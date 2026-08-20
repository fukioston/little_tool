import { errorResponse, HttpError, jsonResponse, verifySameOrigin } from "@/lib/server/http";

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
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 100 * 1024 * 1024) throw new HttpError(413, "音频文件不能超过 100 MB。", "AUDIO_TOO_LARGE");
    const incoming = await request.formData();
    const file = incoming.get("file");
    if (!(file instanceof File) || file.size === 0) throw new HttpError(400, "请选择有效的音频文件。", "AUDIO_REQUIRED");
    if (file.size > 100 * 1024 * 1024) throw new HttpError(413, "音频文件不能超过 100 MB。", "AUDIO_TOO_LARGE");
    const upstream = new FormData();
    upstream.set("file", file, file.name.replace(/[\\/\0]/g, "_").slice(0, 120));
    upstream.set("model", model);
    upstream.set("response_format", "verbose_json");
    upstream.append("timestamp_granularities[]", "segment");
    const language = incoming.get("language");
    if (typeof language === "string" && /^[a-z]{2,3}$/i.test(language)) upstream.set("language", language);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: upstream, signal: controller.signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw new HttpError(504, "转录超时，请尝试较短的音频。", "TRANSCRIPTION_TIMEOUT");
      throw new HttpError(502, "无法连接转录服务。", "TRANSCRIPTION_CONNECTION_FAILED");
    } finally { clearTimeout(timeout); }
    if (!response.ok) throw new HttpError(502, `转录服务返回错误（${response.status}）。`, "TRANSCRIPTION_UPSTREAM_ERROR");
    const raw = await response.json() as Record<string, unknown>;
    const segments = arraySegments(raw.segments || raw.words || []);
    return jsonResponse({ ok: true, data: { schema_version: "1.0", language: raw.language || null, duration_ms: Math.round(Number(raw.duration || 0) * 1000), text: raw.text || segments.map((segment) => segment.text).join(" "), segments, provider: { label: "Configured transcription endpoint", model } } });
  } catch (error) { return errorResponse(error); }
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
