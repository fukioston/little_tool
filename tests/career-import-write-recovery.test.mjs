import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const NOW = "2026-08-22T04:00:00.000Z";
const GEN1 = "10000000-0000-4000-8000-000000000001";
const GEN2 = "20000000-0000-4000-8000-000000000002";

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function transpile(path) {
  const source = await readFile(new URL(path, root), "utf8");
  const result = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
  });
  assert.deepEqual(result.diagnostics.filter(({ category }) => category === ts.DiagnosticCategory.Error), []);
  return result.outputText;
}

const [schemaJs, markerRaw, importsRaw, writesRaw] = await Promise.all([
  transpile("lib/schemas/zhiji.ts"),
  transpile("lib/career/write-marker.ts"),
  transpile("lib/career/imports.ts"),
  transpile("lib/career/import-writes.ts"),
]);
const unexpectedUrl = moduleUrl(`export const localDb=new Proxy({}, {get(){return ()=>{throw new Error('unexpected legacy db call')}}});`);
const lockUrl = moduleUrl(`
  export function broadcastCareerDataChanged(){}
  export function withCareerWriteLock(task){return task();}
  export function withCareerReadLock(task){return task();}
`);
const markerUrl = moduleUrl(markerRaw
  .replaceAll('"@/lib/local-db/client"', `"${unexpectedUrl}"`)
  .replaceAll('"./lock"', `"${lockUrl}"`));
const importsUrl = moduleUrl(importsRaw
  .replaceAll('"@/lib/local-db/client"', `"${unexpectedUrl}"`)
  .replaceAll('"./lock"', `"${lockUrl}"`));
const writesUrl = moduleUrl(writesRaw
  .replaceAll('"./write-marker"', `"${markerUrl}"`)
  .replaceAll('"./imports"', `"${importsUrl}"`));
const [schema, imports, importWrites, sqlite3] = await Promise.all([
  import(moduleUrl(schemaJs)), import(importsUrl), import(writesUrl), sqlite3InitModule(),
]);
const marker = await import(markerUrl);

function execute(database, statements) {
  let changes = 0;
  database.transaction("IMMEDIATE", () => {
    for (const { sql, params = [] } of statements) {
      const statement = database.prepare(sql);
      try {
        if (params.length) statement.bind(params);
        while (statement.step()) { /* consume */ }
        changes += Number(database.changes());
      } finally { statement.finalize(); }
    }
  });
  return { changes };
}

function install(database) {
  execute(database, [
    ...schema.ZHIJI_V1_SCHEMA_STATEMENTS,
    ...schema.ZHIJI_V2_SCHEMA_MIGRATION_STATEMENTS,
    ...schema.ZHIJI_V3_SCHEMA_MIGRATION_STATEMENTS,
    ...schema.ZHIJI_V4_SCHEMA_MIGRATION_STATEMENTS,
    ...schema.ZHIJI_V5_SCHEMA_MIGRATION_STATEMENTS,
  ]);
  database.exec(schema.ZHIJI_STRUCTURAL_SEED_SQL);
}

function uuid(index) {
  return `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function fixture() {
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  install(database);
  const state = {
    active: 0, generationId: GEN1, generationSequence: 1,
    now: Date.parse(NOW), uuid: 1, batchFault: null, beforeBatch: null,
    broadcasts: [], queryCalls: 0, batchCalls: 0, lockCalls: 0,
  };
  const runtime = {
    async withExclusiveLock(operation) {
      state.lockCalls += 1;
      state.active += 1;
      try { return await operation(); } finally { state.active -= 1; }
    },
    async query(sql, params = []) {
      assert.equal(state.active, 1); state.queryCalls += 1;
      return { rows: database.selectObjects(sql, params) };
    },
    async batch(statements) {
      assert.equal(state.active, 1); state.batchCalls += 1;
      state.beforeBatch?.(); state.beforeBatch = null;
      if (state.batchFault === "before") { state.batchFault = null; throw new Error("before commit"); }
      const result = execute(database, statements);
      if (state.batchFault === "after") { state.batchFault = null; throw new Error("response lost"); }
      return result;
    },
    async currentGeneration() {
      assert.equal(state.active, 1);
      return { generationId: state.generationId, sequence: state.generationSequence };
    },
    now() { assert.equal(state.active, 1); return state.now; },
    randomUUID() { assert.equal(state.active, 1); return uuid(state.uuid++); },
    broadcast(reason) { assert.equal(state.active, 1); state.broadcasts.push(reason); },
  };
  return { database, state, service: importWrites.createCareerImportWriteStorageService(runtime), close() { database.close(); } };
}

async function preview(index = 1, operationId) {
  const sourceText = `Acme ${index} / Engineer ${index}`;
  const value = await imports.createCareerJobImportPreview({
    sourceText,
    parsedCandidate: { company: `Acme ${index}`, role: `Engineer ${index}`, source: "手动记录", stageId: "stage_saved" },
    importOperationId: operationId,
    now: new Date(Date.parse("2026-08-20T01:00:00.000Z") + index).toISOString(),
  });
  return { preview: value, currentSourceFingerprint: value.sourceFingerprint };
}

async function resign(receipt, mutate) {
  const cloned = structuredClone(receipt);
  await mutate(cloned);
  const { projectionSha256: _old, ...payload } = cloned;
  void _old;
  return marker.sealCareerWriteReceipt(payload);
}

function operationId(index) {
  return `import_${uuid(index)}`;
}

function callbackSnapshot(value) {
  return {
    lock: value.state.lockCalls,
    query: value.state.queryCalls,
    batch: value.state.batchCalls,
    broadcast: value.state.broadcasts.length,
  };
}

function stage(database, id = "stage_saved") {
  return database.selectObject("SELECT id,name,color,position,is_terminal,hidden FROM career_stages WHERE id=?", [id]);
}

function displayed(value, items) {
  return {
    generationId: value.state.generationId,
    generationSequence: value.state.generationSequence,
    stages: [stage(value.database)],
    rows: items.map(({ preview }) => ({
      importOperationId: preview.importOperationId,
      job: value.database.selectObject("SELECT * FROM career_jobs WHERE id=?", [preview.jobId]) ?? null,
      activity: value.database.selectObject("SELECT * FROM career_activity WHERE id=?", [preview.activityId]) ?? null,
    })),
  };
}

test("multirow import writes all rows and one immutable batch marker", async () => {
  const value = fixture();
  try {
    const items = [await preview(1), await preview(2)];
    const receipt = await value.service.prepareCareerImportWrite(items, displayed(value, items));
    assert.equal(await value.service.inspectCareerImportWrite(receipt), "expected");
    assert.equal((await value.service.commitCareerImportWrite(receipt)).outcome, "saved");
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_jobs"), 2);
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_activity"), 2);
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_write_operations"), 1);
    value.database.exec(`UPDATE career_jobs SET note='later' WHERE id='${receipt.after.rows[0].job.id}'`);
    assert.equal(await value.service.inspectCareerImportWrite(receipt), "exact_saved");
  } finally { value.close(); }
});

test("lost response converges by the exact marker", async () => {
  const value = fixture();
  try {
    const items = [await preview(3)];
    const receipt = await value.service.prepareCareerImportWrite(items, displayed(value, items));
    value.state.batchFault = "after";
    assert.equal((await value.service.commitCareerImportWrite(receipt)).outcome, "saved");
    assert.equal((await value.service.commitCareerImportWrite(receipt)).outcome, "already_saved");
  } finally { value.close(); }
});

test("full-row and stage CAS rejects same-generation edits without partial inserts", async () => {
  const value = fixture();
  try {
    const items = [await preview(4), await preview(5)];
    const receipt = await value.service.prepareCareerImportWrite(items, displayed(value, items));
    value.state.beforeBatch = () => value.database.exec("UPDATE career_stages SET color='#000000' WHERE id='stage_saved'");
    const result = await value.service.commitCareerImportWrite(receipt);
    assert.equal(result.outcome, "changed");
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_jobs"), 0);
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_write_operations"), 0);
  } finally { value.close(); }
});

test("existing exact rows can be marked while partial or conflicting rows are refused", async () => {
  const value = fixture();
  try {
    const items = [await preview(6)];
    const first = await value.service.prepareCareerImportWrite(items, displayed(value, items));
    assert.equal((await value.service.commitCareerImportWrite(first)).outcome, "saved");
    const exact = await value.service.prepareCareerImportWrite(items, displayed(value, items));
    assert.equal((await value.service.commitCareerImportWrite(exact)).outcome, "saved");
    value.database.exec(`DELETE FROM career_activity WHERE id='${items[0].preview.activityId}'`);
    await assert.rejects(() => value.service.prepareCareerImportWrite(items, displayed(value, items)), /不完整记录/);
  } finally { value.close(); }
});

test("mixed existing and fresh rows preserve one-to-one identity and insert only the fresh row", async () => {
  const value = fixture();
  try {
    const existing = await preview(20, operationId(20));
    const initial = await value.service.prepareCareerImportWrite([existing], displayed(value, [existing]));
    assert.equal((await value.service.commitCareerImportWrite(initial)).outcome, "saved");

    const fresh = await preview(21, operationId(21));
    const items = [existing, fresh];
    const receipt = await value.service.prepareCareerImportWrite(items, displayed(value, items));
    assert.equal(receipt.before.rows.filter(({ job }) => job !== null).length, 1);
    assert.equal(receipt.before.rows.filter(({ job }) => job === null).length, 1);
    assert.equal((await value.service.commitCareerImportWrite(receipt)).outcome, "saved");
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_jobs"), 2);
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_activity"), 2);
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_write_operations"), 2);
  } finally { value.close(); }
});

test("re-signed import linkage and preview forgeries are rejected before the lock", async () => {
  const value = fixture();
  try {
    const items = [
      await preview(30, operationId(30)),
      await preview(31, operationId(31)),
    ];
    const receipt = await value.service.prepareCareerImportWrite(items, displayed(value, items));
    const impossible = await imports.createCareerJobImportPreview({
      sourceText: "missing company",
      parsedCandidate: { company: "", role: "Engineer", source: "手动记录", stageId: "stage_saved" },
      importOperationId: receipt.after.rows[0].importOperationId,
      now: receipt.after.rows[0].preview.createdAt,
    });
    const cases = [
      (forged) => { forged.before.rows.pop(); },
      (forged) => { forged.after.rows.reverse(); },
      (forged) => { forged.after.rows[0].importOperationId = forged.after.rows[1].importOperationId; },
      (forged) => { forged.after.rows[0].job.id = "job_ffffffff-ffff-4fff-8fff-ffffffffffff"; },
      (forged) => { forged.after.rows[0].activity.job_id = forged.after.rows[1].job.id; },
      (forged) => { forged.before.stages = []; },
      (forged) => { forged.operationAt = forged.after.rows[0].job.created_at; },
      (forged) => { forged.before.rows[0].job = structuredClone(forged.after.rows[0].job); },
      (forged) => { forged.after.rows[0].previewFingerprint = forged.after.rows[1].previewFingerprint; },
      (forged) => {
        forged.after.rows[0].preview = impossible;
        forged.after.rows[0].previewFingerprint = impossible.previewFingerprint;
        forged.after.rows[0].job = imports.careerImportExpectedJob(impossible);
        forged.after.rows[0].activity = imports.careerImportExpectedActivity(impossible);
      },
    ];
    for (const mutate of cases) {
      const forged = await resign(receipt, mutate);
      const before = callbackSnapshot(value);
      assert.equal(await value.service.inspectCareerImportWrite(forged), "invalid_receipt");
      await assert.rejects(() => value.service.commitCareerImportWrite(forged),
        (error) => error.code === "invalid_receipt");
      assert.deepEqual(callbackSnapshot(value), before);
    }
  } finally { value.close(); }
});

test("the 2000-row batch succeeds while row-count and 8 MiB overflow stop before the lock", async () => {
  const value = fixture();
  try {
    const items = await Promise.all(Array.from({ length: 2_000 }, (_, index) =>
      preview(100 + index, operationId(100 + index))));
    const receipt = await value.service.prepareCareerImportWrite(items, displayed(value, items));
    assert.equal(receipt.after.rows.length, 2_000);
    assert.equal((await value.service.commitCareerImportWrite(receipt)).outcome, "saved");
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_jobs"), 2_000);
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_activity"), 2_000);

    const beforeRows = callbackSnapshot(value);
    await assert.rejects(() => value.service.prepareCareerImportWrite(
      [...items, items[0]], displayed(value, items)),
    (error) => error.code === "invalid_input");
    assert.deepEqual(callbackSnapshot(value), beforeRows);

    const oversized = structuredClone(items[0]);
    oversized.preview.candidate.description = "界".repeat(3_000_000);
    const beforeBytes = callbackSnapshot(value);
    await assert.rejects(() => value.service.prepareCareerImportWrite(
      [oversized], displayed(value, [items[0]])),
    (error) => error.code === "invalid_input");
    assert.deepEqual(callbackSnapshot(value), beforeBytes);
  } finally { value.close(); }
});

test("generation replacement and changed source are refused before writes", async () => {
  const value = fixture();
  try {
    const items = [await preview(7)];
    await assert.rejects(() => value.service.prepareCareerImportWrite([
      { ...items[0], currentSourceFingerprint: "sha256:" + "0".repeat(64) },
    ], displayed(value, items)), /来源已经变化/);
    const receipt = await value.service.prepareCareerImportWrite(items, displayed(value, items));
    value.state.generationId = GEN2; value.state.generationSequence = 2;
    assert.equal((await value.service.commitCareerImportWrite(receipt)).outcome, "changed");
    assert.equal(value.state.batchCalls, 0);
  } finally { value.close(); }
});

test("a refused Web Lock enters no storage callback", async () => {
  let callbacks = 0;
  const runtime = {
    async withExclusiveLock() { throw new Error("no lock"); },
    async query() { callbacks += 1; throw new Error("unexpected"); },
    async batch() { callbacks += 1; throw new Error("unexpected"); },
    async currentGeneration() { callbacks += 1; throw new Error("unexpected"); },
    now() { callbacks += 1; return 0; }, randomUUID() { callbacks += 1; return uuid(9); }, broadcast() { callbacks += 1; },
  };
  const service = importWrites.createCareerImportWriteStorageService(runtime);
  const items = [await preview(8)];
  await assert.rejects(() => service.prepareCareerImportWrite(items, {
    generationId: GEN1, generationSequence: 1, stages: [], rows: [],
  }));
  assert.equal(callbacks, 0);
});
