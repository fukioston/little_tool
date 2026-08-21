import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/career/calm-view.ts", import.meta.url), "utf8");
const { outputText, diagnostics = [] } = ts.transpileModule(source, {
  fileName: "lib/career/calm-view.ts",
  reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
assert.deepEqual(diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
const calm = await import(moduleUrl);

const now = Date.parse("2026-08-21T10:00:00.000Z");
const task = (id, due_at, status = "todo") => ({ id, job_id: "job-1", due_at, status });
const interview = (id, scheduled_at, status = "scheduled") => ({ id, job_id: "job-1", scheduled_at, status });

test("the earliest future fact wins regardless of array order", () => {
  const result = calm.resolveCareerJobNextItem(
    "job-1",
    [task("late-task", "2026-08-23T10:00:00.000Z"), task("early-task", "2026-08-21T12:00:00.000Z")],
    [interview("interview", "2026-08-22T10:00:00.000Z")],
    now,
  );
  assert.equal(result.kind, "task");
  assert.equal(result.task.id, "early-task");
});

test("past, canceled and malformed dates never masquerade as the next step", () => {
  const result = calm.resolveCareerJobNextItem(
    "job-1",
    [task("past", "2026-08-20T10:00:00.000Z"), task("done", "2026-08-22T10:00:00.000Z", "done")],
    [interview("past-interview", "2026-08-20T10:00:00.000Z"), interview("bad", "not-a-date"), interview("canceled", "2026-08-22T10:00:00.000Z", "canceled")],
    now,
  );
  assert.equal(result, null);
});

test("an undated task is shown only after every dated future item", () => {
  const withFuture = calm.resolveCareerJobNextItem(
    "job-1",
    [task("undated", null)],
    [interview("future", "2026-08-24T10:00:00.000Z")],
    now,
  );
  assert.equal(withFuture.kind, "interview");

  const onlyUndated = calm.resolveCareerJobNextItem("job-1", [task("undated", null)], [], now);
  assert.equal(onlyUndated.kind, "task");
  assert.equal(onlyUndated.at, null);
});

test("watching is a boolean marker and preserves old priority 3 as watched", () => {
  assert.equal(calm.careerJobIsWatched(1), false);
  assert.equal(calm.careerJobIsWatched(2), true);
  assert.equal(calm.careerJobIsWatched(3), true);
  assert.equal(calm.careerJobIsWatched(Number.NaN), false);
});
