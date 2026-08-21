import type { ParsedArticle, ParsedPodcast } from "./types";

export function uid(prefix: string) {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}_${random}`;
}

export function normalizeText(value: string) {
  return value.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\t ]+\n/g, "\n").trim();
}

function stripMarkdown(line: string) {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .trim();
}

export function parseArticleText(raw: string, fallbackTitle = "未命名文章"): ParsedArticle {
  const normalized = normalizeText(raw);
  const looksLikeHtml = /<\/?(?:article|p|h[1-6]|div|blockquote)\b/i.test(normalized);
  let lines: Array<{ kind: "heading" | "paragraph" | "quote"; text: string }> = [];

  if (looksLikeHtml && typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(normalized, "text/html");
    doc.querySelectorAll("script,style,iframe,form,noscript,svg").forEach((node) => node.remove());
    lines = Array.from(doc.querySelectorAll("h1,h2,h3,h4,h5,h6,p,blockquote,li"))
      .map((node) => ({
        kind: node.tagName === "BLOCKQUOTE" ? "quote" as const : /^H\d$/.test(node.tagName) ? "heading" as const : "paragraph" as const,
        text: normalizeText(node.textContent ?? ""),
      }))
      .filter((entry) => entry.text.length > 0);
  } else {
    lines = normalized
      .split(/\n\s*\n|\n(?=#{1,6}\s+)/)
      .map((part) => {
        const trimmed = part.trim();
        return {
          kind: /^#{1,6}\s+/.test(trimmed) ? "heading" as const : /^>\s?/.test(trimmed) ? "quote" as const : "paragraph" as const,
          text: stripMarkdown(trimmed.replace(/\n+/g, " ")),
        };
      })
      .filter((entry) => entry.text.length > 0);
  }

  const heading = lines.find((line) => line.kind === "heading");
  const title = heading?.text || fallbackTitle;
  const blocks = heading ? lines.filter((line) => line !== heading) : lines;
  return {
    title,
    description: blocks[0]?.text.slice(0, 120) ?? "",
    author: "",
    source: "本地导入",
    blocks: blocks.length ? blocks : [{ kind: "paragraph", text: normalized }],
  };
}

function parseTimestamp(value: string) {
  const parts = value.trim().replace(",", ".").split(":");
  const seconds = Number(parts.pop() ?? 0);
  const minutes = Number(parts.pop() ?? 0);
  const hours = Number(parts.pop() ?? 0);
  if (![seconds, minutes, hours].every(Number.isFinite)) return 0;
  return Math.max(0, Math.round((hours * 3600 + minutes * 60 + seconds) * 1000));
}

export function parseTranscript(raw: string, filename = "transcript.vtt") {
  const text = normalizeText(raw).replace(/^WEBVTT[^\n]*\n+/i, "");
  const extension = filename.split(".").pop()?.toLowerCase();

  if (extension === "lrc" || /^\[\d{1,2}:\d{2}(?:\.\d+)?]/m.test(text)) {
    const rows = text.split("\n").flatMap((line) => {
      const match = line.match(/^\[(\d{1,2}:\d{2}(?:\.\d+)?)][ \t]*(.+)$/);
      return match ? [{ start_ms: parseTimestamp(match[1]), text: match[2].trim() }] : [];
    });
    return rows.map((row, index) => ({
      ...row,
      end_ms: rows[index + 1]?.start_ms ?? row.start_ms + 5000,
      speaker: null,
    }));
  }

  const cues = text.split(/\n\s*\n/).flatMap((chunk) => {
    const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return [];
    const [start, endWithSettings] = lines[timingIndex].split("-->").map((part) => part.trim());
    const end = endWithSettings.split(/\s+/)[0];
    const cueText = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!cueText) return [];
    return [{ start_ms: parseTimestamp(start), end_ms: Math.max(parseTimestamp(end), parseTimestamp(start) + 250), text: cueText, speaker: null }];
  });

  if (cues.length) return cues.sort((a, b) => a.start_ms - b.start_ms);
  return text.split(/(?<=[.!?。！？])\s+(?=[A-Z“"'])|\n+/).filter(Boolean).map((line) => ({
    start_ms: 0,
    end_ms: 0,
    text: line.trim(),
    speaker: null,
  }));
}

export function normalizeArticleApi(value: unknown): ParsedArticle {
  const root = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const payload = (root.data && typeof root.data === "object" ? root.data : root) as Record<string, unknown>;
  const content = String(payload.content ?? payload.text ?? payload.markdown ?? "");
  const parsed = parseArticleText(content, String(payload.title ?? "网页文章"));
  const blocks: ParsedArticle["blocks"] = Array.isArray(payload.blocks)
    ? payload.blocks.flatMap((entry) => {
        if (typeof entry === "string") return [{ kind: "paragraph" as const, text: normalizeText(entry) }];
        if (!entry || typeof entry !== "object") return [];
        const block = entry as Record<string, unknown>;
        const text = normalizeText(String(block.text ?? block.content ?? ""));
        const kind: ParsedArticle["blocks"][number]["kind"] = block.kind === "heading" || block.kind === "quote" ? block.kind : "paragraph";
        return text ? [{ kind, text }] : [];
      })
    : parsed.blocks;
  return {
    ...parsed,
    title: String(payload.title ?? parsed.title),
    description: String(payload.description ?? payload.excerpt ?? parsed.description),
    author: String(payload.author ?? ""),
    source: String(payload.site_name ?? payload.source ?? "网页导入"),
    sourceUrl: typeof payload.url === "string" ? payload.url : typeof payload.canonicalUrl === "string" ? payload.canonicalUrl : typeof payload.canonical_url === "string" ? payload.canonical_url : undefined,
    blocks,
  };
}

export function normalizePodcastApi(value: unknown): ParsedPodcast[] {
  const root = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<string, unknown>;
  const feed = (data.feed && typeof data.feed === "object" ? data.feed : data) as Record<string, unknown>;
  const episodes = Array.isArray(data.episodes) ? data.episodes : Array.isArray(feed.episodes) ? feed.episodes : [];
  const durationToMs = (duration: unknown) => {
    if (typeof duration === "number") return duration > 10000 ? duration : duration * 1000;
    if (typeof duration !== "string" || !duration.trim()) return 0;
    return duration.includes(":") ? parseTimestamp(duration) : Math.round(Number(duration) * 1000) || 0;
  };
  return episodes.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const episode = entry as Record<string, unknown>;
    const transcript = Array.isArray(episode.segments) ? episode.segments : [];
    return [{
      title: String(episode.title ?? "未命名单集"),
      description: String(episode.description ?? ""),
      source: String(feed.title ?? data.title ?? "RSS 订阅"),
      sourceUrl: typeof episode.link === "string" ? episode.link : typeof data.feedUrl === "string" ? data.feedUrl : undefined,
      audioUrl: typeof episode.audioUrl === "string" ? episode.audioUrl : typeof episode.audio_url === "string" ? episode.audio_url : typeof episode.enclosure_url === "string" ? episode.enclosure_url : undefined,
      transcriptUrl: typeof episode.transcriptUrl === "string" ? episode.transcriptUrl : undefined,
      transcriptType: typeof episode.transcriptType === "string" ? episode.transcriptType : undefined,
      durationMs: Number(episode.duration_ms ?? 0) || durationToMs(episode.duration),
      segments: transcript.flatMap((segment) => {
        if (!segment || typeof segment !== "object") return [];
        const row = segment as Record<string, unknown>;
        return [{
          start_ms: Number.isFinite(Number(row.start_ms))
            ? Number(row.start_ms)
            : Number.isFinite(Number(row.start)) ? Number(row.start) * 1000 : 0,
          end_ms: Number.isFinite(Number(row.end_ms))
            ? Number(row.end_ms)
            : Number.isFinite(Number(row.end)) ? Number(row.end) * 1000 : 0,
          text: String(row.text ?? ""),
          speaker: typeof row.speaker === "string" ? row.speaker : null,
        }];
      }),
    }];
  });
}

const SENTENCE_BOUNDARY = /[.!?。！？；;\n]/;

export function adjacentSentence(text: string, edge: "preceding" | "following") {
  const sentences = text
    .split(SENTENCE_BOUNDARY)
    .map((part) => part.trim())
    .filter(Boolean);
  return edge === "preceding" ? sentences.at(-1) ?? "" : sentences[0] ?? "";
}

export function sentenceContext(text: string, start: number, end: number) {
  const boundary = SENTENCE_BOUNDARY;
  let sentenceStart = start;
  let sentenceEnd = end;
  while (sentenceStart > 0 && !boundary.test(text[sentenceStart - 1])) sentenceStart -= 1;
  while (sentenceEnd < text.length && !boundary.test(text[sentenceEnd])) sentenceEnd += 1;
  if (sentenceEnd < text.length) sentenceEnd += 1;
  const rawSentence = text.slice(sentenceStart, sentenceEnd);
  const leadingWhitespace = rawSentence.length - rawSentence.trimStart().length;
  const trailingWhitespace = rawSentence.length - rawSentence.trimEnd().length;
  const trimmedSentenceStart = sentenceStart + leadingWhitespace;
  const trimmedSentenceEnd = sentenceEnd - trailingWhitespace;
  const sentence = text.slice(trimmedSentenceStart, trimmedSentenceEnd);
  const beforeText = text.slice(0, trimmedSentenceStart).trim();
  const afterText = text.slice(trimmedSentenceEnd).trim();
  return {
    sentence,
    before: adjacentSentence(beforeText, "preceding"),
    after: adjacentSentence(afterText, "following"),
    startUtf16: start - trimmedSentenceStart,
    endUtf16: end - trimmedSentenceStart,
  };
}

export function wordAt(text: string, offset: number) {
  if (!text || offset < 0) return null;
  const Segmenter = Intl.Segmenter;
  if (Segmenter) {
    const segments = Array.from(new Segmenter("en", { granularity: "word" }).segment(text));
    const hit = segments.find((segment) => offset >= segment.index && offset < segment.index + segment.segment.length);
    if (hit && /[\p{L}\p{N}]/u.test(hit.segment)) return { text: hit.segment, start: hit.index, end: hit.index + hit.segment.length };
  }
  const isWord = (char: string) => /[\p{L}\p{N}]/u.test(char);
  if (!isWord(text[offset] ?? "")) return null;
  let start = offset;
  let end = offset + 1;
  while (start > 0 && isWord(text[start - 1])) start -= 1;
  while (end < text.length && isWord(text[end])) end += 1;
  return { text: text.slice(start, end), start, end };
}

export function wordRanges(text: string): Array<{ text: string; start: number; end: number }> {
  if (!text) return [];
  if (Intl.Segmenter) {
    return Array.from(new Intl.Segmenter("en", { granularity: "word" }).segment(text))
      .filter((segment) => segment.isWordLike && /[\p{L}\p{N}]/u.test(segment.segment))
      .map((segment) => ({ text: segment.segment, start: segment.index, end: segment.index + segment.segment.length }));
  }
  return Array.from(text.matchAll(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu), (match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

export function formatShortDate(value: number | string) {
  const date = typeof value === "number" ? new Date(value) : new Date(value || Date.now());
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}

export async function readFileText(file: File) {
  return normalizeText(await file.text());
}
