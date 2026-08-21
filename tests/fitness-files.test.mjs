import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const ZERO_SHA = "0".repeat(64);
const FIRST_UUID = "10000000-0000-4000-8000-000000000001";
const SECOND_UUID = "20000000-0000-4000-8000-000000000002";
const STORED_UUID = "30000000-0000-4000-8000-000000000003";
const FOURTH_UUID = "40000000-0000-4000-8000-000000000004";
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

function pngFile(name = "器械 正面.png", type = "image/png") {
  return new File([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3),
  ], name, { type });
}

function jpegFile(name = "rack.jpg", type = "image/jpeg") {
  return new File([Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3)], name, { type });
}

function row(overrides = {}) {
  return {
    id: "fitness-file-existing",
    entity_type: "venue",
    entity_id: "venue-1",
    purpose: "photo",
    file_key: STORED_UUID,
    file_name: "venue.png",
    mime_type: "image/png",
    byte_size: 11,
    sha256: "a".repeat(64),
    status: "ready",
    created_at: 10,
    updated_at: 10,
    ...overrides,
  };
}

async function fixture(options = {}) {
  const state = {
    lockCalls: 0,
    lockDepth: 0,
    rows: new Map((options.rows ?? []).map((entry) => [entry.id, { ...entry }])),
    local: new Map((options.local ?? []).map((entry) => [entry.metadata.key, entry])),
    venues: new Set(options.venues ?? ["venue-1"]),
    equipment: new Set(options.equipment ?? ["equipment-1"]),
    sessions: new Set(options.sessions ?? ["session-1"]),
    deletedKeys: [],
    broadcasts: [],
    operations: [],
    uuidQueue: [...(options.uuidQueue ?? [FIRST_UUID, SECOND_UUID, STORED_UUID, FOURTH_UUID])],
    ownerQueue: [...(options.ownerQueue ?? [OWNER_A, OWNER_B])],
    generation: {
      database: "shilian",
      generationId: GENERATION_A,
      filename: `shilian.${GENERATION_A}.sqlite3`,
      sequence: 1,
      legacy: false,
      ...(options.generation ?? {}),
    },
    generationQueue: [...(options.generationQueue ?? [])],
    now: 1_800_000_000_000,
  };
  const requireLock = (operation) => {
    assert.equal(state.lockDepth, 1, `${operation} must run inside the exclusive Fitness lock`);
  };
  const runtime = {
    async withExclusiveLock(task) {
      state.lockCalls += 1;
      assert.equal(state.lockDepth, 0, "Fitness file operations must not nest locks");
      state.lockDepth = 1;
      try {
        return await task();
      } finally {
        state.lockDepth = 0;
      }
    },
    async query(sql, params = []) {
      requireLock("query");
      state.operations.push(["query", sql, params]);
      if (/FROM fitness_venues/.test(sql)) {
        return { rows: state.venues.has(params[0]) ? [{ id: params[0] }] : [] };
      }
      if (/FROM fitness_equipment/.test(sql)) {
        return { rows: state.equipment.has(params[0]) ? [{ id: params[0] }] : [] };
      }
      if (/FROM fitness_sessions/.test(sql)) {
        return { rows: state.sessions.has(params[0]) ? [{ id: params[0] }] : [] };
      }
      if (/WHERE id = \? LIMIT 1/.test(sql)) {
        const found = state.rows.get(params[0]);
        return { rows: found ? [{ ...found }] : [] };
      }
      if (/FROM fitness_files ORDER BY/.test(sql)) {
        return { rows: [...state.rows.values()].map((entry) => ({ ...entry })) };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run(sql, params = []) {
      requireLock("run");
      state.operations.push(["run", sql, params]);
      if (/INSERT INTO fitness_files/.test(sql)) {
        if (options.insertMode === "precommit_fail") throw new Error("insert failed before commit");
        const [id, entityType, entityId, purpose, key, name, mime, size, sha, status, created, updated] = params;
        if (state.rows.has(id)) return { changes: 0 };
        state.rows.set(id, row({
          id,
          entity_type: entityType,
          entity_id: entityId,
          purpose,
          file_key: key,
          file_name: name,
          mime_type: mime,
          byte_size: size,
          sha256: sha,
          status,
          created_at: created,
          updated_at: updated,
        }));
        if (options.insertMode === "response_loss") throw new Error("insert response lost");
        return { changes: 1 };
      }
      if (/SET file_key = \?, file_name = \?/.test(sql)) {
        if (options.failReadyUpdate) return { changes: 0 };
        const [key, name, mime, size, sha, updated] = params;
        const expected = rowFromCasParams(params.slice(6));
        const current = state.rows.get(expected.id);
        if (!current || !sameRow(current, expected)) return { changes: 0 };
        state.rows.set(expected.id, {
          ...current,
          file_key: key,
          file_name: name,
          mime_type: mime,
          byte_size: size,
          sha256: sha,
          status: "ready",
          updated_at: updated,
        });
        return { changes: 1 };
      }
      if (/DELETE FROM fitness_files WHERE id = \? AND status = 'missing' AND sha256 = \?/.test(sql)) {
        const current = state.rows.get(params[0]);
        if (current?.status === "missing" && current.sha256 === params[1]) state.rows.delete(params[0]);
        return { changes: current ? 1 : 0 };
      }
      if (/DELETE FROM fitness_files WHERE id = \? AND entity_type = \?/.test(sql)) {
        const current = state.rows.get(params[0]);
        const expected = rowFromCasParams(params);
        const matches = current && sameRow(current, expected);
        if (matches) state.rows.delete(params[0]);
        if (matches && options.deleteRowMode === "response_loss") {
          throw new Error("delete row response lost");
        }
        return { changes: matches ? 1 : 0 };
      }
      if (/SET status = 'deleting'/.test(sql) && /entity_type = \?/.test(sql)) {
        const current = state.rows.get(params[1]);
        const expected = rowFromCasParams(params.slice(1));
        const matches = current && sameRow(current, expected);
        if (matches) {
          state.rows.set(current.id, { ...current, status: "deleting", updated_at: params[0] });
        }
        if (matches && options.markDeleteMode === "response_loss") {
          throw new Error("delete mark response lost");
        }
        return { changes: matches ? 1 : 0 };
      }
      if (/SET status = 'missing'/.test(sql)) {
        const current = state.rows.get(params[1]);
        if (current?.status === "ready") state.rows.set(current.id, { ...current, status: "missing", updated_at: params[0] });
        return { changes: current ? 1 : 0 };
      }
      if (/SET status = 'ready'/.test(sql)) {
        const current = state.rows.get(params[1]);
        if (current?.status === "missing") state.rows.set(current.id, { ...current, status: "ready", updated_at: params[0] });
        return { changes: current ? 1 : 0 };
      }
      throw new Error(`Unexpected run: ${sql}`);
    },
    async currentGeneration() {
      requireLock("currentGeneration");
      const queued = state.generationQueue.shift();
      return { ...(queued ?? state.generation) };
    },
    async assertFileKeyAvailable(key) {
      requireLock("assertFileKeyAvailable");
      if (!state.local.has(key)) return;
      const error = new Error("file key collision");
      error.code = "FILE_KEY_COLLISION";
      throw error;
    },
    async saveFileAtKey(key, blob, saveOptions, stagingOwner) {
      requireLock("saveFileAtKey");
      if (state.local.has(key)) {
        const error = new Error("file key collision");
        error.code = "FILE_KEY_COLLISION";
        throw error;
      }
      if (options.saveAtKeyMode === "precommit_fail") {
        throw new Error("file write failed before claim");
      }
      if (options.saveAtKeyMode === "partial_claim") {
        state.local.set(key, { partial: true, stagingOwner });
        throw new Error("file write failed after claim");
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
      const file = new File([blob], metadata.originalName, { type: metadata.mimeType });
      state.local.set(key, { metadata, file });
      if (options.saveAtKeyMode === "response_loss") throw new Error("file response lost");
      return metadata;
    },
    async deleteOwnedFile(key, stagingOwner) {
      requireLock("deleteOwnedFile");
      state.deletedKeys.push(key);
      const current = state.local.get(key);
      const owner = current?.metadata?.stagingOwner ?? current?.stagingOwner;
      if (!current) return false;
      if (owner !== stagingOwner) {
        const error = new Error("foreign owner");
        error.code = "FILE_OWNERSHIP_MISMATCH";
        throw error;
      }
      state.local.delete(key);
      if (options.deleteOwnedMode === "response_loss") throw new Error("owned delete response lost");
      return true;
    },
    async saveFile(blob, saveOptions) {
      requireLock("saveFile");
      if (options.saveError) throw options.saveError;
      const key = state.uuidQueue.shift() ?? STORED_UUID;
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
      };
      const file = new File([blob], metadata.originalName, { type: metadata.mimeType });
      state.local.set(key, { metadata, file });
      return metadata;
    },
    async getFile(key) {
      requireLock("getFile");
      const found = state.local.get(key);
      if (!found || found.partial) throw new Error("FILE_BYTES_NOT_FOUND");
      return found;
    },
    async listFiles() {
      requireLock("listFiles");
      return [...state.local.values()].flatMap((entry) => entry.metadata ? [entry.metadata] : []);
    },
    async deleteFile(key) {
      requireLock("deleteFile");
      state.deletedKeys.push(key);
      return state.local.delete(key);
    },
    hashBlob,
    getBuiltInExercise(id) {
      return id === "bodyweight-squat" ? { id } : null;
    },
    randomUUID() {
      return state.uuidQueue.shift() ?? STORED_UUID;
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
  return { state, runtime, service: files.createFitnessFileService(runtime) };
}

function rowFromCasParams(params) {
  const [id, entityType, entityId, purpose, key, name, mime, size, sha, status, created, updated] = params;
  return row({
    id,
    entity_type: entityType,
    entity_id: entityId,
    purpose,
    file_key: key,
    file_name: name,
    mime_type: mime,
    byte_size: size,
    sha256: sha,
    status,
    created_at: created,
    updated_at: updated,
  });
}

function sameRow(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stageReceiptFile(state, receipt, file, overrides = {}) {
  state.local.set(receipt.expectedFile.key, {
    metadata: { ...receipt.expectedFile, ...overrides },
    file,
  });
}

test("rejects mismatched extension/MIME and disguised bytes before touching storage", async () => {
  const { state, service } = await fixture();
  await assert.rejects(
    service.saveFitnessFile({
      entityType: "venue",
      entityId: "venue-1",
      purpose: "photo",
      file: jpegFile("not-really.png"),
    }),
    (error) => error.code === "UNSUPPORTED_FILE_TYPE",
  );
  await assert.rejects(
    service.saveFitnessFile({
      entityType: "venue",
      entityId: "venue-1",
      purpose: "photo",
      file: new File(["plain text"], "fake.jpg", { type: "image/jpeg" }),
    }),
    (error) => error.code === "FILE_SIGNATURE_MISMATCH",
  );
  assert.equal(state.lockCalls, 0);
  assert.equal(state.rows.size, 0);
  assert.equal(state.local.size, 0);
});

test("validates the exact entity kind and only accepts catalog-backed exercises", async () => {
  const { state, service } = await fixture({ venues: [], equipment: ["equipment-1"] });
  await assert.rejects(
    service.saveFitnessFile({
      entityType: "venue",
      entityId: "equipment-1",
      purpose: "photo",
      file: pngFile(),
    }),
    (error) => error.code === "ENTITY_NOT_FOUND",
  );
  await assert.rejects(
    service.saveFitnessFile({
      entityType: "exercise",
      entityId: "made-up-exercise",
      purpose: "instruction",
      file: pngFile(),
    }),
    (error) => error.code === "ENTITY_NOT_FOUND",
  );
  const saved = await service.saveFitnessFile({
    entityType: "exercise",
    entityId: "bodyweight-squat",
    purpose: "instruction",
    file: pngFile("深蹲 提示.png"),
  });
  assert.equal(saved.entity_id, "bodyweight-squat");
  assert.equal(saved.file_name, "深蹲 提示.png");
  assert.equal(state.rows.size, 1);
});

test("prepares a JSON-safe stable receipt, saves the exact projection, and retries idempotently", async () => {
  const { state, service } = await fixture();
  const source = pngFile("器械 正面.png");
  const input = {
    entityType: "equipment",
    entityId: "equipment-1",
    purpose: "photo",
    file: source,
  };
  const prepared = await service.prepareFitnessFileSave(input);
  const receipt = JSON.parse(JSON.stringify(prepared));
  const result = await service.saveFitnessFileSafely(input, receipt);
  const expectedHash = await hashBlob(source);

  assert.equal(state.lockCalls, 2);
  assert.equal(result.outcome, "saved");
  assert.equal(result.record.status, "ready");
  assert.equal(result.record.file_name, "器械 正面.png");
  assert.equal(result.record.mime_type, "image/png");
  assert.equal(result.record.byte_size, source.size);
  assert.equal(result.record.sha256, expectedHash);
  assert.deepEqual(state.broadcasts, ["fitness-file-saved"]);
  const insert = state.operations.find(([, sql]) => /INSERT INTO fitness_files/.test(sql));
  assert.equal(insert[2][7], source.size);
  assert.equal(insert[2][8], expectedHash);
  assert.equal(insert[2][9], "ready");
  const stored = state.local.get(result.record.file_key);
  assert.equal(stored.metadata.category, `fitness-file:${result.record.id}`);
  assert.equal(stored.metadata.stagingOwner, OWNER_A);
  assert.equal(state.rows.get(result.record.id).status, "ready");

  const operationCount = state.operations.length;
  const retry = await service.saveFitnessFileSafely(input, receipt);
  assert.equal(retry.outcome, "already_saved");
  assert.equal(state.operations.filter(([, sql]) => /INSERT INTO fitness_files/.test(sql)).length, 1);
  assert.ok(state.operations.length > operationCount, "retry performs check-only reads");
  assert.equal(state.deletedKeys.length, 0);
});

test("a definite precommit row failure clears only the receipt-owned unreferenced stage", async () => {
  const { state, service } = await fixture({ insertMode: "precommit_fail" });
  const input = {
    entityType: "venue",
    entityId: "venue-1",
    purpose: "photo",
    file: pngFile(),
  };
  const receipt = await service.prepareFitnessFileSave(input);
  await assert.rejects(
    service.saveFitnessFileSafely(input, receipt),
    (error) => error.code === "SAVE_NOT_COMMITTED",
  );
  assert.equal(state.local.size, 0);
  assert.equal(state.rows.size, 0);
  assert.equal(state.deletedKeys.length, 1);
  assert.deepEqual(state.broadcasts, []);
});

test("post-ready response loss and broadcast failure preserve durable success", async () => {
  const { state, service } = await fixture({
    insertMode: "response_loss",
    broadcastThrows: true,
  });
  const input = {
    entityType: "venue",
    entityId: "venue-1",
    purpose: "photo",
    file: pngFile(),
  };
  const receipt = await service.prepareFitnessFileSave(input);
  const result = await service.saveFitnessFileSafely(input, receipt);
  assert.equal(result.outcome, "saved");
  assert.equal(await service.inspectFitnessFileSave(receipt), "exact_saved");
  const refreshed = await service.listFitnessFiles();
  assert.ok(refreshed.some((entry) => entry.id === receipt.expectedRow.id && entry.status === "ready"));
  assert.equal(state.rows.has(receipt.expectedRow.id), true);
  assert.equal(state.local.has(receipt.expectedFile.key), true);
  assert.equal(state.deletedKeys.length, 0);
  assert.deepEqual(state.broadcasts, []);
});

test("partial OPFS claim stays outcome-uncertain and check-only inspection never deletes it", async () => {
  const { state, service } = await fixture({ saveAtKeyMode: "partial_claim" });
  const input = {
    entityType: "venue",
    entityId: "venue-1",
    purpose: "photo",
    file: pngFile(),
  };
  const receipt = await service.prepareFitnessFileSave(input);
  const result = await service.saveFitnessFileSafely(input, receipt);
  assert.equal(result.outcome, "outcome_uncertain");
  assert.equal(await service.inspectFitnessFileSave(receipt), "still_unknown");
  assert.equal(state.rows.size, 0);
  assert.equal(state.local.has(receipt.expectedFile.key), true);
  assert.equal(state.deletedKeys.length, 0);
  assert.deepEqual(state.broadcasts, []);
});

test("receipt-only resume survives refresh without the original File and accepts INSERT response loss", async () => {
  const { state, service } = await fixture({
    insertMode: "response_loss",
    broadcastThrows: true,
  });
  const source = pngFile("相机临时照片.png");
  const input = {
    entityType: "venue",
    entityId: "venue-1",
    purpose: "photo",
    file: source,
  };
  const receipt = JSON.parse(JSON.stringify(
    await service.prepareFitnessFileSave(input),
  ));
  stageReceiptFile(state, receipt, source);

  const resumed = await service.resumeFitnessFileSave(receipt);
  assert.equal(resumed.outcome, "saved");
  assert.equal(await service.inspectFitnessFileSave(receipt), "exact_saved");
  assert.equal(state.rows.has(receipt.expectedRow.id), true);
  assert.equal(state.local.has(receipt.expectedFile.key), true);
  assert.equal(state.deletedKeys.length, 0);
});

test("receipt-only discard removes exact and partial claims only through the bound owner", async () => {
  const empty = await fixture();
  const emptyInput = {
    entityType: "venue",
    entityId: "venue-1",
    purpose: "photo",
    file: pngFile(),
  };
  const emptyReceipt = await empty.service.prepareFitnessFileSave(emptyInput);
  assert.equal(
    (await empty.service.discardFitnessFileSave(emptyReceipt)).outcome,
    "already_absent",
  );
  assert.equal(empty.state.deletedKeys.length, 0);

  const exact = await fixture();
  const source = pngFile();
  const input = {
    entityType: "venue",
    entityId: "venue-1",
    purpose: "photo",
    file: source,
  };
  const exactReceipt = await exact.service.prepareFitnessFileSave(input);
  stageReceiptFile(exact.state, exactReceipt, source);
  assert.equal(
    (await exact.service.discardFitnessFileSave(exactReceipt)).outcome,
    "discarded",
  );
  assert.equal(exact.state.local.has(exactReceipt.expectedFile.key), false);

  const partial = await fixture();
  const partialReceipt = await partial.service.prepareFitnessFileSave(input);
  partial.state.local.set(partialReceipt.expectedFile.key, {
    partial: true,
    stagingOwner: partialReceipt.expectedFile.stagingOwner,
  });
  assert.equal(
    (await partial.service.discardFitnessFileSave(partialReceipt)).outcome,
    "discarded",
  );
  assert.equal(partial.state.local.has(partialReceipt.expectedFile.key), false);

  const corrupted = await fixture();
  const corruptedReceipt = await corrupted.service.prepareFitnessFileSave(input);
  stageReceiptFile(corrupted.state, corruptedReceipt, source, {
    originalName: "corrupted-name.png",
  });
  assert.equal(
    (await corrupted.service.discardFitnessFileSave(corruptedReceipt)).outcome,
    "discarded",
  );
  assert.equal(corrupted.state.local.has(corruptedReceipt.expectedFile.key), false);
});

test("foreign owner and generation changes make receipt-only recovery fail closed", async () => {
  const source = pngFile();
  const input = {
    entityType: "venue",
    entityId: "venue-1",
    purpose: "photo",
    file: source,
  };
  const foreign = await fixture();
  const foreignReceipt = await foreign.service.prepareFitnessFileSave(input);
  foreign.state.local.set(foreignReceipt.expectedFile.key, {
    partial: true,
    stagingOwner: OWNER_B,
  });
  const discard = await foreign.service.discardFitnessFileSave(foreignReceipt);
  assert.equal(discard.outcome, "outcome_uncertain");
  assert.equal(foreign.state.local.has(foreignReceipt.expectedFile.key), true);
  assert.equal(foreign.state.deletedKeys.length, 1, "owned delete was attempted but failed closed");

  const validForeign = await fixture();
  const validForeignReceipt = await validForeign.service.prepareFitnessFileSave(input);
  stageReceiptFile(validForeign.state, validForeignReceipt, source, {
    stagingOwner: OWNER_B,
  });
  assert.deepEqual(
    await validForeign.service.discardFitnessFileSave(validForeignReceipt),
    { outcome: "blocked", reason: "conflict", receipt: validForeignReceipt },
  );
  assert.equal(validForeign.state.local.has(validForeignReceipt.expectedFile.key), true);

  const switched = await fixture();
  const switchedReceipt = await switched.service.prepareFitnessFileSave(input);
  stageReceiptFile(switched.state, switchedReceipt, source);
  switched.state.generation = {
    ...switched.state.generation,
    generationId: GENERATION_B,
    sequence: 2,
  };
  await assert.rejects(
    switched.service.resumeFitnessFileSave(switchedReceipt),
    (error) => error.code === "GENERATION_CHANGED",
  );
  assert.deepEqual(
    await switched.service.discardFitnessFileSave(switchedReceipt),
    { outcome: "blocked", reason: "generation_changed", receipt: switchedReceipt },
  );
  assert.equal(switched.state.local.has(switchedReceipt.expectedFile.key), true);
  assert.equal(switched.state.rows.size, 0);
});

test("strict receipt guards accept JSON round trips and reject extra or altered authority", async () => {
  const { state, service } = await fixture();
  const source = pngFile();
  const input = {
    entityType: "venue",
    entityId: "venue-1",
    purpose: "photo",
    file: source,
  };
  const saveReceipt = JSON.parse(JSON.stringify(
    await service.prepareFitnessFileSave(input),
  ));
  assert.equal(files.isFitnessFileSaveReceipt(saveReceipt), true);
  assert.equal(files.isFitnessFileSaveReceipt({ ...saveReceipt, extra: true }), false);
  assert.doesNotThrow(() => files.isFitnessFileSaveReceipt({
    ...saveReceipt,
    expectedRow: {
      ...saveReceipt.expectedRow,
      created_at: Number.MAX_SAFE_INTEGER,
      updated_at: Number.MAX_SAFE_INTEGER,
    },
  }));
  assert.equal(files.isFitnessFileSaveReceipt({
    ...saveReceipt,
    expectedRow: {
      ...saveReceipt.expectedRow,
      created_at: Number.MAX_SAFE_INTEGER,
      updated_at: Number.MAX_SAFE_INTEGER,
    },
  }), false);
  assert.equal(files.isFitnessFileSaveReceipt({
    ...saveReceipt,
    expectedFile: { ...saveReceipt.expectedFile, stagingOwner: OWNER_B },
  }), true, "a structurally valid ticket is still constrained by exact storage inspection");

  stageReceiptFile(state, saveReceipt, source);
  await service.resumeFitnessFileSave(saveReceipt);
  const deleteReceipt = JSON.parse(JSON.stringify(
    await service.prepareFitnessFileDelete(saveReceipt.expectedRow.id),
  ));
  assert.equal(files.isFitnessFileDeleteReceipt(deleteReceipt), true);
  assert.equal(files.isFitnessFileDeleteReceipt({
    ...deleteReceipt,
    expectedRow: { ...deleteReceipt.expectedRow, updated_at: -1 },
  }), false);
  assert.equal(files.isFitnessFileDeleteReceipt({
    ...deleteReceipt,
    deletingUpdatedAt: deleteReceipt.expectedRow.updated_at - 1,
  }), false);
});

test("delete receipt binds the generation, complete row, OPFS owner, and is idempotent", async () => {
  const source = pngFile("venue.png");
  const metadata = {
    version: 1,
    namespace: "fitness",
    key: STORED_UUID,
    originalName: "venue.png",
    mimeType: "image/png",
    category: "fitness-file:fitness-file-existing",
    byteSize: source.size,
    sha256: await hashBlob(source),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stagingOwner: OWNER_A,
  };
  const record = row({ byte_size: source.size, sha256: metadata.sha256 });
  const { state, service } = await fixture({ rows: [record], local: [{ metadata, file: source }] });

  const receipt = JSON.parse(JSON.stringify(
    await service.prepareFitnessFileDelete(record.id),
  ));
  const deleted = await service.deleteFitnessFileSafely(receipt);
  assert.equal(deleted.outcome, "deleted");
  const retry = await service.deleteFitnessFileSafely(receipt);
  assert.equal(retry.outcome, "already_deleted");
  assert.equal(state.rows.size, 0);
  assert.equal(state.local.size, 0);
  assert.deepEqual(state.deletedKeys, [STORED_UUID]);
  assert.deepEqual(state.broadcasts, ["fitness-file-deleted"]);
  assert.equal(state.lockCalls, 3);
  const deletingIndex = state.operations.findIndex(([, sql]) => /SET status = 'deleting'/.test(sql));
  const deleteRowIndex = state.operations.findIndex(([, sql]) => /DELETE FROM fitness_files WHERE id = \? AND entity_type = \?/.test(sql));
  assert.ok(deletingIndex >= 0 && deletingIndex < deleteRowIndex);
  assert.match(state.operations[deletingIndex][1], /file_key = \?.*updated_at = \?/s);
});

test("delete treats lost mark, OPFS, row responses and a failed broadcast as durable success", async () => {
  const source = pngFile("venue.png");
  const metadata = {
    version: 1,
    namespace: "fitness",
    key: STORED_UUID,
    originalName: "venue.png",
    mimeType: "image/png",
    category: "fitness-file:fitness-file-existing",
    byteSize: source.size,
    sha256: await hashBlob(source),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stagingOwner: OWNER_A,
  };
  const record = row({ byte_size: source.size, sha256: metadata.sha256 });
  const { state, service } = await fixture({
    rows: [record],
    local: [{ metadata, file: source }],
    markDeleteMode: "response_loss",
    deleteOwnedMode: "response_loss",
    deleteRowMode: "response_loss",
    broadcastThrows: true,
  });
  const receipt = await service.prepareFitnessFileDelete(record.id);
  const result = await service.deleteFitnessFileSafely(receipt);
  assert.equal(result.outcome, "deleted");
  assert.equal(await service.inspectFitnessFileDelete(receipt), "absent");
  assert.equal(state.rows.size, 0);
  assert.equal(state.local.size, 0);
  assert.deepEqual(state.broadcasts, []);
});

test("stale full-row delete receipt cannot remove a concurrently edited or replacement row", async () => {
  const source = pngFile("venue.png");
  const metadata = {
    version: 1,
    namespace: "fitness",
    key: STORED_UUID,
    originalName: "venue.png",
    mimeType: "image/png",
    category: "fitness-file:fitness-file-existing",
    byteSize: source.size,
    sha256: await hashBlob(source),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stagingOwner: OWNER_A,
  };
  const record = row({ byte_size: source.size, sha256: metadata.sha256 });
  const edited = await fixture({ rows: [record], local: [{ metadata, file: source }] });
  const editedReceipt = await edited.service.prepareFitnessFileDelete(record.id);
  edited.state.rows.set(record.id, { ...record, updated_at: record.updated_at + 1 });
  assert.equal(
    (await edited.service.deleteFitnessFileSafely(editedReceipt)).outcome,
    "conflict",
  );
  assert.equal(edited.state.rows.get(record.id).status, "ready");
  assert.equal(edited.state.local.has(STORED_UUID), true);
  assert.equal(edited.state.deletedKeys.length, 0);

  const replaced = await fixture({ rows: [record], local: [{ metadata, file: source }] });
  const replacedReceipt = await replaced.service.prepareFitnessFileDelete(record.id);
  replaced.state.rows.set(record.id, {
    ...record,
    file_key: FOURTH_UUID,
    file_name: "new.png",
    sha256: "c".repeat(64),
    updated_at: record.updated_at + 2,
  });
  assert.equal(
    (await replaced.service.deleteFitnessFileSafely(replacedReceipt)).outcome,
    "conflict",
  );
  assert.equal(replaced.state.local.has(STORED_UUID), true);
  assert.equal(replaced.state.deletedKeys.length, 0);
});

test("foreign metadata at the shared delete key is retained even when bytes and row fields match", async () => {
  const source = pngFile("venue.png");
  const metadata = {
    version: 1,
    namespace: "fitness",
    key: STORED_UUID,
    originalName: "venue.png",
    mimeType: "image/png",
    category: "fitness-file:fitness-file-existing",
    byteSize: source.size,
    sha256: await hashBlob(source),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stagingOwner: OWNER_A,
  };
  const record = row({ byte_size: source.size, sha256: metadata.sha256 });
  const { state, service } = await fixture({ rows: [record], local: [{ metadata, file: source }] });
  const receipt = await service.prepareFitnessFileDelete(record.id);
  state.local.set(STORED_UUID, {
    metadata: { ...metadata, stagingOwner: OWNER_B },
    file: source,
  });
  const result = await service.deleteFitnessFileSafely(receipt);
  assert.equal(result.outcome, "conflict");
  assert.equal(state.rows.get(record.id).status, "ready");
  assert.equal(state.local.has(STORED_UUID), true);
  assert.equal(state.deletedKeys.length, 0);
});

test("generation switch blocks delete before the full-row CAS", async () => {
  const source = pngFile("venue.png");
  const metadata = {
    version: 1,
    namespace: "fitness",
    key: STORED_UUID,
    originalName: "venue.png",
    mimeType: "image/png",
    category: "fitness-file:fitness-file-existing",
    byteSize: source.size,
    sha256: await hashBlob(source),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stagingOwner: OWNER_A,
  };
  const record = row({ byte_size: source.size, sha256: metadata.sha256 });
  const { state, service } = await fixture({ rows: [record], local: [{ metadata, file: source }] });
  const receipt = await service.prepareFitnessFileDelete(record.id);
  state.generation = {
    ...state.generation,
    generationId: GENERATION_B,
    sequence: 2,
  };
  assert.equal(
    (await service.deleteFitnessFileSafely(receipt)).outcome,
    "conflict",
  );
  assert.equal(state.rows.get(record.id).status, "ready");
  assert.equal(state.local.has(STORED_UUID), true);
  assert.equal(state.operations.some(([, sql]) => /SET status = 'deleting'/.test(sql)), false);
});

test("list reconciliation adopts valid pending files, finishes deletes and preserves unknown OPFS files", async () => {
  const pendingSource = pngFile("待恢复.png");
  const pendingHash = await hashBlob(pendingSource);
  const pendingId = "fitness-file-pending";
  const pendingMetadata = {
    version: 1,
    namespace: "fitness",
    key: FIRST_UUID,
    originalName: "待恢复.png",
    mimeType: "image/png",
    category: `fitness-file:${pendingId}`,
    byteSize: pendingSource.size,
    sha256: pendingHash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const orphanSource = pngFile("orphan.png");
  const orphanMetadata = {
    ...pendingMetadata,
    key: SECOND_UUID,
    originalName: "orphan.png",
    category: "fitness-file:fitness-file-orphan",
    sha256: await hashBlob(orphanSource),
  };
  const unknownKey = "40000000-0000-4000-8000-000000000004";
  const unknownMetadata = {
    ...pendingMetadata,
    key: unknownKey,
    category: "personal-user-file",
  };
  const pending = row({
    id: pendingId,
    file_key: STORED_UUID,
    file_name: "pending.png",
    byte_size: 0,
    sha256: ZERO_SHA,
    status: "missing",
  });
  const deleting = row({
    id: "fitness-file-deleting",
    file_key: "50000000-0000-4000-8000-000000000005",
    status: "deleting",
  });
  const missingReady = row({
    id: "fitness-file-bytes-gone",
    file_key: "60000000-0000-4000-8000-000000000006",
  });
  const { state, service } = await fixture({
    rows: [pending, deleting, missingReady],
    local: [
      { metadata: pendingMetadata, file: pendingSource },
      { metadata: orphanMetadata, file: orphanSource },
      { metadata: unknownMetadata, file: pendingSource },
    ],
  });

  const records = await service.listFitnessFiles();
  assert.equal(state.lockCalls, 1);
  assert.equal(state.rows.get(pendingId).status, "ready");
  assert.equal(state.rows.get(pendingId).file_key, FIRST_UUID);
  assert.equal(state.rows.has(deleting.id), false);
  assert.equal(state.rows.get(missingReady.id).status, "missing");
  assert.equal(state.local.has(SECOND_UUID), false);
  assert.equal(state.local.has(unknownKey), true, "unknown complete user files must never be deleted");
  assert.ok(records.some((entry) => entry.id === pendingId && entry.status === "ready"));
  assert.deepEqual(state.broadcasts, ["fitness-files-reconciled"]);
});

test("refresh reconciliation retains receipt-owned stages and present deleting bytes", async () => {
  const source = pngFile("staged.png");
  const staged = await fixture();
  const input = {
    entityType: "venue",
    entityId: "venue-1",
    purpose: "photo",
    file: source,
  };
  const receipt = await staged.service.prepareFitnessFileSave(input);
  stageReceiptFile(staged.state, receipt, source);
  assert.deepEqual(await staged.service.listFitnessFiles(), []);
  assert.equal(staged.state.local.has(receipt.expectedFile.key), true);
  assert.equal(staged.state.deletedKeys.length, 0);

  const metadata = {
    version: 1,
    namespace: "fitness",
    key: STORED_UUID,
    originalName: "venue.png",
    mimeType: "image/png",
    category: "fitness-file:fitness-file-existing",
    byteSize: source.size,
    sha256: await hashBlob(source),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stagingOwner: OWNER_A,
  };
  const deleting = row({
    status: "deleting",
    file_name: metadata.originalName,
    byte_size: metadata.byteSize,
    sha256: metadata.sha256,
  });
  const inProgress = await fixture({
    rows: [deleting],
    local: [{ metadata, file: source }],
  });
  const records = await inProgress.service.listFitnessFiles();
  assert.ok(records.some((entry) => entry.id === deleting.id && entry.status === "deleting"));
  assert.equal(inProgress.state.rows.has(deleting.id), true);
  assert.equal(inProgress.state.local.has(STORED_UUID), true);
  assert.equal(inProgress.state.deletedKeys.length, 0);
});

test("blob reads verify stored bytes and mark a corrupt ready reference missing without deleting it", async () => {
  const source = pngFile("venue.png");
  const metadata = {
    version: 1,
    namespace: "fitness",
    key: STORED_UUID,
    originalName: "venue.png",
    mimeType: "image/png",
    category: "fitness-file:fitness-file-existing",
    byteSize: source.size,
    sha256: "b".repeat(64),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const record = row({ byte_size: source.size, sha256: metadata.sha256 });
  const { state, service } = await fixture({ rows: [record], local: [{ metadata, file: source }] });

  await assert.rejects(
    service.getFitnessFileBlob(record.id),
    (error) => error.code === "FILE_INTEGRITY_MISMATCH",
  );
  assert.equal(state.rows.get(record.id).status, "missing");
  assert.equal(state.local.has(STORED_UUID), true);
  assert.deepEqual(state.broadcasts, ["fitness-file-missing"]);
});
