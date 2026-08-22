import type { ParsedArticle, ParsedPodcast } from "./types";

/**
 * A local text import is decoded to UTF-16, normalized, hashed, and then copied
 * into SQLite. Keep four complete working copies below the 512 MiB database
 * ceiling used by the worker and full-backup format.
 */
export const VOCAB_LOCAL_TEXT_IMPORT_MAX_BYTES = (512 * 1024 * 1024) / 4;
export const VOCAB_LOCAL_AUDIO_IMPORT_MAX_BYTES = 512 * 1024 * 1024;
export const VOCAB_TRANSCRIPTION_AUDIO_MAX_BYTES = 100 * 1024 * 1024;

export type VocabLocalImportFileKind = "article" | "transcript" | "audio";

type ImportFileFacts = Readonly<{
  name: string;
  size: number;
}>;

function formatImportLimit(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}

export function vocabLocalImportFileProblem(
  file: ImportFileFacts,
  kind: VocabLocalImportFileKind,
  options: Readonly<{ forTranscription?: boolean }> = {},
): string | null {
  const label = kind === "article" ? "文章" : kind === "transcript" ? "字幕" : "音频";
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return `${label}文件为空或大小无效，请重新选择。`;
  }
  if (
    (kind === "article" || kind === "transcript") &&
    file.size > VOCAB_LOCAL_TEXT_IMPORT_MAX_BYTES
  ) {
    return `${label}文件不能超过 ${formatImportLimit(VOCAB_LOCAL_TEXT_IMPORT_MAX_BYTES)}。`;
  }
  if (kind === "audio" && file.size > VOCAB_LOCAL_AUDIO_IMPORT_MAX_BYTES) {
    return `音频文件不能超过 ${formatImportLimit(VOCAB_LOCAL_AUDIO_IMPORT_MAX_BYTES)}，否则无法进入完整备份。`;
  }
  if (
    kind === "audio" &&
    options.forTranscription &&
    file.size > VOCAB_TRANSCRIPTION_AUDIO_MAX_BYTES
  ) {
    return `外部转写只接受不超过 ${formatImportLimit(VOCAB_TRANSCRIPTION_AUDIO_MAX_BYTES)} 的音频。`;
  }
  return null;
}

export type SupportedTranscriptFormat = "vtt" | "srt" | "json" | "html" | "plain";

export type PodcastTranscriptCandidate = Readonly<{
  url: string;
  type: string;
  language?: string;
  ordinal?: number;
}>;

export type SelectedPodcastTranscript = PodcastTranscriptCandidate & Readonly<{
  format: SupportedTranscriptFormat;
}>;

const TRANSCRIPT_MIME_FORMATS = Object.freeze(new Map<string, SupportedTranscriptFormat>([
  ["text/vtt", "vtt"],
  ["application/vtt", "vtt"],
  ["application/srt", "srt"],
  ["application/x-subrip", "srt"],
  ["text/srt", "srt"],
  ["text/x-srt", "srt"],
  ["application/json", "json"],
  ["application/transcript+json", "json"],
  ["application/json+transcript", "json"],
  ["text/html", "html"],
  ["application/xhtml+xml", "html"],
  ["text/plain", "plain"],
]));

function normalizedMimeType(value: string | undefined): string {
  return (value ?? "").split(";", 1)[0].trim().toLowerCase();
}

export function transcriptFormat(
  filename: string,
  ...mediaTypes: Array<string | undefined>
): SupportedTranscriptFormat | null {
  const normalizedMediaTypes = mediaTypes.map(normalizedMimeType);
  const formats = normalizedMediaTypes
    .map((value) => TRANSCRIPT_MIME_FORMATS.get(value))
    .filter((value): value is SupportedTranscriptFormat => Boolean(value));
  const extension = filename.split(/[?#]/, 1)[0].split(".").pop()?.toLowerCase();

  // Podcasting 2.0 makes type required. An explicit, specific unsupported MIME
  // must not be rescued by a misleading extension. Empty and generic binary
  // browser File types may still use the extension below.
  if (
    !formats.length &&
    normalizedMediaTypes.some((value) => value && value !== "application/octet-stream")
  ) return null;

  // A JSON declaration or extension always wins over a generic text/plain
  // response. This prevents structured transcript data becoming visible JSON
  // prose when a host serves it with a weak Content-Type.
  if (formats.includes("json") || extension === "json") return "json";
  if (formats.includes("vtt") || extension === "vtt") return "vtt";
  if (formats.includes("srt") || extension === "srt") return "srt";
  if (formats.includes("html") || extension === "html" || extension === "htm") return "html";
  if (formats.includes("plain") || extension === "txt") return "plain";
  if (extension === "lrc") return "plain";
  return null;
}

function normalizedLanguage(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replaceAll("_", "-");
}

function transcriptLanguageRank(
  language: string | undefined,
  preferredLanguages: readonly string[],
): number {
  const normalized = normalizedLanguage(language);
  const preferred = preferredLanguages.map(normalizedLanguage).filter(Boolean);
  if (!normalized) return preferred.length * 2;
  for (let index = 0; index < preferred.length; index += 1) {
    if (normalized === preferred[index]) return index * 2;
    if (normalized.split("-")[0] === preferred[index].split("-")[0]) {
      return index * 2 + 1;
    }
  }
  return preferred.length * 2 + 1;
}

const TRANSCRIPT_FORMAT_RANK: Readonly<Record<SupportedTranscriptFormat, number>> = {
  vtt: 0,
  srt: 1,
  json: 2,
  html: 3,
  plain: 4,
};

export function selectPodcastTranscript(
  candidates: readonly PodcastTranscriptCandidate[],
  preferredLanguages: readonly string[] = ["en"],
): SelectedPodcastTranscript | null {
  const selected = candidates.flatMap((candidate, index) => {
    const url = candidate.url.trim();
    const declaredType = normalizedMimeType(candidate.type);
    const format = TRANSCRIPT_MIME_FORMATS.get(declaredType) ?? null;
    if (!url || !format) return [];
    return [{
      ...candidate,
      url,
      type: declaredType,
      format,
      stableOrdinal: candidate.ordinal ?? index,
      inputOrdinal: index,
    }];
  }).sort((left, right) =>
    transcriptLanguageRank(left.language, preferredLanguages) -
      transcriptLanguageRank(right.language, preferredLanguages) ||
    TRANSCRIPT_FORMAT_RANK[left.format] - TRANSCRIPT_FORMAT_RANK[right.format] ||
    left.stableOrdinal - right.stableOrdinal ||
    left.inputOrdinal - right.inputOrdinal
  )[0];
  return selected ? {
    url: selected.url,
    type: selected.type,
    language: selected.language,
    ordinal: selected.ordinal,
    format: selected.format,
  } : null;
}

export function podcastEpisodeHasImportableMedia(
  episode: Pick<ParsedPodcast, "audioUrl" | "transcriptUrl" | "segments">,
): boolean {
  return Boolean(episode.audioUrl || episode.transcriptUrl || episode.segments.length);
}

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

const HTML_TRANSCRIPT_IGNORED_ELEMENTS = new Set([
  "script",
  "style",
  "iframe",
  "form",
  "noscript",
  "svg",
]);

function decodeHtmlCharacterReferences(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: "\u00a0",
    quot: '"',
  };
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (entity, decimal, hex, name) => {
    if (name) return named[String(name).toLowerCase()] ?? entity;
    const codePoint = Number.parseInt(decimal || hex, decimal ? 10 : 16);
    return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : "\ufffd";
  });
}

function htmlTagEnd(value: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function htmlAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`,
    "i",
  ));
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? null : decodeHtmlCharacterReferences(value);
}

function parsePodcastHtmlTranscript(raw: string): ParsedTranscriptSegment[] {
  let speaker: string | null = null;
  let startMs = 0;
  const rows: Array<Omit<ParsedTranscriptSegment, "end_ms">> = [];
  const captures: Array<{ tag: "cite" | "time" | "p"; text: string; datetime: string | null }> = [];
  const lastCaptureIndex = (tag: "cite" | "time" | "p") => {
    for (let index = captures.length - 1; index >= 0; index -= 1) {
      if (captures[index].tag === tag) return index;
    }
    return -1;
  };
  const finishCapture = (index: number) => {
    const [capture] = captures.splice(index, 1);
    const text = normalizeText(decodeHtmlCharacterReferences(capture.text));
    if (capture.tag === "cite") {
      speaker = text.replace(/:\s*$/, "") || null;
    } else if (capture.tag === "time") {
      startMs = parseTimestamp(capture.datetime ?? text);
    } else if (text) {
      rows.push({ start_ms: startMs, text, speaker });
    }
  };

  // This tokenizer only reads strings. In particular it never inserts the
  // untrusted document into a browser DOM, so src/href/srcset attributes cannot
  // trigger resource discovery or a secondary network request.
  let cursor = 0;
  while (cursor < raw.length) {
    const open = raw.indexOf("<", cursor);
    const textEnd = open < 0 ? raw.length : open;
    if (textEnd > cursor) {
      const text = raw.slice(cursor, textEnd);
      for (const capture of captures) capture.text += text;
    }
    if (open < 0) break;
    if (raw.startsWith("<!--", open)) {
      const commentEnd = raw.indexOf("-->", open + 4);
      cursor = commentEnd < 0 ? raw.length : commentEnd + 3;
      continue;
    }
    const end = htmlTagEnd(raw, open);
    if (end < 0) {
      for (const capture of captures) capture.text += raw.slice(open);
      break;
    }
    const tag = raw.slice(open + 1, end);
    const match = tag.match(/^\s*(\/)?\s*([a-z][\w:-]*)/i);
    cursor = end + 1;
    if (!match) continue;
    const closing = Boolean(match[1]);
    const name = match[2].toLowerCase();
    const selfClosing = /\/\s*$/.test(tag);

    if (!closing && HTML_TRANSCRIPT_IGNORED_ELEMENTS.has(name)) {
      const close = new RegExp(`<\\/\\s*${name}\\s*[^>]*>`, "ig");
      close.lastIndex = cursor;
      const closingTag = close.exec(raw);
      cursor = closingTag ? close.lastIndex : raw.length;
      continue;
    }
    if (name === "br" && !closing) {
      for (const capture of captures) capture.text += "\n";
      continue;
    }
    if (name !== "cite" && name !== "time" && name !== "p") continue;
    if (closing) {
      const captureIndex = lastCaptureIndex(name);
      if (captureIndex >= 0) finishCapture(captureIndex);
      continue;
    }
    const priorIndex = lastCaptureIndex(name);
    if (priorIndex >= 0) finishCapture(priorIndex);
    captures.push({
      tag: name,
      text: "",
      datetime: name === "time" ? htmlAttribute(tag, "datetime") : null,
    });
    if (selfClosing) finishCapture(captures.length - 1);
  }
  while (captures.length) finishCapture(captures.length - 1);
  if (!rows.length) {
    throw new Error("HTML 字幕没有符合 Podcasting 2.0 格式的段落。");
  }
  return rows.map((row, index) => ({
    ...row,
    end_ms: Math.max(row.start_ms + 250, rows[index + 1]?.start_ms ?? row.start_ms + 5_000),
  }));
}

export type ParsedTranscriptSegment = Readonly<{
  start_ms: number;
  end_ms: number;
  text: string;
  speaker: string | null;
}>;

export function normalizeTranscriptionSegments(value: unknown): ParsedTranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const text = typeof row.text === "string" ? normalizeText(row.text) : "";
    const startMs = row.start_ms !== null && row.start_ms !== undefined
      ? Number(row.start_ms)
      : row.start !== null && row.start !== undefined
        ? Number(row.start) * 1_000
        : index * 5_000;
    const endMs = row.end_ms !== null && row.end_ms !== undefined
      ? Number(row.end_ms)
      : row.end !== null && row.end !== undefined
        ? Number(row.end) * 1_000
        : (index + 1) * 5_000;
    if (
      !text || !Number.isFinite(startMs) || !Number.isFinite(endMs) ||
      startMs < 0 || endMs < 0
    ) return [];
    return [{
      start_ms: Math.round(startMs),
      end_ms: Math.max(Math.round(startMs) + 250, Math.round(endMs)),
      text,
      speaker: typeof row.speaker === "string" && row.speaker.trim()
        ? normalizeText(row.speaker)
        : null,
    }];
  });
}

function finiteTranscriptSeconds(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function parsePodcastJsonTranscript(raw: string): ParsedTranscriptSegment[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("JSON 字幕格式不正确，未把它当作纯文本导入。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON 字幕必须是 Podcasting 2.0 transcript 对象。");
  }
  const root = value as Record<string, unknown>;
  if (typeof root.version !== "string" || !root.version.trim()) {
    throw new Error("JSON 字幕缺少 Podcasting 2.0 version。");
  }
  if (!Array.isArray(root.segments)) {
    throw new Error("JSON 字幕缺少 Podcasting 2.0 segments 数组。");
  }
  const rows = root.segments.flatMap((entry, ordinal) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const segment = entry as Record<string, unknown>;
    const text = typeof segment.body === "string" ? normalizeText(segment.body) : "";
    const start = finiteTranscriptSeconds(segment.startTime);
    const end = finiteTranscriptSeconds(segment.endTime);
    if (!text || start === null) return [];
    return [{
      ordinal,
      start_ms: Math.round(start * 1_000),
      declaredEndMs: end === null ? null : Math.round(end * 1_000),
      text,
      speaker: typeof segment.speaker === "string" && segment.speaker.trim()
        ? normalizeText(segment.speaker)
        : null,
    }];
  }).sort((left, right) => left.start_ms - right.start_ms || left.ordinal - right.ordinal);
  if (!rows.length) {
    throw new Error("JSON 字幕没有可导入的 Podcasting 2.0 segments。");
  }
  return rows.map((row, index) => ({
    start_ms: row.start_ms,
    end_ms: Math.max(
      row.start_ms + 250,
      row.declaredEndMs ?? rows[index + 1]?.start_ms ?? row.start_ms + 5_000,
    ),
    text: row.text,
    speaker: row.speaker,
  }));
}

export function parseTranscript(
  raw: string,
  filename = "transcript.vtt",
  mediaType?: string,
): ParsedTranscriptSegment[] {
  const text = normalizeText(raw).replace(/^WEBVTT[^\n]*\n+/i, "");
  const extension = filename.split(".").pop()?.toLowerCase();
  const format = transcriptFormat(filename, mediaType);

  if (format === "json") {
    return parsePodcastJsonTranscript(text);
  }
  if (format === "html") return parsePodcastHtmlTranscript(text);

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
  return text.split(/(?<=[.!?。！？])\s+(?=[A-Z“"'])|\n+/).map((line) => line.trim()).filter(Boolean).map((line) => ({
    start_ms: 0,
    end_ms: 0,
    text: line,
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
