import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const root = new URL("../", import.meta.url);
const journalUrl = new URL("app/vocab/settings-write-journal.ts", root);
const flowUrl = new URL("app/vocab/VocabSettingsWriteFlow.tsx", root);
const appUrl = new URL("app/vocab/VocabApp.tsx", root);
const viewsUrl = new URL("app/vocab/views.tsx", root);
const uiUrl = new URL("app/vocab/ui.tsx", root);
const overlaysUrl = new URL("app/vocab/overlays.tsx", root);

const [journalSource, flowSource, appSource, viewsSource, uiSource, overlaysSource] = await Promise.all([
  readFile(journalUrl, "utf8"),
  readFile(flowUrl, "utf8"),
  readFile(appUrl, "utf8"),
  readFile(viewsUrl, "utf8"),
  readFile(uiUrl, "utf8"),
  readFile(overlaysUrl, "utf8"),
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
    (result.diagnostics ?? []).filter(({ category }) => category === ts.DiagnosticCategory.Error),
    [],
  );
  return result.outputText;
}

const executableJournal = transpile(journalSource, journalUrl.pathname).replace(
  /import\s*\{\s*isVocabSettingsWriteReceipt,?\s*\}\s*from\s*"@\/lib\/vocab\/store";/,
  "const isVocabSettingsWriteReceipt = (value) => Boolean(value && typeof value === 'object' && /^vocab-settings-operation-[a-z0-9-]+$/.test(value.operationId));",
);
assert.doesNotMatch(executableJournal, /@\/lib\/vocab\/store/);
const journal = await import(`data:text/javascript;base64,${Buffer.from(executableJournal).toString("base64")}`);

const readHelpersSource = appSource.slice(
  appSource.indexOf("function sameVocabSettings("),
  appSource.indexOf("class VocabSnapshotSupersededError"),
);
const executableReadHelpers = transpile(`
let loadVocabSnapshot;
let loadVocabSettingsExpectedState;
${readHelpersSource}
function setLoaders(loadFacts, loadExpected) {
  loadVocabSnapshot = loadFacts;
  loadVocabSettingsExpectedState = loadExpected;
}
export { loadVocabFactsWithSettingsExpected, sameVocabSettingsExpectedState, setLoaders };
`, "vocab-settings-read-contract.ts");
const readHelpers = await import(`data:text/javascript;base64,${Buffer.from(executableReadHelpers).toString("base64")}`);

const flushHelperSource = appSource.slice(
  appSource.indexOf("function claimVocabSettingsDraftFlush("),
  appSource.indexOf("function sameVocabSettings("),
);
const flushHelpers = await import(`data:text/javascript;base64,${Buffer.from(transpile(`${flushHelperSource}\nexport { claimVocabSettingsDraftFlush, vocabSettingsOutboundBlocked };`, "vocab-settings-flush-contract.ts")).toString("base64")}`);

const importPrivacyHelpersSource = overlaysSource.slice(
  overlaysSource.indexOf("class VocabLocalLockImportError"),
  overlaysSource.indexOf("export function ImportWizard"),
);
const importPrivacyHelpers = await import(`data:text/javascript;base64,${Buffer.from(transpile(`${importPrivacyHelpersSource}\nexport { VocabLocalLockImportError, assertVocabExternalImportAllowed };`, "vocab-import-privacy-contract.ts")).toString("base64")}`);

function receipt(operationId = "vocab-settings-operation-contract-a") {
  return { operationId };
}

function ticket(kind = "check", operationId, recordedAt = "2026-08-22T03:04:05.000Z") {
  return { version: 1, kind, receipt: receipt(operationId), recordedAt };
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

test("settings journal rejects noncanonical timestamps and verifies durable persistence", async () => {
  assert.equal(journal.isVocabSettingsWriteTicket(ticket()), true);
  assert.equal(journal.isVocabSettingsWriteTicket(ticket("check", undefined, "2026-08-22 03:04:05Z")), false);
  assert.equal(journal.isVocabSettingsWriteTicket(ticket("check", undefined, "2026-08-22T11:04:05.000+08:00")), false);
  assert.equal(journal.isVocabSettingsWriteTicket({ ...ticket(), extra: true }), false);
  const storage = memoryStorage();
  const saved = await journal.persistVocabSettingsWrite(ticket(), { storage, locks: lockManager() });
  assert.equal(storage.getItem(saved.storageKey), saved.raw);
  assert.match(journalSource, /storage\.setItem\(storageKey, raw\);\s*if \(storage\.getItem\(storageKey\) !== raw\)/);
});

test("the one global journal lease covers backend work and blocks a peer persist", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const first = await journal.persistVocabSettingsWrite(
    ticket("check", "vocab-settings-operation-global-a"),
    { storage, locks },
  );
  const started = deferred();
  const release = deferred();
  let peerSettled = false;
  const running = journal.runWithExclusiveCurrentVocabSettingsWrite(first, async (lease) => {
    started.resolve();
    await release.promise;
    lease.remove();
  }, { storage, locks });
  await started.promise;
  const peer = journal.persistVocabSettingsWrite(
    ticket("check", "vocab-settings-operation-global-b"),
    { storage, locks },
  ).then((entry) => { peerSettled = true; return entry; });
  await Promise.resolve();
  assert.equal(peerSettled, false);
  release.resolve();
  assert.equal((await running).outcome, "ran");
  assert.equal((await peer).ticket.receipt.operationId, "vocab-settings-operation-global-b");
});

test("the in-lock full scan blocks unreadable peers and dynamic length failures before callback", async () => {
  const base = memoryStorage();
  const locks = lockManager();
  const entry = await journal.persistVocabSettingsWrite(ticket(), { storage: base, locks });
  let calls = 0;
  const peerLocks = {
    request(_name, task) {
      base.setItem(`${journal.VOCAB_SETTINGS_WRITE_PREFIX}damaged`, "{damaged");
      return task();
    },
  };
  assert.deepEqual(
    await journal.runWithExclusiveCurrentVocabSettingsWrite(entry, () => { calls += 1; }, { storage: base, locks: peerLocks }),
    { outcome: "blocked", reason: "unreadable" },
  );
  assert.equal(calls, 0);
  base.removeItem(`${journal.VOCAB_SETTINGS_WRITE_PREFIX}damaged`);
  let failLength = false;
  const failingStorage = {
    get length() { if (failLength) throw new Error("length failed"); return base.length; },
    key: base.key,
    getItem: base.getItem,
    setItem: base.setItem,
    removeItem: base.removeItem,
  };
  const failingLocks = { request(_name, task) { failLength = true; return task(); } };
  assert.deepEqual(
    await journal.runWithExclusiveCurrentVocabSettingsWrite(entry, () => { calls += 1; }, { storage: failingStorage, locks: failingLocks }),
    { outcome: "blocked", reason: "storage" },
  );
  assert.equal(calls, 0);
});

test("exclusive settings commit admits only the exact sole valid ticket", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const target = await journal.persistVocabSettingsWrite(
    ticket("check", "vocab-settings-operation-exclusive-target"),
    { storage, locks },
  );
  const peer = journal.createVocabSettingsWriteEntry(
    ticket("check", "vocab-settings-operation-exclusive-peer"),
  );
  storage.setItem(peer.storageKey, peer.raw);
  let backendCalls = 0;
  assert.deepEqual(
    await journal.runWithExclusiveCurrentVocabSettingsWrite(
      target,
      () => { backendCalls += 1; },
      { storage, locks },
    ),
    { outcome: "blocked", reason: "peer" },
  );
  assert.equal(backendCalls, 0);

  storage.removeItem(peer.storageKey);
  storage.setItem(`${journal.VOCAB_SETTINGS_WRITE_PREFIX}damaged`, "{damaged");
  assert.deepEqual(
    await journal.runWithExclusiveCurrentVocabSettingsWrite(
      target,
      () => { backendCalls += 1; },
      { storage, locks },
    ),
    { outcome: "blocked", reason: "unreadable" },
  );
  assert.equal(backendCalls, 0);

  storage.removeItem(`${journal.VOCAB_SETTINGS_WRITE_PREFIX}damaged`);
  const unavailableStorage = {
    get length() { throw new Error("length failed"); },
    key: storage.key,
    getItem: storage.getItem,
    setItem: storage.setItem,
    removeItem: storage.removeItem,
  };
  assert.deepEqual(
    await journal.runWithExclusiveCurrentVocabSettingsWrite(
      target,
      () => { backendCalls += 1; },
      { storage: unavailableStorage, locks },
    ),
    { outcome: "blocked", reason: "storage" },
  );
  assert.equal(backendCalls, 0);

  const exact = await journal.runWithExclusiveCurrentVocabSettingsWrite(
    target,
    (lease) => {
      backendCalls += 1;
      lease.committed();
      return "saved";
    },
    { storage, locks },
  );
  assert.equal(exact.outcome, "ran");
  assert.equal(exact.entry.ticket.kind, "committed");
  assert.equal(backendCalls, 1);
});

test("raw CAS never removes a ticket advanced by a peer", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const original = await journal.persistVocabSettingsWrite(ticket(), { storage, locks });
  const advanced = await journal.runWithCurrentVocabSettingsWrite(original, (lease) => lease.committed(), { storage, locks });
  assert.equal(advanced.outcome, "ran");
  assert.deepEqual(
    await journal.runWithCurrentVocabSettingsWrite(original, (lease) => lease.remove(), { storage, locks }),
    { outcome: "stale" },
  );
  assert.equal(JSON.parse(storage.getItem(original.storageKey)).kind, "committed");
});

test("a durable peer is processed before a missing held receipt, which remains an inspect-only barrier", async () => {
  const outcomes = [
    ["check", "check"],
    ["expected", "check"],
    ["exact_saved", "committed"],
    ["changed", "changed"],
    ["invalid_receipt", "check"],
  ];
  for (const [inspection, finalKind] of outcomes) {
    const operationSuffix = inspection.replaceAll("_", "-");
    const operationId = `vocab-settings-operation-held-${operationSuffix}`;
    const held = journal.createVocabSettingsWriteEntry(
      ticket("committed", operationId),
    );
    const storage = memoryStorage();
    const locks = lockManager();
    const unrelated = await journal.persistVocabSettingsWrite(
      ticket("check", `vocab-settings-operation-unrelated-${operationSuffix}`),
      { storage, locks },
    );
    assert.equal(storage.getItem(held.storageKey), null, "the same-operation durable key starts missing");
    assert.strictEqual(
      journal.selectVocabSettingsWriteRecoveryEntry([held], [unrelated]),
      unrelated,
      "the durable peer is reachable while the operation-bound held receipt remains in memory",
    );
    assert.deepEqual(
      journal.vocabSettingsHeldReceiptBarrier(
        [operationId],
        [unrelated.ticket.receipt.operationId],
      ),
      { blocksWrites: true, volatile: true },
    );

    let inspectCalls = 0;
    assert.deepEqual(
      await journal.runWithMissingVocabSettingsWrite(
        held,
        () => { inspectCalls += 1; },
        { storage, locks },
      ),
      { outcome: "stale" },
    );
    assert.equal(inspectCalls, 0, "the held receipt cannot inspect around a durable peer");
    assert.equal(storage.getItem(unrelated.storageKey), unrelated.raw);
    const peerRemoval = await journal.runWithCurrentVocabSettingsWrite(
      unrelated,
      (lease) => lease.remove(),
      { storage, locks },
    );
    assert.equal(peerRemoval.outcome, "ran");
    assert.strictEqual(
      journal.selectVocabSettingsWriteRecoveryEntry([held], []),
      held,
      "after the peer settles, the original held receipt becomes reachable",
    );

    const result = await journal.runWithMissingVocabSettingsWrite(
      held,
      (lease) => {
        inspectCalls += 1;
        assert.equal(
          JSON.parse(storage.getItem(held.storageKey)).kind,
          "check",
          "the exact held receipt is checkpointed before inspect",
        );
        if (inspection === "exact_saved") lease.committed();
        else if (inspection === "changed") lease.changed();
        return inspection;
      },
      { storage, locks },
    );
    assert.equal(result.outcome, "ran");
    assert.equal(result.value, inspection);
    assert.equal(result.entry.ticket.kind, finalKind);
    assert.equal(inspectCalls, 1);
    assert.deepEqual(
      journal.vocabSettingsHeldReceiptBarrier(
        [operationId],
        [operationId, unrelated.ticket.receipt.operationId],
      ),
      { blocksWrites: true, volatile: false },
    );
  }

  const blockedHeld = journal.createVocabSettingsWriteEntry(
    ticket("changed", "vocab-settings-operation-held-unreadable"),
  );
  const unreadableStorage = memoryStorage([
    [`${journal.VOCAB_SETTINGS_WRITE_PREFIX}damaged`, "{damaged"],
  ]);
  let blockedInspectCalls = 0;
  assert.deepEqual(
    await journal.runWithMissingVocabSettingsWrite(
      blockedHeld,
      () => { blockedInspectCalls += 1; },
      { storage: unreadableStorage, locks: lockManager() },
    ),
    { outcome: "blocked", reason: "unreadable" },
  );
  assert.equal(blockedInspectCalls, 0);
  assert.equal(unreadableStorage.getItem(blockedHeld.storageKey), null);
  assert.deepEqual(
    journal.vocabSettingsHeldReceiptBarrier([], []),
    { blocksWrites: false, volatile: false },
    "only explicit settlement removes the held receipt barrier",
  );
});

test("E1-S-E2 retries only whole bundles and retains the exact second envelope", async () => {
  const settings = { chinese_explanation: false, font_scale: 1, line_height: 1.92, local_lock: true, auto_follow: true, daily_new_limit: 8 };
  const rows = ["chinese_explanation", "font_scale", "line_height", "local_lock", "auto_follow", "daily_new_limit"].map((key) => ({ key, value: String(settings[key]), updated_at: 10 }));
  const stableA = { generationId: "g-a", generationSequence: 3, rows: rows.map((row) => ({ ...row })), settings: { ...settings } };
  const replacement = { ...stableA, generationId: "g-b", generationSequence: 1 };
  const stableB = { ...replacement, rows: replacement.rows.map((row) => ({ ...row })), settings: { ...settings } };
  const expectedReads = [stableA, replacement, stableB, stableB];
  const trace = [];
  readHelpers.setLoaders(
    async () => { trace.push("S"); return { marker: trace.length, items: [], settings: { ...settings } }; },
    async () => { trace.push("E"); return expectedReads.shift(); },
  );
  const bundle = await readHelpers.loadVocabFactsWithSettingsExpected();
  assert.deepEqual(trace, ["E", "S", "E", "E", "S", "E"]);
  assert.strictEqual(bundle.expected, stableB);
  assert.strictEqual(bundle.snapshot.settings, stableB.settings);

  let reads = 0;
  readHelpers.setLoaders(
    async () => ({ items: [], settings: { ...settings } }),
    async () => ({ ...stableA, generationId: `moving-${reads++}` }),
  );
  await assert.rejects(() => readHelpers.loadVocabFactsWithSettingsExpected(), /持续变化/);
});

test("pointerup and blur claim one slider revision, while the next revision may flush", () => {
  const flushed = { current: null };
  assert.equal(flushHelpers.claimVocabSettingsDraftFlush(flushed, { revision: 4 }), true);
  assert.equal(flushHelpers.claimVocabSettingsDraftFlush(flushed, { revision: 4 }), false);
  assert.equal(flushHelpers.claimVocabSettingsDraftFlush(flushed, { revision: 5 }), true);
  assert.match(viewsSource, /onPointerUp:[\s\S]*?onDraftCommit\(event\.currentTarget\)[\s\S]*?onBlur:[\s\S]*?onDraftCommit\(event\.currentTarget\)/);
  assert.doesNotMatch(viewsSource, /type="range"[^>]*onChange=\{[^}]*onDraftCommit/);
});

test("safe settings writes are nonoptimistic, durable, inspect-only on uncertainty, and globally visible", () => {
  assert.doesNotMatch(appSource, /\bsaveSettings\b|\bchangeSettings\b/);
  const request = appSource.slice(appSource.indexOf("const requestSettingsSave"), appSource.indexOf("const submitSettingsDraft"));
  assert.match(request, /settingsExpectedRef\.current !== expected \|\| snapshotRef\.current\.settings !== expected\.settings/);
  assert.match(request, /prepareVocabSettingsSave\(next, expected\)/);
  assert.doesNotMatch(request, /loadVocabSettingsExpectedState|loadVocabSnapshot|setSnapshot\(/);
  const start = flowSource.slice(flowSource.indexOf("const start = useCallback"), flowSource.indexOf("const open = useCallback"));
  assert.ok(start.indexOf("heldEntriesRef.current.size > 0") < start.indexOf("await prepare()"));
  assert.ok(start.indexOf("await prepare()") < start.indexOf("await persistVocabSettingsWrite"));
  assert.ok(start.indexOf("await persistVocabSettingsWrite") < start.indexOf("commitEntry(entry"));
  const inspectLease = flowSource.slice(flowSource.indexOf("const inspectEntryWithLease"), flowSource.indexOf("const finishCommitted"));
  assert.match(inspectLease, /inspectVocabSettingsWrite/);
  assert.doesNotMatch(inspectLease, /commitVocabSettingsWrite/);
  const inspect = flowSource.slice(flowSource.indexOf("const inspect = useCallback"), flowSource.indexOf("const continueExpected = useCallback"));
  assert.match(inspect, /inspectEntryWithLease\(entry, false\)[\s\S]*?inspectEntryWithLease\(entry, true\)/);
  assert.doesNotMatch(inspect, /commitVocabSettingsWrite/);
  const commit = flowSource.slice(flowSource.indexOf("const commitEntry = useCallback"), flowSource.indexOf("const start = useCallback"));
  assert.match(commit, /runWithExclusiveCurrentVocabSettingsWrite/);
  assert.doesNotMatch(commit, /runWithCurrentVocabSettingsWrite/);
  assert.match(commit, /result\.reason === "peer"[\s\S]*?reopenLatest\(entry\)/);
  assert.match(appSource, /<VocabSettingsWriteBanner controller=\{settingsWrites\}/);
  assert.match(flowSource, /const writeLocked = !journal\.loaded \|\| journal\.storageUnavailable \|\| journal\.lockUnavailable/);
});

test("dirty settings defer a changed envelope whole and only an applied refresh clears a receipt", () => {
  const read = appSource.slice(appSource.indexOf("const readVocabFacts = useCallback"), appSource.indexOf("const readAndApplySnapshot"));
  const changed = read.slice(read.indexOf("if (settingsChanged)"), read.indexOf("const nextSnapshot"));
  assert.match(changed, /pendingSettingsBundleRef\.current = \{ requestId, bundle \}/);
  assert.match(changed, /return \{ outcome: "deferred", snapshot: snapshotRef\.current \}/);
  assert.doesNotMatch(changed, /setSnapshot\(|applyVocabFactsBundle/);
  const finish = flowSource.slice(flowSource.indexOf("const finishCommitted"), flowSource.indexOf("const commitEntry"));
  assert.ok(finish.indexOf("refreshOutcome = await refresh()") < finish.indexOf("const removal = await removeCurrent(entry)"));
  assert.match(finish, /if \(refreshOutcome !== "applied"\)/);
  assert.ok(finish.indexOf("const removal = await removeCurrent(entry)") < finish.indexOf("onDurableSettled?.(entry.ticket.receipt)"));
  assert.match(appSource, /pending && pending\.requestId === snapshotReadRequestRef\.current[\s\S]*?applyVocabFactsBundle\(pending\.bundle\)/);
});

test("privacy is fail-closed during every volatile or durable settings state", () => {
  const gate = appSource.slice(appSource.indexOf("const effectiveLocalLock"), appSource.indexOf("const updateSettingsDraft"));
  assert.match(gate, /vocabSettingsOutboundBlocked\([\s\S]*?snapshot\.settings\.local_lock[\s\S]*?journal\.loaded[\s\S]*?settingsWrites\.busy/);
  assert.match(gate, /journal\.storageUnavailable/);
  assert.match(gate, /journal\.unreadable\.length/);
  assert.match(gate, /journal\.entries\.length/);
  assert.doesNotMatch(gate, /journal\.lockUnavailable/);
  let outbound = 0;
  if (!flushHelpers.vocabSettingsOutboundBlocked(false, true, false, false, 0, 0, true)) outbound += 1;
  assert.equal(outbound, 0, "a synchronously claimed operation blocks outbound work before React rerenders");
  assert.equal(flushHelpers.vocabSettingsOutboundBlocked(false, false, false, false, 0, 0), true);
  assert.equal(
    flushHelpers.vocabSettingsOutboundBlocked(false, true, false, false, 0, 0, false, true),
    true,
    "a stale/deferred whole bundle blocks outbound even while the displayed lock is false",
  );
  assert.equal(
    flushHelpers.vocabSettingsOutboundBlocked(false, true, false, false, 0, 0, false, false, true),
    true,
    "a claimed restore remains an independent outbound latch",
  );
  assert.match(gate, /snapshotReadStatus !== "ready"/);
  const changedRead = appSource.slice(
    appSource.indexOf("if (settingsChanged)"),
    appSource.indexOf("const nextSnapshot"),
  );
  assert.match(changedRead, /blockOutboundForUntrustedFacts\(\)/);
  assert.match(changedRead, /setSettingsExternalPending\(true\)/);
  assert.match(appSource, /subscribeVocabChanges\(\(\) => \{\s*blockOutboundForUntrustedFacts\(\)/);
  assert.match(appSource, /const claimRestoreOutboundBarrier[\s\S]*?restoreOutboundBarrierRef\.current = true[\s\S]*?signalVocabOutboundBlock\(\)/);
  assert.match(appSource, /const refreshTrustedCurrentAfterRestore[\s\S]*?initializeVocabDatabase[\s\S]*?result\.outcome !== "applied"[\s\S]*?releaseRestoreOutboundBarrier\(\)/);
  assert.match(appSource, /signalVocabOutboundBlock\(\)/);
  assert.match(overlaysSource, /subscribeVocabOutboundBlock[\s\S]*?healthOperation\.current\?\.abort[\s\S]*?operation\.current\?\.abort/);
  assert.match(viewsSource, /subscribeVocabOutboundBlock[\s\S]*?player\.pause\(\)[\s\S]*?removeAttribute\("src"\)/);
  assert.match(appSource, /if \(effectiveLocalLock\) aiRequest\.current\?\.controller\.abort\(\)/);
  assert.equal((appSource.match(/if \(settingsOutboundBlocked\(\)\)/g) ?? []).length >= 3, true);
  assert.match(appSource, /<PodcastView[\s\S]*?localLock=\{effectiveLocalLock\}/);
  assert.match(appSource, /<ImportWizard localLock=\{effectiveLocalLock\}/);
  assert.match(viewsSource, /disabled=\{busy\|\|settingsWriteLocked\|\|settingsWriteBusy\|\|settings\.local_lock\}/);
});

test("ImportWizard gates every external request synchronously and aborts when the lock turns on", () => {
  let outbound = 0;
  const attempt = (locked, signal) => {
    importPrivacyHelpers.assertVocabExternalImportAllowed(locked, signal, "locked");
    outbound += 1;
  };
  assert.throws(() => attempt(true, new AbortController().signal), /locked/);
  assert.equal(outbound, 0);
  const stopped = new AbortController();
  stopped.abort(new importPrivacyHelpers.VocabLocalLockImportError("stopped"));
  assert.throws(() => attempt(false, stopped.signal), /stopped/);
  assert.equal(outbound, 0);

  const health = overlaysSource.slice(
    overlaysSource.indexOf("healthOperation.current?.abort();"),
    overlaysSource.indexOf("}, [localLock]);", overlaysSource.indexOf("healthOperation.current?.abort();")),
  );
  assert.ok(health.indexOf("if (localLock)") < health.indexOf('fetch("/api/health"'));
  assert.match(health, /operation\.current[\s\S]*?active\.abort\(new VocabLocalLockImportError\(\)\)/);

  const submit = overlaysSource.slice(overlaysSource.indexOf("const submit = async"), overlaysSource.indexOf("const importEpisode = async"));
  for (const request of ['postJson("/api/import/article"', 'postJson("/api/import/rss"', 'fetch("/api/transcribe"']) {
    const requestAt = submit.indexOf(request);
    assert.ok(requestAt > 0);
    assert.ok(submit.lastIndexOf("assertVocabExternalImportAllowed", requestAt) >= 0);
  }
  const episode = overlaysSource.slice(overlaysSource.indexOf("const importEpisode = async"), overlaysSource.indexOf("const inspectRecovery = async"));
  const transcriptRequest = episode.indexOf('postJson(\n            "/api/import/rss"');
  assert.ok(transcriptRequest > 0);
  assert.ok(episode.indexOf("assertVocabExternalImportAllowed") < transcriptRequest);
  assert.match(episode, /kind: "transcript"/);
  assert.doesNotMatch(episode, /postJson\([\s\S]*?"\/api\/import\/article"/);
  assert.match(episode, /controller\.signal\.aborted \|\| isVocabLocalLockImportError\(caught\)/);
  assert.equal((overlaysSource.match(/fetch\("\/api\/health"/g) ?? []).length, 1);
  assert.equal((overlaysSource.match(/没有继续发送内容/g) ?? []).length >= 1, true);
});

test("only busy work, a volatile held receipt, or an unsaved slider draft blocks unload", () => {
  const unload = flowSource.slice(flowSource.indexOf("useEffect(() => {\n    if (!busy && !hasVolatileHeldReceipt)"), flowSource.indexOf("const setSafelyIdle"));
  assert.match(unload, /if \(!busy && !hasVolatileHeldReceipt\) return/);
  assert.doesNotMatch(unload, /journal\.entries|journal\.unreadable/);
  assert.match(flowSource, /event\.key === null \|\| event\.key\.startsWith\(VOCAB_SETTINGS_WRITE_PREFIX\)/);
  assert.match(flowSource, /const refreshCommitted = inspect;/);
  assert.match(flowSource, /hasHeldReceipt,\s*hasVolatileHeldReceipt,\s*writeLocked/);
  const reopen = flowSource.slice(flowSource.indexOf("const reopenLatest"), flowSource.indexOf("const removeCurrent"));
  assert.match(reopen, /selectVocabSettingsWriteRecoveryEntry/);
  assert.doesNotMatch(reopen, /latestJournal\.entries\[0\]/);
  assert.match(appSource, /if \(!settingsDraft\) return;[\s\S]*?beforeunload/);
  assert.match(
    viewsSource,
    /VocabBackupFlow controlsDisabled=\{busy \|\| settingsWriteLocked \|\| settingsWriteBusy \|\| databaseMutationLocked\}/,
  );
  assert.match(uiSource, /disabled=\{disabled\}/);
});

test("background journal reloads stay passive while foreground recovery owns focus", async () => {
  const effect = flowSource.slice(
    flowSource.indexOf("useEffect(() => {\n    mounted.current = true;"),
    flowSource.indexOf("useEffect(() => {\n    if (!busy && !hasVolatileHeldReceipt)"),
  );
  const handlers = effect.slice(
    effect.indexOf("const onStorage"),
    effect.indexOf('window.addEventListener("storage"'),
  );
  assert.match(handlers, /reloadJournal\(\)/);
  assert.doesNotMatch(handlers, /setFocusRequest|onAttention|showAttention|setFlow|open\(/);
  const executable = transpile(`
let reloads = 0;
let focusRequests = 0;
let attentionRequests = 0;
let opens = 0;
let flowChanges = 0;
const reloadJournal = () => { reloads += 1; };
const setFocusRequest = () => { focusRequests += 1; };
const onAttention = () => { attentionRequests += 1; };
const showAttention = () => { attentionRequests += 1; };
const open = () => { opens += 1; };
const setFlow = () => { flowChanges += 1; };
const window = { localStorage: {} };
const document = { visibilityState: "visible" };
${handlers}
onStorage({ storageArea: window.localStorage, key: null });
onFocus();
onVisibility();
export { reloads, focusRequests, attentionRequests, opens, flowChanges };
`, "vocab-settings-background-reload-contract.ts");
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(executable).toString("base64")}`);
  assert.equal(runtime.reloads, 3);
  assert.equal(runtime.focusRequests, 0);
  assert.equal(runtime.attentionRequests, 0);
  assert.equal(runtime.opens, 0);
  assert.equal(runtime.flowChanges, 0);

  const dismiss = flowSource.slice(
    flowSource.indexOf("const dismissInvalid = useCallback"),
    flowSource.indexOf("const clearUnreadable = useCallback"),
  );
  assert.match(dismiss, /catch \(reason\)[\s\S]*?phase: "invalid"/);
});
