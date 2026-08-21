import { runDeepSeekJson } from "@/lib/server/deepseek";
import { vocabPrompt } from "@/lib/server/prompts";
import { errorResponse, HttpError, jsonResponse, readJsonBody, verifySameOrigin } from "@/lib/server/http";
import {
  sanitizeVocabAiRequestPayload,
  VocabAiActionNotAllowedError,
  VocabAiPayloadValidationError,
} from "@/lib/vocab/ai-payload";

export async function POST(request: Request) {
  const originError = verifySameOrigin(request);
  if (originError) return originError;
  try {
    const body = await readJsonBody<{ action?: string; payload?: unknown }>(request);
    if (!body.action || typeof body.action !== "string") {
      throw new HttpError(400, "缺少 AI 功能名称。", "ACTION_REQUIRED");
    }
    const safePayload = sanitizeVocabAiRequestPayload(body.action, body.payload ?? {});
    const result = await runDeepSeekJson(
      vocabPrompt(body.action, safePayload),
      request.signal,
    );
    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    if (error instanceof VocabAiActionNotAllowedError) {
      return errorResponse(new HttpError(
        400,
        "这个词习 AI 功能尚未开放。",
        "VOCAB_AI_ACTION_NOT_ALLOWED",
      ));
    }
    if (error instanceof VocabAiPayloadValidationError) {
      return errorResponse(new HttpError(
        400,
        "这次解释所需的文字不完整，请重新选择后再试。",
        "VOCAB_AI_INPUT_INCOMPLETE",
      ));
    }
    return errorResponse(error);
  }
}
