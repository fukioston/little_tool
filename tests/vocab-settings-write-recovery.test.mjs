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
  export function broadcastVocabChange() {}
`);
let storeJavaScript = rawStoreJavaScript;
for (const [specifier, url] of Object.entries({
  "@/lib/local-db/client": moduleUrl(`
    function runtime() {
      const value = globalThis.__vocabSettingsDefaultRuntime;
      if (!value) throw new Error("default localDb must not be used without a fixture");
      return value;
    }
    export const localDb = {
      query(_database, sql, params) { return runtime().query(sql, params); },
      batch(_database, statements) { return runtime().batch(statements); },
      currentGeneration() { return runtime().currentGeneration(); },
      init() { throw new Error("not used in settings service tests"); },
      run() { throw new Error("not used in settings service tests"); }
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

const settingKeys = [
  "chinese_explanation",
  "font_scale",
  "line_height",
  "local_lock",
  "auto_follow",
  "daily_new_limit",
];
const defaultSettings = {
  chinese_explanation: false,
  font_scale: 1,
  line_height: 1.92,
  local_lock: false,
  auto_follow: true,
  daily_new_limit: 8,
};
const changedSettings = {
  chinese_explanation: true,
  font_scale: 1.12,
  line_height: 2.04,
  local_lock: true,
  auto_follow: false,
  daily_new_limit: 12,
};

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

async function fixture({ now = 1_000 } = {}) {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec(`CREATE TABLE vocab_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
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
    failAtStatement: null,
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
          if (state.failAtStatement === index) {
            throw new Error("injected mid-transaction failure");
          }
          return executeRun(database, sql, params);
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
    service: store.createVocabSettingsStorageService(runtime),
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

function insertCanonicalRows(database, rows) {
  for (const [key, value, updatedAt] of rows) {
    executeRun(
      database,
      "INSERT INTO vocab_settings(key,value,updated_at) VALUES(?,?,?)",
      [key, value, updatedAt],
    );
  }
}

function canonicalRows(database) {
  return database.selectObjects(
    "SELECT key,value,updated_at FROM vocab_settings WHERE key IN (?,?,?,?,?,?) ORDER BY key",
    settingKeys,
  ).map((row) => ({ ...row }));
}

test("loader binds one generation and six raw rows while prepare is strict and zero-write", async () => {
  const { database, state, service } = await fixture({ now: 90_000 });
  try {
    executeRun(
      database,
      "INSERT INTO vocab_settings(key,value,updated_at) VALUES('__vocab_system_marker','kept',7)",
    );
    executeRun(
      database,
      "INSERT INTO vocab_settings(key,value,updated_at) VALUES('local_lock','true',8)",
    );
    const expected = await service.loadVocabSettingsExpectedState();
    assert.equal(state.readLockCalls, 1);
    assert.equal(state.exclusiveLockCalls, 0);
    assert.deepEqual(expected, {
      generationId: "legacy",
      generationSequence: 0,
      rows: [
        null,
        null,
        null,
        { key: "local_lock", value: "true", updated_at: 8 },
        null,
        null,
      ],
      settings: { ...defaultSettings, local_lock: true },
    });

    const next = { ...changedSettings };
    const mutableExpected = structuredClone(expected);
    const preparing = service.prepareVocabSettingsSave(next, mutableExpected);
    next.local_lock = false;
    mutableExpected.generationId = "22222222-2222-4222-8222-222222222222";
    mutableExpected.rows[3].value = "false";
    mutableExpected.settings.local_lock = false;
    const receipt = await preparing;
    assert.equal(state.batchCalls, 0);
    assert.deepEqual(receipt.before, expected);
    assert.deepEqual(receipt.after.settings, changedSettings);
    assert.deepEqual(receipt.after.rows.map(({ key }) => key), settingKeys);
    assert.deepEqual(receipt.after.rows.map(({ updated_at }) => updated_at), [
      90_000, 90_000, 90_000, 90_000, 90_000, 90_000,
    ]);
    assert.match(receipt.operationId, /^vocab-settings-operation-/);
    assert.equal(store.isVocabSettingsWriteReceipt(receipt), true);
    assert.equal(
      database.selectValue(
        "SELECT value FROM vocab_settings WHERE key='__vocab_system_marker'",
      ),
      "kept",
    );

    for (const invalid of [
      { ...changedSettings, font_scale: Number.NaN },
      { ...changedSettings, line_height: 3 },
      { ...changedSettings, daily_new_limit: -1 },
      { ...changedSettings, extra: undefined },
    ]) {
      await assert.rejects(
        service.prepareVocabSettingsSave(invalid, expected),
        (error) => error instanceof store.VocabSettingsMutationError &&
          error.code === "invalid_input",
      );
    }
    assert.equal(state.batchCalls, 0);
  } finally {
    database.close();
  }
});

test("loader rejects non-canonical raw setting values without preparing or writing", async () => {
  for (const [key, value] of [
    ["local_lock", "1"],
    ["font_scale", "1.00"],
    ["line_height", "NaN"],
    ["daily_new_limit", "08"],
  ]) {
    const { database, state, service } = await fixture();
    try {
      executeRun(
        database,
        "INSERT INTO vocab_settings(key,value,updated_at) VALUES(?,?,1)",
        [key, value],
      );
      await assert.rejects(
        service.loadVocabSettingsExpectedState(),
        (error) => error instanceof store.VocabSettingsMutationError &&
          error.code === "inspect_failed",
        key,
      );
      assert.equal(state.batchCalls, 0, key);
      assert.equal(
        database.selectValue("SELECT value FROM vocab_settings WHERE key=?", [key]),
        value,
        key,
      );
    } finally {
      database.close();
    }
  }
});

test("value, timestamp, and missing-row peer changes reject stale prepare with zero writes", async () => {
  const initial = [
    ["chinese_explanation", "false", 11],
    ["font_scale", "1", 12],
    ["line_height", "1.92", 13],
    ["local_lock", "false", 14],
    ["auto_follow", "true", 15],
    ["daily_new_limit", "8", 16],
  ];
  for (const mutation of ["value", "timestamp", "missing"]) {
    const { database, state, service } = await fixture({ now: 91_000 });
    try {
      insertCanonicalRows(database, initial);
      const expected = await service.loadVocabSettingsExpectedState();
      if (mutation === "value") {
        executeRun(
          database,
          "UPDATE vocab_settings SET value='true',updated_at=17 WHERE key='local_lock'",
        );
      } else if (mutation === "timestamp") {
        executeRun(
          database,
          "UPDATE vocab_settings SET updated_at=17 WHERE key='local_lock'",
        );
      } else {
        executeRun(database, "DELETE FROM vocab_settings WHERE key='local_lock'");
      }
      await assert.rejects(
        service.prepareVocabSettingsSave(changedSettings, expected),
        (error) => error instanceof store.VocabSettingsMutationError &&
          error.code === "changed",
        mutation,
      );
      assert.equal(state.batchCalls, 0, mutation);
    } finally {
      database.close();
    }
  }
});

test("value, timestamp, and missing-row races after prepare are changed with zero commit batch", async () => {
  const initial = [
    ["chinese_explanation", "false", 11],
    ["font_scale", "1", 12],
    ["line_height", "1.92", 13],
    ["local_lock", "false", 14],
    ["auto_follow", "true", 15],
    ["daily_new_limit", "8", 16],
  ];
  for (const mutation of ["value", "timestamp", "missing"]) {
    const { database, state, service } = await fixture({ now: 91_500 });
    try {
      insertCanonicalRows(database, initial);
      const expected = await service.loadVocabSettingsExpectedState();
      const receipt = await service.prepareVocabSettingsSave(changedSettings, expected);
      if (mutation === "value") {
        executeRun(
          database,
          "UPDATE vocab_settings SET value='true',updated_at=17 WHERE key='local_lock'",
        );
      } else if (mutation === "timestamp") {
        executeRun(
          database,
          "UPDATE vocab_settings SET updated_at=17 WHERE key='local_lock'",
        );
      } else {
        executeRun(database, "DELETE FROM vocab_settings WHERE key='local_lock'");
      }
      assert.equal(await service.inspectVocabSettingsWrite(receipt), "changed", mutation);
      assert.equal(
        (await service.commitVocabSettingsWrite(receipt)).outcome,
        "changed",
        mutation,
      );
      assert.equal(state.batchCalls, 0, mutation);
    } finally {
      database.close();
    }
  }
});

test("generation replacement blocks stale prepare and a prepared receipt without writing", async () => {
  const prepareFixture = await fixture({ now: 92_000 });
  try {
    const { database, state, service } = prepareFixture;
    const expected = await service.loadVocabSettingsExpectedState();
    state.generation = {
      generationId: "22222222-2222-4222-8222-222222222222",
      sequence: 1,
    };
    await assert.rejects(
      service.prepareVocabSettingsSave(changedSettings, expected),
      (error) => error instanceof store.VocabSettingsMutationError &&
        error.code === "changed",
    );
    assert.equal(state.batchCalls, 0);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM vocab_settings"), 0);
  } finally {
    prepareFixture.database.close();
  }

  const commitFixture = await fixture({ now: 92_500 });
  try {
    const { database, state, service } = commitFixture;
    const expected = await service.loadVocabSettingsExpectedState();
    const receipt = await service.prepareVocabSettingsSave(changedSettings, expected);
    state.generation = {
      generationId: "33333333-3333-4333-8333-333333333333",
      sequence: 2,
    };
    assert.equal(await service.inspectVocabSettingsWrite(receipt), "changed");
    assert.equal((await service.commitVocabSettingsWrite(receipt)).outcome, "changed");
    assert.equal(state.batchCalls, 0);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM vocab_settings"), 0);
  } finally {
    commitFixture.database.close();
  }
});

test("response loss settles exact, writes all values and timestamps, and retry is idempotent", async () => {
  const { database, state, service } = await fixture({ now: 1 });
  try {
    insertCanonicalRows(database, [
      ["chinese_explanation", "false", 11],
      ["font_scale", "1", 22],
      ["line_height", "1.92", 33],
      ["local_lock", "false", 44],
      ["auto_follow", "true", 55],
      ["daily_new_limit", "8", 66],
    ]);
    executeRun(
      database,
      "INSERT INTO vocab_settings(key,value,updated_at) VALUES('__vocab_receipt_marker','proof',99)",
    );
    const expected = await service.loadVocabSettingsExpectedState();
    const receipt = await service.prepareVocabSettingsSave(changedSettings, expected);
    assert.deepEqual(receipt.after.rows.map(({ updated_at }) => updated_at), [
      67, 67, 67, 67, 67, 67,
    ]);
    state.throwAfterBatch = true;
    state.broadcastThrows = true;
    const saved = await service.commitVocabSettingsWrite(receipt);
    assert.equal(saved.outcome, "saved");
    assert.equal(saved.updatedAt, 67);
    assert.deepEqual(canonicalRows(database), [
      { key: "auto_follow", value: "false", updated_at: 67 },
      { key: "chinese_explanation", value: "true", updated_at: 67 },
      { key: "daily_new_limit", value: "12", updated_at: 67 },
      { key: "font_scale", value: "1.12", updated_at: 67 },
      { key: "line_height", value: "2.04", updated_at: 67 },
      { key: "local_lock", value: "true", updated_at: 67 },
    ]);
    assert.equal(
      database.selectValue(
        "SELECT value FROM vocab_settings WHERE key='__vocab_receipt_marker'",
      ),
      "proof",
    );
    assert.equal(await service.inspectVocabSettingsWrite(receipt), "exact_saved");
    const batches = state.batchCalls;
    assert.equal((await service.commitVocabSettingsWrite(receipt)).outcome, "already_saved");
    assert.equal(state.batchCalls, batches);
    assert.deepEqual(state.broadcasts, ["settings-saved", "settings-saved"]);
  } finally {
    database.close();
  }
});

test("lost settle stays uncertain and later read proves the exact committed result", async () => {
  const { database, state, service } = await fixture({ now: 93_000 });
  try {
    const expected = await service.loadVocabSettingsExpectedState();
    const receipt = await service.prepareVocabSettingsSave(changedSettings, expected);
    state.throwAfterBatch = true;
    state.failQueryAfterBatch = true;
    assert.equal(
      (await service.commitVocabSettingsWrite(receipt)).outcome,
      "outcome_uncertain",
    );
    assert.equal(await service.inspectVocabSettingsWrite(receipt), "exact_saved");
    const batches = state.batchCalls;
    assert.equal((await service.commitVocabSettingsWrite(receipt)).outcome, "already_saved");
    assert.equal(state.batchCalls, batches);
  } finally {
    database.close();
  }
});

test("a peer change after an uncertain commit is changed and never replayed", async () => {
  const { database, state, service } = await fixture({ now: 94_000 });
  try {
    const expected = await service.loadVocabSettingsExpectedState();
    const receipt = await service.prepareVocabSettingsSave(changedSettings, expected);
    state.throwAfterBatch = true;
    state.failQueryAfterBatch = true;
    assert.equal(
      (await service.commitVocabSettingsWrite(receipt)).outcome,
      "outcome_uncertain",
    );
    executeRun(
      database,
      "UPDATE vocab_settings SET value='false',updated_at=updated_at+1 WHERE key='local_lock'",
    );
    const batches = state.batchCalls;
    assert.equal(await service.inspectVocabSettingsWrite(receipt), "changed");
    assert.equal((await service.commitVocabSettingsWrite(receipt)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(
      database.selectValue(
        "SELECT value FROM vocab_settings WHERE key='local_lock'",
      ),
      "false",
    );
  } finally {
    database.close();
  }
});

test("transaction sentinel and a mid-batch fault roll back all six settings", async () => {
  const { database, state, service } = await fixture({ now: 1 });
  try {
    insertCanonicalRows(database, [
      ["chinese_explanation", "false", 101],
      ["font_scale", "1", 102],
      ["line_height", "1.92", 103],
      ["local_lock", "false", 104],
      ["auto_follow", "true", 105],
      ["daily_new_limit", "8", 106],
    ]);
    const beforeRows = canonicalRows(database);
    const expected = await service.loadVocabSettingsExpectedState();
    const receipt = await service.prepareVocabSettingsSave(changedSettings, expected);
    assert.deepEqual(receipt.after.rows.map(({ updated_at }) => updated_at), [
      107, 107, 107, 107, 107, 107,
    ]);
    state.failAtStatement = 4;
    await assert.rejects(
      service.commitVocabSettingsWrite(receipt),
      (error) => error instanceof store.VocabSettingsMutationError &&
        error.code === "write_failed",
    );
    assert.deepEqual(canonicalRows(database), beforeRows);
    assert.equal(
      database.selectValue(
        "SELECT COUNT(*) FROM vocab_settings WHERE key='__vocab_settings_cas_abort__'",
      ),
      0,
    );
    assert.equal(await service.inspectVocabSettingsWrite(receipt), "expected");
  } finally {
    database.close();
  }
});

test("transaction sentinel catches a peer raw-row edit after precheck and before its first statement", async () => {
  const { database, state, service } = await fixture({ now: 98_000 });
  try {
    insertCanonicalRows(database, [
      ["chinese_explanation", "false", 11],
      ["font_scale", "1", 12],
      ["line_height", "1.92", 13],
      ["local_lock", "false", 14],
      ["auto_follow", "true", 15],
      ["daily_new_limit", "8", 16],
    ]);
    const expected = await service.loadVocabSettingsExpectedState();
    const receipt = await service.prepareVocabSettingsSave(changedSettings, expected);
    state.beforeBatch = () => executeRun(
      database,
      "UPDATE vocab_settings SET value='true',updated_at=17 WHERE key='local_lock'",
    );
    const result = await service.commitVocabSettingsWrite(receipt);
    assert.equal(result.outcome, "changed");
    assert.equal(state.batchCalls, 1);
    assert.deepEqual(canonicalRows(database), [
      { key: "auto_follow", value: "true", updated_at: 15 },
      { key: "chinese_explanation", value: "false", updated_at: 11 },
      { key: "daily_new_limit", value: "8", updated_at: 16 },
      { key: "font_scale", value: "1", updated_at: 12 },
      { key: "line_height", value: "1.92", updated_at: 13 },
      { key: "local_lock", value: "true", updated_at: 17 },
    ]);
    assert.equal(
      database.selectValue(
        "SELECT COUNT(*) FROM vocab_settings WHERE key='__vocab_settings_cas_abort__'",
      ),
      0,
    );
  } finally {
    database.close();
  }
});

test("same-view receipts use monotonic clocks and only one stale writer can commit", async () => {
  const { database, state, service } = await fixture({ now: 500 });
  try {
    executeRun(
      database,
      "INSERT INTO vocab_settings(key,value,updated_at) VALUES('font_scale','1',500)",
    );
    const expected = await service.loadVocabSettingsExpectedState();
    const first = await service.prepareVocabSettingsSave(changedSettings, expected);
    const second = await service.prepareVocabSettingsSave({
      ...changedSettings,
      font_scale: 1.2,
    }, expected);
    assert.equal(first.after.rows[0].updated_at, 501);
    assert.equal(second.after.rows[0].updated_at, 501);
    assert.equal((await service.commitVocabSettingsWrite(first)).outcome, "saved");
    const batches = state.batchCalls;
    assert.equal((await service.commitVocabSettingsWrite(second)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(
      database.selectValue(
        "SELECT value FROM vocab_settings WHERE key='font_scale'",
      ),
      "1.12",
    );
  } finally {
    database.close();
  }
});

test("tampering and caller mutation cannot create mixed settings receipts", async () => {
  const { database, state, service } = await fixture({ now: 95_000 });
  try {
    const expected = await service.loadVocabSettingsExpectedState();
    const receipt = await service.prepareVocabSettingsSave(changedSettings, expected);

    const hashTamper = structuredClone(receipt);
    hashTamper.after.settings.local_lock = false;
    hashTamper.after.rows[3].value = "false";
    assert.equal(store.isVocabSettingsWriteReceipt(hashTamper), true);
    assert.equal(await service.inspectVocabSettingsWrite(hashTamper), "invalid_receipt");

    const semanticTamper = structuredClone(receipt);
    semanticTamper.after.settings.font_scale = 9;
    semanticTamper.after.rows[1].value = "9";
    const resigned = await resignReceipt(semanticTamper);
    assert.equal(store.isVocabSettingsWriteReceipt(resigned), false);
    assert.equal(await service.inspectVocabSettingsWrite(resigned), "invalid_receipt");
    await assert.rejects(
      service.commitVocabSettingsWrite(resigned),
      (error) => error instanceof store.VocabSettingsMutationError &&
        error.code === "invalid_receipt",
    );
    for (const target of ["top", "before", "after"]) {
      const generationTamper = structuredClone(receipt);
      if (target === "top") {
        generationTamper.generationId = "22222222-2222-4222-8222-222222222222";
      } else {
        generationTamper[target].generationId =
          "22222222-2222-4222-8222-222222222222";
      }
      const resignedGeneration = await resignReceipt(generationTamper);
      assert.equal(store.isVocabSettingsWriteReceipt(resignedGeneration), false, target);
      assert.equal(
        await service.inspectVocabSettingsWrite(resignedGeneration),
        "invalid_receipt",
        target,
      );
    }

    const mutableCommit = structuredClone(receipt);
    const committing = service.commitVocabSettingsWrite(mutableCommit);
    mutableCommit.after.settings.local_lock = false;
    mutableCommit.after.rows[3].value = "false";
    const saved = await committing;
    assert.equal(saved.outcome, "saved");
    assert.equal(
      database.selectValue(
        "SELECT value FROM vocab_settings WHERE key='local_lock'",
      ),
      "true",
    );
    const mutableInspect = structuredClone(saved.receipt);
    const inspecting = service.inspectVocabSettingsWrite(mutableInspect);
    mutableInspect.after.settings.auto_follow = true;
    mutableInspect.after.rows[4].value = "true";
    assert.equal(await inspecting, "exact_saved");
    assert.equal(state.batchCalls, 1);
  } finally {
    database.close();
  }
});

test("no Web Locks keeps the default loader readable and every safe write path zero-write", async () => {
  const { database, state, runtime, service } = await fixture({ now: 96_000 });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    insertCanonicalRows(database, [
      ["chinese_explanation", "false", 1],
      ["font_scale", "1", 2],
      ["line_height", "1.92", 3],
      ["local_lock", "false", 4],
      ["auto_follow", "true", 5],
      ["daily_new_limit", "8", 6],
    ]);
    const expected = await service.loadVocabSettingsExpectedState();
    const receipt = await service.prepareVocabSettingsSave(changedSettings, expected);
    globalThis.__vocabSettingsDefaultRuntime = runtime;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: undefined,
    });

    assert.deepEqual(await store.loadVocabSettingsExpectedState(), expected);
    const readsAfterLoader = state.queryCalls;
    await assert.rejects(
      store.prepareVocabSettingsSave(changedSettings, expected),
      (error) => error instanceof store.VocabSettingsMutationError &&
        error.code === "inspect_failed",
    );
    assert.equal(await store.inspectVocabSettingsWrite(receipt), "still_unknown");
    assert.equal(
      (await store.commitVocabSettingsWrite(receipt)).outcome,
      "outcome_uncertain",
    );
    assert.equal(state.queryCalls, readsAfterLoader);
    assert.equal(state.batchCalls, 0);
    assert.deepEqual(canonicalRows(database), [
      { key: "auto_follow", value: "true", updated_at: 5 },
      { key: "chinese_explanation", value: "false", updated_at: 1 },
      { key: "daily_new_limit", value: "8", updated_at: 6 },
      { key: "font_scale", value: "1", updated_at: 2 },
      { key: "line_height", value: "1.92", updated_at: 3 },
      { key: "local_lock", value: "false", updated_at: 4 },
    ]);
  } finally {
    delete globalThis.__vocabSettingsDefaultRuntime;
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
    database.close();
  }
});

test("unknown inspection and unavailable locks never enter the batch", async () => {
  const { database, state, runtime, service } = await fixture({ now: 97_000 });
  try {
    const expected = await service.loadVocabSettingsExpectedState();
    const receipt = await service.prepareVocabSettingsSave(changedSettings, expected);
    state.failQueries = 1;
    assert.equal(await service.inspectVocabSettingsWrite(receipt), "still_unknown");
    const blocked = store.createVocabSettingsStorageService({
      ...runtime,
      withExclusiveLock() { throw new Error("Web Locks unavailable"); },
    });
    await assert.rejects(
      blocked.prepareVocabSettingsSave(changedSettings, expected),
      (error) => error instanceof store.VocabSettingsMutationError &&
        error.code === "inspect_failed",
    );
    assert.equal(await blocked.inspectVocabSettingsWrite(receipt), "still_unknown");
    assert.equal(
      (await blocked.commitVocabSettingsWrite(receipt)).outcome,
      "outcome_uncertain",
    );
    assert.equal(state.batchCalls, 0);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM vocab_settings"), 0);
  } finally {
    database.close();
  }
});
