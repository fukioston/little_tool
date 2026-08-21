import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const NOW = "2026-08-21T08:00:00.000Z";
const FILE_KEY_A = "10000000-0000-4000-8000-000000000001";
const FILE_KEY_B = "20000000-0000-4000-8000-000000000002";
const GENERATION_A = "30000000-0000-4000-8000-000000000003";
const GENERATION_B = "40000000-0000-4000-8000-000000000004";

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

const source = await readFile(new URL("lib/career/material-save.ts", projectRoot), "utf8");
const rawJavaScript = await transpile("lib/career/material-save.ts");
const dependencies = {
  "@/lib/local-db/client": moduleUrl("export const localDb = {};"),
  "@/lib/local-db/files": moduleUrl(`
    export async function deleteLocalFile(){ throw new Error("default runtime not used"); }
    export async function getLocalFile(){ throw new Error("default runtime not used"); }
    export async function saveLocalFile(){ throw new Error("default runtime not used"); }
    export async function sha256Blob(){ throw new Error("default runtime not used"); }
  `),
  "./lock": moduleUrl(`
    export function withCareerWriteLock(task){ return task(); }
  `),
};
let serviceJavaScript = rawJavaScript;
for (const [specifier, url] of Object.entries(dependencies)) {
  serviceJavaScript = serviceJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const materialSave = await import(moduleUrl(serviceJavaScript));

async function hashBlob(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Buffer.from(digest).toString("hex");
}

function executeRun(database, sql, params = []) {
  const statement = database.prepare(sql);
  try {
    if (params.length > 0) statement.bind(params);
    while (statement.step()) {
      // Consume statements that unexpectedly return rows.
    }
  } finally {
    statement.finalize();
  }
  return {
    changes: Number(database.changes()),
    lastInsertRowId: database.selectValue("SELECT last_insert_rowid()") ?? null,
  };
}

function materialInput(overrides = {}) {
  return {
    materialId: "material-stable-a",
    name: "产品设计主简历",
    kind: "简历",
    version: "v3.2",
    updatedAt: NOW,
    linkedJobId: null,
    status: "ready",
    notes: "针对平台岗位调整了案例顺序",
    attachment: {
      blob: new Blob(["private resume bytes"], { type: "application/pdf" }),
      originalName: "主简历.pdf",
      mimeType: "application/pdf",
    },
    ...overrides,
  };
}

async function expectedSnapshot(input) {
  return {
    name: input.name.trim().replace(/\s+/g, " "),
    kind: input.kind.trim().replace(/\s+/g, " "),
    version: input.version.trim().replace(/\s+/g, " "),
    updatedAt: new Date(input.updatedAt).toISOString(),
    linkedJobId: input.linkedJobId || null,
    status: input.status,
    notes: (input.notes ?? "").replace(/\r\n?/g, "\n").trim(),
    attachment: input.attachment
      ? {
          originalName: input.attachment.originalName,
          mimeType: input.attachment.mimeType,
          byteSize: input.attachment.blob.size,
          sha256: await hashBlob(input.attachment.blob),
        }
      : null,
  };
}

function selectMaterial(database, id) {
  return database.selectObject(
    `SELECT id,name,kind,version,updated_at,linked_job_id,status,notes,
            file_key,file_name,mime_type,byte_size
       FROM career_materials WHERE id = ?`,
    [id],
  ) ?? null;
}

async function fixture(options = {}) {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE career_jobs(id TEXT PRIMARY KEY);
    CREATE TABLE career_materials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT '简历',
      version TEXT NOT NULL DEFAULT 'v1.0',
      updated_at TEXT NOT NULL,
      linked_job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      notes TEXT NOT NULL DEFAULT '',
      file_key TEXT,
      file_name TEXT,
      mime_type TEXT,
      byte_size INTEGER
    );
    INSERT INTO career_jobs(id) VALUES('job-a');
  `);

  const state = {
    activeLocks: 0,
    maxActiveLocks: 0,
    lockCalls: 0,
    tail: Promise.resolve(),
    gate: null,
    files: new Map(),
    fileReadErrorCodes: new Map(),
    keyQueue: [...(options.keyQueue ?? [FILE_KEY_A, FILE_KEY_B])],
    operations: [],
    generation: {
      database: "zhiji",
      generationId: GENERATION_A,
      sequence: 3,
    },
    generationQueue: [],
    queryCalls: 0,
    runCalls: 0,
    saveCalls: 0,
    getCalls: 0,
    deleteCalls: 0,
    broadcasts: [],
    queryFailuresRemaining: 0,
    insertFailure: null,
    recoveryQueryFailures: 0,
    saveFailure: null,
    getFailuresRemaining: 0,
    deleteFailuresRemaining: 0,
    deleteAfterFailuresRemaining: 0,
    hashFailuresRemaining: 0,
    broadcastThrows: Boolean(options.broadcastThrows),
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
      if (state.gate) await state.gate;
      state.activeLocks += 1;
      state.maxActiveLocks = Math.max(state.maxActiveLocks, state.activeLocks);
      try {
        return await operation();
      } finally {
        state.activeLocks -= 1;
        release();
      }
    },
    async currentGeneration() {
      requireLock("generation read");
      state.operations.push(["generation"]);
      const queued = state.generationQueue.shift();
      return { ...(queued ?? state.generation) };
    },
    async query(sql, params = []) {
      requireLock("SQLite read");
      state.queryCalls += 1;
      state.operations.push(["query", params[0]]);
      if (state.queryFailuresRemaining > 0) {
        state.queryFailuresRemaining -= 1;
        throw new Error("SELECT career_materials exposed internal SQL");
      }
      const rows = database.selectObjects(sql, params);
      return { columns: [], rows, rowCount: rows.length };
    },
    async run(sql, params = []) {
      requireLock("SQLite write");
      state.runCalls += 1;
      state.operations.push(["run", params[0]]);
      if (state.insertFailure === "before") {
        state.insertFailure = null;
        state.queryFailuresRemaining += state.recoveryQueryFailures;
        state.recoveryQueryFailures = 0;
        throw new Error("INSERT failed before commit");
      }
      if (state.insertFailure === "conflict") {
        state.insertFailure = null;
        const conflicting = [...params];
        conflicting[7] = "由另一份材料占用";
        conflicting[8] = null;
        conflicting[9] = null;
        conflicting[10] = null;
        conflicting[11] = null;
        executeRun(database, sql, conflicting);
        throw new Error("INSERT collided with another material");
      }
      const result = executeRun(database, sql, params);
      if (state.insertFailure === "after") {
        state.insertFailure = null;
        state.queryFailuresRemaining += state.recoveryQueryFailures;
        state.recoveryQueryFailures = 0;
        throw new Error("INSERT committed but response was lost");
      }
      return result;
    },
    async saveFile(blob, saveOptions) {
      requireLock("OPFS save");
      state.saveCalls += 1;
      state.operations.push(["save"]);
      if (state.saveFailure) throw state.saveFailure;
      const key = state.keyQueue.shift() ?? FILE_KEY_A;
      const metadata = {
        version: 1,
        key,
        namespace: "career",
        originalName: saveOptions.originalName,
        mimeType: saveOptions.mimeType,
        category: saveOptions.category ?? null,
        byteSize: blob.size,
        sha256: await hashBlob(blob),
        createdAt: saveOptions.createdAt,
        updatedAt: saveOptions.updatedAt,
      };
      state.files.set(key, { metadata, blob });
      return metadata;
    },
    async getFile(key) {
      requireLock("OPFS read");
      state.getCalls += 1;
      state.operations.push(["get", key]);
      if (state.getFailuresRemaining > 0) {
        state.getFailuresRemaining -= 1;
        throw new Error("OPFS /private/file missing");
      }
      const readErrorCode = state.fileReadErrorCodes.get(key);
      if (readErrorCode) {
        throw Object.assign(new Error("OPFS file has a missing component"), {
          code: readErrorCode,
        });
      }
      const entry = state.files.get(key);
      if (!entry) {
        throw Object.assign(new Error("OPFS file absent"), {
          code: "FILE_NOT_FOUND",
        });
      }
      return { metadata: { ...entry.metadata }, file: entry.blob };
    },
    async deleteFile(key) {
      requireLock("OPFS delete");
      state.deleteCalls += 1;
      state.operations.push(["delete", key]);
      if (state.deleteFailuresRemaining > 0) {
        state.deleteFailuresRemaining -= 1;
        throw new Error("OPFS cleanup path leaked");
      }
      const deleted = state.files.delete(key);
      const partialDeleted = state.fileReadErrorCodes.delete(key);
      if (state.deleteAfterFailuresRemaining > 0) {
        state.deleteAfterFailuresRemaining -= 1;
        throw new Error("OPFS cleanup response was lost");
      }
      return deleted || partialDeleted;
    },
    async hashBlob(blob) {
      requireLock("blob hash");
      if (state.hashFailuresRemaining > 0) {
        state.hashFailuresRemaining -= 1;
        throw new Error("hash worker exploded");
      }
      return hashBlob(blob);
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
    runtime,
    service: materialSave.createCareerMaterialSaveService(runtime),
    close() {
      database.close();
    },
  };
}

async function createPendingCleanup(context) {
  context.state.insertFailure = "before";
  context.state.deleteFailuresRemaining = 1;
  let receipt;
  await assert.rejects(
    context.service.saveCareerMaterial(materialInput()),
    (error) => {
      assert.equal(error.code, "temporary_file_cleanup_failed");
      assert.ok(error.cleanupReceipt);
      receipt = error.cleanupReceipt;
      return true;
    },
  );
  assert.ok(receipt);
  assert.equal(selectMaterial(context.database, "material-stable-a"), null);
  assert.equal(context.state.files.has(FILE_KEY_A), true);
  return receipt;
}

test("source keeps saves and inspections behind the Career lock without generation broadcasts", () => {
  assert.match(source, /withCareerWriteLock/);
  assert.doesNotMatch(source, /broadcastCareerGenerationChanged/);
  assert.match(source, /INSERT INTO career_materials\([\s\S]*VALUES\(\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?\)/);
  assert.match(source, /WHERE id = \?[\s\S]*LIMIT 1/);
});

test("a successful attached save persists every field from OPFS-authored metadata", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const input = materialInput({ linkedJobId: "job-a" });

  const result = await context.service.saveCareerMaterial(input);
  assert.deepEqual(result, {
    outcome: "saved",
    materialId: input.materialId,
    fileKey: FILE_KEY_A,
  });
  assert.deepEqual(selectMaterial(context.database, input.materialId), {
    id: input.materialId,
    name: input.name,
    kind: input.kind,
    version: input.version,
    updated_at: NOW,
    linked_job_id: "job-a",
    status: input.status,
    notes: input.notes,
    file_key: FILE_KEY_A,
    file_name: input.attachment.originalName,
    mime_type: input.attachment.mimeType,
    byte_size: input.attachment.blob.size,
  });
  assert.equal(context.state.files.get(FILE_KEY_A).metadata.category, "career-material");
  assert.deepEqual(context.state.broadcasts, ["career-material-saved"]);
});

test("an OPFS failure performs no SQLite insert", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  context.state.saveFailure = new Error("OPFS internal failure");

  await assert.rejects(
    context.service.saveCareerMaterial(materialInput()),
    (error) => {
      assert.equal(error.code, "attachment_write_failed");
      assert.doesNotMatch(error.message, /opfs|sqlite|insert|path/i);
      return true;
    },
  );
  assert.equal(context.state.runCalls, 0);
  assert.equal(selectMaterial(context.database, "material-stable-a"), null);
});

test("cleanup receipt issuance happens before INSERT and a signing failure cleans the stage", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const originalBtoa = globalThis.btoa;
  globalThis.btoa = () => {
    throw new Error("receipt encoding unavailable");
  };
  t.after(() => {
    globalThis.btoa = originalBtoa;
  });

  await assert.rejects(
    context.service.saveCareerMaterial(materialInput()),
    (error) => {
      assert.equal(error.code, "write_failed");
      assert.equal(error.cleanupReceipt, undefined);
      return true;
    },
  );
  assert.equal(context.state.runCalls, 0);
  assert.equal(context.state.deleteCalls, 1);
  assert.equal(context.state.files.has(FILE_KEY_A), false);
  assert.equal(selectMaterial(context.database, "material-stable-a"), null);
});

test("a definite pre-commit SQL failure cleans the staged file only after confirming absence", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  context.state.insertFailure = "before";

  await assert.rejects(
    context.service.saveCareerMaterial(materialInput()),
    (error) => error.code === "write_failed",
  );
  assert.equal(selectMaterial(context.database, "material-stable-a"), null);
  assert.equal(context.state.files.has(FILE_KEY_A), false);
  assert.equal(context.state.deleteCalls, 1);
  const runIndex = context.state.operations.findIndex(([kind]) => kind === "run");
  const recoveryReadIndex = context.state.operations.findIndex(
    ([kind], index) => kind === "query" && index > runIndex,
  );
  const deleteIndex = context.state.operations.findIndex(([kind]) => kind === "delete");
  assert.ok(runIndex >= 0 && recoveryReadIndex > runIndex && deleteIndex > recoveryReadIndex);
});

test("a durable insert with a lost response is verified exactly and never deletes its attachment", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  context.state.insertFailure = "after";

  const result = await context.service.saveCareerMaterial(materialInput());
  assert.equal(result.outcome, "saved");
  assert.equal(result.fileKey, FILE_KEY_A);
  assert.notEqual(selectMaterial(context.database, result.materialId), null);
  assert.equal(context.state.files.has(FILE_KEY_A), true);
  assert.equal(context.state.deleteCalls, 0);
});

test("a post-stage conflict never strands an attachment without recovery", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  context.state.insertFailure = "conflict";
  let receipt;

  await assert.rejects(
    context.service.saveCareerMaterial(materialInput()),
    (error) => {
      assert.equal(error.code, "temporary_file_cleanup_failed");
      assert.ok(error.cleanupReceipt);
      receipt = error.cleanupReceipt;
      return true;
    },
  );
  assert.ok(receipt);
  assert.equal(context.state.files.has(FILE_KEY_A), true);
  assert.equal(context.state.deleteCalls, 0);
  assert.equal(selectMaterial(context.database, "material-stable-a").notes, "由另一份材料占用");
  assert.deepEqual(
    await context.service.retryCareerMaterialSaveCleanup(receipt),
    { outcome: "blocked", reason: "material_present", receipt },
  );
  assert.equal(context.state.files.has(FILE_KEY_A), true);
  assert.equal(context.state.deleteCalls, 0);
});

test("durable insert plus failed verification stays uncertain and hides the file key", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  context.state.insertFailure = "after";
  context.state.recoveryQueryFailures = 1;

  const result = await context.service.saveCareerMaterial(materialInput());
  assert.equal(result.outcome, "outcome_uncertain");
  assert.equal(result.materialId, "material-stable-a");
  assert.equal(result.retryable, true);
  assert.equal("fileKey" in result, false);
  assert.equal(JSON.stringify(result).includes(FILE_KEY_A), false);
  assert.ok(result.cleanupReceipt);
  assert.notEqual(selectMaterial(context.database, result.materialId), null);
  assert.equal(context.state.files.has(FILE_KEY_A), true);
  assert.equal(context.state.deleteCalls, 0);

  assert.equal(
    await context.service.inspectCareerMaterialSave(
      result.materialId,
      result.expectedSnapshot,
    ),
    "exact_saved",
  );
  assert.deepEqual(
    await context.service.retryCareerMaterialSaveCleanup(result.cleanupReceipt),
    {
      outcome: "blocked",
      reason: "material_present",
      receipt: result.cleanupReceipt,
    },
  );
  assert.equal(context.state.files.has(FILE_KEY_A), true);
  assert.equal(context.state.deleteCalls, 0);
});

test("retrying the exact uncertain payload is idempotent and performs no second write", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const input = materialInput();
  context.state.insertFailure = "after";
  context.state.recoveryQueryFailures = 1;
  const uncertain = await context.service.saveCareerMaterial(input);
  assert.equal(uncertain.outcome, "outcome_uncertain");

  const retried = await context.service.saveCareerMaterial(input);
  assert.deepEqual(retried, {
    outcome: "already_saved",
    materialId: input.materialId,
    fileKey: FILE_KEY_A,
  });
  assert.equal(context.state.saveCalls, 1);
  assert.equal(context.state.runCalls, 1);
  assert.equal(context.database.selectValue("SELECT COUNT(*) FROM career_materials"), 1);
});

test("uncertain inspection of an existing row never invents a cleanup receipt", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const input = materialInput();
  await context.service.saveCareerMaterial(input);
  context.state.getFailuresRemaining = 1;

  const uncertain = await context.service.saveCareerMaterial(input);
  assert.equal(uncertain.outcome, "outcome_uncertain");
  assert.equal(uncertain.cleanupReceipt, null);
  assert.equal(context.state.saveCalls, 1);
  assert.equal(context.state.runCalls, 1);
  assert.equal(context.state.files.has(FILE_KEY_A), true);
});

test("an ambiguous absent insert cleans its original staged file before a save retry", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const input = materialInput();
  context.state.insertFailure = "before";
  context.state.recoveryQueryFailures = 1;

  const uncertain = await context.service.saveCareerMaterial(input);
  assert.equal(uncertain.outcome, "outcome_uncertain");
  assert.ok(uncertain.cleanupReceipt);
  assert.equal(JSON.stringify(uncertain).includes(FILE_KEY_A), false);
  assert.equal(selectMaterial(context.database, input.materialId), null);
  assert.equal(context.state.files.has(FILE_KEY_A), true);

  const afterRefresh = materialSave.createCareerMaterialSaveService(context.runtime);
  const restored = JSON.parse(JSON.stringify(uncertain));
  assert.equal(
    await afterRefresh.inspectCareerMaterialSave(
      restored.materialId,
      restored.expectedSnapshot,
    ),
    "absent",
  );
  assert.deepEqual(
    await afterRefresh.inspectCareerMaterialSaveCleanup(restored.cleanupReceipt),
    { state: "cleanup_ready", receipt: restored.cleanupReceipt },
  );
  assert.deepEqual(
    await afterRefresh.retryCareerMaterialSaveCleanup(restored.cleanupReceipt),
    { outcome: "cleaned" },
  );
  assert.equal(context.state.files.has(FILE_KEY_A), false);

  const retried = await afterRefresh.saveCareerMaterial(input);
  assert.equal(retried.outcome, "saved");
  assert.equal(retried.fileKey, FILE_KEY_B);
  assert.equal(context.state.files.size, 1);
  assert.equal(context.state.files.has(FILE_KEY_B), true);
});

test("an uncertain cleanup receipt finishes a partial OPFS deletion after reload", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  context.state.insertFailure = "before";
  context.state.recoveryQueryFailures = 1;
  const uncertain = await context.service.saveCareerMaterial(materialInput());
  assert.equal(uncertain.outcome, "outcome_uncertain");
  assert.ok(uncertain.cleanupReceipt);
  context.state.fileReadErrorCodes.set(FILE_KEY_A, "FILE_BYTES_NOT_FOUND");

  const afterRefresh = materialSave.createCareerMaterialSaveService(context.runtime);
  const receipt = JSON.parse(JSON.stringify(uncertain.cleanupReceipt));
  assert.deepEqual(
    await afterRefresh.retryCareerMaterialSaveCleanup(receipt),
    { outcome: "cleaned" },
  );
  assert.equal(context.state.fileReadErrorCodes.has(FILE_KEY_A), false);
  assert.equal(context.state.files.has(FILE_KEY_A), false);
});

test("same id and semantic payload is idempotent after an ordinary success", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const input = materialInput();
  await context.service.saveCareerMaterial(input);
  const saves = context.state.saveCalls;
  const runs = context.state.runCalls;

  const result = await context.service.saveCareerMaterial(input);
  assert.equal(result.outcome, "already_saved");
  assert.equal(context.state.saveCalls, saves);
  assert.equal(context.state.runCalls, runs);
  assert.equal(context.state.files.size, 1);
});

test("same id with changed fields conflicts before OPFS or SQLite writes", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const input = materialInput();
  await context.service.saveCareerMaterial(input);
  const saves = context.state.saveCalls;
  const runs = context.state.runCalls;

  await assert.rejects(
    context.service.saveCareerMaterial({ ...input, notes: "另一份内容" }),
    (error) => {
      assert.equal(error.code, "conflict");
      assert.doesNotMatch(error.message, /sqlite|select|insert|file_key/i);
      return true;
    },
  );
  assert.equal(context.state.saveCalls, saves);
  assert.equal(context.state.runCalls, runs);
});

test("same attachment name and size with different bytes is a hash-backed conflict", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const original = materialInput({
    attachment: {
      blob: new Blob(["AAAA"], { type: "application/pdf" }),
      originalName: "same.pdf",
      mimeType: "application/pdf",
    },
  });
  await context.service.saveCareerMaterial(original);
  const changed = materialInput({
    attachment: {
      blob: new Blob(["BBBB"], { type: "application/pdf" }),
      originalName: "same.pdf",
      mimeType: "application/pdf",
    },
  });

  await assert.rejects(
    context.service.saveCareerMaterial(changed),
    (error) => error.code === "conflict",
  );
  assert.equal(context.state.saveCalls, 1);
  assert.equal(context.state.runCalls, 1);
});

test("a material without an attachment saves null file facts and retries exactly", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const input = materialInput({ attachment: null });

  assert.equal((await context.service.saveCareerMaterial(input)).outcome, "saved");
  const row = selectMaterial(context.database, input.materialId);
  assert.equal(row.file_key, null);
  assert.equal(row.file_name, null);
  assert.equal(row.mime_type, null);
  assert.equal(row.byte_size, null);
  assert.equal((await context.service.saveCareerMaterial(input)).outcome, "already_saved");
  assert.equal(context.state.saveCalls, 0);
});

test("read-only inspection distinguishes exact, absent, conflict, and unknown", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const input = materialInput();
  await context.service.saveCareerMaterial(input);
  const snapshot = await expectedSnapshot(input);

  assert.equal(
    await context.service.inspectCareerMaterialSave(input.materialId, snapshot),
    "exact_saved",
  );
  assert.equal(
    await context.service.inspectCareerMaterialSave("material-absent", snapshot),
    "absent",
  );
  assert.equal(
    await context.service.inspectCareerMaterialSave(input.materialId, {
      ...snapshot,
      version: "other-version",
    }),
    "conflict",
  );
  context.state.queryFailuresRemaining = 1;
  assert.equal(
    await context.service.inspectCareerMaterialSave(input.materialId, snapshot),
    "still_unknown",
  );
  assert.equal(context.state.maxActiveLocks, 1);
});

test("concurrent identical saves serialize into one save and one exact retry", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const input = materialInput();

  const results = await Promise.all([
    context.service.saveCareerMaterial(input),
    context.service.saveCareerMaterial(input),
  ]);
  assert.deepEqual(
    results.map(({ outcome }) => outcome),
    ["saved", "already_saved"],
  );
  assert.equal(context.state.maxActiveLocks, 1);
  assert.equal(context.state.saveCalls, 1);
  assert.equal(context.state.runCalls, 1);
});

test("broadcast failure cannot reverse a durable save", async (t) => {
  const context = await fixture({ broadcastThrows: true });
  t.after(() => context.close());

  const result = await context.service.saveCareerMaterial(materialInput());
  assert.equal(result.outcome, "saved");
  assert.notEqual(selectMaterial(context.database, result.materialId), null);
  assert.equal(context.state.files.has(FILE_KEY_A), true);
  assert.deepEqual(context.state.broadcasts, ["career-material-saved"]);
});

test("caller mutation while waiting for the lock cannot change the persisted snapshot", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  let releaseGate;
  context.state.gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const input = materialInput();
  const operation = context.service.saveCareerMaterial(input);
  input.name = "被等待期间改写";
  input.attachment.originalName = "changed.pdf";
  releaseGate();
  context.state.gate = null;

  await operation;
  const row = selectMaterial(context.database, "material-stable-a");
  assert.equal(row.name, "产品设计主简历");
  assert.equal(row.file_name, "主简历.pdf");
});

test("invalid and zero-byte attachments are rejected before taking the lock", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  await assert.rejects(
    context.service.saveCareerMaterial(materialInput({
      attachment: {
        blob: new Blob([]),
        originalName: "empty.pdf",
        mimeType: "application/pdf",
      },
    })),
    (error) => error.code === "invalid_input",
  );
  assert.equal(context.state.lockCalls, 0);
});

test("failed temporary cleanup returns an opaque JSON-safe cross-refresh receipt", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const receipt = await createPendingCleanup(context);
  const serialized = JSON.stringify(receipt);

  assert.equal(serialized.includes(FILE_KEY_A), false);
  assert.equal("fileKey" in receipt, false);
  const afterRefresh = materialSave.createCareerMaterialSaveService(context.runtime);
  const restored = JSON.parse(serialized);
  assert.deepEqual(
    await afterRefresh.inspectCareerMaterialSaveCleanup(restored),
    { state: "cleanup_ready", receipt: restored },
  );
  assert.equal((await afterRefresh.retryCareerMaterialSaveCleanup(restored)).outcome, "cleaned");
  assert.equal(context.state.files.has(FILE_KEY_A), false);
});

test("cleanup receipt tampering fails closed before any OPFS or SQLite action", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const receipt = await createPendingCleanup(context);
  const calls = {
    query: context.state.queryCalls,
    get: context.state.getCalls,
    delete: context.state.deleteCalls,
  };
  const first = receipt.opaquePayload[0];
  const tampered = {
    ...receipt,
    opaquePayload: `${first === "A" ? "B" : "A"}${receipt.opaquePayload.slice(1)}`,
  };

  await assert.rejects(
    context.service.retryCareerMaterialSaveCleanup(tampered),
    (error) => error.code === "invalid_cleanup_receipt",
  );
  assert.equal(context.state.queryCalls, calls.query);
  assert.equal(context.state.getCalls, calls.get);
  assert.equal(context.state.deleteCalls, calls.delete);
  assert.equal(context.state.files.has(FILE_KEY_A), true);
});

test("cleanup is generation-bound and a generation switch never deletes the file", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const receipt = await createPendingCleanup(context);
  const deletes = context.state.deleteCalls;
  context.state.generation = {
    database: "zhiji",
    generationId: GENERATION_B,
    sequence: 4,
  };

  assert.deepEqual(
    await context.service.retryCareerMaterialSaveCleanup(receipt),
    { outcome: "blocked", reason: "generation_changed", receipt },
  );
  assert.equal(context.state.deleteCalls, deletes);
  assert.equal(context.state.files.has(FILE_KEY_A), true);
});

test("a material row that appears later blocks cleanup even with the same stable id", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const receipt = await createPendingCleanup(context);
  const deletes = context.state.deleteCalls;
  const input = materialInput({ attachment: null });
  executeRun(
    context.database,
    `INSERT INTO career_materials(
       id,name,kind,version,updated_at,linked_job_id,status,notes,
       file_key,file_name,mime_type,byte_size
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.materialId, input.name, input.kind, input.version, NOW, null,
      input.status, input.notes, null, null, null, null,
    ],
  );

  assert.deepEqual(
    await context.service.retryCareerMaterialSaveCleanup(receipt),
    { outcome: "blocked", reason: "material_present", receipt },
  );
  assert.equal(context.state.deleteCalls, deletes);
  assert.equal(context.state.files.has(FILE_KEY_A), true);
});

test("an attachment referenced by another material is retained", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const receipt = await createPendingCleanup(context);
  const deletes = context.state.deleteCalls;
  executeRun(
    context.database,
    `INSERT INTO career_materials(
       id,name,kind,version,updated_at,linked_job_id,status,notes,
       file_key,file_name,mime_type,byte_size
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      "material-other", "共享材料", "简历", "v1", NOW, null, "ready", "",
      FILE_KEY_A, "主简历.pdf", "application/pdf", 20,
    ],
  );

  assert.deepEqual(
    await context.service.retryCareerMaterialSaveCleanup(receipt),
    { outcome: "blocked", reason: "file_referenced", receipt },
  );
  assert.equal(context.state.deleteCalls, deletes);
  assert.equal(context.state.files.has(FILE_KEY_A), true);
});

test("a different file at the receipt-bound key is never deleted", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const receipt = await createPendingCleanup(context);
  const deletes = context.state.deleteCalls;
  const entry = context.state.files.get(FILE_KEY_A);
  context.state.files.set(FILE_KEY_A, {
    metadata: { ...entry.metadata, originalName: "replacement.pdf" },
    blob: entry.blob,
  });

  assert.deepEqual(
    await context.service.retryCareerMaterialSaveCleanup(receipt),
    { outcome: "blocked", reason: "file_changed", receipt },
  );
  assert.equal(context.state.deleteCalls, deletes);
  assert.equal(context.state.files.has(FILE_KEY_A), true);
});

test("cleanup response loss and repeated cleanup are idempotently recoverable", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const receipt = await createPendingCleanup(context);
  context.state.deleteAfterFailuresRemaining = 1;

  assert.deepEqual(
    await context.service.retryCareerMaterialSaveCleanup(receipt),
    { outcome: "cleanup_pending", receipt, retryable: true },
  );
  assert.equal(context.state.files.has(FILE_KEY_A), false);
  assert.deepEqual(
    await context.service.retryCareerMaterialSaveCleanup(receipt),
    { outcome: "already_cleaned" },
  );
  assert.deepEqual(
    await context.service.retryCareerMaterialSaveCleanup(receipt),
    { outcome: "already_cleaned" },
  );
});

for (const partialCode of ["FILE_NOT_FOUND", "FILE_BYTES_NOT_FOUND"]) {
  test(`cleanup completes an OPFS partial deletion reported as ${partialCode}`, async (t) => {
    const context = await fixture();
    t.after(() => context.close());
    const receipt = await createPendingCleanup(context);
    context.state.fileReadErrorCodes.set(FILE_KEY_A, partialCode);
    const deletes = context.state.deleteCalls;

    assert.deepEqual(
      await context.service.inspectCareerMaterialSaveCleanup(receipt),
      { state: "cleanup_ready", receipt },
    );
    assert.deepEqual(
      await context.service.retryCareerMaterialSaveCleanup(receipt),
      { outcome: "cleaned" },
    );
    assert.equal(context.state.deleteCalls, deletes + 1);
    assert.equal(context.state.fileReadErrorCodes.has(FILE_KEY_A), false);
    assert.equal(context.state.files.has(FILE_KEY_A), false);
  });
}

test("cleanup rechecks generation after database facts and fails closed on a switch", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const receipt = await createPendingCleanup(context);
  const deletes = context.state.deleteCalls;
  context.state.generationQueue.push(
    { ...context.state.generation },
    { database: "zhiji", generationId: GENERATION_B, sequence: 4 },
  );

  assert.deepEqual(
    await context.service.retryCareerMaterialSaveCleanup(receipt),
    { outcome: "blocked", reason: "generation_changed", receipt },
  );
  assert.equal(context.state.deleteCalls, deletes);
  assert.equal(context.state.files.has(FILE_KEY_A), true);
});

test("cleanup rechecks generation once more after inspecting the exact staged file", async (t) => {
  const context = await fixture();
  t.after(() => context.close());
  const receipt = await createPendingCleanup(context);
  const deletes = context.state.deleteCalls;
  context.state.generationQueue.push(
    { ...context.state.generation },
    { ...context.state.generation },
    { database: "zhiji", generationId: GENERATION_B, sequence: 4 },
  );

  assert.deepEqual(
    await context.service.retryCareerMaterialSaveCleanup(receipt),
    { outcome: "blocked", reason: "generation_changed", receipt },
  );
  assert.equal(context.state.deleteCalls, deletes);
  assert.equal(context.state.files.has(FILE_KEY_A), true);
});
