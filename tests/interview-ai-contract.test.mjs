import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

async function loadInterviewMapper() {
  const relativePath = "lib/career/interview-ai.ts";
  const source = await readFile(new URL(relativePath, projectRoot), "utf8");
  const { outputText, diagnostics = [] } = ts.transpileModule(source, {
    fileName: relativePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  assert.deepEqual(
    diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error),
    [],
  );
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

test("interview AI mapping preserves authored answers and labels generated candidates", async () => {
  const { createStructuredInterviewDraft } = await loadInterviewMapper();
  const current = {
    rawNotes: "我提到先定义目标，再设计验证路径。",
    questions: [
      { question: "旧问题", answer: "我的原回答", note: "我的原备注" },
      { question: "不能丢的问题", answer: "第二个回答", note: "" },
    ],
  };
  const untouched = structuredClone(current);
  const draft = createStructuredInterviewDraft({
    summary: "讨论如何处理模糊需求。",
    questions: [{
      question: "如何在模糊需求下定义方向？",
      my_answer: "模型改写出的回答",
      interviewer_follow_up: "如何验证？",
      better_answer: "先交代约束。",
    }],
    strengths: ["结构清楚"],
    improvements: ["补充量化结果"],
    next_steps: ["重写案例"],
    uncertain_items: ["面试官原话待确认"],
  }, current);

  assert.equal(draft.summary, "讨论如何处理模糊需求。");
  assert.equal(draft.questions[0].answer, "我的原回答");
  assert.match(draft.questions[0].note, /我的原备注/);
  assert.match(draft.questions[0].note, /AI 识别的追问（待确认）/);
  assert.match(draft.questions[0].note, /AI 改进建议/);
  assert.doesNotMatch(draft.questions[0].note, /回答候选/);
  assert.deepEqual(draft.questions[1], current.questions[1]);
  assert.match(draft.reflection, /做得好的地方（AI 整理，待确认）/);
  assert.match(draft.reflection, /仍需确认/);
  assert.deepEqual(current, untouched);
});

test("interview AI mapping only promotes an unauthored answer when it is grounded in raw notes", async () => {
  const { createStructuredInterviewDraft } = await loadInterviewMapper();
  const grounded = createStructuredInterviewDraft({
    questions: [{ question: "怎么推进？", my_answer: "先定义目标，再设计验证路径。" }],
  }, { rawNotes: "现场回答：先定义目标，再设计验证路径。", questions: [] });
  assert.equal(grounded.questions[0].answer, "先定义目标，再设计验证路径。");
  assert.doesNotMatch(grounded.questions[0].note, /回答候选/);

  const ungrounded = createStructuredInterviewDraft({
    questions: [{ question: "怎么推进？", my_answer: "这是模型补出的内容" }],
  }, { rawNotes: "只记得讨论了推进问题。", questions: [] });
  assert.equal(ungrounded.questions[0].answer, "");
  assert.match(ungrounded.questions[0].note, /AI 整理的回答候选（待确认）/);
});

test("interview AI mapping rejects malformed or empty output without a partial draft", async () => {
  const { createStructuredInterviewDraft } = await loadInterviewMapper();
  const current = { rawNotes: "原始速记", questions: [] };
  for (const invalid of [
    null,
    "plain text",
    [],
    {},
    { summary: 42 },
    { questions: {} },
    { questions: [null] },
    { questions: [{}] },
    { strengths: ["valid", { invalid: true }] },
    { unknown_only: "ignored" },
  ]) {
    assert.throws(() => createStructuredInterviewDraft(invalid, current), /AI/);
  }
});

test("interview AI mapping bounds generated collections and text", async () => {
  const { createStructuredInterviewDraft } = await loadInterviewMapper();
  const questions = Array.from({ length: 25 }, (_, index) => ({
    question: `问题 ${index}`,
    my_answer: null,
  }));
  const draft = createStructuredInterviewDraft({
    summary: "x".repeat(5_000),
    questions,
    strengths: Array.from({ length: 20 }, (_, index) => `优点 ${index}`),
  }, { rawNotes: "", questions: [] });
  assert.equal(draft.summary.length, 4_000);
  assert.equal(draft.questions.length, 20);
  assert.doesNotMatch(draft.reflection, /优点 12/);
});
