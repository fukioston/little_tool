import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const root = new URL("../", import.meta.url);
const paths = {
  journal: new URL("app/fitness/plan-calendar-write-journal.ts", root),
  flow: new URL("app/fitness/FitnessPlanCalendarWriteFlow.tsx", root),
  app: new URL("app/fitness/FitnessApp.tsx", root),
  css: new URL("app/fitness/fitness.css", root),
};
const [journalSource, flowSource, appSource, css] = await Promise.all([
  readFile(paths.journal, "utf8"),
  readFile(paths.flow, "utf8"),
  readFile(paths.app, "utf8"),
  readFile(paths.css, "utf8"),
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

const executableJournal = transpile(journalSource, paths.journal.pathname).replace(
  /import\s*\{\s*isFitnessCalendarWriteReceipt,\s*isFitnessProgramWriteReceipt,\s*\}\s*from\s*"@\/lib\/fitness\/store";/,
  "const isFitnessProgramWriteReceipt = (value) => Boolean(value && value.purpose === 'fitness-program-write' && typeof value.operationId === 'string'); const isFitnessCalendarWriteReceipt = (value) => Boolean(value && value.purpose === 'fitness-calendar-write' && typeof value.operationId === 'string');",
);
const journal = await import(
  `data:text/javascript;base64,${Buffer.from(executableJournal).toString("base64")}`,
);

const summarySource = flowSource.slice(
  flowSource.indexOf("function receiptSummary"),
  flowSource.indexOf("export function FitnessPlanCalendarWriteRecovery"),
);
const summaryModule = await import(
  `data:text/javascript;base64,${Buffer.from(transpile(`
const getFitnessExercise = (id: string) => id === "known"
  ? { name_zh: "深蹲", name_en: "Squat" }
  : null;
${summarySource}
export { receiptSummary };`, "plan-calendar-summary.ts")).toString("base64")}`,
);

function receipt(operationId = "fitness-program-operation-a", purpose = "fitness-program-write") {
  return { purpose, operationId };
}

function ticket(operationId, purpose = "fitness-program-write", kind = "check") {
  return {
    version: 1,
    kind,
    receipt: receipt(operationId, purpose),
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
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test("program and calendar tickets share one strict bounded journal", async () => {
  const program = ticket("fitness-program-operation-a");
  const calendar = ticket("fitness-calendar-operation-a", "fitness-calendar-write");
  assert.equal(journal.isFitnessPlanCalendarWriteTicket(program), true);
  assert.equal(journal.isFitnessPlanCalendarWriteTicket(calendar), true);
  assert.equal(journal.isFitnessPlanCalendarWriteTicket({ ...program, extra: true }), false);
  assert.equal(journal.isFitnessPlanCalendarWriteTicket({ ...calendar, recordedAt: "not-a-date" }), false);
  assert.match(journalSource, /FITNESS_PLAN_CALENDAR_WRITE_MAX_CHARS = 1024 \* 1024/);
  assert.match(journalSource, /FITNESS_PLAN_CALENDAR_WRITE_JOURNAL_LOCK = "fitness-plan-calendar-write-journal"/);
  assert.match(journalSource, /storage\.setItem\(storageKey, raw\);\s*if \(storage\.getItem\(storageKey\) !== raw\)/);
  await assert.rejects(
    journal.persistFitnessPlanCalendarWrite(program, { storage: memoryStorage(), locks: null }),
    /无法跨页面锁定/,
  );
});

test("one global lease covers raw CAS, backend work, and ticket transition", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const first = journal.persistFitnessPlanCalendarWriteToStorage(
    storage,
    ticket("fitness-program-operation-first"),
  );
  const started = deferred();
  const release = deferred();
  let peerSettled = false;
  const backend = journal.runWithCurrentFitnessPlanCalendarWrite(first, async (lease) => {
    started.resolve();
    await release.promise;
    lease.committed();
  }, { storage, locks });
  await started.promise;
  const peer = journal.persistFitnessPlanCalendarWrite(
    ticket("fitness-calendar-operation-peer", "fitness-calendar-write"),
    { storage, locks },
  ).then(() => { peerSettled = true; }, () => { peerSettled = true; });
  await Promise.resolve();
  assert.equal(peerSettled, false);
  release.resolve();
  const settled = await backend;
  assert.equal(settled.outcome, "ran");
  assert.equal(settled.entry.ticket.kind, "committed");
  await peer;
  assert.equal(peerSettled, true);
  assert.equal(storage.values.size, 1, "a peer cannot persist while the first receipt is unsettled");
});

test("full in-lock scans and exact raw CAS fail closed before any callback", async () => {
  const storage = memoryStorage();
  const original = journal.persistFitnessPlanCalendarWriteToStorage(
    storage,
    ticket("fitness-program-operation-cas"),
  );
  storage.setItem(original.storageKey, JSON.stringify({ ...original.ticket, kind: "committed" }));
  let calls = 0;
  assert.deepEqual(await journal.runWithCurrentFitnessPlanCalendarWrite(
    original,
    () => { calls += 1; },
    { storage, locks: lockManager() },
  ), { outcome: "stale" });
  assert.equal(calls, 0);

  const current = journal.readFitnessPlanCalendarWriteJournal(storage).entries[0];
  storage.setItem(`${journal.FITNESS_PLAN_CALENDAR_WRITE_PREFIX}damaged`, "{damaged");
  assert.deepEqual(await journal.runWithCurrentFitnessPlanCalendarWrite(
    current,
    () => { calls += 1; },
    { storage, locks: lockManager() },
  ), { outcome: "blocked", reason: "unreadable" });
  assert.equal(calls, 0);
});

test("a dynamic full-journal read failure blocks a still-readable target", async () => {
  const base = memoryStorage();
  const entry = journal.persistFitnessPlanCalendarWriteToStorage(
    base,
    ticket("fitness-calendar-operation-length", "fitness-calendar-write"),
  );
  let failLength = false;
  const storage = {
    get length() { if (failLength) throw new Error("length unavailable"); return base.length; },
    key: base.key,
    getItem: base.getItem,
    setItem: base.setItem,
    removeItem: base.removeItem,
  };
  let calls = 0;
  const result = await journal.runWithCurrentFitnessPlanCalendarWrite(entry, () => {
    calls += 1;
  }, {
    storage,
    locks: { request(_name, task) { failLength = true; return task(); } },
  });
  assert.deepEqual(result, { outcome: "blocked", reason: "unavailable" });
  assert.equal(calls, 0);
});

test("all four mutations use frozen prepare receipts and no legacy one-shot API", () => {
  for (const name of [
    "prepareFitnessProgramVersionSchedule",
    "prepareFitnessProgramWeekSchedule",
    "prepareFitnessCalendarReschedule",
    "prepareFitnessCalendarNotPerformed",
  ]) assert.match(appSource, new RegExp(`\\b${name}\\(`));
  for (const name of [
    "saveProgramDraft",
    "scheduleProgramWeek",
    "rescheduleCalendarEvent",
    "markCalendarEventNotPerformed",
  ]) assert.doesNotMatch(appSource, new RegExp(`\\b${name}\\b`));
  assert.doesNotMatch(appSource, /window\.confirm/);
  assert.match(appSource, /source: planDraftSource === "ai" \? "ai_draft" : "local"/);
});

test("every prepare binds the complete root snapshot expectation before start", () => {
  const version = appSource.slice(
    appSource.indexOf("const saveAndSchedulePlanDraft"),
    appSource.indexOf("const scheduleProgramWeekSafely"),
  );
  assert.match(version, /const expected = planDraftExpectation/);
  assert.doesNotMatch(version, /fitnessProgramVersionScheduleExpectationFromSnapshot/);
  assert.match(version, /prepareFitnessProgramVersionSchedule\(\{[\s\S]*?draft,[\s\S]*?source:[\s\S]*?anchorAt,[\s\S]*?\}, expected\)/);

  const week = appSource.slice(
    appSource.indexOf("const scheduleProgramWeekSafely"),
    appSource.indexOf("const saveCalendarReschedule"),
  );
  assert.match(week, /fitnessProgramWeekScheduleExpectationFromSnapshot\([\s\S]*?snapshot,[\s\S]*?program\.id,[\s\S]*?anchorAt/);
  assert.ok(week.indexOf("fitnessProgramWeekScheduleExpectationFromSnapshot") <
    week.indexOf("planCalendarWrites.start"));
  assert.match(week, /prepareFitnessProgramWeekSchedule\(\{[\s\S]*?programId: program\.id,[\s\S]*?anchorAt,[\s\S]*?\}, expected\)/);

  assert.match(appSource, /const expected = rescheduleEvent;[\s\S]*?prepareFitnessCalendarReschedule\([\s\S]*?\}, expected\)/);
  assert.match(appSource, /const expected = notPerformedEvent;[\s\S]*?prepareFitnessCalendarNotPerformed\([\s\S]*?\}, expected\)/);
});

test("prepare persists and verifies one ticket before commit; uncertain is inspect-only", () => {
  const start = flowSource.slice(
    flowSource.indexOf("const start = useCallback"),
    flowSource.indexOf("const open = useCallback"),
  );
  const prepared = start.indexOf("const receipt = await prepare()");
  const persisted = start.indexOf("await persistFitnessPlanCalendarWrite");
  const committed = start.indexOf("return await commitEntry(entry, token)");
  assert.ok(prepared >= 0 && prepared < persisted && persisted < committed);
  assert.match(journalSource, /storage\.setItem\(storageKey, raw\);\s*if \(storage\.getItem\(storageKey\) !== raw\)/);

  const commit = flowSource.slice(
    flowSource.indexOf("const commitEntry"),
    flowSource.indexOf("const start = useCallback"),
  );
  assert.match(commit, /purpose === "fitness-program-write"[\s\S]*?commitFitnessProgramWrite[\s\S]*?commitFitnessCalendarWrite/);
  const uncertain = commit.slice(
    commit.indexOf('locked.value.outcome === "outcome_uncertain"'),
    commit.indexOf('locked.value.outcome === "changed"'),
  );
  assert.doesNotMatch(uncertain, /commitFitness|removeCurrent|onDurableCommitted/);
  const inspect = flowSource.slice(
    flowSource.indexOf("const inspect = useCallback"),
    flowSource.indexOf("const continueExpected"),
  );
  assert.match(inspect, /inspectFitnessProgramWrite[\s\S]*?inspectFitnessCalendarWrite/);
  assert.match(inspect, /locked\.value === "expected"[\s\S]*?phase: "expected"/);
  assert.match(inspect, /locked\.value === "changed"[\s\S]*?phase: "changed"/);
  assert.doesNotMatch(inspect, /commitFitnessProgramWrite|commitFitnessCalendarWrite/);
});

test("committed and changed receipts are refresh-only until a latest read applies", () => {
  const finish = flowSource.slice(
    flowSource.indexOf("const finishCommitted"),
    flowSource.indexOf("const commitEntry"),
  );
  assert.match(finish, /onDurableCommitted\?\.\(entry\.ticket\.receipt\)[\s\S]*?await refresh\(\)/);
  assert.match(finish, /refreshOutcome !== "applied"[\s\S]*?phase: "refresh-only"/);
  assert.ok(finish.indexOf('refreshOutcome !== "applied"') < finish.indexOf("removeCurrent(entry)"));
  const clear = flowSource.slice(
    flowSource.indexOf("const clearEntry"),
    flowSource.indexOf("const clearUnreadable"),
  );
  assert.match(clear, /if \(refreshOutcome !== "applied"\)[\s\S]*?旧回执没有清除/);
  assert.match(flowSource, /continueExpected[\s\S]*?commitEntry\(entry, token\)/);
});

test("mount, storage, focus, and visibility only scan durable reminders", () => {
  const effects = flowSource.slice(
    flowSource.indexOf("useEffect(() => {\n    mounted.current = true"),
    flowSource.indexOf("const reopenLatest"),
  );
  assert.match(effects, /window\.addEventListener\("storage", storage\)/);
  assert.match(effects, /window\.addEventListener\("focus", reloadOnly\)/);
  assert.match(effects, /document\.addEventListener\("visibilitychange", visible\)/);
  assert.doesNotMatch(effects, /inspectFitness|commitFitness|prepareFitness/);
  assert.match(flowSource, /const writeLocked = !journal\.loaded \|\| journal\.unavailable \|\| journal\.entries\.length > 0 \|\|[\s\S]*?journal\.unreadable\.length > 0 \|\| busy/);
});

test("plan draft and calendar inputs stay controlled, dirty-protected, and receipt-bound", () => {
  const localGeneration = appSource.slice(
    appSource.indexOf("const generateLocal"),
    appSource.indexOf("const generateAi"),
  );
  assert.match(localGeneration, /setPlanDraft\(draft\);[\s\S]*?setPlanDraftExpectation\(fitnessProgramVersionScheduleExpectationFromSnapshot\(snapshot, draft\)\)[\s\S]*?rememberDialogDirty\(true\);[\s\S]*?setDialog\("plan-preview"\)/);
  assert.match(appSource, /setPlanDraftExpectation\(fitnessProgramVersionScheduleExpectationFromSnapshot\(snapshot, local\)\)/);
  const submit = appSource.slice(
    appSource.indexOf("const saveAndSchedulePlanDraft"),
    appSource.indexOf("const scheduleProgramWeekSafely"),
  );
  assert.match(submit, /const expected = planDraftExpectation;[\s\S]*?planCalendarWrites\.start[\s\S]*?\}, expected\)/);
  assert.doesNotMatch(submit, /ExpectationFromSnapshot\(snapshot/,
    "a later peer refresh must not silently authorize replacing its newly active plan");
  assert.match(appSource, /setPlanDraft\(null\);\s*setPlanDraftExpectation\(null\)/);
  assert.match(appSource, /dialog === "plan-preview"[\s\S]*?confirmClose=\{confirmDirtyClose\}/);
  assert.match(appSource, /const \[rescheduleValue, setRescheduleValue\] = useState\(""\)/);
  assert.match(appSource, /<RescheduleForm[\s\S]*?value=\{rescheduleValue\}[\s\S]*?onValueChange=/);
  assert.match(appSource, /const \[notPerformedNote, setNotPerformedNote\] = useState\(""\)/);
  assert.match(appSource, /<CalendarNotPerformedConfirm[\s\S]*?note=\{notPerformedNote\}[\s\S]*?onNoteChange=/);
  assert.match(appSource, /submittedPlanCalendarDialogRef\.current = \{[\s\S]*?operationId: receipt\.operationId,[\s\S]*?dialog: current/);
  assert.match(appSource, /submitted\.operationId !== receipt\.operationId[\s\S]*?submitted\.dialog !== current\) return/);
  assert.match(appSource, /onDurablePrepared: rememberPreparedPlanCalendarDialog/);
  assert.match(appSource, /onDurableCommitted: consumeCommittedPlanCalendarDialog/);
  assert.match(appSource, /consumedPlanCalendarOperationRef\.current === receipt\.operationId/);
  assert.match(appSource, /if \(!consumedCurrentDialog && \([\s\S]*?returnDialog === "plan-preview" && planDraft && planDraftExpectation[\s\S]*?setDialog\(returnDialog\)/);
});

test("an empty-note lost response stays bound through exact inspection and never reopens the old confirmation", () => {
  const preparedBinding = appSource.slice(
    appSource.indexOf("const rememberPreparedPlanCalendarDialog"),
    appSource.indexOf("const consumeCommittedPlanCalendarDialog"),
  );
  assert.match(preparedBinding, /current === "plan-preview" \|\| current === "reschedule" \|\|[\s\S]*?current === "calendar-not-performed"/);
  assert.doesNotMatch(preparedBinding, /dialogDirtyRef|notPerformedNote/,
    "empty optional text does not make a submitted durable operation unowned");

  const exactInspection = flowSource.slice(
    flowSource.indexOf("const inspect = useCallback"),
    flowSource.indexOf("const continueExpected"),
  );
  assert.match(exactInspection, /locked\.value === "exact_saved"[\s\S]*?finishCommitted\(locked\.entry, token\)/);
  const finish = flowSource.slice(
    flowSource.indexOf("const finishCommitted"),
    flowSource.indexOf("const commitEntry"),
  );
  assert.ok(finish.indexOf("onDurableCommitted?.(entry.ticket.receipt)") < finish.indexOf("await refresh()"));

  const committedBinding = appSource.slice(
    appSource.indexOf("const consumeCommittedPlanCalendarDialog"),
    appSource.indexOf("const planCalendarWrites"),
  );
  assert.ok(committedBinding.indexOf("consumedPlanCalendarOperationRef.current = receipt.operationId") <
    committedBinding.indexOf("const consumedCurrentDialog = consumedPlanCalendarOperationRef.current === receipt.operationId"));
  assert.ok(committedBinding.indexOf("if (!consumedCurrentDialog") < committedBinding.indexOf("setDialog(null)"));
});

test("not-performed uses an in-app safe-default confirmation and every related CTA locks", () => {
  assert.match(appSource, /dialog === "calendar-not-performed"[\s\S]*?initialFocus="\[data-calendar-keep\]"/);
  assert.match(appSource, /title="这次安排可以不进行"/);
  assert.match(appSource, /className="sl-calendar-not-performed" role="status"/);
  assert.match(appSource, /data-calendar-keep[\s\S]*?>继续保留这次安排</);
  const confirmation = appSource.slice(
    appSource.indexOf("function CalendarNotPerformedConfirm"),
    appSource.indexOf("function MoreDialog"),
  );
  assert.doesNotMatch(confirmation, /sl-danger-action/);
  assert.match(appSource, /只会把[\s\S]*?这一次记为未进行[\s\S]*?不会成为欠账[\s\S]*?其他安排原样保留/);
  assert.match(appSource, /disabled=\{startBusy \|\| writeLocked\}[\s\S]*?>改期</);
  assert.match(appSource, /disabled=\{startBusy \|\| writeLocked\}[\s\S]*?>这次不进行</);
  assert.match(appSource, /busy=\{busy \|\| planCalendarWrites\.writeLocked\}/);
  assert.match(appSource, /startLocked=\{liveWrites\.writeLocked \|\| planCalendarWrites\.writeLocked\}/);
});

test("receipt copy is complete and human-readable without technical authority fields", () => {
  const draft = {
    name: "稳稳一周",
    venue_id: "venue-secret",
    goal: "strength",
    split: "full_body",
    assumptions: ["按当前器材"],
    warnings: ["重量现场确认"],
    days: [{
      weekday: 1,
      kind: "resistance",
      name: "周一力量",
      focus: "下肢",
      estimated_minutes: 45,
      items: [{ exercise_id: "known", order_index: 0, sets: 3, rep_min: 5, rep_max: 8, load_guidance: "保守起步" }],
    }],
  };
  const programText = summaryModule.receiptSummary({
    kind: "program-version-schedule",
    request: { draft, source: "local", anchorAt: 1, scheduleTimeZone: "Asia/Shanghai" },
    before: { venue: { name: "家里" } },
    after: {
      program: { version: 2 },
      events: [{ starts_at: 1_787_300_000_000, title: "周一力量", planned_minutes: 45 }],
    },
    operationId: "technical-operation",
    generationId: "technical-generation",
    projectionSha256: "technical-hash",
  });
  assert.match(programText, /计划名称：稳稳一周/);
  assert.match(programText, /场地：家里/);
  assert.match(programText, /目标：力量/);
  assert.match(programText, /分化：全身/);
  assert.match(programText, /排期时区：Asia\/Shanghai/);
  assert.match(programText, /深蹲（Squat）/);
  assert.match(programText, /当前假设：按当前器材/);
  assert.match(programText, /仍需确认：重量现场确认/);
  assert.match(programText, /原计划会收进历史版本；既有训练记录不会改写或删除/);
  assert.match(appSource, /原计划会收进历史版本，既有训练记录不会改写或删除/);

  const calendarText = summaryModule.receiptSummary({
    kind: "calendar-not-performed",
    before: { title: "周一力量", starts_at: 1 },
    after: { note: "今天休息" },
    operationId: "technical-operation",
    generationId: "technical-generation",
    projectionSha256: "technical-hash",
  });
  assert.match(calendarText, /安排：周一力量/);
  assert.match(calendarText, /说明：今天休息/);
  for (const text of [programText, calendarText]) {
    assert.doesNotMatch(text, /technical-operation|technical-generation|technical-hash|projectionSha256|operationId|generationId/);
  }
});

test("busy recovery is non-dismissible, focusable, and calm at 319px", () => {
  assert.match(flowSource, /if \(operationRef\.current\) return/);
  assert.match(flowSource, /window\.addEventListener\("beforeunload", protect\)/);
  assert.match(flowSource, /disabled=\{controller\.busy\}/);
  assert.match(appSource, /initialFocus="\.sl-plan-calendar-write-recovery button:not\(\[disabled\]\), \[data-dialog-close\]"/);
  assert.match(appSource, /calendarDialogReturnFocus\.current = trigger/);
  const postWriteFocus = appSource.slice(
    appSource.indexOf("const focusAfterPlanCalendarWrite"),
    appSource.indexOf("const applyFitnessSnapshot"),
  );
  assert.equal((postWriteFocus.match(/window\.requestAnimationFrame/g) ?? []).length, 2);
  assert.match(postWriteFocus, /\.sl-plan \.sl-page-title h1[\s\S]*?\.sl-calendar \.sl-page-title h1/);
  assert.match(postWriteFocus, /element\.isConnected && element\.getClientRects\(\)\.length > 0/);
  assert.match(postWriteFocus, /target\.focus\(\{ preventScroll: true \}\)/);
  const navigate = appSource.slice(
    appSource.indexOf("const navigateAfterPlanCalendarWrite"),
    appSource.indexOf("const planCalendarWrites"),
  );
  assert.match(navigate, /setDialog\(null\);[\s\S]*?navigateToFitnessView\(next\);[\s\S]*?focusAfterPlanCalendarWrite\(next\)/);
  assert.match(flowSource, /return receipt\.purpose === "fitness-program-write" \? "plan" : "calendar"/);
  assert.match(css, /\.sl-plan-calendar-write-banner button,[\s\S]*?min-height: 44px/);
  assert.match(css, /\.sl-plan-calendar-write-recovery pre[\s\S]*?overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 370px\)[\s\S]*?\.sl-plan-calendar-write-recovery > footer/);
});
