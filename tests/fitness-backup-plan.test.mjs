import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const SHLN = 0x53484c4e;

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

async function loadModules() {
  const schemaOutput = await transpile("lib/schemas/shilian.ts");
  const schemaUrl = `data:text/javascript;base64,${Buffer.from(schemaOutput).toString("base64")}`;
  const planOutput = await transpile("lib/fitness/backup-plan.ts");
  const linkedPlanOutput = planOutput.replace(
    /from\s+["']\.\.\/schemas\/shilian["'];/,
    `from ${JSON.stringify(schemaUrl)};`,
  );
  assert.notEqual(linkedPlanOutput, planOutput, "Fitness plan schema import was not linked");
  const planUrl = `data:text/javascript;base64,${Buffer.from(linkedPlanOutput).toString("base64")}`;
  return Promise.all([import(planUrl), import(schemaUrl)]);
}

function executeRun(database, sql, params = []) {
  const statement = database.prepare(sql);
  try {
    if (Array.isArray(params) ? params.length > 0 : Object.keys(params).length > 0) {
      statement.bind(params);
    }
    while (statement.step()) {
      // Consume every row so PRAGMA and guard statements reach completion.
    }
  } finally {
    statement.finalize();
  }
}

function executePlan(database, statements) {
  database.transaction("IMMEDIATE", () => {
    for (const { sql, params = [] } of statements) {
      executeRun(database, sql, params);
    }
  });
}

const [plan, schema] = await loadModules();
const sqlite3Promise = sqlite3InitModule();

async function databaseFixture(version = 2) {
  assert.ok(version === 1 || version === 2);
  const sqlite3 = await sqlite3Promise;
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  database.transaction("IMMEDIATE", () => {
    const statements = version === 1
      ? schema.SHILIAN_V1_SCHEMA_STATEMENTS
      : schema.SHILIAN_SCHEMA_STATEMENTS;
    for (const { sql } of statements) {
      database.exec(sql);
    }
    executeRun(
      database,
      "INSERT INTO fitness_schema_migrations(version,name,applied_at) VALUES(?,?,?)",
      [1, schema.SHILIAN_V1_MIGRATION_NAME, 1_777_000_000_000],
    );
    if (version === 2) {
      executeRun(
        database,
        "INSERT INTO fitness_schema_migrations(version,name,applied_at) VALUES(?,?,?)",
        [2, schema.SHILIAN_V2_MIGRATION_NAME, 1_777_000_000_001],
      );
    }
    database.exec(`PRAGMA application_id=${SHLN}`);
    database.exec(`PRAGMA user_version=${version}`);
  });
  return database;
}

const entityTypes = ["venue", "equipment", "exercise", "session"];

function metadata(index, overrides = {}) {
  const entityType = entityTypes[index % entityTypes.length];
  return {
    id: `file-${String(index + 1).padStart(3, "0")}`,
    entityType,
    entityId: `${entityType}-${String(index + 1).padStart(3, "0")}`,
    purpose: index % 2 === 0 ? "photo" : "instruction",
    key: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    originalName: `File ${index + 1}.webp`,
    mimeType: "image/webp",
    byteSize: 100 + index,
    sha256: String(index % 10).repeat(64),
    status: "ready",
    createdAt: 1_777_000_000_000 + index,
    updatedAt: 1_777_000_100_000 + index,
    ...overrides,
  };
}

function mapping(index, originalOverrides = {}, stagedOverrides = {}) {
  const original = metadata(index, originalOverrides);
  return {
    original,
    staged: {
      ...original,
      key: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      ...stagedOverrides,
    },
  };
}

function insertFile(database, file) {
  executeRun(
    database,
    `INSERT INTO fitness_files(
      id,entity_type,entity_id,purpose,file_key,file_name,mime_type,byte_size,
      sha256,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      file.id,
      file.entityType,
      file.entityId,
      file.purpose,
      file.key,
      file.originalName,
      file.mimeType,
      file.byteSize,
      file.sha256,
      file.status,
      file.createdAt,
      file.updatedAt,
    ],
  );
}

function fileRows(database) {
  return database.selectObjects(
    `SELECT id,entity_type entityType,entity_id entityId,purpose,
      file_key key,file_name originalName,mime_type mimeType,byte_size byteSize,
      sha256,status,created_at createdAt,updated_at updatedAt
    FROM fitness_files ORDER BY id`,
  ).map((row) => ({ ...row }));
}

function identity(database) {
  return {
    applicationId: Number(database.selectValue("PRAGMA application_id")),
    userVersion: Number(database.selectValue("PRAGMA user_version")),
  };
}

function insertV1ProgramDay(database) {
  executeRun(
    database,
    "INSERT INTO fitness_venues(id,name,venue_type,location,area_notes,busy_notes,default_session_minutes,supersets_allowed,is_default,status,last_verified_at,created_at,updated_at) VALUES('venue-v1','旧场地','home','','','',60,0,0,'active',NULL,1,1)",
  );
  executeRun(
    database,
    "INSERT INTO fitness_programs(id,name,venue_id,goal,split,status,version,source,assumptions_json,created_at,updated_at) VALUES('program-v1','旧计划','venue-v1','strength','full_body','active',1,'local','[]',1,1)",
  );
  executeRun(
    database,
    "INSERT INTO fitness_program_days(id,program_id,day_index,weekday,kind,name,focus,estimated_minutes,variant,created_at) VALUES('day-v1','program-v1',0,1,'resistance','周一','全身',45,'standard',1)",
  );
}

function insertV1Event(database, id, startsAt, status = "planned") {
  executeRun(
    database,
    "INSERT INTO fitness_calendar_events(id,program_day_id,venue_id,title,kind,starts_at,planned_minutes,status,rescheduled_from_id,note,created_at,updated_at) VALUES(?,'day-v1','venue-v1','周一','resistance',?,45,?,NULL,'历史备注',2,3)",
    [id, startsAt, status],
  );
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

test("complete restore accepts zero ready files and the exact canonical v2 schema", async () => {
  const database = await databaseFixture();
  try {
    insertFile(database, metadata(9, {
      id: "missing-file",
      key: "30000000-0000-4000-8000-000000000010",
      status: "missing",
    }));
    executePlan(database, plan.createCompleteFitnessRestoreStatements([]));
    assert.deepEqual(identity(database), { applicationId: SHLN, userVersion: 2 });
    assert.equal(fileRows(database).length, 1);
    assert.equal(fileRows(database)[0].status, "missing");
    assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("complete v1 restore derives immutable occurrences and finishes as exact v2", async () => {
  const database = await databaseFixture(1);
  try {
    insertV1ProgramDay(database);
    const startsAt = new Date(2026, 7, 24, 19, 0, 0, 0).getTime();
    insertV1Event(database, "event-v1", startsAt, "completed");

    executePlan(database, plan.createCompleteFitnessRestoreStatements([], 1));

    assert.deepEqual(identity(database), { applicationId: SHLN, userVersion: 2 });
    assert.deepEqual(
      database.selectObjects(
        "SELECT id,starts_at,occurrence_key,status,note,created_at,updated_at FROM fitness_calendar_events",
      ).map((row) => ({ ...row })),
      [{
        id: "event-v1",
        starts_at: startsAt,
        occurrence_key: localDateKey(startsAt),
        status: "completed",
        note: "历史备注",
        created_at: 2,
        updated_at: 3,
      }],
    );
    assert.deepEqual(
      database.selectObjects("PRAGMA table_info(fitness_calendar_events)").map(({ name }) => name),
      [...schema.SHILIAN_TABLE_COLUMNS.fitness_calendar_events],
    );
    assert.equal(
      database.selectValue(
        "SELECT name FROM sqlite_schema WHERE type='index' AND name='fitness_events_occurrence_idx'",
      ),
      "fitness_events_occurrence_idx",
    );
  } finally {
    database.close();
  }
});

test("complete v1 restore rolls back entirely when occurrence identities collide", async () => {
  const database = await databaseFixture(1);
  try {
    insertV1ProgramDay(database);
    const startsAt = new Date(2026, 7, 24, 9, 0, 0, 0).getTime();
    insertV1Event(database, "event-a", startsAt);
    insertV1Event(database, "event-b", startsAt + 3_600_000);
    const before = database.selectObjects("SELECT * FROM fitness_calendar_events ORDER BY id")
      .map((row) => ({ ...row }));

    assert.throws(
      () => executePlan(database, plan.createCompleteFitnessRestoreStatements([], 1)),
      /CHECK constraint failed/,
    );

    assert.deepEqual(identity(database), { applicationId: SHLN, userVersion: 1 });
    assert.deepEqual(
      database.selectObjects("SELECT * FROM fitness_calendar_events ORDER BY id")
        .map((row) => ({ ...row })),
      before,
    );
    assert.deepEqual(
      database.selectObjects("PRAGMA table_info(fitness_calendar_events)").map(({ name }) => name),
      [...schema.SHILIAN_V1_TABLE_COLUMNS.fitness_calendar_events],
    );
    assert.deepEqual(
      database.selectObjects("SELECT version,name FROM fitness_schema_migrations")
        .map((row) => ({ ...row })),
      [{ version: 1, name: schema.SHILIAN_V1_MIGRATION_NAME }],
    );
  } finally {
    database.close();
  }
});

test("complete restore remaps venue, equipment, exercise, and session payloads exactly", async () => {
  const database = await databaseFixture();
  try {
    const mappings = entityTypes.map((_, index) => mapping(index));
    for (const { original } of mappings) insertFile(database, original);
    insertFile(database, metadata(8, {
      id: "deleting-file",
      key: "30000000-0000-4000-8000-000000000009",
      status: "deleting",
    }));

    executePlan(
      database,
      plan.createCompleteFitnessRestoreStatements(mappings),
    );
    const rows = fileRows(database);
    assert.deepEqual(
      rows.filter(({ status }) => status === "ready"),
      mappings.map(({ staged }) => staged),
    );
    assert.equal(rows.find(({ id }) => id === "deleting-file")?.status, "deleting");
    assert.equal(
      rows.find(({ id }) => id === "deleting-file")?.key,
      "30000000-0000-4000-8000-000000000009",
    );
  } finally {
    database.close();
  }
});

test("missing, extra, or metadata-mismatched ready payloads abort without a partial remap", async () => {
  const cases = [
    {
      label: "missing second payload",
      mappings: [mapping(0)],
    },
    {
      label: "extra payload",
      mappings: [mapping(0), mapping(1), mapping(7)],
    },
    {
      label: "file name mismatch",
      mappings: [mapping(0), mapping(1, { originalName: "wrong.webp" })],
    },
    {
      label: "MIME mismatch",
      mappings: [mapping(0), mapping(1, { mimeType: "image/png" })],
    },
    {
      label: "byte size mismatch",
      mappings: [mapping(0), mapping(1, { byteSize: 999 })],
    },
    {
      label: "hash mismatch",
      mappings: [mapping(0), mapping(1, { sha256: "f".repeat(64) })],
    },
    {
      label: "entity metadata mismatch",
      mappings: [mapping(0), mapping(1, { entityId: "other-equipment" })],
    },
  ];

  for (const entry of cases) {
    const database = await databaseFixture();
    try {
      const originalRows = [mapping(0).original, mapping(1).original];
      for (const file of originalRows) insertFile(database, file);
      assert.throws(
        () => executePlan(
          database,
          plan.createCompleteFitnessRestoreStatements(entry.mappings),
        ),
        /CHECK constraint failed/,
        entry.label,
      );
      assert.deepEqual(fileRows(database), originalRows);
    } finally {
      database.close();
    }
  }
});

test("exact schema and identity guard rejects altered candidates", async (t) => {
  const cases = [
    {
      name: "wrong application id",
      mutate(database) { database.exec("PRAGMA application_id=0"); },
    },
    {
      name: "future user version",
      mutate(database) { database.exec("PRAGMA user_version=3"); },
    },
    {
      name: "unknown table",
      mutate(database) { database.exec("CREATE TABLE unrelated_data(id TEXT)"); },
    },
    {
      name: "extra column",
      mutate(database) {
        database.exec("ALTER TABLE fitness_settings ADD COLUMN unexpected TEXT");
      },
    },
    {
      name: "unknown index",
      mutate(database) {
        database.exec("CREATE INDEX unexpected_index ON fitness_settings(value)");
      },
    },
    {
      name: "missing canonical index",
      mutate(database) { database.exec("DROP INDEX fitness_files_entity_idx"); },
    },
    {
      name: "altered migration ledger",
      mutate(database) {
        database.exec("UPDATE fitness_schema_migrations SET name='invented-schema' WHERE version=2");
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const database = await databaseFixture();
      try {
        entry.mutate(database);
        assert.throws(
          () => executePlan(
            database,
            plan.createCompleteFitnessRestoreStatements([]),
          ),
          /CHECK constraint failed/,
        );
      } finally {
        database.close();
      }
    });
  }

  await t.test("altered exact v1 source", async () => {
    const database = await databaseFixture(1);
    try {
      database.exec("CREATE TABLE unexpected_v1_object(id TEXT) STRICT");
      assert.throws(
        () => executePlan(
          database,
          plan.createCompleteFitnessRestoreStatements([], 1),
        ),
        /CHECK constraint failed/,
      );
      assert.deepEqual(identity(database), { applicationId: SHLN, userVersion: 1 });
      assert.deepEqual(
        database.selectObjects("PRAGMA table_info(fitness_calendar_events)")
          .map(({ name }) => name),
        [...schema.SHILIAN_V1_TABLE_COLUMNS.fitness_calendar_events],
      );
    } finally {
      database.close();
    }
  });

  assert.throws(
    () => plan.createCompleteFitnessRestoreStatements([], 0),
    /Unsupported Fitness restore source user_version/,
  );
  assert.throws(
    () => plan.createLegacyFitnessRestoreStatements(3),
    /Unsupported Fitness restore source user_version/,
  );
});

test("duplicate, overlapping, stale, and mutated staged mappings are rejected before SQL", () => {
  const valid = mapping(0);
  assert.throws(
    () => plan.createCompleteFitnessRestoreStatements([valid, valid]),
    /duplicate file row id/,
  );
  assert.throws(
    () => plan.createCompleteFitnessRestoreStatements([
      valid,
      mapping(1, {}, { key: valid.staged.key }),
    ]),
    /duplicate staged key/,
  );
  assert.throws(
    () => plan.createCompleteFitnessRestoreStatements([
      valid,
      mapping(1, { key: valid.staged.key }),
    ]),
    /must not overlap original keys/,
  );
  assert.throws(
    () => plan.createCompleteFitnessRestoreStatements([
      { original: valid.original, staged: { ...valid.staged, key: valid.original.key } },
    ]),
    /fresh staged key/,
  );
  assert.throws(
    () => plan.createCompleteFitnessRestoreStatements([
      { original: valid.original, staged: { ...valid.staged, sha256: "f".repeat(64) } },
    ]),
    /immutable file metadata/,
  );
  assert.throws(
    () => plan.createCompleteFitnessRestoreStatements([
      { ...valid, unexpected: true },
    ]),
    /mapping 0 is invalid/,
  );
});

test("legacy raw v1 SQLite restore migrates to v2 and removes all OPFS-binding rows", async () => {
  const database = await databaseFixture(1);
  try {
    insertFile(database, mapping(0).original);
    insertFile(database, metadata(1, { status: "missing" }));
    insertFile(database, metadata(2, { status: "deleting" }));
    executePlan(database, plan.createLegacyFitnessRestoreStatements(1));
    assert.deepEqual(fileRows(database), []);
    assert.deepEqual(identity(database), { applicationId: SHLN, userVersion: 2 });
    assert.deepEqual(
      database.selectObjects("SELECT version,name FROM fitness_schema_migrations ORDER BY version")
        .map((row) => ({ ...row })),
      [
        { version: 1, name: schema.SHILIAN_V1_MIGRATION_NAME },
        { version: 2, name: schema.SHILIAN_V2_MIGRATION_NAME },
      ],
    );
  } finally {
    database.close();
  }
});

test("restore SQL keeps file values parameterized and staged requirements canonical", () => {
  const one = mapping(0);
  const statements = plan.createCompleteFitnessRestoreStatements([one]);
  const update = statements.find(({ sql }) => sql.includes("UPDATE fitness_files"));
  assert.ok(update);
  assert.ok(update.params.includes(one.original.key));
  assert.ok(update.params.includes(one.staged.key));
  assert.ok(!update.sql.includes(one.original.key));
  assert.ok(!update.sql.includes(one.staged.key));

  assert.equal(plan.FITNESS_APPLICATION_ID, SHLN);
  assert.equal(plan.FITNESS_USER_VERSION, 2);
  assert.equal(plan.FITNESS_SCHEMA_REQUIREMENTS.minimumUserVersion, 2);
  assert.equal(plan.FITNESS_SCHEMA_REQUIREMENTS.maximumUserVersion, 2);
  assert.deepEqual(plan.FITNESS_SCHEMA_REQUIREMENTS.sourceApplicationIds, [SHLN]);
  assert.equal(plan.FITNESS_SCHEMA_REQUIREMENTS.sourceMinimumUserVersion, 1);
  assert.equal(plan.FITNESS_SCHEMA_REQUIREMENTS.sourceMaximumUserVersion, 2);
  assert.deepEqual(
    plan.FITNESS_SCHEMA_REQUIREMENTS.requiredTables.map(({ name }) => name),
    schema.SHILIAN_TABLES,
  );
  assert.deepEqual(
    plan.FITNESS_SCHEMA_REQUIREMENTS.requiredTables.find(
      ({ name }) => name === "fitness_files",
    )?.columns,
    schema.SHILIAN_TABLE_COLUMNS.fitness_files,
  );
  assert.deepEqual(
    plan.FITNESS_SCHEMA_REQUIREMENTS.sourceRequiredTables.find(
      ({ name }) => name === "fitness_calendar_events",
    )?.columns,
    schema.SHILIAN_V1_TABLE_COLUMNS.fitness_calendar_events,
  );
  assert.deepEqual(plan.FITNESS_SCHEMA_REQUIREMENTS.allowedViews, []);
  assert.deepEqual(plan.FITNESS_SCHEMA_REQUIREMENTS.allowedTriggers, []);
});
