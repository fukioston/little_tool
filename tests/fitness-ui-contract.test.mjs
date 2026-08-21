import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const sourceUrl = new URL("../app/fitness/FitnessApp.tsx", import.meta.url);
const source = await readFile(sourceUrl, "utf8");

async function loadPureFitnessUiHelpers() {
  const sourceFile = ts.createSourceFile(
    sourceUrl.pathname,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  const wanted = new Set([
    "resolveFitnessNavigationBehavior",
    "resolveFitnessPainDraftAfterRecord",
    "resolveScheduledFitnessStartRoute",
  ]);
  const helpers = sourceFile.statements
    .filter(
      (statement) => ts.isFunctionDeclaration(statement) &&
        statement.name && wanted.has(statement.name.text),
    )
    .map((statement) => statement.getText(sourceFile))
    .join("\n");
  assert.equal((helpers.match(/export function/g) ?? []).length, wanted.size);

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
  const persistedAt = recordSource.indexOf("await recordFitnessSet");
  const clearedAt = recordSource.indexOf("setPainDraft", persistedAt);
  const refreshedAt = recordSource.indexOf("await onRefresh", clearedAt);
  assert.ok(persistedAt >= 0 && clearedAt > persistedAt && refreshedAt > clearedAt);
});

test("empty live sessions offer cancellation separately from an explicit empty save", () => {
  assert.match(source, /cancelEmptyFitnessSession,/);
  assert.match(source, /await cancelEmptyFitnessSession\(session\.id\)/);
  assert.match(source, /onExit\(returningToCalendar \? "calendar" : "today"\)/);
  assert.match(source, /onExit=\{\(next = "history"\) => \{ navigateToFitnessView\(next\); void refresh\(\); \}\}/);
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
