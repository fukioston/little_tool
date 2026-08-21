import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const sourceUrl = new URL("../app/fitness/file-operation-journal.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");

class MemoryStorage {
  #values = new Map();

  get length() { return this.#values.size; }
  key(index) { return [...this.#values.keys()][index] ?? null; }
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

class SerialLocks {
  #tails = new Map();

  request(name, operation) {
    const previous = this.#tails.get(name) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    this.#tails.set(name, result.catch(() => undefined));
    return result;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function receipt(operationId, kind = "fitness-file-save", entityId = "equipment-1") {
  return {
    operationId,
    kind,
    expectedRow: {
      entity_type: "equipment",
      entity_id: entityId,
      purpose: "photo",
    },
  };
}

async function loadJournal() {
  const withoutImport = source.replace(/^import \{[\s\S]*?\} from "@\/lib\/fitness\/files";\n/, `
    const isFitnessFileSaveReceipt = (value) => Boolean(
      value && value.kind === "fitness-file-save" && typeof value.operationId === "string"
    );
    const isFitnessFileDeleteReceipt = (value) => Boolean(
      value && value.kind === "fitness-file-delete" && typeof value.operationId === "string"
    );
  `);
  const result = ts.transpileModule(withoutImport, {
    fileName: "file-operation-journal.ts",
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  assert.deepEqual(
    (result.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error),
    [],
  );
  return import(`data:text/javascript;base64,${Buffer.from(result.outputText).toString("base64")}#${crypto.randomUUID()}`);
}

const journal = await loadJournal();

test("file sizes never invent one kilobyte for an unknown legacy value", () => {
  assert.equal(journal.formatFitnessFileByteSize(0), "大小未记录");
  assert.equal(journal.formatFitnessFileByteSize(null), "大小未记录");
  assert.equal(journal.formatFitnessFileByteSize(Number.NaN), "大小未记录");
  assert.equal(journal.formatFitnessFileByteSize(512), "512 B");
  assert.equal(journal.formatFitnessFileByteSize(1536), "1.5 KB");
});

test("tickets bind exact outer fields, operation keys, and equipment-photo scope", () => {
  const save = journal.createFitnessFileSaveTicket(
    receipt("11111111-1111-4111-8111-111111111111"),
    "2026-08-22T00:00:00.000Z",
  );
  assert.equal(journal.isFitnessFileOperationTicket(save), true);
  assert.equal(journal.isFitnessFileOperationTicket({ ...save, extra: true }), false);
  assert.equal(journal.isFitnessFileOperationTicket({
    ...save,
    receipt: receipt(save.receipt.operationId, "fitness-file-save", ""),
  }), true, "the backend receipt guard remains authoritative for identifier structure");
  assert.equal(journal.isFitnessFileOperationTicket({
    ...save,
    receipt: { ...save.receipt, expectedRow: { ...save.receipt.expectedRow, entity_type: "venue" } },
  }), false);
  assert.equal(
    journal.fitnessFileOperationKey(save),
    `${journal.FITNESS_FILE_OPERATION_PREFIX}${save.receipt.operationId}`,
  );
});

test("independent operation keys survive together and exact CAS cannot erase a peer", () => {
  const storage = new MemoryStorage();
  const first = journal.createFitnessFileSaveTicket(
    receipt("11111111-1111-4111-8111-111111111111"),
    "2026-08-22T00:00:00.000Z",
  );
  const second = journal.createFitnessFileDeleteTicket(
    receipt("22222222-2222-4222-8222-222222222222", "fitness-file-delete"),
    "2026-08-22T00:00:01.000Z",
  );
  const firstEntry = journal.persistFitnessFileOperationToStorage(storage, first);
  const secondEntry = journal.persistFitnessFileOperationToStorage(storage, second);
  assert.notEqual(firstEntry.storageKey, secondEntry.storageKey);
  assert.deepEqual(
    journal.readFitnessFileOperationJournal(storage).entries.map((entry) => entry.ticket.kind),
    ["save-check", "delete-check"],
  );

  storage.setItem(firstEntry.storageKey, JSON.stringify({ replaced: true }));
  assert.equal(journal.removeFitnessFileOperationFromStorage(storage, firstEntry), false);
  assert.equal(storage.getItem(secondEntry.storageKey), secondEntry.raw);
  assert.equal(journal.removeFitnessFileOperationFromStorage(storage, secondEntry), true);
});

test("a damaged ticket stays visible without hiding a valid independent receipt", () => {
  const storage = new MemoryStorage();
  const valid = journal.createFitnessFileSaveTicket(
    receipt("33333333-3333-4333-8333-333333333333"),
    "2026-08-22T00:00:00.000Z",
  );
  journal.persistFitnessFileOperationToStorage(storage, valid);
  storage.setItem(`${journal.FITNESS_FILE_OPERATION_PREFIX}damaged`, "{not-json");
  const result = journal.readFitnessFileOperationJournal(storage);
  assert.equal(result.unavailable, false);
  assert.equal(result.entries.length, 1);
  assert.equal(result.unreadable.length, 1);
});

test("storage failures are explicit and a failed checkpoint is not accepted", () => {
  const ticket = journal.createFitnessFileSaveTicket(
    receipt("44444444-4444-4444-8444-444444444444"),
    "2026-08-22T00:00:00.000Z",
  );
  const unavailable = {
    get length() { throw new Error("blocked"); },
    key() { return null; },
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.equal(journal.readFitnessFileOperationJournal(unavailable).unavailable, true);
  assert.throws(() => journal.persistFitnessFileOperationToStorage(unavailable, ticket));
});

test("the synchronous operation claim drops a same-tick double click", async () => {
  const operationRef = { current: null };
  const allowFirst = deferred();
  let backendCalls = 0;
  const click = async () => {
    const token = journal.claimFitnessFileOperation(operationRef);
    if (!token) return "ignored";
    try {
      backendCalls += 1;
      await allowFirst.promise;
      return "finished";
    } finally {
      journal.releaseFitnessFileOperation(operationRef, token);
    }
  };

  const first = click();
  const second = click();
  assert.equal(await second, "ignored");
  assert.equal(backendCalls, 1);
  allowFirst.resolve();
  assert.equal(await first, "finished");
  assert.equal(operationRef.current, null);
});

test("a delete continuation and keep choice serialize around raw CAS and the backend action", async () => {
  const storage = new MemoryStorage();
  const locks = new SerialLocks();
  const ticket = journal.createFitnessFileDeleteTicket(
    receipt("55555555-5555-4555-8555-555555555555", "fitness-file-delete"),
    "2026-08-22T00:00:00.000Z",
  );
  const entry = journal.persistFitnessFileOperationToStorage(storage, ticket);
  const deleteEntered = deferred();
  const allowDelete = deferred();
  let deleteCalls = 0;
  let keepCalls = 0;

  const deleting = journal.runWithCurrentFitnessFileOperation(entry, async (lease) => {
    deleteCalls += 1;
    deleteEntered.resolve();
    await allowDelete.promise;
    lease.committed();
  }, { storage, locks });
  await deleteEntered.promise;
  const keeping = journal.runWithCurrentFitnessFileOperation(entry, (lease) => {
    keepCalls += 1;
    lease.remove();
  }, { storage, locks });
  allowDelete.resolve();

  const [deleteResult, keepResult] = await Promise.all([deleting, keeping]);
  assert.equal(deleteResult.outcome, "ran");
  assert.equal(deleteResult.entry.ticket.kind, "delete-committed");
  assert.equal(keepResult.outcome, "stale");
  assert.equal(deleteCalls, 1);
  assert.equal(keepCalls, 0, "the old keep button cannot claim the photo remains after delete won");

  const secondTicket = journal.createFitnessFileDeleteTicket(
    receipt("66666666-6666-4666-8666-666666666666", "fitness-file-delete"),
    "2026-08-22T00:00:01.000Z",
  );
  const secondEntry = journal.persistFitnessFileOperationToStorage(storage, secondTicket);
  const keepEntered = deferred();
  const allowKeep = deferred();
  let losingDeleteCalls = 0;
  const keepFirst = journal.runWithCurrentFitnessFileOperation(secondEntry, async (lease) => {
    keepEntered.resolve();
    await allowKeep.promise;
    lease.remove();
  }, { storage, locks });
  await keepEntered.promise;
  const deleteSecond = journal.runWithCurrentFitnessFileOperation(secondEntry, () => {
    losingDeleteCalls += 1;
  }, { storage, locks });
  allowKeep.resolve();

  assert.equal((await keepFirst).outcome, "ran");
  assert.equal((await deleteSecond).outcome, "stale");
  assert.equal(losingDeleteCalls, 0, "deletion cannot start after keep removed the exact ticket");
});

test("save resume and discard choices use the same per-entry latch", async () => {
  const storage = new MemoryStorage();
  const locks = new SerialLocks();
  const ticket = journal.createFitnessFileSaveTicket(
    receipt("77777777-7777-4777-8777-777777777777"),
    "2026-08-22T00:00:00.000Z",
  );
  const entry = journal.persistFitnessFileOperationToStorage(storage, ticket);
  const resumeEntered = deferred();
  const allowResume = deferred();
  let discardCalls = 0;
  const resume = journal.runWithCurrentFitnessFileOperation(entry, async (lease) => {
    resumeEntered.resolve();
    await allowResume.promise;
    lease.committed();
  }, { storage, locks });
  await resumeEntered.promise;
  const discard = journal.runWithCurrentFitnessFileOperation(entry, (lease) => {
    discardCalls += 1;
    lease.remove();
  }, { storage, locks });
  allowResume.resolve();

  assert.equal((await resume).entry.ticket.kind, "save-committed");
  assert.equal((await discard).outcome, "stale");
  assert.equal(discardCalls, 0);
});

test("missing Web Locks fails closed before any backend callback", async () => {
  const storage = new MemoryStorage();
  const ticket = journal.createFitnessFileSaveTicket(
    receipt("88888888-8888-4888-8888-888888888888"),
    "2026-08-22T00:00:00.000Z",
  );
  const entry = journal.persistFitnessFileOperationToStorage(storage, ticket);
  let backendCalls = 0;
  await assert.rejects(
    journal.runWithCurrentFitnessFileOperation(entry, () => {
      backendCalls += 1;
    }, { storage, locks: null }),
    /无法跨页面锁定|无法安全协调/,
  );
  assert.equal(backendCalls, 0);
  assert.equal(storage.getItem(entry.storageKey), entry.raw);
});
