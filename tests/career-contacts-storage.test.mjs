import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

function stringValue(expression) {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  return null;
}

function arraySql(source, variableName) {
  const file = ts.createSourceFile(
    "db.ts",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  let values = null;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      values = node.initializer.elements.flatMap((element) => {
        if (!ts.isObjectLiteralExpression(element)) return [];
        const property = element.properties.find(
          (candidate) =>
            ts.isPropertyAssignment(candidate) &&
            ((ts.isIdentifier(candidate.name) && candidate.name.text === "sql") ||
              (ts.isStringLiteral(candidate.name) && candidate.name.text === "sql")),
        );
        if (!property || !ts.isPropertyAssignment(property)) return [];
        const value = stringValue(property.initializer);
        return value === null ? [] : [value];
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(values, `missing ${variableName}`);
  return values;
}

test("fresh runtime schema exposes v2 contact relationships without synthetic history", async () => {
  const source = await readFile(
    new URL("lib/career/db.ts", projectRoot),
    "utf8",
  );
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  try {
    database.exec("PRAGMA foreign_keys=ON");
    for (const sql of arraySql(source, "schemaStatements")) database.exec(sql);

    const contactColumns = new Set(
      database.selectObjects("PRAGMA table_info(career_contacts)")
        .map(({ name }) => name),
    );
    const taskColumns = new Set(
      database.selectObjects("PRAGMA table_info(career_tasks)")
        .map(({ name }) => name),
    );
    assert.equal(contactColumns.has("updated_at"), true);
    assert.equal(contactColumns.has("archived"), true);
    assert.equal(taskColumns.has("contact_id"), true);
    assert.equal(
      database.selectValue(
        "SELECT type FROM sqlite_schema WHERE name='career_contact_jobs'",
      ),
      "table",
    );
    assert.equal(
      database.selectValue(
        "SELECT type FROM sqlite_schema WHERE name='career_contact_interactions'",
      ),
      "table",
    );
    assert.equal(Number(database.selectValue(
      "SELECT COUNT(*) FROM career_contact_jobs",
    )), 0);
    assert.equal(Number(database.selectValue(
      "SELECT COUNT(*) FROM career_contact_interactions",
    )), 0);
    assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
  } finally {
    database.close();
  }

  assert.match(source, /WHERE archived = 0 ORDER BY next_follow_up, name/);
  assert.doesNotMatch(source, /INSERT INTO career_contact_(?:jobs|interactions)/);
});

test("contact repository publishes the agreed API and every write takes the Career lock", async () => {
  const source = await readFile(
    new URL("lib/career/contacts.ts", projectRoot),
    "utf8",
  );
  for (const name of [
    "loadCareerContacts",
    "loadCareerContactDetail",
    "createCareerContact",
    "updateCareerContact",
    "recordCareerContactInteraction",
    "createCareerContactTask",
    "archiveCareerContact",
    "restoreCareerContact",
  ]) {
    assert.match(source, new RegExp(`export (?:async )?function ${name}\\b`));
  }
  assert.match(source, /withCareerReadLock/);
  assert.match(source, /withCareerWriteLock/);
  assert.match(source, /runCareerBatch\(statements, context\)/);
});

test("staged imports use a weaker legacy source contract only before migration", async () => {
  const [types, worker] = await Promise.all([
    readFile(new URL("lib/local-db/types.ts", projectRoot), "utf8"),
    readFile(new URL("lib/local-db/sqlite.worker.ts", projectRoot), "utf8"),
  ]);
  assert.match(types, /sourceRequiredTables\?: readonly DatabaseTableRequirement\[\]/);
  assert.match(worker, /sourceRequiredTables: readonly Readonly/);
  assert.match(worker, /phase === "source"\s*\? requirements\.sourceRequiredTables/);
  assert.match(worker, /: requirements\.requiredTables/);
});
