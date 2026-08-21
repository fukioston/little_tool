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
         WHERE c.state!='suspended' AND l.status NOT IN ('known','ignored')
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

function storedReviewState(card: StoredReviewCard) {
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

function parseStoredReviewState(
  value: string,
): Omit<StoredReviewCard, "id"> {
  let parsed: Partial<Omit<StoredReviewCard, "id">>;
  try {
    parsed = JSON.parse(value) as Partial<Omit<StoredReviewCard, "id">>;
  } catch {
    throw new Error("复习撤销记录无法验证。");
  }
  const validStates: readonly ReviewCard["state"][] = [
    "new",
    "learning",
    "review",
    "relearning",
    "suspended",
  ];
  if (
    !parsed ||
    typeof parsed.state !== "string" ||
    !validStates.includes(parsed.state as ReviewCard["state"]) ||
    typeof parsed.due_at !== "number" ||
    typeof parsed.interval_days !== "number" ||
    typeof parsed.ease !== "number" ||
    typeof parsed.reps !== "number" ||
    typeof parsed.lapses !== "number"
  ) {
    throw new Error("复习撤销记录无法验证。");
  }
  return {
    state: parsed.state as ReviewCard["state"],
    due_at: parsed.due_at,
    interval_days: parsed.interval_days,
    ease: parsed.ease,
    reps: parsed.reps,
    lapses: parsed.lapses,
    last_review_at: typeof parsed.last_review_at === "number"
      ? parsed.last_review_at
      : null,
    algorithm_version: typeof parsed.algorithm_version === "number"
      ? parsed.algorithm_version
      : 1,
    suspended_from_state: parsed.suspended_from_state ?? null,
    suspended_reason: typeof parsed.suspended_reason === "string"
      ? parsed.suspended_reason
      : null,
    updated_at: typeof parsed.updated_at === "number" ? parsed.updated_at : 0,
  };
}

export async function rateReview(
  card: ReviewCard,
  rating: ReviewRating,
): Promise<string> {
  return withWrite("review-rated", async () => {
    const current = (await rawQuery<StoredReviewCard>(
      `SELECT id,state,due_at,interval_days,ease,reps,lapses,last_review_at,
              algorithm_version,suspended_from_state,suspended_reason,updated_at
       FROM vocab_review_cards WHERE id=?`,
      [card.id],
    ))[0];
    if (
      !current ||
      current.state === "suspended" ||
      current.updated_at !== card.updated_at
    ) {
      throw new Error("这张复习卡已发生变化，请刷新后重试。");
    }
    const now = Date.now();
    const changedAt = Math.max(now, current.updated_at + 1);
    const schedule = scheduleReviewV2(current, rating, now);
    const eventId = uid("review");
    const activityId = uid("activity");
    const after = {
      ...schedule,
      suspended_from_state: null,
      suspended_reason: null,
      updated_at: changedAt,
    };
    await rawBatch([
      {
        sql: `UPDATE vocab_review_cards
          SET state=?,due_at=?,interval_days=?,ease=?,reps=?,lapses=?,
              last_review_at=?,algorithm_version=?,suspended_from_state=NULL,
              suspended_reason=NULL,updated_at=?
          WHERE id=?`,
        params: [
          schedule.state,
          schedule.due_at,
          schedule.interval_days,
          schedule.ease,
          schedule.reps,
          schedule.lapses,
          schedule.last_review_at,
          schedule.algorithm_version,
          changedAt,
          current.id,
        ],
      },
      {
        sql: `INSERT INTO vocab_activity(
          id,day,read_seconds,listen_seconds,review_count,lookups,created_at
        ) VALUES (?,?,?,?,?,?,?)`,
        params: [activityId, localDayKey(now), 0, 0, 1, 0, now],
      },
      {
        sql: `INSERT INTO vocab_review_events(
          id,card_id,rating,reviewed_at,before_json,after_json,undone_at,activity_id
        ) VALUES (?,?,?,?,?,?,?,?)`,
        params: [
          eventId,
          current.id,
          rating,
          now,
          JSON.stringify(storedReviewState(current)),
          JSON.stringify(after),
          null,
          activityId,
        ],
      },
    ]);
    return eventId;
  });
}

export async function undoReview(eventId: string): Promise<void> {
  await withWrite("review-undone", async () => {
    const event = (await rawQuery<{
      card_id: string;
      before_json: string;
      activity_id: string | null;
    }>(
      `SELECT e.card_id,e.before_json,e.activity_id
       FROM vocab_review_events e
       WHERE e.id=? AND e.undone_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM vocab_review_events later
           WHERE later.card_id=e.card_id AND later.undone_at IS NULL
             AND (
               later.reviewed_at>e.reviewed_at OR
               (later.reviewed_at=e.reviewed_at AND later.rowid>e.rowid)
             )
         )`,
      [eventId],
    ))[0];
    if (!event) {
      throw new Error("只能撤销这张卡最近一次尚未撤销的评分。");
    }
    const before = parseStoredReviewState(event.before_json);
    const statements: Statement[] = [
      {
        sql: `UPDATE vocab_review_cards
          SET state=?,due_at=?,interval_days=?,ease=?,reps=?,lapses=?,
              last_review_at=?,algorithm_version=?,suspended_from_state=?,
              suspended_reason=?,updated_at=?
          WHERE id=?`,
        params: [
          before.state,
          before.due_at,
          before.interval_days,
          before.ease,
          before.reps,
          before.lapses,
          before.last_review_at,
          before.algorithm_version,
          before.suspended_from_state,
          before.suspended_reason,
          before.updated_at,
          event.card_id,
        ],
      },
      {
        sql: "UPDATE vocab_review_events SET undone_at=? WHERE id=?",
        params: [Date.now(), eventId],
      },
    ];
    if (event.activity_id) {
      statements.push({
        sql: "DELETE FROM vocab_activity WHERE id=? AND review_count=1",
        params: [event.activity_id],
      });
    }
    await rawBatch(statements);
  });
}

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
  itemId: string,
  kind: "read" | "listen",
  seconds: number,
): Promise<void> {
  if (seconds < 1) return;
  await withWrite("study-time-recorded", async () => {
    const now = Date.now();
    await rawBatch([
      {
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
      },
      {
        sql: "UPDATE vocab_items SET updated_at=? WHERE id=?",
        params: [now, itemId],
      },
    ]);
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
