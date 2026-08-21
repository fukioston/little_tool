import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const SHLN = 0x53484c4e;
const GENERATION_ID = "30000000-0000-4000-8000-000000000001";
const ACTIVATION_TOKEN = "a".repeat(64);
const NOW = new Date("2026-08-21T08:09:10.000Z");
const entityTypes = ["venue", "equipment", "exercise", "session"];

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
  transpile("lib/schemas/shilian.ts"),
  transpile("lib/fitness/backup-format.ts"),
  transpile("lib/fitness/backup-plan.ts"),
  transpile("lib/fitness/backup.ts"),
]);
const schemaUrl = moduleUrl(schemaJavaScript);
const formatUrl = moduleUrl(formatJavaScript);
const planJavaScript = rawPlanJavaScript.replace(
  /from\s+["']\.\.\/schemas\/shilian["'];/,
  `from ${JSON.stringify(schemaUrl)};`,
);
assert.notEqual(planJavaScript, rawPlanJavaScript, "Fitness plan schema import was not linked");
const planUrl = moduleUrl(planJavaScript);
const dependencies = {
  "@/lib/local-db/client": moduleUrl("export const localDb = {};"),
  "@/lib/local-db/files": moduleUrl(`
    export async function deleteLocalFile(){ throw new Error("default runtime not used"); }
    export async function getLocalFile(){ throw new Error("default runtime not used"); }
    export async function saveLocalFile(){ throw new Error("default runtime not used"); }
    export async function sha256Blob(blob){
      const digest=await crypto.subtle.digest("SHA-256",await blob.arrayBuffer());
      return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
    }
  `),
  "./backup-format": formatUrl,
  "./backup-plan": planUrl,
  "./lock": moduleUrl(`
    export function broadcastFitnessChange(){}
    export function withFitnessWriteLock(task){ return task(); }
  `),
};
let serviceJavaScript = rawServiceJavaScript;
for (const [specifier, url] of Object.entries(dependencies)) {
  serviceJavaScript = serviceJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const [format, backup] = await Promise.all([
  import(formatUrl),
  import(moduleUrl(serviceJavaScript)),
]);

async function hashBlob(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Buffer.from(digest).toString("hex");
}

function sqliteBytes({ applicationId = SHLN, userVersion = 2 } = {}) {
  const bytes = new Uint8Array(512);
  bytes.set(new TextEncoder().encode("SQLite format 3\0"));
  const view = new DataView(bytes.buffer);
  view.setUint32(60, userVersion, false);
  view.setUint32(68, applicationId, false);
  return bytes;
}

function sourceKey(index) {
  return `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function stagedKey(index) {
  return `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

async function sourceFile(index = 0) {
  const entityType = entityTypes[index % entityTypes.length];
  const originalName = `Fitness ${index + 1}.webp`;
  const file = new File([`fitness payload ${index}`], originalName, {
    type: "image/webp",
  });
  const digest = await hashBlob(file);
  const createdAt = 1_777_000_000_000 + index;
  const updatedAt = 1_777_000_100_000 + index;
  const portable = {
    id: `file-${String(index + 1).padStart(3, "0")}`,
    entityType,
    entityId: `${entityType}-${String(index + 1).padStart(3, "0")}`,
    purpose: index % 2 === 0 ? "photo" : "instruction",
    key: sourceKey(index),
    originalName,
    mimeType: "image/webp",
    byteSize: file.size,
    sha256: digest,
    status: "ready",
    createdAt,
    updatedAt,
  };
  return {
    portable,
    row: {
      id: portable.id,
      entity_type: portable.entityType,
      entity_id: portable.entityId,
      purpose: portable.purpose,
      file_key: portable.key,
      file_name: portable.originalName,
      mime_type: portable.mimeType,
      byte_size: portable.byteSize,
      sha256: portable.sha256,
      status: portable.status,
      created_at: portable.createdAt,
      updated_at: portable.updatedAt,
    },
    metadata: {
      version: 1,
      namespace: "fitness",
      key: portable.key,
      originalName: portable.originalName,
      mimeType: portable.mimeType,
      category: `fitness:${portable.entityType}:${portable.purpose}`,
      byteSize: portable.byteSize,
      sha256: portable.sha256,
      createdAt: new Date(portable.createdAt).toISOString(),
      updatedAt: new Date(portable.updatedAt).toISOString(),
    },
    file,
  };
}

async function completeContainer(sources = []) {
  return format.createFitnessBackupBlob({
    database: sqliteBytes(),
    files: sources.map(({ portable, file }) => ({ metadata: portable, blob: file })),
    exportedAt: "2026-08-20T06:07:08.000Z",
  }, hashBlob);
}

async function legacyV1CompleteContainer() {
  const database = sqliteBytes({ userVersion: 1 });
  const unsigned = {
    format: "fitness-backup",
    version: 1,
    product: "shilian",
    exportedAt: "2026-08-20T06:07:08.000Z",
    database: {
      byteSize: database.byteLength,
      sha256: await hashBlob(new Blob([database])),
      applicationId: SHLN,
      userVersion: 1,
    },
    files: [],
  };
  const manifest = {
    ...unsigned,
    manifestSha256: await hashBlob(new Blob([
      new TextEncoder().encode(JSON.stringify(unsigned)),
    ])),
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const magic = new TextEncoder().encode(format.FITNESS_BACKUP_MAGIC);
  const prefix = new Uint8Array(magic.byteLength + 4);
  prefix.set(magic);
  new DataView(prefix.buffer).setUint32(magic.byteLength, manifestBytes.byteLength, false);
  return new Blob([prefix, manifestBytes, database], {
    type: format.FITNESS_BACKUP_MIME_TYPE,
  });
}

async function runtimeFixture(options = {}) {
  const {
    sourceCount = 1,
    queryRows,
    ...overrides
  } = options;
  const sources = await Promise.all(
    Array.from({ length: sourceCount }, (_, index) => sourceFile(index)),
  );
  const byKey = new Map(sources.map((source) => [source.portable.key, source]));
  const state = {
    events: [],
    lockCalls: 0,
    queries: [],
    readKeys: [],
    exported: 0,
    saved: [],
    deleted: [],
    staged: [],
    activated: [],
    currentChecks: 0,
    discarded: [],
    broadcasts: [],
  };
  const stagedResult = {
    database: "shilian",
    generationId: GENERATION_ID,
    filename: `shilian.${GENERATION_ID}.sqlite3`,
    activationToken: ACTIVATION_TOKEN,
    importedBytes: 512,
    schemaVersion: 2,
  };
  const runtime = {
    async withExclusiveLock(task) {
      state.lockCalls += 1;
      state.events.push("lock");
      return task();
    },
    async query(sql, params) {
      state.queries.push({ sql, params });
      return { rows: queryRows ?? sources.map(({ row }) => row) };
    },
    async exportDatabase() {
      state.exported += 1;
      return { data: sqliteBytes() };
    },
    async stageImport(database, statements) {
      state.events.push("stage-database");
      state.staged.push({ database, statements });
      return stagedResult;
    },
    async activateStaged(staged) {
      state.events.push("activate");
      state.activated.push(staged);
    },
    async currentGeneration() {
      state.currentChecks += 1;
      return {
        database: "shilian",
        generationId: "legacy",
        filename: "shilian.sqlite3",
        sequence: 0,
        legacy: true,
      };
    },
    async discardStaged(staged) {
      state.discarded.push(staged);
    },
    async getFile(key) {
      state.readKeys.push(key);
      const source = byKey.get(key);
      if (!source) throw new Error("unexpected file read");
      return { metadata: source.metadata, file: source.file };
    },
    async saveFile(blob, saveOptions) {
      const index = state.saved.length;
      const metadata = {
        version: 1,
        namespace: "fitness",
        key: stagedKey(index),
        originalName: saveOptions.originalName,
        mimeType: saveOptions.mimeType,
        category: saveOptions.category ?? null,
        byteSize: blob.size,
        sha256: await hashBlob(blob),
        createdAt: saveOptions.createdAt,
        updatedAt: saveOptions.updatedAt,
      };
      state.events.push(`save-${index}`);
      state.saved.push({ blob, options: saveOptions, metadata });
      return metadata;
    },
    async deleteFile(key) {
      state.deleted.push(key);
    },
    hashBlob,
    broadcastGenerationChanged(generationId) {
      state.broadcasts.push(generationId);
    },
    now() {
      return new Date(NOW);
    },
    ...overrides,
  };
  return { runtime, state, sources, stagedResult };
}

test("complete-backup detection is product-specific and does not need a lock", async () => {
  const blob = await completeContainer([]);
  assert.equal(await backup.isCompleteFitnessBackup(blob), true);
  assert.equal(await backup.isCompleteFitnessBackup(new Blob([sqliteBytes()])), false);
  assert.equal(
    await backup.isCompleteFitnessBackup(
      new Blob([new TextEncoder().encode("VOCAB-BACKUP\r\n\u001a")]),
    ),
    false,
  );
});

test("export is locked and truthfully emits zero ready files", async () => {
  const { runtime, state } = await runtimeFixture({ sourceCount: 0 });
  const result = await backup.createFitnessBackupService(runtime).exportCompleteBackup();
  const parsed = await format.parseFitnessBackupBlob(result.blob, hashBlob);

  assert.equal(state.lockCalls, 1);
  assert.equal(state.queries.length, 1);
  assert.match(state.queries[0].sql, /FROM fitness_files/);
  assert.match(state.queries[0].sql, /WHERE status='ready'/);
  assert.match(state.queries[0].sql, /ORDER BY file_key,id/);
  assert.deepEqual(state.readKeys, []);
  assert.equal(parsed.files.length, 0);
  assert.equal(result.fileCount, 0);
  assert.equal(result.fileName, "shilian-complete-2026-08-21.fitness-backup");
});

test("export includes every ready entity file with DB-authored metadata and real bytes", async () => {
  const { runtime, state, sources } = await runtimeFixture({ sourceCount: 4 });
  const result = await backup.createFitnessBackupService(runtime).exportCompleteBackup();
  const parsed = await format.parseFitnessBackupBlob(result.blob, hashBlob);

  assert.equal(state.lockCalls, 1);
  assert.equal(state.exported, 1);
  assert.deepEqual(state.readKeys, sources.map(({ portable }) => portable.key));
  assert.deepEqual(
    parsed.files.map(({ metadata }) => metadata),
    sources.map(({ portable }) => portable),
  );
  assert.deepEqual(
    parsed.files.map(({ metadata }) => metadata.entityType),
    entityTypes,
  );
  for (const [index, file] of parsed.files.entries()) {
    assert.equal(await file.blob.text(), await sources[index].file.text());
  }
});

test("export rejects every DB/OPFS metadata mismatch and a changed real payload", async (t) => {
  const mismatchCases = [
    ["key", { key: stagedKey(0) }],
    ["name", { originalName: "wrong.webp" }],
    ["MIME", { mimeType: "image/png" }],
    ["size", { byteSize: 999 }],
    ["SHA", { sha256: "f".repeat(64) }],
    ["namespace", { namespace: "vocab" }],
  ];
  for (const [label, metadataChange] of mismatchCases) {
    await t.test(label, async () => {
      const { runtime, state, sources } = await runtimeFixture({ sourceCount: 1 });
      runtime.getFile = async (key) => {
        state.readKeys.push(key);
        return {
          metadata: { ...sources[0].metadata, ...metadataChange },
          file: sources[0].file,
        };
      };
      await assert.rejects(
        backup.createFitnessBackupService(runtime).exportCompleteBackup(),
        /数据库索引与本地原件不一致/,
      );
      assert.equal(state.exported, 0);
    });
  }

  await t.test("real payload digest", async () => {
    const { runtime, state, sources } = await runtimeFixture({ sourceCount: 1 });
    const original = sources[0];
    const text = await original.file.text();
    const changed = new File(
      [`${text.slice(0, -1)}x`],
      original.file.name,
      { type: original.file.type },
    );
    assert.equal(changed.size, original.file.size);
    runtime.getFile = async () => ({ metadata: original.metadata, file: changed });
    await assert.rejects(
      backup.createFitnessBackupService(runtime).exportCompleteBackup(),
      /真实内容校验失败/,
    );
    assert.equal(state.exported, 0);
  });
});

test("complete restore stages all authenticated files, remaps, activates, and broadcasts", async () => {
  const { runtime, state, sources } = await runtimeFixture({ sourceCount: 4 });
  const container = await completeContainer(sources);
  const result = await backup.createFitnessBackupService(runtime)
    .restoreCompleteBackup(container);

  assert.equal(state.lockCalls, 1);
  assert.equal(state.saved.length, 4);
  assert.equal(state.staged.length, 1);
  assert.equal(state.activated.length, 1);
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.broadcasts, [GENERATION_ID]);
  assert.equal(result.fileCount, 4);
  assert.equal(result.exportedAt, "2026-08-20T06:07:08.000Z");
  assert.deepEqual(
    state.saved.map(({ options }) => options.category),
    sources.map(({ portable }) => `fitness-file:${portable.id}`),
  );
  assert.deepEqual(
    state.events.slice(0, 6),
    ["lock", "save-0", "save-1", "save-2", "save-3", "stage-database"],
  );
  const params = state.staged[0].statements.flatMap(({ params = [] }) =>
    Array.isArray(params) ? params : Object.values(params));
  for (let index = 0; index < sources.length; index += 1) {
    assert.ok(params.includes(sourceKey(index)));
    assert.ok(params.includes(stagedKey(index)));
  }
  assert.ok(state.staged[0].statements.some(({ sql }) =>
    sql.includes("UPDATE fitness_files")
  ));
});

test("complete v1 container is authenticated then staged with the fixed v2 migration", async () => {
  const { runtime, state } = await runtimeFixture({ sourceCount: 0 });
  await backup.createFitnessBackupService(runtime)
    .restoreCompleteBackup(await legacyV1CompleteContainer());

  assert.equal(state.staged.length, 1);
  assert.ok(state.staged[0].statements.some(({ sql }) =>
    sql.includes("occurrence_key")
  ));
  assert.ok(state.staged[0].statements.some(({ sql, params = [] }) =>
    sql.includes("fitness_schema_migrations") &&
    Array.isArray(params) &&
    params.includes(2) &&
    params.includes("calendar-occurrence-identity")
  ));
  assert.deepEqual(state.broadcasts, [GENERATION_ID]);
});

test("a corrupt complete container fails before lock, save, or database staging", async () => {
  const { runtime, state, sources } = await runtimeFixture();
  const valid = await completeContainer(sources);
  const corrupt = new Uint8Array(await valid.arrayBuffer());
  corrupt[corrupt.length - 1] ^= 0xff;

  await assert.rejects(
    backup.createFitnessBackupService(runtime)
      .restoreCompleteBackup(new Blob([corrupt])),
    (error) => error?.code === "FILE_HASH_MISMATCH",
  );
  assert.equal(state.lockCalls, 0);
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.staged, []);
  assert.deepEqual(state.events, []);
});

test("definite activation failure discards candidate and every staged file", async () => {
  const { runtime, state, sources } = await runtimeFixture({
    sourceCount: 2,
    async activateStaged(staged) {
      state.activated.push(staged);
      throw new Error("pointer write failed");
    },
  });
  await assert.rejects(
    backup.createFitnessBackupService(runtime)
      .restoreCompleteBackup(await completeContainer(sources)),
    /pointer write failed/,
  );
  assert.equal(state.discarded.length, 1);
  assert.deepEqual(state.deleted.sort(), [stagedKey(0), stagedKey(1)]);
  assert.deepEqual(state.broadcasts, []);
});

test("lost activation response is accepted when the Fitness candidate is current", async () => {
  const { runtime, state, sources } = await runtimeFixture({
    async activateStaged(staged) {
      state.activated.push(staged);
      throw new Error("response lost");
    },
    async currentGeneration() {
      state.currentChecks += 1;
      return {
        database: "shilian",
        generationId: GENERATION_ID,
        filename: `shilian.${GENERATION_ID}.sqlite3`,
        sequence: 2,
        legacy: false,
      };
    },
  });
  await backup.createFitnessBackupService(runtime)
    .restoreCompleteBackup(await completeContainer(sources));
  assert.equal(state.currentChecks, 1);
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.broadcasts, [GENERATION_ID]);
});

test("uncertain activation retains candidate and files and raises a dedicated error", async () => {
  const { runtime, state, sources } = await runtimeFixture({
    async activateStaged(staged) {
      state.activated.push(staged);
      throw new Error("worker disconnected");
    },
    async currentGeneration() {
      state.currentChecks += 1;
      throw new Error("worker unavailable");
    },
  });
  await assert.rejects(
    backup.createFitnessBackupService(runtime)
      .restoreCompleteBackup(await completeContainer(sources)),
    (error) => error instanceof backup.FitnessActivationUncertainError,
  );
  assert.equal(state.currentChecks, 1);
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.broadcasts, []);
});

test("candidate validation failure removes staged files while preserving the live generation", async () => {
  const { runtime, state, sources } = await runtimeFixture({
    async stageImport(database, statements) {
      state.staged.push({ database, statements });
      throw new Error("candidate schema rejected");
    },
  });
  await assert.rejects(
    backup.createFitnessBackupService(runtime)
      .restoreCompleteBackup(await completeContainer(sources)),
    /candidate schema rejected/,
  );
  assert.deepEqual(state.deleted, [stagedKey(0)]);
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.activated, []);
});

test("partially successful or metadata-corrupt OPFS writes are cleaned", async (t) => {
  await t.test("returned metadata is recorded before validation", async () => {
    const { runtime, state, sources } = await runtimeFixture({
      async saveFile(blob, saveOptions) {
        const bad = {
          version: 1,
          namespace: "fitness",
          key: stagedKey(0),
          originalName: saveOptions.originalName,
          mimeType: saveOptions.mimeType,
          category: saveOptions.category,
          byteSize: blob.size,
          sha256: "f".repeat(64),
          createdAt: saveOptions.createdAt,
          updatedAt: saveOptions.updatedAt,
        };
        state.saved.push({ blob, options: saveOptions, metadata: bad });
        return bad;
      },
    });
    await assert.rejects(
      backup.createFitnessBackupService(runtime)
        .restoreCompleteBackup(await completeContainer(sources)),
      /暂存文件.*校验失败/,
    );
    assert.deepEqual(state.deleted, [stagedKey(0)]);
    assert.deepEqual(state.staged, []);
  });

  await t.test("an earlier successful file is removed when the next save throws", async () => {
    const { runtime, state, sources } = await runtimeFixture({ sourceCount: 2 });
    let call = 0;
    runtime.saveFile = async (blob, saveOptions) => {
      if (call === 1) throw new Error("OPFS quota exhausted");
      const index = call;
      call += 1;
      const metadata = {
        version: 1,
        namespace: "fitness",
        key: stagedKey(index),
        originalName: saveOptions.originalName,
        mimeType: saveOptions.mimeType,
        category: saveOptions.category,
        byteSize: blob.size,
        sha256: await hashBlob(blob),
        createdAt: saveOptions.createdAt,
        updatedAt: saveOptions.updatedAt,
      };
      state.saved.push({ blob, options: saveOptions, metadata });
      return metadata;
    };
    await assert.rejects(
      backup.createFitnessBackupService(runtime)
        .restoreCompleteBackup(await completeContainer(sources)),
      /OPFS quota exhausted/,
    );
    assert.deepEqual(state.deleted, [stagedKey(0)]);
    assert.deepEqual(state.staged, []);
  });
});

test("wrong-product or malformed staged results are discarded before activation", async (t) => {
  for (const [label, change] of [
    ["database", { database: "zhiji" }],
    ["schema version", { schemaVersion: 1 }],
    ["byte count", { importedBytes: 1 }],
  ]) {
    await t.test(label, async () => {
      const { runtime, state, sources, stagedResult } = await runtimeFixture({
        async stageImport(database, statements) {
          state.staged.push({ database, statements });
          return { ...stagedResult, ...change };
        },
      });
      await assert.rejects(
        backup.createFitnessBackupService(runtime)
          .restoreCompleteBackup(await completeContainer(sources)),
        /另一个产品空间或版本/,
      );
      assert.equal(state.discarded.length, 1);
      assert.deepEqual(state.deleted, [stagedKey(0)]);
      assert.deepEqual(state.activated, []);
    });
  }
});

test("legacy restore accepts only exact SHLN v1/v2 identities before taking the lock", async () => {
  const { runtime, state } = await runtimeFixture({ sourceCount: 0 });
  const service = backup.createFitnessBackupService(runtime);

  for (const invalid of [
    sqliteBytes({ applicationId: 0 }),
    sqliteBytes({ userVersion: 0 }),
    sqliteBytes({ userVersion: 3 }),
    new Uint8Array(512),
    new Uint8Array(60),
  ]) {
    await assert.rejects(service.restoreLegacyDatabase(new Blob([invalid])));
  }
  assert.equal(state.lockCalls, 0);
  assert.deepEqual(state.staged, []);

  const v1Result = await service.restoreLegacyDatabase(
    new Blob([sqliteBytes({ userVersion: 1 })]),
  );
  const v2Result = await service.restoreLegacyDatabase(new Blob([sqliteBytes()]));
  assert.equal(v1Result.byteSize, 512);
  assert.equal(v2Result.byteSize, 512);
  assert.equal(state.lockCalls, 2);
  assert.equal(state.staged.length, 2);
  assert.ok(state.staged.every(({ statements }) => statements.some(({ sql }) =>
    sql.includes("DELETE FROM fitness_files")
  )));
  assert.ok(state.staged[0].statements.some(({ sql }) => sql.includes("occurrence_key")));
  assert.ok(!state.staged[1].statements.some(({ sql }) =>
    sql.includes("CREATE TEMP TABLE __fitness_calendar_events_v2_stage")
  ));
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.broadcasts, [GENERATION_ID, GENERATION_ID]);
});

test("broadcast failure cannot turn a durable activation into a destructive retry", async () => {
  const { runtime, state, sources } = await runtimeFixture({
    broadcastGenerationChanged() {
      throw new Error("BroadcastChannel closed");
    },
  });
  const result = await backup.createFitnessBackupService(runtime)
    .restoreCompleteBackup(await completeContainer(sources));
  assert.equal(result.fileCount, 1);
  assert.equal(state.activated.length, 1);
  assert.deepEqual(state.discarded, []);
  assert.deepEqual(state.deleted, []);
});

test("default exported writes refuse to run without real Web Locks", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: undefined,
  });
  try {
    await assert.rejects(
      backup.exportCompleteFitnessBackup(),
      /不支持安全的跨标签页备份锁/,
    );
    await assert.rejects(
      backup.restoreLegacyFitnessDatabase(new Blob([sqliteBytes()])),
      /不支持安全的跨标签页备份锁/,
    );
  } finally {
    if (descriptor) Object.defineProperty(navigator, "locks", descriptor);
    else delete navigator.locks;
  }
});
