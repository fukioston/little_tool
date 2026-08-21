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
      query() { throw new Error("default localDb must not be used in live service tests"); },
      batch() { throw new Error("default localDb must not be used in live service tests"); },
      init() { throw new Error("default localDb must not be used in live service tests"); }
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

async function fixture({ now = 1_000, event = true } = {}) {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  installSchema(database);
  const state = {
    now,
    generation: { generationId: "legacy", sequence: 0 },
    uuid: 1,
    lockCalls: 0,
    batchCalls: 0,
    queryCalls: 0,
    broadcasts: [],
    broadcastThrows: false,
    throwBeforeBatch: false,
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
      if (state.throwBeforeBatch) {
        state.throwBeforeBatch = false;
        throw new Error("injected before transaction");
      }
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
  if (event) executeRun(database, `INSERT INTO fitness_calendar_events(
    id,program_day_id,venue_id,title,kind,starts_at,occurrence_key,planned_minutes,
    status,rescheduled_from_id,note,created_at,updated_at
  ) VALUES('event-1',NULL,'venue-1','今天训练','resistance',100,NULL,60,
    'in_progress',NULL,'',10,20)`);
  executeRun(database, `INSERT INTO fitness_sessions(
    id,event_id,venue_id,program_day_id,started_at,ended_at,status,available_minutes,
    energy_note,soreness_note,reflection,created_at,updated_at
  ) VALUES('session-1',?,'venue-1',NULL,100,NULL,'active',60,'usual','','',100,100)`,
  [event ? "event-1" : null]);
  executeRun(database, `INSERT INTO fitness_session_exercises(
    id,session_id,exercise_id,equipment_id,planned_item_id,order_index,status,
    substituted_for_exercise_id,substitution_reason,equipment_snapshot,note,
    created_at,updated_at
  ) VALUES('exercise-1','session-1','bodyweight-squat',NULL,NULL,0,'active',
    NULL,'','[]','',100,100)`);
  return {
    database,
    state,
    runtime,
    service: store.createFitnessLiveStorageService(runtime),
  };
}

function setRow(database, {
  id = "set-existing",
  index = 0,
  mutation = `mutation-${id}`,
  reps = 8,
  load = 20_000,
  pain = "",
  at = 110,
} = {}) {
  executeRun(database, `INSERT INTO fitness_sets(
    id,session_exercise_id,set_index,set_kind,load_grams,reps,duration_seconds,
    rir,rpe,completed,pain_note,completed_at,client_mutation_id,created_at,updated_at
  ) VALUES(?,'exercise-1',?,'work',?,?,NULL,2,8,1,?,?,?,?,?)`,
  [id, index, load, reps, pain, at, mutation, at, at]);
}

function publicSet(row) {
  return {
    id: String(row.id),
    session_exercise_id: String(row.session_exercise_id),
    set_index: Number(row.set_index),
    set_kind: String(row.set_kind),
    load_grams: row.load_grams === null ? null : Number(row.load_grams),
    reps: row.reps === null ? null : Number(row.reps),
    duration_seconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    rir: row.rir === null ? null : Number(row.rir),
    rpe: row.rpe === null ? null : Number(row.rpe),
    completed: Number(row.completed) === 1,
    pain_note: String(row.pain_note),
    completed_at: row.completed_at === null ? null : Number(row.completed_at),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function exerciseExpectation(database) {
  const exercise = database.selectObject(
    "SELECT * FROM fitness_session_exercises WHERE id='exercise-1'",
  );
  const session = database.selectObject(
    "SELECT * FROM fitness_sessions WHERE id='session-1'",
  );
  const sets = database.selectObjects(
    "SELECT * FROM fitness_sets WHERE session_exercise_id='exercise-1' ORDER BY set_index,id",
  ).map(publicSet);
  return {
    session,
    exercise,
    sets,
    nextSetIndex: sets.reduce((maximum, set) => Math.max(maximum, set.set_index + 1), 0),
  };
}

function sessionExpectation(database) {
  const session = database.selectObject("SELECT * FROM fitness_sessions WHERE id='session-1'");
  const exercises = database.selectObjects(
    "SELECT * FROM fitness_session_exercises WHERE session_id='session-1' ORDER BY order_index,id",
  );
  const sets = database.selectObjects(`SELECT recorded_set.* FROM fitness_sets recorded_set
    JOIN fitness_session_exercises exercise ON exercise.id=recorded_set.session_exercise_id
    WHERE exercise.session_id='session-1' ORDER BY recorded_set.set_index,recorded_set.id`).map(publicSet);
  const cardioEntries = database.selectObjects(
    "SELECT * FROM fitness_cardio_entries WHERE session_id='session-1' ORDER BY created_at,id",
  );
  const event = session?.event_id
    ? database.selectObject("SELECT * FROM fitness_calendar_events WHERE id=?", [session.event_id])
    : null;
  const capabilities = database.selectObjects(`SELECT capability.*
    FROM fitness_capabilities capability
    JOIN fitness_sets recorded_set ON recorded_set.id=capability.source_set_id
    JOIN fitness_session_exercises exercise ON exercise.id=recorded_set.session_exercise_id
    WHERE exercise.session_id='session-1' ORDER BY capability.recorded_at,capability.id`);
  return { session, exercises, sets, cardioEntries, event, capabilities };
}

const validSetInput = {
  sessionExerciseId: "exercise-1",
  setIndex: 0,
  setKind: "work",
  loadGrams: 20_000,
  reps: 8,
  durationSeconds: null,
  rir: 2,
  rpe: 8,
  painNote: "",
};

test("record prepare is zero-write, binds MAX+1, and owns stable IDs", async () => {
  const { database, state, service } = await fixture({ now: 1_000 });
  try {
    setRow(database, { id: "set-zero", index: 0, mutation: "mutation-zero" });
    setRow(database, { id: "set-gap", index: 2 });
    const expected = exerciseExpectation(database);
    assert.equal(expected.nextSetIndex, 3);
    const receipt = await service.prepareFitnessSetRecord(
      { ...validSetInput, setIndex: 3 },
      expected,
    );
    assert.equal(state.batchCalls, 0);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets"), 2);
    assert.match(receipt.operationId, /^fitness-live-operation-/);
    const added = receipt.after.sets.find(({ set_index }) => set_index === 3);
    assert.match(added.id, /^set-/);
    assert.match(added.client_mutation_id, /^fitness-live-mutation-/);
    assert.equal(added.set_index, 3);
    assert.equal(store.isFitnessLiveWriteReceipt(JSON.parse(JSON.stringify(receipt))), true);
    await assert.rejects(
      service.prepareFitnessSetRecord({ ...validSetInput, setIndex: 1 }, expected),
      (error) => error.code === "invalid_input",
    );
  } finally {
    database.close();
  }
});

test("record response loss settles exact and retry never duplicates", async () => {
  const { database, state, service } = await fixture();
  try {
    const receipt = await service.prepareFitnessSetRecord(validSetInput, exerciseExpectation(database));
    state.throwAfterBatch = true;
    const result = await service.commitFitnessLiveWrite(receipt);
    assert.equal(result.outcome, "saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets"), 1);
    assert.equal(await service.inspectFitnessLiveWrite(receipt), "exact_saved");
    assert.equal((await service.commitFitnessLiveWrite(receipt)).outcome, "already_saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets"), 1);
  } finally {
    database.close();
  }
});

test("an exact recorded target stays provable after later set and finish progress", async () => {
  const { database, state, service } = await fixture();
  try {
    const first = await service.prepareFitnessSetRecord(validSetInput, exerciseExpectation(database));
    state.throwAfterBatch = true;
    assert.equal((await service.commitFitnessLiveWrite(first)).outcome, "saved");
    state.now = 2_000;
    const second = await service.prepareFitnessSetRecord(
      { ...validSetInput, setIndex: 1, reps: 9 },
      exerciseExpectation(database),
    );
    assert.equal((await service.commitFitnessLiveWrite(second)).outcome, "saved");
    const finish = await service.prepareFitnessSessionFinish(
      "session-1", {}, sessionExpectation(database),
    );
    assert.equal((await service.commitFitnessLiveWrite(finish)).outcome, "saved");
    assert.equal(await service.inspectFitnessLiveWrite(first), "exact_saved");
    assert.equal((await service.commitFitnessLiveWrite(first)).outcome, "already_saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets"), 2);
  } finally {
    database.close();
  }
});

test("two tabs prepared from one view permit only one record", async () => {
  const { database, state, service } = await fixture();
  try {
    const expected = exerciseExpectation(database);
    const [first, second] = await Promise.all([
      service.prepareFitnessSetRecord(validSetInput, expected),
      service.prepareFitnessSetRecord(validSetInput, expected),
    ]);
    assert.equal((await service.commitFitnessLiveWrite(first)).outcome, "saved");
    const batches = state.batchCalls;
    assert.equal((await service.commitFitnessLiveWrite(second)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets"), 1);
  } finally {
    database.close();
  }
});

test("generation replacement makes an old record receipt changed", async () => {
  const { database, state, service } = await fixture();
  try {
    const receipt = await service.prepareFitnessSetRecord(validSetInput, exerciseExpectation(database));
    state.generation = { generationId: deterministicUuid(99), sequence: 1 };
    assert.equal(await service.inspectFitnessLiveWrite(receipt), "changed");
    assert.equal((await service.commitFitnessLiveWrite(receipt)).outcome, "changed");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets"), 0);
  } finally {
    database.close();
  }
});

test("mid-transaction record failure rolls back every row", async () => {
  const { database, state, service } = await fixture();
  try {
    const receipt = await service.prepareFitnessSetRecord(validSetInput, exerciseExpectation(database));
    state.failAtStatement = 2;
    await assert.rejects(
      service.commitFitnessLiveWrite(receipt),
      (error) => error.code === "write_failed",
    );
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets"), 0);
    assert.equal(database.selectValue("SELECT updated_at FROM fitness_sessions WHERE id='session-1'"), 100);
    assert.equal(await service.inspectFitnessLiveWrite(receipt), "expected");
  } finally {
    database.close();
  }
});

test("undo response loss settles exact and retry stays idempotent", async () => {
  const { database, state, service } = await fixture();
  try {
    setRow(database);
    const receipt = await service.prepareFitnessSetUndo("set-existing", exerciseExpectation(database));
    assert.equal(state.batchCalls, 0);
    state.throwAfterBatch = true;
    assert.equal((await service.commitFitnessLiveWrite(receipt)).outcome, "saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets"), 0);
    assert.equal((await service.commitFitnessLiveWrite(receipt)).outcome, "already_saved");
  } finally {
    database.close();
  }
});

test("an exact undo stays provable after later set progress", async () => {
  const { database, state, service } = await fixture();
  try {
    setRow(database);
    const undo = await service.prepareFitnessSetUndo("set-existing", exerciseExpectation(database));
    state.throwAfterBatch = true;
    assert.equal((await service.commitFitnessLiveWrite(undo)).outcome, "saved");
    state.now = 2_000;
    const next = await service.prepareFitnessSetRecord(validSetInput, exerciseExpectation(database));
    assert.equal((await service.commitFitnessLiveWrite(next)).outcome, "saved");
    assert.equal(await service.inspectFitnessLiveWrite(undo), "exact_saved");
    assert.equal((await service.commitFitnessLiveWrite(undo)).outcome, "already_saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets"), 1);
  } finally {
    database.close();
  }
});

test("an old undo receipt cannot delete a changed or newly added fact", async () => {
  const { database, state, service } = await fixture();
  try {
    setRow(database);
    const receipt = await service.prepareFitnessSetUndo("set-existing", exerciseExpectation(database));
    setRow(database, { id: "set-later", index: 1, mutation: "mutation-later", at: 120 });
    const batches = state.batchCalls;
    assert.equal((await service.commitFitnessLiveWrite(receipt)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets"), 2);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets WHERE id='set-existing'"), 1);
  } finally {
    database.close();
  }
});

test("finish response loss settles full session, event, exercises, and stable capability", async () => {
  const { database, state, service } = await fixture({ now: 1_000 });
  try {
    setRow(database);
    const receipt = await service.prepareFitnessSessionFinish(
      "session-1",
      { reflection: "  今天状态稳定  " },
      sessionExpectation(database),
    );
    assert.equal(state.batchCalls, 0);
    const capability = receipt.after.capabilities[0];
    assert.match(capability.id, /^[0-9a-f-]{36}$/);
    state.throwAfterBatch = true;
    assert.equal((await service.commitFitnessLiveWrite(receipt)).outcome, "saved");
    assert.equal(database.selectValue("SELECT status FROM fitness_sessions WHERE id='session-1'"), "completed");
    assert.equal(database.selectValue("SELECT reflection FROM fitness_sessions WHERE id='session-1'"), "今天状态稳定");
    assert.equal(database.selectValue("SELECT status FROM fitness_calendar_events WHERE id='event-1'"), "completed");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_capabilities"), 1);
    assert.equal(database.selectValue("SELECT id FROM fitness_capabilities"), capability.id);
    assert.equal((await service.commitFitnessLiveWrite(receipt)).outcome, "already_saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_capabilities"), 1);
  } finally {
    database.close();
  }
});

test("finish without an event handles multiple statuses and duration-only work truthfully", async () => {
  const { database, service } = await fixture({ event: false });
  try {
    const duration = await service.prepareFitnessSetRecord({
      ...validSetInput,
      loadGrams: null,
      reps: null,
      durationSeconds: 60,
      rir: null,
    }, exerciseExpectation(database));
    assert.equal((await service.commitFitnessLiveWrite(duration)).outcome, "saved");
    executeRun(database, `INSERT INTO fitness_session_exercises(
      id,session_id,exercise_id,equipment_id,planned_item_id,order_index,status,
      substituted_for_exercise_id,substitution_reason,equipment_snapshot,note,
      created_at,updated_at
    ) VALUES('exercise-2','session-1','push-up',NULL,NULL,1,'pending',
      NULL,'','[]','',100,100)`);
    const receipt = await service.prepareFitnessSessionFinish(
      "session-1", { endedEarly: true }, sessionExpectation(database),
    );
    assert.equal(receipt.after.event, null);
    assert.deepEqual(receipt.after.exercises.map(({ status }) => status), [
      "completed",
      "skipped",
    ]);
    assert.equal(receipt.after.capabilities.length, 0);
    assert.equal((await service.commitFitnessLiveWrite(receipt)).outcome, "saved");
    assert.equal(database.selectValue("SELECT status FROM fitness_sessions"), "ended_early");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_capabilities"), 0);
  } finally {
    database.close();
  }
});

test("a fact added after finish prepare makes the old receipt changed with zero writes", async () => {
  const { database, state, service } = await fixture();
  try {
    setRow(database);
    const receipt = await service.prepareFitnessSessionFinish(
      "session-1", {}, sessionExpectation(database),
    );
    setRow(database, { id: "set-later", index: 1, mutation: "mutation-later", at: 120 });
    const batches = state.batchCalls;
    assert.equal((await service.commitFitnessLiveWrite(receipt)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT status FROM fitness_sessions WHERE id='session-1'"), "active");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_capabilities"), 0);
  } finally {
    database.close();
  }
});

test("later facts prevent an old finished receipt from inspecting exact", async () => {
  const { database, service } = await fixture();
  try {
    setRow(database);
    const receipt = await service.prepareFitnessSessionFinish(
      "session-1", {}, sessionExpectation(database),
    );
    assert.equal((await service.commitFitnessLiveWrite(receipt)).outcome, "saved");
    executeRun(database, `INSERT INTO fitness_cardio_entries(
      id,session_id,equipment_id,mode,duration_seconds,distance_meters,resistance,
      average_heart_rate,effort,note,created_at
    ) VALUES('cardio-later','session-1',NULL,'walk',60,NULL,'',NULL,'easy','',2000)`);
    assert.equal(await service.inspectFitnessLiveWrite(receipt), "changed");
  } finally {
    database.close();
  }
});

test("response loss plus failed settle is uncertain until inspect proves exact", async () => {
  const { database, state, service } = await fixture();
  try {
    const receipt = await service.prepareFitnessSetRecord(validSetInput, exerciseExpectation(database));
    state.throwAfterBatch = true;
    state.failQueryAfterBatch = true;
    assert.equal((await service.commitFitnessLiveWrite(receipt)).outcome, "outcome_uncertain");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets"), 1);
    assert.equal(await service.inspectFitnessLiveWrite(receipt), "exact_saved");
  } finally {
    database.close();
  }
});

test("empty-session cancel response loss restores exact event and is retry-safe", async () => {
  const { database, state, service } = await fixture();
  try {
    const receipt = await service.prepareFitnessEmptySessionCancel(
      "session-1", sessionExpectation(database),
    );
    assert.equal(state.batchCalls, 0);
    state.throwAfterBatch = true;
    assert.equal((await service.commitFitnessLiveWrite(receipt)).outcome, "saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sessions"), 0);
    assert.equal(database.selectValue("SELECT status FROM fitness_calendar_events WHERE id='event-1'"), "planned");
    assert.equal(await service.inspectFitnessLiveWrite(receipt), "exact_saved");
    assert.equal((await service.commitFitnessLiveWrite(receipt)).outcome, "already_saved");
  } finally {
    database.close();
  }
});

test("a new set after cancel prepare makes the old receipt changed and preserves session", async () => {
  const { database, state, service } = await fixture();
  try {
    const receipt = await service.prepareFitnessEmptySessionCancel(
      "session-1", sessionExpectation(database),
    );
    setRow(database);
    const batches = state.batchCalls;
    assert.equal((await service.commitFitnessLiveWrite(receipt)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sessions"), 1);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets"), 1);
  } finally {
    database.close();
  }
});

test("cancel prepare rejects a viewed session that already contains facts", async () => {
  const { database, state, service } = await fixture();
  try {
    setRow(database);
    await assert.rejects(
      service.prepareFitnessEmptySessionCancel("session-1", sessionExpectation(database)),
      (error) => error.code === "changed",
    );
    assert.equal(state.batchCalls, 0);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sessions"), 1);
  } finally {
    database.close();
  }
});

test("invalid kind, NaN, oversized pain, and oversized reflection are zero-write", async () => {
  const { database, state, service } = await fixture();
  try {
    const expected = exerciseExpectation(database);
    for (const input of [
      { ...validSetInput, setKind: "mystery" },
      { ...validSetInput, reps: Number.NaN },
      { ...validSetInput, painNote: "痛".repeat(10_001) },
    ]) {
      await assert.rejects(
        service.prepareFitnessSetRecord(input, expected),
        (error) => error.code === "invalid_input",
      );
    }
    await assert.rejects(
      service.prepareFitnessSessionFinish(
        "session-1",
        { reflection: "长".repeat(20_001) },
        sessionExpectation(database),
      ),
      (error) => error.code === "invalid_input",
    );
    assert.equal(state.batchCalls, 0);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets"), 0);
  } finally {
    database.close();
  }
});

test("rollback clocks advance beyond every bound fact and exercise version", async () => {
  const { database, state, service } = await fixture({ now: 1 });
  try {
    setRow(database, { at: 5_000 });
    executeRun(database, `INSERT INTO fitness_cardio_entries(
      id,session_id,equipment_id,mode,duration_seconds,distance_meters,resistance,
      average_heart_rate,effort,note,created_at
    ) VALUES('cardio-1','session-1',NULL,'walk',60,NULL,'',NULL,'easy','',6000)`);
    const finish = await service.prepareFitnessSessionFinish(
      "session-1", {}, sessionExpectation(database),
    );
    assert.equal(finish.preparedAt, 6_001);

    executeRun(database, "DELETE FROM fitness_cardio_entries WHERE id='cardio-1'");
    executeRun(database, "DELETE FROM fitness_sets WHERE id='set-existing'");
    executeRun(database,
      "UPDATE fitness_session_exercises SET updated_at=7000 WHERE id='exercise-1'");
    const cancel = await service.prepareFitnessEmptySessionCancel(
      "session-1", sessionExpectation(database),
    );
    assert.equal(cancel.preparedAt, 7_001);
    assert.equal(state.batchCalls, 0);
  } finally {
    database.close();
  }
});

test("commit snapshots a mutable receipt before crypto or lock awaits", async () => {
  const { database, service } = await fixture();
  try {
    const original = await service.prepareFitnessSetRecord(validSetInput, exerciseExpectation(database));
    const inspectReceipt = JSON.parse(JSON.stringify(original));
    const inspect = service.inspectFitnessLiveWrite(inspectReceipt);
    inspectReceipt.before.session.updated_at += 500;
    assert.equal(await inspect, "expected");

    const receipt = JSON.parse(JSON.stringify(
      original,
    ));
    const target = receipt.after.sets.at(-1);
    const commit = service.commitFitnessLiveWrite(receipt);
    target.reps = 999;
    receipt.after.session.updated_at += 500;
    const result = await commit;
    assert.equal(result.outcome, "saved");
    assert.equal(database.selectValue("SELECT reps FROM fitness_sets"), 8);
    assert.equal(result.receipt.after.sets.at(-1).reps, 8);
  } finally {
    database.close();
  }
});

test("stale record expected is rejected during zero-write prepare", async () => {
  const { database, state, service } = await fixture();
  try {
    const stale = exerciseExpectation(database);
    setRow(database);
    await assert.rejects(
      service.prepareFitnessSetRecord(validSetInput, stale),
      (error) => error.code === "changed",
    );
    assert.equal(state.batchCalls, 0);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets"), 1);
  } finally {
    database.close();
  }
});

test("tampered receipts, query loss, and broadcast loss fail safely", async () => {
  const { database, state, service } = await fixture();
  try {
    const receipt = await service.prepareFitnessSetRecord(validSetInput, exerciseExpectation(database));
    assert.equal(await service.inspectFitnessLiveWrite({ ...receipt, extra: true }), "invalid_receipt");
    await assert.rejects(
      service.commitFitnessLiveWrite({ ...receipt, preparedAt: receipt.preparedAt + 1 }),
      (error) => error.code === "invalid_receipt",
    );
    state.failQueries = 1;
    assert.equal(await service.inspectFitnessLiveWrite(receipt), "still_unknown");
    state.broadcastThrows = true;
    assert.equal((await service.commitFitnessLiveWrite(receipt)).outcome, "saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_sets"), 1);
  } finally {
    database.close();
  }
});

test("default live runtime requires the cross-tab Web Lock", () => {
  assert.match(
    storeTypeScript,
    /createFitnessLiveStorageService\([\s\S]{0,600}withFitnessWriteLock\(operation, \{ requireSupport: true \}\)/,
  );
});
