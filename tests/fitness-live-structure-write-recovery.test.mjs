import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const storeTypeScript = await readFile(new URL("lib/fitness/store.ts", projectRoot), "utf8");

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

const [schemaJavaScript, catalogJavaScript, rawStoreJavaScript] = await Promise.all([
  transpile("lib/schemas/shilian.ts"),
  transpile("lib/fitness/catalog.ts"),
  transpile("lib/fitness/store.ts"),
]);
const schemaUrl = moduleUrl(schemaJavaScript);
const catalogUrl = moduleUrl(catalogJavaScript);
const lockStubUrl = moduleUrl(`
  export async function withFitnessReadLock(task) { return task(); }
  export async function withFitnessWriteLock(task) { return task(); }
  export function broadcastFitnessChange() {}
`);
let storeJavaScript = rawStoreJavaScript;
for (const [specifier, url] of Object.entries({
  "@/lib/local-db/client": moduleUrl(`
    export const localDb = {
      query() { throw new Error("default localDb must not be used in structure tests"); },
      batch() { throw new Error("default localDb must not be used in structure tests"); },
      init() { throw new Error("default localDb must not be used in structure tests"); }
    };
  `),
  "@/lib/schemas/shilian": schemaUrl,
  "./catalog": catalogUrl,
  "./lock": lockStubUrl,
})) {
  storeJavaScript = storeJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const [schema, store] = await Promise.all([
  import(schemaUrl),
  import(moduleUrl(storeJavaScript)),
]);

function executeRun(database, sql, params = []) {
  const statement = database.prepare(sql);
  try {
    if (params.length || (!Array.isArray(params) && Object.keys(params).length)) {
      statement.bind(params);
    }
    while (statement.step()) {
      // Consume returned rows.
    }
  } finally {
    statement.finalize();
  }
  return { changes: Number(database.changes()), lastInsertRowId: null };
}

function installSchema(database) {
  database.transaction("IMMEDIATE", () => {
    for (const { sql } of schema.SHILIAN_SCHEMA_STATEMENTS) executeRun(database, sql);
  });
}

function deterministicUuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function fixture({ withSession = true, secondOrder = 1, now = 1_000 } = {}) {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  installSchema(database);
  const state = {
    now,
    generation: { generationId: "legacy", sequence: 0 },
    uuid: 1,
    lockCalls: 0,
    queryCalls: 0,
    batchCalls: 0,
    broadcasts: [],
    broadcastThrows: false,
    throwAfterBatch: false,
    failQueryAfterBatch: false,
    failQueries: 0,
    failAtStatement: null,
  };
  let tail = Promise.resolve();
  const runtime = {
    async withExclusiveLock(operation) {
      state.lockCalls += 1;
      const previous = tail;
      let release;
      tail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    },
    async query(sql, params = []) {
      state.queryCalls += 1;
      if (state.failQueries > 0) {
        state.failQueries -= 1;
        throw new Error("injected query loss");
      }
      const rows = database.selectObjects(sql, params);
      return { rows, rowCount: rows.length, columns: [] };
    },
    async batch(statements) {
      state.batchCalls += 1;
      const results = database.transaction("IMMEDIATE", () =>
        statements.map(({ sql, params = [] }, index) => {
          if (state.failAtStatement === index) throw new Error("injected mid transaction");
          return executeRun(database, sql, params);
        })
      );
      if (state.throwAfterBatch) {
        state.throwAfterBatch = false;
        if (state.failQueryAfterBatch) {
          state.failQueryAfterBatch = false;
          state.failQueries += 1;
        }
        throw new Error("injected response loss");
      }
      return {
        results,
        changes: results.reduce((sum, result) => sum + result.changes, 0),
      };
    },
    async currentGeneration() { return { ...state.generation }; },
    now() { return state.now; },
    randomUUID() { return deterministicUuid(state.uuid++); },
    broadcast(reason) {
      state.broadcasts.push(reason);
      if (state.broadcastThrows) throw new Error("injected broadcast loss");
    },
  };

  executeRun(database, `INSERT INTO fitness_venues(
    id,name,venue_type,location,area_notes,busy_notes,default_session_minutes,
    supersets_allowed,is_default,status,last_verified_at,created_at,updated_at
  ) VALUES('venue-1','家','home','','','',60,0,1,'active',NULL,10,10)`);
  executeRun(database, `INSERT INTO fitness_equipment(
    id,venue_id,name,kind,area,quantity,status,load_mode,load_semantics,
    min_load_grams,max_load_grams,increment_grams,bar_weight_grams,unilateral,
    busy_level,settings_json,attachments_json,notes,created_at,updated_at
  ) VALUES('equipment-space','venue-1','空地','open_space','',1,'available','none',
    'total',NULL,NULL,NULL,NULL,0,'unknown','{}','[]','',10,10)`);
  executeRun(database, `INSERT INTO fitness_programs(
    id,name,venue_id,goal,split,status,version,source,assumptions_json,created_at,updated_at
  ) VALUES('program-1','基础计划','venue-1','general_health','full_body','active',1,
    'manual','[]',20,20)`);
  executeRun(database, `INSERT INTO fitness_program_days(
    id,program_id,day_index,weekday,kind,name,focus,estimated_minutes,variant,created_at
  ) VALUES('day-1','program-1',0,1,'resistance','全身','基础',45,'standard',20)`);
  executeRun(database, `INSERT INTO fitness_program_items(
    id,program_day_id,exercise_id,equipment_id,resource_equipment_ids_json,
    order_index,sets,rep_min,rep_max,duration_seconds,target_rir,rest_seconds,
    load_grams,load_guidance,rationale,substitution_exercise_ids_json,
    equipment_snapshot,created_at
  ) VALUES('item-1','day-1','bodyweight-squat','equipment-space',
    '["equipment-space"]',0,3,8,12,NULL,2,60,NULL,'自重','基础','["push-up"]',
    '[{"id":"equipment-space"}]',20)`);
  executeRun(database, `INSERT INTO fitness_calendar_events(
    id,program_day_id,venue_id,title,kind,starts_at,occurrence_key,planned_minutes,
    status,rescheduled_from_id,note,created_at,updated_at
  ) VALUES('event-1','day-1','venue-1','今天训练','resistance',100,'1970-01-01',45,
    ?,NULL,'',20,20)`, [withSession ? "in_progress" : "planned"]);
  if (withSession) {
    executeRun(database, `INSERT INTO fitness_sessions(
      id,event_id,venue_id,program_day_id,started_at,ended_at,status,available_minutes,
      energy_note,soreness_note,reflection,created_at,updated_at
    ) VALUES('session-1','event-1','venue-1','day-1',100,NULL,'active',60,
      'usual','','旧感受',100,100)`);
    executeRun(database, `INSERT INTO fitness_session_exercises(
      id,session_id,exercise_id,equipment_id,planned_item_id,order_index,status,
      substituted_for_exercise_id,substitution_reason,equipment_snapshot,note,
      created_at,updated_at
    ) VALUES('exercise-1','session-1','bodyweight-squat','equipment-space','item-1',
      0,'active',NULL,'','[]','',100,100)`);
    executeRun(database, `INSERT INTO fitness_session_exercises(
      id,session_id,exercise_id,equipment_id,planned_item_id,order_index,status,
      substituted_for_exercise_id,substitution_reason,equipment_snapshot,note,
      created_at,updated_at
    ) VALUES('exercise-2','session-1','push-up','equipment-space',NULL,?,
      'pending',NULL,'','[]','',100,100)`, [secondOrder]);
  }
  return {
    database,
    state,
    runtime,
    service: store.createFitnessLiveStructureStorageService(runtime),
  };
}

function mapVenue(row) {
  return {
    ...row,
    supersets_allowed: Number(row.supersets_allowed) === 1,
    is_default: Number(row.is_default) === 1,
  };
}

function mapEquipment(row) {
  const { settings_json, attachments_json, ...rest } = row;
  return {
    ...rest,
    unilateral: Number(row.unilateral) === 1,
    settings: JSON.parse(settings_json),
    attachments: JSON.parse(attachments_json),
  };
}

function mapProgram(row) {
  const { assumptions_json, ...rest } = row;
  return { ...rest, assumptions: JSON.parse(assumptions_json) };
}

function mapItem(row) {
  const {
    resource_equipment_ids_json,
    substitution_exercise_ids_json,
    ...rest
  } = row;
  return {
    ...rest,
    resource_equipment_ids: JSON.parse(resource_equipment_ids_json),
    substitution_exercise_ids: JSON.parse(substitution_exercise_ids_json),
  };
}

function publicSet(row) {
  return {
    id: row.id,
    session_exercise_id: row.session_exercise_id,
    set_index: Number(row.set_index),
    set_kind: row.set_kind,
    load_grams: row.load_grams,
    reps: row.reps,
    duration_seconds: row.duration_seconds,
    rir: row.rir,
    rpe: row.rpe,
    completed: Number(row.completed) === 1,
    pain_note: row.pain_note,
    completed_at: row.completed_at,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function snapshot(database) {
  const sessions = database.selectObjects("SELECT * FROM fitness_sessions ORDER BY started_at DESC");
  const sessionExercises = database.selectObjects(
    "SELECT * FROM fitness_session_exercises ORDER BY session_id,order_index",
  );
  return {
    profile: null,
    venues: database.selectObjects("SELECT * FROM fitness_venues").map(mapVenue),
    equipment: database.selectObjects("SELECT * FROM fitness_equipment").map(mapEquipment),
    equipmentLoads: [],
    constraints: [],
    programs: database.selectObjects("SELECT * FROM fitness_programs").map(mapProgram),
    programDays: database.selectObjects("SELECT * FROM fitness_program_days"),
    programItems: database.selectObjects("SELECT * FROM fitness_program_items").map(mapItem),
    events: database.selectObjects("SELECT * FROM fitness_calendar_events ORDER BY starts_at"),
    sessions,
    sessionExercises,
    sets: database.selectObjects("SELECT * FROM fitness_sets ORDER BY session_exercise_id,set_index")
      .map(publicSet),
    cardioEntries: database.selectObjects("SELECT * FROM fitness_cardio_entries"),
    capabilities: database.selectObjects("SELECT * FROM fitness_capabilities"),
    files: [],
    settings: {
      unit: "kg",
      rest_timer_enabled: true,
      sound_enabled: false,
      ai_enabled: true,
    },
  };
}

function addSet(database, {
  id = "set-1",
  exerciseId = "exercise-1",
  index = 0,
  at = 120,
} = {}) {
  executeRun(database, `INSERT INTO fitness_sets(
    id,session_exercise_id,set_index,set_kind,load_grams,reps,duration_seconds,
    rir,rpe,completed,pain_note,completed_at,client_mutation_id,created_at,updated_at
  ) VALUES(?, ?,?,'work',NULL,8,NULL,2,8,1,'',?, ?,?,?)`, [
    id,
    exerciseId,
    index,
    at,
    `mutation-${id}`,
    at,
    at,
  ]);
}

const startInput = {
  eventId: "event-1",
  venueId: "venue-1",
  availableMinutes: 45,
  energyNote: "usual",
  sorenessNote: "",
};

function startExpected(database) {
  return store.fitnessLiveStartExpectationFromSnapshot(snapshot(database), startInput);
}

function sessionExpected(database) {
  return store.fitnessLiveSessionExpectationFromSnapshot(snapshot(database), "session-1");
}

function addExpected(database) {
  return store.fitnessLiveAddExpectationFromSnapshot(snapshot(database), "session-1");
}

function substituteExpected(database) {
  return store.fitnessLiveSubstituteExpectationFromSnapshot(snapshot(database), "session-1");
}

const addInput = {
  sessionId: "session-1",
  exerciseId: "push-up",
  equipmentId: "equipment-space",
  equipmentSnapshot: '[{"id":"equipment-space"}]',
};

const substituteInput = {
  sessionExerciseId: "exercise-1",
  exerciseId: "push-up",
  equipmentId: "equipment-space",
  equipmentSnapshot: '[{"id":"equipment-space"}]',
  reason: "器材被占",
};

test("start prepare is zero-write, uses a separate strict union, and owns every ID", async () => {
  const { database, state, service } = await fixture({ withSession: false });
  try {
    const receipt = await service.prepareFitnessLiveSessionStart(startInput, startExpected(database));
    assert.equal(state.batchCalls, 0);
    assert.match(receipt.after.session.id, /^session-/);
    assert.match(receipt.after.exercises[0].id, /^session-exercise-/);
    assert.equal(store.isFitnessLiveStructureWriteReceipt(receipt), true);
    assert.equal(store.isFitnessLiveWriteReceipt(receipt), false);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sessions"), 0);
  } finally {
    database.close();
  }
});

test("start prepare snapshots caller input before the lock await", async () => {
  const { database, state, service } = await fixture({ withSession: false });
  try {
    const input = JSON.parse(JSON.stringify(startInput));
    const expected = JSON.parse(JSON.stringify(startExpected(database)));
    const pending = service.prepareFitnessLiveSessionStart(input, expected);
    input.venueId = "mutated-venue";
    expected.venue.id = "mutated-venue";
    expected.programItems[0].exercise_id = "push-up";
    const receipt = await pending;
    assert.equal(receipt.after.session.venue_id, "venue-1");
    assert.equal(receipt.after.exercises[0].exercise_id, "bodyweight-squat");
    assert.equal(state.batchCalls, 0);
  } finally {
    database.close();
  }
});

test("lost start response settles exact, retries once, and survives later workout progress", async () => {
  const { database, state, service } = await fixture({ withSession: false });
  try {
    const receipt = await service.prepareFitnessLiveSessionStart(startInput, startExpected(database));
    state.throwAfterBatch = true;
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sessions"), 1);
    assert.equal(database.selectValue("SELECT status FROM fitness_calendar_events"), "in_progress");
    const marker = database.selectObject(
      "SELECT key,value,updated_at FROM fitness_settings WHERE key LIKE '__fitness_live_structure_receipt__:%'",
    );
    assert.equal(marker.key, `__fitness_live_structure_receipt__:${receipt.operationId}`);
    assert.equal(marker.updated_at, receipt.preparedAt);
    assert.deepEqual(JSON.parse(marker.value), {
      generationId: receipt.generationId,
      generationSequence: receipt.generationSequence,
      kind: receipt.kind,
      projectionSha256: receipt.projectionSha256,
      purpose: "fitness-live-structure-receipt-marker",
      version: 1,
    });
    const targetExercise = receipt.after.exercises[0];
    addSet(database, { exerciseId: targetExercise.id });
    executeRun(database, "UPDATE fitness_session_exercises SET status='completed',updated_at=2000 WHERE id=?", [targetExercise.id]);
    executeRun(database, "UPDATE fitness_sessions SET updated_at=2000 WHERE id=?", [receipt.after.session.id]);
    assert.equal(await service.inspectFitnessLiveStructureWrite(receipt), "exact_saved");
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "already_saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sessions"), 1);
  } finally {
    database.close();
  }
});

test("start tombstone marker prevents resurrection after an exact before restore", async () => {
  const { database, state, service } = await fixture({ withSession: false });
  try {
    const receipt = await service.prepareFitnessLiveSessionStart(startInput, startExpected(database));
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "saved");
    executeRun(database, "DELETE FROM fitness_sessions WHERE id=?", [receipt.after.session.id]);
    executeRun(database,
      "UPDATE fitness_calendar_events SET status=?,updated_at=? WHERE id=?",
      [receipt.before.event.status, receipt.before.event.updated_at, receipt.before.event.id]);
    assert.deepEqual(
      JSON.parse(JSON.stringify(startExpected(database))),
      JSON.parse(JSON.stringify(receipt.context)),
    );
    assert.equal(await service.inspectFitnessLiveStructureWrite(receipt), "changed");
    const batches = state.batchCalls;
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sessions"), 0);
  } finally {
    database.close();
  }
});

test("same-tick start receipts allow only one global active session", async () => {
  const { database, state, service } = await fixture({ withSession: false });
  try {
    const expected = startExpected(database);
    const [first, second] = await Promise.all([
      service.prepareFitnessLiveSessionStart(startInput, expected),
      service.prepareFitnessLiveSessionStart(startInput, expected),
    ]);
    assert.notEqual(first.after.session.id, second.after.session.id);
    assert.equal((await service.commitFitnessLiveStructureWrite(first)).outcome, "saved");
    const batches = state.batchCalls;
    assert.equal((await service.commitFitnessLiveStructureWrite(second)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sessions WHERE status='active'"), 1);
  } finally {
    database.close();
  }
});

test("same-tick temporary starts without an event still allow one active session", async () => {
  const { database, state, service } = await fixture({ withSession: false });
  try {
    const input = { venueId: "venue-1", availableMinutes: 30, energyNote: "lower" };
    const expected = store.fitnessLiveStartExpectationFromSnapshot(snapshot(database), input);
    const [first, second] = await Promise.all([
      service.prepareFitnessLiveSessionStart(input, expected),
      service.prepareFitnessLiveSessionStart(input, expected),
    ]);
    assert.equal(first.after.exercises.length, 0);
    assert.equal((await service.commitFitnessLiveStructureWrite(first)).outcome, "saved");
    const batches = state.batchCalls;
    assert.equal((await service.commitFitnessLiveStructureWrite(second)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue(
      "SELECT COUNT(*) FROM fitness_sessions WHERE status='active'",
    ), 1);
    assert.equal(database.selectValue(
      "SELECT status FROM fitness_calendar_events WHERE id='event-1'",
    ), "planned");
  } finally {
    database.close();
  }
});

test("start stale active-session or plan context is changed with zero commit batch", async () => {
  const firstFixture = await fixture({ withSession: false });
  try {
    const receipt = await firstFixture.service.prepareFitnessLiveSessionStart(
      startInput,
      startExpected(firstFixture.database),
    );
    executeRun(firstFixture.database, `INSERT INTO fitness_sessions(
      id,event_id,venue_id,program_day_id,started_at,ended_at,status,available_minutes,
      energy_note,soreness_note,reflection,created_at,updated_at
    ) VALUES('foreign-session',NULL,'venue-1',NULL,200,NULL,'active',30,'','','',200,200)`);
    assert.equal((await firstFixture.service.commitFitnessLiveStructureWrite(receipt)).outcome, "changed");
    assert.equal(firstFixture.state.batchCalls, 0);
  } finally {
    firstFixture.database.close();
  }

  const secondFixture = await fixture({ withSession: false });
  try {
    const receipt = await secondFixture.service.prepareFitnessLiveSessionStart(
      startInput,
      startExpected(secondFixture.database),
    );
    executeRun(secondFixture.database,
      "UPDATE fitness_program_items SET rationale='另一页改过' WHERE id='item-1'");
    assert.equal((await secondFixture.service.commitFitnessLiveStructureWrite(receipt)).outcome, "changed");
    assert.equal(secondFixture.state.batchCalls, 0);
  } finally {
    secondFixture.database.close();
  }
});

test("generation ABA blocks an otherwise unchanged start receipt", async () => {
  const { database, state, service } = await fixture({ withSession: false });
  try {
    const receipt = await service.prepareFitnessLiveSessionStart(startInput, startExpected(database));
    state.generation = { generationId: deterministicUuid(99), sequence: 1 };
    assert.equal(await service.inspectFitnessLiveStructureWrite(receipt), "changed");
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "changed");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sessions"), 0);
  } finally {
    database.close();
  }
});

test("prepared timestamps advance beyond every bound fact under clock rollback", async () => {
  const startFixture = await fixture({ withSession: false, now: 1 });
  try {
    const receipt = await startFixture.service.prepareFitnessLiveSessionStart(
      startInput,
      startExpected(startFixture.database),
    );
    assert.equal(receipt.preparedAt, 21);
  } finally {
    startFixture.database.close();
  }

  const completeFixture = await fixture({ now: 1 });
  try {
    addSet(completeFixture.database, { at: 2_000 });
    const receipt = await completeFixture.service.prepareFitnessLiveExerciseComplete(
      { sessionExerciseId: "exercise-1" },
      sessionExpected(completeFixture.database),
    );
    assert.equal(receipt.preparedAt, 2_001);
  } finally {
    completeFixture.database.close();
  }
});

test("start expectations reject malformed enums, duplicate IDs, and oversized JSON", async () => {
  const { database, state, service } = await fixture({ withSession: false });
  try {
    const expected = startExpected(database);
    const invalidCases = [
      { ...expected, event: { ...expected.event, kind: "unsupported" } },
      { ...expected, programItems: [expected.programItems[0], expected.programItems[0]] },
      {
        ...expected,
        program: { ...expected.program, assumptions: ["大".repeat(500_001)] },
      },
      {
        ...expected,
        equipment: [{ ...expected.equipment[0], kind: "unsupported" }],
      },
    ];
    for (const invalid of invalidCases) {
      await assert.rejects(
        service.prepareFitnessLiveSessionStart(startInput, invalid),
        (error) => error.code === "invalid_input",
      );
    }
    assert.equal(state.batchCalls, 0);
  } finally {
    database.close();
  }
});

test("add binds sparse MAX+1, response loss, and later target progress", async () => {
  const { database, state, service } = await fixture({ secondOrder: 2 });
  try {
    const expected = addExpected(database);
    assert.equal(expected.nextOrderIndex, 3);
    const receipt = await service.prepareFitnessLiveExerciseAdd(addInput, expected);
    const target = receipt.after.exercises.find(({ id }) =>
      !receipt.before.exercises.some((before) => before.id === id));
    assert.equal(target.order_index, 3);
    assert.equal(state.batchCalls, 0);
    state.throwAfterBatch = true;
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "saved");
    executeRun(database, `UPDATE fitness_session_exercises SET exercise_id='dead-bug',
      status='completed',substituted_for_exercise_id='push-up',
      substitution_reason='后来替换',updated_at=3000 WHERE id=?`, [target.id]);
    assert.equal(await service.inspectFitnessLiveStructureWrite(receipt), "exact_saved");
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "already_saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_session_exercises"), 3);
  } finally {
    database.close();
  }
});

test("two add receipts never duplicate an exercise", async () => {
  const { database, state, service } = await fixture();
  try {
    const expected = addExpected(database);
    const [first, second] = await Promise.all([
      service.prepareFitnessLiveExerciseAdd(addInput, expected),
      service.prepareFitnessLiveExerciseAdd(addInput, expected),
    ]);
    assert.equal((await service.commitFitnessLiveStructureWrite(first)).outcome, "saved");
    const batches = state.batchCalls;
    assert.equal((await service.commitFitnessLiveStructureWrite(second)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_session_exercises"), 3);
  } finally {
    database.close();
  }
});

test("add tombstone marker cannot recreate a deleted target from exact before", async () => {
  const { database, state, service } = await fixture();
  try {
    const receipt = await service.prepareFitnessLiveExerciseAdd(addInput, addExpected(database));
    const target = receipt.after.exercises.find(({ id }) =>
      !receipt.before.exercises.some((before) => before.id === id));
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "saved");
    executeRun(database, "DELETE FROM fitness_session_exercises WHERE id=?", [target.id]);
    executeRun(database, "UPDATE fitness_sessions SET updated_at=? WHERE id=?", [
      receipt.before.session.updated_at,
      receipt.before.session.id,
    ]);
    assert.deepEqual(
      JSON.parse(JSON.stringify(addExpected(database).projection)),
      JSON.parse(JSON.stringify(receipt.before)),
    );
    assert.equal(await service.inspectFitnessLiveStructureWrite(receipt), "changed");
    const batches = state.batchCalls;
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue(
      "SELECT COUNT(*) FROM fitness_session_exercises WHERE id=?", [target.id],
    ), 0);
  } finally {
    database.close();
  }
});

test("target-forward matching rejects illegal lifecycle and substitution divergence", async () => {
  const sessionFixture = await fixture({ withSession: false });
  try {
    const receipt = await sessionFixture.service.prepareFitnessLiveSessionStart(
      startInput,
      startExpected(sessionFixture.database),
    );
    assert.equal(
      (await sessionFixture.service.commitFitnessLiveStructureWrite(receipt)).outcome,
      "saved",
    );
    executeRun(sessionFixture.database, `UPDATE fitness_sessions
      SET ended_at=2000,updated_at=2000 WHERE id=?`, [receipt.after.session.id]);
    assert.equal(
      await sessionFixture.service.inspectFitnessLiveStructureWrite(receipt),
      "changed",
    );
    const batches = sessionFixture.state.batchCalls;
    assert.equal(
      (await sessionFixture.service.commitFitnessLiveStructureWrite(receipt)).outcome,
      "changed",
    );
    assert.equal(sessionFixture.state.batchCalls, batches);
  } finally {
    sessionFixture.database.close();
  }

  const startExerciseFixture = await fixture({ withSession: false });
  try {
    const receipt = await startExerciseFixture.service.prepareFitnessLiveSessionStart(
      startInput,
      startExpected(startExerciseFixture.database),
    );
    assert.equal(
      (await startExerciseFixture.service.commitFitnessLiveStructureWrite(receipt)).outcome,
      "saved",
    );
    executeRun(startExerciseFixture.database, `UPDATE fitness_session_exercises
      SET exercise_id='push-up',substituted_for_exercise_id=NULL,updated_at=2000
      WHERE id=?`, [receipt.after.exercises[0].id]);
    assert.equal(
      await startExerciseFixture.service.inspectFitnessLiveStructureWrite(receipt),
      "changed",
    );
  } finally {
    startExerciseFixture.database.close();
  }

  const addFixture = await fixture();
  try {
    const receipt = await addFixture.service.prepareFitnessLiveExerciseAdd(
      addInput,
      addExpected(addFixture.database),
    );
    const target = receipt.after.exercises.find(({ id }) =>
      !receipt.before.exercises.some((before) => before.id === id));
    assert.equal(
      (await addFixture.service.commitFitnessLiveStructureWrite(receipt)).outcome,
      "saved",
    );
    executeRun(addFixture.database, `UPDATE fitness_session_exercises
      SET status='substituted',updated_at=2000 WHERE id=?`, [target.id]);
    assert.equal(
      await addFixture.service.inspectFitnessLiveStructureWrite(receipt),
      "changed",
    );
  } finally {
    addFixture.database.close();
  }

  const substituteFixture = await fixture();
  try {
    const receipt = await substituteFixture.service.prepareFitnessLiveExerciseSubstitute(
      substituteInput,
      substituteExpected(substituteFixture.database),
    );
    assert.equal(
      (await substituteFixture.service.commitFitnessLiveStructureWrite(receipt)).outcome,
      "saved",
    );
    executeRun(substituteFixture.database, `UPDATE fitness_session_exercises
      SET status='pending',updated_at=2000 WHERE id='exercise-1'`);
    assert.equal(
      await substituteFixture.service.inspectFitnessLiveStructureWrite(receipt),
      "changed",
    );
  } finally {
    substituteFixture.database.close();
  }
});

test("complete response loss atomically advances exactly one next action", async () => {
  const { database, state, service } = await fixture();
  try {
    addSet(database);
    const receipt = await service.prepareFitnessLiveExerciseComplete(
      { sessionExerciseId: "exercise-1" },
      sessionExpected(database),
    );
    state.throwAfterBatch = true;
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "saved");
    assert.deepEqual(database.selectObjects(
      "SELECT id,status FROM fitness_session_exercises ORDER BY order_index",
    ).map(({ id, status }) => ({ id, status })), [
      { id: "exercise-1", status: "completed" },
      { id: "exercise-2", status: "active" },
    ]);
    addSet(database, { id: "set-later", exerciseId: "exercise-2", at: 2_000 });
    executeRun(database, `UPDATE fitness_session_exercises
      SET status='completed',updated_at=2000 WHERE id='exercise-2'`);
    executeRun(database, `UPDATE fitness_sessions
      SET status='completed',ended_at=2000,updated_at=2000 WHERE id='session-1'`);
    assert.equal(await service.inspectFitnessLiveStructureWrite(receipt), "exact_saved");
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "already_saved");
    assert.equal(database.selectValue(
      "SELECT status FROM fitness_sessions WHERE id='session-1'",
    ), "completed");
    assert.equal(database.selectValue(
      "SELECT COUNT(*) FROM fitness_sets WHERE id='set-later'",
    ), 1);
  } finally {
    database.close();
  }
});

test("skip requires zero facts while complete requires a recorded fact", async () => {
  const skippedFixture = await fixture();
  try {
    const receipt = await skippedFixture.service.prepareFitnessLiveExerciseComplete(
      { sessionExerciseId: "exercise-1", skipped: true },
      sessionExpected(skippedFixture.database),
    );
    assert.equal((await skippedFixture.service.commitFitnessLiveStructureWrite(receipt)).outcome, "saved");
    assert.equal(skippedFixture.database.selectValue(
      "SELECT status FROM fitness_session_exercises WHERE id='exercise-1'",
    ), "skipped");
  } finally {
    skippedFixture.database.close();
  }

  const completeFixture = await fixture();
  try {
    await assert.rejects(
      completeFixture.service.prepareFitnessLiveExerciseComplete(
        { sessionExerciseId: "exercise-1" },
        sessionExpected(completeFixture.database),
      ),
      (error) => error.code === "changed",
    );
    addSet(completeFixture.database);
    await assert.rejects(
      completeFixture.service.prepareFitnessLiveExerciseComplete(
        { sessionExerciseId: "exercise-1", skipped: true },
        sessionExpected(completeFixture.database),
      ),
      (error) => error.code === "changed",
    );
    assert.equal(completeFixture.state.batchCalls, 0);
  } finally {
    completeFixture.database.close();
  }
});

test("pending targets and legacy double-active sessions fail before complete writes", async () => {
  const pendingFixture = await fixture();
  try {
    await assert.rejects(
      pendingFixture.service.prepareFitnessLiveExerciseComplete(
        { sessionExerciseId: "exercise-2", skipped: true },
        sessionExpected(pendingFixture.database),
      ),
      (error) => error.code === "changed",
    );
    assert.equal(pendingFixture.state.batchCalls, 0);
  } finally {
    pendingFixture.database.close();
  }

  const doubleFixture = await fixture();
  try {
    executeRun(doubleFixture.database,
      "UPDATE fitness_session_exercises SET status='active' WHERE id='exercise-2'");
    addSet(doubleFixture.database);
    await assert.rejects(
      doubleFixture.service.prepareFitnessLiveExerciseComplete(
        { sessionExerciseId: "exercise-1" },
        sessionExpected(doubleFixture.database),
      ),
      (error) => error.code === "changed",
    );
    assert.equal(doubleFixture.state.batchCalls, 0);
  } finally {
    doubleFixture.database.close();
  }
});

test("complete stale projection never overwrites a later set", async () => {
  const { database, state, service } = await fixture();
  try {
    addSet(database);
    const receipt = await service.prepareFitnessLiveExerciseComplete(
      { sessionExerciseId: "exercise-1" }, sessionExpected(database),
    );
    addSet(database, { id: "set-later", index: 1, at: 130 });
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "changed");
    assert.equal(state.batchCalls, 0);
    assert.equal(database.selectValue("SELECT status FROM fitness_session_exercises WHERE id='exercise-1'"), "active");
  } finally {
    database.close();
  }
});

test("substitute response loss preserves the original chain and survives later set progress", async () => {
  const { database, state, service } = await fixture();
  try {
    const receipt = await service.prepareFitnessLiveExerciseSubstitute(
      substituteInput,
      substituteExpected(database),
    );
    state.throwAfterBatch = true;
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "saved");
    assert.deepEqual(database.selectObject(`SELECT exercise_id,
      substituted_for_exercise_id,substitution_reason
      FROM fitness_session_exercises WHERE id='exercise-1'`), {
      exercise_id: "push-up",
      substituted_for_exercise_id: "bodyweight-squat",
      substitution_reason: "器材被占",
    });
    addSet(database);
    executeRun(database,
      "UPDATE fitness_session_exercises SET status='completed',updated_at=3000 WHERE id='exercise-1'");
    assert.equal(await service.inspectFitnessLiveStructureWrite(receipt), "exact_saved");
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "already_saved");
  } finally {
    database.close();
  }
});

test("substitute rejects pending, double-active, same-exercise, and recorded targets", async () => {
  const cases = ["pending", "double", "same", "recorded"];
  for (const scenario of cases) {
    const { database, state, service } = await fixture();
    try {
      let input = substituteInput;
      if (scenario === "pending") input = { ...input, sessionExerciseId: "exercise-2" };
      if (scenario === "double") executeRun(database,
        "UPDATE fitness_session_exercises SET status='active' WHERE id='exercise-2'");
      if (scenario === "same") input = { ...input, exerciseId: "bodyweight-squat" };
      if (scenario === "recorded") addSet(database);
      await assert.rejects(
        service.prepareFitnessLiveExerciseSubstitute(input, substituteExpected(database)),
        (error) => error.code === "changed",
      );
      assert.equal(state.batchCalls, 0);
    } finally {
      database.close();
    }
  }
});

test("reflection response loss is exact through compatible progress but never through new text", async () => {
  const { database, state, service } = await fixture();
  try {
    const expected = database.selectObject("SELECT * FROM fitness_sessions WHERE id='session-1'");
    const receipt = await service.prepareFitnessLiveSessionReflection(
      "session-1", "  今天状态稳定  ", expected,
    );
    state.throwAfterBatch = true;
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "saved");
    executeRun(database, `UPDATE fitness_sessions SET status='completed',ended_at=2000,
      updated_at=2000 WHERE id='session-1'`);
    assert.equal(await service.inspectFitnessLiveStructureWrite(receipt), "exact_saved");
    executeRun(database, `UPDATE fitness_sessions SET reflection='另一段文字',updated_at=3000
      WHERE id='session-1'`);
    assert.equal(await service.inspectFitnessLiveStructureWrite(receipt), "changed");
  } finally {
    database.close();
  }
});

test("reflection marker rejects same-id same-text session ABA and immutable divergence", async () => {
  const abaFixture = await fixture();
  try {
    const expected = abaFixture.database.selectObject(
      "SELECT * FROM fitness_sessions WHERE id='session-1'",
    );
    const receipt = await abaFixture.service.prepareFitnessLiveSessionReflection(
      "session-1", "同一段文字", expected,
    );
    assert.equal(
      (await abaFixture.service.commitFitnessLiveStructureWrite(receipt)).outcome,
      "saved",
    );
    executeRun(abaFixture.database, "DELETE FROM fitness_sessions WHERE id='session-1'");
    executeRun(abaFixture.database, `INSERT INTO fitness_sessions(
      id,event_id,venue_id,program_day_id,started_at,ended_at,status,available_minutes,
      energy_note,soreness_note,reflection,created_at,updated_at
    ) VALUES('session-1',NULL,'venue-1',NULL,2000,NULL,'active',30,
      'lower','另一身体事实',?,2000,2000)`, [receipt.after.reflection]);
    assert.equal(
      await abaFixture.service.inspectFitnessLiveStructureWrite(receipt),
      "changed",
    );
    const batches = abaFixture.state.batchCalls;
    assert.equal(
      (await abaFixture.service.commitFitnessLiveStructureWrite(receipt)).outcome,
      "changed",
    );
    assert.equal(abaFixture.state.batchCalls, batches);
  } finally {
    abaFixture.database.close();
  }

  const divergenceFixture = await fixture();
  try {
    const expected = divergenceFixture.database.selectObject(
      "SELECT * FROM fitness_sessions WHERE id='session-1'",
    );
    const receipt = await divergenceFixture.service.prepareFitnessLiveSessionReflection(
      "session-1", "仍然同文", expected,
    );
    assert.equal(
      (await divergenceFixture.service.commitFitnessLiveStructureWrite(receipt)).outcome,
      "saved",
    );
    executeRun(divergenceFixture.database, `UPDATE fitness_sessions
      SET available_minutes=30,updated_at=2000 WHERE id='session-1'`);
    assert.equal(
      await divergenceFixture.service.inspectFitnessLiveStructureWrite(receipt),
      "changed",
    );
    const batches = divergenceFixture.state.batchCalls;
    assert.equal(
      (await divergenceFixture.service.commitFitnessLiveStructureWrite(receipt)).outcome,
      "changed",
    );
    assert.equal(divergenceFixture.state.batchCalls, batches);
  } finally {
    divergenceFixture.database.close();
  }
});

test("two reflection editors cannot overwrite the newer full-row truth", async () => {
  const { database, state, service } = await fixture();
  try {
    const expected = database.selectObject("SELECT * FROM fitness_sessions WHERE id='session-1'");
    const [first, second] = await Promise.all([
      service.prepareFitnessLiveSessionReflection("session-1", "甲", expected),
      service.prepareFitnessLiveSessionReflection("session-1", "乙", expected),
    ]);
    assert.equal((await service.commitFitnessLiveStructureWrite(first)).outcome, "saved");
    const batches = state.batchCalls;
    assert.equal((await service.commitFitnessLiveStructureWrite(second)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT reflection FROM fitness_sessions"), "甲");
  } finally {
    database.close();
  }
});

test("reflection enforces the 4000-character editor contract and stale prepare", async () => {
  const { database, state, service } = await fixture();
  try {
    const expected = database.selectObject("SELECT * FROM fitness_sessions WHERE id='session-1'");
    await assert.rejects(
      service.prepareFitnessLiveSessionReflection("session-1", "长".repeat(4_001), expected),
      (error) => error.code === "invalid_input",
    );
    executeRun(database,
      "UPDATE fitness_sessions SET reflection='别处修改',updated_at=200 WHERE id='session-1'");
    await assert.rejects(
      service.prepareFitnessLiveSessionReflection("session-1", "新文字", expected),
      (error) => error.code === "changed",
    );
    assert.equal(state.batchCalls, 0);
  } finally {
    database.close();
  }
});

test("marker-tail transaction failure rolls back session, exercises, and event together", async () => {
  const { database, state, service } = await fixture({ withSession: false });
  try {
    const receipt = await service.prepareFitnessLiveSessionStart(startInput, startExpected(database));
    state.failAtStatement = 4;
    await assert.rejects(
      service.commitFitnessLiveStructureWrite(receipt),
      (error) => error.code === "write_failed",
    );
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sessions"), 0);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_session_exercises"), 0);
    assert.equal(database.selectValue("SELECT status FROM fitness_calendar_events"), "planned");
    assert.equal(database.selectValue(
      "SELECT COUNT(*) FROM fitness_settings WHERE key LIKE '__fitness_live_structure_receipt__:%'",
    ), 0);
  } finally {
    database.close();
  }
});

test("lost response plus failed settle remains uncertain until inspect", async () => {
  const { database, state, service } = await fixture();
  try {
    const expected = database.selectObject("SELECT * FROM fitness_sessions WHERE id='session-1'");
    const receipt = await service.prepareFitnessLiveSessionReflection(
      "session-1", "已保存", expected,
    );
    state.throwAfterBatch = true;
    state.failQueryAfterBatch = true;
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "outcome_uncertain");
    assert.equal(await service.inspectFitnessLiveStructureWrite(receipt), "exact_saved");
  } finally {
    database.close();
  }
});

test("commit snapshots caller receipt before crypto await and broadcast failure cannot reverse", async () => {
  const { database, state, service } = await fixture();
  try {
    const expected = database.selectObject("SELECT * FROM fitness_sessions WHERE id='session-1'");
    const receipt = JSON.parse(JSON.stringify(
      await service.prepareFitnessLiveSessionReflection("session-1", "原目标", expected),
    ));
    state.broadcastThrows = true;
    const pending = service.commitFitnessLiveStructureWrite(receipt);
    receipt.after.reflection = "调用后篡改";
    receipt.before.updated_at += 50;
    const result = await pending;
    assert.equal(result.outcome, "saved");
    assert.equal(database.selectValue("SELECT reflection FROM fitness_sessions"), "原目标");
    assert.equal(result.receipt.after.reflection, "原目标");
  } finally {
    database.close();
  }
});

test("tampered structure receipts are invalid and default runtime requires Web Locks", async () => {
  const { database, state, service } = await fixture();
  try {
    const expected = database.selectObject("SELECT * FROM fitness_sessions WHERE id='session-1'");
    const receipt = await service.prepareFitnessLiveSessionReflection(
      "session-1", "新感受", expected,
    );
    assert.equal(await service.inspectFitnessLiveStructureWrite({ ...receipt, extra: true }), "invalid_receipt");
    await assert.rejects(
      service.commitFitnessLiveStructureWrite({ ...receipt, after: { ...receipt.after, reflection: "伪造" } }),
      (error) => error.code === "invalid_receipt",
    );
    assert.equal(state.batchCalls, 0);
    assert.match(
      storeTypeScript,
      /createFitnessLiveStructureStorageService\([\s\S]{0,600}withFitnessWriteLock\(operation, \{ requireSupport: true \}\)/,
    );
  } finally {
    database.close();
  }
});

test("a colliding durable marker fails closed without a business write", async () => {
  const { database, state, service } = await fixture();
  try {
    const expected = database.selectObject("SELECT * FROM fitness_sessions WHERE id='session-1'");
    const receipt = await service.prepareFitnessLiveSessionReflection(
      "session-1", "不得写入", expected,
    );
    executeRun(database,
      "INSERT INTO fitness_settings(key,value,updated_at) VALUES(?,?,?)",
      [`__fitness_live_structure_receipt__:${receipt.operationId}`, '{"kind":"collision"}', 1]);
    assert.equal(await service.inspectFitnessLiveStructureWrite(receipt), "changed");
    assert.equal((await service.commitFitnessLiveStructureWrite(receipt)).outcome, "changed");
    assert.equal(state.batchCalls, 0);
    assert.equal(database.selectValue(
      "SELECT reflection FROM fitness_sessions WHERE id='session-1'",
    ), "旧感受");
  } finally {
    database.close();
  }
});
