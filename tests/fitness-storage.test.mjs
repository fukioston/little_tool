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
    assert.equal(Number(database.selectValue("PRAGMA user_version")), 1);
    assert.deepEqual(
      database.selectObjects("SELECT version,name FROM fitness_schema_migrations")
        .map((row) => ({ ...row })),
      [{ version: 1, name: schema.SHILIAN_MIGRATION_NAME }],
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
      "saveEquipmentWithLoads",
      "setEquipmentStatus",
      "saveConstraint",
      "saveProgramDraft",
      "scheduleProgramWeek",
      "rescheduleCalendarEvent",
      "markCalendarEventNotPerformed",
      "startFitnessSession",
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
