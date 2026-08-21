import {
  CareerAiActionNotAllowedError,
  CareerAiPayloadValidationError,
  sanitizeCareerAiRequestPayload,
} from "@/lib/career/ai-payload";
import { runDeepSeekJson } from "@/lib/server/deepseek";
import { careerPrompt } from "@/lib/server/prompts";
import { errorResponse, HttpError, jsonResponse, readJsonBody, verifySameOrigin } from "@/lib/server/http";

export async function POST(request: Request) {
  const originError = verifySameOrigin(request);
  if (originError) return originError;
  try {
    const body = await readJsonBody<{ action?: string; payload?: unknown }>(request);
    if (!body.action || typeof body.action !== "string") {
      throw new HttpError(400, "缺少 AI 功能名称。", "ACTION_REQUIRED");
    }
    const safePayload = sanitizeCareerAiRequestPayload(body.action, body.payload ?? {});
    const result = await runDeepSeekJson(
      careerPrompt(body.action, safePayload),
      request.signal,
    );
    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    if (error instanceof CareerAiActionNotAllowedError) {
      return errorResponse(new HttpError(
        400,
        "这个 AI 功能尚未开放。",
        "CAREER_AI_ACTION_NOT_ALLOWED",
      ));
    }
    if (error instanceof CareerAiPayloadValidationError) {
      return errorResponse(new HttpError(
        400,
        "AI 所需的信息不完整，请补全后再试。",
        "CAREER_AI_INPUT_INCOMPLETE",
      ));
    }
    return errorResponse(error);
  }
}
