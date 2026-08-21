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
  const wanted = new Set(["resolveCareerTodayFocus", "resolveInterviewDraftRestoreMode"]);
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

const { resolveCareerTodayFocus, resolveInterviewDraftRestoreMode } = await loadPureCareerUiHelpers();
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

test("failed stage undo never announces success and stage history stays neutral", () => {
  const undoStart = source.indexOf("async function handleUndo");
  const taskStart = source.indexOf("async function toggleTask", undoStart);
  const undoSource = source.slice(undoStart, taskStart);
  assert.match(undoSource, /const restored = await moveJob/);
  assert.match(undoSource, /if \(restored\) notify\("已恢复到原阶段"/);
  assert.match(undoSource, /else setUndo\(item\)/);
  assert.match(source, /阶段改为「\$\{nextStage\?\.name/);
  assert.doesNotMatch(source, /推进至「\$\{nextStage/);
  assert.match(source, /neutralActivityDetail\(item\.detail\)/);
  assert.match(source, /replace\(\/\^推进至\(\?=「\)\//);
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
