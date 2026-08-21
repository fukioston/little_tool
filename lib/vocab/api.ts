import type { AiExplanation, SelectionTarget } from "./types";
import { parseAiExplanation, parseChineseExplanation } from "./ai-contract";

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "发生了未知错误";
}

export async function postJson(path: string, body: unknown, signal?: AbortSignal) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("json") ? await response.json() : { error: await response.text() };
  if (!response.ok) {
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    throw new Error(String(record.error ?? record.message ?? `请求失败（${response.status}）`));
  }
  return payload as Record<string, unknown>;
}

function dataOf(value: Record<string, unknown>) {
  const candidate = value.data ?? value.result ?? value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("服务返回格式无法识别");
  return candidate as Record<string, unknown>;
}

export async function explainSelection(target: SelectionTarget, includeChinese: boolean, signal?: AbortSignal) {
  const response = await postJson("/api/ai/vocab", {
    action: "explain",
    payload: {
      schema_version: "1.0",
      target: {
        surface: target.surface,
        start_utf16: target.contextStartUtf16 ?? target.startUtf16,
        end_utf16: target.contextEndUtf16 ?? target.endUtf16,
      },
      context: { sentence: target.sentence, preceding_sentence: target.before || null, following_sentence: target.after || null },
      learner: { interface_language: "zh-CN", explanation_language: "en", include_simplified_chinese: includeChinese },
    },
  }, signal);
  return parseAiExplanation(dataOf(response));
}

export async function explainInChinese(explanation: AiExplanation, target: SelectionTarget, signal?: AbortSignal) {
  const response = await postJson("/api/ai/vocab", {
    action: "explain_chinese",
    payload: {
      schema_version: "1.0",
      target: { surface: target.surface },
      context: { sentence: target.sentence },
      english_explanation: {
        glosses_en: explanation.sense?.glosses_en ?? [],
        meaning_in_context_en: explanation.sense?.meaning_in_context_en ?? null,
        explanation_en: explanation.sense?.explanation_en ?? null,
      },
    },
  }, signal);
  return parseChineseExplanation(dataOf(response));
}
