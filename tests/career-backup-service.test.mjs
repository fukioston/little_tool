import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const ZHIJI_APPLICATION_ID = 0x5a484a49;
const GENERATION_ID = "30000000-0000-4000-8000-000000000001";
const OLD_GENERATION_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_GENERATION_ID = "40000000-0000-4000-8000-000000000001";
const ACTIVATION_TOKEN = "a".repeat(64);
const RECOVERY_TOKEN = "b".repeat(64);
const SOURCE_KEY = "10000000-0000-4000-8000-000000000001";
const STAGED_KEY = "20000000-0000-4000-8000-000000000001";

// Stable caller operation id keeps the fixture assertions deterministic.
globalThis.crypto.randomUUID = () => GENERATION_ID;

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

const [
  schemaJavaScript,
  formatJavaScript,
  rawPlanJavaScript,
  rawServiceJavaScript,
] = await Promise.all([
  transpile("lib/schemas/zhiji.ts"),
  transpile("lib/career/backup-format.ts"),
  transpile("lib/career/backup-plan.ts"),
  transpile("lib/career/backup.ts"),
]);
const schemaUrl = moduleUrl(schemaJavaScript);
const formatUrl = moduleUrl(formatJavaScript);
const planJavaScript = rawPlanJavaScript.replace(
  /from\s+["']\.\.\/schemas\/zhiji["'];/,
  `from ${JSON.stringify(schemaUrl)};`,
);
assert.notEqual(planJavaScript, rawPlanJavaScript, "Career plan schema import was not linked");
const planUrl = moduleUrl(planJavaScript);

const clientUrl = moduleUrl(`
  function runtime(){
    const value=globalThis.__careerBackupServiceTestRuntime;
    if(!value) throw new Error("Career backup test runtime is missing");
    return value;
  }
  export const localDb={
    stageImport(database,bytes,statements,requirements,options){
      return runtime().stageImport(database,bytes,statements,requirements,options);
    },
    registerPrepareCleanup(database,receipt){
      return runtime().registerPrepareCleanup(database,receipt);
    },
    recoverPrepare(database,receipt){
      return runtime().recoverPrepare(database,receipt);
    },
    completePrepareCleanup(database,receipt){
      return runtime().completePrepareCleanup(database,receipt);
    },
    activateStaged(database,generationId,activationToken,recoveryReceipt){
      return runtime().activateStaged(database,generationId,activationToken,recoveryReceipt);
    },
    inspectStaged(database,generationId,activationToken,recoveryReceipt){
      return runtime().inspectStaged(database,generationId,activationToken,recoveryReceipt);
    },
    currentGeneration(database){ return runtime().currentGeneration(database); },
    discardStaged(database,generationId,activationToken,recoveryReceipt){
      return runtime().discardStaged(database,generationId,activationToken,recoveryReceipt);
    },
  };
`);
const filesUrl = moduleUrl(`
  function runtime(){
    const value=globalThis.__careerBackupServiceTestRuntime;
    if(!value) throw new Error("Career backup test runtime is missing");
    return value;
  }
  export function deleteLocalFile(database,key){
    return runtime().deleteLocalFile(database,key);
  }
  export function getLocalFile(database,key){
    return runtime().getLocalFile(database,key);
  }
  export function saveLocalFile(database,blob,options){
    return runtime().saveLocalFile(database,blob,options);
  }
  export async function sha256Blob(blob){
    const digest=await crypto.subtle.digest("SHA-256",await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
  }
`);
const lockUrl = moduleUrl(`
  function runtime(){
    const value=globalThis.__careerBackupServiceTestRuntime;
    if(!value) throw new Error("Career backup test runtime is missing");
    return value;
  }
  export function withCareerBackupLock(task){
    return runtime().withCareerBackupLock(task);
  }
  export function broadcastCareerGenerationChanged(generationId){
    return runtime().broadcastCareerGenerationChanged(generationId);
  }
`);
const dbUrl = moduleUrl(`
  export function exportCareerDb(){ throw new Error("export is outside this test boundary"); }
  export function loadCareerData(){ throw new Error("export is outside this test boundary"); }
`);
const dependencies = {
  "@/lib/local-db/client": clientUrl,
  "@/lib/local-db/files": filesUrl,
  "./backup-format": formatUrl,
  "./backup-plan": planUrl,
  "./db": dbUrl,
  "./lock": lockUrl,
};
let serviceJavaScript = rawServiceJavaScript;
for (const [specifier, url] of Object.entries(dependencies)) {
  serviceJavaScript = serviceJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const [format, backupService] = await Promise.all([
  import(formatUrl),
  import(moduleUrl(serviceJavaScript)),
]);

async function hashBlob(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Buffer.from(digest).toString("hex");
}

async function projectionDigestForReceipt(receipt) {
  return hashBlob(new Blob([JSON.stringify({
    version: 1,
    database: "zhiji",
    preparedAt: receipt.preparedAt,
    summary: {
      kind: receipt.summary.kind,
      fileName: receipt.summary.fileName,
      byteSize: receipt.summary.byteSize,
      databaseByteSize: receipt.summary.databaseByteSize,
      exportedAt: receipt.summary.exportedAt,
      sourceUserVersion: receipt.summary.sourceUserVersion,
      canonicalUserVersion: receipt.summary.canonicalUserVersion,
      attachmentCount: receipt.summary.attachmentCount,
      jobCount: receipt.summary.jobCount,
      materialCount: receipt.summary.materialCount,
      verification: receipt.summary.verification,
    },
    stagedAttachmentKeys: receipt.stagedAttachmentKeys,
  })], { type: "application/json" }));
}

async function attachmentKeysDigest(keys) {
  return hashBlob(new Blob([
    JSON.stringify({ version: 1, stagedAttachmentKeys: keys }),
  ], { type: "application/json" }));
}

function sqliteBytes(userVersion = 3, applicationId = userVersion === 0 ? 0 : ZHIJI_APPLICATION_ID) {
  const bytes = new Uint8Array(512);
  bytes.set(new TextEncoder().encode("SQLite format 3\0"));
  const view = new DataView(bytes.buffer);
  view.setUint32(60, userVersion, false);
  view.setUint32(68, applicationId, false);
  return bytes;
}

async function completeContainer(userVersion = 3) {
  const file = new File(["private career material"], "resume.pdf", {
    type: "application/pdf",
  });
  return format.createCareerBackupBlob({
    database: sqliteBytes(userVersion),
    attachments: [{
      metadata: {
        key: SOURCE_KEY,
        originalName: file.name,
        mimeType: file.type,
        category: "career-material:resume",
        byteSize: file.size,
        sha256: await hashBlob(file),
        createdAt: "2026-08-20T06:07:08.000Z",
        updatedAt: "2026-08-20T07:08:09.000Z",
      },
      blob: file,
    }],
    exportedAt: "2026-08-20T08:09:10.000Z",
  }, hashBlob);
}

async function runtimeFixture(overrides = {}) {
  const oldGeneration = {
    database: "zhiji",
    generationId: OLD_GENERATION_ID,
    filename: `zhiji.${OLD_GENERATION_ID}.sqlite3`,
    sequence: 1,
    legacy: false,
  };
  const nextGeneration = {
    database: "zhiji",
    generationId: GENERATION_ID,
    filename: `zhiji.${GENERATION_ID}.sqlite3`,
    sequence: 2,
    legacy: false,
  };
  const stagedResult = {
    database: "zhiji",
    generationId: GENERATION_ID,
    filename: `zhiji.${GENERATION_ID}.sqlite3`,
    activationToken: ACTIVATION_TOKEN,
    importedBytes: 512,
    schemaVersion: 3,
  };
  const state = {
    lockCalls: 0,
    saved: [],
    deleted: [],
    staged: [],
    activated: [],
    inspected: [],
    currentChecks: 0,
    current: oldGeneration,
    currentDatabaseSha256: "e".repeat(64),
    boundRecovery: null,
    boundCurrentDatabaseSha256: null,
    prepareReceipt: null,
    prepareStatus: null,
    preparedStageResult: null,
    discarded: [],
    broadcasts: [],
  };
  const runtime = {
    async withCareerBackupLock(task) {
      state.lockCalls += 1;
      return task({ token: Symbol("career-backup-test"), mode: "exclusive" });
    },
    async saveLocalFile(database, blob, options) {
      const metadata = {
        version: 1,
        namespace: database,
        key: STAGED_KEY,
        originalName: options.originalName,
        mimeType: options.mimeType,
        category: options.category ?? null,
        byteSize: blob.size,
        sha256: await hashBlob(blob),
        createdAt: options.createdAt,
        updatedAt: options.updatedAt,
      };
      state.saved.push({ database, blob, options, metadata });
      return metadata;
    },
    async deleteLocalFile(database, key) {
      state.deleted.push({ database, key });
    },
    async getLocalFile() {
      throw new Error("export is outside this test boundary");
    },
    async stageImport(database, bytes, statements, requirements, options) {
      state.staged.push({ database, bytes, statements, requirements, options });
      const prepareReceipt = options.recovery.prepareOperation;
      assert.equal(prepareReceipt.operationId, GENERATION_ID);
      assert.equal(prepareReceipt.generationId, GENERATION_ID);
      state.prepareReceipt = structuredClone(prepareReceipt);
      state.prepareStatus = "ready";
      const recoveryReceipt = {
        version: 1,
        database: "zhiji",
        generationId: GENERATION_ID,
        recoveryToken: RECOVERY_TOKEN,
        expectedCurrentGenerationId: state.current.generationId,
        expectedCurrentSequence: state.current.sequence,
        canonicalApplicationId: ZHIJI_APPLICATION_ID,
        canonicalUserVersion: 3,
        projectionSha256: options.recovery.projectionSha256,
      };
      state.boundRecovery = recoveryReceipt;
      state.boundCurrentDatabaseSha256 = state.currentDatabaseSha256;
      state.preparedStageResult = {
        ...stagedResult,
        recoveryReceipt,
      };
      return state.preparedStageResult;
    },
    async registerPrepareCleanup(database, receipt) {
      assert.equal(database, "career");
      if (state.prepareReceipt &&
          JSON.stringify(state.prepareReceipt) !== JSON.stringify(receipt)) {
        const error = new Error("prepare binding mismatch");
        error.code = "PREPARE_OPERATION_BINDING_MISMATCH";
        throw error;
      }
      state.prepareReceipt = structuredClone(receipt);
      state.prepareStatus = receipt.stagedAttachmentKeys.length
        ? "cleanup-pending"
        : "cleanup-complete";
      return {
        database: "zhiji",
        operationId: receipt.operationId,
        status: state.prepareStatus,
        stagedAttachmentKeys: [...receipt.stagedAttachmentKeys],
      };
    },
    async recoverPrepare(database, receipt) {
      assert.equal(database, "career");
      if (!state.prepareReceipt) {
        const error = new Error("prepare operation absent");
        error.code = "PREPARE_OPERATION_NOT_FOUND";
        throw error;
      }
      if (JSON.stringify(state.prepareReceipt) !== JSON.stringify(receipt)) {
        const error = new Error("prepare binding mismatch");
        error.code = "PREPARE_OPERATION_BINDING_MISMATCH";
        throw error;
      }
      if (state.prepareStatus === "ready") {
        return {
          database: "zhiji",
          operationId: receipt.operationId,
          status: "ready",
          staged: state.preparedStageResult,
        };
      }
      return {
        database: "zhiji",
        operationId: receipt.operationId,
        status: state.prepareStatus,
        stagedAttachmentKeys: [...receipt.stagedAttachmentKeys],
      };
    },
    async completePrepareCleanup(database, receipt) {
      assert.equal(database, "career");
      if (JSON.stringify(state.prepareReceipt) !== JSON.stringify(receipt) ||
          state.prepareStatus !== "cleanup-pending") {
        const error = new Error("cleanup not authorized");
        error.code = "PREPARE_CLEANUP_NOT_AUTHORIZED";
        throw error;
      }
      state.prepareStatus = "cleanup-complete";
      return {
        database: "zhiji",
        operationId: receipt.operationId,
        status: "cleanup-complete",
        stagedAttachmentKeys: [...receipt.stagedAttachmentKeys],
      };
    },
    async activateStaged(database, generationId, activationToken, recoveryReceipt) {
      state.activated.push({ database, generationId, activationToken, recoveryReceipt });
      if (
        database !== "career" || generationId !== GENERATION_ID ||
        activationToken !== ACTIVATION_TOKEN ||
        JSON.stringify(recoveryReceipt) !== JSON.stringify(state.boundRecovery)
      ) {
        const error = new Error("worker recovery binding mismatch");
        error.code = "RECOVERY_BINDING_MISMATCH";
        throw error;
      }
      if (
        state.current.generationId !== GENERATION_ID &&
        (state.current.generationId !== state.boundRecovery.expectedCurrentGenerationId ||
          state.current.sequence !== state.boundRecovery.expectedCurrentSequence ||
          state.currentDatabaseSha256 !== state.boundCurrentDatabaseSha256)
      ) {
        const error = new Error("worker baseline changed");
        error.code = "STAGED_BASELINE_CHANGED";
        throw error;
      }
      state.current = nextGeneration;
      return {
        database: "zhiji",
        filename: `zhiji.${generationId}.sqlite3`,
        persistent: true,
        sqliteVersion: "3.53.0",
        schemaVersion: 3,
        seeded: false,
        generationId,
        sequence: state.current.sequence,
      };
    },
    async currentGeneration() {
      state.currentChecks += 1;
      return state.current;
    },
    async inspectStaged(database, generationId, activationToken, recoveryReceipt) {
      state.inspected.push({ database, generationId, activationToken, recoveryReceipt });
      if (
        database !== "career" || generationId !== GENERATION_ID ||
        activationToken !== ACTIVATION_TOKEN ||
        JSON.stringify(recoveryReceipt) !== JSON.stringify(state.boundRecovery)
      ) {
        const error = new Error("worker recovery binding mismatch");
        error.code = "RECOVERY_BINDING_MISMATCH";
        throw error;
      }
      return state.current;
    },
    async discardStaged(database, generationId, activationToken, recoveryReceipt) {
      state.discarded.push({ database, generationId, activationToken, recoveryReceipt });
      if (
        database !== "career" || generationId !== GENERATION_ID ||
        activationToken !== ACTIVATION_TOKEN ||
        JSON.stringify(recoveryReceipt) !== JSON.stringify(state.boundRecovery)
      ) {
        const error = new Error("worker recovery binding mismatch");
        error.code = "RECOVERY_BINDING_MISMATCH";
        throw error;
      }
      return { database: "zhiji", generationId, discarded: true };
    },
    broadcastCareerGenerationChanged(generationId) {
      state.broadcasts.push(generationId);
    },
    ...overrides,
  };
  globalThis.__careerBackupServiceTestRuntime = runtime;
  return { runtime, state, stagedResult, oldGeneration, nextGeneration };
}

test("prepare verifies a complete backup into a serializable candidate without activating", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );

  assert.equal(receipt.version, 1);
  assert.equal(receipt.database, "zhiji");
  assert.equal(receipt.generationId, GENERATION_ID);
  assert.equal(receipt.activationToken, ACTIVATION_TOKEN);
  assert.equal(receipt.recoveryToken, RECOVERY_TOKEN);
  assert.equal(receipt.expectedCurrentGenerationId, OLD_GENERATION_ID);
  assert.equal(receipt.expectedCurrentSequence, 1);
  assert.deepEqual(receipt.stagedAttachmentKeys, [STAGED_KEY]);
  assert.equal(receipt.summary.kind, "complete-backup");
  assert.equal(receipt.summary.exportedAt, "2026-08-20T08:09:10.000Z");
  assert.equal(receipt.summary.attachmentCount, 1);
  assert.equal(receipt.summary.jobCount, null);
  assert.equal(receipt.summary.materialCount, null);
  assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt);
  assert.equal(fixture.state.staged.length, 1);
  assert.equal(fixture.state.activated.length, 0);
  assert.equal(fixture.state.current.generationId, OLD_GENERATION_ID);
  assert.deepEqual(fixture.state.broadcasts, []);
});

test("an awaited recovery checkpoint precedes database staging with attachments", async () => {
  const fixture = await runtimeFixture();
  let enterHook;
  let releaseHook;
  const hookEntered = new Promise((resolve) => { enterHook = resolve; });
  const hookGate = new Promise((resolve) => { releaseHook = resolve; });
  let checkpoint;

  const operation = backupService.prepareCareerBackupRestore(
    await completeContainer(),
    {
      async onRecoveryPrepared(value) {
        checkpoint = JSON.parse(JSON.stringify(value));
        assert.equal(Object.isFrozen(value), true);
        assert.equal(Object.isFrozen(value.summary), true);
        assert.equal(Object.isFrozen(value.stagedAttachmentKeys), true);
        enterHook();
        await hookGate;
      },
    },
  );

  await hookEntered;
  assert.equal(fixture.state.saved.length, 1);
  assert.equal(fixture.state.staged.length, 0);
  assert.equal(checkpoint.operationId, GENERATION_ID);
  assert.equal(checkpoint.generationId, GENERATION_ID);
  assert.deepEqual(checkpoint.stagedAttachmentKeys, [STAGED_KEY]);
  assert.deepEqual(JSON.parse(JSON.stringify(checkpoint)), checkpoint);

  releaseHook();
  const prepared = await operation;
  assert.equal(fixture.state.staged.length, 1);
  assert.equal(prepared.generationId, checkpoint.generationId);
  assert.equal(prepared.projectionSha256, checkpoint.projectionSha256);
  assert.equal(
    fixture.state.staged[0].options.recovery.prepareOperation.operationToken,
    checkpoint.operationToken,
  );
});

test("a legacy restore without attachments also checkpoints before database staging", async () => {
  const fixture = await runtimeFixture();
  let checkpoint;

  await backupService.prepareCareerBackupRestore(
    new File([sqliteBytes(3)], "career-v3.sqlite3"),
    {
      onRecoveryPrepared(value) {
        checkpoint = JSON.parse(JSON.stringify(value));
        assert.equal(fixture.state.saved.length, 0);
        assert.equal(fixture.state.staged.length, 0);
      },
    },
  );

  assert.equal(checkpoint.summary.kind, "legacy-career-sqlite");
  assert.deepEqual(checkpoint.stagedAttachmentKeys, []);
  assert.equal(fixture.state.staged.length, 1);
});

test("a rejected recovery checkpoint prevents database staging and rolls back attachments", async () => {
  const fixture = await runtimeFixture();

  await assert.rejects(
    backupService.prepareCareerBackupRestore(await completeContainer(), {
      async onRecoveryPrepared() {
        throw new Error("persistent recovery write rejected");
      },
    }),
    (error) => error?.code === "PREPARE_FAILED" &&
      error?.message.includes("没有开始建立候选"),
  );

  assert.equal(fixture.state.saved.length, 1);
  assert.equal(fixture.state.staged.length, 0);
  assert.deepEqual(fixture.state.deleted, [
    { database: "career", key: STAGED_KEY },
  ]);
  assert.equal(fixture.state.prepareReceipt, null);
});

test("a rejected checkpoint plus unknown rollback exposes durable bound cleanup", async () => {
  const fixture = await runtimeFixture();
  const originalRegister = fixture.runtime.registerPrepareCleanup;
  fixture.runtime.deleteLocalFile = async (database, key) => {
    fixture.state.deleted.push({ database, key });
    throw new Error("temporary OPFS delete failure");
  };
  fixture.runtime.registerPrepareCleanup = async (...args) => {
    await originalRegister(...args);
    throw new Error("cleanup binding response lost");
  };
  let cleanupError;

  try {
    await backupService.prepareCareerBackupRestore(await completeContainer(), {
      onRecoveryPrepared() {
        throw new Error("persistent recovery write rejected");
      },
    });
  } catch (error) {
    cleanupError = error;
  }

  assert.equal(cleanupError?.code, "PREPARE_CLEANUP_INCOMPLETE");
  assert.deepEqual(
    JSON.parse(JSON.stringify(cleanupError.receipt)),
    cleanupError.receipt,
  );
  assert.equal(fixture.state.staged.length, 0);
  assert.deepEqual(fixture.state.prepareReceipt, cleanupError.receipt);

  fixture.runtime.deleteLocalFile = async (database, key) => {
    fixture.state.deleted.push({ database, key });
  };
  fixture.runtime.registerPrepareCleanup = originalRegister;
  assert.deepEqual(
    await backupService.retryCareerPrepareCleanup(
      JSON.parse(JSON.stringify(cleanupError.receipt)),
    ),
    { cleaned: true },
  );
  assert.equal(fixture.state.prepareStatus, "cleanup-complete");
});

test("activate performs one guarded activation and treats broadcast failure as best-effort", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );
  fixture.runtime.broadcastCareerGenerationChanged = (generationId) => {
    fixture.state.broadcasts.push(generationId);
    throw new Error("BroadcastChannel closed");
  };

  const result = await backupService.activatePreparedCareerRestore(receipt);

  assert.equal(result.outcome, "activated");
  assert.equal(result.generationId, GENERATION_ID);
  assert.equal(fixture.state.activated.length, 1, "activation must never retry");
  assert.equal(fixture.state.current.generationId, GENERATION_ID);
  assert.deepEqual(fixture.state.broadcasts, [GENERATION_ID]);
  assert.deepEqual(fixture.state.discarded, []);
  assert.deepEqual(fixture.state.deleted, []);
});

test("a lost activation response is confirmed without a second activation", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );
  fixture.runtime.activateStaged = async (database, generationId, activationToken, recoveryReceipt) => {
    fixture.state.activated.push({ database, generationId, activationToken, recoveryReceipt });
    fixture.state.current = fixture.nextGeneration;
    throw new Error("activation response lost");
  };

  const result = await backupService.activatePreparedCareerRestore(receipt);

  assert.equal(result.outcome, "confirmed-after-lost-response");
  assert.equal(fixture.state.activated.length, 1);
  assert.equal(fixture.state.current.generationId, GENERATION_ID);
  assert.deepEqual(fixture.state.discarded, []);
  assert.deepEqual(fixture.state.deleted, []);
});

test("uncertain activation retains the receipt and inspect only reads current generation", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );
  let activationChecks = 0;
  fixture.runtime.activateStaged = async (database, generationId, activationToken, recoveryReceipt) => {
    fixture.state.activated.push({ database, generationId, activationToken, recoveryReceipt });
    fixture.state.current = fixture.nextGeneration;
    throw new Error("activation response lost");
  };
  fixture.runtime.currentGeneration = async () => {
    fixture.state.currentChecks += 1;
    activationChecks += 1;
    if (activationChecks === 1) return fixture.oldGeneration;
    throw new Error("generation pointer temporarily unreadable");
  };

  await assert.rejects(
    backupService.activatePreparedCareerRestore(receipt),
    (error) => error?.name === "CareerActivationUncertainError" &&
      error?.code === "ACTIVATION_UNCERTAIN" &&
      error?.targetGenerationId === GENERATION_ID,
  );

  const callsBeforeInspect = {
    staged: fixture.state.staged.length,
    activated: fixture.state.activated.length,
    discarded: fixture.state.discarded.length,
    deleted: fixture.state.deleted.length,
  };
  fixture.runtime.currentGeneration = async () => {
    fixture.state.currentChecks += 1;
    return fixture.state.current;
  };
  const inspection = await backupService.inspectCareerRestoreActivation(
    JSON.parse(JSON.stringify(receipt)),
  );
  assert.equal(inspection.status, "current");
  assert.deepEqual({
    staged: fixture.state.staged.length,
    activated: fixture.state.activated.length,
    discarded: fixture.state.discarded.length,
    deleted: fixture.state.deleted.length,
  }, callsBeforeInspect);
});

test("inspect reports a different current generation without touching the candidate", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );
  fixture.state.current = {
    ...fixture.nextGeneration,
    generationId: OTHER_GENERATION_ID,
    filename: `zhiji.${OTHER_GENERATION_ID}.sqlite3`,
    sequence: 4,
  };

  const inspection = await backupService.inspectCareerRestoreActivation(receipt);

  assert.deepEqual(inspection, {
    status: "different-current",
    currentGenerationId: OTHER_GENERATION_ID,
    currentSequence: 4,
  });
  assert.equal(fixture.state.activated.length, 0);
  assert.equal(fixture.state.discarded.length, 0);
  assert.equal(fixture.state.deleted.length, 0);
});

test("inspect rejects a self-consistent forged receipt instead of blessing the current generation", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );
  fixture.state.current = {
    database: "zhiji",
    generationId: OTHER_GENERATION_ID,
    filename: `zhiji.${OTHER_GENERATION_ID}.sqlite3`,
    sequence: 7,
    legacy: false,
  };
  const forged = {
    ...JSON.parse(JSON.stringify(receipt)),
    generationId: OTHER_GENERATION_ID,
    activationToken: "c".repeat(64),
    recoveryToken: "d".repeat(64),
    summary: { ...receipt.summary, fileName: "forged.career-backup" },
  };
  forged.projectionSha256 = await projectionDigestForReceipt(forged);

  await assert.rejects(
    backupService.inspectCareerRestoreActivation(forged),
    (error) => error?.code === "INVALID_RECEIPT",
  );
  assert.equal(fixture.state.inspected.length, 1);
  assert.equal(fixture.state.activated.length, 0);
  assert.equal(fixture.state.discarded.length, 0);
  assert.equal(fixture.state.deleted.length, 0);
});

test("activation refuses a changed baseline before writing", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );
  fixture.state.current = {
    ...fixture.nextGeneration,
    generationId: OTHER_GENERATION_ID,
    filename: `zhiji.${OTHER_GENERATION_ID}.sqlite3`,
    sequence: 9,
  };

  await assert.rejects(
    backupService.activatePreparedCareerRestore(receipt),
    (error) => error?.code === "CURRENT_GENERATION_CHANGED" &&
      error?.currentGenerationId === OTHER_GENERATION_ID,
  );
  assert.equal(fixture.state.activated.length, 0);
  assert.equal(fixture.state.discarded.length, 0);
  assert.equal(fixture.state.deleted.length, 0);
});

test("activation refuses ordinary edits even when generation identity did not change", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );
  fixture.state.currentDatabaseSha256 = "f".repeat(64);

  await assert.rejects(
    backupService.activatePreparedCareerRestore(receipt),
    (error) => error?.code === "CURRENT_GENERATION_CHANGED",
  );
  assert.equal(fixture.state.activated.length, 1);
  assert.equal(fixture.state.current.generationId, OLD_GENERATION_ID);
  assert.equal(fixture.state.current.sequence, 1);
  assert.deepEqual(fixture.state.broadcasts, []);
});

test("an already-current receipt is worker-validated without another pointer switch", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );
  fixture.state.current = fixture.nextGeneration;

  const result = await backupService.activatePreparedCareerRestore(receipt);

  assert.equal(result.outcome, "already-current");
  assert.equal(fixture.state.activated.length, 0);
  assert.equal(fixture.state.inspected.length, 1);
  assert.deepEqual(fixture.state.broadcasts, [GENERATION_ID]);
});

test("an already-current forged receipt cannot turn current identity into false restore success", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );
  fixture.state.current = fixture.nextGeneration;
  const forged = {
    ...JSON.parse(JSON.stringify(receipt)),
    recoveryToken: "c".repeat(64),
    summary: { ...receipt.summary, fileName: "forged.career-backup" },
  };
  forged.projectionSha256 = await projectionDigestForReceipt(forged);

  await assert.rejects(
    backupService.activatePreparedCareerRestore(forged),
    (error) => error?.code === "INVALID_RECEIPT",
  );
  assert.equal(fixture.state.activated.length, 0);
  assert.equal(fixture.state.inspected.length, 1);
  assert.deepEqual(fixture.state.broadcasts, []);
});

test("discard deletes attachment objects only after an explicit positive database result", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );

  const result = await backupService.discardPreparedCareerRestore(receipt);

  assert.deepEqual(result, {
    discarded: true,
    attachmentCleanup: "complete",
    failedAttachmentKeys: [],
  });
  assert.equal(fixture.state.discarded.length, 1);
  assert.deepEqual(fixture.state.deleted, [{ database: "career", key: STAGED_KEY }]);
  assert.equal(fixture.state.activated.length, 0);
});

test("unknown or refused discard results retain every attachment", async () => {
  for (const mode of ["unknown", "rejected"]) {
    const fixture = await runtimeFixture();
    const receipt = await backupService.prepareCareerBackupRestore(
      await completeContainer(),
    );
    fixture.runtime.discardStaged = async (database, generationId, activationToken, recoveryReceipt) => {
      fixture.state.discarded.push({ database, generationId, activationToken, recoveryReceipt });
      if (mode === "rejected") throw new Error("discard result lost");
      return undefined;
    };

    await assert.rejects(
      backupService.discardPreparedCareerRestore(receipt),
      (error) => error?.code === "DISCARD_UNCERTAIN",
    );
    assert.deepEqual(fixture.state.deleted, [], `${mode} discard must retain attachments`);
  }
});

test("AbortSignal stops only before atomic staging and never changes current", async () => {
  const earlyFixture = await runtimeFixture();
  const earlyController = new AbortController();
  earlyController.abort();
  await assert.rejects(
    backupService.prepareCareerBackupRestore(
      await completeContainer(),
      { signal: earlyController.signal },
    ),
    (error) => error?.name === "AbortError" && error?.code === "PREPARE_ABORTED",
  );
  assert.equal(earlyFixture.state.staged.length, 0);
  assert.equal(earlyFixture.state.activated.length, 0);
  assert.equal(earlyFixture.state.current.generationId, OLD_GENERATION_ID);

  const lateFixture = await runtimeFixture();
  const lateController = new AbortController();
  const originalLateStage = lateFixture.runtime.stageImport;
  lateFixture.runtime.stageImport = async (...args) => {
    const result = await originalLateStage(...args);
    lateController.abort();
    return result;
  };
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
    { signal: lateController.signal },
  );
  assert.equal(receipt.generationId, GENERATION_ID);
  assert.equal(lateFixture.state.activated.length, 0);
  assert.equal(lateFixture.state.current.generationId, OLD_GENERATION_ID);
});

test("an unknown or malformed stage response retains attachments and never claims ordinary failure", async () => {
  for (const mode of ["response-lost", "malformed-receipt"]) {
    const fixture = await runtimeFixture();
    const originalStage = fixture.runtime.stageImport;
    fixture.runtime.stageImport = async (...args) => {
      const result = await originalStage(...args);
      if (mode === "response-lost") throw new Error("READY response lost");
      return {
        ...result,
        recoveryReceipt: { ...result.recoveryReceipt, recoveryToken: null },
      };
    };

    await assert.rejects(
      backupService.prepareCareerBackupRestore(await completeContainer()),
      (error) => error?.code === "PREPARE_UNCERTAIN",
    );
    assert.equal(fixture.state.activated.length, 0);
    assert.equal(fixture.state.current.generationId, OLD_GENERATION_ID);
    assert.deepEqual(fixture.state.deleted, [], `${mode} must retain staged attachments`);
  }
});

test("a lost READY response recovers the same candidate across refresh without restaging", async () => {
  const fixture = await runtimeFixture();
  const originalStage = fixture.runtime.stageImport;
  let checkpoint;
  fixture.runtime.stageImport = async (...args) => {
    await originalStage(...args);
    throw new Error("READY response lost after durable commit");
  };

  let uncertain;
  try {
    await backupService.prepareCareerBackupRestore(await completeContainer(), {
      onRecoveryPrepared(value) {
        checkpoint = JSON.parse(JSON.stringify(value));
      },
    });
  } catch (error) {
    uncertain = error;
  }
  assert.equal(uncertain?.name, "CareerPrepareUncertainError");
  assert.equal(uncertain?.code, "PREPARE_UNCERTAIN");
  const serialized = JSON.parse(JSON.stringify(uncertain.receipt));
  assert.equal(serialized.operationId, GENERATION_ID);
  assert.equal(serialized.generationId, GENERATION_ID);
  assert.equal(serialized.stagedAttachmentKeys[0], STAGED_KEY);
  assert.deepEqual(serialized, checkpoint);

  const recovered = await backupService.recoverCareerBackupPrepare(serialized);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.receipt.generationId, GENERATION_ID);
  assert.equal(fixture.state.staged.length, 1, "recovery must not stage twice");
  assert.equal(fixture.state.activated.length, 0, "recovery must not activate");
  assert.deepEqual(fixture.state.deleted, []);

  const activated = await backupService.activatePreparedCareerRestore(
    recovered.receipt,
  );
  assert.equal(activated.outcome, "activated");
  assert.equal(fixture.state.staged.length, 1);
});

test("a failed atomic stage recovers only its worker-bound cleanup scope", async () => {
  const fixture = await runtimeFixture();
  fixture.runtime.stageImport = async (database, bytes, statements, requirements, options) => {
    fixture.state.staged.push({ database, bytes, statements, requirements, options });
    fixture.state.prepareReceipt = structuredClone(options.recovery.prepareOperation);
    fixture.state.prepareStatus = "cleanup-pending";
    throw new Error("candidate validation failed after operation tombstone");
  };

  let uncertain;
  try {
    await backupService.prepareCareerBackupRestore(await completeContainer());
  } catch (error) {
    uncertain = error;
  }
  const recovered = await backupService.recoverCareerBackupPrepare(
    JSON.parse(JSON.stringify(uncertain.receipt)),
  );
  assert.equal(recovered.status, "cleanup-pending");
  assert.deepEqual(recovered.cleanupReceipt.stagedAttachmentKeys, [STAGED_KEY]);
  assert.equal(fixture.state.staged.length, 1);
  assert.equal(fixture.state.activated.length, 0);

  assert.deepEqual(
    await backupService.retryCareerPrepareCleanup(
      JSON.parse(JSON.stringify(recovered.cleanupReceipt)),
    ),
    { cleaned: true },
  );
  assert.deepEqual(fixture.state.deleted, [{ database: "career", key: STAGED_KEY }]);
  assert.equal(fixture.state.prepareStatus, "cleanup-complete");
});

test("tampered prepare capability fails closed before recovery or attachment deletion", async () => {
  const fixture = await runtimeFixture();
  const originalStage = fixture.runtime.stageImport;
  fixture.runtime.stageImport = async (...args) => {
    await originalStage(...args);
    throw new Error("READY response lost");
  };
  let uncertain;
  try {
    await backupService.prepareCareerBackupRestore(await completeContainer());
  } catch (error) {
    uncertain = error;
  }
  const forged = {
    ...JSON.parse(JSON.stringify(uncertain.receipt)),
    operationToken: "f".repeat(64),
  };
  await assert.rejects(
    backupService.recoverCareerBackupPrepare(forged),
    (error) => error?.code === "PREPARE_UNCERTAIN",
  );
  assert.equal(fixture.state.staged.length, 1);
  assert.equal(fixture.state.activated.length, 0);
  assert.deepEqual(fixture.state.deleted, []);
});

test("failed pre-stage attachment rollback is explicit and exposes a capability-bound retry", async () => {
  const fixture = await runtimeFixture();
  const controller = new AbortController();
  const originalSave = fixture.runtime.saveLocalFile;
  fixture.runtime.saveLocalFile = async (...args) => {
    const metadata = await originalSave(...args);
    controller.abort();
    return metadata;
  };
  let deleteAttempts = 0;
  fixture.runtime.deleteLocalFile = async (database, key) => {
    fixture.state.deleted.push({ database, key });
    deleteAttempts += 1;
    if (deleteAttempts === 1) throw new Error("temporary cleanup failure");
  };

  let cleanupError;
  try {
    await backupService.prepareCareerBackupRestore(
      await completeContainer(),
      { signal: controller.signal },
    );
  } catch (error) {
    cleanupError = error;
  }
  assert.equal(cleanupError?.code, "PREPARE_CLEANUP_INCOMPLETE");
  assert.equal(cleanupError?.failedAttachmentCount, 1);
  assert.equal(typeof cleanupError?.retryCleanup, "function");
  assert.deepEqual(
    JSON.parse(JSON.stringify(cleanupError.receipt)),
    cleanupError.receipt,
  );
  assert.equal(fixture.state.staged.length, 0);
  assert.equal(fixture.state.current.generationId, OLD_GENERATION_ID);

  assert.deepEqual(
    await backupService.retryCareerPrepareCleanup(
      JSON.parse(JSON.stringify(cleanupError.receipt)),
    ),
    { cleaned: true },
  );
  assert.equal(deleteAttempts, 2);
});

test("lost cleanup completion is recovered idempotently without widening keys", async () => {
  const fixture = await runtimeFixture();
  const controller = new AbortController();
  const originalSave = fixture.runtime.saveLocalFile;
  fixture.runtime.saveLocalFile = async (...args) => {
    const metadata = await originalSave(...args);
    controller.abort();
    return metadata;
  };
  let deleteAttempts = 0;
  fixture.runtime.deleteLocalFile = async (database, key) => {
    fixture.state.deleted.push({ database, key });
    deleteAttempts += 1;
    if (deleteAttempts === 1) throw new Error("first cleanup failed");
  };
  let cleanupError;
  try {
    await backupService.prepareCareerBackupRestore(
      await completeContainer(),
      { signal: controller.signal },
    );
  } catch (error) {
    cleanupError = error;
  }
  const receipt = JSON.parse(JSON.stringify(cleanupError.receipt));
  const originalComplete = fixture.runtime.completePrepareCleanup;
  let loseCompletion = true;
  fixture.runtime.completePrepareCleanup = async (...args) => {
    const completed = await originalComplete(...args);
    if (loseCompletion) {
      loseCompletion = false;
      throw new Error("cleanup completion response lost");
    }
    return completed;
  };

  await assert.rejects(
    backupService.retryCareerPrepareCleanup(receipt),
    (error) => error?.code === "PREPARE_CLEANUP_INCOMPLETE",
  );
  assert.equal(fixture.state.prepareStatus, "cleanup-complete");
  const attemptsAfterLostResponse = deleteAttempts;
  assert.deepEqual(await backupService.retryCareerPrepareCleanup(receipt), {
    cleaned: true,
  });
  assert.equal(deleteAttempts, attemptsAfterLostResponse);
  assert.deepEqual(
    new Set(fixture.state.deleted.map(({ key }) => key)),
    new Set([STAGED_KEY]),
  );
});

test("a re-signed cleanup key list is rejected by the worker-owned binding", async () => {
  const fixture = await runtimeFixture();
  const controller = new AbortController();
  const originalSave = fixture.runtime.saveLocalFile;
  fixture.runtime.saveLocalFile = async (...args) => {
    const metadata = await originalSave(...args);
    controller.abort();
    return metadata;
  };
  fixture.runtime.deleteLocalFile = async (database, key) => {
    fixture.state.deleted.push({ database, key });
    throw new Error("cleanup unavailable");
  };
  let cleanupError;
  try {
    await backupService.prepareCareerBackupRestore(
      await completeContainer(),
      { signal: controller.signal },
    );
  } catch (error) {
    cleanupError = error;
  }
  const forged = {
    ...JSON.parse(JSON.stringify(cleanupError.receipt)),
    stagedAttachmentKeys: [OTHER_GENERATION_ID],
    attachmentKeysSha256: await attachmentKeysDigest([OTHER_GENERATION_ID]),
  };
  await assert.rejects(
    backupService.retryCareerPrepareCleanup(forged),
    (error) => error?.code === "PREPARE_CLEANUP_INCOMPLETE",
  );
  assert.deepEqual(fixture.state.deleted, [{ database: "career", key: STAGED_KEY }]);
  assert.ok(!rawServiceJavaScript.includes("WeakMap"));
});

test("legacy Career SQLite v0 through v3 prepare without activation", async () => {
  for (const userVersion of [0, 1, 2, 3]) {
    const fixture = await runtimeFixture();
    const receipt = await backupService.prepareCareerBackupRestore(
      new File([sqliteBytes(userVersion)], `career-v${userVersion}.sqlite3`),
    );

    assert.equal(receipt.summary.kind, "legacy-career-sqlite");
    assert.equal(receipt.summary.fileName, `career-v${userVersion}.sqlite3`);
    assert.equal(receipt.summary.sourceUserVersion, userVersion);
    assert.equal(receipt.summary.canonicalUserVersion, 3);
    assert.equal(receipt.summary.attachmentCount, 0);
    assert.deepEqual(receipt.stagedAttachmentKeys, []);
    assert.equal(fixture.state.staged.length, 1);
    assert.equal(fixture.state.activated.length, 0);
    assert.equal(fixture.state.current.generationId, OLD_GENERATION_ID);
  }
});

test("complete Career backups v0 through v3 prepare without activation", async () => {
  for (const userVersion of [0, 1, 2, 3]) {
    const fixture = await runtimeFixture();
    const receipt = await backupService.prepareCareerBackupRestore(
      await completeContainer(userVersion),
    );

    assert.equal(receipt.summary.kind, "complete-backup");
    assert.equal(receipt.summary.sourceUserVersion, userVersion);
    assert.equal(receipt.summary.canonicalUserVersion, 3);
    assert.equal(receipt.summary.attachmentCount, 1);
    assert.equal(fixture.state.staged.length, 1);
    assert.equal(fixture.state.activated.length, 0);
  }
});

test("a random file is never promoted to a legacy SQLite candidate", async () => {
  const fixture = await runtimeFixture();
  await assert.rejects(
    backupService.prepareCareerBackupRestore(
      new File(["not a database"], "random.sqlite"),
    ),
    (error) => error?.code === "UNRECOGNIZED_SQLITE",
  );
  assert.equal(fixture.state.currentChecks, 0);
  assert.equal(fixture.state.staged.length, 0);
  assert.equal(fixture.state.activated.length, 0);
});

test("receipt validation rejects added executable fields before any runtime call", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );
  const currentChecks = fixture.state.currentChecks;
  const forged = { ...JSON.parse(JSON.stringify(receipt)), sql: "DROP TABLE career_jobs" };

  await assert.rejects(
    backupService.activatePreparedCareerRestore(forged),
    (error) => error?.code === "INVALID_RECEIPT",
  );
  assert.equal(fixture.state.currentChecks, currentChecks);
  assert.equal(fixture.state.activated.length, 0);
});

test("changing the expected baseline cannot authorize an older prepared candidate", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );
  fixture.state.current = {
    database: "zhiji",
    generationId: OTHER_GENERATION_ID,
    filename: `zhiji.${OTHER_GENERATION_ID}.sqlite3`,
    sequence: 9,
    legacy: false,
  };
  const forged = {
    ...JSON.parse(JSON.stringify(receipt)),
    expectedCurrentGenerationId: OTHER_GENERATION_ID,
    expectedCurrentSequence: 9,
  };

  await assert.rejects(
    backupService.activatePreparedCareerRestore(forged),
    (error) => error?.code === "INVALID_RECEIPT",
  );
  assert.equal(fixture.state.activated.length, 1, "the worker must validate the durable binding");
  assert.equal(fixture.state.current.generationId, OTHER_GENERATION_ID);
  assert.deepEqual(fixture.state.deleted, []);
});

test("changing cleanup keys and recomputing the public projection still cannot delete files", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );
  const forged = {
    ...JSON.parse(JSON.stringify(receipt)),
    stagedAttachmentKeys: [OTHER_GENERATION_ID],
  };
  forged.projectionSha256 = await projectionDigestForReceipt(forged);

  await assert.rejects(
    backupService.discardPreparedCareerRestore(forged),
    (error) => error?.code === "DISCARD_UNCERTAIN",
  );
  assert.equal(fixture.state.discarded.length, 1);
  assert.deepEqual(fixture.state.deleted, []);
});

test("wrong recovery token or generation cannot discard a bound candidate", async () => {
  for (const change of [
    (receipt) => ({ ...receipt, recoveryToken: "c".repeat(64) }),
    (receipt) => ({ ...receipt, generationId: OTHER_GENERATION_ID }),
  ]) {
    const fixture = await runtimeFixture();
    const receipt = await backupService.prepareCareerBackupRestore(
      await completeContainer(),
    );
    await assert.rejects(
      backupService.discardPreparedCareerRestore(change(JSON.parse(JSON.stringify(receipt)))),
      (error) => error?.code === "DISCARD_UNCERTAIN",
    );
    assert.deepEqual(fixture.state.deleted, []);
  }
});

test("a malformed fulfilled activation response is postflight-checked, never called success", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );
  fixture.runtime.activateStaged = async (database, generationId, activationToken, recoveryReceipt) => {
    fixture.state.activated.push({ database, generationId, activationToken, recoveryReceipt });
    return undefined;
  };

  await assert.rejects(
    backupService.activatePreparedCareerRestore(receipt),
    (error) => error?.code === "ACTIVATION_FAILED",
  );
  assert.equal(fixture.state.activated.length, 1);
  assert.equal(fixture.state.currentChecks, 2, "one preflight plus exactly one postflight");
  assert.equal(fixture.state.current.generationId, OLD_GENERATION_ID);
});

test("malformed current generation data fails closed before activation", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );
  fixture.runtime.currentGeneration = async () => {
    fixture.state.currentChecks += 1;
    return { database: "zhiji", generationId: OLD_GENERATION_ID };
  };

  await assert.rejects(
    backupService.activatePreparedCareerRestore(receipt),
    (error) => error?.code === "CURRENT_GENERATION_UNAVAILABLE",
  );
  assert.equal(fixture.state.activated.length, 0);
});

test("an incomplete attachment cleanup can retry the idempotent bound discard", async () => {
  const fixture = await runtimeFixture();
  const receipt = await backupService.prepareCareerBackupRestore(
    await completeContainer(),
  );
  let attempts = 0;
  fixture.runtime.deleteLocalFile = async (database, key) => {
    fixture.state.deleted.push({ database, key });
    attempts += 1;
    if (attempts === 1) throw new Error("temporary OPFS delete failure");
  };

  const first = await backupService.discardPreparedCareerRestore(receipt);
  assert.equal(first.attachmentCleanup, "incomplete");
  assert.deepEqual(first.failedAttachmentKeys, [STAGED_KEY]);
  const second = await backupService.discardPreparedCareerRestore(
    JSON.parse(JSON.stringify(receipt)),
  );
  assert.equal(second.attachmentCleanup, "complete");
  assert.equal(fixture.state.discarded.length, 2);
  assert.equal(attempts, 2);
});

test("legacy one-call API remains compatible and uses one exclusive lock", async () => {
  const fixture = await runtimeFixture();
  fixture.runtime.broadcastCareerGenerationChanged = (generationId) => {
    fixture.state.broadcasts.push(generationId);
    throw new Error("BroadcastChannel closed");
  };

  const result = await backupService.restoreCompleteCareerBackup(
    await completeContainer(),
  );

  assert.equal(result.attachmentCount, 1);
  assert.equal(result.exportedAt, "2026-08-20T08:09:10.000Z");
  assert.equal(fixture.state.lockCalls, 1);
  assert.equal(fixture.state.activated.length, 1);
  assert.equal(fixture.state.current.generationId, GENERATION_ID);
  assert.deepEqual(fixture.state.broadcasts, [GENERATION_ID]);
});

test("legacy one-call API retains everything when activation is uncertain", async () => {
  const fixture = await runtimeFixture();
  let currentChecks = 0;
  fixture.runtime.currentGeneration = async () => {
    fixture.state.currentChecks += 1;
    currentChecks += 1;
    if (currentChecks <= 1) return fixture.oldGeneration;
    throw new Error("generation pointer temporarily unreadable");
  };
  fixture.runtime.activateStaged = async (database, generationId, activationToken, recoveryReceipt) => {
    fixture.state.activated.push({ database, generationId, activationToken, recoveryReceipt });
    fixture.state.current = fixture.nextGeneration;
    throw new Error("activation response lost");
  };

  let uncertain;
  try {
    await backupService.restoreCompleteCareerBackup(await completeContainer());
  } catch (error) {
    uncertain = error;
  }
  assert.equal(uncertain?.code, "ACTIVATION_UNCERTAIN");
  assert.equal(uncertain?.receipt?.generationId, GENERATION_ID);
  assert.deepEqual(
    JSON.parse(JSON.stringify(uncertain.receipt)),
    uncertain.receipt,
  );
  assert.equal(fixture.state.activated.length, 1);
  assert.equal(fixture.state.discarded.length, 0);
  assert.equal(fixture.state.deleted.length, 0);

  fixture.runtime.currentGeneration = async () => {
    fixture.state.currentChecks += 1;
    return fixture.state.current;
  };
  const inspection = await backupService.inspectCareerRestoreActivation(
    JSON.parse(JSON.stringify(uncertain.receipt)),
  );
  assert.equal(inspection.status, "current");
});

test("legacy one-call API cleans a definitely inactive candidate", async () => {
  const fixture = await runtimeFixture();
  fixture.runtime.activateStaged = async (database, generationId, activationToken, recoveryReceipt) => {
    fixture.state.activated.push({ database, generationId, activationToken, recoveryReceipt });
    throw new Error("pointer write failed");
  };

  await assert.rejects(
    backupService.restoreCompleteCareerBackup(await completeContainer()),
    (error) => error?.code === "ACTIVATION_FAILED",
  );
  assert.equal(fixture.state.activated.length, 1);
  assert.equal(fixture.state.current.generationId, OLD_GENERATION_ID);
  assert.equal(fixture.state.discarded.length, 1);
  assert.deepEqual(fixture.state.deleted, [{ database: "career", key: STAGED_KEY }]);
});

test("legacy one-call API returns its receipt when candidate cleanup is uncertain", async () => {
  const fixture = await runtimeFixture();
  fixture.runtime.activateStaged = async (database, generationId, activationToken, recoveryReceipt) => {
    fixture.state.activated.push({ database, generationId, activationToken, recoveryReceipt });
    throw new Error("pointer write failed");
  };
  fixture.runtime.discardStaged = async (database, generationId, activationToken, recoveryReceipt) => {
    fixture.state.discarded.push({ database, generationId, activationToken, recoveryReceipt });
    throw new Error("discard state unavailable");
  };

  let recoveryError;
  try {
    await backupService.restoreCompleteCareerBackup(await completeContainer());
  } catch (error) {
    recoveryError = error;
  }
  assert.equal(recoveryError?.name, "CareerDiscardUncertainError");
  assert.equal(recoveryError?.code, "DISCARD_UNCERTAIN");
  assert.equal(recoveryError?.receipt?.generationId, GENERATION_ID);
  assert.equal(fixture.state.discarded.length, 1);
  assert.deepEqual(fixture.state.deleted, []);
});
