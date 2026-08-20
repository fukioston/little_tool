import { HttpError } from "./http";
import type { PromptBundle } from "./prompts";

type DeepSeekResult = {
  data: Record<string, unknown>;
  model: string;
  promptVersion: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
};

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function configuredEndpoint(): { endpoint: string; apiKey: string; model: string } {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new HttpError(503, "DeepSeek API Key 尚未配置。", "AI_NOT_CONFIGURED");
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
  if (!/^https:\/\//i.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl)) {
    throw new HttpError(500, "AI 服务地址配置无效。", "AI_CONFIG_INVALID");
  }
  return {
    endpoint: `${baseUrl}/chat/completions`,
    apiKey,
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
  };
}

async function requestCompletion(
  prompt: PromptBundle,
  repair?: { invalid: string; error: string },
): Promise<{ content: string; model: string; usage: DeepSeekResult["usage"] }> {
  const config = configuredEndpoint();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const messages = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  if (repair) {
    messages.push({
      role: "user",
      content: `The previous response was invalid JSON (${repair.error}). Repair it to match the requested contract. Return JSON only. Invalid response:\n${repair.invalid.slice(0, 24_000)}`,
    });
  }

  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.15,
        max_tokens: 4_000,
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const code = response.status === 401 ? "AI_AUTH_FAILED" : response.status === 429 ? "AI_RATE_LIMITED" : "AI_UPSTREAM_ERROR";
      const message = response.status === 401
        ? "DeepSeek API Key 无效或已失效。"
        : response.status === 429
          ? "AI 请求过于频繁，请稍后重试。"
          : `AI 服务暂时不可用（${response.status}）。`;
      throw new HttpError(response.status === 401 ? 401 : 502, message, code);
    }

    const raw = await response.json() as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = raw.choices?.[0]?.message?.content;
    if (!content) throw new HttpError(502, "AI 返回了空内容。", "AI_EMPTY_RESPONSE");
    const usage = raw.usage ? {
      promptTokens: raw.usage.prompt_tokens ?? 0,
      completionTokens: raw.usage.completion_tokens ?? 0,
      totalTokens: raw.usage.total_tokens ?? 0,
    } : null;
    return { content, model: raw.model || config.model, usage };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new HttpError(504, "AI 请求超时，请重试。", "AI_TIMEOUT");
    }
    throw new HttpError(502, "无法连接 AI 服务，请检查网络后重试。", "AI_CONNECTION_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}

export async function runDeepSeekJson(prompt: PromptBundle): Promise<DeepSeekResult> {
  const first = await requestCompletion(prompt);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(first.content));
  } catch (error) {
    const repaired = await requestCompletion(prompt, {
      invalid: first.content,
      error: error instanceof Error ? error.message : "invalid JSON",
    });
    try {
      parsed = JSON.parse(stripJsonFence(repaired.content));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON root must be an object");
      return { data: parsed as Record<string, unknown>, model: repaired.model, promptVersion: prompt.promptVersion, usage: repaired.usage };
    } catch {
      throw new HttpError(502, "AI 返回格式无法验证，请重新生成。", "AI_INVALID_RESPONSE");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(502, "AI 返回格式无法验证，请重新生成。", "AI_INVALID_RESPONSE");
  }
  return { data: parsed as Record<string, unknown>, model: first.model, promptVersion: prompt.promptVersion, usage: first.usage };
}
