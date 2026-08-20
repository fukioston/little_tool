import { assertPublicHttpUrl } from "@/lib/server/safe-fetch";
import { errorResponse, HttpError } from "@/lib/server/http";

const MAX_REDIRECTS = 4;
const MAX_MEDIA_BYTES = 500 * 1024 * 1024;

export async function GET(request: Request) {
  try {
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      throw new HttpError(403, "不允许跨站读取媒体。", "MEDIA_ORIGIN_BLOCKED");
    }
    const input = new URL(request.url).searchParams.get("url");
    if (!input) throw new HttpError(400, "缺少媒体链接。", "MEDIA_URL_REQUIRED");
    let url = assertPublicHttpUrl(input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        const headers = new Headers({
          Accept: "audio/*,application/ogg,application/octet-stream;q=0.7",
          "User-Agent": "PrivateAISuite/1.0 (personal local podcast player)",
        });
        const range = request.headers.get("range");
        if (range && /^bytes=\d*-\d*$/.test(range)) headers.set("Range", range);
        const upstream = await fetch(url, { redirect: "manual", headers, signal: controller.signal });
        if ([301, 302, 303, 307, 308].includes(upstream.status)) {
          const location = upstream.headers.get("location");
          if (!location) throw new HttpError(502, "音频链接重定向异常。", "MEDIA_REDIRECT_INVALID");
          url = assertPublicHttpUrl(new URL(location, url).toString());
          continue;
        }
        if (!upstream.ok && upstream.status !== 206) {
          throw new HttpError(502, `音频源暂时不可用（${upstream.status}）。`, "MEDIA_UPSTREAM_ERROR");
        }
        const contentType = upstream.headers.get("content-type") || "application/octet-stream";
        const looksLikeAudio = /^audio\//i.test(contentType) || /ogg|octet-stream/i.test(contentType) || /\.(mp3|m4a|aac|wav|ogg|opus)(?:$|\?)/i.test(url.pathname);
        if (!looksLikeAudio) throw new HttpError(415, "远程链接不是受支持的音频。", "MEDIA_TYPE_UNSUPPORTED");
        const size = Number(upstream.headers.get("content-length") || 0);
        if (size > MAX_MEDIA_BYTES) throw new HttpError(413, "音频文件超过 500 MB。", "MEDIA_TOO_LARGE");
        const responseHeaders = new Headers({
          "Content-Type": contentType,
          "Cache-Control": "private, max-age=3600",
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
        });
        for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
          const value = upstream.headers.get(name);
          if (value) responseHeaders.set(name, value);
        }
        return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
      }
      throw new HttpError(502, "音频链接重定向次数过多。", "MEDIA_TOO_MANY_REDIRECTS");
    } finally { clearTimeout(timeout); }
  } catch (error) { return errorResponse(error); }
}
