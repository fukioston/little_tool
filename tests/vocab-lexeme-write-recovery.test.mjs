import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function transpile(relativePath) {
  const source = await readFile(new URL(relativePath, projectRoot), "utf8");
  const { outputText, diagnostics = [] } = ts.transpileModule(source, {
    fileName: relativePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  assert.deepEqual(
    diagnostics.filter(({ category }) => category === ts.DiagnosticCategory.Error),
    [],
  );
  return outputText;
}

const [rawStoreJavaScript, srsJavaScript] = await Promise.all([
  transpile("lib/vocab/store.ts"),
  transpile("lib/vocab/srs.ts"),
]);
const srsUrl = moduleUrl(srsJavaScript);
const lockStubUrl = moduleUrl(`
  function runtime() { return globalThis.__vocabLexemeDefaultRuntime; }
  export async function withVocabReadLock(task) {
    return runtime()?.withReadLock ? runtime().withReadLock(task) : task();
  }
  export async function withVocabWriteLock(task) {
    return runtime()?.withExclusiveLock ? runtime().withExclusiveLock(task) : task();
  }
  export function broadcastVocabChange(reason) { runtime()?.broadcast(reason); }
`);
let storeJavaScript = rawStoreJavaScript;
for (const [specifier, url] of Object.entries({
  "@/lib/local-db/client": moduleUrl(`
    function runtime() {
      const value = globalThis.__vocabLexemeDefaultRuntime;
      if (!value) throw new Error("default localDb must not be used without a fixture");
      return value;
    }
    export const localDb = {
      query(_database, sql, params) { return runtime().query(sql, params); },
      batch(_database, statements) { return runtime().batch(statements); },
      currentGeneration() { return runtime().currentGeneration(); },
      init() { throw new Error("not used in lexeme service tests"); },
      run() { throw new Error("not used in lexeme service tests"); }
    };
  `),
  "./content": moduleUrl(`
    export function uid(prefix) {
      return prefix + "_" + crypto.randomUUID();
    }
  `),
  "./lock": lockStubUrl,
  "./srs": srsUrl,
})) {
  storeJavaScript = storeJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const store = await import(moduleUrl(storeJavaScript));

function executeRun(database, sql, params = []) {
  const statement = database.prepare(sql);
  try {
    if (params.length) statement.bind(params);
    while (statement.step()) {
      // Consume any returned rows.
    }
  } finally {
    statement.finalize();
  }
  return { changes: Number(database.changes()), lastInsertRowId: null };
}

function deterministicUuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function lexeme(overrides = {}) {
  return {
    id: "lexeme_fixture",
    headword: "steady",
    normalized_key: "steady",
    pronunciation: "/ˈstɛdi/",
    gloss_en: "consistent and reliable",
    explanation_en: "Continuing without unwanted change.",
    explanation_zh: "稳定的",
    status: "saved",
    starred: 0,
    notes: "",
    lookup_count: 3,
    created_at: 100,
    updated_at: 100,
    ...overrides,
  };
}

function reviewCard(overrides = {}) {
  return {
    id: "card_fixture",
    lexeme_id: "lexeme_fixture",
    state: "review",
    due_at: 900,
    interval_days: 3.5,
    ease: 2.4,
    reps: 4,
    lapses: 1,
    last_review_at: 700,
    algorithm_version: 2,
    suspended_from_state: null,
    suspended_reason: null,
    updated_at: 800,
    ...overrides,
  };
}

function insertLexeme(database, value) {
  executeRun(
    database,
    `INSERT INTO vocab_lexemes(
      id,headword,normalized_key,pronunciation,gloss_en,explanation_en,
      explanation_zh,status,starred,notes,lookup_count,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      value.id, value.headword, value.normalized_key, value.pronunciation,
      value.gloss_en, value.explanation_en, value.explanation_zh, value.status,
      value.starred, value.notes, value.lookup_count, value.created_at,
      value.updated_at,
    ],
  );
}

function insertCard(database, value) {
  executeRun(
    database,
    `INSERT INTO vocab_review_cards(
      id,lexeme_id,state,due_at,interval_days,ease,reps,lapses,last_review_at,
      algorithm_version,suspended_from_state,suspended_reason,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      value.id, value.lexeme_id, value.state, value.due_at,
      value.interval_days, value.ease, value.reps, value.lapses,
      value.last_review_at, value.algorithm_version, value.suspended_from_state,
      value.suspended_reason, value.updated_at,
    ],
  );
}

function selectedLexeme(database, id = "lexeme_fixture") {
  const row = database.selectObjects(
    `SELECT id,headword,normalized_key,pronunciation,gloss_en,explanation_en,
      explanation_zh,status,starred,notes,lookup_count,created_at,updated_at
      FROM vocab_lexemes WHERE id=?`,
    [id],
  )[0];
  return row ? { ...row } : null;
}

function selectedCard(database, id = "card_fixture") {
  const row = database.selectObjects(
    `SELECT id,lexeme_id,state,due_at,interval_days,ease,reps,lapses,
      last_review_at,algorithm_version,suspended_from_state,suspended_reason,
      updated_at FROM vocab_review_cards WHERE id=?`,
    [id],
  )[0];
  return row ? { ...row } : null;
}

async function fixture({
  now = 1_000,
  initialLexemes = [lexeme()],
  initialCards = [reviewCard()],
} = {}) {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE vocab_lexemes (
    id TEXT PRIMARY KEY,
    headword TEXT NOT NULL,
    normalized_key TEXT NOT NULL UNIQUE,
    pronunciation TEXT NOT NULL DEFAULT '',
    gloss_en TEXT NOT NULL DEFAULT '',
    explanation_en TEXT NOT NULL DEFAULT '',
    explanation_zh TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'saved'
      CHECK (status IN ('saved','learning','known','ignored')),
    starred INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    lookup_count INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE vocab_review_cards (
    id TEXT PRIMARY KEY,
    lexeme_id TEXT NOT NULL UNIQUE REFERENCES vocab_lexemes(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'new',
    due_at INTEGER NOT NULL,
    interval_days REAL NOT NULL DEFAULT 0,
    ease REAL NOT NULL DEFAULT 2.5,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    last_review_at INTEGER,
    algorithm_version INTEGER NOT NULL DEFAULT 2,
    suspended_from_state TEXT,
    suspended_reason TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE vocab_activity (
    id TEXT PRIMARY KEY,
    day TEXT NOT NULL,
    read_seconds INTEGER NOT NULL DEFAULT 0,
    listen_seconds INTEGER NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    lookups INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE vocab_review_events (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES vocab_review_cards(id) ON DELETE CASCADE,
    rating TEXT NOT NULL,
    reviewed_at INTEGER NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    undone_at INTEGER,
    activity_id TEXT REFERENCES vocab_activity(id) ON DELETE SET NULL
  );`);
  for (const value of initialLexemes) insertLexeme(database, value);
  for (const value of initialCards) insertCard(database, value);
  const state = {
    now,
    generation: { generationId: "legacy", sequence: 0 },
    uuid: 1,
    readLockCalls: 0,
    exclusiveLockCalls: 0,
    queryCalls: 0,
    batchCalls: 0,
    batchStatementCounts: [],
    broadcasts: [],
    broadcastThrows: false,
    throwBeforeBatch: false,
    beforeBatch: null,
    throwAfterBatch: false,
    failQueryAfterBatch: false,
    failAfterStatement: null,
    failQueries: 0,
  };
  let tail = Promise.resolve();
  async function locked(kind, operation) {
    if (kind === "read") state.readLockCalls += 1;
    else state.exclusiveLockCalls += 1;
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  const runtime = {
    withReadLock(operation) { return locked("read", operation); },
    withExclusiveLock(operation) { return locked("exclusive", operation); },
    async query(sql, params = []) {
      state.queryCalls += 1;
      if (state.failQueries > 0) {
        state.failQueries -= 1;
        throw new Error("injected query loss");
      }
      const rows = database.selectObjects(sql, params);
      return { rows, rowCount: rows.length, columns: [] };
    },
    async batch(statements) {
      state.batchCalls += 1;
      state.batchStatementCounts.push(statements.length);
      if (state.throwBeforeBatch) {
        state.throwBeforeBatch = false;
        throw new Error("injected failure before transaction");
      }
      if (state.beforeBatch) {
        const operation = state.beforeBatch;
        state.beforeBatch = null;
        operation();
      }
      let statementIndex = 0;
      const results = database.transaction("IMMEDIATE", () =>
        statements.map(({ sql, params = [] }) => {
          const result = executeRun(database, sql, params);
          if (state.failAfterStatement === statementIndex) {
            state.failAfterStatement = null;
            throw new Error("injected mid-transaction failure");
          }
          statementIndex += 1;
          return result;
        })
      );
      if (state.throwAfterBatch) {
        state.throwAfterBatch = false;
        if (state.failQueryAfterBatch) {
          state.failQueryAfterBatch = false;
          state.failQueries += 1;
        }
        throw new Error("injected response loss after commit");
      }
      return {
        results,
        changes: results.reduce((sum, result) => sum + result.changes, 0),
      };
    },
    async currentGeneration() { return { ...state.generation }; },
    now() { return state.now; },
    randomUUID() { return deterministicUuid(state.uuid++); },
    broadcast(reason) {
      state.broadcasts.push(reason);
      if (state.broadcastThrows) throw new Error("injected broadcast failure");
    },
  };
  return {
    database,
    state,
    runtime,
    service: store.createVocabLexemeStorageService(runtime),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function resignReceipt(receipt) {
  const projection = structuredClone(receipt);
  delete projection.projectionSha256;
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(projection)),
  ));
  return {
    ...projection,
    projectionSha256: Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}

test("bulk loader binds generation, sorted complete lexemes, and full card or absence", async () => {
  const second = lexeme({
    id: "aaa_lexeme",
    normalized_key: "alpha",
    headword: "alpha",
    created_at: 50,
    updated_at: 60,
  });
  const context = await fixture({
    initialLexemes: [lexeme(), second],
    initialCards: [reviewCard()],
  });
  try {
    const expected = await context.service.loadVocabLexemeExpectedStates();
    assert.equal(store.isVocabLexemeExpectedSet(expected), true);
    assert.equal(expected.generationId, "legacy");
    assert.equal(expected.generationSequence, 0);
    assert.deepEqual(expected.entries.map(({ lexeme: row }) => row.id), [
      "aaa_lexeme",
      "lexeme_fixture",
    ]);
    assert.deepEqual(expected.entries[0], { lexeme: second, reviewCard: null });
    assert.deepEqual(expected.entries[1], {
      lexeme: lexeme(),
      reviewCard: reviewCard(),
    });
    assert.equal(Object.keys(expected.entries[1].lexeme).length, 13);
    assert.equal(Object.keys(expected.entries[1].reviewCard).length, 13);
    assert.equal(context.state.readLockCalls, 1);
    assert.equal(context.state.exclusiveLockCalls, 0);

    const single = await context.service.loadVocabLexemeExpectedState("aaa_lexeme");
    assert.deepEqual(single, {
      generationId: "legacy",
      generationSequence: 0,
      lexeme: second,
      reviewCard: null,
    });
    await assert.rejects(
      context.service.loadVocabLexemeExpectedState("missing_lexeme"),
      (error) => error instanceof store.VocabLexemeMutationError &&
        error.code === "changed",
    );
  } finally {
    context.database.close();
  }

  const empty = await fixture({ initialLexemes: [], initialCards: [] });
  try {
    assert.deepEqual(await empty.service.loadVocabLexemeExpectedStates(), {
      generationId: "legacy",
      generationSequence: 0,
      entries: [],
    });
  } finally {
    empty.database.close();
  }
});

test("prepare is query-only, snapshots before its first await, and note/star omit cards", async () => {
  const context = await fixture({ now: 500 });
  try {
    const expected = await context.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const mutable = structuredClone(expected);
    const preparing = context.service.prepareVocabLexemeNoteSave("first", mutable);
    mutable.lexeme.headword = "caller mutation";
    mutable.reviewCard.state = "new";
    const note = await preparing;
    assert.deepEqual(note.before.lexeme, expected.lexeme);
    assert.deepEqual(Object.keys(note.before).sort(), [
      "generationId", "generationSequence", "lexeme",
    ]);
    assert.equal(note.after.lexeme.notes, "first");
    assert.equal(note.after.lexeme.updated_at, 500);
    assert.equal(store.isVocabLexemeWriteReceipt(note), true);

    executeRun(
      context.database,
      "UPDATE vocab_review_cards SET due_at=due_at+1,updated_at=updated_at+1",
    );
    const star = await context.service.prepareVocabLexemeStarSet(true, expected);
    assert.equal(star.after.lexeme.starred, 1);
    assert.equal("reviewCard" in star.before, false);
    assert.equal(context.state.batchCalls, 0);
    assert.deepEqual(selectedLexeme(context.database), lexeme());
  } finally {
    context.database.close();
  }
});

test("two note writers from one view cannot lose an update", async () => {
  const context = await fixture({ now: 1_200 });
  try {
    const expected = await context.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const [first, stale] = await Promise.all([
      context.service.prepareVocabLexemeNoteSave("A", expected),
      context.service.prepareVocabLexemeNoteSave("B", expected),
    ]);
    assert.equal((await context.service.commitVocabLexemeWrite(first)).outcome, "saved");
    const batches = context.state.batchCalls;
    assert.equal((await context.service.commitVocabLexemeWrite(stale)).outcome, "changed");
    assert.equal(context.state.batchCalls, batches);
    assert.equal(selectedLexeme(context.database).notes, "A");
  } finally {
    context.database.close();
  }
});

test("all thirteen lexeme columns participate in prepare and transaction CAS", async () => {
  const replacements = {
    headword: "peer headword",
    normalized_key: "peer-key",
    pronunciation: "peer pronunciation",
    gloss_en: "peer gloss",
    explanation_en: "peer explanation",
    explanation_zh: "同伴解释",
    status: "learning",
    starred: 1,
    notes: "peer note",
    lookup_count: 4,
    created_at: 99,
    updated_at: 101,
  };
  for (const [field, replacement] of Object.entries(replacements)) {
    const context = await fixture();
    try {
      const expected = await context.service.loadVocabLexemeExpectedState("lexeme_fixture");
      executeRun(
        context.database,
        `UPDATE vocab_lexemes SET ${field}=? WHERE id=?`,
        [replacement, "lexeme_fixture"],
      );
      await assert.rejects(
        context.service.prepareVocabLexemeNoteSave("next", expected),
        (error) => error instanceof store.VocabLexemeMutationError &&
          error.code === "changed",
        field,
      );
    } finally {
      context.database.close();
    }

    const raced = await fixture();
    try {
      const expected = await raced.service.loadVocabLexemeExpectedState("lexeme_fixture");
      const receipt = await raced.service.prepareVocabLexemeNoteSave("next", expected);
      raced.state.beforeBatch = () => executeRun(
        raced.database,
        `UPDATE vocab_lexemes SET ${field}=? WHERE id=?`,
        [replacement, "lexeme_fixture"],
      );
      assert.equal(
        (await raced.service.commitVocabLexemeWrite(receipt)).outcome,
        "changed",
        field,
      );
      assert.equal(selectedLexeme(raced.database).notes, field === "notes" ? replacement : "");
      assert.equal(Number(raced.database.selectValue(
        "SELECT COUNT(*) FROM vocab_lexemes WHERE id='__vocab_lexeme_cas_abort__'",
      )), 0);
    } finally {
      raced.database.close();
    }
  }
});

test("generation replacement and missing rows invalidate snapshots and receipts", async () => {
  const context = await fixture();
  try {
    const expected = await context.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const receipt = await context.service.prepareVocabLexemeStarSet(true, expected);
    context.state.generation = {
      generationId: "22222222-2222-4222-8222-222222222222",
      sequence: 1,
    };
    await assert.rejects(
      context.service.prepareVocabLexemeStarSet(true, expected),
      (error) => error instanceof store.VocabLexemeMutationError &&
        error.code === "changed",
    );
    assert.equal(await context.service.inspectVocabLexemeWrite(receipt), "changed");
    assert.equal((await context.service.commitVocabLexemeWrite(receipt)).outcome, "changed");
    assert.equal(context.state.batchCalls, 0);

    context.state.generation = { generationId: "legacy", sequence: 0 };
    executeRun(context.database, "DELETE FROM vocab_lexemes WHERE id=?", [
      "lexeme_fixture",
    ]);
    assert.equal(await context.service.inspectVocabLexemeWrite(receipt), "changed");
    await assert.rejects(
      context.service.loadVocabLexemeExpectedState("lexeme_fixture"),
      (error) => error instanceof store.VocabLexemeMutationError &&
        error.code === "changed",
    );
  } finally {
    context.database.close();
  }
});

test("status reconciliation covers active, managed, unmanaged, missing-card and explanation states", async () => {
  const activeStates = ["new", "learning", "review", "relearning"];
  for (const activeState of activeStates) {
    const context = await fixture({
      initialCards: [reviewCard({ state: activeState, suspended_from_state: null })],
    });
    try {
      const expected = await context.service.loadVocabLexemeExpectedState("lexeme_fixture");
      const receipt = await context.service.prepareVocabLexemeStatusSet("known", expected);
      assert.deepEqual({
        state: receipt.after.reviewCard.state,
        from: receipt.after.reviewCard.suspended_from_state,
        reason: receipt.after.reviewCard.suspended_reason,
      }, {
        state: "suspended",
        from: activeState,
        reason: "lexeme_known",
      });
      assert.ok(receipt.after.reviewCard.updated_at > expected.reviewCard.updated_at);
      assert.equal((await context.service.commitVocabLexemeWrite(receipt)).outcome, "saved");
    } finally {
      context.database.close();
    }
  }

  for (const [target, expectedReason] of [
    ["saved", null],
    ["learning", null],
    ["known", "lexeme_known"],
    ["ignored", "lexeme_ignored"],
  ]) {
    const context = await fixture({ initialCards: [] });
    try {
      const expected = await context.service.loadVocabLexemeExpectedState("lexeme_fixture");
      const receipt = await context.service.prepareVocabLexemeStatusSet(target, expected);
      assert.match(receipt.after.reviewCard.id, /^card_/);
      assert.equal(
        receipt.after.reviewCard.state,
        expectedReason === null ? "new" : "suspended",
      );
      assert.equal(receipt.after.reviewCard.suspended_reason, expectedReason);
      assert.equal(store.isVocabLexemeWriteReceipt(receipt), true);
      assert.equal((await context.service.commitVocabLexemeWrite(receipt)).outcome, "saved");
    } finally {
      context.database.close();
    }
  }

  const missingExplanation = await fixture({
    initialLexemes: [lexeme({ gloss_en: "", explanation_en: "" })],
    initialCards: [],
  });
  try {
    const expected = await missingExplanation.service.loadVocabLexemeExpectedState(
      "lexeme_fixture",
    );
    const receipt = await missingExplanation.service.prepareVocabLexemeStatusSet(
      "saved",
      expected,
    );
    assert.equal(receipt.after.reviewCard.state, "suspended");
    assert.equal(receipt.after.reviewCard.suspended_reason, "missing_explanation");
  } finally {
    missingExplanation.database.close();
  }

  const managed = await fixture({
    initialCards: [reviewCard({
      state: "suspended",
      suspended_from_state: "relearning",
      suspended_reason: "lexeme_known",
    })],
  });
  try {
    const expected = await managed.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const receipt = await managed.service.prepareVocabLexemeStatusSet("saved", expected);
    assert.equal(receipt.after.reviewCard.state, "relearning");
    assert.equal(receipt.after.reviewCard.suspended_from_state, null);
    assert.equal(receipt.after.reviewCard.suspended_reason, null);
  } finally {
    managed.database.close();
  }

  const unmanagedCard = reviewCard({
    state: "suspended",
    suspended_from_state: "review",
    suspended_reason: "manual_pause",
  });
  const unmanaged = await fixture({ initialCards: [unmanagedCard] });
  try {
    const expected = await unmanaged.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const receipt = await unmanaged.service.prepareVocabLexemeStatusSet("ignored", expected);
    assert.deepEqual(receipt.after.reviewCard, {
      ...unmanagedCard,
      updated_at: receipt.after.reviewCard.updated_at,
    });
    assert.ok(receipt.after.reviewCard.updated_at > unmanagedCard.updated_at);
    assert.equal((await unmanaged.service.commitVocabLexemeWrite(receipt)).outcome, "saved");
    assert.deepEqual(selectedCard(unmanaged.database), receipt.after.reviewCard);
  } finally {
    unmanaged.database.close();
  }
});

test("status and rating are one-winner CAS operations and neither overwrites the other", async () => {
  const ratingWins = await fixture({ now: 2_000 });
  try {
    globalThis.__vocabLexemeDefaultRuntime = ratingWins.runtime;
    const expected = await ratingWins.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const status = await ratingWins.service.prepareVocabLexemeStatusSet("known", expected);
    const rating = await store.prepareVocabReviewRating(reviewCard(), "good");
    assert.equal((await store.commitVocabReviewRating(rating)).status, "exact");
    const ratedCard = selectedCard(ratingWins.database);
    assert.equal((await ratingWins.service.commitVocabLexemeWrite(status)).outcome, "changed");
    assert.deepEqual(selectedCard(ratingWins.database), ratedCard);
    assert.equal(selectedLexeme(ratingWins.database).status, "saved");
  } finally {
    delete globalThis.__vocabLexemeDefaultRuntime;
    ratingWins.database.close();
  }

  const statusWins = await fixture({ now: 2_100 });
  try {
    globalThis.__vocabLexemeDefaultRuntime = statusWins.runtime;
    const expected = await statusWins.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const status = await statusWins.service.prepareVocabLexemeStatusSet("known", expected);
    const rating = await store.prepareVocabReviewRating(reviewCard(), "easy");
    assert.equal((await statusWins.service.commitVocabLexemeWrite(status)).outcome, "saved");
    const suspended = selectedCard(statusWins.database);
    await assert.rejects(
      store.commitVocabReviewRating(rating),
      (error) => error?.code === "VOCAB_REVIEW_CHANGED",
    );
    assert.deepEqual(selectedCard(statusWins.database), suspended);
    assert.equal(selectedLexeme(statusWins.database).status, "known");
  } finally {
    delete globalThis.__vocabLexemeDefaultRuntime;
    statusWins.database.close();
  }
});

test("saved-learning status heartbeats make stale ratings lose in both commit orders", async () => {
  for (const [fromStatus, toStatus] of [
    ["saved", "learning"],
    ["learning", "saved"],
  ]) {
    for (const firstWriter of ["status", "rating"]) {
      const context = await fixture({
        now: 2_150,
        initialLexemes: [lexeme({ status: fromStatus })],
      });
      try {
        globalThis.__vocabLexemeDefaultRuntime = context.runtime;
        const expected = await context.service.loadVocabLexemeExpectedState(
          "lexeme_fixture",
        );
        const status = await context.service.prepareVocabLexemeStatusSet(
          toStatus,
          expected,
        );
        const beforeCard = structuredClone(status.before.reviewCard);
        const afterCard = structuredClone(status.after.reviewCard);
        assert.ok(afterCard.updated_at > beforeCard.updated_at);
        delete beforeCard.updated_at;
        delete afterCard.updated_at;
        assert.deepEqual(afterCard, beforeCard);
        const rating = await store.prepareVocabReviewRating(
          expected.reviewCard,
          "good",
        );

        if (firstWriter === "status") {
          assert.equal(
            (await context.service.commitVocabLexemeWrite(status)).outcome,
            "saved",
          );
          await assert.rejects(
            store.commitVocabReviewRating(rating),
            (error) => error?.code === "VOCAB_REVIEW_CHANGED",
          );
          assert.equal(selectedLexeme(context.database).status, toStatus);
          assert.equal(Number(context.database.selectValue(
            "SELECT COUNT(*) FROM vocab_review_events WHERE id=?",
            [rating.eventId],
          )), 0);
        } else {
          assert.equal((await store.commitVocabReviewRating(rating)).status, "exact");
          assert.equal(
            (await context.service.commitVocabLexemeWrite(status)).outcome,
            "changed",
          );
          assert.equal(selectedLexeme(context.database).status, fromStatus);
          assert.equal(Number(context.database.selectValue(
            "SELECT COUNT(*) FROM vocab_review_events WHERE id=?",
            [rating.eventId],
          )), 1);
        }
      } finally {
        delete globalThis.__vocabLexemeDefaultRuntime;
        context.database.close();
      }
    }
  }
});

test("a lost response after an active status heartbeat still settles exact", async () => {
  const context = await fixture({ now: 2_175 });
  try {
    const expected = await context.service.loadVocabLexemeExpectedState(
      "lexeme_fixture",
    );
    const receipt = await context.service.prepareVocabLexemeStatusSet(
      "learning",
      expected,
    );
    assert.ok(
      receipt.after.reviewCard.updated_at >
        receipt.before.reviewCard.updated_at,
    );
    context.state.throwAfterBatch = true;
    assert.equal(
      (await context.service.commitVocabLexemeWrite(receipt)).outcome,
      "saved",
    );
    assert.equal(
      await context.service.inspectVocabLexemeWrite(receipt),
      "exact_saved",
    );
    assert.equal(selectedLexeme(context.database).status, "learning");
    assert.equal(
      selectedCard(context.database).updated_at,
      receipt.after.reviewCard.updated_at,
    );
  } finally {
    context.database.close();
  }
});

test("note and star writes do not conflict with a concurrent card rating", async () => {
  for (const kind of ["note", "star"]) {
    const context = await fixture({ now: 2_200 });
    try {
      globalThis.__vocabLexemeDefaultRuntime = context.runtime;
      const expected = await context.service.loadVocabLexemeExpectedState("lexeme_fixture");
      const receipt = kind === "note"
        ? await context.service.prepareVocabLexemeNoteSave("parallel", expected)
        : await context.service.prepareVocabLexemeStarSet(true, expected);
      const rating = await store.prepareVocabReviewRating(reviewCard(), "good");
      assert.equal((await store.commitVocabReviewRating(rating)).status, "exact");
      const rated = selectedCard(context.database);
      assert.equal((await context.service.commitVocabLexemeWrite(receipt)).outcome, "saved");
      assert.deepEqual(selectedCard(context.database), rated);
      assert.equal(kind === "note"
        ? selectedLexeme(context.database).notes
        : selectedLexeme(context.database).starred, kind === "note" ? "parallel" : 1);
    } finally {
      delete globalThis.__vocabLexemeDefaultRuntime;
      context.database.close();
    }
  }
});

test("status CAS catches precheck races and card id occupation inside the transaction", async () => {
  const cardRace = await fixture({ now: 2_300 });
  try {
    const expected = await cardRace.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const receipt = await cardRace.service.prepareVocabLexemeStatusSet("known", expected);
    const beforeLexeme = selectedLexeme(cardRace.database);
    cardRace.state.beforeBatch = () => executeRun(
      cardRace.database,
      "UPDATE vocab_review_cards SET reps=reps+1,updated_at=updated_at+1 WHERE id=?",
      ["card_fixture"],
    );
    assert.equal((await cardRace.service.commitVocabLexemeWrite(receipt)).outcome, "changed");
    assert.deepEqual(selectedLexeme(cardRace.database), beforeLexeme);
    assert.equal(selectedCard(cardRace.database).reps, 5);
  } finally {
    cardRace.database.close();
  }

  const idRace = await fixture({ initialCards: [] });
  try {
    const expected = await idRace.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const receipt = await idRace.service.prepareVocabLexemeStatusSet("learning", expected);
    idRace.state.beforeBatch = () => {
      insertLexeme(idRace.database, lexeme({
        id: "lexeme_peer",
        normalized_key: "peer",
        headword: "peer",
      }));
      insertCard(idRace.database, reviewCard({
        id: receipt.after.reviewCard.id,
        lexeme_id: "lexeme_peer",
      }));
    };
    assert.equal((await idRace.service.commitVocabLexemeWrite(receipt)).outcome, "changed");
    assert.equal(selectedLexeme(idRace.database).status, "saved");
    assert.equal(Number(idRace.database.selectValue(
      "SELECT COUNT(*) FROM vocab_review_cards WHERE lexeme_id='lexeme_fixture'",
    )), 0);
  } finally {
    idRace.database.close();
  }
});

test("response loss settles exact, expected, changed, and unknown without unsafe replay", async () => {
  const exact = await fixture({ now: 3_000 });
  try {
    const expected = await exact.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const receipt = await exact.service.prepareVocabLexemeNoteSave("durable", expected);
    exact.state.throwAfterBatch = true;
    exact.state.broadcastThrows = true;
    assert.equal((await exact.service.commitVocabLexemeWrite(receipt)).outcome, "saved");
    assert.equal(await exact.service.inspectVocabLexemeWrite(receipt), "exact_saved");
    const batches = exact.state.batchCalls;
    assert.equal((await exact.service.commitVocabLexemeWrite(receipt)).outcome, "already_saved");
    assert.equal(exact.state.batchCalls, batches);
  } finally {
    exact.database.close();
  }

  const expectedState = await fixture({ now: 3_100 });
  try {
    const expected = await expectedState.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const receipt = await expectedState.service.prepareVocabLexemeStarSet(true, expected);
    expectedState.state.throwBeforeBatch = true;
    await assert.rejects(
      expectedState.service.commitVocabLexemeWrite(receipt),
      (error) => error instanceof store.VocabLexemeMutationError &&
        error.code === "write_failed" && error.receipt.operationId === receipt.operationId,
    );
    assert.equal(await expectedState.service.inspectVocabLexemeWrite(receipt), "expected");
  } finally {
    expectedState.database.close();
  }

  const changed = await fixture({ now: 3_200 });
  try {
    const expected = await changed.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const receipt = await changed.service.prepareVocabLexemeNoteSave("mine", expected);
    changed.state.beforeBatch = () => executeRun(
      changed.database,
      "UPDATE vocab_lexemes SET notes='peer',updated_at=updated_at+1 WHERE id=?",
      ["lexeme_fixture"],
    );
    assert.equal((await changed.service.commitVocabLexemeWrite(receipt)).outcome, "changed");
    assert.equal(selectedLexeme(changed.database).notes, "peer");
  } finally {
    changed.database.close();
  }

  const unknown = await fixture({ now: 3_300 });
  try {
    const expected = await unknown.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const receipt = await unknown.service.prepareVocabLexemeStarSet(true, expected);
    unknown.state.throwAfterBatch = true;
    unknown.state.failQueryAfterBatch = true;
    assert.equal(
      (await unknown.service.commitVocabLexemeWrite(receipt)).outcome,
      "outcome_uncertain",
    );
    assert.equal(await unknown.service.inspectVocabLexemeWrite(receipt), "exact_saved");
    const batches = unknown.state.batchCalls;
    assert.equal((await unknown.service.commitVocabLexemeWrite(receipt)).outcome, "already_saved");
    assert.equal(unknown.state.batchCalls, batches);
  } finally {
    unknown.database.close();
  }
});

test("a mid-transaction fault rolls lexeme and review card changes back together", async () => {
  const context = await fixture({ now: 3_400 });
  try {
    const beforeLexeme = selectedLexeme(context.database);
    const beforeCard = selectedCard(context.database);
    const expected = await context.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const receipt = await context.service.prepareVocabLexemeStatusSet("ignored", expected);
    context.state.failAfterStatement = 1;
    await assert.rejects(
      context.service.commitVocabLexemeWrite(receipt),
      (error) => error instanceof store.VocabLexemeMutationError &&
        error.code === "write_failed",
    );
    assert.deepEqual(selectedLexeme(context.database), beforeLexeme);
    assert.deepEqual(selectedCard(context.database), beforeCard);
    assert.equal(await context.service.inspectVocabLexemeWrite(receipt), "expected");
  } finally {
    context.database.close();
  }
});

test("timestamps stay monotonic through clock rollback", async () => {
  const context = await fixture({
    now: 1,
    initialLexemes: [lexeme({ updated_at: 5_000 })],
    initialCards: [reviewCard({ updated_at: 8_000 })],
  });
  try {
    const expected = await context.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const note = await context.service.prepareVocabLexemeNoteSave("rollback", expected);
    assert.equal(note.after.lexeme.updated_at, 5_001);
    const status = await context.service.prepareVocabLexemeStatusSet("known", expected);
    assert.equal(status.after.lexeme.updated_at, 5_001);
    assert.equal(status.after.reviewCard.updated_at, 8_001);
  } finally {
    context.database.close();
  }
});

test("tampering, resigned semantic forgery, oversize input, and caller mutation fail closed", async () => {
  const context = await fixture({ now: 3_500 });
  try {
    const expected = await context.service.loadVocabLexemeExpectedState("lexeme_fixture");
    const receipt = await context.service.prepareVocabLexemeNoteSave("sealed", expected);
    const hashTamper = structuredClone(receipt);
    hashTamper.after.lexeme.notes = "tampered";
    assert.equal(store.isVocabLexemeWriteReceipt(hashTamper), true);
    assert.equal(await context.service.inspectVocabLexemeWrite(hashTamper), "invalid_receipt");

    const semantic = structuredClone(receipt);
    semantic.after.lexeme.status = "known";
    assert.equal(store.isVocabLexemeWriteReceipt(await resignReceipt(semantic)), false);

    const mixedGeneration = structuredClone(receipt);
    mixedGeneration.after.generationSequence = 1;
    assert.equal(store.isVocabLexemeWriteReceipt(
      await resignReceipt(mixedGeneration),
    ), false);

    const oversized = structuredClone(receipt);
    oversized.after.lexeme.notes = "x".repeat(1_100_000);
    assert.equal(store.isVocabLexemeWriteReceipt(await resignReceipt(oversized)), false);

    const mutable = structuredClone(receipt);
    const committing = context.service.commitVocabLexemeWrite(mutable);
    mutable.after.lexeme.notes = "caller changed";
    mutable.after.lexeme.headword = "caller changed";
    assert.equal((await committing).outcome, "saved");
    assert.equal(selectedLexeme(context.database).notes, "sealed");
    assert.equal(selectedLexeme(context.database).headword, "steady");
  } finally {
    context.database.close();
  }
});

test("without Web Locks default reads work and every durable write callback stays at zero", async () => {
  const context = await fixture({ now: 3_600 });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    globalThis.__vocabLexemeDefaultRuntime = context.runtime;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: undefined,
    });
    const all = await store.loadVocabLexemeExpectedStates();
    const expected = await store.loadVocabLexemeExpectedState("lexeme_fixture");
    assert.equal(all.entries.length, 1);
    const customReceipt = await context.service.prepareVocabLexemeStarSet(true, expected);
    const callbacksBefore = context.state.exclusiveLockCalls;
    const queriesBefore = context.state.queryCalls;
    await assert.rejects(
      store.prepareVocabLexemeStarSet(true, expected),
      (error) => error instanceof store.VocabLexemeMutationError &&
        error.code === "inspect_failed",
    );
    assert.equal(await store.inspectVocabLexemeWrite(customReceipt), "still_unknown");
    assert.equal(
      (await store.commitVocabLexemeWrite(customReceipt)).outcome,
      "outcome_uncertain",
    );
    assert.equal(context.state.exclusiveLockCalls, callbacksBefore);
    assert.equal(context.state.queryCalls, queriesBefore);
    assert.equal(context.state.batchCalls, 0);
    assert.deepEqual(selectedLexeme(context.database), lexeme());
  } finally {
    delete globalThis.__vocabLexemeDefaultRuntime;
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
    context.database.close();
  }
});
