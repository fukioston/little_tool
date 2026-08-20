import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
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
  const sourceUrl = `\n//# sourceURL=${relativePath.replaceAll(" ", "%20")}`;
  const encoded = Buffer.from(`${outputText}${sourceUrl}`).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

test("incremental SHA-256 matches standard vectors", async () => {
  const { sha256Blob } = await loadStandaloneTypeScriptModule(
    "lib/local-db/files.ts",
  );

  assert.equal(
    await sha256Blob(new Blob([])),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    await sha256Blob(new Blob(["abc"])),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );

  const chunks = Array.from({ length: 257 }, (_, index) =>
    new Uint8Array(4093).fill(index % 251),
  );
  const payload = new Blob(chunks);
  const nativeDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", await payload.arrayBuffer()),
  );
  const nativeHex = Buffer.from(nativeDigest).toString("hex");
  assert.equal(await sha256Blob(payload), nativeHex);
});

for (const contract of [
  {
    path: "lib/schemas/zhiji.ts",
    exportName: "zhijiSchema",
    name: "zhiji",
    filename: "zhiji.sqlite3",
    minimumTables: 12,
    seedTable: "job_applications",
    minimumSeedRows: 4,
  },
  {
    path: "lib/schemas/shici.ts",
    exportName: "shiciSchema",
    name: "shici",
    filename: "shici.sqlite3",
    minimumTables: 13,
    seedTable: "vocabulary_entries",
    minimumSeedRows: 6,
  },
]) {
  test(`${contract.name} reference schema and seed are idempotent`, async () => {
    const sqlite3 = await sqlite3InitModule();
    const loadedModule = await loadStandaloneTypeScriptModule(contract.path);
    const schema = loadedModule[contract.exportName];
    assert.equal(schema.name, contract.name);
    assert.equal(schema.filename, contract.filename);

    const database = new sqlite3.oo1.DB(":memory:", "c");
    try {
      database.exec("PRAGMA foreign_keys=ON");
      for (const migration of schema.migrations) {
        database.transaction("IMMEDIATE", () => {
          database.exec(migration.sql);
          database.exec(`PRAGMA user_version=${migration.version}`);
        });
      }

      database.transaction("IMMEDIATE", () => database.exec(schema.seedSql));
      const firstSeedCount = Number(
        database.selectValue(`SELECT COUNT(*) FROM ${contract.seedTable}`),
      );
      database.transaction("IMMEDIATE", () => database.exec(schema.seedSql));
      const secondSeedCount = Number(
        database.selectValue(`SELECT COUNT(*) FROM ${contract.seedTable}`),
      );

      assert.ok(firstSeedCount >= contract.minimumSeedRows);
      assert.equal(secondSeedCount, firstSeedCount);
      assert.equal(database.selectValue("PRAGMA integrity_check"), "ok");
      assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
      assert.equal(
        Number(database.selectValue("PRAGMA application_id")),
        schema.applicationId,
      );
      assert.ok(
        Number(
          database.selectValue(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type=?",
            ["table"],
          ),
        ) >= contract.minimumTables,
      );
    } finally {
      database.close();
    }
  });
}

test("runtime maps product aliases to independent files without auto-running reference schemas", async () => {
  const [types, worker] = await Promise.all([
    readFile(new URL("lib/local-db/types.ts", projectRoot), "utf8"),
    readFile(new URL("lib/local-db/sqlite.worker.ts", projectRoot), "utf8"),
  ]);

  assert.match(types, /career["']\) return ["']zhiji["']/);
  assert.match(types, /vocab["']\) return ["']shici["']/);
  assert.match(types, /zhiji:\s*["']zhiji\.sqlite3["']/);
  assert.match(types, /shici:\s*["']shici\.sqlite3["']/);
  assert.doesNotMatch(worker, /localDatabaseSchemas|seedSql|migrations/);
});
