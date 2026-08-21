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
    diagnostics.filter(({ category }) => category === ts.DiagnosticCategory.Error),
    [],
  );
  return outputText;
}

function executeRun(database, sql, params = []) {
  const statement = database.prepare(sql);
  try {
    if (params.length) statement.bind(params);
    while (statement.step()) {
      // Consume all rows from PRAGMAs and statements with RETURNING.
    }
  } finally {
    statement.finalize();
  }
  return {
    changes: Number(database.changes()),
    lastInsertRowId: database.selectValue("SELECT last_insert_rowid()") ?? null,
  };
}

function adapterFor(database, state) {
  return {
    async init(name) {
      assert.equal(name, "fitness");
      state.operations.push(["init", name]);
      return {
        database: "shilian",
        filename: "shilian.sqlite3",
        persistent: true,
        sqliteVersion: "test",
        schemaVersion: Number(database.selectValue("PRAGMA user_version") ?? 0),
        seeded: false,
      };
    },
    async query(name, sql, params = []) {
      assert.equal(name, "fitness");
      state.operations.push(["query", name]);
      const rows = database.selectObjects(sql, params);
      return { columns: [], rows, rowCount: rows.length };
    },
    async run(name, sql, params = []) {
      assert.equal(name, "fitness");
      state.operations.push(["run", name]);
      return executeRun(database, sql, params);
    },
    async batch(name, statements, options = {}) {
      assert.equal(name, "fitness");
      state.operations.push(["batch", name]);
      state.batchTransactions.push(options.transaction !== false);
      const operation = () => statements.map(({ sql, params = [] }) =>
        executeRun(database, sql, params)
      );
      const results = options.transaction === false
        ? operation()
        : database.transaction("IMMEDIATE", operation);
      return {
        results,
        changes: results.reduce((sum, result) => sum + result.changes, 0),
      };
    },
  };
}

globalThis.__fitnessLocalDbProxy = {
  init(...args) {
    return globalThis.__fitnessLocalDbAdapter.init(...args);
  },
  query(...args) {
    return globalThis.__fitnessLocalDbAdapter.query(...args);
  },
  run(...args) {
    return globalThis.__fitnessLocalDbAdapter.run(...args);
  },
  batch(...args) {
    return globalThis.__fitnessLocalDbAdapter.batch(...args);
  },
};

globalThis.__fitnessLockState = {
  reads: 0,
  writes: 0,
  broadcasts: [],
};

const [schemaJavaScript, catalogJavaScript, rawStoreJavaScript] = await Promise.all([
  transpile("lib/schemas/shilian.ts"),
  transpile("lib/fitness/catalog.ts"),
  transpile("lib/fitness/store.ts"),
]);
const schemaUrl = moduleUrl(schemaJavaScript);
const catalogUrl = moduleUrl(catalogJavaScript);
const lockUrl = moduleUrl(`
  export async function withFitnessReadLock(task) {
    globalThis.__fitnessLockState.reads += 1;
    return task();
  }
  export async function withFitnessWriteLock(task) {
    globalThis.__fitnessLockState.writes += 1;
    return task();
  }
  export function broadcastFitnessChange(reason) {
    globalThis.__fitnessLockState.broadcasts.push(reason);
  }
`);
const dependencyUrls = {
  "@/lib/local-db/client": moduleUrl(
    "export const localDb = globalThis.__fitnessLocalDbProxy;",
  ),
  "@/lib/schemas/shilian": schemaUrl,
  "./catalog": catalogUrl,
  "./lock": lockUrl,
};
let storeJavaScript = rawStoreJavaScript;
for (const [specifier, url] of Object.entries(dependencyUrls)) {
  storeJavaScript = storeJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const [schema, catalog, store] = await Promise.all([
  import(schemaUrl),
  import(catalogUrl),
  import(moduleUrl(storeJavaScript)),
]);

async function databaseFixture() {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  const state = { operations: [], batchTransactions: [] };
  globalThis.__fitnessLocalDbAdapter = adapterFor(database, state);
  globalThis.__fitnessLockState = { reads: 0, writes: 0, broadcasts: [] };
  return { database, state };
}

function installV1Schema(database, appliedAt = 1_700_000_000_000) {
  database.transaction("IMMEDIATE", () => {
    for (const { sql } of schema.SHILIAN_V1_SCHEMA_STATEMENTS) executeRun(database, sql);
    executeRun(
      database,
      "INSERT INTO fitness_schema_migrations(version,name,applied_at) VALUES(1,?,?)",
      [schema.SHILIAN_V1_MIGRATION_NAME, appliedAt],
    );
    executeRun(database, `PRAGMA application_id=${schema.SHILIAN_APPLICATION_ID}`);
    executeRun(database, "PRAGMA user_version=1");
  });
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

const profileInput = {
  goals: ["strength", "general_health"],
  experience: "returning",
  resistance_days_per_week: 3,
  cardio_days_per_week: 2,
  session_minutes: 60,
  split: "full_body",
  preferred_weekdays: [1, 3, 5],
  preferred_rir: 2,
  rest_seconds: 90,
  unit: "kg",
  notes: "",
};

const venueInput = {
  name: "社区健身房",
  venue_type: "commercial",
  location: "步行十分钟",
  area_notes: "自由力量区在二层",
  busy_notes: "工作日晚间较忙",
  default_session_minutes: 60,
  supersets_allowed: false,
  is_default: true,
  status: "active",
  last_verified_at: null,
};

function dumbbellInput(venueId, loads) {
  return {
    venue_id: venueId,
    name: "固定哑铃",
    kind: "dumbbell",
    area: "自由力量区",
    quantity: 20,
    status: "available",
    load_mode: "discrete",
    load_semantics: "per_hand",
    min_load_grams: 5000,
    max_load_grams: 30000,
    increment_grams: null,
    bar_weight_grams: null,
    unilateral: false,
    busy_level: "medium",
    settings: {},
    attachments: [],
    notes: "",
    loads,
  };
}

function treadmillInput(venueId) {
  return {
    venue_id: venueId,
    name: "靠窗跑步机",
    kind: "treadmill",
    area: "心肺区",
    quantity: 4,
    status: "available",
    load_mode: "range",
    load_semantics: "resistance_level",
    min_load_grams: null,
    max_load_grams: null,
    increment_grams: null,
    bar_weight_grams: null,
    unilateral: false,
    busy_level: "low",
    settings: { max_speed_kph: 18, max_incline_percent: 15 },
    attachments: [],
    notes: "可记录速度与坡度",
    loads: [],
  };
}

function load(loadGrams, label = `${loadGrams / 1000} kg`) {
  return { load_grams: loadGrams, quantity: 2, label, available: true };
}

function draftFor(venueId, equipmentId) {
  return {
    name: "真实器材全身计划",
    venue_id: venueId,
    goal: "strength",
    split: "full_body",
    assumptions: ["按当前场地档位生成"],
    warnings: [],
    days: [{
      weekday: 1,
      kind: "resistance",
      name: "全身 A",
      focus: "髋铰链",
      estimated_minutes: 45,
      items: [{
        exercise_id: "dumbbell-rdl",
        equipment_id: equipmentId,
        resource_equipment_ids: [equipmentId],
        order_index: 0,
        sets: 3,
        rep_min: 8,
        rep_max: 10,
        duration_seconds: null,
        target_rir: 2,
        rest_seconds: 90,
        load_grams: 10000,
        load_guidance: "每手 10 kg",
        rationale: "用真实哑铃档位",
        substitution_exercise_ids: ["kettlebell-deadlift"],
        equipment_snapshot: "forged snapshot must not survive",
      }],
    }],
  };
}

test("fresh initialization has exact identity, exact objects, and zero personal data", async () => {
  const { database, state } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    assert.equal(Number(database.selectValue("PRAGMA application_id")), 0x53484c4e);
    assert.equal(Number(database.selectValue("PRAGMA user_version")), 2);
    assert.deepEqual(
      database.selectObjects("SELECT version,name FROM fitness_schema_migrations ORDER BY version")
        .map((row) => ({ ...row })),
      [
        { version: 1, name: schema.SHILIAN_V1_MIGRATION_NAME },
        { version: 2, name: schema.SHILIAN_V2_MIGRATION_NAME },
      ],
    );
    assert.deepEqual(
      database.selectObjects(
        `SELECT name FROM sqlite_schema
          WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      ).map(({ name }) => name),
      [...schema.SHILIAN_TABLES].sort(),
    );
    assert.deepEqual(
      database.selectObjects(
        `SELECT name FROM sqlite_schema
          WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      ).map(({ name }) => name),
      [...schema.SHILIAN_INDEXES].sort(),
    );
    for (const table of schema.SHILIAN_TABLES) {
      if (table !== "fitness_schema_migrations") {
        assert.equal(Number(database.selectValue(`SELECT COUNT(*) FROM ${table}`)), 0, table);
      }
      assert.deepEqual(
        database.selectObjects(`PRAGMA table_info("${table}")`).map(({ name }) => name),
        [...schema.SHILIAN_TABLE_COLUMNS[table]],
      );
    }
    assert.ok(state.batchTransactions.every(Boolean));
    assert.equal(globalThis.__fitnessLockState.writes, 1);
    assert.deepEqual(globalThis.__fitnessLockState.broadcasts, []);

    database.exec("CREATE TABLE fitness_intruder(secret TEXT) STRICT");
    await assert.rejects(store.initializeFitnessDatabase(), /结构与当前版本不一致/);
    database.exec("DROP TABLE fitness_intruder");
    database.exec("PRAGMA writable_schema=ON");
    executeRun(
      database,
      "UPDATE sqlite_schema SET sql=replace(sql,?,?) WHERE name='fitness_profiles'",
      ["unit IN ('kg','lb')", "unit IN ('KG','LB')"],
    );
    database.exec("PRAGMA writable_schema=OFF");
    await assert.rejects(store.initializeFitnessDatabase(), /定义与当前版本不一致/);
  } finally {
    database.close();
  }
});

test("exact v1 databases migrate atomically to v2 without rewriting calendar facts", async () => {
  const { database } = await databaseFixture();
  try {
    installV1Schema(database, 1234);
    const startsAt = new Date(2026, 7, 24, 19, 0, 0, 0).getTime();
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
    executeRun(
      database,
      "INSERT INTO fitness_calendar_events(id,program_day_id,venue_id,title,kind,starts_at,planned_minutes,status,rescheduled_from_id,note,created_at,updated_at) VALUES('event-v1','day-v1','venue-v1','周一','resistance',?,45,'completed',NULL,'保留事实',2,3)",
      [startsAt],
    );
    executeRun(
      database,
      "INSERT INTO fitness_calendar_events(id,program_day_id,venue_id,title,kind,starts_at,planned_minutes,status,rescheduled_from_id,note,created_at,updated_at) VALUES('manual-v1',NULL,'venue-v1','自由训练','note',?,30,'cancelled','event-v1','手动安排',4,5)",
      [startsAt + 60_000],
    );
    executeRun(
      database,
      "INSERT INTO fitness_sessions(id,event_id,venue_id,program_day_id,started_at,ended_at,status,available_minutes,energy_note,soreness_note,reflection,created_at,updated_at) VALUES('session-v1','event-v1','venue-v1','day-v1',?,?, 'completed',45,'usual','','保留训练事实',6,7)",
      [startsAt, startsAt + 2_700_000],
    );

    await store.initializeFitnessDatabase();

    assert.equal(Number(database.selectValue("PRAGMA user_version")), 2);
    assert.deepEqual(
      database.selectObjects("SELECT version,name,applied_at FROM fitness_schema_migrations ORDER BY version")
        .map((row) => ({ ...row })),
      [
        { version: 1, name: schema.SHILIAN_V1_MIGRATION_NAME, applied_at: 1234 },
        {
          version: 2,
          name: schema.SHILIAN_V2_MIGRATION_NAME,
          applied_at: database.selectValue(
            "SELECT applied_at FROM fitness_schema_migrations WHERE version=2",
          ),
        },
      ],
    );
    assert.deepEqual(
      database.selectObjects(
        "SELECT id,starts_at,occurrence_key,status,note,created_at,updated_at FROM fitness_calendar_events ORDER BY id",
      ).map((row) => ({ ...row })),
      [
        {
          id: "event-v1",
          starts_at: startsAt,
          occurrence_key: localDateKey(startsAt),
          status: "completed",
          note: "保留事实",
          created_at: 2,
          updated_at: 3,
        },
        {
          id: "manual-v1",
          starts_at: startsAt + 60_000,
          occurrence_key: null,
          status: "cancelled",
          note: "手动安排",
          created_at: 4,
          updated_at: 5,
        },
      ],
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
    assert.deepEqual(
      database.selectObjects(
        "SELECT event_id,program_day_id,status,reflection,created_at,updated_at FROM fitness_sessions",
      ).map((row) => ({ ...row })),
      [{
        event_id: "event-v1",
        program_day_id: "day-v1",
        status: "completed",
        reflection: "保留训练事实",
        created_at: 6,
        updated_at: 7,
      }],
    );
    assert.equal(
      database.selectValue(
        "SELECT rescheduled_from_id FROM fitness_calendar_events WHERE id='manual-v1'",
      ),
      "event-v1",
      "self-references survive the table rebuild",
    );
  } finally {
    database.close();
  }
});

test("v1 occurrence collisions reject migration without changing bytes or ledger", async () => {
  const { database } = await databaseFixture();
  try {
    installV1Schema(database, 4321);
    const startsAt = new Date(2026, 7, 24, 9, 0, 0, 0).getTime();
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
    for (const [id, offset] of [["event-a", 0], ["event-b", 3_600_000]]) {
      executeRun(
        database,
        "INSERT INTO fitness_calendar_events(id,program_day_id,venue_id,title,kind,starts_at,planned_minutes,status,rescheduled_from_id,note,created_at,updated_at) VALUES(?,'day-v1','venue-v1','周一','resistance',?,45,'planned',NULL,'',2,2)",
        [id, startsAt + offset],
      );
    }
    const beforeEvents = database.selectObjects(
      "SELECT * FROM fitness_calendar_events ORDER BY id",
    ).map((row) => ({ ...row }));

    await assert.rejects(store.initializeFitnessDatabase(), /重复日期.*原数据没有被改动/);

    assert.equal(Number(database.selectValue("PRAGMA user_version")), 1);
    assert.deepEqual(
      database.selectObjects("SELECT version,name,applied_at FROM fitness_schema_migrations")
        .map((row) => ({ ...row })),
      [{ version: 1, name: schema.SHILIAN_V1_MIGRATION_NAME, applied_at: 4321 }],
    );
    assert.deepEqual(
      database.selectObjects("PRAGMA table_info(fitness_calendar_events)").map(({ name }) => name),
      [...schema.SHILIAN_V1_TABLE_COLUMNS.fitness_calendar_events],
    );
    assert.deepEqual(
      database.selectObjects("SELECT * FROM fitness_calendar_events ORDER BY id")
        .map((row) => ({ ...row })),
      beforeEvents,
    );
  } finally {
    database.close();
  }
});

test("equipment catalog covers every persisted kind without duplicate templates", () => {
  assert.deepEqual(
    catalog.EQUIPMENT_TEMPLATES.map(({ kind }) => kind).sort(),
    Object.keys(catalog.EQUIPMENT_KIND_LABELS).sort(),
  );
  assert.equal(
    new Set(catalog.EQUIPMENT_TEMPLATES.map(({ kind }) => kind)).size,
    catalog.EQUIPMENT_TEMPLATES.length,
  );
  const exerciseKinds = new Set(
    catalog.FITNESS_EXERCISES.flatMap(({ requirements }) =>
      requirements.map(({ kind }) => kind)
    ),
  );
  for (const { kind } of catalog.EQUIPMENT_TEMPLATES) {
    if (kind !== "other") assert.ok(exerciseKinds.has(kind), kind);
  }

  const singleDumbbell = {
    ...dumbbellInput("venue-catalog", []),
    id: "single-db",
    quantity: 1,
    created_at: 0,
    updated_at: 0,
  };
  const bench = {
    ...singleDumbbell,
    id: "bench",
    name: "训练凳",
    kind: "bench",
    load_mode: "none",
    load_semantics: "total",
  };
  const dumbbellRdl = catalog.getFitnessExercise("dumbbell-rdl");
  const dumbbellBench = catalog.getFitnessExercise("dumbbell-bench");
  const oneArmRow = catalog.getFitnessExercise("one-arm-dumbbell-row");
  const gobletSquat = catalog.getFitnessExercise("goblet-squat");
  assert.equal(catalog.exerciseFitsEquipment(dumbbellRdl, [singleDumbbell]), false);
  assert.equal(catalog.exerciseFitsEquipment(dumbbellBench, [singleDumbbell, bench]), false);
  assert.equal(catalog.exerciseFitsEquipment(oneArmRow, [singleDumbbell, bench]), true);
  assert.equal(catalog.exerciseFitsEquipment(gobletSquat, [singleDumbbell]), true);
  assert.equal(
    catalog.exerciseFitsEquipment(dumbbellRdl, [{ ...singleDumbbell, unilateral: true }]),
    true,
  );
  assert.equal(
    catalog.exercisesForVenue([singleDumbbell, bench]).some(({ id }) => id === "dumbbell-rdl"),
    false,
  );
});

test("direct live-session writes reject bilateral work with one ordinary dumbbell", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    const singleDumbbellId = await store.saveEquipmentWithLoads({
      ...dumbbellInput(venueId, [{ ...load(10000), quantity: 1 }]),
      quantity: 1,
    });
    const sessionId = await store.startFitnessSession({ venueId });

    await assert.rejects(
      store.addSessionExercise(sessionId, "dumbbell-rdl", singleDumbbellId),
      /器材数量不足/,
    );
    assert.equal(Number(database.selectValue("SELECT COUNT(*) FROM fitness_session_exercises")), 0);
    const gobletId = await store.addSessionExercise(
      sessionId,
      "goblet-squat",
      singleDumbbellId,
    );
    await assert.rejects(
      store.substituteSessionExercise({
        sessionExerciseId: gobletId,
        exerciseId: "dumbbell-rdl",
        equipmentId: singleDumbbellId,
        reason: "尝试双手动作",
      }),
      /器材数量不足/,
    );
    assert.equal(
      database.selectValue("SELECT exercise_id FROM fitness_session_exercises WHERE id=?", [gobletId]),
      "goblet-squat",
    );

    const unilateralDumbbellId = await store.saveEquipmentWithLoads({
      ...dumbbellInput(venueId, [{ ...load(12000), quantity: 1 }]),
      name: "明确单侧使用的可调哑铃",
      quantity: 1,
      unilateral: true,
    });
    const explicitlyUnilateralId = await store.addSessionExercise(
      sessionId,
      "dumbbell-rdl",
      unilateralDumbbellId,
    );
    assert.equal(
      database.selectValue("SELECT status FROM fitness_session_exercises WHERE id=?", [explicitlyUnilateralId]),
      "pending",
    );
  } finally {
    database.close();
  }
});

test("runtime opening rejects broken foreign-key relationships", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    await store.saveEquipmentWithLoads(
      dumbbellInput(venueId, [load(10000)]),
    );
    database.exec("PRAGMA foreign_keys=OFF");
    executeRun(database, "DELETE FROM fitness_venues WHERE id=?", [venueId]);
    database.exec("PRAGMA foreign_keys=ON");
    await assert.rejects(store.initializeFitnessDatabase(), /断开的关联/);
  } finally {
    database.close();
  }
});

test("profile, venue, equipment, and discrete loads persist transactionally", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    await store.saveFitnessProfile(profileInput);
    const venueId = await store.saveVenue(venueInput);
    const equipmentId = await store.saveEquipmentWithLoads(
      dumbbellInput(venueId, [load(10000), load(12500)]),
    );
    let snapshot = await store.loadFitnessSnapshot();
    assert.deepEqual(snapshot.profile.goals, ["strength", "general_health"]);
    assert.equal("goals_json" in snapshot.profile, false);
    assert.equal(snapshot.venues[0].is_default, true);
    assert.equal("settings_json" in snapshot.equipment[0], false);
    assert.equal("attachments_json" in snapshot.equipment[0], false);
    assert.deepEqual(
      snapshot.equipmentLoads.map(({ load_grams }) => load_grams),
      [10000, 12500],
    );

    await assert.rejects(
      store.saveEquipmentWithLoads({
        ...dumbbellInput(venueId, [load(15000, "15 kg"), load(15000, " 15 kg ")]),
        id: equipmentId,
      }),
      /档位不能重复/,
    );
    snapshot = await store.loadFitnessSnapshot();
    assert.deepEqual(
      snapshot.equipmentLoads.map(({ load_grams }) => load_grams),
      [10000, 12500],
      "a rejected replacement must retain the entire prior ladder",
    );

    await store.saveEquipmentWithLoads({
      ...dumbbellInput(venueId, [load(15000)]),
      id: equipmentId,
    });
    assert.deepEqual(
      database.selectObjects(
        "SELECT load_grams FROM fitness_equipment_loads WHERE equipment_id=?",
        [equipmentId],
      ).map(({ load_grams }) => load_grams),
      [15000],
    );
    assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("constraint-aware program persistence uses canonical equipment snapshots and schedules idempotently", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    const equipmentId = await store.saveEquipmentWithLoads(
      dumbbellInput(venueId, [{ ...load(10000), quantity: 1 }, load(12500)]),
    );
    await assert.rejects(
      store.saveProgramDraft(draftFor(venueId, equipmentId)),
      /数量不足/,
    );
    assert.equal(Number(database.selectValue("SELECT COUNT(*) FROM fitness_programs")), 0);
    await store.saveEquipmentWithLoads({
      ...dumbbellInput(venueId, [load(10000), load(12500)]),
      id: equipmentId,
    });
    const programId = await store.saveProgramDraft(draftFor(venueId, equipmentId));
    const storedSnapshot = String(database.selectValue(
      "SELECT equipment_snapshot FROM fitness_program_items LIMIT 1",
    ));
    assert.notEqual(storedSnapshot, "forged snapshot must not survive");
    assert.equal(JSON.parse(storedSnapshot)[0].id, equipmentId);

    const from = new Date(2026, 7, 24, 9, 0, 0, 0);
    const first = await store.scheduleProgramWeek(programId, from);
    const second = await store.scheduleProgramWeek(programId, from);
    assert.deepEqual(second, first);
    assert.equal(Number(database.selectValue("SELECT COUNT(*) FROM fitness_calendar_events")), 1);
    const otherVenueId = await store.saveVenue({
      ...venueInput,
      name: "出差酒店健身房",
      is_default: false,
    });
    await assert.rejects(
      store.rescheduleCalendarEvent(first[0], from.getTime() + 86_400_000, otherVenueId),
      /不能直接改到另一个场地/,
    );

    await store.saveConstraint({
      label: "暂时避免髋铰链",
      body_area: "下背",
      severity: "avoid",
      movement_patterns: ["hinge"],
      exercise_ids: [],
      note: "保守调整",
      active: true,
    });
    await assert.rejects(
      store.saveProgramDraft({ ...draftFor(venueId, equipmentId), name: "冲突计划" }),
      /避用限制冲突/,
    );
    assert.equal(Number(database.selectValue("SELECT COUNT(*) FROM fitness_programs")), 1);
    const eventCountBeforeConflict = Number(database.selectValue("SELECT COUNT(*) FROM fitness_calendar_events"));
    await assert.rejects(
      store.scheduleProgramWeek(programId, new Date(2026, 7, 31, 9, 0, 0, 0)),
      /身体边界已更新.*生成适用版本后再排期/,
    );
    assert.equal(
      Number(database.selectValue("SELECT COUNT(*) FROM fitness_calendar_events")),
      eventCountBeforeConflict,
      "a newly avoided action must block rescheduling an old plan without changing history",
    );
    await assert.rejects(
      store.startFitnessSession({ eventId: first[0], venueId }),
      /避用限制冲突/,
    );
    assert.equal(Number(database.selectValue("SELECT COUNT(*) FROM fitness_sessions")), 0);
    await store.archiveVenue(venueId);
    assert.equal(
      database.selectValue("SELECT status FROM fitness_programs WHERE id=?", [programId]),
      "archived",
    );
    assert.equal(
      database.selectValue("SELECT status FROM fitness_calendar_events WHERE id=?", [first[0]]),
      "cancelled",
    );
    await assert.rejects(store.scheduleProgramWeek(programId, from), /当前启用的计划/);
  } finally {
    database.close();
  }
});

test("body boundaries can be edited, paused, and restored without rewriting plans or history", async () => {
  const { database, state } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    const equipmentId = await store.saveEquipmentWithLoads(
      dumbbellInput(venueId, [load(10000), load(12500)]),
    );
    const programId = await store.saveProgramDraft(draftFor(venueId, equipmentId));
    const [eventId] = await store.scheduleProgramWeek(
      programId,
      new Date(2026, 7, 24, 9, 0, 0, 0),
    );
    const sessionId = await store.startFitnessSession({ eventId, venueId });
    const sessionExerciseId = String(database.selectValue(
      "SELECT id FROM fitness_session_exercises WHERE session_id=?",
      [sessionId],
    ));
    await store.recordFitnessSet({
      sessionExerciseId,
      setIndex: 0,
      loadGrams: 10000,
      reps: 8,
      rir: 3,
      clientMutationId: "constraint-lifecycle-history",
    });
    await store.finishFitnessSession(sessionId);

    const factTables = [
      "fitness_programs",
      "fitness_program_days",
      "fitness_program_items",
      "fitness_calendar_events",
      "fitness_sessions",
      "fitness_session_exercises",
      "fitness_sets",
      "fitness_capabilities",
    ];
    const factsBefore = Object.fromEntries(factTables.map((table) => [
      table,
      database.selectObjects(`SELECT * FROM ${table} ORDER BY id`).map((row) => ({ ...row })),
    ]));

    const constraintId = await store.saveConstraint({
      label: "训练时留意下背",
      body_area: "下背",
      severity: "monitor",
      movement_patterns: ["hinge"],
      exercise_ids: [],
      note: "只记录自己的感受",
      active: true,
    });
    const createdAt = Number(database.selectValue(
      "SELECT created_at FROM fitness_constraints WHERE id=?",
      [constraintId],
    ));
    await store.saveConstraint({
      id: constraintId,
      label: "暂时避开髋铰链",
      body_area: "下背",
      severity: "avoid",
      movement_patterns: ["hinge"],
      exercise_ids: [],
      note: "按已知边界暂停这类动作",
      active: true,
    });
    assert.deepEqual(
      database.selectObjects(
        `SELECT label,severity,movement_patterns_json,exercise_ids_json,note,active,created_at
          FROM fitness_constraints WHERE id=?`,
        [constraintId],
      ).map((row) => ({ ...row })),
      [{
        label: "暂时避开髋铰链",
        severity: "avoid",
        movement_patterns_json: '["hinge"]',
        exercise_ids_json: "[]",
        note: "按已知边界暂停这类动作",
        active: 1,
        created_at: createdAt,
      }],
      "editing reuses the original record and creation fact",
    );

    const beforeEmptyEdit = database.selectObjects(
      "SELECT * FROM fitness_constraints WHERE id=?",
      [constraintId],
    ).map((row) => ({ ...row }));
    let batchCount = state.operations.filter(([operation]) => operation === "batch").length;
    let broadcastCount = globalThis.__fitnessLockState.broadcasts.length;
    await assert.rejects(
      store.saveConstraint({
        id: constraintId,
        label: "范围不能丢失",
        body_area: "下背",
        severity: "avoid",
        movement_patterns: [],
        exercise_ids: [],
        note: "无范围",
        active: true,
      }),
      /至少包含一个受影响的动作模式或动作/,
    );
    assert.equal(
      state.operations.filter(([operation]) => operation === "batch").length,
      batchCount,
      "an invalid active edit must not reach SQLite writes",
    );
    assert.equal(globalThis.__fitnessLockState.broadcasts.length, broadcastCount);
    assert.deepEqual(
      database.selectObjects("SELECT * FROM fitness_constraints WHERE id=?", [constraintId])
        .map((row) => ({ ...row })),
      beforeEmptyEdit,
      "an invalid active edit is atomic",
    );

    const beforePause = beforeEmptyEdit[0];
    const { active: beforePauseActive, updated_at: beforePauseUpdatedAt, ...stableBeforePause } = beforePause;
    assert.equal(beforePauseActive, 1);
    let writes = globalThis.__fitnessLockState.writes;
    broadcastCount = globalThis.__fitnessLockState.broadcasts.length;
    await store.setFitnessConstraintActive(constraintId, false);
    assert.equal(globalThis.__fitnessLockState.writes, writes + 1);
    assert.deepEqual(
      globalThis.__fitnessLockState.broadcasts.slice(broadcastCount),
      ["constraint-deactivated"],
    );
    const paused = database.selectObjects(
      "SELECT * FROM fitness_constraints WHERE id=?",
      [constraintId],
    ).map((row) => ({ ...row }))[0];
    const { active: pausedActive, updated_at: pausedUpdatedAt, ...stablePaused } = paused;
    assert.equal(pausedActive, 0);
    assert.ok(Number(pausedUpdatedAt) >= Number(beforePauseUpdatedAt));
    assert.deepEqual(stablePaused, stableBeforePause, "pausing changes only active and updated_at");

    batchCount = state.operations.filter(([operation]) => operation === "batch").length;
    broadcastCount = globalThis.__fitnessLockState.broadcasts.length;
    writes = globalThis.__fitnessLockState.writes;
    await assert.rejects(
      store.setFitnessConstraintActive(constraintId, false),
      /已经处于暂停状态/,
    );
    assert.equal(
      globalThis.__fitnessLockState.writes,
      writes + 1,
      "even rejected transitions must inspect state under the exclusive lock",
    );
    assert.equal(
      state.operations.filter(([operation]) => operation === "batch").length,
      batchCount,
      "a repeated state is a zero-write rejection",
    );
    assert.equal(globalThis.__fitnessLockState.broadcasts.length, broadcastCount);
    assert.deepEqual(
      database.selectObjects("SELECT * FROM fitness_constraints WHERE id=?", [constraintId])
        .map((row) => ({ ...row }))[0],
      paused,
    );

    broadcastCount = globalThis.__fitnessLockState.broadcasts.length;
    writes = globalThis.__fitnessLockState.writes;
    await store.setFitnessConstraintActive(constraintId, true);
    assert.equal(globalThis.__fitnessLockState.writes, writes + 1);
    assert.deepEqual(
      globalThis.__fitnessLockState.broadcasts.slice(broadcastCount),
      ["constraint-activated"],
    );
    const restored = database.selectObjects(
      "SELECT * FROM fitness_constraints WHERE id=?",
      [constraintId],
    ).map((row) => ({ ...row }))[0];
    const { active: restoredActive, updated_at: restoredUpdatedAt, ...stableRestored } = restored;
    assert.equal(restoredActive, 1);
    assert.ok(Number(restoredUpdatedAt) >= Number(pausedUpdatedAt));
    assert.deepEqual(stableRestored, stablePaused, "restoring changes only active and updated_at");

    assert.deepEqual(
      Object.fromEntries(factTables.map((table) => [
        table,
        database.selectObjects(`SELECT * FROM ${table} ORDER BY id`).map((row) => ({ ...row })),
      ])),
      factsBefore,
      "constraint lifecycle changes never rewrite old plan or training facts",
    );
  } finally {
    database.close();
  }
});

test("empty, unknown, and repeated body-boundary activation attempts are rejected without writes", async () => {
  const { database, state } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    let batchCount = state.operations.filter(([operation]) => operation === "batch").length;
    let broadcastCount = globalThis.__fitnessLockState.broadcasts.length;
    await assert.rejects(
      store.saveConstraint({
        label: "没有范围的生效边界",
        body_area: "",
        severity: "avoid",
        movement_patterns: [],
        exercise_ids: [],
        note: "",
        active: true,
      }),
      /至少包含一个受影响的动作模式或动作/,
    );
    assert.equal(Number(database.selectValue("SELECT COUNT(*) FROM fitness_constraints")), 0);
    assert.equal(state.operations.filter(([operation]) => operation === "batch").length, batchCount);
    assert.equal(globalThis.__fitnessLockState.broadcasts.length, broadcastCount);

    const legacyId = await store.saveConstraint({
      label: "待补范围的旧记录",
      body_area: "",
      severity: "monitor",
      movement_patterns: [],
      exercise_ids: [],
      note: "从旧版本保留下来",
      active: false,
    });
    const legacy = database.selectObjects(
      "SELECT * FROM fitness_constraints WHERE id=?",
      [legacyId],
    ).map((row) => ({ ...row }))[0];
    batchCount = state.operations.filter(([operation]) => operation === "batch").length;
    broadcastCount = globalThis.__fitnessLockState.broadcasts.length;
    await assert.rejects(
      store.setFitnessConstraintActive(legacyId, true),
      /没有受影响范围.*补充范围后才能启用/,
    );
    assert.equal(state.operations.filter(([operation]) => operation === "batch").length, batchCount);
    assert.equal(globalThis.__fitnessLockState.broadcasts.length, broadcastCount);
    assert.deepEqual(
      database.selectObjects("SELECT * FROM fitness_constraints WHERE id=?", [legacyId])
        .map((row) => ({ ...row }))[0],
      legacy,
    );

    batchCount = state.operations.filter(([operation]) => operation === "batch").length;
    broadcastCount = globalThis.__fitnessLockState.broadcasts.length;
    const writes = globalThis.__fitnessLockState.writes;
    await assert.rejects(
      store.setFitnessConstraintActive("constraint-does-not-exist", true),
      /身体边界不存在/,
    );
    assert.equal(globalThis.__fitnessLockState.writes, writes + 1);
    assert.equal(state.operations.filter(([operation]) => operation === "batch").length, batchCount);
    assert.equal(globalThis.__fitnessLockState.broadcasts.length, broadcastCount);

    await assert.rejects(
      store.setFitnessConstraintActive(legacyId, false),
      /已经处于暂停状态/,
    );
    assert.equal(state.operations.filter(([operation]) => operation === "batch").length, batchCount);
    assert.equal(globalThis.__fitnessLockState.broadcasts.length, broadcastCount);
  } finally {
    database.close();
  }
});

test("an archived venue can be restored without reviving plans or rewriting history", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    const equipmentId = await store.saveEquipmentWithLoads(
      dumbbellInput(venueId, [load(10000), load(12500)]),
    );
    const programId = await store.saveProgramDraft(draftFor(venueId, equipmentId));
    const from = new Date(2026, 7, 24, 9, 0, 0, 0);
    const [completedEventId] = await store.scheduleProgramWeek(programId, from);
    const sessionId = await store.startFitnessSession({ eventId: completedEventId, venueId });
    await store.finishFitnessSession(sessionId);
    const followingWeek = new Date(from.getTime() + 7 * 86_400_000);
    const [notPerformedEventId] = await store.scheduleProgramWeek(programId, followingWeek);
    await store.markCalendarEventNotPerformed(notPerformedEventId, "当天休息");
    const thirdWeek = new Date(from.getTime() + 14 * 86_400_000);
    const [cancelledEventId] = await store.scheduleProgramWeek(programId, thirdWeek);

    let broadcastCount = globalThis.__fitnessLockState.broadcasts.length;
    await assert.rejects(store.restoreVenue("venue-does-not-exist"), /场地不存在/);
    await assert.rejects(store.restoreVenue(venueId), /只能恢复已归档的场地/);
    assert.equal(
      globalThis.__fitnessLockState.broadcasts.length,
      broadcastCount,
      "failed restores must not broadcast",
    );

    await store.archiveVenue(venueId);
    assert.deepEqual(
      Object.fromEntries(database.selectObjects(
        "SELECT id,status FROM fitness_calendar_events WHERE venue_id=?",
        [venueId],
      ).map(({ id, status }) => [id, status])),
      {
        [completedEventId]: "completed",
        [notPerformedEventId]: "not_performed",
        [cancelledEventId]: "cancelled",
      },
      "archiving only cancels the still-planned event",
    );
    const programsAfterArchive = database.selectObjects(
      "SELECT * FROM fitness_programs WHERE venue_id=? ORDER BY id",
      [venueId],
    ).map((row) => ({ ...row }));
    const eventsAfterArchive = database.selectObjects(
      "SELECT * FROM fitness_calendar_events WHERE venue_id=? ORDER BY id",
      [venueId],
    ).map((row) => ({ ...row }));
    const sessionsAfterArchive = database.selectObjects(
      "SELECT * FROM fitness_sessions WHERE venue_id=? ORDER BY id",
      [venueId],
    ).map((row) => ({ ...row }));
    broadcastCount = globalThis.__fitnessLockState.broadcasts.length;
    const writesBeforeRestore = globalThis.__fitnessLockState.writes;

    await store.restoreVenue(venueId);
    assert.equal(
      globalThis.__fitnessLockState.writes,
      writesBeforeRestore + 1,
      "restore must use the product's exclusive write lock",
    );
    assert.deepEqual(
      database.selectObjects("SELECT status,is_default FROM fitness_venues WHERE id=?", [venueId])
        .map((row) => ({ ...row })),
      [{ status: "active", is_default: 0 }],
      "restoring availability must not silently make the venue default",
    );
    assert.deepEqual(
      database.selectObjects("SELECT * FROM fitness_programs WHERE venue_id=? ORDER BY id", [venueId])
        .map((row) => ({ ...row })),
      programsAfterArchive,
      "old plans stay archived",
    );
    assert.deepEqual(
      database.selectObjects("SELECT * FROM fitness_calendar_events WHERE venue_id=? ORDER BY id", [venueId])
        .map((row) => ({ ...row })),
      eventsAfterArchive,
      "calendar facts stay completed, not performed, or cancelled",
    );
    assert.deepEqual(
      database.selectObjects("SELECT * FROM fitness_sessions WHERE venue_id=? ORDER BY id", [venueId])
        .map((row) => ({ ...row })),
      sessionsAfterArchive,
      "completed session facts stay byte-for-byte unchanged",
    );
    assert.deepEqual(
      globalThis.__fitnessLockState.broadcasts.slice(broadcastCount),
      ["venue-restored"],
    );

    const venueAfterRestore = database.selectObjects(
      "SELECT * FROM fitness_venues WHERE id=?",
      [venueId],
    ).map((row) => ({ ...row }));
    broadcastCount = globalThis.__fitnessLockState.broadcasts.length;
    await assert.rejects(store.restoreVenue(venueId), /只能恢复已归档的场地/);
    assert.deepEqual(
      database.selectObjects("SELECT * FROM fitness_venues WHERE id=?", [venueId])
        .map((row) => ({ ...row })),
      venueAfterRestore,
      "a repeated restore of an active venue is a rejected no-op",
    );
    assert.equal(globalThis.__fitnessLockState.broadcasts.length, broadcastCount);
  } finally {
    database.close();
  }
});

test("program versions advance within one logical venue plan and retain prior versions", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    const equipmentId = await store.saveEquipmentWithLoads(
      dumbbellInput(venueId, [load(10000), load(12500)]),
    );
    const firstId = await store.saveProgramDraft(draftFor(venueId, equipmentId));
    const secondId = await store.saveProgramDraft({
      ...draftFor(venueId, equipmentId),
      name: "  真实器材全身计划  ",
      assumptions: ["器材复核后的新版本"],
    });
    const draftId = await store.saveProgramDraft(
      draftFor(venueId, equipmentId),
      "manual",
      false,
    );
    const separateId = await store.saveProgramDraft({
      ...draftFor(venueId, equipmentId),
      name: "旅行前保守计划",
    });

    const programs = database.selectObjects(
      "SELECT id,name,status,version,source FROM fitness_programs ORDER BY rowid",
    ).map((row) => ({ ...row }));
    assert.deepEqual(programs, [
      { id: firstId, name: "真实器材全身计划", status: "archived", version: 1, source: "local" },
      { id: secondId, name: "真实器材全身计划", status: "archived", version: 2, source: "local" },
      { id: draftId, name: "真实器材全身计划", status: "draft", version: 3, source: "manual" },
      { id: separateId, name: "旅行前保守计划", status: "active", version: 1, source: "local" },
    ]);
    assert.equal(Number(database.selectValue("SELECT COUNT(*) FROM fitness_programs")), 4);
  } finally {
    database.close();
  }
});

test("a planned event from an earlier rolling week never blocks the next week", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    const equipmentId = await store.saveEquipmentWithLoads(
      dumbbellInput(venueId, [load(10000), load(12500)]),
    );
    const programId = await store.saveProgramDraft(draftFor(venueId, equipmentId));
    const firstWeek = new Date(2026, 7, 24, 9, 0, 0, 0);
    const secondWeek = new Date(2026, 7, 31, 9, 0, 0, 0);
    const [firstId] = await store.scheduleProgramWeek(programId, firstWeek);
    const [secondId] = await store.scheduleProgramWeek(programId, secondWeek);

    assert.notEqual(secondId, firstId);
    assert.equal(Number(database.selectValue("SELECT COUNT(*) FROM fitness_calendar_events")), 2);
    assert.deepEqual(await store.scheduleProgramWeek(programId, firstWeek), [firstId]);
    assert.deepEqual(await store.scheduleProgramWeek(programId, secondWeek), [secondId]);
    assert.equal(
      Number(database.selectValue("SELECT COUNT(*) FROM fitness_calendar_events")),
      2,
      "each rolling week is independently idempotent",
    );
  } finally {
    database.close();
  }
});

test("Monday after the 18:00 slot schedules next Monday and occurrence identity is unique", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    const equipmentId = await store.saveEquipmentWithLoads(
      dumbbellInput(venueId, [load(10000), load(12500)]),
    );
    const programId = await store.saveProgramDraft(draftFor(venueId, equipmentId));
    const mondayAtNineteen = new Date(2026, 7, 24, 19, 0, 0, 0);
    const [nextMondayId] = await store.scheduleProgramWeek(programId, mondayAtNineteen);
    const expectedNextMonday = new Date(2026, 7, 31, 18, 0, 0, 0);
    const nextMonday = database.selectObjects(
      "SELECT program_day_id,starts_at,occurrence_key FROM fitness_calendar_events WHERE id=?",
      [nextMondayId],
    ).map((row) => ({ ...row }))[0];

    assert.equal(nextMonday.starts_at, expectedNextMonday.getTime());
    assert.equal(nextMonday.occurrence_key, localDateKey(expectedNextMonday.getTime()));
    const mondayBeforeSlot = new Date(2026, 7, 24, 17, 59, 59, 999);
    const [sameMondayId] = await store.scheduleProgramWeek(programId, mondayBeforeSlot);
    assert.notEqual(sameMondayId, nextMondayId);
    assert.equal(
      database.selectValue(
        "SELECT occurrence_key FROM fitness_calendar_events WHERE id=?",
        [sameMondayId],
      ),
      "2026-08-24",
    );
    assert.throws(
      () => executeRun(
        database,
        `INSERT INTO fitness_calendar_events(
          id,program_day_id,venue_id,title,kind,starts_at,occurrence_key,
          planned_minutes,status,rescheduled_from_id,note,created_at,updated_at
        ) VALUES('duplicate-occurrence',? ,?,'重复','resistance',?, ?,45,'cancelled',NULL,'',1,1)`,
        [nextMonday.program_day_id, venueId, expectedNextMonday.getTime() + 3_600_000, nextMonday.occurrence_key],
      ),
      /UNIQUE constraint failed/,
    );
  } finally {
    database.close();
  }
});

test("week scheduling follows program-day state after rescheduling and preserves event truth", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    const equipmentId = await store.saveEquipmentWithLoads(
      dumbbellInput(venueId, [load(10000), load(12500)]),
    );
    const programId = await store.saveProgramDraft(draftFor(venueId, equipmentId));
    const from = new Date(2026, 7, 24, 9, 0, 0, 0);
    const [originalId] = await store.scheduleProgramWeek(programId, from);
    const originalOccurrence = database.selectValue(
      "SELECT occurrence_key FROM fitness_calendar_events WHERE id=?",
      [originalId],
    );
    const movedAt = from.getTime() + 3 * 86_400_000;
    await store.rescheduleCalendarEvent(originalId, movedAt);

    assert.deepEqual(await store.scheduleProgramWeek(programId, from), [originalId]);
    assert.equal(Number(database.selectValue("SELECT COUNT(*) FROM fitness_calendar_events")), 1);
    assert.equal(
      Number(database.selectValue("SELECT starts_at FROM fitness_calendar_events WHERE id=?", [originalId])),
      movedAt,
      "scheduling again must not undo a user's reschedule",
    );
    assert.equal(
      database.selectValue(
        "SELECT occurrence_key FROM fitness_calendar_events WHERE id=?",
        [originalId],
      ),
      originalOccurrence,
      "rescheduling changes the appointment time, never its immutable occurrence identity",
    );

    const sessionId = await store.startFitnessSession({ eventId: originalId, venueId });
    assert.deepEqual(await store.scheduleProgramWeek(programId, from), [originalId]);
    assert.equal(
      database.selectValue("SELECT status FROM fitness_calendar_events WHERE id=?", [originalId]),
      "in_progress",
      "an in-progress fact must not be rewritten as planned",
    );
    assert.equal(
      (await store.loadFitnessSnapshot()).events.find(({ id }) => id === originalId)?.status,
      "in_progress",
      "agenda data must expose an in-progress event as in-progress",
    );
    await store.finishFitnessSession(sessionId, { endedEarly: true });

    const followingWeek = new Date(from.getTime() + 7 * 86_400_000);
    const [afterCompletedId] = await store.scheduleProgramWeek(programId, followingWeek);
    assert.notEqual(afterCompletedId, originalId);
    await store.markCalendarEventNotPerformed(afterCompletedId, "当天休息");
    const [afterNotPerformedId] = await store.scheduleProgramWeek(programId, followingWeek);
    assert.equal(
      afterNotPerformedId,
      afterCompletedId,
      "a final not-performed occurrence must not be silently recreated",
    );
    executeRun(
      database,
      "UPDATE fitness_calendar_events SET status='cancelled',updated_at=updated_at+1 WHERE id=?",
      [afterNotPerformedId],
    );
    const [afterCancelledId] = await store.scheduleProgramWeek(programId, followingWeek);
    assert.equal(
      afterCancelledId,
      afterNotPerformedId,
      "a cancelled occurrence must not be silently recreated",
    );
    const thirdWeek = new Date(from.getTime() + 14 * 86_400_000);
    const [nextOccurrenceId] = await store.scheduleProgramWeek(programId, thirdWeek);
    assert.notEqual(nextOccurrenceId, afterCancelledId);

    const snapshot = await store.loadFitnessSnapshot();
    assert.deepEqual(
      Object.fromEntries(snapshot.events.map(({ id, status }) => [id, status])),
      {
        [originalId]: "completed",
        [afterCompletedId]: "cancelled",
        [nextOccurrenceId]: "planned",
      },
      "agenda data must preserve historical and current statuses exactly",
    );
  } finally {
    database.close();
  }
});

test("cancelling an empty scheduled session restores only its calendar status", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    const equipmentId = await store.saveEquipmentWithLoads(
      dumbbellInput(venueId, [load(10000), load(12500)]),
    );

    const historicalSessionId = await store.startFitnessSession({ venueId });
    const historicalExerciseId = await store.addSessionExercise(
      historicalSessionId,
      "dumbbell-rdl",
      equipmentId,
    );
    await store.recordFitnessSet({
      sessionExerciseId: historicalExerciseId,
      setIndex: 0,
      setKind: "work",
      loadGrams: 10000,
      reps: 8,
      rir: 2,
      clientMutationId: "empty-cancel-history",
    });
    await store.finishFitnessSession(historicalSessionId);

    const programId = await store.saveProgramDraft(draftFor(venueId, equipmentId));
    const firstWeek = new Date(2026, 7, 24, 9, 0, 0, 0);
    const secondWeek = new Date(2026, 7, 31, 9, 0, 0, 0);
    const [eventId] = await store.scheduleProgramWeek(programId, firstWeek);
    const [otherEventId] = await store.scheduleProgramWeek(programId, secondWeek);
    const sessionId = await store.startFitnessSession({ eventId, venueId });
    const inProgressEvent = database.selectObjects(
      "SELECT * FROM fitness_calendar_events WHERE id=?",
      [eventId],
    ).map((row) => ({ ...row }))[0];
    const otherEvent = database.selectObjects(
      "SELECT * FROM fitness_calendar_events WHERE id=?",
      [otherEventId],
    ).map((row) => ({ ...row }))[0];
    const historicalFacts = {
      sessions: database.selectObjects(
        "SELECT * FROM fitness_sessions WHERE id=?",
        [historicalSessionId],
      ).map((row) => ({ ...row })),
      exercises: database.selectObjects(
        "SELECT * FROM fitness_session_exercises WHERE session_id=?",
        [historicalSessionId],
      ).map((row) => ({ ...row })),
      sets: database.selectObjects(
        `SELECT recorded_set.*
         FROM fitness_sets recorded_set
         JOIN fitness_session_exercises exercise
           ON exercise.id=recorded_set.session_exercise_id
         WHERE exercise.session_id=?`,
        [historicalSessionId],
      ).map((row) => ({ ...row })),
      capabilities: database.selectObjects(
        "SELECT * FROM fitness_capabilities ORDER BY id",
      ).map((row) => ({ ...row })),
    };
    assert.equal(inProgressEvent.status, "in_progress");
    assert.ok(
      Number(database.selectValue(
        "SELECT COUNT(*) FROM fitness_session_exercises WHERE session_id=?",
        [sessionId],
      )) > 0,
      "a scheduled session starts with cloned plan exercises",
    );
    const writes = globalThis.__fitnessLockState.writes;
    const broadcasts = globalThis.__fitnessLockState.broadcasts.length;

    await store.cancelEmptyFitnessSession(sessionId);

    assert.equal(globalThis.__fitnessLockState.writes, writes + 1);
    assert.equal(globalThis.__fitnessLockState.broadcasts.length, broadcasts + 1);
    assert.equal(globalThis.__fitnessLockState.broadcasts.at(-1), "session-cancelled");
    assert.equal(
      Number(database.selectValue("SELECT COUNT(*) FROM fitness_sessions WHERE id=?", [sessionId])),
      0,
    );
    assert.equal(
      Number(database.selectValue(
        "SELECT COUNT(*) FROM fitness_session_exercises WHERE session_id=?",
        [sessionId],
      )),
      0,
      "session exercises are removed through the declared cascade",
    );
    assert.deepEqual(
      database.selectObjects("SELECT * FROM fitness_calendar_events WHERE id=?", [eventId])
        .map((row) => ({ ...row }))[0],
      { ...inProgressEvent, status: "planned" },
      "undo restores status without changing time, occurrence identity, or authored fields",
    );
    assert.deepEqual(
      database.selectObjects("SELECT * FROM fitness_calendar_events WHERE id=?", [otherEventId])
        .map((row) => ({ ...row }))[0],
      otherEvent,
    );
    assert.deepEqual({
      sessions: database.selectObjects(
        "SELECT * FROM fitness_sessions WHERE id=?",
        [historicalSessionId],
      ).map((row) => ({ ...row })),
      exercises: database.selectObjects(
        "SELECT * FROM fitness_session_exercises WHERE session_id=?",
        [historicalSessionId],
      ).map((row) => ({ ...row })),
      sets: database.selectObjects(
        `SELECT recorded_set.*
         FROM fitness_sets recorded_set
         JOIN fitness_session_exercises exercise
           ON exercise.id=recorded_set.session_exercise_id
         WHERE exercise.session_id=?`,
        [historicalSessionId],
      ).map((row) => ({ ...row })),
      capabilities: database.selectObjects(
        "SELECT * FROM fitness_capabilities ORDER BY id",
      ).map((row) => ({ ...row })),
    }, historicalFacts, "unrelated history and capabilities stay byte-for-byte unchanged");
    assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("cancelling an empty temporary program-day session deletes it without touching calendar", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    const equipmentId = await store.saveEquipmentWithLoads(
      dumbbellInput(venueId, [load(10000)]),
    );
    const programId = await store.saveProgramDraft(draftFor(venueId, equipmentId));
    const [otherEventId] = await store.scheduleProgramWeek(
      programId,
      new Date(2026, 7, 24, 9, 0, 0, 0),
    );
    const otherEvent = database.selectObjects(
      "SELECT * FROM fitness_calendar_events WHERE id=?",
      [otherEventId],
    ).map((row) => ({ ...row }))[0];
    const programDayId = database.selectValue(
      "SELECT id FROM fitness_program_days WHERE program_id=? AND day_index=0",
      [programId],
    );
    const sessionId = await store.startFitnessSession({
      venueId,
      programDayId,
    });
    assert.equal(
      database.selectValue("SELECT event_id FROM fitness_sessions WHERE id=?", [sessionId]),
      null,
    );
    assert.ok(
      Number(database.selectValue(
        "SELECT COUNT(*) FROM fitness_session_exercises WHERE session_id=?",
        [sessionId],
      )) > 0,
    );

    await store.cancelEmptyFitnessSession(sessionId);

    assert.equal(
      Number(database.selectValue("SELECT COUNT(*) FROM fitness_sessions WHERE id=?", [sessionId])),
      0,
    );
    assert.equal(
      Number(database.selectValue(
        "SELECT COUNT(*) FROM fitness_session_exercises WHERE session_id=?",
        [sessionId],
      )),
      0,
    );
    assert.deepEqual(
      database.selectObjects("SELECT * FROM fitness_calendar_events WHERE id=?", [otherEventId])
        .map((row) => ({ ...row }))[0],
      otherEvent,
      "an event-less session never writes to the calendar",
    );
    assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("empty-session cancellation rejects every measured set or cardio fact without writes", async () => {
  const cases = [
    {
      label: "completed repetition set",
      async record(database, sessionId, exerciseId) {
        await store.recordFitnessSet({
          sessionExerciseId: exerciseId,
          setIndex: 0,
          reps: 8,
          clientMutationId: "cancel-completed-set",
        });
      },
    },
    {
      label: "non-completed zero-repetition fact",
      async record(database, sessionId, exerciseId) {
        executeRun(
          database,
          `INSERT INTO fitness_sets(
            id,session_exercise_id,set_index,set_kind,load_grams,reps,duration_seconds,
            rir,rpe,completed,pain_note,completed_at,client_mutation_id,created_at,updated_at
          ) VALUES('incomplete-measured-set',?,0,'work',NULL,0,NULL,NULL,NULL,0,'',NULL,'cancel-incomplete-set',1,1)`,
          [exerciseId],
        );
      },
    },
    {
      label: "cardio duration fact",
      async record(database, sessionId) {
        executeRun(
          database,
          "INSERT INTO fitness_cardio_entries(id,session_id,equipment_id,mode,duration_seconds,distance_meters,resistance,average_heart_rate,effort,note,created_at) VALUES('cardio-fact',?,NULL,'walk',60,NULL,'',NULL,'easy','',1)",
          [sessionId],
        );
      },
    },
  ];

  for (const entry of cases) {
    const { database, state } = await databaseFixture();
    try {
      await store.initializeFitnessDatabase();
      const venueId = await store.saveVenue(venueInput);
      const equipmentId = await store.saveEquipmentWithLoads(
        dumbbellInput(venueId, [load(10000)]),
      );
      const sessionId = await store.startFitnessSession({ venueId });
      const exerciseId = await store.addSessionExercise(
        sessionId,
        "dumbbell-rdl",
        equipmentId,
      );
      await entry.record(database, sessionId, exerciseId);
      const before = {
        session: database.selectObjects("SELECT * FROM fitness_sessions WHERE id=?", [sessionId])
          .map((row) => ({ ...row })),
        exercises: database.selectObjects(
          "SELECT * FROM fitness_session_exercises WHERE session_id=?",
          [sessionId],
        ).map((row) => ({ ...row })),
        sets: database.selectObjects(
          `SELECT recorded_set.*
           FROM fitness_sets recorded_set
           JOIN fitness_session_exercises exercise
             ON exercise.id=recorded_set.session_exercise_id
           WHERE exercise.session_id=?`,
          [sessionId],
        ).map((row) => ({ ...row })),
        cardio: database.selectObjects(
          "SELECT * FROM fitness_cardio_entries WHERE session_id=?",
          [sessionId],
        ).map((row) => ({ ...row })),
      };
      const batches = state.operations.filter(([operation]) => operation === "batch").length;
      const broadcasts = globalThis.__fitnessLockState.broadcasts.length;

      await assert.rejects(
        store.cancelEmptyFitnessSession(sessionId),
        /已有完成组、次数或时长记录/,
        entry.label,
      );

      assert.equal(
        state.operations.filter(([operation]) => operation === "batch").length,
        batches,
        `${entry.label} must reject before a SQLite write`,
      );
      assert.equal(globalThis.__fitnessLockState.broadcasts.length, broadcasts);
      assert.deepEqual({
        session: database.selectObjects("SELECT * FROM fitness_sessions WHERE id=?", [sessionId])
          .map((row) => ({ ...row })),
        exercises: database.selectObjects(
          "SELECT * FROM fitness_session_exercises WHERE session_id=?",
          [sessionId],
        ).map((row) => ({ ...row })),
        sets: database.selectObjects(
          `SELECT recorded_set.*
           FROM fitness_sets recorded_set
           JOIN fitness_session_exercises exercise
             ON exercise.id=recorded_set.session_exercise_id
           WHERE exercise.session_id=?`,
          [sessionId],
        ).map((row) => ({ ...row })),
        cardio: database.selectObjects(
          "SELECT * FROM fitness_cardio_entries WHERE session_id=?",
          [sessionId],
        ).map((row) => ({ ...row })),
      }, before);
    } finally {
      database.close();
    }
  }
});

test("empty-session cancellation rejects unknown, finished, and calendar-conflicted sessions", async () => {
  const { database, state } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    const equipmentId = await store.saveEquipmentWithLoads(
      dumbbellInput(venueId, [load(10000)]),
    );
    let batches = state.operations.filter(([operation]) => operation === "batch").length;
    let broadcasts = globalThis.__fitnessLockState.broadcasts.length;
    let writes = globalThis.__fitnessLockState.writes;

    await assert.rejects(
      store.cancelEmptyFitnessSession("session-does-not-exist"),
      /训练不存在/,
    );
    assert.equal(globalThis.__fitnessLockState.writes, writes + 1);
    assert.equal(state.operations.filter(([operation]) => operation === "batch").length, batches);
    assert.equal(globalThis.__fitnessLockState.broadcasts.length, broadcasts);

    const finishedId = await store.startFitnessSession({ venueId });
    await store.finishFitnessSession(finishedId);
    batches = state.operations.filter(([operation]) => operation === "batch").length;
    broadcasts = globalThis.__fitnessLockState.broadcasts.length;
    writes = globalThis.__fitnessLockState.writes;
    const finishedBefore = database.selectObjects(
      "SELECT * FROM fitness_sessions WHERE id=?",
      [finishedId],
    ).map((row) => ({ ...row }));
    await assert.rejects(
      store.cancelEmptyFitnessSession(finishedId),
      /只能撤销正在进行的空训练/,
    );
    assert.equal(globalThis.__fitnessLockState.writes, writes + 1);
    assert.equal(state.operations.filter(([operation]) => operation === "batch").length, batches);
    assert.equal(globalThis.__fitnessLockState.broadcasts.length, broadcasts);
    assert.deepEqual(
      database.selectObjects("SELECT * FROM fitness_sessions WHERE id=?", [finishedId])
        .map((row) => ({ ...row })),
      finishedBefore,
    );

    const programId = await store.saveProgramDraft(draftFor(venueId, equipmentId));
    const [eventId] = await store.scheduleProgramWeek(
      programId,
      new Date(2026, 7, 24, 9, 0, 0, 0),
    );
    const conflictedSessionId = await store.startFitnessSession({ eventId, venueId });
    executeRun(
      database,
      "UPDATE fitness_calendar_events SET status='cancelled' WHERE id=?",
      [eventId],
    );
    const sessionBefore = database.selectObjects(
      "SELECT * FROM fitness_sessions WHERE id=?",
      [conflictedSessionId],
    ).map((row) => ({ ...row }));
    const exercisesBefore = database.selectObjects(
      "SELECT * FROM fitness_session_exercises WHERE session_id=? ORDER BY id",
      [conflictedSessionId],
    ).map((row) => ({ ...row }));
    const eventBefore = database.selectObjects(
      "SELECT * FROM fitness_calendar_events WHERE id=?",
      [eventId],
    ).map((row) => ({ ...row }))[0];
    batches = state.operations.filter(([operation]) => operation === "batch").length;
    broadcasts = globalThis.__fitnessLockState.broadcasts.length;
    writes = globalThis.__fitnessLockState.writes;

    await assert.rejects(
      store.cancelEmptyFitnessSession(conflictedSessionId),
      /日历安排已不在进行中/,
    );

    assert.equal(globalThis.__fitnessLockState.writes, writes + 1);
    assert.equal(state.operations.filter(([operation]) => operation === "batch").length, batches);
    assert.equal(globalThis.__fitnessLockState.broadcasts.length, broadcasts);
    assert.deepEqual(
      database.selectObjects("SELECT * FROM fitness_sessions WHERE id=?", [conflictedSessionId])
        .map((row) => ({ ...row })),
      sessionBefore,
    );
    assert.deepEqual(
      database.selectObjects(
        "SELECT * FROM fitness_session_exercises WHERE session_id=? ORDER BY id",
        [conflictedSessionId],
      ).map((row) => ({ ...row })),
      exercisesBefore,
    );
    assert.deepEqual(
      database.selectObjects("SELECT * FROM fitness_calendar_events WHERE id=?", [eventId])
        .map((row) => ({ ...row }))[0],
      eventBefore,
    );
  } finally {
    database.close();
  }
});

test("manual sessions support added exercises, idempotent sets, undo, and truthful early finish", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    const equipmentId = await store.saveEquipmentWithLoads(
      dumbbellInput(venueId, [load(10000)]),
    );
    await assert.rejects(
      store.startFitnessSession({ eventId: "missing", venueId }),
      /日历安排.*不存在/,
    );
    assert.equal(Number(database.selectValue("SELECT COUNT(*) FROM fitness_sessions")), 0);

    const sessionId = await store.startFitnessSession({ venueId, availableMinutes: 30 });
    await assert.rejects(
      store.addSessionExercise(sessionId, "dumbbell-rdl", equipmentId, "{not-json"),
      /不是有效 JSON/,
    );
    assert.equal(Number(database.selectValue("SELECT COUNT(*) FROM fitness_session_exercises")), 0);
    const exerciseId = await store.addSessionExercise(
      sessionId,
      "dumbbell-rdl",
      equipmentId,
    );
    const firstSet = {
      sessionExerciseId: exerciseId,
      setIndex: 0,
      loadGrams: 10000,
      reps: 8,
      rir: 2,
      clientMutationId: "tap-1",
    };
    const setId = await store.recordFitnessSet(firstSet);
    assert.equal(await store.recordFitnessSet(firstSet), setId);
    assert.equal(Number(database.selectValue("SELECT COUNT(*) FROM fitness_sets")), 1);
    await assert.rejects(
      store.recordFitnessSet({ ...firstSet, reps: 9 }),
      /未覆盖原记录/,
    );
    await store.undoFitnessSet(setId);
    assert.equal(Number(database.selectValue("SELECT COUNT(*) FROM fitness_sets")), 0);

    const keptSetId = await store.recordFitnessSet({
      ...firstSet,
      clientMutationId: "tap-2",
    });
    await store.recordFitnessSet({
      ...firstSet,
      setIndex: 1,
      reps: 7,
      clientMutationId: "tap-3",
    });
    const substitutedId = await store.addSessionExercise(
      sessionId,
      "dumbbell-rdl",
      equipmentId,
    );
    await store.substituteSessionExercise({
      sessionExerciseId: substitutedId,
      exerciseId: "goblet-squat",
      equipmentId,
      reason: "现场调整",
    });
    await store.updateSessionReflection(sessionId, "时间到了，保留已完成内容。");
    await store.finishFitnessSession(sessionId, { endedEarly: true });
    const session = database.selectObjects(
      "SELECT status,reflection FROM fitness_sessions WHERE id=?",
      [sessionId],
    )[0];
    assert.deepEqual({ ...session }, {
      status: "ended_early",
      reflection: "时间到了，保留已完成内容。",
    });
    const capabilities = database.selectObjects(
      "SELECT id,source_set_id FROM fitness_capabilities ORDER BY source_set_id",
    );
    assert.equal(capabilities.length, 2);
    assert.ok(capabilities.every(({ id }) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ));
    assert.ok(capabilities.some(({ source_set_id }) => source_set_id === keptSetId));
    assert.equal(
      database.selectValue("SELECT status FROM fitness_session_exercises WHERE id=?", [substitutedId]),
      "skipped",
    );
    await assert.rejects(store.undoFitnessSet(keptSetId), /只能撤销进行中/);
    await store.updateSessionReflection(sessionId, "短一些，也是真实训练。");
    assert.equal(
      database.selectValue("SELECT reflection FROM fitness_sessions WHERE id=?", [sessionId]),
      "短一些，也是真实训练。",
    );
    assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("pain notes survive session finish as trimmed history facts without creating capabilities", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    const equipmentId = await store.saveEquipmentWithLoads(
      dumbbellInput(venueId, [load(10000)]),
    );
    const sessionId = await store.startFitnessSession({ venueId });
    const sessionExerciseId = await store.addSessionExercise(
      sessionId,
      "dumbbell-rdl",
      equipmentId,
    );
    const setId = await store.recordFitnessSet({
      sessionExerciseId,
      setIndex: 0,
      setKind: "work",
      loadGrams: 10000,
      reps: 8,
      rir: 2,
      painNote: "  右膝出现刺痛，已停止这一组。  ",
      clientMutationId: "pain-note-history-fact",
    });

    await store.finishFitnessSession(sessionId);

    assert.deepEqual(
      database.selectObjects(
        `SELECT s.id,s.pain_note,se.status exercise_status
         FROM fitness_sets s
         JOIN fitness_session_exercises se ON se.id=s.session_exercise_id
         WHERE s.id=?`,
        [setId],
      ).map((row) => ({ ...row })),
      [{
        id: setId,
        pain_note: "右膝出现刺痛，已停止这一组。",
        exercise_status: "completed",
      }],
      "the user's trimmed note must remain attached to the completed historical set",
    );
    assert.equal(
      Number(database.selectValue(
        `SELECT COUNT(*) FROM fitness_capabilities
         WHERE source_set_id=? OR exercise_id=?`,
        [setId, "dumbbell-rdl"],
      )),
      0,
      "a painful set and its exercise must not become a progression capability",
    );
    const snapshot = await store.loadFitnessSnapshot();
    assert.equal(
      snapshot.sets.find((set) => set.id === setId)?.pain_note,
      "右膝出现刺痛，已停止这一组。",
      "history reads must surface the same verbatim SQLite fact",
    );
  } finally {
    database.close();
  }
});

test("exercise substitution preserves live status and its original-exercise fact after finish", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    const equipmentId = await store.saveEquipmentWithLoads(
      dumbbellInput(venueId, [load(10000)]),
    );
    const sessionId = await store.startFitnessSession({ venueId });
    const activeExerciseId = await store.addSessionExercise(
      sessionId,
      "dumbbell-rdl",
      equipmentId,
    );
    const pendingExerciseId = await store.addSessionExercise(
      sessionId,
      "dumbbell-rdl",
      equipmentId,
    );

    await store.substituteSessionExercise({
      sessionExerciseId: activeExerciseId,
      exerciseId: "goblet-squat",
      equipmentId,
      reason: "硬拉区临时拥挤",
    });
    await store.substituteSessionExercise({
      sessionExerciseId: pendingExerciseId,
      exerciseId: "goblet-squat",
      equipmentId,
      reason: "现场改用同一只哑铃",
    });

    assert.deepEqual(
      database.selectObjects(
        `SELECT id,status,exercise_id,substituted_for_exercise_id,substitution_reason
         FROM fitness_session_exercises
         WHERE id IN (?,?) ORDER BY order_index`,
        [activeExerciseId, pendingExerciseId],
      ).map((row) => ({ ...row })),
      [{
        id: activeExerciseId,
        status: "active",
        exercise_id: "goblet-squat",
        substituted_for_exercise_id: "dumbbell-rdl",
        substitution_reason: "硬拉区临时拥挤",
      }, {
        id: pendingExerciseId,
        status: "pending",
        exercise_id: "goblet-squat",
        substituted_for_exercise_id: "dumbbell-rdl",
        substitution_reason: "现场改用同一只哑铃",
      }],
    );

    await store.recordFitnessSet({
      sessionExerciseId: pendingExerciseId,
      setIndex: 0,
      setKind: "warmup",
      loadGrams: 10000,
      reps: 10,
      clientMutationId: "substitution-remains-recordable",
    });
    await store.finishFitnessSession(sessionId);

    assert.deepEqual(
      database.selectObjects(
        `SELECT id,status,substituted_for_exercise_id,substitution_reason
         FROM fitness_session_exercises
         WHERE id IN (?,?) ORDER BY order_index`,
        [activeExerciseId, pendingExerciseId],
      ).map((row) => ({ ...row })),
      [{
        id: activeExerciseId,
        status: "skipped",
        substituted_for_exercise_id: "dumbbell-rdl",
        substitution_reason: "硬拉区临时拥挤",
      }, {
        id: pendingExerciseId,
        status: "completed",
        substituted_for_exercise_id: "dumbbell-rdl",
        substitution_reason: "现场改用同一只哑铃",
      }],
    );
  } finally {
    database.close();
  }
});

test("duration-only cardio sets persist without invented repetition counts", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const venueId = await store.saveVenue(venueInput);
    const treadmillId = await store.saveEquipmentWithLoads(treadmillInput(venueId));
    const sessionId = await store.startFitnessSession({ venueId });
    const exerciseId = await store.addSessionExercise(
      sessionId,
      "treadmill-steady",
      treadmillId,
    );

    const setId = await store.recordFitnessSet({
      sessionExerciseId: exerciseId,
      setIndex: 0,
      durationSeconds: 1_200,
      rpe: 5,
      clientMutationId: "cardio-duration-only",
    });

    assert.deepEqual(
      database.selectObjects(
        "SELECT id,reps,duration_seconds,load_grams,rpe,completed FROM fitness_sets WHERE id=?",
        [setId],
      ).map((row) => ({ ...row })),
      [{
        id: setId,
        reps: null,
        duration_seconds: 1_200,
        load_grams: null,
        rpe: 5,
        completed: 1,
      }],
    );
    assert.equal(
      database.selectValue("SELECT status FROM fitness_session_exercises WHERE id=?", [exerciseId]),
      "active",
    );
    await store.finishFitnessSession(sessionId);
    assert.equal(
      Number(database.selectValue("SELECT COUNT(*) FROM fitness_capabilities")),
      0,
      "a duration-only fact must not be flattened into a strength capability that cannot express duration",
    );
  } finally {
    database.close();
  }
});

test("store operations take product locks and broadcast only successful writes", async () => {
  const { database } = await databaseFixture();
  try {
    await store.initializeFitnessDatabase();
    const afterInit = { ...globalThis.__fitnessLockState };
    await store.loadFitnessSnapshot();
    assert.equal(globalThis.__fitnessLockState.reads, afterInit.reads + 1);
    const before = { ...globalThis.__fitnessLockState };
    await store.saveVenue(venueInput);
    assert.equal(globalThis.__fitnessLockState.reads, before.reads);
    assert.equal(globalThis.__fitnessLockState.writes, before.writes + 1);
    assert.deepEqual(globalThis.__fitnessLockState.broadcasts, ["venue-saved"]);
    const broadcasts = globalThis.__fitnessLockState.broadcasts.length;
    await assert.rejects(
      store.saveEquipmentWithLoads(dumbbellInput("missing-venue", [load(10000)])),
      /可用场地/,
    );
    assert.equal(globalThis.__fitnessLockState.broadcasts.length, broadcasts);

    for (const api of [
      "initializeFitnessDatabase",
      "loadFitnessSnapshot",
      "saveFitnessProfile",
      "saveVenue",
      "archiveVenue",
      "restoreVenue",
      "saveEquipmentWithLoads",
      "setEquipmentStatus",
      "saveConstraint",
      "setFitnessConstraintActive",
      "saveProgramDraft",
      "scheduleProgramWeek",
      "rescheduleCalendarEvent",
      "markCalendarEventNotPerformed",
      "startFitnessSession",
      "cancelEmptyFitnessSession",
      "addSessionExercise",
      "recordFitnessSet",
      "undoFitnessSet",
      "substituteSessionExercise",
      "completeSessionExercise",
      "finishFitnessSession",
      "updateSessionReflection",
      "saveFitnessSettings",
    ]) {
      assert.equal(typeof store[api], "function", api);
    }
  } finally {
    database.close();
  }
});

test("real lock module keeps a Fitness-only Web Lock and BroadcastChannel contract", async () => {
  const source = await readFile(new URL("lib/fitness/lock.ts", projectRoot), "utf8");
  assert.match(source, /private-ai-suite:fitness:database/);
  assert.match(source, /private-ai-suite:fitness:changes/);
  assert.match(source, /locks\.request\(FITNESS_LOCK_NAME, \{ mode \}, operation\)/);
  assert.match(source, /senderId === senderId/);
  assert.doesNotMatch(source, /career|vocab|zhiji|shici/);
});
