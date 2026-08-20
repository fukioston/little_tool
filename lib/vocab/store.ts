import { localDb } from "@/lib/local-db/client";
import { uid } from "./content";
import type {
  AiExplanation,
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
type SqlValue = string | number | bigint | boolean | null | Uint8Array;
type Statement = { sql: string; params?: SqlValue[] | Record<string, SqlValue> };

const schema = [
  `CREATE TABLE IF NOT EXISTS vocab_items (
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
  )`,
  `CREATE TABLE IF NOT EXISTS vocab_blocks (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES vocab_items(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'paragraph',
    text TEXT NOT NULL,
    UNIQUE(item_id, ordinal)
  )`,
  `CREATE TABLE IF NOT EXISTS vocab_transcript_segments (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES vocab_items(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    speaker TEXT,
    UNIQUE(item_id, ordinal)
  )`,
  `CREATE TABLE IF NOT EXISTS vocab_lexemes (
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
  )`,
  `CREATE TABLE IF NOT EXISTS vocab_occurrences (
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
  )`,
  `CREATE TABLE IF NOT EXISTS vocab_review_cards (
    id TEXT PRIMARY KEY,
    lexeme_id TEXT NOT NULL UNIQUE REFERENCES vocab_lexemes(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'new',
    due_at INTEGER NOT NULL,
    interval_days REAL NOT NULL DEFAULT 0,
    ease REAL NOT NULL DEFAULT 2.5,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    last_review_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS vocab_review_events (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES vocab_review_cards(id) ON DELETE CASCADE,
    rating TEXT NOT NULL,
    reviewed_at INTEGER NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    undone_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS vocab_bookmarks (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES vocab_items(id) ON DELETE CASCADE,
    locator TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vocab_activity (
    id TEXT PRIMARY KEY,
    day TEXT NOT NULL,
    read_seconds INTEGER NOT NULL DEFAULT 0,
    listen_seconds INTEGER NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    lookups INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vocab_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vocab_imports (
    id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    item_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_vocab_items_kind_updated ON vocab_items(kind, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_vocab_blocks_item_ordinal ON vocab_blocks(item_id, ordinal)",
  "CREATE INDEX IF NOT EXISTS idx_vocab_segments_item_start ON vocab_transcript_segments(item_id, start_ms)",
  "CREATE INDEX IF NOT EXISTS idx_vocab_occurrences_lexeme ON vocab_occurrences(lexeme_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_vocab_cards_due ON vocab_review_cards(due_at, state)",
];

const seedStatements = (now: number): Statement[] => {
  const day = new Date(now).toISOString().slice(0, 10);
  const prior = new Date(now - 86400000).toISOString().slice(0, 10);
  const articleId = "seed_article_deliberate";
  const podcastId = "seed_podcast_market";
  const blocks = [
    ["seed_block_1", 0, "paragraph", "Just after sunrise, the streets have not fully awakened. Steam drifts from a bakery doorway, a cyclist passes beneath the plane trees, and the city seems to lower its voice for a moment."],
    ["seed_block_2", 1, "heading", "Making room for attention"],
    ["seed_block_3", 2, "paragraph", "We have learned to treat speed as a virtue. Messages should be answered instantly, journeys compressed, and even rest is expected to produce a measurable result. Yet the moments worth remembering rarely cooperate with that rhythm."],
    ["seed_block_4", 3, "paragraph", "Moving slowly is not the same as abandoning progress. It can be a deliberate choice: looking once more before deciding, exercising restraint before speaking, and allowing an experience to acquire a lingering resonance."],
    ["seed_block_5", 4, "quote", "When every minute is assigned a purpose, attention loses the freedom to linger."],
    ["seed_block_6", 5, "paragraph", "In the afternoon I walked through an old neighborhood without opening a map. A repairman arranged his tools in a careful row, a cat narrowed its eyes in a window, and a grocer removed one yellow leaf from a bundle of greens. Fleeting details made the city tangible again."],
    ["seed_block_7", 6, "heading", "A more discerning pace"],
    ["seed_block_8", 7, "paragraph", "Perhaps the goal is not to move slowly all the time, but to recover the ability to change pace: to know when quick action matters and when an unhurried moment deserves our full attention."],
  ] as const;
  const segments = [
    [0, 0, 6200, "Today we are listening to a neighborhood market at six in the morning."],
    [1, 6200, 13500, "Metal shutters rise one by one, and the first vegetables still carry the coolness of the night."],
    [2, 13500, 21800, "Vendors arrange their stalls while finishing stories they began the day before."],
    [3, 21800, 30200, "The bustle is not merely noise; it has the familiar rhythm of a community waking up."],
    [4, 30200, 39200, "One customer bargains over a bunch of greens, while another stops only to ask how someone has been."],
    [5, 39200, 48000, "By the time sunlight crosses the rooftops, the market has already staged the city's earliest reunion."],
  ] as const;

  return [
    { sql: "INSERT INTO vocab_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params: [articleId, "article", "The Quiet Value of Moving Slowly", "Speed is not the only measure of progress. An aimless walk reveals the details that urgency makes easy to miss.", "Field Notes", null, "Mara Ellison", "2026-08-18", 0, null, "in_progress", 0.46, now - 7200000, now - 900000] },
    { sql: "INSERT INTO vocab_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params: [podcastId, "podcast", "City Sounds: A Market Before Dawn", "A short field recording about the voices and rituals that wake a neighborhood.", "The Listening Room", null, "Noah Reed", "2026-08-16", 48000, null, "in_progress", 0.31, now - 172800000, now - 3600000] },
    ...blocks.map(([id, ordinal, kind, text]) => ({ sql: "INSERT INTO vocab_blocks VALUES (?,?,?,?,?)", params: [id, articleId, ordinal, kind, text] })),
    ...segments.map(([ordinal, start, end, text]) => ({ sql: "INSERT INTO vocab_transcript_segments VALUES (?,?,?,?,?,?,?)", params: [`seed_segment_${ordinal}`, podcastId, ordinal, start, end, text, null] })),
    { sql: "INSERT INTO vocab_lexemes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", params: ["seed_lexeme_deliberate", "deliberate", "deliberate", "/dɪˈlɪbərət/", "intentional and carefully considered", "Chosen consciously rather than done by accident or in a hurry.", "深思熟虑的；从容而有意识的。", "learning", 1, "Useful for describing careful choices.", 3, now - 604800000, now - 86400000] },
    { sql: "INSERT INTO vocab_lexemes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", params: ["seed_lexeme_restraint", "restraint", "restraint", "/rɪˈstreɪnt/", "self-control; moderation", "The ability to hold back an impulse, action, or expression.", "克制；节制；约束力。", "learning", 0, "", 2, now - 432000000, now - 172800000] },
    { sql: "INSERT INTO vocab_lexemes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", params: ["seed_lexeme_bustle", "bustle", "bustle", "/ˈbʌsəl/", "lively, busy activity", "Energetic movement and activity involving many people.", "熙熙攘攘的活动；忙碌景象。", "saved", 0, "", 1, now - 172800000, now - 172800000] },
    { sql: "INSERT INTO vocab_lexemes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", params: ["seed_lexeme_fleeting", "fleeting", "fleeting", "/ˈfliːtɪŋ/", "lasting for only a short time", "Passing so quickly that it can easily be missed.", "短暂的；转瞬即逝的。", "learning", 1, "", 2, now - 345600000, now - 86400000] },
    { sql: "INSERT INTO vocab_occurrences VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params: ["seed_occ_deliberate", "seed_lexeme_deliberate", articleId, "seed_block_4", null, "deliberate", "", blocks[3][3], "", 63, 73, null, "", "", now - 604800000] },
    { sql: "INSERT INTO vocab_occurrences VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params: ["seed_occ_restraint", "seed_lexeme_restraint", articleId, "seed_block_4", null, "restraint", "", blocks[3][3], "", 113, 122, null, "", "", now - 432000000] },
    { sql: "INSERT INTO vocab_occurrences VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params: ["seed_occ_fleeting", "seed_lexeme_fleeting", articleId, "seed_block_6", null, "Fleeting", "", blocks[5][3], "", 219, 227, null, "", "", now - 345600000] },
    { sql: "INSERT INTO vocab_occurrences VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params: ["seed_occ_bustle", "seed_lexeme_bustle", podcastId, null, "seed_segment_3", "bustle", "", segments[3][3], "", 4, 10, 21800, "", "", now - 172800000] },
    { sql: "INSERT INTO vocab_review_cards VALUES (?,?,?,?,?,?,?,?,?)", params: ["seed_card_deliberate", "seed_lexeme_deliberate", "review", now - 3600000, 3, 2.5, 4, 0, now - 259200000] },
    { sql: "INSERT INTO vocab_review_cards VALUES (?,?,?,?,?,?,?,?,?)", params: ["seed_card_restraint", "seed_lexeme_restraint", "learning", now - 120000, 1, 2.35, 2, 1, now - 86400000] },
    { sql: "INSERT INTO vocab_review_cards VALUES (?,?,?,?,?,?,?,?,?)", params: ["seed_card_fleeting", "seed_lexeme_fleeting", "review", now + 10800000, 5, 2.6, 5, 0, now - 432000000] },
    { sql: "INSERT INTO vocab_activity VALUES (?,?,?,?,?,?,?)", params: ["seed_activity_today", day, 1320, 780, 7, 4, now] },
    { sql: "INSERT INTO vocab_activity VALUES (?,?,?,?,?,?,?)", params: ["seed_activity_prior", prior, 840, 1240, 11, 3, now - 86400000] },
  ];
};

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object") {
    const record = result as { rows?: T[]; results?: T[] };
    return record.rows ?? record.results ?? [];
  }
  return [];
}

async function query<T>(sql: string, params: SqlValue[] = []) {
  return rowsOf<T>(await localDb.query(DB, sql, params));
}

async function run(sql: string, params: SqlValue[] = []) {
  return localDb.run(DB, sql, params);
}

export async function initializeVocabDatabase() {
  await localDb.init();
  for (const statement of schema) await run(statement);
  const count = await query<{ total: number }>("SELECT COUNT(*) AS total FROM vocab_items");
  if (Number(count[0]?.total ?? 0) === 0) {
    await localDb.batch(DB, seedStatements(Date.now()));
  }
  await run("PRAGMA optimize");
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

export async function loadVocabSnapshot(): Promise<VocabSnapshot> {
  const [items, blocks, segments, lexemes, occurrences, reviewCards, bookmarks, activity, settingRows] = await Promise.all([
    query<VocabSnapshot["items"][number]>("SELECT * FROM vocab_items ORDER BY updated_at DESC"),
    query<VocabSnapshot["blocks"][number]>("SELECT * FROM vocab_blocks ORDER BY item_id, ordinal"),
    query<VocabSnapshot["segments"][number]>("SELECT * FROM vocab_transcript_segments ORDER BY item_id, ordinal"),
    query<VocabSnapshot["lexemes"][number]>(`SELECT l.*, COUNT(o.id) AS occurrence_count FROM vocab_lexemes l LEFT JOIN vocab_occurrences o ON o.lexeme_id=l.id GROUP BY l.id ORDER BY l.updated_at DESC`),
    query<VocabSnapshot["occurrences"][number]>(`SELECT o.*, i.title AS item_title FROM vocab_occurrences o LEFT JOIN vocab_items i ON i.id=o.item_id ORDER BY o.created_at DESC`),
    query<ReviewCard>(`SELECT c.*, l.headword, l.pronunciation, l.gloss_en, COALESCE(o.context_sentence,'') AS context_sentence FROM vocab_review_cards c JOIN vocab_lexemes l ON l.id=c.lexeme_id LEFT JOIN vocab_occurrences o ON o.id=(SELECT id FROM vocab_occurrences WHERE lexeme_id=l.id ORDER BY created_at DESC LIMIT 1) WHERE c.state!='suspended' ORDER BY c.due_at`),
    query<VocabSnapshot["bookmarks"][number]>("SELECT * FROM vocab_bookmarks ORDER BY created_at DESC"),
    query<VocabSnapshot["activity"][number]>("SELECT day, SUM(read_seconds) AS read_seconds, SUM(listen_seconds) AS listen_seconds, SUM(review_count) AS review_count, SUM(lookups) AS lookups FROM vocab_activity GROUP BY day ORDER BY day"),
    query<{ key: string; value: string }>("SELECT key,value FROM vocab_settings"),
  ]);
  const settings = defaultSettings();
  for (const row of settingRows) {
    if (row.key in settings) {
      const key = row.key as keyof VocabSettings;
      const raw = row.value;
      (settings as unknown as Record<string, unknown>)[key] = raw === "true" ? true : raw === "false" ? false : Number.isNaN(Number(raw)) ? raw : Number(raw);
    }
  }
  return { items, blocks, segments, lexemes, occurrences, reviewCards, bookmarks, activity, settings };
}

export async function saveArticle(article: ParsedArticle, method: string) {
  const now = Date.now();
  const id = uid("article");
  const statements: Statement[] = [
    { sql: "INSERT INTO vocab_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params: [id, "article", article.title, article.description, article.source, article.sourceUrl ?? null, article.author, new Date(now).toISOString().slice(0, 10), 0, null, "unread", 0, now, now] },
    ...article.blocks.map((block, ordinal) => ({ sql: "INSERT INTO vocab_blocks VALUES (?,?,?,?,?)", params: [uid("block"), id, ordinal, block.kind, block.text] })),
    { sql: "INSERT INTO vocab_imports VALUES (?,?,?,?,?,?,?)", params: [uid("import"), method, article.title, "complete", "", id, now] },
  ];
  await localDb.batch(DB, statements);
  return id;
}

export async function savePodcast(podcast: ParsedPodcast, method: string) {
  const now = Date.now();
  const id = uid("podcast");
  const duration = podcast.durationMs || podcast.segments.at(-1)?.end_ms || 0;
  const statements: Statement[] = [
    { sql: "INSERT INTO vocab_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params: [id, "podcast", podcast.title, podcast.description, podcast.source, podcast.sourceUrl ?? null, "", new Date(now).toISOString().slice(0, 10), duration, podcast.audioUrl ?? null, "unread", 0, now, now] },
    ...podcast.segments.map((segment, ordinal) => ({ sql: "INSERT INTO vocab_transcript_segments VALUES (?,?,?,?,?,?,?)", params: [uid("segment"), id, ordinal, segment.start_ms, segment.end_ms, segment.text, segment.speaker ?? null] })),
    { sql: "INSERT INTO vocab_imports VALUES (?,?,?,?,?,?,?)", params: [uid("import"), method, podcast.title, "complete", "", id, now] },
  ];
  await localDb.batch(DB, statements);
  return id;
}

export async function saveOccurrence(target: SelectionTarget, explanation: AiExplanation | null) {
  const now = Date.now();
  const normalized = target.surface.normalize("NFC").trim().toLocaleLowerCase("en");
  const existing = await query<{ id: string }>("SELECT id FROM vocab_lexemes WHERE normalized_key=?", [normalized]);
  const lexemeId = existing[0]?.id ?? uid("lexeme");
  const canonical = explanation?.target?.canonical?.trim() || target.surface;
  const pronunciation = explanation?.target?.pronunciation || explanation?.target?.ipa || "";
  const gloss = explanation?.sense?.glosses_en?.join("; ") || explanation?.sense?.meaning_in_context_en || "";
  const english = explanation?.sense?.explanation_en || explanation?.sense?.meaning_in_context_en || "";
  const chinese = explanation?.sense?.explanation_zh || "";
  const occurrenceId = uid("occurrence");
  const statements: Statement[] = [];
  if (existing[0]) {
    statements.push({ sql: "UPDATE vocab_lexemes SET headword=?, pronunciation=CASE WHEN ?!='' THEN ? ELSE pronunciation END, gloss_en=CASE WHEN ?!='' THEN ? ELSE gloss_en END, explanation_en=CASE WHEN ?!='' THEN ? ELSE explanation_en END, explanation_zh=CASE WHEN ?!='' THEN ? ELSE explanation_zh END, lookup_count=lookup_count+1, updated_at=? WHERE id=?", params: [canonical, pronunciation, pronunciation, gloss, gloss, english, english, chinese, chinese, now, lexemeId] });
  } else {
    statements.push({ sql: "INSERT INTO vocab_lexemes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", params: [lexemeId, canonical, normalized, pronunciation, gloss, english, chinese, "saved", 0, "", 1, now, now] });
    statements.push({ sql: "INSERT INTO vocab_review_cards VALUES (?,?,?,?,?,?,?,?,?)", params: [uid("card"), lexemeId, "new", now, 0, 2.5, 0, 0, null] });
  }
  statements.push({ sql: "INSERT INTO vocab_occurrences VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params: [occurrenceId, lexemeId, target.itemId, target.blockId ?? null, target.segmentId ?? null, target.surface, target.before, target.sentence, target.after, target.startUtf16, target.endUtf16, target.startMs ?? null, "", explanation ? JSON.stringify(explanation) : "", now] });
  statements.push({ sql: "INSERT INTO vocab_activity VALUES (?,?,?,?,?,?,?)", params: [uid("activity"), new Date(now).toISOString().slice(0, 10), 0, 0, 0, 1, now] });
  await localDb.batch(DB, statements);
  return { lexemeId, occurrenceId };
}

export async function saveLexemeNote(lexemeId: string, note: string) {
  await run("UPDATE vocab_lexemes SET notes=?, updated_at=? WHERE id=?", [note, Date.now(), lexemeId]);
}

export async function saveOccurrenceNote(occurrenceId: string, note: string) {
  await run("UPDATE vocab_occurrences SET note=? WHERE id=?", [note, occurrenceId]);
}

export async function updateLexemeStatus(lexemeId: string, status: string) {
  await run("UPDATE vocab_lexemes SET status=?, updated_at=? WHERE id=?", [status, Date.now(), lexemeId]);
}

export async function toggleLexemeStar(lexemeId: string, starred: boolean) {
  await run("UPDATE vocab_lexemes SET starred=?, updated_at=? WHERE id=?", [starred ? 1 : 0, Date.now(), lexemeId]);
}

export async function createBookmark(itemId: string, locator: string, label: string) {
  await run("INSERT INTO vocab_bookmarks VALUES (?,?,?,?,?,?)", [uid("bookmark"), itemId, locator, label, "", Date.now()]);
}

export async function updateItemProgress(itemId: string, progress: number, complete = false) {
  await run("UPDATE vocab_items SET progress=?, status=?, updated_at=? WHERE id=?", [Math.max(0, Math.min(1, progress)), complete ? "complete" : progress > 0 ? "in_progress" : "unread", Date.now(), itemId]);
}

export async function updateItemStatus(itemId: string, status: LibraryItem["status"]) {
  await run("UPDATE vocab_items SET status=?, updated_at=? WHERE id=?", [status, Date.now(), itemId]);
}

export async function rateReview(card: ReviewCard, rating: ReviewRating) {
  const now = Date.now();
  let interval = card.interval_days;
  let ease = card.ease;
  let state: ReviewCard["state"] = "review";
  let lapses = card.lapses;
  if (rating === "again") {
    interval = 10 / 1440;
    ease = Math.max(1.3, ease - 0.2);
    state = card.reps ? "relearning" : "learning";
    lapses += card.reps ? 1 : 0;
  } else if (rating === "hard") {
    interval = Math.max(1, interval * 1.2 || 1);
    ease = Math.max(1.3, ease - 0.05);
  } else if (rating === "good") {
    interval = Math.max(1, interval ? interval * ease : 1);
  } else {
    interval = Math.max(4, interval ? interval * (ease + 0.35) : 4);
    ease = Math.min(3.2, ease + 0.1);
  }
  const due = now + interval * 86400000;
  const before = JSON.stringify(card);
  const after = JSON.stringify({ state, due_at: due, interval_days: interval, ease, reps: card.reps + 1, lapses, last_review_at: now });
  const eventId = uid("review");
  await localDb.batch(DB, [
    { sql: "UPDATE vocab_review_cards SET state=?, due_at=?, interval_days=?, ease=?, reps=?, lapses=?, last_review_at=? WHERE id=?", params: [state, due, interval, ease, card.reps + 1, lapses, now, card.id] },
    { sql: "INSERT INTO vocab_review_events VALUES (?,?,?,?,?,?,?)", params: [eventId, card.id, rating, now, before, after, null] },
    { sql: "INSERT INTO vocab_activity VALUES (?,?,?,?,?,?,?)", params: [uid("activity"), new Date(now).toISOString().slice(0, 10), 0, 0, 1, 0, now] },
  ]);
  return eventId;
}

export async function undoReview(eventId: string) {
  const events = await query<{ card_id: string; before_json: string }>("SELECT card_id,before_json FROM vocab_review_events WHERE id=? AND undone_at IS NULL", [eventId]);
  const event = events[0];
  if (!event) return;
  const card = JSON.parse(event.before_json) as ReviewCard;
  await localDb.batch(DB, [
    { sql: "UPDATE vocab_review_cards SET state=?, due_at=?, interval_days=?, ease=?, reps=?, lapses=?, last_review_at=? WHERE id=?", params: [card.state, card.due_at, card.interval_days, card.ease, card.reps, card.lapses, card.last_review_at, event.card_id] },
    { sql: "UPDATE vocab_review_events SET undone_at=? WHERE id=?", params: [Date.now(), eventId] },
  ]);
}

export async function saveSettings(settings: VocabSettings) {
  const now = Date.now();
  const statements = Object.entries(settings).map(([key, value]) => ({
    sql: "INSERT INTO vocab_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    params: [key, String(value), now],
  }));
  await localDb.batch(DB, statements);
}

export async function exportVocabDatabase() {
  const result = await localDb.export(DB) as unknown;
  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (result && typeof result === "object" && "data" in result) {
    const data = (result as { data: Uint8Array | ArrayBuffer }).data;
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  }
  throw new Error("数据库导出没有返回有效文件");
}

export async function importVocabDatabase(bytes: Uint8Array) {
  await localDb.import(DB, bytes);
  await initializeVocabDatabase();
}

export async function recordStudySeconds(itemId: string, kind: "read" | "listen", seconds: number) {
  if (seconds < 1) return;
  const now = Date.now();
  await run("INSERT INTO vocab_activity VALUES (?,?,?,?,?,?,?)", [uid("activity"), new Date(now).toISOString().slice(0, 10), kind === "read" ? seconds : 0, kind === "listen" ? seconds : 0, 0, 0, now]);
  await run("UPDATE vocab_items SET updated_at=? WHERE id=?", [now, itemId]);
}

export function getDueCards(cards: ReviewCard[], now = Date.now()) {
  return cards.filter((card) => card.due_at <= now && card.state !== "suspended");
}

export function findItem(items: LibraryItem[], id: string | null) {
  return id ? items.find((item) => item.id === id) ?? null : null;
}
