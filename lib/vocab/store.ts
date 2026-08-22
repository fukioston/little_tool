import { localDb } from "@/lib/local-db/client";
import { uid } from "./content";
import {
  broadcastVocabChange,
  withVocabReadLock,
  withVocabWriteLock,
} from "./lock";
import {
  applyDailyNewLimit,
  createContextCloze,
  hasUsefulEnglishExplanation,
  localDayBounds,
  localDayKey,
  reconcileReviewSuspension,
  reviewEventStartedAsNew,
  scheduleReviewV2,
} from "./srs";
import type {
  AiExplanation,
  Bookmark,
  Lexeme,
  LibraryItem,
  ParsedArticle,
  ParsedPodcast,
  ReviewCard,
  ReviewRating,
  SelectionTarget,
  VocabSettings,
  VocabSnapshot,
} from "./types";

const DB = "vocab";
export const VOCAB_APPLICATION_ID = 0x53484349;
export const VOCAB_RUNTIME_VERSION = 2;
const LEGACY_SEED_CLEANUP_MARKER = "__shici_system_legacy_seed_cleanup_v1";
const LEGACY_SEED_IDS = {
  items: ["seed_article_deliberate", "seed_podcast_market"],
  blocks: Array.from({ length: 8 }, (_, index) => `seed_block_${index + 1}`),
  segments: Array.from({ length: 6 }, (_, index) => `seed_segment_${index}`),
  lexemes: [
    "seed_lexeme_deliberate",
    "seed_lexeme_restraint",
    "seed_lexeme_bustle",
    "seed_lexeme_fleeting",
  ],
  occurrences: [
    "seed_occ_deliberate",
    "seed_occ_restraint",
    "seed_occ_bustle",
    "seed_occ_fleeting",
  ],
  cards: [
    "seed_card_deliberate",
    "seed_card_restraint",
    "seed_card_fleeting",
  ],
  activity: ["seed_activity_today", "seed_activity_prior"],
} as const;

type SqlValue = string | number | bigint | boolean | null | Uint8Array;
type Statement = { sql: string; params?: SqlValue[] | Record<string, SqlValue> };

export type VocabWriteInspection =
  | "exact_saved"
  | "absent"
  | "conflict"
  | "unknown";

export type VocabImportWriteReceipt = Readonly<{
  version: 1;
  kind: "article" | "podcast";
  operationId: string;
  itemId: string;
  importId: string;
  contentIds: readonly string[];
  createdAt: number;
  publishedAt: string;
  projectionSha256: string;
}>;

export type VocabOccurrenceWriteReceipt = Readonly<{
  version: 1;
  kind: "occurrence";
  operationId: string;
  occurrenceId: string;
  activityId: string;
  lexemeId: string;
  cardId: string;
  createdAt: number;
  day: string;
  projectionSha256: string;
}>;

export type VocabWriteReceipt =
  | VocabImportWriteReceipt
  | VocabOccurrenceWriteReceipt;

export type VocabReviewStateProjection = Readonly<{
  state: ReviewCard["state"];
  due_at: number;
  interval_days: number;
  ease: number;
  reps: number;
  lapses: number;
  last_review_at: number | null;
  algorithm_version: number;
  suspended_from_state: ReviewCard["suspended_from_state"];
  suspended_reason: string | null;
  updated_at: number;
}>;

type VocabReviewReceiptBase = Readonly<{
  version: 1;
  operationId: string;
  eventId: string;
  activityId: string;
  cardId: string;
  rating: ReviewRating;
  reviewedAt: number;
  day: string;
  before: VocabReviewStateProjection;
  after: VocabReviewStateProjection;
}>;

export type VocabReviewRatingReceipt = VocabReviewReceiptBase & Readonly<{
  kind: "review-rating";
  projectionSha256: string;
}>;

export type VocabReviewUndoReceipt = VocabReviewReceiptBase & Readonly<{
  kind: "review-undo";
  ratingOperationId: string | null;
  undoneAt: number;
  projectionSha256: string;
}>;

export type VocabReviewReceipt =
  | VocabReviewRatingReceipt
  | VocabReviewUndoReceipt;

export type VocabReviewInspection =
  | "exact"
  | "absent"
  | "conflict"
  | "still_unknown"
  | "changed";

export type VocabReviewCommitResult<Receipt extends VocabReviewReceipt> =
  Readonly<{
    status: "exact" | "already";
    eventId: string;
    receipt: Receipt;
  }>;

export type VocabSettingKey = keyof VocabSettings;

export type VocabSettingWriteRow<Key extends VocabSettingKey = VocabSettingKey> =
  Readonly<{
    key: Key;
    value: string;
    updated_at: number;
  }>;

export type VocabSettingsWriteRows = readonly [
  VocabSettingWriteRow<"chinese_explanation"> | null,
  VocabSettingWriteRow<"font_scale"> | null,
  VocabSettingWriteRow<"line_height"> | null,
  VocabSettingWriteRow<"local_lock"> | null,
  VocabSettingWriteRow<"auto_follow"> | null,
  VocabSettingWriteRow<"daily_new_limit"> | null,
];

export type VocabSettingsWriteSnapshot = Readonly<{
  generationId: string;
  generationSequence: number;
  rows: VocabSettingsWriteRows;
  settings: VocabSettings;
}>;

export type VocabSettingsSaveReceipt = Readonly<{
  purpose: "vocab-settings-write";
  version: 1;
  kind: "settings-save";
  operationId: string;
  generationId: string;
  generationSequence: number;
  before: VocabSettingsWriteSnapshot;
  after: VocabSettingsWriteSnapshot;
  projectionSha256: string;
}>;

export type VocabSettingsWriteReceipt = VocabSettingsSaveReceipt;

export type VocabSettingsWriteInspection =
  | "exact_saved"
  | "expected"
  | "changed"
  | "still_unknown"
  | "invalid_receipt";

export type VocabSettingsWriteResult =
  | Readonly<{
      outcome: "saved" | "already_saved";
      receipt: VocabSettingsWriteReceipt;
      entityId: "settings";
      updatedAt: number;
    }>
  | Readonly<{
      outcome: "changed";
      receipt: VocabSettingsWriteReceipt;
      entityId: "settings";
      retryable: false;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      receipt: VocabSettingsWriteReceipt;
      entityId: "settings";
      retryable: true;
    }>;

export type VocabSettingsMutationErrorCode =
  | "invalid_input"
  | "invalid_receipt"
  | "changed"
  | "inspect_failed"
  | "write_failed";

export class VocabSettingsMutationError extends Error {
  readonly name = "VocabSettingsMutationError";

  constructor(
    readonly code: VocabSettingsMutationErrorCode,
    message: string,
    readonly receipt?: VocabSettingsWriteReceipt,
  ) {
    super(message);
  }
}

type VocabSettingsQueryResult<Result extends object> = Readonly<{
  rows: readonly Result[];
}>;

export type VocabSettingsStorageRuntime = Readonly<{
  withReadLock?<Result>(operation: () => Promise<Result>): Promise<Result>;
  withExclusiveLock<Result>(operation: () => Promise<Result>): Promise<Result>;
  query<Result extends object>(
    sql: string,
    params?: SqlValue[],
  ): Promise<VocabSettingsQueryResult<Result>>;
  batch(statements: readonly Statement[]): Promise<unknown>;
  currentGeneration(): Promise<Readonly<{ generationId: string; sequence: number }>>;
  now(): number;
  randomUUID(): string;
  broadcast(reason: string): void;
}>;

export type VocabItemWriteKind =
  | "progress-checkpoint"
  | "complete"
  | "reopen"
  | "archive"
  | "restore";

export type VocabItemWriteSnapshot = Readonly<{
  generationId: string;
  generationSequence: number;
  item: LibraryItem;
}>;

type VocabItemReceiptBase<Kind extends VocabItemWriteKind> = Readonly<{
  purpose: "vocab-item-write";
  version: 1;
  kind: Kind;
  operationId: string;
  generationId: string;
  generationSequence: number;
  before: VocabItemWriteSnapshot;
  after: VocabItemWriteSnapshot;
  projectionSha256: string;
}>;

export type VocabItemProgressCheckpointReceipt =
  VocabItemReceiptBase<"progress-checkpoint">;
export type VocabItemCompleteReceipt = VocabItemReceiptBase<"complete">;
export type VocabItemReopenReceipt = VocabItemReceiptBase<"reopen">;
export type VocabItemArchiveReceipt = VocabItemReceiptBase<"archive">;
export type VocabItemRestoreReceipt = VocabItemReceiptBase<"restore">;

export type VocabItemWriteReceipt =
  | VocabItemProgressCheckpointReceipt
  | VocabItemCompleteReceipt
  | VocabItemReopenReceipt
  | VocabItemArchiveReceipt
  | VocabItemRestoreReceipt;

export type VocabItemWriteInspection =
  | "exact_saved"
  | "expected"
  | "changed"
  | "still_unknown"
  | "invalid_receipt";

export type VocabItemWriteResult =
  | Readonly<{
      outcome: "saved" | "already_saved";
      receipt: VocabItemWriteReceipt;
      entityId: string;
      updatedAt: number;
    }>
  | Readonly<{
      outcome: "changed";
      receipt: VocabItemWriteReceipt;
      entityId: string;
      retryable: false;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      receipt: VocabItemWriteReceipt;
      entityId: string;
      retryable: true;
    }>;

export type VocabItemMutationErrorCode =
  | "invalid_input"
  | "invalid_receipt"
  | "changed"
  | "inspect_failed"
  | "write_failed";

export class VocabItemMutationError extends Error {
  readonly name = "VocabItemMutationError";

  constructor(
    readonly code: VocabItemMutationErrorCode,
    message: string,
    readonly receipt?: VocabItemWriteReceipt,
  ) {
    super(message);
  }
}

export type VocabItemStorageRuntime = Readonly<{
  withReadLock?<Result>(operation: () => Promise<Result>): Promise<Result>;
  withExclusiveLock<Result>(operation: () => Promise<Result>): Promise<Result>;
  query<Result extends object>(
    sql: string,
    params?: SqlValue[],
  ): Promise<VocabSettingsQueryResult<Result>>;
  batch(statements: readonly Statement[]): Promise<unknown>;
  currentGeneration(): Promise<Readonly<{ generationId: string; sequence: number }>>;
  now(): number;
  randomUUID(): string;
  broadcast(reason: string): void;
}>;

export type VocabStoredLexeme = Readonly<Pick<
  Lexeme,
  | "id"
  | "headword"
  | "normalized_key"
  | "pronunciation"
  | "gloss_en"
  | "explanation_en"
  | "explanation_zh"
  | "status"
  | "starred"
  | "notes"
  | "lookup_count"
  | "created_at"
  | "updated_at"
>>;

export type VocabStoredReviewCard = Readonly<Pick<
  ReviewCard,
  | "id"
  | "lexeme_id"
  | "state"
  | "due_at"
  | "interval_days"
  | "ease"
  | "reps"
  | "lapses"
  | "last_review_at"
  | "algorithm_version"
  | "suspended_from_state"
  | "suspended_reason"
  | "updated_at"
>>;

export type VocabLexemeExpectedEntry = Readonly<{
  lexeme: VocabStoredLexeme;
  reviewCard: VocabStoredReviewCard | null;
}>;

export type VocabLexemeExpectedSet = Readonly<{
  generationId: string;
  generationSequence: number;
  entries: readonly VocabLexemeExpectedEntry[];
}>;

export type VocabLexemeExpectedState = Readonly<{
  generationId: string;
  generationSequence: number;
  lexeme: VocabStoredLexeme;
  reviewCard: VocabStoredReviewCard | null;
}>;

export type VocabLexemeWriteSnapshot = Readonly<{
  generationId: string;
  generationSequence: number;
  lexeme: VocabStoredLexeme;
}>;

export type VocabLexemeStatusWriteSnapshot = VocabLexemeWriteSnapshot & Readonly<{
  reviewCard: VocabStoredReviewCard | null;
}>;

type VocabLexemeReceiptBase<
  Kind extends "note-save" | "star-set",
> = Readonly<{
  purpose: "vocab-lexeme-write";
  version: 1;
  kind: Kind;
  operationId: string;
  generationId: string;
  generationSequence: number;
  before: VocabLexemeWriteSnapshot;
  after: VocabLexemeWriteSnapshot;
  projectionSha256: string;
}>;

export type VocabLexemeNoteSaveReceipt =
  VocabLexemeReceiptBase<"note-save">;
export type VocabLexemeStarSetReceipt =
  VocabLexemeReceiptBase<"star-set">;
export type VocabLexemeStatusSetReceipt = Readonly<{
  purpose: "vocab-lexeme-write";
  version: 1;
  kind: "status-set";
  operationId: string;
  generationId: string;
  generationSequence: number;
  before: VocabLexemeStatusWriteSnapshot;
  after: VocabLexemeStatusWriteSnapshot;
  projectionSha256: string;
}>;

export type VocabLexemeWriteReceipt =
  | VocabLexemeNoteSaveReceipt
  | VocabLexemeStarSetReceipt
  | VocabLexemeStatusSetReceipt;

export type VocabLexemeWriteInspection =
  | "exact_saved"
  | "expected"
  | "changed"
  | "still_unknown"
  | "invalid_receipt";

export type VocabLexemeWriteResult =
  | Readonly<{
      outcome: "saved" | "already_saved";
      receipt: VocabLexemeWriteReceipt;
      entityId: string;
      updatedAt: number;
    }>
  | Readonly<{
      outcome: "changed";
      receipt: VocabLexemeWriteReceipt;
      entityId: string;
      retryable: false;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      receipt: VocabLexemeWriteReceipt;
      entityId: string;
      retryable: true;
    }>;

export type VocabLexemeMutationErrorCode =
  | "invalid_input"
  | "invalid_receipt"
  | "changed"
  | "inspect_failed"
  | "write_failed";

export class VocabLexemeMutationError extends Error {
  readonly name = "VocabLexemeMutationError";

  constructor(
    readonly code: VocabLexemeMutationErrorCode,
    message: string,
    readonly receipt?: VocabLexemeWriteReceipt,
  ) {
    super(message);
  }
}

export type VocabLexemeStorageRuntime = Readonly<{
  withReadLock?<Result>(operation: () => Promise<Result>): Promise<Result>;
  withExclusiveLock<Result>(operation: () => Promise<Result>): Promise<Result>;
  query<Result extends object>(
    sql: string,
    params?: SqlValue[],
  ): Promise<VocabSettingsQueryResult<Result>>;
  batch(statements: readonly Statement[]): Promise<unknown>;
  currentGeneration(): Promise<Readonly<{ generationId: string; sequence: number }>>;
  now(): number;
  randomUUID(): string;
  broadcast(reason: string): void;
}>;

export type VocabEngagementGenerationExpectation = Readonly<{
  generationId: string;
  generationSequence: number;
}>;

export type VocabBookmarkCreateInput = Readonly<{
  itemId: string;
  locator: string;
  label: string;
}>;

export type VocabBookmarkNoteSetInput = Readonly<{
  itemId: string;
  locator: string;
  bookmarkId: string;
  note: string;
}>;

export type VocabBookmarkDeleteInput = Readonly<{
  itemId: string;
  locator: string;
  bookmarkId: string;
}>;

export type VocabBookmarkMutationInput =
  | VocabBookmarkCreateInput
  | VocabBookmarkNoteSetInput
  | VocabBookmarkDeleteInput;

export type VocabBookmarkExpectedState =
  VocabEngagementGenerationExpectation & Readonly<{
    item: LibraryItem;
    locator: string;
    bookmarks: readonly Bookmark[];
  }>;

export type VocabStudyActivityRecordInput = Readonly<{
  kind: "read" | "listen";
  seconds: number;
  recordedAt?: number;
  timezoneOffsetMinutes?: number;
}>;

export type VocabPreparedStudyActivityInput = Readonly<{
  kind: "read" | "listen";
  seconds: number;
  recordedAt: number;
}>;

export type VocabStudyActivityRow = Readonly<{
  id: string;
  day: string;
  read_seconds: number;
  listen_seconds: number;
  review_count: number;
  lookups: number;
  created_at: number;
}>;

type VocabEngagementReceiptBase<
  Kind extends "bookmark-create" | "bookmark-note-set" | "bookmark-delete" |
    "study-activity-record",
  Expected,
  Target,
> = Readonly<{
  purpose: "vocab-engagement-write";
  version: 1;
  kind: Kind;
  operationId: string;
  generationId: string;
  generationSequence: number;
  expected: Expected;
  target: Target;
}>;

export type VocabBookmarkCreateReceipt = VocabEngagementReceiptBase<
  "bookmark-create",
  VocabBookmarkExpectedState,
  Bookmark
> & Readonly<{
  request: VocabBookmarkCreateInput;
  projectionSha256: string;
}>;

export type VocabBookmarkNoteSetReceipt = VocabEngagementReceiptBase<
  "bookmark-note-set",
  VocabBookmarkExpectedState,
  Bookmark
> & Readonly<{
  request: VocabBookmarkNoteSetInput;
  projectionSha256: string;
}>;

export type VocabBookmarkDeleteReceipt = VocabEngagementReceiptBase<
  "bookmark-delete",
  VocabBookmarkExpectedState,
  Bookmark
> & Readonly<{
  request: VocabBookmarkDeleteInput;
  projectionSha256: string;
}>;

export type VocabStudyActivityRecordReceipt = VocabEngagementReceiptBase<
  "study-activity-record",
  VocabEngagementGenerationExpectation,
  VocabStudyActivityRow
> & Readonly<{
  request: VocabPreparedStudyActivityInput;
  timezoneOffsetMinutes: number;
  projectionSha256: string;
}>;

export type VocabEngagementWriteReceipt =
  | VocabBookmarkCreateReceipt
  | VocabBookmarkNoteSetReceipt
  | VocabBookmarkDeleteReceipt
  | VocabStudyActivityRecordReceipt;

export type VocabEngagementWriteInspection =
  | "exact_saved"
  | "expected"
  | "changed"
  | "still_unknown"
  | "invalid_receipt";

export type VocabEngagementWriteResult =
  | Readonly<{
      outcome: "saved" | "already_saved";
      receipt: VocabEngagementWriteReceipt;
      entityId: string;
      createdAt: number;
    }>
  | Readonly<{
      outcome: "changed";
      receipt: VocabEngagementWriteReceipt;
      entityId: string;
      retryable: false;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      receipt: VocabEngagementWriteReceipt;
      entityId: string;
      retryable: true;
    }>;

export type VocabEngagementMutationErrorCode =
  | "invalid_input"
  | "invalid_receipt"
  | "changed"
  | "inspect_failed"
  | "write_failed";

export class VocabEngagementMutationError extends Error {
  readonly name = "VocabEngagementMutationError";

  constructor(
    readonly code: VocabEngagementMutationErrorCode,
    message: string,
    readonly receipt?: VocabEngagementWriteReceipt,
  ) {
    super(message);
  }
}

export type VocabEngagementStorageRuntime = Readonly<{
  withReadLock?<Result>(operation: () => Promise<Result>): Promise<Result>;
  withExclusiveLock<Result>(operation: () => Promise<Result>): Promise<Result>;
  query<Result extends object>(
    sql: string,
    params?: SqlValue[],
  ): Promise<VocabSettingsQueryResult<Result>>;
  batch(statements: readonly Statement[]): Promise<unknown>;
  currentGeneration(): Promise<Readonly<{ generationId: string; sequence: number }>>;
  now(): number;
  randomUUID(): string;
  timezoneOffsetMinutes?(timestamp: number): number;
  broadcast(reason: string): void;
}>;

export class VocabReviewConflictError extends Error {
  readonly code = "VOCAB_REVIEW_CONFLICT";

  constructor(
    message: string,
    readonly receipt: VocabReviewReceipt,
  ) {
    super(message);
    this.name = "VocabReviewConflictError";
  }
}

export class VocabReviewChangedError extends Error {
  readonly code = "VOCAB_REVIEW_CHANGED";

  constructor(
    message: string,
    readonly receipt: VocabReviewReceipt,
  ) {
    super(message);
    this.name = "VocabReviewChangedError";
  }
}

export class VocabReviewUncertainError extends Error {
  readonly code = "VOCAB_REVIEW_UNCERTAIN";
  override readonly cause: unknown;

  constructor(
    message: string,
    readonly receipt: VocabReviewReceipt,
    cause?: unknown,
  ) {
    super(message);
    this.name = "VocabReviewUncertainError";
    this.cause = cause;
  }
}

export class VocabReviewNotSavedError extends Error {
  readonly code = "VOCAB_REVIEW_NOT_SAVED";
  override readonly cause: unknown;

  constructor(
    message: string,
    readonly receipt: VocabReviewReceipt,
    cause?: unknown,
  ) {
    super(message);
    this.name = "VocabReviewNotSavedError";
    this.cause = cause;
  }
}

export class VocabWriteConflictError extends Error {
  readonly code = "VOCAB_WRITE_CONFLICT";

  constructor(
    message: string,
    readonly receipt: VocabWriteReceipt,
  ) {
    super(message);
    this.name = "VocabWriteConflictError";
  }
}

export class VocabWriteUncertainError extends Error {
  readonly code = "VOCAB_WRITE_UNCERTAIN";
  override readonly cause: unknown;

  constructor(
    message: string,
    readonly receipt: VocabWriteReceipt,
    cause?: unknown,
  ) {
    super(message);
    this.name = "VocabWriteUncertainError";
    this.cause = cause;
  }
}

export class VocabWriteNotSavedError extends Error {
  readonly code = "VOCAB_WRITE_NOT_SAVED";
  override readonly cause: unknown;

  constructor(
    message: string,
    readonly receipt: VocabWriteReceipt,
    cause?: unknown,
  ) {
    super(message);
    this.name = "VocabWriteNotSavedError";
    this.cause = cause;
  }
}

const RECEIPT_ID_PATTERN = /^[a-z]+_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_HASH_PATTERN = /^[0-9a-f]{64}$/;

function isReceiptId(value: unknown, prefix: string): value is string {
  return typeof value === "string" &&
    value.startsWith(`${prefix}_`) &&
    RECEIPT_ID_PATTERN.test(value);
}

function isSafeOpaqueReviewCardId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim().length === 0 ||
    Array.from(value).length > 256
  ) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) {
      return false;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        next < 0xdc00 ||
        next > 0xdfff
      ) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isReceiptTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isVocabImportWriteReceipt(
  value: unknown,
): value is VocabImportWriteReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<VocabImportWriteReceipt>;
  const contentPrefix = receipt.kind === "article" ? "block" : "segment";
  const itemPrefix = receipt.kind === "article" ? "article" : "podcast";
  return receipt.version === 1 &&
    (receipt.kind === "article" || receipt.kind === "podcast") &&
    isReceiptId(receipt.operationId, "operation") &&
    isReceiptId(receipt.itemId, itemPrefix) &&
    isReceiptId(receipt.importId, "import") &&
    Array.isArray(receipt.contentIds) &&
    receipt.contentIds.length <= 100_000 &&
    new Set(receipt.contentIds).size === receipt.contentIds.length &&
    receipt.contentIds.every((id) => isReceiptId(id, contentPrefix)) &&
    isReceiptTimestamp(receipt.createdAt) &&
    typeof receipt.publishedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(receipt.publishedAt) &&
    typeof receipt.projectionSha256 === "string" &&
    RECEIPT_HASH_PATTERN.test(receipt.projectionSha256);
}

export function isVocabOccurrenceWriteReceipt(
  value: unknown,
): value is VocabOccurrenceWriteReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<VocabOccurrenceWriteReceipt>;
  return receipt.version === 1 &&
    receipt.kind === "occurrence" &&
    isReceiptId(receipt.operationId, "operation") &&
    isReceiptId(receipt.occurrenceId, "occurrence") &&
    isReceiptId(receipt.activityId, "activity") &&
    isReceiptId(receipt.lexemeId, "lexeme") &&
    isReceiptId(receipt.cardId, "card") &&
    isReceiptTimestamp(receipt.createdAt) &&
    typeof receipt.day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(receipt.day) &&
    typeof receipt.projectionSha256 === "string" &&
    RECEIPT_HASH_PATTERN.test(receipt.projectionSha256);
}

async function projectionSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const legacySchemaStatements: readonly Statement[] = [
  { sql: `CREATE TABLE vocab_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('article','podcast')),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    source_url TEXT,
    author TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    audio_url TEXT,
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread','in_progress','complete','archived')),
    progress REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )` },
  { sql: `CREATE TABLE vocab_blocks (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES vocab_items(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'paragraph',
    text TEXT NOT NULL,
    UNIQUE(item_id, ordinal)
  )` },
  { sql: `CREATE TABLE vocab_transcript_segments (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES vocab_items(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    speaker TEXT,
    UNIQUE(item_id, ordinal)
  )` },
  { sql: `CREATE TABLE vocab_lexemes (
    id TEXT PRIMARY KEY,
    headword TEXT NOT NULL,
    normalized_key TEXT NOT NULL UNIQUE,
    pronunciation TEXT NOT NULL DEFAULT '',
    gloss_en TEXT NOT NULL DEFAULT '',
    explanation_en TEXT NOT NULL DEFAULT '',
    explanation_zh TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'saved' CHECK (status IN ('saved','learning','known','ignored')),
    starred INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    lookup_count INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )` },
  { sql: `CREATE TABLE vocab_occurrences (
    id TEXT PRIMARY KEY,
    lexeme_id TEXT NOT NULL REFERENCES vocab_lexemes(id) ON DELETE CASCADE,
    item_id TEXT REFERENCES vocab_items(id) ON DELETE SET NULL,
    block_id TEXT REFERENCES vocab_blocks(id) ON DELETE SET NULL,
    segment_id TEXT REFERENCES vocab_transcript_segments(id) ON DELETE SET NULL,
    surface TEXT NOT NULL,
    context_before TEXT NOT NULL DEFAULT '',
    context_sentence TEXT NOT NULL,
    context_after TEXT NOT NULL DEFAULT '',
    start_utf16 INTEGER NOT NULL DEFAULT 0,
    end_utf16 INTEGER NOT NULL DEFAULT 0,
    start_ms INTEGER,
    note TEXT NOT NULL DEFAULT '',
    explanation_json TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )` },
  { sql: `CREATE TABLE vocab_review_cards (
    id TEXT PRIMARY KEY,
    lexeme_id TEXT NOT NULL UNIQUE REFERENCES vocab_lexemes(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'new',
    due_at INTEGER NOT NULL,
    interval_days REAL NOT NULL DEFAULT 0,
    ease REAL NOT NULL DEFAULT 2.5,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    last_review_at INTEGER
  )` },
  { sql: `CREATE TABLE vocab_review_events (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES vocab_review_cards(id) ON DELETE CASCADE,
    rating TEXT NOT NULL,
    reviewed_at INTEGER NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    undone_at INTEGER
  )` },
  { sql: `CREATE TABLE vocab_bookmarks (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES vocab_items(id) ON DELETE CASCADE,
    locator TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )` },
  { sql: `CREATE TABLE vocab_activity (
    id TEXT PRIMARY KEY,
    day TEXT NOT NULL,
    read_seconds INTEGER NOT NULL DEFAULT 0,
    listen_seconds INTEGER NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    lookups INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )` },
  { sql: `CREATE TABLE vocab_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )` },
  { sql: `CREATE TABLE vocab_imports (
    id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    item_id TEXT,
    created_at INTEGER NOT NULL
  )` },
  { sql: "CREATE INDEX idx_vocab_items_kind_updated ON vocab_items(kind, updated_at DESC)" },
  { sql: "CREATE INDEX idx_vocab_blocks_item_ordinal ON vocab_blocks(item_id, ordinal)" },
  { sql: "CREATE INDEX idx_vocab_segments_item_start ON vocab_transcript_segments(item_id, start_ms)" },
  { sql: "CREATE INDEX idx_vocab_occurrences_lexeme ON vocab_occurrences(lexeme_id, created_at DESC)" },
  { sql: "CREATE INDEX idx_vocab_cards_due ON vocab_review_cards(due_at, state)" },
];

const migrationLedgerStatement: Statement = {
  sql: `CREATE TABLE vocab_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`,
};

const schemaV2Statements: readonly Statement[] = [
  { sql: "ALTER TABLE vocab_review_cards ADD COLUMN algorithm_version INTEGER NOT NULL DEFAULT 2" },
  { sql: "ALTER TABLE vocab_review_cards ADD COLUMN suspended_from_state TEXT" },
  { sql: "ALTER TABLE vocab_review_cards ADD COLUMN suspended_reason TEXT" },
  { sql: "ALTER TABLE vocab_review_cards ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0" },
  { sql: "ALTER TABLE vocab_review_events ADD COLUMN activity_id TEXT REFERENCES vocab_activity(id) ON DELETE SET NULL" },
  { sql: "UPDATE vocab_review_cards SET updated_at=COALESCE(last_review_at,due_at) WHERE updated_at=0" },
];

const legacyTableColumns = {
  vocab_items: ["id", "kind", "title", "description", "source", "source_url", "author", "published_at", "duration_ms", "audio_url", "status", "progress", "created_at", "updated_at"],
  vocab_blocks: ["id", "item_id", "ordinal", "kind", "text"],
  vocab_transcript_segments: ["id", "item_id", "ordinal", "start_ms", "end_ms", "text", "speaker"],
  vocab_lexemes: ["id", "headword", "normalized_key", "pronunciation", "gloss_en", "explanation_en", "explanation_zh", "status", "starred", "notes", "lookup_count", "created_at", "updated_at"],
  vocab_occurrences: ["id", "lexeme_id", "item_id", "block_id", "segment_id", "surface", "context_before", "context_sentence", "context_after", "start_utf16", "end_utf16", "start_ms", "note", "explanation_json", "created_at"],
  vocab_review_cards: ["id", "lexeme_id", "state", "due_at", "interval_days", "ease", "reps", "lapses", "last_review_at"],
  vocab_review_events: ["id", "card_id", "rating", "reviewed_at", "before_json", "after_json", "undone_at"],
  vocab_bookmarks: ["id", "item_id", "locator", "label", "note", "created_at"],
  vocab_activity: ["id", "day", "read_seconds", "listen_seconds", "review_count", "lookups", "created_at"],
  vocab_settings: ["key", "value", "updated_at"],
  vocab_imports: ["id", "method", "label", "status", "error", "item_id", "created_at"],
} as const;

const ledgerColumns = ["version", "name", "applied_at"] as const;
const v2CardColumns = [
  ...legacyTableColumns.vocab_review_cards,
  "algorithm_version",
  "suspended_from_state",
  "suspended_reason",
  "updated_at",
] as const;
const v2EventColumns = [
  ...legacyTableColumns.vocab_review_events,
  "activity_id",
] as const;

type TableContract = Readonly<Record<string, readonly string[]>>;
type SchemaObject = Readonly<{ type: string; name: string }>;
type StoredReviewCard = Pick<
  ReviewCard,
  | "id"
  | "state"
  | "due_at"
  | "interval_days"
  | "ease"
  | "reps"
  | "lapses"
  | "last_review_at"
  | "algorithm_version"
  | "suspended_from_state"
  | "suspended_reason"
  | "updated_at"
>;
type ReviewEligibilityCard = Pick<
  ReviewCard,
  | "id"
  | "state"
  | "suspended_from_state"
  | "suspended_reason"
  | "updated_at"
>;

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

function newReviewCardStatement(
  lexemeId: string,
  status: Lexeme["status"],
  hasExplanation: boolean,
  now: number,
  cardId = uid("card"),
): Statement {
  const suspension = reconcileReviewSuspension({
    state: "new",
    suspended_from_state: null,
    suspended_reason: null,
  }, status, hasExplanation);
  return {
    sql: `INSERT INTO vocab_review_cards(
      id,lexeme_id,state,due_at,interval_days,ease,reps,lapses,last_review_at,
      algorithm_version,suspended_from_state,suspended_reason,updated_at
    ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE NOT EXISTS (SELECT 1 FROM vocab_review_cards WHERE lexeme_id=?)`,
    params: [
      cardId, lexemeId, suspension.state, now, 0, 2.5, 0, 0, null, 2,
      suspension.suspended_from_state, suspension.suspended_reason, now, lexemeId,
    ],
  };
}

function reviewSuspensionUpdateStatement(
  card: ReviewEligibilityCard,
  status: Lexeme["status"],
  hasExplanation: boolean,
  now: number,
): Statement | null {
  const next = reconcileReviewSuspension(card, status, hasExplanation);
  if (
    next.state === card.state &&
    next.suspended_from_state === card.suspended_from_state &&
    next.suspended_reason === card.suspended_reason
  ) return null;
  return {
    sql: `UPDATE vocab_review_cards
      SET state=?,suspended_from_state=?,suspended_reason=?,updated_at=?
      WHERE id=?`,
    params: [
      next.state,
      next.suspended_from_state,
      next.suspended_reason,
      Math.max(now, card.updated_at + 1),
      card.id,
    ],
  };
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object") {
    const record = result as { rows?: T[]; results?: T[] };
    return record.rows ?? record.results ?? [];
  }
  return [];
}

async function rawQuery<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
  return rowsOf<T>(await localDb.query(DB, sql, params));
}

async function rawRun(sql: string, params: SqlValue[] = []) {
  return localDb.run(DB, sql, params);
}

async function rawBatch(statements: readonly Statement[]) {
  return localDb.batch(DB, statements);
}

async function readPragma(name: "application_id" | "user_version"): Promise<number> {
  const rows = await rawQuery<Record<string, number>>(`PRAGMA ${name}`);
  return Number(rows[0]?.[name] ?? 0);
}

async function schemaObjects(): Promise<SchemaObject[]> {
  return rawQuery<SchemaObject>(
    "SELECT type,name FROM sqlite_schema WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type,name",
  );
}

async function tableColumns(table: string): Promise<string[]> {
  const escaped = table.replaceAll('"', '""');
  const rows = await rawQuery<{ name: string }>(`PRAGMA table_info("${escaped}")`);
  return rows.map((row) => row.name);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function matchesExactContract(
  objects: readonly SchemaObject[],
  contract: TableContract,
): Promise<boolean> {
  if (objects.some((object) => object.type !== "table")) return false;
  const expectedNames = Object.keys(contract).sort();
  const actualNames = objects.map((object) => object.name).sort();
  if (!sameStrings(actualNames, expectedNames)) return false;
  for (const [table, expectedColumns] of Object.entries(contract)) {
    if (!sameStrings(await tableColumns(table), expectedColumns)) return false;
  }
  return true;
}

function versionContract(version: 1 | 2): TableContract {
  const base: Record<string, readonly string[]> = {
    ...legacyTableColumns,
    vocab_schema_migrations: ledgerColumns,
  };
  if (version === 2) {
    base.vocab_review_cards = v2CardColumns;
    base.vocab_review_events = v2EventColumns;
  }
  return base;
}

async function assertRuntimeContract(version: 1 | 2): Promise<void> {
  const objects = await schemaObjects();
  if (!await matchesExactContract(objects, versionContract(version))) {
    throw new Error(`拾词数据库 v${version} 的表结构不完整或包含未知对象。`);
  }
  const ledger = await rawQuery<{ version: number }>(
    "SELECT version FROM vocab_schema_migrations ORDER BY version",
  );
  const expected = Array.from({ length: version }, (_, index) => index + 1);
  if (!sameStrings(ledger.map((row) => String(row.version)), expected.map(String))) {
    throw new Error("拾词数据库迁移记录不完整。");
  }
}

async function installSchemaV1(now: number): Promise<void> {
  await rawBatch([
    ...legacySchemaStatements,
    migrationLedgerStatement,
    {
      sql: "INSERT INTO vocab_schema_migrations(version,name,applied_at) VALUES(?,?,?)",
      params: [1, "formalize-runtime-schema", now],
    },
    { sql: `PRAGMA application_id=${VOCAB_APPLICATION_ID}` },
    { sql: "PRAGMA user_version=1" },
  ]);
}

async function adoptExactLegacySchema(now: number): Promise<void> {
  await rawBatch([
    migrationLedgerStatement,
    {
      sql: "INSERT INTO vocab_schema_migrations(version,name,applied_at) VALUES(?,?,?)",
      params: [1, "adopt-exact-legacy-runtime", now],
    },
    { sql: `PRAGMA application_id=${VOCAB_APPLICATION_ID}` },
    { sql: "PRAGMA user_version=1" },
  ]);
}

async function migrateSchemaV2(now: number): Promise<void> {
  await rawBatch([
    ...schemaV2Statements,
    {
      sql: "INSERT INTO vocab_schema_migrations(version,name,applied_at) VALUES(?,?,?)",
      params: [2, "srs-v2", now],
    },
    { sql: "PRAGMA user_version=2" },
  ]);
}

async function migrateRuntimeSchema(): Promise<boolean> {
  const now = Date.now();
  let applicationId = await readPragma("application_id");
  let version = await readPragma("user_version");
  const objects = await schemaObjects();
  let changed = false;

  if (applicationId === 0 && version === 0) {
    if (objects.length === 0) {
      await installSchemaV1(now);
    } else if (await matchesExactContract(objects, legacyTableColumns)) {
      await adoptExactLegacySchema(now);
    } else {
      throw new Error("当前文件不是可识别的旧版拾词数据库，已停止迁移。");
    }
    applicationId = VOCAB_APPLICATION_ID;
    version = 1;
    changed = true;
  }

  if (applicationId !== VOCAB_APPLICATION_ID) {
    throw new Error("当前 SQLite 文件不属于拾词，未执行任何迁移。");
  }
  if (!Number.isInteger(version) || version < 1 || version > VOCAB_RUNTIME_VERSION) {
    throw new Error(`拾词数据库版本 ${version} 不受支持。`);
  }

  await assertRuntimeContract(version as 1 | 2);
  if (version < 2) {
    await migrateSchemaV2(now);
    version = 2;
    changed = true;
  }

  if (
    await readPragma("application_id") !== VOCAB_APPLICATION_ID ||
    await readPragma("user_version") !== VOCAB_RUNTIME_VERSION
  ) {
    throw new Error("拾词数据库身份写入未完成。");
  }
  await assertRuntimeContract(2);
  await rawRun("PRAGMA optimize");
  return changed;
}

async function cleanupLegacySeedData(now: number): Promise<boolean> {
  const marked = await rawQuery<{ value: string }>(
    "SELECT value FROM vocab_settings WHERE key=?",
    [LEGACY_SEED_CLEANUP_MARKER],
  );
  if (marked.length > 0) return false;

  const seedGroups = [
    ["vocab_items", LEGACY_SEED_IDS.items],
    ["vocab_blocks", LEGACY_SEED_IDS.blocks],
    ["vocab_transcript_segments", LEGACY_SEED_IDS.segments],
    ["vocab_lexemes", LEGACY_SEED_IDS.lexemes],
    ["vocab_occurrences", LEGACY_SEED_IDS.occurrences],
    ["vocab_review_cards", LEGACY_SEED_IDS.cards],
    ["vocab_activity", LEGACY_SEED_IDS.activity],
  ] as const;
  const evidenceSql = seedGroups.map(([table, ids]) =>
    `SELECT 1 AS present FROM ${table} WHERE id IN (${placeholders(ids)})`
  ).join(" UNION ALL ");
  const evidence = await rawQuery<{ present: number }>(
    `${evidenceSql} LIMIT 1`,
    seedGroups.flatMap(([, ids]) => [...ids]),
  );
  if (evidence.length === 0) return false;

  const dependencies = await rawQuery<{
    id: string;
    status: Lexeme["status"];
    gloss_en: string;
    explanation_en: string;
    card_id: string | null;
    card_state: ReviewCard["state"] | null;
    card_suspended_from_state: ReviewCard["suspended_from_state"];
    card_suspended_reason: string | null;
    card_updated_at: number | null;
    user_occurrence_count: number;
    review_event_count: number;
  }>(
    `SELECT l.id,l.status,l.gloss_en,l.explanation_en,
            c.id AS card_id,c.state AS card_state,
            c.suspended_from_state AS card_suspended_from_state,
            c.suspended_reason AS card_suspended_reason,
            c.updated_at AS card_updated_at,
            (SELECT COUNT(*) FROM vocab_occurrences o
             WHERE o.lexeme_id=l.id
               AND o.id NOT IN (${placeholders(LEGACY_SEED_IDS.occurrences)}))
              AS user_occurrence_count,
            (SELECT COUNT(*) FROM vocab_review_events e WHERE e.card_id=c.id)
              AS review_event_count
     FROM vocab_lexemes l
     LEFT JOIN vocab_review_cards c ON c.lexeme_id=l.id
     WHERE l.id IN (${placeholders(LEGACY_SEED_IDS.lexemes)})`,
    [...LEGACY_SEED_IDS.occurrences, ...LEGACY_SEED_IDS.lexemes],
  );
  const expectedCards = new Map<string, string>([
    ["seed_lexeme_deliberate", "seed_card_deliberate"],
    ["seed_lexeme_restraint", "seed_card_restraint"],
    ["seed_lexeme_fleeting", "seed_card_fleeting"],
  ]);
  const statements: Statement[] = [
    {
      sql: `UPDATE vocab_imports SET item_id=NULL
            WHERE item_id IN (${placeholders(LEGACY_SEED_IDS.items)})`,
      params: [...LEGACY_SEED_IDS.items],
    },
    {
      sql: `DELETE FROM vocab_occurrences
            WHERE id IN (${placeholders(LEGACY_SEED_IDS.occurrences)})`,
      params: [...LEGACY_SEED_IDS.occurrences],
    },
    {
      sql: `DELETE FROM vocab_activity
            WHERE id IN (${placeholders(LEGACY_SEED_IDS.activity)})`,
      params: [...LEGACY_SEED_IDS.activity],
    },
  ];

  for (const row of dependencies) {
    const expectedCard = expectedCards.get(row.id);
    const seedCardWithoutHistory = row.card_id !== null &&
      row.card_id === expectedCard && row.review_event_count === 0;
    const userCard = row.card_id !== null && row.card_id !== expectedCard;
    const preserveLexeme = row.user_occurrence_count > 0 ||
      row.review_event_count > 0 || userCard;
    if (seedCardWithoutHistory && row.card_id) {
      statements.push({
        sql: "DELETE FROM vocab_review_cards WHERE id=? AND lexeme_id=?",
        params: [row.card_id, row.id],
      });
    }
    if (!preserveLexeme) {
      statements.push({
        sql: `DELETE FROM vocab_lexemes WHERE id=?
              AND NOT EXISTS (SELECT 1 FROM vocab_occurrences WHERE lexeme_id=?)
              AND NOT EXISTS (SELECT 1 FROM vocab_review_cards WHERE lexeme_id=?)`,
        params: [row.id, row.id, row.id],
      });
    } else if (!row.card_id || seedCardWithoutHistory) {
      statements.push(newReviewCardStatement(
        row.id,
        row.status,
        hasUsefulEnglishExplanation(row.gloss_en, row.explanation_en),
        now,
      ));
    }
  }

  statements.push(
    {
      sql: `DELETE FROM vocab_items
            WHERE id IN (${placeholders(LEGACY_SEED_IDS.items)})`,
      params: [...LEGACY_SEED_IDS.items],
    },
    {
      sql: `DELETE FROM vocab_blocks
            WHERE id IN (${placeholders(LEGACY_SEED_IDS.blocks)})`,
      params: [...LEGACY_SEED_IDS.blocks],
    },
    {
      sql: `DELETE FROM vocab_transcript_segments
            WHERE id IN (${placeholders(LEGACY_SEED_IDS.segments)})`,
      params: [...LEGACY_SEED_IDS.segments],
    },
    {
      sql: `INSERT INTO vocab_settings(key,value,updated_at) VALUES(?,?,?)
            ON CONFLICT(key) DO NOTHING`,
      params: [LEGACY_SEED_CLEANUP_MARKER, "complete", now],
    },
  );
  await rawBatch(statements);
  return true;
}

async function reconcileExplanationEligibility(now: number): Promise<boolean> {
  const rows = await rawQuery<ReviewEligibilityCard & {
    status: Lexeme["status"];
    gloss_en: string;
    explanation_en: string;
  }>(
    `SELECT c.id,c.state,c.suspended_from_state,c.suspended_reason,c.updated_at,
            l.status,l.gloss_en,l.explanation_en
     FROM vocab_review_cards c JOIN vocab_lexemes l ON l.id=c.lexeme_id`,
  );
  const statements = rows.flatMap((row) => {
    const statement = reviewSuspensionUpdateStatement(
      row,
      row.status,
      hasUsefulEnglishExplanation(row.gloss_en, row.explanation_en),
      now,
    );
    return statement ? [statement] : [];
  });
  if (statements.length === 0) return false;
  await rawBatch(statements);
  return true;
}

async function withWrite<Result>(
  reason: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  return withVocabWriteLock(async () => {
    const result = await operation();
    broadcastVocabChange(reason);
    return result;
  });
}

export async function initializeVocabDatabase(): Promise<void> {
  await withVocabWriteLock(async () => {
    await localDb.init(DB);
    const migrated = await migrateRuntimeSchema();
    const cleaned = await cleanupLegacySeedData(Date.now());
    const reconciled = await reconcileExplanationEligibility(Date.now());
    if (migrated || cleaned || reconciled) {
      broadcastVocabChange(
        cleaned
          ? "legacy-seed-cleaned"
          : migrated
            ? "schema-migrated"
            : "review-eligibility-reconciled",
      );
    }
  });
}

function defaultSettings(): VocabSettings {
  return {
    chinese_explanation: false,
    font_scale: 1,
    line_height: 1.92,
    local_lock: false,
    auto_follow: true,
    daily_new_limit: 8,
  };
}

function settingsFromRows(rows: readonly { key: string; value: string }[]): VocabSettings {
  const settings = defaultSettings();
  for (const row of rows) {
    if (!(row.key in settings)) continue;
    const key = row.key as keyof VocabSettings;
    const raw = row.value;
    (settings as unknown as Record<string, unknown>)[key] = raw === "true"
      ? true
      : raw === "false"
        ? false
        : Number.isNaN(Number(raw))
          ? raw
          : Number(raw);
  }
  return settings;
}

export async function loadVocabSnapshot(): Promise<VocabSnapshot> {
  return withVocabReadLock(async () => {
    const now = Date.now();
    const day = localDayBounds(now);
    const [
      items,
      blocks,
      segments,
      lexemes,
      occurrences,
      rawCards,
      bookmarks,
      activity,
      settingRows,
      todayReviewEvents,
    ] = await Promise.all([
      rawQuery<VocabSnapshot["items"][number]>(
        "SELECT * FROM vocab_items ORDER BY updated_at DESC",
      ),
      rawQuery<VocabSnapshot["blocks"][number]>(
        "SELECT * FROM vocab_blocks ORDER BY item_id, ordinal",
      ),
      rawQuery<VocabSnapshot["segments"][number]>(
        "SELECT * FROM vocab_transcript_segments ORDER BY item_id, ordinal",
      ),
      rawQuery<VocabSnapshot["lexemes"][number]>(
        `SELECT l.*, COUNT(o.id) AS occurrence_count
         FROM vocab_lexemes l
         LEFT JOIN vocab_occurrences o ON o.lexeme_id=l.id
         GROUP BY l.id ORDER BY l.updated_at DESC`,
      ),
      rawQuery<VocabSnapshot["occurrences"][number]>(
        `SELECT o.*, i.title AS item_title
         FROM vocab_occurrences o
         LEFT JOIN vocab_items i ON i.id=o.item_id
         ORDER BY o.created_at DESC`,
      ),
      rawQuery<ReviewCard & { definition_explanation_en: string }>(
        `SELECT c.*, l.headword, l.pronunciation,
                COALESCE(NULLIF(TRIM(l.gloss_en),''),l.explanation_en) AS gloss_en,
                l.explanation_en AS definition_explanation_en,
                COALESCE(o.context_sentence,'') AS context_sentence,
                COALESCE(o.surface,l.headword) AS context_surface
         FROM vocab_review_cards c
         JOIN vocab_lexemes l ON l.id=c.lexeme_id
         LEFT JOIN vocab_occurrences o ON o.id=(
           SELECT id FROM vocab_occurrences
           WHERE lexeme_id=l.id ORDER BY created_at DESC LIMIT 1
         )
         WHERE c.state!='suspended' AND l.status='learning'
         ORDER BY c.due_at`,
      ),
      rawQuery<VocabSnapshot["bookmarks"][number]>(
        "SELECT * FROM vocab_bookmarks ORDER BY created_at DESC",
      ),
      rawQuery<VocabSnapshot["activity"][number]>(
        `SELECT day,
                SUM(read_seconds) AS read_seconds,
                SUM(listen_seconds) AS listen_seconds,
                SUM(review_count) AS review_count,
                SUM(lookups) AS lookups
         FROM vocab_activity GROUP BY day ORDER BY day`,
      ),
      rawQuery<{ key: string; value: string }>(
        "SELECT key,value FROM vocab_settings",
      ),
      rawQuery<{ before_json: string }>(
        `SELECT before_json FROM vocab_review_events
         WHERE reviewed_at>=? AND reviewed_at<? AND undone_at IS NULL`,
        [day.start, day.end],
      ),
    ]);
    const settings = settingsFromRows(settingRows);
    const reviewedNewToday = todayReviewEvents.filter((event) =>
      reviewEventStartedAsNew(event.before_json)
    ).length;
    const cardsWithCloze = rawCards.flatMap((row) => {
      const { definition_explanation_en: explanationEnglish, ...card } = row;
      if (!hasUsefulEnglishExplanation(card.gloss_en, explanationEnglish)) return [];
      return [{
        ...card,
        cloze_sentence: createContextCloze(
          card.context_sentence,
          card.context_surface || card.headword,
        ),
      }];
    });
    const reviewCards = applyDailyNewLimit(
      cardsWithCloze,
      settings.daily_new_limit,
      reviewedNewToday,
      now,
    );
    return {
      items,
      blocks,
      segments,
      lexemes,
      occurrences,
      reviewCards,
      bookmarks,
      activity,
      settings,
    };
  });
}

type ImportItemProjection = Pick<
  LibraryItem,
  | "id"
  | "kind"
  | "title"
  | "description"
  | "source"
  | "source_url"
  | "author"
  | "published_at"
  | "duration_ms"
  | "audio_url"
  | "created_at"
>;
type ImportRowProjection = Readonly<{
  id: string;
  method: string;
  label: string;
  status: string;
  error: string;
  item_id: string | null;
  created_at: number;
}>;
type BlockProjection = Readonly<{
  id: string;
  item_id: string;
  ordinal: number;
  kind: string;
  text: string;
}>;
type SegmentProjection = Readonly<{
  id: string;
  item_id: string;
  ordinal: number;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker: string | null;
}>;

function importProjection(
  receipt: VocabImportWriteReceipt,
  item: ImportItemProjection,
  content: readonly (BlockProjection | SegmentProjection)[],
  importRow: ImportRowProjection,
) {
  return {
    version: 1,
    receipt: {
      operationId: receipt.operationId,
      kind: receipt.kind,
      itemId: receipt.itemId,
      importId: receipt.importId,
      contentIds: [...receipt.contentIds],
      createdAt: receipt.createdAt,
      publishedAt: receipt.publishedAt,
    },
    item,
    content,
    import: importRow,
  };
}

function expectedArticleProjection(
  article: ParsedArticle,
  method: string,
  receipt: VocabImportWriteReceipt,
) {
  const item: ImportItemProjection = {
    id: receipt.itemId,
    kind: "article",
    title: article.title,
    description: article.description,
    source: article.source,
    source_url: article.sourceUrl ?? null,
    author: article.author,
    published_at: receipt.publishedAt,
    duration_ms: 0,
    audio_url: null,
    created_at: receipt.createdAt,
  };
  const content = article.blocks.map<BlockProjection>((block, ordinal) => ({
    id: receipt.contentIds[ordinal] ?? "",
    item_id: receipt.itemId,
    ordinal,
    kind: block.kind,
    text: block.text,
  }));
  return importProjection(receipt, item, content, {
    id: receipt.importId,
    method,
    label: article.title,
    status: "complete",
    error: "",
    item_id: receipt.itemId,
    created_at: receipt.createdAt,
  });
}

function expectedPodcastProjection(
  podcast: ParsedPodcast,
  method: string,
  receipt: VocabImportWriteReceipt,
) {
  const duration = podcast.durationMs || podcast.segments.at(-1)?.end_ms || 0;
  const item: ImportItemProjection = {
    id: receipt.itemId,
    kind: "podcast",
    title: podcast.title,
    description: podcast.description,
    source: podcast.source,
    source_url: podcast.sourceUrl ?? null,
    author: "",
    published_at: receipt.publishedAt,
    duration_ms: duration,
    audio_url: podcast.audioUrl ?? null,
    created_at: receipt.createdAt,
  };
  const content = podcast.segments.map<SegmentProjection>((segment, ordinal) => ({
    id: receipt.contentIds[ordinal] ?? "",
    item_id: receipt.itemId,
    ordinal,
    start_ms: segment.start_ms,
    end_ms: segment.end_ms,
    text: segment.text,
    speaker: segment.speaker ?? null,
  }));
  return importProjection(receipt, item, content, {
    id: receipt.importId,
    method,
    label: podcast.title,
    status: "complete",
    error: "",
    item_id: receipt.itemId,
    created_at: receipt.createdAt,
  });
}

export async function prepareVocabArticleWrite(
  article: ParsedArticle,
  method: string,
): Promise<VocabImportWriteReceipt> {
  const createdAt = Date.now();
  const receipt: VocabImportWriteReceipt = {
    version: 1,
    kind: "article",
    operationId: uid("operation"),
    itemId: uid("article"),
    importId: uid("import"),
    contentIds: article.blocks.map(() => uid("block")),
    createdAt,
    publishedAt: localDayKey(createdAt),
    projectionSha256: "",
  };
  return {
    ...receipt,
    projectionSha256: await projectionSha256(
      expectedArticleProjection(article, method, receipt),
    ),
  };
}

export async function prepareVocabPodcastWrite(
  podcast: ParsedPodcast,
  method: string,
): Promise<VocabImportWriteReceipt> {
  const createdAt = Date.now();
  const receipt: VocabImportWriteReceipt = {
    version: 1,
    kind: "podcast",
    operationId: uid("operation"),
    itemId: uid("podcast"),
    importId: uid("import"),
    contentIds: podcast.segments.map(() => uid("segment")),
    createdAt,
    publishedAt: localDayKey(createdAt),
    projectionSha256: "",
  };
  return {
    ...receipt,
    projectionSha256: await projectionSha256(
      expectedPodcastProjection(podcast, method, receipt),
    ),
  };
}

type ImportInspectionResult = Readonly<{ status: VocabWriteInspection }>;

async function inspectImportWriteUnlocked(
  receipt: VocabImportWriteReceipt,
): Promise<ImportInspectionResult> {
  if (!isVocabImportWriteReceipt(receipt)) return { status: "conflict" };
  try {
    const contentTable = receipt.kind === "article"
      ? "vocab_blocks"
      : "vocab_transcript_segments";
    const otherContentTable = receipt.kind === "article"
      ? "vocab_transcript_segments"
      : "vocab_blocks";
    const contentColumns = receipt.kind === "article"
      ? "id,item_id,ordinal,kind,text"
      : "id,item_id,ordinal,start_ms,end_ms,text,speaker";
    const [items, imports, content, otherContent, ownedContent] = await Promise.all([
      rawQuery<ImportItemProjection>(
        `SELECT id,kind,title,description,source,source_url,author,published_at,
                duration_ms,audio_url,created_at
         FROM vocab_items WHERE id=?`,
        [receipt.itemId],
      ),
      rawQuery<ImportRowProjection>(
        `SELECT id,method,label,status,error,item_id,created_at
         FROM vocab_imports WHERE id=?`,
        [receipt.importId],
      ),
      rawQuery<BlockProjection | SegmentProjection>(
        `SELECT ${contentColumns} FROM ${contentTable}
         WHERE item_id=? ORDER BY ordinal,id`,
        [receipt.itemId],
      ),
      rawQuery<{ id: string }>(
        `SELECT id FROM ${otherContentTable} WHERE item_id=? LIMIT 1`,
        [receipt.itemId],
      ),
      receipt.contentIds.length === 0
        ? Promise.resolve([] as Array<{ id: string }>)
        : rawQuery<{ id: string }>(
          `SELECT id FROM ${contentTable}
           WHERE id IN (${placeholders(receipt.contentIds)})`,
          [...receipt.contentIds],
        ),
    ]);
    if (
      items.length === 0 &&
      imports.length === 0 &&
      content.length === 0 &&
      otherContent.length === 0 &&
      ownedContent.length === 0
    ) return { status: "absent" };
    if (
      items.length !== 1 ||
      imports.length !== 1 ||
      content.length !== receipt.contentIds.length ||
      ownedContent.length !== receipt.contentIds.length ||
      otherContent.length !== 0
    ) return { status: "conflict" };
    const digest = await projectionSha256(
      importProjection(receipt, items[0], content, imports[0]),
    );
    return {
      status: digest === receipt.projectionSha256 ? "exact_saved" : "conflict",
    };
  } catch {
    return { status: "unknown" };
  }
}

export async function inspectVocabImportWrite(
  receipt: VocabImportWriteReceipt,
): Promise<VocabWriteInspection> {
  if (!isVocabImportWriteReceipt(receipt)) return "conflict";
  try {
    return (await withVocabReadLock(() => inspectImportWriteUnlocked(receipt))).status;
  } catch {
    return "unknown";
  }
}

async function assertImportReceiptMatches(
  receipt: VocabImportWriteReceipt,
  kind: VocabImportWriteReceipt["kind"],
  expected: unknown,
): Promise<void> {
  if (
    !isVocabImportWriteReceipt(receipt) ||
    receipt.kind !== kind ||
    await projectionSha256(expected) !== receipt.projectionSha256
  ) {
    throw new VocabWriteConflictError(
      "写入回执与这份内容不一致，已停止以避免覆盖其他资料。",
      receipt,
    );
  }
}

export async function matchesVocabArticleWriteReceipt(
  article: ParsedArticle,
  method: string,
  receipt: VocabImportWriteReceipt,
): Promise<boolean> {
  return isVocabImportWriteReceipt(receipt) &&
    receipt.kind === "article" &&
    await projectionSha256(
      expectedArticleProjection(article, method, receipt),
    ) === receipt.projectionSha256;
}

export async function matchesVocabPodcastWriteReceipt(
  podcast: ParsedPodcast,
  method: string,
  receipt: VocabImportWriteReceipt,
): Promise<boolean> {
  return isVocabImportWriteReceipt(receipt) &&
    receipt.kind === "podcast" &&
    await projectionSha256(
      expectedPodcastProjection(podcast, method, receipt),
    ) === receipt.projectionSha256;
}

function broadcastConfirmedWrite(reason: string): void {
  try {
    broadcastVocabChange(reason);
  } catch {
    // A cross-tab hint is not part of the durable commit acknowledgement.
  }
}

async function commitImportWrite(
  receipt: VocabImportWriteReceipt,
  reason: string,
  statements: readonly Statement[],
): Promise<string> {
  return withVocabWriteLock(async () => {
    const before = await inspectImportWriteUnlocked(receipt);
    if (before.status === "exact_saved") return receipt.itemId;
    if (before.status === "conflict") {
      throw new VocabWriteConflictError(
        "这个写入编号已被不同内容占用，未执行任何写入。",
        receipt,
      );
    }
    if (before.status === "unknown") {
      throw new VocabWriteUncertainError(
        "暂时无法核对本地数据库；请先只读核对，不要重复导入。",
        receipt,
      );
    }

    try {
      await rawBatch(statements);
    } catch (cause) {
      const afterFailure = await inspectImportWriteUnlocked(receipt);
      if (afterFailure.status === "exact_saved") {
        broadcastConfirmedWrite(reason);
        return receipt.itemId;
      }
      if (afterFailure.status === "absent") {
        throw new VocabWriteNotSavedError(
          "已确认内容没有写入本地数据库。",
          receipt,
          cause,
        );
      }
      if (afterFailure.status === "conflict") {
        throw new VocabWriteConflictError(
          "写入结果与原回执不一致，已停止后续操作。",
          receipt,
        );
      }
      throw new VocabWriteUncertainError(
        "数据库没有返回完整回执；请先只读核对，不要重复导入。",
        receipt,
        cause,
      );
    }

    const after = await inspectImportWriteUnlocked(receipt);
    if (after.status === "exact_saved") {
      broadcastConfirmedWrite(reason);
      return receipt.itemId;
    }
    if (after.status === "absent") {
      throw new VocabWriteNotSavedError(
        "数据库未能确认刚才的写入。",
        receipt,
      );
    }
    if (after.status === "conflict") {
      throw new VocabWriteConflictError(
        "数据库中的结果与原回执不一致，已停止后续操作。",
        receipt,
      );
    }
    throw new VocabWriteUncertainError(
      "写入后暂时无法读取数据库；请先只读核对，不要重复导入。",
      receipt,
    );
  });
}

export async function saveArticle(
  article: ParsedArticle,
  method: string,
  suppliedReceipt?: VocabImportWriteReceipt,
): Promise<string> {
  const receipt = suppliedReceipt ?? await prepareVocabArticleWrite(article, method);
  await assertImportReceiptMatches(
    receipt,
    "article",
    expectedArticleProjection(article, method, receipt),
  );
  const statements: Statement[] = [
    {
      sql: `INSERT INTO vocab_items(
        id,kind,title,description,source,source_url,author,published_at,
        duration_ms,audio_url,status,progress,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        receipt.itemId, "article", article.title, article.description,
        article.source, article.sourceUrl ?? null, article.author,
        receipt.publishedAt, 0, null, "unread", 0, receipt.createdAt,
        receipt.createdAt,
      ],
    },
    ...article.blocks.map((block, ordinal) => ({
      sql: `INSERT INTO vocab_blocks(id,item_id,ordinal,kind,text)
            VALUES (?,?,?,?,?)`,
      params: [
        receipt.contentIds[ordinal], receipt.itemId, ordinal, block.kind,
        block.text,
      ],
    })),
    {
      sql: `INSERT INTO vocab_imports(
        id,method,label,status,error,item_id,created_at
      ) VALUES (?,?,?,?,?,?,?)`,
      params: [
        receipt.importId, method, article.title, "complete", "",
        receipt.itemId, receipt.createdAt,
      ],
    },
  ];
  return commitImportWrite(receipt, "article-saved", statements);
}

export async function savePodcast(
  podcast: ParsedPodcast,
  method: string,
  suppliedReceipt?: VocabImportWriteReceipt,
): Promise<string> {
  const receipt = suppliedReceipt ?? await prepareVocabPodcastWrite(podcast, method);
  await assertImportReceiptMatches(
    receipt,
    "podcast",
    expectedPodcastProjection(podcast, method, receipt),
  );
  const duration = podcast.durationMs || podcast.segments.at(-1)?.end_ms || 0;
  const statements: Statement[] = [
    {
      sql: `INSERT INTO vocab_items(
        id,kind,title,description,source,source_url,author,published_at,
        duration_ms,audio_url,status,progress,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        receipt.itemId, "podcast", podcast.title, podcast.description,
        podcast.source, podcast.sourceUrl ?? null, "", receipt.publishedAt,
        duration, podcast.audioUrl ?? null, "unread", 0, receipt.createdAt,
        receipt.createdAt,
      ],
    },
    ...podcast.segments.map((segment, ordinal) => ({
      sql: `INSERT INTO vocab_transcript_segments(
        id,item_id,ordinal,start_ms,end_ms,text,speaker
      ) VALUES (?,?,?,?,?,?,?)`,
      params: [
        receipt.contentIds[ordinal], receipt.itemId, ordinal, segment.start_ms,
        segment.end_ms, segment.text, segment.speaker ?? null,
      ],
    })),
    {
      sql: `INSERT INTO vocab_imports(
        id,method,label,status,error,item_id,created_at
      ) VALUES (?,?,?,?,?,?,?)`,
      params: [
        receipt.importId, method, podcast.title, "complete", "",
        receipt.itemId, receipt.createdAt,
      ],
    },
  ];
  return commitImportWrite(receipt, "podcast-saved", statements);
}

function normalizedSelection(target: SelectionTarget): string {
  return target.surface.normalize("NFC").trim().toLocaleLowerCase("en");
}

function occurrenceProjection(
  receipt: VocabOccurrenceWriteReceipt,
  occurrence: Readonly<{
    id: string;
    normalized_key: string | null;
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
  }>,
  activity: Readonly<{
    id: string;
    day: string;
    read_seconds: number;
    listen_seconds: number;
    review_count: number;
    lookups: number;
    created_at: number;
  }>,
) {
  return {
    version: 1,
    receipt: {
      operationId: receipt.operationId,
      occurrenceId: receipt.occurrenceId,
      activityId: receipt.activityId,
      lexemeId: receipt.lexemeId,
      cardId: receipt.cardId,
      createdAt: receipt.createdAt,
      day: receipt.day,
    },
    occurrence,
    activity,
  };
}

function expectedOccurrenceProjection(
  target: SelectionTarget,
  explanation: AiExplanation | null,
  note: string,
  receipt: VocabOccurrenceWriteReceipt,
) {
  return occurrenceProjection(receipt, {
    id: receipt.occurrenceId,
    normalized_key: normalizedSelection(target),
    item_id: target.itemId,
    block_id: target.blockId ?? null,
    segment_id: target.segmentId ?? null,
    surface: target.surface,
    context_before: target.before,
    context_sentence: target.sentence,
    context_after: target.after,
    start_utf16: target.startUtf16,
    end_utf16: target.endUtf16,
    start_ms: target.startMs ?? null,
    note,
    explanation_json: explanation ? JSON.stringify(explanation) : "",
    created_at: receipt.createdAt,
  }, {
    id: receipt.activityId,
    day: receipt.day,
    read_seconds: 0,
    listen_seconds: 0,
    review_count: 0,
    lookups: 1,
    created_at: receipt.createdAt,
  });
}

export async function prepareVocabOccurrenceWrite(
  target: SelectionTarget,
  explanation: AiExplanation | null,
  note = "",
): Promise<VocabOccurrenceWriteReceipt> {
  const createdAt = Date.now();
  const receipt: VocabOccurrenceWriteReceipt = {
    version: 1,
    kind: "occurrence",
    operationId: uid("operation"),
    occurrenceId: uid("occurrence"),
    activityId: uid("activity"),
    lexemeId: uid("lexeme"),
    cardId: uid("card"),
    createdAt,
    day: localDayKey(createdAt),
    projectionSha256: "",
  };
  return {
    ...receipt,
    projectionSha256: await projectionSha256(
      expectedOccurrenceProjection(target, explanation, note, receipt),
    ),
  };
}

type OccurrenceInspectionResult = Readonly<{
  status: VocabWriteInspection;
  lexemeId?: string;
}>;

async function inspectOccurrenceWriteUnlocked(
  receipt: VocabOccurrenceWriteReceipt,
): Promise<OccurrenceInspectionResult> {
  if (!isVocabOccurrenceWriteReceipt(receipt)) return { status: "conflict" };
  try {
    const [occurrences, activity] = await Promise.all([
      rawQuery<{
        id: string;
        lexeme_id: string;
        normalized_key: string | null;
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
      }>(
        `SELECT o.id,o.lexeme_id,l.normalized_key,o.item_id,o.block_id,
                o.segment_id,o.surface,o.context_before,o.context_sentence,
                o.context_after,o.start_utf16,o.end_utf16,o.start_ms,o.note,
                o.explanation_json,o.created_at
         FROM vocab_occurrences o
         LEFT JOIN vocab_lexemes l ON l.id=o.lexeme_id
         WHERE o.id=?`,
        [receipt.occurrenceId],
      ),
      rawQuery<{
        id: string;
        day: string;
        read_seconds: number;
        listen_seconds: number;
        review_count: number;
        lookups: number;
        created_at: number;
      }>(
        `SELECT id,day,read_seconds,listen_seconds,review_count,lookups,created_at
         FROM vocab_activity WHERE id=?`,
        [receipt.activityId],
      ),
    ]);
    if (occurrences.length === 0 && activity.length === 0) {
      return { status: "absent" };
    }
    if (occurrences.length !== 1 || activity.length !== 1) {
      return { status: "conflict" };
    }
    const row = occurrences[0];
    const digest = await projectionSha256(occurrenceProjection(receipt, {
      id: row.id,
      normalized_key: row.normalized_key,
      item_id: row.item_id,
      block_id: row.block_id,
      segment_id: row.segment_id,
      surface: row.surface,
      context_before: row.context_before,
      context_sentence: row.context_sentence,
      context_after: row.context_after,
      start_utf16: row.start_utf16,
      end_utf16: row.end_utf16,
      start_ms: row.start_ms,
      note: row.note,
      explanation_json: row.explanation_json,
      created_at: row.created_at,
    }, activity[0]));
    return digest === receipt.projectionSha256
      ? { status: "exact_saved", lexemeId: row.lexeme_id }
      : { status: "conflict" };
  } catch {
    return { status: "unknown" };
  }
}

export async function inspectVocabOccurrenceWrite(
  receipt: VocabOccurrenceWriteReceipt,
): Promise<VocabWriteInspection> {
  if (!isVocabOccurrenceWriteReceipt(receipt)) return "conflict";
  try {
    return (await withVocabReadLock(() => inspectOccurrenceWriteUnlocked(receipt))).status;
  } catch {
    return "unknown";
  }
}

export type SaveOccurrenceOptions = Readonly<{
  note?: string;
  receipt?: VocabOccurrenceWriteReceipt;
}>;

export async function saveOccurrence(
  target: SelectionTarget,
  explanation: AiExplanation | null,
  options: SaveOccurrenceOptions = {},
): Promise<{ lexemeId: string; occurrenceId: string }> {
  const note = options.note ?? "";
  const receipt = options.receipt ??
    await prepareVocabOccurrenceWrite(target, explanation, note);
  if (
    !isVocabOccurrenceWriteReceipt(receipt) ||
    await projectionSha256(
      expectedOccurrenceProjection(target, explanation, note, receipt),
    ) !== receipt.projectionSha256
  ) {
    throw new VocabWriteConflictError(
      "收词回执与当前语境或笔记不一致，未执行任何写入。",
      receipt,
    );
  }

  return withVocabWriteLock(async () => {
    const before = await inspectOccurrenceWriteUnlocked(receipt);
    if (before.status === "exact_saved" && before.lexemeId) {
      return { lexemeId: before.lexemeId, occurrenceId: receipt.occurrenceId };
    }
    if (before.status === "conflict") {
      throw new VocabWriteConflictError(
        "这个收词编号已被不同语境占用，未重复计数。",
        receipt,
      );
    }
    if (before.status === "unknown") {
      throw new VocabWriteUncertainError(
        "暂时无法核对这次收词；请先只读核对，不要重复保存。",
        receipt,
      );
    }

    const now = receipt.createdAt;
    const normalized = normalizedSelection(target);
    const existing = await rawQuery<{
      id: string;
      status: Lexeme["status"];
      gloss_en: string;
      explanation_en: string;
      card_id: string | null;
      card_state: ReviewCard["state"] | null;
      card_suspended_from_state: ReviewCard["suspended_from_state"];
      card_suspended_reason: string | null;
      card_updated_at: number | null;
    }>(
      `SELECT l.id,l.status,l.gloss_en,l.explanation_en,
              c.id AS card_id,c.state AS card_state,
              c.suspended_from_state AS card_suspended_from_state,
              c.suspended_reason AS card_suspended_reason,
              c.updated_at AS card_updated_at
       FROM vocab_lexemes l
       LEFT JOIN vocab_review_cards c ON c.lexeme_id=l.id
       WHERE l.normalized_key=?`,
      [normalized],
    );
    const lexemeId = existing[0]?.id ?? receipt.lexemeId;
    const canonical = explanation?.target?.canonical?.trim() || target.surface;
    const pronunciation = explanation?.target?.pronunciation ||
      explanation?.target?.ipa ||
      "";
    const rawGloss = explanation?.sense?.glosses_en?.join("; ") ||
      explanation?.sense?.meaning_in_context_en ||
      "";
    const rawEnglish = explanation?.sense?.explanation_en ||
      explanation?.sense?.meaning_in_context_en ||
      "";
    const gloss = rawGloss || rawEnglish;
    const english = rawEnglish || rawGloss;
    const chinese = explanation?.sense?.explanation_zh || "";
    const hasExplanation = hasUsefulEnglishExplanation(
      gloss,
      english,
      existing[0]?.gloss_en ?? "",
      existing[0]?.explanation_en ?? "",
    );
    const statements: Statement[] = [];
    if (existing[0]) {
      statements.push({
        sql: `UPDATE vocab_lexemes
          SET headword=?,
              pronunciation=CASE WHEN ?!='' THEN ? ELSE pronunciation END,
              gloss_en=CASE WHEN ?!='' THEN ? ELSE gloss_en END,
              explanation_en=CASE WHEN ?!='' THEN ? ELSE explanation_en END,
              explanation_zh=CASE WHEN ?!='' THEN ? ELSE explanation_zh END,
              lookup_count=lookup_count+1, updated_at=?
          WHERE id=?`,
        params: [
          canonical, pronunciation, pronunciation, gloss, gloss, english,
          english, chinese, chinese, now, lexemeId,
        ],
      });
    } else {
      statements.push({
        sql: `INSERT INTO vocab_lexemes(
          id,headword,normalized_key,pronunciation,gloss_en,explanation_en,
          explanation_zh,status,starred,notes,lookup_count,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          lexemeId, canonical, normalized, pronunciation, gloss, english,
          chinese, "saved", 0, "", 1, now, now,
        ],
      });
    }
    const existingLexeme = existing[0];
    if (existingLexeme?.card_id && existingLexeme.card_state) {
      const cardUpdate = reviewSuspensionUpdateStatement({
        id: existingLexeme.card_id,
        state: existingLexeme.card_state,
        suspended_from_state: existingLexeme.card_suspended_from_state,
        suspended_reason: existingLexeme.card_suspended_reason,
        updated_at: existingLexeme.card_updated_at ?? 0,
      }, existingLexeme.status, hasExplanation, now);
      if (cardUpdate) statements.push(cardUpdate);
    } else {
      statements.push(newReviewCardStatement(
        lexemeId,
        existingLexeme?.status ?? "saved",
        hasExplanation,
        now,
        receipt.cardId,
      ));
    }
    statements.push({
      sql: `INSERT INTO vocab_occurrences(
        id,lexeme_id,item_id,block_id,segment_id,surface,context_before,
        context_sentence,context_after,start_utf16,end_utf16,start_ms,note,
        explanation_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        receipt.occurrenceId, lexemeId, target.itemId, target.blockId ?? null,
        target.segmentId ?? null, target.surface, target.before,
        target.sentence, target.after, target.startUtf16, target.endUtf16,
        target.startMs ?? null, note,
        explanation ? JSON.stringify(explanation) : "", now,
      ],
    });
    statements.push({
      sql: `INSERT INTO vocab_activity(
        id,day,read_seconds,listen_seconds,review_count,lookups,created_at
      ) VALUES (?,?,?,?,?,?,?)`,
      params: [receipt.activityId, receipt.day, 0, 0, 0, 1, now],
    });

    try {
      await rawBatch(statements);
    } catch (cause) {
      const afterFailure = await inspectOccurrenceWriteUnlocked(receipt);
      if (afterFailure.status === "exact_saved" && afterFailure.lexemeId) {
        broadcastConfirmedWrite("occurrence-saved");
        return {
          lexemeId: afterFailure.lexemeId,
          occurrenceId: receipt.occurrenceId,
        };
      }
      if (afterFailure.status === "absent") {
        throw new VocabWriteNotSavedError(
          "已确认这次收词没有写入，也没有增加查询次数。",
          receipt,
          cause,
        );
      }
      if (afterFailure.status === "conflict") {
        throw new VocabWriteConflictError(
          "收词结果与原回执不一致，已停止后续操作。",
          receipt,
        );
      }
      throw new VocabWriteUncertainError(
        "收词后没有收到完整回执；请先只读核对，不要重复保存。",
        receipt,
        cause,
      );
    }

    const after = await inspectOccurrenceWriteUnlocked(receipt);
    if (after.status === "exact_saved" && after.lexemeId) {
      broadcastConfirmedWrite("occurrence-saved");
      return { lexemeId: after.lexemeId, occurrenceId: receipt.occurrenceId };
    }
    if (after.status === "absent") {
      throw new VocabWriteNotSavedError(
        "数据库未能确认这次收词，也没有增加查询次数。",
        receipt,
      );
    }
    if (after.status === "conflict") {
      throw new VocabWriteConflictError(
        "收词结果与原回执不一致，已停止后续操作。",
        receipt,
      );
    }
    throw new VocabWriteUncertainError(
      "收词后暂时无法读取数据库；请先只读核对，不要重复保存。",
      receipt,
    );
  });
}

export async function saveLexemeNote(
  lexemeId: string,
  note: string,
): Promise<void> {
  await withWrite("lexeme-note-saved", async () => {
    await rawRun(
      "UPDATE vocab_lexemes SET notes=?, updated_at=? WHERE id=?",
      [note, Date.now(), lexemeId],
    );
  });
}

export async function saveOccurrenceNote(
  occurrenceId: string,
  note: string,
): Promise<void> {
  await withWrite("occurrence-note-saved", async () => {
    await rawRun(
      "UPDATE vocab_occurrences SET note=? WHERE id=?",
      [note, occurrenceId],
    );
  });
}

export async function updateLexemeStatus(
  lexemeId: string,
  status: Lexeme["status"],
): Promise<void> {
  await withWrite("lexeme-status-changed", async () => {
    const now = Date.now();
    const row = (await rawQuery<{
      gloss_en: string;
      explanation_en: string;
      card_id: string | null;
      card_state: ReviewCard["state"] | null;
      card_suspended_from_state: ReviewCard["suspended_from_state"];
      card_suspended_reason: string | null;
      card_updated_at: number | null;
    }>(
      `SELECT l.gloss_en,l.explanation_en,c.id AS card_id,c.state AS card_state,
              c.suspended_from_state AS card_suspended_from_state,
              c.suspended_reason AS card_suspended_reason,
              c.updated_at AS card_updated_at
       FROM vocab_lexemes l LEFT JOIN vocab_review_cards c ON c.lexeme_id=l.id
       WHERE l.id=?`,
      [lexemeId],
    ))[0];
    const statements: Statement[] = [
      {
        sql: "UPDATE vocab_lexemes SET status=?, updated_at=? WHERE id=?",
        params: [status, now, lexemeId],
      },
    ];
    if (row?.card_id && row.card_state) {
      const cardUpdate = reviewSuspensionUpdateStatement({
        id: row.card_id,
        state: row.card_state,
        suspended_from_state: row.card_suspended_from_state,
        suspended_reason: row.card_suspended_reason,
        updated_at: row.card_updated_at ?? 0,
      }, status, hasUsefulEnglishExplanation(row.gloss_en, row.explanation_en), now);
      if (cardUpdate) statements.push(cardUpdate);
    } else if (row) {
      statements.push(newReviewCardStatement(
        lexemeId,
        status,
        hasUsefulEnglishExplanation(row.gloss_en, row.explanation_en),
        now,
      ));
    }
    await rawBatch(statements);
  });
}

export async function toggleLexemeStar(
  lexemeId: string,
  starred: boolean,
): Promise<void> {
  await withWrite("lexeme-star-changed", async () => {
    await rawRun(
      "UPDATE vocab_lexemes SET starred=?, updated_at=? WHERE id=?",
      [starred ? 1 : 0, Date.now(), lexemeId],
    );
  });
}

export async function createBookmark(
  itemId: string,
  locator: string,
  label: string,
): Promise<void> {
  await withWrite("bookmark-created", async () => {
    await rawRun(
      `INSERT INTO vocab_bookmarks(
        id,item_id,locator,label,note,created_at
      ) SELECT ?,?,?,?,?,?
        WHERE NOT EXISTS (
          SELECT 1 FROM vocab_bookmarks WHERE item_id=? AND locator=?
        )`,
      [uid("bookmark"), itemId, locator, label, "", Date.now(), itemId, locator],
    );
  });
}

export async function updateItemProgress(
  itemId: string,
  progress: number,
  complete = false,
): Promise<void> {
  await withWrite("item-progress-changed", async () => {
    const bounded = Math.max(0, Math.min(1, progress));
    await rawRun(
      "UPDATE vocab_items SET progress=?, status=?, updated_at=? WHERE id=?",
      [
        bounded,
        complete ? "complete" : bounded > 0 ? "in_progress" : "unread",
        Date.now(),
        itemId,
      ],
    );
  });
}

export async function updateItemStatus(
  itemId: string,
  status: LibraryItem["status"],
): Promise<void> {
  await withWrite("item-status-changed", async () => {
    await rawRun(
      "UPDATE vocab_items SET status=?, updated_at=? WHERE id=?",
      [status, Date.now(), itemId],
    );
  });
}

const REVIEW_STATES: readonly ReviewCard["state"][] = [
  "new",
  "learning",
  "review",
  "relearning",
  "suspended",
];
const REVIEW_RATINGS: readonly ReviewRating[] = [
  "again",
  "hard",
  "good",
  "easy",
];
const REVIEW_STATE_KEYS = [
  "state",
  "due_at",
  "interval_days",
  "ease",
  "reps",
  "lapses",
  "last_review_at",
  "algorithm_version",
  "suspended_from_state",
  "suspended_reason",
  "updated_at",
] as const;
const REVIEW_RATING_RECEIPT_KEYS = [
  "version",
  "kind",
  "operationId",
  "eventId",
  "activityId",
  "cardId",
  "rating",
  "reviewedAt",
  "day",
  "before",
  "after",
  "projectionSha256",
] as const;
const REVIEW_UNDO_RECEIPT_KEYS = [
  "version",
  "kind",
  "operationId",
  "eventId",
  "activityId",
  "cardId",
  "rating",
  "reviewedAt",
  "day",
  "before",
  "after",
  "ratingOperationId",
  "undoneAt",
  "projectionSha256",
] as const;
const REVIEW_WRITE_METADATA_KEY = "_review_write";

type ReviewActivityProjection = Readonly<{
  id: string;
  day: string;
  read_seconds: number;
  listen_seconds: number;
  review_count: number;
  lookups: number;
  created_at: number;
}>;

type ReviewEventProjection = Readonly<{
  id: string;
  card_id: string;
  rating: string;
  reviewed_at: number;
  before_json: string;
  after_json: string;
  undone_at: number | null;
  activity_id: string | null;
}>;

type ReviewWriteMetadata = Readonly<{
  version: 1;
  operationId: string;
  eventId: string;
  activityId: string;
  cardId: string;
  day: string;
}>;

function hasExactKeys(
  value: object,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return sameStrings(actual, wanted);
}

function isReviewTimestamp(value: unknown): value is number {
  return isReceiptTimestamp(value) && value <= 8_640_000_000_000_000;
}

function isReviewDueTime(value: unknown): value is number {
  return isFiniteNumber(value) && value <= 8_640_000_000_000_000;
}

function isFiniteNumber(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function isReviewStateProjection(
  value: unknown,
): value is VocabReviewStateProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<VocabReviewStateProjection>;
  return hasExactKeys(value, REVIEW_STATE_KEYS) &&
    typeof state.state === "string" &&
    REVIEW_STATES.includes(state.state as ReviewCard["state"]) &&
    isReviewDueTime(state.due_at) &&
    isFiniteNumber(state.interval_days) &&
    isFiniteNumber(state.ease, 1) &&
    Number.isSafeInteger(state.reps) && Number(state.reps) >= 0 &&
    Number.isSafeInteger(state.lapses) && Number(state.lapses) >= 0 &&
    (state.last_review_at === null || isReviewTimestamp(state.last_review_at)) &&
    Number.isSafeInteger(state.algorithm_version) &&
    Number(state.algorithm_version) >= 1 &&
    (
      state.suspended_from_state === null ||
      REVIEW_STATES.slice(0, -1).includes(
        state.suspended_from_state as ReviewCard["state"],
      )
    ) &&
    (state.suspended_reason === null || typeof state.suspended_reason === "string") &&
    isReviewTimestamp(state.updated_at);
}

function sameReviewState(
  left: VocabReviewStateProjection,
  right: VocabReviewStateProjection,
): boolean {
  return REVIEW_STATE_KEYS.every((key) => left[key] === right[key]);
}

function storedReviewState(card: StoredReviewCard): VocabReviewStateProjection {
  return {
    state: card.state,
    due_at: card.due_at,
    interval_days: card.interval_days,
    ease: card.ease,
    reps: card.reps,
    lapses: card.lapses,
    last_review_at: card.last_review_at,
    algorithm_version: card.algorithm_version,
    suspended_from_state: card.suspended_from_state,
    suspended_reason: card.suspended_reason,
    updated_at: card.updated_at,
  };
}

function scheduledReviewState(
  before: VocabReviewStateProjection,
  rating: ReviewRating,
  reviewedAt: number,
): VocabReviewStateProjection {
  const schedule = scheduleReviewV2(before, rating, reviewedAt);
  return {
    ...schedule,
    suspended_from_state: null,
    suspended_reason: null,
    updated_at: Math.max(reviewedAt, before.updated_at + 1),
  };
}

function isReviewReceiptBase(
  receipt: Partial<VocabReviewReceiptBase>,
): receipt is VocabReviewReceiptBase {
  if (
    receipt.version !== 1 ||
    !isReceiptId(receipt.operationId, "operation") ||
    !isReceiptId(receipt.eventId, "review") ||
    !isReceiptId(receipt.activityId, "activity") ||
    !isSafeOpaqueReviewCardId(receipt.cardId) ||
    typeof receipt.rating !== "string" ||
    !REVIEW_RATINGS.includes(receipt.rating as ReviewRating) ||
    !isReviewTimestamp(receipt.reviewedAt) ||
    typeof receipt.day !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(receipt.day) ||
    !isReviewStateProjection(receipt.before) ||
    !isReviewStateProjection(receipt.after) ||
    receipt.before.state === "suspended" ||
    receipt.after.state === "suspended" ||
    receipt.before.updated_at >= 8_640_000_000_000_000
  ) return false;
  return sameReviewState(
    receipt.after,
    scheduledReviewState(receipt.before, receipt.rating, receipt.reviewedAt),
  );
}

export function isVocabReviewRatingReceipt(
  value: unknown,
): value is VocabReviewRatingReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<VocabReviewRatingReceipt>;
  return hasExactKeys(value, REVIEW_RATING_RECEIPT_KEYS) &&
    receipt.kind === "review-rating" &&
    typeof receipt.projectionSha256 === "string" &&
    RECEIPT_HASH_PATTERN.test(receipt.projectionSha256) &&
    isReviewReceiptBase(receipt);
}

export function isVocabReviewUndoReceipt(
  value: unknown,
): value is VocabReviewUndoReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<VocabReviewUndoReceipt>;
  return hasExactKeys(value, REVIEW_UNDO_RECEIPT_KEYS) &&
    receipt.kind === "review-undo" &&
    (
      receipt.ratingOperationId === null ||
      isReceiptId(receipt.ratingOperationId, "operation")
    ) &&
    isReviewTimestamp(receipt.undoneAt) &&
    isReviewTimestamp(receipt.reviewedAt) &&
    receipt.undoneAt >= receipt.reviewedAt &&
    typeof receipt.projectionSha256 === "string" &&
    RECEIPT_HASH_PATTERN.test(receipt.projectionSha256) &&
    isReviewReceiptBase(receipt);
}

function reviewWriteMetadata(
  receipt: VocabReviewRatingReceipt,
): ReviewWriteMetadata {
  return {
    version: 1,
    operationId: receipt.operationId,
    eventId: receipt.eventId,
    activityId: receipt.activityId,
    cardId: receipt.cardId,
    day: receipt.day,
  };
}

function reviewEventJson(
  state: VocabReviewStateProjection,
  metadata: ReviewWriteMetadata | null,
): string {
  return JSON.stringify(metadata
    ? { ...state, [REVIEW_WRITE_METADATA_KEY]: metadata }
    : state);
}

function parseReviewWriteMetadata(value: string): ReviewWriteMetadata | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const metadata = parsed[REVIEW_WRITE_METADATA_KEY];
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return null;
    }
    const candidate = metadata as Partial<ReviewWriteMetadata>;
    return hasExactKeys(metadata, [
      "version", "operationId", "eventId", "activityId", "cardId", "day",
    ]) &&
        candidate.version === 1 &&
        isReceiptId(candidate.operationId, "operation") &&
        isReceiptId(candidate.eventId, "review") &&
        isReceiptId(candidate.activityId, "activity") &&
        isSafeOpaqueReviewCardId(candidate.cardId) &&
        typeof candidate.day === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(candidate.day)
      ? candidate as ReviewWriteMetadata
      : null;
  } catch {
    return null;
  }
}

function expectedReviewEvent(
  receipt: VocabReviewRatingReceipt,
): ReviewEventProjection {
  const metadata = reviewWriteMetadata(receipt);
  return {
    id: receipt.eventId,
    card_id: receipt.cardId,
    rating: receipt.rating,
    reviewed_at: receipt.reviewedAt,
    before_json: reviewEventJson(receipt.before, metadata),
    after_json: reviewEventJson(receipt.after, metadata),
    undone_at: null,
    activity_id: receipt.activityId,
  };
}

function expectedReviewActivity(
  receipt: VocabReviewReceiptBase,
): ReviewActivityProjection {
  return {
    id: receipt.activityId,
    day: receipt.day,
    read_seconds: 0,
    listen_seconds: 0,
    review_count: 1,
    lookups: 0,
    created_at: receipt.reviewedAt,
  };
}

function ratingProjection(
  receipt: VocabReviewRatingReceipt,
  event = expectedReviewEvent(receipt),
  activity = expectedReviewActivity(receipt),
) {
  return {
    version: 1,
    receipt: {
      operationId: receipt.operationId,
      eventId: receipt.eventId,
      activityId: receipt.activityId,
      cardId: receipt.cardId,
      rating: receipt.rating,
      reviewedAt: receipt.reviewedAt,
      day: receipt.day,
      before: receipt.before,
      after: receipt.after,
    },
    event,
    activity,
  };
}

async function ratingReceiptHasValidProjection(
  receipt: VocabReviewRatingReceipt,
): Promise<boolean> {
  return isVocabReviewRatingReceipt(receipt) &&
    await projectionSha256(ratingProjection(receipt)) === receipt.projectionSha256;
}

export async function prepareVocabReviewRating(
  card: ReviewCard,
  rating: ReviewRating,
): Promise<VocabReviewRatingReceipt> {
  const before = storedReviewState(card);
  if (
    !isSafeOpaqueReviewCardId(card.id) ||
    !isReviewStateProjection(before) ||
    before.state === "suspended" ||
    !REVIEW_RATINGS.includes(rating)
  ) {
    throw new Error("这张复习卡无法生成可验证的评分记录。");
  }
  const reviewedAt = Math.max(Date.now(), before.updated_at + 1);
  const draft: VocabReviewRatingReceipt = {
    version: 1,
    kind: "review-rating",
    operationId: uid("operation"),
    eventId: uid("review"),
    activityId: uid("activity"),
    cardId: card.id,
    rating,
    reviewedAt,
    day: localDayKey(reviewedAt),
    before,
    after: scheduledReviewState(before, rating, reviewedAt),
    projectionSha256: "",
  };
  return {
    ...draft,
    projectionSha256: await projectionSha256(ratingProjection(draft)),
  };
}

const reviewStatePredicate = (alias: string) => `${alias}.state=? AND
  ${alias}.due_at=? AND ${alias}.interval_days=? AND ${alias}.ease=? AND
  ${alias}.reps=? AND ${alias}.lapses=? AND ${alias}.last_review_at IS ? AND
  ${alias}.algorithm_version=? AND ${alias}.suspended_from_state IS ? AND
  ${alias}.suspended_reason IS ? AND ${alias}.updated_at=?`;

function reviewStateParams(state: VocabReviewStateProjection): SqlValue[] {
  return REVIEW_STATE_KEYS.map((key) => state[key]);
}

function exactActivityPredicate(alias: string): string {
  return `${alias}.id=? AND ${alias}.day=? AND ${alias}.read_seconds=? AND
    ${alias}.listen_seconds=? AND ${alias}.review_count=? AND
    ${alias}.lookups=? AND ${alias}.created_at=?`;
}

function activityParams(activity: ReviewActivityProjection): SqlValue[] {
  return [
    activity.id,
    activity.day,
    activity.read_seconds,
    activity.listen_seconds,
    activity.review_count,
    activity.lookups,
    activity.created_at,
  ];
}

function exactEventPredicate(alias: string, includeUndo = true): string {
  return `${alias}.id=? AND ${alias}.card_id=? AND ${alias}.rating=? AND
    ${alias}.reviewed_at=? AND ${alias}.before_json=? AND
    ${alias}.after_json=?${includeUndo ? ` AND ${alias}.undone_at IS ?` : ""} AND
    ${alias}.activity_id IS ?`;
}

function eventParams(
  event: ReviewEventProjection,
  includeUndo = true,
): SqlValue[] {
  return [
    event.id,
    event.card_id,
    event.rating,
    event.reviewed_at,
    event.before_json,
    event.after_json,
    ...(includeUndo ? [event.undone_at] : []),
    event.activity_id,
  ];
}

async function reviewRows(receipt: VocabReviewReceiptBase): Promise<Readonly<{
  events: ReviewEventProjection[];
  activity: ReviewActivityProjection[];
  cards: StoredReviewCard[];
}>> {
  const [events, activity, cards] = await Promise.all([
    rawQuery<ReviewEventProjection>(
      `SELECT id,card_id,rating,reviewed_at,before_json,after_json,
              undone_at,activity_id
       FROM vocab_review_events WHERE id=?`,
      [receipt.eventId],
    ),
    rawQuery<ReviewActivityProjection>(
      `SELECT id,day,read_seconds,listen_seconds,review_count,lookups,created_at
       FROM vocab_activity WHERE id=?`,
      [receipt.activityId],
    ),
    rawQuery<StoredReviewCard>(
      `SELECT id,state,due_at,interval_days,ease,reps,lapses,last_review_at,
              algorithm_version,suspended_from_state,suspended_reason,updated_at
       FROM vocab_review_cards WHERE id=?`,
      [receipt.cardId],
    ),
  ]);
  return { events, activity, cards };
}

async function inspectReviewRatingUnlocked(
  receipt: VocabReviewRatingReceipt,
): Promise<VocabReviewInspection> {
  try {
    if (!await ratingReceiptHasValidProjection(receipt)) return "conflict";
    const { events, activity, cards } = await reviewRows(receipt);
    if (events.length === 0 && activity.length === 0) {
      return cards.length === 1 &&
          sameReviewState(storedReviewState(cards[0]), receipt.before)
        ? "absent"
        : "changed";
    }
    if (events.length !== 1 || activity.length !== 1) {
      if (
        events.length === 1 &&
        activity.length === 0 &&
        events[0].undone_at !== null
      ) {
        const expected = expectedReviewEvent(receipt);
        return sameEventImmutable(events[0], expected) ? "changed" : "conflict";
      }
      return "conflict";
    }
    const digest = await projectionSha256(
      ratingProjection(receipt, events[0], activity[0]),
    );
    return digest === receipt.projectionSha256 ? "exact" : "conflict";
  } catch {
    return "still_unknown";
  }
}

export async function inspectVocabReviewRating(
  receipt: VocabReviewRatingReceipt,
): Promise<VocabReviewInspection> {
  if (!isVocabReviewRatingReceipt(receipt)) return "conflict";
  try {
    return await withVocabReadLock(() => inspectReviewRatingUnlocked(receipt));
  } catch {
    return "still_unknown";
  }
}

function throwReviewCommitStatus(
  status: Exclude<VocabReviewInspection, "exact">,
  receipt: VocabReviewReceipt,
  action: "评分" | "撤销",
  cause?: unknown,
): never {
  if (status === "changed") {
    throw new VocabReviewChangedError(
      `这张复习卡已发生变化，未重复${action}。`,
      receipt,
    );
  }
  if (status === "conflict") {
    throw new VocabReviewConflictError(
      `${action}凭据与数据库中的记录冲突，已停止写入。`,
      receipt,
    );
  }
  if (status === "still_unknown") {
    throw new VocabReviewUncertainError(
      `${action}结果暂时无法确认，请保留恢复凭据后再核对。`,
      receipt,
      cause,
    );
  }
  throw new VocabReviewNotSavedError(
    `${action}没有写入数据库，可以使用同一凭据安全重试。`,
    receipt,
    cause,
  );
}

function broadcastReviewChange(reason: string): void {
  try {
    broadcastVocabChange(reason);
  } catch {
    // The database is already durable; a notification failure must not undo it.
  }
}

function ratingStatements(receipt: VocabReviewRatingReceipt): Statement[] {
  const event = expectedReviewEvent(receipt);
  const activity = expectedReviewActivity(receipt);
  return [
    {
      sql: `INSERT INTO vocab_activity(
              id,day,read_seconds,listen_seconds,review_count,lookups,created_at
            )
            SELECT ?,?,?,?,?,?,?
            WHERE NOT EXISTS (SELECT 1 FROM vocab_activity WHERE id=?)
              AND NOT EXISTS (SELECT 1 FROM vocab_review_events WHERE id=?)
              AND EXISTS (
                SELECT 1 FROM vocab_review_cards c
                WHERE c.id=? AND ${reviewStatePredicate("c")}
              )`,
      params: [
        ...activityParams(activity),
        receipt.activityId,
        receipt.eventId,
        receipt.cardId,
        ...reviewStateParams(receipt.before),
      ],
    },
    {
      sql: `INSERT INTO vocab_review_events(
              id,card_id,rating,reviewed_at,before_json,after_json,
              undone_at,activity_id
            )
            SELECT ?,?,?,?,?,?,?,?
            WHERE EXISTS (
              SELECT 1 FROM vocab_review_cards c
              WHERE c.id=? AND ${reviewStatePredicate("c")}
            ) AND EXISTS (
              SELECT 1 FROM vocab_activity a
              WHERE ${exactActivityPredicate("a")}
            )`,
      params: [
        ...eventParams(event),
        receipt.cardId,
        ...reviewStateParams(receipt.before),
        ...activityParams(activity),
      ],
    },
    {
      sql: `UPDATE vocab_review_cards
            SET state=?,due_at=?,interval_days=?,ease=?,reps=?,lapses=?,
                last_review_at=?,algorithm_version=?,suspended_from_state=?,
                suspended_reason=?,updated_at=?
            WHERE id=? AND ${reviewStatePredicate("vocab_review_cards")}
              AND EXISTS (
                SELECT 1 FROM vocab_review_events e
                WHERE ${exactEventPredicate("e")}
              )
              AND EXISTS (
                SELECT 1 FROM vocab_activity a
                WHERE ${exactActivityPredicate("a")}
              )`,
      params: [
        ...reviewStateParams(receipt.after),
        receipt.cardId,
        ...reviewStateParams(receipt.before),
        ...eventParams(event),
        ...activityParams(activity),
      ],
    },
    {
      sql: `INSERT INTO vocab_review_events(
              id,card_id,rating,reviewed_at,before_json,after_json,
              undone_at,activity_id
            )
            SELECT ?,NULL,'again',0,'','',NULL,NULL
            WHERE NOT EXISTS (
              SELECT 1
              FROM vocab_review_cards c
              JOIN vocab_review_events e ON e.id=?
              JOIN vocab_activity a ON a.id=?
              WHERE c.id=? AND ${reviewStatePredicate("c")}
                AND ${exactEventPredicate("e")}
                AND ${exactActivityPredicate("a")}
            )`,
      params: [
        receipt.eventId,
        receipt.eventId,
        receipt.activityId,
        receipt.cardId,
        ...reviewStateParams(receipt.after),
        ...eventParams(event),
        ...activityParams(activity),
      ],
    },
  ];
}

export async function commitVocabReviewRating(
  receipt: VocabReviewRatingReceipt,
): Promise<VocabReviewCommitResult<VocabReviewRatingReceipt>> {
  if (!isVocabReviewRatingReceipt(receipt)) {
    throw new VocabReviewConflictError("评分凭据格式无效。", receipt);
  }
  return withVocabWriteLock(async () => {
    let initial: VocabReviewInspection;
    try {
      initial = await inspectReviewRatingUnlocked(receipt);
    } catch (cause) {
      throw new VocabReviewUncertainError(
        "暂时无法核对评分凭据，请稍后重试。",
        receipt,
        cause,
      );
    }
    if (initial === "exact") {
      return { status: "already", eventId: receipt.eventId, receipt };
    }
    if (initial !== "absent") {
      return throwReviewCommitStatus(initial, receipt, "评分");
    }

    let batchError: unknown;
    try {
      await rawBatch(ratingStatements(receipt));
    } catch (cause) {
      batchError = cause;
    }
    const settled = await inspectReviewRatingUnlocked(receipt);
    if (settled === "exact") {
      broadcastReviewChange("review-rated");
      return { status: "exact", eventId: receipt.eventId, receipt };
    }
    return throwReviewCommitStatus(settled, receipt, "评分", batchError);
  });
}

function parseReviewEventState(value: string): VocabReviewStateProjection {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error("复习撤销记录无法验证。");
  }
  const state = Object.fromEntries(
    REVIEW_STATE_KEYS.map((key) => [key, parsed[key]]),
  );
  if (!isReviewStateProjection(state)) {
    throw new Error("复习记录里的卡片状态无法严格验证。");
  }
  return state;
}

function metadataForUndoReceipt(
  receipt: VocabReviewUndoReceipt,
): ReviewWriteMetadata | null {
  return receipt.ratingOperationId === null ? null : {
    version: 1,
    operationId: receipt.ratingOperationId,
    eventId: receipt.eventId,
    activityId: receipt.activityId,
    cardId: receipt.cardId,
    day: receipt.day,
  };
}

function expectedUndoOriginalEvent(
  receipt: VocabReviewUndoReceipt,
): ReviewEventProjection {
  const metadata = metadataForUndoReceipt(receipt);
  return {
    id: receipt.eventId,
    card_id: receipt.cardId,
    rating: receipt.rating,
    reviewed_at: receipt.reviewedAt,
    before_json: reviewEventJson(receipt.before, metadata),
    after_json: reviewEventJson(receipt.after, metadata),
    undone_at: null,
    activity_id: receipt.activityId,
  };
}

function expectedUndoFinalEvent(
  receipt: VocabReviewUndoReceipt,
): ReviewEventProjection {
  return {
    ...expectedUndoOriginalEvent(receipt),
    undone_at: receipt.undoneAt,
    activity_id: null,
  };
}

function undoProjection(receipt: VocabReviewUndoReceipt) {
  return {
    version: 1,
    receipt: {
      operationId: receipt.operationId,
      eventId: receipt.eventId,
      activityId: receipt.activityId,
      cardId: receipt.cardId,
      rating: receipt.rating,
      reviewedAt: receipt.reviewedAt,
      day: receipt.day,
      before: receipt.before,
      after: receipt.after,
      ratingOperationId: receipt.ratingOperationId,
      undoneAt: receipt.undoneAt,
    },
    originalEvent: expectedUndoOriginalEvent(receipt),
    finalEvent: expectedUndoFinalEvent(receipt),
    removedActivity: expectedReviewActivity(receipt),
  };
}

async function undoReceiptHasValidProjection(
  receipt: VocabReviewUndoReceipt,
): Promise<boolean> {
  return isVocabReviewUndoReceipt(receipt) &&
    await projectionSha256(undoProjection(receipt)) === receipt.projectionSha256;
}

function sameReviewWriteMetadata(
  left: ReviewWriteMetadata,
  right: ReviewWriteMetadata,
): boolean {
  return left.version === right.version &&
    left.operationId === right.operationId &&
    left.eventId === right.eventId &&
    left.activityId === right.activityId &&
    left.cardId === right.cardId &&
    left.day === right.day;
}

function sameActivity(
  left: ReviewActivityProjection,
  right: ReviewActivityProjection,
): boolean {
  return left.id === right.id &&
    left.day === right.day &&
    left.read_seconds === right.read_seconds &&
    left.listen_seconds === right.listen_seconds &&
    left.review_count === right.review_count &&
    left.lookups === right.lookups &&
    left.created_at === right.created_at;
}

function sameEventImmutable(
  left: ReviewEventProjection,
  right: ReviewEventProjection,
): boolean {
  return left.id === right.id &&
    left.card_id === right.card_id &&
    left.rating === right.rating &&
    left.reviewed_at === right.reviewed_at &&
    left.before_json === right.before_json &&
    left.after_json === right.after_json;
}

async function hasLaterActiveReview(eventId: string): Promise<boolean> {
  const rows = await rawQuery<{ has_later: number }>(
    `SELECT EXISTS(
       SELECT 1
       FROM vocab_review_events current
       JOIN vocab_review_events later ON later.card_id=current.card_id
       WHERE current.id=? AND later.undone_at IS NULL
         AND (
           later.reviewed_at>current.reviewed_at OR
           (later.reviewed_at=current.reviewed_at AND later.rowid>current.rowid)
         )
     ) AS has_later`,
    [eventId],
  );
  return Number(rows[0]?.has_later ?? 0) === 1;
}

export async function prepareVocabReviewUndo(
  eventId: string,
): Promise<VocabReviewUndoReceipt> {
  return withVocabReadLock(async () => {
    if (!isReceiptId(eventId, "review")) {
      throw new Error("复习事件编号无法验证。");
    }
    const events = await rawQuery<ReviewEventProjection>(
      `SELECT id,card_id,rating,reviewed_at,before_json,after_json,
              undone_at,activity_id
       FROM vocab_review_events WHERE id=?`,
      [eventId],
    );
    if (events.length !== 1) throw new Error("没有找到可核对的复习评分。");
    const event = events[0];
    if (
      !isSafeOpaqueReviewCardId(event.card_id) ||
      typeof event.rating !== "string" ||
      !REVIEW_RATINGS.includes(event.rating as ReviewRating) ||
      !isReviewTimestamp(event.reviewed_at)
    ) throw new Error("复习评分的基础字段无法验证。");

    const before = parseReviewEventState(event.before_json);
    const after = parseReviewEventState(event.after_json);
    const beforeMetadata = parseReviewWriteMetadata(event.before_json);
    const afterMetadata = parseReviewWriteMetadata(event.after_json);
    if (
      (beforeMetadata === null) !== (afterMetadata === null) ||
      (
        beforeMetadata && afterMetadata &&
        !sameReviewWriteMetadata(beforeMetadata, afterMetadata)
      )
    ) throw new Error("复习评分的恢复绑定不完整。");
    const metadata = beforeMetadata;
    if (
      metadata &&
      (
        metadata.eventId !== event.id ||
        metadata.cardId !== event.card_id ||
        (event.activity_id !== null && metadata.activityId !== event.activity_id)
      )
    ) throw new Error("复习评分的恢复绑定与数据库不一致。");

    const activityId = event.activity_id ?? metadata?.activityId;
    if (!activityId || !isReceiptId(activityId, "activity")) {
      throw new Error("旧版撤销记录缺少可恢复的活动编号。");
    }
    const [activity, cards, later] = await Promise.all([
      rawQuery<ReviewActivityProjection>(
        `SELECT id,day,read_seconds,listen_seconds,review_count,lookups,created_at
         FROM vocab_activity WHERE id=?`,
        [activityId],
      ),
      rawQuery<StoredReviewCard>(
        `SELECT id,state,due_at,interval_days,ease,reps,lapses,last_review_at,
                algorithm_version,suspended_from_state,suspended_reason,updated_at
         FROM vocab_review_cards WHERE id=?`,
        [event.card_id],
      ),
      hasLaterActiveReview(event.id),
    ]);
    const day = event.undone_at === null
      ? activity[0]?.day ?? metadata?.day
      : metadata?.day;
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new Error("复习评分缺少原始日期绑定。");
    }
    if (metadata && metadata.day !== day) {
      throw new Error("复习评分的日期绑定与活动记录不一致。");
    }
    const semanticBase: VocabReviewReceiptBase = {
      version: 1,
      operationId: uid("operation"),
      eventId: event.id,
      activityId,
      cardId: event.card_id,
      rating: event.rating as ReviewRating,
      reviewedAt: event.reviewed_at,
      day,
      before,
      after,
    };
    if (!isReviewReceiptBase(semanticBase)) {
      throw new Error("复习评分前后的调度语义无法验证。");
    }

    if (event.undone_at === null) {
      const expectedActivity = expectedReviewActivity(semanticBase);
      if (
        event.activity_id !== activityId ||
        activity.length !== 1 ||
        !sameActivity(activity[0], expectedActivity)
      ) throw new Error("复习活动与评分记录不一致，已停止撤销。");
      if (
        later ||
        cards.length !== 1 ||
        !sameReviewState(storedReviewState(cards[0]), after)
      ) throw new Error("只能撤销这张卡最近一次未被后续改动的评分。");
    } else if (
      !isReviewTimestamp(event.undone_at) ||
      event.activity_id !== null ||
      activity.length !== 0
    ) {
      throw new Error("已撤销评分的数据库事实不完整。");
    }

    const draft: VocabReviewUndoReceipt = {
      ...semanticBase,
      kind: "review-undo",
      ratingOperationId: metadata?.operationId ?? null,
      undoneAt: event.undone_at ?? Math.max(Date.now(), event.reviewed_at),
      projectionSha256: "",
    };
    return {
      ...draft,
      projectionSha256: await projectionSha256(undoProjection(draft)),
    };
  });
}

async function inspectReviewUndoUnlocked(
  receipt: VocabReviewUndoReceipt,
): Promise<VocabReviewInspection> {
  try {
    if (!await undoReceiptHasValidProjection(receipt)) return "conflict";
    const [{ events, activity, cards }, later] = await Promise.all([
      reviewRows(receipt),
      hasLaterActiveReview(receipt.eventId),
    ]);
    if (events.length !== 1) return "conflict";
    const event = events[0];
    const original = expectedUndoOriginalEvent(receipt);
    if (!sameEventImmutable(event, original)) return "conflict";
    if (
      event.undone_at === receipt.undoneAt &&
      event.activity_id === null &&
      activity.length === 0
    ) return "exact";
    if (event.undone_at !== null) return "changed";
    if (event.activity_id !== receipt.activityId) return "conflict";
    if (
      activity.length !== 1 ||
      !sameActivity(activity[0], expectedReviewActivity(receipt))
    ) return "conflict";
    return !later && cards.length === 1 &&
        sameReviewState(storedReviewState(cards[0]), receipt.after)
      ? "absent"
      : "changed";
  } catch {
    return "still_unknown";
  }
}

export async function inspectVocabReviewUndo(
  receipt: VocabReviewUndoReceipt,
): Promise<VocabReviewInspection> {
  if (!isVocabReviewUndoReceipt(receipt)) return "conflict";
  try {
    return await withVocabReadLock(() => inspectReviewUndoUnlocked(receipt));
  } catch {
    return "still_unknown";
  }
}

const laterActiveEventPredicate = (alias: string) => `NOT EXISTS (
  SELECT 1 FROM vocab_review_events later
  WHERE later.card_id=${alias}.card_id AND later.undone_at IS NULL
    AND (
      later.reviewed_at>${alias}.reviewed_at OR
      (later.reviewed_at=${alias}.reviewed_at AND later.rowid>${alias}.rowid)
    )
)`;

function undoStatements(receipt: VocabReviewUndoReceipt): Statement[] {
  const original = expectedUndoOriginalEvent(receipt);
  const final = expectedUndoFinalEvent(receipt);
  const activity = expectedReviewActivity(receipt);
  const eventAfterMark = { ...original, undone_at: receipt.undoneAt };
  return [
    {
      sql: `UPDATE vocab_review_events AS e SET undone_at=?
            WHERE ${exactEventPredicate("e")}
              AND ${laterActiveEventPredicate("e")}
              AND EXISTS (
                SELECT 1 FROM vocab_review_cards c
                WHERE c.id=? AND ${reviewStatePredicate("c")}
              )
              AND EXISTS (
                SELECT 1 FROM vocab_activity a
                WHERE ${exactActivityPredicate("a")}
              )`,
      params: [
        receipt.undoneAt,
        ...eventParams(original),
        receipt.cardId,
        ...reviewStateParams(receipt.after),
        ...activityParams(activity),
      ],
    },
    {
      sql: `UPDATE vocab_review_cards
            SET state=?,due_at=?,interval_days=?,ease=?,reps=?,lapses=?,
                last_review_at=?,algorithm_version=?,suspended_from_state=?,
                suspended_reason=?,updated_at=?
            WHERE id=? AND ${reviewStatePredicate("vocab_review_cards")}
              AND EXISTS (
                SELECT 1 FROM vocab_review_events e
                WHERE ${exactEventPredicate("e")}
              )
              AND EXISTS (
                SELECT 1 FROM vocab_activity a
                WHERE ${exactActivityPredicate("a")}
              )`,
      params: [
        ...reviewStateParams(receipt.before),
        receipt.cardId,
        ...reviewStateParams(receipt.after),
        ...eventParams(eventAfterMark),
        ...activityParams(activity),
      ],
    },
    {
      sql: `DELETE FROM vocab_activity
            WHERE ${exactActivityPredicate("vocab_activity")}
              AND EXISTS (
                SELECT 1 FROM vocab_review_events e
                WHERE ${exactEventPredicate("e")}
              )
              AND EXISTS (
                SELECT 1 FROM vocab_review_cards c
                WHERE c.id=? AND ${reviewStatePredicate("c")}
              )`,
      params: [
        ...activityParams(activity),
        ...eventParams(eventAfterMark),
        receipt.cardId,
        ...reviewStateParams(receipt.before),
      ],
    },
    {
      sql: `INSERT INTO vocab_review_events(
              id,card_id,rating,reviewed_at,before_json,after_json,
              undone_at,activity_id
            )
            SELECT ?,NULL,'again',0,'','',NULL,NULL
            WHERE NOT EXISTS (
              SELECT 1 FROM vocab_review_events e
              JOIN vocab_review_cards c ON c.id=?
              WHERE ${exactEventPredicate("e")}
                AND ${reviewStatePredicate("c")}
                AND NOT EXISTS (
                  SELECT 1 FROM vocab_activity a WHERE a.id=?
                )
            )`,
      params: [
        receipt.eventId,
        receipt.cardId,
        ...eventParams(final),
        ...reviewStateParams(receipt.before),
        receipt.activityId,
      ],
    },
  ];
}

export async function commitVocabReviewUndo(
  receipt: VocabReviewUndoReceipt,
): Promise<VocabReviewCommitResult<VocabReviewUndoReceipt>> {
  if (!isVocabReviewUndoReceipt(receipt)) {
    throw new VocabReviewConflictError("撤销凭据格式无效。", receipt);
  }
  return withVocabWriteLock(async () => {
    const initial = await inspectReviewUndoUnlocked(receipt);
    if (initial === "exact") {
      return { status: "already", eventId: receipt.eventId, receipt };
    }
    if (initial !== "absent") {
      return throwReviewCommitStatus(initial, receipt, "撤销");
    }
    let batchError: unknown;
    try {
      await rawBatch(undoStatements(receipt));
    } catch (cause) {
      batchError = cause;
    }
    const settled = await inspectReviewUndoUnlocked(receipt);
    if (settled === "exact") {
      broadcastReviewChange("review-undone");
      return { status: "exact", eventId: receipt.eventId, receipt };
    }
    return throwReviewCommitStatus(settled, receipt, "撤销", batchError);
  });
}

export async function rateReview(
  card: ReviewCard,
  rating: ReviewRating,
): Promise<string> {
  const receipt = await prepareVocabReviewRating(card, rating);
  return (await commitVocabReviewRating(receipt)).eventId;
}

export async function undoReview(eventId: string): Promise<void> {
  try {
    const receipt = await prepareVocabReviewUndo(eventId);
    await commitVocabReviewUndo(receipt);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "旧版撤销记录缺少可恢复的活动编号。"
    ) {
      const alreadyUndone = await withVocabReadLock(async () => {
        const rows = await rawQuery<{ undone_at: number | null; activity_id: string | null }>(
          "SELECT undone_at,activity_id FROM vocab_review_events WHERE id=?",
          [eventId],
        );
        return rows.length === 1 &&
          rows[0].undone_at !== null &&
          rows[0].activity_id === null;
      });
      if (alreadyUndone) return;
    }
    throw error;
  }
}

const VOCAB_SETTING_KEYS = [
  "chinese_explanation",
  "font_scale",
  "line_height",
  "local_lock",
  "auto_follow",
  "daily_new_limit",
] as const satisfies readonly VocabSettingKey[];
const VOCAB_SETTINGS_MAX_JSON_BYTES = 1_048_576;
const VOCAB_SETTINGS_OPERATION_ID_PATTERN =
  /^vocab-settings-operation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOCAB_SETTINGS_GENERATION_ID_PATTERN =
  /^(?:legacy|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function vocabSettingsError(
  code: VocabSettingsMutationErrorCode,
  message: string,
  receipt?: VocabSettingsWriteReceipt,
): VocabSettingsMutationError {
  return new VocabSettingsMutationError(code, message, receipt);
}

function settingsExactObjectKeys(
  value: object,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function settingsSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function settingsJsonSafe(
  value: unknown,
  seen = new Set<object>(),
): boolean {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    return false;
  }
  seen.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  const safe = values.every((entry) => settingsJsonSafe(entry, seen));
  seen.delete(value);
  return safe;
}

function settingsSnapshotInput(value: unknown): unknown {
  if (!settingsJsonSafe(value)) {
    throw new TypeError("设置写入内容必须是严格 JSON-safe 数据。");
  }
  const json = JSON.stringify(value);
  if (
    typeof json !== "string" ||
    new TextEncoder().encode(json).byteLength > VOCAB_SETTINGS_MAX_JSON_BYTES
  ) {
    throw new TypeError("设置写入内容超过安全大小限制。");
  }
  return JSON.parse(json) as unknown;
}

function settingsCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(settingsCanonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${settingsCanonicalJson(
        (value as Record<string, unknown>)[key],
      )}`
    ).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("设置写入内容不可序列化。");
  return encoded;
}

function sameSettingsProjection(left: unknown, right: unknown): boolean {
  return settingsCanonicalJson(left) === settingsCanonicalJson(right);
}

async function settingsSha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isVocabSettingsObject(value: unknown): value is VocabSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Partial<VocabSettings>;
  return settingsExactObjectKeys(value, VOCAB_SETTING_KEYS) &&
    typeof settings.chinese_explanation === "boolean" &&
    typeof settings.font_scale === "number" &&
    Number.isFinite(settings.font_scale) &&
    settings.font_scale >= 0.88 && settings.font_scale <= 1.25 &&
    typeof settings.line_height === "number" &&
    Number.isFinite(settings.line_height) &&
    settings.line_height >= 1.6 && settings.line_height <= 2.2 &&
    typeof settings.local_lock === "boolean" &&
    typeof settings.auto_follow === "boolean" &&
    Number.isSafeInteger(settings.daily_new_limit) &&
    Number(settings.daily_new_limit) >= 0 && Number(settings.daily_new_limit) <= 30;
}

function canonicalVocabSettingValue(
  settings: VocabSettings,
  key: VocabSettingKey,
): string {
  return String(settings[key]);
}

function canonicalStoredSettingValue(
  key: VocabSettingKey,
  value: unknown,
): boolean {
  if (typeof value !== "string") return false;
  if (
    key === "chinese_explanation" || key === "local_lock" ||
    key === "auto_follow"
  ) return value === "true" || value === "false";
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || String(parsed) !== value) return false;
  if (key === "font_scale") return parsed >= 0.88 && parsed <= 1.25;
  if (key === "line_height") return parsed >= 1.6 && parsed <= 2.2;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 30;
}

function isVocabSettingWriteRow<Key extends VocabSettingKey>(
  value: unknown,
  key: Key,
): value is VocabSettingWriteRow<Key> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<VocabSettingWriteRow>;
  return settingsExactObjectKeys(value, ["key", "value", "updated_at"]) &&
    row.key === key && canonicalStoredSettingValue(key, row.value) &&
    settingsSafeInteger(row.updated_at);
}

function settingsFromWriteRows(rows: VocabSettingsWriteRows): VocabSettings {
  const settings = defaultSettings();
  for (const row of rows) {
    if (!row) continue;
    const value: boolean | number = row.value === "true"
      ? true
      : row.value === "false"
        ? false
        : Number(row.value);
    (settings as unknown as Record<VocabSettingKey, boolean | number>)[row.key] = value;
  }
  return settings;
}

function isVocabSettingsWriteSnapshot(
  value: unknown,
): value is VocabSettingsWriteSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<VocabSettingsWriteSnapshot>;
  if (
    !settingsExactObjectKeys(value, [
      "generationId", "generationSequence", "rows", "settings",
    ]) ||
    typeof snapshot.generationId !== "string" ||
    !VOCAB_SETTINGS_GENERATION_ID_PATTERN.test(snapshot.generationId) ||
    !settingsSafeInteger(snapshot.generationSequence) ||
    !Array.isArray(snapshot.rows) || snapshot.rows.length !== VOCAB_SETTING_KEYS.length ||
    !isVocabSettingsObject(snapshot.settings)
  ) return false;
  for (let index = 0; index < VOCAB_SETTING_KEYS.length; index += 1) {
    const row = snapshot.rows[index];
    if (row !== null && !isVocabSettingWriteRow(row, VOCAB_SETTING_KEYS[index])) {
      return false;
    }
  }
  return sameSettingsProjection(
    snapshot.settings,
    settingsFromWriteRows(snapshot.rows as VocabSettingsWriteRows),
  );
}

function isVocabSettingsSaveTransition(
  before: unknown,
  after: unknown,
): before is VocabSettingsWriteSnapshot {
  if (!isVocabSettingsWriteSnapshot(before) || !isVocabSettingsWriteSnapshot(after)) {
    return false;
  }
  if (
    before.generationId !== after.generationId ||
    before.generationSequence !== after.generationSequence ||
    after.rows.some((row) => row === null)
  ) return false;
  const timestamp = after.rows[0]?.updated_at;
  if (
    !settingsSafeInteger(timestamp) ||
    after.rows.some((row) => row?.updated_at !== timestamp)
  ) return false;
  const latestBefore = before.rows.reduce(
    (latest, row) => row === null ? latest : Math.max(latest, row.updated_at),
    -1,
  );
  return timestamp > latestBefore && after.rows.every((row) =>
    row !== null && row.value === canonicalVocabSettingValue(after.settings, row.key)
  );
}

function isVocabSettingsWriteReceiptUnchecked(
  value: unknown,
): value is VocabSettingsWriteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<VocabSettingsWriteReceipt>;
  return settingsExactObjectKeys(value, [
    "purpose", "version", "kind", "operationId", "generationId",
    "generationSequence", "before", "after", "projectionSha256",
  ]) && receipt.purpose === "vocab-settings-write" && receipt.version === 1 &&
    receipt.kind === "settings-save" &&
    typeof receipt.operationId === "string" &&
    VOCAB_SETTINGS_OPERATION_ID_PATTERN.test(receipt.operationId) &&
    typeof receipt.generationId === "string" &&
    VOCAB_SETTINGS_GENERATION_ID_PATTERN.test(receipt.generationId) &&
    settingsSafeInteger(receipt.generationSequence) &&
    isVocabSettingsSaveTransition(receipt.before, receipt.after) &&
    receipt.generationId === receipt.before.generationId &&
    receipt.generationSequence === receipt.before.generationSequence &&
    typeof receipt.projectionSha256 === "string" &&
    RECEIPT_HASH_PATTERN.test(receipt.projectionSha256) &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      VOCAB_SETTINGS_MAX_JSON_BYTES;
}

export function isVocabSettingsWriteReceipt(
  value: unknown,
): value is VocabSettingsWriteReceipt {
  try {
    return settingsJsonSafe(value) && isVocabSettingsWriteReceiptUnchecked(value);
  } catch {
    return false;
  }
}

async function sealVocabSettingsReceipt(
  draft: Omit<VocabSettingsWriteReceipt, "projectionSha256">,
): Promise<VocabSettingsWriteReceipt> {
  const projectionSha256 = await settingsSha256Hex(settingsCanonicalJson(draft));
  const receipt = { ...draft, projectionSha256 };
  if (!isVocabSettingsWriteReceipt(receipt)) {
    throw vocabSettingsError("invalid_input", "无法生成有效的设置写入回执。");
  }
  return receipt;
}

async function vocabSettingsReceiptHashIsValid(
  receipt: VocabSettingsWriteReceipt,
): Promise<boolean> {
  const { projectionSha256, ...projection } = receipt;
  return projectionSha256 === await settingsSha256Hex(settingsCanonicalJson(projection));
}

function cloneVocabSettingsChecked<Result>(
  value: unknown,
  guard: (candidate: unknown) => candidate is Result,
  label: string,
): Result {
  let snapshot: unknown;
  try {
    snapshot = settingsSnapshotInput(value);
  } catch (error) {
    throw vocabSettingsError(
      "invalid_input",
      error instanceof Error ? error.message : `${label}格式不正确。`,
    );
  }
  if (!guard(snapshot)) {
    throw vocabSettingsError("invalid_input", `${label}格式不正确。`);
  }
  return snapshot;
}

async function readVocabSettingsGeneration(
  runtime: VocabSettingsStorageRuntime,
): Promise<Readonly<{ generationId: string; generationSequence: number }>> {
  const current = await runtime.currentGeneration();
  if (
    !current || typeof current.generationId !== "string" ||
    !VOCAB_SETTINGS_GENERATION_ID_PATTERN.test(current.generationId) ||
    !settingsSafeInteger(current.sequence)
  ) throw new Error("无法确认当前拾词数据库世代。");
  return {
    generationId: current.generationId,
    generationSequence: current.sequence,
  };
}

async function readVocabSettingsWriteSnapshot(
  runtime: VocabSettingsStorageRuntime,
  generation: Readonly<{ generationId: string; generationSequence: number }>,
): Promise<VocabSettingsWriteSnapshot> {
  const stored = (await runtime.query<{
    key: string;
    value: string;
    updated_at: number;
  }>(
    "SELECT key,value,updated_at FROM vocab_settings WHERE key IN (?,?,?,?,?,?)",
    [...VOCAB_SETTING_KEYS],
  )).rows;
  const byKey = new Map<string, unknown>();
  for (const row of stored) {
    if (byKey.has(row.key)) throw new Error("设置表包含重复的 canonical key。");
    byKey.set(row.key, row);
  }
  const rows = VOCAB_SETTING_KEYS.map((key) => {
    const row = byKey.get(key);
    if (row === undefined) return null;
    if (!isVocabSettingWriteRow(row, key)) {
      throw new Error(`设置 ${key} 的存储值不符合 canonical 格式。`);
    }
    return { ...row };
  }) as unknown as VocabSettingsWriteRows;
  const snapshot: VocabSettingsWriteSnapshot = {
    ...generation,
    rows,
    settings: settingsFromWriteRows(rows),
  };
  if (!isVocabSettingsWriteSnapshot(snapshot)) {
    throw new Error("无法构造可信的设置读取快照。");
  }
  return snapshot;
}

function nextVocabSettingsTimestamp(latest: number, now: number): number {
  if (!settingsSafeInteger(now)) {
    throw vocabSettingsError("invalid_input", "设备时间不在可接受范围。");
  }
  const timestamp = Math.max(now, latest + 1);
  if (!settingsSafeInteger(timestamp)) {
    throw vocabSettingsError("invalid_input", "设置版本时间超出可接受范围。");
  }
  return timestamp;
}

function generatedVocabSettingsOperationId(runtime: VocabSettingsStorageRuntime): string {
  const id = `vocab-settings-operation-${runtime.randomUUID()}`;
  if (!VOCAB_SETTINGS_OPERATION_ID_PATTERN.test(id)) {
    throw vocabSettingsError("invalid_input", "无法生成可靠的设置操作标识。");
  }
  return id;
}

function safeVocabSettingsBroadcast(
  runtime: VocabSettingsStorageRuntime,
  reason: string,
): void {
  try {
    runtime.broadcast(reason);
  } catch {
    // A refresh hint is advisory and cannot reverse a durable commit.
  }
}

function withRequiredVocabSettingsWriteLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const locks = typeof navigator === "undefined"
    ? null
    : (navigator as Navigator & { locks?: unknown }).locks ?? null;
  if (!locks) {
    throw new Error(
      "当前浏览器不支持安全的跨标签页写入锁，请使用最新版 Chrome、Edge 或 Safari。",
    );
  }
  return withVocabWriteLock(operation);
}

export function createVocabSettingsStorageService(
  runtime: VocabSettingsStorageRuntime = {
    withReadLock: (operation) => withVocabReadLock(operation),
    withExclusiveLock: withRequiredVocabSettingsWriteLock,
    query: async <Result extends object>(sql: string, params?: SqlValue[]) => ({
      rows: await rawQuery<Result>(sql, params),
    }),
    batch: (statements) => localDb.batch(DB, statements, { transaction: true }),
    currentGeneration: () => localDb.currentGeneration(DB),
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    broadcast: broadcastVocabChange,
  },
) {
  async function readLocked<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await (runtime.withReadLock
        ? runtime.withReadLock(operation)
        : runtime.withExclusiveLock(operation));
    } catch (error) {
      if (error instanceof VocabSettingsMutationError) throw error;
      throw vocabSettingsError("inspect_failed", "暂时无法读取最新设置；没有开始写入。");
    }
  }

  async function prepareLocked<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await runtime.withExclusiveLock(operation);
    } catch (error) {
      if (error instanceof VocabSettingsMutationError) throw error;
      throw vocabSettingsError("inspect_failed", "暂时无法核对最新设置；没有开始写入。");
    }
  }

  async function loadExpectedState(): Promise<VocabSettingsWriteSnapshot> {
    return readLocked(async () => {
      const generation = await readVocabSettingsGeneration(runtime);
      return settingsSnapshotInput(
        await readVocabSettingsWriteSnapshot(runtime, generation),
      ) as VocabSettingsWriteSnapshot;
    });
  }

  async function prepareSave(
    nextValue: VocabSettings,
    expectedValue: VocabSettingsWriteSnapshot,
  ): Promise<VocabSettingsWriteReceipt> {
    const next = cloneVocabSettingsChecked(nextValue, isVocabSettingsObject, "拾词设置");
    const expected = cloneVocabSettingsChecked(
      expectedValue,
      isVocabSettingsWriteSnapshot,
      "拾词设置读取快照",
    );
    return prepareLocked(async () => {
      const generation = await readVocabSettingsGeneration(runtime);
      if (
        expected.generationId !== generation.generationId ||
        expected.generationSequence !== generation.generationSequence
      ) {
        throw vocabSettingsError("changed", "拾词设置所在数据库已经更换；没有准备写入。");
      }
      const current = await readVocabSettingsWriteSnapshot(runtime, generation);
      if (!sameSettingsProjection(current, expected)) {
        throw vocabSettingsError("changed", "拾词设置已在别处变化；没有准备写入。");
      }
      const latest = expected.rows.reduce(
        (value, row) => row === null ? value : Math.max(value, row.updated_at),
        -1,
      );
      const timestamp = nextVocabSettingsTimestamp(latest, runtime.now());
      const rows = VOCAB_SETTING_KEYS.map((key) => ({
        key,
        value: canonicalVocabSettingValue(next, key),
        updated_at: timestamp,
      })) as unknown as VocabSettingsWriteRows;
      const after: VocabSettingsWriteSnapshot = {
        ...generation,
        rows,
        settings: next,
      };
      return sealVocabSettingsReceipt({
        purpose: "vocab-settings-write",
        version: 1,
        kind: "settings-save",
        operationId: generatedVocabSettingsOperationId(runtime),
        ...generation,
        before: expected,
        after,
      });
    });
  }

  async function receiptStateUnlocked(
    receipt: VocabSettingsWriteReceipt,
  ): Promise<Exclude<
    VocabSettingsWriteInspection,
    "still_unknown" | "invalid_receipt"
  >> {
    const generation = await readVocabSettingsGeneration(runtime);
    if (
      generation.generationId !== receipt.generationId ||
      generation.generationSequence !== receipt.generationSequence
    ) return "changed";
    const current = await readVocabSettingsWriteSnapshot(runtime, generation);
    if (sameSettingsProjection(current, receipt.after)) return "exact_saved";
    return sameSettingsProjection(current, receipt.before) ? "expected" : "changed";
  }

  function expectedSetPredicate(rows: VocabSettingsWriteRows): Readonly<{
    sql: string;
    params: SqlValue[];
  }> {
    const present = rows.filter(
      (row): row is VocabSettingWriteRow => row !== null,
    );
    const fragments = [
      `(SELECT COUNT(*) FROM vocab_settings WHERE key IN (?,?,?,?,?,?))=?`,
      ...rows.map((row) => row === null
        ? "NOT EXISTS(SELECT 1 FROM vocab_settings WHERE key=?)"
        : `EXISTS(SELECT 1 FROM vocab_settings
            WHERE key=? AND value=? AND updated_at=?)`),
    ];
    const params: SqlValue[] = [...VOCAB_SETTING_KEYS, present.length];
    rows.forEach((row, index) => {
      if (row === null) params.push(VOCAB_SETTING_KEYS[index]);
      else params.push(row.key, row.value, row.updated_at);
    });
    return { sql: fragments.map((fragment) => `(${fragment})`).join(" AND "), params };
  }

  function receiptStatements(
    receipt: VocabSettingsWriteReceipt,
  ): Statement[] {
    const predicate = expectedSetPredicate(receipt.before.rows);
    const statements: Statement[] = [{
      sql: `INSERT INTO vocab_settings(key,value,updated_at)
        SELECT '__vocab_settings_cas_abort__',NULL,0 WHERE NOT (${predicate.sql})`,
      params: predicate.params,
    }];
    for (const row of receipt.after.rows) {
      if (!row) throw vocabSettingsError("invalid_receipt", "设置回执缺少目标行。", receipt);
      statements.push({
        sql: `INSERT INTO vocab_settings(key,value,updated_at) VALUES(?,?,?)
          ON CONFLICT(key) DO UPDATE SET
            value=excluded.value,updated_at=excluded.updated_at`,
        params: [row.key, row.value, row.updated_at],
      });
    }
    return statements;
  }

  async function inspectWrite(value: unknown): Promise<VocabSettingsWriteInspection> {
    let receipt: VocabSettingsWriteReceipt;
    try {
      const stable = settingsSnapshotInput(value);
      if (!isVocabSettingsWriteReceipt(stable)) return "invalid_receipt";
      receipt = stable;
      if (!await vocabSettingsReceiptHashIsValid(receipt)) return "invalid_receipt";
    } catch {
      return "invalid_receipt";
    }
    try {
      return await runtime.withExclusiveLock(() => receiptStateUnlocked(receipt));
    } catch {
      return "still_unknown";
    }
  }

  async function commitWrite(value: unknown): Promise<VocabSettingsWriteResult> {
    let receipt: VocabSettingsWriteReceipt;
    try {
      const stable = settingsSnapshotInput(value);
      if (!isVocabSettingsWriteReceipt(stable)) {
        throw vocabSettingsError("invalid_receipt", "设置写入回执无效；没有改动资料。");
      }
      receipt = stable;
      if (!await vocabSettingsReceiptHashIsValid(receipt)) {
        throw vocabSettingsError("invalid_receipt", "设置写入回执无法验证；没有改动资料。");
      }
    } catch (error) {
      if (
        error instanceof VocabSettingsMutationError &&
        error.code === "invalid_receipt"
      ) throw error;
      throw vocabSettingsError("invalid_receipt", "设置写入回执无法验证；没有改动资料。");
    }
    const updatedAt = receipt.after.rows[0]!.updated_at;
    try {
      return await runtime.withExclusiveLock(async () => {
        const before = await receiptStateUnlocked(receipt);
        if (before === "exact_saved") {
          safeVocabSettingsBroadcast(runtime, "settings-saved");
          return {
            outcome: "already_saved",
            receipt,
            entityId: "settings",
            updatedAt,
          };
        }
        if (before === "changed") {
          return {
            outcome: "changed",
            receipt,
            entityId: "settings",
            retryable: false,
          };
        }
        try {
          await runtime.batch(receiptStatements(receipt));
        } catch {
          // The transaction may have committed even though its response was lost.
        }
        const after = await receiptStateUnlocked(receipt);
        if (after === "exact_saved") {
          safeVocabSettingsBroadcast(runtime, "settings-saved");
          return { outcome: "saved", receipt, entityId: "settings", updatedAt };
        }
        if (after === "expected") {
          throw vocabSettingsError(
            "write_failed",
            "这次设置确定没有写入；保留原回执后可以重试。",
            receipt,
          );
        }
        return {
          outcome: "changed",
          receipt,
          entityId: "settings",
          retryable: false,
        };
      });
    } catch (error) {
      if (error instanceof VocabSettingsMutationError) throw error;
      return {
        outcome: "outcome_uncertain",
        receipt,
        entityId: "settings",
        retryable: true,
      };
    }
  }

  return {
    loadVocabSettingsExpectedState: loadExpectedState,
    prepareVocabSettingsSave: prepareSave,
    inspectVocabSettingsWrite: inspectWrite,
    commitVocabSettingsWrite: commitWrite,
  } as const;
}

const defaultVocabSettingsStorageService = createVocabSettingsStorageService();

export const loadVocabSettingsExpectedState =
  defaultVocabSettingsStorageService.loadVocabSettingsExpectedState;
export const prepareVocabSettingsSave =
  defaultVocabSettingsStorageService.prepareVocabSettingsSave;
export const inspectVocabSettingsWrite =
  defaultVocabSettingsStorageService.inspectVocabSettingsWrite;
export const commitVocabSettingsWrite =
  defaultVocabSettingsStorageService.commitVocabSettingsWrite;

const VOCAB_ITEM_MAX_JSON_BYTES = 1_048_576;
const VOCAB_ITEM_OPERATION_ID_PATTERN =
  /^vocab-item-operation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOCAB_ITEM_STATUSES: readonly LibraryItem["status"][] = [
  "unread",
  "in_progress",
  "complete",
  "archived",
];
const VOCAB_ITEM_KINDS: readonly VocabItemWriteKind[] = [
  "progress-checkpoint",
  "complete",
  "reopen",
  "archive",
  "restore",
];
const VOCAB_ITEM_ROW_KEYS = [
  "id",
  "kind",
  "title",
  "description",
  "source",
  "source_url",
  "author",
  "published_at",
  "duration_ms",
  "audio_url",
  "status",
  "progress",
  "created_at",
  "updated_at",
] as const;

function vocabItemError(
  code: VocabItemMutationErrorCode,
  message: string,
  receipt?: VocabItemWriteReceipt,
): VocabItemMutationError {
  return new VocabItemMutationError(code, message, receipt);
}

function isVocabItemRow(value: unknown): value is LibraryItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<LibraryItem>;
  return settingsExactObjectKeys(value, VOCAB_ITEM_ROW_KEYS) &&
    isSafeOpaqueReviewCardId(item.id) &&
    (item.kind === "article" || item.kind === "podcast") &&
    typeof item.title === "string" &&
    typeof item.description === "string" &&
    typeof item.source === "string" &&
    (item.source_url === null || typeof item.source_url === "string") &&
    typeof item.author === "string" &&
    typeof item.published_at === "string" &&
    settingsSafeInteger(item.duration_ms) &&
    (item.audio_url === null || typeof item.audio_url === "string") &&
    VOCAB_ITEM_STATUSES.includes(item.status as LibraryItem["status"]) &&
    typeof item.progress === "number" && Number.isFinite(item.progress) &&
    item.progress >= 0 && item.progress <= 1 &&
    settingsSafeInteger(item.created_at) &&
    settingsSafeInteger(item.updated_at);
}

function isVocabItemWriteSnapshot(
  value: unknown,
): value is VocabItemWriteSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<VocabItemWriteSnapshot>;
  return settingsExactObjectKeys(value, [
    "generationId", "generationSequence", "item",
  ]) &&
    typeof snapshot.generationId === "string" &&
    VOCAB_SETTINGS_GENERATION_ID_PATTERN.test(snapshot.generationId) &&
    settingsSafeInteger(snapshot.generationSequence) &&
    isVocabItemRow(snapshot.item);
}

function sameVocabItemImmutableFields(
  before: LibraryItem,
  after: LibraryItem,
): boolean {
  return before.id === after.id && before.kind === after.kind &&
    before.title === after.title && before.description === after.description &&
    before.source === after.source && before.source_url === after.source_url &&
    before.author === after.author && before.published_at === after.published_at &&
    before.duration_ms === after.duration_ms && before.audio_url === after.audio_url &&
    before.created_at === after.created_at;
}

function restoredVocabItemStatus(progress: number): LibraryItem["status"] {
  return progress >= 1 ? "complete" : progress > 0 ? "in_progress" : "unread";
}

function isVocabItemTransition(
  kind: VocabItemWriteKind,
  beforeValue: unknown,
  afterValue: unknown,
): boolean {
  if (
    !isVocabItemWriteSnapshot(beforeValue) ||
    !isVocabItemWriteSnapshot(afterValue)
  ) return false;
  const before = beforeValue;
  const after = afterValue;
  if (
    before.generationId !== after.generationId ||
    before.generationSequence !== after.generationSequence ||
    !sameVocabItemImmutableFields(before.item, after.item) ||
    after.item.updated_at <= before.item.updated_at
  ) return false;
  switch (kind) {
    case "progress-checkpoint":
      return (before.item.status === "unread" || before.item.status === "in_progress") &&
        after.item.progress < 1 &&
        after.item.status === restoredVocabItemStatus(after.item.progress);
    case "complete":
      return before.item.status !== "archived" &&
        after.item.status === "complete" && after.item.progress === 1;
    case "reopen":
      return before.item.status === "complete" &&
        after.item.status === "unread" && after.item.progress === 0;
    case "archive":
      return before.item.status !== "archived" &&
        after.item.status === "archived" &&
        after.item.progress === before.item.progress;
    case "restore":
      return before.item.status === "archived" &&
        after.item.progress === before.item.progress &&
        after.item.status === restoredVocabItemStatus(before.item.progress);
  }
}

function isVocabItemWriteReceiptUnchecked(
  value: unknown,
): value is VocabItemWriteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<VocabItemWriteReceipt>;
  if (
    !settingsExactObjectKeys(value, [
      "purpose", "version", "kind", "operationId", "generationId",
      "generationSequence", "before", "after", "projectionSha256",
    ]) ||
    receipt.purpose !== "vocab-item-write" || receipt.version !== 1 ||
    !VOCAB_ITEM_KINDS.includes(receipt.kind as VocabItemWriteKind) ||
    typeof receipt.operationId !== "string" ||
    !VOCAB_ITEM_OPERATION_ID_PATTERN.test(receipt.operationId) ||
    typeof receipt.generationId !== "string" ||
    !VOCAB_SETTINGS_GENERATION_ID_PATTERN.test(receipt.generationId) ||
    !settingsSafeInteger(receipt.generationSequence) ||
    typeof receipt.projectionSha256 !== "string" ||
    !RECEIPT_HASH_PATTERN.test(receipt.projectionSha256) ||
    !isVocabItemTransition(
      receipt.kind as VocabItemWriteKind,
      receipt.before,
      receipt.after,
    )
  ) return false;
  return receipt.generationId === receipt.before?.generationId &&
    receipt.generationSequence === receipt.before.generationSequence &&
    receipt.generationId === receipt.after?.generationId &&
    receipt.generationSequence === receipt.after.generationSequence &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      VOCAB_ITEM_MAX_JSON_BYTES;
}

export function isVocabItemWriteReceipt(
  value: unknown,
): value is VocabItemWriteReceipt {
  try {
    return settingsJsonSafe(value) && isVocabItemWriteReceiptUnchecked(value);
  } catch {
    return false;
  }
}

async function sealVocabItemReceipt<Receipt extends VocabItemWriteReceipt>(
  draft: Omit<Receipt, "projectionSha256">,
): Promise<Receipt> {
  const projectionSha256 = await settingsSha256Hex(settingsCanonicalJson(draft));
  const receipt = { ...draft, projectionSha256 } as Receipt;
  if (!isVocabItemWriteReceipt(receipt)) {
    throw vocabItemError("invalid_input", "无法生成有效的条目写入回执。");
  }
  return receipt;
}

async function vocabItemReceiptHashIsValid(
  receipt: VocabItemWriteReceipt,
): Promise<boolean> {
  const { projectionSha256, ...projection } = receipt;
  return projectionSha256 ===
    await settingsSha256Hex(settingsCanonicalJson(projection));
}

function cloneVocabItemChecked<Result>(
  value: unknown,
  guard: (candidate: unknown) => candidate is Result,
  label: string,
): Result {
  let snapshot: unknown;
  try {
    snapshot = settingsSnapshotInput(value);
  } catch {
    throw vocabItemError("invalid_input", `${label}必须是安全、有限的 JSON 数据。`);
  }
  if (!guard(snapshot)) {
    throw vocabItemError("invalid_input", `${label}格式不正确。`);
  }
  return snapshot;
}

async function readVocabItemGeneration(
  runtime: VocabItemStorageRuntime,
): Promise<Readonly<{ generationId: string; generationSequence: number }>> {
  const current = await runtime.currentGeneration();
  if (
    !current || typeof current.generationId !== "string" ||
    !VOCAB_SETTINGS_GENERATION_ID_PATTERN.test(current.generationId) ||
    !settingsSafeInteger(current.sequence)
  ) throw new Error("无法确认当前拾词数据库世代。");
  return {
    generationId: current.generationId,
    generationSequence: current.sequence,
  };
}

async function readVocabItemWriteSnapshot(
  runtime: VocabItemStorageRuntime,
  generation: Readonly<{ generationId: string; generationSequence: number }>,
  itemId: string,
): Promise<VocabItemWriteSnapshot | null> {
  const rows = (await runtime.query<LibraryItem>(
    `SELECT id,kind,title,description,source,source_url,author,published_at,
      duration_ms,audio_url,status,progress,created_at,updated_at
      FROM vocab_items WHERE id=? LIMIT 2`,
    [itemId],
  )).rows;
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !isVocabItemRow(rows[0])) {
    throw new Error("条目存储行不符合 canonical 格式。");
  }
  const snapshot: VocabItemWriteSnapshot = {
    ...generation,
    item: { ...rows[0] },
  };
  if (!isVocabItemWriteSnapshot(snapshot)) {
    throw new Error("无法构造可信的条目读取快照。");
  }
  return snapshot;
}

function nextVocabItemTimestamp(latest: number, now: number): number {
  if (!settingsSafeInteger(now)) {
    throw vocabItemError("invalid_input", "设备时间不在可接受范围。");
  }
  const timestamp = Math.max(now, latest + 1);
  if (!settingsSafeInteger(timestamp)) {
    throw vocabItemError("invalid_input", "条目版本时间超出可接受范围。");
  }
  return timestamp;
}

function generatedVocabItemOperationId(runtime: VocabItemStorageRuntime): string {
  const id = `vocab-item-operation-${runtime.randomUUID()}`;
  if (!VOCAB_ITEM_OPERATION_ID_PATTERN.test(id)) {
    throw vocabItemError("invalid_input", "无法生成可靠的条目操作标识。");
  }
  return id;
}

function safeVocabItemBroadcast(
  runtime: VocabItemStorageRuntime,
  reason: string,
): void {
  try {
    runtime.broadcast(reason);
  } catch {
    // A refresh hint is advisory and cannot reverse a durable commit.
  }
}

function withRequiredVocabItemWriteLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const locks = typeof navigator === "undefined"
    ? null
    : (navigator as Navigator & { locks?: unknown }).locks ?? null;
  if (!locks) {
    throw new Error(
      "当前浏览器不支持安全的跨标签页写入锁，请使用最新版 Chrome、Edge 或 Safari。",
    );
  }
  return withVocabWriteLock(operation);
}

function vocabItemBroadcastReason(kind: VocabItemWriteKind): string {
  switch (kind) {
    case "progress-checkpoint": return "item-progress-changed";
    case "complete": return "item-completed";
    case "reopen": return "item-reopened";
    case "archive": return "item-archived";
    case "restore": return "item-restored";
  }
}

export function createVocabItemStorageService(
  runtime: VocabItemStorageRuntime = {
    withReadLock: (operation) => withVocabReadLock(operation),
    withExclusiveLock: withRequiredVocabItemWriteLock,
    query: async <Result extends object>(sql: string, params?: SqlValue[]) => ({
      rows: await rawQuery<Result>(sql, params),
    }),
    batch: (statements) => localDb.batch(DB, statements, { transaction: true }),
    currentGeneration: () => localDb.currentGeneration(DB),
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    broadcast: broadcastVocabChange,
  },
) {
  async function readLocked<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await (runtime.withReadLock
        ? runtime.withReadLock(operation)
        : runtime.withExclusiveLock(operation));
    } catch (error) {
      if (error instanceof VocabItemMutationError) throw error;
      throw vocabItemError("inspect_failed", "暂时无法读取最新条目；没有开始写入。");
    }
  }

  async function prepareLocked<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await runtime.withExclusiveLock(operation);
    } catch (error) {
      if (error instanceof VocabItemMutationError) throw error;
      throw vocabItemError("inspect_failed", "暂时无法核对最新条目；没有开始写入。");
    }
  }

  async function loadExpectedState(itemIdValue: string): Promise<VocabItemWriteSnapshot> {
    const itemId = cloneVocabItemChecked(
      itemIdValue,
      isSafeOpaqueReviewCardId,
      "条目标识",
    );
    return readLocked(async () => {
      const generation = await readVocabItemGeneration(runtime);
      const snapshot = await readVocabItemWriteSnapshot(runtime, generation, itemId);
      if (!snapshot) {
        throw vocabItemError("changed", "这个条目已经不存在；没有开始写入。");
      }
      return settingsSnapshotInput(snapshot) as VocabItemWriteSnapshot;
    });
  }

  async function prepareTransition<Receipt extends VocabItemWriteReceipt>(
    kind: Receipt["kind"],
    expectedValue: VocabItemWriteSnapshot,
    progressValue?: number,
  ): Promise<Receipt> {
    const expected = cloneVocabItemChecked(
      expectedValue,
      isVocabItemWriteSnapshot,
      "条目读取快照",
    );
    const progress = progressValue;
    if (
      kind === "progress-checkpoint" &&
      (typeof progress !== "number" || !Number.isFinite(progress) ||
        progress < 0 || progress >= 1)
    ) {
      throw vocabItemError("invalid_input", "阅读进度必须在 0（含）到 1（不含）之间。");
    }
    if (
      kind === "progress-checkpoint" &&
      expected.item.status !== "unread" && expected.item.status !== "in_progress"
    ) {
      throw vocabItemError("invalid_input", "已完成或已归档的条目不能写入阅读中进度。");
    }
    if (kind === "complete" && expected.item.status === "archived") {
      throw vocabItemError("invalid_input", "请先恢复已归档条目，再标记完成。");
    }
    if (kind === "reopen" && expected.item.status !== "complete") {
      throw vocabItemError("invalid_input", "只能重新开始已完成的条目。");
    }
    if (kind === "archive" && expected.item.status === "archived") {
      throw vocabItemError("invalid_input", "这个条目已经归档。");
    }
    if (kind === "restore" && expected.item.status !== "archived") {
      throw vocabItemError("invalid_input", "只能恢复已归档条目。");
    }
    return prepareLocked(async () => {
      const generation = await readVocabItemGeneration(runtime);
      if (
        expected.generationId !== generation.generationId ||
        expected.generationSequence !== generation.generationSequence
      ) {
        throw vocabItemError("changed", "条目所在数据库已经更换；没有准备写入。");
      }
      const current = await readVocabItemWriteSnapshot(
        runtime,
        generation,
        expected.item.id,
      );
      if (!current || !sameSettingsProjection(current, expected)) {
        throw vocabItemError("changed", "这个条目已在别处变化；没有准备写入。");
      }
      const updatedAt = nextVocabItemTimestamp(expected.item.updated_at, runtime.now());
      let status: LibraryItem["status"];
      let nextProgress: number;
      switch (kind) {
        case "progress-checkpoint":
          nextProgress = progress!;
          status = restoredVocabItemStatus(nextProgress);
          break;
        case "complete":
          nextProgress = 1;
          status = "complete";
          break;
        case "reopen":
          nextProgress = 0;
          status = "unread";
          break;
        case "archive":
          nextProgress = expected.item.progress;
          status = "archived";
          break;
        case "restore":
          nextProgress = expected.item.progress;
          status = restoredVocabItemStatus(nextProgress);
          break;
      }
      const after: VocabItemWriteSnapshot = {
        ...generation,
        item: {
          ...expected.item,
          progress: nextProgress,
          status,
          updated_at: updatedAt,
        },
      };
      return sealVocabItemReceipt<Receipt>({
        purpose: "vocab-item-write",
        version: 1,
        kind,
        operationId: generatedVocabItemOperationId(runtime),
        ...generation,
        before: expected,
        after,
      } as Omit<Receipt, "projectionSha256">);
    });
  }

  async function receiptStateUnlocked(
    receipt: VocabItemWriteReceipt,
  ): Promise<Exclude<
    VocabItemWriteInspection,
    "still_unknown" | "invalid_receipt"
  >> {
    const generation = await readVocabItemGeneration(runtime);
    if (
      generation.generationId !== receipt.generationId ||
      generation.generationSequence !== receipt.generationSequence
    ) return "changed";
    const current = await readVocabItemWriteSnapshot(
      runtime,
      generation,
      receipt.before.item.id,
    );
    if (!current) return "changed";
    if (sameSettingsProjection(current, receipt.after)) return "exact_saved";
    return sameSettingsProjection(current, receipt.before) ? "expected" : "changed";
  }

  function itemRowPredicate(item: LibraryItem): Readonly<{
    sql: string;
    params: SqlValue[];
  }> {
    return {
      sql: `EXISTS(SELECT 1 FROM vocab_items WHERE id IS ? AND kind IS ?
        AND title IS ? AND description IS ? AND source IS ? AND source_url IS ?
        AND author IS ? AND published_at IS ? AND duration_ms IS ?
        AND audio_url IS ? AND status IS ? AND progress IS ?
        AND created_at IS ? AND updated_at IS ?)`,
      params: [
        item.id, item.kind, item.title, item.description, item.source,
        item.source_url, item.author, item.published_at, item.duration_ms,
        item.audio_url, item.status, item.progress, item.created_at, item.updated_at,
      ],
    };
  }

  function receiptStatements(receipt: VocabItemWriteReceipt): Statement[] {
    const predicate = itemRowPredicate(receipt.before.item);
    return [
      {
        sql: `INSERT INTO vocab_items(id,kind,title,created_at,updated_at)
          SELECT '__vocab_item_cas_abort__','article',NULL,0,0
          WHERE NOT (${predicate.sql})`,
        params: predicate.params,
      },
      {
        sql: `UPDATE vocab_items SET progress=?,status=?,updated_at=?
          WHERE id=?`,
        params: [
          receipt.after.item.progress,
          receipt.after.item.status,
          receipt.after.item.updated_at,
          receipt.after.item.id,
        ],
      },
    ];
  }

  async function inspectWrite(value: unknown): Promise<VocabItemWriteInspection> {
    let receipt: VocabItemWriteReceipt;
    try {
      const stable = settingsSnapshotInput(value);
      if (!isVocabItemWriteReceipt(stable)) return "invalid_receipt";
      receipt = stable;
      if (!await vocabItemReceiptHashIsValid(receipt)) return "invalid_receipt";
    } catch {
      return "invalid_receipt";
    }
    try {
      return await runtime.withExclusiveLock(() => receiptStateUnlocked(receipt));
    } catch {
      return "still_unknown";
    }
  }

  async function commitWrite(value: unknown): Promise<VocabItemWriteResult> {
    let receipt: VocabItemWriteReceipt;
    try {
      const stable = settingsSnapshotInput(value);
      if (!isVocabItemWriteReceipt(stable)) {
        throw vocabItemError("invalid_receipt", "条目写入回执无效；没有改动资料。");
      }
      receipt = stable;
      if (!await vocabItemReceiptHashIsValid(receipt)) {
        throw vocabItemError("invalid_receipt", "条目写入回执无法验证；没有改动资料。");
      }
    } catch (error) {
      if (
        error instanceof VocabItemMutationError &&
        error.code === "invalid_receipt"
      ) throw error;
      throw vocabItemError("invalid_receipt", "条目写入回执无法验证；没有改动资料。");
    }
    const entityId = receipt.after.item.id;
    const updatedAt = receipt.after.item.updated_at;
    try {
      return await runtime.withExclusiveLock(async () => {
        const before = await receiptStateUnlocked(receipt);
        if (before === "exact_saved") {
          safeVocabItemBroadcast(runtime, vocabItemBroadcastReason(receipt.kind));
          return { outcome: "already_saved", receipt, entityId, updatedAt };
        }
        if (before === "changed") {
          return { outcome: "changed", receipt, entityId, retryable: false };
        }
        try {
          await runtime.batch(receiptStatements(receipt));
        } catch {
          // The transaction may have committed even though its response was lost.
        }
        const after = await receiptStateUnlocked(receipt);
        if (after === "exact_saved") {
          safeVocabItemBroadcast(runtime, vocabItemBroadcastReason(receipt.kind));
          return { outcome: "saved", receipt, entityId, updatedAt };
        }
        if (after === "expected") {
          throw vocabItemError(
            "write_failed",
            "这次条目修改确定没有写入；保留原回执后可以重试。",
            receipt,
          );
        }
        return { outcome: "changed", receipt, entityId, retryable: false };
      });
    } catch (error) {
      if (error instanceof VocabItemMutationError) throw error;
      return {
        outcome: "outcome_uncertain",
        receipt,
        entityId,
        retryable: true,
      };
    }
  }

  return {
    loadVocabItemExpectedState: loadExpectedState,
    prepareVocabItemProgressCheckpoint: (
      progress: number,
      expected: VocabItemWriteSnapshot,
    ) => prepareTransition<VocabItemProgressCheckpointReceipt>(
      "progress-checkpoint",
      expected,
      progress,
    ),
    prepareVocabItemComplete: (expected: VocabItemWriteSnapshot) =>
      prepareTransition<VocabItemCompleteReceipt>("complete", expected),
    prepareVocabItemReopen: (expected: VocabItemWriteSnapshot) =>
      prepareTransition<VocabItemReopenReceipt>("reopen", expected),
    prepareVocabItemArchive: (expected: VocabItemWriteSnapshot) =>
      prepareTransition<VocabItemArchiveReceipt>("archive", expected),
    prepareVocabItemRestore: (expected: VocabItemWriteSnapshot) =>
      prepareTransition<VocabItemRestoreReceipt>("restore", expected),
    inspectVocabItemWrite: inspectWrite,
    commitVocabItemWrite: commitWrite,
  } as const;
}

const defaultVocabItemStorageService = createVocabItemStorageService();

export const loadVocabItemExpectedState =
  defaultVocabItemStorageService.loadVocabItemExpectedState;
export const prepareVocabItemProgressCheckpoint =
  defaultVocabItemStorageService.prepareVocabItemProgressCheckpoint;
export const prepareVocabItemComplete =
  defaultVocabItemStorageService.prepareVocabItemComplete;
export const prepareVocabItemReopen =
  defaultVocabItemStorageService.prepareVocabItemReopen;
export const prepareVocabItemArchive =
  defaultVocabItemStorageService.prepareVocabItemArchive;
export const prepareVocabItemRestore =
  defaultVocabItemStorageService.prepareVocabItemRestore;
export const inspectVocabItemWrite =
  defaultVocabItemStorageService.inspectVocabItemWrite;
export const commitVocabItemWrite =
  defaultVocabItemStorageService.commitVocabItemWrite;

const VOCAB_LEXEME_MAX_JSON_BYTES = 1_048_576;
const VOCAB_LEXEME_OPERATION_ID_PATTERN =
  /^vocab-lexeme-operation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOCAB_LEXEME_CARD_ID_PATTERN =
  /^card_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOCAB_LEXEME_STATUSES: readonly Lexeme["status"][] = [
  "saved",
  "learning",
  "known",
  "ignored",
];
const VOCAB_LEXEME_WRITE_KINDS = [
  "note-save",
  "status-set",
  "star-set",
] as const;
const VOCAB_STORED_LEXEME_KEYS = [
  "id",
  "headword",
  "normalized_key",
  "pronunciation",
  "gloss_en",
  "explanation_en",
  "explanation_zh",
  "status",
  "starred",
  "notes",
  "lookup_count",
  "created_at",
  "updated_at",
] as const;
const VOCAB_STORED_REVIEW_CARD_KEYS = [
  "id",
  "lexeme_id",
  ...REVIEW_STATE_KEYS,
] as const;

type VocabLexemeJoinRow = VocabStoredLexeme & Readonly<{
  card_id: string | null;
  card_lexeme_id: string | null;
  card_state: ReviewCard["state"] | null;
  card_due_at: number | null;
  card_interval_days: number | null;
  card_ease: number | null;
  card_reps: number | null;
  card_lapses: number | null;
  card_last_review_at: number | null;
  card_algorithm_version: number | null;
  card_suspended_from_state: ReviewCard["suspended_from_state"];
  card_suspended_reason: string | null;
  card_updated_at: number | null;
}>;

function vocabLexemeError(
  code: VocabLexemeMutationErrorCode,
  message: string,
  receipt?: VocabLexemeWriteReceipt,
): VocabLexemeMutationError {
  return new VocabLexemeMutationError(code, message, receipt);
}

export function isVocabStoredLexeme(
  value: unknown,
): value is VocabStoredLexeme {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lexeme = value as Partial<VocabStoredLexeme>;
  return settingsExactObjectKeys(value, VOCAB_STORED_LEXEME_KEYS) &&
    isSafeOpaqueReviewCardId(lexeme.id) &&
    typeof lexeme.headword === "string" &&
    typeof lexeme.normalized_key === "string" &&
    typeof lexeme.pronunciation === "string" &&
    typeof lexeme.gloss_en === "string" &&
    typeof lexeme.explanation_en === "string" &&
    typeof lexeme.explanation_zh === "string" &&
    VOCAB_LEXEME_STATUSES.includes(lexeme.status as Lexeme["status"]) &&
    (lexeme.starred === 0 || lexeme.starred === 1) &&
    typeof lexeme.notes === "string" &&
    settingsSafeInteger(lexeme.lookup_count) &&
    settingsSafeInteger(lexeme.created_at) &&
    settingsSafeInteger(lexeme.updated_at);
}

export function isVocabStoredReviewCard(
  value: unknown,
): value is VocabStoredReviewCard {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const card = value as Partial<VocabStoredReviewCard>;
  if (
    !settingsExactObjectKeys(value, VOCAB_STORED_REVIEW_CARD_KEYS) ||
    !isSafeOpaqueReviewCardId(card.id) ||
    !isSafeOpaqueReviewCardId(card.lexeme_id)
  ) return false;
  return isReviewStateProjection(Object.fromEntries(
    REVIEW_STATE_KEYS.map((key) => [key, card[key]]),
  ));
}

function isVocabLexemeExpectedEntry(
  value: unknown,
): value is VocabLexemeExpectedEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<VocabLexemeExpectedEntry>;
  return settingsExactObjectKeys(value, ["lexeme", "reviewCard"]) &&
    isVocabStoredLexeme(entry.lexeme) &&
    (entry.reviewCard === null || isVocabStoredReviewCard(entry.reviewCard)) &&
    (entry.reviewCard === null || entry.reviewCard.lexeme_id === entry.lexeme.id);
}

export function isVocabLexemeExpectedSet(
  value: unknown,
): value is VocabLexemeExpectedSet {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const set = value as Partial<VocabLexemeExpectedSet>;
  if (
    !settingsExactObjectKeys(value, [
      "generationId", "generationSequence", "entries",
    ]) ||
    typeof set.generationId !== "string" ||
    !VOCAB_SETTINGS_GENERATION_ID_PATTERN.test(set.generationId) ||
    !settingsSafeInteger(set.generationSequence) ||
    !Array.isArray(set.entries) ||
    !set.entries.every(isVocabLexemeExpectedEntry)
  ) return false;
  return set.entries.every((entry, index) =>
    index === 0 || set.entries![index - 1].lexeme.id < entry.lexeme.id
  );
}

export function isVocabLexemeExpectedState(
  value: unknown,
): value is VocabLexemeExpectedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<VocabLexemeExpectedState>;
  return settingsExactObjectKeys(value, [
    "generationId", "generationSequence", "lexeme", "reviewCard",
  ]) &&
    typeof state.generationId === "string" &&
    VOCAB_SETTINGS_GENERATION_ID_PATTERN.test(state.generationId) &&
    settingsSafeInteger(state.generationSequence) &&
    isVocabStoredLexeme(state.lexeme) &&
    (state.reviewCard === null || isVocabStoredReviewCard(state.reviewCard)) &&
    (state.reviewCard === null || state.reviewCard.lexeme_id === state.lexeme.id);
}

function isVocabLexemeWriteSnapshot(
  value: unknown,
): value is VocabLexemeWriteSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<VocabLexemeWriteSnapshot>;
  return settingsExactObjectKeys(value, [
    "generationId", "generationSequence", "lexeme",
  ]) &&
    typeof snapshot.generationId === "string" &&
    VOCAB_SETTINGS_GENERATION_ID_PATTERN.test(snapshot.generationId) &&
    settingsSafeInteger(snapshot.generationSequence) &&
    isVocabStoredLexeme(snapshot.lexeme);
}

function isVocabLexemeStatusWriteSnapshot(
  value: unknown,
): value is VocabLexemeStatusWriteSnapshot {
  return isVocabLexemeExpectedState(value);
}

function sameVocabLexemeExcept(
  before: VocabStoredLexeme,
  after: VocabStoredLexeme,
  changed: "notes" | "starred" | "status",
): boolean {
  return VOCAB_STORED_LEXEME_KEYS.every((key) =>
    key === changed || key === "updated_at" || before[key] === after[key]
  ) && after.updated_at > before.updated_at;
}

function sameVocabLexemeGeneration(
  before: VocabLexemeWriteSnapshot,
  after: VocabLexemeWriteSnapshot,
): boolean {
  return before.generationId === after.generationId &&
    before.generationSequence === after.generationSequence &&
    before.lexeme.id === after.lexeme.id;
}

function reconciledStoredCard(
  before: VocabStoredReviewCard,
  lexeme: VocabStoredLexeme,
  heartbeat: boolean,
): VocabStoredReviewCard {
  const suspension = reconcileReviewSuspension(
    before,
    lexeme.status,
    hasUsefulEnglishExplanation(lexeme.gloss_en, lexeme.explanation_en),
  );
  if (
    suspension.state === before.state &&
    suspension.suspended_from_state === before.suspended_from_state &&
    suspension.suspended_reason === before.suspended_reason
  ) {
    return heartbeat
      ? {
          ...before,
          updated_at: Math.max(lexeme.updated_at, before.updated_at + 1),
        }
      : { ...before };
  }
  return {
    ...before,
    ...suspension,
    updated_at: Math.max(lexeme.updated_at, before.updated_at + 1),
  };
}

function newStoredReviewCard(
  cardId: string,
  lexeme: VocabStoredLexeme,
): VocabStoredReviewCard {
  const suspension = reconcileReviewSuspension({
    state: "new",
    suspended_from_state: null,
    suspended_reason: null,
  }, lexeme.status, hasUsefulEnglishExplanation(
    lexeme.gloss_en,
    lexeme.explanation_en,
  ));
  return {
    id: cardId,
    lexeme_id: lexeme.id,
    ...suspension,
    due_at: lexeme.updated_at,
    interval_days: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    last_review_at: null,
    algorithm_version: 2,
    updated_at: lexeme.updated_at,
  };
}

function isVocabLexemeStatusCardTransition(
  beforeLexeme: VocabStoredLexeme,
  before: VocabStoredReviewCard | null,
  after: VocabStoredReviewCard | null,
  afterLexeme: VocabStoredLexeme,
): boolean {
  if (after === null) return false;
  if (before === null) {
    return VOCAB_LEXEME_CARD_ID_PATTERN.test(after.id) &&
      sameSettingsProjection(after, newStoredReviewCard(after.id, afterLexeme));
  }
  return sameSettingsProjection(after, reconciledStoredCard(
    before,
    afterLexeme,
    beforeLexeme.status !== afterLexeme.status,
  ));
}

function isVocabLexemeWriteTransition(
  kind: VocabLexemeWriteReceipt["kind"],
  beforeValue: unknown,
  afterValue: unknown,
): boolean {
  if (kind === "status-set") {
    if (
      !isVocabLexemeStatusWriteSnapshot(beforeValue) ||
      !isVocabLexemeStatusWriteSnapshot(afterValue)
    ) return false;
    return sameVocabLexemeGeneration(beforeValue, afterValue) &&
      sameVocabLexemeExcept(beforeValue.lexeme, afterValue.lexeme, "status") &&
      isVocabLexemeStatusCardTransition(
        beforeValue.lexeme,
        beforeValue.reviewCard,
        afterValue.reviewCard,
        afterValue.lexeme,
      );
  }
  if (
    !isVocabLexemeWriteSnapshot(beforeValue) ||
    !isVocabLexemeWriteSnapshot(afterValue) ||
    !sameVocabLexemeGeneration(beforeValue, afterValue)
  ) return false;
  return kind === "note-save"
    ? sameVocabLexemeExcept(beforeValue.lexeme, afterValue.lexeme, "notes")
    : sameVocabLexemeExcept(beforeValue.lexeme, afterValue.lexeme, "starred");
}

function isVocabLexemeWriteReceiptUnchecked(
  value: unknown,
): value is VocabLexemeWriteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<VocabLexemeWriteReceipt>;
  if (
    !settingsExactObjectKeys(value, [
      "purpose", "version", "kind", "operationId", "generationId",
      "generationSequence", "before", "after", "projectionSha256",
    ]) ||
    receipt.purpose !== "vocab-lexeme-write" || receipt.version !== 1 ||
    !VOCAB_LEXEME_WRITE_KINDS.includes(
      receipt.kind as VocabLexemeWriteReceipt["kind"],
    ) ||
    typeof receipt.operationId !== "string" ||
    !VOCAB_LEXEME_OPERATION_ID_PATTERN.test(receipt.operationId) ||
    typeof receipt.generationId !== "string" ||
    !VOCAB_SETTINGS_GENERATION_ID_PATTERN.test(receipt.generationId) ||
    !settingsSafeInteger(receipt.generationSequence) ||
    typeof receipt.projectionSha256 !== "string" ||
    !RECEIPT_HASH_PATTERN.test(receipt.projectionSha256) ||
    !isVocabLexemeWriteTransition(
      receipt.kind as VocabLexemeWriteReceipt["kind"],
      receipt.before,
      receipt.after,
    )
  ) return false;
  const before = receipt.before as VocabLexemeWriteSnapshot;
  const after = receipt.after as VocabLexemeWriteSnapshot;
  return receipt.generationId === before.generationId &&
    receipt.generationSequence === before.generationSequence &&
    receipt.generationId === after.generationId &&
    receipt.generationSequence === after.generationSequence &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      VOCAB_LEXEME_MAX_JSON_BYTES;
}

export function isVocabLexemeWriteReceipt(
  value: unknown,
): value is VocabLexemeWriteReceipt {
  try {
    return settingsJsonSafe(value) && isVocabLexemeWriteReceiptUnchecked(value);
  } catch {
    return false;
  }
}

async function sealVocabLexemeReceipt<Receipt extends VocabLexemeWriteReceipt>(
  draft: Omit<Receipt, "projectionSha256">,
): Promise<Receipt> {
  const projectionSha256 = await settingsSha256Hex(settingsCanonicalJson(draft));
  const receipt = { ...draft, projectionSha256 } as Receipt;
  if (!isVocabLexemeWriteReceipt(receipt)) {
    throw vocabLexemeError("invalid_input", "无法生成有效的词条写入回执。");
  }
  return receipt;
}

async function vocabLexemeReceiptHashIsValid(
  receipt: VocabLexemeWriteReceipt,
): Promise<boolean> {
  const { projectionSha256, ...projection } = receipt;
  return projectionSha256 ===
    await settingsSha256Hex(settingsCanonicalJson(projection));
}

function cloneVocabLexemeChecked<Result>(
  value: unknown,
  guard: (candidate: unknown) => candidate is Result,
  label: string,
): Result {
  let snapshot: unknown;
  try {
    snapshot = settingsSnapshotInput(value);
  } catch {
    throw vocabLexemeError(
      "invalid_input",
      `${label}必须是安全、有限的 JSON 数据。`,
    );
  }
  if (!guard(snapshot)) {
    throw vocabLexemeError("invalid_input", `${label}格式不正确。`);
  }
  return snapshot;
}

async function readVocabLexemeGeneration(
  runtime: VocabLexemeStorageRuntime,
): Promise<Readonly<{ generationId: string; generationSequence: number }>> {
  const current = await runtime.currentGeneration();
  if (
    !current || typeof current.generationId !== "string" ||
    !VOCAB_SETTINGS_GENERATION_ID_PATTERN.test(current.generationId) ||
    !settingsSafeInteger(current.sequence)
  ) throw new Error("无法确认当前拾词数据库世代。");
  return {
    generationId: current.generationId,
    generationSequence: current.sequence,
  };
}

function storedLexemeFromJoin(row: VocabLexemeJoinRow): VocabStoredLexeme {
  return {
    id: row.id,
    headword: row.headword,
    normalized_key: row.normalized_key,
    pronunciation: row.pronunciation,
    gloss_en: row.gloss_en,
    explanation_en: row.explanation_en,
    explanation_zh: row.explanation_zh,
    status: row.status,
    starred: row.starred,
    notes: row.notes,
    lookup_count: row.lookup_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function storedCardFromJoin(
  row: VocabLexemeJoinRow,
): VocabStoredReviewCard | null {
  if (row.card_id === null) return null;
  return {
    id: row.card_id,
    lexeme_id: row.card_lexeme_id as string,
    state: row.card_state as ReviewCard["state"],
    due_at: row.card_due_at as number,
    interval_days: row.card_interval_days as number,
    ease: row.card_ease as number,
    reps: row.card_reps as number,
    lapses: row.card_lapses as number,
    last_review_at: row.card_last_review_at,
    algorithm_version: row.card_algorithm_version as number,
    suspended_from_state: row.card_suspended_from_state,
    suspended_reason: row.card_suspended_reason,
    updated_at: row.card_updated_at as number,
  };
}

async function readVocabLexemeEntries(
  runtime: VocabLexemeStorageRuntime,
  lexemeId?: string,
): Promise<readonly VocabLexemeExpectedEntry[]> {
  const rows = (await runtime.query<VocabLexemeJoinRow>(
    `SELECT l.id,l.headword,l.normalized_key,l.pronunciation,l.gloss_en,
      l.explanation_en,l.explanation_zh,l.status,l.starred,l.notes,
      l.lookup_count,l.created_at,l.updated_at,c.id AS card_id,
      c.lexeme_id AS card_lexeme_id,c.state AS card_state,
      c.due_at AS card_due_at,c.interval_days AS card_interval_days,
      c.ease AS card_ease,c.reps AS card_reps,c.lapses AS card_lapses,
      c.last_review_at AS card_last_review_at,
      c.algorithm_version AS card_algorithm_version,
      c.suspended_from_state AS card_suspended_from_state,
      c.suspended_reason AS card_suspended_reason,
      c.updated_at AS card_updated_at
      FROM vocab_lexemes l
      LEFT JOIN vocab_review_cards c ON c.lexeme_id=l.id
      ${lexemeId === undefined ? "" : "WHERE l.id=?"}
      ORDER BY l.id`,
    lexemeId === undefined ? [] : [lexemeId],
  )).rows;
  const entries: VocabLexemeExpectedEntry[] = [];
  for (const row of rows) {
    const entry = {
      lexeme: storedLexemeFromJoin(row),
      reviewCard: storedCardFromJoin(row),
    };
    if (
      !isVocabLexemeExpectedEntry(entry) ||
      (entries.length > 0 &&
        entries[entries.length - 1].lexeme.id >= entry.lexeme.id)
    ) throw new Error("词条或复习卡存储行不符合 canonical 格式。");
    entries.push(entry);
  }
  return entries;
}

async function readVocabStoredLexeme(
  runtime: VocabLexemeStorageRuntime,
  lexemeId: string,
): Promise<VocabStoredLexeme | null> {
  const rows = (await runtime.query<VocabStoredLexeme>(
    `SELECT id,headword,normalized_key,pronunciation,gloss_en,explanation_en,
      explanation_zh,status,starred,notes,lookup_count,created_at,updated_at
      FROM vocab_lexemes WHERE id=? ORDER BY id LIMIT 2`,
    [lexemeId],
  )).rows;
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !isVocabStoredLexeme(rows[0])) {
    throw new Error("词条存储行不符合 canonical 格式。");
  }
  return { ...rows[0] };
}

function nextVocabLexemeTimestamp(latest: number, now: number): number {
  if (!settingsSafeInteger(now)) {
    throw vocabLexemeError("invalid_input", "设备时间不在可接受范围。");
  }
  const timestamp = Math.max(now, latest + 1);
  if (!settingsSafeInteger(timestamp)) {
    throw vocabLexemeError("invalid_input", "词条版本时间超出可接受范围。");
  }
  return timestamp;
}

function generatedVocabLexemeOperationId(
  runtime: VocabLexemeStorageRuntime,
): string {
  const id = `vocab-lexeme-operation-${runtime.randomUUID()}`;
  if (!VOCAB_LEXEME_OPERATION_ID_PATTERN.test(id)) {
    throw vocabLexemeError("invalid_input", "无法生成可靠的词条操作标识。");
  }
  return id;
}

function generatedVocabLexemeCardId(runtime: VocabLexemeStorageRuntime): string {
  const id = `card_${runtime.randomUUID()}`;
  if (!VOCAB_LEXEME_CARD_ID_PATTERN.test(id)) {
    throw vocabLexemeError("invalid_input", "无法生成可靠的复习卡标识。");
  }
  return id;
}

function withRequiredVocabLexemeWriteLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const locks = typeof navigator === "undefined"
    ? null
    : (navigator as Navigator & { locks?: unknown }).locks ?? null;
  if (!locks) {
    throw new Error(
      "当前浏览器不支持安全的跨标签页写入锁，请使用最新版 Chrome、Edge 或 Safari。",
    );
  }
  return withVocabWriteLock(operation);
}

function safeVocabLexemeBroadcast(
  runtime: VocabLexemeStorageRuntime,
  reason: string,
): void {
  try {
    runtime.broadcast(reason);
  } catch {
    // A refresh hint is advisory and cannot reverse a durable commit.
  }
}

function vocabLexemeBroadcastReason(
  kind: VocabLexemeWriteReceipt["kind"],
): string {
  switch (kind) {
    case "note-save": return "lexeme-note-saved";
    case "status-set": return "lexeme-status-changed";
    case "star-set": return "lexeme-star-changed";
  }
}

function vocabLexemeRowPredicate(
  lexeme: VocabStoredLexeme,
): Readonly<{ sql: string; params: SqlValue[] }> {
  return {
    sql: `EXISTS(SELECT 1 FROM vocab_lexemes WHERE id IS ? AND headword IS ?
      AND normalized_key IS ? AND pronunciation IS ? AND gloss_en IS ?
      AND explanation_en IS ? AND explanation_zh IS ? AND status IS ?
      AND starred IS ? AND notes IS ? AND lookup_count IS ?
      AND created_at IS ? AND updated_at IS ?)`,
    params: VOCAB_STORED_LEXEME_KEYS.map((key) => lexeme[key]),
  };
}

function vocabReviewCardRowPredicate(
  card: VocabStoredReviewCard,
): Readonly<{ sql: string; params: SqlValue[] }> {
  return {
    sql: `EXISTS(SELECT 1 FROM vocab_review_cards WHERE id IS ?
      AND lexeme_id IS ? AND state IS ? AND due_at IS ?
      AND interval_days IS ? AND ease IS ? AND reps IS ? AND lapses IS ?
      AND last_review_at IS ? AND algorithm_version IS ?
      AND suspended_from_state IS ? AND suspended_reason IS ?
      AND updated_at IS ?)`,
    params: VOCAB_STORED_REVIEW_CARD_KEYS.map((key) => card[key]),
  };
}

function vocabLexemeReceiptStatements(
  receipt: VocabLexemeWriteReceipt,
): Statement[] {
  const lexemePredicate = vocabLexemeRowPredicate(receipt.before.lexeme);
  let relatedPredicate = "1";
  let relatedParams: SqlValue[] = [];
  if (receipt.kind === "status-set") {
    if (receipt.before.reviewCard) {
      const card = vocabReviewCardRowPredicate(receipt.before.reviewCard);
      relatedPredicate = card.sql;
      relatedParams = card.params;
    } else {
      const cardId = receipt.after.reviewCard!.id;
      relatedPredicate = `NOT EXISTS(
          SELECT 1 FROM vocab_review_cards WHERE lexeme_id=?
        ) AND NOT EXISTS(
          SELECT 1 FROM vocab_review_cards WHERE id=?
        )`;
      relatedParams = [receipt.before.lexeme.id, cardId];
    }
  }
  const statements: Statement[] = [{
    sql: `INSERT INTO vocab_lexemes(
        id,headword,normalized_key,created_at,updated_at
      ) SELECT '__vocab_lexeme_cas_abort__',NULL,
        '__vocab_lexeme_cas_abort__',0,0
      WHERE NOT ((${lexemePredicate.sql}) AND (${relatedPredicate}))`,
    params: [...lexemePredicate.params, ...relatedParams],
  }];
  switch (receipt.kind) {
    case "note-save":
      statements.push({
        sql: "UPDATE vocab_lexemes SET notes=?,updated_at=? WHERE id=?",
        params: [
          receipt.after.lexeme.notes,
          receipt.after.lexeme.updated_at,
          receipt.after.lexeme.id,
        ],
      });
      break;
    case "star-set":
      statements.push({
        sql: "UPDATE vocab_lexemes SET starred=?,updated_at=? WHERE id=?",
        params: [
          receipt.after.lexeme.starred,
          receipt.after.lexeme.updated_at,
          receipt.after.lexeme.id,
        ],
      });
      break;
    case "status-set": {
      statements.push({
        sql: "UPDATE vocab_lexemes SET status=?,updated_at=? WHERE id=?",
        params: [
          receipt.after.lexeme.status,
          receipt.after.lexeme.updated_at,
          receipt.after.lexeme.id,
        ],
      });
      const afterCard = receipt.after.reviewCard!;
      if (receipt.before.reviewCard === null) {
        statements.push({
          sql: `INSERT INTO vocab_review_cards(
            id,lexeme_id,state,due_at,interval_days,ease,reps,lapses,
            last_review_at,algorithm_version,suspended_from_state,
            suspended_reason,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          params: VOCAB_STORED_REVIEW_CARD_KEYS.map((key) => afterCard[key]),
        });
      } else if (!sameSettingsProjection(receipt.before.reviewCard, afterCard)) {
        statements.push({
          sql: `UPDATE vocab_review_cards SET state=?,suspended_from_state=?,
            suspended_reason=?,updated_at=? WHERE id=?`,
          params: [
            afterCard.state,
            afterCard.suspended_from_state,
            afterCard.suspended_reason,
            afterCard.updated_at,
            afterCard.id,
          ],
        });
      }
      break;
    }
  }
  return statements;
}

export function createVocabLexemeStorageService(
  runtime: VocabLexemeStorageRuntime = {
    withReadLock: (operation) => withVocabReadLock(operation),
    withExclusiveLock: withRequiredVocabLexemeWriteLock,
    query: async <Result extends object>(sql: string, params?: SqlValue[]) => ({
      rows: await rawQuery<Result>(sql, params),
    }),
    batch: (statements) => localDb.batch(DB, statements, { transaction: true }),
    currentGeneration: () => localDb.currentGeneration(DB),
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    broadcast: broadcastVocabChange,
  },
) {
  async function readLocked<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await (runtime.withReadLock
        ? runtime.withReadLock(operation)
        : runtime.withExclusiveLock(operation));
    } catch (error) {
      if (error instanceof VocabLexemeMutationError) throw error;
      throw vocabLexemeError("inspect_failed", "暂时无法读取最新词条；没有开始写入。");
    }
  }

  async function prepareLocked<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await runtime.withExclusiveLock(operation);
    } catch (error) {
      if (error instanceof VocabLexemeMutationError) throw error;
      throw vocabLexemeError("inspect_failed", "暂时无法核对最新词条；没有开始写入。");
    }
  }

  async function loadExpectedStates(): Promise<VocabLexemeExpectedSet> {
    return readLocked(async () => {
      const generation = await readVocabLexemeGeneration(runtime);
      const set: VocabLexemeExpectedSet = {
        ...generation,
        entries: await readVocabLexemeEntries(runtime),
      };
      if (!isVocabLexemeExpectedSet(set)) {
        throw new Error("无法构造可信的词条集合读取快照。");
      }
      return set;
    });
  }

  async function loadExpectedState(
    lexemeIdValue: string,
  ): Promise<VocabLexemeExpectedState> {
    const lexemeId = cloneVocabLexemeChecked(
      lexemeIdValue,
      isSafeOpaqueReviewCardId,
      "词条标识",
    );
    return readLocked(async () => {
      const generation = await readVocabLexemeGeneration(runtime);
      const entries = await readVocabLexemeEntries(runtime, lexemeId);
      if (entries.length !== 1) {
        throw vocabLexemeError("changed", "这个词条已经不存在；没有开始写入。");
      }
      return { ...generation, ...entries[0] };
    });
  }

  async function currentLexemeSnapshot(
    expected: VocabLexemeExpectedState,
  ): Promise<Readonly<{
    generation: Readonly<{ generationId: string; generationSequence: number }>;
    lexeme: VocabStoredLexeme;
  }>> {
    const generation = await readVocabLexemeGeneration(runtime);
    if (
      expected.generationId !== generation.generationId ||
      expected.generationSequence !== generation.generationSequence
    ) throw vocabLexemeError("changed", "词条所在数据库已经更换；没有准备写入。");
    const lexeme = await readVocabStoredLexeme(runtime, expected.lexeme.id);
    if (!lexeme || !sameSettingsProjection(lexeme, expected.lexeme)) {
      throw vocabLexemeError("changed", "这个词条已在别处变化；没有准备写入。");
    }
    return { generation, lexeme };
  }

  async function prepareSimple<Receipt extends
    VocabLexemeNoteSaveReceipt | VocabLexemeStarSetReceipt>(
    kind: Receipt["kind"],
    nextValue: string | boolean,
    expectedValue: VocabLexemeExpectedState,
  ): Promise<Receipt> {
    const expected = cloneVocabLexemeChecked(
      expectedValue,
      isVocabLexemeExpectedState,
      "词条读取快照",
    );
    if (kind === "note-save" && typeof nextValue !== "string") {
      throw vocabLexemeError("invalid_input", "词条笔记必须是文本。");
    }
    if (kind === "star-set" && typeof nextValue !== "boolean") {
      throw vocabLexemeError("invalid_input", "词条星标必须是布尔值。");
    }
    return prepareLocked(async () => {
      const { generation, lexeme } = await currentLexemeSnapshot(expected);
      const updatedAt = nextVocabLexemeTimestamp(lexeme.updated_at, runtime.now());
      const before: VocabLexemeWriteSnapshot = { ...generation, lexeme };
      const after: VocabLexemeWriteSnapshot = {
        ...generation,
        lexeme: {
          ...lexeme,
          ...(kind === "note-save"
            ? { notes: nextValue as string }
            : { starred: (nextValue as boolean) ? 1 : 0 }),
          updated_at: updatedAt,
        },
      };
      return sealVocabLexemeReceipt<Receipt>({
        purpose: "vocab-lexeme-write",
        version: 1,
        kind,
        operationId: generatedVocabLexemeOperationId(runtime),
        ...generation,
        before,
        after,
      } as Omit<Receipt, "projectionSha256">);
    });
  }

  async function prepareStatus(
    statusValue: Lexeme["status"],
    expectedValue: VocabLexemeExpectedState,
  ): Promise<VocabLexemeStatusSetReceipt> {
    const expected = cloneVocabLexemeChecked(
      expectedValue,
      isVocabLexemeExpectedState,
      "词条读取快照",
    );
    if (!VOCAB_LEXEME_STATUSES.includes(statusValue)) {
      throw vocabLexemeError("invalid_input", "词条状态不受支持。");
    }
    return prepareLocked(async () => {
      const generation = await readVocabLexemeGeneration(runtime);
      if (
        expected.generationId !== generation.generationId ||
        expected.generationSequence !== generation.generationSequence
      ) throw vocabLexemeError("changed", "词条所在数据库已经更换；没有准备写入。");
      const entries = await readVocabLexemeEntries(runtime, expected.lexeme.id);
      if (entries.length !== 1) {
        throw vocabLexemeError("changed", "这个词条已经不存在；没有准备写入。");
      }
      const current: VocabLexemeExpectedState = { ...generation, ...entries[0] };
      if (!sameSettingsProjection(current, expected)) {
        throw vocabLexemeError("changed", "词条或复习卡已在别处变化；没有准备写入。");
      }
      const updatedAt = nextVocabLexemeTimestamp(
        current.lexeme.updated_at,
        runtime.now(),
      );
      const afterLexeme: VocabStoredLexeme = {
        ...current.lexeme,
        status: statusValue,
        updated_at: updatedAt,
      };
      let afterCard: VocabStoredReviewCard;
      if (current.reviewCard) {
        afterCard = reconciledStoredCard(
          current.reviewCard,
          afterLexeme,
          current.lexeme.status !== afterLexeme.status,
        );
      } else {
        const cardId = generatedVocabLexemeCardId(runtime);
        const occupied = (await runtime.query<{ id: string }>(
          "SELECT id FROM vocab_review_cards WHERE id=? LIMIT 2",
          [cardId],
        )).rows;
        if (occupied.length !== 0) {
          throw vocabLexemeError("changed", "新的复习卡标识已被占用；没有准备写入。");
        }
        afterCard = newStoredReviewCard(cardId, afterLexeme);
      }
      const before: VocabLexemeStatusWriteSnapshot = {
        ...generation,
        lexeme: current.lexeme,
        reviewCard: current.reviewCard,
      };
      const after: VocabLexemeStatusWriteSnapshot = {
        ...generation,
        lexeme: afterLexeme,
        reviewCard: afterCard,
      };
      return sealVocabLexemeReceipt<VocabLexemeStatusSetReceipt>({
        purpose: "vocab-lexeme-write",
        version: 1,
        kind: "status-set",
        operationId: generatedVocabLexemeOperationId(runtime),
        ...generation,
        before,
        after,
      });
    });
  }

  async function receiptStateUnlocked(
    receipt: VocabLexemeWriteReceipt,
  ): Promise<Exclude<
    VocabLexemeWriteInspection,
    "still_unknown" | "invalid_receipt"
  >> {
    const generation = await readVocabLexemeGeneration(runtime);
    if (
      generation.generationId !== receipt.generationId ||
      generation.generationSequence !== receipt.generationSequence
    ) return "changed";
    if (receipt.kind === "status-set") {
      const entries = await readVocabLexemeEntries(
        runtime,
        receipt.before.lexeme.id,
      );
      if (entries.length !== 1) return "changed";
      const current: VocabLexemeStatusWriteSnapshot = {
        ...generation,
        ...entries[0],
      };
      if (sameSettingsProjection(current, receipt.after)) return "exact_saved";
      if (!sameSettingsProjection(current, receipt.before)) return "changed";
      if (receipt.before.reviewCard === null) {
        const occupied = (await runtime.query<{ id: string; lexeme_id: string }>(
          "SELECT id,lexeme_id FROM vocab_review_cards WHERE id=? LIMIT 2",
          [receipt.after.reviewCard!.id],
        )).rows;
        if (occupied.length !== 0) return "changed";
      }
      return "expected";
    }
    const lexeme = await readVocabStoredLexeme(runtime, receipt.before.lexeme.id);
    if (!lexeme) return "changed";
    const current: VocabLexemeWriteSnapshot = { ...generation, lexeme };
    if (sameSettingsProjection(current, receipt.after)) return "exact_saved";
    return sameSettingsProjection(current, receipt.before) ? "expected" : "changed";
  }

  async function inspectWrite(value: unknown): Promise<VocabLexemeWriteInspection> {
    let receipt: VocabLexemeWriteReceipt;
    try {
      const stable = settingsSnapshotInput(value);
      if (!isVocabLexemeWriteReceipt(stable)) return "invalid_receipt";
      receipt = stable;
      if (!await vocabLexemeReceiptHashIsValid(receipt)) return "invalid_receipt";
    } catch {
      return "invalid_receipt";
    }
    try {
      return await runtime.withExclusiveLock(() => receiptStateUnlocked(receipt));
    } catch {
      return "still_unknown";
    }
  }

  async function commitWrite(value: unknown): Promise<VocabLexemeWriteResult> {
    let receipt: VocabLexemeWriteReceipt;
    try {
      const stable = settingsSnapshotInput(value);
      if (!isVocabLexemeWriteReceipt(stable)) {
        throw vocabLexemeError("invalid_receipt", "词条写入回执无效；没有改动资料。");
      }
      receipt = stable;
      if (!await vocabLexemeReceiptHashIsValid(receipt)) {
        throw vocabLexemeError("invalid_receipt", "词条写入回执无法验证；没有改动资料。");
      }
    } catch (error) {
      if (
        error instanceof VocabLexemeMutationError &&
        error.code === "invalid_receipt"
      ) throw error;
      throw vocabLexemeError("invalid_receipt", "词条写入回执无法验证；没有改动资料。");
    }
    const entityId = receipt.after.lexeme.id;
    const updatedAt = receipt.after.lexeme.updated_at;
    try {
      return await runtime.withExclusiveLock(async () => {
        const before = await receiptStateUnlocked(receipt);
        if (before === "exact_saved") {
          safeVocabLexemeBroadcast(
            runtime,
            vocabLexemeBroadcastReason(receipt.kind),
          );
          return { outcome: "already_saved", receipt, entityId, updatedAt };
        }
        if (before === "changed") {
          return { outcome: "changed", receipt, entityId, retryable: false };
        }
        try {
          await runtime.batch(vocabLexemeReceiptStatements(receipt));
        } catch {
          // The transaction may have committed even though its response was lost.
        }
        const after = await receiptStateUnlocked(receipt);
        if (after === "exact_saved") {
          safeVocabLexemeBroadcast(
            runtime,
            vocabLexemeBroadcastReason(receipt.kind),
          );
          return { outcome: "saved", receipt, entityId, updatedAt };
        }
        if (after === "expected") {
          throw vocabLexemeError(
            "write_failed",
            "这次词条修改确定没有写入；保留原回执后可以重试。",
            receipt,
          );
        }
        return { outcome: "changed", receipt, entityId, retryable: false };
      });
    } catch (error) {
      if (error instanceof VocabLexemeMutationError) throw error;
      return {
        outcome: "outcome_uncertain",
        receipt,
        entityId,
        retryable: true,
      };
    }
  }

  return {
    loadVocabLexemeExpectedStates: loadExpectedStates,
    loadVocabLexemeExpectedState: loadExpectedState,
    prepareVocabLexemeNoteSave: (
      note: string,
      expected: VocabLexemeExpectedState,
    ) => prepareSimple<VocabLexemeNoteSaveReceipt>("note-save", note, expected),
    prepareVocabLexemeStarSet: (
      starred: boolean,
      expected: VocabLexemeExpectedState,
    ) => prepareSimple<VocabLexemeStarSetReceipt>("star-set", starred, expected),
    prepareVocabLexemeStatusSet: prepareStatus,
    inspectVocabLexemeWrite: inspectWrite,
    commitVocabLexemeWrite: commitWrite,
  } as const;
}

const defaultVocabLexemeStorageService = createVocabLexemeStorageService();

export const loadVocabLexemeExpectedStates =
  defaultVocabLexemeStorageService.loadVocabLexemeExpectedStates;
export const loadVocabLexemeExpectedState =
  defaultVocabLexemeStorageService.loadVocabLexemeExpectedState;
export const prepareVocabLexemeNoteSave =
  defaultVocabLexemeStorageService.prepareVocabLexemeNoteSave;
export const prepareVocabLexemeStarSet =
  defaultVocabLexemeStorageService.prepareVocabLexemeStarSet;
export const prepareVocabLexemeStatusSet =
  defaultVocabLexemeStorageService.prepareVocabLexemeStatusSet;
export const inspectVocabLexemeWrite =
  defaultVocabLexemeStorageService.inspectVocabLexemeWrite;
export const commitVocabLexemeWrite =
  defaultVocabLexemeStorageService.commitVocabLexemeWrite;

const VOCAB_ENGAGEMENT_MAX_JSON_BYTES = 1_048_576;
const VOCAB_ENGAGEMENT_MAX_SECONDS = 86_400;
const VOCAB_ENGAGEMENT_OPERATION_ID_PATTERN =
  /^vocab-engagement-operation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOCAB_ENGAGEMENT_BOOKMARK_ID_PATTERN =
  /^bookmark_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOCAB_ENGAGEMENT_ACTIVITY_ID_PATTERN =
  /^activity_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOCAB_ENGAGEMENT_BOOKMARK_ROW_KEYS = [
  "id", "item_id", "locator", "label", "note", "created_at",
] as const;
const VOCAB_ENGAGEMENT_ACTIVITY_ROW_KEYS = [
  "id", "day", "read_seconds", "listen_seconds", "review_count", "lookups",
  "created_at",
] as const;

function vocabEngagementError(
  code: VocabEngagementMutationErrorCode,
  message: string,
  receipt?: VocabEngagementWriteReceipt,
): VocabEngagementMutationError {
  return new VocabEngagementMutationError(code, message, receipt);
}

function engagementStringIsWellFormed(
  value: unknown,
  maximumCharacters: number,
  maximumBytes: number,
  allowEmpty: boolean,
): value is string {
  if (typeof value !== "string") return false;
  const characters = Array.from(value);
  if (
    characters.length > maximumCharacters ||
    new TextEncoder().encode(value).byteLength > maximumBytes ||
    (!allowEmpty && value.trim().length === 0)
  ) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return allowEmpty || characters.length > 0;
}

function isVocabBookmarkLocator(value: unknown): value is string {
  return engagementStringIsWellFormed(value, 2_048, 8_192, false);
}

function isVocabBookmarkLabel(value: unknown): value is string {
  return engagementStringIsWellFormed(value, 4_096, 16_384, true);
}

function isVocabBookmarkNote(value: unknown): value is string {
  return engagementStringIsWellFormed(value, 65_536, 262_144, true);
}

function isVocabEngagementGenerationExpectation(
  value: unknown,
): value is VocabEngagementGenerationExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expected = value as Partial<VocabEngagementGenerationExpectation>;
  return settingsExactObjectKeys(value, ["generationId", "generationSequence"]) &&
    typeof expected.generationId === "string" &&
    VOCAB_SETTINGS_GENERATION_ID_PATTERN.test(expected.generationId) &&
    settingsSafeInteger(expected.generationSequence);
}

function isVocabBookmarkCreateInput(
  value: unknown,
): value is VocabBookmarkCreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<VocabBookmarkCreateInput>;
  return settingsExactObjectKeys(value, ["itemId", "locator", "label"]) &&
    isSafeOpaqueReviewCardId(input.itemId) &&
    isVocabBookmarkLocator(input.locator) &&
    isVocabBookmarkLabel(input.label);
}

function isVocabBookmarkNoteSetInput(
  value: unknown,
): value is VocabBookmarkNoteSetInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<VocabBookmarkNoteSetInput>;
  return settingsExactObjectKeys(value, [
    "itemId", "locator", "bookmarkId", "note",
  ]) && isSafeOpaqueReviewCardId(input.itemId) &&
    isVocabBookmarkLocator(input.locator) &&
    isSafeOpaqueReviewCardId(input.bookmarkId) &&
    isVocabBookmarkNote(input.note);
}

function isVocabBookmarkDeleteInput(
  value: unknown,
): value is VocabBookmarkDeleteInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<VocabBookmarkDeleteInput>;
  return settingsExactObjectKeys(value, ["itemId", "locator", "bookmarkId"]) &&
    isSafeOpaqueReviewCardId(input.itemId) &&
    isVocabBookmarkLocator(input.locator) &&
    isSafeOpaqueReviewCardId(input.bookmarkId);
}

function isVocabStudyActivityRecordInput(
  value: unknown,
): value is VocabStudyActivityRecordInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<VocabStudyActivityRecordInput>;
  const keys = [
    "kind",
    "seconds",
    ...(input.recordedAt === undefined ? [] : ["recordedAt"]),
    ...(input.timezoneOffsetMinutes === undefined
      ? []
      : ["timezoneOffsetMinutes"]),
  ];
  return settingsExactObjectKeys(value, keys) &&
    (input.kind === "read" || input.kind === "listen") &&
    typeof input.seconds === "number" && Number.isSafeInteger(input.seconds) &&
    input.seconds >= 1 && input.seconds <= VOCAB_ENGAGEMENT_MAX_SECONDS &&
    (input.recordedAt === undefined || isReceiptTimestamp(input.recordedAt)) &&
    (input.timezoneOffsetMinutes === undefined || (
      input.recordedAt !== undefined &&
      Number.isSafeInteger(input.timezoneOffsetMinutes) &&
      input.timezoneOffsetMinutes >= -1_440 &&
      input.timezoneOffsetMinutes <= 1_440
    ));
}

function isVocabPreparedStudyActivityInput(
  value: unknown,
): value is VocabPreparedStudyActivityInput {
  return isVocabStudyActivityRecordInput(value) &&
    settingsExactObjectKeys(value, ["kind", "seconds", "recordedAt"]) &&
    (value as VocabStudyActivityRecordInput).recordedAt !== undefined;
}

function isVocabBookmarkRow(value: unknown): value is Bookmark {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<Bookmark>;
  return settingsExactObjectKeys(value, VOCAB_ENGAGEMENT_BOOKMARK_ROW_KEYS) &&
    isSafeOpaqueReviewCardId(row.id) &&
    isSafeOpaqueReviewCardId(row.item_id) &&
    isVocabBookmarkLocator(row.locator) &&
    isVocabBookmarkLabel(row.label) &&
    isVocabBookmarkNote(row.note) &&
    isReceiptTimestamp(row.created_at);
}

function isVocabBookmarkExpectedState(
  value: unknown,
): value is VocabBookmarkExpectedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expected = value as Partial<VocabBookmarkExpectedState>;
  if (
    !settingsExactObjectKeys(value, [
      "generationId", "generationSequence", "item", "locator", "bookmarks",
    ]) ||
    !isVocabEngagementGenerationExpectation({
      generationId: expected.generationId,
      generationSequence: expected.generationSequence,
    }) ||
    !isVocabItemRow(expected.item) ||
    !isVocabBookmarkLocator(expected.locator) ||
    !Array.isArray(expected.bookmarks) || expected.bookmarks.length > 10_000
  ) return false;
  let previousId: string | null = null;
  for (const row of expected.bookmarks) {
    if (
      !isVocabBookmarkRow(row) || row.item_id !== expected.item.id ||
      row.locator !== expected.locator ||
      (previousId !== null && previousId >= row.id)
    ) return false;
    previousId = row.id;
  }
  return true;
}

function isVocabStudyActivityRow(
  value: unknown,
): value is VocabStudyActivityRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<VocabStudyActivityRow>;
  return settingsExactObjectKeys(value, VOCAB_ENGAGEMENT_ACTIVITY_ROW_KEYS) &&
    isSafeOpaqueReviewCardId(row.id) &&
    typeof row.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.day) &&
    settingsSafeInteger(row.read_seconds) &&
    settingsSafeInteger(row.listen_seconds) &&
    settingsSafeInteger(row.review_count) &&
    settingsSafeInteger(row.lookups) &&
    isReceiptTimestamp(row.created_at);
}

function engagementCivilDay(
  timestamp: number,
  timezoneOffsetMinutes: number,
): string | null {
  if (
    !isReceiptTimestamp(timestamp) ||
    !Number.isSafeInteger(timezoneOffsetMinutes) ||
    timezoneOffsetMinutes < -1_440 || timezoneOffsetMinutes > 1_440
  ) return null;
  const shifted = timestamp - timezoneOffsetMinutes * 60_000;
  if (!Number.isSafeInteger(shifted)) return null;
  try {
    const day = new Date(shifted).toISOString().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  } catch {
    return null;
  }
}

function isVocabEngagementWriteReceiptUnchecked(
  value: unknown,
): value is VocabEngagementWriteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<VocabEngagementWriteReceipt>;
  const common = receipt.purpose === "vocab-engagement-write" &&
    receipt.version === 1 &&
    typeof receipt.operationId === "string" &&
    VOCAB_ENGAGEMENT_OPERATION_ID_PATTERN.test(receipt.operationId) &&
    typeof receipt.generationId === "string" &&
    VOCAB_SETTINGS_GENERATION_ID_PATTERN.test(receipt.generationId) &&
    settingsSafeInteger(receipt.generationSequence) &&
    typeof receipt.projectionSha256 === "string" &&
    RECEIPT_HASH_PATTERN.test(receipt.projectionSha256) &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      VOCAB_ENGAGEMENT_MAX_JSON_BYTES;
  if (!common) return false;
  if (receipt.kind === "bookmark-create") {
    if (!settingsExactObjectKeys(value, [
      "purpose", "version", "kind", "operationId", "generationId",
      "generationSequence", "expected", "request", "target", "projectionSha256",
    ])) return false;
    const bookmarkReceipt = receipt as Partial<VocabBookmarkCreateReceipt>;
    const expected = bookmarkReceipt.expected;
    const request = bookmarkReceipt.request;
    const target = bookmarkReceipt.target;
    return isVocabBookmarkExpectedState(expected) &&
      isVocabBookmarkCreateInput(request) &&
      expected.bookmarks.length === 0 && isVocabBookmarkRow(target) &&
      VOCAB_ENGAGEMENT_BOOKMARK_ID_PATTERN.test(target.id) &&
      bookmarkReceipt.generationId === expected.generationId &&
      bookmarkReceipt.generationSequence === expected.generationSequence &&
      request.itemId === expected.item.id &&
      request.locator === expected.locator &&
      target.item_id === request.itemId && target.locator === request.locator &&
      target.label === request.label && target.note === "" &&
      target.created_at > Math.max(expected.item.created_at, expected.item.updated_at);
  }
  if (receipt.kind === "bookmark-note-set") {
    if (!settingsExactObjectKeys(value, [
      "purpose", "version", "kind", "operationId", "generationId",
      "generationSequence", "expected", "request", "target", "projectionSha256",
    ])) return false;
    const bookmarkReceipt = receipt as Partial<VocabBookmarkNoteSetReceipt>;
    const expected = bookmarkReceipt.expected;
    const request = bookmarkReceipt.request;
    const target = bookmarkReceipt.target;
    const before = expected?.bookmarks.find((row) => row.id === request?.bookmarkId);
    return isVocabBookmarkExpectedState(expected) &&
      isVocabBookmarkNoteSetInput(request) && isVocabBookmarkRow(target) &&
      !!before && bookmarkReceipt.generationId === expected.generationId &&
      bookmarkReceipt.generationSequence === expected.generationSequence &&
      request.itemId === expected.item.id && request.locator === expected.locator &&
      target.id === before.id && target.item_id === before.item_id &&
      target.locator === before.locator && target.label === before.label &&
      target.created_at === before.created_at && target.note === request.note;
  }
  if (receipt.kind === "bookmark-delete") {
    if (!settingsExactObjectKeys(value, [
      "purpose", "version", "kind", "operationId", "generationId",
      "generationSequence", "expected", "request", "target", "projectionSha256",
    ])) return false;
    const bookmarkReceipt = receipt as Partial<VocabBookmarkDeleteReceipt>;
    const expected = bookmarkReceipt.expected;
    const request = bookmarkReceipt.request;
    const target = bookmarkReceipt.target;
    const before = expected?.bookmarks.find((row) => row.id === request?.bookmarkId);
    return isVocabBookmarkExpectedState(expected) &&
      isVocabBookmarkDeleteInput(request) && isVocabBookmarkRow(target) &&
      !!before && sameSettingsProjection(before, target) &&
      bookmarkReceipt.generationId === expected.generationId &&
      bookmarkReceipt.generationSequence === expected.generationSequence &&
      request.itemId === expected.item.id && request.locator === expected.locator;
  }
  if (receipt.kind === "study-activity-record") {
    if (!settingsExactObjectKeys(value, [
      "purpose", "version", "kind", "operationId", "generationId",
      "generationSequence", "expected", "request", "target",
      "timezoneOffsetMinutes", "projectionSha256",
    ])) return false;
    const activityReceipt = receipt as Partial<VocabStudyActivityRecordReceipt>;
    const expected = activityReceipt.expected;
    const request = activityReceipt.request;
    const target = activityReceipt.target;
    const timezoneOffsetMinutes = activityReceipt.timezoneOffsetMinutes;
    return isVocabEngagementGenerationExpectation(expected) &&
      isVocabStudyActivityRow(target) &&
      VOCAB_ENGAGEMENT_ACTIVITY_ID_PATTERN.test(target.id) &&
      activityReceipt.generationId === expected.generationId &&
      activityReceipt.generationSequence === expected.generationSequence &&
      !!request && isVocabPreparedStudyActivityInput(request) &&
      target.created_at === request.recordedAt &&
      typeof timezoneOffsetMinutes === "number" &&
      Number.isSafeInteger(timezoneOffsetMinutes) &&
      timezoneOffsetMinutes >= -1_440 &&
      timezoneOffsetMinutes <= 1_440 &&
      target.review_count === 0 && target.lookups === 0 &&
      target.read_seconds === (
        request.kind === "read" ? request.seconds : 0
      ) &&
      target.listen_seconds === (
        request.kind === "listen" ? request.seconds : 0
      ) &&
      target.day === engagementCivilDay(
        target.created_at,
        timezoneOffsetMinutes,
      );
  }
  return false;
}

export function isVocabEngagementWriteReceipt(
  value: unknown,
): value is VocabEngagementWriteReceipt {
  try {
    return settingsJsonSafe(value) && isVocabEngagementWriteReceiptUnchecked(value);
  } catch {
    return false;
  }
}

async function sealVocabEngagementReceipt<
  Receipt extends VocabEngagementWriteReceipt,
>(draft: Omit<Receipt, "projectionSha256">): Promise<Receipt> {
  const projectionSha256 = await settingsSha256Hex(settingsCanonicalJson(draft));
  const receipt = { ...draft, projectionSha256 } as Receipt;
  if (!isVocabEngagementWriteReceipt(receipt)) {
    throw vocabEngagementError("invalid_input", "无法生成有效的学习记录写入回执。");
  }
  return receipt;
}

async function vocabEngagementReceiptHashIsValid(
  receipt: VocabEngagementWriteReceipt,
): Promise<boolean> {
  const { projectionSha256, ...projection } = receipt;
  return projectionSha256 ===
    await settingsSha256Hex(settingsCanonicalJson(projection));
}

function cloneVocabEngagementChecked<Result>(
  value: unknown,
  guard: (candidate: unknown) => candidate is Result,
  label: string,
): Result {
  let snapshot: unknown;
  try {
    snapshot = settingsSnapshotInput(value);
  } catch {
    throw vocabEngagementError(
      "invalid_input",
      `${label}必须是安全、有限且不超过 1 MiB 的 JSON 数据。`,
    );
  }
  if (!guard(snapshot)) {
    throw vocabEngagementError("invalid_input", `${label}格式不正确。`);
  }
  return snapshot;
}

async function readVocabEngagementGeneration(
  runtime: VocabEngagementStorageRuntime,
): Promise<VocabEngagementGenerationExpectation> {
  const current = await runtime.currentGeneration();
  const expected = {
    generationId: current?.generationId,
    generationSequence: current?.sequence,
  };
  if (!isVocabEngagementGenerationExpectation(expected)) {
    throw new Error("无法确认当前拾词数据库世代。");
  }
  return expected;
}

async function readVocabBookmarkRows(
  runtime: VocabEngagementStorageRuntime,
  itemId: string,
  locator: string,
): Promise<Bookmark[]> {
  const rows = (await runtime.query<Bookmark>(
    `SELECT id,item_id,locator,label,note,created_at FROM vocab_bookmarks
      WHERE item_id=? AND locator=? ORDER BY id`,
    [itemId, locator],
  )).rows.map((row) => ({ ...row }));
  if (rows.length > 10_000 || rows.some((row) => !isVocabBookmarkRow(row))) {
    throw new Error("书签存储集合不符合 canonical 格式。");
  }
  return rows;
}

async function readVocabBookmarkById(
  runtime: VocabEngagementStorageRuntime,
  bookmarkId: string,
): Promise<Bookmark | null> {
  const rows = (await runtime.query<Bookmark>(
    `SELECT id,item_id,locator,label,note,created_at FROM vocab_bookmarks
      WHERE id=? LIMIT 2`,
    [bookmarkId],
  )).rows;
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !isVocabBookmarkRow(rows[0])) {
    throw new Error("书签目标行不符合 canonical 格式。");
  }
  return { ...rows[0] };
}

async function readVocabBookmarkExpectedState(
  runtime: VocabEngagementStorageRuntime,
  generation: VocabEngagementGenerationExpectation,
  itemId: string,
  locator: string,
): Promise<VocabBookmarkExpectedState | null> {
  const itemRows = (await runtime.query<LibraryItem>(
    `SELECT id,kind,title,description,source,source_url,author,published_at,
      duration_ms,audio_url,status,progress,created_at,updated_at
      FROM vocab_items WHERE id=? LIMIT 2`,
    [itemId],
  )).rows;
  if (itemRows.length === 0) return null;
  if (itemRows.length !== 1 || !isVocabItemRow(itemRows[0])) {
    throw new Error("书签所属条目不符合 canonical 格式。");
  }
  const snapshot: VocabBookmarkExpectedState = {
    ...generation,
    item: { ...itemRows[0] },
    locator,
    bookmarks: await readVocabBookmarkRows(runtime, itemId, locator),
  };
  if (!isVocabBookmarkExpectedState(snapshot)) {
    throw new Error("无法构造可信的书签读取快照。");
  }
  return snapshot;
}

async function readVocabStudyActivityById(
  runtime: VocabEngagementStorageRuntime,
  activityId: string,
): Promise<VocabStudyActivityRow | null> {
  const rows = (await runtime.query<VocabStudyActivityRow>(
    `SELECT id,day,read_seconds,listen_seconds,review_count,lookups,created_at
      FROM vocab_activity WHERE id=? LIMIT 2`,
    [activityId],
  )).rows;
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !isVocabStudyActivityRow(rows[0])) {
    throw new Error("学习时间目标行不符合 canonical 格式。");
  }
  return { ...rows[0] };
}

function nextVocabEngagementTimestamp(latest: number, now: number): number {
  if (!isReceiptTimestamp(now)) {
    throw vocabEngagementError("invalid_input", "设备时间不在可接受范围。");
  }
  const timestamp = Math.max(now, latest + 1);
  if (!isReceiptTimestamp(timestamp)) {
    throw vocabEngagementError("invalid_input", "学习记录时间超出可接受范围。");
  }
  return timestamp;
}

function generatedVocabEngagementId(
  runtime: VocabEngagementStorageRuntime,
  prefix: "vocab-engagement-operation" | "bookmark" | "activity",
): string {
  const separator = prefix === "vocab-engagement-operation" ? "-" : "_";
  const id = `${prefix}${separator}${runtime.randomUUID()}`;
  const valid = prefix === "vocab-engagement-operation"
    ? VOCAB_ENGAGEMENT_OPERATION_ID_PATTERN.test(id)
    : prefix === "bookmark"
      ? VOCAB_ENGAGEMENT_BOOKMARK_ID_PATTERN.test(id)
      : VOCAB_ENGAGEMENT_ACTIVITY_ID_PATTERN.test(id);
  if (!valid) {
    throw vocabEngagementError("invalid_input", "无法生成可靠的学习记录标识。");
  }
  return id;
}

function safeVocabEngagementBroadcast(
  runtime: VocabEngagementStorageRuntime,
  reason: string,
): void {
  try {
    runtime.broadcast(reason);
  } catch {
    // Broadcast is only a refresh hint and cannot reverse a durable commit.
  }
}

function withRequiredVocabEngagementWriteLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const locks = typeof navigator === "undefined"
    ? null
    : (navigator as Navigator & { locks?: unknown }).locks ?? null;
  if (!locks) {
    throw new Error(
      "当前浏览器不支持安全的跨标签页写入锁，请使用最新版 Chrome、Edge 或 Safari。",
    );
  }
  return withVocabWriteLock(operation);
}

function vocabEngagementBroadcastReason(
  kind: VocabEngagementWriteReceipt["kind"],
): string {
  if (kind === "bookmark-create") return "bookmark-created";
  if (kind === "bookmark-note-set") return "bookmark-note-set";
  if (kind === "bookmark-delete") return "bookmark-deleted";
  return "study-time-recorded";
}

export function createVocabEngagementStorageService(
  runtime: VocabEngagementStorageRuntime = {
    withReadLock: (operation) => withVocabReadLock(operation),
    withExclusiveLock: withRequiredVocabEngagementWriteLock,
    query: async <Result extends object>(sql: string, params?: SqlValue[]) => ({
      rows: await rawQuery<Result>(sql, params),
    }),
    batch: (statements) => localDb.batch(DB, statements, { transaction: true }),
    currentGeneration: () => localDb.currentGeneration(DB),
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    timezoneOffsetMinutes: (timestamp) => new Date(timestamp).getTimezoneOffset(),
    broadcast: broadcastVocabChange,
  },
) {
  async function readLocked<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await (runtime.withReadLock
        ? runtime.withReadLock(operation)
        : runtime.withExclusiveLock(operation));
    } catch (error) {
      if (error instanceof VocabEngagementMutationError) throw error;
      throw vocabEngagementError(
        "inspect_failed",
        "暂时无法读取最新学习记录；没有开始写入。",
      );
    }
  }

  async function prepareLocked<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await runtime.withExclusiveLock(operation);
    } catch (error) {
      if (error instanceof VocabEngagementMutationError) throw error;
      throw vocabEngagementError(
        "inspect_failed",
        "暂时无法核对最新学习记录；没有开始写入。",
      );
    }
  }

  async function loadGenerationExpectation(): Promise<
    VocabEngagementGenerationExpectation
  > {
    return readLocked(async () => settingsSnapshotInput(
      await readVocabEngagementGeneration(runtime),
    ) as VocabEngagementGenerationExpectation);
  }

  async function loadBookmarkExpectedState(
    itemIdValue: string,
    locatorValue: string,
  ): Promise<VocabBookmarkExpectedState> {
    const key = cloneVocabEngagementChecked(
      { itemId: itemIdValue, locator: locatorValue, label: "" },
      isVocabBookmarkCreateInput,
      "书签读取目标",
    );
    return readLocked(async () => {
      const generation = await readVocabEngagementGeneration(runtime);
      const snapshot = await readVocabBookmarkExpectedState(
        runtime,
        generation,
        key.itemId,
        key.locator,
      );
      if (!snapshot) {
        throw vocabEngagementError("changed", "这个条目已经不存在；没有开始写入。");
      }
      return settingsSnapshotInput(snapshot) as VocabBookmarkExpectedState;
    });
  }

  async function prepareBookmarkCreate(
    inputValue: VocabBookmarkCreateInput,
    expectedValue: VocabBookmarkExpectedState,
  ): Promise<VocabBookmarkCreateReceipt> {
    // Both caller-owned values are detached before the first await.
    const input = cloneVocabEngagementChecked(
      inputValue,
      isVocabBookmarkCreateInput,
      "书签写入内容",
    );
    const expected = cloneVocabEngagementChecked(
      expectedValue,
      isVocabBookmarkExpectedState,
      "书签读取快照",
    );
    if (
      input.itemId !== expected.item.id ||
      input.locator !== expected.locator ||
      expected.bookmarks.some((bookmark) => bookmark.locator !== input.locator)
    ) {
      throw vocabEngagementError("invalid_input", "书签内容与读取快照不属于同一位置。");
    }
    return prepareLocked(async () => {
      const generation = await readVocabEngagementGeneration(runtime);
      if (!sameSettingsProjection(generation, {
        generationId: expected.generationId,
        generationSequence: expected.generationSequence,
      })) {
        throw vocabEngagementError("changed", "书签所在数据库已经更换；没有准备写入。");
      }
      const current = await readVocabBookmarkExpectedState(
        runtime,
        generation,
        input.itemId,
        input.locator,
      );
      if (!current || !sameSettingsProjection(current, expected)) {
        throw vocabEngagementError("changed", "书签位置已在别处变化；没有准备写入。");
      }
      if (current.bookmarks.length !== 0) {
        throw vocabEngagementError("changed", "这个位置已经有书签；没有准备重复写入。");
      }
      const operationId = generatedVocabEngagementId(
        runtime,
        "vocab-engagement-operation",
      );
      const bookmarkId = generatedVocabEngagementId(runtime, "bookmark");
      if (await readVocabBookmarkById(runtime, bookmarkId)) {
        throw vocabEngagementError("changed", "生成的书签标识已经被占用；没有准备写入。");
      }
      const createdAt = nextVocabEngagementTimestamp(
        Math.max(expected.item.created_at, expected.item.updated_at),
        runtime.now(),
      );
      return sealVocabEngagementReceipt<VocabBookmarkCreateReceipt>({
        purpose: "vocab-engagement-write",
        version: 1,
        kind: "bookmark-create",
        operationId,
        ...generation,
        expected,
        request: input,
        target: {
          id: bookmarkId,
          item_id: input.itemId,
          locator: input.locator,
          label: input.label,
          note: "",
          created_at: createdAt,
        },
      });
    });
  }

  async function prepareBookmarkNoteSet(
    inputValue: VocabBookmarkNoteSetInput,
    expectedValue: VocabBookmarkExpectedState,
  ): Promise<VocabBookmarkNoteSetReceipt> {
    const input = cloneVocabEngagementChecked(
      inputValue,
      isVocabBookmarkNoteSetInput,
      "书签笔记写入内容",
    );
    const expected = cloneVocabEngagementChecked(
      expectedValue,
      isVocabBookmarkExpectedState,
      "书签读取快照",
    );
    if (input.itemId !== expected.item.id || input.locator !== expected.locator) {
      throw vocabEngagementError("invalid_input", "书签笔记与读取快照不属于同一位置。");
    }
    const before = expected.bookmarks.find((row) => row.id === input.bookmarkId);
    if (!before) {
      throw vocabEngagementError("invalid_input", "书签笔记目标不在读取快照中。");
    }
    if (before.note === input.note) {
      throw vocabEngagementError("invalid_input", "书签笔记没有变化。");
    }
    return prepareLocked(async () => {
      const generation = await readVocabEngagementGeneration(runtime);
      if (!sameSettingsProjection(generation, {
        generationId: expected.generationId,
        generationSequence: expected.generationSequence,
      })) {
        throw vocabEngagementError("changed", "书签所在数据库已经更换；没有准备写入。");
      }
      const current = await readVocabBookmarkExpectedState(
        runtime, generation, input.itemId, input.locator,
      );
      if (!current || !sameSettingsProjection(current, expected)) {
        throw vocabEngagementError("changed", "书签已经在别处变化；没有准备写入笔记。");
      }
      return sealVocabEngagementReceipt<VocabBookmarkNoteSetReceipt>({
        purpose: "vocab-engagement-write",
        version: 1,
        kind: "bookmark-note-set",
        operationId: generatedVocabEngagementId(
          runtime, "vocab-engagement-operation",
        ),
        ...generation,
        expected,
        request: input,
        target: { ...before, note: input.note },
      });
    });
  }

  async function prepareBookmarkDelete(
    inputValue: VocabBookmarkDeleteInput,
    expectedValue: VocabBookmarkExpectedState,
  ): Promise<VocabBookmarkDeleteReceipt> {
    const input = cloneVocabEngagementChecked(
      inputValue,
      isVocabBookmarkDeleteInput,
      "书签删除内容",
    );
    const expected = cloneVocabEngagementChecked(
      expectedValue,
      isVocabBookmarkExpectedState,
      "书签读取快照",
    );
    if (input.itemId !== expected.item.id || input.locator !== expected.locator) {
      throw vocabEngagementError("invalid_input", "待删除书签与读取快照不属于同一位置。");
    }
    const before = expected.bookmarks.find((row) => row.id === input.bookmarkId);
    if (!before) {
      throw vocabEngagementError("invalid_input", "待删除书签不在读取快照中。");
    }
    return prepareLocked(async () => {
      const generation = await readVocabEngagementGeneration(runtime);
      if (!sameSettingsProjection(generation, {
        generationId: expected.generationId,
        generationSequence: expected.generationSequence,
      })) {
        throw vocabEngagementError("changed", "书签所在数据库已经更换；没有准备删除。");
      }
      const current = await readVocabBookmarkExpectedState(
        runtime, generation, input.itemId, input.locator,
      );
      if (!current || !sameSettingsProjection(current, expected)) {
        throw vocabEngagementError("changed", "书签已经在别处变化；没有准备删除。");
      }
      return sealVocabEngagementReceipt<VocabBookmarkDeleteReceipt>({
        purpose: "vocab-engagement-write",
        version: 1,
        kind: "bookmark-delete",
        operationId: generatedVocabEngagementId(
          runtime, "vocab-engagement-operation",
        ),
        ...generation,
        expected,
        request: input,
        target: before,
      });
    });
  }

  async function prepareStudyActivityRecord(
    inputValue: VocabStudyActivityRecordInput,
    expectedValue: VocabEngagementGenerationExpectation,
  ): Promise<VocabStudyActivityRecordReceipt> {
    // The logical time slice and displayed generation are detached before await.
    const input = cloneVocabEngagementChecked(
      inputValue,
      isVocabStudyActivityRecordInput,
      "学习时间片",
    );
    const expected = cloneVocabEngagementChecked(
      expectedValue,
      isVocabEngagementGenerationExpectation,
      "学习时间片数据库世代",
    );
    return prepareLocked(async () => {
      const generation = await readVocabEngagementGeneration(runtime);
      if (!sameSettingsProjection(generation, expected)) {
        throw vocabEngagementError(
          "changed",
          "学习时间片所属数据库已经更换；没有准备写入。",
        );
      }
      const operationId = generatedVocabEngagementId(
        runtime,
        "vocab-engagement-operation",
      );
      const activityId = generatedVocabEngagementId(runtime, "activity");
      if (await readVocabStudyActivityById(runtime, activityId)) {
        throw vocabEngagementError("changed", "生成的活动标识已经被占用；没有准备写入。");
      }
      const createdAt = input.recordedAt ?? runtime.now();
      if (!isReceiptTimestamp(createdAt)) {
        throw vocabEngagementError("invalid_input", "学习时间片的记录时间不在可接受范围。");
      }
      const timezoneOffsetMinutes = input.timezoneOffsetMinutes ?? (
        runtime.timezoneOffsetMinutes ??
        ((timestamp: number) => new Date(timestamp).getTimezoneOffset())
      )(createdAt);
      const day = engagementCivilDay(createdAt, timezoneOffsetMinutes);
      if (day === null) {
        throw vocabEngagementError("invalid_input", "无法冻结学习时间片的本地日期。");
      }
      return sealVocabEngagementReceipt<VocabStudyActivityRecordReceipt>({
        purpose: "vocab-engagement-write",
        version: 1,
        kind: "study-activity-record",
        operationId,
        ...generation,
        expected,
        request: {
          kind: input.kind,
          seconds: input.seconds,
          recordedAt: createdAt,
        },
        timezoneOffsetMinutes,
        target: {
          id: activityId,
          day,
          read_seconds: input.kind === "read" ? input.seconds : 0,
          listen_seconds: input.kind === "listen" ? input.seconds : 0,
          review_count: 0,
          lookups: 0,
          created_at: createdAt,
        },
      });
    });
  }

  async function receiptStateUnlocked(
    receipt: VocabEngagementWriteReceipt,
  ): Promise<Exclude<
    VocabEngagementWriteInspection,
    "still_unknown" | "invalid_receipt"
  >> {
    const generation = await readVocabEngagementGeneration(runtime);
    if (
      generation.generationId !== receipt.generationId ||
      generation.generationSequence !== receipt.generationSequence
    ) return "changed";
    if (receipt.kind === "bookmark-create") {
      const [current, targetById] = await Promise.all([
        readVocabBookmarkExpectedState(
          runtime,
          generation,
          receipt.target.item_id,
          receipt.target.locator,
        ),
        readVocabBookmarkById(runtime, receipt.target.id),
      ]);
      if (!current || !sameSettingsProjection(current.item, receipt.expected.item)) {
        return "changed";
      }
      if (
        targetById && sameSettingsProjection(targetById, receipt.target) &&
        current.bookmarks.length === 1 &&
        sameSettingsProjection(current.bookmarks[0], receipt.target)
      ) return "exact_saved";
      return targetById === null &&
          sameSettingsProjection(current, receipt.expected)
        ? "expected"
        : "changed";
    }
    if (receipt.kind === "bookmark-note-set") {
      const [current, targetById] = await Promise.all([
        readVocabBookmarkExpectedState(
          runtime, generation, receipt.target.item_id, receipt.target.locator,
        ),
        readVocabBookmarkById(runtime, receipt.target.id),
      ]);
      if (!current || !sameSettingsProjection(current.item, receipt.expected.item)) {
        return "changed";
      }
      const afterRows = receipt.expected.bookmarks.map((row) =>
        row.id === receipt.target.id ? receipt.target : row
      );
      if (targetById && sameSettingsProjection(targetById, receipt.target) &&
          sameSettingsProjection(current.bookmarks, afterRows)) {
        return "exact_saved";
      }
      return sameSettingsProjection(current, receipt.expected)
        ? "expected"
        : "changed";
    }
    if (receipt.kind === "bookmark-delete") {
      const [current, targetById] = await Promise.all([
        readVocabBookmarkExpectedState(
          runtime, generation, receipt.target.item_id, receipt.target.locator,
        ),
        readVocabBookmarkById(runtime, receipt.target.id),
      ]);
      if (!current || !sameSettingsProjection(current.item, receipt.expected.item)) {
        return "changed";
      }
      const afterRows = receipt.expected.bookmarks.filter((row) =>
        row.id !== receipt.target.id
      );
      if (targetById === null &&
          sameSettingsProjection(current.bookmarks, afterRows)) {
        return "exact_saved";
      }
      return targetById && sameSettingsProjection(targetById, receipt.target) &&
          sameSettingsProjection(current, receipt.expected)
        ? "expected"
        : "changed";
    }
    const target = await readVocabStudyActivityById(runtime, receipt.target.id);
    if (target && sameSettingsProjection(target, receipt.target)) {
      return "exact_saved";
    }
    // No product path deletes generated activity rows inside one generation.
    // Therefore absence is the retryable pre-state. A same-generation direct-SQL
    // insert-then-delete is intentionally outside this marker-free contract.
    return target === null ? "expected" : "changed";
  }

  function bookmarkSetPredicate(
    expected: VocabBookmarkExpectedState,
  ): Readonly<{ sql: string; params: SqlValue[] }> {
    const fragments = [
      `(SELECT COUNT(*) FROM vocab_bookmarks WHERE item_id IS ? AND locator IS ?)=?`,
      ...expected.bookmarks.map(() => `EXISTS(SELECT 1 FROM vocab_bookmarks
        WHERE id IS ? AND item_id IS ? AND locator IS ? AND label IS ?
          AND note IS ? AND created_at IS ?)`),
    ];
    const params: SqlValue[] = [
      expected.item.id,
      expected.locator,
      expected.bookmarks.length,
    ];
    for (const row of expected.bookmarks) {
      params.push(
        row.id,
        row.item_id,
        row.locator,
        row.label,
        row.note,
        row.created_at,
      );
    }
    return { sql: fragments.map((fragment) => `(${fragment})`).join(" AND "), params };
  }

  function engagementItemRowPredicate(item: LibraryItem): Readonly<{
    sql: string;
    params: SqlValue[];
  }> {
    return {
      sql: `EXISTS(SELECT 1 FROM vocab_items WHERE id IS ? AND kind IS ?
        AND title IS ? AND description IS ? AND source IS ? AND source_url IS ?
        AND author IS ? AND published_at IS ? AND duration_ms IS ?
        AND audio_url IS ? AND status IS ? AND progress IS ?
        AND created_at IS ? AND updated_at IS ?)`,
      params: [
        item.id,
        item.kind,
        item.title,
        item.description,
        item.source,
        item.source_url,
        item.author,
        item.published_at,
        item.duration_ms,
        item.audio_url,
        item.status,
        item.progress,
        item.created_at,
        item.updated_at,
      ],
    };
  }

  function bookmarkReceiptStatements(
    receipt: VocabBookmarkCreateReceipt,
  ): Statement[] {
    const item = engagementItemRowPredicate(receipt.expected.item);
    const bookmarks = bookmarkSetPredicate(receipt.expected);
    return [
      {
        sql: `INSERT INTO vocab_bookmarks(id,item_id,locator,label,note,created_at)
          SELECT '__vocab_engagement_cas_abort__',NULL,'','','',0
          WHERE NOT ((${item.sql}) AND (${bookmarks.sql}) AND
            NOT EXISTS(SELECT 1 FROM vocab_bookmarks WHERE id IS ?))`,
        params: [...item.params, ...bookmarks.params, receipt.target.id],
      },
      {
        sql: `INSERT INTO vocab_bookmarks(
          id,item_id,locator,label,note,created_at
        ) VALUES(?,?,?,?,?,?)`,
        params: [
          receipt.target.id,
          receipt.target.item_id,
          receipt.target.locator,
          receipt.target.label,
          receipt.target.note,
          receipt.target.created_at,
        ],
      },
    ];
  }

  function bookmarkMutationReceiptStatements(
    receipt: VocabBookmarkNoteSetReceipt | VocabBookmarkDeleteReceipt,
  ): Statement[] {
    const item = engagementItemRowPredicate(receipt.expected.item);
    const bookmarks = bookmarkSetPredicate(receipt.expected);
    const before = receipt.expected.bookmarks.find((row) =>
      row.id === receipt.target.id
    );
    if (!before) {
      throw vocabEngagementError(
        "invalid_receipt",
        "书签变更回执没有完整的旧行；没有改动资料。",
        receipt,
      );
    }
    const guard: Statement = {
      sql: `INSERT INTO vocab_bookmarks(id,item_id,locator,label,note,created_at)
        SELECT '__vocab_engagement_cas_abort__',NULL,'','','',0
        WHERE NOT ((${item.sql}) AND (${bookmarks.sql}))`,
      params: [...item.params, ...bookmarks.params],
    };
    if (receipt.kind === "bookmark-note-set") {
      return [
        guard,
        {
          sql: `UPDATE vocab_bookmarks SET note=? WHERE id IS ? AND item_id IS ?
            AND locator IS ? AND label IS ? AND note IS ? AND created_at IS ?`,
          params: [
            receipt.target.note,
            before.id,
            before.item_id,
            before.locator,
            before.label,
            before.note,
            before.created_at,
          ],
        },
      ];
    }
    return [
      guard,
      {
        sql: `DELETE FROM vocab_bookmarks WHERE id IS ? AND item_id IS ?
          AND locator IS ? AND label IS ? AND note IS ? AND created_at IS ?`,
        params: [
          before.id,
          before.item_id,
          before.locator,
          before.label,
          before.note,
          before.created_at,
        ],
      },
    ];
  }

  function activityReceiptStatements(
    receipt: VocabStudyActivityRecordReceipt,
  ): Statement[] {
    return [
      {
        sql: `INSERT INTO vocab_activity(
          id,day,read_seconds,listen_seconds,review_count,lookups,created_at
        ) SELECT '__vocab_engagement_cas_abort__','',NULL,0,0,0,0
          WHERE EXISTS(SELECT 1 FROM vocab_activity WHERE id IS ?)`,
        params: [receipt.target.id],
      },
      {
        sql: `INSERT INTO vocab_activity(
          id,day,read_seconds,listen_seconds,review_count,lookups,created_at
        ) VALUES(?,?,?,?,?,?,?)`,
        params: [
          receipt.target.id,
          receipt.target.day,
          receipt.target.read_seconds,
          receipt.target.listen_seconds,
          receipt.target.review_count,
          receipt.target.lookups,
          receipt.target.created_at,
        ],
      },
    ];
  }

  function receiptStatements(receipt: VocabEngagementWriteReceipt): Statement[] {
    if (receipt.kind === "bookmark-create") {
      return bookmarkReceiptStatements(receipt);
    }
    if (receipt.kind === "bookmark-note-set" || receipt.kind === "bookmark-delete") {
      return bookmarkMutationReceiptStatements(receipt);
    }
    return activityReceiptStatements(receipt);
  }

  async function inspectWrite(value: unknown): Promise<VocabEngagementWriteInspection> {
    let receipt: VocabEngagementWriteReceipt;
    try {
      const stable = settingsSnapshotInput(value);
      if (!isVocabEngagementWriteReceipt(stable)) return "invalid_receipt";
      receipt = stable;
      if (!await vocabEngagementReceiptHashIsValid(receipt)) {
        return "invalid_receipt";
      }
    } catch {
      return "invalid_receipt";
    }
    try {
      return await runtime.withExclusiveLock(() => receiptStateUnlocked(receipt));
    } catch {
      return "still_unknown";
    }
  }

  async function commitWrite(value: unknown): Promise<VocabEngagementWriteResult> {
    let receipt: VocabEngagementWriteReceipt;
    try {
      const stable = settingsSnapshotInput(value);
      if (!isVocabEngagementWriteReceipt(stable)) {
        throw vocabEngagementError(
          "invalid_receipt",
          "学习记录写入回执无效；没有改动资料。",
        );
      }
      receipt = stable;
      if (!await vocabEngagementReceiptHashIsValid(receipt)) {
        throw vocabEngagementError(
          "invalid_receipt",
          "学习记录写入回执无法验证；没有改动资料。",
        );
      }
    } catch (error) {
      if (
        error instanceof VocabEngagementMutationError &&
        error.code === "invalid_receipt"
      ) throw error;
      throw vocabEngagementError(
        "invalid_receipt",
        "学习记录写入回执无法验证；没有改动资料。",
      );
    }
    const entityId = receipt.target.id;
    const createdAt = receipt.target.created_at;
    try {
      return await runtime.withExclusiveLock(async () => {
        const before = await receiptStateUnlocked(receipt);
        if (before === "exact_saved") {
          safeVocabEngagementBroadcast(
            runtime,
            vocabEngagementBroadcastReason(receipt.kind),
          );
          return { outcome: "already_saved", receipt, entityId, createdAt };
        }
        if (before === "changed") {
          return { outcome: "changed", receipt, entityId, retryable: false };
        }
        try {
          await runtime.batch(receiptStatements(receipt));
        } catch {
          // The transaction may have committed even though its response was lost.
        }
        const after = await receiptStateUnlocked(receipt);
        if (after === "exact_saved") {
          safeVocabEngagementBroadcast(
            runtime,
            vocabEngagementBroadcastReason(receipt.kind),
          );
          return { outcome: "saved", receipt, entityId, createdAt };
        }
        if (after === "expected") {
          throw vocabEngagementError(
            "write_failed",
            "这次学习记录确定没有写入；保留原回执后可以重试。",
            receipt,
          );
        }
        return { outcome: "changed", receipt, entityId, retryable: false };
      });
    } catch (error) {
      if (error instanceof VocabEngagementMutationError) throw error;
      return {
        outcome: "outcome_uncertain",
        receipt,
        entityId,
        retryable: true,
      };
    }
  }

  return {
    loadVocabEngagementGenerationExpectation: loadGenerationExpectation,
    loadVocabBookmarkExpectedState: loadBookmarkExpectedState,
    prepareVocabBookmarkCreate: prepareBookmarkCreate,
    prepareVocabBookmarkNoteSet: prepareBookmarkNoteSet,
    prepareVocabBookmarkDelete: prepareBookmarkDelete,
    prepareVocabStudyActivityRecord: prepareStudyActivityRecord,
    inspectVocabEngagementWrite: inspectWrite,
    commitVocabEngagementWrite: commitWrite,
  } as const;
}

const defaultVocabEngagementStorageService =
  createVocabEngagementStorageService();

export const loadVocabEngagementGenerationExpectation =
  defaultVocabEngagementStorageService.loadVocabEngagementGenerationExpectation;
export const loadVocabBookmarkExpectedState =
  defaultVocabEngagementStorageService.loadVocabBookmarkExpectedState;
export const prepareVocabBookmarkCreate =
  defaultVocabEngagementStorageService.prepareVocabBookmarkCreate;
export const prepareVocabBookmarkNoteSet =
  defaultVocabEngagementStorageService.prepareVocabBookmarkNoteSet;
export const prepareVocabBookmarkDelete =
  defaultVocabEngagementStorageService.prepareVocabBookmarkDelete;
export const prepareVocabStudyActivityRecord =
  defaultVocabEngagementStorageService.prepareVocabStudyActivityRecord;
export const inspectVocabEngagementWrite =
  defaultVocabEngagementStorageService.inspectVocabEngagementWrite;
export const commitVocabEngagementWrite =
  defaultVocabEngagementStorageService.commitVocabEngagementWrite;

export async function saveSettings(settings: VocabSettings): Promise<void> {
  await withWrite("settings-saved", async () => {
    const now = Date.now();
    const statements = Object.entries(settings).map(([key, value]) => ({
      sql: `INSERT INTO vocab_settings(key,value,updated_at) VALUES(?,?,?)
            ON CONFLICT(key) DO UPDATE SET
              value=excluded.value,updated_at=excluded.updated_at`,
      params: [key, String(value), now],
    }));
    await rawBatch(statements);
  });
}

export async function recordStudySeconds(
  _itemId: string,
  kind: "read" | "listen",
  seconds: number,
): Promise<void> {
  if (seconds < 1) return;
  await withWrite("study-time-recorded", async () => {
    const now = Date.now();
    await rawBatch([{
      sql: `INSERT INTO vocab_activity(
        id,day,read_seconds,listen_seconds,review_count,lookups,created_at
      ) VALUES (?,?,?,?,?,?,?)`,
      params: [
        uid("activity"),
        localDayKey(now),
        kind === "read" ? seconds : 0,
        kind === "listen" ? seconds : 0,
        0,
        0,
        now,
      ],
    }]);
  });
}

export function getDueCards(
  cards: ReviewCard[],
  now = Date.now(),
): ReviewCard[] {
  return cards.filter((card) =>
    card.due_at <= now &&
    card.state !== "suspended" &&
    card.queue_eligible !== false
  );
}

export function findItem(
  items: LibraryItem[],
  id: string | null,
): LibraryItem | null {
  return id ? items.find((item) => item.id === id) ?? null : null;
}
