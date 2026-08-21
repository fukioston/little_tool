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
      query() { throw new Error("default localDb must not be used in receipt tests"); },
      batch() { throw new Error("default localDb must not be used in receipt tests"); },
      init() { throw new Error("default localDb must not be used in receipt tests"); }
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function resignReceipt(receipt) {
  const { projectionSha256: _oldHash, ...projection } = receipt;
  void _oldHash;
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(projection)),
  ));
  return {
    ...projection,
    projectionSha256: Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}

function localAt(year, month, day, hour, minute = 0, millisecond = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, millisecond).getTime();
}

function occurrenceKey(timestamp) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function nextWeekdayAtSix(anchorAt, weekday) {
  const anchor = new Date(anchorAt);
  const target = new Date(anchorAt);
  target.setDate(target.getDate() + ((weekday - target.getDay() + 7) % 7));
  target.setHours(18, 0, 0, 0);
  if (target.getTime() < anchor.getTime()) target.setDate(target.getDate() + 7);
  return target.getTime();
}

const planDraft = {
  name: "基础计划",
  venue_id: "venue-1",
  goal: "general_health",
  split: "full_body",
  assumptions: [],
  warnings: [],
  days: [{
    weekday: 1,
    kind: "resistance",
    name: "全身训练",
    focus: "基础",
    estimated_minutes: 45,
    items: [{
      exercise_id: "bodyweight-squat",
      equipment_id: "equipment-space",
      resource_equipment_ids: ["equipment-space"],
      order_index: 0,
      sets: 3,
      rep_min: 8,
      rep_max: 12,
      duration_seconds: null,
      target_rir: 2,
      rest_seconds: 60,
      load_grams: null,
      load_guidance: "自重",
      rationale: "基础动作",
      substitution_exercise_ids: ["push-up"],
      equipment_snapshot: "[]",
    }],
  }],
};

async function fixture({ now = 1_000, weekday = 1 } = {}) {
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
  ) VALUES('day-1','program-1',0,?,'resistance','全身训练','基础',45,'standard',20)`,
  [weekday]);
  executeRun(database, `INSERT INTO fitness_program_items(
    id,program_day_id,exercise_id,equipment_id,resource_equipment_ids_json,
    order_index,sets,rep_min,rep_max,duration_seconds,target_rir,rest_seconds,
    load_grams,load_guidance,rationale,substitution_exercise_ids_json,
    equipment_snapshot,created_at
  ) VALUES('item-1','day-1','bodyweight-squat','equipment-space',
    '["equipment-space"]',0,3,8,12,NULL,2,60,NULL,'自重','基础动作','["push-up"]',
    '[{"id":"equipment-space","venue_id":"venue-1","name":"空地","kind":"open_space","quantity":1,"status":"available","load_mode":"none","load_semantics":"total","min_load_grams":null,"max_load_grams":null,"increment_grams":null,"bar_weight_grams":null,"loads":[]}]',20)`);
  executeRun(database, `INSERT INTO fitness_calendar_events(
    id,program_day_id,venue_id,title,kind,starts_at,occurrence_key,planned_minutes,
    status,rescheduled_from_id,note,created_at,updated_at
  ) VALUES('calendar-1',NULL,'venue-1','临时安排','resistance',5000,NULL,45,
    'planned',NULL,'旧说明',30,30)`);

  return {
    database,
    state,
    runtime,
    programService: store.createFitnessProgramStorageService(runtime),
    calendarService: store.createFitnessCalendarStorageService(runtime),
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
  const { resource_equipment_ids_json, substitution_exercise_ids_json, ...rest } = row;
  return {
    ...rest,
    resource_equipment_ids: JSON.parse(resource_equipment_ids_json),
    substitution_exercise_ids: JSON.parse(substitution_exercise_ids_json),
  };
}

function snapshot(database) {
  return {
    profile: null,
    venues: database.selectObjects("SELECT * FROM fitness_venues ORDER BY id").map(mapVenue),
    equipment: database.selectObjects("SELECT * FROM fitness_equipment ORDER BY id").map(mapEquipment),
    equipmentLoads: [],
    constraints: [],
    programs: database.selectObjects("SELECT * FROM fitness_programs ORDER BY version,id").map(mapProgram),
    programDays: database.selectObjects("SELECT * FROM fitness_program_days ORDER BY day_index,id"),
    programItems: database.selectObjects("SELECT * FROM fitness_program_items ORDER BY order_index,id").map(mapItem),
    events: database.selectObjects("SELECT * FROM fitness_calendar_events ORDER BY starts_at,id"),
    sessions: [],
    sessionExercises: [],
    sets: [],
    cardioEntries: [],
    capabilities: [],
    files: [],
    settings: {
      unit: "kg",
      rest_timer_enabled: true,
      sound_enabled: false,
      ai_enabled: true,
    },
  };
}

function versionExpected(database, draft = planDraft) {
  return store.fitnessProgramVersionScheduleExpectationFromSnapshot(snapshot(database), draft);
}

function weekExpected(database, anchorAt) {
  return store.fitnessProgramWeekScheduleExpectationFromSnapshot(
    snapshot(database),
    "program-1",
    anchorAt,
  );
}

function calendarExpected(database) {
  return database.selectObject("SELECT * FROM fitness_calendar_events WHERE id='calendar-1'");
}

function insertOccurrence(database, anchorAt) {
  const startsAt = nextWeekdayAtSix(anchorAt, 1);
  executeRun(database, `INSERT INTO fitness_calendar_events(
    id,program_day_id,venue_id,title,kind,starts_at,occurrence_key,planned_minutes,
    status,rescheduled_from_id,note,created_at,updated_at
  ) VALUES('existing-occurrence','day-1','venue-1','全身训练','resistance',?,?,45,
    'planned',NULL,'',40,40)`, [startsAt, occurrenceKey(startsAt)]);
  return startsAt;
}

test("program version prepare is zero-write, canonicalizes source, and owns stable targets", async () => {
  const anchorAt = localAt(2026, 3, 2, 17, 59);
  const { database, state, programService } = await fixture();
  try {
    const receipt = await programService.prepareFitnessProgramVersionSchedule(
      { draft: planDraft, anchorAt },
      versionExpected(database),
    );
    assert.equal(state.batchCalls, 0);
    assert.equal(receipt.request.source, "local");
    assert.equal(receipt.after.program.version, 2);
    assert.match(receipt.after.program.id, /^program-/);
    assert.match(receipt.after.days[0].id, /^program-day-/);
    assert.match(receipt.after.items[0].id, /^program-item-/);
    assert.match(receipt.after.events[0].id, /^event-/);
    assert.equal(receipt.after.events[0].starts_at, localAt(2026, 3, 2, 18));
    assert.equal(store.isFitnessProgramWriteReceipt(receipt), true);
    assert.equal(store.isFitnessLiveWriteReceipt(receipt), false);
    assert.equal(store.isFitnessLiveStructureWriteReceipt(receipt), false);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_programs"), 1);
  } finally {
    database.close();
  }
});

test("program prepare snapshots source, draft, and expected before the lock await", async () => {
  const anchorAt = localAt(2026, 3, 2, 17, 59);
  const { database, state, programService } = await fixture();
  try {
    const input = { draft: structuredClone(planDraft), anchorAt };
    const expected = structuredClone(versionExpected(database));
    const pending = programService.prepareFitnessProgramVersionSchedule(input, expected);
    input.source = "manual";
    input.draft.name = "被改写";
    expected.venue.name = "被改写";
    const receipt = await pending;
    assert.equal(receipt.request.source, "local");
    assert.equal(receipt.request.draft.name, "基础计划");
    assert.equal(receipt.before.venue.name, "家");
    assert.equal(state.batchCalls, 0);
  } finally {
    database.close();
  }
});

test("lost version response settles exact and compatible archive/reschedule stays exact", async () => {
  const anchorAt = localAt(2026, 3, 2, 17, 59);
  const { database, state, programService } = await fixture();
  try {
    const receipt = await programService.prepareFitnessProgramVersionSchedule(
      { draft: planDraft, source: "manual", anchorAt },
      versionExpected(database),
    );
    state.throwAfterBatch = true;
    assert.equal((await programService.commitFitnessProgramWrite(receipt)).outcome, "saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_programs"), 2);
    assert.equal(database.selectValue("SELECT status FROM fitness_programs WHERE id='program-1'"), "archived");
    assert.equal(database.selectValue(
      "SELECT COUNT(*) FROM fitness_settings WHERE key=?",
      [`__fitness_program_receipt__:${receipt.operationId}`],
    ), 1);
    executeRun(database,
      "UPDATE fitness_programs SET status='archived',updated_at=5000 WHERE id=?",
      [receipt.after.program.id]);
    executeRun(database, `UPDATE fitness_calendar_events
      SET starts_at=starts_at+86400000,status='not_performed',note='后来变化',updated_at=5000
      WHERE id=?`, [receipt.after.events[0].id]);
    assert.equal(await programService.inspectFitnessProgramWrite(receipt), "exact_saved");
    assert.equal((await programService.commitFitnessProgramWrite(receipt)).outcome, "already_saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_programs"), 2);
  } finally {
    database.close();
  }
});

test("version target tombstone never replays after its exact before is restored", async () => {
  const anchorAt = localAt(2026, 3, 2, 17, 59);
  const { database, state, programService } = await fixture();
  try {
    const receipt = await programService.prepareFitnessProgramVersionSchedule(
      { draft: planDraft, anchorAt },
      versionExpected(database),
    );
    assert.equal((await programService.commitFitnessProgramWrite(receipt)).outcome, "saved");
    executeRun(database, "DELETE FROM fitness_calendar_events WHERE program_day_id=?", [receipt.after.days[0].id]);
    executeRun(database, "DELETE FROM fitness_program_items WHERE program_day_id=?", [receipt.after.days[0].id]);
    executeRun(database, "DELETE FROM fitness_program_days WHERE program_id=?", [receipt.after.program.id]);
    executeRun(database, "DELETE FROM fitness_programs WHERE id=?", [receipt.after.program.id]);
    executeRun(database,
      "UPDATE fitness_programs SET status='active',updated_at=20 WHERE id='program-1'");
    assert.deepEqual(versionExpected(database), receipt.before);
    assert.equal(await programService.inspectFitnessProgramWrite(receipt), "changed");
    const batches = state.batchCalls;
    assert.equal((await programService.commitFitnessProgramWrite(receipt)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_programs"), 1);
  } finally {
    database.close();
  }
});

test("a marker collision and a missing target both fail closed without a write", async () => {
  const anchorAt = localAt(2026, 3, 2, 17, 59);
  const collision = await fixture();
  try {
    const receipt = await collision.programService.prepareFitnessProgramVersionSchedule(
      { draft: planDraft, anchorAt },
      versionExpected(collision.database),
    );
    executeRun(collision.database,
      "INSERT INTO fitness_settings(key,value,updated_at) VALUES(?,?,?)",
      [`__fitness_program_receipt__:${receipt.operationId}`, "collision", receipt.preparedAt]);
    assert.equal((await collision.programService.commitFitnessProgramWrite(receipt)).outcome, "changed");
    assert.equal(collision.state.batchCalls, 0);
  } finally {
    collision.database.close();
  }

  const missing = await fixture();
  try {
    const receipt = await missing.programService.prepareFitnessProgramVersionSchedule(
      { draft: planDraft, anchorAt },
      versionExpected(missing.database),
    );
    assert.equal((await missing.programService.commitFitnessProgramWrite(receipt)).outcome, "saved");
    executeRun(missing.database, "DELETE FROM fitness_calendar_events WHERE id=?", [receipt.after.events[0].id]);
    const batches = missing.state.batchCalls;
    assert.equal(await missing.programService.inspectFitnessProgramWrite(receipt), "changed");
    assert.equal((await missing.programService.commitFitnessProgramWrite(receipt)).outcome, "changed");
    assert.equal(missing.state.batchCalls, batches);
    assert.equal(missing.database.selectValue("SELECT COUNT(*) FROM fitness_calendar_events WHERE program_day_id=?", [receipt.after.days[0].id]), 0);
  } finally {
    missing.database.close();
  }
});

test("version transaction rolls back program, children, archive, and marker together", async () => {
  const anchorAt = localAt(2026, 3, 2, 17, 59);
  const { database, state, programService } = await fixture();
  try {
    const receipt = await programService.prepareFitnessProgramVersionSchedule(
      { draft: planDraft, anchorAt },
      versionExpected(database),
    );
    state.failAtStatement = 6;
    await assert.rejects(
      programService.commitFitnessProgramWrite(receipt),
      (error) => error.code === "write_failed",
    );
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_programs"), 1);
    assert.equal(database.selectValue("SELECT status FROM fitness_programs WHERE id='program-1'"), "active");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_settings"), 0);
  } finally {
    database.close();
  }
});

test("same-view version receipts allow only one new active version", async () => {
  const anchorAt = localAt(2026, 3, 2, 17, 59);
  const { database, state, programService } = await fixture();
  try {
    const expected = versionExpected(database);
    const [first, second] = await Promise.all([
      programService.prepareFitnessProgramVersionSchedule({ draft: planDraft, anchorAt }, expected),
      programService.prepareFitnessProgramVersionSchedule({ draft: planDraft, anchorAt }, expected),
    ]);
    assert.notEqual(first.after.program.id, second.after.program.id);
    assert.equal((await programService.commitFitnessProgramWrite(first)).outcome, "saved");
    const batches = state.batchCalls;
    assert.equal((await programService.commitFitnessProgramWrite(second)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_programs WHERE status='active'"), 1);
  } finally {
    database.close();
  }
});

test("version prepare rejects no schedulable day and stale environment snapshots", async () => {
  const anchorAt = localAt(2026, 3, 2, 17, 59);
  const { database, state, programService } = await fixture();
  try {
    const restDraft = {
      ...structuredClone(planDraft),
      days: [{
        weekday: 1,
        kind: "rest",
        name: "休息",
        focus: "恢复",
        estimated_minutes: 0,
        items: [],
      }],
    };
    await assert.rejects(
      programService.prepareFitnessProgramVersionSchedule(
        { draft: restDraft, anchorAt },
        versionExpected(database, restDraft),
      ),
      (error) => error.code === "invalid_input",
    );
    const expected = versionExpected(database);
    executeRun(database, "UPDATE fitness_equipment SET notes='另一页改过',updated_at=40 WHERE id='equipment-space'");
    await assert.rejects(
      programService.prepareFitnessProgramVersionSchedule(
        { draft: planDraft, anchorAt },
        expected,
      ),
      (error) => error.code === "changed",
    );
    assert.equal(state.batchCalls, 0);
  } finally {
    database.close();
  }
});

test("lost week-schedule response settles and compatible target progress remains exact", async () => {
  const anchorAt = localAt(2026, 3, 2, 17, 59);
  const { database, state, programService } = await fixture();
  try {
    const receipt = await programService.prepareFitnessProgramWeekSchedule(
      { programId: "program-1", anchorAt },
      weekExpected(database, anchorAt),
    );
    assert.equal(receipt.after.createdEventIds.length, 1);
    state.throwAfterBatch = true;
    assert.equal((await programService.commitFitnessProgramWrite(receipt)).outcome, "saved");
    const eventId = receipt.after.createdEventIds[0];
    executeRun(database,
      "UPDATE fitness_programs SET status='archived',updated_at=5000 WHERE id='program-1'");
    executeRun(database, `UPDATE fitness_calendar_events
      SET starts_at=starts_at+86400000,status='completed',updated_at=5000 WHERE id=?`, [eventId]);
    assert.equal(await programService.inspectFitnessProgramWrite(receipt), "exact_saved");
    assert.equal((await programService.commitFitnessProgramWrite(receipt)).outcome, "already_saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_calendar_events WHERE id=?", [eventId]), 1);
  } finally {
    database.close();
  }
});

test("week schedule binds existing occurrence and never reconstructs a deleted child", async () => {
  const anchorAt = localAt(2026, 3, 2, 17, 59);
  const { database, state, programService } = await fixture();
  try {
    insertOccurrence(database, anchorAt);
    const receipt = await programService.prepareFitnessProgramWeekSchedule(
      { programId: "program-1", anchorAt },
      weekExpected(database, anchorAt),
    );
    assert.deepEqual(receipt.after.createdEventIds, []);
    assert.equal((await programService.commitFitnessProgramWrite(receipt)).outcome, "saved");
    executeRun(database, "DELETE FROM fitness_calendar_events WHERE id='existing-occurrence'");
    assert.equal(await programService.inspectFitnessProgramWrite(receipt), "changed");
    const batches = state.batchCalls;
    assert.equal((await programService.commitFitnessProgramWrite(receipt)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_calendar_events WHERE id='existing-occurrence'"), 0);
  } finally {
    database.close();
  }
});

test("week schedule rejects a different anchor or changed occurrence with zero write", async () => {
  const anchorAt = localAt(2026, 3, 2, 17, 59);
  const { database, state, programService } = await fixture();
  try {
    insertOccurrence(database, anchorAt);
    const expected = weekExpected(database, anchorAt);
    await assert.rejects(
      programService.prepareFitnessProgramWeekSchedule(
        { programId: "program-1", anchorAt: anchorAt + 1 },
        expected,
      ),
      (error) => error.code === "invalid_input",
    );
    const receipt = await programService.prepareFitnessProgramWeekSchedule(
      { programId: "program-1", anchorAt },
      expected,
    );
    executeRun(database,
      "UPDATE fitness_calendar_events SET title='另一标题',updated_at=50 WHERE id='existing-occurrence'");
    assert.equal((await programService.commitFitnessProgramWrite(receipt)).outcome, "changed");
    assert.equal(state.batchCalls, 0);
  } finally {
    database.close();
  }
});

test("local-civil 18:00 boundary and response-loss use the frozen anchor", async () => {
  const exact = localAt(2026, 3, 2, 18);
  const { database, state, programService } = await fixture();
  try {
    const exactReceipt = await programService.prepareFitnessProgramVersionSchedule(
      { draft: planDraft, anchorAt: exact },
      versionExpected(database),
    );
    const afterReceipt = await programService.prepareFitnessProgramVersionSchedule(
      { draft: planDraft, anchorAt: exact + 1 },
      versionExpected(database),
    );
    assert.equal(exactReceipt.after.events[0].starts_at, exact);
    assert.equal(afterReceipt.after.events[0].starts_at, localAt(2026, 3, 9, 18));
    const beforeReceipt = await programService.prepareFitnessProgramVersionSchedule(
      { draft: planDraft, anchorAt: exact - 60_000 },
      versionExpected(database),
    );
    state.now = exact + 60_000;
    state.throwAfterBatch = true;
    assert.equal((await programService.commitFitnessProgramWrite(beforeReceipt)).outcome, "saved");
    assert.equal(database.selectValue(
      "SELECT starts_at FROM fitness_calendar_events WHERE id=?",
      [beforeReceipt.after.events[0].id],
    ), exact);
  } finally {
    database.close();
  }
});

test("local-civil scheduling stays at 18:00 across spring and fall DST", async () => {
  const priorTimezone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    for (const anchorAt of [localAt(2026, 3, 7, 12), localAt(2026, 10, 31, 12)]) {
      const { database, programService } = await fixture({ weekday: 0 });
      try {
        const draft = structuredClone(planDraft);
        draft.days[0].weekday = 0;
        const receipt = await programService.prepareFitnessProgramVersionSchedule(
          { draft, anchorAt },
          versionExpected(database, draft),
        );
        const target = new Date(receipt.after.events[0].starts_at);
        assert.equal(target.getDay(), 0);
        assert.equal(target.getHours(), 18);
        assert.equal(target.getMinutes(), 0);
      } finally {
        database.close();
      }
    }
  } finally {
    if (priorTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = priorTimezone;
  }
});

test("program receipts keep their Singapore civil slots after the OS moves to New York", async () => {
  const priorTimezone = process.env.TZ;
  const openedDatabases = [];
  try {
    process.env.TZ = "Asia/Singapore";
    const anchorAt = localAt(2026, 3, 2, 17, 59);
    const versionFixture = await fixture();
    openedDatabases.push(versionFixture.database);
    const versionReceipt = await versionFixture.programService
      .prepareFitnessProgramVersionSchedule(
        { draft: planDraft, anchorAt },
        versionExpected(versionFixture.database),
      );
    const frozenVersionStart = versionReceipt.after.events[0].starts_at;
    assert.equal(versionReceipt.request.scheduleTimeZone, "Asia/Singapore");
    assert.equal(frozenVersionStart, localAt(2026, 3, 2, 18));

    process.env.TZ = "America/New_York";
    assert.equal(store.isFitnessProgramWriteReceipt(versionReceipt), true);
    versionFixture.state.throwAfterBatch = true;
    assert.equal(
      (await versionFixture.programService.commitFitnessProgramWrite(versionReceipt)).outcome,
      "saved",
    );
    assert.equal(versionFixture.database.selectValue(
      "SELECT starts_at FROM fitness_calendar_events WHERE id=?",
      [versionReceipt.after.events[0].id],
    ), frozenVersionStart);
    assert.equal(
      await versionFixture.programService.inspectFitnessProgramWrite(versionReceipt),
      "exact_saved",
    );
    const versionBatches = versionFixture.state.batchCalls;
    assert.equal(
      (await versionFixture.programService.commitFitnessProgramWrite(versionReceipt)).outcome,
      "already_saved",
    );
    assert.equal(versionFixture.state.batchCalls, versionBatches);

    process.env.TZ = "Asia/Singapore";
    const weekFixture = await fixture();
    openedDatabases.push(weekFixture.database);
    const weekReceipt = await weekFixture.programService.prepareFitnessProgramWeekSchedule(
      { programId: "program-1", anchorAt },
      weekExpected(weekFixture.database, anchorAt),
    );
    const frozenWeekStart = weekReceipt.after.events[0].starts_at;
    assert.equal(weekReceipt.request.scheduleTimeZone, "Asia/Singapore");

    process.env.TZ = "America/New_York";
    assert.equal(store.isFitnessProgramWriteReceipt(weekReceipt), true);
    weekFixture.state.throwAfterBatch = true;
    assert.equal(
      (await weekFixture.programService.commitFitnessProgramWrite(weekReceipt)).outcome,
      "saved",
    );
    assert.equal(weekFixture.database.selectValue(
      "SELECT starts_at FROM fitness_calendar_events WHERE id=?",
      [weekReceipt.after.events[0].id],
    ), frozenWeekStart);
    assert.equal(
      await weekFixture.programService.inspectFitnessProgramWrite(weekReceipt),
      "exact_saved",
    );
    const weekBatches = weekFixture.state.batchCalls;
    assert.equal(
      (await weekFixture.programService.commitFitnessProgramWrite(weekReceipt)).outcome,
      "already_saved",
    );
    assert.equal(weekFixture.state.batchCalls, weekBatches);
  } finally {
    for (const database of openedDatabases) database.close();
    if (priorTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = priorTimezone;
  }
});

test("a recomputed hash cannot authorize a forged zoned start or occurrence key", async () => {
  const priorTimezone = process.env.TZ;
  process.env.TZ = "Asia/Singapore";
  const versionFixture = await fixture();
  const weekFixture = await fixture();
  try {
    const anchorAt = localAt(2026, 3, 2, 17, 59);
    const versionReceipt = await versionFixture.programService
      .prepareFitnessProgramVersionSchedule(
        { draft: planDraft, anchorAt },
        versionExpected(versionFixture.database),
      );
    const forgedStart = await resignReceipt({
      ...versionReceipt,
      after: {
        ...versionReceipt.after,
        events: [{
          ...versionReceipt.after.events[0],
          starts_at: versionReceipt.after.events[0].starts_at + 60_000,
        }],
      },
    });
    assert.equal(store.isFitnessProgramWriteReceipt(forgedStart), false);
    await assert.rejects(
      versionFixture.programService.commitFitnessProgramWrite(forgedStart),
      (error) => error.code === "invalid_receipt",
    );
    assert.equal(versionFixture.state.batchCalls, 0);

    const weekReceipt = await weekFixture.programService.prepareFitnessProgramWeekSchedule(
      { programId: "program-1", anchorAt },
      weekExpected(weekFixture.database, anchorAt),
    );
    const forgedKey = await resignReceipt({
      ...weekReceipt,
      after: {
        ...weekReceipt.after,
        events: [{
          ...weekReceipt.after.events[0],
          occurrence_key: "2099-01-01",
        }],
      },
    });
    assert.equal(store.isFitnessProgramWriteReceipt(forgedKey), false);
    await assert.rejects(
      weekFixture.programService.commitFitnessProgramWrite(forgedKey),
      (error) => error.code === "invalid_receipt",
    );
    assert.equal(weekFixture.state.batchCalls, 0);
  } finally {
    versionFixture.database.close();
    weekFixture.database.close();
    if (priorTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = priorTimezone;
  }
});

test("program target-forward rejects impossible event state and same-clock ABA", async () => {
  const anchorAt = localAt(2026, 3, 2, 17, 59);
  const versionFixture = await fixture();
  try {
    const receipt = await versionFixture.programService.prepareFitnessProgramVersionSchedule(
      { draft: planDraft, anchorAt },
      versionExpected(versionFixture.database),
    );
    assert.equal(
      (await versionFixture.programService.commitFitnessProgramWrite(receipt)).outcome,
      "saved",
    );
    executeRun(versionFixture.database, `UPDATE fitness_calendar_events
      SET status='planned',note='impossible forward note',updated_at=5000 WHERE id=?`,
    [receipt.after.events[0].id]);
    assert.equal(
      await versionFixture.programService.inspectFitnessProgramWrite(receipt),
      "changed",
    );
    const batches = versionFixture.state.batchCalls;
    assert.equal(
      (await versionFixture.programService.commitFitnessProgramWrite(receipt)).outcome,
      "changed",
    );
    assert.equal(versionFixture.state.batchCalls, batches);
  } finally {
    versionFixture.database.close();
  }

  const weekFixture = await fixture();
  try {
    const receipt = await weekFixture.programService.prepareFitnessProgramWeekSchedule(
      { programId: "program-1", anchorAt },
      weekExpected(weekFixture.database, anchorAt),
    );
    assert.equal(
      (await weekFixture.programService.commitFitnessProgramWrite(receipt)).outcome,
      "saved",
    );
    const target = receipt.after.events[0];
    executeRun(weekFixture.database, "DELETE FROM fitness_calendar_events WHERE id=?", [target.id]);
    executeRun(weekFixture.database, `INSERT INTO fitness_calendar_events(
      id,program_day_id,venue_id,title,kind,starts_at,occurrence_key,planned_minutes,
      status,rescheduled_from_id,note,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      target.id,
      target.program_day_id,
      target.venue_id,
      "ABA title",
      target.kind,
      target.starts_at,
      target.occurrence_key,
      target.planned_minutes,
      target.status,
      target.rescheduled_from_id,
      target.note,
      target.created_at,
      5000,
    ]);
    assert.equal(
      await weekFixture.programService.inspectFitnessProgramWrite(receipt),
      "changed",
    );
    const batches = weekFixture.state.batchCalls;
    assert.equal(
      (await weekFixture.programService.commitFitnessProgramWrite(receipt)).outcome,
      "changed",
    );
    assert.equal(weekFixture.state.batchCalls, batches);
  } finally {
    weekFixture.database.close();
  }
});

test("lost calendar reschedule response settles exact and retry cannot duplicate", async () => {
  const { database, state, calendarService } = await fixture();
  try {
    const receipt = await calendarService.prepareFitnessCalendarReschedule(
      { eventId: "calendar-1", startsAt: 6000 },
      calendarExpected(database),
    );
    assert.equal(state.batchCalls, 0);
    state.throwAfterBatch = true;
    assert.equal((await calendarService.commitFitnessCalendarWrite(receipt)).outcome, "saved");
    assert.equal(database.selectValue("SELECT starts_at FROM fitness_calendar_events WHERE id='calendar-1'"), 6000);
    assert.equal(await calendarService.inspectFitnessCalendarWrite(receipt), "exact_saved");
    assert.equal((await calendarService.commitFitnessCalendarWrite(receipt)).outcome, "already_saved");
    assert.equal(store.isFitnessCalendarWriteReceipt(receipt), true);
    assert.equal(store.isFitnessProgramWriteReceipt(receipt), false);
  } finally {
    database.close();
  }
});

test("two calendar tickets from one view use strict full-row CAS", async () => {
  const { database, state, calendarService } = await fixture();
  try {
    const expected = calendarExpected(database);
    const [first, second] = await Promise.all([
      calendarService.prepareFitnessCalendarReschedule(
        { eventId: "calendar-1", startsAt: 6000 }, expected),
      calendarService.prepareFitnessCalendarReschedule(
        { eventId: "calendar-1", startsAt: 7000 }, expected),
    ]);
    assert.equal((await calendarService.commitFitnessCalendarWrite(first)).outcome, "saved");
    const batches = state.batchCalls;
    assert.equal((await calendarService.commitFitnessCalendarWrite(second)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT starts_at FROM fitness_calendar_events WHERE id='calendar-1'"), 6000);
  } finally {
    database.close();
  }
});

test("not-performed canonicalizes note, survives response loss, and is value-strict", async () => {
  const { database, state, calendarService } = await fixture();
  try {
    const expected = calendarExpected(database);
    const first = await calendarService.prepareFitnessCalendarNotPerformed(
      { eventId: "calendar-1", note: "  今天恢复  " }, expected);
    const other = await calendarService.prepareFitnessCalendarNotPerformed(
      { eventId: "calendar-1", note: "另一说明" }, expected);
    assert.equal(first.after.note, "今天恢复");
    state.throwAfterBatch = true;
    assert.equal((await calendarService.commitFitnessCalendarWrite(first)).outcome, "saved");
    assert.equal(await calendarService.inspectFitnessCalendarWrite(first), "exact_saved");
    assert.equal(await calendarService.inspectFitnessCalendarWrite(other), "changed");
    const batches = state.batchCalls;
    assert.equal((await calendarService.commitFitnessCalendarWrite(other)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
  } finally {
    database.close();
  }
});

test("calendar transaction rollback leaves the full planned event unchanged", async () => {
  const { database, state, calendarService } = await fixture();
  try {
    const before = calendarExpected(database);
    const receipt = await calendarService.prepareFitnessCalendarNotPerformed(
      { eventId: "calendar-1", note: "未进行" },
      before,
    );
    state.failAtStatement = 1;
    await assert.rejects(
      calendarService.commitFitnessCalendarWrite(receipt),
      (error) => error.code === "write_failed",
    );
    assert.deepEqual(calendarExpected(database), before);
  } finally {
    database.close();
  }
});

test("generation ABA blocks program and calendar receipts without a commit batch", async () => {
  const anchorAt = localAt(2026, 3, 2, 17, 59);
  const { database, state, programService, calendarService } = await fixture();
  try {
    const programReceipt = await programService.prepareFitnessProgramWeekSchedule(
      { programId: "program-1", anchorAt }, weekExpected(database, anchorAt));
    const calendarReceipt = await calendarService.prepareFitnessCalendarReschedule(
      { eventId: "calendar-1", startsAt: 6000 }, calendarExpected(database));
    state.generation = { generationId: deterministicUuid(99), sequence: 1 };
    assert.equal((await programService.commitFitnessProgramWrite(programReceipt)).outcome, "changed");
    assert.equal((await calendarService.commitFitnessCalendarWrite(calendarReceipt)).outcome, "changed");
    assert.equal(state.batchCalls, 0);
  } finally {
    database.close();
  }
});

test("commit snapshots a mutable receipt before the first hash await", async () => {
  const { database, calendarService } = await fixture();
  try {
    const receipt = await calendarService.prepareFitnessCalendarReschedule(
      { eventId: "calendar-1", startsAt: 6000 }, calendarExpected(database));
    const savedReceipt = structuredClone(receipt);
    const pending = calendarService.commitFitnessCalendarWrite(receipt);
    receipt.after.starts_at = 9000;
    receipt.before.title = "被改写";
    const result = await pending;
    assert.equal(result.outcome, "saved");
    assert.deepEqual(result.receipt, savedReceipt);
    assert.equal(database.selectValue("SELECT starts_at FROM fitness_calendar_events WHERE id='calendar-1'"), 6000);
  } finally {
    database.close();
  }
});

test("settle loss reports uncertain, later inspect proves exact, and broadcast loss is harmless", async () => {
  const anchorAt = localAt(2026, 3, 2, 17, 59);
  const { database, state, programService } = await fixture();
  try {
    const receipt = await programService.prepareFitnessProgramWeekSchedule(
      { programId: "program-1", anchorAt }, weekExpected(database, anchorAt));
    state.throwAfterBatch = true;
    state.failQueryAfterBatch = true;
    assert.equal((await programService.commitFitnessProgramWrite(receipt)).outcome, "outcome_uncertain");
    assert.equal(await programService.inspectFitnessProgramWrite(receipt), "exact_saved");
    state.broadcastThrows = true;
    assert.equal((await programService.commitFitnessProgramWrite(receipt)).outcome, "already_saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_calendar_events WHERE program_day_id='day-1'"), 1);
  } finally {
    database.close();
  }
});

test("receipt guards reject tampering, oversized notes, NaN, and unsupported kinds", async () => {
  const anchorAt = localAt(2026, 3, 2, 17, 59);
  const { database, state, programService, calendarService } = await fixture();
  try {
    await assert.rejects(
      calendarService.prepareFitnessCalendarNotPerformed(
        { eventId: "calendar-1", note: "大".repeat(4001) }, calendarExpected(database)),
      (error) => error.code === "invalid_input",
    );
    await assert.rejects(
      calendarService.prepareFitnessCalendarReschedule(
        { eventId: "calendar-1", startsAt: Number.NaN }, calendarExpected(database)),
      (error) => error.code === "invalid_input",
    );
    const receipt = await programService.prepareFitnessProgramWeekSchedule(
      { programId: "program-1", anchorAt }, weekExpected(database, anchorAt));
    assert.equal(store.isFitnessProgramWriteReceipt({ ...receipt, kind: "unsupported" }), false);
    assert.equal(store.isFitnessProgramWriteReceipt({
      ...receipt,
      before: { ...receipt.before, venue: { ...receipt.before.venue, name: "大".repeat(1_000_001) } },
    }), false);
    assert.equal(state.batchCalls, 0);
  } finally {
    database.close();
  }
});

test("default program and calendar services require the exclusive Web Lock lease", () => {
  assert.match(storeTypeScript, /createFitnessProgramStorageService[\s\S]*?withFitnessWriteLock\(operation, \{ requireSupport: true \}\)/);
  assert.match(storeTypeScript, /createFitnessCalendarStorageService[\s\S]*?withFitnessWriteLock\(operation, \{ requireSupport: true \}\)/);
  assert.doesNotMatch(storeTypeScript, /purpose: "fitness-(?:program|calendar)-write"[\s\S]{0,200}localStorage/);
});
