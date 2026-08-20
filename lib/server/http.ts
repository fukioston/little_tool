export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function verifySameOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const expected = new URL(request.url).origin;
  if (origin !== expected) {
    return jsonResponse({ ok: false, error: "不允许跨站请求。", code: "ORIGIN_MISMATCH" }, 403);
  }
  return null;
}

export async function readJsonBody<T>(request: Request, maxBytes = 512_000): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "请求格式必须是 JSON。", "INVALID_CONTENT_TYPE");
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new HttpError(413, "请求内容过大。", "PAYLOAD_TOO_LARGE");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new HttpError(413, "请求内容过大。", "PAYLOAD_TOO_LARGE");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "无法解析请求内容。", "INVALID_JSON");
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse({ ok: false, error: error.message, code: error.code }, error.status);
  }
  return jsonResponse({ ok: false, error: "处理请求时发生错误，请稍后重试。", code: "INTERNAL_ERROR" }, 500);
}
