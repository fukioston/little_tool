import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const BASE = "2026-08-20T01:00:00.000Z";
const NOW = "2026-08-22T05:00:00.000Z";
const GEN1 = "10000000-0000-4000-8000-000000000001";
const GEN2 = "20000000-0000-4000-8000-000000000002";

function moduleUrl(source) { return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`; }
async function transpile(path) {
  const source = await readFile(new URL(path, root), "utf8");
  const result = ts.transpileModule(source, {
    fileName: path, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
  });
  assert.deepEqual(result.diagnostics.filter(({ category }) => category === ts.DiagnosticCategory.Error), []);
  return result.outputText;
}

const [schemaJs, markerRaw, fileRaw, materialRaw] = await Promise.all([
  transpile("lib/schemas/zhiji.ts"), transpile("lib/career/write-marker.ts"),
  transpile("lib/career/material-write-files.ts"), transpile("lib/career/material-writes.ts"),
]);
const unexpectedUrl = moduleUrl(`export const localDb=new Proxy({}, {get(){return ()=>{throw new Error('unexpected')}}});`);
const lockUrl = moduleUrl(`export function broadcastCareerDataChanged(){} export function withCareerWriteLock(task){return task();}`);
const localFilesUrl = moduleUrl(`
  export async function assertLocalFileKeyAvailable(){throw new Error('unexpected default file')}
  export async function abandonClaimedLocalFileDeletion(){throw new Error('unexpected default file')}
  export async function claimLocalFileDeletion(){throw new Error('unexpected default file')}
  export async function deleteLocalFile(){throw new Error('unexpected default file')}
  export async function deleteOwnedLocalFile(){throw new Error('unexpected default file')}
  export async function getLocalFile(){throw new Error('unexpected default file')}
  export async function inspectClaimedLocalFileDeletion(){throw new Error('unexpected default file')}
  export async function inspectLocalFileDeletionCandidate(){throw new Error('unexpected default file')}
  export async function inspectOwnedLocalFileFragments(){throw new Error('unexpected default file')}
  export async function releaseClaimedLocalFileDeletion(){throw new Error('unexpected default file')}
  export async function saveLocalFileAtKey(){throw new Error('unexpected default file')}
  export async function sha256Blob(){throw new Error('unexpected default file')}
  export async function sweepClaimedLocalFileDeletion(){throw new Error('unexpected default file')}
`);
const markerUrl = moduleUrl(markerRaw
  .replaceAll('"@/lib/local-db/client"', `"${unexpectedUrl}"`)
  .replaceAll('"./lock"', `"${lockUrl}"`));
const fileUrl = moduleUrl(fileRaw
  .replaceAll('"@/lib/local-db/files"', `"${localFilesUrl}"`)
  .replaceAll('"./write-marker"', `"${markerUrl}"`));
const materialUrl = moduleUrl(materialRaw
  .replaceAll('"./material-write-files"', `"${fileUrl}"`)
  .replaceAll('"./write-marker"', `"${markerUrl}"`));
const [schema, marker, materialFiles, materialWrites, sqlite3] = await Promise.all([
  import(moduleUrl(schemaJs)), import(markerUrl), import(fileUrl), import(materialUrl), sqlite3InitModule(),
]);

function execute(database, statements) {
  let changes = 0;
  database.transaction("IMMEDIATE", () => {
    for (const { sql, params = [] } of statements) {
      const statement = database.prepare(sql);
      try { if (params.length) statement.bind(params); while (statement.step()) { /* consume */ } changes += Number(database.changes()); }
      finally { statement.finalize(); }
    }
  });
  return { changes };
}

function install(database) {
  execute(database, [
    ...schema.ZHIJI_V1_SCHEMA_STATEMENTS, ...schema.ZHIJI_V2_SCHEMA_MIGRATION_STATEMENTS,
    ...schema.ZHIJI_V3_SCHEMA_MIGRATION_STATEMENTS, ...schema.ZHIJI_V4_SCHEMA_MIGRATION_STATEMENTS,
    ...schema.ZHIJI_V5_SCHEMA_MIGRATION_STATEMENTS,
  ]);
  database.exec(schema.ZHIJI_STRUCTURAL_SEED_SQL);
}

function uuid(index) { return `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`; }
async function hashBlob(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Buffer.from(digest).toString("hex");
}

function fixture() {
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON"); install(database);
  database.exec(`INSERT INTO career_jobs(
    id,company,role,location,source,source_url,stage_id,priority,salary,work_mode,
    description,applied_at,deadline,contact_name,note,tags,created_at,updated_at,
    archived,position,archived_at,ended_at,archived_operation_id,ended_operation_id
  ) VALUES('job','Acme','Designer','','手动记录','','stage_saved',1,'','','',NULL,NULL,'','','',
    '${BASE}','${BASE}',0,0,NULL,NULL,NULL,NULL)`);
  const files = new Map();
  const capabilities = new Map();
  const claims = new Map();
  const state = {
    active: 0, generationId: GEN1, generationSequence: 1, now: Date.parse(NOW), uuid: 1,
    batchFault: null, beforeBatch: null, fileFault: null, capabilityFault: null,
    claimFault: null, sweepFault: null, releaseFault: null,
    events: [], broadcasts: [], fragmentOverrides: new Map(),
    queryCalls: 0, batchCalls: 0, fileCalls: 0, deleteCalls: 0, capabilityCalls: 0,
    claimCalls: 0, lockCalls: 0,
  };
  const runtime = {
    async withExclusiveLock(operation) {
      state.lockCalls += 1;
      state.active += 1;
      try { return await operation(); } finally { state.active -= 1; }
    },
    async query(sql, params = []) { assert.equal(state.active, 1); state.queryCalls += 1; return { rows: database.selectObjects(sql, params) }; },
    async batch(statements) {
      assert.equal(state.active, 1); state.batchCalls += 1; state.beforeBatch?.(); state.beforeBatch = null;
      if (state.batchFault === "before") { state.batchFault = null; throw new Error("before"); }
      const result = execute(database, statements);
      if (state.batchFault === "after") { state.batchFault = null; throw new Error("after"); }
      return result;
    },
    async currentGeneration() { assert.equal(state.active, 1); return { generationId: state.generationId, sequence: state.generationSequence }; },
    now() { assert.equal(state.active, 1); return state.now; },
    randomUUID() { assert.equal(state.active, 1); return uuid(state.uuid++); },
    broadcast(reason) { assert.equal(state.active, 1); state.broadcasts.push(reason); },
    async assertFileKeyAvailable(key) { assert.equal(state.active, 1); state.fileCalls += 1; if (files.has(key)) throw new Error("collision"); },
    async saveFileAtKey(key, blob, options, stagingOwner) {
      assert.equal(state.active, 1); state.fileCalls += 1; state.events.push("file-write");
      const metadata = { version: 1, key, namespace: "career", originalName: options.originalName,
        mimeType: options.mimeType, category: options.category, byteSize: blob.size,
        sha256: await hashBlob(blob), createdAt: options.createdAt, updatedAt: options.updatedAt, stagingOwner };
      files.set(key, { metadata, file: blob });
      if (state.fileFault === "after") { state.fileFault = null; throw new Error("file response lost"); }
      return metadata;
    },
    async getFile(key) {
      assert.equal(state.active, 1); state.fileCalls += 1;
      if (state.fileFault === "get" || state.fileFault === "get-always") {
        const persistent = state.fileFault === "get-always";
        if (!persistent) state.fileFault = null;
        throw new Error("file read fault");
      }
      const found = files.get(key); if (!found) throw Object.assign(new Error("missing"), { code: "FILE_NOT_FOUND" });
      return found;
    },
    async inspectDeletionCandidate(key, expected) {
      assert.equal(state.active, 1); state.fileCalls += 1;
      if (state.fileFault === "inspect-candidate" || state.fileFault === "inspect-candidate-always") {
        const persistent = state.fileFault === "inspect-candidate-always";
        if (!persistent) state.fileFault = null;
        throw new Error("candidate read fault");
      }
      const found = files.get(key);
      if (!found) return { state: "missing" };
      if (expected === null || found.metadata.stagingOwner !== undefined) {
        return { state: "foreign_or_unverifiable", objectPresent: true, metadataPresent: true };
      }
      return JSON.stringify(found.metadata) === JSON.stringify(expected) &&
        await hashBlob(found.file) === expected.sha256
        ? { state: "exact", objectPresent: true, metadataPresent: true }
        : { state: "verified_changed", objectPresent: true, metadataPresent: true };
    },
    async inspectOwnedFragments(key, owner) {
      assert.equal(state.active, 1); state.fileCalls += 1;
      if (state.fileFault === "inspect-fragments" || state.fileFault === "inspect-fragments-always") {
        const persistent = state.fileFault === "inspect-fragments-always";
        if (!persistent) state.fileFault = null;
        throw new Error("fragment read fault");
      }
      const override = state.fragmentOverrides.get(key);
      if (override) return override;
      const found = files.get(key);
      if (!found) return { state: "missing" };
      return found.metadata.stagingOwner === owner
        ? { state: "owned", objectPresent: true, metadataKind: "complete" }
        : { state: "foreign_or_unverifiable", objectPresent: true, metadataPresent: true };
    },
    async deleteOwnedFile(key, owner) {
      assert.equal(state.active, 1); state.deleteCalls += 1;
      const found = files.get(key); if (!found) return false;
      if (found.metadata.stagingOwner !== owner) throw new Error("owner mismatch");
      if (state.fileFault === "delete-before") { state.fileFault = null; throw new Error("delete before"); }
      files.delete(key);
      if (state.fileFault === "delete-after") { state.fileFault = null; throw new Error("delete after"); }
      return true;
    },
    async deleteFile(key) { assert.equal(state.active, 1); state.deleteCalls += 1; return files.delete(key); },
    async claimFileDeletion(key, expected, owner) {
      assert.equal(state.active, 1); state.claimCalls += 1;
      if (state.claimFault === "before") { state.claimFault = null; throw new Error("claim before"); }
      const found = files.get(key);
      if (found && (expected === null || found.metadata.stagingOwner !== undefined ||
        JSON.stringify(found.metadata) !== JSON.stringify(expected) ||
        await hashBlob(found.file) !== expected.sha256)) throw new Error("claim mismatch");
      const existing = claims.get(key);
      if (existing && (existing.owner !== owner || JSON.stringify(existing.expected) !== JSON.stringify(expected))) {
        throw new Error("foreign claim");
      }
      claims.set(key, { owner, expected: structuredClone(expected), phase: found ? "claimed" : "swept" });
      if (state.claimFault === "after") { state.claimFault = null; throw new Error("claim after"); }
    },
    async inspectClaimedDeletion(key, expected, owner) {
      assert.equal(state.active, 1); state.claimCalls += 1;
      const claim = claims.get(key);
      if (!claim) return { state: "missing_claim" };
      const found = files.get(key);
      if (claim.owner !== owner || JSON.stringify(claim.expected) !== JSON.stringify(expected)) {
        return { state: "foreign_or_unverifiable", objectPresent: Boolean(found), metadataPresent: Boolean(found) };
      }
      if ((expected === null && found) || (found && (claim.phase !== "claimed" ||
        JSON.stringify(found.metadata) !== JSON.stringify(expected) ||
        await hashBlob(found.file) !== expected.sha256))) {
        return { state: "foreign_or_unverifiable", objectPresent: true, metadataPresent: true };
      }
      return { state: "owned", phase: claim.phase, objectPresent: Boolean(found), metadataPresent: Boolean(found) };
    },
    async sweepClaimedDeletion(key, expected, owner) {
      assert.equal(state.active, 1); state.claimCalls += 1;
      const claim = claims.get(key);
      if (!claim || claim.owner !== owner || JSON.stringify(claim.expected) !== JSON.stringify(expected)) {
        throw new Error("claim mismatch");
      }
      if (state.sweepFault === "before") { state.sweepFault = null; throw new Error("sweep before"); }
      const removed = files.delete(key);
      claim.phase = "swept";
      if (state.sweepFault === "after") { state.sweepFault = null; throw new Error("sweep after"); }
      return removed;
    },
    async releaseClaimedDeletion(key, expected, owner) {
      assert.equal(state.active, 1); state.claimCalls += 1;
      const claim = claims.get(key);
      if (!claim) return false;
      if (claim.owner !== owner || claim.phase !== "swept" ||
        JSON.stringify(claim.expected) !== JSON.stringify(expected)) throw new Error("release mismatch");
      if (state.releaseFault === "before") { state.releaseFault = null; throw new Error("release before"); }
      claims.delete(key);
      if (state.releaseFault === "after") { state.releaseFault = null; throw new Error("release after"); }
      return true;
    },
    async abandonClaimedDeletion(key) { assert.equal(state.active, 1); return claims.delete(key); },
    async hashBlob(blob) {
      assert.equal(state.active, 1); state.fileCalls += 1;
      if (state.fileFault === "hash" || state.fileFault === "hash-always") {
        const persistent = state.fileFault === "hash-always";
        if (!persistent) state.fileFault = null;
        throw new Error("hash fault");
      }
      return hashBlob(blob);
    },
    async storeCapabilityRecord(handle, serialized) {
      assert.equal(state.active, 1); state.capabilityCalls += 1;
      if (state.capabilityFault === "store-before") { state.capabilityFault = null; throw new Error("store before"); }
      if (capabilities.has(handle) && capabilities.get(handle) !== serialized) throw new Error("collision");
      state.events.push("capability-write");
      capabilities.set(handle, serialized);
      if (state.capabilityFault === "store-after") { state.capabilityFault = null; throw new Error("store after"); }
    },
    async replaceCapabilityRecord(handle, expected, serialized) {
      assert.equal(state.active, 1); state.capabilityCalls += 1;
      if (state.capabilityFault === "replace-before") { state.capabilityFault = null; throw new Error("replace before"); }
      if (capabilities.get(handle) !== expected) throw new Error("replace mismatch");
      capabilities.set(handle, serialized);
      if (state.capabilityFault === "replace-after") { state.capabilityFault = null; throw new Error("replace after"); }
    },
    async readCapabilityRecord(handle) {
      assert.equal(state.active, 1); state.capabilityCalls += 1;
      if (state.capabilityFault === "read" || state.capabilityFault === "read-always") {
        const persistent = state.capabilityFault === "read-always";
        if (!persistent) state.capabilityFault = null;
        throw new Error("read fault");
      }
      return capabilities.get(handle) ?? null;
    },
    async deleteCapabilityRecord(handle) {
      assert.equal(state.active, 1); state.capabilityCalls += 1;
      if (state.capabilityFault === "delete-before") { state.capabilityFault = null; throw new Error("delete before"); }
      const removed = capabilities.delete(handle);
      if (state.capabilityFault === "delete-after") { state.capabilityFault = null; throw new Error("delete after"); }
      return removed;
    },
  };
  return { database, files, capabilities, claims, state, runtime,
    service: materialWrites.createCareerMaterialWriteStorageService(runtime), close() { database.close(); } };
}

function job(database) { return database.selectObject("SELECT * FROM career_jobs WHERE id='job'"); }
function material(database, id) { return database.selectObject("SELECT * FROM career_materials WHERE id=?", [id]) ?? null; }
function saveDisplayed(value) { return { generationId: value.state.generationId, generationSequence: value.state.generationSequence, material: null, linkedJob: job(value.database) }; }
function deleteDisplayed(value, id) {
  const row = material(value.database, id);
  return {
    generationId: value.state.generationId, generationSequence: value.state.generationSequence,
    material: row, linkedJob: row.linked_job_id ? job(value.database) : null,
    file: row.file_key ? value.files.get(row.file_key)?.metadata ?? null : null,
    fileReferences: row.file_key ? value.database.selectObjects("SELECT * FROM career_materials WHERE file_key=? ORDER BY id", [row.file_key]) : [],
  };
}

function convertAttachmentToOrdinary(value, key) {
  const found = value.files.get(key);
  assert.ok(found);
  const { stagingOwner: _owner, ...ordinary } = found.metadata;
  void _owner;
  found.metadata = ordinary;
  return ordinary;
}

async function prepareSavedAttachment(value, extra = {}) {
  let cleanup;
  const receipt = await value.service.prepareCareerMaterialSaveWrite({
    name: "CV", kind: "resume", version: "v1", linkedJobId: "job", status: "ready",
    attachment: { blob: new Blob(["hello"], { type: "text/plain" }), originalName: "cv.txt" },
  }, saveDisplayed(value), { onCleanupPrepared(prepared) {
    assert.equal(value.state.active, 1);
    value.state.events.push("cleanup-persist"); cleanup = structuredClone(prepared);
    extra.onCleanupPrepared?.(prepared);
  } });
  return { receipt, cleanup };
}

async function resign(receipt, mutate) {
  const cloned = structuredClone(receipt);
  await mutate(cloned);
  const { projectionSha256: _old, ...payload } = cloned;
  void _old;
  return marker.sealCareerWriteReceipt(payload);
}

function callbackSnapshot(value) {
  return {
    lock: value.state.lockCalls,
    query: value.state.queryCalls,
    batch: value.state.batchCalls,
    file: value.state.fileCalls,
    delete: value.state.deleteCalls,
    capability: value.state.capabilityCalls,
    claim: value.state.claimCalls,
    broadcast: value.state.broadcasts.length,
  };
}

async function assertRejectedBeforeHooks(value, receipt) {
  const before = callbackSnapshot(value);
  assert.equal(await value.service.inspectCareerMaterialWrite(receipt), "invalid_receipt");
  await assert.rejects(() => value.service.commitCareerMaterialWrite(receipt),
    (error) => error.code === "invalid_receipt");
  assert.deepEqual(callbackSnapshot(value), before);
}

test("attachment cleanup capability is durable before staging and marker survives later edits", async () => {
  const value = fixture();
  try {
    const { receipt, cleanup } = await prepareSavedAttachment(value);
    assert.deepEqual(value.state.events, ["capability-write", "cleanup-persist", "file-write"]);
    const privateKey = [...value.files.keys()][0];
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes(privateKey), false);
    assert.equal(serialized.includes("file_key"), false);
    assert.equal(serialized.includes("stagingOwner"), false);
    assert.equal("key" in receipt.after.stagedFile, false);
    value.state.batchFault = "after";
    assert.equal((await value.service.commitCareerMaterialWrite(receipt)).outcome, "saved");
    assert.equal(JSON.parse(value.capabilities.get(cleanup.cleanupReceipt.handle)).state, "completed");
    assert.equal((await value.service.inspectCareerMaterialFileCleanup(cleanup)).state, "already_clean");
    value.database.exec(`UPDATE career_materials SET notes='later' WHERE id='${receipt.after.material.id}'`);
    assert.equal(await value.service.inspectCareerMaterialWrite(receipt), "exact_saved_completed");
  } finally { value.close(); }
});

test("staging response loss is cleaned with the pre-persisted capability", async () => {
  const value = fixture();
  try {
    let cleanup;
    value.state.fileFault = "after";
    await assert.rejects(() => value.service.prepareCareerMaterialSaveWrite({
      name: "CV", kind: "resume", version: "v1", status: "draft",
      attachment: { blob: new Blob(["hello"]), originalName: "cv.txt" },
    }, { ...saveDisplayed(value), linkedJob: null }, { onCleanupPrepared(value_) { cleanup = structuredClone(value_); } }), /附件暂存失败/);
    assert.equal(value.files.size, 1);
    assert.equal((await value.service.retryCareerMaterialFileCleanup(cleanup)).outcome, "cleaned");
    assert.equal(value.files.size, 0);
  } finally { value.close(); }
});

test("cleanup distinguishes missing, same-owner partial, and foreign fragments", async () => {
  const owned = fixture();
  try {
    const { cleanup } = await prepareSavedAttachment(owned);
    const key = [...owned.files.keys()][0];
    owned.state.fragmentOverrides.set(key, { state: "owned", objectPresent: false, metadataKind: "claim" });
    assert.equal((await owned.service.inspectCareerMaterialFileCleanup(cleanup)).state, "cleanup_ready");
    assert.equal((await owned.service.retryCareerMaterialFileCleanup(cleanup)).outcome, "cleaned");
  } finally { owned.close(); }

  const foreign = fixture();
  try {
    const { cleanup } = await prepareSavedAttachment(foreign);
    const key = [...foreign.files.keys()][0];
    foreign.state.fragmentOverrides.set(key, {
      state: "foreign_or_unverifiable", objectPresent: true, metadataPresent: false,
    });
    assert.equal((await foreign.service.inspectCareerMaterialFileCleanup(cleanup)).reason, "file_changed");
    assert.equal((await foreign.service.retryCareerMaterialFileCleanup(cleanup)).reason, "file_changed");
    assert.equal(foreign.state.deleteCalls, 0);
  } finally { foreign.close(); }

  const missing = fixture();
  try {
    const { cleanup } = await prepareSavedAttachment(missing);
    missing.files.clear();
    assert.equal((await missing.service.inspectCareerMaterialFileCleanup(cleanup)).state, "already_clean");
    assert.equal((await missing.service.retryCareerMaterialFileCleanup(cleanup)).outcome, "already_cleaned");
  } finally { missing.close(); }
});

test("failed cleanup persistence writes zero file bytes", async () => {
  const value = fixture();
  try {
    await assert.rejects(() => value.service.prepareCareerMaterialSaveWrite({
      name: "CV", kind: "resume", version: "v1", status: "draft",
      attachment: { blob: new Blob(["hello"]), originalName: "cv.txt" },
    }, { ...saveDisplayed(value), linkedJob: null }, { onCleanupPrepared() { throw new Error("journal full"); } }), /清理凭据未能持久化/);
    assert.equal(value.files.size, 0);
    assert.equal(value.state.events.includes("file-write"), false);
  } finally { value.close(); }
});

test("file deletion followed by DB failure converges with the same receipt", async () => {
  const value = fixture();
  try {
    const { receipt: saveReceipt } = await prepareSavedAttachment(value);
    await value.service.commitCareerMaterialWrite(saveReceipt);
    const receipt = await value.service.prepareCareerMaterialDeleteWrite(deleteDisplayed(value, saveReceipt.after.material.id));
    const privateKey = [...value.files.keys()][0];
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes(privateKey), false);
    assert.equal(serialized.includes("file_key"), false);
    assert.equal(serialized.includes("stagingOwner"), false);
    value.state.batchFault = "before";
    await assert.rejects(() => value.service.commitCareerMaterialWrite(receipt), /确定没有提交/);
    assert.equal(value.files.size, 0);
    assert.equal(material(value.database, saveReceipt.after.material.id) !== null, true);
    assert.equal((await value.service.commitCareerMaterialWrite(receipt)).outcome, "saved");
    assert.equal(material(value.database, saveReceipt.after.material.id), null);
  } finally { value.close(); }
});

test("delete recovery remains reachable when the attachment is already physically absent", async () => {
  const value = fixture();
  try {
    const { receipt: saveReceipt } = await prepareSavedAttachment(value);
    await value.service.commitCareerMaterialWrite(saveReceipt);
    value.files.clear();
    const displayed = deleteDisplayed(value, saveReceipt.after.material.id);
    assert.equal(displayed.file, null);
    const receipt = await value.service.prepareCareerMaterialDeleteWrite(displayed);
    assert.equal((await value.service.commitCareerMaterialWrite(receipt)).outcome, "saved");
    assert.equal(value.state.deleteCalls, 0);
  } finally { value.close(); }
});

test("a stale shared-reference projection performs zero file deletions", async () => {
  const value = fixture();
  try {
    const { receipt: saveReceipt } = await prepareSavedAttachment(value);
    await value.service.commitCareerMaterialWrite(saveReceipt);
    const displayed = deleteDisplayed(value, saveReceipt.after.material.id);
    const receipt = await value.service.prepareCareerMaterialDeleteWrite(displayed);
    const row = displayed.material;
    value.database.exec({ sql: `INSERT INTO career_materials(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`,
      bind: Object.keys(row).map((key) => key === "id" ? "material_shared" : row[key]) });
    assert.equal((await value.service.commitCareerMaterialWrite(receipt)).outcome, "changed");
    assert.equal(value.state.deleteCalls, 0);
    assert.equal(value.files.size, 1);
  } finally { value.close(); }
});

test("an exact shared reference retains the file while deleting only the target row", async () => {
  const value = fixture();
  try {
    const { receipt: saveReceipt } = await prepareSavedAttachment(value);
    await value.service.commitCareerMaterialWrite(saveReceipt);
    const row = material(value.database, saveReceipt.after.material.id);
    value.database.exec({ sql: `INSERT INTO career_materials(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`,
      bind: Object.keys(row).map((key) => key === "id" ? "material_shared" : row[key]) });
    const receipt = await value.service.prepareCareerMaterialDeleteWrite(deleteDisplayed(value, row.id));
    assert.equal((await value.service.commitCareerMaterialWrite(receipt)).outcome, "saved");
    assert.equal(value.state.deleteCalls, 0);
    assert.equal(value.files.size, 1);
    assert.equal(material(value.database, "material_shared") !== null, true);
  } finally { value.close(); }
});

test("unique delete sweeps same-owner changed or partial fragments before its DB marker", async () => {
  for (const mode of ["changed", "partial"]) {
    const value = fixture();
    try {
      const { receipt: saveReceipt } = await prepareSavedAttachment(value);
      await value.service.commitCareerMaterialWrite(saveReceipt);
      const id = saveReceipt.after.material.id;
      const receipt = await value.service.prepareCareerMaterialDeleteWrite(deleteDisplayed(value, id));
      const key = [...value.files.keys()][0];
      if (mode === "changed") value.files.get(key).file = new Blob(["changed bytes"]);
      else value.state.fragmentOverrides.set(key, { state: "owned", objectPresent: false, metadataKind: "complete" });
      assert.equal((await value.service.commitCareerMaterialWrite(receipt)).outcome, "saved");
      assert.equal(value.files.size, 0);
      assert.equal(material(value.database, id), null);
      assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_write_operations WHERE operation_id=?", [receipt.operationId]), 1);
    } finally { value.close(); }
  }
});

test("unique delete blocks bytes-only unverifiable fragments with zero deletion or marker", async () => {
  const value = fixture();
  try {
    const { receipt: saveReceipt } = await prepareSavedAttachment(value);
    await value.service.commitCareerMaterialWrite(saveReceipt);
    const id = saveReceipt.after.material.id;
    const receipt = await value.service.prepareCareerMaterialDeleteWrite(deleteDisplayed(value, id));
    const key = [...value.files.keys()][0];
    value.state.fragmentOverrides.set(key, {
      state: "foreign_or_unverifiable", objectPresent: true, metadataPresent: false,
    });
    const deletes = value.state.deleteCalls;
    assert.equal((await value.service.commitCareerMaterialWrite(receipt)).outcome, "changed");
    assert.equal(value.state.deleteCalls, deletes);
    assert.notEqual(material(value.database, id), null);
    assert.equal(value.database.selectValue(
      "SELECT COUNT(*) FROM career_write_operations WHERE operation_id=?", [receipt.operationId]), 0);
  } finally { value.close(); }
});

test("re-signed save receipt, file projection, cleanup payload, and owner swaps stop before hooks", async () => {
  const value = fixture();
  try {
    const { receipt: first } = await prepareSavedAttachment(value);
    const { receipt: second } = await prepareSavedAttachment(value);
    const cleanupPayload = await value.runtime.withExclusiveLock(async () =>
      (await materialFiles.resolveCareerMaterialFileCleanupReceipt(
        first.after.cleanupReceipt, value.runtime)).payload);
    await assert.rejects(() => materialFiles.issueCareerMaterialFileCleanupReceipt({
      ...cleanupPayload,
      stagedFile: { ...cleanupPayload.stagedFile, stagingOwner: "0".repeat(64) },
    }, uuid(999), value.runtime), /owner/);
    const wrongOwner = { ...first.after.cleanupReceipt, handle: "not-a-capability" };
    const beforeCleanup = callbackSnapshot(value);
    await assert.rejects(() => value.service.inspectCareerMaterialFileCleanup(wrongOwner),
      (error) => error.code === "invalid_receipt");
    await assert.rejects(() => value.service.retryCareerMaterialFileCleanup(wrongOwner),
      (error) => error.code === "invalid_receipt");
    assert.deepEqual(callbackSnapshot(value), beforeCleanup);
    const cases = [
      (receipt) => { receipt.after.material.id = second.after.material.id; },
      (receipt) => { receipt.after.material.file_name = "other.txt"; },
      (receipt) => { receipt.after.stagedFile.sha256 = "0".repeat(64); },
      (receipt) => { receipt.after.cleanupReceipt = second.after.cleanupReceipt; },
      (receipt) => { receipt.after.cleanupReceipt = wrongOwner; },
      (receipt) => { receipt.before.linkedJob.company = 7; },
      (receipt) => { receipt.operationAt = "2026-08-22T06:00:00.000Z"; },
    ];
    for (const mutate of cases) {
      await assertRejectedBeforeHooks(value, await resign(first, mutate));
    }
  } finally { value.close(); }
});

test("canonical save intent rejects coordinated scalar and operationAt re-signing before hooks", async () => {
  const value = fixture();
  try {
    const { receipt } = await prepareSavedAttachment(value);
    const at = "2026-08-22T06:00:00.000Z";
    const forged = await resign(receipt, (candidate) => {
      candidate.operationAt = at;
      candidate.after.material.name = "forged canonical material";
      candidate.after.material.updated_at = at;
      candidate.after.stagedFile.originalName = "forged.txt";
      candidate.after.stagedFile.createdAt = at;
      candidate.after.stagedFile.updatedAt = at;
    });
    await assertRejectedBeforeHooks(value, forged);
  } finally { value.close(); }
});

test("re-signed delete receipt cannot use material B or its file capability to delete A", async () => {
  const value = fixture();
  try {
    const { receipt: saveA } = await prepareSavedAttachment(value);
    assert.equal((await value.service.commitCareerMaterialWrite(saveA)).outcome, "saved");
    const { receipt: saveB } = await prepareSavedAttachment(value);
    assert.equal((await value.service.commitCareerMaterialWrite(saveB)).outcome, "saved");
    const deleteA = await value.service.prepareCareerMaterialDeleteWrite(
      deleteDisplayed(value, saveA.after.material.id));
    const deleteB = await value.service.prepareCareerMaterialDeleteWrite(
      deleteDisplayed(value, saveB.after.material.id));
    const cases = [
      (receipt) => { receipt.before.fileReceipt = deleteB.before.fileReceipt; },
      (receipt) => {
        receipt.before.material.id = deleteB.before.material.id;
        receipt.after.materialId = deleteB.before.material.id;
      },
      (receipt) => { receipt.before.file.sha256 = "0".repeat(64); },
      (receipt) => { receipt.before.fileReferences[0].id = "material_other"; },
      (receipt) => { receipt.before.linkedJob.id = "job_other"; },
      (receipt) => { receipt.operationAt = receipt.before.material.updated_at; },
    ];
    for (const mutate of cases) {
      await assertRejectedBeforeHooks(value, await resign(deleteA, mutate));
    }
    assert.notEqual(material(value.database, saveA.after.material.id), null);
    assert.notEqual(material(value.database, saveB.after.material.id), null);
    assert.equal(value.files.size, 2);
  } finally { value.close(); }
});

test("generation replacement blocks a prepared save without another batch", async () => {
  const value = fixture();
  try {
    const receipt = await value.service.prepareCareerMaterialSaveWrite({ name: "Notes", kind: "text", version: "v1", status: "draft" }, { ...saveDisplayed(value), linkedJob: null });
    value.state.generationId = GEN2; value.state.generationSequence = 2;
    assert.equal((await value.service.commitCareerMaterialWrite(receipt)).outcome, "changed");
    assert.equal(value.state.batchCalls, 0);
  } finally { value.close(); }
});

test("a refused Web Lock enters zero DB, file, callback, or broadcast hooks", async () => {
  let callbacks = 0;
  const runtime = {
    async withExclusiveLock() { throw new Error("no lock"); },
    async query() { callbacks += 1; throw new Error("unexpected"); }, async batch() { callbacks += 1; throw new Error("unexpected"); },
    async currentGeneration() { callbacks += 1; throw new Error("unexpected"); }, now() { callbacks += 1; return 0; },
    randomUUID() { callbacks += 1; return uuid(1); }, broadcast() { callbacks += 1; },
    async assertFileKeyAvailable() { callbacks += 1; }, async saveFileAtKey() { callbacks += 1; },
    async getFile() { callbacks += 1; }, async inspectOwnedFragments() { callbacks += 1; },
    async deleteOwnedFile() { callbacks += 1; }, async deleteFile() { callbacks += 1; },
    async hashBlob() { callbacks += 1; return "0".repeat(64); },
  };
  const service = materialWrites.createCareerMaterialWriteStorageService(runtime);
  await assert.rejects(() => service.prepareCareerMaterialSaveWrite({
    name: "CV", kind: "resume", version: "v1", status: "draft",
    attachment: { blob: new Blob(["hello"]), originalName: "cv.txt" },
  }, { generationId: GEN1, generationSequence: 1, material: null, linkedJob: null }, { onCleanupPrepared() { callbacks += 1; } }));
  assert.equal(callbacks, 0);
});

test("opaque capability uses only a random handle and settles store response loss", async () => {
  const value = fixture();
  try {
    value.state.capabilityFault = "store-after";
    const { receipt, cleanup } = await prepareSavedAttachment(value);
    const key = [...value.files.keys()][0];
    const owner = value.files.get(key).metadata.stagingOwner;
    assert.deepEqual(Object.keys(cleanup).sort(), ["cleanupReceipt", "materialId", "operationId"]);
    assert.deepEqual(Object.keys(cleanup.cleanupReceipt).sort(), ["handle", "purpose", "version"]);
    assert.equal(cleanup.cleanupReceipt.handle, receipt.intent.capabilityHandle);
    const journalText = JSON.stringify({ receipt, cleanup });
    assert.equal(journalText.includes(key), false);
    assert.equal(journalText.includes(owner), false);
    assert.equal(journalText.includes("stagingOwner"), false);
    assert.equal(journalText.includes("fileKey"), false);
    const decodedHandle = Buffer.from(cleanup.cleanupReceipt.handle, "base64url").toString("utf8");
    assert.equal(decodedHandle.includes(key), false);
    assert.equal(decodedHandle.includes(owner), false);
    const legallyDecodedJournal = Buffer.from(
      Buffer.from(journalText).toString("base64url"),
      "base64url",
    ).toString("utf8");
    assert.equal(legallyDecodedJournal.includes(key), false);
    assert.equal(legallyDecodedJournal.includes(owner), false);
    assert.equal(value.capabilities.size, 1);
    assert.equal([...value.capabilities.values()][0].includes(key), true);
    assert.equal(value.files.size, 1);
  } finally { value.close(); }

  const failed = fixture();
  try {
    failed.state.capabilityFault = "store-before";
    let callbacks = 0;
    await assert.rejects(() => failed.service.prepareCareerMaterialSaveWrite({
      name: "CV", kind: "resume", version: "v1", status: "draft",
      attachment: { blob: new Blob(["hello"]), originalName: "cv.txt" },
    }, { ...saveDisplayed(failed), linkedJob: null }, {
      onCleanupPrepared() { callbacks += 1; },
    }), (error) => error.code === "write_failed" && error.receipt === undefined);
    assert.equal(callbacks, 0);
    assert.equal(failed.capabilities.size, 0);
    assert.equal(failed.files.size, 0);
  } finally { failed.close(); }

  const readbackFailed = fixture();
  try {
    readbackFailed.state.capabilityFault = "read";
    let callbacks = 0;
    await assert.rejects(() => readbackFailed.service.prepareCareerMaterialSaveWrite({
      name: "CV", kind: "resume", version: "v1", status: "draft",
      attachment: { blob: new Blob(["hello"]), originalName: "cv.txt" },
    }, { ...saveDisplayed(readbackFailed), linkedJob: null }, {
      onCleanupPrepared() { callbacks += 1; },
    }), (error) => error.code === "write_failed" && error.receipt === undefined);
    assert.equal(callbacks, 0);
    assert.equal(readbackFailed.capabilities.size, 0);
    assert.equal(readbackFailed.files.size, 0);
  } finally { readbackFailed.close(); }
});

test("marker-exact save reports retryable private cleanup without losing the receipt", async () => {
  const value = fixture();
  try {
    const { receipt } = await prepareSavedAttachment(value);
    value.state.capabilityFault = "replace-before";
    const saved = await value.service.commitCareerMaterialWrite(receipt);
    assert.equal(saved.outcome, "saved");
    assert.equal(saved.cleanupPending, true);
    assert.equal(saved.cleanupRetryable, true);
    assert.equal(value.capabilities.has(receipt.intent.capabilityHandle), true);
    assert.equal(await value.service.inspectCareerMaterialWrite(receipt),
      "exact_saved_cleanup_pending");
    value.state.capabilityFault = "replace-after";
    const recovered = await value.service.commitCareerMaterialWrite(receipt);
    assert.equal(recovered.outcome, "already_saved");
    assert.equal(recovered.cleanupPending, undefined);
    assert.equal(recovered.privateFinalize, "completed");
    assert.equal(await value.service.inspectCareerMaterialWrite(receipt),
      "exact_saved_completed");
    assert.equal(JSON.parse([...value.capabilities.values()][0]).state, "completed");
  } finally { value.close(); }
});

test("capability read I/O stays unknown before a marker and cleanup-pending after an exact marker", async () => {
  const beforeMarker = fixture();
  try {
    const { receipt } = await prepareSavedAttachment(beforeMarker);
    const mutations = {
      batch: beforeMarker.state.batchCalls,
      delete: beforeMarker.state.deleteCalls,
      broadcast: beforeMarker.state.broadcasts.length,
    };
    beforeMarker.state.capabilityFault = "read-always";
    assert.equal(await beforeMarker.service.inspectCareerMaterialWrite(receipt), "still_unknown");
    const uncertain = await beforeMarker.service.commitCareerMaterialWrite(receipt);
    assert.equal(uncertain.outcome, "outcome_uncertain");
    assert.equal(uncertain.receipt.operationId, receipt.operationId);
    assert.deepEqual({
      batch: beforeMarker.state.batchCalls,
      delete: beforeMarker.state.deleteCalls,
      broadcast: beforeMarker.state.broadcasts.length,
    }, mutations);
  } finally { beforeMarker.close(); }

  const exactMarker = fixture();
  try {
    const { receipt } = await prepareSavedAttachment(exactMarker);
    exactMarker.state.capabilityFault = "replace-before";
    assert.equal((await exactMarker.service.commitCareerMaterialWrite(receipt)).cleanupPending, true);
    exactMarker.state.capabilityFault = "read-always";
    assert.equal(await exactMarker.service.inspectCareerMaterialWrite(receipt),
      "exact_saved_cleanup_pending");
    const replay = await exactMarker.service.commitCareerMaterialWrite(receipt);
    assert.equal(replay.outcome, "already_saved");
    assert.equal(replay.privateFinalize, "cleanup_pending");
    assert.equal(replay.cleanupPending, true);
  } finally { exactMarker.close(); }
});

test("a random capability-handle collision returns no foreign ticket and reaches no callback or file write", async () => {
  const value = fixture();
  try {
    const collidingHandle = uuid(3);
    const foreign = JSON.stringify({ foreign: true });
    value.capabilities.set(collidingHandle, foreign);
    let callbacks = 0;
    await assert.rejects(() => value.service.prepareCareerMaterialSaveWrite({
      name: "CV", kind: "resume", version: "v1", status: "draft",
      attachment: { blob: new Blob(["hello"]), originalName: "cv.txt" },
    }, { ...saveDisplayed(value), linkedJob: null }, {
      onCleanupPrepared() { callbacks += 1; },
    }), (error) => error.code === "write_failed" && error.receipt === undefined);
    assert.equal(callbacks, 0);
    assert.equal(value.files.size, 0);
    assert.equal(value.capabilities.size, 1);
    assert.equal(value.capabilities.get(collidingHandle), foreign);
    assert.equal(value.state.events.includes("file-write"), false);
  } finally { value.close(); }
});

test("cleanup tickets bind both operation and material before DB or file hooks", async () => {
  const value = fixture();
  try {
    const { cleanup } = await prepareSavedAttachment(value);
    const changedTail = (text) => `${text.slice(0, -1)}${text.endsWith("0") ? "1" : "0"}`;
    const wrongOperation = { ...cleanup, operationId: changedTail(cleanup.operationId) };
    const wrongMaterial = { ...cleanup, materialId: changedTail(cleanup.materialId) };
    for (const ticket of [wrongOperation, wrongMaterial]) {
      const before = callbackSnapshot(value);
      assert.equal((await value.service.inspectCareerMaterialFileCleanup(ticket)).state,
        "still_unknown");
      assert.equal((await value.service.retryCareerMaterialFileCleanup(ticket)).outcome,
        "cleanup_pending");
      assert.equal((await value.service.garbageCollectCareerMaterialFileCleanupCapability(ticket)).outcome,
        "cleanup_pending");
      const after = callbackSnapshot(value);
      assert.deepEqual({
        query: after.query, batch: after.batch, file: after.file,
        delete: after.delete, claim: after.claim, broadcast: after.broadcast,
      }, {
        query: before.query, batch: before.batch, file: before.file,
        delete: before.delete, claim: before.claim, broadcast: before.broadcast,
      });
    }
    assert.equal(value.files.size, 1);
  } finally { value.close(); }
});

test("main save and delete file read faults remain unknown with zero mutation", async () => {
  for (const fault of ["get-always", "hash-always"]) {
    const value = fixture();
    try {
      const { receipt } = await prepareSavedAttachment(value);
      value.state.fileFault = fault;
      const before = callbackSnapshot(value);
      assert.equal(await value.service.inspectCareerMaterialWrite(receipt), "still_unknown");
      await assert.rejects(() => value.service.commitCareerMaterialWrite(receipt),
        (error) => error.code === "inspect_failed" && error.receipt.operationId === receipt.operationId);
      const after = callbackSnapshot(value);
      assert.deepEqual({ batch: after.batch, delete: after.delete, broadcast: after.broadcast },
        { batch: before.batch, delete: before.delete, broadcast: before.broadcast });
      assert.equal(value.files.size, 1);
    } finally { value.close(); }
  }

  const deletion = fixture();
  try {
    const { receipt: saved } = await prepareSavedAttachment(deletion);
    await deletion.service.commitCareerMaterialWrite(saved);
    const key = [...deletion.files.keys()][0];
    convertAttachmentToOrdinary(deletion, key);
    const receipt = await deletion.service.prepareCareerMaterialDeleteWrite(
      deleteDisplayed(deletion, saved.after.material.id));
    deletion.state.fileFault = "inspect-candidate-always";
    const before = callbackSnapshot(deletion);
    assert.equal(await deletion.service.inspectCareerMaterialWrite(receipt), "still_unknown");
    await assert.rejects(() => deletion.service.commitCareerMaterialWrite(receipt),
      (error) => error.code === "inspect_failed" && error.receipt.operationId === receipt.operationId);
    const after = callbackSnapshot(deletion);
    assert.deepEqual({ batch: after.batch, delete: after.delete, broadcast: after.broadcast },
      { batch: before.batch, delete: before.delete, broadcast: before.broadcast });
    assert.equal(deletion.files.has(key), true);
    assert.notEqual(material(deletion.database, saved.after.material.id), null);
  } finally { deletion.close(); }
});

test("owned attachment deletion settles delete I/O response loss with the same receipt", async () => {
  for (const fault of ["delete-before", "delete-after"]) {
    const value = fixture();
    try {
      const { receipt: saved } = await prepareSavedAttachment(value);
      await value.service.commitCareerMaterialWrite(saved);
      const receipt = await value.service.prepareCareerMaterialDeleteWrite(
        deleteDisplayed(value, saved.after.material.id));
      value.state.fileFault = fault;
      if (fault === "delete-before") {
        await assert.rejects(() => value.service.commitCareerMaterialWrite(receipt), /同一回执继续/);
        assert.notEqual(material(value.database, saved.after.material.id), null);
        assert.equal((await value.service.commitCareerMaterialWrite(receipt)).outcome, "saved");
      } else {
        assert.equal((await value.service.commitCareerMaterialWrite(receipt)).outcome, "saved");
      }
      assert.equal(value.files.size, 0);
      assert.equal(material(value.database, saved.after.material.id), null);
    } finally { value.close(); }
  }
});

test("UI-safe material deletion accepts the displayed generation projection", async () => {
  const value = fixture();
  try {
    const { receipt: saved } = await prepareSavedAttachment(value);
    await value.service.commitCareerMaterialWrite(saved);
    const receipt = await value.service.prepareCareerMaterialDeleteWriteForUi({
      generationId: value.state.generationId,
      generationSequence: value.state.generationSequence,
      material: saved.after.material,
      linkedJob: job(value.database),
    });
    const committed = await value.service.commitCareerMaterialWrite(receipt);
    assert.equal(committed.outcome, "saved");
    assert.equal(material(value.database, saved.after.material.id), null);
  } finally { value.close(); }
});

test("UI-safe material deletion resolves an archived linked job under its prepare lock", async () => {
  const value = fixture();
  try {
    const { receipt: saved } = await prepareSavedAttachment(value);
    await value.service.commitCareerMaterialWrite(saved);
    execute(value.database, [{
      sql: "UPDATE career_jobs SET archived=1, archived_at=?, updated_at=? WHERE id='job'",
      params: [NOW, NOW],
    }]);
    const receipt = await value.service.prepareCareerMaterialDeleteWriteForUi({
      generationId: value.state.generationId,
      generationSequence: value.state.generationSequence,
      material: saved.after.material,
      linkedJob: null,
    });
    assert.equal(receipt.before.linkedJob.archived, 1);
    assert.equal((await value.service.commitCareerMaterialWrite(receipt)).outcome, "saved");
    assert.equal(material(value.database, saved.after.material.id), null);
  } finally { value.close(); }
});

test("ordinary legacy delete retains its claim across DB loss and releases only after marker", async () => {
  const value = fixture();
  try {
    const { receipt: saved } = await prepareSavedAttachment(value);
    await value.service.commitCareerMaterialWrite(saved);
    const key = [...value.files.keys()][0];
    convertAttachmentToOrdinary(value, key);
    const receipt = await value.service.prepareCareerMaterialDeleteWrite(
      deleteDisplayed(value, saved.after.material.id));
    value.state.batchFault = "before";
    await assert.rejects(() => value.service.commitCareerMaterialWrite(receipt), /确定没有提交/);
    assert.equal(value.files.has(key), false);
    assert.equal(value.claims.get(key)?.phase, "swept");
    assert.equal(value.capabilities.has(receipt.intent.capabilityHandle), true);
    assert.notEqual(material(value.database, saved.after.material.id), null);
    const recovered = await value.service.commitCareerMaterialWrite(receipt);
    assert.equal(recovered.outcome, "saved");
    assert.equal(value.claims.size, 0);
    assert.equal(JSON.parse([...value.capabilities.values()][0]).state, "completed");
    assert.equal(material(value.database, saved.after.material.id), null);
  } finally { value.close(); }
});

test("ordinary claim write and claim release settle before/after response loss", async () => {
  for (const claimFault of ["before", "after"]) {
    const value = fixture();
    try {
      const { receipt: saved } = await prepareSavedAttachment(value);
      await value.service.commitCareerMaterialWrite(saved);
      const key = [...value.files.keys()][0];
      convertAttachmentToOrdinary(value, key);
      const receipt = await value.service.prepareCareerMaterialDeleteWrite(
        deleteDisplayed(value, saved.after.material.id));
      value.state.claimFault = claimFault;
      if (claimFault === "before") {
        await assert.rejects(() => value.service.commitCareerMaterialWrite(receipt), /声明未能持久化/);
        assert.equal(value.files.has(key), true);
        assert.equal(value.claims.size, 0);
        assert.equal(value.state.batchCalls, 1);
      } else {
        assert.equal((await value.service.commitCareerMaterialWrite(receipt)).outcome, "saved");
        assert.equal(value.files.has(key), false);
        assert.equal(value.claims.size, 0);
      }
    } finally { value.close(); }
  }

  for (const releaseFault of ["before", "after"]) {
    const value = fixture();
    try {
      const { receipt: saved } = await prepareSavedAttachment(value);
      await value.service.commitCareerMaterialWrite(saved);
      const key = [...value.files.keys()][0];
      convertAttachmentToOrdinary(value, key);
      const receipt = await value.service.prepareCareerMaterialDeleteWrite(
        deleteDisplayed(value, saved.after.material.id));
      value.state.releaseFault = releaseFault;
      const committed = await value.service.commitCareerMaterialWrite(receipt);
      assert.equal(committed.outcome, "saved");
      if (releaseFault === "before") {
        assert.equal(committed.cleanupPending, true);
        assert.equal(value.claims.size, 1);
        assert.equal((await value.service.commitCareerMaterialWrite(receipt)).outcome, "already_saved");
      } else {
        assert.equal(committed.cleanupPending, undefined);
      }
      assert.equal(value.claims.size, 0);
      assert.equal(JSON.parse([...value.capabilities.values()][0]).state, "completed");
    } finally { value.close(); }
  }
});

test("missing-both ordinary deletes reserve a swept claim across before and after claim loss", async () => {
  for (const claimFault of ["before", "after"]) {
    const value = fixture();
    try {
      const { receipt: saved } = await prepareSavedAttachment(value);
      await value.service.commitCareerMaterialWrite(saved);
      const key = [...value.files.keys()][0];
      convertAttachmentToOrdinary(value, key);
      const receipt = await value.service.prepareCareerMaterialDeleteWrite(
        deleteDisplayed(value, saved.after.material.id));
      value.files.clear();
      value.state.claimFault = claimFault;
      if (claimFault === "after") value.state.batchFault = "before";
      const batches = value.state.batchCalls;
      await assert.rejects(() => value.service.commitCareerMaterialWrite(receipt),
        (error) => error.code === "write_failed" && error.receipt.operationId === receipt.operationId);
      assert.equal(value.state.deleteCalls, 0);
      assert.notEqual(material(value.database, saved.after.material.id), null);
      if (claimFault === "before") {
        assert.equal(value.claims.size, 0);
        assert.equal(value.state.batchCalls, batches);
      } else {
        assert.equal(value.claims.get(key)?.phase, "swept");
        assert.equal(value.state.batchCalls, batches + 1);
      }
      const recovered = await value.service.commitCareerMaterialWrite(receipt);
      assert.equal(recovered.outcome, "saved");
      assert.equal(recovered.privateFinalize, "completed");
      assert.equal(value.claims.size, 0);
      assert.equal(material(value.database, saved.after.material.id), null);
    } finally { value.close(); }
  }
});

test("generation replacement finalizes exact old private work and retains foreign replacements", async () => {
  const staged = fixture();
  try {
    const { receipt } = await prepareSavedAttachment(staged);
    const batches = staged.state.batchCalls;
    staged.state.generationId = GEN2; staged.state.generationSequence = 2;
    const changed = await staged.service.commitCareerMaterialWrite(receipt);
    assert.equal(changed.outcome, "changed");
    assert.equal(changed.privateFinalize, "completed");
    assert.equal(staged.state.batchCalls, batches);
    assert.equal(staged.files.size, 0);
    assert.equal(JSON.parse(staged.capabilities.get(receipt.intent.capabilityHandle)).state,
      "completed");
  } finally { staged.close(); }

  const foreign = fixture();
  try {
    const { receipt } = await prepareSavedAttachment(foreign);
    const key = [...foreign.files.keys()][0];
    foreign.files.get(key).metadata = {
      ...foreign.files.get(key).metadata,
      stagingOwner: "f".repeat(64),
    };
    foreign.state.generationId = GEN2; foreign.state.generationSequence = 2;
    const deletes = foreign.state.deleteCalls;
    const changed = await foreign.service.commitCareerMaterialWrite(receipt);
    assert.equal(changed.outcome, "changed");
    assert.equal(changed.privateFinalize, "cleanup_pending");
    assert.equal(foreign.state.deleteCalls, deletes);
    assert.equal(foreign.files.has(key), true);
    assert.equal(JSON.parse(foreign.capabilities.get(receipt.intent.capabilityHandle)).state,
      "active");
  } finally { foreign.close(); }

  const swept = fixture();
  try {
    const { receipt: saved } = await prepareSavedAttachment(swept);
    await swept.service.commitCareerMaterialWrite(saved);
    const key = [...swept.files.keys()][0];
    convertAttachmentToOrdinary(swept, key);
    const receipt = await swept.service.prepareCareerMaterialDeleteWrite(
      deleteDisplayed(swept, saved.after.material.id));
    swept.state.batchFault = "before";
    await assert.rejects(() => swept.service.commitCareerMaterialWrite(receipt), /确定没有提交/);
    assert.equal(swept.claims.get(key)?.phase, "swept");
    swept.state.generationId = GEN2; swept.state.generationSequence = 2;
    swept.state.releaseFault = "after";
    const pending = await swept.service.commitCareerMaterialWrite(receipt);
    assert.equal(pending.outcome, "changed");
    assert.equal(pending.privateFinalize, "cleanup_pending");
    assert.equal((await swept.service.commitCareerMaterialWrite(receipt)).privateFinalize,
      "completed");
    assert.equal(swept.claims.size, 0);
    assert.equal(swept.files.size, 0);
    assert.notEqual(material(swept.database, saved.after.material.id), null);
  } finally { swept.close(); }
});

test("delete capability re-derives its owner and rejects owner swaps before file mutation", async () => {
  const value = fixture();
  try {
    const { receipt: saved } = await prepareSavedAttachment(value);
    await value.service.commitCareerMaterialWrite(saved);
    const key = [...value.files.keys()][0];
    convertAttachmentToOrdinary(value, key);
    const receipt = await value.service.prepareCareerMaterialDeleteWrite(
      deleteDisplayed(value, saved.after.material.id));
    const handle = receipt.before.fileReceipt.handle;
    const resolution = await value.runtime.withExclusiveLock(() =>
      materialFiles.resolveCareerMaterialDeleteFileReceipt(receipt.before.fileReceipt, value.runtime));
    assert.equal(resolution.state, "active");
    const beforeIssue = callbackSnapshot(value);
    await assert.rejects(() => materialFiles.issueCareerMaterialDeleteFileReceipt({
      ...resolution.payload,
      deletionOwner: "f".repeat(64),
    }, uuid(999), value.runtime), /owner/);
    assert.deepEqual(callbackSnapshot(value), beforeIssue);

    const record = JSON.parse(value.capabilities.get(handle));
    record.payload.deletionOwner = "f".repeat(64);
    record.payloadSha256 = await marker.hashCareerWriteValue({
      version: record.version,
      purpose: record.purpose,
      handle: record.handle,
      state: record.state,
      payload: record.payload,
    });
    value.capabilities.set(handle, JSON.stringify(record));
    const beforeCommit = callbackSnapshot(value);
    assert.equal(await value.service.inspectCareerMaterialWrite(receipt), "invalid_receipt");
    await assert.rejects(() => value.service.commitCareerMaterialWrite(receipt),
      (error) => error.code === "invalid_receipt");
    const afterCommit = callbackSnapshot(value);
    assert.deepEqual({ batch: afterCommit.batch, file: afterCommit.file,
      delete: afterCommit.delete, claim: afterCommit.claim, broadcast: afterCommit.broadcast },
    { batch: beforeCommit.batch, file: beforeCommit.file,
      delete: beforeCommit.delete, claim: beforeCommit.claim, broadcast: beforeCommit.broadcast });
    assert.equal(value.files.has(key), true);
  } finally { value.close(); }
});

test("a claimed ordinary deletion never removes a foreign same-key restore", async () => {
  const value = fixture();
  try {
    const { receipt: saved } = await prepareSavedAttachment(value);
    await value.service.commitCareerMaterialWrite(saved);
    const key = [...value.files.keys()][0];
    const ordinary = convertAttachmentToOrdinary(value, key);
    const receipt = await value.service.prepareCareerMaterialDeleteWrite(
      deleteDisplayed(value, saved.after.material.id));
    value.state.batchFault = "before";
    await assert.rejects(() => value.service.commitCareerMaterialWrite(receipt), /确定没有提交/);
    const foreignFile = new Blob(["foreign restored bytes"]);
    value.files.set(key, {
      metadata: { ...ordinary, byteSize: foreignFile.size, sha256: await hashBlob(foreignFile), updatedAt: NOW },
      file: foreignFile,
    });
    const deletes = value.state.deleteCalls;
    assert.equal((await value.service.commitCareerMaterialWrite(receipt)).outcome, "changed");
    assert.equal(value.files.get(key).file, foreignFile);
    assert.equal(value.state.deleteCalls, deletes);
    assert.notEqual(material(value.database, saved.after.material.id), null);
  } finally { value.close(); }
});

test("cleanup delete I/O uses post-failure fragment classification", async () => {
  const before = fixture();
  try {
    const { cleanup } = await prepareSavedAttachment(before);
    before.state.fileFault = "delete-before";
    const pending = await before.service.retryCareerMaterialFileCleanup(cleanup);
    assert.equal(pending.outcome, "cleanup_pending");
    assert.equal(pending.ticket.cleanupReceipt.handle, cleanup.cleanupReceipt.handle);
    assert.equal((await before.service.retryCareerMaterialFileCleanup(cleanup)).outcome, "cleaned");
  } finally { before.close(); }

  const after = fixture();
  try {
    const { cleanup } = await prepareSavedAttachment(after);
    after.state.fileFault = "delete-after";
    assert.equal((await after.service.retryCareerMaterialFileCleanup(cleanup)).outcome, "cleaned");
    assert.equal(after.files.size, 0);
  } finally { after.close(); }

  const foreign = fixture();
  try {
    const { cleanup } = await prepareSavedAttachment(foreign);
    const key = [...foreign.files.keys()][0];
    foreign.state.fileFault = "delete-before";
    foreign.state.fragmentOverrides.set(key, {
      state: "foreign_or_unverifiable", objectPresent: true, metadataPresent: true,
    });
    assert.equal((await foreign.service.retryCareerMaterialFileCleanup(cleanup)).reason, "file_changed");
  } finally { foreign.close(); }
});

test("cleanup completion response loss remains replayable with the same bound ticket", async () => {
  for (const replaceFault of ["replace-before", "replace-after"]) {
    const value = fixture();
    try {
      const { cleanup } = await prepareSavedAttachment(value);
      value.state.capabilityFault = replaceFault;
      const first = await value.service.retryCareerMaterialFileCleanup(cleanup);
      if (replaceFault === "replace-before") {
        assert.equal(first.outcome, "cleanup_pending");
        assert.equal(first.ticket.cleanupReceipt.handle, cleanup.cleanupReceipt.handle);
        assert.equal(JSON.parse(value.capabilities.get(cleanup.cleanupReceipt.handle)).state,
          "active");
        assert.equal((await value.service.retryCareerMaterialFileCleanup(cleanup)).outcome,
          "already_cleaned");
      } else {
        assert.equal(first.outcome, "cleaned");
      }
      assert.equal(JSON.parse(value.capabilities.get(cleanup.cleanupReceipt.handle)).state,
        "completed");
      assert.equal((await value.service.retryCareerMaterialFileCleanup(cleanup)).outcome,
        "already_cleaned");
    } finally { value.close(); }
  }
});

test("private capability records are strict, bounded, purpose-bound, and fail closed", async () => {
  for (const mutation of ["extra", "purpose", "missing", "oversized"]) {
    const value = fixture();
    try {
      const { receipt, cleanup } = await prepareSavedAttachment(value);
      const handle = cleanup.cleanupReceipt.handle;
      if (mutation === "missing") value.capabilities.delete(handle);
      else if (mutation === "oversized") value.capabilities.set(handle, "x".repeat(65 * 1024));
      else {
        const record = JSON.parse(value.capabilities.get(handle));
        if (mutation === "extra") record.extra = true;
        else record.purpose = "career-material-delete-file";
        record.payloadSha256 = await marker.hashCareerWriteValue({
          version: record.version, purpose: record.purpose, handle: record.handle,
          state: record.state, payload: record.payload,
        });
        value.capabilities.set(handle, JSON.stringify(record));
      }
      const beforeBatch = value.state.batchCalls;
      const beforeDelete = value.state.deleteCalls;
      assert.equal((await value.service.inspectCareerMaterialFileCleanup(cleanup)).state, "still_unknown");
      assert.equal((await value.service.retryCareerMaterialFileCleanup(cleanup)).outcome, "cleanup_pending");
      await assert.rejects(() => value.service.commitCareerMaterialWrite(receipt),
        (error) => error.code === "invalid_receipt");
      assert.equal(value.state.batchCalls, beforeBatch);
      assert.equal(value.state.deleteCalls, beforeDelete);
      assert.equal(value.files.size, 1);
    } finally { value.close(); }
  }

  const invalid = fixture();
  try {
    const before = callbackSnapshot(invalid);
    const traversal = { purpose: "career-material-file-cleanup", version: 1, handle: "../../secret" };
    await assert.rejects(() => invalid.service.inspectCareerMaterialFileCleanup(traversal),
      (error) => error.code === "invalid_receipt");
    await assert.rejects(() => invalid.service.retryCareerMaterialFileCleanup(traversal),
      (error) => error.code === "invalid_receipt");
    assert.deepEqual(callbackSnapshot(invalid), before);
  } finally { invalid.close(); }
});

test("generation restore GC removes only exact old-owner staging and its private record", async () => {
  const owned = fixture();
  try {
    const { cleanup } = await prepareSavedAttachment(owned);
    owned.state.generationId = GEN2; owned.state.generationSequence = 2;
    assert.equal((await owned.service.retryCareerMaterialFileCleanup(cleanup)).reason, "generation_changed");
    owned.state.capabilityFault = "replace-after";
    assert.equal((await owned.service.garbageCollectCareerMaterialFileCleanupCapability(cleanup)).outcome,
      "cleaned_and_released");
    assert.equal(owned.files.size, 0);
    assert.equal(JSON.parse([...owned.capabilities.values()][0]).state, "completed");
  } finally { owned.close(); }

  const foreign = fixture();
  try {
    const { cleanup } = await prepareSavedAttachment(foreign);
    const key = [...foreign.files.keys()][0];
    const replacement = foreign.files.get(key);
    replacement.metadata = { ...replacement.metadata, stagingOwner: "f".repeat(64) };
    foreign.state.generationId = GEN2; foreign.state.generationSequence = 2;
    const deletes = foreign.state.deleteCalls;
    assert.equal((await foreign.service.garbageCollectCareerMaterialFileCleanupCapability(cleanup)).reason,
      "file_changed");
    assert.equal(foreign.state.deleteCalls, deletes);
    assert.equal(foreign.files.has(key), true);
    assert.equal(foreign.capabilities.has(cleanup.cleanupReceipt.handle), true);
  } finally { foreign.close(); }

  const missing = fixture();
  try {
    const { cleanup } = await prepareSavedAttachment(missing);
    missing.files.clear();
    missing.state.generationId = GEN2; missing.state.generationSequence = 2;
    assert.equal((await missing.service.garbageCollectCareerMaterialFileCleanupCapability(cleanup)).outcome,
      "released");
    assert.equal(JSON.parse([...missing.capabilities.values()][0]).state, "completed");
  } finally { missing.close(); }
});
