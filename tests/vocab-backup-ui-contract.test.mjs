import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const recoveryUrl = new URL("app/vocab/backup-recovery.ts", projectRoot);
const flowUrl = new URL("app/vocab/VocabBackupFlow.tsx", projectRoot);
const appUrl = new URL("app/vocab/VocabApp.tsx", projectRoot);
const viewsUrl = new URL("app/vocab/views.tsx", projectRoot);
const cssUrl = new URL("app/vocab/vocab.css", projectRoot);

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
const AUDIO_A = "20000000-0000-4000-8000-000000000001";

function completeSummary(fileName = "words.vocab-backup") {
  return {
    kind: "complete-backup",
    fileName,
    byteSize: 2048,
    databaseByteSize: 1024,
    exportedAt: "2026-08-21T02:03:04.000Z",
    sourceUserVersion: 2,
    canonicalUserVersion: 2,
    audioCount: 1,
    itemCount: null,
    lexemeCount: null,
    verification: "container-and-payload-verified",
  };
}

function prepareReceipt(generationId = GENERATION_A) {
  return {
    version: 1,
    database: "shici",
    operationId: generationId,
    generationId,
    operationToken: "a".repeat(64),
    projectionSha256: "b".repeat(64),
    audioKeysSha256: "c".repeat(64),
    preparedAt: "2026-08-21T02:03:05.000Z",
    summary: completeSummary(),
    stagedAudioKeys: [AUDIO_A],
  };
}

function candidateReceipt(generationId = GENERATION_A) {
  return {
    version: 1,
    database: "shici",
    generationId,
    activationToken: "d".repeat(64),
    recoveryToken: "e".repeat(64),
    expectedCurrentGenerationId: "legacy",
    expectedCurrentSequence: 0,
    canonicalApplicationId: 0x53484349,
    canonicalUserVersion: 2,
    projectionSha256: "b".repeat(64),
    preparedAt: "2026-08-21T02:03:05.000Z",
    summary: completeSummary(),
    stagedAudioKeys: [AUDIO_A],
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
      audioKeysSha256: prepared.audioKeysSha256,
      stagedAudioKeys: prepared.stagedAudioKeys,
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

test("stored recovery tickets are exact, bounded, and operation-bound", () => {
  const valid = ticket("candidate");
  assert.equal(recovery.isVocabBackupRecoveryTicket(valid), true);
  assert.equal(
    recovery.vocabBackupRecoveryStorageKey(valid),
    `${recovery.VOCAB_BACKUP_RECOVERY_PREFIX}operation:${GENERATION_A}`,
  );
  assert.equal(
    recovery.isVocabBackupRecoveryTicket({ ...valid, unexpected: true }),
    false,
  );
  assert.equal(
    recovery.isVocabBackupRecoveryTicket({
      ...valid,
      receipt: { ...valid.receipt, activationToken: "short" },
    }),
    false,
  );
  assert.equal(
    recovery.isVocabBackupRecoveryTicket({
      ...valid,
      receipt: {
        ...valid.receipt,
        summary: { ...valid.receipt.summary, itemCount: 8 },
      },
    }),
    false,
  );
  assert.equal(recovery.isVocabBackupRecoveryTicket(ticket("prepare")), true);
  assert.equal(recovery.isVocabBackupRecoveryTicket(ticket("prepare-cleanup")), true);
  assert.equal(recovery.isVocabBackupRecoveryTicket(ticket("refresh-only")), true);
  assert.match(recoverySource, /VOCAB_BACKUP_RECOVERY_MAX_BYTES = 256 \* 1024/);
  assert.match(recoverySource, /raw\.length > VOCAB_BACKUP_RECOVERY_MAX_BYTES/);
});

test("one damaged entry cannot hide peer operations and conservative phases sort first", () => {
  const refresh = ticket("refresh-only", GENERATION_B, "review", "2026-08-21T02:03:09.000Z");
  const prepare = ticket("prepare", GENERATION_A, "review", "2026-08-21T02:03:06.000Z");
  const refreshKey = recovery.vocabBackupRecoveryStorageKey(refresh);
  const prepareKey = recovery.vocabBackupRecoveryStorageKey(prepare);
  const damagedKey = `${recovery.VOCAB_BACKUP_RECOVERY_PREFIX}operation:damaged`;
  const storage = memoryStorage([
    [prepareKey, JSON.stringify(prepare)],
    [damagedKey, "{not json"],
    [refreshKey, JSON.stringify(refresh)],
  ]);
  const result = recovery.readVocabBackupRecoveryStorage(storage);
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
  const first = await recovery.replaceVocabBackupRecoveryTicket(
    prepared,
    null,
    runtime,
  );
  assert.equal(first.outcome, "written");

  const review = ticket("candidate");
  const activationCheck = ticket("candidate", GENERATION_A, "activation-check");
  const [left, right] = await Promise.all([
    recovery.replaceVocabBackupRecoveryTicket(review, first.entry, runtime),
    recovery.replaceVocabBackupRecoveryTicket(
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
    (await recovery.removeVocabBackupRecoveryEntry(first.entry, runtime)).outcome,
    "stale",
  );
  const current = recovery.readVocabBackupRecoveryStorage(storage).entries[0];
  assert.equal(
    (await recovery.checkVocabBackupRecoveryEntry(current, runtime)).outcome,
    "current",
  );
  assert.equal(
    (await recovery.removeVocabBackupRecoveryEntry(current, runtime)).outcome,
    "removed",
  );
  assert.equal(storage.length, 0);
  assert.match(recoverySource, /private-ai-suite:vocab:backup-recovery-journal/);
  assert.doesNotMatch(recoverySource, /private-ai-suite:vocab:database/);
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
  const pendingPrepare = recovery.retainVocabBackupVolatileTransition(
    ticket("prepare"),
    null,
  );
  assert.equal(
    (await recovery.replaceVocabBackupRecoveryTicket(
      pendingPrepare.ticket,
      pendingPrepare.expected,
      runtime,
    )).outcome,
    "unavailable",
  );

  const pendingCleanup = recovery.retainVocabBackupVolatileTransition(
    ticket("prepare-cleanup"),
    pendingPrepare,
  );
  assert.equal(pendingCleanup.ticket.kind, "prepare-cleanup");
  assert.equal(pendingCleanup.expected, null);

  unavailable = false;
  const saved = await recovery.replaceVocabBackupRecoveryTicket(
    pendingCleanup.ticket,
    pendingCleanup.expected,
    runtime,
  );
  assert.equal(saved.outcome, "written");
  assert.deepEqual(
    recovery.readVocabBackupRecoveryStorage(storage).entries.map(
      ({ ticket: stored }) => stored.kind,
    ),
    ["prepare-cleanup"],
  );

  const peer = ticket("prepare");
  const peerKey = recovery.vocabBackupRecoveryStorageKey(peer);
  const peerRaw = JSON.stringify(peer);
  const peerStorage = memoryStorage([[peerKey, peerRaw]]);
  const peerResult = await recovery.replaceVocabBackupRecoveryTicket(
    pendingCleanup.ticket,
    pendingCleanup.expected,
    journalRuntime(peerStorage),
  );
  assert.equal(peerResult.outcome, "stale");
  assert.equal(peerStorage.getItem(peerKey), peerRaw);
});

test("restore UI uses staged APIs and never labels an unknown file before verification", () => {
  for (const call of [
    "prepareVocabBackupRestore",
    "recoverVocabBackupPrepare",
    "retryVocabPrepareCleanup",
    "activatePreparedVocabRestore",
    "inspectVocabRestoreActivation",
    "discardPreparedVocabRestore",
  ]) assert.match(flowSource, new RegExp(call));
  for (const removed of [
    "isCompleteVocabBackup",
    "restoreCompleteVocabBackup",
    "restoreLegacyVocabDatabase",
  ]) {
    assert.doesNotMatch(appSource, new RegExp(removed.replace(/[.()]/g, "\\$&")));
    assert.doesNotMatch(flowSource, new RegExp(removed.replace(/[.()]/g, "\\$&")));
  }
  assert.doesNotMatch(flowSource, /window\.confirm/);
  assert.doesNotMatch(
    viewsSource.slice(viewsSource.indexOf("type SettingsViewProps")),
    /window\.confirm/,
  );
  assert.match(flowSource, /正在判断“<b className="sc-backup-file-name">\{flow\.fileName\}<\/b>”是什么/);
  assert.match(flowSource, /receipt\?\.summary\.kind === "legacy-vocab-sqlite"/);
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
  assert.match(prepare, /prepareVocabBackupRestore\(file, \{/);
  assert.match(prepare, /onRecoveryPrepared: async \(recoveryReceipt\)/);
  assert.match(prepare, /await writeTicket\(prepareTicket\(recoveryReceipt\), null\)/);
  assert.match(prepare, /if \(result\.outcome !== "written"\) \{\s*throw new Error/);
  assert.ok(
    prepare.indexOf("writeTicket(prepareTicket(recoveryReceipt), null)") <
      prepare.indexOf('candidateTicket(receipt, "review")'),
  );
  assert.match(flowSource, /flow\.phase !== "preparing" && !volatileTransition/);
  assert.match(flowSource, /window\.addEventListener\("beforeunload", protectUnfinishedRestore\)/);
});

test("cleanup returned without a durable checkpoint remains fail-closed until storage retry", () => {
  assert.doesNotMatch(
    flowSource,
    /VocabPrepareCleanupIncompleteError && checkpointEntry/,
  );
  const cleanupStart = flowSource.indexOf(
    "error instanceof VocabPrepareCleanupIncompleteError",
  );
  const cleanupEnd = flowSource.indexOf(
    "error instanceof VocabDiscardUncertainError",
    cleanupStart,
  );
  const cleanupCatch = flowSource.slice(cleanupStart, cleanupEnd);
  assert.match(cleanupCatch, /if \(checkpointEntry\)/);
  assert.match(
    cleanupCatch,
    /retainVocabBackupVolatileTransition\(ticket, current\)/,
  );
  assert.match(cleanupCatch, /setStorageUnavailable\(true\)/);
  assert.match(cleanupCatch, /浏览器存储恢复前不会开始新的恢复/);
  assert.doesNotMatch(cleanupCatch, /setVolatileTransition\([\s\S]*?null/);

  const retryStart = flowSource.indexOf("async function retryRecoveryStorage");
  const retryEnd = flowSource.indexOf("async function exportBackup", retryStart);
  const retry = flowSource.slice(retryStart, retryEnd);
  assert.match(retry, /pending\.ticket\.kind === "prepare-cleanup"/);
  assert.match(
    retry,
    /phase: "prepare-cleanup",\s*entry: result\.entry/,
  );
  const staleStart = retry.indexOf('result.outcome === "stale"');
  const stale = retry.slice(staleStart);
  assert.match(stale, /这里没有覆盖它/);
  assert.match(stale, /可信的清理凭据也仍留在这页/);
  assert.match(stale, /清理凭据仍留在这页/);
  assert.doesNotMatch(stale, /setVolatileTransition\(null\)/);
  assert.doesNotMatch(stale, /setFlow\(\{ phase: "idle" \}\)/);
  assert.match(
    flowSource,
    /const restoreLocked = !loaded[\s\S]*?Boolean\(volatileTransition\)/,
  );
});

test("every clickable async action claims its busy guard before the first await", () => {
  const actions = [
    ["refreshActivated", "inspectCandidate", "ensureCurrent(entry)"],
    ["inspectCandidate", "recoverPreparation", "ensureCurrent(entry)"],
    ["recoverPreparation", "activateCandidate", "ensureCurrent(entry)"],
    ["activateCandidate", "discardCandidate", "transitionOrExplain("],
    ["discardCandidate", "cleanPreparedAudio", "transitionOrExplain("],
    ["cleanPreparedAudio", "continueEntry", "ensureCurrent(entry)"],
    ["prepareSelectedBackup", "stopPreparation", "prepareVocabBackupRestore("],
    ["clearUnreadable", "retryRecoveryStorage", "removeVocabBackupRecoveryEntry("],
    ["retryRecoveryStorage", "exportBackup", "replaceVocabBackupRecoveryTicket("],
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
  assert.match(inspect, /inspectVocabRestoreActivation\(receipt\)/);
  assert.doesNotMatch(inspect, /activatePreparedVocabRestore|discardPreparedVocabRestore/);

  const activationStart = flowSource.indexOf("async function activateCandidate");
  const discardStart = flowSource.indexOf("async function discardCandidate", activationStart);
  const activation = flowSource.slice(activationStart, discardStart);
  assert.ok(
    activation.indexOf('candidateTicket(entry.ticket.receipt, "activation-check")') <
      activation.indexOf("activatePreparedVocabRestore(entry.ticket.receipt)"),
  );
  assert.equal((activation.match(/activatePreparedVocabRestore\(/g) ?? []).length, 1);
  assert.match(activation, /VocabActivationUncertainError/);

  const cleanupStart = flowSource.indexOf("async function cleanPreparedAudio", discardStart);
  const discard = flowSource.slice(discardStart, cleanupStart);
  assert.ok(
    discard.indexOf('candidateTicket(entry.ticket.receipt, "discard-only")') <
      discard.indexOf("discardPreparedVocabRestore"),
  );
  assert.doesNotMatch(discard, /activatePreparedVocabRestore/);
  assert.match(discard, /audioCleanup === "incomplete"/);
});

test("activation success and refresh failure remain separate truthful outcomes", () => {
  const persistStart = flowSource.indexOf("async function persistRefreshThenRead");
  const inspectStart = flowSource.indexOf("async function inspectCandidate", persistStart);
  const refreshSlice = flowSource.slice(persistStart, inspectStart);
  assert.ok(
    refreshSlice.indexOf("refreshTicket(receipt)") <
      refreshSlice.indexOf("await onRefreshActivated()"),
  );
  assert.match(refreshSlice, /页面暂时没有重新读到它，只需重新读取，不会重复启用/);
  assert.doesNotMatch(
    flowSource.slice(
      flowSource.indexOf("async function refreshActivated"),
      flowSource.indexOf("async function inspectCandidate"),
    ),
    /prepareVocabBackupRestore|activatePreparedVocabRestore|discardPreparedVocabRestore/,
  );
  assert.match(flowSource, />只重新读取<\/button>/);
});

test("review copy reports only verified facts and does not promise one-click rollback", () => {
  const summaryStart = flowSource.indexOf("const renderSummary");
  const flowStart = flowSource.indexOf("const renderFlow", summaryStart);
  const summary = flowSource.slice(summaryStart, flowStart);
  assert.match(summary, /summary\.fileName/);
  assert.match(summary, /summary\.audioCount/);
  assert.match(summary, /summary\.exportedAt/);
  assert.match(summary, /summary\.verification/);
  assert.doesNotMatch(summary, /summary\.(?:itemCount|lexemeCount)/);
  assert.match(flowSource, /旧版数据库不带本地音频/);
  assert.match(flowSource, /会清空其中的本地音频引用/);
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
    /prepareVocab|recoverVocab|activatePrepared|inspectVocab|discardPrepared|\.focus\(/,
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
  assert.match(flowSource, /const restoreLocked = !loaded[\s\S]*?storageUnavailable/);
});

test("Settings wiring, mobile sidebar, and 319px CSS preserve operability", () => {
  assert.match(viewsSource, /<VocabBackupFlow[\s\S]*?onRefreshActivated=\{onRestoreRefresh\}/);
  assert.doesNotMatch(viewsSource.slice(viewsSource.indexOf("type SettingsViewProps")), /onImport/);
  assert.match(appSource, /const refreshAfterBackupActivation = useCallback\(async \(\) => \{\s*await initializeVocabDatabase\(\);\s*await refresh\(\)/);
  assert.match(appSource, /aria-hidden=\{sidebarHidden \|\| undefined\} inert=\{sidebarHidden \|\| undefined\}/);
  assert.match(appSource, /button\[data-sidebar-close\]/);
  assert.match(appSource, /data-sidebar-close className="sc-sidebar-close"/);
  assert.match(css, /\.sc-backup-area \.sc-data-actions>button\{min-width:0;min-height:66px/);
  assert.match(css, /\.sc-backup-flow>footer button\{min-height:44px/);
  assert.match(css, /@media\(max-width:760px\)[\s\S]*?\.sc-backup-summary\{grid-template-columns:1fr\}/);
  assert.match(css, /\.sc-backup-flow>footer\{display:grid;grid-template-columns:1fr\}/);
  assert.match(css, /\.sc-backup-file-name\{font-weight:650;overflow-wrap:anywhere\}/);
});
