import type { AiExplanation } from "./types";

const MAX_TEXT = 2_000;
const MAX_SHORT = 240;
const MAX_ITEMS = 12;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`AI 返回的${label}格式不正确。`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, limit = MAX_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, limit) : undefined;
}

function nullableText(value: unknown, limit = MAX_TEXT): string | null | undefined {
  if (value === null) return null;
  return text(value, limit);
}

function textList(value: unknown, limit = MAX_ITEMS): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("AI 返回的列表格式不正确。");
  }
  return value.map((entry) => entry.trim().slice(0, MAX_SHORT)).filter(Boolean).slice(0, limit);
}

function objectList<T>(
  value: unknown,
  map: (entry: Record<string, unknown>) => T | null,
  limit = MAX_ITEMS,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new Error("AI 返回的对象列表格式不正确。");
  }
  return value.slice(0, limit).flatMap((entry) => {
    const mapped = map(entry as Record<string, unknown>);
    return mapped ? [mapped] : [];
  });
}

export function parseAiExplanation(value: unknown): AiExplanation {
  const root = record(value, "解释");
  const target = record(root.target, "目标词");
  const sense = record(root.sense, "英文释义");
  const surface = text(target.surface, 120);
  const canonical = text(target.canonical, 120);
  const glosses = textList(sense.glosses_en, 6);
  const meaning = text(sense.meaning_in_context_en);
  const explanation = text(sense.explanation_en);
  if (!surface || !canonical || (!glosses.length && !meaning && !explanation)) {
    throw new Error("AI 没有返回可核对的语境释义，请重试。");
  }

  const kind = target.kind === "word" || target.kind === "phrase" ? target.kind : undefined;
  const cefr = ["A1", "A2", "B1", "B2", "C1", "C2"].includes(String(root.cefr))
    ? String(root.cefr)
    : null;
  return {
    target: {
      surface,
      canonical,
      kind,
      pronunciation: nullableText(target.pronunciation, 160),
      ipa: nullableText(target.ipa, 160),
    },
    sense: {
      glosses_en: glosses,
      meaning_in_context_en: meaning,
      explanation_en: explanation,
      explanation_zh: nullableText(sense.explanation_zh),
      parts_of_speech: textList(sense.parts_of_speech, 6),
      register: nullableText(sense.register, MAX_SHORT),
    },
    context_translation_zh: nullableText(root.context_translation_zh),
    collocations: textList(root.collocations),
    word_family: objectList(root.word_family, (entry) => {
      const word = text(entry.word, 120);
      return word ? { word, part_of_speech: text(entry.part_of_speech, 80) } : null;
    }),
    synonyms: objectList(root.synonyms, (entry) => {
      const word = text(entry.word, 120);
      return word ? { word, difference_en: text(entry.difference_en, 500) } : null;
    }),
    example: root.example === undefined ? undefined : (() => {
      const example = record(root.example, "例句");
      return {
        sentence_en: text(example.sentence_en),
        translation_zh: nullableText(example.translation_zh),
      };
    })(),
    cefr,
    warnings: textList(root.warnings, 8),
  };
}

export function parseChineseExplanation(value: unknown): {
  explanation_zh?: string;
  context_translation_zh?: string;
  warnings: string[];
} {
  const root = record(value, "中文说明");
  const explanationZh = text(root.explanation_zh);
  const contextZh = text(root.context_translation_zh);
  if (!explanationZh && !contextZh) throw new Error("AI 没有返回可核对的中文说明，请重试。");
  return {
    explanation_zh: explanationZh,
    context_translation_zh: contextZh,
    warnings: textList(root.warnings, 8),
  };
}
