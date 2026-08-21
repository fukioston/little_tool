import {
  parseAdaptSessionInput,
  parseEquipmentDraft,
  parseEquipmentDraftInput,
  parsePlanDraft,
  parsePlanDraftInput,
  parseSessionAdaptation,
  type AdaptSessionInput,
  type EquipmentDraft,
  type EquipmentDraftInput,
  type FitnessAiAction,
  type PlanDraft,
  type PlanDraftInput,
  type SessionAdaptationDraft,
} from "./ai-contract";

export function fitnessAiErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "AI 草稿暂时无法生成，请稍后重试。";
}

async function postFitnessAi(action: FitnessAiAction, payload: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch("/api/ai/fitness", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, payload }),
    signal,
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body: unknown = contentType.includes("json")
    ? await response.json()
    : { error: await response.text() };
  const root = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (!response.ok) {
    throw new Error(String(root.error ?? root.message ?? `AI 请求失败（${response.status}）`));
  }
  const data = root.data ?? root.result;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("AI 服务没有返回可核对的草稿。");
  }
  return data as Record<string, unknown>;
}

export async function createEquipmentDraft(
  input: EquipmentDraftInput,
  signal?: AbortSignal,
): Promise<EquipmentDraft> {
  const safeInput = parseEquipmentDraftInput(input);
  const result = await postFitnessAi("equipment_draft", safeInput, signal);
  return parseEquipmentDraft(result);
}

export async function createPlanDraft(
  input: PlanDraftInput,
  signal?: AbortSignal,
): Promise<PlanDraft> {
  const safeInput = parsePlanDraftInput(input);
  const result = await postFitnessAi("plan_draft", safeInput, signal);
  return parsePlanDraft(result, safeInput);
}

export async function createSessionAdaptation(
  input: AdaptSessionInput,
  signal?: AbortSignal,
): Promise<SessionAdaptationDraft> {
  const safeInput = parseAdaptSessionInput(input);
  const result = await postFitnessAi("adapt_session", safeInput, signal);
  return parseSessionAdaptation(result, safeInput);
}
