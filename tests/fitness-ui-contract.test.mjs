import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const sourceUrl = new URL("../app/fitness/FitnessApp.tsx", import.meta.url);
const logicUrl = new URL("../app/fitness/fitness-ui-logic.ts", import.meta.url);
const [source, logicSource] = await Promise.all([
  readFile(sourceUrl, "utf8"),
  readFile(logicUrl, "utf8"),
]);

async function loadPureFitnessUiHelpers() {
  const sourceFile = ts.createSourceFile(
    logicUrl.pathname,
    logicSource,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  const wanted = new Set([
    "resolveFitnessNavigationBehavior",
    "resolveFitnessPainDraftAfterRecord",
    "resolveScheduledFitnessStartRoute",
    "runFitnessPersistThenRefresh",
  ]);
  const helpers = sourceFile.statements
    .filter(
      (statement) => ts.isFunctionDeclaration(statement) &&
        statement.name && wanted.has(statement.name.text),
    )
    .map((statement) => statement.getText(sourceFile))
    .join("\n");
  assert.equal((helpers.match(/export (?:async )?function/g) ?? []).length, wanted.size);

  const { outputText, diagnostics = [] } = ts.transpileModule(helpers, {
    fileName: "fitness-ui-helpers.ts",
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  assert.deepEqual(
    diagnostics.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const {
  resolveFitnessNavigationBehavior,
  resolveFitnessPainDraftAfterRecord,
  resolveScheduledFitnessStartRoute,
  runFitnessPersistThenRefresh,
} = await loadPureFitnessUiHelpers();

test("every fitness view route uses one reduced-motion-aware scroll reset", () => {
  assert.equal(resolveFitnessNavigationBehavior(true), "auto");
  assert.equal(resolveFitnessNavigationBehavior(false), "smooth");
  assert.equal((source.match(/\bsetView\(/g) ?? []).length, 1);
  assert.match(source, /const navigateToFitnessView = useCallback/);
  assert.match(source, /window\.requestAnimationFrame/);
  assert.match(source, /window\.cancelAnimationFrame/);
  assert.match(source, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/);
  assert.match(source, /window\.scrollTo\(\{\s*top: 0,\s*left: 0,/);
  assert.equal(
    (source.match(/onClick=\{\(\) => navigateToFitnessView\(item\.id\)\}/g) ?? []).length,
    2,
    "desktop and mobile navigation must share the same route helper",
  );
  assert.match(source, /onView=\{navigateToFitnessView\}/);
});

test("scheduled starts distinguish planned and current venues before writing", () => {
  assert.equal(resolveScheduledFitnessStartRoute("venue-a", "venue-a"), "start-planned");
  assert.equal(resolveScheduledFitnessStartRoute("venue-a", "venue-b"), "choose-venue");
  assert.equal(resolveScheduledFitnessStartRoute(null, "venue-b"), "choose-venue");
  assert.equal(resolveScheduledFitnessStartRoute("venue-a", null), "missing-planned-venue");

  assert.equal(
    (source.match(/onStart=\{requestFitnessStart\}/g) ?? []).length,
    2,
    "Today and Calendar must share the venue-aware start entry",
  );
  assert.match(source, />切换到计划场地并开始<\/button>/);
  assert.match(source, />按当前场地开始临时训练<\/button>/);
  assert.match(source, /原来的日历安排仍会保留/);
  assert.match(source, /if \(scheduledStartMutationRef\.current\) return;/);
  assert.match(source, /scheduledStartChoiceRef\.current\?\.requestId === expectedChoiceId/);
  assert.match(source, /activeDialog\.current === "venue-start-choice"/);
});

test("the one-shot pain note clears only after persistence succeeds", () => {
  assert.equal(resolveFitnessPainDraftAfterRecord("左膝不适", false), "左膝不适");
  assert.equal(resolveFitnessPainDraftAfterRecord("左膝不适", true), "");
  assert.match(source, /name="pain" value=\{currentPainDraft\}/);
  assert.match(source, /painNote: currentPainDraft/);

  const recordStart = source.indexOf("const record = async");
  const finishStart = source.indexOf("const finish = async", recordStart);
  assert.ok(recordStart >= 0 && finishStart > recordStart);
  const recordSource = source.slice(recordStart, finishStart);
  const persistedAt = recordSource.indexOf("await runFitnessPersistThenRefresh");
  const writeAt = recordSource.indexOf("recordFitnessSet", persistedAt);
  const clearedAt = recordSource.indexOf("setPainDraft", persistedAt);
  assert.ok(persistedAt >= 0 && writeAt > persistedAt && clearedAt > writeAt);
});

test("a committed write with a failed refresh becomes recovery, never a write retry", async () => {
  const calls = [];
  const result = await runFitnessPersistThenRefresh(
    async () => {
      calls.push("persist");
      return "committed-row";
    },
    async () => {
      calls.push("refresh");
      throw new Error("snapshot temporarily unavailable");
    },
  );
  assert.deepEqual(calls, ["persist", "refresh"]);
  assert.deepEqual(result, { status: "refresh-failed", value: "committed-row" });

  const refreshed = await runFitnessPersistThenRefresh(
    async () => "committed-row",
    async () => undefined,
  );
  assert.deepEqual(refreshed, { status: "refreshed", value: "committed-row" });

  let refreshCalled = false;
  await assert.rejects(
    runFitnessPersistThenRefresh(
      async () => { throw new Error("write rejected"); },
      async () => { refreshCalled = true; },
    ),
    /write rejected/,
  );
  assert.equal(refreshCalled, false, "a genuine write failure must remain a normal failure");

  const liveStart = source.indexOf("function LiveSession");
  const pickerStart = source.indexOf("function ExercisePicker", liveStart);
  const liveSource = source.slice(liveStart, pickerStart);
  assert.equal(
    (liveSource.match(/await runFitnessPersistThenRefresh\(/g) ?? []).length,
    4,
    "mutate, record, finish and cancel must share the commit boundary",
  );
  assert.equal(
    (liveSource.match(/await onRefresh\(\)/g) ?? []).length,
    1,
    "only the explicit recovery path may refresh outside the shared commit helper",
  );
  assert.match(liveSource, /interactionLocked = mutationBusy \|\| postCommitRecovery !== null/);
  assert.match(liveSource, /mutationGuardRef\.current \|\| recoveryRef\.current/);
  assert.match(liveSource, /recoveryRequestRef\.current !== null/);
  assert.match(liveSource, /recoveryRef\.current\?\.token !== pending\.token \|\| recoveryTokenRef\.current !== pending\.token/);
  assert.match(liveSource, /已保存在本地/);
  assert.match(liveSource, /请重新读取/);
  assert.match(liveSource, /不要重复提交/);
  assert.match(liveSource, /onClick=\{\(\) => void retryPostCommitRefresh\(\)\}/);
  assert.match(liveSource, /: "重新读取"/);
  assert.match(liveSource, /onToast\(pending\.success\)/);
  assert.match(liveSource, /if \(pending\.nextView\) onExit\(pending\.nextView\)/);
});

test("empty live sessions offer cancellation separately from an explicit empty save", () => {
  assert.match(source, /cancelEmptyFitnessSession,/);
  assert.match(source, /\(\) => cancelEmptyFitnessSession\(session\.id\)/);
  assert.match(source, /nextView: returningToCalendar \? "calendar" : "today"/);
  assert.match(source, /onExit=\{navigateToFitnessView\}/);
  assert.doesNotMatch(source, /onExit=\{[^}]*refresh/);
  const liveActionsStart = source.indexOf('<footer className="sl-live-actions">');
  const liveActionsEnd = source.indexOf("</footer>", liveActionsStart);
  assert.ok(liveActionsStart >= 0 && liveActionsEnd > liveActionsStart);
  const liveActions = source.slice(liveActionsStart, liveActionsEnd);
  assert.match(liveActions, /sets\.length > 0 && <button/);
  assert.match(liveActions, />完成这个动作<\/button>/);
  assert.match(source, />取消误开的训练<\/button>/);
  assert.match(source, /hasActualFacts \? "结束并保存" : "保存空时段"/);
  assert.match(source, /原来的日历安排会回到待进行/);
});

test("the More sheet backdrop is inert to keyboard and accessibility traversal", () => {
  assert.match(
    source,
    /<button type="button" className="sl-scrim" tabIndex=\{-1\} aria-hidden="true" onClick=\{onClose\}\/>/,
  );
});
