import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const sourceUrl = new URL("../app/career/CareerApp.tsx", import.meta.url);
const cssUrl = new URL("../app/career/career.css", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const css = await readFile(cssUrl, "utf8");

async function loadPureCareerUiHelpers() {
  const sourceFile = ts.createSourceFile(
    sourceUrl.pathname,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  const wanted = new Set(["isCareerLifecyclePaused", "projectCareerLifecycleScope", "resolveCareerTodayFocus", "resolveInterviewDraftRestoreMode"]);
  const declarations = sourceFile.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name && wanted.has(statement.name.text),
  );
  assert.equal(declarations.length, wanted.size, "career UI truth helpers must remain independently testable");
  const { outputText, diagnostics = [] } = ts.transpileModule(declarations.map((item) => item.getText(sourceFile)).join("\n"), {
    fileName: "career-today-focus.ts",
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  assert.deepEqual(diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const { isCareerLifecyclePaused, projectCareerLifecycleScope, resolveCareerTodayFocus, resolveInterviewDraftRestoreMode } = await loadPureCareerUiHelpers();
const now = new Date("2026-08-21T12:00:00+08:00").getTime();
const activeJob = { id: "active", stage_id: "stage_saved", archived: 0, updated_at: "2026-08-20" };
const terminalJob = { id: "terminal", stage_id: "stage_rejected", archived: 0, updated_at: "2026-08-20" };
const archivedJob = { id: "archived", stage_id: "stage_saved", archived: 1, updated_at: "2026-08-20" };

function data(overrides = {}) {
  return {
    stages: [
      { id: "stage_saved", is_terminal: 0 },
      { id: "stage_offer", is_terminal: 0 },
      { id: "stage_rejected", is_terminal: 1 },
    ],
    jobs: [activeJob, terminalJob, archivedJob],
    tasks: [],
    interviews: [],
    ...overrides,
  };
}

test("Today stays quiet when there is no authored action", () => {
  assert.equal(resolveCareerTodayFocus(data(), now), null);
  assert.match(source, /今天没有必须处理的事/);
  assert.match(source, /职迹不会替你制造任务/);
  assert.doesNotMatch(source, /interview:\s*[^,}\n]*\?\?\s*null/);
});

test("Today focus is driven only by an eligible interview, task, or offer decision", () => {
  const interview = { id: "real-interview", job_id: "active", status: "scheduled", scheduled_at: new Date(now + 3_600_000).toISOString() };
  const task = { id: "real-task", job_id: "active", status: "todo", due_at: null, priority: 2, created_at: "2026-08-20" };
  const offer = { ...activeJob, id: "offer", stage_id: "stage_offer", updated_at: "2026-08-21" };
  assert.deepEqual(
    resolveCareerTodayFocus(data({ jobs: [activeJob, offer], tasks: [task], interviews: [interview] }), now),
    { kind: "interview", interviewId: "real-interview", jobId: "active" },
  );
  assert.deepEqual(
    resolveCareerTodayFocus(data({ tasks: [task] }), now),
    { kind: "task", taskId: "real-task", jobId: "active" },
  );
  assert.deepEqual(
    resolveCareerTodayFocus(data({ jobs: [offer] }), now),
    { kind: "offer", jobId: "offer" },
  );
});

test("archived, terminal, stale, and completed records never become Today focus", () => {
  const ignoredTasks = [
    { id: "terminal-task", job_id: "terminal", status: "todo", due_at: null, priority: 2, created_at: "2026-08-20" },
    { id: "archived-task", job_id: "archived", status: "todo", due_at: null, priority: 2, created_at: "2026-08-20" },
    { id: "done-task", job_id: "active", status: "done", due_at: null, priority: 2, created_at: "2026-08-20" },
  ];
  const ignoredInterviews = [
    { id: "terminal-interview", job_id: "terminal", status: "scheduled", scheduled_at: new Date(now + 3_600_000).toISOString() },
    { id: "archived-interview", job_id: "archived", status: "scheduled", scheduled_at: new Date(now + 3_600_000).toISOString() },
    { id: "past-interview", job_id: "active", status: "scheduled", scheduled_at: new Date(now - 172_800_000).toISOString() },
    { id: "completed-interview", job_id: "active", status: "completed", scheduled_at: new Date(now + 3_600_000).toISOString() },
  ];
  assert.equal(resolveCareerTodayFocus(data({ tasks: ignoredTasks, interviews: ignoredInterviews }), now), null);
});

test("the visible career clock refreshes each minute and when the tab returns", () => {
  assert.doesNotMatch(source, /\bCAREER_CLOCK\b|\bCAREER_TODAY\b/);
  assert.match(source, /window\.setInterval\(updateClock, 60_000\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(source, /document\.visibilityState === "visible"/);
  assert.match(source, /window\.clearInterval\(timer\)/);
  assert.doesNotMatch(source, /function relativeDate\([^)]*=\s*Date\.now/);
});

test("stage undo stays lifecycle-safe and never announces a failed restore", () => {
  const undoStart = source.indexOf("async function handleUndo");
  const taskStart = source.indexOf("async function toggleTask", undoStart);
  const undoSource = source.slice(undoStart, taskStart);
  assert.match(undoSource, /const restored = await requestLifecycleChange/);
  assert.match(undoSource, /rememberUndo: false, choice: "keep"/);
  assert.match(undoSource, /expectedUndo: item/);
  assert.match(undoSource, /currentJob\.stage_id !== item\.to/);
  assert.match(source, /prepared\.transition !== "active-to-active"/);
  assert.match(source, /prepared\.allowedChoices\.includes\(requestedChoice\)/);
  assert.match(undoSource, /if \(restored\) \{ setUndo\(null\); notify\("已恢复到原阶段"/);
  assert.doesNotMatch(undoSource.slice(undoSource.indexOf("const restored"), undoSource.indexOf("if (restored)")), /setUndo\(null\)/);
  assert.match(source, /neutralActivityDetail\(item\.detail\)/);
  assert.match(source, /replace\(\/\^推进至\(\?=「\)\//);
});

test("job lifecycle scope is mutually exclusive and each surface uses its truthful snapshot", () => {
  const stages = [
    { id: "active", is_terminal: 0 },
    { id: "ended", is_terminal: 1 },
  ];
  const snapshot = {
    jobs: [
      { id: "a", stage_id: "active", archived: 0 },
      { id: "e", stage_id: "ended", archived: 0 },
      { id: "r", stage_id: "ended", archived: 1 },
    ],
    tasks: [
      { id: "general", job_id: null },
      { id: "at", job_id: "a" },
      { id: "et", job_id: "e" },
      { id: "rt", job_id: "r" },
    ],
    interviews: [
      { id: "ai", job_id: "a" },
      { id: "ei", job_id: "e" },
      { id: "ri", job_id: "r" },
    ],
  };
  assert.deepEqual(projectCareerLifecycleScope(snapshot, stages, "active").jobs.map((item) => item.id), ["a"]);
  assert.deepEqual(projectCareerLifecycleScope(snapshot, stages, "ended").jobs.map((item) => item.id), ["e"]);
  assert.deepEqual(projectCareerLifecycleScope(snapshot, stages, "archived").jobs.map((item) => item.id), ["r"]);
  assert.deepEqual(projectCareerLifecycleScope(snapshot, stages, "active").tasks.map((item) => item.id), ["general", "at"]);
  assert.match(source, /Promise\.all\(\[\s*loadCareerData\(\),\s*loadCareerLifecycleScope\("all"\),\s*loadCareerLifecycleScope\(scope\)/);
  assert.match(source, /<BoardView data=\{boardData\} jobs=\{boardJobs\}/);
  assert.match(source, /<JobsView data=\{scopedData\} jobs=\{scopedJobs\}/);
  assert.match(source, /const selectedJob = allLifecycle\.jobs\.find/);
  for (const scope of ["active", "ended", "archived"]) {
    assert.match(source, new RegExp(`data-career-scope=\\{value\\}`));
    assert.match(source, new RegExp(`\\["${scope}",`));
  }
  assert.match(source, /aria-pressed=\{scope === value\}/);
});

test("every job stage and archive entrance goes through one lifecycle request", () => {
  assert.doesNotMatch(source, /UPDATE career_jobs SET stage_id/);
  assert.doesNotMatch(source, /UPDATE career_jobs SET archived/);
  assert.doesNotMatch(source, /function moveJob|function removeJob/);
  assert.match(source, /prepareCareerLifecycleChange\(intent\)/);
  assert.match(source, /commitPreparedCareerLifecycleChange\(prepared, choice\)/);
  assert.match(source, /onLifecycle\(\{ kind: "stage"/);
  assert.match(source, /onLifecycle\(\{ kind: "archive"/);
  assert.match(source, /onLifecycle\(\{ kind: "restore"/);
  assert.match(source, /currentJob\.stage_id === intent\.nextStageId/);
  assert.match(source, /if \(!currentJob\) \{\s*notify\("\u804c\u4f4d\u8bb0\u5f55\u521a\u6709\u53d8\u5316/);
  assert.match(source, /return false;\s*\}\s*if \(\s*\(intent\.kind === "stage"/);
  assert.match(source, /prepared\.transition === "active-to-active" \|\| prepared\.transition === "terminal-to-terminal"/);
});

test("a consequential lifecycle choice is never preselected", () => {
  assert.match(source, /return prepared\.requiresChoice \? null : prepared\.allowedChoices\[0\] \?\? null/);
  assert.match(source, /<fieldset className="career-lifecycle-choices">/);
  assert.match(source, /type="radio" name="career-lifecycle-choice"/);
  assert.match(source, /disabled=\{busy \|\| !state\.choice\}/);
  assert.match(source, /保留安排/);
  assert.match(source, /随职位暂停/);
  assert.match(source, /恢复仍合适的安排/);
  assert.match(source, /只恢复仍在未来且之后没有被修改过/);
  assert.match(source, /\? "确认归档"/);
  assert.match(source, /\? "确认取回"/);
  assert.match(source, /\? "记录结果"/);
  assert.match(source, /setLifecycleDialog\(null\);\s*focusAfterLifecycle\(\);/);
});

test("changed previews and committed refresh recovery cannot repeat a write", () => {
  const finishStart = source.indexOf("async function finishPreparedLifecycle");
  const requestStart = source.indexOf("async function requestLifecycleChange", finishStart);
  const finishSource = source.slice(finishStart, requestStart);
  assert.match(finishSource, /if \(result\.status === "changed"\)/);
  assert.match(finishSource, /prepared: result\.prepared/);
  assert.match(finishSource, /changed: true/);
  assert.match(source, /安排刚有变化，请再看一眼/);
  assert.match(finishSource, /lifecycleRefreshOnlyRef\.current = true/);
  assert.match(finishSource, /phase: "refresh-recovery"/);
  assert.match(finishSource, /更改已保存在本机/);
  const retryStart = source.indexOf("async function retryLifecycleRefresh");
  const undoStart = source.indexOf("async function handleUndo", retryStart);
  const retrySource = source.slice(retryStart, undoStart);
  assert.match(retrySource, /await refresh\(\)/);
  assert.doesNotMatch(retrySource, /commitPreparedCareerLifecycleChange|prepareCareerLifecycleChange/);
  assert.match(source, /请不要重复提交/);
  assert.match(source, /dismissible=\{false\} inertToasts/);
});

test("dragging is pointer-only while the stage select remains the keyboard path", () => {
  assert.match(source, /useSensor\(PointerSensor/);
  assert.match(source, /<span className="career-grip" \{\.\.\.dragProps\} tabIndex=\{-1\} aria-hidden="true">/);
  assert.doesNotMatch(source, /dragProps=\{\{ \.\.\.attributes/);
  assert.match(source, /<div aria-hidden="true"><JobCard job=\{activeJob\}/);
  assert.match(source, /<select value=\{job\.stage_id\} disabled=\{pending\}/);
  assert.match(css, /\.career-job-card footer select \{ min-height: 44px; \}/);
  assert.match(source, /pending=\{lifecycleLocked\}/);
  assert.match(source, /lifecyclePending=\{lifecycleLocked\}/);
});

test("kept actions stay visible with an ended or archived context", () => {
  assert.match(source, /<TodayView data=\{allData\}/);
  assert.match(source, /<CalendarView data=\{allData\}/);
  assert.match(source, /task\.status === "todo"/);
  assert.match(source, /item\.status === "scheduled"/);
  assert.match(source, /interview\.status === "scheduled" && Boolean\(interview\.scheduled_at\)/);
  assert.match(source, /职位已结束/);
  assert.match(source, /职位已归档/);
  assert.match(source, /career-action-context/);
  assert.match(source, /resolveCareerTodayFocus\(data, now\)/);
});

test("lifecycle-paused actions are not described as a user cancellation", () => {
  assert.equal(isCareerLifecyclePaused({ status: "canceled", cancellation_reason: "job_ended", lifecycle_operation_id: "operation" }), true);
  assert.equal(isCareerLifecyclePaused({ status: "canceled", cancellation_reason: "job_archived", lifecycle_operation_id: "operation" }), true);
  assert.equal(isCareerLifecyclePaused({ status: "canceled", cancellation_reason: "user_canceled", lifecycle_operation_id: null }), false);
  assert.match(source, /lifecyclePaused \? "随职位暂停" : item\.status === "canceled" \? "已取消"/);
  assert.match(source, /disabled=\{lifecyclePaused\}/);
  assert.match(source, /lifecyclePaused && status !== "canceled"/);
  assert.match(source, /不能从普通状态菜单恢复/);
});

test("scope read failures keep the previous truthful view and stale requests cannot win", () => {
  const start = source.indexOf("async function changeJobScope");
  const end = source.indexOf("async function runAi", start);
  const scopeSource = source.slice(start, end);
  assert.match(scopeSource, /const requestToken = \+\+scopeRequestRef\.current/);
  assert.match(scopeSource, /const uiReadToken = \+\+uiReadRequestRef\.current/);
  assert.match(scopeSource, /scopeRequestRef\.current !== requestToken \|\| uiReadRequestRef\.current !== uiReadToken/);
  assert.match(scopeSource, /setScopedLifecycle\(next\.scoped\)/);
  assert.doesNotMatch(scopeSource, /setScopedLifecycle\(emptyLifecycleSnapshot\)/);
  assert.match(scopeSource, /原来的记录仍保留在画面上/);
  assert.match(source, /scopeError && <div className="career-scope-error" role="alert">/);
  assert.match(source, /if \(uiReadRequestRef\.current !== requestToken\) return/);
});

test("archived job details are read-only except for taking the job back", () => {
  const start = source.indexOf("function JobDrawer");
  const end = source.indexOf("type InterviewEditorSnapshot", start);
  const drawerSource = source.slice(start, end);
  assert.match(drawerSource, /archived \? <span className="career-archived-state"/);
  assert.match(drawerSource, /!archived && <div className="career-detail-actions">/);
  assert.match(drawerSource, /if \(archived\) return/);
  assert.match(drawerSource, /WHERE id=\? AND archived=0/);
  assert.match(drawerSource, /if \(result\.changes === 0\)/);
  assert.match(drawerSource, /kind: "restore", jobId: job\.id/);
  assert.match(drawerSource, /归档只是整理，不会删除职位或相关记录/);
});

test("job ranges stay calm and do not turn into scorekeeping", () => {
  const start = source.indexOf("function JobsView");
  const end = source.indexOf("function CalendarView", start);
  const jobsSource = source.slice(start, end);
  assert.match(jobsSource, /进行中/);
  assert.match(jobsSource, /已结束/);
  assert.match(jobsSource, /已归档/);
  assert.doesNotMatch(jobsSource, /共 \$\{|\u663e示 \{jobs\.length\}|成功率|Offer 率/);
  assert.match(css, /\.career-job-scope[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.career-modal > header \.career-icon-button \{ width: 44px; height: 44px; flex: 0 0 44px;/);
});

test("task and interview creation use a synchronous duplicate-submit guard", () => {
  for (const [startName, endName] of [["function TaskModal", "function InterviewModal"], ["function InterviewModal", "function ContactModal"]]) {
    const start = source.indexOf(startName);
    const end = source.indexOf(endName, start + 1);
    const modalSource = source.slice(start, end);
    assert.match(modalSource, /const savingRef = useRef\(false\)/);
    assert.match(modalSource, /if \(savingRef\.current\) return/);
    assert.match(modalSource, /savingRef\.current = true/);
    assert.match(modalSource, /disabled=\{saving\}/);
  }
});

test("every dirty interview close path offers an explicit local-only choice", () => {
  const drawerStart = source.indexOf("function InterviewDrawer");
  const contactStart = source.indexOf("function ContactDrawer", drawerStart);
  const drawerSource = source.slice(drawerStart, contactStart);
  assert.match(drawerSource, /onClose=\{requestClose\}/);
  assert.ok((drawerSource.match(/onClick=\{requestClose\}/g) ?? []).length >= 2);
  assert.match(drawerSource, /window\.addEventListener\("beforeunload", protectUnsavedDraft\)/);
  assert.match(source, /career\.interview-draft\.v1:/);
  assert.match(drawerSource, />继续编辑<\/button>/);
  assert.match(drawerSource, /保存本机草稿并关闭/);
  assert.match(drawerSource, /放弃修改/);
  assert.match(drawerSource, /不进入 SQLite 或导出备份/);
  assert.match(drawerSource, /setBaseline\(currentSnapshot\)/);
  assert.match(drawerSource, /localStorage\.removeItem\(interviewDraftKey\(interview\.id\)\)/);
  assert.match(source, /\["scheduled", "completed", "canceled"\]\.includes\(snapshot\.status\)/);
  assert.match(drawerSource, /if \(draft\.summary !== null\) setSummary/);
  assert.match(css, /\.career-draft-choice\s*\{/);
  assert.match(css, /\.career-local-draft-note/);
});

test("a stale local interview draft never overwrites newer SQLite content automatically", () => {
  assert.equal(resolveInterviewDraftRestoreMode("same", "same"), "auto");
  assert.equal(resolveInterviewDraftRestoreMode("older", "newer"), "confirm");
  const effectStart = source.indexOf("const draft = readInterviewLocalDraft(interview)");
  const unloadStart = source.indexOf("protectUnsavedDraft", effectStart);
  const restoreSource = source.slice(effectStart, unloadStart);
  const confirmAt = restoreSource.indexOf('=== "confirm"');
  const pendingAt = restoreSource.indexOf("setPendingStaleDraft(draft)");
  const returnAt = restoreSource.indexOf("return;", pendingAt);
  const applyAt = restoreSource.indexOf("setStatus(draft.snapshot.status)");
  assert.ok(confirmAt >= 0 && pendingAt > confirmAt && returnAt > pendingAt && applyAt > returnAt);
  assert.match(source, /SQLite 里已有更新，因此没有自动覆盖/);
  assert.match(source, /载入本机草稿核对/);
  assert.match(source, /继续使用当前内容/);
  assert.match(source, /清除旧草稿/);
});

test("legacy uncertainty is disclosed without deleting or accusing", () => {
  assert.match(source, /getCareerLegacyDemoResolution/);
  assert.match(source, /legacyResolution === CAREER_LEGACY_DEMO_REVIEW_NEEDED/);
  assert.match(source, /旧版可能含示例内容，未自动删除以保护你的编辑/);
  assert.match(source, /不会替你判断哪些记录属于你，也不会自行清理/);
  const contentStart = source.indexOf('<div className="career-content">');
  const viewStart = source.indexOf('{view === "today"', contentStart);
  const globalNotice = source.indexOf('legacyReviewNeeded && <div className="career-legacy-review-note"', contentStart);
  assert.ok(contentStart >= 0 && globalNotice > contentStart && globalNotice < viewStart,
    "legacy uncertainty must be visible before every Career view, not buried in Settings");
  assert.doesNotMatch(source, /一键删除示例|确认这些是假数据/);
});
