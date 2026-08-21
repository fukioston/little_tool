import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);
const KEY_A = "71000000-0000-4000-8000-000000000001";
const KEY_B = "71000000-0000-4000-8000-000000000002";
const KEY_C = "71000000-0000-4000-8000-000000000003";
const KEY_D = "71000000-0000-4000-8000-000000000004";
const KEY_E = "71000000-0000-4000-8000-000000000005";

function domError(name) {
  return new DOMException(name, name);
}

function bytesFor(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new TypeError("Unsupported memory OPFS write");
}

class MemoryFileHandle {
  kind = "file";
  bytes = new Uint8Array();

  constructor(name) {
    this.name = name;
  }

  async getFile() {
    return new File([this.bytes], this.name);
  }

  async createWritable() {
    const chunks = [];
    return {
      write: async (value) => {
        chunks.push(bytesFor(value));
      },
      close: async () => {
        const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        const combined = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.bytes = combined;
      },
      abort: async () => undefined,
    };
  }
}

class MemoryDirectoryHandle {
  kind = "directory";
  entriesByName = new Map();

  constructor(name) {
    this.name = name;
  }

  async getDirectoryHandle(name, options = {}) {
    const current = this.entriesByName.get(name);
    if (current?.kind === "directory") return current;
    if (current) throw domError("TypeMismatchError");
    if (!options.create) throw domError("NotFoundError");
    const created = new MemoryDirectoryHandle(name);
    this.entriesByName.set(name, created);
    return created;
  }

  async getFileHandle(name, options = {}) {
    const current = this.entriesByName.get(name);
    if (current?.kind === "file") return current;
    if (current) throw domError("TypeMismatchError");
    if (!options.create) throw domError("NotFoundError");
    const created = new MemoryFileHandle(name);
    this.entriesByName.set(name, created);
    return created;
  }

  async removeEntry(name) {
    if (!this.entriesByName.delete(name)) throw domError("NotFoundError");
  }

  async *entries() {
    yield* this.entriesByName.entries();
  }
}

async function writeMemoryFile(directory, name, value) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  await writable.write(typeof value === "string" ? value : JSON.stringify(value));
  await writable.close();
  return handle;
}

const opfsRoot = new MemoryDirectoryHandle("root");
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    storage: {
      async getDirectory() {
        return opfsRoot;
      },
    },
  },
});

const source = await readFile(new URL("lib/local-db/files.ts", projectRoot), "utf8");
const { outputText, diagnostics = [] } = ts.transpileModule(source, {
  fileName: "lib/local-db/files.ts",
  reportDiagnostics: true,
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true,
  },
});
assert.deepEqual(
  diagnostics.filter(({ category }) => category === ts.DiagnosticCategory.Error),
  [],
);
const files = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

async function careerDirectories() {
  const root = await opfsRoot.getDirectoryHandle("private-ai-suite-files", { create: true });
  const version = await root.getDirectoryHandle("v1", { create: true });
  const career = await version.getDirectoryHandle("career", { create: true });
  return {
    objects: await career.getDirectoryHandle("objects", { create: true }),
    metadata: await career.getDirectoryHandle("metadata", { create: true }),
  };
}

test("exact-key save writes a bound record and ordinary save remains compatible", async () => {
  await files.assertLocalFileKeyAvailable("career", KEY_A);
  assert.equal(
    opfsRoot.entriesByName.has("private-ai-suite-files"),
    false,
    "availability preflight must not create OPFS directories",
  );
  const exact = await files.saveLocalFileAtKey(
    "career",
    KEY_A,
    new Blob(["exact private bytes"], { type: "text/plain" }),
    { originalName: "exact.txt", mimeType: "text/plain" },
    OWNER_A,
  );
  assert.equal(exact.key, KEY_A);
  assert.equal(exact.stagingOwner, OWNER_A);
  const exactRead = await files.getLocalFile("career", KEY_A);
  assert.equal(await exactRead.file.text(), "exact private bytes");

  const ordinary = await files.saveLocalFile(
    "career",
    new Blob(["ordinary private bytes"], { type: "text/plain" }),
    { originalName: "ordinary.txt" },
  );
  assert.match(ordinary.key, /^[0-9a-f-]{36}$/);
  assert.equal(ordinary.stagingOwner, undefined);
  assert.equal(
    await (await files.getLocalFile("career", ordinary.key)).file.text(),
    "ordinary private bytes",
  );
});

test("object-side and metadata-side collisions are rejected without overwrite", async () => {
  const { objects, metadata } = await careerDirectories();
  const object = await writeMemoryFile(objects, `${KEY_B}.bin`, "foreign object bytes");
  await assert.rejects(
    files.saveLocalFileAtKey(
      "career",
      KEY_B,
      new Blob(["replacement"]),
      {},
      OWNER_A,
    ),
    (error) => error?.code === "FILE_KEY_COLLISION",
  );
  assert.equal(await (await object.getFile()).text(), "foreign object bytes");
  await assert.rejects(
    metadata.getFileHandle(`${KEY_B}.json`),
    (error) => error?.name === "NotFoundError",
  );

  await writeMemoryFile(metadata, `${KEY_C}.json`, { foreign: true });
  await assert.rejects(
    files.assertLocalFileKeyAvailable("career", KEY_C),
    (error) => error?.code === "FILE_KEY_COLLISION",
  );
  await assert.rejects(
    files.saveLocalFileAtKey(
      "career",
      KEY_C,
      new Blob(["replacement"]),
      {},
      OWNER_A,
    ),
    (error) => error?.code === "FILE_KEY_COLLISION",
  );
  await assert.rejects(
    objects.getFileHandle(`${KEY_C}.bin`),
    (error) => error?.name === "NotFoundError",
  );
  const foreignMetadataHandle = await metadata.getFileHandle(`${KEY_C}.json`);
  const foreignMetadataFile = await foreignMetadataHandle.getFile();
  assert.deepEqual(JSON.parse(await foreignMetadataFile.text()), { foreign: true });
});

test("exact-key APIs reject non-v4 UUIDs before touching their target names", async () => {
  for (const key of [
    "not-a-uuid",
    "71000000-0000-1000-8000-000000000007",
    "71000000-0000-4000-7000-000000000007",
  ]) {
    await assert.rejects(
      files.assertLocalFileKeyAvailable("career", key),
      (error) => error?.code === "INVALID_FILE_KEY",
    );
    await assert.rejects(
      files.saveLocalFileAtKey("career", key, new Blob(["bytes"]), {}, OWNER_A),
      (error) => error?.code === "INVALID_FILE_KEY",
    );
  }
});

test("owned cleanup removes claims idempotently and retains unverified objects", async () => {
  const { objects, metadata } = await careerDirectories();
  await writeMemoryFile(metadata, `${KEY_D}.json`, {
    version: 1,
    namespace: "career",
    key: KEY_D,
    stagingOwner: OWNER_A,
  });
  assert.equal(await files.deleteOwnedLocalFile("career", KEY_D, OWNER_A), true);
  assert.equal(await files.deleteOwnedLocalFile("career", KEY_D, OWNER_A), false);

  const unverified = await writeMemoryFile(objects, `${KEY_E}.bin`, "orphan bytes");
  await assert.rejects(
    files.deleteOwnedLocalFile("career", KEY_E, OWNER_A),
    (error) => error?.code === "FILE_OWNERSHIP_UNVERIFIED",
  );
  assert.equal(await (await unverified.getFile()).text(), "orphan bytes");
});

test("an ownership mismatch never deletes another operation's bytes or metadata", async () => {
  const key = "71000000-0000-4000-8000-000000000006";
  await files.saveLocalFileAtKey(
    "career",
    key,
    new Blob(["owned elsewhere"]),
    { originalName: "elsewhere.txt" },
    OWNER_A,
  );
  await assert.rejects(
    files.deleteOwnedLocalFile("career", key, OWNER_B),
    (error) => error?.code === "FILE_OWNERSHIP_MISMATCH",
  );
  assert.equal(
    await (await files.getLocalFile("career", key)).file.text(),
    "owned elsewhere",
  );
});
