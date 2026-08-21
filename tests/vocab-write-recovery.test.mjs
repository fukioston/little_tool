import assert from "node:assert/strict";
import { File } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function transpile(relativePath) {
  const source = await readFile(new URL(relativePath, projectRoot), "utf8");
  const result = ts.transpileModule(source, {
    fileName: relativePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  assert.deepEqual(
    (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  return result.outputText;
}

const fileStub = moduleUrl(`
  export class LocalFileError extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }
  globalThis.__TestLocalFileError = LocalFileError;
  export async function assertLocalFileKeyAvailable() { throw new Error("use injected runtime"); }
  export async function deleteOwnedLocalFile() { throw new Error("use injected runtime"); }
  export async function getLocalFile() { throw new Error("use injected runtime"); }
  export async function saveLocalFileAtKey() { throw new Error("use injected runtime"); }
  export async function sha256Blob(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
`);

const storeStub = moduleUrl(`
  export function isVocabImportWriteReceipt(value) {
    return Boolean(value && value.kind === "podcast" && value.operationId && value.itemId);
  }
  export async function prepareVocabPodcastWrite(podcast) {
    const operationId = \`operation_\${crypto.randomUUID()}\`;
    const createdAt = Date.now();
    return {
      version: 1,
      kind: "podcast",
      operationId,
      itemId: \`podcast_\${crypto.randomUUID()}\`,
      importId: \`import_\${crypto.randomUUID()}\`,
      contentIds: podcast.segments.map(() => \`segment_\${crypto.randomUUID()}\`),
      createdAt,
      publishedAt: "2026-08-21",
      projectionSha256: "0".repeat(64),
    };
  }
  export async function matchesVocabPodcastWriteReceipt() { return true; }
  export async function savePodcast() { throw new Error("use injected runtime"); }
  export async function inspectVocabImportWrite() { return "unknown"; }
`);

let source = await transpile("lib/vocab/write-receipts.ts");
source = source
  .replaceAll('"@/lib/local-db/files"', `"${fileStub}"`)
  .replaceAll('"./store"', `"${storeStub}"`);
const recovery = await import(moduleUrl(source));

test("audio receipt hashing uses the shared streaming hasher", async () => {
  const original = await readFile(new URL("lib/vocab/write-receipts.ts", projectRoot), "utf8");
  const body = original.slice(
    original.indexOf("function blobSha256"),
    original.indexOf("function podcastWithReceiptAudio"),
  );
  assert.match(body, /sha256Blob\(blob\)/);
  assert.doesNotMatch(body, /arrayBuffer\(|subtle\.digest/);
});

const podcast = {
  title: "Local audio",
  description: "",
  source: "local",
  durationMs: 1_000,
  segments: [{ start_ms: 0, end_ms: 1_000, text: "One second." }],
};
const audio = new File([new Uint8Array([1, 2, 3, 4])], "private.mp3", {
  type: "audio/mpeg",
});
const differentAudio = new File([new Uint8Array([4, 3, 2, 1])], "other.mp3", {
  type: "audio/mpeg",
});

function runtimeFixture(receipt, saveMode = "success") {
  const calls = [];
  const state = { database: "absent", file: "absent", fileObject: audio };
  const runtime = {
    async assertFileKeyAvailable(_namespace, key) {
      calls.push(["preflight", key]);
      assert.equal(key, receipt.fileKey);
      assert.equal(state.file, "absent");
    },
    async saveFileAtKey(_namespace, key, blob, options, owner) {
      calls.push(["save-file", key, owner]);
      assert.equal(key, receipt.fileKey);
      assert.equal(owner, receipt.stagingOwner);
      assert.equal(blob.size, receipt.byteSize);
      assert.equal(options.category, "podcast-audio");
      state.file = "exact";
      state.fileObject = blob;
    },
    async getFile(_namespace, key) {
      calls.push(["inspect-file", key]);
      if (state.file === "absent") {
        throw new globalThis.__TestLocalFileError("missing", "FILE_NOT_FOUND");
      }
      if (state.file === "owned-partial") {
        throw new globalThis.__TestLocalFileError("incomplete metadata", "INVALID_FILE_METADATA");
      }
      return {
        metadata: {
          key: receipt.fileKey,
          namespace: "vocab",
          stagingOwner: state.file === "foreign" ? "f".repeat(64) : receipt.stagingOwner,
          byteSize: receipt.byteSize,
          mimeType: receipt.mimeType,
          sha256: receipt.fileSha256,
          category: "podcast-audio",
        },
        file: state.fileObject,
      };
    },
    async deleteOwnedFile(_namespace, key, owner) {
      calls.push(["delete-owned", key, owner]);
      assert.equal(key, receipt.fileKey);
      assert.equal(owner, receipt.stagingOwner);
      if (state.file === "foreign") {
        throw new globalThis.__TestLocalFileError("foreign owner", "FILE_OWNERSHIP_MISMATCH");
      }
      const deleted = state.file !== "absent";
      state.file = "absent";
      return deleted;
    },
    async matchesPodcast() {
      calls.push(["match-database-projection"]);
      return true;
    },
    async savePodcast(_ready, _method, databaseReceipt) {
      calls.push(["save-database", databaseReceipt.itemId]);
      if (saveMode === "response-lost") {
        state.database = "exact_saved";
        throw new Error("worker response lost");
      }
      if (saveMode === "absent-failure") {
        throw new Error("transaction rejected");
      }
      if (saveMode === "unknown-failure") {
        state.database = "unknown";
        throw new Error("worker unavailable");
      }
      state.database = "exact_saved";
      if (saveMode === "file-disappears-after-save") state.file = "absent";
      return databaseReceipt.itemId;
    },
    async inspectDatabase() {
      calls.push(["inspect-database", state.database]);
      return state.database;
    },
  };
  return { calls, runtime, state };
}

async function preparedReceipt() {
  return recovery.prepareVocabPodcastAudioWrite(podcast, "file", audio);
}

test("audio stages an exact key only after preflight and a durable checkpoint", async () => {
  const receipt = await preparedReceipt();
  const fixture = runtimeFixture(receipt);
  const result = await recovery.saveVocabPodcastWithAudio(
    podcast,
    "file",
    audio,
    {
      receipt,
      runtime: fixture.runtime,
      onRecoveryPrepared(value) {
        fixture.calls.push(["checkpoint", value.fileKey, value.stagingOwner]);
      },
    },
  );
  assert.equal(result.itemId, receipt.database.itemId);
  const names = fixture.calls.map(([name]) => name);
  assert.ok(names.indexOf("preflight") < names.indexOf("checkpoint"));
  assert.ok(names.indexOf("checkpoint") < names.indexOf("save-file"));
  assert.ok(names.indexOf("save-file") < names.indexOf("save-database"));
  assert.equal(names.includes("delete-owned"), false);
});

test("a committed database response loss never deletes owned audio", async () => {
  const receipt = await preparedReceipt();
  const fixture = runtimeFixture(receipt, "response-lost");
  const result = await recovery.saveVocabPodcastWithAudio(
    podcast,
    "file",
    audio,
    { receipt, runtime: fixture.runtime, onRecoveryPrepared() {} },
  );
  assert.equal(result.itemId, receipt.database.itemId);
  assert.equal(fixture.state.database, "exact_saved");
  assert.equal(fixture.state.file, "exact");
  assert.equal(
    fixture.calls.some(([name]) => name === "delete-owned"),
    false,
  );
});

test("a database success is not acknowledged after the staged audio disappears", async () => {
  const receipt = await preparedReceipt();
  const fixture = runtimeFixture(receipt, "file-disappears-after-save");
  await assert.rejects(
    recovery.saveVocabPodcastWithAudio(
      podcast,
      "file",
      audio,
      { receipt, runtime: fixture.runtime, onRecoveryPrepared() {} },
    ),
    (error) => error?.code === "VOCAB_PODCAST_AUDIO_CONFLICT",
  );
  assert.equal(fixture.state.database, "exact_saved");
  assert.equal(fixture.state.file, "absent");
  assert.equal(
    fixture.calls.some(([name]) => name === "delete-owned"),
    false,
  );
});

test("owned audio is deleted only after the database is explicitly absent", async () => {
  const receipt = await preparedReceipt();
  const fixture = runtimeFixture(receipt, "absent-failure");
  await assert.rejects(
    recovery.saveVocabPodcastWithAudio(
      podcast,
      "file",
      audio,
      { receipt, runtime: fixture.runtime, onRecoveryPrepared() {} },
    ),
    (error) => error?.code === "VOCAB_PODCAST_AUDIO_NOT_SAVED",
  );
  assert.equal(fixture.state.database, "absent");
  assert.equal(fixture.state.file, "absent");
  const deletion = fixture.calls.find(([name]) => name === "delete-owned");
  assert.deepEqual(deletion, [
    "delete-owned",
    receipt.fileKey,
    receipt.stagingOwner,
  ]);
  const lastDatabaseInspection = fixture.calls
    .map(([name, value]) => [name, value])
    .filter(([name]) => name === "inspect-database")
    .at(-1);
  assert.deepEqual(lastDatabaseInspection, ["inspect-database", "absent"]);
});

test("unknown database state preserves audio and cleanup rechecks absence", async () => {
  const receipt = await preparedReceipt();
  const fixture = runtimeFixture(receipt, "unknown-failure");
  await assert.rejects(
    recovery.saveVocabPodcastWithAudio(
      podcast,
      "file",
      audio,
      { receipt, runtime: fixture.runtime, onRecoveryPrepared() {} },
    ),
    (error) => error?.code === "VOCAB_PODCAST_AUDIO_UNCERTAIN",
  );
  assert.equal(fixture.state.file, "exact");
  assert.equal(
    fixture.calls.some(([name]) => name === "delete-owned"),
    false,
  );
  assert.equal(
    await recovery.cleanupVocabPodcastAudioWrite(receipt, fixture.runtime),
    "blocked",
  );
  assert.equal(fixture.state.file, "exact");
  fixture.state.database = "absent";
  assert.equal(
    await recovery.cleanupVocabPodcastAudioWrite(receipt, fixture.runtime),
    "deleted",
  );
  assert.equal(fixture.state.file, "absent");
});

test("cleanup removes a receipt-owned partial audio claim but retains a foreign file", async () => {
  const receipt = await preparedReceipt();
  const fixture = runtimeFixture(receipt);
  fixture.state.file = "owned-partial";
  assert.deepEqual(
    await recovery.inspectVocabPodcastAudioWrite(receipt, fixture.runtime),
    { database: "absent", file: "conflict" },
  );
  assert.equal(
    await recovery.cleanupVocabPodcastAudioWrite(receipt, fixture.runtime),
    "deleted",
  );
  assert.equal(fixture.state.file, "absent");

  fixture.state.file = "foreign";
  assert.equal(
    await recovery.cleanupVocabPodcastAudioWrite(receipt, fixture.runtime),
    "blocked",
  );
  assert.equal(fixture.state.file, "foreign");
});

test("cleanup waits for the same operation to finish and rechecks the database before deleting", async () => {
  const receipt = await preparedReceipt();
  const fixture = runtimeFixture(receipt);
  let releaseSave;
  let reportSaveEntered;
  const saveEntered = new Promise((resolve) => {
    reportSaveEntered = resolve;
  });
  const saveMayFinish = new Promise((resolve) => {
    releaseSave = resolve;
  });
  fixture.runtime.savePodcast = async () => {
    fixture.calls.push(["save-database-paused", receipt.database.itemId]);
    reportSaveEntered();
    await saveMayFinish;
    fixture.state.database = "exact_saved";
    return receipt.database.itemId;
  };

  const saving = recovery.saveVocabPodcastWithAudio(
    podcast,
    "file",
    audio,
    { receipt, runtime: fixture.runtime, onRecoveryPrepared() {} },
  );
  await saveEntered;
  const cleaning = recovery.cleanupVocabPodcastAudioWrite(receipt, fixture.runtime);
  await Promise.resolve();
  assert.equal(
    fixture.calls.some(([name]) => name === "delete-owned"),
    false,
  );

  releaseSave();
  await saving;
  assert.equal(await cleaning, "blocked");
  assert.equal(fixture.state.database, "exact_saved");
  assert.equal(fixture.state.file, "exact");
  assert.equal(
    fixture.calls.some(([name]) => name === "delete-owned"),
    false,
  );
});

test("same-size same-MIME audio cannot reuse another file's receipt", async () => {
  const receipt = await preparedReceipt();
  const fixture = runtimeFixture(receipt);
  await assert.rejects(
    recovery.saveVocabPodcastWithAudio(
      podcast,
      "file",
      differentAudio,
      { receipt, runtime: fixture.runtime, onRecoveryPrepared() {} },
    ),
    (error) => error?.code === "VOCAB_PODCAST_AUDIO_CONFLICT",
  );
  assert.equal(
    fixture.calls.some(([name]) => name === "save-file" || name === "save-database"),
    false,
  );

  fixture.state.file = "exact";
  fixture.state.fileObject = differentAudio;
  assert.deepEqual(
    await recovery.inspectVocabPodcastAudioWrite(receipt, fixture.runtime),
    { database: "absent", file: "conflict" },
  );
  assert.equal(
    await recovery.cleanupVocabPodcastAudioWrite(receipt, fixture.runtime),
    "deleted",
  );
  assert.equal(fixture.state.file, "absent");
  assert.equal(
    fixture.calls.some(([name]) => name === "delete-owned"),
    true,
  );
});
