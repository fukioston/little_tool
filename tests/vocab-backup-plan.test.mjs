import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const SHCI = 0x53484349;
const MIGRATION_TIME = 1_777_777_777_000;

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
    "store.ts",
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

async function loadPlan() {
  const relativePath = "lib/vocab/backup-plan.ts";
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
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

function executeRun(database, sql, params = []) {
  const statement = database.prepare(sql);
  try {
    if (Array.isArray(params) ? params.length > 0 : Object.keys(params).length > 0) {
      statement.bind(params);
    }
    while (statement.step()) {
      // Consume PRAGMA/RETURNING rows so every statement reaches completion.
    }
  } finally {
    statement.finalize();
  }
}

function executePlan(database, statements) {
  database.transaction("IMMEDIATE", () => {
    for (const { sql, params = [] } of statements) executeRun(database, sql, params);
  });
}

const [plan, storeSource] = await Promise.all([
  loadPlan(),
  readFile(new URL("lib/vocab/store.ts", projectRoot), "utf8"),
]);
const legacySql = arraySql(storeSource, "legacySchemaStatements");

async function databaseFixture(version = 0) {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  database.transaction("IMMEDIATE", () => {
    for (const sql of legacySql) database.exec(sql);
    if (version >= 1) {
      database.exec(`CREATE TABLE vocab_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`);
      database.exec(
        "INSERT INTO vocab_schema_migrations VALUES(1,'formalize-runtime-schema',1)",
      );
      database.exec(`PRAGMA application_id=${SHCI}`);
      database.exec("PRAGMA user_version=1");
    }
  });
  if (version === 2) {
    executePlan(
      database,
      plan.createLegacyVocabRestoreStatements(1, MIGRATION_TIME),
    );
  }
  return database;
}

function addItem(database, id, audioUrl) {
  executeRun(
    database,
    `INSERT INTO vocab_items(
      id,kind,title,description,source,source_url,author,published_at,
      duration_ms,audio_url,status,progress,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, "podcast", id, "", "local", null, "", "", 0, audioUrl, "unread", 0, 1, 1],
  );
}

function metadata(key, name = `${key}.mp3`) {
  return {
    key,
    originalName: name,
    mimeType: "audio/mpeg",
    byteSize: 12,
  };
}

function mapping(originalKey, stagedKey) {
  return {
    original: metadata(originalKey, "original.mp3"),
    staged: metadata(stagedKey, "original.mp3"),
  };
}

function columns(database, table) {
  return database.selectObjects(`PRAGMA table_info(${table})`).map(({ name }) => name);
}

function identity(database) {
  return {
    applicationId: Number(database.selectValue("PRAGMA application_id")),
    userVersion: Number(database.selectValue("PRAGMA user_version")),
  };
}

test("complete restore accepts zero audio and migrates exact v0 and v1 runtimes to v2", async () => {
  for (const sourceVersion of [0, 1]) {
    const database = await databaseFixture(sourceVersion);
    try {
      addItem(database, `remote-${sourceVersion}`, "https://example.test/episode.mp3");
      executePlan(
        database,
        plan.createCompleteVocabRestoreStatements([], sourceVersion, MIGRATION_TIME),
      );
      assert.deepEqual(identity(database), { applicationId: SHCI, userVersion: 2 });
      assert.equal(
        database.selectValue("SELECT audio_url FROM vocab_items"),
        "https://example.test/episode.mp3",
      );
      assert.deepEqual(
        database.selectObjects(
          "SELECT version,name FROM vocab_schema_migrations ORDER BY version",
        ).map((row) => ({ ...row })),
        [
          {
            version: 1,
            name: sourceVersion === 0
              ? "adopt-exact-legacy-runtime"
              : "formalize-runtime-schema",
          },
          { version: 2, name: "srs-v2" },
        ],
      );
      assert.deepEqual(columns(database, "vocab_review_cards").slice(-4), [
        "algorithm_version",
        "suspended_from_state",
        "suspended_reason",
        "updated_at",
      ]);
      assert.equal(columns(database, "vocab_review_events").at(-1), "activity_id");
      assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
    } finally {
      database.close();
    }
  }
});

test("complete restore remaps exactly one and multiple referenced local audio keys", async () => {
  const cases = [
    [["10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000001"]],
    [
      ["10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000001"],
      ["10000000-0000-4000-8000-000000000002", "20000000-0000-4000-8000-000000000002"],
      ["10000000-0000-4000-8000-000000000003", "20000000-0000-4000-8000-000000000003"],
    ],
  ];
  for (const pairs of cases) {
    const database = await databaseFixture(2);
    try {
      for (const [index, [original]] of pairs.entries()) {
        addItem(database, `local-${index}`, `local:${original}`);
      }
      executePlan(
        database,
        plan.createCompleteVocabRestoreStatements(
          pairs.map(([original, staged]) => mapping(original, staged)),
          2,
          MIGRATION_TIME,
        ),
      );
      assert.deepEqual(
        database.selectObjects("SELECT audio_url FROM vocab_items ORDER BY id")
          .map(({ audio_url }) => audio_url),
        pairs.map(([, staged]) => `local:${staged}`),
      );
    } finally {
      database.close();
    }
  }
});

test("audio set mismatch aborts the candidate transaction without partial remapping", async () => {
  const first = "10000000-0000-4000-8000-000000000001";
  const second = "10000000-0000-4000-8000-000000000002";
  const staged = "20000000-0000-4000-8000-000000000001";
  for (const mappings of [
    [],
    [mapping(first, staged)],
    [mapping(first, staged), mapping("10000000-0000-4000-8000-000000000099", "20000000-0000-4000-8000-000000000099")],
  ]) {
    const database = await databaseFixture(2);
    try {
      addItem(database, "a", `local:${first}`);
      addItem(database, "b", `local:${second}`);
      assert.throws(
        () => executePlan(
          database,
          plan.createCompleteVocabRestoreStatements(mappings, 2, MIGRATION_TIME),
        ),
        /CHECK constraint failed/,
      );
      assert.deepEqual(
        database.selectObjects("SELECT audio_url FROM vocab_items ORDER BY id")
          .map(({ audio_url }) => audio_url),
        [`local:${first}`, `local:${second}`],
      );
      assert.deepEqual(identity(database), { applicationId: SHCI, userVersion: 2 });
    } finally {
      database.close();
    }
  }
});

test("legacy SQLite restore clears only unrecoverable local audio and keeps remote URLs", async () => {
  const database = await databaseFixture(0);
  try {
    addItem(database, "local", "local:10000000-0000-4000-8000-000000000001");
    addItem(database, "remote", "https://example.test/remote.ogg");
    executePlan(
      database,
      plan.createLegacyVocabRestoreStatements(0, MIGRATION_TIME),
    );
    assert.deepEqual(
      database.selectObjects("SELECT id,audio_url FROM vocab_items ORDER BY id")
        .map((row) => ({ ...row })),
      [
        { id: "local", audio_url: null },
        { id: "remote", audio_url: "https://example.test/remote.ogg" },
      ],
    );
    assert.deepEqual(identity(database), { applicationId: SHCI, userVersion: 2 });
  } finally {
    database.close();
  }
});

test("wrong products, malformed version contracts, unknown tables, and future schemas are rejected", async () => {
  const unknownTable = await databaseFixture(0);
  try {
    unknownTable.exec("CREATE TABLE unrelated_private_data(id TEXT PRIMARY KEY)");
    assert.throws(
      () => executePlan(
        unknownTable,
        plan.createLegacyVocabRestoreStatements(0, MIGRATION_TIME),
      ),
      /CHECK constraint failed/,
    );
    assert.deepEqual(identity(unknownTable), { applicationId: 0, userVersion: 0 });
    assert.equal(
      Number(unknownTable.selectValue(
        "SELECT COUNT(*) FROM sqlite_schema WHERE name='vocab_schema_migrations'",
      )),
      0,
    );
  } finally {
    unknownTable.close();
  }

  const wrongIdentity = await databaseFixture(1);
  try {
    wrongIdentity.exec("PRAGMA application_id=0");
    assert.throws(
      () => executePlan(
        wrongIdentity,
        plan.createLegacyVocabRestoreStatements(1, MIGRATION_TIME),
      ),
      /CHECK constraint failed/,
    );
    assert.deepEqual(identity(wrongIdentity), { applicationId: 0, userVersion: 1 });
  } finally {
    wrongIdentity.close();
  }

  const incompleteLedger = await databaseFixture(2);
  try {
    incompleteLedger.exec("DELETE FROM vocab_schema_migrations WHERE version=2");
    assert.throws(
      () => executePlan(
        incompleteLedger,
        plan.createLegacyVocabRestoreStatements(2, MIGRATION_TIME),
      ),
      /CHECK constraint failed/,
    );
  } finally {
    incompleteLedger.close();
  }

  assert.throws(
    () => plan.createCompleteVocabRestoreStatements([], 3, MIGRATION_TIME),
    /Unsupported Vocabulary restore source user_version/,
  );
  assert.throws(
    () => plan.createLegacyVocabRestoreStatements(-1, MIGRATION_TIME),
    /Unsupported Vocabulary restore source user_version/,
  );
});

test("duplicate or overlapping audio mappings are rejected before any SQLite write", () => {
  const first = "10000000-0000-4000-8000-000000000001";
  const second = "20000000-0000-4000-8000-000000000001";
  const valid = mapping(first, second);
  assert.throws(
    () => plan.createCompleteVocabRestoreStatements([valid, valid], 2, MIGRATION_TIME),
    /duplicate original key/,
  );
  assert.throws(
    () => plan.createCompleteVocabRestoreStatements([
      valid,
      mapping(second, "30000000-0000-4000-8000-000000000001"),
    ], 2, MIGRATION_TIME),
    /must not overlap original keys/,
  );
});

test("staged import requirements end at the canonical v2 identity and full schema", () => {
  assert.equal(plan.VOCAB_APPLICATION_ID, SHCI);
  assert.equal(plan.VOCAB_USER_VERSION, 2);
  assert.equal(plan.VOCAB_SCHEMA_REQUIREMENTS.minimumUserVersion, 2);
  assert.equal(plan.VOCAB_SCHEMA_REQUIREMENTS.maximumUserVersion, 2);
  assert.deepEqual(plan.VOCAB_SCHEMA_REQUIREMENTS.sourceApplicationIds, [0, SHCI]);
  const cards = plan.VOCAB_SCHEMA_REQUIREMENTS.requiredTables.find(
    ({ name }) => name === "vocab_review_cards",
  );
  const events = plan.VOCAB_SCHEMA_REQUIREMENTS.requiredTables.find(
    ({ name }) => name === "vocab_review_events",
  );
  assert.ok(cards.columns.includes("algorithm_version"));
  assert.ok(cards.columns.includes("suspended_reason"));
  assert.ok(events.columns.includes("activity_id"));
  assert.ok(plan.VOCAB_SCHEMA_REQUIREMENTS.requiredTables.some(
    ({ name }) => name === "vocab_schema_migrations",
  ));
});
