export class VocabAiActionNotAllowedError extends Error {}
export class VocabAiPayloadValidationError extends Error {}

export const VOCAB_AI_DISCLOSURE_BY_ACTION = Object.freeze({
  explain: "点词后会发送：所选英文、它在当前句中的位置、当前句、前一句、后一句，以及界面语言偏好。",
  explain_chinese: "补充中文时会发送：所选英文、当前句，以及刚才生成的精简英文释义；不发送整份词条或阅读历史。",
} as const);

type VocabAiAction = keyof typeof VOCAB_AI_DISCLOSURE_BY_ACTION;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VocabAiPayloadValidationError("invalid object");
  }
  return value as Record<string, unknown>;
}

function normalizeTextSegment(value: string): string {
  return Array.from(value.normalize("NFC").replace(/\r\n?/g, "\n"))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code >= 32 && code !== 127;
    })
    .join("");
}

function cleanText(value: unknown, maxLength: number, required = false): string {
  const cleaned = typeof value === "string"
    ? normalizeTextSegment(value).trim().slice(0, maxLength)
    : "";
  if (required && !cleaned) throw new VocabAiPayloadValidationError("required text missing");
  return cleaned;
}

function adjacentSentenceText(
  value: unknown,
  edge: "preceding" | "following",
): string | null {
  const cleaned = cleanText(value, 8_000);
  if (!cleaned) return null;
  const sentences = cleaned
    .split(/[.!?。！？；;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return edge === "preceding"
    ? sentences.at(-1) ?? null
    : sentences[0] ?? null;
}

function integer(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new VocabAiPayloadValidationError("invalid position");
  }
  return value as number;
}

function stringList(value: unknown, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value
    .slice(0, maxItems)
    .map((item) => cleanText(item, maxLength))
    .filter(Boolean));
}

function normalizeAction(action: string): string {
  return action
    .replace(/[A-Z]/g, (value) => `_${value.toLowerCase()}`)
    .replace(/-/g, "_");
}

function sanitizeExplain(payload: unknown) {
  const root = record(payload);
  const target = record(root.target);
  const context = record(root.context);
  const learner = root.learner && typeof root.learner === "object" && !Array.isArray(root.learner)
    ? root.learner as Record<string, unknown>
    : {};
  const start = integer(target.start_utf16, 0, 2_000_000);
  const end = integer(target.end_utf16, 1, 2_000_000);
  if (end <= start) throw new VocabAiPayloadValidationError("invalid selection range");
  if (typeof target.surface !== "string" || typeof context.sentence !== "string") {
    throw new VocabAiPayloadValidationError("selection text missing");
  }
  const rawSurface = target.surface.trim();
  const rawSentence = context.sentence;
  if (target.surface.length > 320 || rawSentence.length > 16_000 ||
      end > rawSentence.length || rawSentence.slice(start, end) !== rawSurface) {
    throw new VocabAiPayloadValidationError("selection does not match context");
  }
  const normalizedPrefix = normalizeTextSegment(rawSentence.slice(0, start));
  const surface = normalizeTextSegment(rawSentence.slice(start, end));
  const normalizedSuffix = normalizeTextSegment(rawSentence.slice(end));
  const normalizedSentence = `${normalizedPrefix}${surface}${normalizedSuffix}`;
  const leadingWhitespace = normalizedSentence.length - normalizedSentence.trimStart().length;
  const sentence = normalizedSentence.trim();
  const normalizedStart = normalizedPrefix.length - leadingWhitespace;
  const normalizedEnd = normalizedStart + surface.length;
  if (!surface || surface !== surface.trim() || surface.length > 160 ||
      !sentence || sentence.length > 8_000 || normalizedStart < 0 ||
      normalizedEnd > sentence.length || sentence.slice(normalizedStart, normalizedEnd) !== surface) {
    throw new VocabAiPayloadValidationError("selection does not match normalized context");
  }

  return Object.freeze({
    schema_version: "1.0",
    target: Object.freeze({
      surface,
      start_utf16: normalizedStart,
      end_utf16: normalizedEnd,
    }),
    context: Object.freeze({
      sentence,
      preceding_sentence: adjacentSentenceText(context.preceding_sentence, "preceding"),
      following_sentence: adjacentSentenceText(context.following_sentence, "following"),
    }),
    learner: Object.freeze({
      interface_language: "zh-CN",
      explanation_language: "en",
      include_simplified_chinese: learner.include_simplified_chinese === true,
    }),
  });
}

function sanitizeChinese(payload: unknown) {
  const root = record(payload);
  const targetRecord = root.target && typeof root.target === "object" && !Array.isArray(root.target)
    ? root.target as Record<string, unknown>
    : null;
  const contextRecord = root.context && typeof root.context === "object" && !Array.isArray(root.context)
    ? root.context as Record<string, unknown>
    : null;
  const englishRoot = record(root.english_explanation);
  const english = englishRoot.sense && typeof englishRoot.sense === "object" && !Array.isArray(englishRoot.sense)
    ? englishRoot.sense as Record<string, unknown>
    : englishRoot;

  const surface = cleanText(targetRecord?.surface ?? root.target, 160, true);
  const sentence = cleanText(contextRecord?.sentence ?? root.context, 8_000, true);
  const explanation = cleanText(english.explanation_en, 6_000);
  const meaning = cleanText(english.meaning_in_context_en, 3_000);
  const glosses = stringList(english.glosses_en, 8, 500);
  if (!explanation && !meaning && glosses.length === 0) {
    throw new VocabAiPayloadValidationError("English explanation missing");
  }

  return Object.freeze({
    schema_version: "1.0",
    target: Object.freeze({ surface }),
    context: Object.freeze({ sentence }),
    english_explanation: Object.freeze({
      glosses_en: glosses,
      meaning_in_context_en: meaning || null,
      explanation_en: explanation || null,
    }),
  });
}

export function sanitizeVocabAiRequestPayload(
  action: string,
  payload: unknown,
): Readonly<Record<string, unknown>> {
  const normalized = normalizeAction(action) as VocabAiAction;
  if (normalized === "explain") return sanitizeExplain(payload);
  if (normalized === "explain_chinese") return sanitizeChinese(payload);
  throw new VocabAiActionNotAllowedError("unsupported vocabulary AI action");
}
