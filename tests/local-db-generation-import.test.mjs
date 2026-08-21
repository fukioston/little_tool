import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

async function loadStandaloneTypeScriptModule(relativePath) {
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
    diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error),
    [],
  );
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  assert.ok(endIndex > startIndex, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Career compatibility and per-database generation identities remain deterministic", async () => {
  const types = await loadStandaloneTypeScriptModule("lib/local-db/types.ts");
  const generationId = "123e4567-e89b-42d3-a456-426614174000";
  const filename = `zhiji.${generationId}.sqlite3`;
  const vocabFilename = `shici.${generationId}.sqlite3`;
  const fitnessFilename = `shilian.${generationId}.sqlite3`;

  assert.equal(types.isDatabaseGenerationId(generationId), true);
  assert.equal(types.isCareerGenerationId(generationId), true);
  assert.equal(types.isCareerGenerationId("../../zhiji.sqlite3"), false);
  assert.equal(types.isCareerGenerationId("123E4567-e89b-42d3-a456-426614174000"), false);
  assert.equal(types.careerGenerationFilename(generationId), filename);
  assert.equal(types.databaseGenerationFilename("zhiji", generationId), filename);
  assert.equal(types.databaseGenerationFilename("shici", generationId), vocabFilename);
  assert.equal(types.databaseGenerationFilename("shilian", generationId), fitnessFilename);
  assert.throws(() => types.careerGenerationFilename("not-a-generation"));

  assert.equal(types.isCareerActivationToken("a".repeat(64)), true);
  assert.equal(types.isCareerActivationToken("A".repeat(64)), false);
  assert.equal(types.isCareerActivationToken("a".repeat(63)), false);

  const pointer = { version: 1, sequence: 7, filename };
  assert.equal(
    types.careerGenerationPointerChecksumInput(pointer),
    `private-ai-suite:career-pointer:v1\n7\n${filename}\n`,
  );
  assert.equal(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(types.careerGenerationPointerChecksumInput(pointer)),
    ).then((digest) => Buffer.from(digest).toString("hex")),
    "891d1725fd9f26d9e511c7d3ffa393f6f51e6536e5a1ff8ca1254ed27bee8b15",
  );
  const vocabPointer = { ...pointer, filename: vocabFilename };
  const fitnessPointer = { ...pointer, filename: fitnessFilename };
  assert.equal(
    types.databaseGenerationPointerChecksumInput("shici", vocabPointer),
    `private-ai-suite:vocab-pointer:v1\n7\n${vocabFilename}\n`,
  );
  assert.equal(
    types.databaseGenerationPointerChecksumInput("shilian", fitnessPointer),
    `private-ai-suite:fitness-pointer:v1\n7\n${fitnessFilename}\n`,
  );
  assert.deepEqual(types.DATABASE_PRODUCTS, {
    zhiji: "career",
    shici: "vocab",
    shilian: "fitness",
  });
  assert.equal(types.canonicalDatabaseName("fitness"), "shilian");
  assert.notEqual(
    types.databaseGenerationPointerChecksumInput("zhiji", pointer),
    types.databaseGenerationPointerChecksumInput("shici", vocabPointer),
  );
  assert.notEqual(
    types.databaseGenerationPointerChecksumInput("shici", vocabPointer),
    types.databaseGenerationPointerChecksumInput("shilian", fitnessPointer),
  );

  const ranked = types.rankCareerGenerationPointers([
    { ...pointer, sequence: 3, slot: "a", checksum: "1".repeat(64) },
    { ...pointer, sequence: 9, slot: "a", checksum: "2".repeat(64) },
    { ...pointer, sequence: 9, slot: "b", checksum: "3".repeat(64) },
  ]);
  assert.deepEqual(ranked.map(({ sequence, slot }) => [sequence, slot]), [
    [9, "b"],
    [9, "a"],
    [3, "a"],
  ]);
});

test("worker rejects corrupt namespaced pointers and falls back through older generations", async () => {
  const worker = await readFile(
    new URL("lib/local-db/sqlite.worker.ts", projectRoot),
    "utf8",
  );
  const pointerReader = section(
    worker,
    "async function readGenerationPointer(",
    "async function readRankedGenerationPointers(",
  );
  assert.match(pointerReader, /GENERATION_FILES\[name\]\.pointerFiles\[slot\]/);
  assert.match(pointerReader, /databaseGenerationPointerChecksumInput\(name, pointer\)/);
  assert.match(pointerReader, /generationIdFromFilename\(name, parsed\.filename\) === null/);
  assert.match(pointerReader, /if \(!equalDigest\(checksum, parsed\.checksum\)\) return null/);

  const opener = section(
    worker,
    "async function openDatabase(",
    "async function initDatabase(",
  );
  assert.match(opener, /for \(const pointer of pointers\)/);
  assert.match(opener, /new sqlite3\.oo1\.OpfsDb\(`\/\$\{pointer\.filename\}`, "w"\)/);
  assert.match(opener, /catch \{[\s\S]*?db\?\.close\(\)/);
  assert.ok(
    opener.indexOf("for (const pointer of pointers)") <
      opener.indexOf("const filename = DATABASE_FILES[name]"),
    "legacy fallback must follow all pointer candidates",
  );
});

test("every worker request revalidates a cached handle against durable generation pointers", async () => {
  const worker = await readFile(
    new URL("lib/local-db/sqlite.worker.ts", projectRoot),
    "utf8",
  );
  const opener = section(
    worker,
    "async function openDatabase(",
    "async function initDatabase(",
  );
  const pointerRead = opener.indexOf("await readRankedGenerationPointers(name)");
  const pointerLoop = opener.indexOf("for (const pointer of pointers)");
  const cachedMatch = opener.indexOf("existing?.filename === pointer.filename");
  const installReplacement = opener.indexOf("openDatabases.set(name, state)");
  const closeCached = opener.indexOf("existing?.db.close()");
  const legacyFallback = opener.indexOf("const filename = DATABASE_FILES[name]");

  assert.ok(pointerRead >= 0 && pointerRead < pointerLoop);
  assert.ok(
    pointerLoop < cachedMatch && cachedMatch < legacyFallback,
    "a cached handle may only be reused after every newer durable pointer is considered",
  );
  assert.ok(
    installReplacement >= 0 && installReplacement < closeCached,
    "the validated replacement must become authoritative before the stale handle closes",
  );
  assert.doesNotMatch(
    opener,
    /if \(existing\?\.db\.isOpen\(\)\) return/,
    "an open in-memory handle must never bypass durable pointer revalidation",
  );

  const requestHandler = section(
    worker,
    "async function handleRequest(",
    "function serializeError(",
  );
  for (const operation of ["query", "run", "batch", "export"]) {
    const operationCase = section(
      requestHandler,
      `case "${operation}"`,
      operation === "export" ? 'case "import"' : `case "${({ query: "run", run: "batch", batch: "export" })[operation]}"`,
    );
    assert.match(
      operationCase,
      /await openDatabase\(request\.database\)/,
      `${operation} must revalidate its generation before touching SQLite`,
    );
  }
});

test("Fitness attachment reconciliation resolves its database generation before OPFS garbage collection", async () => {
  const files = await readFile(
    new URL("lib/fitness/files.ts", projectRoot),
    "utf8",
  );
  const reconcile = section(
    files,
    "async function reconcileUnlocked(",
    "export function createFitnessFileService(",
  );
  const rowsQuery = reconcile.indexOf('runtime.query<StoredFitnessFile>(');
  const localListing = reconcile.indexOf("runtime.listFiles()");
  const orphanDelete = reconcile.lastIndexOf("runtime.deleteFile(metadata.key)");
  assert.ok(
    rowsQuery >= 0 && rowsQuery < localListing && localListing < orphanDelete,
    "reconcile must enter the generation-aware DB path before listing or deleting managed OPFS files",
  );

  const service = section(
    files,
    "export function createFitnessFileService(",
    "const service = createFitnessFileService(",
  );
  assert.match(
    service,
    /async function reconcile\(\)[\s\S]*?runtime\.withExclusiveLock/,
    "generation selection and attachment GC must remain inside one exclusive product lock",
  );
});

test("first activation preserves legacy, then commits the candidate to the other pointer", async () => {
  const worker = await readFile(
    new URL("lib/local-db/sqlite.worker.ts", projectRoot),
    "utf8",
  );
  const activation = section(
    worker,
    "async function activateStagedDatabaseGeneration(",
    "async function currentDatabaseGeneration(",
  );
  const baselineGuard = activation.indexOf("if (active.pointerSlot === null)");
  const baselineWrite = activation.indexOf("const baseline = await writeGenerationPointer");
  const targetSelection = activation.indexOf("const targetSlot:");
  const candidateWrite = activation.indexOf("const committed = await writeGenerationPointer");
  const stateSwitch = activation.indexOf("openDatabases.set(name, nextState)");
  assert.ok(
    baselineGuard >= 0 &&
      baselineGuard < baselineWrite &&
      baselineWrite < targetSelection &&
      targetSelection < candidateWrite &&
      candidateWrite < stateSwitch,
  );
  assert.match(activation, /active\.pointerSlot === "a" \? "b" : "a"/);
  assert.match(activation, /if \(active\.filename === ready\.filename\)/);
});

test("stage failure only cleans its random candidate and never writes the live path", async () => {
  const worker = await readFile(
    new URL("lib/local-db/sqlite.worker.ts", projectRoot),
    "utf8",
  );
  const staging = section(
    worker,
    "async function stageDatabaseImport(",
    "async function validateReadyCandidate(",
  );
  assert.match(staging, /const filename = databaseGenerationFilename\(name, generationId\)/);
  assert.match(staging, /OpfsDb\.importDb\(`\/\$\{filename\}`, replacement\)/);
  assert.match(staging, /assertDatabaseContract\(candidate, requirements, "source"\)/);
  assert.match(staging, /executeBatch\(candidate, statements, true\)/);
  assert.match(staging, /assertDatabaseContract\(candidate, requirements, "canonical"\)/);
  assert.match(staging, /removeOpfsEntryIfPresent\(filename\)/);
  assert.doesNotMatch(staging, /DATABASE_FILES|openDatabases\.set/);
});

test("public RPC stages all three products independently without cross-product pointers", async () => {
  const [types, client, worker] = await Promise.all([
    readFile(new URL("lib/local-db/types.ts", projectRoot), "utf8"),
    readFile(new URL("lib/local-db/client.ts", projectRoot), "utf8"),
    readFile(new URL("lib/local-db/sqlite.worker.ts", projectRoot), "utf8"),
  ]);
  for (const operation of [
    "stageImport",
    "registerPrepareCleanup",
    "recoverPrepare",
    "completePrepareCleanup",
    "activateStaged",
    "inspectStaged",
    "currentGeneration",
    "discardStaged",
  ]) {
    assert.match(types, new RegExp(`\\| \\"${operation}\\"`));
    assert.match(client, new RegExp(`\\b${operation}\\(`));
  }
  assert.match(client, /stageImport\(\s*database: LocalDatabaseId/);
  assert.match(client, /activateStaged\(\s*database: LocalDatabaseId/);
  assert.match(worker, /stageDatabaseImport\(\s*request\.database/);
  assert.match(worker, /activateStagedDatabaseGeneration\(\s*request\.database/);
  assert.match(worker, /inspectStagedDatabaseGeneration\(\s*request\.database/);
  assert.match(worker, /assertActivationToken\(name, ready, activationToken\)/);
  assert.match(worker, /zhiji\.active-a\.json/);
  assert.match(worker, /zhiji\.active-b\.json/);
  assert.match(worker, /shici\.active-a\.json/);
  assert.match(worker, /shici\.active-b\.json/);
  assert.match(worker, /shilian\.active-a\.json/);
  assert.match(worker, /shilian\.active-b\.json/);
  assert.match(client, /shilian:\s*new LocalDatabaseClient\("shilian"\)/);
  assert.match(client, /getLocalDatabase\("fitness"\)\.init\(\)/);
  assert.match(client, /return \{ career, vocab, fitness \}/);
  assert.match(types, /shilian:\s*"fitness"/);
  assert.match(worker, /rawPointerReferences\(\s*name,/);
  assert.match(worker, /generationIdFromFilename\(name, filename\)/);
  assert.doesNotMatch(worker, /assertCareerOnly/);
});

test("bound recovery READY records persist a worker-owned baseline and app projection digest", async () => {
  const worker = await readFile(
    new URL("lib/local-db/sqlite.worker.ts", projectRoot),
    "utf8",
  );
  const staging = section(
    worker,
    "async function stageDatabaseImport(",
    "async function validateReadyCandidate(",
  );
  const capture = staging.indexOf("const recoveryBaselineState");
  const primitiveCopy = staging.indexOf("generationId: recoveryBaselineState.generationId");
  const importWrite = staging.indexOf("OpfsDb.importDb");
  const readyWrite = staging.indexOf("version: 2");
  assert.ok(
    capture >= 0 && capture < primitiveCopy && primitiveCopy < importWrite && importWrite < readyWrite,
    "the durable baseline must be copied before any candidate import and persisted in v2 READY",
  );
  assert.match(staging, /recoveryTokenSha256: await sha256Text\(recoveryToken\)/);
  assert.match(staging, /databaseSha256: await sha256Bytes\([\s\S]*?recoveryBaselineState\.db/);
  assert.match(staging, /expectedCurrentDatabaseSha256: recoveryBaseline\.databaseSha256/);
  assert.match(staging, /canonicalApplicationId: requirements\.applicationId/);
  assert.match(staging, /canonicalUserVersion: canonicalSchemaVersion/);
  assert.match(staging, /projectionSha256: recoveryOptions\.projectionSha256/);
  assert.doesNotMatch(
    staging,
    /expectedCurrentGenerationId:\s*rawRecovery/,
    "the app may provide a projection digest, never its own baseline",
  );
});

test("prepare operations bind a caller-stable generation before candidate writes", async () => {
  const [types, worker] = await Promise.all([
    readFile(new URL("lib/local-db/types.ts", projectRoot), "utf8"),
    readFile(new URL("lib/local-db/sqlite.worker.ts", projectRoot), "utf8"),
  ]);
  const staging = section(
    worker,
    "async function stageDatabaseImport(",
    "async function validateReadyCandidate(",
  );
  const stableId = staging.indexOf("prepareOperation?.operationId");
  const operationWrite = staging.indexOf("status: \"staging\"");
  const importWrite = staging.indexOf("OpfsDb.importDb");
  const readyStatus = staging.indexOf("status: \"ready\"");
  assert.ok(
    stableId >= 0 && stableId < operationWrite &&
      operationWrite < importWrite && importWrite < readyStatus,
    "the durable operation claim must precede the candidate and READY response",
  );
  assert.match(types, /export type DatabasePrepareOperationReceipt/);
  assert.match(types, /generationId: string/);
  assert.match(types, /attachmentKeysSha256: string/);
  assert.match(staging, /derivePrepareCapability\(prepareOperation\.operationToken, "activation"\)/);
  assert.match(staging, /derivePrepareCapability\(prepareOperation\.operationToken, "recovery"\)/);
  assert.match(staging, /stagedAttachmentKeys: \[\.\.\.prepareOperation\.stagedAttachmentKeys\]/);
  assert.match(staging, /PREPARE_OPERATION_ALREADY_STARTED/);
});

test("prepare recovery authenticates durable scope and never repeats stage or activation", async () => {
  const worker = await readFile(
    new URL("lib/local-db/sqlite.worker.ts", projectRoot),
    "utf8",
  );
  const transition = section(
    worker,
    "async function transitionPrepareOperationToCleanup(",
    "async function recoverPrepareOperation(",
  );
  const recovery = section(
    worker,
    "async function recoverPrepareOperation(",
    "async function completePrepareCleanup(",
  );
  const record = recovery.indexOf("readPrepareOperation");
  const binding = recovery.indexOf("assertPrepareOperationReceiptMatches");
  const discard = recovery.indexOf("readDiscardedBoundGeneration");
  const ready = recovery.indexOf("readStagedReady");
  const candidateValidation = recovery.indexOf("validateReadyCandidate");
  assert.ok(
    record >= 0 && record < binding && binding < discard && discard < ready &&
      ready < candidateValidation,
  );
  const pointerGuard = transition.indexOf("rawPointerReferences");
  const cleanupDelete = transition.indexOf("removeOpfsEntryIfPresent(filename)");
  assert.ok(pointerGuard >= 0 && pointerGuard < cleanupDelete);
  assert.match(recovery, /status: "ready"/);
  assert.match(recovery, /status: "discarded"/);
  assert.match(transition, /PREPARE_CLEANUP_NOT_AUTHORIZED/);
  assert.doesNotMatch(
    recovery,
    /stageDatabaseImport|activateStagedDatabaseGeneration|OpfsDb\.importDb|writeGenerationPointer/,
  );
});

test("prepare cleanup uses an exact checksummed tombstone and completes idempotently", async () => {
  const worker = await readFile(
    new URL("lib/local-db/sqlite.worker.ts", projectRoot),
    "utf8",
  );
  const validation = section(
    worker,
    "function normalizePrepareOperationReceipt(",
    "async function derivePrepareCapability(",
  );
  assert.match(validation, /new Set\(value\.stagedAttachmentKeys\)\.size/);
  assert.match(validation, /receipt\.attachmentKeysSha256 !== record\.attachmentKeysSha256/);
  assert.match(validation, /key !== record\.stagedAttachmentKeys\[index\]/);
  assert.match(validation, /sha256Text\(receipt\.operationToken\)/);
  assert.match(validation, /prepareOperationChecksumInput/);

  const registration = section(
    worker,
    "async function registerPrepareCleanup(",
    "async function recoverPrepareOperation(",
  );
  const readyGuard = registration.indexOf("stagedReadyFilename");
  const activationGuard = registration.indexOf("activatedGenerationFilename");
  const pointerGuard = registration.indexOf("rawPointerReferences");
  const orphanDelete = registration.indexOf("removeOpfsEntryIfPresent(filename)");
  const tombstone = registration.indexOf("writePrepareOperation(name, core)");
  assert.ok(
    readyGuard >= 0 && readyGuard < activationGuard &&
      activationGuard < pointerGuard && pointerGuard < orphanDelete &&
      orphanDelete < tombstone,
  );

  const completion = section(
    worker,
    "async function completePrepareCleanup(",
    "async function activateStagedDatabaseGeneration(",
  );
  assert.match(completion, /record\.status === "cleanup-complete"/);
  assert.match(completion, /record\.status !== "cleanup-pending"/);
  assert.match(completion, /prepareOperationWithStatus\(record, "cleanup-complete"\)/);
});

test("v1 READY stays compatible while v2 requires an exact durable recovery binding", async () => {
  const worker = await readFile(
    new URL("lib/local-db/sqlite.worker.ts", projectRoot),
    "utf8",
  );
  const reader = section(
    worker,
    "async function readStagedReady(",
    "function normalizeRecoveryStageOptions(",
  );
  assert.match(reader, /parsed\.version !== 1 && parsed\.version !== 2/);
  assert.match(reader, /parsed\.version === 1 \? commonKeys : \[\.\.\.commonKeys, "recovery"\]/);
  assert.match(reader, /parseStoredRecoveryBinding\(name, parsed\.recovery\)/);
  assert.match(worker, /"expectedCurrentDatabaseSha256"/);
  assert.match(reader, /recovery\.canonicalApplicationId !== common\.requirements\.applicationId/);

  const validation = section(
    worker,
    "async function assertRecoveryReceipt(",
    "async function openDatabase(",
  );
  assert.match(validation, /if \(ready\.version === 1\)/);
  assert.match(validation, /RECOVERY_BINDING_REQUIRED/);
  assert.match(validation, /value\.expectedCurrentGenerationId !== recovery\.expectedCurrentGenerationId/);
  assert.match(validation, /value\.projectionSha256 !== recovery\.projectionSha256/);
  assert.match(validation, /sha256Text\(value\.recoveryToken\)/);
});

test("bound activation validates the receipt before idempotence and enforces worker baseline", async () => {
  const worker = await readFile(
    new URL("lib/local-db/sqlite.worker.ts", projectRoot),
    "utf8",
  );
  const activation = section(
    worker,
    "async function activateStagedDatabaseGeneration(",
    "async function currentDatabaseGeneration(",
  );
  const binding = activation.indexOf("await assertRecoveryReceipt");
  const open = activation.indexOf("await openDatabase(name)");
  const idempotent = activation.indexOf("if (active.filename === ready.filename)");
  const baseline = activation.indexOf("active.generationId !== recovery.expectedCurrentGenerationId");
  const pointer = activation.indexOf("const committed = await writeGenerationPointer");
  assert.ok(
    binding >= 0 && binding < open && open < idempotent && idempotent < baseline && baseline < pointer,
  );
  assert.match(activation, /"STAGED_BASELINE_CHANGED"/);
  assert.match(
    activation,
    /sha256Bytes\(exportUnmodifiedBytes\(sqlite3, active\.db\)\)/,
  );
  assert.match(activation, /discardedGenerationFilename\(name, generationId\)/);
});

test("bound discard is idempotent only through a validated durable tombstone", async () => {
  const worker = await readFile(
    new URL("lib/local-db/sqlite.worker.ts", projectRoot),
    "utf8",
  );
  const discard = section(
    worker,
    "async function discardStagedDatabaseGeneration(",
    "async function replaceDatabase(",
  );
  const tombstoneRead = discard.indexOf("readDiscardedBoundGeneration");
  const tokenCheck = discard.indexOf("discarded.activationTokenSha256");
  const bindingCheck = discard.indexOf("assertRecoveryReceiptMatches");
  const retryDelete = discard.indexOf("if (discarded.status === \"pending\")");
  const firstPendingWrite = discard.indexOf("writeDiscardedBoundGeneration(name, pending)");
  const candidateDelete = discard.indexOf(
    "removeOpfsEntryIfPresent(ready.filename)",
    firstPendingWrite,
  );
  const completeWrite = discard.indexOf("status: \"complete\"", candidateDelete);
  assert.ok(
    tombstoneRead >= 0 && tombstoneRead < tokenCheck && tokenCheck < bindingCheck &&
      bindingCheck < retryDelete,
  );
  assert.ok(
    firstPendingWrite >= 0 && firstPendingWrite < candidateDelete && candidateDelete < completeWrite,
    "a pending tombstone must make response-lost discard retryable before READY is removed",
  );
  assert.match(discard, /await assertRecoveryReceipt\(name, ready, recoveryReceipt\)/);
  assert.match(discard, /GENERATION_ALREADY_ACTIVATED/);
});

test("client forwards recovery capabilities without changing legacy Vocab or Fitness calls", async () => {
  const [types, client, vocab, fitness] = await Promise.all([
    readFile(new URL("lib/local-db/types.ts", projectRoot), "utf8"),
    readFile(new URL("lib/local-db/client.ts", projectRoot), "utf8"),
    readFile(new URL("lib/vocab/backup.ts", projectRoot), "utf8"),
    readFile(new URL("lib/fitness/backup.ts", projectRoot), "utf8"),
  ]);
  assert.match(types, /export type DatabaseRecoveryReceipt</);
  assert.match(types, /recovery\?: DatabaseRecoveryStageOptions/);
  assert.match(types, /recoveryReceipt\?: DatabaseRecoveryReceipt/);
  assert.match(client, /recovery: options\.recovery/);
  assert.match(client, /recoveryReceipt,/);
  assert.match(vocab, /localDb\.stageImport\(DATABASE, database, statements, VOCAB_SCHEMA_REQUIREMENTS\)/);
  assert.match(fitness, /localDb\.stageImport\([\s\S]*?FITNESS_SCHEMA_REQUIREMENTS,[\s\S]*?\)/);
});

test("staged inspection validates both capabilities and only returns current generation", async () => {
  const worker = await readFile(
    new URL("lib/local-db/sqlite.worker.ts", projectRoot),
    "utf8",
  );
  const inspection = section(
    worker,
    "async function inspectStagedDatabaseGeneration(",
    "async function rawPointerReferences(",
  );
  assert.match(inspection, /await readStagedReady\(name, generationId\)/);
  assert.match(inspection, /await assertActivationToken\(name, ready, activationToken\)/);
  assert.match(inspection, /await assertRecoveryReceipt\(name, ready, recoveryReceipt\)/);
  assert.match(inspection, /return currentDatabaseGeneration\(name\)/);
  assert.doesNotMatch(
    inspection,
    /write|removeOpfsEntry|importDb|executeBatch|activateStagedDatabaseGeneration/,
  );
});
