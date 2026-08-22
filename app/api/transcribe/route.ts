import { errorResponse, HttpError, jsonResponse, verifySameOrigin } from "@/lib/server/http";
import {
  composeRequestSignal,
  isAbortLike,
  readBoundedAbortableFormData,
  RequestBodyTooLargeError,
} from "@/lib/server/request-signal";
import { VOCAB_TRANSCRIPTION_AUDIO_MAX_BYTES } from "@/lib/vocab/content";

const TRANSCRIPTION_MULTIPART_OVERHEAD_MAX_BYTES = 1024 * 1024;
const TRANSCRIPTION_MULTIPART_MAX_BYTES =
  VOCAB_TRANSCRIPTION_AUDIO_MAX_BYTES + TRANSCRIPTION_MULTIPART_OVERHEAD_MAX_BYTES;

export async function POST(request: Request) {
  const originError = verifySameOrigin(request);
  if (originError) return originError;
  try {
    const apiKey = process.env.TRANSCRIPTION_API_KEY?.trim();
    const baseUrl = process.env.TRANSCRIPTION_BASE_URL?.trim().replace(/\/+$/, "");
    const model = process.env.TRANSCRIPTION_MODEL?.trim() || "whisper-1";
    if (!apiKey || !baseUrl) {
      throw new HttpError(503, "尚未配置语音转录服务。你仍可导入 SRT、VTT、LRC 或纯文本字幕。", "TRANSCRIPTION_NOT_CONFIGURED");
    }
    if (!/^https:\/\//i.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl)) {
      throw new HttpError(500, "转录服务地址配置无效。", "TRANSCRIPTION_CONFIG_INVALID");
    }
    if (request.signal.aborted) {
      throw new HttpError(499, "转录已停止。", "REQUEST_CANCELLED");
    }
    const incoming = await readBoundedAbortableFormData(
      request,
      TRANSCRIPTION_MULTIPART_MAX_BYTES,
    );
    const file = incoming.get("file");
    if (!(file instanceof File) || file.size === 0) throw new HttpError(400, "请选择有效的音频文件。", "AUDIO_REQUIRED");
    if (file.size > VOCAB_TRANSCRIPTION_AUDIO_MAX_BYTES) {
      throw new HttpError(413, "音频文件不能超过 100 MiB。", "AUDIO_TOO_LARGE");
    }
    const upstream = new FormData();
    upstream.set("file", file, file.name.replace(/[\\/\0]/g, "_").slice(0, 120));
    upstream.set("model", model);
    upstream.set("response_format", "verbose_json");
    upstream.append("timestamp_granularities[]", "segment");
    const language = incoming.get("language");
    if (typeof language === "string" && /^[a-z]{2,3}$/i.test(language)) upstream.set("language", language);
    if (request.signal.aborted) {
      throw new HttpError(499, "转录已停止。", "REQUEST_CANCELLED");
    }
    const upstreamSignal = composeRequestSignal(request.signal, 10 * 60_000);
    try {
      const response = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: upstream,
        signal: upstreamSignal.signal,
      });
      if (upstreamSignal.cause() === "caller") {
        await response.body?.cancel().catch(() => undefined);
        throw new HttpError(499, "转录已停止。", "REQUEST_CANCELLED");
      }
      if (upstreamSignal.cause() === "timeout") {
        await response.body?.cancel().catch(() => undefined);
        throw new HttpError(504, "转录超时，请尝试较短的音频。", "TRANSCRIPTION_TIMEOUT");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new HttpError(
          502,
          `转录服务返回错误（${response.status}）。`,
          "TRANSCRIPTION_UPSTREAM_ERROR",
        );
      }
      const raw = await response.json() as Record<string, unknown>;
      if (upstreamSignal.cause() === "caller") {
        throw new HttpError(499, "转录已停止。", "REQUEST_CANCELLED");
      }
      if (upstreamSignal.cause() === "timeout") {
        throw new HttpError(504, "转录超时，请尝试较短的音频。", "TRANSCRIPTION_TIMEOUT");
      }
      const segments = arraySegments(raw.segments || raw.words || []);
      return jsonResponse({ ok: true, data: { schema_version: "1.0", language: raw.language || null, duration_ms: Math.round(Number(raw.duration || 0) * 1000), text: raw.text || segments.map((segment) => segment.text).join(" "), segments, provider: { label: "Configured transcription endpoint", model } } });
    } catch (error) {
      if (upstreamSignal.cause() === "caller") {
        throw new HttpError(499, "转录已停止。", "REQUEST_CANCELLED");
      }
      if (upstreamSignal.cause() === "timeout") {
        throw new HttpError(504, "转录超时，请尝试较短的音频。", "TRANSCRIPTION_TIMEOUT");
      }
      if (error instanceof HttpError) throw error;
      if (isAbortLike(error)) throw new HttpError(502, "转录服务没有返回可读取结果。", "TRANSCRIPTION_CONNECTION_FAILED");
      throw new HttpError(502, "转录服务没有返回可读取结果。", "TRANSCRIPTION_CONNECTION_FAILED");
    } finally { upstreamSignal.dispose(); }
  } catch (error) {
    if (request.signal.aborted) {
      return errorResponse(new HttpError(499, "转录已停止。", "REQUEST_CANCELLED"));
    }
    if (error instanceof RequestBodyTooLargeError) {
      return errorResponse(new HttpError(
        413,
        "上传请求超过 101 MiB；音频本身不能超过 100 MiB。",
        "AUDIO_ENVELOPE_TOO_LARGE",
      ));
    }
    return errorResponse(error);
  }
}

function arraySegments(value: unknown): Array<{ ordinal: number; start_ms: number; end_ms: number; text: string; speaker: string | null; confidence: number | null }> {
  if (!Array.isArray(value)) return [];
  return value.map((rawSegment, ordinal) => {
    const segment = rawSegment && typeof rawSegment === "object"
      ? rawSegment as Record<string, unknown>
      : {};
    return {
      ordinal,
      start_ms: Math.max(0, Math.round(Number(segment.start || segment.start_time || 0) * 1000)),
      end_ms: Math.max(0, Math.round(Number(segment.end || segment.end_time || segment.start || 0) * 1000)),
      text: String(segment.text || segment.word || "").trim(),
      speaker: segment.speaker ? String(segment.speaker) : null,
      confidence: Number.isFinite(segment.confidence) ? Number(segment.confidence) : null,
    };
  }).filter((segment) => segment.text);
}
