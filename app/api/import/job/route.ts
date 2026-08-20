import { runDeepSeekJson } from "@/lib/server/deepseek";
import { extractJobHtml } from "@/lib/server/extract";
import { errorResponse, HttpError, jsonResponse, readJsonBody, verifySameOrigin } from "@/lib/server/http";
import { careerPrompt } from "@/lib/server/prompts";
import { safeFetchText } from "@/lib/server/safe-fetch";

function detectSource(value: string): "linkedin" | "boss" | "other" {
  const lower = value.toLowerCase();
  if (lower.includes("linkedin.com")) return "linkedin";
  if (lower.includes("zhipin.com") || lower.includes("boss直聘")) return "boss";
  return "other";
}

export async function POST(request: Request) {
  const originError = verifySameOrigin(request);
  if (originError) return originError;
  try {
    const body = await readJsonBody<{ url?: string; text?: string }>(request, 180_000);
    if (!body.url && !body.text?.trim()) throw new HttpError(400, "请粘贴职位链接或职位描述。", "JOB_INPUT_REQUIRED");
    const source = detectSource(`${body.url || ""} ${body.text || ""}`);
    let publicPage: ReturnType<typeof extractJobHtml> | null = null;
    let fetchWarning: string | null = null;
    if (body.url) {
      try {
        const fetched = await safeFetchText(body.url, { maxBytes: 1_500_000 });
        publicPage = extractJobHtml(fetched.text, fetched.url);
      } catch (error) {
        fetchWarning = error instanceof Error ? error.message : "平台页面无法直接读取。";
      }
    }
    const result = await runDeepSeekJson(careerPrompt("parse_job", {
      source,
      original_url: body.url || null,
      shared_or_pasted_text: body.text?.slice(0, 80_000) || null,
      public_page_metadata: publicPage,
      note: fetchWarning,
    }));
    return jsonResponse({ ok: true, source, originalUrl: body.url || null, data: result.data, warning: fetchWarning, meta: { model: result.model, promptVersion: result.promptVersion } });
  } catch (error) { return errorResponse(error); }
}
