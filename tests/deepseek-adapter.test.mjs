import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../lib/server/deepseek.ts", import.meta.url),
  "utf8",
);

test("structured DeepSeek requests explicitly disable default thinking mode", () => {
  assert.match(source, /thinking:\s*\{\s*type:\s*["']disabled["']\s*\}/);
  assert.match(source, /response_format:\s*\{\s*type:\s*["']json_object["']\s*\}/);
  assert.match(source, /max_tokens:\s*4_000/);
});

test("an empty JSON response is retried once with a modified prompt", () => {
  assert.match(source, /error\.code\s*!==\s*["']AI_EMPTY_RESPONSE["']/);
  assert.match(source, /first JSON response was empty/);
  const calls = source.match(/first\s*=\s*await requestCompletion\(/g) ?? [];
  assert.equal(calls.length, 2, "the bounded adapter should have one initial attempt and one empty retry");
  assert.doesNotMatch(source, /while\s*\(/, "the adapter must not retry without a bound");
});
