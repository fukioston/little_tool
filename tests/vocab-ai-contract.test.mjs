import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

async function loadContract() {
  const relativePath = "lib/vocab/ai-contract.ts";
  const source = await readFile(new URL(relativePath, projectRoot), "utf8");
  const { outputText, diagnostics = [] } = ts.transpileModule(source, {
    fileName: relativePath,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
  });
  assert.deepEqual(diagnostics.filter((entry) => entry.category === ts.DiagnosticCategory.Error), []);
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const valid = {
  schema_version: "1.0",
  target: { surface: "deliberate", canonical: "deliberate", kind: "adjective", ipa: "/dɪˈlɪbərət/" },
  sense: {
    glosses_en: ["done consciously"],
    meaning_in_context_en: "The choice was intentional.",
    explanation_en: "Here it describes a considered choice.",
    explanation_zh: null,
    parts_of_speech: ["adjective"],
  },
  collocations: ["deliberate choice"],
  warnings: [],
};

test("vocab AI parser keeps only bounded contract fields", async () => {
  const { parseAiExplanation } = await loadContract();
  const result = parseAiExplanation({ ...valid, unknown_secret: "ignored", warnings: Array.from({ length: 20 }, (_, index) => `w${index}`) });
  assert.equal(result.target.canonical, "deliberate");
  assert.equal(result.target.kind, undefined);
  assert.deepEqual(result.sense.glosses_en, ["done consciously"]);
  assert.equal(result.warnings.length, 8);
  assert.equal("unknown_secret" in result, false);
});

test("vocab AI parser rejects malformed or empty explanations", async () => {
  const { parseAiExplanation } = await loadContract();
  for (const value of [null, [], "text", {}, { target: {}, sense: {} }, { ...valid, sense: { ...valid.sense, glosses_en: "wrong" } }, { ...valid, word_family: [null] }]) {
    assert.throws(() => parseAiExplanation(value), /AI/);
  }
});

test("Chinese parser requires useful text and bounds warnings", async () => {
  const { parseChineseExplanation } = await loadContract();
  assert.throws(() => parseChineseExplanation({ warnings: [] }), /AI/);
  const parsed = parseChineseExplanation({ explanation_zh: " 有意的 ", context_translation_zh: "这是有意的选择。", warnings: ["x"] });
  assert.equal(parsed.explanation_zh, "有意的");
  assert.equal(parsed.context_translation_zh, "这是有意的选择。");
});
