import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const ZHIJI_APPLICATION_ID = 0x5a484a49;
const GENERATION_ID = "30000000-0000-4000-8000-000000000001";
const OLD_GENERATION_ID = "00000000-0000-4000-8000-000000000001";
const ACTIVATION_TOKEN = "a".repeat(64);
const SOURCE_KEY = "10000000-0000-4000-8000-000000000001";
const STAGED_KEY = "20000000-0000-4000-8000-000000000001";

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

const [
  schemaJavaScript,
  formatJavaScript,
  rawPlanJavaScript,
  rawServiceJavaScript,
] = await Promise.all([
  transpile("lib/schemas/zhiji.ts"),
  transpile("lib/career/backup-format.ts"),
  transpile("lib/career/backup-plan.ts"),
  transpile("lib/career/backup.ts"),
]);
const schemaUrl = moduleUrl(schemaJavaScript);
const formatUrl = moduleUrl(formatJavaScript);
const planJavaScript = rawPlanJavaScript.replace(
  /from\s+["']\.\.\/schemas\/zhiji["'];/,
  `from ${JSON.stringify(schemaUrl)};`,
);
assert.notEqual(planJavaScript, rawPlanJavaScript, "Career plan schema import was not linked");
const planUrl = moduleUrl(planJavaScript);

const clientUrl = moduleUrl(`
  function runtime(){
    const value=globalThis.__careerBackupServiceTestRuntime;
    if(!value) throw new Error("Career backup test runtime is missing");
    return value;
  }
  export const localDb={
    stageImport(database,bytes,statements,requirements){
      return runtime().stageImport(database,bytes,statements,requirements);
    },
    activateStaged(database,generationId,activationToken){
      return runtime().activateStaged(database,generationId,activationToken);
    },
    currentGeneration(database){ return runtime().currentGeneration(database); },
    discardStaged(database,generationId,activationToken){
      return runtime().discardStaged(database,generationId,activationToken);
    },
  };
`);
const filesUrl = moduleUrl(`
  function runtime(){
    const value=globalThis.__careerBackupServiceTestRuntime;
    if(!value) throw new Error("Career backup test runtime is missing");
    return value;
  }
  export function deleteLocalFile(database,key){
    return runtime().deleteLocalFile(database,key);
  }
  export function getLocalFile(database,key){
    return runtime().getLocalFile(database,key);
  }
  export function saveLocalFile(database,blob,options){
    return runtime().saveLocalFile(database,blob,options);
  }
  export async function sha256Blob(blob){
    const digest=await crypto.subtle.digest("SHA-256",await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
  }
`);
const lockUrl = moduleUrl(`
  function runtime(){
    const value=globalThis.__careerBackupServiceTestRuntime;
    if(!value) throw new Error("Career backup test runtime is missing");
    return value;
  }
  export function withCareerBackupLock(task){
    return runtime().withCareerBackupLock(task);
  }
  export function broadcastCareerGenerationChanged(generationId){
    return runtime().broadcastCareerGenerationChanged(generationId);
  }
`);
const dbUrl = moduleUrl(`
  export function exportCareerDb(){ throw new Error("export is outside this test boundary"); }
  export function loadCareerData(){ throw new Error("export is outside this test boundary"); }
`);
const dependencies = {
  "@/lib/local-db/client": clientUrl,
  "@/lib/local-db/files": filesUrl,
  "./backup-format": formatUrl,
  "./backup-plan": planUrl,
  "./db": dbUrl,
  "./lock": lockUrl,
};
let serviceJavaScript = rawServiceJavaScript;
for (const [specifier, url] of Object.entries(dependencies)) {
  serviceJavaScript = serviceJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const [format, backupService] = await Promise.all([
  import(formatUrl),
  import(moduleUrl(serviceJavaScript)),
]);

async function hashBlob(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Buffer.from(digest).toString("hex");
}

function sqliteBytes() {
  const bytes = new Uint8Array(512);
  bytes.set(new TextEncoder().encode("SQLite format 3\0"));
  const view = new DataView(bytes.buffer);
  view.setUint32(60, 3, false);
  view.setUint32(68, ZHIJI_APPLICATION_ID, false);
  return bytes;
}

async function completeContainer() {
  const file = new File(["private career material"], "resume.pdf", {
    type: "application/pdf",
  });
  return format.createCareerBackupBlob({
    database: sqliteBytes(),
    attachments: [{
      metadata: {
        key: SOURCE_KEY,
        originalName: file.name,
        mimeType: file.type,
        category: "career-material:resume",
        byteSize: file.size,
        sha256: await hashBlob(file),
        createdAt: "2026-08-20T06:07:08.000Z",
        updatedAt: "2026-08-20T07:08:09.000Z",
      },
      blob: file,
    }],
    exportedAt: "2026-08-20T08:09:10.000Z",
  }, hashBlob);
}

async function runtimeFixture(overrides = {}) {
  const oldGeneration = {
    database: "zhiji",
    generationId: OLD_GENERATION_ID,
    filename: `zhiji.${OLD_GENERATION_ID}.sqlite3`,
    sequence: 1,
    legacy: false,
  };
  const nextGeneration = {
    database: "zhiji",
    generationId: GENERATION_ID,
    filename: `zhiji.${GENERATION_ID}.sqlite3`,
    sequence: 2,
    legacy: false,
  };
  const stagedResult = {
    database: "zhiji",
    generationId: GENERATION_ID,
    filename: `zhiji.${GENERATION_ID}.sqlite3`,
    activationToken: ACTIVATION_TOKEN,
    importedBytes: 512,
    schemaVersion: 3,
  };
  const state = {
    lockCalls: 0,
    saved: [],
    deleted: [],
    staged: [],
    activated: [],
    currentChecks: 0,
    current: oldGeneration,
    discarded: [],
    broadcasts: [],
  };
  const runtime = {
    async withCareerBackupLock(task) {
      state.lockCalls += 1;
      return task({ token: Symbol("career-backup-test"), mode: "exclusive" });
    },
    async saveLocalFile(database, blob, options) {
      const metadata = {
        version: 1,
        namespace: database,
        key: STAGED_KEY,
        originalName: options.originalName,
        mimeType: options.mimeType,
        category: options.category ?? null,
        byteSize: blob.size,
        sha256: await hashBlob(blob),
        createdAt: options.createdAt,
        updatedAt: options.updatedAt,
      };
      state.saved.push({ database, blob, options, metadata });
      return metadata;
    },
    async deleteLocalFile(database, key) {
      state.deleted.push({ database, key });
    },
    async getLocalFile() {
      throw new Error("export is outside this test boundary");
    },
    async stageImport(database, bytes, statements, requirements) {
      state.staged.push({ database, bytes, statements, requirements });
      return stagedResult;
    },
    async activateStaged(database, generationId, activationToken) {
      state.activated.push({ database, generationId, activationToken });
      state.current = nextGeneration;
    },
    async currentGeneration() {
      state.currentChecks += 1;
      return state.current;
    },
    async discardStaged(database, generationId, activationToken) {
      state.discarded.push({ database, generationId, activationToken });
    },
    broadcastCareerGenerationChanged(generationId) {
      state.broadcasts.push(generationId);
    },
    ...overrides,
  };
  globalThis.__careerBackupServiceTestRuntime = runtime;
  return { runtime, state, stagedResult, oldGeneration, nextGeneration };
}

test("broadcast failure is best-effort after durable Career activation", async () => {
  const fixture = await runtimeFixture({
    broadcastCareerGenerationChanged(generationId) {
      fixture.state.broadcasts.push(generationId);
      throw new Error("BroadcastChannel closed");
    },
  });

  const result = await backupService.restoreCompleteCareerBackup(
    await completeContainer(),
  );

  assert.equal(result.attachmentCount, 1);
  assert.equal(fixture.state.lockCalls, 1);
  assert.equal(fixture.state.activated.length, 1, "activation must never retry");
  assert.equal(fixture.state.current.generationId, GENERATION_ID);
  assert.deepEqual(fixture.state.broadcasts, [GENERATION_ID]);
  assert.deepEqual(fixture.state.discarded, []);
  assert.deepEqual(fixture.state.deleted, []);
  assert.equal(fixture.state.saved.length, 1);
  assert.equal(fixture.state.saved[0].metadata.key, STAGED_KEY);
});

test("lost activation response plus unreadable current generation stays uncertain", async () => {
  const fixture = await runtimeFixture();
  fixture.runtime.activateStaged = async (database, generationId, activationToken) => {
    fixture.state.activated.push({ database, generationId, activationToken });
    fixture.state.current = fixture.nextGeneration;
    throw new Error("activation response lost");
  };
  fixture.runtime.currentGeneration = async () => {
    fixture.state.currentChecks += 1;
    throw new Error("generation pointer temporarily unreadable");
  };

  await assert.rejects(
    backupService.restoreCompleteCareerBackup(await completeContainer()),
    (error) => error?.name === "CareerActivationUncertainError",
  );

  assert.equal(fixture.state.activated.length, 1);
  assert.equal(fixture.state.currentChecks, 1);
  assert.equal(fixture.state.current.generationId, GENERATION_ID);
  assert.deepEqual(fixture.state.broadcasts, []);
  assert.deepEqual(fixture.state.discarded, []);
  assert.deepEqual(fixture.state.deleted, []);
  assert.equal(fixture.state.saved.length, 1);
});

test("definite activation failure keeps the old generation and removes only staged data", async () => {
  const fixture = await runtimeFixture();
  fixture.runtime.activateStaged = async (database, generationId, activationToken) => {
    fixture.state.activated.push({ database, generationId, activationToken });
    throw new Error("pointer write failed");
  };

  await assert.rejects(
    backupService.restoreCompleteCareerBackup(await completeContainer()),
    /pointer write failed/,
  );

  assert.equal(fixture.state.activated.length, 1);
  assert.equal(fixture.state.currentChecks, 1);
  assert.equal(fixture.state.current.generationId, OLD_GENERATION_ID);
  assert.deepEqual(fixture.state.broadcasts, []);
  assert.equal(fixture.state.discarded.length, 1);
  assert.deepEqual(fixture.state.deleted, [{ database: "career", key: STAGED_KEY }]);
});
