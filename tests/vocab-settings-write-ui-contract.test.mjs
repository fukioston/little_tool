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
  const running = journal.runWithCurrentVocabSettingsWrite(first, async (lease) => {
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
    await journal.runWithCurrentVocabSettingsWrite(entry, () => { calls += 1; }, { storage: base, locks: peerLocks }),
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
    await journal.runWithCurrentVocabSettingsWrite(entry, () => { calls += 1; }, { storage: failingStorage, locks: failingLocks }),
    { outcome: "blocked", reason: "storage" },
  );
  assert.equal(calls, 0);
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

test("E1-S-E2 retries only whole bundles and retains the exact second envelope", async () => {
  const settings = { chinese_explanation: false, font_scale: 1, line_height: 1.92, local_lock: true, auto_follow: true, daily_new_limit: 8 };
  const rows = ["chinese_explanation", "font_scale", "line_height", "local_lock", "auto_follow", "daily_new_limit"].map((key) => ({ key, value: String(settings[key]), updated_at: 10 }));
  const stableA = { generationId: "g-a", generationSequence: 3, rows: rows.map((row) => ({ ...row })), settings: { ...settings } };
  const replacement = { ...stableA, generationId: "g-b", generationSequence: 1 };
  const stableB = { ...replacement, rows: replacement.rows.map((row) => ({ ...row })), settings: { ...settings } };
  const expectedReads = [stableA, replacement, stableB, stableB];
  const trace = [];
  readHelpers.setLoaders(
    async () => { trace.push("S"); return { marker: trace.length, settings: { ...settings } }; },
    async () => { trace.push("E"); return expectedReads.shift(); },
  );
  const bundle = await readHelpers.loadVocabFactsWithSettingsExpected();
  assert.deepEqual(trace, ["E", "S", "E", "E", "S", "E"]);
  assert.strictEqual(bundle.expected, stableB);
  assert.strictEqual(bundle.snapshot.settings, stableB.settings);

  let reads = 0;
  readHelpers.setLoaders(
    async () => ({ settings: { ...settings } }),
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
  assert.ok(start.indexOf("await prepare()") < start.indexOf("await persistVocabSettingsWrite"));
  assert.ok(start.indexOf("await persistVocabSettingsWrite") < start.indexOf("commitEntry(entry"));
  const inspect = flowSource.slice(flowSource.indexOf("const inspect = useCallback"), flowSource.indexOf("const continueExpected = useCallback"));
  assert.match(inspect, /inspectVocabSettingsWrite/);
  assert.doesNotMatch(inspect, /commitVocabSettingsWrite/);
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
  assert.ok(episode.indexOf("assertVocabExternalImportAllowed") < episode.indexOf('postJson(\n            "/api/import/article"'));
  assert.match(episode, /controller\.signal\.aborted \|\| isVocabLocalLockImportError\(caught\)/);
  assert.equal((overlaysSource.match(/fetch\("\/api\/health"/g) ?? []).length, 1);
  assert.equal((overlaysSource.match(/没有继续发送内容/g) ?? []).length >= 1, true);
});

test("only volatile work or an unsaved slider draft blocks unload and backup activation", () => {
  const unload = flowSource.slice(flowSource.indexOf("useEffect(() => {\n    if (!busy)"), flowSource.indexOf("const reopenLatest"));
  assert.match(unload, /if \(!busy\) return/);
  assert.doesNotMatch(unload, /journal\.entries|journal\.unreadable/);
  assert.match(appSource, /if \(!settingsDraft\) return;[\s\S]*?beforeunload/);
  assert.match(viewsSource, /VocabBackupFlow controlsDisabled=\{busy \|\| settingsWriteLocked \|\| settingsWriteBusy\}/);
  assert.match(uiSource, /disabled=\{disabled\}/);
});
