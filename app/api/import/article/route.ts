import { extractReadableHtml } from "@/lib/server/extract";
import { errorResponse, HttpError, jsonResponse, readJsonBody, verifySameOrigin } from "@/lib/server/http";
import { safeFetchText } from "@/lib/server/safe-fetch";

export async function POST(request: Request) {
  const originError = verifySameOrigin(request);
  if (originError) return originError;
  try {
    const { url } = await readJsonBody<{ url?: string }>(request, 32_000);
    if (!url) throw new HttpError(400, "请输入文章链接。", "URL_REQUIRED");
    const fetched = await safeFetchText(url);
    const content = /html|xhtml/.test(fetched.contentType)
      ? extractReadableHtml(fetched.text, fetched.url)
      : { title: new URL(fetched.url).hostname, author: null, description: null, canonicalUrl: fetched.url, blocks: fetched.text.split(/\n{2,}/).filter(Boolean).map((text, ordinal) => ({ ordinal, kind: "paragraph", text: text.trim() })), text: fetched.text };
    if (content.text.trim().length < 80) throw new HttpError(422, "没有提取到足够的正文，请改为粘贴内容。", "ARTICLE_EXTRACTION_EMPTY");
    return jsonResponse({ ok: true, data: content });
  } catch (error) { return errorResponse(error); }
}
