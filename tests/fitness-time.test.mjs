import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const source = await readFile(new URL("../lib/fitness/time.ts", import.meta.url), "utf8");
const { outputText, diagnostics = [] } = ts.transpileModule(source, {
  fileName: "lib/fitness/time.ts",
  reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
assert.deepEqual(diagnostics.filter((entry) => entry.category === ts.DiagnosticCategory.Error), []);
const time = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("datetime-local formatting uses the event date's own timezone offset", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    assert.equal(
      time.toLocalDateTimeInputValue(new Date("2026-01-15T18:30:00-05:00").getTime()),
      "2026-01-15T18:30",
    );
    assert.equal(
      time.toLocalDateTimeInputValue(new Date("2026-07-15T18:30:00-04:00").getTime()),
      "2026-07-15T18:30",
    );
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("local day bounds follow 23-hour and 25-hour DST days", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const spring = time.localDayBounds(new Date("2026-03-08T12:00:00-04:00").getTime());
    const autumn = time.localDayBounds(new Date("2026-11-01T12:00:00-05:00").getTime());
    assert.equal(spring.end - spring.start, 23 * 60 * 60 * 1000);
    assert.equal(autumn.end - autumn.start, 25 * 60 * 60 * 1000);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
