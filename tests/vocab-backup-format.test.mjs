import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

async function loadFormat() {
  const relativePath = "lib/vocab/backup-format.ts";
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
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

async function hashBlob(blob) {
  return crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
    .then((digest) => Buffer.from(digest).toString("hex"));
}

function sqliteBytes({ applicationId = 0, userVersion = 0, length = 256 } = {}) {
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode("SQLite format 3\0"));
  const view = new DataView(bytes.buffer);
  view.setUint32(60, userVersion, false);
  view.setUint32(68, applicationId, false);
  return bytes;
}

function audioMetadata(index, bytes, overrides = {}) {
  return {
    key: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    originalName: `Episode ${index + 1}.mp3`,
    mimeType: "audio/mpeg",
    category: "podcast-audio",
    byteSize: bytes.byteLength,
    sha256: "0".repeat(64),
    createdAt: "2026-08-21T01:02:03.000Z",
    updatedAt: "2026-08-21T04:05:06.000Z",
    ...overrides,
  };
}

async function audioInput(index, text, overrides = {}) {
  const bytes = new TextEncoder().encode(text);
  const blob = new Blob([bytes], { type: "audio/mpeg" });
  return {
    metadata: audioMetadata(index, bytes, {
      sha256: await hashBlob(blob),
      ...overrides,
    }),
    blob,
  };
}

async function containerParts(blob, magic) {
  const magicLength = new TextEncoder().encode(magic).byteLength;
  const prefix = new Uint8Array(await blob.slice(0, magicLength + 4).arrayBuffer());
  const manifestLength = new DataView(prefix.buffer, prefix.byteOffset + magicLength, 4)
    .getUint32(0, false);
  const manifestStart = magicLength + 4;
  const manifestEnd = manifestStart + manifestLength;
  return {
    prefix,
    manifestStart,
    manifestEnd,
    manifest: JSON.parse(await blob.slice(manifestStart, manifestEnd).text()),
  };
}

test("Vocabulary complete backup round-trips with zero audio files and a self-authenticated manifest", async () => {
  const format = await loadFormat();
  const database = sqliteBytes();
  const blob = await format.createVocabBackupBlob({
    database,
    audio: [],
    exportedAt: "2026-08-21T06:07:08.000Z",
  }, hashBlob);
  const parsed = await format.parseVocabBackupBlob(blob, hashBlob);

  assert.equal(blob.type, format.VOCAB_BACKUP_MIME_TYPE);
  assert.deepEqual(parsed.database, database);
  assert.equal(parsed.audio.length, 0);
  assert.equal(parsed.manifest.product, "shici");
  assert.equal(parsed.manifest.database.applicationId, 0);
  assert.equal(parsed.manifest.database.userVersion, 0);
  assert.match(parsed.manifest.manifestSha256, /^[0-9a-f]{64}$/);
});

test("Vocabulary complete backup preserves one and multiple audio files with exact metadata", async () => {
  const format = await loadFormat();
  for (const audio of [
    [await audioInput(0, "one-audio")],
    [
      await audioInput(0, "first-audio", { originalName: "晨间英语.mp3" }),
      await audioInput(1, "second-audio", { mimeType: "audio/ogg", originalName: "Episode 2.ogg" }),
      await audioInput(2, "third-audio", { category: null }),
    ],
  ]) {
    const blob = await format.createVocabBackupBlob({
      database: sqliteBytes({ applicationId: 0x53484349, userVersion: 1 }),
      audio,
    }, hashBlob);
    const parsed = await format.parseVocabBackupBlob(blob, hashBlob);
    assert.equal(parsed.audio.length, audio.length);
    for (const [index, restored] of parsed.audio.entries()) {
      assert.deepEqual(restored.metadata, audio[index].metadata);
      assert.equal(await restored.blob.text(), await audio[index].blob.text());
    }
  }
});

test("Vocabulary parser rejects manifest, database, audio, identity, and product corruption", async (t) => {
  const format = await loadFormat();
  const audio = [await audioInput(0, "authenticated-audio")];
  const valid = await format.createVocabBackupBlob({
    database: sqliteBytes({ applicationId: 0x53484349, userVersion: 1 }),
    audio,
    exportedAt: "2026-08-21T06:07:08.000Z",
  }, hashBlob);
  const parts = await containerParts(valid, format.VOCAB_BACKUP_MAGIC);
  const validBytes = new Uint8Array(await valid.arrayBuffer());
  const databaseStart = parts.manifestEnd;
  const audioStart = databaseStart + parts.manifest.database.byteSize;

  const cases = [
    {
      name: "manifest digest",
      mutate(bytes) {
        const needle = new TextEncoder().encode(parts.manifest.manifestSha256);
        const at = Buffer.from(bytes).indexOf(Buffer.from(needle));
        bytes[at] = bytes[at] === 97 ? 98 : 97;
      },
      code: "MANIFEST_HASH_MISMATCH",
    },
    {
      name: "database bytes",
      mutate(bytes) { bytes[databaseStart + 100] ^= 0xff; },
      code: "DATABASE_HASH_MISMATCH",
    },
    {
      name: "database identity",
      mutate(bytes) { bytes[databaseStart + 71] ^= 0x01; },
      code: "DATABASE_IDENTITY_MISMATCH",
    },
    {
      name: "audio bytes",
      mutate(bytes) { bytes[audioStart] ^= 0xff; },
      code: "AUDIO_HASH_MISMATCH",
    },
    {
      name: "wrong product",
      mutate(bytes) {
        const needle = Buffer.from('"product":"shici"');
        const at = Buffer.from(bytes).indexOf(needle);
        bytes.set(Buffer.from('"product":"zhiji"'), at);
      },
      code: "UNSUPPORTED_FORMAT",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const bytes = validBytes.slice();
      entry.mutate(bytes);
      await assert.rejects(
        format.parseVocabBackupBlob(new Blob([bytes]), hashBlob),
        (error) => error?.code === entry.code,
      );
    });
  }
});

test("Vocabulary export refuses missing, duplicate, or hash-mismatched audio metadata", async () => {
  const format = await loadFormat();
  const one = await audioInput(0, "audio");
  await assert.rejects(
    format.createVocabBackupBlob({
      database: sqliteBytes(),
      audio: [{ ...one, metadata: { ...one.metadata, sha256: "f".repeat(64) } }],
    }, hashBlob),
    (error) => error?.code === "AUDIO_HASH_MISMATCH",
  );
  await assert.rejects(
    format.createVocabBackupBlob({ database: sqliteBytes(), audio: [one, one] }, hashBlob),
    (error) => error?.code === "DUPLICATE_AUDIO_KEY",
  );
  await assert.rejects(
    format.createVocabBackupBlob({
      database: sqliteBytes(),
      audio: [{ ...one, metadata: { ...one.metadata, byteSize: one.metadata.byteSize + 1 } }],
    }, hashBlob),
    (error) => error?.code === "AUDIO_SIZE_MISMATCH",
  );
});

test("Career containers and raw SQLite are never mistaken for complete Vocabulary backups", async () => {
  const format = await loadFormat();
  const raw = new Blob([sqliteBytes()]);
  await assert.rejects(
    format.parseVocabBackupBlob(raw, hashBlob),
    (error) => error?.code === "INVALID_MAGIC",
  );
  const careerMagic = new Blob([new TextEncoder().encode("CAREER-BACKUP\r\n\u001a")]);
  await assert.rejects(
    format.parseVocabBackupBlob(careerMagic, hashBlob),
    (error) => error?.code === "INVALID_MAGIC",
  );
});
