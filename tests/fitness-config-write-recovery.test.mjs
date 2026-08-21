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

const [schemaJavaScript, catalogJavaScript, rawStoreJavaScript, lockJavaScript] =
  await Promise.all([
    transpile("lib/schemas/shilian.ts"),
    transpile("lib/fitness/catalog.ts"),
    transpile("lib/fitness/store.ts"),
    transpile("lib/fitness/lock.ts"),
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
      query() { throw new Error("default localDb must not be used in config service tests"); },
      batch() { throw new Error("default localDb must not be used in config service tests"); },
      init() { throw new Error("default localDb must not be used in config service tests"); }
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
      // Consume RETURNING/PRAGMA rows.
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

async function fixture({ now = 1_000 } = {}) {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  installSchema(database);
  const state = {
    now,
    generation: { generationId: "legacy", sequence: 0 },
    uuid: 1,
    uuidQueue: [],
    lockCalls: 0,
    queryCalls: 0,
    batchCalls: 0,
    broadcasts: [],
    broadcastThrows: false,
    throwBeforeBatch: false,
    throwAfterBatch: false,
    failQueryAfterBatch: false,
    failAtStatement: null,
    failQueries: 0,
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
        throw new Error("injected lost response after commit");
      }
      return {
        results,
        changes: results.reduce((sum, result) => sum + result.changes, 0),
      };
    },
    async currentGeneration() { return { ...state.generation }; },
    now() { return state.now; },
    randomUUID() {
      return state.uuidQueue.shift() ?? deterministicUuid(state.uuid++);
    },
    broadcast(reason) {
      state.broadcasts.push(reason);
      if (state.broadcastThrows) throw new Error("injected broadcast failure");
    },
  };
  return {
    database,
    state,
    runtime,
    service: store.createFitnessConfigStorageService(runtime),
  };
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

function equipmentInput(venueId, loads = []) {
  return {
    venue_id: venueId,
    name: "固定哑铃",
    kind: "dumbbell",
    area: "自由力量区",
    quantity: 20,
    status: "available",
    load_mode: "discrete",
    load_semantics: "per_hand",
    min_load_grams: 5_000,
    max_load_grams: 30_000,
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

const constraintInput = {
  label: "右膝深屈需留意",
  body_area: "右膝",
  severity: "modify",
  movement_patterns: ["squat"],
  exercise_ids: [],
  note: "疼痛时缩短幅度",
  active: true,
};

const defaultSettings = {
  unit: "kg",
  rest_timer_enabled: true,
  sound_enabled: false,
  ai_enabled: true,
};

const changedSettings = {
  unit: "lb",
  rest_timer_enabled: false,
  sound_enabled: true,
  ai_enabled: false,
};

const canonicalSettingKeys = [
  "unit",
  "rest_timer_enabled",
  "sound_enabled",
  "ai_enabled",
];

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
  const projection = structuredClone(receipt);
  delete projection.projectionSha256;
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

async function createVenue(service, input = venueInput) {
  const receipt = await service.prepareFitnessVenueSave(input, null);
  assert.equal((await service.commitFitnessConfigWrite(receipt)).outcome, "saved");
  return receipt.after;
}

test("prepare is zero-write and emits strict JSON-safe service-owned identity", async () => {
  const { database, state, service } = await fixture({ now: 9_000 });
  try {
    const receipt = await service.prepareFitnessVenueSave(venueInput, null);
    assert.equal(state.batchCalls, 0);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_venues"), 0);
    assert.match(receipt.operationId, /^fitness-operation-/);
    assert.match(receipt.after.id, /^venue-/);
    assert.equal(receipt.after.created_at, 9_000);
    assert.equal(receipt.after.updated_at, 9_000);
    assert.equal(store.isFitnessConfigWriteReceipt(receipt), true);
    assert.equal(
      store.isFitnessConfigWriteReceipt(JSON.parse(JSON.stringify(receipt))),
      true,
    );
    assert.equal(store.isFitnessConfigWriteReceipt({ ...receipt, extra: true }), false);
    assert.doesNotThrow(() => store.isFitnessConfigWriteReceipt(
      new Proxy({}, { ownKeys() { throw new Error("hostile value"); } }),
    ));
    assert.equal(store.isFitnessConfigWriteReceipt(
      new Proxy({}, { ownKeys() { throw new Error("hostile value"); } }),
    ), false);
    assert.equal(
      await service.inspectFitnessConfigWrite({ ...receipt, projectionSha256: "0".repeat(64) }),
      "invalid_receipt",
    );
    await assert.rejects(
      service.commitFitnessConfigWrite({ ...receipt, projectionSha256: "0".repeat(64) }),
      (error) => error instanceof store.FitnessConfigMutationError &&
        error.code === "invalid_receipt",
    );
    assert.equal(state.batchCalls, 0);
  } finally {
    database.close();
  }
});

test("lost create response settles exact, retry is idempotent, and ID collision never overwrites", async () => {
  const { database, state, service } = await fixture({ now: 10_000 });
  try {
    const receipt = await service.prepareFitnessVenueSave(venueInput, null);
    state.throwAfterBatch = true;
    assert.equal((await service.commitFitnessConfigWrite(receipt)).outcome, "saved");
    assert.equal((await service.commitFitnessConfigWrite(receipt)).outcome, "already_saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_venues"), 1);
    assert.equal(
      await service.inspectFitnessConfigWrite(receipt),
      "exact_saved",
    );

    const entityUuid = receipt.after.id.slice("venue-".length);
    state.uuidQueue.push(entityUuid, deterministicUuid(999));
    await assert.rejects(
      service.prepareFitnessVenueSave({ ...venueInput, name: "另一份内容" }, null),
      (error) => error instanceof store.FitnessConfigMutationError && error.code === "conflict",
    );
    assert.equal(
      database.selectValue("SELECT name FROM fitness_venues WHERE id=?", [receipt.after.id]),
      venueInput.name,
    );
  } finally {
    database.close();
  }
});

test("replacing an existing default venue settles exact after a lost response", async () => {
  const { database, state, service } = await fixture({ now: 15_000 });
  try {
    const first = await createVenue(service);
    state.now += 1;
    const second = await service.prepareFitnessVenueSave({
      ...venueInput,
      name: "新的默认场地",
    }, null);
    assert.deepEqual(second.defaultResets.map(({ before }) => before.id), [first.id]);
    state.throwAfterBatch = true;
    assert.equal((await service.commitFitnessConfigWrite(second)).outcome, "saved");
    assert.deepEqual(
      database.selectObjects("SELECT id,is_default FROM fitness_venues ORDER BY id")
        .map((row) => ({ ...row })),
      [
        { id: first.id, is_default: 0 },
        { id: second.after.id, is_default: 1 },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    assert.equal(await service.inspectFitnessConfigWrite(second), "exact_saved");
    assert.equal((await service.commitFitnessConfigWrite(second)).outcome, "already_saved");
  } finally {
    database.close();
  }
});

test("post-commit inspection loss stays uncertain until a later exact retry", async () => {
  const { database, state, service } = await fixture({ now: 17_000 });
  try {
    const receipt = await service.prepareFitnessVenueSave(venueInput, null);
    state.throwAfterBatch = true;
    state.failQueryAfterBatch = true;
    const uncertain = await service.commitFitnessConfigWrite(receipt);
    assert.equal(uncertain.outcome, "outcome_uncertain");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_venues"), 1);
    assert.deepEqual(state.broadcasts, []);
    assert.equal((await service.commitFitnessConfigWrite(receipt)).outcome, "already_saved");
    assert.deepEqual(state.broadcasts, ["venue-saved"]);
  } finally {
    database.close();
  }
});

test("profile CAS is monotonic under same-tick A/B edits and stale writer is changed", async () => {
  const { database, state, service } = await fixture({ now: 20_000 });
  try {
    const created = await service.prepareFitnessProfileSave(profileInput, null);
    await service.commitFitnessConfigWrite(created);
    state.now = created.after.updated_at;
    const a = await service.prepareFitnessProfileSave(
      { ...profileInput, session_minutes: 55 },
      created.after,
    );
    const b = await service.prepareFitnessProfileSave(
      { ...profileInput, session_minutes: 75 },
      created.after,
    );
    assert.equal(a.after.updated_at, created.after.updated_at + 1);
    assert.equal(b.after.updated_at, created.after.updated_at + 1);
    assert.equal((await service.commitFitnessConfigWrite(a)).outcome, "saved");
    const batches = state.batchCalls;
    assert.equal((await service.commitFitnessConfigWrite(b)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT session_minutes FROM fitness_profiles"), 55);
  } finally {
    database.close();
  }
});

test("a database-generation ABA blocks an otherwise byte-identical stale receipt", async () => {
  const { database, state, service } = await fixture({ now: 25_000 });
  try {
    const created = await service.prepareFitnessProfileSave(profileInput, null);
    await service.commitFitnessConfigWrite(created);
    const edit = await service.prepareFitnessProfileSave(
      { ...profileInput, notes: "只属于旧世代" },
      created.after,
    );
    state.generation = {
      generationId: "11111111-1111-4111-8111-111111111111",
      sequence: 1,
    };
    const batches = state.batchCalls;
    assert.equal(await service.inspectFitnessConfigWrite(edit), "changed");
    assert.equal((await service.commitFitnessConfigWrite(edit)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT notes FROM fitness_profiles"), "");
  } finally {
    database.close();
  }
});

test("venue update, archive, and restore bind full expected snapshots and affected sets", async () => {
  const { database, state, service } = await fixture({ now: 30_000 });
  try {
    const venue = await createVenue(service);
    const statusGuardBatches = state.batchCalls;
    await assert.rejects(
      service.prepareFitnessVenueSave({ ...venueInput, status: "archived" }, venue),
      (error) => error instanceof store.FitnessConfigMutationError &&
        error.code === "invalid_input",
    );
    assert.equal(state.batchCalls, statusGuardBatches);
    const a = await service.prepareFitnessVenueSave(
      { ...venueInput, name: "安静训练馆" },
      venue,
    );
    assert.equal(store.isFitnessConfigWriteReceipt({
      ...a,
      after: { ...a.after, status: "archived" },
    }), false);
    const b = await service.prepareFitnessVenueSave(
      { ...venueInput, name: "热闹训练馆" },
      venue,
    );
    await service.commitFitnessConfigWrite(a);
    assert.equal((await service.commitFitnessConfigWrite(b)).outcome, "changed");

    const current = a.after;
    executeRun(
      database,
      `INSERT INTO fitness_programs(
        id,name,venue_id,goal,split,status,version,source,assumptions_json,created_at,updated_at
      ) VALUES('program-a','计划',?,'strength','full_body','active',1,'manual','[]',1,1)`,
      [current.id],
    );
    const archive = await service.prepareFitnessVenueArchive(current);
    assert.equal(archive.programs.length, 1);
    assert.equal(store.isFitnessConfigWriteReceipt({
      ...archive,
      programs: [...archive.programs, archive.programs[0]],
    }), false);
    assert.equal(store.isFitnessConfigWriteReceipt({
      ...archive,
      programs: archive.programs.map((pair) => ({
        ...pair,
        after: { ...pair.after, status: "active" },
      })),
    }), false);
    executeRun(
      database,
      `INSERT INTO fitness_programs(
        id,name,venue_id,goal,split,status,version,source,assumptions_json,created_at,updated_at
      ) VALUES('program-race','新计划',?,'strength','full_body','draft',1,'manual','[]',2,2)`,
      [current.id],
    );
    const beforeBatch = state.batchCalls;
    assert.equal((await service.commitFitnessConfigWrite(archive)).outcome, "changed");
    assert.equal(state.batchCalls, beforeBatch);
    assert.equal(database.selectValue("SELECT status FROM fitness_venues WHERE id=?", [current.id]), "active");

    executeRun(database, "DELETE FROM fitness_programs WHERE id='program-race'");
    state.throwAfterBatch = true;
    assert.equal((await service.commitFitnessConfigWrite(archive)).outcome, "saved");
    assert.equal(database.selectValue("SELECT status FROM fitness_programs WHERE id='program-a'"), "archived");
    assert.equal(archive.after.updated_at > current.updated_at, true);

    const restore = await service.prepareFitnessVenueRestore(archive.after);
    const staleRestore = await service.prepareFitnessVenueRestore(archive.after);
    assert.equal((await service.commitFitnessConfigWrite(restore)).outcome, "saved");
    assert.equal((await service.commitFitnessConfigWrite(staleRestore)).outcome, "already_saved");
  } finally {
    database.close();
  }
});

test("archive also binds planned calendar rows and rejects an active-session race", async () => {
  const { database, state, service } = await fixture({ now: 35_000 });
  try {
    const venue = await createVenue(service);
    executeRun(
      database,
      `INSERT INTO fitness_calendar_events(
        id,program_day_id,venue_id,title,kind,starts_at,occurrence_key,planned_minutes,
        status,rescheduled_from_id,note,created_at,updated_at
      ) VALUES('event-a',NULL,?,'自由训练','note',10,NULL,45,'planned',NULL,'',1,1)`,
      [venue.id],
    );
    const receipt = await service.prepareFitnessVenueArchive(venue);
    assert.equal(receipt.events.length, 1);
    executeRun(
      database,
      `INSERT INTO fitness_sessions(
        id,event_id,venue_id,program_day_id,started_at,ended_at,status,available_minutes,
        energy_note,soreness_note,reflection,created_at,updated_at
      ) VALUES('session-race',NULL,?,NULL,10,NULL,'active',45,'usual','','',10,10)`,
      [venue.id],
    );
    const batches = state.batchCalls;
    assert.equal((await service.commitFitnessConfigWrite(receipt)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT status FROM fitness_calendar_events WHERE id='event-a'"), "planned");
  } finally {
    database.close();
  }
});

test("equipment receipt binds stable load IDs, full set, active venue, and atomic rollback", async () => {
  const { database, state, service } = await fixture({ now: 40_000 });
  try {
    const venue = await createVenue(service);
    const input = equipmentInput(venue.id, [
      { load_grams: 5_000, quantity: 2, label: "5 kg", available: true },
      { load_grams: 10_000, quantity: 2, label: "10 kg", available: true },
    ]);
    const receipt = await service.prepareFitnessEquipmentSave(input, null);
    const loadIds = receipt.after.loads.map(({ id }) => id);
    assert.equal(new Set(loadIds).size, 2);
    state.throwAfterBatch = true;
    assert.equal((await service.commitFitnessConfigWrite(receipt)).outcome, "saved");
    assert.deepEqual(
      database.selectObjects(
        "SELECT id FROM fitness_equipment_loads WHERE equipment_id=? ORDER BY load_grams",
        [receipt.after.equipment.id],
      ).map(({ id }) => id),
      loadIds,
    );
    assert.equal((await service.commitFitnessConfigWrite(receipt)).outcome, "already_saved");

    const edit = await service.prepareFitnessEquipmentSave(
      equipmentInput(venue.id, [
        { load_grams: 7_500, quantity: 2, label: "7.5 kg", available: true },
      ]),
      receipt.after,
    );
    state.failAtStatement = 2;
    await assert.rejects(
      service.commitFitnessConfigWrite(edit),
      (error) => error instanceof store.FitnessConfigMutationError && error.code === "write_failed",
    );
    assert.deepEqual(
      database.selectObjects(
        "SELECT id FROM fitness_equipment_loads WHERE equipment_id=? ORDER BY load_grams",
        [receipt.after.equipment.id],
      ).map(({ id }) => id),
      loadIds,
    );
    assert.equal(
      database.selectValue("SELECT updated_at FROM fitness_equipment WHERE id=?", [receipt.after.equipment.id]),
      receipt.after.equipment.updated_at,
    );
  } finally {
    database.close();
  }
});

test("equipment save rejects unknown/archived venue and stale update/status writers", async () => {
  const { database, state, service } = await fixture({ now: 50_000 });
  try {
    await assert.rejects(
      service.prepareFitnessEquipmentSave(equipmentInput("missing"), null),
      (error) => error instanceof store.FitnessConfigMutationError && error.code === "changed",
    );
    const venue = await createVenue(service);
    const beforeInvalidKind = database.selectValue("SELECT COUNT(*) FROM fitness_equipment");
    const invalidKindBatches = state.batchCalls;
    await assert.rejects(
      service.prepareFitnessEquipmentSave({
        ...equipmentInput(venue.id),
        kind: "unknown-kind",
      }, null),
      (error) => error instanceof store.FitnessConfigMutationError &&
        error.code === "invalid_input",
    );
    assert.equal(state.batchCalls, invalidKindBatches);
    assert.equal(
      database.selectValue("SELECT COUNT(*) FROM fitness_equipment"),
      beforeInvalidKind,
    );
    const oversizedBatches = state.batchCalls;
    await assert.rejects(
      service.prepareFitnessEquipmentSave({
        ...equipmentInput(venue.id),
        min_load_grams: 0,
        max_load_grams: 1_000_000,
        loads: Array.from({ length: 501 }, (_, index) => ({
          load_grams: index,
          quantity: 1,
          label: `档位 ${index}`,
          available: true,
        })),
      }, null),
      (error) => error instanceof store.FitnessConfigMutationError &&
        error.code === "invalid_input",
    );
    assert.equal(state.batchCalls, oversizedBatches);
    const created = await service.prepareFitnessEquipmentSave(equipmentInput(venue.id), null);
    await service.commitFitnessConfigWrite(created);
    const edit = await service.prepareFitnessEquipmentSave(
      { ...equipmentInput(venue.id), name: "新哑铃" },
      created.after,
    );
    const status = await service.prepareFitnessEquipmentStatus(
      created.after.equipment,
      "maintenance",
    );
    assert.equal((await service.commitFitnessConfigWrite(status)).outcome, "saved");
    assert.equal((await service.commitFitnessConfigWrite(edit)).outcome, "changed");

    executeRun(
      database,
      "UPDATE fitness_venues SET status='archived',is_default=0,updated_at=updated_at+1 WHERE id=?",
      [venue.id],
    );
    await assert.rejects(
      service.prepareFitnessEquipmentSave(equipmentInput(venue.id), null),
      (error) => error instanceof store.FitnessConfigMutationError && error.code === "changed",
    );
  } finally {
    database.close();
  }
});

test("constraint save/toggle uses full CAS and profile/venue/equipment clocks cannot ABA", async () => {
  const { database, state, service } = await fixture({ now: 60_000 });
  try {
    const created = await service.prepareFitnessConstraintSave(constraintInput, null);
    await service.commitFitnessConfigWrite(created);
    state.now = created.after.updated_at;
    const pauseA = await service.prepareFitnessConstraintActive(created.after, false);
    const pauseB = await service.prepareFitnessConstraintActive(created.after, false);
    assert.equal(pauseA.after.updated_at, created.after.updated_at + 1);
    assert.equal((await service.commitFitnessConfigWrite(pauseA)).outcome, "saved");
    assert.equal((await service.commitFitnessConfigWrite(pauseB)).outcome, "already_saved");

    const editFromOld = await service.prepareFitnessConstraintSave(
      { ...constraintInput, label: "旧标签写入", active: false },
      pauseA.after,
    );
    const resume = await service.prepareFitnessConstraintActive(pauseA.after, true);
    await service.commitFitnessConfigWrite(resume);
    assert.equal((await service.commitFitnessConfigWrite(editFromOld)).outcome, "changed");
    assert.equal(
      database.selectValue("SELECT active FROM fitness_constraints WHERE id=?", [created.after.id]),
      1,
    );
  } finally {
    database.close();
  }
});

test("unknown inspection never writes; committed write survives broadcast failure", async () => {
  const { database, state, service } = await fixture({ now: 70_000 });
  try {
    const receipt = await service.prepareFitnessProfileSave(profileInput, null);
    state.failQueries = 1;
    assert.equal(await service.inspectFitnessConfigWrite(receipt), "still_unknown");
    const batches = state.batchCalls;
    state.failQueries = 1;
    assert.equal((await service.commitFitnessConfigWrite(receipt)).outcome, "outcome_uncertain");
    assert.equal(state.batchCalls, batches);

    state.broadcastThrows = true;
    state.throwAfterBatch = true;
    assert.equal((await service.commitFitnessConfigWrite(receipt)).outcome, "saved");
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_profiles"), 1);
    assert.deepEqual(state.broadcasts, ["profile-saved"]);
  } finally {
    database.close();
  }
});

test("safe Web Lock option fails closed before invoking an operation", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: undefined,
  });
  try {
    const lock = await import(moduleUrl(`${lockJavaScript}\n// isolated-no-locks`));
    let invoked = false;
    assert.throws(
      () => lock.withFitnessWriteLock(async () => {
        invoked = true;
      }, { requireSupport: true }),
      /不支持安全的跨标签页写入锁/,
    );
    assert.equal(invoked, false);
  } finally {
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
  }
});

test("safe config service performs zero reads and writes when its lock is unavailable", async () => {
  const { database, state, runtime } = await fixture({ now: 80_000 });
  try {
    const service = store.createFitnessConfigStorageService({
      ...runtime,
      withExclusiveLock() {
        throw new Error("Web Locks unavailable");
      },
    });
    await assert.rejects(
      service.prepareFitnessProfileSave(profileInput, null),
      (error) => error instanceof store.FitnessConfigMutationError &&
        error.code === "inspect_failed",
    );
    assert.equal(state.queryCalls, 0);
    assert.equal(state.batchCalls, 0);
    assert.equal(database.selectValue("SELECT COUNT(*) FROM fitness_profiles"), 0);
  } finally {
    database.close();
  }
});

test("settings loader exposes one cached display generation and prepare snapshots callers before awaiting", async () => {
  const { database, state, service } = await fixture({ now: 90_000 });
  try {
    executeRun(
      database,
      "INSERT INTO fitness_settings(key,value,updated_at) VALUES('__fitness_live_receipt__:kept','marker',7)",
    );
    const expected = await service.loadFitnessSettingsExpectedState();
    assert.deepEqual(expected, {
      generationId: "legacy",
      generationSequence: 0,
      rows: [null, null, null, null],
      settings: defaultSettings,
    });
    assert.equal(state.batchCalls, 0);

    const next = { ...changedSettings };
    const mutableExpected = structuredClone(expected);
    const prepare = service.prepareFitnessSettingsSave(next, mutableExpected);
    next.unit = "kg";
    mutableExpected.generationId = "22222222-2222-4222-8222-222222222222";
    mutableExpected.generationSequence = 1;
    mutableExpected.settings.unit = "lb";
    mutableExpected.rows[0] = { key: "unit", value: "lb", updated_at: 1 };
    const receipt = await prepare;

    assert.equal(state.batchCalls, 0);
    assert.deepEqual(receipt.before, expected);
    assert.deepEqual(receipt.after.settings, changedSettings);
    assert.deepEqual(receipt.after.rows.map(({ key }) => key), canonicalSettingKeys);
    assert.deepEqual(receipt.after.rows.map(({ value }) => value), [
      "lb", "false", "true", "false",
    ]);
    assert.deepEqual(receipt.after.rows.map(({ updated_at }) => updated_at), [
      90_000, 90_000, 90_000, 90_000,
    ]);
    assert.equal(store.isFitnessConfigWriteReceipt(receipt), true);
    assert.equal(
      database.selectValue(
        "SELECT value FROM fitness_settings WHERE key='__fitness_live_receipt__:kept'",
      ),
      "marker",
    );

    const invalidValue = structuredClone(receipt);
    invalidValue.after.rows[1].value = "yes";
    invalidValue.after.settings.rest_timer_enabled = true;
    const resignedInvalidValue = await resignReceipt(invalidValue);
    assert.equal(store.isFitnessConfigWriteReceipt(resignedInvalidValue), false);
    assert.equal(
      await service.inspectFitnessConfigWrite(resignedInvalidValue),
      "invalid_receipt",
    );
    for (const target of ["top", "before", "after"]) {
      const generationTamper = structuredClone(receipt);
      if (target === "top") {
        generationTamper.generationId = "33333333-3333-4333-8333-333333333333";
      } else {
        generationTamper[target].generationId =
          "33333333-3333-4333-8333-333333333333";
      }
      const resignedGenerationTamper = await resignReceipt(generationTamper);
      assert.equal(store.isFitnessConfigWriteReceipt(resignedGenerationTamper), false, target);
      assert.equal(
        await service.inspectFitnessConfigWrite(resignedGenerationTamper),
        "invalid_receipt",
        target,
      );
    }
    await assert.rejects(
      service.prepareFitnessSettingsSave({ ...changedSettings, sound_enabled: Number.NaN }, expected),
      (error) => error instanceof store.FitnessConfigMutationError &&
        error.code === "invalid_input",
    );
    assert.equal(state.batchCalls, 0);
  } finally {
    database.close();
  }
});

test("settings display generation replacement blocks prepare despite byte-identical rows", async () => {
  const { database, state, service } = await fixture({ now: 90_500 });
  try {
    for (const [key, value, updatedAt] of [
      ["unit", "kg", 1],
      ["rest_timer_enabled", "true", 2],
      ["sound_enabled", "false", 3],
      ["ai_enabled", "true", 4],
    ]) {
      executeRun(
        database,
        "INSERT INTO fitness_settings(key,value,updated_at) VALUES(?,?,?)",
        [key, value, updatedAt],
      );
    }
    const displayed = await service.loadFitnessSettingsExpectedState();
    const rawBefore = database.selectObjects(
      "SELECT key,value,updated_at FROM fitness_settings ORDER BY key",
    ).map((row) => ({ ...row }));
    state.generation = {
      generationId: "22222222-2222-4222-8222-222222222222",
      sequence: 1,
    };
    await assert.rejects(
      service.prepareFitnessSettingsSave(changedSettings, displayed),
      (error) => error instanceof store.FitnessConfigMutationError &&
        error.code === "changed",
    );
    assert.equal(state.batchCalls, 0);
    assert.deepEqual(
      database.selectObjects(
        "SELECT key,value,updated_at FROM fitness_settings ORDER BY key",
      ).map((row) => ({ ...row })),
      rawBefore,
    );
  } finally {
    database.close();
  }
});

test("a cached settings expectation rejects a peer edit to any canonical key without writing", async () => {
  const initialRows = [
    ["unit", "kg", 90_001],
    ["rest_timer_enabled", "true", 90_002],
    ["sound_enabled", "false", 90_003],
    ["ai_enabled", "true", 90_004],
  ];
  for (const [key, peerValue] of [
    ["unit", "lb"],
    ["rest_timer_enabled", "false"],
    ["sound_enabled", "true"],
    ["ai_enabled", "false"],
  ]) {
    const initial = initialRows.find(([candidate]) => candidate === key);
    for (const field of ["value", "updated_at"]) {
      const { database, state, service } = await fixture({ now: 91_000 });
      try {
        for (const row of initialRows) {
          executeRun(
            database,
            "INSERT INTO fitness_settings(key,value,updated_at) VALUES(?,?,?)",
            row,
          );
        }
        // This snapshot and its .settings value represent the UI's one cached read.
        const displayed = await service.loadFitnessSettingsExpectedState();
        const receipt = await service.prepareFitnessSettingsSave(changedSettings, displayed);
        const value = field === "value" ? peerValue : initial[1];
        const updatedAt = field === "updated_at" ? 90_500 : initial[2];
        executeRun(
          database,
          "UPDATE fitness_settings SET value=?,updated_at=? WHERE key=?",
          [value, updatedAt, key],
        );
        const label = `${key}/${field}`;
        const batches = state.batchCalls;
        assert.equal(await service.inspectFitnessConfigWrite(receipt), "changed", label);
        assert.equal((await service.commitFitnessConfigWrite(receipt)).outcome, "changed", label);
        assert.equal(state.batchCalls, batches, label);
        assert.deepEqual(
          database.selectObjects(
            "SELECT key,value,updated_at FROM fitness_settings WHERE key=?",
            [key],
          ).map((row) => ({ ...row })),
          [{ key, value, updated_at: updatedAt }],
          label,
        );
      } finally {
        database.close();
      }
    }
  }
});

test("settings response loss settles exact, writes all four rows, and retry is idempotent", async () => {
  const { database, state, service } = await fixture({ now: 1 });
  try {
    for (const [key, value, updatedAt] of [
      ["unit", "lb", 11],
      ["rest_timer_enabled", "false", 22],
      ["sound_enabled", "true", 33],
      ["ai_enabled", "false", 44],
    ]) {
      executeRun(
        database,
        "INSERT INTO fitness_settings(key,value,updated_at) VALUES(?,?,?)",
        [key, value, updatedAt],
      );
    }
    executeRun(
      database,
      "INSERT INTO fitness_settings(key,value,updated_at) VALUES('__fitness_structure_receipt__:kept','proof',99)",
    );
    const expected = await service.loadFitnessSettingsExpectedState();
    assert.deepEqual(expected.rows.map((row) => row.updated_at), [11, 22, 33, 44]);
    assert.deepEqual(expected.settings, changedSettings);

    const receipt = await service.prepareFitnessSettingsSave(defaultSettings, expected);
    assert.deepEqual(receipt.after.rows.map((row) => row.updated_at), [45, 45, 45, 45]);
    state.throwAfterBatch = true;
    state.broadcastThrows = true;
    const saved = await service.commitFitnessConfigWrite(receipt);
    assert.equal(saved.outcome, "saved");
    assert.equal(saved.entityId, "settings");
    assert.equal(saved.updatedAt, 45);
    assert.deepEqual(
      database.selectObjects(
        "SELECT key,value,updated_at FROM fitness_settings WHERE key IN (?,?,?,?) ORDER BY key",
        canonicalSettingKeys,
      ).map((row) => ({ ...row })),
      [
        { key: "ai_enabled", value: "true", updated_at: 45 },
        { key: "rest_timer_enabled", value: "true", updated_at: 45 },
        { key: "sound_enabled", value: "false", updated_at: 45 },
        { key: "unit", value: "kg", updated_at: 45 },
      ],
    );
    assert.equal(
      database.selectValue(
        "SELECT value FROM fitness_settings WHERE key='__fitness_structure_receipt__:kept'",
      ),
      "proof",
    );
    assert.equal(await service.inspectFitnessConfigWrite(receipt), "exact_saved");
    const batches = state.batchCalls;
    assert.equal((await service.commitFitnessConfigWrite(receipt)).outcome, "already_saved");
    assert.equal(state.batchCalls, batches);
    assert.deepEqual(state.broadcasts, ["settings-saved", "settings-saved"]);
  } finally {
    database.close();
  }
});

test("settings recovery reports changed after a peer advances a committed uncertain result", async () => {
  const { database, state, service } = await fixture({ now: 92_000 });
  try {
    const expected = await service.loadFitnessSettingsExpectedState();
    const receipt = await service.prepareFitnessSettingsSave(changedSettings, expected);
    state.throwAfterBatch = true;
    state.failQueryAfterBatch = true;
    assert.equal(
      (await service.commitFitnessConfigWrite(receipt)).outcome,
      "outcome_uncertain",
    );
    executeRun(
      database,
      "UPDATE fitness_settings SET value='kg',updated_at=updated_at+1 WHERE key='unit'",
    );
    const batches = state.batchCalls;
    assert.equal(await service.inspectFitnessConfigWrite(receipt), "changed");
    assert.equal((await service.commitFitnessConfigWrite(receipt)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(
      database.selectValue("SELECT value FROM fitness_settings WHERE key='unit'"),
      "kg",
    );
  } finally {
    database.close();
  }
});

test("settings generation ABA and stale concurrent writers both fail closed with zero write", async () => {
  const generationFixture = await fixture({ now: 93_000 });
  try {
    const { database, state, service } = generationFixture;
    const expected = await service.loadFitnessSettingsExpectedState();
    const receipt = await service.prepareFitnessSettingsSave(changedSettings, expected);
    state.generation = {
      generationId: "22222222-2222-4222-8222-222222222222",
      sequence: 1,
    };
    assert.equal(await service.inspectFitnessConfigWrite(receipt), "changed");
    assert.equal((await service.commitFitnessConfigWrite(receipt)).outcome, "changed");
    assert.equal(state.batchCalls, 0);
    assert.equal(
      database.selectValue(
        "SELECT COUNT(*) FROM fitness_settings WHERE key IN (?,?,?,?)",
        canonicalSettingKeys,
      ),
      0,
    );
  } finally {
    generationFixture.database.close();
  }

  const raceFixture = await fixture({ now: 94_000 });
  try {
    const { database, state, service } = raceFixture;
    const expected = await service.loadFitnessSettingsExpectedState();
    const a = await service.prepareFitnessSettingsSave(changedSettings, expected);
    const b = await service.prepareFitnessSettingsSave({
      ...changedSettings,
      unit: "kg",
    }, expected);
    assert.equal((await service.commitFitnessConfigWrite(a)).outcome, "saved");
    const batches = state.batchCalls;
    assert.equal((await service.commitFitnessConfigWrite(b)).outcome, "changed");
    assert.equal(state.batchCalls, batches);
    assert.equal(database.selectValue("SELECT value FROM fitness_settings WHERE key='unit'"), "lb");
  } finally {
    raceFixture.database.close();
  }
});

test("settings transaction rollback restores every value and timestamp", async () => {
  const { database, state, service } = await fixture({ now: 1 });
  try {
    for (const [key, value, updatedAt] of [
      ["unit", "kg", 101],
      ["rest_timer_enabled", "true", 102],
      ["sound_enabled", "false", 103],
      ["ai_enabled", "true", 104],
    ]) {
      executeRun(
        database,
        "INSERT INTO fitness_settings(key,value,updated_at) VALUES(?,?,?)",
        [key, value, updatedAt],
      );
    }
    const before = await service.loadFitnessSettingsExpectedState();
    const receipt = await service.prepareFitnessSettingsSave(changedSettings, before);
    assert.deepEqual(receipt.after.rows.map((row) => row.updated_at), [105, 105, 105, 105]);
    state.failAtStatement = 3;
    await assert.rejects(
      service.commitFitnessConfigWrite(receipt),
      (error) => error instanceof store.FitnessConfigMutationError &&
        error.code === "write_failed",
    );
    assert.deepEqual(await service.loadFitnessSettingsExpectedState(), before);
    assert.equal(await service.inspectFitnessConfigWrite(receipt), "expected");
  } finally {
    database.close();
  }
});

test("settings inspect and commit consume one synchronous receipt snapshot", async () => {
  const { database, service } = await fixture({ now: 96_000 });
  try {
    const expected = await service.loadFitnessSettingsExpectedState();
    const prepared = await service.prepareFitnessSettingsSave(changedSettings, expected);
    const mutableCommitReceipt = structuredClone(prepared);
    const committing = service.commitFitnessConfigWrite(mutableCommitReceipt);
    mutableCommitReceipt.after.rows[0].value = "kg";
    mutableCommitReceipt.after.settings.unit = "kg";
    const saved = await committing;
    assert.equal(saved.outcome, "saved");
    assert.equal(database.selectValue("SELECT value FROM fitness_settings WHERE key='unit'"), "lb");
    assert.equal(saved.receipt.after.rows[0].value, "lb");

    const mutableInspectReceipt = structuredClone(saved.receipt);
    const inspecting = service.inspectFitnessConfigWrite(mutableInspectReceipt);
    mutableInspectReceipt.after.rows[2].value = "false";
    mutableInspectReceipt.after.settings.sound_enabled = false;
    assert.equal(await inspecting, "exact_saved");
  } finally {
    database.close();
  }
});
