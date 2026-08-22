import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

function executeRun(database, sql, params = []) {
  const statement = database.prepare(sql);
  try {
    if (params.length) statement.bind(params);
    while (statement.step()) {
      // Consume RETURNING and PRAGMA rows.
    }
  } finally {
    statement.finalize();
  }
  return {
    changes: Number(database.changes()),
    lastInsertRowId: database.selectValue("SELECT last_insert_rowid()") ?? null,
  };
}

function adapterFor(database) {
  return {
    async init() {
      return {
        database: "vocab",
        filename: "vocab.sqlite3",
        persistent: true,
        sqliteVersion: "test",
        schemaVersion: Number(database.selectValue("PRAGMA user_version") ?? 0),
        seeded: false,
      };
    },
    async query(_name, sql, params = []) {
      if (globalThis.__reviewQueryFault) {
        throw new Error("injected review verification failure");
      }
      const rows = database.selectObjects(sql, params);
      return { columns: [], rows, rowCount: rows.length };
    },
    async run(_name, sql, params = []) {
      return executeRun(database, sql, params);
    },
    async batch(_name, statements, options = {}) {
      if (globalThis.__reviewBatchFault === "before_commit") {
        globalThis.__reviewBatchFault = null;
        throw new Error("injected failure before review transaction");
      }
      let statementIndex = 0;
      const operation = () => statements.map(({ sql, params = [] }) => {
        if (statementIndex === globalThis.__reviewStatementFaultAt) {
          statementIndex += 1;
          throw new Error("injected failure inside review transaction");
        }
        statementIndex += 1;
        return executeRun(database, sql, params);
      });
      const results = options.transaction === false
        ? operation()
        : database.transaction("IMMEDIATE", operation);
      if (globalThis.__reviewBatchFault === "after_commit") {
        globalThis.__reviewBatchFault = null;
        throw new Error("injected worker response loss after review commit");
      }
      if (globalThis.__reviewBatchFault === "after_commit_verify_fails") {
        globalThis.__reviewBatchFault = null;
        globalThis.__reviewQueryFault = true;
        throw new Error("injected response loss and unavailable verification");
      }
      return {
        results,
        changes: results.reduce((sum, result) => sum + result.changes, 0),
      };
    },
    async export() {
      throw new Error("not needed");
    },
    async import() {
      throw new Error("not needed");
    },
  };
}

globalThis.__vocabLocalDbProxy = {
  init(...args) {
    return globalThis.__vocabLocalDbAdapter.init(...args);
  },
  query(...args) {
    return globalThis.__vocabLocalDbAdapter.query(...args);
  },
  run(...args) {
    return globalThis.__vocabLocalDbAdapter.run(...args);
  },
  batch(...args) {
    return globalThis.__vocabLocalDbAdapter.batch(...args);
  },
  export(...args) {
    return globalThis.__vocabLocalDbAdapter.export(...args);
  },
  import(...args) {
    return globalThis.__vocabLocalDbAdapter.import(...args);
  },
};

globalThis.window = {};
globalThis.__reviewBroadcastFault = false;
globalThis.BroadcastChannel = class {
  postMessage() {
    if (globalThis.__reviewBroadcastFault) {
      throw new Error("injected BroadcastChannel failure");
    }
  }
  addEventListener() {}
  removeEventListener() {}
};

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function transpile(relativePath) {
  const source = await readFile(new URL(relativePath, projectRoot), "utf8");
  const result = ts.transpileModule(source, {
    fileName: relativePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  assert.deepEqual(
    (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  return result.outputText;
}

const [lockJavaScript, srsJavaScript, rawStoreJavaScript] = await Promise.all([
  transpile("lib/vocab/lock.ts"),
  transpile("lib/vocab/srs.ts"),
  transpile("lib/vocab/store.ts"),
]);
const dependencyUrls = {
  "@/lib/local-db/client": moduleUrl(
    "export const localDb = globalThis.__vocabLocalDbProxy;",
  ),
  "./content": moduleUrl(
    "export function uid(prefix){ return `${prefix}_${crypto.randomUUID()}`; }",
  ),
  "./lock": moduleUrl(lockJavaScript),
  "./srs": moduleUrl(srsJavaScript),
};
let storeJavaScript = rawStoreJavaScript;
for (const [specifier, url] of Object.entries(dependencyUrls)) {
  storeJavaScript = storeJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const store = await import(moduleUrl(storeJavaScript));

async function fixture() {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  globalThis.__reviewBatchFault = null;
  globalThis.__reviewStatementFaultAt = -1;
  globalThis.__reviewQueryFault = false;
  globalThis.__reviewBroadcastFault = false;
  globalThis.__vocabLocalDbAdapter = adapterFor(database);
  await store.initializeVocabDatabase();
  return database;
}

async function createReviewCard() {
  const itemId = await store.saveArticle({
    title: "Recovery test",
    description: "",
    author: "",
    source: "local",
    blocks: [{ kind: "paragraph", text: "Steady practice compounds." }],
  }, "paste");
  const saved = await store.saveOccurrence({
    surface: "Steady",
    sentence: "Steady practice compounds.",
    before: "",
    after: "",
    itemId,
    startUtf16: 0,
    endUtf16: 6,
  }, {
    target: { canonical: "steady" },
    sense: {
      glosses_en: ["consistent and reliable"],
      explanation_en: "Consistent and reliable.",
    },
  });
  await store.updateLexemeStatus(saved.lexemeId, "learning");
  const snapshot = await store.loadVocabSnapshot();
  assert.equal(snapshot.reviewCards.length, 1);
  return snapshot.reviewCards[0];
}

function count(database, table, id) {
  return Number(database.selectValue(
    `SELECT COUNT(*) FROM ${table} WHERE id=?`,
    [id],
  ));
}

function cardProjection(database, cardId) {
  return { ...database.selectObjects(
    `SELECT state,due_at,interval_days,ease,reps,lapses,last_review_at,
            algorithm_version,suspended_from_state,suspended_reason,updated_at
     FROM vocab_review_cards WHERE id=?`,
    [cardId],
  )[0] };
}

test("rating receipts are strict JSON checkpoints with deterministic scheduling semantics", async () => {
  const database = await fixture();
  try {
    const card = await createReviewCard();
    const receipt = await store.prepareVocabReviewRating(card, "good");
    const roundTrip = JSON.parse(JSON.stringify(receipt));
    assert.equal(store.isVocabReviewRatingReceipt(roundTrip), true);
    assert.equal(receipt.after.last_review_at, receipt.reviewedAt);
    assert.ok(receipt.after.updated_at > receipt.before.updated_at);
    assert.equal(receipt.day.length, 10);
    assert.equal(store.isVocabReviewRatingReceipt({ ...roundTrip, extra: true }), false);
    assert.equal(store.isVocabReviewRatingReceipt({
      ...roundTrip,
      after: { ...roundTrip.after, updated_at: roundTrip.before.updated_at },
    }), false);
    assert.equal(store.isVocabReviewRatingReceipt({
      ...roundTrip,
      rating: "easy",
    }), false);
    const fractional = await store.prepareVocabReviewRating({
      ...card,
      state: "review",
      interval_days: 1.234_567,
      ease: 2.345,
      reps: 3,
    }, "good");
    assert.equal(store.isVocabReviewRatingReceipt(fractional), true);
    for (const invalidCardId of [
      "",
      "   ",
      "card\ncontrol",
      `card_${String.fromCharCode(0)}control`,
      "x".repeat(257),
      String.fromCharCode(0xd800),
    ]) {
      assert.equal(store.isVocabReviewRatingReceipt({
        ...roundTrip,
        cardId: invalidCardId,
      }), false);
      await assert.rejects(
        store.prepareVocabReviewRating({ ...card, id: invalidCardId }, "good"),
        /无法生成可验证/,
      );
    }
    const changedDay = {
      ...roundTrip,
      day: "1999-01-01",
    };
    assert.equal(store.isVocabReviewRatingReceipt(changedDay), true);
    assert.equal(await store.inspectVocabReviewRating(changedDay), "conflict");
    assert.equal(await store.inspectVocabReviewRating(receipt), "absent");
  } finally {
    database.close();
  }
});

test("a preserved non-UUID legacy card can be rated, inspected, and undone after response loss", async () => {
  const database = await fixture();
  try {
    const generated = await createReviewCard();
    executeRun(
      database,
      "UPDATE vocab_review_cards SET id=? WHERE id=?",
      ["seed_card_deliberate", generated.id],
    );
    const legacyCard = (await store.loadVocabSnapshot()).reviewCards.find(
      ({ id }) => id === "seed_card_deliberate",
    );
    assert.ok(legacyCard);

    const rating = await store.prepareVocabReviewRating(legacyCard, "good");
    assert.equal(rating.cardId, "seed_card_deliberate");
    assert.equal(store.isVocabReviewRatingReceipt(rating), true);
    globalThis.__reviewBatchFault = "after_commit";
    assert.equal((await store.commitVocabReviewRating(rating)).status, "exact");
    assert.equal(await store.inspectVocabReviewRating(rating), "exact");

    const undo = await store.prepareVocabReviewUndo(rating.eventId);
    assert.equal(undo.cardId, "seed_card_deliberate");
    assert.equal(store.isVocabReviewUndoReceipt(undo), true);
    globalThis.__reviewBatchFault = "after_commit";
    assert.equal((await store.commitVocabReviewUndo(undo)).status, "exact");
    assert.equal(await store.inspectVocabReviewUndo(undo), "exact");
    assert.equal(count(database, "vocab_activity", rating.activityId), 0);
  } finally {
    database.close();
  }
});

test("every mutable event and activity fact participates in exact inspection", async () => {
  const database = await fixture();
  try {
    const card = await createReviewCard();
    const receipt = await store.prepareVocabReviewRating(card, "good");
    await store.commitVocabReviewRating(receipt);
    const changes = [
      ["vocab_review_events", "rating", "easy"],
      ["vocab_review_events", "reviewed_at", receipt.reviewedAt + 10],
      ["vocab_review_events", "before_json", "{}"],
      ["vocab_review_events", "after_json", "{}"],
      ["vocab_review_events", "undone_at", receipt.reviewedAt + 20],
      ["vocab_review_events", "activity_id", null],
      ["vocab_activity", "day", "1999-01-01"],
      ["vocab_activity", "read_seconds", 1],
      ["vocab_activity", "listen_seconds", 1],
      ["vocab_activity", "review_count", 2],
      ["vocab_activity", "lookups", 1],
      ["vocab_activity", "created_at", receipt.reviewedAt + 30],
    ];
    for (const [table, field, replacement] of changes) {
      const id = table === "vocab_review_events"
        ? receipt.eventId
        : receipt.activityId;
      const original = database.selectValue(
        `SELECT ${field} FROM ${table} WHERE id=?`,
        [id],
      ) ?? null;
      executeRun(database, `UPDATE ${table} SET ${field}=? WHERE id=?`, [
        replacement,
        id,
      ]);
      assert.notEqual(
        await store.inspectVocabReviewRating(receipt),
        "exact",
        `${table}.${field}`,
      );
      executeRun(database, `UPDATE ${table} SET ${field}=? WHERE id=?`, [
        original,
        id,
      ]);
      assert.equal(
        await store.inspectVocabReviewRating(receipt),
        "exact",
        `${table}.${field} restored`,
      );
    }
  } finally {
    database.close();
  }
});

test("a persisted receipt remains valid after the user crosses a time-zone boundary", async () => {
  const database = await fixture();
  const originalTimeZone = process.env.TZ;
  const realNow = Date.now;
  try {
    const card = await createReviewCard();
    Date.now = () => Date.parse("2030-01-02T00:30:00.000Z");
    process.env.TZ = "Asia/Singapore";
    const receipt = await store.prepareVocabReviewRating(card, "good");
    assert.equal(receipt.day, "2030-01-02");

    process.env.TZ = "America/Los_Angeles";
    assert.equal(new Date(receipt.reviewedAt).getDate(), 1);
    assert.equal(store.isVocabReviewRatingReceipt(receipt), true);
    assert.equal(await store.inspectVocabReviewRating(receipt), "absent");
    await store.commitVocabReviewRating(receipt);
    const undo = await store.prepareVocabReviewUndo(receipt.eventId);
    assert.equal(undo.day, "2030-01-02");
    assert.equal(store.isVocabReviewUndoReceipt(undo), true);
  } finally {
    Date.now = realNow;
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
    database.close();
  }
});

test("lost rating responses recover exactly and an exact retry never duplicates facts", async () => {
  const database = await fixture();
  try {
    const card = await createReviewCard();
    const receipt = await store.prepareVocabReviewRating(card, "good");
    globalThis.__reviewBatchFault = "after_commit";
    const recovered = await store.commitVocabReviewRating(receipt);
    assert.equal(recovered.status, "exact");
    assert.equal(await store.inspectVocabReviewRating(receipt), "exact");
    const retry = await store.commitVocabReviewRating(
      JSON.parse(JSON.stringify(receipt)),
    );
    assert.equal(retry.status, "already");
    assert.equal(count(database, "vocab_review_events", receipt.eventId), 1);
    assert.equal(count(database, "vocab_activity", receipt.activityId), 1);
    assert.equal(Number(database.selectValue(
      "SELECT reps FROM vocab_review_cards WHERE id=?",
      [card.id],
    )), 1);
  } finally {
    database.close();
  }
});

test("double clicks converge while a stale cross-tab receipt and changed payload fail closed", async () => {
  const database = await fixture();
  try {
    const card = await createReviewCard();
    const first = await store.prepareVocabReviewRating(card, "hard");
    const staleOtherTab = await store.prepareVocabReviewRating(card, "easy");
    const results = await Promise.all([
      store.commitVocabReviewRating(first),
      store.commitVocabReviewRating(first),
    ]);
    assert.deepEqual(results.map(({ status }) => status).sort(), ["already", "exact"]);
    await assert.rejects(
      store.commitVocabReviewRating(staleOtherTab),
      (error) => error?.code === "VOCAB_REVIEW_CHANGED" &&
        error.receipt.eventId === staleOtherTab.eventId,
    );
    const tampered = {
      ...first,
      rating: "easy",
    };
    await assert.rejects(
      store.commitVocabReviewRating(tampered),
      (error) => error?.code === "VOCAB_REVIEW_CONFLICT",
    );
    assert.equal(count(database, "vocab_review_events", first.eventId), 1);
    assert.equal(count(database, "vocab_review_events", staleOtherTab.eventId), 0);
    assert.equal(count(database, "vocab_activity", staleOtherTab.activityId), 0);
  } finally {
    database.close();
  }
});

test("occupied IDs and mid-transaction faults roll every review fact back", async () => {
  const database = await fixture();
  try {
    const card = await createReviewCard();
    const before = cardProjection(database, card.id);
    const occupied = await store.prepareVocabReviewRating(card, "good");
    executeRun(database, `INSERT INTO vocab_activity(
      id,day,read_seconds,listen_seconds,review_count,lookups,created_at
    ) VALUES(?,?,?,?,?,?,?)`, [
      occupied.activityId, occupied.day, 99, 0, 0, 0, occupied.reviewedAt,
    ]);
    await assert.rejects(
      store.commitVocabReviewRating(occupied),
      (error) => error?.code === "VOCAB_REVIEW_CONFLICT",
    );
    assert.deepEqual(cardProjection(database, card.id), before);
    assert.equal(count(database, "vocab_review_events", occupied.eventId), 0);

    executeRun(database, "DELETE FROM vocab_activity WHERE id=?", [occupied.activityId]);
    const rollback = await store.prepareVocabReviewRating(card, "good");
    globalThis.__reviewStatementFaultAt = 2;
    await assert.rejects(
      store.commitVocabReviewRating(rollback),
      (error) => error?.code === "VOCAB_REVIEW_NOT_SAVED",
    );
    assert.deepEqual(cardProjection(database, card.id), before);
    assert.equal(count(database, "vocab_review_events", rollback.eventId), 0);
    assert.equal(count(database, "vocab_activity", rollback.activityId), 0);
    assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("an uncheckable lost response exposes its durable receipt and later resolves without replay", async () => {
  const database = await fixture();
  try {
    const card = await createReviewCard();
    const receipt = await store.prepareVocabReviewRating(card, "again");
    globalThis.__reviewBatchFault = "after_commit_verify_fails";
    await assert.rejects(
      store.commitVocabReviewRating(receipt),
      (error) => error?.code === "VOCAB_REVIEW_UNCERTAIN" &&
        error.receipt.eventId === receipt.eventId,
    );
    globalThis.__reviewQueryFault = false;
    assert.equal(await store.inspectVocabReviewRating(receipt), "exact");
    assert.equal((await store.commitVocabReviewRating(receipt)).status, "already");
    assert.equal(count(database, "vocab_review_events", receipt.eventId), 1);
    assert.equal(count(database, "vocab_activity", receipt.activityId), 1);
  } finally {
    globalThis.__reviewQueryFault = false;
    database.close();
  }
});

test("same-tick and clock-rollback reviews stay monotonic with a latest-event guard", async () => {
  const database = await fixture();
  const realNow = Date.now;
  try {
    const firstCard = await createReviewCard();
    const fixedNow = realNow();
    Date.now = () => fixedNow;
    const first = await store.prepareVocabReviewRating(firstCard, "good");
    await store.commitVocabReviewRating(first);
    const nextCard = (await store.loadVocabSnapshot()).reviewCards[0];
    Date.now = () => first.reviewedAt - 86_400_000;
    const second = await store.prepareVocabReviewRating(nextCard, "hard");
    await store.commitVocabReviewRating(second);
    assert.equal(second.reviewedAt, first.reviewedAt + 1);
    assert.equal(await store.inspectVocabReviewRating(first), "exact");
    await assert.rejects(
      store.prepareVocabReviewUndo(first.eventId),
      /最近一次/,
    );
    const secondUndo = await store.prepareVocabReviewUndo(second.eventId);
    await store.commitVocabReviewUndo(secondUndo);
    const firstUndo = await store.prepareVocabReviewUndo(first.eventId);
    assert.equal(await store.inspectVocabReviewUndo(firstUndo), "absent");
  } finally {
    Date.now = realNow;
    database.close();
  }
});

test("lost undo responses are exact, idempotent, and cannot restore over a later review", async () => {
  const database = await fixture();
  try {
    const card = await createReviewCard();
    const rating = await store.prepareVocabReviewRating(card, "good");
    await store.commitVocabReviewRating(rating);
    const undo = await store.prepareVocabReviewUndo(rating.eventId);
    assert.equal(store.isVocabReviewUndoReceipt(JSON.parse(JSON.stringify(undo))), true);
    assert.equal(await store.inspectVocabReviewUndo(undo), "absent");
    globalThis.__reviewBatchFault = "after_commit";
    assert.equal((await store.commitVocabReviewUndo(undo)).status, "exact");
    assert.equal(await store.inspectVocabReviewUndo(undo), "exact");
    assert.equal((await store.commitVocabReviewUndo(undo)).status, "already");
    assert.equal(count(database, "vocab_activity", rating.activityId), 0);
    assert.equal(database.selectValue(
      "SELECT activity_id FROM vocab_review_events WHERE id=?",
      [rating.eventId],
    ), null);

    const restoredCard = (await store.loadVocabSnapshot()).reviewCards[0];
    const later = await store.prepareVocabReviewRating(restoredCard, "easy");
    await store.commitVocabReviewRating(later);
    const afterLater = cardProjection(database, card.id);
    assert.equal(await store.inspectVocabReviewUndo(undo), "exact");
    assert.equal((await store.commitVocabReviewUndo(undo)).status, "already");
    assert.deepEqual(cardProjection(database, card.id), afterLater);
    assert.equal(count(database, "vocab_review_events", later.eventId), 1);
  } finally {
    database.close();
  }
});

test("an uncheckable undo keeps its receipt, and a partial undo transaction fully rolls back", async () => {
  const database = await fixture();
  try {
    const card = await createReviewCard();
    const rating = await store.prepareVocabReviewRating(card, "good");
    await store.commitVocabReviewRating(rating);
    const undo = await store.prepareVocabReviewUndo(rating.eventId);
    globalThis.__reviewBatchFault = "after_commit_verify_fails";
    await assert.rejects(
      store.commitVocabReviewUndo(undo),
      (error) => error?.code === "VOCAB_REVIEW_UNCERTAIN" &&
        error.receipt.operationId === undo.operationId,
    );
    globalThis.__reviewQueryFault = false;
    assert.equal(await store.inspectVocabReviewUndo(undo), "exact");

    const restored = (await store.loadVocabSnapshot()).reviewCards[0];
    const nextRating = await store.prepareVocabReviewRating(restored, "hard");
    await store.commitVocabReviewRating(nextRating);
    const nextUndo = await store.prepareVocabReviewUndo(nextRating.eventId);
    const beforeUndo = cardProjection(database, card.id);
    globalThis.__reviewStatementFaultAt = 2;
    await assert.rejects(
      store.commitVocabReviewUndo(nextUndo),
      (error) => error?.code === "VOCAB_REVIEW_NOT_SAVED",
    );
    assert.deepEqual(cardProjection(database, card.id), beforeUndo);
    assert.equal(await store.inspectVocabReviewUndo(nextUndo), "absent");
    assert.equal(count(database, "vocab_activity", nextRating.activityId), 1);
    assert.equal(database.selectValue(
      "SELECT undone_at FROM vocab_review_events WHERE id=?",
      [nextRating.eventId],
    ), null);
  } finally {
    globalThis.__reviewQueryFault = false;
    database.close();
  }
});

test("notification failure never turns a durable review or undo into a false failure", async () => {
  const database = await fixture();
  try {
    const card = await createReviewCard();
    const rating = await store.prepareVocabReviewRating(card, "good");
    globalThis.__reviewBroadcastFault = true;
    assert.equal((await store.commitVocabReviewRating(rating)).status, "exact");
    const undo = await store.prepareVocabReviewUndo(rating.eventId);
    assert.equal((await store.commitVocabReviewUndo(undo)).status, "exact");
    assert.equal(await store.inspectVocabReviewUndo(undo), "exact");
  } finally {
    globalThis.__reviewBroadcastFault = false;
    database.close();
  }
});
