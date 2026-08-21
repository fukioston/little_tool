import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const ZERO_SHA = "0".repeat(64);
const FIRST_UUID = "10000000-0000-4000-8000-000000000001";
const SECOND_UUID = "20000000-0000-4000-8000-000000000002";
const STORED_UUID = "30000000-0000-4000-8000-000000000003";

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
    export async function deleteLocalFile(){ throw new Error("default runtime not used"); }
    export async function getLocalFile(){ throw new Error("default runtime not used"); }
    export async function listLocalFiles(){ throw new Error("default runtime not used"); }
    export async function saveLocalFile(){ throw new Error("default runtime not used"); }
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
    uuidQueue: [...(options.uuidQueue ?? [FIRST_UUID, SECOND_UUID, STORED_UUID])],
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
        const [id, entityType, entityId, purpose, key, name, mime, size, sha, created, updated] = params;
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
          status: "missing",
          created_at: created,
          updated_at: updated,
        }));
        return { changes: 1 };
      }
      if (/SET file_key = \?, file_name = \?/.test(sql)) {
        if (options.failReadyUpdate) return { changes: 0 };
        const [key, name, mime, size, sha, updated, id] = params;
        const current = state.rows.get(id);
        if (!current) return { changes: 0 };
        state.rows.set(id, {
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
      if (/DELETE FROM fitness_files WHERE id = \? AND status = 'deleting'/.test(sql)) {
        const current = state.rows.get(params[0]);
        if (current?.status === "deleting") state.rows.delete(params[0]);
        return { changes: current ? 1 : 0 };
      }
      if (/SET status = 'deleting'/.test(sql)) {
        const current = state.rows.get(params[1]);
        if (current) state.rows.set(current.id, { ...current, status: "deleting", updated_at: params[0] });
        return { changes: current ? 1 : 0 };
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
      if (!found) throw new Error("FILE_BYTES_NOT_FOUND");
      return found;
    },
    async listFiles() {
      requireLock("listFiles");
      return [...state.local.values()].map(({ metadata }) => metadata);
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
    now() {
      state.now += 1;
      return state.now;
    },
    broadcast(reason) {
      requireLock("broadcast");
      state.broadcasts.push(reason);
    },
  };
  return { state, runtime, service: files.createFitnessFileService(runtime) };
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

test("persists a pending row first, then records only OPFS-derived size, hash, name and MIME", async () => {
  const { state, service } = await fixture();
  const source = pngFile("器械 正面.png");
  const saved = await service.saveFitnessFile({
    entityType: "equipment",
    entityId: "equipment-1",
    purpose: "photo",
    file: source,
  });
  const expectedHash = await hashBlob(source);

  assert.equal(state.lockCalls, 1);
  assert.equal(saved.status, "ready");
  assert.equal(saved.file_name, "器械 正面.png");
  assert.equal(saved.mime_type, "image/png");
  assert.equal(saved.byte_size, source.size);
  assert.equal(saved.sha256, expectedHash);
  assert.deepEqual(state.broadcasts, ["fitness-file-saved"]);
  const insert = state.operations.find(([, sql]) => /INSERT INTO fitness_files/.test(sql));
  assert.equal(insert[2][7], 0);
  assert.equal(insert[2][8], ZERO_SHA);
  const stored = state.local.get(saved.file_key);
  assert.equal(stored.metadata.category, `fitness-file:${saved.id}`);
  assert.equal(state.rows.get(saved.id).status, "ready");
});

test("cleans both the completed OPFS object and pending row when final activation fails", async () => {
  const { state, service } = await fixture({ failReadyUpdate: true });
  await assert.rejects(
    service.saveFitnessFile({
      entityType: "venue",
      entityId: "venue-1",
      purpose: "photo",
      file: pngFile(),
    }),
    (error) => error.code === "PENDING_ROW_CHANGED",
  );
  assert.equal(state.local.size, 0);
  assert.equal(state.rows.size, 0);
  assert.equal(state.deletedKeys.length, 1);
  assert.deepEqual(state.broadcasts, []);
});

test("deletion is a deleting-to-OPFS-to-row transition and is idempotent", async () => {
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
  };
  const record = row({ byte_size: source.size, sha256: metadata.sha256 });
  const { state, service } = await fixture({ rows: [record], local: [{ metadata, file: source }] });

  assert.equal(await service.deleteFitnessFile(record.id), true);
  assert.equal(await service.deleteFitnessFile(record.id), false);
  assert.equal(state.rows.size, 0);
  assert.equal(state.local.size, 0);
  assert.deepEqual(state.deletedKeys, [STORED_UUID]);
  assert.deepEqual(state.broadcasts, ["fitness-file-deleted"]);
  assert.equal(state.lockCalls, 2);
  const deletingIndex = state.operations.findIndex(([, sql]) => /SET status = 'deleting'/.test(sql));
  const deleteRowIndex = state.operations.findIndex(([, sql]) => /DELETE FROM fitness_files WHERE id = \? AND status = 'deleting'/.test(sql));
  assert.ok(deletingIndex >= 0 && deletingIndex < deleteRowIndex);
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
