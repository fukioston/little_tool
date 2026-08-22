import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const sourceUrl = new URL("../app/career/CareerApp.tsx", import.meta.url);
const cssUrl = new URL("../app/career/career.css", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const css = await readFile(cssUrl, "utf8");

async function loadTaskHelpers() {
  const sourceFile = ts.createSourceFile(sourceUrl.pathname, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const names = new Set([
    "localDayBounds",
    "localDayKey",
    "resolveCareerTaskDateGroup",
    "formatCareerTaskDate",
    "runCareerTaskUiOnce",
  ]);
  const declarations = sourceFile.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text),
  );
  assert.equal(declarations.length, names.size);
  const { outputText, diagnostics = [] } = ts.transpileModule(declarations.map((item) => item.getText(sourceFile)).join("\n"), {
    fileName: "career-task-ui-helpers.ts",
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  assert.deepEqual(diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const helpers = await loadTaskHelpers();
const now = new Date("2026-08-21T12:00:00+08:00").getTime();

test("task dates follow local calendar days and never turn elapsed time into debt", () => {
  assert.equal(helpers.resolveCareerTaskDateGroup(null, now), "unscheduled");
  assert.equal(helpers.resolveCareerTaskDateGroup("2026-08-20T23:59:00+08:00", now), "past");
  assert.equal(helpers.resolveCareerTaskDateGroup("2026-08-21T00:01:00+08:00", now), "today");
  assert.equal(helpers.resolveCareerTaskDateGroup("2026-08-22T08:00:00+08:00", now), "future");
  assert.equal(helpers.formatCareerTaskDate(null, now), "以后再说");
  assert.match(helpers.formatCareerTaskDate("2026-08-20T14:00:00+08:00", now), /^原计划 /);
  assert.match(helpers.formatCareerTaskDate("2026-08-21T14:00:00+08:00", now), /^今天 /);
  assert.match(helpers.formatCareerTaskDate("2026-08-22T14:00:00+08:00", now), /^明天 /);
  assert.doesNotMatch(source, /逾期|\d+\s*项未完成|\d+\s*项可以重新安排|通用任务/);
});

test("a rapid repeated completion gesture can invoke the root action only once", async () => {
  const pending = new Set();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const action = () => helpers.runCareerTaskUiOnce(pending, "same-task", async () => {
    calls += 1;
    await gate;
  });
  const first = action();
  const second = action();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(pending.size, 0);
  assert.match(source, /const pendingRef = useRef\(false\)/);
  assert.match(source, /disabled=\{pending\} aria-busy=\{pending \|\| undefined\}/);
});

test("all five task surfaces use one text-opening row and an independent completion target", () => {
  const rowStart = source.indexOf("function CareerTaskRow");
  const todayStart = source.indexOf("function TodayView", rowStart);
  const calendarStart = source.indexOf("function CalendarView", todayStart);
  const interviewsStart = source.indexOf("function InterviewsView", calendarStart);
  const jobStart = source.indexOf("function JobDrawer", interviewsStart);
  const interviewDrawerStart = source.indexOf("type InterviewEditorSnapshot", jobStart);
  const contactStart = source.indexOf("function ContactDrawer", interviewDrawerStart);
  const jobModalStart = source.indexOf("function JobModal", contactStart);
  const rowSource = source.slice(rowStart, todayStart);
  assert.match(rowSource, /career-task-complete/);
  assert.match(rowSource, /career-task-open/);
  assert.match(rowSource, /onClick=\{\(\) => onOpen\(task\.id\)\}/);
  assert.match(rowSource, /onClick=\{\(\) => void handleComplete\(\)\}/);
  assert.doesNotMatch(rowSource, /<button(?:(?!<\/button>)[\s\S])*<button/);
  for (const slice of [
    source.slice(todayStart, calendarStart),
    source.slice(calendarStart, interviewsStart),
    source.slice(jobStart, interviewDrawerStart),
    source.slice(contactStart, jobModalStart),
  ]) assert.match(slice, /<CareerTaskRow/);
  assert.match(source.slice(calendarStart, interviewsStart), /career-week-entry[\s\S]*onOpenTask\(task\.id\)/);
});

test("every existing-task write is typed, versioned, stale-aware, and never direct SQL", () => {
  assert.match(source, /CareerTaskError/);
  assert.match(source, /careerTaskActions\.(complete|reschedule|cancel|restore|reopenCompleted)/);
  assert.doesNotMatch(source, /UPDATE career_tasks/);
  assert.doesNotMatch(source, /runCareerSql\([^)]*career_tasks/);
  const sheetStart = source.indexOf("function TaskDetailSheet");
  const lifecycleStart = source.indexOf("function lifecycleChoiceCopy", sheetStart);
  const sheet = source.slice(sheetStart, lifecycleStart);
  assert.match(sheet, /task\.updated_at/);
  assert.match(sheet, /expectedUpdatedAt/);
  assert.match(sheet, /error instanceof CareerTaskError && error\.code === "changed"/);
  assert.match(source, /"idle" \| "loading" \| "ready" \| "writing" \| "refreshing" \| "stale" \| "refresh-only"/);
  assert.match(sheet, /这条待办刚在另一个页面发生了变化/);
});

test("committed refresh recovery cannot repeat a task write", () => {
  const start = source.indexOf("async function retryRefreshOnly");
  const end = source.indexOf("function chosenDueAt", start);
  const retry = source.slice(start, end);
  assert.match(retry, /await onRefresh\(\)/);
  assert.match(retry, /careerTaskActions\.load/);
  assert.doesNotMatch(retry, /careerTaskActions\.(complete|reschedule|cancel|restore|reopenCompleted|create)/);
  assert.match(source, /更改已保存在本机/);
  assert.match(source, /请只重新读取，不要重复提交/);
  assert.match(source, /lifecycleTaskWrites\.submitTaskCreate\(input, expected, trigger\)/);
  assert.match(source, /lifecycleTaskWrites\.submitTaskComplete\(expected, trigger\)/);
});

test("restore and cancel ask for a safe explicit decision", () => {
  assert.match(source, /type CareerTaskDueChoice = "later" \| "new" \| "original" \| null/);
  assert.match(source, /useState<CareerTaskDueChoice>\(null\)/);
  assert.match(source, /disabled=\{!canSubmitDue \|\| busy \|\| externalWriteLocked\}/);
  assert.match(source, /原计划时间已经过去。请选择新的时间/);
  assert.match(source, /data-task-safe-focus/);
  assert.match(source, /继续保留/);
  assert.match(source, /它会留在记录里，不会被删除，也不会被当作失败/);
  const cancelStart = css.indexOf(".career-task-cancel-confirm");
  const cancelEnd = css.indexOf(".career-task-empty", cancelStart);
  assert.doesNotMatch(css.slice(cancelStart, cancelEnd), /danger|var\(--career-danger\)/i);
});

test("the task sheet and compact week view preserve focus and 319px geometry", () => {
  assert.match(source, /\[data-dialog-initial\]:not\(\[disabled\]\)/);
  assert.match(source, /if \(phase !== "ready" && phase !== "stale"\) return;[\s\S]*dialog\.contains\(document\.activeElement\)/);
  assert.match(source, /!items\.includes\(document\.activeElement\)[\s\S]*\(event\.shiftKey \? last : first\)\.focus\(\)/);
  assert.match(source, /role="dialog" aria-modal="true" aria-labelledby=\{titleId\}/);
  assert.match(source, /disabled=\{busy \|\| \(mode !== "summary" && phase !== "stale"\)\}/);
  assert.match(css, /\.career-task-sheet button \{ min-height: 44px; \}/);
  assert.match(css, /\.career-task-sheet \.career-icon-button \{ width: 44px; height: 44px; \}/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.career-week-grid \{ display: none; \}[\s\S]*\.career-week-mobile/);
  assert.match(css, /\.career-week-day-picker button \{ min-width: 44px; min-height: 55px;/);
  assert.match(css, /\.career-view:has\(> \.career-plan-grid, > \.career-week-grid\)[\s\S]*\.career-segmented button \{ min-height: 44px; \}/);
  assert.match(css, /\.career-task-sheet \{ width: 100%; height: min\(86dvh, 760px\)/);
});

test("contact read failures are disclosed rather than rendered as empty facts", () => {
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /detailErrors/);
  assert.match(source, /相关记录暂时没有读到/);
  assert.match(source, /没有把它当成“没有安排”/);
  assert.match(source, /联系人资料暂时没有打开。没有把它当成空记录/);
});

test("a contact follow-up defaults to ordinary priority unless the user chooses otherwise", () => {
  const interactionStart = source.indexOf("function ContactInteractionModal");
  const taskModalStart = source.indexOf("function ContactTaskModal", interactionStart);
  const interaction = source.slice(interactionStart, taskModalStart);
  assert.match(interaction, /followUp: scheduleNext[\s\S]*priority: 1/);
  assert.doesNotMatch(interaction, /priority: 2/);
});
