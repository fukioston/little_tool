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
    const result = await runDeepSeekJson(careerPrompt(body.action, body.payload ?? {}));
    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
