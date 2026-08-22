import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const root = new URL("../", import.meta.url);
const journalUrl = new URL("app/vocab/item-write-journal.ts", root);
const stateUrl = new URL("app/vocab/item-write-state.ts", root);
const flowUrl = new URL("app/vocab/VocabItemWriteFlow.tsx", root);
const appUrl = new URL("app/vocab/VocabApp.tsx", root);
const viewsUrl = new URL("app/vocab/views.tsx", root);
const cssUrl = new URL("app/vocab/vocab.css", root);

const [journalSource, stateSource, flowSource, appSource, viewsSource, cssSource] =
  await Promise.all([
    readFile(journalUrl, "utf8"),
    readFile(stateUrl, "utf8"),
    readFile(flowUrl, "utf8"),
    readFile(appUrl, "utf8"),
    readFile(viewsUrl, "utf8"),
    readFile(cssUrl, "utf8"),
  ]);

function transpile(source, fileName) {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  assert.deepEqual(
    (result.diagnostics ?? []).filter(({ category }) =>
      category === ts.DiagnosticCategory.Error
    ),
    [],
  );
  return result.outputText;
}

const executableJournal = transpile(journalSource, journalUrl.pathname).replace(
  /import\s*\{\s*isVocabItemWriteReceipt,?\s*\}\s*from\s*"@\/lib\/vocab\/store";/,
  "const isVocabItemWriteReceipt = (value) => Boolean(value && typeof value === 'object' && /^vocab-item-operation-[a-z0-9-]+$/.test(value.operationId) && value.before?.item?.id);",
);
assert.doesNotMatch(executableJournal, /@\/lib\/vocab\/store/);
const journal = await import(
  `data:text/javascript;base64,${Buffer.from(executableJournal).toString("base64")}`
);

const executableState = transpile(stateSource, stateUrl.pathname);
assert.doesNotMatch(executableState, /^import /m);
const state = await import(
  `data:text/javascript;base64,${Buffer.from(executableState).toString("base64")}`
);

function item(overrides = {}) {
  return {
    id: "article-a",
    kind: "article",
    title: "A",
    description: "D",
    source: "local",
    source_url: null,
    author: "Author",
    published_at: "2026-08-22",
    duration_ms: 0,
    audio_url: null,
    status: "in_progress",
    progress: 0.2,
    created_at: 10,
    updated_at: 20,
    ...overrides,
  };
}

function expected(itemValue = item(), generationId = "generation-a") {
  return { generationId, generationSequence: 3, item: itemValue };
}

function writeReceipt(operationId = "vocab-item-operation-contract-a", overrides = {}) {
  const before = expected(item());
  const after = expected(item({ progress: 0.4, updated_at: 21 }));
  return {
    purpose: "vocab-item-write",
    version: 1,
    kind: "progress-checkpoint",
    operationId,
    generationId: before.generationId,
    generationSequence: before.generationSequence,
    before,
    after,
    projectionSha256: "0".repeat(64),
    ...overrides,
  };
}

function ticket(
  kind = "check",
  operationId = "vocab-item-operation-contract-a",
  itemId = "article-a",
  recordedAt = "2026-08-22T03:04:05.000Z",
) {
  const receipt = writeReceipt(operationId);
  receipt.before.item.id = itemId;
  receipt.after.item.id = itemId;
  return { version: 1, kind, receipt, recordedAt };
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

function lockManager() {
  const tails = new Map();
  return {
    request(name, task) {
      const previous = tails.get(name) ?? Promise.resolve();
      const run = previous.then(task, task);
      tails.set(name, run.then(() => undefined, () => undefined));
      return run;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test("item journal validates canonical tickets and confirms durable persistence", async () => {
  assert.equal(journal.isVocabItemWriteTicket(ticket()), true);
  assert.equal(
    journal.isVocabItemWriteTicket(ticket("check", undefined, undefined, "2026-08-22 03:04:05Z")),
    false,
  );
  assert.equal(journal.isVocabItemWriteTicket({ ...ticket(), extra: true }), false);
  const storage = memoryStorage();
  const saved = await journal.persistVocabItemWrite(ticket(), {
    storage,
    locks: lockManager(),
  });
  assert.equal(storage.getItem(saved.storageKey), saved.raw);
});

test("one journal lease spans backend work and a peer cannot interleave", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const entry = await journal.persistVocabItemWrite(ticket(), { storage, locks });
  const started = deferred();
  const release = deferred();
  let peerSettled = false;
  const running = journal.runWithCurrentVocabItemWrite(entry, async (lease) => {
    started.resolve();
    await release.promise;
    lease.remove();
  }, { storage, locks });
  await started.promise;
  const peer = journal.persistVocabItemWrite(
    ticket("check", "vocab-item-operation-contract-b", "article-b"),
    { storage, locks },
  ).then((value) => { peerSettled = true; return value; });
  await Promise.resolve();
  assert.equal(peerSettled, false);
  release.resolve();
  assert.equal((await running).outcome, "ran");
  assert.equal((await peer).ticket.receipt.before.item.id, "article-b");
});

test("a missing held receipt is re-checkpointed before inspect under one full journal lease", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const held = journal.createVocabItemWriteEntry(ticket());
  const started = deferred();
  const release = deferred();
  let inspectCalls = 0;
  let peerSettled = false;
  const recovering = journal.runWithMissingVocabItemWrite(
    held,
    async (lease) => {
      inspectCalls += 1;
      assert.equal(JSON.parse(storage.getItem(held.storageKey)).kind, "check");
      started.resolve();
      await release.promise;
      lease.committed();
      return "exact_saved";
    },
    { storage, locks },
  );
  await started.promise;
  const peer = journal.persistVocabItemWrite(
    ticket("check", "vocab-item-operation-contract-a", "article-a", "2026-08-22T03:04:06.000Z"),
    { storage, locks },
  ).then(
    () => { peerSettled = true; return "saved"; },
    () => { peerSettled = true; return "blocked"; },
  );
  await Promise.resolve();
  assert.equal(peerSettled, false, "a peer cannot write the orphan key while inspect holds the lease");
  release.resolve();
  const recovered = await recovering;
  assert.equal(recovered.outcome, "ran");
  assert.equal(recovered.entry.ticket.kind, "committed");
  assert.equal(await peer, "blocked", "the peer sees the durably advanced raw entry after serialization");
  assert.equal(inspectCalls, 1);

  let repeatedCalls = 0;
  assert.deepEqual(
    await journal.runWithMissingVocabItemWrite(
      held,
      () => { repeatedCalls += 1; },
      { storage, locks },
    ),
    { outcome: "stale" },
    "a same-key entry that reappeared is never inspected outside its current lease",
  );
  assert.equal(repeatedCalls, 0);

  const unrelatedStorage = memoryStorage();
  const unrelatedLocks = lockManager();
  const unrelated = await journal.persistVocabItemWrite(
    ticket("check", "vocab-item-operation-contract-q", "article-q"),
    { storage: unrelatedStorage, locks: unrelatedLocks },
  );
  let heldInspectCalls = 0;
  const heldWithUnrelatedPeer = await journal.runWithMissingVocabItemWrite(
    held,
    (lease) => {
      heldInspectCalls += 1;
      lease.committed();
      return "exact_saved";
    },
    { storage: unrelatedStorage, locks: unrelatedLocks },
  );
  assert.equal(heldWithUnrelatedPeer.outcome, "ran");
  assert.equal(heldInspectCalls, 1, "an unrelated Q never replaces the held P receipt");
  assert.equal(
    unrelatedStorage.getItem(unrelated.storageKey),
    unrelated.raw,
    "the full-scan lease preserves the unrelated ticket",
  );

  for (const kind of ["check", "committed", "changed"]) {
    const sameItemStorage = memoryStorage();
    const sameItemLocks = lockManager();
    const sameItemQ = await journal.persistVocabItemWrite(
      ticket(kind, `vocab-item-operation-same-item-q-${kind}`, "article-a"),
      { storage: sameItemStorage, locks: sameItemLocks },
    );
    let pInspectCalls = 0;
    assert.deepEqual(
      await journal.runWithMissingVocabItemWrite(
        held,
        () => { pInspectCalls += 1; },
        { storage: sameItemStorage, locks: sameItemLocks },
      ),
      { outcome: "stale" },
      `same-item ${kind} Q remains the one durable item ticket`,
    );
    assert.equal(pInspectCalls, 0);
    assert.strictEqual(
      journal.selectVocabItemWriteRecoveryEntry([held], [sameItemQ]),
      sameItemQ,
      `same-item ${kind} Q is explicitly processed while held P remains queued`,
    );
    assert.strictEqual(
      journal.selectVocabItemWriteRecoveryEntry([held], []),
      held,
      `after ${kind} Q settles, missing held P becomes reachable again`,
    );
  }

  const exactP = journal.createVocabItemWriteEntry({
    ...held.ticket,
    kind: "committed",
  });
  const sameItemQ = journal.createVocabItemWriteEntry(
    ticket("check", "vocab-item-operation-priority-q", "article-a"),
  );
  assert.strictEqual(
    journal.selectVocabItemWriteRecoveryEntry([held], [sameItemQ, exactP]),
    exactP,
    "an exact P key has priority over a same-item Q",
  );

  const unreadableStorage = memoryStorage([
    [`${journal.VOCAB_ITEM_WRITE_PREFIX}damaged`, "{damaged"],
  ]);
  let blockedInspectCalls = 0;
  assert.deepEqual(
    await journal.runWithMissingVocabItemWrite(
      held,
      () => { blockedInspectCalls += 1; },
      { storage: unreadableStorage, locks: lockManager() },
    ),
    { outcome: "blocked", reason: "unreadable" },
  );
  await assert.rejects(
    () => journal.runWithMissingVocabItemWrite(
      held,
      () => { blockedInspectCalls += 1; },
      { storage: memoryStorage(), locks: null },
    ),
    /无法跨页面锁定/,
  );
  assert.equal(blockedInspectCalls, 0, "unreadable storage and missing Web Locks call no orphan inspector");
});

test("full scan failures and unreadable peers make backend callback count stay zero", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const entry = await journal.persistVocabItemWrite(ticket(), { storage, locks });
  let backendCalls = 0;
  const peerLocks = {
    request(_name, task) {
      storage.setItem(`${journal.VOCAB_ITEM_WRITE_PREFIX}damaged`, "{damaged");
      return task();
    },
  };
  assert.deepEqual(
    await journal.runWithCurrentVocabItemWrite(
      entry,
      () => { backendCalls += 1; },
      { storage, locks: peerLocks },
    ),
    { outcome: "blocked", reason: "unreadable" },
  );
  assert.equal(backendCalls, 0);
  storage.removeItem(`${journal.VOCAB_ITEM_WRITE_PREFIX}damaged`);
  let failLength = false;
  const failingStorage = {
    get length() {
      if (failLength) throw new Error("length failed");
      return storage.length;
    },
    key: storage.key,
    getItem: storage.getItem,
    setItem: storage.setItem,
    removeItem: storage.removeItem,
  };
  const failingLocks = {
    request(_name, task) { failLength = true; return task(); },
  };
  assert.deepEqual(
    await journal.runWithCurrentVocabItemWrite(
      entry,
      () => { backendCalls += 1; },
      { storage: failingStorage, locks: failingLocks },
    ),
    { outcome: "blocked", reason: "storage" },
  );
  assert.equal(backendCalls, 0);
});

test("raw CAS protects an advanced ticket and no-lock persistence performs zero writes", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const entry = await journal.persistVocabItemWrite(ticket(), { storage, locks });
  const advanced = await journal.runWithCurrentVocabItemWrite(
    entry,
    (lease) => lease.committed(),
    { storage, locks },
  );
  assert.equal(advanced.outcome, "ran");
  assert.deepEqual(
    await journal.runWithCurrentVocabItemWrite(
      entry,
      (lease) => lease.remove(),
      { storage, locks },
    ),
    { outcome: "stale" },
  );
  assert.equal(JSON.parse(storage.getItem(entry.storageKey)).kind, "committed");

  let writes = 0;
  const noLockStorage = memoryStorage();
  const guardedStorage = {
    ...noLockStorage,
    setItem(key, value) { writes += 1; noLockStorage.setItem(key, value); },
  };
  await assert.rejects(
    () => journal.persistVocabItemWrite(ticket(), {
      storage: guardedStorage,
      locks: null,
    }),
    /无法跨页面锁定/,
  );
  assert.equal(writes, 0);
});

test("revision trace consumes only the exact submission and rebases a newer candidate", () => {
  const receipt = writeReceipt();
  const submitted = {
    itemId: "article-a",
    progress: 0.4,
    expected: receipt.before,
    revision: 7,
  };
  const newer = { ...submitted, progress: 0.6, revision: 8 };
  assert.equal(state.vocabItemCandidateMatchesSubmission(submitted, submitted), true);
  assert.equal(state.vocabItemCandidateMatchesSubmission(newer, submitted), false);
  assert.deepEqual(
    state.reconcileVocabItemCheckpointAfterApplied(
      newer,
      receipt,
      submitted.revision,
      receipt.after,
    ),
    { ...newer, expected: receipt.after },
  );
  assert.equal(
    state.reconcileVocabItemCheckpointAfterApplied(
      submitted,
      receipt,
      submitted.revision,
      receipt.after,
    ),
    null,
  );

  const firstRefresh = state.reconcileVocabItemCheckpointAfterApplied(
    newer,
    receipt,
    submitted.revision,
    receipt.after,
  );
  assert.deepEqual(firstRefresh, { ...newer, expected: receipt.after });
  assert.strictEqual(
    state.reconcileVocabItemCheckpointAfterApplied(
      firstRefresh,
      receipt,
      null,
      receipt.after,
    ),
    firstRefresh,
    "a second refresh-only pass after journal removal failed keeps the already-rebased candidate",
  );
  assert.equal(
    state.vocabItemBundleShouldDefer(
      new Map([["article-a", receipt.after]]),
      new Map([["article-a", firstRefresh]]),
      { receipt, mode: "after-only", submittedRevision: null },
    ),
    false,
  );
  assert.equal(
    state.sameVocabItemExpected(firstRefresh.expected, receipt.after),
    true,
    "after the second refresh and successful receipt removal, the newer candidate is eligible for its own checkpoint",
  );

  const uncertainTail = { ...newer, revision: 9 };
  assert.equal(
    state.vocabItemBundleShouldDefer(
      new Map([["article-a", receipt.after]]),
      new Map([["article-a", uncertainTail]]),
      { receipt, mode: "after-only", submittedRevision: null },
    ),
    false,
    "an exact inspect after an uncertain progress commit may rebase a same-before tail",
  );
  assert.deepEqual(
    state.reconcileVocabItemCheckpointAfterApplied(
      uncertainTail,
      receipt,
      null,
      receipt.after,
    ),
    { ...uncertainTail, expected: receipt.after },
  );

  const sameValueTail = {
    ...newer,
    progress: receipt.after.item.progress,
    revision: 10,
  };
  assert.equal(
    state.reconcileVocabItemCheckpointAfterApplied(
      sameValueTail,
      receipt,
      submitted.revision,
      receipt.after,
    ),
    null,
    "a newer revision already satisfied by the receipt is consumed instead of preparing a redundant write",
  );
});

test("a flow-held receipt remains a write barrier after its journal key disappears", () => {
  const receipt = writeReceipt("vocab-item-operation-held-p");
  const tail = {
    itemId: receipt.before.item.id,
    progress: receipt.before.item.progress,
    expected: receipt.before,
    revision: 8,
  };
  assert.deepEqual(
    state.vocabItemHeldReceiptBarrier(receipt.operationId, [receipt.operationId]),
    { blocksWrites: true, volatile: false },
    "a durably journaled held receipt blocks item writes without adding unload risk",
  );
  const missingWithUnrelatedQ = state.vocabItemHeldReceiptBarrier(
    receipt.operationId,
    ["vocab-item-operation-unrelated-q"],
  );
  assert.deepEqual(
    missingWithUnrelatedQ,
    { blocksWrites: true, volatile: true },
    "an unrelated Q cannot satisfy or replace the missing held P receipt",
  );
  let stalePrepareCalls = 0;
  if (state.vocabItemCheckpointSchedulingOpen({
    dirtyCount: 1,
    operationInProgress: false,
    journalLoaded: true,
    externalWriteLocked: false,
    storageUnavailable: false,
    lockUnavailable: false,
    unreadableCount: 0,
    entryCount: 0,
    allDirtyItemsPaused: missingWithUnrelatedQ.blocksWrites,
  })) stalePrepareCalls += 1;
  assert.equal(stalePrepareCalls, 0, "storage-event removal cannot schedule the before-bound tail");
  const away = { ...tail, progress: 0.65, revision: 7 };
  assert.equal(
    state.coalesceVocabItemCheckpointSample(
      away,
      receipt.before,
      receipt.before.item.progress,
      8,
      false,
    ),
    null,
    "without the held receipt lineage a genuine return during inspect would be lost",
  );
  const returnedDuringHeldInspect = state.coalesceVocabItemCheckpointSample(
    away,
    receipt.before,
    receipt.before.item.progress,
    8,
    true,
  );
  assert.deepEqual(
    returnedDuringHeldInspect,
    tail,
    "a missing held progress receipt keeps return-to-before as a newer revision while inspect awaits",
  );
  const rebased = state.reconcileVocabItemCheckpointAfterApplied(
    returnedDuringHeldInspect,
    receipt,
    null,
    receipt.after,
  );
  assert.deepEqual(
    rebased,
    { ...tail, expected: receipt.after },
    "an exact orphan inspection refresh rebases the genuine latest tail",
  );
  assert.deepEqual(
    state.vocabItemHeldReceiptBarrier(null, []),
    { blocksWrites: false, volatile: false },
    "only exact settlement clears the operation-bound barrier",
  );

  const reopenFlow = flowSource.slice(
    flowSource.indexOf("const reopenLatest"),
    flowSource.indexOf("const removeCurrent"),
  );
  assert.match(reopenFlow, /selectVocabItemWriteRecoveryEntry/);
  assert.doesNotMatch(reopenFlow, /latestJournal\.entries\[0\]/);
  assert.match(flowSource, /const heldProgressAdvance = [\s\S]*?heldEntriesRef\.current\.values\(\)[\s\S]*?receipt\.before[\s\S]*?heldProgressAdvance/);
  assert.match(flowSource, /runWithMissingVocabItemWrite\(entry, operation\)/);
  assert.ok(
    (flowSource.match(/inspectEntryWithLease\(entry, true\)/g) ?? []).length >= 2,
    "both commit-stale and inspect-stale use the held receipt's inspect-only recovery",
  );
  assert.match(
    flowSource,
    /const refreshCommitted = inspect;/,
    "a refresh-only action whose durable key vanished also re-inspects the held receipt before applying after facts",
  );
  assert.match(flowSource, /inspection === "expected"[\s\S]*?progress-checkpoint"[\s\S]*?lease\.remove\(\)/);
});

test("a repeated committed restore refresh preserves a new after-bound checkpoint", () => {
  const before = expected(item({ status: "archived", progress: 0.7 }));
  const after = expected(item({ status: "in_progress", progress: 0.7, updated_at: 21 }));
  const receipt = writeReceipt("vocab-item-operation-restore", {
    kind: "restore",
    before,
    after,
  });
  const afterBound = {
    itemId: "article-a",
    progress: 0.82,
    expected: after,
    revision: 15,
  };
  const firstRetry = state.reconcileVocabItemCheckpointAfterApplied(
    afterBound,
    receipt,
    null,
    after,
  );
  assert.strictEqual(firstRetry, afterBound);
  assert.strictEqual(
    state.reconcileVocabItemCheckpointAfterApplied(
      firstRetry,
      receipt,
      null,
      after,
    ),
    afterBound,
    "receipt removal failure followed by a second refresh-only pass cannot consume restored-item progress",
  );
  assert.equal(
    state.vocabItemCheckpointSchedulingOpen({
      dirtyCount: 1,
      operationInProgress: false,
      journalLoaded: true,
      externalWriteLocked: false,
      storageUnavailable: false,
      lockUnavailable: false,
      unreadableCount: 0,
      entryCount: 0,
      allDirtyItemsPaused: false,
    }),
    true,
    "after successful ticket removal, the restored item candidate can schedule normally",
  );
});

test("checkpoint coalescing cancels an away-then-back sample and Reader setup emits zero writes", () => {
  const baseline = expected(item({ progress: 0.5 }));
  let candidate = state.coalesceVocabItemCheckpointSample(
    undefined,
    baseline,
    0.6,
    1,
  );
  assert.equal(candidate.progress, 0.6);
  candidate = state.coalesceVocabItemCheckpointSample(
    candidate,
    baseline,
    0.5,
    2,
  );
  assert.equal(candidate, null, "returning to the displayed baseline leaves no dirty checkpoint");

  let progressCalls = 0;
  const sample = (enabled, progress, last) => {
    if (state.shouldReportVocabReaderProgress(enabled, progress, last)) {
      progressCalls += 1;
    }
  };
  sample(false, 0, 0.8);
  sample(false, 0.8, 0.8);
  sample(false, 0.6, 0.8);
  assert.equal(
    progressCalls,
    0,
    "mount restoration and own/peer prop refresh setup are display-only",
  );
  sample(true, 0.6, 0.8);
  assert.equal(progressCalls, 1, "only the enabled scroll listener may report progress");

  const readerEffect = viewsSource.slice(
    viewsSource.indexOf("const needsRestore = restoredItem.current !== item.id"),
    viewsSource.indexOf("const handlePick = (event: MouseEvent)"),
  );
  assert.match(readerEffect, /lastSavedProgress\.current = item\.progress/);
  assert.match(readerEffect, /updatePosition\(false\)[\s\S]*?persistenceEnabled = true[\s\S]*?addEventListener\("scroll"/);
  assert.doesNotMatch(readerEffect, /updatePosition\(true\)/);

  const queue = () => true;
  const firstFlowRender = { queueCheckpoint: queue };
  const secondFlowRender = { queueCheckpoint: queue, status: "updated" };
  assert.strictEqual(
    firstFlowRender.queueCheckpoint,
    secondFlowRender.queueCheckpoint,
    "a Flow status rerender keeps the Reader callback dependency stable",
  );
  assert.match(
    appSource,
    /const queueItemCheckpoint = itemWrites\.queueCheckpoint[\s\S]*?\}, \[queueItemCheckpoint\]\)/,
  );
  assert.doesNotMatch(
    appSource.slice(
      appSource.indexOf("const recordItemProgressCandidate"),
      appSource.indexOf("const discardItemCheckpointsAndRefresh"),
    ),
    /\[itemWrites\]/,
  );
  const queueCallback = flowSource.slice(
    flowSource.indexOf("const queueCheckpoint = useCallback"),
    flowSource.indexOf("useEffect(() => {", flowSource.indexOf("const queueCheckpoint")),
  );
  assert.match(queueCallback, /const currentJournal = journalRef\.current/);
  assert.doesNotMatch(
    queueCallback.slice(queueCallback.lastIndexOf("}, [")),
    /\bjournal\b/,
    "journal/status rerenders do not change the Reader listener callback identity",
  );
});

test("baseline return is cancelable before claim but becomes a newer tail during commit and recovery", async () => {
  const receipt = writeReceipt();
  const away = state.coalesceVocabItemCheckpointSample(
    undefined,
    receipt.before,
    0.4,
    7,
  );
  assert.equal(away.progress, 0.4);
  assert.equal(
    state.coalesceVocabItemCheckpointSample(away, receipt.before, 0.2, 8),
    null,
    "before submission, away then back is a zero-write cancellation",
  );
  const postClaimBack = state.coalesceVocabItemCheckpointSample(
    away,
    receipt.before,
    0.2,
    8,
    true,
  );
  assert.equal(postClaimBack.progress, 0.2);
  assert.ok(postClaimBack.revision > away.revision);
  assert.deepEqual(
    state.reconcileVocabItemCheckpointAfterApplied(
      postClaimBack,
      receipt,
      away.revision,
      receipt.after,
    ),
    { ...postClaimBack, expected: receipt.after },
    "after C7 commits .4, C8 is rebased and can checkpoint back to the latest .2 intent",
  );

  for (const recoveryPath of ["inspect-exact", "refresh-committed"]) {
    const gate = deferred();
    const oldTail = { ...away, progress: 0.7, revision: 9 };
    let recoveryTail = oldTail;
    const running = (async () => {
      await gate.promise;
      return state.reconcileVocabItemCheckpointAfterApplied(
        recoveryTail,
        receipt,
        null,
        receipt.after,
      );
    })();
    recoveryTail = state.coalesceVocabItemCheckpointSample(
      oldTail,
      receipt.before,
      receipt.before.item.progress,
      10,
      true,
    );
    gate.resolve();
    assert.deepEqual(
      await running,
      { ...recoveryTail, expected: receipt.after },
      `${recoveryPath} keeps a return-to-before tail until exact after applies`,
    );
  }
  const flowQueue = flowSource.slice(
    flowSource.indexOf("const queueCheckpoint = useCallback"),
    flowSource.indexOf("useEffect(() => {", flowSource.indexOf("const queueCheckpoint")),
  );
  assert.match(flowQueue, /submittedCheckpointRef/);
  assert.match(flowQueue, /journalRef\.current\.entries/);
  assert.match(flowQueue, /refreshProtectionRef/);
});

test("bundle trace accepts own after for rebase, accepts arbitrary committed truth without dirty, and defers peers", () => {
  const receipt = writeReceipt();
  const newer = new Map([["article-a", {
    itemId: "article-a",
    progress: 0.6,
    expected: receipt.before,
    revision: 8,
  }]]);
  const protection = {
    receipt,
    mode: "after-only",
    submittedRevision: 7,
  };
  assert.equal(
    state.vocabItemBundleShouldDefer(
      new Map([["article-a", receipt.after]]),
      newer,
      protection,
    ),
    false,
  );
  const peer = expected(item({ progress: 0.9, updated_at: 30 }));
  assert.equal(
    state.vocabItemBundleShouldDefer(
      new Map([["article-a", peer]]),
      newer,
      protection,
    ),
    true,
  );
  assert.equal(
    state.vocabItemBundleShouldDefer(
      new Map([["article-a", peer]]),
      new Map(),
      protection,
    ),
    false,
    "a durably committed receipt may refresh to newer truth when no newer local candidate exists",
  );
  const complete = writeReceipt("vocab-item-operation-complete", {
    kind: "complete",
    after: expected(item({ status: "complete", progress: 1, updated_at: 21 })),
  });
  const terminalTail = new Map([["article-a", {
    itemId: "article-a",
    progress: 0.99,
    expected: complete.before,
    revision: 12,
  }]]);
  assert.equal(
    state.vocabItemBundleShouldDefer(
      new Map([["article-a", complete.after]]),
      terminalTail,
      { receipt: complete, mode: "after-only", submittedRevision: 11 },
    ),
    false,
    "a pause/scroll tail sampled after complete starts is consumed by the bound terminal operation",
  );
  assert.equal(
    state.vocabItemBundleShouldDefer(
      new Map([["article-a", complete.after]]),
      terminalTail,
      { receipt: complete, mode: "after-only", submittedRevision: null },
    ),
    false,
    "after uncertainty, inspect-exact or reload may consume a before-bound tail without a volatile barrier",
  );
  assert.equal(
    state.vocabItemBundleShouldDefer(
      new Map([["article-a", peer]]),
      terminalTail,
      { receipt: complete, mode: "after-only", submittedRevision: null },
    ),
    true,
    "the terminal exception never authorizes arbitrary peer truth while a local tail exists",
  );
  assert.equal(
    state.reconcileVocabItemCheckpointAfterApplied(
      terminalTail.get("article-a"),
      complete,
      11,
      complete.after,
    ),
    null,
  );
});

test("changed/external trace blocks until explicit candidate discard, then whole truth can apply", () => {
  const before = expected(item());
  const peer = expected(item({ progress: 0.75, updated_at: 99 }));
  const dirty = new Map([["article-a", {
    itemId: "article-a",
    progress: 0.5,
    expected: before,
    revision: 4,
  }]]);
  assert.equal(
    state.vocabItemBundleShouldDefer(
      new Map([["article-a", peer]]),
      dirty,
      null,
    ),
    true,
  );
  dirty.delete("article-a");
  assert.equal(
    state.vocabItemBundleShouldDefer(
      new Map([["article-a", peer]]),
      dirty,
      null,
    ),
    false,
  );
  const pendingNotice = appSource.slice(
    appSource.indexOf("{itemExternalPending &&"),
    appSource.indexOf("{globalSettingsNotice"),
  );
  assert.match(pendingNotice, /放弃本页位置并读取最新/);
  assert.doesNotMatch(pendingNotice, /flushCheckpoint/);
  assert.match(
    appSource,
    /discardItemPositionsAndReadLatest[\s\S]*?await discardItemCheckpointsAndRefresh\(true, trigger\)/,
  );

  const clicked = {
    itemId: "article-a",
    progress: 0.5,
    expected: before,
    revision: 4,
  };
  const newer = { ...clicked, progress: 0.65, revision: 5 };
  assert.deepEqual(
    state.resolveVocabItemChangedRefreshCandidate(clicked, clicked, false),
    { discardRevision: null, keepAsConflict: false },
    "a failed/deferred refresh must not consume the candidate selected for discard",
  );
  assert.deepEqual(
    state.resolveVocabItemChangedRefreshCandidate(clicked, newer, true),
    { discardRevision: null, keepAsConflict: true },
    "a newer candidate created while reading survives as a paused conflict",
  );
  assert.deepEqual(
    state.resolveVocabItemChangedRefreshCandidate(newer, newer, false),
    { discardRevision: null, keepAsConflict: false },
    "after receipt removal fails, a second failed read still cannot consume the newer revision",
  );
  assert.deepEqual(
    state.resolveVocabItemChangedRefreshCandidate(clicked, clicked, true),
    { discardRevision: 4, keepAsConflict: false },
    "only the exact click-bound revision is discarded after an applied refresh",
  );
});

test("a cached settings bundle cannot bypass an item candidate created later", () => {
  const oldExpected = expected(item());
  const cachedPeer = expected(item({ progress: 0.7, updated_at: 44 }));
  const laterDirty = new Map([["article-a", {
    itemId: "article-a",
    progress: 0.55,
    expected: oldExpected,
    revision: 9,
  }]]);
  assert.equal(
    state.vocabItemBundleShouldDefer(
      new Map([["article-a", cachedPeer]]),
      laterDirty,
      null,
    ),
    true,
  );
  const discardSettings = appSource.slice(
    appSource.indexOf("const discardSettingsDraftAndRead"),
    appSource.indexOf("const rereadSettingsTruth"),
  );
  assert.ok(discardSettings.indexOf("itemWriteGuardRef.current") <
    discardSettings.indexOf("applyVocabFactsBundle(pending.bundle)"));
  assert.match(discardSettings, /pendingItemBundleRef\.current = pending/);
  assert.match(discardSettings, /setItemExternalPending\(true\)/);
});

test("archive and external-lock traces stop before lifecycle mutation", () => {
  assert.equal(state.vocabItemArchiveCheckpointGate(false, "none"), "archive");
  assert.equal(state.vocabItemArchiveCheckpointGate(true, "saved"), "stop-saved");
  assert.equal(state.vocabItemArchiveCheckpointGate(true, "blocked"), "stop-blocked");
  assert.equal(
    state.vocabItemArchiveCheckpointGate(true, "saved", true),
    "stop-blocked",
    "archive cannot unpause and retry a candidate whose baseline is known changed",
  );
  const open = {
    loaded: true,
    storageUnavailable: false,
    lockUnavailable: false,
    entryCount: 0,
    unreadableCount: 0,
  };
  let backendCalls = 0;
  if (state.vocabItemWritePreflightOpen(open, true)) backendCalls += 1;
  assert.equal(backendCalls, 0);
  assert.equal(state.vocabItemWritePreflightOpen(open, false), true);
  assert.equal(state.vocabItemWritePreflightOpen({ ...open, entryCount: 1 }, false), false);
  const staleReadCandidate = state.coalesceVocabItemCheckpointSample(
    undefined,
    expected(item()),
    0.55,
    31,
  );
  assert.ok(staleReadCandidate, "scrolling while a snapshot is stale retains a local candidate");
  const staleScheduler = {
    dirtyCount: 1,
    operationInProgress: false,
    journalLoaded: true,
    externalWriteLocked: true,
    storageUnavailable: false,
    lockUnavailable: false,
    unreadableCount: 0,
    entryCount: 0,
    allDirtyItemsPaused: false,
  };
  let staleReadBackendCalls = 0;
  if (state.vocabItemCheckpointSchedulingOpen(staleScheduler)) {
    staleReadBackendCalls += 1;
  }
  if (state.vocabItemWritePreflightOpen(open, true)) {
    staleReadBackendCalls += 1;
  }
  assert.equal(staleReadBackendCalls, 0, "stale snapshot scroll and Podcast ended perform zero backend work");
  assert.equal(
    state.vocabItemCheckpointSchedulingOpen({
      ...staleScheduler,
      externalWriteLocked: false,
    }),
    true,
    "the retained candidate may schedule only after a successful whole-bundle read returns ready",
  );
  assert.match(
    appSource,
    /externalWriteLocked: settingsDatabaseWriteLocked \|\|\s*snapshotReadStatus !== "ready"/,
  );
  const lifecycle = flowSource.slice(
    flowSource.indexOf("const startLifecycle = useCallback"),
    flowSource.indexOf("const open = useCallback"),
  );
  assert.ok(lifecycle.indexOf("await running") < lifecycle.indexOf("请再次选择归档"));
  assert.ok(lifecycle.indexOf("externalWriteLocked") < lifecycle.indexOf("prepareVocabItemComplete"));
  const immediateIdentity = lifecycle.indexOf(
    "vocabItemLifecycleDisplayBound(displayedExpected, item)",
  );
  assert.ok(immediateIdentity > 0);
  assert.ok(immediateIdentity < lifecycle.indexOf("flushCheckpoint()"));
  assert.ok(immediateIdentity < lifecycle.indexOf("await pending"));
  assert.ok(
    lifecycle.indexOf("await pending") <
      lifecycle.indexOf("vocabItemLifecycleDisplayBound(expected, item)") &&
      lifecycle.indexOf("vocabItemLifecycleDisplayBound(expected, item)") <
      lifecycle.indexOf("prepareVocabItemComplete"),
    "the displayed-object identity is rechecked after any pending write settles and before prepare",
  );

  const displayed = item();
  const unseenSameId = expected({ ...displayed, updated_at: displayed.updated_at + 1 });
  let lifecycleBackendCalls = 0;
  let lifecycleFlushCalls = 0;
  if (state.vocabItemLifecycleDisplayBound(unseenSameId, displayed)) {
    lifecycleFlushCalls += 1;
    lifecycleBackendCalls += 1;
  }
  assert.equal(lifecycleFlushCalls, 0, "a stale displayed object cannot flush before lifecycle preflight");
  assert.equal(
    lifecycleBackendCalls,
    0,
    "an old displayed object cannot authorize a lifecycle prepare with a newer same-id expected object",
  );
  let expectedAfterAwait = expected(displayed);
  expectedAfterAwait = unseenSameId;
  if (state.vocabItemLifecycleDisplayBound(expectedAfterAwait, displayed)) {
    lifecycleBackendCalls += 1;
  }
  assert.equal(
    lifecycleBackendCalls,
    0,
    "an expected object swapped while awaiting another operation cannot authorize prepare",
  );
  assert.equal(state.vocabItemLifecycleDisplayBound(expected(displayed), displayed), true);
  assert.match(lifecycle, /vocabItemLifecycleDisplayBound\(expected, item\)/);
});

test("typed changed locks the old baseline until an explicit applied whole-read", () => {
  const open = {
    loaded: true,
    storageUnavailable: false,
    lockUnavailable: false,
    entryCount: 0,
    unreadableCount: 0,
  };
  let prepareCalls = 0;
  let conflicted = false;
  const attemptPrepare = () => {
    if (!state.vocabItemWritePreflightOpen(open, false, conflicted)) return;
    prepareCalls += 1;
    conflicted = true;
  };
  attemptPrepare();
  attemptPrepare();
  assert.equal(
    prepareCalls,
    1,
    "after the first typed changed result, the same stale display cannot prepare again",
  );

  const baseline = expected(item());
  const captured = {
    itemId: "article-a",
    progress: 0.55,
    expected: baseline,
    revision: 22,
  };
  const peer = expected(item({ progress: 0.7, updated_at: 44 }));
  assert.equal(
    state.vocabItemBundleShouldDefer(
      new Map([["article-a", peer]]),
      new Map([["article-a", captured]]),
      null,
      new Set(["article-a"]),
    ),
    false,
    "the explicit discard transaction alone may let its bound item through the whole-read guard",
  );
  const failed = state.resolveVocabItemExplicitConflictRefresh(
    captured,
    captured,
    false,
  );
  assert.deepEqual(failed, {
    discardRevision: null,
    keepConflict: true,
    clearConflict: false,
  });
  conflicted = !failed.clearConflict;
  attemptPrepare();
  assert.equal(prepareCalls, 1, "a failed or deferred read keeps the stale gate closed");

  const applied = state.resolveVocabItemExplicitConflictRefresh(
    captured,
    captured,
    true,
  );
  assert.deepEqual(applied, {
    discardRevision: captured.revision,
    keepConflict: false,
    clearConflict: true,
  });
  conflicted = !applied.clearConflict;
  attemptPrepare();
  assert.equal(prepareCalls, 2, "only an applied read releases the old-baseline gate");

  const newer = { ...captured, revision: 23, progress: 0.65 };
  assert.deepEqual(
    state.resolveVocabItemExplicitConflictRefresh(captured, newer, true),
    { discardRevision: null, keepConflict: true, clearConflict: false },
    "a candidate updated during the read survives as a paused conflict",
  );
  assert.match(flowSource, /放弃本页未保存位置并读取最新/);
  const discardFlow = flowSource.slice(
    flowSource.indexOf("const discardCheckpointsAndRefresh"),
    flowSource.indexOf("const startLifecycle"),
  );
  assert.match(discardFlow, /checkpointPausedRef\.current\.add\(itemId\)[\s\S]*?checkpointConflictRef\.current\.add\(itemId\)[\s\S]*?const outcome = await refresh\(\)/);
  assert.equal(
    (discardFlow.match(/vocabItemExplicitDiscardGateItemIds\(/g) ?? []).length,
    3,
    "deferred, applied, and thrown explicit reads all reconcile the click set with candidates created while awaiting",
  );

  let ordinaryPrepareCalls = 0;
  const schedulerInput = (allDirtyItemsPaused) => ({
    dirtyCount: 1,
    operationInProgress: false,
    journalLoaded: true,
    externalWriteLocked: false,
    storageUnavailable: false,
    lockUnavailable: false,
    unreadableCount: 0,
    entryCount: 0,
    allDirtyItemsPaused,
  });
  assert.equal(state.vocabItemCheckpointSchedulingOpen(schedulerInput(false)), true);
  for (const refreshOutcome of ["deferred", "superseded", "throw"]) {
    const ordinaryFailed = state.resolveVocabItemExplicitConflictRefresh(
      captured,
      captured,
      false,
    );
    if (state.vocabItemCheckpointSchedulingOpen(
      schedulerInput(ordinaryFailed.keepConflict),
    )) ordinaryPrepareCalls += 1;
    assert.equal(
      ordinaryFailed.keepConflict,
      true,
      `${refreshOutcome} preserves the click-bound candidate as paused conflict`,
    );
  }
  assert.equal(
    ordinaryPrepareCalls,
    0,
    "an ordinary unpaused candidate becomes gated before read and stays at zero prepares after failure",
  );

  const candidateCreatedDuringForcedRead = {
    ...captured,
    itemId: "podcast-c",
    expected: expected(item({ id: "podcast-c", kind: "podcast" })),
    revision: 24,
  };
  for (const refreshOutcome of ["deferred", "superseded", "throw"]) {
    const gatedAfterFailure = state.vocabItemExplicitDiscardGateItemIds(
      new Set(),
      new Map([["podcast-c", candidateCreatedDuringForcedRead]]),
    );
    assert.deepEqual(
      [...gatedAfterFailure],
      ["podcast-c"],
      `${refreshOutcome} gates a candidate created while a forced read with an empty capture awaits`,
    );
    assert.equal(
      state.vocabItemCheckpointSchedulingOpen(
        schedulerInput(gatedAfterFailure.has("podcast-c")),
      ),
      false,
      `${refreshOutcome} releases the operation with zero stale checkpoint prepares`,
    );
  }

  const candidateB = {
    ...captured,
    itemId: "article-b",
    expected: expected(item({ id: "article-b", title: "B" })),
    revision: 25,
  };
  const capturedAAndNewB = state.vocabItemExplicitDiscardGateItemIds(
    new Set(["article-a"]),
    new Map([["article-b", candidateB]]),
  );
  assert.deepEqual(
    [...capturedAAndNewB].sort(),
    ["article-a", "article-b"],
    "a failed explicit read gates both the click-bound item and a different item dirtied while awaiting",
  );
  assert.equal(
    state.vocabItemCheckpointSchedulingOpen(schedulerInput(
      ["article-b"].every((itemId) => capturedAAndNewB.has(itemId)),
    )),
    false,
    "the newly dirty peer cannot schedule after the explicit-read operation releases",
  );
  assert.deepEqual(
    state.resolveVocabItemExplicitConflictRefresh(
      null,
      candidateB,
      true,
    ),
    { discardRevision: null, keepConflict: true, clearConflict: false },
    "an applied read still preserves and gates a candidate created after the click",
  );
  const ordinaryApplied = state.resolveVocabItemExplicitConflictRefresh(
    captured,
    captured,
    true,
  );
  assert.equal(ordinaryApplied.discardRevision, captured.revision);
  assert.equal(
    state.vocabItemCheckpointSchedulingOpen(schedulerInput(true)),
    false,
    "a newer revision retained after an applied read remains paused instead of scheduling",
  );

  const baselineReturn = state.coalesceVocabItemCheckpointSample(
    captured,
    baseline,
    baseline.item.progress,
    24,
  );
  assert.equal(baselineReturn, null);
  conflicted = true;
  attemptPrepare();
  assert.equal(
    prepareCalls,
    2,
    "removing a satisfied candidate never removes the independent stale-display gate",
  );
  const candidateRemoval = flowSource.slice(
    flowSource.indexOf("const clearCheckpointCandidate"),
    flowSource.indexOf("useEffect(() => {", flowSource.indexOf("const clearCheckpointCandidate")),
  );
  assert.doesNotMatch(candidateRemoval, /checkpointConflictRef\.current\.delete/);
  assert.match(
    flowSource.slice(
      flowSource.indexOf("const commitEntry = useCallback"),
      flowSource.indexOf("const startPrepared = useCallback"),
    ),
    /result\.value === "changed"[\s\S]*?checkpointPausedRef\.current\.add\(itemId\)[\s\S]*?checkpointConflictRef\.current\.add\(itemId\)/,
  );

  const noCandidateApplied = state.resolveVocabItemExplicitConflictRefresh(
    null,
    undefined,
    true,
  );
  assert.deepEqual(noCandidateApplied, {
    discardRevision: null,
    keepConflict: false,
    clearConflict: true,
  });
  assert.deepEqual(
    state.resolveVocabItemExplicitConflictRefresh(null, undefined, false),
    { discardRevision: null, keepConflict: true, clearConflict: false },
    "a read failure keeps a no-candidate changed gate too",
  );

  let crossItemPrepareCalls = 0;
  if (state.vocabItemCheckpointSchedulingOpen(schedulerInput(true))) {
    crossItemPrepareCalls += 1;
  }
  assert.equal(
    crossItemPrepareCalls,
    0,
    "conflict A globally blocks an otherwise unpaused dirty B to match the global locked UI",
  );
  const lifecycle = flowSource.slice(
    flowSource.indexOf("const startLifecycle = useCallback"),
    flowSource.indexOf("const open = useCallback"),
  );
  assert.match(lifecycle, /checkpointConflictRef\.current\.size > 0/);
});

test("recovery close restores focus to the bound opener or a visible fallback", () => {
  let activeElement = { id: "body" };
  const opener = {
    id: "opener",
    isConnected: true,
    disabled: false,
    focus() { activeElement = opener; },
  };
  const detached = { id: "detached", isConnected: false, disabled: false };
  const fallback = {
    id: "heading",
    isConnected: true,
    disabled: false,
    focus() { activeElement = fallback; },
  };
  const usable = (candidate) => candidate.isConnected && !candidate.disabled;
  assert.strictEqual(
    state.firstVocabItemRecoveryFocusTarget([opener, fallback], usable),
    opener,
  );
  assert.strictEqual(
    state.firstVocabItemRecoveryFocusTarget([detached, fallback], usable),
    fallback,
  );
  assert.equal(
    state.firstVocabItemRecoveryFocusTarget([detached], usable),
    null,
  );
  state.firstVocabItemRecoveryFocusTarget([detached, fallback], usable)?.focus();
  assert.notEqual(activeElement.id, "body", "auto-close never leaves focus on the document body");
  for (const source of ["item-write-banner", "item-external-pending"]) {
    activeElement = { id: "body" };
    state.firstVocabItemRecoveryFocusTarget([detached, fallback], usable)?.focus();
    assert.notEqual(
      activeElement.id,
      "body",
      `${source} applied refresh restores focus after its CTA disappears`,
    );
  }

  const commitFlow = flowSource.slice(
    flowSource.indexOf("const commitEntry = useCallback"),
    flowSource.indexOf("const startPrepared = useCallback"),
  );
  const uncertainCatch = commitFlow.slice(commitFlow.lastIndexOf("} catch (reason) {"));
  assert.doesNotMatch(
    uncertainCatch.slice(0, uncertainCatch.indexOf("} finally")),
    /clearExplicitBinding/,
  );
  assert.match(flowSource, /onOpen\(event\.currentTarget\)[\s\S]*?controller\.open\(\)/);
  assert.match(flowSource, /discardCheckpointsAndRefresh\(false, event\.currentTarget\)/);
  assert.match(appSource, /discardItemPositionsAndReadLatest\(event\.currentTarget\)/);
  const discardFocus = flowSource.slice(
    flowSource.indexOf("const discardCheckpointsAndRefresh"),
    flowSource.indexOf("const startLifecycle"),
  );
  assert.match(discardFocus, /if \(trigger\) restoreVisibleFocus\(trigger\)/);
  const focusRestore = appSource.slice(
    appSource.indexOf("const restoreItemRecoveryFocus"),
    appSource.indexOf("const restoreItemExitFocus"),
  );
  assert.equal((focusRestore.match(/requestAnimationFrame/g) ?? []).length, 2);
  assert.match(focusRestore, /!candidate\.isConnected[\s\S]*?candidate\.matches\(":disabled"\)/);
  assert.match(focusRestore, /\.sc-main h1/);
  assert.match(appSource, /setItemRecoveryOpen\(false\)[\s\S]*?restoreItemRecoveryFocus\(\)/);
  const exitFocusRestore = appSource.slice(
    appSource.indexOf("const restoreItemExitFocus"),
    appSource.indexOf("const sidebarOpener"),
  );
  assert.equal((exitFocusRestore.match(/requestAnimationFrame/g) ?? []).length, 2);
  assert.match(exitFocusRestore, /candidate === document\.body[\s\S]*?target\.focus/);
});

test("suite navigation blocks busy work and confirms only volatile checkpoint loss", () => {
  assert.equal(state.vocabItemExitDecision(true, false), "block");
  assert.equal(state.vocabItemExitDecision(false, true), "confirm");
  assert.equal(
    state.vocabItemExitDecision(false, false),
    "leave",
    "an idle durable receipt without volatile progress remains recoverable after navigation",
  );
  assert.equal(state.vocabItemHistoryBackDecision(true, false), "restore-block");
  assert.equal(state.vocabItemHistoryBackDecision(false, true), "restore-confirm");
  assert.equal(state.vocabItemHistoryBackDecision(false, false), "continue");
  const durableHeld = state.vocabItemHeldReceiptBarrier("held-p", ["held-p"]);
  const missingHeld = state.vocabItemHeldReceiptBarrier("held-p", ["unrelated-q"]);
  assert.equal(
    state.vocabItemExitDecision(durableHeld.volatile, false),
    "leave",
    "a held receipt still present in the durable journal does not prompt on navigation",
  );
  assert.equal(
    state.vocabItemExitDecision(missingHeld.volatile, false),
    "block",
    "a held receipt missing from the journal remains volatile and cannot be abandoned as a reading position",
  );
  const historyTrace = [];
  const simulateDuplicatePop = (busy, dirty) => {
    historyTrace.push("duplicate-pop");
    const decision = state.vocabItemHistoryBackDecision(busy, dirty);
    if (decision === "continue") historyTrace.push("back-again");
    else historyTrace.push(decision);
  };
  simulateDuplicatePop(false, false);
  assert.deepEqual(
    historyTrace,
    ["duplicate-pop", "back-again"],
    "once risk clears, one Back traverses the duplicate guard and immediately continues instead of stranding an empty shell",
  );
  const exitGuard = appSource.slice(
    appSource.indexOf("const requestSuiteExit"),
    appSource.indexOf("useEffect(() => {", appSource.indexOf("const requestSuiteExit")),
  );
  assert.match(exitGuard, /vocabItemExitDecision[\s\S]*?event\.preventDefault\(\)/);
  assert.match(exitGuard, /decision === "leave"[\s\S]*?itemHistoryGuardRef\.current = null[\s\S]*?window\.location\.replace\("\/"\)/);
  assert.match(appSource, /<Link href="\/" className="sc-brand"[\s\S]*?onClick=\{requestSuiteExit\}/);
  const exitDialog = appSource.slice(
    appSource.indexOf("{itemExitConfirmOpen &&"),
    appSource.indexOf("{!selection && !toast"),
  );
  assert.match(exitDialog, /data-item-exit-stay[\s\S]*?继续留在本页/);
  assert.match(exitDialog, /abandonItemPositionAndLeaveSuite[\s\S]*?放弃本页位置并离开/);
  assert.match(appSource, /useOverlayDialog<HTMLElement>\([\s\S]*?itemExitConfirmOpen[\s\S]*?"\[data-item-exit-stay\]"/);
  assert.match(exitDialog, /sc-item-exit-scrim" aria-hidden="true"/);
  assert.doesNotMatch(exitDialog, /sc-item-exit-scrim[^>]*onClick/);
  assert.match(exitDialog, /disabled=\{itemWrites\.busy \|\| itemWrites\.hasVolatileHeldReceipt\}[\s\S]*?abandonItemPositionAndContinueHistory/);
  const exitClose = appSource.slice(
    appSource.indexOf("const closeItemExitConfirm"),
    appSource.indexOf("const itemExitDialog"),
  );
  assert.match(exitClose, /setItemExitConfirmOpen\(false\)[\s\S]*?restoreItemExitFocus\(\)/);
  assert.doesNotMatch(exitGuard, /window\.confirm/);
  const historyGuard = appSource.slice(
    appSource.indexOf("useEffect(() => {", appSource.indexOf("const requestSuiteExit")),
    appSource.indexOf("const abandonItemPositionAndContinueHistory"),
  );
  assert.match(historyGuard, /history\.pushState[\s\S]*?addEventListener\("popstate"/);
  assert.match(historyGuard, /vocabItemHistoryBackDecision[\s\S]*?history\.forward\(\)/);
  assert.match(appSource, /history\.go\(guarded \? -2 : -1\)/);
  const suiteLeave = appSource.slice(
    appSource.indexOf("const abandonItemPositionAndLeaveSuite"),
    appSource.indexOf("const abandonItemPositionAndContinueHistory"),
  );
  assert.match(suiteLeave, /discardAllItemCheckpoints\(\)[\s\S]*?allowDiscardedItemNavigation\(\)/);
  assert.match(suiteLeave, /if \(guarded\) window\.location\.replace\("\/"\)[\s\S]*?window\.location\.assign\("\/"\)/);
  const guardedStack = ["A", "Vocab", "Vocab guard"];
  guardedStack[guardedStack.length - 1] = "Suite";
  guardedStack.pop();
  assert.deepEqual(
    guardedStack,
    ["A", "Vocab"],
    "explicit suite leave replaces the sentinel, so one Back returns to one Vocab entry",
  );
  assert.match(appSource, /popstate cannot cancel an arbitrary multi-entry history\.go jump/);
  assert.match(flowSource, /if \(!busy && !hasDirtyCheckpoint && !hasVolatileHeldReceipt\) return;[\s\S]*?beforeunload/);
});

test("whole-bundle read constructs exact item pairs without N+1 item loaders", async () => {
  const helpersSource = appSource.slice(
    appSource.indexOf("function sameVocabSettings("),
    appSource.indexOf("class VocabSnapshotSupersededError"),
  );
  const executable = transpile(`
let loadVocabSnapshot;
let loadVocabSettingsExpectedState;
${helpersSource}
function setLoaders(loadFacts, loadExpected) {
  loadVocabSnapshot = loadFacts;
  loadVocabSettingsExpectedState = loadExpected;
}
export { loadVocabFactsWithSettingsExpected, setLoaders };
`, "vocab-item-bundle-contract.ts");
  const helpers = await import(
    `data:text/javascript;base64,${Buffer.from(executable).toString("base64")}`
  );
  const settings = {
    chinese_explanation: false,
    font_scale: 1,
    line_height: 1.92,
    local_lock: false,
    auto_follow: true,
    daily_new_limit: 8,
  };
  const envelope = {
    generationId: "generation-a",
    generationSequence: 2,
    rows: [],
    settings,
  };
  const original = item();
  const trace = [];
  helpers.setLoaders(
    async () => { trace.push("S"); return { items: [original], settings }; },
    async () => { trace.push("E"); return envelope; },
  );
  const bundle = await helpers.loadVocabFactsWithSettingsExpected();
  assert.deepEqual(trace, ["E", "S", "E"]);
  assert.notStrictEqual(bundle.snapshot.items[0], original);
  assert.strictEqual(
    bundle.itemExpectedById.get("article-a").item,
    bundle.snapshot.items[0],
  );
  assert.equal(bundle.itemExpectedById.get("article-a").generationId, "generation-a");
  assert.doesNotMatch(appSource, /loadVocabItemExpectedState\s*\(/);
});

test("views only report candidates and never write from cleanup", () => {
  const reader = viewsSource.slice(
    viewsSource.indexOf("export function ReaderView"),
    viewsSource.indexOf("export function PodcastView"),
  );
  assert.doesNotMatch(reader, /progressTimer/);
  assert.match(reader, /lastSavedProgress\.current = progress;\s*void onProgress\(item, progress\)/);
  const readerCleanup = reader.slice(
    reader.indexOf("return () => {\n      window.removeEventListener(\"scroll\", updatePosition)"),
    reader.indexOf("};\n  }, [articleBlocks", reader.indexOf("return () => {\n      window.removeEventListener(\"scroll\", updatePosition)")),
  );
  assert.doesNotMatch(readerCleanup, /onProgress|updateItem/);

  const podcast = viewsSource.slice(
    viewsSource.indexOf("export function PodcastView"),
    viewsSource.indexOf("export function WordsView"),
  );
  assert.match(podcast, /const now = performance\.now\(\)/);
  assert.match(podcast, /onPause=\{\(\) => \{ setPlaying\(false\);commitListen\(\);reportCurrentPosition\(\); \}\}/);
  assert.match(podcast, /terminalIntent\.current=true[\s\S]*?onFinish\(item, null\)/);
  const visibilityCleanup = podcast.slice(
    podcast.indexOf("document.addEventListener(\"visibilitychange\", visibility)"),
    podcast.indexOf("}, [commitListen", podcast.indexOf("document.addEventListener(\"visibilitychange\", visibility)")),
  );
  assert.doesNotMatch(visibilityCleanup, /onProgress|onFinish/);
  assert.match(viewsSource, /\.catch\(\(\) => undefined\)/);
});

test("Podcast explicit seek and visible completion retry stay display-bound", () => {
  let seekReports = 0;
  for (const source of ["metadata-restore", "slider-input", "explicit-user"]) {
    if (state.vocabPodcastSeekShouldReport(source)) seekReports += 1;
  }
  assert.equal(
    seekReports,
    2,
    "transcript/J/K and slider movement establish candidates while metadata restoration remains passive",
  );
  const podcast = viewsSource.slice(
    viewsSource.indexOf("export function PodcastView"),
    viewsSource.indexOf("export function WordsView"),
  );
  assert.match(podcast, /onChange=\{\(event\) => seek\(Number\(event\.target\.value\), "slider-input"\)\}/);
  assert.match(podcast, /vocabPodcastSeekShouldReport\(source\)[\s\S]*?reportCurrentPosition\(\)/);
  assert.match(podcast, /lastReportedPositionRef[\s\S]*?vocabPodcastPositionReportChanged\(last, currentItem, progress\)[\s\S]*?return/);
  assert.match(podcast, /onClick=\{\(event\) => \{ setTerminalRetry\(false\);onFinish\(item, event\.currentTarget\); \}\}/);
  assert.match(podcast, /重新标记已听完|标记已听完/);
  assert.match(podcast, /item\.status !== "complete" && item\.status !== "archived" && <div className="sc-podcast-terminal-actions">/);
  assert.equal(state.vocabPodcastCompleteActionEnabled("complete", false, false), false);
  assert.equal(state.vocabPodcastCompleteActionEnabled("archived", false, false), false);

  const oldDisplayed = item({ id: "podcast-a", kind: "podcast", duration_ms: 10_000 });
  const refreshed = expected({ ...oldDisplayed, progress: 0.4, updated_at: 21 });
  let completePrepareCalls = 0;
  if (state.vocabItemLifecycleDisplayBound(refreshed, oldDisplayed)) {
    completePrepareCalls += 1;
  }
  assert.equal(
    completePrepareCalls,
    0,
    "ended intent waiting behind a checkpoint cannot prepare against a swapped unseen expected object",
  );
  assert.equal(
    state.vocabPodcastCompleteActionEnabled(
      refreshed.item.status,
      false,
      false,
    ),
    true,
    "the refreshed display exposes an enabled manual completion retry",
  );
  if (
    state.vocabPodcastCompleteActionEnabled(refreshed.item.status, false, false) &&
    state.vocabItemLifecycleDisplayBound(refreshed, refreshed.item)
  ) completePrepareCalls += 1;
  assert.equal(completePrepareCalls, 1, "the visible CTA prepares once with the current displayed object");
  assert.match(cssSource, /\.sc-podcast-terminal-actions button\{[\s\S]*?min-height:44px/);
  assert.match(podcast, /itemWritePermanentReadOnly \? "当前只读开放[^"]+" : "当前位置先暂存在本页；安全操作结束后会再尝试保存。"/);

  const temporarilyLocked = {
    dirtyCount: 1,
    operationInProgress: false,
    journalLoaded: true,
    externalWriteLocked: true,
    storageUnavailable: false,
    lockUnavailable: false,
    unreadableCount: 0,
    entryCount: 0,
    allDirtyItemsPaused: false,
  };
  assert.equal(state.vocabItemCheckpointSchedulingOpen(temporarilyLocked), false);
  assert.equal(
    state.vocabItemCheckpointSchedulingOpen({
      ...temporarilyLocked,
      externalWriteLocked: false,
    }),
    true,
    "a candidate retained under a temporary settings/item operation can schedule when the gate settles",
  );
});

test("Podcast adopts a peer baseline while paused and reports only genuine local activity", () => {
  assert.equal(state.vocabPodcastSnapshotPositionMode(false, true), "none");
  assert.equal(
    state.vocabPodcastSnapshotPositionMode(true, true),
    "sync-baseline",
  );
  assert.equal(
    state.vocabPodcastSnapshotPositionMode(true, false),
    "keep-active",
  );

  const before = item({ id: "podcast-a", kind: "podcast", progress: 0.2 });
  const identicalClone = { ...before };
  const peer = item({
    id: "podcast-a",
    kind: "podcast",
    progress: 0.7,
    updated_at: 30,
  });
  let displayed = before;
  let current = 0.5;
  let localActivity = true;
  let calls = 0;
  const report = () => {
    if (state.vocabPodcastPositionCanReport(
      localActivity,
      false,
      false,
      displayed.status,
    )) calls += 1;
  };
  const identicalMode = state.vocabPodcastSnapshotPositionMode(
    !state.sameVocabLibraryItemFacts(displayed, identicalClone),
    true,
  );
  assert.equal(identicalMode, "none");
  if (identicalMode === "sync-baseline") {
    current = identicalClone.progress;
    localActivity = false;
  }
  assert.equal(current, 0.5, "an identical whole-read clone cannot rewind local pause position");
  assert.equal(localActivity, true, "the already queued local candidate remains owned");
  assert.equal(Object.keys(before).length, 14);
  for (const key of Object.keys(before)) {
    const value = before[key];
    const changed = {
      ...before,
      [key]: typeof value === "number"
        ? value + 1
        : value === null ? "changed" : `${value}-changed`,
    };
    assert.equal(
      state.sameVocabLibraryItemFacts(before, changed),
      false,
      `${key} participates in the paused snapshot gate`,
    );
  }

  if (state.vocabPodcastSnapshotPositionMode(
    !state.sameVocabLibraryItemFacts(displayed, peer),
    true,
  ) ===
      "sync-baseline") {
    displayed = peer;
    current = peer.progress;
    localActivity = false;
  }
  report(); // untouched range blur
  report(); // visibility hidden
  assert.equal(calls, 0);
  assert.equal(current, 0.7);

  current = 0.44;
  localActivity = true;
  assert.equal(
    state.vocabPodcastSnapshotPositionMode(
      !state.sameVocabLibraryItemFacts(displayed, before),
      false,
    ),
    "keep-active",
  );
  report();
  assert.equal(calls, 1, "active playback may publish its current candidate");
  const firstReport = { item: displayed, progress: current };
  assert.equal(
    state.vocabPodcastPositionReportChanged(firstReport, displayed, current),
    false,
    "pointer-up and blur do not duplicate the candidate established by slider input",
  );
  assert.equal(
    state.vocabPodcastPositionReportChanged(firstReport, displayed, 0.45),
    true,
  );

  const podcast = viewsSource.slice(
    viewsSource.indexOf("export function PodcastView"),
    viewsSource.indexOf("export function WordsView"),
  );
  assert.match(podcast, /vocabPodcastSnapshotPositionMode\(\s*!sameVocabLibraryItemFacts\(previousItem, item\)[\s\S]*?positionActivityRef\.current = false/);
  assert.match(podcast, /if \(!event\.currentTarget\.paused\) positionActivityRef\.current = true/);
  assert.match(podcast, /vocabPodcastPositionCanReport\([\s\S]*?vocabPodcastPositionReportChanged/);
  assert.match(podcast, /onPointerUp=\{reportCurrentPosition\} onBlur=\{reportCurrentPosition\}/);
});

test("journal action rejection restores a retryable phase and releases working state", async () => {
  const scenarios = [
    ["discard-expected", false, "expected"],
    ["dismiss-invalid", false, "invalid"],
    ["clear-unreadable", false, "idle"],
    ["clear-unreadable", true, "check"],
  ];
  for (const [action, held, expectedPhase] of scenarios) {
    let phase = "working";
    let claimed = true;
    try {
      await Promise.reject(new Error("journal unavailable"));
    } catch {
      phase = state.vocabItemJournalFailureRecoveryPhase(action, held);
    } finally {
      claimed = false;
    }
    assert.equal(phase, expectedPhase);
    assert.notEqual(phase, "working");
    assert.equal(claimed, false);
  }

  const discard = flowSource.slice(
    flowSource.indexOf("const discardExpected = useCallback"),
    flowSource.indexOf("const refreshCommitted"),
  );
  assert.match(discard, /catch \(reason\)[\s\S]*?reloadJournal\(\)[\s\S]*?phase: vocabItemJournalFailureRecoveryPhase\("discard-expected"\)[\s\S]*?finally[\s\S]*?release\(token\)/);
  const dismiss = flowSource.slice(
    flowSource.indexOf("const dismissInvalid = useCallback"),
    flowSource.indexOf("const clearUnreadable"),
  );
  assert.match(dismiss, /catch \(reason\)[\s\S]*?phase: vocabItemJournalFailureRecoveryPhase\("dismiss-invalid"\)[\s\S]*?finally[\s\S]*?release\(token\)/);
  const clear = flowSource.slice(
    flowSource.indexOf("const clearUnreadable = useCallback"),
    flowSource.indexOf("return {", flowSource.indexOf("const clearUnreadable = useCallback")),
  );
  assert.match(clear, /catch \(reason\)[\s\S]*?reloadJournal\(\)[\s\S]*?restoreHeldFlowOrIdle[\s\S]*?finally[\s\S]*?release\(token\)/);
});

test("expected continuation and delayed checkpoints recheck the current external write gate", () => {
  const continuation = {
    externalWriteLocked: false,
    hasConflict: false,
    storageUnavailable: false,
    lockUnavailable: false,
    unreadableCount: 0,
    selectedReceiptMatches: true,
  };
  let commitCalls = 0;
  if (state.vocabItemExpectedContinuationOpen({
    ...continuation,
    externalWriteLocked: true,
  })) commitCalls += 1;
  assert.equal(commitCalls, 0);
  if (state.vocabItemExpectedContinuationOpen(continuation)) commitCalls += 1;
  assert.equal(commitCalls, 1);
  for (const blocked of [
    { storageUnavailable: true },
    { lockUnavailable: true },
    { unreadableCount: 1 },
    { hasConflict: true },
    { selectedReceiptMatches: false },
  ]) {
    assert.equal(
      state.vocabItemExpectedContinuationOpen({ ...continuation, ...blocked }),
      false,
    );
  }

  const scheduleInput = {
    dirtyCount: 1,
    operationInProgress: false,
    journalLoaded: true,
    externalWriteLocked: false,
    storageUnavailable: false,
    lockUnavailable: false,
    unreadableCount: 0,
    entryCount: 0,
    allDirtyItemsPaused: false,
  };
  assert.equal(state.vocabItemCheckpointSchedulingOpen(scheduleInput), true);
  let prepareCalls = 0;
  const externalAtFire = true;
  if (state.vocabItemCheckpointSchedulingOpen({
    ...scheduleInput,
    externalWriteLocked: externalAtFire,
  })) prepareCalls += 1;
  assert.equal(prepareCalls, 0, "an already armed timer does not prepare after the gate closes");
  if (state.vocabItemCheckpointSchedulingOpen(scheduleInput)) prepareCalls += 1;
  assert.equal(prepareCalls, 1, "unlock schedules exactly one later attempt");

  const continuationSource = flowSource.slice(
    flowSource.indexOf("const continueExpected = useCallback"),
    flowSource.indexOf("const discardExpected"),
  );
  assert.ok(continuationSource.indexOf("vocabItemExpectedContinuationOpen") <
    continuationSource.indexOf('claim("commit"'));
  assert.ok(continuationSource.indexOf('claim("commit"') <
    continuationSource.indexOf("commitEntry(entry"));
  const scheduler = flowSource.slice(
    flowSource.indexOf("const scheduleCheckpoint = useCallback"),
    flowSource.indexOf("const queueCheckpoint"),
  );
  assert.ok(scheduler.indexOf("externalWriteLockedRef.current") <
    scheduler.indexOf("flushCheckpoint()"));
  const prepared = flowSource.slice(
    flowSource.indexOf("const startPrepared = useCallback"),
    flowSource.indexOf("const flushCheckpoint"),
  );
  assert.ok(prepared.indexOf("externalWriteLockedRef.current") <
    prepared.indexOf("receipt = await prepare()"));
  assert.match(flowSource, /useLayoutEffect\(\(\) => \{[\s\S]*?externalWriteLockedRef\.current = externalWriteLocked;[\s\S]*?clearCheckpointTimer\(\)/);
});

test("snapshot read failure stays visible and storage clear makes a held receipt volatile", () => {
  const operationId = "vocab-item-operation-storage-clear";
  assert.deepEqual(
    state.vocabItemHeldReceiptBarrier(operationId, [operationId]),
    { blocksWrites: true, volatile: false },
  );
  assert.deepEqual(
    state.vocabItemHeldReceiptBarrier(operationId, []),
    { blocksWrites: true, volatile: true },
  );
  assert.equal(state.vocabItemExitDecision(true, false), "block");
  assert.match(flowSource, /event\.key === null \|\| event\.key\.startsWith\(VOCAB_ITEM_WRITE_PREFIX\)/);
  assert.match(appSource, /setSnapshotReadStatus\("stale"\);\s*setSnapshotReadError\(errorMessage\(reason\)\)/);
  assert.match(appSource, /snapshotReadStatus === "stale"[\s\S]*?sc-snapshot-read-notice[\s\S]*?只重新读取/);
  assert.match(appSource, /externalWriteLocked: settingsDatabaseWriteLocked \|\|\s*snapshotReadStatus !== "ready"/);
  assert.match(appSource, /retryVocabFactsRead[\s\S]*?readVocabFacts\(\)[\s\S]*?\.sc-main h1/);
});

test("foreground stale recovery requests focus while background recovery stays calm", () => {
  const reopen = flowSource.slice(
    flowSource.indexOf("const reopenLatest = useCallback"),
    flowSource.indexOf("const removeCurrent"),
  );
  assert.match(reopen, /entry: VocabItemWriteEntry,\s*background: boolean/);
  assert.match(reopen, /showAttention\([\s\S]*?, background\)/);
  assert.match(flowSource, /reopenLatest\(entry, false\)/);
  assert.match(flowSource, /reopenLatest\(entry, background\)/);
  let focusRequests = 0;
  const reopenTrace = (background) => {
    if (!background) focusRequests += 1;
  };
  reopenTrace(false);
  assert.equal(focusRequests, 1);
  reopenTrace(true);
  assert.equal(focusRequests, 1, "background recovery does not steal focus");
});

test("UI wiring is durable-first, terminal-safe, and mobile actions remain 44px", () => {
  const start = flowSource.slice(
    flowSource.indexOf("const startPrepared = useCallback"),
    flowSource.indexOf("const flushCheckpoint = useCallback"),
  );
  assert.ok(start.indexOf("receipt = await prepare()") <
    start.indexOf("await persistVocabItemWrite"));
  assert.ok(start.indexOf("await persistVocabItemWrite") <
    start.indexOf("await commitEntry"));
  const inspect = flowSource.slice(
    flowSource.indexOf("const inspect = useCallback"),
    flowSource.indexOf("const continueExpected = useCallback"),
  );
  const inspectLease = flowSource.slice(
    flowSource.indexOf("const inspectEntryWithLease"),
    flowSource.indexOf("const shouldDeferBundle"),
  );
  assert.match(inspectLease, /inspectVocabItemWrite/);
  assert.doesNotMatch(inspect, /commitVocabItemWrite/);
  assert.match(appSource, /settingsDatabaseWriteLocked = settingsWrites\.writeLocked \|\|\s*settingsWrites\.operationInProgress\(\)/);
  assert.match(appSource, /databaseMutationLocked=\{itemDatabaseMutationLocked\}/);
  assert.match(viewsSource, /status === "in_progress"[\s\S]*?status === "unread"/);
  assert.match(cssSource, /\.sc-item-write-banner[\s\S]*?min-height:44px/);
  assert.match(cssSource, /\.sc-item-write-recovery[\s\S]*?min-height:44px/);
  assert.match(cssSource, /\.sc-item-exit-dialog button,\.sc-item-exit-dialog a\{[\s\S]*?min-height:44px/);
});
