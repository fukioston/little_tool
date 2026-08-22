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
let writeFault = null;
let removeFault = null;

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
        if (writeFault?.name === this.name && writeFault.mode === "before") {
          writeFault = null;
          throw new Error("write before close");
        }
        const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        const combined = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.bytes = combined;
        if (writeFault?.name === this.name && writeFault.mode === "after") {
          writeFault = null;
          throw new Error("write response lost");
        }
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
    if (removeFault?.name === name && removeFault.mode === "before") {
      removeFault = null;
      throw new Error("remove before");
    }
    if (!this.entriesByName.delete(name)) throw domError("NotFoundError");
    if (removeFault?.name === name && removeFault.mode === "after") {
      removeFault = null;
      throw new Error("remove response lost");
    }
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

function treeShape(directory) {
  return [...directory.entriesByName.entries()].map(([name, entry]) => [
    name,
    entry.kind === "directory" ? treeShape(entry) : entry.bytes.byteLength,
  ]);
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

test("owned fragment inspection classifies recovery states without any mutation", async () => {
  const missingKey = "71000000-0000-4000-8000-000000000010";
  const claimKey = "71000000-0000-4000-8000-000000000011";
  const bytesKey = "71000000-0000-4000-8000-000000000012";
  const completeKey = "71000000-0000-4000-8000-000000000013";
  const metadataKey = "71000000-0000-4000-8000-000000000014";
  const foreignKey = "71000000-0000-4000-8000-000000000015";
  const { objects, metadata } = await careerDirectories();
  await writeMemoryFile(metadata, `${claimKey}.json`, {
    version: 1, namespace: "career", key: claimKey, stagingOwner: OWNER_A,
  });
  await writeMemoryFile(objects, `${bytesKey}.bin`, "unverifiable bytes");
  await files.saveLocalFileAtKey("career", completeKey, new Blob(["complete"]), {}, OWNER_A);
  await files.saveLocalFileAtKey("career", metadataKey, new Blob(["metadata only"]), {}, OWNER_A);
  await objects.removeEntry(`${metadataKey}.bin`);
  await files.saveLocalFileAtKey("career", foreignKey, new Blob(["foreign"]), {}, OWNER_B);
  const before = treeShape(opfsRoot);

  assert.deepEqual(await files.inspectOwnedLocalFileFragments("career", missingKey, OWNER_A), { state: "missing" });
  assert.deepEqual(await files.inspectOwnedLocalFileFragments("career", claimKey, OWNER_A), {
    state: "owned", objectPresent: false, metadataKind: "claim",
  });
  assert.deepEqual(await files.inspectOwnedLocalFileFragments("career", bytesKey, OWNER_A), {
    state: "foreign_or_unverifiable", objectPresent: true, metadataPresent: false,
  });
  assert.deepEqual(await files.inspectOwnedLocalFileFragments("career", completeKey, OWNER_A), {
    state: "owned", objectPresent: true, metadataKind: "complete",
  });
  assert.deepEqual(await files.inspectOwnedLocalFileFragments("career", metadataKey, OWNER_A), {
    state: "owned", objectPresent: false, metadataKind: "complete",
  });
  assert.deepEqual(await files.inspectOwnedLocalFileFragments("career", foreignKey, OWNER_A), {
    state: "foreign_or_unverifiable", objectPresent: true, metadataPresent: true,
  });
  assert.deepEqual(treeShape(opfsRoot), before);
});

test("ordinary deletion claims recover metadata-only and bytes-only fragments before release", async () => {
  for (const partial of ["metadata-only", "bytes-only"]) {
    const stored = await files.saveLocalFile("career", new Blob([`ordinary ${partial}`]), {
      originalName: `${partial}.txt`, mimeType: "text/plain",
    });
    const { objects, metadata } = await careerDirectories();
    if (partial === "metadata-only") await objects.removeEntry(`${stored.key}.bin`);
    else await metadata.removeEntry(`${stored.key}.json`);
    await files.claimLocalFileDeletion("career", stored.key, stored, OWNER_A);
    assert.deepEqual(await files.inspectClaimedLocalFileDeletion(
      "career", stored.key, stored, OWNER_A), {
      state: "owned",
      phase: "claimed",
      objectPresent: partial === "bytes-only",
      metadataPresent: partial === "metadata-only",
    });
    await files.sweepClaimedLocalFileDeletion("career", stored.key, stored, OWNER_A);
    assert.deepEqual(await files.inspectClaimedLocalFileDeletion(
      "career", stored.key, stored, OWNER_A), {
      state: "owned", phase: "swept", objectPresent: false, metadataPresent: false,
    });
    assert.equal(await files.releaseClaimedLocalFileDeletion(
      "career", stored.key, stored, OWNER_A), true);
    assert.equal((await files.inspectClaimedLocalFileDeletion(
      "career", stored.key, stored, OWNER_A)).state, "missing_claim");
  }
});

test("deletion claim write response loss settles exact and pre-write failure deletes nothing", async () => {
  const recovered = await files.saveLocalFile("career", new Blob(["claim response loss"]), {
    originalName: "claim.txt",
  });
  writeFault = { name: `${recovered.key}.deletion.json`, mode: "after" };
  await files.claimLocalFileDeletion("career", recovered.key, recovered, OWNER_A);
  assert.equal((await files.inspectClaimedLocalFileDeletion(
    "career", recovered.key, recovered, OWNER_A)).state, "owned");
  const listedWhileClaimed = await files.listLocalFiles("career");
  assert.equal(listedWhileClaimed.filter(({ key }) => key === recovered.key).length, 1);
  assert.equal(JSON.stringify(listedWhileClaimed).includes("deletionOwner"), false);
  assert.equal(JSON.stringify(listedWhileClaimed).includes("deletion-claim"), false);

  const failed = await files.saveLocalFile("career", new Blob(["claim failed"]), {
    originalName: "failed.txt",
  });
  writeFault = { name: `${failed.key}.deletion.json`, mode: "before" };
  await assert.rejects(files.claimLocalFileDeletion("career", failed.key, failed, OWNER_A),
    /write before close/);
  assert.equal(await (await files.getLocalFile("career", failed.key)).file.text(), "claim failed");
});

test("a swept deletion claim blocks same-key foreign resurrection until exact release", async () => {
  const stored = await files.saveLocalFile("career", new Blob(["old ordinary file"]), {
    originalName: "old.txt",
  });
  await files.claimLocalFileDeletion("career", stored.key, stored, OWNER_A);
  await files.sweepClaimedLocalFileDeletion("career", stored.key, stored, OWNER_A);
  const { objects } = await careerDirectories();
  await writeMemoryFile(objects, `${stored.key}.bin`, "foreign resurrection");
  assert.equal((await files.inspectClaimedLocalFileDeletion(
    "career", stored.key, stored, OWNER_A)).state, "foreign_or_unverifiable");
  await assert.rejects(files.sweepClaimedLocalFileDeletion(
    "career", stored.key, stored, OWNER_A), /cannot sweep|foreign/i);
  await assert.rejects(files.releaseClaimedLocalFileDeletion(
    "career", stored.key, stored, OWNER_A), /not ready/);
  await assert.rejects(files.abandonClaimedLocalFileDeletion(
    "career", stored.key, stored, OWNER_A), /untouched/);
  assert.equal(await (await objects.getFileHandle(`${stored.key}.bin`)).getFile().then((file) => file.text()),
    "foreign resurrection");
  await assert.rejects(files.saveLocalFileAtKey(
    "career", stored.key, new Blob(["replacement"]), {}, OWNER_B),
  (error) => error?.code === "FILE_KEY_COLLISION");
});

test("owned deletion preserves metadata on object failure and settles object response loss", async () => {
  const before = await files.saveLocalFileAtKey(
    "career", "71000000-0000-4000-8000-000000000020", new Blob(["before failure"]), {}, OWNER_A,
  );
  removeFault = { name: `${before.key}.bin`, mode: "before" };
  await assert.rejects(files.deleteOwnedLocalFile("career", before.key, OWNER_A), /remove before/);
  assert.equal(await (await files.getLocalFile("career", before.key)).file.text(), "before failure");

  const after = await files.saveLocalFileAtKey(
    "career", "71000000-0000-4000-8000-000000000021", new Blob(["after failure"]), {}, OWNER_A,
  );
  removeFault = { name: `${after.key}.bin`, mode: "after" };
  assert.equal(await files.deleteOwnedLocalFile("career", after.key, OWNER_A), true);
  assert.deepEqual(await files.inspectOwnedLocalFileFragments("career", after.key, OWNER_A), { state: "missing" });
});

test("same-owner extra, array, wrong-version metadata and malformed claims never authorize deletion", async () => {
  const { objects, metadata } = await careerDirectories();
  for (const [suffix, mutate] of [
    ["022", (record) => ({ ...record, extra: true })],
    ["023", (record) => [record]],
    ["024", (record) => ({ ...record, version: 2 })],
  ]) {
    const key = `71000000-0000-4000-8000-000000000${suffix}`;
    const stored = await files.saveLocalFileAtKey(
      "career", key, new Blob([`schema ${suffix}`]), {}, OWNER_A,
    );
    await writeMemoryFile(metadata, `${key}.json`, mutate(stored));
    const before = treeShape(opfsRoot);
    assert.equal((await files.inspectOwnedLocalFileFragments("career", key, OWNER_A)).state,
      "foreign_or_unverifiable");
    await assert.rejects(files.deleteOwnedLocalFile("career", key, OWNER_A),
      (error) => error?.code === "FILE_OWNERSHIP_MISMATCH");
    assert.deepEqual(treeShape(opfsRoot), before);
    assert.equal(await (await objects.getFileHandle(`${key}.bin`)).getFile().then((file) => file.text()),
      `schema ${suffix}`);
  }

  const ordinary = await files.saveLocalFile("career", new Blob(["claim schema"]), {
    originalName: "claim-schema.txt",
  });
  await files.claimLocalFileDeletion("career", ordinary.key, ordinary, OWNER_A);
  const claimHandle = await metadata.getFileHandle(`${ordinary.key}.deletion.json`);
  const rawClaim = JSON.parse(await (await claimHandle.getFile()).text());
  await writeMemoryFile(metadata, `${ordinary.key}.deletion.json`, { ...rawClaim, extra: true });
  const beforeClaimChecks = treeShape(opfsRoot);
  assert.equal((await files.inspectClaimedLocalFileDeletion(
    "career", ordinary.key, ordinary, OWNER_A)).state, "foreign_or_unverifiable");
  await assert.rejects(files.sweepClaimedLocalFileDeletion(
    "career", ordinary.key, ordinary, OWNER_A), /cannot sweep/i);
  await assert.rejects(files.releaseClaimedLocalFileDeletion(
    "career", ordinary.key, ordinary, OWNER_A), /not ready/i);
  assert.deepEqual(treeShape(opfsRoot), beforeClaimChecks);
});

test("missing-both deletion reservation is swept atomically and settles claim response loss", async () => {
  const beforeKey = "71000000-0000-4000-8000-000000000025";
  writeFault = { name: `${beforeKey}.deletion.json`, mode: "before" };
  await assert.rejects(files.claimLocalFileDeletion("career", beforeKey, null, OWNER_A),
    /write before close/);
  assert.equal((await files.inspectClaimedLocalFileDeletion(
    "career", beforeKey, null, OWNER_A)).state, "missing_claim");
  assert.equal((await files.inspectLocalFileDeletionCandidate(
    "career", beforeKey, null)).state, "missing");

  const afterKey = "71000000-0000-4000-8000-000000000026";
  writeFault = { name: `${afterKey}.deletion.json`, mode: "after" };
  await files.claimLocalFileDeletion("career", afterKey, null, OWNER_A);
  assert.deepEqual(await files.inspectClaimedLocalFileDeletion(
    "career", afterKey, null, OWNER_A), {
    state: "owned", phase: "swept", objectPresent: false, metadataPresent: false,
  });
  await assert.rejects(files.saveLocalFileAtKey(
    "career", afterKey, new Blob(["resurrection"]), {}, OWNER_B),
  (error) => error?.code === "FILE_KEY_COLLISION");
  assert.equal(await files.releaseClaimedLocalFileDeletion(
    "career", afterKey, null, OWNER_A), true);
  assert.equal((await files.inspectClaimedLocalFileDeletion(
    "career", afterKey, null, OWNER_A)).state, "missing_claim");

  const disappeared = await files.saveLocalFile("career", new Blob(["disappeared"]), {
    originalName: "disappeared.txt",
  });
  const { objects, metadata } = await careerDirectories();
  await objects.removeEntry(`${disappeared.key}.bin`);
  await metadata.removeEntry(`${disappeared.key}.json`);
  await files.claimLocalFileDeletion("career", disappeared.key, disappeared, OWNER_A);
  assert.equal((await files.inspectClaimedLocalFileDeletion(
    "career", disappeared.key, disappeared, OWNER_A)).phase, "swept");
});
