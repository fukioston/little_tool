import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const journalUrl = new URL("app/fitness/config-write-journal.ts", projectRoot);
const flowUrl = new URL("app/fitness/FitnessConfigWriteFlow.tsx", projectRoot);
const appUrl = new URL("app/fitness/FitnessApp.tsx", projectRoot);
const formsUrl = new URL("app/fitness/forms.tsx", projectRoot);
const cssUrl = new URL("app/fitness/fitness.css", projectRoot);

const [journalSource, flowSource, appSource, formsSource, css] = await Promise.all([
  readFile(journalUrl, "utf8"),
  readFile(flowUrl, "utf8"),
  readFile(appUrl, "utf8"),
  readFile(formsUrl, "utf8"),
  readFile(cssUrl, "utf8"),
]);

const transpiled = ts.transpileModule(journalSource, {
  fileName: journalUrl.pathname,
  reportDiagnostics: true,
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true,
  },
});
assert.deepEqual(
  (transpiled.diagnostics ?? []).filter(({ category }) => category === ts.DiagnosticCategory.Error),
  [],
);
const executableJournal = transpiled.outputText.replace(
  /import \{ isFitnessConfigWriteReceipt, \} from "@\/lib\/fitness\/store";/,
  "const isFitnessConfigWriteReceipt = (value) => Boolean(value && typeof value === 'object' && /^fitness-operation-[a-z0-9-]+$/.test(value.operationId));",
);
const journal = await import(
  `data:text/javascript;base64,${Buffer.from(executableJournal).toString("base64")}`
);

const draftHelpersSource = flowSource.slice(
  flowSource.indexOf("const displayValue ="),
  flowSource.indexOf("function FitnessConfigReceiptDraft"),
);
const draftHelpersTranspiled = ts.transpileModule(`
const getFitnessExercise = (id) => id === "bodyweight-squat"
  ? { name_zh: "徒手深蹲", name_en: "Bodyweight squat" }
  : null;
${draftHelpersSource}
export { fitnessConfigReceiptDraftText };`, {
  fileName: "fitness-config-receipt-draft.ts",
  reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
assert.deepEqual(
  (draftHelpersTranspiled.diagnostics ?? []).filter(({ category }) => category === ts.DiagnosticCategory.Error),
  [],
);
const { fitnessConfigReceiptDraftText } = await import(
  `data:text/javascript;base64,${Buffer.from(draftHelpersTranspiled.outputText).toString("base64")}`
);

const settingsReadHelpersSource = appSource.slice(
  appSource.indexOf("function sameFitnessSettings("),
  appSource.indexOf("function liveDraftFactsChanged"),
);
const settingsReadHelpersTranspiled = ts.transpileModule(`
let loadFitnessSnapshot;
let loadFitnessSettingsExpectedState;
${settingsReadHelpersSource}
function setFitnessSettingsReadLoaders(loadFacts, loadExpected) {
  loadFitnessSnapshot = loadFacts;
  loadFitnessSettingsExpectedState = loadExpected;
}
export { loadFitnessFactsWithSettingsExpected, sameFitnessSettingsExpectedState, setFitnessSettingsReadLoaders };`, {
  fileName: "fitness-settings-read-bundle.ts",
  reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
assert.deepEqual(
  (settingsReadHelpersTranspiled.diagnostics ?? []).filter(({ category }) => category === ts.DiagnosticCategory.Error),
  [],
);
const settingsRead = await import(
  `data:text/javascript;base64,${Buffer.from(settingsReadHelpersTranspiled.outputText).toString("base64")}`
);

function receipt(operationId = "fitness-operation-ui-contract-a") {
  return { operationId };
}

function ticket(kind = "check", operationId) {
  return {
    version: 1,
    kind,
    receipt: receipt(operationId),
    recordedAt: "2026-08-22T03:04:05.000Z",
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

test("config tickets are exact, bounded, verified after persistence, and independently locked", () => {
  const valid = ticket();
  assert.equal(journal.isFitnessConfigWriteTicket(valid), true);
  assert.equal(journal.isFitnessConfigWriteTicket({ ...valid, extra: true }), false);
  assert.equal(journal.isFitnessConfigWriteTicket({ ...valid, recordedAt: "not-a-date" }), false);
  assert.match(journalSource, /FITNESS_CONFIG_WRITE_MAX_CHARS = 1024 \* 1024/);
  assert.match(journalSource, /storage\.setItem\(storageKey, raw\);\s*if \(storage\.getItem\(storageKey\) !== raw\)/);
  assert.match(journalSource, /FITNESS_CONFIG_WRITE_JOURNAL_LOCK = "fitness-config-write-journal"/);
  assert.match(journalSource, /manager\.request\(FITNESS_CONFIG_WRITE_JOURNAL_LOCK, operation\)/);
  assert.match(journalSource, /if \(!locks\) \{\s*throw new Error/);
});

test("raw-CAS refuses an old discard after a peer advances the same ticket", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const original = journal.persistFitnessConfigWriteToStorage(storage, ticket());
  const peerMayAdvance = deferred();

  const staleTab = (async () => {
    await peerMayAdvance.promise;
    return journal.runWithCurrentFitnessConfigWrite(
      original,
      (lease) => lease.remove(),
      { storage, locks },
    );
  })();
  const peer = await journal.runWithCurrentFitnessConfigWrite(
    original,
    (lease) => lease.committed(),
    { storage, locks },
  );
  assert.equal(peer.outcome, "ran");
  assert.equal(peer.entry.ticket.kind, "committed");
  peerMayAdvance.resolve();

  const stale = await staleTab;
  assert.deepEqual(stale, { outcome: "stale" });
  const currentRaw = storage.getItem(original.storageKey);
  assert.notEqual(currentRaw, null);
  assert.equal(JSON.parse(currentRaw).kind, "committed");
});

test("the global journal lock serializes different receipt keys across backend callbacks", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const first = journal.persistFitnessConfigWriteToStorage(
    storage,
    ticket("check", "fitness-operation-global-lock-a"),
  );
  const second = journal.persistFitnessConfigWriteToStorage(
    storage,
    ticket("check", "fitness-operation-global-lock-b"),
  );
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let secondCallbacks = 0;
  const firstRun = journal.runWithCurrentFitnessConfigWrite(first, async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  }, { storage, locks });
  await firstStarted.promise;
  const secondRun = journal.runWithCurrentFitnessConfigWrite(second, () => {
    secondCallbacks += 1;
  }, { storage, locks });
  await Promise.resolve();
  assert.equal(secondCallbacks, 0, "a different receipt key must wait behind the global journal lease");
  releaseFirst.resolve();
  assert.equal((await firstRun).outcome, "ran");
  assert.equal((await secondRun).outcome, "ran");
  assert.equal(secondCallbacks, 1);
  assert.match(journalSource, /persistFitnessConfigWrite[\s\S]*return withJournalLock\(\(\) =>/);
});

test("the in-lock durable gate blocks callbacks when a peer appears after precheck", async () => {
  const storage = memoryStorage();
  const original = journal.persistFitnessConfigWriteToStorage(
    storage,
    ticket("check", "fitness-operation-ui-contract-gate"),
  );
  const lockAcquired = deferred();
  let backendCalls = 0;
  const locks = {
    async request(_name, task) {
      await lockAcquired.promise;
      storage.setItem(`${journal.FITNESS_CONFIG_WRITE_PREFIX}peer-damaged`, "{damaged");
      return task();
    },
  };
  const run = journal.runWithCurrentFitnessConfigWrite(
    original,
    () => { backendCalls += 1; },
    { storage, locks },
  );
  assert.equal(backendCalls, 0);
  lockAcquired.resolve();
  assert.deepEqual(await run, { outcome: "blocked", reason: "unreadable" });
  assert.equal(backendCalls, 0);
});

test("the in-lock durable gate treats a dynamic journal read failure as unavailable", async () => {
  const base = memoryStorage();
  const original = journal.persistFitnessConfigWriteToStorage(
    base,
    ticket("check", "fitness-operation-ui-contract-length"),
  );
  let failLength = false;
  const storage = {
    get length() {
      if (failLength) throw new Error("length unavailable");
      return base.length;
    },
    key: base.key,
    getItem: base.getItem,
    setItem: base.setItem,
    removeItem: base.removeItem,
  };
  let backendCalls = 0;
  const locks = {
    request(_name, task) {
      failLength = true;
      return task();
    },
  };
  const result = await journal.runWithCurrentFitnessConfigWrite(
    original,
    () => { backendCalls += 1; },
    { storage, locks },
  );
  assert.deepEqual(result, { outcome: "blocked", reason: "unavailable" });
  assert.equal(backendCalls, 0);
  assert.notEqual(base.getItem(original.storageKey), null);
});

test("damaged peers remain visible and cannot hide valid config tickets", () => {
  const valid = ticket("check", "fitness-operation-ui-contract-b");
  const key = journal.fitnessConfigWriteKey(valid);
  const damagedKey = `${journal.FITNESS_CONFIG_WRITE_PREFIX}damaged`;
  const result = journal.readFitnessConfigWriteJournal(memoryStorage([
    [damagedKey, "{damaged"],
    [key, JSON.stringify(valid)],
  ]));
  assert.equal(result.unavailable, false);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.unreadable, [{ storageKey: damagedKey, raw: "{damaged" }]);
});

test("all nine config mutations use frozen safe prepare APIs and no legacy write call", () => {
  for (const name of [
    "prepareFitnessSettingsSave",
    "prepareFitnessProfileSave",
    "prepareFitnessVenueSave",
    "prepareFitnessVenueArchive",
    "prepareFitnessVenueRestore",
    "prepareFitnessEquipmentSave",
    "prepareFitnessEquipmentStatus",
    "prepareFitnessConstraintSave",
    "prepareFitnessConstraintActive",
  ]) assert.match(appSource, new RegExp(`\\b${name}\\b`));

  for (const name of [
    "saveFitnessSettings",
    "saveFitnessProfile",
    "saveVenue",
    "archiveVenue",
    "restoreVenue",
    "saveEquipmentWithLoads",
    "setEquipmentStatus",
    "saveConstraint",
    "setFitnessConstraintActive",
  ]) assert.doesNotMatch(appSource, new RegExp(`\\b${name}\\b`));
});

test("settings facts use an executable E1-facts-E2 bundle and retain the exact second envelope", async () => {
  const value = { unit: "kg", rest_timer_enabled: true, sound_enabled: false, ai_enabled: true };
  const rows = [
    { key: "unit", value: "kg", updated_at: 10 },
    { key: "rest_timer_enabled", value: "true", updated_at: 10 },
    { key: "sound_enabled", value: "false", updated_at: 10 },
    { key: "ai_enabled", value: "true", updated_at: 10 },
  ];
  const first = { generationId: "generation-a", generationSequence: 4, rows: rows.map((row) => ({ ...row })), settings: { ...value } };
  const second = { generationId: "generation-a", generationSequence: 4, rows: rows.map((row) => ({ ...row })), settings: { ...value } };
  const trace = [];
  let expectedRead = 0;
  settingsRead.setFitnessSettingsReadLoaders(
    async () => { trace.push("facts"); return { marker: "facts-a", settings: { ...value } }; },
    async () => { trace.push(`expected-${expectedRead + 1}`); return [first, second][expectedRead++]; },
  );
  const bundle = await settingsRead.loadFitnessFactsWithSettingsExpected();
  assert.deepEqual(trace, ["expected-1", "facts", "expected-2"]);
  assert.strictEqual(bundle.expected, second);
  assert.strictEqual(bundle.snapshot.settings, second.settings);
  assert.equal(bundle.snapshot.marker, "facts-a");

  const generationReplacement = { ...second, generationId: "generation-b", generationSequence: 1 };
  let replacementRead = 0;
  settingsRead.setFitnessSettingsReadLoaders(
    async () => ({ settings: { ...value } }),
    async () => [first, generationReplacement][replacementRead++],
  );
  await assert.rejects(() => settingsRead.loadFitnessFactsWithSettingsExpected(), /没有拼接新旧页面资料/);

  const changedRows = { ...second, rows: second.rows.map((row, index) => index === 2 ? { ...row, updated_at: 11 } : row) };
  let rowRead = 0;
  settingsRead.setFitnessSettingsReadLoaders(
    async () => ({ settings: { ...value } }),
    async () => [first, changedRows][rowRead++],
  );
  await assert.rejects(() => settingsRead.loadFitnessFactsWithSettingsExpected(), /没有拼接新旧页面资料/);

  let mismatchRead = 0;
  settingsRead.setFitnessSettingsReadLoaders(
    async () => ({ settings: { ...value, ai_enabled: false } }),
    async () => [first, second][mismatchRead++],
  );
  await assert.rejects(() => settingsRead.loadFitnessFactsWithSettingsExpected(), /没有拼接新旧页面资料/);
  settingsRead.setFitnessSettingsReadLoaders(
    async () => { throw new Error("facts unavailable"); },
    async () => first,
  );
  await assert.rejects(() => settingsRead.loadFitnessFactsWithSettingsExpected(), /facts unavailable/);
});

test("all nine durable receipts expose complete calm user content without technical guards", () => {
  const profile = { goals: ["strength"], experience: "new", resistance_days_per_week: 3, cardio_days_per_week: 1, session_minutes: 60, split: "auto", preferred_weekdays: [1, 3], preferred_rir: 3, rest_seconds: 90, unit: "kg", notes: "慢慢开始" };
  const venue = { name: "楼下", venue_type: "commercial", location: "二层", area_notes: "靠窗", busy_notes: "晚间忙", default_session_minutes: 55, supersets_allowed: false, is_default: true, last_verified_at: 1_787_300_000_000, status: "active" };
  const equipment = { name: "哑铃", kind: "dumbbell", area: "自由重量区", quantity: 2, status: "available", load_mode: "discrete", load_semantics: "per_hand", min_load_grams: 5000, max_load_grams: 7500, increment_grams: null, bar_weight_grams: null, unilateral: true, busy_level: "medium", attachments: ["防滑套"], notes: "握距自然" };
  const constraint = { label: "右膝", body_area: "膝", severity: "avoid", movement_patterns: ["squat"], exercise_ids: ["bodyweight-squat", "legacy-unknown-action"], note: "先减小幅度", active: true };
  const receipts = [
    { kind: "profile-save", after: profile },
    { kind: "venue-save", after: venue, defaultResets: [{ before: { name: "旧场地" } }] },
    { kind: "venue-archive", after: venue, programs: [{ before: {} }], events: [{ before: {} }] },
    { kind: "venue-restore", after: venue },
    { kind: "equipment-save", after: { equipment, loads: [{ label: "5 kg", load_grams: 5000, quantity: 2, available: true }] }, venue },
    { kind: "equipment-status", before: { ...equipment, status: "available" }, after: { ...equipment, status: "maintenance" } },
    { kind: "constraint-save", after: constraint },
    { kind: "constraint-active", before: { ...constraint, active: false }, after: constraint },
    {
      kind: "settings-save",
      before: { rows: [null, null, null, null], settings: { unit: "kg", rest_timer_enabled: true, sound_enabled: true, ai_enabled: false } },
      after: {
        rows: [
          { key: "unit", value: "lb", updated_at: 1_787_300_000_000 },
          { key: "rest_timer_enabled", value: "false", updated_at: 1_787_300_000_000 },
          { key: "sound_enabled", value: "true", updated_at: 1_787_300_000_000 },
          { key: "ai_enabled", value: "true", updated_at: 1_787_300_000_000 },
        ],
        settings: { unit: "lb", rest_timer_enabled: false, sound_enabled: true, ai_enabled: true },
      },
    },
  ];
  const requiredUserFacts = [
    ["训练偏好", "慢慢开始"],
    ["场地", "旧场地"],
    ["归档场地", "1 条"],
    ["恢复场地", "楼下"],
    ["器材与重量档位", "5 kg × 2"],
    ["器材状态", "临时停用"],
    ["身体边界", "先减小幅度", "徒手深蹲（Bodyweight squat）", "当前版本不识别的动作标识：legacy-unknown-action"],
    ["身体边界状态", "生效中", "徒手深蹲（Bodyweight squat）", "当前版本不识别的动作标识：legacy-unknown-action"],
    ["本地设置", "重量单位：磅（lb）", "休息计时器：关闭", "提示音：开启", "允许 AI 草稿：开启"],
  ];
  receipts.forEach((value, index) => {
    const text = fitnessConfigReceiptDraftText({
      purpose: "fitness-config-write",
      version: 1,
      operationId: "fitness-operation-secret",
      generationId: "generation-secret",
      generationSequence: 987654,
      projectionSha256: "projection-secret",
      hash: "sha-secret",
      ...value,
    });
    for (const fact of requiredUserFacts[index]) assert.match(text, new RegExp(fact));
    assert.doesNotMatch(text, /fitness-operation-secret|generation-secret|987654|projection-secret|sha-secret/i);
    if (value.kind === "settings-save") assert.doesNotMatch(text, /updated_at|1787300000000|\brows\b/);
  });
});

test("prepare is zero-journal until it succeeds, then durable receipt precedes commit", () => {
  const start = flowSource.slice(
    flowSource.indexOf("const start = useCallback"),
    flowSource.indexOf("const open = useCallback"),
  );
  const prepareAt = start.indexOf("await prepare()");
  const persistAt = start.indexOf("await persistFitnessConfigWrite");
  const commitAt = start.indexOf("commitEntry(entry");
  assert.ok(prepareAt >= 0 && persistAt > prepareAt && commitAt > persistAt);
  assert.match(start, /if \(entry\) \{[\s\S]*收据仍保留/);
});

test("response loss is inspect-only, changed is refresh-only, and peer unreadable state fails closed", () => {
  const inspect = flowSource.slice(
    flowSource.indexOf("const inspect = useCallback"),
    flowSource.indexOf("const continueExpected = useCallback"),
  );
  assert.match(inspect, /inspectFitnessConfigWrite/);
  assert.doesNotMatch(inspect, /commitFitnessConfigWrite/);

  const refreshChanged = flowSource.slice(
    flowSource.indexOf("const refreshChanged = useCallback"),
    flowSource.indexOf("const dismissReminder = useCallback"),
  );
  assert.match(refreshChanged, /await refresh\(\)/);
  assert.doesNotMatch(refreshChanged, /(inspect|commit)FitnessConfigWrite/);

  assert.equal((flowSource.match(/currentJournal\.unavailable \|\| currentJournal\.unreadable\.length > 0/g) ?? []).length, 2);
  const listeners = flowSource.slice(
    flowSource.indexOf("const onStorage ="),
    flowSource.indexOf("useEffect(() => {\n    if (!busy)"),
  );
  assert.match(listeners, /reloadJournal\(\)/);
  assert.doesNotMatch(listeners, /(inspect|commit)FitnessConfigWrite/);
});

test("only a newest complete settings bundle is applied, deferred, or later consumed as one unit", () => {
  const loader = appSource.slice(
    appSource.indexOf("async function loadFitnessFactsWithSettingsExpected"),
    appSource.indexOf("function liveDraftFactsChanged"),
  );
  const firstExpected = loader.indexOf("const expectedBefore = await loadFitnessSettingsExpectedState()");
  const facts = loader.indexOf("const facts = await loadFitnessSnapshot()");
  const secondExpected = loader.indexOf("const expectedAfter = await loadFitnessSettingsExpectedState()", firstExpected + 1);
  assert.ok(firstExpected >= 0 && firstExpected < facts && facts < secondExpected);
  assert.match(loader, /sameFitnessSettingsExpectedState\(expectedBefore, expectedAfter\)/);
  assert.match(loader, /sameFitnessSettings\(facts\.settings, expectedAfter\.settings\)/);
  assert.match(loader, /snapshot: \{ \.\.\.facts, settings: expectedAfter\.settings \},\s*expected: expectedAfter/);

  const apply = appSource.slice(
    appSource.indexOf("const applyFitnessSnapshot = useCallback"),
    appSource.indexOf("const readFitnessFacts = useCallback"),
  );
  assert.match(apply, /snapshotRef\.current = next\.snapshot/);
  assert.match(apply, /settingsExpectedRef\.current = next\.expected/);
  assert.match(apply, /setSnapshot\(next\.snapshot\)/);
  assert.match(apply, /setSettingsExpected\(next\.expected\)/);

  const read = appSource.slice(
    appSource.indexOf("const readFitnessFacts = useCallback"),
    appSource.indexOf("const refresh = useCallback"),
  );
  assert.ok(read.indexOf("const next = await loadFitnessFactsWithSettingsExpected()") < read.indexOf("resolveFitnessFactsRead("));
  assert.ok(read.indexOf('if (outcome === "superseded") return outcome') < read.indexOf("applyFitnessSnapshot(next)"));
  assert.match(read, /if \(outcome === "deferred"\) \{[\s\S]*?pendingLiveSnapshotRef\.current = next;[\s\S]*?return outcome/);
  assert.match(appSource, /const pendingLiveSnapshotRef = useRef<FitnessFactsReadBundle \| null>/);
  assert.equal((appSource.match(/if \(pending\) applyFitnessSnapshot\(pending\)/g) ?? []).length, 2);

  const initial = appSource.slice(
    appSource.indexOf("await initializeFitnessDatabase()"),
    appSource.indexOf("useEffect(() => subscribeFitnessChanges"),
  );
  assert.match(initial, /await readFitnessFacts\(\)/);
  assert.doesNotMatch(initial, /await loadFitnessSnapshot\(\)/);
});

test("settings switch submits its rendered envelope once and every unsafe pre-ticket outcome locks stale", () => {
  const save = appSource.slice(
    appSource.indexOf("const saveFitnessSettingsSafely"),
    appSource.indexOf("const openLiveRecovery"),
  );
  assert.match(save, /settingsExpectedRef\.current !== expected \|\| snapshotRef\.current\.settings !== expected\.settings/);
  assert.match(save, /configWrites\.start\([\s\S]*?prepareFitnessSettingsSave\(next, expected\)/);
  assert.doesNotMatch(save, /loadFitnessSettingsExpectedState|loadFitnessSnapshot/);
  assert.match(save, /reason instanceof FitnessConfigMutationError && reason\.code === "changed"/);
  assert.match(save, /setSnapshotReadStatus\("stale"\)/);
  assert.match(save, /没有确认安全收据是否完整保留/);

  const view = appSource.slice(
    appSource.indexOf("function SettingsView"),
    appSource.indexOf("function PlanDraftPreview"),
  );
  assert.match(view, /const settingsBound = expected !== null && settings === expected\.settings/);
  assert.match(view, /snapshotReadStatus !== "ready" \|\| !settingsBound \|\| configWriteLocked/);
  assert.match(view, /role="switch"[\s\S]*?disabled=\{disabled\}/);
  assert.match(view, /role="status">\{settingsWriteStatus\}/);
  assert.match(appSource, /expected=\{settingsExpected\}[\s\S]*?configWriteLocked=\{configWrites\.writeLocked\}/);
  assert.match(flowSource, /新的本地设置、偏好、场地、器材和身体边界改动先停用/);
});

test("settings response loss remains inspect-only and settles focus only after applied refresh and ticket removal", () => {
  const inspect = flowSource.slice(
    flowSource.indexOf("const inspect = useCallback"),
    flowSource.indexOf("const continueExpected = useCallback"),
  );
  assert.match(inspect, /inspectFitnessConfigWrite/);
  assert.doesNotMatch(inspect, /commitFitnessConfigWrite/);

  const finish = flowSource.slice(
    flowSource.indexOf("const finishCommitted"),
    flowSource.indexOf("const commitEntry"),
  );
  assert.ok(finish.indexOf("await refresh()") < finish.indexOf("const removal = await removeCurrent(entry)"));
  assert.ok(finish.indexOf("const removal = await removeCurrent(entry)") < finish.indexOf("onDurableSettled?.(entry.ticket.receipt)"));

  const prepared = appSource.slice(
    appSource.indexOf("const rememberPreparedConfigDialog"),
    appSource.indexOf("const configWrites = useFitnessConfigWriteFlow"),
  );
  assert.match(prepared, /receipt\.kind === "settings-save"[\s\S]*?operationId: receipt\.operationId, trigger/);
  const focus = appSource.slice(
    appSource.indexOf("const settleConfigWriteFocus"),
    appSource.indexOf("const configWrites = useFitnessConfigWriteFlow"),
  );
  assert.match(focus, /submitted\.operationId !== receipt\.operationId/);
  assert.match(focus, /activeDialog\.current === "config-recovery"\) setDialog\(null\)/);
  assert.equal((focus.match(/window\.requestAnimationFrame/g) ?? []).length, 2);
  assert.match(focus, /trigger\.isConnected && trigger\.getClientRects\(\)\.length > 0/);
  assert.match(appSource, /onDurableSettled: settleConfigWriteFocus/);

  const start = flowSource.slice(
    flowSource.indexOf("const start = useCallback"),
    flowSource.indexOf("const open = useCallback"),
  );
  assert.match(start, /const recovered = reloadJournal\(\)/);
  assert.match(start, /candidate\.ticket\.receipt\.operationId === preparedReceipt\?\.operationId/);
  assert.match(start, /onDurablePrepared\?\.\(recoveredPrepared\.ticket\.receipt\)/);
});

test("focus and visibility only refresh facts, while changed receipts survive until explicit clearing", () => {
  const visibleRefresh = appSource.slice(
    appSource.indexOf("const refreshVisibleFacts ="),
    appSource.indexOf("useEffect(() => () =>", appSource.indexOf("const refreshVisibleFacts =")),
  );
  assert.match(visibleRefresh, /visibilitychange/);
  assert.match(visibleRefresh, /window\.addEventListener\("focus"/);
  assert.match(visibleRefresh, /void refresh\(\)\.catch/);
  assert.doesNotMatch(visibleRefresh, /(prepare|inspect|commit)FitnessConfigWrite/);

  const refreshChanged = flowSource.slice(
    flowSource.indexOf("const refreshChanged = useCallback"),
    flowSource.indexOf("const dismissReminder = useCallback"),
  );
  assert.ok(refreshChanged.indexOf("await refresh()") < refreshChanged.indexOf("await removeCurrent(entry)"));
  assert.match(flowSource, /清除这份收据并读取当前资料（不可撤回）/);
  assert.match(flowSource, /open=\{emphasize\}/);
  assert.match(journalSource, /readFitnessConfigWriteJournal/);
});

test("venue archive uses an in-app safe-default confirmation and never native confirm", () => {
  const venuesWiring = appSource.slice(
    appSource.indexOf('{view === "venues"'),
    appSource.indexOf('{view === "plan"'),
  );
  assert.doesNotMatch(venuesWiring, /window\.confirm/);
  assert.match(appSource, /initialFocus="\[data-archive-keep\]"/);
  assert.match(appSource, /data-archive-keep[^>]*>继续保留场地/);
  assert.match(appSource, /停用它关联的启用中或草稿计划/);
  assert.match(appSource, /取消尚未开始的日历安排/);
  assert.match(appSource, /训练历史、器材和已经发生的记录都会保留/);
});

test("venue archive attention closes into recovery and returns focus through a stable handler", () => {
  const openRecovery = appSource.slice(
    appSource.indexOf("const openConfigRecovery = useCallback"),
    appSource.indexOf("const configWrites = useFitnessConfigWriteFlow"),
  );
  assert.match(openRecovery, /activeDialog\.current === "venue-archive"/);
  assert.match(openRecovery, /setConfigRecoveryReturnsToVenue\(fromVenueArchive\)/);
  assert.match(openRecovery, /if \(fromVenueArchive\) setArchivingVenue\(null\)/);

  const closeRecovery = appSource.slice(
    appSource.indexOf("const closeConfigRecoveryDialog = useCallback"),
    appSource.indexOf("const discardDirtyDialog = useCallback"),
  );
  assert.match(closeRecovery, /if \(configRecoveryReturnsToVenue\) \{\s*closeVenueArchiveDialog\(\)/);
  assert.match(appSource, /onClose=\{closeConfigRecoveryDialog\}/);
  assert.doesNotMatch(appSource, /onClose=\{venueArchiveReturnFocus\.current/);
  assert.match(appSource, /if \(target\?\.isConnected\)[\s\S]*\.sl-venue-tabs button\[aria-pressed='true'\], \.sl-page-title \.sl-primary/);
});

test("every stale raw-CAS removal reopens latest truth instead of claiming success", () => {
  for (const [caller, nextCaller] of [
    ["finishCommitted", "commitEntry"],
    ["discardExpected", "refreshChanged"],
    ["refreshChanged", "dismissReminder"],
    ["dismissReminder", "clearUnreadable"],
  ]) {
    const start = flowSource.indexOf(`const ${caller} = useCallback`);
    const end = flowSource.indexOf(`const ${nextCaller} = useCallback`, start + 10);
    const body = flowSource.slice(start, end);
    assert.match(body, /const removal = await removeCurrent\(entry\)/);
    assert.match(body, /if \(removal === "blocked"\)/);
    assert.match(body, /if \(removal === "stale"\) \{\s*reopenLatestAfterStale\(entry\);\s*return/);
  }
});

test("dirty close keeps the form mounted and restores deferred focus", () => {
  assert.match(formsSource, /<div hidden=\{confirmClose\}>\{children\}<\/div>/);
  assert.match(formsSource, /ref=\{keepEditing\}/);
  assert.equal((formsSource.match(/onDirtyChange=|onDirtyChange\?:/g) ?? []).length >= 4, true);
  const keep = appSource.slice(
    appSource.indexOf("const keepEditingDialog = useCallback"),
    appSource.indexOf("const showEquipmentDetails = useCallback"),
  );
  assert.match(keep, /window\.requestAnimationFrame/);
  assert.match(keep, /target\?\.isConnected/);
  assert.match(keep, /\.sl-dialog :is\(\.sl-form, \.sl-draft, \.sl-calendar-not-performed\) :is\(input, select, textarea, button\)/);
  assert.match(appSource, /document\.addEventListener\("focusin", rememberFocus, true\)/);
  assert.match(appSource, /fitnessDirtyConfigDialogBlocksRouteChange\([\s\S]*?dialogDirtyRef\.current[\s\S]*?snapshotRef\.current\.sessions[\s\S]*?next\.snapshot\.sessions/);
  assert.match(appSource, /configDialogSnapshotPending && <ConfigDialogSnapshotNotice/);
  assert.match(appSource, /另一页已开始或结束训练[\s\S]*?当前表单和输入仍完整保留/);
  assert.match(appSource, /const discardDirtyDialog =[\s\S]*?if \(configDialogSnapshotPending\) applyPendingConfigDialogSnapshot\(\)/);
});

test("pending or unreadable journals visibly lock config writes without discarding open drafts", () => {
  assert.match(flowSource, /const writeLocked = !journal\.loaded \|\| journal\.unavailable \|\|\s*journal\.entries\.length > 0 \|\| journal\.unreadable\.length > 0 \|\| busy/);
  assert.equal((appSource.match(/writeBlocked=\{configDialogSnapshotPending \|\| configWrites\.writeLocked \|\| snapshotReadStatus !== "ready"\}/g) ?? []).length, 4);
  assert.equal((formsSource.match(/现有草稿会保留，但资料核对线索处理完成前不能保存/g) ?? []).length, 4);
  assert.match(appSource, /busy=\{busy \|\| configWrites\.writeLocked\}/);
});

test("only the config form bound to the durable receipt is consumed before refresh", () => {
  const start = flowSource.slice(flowSource.indexOf("const start = useCallback"), flowSource.indexOf("const open = useCallback"));
  assert.ok(start.indexOf("persistFitnessConfigWrite(createFitnessConfigWriteTicket(receipt))") < start.indexOf("onDurablePrepared?.(receipt)"));
  const finish = flowSource.slice(flowSource.indexOf("const finishCommitted"), flowSource.indexOf("const commitEntry"));
  assert.ok(finish.indexOf("onDurableCommitted?.(entry.ticket.receipt)") < finish.indexOf("await refresh()"));
  assert.match(appSource, /submittedConfigDialogRef\.current = \{ operationId: receipt\.operationId, dialog: current \}/);
  assert.match(appSource, /submitted\.operationId !== receipt\.operationId \|\| activeDialog\.current !== submitted\.dialog\) return/);
  assert.match(appSource, /onDurablePrepared: rememberPreparedConfigDialog/);
  assert.match(appSource, /onDurableCommitted: consumeCommittedConfigDialog/);
  assert.match(flowSource, /const refreshOutcome = await refresh\(\);[\s\S]*?if \(!fitnessFactsRefreshApplied\(refreshOutcome\)\)[\s\S]*?phase: "refresh-only"/);
  assert.ok(flowSource.indexOf("fitnessFactsRefreshApplied(refreshOutcome)") < flowSource.indexOf("const removal = await removeCurrent(entry)"));
});

test("read failure preserves the rendered baseline and config recovery fits narrow screens", () => {
  const refresh = appSource.slice(
    appSource.indexOf("const readFitnessFacts = useCallback"),
    appSource.indexOf("const openConfigRecovery = useCallback"),
  );
  assert.match(refresh, /const next = await loadFitnessFactsWithSettingsExpected\(\);[\s\S]*?applyFitnessSnapshot\(next\)/);
  assert.doesNotMatch(refresh.slice(refresh.indexOf("catch (reason)"), refresh.indexOf("const refresh = useCallback")), /\bsetSnapshot\(/);
  assert.match(refresh, /shouldMarkFitnessFactsReadStale[\s\S]*?setSnapshotReadStatus\("stale"\)/);
  assert.match(appSource, /loads=\{editingEquipmentExpected\?\.loads \?\? \[\]\}/);
  assert.match(appSource, /profile=\{editingProfile\}/);
  assert.match(appSource, /当前显示的是上次成功读取的资料/);
  assert.match(css, /\.shilian button \{\s*min-height: 44px/);
  assert.match(css, /\.sl-setting-row > button \{[\s\S]*?min-height: 44px/);
  assert.match(css, /\.sl-settings-write-status \{[\s\S]*?overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*?\.sl-settings,[\s\S]*?grid-template-columns: 1fr/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 370px\) \{[\s\S]*\.sl-config-recovery > footer[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
});
