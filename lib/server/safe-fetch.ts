import { HttpError } from "./http";

const MAX_REDIRECTS = 4;

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

export function assertPublicHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "链接格式不正确。", "INVALID_URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, "仅支持 HTTP 或 HTTPS 链接。", "INVALID_URL_SCHEME");
  }
  if (url.username || url.password) throw new HttpError(400, "链接不能包含登录凭据。", "URL_CREDENTIALS_BLOCKED");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
    host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") ||
    host.startsWith("fe80:") || isPrivateIpv4(host) || host === "169.254.169.254"
  ) {
    throw new HttpError(400, "出于安全原因，不能访问本机或私有网络地址。", "PRIVATE_URL_BLOCKED");
  }
  return url;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new HttpError(413, "远程内容过大。", "REMOTE_CONTENT_TOO_LARGE");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "远程内容过大。", "REMOTE_CONTENT_TOO_LARGE");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function safeFetchText(
  input: string,
  options: { maxBytes?: number; accept?: string } = {},
): Promise<{ text: string; url: string; contentType: string; headers: Headers }> {
  let url = assertPublicHttpUrl(input);
  const maxBytes = options.maxBytes ?? 2_000_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: options.accept || "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.2",
            "User-Agent": "PrivateAISuite/1.0 (personal local reader)",
          },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new HttpError(504, "读取远程内容超时。", "REMOTE_TIMEOUT");
        }
        throw new HttpError(502, "无法读取这个链接，请改为粘贴内容。", "REMOTE_FETCH_FAILED");
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new HttpError(502, "远程链接重定向异常。", "REMOTE_REDIRECT_INVALID");
        url = assertPublicHttpUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) {
        const message = response.status === 401 || response.status === 403
          ? "该页面需要登录或禁止自动读取，请粘贴职位/文章正文。"
          : `读取链接失败（${response.status}），请改为粘贴内容。`;
        throw new HttpError(502, message, "REMOTE_FETCH_REJECTED");
      }
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!/(text|html|xml|json|rss|atom)/.test(contentType)) {
        throw new HttpError(415, "这个链接不是可读取的文字内容。", "REMOTE_CONTENT_UNSUPPORTED");
      }
      return { text: await readBoundedText(response, maxBytes), url: url.toString(), contentType, headers: response.headers };
    }
    throw new HttpError(502, "远程链接重定向次数过多。", "TOO_MANY_REDIRECTS");
  } finally {
    clearTimeout(timeout);
  }
}
