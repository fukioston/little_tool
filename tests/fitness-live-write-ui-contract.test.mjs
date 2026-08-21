import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const root = new URL("../", import.meta.url);
const paths = {
  journal: new URL("app/fitness/live-write-journal.ts", root),
  flow: new URL("app/fitness/FitnessLiveWriteFlow.tsx", root),
  app: new URL("app/fitness/FitnessApp.tsx", root),
  gate: new URL("app/fitness/live-refresh-gate.ts", root),
  css: new URL("app/fitness/fitness.css", root),
};
const [journalSource, flowSource, appSource, gateSource, css] = await Promise.all(
  Object.values(paths).map((url) => readFile(url, "utf8")),
);

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

const executableJournal = transpile(journalSource, paths.journal.pathname).replace(
  /import\s*\{\s*isFitnessLiveWriteReceipt,\s*isFitnessLiveStructureWriteReceipt,\s*\}\s*from\s*"@\/lib\/fitness\/store";/,
  "const isFitnessLiveWriteReceipt = (value) => Boolean(value && value.purpose === 'fitness-live-write' && typeof value.operationId === 'string'); const isFitnessLiveStructureWriteReceipt = (value) => Boolean(value && value.purpose === 'fitness-live-structure-write' && typeof value.operationId === 'string');",
);
const journal = await import(`data:text/javascript;base64,${Buffer.from(executableJournal).toString("base64")}`);
const gate = await import(`data:text/javascript;base64,${Buffer.from(transpile(gateSource, paths.gate.pathname)).toString("base64")}`);

const summarySource = flowSource.slice(
  flowSource.indexOf("function receiptSummary"),
  flowSource.indexOf("export function FitnessLiveWriteRecovery"),
);
const summaryModule = await import(`data:text/javascript;base64,${Buffer.from(transpile(`const getFitnessExercise = (id: string) => ({ known: { name_zh: "深蹲", name_en: "Squat" }, next: { name_zh: "划船", name_en: "Row" } }[id]);\n${summarySource}\nexport { receiptSummary };`, "live-summary.ts")).toString("base64")}`);

function receipt(operationId = "live-operation-a") {
  return { purpose: "fitness-live-write", operationId };
}

function ticket(operationId = "live-operation-a", kind = "check") {
  return { version: 1, kind, receipt: receipt(operationId), recordedAt: "2026-08-22T03:04:05.000Z" };
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
  let tail = Promise.resolve();
  return {
    request(_name, task) {
      const run = tail.then(task, task);
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("live tickets are exact, bounded, verified, and unavailable without Web Locks", async () => {
  const valid = ticket();
  assert.equal(journal.isFitnessLiveWriteTicket(valid), true);
  assert.equal(journal.isFitnessLiveWriteTicket({ ...valid, extra: true }), false);
  assert.equal(journal.isFitnessLiveWriteTicket({ ...valid, recordedAt: "not-a-date" }), false);
  assert.match(journalSource, /FITNESS_LIVE_WRITE_MAX_CHARS = 1024 \* 1024/);
  assert.match(journalSource, /storage\.setItem\(storageKey, raw\);\s*if \(storage\.getItem\(storageKey\) !== raw\)/);
  await assert.rejects(
    journal.persistFitnessLiveWrite(valid, { storage: memoryStorage(), locks: null }),
    /无法跨页面锁定/,
  );
});

test("the unified journal lease prevents a peer ticket appearing during a backend callback", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const first = journal.persistFitnessLiveWriteToStorage(storage, ticket("live-operation-first"));
  const started = deferred();
  const release = deferred();
  let peerSettled = false;
  const backend = journal.runWithCurrentFitnessLiveWrite(first, async () => {
    started.resolve();
    await release.promise;
  }, { storage, locks });
  await started.promise;
  const peer = journal.persistFitnessLiveWrite(ticket("live-operation-peer"), { storage, locks })
    .then(() => { peerSettled = true; }, () => { peerSettled = true; });
  await Promise.resolve();
  assert.equal(peerSettled, false);
  release.resolve();
  assert.equal((await backend).outcome, "ran");
  await peer;
  assert.equal(peerSettled, true);
  assert.equal(storage.values.size, 1, "the peer must fail closed instead of adding a second ticket");
});

test("raw CAS and the full in-lock scan block stale or unreadable callbacks", async () => {
  const storage = memoryStorage();
  const original = journal.persistFitnessLiveWriteToStorage(storage, ticket("live-operation-cas"));
  storage.setItem(original.storageKey, JSON.stringify(ticket("live-operation-cas", "committed")));
  let calls = 0;
  assert.deepEqual(await journal.runWithCurrentFitnessLiveWrite(
    original,
    () => { calls += 1; },
    { storage, locks: lockManager() },
  ), { outcome: "stale" });
  assert.equal(calls, 0);

  const current = journal.readFitnessLiveWriteJournal(storage).entries[0];
  storage.setItem(`${journal.FITNESS_LIVE_WRITE_PREFIX}damaged`, "{damaged");
  assert.deepEqual(await journal.runWithCurrentFitnessLiveWrite(
    current,
    () => { calls += 1; },
    { storage, locks: lockManager() },
  ), { outcome: "blocked", reason: "unreadable" });
  assert.equal(calls, 0);
});

test("a dynamic storage read failure blocks the callback even when the target raw remains readable", async () => {
  const base = memoryStorage();
  const entry = journal.persistFitnessLiveWriteToStorage(base, ticket("live-operation-length"));
  let fail = false;
  const storage = {
    get length() { if (fail) throw new Error("length unavailable"); return base.length; },
    key: base.key,
    getItem: base.getItem,
    setItem: base.setItem,
    removeItem: base.removeItem,
  };
  let calls = 0;
  const result = await journal.runWithCurrentFitnessLiveWrite(entry, () => { calls += 1; }, {
    storage,
    locks: { request(_name, task) { fail = true; return task(); } },
  });
  assert.deepEqual(result, { outcome: "blocked", reason: "unavailable" });
  assert.equal(calls, 0);
});

test("refresh request sequencing rejects old responses and only the newest failure marks stale", async () => {
  let latest = 0;
  let stale = false;
  const first = deferred();
  const second = deferred();
  const run = async (work, dirtyConflict) => {
    const requestId = ++latest;
    try {
      await work;
      return gate.resolveFitnessFactsRead(requestId, latest, dirtyConflict);
    } catch (error) {
      if (gate.shouldMarkFitnessFactsReadStale(requestId, latest)) stale = true;
      throw error;
    }
  };
  const a = run(first.promise, false);
  const b = run(second.promise, false);
  first.resolve();
  assert.equal(await a, "superseded");
  second.reject(new Error("latest read failed"));
  await assert.rejects(b, /latest read failed/);
  assert.equal(stale, true);
  assert.equal(gate.resolveFitnessFactsRead(2, 2, true), "deferred");
  let removals = 0;
  const clearAfterRefresh = (outcome) => {
    if (!gate.fitnessFactsRefreshApplied(outcome)) return;
    removals += 1;
  };
  clearAfterRefresh("deferred");
  clearAfterRefresh("superseded");
  assert.equal(removals, 0, "an unbound old receipt must survive deferred/superseded config refresh");
  clearAfterRefresh("applied");
  assert.equal(removals, 1);
});

test("a dirty reflection defers active-session route changes until an explicit discard", () => {
  const historyOnly = [{ id: "history-1", status: "completed" }];
  const peerStarted = [...historyOnly, { id: "live-2", status: "active" }];
  assert.equal(gate.fitnessActiveSessionRouteChanged(historyOnly, historyOnly), false);
  assert.equal(gate.fitnessActiveSessionRouteChanged(historyOnly, peerStarted), true);
  assert.equal(gate.fitnessActiveSessionRouteChanged(peerStarted, historyOnly), true);
  assert.deepEqual(
    gate.resolveFitnessReflectionDraftAction(true, "change", true),
    { dirty: false, applyPending: true },
    "typing back to the exact old text must release and apply a queued peer snapshot",
  );
  assert.deepEqual(
    gate.resolveFitnessReflectionDraftAction(true, "cancel", true),
    { dirty: false, applyPending: true },
    "explicit cancel must release the gate and apply the queued snapshot",
  );
  assert.match(appSource, /if \(fitnessActiveSessionRouteChanged\(before\.sessions, after\.sessions\)\) return true/);
  assert.match(appSource, /if \(action\.applyPending\) window\.requestAnimationFrame\(onDiscardDraft\)/);
  assert.equal(gate.fitnessDirtyConfigDialogBlocksRouteChange(true, historyOnly, peerStarted), true);
  assert.equal(gate.fitnessDirtyConfigDialogBlocksRouteChange(false, historyOnly, peerStarted), false);
  assert.equal(gate.fitnessDirtyConfigDialogBlocksRouteChange(true, historyOnly, historyOnly), false);
});

test("all nine live writes use one durable prepare flow and no legacy one-shot mutations", () => {
  for (const name of [
    "prepareFitnessSetRecord",
    "prepareFitnessSetUndo",
    "prepareFitnessSessionFinish",
    "prepareFitnessEmptySessionCancel",
  ]) assert.match(appSource, new RegExp(`\\b${name}\\(`));
  for (const name of ["recordFitnessSet", "undoFitnessSet", "finishFitnessSession", "cancelEmptyFitnessSession"]) {
    assert.doesNotMatch(appSource, new RegExp(`\\b${name}\\b`));
  }
  assert.match(appSource, /setIndex: setDraft\.expected\.nextSetIndex/);
  assert.doesNotMatch(appSource, /window\.confirm\([^)]*训练/);

  for (const name of [
    "prepareFitnessLiveSessionStart",
    "prepareFitnessLiveExerciseAdd",
    "prepareFitnessLiveExerciseComplete",
    "prepareFitnessLiveExerciseSubstitute",
    "prepareFitnessLiveSessionReflection",
  ]) assert.match(appSource, new RegExp(`\\b${name}\\(`));
  for (const name of [
    "startFitnessSession",
    "addSessionExercise",
    "completeSessionExercise",
    "substituteSessionExercise",
    "updateSessionReflection",
  ]) assert.doesNotMatch(appSource, new RegExp(`\\b${name}\\b`));
  assert.equal((appSource.match(/useFitnessLiveWriteFlow\(/g) ?? []).length, 1);
  assert.match(journalSource, /isFitnessLiveWriteReceipt\(ticket\.receipt\) \|\|\s*isFitnessLiveStructureWriteReceipt\(ticket\.receipt\)/);
  assert.match(flowSource, /receipt\.purpose === "fitness-live-structure-write"[\s\S]*?commitFitnessLiveStructureWrite\(entry\.ticket\.receipt\)/);
  assert.match(flowSource, /receipt\.purpose === "fitness-live-structure-write"[\s\S]*?inspectFitnessLiveStructureWrite\(entry\.ticket\.receipt\)/);
});

test("each structure prepare binds the current complete expectation before durable start", () => {
  const start = appSource.slice(appSource.indexOf("const performFitnessStart"), appSource.indexOf("const requestFitnessStart"));
  assert.ok(start.indexOf("fitnessLiveStartExpectationFromSnapshot(snapshot, input)") < start.indexOf("prepareFitnessLiveSessionStart(input, expected)"));

  const live = appSource.slice(appSource.indexOf("function LiveSession"), appSource.indexOf("function ExercisePicker"));
  for (const [operation, expectation] of [
    ["prepareFitnessLiveExerciseComplete", "fitnessLiveSessionExpectationFromSnapshot(snapshot, session.id)"],
    ["prepareFitnessLiveExerciseAdd", "fitnessLiveAddExpectationFromSnapshot(snapshot, session.id)"],
    ["prepareFitnessLiveExerciseSubstitute", "fitnessLiveSubstituteExpectationFromSnapshot(snapshot, session.id)"],
  ]) {
    const prepareAt = live.indexOf(operation);
    assert.ok(prepareAt > 0);
    assert.ok(live.lastIndexOf(expectation, prepareAt) >= 0, `${operation} must receive an expectation captured first`);
  }
  assert.match(appSource, /onSaveReflection=\{async \(sessionId, reflection, expected\) => liveWrites\.start\(\(\) => prepareFitnessLiveSessionReflection\(sessionId, reflection, expected\)\)\}/);
  assert.match(appSource, /const expected = reflectionExpected \?\? session;[\s\S]*?setReflectionState\(\{ version: draftResetVersion, draft, dirty: action\.dirty, expected \}\)/);
});

test("complete, skip, substitute, and reflection preserve their product invariants", () => {
  const live = appSource.slice(appSource.indexOf("function LiveSession"), appSource.indexOf("function ExercisePicker"));
  assert.match(live, /sets\.length === 0 && <button[^>]*>[\s\S]*?completeExercise\(true\)[\s\S]*?今天不做这个动作/);
  assert.match(live, /sets\.length > 0 && <button[^>]*>[\s\S]*?completeExercise\(false\)[\s\S]*?完成这个动作/);
  assert.match(live, /selectedExerciseId !== current\.id \|\| sets\.length > 0[\s\S]*?exercise\.id === current\.exercise_id/);
  assert.match(live, /availableExercises\.filter\(\(exercise\) => exercise\.pattern === currentExercise\?\.pattern && exercise\.id !== current\.exercise_id\)/);
  assert.match(appSource, /type FitnessLiveDraftGate =[\s\S]*?kind: "reflection"/);
  assert.match(appSource, /if \(!reflectionDirty\) return;[\s\S]*?window\.addEventListener\("beforeunload", protect\)/);
  assert.match(appSource, /<div hidden=\{historyLiveRecovery\}><HistoryDetail/);
  assert.match(appSource, /textarea disabled=\{writeLocked\} value=\{reflectionDraft\}/);
  assert.match(appSource, /submitted\?\.kind === "reflection"[\s\S]*?submitted\.operationId === receipt\.operationId/);
  assert.match(appSource, /resolveFitnessReflectionDraftAction\(snapshotPending, "change", draft\.trim\(\) === expected\.reflection\)/);
  assert.match(appSource, /const cancelReflection =[\s\S]*?resolveFitnessReflectionDraftAction\(snapshotPending, "cancel", true\)[\s\S]*?if \(action\.applyPending\) onDiscardDraft\(\)/);
});

test("confirmed record consumes only its bound draft before refresh; uncertain keeps it", () => {
  const finishCommitted = flowSource.indexOf("const finishCommitted");
  const committed = flowSource.indexOf("onDurableCommitted?.(entry.ticket.receipt)", finishCommitted);
  const refreshed = flowSource.indexOf("await refresh()", committed);
  assert.ok(committed >= 0 && committed < refreshed);
  assert.match(appSource, /submitted\.operationId === receipt\.operationId/);
  assert.match(appSource, /liveDraftGateRef\.current = null;[\s\S]*?setLiveDraftResetVersion/);
  const uncertain = flowSource.slice(
    flowSource.indexOf('locked.value.outcome === "outcome_uncertain"'),
    flowSource.indexOf('locked.value.outcome === "changed"'),
  );
  assert.doesNotMatch(uncertain, /onDurableCommitted|removeCurrent/);
  assert.match(appSource, /setStoredSetDraft\(\{ version: draftResetVersion \+ 1, draft: null \}\);[\s\S]*?onDiscardDraft\(\)/);
});

test("dirty drafts and active operations survive reload, external refresh, and recovery clicks", () => {
  assert.match(appSource, /if \(!setDraft\?\.dirty\) return;[\s\S]*?window\.addEventListener\("beforeunload", protect\)/);
  assert.match(appSource, /pendingLiveSnapshotRef\.current = next;[\s\S]*?return outcome/);
  assert.match(appSource, /const setDraft = storedSetDraft\.draft\?\.dirty && storedSetDraft\.version === draftResetVersion/);
  assert.match(appSource, /<FitnessLiveWriteBanner controller=\{liveWrites\} \/>/);
  assert.match(appSource, /dialog === "live-recovery"[\s\S]*?<FitnessLiveWriteRecovery controller=\{liveWrites\}/);
  assert.match(flowSource, /const busy = operationActive/);
  assert.match(flowSource, /if \(operationRef\.current\) return/);
  assert.match(flowSource, /operationInProgress = useCallback\(\(\) => operationRef\.current !== null/);
  assert.match(flowSource, /disabled=\{controller\.busy\}/);
  assert.match(flowSource, /window\.addEventListener\("beforeunload", protect\)/);
  assert.match(appSource, /disabled=\{liveWrites\.writeLocked\} inputMode/);
  assert.match(appSource, /if \(!liveWrites\.operationInProgress\(\)\) setDialog\(null\)/);
});

test("committed tickets clear only after a latest refresh really applies", () => {
  const finish = flowSource.slice(
    flowSource.indexOf("const finishCommitted"),
    flowSource.indexOf("const commitEntry"),
  );
  assert.match(finish, /refreshOutcome !== "applied"[\s\S]*?phase: "refresh-only"/);
  assert.match(finish, /const removal = await removeCurrent\(entry\)/);
  assert.ok(finish.indexOf('refreshOutcome !== "applied"') < finish.indexOf("removeCurrent(entry)"));
  assert.match(appSource, /return "superseded"|return outcome/);
});

test("record and undo recovery show complete human-readable set facts without technical receipt fields", () => {
  const baseSet = {
    id: "set-1", set_index: 1, load_grams: 20_000, reps: 8,
    duration_seconds: null, rir: 2, rpe: 8, pain_note: "膝前侧紧",
  };
  const projection = { session: {}, exercise: {}, sets: [] };
  const recordText = summaryModule.receiptSummary({
    kind: "set-record", before: projection, after: { ...projection, sets: [baseSet] },
    operationId: "secret", generationId: "secret", projectionSha256: "secret",
  });
  const undoText = summaryModule.receiptSummary({
    kind: "set-undo", before: { ...projection, sets: [baseSet] }, after: projection,
    operationId: "secret", generationId: "secret", projectionSha256: "secret",
  });
  for (const text of [recordText, undoText]) {
    assert.match(text, /组序号：2/);
    assert.match(text, /重量：20 千克/);
    assert.match(text, /次数：8/);
    assert.match(text, /RIR：2/);
    assert.match(text, /RPE：8/);
    assert.match(text, /不适原文：膝前侧紧/);
    assert.doesNotMatch(text, /operation|generation|Sha256|secret|20000 克/);
  }
});

test("all structure receipts show user facts without exposing receipt internals", () => {
  const session = { id: "session-1", status: "active", reflection: "" };
  const active = { id: "row-1", exercise_id: "known", status: "active", substitution_reason: "" };
  const pending = { id: "row-2", exercise_id: "next", status: "pending", substitution_reason: "" };
  const set = { id: "set-1", session_exercise_id: "row-1" };
  const technical = { operationId: "secret-operation", generationId: "secret-generation", projectionSha256: "secret-hash" };
  const receipts = [
    {
      kind: "session-start",
      context: { venue: { name: "家里" } },
      before: { activeSessions: [], event: null },
      after: { session: { ...session, available_minutes: 45 }, exercises: [active], event: null },
      ...technical,
    },
    {
      kind: "exercise-add",
      before: { session, exercises: [active], sets: [] },
      after: { session, exercises: [active, pending], sets: [] },
      ...technical,
    },
    {
      kind: "exercise-complete",
      before: { session, exercises: [active, pending], sets: [set] },
      after: { session, exercises: [{ ...active, status: "completed" }, { ...pending, status: "active" }], sets: [set] },
      ...technical,
    },
    {
      kind: "exercise-substitute",
      before: { session, exercises: [active], sets: [] },
      after: { session, exercises: [{ ...active, exercise_id: "unknown-id", substitution_reason: "器材占用" }], sets: [] },
      ...technical,
    },
    {
      kind: "session-reflection",
      before: { ...session, reflection: "原感受" },
      after: { ...session, reflection: "今天动作很顺" },
      ...technical,
    },
  ];
  const texts = receipts.map(summaryModule.receiptSummary);
  assert.match(texts[0], /开始场地：家里[\s\S]*计划动作：1 个[\s\S]*可用时长：45 分钟/);
  assert.match(texts[1], /新增动作：划船（Row）/);
  assert.match(texts[2], /动作：深蹲（Squat）[\s\S]*现场状态：完成到这里[\s\S]*已有组记录：1 条/);
  assert.match(texts[3], /原动作：深蹲（Squat）[\s\S]*当前版本不识别的动作标识：unknown-id[\s\S]*原因：器材占用/);
  assert.match(texts[4], /训练感受[\s\S]*今天动作很顺/);
  for (const text of texts) assert.doesNotMatch(text, /secret|operation|generation|projectionSha256/);
  assert.match(summaryModule.receiptSummary({
    ...receipts[0],
    after: { ...receipts[0].after, session: { ...receipts[0].after.session, available_minutes: null } },
  }), /可用时长：未限定$/);
});

test("structure success restores focus to the new live target or reflection action", () => {
  assert.match(appSource, /liveMainRef\.current\?\.querySelector<HTMLElement>\([\s\S]*?\.sl-set-form input:not\(\[disabled\]\)[\s\S]*?\.sl-live-done button:not\(\[disabled\]\)[\s\S]*?\.sl-live-empty button:not\(\[disabled\]\)/);
  const completeSlice = appSource.slice(appSource.indexOf("const completeExercise"), appSource.indexOf("const addExercise"));
  assert.match(completeSlice, /prepareFitnessLiveExerciseComplete[\s\S]*?if \(result === "fresh"\) focusLivePrimary\(\)/);
  assert.doesNotMatch(completeSlice, /setFormRef\.current/);
  assert.match(appSource, /\.sl-live-done button:not\(\[disabled\]\), \.sl-live-empty button:not\(\[disabled\]\)/, "last complete/only skip must focus a surviving CTA when no next input exists");
  assert.match(appSource, /prepareFitnessLiveExerciseAdd[\s\S]*?result === "fresh"[\s\S]*?focusLivePrimary\(\)/);
  assert.match(appSource, /reflectionSectionRef\.current\?\.querySelector<HTMLButtonElement>\("header button:not\(\[disabled\]\)"\)[\s\S]*?\.focus/);
  assert.match(appSource, /initialFocus="\.sl-live-write-recovery button:not\(\[disabled\]\), \[data-dialog-close\]"/);
});

test("live error and operation controls render once per active branch", () => {
  const live = appSource.slice(appSource.indexOf("function LiveSession"), appSource.indexOf("function ExercisePicker"));
  assert.equal((live.match(/error && <div className="sl-error-toast"/g) ?? []).length, 1);
  const controllerReturn = flowSource.slice(flowSource.indexOf("  return {\n    journal, flow"), flowSource.indexOf("  } as const;", flowSource.indexOf("  return {\n    journal, flow")));
  assert.equal((controllerReturn.match(/operationInProgress/g) ?? []).length, 1);
});

test("pending live tickets visibly disable every start CTA instead of creating dead buttons", () => {
  assert.match(appSource, /startLocked=\{liveWrites\.writeLocked\}/);
  assert.match(appSource, /const startDisabled = startBusy \|\| startLocked/);
  assert.match(appSource, /aria-describedby=\{startLocked \? "sl-today-start-locked" : undefined\} disabled=\{startDisabled\}/);
  assert.match(appSource, /aria-describedby=\{startLocked \? "sl-calendar-start-locked" : undefined\} disabled=\{startDisabled\}/);
  assert.match(appSource, /先核对页面上方待处理的训练写入，再开始另一场训练/);
  assert.match(css, /\.sl-live-start-locked/);
});

test("calm controls retain 44px targets and collapse safely at 319px", () => {
  assert.match(appSource, /initialFocus="\[data-live-confirm-keep\]"/);
  assert.match(appSource, /继续保留这场训练/);
  assert.match(css, /\.sl-live-write-banner button,[\s\S]*?min-height: 44px/);
  assert.match(css, /@media \(max-width: 370px\)[\s\S]*?\.sl-live-write-recovery > footer/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(appSource, /const focusLivePrimary = useCallback\(\(\) => window\.requestAnimationFrame\(\(\) => \{[\s\S]*?liveMainRef\.current\?\.querySelector<HTMLElement>/);
  assert.match(appSource, /\.sl-page :is\(\.sl-page-title, \.sl-hero\) h1/);
  assert.match(appSource, /initialFocus="\.sl-live-write-recovery button:not\(\[disabled\]\), \[data-dialog-close\]"/);
});
