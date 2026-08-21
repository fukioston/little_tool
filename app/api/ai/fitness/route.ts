import {
  FitnessAiContractError,
  isFitnessAiAction,
  parseAdaptSessionInput,
  parseEquipmentDraft,
  parseEquipmentDraftInput,
  parsePlanDraft,
  parsePlanDraftInput,
  parseSessionAdaptation,
  type AdaptSessionInput,
  type FitnessAiInput,
  type FitnessAiResult,
  type PlanDraftInput,
} from "@/lib/fitness/ai-contract";
import { runDeepSeekJson } from "@/lib/server/deepseek";
import { fitnessPrompt } from "@/lib/server/prompts";
import { errorResponse, HttpError, jsonResponse, readJsonBody, verifySameOrigin } from "@/lib/server/http";

function validateInput(action: "equipment_draft" | "plan_draft" | "adapt_session", value: unknown): FitnessAiInput {
  try {
    if (action === "equipment_draft") return parseEquipmentDraftInput(value);
    if (action === "plan_draft") return parsePlanDraftInput(value);
    return parseAdaptSessionInput(value);
  } catch (error) {
    if (error instanceof FitnessAiContractError) {
      throw new HttpError(400, error.message, "FITNESS_AI_INPUT_INVALID");
    }
    throw error;
  }
}

function validateResult(
  action: "equipment_draft" | "plan_draft" | "adapt_session",
  value: unknown,
  input: FitnessAiInput,
): FitnessAiResult {
  try {
    if (action === "equipment_draft") return parseEquipmentDraft(value);
    if (action === "plan_draft") return parsePlanDraft(value, input as PlanDraftInput);
    return parseSessionAdaptation(value, input as AdaptSessionInput);
  } catch (error) {
    if (error instanceof FitnessAiContractError) {
      throw new HttpError(502, "AI 返回的草稿无法安全核对，请重新生成。", "FITNESS_AI_RESPONSE_INVALID");
    }
    throw error;
  }
}

export async function POST(request: Request) {
  const originError = verifySameOrigin(request);
  if (originError) return originError;
  try {
    const body = await readJsonBody<{ action?: unknown; payload?: unknown }>(request, 160_000);
    if (!isFitnessAiAction(body.action)) {
      throw new HttpError(400, "不支持这个适练 AI 功能。", "FITNESS_AI_ACTION_UNSUPPORTED");
    }
    const input = validateInput(body.action, body.payload ?? {});
    const result = await runDeepSeekJson(
      fitnessPrompt(body.action, input),
      request.signal,
    );
    const data = validateResult(body.action, result.data, input);
    return jsonResponse({ ok: true, ...result, data });
  } catch (error) {
    return errorResponse(error);
  }
}
