import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const relativePath = "lib/vocab/ai-payload.ts";
const source = await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  fileName: relativePath,
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const payloads = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

function dataModule(moduleSource, sourceName) {
  return `data:text/javascript;base64,${Buffer.from(`${moduleSource}\n//# sourceURL=${sourceName}`).toString("base64")}`;
}

async function transpile(relativeModulePath) {
  const input = await readFile(new URL(`../${relativeModulePath}`, import.meta.url), "utf8");
  return ts.transpileModule(input, {
    fileName: relativeModulePath,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

async function loadVocabAiRoute() {
  const payloadUrl = dataModule(output, relativePath);
  const deepSeekUrl = dataModule(`
    export async function runDeepSeekJson(prompt, signal) {
      globalThis.__vocabAiDeepSeekCalls.push({ prompt, signal });
      return { data: { accepted: true }, model: "stub", promptVersion: prompt.promptVersion, usage: null };
    }
  `, "tests/stubs/vocab-deepseek.mjs");
  const promptsUrl = dataModule(`
    export function vocabPrompt(action, payload) {
      globalThis.__vocabAiPromptCalls.push({ action, payload });
      return { system: "test", user: "test", promptVersion: "vocab-test" };
    }
  `, "tests/stubs/vocab-prompts.mjs");
  const httpUrl = dataModule(await transpile("lib/server/http.ts"), "lib/server/http.ts");
  const routeOutput = (await transpile("app/api/ai/vocab/route.ts"))
    .replaceAll('"@/lib/vocab/ai-payload"', JSON.stringify(payloadUrl))
    .replaceAll('"@/lib/server/deepseek"', JSON.stringify(deepSeekUrl))
    .replaceAll('"@/lib/server/prompts"', JSON.stringify(promptsUrl))
    .replaceAll('"@/lib/server/http"', JSON.stringify(httpUrl));
  return import(dataModule(routeOutput, "app/api/ai/vocab/route.ts"));
}

test("explain payload is rebuilt from the exact disclosed fields", () => {
  const result = payloads.sanitizeVocabAiRequestPayload("explain", {
    schema_version: "PRIVATE_SCHEMA",
    target: {
      surface: " deliberate ",
      start_utf16: 9,
      end_utf16: 19,
      item_id: "PRIVATE_ITEM",
    },
    context: {
      sentence: "It was a deliberate choice.",
      preceding_sentence: "They discussed it.",
      following_sentence: "Then they acted.",
      whole_article: "PRIVATE_ARTICLE",
    },
    learner: {
      include_simplified_chinese: true,
      profile_note: "PRIVATE_PROFILE",
    },
    reading_history: "PRIVATE_HISTORY",
  });

  assert.deepEqual(result, {
    schema_version: "1.0",
    target: { surface: "deliberate", start_utf16: 9, end_utf16: 19 },
    context: {
      sentence: "It was a deliberate choice.",
      preceding_sentence: "They discussed it",
      following_sentence: "Then they acted",
    },
    learner: {
      interface_language: "zh-CN",
      explanation_language: "en",
      include_simplified_chinese: true,
    },
  });
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.context), true);
});

test("Chinese follow-up keeps only the selected sentence and concise English sense", () => {
  const result = payloads.sanitizeVocabAiRequestPayload("explainChinese", {
    target: { surface: "deliberate", canonical: "PRIVATE_CANONICAL" },
    context: { sentence: "It was deliberate.", full_article: "PRIVATE_ARTICLE" },
    english_explanation: {
      target: { canonical: "PRIVATE_TARGET" },
      sense: {
        glosses_en: ["intentional"],
        meaning_in_context_en: "Done on purpose.",
        explanation_en: "It describes a conscious choice.",
        explanation_zh: "PRIVATE_CHINESE",
      },
      word_family: ["PRIVATE_FAMILY"],
      warnings: ["PRIVATE_WARNING"],
    },
  });

  assert.deepEqual(result, {
    schema_version: "1.0",
    target: { surface: "deliberate" },
    context: { sentence: "It was deliberate." },
    english_explanation: {
      glosses_en: ["intentional"],
      meaning_in_context_en: "Done on purpose.",
      explanation_en: "It describes a conscious choice.",
    },
  });
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
});

test("missing required context and unopened actions are rejected before prompting", () => {
  assert.throws(
    () => payloads.sanitizeVocabAiRequestPayload("explain", {
      target: { surface: "word", start_utf16: 0, end_utf16: 4 },
      context: { sentence: "" },
    }),
    payloads.VocabAiPayloadValidationError,
  );
  assert.throws(
    () => payloads.sanitizeVocabAiRequestPayload("explain", {
      target: { surface: "word", start_utf16: 100, end_utf16: 104 },
      context: { sentence: "word" },
    }),
    payloads.VocabAiPayloadValidationError,
  );
  assert.throws(
    () => payloads.sanitizeVocabAiRequestPayload("explain", {
      target: { surface: "word", start_utf16: 0, end_utf16: 4 },
      context: { sentence: "ward" },
    }),
    payloads.VocabAiPayloadValidationError,
  );
  assert.throws(
    () => payloads.sanitizeVocabAiRequestPayload("article_insights", {}),
    payloads.VocabAiActionNotAllowedError,
  );
});

test("sentence context returns UTF-16 offsets in the disclosed trimmed sentence", async () => {
  const content = await import(dataModule(await transpile("lib/vocab/content.ts"), "lib/vocab/content.ts"));
  const text = "First thought.   A deliberate 😀 choice follows.";
  const start = text.indexOf("deliberate");
  const result = content.sentenceContext(text, start, start + "deliberate".length);
  assert.equal(result.sentence, "A deliberate 😀 choice follows.");
  assert.equal(result.sentence.slice(result.startUtf16, result.endUtf16), "deliberate");
  assert.equal(result.before, "First thought");
  assert.equal(result.after, "");
});

test("canonical Unicode normalization preserves a later selection and recomputes its offsets", () => {
  const sentence = "Cafe\u0301 deliberate choice.";
  const surface = "deliberate";
  const start = sentence.indexOf(surface);
  const safe = payloads.sanitizeVocabAiRequestPayload("explain", {
    target: {
      surface,
      start_utf16: start,
      end_utf16: start + surface.length,
    },
    context: { sentence },
  });
  assert.equal(safe.context.sentence, "Café deliberate choice.");
  assert.equal(safe.target.start_utf16, "Café ".length);
  assert.equal(safe.target.end_utf16, "Café deliberate".length);
  assert.equal(
    safe.context.sentence.slice(safe.target.start_utf16, safe.target.end_utf16),
    surface,
  );
});

test("only one adjacent sentence is disclosed across newlines and semicolons", async () => {
  const content = await import(dataModule(await transpile("lib/vocab/content.ts"), "lib/vocab/content-adjacent.ts"));
  const text = "PRIVATE ONE\nPRIVATE TWO; selected word.\nPRIVATE NEXT; PRIVATE AFTER";
  const start = text.indexOf("selected");
  const result = content.sentenceContext(text, start, start + "selected".length);
  assert.equal(result.sentence, "selected word.");
  assert.equal(result.before, "PRIVATE TWO");
  assert.equal(result.after, "PRIVATE NEXT");
  assert.equal(result.sentence.slice(result.startUtf16, result.endUtf16), "selected");

  const safe = payloads.sanitizeVocabAiRequestPayload("explain", {
    target: { surface: "selected", start_utf16: 0, end_utf16: 8 },
    context: {
      sentence: "selected word.",
      preceding_sentence: "PRIVATE ONE. PRIVATE TWO.",
      following_sentence: "PRIVATE NEXT; PRIVATE AFTER",
    },
  });
  assert.equal(safe.context.preceding_sentence, "PRIVATE TWO");
  assert.equal(safe.context.following_sentence, "PRIVATE NEXT");
});

test("podcast segment fallbacks disclose only the nearest adjacent sentence", async () => {
  const content = await import(dataModule(await transpile("lib/vocab/content.ts"), "lib/vocab/content-segment-edge.ts"));
  assert.equal(
    content.adjacentSentence("PRIVATE ONE. PRIVATE TWO.", "preceding"),
    "PRIVATE TWO",
  );
  assert.equal(
    content.adjacentSentence("PRIVATE NEXT; PRIVATE AFTER", "following"),
    "PRIVATE NEXT",
  );

  const viewSource = await readFile(new URL("../app/vocab/views.tsx", import.meta.url), "utf8");
  assert.match(viewSource, /adjacentSentence\(episodeSegments\[index-1\]\?\.text \?\? "", "preceding"\)/);
  assert.match(viewSource, /adjacentSentence\(episodeSegments\[index\+1\]\?\.text \?\? "", "following"\)/);
  assert.doesNotMatch(viewSource, /context\.before \|\| episodeSegments\[index-1\]\?\.text/);
});

test("the route sanitizes before the prompt and the client no longer sends the full explanation object", async () => {
  const [route, client] = await Promise.all([
    readFile(new URL("../app/api/ai/vocab/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/vocab/api.ts", import.meta.url), "utf8"),
  ]);
  const sanitizeIndex = route.indexOf("sanitizeVocabAiRequestPayload(");
  const promptIndex = route.indexOf("vocabPrompt(body.action, safePayload)");
  assert.ok(sanitizeIndex >= 0 && promptIndex > sanitizeIndex);
  assert.doesNotMatch(client, /english_explanation:\s*explanation\b/);
  assert.match(client, /meaning_in_context_en:\s*explanation\.sense\?\.meaning_in_context_en/);
});

test("the live route passes only sanitized fields to the prompt and rejects unopened actions before AI", async () => {
  const route = await loadVocabAiRoute();
  globalThis.__vocabAiPromptCalls = [];
  globalThis.__vocabAiDeepSeekCalls = [];
  const request = new Request("http://localhost/api/ai/vocab", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "explain",
      payload: {
        target: { surface: "deliberate", start_utf16: 2, end_utf16: 12, item_id: "PRIVATE_ITEM" },
        context: { sentence: "A deliberate choice.", whole_article: "PRIVATE_ARTICLE" },
        learner: { include_simplified_chinese: false, profile: "PRIVATE_PROFILE" },
      },
    }),
  });
  const accepted = await route.POST(request);
  assert.equal(accepted.status, 200);
  assert.equal(globalThis.__vocabAiPromptCalls.length, 1);
  assert.equal(globalThis.__vocabAiDeepSeekCalls.length, 1);
  assert.equal(JSON.stringify(globalThis.__vocabAiPromptCalls[0]).includes("PRIVATE_"), false);
  assert.equal(globalThis.__vocabAiDeepSeekCalls[0].signal, request.signal);

  globalThis.__vocabAiPromptCalls = [];
  globalThis.__vocabAiDeepSeekCalls = [];
  const rejected = await route.POST(new Request("http://localhost/api/ai/vocab", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "article_insights",
      payload: { full_article: "PRIVATE_ARTICLE" },
    }),
  }));
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), {
    ok: false,
    error: "这个词习 AI 功能尚未开放。",
    code: "VOCAB_AI_ACTION_NOT_ALLOWED",
  });
  assert.equal(globalThis.__vocabAiPromptCalls.length, 0);
  assert.equal(globalThis.__vocabAiDeepSeekCalls.length, 0);
});
