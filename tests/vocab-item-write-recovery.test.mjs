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
    globalThis.__vocabItemDefaultRuntime?.broadcast(reason);
  }
`);
let storeJavaScript = rawStoreJavaScript;
for (const [specifier, url] of Object.entries({
  "@/lib/local-db/client": moduleUrl(`
    function runtime() {
      const value = globalThis.__vocabItemDefaultRuntime;
      if (!value) throw new Error("default localDb must not be used without a fixture");
      return value;
    }
    export const localDb = {
      query(_database, sql, params) { return runtime().query(sql, params); },
      batch(_database, statements) { return runtime().batch(statements); },
      currentGeneration() { return runtime().currentGeneration(); },
      init() { throw new Error("not used in item service tests"); },
      run() { throw new Error("not used in item service tests"); }
    };
  `),
  "./content": moduleUrl(`
    export function uid(prefix) { return prefix + "_unused"; }
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

function item(overrides = {}) {
  return {
    id: "article_fixture",
    kind: "article",
    title: "Durable reading",
    description: "A complete row must be bound.",
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

function selectedItem(database, id = "article_fixture") {
  const row = database.selectObjects(
    `SELECT id,kind,title,description,source,source_url,author,published_at,
      duration_ms,audio_url,status,progress,created_at,updated_at
      FROM vocab_items WHERE id=?`,
    [id],
  )[0];
  return row ? { ...row } : null;
}

async function fixture({ now = 1_000, initialItem = item() } = {}) {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec(`CREATE TABLE vocab_items (
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
    broadcast(reason) {
      state.broadcasts.push(reason);
      if (state.broadcastThrows) throw new Error("injected broadcast failure");
    },
  };
  return {
    database,
    state,
    runtime,
    service: store.createVocabItemStorageService(runtime),
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

test("loader binds generation and every item column; prepare deep-copies and writes nothing", async () => {
  const original = item({
    source_url: "https://example.test/story",
    audio_url: "https://example.test/story.mp3",
  });
  const { database, state, service } = await fixture({ now: 500, initialItem: original });
  try {
    const expected = await service.loadVocabItemExpectedState(original.id);
    assert.deepEqual(expected, {
      generationId: "legacy",
      generationSequence: 0,
      item: original,
    });
    assert.equal(state.readLockCalls, 1);
    assert.equal(state.exclusiveLockCalls, 0);
    const mutable = structuredClone(expected);
    const preparing = service.prepareVocabItemProgressCheckpoint(0.4, mutable);
    mutable.item.title = "caller mutation";
    mutable.generationId = "22222222-2222-4222-8222-222222222222";
    const receipt = await preparing;
    assert.deepEqual(receipt.before, expected);
    assert.equal(receipt.after.item.progress, 0.4);
    assert.equal(receipt.after.item.status, "in_progress");
    assert.equal(receipt.after.item.updated_at, 500);
    assert.equal(store.isVocabItemWriteReceipt(receipt), true);
    assert.equal(state.batchCalls, 0);
    assert.deepEqual(selectedItem(database), original);
  } finally {
    database.close();
  }
});

test("invalid progress and terminal checkpoints fail closed with zero writes", async () => {
  for (const progress of [-0.01, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const context = await fixture();
    try {
      const expected = await context.service.loadVocabItemExpectedState("article_fixture");
      await assert.rejects(
        context.service.prepareVocabItemProgressCheckpoint(progress, expected),
        (error) => error instanceof store.VocabItemMutationError &&
          error.code === "invalid_input",
      );
      assert.equal(context.state.batchCalls, 0);
    } finally {
      context.database.close();
    }
  }
  for (const status of ["complete", "archived"]) {
    const context = await fixture({ initialItem: item({ status, progress: 1 }) });
    try {
      const expected = await context.service.loadVocabItemExpectedState("article_fixture");
      await assert.rejects(
        context.service.prepareVocabItemProgressCheckpoint(0.2, expected),
        (error) => error instanceof store.VocabItemMutationError &&
          error.code === "invalid_input",
      );
      assert.equal(context.state.batchCalls, 0);
      assert.equal(selectedItem(context.database).status, status);
    } finally {
      context.database.close();
    }
  }
});

test("every stale full-row fact, including nullable URLs, rejects prepare without writes", async () => {
  const mutations = [
    ["title", "peer title"],
    ["description", "peer description"],
    ["source", "peer source"],
    ["source_url", "https://peer.test/source"],
    ["author", "Peer"],
    ["published_at", "2026-08-23"],
    ["duration_ms", 9_000],
    ["audio_url", "https://peer.test/audio"],
    ["status", "in_progress"],
    ["progress", 0.2],
    ["created_at", 99],
    ["updated_at", 101],
  ];
  for (const [field, value] of mutations) {
    const context = await fixture();
    try {
      const expected = await context.service.loadVocabItemExpectedState("article_fixture");
      executeRun(
        context.database,
        `UPDATE vocab_items SET ${field}=? WHERE id=?`,
        [value, "article_fixture"],
      );
      await assert.rejects(
        context.service.prepareVocabItemProgressCheckpoint(0.25, expected),
        (error) => error instanceof store.VocabItemMutationError &&
          error.code === "changed",
        field,
      );
      assert.equal(context.state.batchCalls, 0, field);
    } finally {
      context.database.close();
    }
  }
});

test("generation replacement and item deletion invalidate prepare and prepared receipts", async () => {
  const context = await fixture();
  try {
    const expected = await context.service.loadVocabItemExpectedState("article_fixture");
    const receipt = await context.service.prepareVocabItemComplete(expected);
    context.state.generation = {
      generationId: "22222222-2222-4222-8222-222222222222",
      sequence: 1,
    };
    await assert.rejects(
      context.service.prepareVocabItemComplete(expected),
      (error) => error instanceof store.VocabItemMutationError &&
        error.code === "changed",
    );
    assert.equal(await context.service.inspectVocabItemWrite(receipt), "changed");
    assert.equal(
      (await context.service.commitVocabItemWrite(receipt)).outcome,
      "changed",
    );
    assert.equal(context.state.batchCalls, 0);
    context.state.generation = { generationId: "legacy", sequence: 0 };
    executeRun(context.database, "DELETE FROM vocab_items WHERE id='article_fixture'");
    await assert.rejects(
      context.service.loadVocabItemExpectedState("article_fixture"),
      (error) => error instanceof store.VocabItemMutationError &&
        error.code === "changed",
    );
  } finally {
    context.database.close();
  }
});

test("checkpoint derives unread/in-progress and uses a monotonic timestamp", async () => {
  for (const [progress, status] of [[0, "unread"], [0.75, "in_progress"]]) {
    const context = await fixture({ now: 1, initialItem: item({ updated_at: 500 }) });
    try {
      const expected = await context.service.loadVocabItemExpectedState("article_fixture");
      const receipt = await context.service.prepareVocabItemProgressCheckpoint(
        progress,
        expected,
      );
      assert.equal(receipt.after.item.updated_at, 501);
      assert.equal((await context.service.commitVocabItemWrite(receipt)).outcome, "saved");
      assert.equal(selectedItem(context.database).status, status);
      assert.equal(selectedItem(context.database).progress, progress);
    } finally {
      context.database.close();
    }
  }
});

test("complete normalizes legacy complete progress and cannot complete archived rows", async () => {
  const legacy = await fixture({
    now: 900,
    initialItem: item({ status: "complete", progress: 0.4, updated_at: 800 }),
  });
  try {
    const expected = await legacy.service.loadVocabItemExpectedState("article_fixture");
    const receipt = await legacy.service.prepareVocabItemComplete(expected);
    assert.equal(receipt.after.item.progress, 1);
    assert.equal(receipt.after.item.status, "complete");
    assert.equal((await legacy.service.commitVocabItemWrite(receipt)).outcome, "saved");
    assert.equal(selectedItem(legacy.database).progress, 1);
  } finally {
    legacy.database.close();
  }
  const archived = await fixture({
    initialItem: item({ status: "archived", progress: 0.4 }),
  });
  try {
    const expected = await archived.service.loadVocabItemExpectedState("article_fixture");
    await assert.rejects(
      archived.service.prepareVocabItemComplete(expected),
      (error) => error instanceof store.VocabItemMutationError &&
        error.code === "invalid_input",
    );
    assert.equal(archived.state.batchCalls, 0);
  } finally {
    archived.database.close();
  }
});

test("archive preserves progress and restore derives all three lifecycle states", async () => {
  for (const [progress, restoredStatus] of [
    [0, "unread"],
    [0.45, "in_progress"],
    [1, "complete"],
  ]) {
    const context = await fixture({
      now: 5_000,
      initialItem: item({
        status: progress === 0 ? "unread" : progress === 1 ? "complete" : "in_progress",
        progress,
      }),
    });
    try {
      const expected = await context.service.loadVocabItemExpectedState("article_fixture");
      const archive = await context.service.prepareVocabItemArchive(expected);
      assert.equal(archive.after.item.progress, progress);
      assert.equal((await context.service.commitVocabItemWrite(archive)).outcome, "saved");
      const archived = await context.service.loadVocabItemExpectedState("article_fixture");
      assert.equal(archived.item.status, "archived");
      assert.equal(archived.item.progress, progress);
      context.state.now = 5_001;
      const restore = await context.service.prepareVocabItemRestore(archived);
      assert.equal(restore.after.item.status, restoredStatus);
      assert.equal(restore.after.item.progress, progress);
      assert.equal((await context.service.commitVocabItemWrite(restore)).outcome, "saved");
      assert.equal(selectedItem(context.database).status, restoredStatus);
      assert.equal(selectedItem(context.database).progress, progress);
    } finally {
      context.database.close();
    }
  }
});

test("response loss settles exact, retry is idempotent, and broadcast failure cannot reverse", async () => {
  const context = await fixture({ now: 2_000 });
  try {
    const expected = await context.service.loadVocabItemExpectedState("article_fixture");
    const receipt = await context.service.prepareVocabItemProgressCheckpoint(0.6, expected);
    context.state.throwAfterBatch = true;
    context.state.broadcastThrows = true;
    const saved = await context.service.commitVocabItemWrite(receipt);
    assert.equal(saved.outcome, "saved");
    assert.equal(saved.updatedAt, 2_000);
    assert.equal(selectedItem(context.database).progress, 0.6);
    assert.equal(await context.service.inspectVocabItemWrite(receipt), "exact_saved");
    const batches = context.state.batchCalls;
    assert.equal(
      (await context.service.commitVocabItemWrite(receipt)).outcome,
      "already_saved",
    );
    assert.equal(context.state.batchCalls, batches);
    assert.deepEqual(context.state.broadcasts, [
      "item-progress-changed",
      "item-progress-changed",
    ]);
  } finally {
    context.database.close();
  }
});

test("lost settle is uncertain until a later exact read, then never replays", async () => {
  const context = await fixture({ now: 2_100 });
  try {
    const expected = await context.service.loadVocabItemExpectedState("article_fixture");
    const receipt = await context.service.prepareVocabItemComplete(expected);
    context.state.throwAfterBatch = true;
    context.state.failQueryAfterBatch = true;
    assert.equal(
      (await context.service.commitVocabItemWrite(receipt)).outcome,
      "outcome_uncertain",
    );
    assert.equal(await context.service.inspectVocabItemWrite(receipt), "exact_saved");
    const batches = context.state.batchCalls;
    assert.equal(
      (await context.service.commitVocabItemWrite(receipt)).outcome,
      "already_saved",
    );
    assert.equal(context.state.batchCalls, batches);
  } finally {
    context.database.close();
  }
});

test("a peer edit after uncertain commit becomes changed and the receipt is not replayed", async () => {
  const context = await fixture({ now: 2_200 });
  try {
    const expected = await context.service.loadVocabItemExpectedState("article_fixture");
    const receipt = await context.service.prepareVocabItemProgressCheckpoint(0.5, expected);
    context.state.throwAfterBatch = true;
    context.state.failQueryAfterBatch = true;
    assert.equal(
      (await context.service.commitVocabItemWrite(receipt)).outcome,
      "outcome_uncertain",
    );
    executeRun(
      context.database,
      "UPDATE vocab_items SET title='peer after commit',updated_at=updated_at+1 WHERE id=?",
      ["article_fixture"],
    );
    const batches = context.state.batchCalls;
    assert.equal(await context.service.inspectVocabItemWrite(receipt), "changed");
    assert.equal(
      (await context.service.commitVocabItemWrite(receipt)).outcome,
      "changed",
    );
    assert.equal(context.state.batchCalls, batches);
    assert.equal(selectedItem(context.database).title, "peer after commit");
  } finally {
    context.database.close();
  }
});

test("the one transaction rolls back a fault after its update", async () => {
  const context = await fixture({ now: 2_300 });
  try {
    const before = selectedItem(context.database);
    const expected = await context.service.loadVocabItemExpectedState("article_fixture");
    const receipt = await context.service.prepareVocabItemComplete(expected);
    context.state.failAfterStatement = 1;
    await assert.rejects(
      context.service.commitVocabItemWrite(receipt),
      (error) => error instanceof store.VocabItemMutationError &&
        error.code === "write_failed",
    );
    assert.deepEqual(selectedItem(context.database), before);
    assert.equal(await context.service.inspectVocabItemWrite(receipt), "expected");
    assert.equal(Number(context.database.selectValue(
      "SELECT COUNT(*) FROM vocab_items WHERE id='__vocab_item_cas_abort__'",
    )), 0);
  } finally {
    context.database.close();
  }
});

test("full-row CAS catches a nullable URL peer race between precheck and update", async () => {
  for (const [field, value] of [
    ["source_url", "https://peer.test/new-source"],
    ["audio_url", "https://peer.test/new-audio"],
  ]) {
    const context = await fixture({ now: 2_400 });
    try {
      const expected = await context.service.loadVocabItemExpectedState("article_fixture");
      const receipt = await context.service.prepareVocabItemProgressCheckpoint(0.8, expected);
      context.state.beforeBatch = () => executeRun(
        context.database,
        `UPDATE vocab_items SET ${field}=?,updated_at=updated_at+1 WHERE id=?`,
        [value, "article_fixture"],
      );
      const result = await context.service.commitVocabItemWrite(receipt);
      assert.equal(result.outcome, "changed", field);
      const stored = selectedItem(context.database);
      assert.equal(stored[field], value, field);
      assert.equal(stored.progress, 0, field);
      assert.equal(stored.status, "unread", field);
      assert.equal(Number(context.database.selectValue(
        "SELECT COUNT(*) FROM vocab_items WHERE id='__vocab_item_cas_abort__'",
      )), 0, field);
    } finally {
      context.database.close();
    }
  }
});

test("two receipts from one view are monotonic but only one stale writer commits", async () => {
  const context = await fixture({ now: 100, initialItem: item({ updated_at: 100 }) });
  try {
    const expected = await context.service.loadVocabItemExpectedState("article_fixture");
    const first = await context.service.prepareVocabItemProgressCheckpoint(0.3, expected);
    const second = await context.service.prepareVocabItemProgressCheckpoint(0.7, expected);
    assert.equal(first.after.item.updated_at, 101);
    assert.equal(second.after.item.updated_at, 101);
    assert.equal((await context.service.commitVocabItemWrite(first)).outcome, "saved");
    const batches = context.state.batchCalls;
    assert.equal((await context.service.commitVocabItemWrite(second)).outcome, "changed");
    assert.equal(context.state.batchCalls, batches);
    assert.equal(selectedItem(context.database).progress, 0.3);
  } finally {
    context.database.close();
  }
});

test("semantic/hash/generation tampering and caller mutation cannot forge or mix receipts", async () => {
  const context = await fixture({ now: 2_500 });
  try {
    const expected = await context.service.loadVocabItemExpectedState("article_fixture");
    const receipt = await context.service.prepareVocabItemProgressCheckpoint(0.55, expected);

    const hashTamper = structuredClone(receipt);
    hashTamper.after.item.progress = 0.6;
    assert.equal(store.isVocabItemWriteReceipt(hashTamper), true);
    assert.equal(await context.service.inspectVocabItemWrite(hashTamper), "invalid_receipt");

    const semanticTamper = structuredClone(receipt);
    semanticTamper.after.item.status = "complete";
    const resignedSemantic = await resignReceipt(semanticTamper);
    assert.equal(store.isVocabItemWriteReceipt(resignedSemantic), false);

    for (const target of ["top", "before", "after"]) {
      const generationTamper = structuredClone(receipt);
      if (target === "top") {
        generationTamper.generationId = "22222222-2222-4222-8222-222222222222";
      } else {
        generationTamper[target].generationId =
          "22222222-2222-4222-8222-222222222222";
      }
      const resigned = await resignReceipt(generationTamper);
      assert.equal(store.isVocabItemWriteReceipt(resigned), false, target);
      assert.equal(
        await context.service.inspectVocabItemWrite(resigned),
        "invalid_receipt",
        target,
      );
    }

    const mutable = structuredClone(receipt);
    const committing = context.service.commitVocabItemWrite(mutable);
    mutable.after.item.progress = 0.9;
    mutable.after.item.title = "caller changed";
    const saved = await committing;
    assert.equal(saved.outcome, "saved");
    assert.equal(selectedItem(context.database).progress, 0.55);
    assert.equal(selectedItem(context.database).title, "Durable reading");
  } finally {
    context.database.close();
  }
});

test("no Web Locks leaves default reads usable and all durable write paths zero-write", async () => {
  const context = await fixture({ now: 2_600 });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    const expected = await context.service.loadVocabItemExpectedState("article_fixture");
    const receipt = await context.service.prepareVocabItemComplete(expected);
    globalThis.__vocabItemDefaultRuntime = context.runtime;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: undefined,
    });
    assert.deepEqual(
      await store.loadVocabItemExpectedState("article_fixture"),
      expected,
    );
    const readsAfterLoader = context.state.queryCalls;
    await assert.rejects(
      store.prepareVocabItemComplete(expected),
      (error) => error instanceof store.VocabItemMutationError &&
        error.code === "inspect_failed",
    );
    assert.equal(await store.inspectVocabItemWrite(receipt), "still_unknown");
    assert.equal(
      (await store.commitVocabItemWrite(receipt)).outcome,
      "outcome_uncertain",
    );
    assert.equal(context.state.queryCalls, readsAfterLoader);
    assert.equal(context.state.batchCalls, 0);
    assert.deepEqual(selectedItem(context.database), item());
  } finally {
    delete globalThis.__vocabItemDefaultRuntime;
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
    context.database.close();
  }
});

test("recordStudySeconds records activity without rewriting unrelated item updated_at", async () => {
  const context = await fixture({ now: 9_000, initialItem: item({ updated_at: 777 }) });
  try {
    globalThis.__vocabItemDefaultRuntime = context.runtime;
    await store.recordStudySeconds("article_fixture", "read", 15);
    assert.equal(selectedItem(context.database).updated_at, 777);
    const activity = context.database.selectObjects(
      "SELECT read_seconds,listen_seconds,created_at FROM vocab_activity",
    ).map((row) => ({ ...row }));
    assert.equal(activity.length, 1);
    assert.deepEqual({
      read_seconds: activity[0].read_seconds,
      listen_seconds: activity[0].listen_seconds,
    }, {
      read_seconds: 15,
      listen_seconds: 0,
    });
    assert.equal(Number.isSafeInteger(activity[0].created_at), true);
  } finally {
    delete globalThis.__vocabItemDefaultRuntime;
    context.database.close();
  }
});
