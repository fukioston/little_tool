import { XMLParser } from "fast-xml-parser";
import { errorResponse, HttpError, jsonResponse, readJsonBody, verifySameOrigin } from "@/lib/server/http";
import { safeFetchText } from "@/lib/server/safe-fetch";

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

export async function POST(request: Request) {
  const originError = verifySameOrigin(request);
  if (originError) return originError;
  try {
    const { url } = await readJsonBody<{ url?: string }>(request, 32_000);
    if (!url) throw new HttpError(400, "请输入播客 RSS 地址。", "URL_REQUIRED");
    const fetched = await safeFetchText(url, { maxBytes: 4_000_000, accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.2" });
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", cdataPropName: "__cdata" });
    const parsed = recordOf(parser.parse(fetched.text)) ?? {};
    const channel = recordOf(recordOf(parsed.rss)?.channel) ?? recordOf(parsed.feed);
    if (!channel) throw new HttpError(422, "无法识别这个 RSS Feed。", "RSS_INVALID");
    const rawEpisodes = arrayOf(channel.item || channel.entry);
    const episodes = rawEpisodes.slice(0, 200).map((rawItem, index) => {
      const item = recordOf(rawItem) ?? {};
      const enclosure = item.enclosure || item.link;
      const links = arrayOf(item.link);
      const audioLink = links.find((link) => textOf(recordOf(link)?.["@_type"]).startsWith("audio/")) || enclosure;
      const audioRecord = recordOf(audioLink);
      const transcript = item["podcast:transcript"];
      const transcriptRecord = recordOf(transcript);
      return {
        guid: textOf(item.guid || item.id) || `${fetched.url}#${index}`,
        title: textOf(item.title) || `第 ${index + 1} 期`,
        description: textOf(item.description || item.summary || item["content:encoded"]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2_000),
        publishedAt: textOf(item.pubDate || item.published || item.updated) || null,
        duration: textOf(item["itunes:duration"]) || null,
        audioUrl: typeof audioLink === "string" ? audioLink : textOf(audioRecord?.["@_url"] || audioRecord?.["@_href"]) || null,
        transcriptUrl: typeof transcript === "string" ? transcript : textOf(transcriptRecord?.["@_url"]) || null,
        transcriptType: textOf(transcriptRecord?.["@_type"]) || null,
      };
    });
    return jsonResponse({ ok: true, data: { title: textOf(channel.title) || "未命名播客", description: textOf(channel.description || channel.subtitle), feedUrl: fetched.url, homeUrl: textOf(channel.link), episodes } });
  } catch (error) { return errorResponse(error); }
}
