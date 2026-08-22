import { XMLParser } from "fast-xml-parser";
import { errorResponse, HttpError, jsonResponse, readJsonBody, verifySameOrigin } from "@/lib/server/http";
import { safeFetchText } from "@/lib/server/safe-fetch";
import {
  selectPodcastTranscript,
  transcriptFormat,
  VOCAB_LOCAL_TEXT_IMPORT_MAX_BYTES,
  type SupportedTranscriptFormat,
} from "@/lib/vocab/content";

function arrayOf<T>(value: T | T[] | undefined): T[] { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textOf(record["#text"] ?? record["__cdata"] ?? "");
  }
  return "";
}

function enclosureUrl(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const record = recordOf(value);
  return textOf(record?.["@_url"] || record?.["@_href"]).trim();
}

function remotePodcastUrl(value: unknown): string | null {
  const candidate = enclosureUrl(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username || url.password
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isAudioEnclosure(value: unknown): boolean {
  const record = recordOf(value);
  const type = textOf(record?.["@_type"]).trim().toLowerCase();
  const candidateUrl = remotePodcastUrl(value);
  if (!candidateUrl) return false;
  if (type.startsWith("audio/") || type === "application/ogg") return true;
  return (!type || type === "application/octet-stream") &&
    /\.(?:aac|flac|m4a|m4b|mp3|oga|ogg|opus|wav)(?:$|[?#])/i.test(candidateUrl);
}

export async function POST(request: Request) {
  const originError = verifySameOrigin(request);
  if (originError) return originError;
  try {
    const { url, kind, transcriptType } = await readJsonBody<{
      url?: string;
      kind?: "feed" | "transcript";
      transcriptType?: string;
    }>(request, 32_000);
    if (!url) throw new HttpError(400, "请输入播客 RSS 地址。", "URL_REQUIRED");

    if (kind === "transcript") {
      const declaredFormat = transcriptFormat(url, transcriptType);
      if (!declaredFormat) {
        throw new HttpError(415, "该远程字幕格式暂不支持。", "TRANSCRIPT_TYPE_UNSUPPORTED");
      }
      const transcript = await safeFetchText(url, {
        maxBytes: VOCAB_LOCAL_TEXT_IMPORT_MAX_BYTES,
        accept: "text/vtt,application/vtt,application/srt,application/x-subrip,text/srt,application/json,application/transcript+json,text/html,application/xhtml+xml,text/plain",
        signal: request.signal,
      });
      const responseFormat = transcriptFormat("transcript", transcript.contentType);
      if (!responseFormat) {
        throw new HttpError(415, "远程地址没有返回受支持的字幕内容类型。", "TRANSCRIPT_CONTENT_TYPE_UNSUPPORTED");
      }
      const format = transcriptFormat(transcript.url, transcriptType, transcript.contentType);
      if (!format) {
        throw new HttpError(415, "无法确认远程字幕格式。", "TRANSCRIPT_TYPE_UNSUPPORTED");
      }
      return jsonResponse({
        ok: true,
        data: {
          text: transcript.text,
          url: transcript.url,
          contentType: transcript.contentType,
          transcriptType: canonicalTranscriptMimeType(format),
        },
      });
    }

    const fetched = await safeFetchText(url, {
      maxBytes: 4_000_000,
      accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.2",
      signal: request.signal,
    });
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", cdataPropName: "__cdata" });
    const parsed = recordOf(parser.parse(fetched.text)) ?? {};
    const channel = recordOf(recordOf(parsed.rss)?.channel) ?? recordOf(parsed.feed);
    if (!channel) throw new HttpError(422, "无法识别这个 RSS Feed。", "RSS_INVALID");
    const feedLanguage = textOf(channel.language).trim();
    const rawEpisodes = arrayOf(channel.item || channel.entry);
    const episodes = rawEpisodes.slice(0, 200).map((rawItem, index) => {
      const item = recordOf(rawItem) ?? {};
      const links = arrayOf(item.link);
      const declaredEnclosures = arrayOf(item.enclosure);
      const audioLink = [...declaredEnclosures, ...links].find(isAudioEnclosure);
      const selectedTranscript = selectPodcastTranscript(
        arrayOf(item["podcast:transcript"]).flatMap((entry, ordinal) => {
          if (typeof entry === "string") {
            const transcriptUrl = remotePodcastUrl(entry);
            return transcriptUrl
              ? [{ url: transcriptUrl, type: "", language: feedLanguage, ordinal }]
              : [];
          }
          const transcript = recordOf(entry);
          const transcriptUrl = remotePodcastUrl(textOf(transcript?.["@_url"]));
          return transcriptUrl ? [{
            url: transcriptUrl,
            type: textOf(transcript?.["@_type"]),
            language: textOf(transcript?.["@_language"]) || feedLanguage,
            ordinal,
          }] : [];
        }),
        [...new Set(["en", feedLanguage].filter(Boolean))],
      );
      return {
        guid: textOf(item.guid || item.id) || `${fetched.url}#${index}`,
        title: textOf(item.title) || `第 ${index + 1} 期`,
        description: textOf(item.description || item.summary || item["content:encoded"]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2_000),
        publishedAt: textOf(item.pubDate || item.published || item.updated) || null,
        duration: textOf(item["itunes:duration"]) || null,
        audioUrl: remotePodcastUrl(audioLink),
        transcriptUrl: selectedTranscript?.url ?? null,
        transcriptType: selectedTranscript?.type || canonicalTranscriptMimeType(selectedTranscript?.format) || null,
        transcriptLanguage: selectedTranscript?.language || null,
      };
    });
    return jsonResponse({ ok: true, data: { title: textOf(channel.title) || "未命名播客", description: textOf(channel.description || channel.subtitle), feedUrl: fetched.url, homeUrl: textOf(channel.link), episodes } });
  } catch (error) { return errorResponse(error); }
}

function canonicalTranscriptMimeType(format: SupportedTranscriptFormat | undefined): string {
  switch (format) {
    case "vtt": return "text/vtt";
    case "srt": return "application/x-subrip";
    case "json": return "application/json";
    case "html": return "text/html";
    case "plain": return "text/plain";
    default: return "";
  }
}
