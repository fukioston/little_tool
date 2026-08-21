import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const SOURCE_KEY = "10000000-0000-4000-8000-000000000001";
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
    export async function assertLocalFileKeyAvailable(){ throw new Error("default runtime not used"); }
    export async function deleteOwnedLocalFile(){ throw new Error("default runtime not used"); }
    export async function getLocalFile(){ throw new Error("default runtime not used"); }
    export async function saveLocalFileAtKey(){ throw new Error("default runtime not used"); }
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

async function completeContainer(audio = [], identity = {}) {
  return format.createVocabBackupBlob({
    database: sqliteBytes(identity),
    audio: audio.map(({ metadata, file }) => ({ metadata, blob: file })),
    exportedAt: "2026-08-20T06:07:08.000Z",
  }, hashBlob);
}

async function runtimeFixture(overrides = {}) {
  const source = await sourceAudio();
  const oldGeneration = {
    database: "shici",
    generationId: "legacy",
    filename: "shici.sqlite3",
    sequence: 0,
    legacy: true,
  };
  const state = {
    lockCalls: 0,
    queries: [],
    readKeys: [],
    keyPreflights: [],
    saved: [],
    deleted: [],
    staged: [],
    recovered: [],
    registered: [],
    completed: [],
    activated: [],
    inspected: [],
    discarded: [],
    broadcasts: [],
    currentChecks: 0,
    current: oldGeneration,
    ready: null,
    prepareStates: new Map(),
    fileOwners: new Map(),
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
    async stageImport(database, statements, recovery) {
      const operation = recovery.prepareOperation;
      const stagedResult = {
        database: "shici",
        generationId: operation.operationId,
        filename: `shici.${operation.operationId}.sqlite3`,
        activationToken: ACTIVATION_TOKEN,
        importedBytes: database.byteLength,
        schemaVersion: 2,
        recoveryReceipt: {
          version: 1,
          database: "shici",
          generationId: operation.operationId,
          recoveryToken: "b".repeat(64),
          expectedCurrentGenerationId: state.current.generationId,
          expectedCurrentSequence: state.current.sequence,
          canonicalApplicationId: 0x53484349,
          canonicalUserVersion: 2,
          projectionSha256: recovery.projectionSha256,
        },
      };
      state.ready = stagedResult;
      state.prepareStates.set(operation.operationId, {
        database: "shici",
        operationId: operation.operationId,
        status: "ready",
        staged: stagedResult,
      });
      state.staged.push({ database, statements, recovery, result: stagedResult });
      return stagedResult;
    },
    async recoverPrepare(receipt) {
      state.recovered.push(receipt);
      const result = state.prepareStates.get(receipt.operationId);
      if (!result) {
        const error = new Error("prepare operation not found");
        error.code = "PREPARE_OPERATION_NOT_FOUND";
        throw error;
      }
      return result;
    },
    async registerPrepareCleanup(receipt) {
      state.registered.push(receipt);
      const result = {
        database: "shici",
        operationId: receipt.operationId,
        status: receipt.stagedAttachmentKeys.length > 0
          ? "cleanup-pending"
          : "cleanup-complete",
        stagedAttachmentKeys: [...receipt.stagedAttachmentKeys],
      };
      state.prepareStates.set(receipt.operationId, result);
      return result;
    },
    async completePrepareCleanup(receipt) {
      state.completed.push(receipt);
      const result = {
        database: "shici",
        operationId: receipt.operationId,
        status: "cleanup-complete",
        stagedAttachmentKeys: [...receipt.stagedAttachmentKeys],
      };
      state.prepareStates.set(receipt.operationId, result);
      return result;
    },
    async activateStaged(staged, recovery) {
      state.activated.push({ staged, recovery });
      state.current = {
        database: "shici",
        generationId: staged.generationId,
        filename: staged.filename,
        sequence: Math.max(1, state.current.sequence + 1),
        legacy: false,
      };
      return {
        database: "shici",
        filename: staged.filename,
        persistent: true,
        sqliteVersion: "3.49.1",
        schemaVersion: 2,
        seeded: false,
        generationId: staged.generationId,
        sequence: state.current.sequence,
      };
    },
    async inspectStaged(staged, recovery) {
      state.inspected.push({ staged, recovery });
      return state.current;
    },
    async currentGeneration() {
      state.currentChecks += 1;
      return state.current;
    },
    async discardStaged(staged, recovery) {
      state.discarded.push({ staged, recovery });
      state.prepareStates.set(staged.generationId, {
        database: "shici",
        operationId: staged.generationId,
        status: "discarded",
      });
      return {
        database: "shici",
        generationId: staged.generationId,
        discarded: true,
      };
    },
    async getFile(key) {
      state.readKeys.push(key);
      if (key !== SOURCE_KEY) throw new Error("unexpected file read");
      return source;
    },
    async assertFileKeyAvailable(key) {
      state.keyPreflights.push(key);
      if (state.fileOwners.has(key)) throw new Error("file key collision");
    },
    async saveFileAtKey(key, blob, options, stagingOwner) {
      const saved = {
        version: 1,
        namespace: "vocab",
        key,
        originalName: options.originalName,
        mimeType: options.mimeType,
        category: options.category ?? null,
        byteSize: blob.size,
        sha256: await hashBlob(blob),
        createdAt: options.createdAt,
        updatedAt: options.updatedAt,
        stagingOwner,
      };
      state.fileOwners.set(key, stagingOwner);
      state.saved.push({ key, blob, options, stagingOwner, metadata: saved });
      return saved;
    },
    async deleteOwnedFile(key, stagingOwner) {
      const owner = state.fileOwners.get(key);
      if (owner !== undefined && owner !== stagingOwner) {
        throw new Error("file ownership mismatch");
      }
      state.deleted.push(key);
      state.fileOwners.delete(key);
      return owner !== undefined;
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
  return { runtime, state, source, oldGeneration };
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
  assert.deepEqual(state.broadcasts, [state.staged[0].result.generationId]);
  assert.equal(result.audioCount, 1);
  const mappingParams = state.staged[0].statements
    .flatMap(({ params = [] }) => Array.isArray(params) ? params : Object.values(params));
  assert.ok(mappingParams.includes(SOURCE_KEY));
  assert.ok(mappingParams.includes(state.saved[0].key));
  assert.ok(state.staged[0].statements.some(({ sql }) =>
    sql.includes("PRAGMA user_version = 2")
  ));
});

test("definite activation failure discards the inactive candidate and staged audio", async () => {
  const { runtime, state, source } = await runtimeFixture({
    async activateStaged(staged, recovery) {
      state.activated.push({ staged, recovery });
      throw new Error("pointer write failed");
    },
  });
  await assert.rejects(
    backup.createVocabBackupService(runtime)
      .restoreCompleteBackup(await completeContainer([source])),
    (error) => error?.code === "ACTIVATION_FAILED",
  );
  assert.equal(state.discarded.length, 1);
  assert.deepEqual(state.deleted, [state.saved[0].key]);
  assert.deepEqual(state.broadcasts, []);
});

test("lost activation response is idempotently accepted when the candidate is current", async () => {
  const { runtime, state, source } = await runtimeFixture({
    async activateStaged(staged, recovery) {
      state.activated.push({ staged, recovery });
      state.current = {
        database: "shici",
        generationId: staged.generationId,
        filename: staged.filename,
        sequence: 2,
        legacy: false,
      };
      throw new Error("response lost");
    },
  });
  await backup.createVocabBackupService(runtime)
    .restoreCompleteBackup(await completeContainer([source]));
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.broadcasts, [state.staged[0].result.generationId]);
});

test("uncertain activation retains both candidate and audio for crash recovery", async () => {
  const { runtime, state, source } = await runtimeFixture({
    async activateStaged(staged, recovery) {
      state.activated.push({ staged, recovery });
      throw new Error("worker disconnected");
    },
    async currentGeneration() {
      state.currentChecks += 1;
      if (state.currentChecks === 1) return state.current;
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

test("lost stage response retains staged audio and returns a recoverable prepare receipt", async () => {
  const { runtime, state, source } = await runtimeFixture({
    async stageImport(database, statements, recovery) {
      state.staged.push({ database, statements, recovery });
      throw new Error("candidate schema rejected");
    },
  });
  let uncertain;
  try {
    await backup.createVocabBackupService(runtime)
      .restoreCompleteBackup(await completeContainer([source]));
  } catch (error) {
    uncertain = error;
  }
  assert.equal(uncertain?.code, "PREPARE_UNCERTAIN");
  assert.deepEqual(JSON.parse(JSON.stringify(uncertain.receipt)), uncertain.receipt);
  assert.equal(uncertain.receipt.stagedAudioKeys.length, 1);
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.activated, []);
});

test("a partially successful OPFS write with bad metadata is still cleaned", async () => {
  const { runtime, state, source } = await runtimeFixture({
    async saveFileAtKey(key, blob, options, stagingOwner) {
      const metadata = {
        version: 1,
        namespace: "vocab",
        key,
        originalName: options.originalName,
        mimeType: options.mimeType,
        category: options.category ?? null,
        byteSize: blob.size,
        sha256: "f".repeat(64),
        createdAt: options.createdAt,
        updatedAt: options.updatedAt,
        stagingOwner,
      };
      state.fileOwners.set(key, stagingOwner);
      state.saved.push({ key, blob, options, stagingOwner, metadata });
      return metadata;
    },
  });
  await assert.rejects(
    backup.createVocabBackupService(runtime)
      .restoreCompleteBackup(await completeContainer([source])),
    /暂存音频.*校验失败/,
  );
  assert.deepEqual(state.deleted, [state.saved[0].key]);
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.staged, []);
  assert.deepEqual(state.activated, []);
});

test("malformed stage response fails closed as prepare-uncertain", async () => {
  const { runtime, state } = await runtimeFixture({
    async stageImport(database, statements, recovery) {
      state.staged.push({ database, statements, recovery });
      return {
        database: "zhiji",
        generationId: recovery.prepareOperation.operationId,
        filename: `zhiji.${recovery.prepareOperation.operationId}.sqlite3`,
        activationToken: ACTIVATION_TOKEN,
        importedBytes: 256,
        schemaVersion: 2,
      };
    },
  });
  await assert.rejects(
    backup.createVocabBackupService(runtime)
      .restoreCompleteBackup(await completeContainer()),
    (error) => error?.code === "PREPARE_UNCERTAIN",
  );
  assert.equal(state.discarded.length, 0);
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
    (error) => error?.code === "UNSUPPORTED_SOURCE",
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

test("prepare checkpoints a JSON-safe capability before writes and never activates", async () => {
  const { runtime, state, source } = await runtimeFixture();
  const service = backup.createVocabBackupService(runtime);
  const checkpoints = [];
  const receipt = await service.prepareBackupRestore(
    await completeContainer([source]),
    {
      onRecoveryPrepared(checkpoint) {
        checkpoints.push(JSON.parse(JSON.stringify(checkpoint)));
        assert.equal(Object.isFrozen(checkpoint), true);
        assert.equal(Object.isFrozen(checkpoint.summary), true);
        assert.equal(Object.isFrozen(checkpoint.stagedAudioKeys), true);
        assert.deepEqual(state.saved, []);
        assert.deepEqual(state.staged, []);
        assert.deepEqual(state.activated, []);
      },
    },
  );

  assert.equal(checkpoints.length, 1);
  assert.equal(receipt.generationId, checkpoints[0].operationId);
  assert.equal(receipt.summary.kind, "complete-backup");
  assert.equal(receipt.summary.sourceUserVersion, 0);
  assert.equal(receipt.stagedAudioKeys.length, 1);
  assert.equal(receipt.stagedAudioKeys[0], state.saved[0].key);
  assert.equal(state.staged.length, 1);
  assert.deepEqual(state.activated, []);
  assert.deepEqual(state.broadcasts, []);
  const serialized = JSON.stringify(checkpoints[0]);
  assert.doesNotMatch(serialized, /episode\.mp3|audio payload/);
  assert.equal(serialized.includes(SOURCE_KEY), false);
  assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt);
});

test("a rejected durable checkpoint leaves OPFS and database staging untouched", async () => {
  const { runtime, state, source } = await runtimeFixture();
  await assert.rejects(
    backup.createVocabBackupService(runtime).prepareBackupRestore(
      await completeContainer([source]),
      {
        onRecoveryPrepared() {
          throw new Error("localStorage quota exceeded");
        },
      },
    ),
    (error) => error?.code === "PREPARE_FAILED",
  );
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.staged, []);
  assert.deepEqual(state.activated, []);
  assert.deepEqual(state.deleted, []);
});

test("lost stage response recovers the same READY candidate after serialized refresh", async () => {
  const { runtime, state, source } = await runtimeFixture();
  const committedStage = runtime.stageImport.bind(runtime);
  runtime.stageImport = async (...args) => {
    await committedStage(...args);
    throw new Error("worker response lost after READY tombstone");
  };
  const service = backup.createVocabBackupService(runtime);
  let checkpoint;
  let uncertain;
  try {
    await service.prepareBackupRestore(await completeContainer([source]), {
      onRecoveryPrepared(receipt) {
        checkpoint = JSON.parse(JSON.stringify(receipt));
      },
    });
  } catch (error) {
    uncertain = error;
  }

  assert.equal(uncertain?.code, "PREPARE_UNCERTAIN");
  assert.deepEqual(uncertain.receipt, checkpoint);
  assert.equal(state.staged.length, 1);
  assert.deepEqual(state.activated, []);
  assert.deepEqual(state.deleted, []);

  const refreshedService = backup.createVocabBackupService(runtime);
  const recovered = await refreshedService.recoverBackupPrepare(
    JSON.parse(JSON.stringify(checkpoint)),
  );
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.receipt.generationId, checkpoint.operationId);
  assert.equal(state.staged.length, 1);
  assert.equal(state.recovered.length, 1);
  assert.deepEqual(state.activated, []);
  assert.deepEqual(state.deleted, []);
});

test("uncertain activation is resolved by a pure bound inspection after refresh", async () => {
  const { runtime, state } = await runtimeFixture();
  const service = backup.createVocabBackupService(runtime);
  const receipt = await service.prepareBackupRestore(await completeContainer());
  runtime.currentGeneration = async () => {
    state.currentChecks += 1;
    if (state.currentChecks === 1) return state.current;
    throw new Error("pointer temporarily unreadable");
  };
  runtime.activateStaged = async (staged, recovery) => {
    state.activated.push({ staged, recovery });
    state.current = {
      database: "shici",
      generationId: staged.generationId,
      filename: staged.filename,
      sequence: 2,
      legacy: false,
    };
    throw new Error("activation response lost");
  };

  let uncertain;
  try {
    await service.activatePreparedRestore(receipt);
  } catch (error) {
    uncertain = error;
  }
  assert.equal(uncertain?.code, "ACTIVATION_UNCERTAIN");
  assert.deepEqual(JSON.parse(JSON.stringify(uncertain.receipt)), receipt);
  assert.equal(state.activated.length, 1);
  assert.deepEqual(state.inspected, []);
  assert.deepEqual(state.discarded, []);

  const inspection = await backup.createVocabBackupService(runtime)
    .inspectRestoreActivation(JSON.parse(JSON.stringify(uncertain.receipt)));
  assert.equal(inspection.status, "current");
  assert.equal(inspection.currentGenerationId, receipt.generationId);
  assert.equal(state.inspected.length, 1);
  assert.equal(state.activated.length, 1);
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.deleted, []);
});

test("broadcast failure cannot reverse a durably activated generation", async () => {
  const { runtime, state } = await runtimeFixture();
  const service = backup.createVocabBackupService(runtime);
  const receipt = await service.prepareBackupRestore(await completeContainer());
  runtime.broadcastGenerationChanged = () => {
    throw new Error("BroadcastChannel unavailable");
  };
  const result = await service.activatePreparedRestore(receipt);
  assert.equal(result.outcome, "activated");
  assert.equal(state.current.generationId, receipt.generationId);
  assert.equal(state.activated.length, 1);
  assert.deepEqual(state.discarded, []);
});

test("discard is idempotent and retries only receipt-owned audio cleanup", async () => {
  const { runtime, state, source } = await runtimeFixture();
  const service = backup.createVocabBackupService(runtime);
  const receipt = await service.prepareBackupRestore(
    await completeContainer([source]),
  );
  const deleteOwned = runtime.deleteOwnedFile.bind(runtime);
  let attempts = 0;
  runtime.deleteOwnedFile = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new Error("OPFS delete response lost");
    return deleteOwned(...args);
  };

  const first = await service.discardPreparedRestore(receipt);
  assert.equal(first.audioCleanup, "incomplete");
  assert.deepEqual(first.failedAudioKeys, receipt.stagedAudioKeys);
  assert.equal(state.fileOwners.has(receipt.stagedAudioKeys[0]), true);
  const second = await service.discardPreparedRestore(
    JSON.parse(JSON.stringify(receipt)),
  );
  assert.equal(second.audioCleanup, "complete");
  assert.deepEqual(second.failedAudioKeys, []);
  assert.equal(state.discarded.length, 2);
  assert.deepEqual(state.deleted, receipt.stagedAudioKeys);
  assert.equal(state.fileOwners.size, 0);
});

test("prepare cleanup receipt survives refresh and completion is idempotent", async () => {
  const { runtime, state, source } = await runtimeFixture();
  runtime.saveFileAtKey = async (key, blob, options, stagingOwner) => {
    state.fileOwners.set(key, stagingOwner);
    state.saved.push({ key, blob, options, stagingOwner });
    throw new Error("audio write response lost");
  };
  const deleteOwned = runtime.deleteOwnedFile.bind(runtime);
  let deleteAttempts = 0;
  runtime.deleteOwnedFile = async (...args) => {
    deleteAttempts += 1;
    if (deleteAttempts === 1) throw new Error("cleanup temporarily unavailable");
    return deleteOwned(...args);
  };

  let cleanupError;
  try {
    await backup.createVocabBackupService(runtime)
      .prepareBackupRestore(await completeContainer([source]));
  } catch (error) {
    cleanupError = error;
  }
  assert.equal(cleanupError?.code, "PREPARE_CLEANUP_INCOMPLETE");
  const serialized = JSON.parse(JSON.stringify(cleanupError.receipt));
  assert.equal(serialized.stagedAudioKeys.length, 1);
  assert.equal(state.registered.length, 1);
  assert.equal(state.fileOwners.has(serialized.stagedAudioKeys[0]), true);

  const refreshed = backup.createVocabBackupService(runtime);
  assert.deepEqual(
    await refreshed.retryPrepareCleanup(serialized),
    { cleaned: true },
  );
  assert.equal(state.completed.length, 1);
  assert.equal(state.fileOwners.size, 0);
  const attemptsAfterCompletion = deleteAttempts;
  assert.deepEqual(
    await refreshed.retryPrepareCleanup(serialized),
    { cleaned: true },
  );
  assert.equal(deleteAttempts, attemptsAfterCompletion);
  assert.equal(state.completed.length, 1);
});

test("complete and legacy v0-v2 all prepare through the canonical v2 path", async () => {
  for (const sourceUserVersion of [0, 1, 2]) {
    const applicationId = sourceUserVersion === 0 ? 0 : 0x53484349;
    const legacy = await runtimeFixture();
    const legacyReceipt = await backup.createVocabBackupService(legacy.runtime)
      .prepareBackupRestore(new Blob([sqliteBytes({
        applicationId,
        userVersion: sourceUserVersion,
      })]));
    assert.equal(legacyReceipt.summary.kind, "legacy-vocab-sqlite");
    assert.equal(legacyReceipt.summary.sourceUserVersion, sourceUserVersion);
    assert.equal(legacyReceipt.canonicalUserVersion, 2);
    assert.equal(legacy.state.activated.length, 0);
    assert.ok(legacy.state.staged[0].statements.some(({ sql }) =>
      sql.includes("PRAGMA user_version = 2")
    ));

    const complete = await runtimeFixture();
    const completeReceipt = await backup.createVocabBackupService(complete.runtime)
      .prepareBackupRestore(await completeContainer([], {
        applicationId,
        userVersion: sourceUserVersion,
      }));
    assert.equal(completeReceipt.summary.kind, "complete-backup");
    assert.equal(completeReceipt.summary.sourceUserVersion, sourceUserVersion);
    assert.equal(completeReceipt.canonicalUserVersion, 2);
    assert.equal(complete.state.activated.length, 0);
  }
});
