export type VocabView =
  | "today"
  | "library"
  | "reader"
  | "podcast"
  | "words"
  | "review"
  | "stats"
  | "settings";

export type ItemKind = "article" | "podcast";

export interface LibraryItem {
  id: string;
  kind: ItemKind;
  title: string;
  description: string;
  source: string;
  source_url: string | null;
  author: string;
  published_at: string;
  duration_ms: number;
  audio_url: string | null;
  status: "unread" | "in_progress" | "complete" | "archived";
  progress: number;
  created_at: number;
  updated_at: number;
}

export interface ContentBlock {
  id: string;
  item_id: string;
  ordinal: number;
  kind: "heading" | "paragraph" | "quote";
  text: string;
}

export interface TranscriptSegment {
  id: string;
  item_id: string;
  ordinal: number;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker: string | null;
}

export interface Lexeme {
  id: string;
  headword: string;
  normalized_key: string;
  pronunciation: string;
  gloss_en: string;
  explanation_en: string;
  explanation_zh: string;
  status: "saved" | "learning" | "known" | "ignored";
  starred: number;
  notes: string;
  lookup_count: number;
  occurrence_count: number;
  created_at: number;
  updated_at: number;
}

export interface Occurrence {
  id: string;
  lexeme_id: string;
  item_id: string | null;
  block_id: string | null;
  segment_id: string | null;
  surface: string;
  context_before: string;
  context_sentence: string;
  context_after: string;
  start_utf16: number;
  end_utf16: number;
  start_ms: number | null;
  note: string;
  explanation_json: string;
  created_at: number;
  item_title?: string;
}

export interface ReviewCard {
  id: string;
  lexeme_id: string;
  headword: string;
  pronunciation: string;
  gloss_en: string;
  context_sentence: string;
  state: "new" | "learning" | "review" | "relearning" | "suspended";
  due_at: number;
  interval_days: number;
  ease: number;
  reps: number;
  lapses: number;
  last_review_at: number | null;
  algorithm_version: number;
  suspended_from_state: Exclude<ReviewCard["state"], "suspended"> | null;
  suspended_reason: string | null;
  updated_at: number;
  context_surface: string;
  cloze_sentence: string;
  queue_eligible?: boolean;
}

export interface Bookmark {
  id: string;
  item_id: string;
  locator: string;
  label: string;
  note: string;
  created_at: number;
}

export interface ActivityDay {
  day: string;
  read_seconds: number;
  listen_seconds: number;
  review_count: number;
  lookups: number;
}

export interface VocabSettings {
  chinese_explanation: boolean;
  font_scale: number;
  line_height: number;
  local_lock: boolean;
  auto_follow: boolean;
  daily_new_limit: number;
}

export interface VocabSnapshot {
  items: LibraryItem[];
  blocks: ContentBlock[];
  segments: TranscriptSegment[];
  lexemes: Lexeme[];
  occurrences: Occurrence[];
  reviewCards: ReviewCard[];
  bookmarks: Bookmark[];
  activity: ActivityDay[];
  settings: VocabSettings;
}

export interface SelectionTarget {
  surface: string;
  sentence: string;
  before: string;
  after: string;
  itemId: string;
  blockId?: string;
  segmentId?: string;
  startUtf16: number;
  endUtf16: number;
  startMs?: number;
  rect?: { top: number; left: number; width: number };
}

export interface AiExplanation {
  target?: {
    surface?: string;
    canonical?: string;
    kind?: string;
    pronunciation?: string | null;
    ipa?: string | null;
  };
  sense?: {
    glosses_en?: string[];
    meaning_in_context_en?: string;
    explanation_en?: string;
    explanation_zh?: string | null;
    parts_of_speech?: string[];
    register?: string | null;
  };
  context_translation_zh?: string | null;
  word_family?: Array<{ word?: string; part_of_speech?: string }>;
  synonyms?: Array<{ word?: string; difference_en?: string }>;
  example?: { sentence_en?: string; translation_zh?: string | null };
  cefr?: string | null;
  collocations?: string[];
  warnings?: string[];
}

export interface ParsedArticle {
  title: string;
  description: string;
  author: string;
  source: string;
  sourceUrl?: string;
  blocks: Array<{ kind: ContentBlock["kind"]; text: string }>;
}

export interface ParsedPodcast {
  title: string;
  description: string;
  source: string;
  sourceUrl?: string;
  audioUrl?: string;
  transcriptUrl?: string;
  transcriptType?: string;
  durationMs: number;
  segments: Array<{
    start_ms: number;
    end_ms: number;
    text: string;
    speaker?: string | null;
  }>;
}

export type ReviewRating = "again" | "hard" | "good" | "easy";
