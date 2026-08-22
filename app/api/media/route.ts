import {
  assertPublicHttpUrl,
  assertPublicRemoteTarget,
  fetchPinnedRemoteTarget,
} from "@/lib/server/safe-fetch";
import { errorResponse, HttpError } from "@/lib/server/http";

const MAX_REDIRECTS = 4;
const MAX_MEDIA_BYTES = 500 * 1024 * 1024;
const SAFE_AUDIO_CONTENT_TYPES = new Set([
  "audio/3gpp",
  "audio/3gpp2",
  "audio/aac",
  "audio/ac3",
  "audio/amr",
  "audio/basic",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "audio/vnd.wave",
  "audio/wav",
  "audio/webm",
  "audio/x-aac",
  "audio/x-flac",
  "audio/x-m4a",
  "audio/x-wav",
]);

function safeMediaContentType(value: string | null): string | null {
  const raw = value?.trim() ?? "";
  if (!raw) return "application/octet-stream";
  // Multiple/conflicting Content-Type fields are combined with a comma by
  // Headers. Never choose one side of that conflict, and never reflect params.
  if (raw.includes(",") || /[\r\n]/.test(raw)) return null;
  const essence = raw.split(";", 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(essence)) return null;
  if (essence === "application/octet-stream") return essence;
  if (essence === "application/ogg") return "audio/ogg";
  return SAFE_AUDIO_CONTENT_TYPES.has(essence) ? essence : null;
}

function boundedMediaBody(
  source: ReadableStream<Uint8Array>,
  abort: AbortController,
  onFinish: () => void,
) {
  const reader = source.getReader();
  let total = 0;
  let finished = false;
  let inactivity = setTimeout(() => abort.abort(), 30_000);
  const refreshTimeout = () => {
    clearTimeout(inactivity);
    inactivity = setTimeout(() => abort.abort(), 30_000);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(inactivity);
    onFinish();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        refreshTimeout();
        total += value.byteLength;
        if (total > MAX_MEDIA_BYTES) {
          finish();
          abort.abort();
          await reader.cancel("media byte limit exceeded").catch(() => undefined);
          controller.error(new Error("远程音频超过 500 MiB，传输已停止。"));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      abort.abort();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

export async function GET(request: Request) {
  try {
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      throw new HttpError(403, "不允许跨站读取媒体。", "MEDIA_ORIGIN_BLOCKED");
    }
    const input = new URL(request.url).searchParams.get("url");
    if (!input) throw new HttpError(400, "缺少媒体链接。", "MEDIA_URL_REQUIRED");
    if (request.signal.aborted) {
      throw new HttpError(499, "音频读取已停止。", "REQUEST_CANCELLED");
    }
    let url = assertPublicHttpUrl(input);
    const controller = new AbortController();
    let firstCause: "caller" | "timeout" | null = null;
    const abortFromCaller = () => {
      if (firstCause !== null) return;
      firstCause = "caller";
      controller.abort(request.signal.reason);
    };
    request.signal.addEventListener("abort", abortFromCaller, { once: true });
    if (request.signal.aborted) abortFromCaller();
    const timeout = setTimeout(() => {
      if (firstCause !== null) return;
      firstCause = "timeout";
      controller.abort(new DOMException("media timeout", "TimeoutError"));
    }, 30_000);
    let handedOff = false;
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abortFromCaller);
    };
    try {
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        const target = await assertPublicRemoteTarget(url, undefined, controller.signal);
        url = target.url;
        if (firstCause === "caller") {
          throw new HttpError(499, "音频读取已停止。", "REQUEST_CANCELLED");
        }
        if (firstCause === "timeout") {
          throw new HttpError(504, "音频源响应超时。", "MEDIA_TIMEOUT");
        }
        const headers = new Headers({
          Accept: "audio/*,application/ogg,application/octet-stream;q=0.7",
          "User-Agent": "PrivateAISuite/1.0 (personal local podcast player)",
        });
        const range = request.headers.get("range");
        if (range && /^bytes=\d*-\d*$/.test(range)) headers.set("Range", range);
        const upstream = await fetchPinnedRemoteTarget(target, {
          redirect: "manual",
          headers,
          signal: controller.signal,
        });
        if (firstCause === "caller") {
          await upstream.body?.cancel().catch(() => undefined);
          throw new HttpError(499, "音频读取已停止。", "REQUEST_CANCELLED");
        }
        if (firstCause === "timeout") {
          await upstream.body?.cancel().catch(() => undefined);
          throw new HttpError(504, "音频源响应超时。", "MEDIA_TIMEOUT");
        }
        if ([301, 302, 303, 307, 308].includes(upstream.status)) {
          const location = upstream.headers.get("location");
          await upstream.body?.cancel().catch(() => undefined);
          if (!location) throw new HttpError(502, "音频链接重定向异常。", "MEDIA_REDIRECT_INVALID");
          url = assertPublicHttpUrl(new URL(location, url).toString());
          continue;
        }
        if (!upstream.ok && upstream.status !== 206) {
          await upstream.body?.cancel().catch(() => undefined);
          throw new HttpError(502, `音频源暂时不可用（${upstream.status}）。`, "MEDIA_UPSTREAM_ERROR");
        }
        const contentType = safeMediaContentType(upstream.headers.get("content-type"));
        if (!contentType) {
          await upstream.body?.cancel().catch(() => undefined);
          throw new HttpError(415, "远程链接不是受支持的音频。", "MEDIA_TYPE_UNSUPPORTED");
        }
        const size = Number(upstream.headers.get("content-length") || 0);
        if (size > MAX_MEDIA_BYTES) {
          await upstream.body?.cancel().catch(() => undefined);
          throw new HttpError(413, "音频文件超过 500 MiB。", "MEDIA_TOO_LARGE");
        }
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
        if (!upstream.body) throw new HttpError(502, "音频源没有返回可读取内容。", "MEDIA_BODY_MISSING");
        clearTimeout(timeout);
        const body = boundedMediaBody(upstream.body, controller, cleanup);
        handedOff = true;
        return new Response(body, { status: upstream.status, headers: responseHeaders });
      }
      throw new HttpError(502, "音频链接重定向次数过多。", "MEDIA_TOO_MANY_REDIRECTS");
    } catch (error) {
      if (firstCause === "caller") {
        throw new HttpError(499, "音频读取已停止。", "REQUEST_CANCELLED");
      }
      if (firstCause === "timeout") {
        throw new HttpError(504, "音频源响应超时。", "MEDIA_TIMEOUT");
      }
      if (!(error instanceof HttpError)) {
        throw new HttpError(502, "无法安全连接这个音频源。", "MEDIA_FETCH_FAILED");
      }
      throw error;
    } finally {
      if (!handedOff) cleanup();
    }
  } catch (error) { return errorResponse(error); }
}
