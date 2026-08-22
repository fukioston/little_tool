import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

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
    diagnostics.filter(
      ({ category }) => category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  return outputText;
}

const schemaJavaScript = await transpile("lib/schemas/zhiji.ts");
const schemaUrl = moduleUrl(schemaJavaScript);
const schema = await import(schemaUrl);
let backupPlanJavaScript = await transpile("lib/career/backup-plan.ts");
backupPlanJavaScript = backupPlanJavaScript.replaceAll(
  '"../schemas/zhiji"',
  `"${schemaUrl}"`,
);

const [sqlite3, restorePlan] = await Promise.all([
  sqlite3InitModule(),
  import(moduleUrl(backupPlanJavaScript)),
]);
const {
  CAREER_APPLICATION_ID,
  CAREER_SCHEMA_REQUIREMENTS,
  CAREER_USER_VERSION,
  createCompleteCareerRestoreStatements,
  createLegacyCareerRestoreStatements,
} = restorePlan;

function executeStatements(database, statements) {
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
}

function executeStatementsAtomically(database, statements) {
  database.transaction("IMMEDIATE", () => {
    executeStatements(database, statements);
  });
}

function createVersionDatabase(version, { facts = false, materials = [] } = {}) {
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  const statements = [...schema.ZHIJI_V1_SCHEMA_STATEMENTS];
  if (version >= 2) statements.push(...schema.ZHIJI_V2_SCHEMA_MIGRATION_STATEMENTS);
  if (version >= 3) statements.push(...schema.ZHIJI_V3_SCHEMA_MIGRATION_STATEMENTS);
  if (version >= 4) statements.push(...schema.ZHIJI_V4_SCHEMA_MIGRATION_STATEMENTS);
  if (version >= 5) statements.push(...schema.ZHIJI_V5_SCHEMA_MIGRATION_STATEMENTS);
  statements.push(
    {
      sql: `PRAGMA application_id = ${
        version === 0 ? 0 : CAREER_APPLICATION_ID
      }`,
    },
    { sql: `PRAGMA user_version = ${version}` },
  );
  executeStatementsAtomically(database, statements);

  if (facts) insertBusinessFacts(database);
  for (const row of materials) insertMaterial(database, row);
  return database;
}

function createDatabase(materials = []) {
  return createVersionDatabase(5, { materials });
}

function createDirectVersionTwoDatabase({
  applicationId = CAREER_APPLICATION_ID,
  userVersion = 2,
  materials = [],
} = {}) {
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  const objectSql = Object.entries(
    schema.ZHIJI_SCHEMA_OBJECT_SQL_VARIANTS[2],
  ).map(([name, variants]) => ({
    name,
    sql: name === "career_contacts" || name === "career_tasks"
      ? variants[1]
      : variants[0],
  }));
  executeStatementsAtomically(database, [
    ...objectSql.filter(({ sql }) => /^CREATE\s+TABLE\b/i.test(sql)),
    ...objectSql.filter(({ sql }) => /^CREATE\s+INDEX\b/i.test(sql)),
    { sql: `PRAGMA application_id=${applicationId}` },
    { sql: `PRAGMA user_version=${userVersion}` },
  ]);
  for (const row of materials) insertMaterial(database, row);
  return database;
}

function insertBusinessFacts(database) {
  database.exec(`
    INSERT INTO career_stages
      (id,name,color,position,is_terminal,hidden)
      VALUES ('stage-active','进行中','#4477aa',0,0,0);
    INSERT INTO career_jobs
      (id,company,role,location,source,source_url,stage_id,priority,salary,
       work_mode,description,applied_at,deadline,contact_name,note,tags,
       created_at,updated_at,archived,position)
      VALUES ('job-fact','保留公司','产品设计师','上海','BOSS直聘',
       'https://example.test/job', 'stage-active',2,'20k-30k','hybrid',
       '事实不能丢','2026-01-02T00:00:00.000Z','2026-02-01T00:00:00.000Z',
       '招聘同学','保持原样','产品,设计','2026-01-01T00:00:00.000Z',
       '2026-01-03T00:00:00.000Z',0,7);
    INSERT INTO career_contacts
      (id,company,name,role,channel,email,phone,last_contact_at,next_follow_up,
       notes,created_at)
      VALUES ('contact-fact','保留公司','旧联系人','招聘经理','LinkedIn',
       'person@example.test','123','2026-01-02T00:00:00.000Z',
       '2026-01-09T00:00:00.000Z','联系人事实',
       '2026-01-01T00:00:00.000Z');
    INSERT INTO career_tasks
      (id,job_id,title,due_at,kind,priority,status,created_at)
      VALUES ('task-fact','job-fact','发送跟进','2026-02-02T00:00:00.000Z',
       '跟进',3,'todo','2026-01-01T00:00:00.000Z');
    INSERT INTO career_interviews
      (id,job_id,round_name,interview_type,scheduled_at,duration,interviewer,
       meeting_url,status,summary,raw_notes,questions_json,reflection,
       created_at,updated_at)
      VALUES ('interview-fact','job-fact','一面','视频面试',
       '2026-02-03T00:00:00.000Z',60,'面试官','https://example.test/meet',
       'scheduled','摘要','原始笔记','["问题"]','复盘',
       '2026-01-01T00:00:00.000Z','2026-01-04T00:00:00.000Z');
    INSERT INTO career_activity (id,job_id,type,detail,created_at)
      VALUES ('activity-fact','job-fact','note','活动事实',
       '2026-01-05T00:00:00.000Z');
    INSERT INTO career_settings (key,value)
      VALUES ('fact-setting','保留设置');
  `);
}

function insertMaterial(database, row) {
  const statement = database.prepare(`INSERT INTO career_materials
    (id,name,updated_at,file_key,file_name,mime_type,byte_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  try {
    statement.bind([
      row.id,
      row.name ?? row.id,
      row.updatedAt ?? "2026-01-01T00:00:00.000Z",
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

function businessFacts(database) {
  return {
    jobs: database.selectObjects(`SELECT id,company,role,stage_id,priority,
      note,created_at,updated_at,archived,position FROM career_jobs ORDER BY id`)
      .map((row) => ({ ...row })),
    contacts: database.selectObjects(`SELECT id,company,name,channel,
      last_contact_at,next_follow_up,notes,created_at
      FROM career_contacts ORDER BY id`).map((row) => ({ ...row })),
    tasks: database.selectObjects(`SELECT id,job_id,title,due_at,kind,priority,
      status,created_at FROM career_tasks ORDER BY id`).map((row) => ({ ...row })),
    interviews: database.selectObjects(`SELECT id,job_id,round_name,
      scheduled_at,duration,status,summary,raw_notes,questions_json,reflection,
      created_at,updated_at FROM career_interviews ORDER BY id`)
      .map((row) => ({ ...row })),
    activity: database.selectObjects(`SELECT id,job_id,type,detail,created_at
      FROM career_activity ORDER BY id`).map((row) => ({ ...row })),
    settings: database.selectObjects(`SELECT key,value FROM career_settings
      ORDER BY key`).map((row) => ({ ...row })),
  };
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

function assertCanonicalLedger(database) {
  assert.deepEqual(database.selectObjects(`SELECT version,name,
    CASE WHEN applied_at <> '' THEN 1 ELSE 0 END AS hasAppliedAt
    FROM career_schema_migrations ORDER BY version`).map((row) => ({ ...row })), [
    {
      version: 1,
      name: schema.ZHIJI_V1_MIGRATION_NAME,
      hasAppliedAt: 1,
    },
    {
      version: 2,
      name: schema.ZHIJI_V2_MIGRATION_NAME,
      hasAppliedAt: 1,
    },
    {
      version: 3,
      name: schema.ZHIJI_V3_MIGRATION_NAME,
      hasAppliedAt: 1,
    },
    {
      version: 4,
      name: schema.ZHIJI_V4_MIGRATION_NAME,
      hasAppliedAt: 1,
    },
    {
      version: 5,
      name: schema.ZHIJI_V5_MIGRATION_NAME,
      hasAppliedAt: 1,
    },
  ]);
}

function assertNoRestoreGuards(database) {
  assert.equal(
    Number(database.selectValue(`SELECT COUNT(*) FROM temp.sqlite_temp_schema
      WHERE type = 'table' AND name IN (
        '__career_restore_guard','__career_restore_schema_guard'
      )`)),
    0,
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
    assertCanonicalLedger(database);
    assertNoRestoreGuards(database);
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
      assertCanonicalIdentity(database);
      assertCanonicalLedger(database);
      assertNoRestoreGuards(database);
    } finally {
      database.close();
    }
  });
}

test("zero-attachment restore accepts no real references", () => {
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
    assertNoRestoreGuards(database);
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
    assertCanonicalLedger(database);
  } finally {
    database.close();
  }
});

test("restore plan publishes the canonical v5 Career schema identity", () => {
  assert.equal(CAREER_APPLICATION_ID, 0x5a484a49);
  assert.equal(CAREER_USER_VERSION, 5);
  assert.deepEqual(CAREER_SCHEMA_REQUIREMENTS.sourceApplicationIds, [
    0,
    CAREER_APPLICATION_ID,
  ]);
  assert.equal(CAREER_SCHEMA_REQUIREMENTS.applicationId, CAREER_APPLICATION_ID);
  assert.equal(CAREER_SCHEMA_REQUIREMENTS.minimumUserVersion, 5);
  assert.equal(CAREER_SCHEMA_REQUIREMENTS.maximumUserVersion, 5);
  assert.equal(CAREER_SCHEMA_REQUIREMENTS.sourceMinimumUserVersion, 0);
  assert.equal(CAREER_SCHEMA_REQUIREMENTS.sourceMaximumUserVersion, 5);

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
  const canonicalJobs = CAREER_SCHEMA_REQUIREMENTS.requiredTables.find(
    ({ name }) => name === "career_jobs",
  );
  const coreWriteOperations = CAREER_SCHEMA_REQUIREMENTS.requiredTables.find(
    ({ name }) => name === "career_core_write_operations",
  );
  const writeOperations = CAREER_SCHEMA_REQUIREMENTS.requiredTables.find(
    ({ name }) => name === "career_write_operations",
  );
  assert.equal(sourceContacts.columns.includes("updated_at"), false);
  assert.equal(sourceContacts.columns.includes("archived"), false);
  assert.equal(canonicalContacts.columns.includes("updated_at"), true);
  assert.equal(canonicalContacts.columns.includes("archived"), true);
  assert.equal(canonicalJobs.columns.includes("archived_at"), true);
  assert.equal(canonicalJobs.columns.includes("ended_at"), true);
  assert.deepEqual(coreWriteOperations?.columns, [
    "operation_id",
    "purpose",
    "receipt_version",
    "kind",
    "entity_id",
    "projection_sha256",
    "operation_at",
  ]);
  assert.deepEqual(writeOperations?.columns, coreWriteOperations?.columns);
  assert.equal(
    CAREER_SCHEMA_REQUIREMENTS.sourceRequiredTables.some(
      ({ name }) => name === "career_core_write_operations",
    ),
    false,
  );
  for (const name of [
    "career_schema_migrations",
    "career_contact_jobs",
    "career_contact_interactions",
    "career_lifecycle_events",
    "career_core_write_operations",
    "career_write_operations",
  ]) {
    assert.ok(
      CAREER_SCHEMA_REQUIREMENTS.requiredTables.some((table) => table.name === name),
    );
  }
});

test("v4 and v5 restores preserve existing immutable operation proofs", () => {
  for (const sourceVersion of [4, 5]) {
    const database = createVersionDatabase(sourceVersion);
    try {
      database.exec(`INSERT INTO career_core_write_operations(
        operation_id,purpose,receipt_version,kind,entity_id,
        projection_sha256,operation_at
      ) VALUES(
        'career-core-operation-40000000-0000-4000-8000-000000000004',
        'career-core-write',1,'stage-rename','stage_saved',
        '${"a".repeat(64)}','2026-08-20T01:00:00.000Z'
      )`);
      if (sourceVersion === 5) {
        database.exec(`INSERT INTO career_write_operations(
          operation_id,purpose,receipt_version,kind,entity_id,
          projection_sha256,operation_at
        ) VALUES('future-operation','career-contact-write',1,'contact-update',
          'contact-1','${"b".repeat(64)}','2026-08-20T01:00:00.000Z')`);
      }
      executeStatementsAtomically(
        database,
        createCompleteCareerRestoreStatements([], sourceVersion),
      );
      assert.equal(
        Number(database.selectValue("SELECT COUNT(*) FROM career_core_write_operations")),
        1,
      );
      assert.equal(
        Number(database.selectValue("SELECT COUNT(*) FROM career_write_operations")),
        sourceVersion === 5 ? 1 : 0,
      );
      if (sourceVersion === 5) {
        assert.deepEqual(
          database.selectObject(`SELECT purpose,kind FROM career_write_operations
            WHERE operation_id='future-operation'`),
          { purpose: "career-contact-write", kind: "contact-update" },
        );
      }
      assertCanonicalLedger(database);
    } finally {
      database.close();
    }
  }
});

for (const sourceVersion of [0, 1, 2, 3, 4, 5]) {
  test(`complete restore stages v${sourceVersion} to canonical v5 without losing facts`, () => {
    const originalKey = `source-v${sourceVersion}`;
    const stagedKey = `staged-v${sourceVersion}`;
    const database = createVersionDatabase(sourceVersion, {
      facts: true,
      materials: [{
        id: "material-fact",
        fileKey: originalKey,
        fileName: "事实简历.pdf",
        mimeType: "application/pdf",
        byteSize: 321,
      }],
    });
    const beforeFacts = businessFacts(database);
    try {
      executeStatementsAtomically(
        database,
        createCompleteCareerRestoreStatements([{
          original: metadata(originalKey, "事实简历.pdf", "application/pdf", 321),
          staged: metadata(stagedKey, "事实简历.pdf", "application/pdf", 321),
        }], sourceVersion),
      );

      assertCanonicalIdentity(database);
      assertCanonicalLedger(database);
      assert.deepEqual(businessFacts(database), beforeFacts);
      assert.deepEqual(materialRows(database), [{
        id: "material-fact",
        fileKey: stagedKey,
        fileName: "事实简历.pdf",
        mimeType: "application/pdf",
        byteSize: 321,
      }]);
      assert.equal(
        Number(database.selectValue("SELECT COUNT(*) FROM career_contact_jobs")),
        0,
      );
      assert.equal(
        Number(database.selectValue(
          "SELECT COUNT(*) FROM career_contact_interactions",
        )),
        0,
      );
      assert.equal(
        Number(database.selectValue("SELECT COUNT(*) FROM career_lifecycle_events")),
        0,
      );
      assert.equal(
        Number(database.selectValue("SELECT COUNT(*) FROM career_core_write_operations")),
        0,
      );
      assertNoRestoreGuards(database);
    } finally {
      database.close();
    }
  });

  test(`legacy restore stages v${sourceVersion} to canonical v5 and clears file references`, () => {
    const database = createVersionDatabase(sourceVersion, {
      facts: true,
      materials: [{
        id: "material-fact",
        fileKey: `raw-v${sourceVersion}`,
        fileName: "原始备份简历.pdf",
        mimeType: "application/pdf",
        byteSize: 654,
      }],
    });
    const beforeFacts = businessFacts(database);
    try {
      executeStatementsAtomically(
        database,
        createLegacyCareerRestoreStatements(sourceVersion),
      );

      assertCanonicalIdentity(database);
      assertCanonicalLedger(database);
      assert.deepEqual(businessFacts(database), beforeFacts);
      assert.deepEqual(materialRows(database), [{
        id: "material-fact",
        fileKey: null,
        fileName: null,
        mimeType: null,
        byteSize: null,
      }]);
      assertNoRestoreGuards(database);
    } finally {
      database.close();
    }
  });
}

test("v2 complete and legacy restores normalize the known canceled alias", () => {
  for (const createPlan of [
    () => createCompleteCareerRestoreStatements([], 2),
    () => createLegacyCareerRestoreStatements(2),
  ]) {
    const database = createVersionDatabase(2, { facts: true });
    try {
      database.exec(`
        UPDATE career_tasks SET status='cancelled' WHERE id='task-fact';
        UPDATE career_interviews SET status='cancelled' WHERE id='interview-fact';
      `);
      executeStatementsAtomically(database, createPlan());

      assertCanonicalIdentity(database);
      assert.equal(
        database.selectValue("SELECT status FROM career_tasks WHERE id='task-fact'"),
        "canceled",
      );
      assert.equal(
        database.selectValue(
          "SELECT status FROM career_interviews WHERE id='interview-fact'",
        ),
        "canceled",
      );
      assertNoRestoreGuards(database);
    } finally {
      database.close();
    }
  }
});

test("v1 migration preserves contact history without inventing linked records", () => {
  const database = createVersionDatabase(1, { facts: true });
  try {
    executeStatementsAtomically(
      database,
      createCompleteCareerRestoreStatements([], 1),
    );

    assertCanonicalIdentity(database);
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
    assert.equal(Number(database.selectValue("SELECT COUNT(*) FROM career_tasks")), 1);
  } finally {
    database.close();
  }
});

test("strict guard rejects a wrong Career identity before changing rows", () => {
  const database = createVersionDatabase(2, {
    materials: [{
      id: "identity-material",
      fileKey: "old-key",
      fileName: "a.pdf",
      mimeType: "application/pdf",
      byteSize: 10,
    }],
  });
  database.exec("PRAGMA application_id=12345");
  const before = materialRows(database);
  try {
    assert.throws(() => executeStatementsAtomically(
      database,
      createLegacyCareerRestoreStatements(2),
    ));
    assert.deepEqual(materialRows(database), before);
    assert.equal(Number(database.selectValue("PRAGMA application_id")), 12345);
    assert.equal(Number(database.selectValue("PRAGMA user_version")), 2);
    assertNoRestoreGuards(database);
  } finally {
    database.close();
  }
});

test("strict guard rejects altered DDL with the same object name", () => {
  const database = createDatabase([{ id: "ddl-material" }]);
  database.exec(`
    DROP INDEX idx_career_tasks_due;
    CREATE INDEX idx_career_tasks_due ON career_tasks(due_at,status);
  `);
  const before = materialRows(database);
  try {
    assert.throws(() => executeStatementsAtomically(
      database,
      createCompleteCareerRestoreStatements([]),
    ));
    assert.deepEqual(materialRows(database), before);
    assertCanonicalIdentity(database);
    assertNoRestoreGuards(database);
  } finally {
    database.close();
  }
});

test("strict guard rejects a corrupted v4 migration ledger", () => {
  const database = createDatabase([{ id: "ledger-material" }]);
  database.exec(`UPDATE career_schema_migrations
    SET name='tampered-contact-history' WHERE version=2`);
  const before = materialRows(database);
  try {
    assert.throws(() => executeStatementsAtomically(
      database,
      createLegacyCareerRestoreStatements(4),
    ));
    assert.deepEqual(materialRows(database), before);
    assert.equal(
      database.selectValue(
        "SELECT name FROM career_schema_migrations WHERE version=2",
      ),
      "tampered-contact-history",
    );
    assertCanonicalIdentity(database);
    assertNoRestoreGuards(database);
  } finally {
    database.close();
  }
});

test("external restores reject v2 DDL that falsely declares user_version 3", () => {
  const database = createVersionDatabase(2, {
    facts: true,
    materials: [{ id: "interrupted-material" }],
  });
  database.exec("PRAGMA user_version=3");
  const beforeFacts = businessFacts(database);
  try {
    for (const statements of [
      createCompleteCareerRestoreStatements([], 3),
      createLegacyCareerRestoreStatements(3),
    ]) {
      assert.throws(() => executeStatementsAtomically(database, statements));
      assert.deepEqual(businessFacts(database), beforeFacts);
      assert.equal(Number(database.selectValue("PRAGMA user_version")), 3);
      assert.equal(
        Number(database.selectValue(`SELECT COUNT(*) FROM sqlite_schema
          WHERE name IN ('career_schema_migrations','career_lifecycle_events')`)),
        0,
      );
      assertNoRestoreGuards(database);
    }
  } finally {
    database.close();
  }
});

test("external restores reject both historical runtime-only interrupted-v2 identities", () => {
  const migratedV1 = createVersionDatabase(2, {
    materials: [{ id: "interrupted-v1-material" }],
  });
  migratedV1.exec("PRAGMA user_version=1");
  const directV0 = createDirectVersionTwoDatabase({
    applicationId: 0,
    userVersion: 0,
    materials: [{ id: "interrupted-v0-material" }],
  });
  for (const [database, sourceVersion] of [
    [migratedV1, 1],
    [directV0, 0],
  ]) {
    const before = materialRows(database);
    try {
      for (const statements of [
        createCompleteCareerRestoreStatements([], sourceVersion),
        createLegacyCareerRestoreStatements(sourceVersion),
      ]) {
        assert.throws(() => executeStatementsAtomically(database, statements));
        assert.deepEqual(materialRows(database), before);
        assert.equal(
          Number(database.selectValue("PRAGMA user_version")),
          sourceVersion,
        );
        assertNoRestoreGuards(database);
      }
    } finally {
      database.close();
    }
  }
});

test("a late SQL failure rolls attachment remapping and v2 migration back together", () => {
  const database = createVersionDatabase(2, {
    materials: [{
      id: "rollback-material",
      fileKey: "before-rollback",
      fileName: "rollback.pdf",
      mimeType: "application/pdf",
      byteSize: 44,
    }],
  });
  const before = materialRows(database);
  const statements = createCompleteCareerRestoreStatements([{
    original: metadata("before-rollback", "rollback.pdf", "application/pdf", 44),
    staged: metadata("after-rollback", "rollback.pdf", "application/pdf", 44),
  }], 2);
  statements.push({
    sql: `INSERT INTO career_schema_migrations(version,name,applied_at)
      VALUES (3,'duplicate-version','2026-01-01T00:00:00.000Z')`,
  });

  try {
    assert.throws(() => executeStatementsAtomically(database, statements));
    assert.deepEqual(materialRows(database), before);
    assert.equal(Number(database.selectValue("PRAGMA user_version")), 2);
    assert.equal(
      Number(database.selectValue(`SELECT COUNT(*) FROM sqlite_schema
        WHERE type='table' AND name='career_schema_migrations'`)),
      0,
    );
    assert.equal(
      database.selectObjects("PRAGMA table_info(career_tasks)")
        .some(({ name }) => name === "updated_at"),
      false,
    );
    assertNoRestoreGuards(database);
  } finally {
    database.close();
  }
});

test("restore plan rejects duplicate and overlapping keys before SQL", () => {
  const original = metadata("old-a", "a.pdf", "application/pdf", 10);
  const staged = metadata("new-a", "a.pdf", "application/pdf", 10);
  assert.throws(
    () => createCompleteCareerRestoreStatements([
      { original, staged },
      {
        original,
        staged: metadata("new-b", "a.pdf", "application/pdf", 10),
      },
    ]),
    /duplicate original key/,
  );
  assert.throws(
    () => createCompleteCareerRestoreStatements([{
      original,
      staged: metadata("old-a", "a.pdf", "application/pdf", 10),
    }]),
    /must not overlap/,
  );
});
