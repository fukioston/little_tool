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
  export async function withVocabReadLock(task) { return task(); }
  export async function withVocabWriteLock(task) { return task(); }
  export function broadcastVocabChange(reason) {
    globalThis.__vocabEngagementDefaultRuntime?.broadcast(reason);
  }
`);
let storeJavaScript = rawStoreJavaScript;
for (const [specifier, url] of Object.entries({
  "@/lib/local-db/client": moduleUrl(`
    function runtime() {
      const value = globalThis.__vocabEngagementDefaultRuntime;
      if (!value) throw new Error("default localDb must not be used without a fixture");
      return value;
    }
    export const localDb = {
      query(_database, sql, params) { return runtime().query(sql, params); },
      batch(_database, statements) { return runtime().batch(statements); },
      currentGeneration() { return runtime().currentGeneration(); },
      init() { throw new Error("not used in engagement service tests"); },
      run() { throw new Error("not used in engagement service tests"); }
    };
  `),
  "./content": moduleUrl(`
    export function uid(prefix) { return prefix + "_legacy_unused"; }
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
      // Consume rows returned by statements such as PRAGMA.
    }
  } finally {
    statement.finalize();
  }
  return { changes: Number(database.changes()), lastInsertRowId: null };
}

function deterministicUuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function item(overrides = {}) {
  return {
    id: "article_engagement",
    kind: "article",
    title: "Durable engagement",
    description: "Every observed item field is bound.",
    source: "fixture",
    source_url: null,
    author: "Reader",
    published_at: "2026-08-22",
    duration_ms: 0,
    audio_url: null,
    status: "unread",
    progress: 0,
    created_at: 100,
    updated_at: 100,
    ...overrides,
  };
}

function insertItem(database, value) {
  executeRun(
    database,
    `INSERT INTO vocab_items(
      id,kind,title,description,source,source_url,author,published_at,
      duration_ms,audio_url,status,progress,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      value.id, value.kind, value.title, value.description, value.source,
      value.source_url, value.author, value.published_at, value.duration_ms,
      value.audio_url, value.status, value.progress, value.created_at, value.updated_at,
    ],
  );
}

function insertBookmark(database, value) {
  executeRun(
    database,
    `INSERT INTO vocab_bookmarks(id,item_id,locator,label,note,created_at)
      VALUES(?,?,?,?,?,?)`,
    [
      value.id, value.item_id, value.locator, value.label, value.note,
      value.created_at,
    ],
  );
}

function bookmarkRows(database) {
  return database.selectObjects(
    `SELECT id,item_id,locator,label,note,created_at
      FROM vocab_bookmarks ORDER BY id`,
  ).map((row) => ({ ...row }));
}

function activityRows(database) {
  return database.selectObjects(
    `SELECT id,day,read_seconds,listen_seconds,review_count,lookups,created_at
      FROM vocab_activity ORDER BY id`,
  ).map((row) => ({ ...row }));
}

async function fixture({
  now = Date.UTC(2026, 7, 22, 16, 30),
  timezoneOffsetMinutes = -480,
  initialItem = item(),
} = {}) {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE vocab_items (
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
    status TEXT NOT NULL DEFAULT 'unread'
      CHECK (status IN ('unread','in_progress','complete','archived')),
    progress REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE vocab_bookmarks (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES vocab_items(id) ON DELETE CASCADE,
    locator TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE vocab_activity (
    id TEXT PRIMARY KEY,
    day TEXT NOT NULL,
    read_seconds INTEGER NOT NULL DEFAULT 0,
    listen_seconds INTEGER NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    lookups INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );`);
  if (initialItem) insertItem(database, initialItem);
  const state = {
    now,
    timezoneOffsetMinutes,
    generation: { generationId: "legacy", sequence: 0 },
    uuid: 1,
    readLockCalls: 0,
    exclusiveLockCalls: 0,
    queryCalls: 0,
    batchCalls: 0,
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
      if (state.throwBeforeBatch) {
        state.throwBeforeBatch = false;
        throw new Error("injected failure before transaction");
      }
      if (state.beforeBatch) {
        const operation = state.beforeBatch;
        state.beforeBatch = null;
        operation();
      }
      const results = database.transaction("IMMEDIATE", () =>
        statements.map(({ sql, params = [] }, index) => {
          const result = executeRun(database, sql, params);
          if (state.failAfterStatement === index) {
            throw new Error("injected mid-transaction failure");
          }
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
    timezoneOffsetMinutes() { return state.timezoneOffsetMinutes; },
    broadcast(reason) {
      state.broadcasts.push(reason);
      if (state.broadcastThrows) throw new Error("injected broadcast failure");
    },
  };
  return {
    database,
    state,
    runtime,
    service: store.createVocabEngagementStorageService(runtime),
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

test("prepare snapshots bookmark/activity inputs before await and performs zero writes", async () => {
  const context = await fixture({ now: 50, initialItem: item({ updated_at: 100 }) });
  try {
    const expected = await context.service.loadVocabBookmarkExpectedState(
      "article_engagement",
      "block:0",
    );
    assert.deepEqual(expected, {
      generationId: "legacy",
      generationSequence: 0,
      item: item({ updated_at: 100 }),
      locator: "block:0",
      bookmarks: [],
    });
    const mutableInput = {
      itemId: "article_engagement",
      locator: "block:0",
      label: "First paragraph",
    };
    const mutableExpected = structuredClone(expected);
    const preparingBookmark = context.service.prepareVocabBookmarkCreate(
      mutableInput,
      mutableExpected,
    );
    mutableInput.label = "caller mutation";
    mutableExpected.item.title = "caller mutation";
    const bookmark = await preparingBookmark;
    assert.equal(bookmark.request.label, "First paragraph");
    assert.equal(bookmark.expected.item.title, "Durable engagement");
    assert.equal(bookmark.target.created_at, 101, "clock rollback is advanced");
    assert.equal(store.isVocabEngagementWriteReceipt(bookmark), true);

    const generation = await context.service.loadVocabEngagementGenerationExpectation();
    const activityInput = {
      kind: "read",
      seconds: 15,
      recordedAt: 1_777_777,
      timezoneOffsetMinutes: 480,
    };
    const mutableGeneration = structuredClone(generation);
    const preparingActivity = context.service.prepareVocabStudyActivityRecord(
      activityInput,
      mutableGeneration,
    );
    activityInput.kind = "listen";
    activityInput.seconds = 99;
    activityInput.timezoneOffsetMinutes = -840;
    mutableGeneration.generationSequence = 9;
    const activity = await preparingActivity;
    assert.deepEqual(activity.request, {
      kind: "read",
      seconds: 15,
      recordedAt: 1_777_777,
    });
    assert.equal(activity.target.read_seconds, 15);
    assert.equal(activity.target.listen_seconds, 0);
    assert.equal(activity.timezoneOffsetMinutes, 480);
    assert.equal(store.isVocabEngagementWriteReceipt(activity), true);
    assert.equal(context.state.batchCalls, 0);
    assert.deepEqual(bookmarkRows(context.database), []);
    assert.deepEqual(activityRows(context.database), []);
  } finally {
    context.database.close();
  }
});

test("strict input bounds, enums, timestamps, and occupied natural keys fail with zero writes", async () => {
  const context = await fixture();
  try {
    const expected = await context.service.loadVocabBookmarkExpectedState(
      "article_engagement",
      "block:0",
    );
    for (const input of [
      { itemId: "", locator: "block:0", label: "x" },
      { itemId: "article_engagement", locator: "", label: "x" },
      { itemId: "article_engagement", locator: "bad\nlocator", label: "x" },
      { itemId: "article_engagement", locator: "block:0", label: "bad\u0000" },
      { itemId: "article_engagement", locator: "x".repeat(2_049), label: "x" },
      { itemId: "article_engagement", locator: "block:0", label: "x".repeat(4_097) },
    ]) {
      await assert.rejects(
        context.service.prepareVocabBookmarkCreate(input, expected),
        (error) => error instanceof store.VocabEngagementMutationError &&
          error.code === "invalid_input",
      );
    }
    const generation = await context.service.loadVocabEngagementGenerationExpectation();
    for (const input of [
      { kind: "review", seconds: 15 },
      { kind: "read", seconds: 0 },
      { kind: "listen", seconds: 1.5 },
      { kind: "read", seconds: 86_401 },
      { kind: "read", seconds: Number.NaN },
      { kind: "read", seconds: 15, recordedAt: -1 },
      { kind: "read", seconds: 15, timezoneOffsetMinutes: 480 },
      {
        kind: "read",
        seconds: 15,
        recordedAt: 1_777_777,
        timezoneOffsetMinutes: 1.5,
      },
      {
        kind: "read",
        seconds: 15,
        recordedAt: 1_777_777,
        timezoneOffsetMinutes: 1_441,
      },
    ]) {
      await assert.rejects(
        context.service.prepareVocabStudyActivityRecord(input, generation),
        (error) => error instanceof store.VocabEngagementMutationError &&
          error.code === "invalid_input",
      );
    }
    insertBookmark(context.database, {
      id: "bookmark_existing",
      item_id: "article_engagement",
      locator: "block:0",
      label: "peer",
      note: "",
      created_at: 200,
    });
    const occupied = await context.service.loadVocabBookmarkExpectedState(
      "article_engagement",
      "block:0",
    );
    await assert.rejects(
      context.service.prepareVocabBookmarkCreate({
        itemId: "article_engagement",
        locator: "block:0",
        label: "peer",
      }, occupied),
      (error) => error instanceof store.VocabEngagementMutationError &&
        error.code === "changed",
    );
    assert.equal(context.state.batchCalls, 0);
  } finally {
    context.database.close();
  }
});

test("bookmark prepare binds every item field, natural-key absence, item existence, and generation", async () => {
  for (const [field, value] of [
    ["title", "peer title"],
    ["source_url", "https://peer.test/source"],
    ["audio_url", "https://peer.test/audio"],
    ["status", "in_progress"],
    ["progress", 0.25],
    ["updated_at", 101],
  ]) {
    const context = await fixture();
    try {
      const expected = await context.service.loadVocabBookmarkExpectedState(
        "article_engagement",
        "block:0",
      );
      executeRun(
        context.database,
        `UPDATE vocab_items SET ${field}=? WHERE id=?`,
        [value, "article_engagement"],
      );
      await assert.rejects(
        context.service.prepareVocabBookmarkCreate({
          itemId: "article_engagement",
          locator: "block:0",
          label: "saved",
        }, expected),
        (error) => error instanceof store.VocabEngagementMutationError &&
          error.code === "changed",
        field,
      );
      assert.equal(context.state.batchCalls, 0, field);
    } finally {
      context.database.close();
    }
  }

  const naturalKey = await fixture();
  try {
    const expected = await naturalKey.service.loadVocabBookmarkExpectedState(
      "article_engagement",
      "block:0",
    );
    insertBookmark(naturalKey.database, {
      id: "bookmark_peer",
      item_id: "article_engagement",
      locator: "block:0",
      label: "peer",
      note: "",
      created_at: 200,
    });
    await assert.rejects(
      naturalKey.service.prepareVocabBookmarkCreate({
        itemId: "article_engagement",
        locator: "block:0",
        label: "ours",
      }, expected),
      (error) => error instanceof store.VocabEngagementMutationError &&
        error.code === "changed",
    );
    executeRun(naturalKey.database, "DELETE FROM vocab_items WHERE id=?", [
      "article_engagement",
    ]);
    await assert.rejects(
      naturalKey.service.prepareVocabBookmarkCreate({
        itemId: "article_engagement",
        locator: "block:0",
        label: "ours",
      }, expected),
      (error) => error instanceof store.VocabEngagementMutationError &&
        error.code === "changed",
    );
  } finally {
    naturalKey.database.close();
  }

  const generationChange = await fixture();
  try {
    const bookmarkExpected = await generationChange.service
      .loadVocabBookmarkExpectedState("article_engagement", "block:0");
    const activityExpected = await generationChange.service
      .loadVocabEngagementGenerationExpectation();
    generationChange.state.generation = {
      generationId: "22222222-2222-4222-8222-222222222222",
      sequence: 1,
    };
    await assert.rejects(
      generationChange.service.prepareVocabBookmarkCreate({
        itemId: "article_engagement",
        locator: "block:0",
        label: "ours",
      }, bookmarkExpected),
      (error) => error instanceof store.VocabEngagementMutationError &&
        error.code === "changed",
    );
    await assert.rejects(
      generationChange.service.prepareVocabStudyActivityRecord({
        kind: "read",
        seconds: 15,
      }, activityExpected),
      (error) => error instanceof store.VocabEngagementMutationError &&
        error.code === "changed",
    );
    assert.equal(generationChange.state.batchCalls, 0);
  } finally {
    generationChange.database.close();
  }
});

test("successful commits inspect exact, replay without duplicates, and ignore broadcast loss", async () => {
  const context = await fixture();
  try {
    const expected = await context.service.loadVocabBookmarkExpectedState(
      "article_engagement",
      "block:0",
    );
    const bookmark = await context.service.prepareVocabBookmarkCreate({
      itemId: "article_engagement",
      locator: "block:0",
      label: "Paragraph one",
    }, expected);
    context.state.broadcastThrows = true;
    const first = await context.service.commitVocabEngagementWrite(bookmark);
    assert.equal(first.outcome, "saved");
    assert.equal(await context.service.inspectVocabEngagementWrite(bookmark), "exact_saved");
    assert.equal(
      (await context.service.commitVocabEngagementWrite(bookmark)).outcome,
      "already_saved",
    );
    assert.deepEqual(bookmarkRows(context.database), [bookmark.target]);

    const generation = await context.service.loadVocabEngagementGenerationExpectation();
    const activity = await context.service.prepareVocabStudyActivityRecord({
      kind: "listen",
      seconds: 30,
      recordedAt: Date.UTC(2026, 7, 22, 16, 30),
    }, generation);
    assert.equal((await context.service.commitVocabEngagementWrite(activity)).outcome, "saved");
    assert.equal(
      (await context.service.commitVocabEngagementWrite(activity)).outcome,
      "already_saved",
    );
    assert.deepEqual(activityRows(context.database), [activity.target]);
    assert.equal(context.state.broadcasts.includes("bookmark-created"), true);
    assert.equal(context.state.broadcasts.includes("study-time-recorded"), true);
  } finally {
    context.database.close();
  }
});

test("bookmark note and delete are durable, recover response loss, and reject a cross-tab stale peer", async () => {
  const context = await fixture();
  try {
    const empty = await context.service.loadVocabBookmarkExpectedState(
      "article_engagement",
      "block:0",
    );
    const created = await context.service.prepareVocabBookmarkCreate({
      itemId: "article_engagement",
      locator: "block:0",
      label: "Paragraph one",
    }, empty);
    assert.equal(
      (await context.service.commitVocabEngagementWrite(created)).outcome,
      "saved",
    );

    const beforeNote = await context.service.loadVocabBookmarkExpectedState(
      "article_engagement",
      "block:0",
    );
    const noted = await context.service.prepareVocabBookmarkNoteSet({
      itemId: "article_engagement",
      locator: "block:0",
      bookmarkId: created.target.id,
      note: "Review this contrast",
    }, beforeNote);
    context.state.throwAfterBatch = true;
    context.state.failQueryAfterBatch = true;
    assert.equal(
      (await context.service.commitVocabEngagementWrite(noted)).outcome,
      "outcome_uncertain",
    );
    assert.equal(
      await context.service.inspectVocabEngagementWrite(noted),
      "exact_saved",
    );
    assert.equal(bookmarkRows(context.database)[0].note, "Review this contrast");

    const beforeRace = await context.service.loadVocabBookmarkExpectedState(
      "article_engagement",
      "block:0",
    );
    const peerService = store.createVocabEngagementStorageService(context.runtime);
    const noteAgain = await context.service.prepareVocabBookmarkNoteSet({
      itemId: "article_engagement",
      locator: "block:0",
      bookmarkId: created.target.id,
      note: "Peer note",
    }, beforeRace);
    const remove = await peerService.prepareVocabBookmarkDelete({
      itemId: "article_engagement",
      locator: "block:0",
      bookmarkId: created.target.id,
    }, beforeRace);
    const raced = await Promise.all([
      context.service.commitVocabEngagementWrite(noteAgain),
      peerService.commitVocabEngagementWrite(remove),
    ]);
    assert.deepEqual(
      raced.map(({ outcome }) => outcome).sort(),
      ["changed", "saved"],
    );
    const winner = raced[0].outcome === "saved" ? noteAgain : remove;
    assert.equal(
      await context.service.inspectVocabEngagementWrite(winner),
      "exact_saved",
    );
    if (bookmarkRows(context.database).length > 0) {
      const latest = await context.service.loadVocabBookmarkExpectedState(
        "article_engagement",
        "block:0",
      );
      const durableDelete = await context.service.prepareVocabBookmarkDelete({
        itemId: "article_engagement",
        locator: "block:0",
        bookmarkId: created.target.id,
      }, latest);
      assert.equal(
        (await context.service.commitVocabEngagementWrite(durableDelete)).outcome,
        "saved",
      );
      assert.equal(
        await context.service.inspectVocabEngagementWrite(durableDelete),
        "exact_saved",
      );
    }
    assert.deepEqual(bookmarkRows(context.database), []);
    assert.equal(
      context.state.broadcasts.some((reason) =>
        reason === "bookmark-note-set" || reason === "bookmark-deleted"
      ),
      true,
    );
  } finally {
    context.database.close();
  }
});

test("same-view/cross-service bookmark race stores one row despite no natural-key UNIQUE", async () => {
  const context = await fixture();
  try {
    const schema = String(context.database.selectValue(
      "SELECT sql FROM sqlite_schema WHERE type='table' AND name='vocab_bookmarks'",
    ));
    assert.doesNotMatch(schema, /UNIQUE\s*\(\s*item_id\s*,\s*locator/i);
    const expected = await context.service.loadVocabBookmarkExpectedState(
      "article_engagement",
      "block:0",
    );
    const peerService = store.createVocabEngagementStorageService(context.runtime);
    const [left, right] = await Promise.all([
      context.service.prepareVocabBookmarkCreate({
        itemId: "article_engagement",
        locator: "block:0",
        label: "left",
      }, expected),
      peerService.prepareVocabBookmarkCreate({
        itemId: "article_engagement",
        locator: "block:0",
        label: "right",
      }, expected),
    ]);
    const results = await Promise.all([
      context.service.commitVocabEngagementWrite(left),
      peerService.commitVocabEngagementWrite(right),
    ]);
    assert.deepEqual(results.map(({ outcome }) => outcome).sort(), ["changed", "saved"]);
    assert.equal(bookmarkRows(context.database).length, 1);
    const loser = results[0].outcome === "changed" ? left : right;
    assert.equal(await context.service.inspectVocabEngagementWrite(loser), "changed");
  } finally {
    context.database.close();
  }
});

test("transaction sentinels close precheck-to-transaction races without overwriting peers", async () => {
  const bookmarkContext = await fixture();
  try {
    const expected = await bookmarkContext.service.loadVocabBookmarkExpectedState(
      "article_engagement",
      "block:0",
    );
    const receipt = await bookmarkContext.service.prepareVocabBookmarkCreate({
      itemId: "article_engagement",
      locator: "block:0",
      label: "ours",
    }, expected);
    const peer = {
      id: "bookmark_peer",
      item_id: "article_engagement",
      locator: "block:0",
      label: "peer",
      note: "",
      created_at: 500,
    };
    bookmarkContext.state.beforeBatch = () => insertBookmark(
      bookmarkContext.database,
      peer,
    );
    const result = await bookmarkContext.service.commitVocabEngagementWrite(receipt);
    assert.equal(result.outcome, "changed");
    assert.deepEqual(bookmarkRows(bookmarkContext.database), [peer]);
  } finally {
    bookmarkContext.database.close();
  }

  const activityContext = await fixture();
  try {
    const expected = await activityContext.service
      .loadVocabEngagementGenerationExpectation();
    const receipt = await activityContext.service.prepareVocabStudyActivityRecord({
      kind: "read",
      seconds: 15,
      recordedAt: 1_000,
    }, expected);
    activityContext.state.beforeBatch = () => executeRun(
      activityContext.database,
      `INSERT INTO vocab_activity(
        id,day,read_seconds,listen_seconds,review_count,lookups,created_at
      ) VALUES(?,?,?,?,?,?,?)`,
      [receipt.target.id, "1999-01-01", 1, 0, 0, 0, 2],
    );
    const result = await activityContext.service.commitVocabEngagementWrite(receipt);
    assert.equal(result.outcome, "changed");
    assert.deepEqual(activityRows(activityContext.database), [{
      id: receipt.target.id,
      day: "1999-01-01",
      read_seconds: 1,
      listen_seconds: 0,
      review_count: 0,
      lookups: 0,
      created_at: 2,
    }]);
  } finally {
    activityContext.database.close();
  }
});

test("response plus readback loss returns uncertain, then the same receipt recovers exactly once", async () => {
  for (const kind of ["bookmark", "activity"]) {
    const context = await fixture();
    try {
      let receipt;
      if (kind === "bookmark") {
        const expected = await context.service.loadVocabBookmarkExpectedState(
          "article_engagement",
          "block:0",
        );
        receipt = await context.service.prepareVocabBookmarkCreate({
          itemId: "article_engagement",
          locator: "block:0",
          label: "recover",
        }, expected);
      } else {
        const expected = await context.service
          .loadVocabEngagementGenerationExpectation();
        receipt = await context.service.prepareVocabStudyActivityRecord({
          kind: "listen",
          seconds: 30,
          recordedAt: 1_000,
        }, expected);
      }
      context.state.throwAfterBatch = true;
      context.state.failQueryAfterBatch = true;
      const uncertain = await context.service.commitVocabEngagementWrite(receipt);
      assert.equal(uncertain.outcome, "outcome_uncertain", kind);
      assert.equal(await context.service.inspectVocabEngagementWrite(receipt), "exact_saved");
      assert.equal(
        (await context.service.commitVocabEngagementWrite(receipt)).outcome,
        "already_saved",
        kind,
      );
      assert.equal(
        kind === "bookmark"
          ? bookmarkRows(context.database).length
          : activityRows(context.database).length,
        1,
        kind,
      );
    } finally {
      context.database.close();
    }
  }
});

test("mid-transaction failures roll back targets and remain retryable with the original receipt", async () => {
  for (const kind of ["bookmark", "activity"]) {
    const context = await fixture();
    try {
      let receipt;
      if (kind === "bookmark") {
        const expected = await context.service.loadVocabBookmarkExpectedState(
          "article_engagement",
          "block:0",
        );
        receipt = await context.service.prepareVocabBookmarkCreate({
          itemId: "article_engagement",
          locator: "block:0",
          label: "rollback",
        }, expected);
      } else {
        const expected = await context.service
          .loadVocabEngagementGenerationExpectation();
        receipt = await context.service.prepareVocabStudyActivityRecord({
          kind: "read",
          seconds: 15,
          recordedAt: 2_000,
        }, expected);
      }
      context.state.failAfterStatement = 1;
      await assert.rejects(
        context.service.commitVocabEngagementWrite(receipt),
        (error) => error instanceof store.VocabEngagementMutationError &&
          error.code === "write_failed" && error.receipt.operationId === receipt.operationId,
        kind,
      );
      assert.equal(
        kind === "bookmark"
          ? bookmarkRows(context.database).length
          : activityRows(context.database).length,
        0,
        kind,
      );
      context.state.failAfterStatement = null;
      assert.equal(
        (await context.service.commitVocabEngagementWrite(receipt)).outcome,
        "saved",
        kind,
      );
    } finally {
      context.database.close();
    }
  }
});

test("generation sequence prevents ABA replay and bookmark item deletion cannot recreate ownership", async () => {
  const context = await fixture();
  try {
    const bookmarkExpected = await context.service.loadVocabBookmarkExpectedState(
      "article_engagement",
      "block:0",
    );
    const bookmark = await context.service.prepareVocabBookmarkCreate({
      itemId: "article_engagement",
      locator: "block:0",
      label: "stale",
    }, bookmarkExpected);
    const activityExpected = await context.service
      .loadVocabEngagementGenerationExpectation();
    const activity = await context.service.prepareVocabStudyActivityRecord({
      kind: "read",
      seconds: 15,
      recordedAt: 2_000,
    }, activityExpected);

    context.state.generation = {
      generationId: "22222222-2222-4222-8222-222222222222",
      sequence: 1,
    };
    context.state.generation = { generationId: "legacy", sequence: 2 };
    assert.equal(
      (await context.service.commitVocabEngagementWrite(bookmark)).outcome,
      "changed",
    );
    assert.equal(
      (await context.service.commitVocabEngagementWrite(activity)).outcome,
      "changed",
    );
    assert.equal(context.state.batchCalls, 0);
    assert.deepEqual(bookmarkRows(context.database), []);
    assert.deepEqual(activityRows(context.database), []);

    context.state.generation = { generationId: "legacy", sequence: 0 };
    executeRun(context.database, "DELETE FROM vocab_items WHERE id=?", [
      "article_engagement",
    ]);
    assert.equal(
      (await context.service.commitVocabEngagementWrite(bookmark)).outcome,
      "changed",
    );
    assert.equal(context.state.batchCalls, 0);
  } finally {
    context.database.close();
  }
});

test("later target divergence is changed; raw same-generation tombstone is the documented marker-free boundary", async () => {
  const context = await fixture();
  try {
    const generation = await context.service.loadVocabEngagementGenerationExpectation();
    const receipt = await context.service.prepareVocabStudyActivityRecord({
      kind: "read",
      seconds: 15,
      recordedAt: 3_000,
    }, generation);
    await context.service.commitVocabEngagementWrite(receipt);
    executeRun(
      context.database,
      "UPDATE vocab_activity SET read_seconds=16 WHERE id=?",
      [receipt.target.id],
    );
    assert.equal(await context.service.inspectVocabEngagementWrite(receipt), "changed");
    assert.equal(
      (await context.service.commitVocabEngagementWrite(receipt)).outcome,
      "changed",
    );

    executeRun(context.database, "DELETE FROM vocab_activity WHERE id=?", [
      receipt.target.id,
    ]);
    // There is no product delete path for generated activity rows. Without a
    // per-operation tombstone, direct SQL deletion is indistinguishable from a
    // never-committed receipt and deliberately remains retryable.
    assert.equal(await context.service.inspectVocabEngagementWrite(receipt), "expected");
  } finally {
    context.database.close();
  }
});

test("tampering, re-signed broken transitions, and oversized receipts fail before writes", async () => {
  const context = await fixture();
  try {
    const expected = await context.service.loadVocabBookmarkExpectedState(
      "article_engagement",
      "block:0",
    );
    const receipt = await context.service.prepareVocabBookmarkCreate({
      itemId: "article_engagement",
      locator: "block:0",
      label: "sealed",
    }, expected);
    const hashTamper = structuredClone(receipt);
    hashTamper.target.label = "changed";
    assert.equal(
      await context.service.inspectVocabEngagementWrite(hashTamper),
      "invalid_receipt",
    );
    await assert.rejects(
      context.service.commitVocabEngagementWrite(hashTamper),
      (error) => error instanceof store.VocabEngagementMutationError &&
        error.code === "invalid_receipt",
    );

    const resignedMismatch = await resignReceipt(hashTamper);
    assert.equal(store.isVocabEngagementWriteReceipt(resignedMismatch), false);
    assert.equal(
      await context.service.inspectVocabEngagementWrite(resignedMismatch),
      "invalid_receipt",
    );

    const oversized = structuredClone(receipt);
    oversized.request.label = "x".repeat(1_048_577);
    oversized.target.label = oversized.request.label;
    const resignedOversized = await resignReceipt(oversized);
    assert.equal(store.isVocabEngagementWriteReceipt(resignedOversized), false);

    const generation = await context.service
      .loadVocabEngagementGenerationExpectation();
    const activity = await context.service.prepareVocabStudyActivityRecord({
      kind: "read",
      seconds: 15,
      recordedAt: 1_777_777,
      timezoneOffsetMinutes: 480,
    }, generation);
    const duplicatedOffset = structuredClone(activity);
    duplicatedOffset.request.timezoneOffsetMinutes = -840;
    const resignedDuplicatedOffset = await resignReceipt(duplicatedOffset);
    assert.equal(
      store.isVocabEngagementWriteReceipt(resignedDuplicatedOffset),
      false,
    );
    assert.equal(
      await context.service.inspectVocabEngagementWrite(
        resignedDuplicatedOffset,
      ),
      "invalid_receipt",
    );
    assert.equal(context.state.batchCalls, 0);
    assert.deepEqual(bookmarkRows(context.database), []);
  } finally {
    context.database.close();
  }
});

test("activity day is sealed from prepare-time offset and never recomputed after timezone/clock changes", async () => {
  const timestamp = Date.UTC(2026, 0, 1, 0, 30);
  const context = await fixture({
    now: timestamp,
    timezoneOffsetMinutes: -840,
  });
  try {
    const expected = await context.service.loadVocabEngagementGenerationExpectation();
    const receipt = await context.service.prepareVocabStudyActivityRecord({
      kind: "listen",
      seconds: 45,
      recordedAt: timestamp,
      timezoneOffsetMinutes: 480,
    }, expected);
    assert.equal(receipt.target.day, "2025-12-31");
    assert.equal(receipt.timezoneOffsetMinutes, 480);
    context.state.timezoneOffsetMinutes = -840;
    context.state.now = 1;
    assert.equal(await context.service.inspectVocabEngagementWrite(receipt), "expected");
    assert.equal(
      (await context.service.commitVocabEngagementWrite(receipt)).outcome,
      "saved",
    );
    assert.equal(activityRows(context.database)[0].day, "2025-12-31");

    const fallbackContext = await fixture({
      now: timestamp,
      timezoneOffsetMinutes: 480,
    });
    try {
      const fallbackExpected = await fallbackContext.service
        .loadVocabEngagementGenerationExpectation();
      const fallbackReceipt = await fallbackContext.service
        .prepareVocabStudyActivityRecord({
          kind: "read",
          seconds: 15,
          recordedAt: timestamp,
        }, fallbackExpected);
      assert.equal(fallbackReceipt.timezoneOffsetMinutes, 480);
      assert.equal(fallbackReceipt.target.day, "2025-12-31");
    } finally {
      fallbackContext.database.close();
    }

    const invalidClockContext = await fixture({ now: -1 });
    try {
      const invalidExpected = await invalidClockContext.service
        .loadVocabEngagementGenerationExpectation();
      await assert.rejects(
        invalidClockContext.service.prepareVocabStudyActivityRecord({
          kind: "read",
          seconds: 15,
        }, invalidExpected),
        (error) => error instanceof store.VocabEngagementMutationError &&
          error.code === "invalid_input",
      );
      assert.equal(invalidClockContext.state.batchCalls, 0);
    } finally {
      invalidClockContext.database.close();
    }
  } finally {
    context.database.close();
  }
});

test("read lock falls back to exclusive, while default mutation APIs fail closed without Web Locks", async () => {
  const context = await fixture();
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    const exclusiveOnlyRuntime = { ...context.runtime };
    delete exclusiveOnlyRuntime.withReadLock;
    const fallbackService = store.createVocabEngagementStorageService(
      exclusiveOnlyRuntime,
    );
    await fallbackService.loadVocabEngagementGenerationExpectation();
    assert.equal(context.state.exclusiveLockCalls, 1);

    globalThis.__vocabEngagementDefaultRuntime = context.runtime;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
    const expected = await store.loadVocabEngagementGenerationExpectation();
    await assert.rejects(
      store.prepareVocabStudyActivityRecord({ kind: "read", seconds: 15 }, expected),
      (error) => error instanceof store.VocabEngagementMutationError &&
        error.code === "inspect_failed",
    );

    const receipt = await context.service.prepareVocabStudyActivityRecord({
      kind: "read",
      seconds: 15,
      recordedAt: 4_000,
    }, expected);
    assert.equal(await store.inspectVocabEngagementWrite(receipt), "still_unknown");
    assert.equal(
      (await store.commitVocabEngagementWrite(receipt)).outcome,
      "outcome_uncertain",
    );
    assert.equal(context.state.batchCalls, 0);
    assert.deepEqual(activityRows(context.database), []);
  } finally {
    delete globalThis.__vocabEngagementDefaultRuntime;
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
    context.database.close();
  }
});
