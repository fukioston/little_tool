import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const recoveryUrl = new URL("app/fitness/backup-recovery.ts", projectRoot);
const flowUrl = new URL("app/fitness/FitnessBackupFlow.tsx", projectRoot);
const appUrl = new URL("app/fitness/FitnessApp.tsx", projectRoot);
const viewsUrl = new URL("app/fitness/data-panels.tsx", projectRoot);
const cssUrl = new URL("app/fitness/fitness.css", projectRoot);

const [recoverySource, flowSource, appSource, viewsSource, css] = await Promise.all([
  readFile(recoveryUrl, "utf8"),
  readFile(flowUrl, "utf8"),
  readFile(appUrl, "utf8"),
  readFile(viewsUrl, "utf8"),
  readFile(cssUrl, "utf8"),
]);

const { outputText, diagnostics = [] } = ts.transpileModule(recoverySource, {
  fileName: recoveryUrl.pathname,
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
const recovery = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

const GENERATION_A = "30000000-0000-4000-8000-000000000001";
const GENERATION_B = "30000000-0000-4000-8000-000000000002";
const FILE_A = "20000000-0000-4000-8000-000000000001";

function completeSummary(fileName = "shilian-complete.fitness-backup") {
  return {
    kind: "complete-backup",
    fileName,
    byteSize: 2048,
    databaseByteSize: 1024,
    exportedAt: "2026-08-21T02:03:04.000Z",
    sourceUserVersion: 2,
    canonicalUserVersion: 2,
    fileCount: 1,
    venueCount: null,
    equipmentCount: null,
    exerciseCount: null,
    sessionCount: null,
    verification: "container-and-payload-verified",
  };
}

function prepareReceipt(generationId = GENERATION_A) {
  return {
    version: 1,
    database: "shilian",
    operationId: generationId,
    generationId,
    operationToken: "a".repeat(64),
    databaseSha256: "f".repeat(64),
    filesSha256: "9".repeat(64),
    projectionSha256: "b".repeat(64),
    fileKeysSha256: "c".repeat(64),
    preparedAt: "2026-08-21T02:03:05.000Z",
    summary: completeSummary(),
    stagedFileKeys: [FILE_A],
  };
}

function candidateReceipt(generationId = GENERATION_A) {
  return {
    version: 1,
    database: "shilian",
    generationId,
    activationToken: "d".repeat(64),
    recoveryToken: "e".repeat(64),
    expectedCurrentGenerationId: "legacy",
    expectedCurrentSequence: 0,
    canonicalApplicationId: 0x53484c4e,
    canonicalUserVersion: 2,
    databaseSha256: "f".repeat(64),
    filesSha256: "9".repeat(64),
    projectionSha256: "b".repeat(64),
    preparedAt: "2026-08-21T02:03:05.000Z",
    summary: completeSummary(),
    stagedFileKeys: [FILE_A],
  };
}

function ticket(kind, generationId = GENERATION_A, mode = "review", recordedAt = "2026-08-21T02:03:06.000Z") {
  if (kind === "prepare") {
    return { version: 1, kind, receipt: prepareReceipt(generationId), recordedAt };
  }
  if (kind === "prepare-cleanup") {
    const prepared = prepareReceipt(generationId);
    const receipt = {
      version: prepared.version,
      database: prepared.database,
      operationId: prepared.operationId,
      generationId: prepared.generationId,
      operationToken: prepared.operationToken,
      projectionSha256: prepared.projectionSha256,
      fileKeysSha256: prepared.fileKeysSha256,
      stagedFileKeys: prepared.stagedFileKeys,
    };
    return { version: 1, kind, receipt, recordedAt };
  }
  if (kind === "refresh-only") {
    return { version: 1, kind, receipt: candidateReceipt(generationId), recordedAt };
  }
  return {
    version: 1,
    kind: "candidate",
    mode,
    receipt: candidateReceipt(generationId),
    recordedAt,
  };
}

function memoryStorage(initial = []) {
  const values = new Map(initial);
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
    values,
  };
}

function journalRuntime(storage) {
  let tail = Promise.resolve();
  return {
    storage,
    withExclusiveLock(task) {
      const run = tail.then(task, task);
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test("stored recovery tickets are exact, bounded, and operation-bound", () => {
  const valid = ticket("candidate");
  assert.equal(recovery.isFitnessBackupRecoveryTicket(valid), true);
  assert.equal(
    recovery.fitnessBackupRecoveryStorageKey(valid),
    `${recovery.FITNESS_BACKUP_RECOVERY_PREFIX}operation:${GENERATION_A}`,
  );
  assert.equal(
    recovery.isFitnessBackupRecoveryTicket({ ...valid, unexpected: true }),
    false,
  );
  assert.equal(
    recovery.isFitnessBackupRecoveryTicket({
      ...valid,
      receipt: { ...valid.receipt, activationToken: "short" },
    }),
    false,
  );
  assert.equal(
    recovery.isFitnessBackupRecoveryTicket({
      ...valid,
      receipt: {
        ...valid.receipt,
        summary: { ...valid.receipt.summary, venueCount: 8 },
      },
    }),
    false,
  );
  assert.equal(recovery.isFitnessBackupRecoveryTicket(ticket("prepare")), true);
  assert.equal(recovery.isFitnessBackupRecoveryTicket(ticket("prepare-cleanup")), true);
  assert.equal(recovery.isFitnessBackupRecoveryTicket(ticket("refresh-only")), true);
  assert.match(recoverySource, /FITNESS_BACKUP_RECOVERY_MAX_BYTES = 256 \* 1024/);
  assert.match(recoverySource, /raw\.length > FITNESS_BACKUP_RECOVERY_MAX_BYTES/);
});

test("one damaged entry cannot hide peer operations and conservative phases sort first", () => {
  const refresh = ticket("refresh-only", GENERATION_B, "review", "2026-08-21T02:03:09.000Z");
  const prepare = ticket("prepare", GENERATION_A, "review", "2026-08-21T02:03:06.000Z");
  const refreshKey = recovery.fitnessBackupRecoveryStorageKey(refresh);
  const prepareKey = recovery.fitnessBackupRecoveryStorageKey(prepare);
  const damagedKey = `${recovery.FITNESS_BACKUP_RECOVERY_PREFIX}operation:damaged`;
  const storage = memoryStorage([
    [prepareKey, JSON.stringify(prepare)],
    [damagedKey, "{not json"],
    [refreshKey, JSON.stringify(refresh)],
  ]);
  const result = recovery.readFitnessBackupRecoveryStorage(storage);
  assert.equal(result.storageUnavailable, false);
  assert.deepEqual(result.entries.map(({ ticket: entry }) => entry.kind), [
    "refresh-only",
    "prepare",
  ]);
  assert.deepEqual(result.unreadableEntries, [
    { storageKey: damagedKey, raw: "{not json" },
  ]);
});

test("journal replacement and removal use raw CAS under an independent lock", async () => {
  const storage = memoryStorage();
  const runtime = journalRuntime(storage);
  const prepared = ticket("prepare");
  const first = await recovery.replaceFitnessBackupRecoveryTicket(
    prepared,
    null,
    runtime,
  );
  assert.equal(first.outcome, "written");

  const review = ticket("candidate");
  const activationCheck = ticket("candidate", GENERATION_A, "activation-check");
  const [left, right] = await Promise.all([
    recovery.replaceFitnessBackupRecoveryTicket(review, first.entry, runtime),
    recovery.replaceFitnessBackupRecoveryTicket(
      activationCheck,
      first.entry,
      runtime,
    ),
  ]);
  assert.deepEqual(
    [left.outcome, right.outcome].sort(),
    ["stale", "written"],
  );
  assert.equal(
    (await recovery.removeFitnessBackupRecoveryEntry(first.entry, runtime)).outcome,
    "stale",
  );
  const current = recovery.readFitnessBackupRecoveryStorage(storage).entries[0];
  assert.equal(
    (await recovery.checkFitnessBackupRecoveryEntry(current, runtime)).outcome,
    "current",
  );
  assert.equal(
    (await recovery.removeFitnessBackupRecoveryEntry(current, runtime)).outcome,
    "removed",
  );
  assert.equal(storage.length, 0);
  assert.match(recoverySource, /private-ai-suite:fitness:backup-recovery-journal/);
  assert.doesNotMatch(recoverySource, /private-ai-suite:fitness:database/);
});

test("one journal lock spans raw CAS, backend wait, and the final transition", async () => {
  const storage = memoryStorage();
  const runtime = journalRuntime(storage);
  const first = await recovery.replaceFitnessBackupRecoveryTicket(
    ticket("candidate"),
    null,
    runtime,
  );
  assert.equal(first.outcome, "written");
  const entered = deferred();
  const release = deferred();
  let secondBackendCalls = 0;
  const firstRun = recovery.runWithCurrentFitnessBackupEntry(
    first.entry,
    async (lease) => {
      entered.resolve();
      await release.promise;
      lease.replace(ticket("candidate", GENERATION_A, "activation-check"));
      return "first";
    },
    runtime,
  );
  await entered.promise;
  const secondRun = recovery.runWithCurrentFitnessBackupEntry(
    first.entry,
    async () => {
      secondBackendCalls += 1;
      return "second";
    },
    runtime,
  );
  await Promise.resolve();
  assert.equal(secondBackendCalls, 0);
  release.resolve();
  assert.equal((await firstRun).outcome, "ran");
  assert.equal((await secondRun).outcome, "stale");
  assert.equal(secondBackendCalls, 0);
});

test("a malformed peer or failed storage scan blocks every recovery backend under the journal lease", async () => {
  const validTicket = ticket("candidate");
  const storageKey = recovery.fitnessBackupRecoveryStorageKey(validTicket);
  const raw = JSON.stringify(validTicket);
  const damagedKey = `${recovery.FITNESS_BACKUP_RECOVERY_PREFIX}operation:damaged-peer`;
  const storage = memoryStorage([
    [storageKey, raw],
    [damagedKey, "{not json"],
  ]);
  const entry = { storageKey, raw, ticket: validTicket };
  const backendCalls = {
    activate: 0,
    recover: 0,
    inspect: 0,
    discard: 0,
    cleanup: 0,
    refresh: 0,
  };
  for (const backend of Object.keys(backendCalls)) {
    const result = await recovery.runWithCurrentFitnessBackupEntry(
      entry,
      async () => {
        backendCalls[backend] += 1;
      },
      journalRuntime(storage),
    );
    assert.equal(result.outcome, "blocked", `${backend} must fail closed`);
  }
  assert.deepEqual(backendCalls, {
    activate: 0,
    recover: 0,
    inspect: 0,
    discard: 0,
    cleanup: 0,
    refresh: 0,
  });

  storage.removeItem(damagedKey);
  let resumedBackendCalls = 0;
  const resumed = await recovery.runWithCurrentFitnessBackupEntry(
    entry,
    async () => { resumedBackendCalls += 1; },
    journalRuntime(storage),
  );
  assert.equal(resumed.outcome, "ran");
  assert.equal(resumedBackendCalls, 1);

  let unavailableBackendCalls = 0;
  const unreadableStorage = {
    get length() { throw new Error("enumeration unavailable"); },
    key() { return null; },
    getItem(key) { return key === storageKey ? raw : null; },
    setItem() {},
    removeItem() {},
  };
  const unavailable = await recovery.runWithCurrentFitnessBackupEntry(
    entry,
    async () => { unavailableBackendCalls += 1; },
    journalRuntime(unreadableStorage),
  );
  assert.equal(unavailable.outcome, "unavailable");
  assert.equal(unavailableBackendCalls, 0);
});

test("a prepare checkpoint remains under the same lock until prepare settles", async () => {
  const storage = memoryStorage();
  const runtime = journalRuntime(storage);
  const checkpointVisible = deferred();
  const finishPrepare = deferred();
  let preparedEntry;
  let recoverCalls = 0;
  const prepareRun = recovery.runNewFitnessBackupRecovery(
    async (lease) => {
      preparedEntry = lease.replace(ticket("prepare"));
      checkpointVisible.resolve();
      await finishPrepare.promise;
      lease.replace(ticket("candidate"));
      return "prepared";
    },
    runtime,
  );
  await checkpointVisible.promise;
  assert.ok(preparedEntry);
  const recoverRun = recovery.runWithCurrentFitnessBackupEntry(
    preparedEntry,
    async () => {
      recoverCalls += 1;
      return "recovered";
    },
    runtime,
  );
  await Promise.resolve();
  assert.equal(recoverCalls, 0);
  finishPrepare.resolve();
  assert.equal((await prepareRun).outcome, "ran");
  assert.equal((await recoverRun).outcome, "stale");
  assert.equal(recoverCalls, 0);

  let secondPrepareCalls = 0;
  const secondPrepare = await recovery.runNewFitnessBackupRecovery(
    async () => {
      secondPrepareCalls += 1;
    },
    runtime,
  );
  assert.equal(secondPrepare.outcome, "blocked");
  assert.equal(secondPrepareCalls, 0);
});

test("lost storage acknowledgement reconciles durable, adopted, and removed peers without backend work", async () => {
  const backing = memoryStorage();
  let failReadback = false;
  let injectLostAcknowledgement = true;
  const storage = {
    get length() { return backing.length; },
    key(index) { return backing.key(index); },
    getItem(key) {
      if (failReadback) {
        failReadback = false;
        throw new Error("lost read-back");
      }
      return backing.getItem(key);
    },
    setItem(key, value) {
      backing.setItem(key, value);
      if (injectLostAcknowledgement) {
        injectLostAcknowledgement = false;
        failReadback = true;
      }
    },
    removeItem(key) { backing.removeItem(key); },
  };
  const runtime = journalRuntime(storage);
  const pendingTicket = ticket("candidate");
  const lost = await recovery.replaceFitnessBackupRecoveryTicket(
    pendingTicket,
    null,
    runtime,
  );
  assert.equal(lost.outcome, "unavailable");
  const pending = { ticket: pendingTicket, expected: null };
  const persisted = await recovery.reconcileFitnessBackupVolatileTransition(
    pending,
    runtime,
  );
  assert.equal(persisted.outcome, "persisted");

  const peerTicket = ticket("candidate", GENERATION_A, "activation-check", "2026-08-21T02:03:07.000Z");
  backing.setItem(
    recovery.fitnessBackupRecoveryStorageKey(peerTicket),
    JSON.stringify(peerTicket),
  );
  const adopted = await recovery.reconcileFitnessBackupVolatileTransition(
    pending,
    runtime,
  );
  assert.equal(adopted.outcome, "adopted");
  assert.equal(adopted.entry.ticket.mode, "activation-check");

  const peerEntered = deferred();
  const finishPeer = deferred();
  const peerRun = recovery.runWithCurrentFitnessBackupEntry(
    adopted.entry,
    async (lease) => {
      peerEntered.resolve();
      await finishPeer.promise;
      lease.remove();
    },
    runtime,
  );
  await peerEntered.promise;
  let reconcileSettled = false;
  const reconcileAfterPeer = recovery.reconcileFitnessBackupVolatileTransition(
    pending,
    runtime,
  ).then((value) => {
    reconcileSettled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(reconcileSettled, false);
  finishPeer.resolve();
  assert.equal((await peerRun).outcome, "ran");
  const rewritten = await reconcileAfterPeer;
  assert.equal(rewritten.outcome, "written");
  assert.equal(rewritten.entry.ticket.mode, "review");
});

test("a newer timestamp cannot downgrade a conservative volatile phase", async () => {
  let backendCalls = 0;
  const pendingTicket = ticket(
    "candidate",
    GENERATION_A,
    "activation-check",
    "2026-08-21T02:03:07.000Z",
  );
  const downgradedPeer = ticket(
    "candidate",
    GENERATION_A,
    "review",
    "2026-08-21T02:03:09.000Z",
  );
  const storageKey = recovery.fitnessBackupRecoveryStorageKey(pendingTicket);
  const storage = memoryStorage([[storageKey, JSON.stringify(downgradedPeer)]]);
  const result = await recovery.reconcileFitnessBackupVolatileTransition(
    { ticket: pendingTicket, expected: null },
    journalRuntime(storage),
  );
  if (result.outcome !== "conflict") backendCalls += 1;
  assert.equal(result.outcome, "conflict");
  assert.equal(backendCalls, 0);
  assert.equal(storage.getItem(storageKey), JSON.stringify(downgradedPeer));
});

test("a journal outage upgrades volatile prepare to cleanup and later persists only cleanup", async () => {
  const backing = memoryStorage();
  let unavailable = true;
  const storage = {
    get length() {
      if (unavailable) throw new Error("storage unavailable");
      return backing.length;
    },
    key(index) {
      if (unavailable) throw new Error("storage unavailable");
      return backing.key(index);
    },
    getItem(key) {
      if (unavailable) throw new Error("storage unavailable");
      return backing.getItem(key);
    },
    setItem(key, value) {
      if (unavailable) throw new Error("storage unavailable");
      backing.setItem(key, value);
    },
    removeItem(key) {
      if (unavailable) throw new Error("storage unavailable");
      backing.removeItem(key);
    },
  };
  const runtime = journalRuntime(storage);
  const pendingPrepare = recovery.retainFitnessBackupVolatileTransition(
    ticket("prepare"),
    null,
  );
  assert.equal(
    (await recovery.replaceFitnessBackupRecoveryTicket(
      pendingPrepare.ticket,
      pendingPrepare.expected,
      runtime,
    )).outcome,
    "unavailable",
  );

  const pendingCleanup = recovery.retainFitnessBackupVolatileTransition(
    ticket("prepare-cleanup"),
    pendingPrepare,
  );
  assert.equal(pendingCleanup.ticket.kind, "prepare-cleanup");
  assert.equal(pendingCleanup.expected, null);

  unavailable = false;
  const saved = await recovery.replaceFitnessBackupRecoveryTicket(
    pendingCleanup.ticket,
    pendingCleanup.expected,
    runtime,
  );
  assert.equal(saved.outcome, "written");
  assert.deepEqual(
    recovery.readFitnessBackupRecoveryStorage(storage).entries.map(
      ({ ticket: stored }) => stored.kind,
    ),
    ["prepare-cleanup"],
  );

  const peer = ticket("prepare");
  const peerKey = recovery.fitnessBackupRecoveryStorageKey(peer);
  const peerRaw = JSON.stringify(peer);
  const peerStorage = memoryStorage([[peerKey, peerRaw]]);
  const peerResult = await recovery.replaceFitnessBackupRecoveryTicket(
    pendingCleanup.ticket,
    pendingCleanup.expected,
    journalRuntime(peerStorage),
  );
  assert.equal(peerResult.outcome, "stale");
  assert.equal(peerStorage.getItem(peerKey), peerRaw);
});

test("restore UI uses staged APIs and never labels an unknown file before verification", () => {
  for (const call of [
    "prepareFitnessBackupRestore",
    "recoverFitnessBackupPrepare",
    "retryFitnessPrepareCleanup",
    "activatePreparedFitnessRestore",
    "inspectFitnessRestoreActivation",
    "discardPreparedFitnessRestore",
  ]) assert.match(flowSource, new RegExp(call));
  for (const removed of [
    "isCompleteFitnessBackup",
    "restoreCompleteFitnessBackup",
    "restoreLegacyFitnessDatabase",
  ]) {
    assert.doesNotMatch(appSource, new RegExp(removed.replace(/[.()]/g, "\\$&")));
    assert.doesNotMatch(flowSource, new RegExp(removed.replace(/[.()]/g, "\\$&")));
  }
  assert.doesNotMatch(flowSource, /window\.confirm/);
  assert.doesNotMatch(
    viewsSource.slice(viewsSource.indexOf("type SettingsViewProps")),
    /window\.confirm/,
  );
  assert.match(flowSource, /正在判断“<b className="sl-backup-file-name">\{flow\.fileName\}<\/b>”是什么/);
  assert.match(flowSource, /receipt\?\.summary\.kind === "legacy-fitness-sqlite"/);
  assert.doesNotMatch(
    flowSource.slice(
      flowSource.indexOf("async function prepareSelectedBackup"),
      flowSource.indexOf("function stopPreparation"),
    ),
    /这是旧版|只能恢复数据库内容/,
  );
});

test("prepare checkpoints a durable ticket before staging can proceed", () => {
  const start = flowSource.indexOf("async function prepareSelectedBackup");
  const end = flowSource.indexOf("function stopPreparation", start);
  const prepare = flowSource.slice(start, end);
  assert.match(prepare, /runNewFitnessBackupRecovery\(async \(lease\) =>/);
  assert.match(prepare, /prepareFitnessBackupRestore\(file, \{/);
  assert.match(prepare, /onRecoveryPrepared: async \(recoveryReceipt\)/);
  assert.match(prepare, /trackedReplace\([\s\S]*?lease,[\s\S]*?prepareTicket\(recoveryReceipt\)/);
  assert.ok(
    prepare.indexOf("prepareTicket(recoveryReceipt)") <
      prepare.indexOf('candidateTicket(receipt, "review")'),
  );
  assert.match(recoverySource, /Holds the one Fitness backup-journal lock across raw CAS, backend work/);
  assert.match(recoverySource, /checkpoint callback writes through the lease/);
  assert.match(flowSource, /flow\.phase !== "preparing" && !volatileTransition/);
  assert.match(flowSource, /window\.addEventListener\("beforeunload", protectUnfinishedRestore\)/);
});

test("cleanup and lost journal acknowledgements remain fail-closed until storage-only reconciliation", () => {
  const cleanupStart = flowSource.indexOf(
    "error instanceof FitnessPrepareCleanupIncompleteError",
  );
  const cleanupEnd = flowSource.indexOf(
    "error instanceof FitnessDiscardUncertainError",
    cleanupStart,
  );
  const cleanupCatch = flowSource.slice(cleanupStart, cleanupEnd);
  assert.match(cleanupCatch, /trackedReplace\([\s\S]*?cleanupTicket\(error\.receipt\)/);
  assert.match(flowSource, /setVolatileTransition\(tracker\.current\)/);
  assert.match(
    flowSource,
    /const recoveryActionsLocked = !loaded \|\| storageUnavailable \|\|[\s\S]*?unreadableEntries\.length > 0/,
  );

  const retryStart = flowSource.indexOf("async function retryRecoveryStorage");
  const retryEnd = flowSource.indexOf("async function exportBackup", retryStart);
  const retry = flowSource.slice(retryStart, retryEnd);
  assert.match(retry, /reconcileFitnessBackupVolatileTransition\(pending\)/);
  assert.match(retry, /result\.outcome === "persisted"/);
  assert.match(retry, /result\.outcome === "adopted"/);
  assert.match(retry, /result\.entry\.ticket\.kind === "prepare-cleanup"/);
  assert.doesNotMatch(
    retry,
    /prepareFitnessBackupRestore|recoverFitnessBackupPrepare|activatePreparedFitnessRestore|inspectFitnessRestoreActivation|discardPreparedFitnessRestore|retryFitnessPrepareCleanup/,
  );
  assert.match(
    retry,
    /phase: "prepare-cleanup",\s*entry: result\.entry/,
  );
  assert.match(
    flowSource,
    /const restoreLocked = exportBusy[\s\S]*?recoveryActionsLocked/,
  );
  assert.match(flowSource, /activeEntry && !recoveryActionsLocked/);
});

test("damaged recovery peers synchronously disable every backend phase action", () => {
  const handlers = [
    ["refreshActivated", "inspectCandidate"],
    ["inspectCandidate", "recoverPreparation"],
    ["recoverPreparation", "activateCandidate"],
    ["activateCandidate", "discardCandidate"],
    ["discardCandidate", "cleanPreparedFile"],
    ["cleanPreparedFile", "continueEntry"],
    ["continueEntry", "prepareSelectedBackup"],
  ];
  for (const [name, nextName] of handlers) {
    const start = flowSource.indexOf(`async function ${name}`);
    const end = flowSource.indexOf(`async function ${nextName}`, start + 1);
    const handler = flowSource.slice(start, end);
    assert.ok(start >= 0 && end > start, `${name} must have a bounded source slice`);
    assert.match(
      handler,
      /recoveryActionsLocked/,
      `${name} must synchronously honor the damaged-peer gate`,
    );
  }
  const runnerStart = recoverySource.indexOf(
    "export async function runWithCurrentFitnessBackupEntry",
  );
  const runnerEnd = recoverySource.indexOf(
    "export async function runNewFitnessBackupRecovery",
    runnerStart,
  );
  const runner = recoverySource.slice(runnerStart, runnerEnd);
  assert.ok(
    runner.indexOf("readFitnessBackupRecoveryStorage(journal.storage)") <
      runner.indexOf("await operation(state.lease)"),
  );
  assert.match(runner, /recoveries\.unreadableEntries\.length > 0/);
  assert.match(runner, /outcome: "blocked"/);
  assert.match(runner, /outcome: "unavailable"/);
  assert.ok(
    (flowSource.match(
      /disabled=\{controlsDisabled \|\| recoveryActionsLocked\}/g,
    ) ?? []).length >= 7,
  );
});

test("every clickable async action claims its busy guard before the first await", () => {
  const actions = [
    ["refreshActivated", "inspectCandidate", "runWithCurrentFitnessBackupEntry("],
    ["inspectCandidate", "recoverPreparation", "runWithCurrentFitnessBackupEntry("],
    ["recoverPreparation", "activateCandidate", "runWithCurrentFitnessBackupEntry("],
    ["activateCandidate", "discardCandidate", "runWithCurrentFitnessBackupEntry("],
    ["discardCandidate", "cleanPreparedFile", "runWithCurrentFitnessBackupEntry("],
    ["cleanPreparedFile", "continueEntry", "runWithCurrentFitnessBackupEntry("],
    ["prepareSelectedBackup", "stopPreparation", "runNewFitnessBackupRecovery("],
    ["clearUnreadable", "retryRecoveryStorage", "removeFitnessBackupRecoveryEntry("],
    ["retryRecoveryStorage", "exportBackup", "reconcileFitnessBackupVolatileTransition("],
    ["exportBackup", "const renderSummary", "onExport("],
  ];
  for (const [name, nextName, firstAsyncWork] of actions) {
    const start = flowSource.indexOf(`function ${name}`);
    const end = flowSource.indexOf(nextName.startsWith("const ")
      ? nextName
      : `function ${nextName}`, start + 1);
    const action = flowSource.slice(start, end);
    const guard = action.indexOf("operationRef.current = true");
    const work = action.indexOf(firstAsyncWork);
    assert.ok(start >= 0 && end > start, `${name} must have a bounded source slice`);
    assert.ok(guard >= 0 && guard < work, `${name} must claim busy before async work`);
  }
});

test("activation uncertainty inspects only and every risky path persists a conservative phase first", () => {
  const inspectStart = flowSource.indexOf("async function inspectCandidate");
  const recoverStart = flowSource.indexOf("async function recoverPreparation", inspectStart);
  const inspect = flowSource.slice(inspectStart, recoverStart);
  assert.match(inspect, /inspectFitnessRestoreActivation\(receipt\)/);
  assert.doesNotMatch(inspect, /activatePreparedFitnessRestore|discardPreparedFitnessRestore/);

  const activationStart = flowSource.indexOf("async function activateCandidate");
  const discardStart = flowSource.indexOf("async function discardCandidate", activationStart);
  const activation = flowSource.slice(activationStart, discardStart);
  assert.ok(
    activation.indexOf('candidateTicket(restoreReceipt, "activation-check")') <
      activation.indexOf("activatePreparedFitnessRestore(restoreReceipt)"),
  );
  assert.equal((activation.match(/activatePreparedFitnessRestore\(/g) ?? []).length, 1);
  assert.match(activation, /FitnessActivationUncertainError/);

  const cleanupStart = flowSource.indexOf("async function cleanPreparedFile", discardStart);
  const discard = flowSource.slice(discardStart, cleanupStart);
  assert.ok(
    discard.indexOf('candidateTicket(discardReceipt, "discard-only")') <
      discard.indexOf("discardPreparedFitnessRestore"),
  );
  assert.doesNotMatch(discard, /activatePreparedFitnessRestore/);
  assert.match(discard, /fileCleanup === "incomplete"/);
});

test("activation success and refresh failure remain separate truthful outcomes", () => {
  const helperStart = flowSource.indexOf("async function refreshWithinLease");
  const refreshStart = flowSource.indexOf("async function refreshActivated", helperStart);
  const helper = flowSource.slice(helperStart, refreshStart);
  assert.match(helper, /await onRefreshActivated\(\)/);
  assert.match(helper, /lease\.remove\(\)/);
  const activation = flowSource.slice(
    flowSource.indexOf("async function activateCandidate"),
    flowSource.indexOf("async function discardCandidate"),
  );
  assert.ok(
    activation.indexOf("refreshTicket(restoreReceipt)") <
      activation.indexOf("refreshWithinLease("),
  );
  assert.match(flowSource, /页面暂时没有重新读到它，只需重新读取，不会重复启用/);
  assert.doesNotMatch(
    flowSource.slice(
      flowSource.indexOf("async function refreshActivated"),
      flowSource.indexOf("async function inspectCandidate"),
    ),
    /prepareFitnessBackupRestore|activatePreparedFitnessRestore|discardPreparedFitnessRestore/,
  );
  assert.match(flowSource, />只重新读取<\/button>/);
});

test("review copy reports only verified facts and does not promise one-click rollback", () => {
  const summaryStart = flowSource.indexOf("const renderSummary");
  const flowStart = flowSource.indexOf("const renderFlow", summaryStart);
  const summary = flowSource.slice(summaryStart, flowStart);
  assert.match(summary, /summary\.fileName/);
  assert.match(summary, /summary\.fileCount/);
  assert.match(summary, /summary\.exportedAt/);
  assert.match(summary, /summary\.verification/);
  assert.doesNotMatch(summary, /summary\.(?:venueCount|equipmentCount|exerciseCount|sessionCount)/);
  assert.match(flowSource, /旧版数据库不含器材照片原件/);
  assert.match(flowSource, /会清空失效的附件引用/);
  assert.match(flowSource, /它不是可下载备份，也不代表这里提供一键回退/);
  assert.doesNotMatch(flowSource, /可随时恢复上一版本|完整上一版本/);
});

test("mount and cross-tab changes only reload tickets without automatic backend work or focus", () => {
  const effectStart = flowSource.indexOf("useEffect(() => {\n    const frame");
  const effectEnd = flowSource.indexOf("useEffect(() => {", effectStart + 20);
  const storageEffect = flowSource.slice(effectStart, effectEnd);
  assert.match(storageEffect, /window\.addEventListener\("storage", onStorage\)/);
  assert.match(storageEffect, /window\.addEventListener\("focus", onFocus\)/);
  assert.match(storageEffect, /reloadRecoveries\(\)/);
  assert.doesNotMatch(
    storageEffect,
    /prepareFitness|recoverFitness|activatePrepared|inspectFitness|discardPrepared|\.focus\(/,
  );
  assert.match(flowSource, /页面不会自动执行，也不会抢走焦点/);
  assert.match(flowSource, /entries\.length > 1/);
  assert.match(flowSource, /每次只处理自己的候选/);
});

test("storage failure and damaged tickets expose non-mutating exits", () => {
  assert.match(flowSource, /现在无法查看是否有未完成恢复，因此不会开始新的核对/);
  assert.match(flowSource, /继续信息暂时无法安全保存/);
  assert.match(flowSource, /我知道了，只清除一条提醒/);
  assert.match(flowSource, /没有调用恢复或清理/);
  assert.match(flowSource, /清除后无法在这里继续它/);
  assert.match(flowSource, /const recoveryActionsLocked = !loaded[\s\S]*?unreadableEntries\.length > 0/);
});

test("Settings wiring and 319px CSS preserve operability", () => {
  assert.match(viewsSource, /<FitnessBackupFlow[\s\S]*?onRefreshActivated=\{onRestored\}/);
  assert.match(appSource, /<FitnessDataControls onRestored=\{onRestored\}/);
  assert.match(appSource, /view === "settings"[\s\S]*?onRestored=\{refresh\}/);
  assert.match(css, /\.sl-backup-actions > button \{[\s\S]*?min-width: 0;[\s\S]*?min-height: 66px/);
  assert.match(css, /\.sl-backup-flow > footer button,[\s\S]*?min-height: 44px/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.sl-backup-summary \{\s*grid-template-columns: 1fr/);
  assert.match(css, /\.sl-backup-flow > footer \{\s*display: grid;\s*grid-template-columns: 1fr/);
  assert.match(css, /\.sl-backup-file-name \{[\s\S]*?overflow-wrap: anywhere/);
});
