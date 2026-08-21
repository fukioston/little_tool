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
    "activateStaged",
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
