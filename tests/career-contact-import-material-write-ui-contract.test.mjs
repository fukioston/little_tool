import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const root = new URL("../", import.meta.url);
const journalUrl = new URL(
  "app/career/contact-import-material-write-journal.ts",
  root,
);
const flowUrl = new URL(
  "app/career/CareerContactImportMaterialWriteFlow.tsx",
  root,
);
const stateUrl = new URL(
  "app/career/contact-import-material-write-state.ts",
  root,
);
const adapterUrl = new URL(
  "app/career/contact-import-material-write-adapter.ts",
  root,
);
const appUrl = new URL("app/career/CareerApp.tsx", root);
const dbUrl = new URL("lib/career/db.ts", root);
const contactWritesUrl = new URL("lib/career/contact-writes.ts", root);
const importWritesUrl = new URL("lib/career/import-writes.ts", root);
const materialWritesUrl = new URL("lib/career/material-writes.ts", root);
const [journalSource, flowSource, stateSource, adapterSource, appSource,
  dbSource, contactWritesSource, importWritesSource, materialWritesSource] =
  await Promise.all([
    readFile(journalUrl, "utf8"),
    readFile(flowUrl, "utf8"),
    readFile(stateUrl, "utf8"),
    readFile(adapterUrl, "utf8"),
    readFile(appUrl, "utf8"),
    readFile(dbUrl, "utf8"),
    readFile(contactWritesUrl, "utf8"),
    readFile(importWritesUrl, "utf8"),
    readFile(materialWritesUrl, "utf8"),
  ]);

function transpile(source, fileName) {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  assert.deepEqual(
    (result.diagnostics ?? []).filter(({ category }) =>
      category === ts.DiagnosticCategory.Error),
    [],
  );
  return result.outputText;
}

let executable = transpile(journalSource, journalUrl.pathname);
executable = executable
  .replace(
    'import { isCareerContactWriteReceipt, } from "@/lib/career/contact-writes";',
    `const isCareerContactWriteReceipt=(v)=>v?.purpose==="career-contact-write";`,
  )
  .replace(
    'import { isCareerImportWriteReceipt, } from "@/lib/career/import-writes";',
    `const isCareerImportWriteReceipt=(v)=>v?.purpose==="career-import-write";`,
  )
  .replace(
    'import { isCareerMaterialFileCleanupReceipt, } from "@/lib/career/material-write-files";',
    `const isCareerMaterialFileCleanupReceipt=(v)=>Boolean(v&&v.purpose==="career-material-cleanup"&&v.version===1&&/^[0-9a-f-]{36}$/.test(v.handle));`,
  )
  .replace(
    'import { isCareerMaterialWriteReceipt, } from "@/lib/career/material-writes";',
    `const isCareerMaterialWriteReceipt=(v)=>v?.purpose==="career-material-write";`,
  )
  .replace(
    'import { isCareerWriteOperationId } from "@/lib/career/write-marker";',
    `const isCareerWriteOperationId=(v,p)=>p==="career-material-write"&&/^career-material-operation-[0-9a-f-]{36}$/.test(v);`,
  )
  .replace(
    /import \{ CAREER_CONTACT_IMPORT_MATERIAL_WRITE_MAX_BYTES,[\s\S]*?\} from "\.\/core-write-journal";/,
    `const CAREER_CONTACT_IMPORT_MATERIAL_WRITE_MAX_BYTES=8388608;
     const CAREER_CONTACT_IMPORT_MATERIAL_WRITE_PREFIX="career.contact-import-material-write.v1:";
     const CAREER_CORE_WRITE_JOURNAL_LOCK="private-ai-suite:career:core-write-journal";
     const CAREER_CORE_WRITE_MAX_CHARS=1048576;
     const CAREER_CORE_WRITE_PREFIX="career.core-write.v1:";
     const CAREER_LIFECYCLE_TASK_WRITE_MAX_BYTES=8388608;
     const CAREER_LIFECYCLE_TASK_WRITE_PREFIX="career.lifecycle-task-write.v1:";`,
  );
assert.doesNotMatch(executable, /^import /m);
const journal = await import(
  `data:text/javascript;base64,${Buffer.from(executable).toString("base64")}`
);

function memoryStorage(initial = []) {
  const values = new Map(initial);
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
    values,
  };
}

function lockManager() {
  const tails = new Map();
  return {
    request(name, task) {
      const previous = tails.get(name) ?? Promise.resolve();
      const run = previous.then(task, task);
      tails.set(name, run.then(() => undefined, () => undefined));
      return run;
    },
  };
}

const UUID = "30000000-0000-4000-8000-000000000001";
const OPERATION = `career-material-operation-${UUID}`;
const CLEANUP = {
  purpose: "career-material-cleanup",
  version: 1,
  handle: "40000000-0000-4000-8000-000000000002",
};

function materialReceipt() {
  return {
    purpose: "career-material-write",
    version: 1,
    kind: "material-save",
    operationId: OPERATION,
    after: {
      material: { id: "material-a" },
      cleanupReceipt: CLEANUP,
    },
  };
}

test("cleanup tickets are exact, opaque-handle-only, and key-bound", () => {
  const ticket = journal.createCareerMaterialCleanupWriteTicket({
    operationId: OPERATION,
    materialId: "material-a",
    cleanupReceipt: CLEANUP,
  }, "2026-08-22T03:04:05.000Z");
  assert.equal(journal.isCareerContactImportMaterialWriteTicket(ticket), true);
  assert.equal(
    journal.isCareerContactImportMaterialWriteTicket({ ...ticket, extra: true }),
    false,
  );
  assert.equal(
    journal.careerContactImportMaterialWriteKey(ticket),
    `${journal.CAREER_CONTACT_IMPORT_MATERIAL_WRITE_PREFIX}${OPERATION}`,
  );
  const raw = JSON.stringify(ticket);
  assert.match(raw, new RegExp(CLEANUP.handle));
  assert.doesNotMatch(raw, /file_key|stagedFile|payload|base64/i);
  assert.doesNotMatch(journalSource, /\batob\b|\bbtoa\b|file_key/);
});

test("one outer lease checkpoints cleanup then raw-CAS promotes the exact receipt", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const result = await journal.runWithEmptyCareerContactImportMaterialWrite(
    async (lease) => {
      const cleanup = lease.checkpointCleanup({
        operationId: OPERATION,
        materialId: "material-a",
        cleanupReceipt: CLEANUP,
      });
      assert.equal(JSON.parse(storage.getItem(cleanup.storageKey)).kind, "material-cleanup");
      const promoted = lease.promote(materialReceipt());
      assert.equal(JSON.parse(storage.getItem(promoted.storageKey)).kind, "check");
      return "prepared";
    },
    { storage, locks },
  );
  assert.equal(result.outcome, "ran");
  assert.equal(result.value, "prepared");
  assert.equal(result.entry.ticket.receipt.operationId, OPERATION);
});

test("cleanup survives response loss and a pending main finalize remains durable", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  await assert.rejects(
    journal.runWithEmptyCareerContactImportMaterialWrite(
      (lease) => {
        lease.checkpointCleanup({
          operationId: OPERATION,
          materialId: "material-a",
          cleanupReceipt: CLEANUP,
        });
        throw new Error("prepare response lost");
      },
      { storage, locks },
    ),
    /response lost/,
  );
  let scan = journal.readCareerContactImportMaterialWriteJournal(storage, locks);
  assert.equal(scan.entries[0].ticket.kind, "material-cleanup");
  await journal.runWithCurrentCareerContactImportMaterialWrite(
    scan.entries[0],
    (lease) => lease.promote(materialReceipt()),
    { storage, locks },
  );
  scan = journal.readCareerContactImportMaterialWriteJournal(storage, locks);
  assert.equal(scan.entries[0].ticket.kind, "check");
  assert.equal(scan.entries.length, 1, "cleanup-pending main receipt must stay durable");
});

test("all three prefixes are scanned and no callback runs around a peer", async () => {
  const storage = memoryStorage([
    [`${journal.CAREER_CORE_WRITE_PREFIX}peer`, "{}"],
  ]);
  const locks = lockManager();
  let calls = 0;
  assert.deepEqual(
    await journal.runWithEmptyCareerContactImportMaterialWrite(
      () => { calls += 1; },
      { storage, locks },
    ),
    { outcome: "blocked", reason: "peer" },
  );
  assert.equal(calls, 0);
  storage.removeItem(`${journal.CAREER_CORE_WRITE_PREFIX}peer`);
  storage.setItem(`${journal.CAREER_LIFECYCLE_TASK_WRITE_PREFIX}peer`, "{}");
  assert.equal(
    journal.readCareerContactImportMaterialWriteJournal(storage, locks)
      .peerEntries.length,
    1,
  );
});

test("raw-CAS rejects stale promotion and missing locks run zero callbacks", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  await assert.rejects(
    journal.runWithEmptyCareerContactImportMaterialWrite(
      (lease) => {
        const entry = lease.checkpointCleanup({
          operationId: OPERATION,
          materialId: "material-a",
          cleanupReceipt: CLEANUP,
        });
        storage.setItem(entry.storageKey, `${entry.raw} `);
        lease.promote(materialReceipt());
      },
      { storage, locks },
    ),
    /另一页/,
  );
  let calls = 0;
  await assert.rejects(
    journal.runWithEmptyCareerContactImportMaterialWrite(
      () => { calls += 1; },
      { storage: memoryStorage(), locks: null },
    ),
    /无法跨页面锁定/,
  );
  assert.equal(calls, 0);
});

test("state, adapter, and Flow contracts keep exact ownership and lock order", () => {
  transpile(stateSource, stateUrl.pathname);
  transpile(adapterSource, adapterUrl.pathname);
  transpile(flowSource, flowUrl.pathname);
  assert.match(stateSource, /createCareerContactImportMaterialSettlementRegistry/);
  assert.match(stateSource, /owned\.get\(receipt\.operationId\) === ownershipKey\(receipt\)/);
  assert.match(stateSource, /createCareerContactImportMaterialReadEnvelope/);
  assert.match(flowSource, /runWithEmptyCareerContactImportMaterialWrite/);
  assert.match(flowSource, /onCleanupPrepared\(prepared\)[\s\S]*lease\.checkpointCleanup\(prepared\)/);
  assert.match(flowSource, /lease\.promote\(prepared\.receipt\)/);
  assert.match(flowSource, /materialWriteNeedsCleanup\(committed\)/);
  assert.match(flowSource, /window\.addEventListener\("beforeunload"/);
  assert.match(flowSource, /window\.addEventListener\("focus"/);
  assert.match(adapterSource, /prepareCareerMaterialDeleteWriteForUi/);
});

test("CareerApp routes every contact/import/material write through the unified Flow", () => {
  transpile(appSource, appUrl.pathname);
  for (const method of [
    "submitContactCreate",
    "submitContactUpdate",
    "submitContactArchive",
    "submitContactRestore",
    "submitContactInteraction",
    "submitContactTask",
    "submitImport",
    "submitMaterialSave",
    "submitMaterialDelete",
  ]) {
    assert.match(appSource, new RegExp(`\\.${method}\\(`));
  }
  assert.match(appSource, /career-contact-import-material-recovery/);
  assert.match(appSource, /careerContactImportMaterialReadApplyDecision/);
  assert.match(appSource, /contactImportMaterialDirtyEditorsRef/);
  assert.match(appSource, /career-job-imported/);
  assert.match(appSource, /career-material-(?:saved|deleted)/);
  assert.doesNotMatch(appSource, /\b(?:commitCareerJobImports|saveCareerMaterial|deleteCareerMaterial|retryCareerMaterialSaveCleanup)\s*\(/);
  assert.doesNotMatch(appSource, /file_key|createLocalFileObjectUrl|opaquePayload/);
});

test("shared validators and material UI facades keep private keys below the UI boundary", () => {
  assert.match(contactWritesSource, /export function isCareerContactWriteReceipt/);
  assert.match(importWritesSource, /export function isCareerImportWriteReceipt/);
  assert.match(materialWritesSource, /export function isCareerMaterialWriteReceipt/);
  assert.match(materialWritesSource, /prepareCareerMaterialDeleteWriteForUi/);
  assert.match(materialWritesSource, /withCareerWritePrepareLock[\s\S]*prepareDeleteForUi/);
  assert.match(dbSource, /export async function loadCareerUiData/);
  assert.match(dbSource, /CASE WHEN file_key IS NULL THEN 0 ELSE 1 END AS has_attachment/);
  assert.match(dbSource, /export async function openCareerMaterialAttachmentById/);
  assert.match(dbSource, /SELECT file_key FROM career_materials WHERE id = \?/);
});
