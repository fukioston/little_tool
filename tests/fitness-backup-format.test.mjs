import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const SHLN = 0x53484c4e;
const sqlite3Promise = sqlite3InitModule();

async function loadFormat() {
  const relativePath = "lib/fitness/backup-format.ts";
  const source = await readFile(new URL(relativePath, projectRoot), "utf8");
  const { outputText, diagnostics = [] } = ts.transpileModule(source, {
    fileName: relativePath,
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
  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
}

async function hashBlob(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Buffer.from(digest).toString("hex");
}

function sqliteBytes({
  applicationId = SHLN,
  userVersion = 1,
  length = 512,
} = {}) {
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode("SQLite format 3\0"));
  const view = new DataView(bytes.buffer);
  view.setUint32(60, userVersion, false);
  view.setUint32(68, applicationId, false);
  return bytes;
}

async function realSqliteBytes() {
  const sqlite3 = await sqlite3Promise;
  const database = new sqlite3.oo1.DB(":memory:", "c");
  try {
    database.exec(`
      CREATE TABLE fitness_backup_probe(id TEXT PRIMARY KEY, value TEXT) STRICT;
      INSERT INTO fitness_backup_probe VALUES('probe','kept byte-for-byte');
      PRAGMA application_id=${SHLN};
      PRAGMA user_version=1;
    `);
    return sqlite3.capi.sqlite3_js_db_export(database).slice();
  } finally {
    database.close();
  }
}

const entityTypes = ["venue", "equipment", "exercise", "session"];

function fileMetadata(index, bytes, overrides = {}) {
  const entityType = entityTypes[index % entityTypes.length];
  return {
    id: `file-${String(index + 1).padStart(3, "0")}`,
    entityType,
    entityId: `${entityType}-${String(index + 1).padStart(3, "0")}`,
    purpose: index % 2 === 0 ? "photo" : "instruction",
    key: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    originalName: `Fitness file ${index + 1}.webp`,
    mimeType: "image/webp",
    byteSize: bytes.byteLength,
    sha256: "0".repeat(64),
    status: "ready",
    createdAt: 1_777_000_000_000 + index,
    updatedAt: 1_777_000_100_000 + index,
    ...overrides,
  };
}

async function fileInput(index, content, overrides = {}) {
  const bytes = new TextEncoder().encode(content);
  const blob = new Blob([bytes], { type: overrides.mimeType ?? "image/webp" });
  return {
    metadata: fileMetadata(index, bytes, {
      sha256: await hashBlob(blob),
      ...overrides,
    }),
    blob,
  };
}

async function containerParts(blob, magic) {
  const magicLength = new TextEncoder().encode(magic).byteLength;
  const prefix = new Uint8Array(
    await blob.slice(0, magicLength + 4).arrayBuffer(),
  );
  const manifestLength = new DataView(
    prefix.buffer,
    prefix.byteOffset + magicLength,
    4,
  ).getUint32(0, false);
  const manifestStart = magicLength + 4;
  const manifestEnd = manifestStart + manifestLength;
  return {
    magicLength,
    manifestStart,
    manifestEnd,
    manifest: JSON.parse(await blob.slice(manifestStart, manifestEnd).text()),
  };
}

async function replaceManifest(blob, magic, manifest) {
  const parts = await containerParts(blob, magic);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const prefix = new Uint8Array(parts.magicLength + 4);
  prefix.set(new TextEncoder().encode(magic));
  new DataView(prefix.buffer).setUint32(parts.magicLength, manifestBytes.length, false);
  return new Blob([
    prefix,
    manifestBytes,
    blob.slice(parts.manifestEnd),
  ]);
}

test("Fitness complete backup round-trips a canonical empty container", async () => {
  const format = await loadFormat();
  const database = await realSqliteBytes();
  const blob = await format.createFitnessBackupBlob({
    database,
    files: [],
    exportedAt: "2026-08-21T06:07:08.000Z",
  }, hashBlob);
  const parsed = await format.parseFitnessBackupBlob(blob, hashBlob);

  assert.equal(blob.type, format.FITNESS_BACKUP_MIME_TYPE);
  assert.deepEqual(parsed.database, database);
  assert.equal(parsed.files.length, 0);
  assert.equal(parsed.manifest.product, "shilian");
  assert.deepEqual(parsed.manifest.database.applicationId, SHLN);
  assert.deepEqual(parsed.manifest.database.userVersion, 1);
  assert.match(parsed.manifest.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(format.FITNESS_BACKUP_LIMITS.databaseBytes, 512 * 1024 * 1024);
  assert.equal(format.FITNESS_BACKUP_LIMITS.fileBytes, 512 * 1024 * 1024);
  assert.equal(format.FITNESS_BACKUP_LIMITS.totalBytes, 2 * 1024 * 1024 * 1024);
});

test("Fitness backup preserves every supported entity file and exact row metadata", async () => {
  const format = await loadFormat();
  const files = [
    await fileInput(0, "venue-photo", { originalName: "场地.webp" }),
    await fileInput(1, "equipment-guide", {
      entityType: "equipment",
      mimeType: "application/pdf",
      originalName: "器材说明.pdf",
    }),
    await fileInput(2, "exercise-photo", { entityType: "exercise" }),
    await fileInput(3, "session-photo", {
      entityType: "session",
      purpose: "other",
    }),
  ];
  const blob = await format.createFitnessBackupBlob({
    database: sqliteBytes(),
    files,
  }, hashBlob);
  const parsed = await format.parseFitnessBackupBlob(blob, hashBlob);

  assert.equal(parsed.files.length, files.length);
  for (const [index, restored] of parsed.files.entries()) {
    assert.deepEqual(restored.metadata, files[index].metadata);
    assert.equal(await restored.blob.text(), await files[index].blob.text());
    assert.equal(restored.blob.type, files[index].metadata.mimeType);
  }
  assert.deepEqual(
    parsed.files.map(({ metadata }) => metadata.entityType),
    entityTypes,
  );
});

test("Fitness parser rejects manifest, database, payload, identity, and product corruption", async (t) => {
  const format = await loadFormat();
  const files = [await fileInput(0, "authenticated-photo")];
  const valid = await format.createFitnessBackupBlob({
    database: sqliteBytes(),
    files,
    exportedAt: "2026-08-21T06:07:08.000Z",
  }, hashBlob);
  const parts = await containerParts(valid, format.FITNESS_BACKUP_MAGIC);
  const pristine = new Uint8Array(await valid.arrayBuffer());
  const databaseStart = parts.manifestEnd;
  const fileStart = databaseStart + parts.manifest.database.byteSize;

  const byteCases = [
    {
      name: "database payload",
      mutate(bytes) { bytes[databaseStart + 100] ^= 0xff; },
      code: "DATABASE_HASH_MISMATCH",
    },
    {
      name: "database identity",
      mutate(bytes) { bytes[databaseStart + 71] ^= 0x01; },
      code: "DATABASE_IDENTITY_MISMATCH",
    },
    {
      name: "file payload",
      mutate(bytes) { bytes[fileStart] ^= 0xff; },
      code: "FILE_HASH_MISMATCH",
    },
  ];
  for (const entry of byteCases) {
    await t.test(entry.name, async () => {
      const bytes = pristine.slice();
      entry.mutate(bytes);
      await assert.rejects(
        format.parseFitnessBackupBlob(new Blob([bytes]), hashBlob),
        (error) => error?.code === entry.code,
      );
    });
  }

  const manifestCases = [
    {
      name: "manifest digest",
      mutate(manifest) {
        manifest.manifestSha256 = `${manifest.manifestSha256[0] === "a" ? "b" : "a"}${manifest.manifestSha256.slice(1)}`;
      },
      code: "MANIFEST_HASH_MISMATCH",
    },
    {
      name: "wrong product",
      mutate(manifest) { manifest.product = "zhiji"; },
      code: "UNSUPPORTED_FORMAT",
    },
    {
      name: "wrong declared identity",
      mutate(manifest) { manifest.database.applicationId = 0; },
      code: "UNSUPPORTED_DATABASE_IDENTITY",
    },
  ];
  for (const entry of manifestCases) {
    await t.test(entry.name, async () => {
      const manifest = structuredClone(parts.manifest);
      entry.mutate(manifest);
      const corrupted = await replaceManifest(
        valid,
        format.FITNESS_BACKUP_MAGIC,
        manifest,
      );
      await assert.rejects(
        format.parseFitnessBackupBlob(corrupted, hashBlob),
        (error) => error?.code === entry.code,
      );
    });
  }
});

test("Fitness manifest enforces exact keys, ready status, limits, and payload completeness", async () => {
  const format = await loadFormat();
  const file = await fileInput(0, "strict-manifest");
  const valid = await format.createFitnessBackupBlob({
    database: sqliteBytes(),
    files: [file],
  }, hashBlob);
  const parts = await containerParts(valid, format.FITNESS_BACKUP_MAGIC);

  const mutations = [
    {
      mutate(manifest) { manifest.unexpected = true; },
      code: "INVALID_MANIFEST",
    },
    {
      mutate(manifest) { delete manifest.files[0].entityId; },
      code: "INVALID_MANIFEST",
    },
    {
      mutate(manifest) { manifest.files[0].unexpected = "field"; },
      code: "INVALID_MANIFEST",
    },
    {
      mutate(manifest) { manifest.files[0].status = "missing"; },
      code: "INVALID_MANIFEST",
    },
    {
      mutate(manifest) {
        manifest.files[0].byteSize = format.FITNESS_BACKUP_LIMITS.fileBytes + 1;
      },
      code: "FILE_TOO_LARGE",
    },
  ];
  for (const entry of mutations) {
    const manifest = structuredClone(parts.manifest);
    entry.mutate(manifest);
    const corrupted = await replaceManifest(
      valid,
      format.FITNESS_BACKUP_MAGIC,
      manifest,
    );
    await assert.rejects(
      format.parseFitnessBackupBlob(corrupted, hashBlob),
      (error) => error?.code === entry.code,
    );
  }

  const truncated = valid.slice(0, valid.size - 1);
  await assert.rejects(
    format.parseFitnessBackupBlob(truncated, hashBlob),
    (error) => error?.code === "SIZE_MISMATCH",
  );
});

test("Fitness export rejects non-ready, duplicate, mismatched, and non-canonical input", async () => {
  const format = await loadFormat();
  const one = await fileInput(0, "one-file");
  const two = await fileInput(1, "two-file");

  await assert.rejects(
    format.createFitnessBackupBlob({
      database: sqliteBytes(),
      files: [{ ...one, metadata: { ...one.metadata, status: "missing" } }],
    }, hashBlob),
    (error) => error?.code === "INVALID_MANIFEST",
  );
  await assert.rejects(
    format.createFitnessBackupBlob({
      database: sqliteBytes(),
      files: [one, { ...two, metadata: { ...two.metadata, id: one.metadata.id } }],
    }, hashBlob),
    (error) => error?.code === "DUPLICATE_FILE_ID",
  );
  await assert.rejects(
    format.createFitnessBackupBlob({
      database: sqliteBytes(),
      files: [one, { ...two, metadata: { ...two.metadata, key: one.metadata.key } }],
    }, hashBlob),
    (error) => error?.code === "DUPLICATE_FILE_KEY",
  );
  await assert.rejects(
    format.createFitnessBackupBlob({
      database: sqliteBytes(),
      files: [{ ...one, metadata: { ...one.metadata, byteSize: one.blob.size + 1 } }],
    }, hashBlob),
    (error) => error?.code === "FILE_SIZE_MISMATCH",
  );
  await assert.rejects(
    format.createFitnessBackupBlob({
      database: sqliteBytes(),
      files: [{ ...one, metadata: { ...one.metadata, sha256: "f".repeat(64) } }],
    }, hashBlob),
    (error) => error?.code === "FILE_HASH_MISMATCH",
  );
  await assert.rejects(
    format.createFitnessBackupBlob({
      database: sqliteBytes({ applicationId: 0 }),
      files: [],
    }, hashBlob),
    (error) => error?.code === "UNSUPPORTED_DATABASE_IDENTITY",
  );
  await assert.rejects(
    format.createFitnessBackupBlob({
      database: sqliteBytes(),
      files: [{
        ...one,
        metadata: { ...one.metadata, unexpected: true },
      }],
    }, hashBlob),
    (error) => error?.code === "INVALID_MANIFEST",
  );
});

test("raw SQLite and other product containers are not Fitness complete backups", async () => {
  const format = await loadFormat();
  await assert.rejects(
    format.parseFitnessBackupBlob(new Blob([sqliteBytes()]), hashBlob),
    (error) => error?.code === "INVALID_MAGIC",
  );
  await assert.rejects(
    format.parseFitnessBackupBlob(
      new Blob([new TextEncoder().encode("VOCAB-BACKUP\r\n\u001a")]),
      hashBlob,
    ),
    (error) => error?.code === "INVALID_MAGIC",
  );
});
