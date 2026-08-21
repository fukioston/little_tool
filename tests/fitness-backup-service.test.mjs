import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const SOURCE_KEY = "10000000-0000-4000-8000-000000000001";
const FITNESS_APPLICATION_ID = 0x53484c4e;
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

const [schemaJavaScript, formatJavaScript, rawPlanJavaScript, rawServiceJavaScript] = await Promise.all([
  transpile("lib/schemas/shilian.ts"),
  transpile("lib/fitness/backup-format.ts"),
  transpile("lib/fitness/backup-plan.ts"),
  transpile("lib/fitness/backup.ts"),
]);
const schemaUrl = moduleUrl(schemaJavaScript);
const formatUrl = moduleUrl(formatJavaScript);
const planJavaScript = rawPlanJavaScript.replace(
  /from\s+["']\.\.\/schemas\/shilian["'];/,
  `from ${JSON.stringify(schemaUrl)};`,
);
assert.notEqual(planJavaScript, rawPlanJavaScript, "Fitness plan schema import was not linked");
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
    export function broadcastFitnessChange(){}
    export function withFitnessWriteLock(task){ return task(); }
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

function sqliteBytes({ applicationId = FITNESS_APPLICATION_ID, userVersion = 2 } = {}) {
  const bytes = new Uint8Array(256);
  bytes.set(new TextEncoder().encode("SQLite format 3\0"));
  const view = new DataView(bytes.buffer);
  view.setUint32(60, userVersion, false);
  view.setUint32(68, applicationId, false);
  return bytes;
}

async function sourceFile(index = 0) {
  const ordinal = index + 1;
  const key = `10000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
  const originalName = `squat-${ordinal}.webp`;
  const file = new File([`fitness file payload ${ordinal}`], originalName, {
    type: "image/webp",
  });
  const sha256 = await hashBlob(file);
  const createdAt = 1_777_000_000_000;
  const updatedAt = 1_777_000_100_000;
  const metadata = {
    id: `file-${String(ordinal).padStart(3, "0")}`,
    entityType: "equipment",
    entityId: `equipment-${String(ordinal).padStart(3, "0")}`,
    purpose: "photo",
    key,
    originalName,
    mimeType: "image/webp",
    byteSize: file.size,
    sha256,
    status: "ready",
    createdAt: createdAt + index,
    updatedAt: updatedAt + index,
  };
  return {
    metadata,
    row: {
      id: metadata.id,
      entity_type: metadata.entityType,
      entity_id: metadata.entityId,
      purpose: metadata.purpose,
      file_key: metadata.key,
      file_name: metadata.originalName,
      mime_type: metadata.mimeType,
      byte_size: metadata.byteSize,
      sha256: metadata.sha256,
      status: metadata.status,
      created_at: metadata.createdAt,
      updated_at: metadata.updatedAt,
    },
    storage: {
      version: 1,
      namespace: "fitness",
      key,
      originalName: metadata.originalName,
      mimeType: metadata.mimeType,
      category: `fitness-file:${metadata.id}`,
      byteSize: file.size,
      sha256,
      createdAt: new Date(metadata.createdAt).toISOString(),
      updatedAt: new Date(metadata.updatedAt).toISOString(),
    },
    file,
  };
}

async function completeContainer(file = [], identity = {}) {
  return format.createFitnessBackupBlob({
    database: sqliteBytes(identity),
    files: file.map(({ metadata, file }) => ({ metadata, blob: file })),
    exportedAt: "2026-08-20T06:07:08.000Z",
  }, hashBlob);
}

async function legacyV1CompleteContainer() {
  const database = sqliteBytes({ userVersion: 1 });
  const unsigned = {
    format: "fitness-backup",
    version: 1,
    product: "shilian",
    exportedAt: "2026-08-20T06:07:08.000Z",
    database: {
      byteSize: database.byteLength,
      sha256: await hashBlob(new Blob([database])),
      applicationId: FITNESS_APPLICATION_ID,
      userVersion: 1,
    },
    files: [],
  };
  const manifest = {
    ...unsigned,
    manifestSha256: await hashBlob(new Blob([
      new TextEncoder().encode(JSON.stringify(unsigned)),
    ])),
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const magic = new TextEncoder().encode(format.FITNESS_BACKUP_MAGIC);
  const prefix = new Uint8Array(magic.byteLength + 4);
  prefix.set(magic);
  new DataView(prefix.buffer).setUint32(
    magic.byteLength,
    manifestBytes.byteLength,
    false,
  );
  return new Blob([prefix, manifestBytes, database], {
    type: format.FITNESS_BACKUP_MIME_TYPE,
  });
}

async function runtimeFixture(overrides = {}) {
  const source = await sourceFile();
  const oldGeneration = {
    database: "shilian",
    generationId: "legacy",
    filename: "shilian.sqlite3",
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
      return { rows: [source.row] };
    },
    async exportDatabase() {
      return { data: sqliteBytes() };
    },
    async stageImport(database, statements, recovery) {
      const operation = recovery.prepareOperation;
      const stagedResult = {
        database: "shilian",
        generationId: operation.operationId,
        filename: `shilian.${operation.operationId}.sqlite3`,
        activationToken: ACTIVATION_TOKEN,
        importedBytes: database.byteLength,
        schemaVersion: 2,
        recoveryReceipt: {
          version: 1,
          database: "shilian",
          generationId: operation.operationId,
          recoveryToken: "b".repeat(64),
          expectedCurrentGenerationId: state.current.generationId,
          expectedCurrentSequence: state.current.sequence,
          canonicalApplicationId: FITNESS_APPLICATION_ID,
          canonicalUserVersion: 2,
          projectionSha256: recovery.projectionSha256,
        },
      };
      state.ready = stagedResult;
      state.prepareStates.set(operation.operationId, {
        database: "shilian",
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
        database: "shilian",
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
        database: "shilian",
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
        database: "shilian",
        generationId: staged.generationId,
        filename: staged.filename,
        sequence: Math.max(1, state.current.sequence + 1),
        legacy: false,
      };
      return {
        database: "shilian",
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
        database: "shilian",
        operationId: staged.generationId,
        status: "discarded",
      });
      return {
        database: "shilian",
        generationId: staged.generationId,
        discarded: true,
      };
    },
    async getFile(key) {
      state.readKeys.push(key);
      if (key !== SOURCE_KEY) throw new Error("unexpected file read");
      return { metadata: source.storage, file: source.file };
    },
    async assertFileKeyAvailable(key) {
      state.keyPreflights.push(key);
      if (state.fileOwners.has(key)) throw new Error("file key collision");
    },
    async saveFileAtKey(key, blob, options, stagingOwner) {
      const saved = {
        version: 1,
        namespace: "fitness",
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

test("complete-backup detection is product-specific and performs no write", async () => {
  const blob = await completeContainer();
  assert.equal(await backup.isCompleteFitnessBackup(blob), true);
  assert.equal(
    await backup.isCompleteFitnessBackup(new Blob([sqliteBytes()])),
    false,
  );
  assert.equal(
    await backup.isCompleteFitnessBackup(new Blob([
      new TextEncoder().encode("VOCAB-BACKUP\r\n\u001a"),
    ])),
    false,
  );
});

test("export is locked and includes exactly the ready Fitness file rows", async () => {
  const { runtime, state, source } = await runtimeFixture();
  const service = backup.createFitnessBackupService(runtime);
  const result = await service.exportCompleteBackup();
  const parsed = await format.parseFitnessBackupBlob(result.blob, hashBlob);

  assert.equal(state.lockCalls, 1);
  assert.equal(state.queries.length, 1);
  assert.match(state.queries[0].sql, /FROM fitness_files/);
  assert.match(state.queries[0].sql, /WHERE status='ready'/);
  assert.match(state.queries[0].sql, /ORDER BY file_key,id/);
  assert.deepEqual(state.readKeys, [SOURCE_KEY]);
  assert.equal(parsed.files.length, 1);
  assert.deepEqual(parsed.files[0].metadata, source.metadata);
  assert.equal(await parsed.files[0].blob.text(), await source.file.text());
  assert.equal(result.fileName, "shilian-complete-2026-08-21.fitness-backup");
});

test("export rejects malformed ready rows instead of silently omitting them", async () => {
  const { runtime, state, source } = await runtimeFixture();
  runtime.query = async () => ({
    rows: [{ ...source.row, file_key: "../../other-product" }],
  });
  await assert.rejects(
    backup.createFitnessBackupService(runtime).exportCompleteBackup(),
    /文件索引无法验证/,
  );
  assert.equal(state.lockCalls, 1);
  assert.deepEqual(state.readKeys, []);
});

test("complete restore stages authenticated file, remaps it, then activates and broadcasts", async () => {
  const { runtime, state, source } = await runtimeFixture();
  const result = await backup.createFitnessBackupService(runtime)
    .restoreCompleteBackup(await completeContainer([source]));

  assert.equal(state.lockCalls, 1);
  assert.equal(state.saved.length, 1);
  assert.equal(state.staged.length, 1);
  assert.equal(state.activated.length, 1);
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.broadcasts, [state.staged[0].result.generationId]);
  assert.equal(result.fileCount, 1);
  const mappingParams = state.staged[0].statements
    .flatMap(({ params = [] }) => Array.isArray(params) ? params : Object.values(params));
  assert.ok(mappingParams.includes(SOURCE_KEY));
  assert.ok(mappingParams.includes(state.saved[0].key));
  assert.ok(state.staged[0].statements.some(({ sql }) =>
    sql.includes("PRAGMA user_version = 2")
  ));
});

test("definite activation failure discards the inactive candidate and staged file", async () => {
  const { runtime, state, source } = await runtimeFixture({
    async activateStaged(staged, recovery) {
      state.activated.push({ staged, recovery });
      throw new Error("pointer write failed");
    },
  });
  await assert.rejects(
    backup.createFitnessBackupService(runtime)
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
        database: "shilian",
        generationId: staged.generationId,
        filename: staged.filename,
        sequence: 2,
        legacy: false,
      };
      throw new Error("response lost");
    },
  });
  await backup.createFitnessBackupService(runtime)
    .restoreCompleteBackup(await completeContainer([source]));
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.broadcasts, [state.staged[0].result.generationId]);
});

test("uncertain activation retains both candidate and file for crash recovery", async () => {
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
    backup.createFitnessBackupService(runtime)
      .restoreCompleteBackup(await completeContainer([source])),
    (error) => error instanceof backup.FitnessActivationUncertainError,
  );
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.broadcasts, []);
});

test("lost stage response retains staged file and returns a recoverable prepare receipt", async () => {
  const { runtime, state, source } = await runtimeFixture({
    async stageImport(database, statements, recovery) {
      state.staged.push({ database, statements, recovery });
      throw new Error("candidate schema rejected");
    },
  });
  let uncertain;
  try {
    await backup.createFitnessBackupService(runtime)
      .restoreCompleteBackup(await completeContainer([source]));
  } catch (error) {
    uncertain = error;
  }
  assert.equal(uncertain?.code, "PREPARE_UNCERTAIN");
  assert.deepEqual(JSON.parse(JSON.stringify(uncertain.receipt)), uncertain.receipt);
  assert.equal(uncertain.receipt.stagedFileKeys.length, 1);
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.activated, []);
});

test("a partially successful OPFS write with bad metadata is still cleaned", async () => {
  const { runtime, state, source } = await runtimeFixture({
    async saveFileAtKey(key, blob, options, stagingOwner) {
      const metadata = {
        version: 1,
        namespace: "fitness",
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
    backup.createFitnessBackupService(runtime)
      .restoreCompleteBackup(await completeContainer([source])),
    /暂存附件.*校验失败/,
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
    backup.createFitnessBackupService(runtime)
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
  const service = backup.createFitnessBackupService(runtime);
  await assert.rejects(
    service.restoreCompleteBackup(new Blob([corrupt])),
    (error) => error?.code === "FILE_HASH_MISMATCH",
  );
  const future = sqliteBytes({ applicationId: FITNESS_APPLICATION_ID, userVersion: 3 });
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
  const result = await backup.createFitnessBackupService(runtime)
    .restoreLegacyDatabase(new Blob([sqliteBytes()]));
  assert.equal(result.byteSize, 256);
  assert.equal(state.lockCalls, 1);
  assert.equal(state.staged.length, 1);
  assert.ok(state.staged[0].statements.some(({ sql }) =>
    sql.includes("DELETE FROM fitness_files")
  ));
  assert.ok(state.staged[0].statements.some(({ sql }) =>
    sql.includes("PRAGMA user_version = 2")
  ));
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.deleted, []);
});

test("prepare checkpoints a JSON-safe capability before writes and never activates", async () => {
  const { runtime, state, source } = await runtimeFixture();
  const service = backup.createFitnessBackupService(runtime);
  const checkpoints = [];
  const receipt = await service.prepareBackupRestore(
    await completeContainer([source]),
    {
      onRecoveryPrepared(checkpoint) {
        checkpoints.push(JSON.parse(JSON.stringify(checkpoint)));
        assert.equal(Object.isFrozen(checkpoint), true);
        assert.equal(Object.isFrozen(checkpoint.summary), true);
        assert.equal(Object.isFrozen(checkpoint.stagedFileKeys), true);
        assert.deepEqual(state.saved, []);
        assert.deepEqual(state.staged, []);
        assert.deepEqual(state.activated, []);
      },
    },
  );

  assert.equal(checkpoints.length, 1);
  assert.equal(receipt.generationId, checkpoints[0].operationId);
  assert.equal(receipt.summary.kind, "complete-backup");
  assert.equal(receipt.summary.sourceUserVersion, 2);
  assert.equal(receipt.summary.fileCount, 1);
  assert.equal(receipt.summary.venueCount, null);
  assert.equal(receipt.summary.equipmentCount, null);
  assert.equal(receipt.summary.exerciseCount, null);
  assert.equal(receipt.summary.sessionCount, null);
  assert.match(receipt.databaseSha256, /^[0-9a-f]{64}$/);
  assert.match(receipt.filesSha256, /^[0-9a-f]{64}$/);
  assert.match(receipt.projectionSha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.stagedFileKeys.length, 1);
  assert.equal(receipt.stagedFileKeys[0], state.saved[0].key);
  assert.equal(state.staged.length, 1);
  assert.deepEqual(state.activated, []);
  assert.deepEqual(state.broadcasts, []);
  const serialized = JSON.stringify(checkpoints[0]);
  assert.doesNotMatch(serialized, /squat-1\.webp|fitness file payload/);
  assert.equal(serialized.includes(SOURCE_KEY), false);
  assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt);
});

test("a rejected durable checkpoint leaves OPFS and database staging untouched", async () => {
  const { runtime, state, source } = await runtimeFixture();
  await assert.rejects(
    backup.createFitnessBackupService(runtime).prepareBackupRestore(
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
  const service = backup.createFitnessBackupService(runtime);
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

  const refreshedService = backup.createFitnessBackupService(runtime);
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
  const service = backup.createFitnessBackupService(runtime);
  const receipt = await service.prepareBackupRestore(await completeContainer());
  runtime.currentGeneration = async () => {
    state.currentChecks += 1;
    if (state.currentChecks === 1) return state.current;
    throw new Error("pointer temporarily unreadable");
  };
  runtime.activateStaged = async (staged, recovery) => {
    state.activated.push({ staged, recovery });
    state.current = {
      database: "shilian",
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

  const inspection = await backup.createFitnessBackupService(runtime)
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
  const service = backup.createFitnessBackupService(runtime);
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

test("discard is idempotent and retries only receipt-owned file cleanup", async () => {
  const { runtime, state, source } = await runtimeFixture();
  const service = backup.createFitnessBackupService(runtime);
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
  assert.equal(first.fileCleanup, "incomplete");
  assert.deepEqual(first.failedFileKeys, receipt.stagedFileKeys);
  assert.equal(state.fileOwners.has(receipt.stagedFileKeys[0]), true);
  const second = await service.discardPreparedRestore(
    JSON.parse(JSON.stringify(receipt)),
  );
  assert.equal(second.fileCleanup, "complete");
  assert.deepEqual(second.failedFileKeys, []);
  assert.equal(state.discarded.length, 2);
  assert.deepEqual(state.deleted, receipt.stagedFileKeys);
  assert.equal(state.fileOwners.size, 0);
});

test("prepare cleanup receipt survives refresh and completion is idempotent", async () => {
  const { runtime, state, source } = await runtimeFixture();
  runtime.saveFileAtKey = async (key, blob, options, stagingOwner) => {
    state.fileOwners.set(key, stagingOwner);
    state.saved.push({ key, blob, options, stagingOwner });
    throw new Error("file write response lost");
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
    await backup.createFitnessBackupService(runtime)
      .prepareBackupRestore(await completeContainer([source]));
  } catch (error) {
    cleanupError = error;
  }
  assert.equal(cleanupError?.code, "PREPARE_CLEANUP_INCOMPLETE");
  const serialized = JSON.parse(JSON.stringify(cleanupError.receipt));
  assert.equal(serialized.stagedFileKeys.length, 1);
  assert.equal(state.registered.length, 1);
  assert.equal(state.fileOwners.has(serialized.stagedFileKeys[0]), true);

  const refreshed = backup.createFitnessBackupService(runtime);
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

test("exact-key preflight collision stops before checkpoint or any write", async () => {
  const { runtime, state, source } = await runtimeFixture();
  let checkpointed = false;
  runtime.assertFileKeyAvailable = async (key) => {
    state.keyPreflights.push(key);
    throw new Error("exact key already exists");
  };
  await assert.rejects(
    backup.createFitnessBackupService(runtime).prepareBackupRestore(
      await completeContainer([source]),
      { onRecoveryPrepared() { checkpointed = true; } },
    ),
    (error) => error?.code === "PREPARE_FAILED",
  );
  assert.equal(checkpointed, false);
  assert.equal(state.keyPreflights.length, 1);
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.staged, []);
  assert.deepEqual(state.deleted, []);
});

test("a foreign object appearing after preflight is never deleted by cleanup", async () => {
  const { runtime, state, source } = await runtimeFixture();
  const foreignOwner = "f".repeat(64);
  runtime.saveFileAtKey = async (key) => {
    state.fileOwners.set(key, foreignOwner);
    throw new Error("exact-key collision after preflight");
  };
  let failure;
  try {
    await backup.createFitnessBackupService(runtime).prepareBackupRestore(
      await completeContainer([source]),
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, "PREPARE_CLEANUP_INCOMPLETE");
  assert.equal(failure.receipt.stagedFileKeys.length, 1);
  assert.equal(
    state.fileOwners.get(failure.receipt.stagedFileKeys[0]),
    foreignOwner,
  );
  assert.equal(state.registered.length, 1);
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.staged, []);
});

test("a later attachment failure cleans every receipt-owned staged key", async () => {
  const { runtime, state, source } = await runtimeFixture();
  const second = await sourceFile(1);
  const save = runtime.saveFileAtKey.bind(runtime);
  let saves = 0;
  runtime.saveFileAtKey = async (...args) => {
    saves += 1;
    if (saves === 2) throw new Error("OPFS quota exhausted");
    return save(...args);
  };
  await assert.rejects(
    backup.createFitnessBackupService(runtime).prepareBackupRestore(
      await completeContainer([source, second]),
    ),
    (error) => error?.code === "PREPARE_FAILED",
  );
  assert.equal(state.saved.length, 1);
  assert.equal(state.deleted.length, 2);
  assert.equal(state.fileOwners.size, 0);
  assert.deepEqual(state.staged, []);
});

test("baseline change carries the exact receipt and never attempts activation", async () => {
  const { runtime, state } = await runtimeFixture();
  const service = backup.createFitnessBackupService(runtime);
  const receipt = await service.prepareBackupRestore(await completeContainer());
  state.current = {
    database: "shilian",
    generationId: "40000000-0000-4000-8000-000000000004",
    filename: "shilian.40000000-0000-4000-8000-000000000004.sqlite3",
    sequence: 1,
    legacy: false,
  };
  await assert.rejects(
    service.activatePreparedRestore(JSON.parse(JSON.stringify(receipt))),
    (error) =>
      error instanceof backup.FitnessCurrentGenerationChangedError &&
      error.receipt.generationId === receipt.generationId &&
      error.currentGenerationId === state.current.generationId,
  );
  assert.deepEqual(state.activated, []);
  assert.deepEqual(state.discarded, []);
});

test("strict receipt parsing rejects projection, digest, and extra-field tampering", async () => {
  const { runtime, state, source } = await runtimeFixture();
  const service = backup.createFitnessBackupService(runtime);
  const receipt = await service.prepareBackupRestore(await completeContainer([source]));
  const cases = [
    { ...receipt, databaseSha256: "f".repeat(64) },
    { ...receipt, filesSha256: "e".repeat(64) },
    { ...receipt, stagedFileKeys: ["50000000-0000-4000-8000-000000000005"] },
    { ...receipt, unsupported: true },
  ];
  for (const tampered of cases) {
    await assert.rejects(
      service.inspectRestoreActivation(tampered),
      (error) => error?.code === "INVALID_RECEIPT",
    );
  }
  assert.deepEqual(state.inspected, []);
  assert.equal(state.activated.length, 0);
});

test("lost discard response keeps the receipt and defers all file deletion", async () => {
  const { runtime, state, source } = await runtimeFixture();
  const service = backup.createFitnessBackupService(runtime);
  const receipt = await service.prepareBackupRestore(await completeContainer([source]));
  const discard = runtime.discardStaged.bind(runtime);
  let calls = 0;
  runtime.discardStaged = async (...args) => {
    calls += 1;
    const result = await discard(...args);
    if (calls === 1) throw new Error("discard response lost");
    return result;
  };
  await assert.rejects(
    service.discardPreparedRestore(receipt),
    (error) =>
      error instanceof backup.FitnessDiscardUncertainError &&
      error.receipt.generationId === receipt.generationId,
  );
  assert.equal(state.fileOwners.has(receipt.stagedFileKeys[0]), true);
  assert.deepEqual(state.deleted, []);
  const retry = await service.discardPreparedRestore(receipt);
  assert.equal(retry.fileCleanup, "complete");
  assert.equal(state.fileOwners.size, 0);
});

test("lost cleanup completion response recovers without deleting twice", async () => {
  const { runtime, state, source } = await runtimeFixture();
  runtime.saveFileAtKey = async (key, blob, options, stagingOwner) => {
    state.fileOwners.set(key, stagingOwner);
    state.saved.push({ key, blob, options, stagingOwner });
    throw new Error("write response lost");
  };
  const deleteOwned = runtime.deleteOwnedFile.bind(runtime);
  let deleteAttempts = 0;
  runtime.deleteOwnedFile = async (...args) => {
    deleteAttempts += 1;
    if (deleteAttempts === 1) throw new Error("initial cleanup unavailable");
    return deleteOwned(...args);
  };
  let cleanupReceipt;
  try {
    await backup.createFitnessBackupService(runtime).prepareBackupRestore(
      await completeContainer([source]),
    );
  } catch (error) {
    cleanupReceipt = error.receipt;
  }
  const completeCleanup = runtime.completePrepareCleanup.bind(runtime);
  runtime.completePrepareCleanup = async (...args) => {
    await completeCleanup(...args);
    throw new Error("cleanup completion response lost");
  };
  await assert.rejects(
    backup.createFitnessBackupService(runtime).retryPrepareCleanup(cleanupReceipt),
    (error) => error?.code === "PREPARE_CLEANUP_INCOMPLETE",
  );
  const attemptsAfterLostResponse = deleteAttempts;
  assert.deepEqual(
    await backup.createFitnessBackupService(runtime)
      .retryPrepareCleanup(cleanupReceipt),
    { cleaned: true },
  );
  assert.equal(deleteAttempts, attemptsAfterLostResponse);
  assert.equal(state.fileOwners.size, 0);
});

test("complete and legacy v1-v2 all prepare through the canonical v2 path", async () => {
  for (const sourceUserVersion of [1, 2]) {
    const applicationId = FITNESS_APPLICATION_ID;
    const legacy = await runtimeFixture();
    const legacyReceipt = await backup.createFitnessBackupService(legacy.runtime)
      .prepareBackupRestore(new Blob([sqliteBytes({
        applicationId,
        userVersion: sourceUserVersion,
      })]));
    assert.equal(legacyReceipt.summary.kind, "legacy-fitness-sqlite");
    assert.equal(legacyReceipt.summary.sourceUserVersion, sourceUserVersion);
    assert.equal(legacyReceipt.canonicalUserVersion, 2);
    assert.equal(legacy.state.activated.length, 0);
    assert.ok(legacy.state.staged[0].statements.some(({ sql }) =>
      sql.includes("PRAGMA user_version = 2")
    ));

    const complete = await runtimeFixture();
    const completeBlob = sourceUserVersion === 1
      ? await legacyV1CompleteContainer()
      : await completeContainer();
    const completeReceipt = await backup.createFitnessBackupService(complete.runtime)
      .prepareBackupRestore(completeBlob);
    assert.equal(completeReceipt.summary.kind, "complete-backup");
    assert.equal(completeReceipt.summary.sourceUserVersion, sourceUserVersion);
    assert.equal(completeReceipt.canonicalUserVersion, 2);
    assert.equal(complete.state.activated.length, 0);
  }
});

test("default exported writes refuse to run without real Web Locks", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: undefined,
  });
  try {
    await assert.rejects(
      backup.exportCompleteFitnessBackup(),
      /不支持安全的跨标签页备份锁/,
    );
    await assert.rejects(
      backup.restoreLegacyFitnessDatabase(new Blob([sqliteBytes()])),
      /不支持安全的跨标签页备份锁/,
    );
  } finally {
    if (descriptor) Object.defineProperty(navigator, "locks", descriptor);
    else delete navigator.locks;
  }
});
