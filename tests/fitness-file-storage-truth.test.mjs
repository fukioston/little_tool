import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const OPERATION_ID = "10000000-0000-4000-8000-000000000001";
const FILE_KEY = "20000000-0000-4000-8000-000000000002";
const DELETE_ID = "30000000-0000-4000-8000-000000000003";
const GENERATION_A = "a0000000-0000-4000-8000-00000000000a";
const GENERATION_B = "b0000000-0000-4000-8000-00000000000b";
const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);

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

const rawJavaScript = await transpile("lib/fitness/files.ts");
const dependencies = {
  "@/lib/local-db/client": moduleUrl("export const localDb = {};"),
  "@/lib/local-db/files": moduleUrl(`
    export async function assertLocalFileKeyAvailable(){ throw new Error("default runtime not used"); }
    export async function deleteOwnedLocalFile(){ throw new Error("default runtime not used"); }
    export async function deleteLocalFile(){ throw new Error("default runtime not used"); }
    export async function getLocalFile(){ throw new Error("default runtime not used"); }
    export async function listLocalFiles(){ throw new Error("default runtime not used"); }
    export async function saveLocalFile(){ throw new Error("default runtime not used"); }
    export async function saveLocalFileAtKey(){ throw new Error("default runtime not used"); }
    export async function sha256Blob(){ throw new Error("default runtime not used"); }
  `),
  "./catalog": moduleUrl("export function getFitnessExercise(){ return null; }"),
  "./lock": moduleUrl(`
    export function broadcastFitnessChange(){}
    export function withFitnessWriteLock(task){ return task(); }
  `),
};
let serviceJavaScript = rawJavaScript;
for (const [specifier, url] of Object.entries(dependencies)) {
  serviceJavaScript = serviceJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const files = await import(moduleUrl(serviceJavaScript));

async function hashBlob(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Buffer.from(digest).toString("hex");
}

function pngFile(name = "器械照片.png") {
  return new File([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3),
  ], name, { type: "image/png" });
}

function executeRun(database, sql, params = []) {
  const statement = database.prepare(sql);
  try {
    if (params.length) statement.bind(params);
    while (statement.step()) {
      // Consume any rows from statements with RETURNING.
    }
  } finally {
    statement.finalize();
  }
  return { changes: Number(database.changes()) };
}

async function fixture(options = {}) {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE fitness_venues(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE fitness_equipment(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE fitness_sessions(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE fitness_files(
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      file_key TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO fitness_venues(id) VALUES('venue-1');
    INSERT INTO fitness_equipment(id) VALUES('equipment-1');
    INSERT INTO fitness_sessions(id) VALUES('session-1');
  `);
  const state = {
    lockDepth: 0,
    lockCalls: 0,
    opfs: new Map(),
    deleted: [],
    broadcasts: [],
    generation: {
      database: "shilian",
      generationId: GENERATION_A,
      filename: `shilian.${GENERATION_A}.sqlite3`,
      sequence: 1,
      legacy: false,
    },
    uuidQueue: [OPERATION_ID, FILE_KEY, DELETE_ID],
    ownerQueue: [OWNER_A],
    now: 1_800_000_000_000,
  };
  const requireLock = (name) => assert.equal(state.lockDepth, 1, `${name} must hold lock`);
  const runtime = {
    async withExclusiveLock(task) {
      assert.equal(state.lockDepth, 0);
      state.lockCalls += 1;
      state.lockDepth = 1;
      try {
        return await task();
      } finally {
        state.lockDepth = 0;
      }
    },
    async query(sql, params = []) {
      requireLock("query");
      const rows = database.selectObjects(sql, params);
      return { rows };
    },
    async run(sql, params = []) {
      requireLock("run");
      if (options.failInsertBeforeCommit && /INSERT INTO fitness_files/.test(sql)) {
        throw new Error("sqlite insert rejected before commit");
      }
      const result = executeRun(database, sql, params);
      if (options.loseInsertResponse && /INSERT INTO fitness_files/.test(sql)) {
        throw new Error("sqlite insert response lost");
      }
      if (options.loseMarkResponse && /SET status = 'deleting'/.test(sql)) {
        throw new Error("sqlite mark response lost");
      }
      if (options.loseDeleteResponse && /DELETE FROM fitness_files WHERE id = \? AND entity_type/.test(sql)) {
        throw new Error("sqlite delete response lost");
      }
      return result;
    },
    async currentGeneration() {
      requireLock("generation");
      return { ...state.generation };
    },
    async assertFileKeyAvailable(key) {
      requireLock("key inspection");
      if (!state.opfs.has(key)) return;
      const error = new Error("collision");
      error.code = "FILE_KEY_COLLISION";
      throw error;
    },
    async saveFileAtKey(key, blob, saveOptions, stagingOwner) {
      requireLock("OPFS save");
      if (state.opfs.has(key)) throw new Error("collision");
      if (options.partialClaim) {
        state.opfs.set(key, { partial: true, stagingOwner });
        throw new Error("OPFS stopped after ownership claim");
      }
      const metadata = {
        version: 1,
        key,
        namespace: "fitness",
        originalName: saveOptions.originalName,
        mimeType: saveOptions.mimeType,
        category: saveOptions.category ?? null,
        byteSize: blob.size,
        sha256: await hashBlob(blob),
        createdAt: saveOptions.createdAt,
        updatedAt: saveOptions.updatedAt,
        stagingOwner,
      };
      state.opfs.set(key, {
        metadata,
        file: new File([blob], metadata.originalName, { type: metadata.mimeType }),
      });
      return metadata;
    },
    async deleteOwnedFile(key, stagingOwner) {
      requireLock("owned OPFS delete");
      state.deleted.push(key);
      const current = state.opfs.get(key);
      if (!current) return false;
      if ((current.metadata?.stagingOwner ?? current.stagingOwner) !== stagingOwner) {
        const error = new Error("foreign owner");
        error.code = "FILE_OWNERSHIP_MISMATCH";
        throw error;
      }
      state.opfs.delete(key);
      if (options.loseOwnedDeleteResponse) throw new Error("OPFS delete response lost");
      return true;
    },
    async saveFile() {
      throw new Error("legacy random-key save is not expected");
    },
    async getFile(key) {
      requireLock("OPFS read");
      const current = state.opfs.get(key);
      if (!current || current.partial) throw new Error("OPFS entry incomplete");
      return current;
    },
    async listFiles() {
      requireLock("OPFS list");
      return [...state.opfs.values()].flatMap((entry) => entry.metadata ? [entry.metadata] : []);
    },
    async deleteFile(key) {
      requireLock("legacy OPFS delete");
      state.deleted.push(key);
      return state.opfs.delete(key);
    },
    hashBlob,
    getBuiltInExercise() {
      return null;
    },
    randomUUID() {
      return state.uuidQueue.shift() ?? DELETE_ID;
    },
    randomOwner() {
      return state.ownerQueue.shift() ?? OWNER_A;
    },
    now() {
      state.now += 1;
      return state.now;
    },
    broadcast(reason) {
      requireLock("broadcast");
      if (options.broadcastThrows) throw new Error("broadcast unavailable");
      state.broadcasts.push(reason);
    },
  };
  return {
    database,
    state,
    service: files.createFitnessFileService(runtime),
  };
}

function saveInput(file = pngFile()) {
  return {
    entityType: "venue",
    entityId: "venue-1",
    purpose: "photo",
    file,
  };
}

function selectFile(database, id) {
  return database.selectObject("SELECT * FROM fitness_files WHERE id = ?", [id]) ?? null;
}

test("real SQLite proves post-ready response loss cannot trigger OPFS compensation", async (t) => {
  const context = await fixture({ loseInsertResponse: true, broadcastThrows: true });
  t.after(() => context.database.close());
  const input = saveInput();
  const receipt = await context.service.prepareFitnessFileSave(input);
  const result = await context.service.saveFitnessFileSafely(input, receipt);

  assert.equal(result.outcome, "saved");
  assert.equal(selectFile(context.database, receipt.expectedRow.id).status, "ready");
  assert.equal(context.state.opfs.has(receipt.expectedFile.key), true);
  assert.equal(context.state.deleted.length, 0);
  assert.equal(await context.service.inspectFitnessFileSave(receipt), "exact_saved");
});

test("real SQLite precommit failure deletes only the exact owned stage", async (t) => {
  const context = await fixture({ failInsertBeforeCommit: true });
  t.after(() => context.database.close());
  const input = saveInput();
  const receipt = await context.service.prepareFitnessFileSave(input);
  await assert.rejects(
    context.service.saveFitnessFileSafely(input, receipt),
    (error) => error.code === "SAVE_NOT_COMMITTED",
  );
  assert.equal(selectFile(context.database, receipt.expectedRow.id), null);
  assert.equal(context.state.opfs.has(receipt.expectedFile.key), false);
  assert.deepEqual(context.state.deleted, [receipt.expectedFile.key]);
});

test("receipt-only recovery handles a partial claim and refuses a foreign owner", async (t) => {
  const context = await fixture({ partialClaim: true });
  t.after(() => context.database.close());
  const input = saveInput();
  const receipt = await context.service.prepareFitnessFileSave(input);
  const uncertain = await context.service.saveFitnessFileSafely(input, receipt);
  assert.equal(uncertain.outcome, "outcome_uncertain");

  context.state.opfs.get(receipt.expectedFile.key).stagingOwner = OWNER_B;
  const foreign = await context.service.discardFitnessFileSave(receipt);
  assert.equal(foreign.outcome, "outcome_uncertain");
  assert.equal(context.state.opfs.has(receipt.expectedFile.key), true);
  assert.equal(selectFile(context.database, receipt.expectedRow.id), null);
});

test("real SQLite full-row CAS and generation binding protect a newer row", async (t) => {
  const context = await fixture();
  t.after(() => context.database.close());
  const input = saveInput();
  const saveReceipt = await context.service.prepareFitnessFileSave(input);
  await context.service.saveFitnessFileSafely(input, saveReceipt);
  const deleteReceipt = await context.service.prepareFitnessFileDelete(
    saveReceipt.expectedRow.id,
  );

  executeRun(
    context.database,
    "UPDATE fitness_files SET updated_at = updated_at + 1 WHERE id = ?",
    [saveReceipt.expectedRow.id],
  );
  const stale = await context.service.deleteFitnessFileSafely(deleteReceipt);
  assert.equal(stale.outcome, "conflict");
  assert.equal(selectFile(context.database, saveReceipt.expectedRow.id).status, "ready");
  assert.equal(context.state.opfs.has(saveReceipt.expectedFile.key), true);

  context.state.generation = {
    ...context.state.generation,
    generationId: GENERATION_B,
    sequence: 2,
  };
  const switched = await context.service.deleteFitnessFileSafely(deleteReceipt);
  assert.equal(switched.outcome, "conflict");
  assert.equal(context.state.opfs.has(saveReceipt.expectedFile.key), true);
});

test("real SQLite deletion survives every lost response and a failed notification", async (t) => {
  const context = await fixture({
    loseMarkResponse: true,
    loseOwnedDeleteResponse: true,
    loseDeleteResponse: true,
    broadcastThrows: true,
  });
  t.after(() => context.database.close());
  const input = saveInput();
  const saveReceipt = await context.service.prepareFitnessFileSave(input);
  await context.service.saveFitnessFileSafely(input, saveReceipt);
  const deleteReceipt = await context.service.prepareFitnessFileDelete(
    saveReceipt.expectedRow.id,
  );
  const result = await context.service.deleteFitnessFileSafely(deleteReceipt);

  assert.equal(result.outcome, "deleted");
  assert.equal(selectFile(context.database, saveReceipt.expectedRow.id), null);
  assert.equal(context.state.opfs.has(saveReceipt.expectedFile.key), false);
  assert.equal(await context.service.inspectFitnessFileDelete(deleteReceipt), "absent");
});
