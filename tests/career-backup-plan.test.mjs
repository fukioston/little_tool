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
    diagnostics.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  const sourceUrl = `\n//# sourceURL=${relativePath.replaceAll(" ", "%20")}`;
  const encoded = Buffer.from(`${outputText}${sourceUrl}`).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

const [sqlite3, restorePlan] = await Promise.all([
  sqlite3InitModule(),
  loadStandaloneTypeScriptModule("lib/career/backup-plan.ts"),
]);
const {
  CAREER_APPLICATION_ID,
  CAREER_SCHEMA_REQUIREMENTS,
  CAREER_USER_VERSION,
  createCompleteCareerRestoreStatements,
  createLegacyCareerRestoreStatements,
} = restorePlan;

function createDatabase(rows = []) {
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec(`CREATE TABLE career_materials (
    id TEXT PRIMARY KEY,
    file_key TEXT,
    file_name TEXT,
    mime_type TEXT,
    byte_size INTEGER
  )`);
  for (const row of rows) {
    const statement = database.prepare(`INSERT INTO career_materials
      (id, file_key, file_name, mime_type, byte_size)
      VALUES (?, ?, ?, ?, ?)`);
    try {
      statement.bind([
        row.id,
        row.fileKey ?? null,
        row.fileName ?? null,
        row.mimeType ?? null,
        row.byteSize ?? null,
      ]);
      statement.step();
    } finally {
      statement.finalize();
    }
  }
  return database;
}

function executeStatementsAtomically(database, statements) {
  database.transaction("IMMEDIATE", () => {
    for (const { sql, params } of statements) {
      const statement = database.prepare(sql);
      try {
        if (params?.length) statement.bind(params);
        while (statement.step()) {
          // Consume every result so PRAGMAs and RETURNING statements complete.
        }
      } finally {
        statement.finalize();
      }
    }
  });
}

function materialRows(database) {
  return database.selectObjects(`SELECT
    id,
    file_key AS fileKey,
    file_name AS fileName,
    mime_type AS mimeType,
    byte_size AS byteSize
    FROM career_materials
    ORDER BY id`).map((row) => ({ ...row }));
}

function metadata(key, originalName, mimeType, byteSize) {
  return { key, originalName, mimeType, byteSize };
}

function assertCanonicalIdentity(database) {
  assert.equal(
    Number(database.selectValue("PRAGMA application_id")),
    CAREER_APPLICATION_ID,
  );
  assert.equal(
    Number(database.selectValue("PRAGMA user_version")),
    CAREER_USER_VERSION,
  );
}

test("complete restore maps an exact Unicode attachment set atomically", () => {
  const database = createDatabase([
    {
      id: "material-a",
      fileKey: "原件-简历-α",
      fileName: "产品设计简历·秋招.pdf",
      mimeType: "application/pdf",
      byteSize: 17,
    },
    {
      id: "material-a-copy",
      fileKey: "原件-简历-α",
      fileName: "产品设计简历·秋招.pdf",
      mimeType: "application/pdf",
      byteSize: 17,
    },
    {
      id: "material-b",
      fileKey: "原件-作品集-日本語",
      fileName: "作品集_日本語版.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      byteSize: 2048,
    },
    { id: "material-without-file" },
  ]);
  const mappings = [
    {
      original: metadata(
        "原件-简历-α",
        "产品设计简历·秋招.pdf",
        "application/pdf",
        17,
      ),
      staged: metadata(
        "暂存-简历-β",
        "产品设计简历·秋招.pdf",
        "application/pdf",
        17,
      ),
    },
    {
      original: metadata(
        "原件-作品集-日本語",
        "作品集_日本語版.pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        2048,
      ),
      staged: metadata(
        "暂存-作品集-γ",
        "作品集_日本語版.pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        2048,
      ),
    },
  ];

  try {
    executeStatementsAtomically(
      database,
      createCompleteCareerRestoreStatements(mappings),
    );

    assert.deepEqual(materialRows(database), [
      {
        id: "material-a",
        fileKey: "暂存-简历-β",
        fileName: "产品设计简历·秋招.pdf",
        mimeType: "application/pdf",
        byteSize: 17,
      },
      {
        id: "material-a-copy",
        fileKey: "暂存-简历-β",
        fileName: "产品设计简历·秋招.pdf",
        mimeType: "application/pdf",
        byteSize: 17,
      },
      {
        id: "material-b",
        fileKey: "暂存-作品集-γ",
        fileName: "作品集_日本語版.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        byteSize: 2048,
      },
      {
        id: "material-without-file",
        fileKey: null,
        fileName: null,
        mimeType: null,
        byteSize: null,
      },
    ]);
    assertCanonicalIdentity(database);
    assert.equal(
      Number(
        database.selectValue(`SELECT COUNT(*) FROM temp.sqlite_temp_schema
          WHERE type = 'table' AND name = '__career_restore_guard'`),
      ),
      0,
    );
  } finally {
    database.close();
  }
});

for (const scenario of [
  {
    name: "missing attachment mapping",
    rows: [
      {
        id: "a",
        fileKey: "old-a",
        fileName: "a.pdf",
        mimeType: "application/pdf",
        byteSize: 10,
      },
      {
        id: "b",
        fileKey: "old-b",
        fileName: "b.pdf",
        mimeType: "application/pdf",
        byteSize: 20,
      },
    ],
    mappings: [
      {
        original: metadata("old-a", "a.pdf", "application/pdf", 10),
        staged: metadata("new-a", "a.pdf", "application/pdf", 10),
      },
    ],
  },
  {
    name: "extra attachment mapping",
    rows: [
      {
        id: "a",
        fileKey: "old-a",
        fileName: "a.pdf",
        mimeType: "application/pdf",
        byteSize: 10,
      },
    ],
    mappings: [
      {
        original: metadata("old-a", "a.pdf", "application/pdf", 10),
        staged: metadata("new-a", "a.pdf", "application/pdf", 10),
      },
      {
        original: metadata("old-b", "b.pdf", "application/pdf", 20),
        staged: metadata("new-b", "b.pdf", "application/pdf", 20),
      },
    ],
  },
  {
    name: "attachment metadata mismatch",
    rows: [
      {
        id: "a",
        fileKey: "old-a",
        fileName: "actual-name.pdf",
        mimeType: "application/pdf",
        byteSize: 10,
      },
    ],
    mappings: [
      {
        original: metadata("old-a", "manifest-name.pdf", "application/pdf", 10),
        staged: metadata("new-a", "manifest-name.pdf", "application/pdf", 10),
      },
    ],
  },
]) {
  test(`${scenario.name} aborts with every original row unchanged`, () => {
    const database = createDatabase(scenario.rows);
    const before = materialRows(database);
    try {
      assert.throws(() =>
        executeStatementsAtomically(
          database,
          createCompleteCareerRestoreStatements(scenario.mappings),
        ),
      );
      assert.deepEqual(materialRows(database), before);
      assert.equal(Number(database.selectValue("PRAGMA application_id")), 0);
      assert.equal(Number(database.selectValue("PRAGMA user_version")), 0);
      assert.equal(
        Number(
          database.selectValue(`SELECT COUNT(*) FROM temp.sqlite_temp_schema
            WHERE type = 'table' AND name = '__career_restore_guard'`),
        ),
        0,
      );
    } finally {
      database.close();
    }
  });
}

test("zero-attachment restore accepts no references and sets canonical identity", () => {
  const database = createDatabase([
    { id: "plain-material" },
    {
      id: "empty-key-is-not-a-reference",
      fileKey: "",
      fileName: "stale-name.pdf",
      mimeType: "application/pdf",
      byteSize: 9,
    },
  ]);
  try {
    executeStatementsAtomically(
      database,
      createCompleteCareerRestoreStatements([]),
    );
    assert.deepEqual(materialRows(database), [
      {
        id: "empty-key-is-not-a-reference",
        fileKey: "",
        fileName: "stale-name.pdf",
        mimeType: "application/pdf",
        byteSize: 9,
      },
      {
        id: "plain-material",
        fileKey: null,
        fileName: null,
        mimeType: null,
        byteSize: null,
      },
    ]);
    assertCanonicalIdentity(database);
  } finally {
    database.close();
  }
});

test("zero-attachment restore rejects even one real file reference", () => {
  const database = createDatabase([
    {
      id: "attached",
      fileKey: "old-a",
      fileName: "a.pdf",
      mimeType: "application/pdf",
      byteSize: 10,
    },
  ]);
  const before = materialRows(database);
  try {
    assert.throws(() =>
      executeStatementsAtomically(
        database,
        createCompleteCareerRestoreStatements([]),
      ),
    );
    assert.deepEqual(materialRows(database), before);
  } finally {
    database.close();
  }
});

test("legacy restore clears all four attachment columns", () => {
  const database = createDatabase([
    {
      id: "complete-reference",
      fileKey: "old-a",
      fileName: "简历.pdf",
      mimeType: "application/pdf",
      byteSize: 1024,
    },
    {
      id: "partial-reference",
      fileName: "orphaned-name.pdf",
      mimeType: "application/pdf",
      byteSize: 3,
    },
  ]);
  try {
    executeStatementsAtomically(
      database,
      createLegacyCareerRestoreStatements(),
    );
    assert.deepEqual(materialRows(database), [
      {
        id: "complete-reference",
        fileKey: null,
        fileName: null,
        mimeType: null,
        byteSize: null,
      },
      {
        id: "partial-reference",
        fileKey: null,
        fileName: null,
        mimeType: null,
        byteSize: null,
      },
    ]);
    assertCanonicalIdentity(database);
  } finally {
    database.close();
  }
});

test("restore plan publishes the canonical Career schema identity", () => {
  assert.equal(CAREER_APPLICATION_ID, 0x5a484a49);
  assert.equal(CAREER_USER_VERSION, 2);
  assert.deepEqual(CAREER_SCHEMA_REQUIREMENTS.sourceApplicationIds, [
    0,
    CAREER_APPLICATION_ID,
  ]);
  assert.equal(CAREER_SCHEMA_REQUIREMENTS.applicationId, CAREER_APPLICATION_ID);
  assert.equal(CAREER_SCHEMA_REQUIREMENTS.minimumUserVersion, 2);
  assert.equal(CAREER_SCHEMA_REQUIREMENTS.maximumUserVersion, 2);
  assert.equal(CAREER_SCHEMA_REQUIREMENTS.sourceMinimumUserVersion, 0);
  assert.equal(CAREER_SCHEMA_REQUIREMENTS.sourceMaximumUserVersion, 2);
  const materials = CAREER_SCHEMA_REQUIREMENTS.requiredTables.find(
    ({ name }) => name === "career_materials",
  );
  assert.deepEqual(materials?.columns.slice(-4), [
    "file_key",
    "file_name",
    "mime_type",
    "byte_size",
  ]);
  const sourceContacts = CAREER_SCHEMA_REQUIREMENTS.sourceRequiredTables.find(
    ({ name }) => name === "career_contacts",
  );
  const canonicalContacts = CAREER_SCHEMA_REQUIREMENTS.requiredTables.find(
    ({ name }) => name === "career_contacts",
  );
  assert.equal(sourceContacts.columns.includes("updated_at"), false);
  assert.equal(sourceContacts.columns.includes("archived"), false);
  assert.equal(canonicalContacts.columns.includes("updated_at"), true);
  assert.equal(canonicalContacts.columns.includes("archived"), true);
  assert.ok(CAREER_SCHEMA_REQUIREMENTS.requiredTables.some(
    ({ name }) => name === "career_contact_jobs",
  ));
  assert.ok(CAREER_SCHEMA_REQUIREMENTS.requiredTables.some(
    ({ name }) => name === "career_contact_interactions",
  ));
});

test("v1 restore migrates contacts without inventing interactions, links, or tasks", () => {
  const database = new sqlite3.oo1.DB(":memory:", "c");
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA application_id = ${CAREER_APPLICATION_ID};
      PRAGMA user_version = 1;
      CREATE TABLE career_jobs (id TEXT PRIMARY KEY);
      CREATE TABLE career_tasks (
        id TEXT PRIMARY KEY,
        job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        due_at TEXT,
        kind TEXT NOT NULL,
        priority INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE career_contacts (
        id TEXT PRIMARY KEY,
        company TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        last_contact_at TEXT,
        next_follow_up TEXT,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE career_materials (
        id TEXT PRIMARY KEY,
        file_key TEXT,
        file_name TEXT,
        mime_type TEXT,
        byte_size INTEGER
      );
      INSERT INTO career_contacts
        (id,name,channel,last_contact_at,next_follow_up,created_at)
        VALUES (
          'legacy-contact',
          '旧联系人',
          'LinkedIn',
          '2026-01-02T00:00:00.000Z',
          '2026-01-09T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        );
    `);

    executeStatementsAtomically(
      database,
      createCompleteCareerRestoreStatements([], 1),
    );

    assertCanonicalIdentity(database);
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
    assert.deepEqual(database.selectObjects(`SELECT
      last_contact_at,next_follow_up,updated_at,archived
      FROM career_contacts`).map((row) => ({ ...row })), [{
      last_contact_at: "2026-01-02T00:00:00.000Z",
      next_follow_up: "2026-01-09T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      archived: 0,
    }]);
    assert.equal(
      Number(database.selectValue("SELECT COUNT(*) FROM career_contact_interactions")),
      0,
    );
    assert.equal(
      Number(database.selectValue("SELECT COUNT(*) FROM career_contact_jobs")),
      0,
    );
    assert.equal(Number(database.selectValue("SELECT COUNT(*) FROM career_tasks")), 0);
  } finally {
    database.close();
  }
});

test("restore plan rejects duplicate and overlapping keys before SQL", () => {
  const original = metadata("old-a", "a.pdf", "application/pdf", 10);
  const staged = metadata("new-a", "a.pdf", "application/pdf", 10);
  assert.throws(
    () =>
      createCompleteCareerRestoreStatements([
        { original, staged },
        {
          original,
          staged: metadata("new-b", "a.pdf", "application/pdf", 10),
        },
      ]),
    /duplicate original key/,
  );
  assert.throws(
    () =>
      createCompleteCareerRestoreStatements([
        {
          original,
          staged: metadata("old-a", "a.pdf", "application/pdf", 10),
        },
      ]),
    /must not overlap/,
  );
});
