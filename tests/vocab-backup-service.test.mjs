import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const SOURCE_KEY = "10000000-0000-4000-8000-000000000001";
const STAGED_KEY = "20000000-0000-4000-8000-000000000001";
const GENERATION_ID = "30000000-0000-4000-8000-000000000001";
const ACTIVATION_TOKEN = "a".repeat(64);
const NOW = new Date("2026-08-21T08:09:10.000Z");

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function transpile(relativePath) {
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
  return outputText;
}

const [formatJavaScript, planJavaScript, rawServiceJavaScript] = await Promise.all([
  transpile("lib/vocab/backup-format.ts"),
  transpile("lib/vocab/backup-plan.ts"),
  transpile("lib/vocab/backup.ts"),
]);
const formatUrl = moduleUrl(formatJavaScript);
const planUrl = moduleUrl(planJavaScript);
const dependencies = {
  "@/lib/local-db/client": moduleUrl("export const localDb = {};"),
  "@/lib/local-db/files": moduleUrl(`
    export async function deleteLocalFile(){ throw new Error("default runtime not used"); }
    export async function getLocalFile(){ throw new Error("default runtime not used"); }
    export async function saveLocalFile(){ throw new Error("default runtime not used"); }
    export async function sha256Blob(blob){
      const digest=await crypto.subtle.digest("SHA-256",await blob.arrayBuffer());
      return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
    }
  `),
  "./backup-format": formatUrl,
  "./backup-plan": planUrl,
  "./lock": moduleUrl(`
    export function broadcastVocabChange(){}
    export function withVocabWriteLock(task){ return task(); }
  `),
};
let serviceJavaScript = rawServiceJavaScript;
for (const [specifier, url] of Object.entries(dependencies)) {
  serviceJavaScript = serviceJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const [format, backup] = await Promise.all([
  import(formatUrl),
  import(moduleUrl(serviceJavaScript)),
]);

async function hashBlob(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Buffer.from(digest).toString("hex");
}

function sqliteBytes({ applicationId = 0, userVersion = 0 } = {}) {
  const bytes = new Uint8Array(256);
  bytes.set(new TextEncoder().encode("SQLite format 3\0"));
  const view = new DataView(bytes.buffer);
  view.setUint32(60, userVersion, false);
  view.setUint32(68, applicationId, false);
  return bytes;
}

async function sourceAudio() {
  const file = new File(["audio payload"], "episode.mp3", { type: "audio/mpeg" });
  return {
    metadata: {
      namespace: "vocab",
      key: SOURCE_KEY,
      originalName: "episode.mp3",
      mimeType: "audio/mpeg",
      category: "podcast-audio",
      byteSize: file.size,
      sha256: await hashBlob(file),
      createdAt: "2026-08-20T01:02:03.000Z",
      updatedAt: "2026-08-20T04:05:06.000Z",
    },
    file,
  };
}

async function completeContainer(audio = []) {
  return format.createVocabBackupBlob({
    database: sqliteBytes(),
    audio: audio.map(({ metadata, file }) => ({ metadata, blob: file })),
    exportedAt: "2026-08-20T06:07:08.000Z",
  }, hashBlob);
}

async function runtimeFixture(overrides = {}) {
  const source = await sourceAudio();
  const state = {
    lockCalls: 0,
    queries: [],
    readKeys: [],
    saved: [],
    deleted: [],
    staged: [],
    activated: [],
    discarded: [],
    broadcasts: [],
  };
  const stagedResult = {
    database: "shici",
    generationId: GENERATION_ID,
    filename: `shici.${GENERATION_ID}.sqlite3`,
    activationToken: ACTIVATION_TOKEN,
    importedBytes: 256,
    schemaVersion: 2,
  };
  const runtime = {
    async withExclusiveLock(task) {
      state.lockCalls += 1;
      return task();
    },
    async query(sql, params) {
      state.queries.push({ sql, params });
      return { rows: [{ audio_url: `local:${SOURCE_KEY}` }] };
    },
    async exportDatabase() {
      return { data: sqliteBytes() };
    },
    async stageImport(database, statements) {
      state.staged.push({ database, statements });
      return stagedResult;
    },
    async activateStaged(staged) {
      state.activated.push(staged);
    },
    async currentGeneration() {
      return {
        database: "shici",
        generationId: "legacy",
        filename: "shici.sqlite3",
        sequence: 0,
        legacy: true,
      };
    },
    async discardStaged(staged) {
      state.discarded.push(staged);
    },
    async getFile(key) {
      state.readKeys.push(key);
      if (key !== SOURCE_KEY) throw new Error("unexpected file read");
      return source;
    },
    async saveFile(blob, options) {
      const saved = {
        version: 1,
        namespace: "vocab",
        key: STAGED_KEY,
        originalName: options.originalName,
        mimeType: options.mimeType,
        category: options.category ?? null,
        byteSize: blob.size,
        sha256: await hashBlob(blob),
        createdAt: options.createdAt,
        updatedAt: options.updatedAt,
      };
      state.saved.push({ blob, options, metadata: saved });
      return saved;
    },
    async deleteFile(key) {
      state.deleted.push(key);
    },
    hashBlob,
    broadcastGenerationChanged(generationId) {
      state.broadcasts.push(generationId);
    },
    now() {
      return new Date(NOW);
    },
    ...overrides,
  };
  return { runtime, state, source, stagedResult };
}

test("export is locked and includes exactly the DB-referenced local OPFS audio", async () => {
  const { runtime, state, source } = await runtimeFixture();
  const service = backup.createVocabBackupService(runtime);
  const result = await service.exportCompleteBackup();
  const parsed = await format.parseVocabBackupBlob(result.blob, hashBlob);

  assert.equal(state.lockCalls, 1);
  assert.equal(state.queries.length, 1);
  assert.match(state.queries[0].sql, /SELECT DISTINCT audio_url/);
  assert.match(state.queries[0].sql, /ORDER BY audio_url/);
  assert.deepEqual(state.readKeys, [SOURCE_KEY]);
  assert.equal(parsed.audio.length, 1);
  const portableMetadata = Object.fromEntries(
    Object.entries(source.metadata).filter(([key]) => key !== "namespace"),
  );
  assert.deepEqual(parsed.audio[0].metadata, portableMetadata);
  assert.equal(await parsed.audio[0].blob.text(), await source.file.text());
  assert.equal(result.fileName, "shici-complete-2026-08-21.vocab-backup");
});

test("export rejects malformed local references instead of silently omitting them", async () => {
  const { runtime, state } = await runtimeFixture({
    async query() {
      return { rows: [{ audio_url: "local:../../other-product" }] };
    },
  });
  await assert.rejects(
    backup.createVocabBackupService(runtime).exportCompleteBackup(),
    /无法验证的本地音频引用/,
  );
  assert.equal(state.lockCalls, 1);
  assert.deepEqual(state.readKeys, []);
});

test("complete restore stages authenticated audio, remaps it, then activates and broadcasts", async () => {
  const { runtime, state, source } = await runtimeFixture();
  const result = await backup.createVocabBackupService(runtime)
    .restoreCompleteBackup(await completeContainer([source]));

  assert.equal(state.lockCalls, 1);
  assert.equal(state.saved.length, 1);
  assert.equal(state.staged.length, 1);
  assert.equal(state.activated.length, 1);
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.broadcasts, [GENERATION_ID]);
  assert.equal(result.audioCount, 1);
  const mappingParams = state.staged[0].statements
    .flatMap(({ params = [] }) => Array.isArray(params) ? params : Object.values(params));
  assert.ok(mappingParams.includes(SOURCE_KEY));
  assert.ok(mappingParams.includes(STAGED_KEY));
  assert.ok(state.staged[0].statements.some(({ sql }) =>
    sql.includes("PRAGMA user_version = 2")
  ));
});

test("definite activation failure discards the inactive candidate and staged audio", async () => {
  const { runtime, state, source } = await runtimeFixture({
    async activateStaged(staged) {
      state.activated.push(staged);
      throw new Error("pointer write failed");
    },
  });
  await assert.rejects(
    backup.createVocabBackupService(runtime)
      .restoreCompleteBackup(await completeContainer([source])),
    /pointer write failed/,
  );
  assert.equal(state.discarded.length, 1);
  assert.deepEqual(state.deleted, [STAGED_KEY]);
  assert.deepEqual(state.broadcasts, []);
});

test("lost activation response is idempotently accepted when the candidate is current", async () => {
  const { runtime, state, source } = await runtimeFixture({
    async activateStaged(staged) {
      state.activated.push(staged);
      throw new Error("response lost");
    },
    async currentGeneration() {
      return {
        database: "shici",
        generationId: GENERATION_ID,
        filename: `shici.${GENERATION_ID}.sqlite3`,
        sequence: 2,
        legacy: false,
      };
    },
  });
  await backup.createVocabBackupService(runtime)
    .restoreCompleteBackup(await completeContainer([source]));
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.broadcasts, [GENERATION_ID]);
});

test("uncertain activation retains both candidate and audio for crash recovery", async () => {
  const { runtime, state, source } = await runtimeFixture({
    async activateStaged(staged) {
      state.activated.push(staged);
      throw new Error("worker disconnected");
    },
    async currentGeneration() {
      throw new Error("worker unavailable");
    },
  });
  await assert.rejects(
    backup.createVocabBackupService(runtime)
      .restoreCompleteBackup(await completeContainer([source])),
    (error) => error instanceof backup.VocabActivationUncertainError,
  );
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.broadcasts, []);
});

test("candidate validation failure deletes staged audio while preserving the old generation", async () => {
  const { runtime, state, source } = await runtimeFixture({
    async stageImport(database, statements) {
      state.staged.push({ database, statements });
      throw new Error("candidate schema rejected");
    },
  });
  await assert.rejects(
    backup.createVocabBackupService(runtime)
      .restoreCompleteBackup(await completeContainer([source])),
    /candidate schema rejected/,
  );
  assert.deepEqual(state.deleted, [STAGED_KEY]);
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.activated, []);
});

test("a partially successful OPFS write with bad metadata is still cleaned", async () => {
  const { runtime, state, source } = await runtimeFixture({
    async saveFile(blob, options) {
      const metadata = {
        version: 1,
        namespace: "vocab",
        key: STAGED_KEY,
        originalName: options.originalName,
        mimeType: options.mimeType,
        category: options.category ?? null,
        byteSize: blob.size,
        sha256: "f".repeat(64),
        createdAt: options.createdAt,
        updatedAt: options.updatedAt,
      };
      state.saved.push({ blob, options, metadata });
      return metadata;
    },
  });
  await assert.rejects(
    backup.createVocabBackupService(runtime)
      .restoreCompleteBackup(await completeContainer([source])),
    /暂存音频.*校验失败/,
  );
  assert.deepEqual(state.deleted, [STAGED_KEY]);
  assert.deepEqual(state.staged, []);
  assert.deepEqual(state.activated, []);
});

test("wrong-database staging is rejected and never activated", async () => {
  const { runtime, state } = await runtimeFixture({
    async stageImport(database, statements) {
      state.staged.push({ database, statements });
      return {
        database: "zhiji",
        generationId: GENERATION_ID,
        filename: `zhiji.${GENERATION_ID}.sqlite3`,
        activationToken: ACTIVATION_TOKEN,
        importedBytes: 256,
        schemaVersion: 2,
      };
    },
  });
  await assert.rejects(
    backup.createVocabBackupService(runtime)
      .restoreCompleteBackup(await completeContainer()),
    /另一个产品空间/,
  );
  assert.equal(state.discarded.length, 1);
  assert.deepEqual(state.activated, []);
});

test("corrupt complete backups and future legacy schemas fail before lock or writes", async () => {
  const { runtime, state, source } = await runtimeFixture();
  const valid = await completeContainer([source]);
  const corrupt = new Uint8Array(await valid.arrayBuffer());
  corrupt[corrupt.length - 1] ^= 0xff;
  const service = backup.createVocabBackupService(runtime);
  await assert.rejects(
    service.restoreCompleteBackup(new Blob([corrupt])),
    (error) => error?.code === "AUDIO_HASH_MISMATCH",
  );
  const future = sqliteBytes({ applicationId: 0x53484349, userVersion: 3 });
  await assert.rejects(
    service.restoreLegacyDatabase(new Blob([future])),
    /未来版本/,
  );
  assert.equal(state.lockCalls, 0);
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.staged, []);
});

test("legacy SQLite restore uses the staged v2 migration path with no OPFS writes", async () => {
  const { runtime, state } = await runtimeFixture();
  const result = await backup.createVocabBackupService(runtime)
    .restoreLegacyDatabase(new Blob([sqliteBytes()]));
  assert.equal(result.byteSize, 256);
  assert.equal(state.lockCalls, 1);
  assert.equal(state.staged.length, 1);
  assert.ok(state.staged[0].statements.some(({ sql }) =>
    sql.includes("SET audio_url = NULL")
  ));
  assert.ok(state.staged[0].statements.some(({ sql }) =>
    sql.includes("PRAGMA user_version = 2")
  ));
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.deleted, []);
});
