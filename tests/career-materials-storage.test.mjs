import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const FILE_A = "10000000-0000-4000-8000-000000000001";
const FILE_B = "20000000-0000-4000-8000-000000000002";
const GENERATION_A = "10000000-0000-4000-8000-00000000000a";
const GENERATION_B = "20000000-0000-4000-8000-00000000000b";

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

const source = await readFile(new URL("lib/career/materials.ts", projectRoot), "utf8");
const rawJavaScript = await transpile("lib/career/materials.ts");
const dependencies = {
  "@/lib/local-db/client": moduleUrl("export const localDb = {};"),
  "@/lib/local-db/files": moduleUrl(`
    export async function deleteLocalFile(){ throw new Error("default runtime not used"); }
  `),
  "./lock": moduleUrl(`
    export function withCareerWriteLock(task){ return task(); }
  `),
};
let serviceJavaScript = rawJavaScript;
for (const [specifier, url] of Object.entries(dependencies)) {
  serviceJavaScript = serviceJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const materials = await import(moduleUrl(serviceJavaScript));

function executeRun(database, sql, params = []) {
  const statement = database.prepare(sql);
  try {
    if (params.length > 0) statement.bind(params);
    while (statement.step()) {
      // Consume any unexpected returned rows before finalizing the statement.
    }
  } finally {
    statement.finalize();
  }
  return {
    changes: Number(database.changes()),
    lastInsertRowId: database.selectValue("SELECT last_insert_rowid()") ?? null,
  };
}

function insertMaterial(database, {
  id,
  fileKey = null,
  status = "ready",
  name = id,
  kind = "简历",
  version = "v1",
  updatedAt = "2026-08-21T00:00:00.000Z",
  linkedJobId = null,
  notes = "",
  fileName = null,
  mimeType = null,
  byteSize = null,
}) {
  executeRun(
    database,
    `INSERT INTO career_materials(
       id,name,kind,version,updated_at,linked_job_id,status,notes,
       file_key,file_name,mime_type,byte_size
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, name, kind, version, updatedAt, linkedJobId, status, notes,
      fileKey, fileName, mimeType, byteSize,
    ],
  );
}

function selectMaterial(database, id) {
  return database.selectObject(
    "SELECT id,status,file_key FROM career_materials WHERE id = ?",
    [id],
  ) ?? null;
}

async function fixture({ rows = [], files = [], broadcastThrows = false } = {}) {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec(`
    CREATE TABLE career_materials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT '简历',
      version TEXT NOT NULL DEFAULT 'v1.0',
      updated_at TEXT NOT NULL,
      linked_job_id TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      notes TEXT NOT NULL DEFAULT '',
      file_key TEXT,
      file_name TEXT,
      mime_type TEXT,
      byte_size INTEGER
    );
  `);
  for (const row of rows) insertMaterial(database, row);

  const state = {
    activeLocks: 0,
    lockCalls: 0,
    maxActiveLocks: 0,
    tail: Promise.resolve(),
    files: new Set(files),
    deletedKeys: [],
    broadcasts: [],
    deleteFailures: new Map(),
    failQueriesRemaining: 0,
    failReferenceQueriesRemaining: 0,
    markFailure: null,
    markRecoveryQueryFailures: 0,
    finalFailure: null,
    finalRecoveryQueryFailures: 0,
    broadcastThrows,
    generation: {
      database: "zhiji",
      generationId: GENERATION_A,
      sequence: 1,
    },
    currentGenerationCalls: 0,
    queryCalls: 0,
    runCalls: 0,
  };

  const requireLock = (operation) => {
    assert.equal(
      state.activeLocks,
      1,
      `${operation} must stay inside the exclusive Career lock`,
    );
  };

  const runtime = {
    async withExclusiveLock(operation) {
      state.lockCalls += 1;
      const previous = state.tail;
      let release;
      state.tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      state.activeLocks += 1;
      state.maxActiveLocks = Math.max(state.maxActiveLocks, state.activeLocks);
      try {
        return await operation();
      } finally {
        state.activeLocks -= 1;
        release();
      }
    },
    async query(sql, params = []) {
      requireLock("SQLite read");
      state.queryCalls += 1;
      if (state.failQueriesRemaining > 0) {
        state.failQueriesRemaining -= 1;
        throw new Error("SELECT career_materials leaked an internal path");
      }
      if (/SELECT EXISTS/.test(sql) && state.failReferenceQueriesRemaining > 0) {
        state.failReferenceQueriesRemaining -= 1;
        throw new Error("SELECT shared reference exploded");
      }
      const rowsResult = database.selectObjects(sql, params);
      return { columns: [], rows: rowsResult, rowCount: rowsResult.length };
    },
    async run(sql, params = []) {
      requireLock("SQLite write");
      state.runCalls += 1;
      const isMark = /UPDATE career_materials/.test(sql);
      const isFinalDelete = /DELETE FROM career_materials/.test(sql);
      const failure = isMark ? state.markFailure : isFinalDelete ? state.finalFailure : null;
      if (failure === "before") {
        if (isMark) state.markFailure = null;
        if (isFinalDelete) state.finalFailure = null;
        throw new Error(`SQLite ${isMark ? "UPDATE" : "DELETE"} failed before commit`);
      }
      const result = executeRun(database, sql, params);
      if (failure === "after") {
        if (isMark) {
          state.markFailure = null;
          state.failQueriesRemaining += state.markRecoveryQueryFailures;
          state.markRecoveryQueryFailures = 0;
        }
        if (isFinalDelete) {
          state.finalFailure = null;
          state.failQueriesRemaining += state.finalRecoveryQueryFailures;
          state.finalRecoveryQueryFailures = 0;
        }
        throw new Error(`SQLite ${isMark ? "UPDATE" : "DELETE"} response was lost`);
      }
      return result;
    },
    async currentGeneration() {
      requireLock("generation read");
      state.currentGenerationCalls += 1;
      return { ...state.generation };
    },
    async deleteFile(key) {
      requireLock("OPFS delete");
      state.deletedKeys.push(key);
      const failures = state.deleteFailures.get(key) ?? 0;
      if (failures > 0) {
        state.deleteFailures.set(key, failures - 1);
        throw new Error("OPFS /private/path/object.bin failed");
      }
      return state.files.delete(key);
    },
    broadcast(reason) {
      requireLock("broadcast");
      state.broadcasts.push(reason);
      if (state.broadcastThrows) throw new Error("BroadcastChannel closed");
    },
  };

  return {
    database,
    state,
    service: materials.createCareerMaterialsService(runtime),
    close() {
      database.close();
    },
  };
}

async function inspectPresent(context, id) {
  const inspected = await context.service.inspectCareerMaterialDeletion(id);
  assert.notEqual(inspected.state, "already_absent");
  assert.equal(inspected.materialId, id);
  assert.equal(inspected.receipt.purpose, "career-material-deletion");
  assert.equal(inspected.receipt.version, 1);
  assert.match(inspected.receipt.digest, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => JSON.stringify(inspected.receipt));
  return inspected;
}

async function deleteInspected(context, id) {
  const inspected = await inspectPresent(context, id);
  return context.service.deleteCareerMaterial(inspected.receipt);
}

function withoutReceipt(value) {
  const { receipt, ...rest } = value;
  assert.ok(receipt);
  return rest;
}

test("material deletion source keeps every mutation guarded and behind the Career write lock", () => {
  assert.match(source, /withCareerWriteLock/);
  assert.doesNotMatch(source, /broadcastCareerGenerationChanged/);
  assert.match(source, /currentGeneration: \(\) => localDb\.currentGeneration\(DATABASE\)/);
  assert.match(source, /sameGeneration\(generation, receipt\)/);
  assert.match(source, /payloadMatchesRow\(receipt, found\)/);
  assert.match(
    source,
    /UPDATE career_materials[\s\S]*WHERE \$\{ROW_CAS_WHERE\}/,
  );
  assert.match(
    source,
    /DELETE FROM career_materials[\s\S]*WHERE \$\{ROW_CAS_WHERE\}/,
  );
  assert.match(source, /name = \?[\s\S]*version = \?[\s\S]*updated_at = \?[\s\S]*file_key IS \?/);
  assert.match(source, /WHERE file_key = \? AND id <> \?/);
  assert.doesNotMatch(source, /previous_status|restore_status|status_before_delete/i);
});

test("a legacy empty file key is no attachment and never reaches OPFS", async (t) => {
  const context = await fixture({
    rows: [{ id: "material-empty-key", fileKey: "" }],
  });
  t.after(() => context.close());

  assert.deepEqual(
    withoutReceipt(await context.service.inspectCareerMaterialDeletion("material-empty-key")),
    {
      state: "present",
      materialId: "material-empty-key",
      hasAttachment: false,
      sharesAttachment: false,
    },
  );
  const inspected = await inspectPresent(context, "material-empty-key");
  assert.deepEqual(
    await context.service.deleteCareerMaterial(inspected.receipt),
    {
      outcome: "deleted",
      materialId: "material-empty-key",
      fileAction: "not_attached",
    },
  );
  assert.deepEqual(context.state.deletedKeys, []);
});

test("OPFS failure leaves a visible deleting row and an idempotent retry completes cleanup", async (t) => {
  const context = await fixture({
    rows: [{ id: "material-a", fileKey: FILE_A }],
    files: [FILE_A],
  });
  t.after(() => context.close());
  context.state.deleteFailures.set(FILE_A, 1);

  const inspected = await inspectPresent(context, "material-a");
  const first = await context.service.deleteCareerMaterial(inspected.receipt);
  assert.deepEqual(withoutReceipt(first), {
    outcome: "cleanup_pending",
    materialId: "material-a",
    reason: "file_cleanup_failed",
    retryable: true,
  });
  assert.notDeepEqual(first.receipt, inspected.receipt);
  assert.deepEqual(selectMaterial(context.database, "material-a"), {
    id: "material-a",
    status: "deleting",
    file_key: FILE_A,
  });
  assert.equal(context.state.files.has(FILE_A), true);
  assert.deepEqual(
    withoutReceipt(await context.service.loadCareerMaterialDeletionState("material-a")),
    {
      state: "cleanup_pending",
      materialId: "material-a",
      hasAttachment: true,
      sharesAttachment: false,
      retryable: true,
    },
  );

  const retried = await context.service.deleteCareerMaterial(first.receipt);
  assert.deepEqual(retried, {
    outcome: "deleted",
    materialId: "material-a",
    fileAction: "removed",
  });
  assert.equal(selectMaterial(context.database, "material-a"), null);
  assert.equal(context.state.files.has(FILE_A), false);
  assert.deepEqual(context.state.deletedKeys, [FILE_A, FILE_A]);
});

test("a shared file key is retained until the last material reference is removed", async (t) => {
  const context = await fixture({
    rows: [
      { id: "material-a", fileKey: FILE_A },
      { id: "material-b", fileKey: FILE_A },
    ],
    files: [FILE_A],
  });
  t.after(() => context.close());

  const first = await deleteInspected(context, "material-a");
  assert.deepEqual(first, {
    outcome: "deleted",
    materialId: "material-a",
    fileAction: "retained_shared",
  });
  assert.equal(context.state.files.has(FILE_A), true);
  assert.deepEqual(context.state.deletedKeys, []);
  assert.equal(selectMaterial(context.database, "material-b").file_key, FILE_A);

  const last = await deleteInspected(context, "material-b");
  assert.equal(last.outcome, "deleted");
  assert.equal(last.fileAction, "removed");
  assert.equal(context.state.files.has(FILE_A), false);
  assert.deepEqual(context.state.deletedKeys, [FILE_A]);
});

test("unknown ids inspect as already absent and perform no cleanup", async (t) => {
  const context = await fixture({ files: [FILE_A] });
  t.after(() => context.close());

  assert.deepEqual(
    await context.service.inspectCareerMaterialDeletion("material-unknown"),
    { state: "already_absent", materialId: "material-unknown" },
  );
  assert.equal(context.state.files.has(FILE_A), true);
  assert.deepEqual(context.state.deletedKeys, []);
  assert.deepEqual(context.state.broadcasts, []);
});

test("double clicks are serialized: one deletes and the retry observes absence", async (t) => {
  const context = await fixture({
    rows: [{ id: "material-a", fileKey: FILE_A }],
    files: [FILE_A],
  });
  t.after(() => context.close());

  const receipt = (await inspectPresent(context, "material-a")).receipt;

  const results = await Promise.all([
    context.service.deleteCareerMaterial(receipt),
    context.service.deleteCareerMaterial(receipt),
  ]);
  assert.deepEqual(results.map(({ outcome }) => outcome), ["deleted", "already_absent"]);
  assert.equal(context.state.lockCalls, 3);
  assert.equal(context.state.maxActiveLocks, 1);
  assert.deepEqual(context.state.deletedKeys, [FILE_A]);
});

test("a lost final SQLite response is verified as deleted instead of reported as failure", async (t) => {
  const context = await fixture({
    rows: [{ id: "material-a", fileKey: FILE_A }],
    files: [FILE_A],
    broadcastThrows: true,
  });
  t.after(() => context.close());
  context.state.finalFailure = "after";

  const result = await deleteInspected(context, "material-a");
  assert.deepEqual(result, {
    outcome: "deleted",
    materialId: "material-a",
    fileAction: "removed",
  });
  assert.equal(selectMaterial(context.database, "material-a"), null);
  assert.equal(context.state.files.has(FILE_A), false);
  assert.deepEqual(context.state.broadcasts, ["career-materials-changed"]);
});

test("if final commit verification is also unavailable the result stays uncertain", async (t) => {
  const context = await fixture({
    rows: [{ id: "material-a", fileKey: FILE_A }],
    files: [FILE_A],
  });
  t.after(() => context.close());
  context.state.finalFailure = "after";
  context.state.finalRecoveryQueryFailures = 1;

  const receipt = (await inspectPresent(context, "material-a")).receipt;

  assert.deepEqual(
    await context.service.deleteCareerMaterial(receipt),
    {
      outcome: "outcome_uncertain",
      materialId: "material-a",
      retryable: true,
    },
  );
  assert.equal(selectMaterial(context.database, "material-a"), null);
  assert.deepEqual(
    await context.service.inspectCareerMaterialDeletion("material-a"),
    { state: "already_absent", materialId: "material-a" },
  );
});

test("a pre-commit final DB failure keeps a deleting row and retry removes the index", async (t) => {
  const context = await fixture({
    rows: [{ id: "material-a", fileKey: FILE_A }],
    files: [FILE_A],
  });
  t.after(() => context.close());
  context.state.finalFailure = "before";

  const first = await deleteInspected(context, "material-a");
  assert.deepEqual(withoutReceipt(first), {
    outcome: "cleanup_pending",
    materialId: "material-a",
    reason: "database_cleanup_failed",
    retryable: true,
  });
  assert.equal(selectMaterial(context.database, "material-a").status, "deleting");
  assert.equal(context.state.files.has(FILE_A), false);

  const retried = await context.service.deleteCareerMaterial(first.receipt);
  assert.deepEqual(retried, {
    outcome: "deleted",
    materialId: "material-a",
    fileAction: "already_absent",
  });
  assert.equal(selectMaterial(context.database, "material-a"), null);
});

test("a lost mark response is recovered before OPFS cleanup", async (t) => {
  const context = await fixture({
    rows: [{ id: "material-a", fileKey: FILE_A }],
    files: [FILE_A],
  });
  t.after(() => context.close());
  context.state.markFailure = "after";

  const result = await deleteInspected(context, "material-a");
  assert.equal(result.outcome, "deleted");
  assert.equal(selectMaterial(context.database, "material-a"), null);
  assert.deepEqual(context.state.deletedKeys, [FILE_A]);
});

test("reference-check failure never risks a shared attachment and remains retryable", async (t) => {
  const context = await fixture({
    rows: [
      { id: "material-a", fileKey: FILE_A },
      { id: "material-b", fileKey: FILE_A },
    ],
    files: [FILE_A],
  });
  t.after(() => context.close());
  const receipt = (await inspectPresent(context, "material-a")).receipt;
  context.state.failReferenceQueriesRemaining = 1;

  const result = await context.service.deleteCareerMaterial(receipt);
  assert.equal(result.outcome, "cleanup_pending");
  assert.equal(result.reason, "reference_check_failed");
  assert.equal(selectMaterial(context.database, "material-a").status, "deleting");
  assert.equal(context.state.files.has(FILE_A), true);
  assert.deepEqual(context.state.deletedKeys, []);
});

test("a same-generation row edit invalidates the receipt before every mutation", async (t) => {
  const context = await fixture({
    rows: [{ id: "material-a", fileKey: FILE_A, name: "旧简历" }],
    files: [FILE_A, FILE_B],
  });
  t.after(() => context.close());
  const receipt = (await inspectPresent(context, "material-a")).receipt;

  executeRun(
    context.database,
    `UPDATE career_materials
        SET name = '新简历', version = 'v2',
            updated_at = '2026-08-22T00:00:00.000Z', file_key = ?
      WHERE id = 'material-a'`,
    [FILE_B],
  );
  const runCalls = context.state.runCalls;

  assert.deepEqual(await context.service.deleteCareerMaterial(receipt), {
    outcome: "changed",
    materialId: "material-a",
    retryable: true,
  });
  assert.equal(context.state.runCalls, runCalls);
  assert.deepEqual(context.state.deletedKeys, []);
  assert.deepEqual(selectMaterial(context.database, "material-a"), {
    id: "material-a",
    status: "ready",
    file_key: FILE_B,
  });
  assert.equal(context.state.files.has(FILE_A), true);
  assert.equal(context.state.files.has(FILE_B), true);
});

test("a generation switch without Broadcast never lets an old receipt delete the same id", async (t) => {
  const context = await fixture({
    rows: [{ id: "material-a", fileKey: FILE_A, name: "A 代简历" }],
    files: [FILE_A, FILE_B],
  });
  t.after(() => context.close());
  const receipt = (await inspectPresent(context, "material-a")).receipt;

  executeRun(context.database, "DELETE FROM career_materials WHERE id = ?", ["material-a"]);
  insertMaterial(context.database, {
    id: "material-a",
    fileKey: FILE_B,
    name: "B 代简历",
    version: "v9",
    updatedAt: "2026-08-30T00:00:00.000Z",
  });
  context.state.generation = {
    database: "zhiji",
    generationId: GENERATION_B,
    sequence: 2,
  };
  const queryCalls = context.state.queryCalls;
  const runCalls = context.state.runCalls;

  assert.deepEqual(await context.service.deleteCareerMaterial(receipt), {
    outcome: "changed",
    materialId: "material-a",
    retryable: true,
  });
  assert.equal(context.state.queryCalls, queryCalls);
  assert.equal(context.state.runCalls, runCalls);
  assert.deepEqual(context.state.deletedKeys, []);
  assert.deepEqual(context.state.broadcasts, []);
  assert.equal(selectMaterial(context.database, "material-a").file_key, FILE_B);
  assert.equal(context.state.files.has(FILE_A), true);
  assert.equal(context.state.files.has(FILE_B), true);
});

test("receipt tampering is rejected before the Career lock or any storage call", async (t) => {
  const context = await fixture({
    rows: [{ id: "material-a", fileKey: FILE_A }],
    files: [FILE_A],
  });
  t.after(() => context.close());
  const receipt = (await inspectPresent(context, "material-a")).receipt;
  const calls = {
    locks: context.state.lockCalls,
    generations: context.state.currentGenerationCalls,
    queries: context.state.queryCalls,
    runs: context.state.runCalls,
  };
  const tampered = {
    ...receipt,
    payload: receipt.payload.replace("material-a", "material-b"),
  };

  await assert.rejects(
    context.service.deleteCareerMaterial(tampered),
    (error) => error.code === "invalid_receipt" &&
      !/digest|payload|sha|sqlite|opfs/i.test(error.message),
  );
  assert.deepEqual({
    locks: context.state.lockCalls,
    generations: context.state.currentGenerationCalls,
    queries: context.state.queryCalls,
    runs: context.state.runCalls,
  }, calls);
  assert.deepEqual(context.state.deletedKeys, []);
  assert.equal(selectMaterial(context.database, "material-a").status, "ready");
});

test("a lost mark response with unavailable verification requires a fresh cleanup receipt", async (t) => {
  const context = await fixture({
    rows: [{ id: "material-a", fileKey: FILE_A }],
    files: [FILE_A],
  });
  t.after(() => context.close());
  const original = (await inspectPresent(context, "material-a")).receipt;
  context.state.markFailure = "after";
  context.state.markRecoveryQueryFailures = 1;

  assert.deepEqual(await context.service.deleteCareerMaterial(original), {
    outcome: "outcome_uncertain",
    materialId: "material-a",
    retryable: true,
  });
  assert.equal(selectMaterial(context.database, "material-a").status, "deleting");
  assert.deepEqual(context.state.deletedKeys, []);
  assert.deepEqual(await context.service.deleteCareerMaterial(original), {
    outcome: "changed",
    materialId: "material-a",
    retryable: true,
  });

  const recovered = await inspectPresent(context, "material-a");
  assert.equal(recovered.state, "cleanup_pending");
  assert.deepEqual(await context.service.deleteCareerMaterial(recovered.receipt), {
    outcome: "deleted",
    materialId: "material-a",
    fileAction: "removed",
  });
  assert.equal(selectMaterial(context.database, "material-a"), null);
});

test("safe public errors never expose SQLite or OPFS internals", async (t) => {
  const context = await fixture({ rows: [{ id: "material-a", fileKey: FILE_B }] });
  t.after(() => context.close());
  const receipt = (await inspectPresent(context, "material-a")).receipt;
  context.state.markFailure = "before";

  await assert.rejects(
    context.service.deleteCareerMaterial(receipt),
    (error) => {
      assert.equal(error.name, "CareerMaterialDeletionError");
      assert.equal(error.code, "mark_failed");
      assert.doesNotMatch(error.message, /sqlite|select|update|delete|opfs|path/i);
      return true;
    },
  );

  context.state.failQueriesRemaining = 1;
  await assert.rejects(
    context.service.inspectCareerMaterialDeletion("material-a"),
    (error) => {
      assert.equal(error.code, "inspect_failed");
      assert.doesNotMatch(error.message, /sqlite|select|career_materials|path/i);
      return true;
    },
  );
});

test("invalid identifiers are rejected before entering storage", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await assert.rejects(
    context.service.inspectCareerMaterialDeletion(" material-a "),
    (error) => error.code === "invalid_id",
  );
  assert.equal(context.state.lockCalls, 0);
});
