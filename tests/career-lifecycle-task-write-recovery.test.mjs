import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const BASE_TIME = "2026-08-20T01:00:00.000Z";
const OPERATION_TIME = "2026-08-22T02:00:00.000Z";
const FUTURE_TIME = "2026-08-25T02:00:00.000Z";
const GENERATION_ONE = "10000000-0000-4000-8000-000000000001";
const GENERATION_TWO = "20000000-0000-4000-8000-000000000002";

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

const [
  schemaJavaScript,
  rawMarkerJavaScript,
  rawLifecycleJavaScript,
  rawTaskJavaScript,
] = await Promise.all([
  transpile("lib/schemas/zhiji.ts"),
  transpile("lib/career/write-marker.ts"),
  transpile("lib/career/lifecycle-writes.ts"),
  transpile("lib/career/task-writes.ts"),
]);

const defaultRuntimeCalls = {
  query: 0,
  batch: 0,
  currentGeneration: 0,
  lockCallback: 0,
  broadcast: 0,
};
globalThis.__careerWriteDefaultRuntimeCalls = defaultRuntimeCalls;

const stubModules = {
  "@/lib/local-db/client": moduleUrl(`
    function calls(){ return globalThis.__careerWriteDefaultRuntimeCalls; }
    export const localDb = {
      query(){ calls().query += 1; throw new Error("default runtime not used"); },
      batch(){ calls().batch += 1; throw new Error("default runtime not used"); },
      currentGeneration(){
        calls().currentGeneration += 1;
        throw new Error("default runtime not used");
      }
    };
  `),
  "./lock": moduleUrl(`
    function calls(){ return globalThis.__careerWriteDefaultRuntimeCalls; }
    export function broadcastCareerDataChanged(){ calls().broadcast += 1; }
    export function withCareerWriteLock(task){
      calls().lockCallback += 1;
      return task();
    }
  `),
};
let markerJavaScript = rawMarkerJavaScript;
for (const [specifier, url] of Object.entries(stubModules)) {
  markerJavaScript = markerJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const markerUrl = moduleUrl(markerJavaScript);
const lifecycleUrl = moduleUrl(rawLifecycleJavaScript.replaceAll(
  '"./write-marker"',
  `"${markerUrl}"`,
));
const taskUrl = moduleUrl(rawTaskJavaScript.replaceAll(
  '"./write-marker"',
  `"${markerUrl}"`,
));
const schemaUrl = moduleUrl(schemaJavaScript);

const [marker, lifecycle, taskWrites, schema, sqlite3] = await Promise.all([
  import(markerUrl),
  import(lifecycleUrl),
  import(taskUrl),
  import(schemaUrl),
  sqlite3InitModule(),
]);

function execute(database, statements) {
  let changes = 0;
  database.transaction("IMMEDIATE", () => {
    for (const { sql, params = [] } of statements) {
      const statement = database.prepare(sql);
      try {
        if (params.length) statement.bind(params);
        while (statement.step()) {
          // Consume all rows before finalization.
        }
        changes += Number(database.changes());
      } finally {
        statement.finalize();
      }
    }
  });
  return { changes };
}

function generatedUuid(index) {
  return `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function installCanonicalSchema(database) {
  execute(database, [
    ...schema.ZHIJI_V1_SCHEMA_STATEMENTS,
    ...schema.ZHIJI_V2_SCHEMA_MIGRATION_STATEMENTS,
    ...schema.ZHIJI_V3_SCHEMA_MIGRATION_STATEMENTS,
    ...schema.ZHIJI_V4_SCHEMA_MIGRATION_STATEMENTS,
    ...schema.ZHIJI_V5_SCHEMA_MIGRATION_STATEMENTS,
  ]);
  database.exec(`
    PRAGMA application_id=${schema.ZHIJI_APPLICATION_ID};
    PRAGMA user_version=5;
  `);
}

function insertFixtureFacts(database) {
  database.exec(`
    INSERT INTO career_stages(id,name,color,position,is_terminal,hidden) VALUES
      ('stage-active','进行中','#4488aa',0,0,0),
      ('stage-next','下一阶段','#44aa88',1,0,0),
      ('stage-terminal','已结束','#888888',2,1,0);

    INSERT INTO career_jobs(
      id,company,role,location,source,source_url,stage_id,priority,salary,
      work_mode,description,applied_at,deadline,contact_name,note,tags,
      created_at,updated_at,archived,position,archived_at,ended_at,
      archived_operation_id,ended_operation_id
    ) VALUES
      ('job-active','Active Co','Designer','','手动记录','','stage-active',1,
       '','','',NULL,NULL,'','original note','','${BASE_TIME}','${BASE_TIME}',
       0,0,NULL,NULL,NULL,NULL),
      ('job-ended','Ended Co','Engineer','','手动记录','','stage-terminal',1,
       '','','',NULL,NULL,'','','','${BASE_TIME}','${BASE_TIME}',0,0,NULL,
       '${BASE_TIME}',NULL,'old-end-operation'),
      ('job-archived','Archived Co','Researcher','','手动记录','','stage-active',1,
       '','','',NULL,NULL,'','','','${BASE_TIME}','${BASE_TIME}',1,0,
       '${BASE_TIME}',NULL,'old-archive-operation',NULL);

    INSERT INTO career_tasks(
      id,job_id,contact_id,title,due_at,kind,priority,status,created_at,
      updated_at,canceled_at,cancellation_reason,lifecycle_previous_status,
      lifecycle_operation_id
    ) VALUES
      ('task-active','job-active',NULL,'Active follow-up','${FUTURE_TIME}',
       '跟进',2,'todo','${BASE_TIME}','${BASE_TIME}',NULL,NULL,NULL,NULL),
      ('task-complete','job-active',NULL,'Complete me','${FUTURE_TIME}',
       '跟进',1,'todo','${BASE_TIME}','${BASE_TIME}',NULL,NULL,NULL,NULL),
      ('task-ended','job-ended',NULL,'Ended follow-up','${FUTURE_TIME}',
       '跟进',1,'canceled','${BASE_TIME}','${BASE_TIME}','${BASE_TIME}',
       'job_ended','todo','old-end-operation'),
      ('task-archived','job-archived',NULL,'Archived follow-up','${FUTURE_TIME}',
       '跟进',1,'canceled','${BASE_TIME}','${BASE_TIME}','${BASE_TIME}',
       'job_archived','todo','old-archive-operation');

    INSERT INTO career_interviews(
      id,job_id,round_name,interview_type,scheduled_at,duration,interviewer,
      meeting_url,status,summary,raw_notes,questions_json,reflection,
      created_at,updated_at,canceled_at,cancellation_reason,
      lifecycle_previous_status,lifecycle_operation_id
    ) VALUES
      ('interview-active','job-active','一面','视频面试','${FUTURE_TIME}',45,
       'Lee','','scheduled','','','[]','','${BASE_TIME}','${BASE_TIME}',
       NULL,NULL,NULL,NULL),
      ('interview-ended','job-ended','终态面试','视频面试','${FUTURE_TIME}',45,
       'Kai','','canceled','','','[]','','${BASE_TIME}','${BASE_TIME}',
       '${BASE_TIME}','job_ended','scheduled','old-end-operation'),
      ('interview-archived','job-archived','归档面试','视频面试','${FUTURE_TIME}',45,
       'Morgan','','canceled','','','[]','','${BASE_TIME}','${BASE_TIME}',
       '${BASE_TIME}','job_archived','scheduled','old-archive-operation');

    INSERT INTO career_lifecycle_events(
      id,job_id,entity_type,entity_id,action,previous_status,next_status,
      previous_due_at,next_due_at,reason,created_at
    ) VALUES
      ('old-end-operation_task_task-ended','job-ended','task','task-ended',
       'auto_pause_job_ended','todo','canceled','${FUTURE_TIME}','${FUTURE_TIME}',
       'job_ended','${BASE_TIME}'),
      ('old-end-operation_interview_interview-ended','job-ended','interview',
       'interview-ended','auto_pause_job_ended','scheduled','canceled',
       '${FUTURE_TIME}','${FUTURE_TIME}','job_ended','${BASE_TIME}'),
      ('old-archive-operation_task_task-archived','job-archived','task',
       'task-archived','auto_pause_job_archived','todo','canceled',
       '${FUTURE_TIME}','${FUTURE_TIME}','job_archived','${BASE_TIME}'),
      ('old-archive-operation_interview_interview-archived','job-archived',
       'interview','interview-archived','auto_pause_job_archived','scheduled',
       'canceled','${FUTURE_TIME}','${FUTURE_TIME}','job_archived','${BASE_TIME}');
  `);
}

function fixture() {
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  installCanonicalSchema(database);
  insertFixtureFacts(database);
  const state = {
    activeLocks: 0,
    maxActiveLocks: 0,
    lockCalls: 0,
    tail: Promise.resolve(),
    queryCalls: 0,
    batchCalls: 0,
    batchFault: null,
    beforeBatch: null,
    queryFailuresRemaining: 0,
    queryFailuresAfterBatch: 0,
    broadcasts: [],
    broadcastThrows: false,
    generationId: GENERATION_ONE,
    generationSequence: 1,
    uuidIndex: 1,
    now: Date.parse(OPERATION_TIME),
    nowSequence: [],
  };
  const requireLock = (label) => {
    assert.equal(state.activeLocks, 1, `${label} must hold the exclusive lock`);
  };
  const runtime = {
    async withExclusiveLock(operation) {
      state.lockCalls += 1;
      const previous = state.tail;
      let release;
      state.tail = new Promise((resolve) => { release = resolve; });
      await previous;
      state.activeLocks += 1;
      state.maxActiveLocks = Math.max(state.maxActiveLocks, state.activeLocks);
      try {
        return await operation();
      } finally {
        state.activeLocks -= 1;
        release();
      }
    },
    async query(sql, params = []) {
      requireLock("query");
      state.queryCalls += 1;
      if (state.queryFailuresRemaining > 0) {
        state.queryFailuresRemaining -= 1;
        throw new Error("query response unavailable");
      }
      return { rows: database.selectObjects(sql, params) };
    },
    async batch(statements) {
      requireLock("batch");
      state.batchCalls += 1;
      const hook = state.beforeBatch;
      state.beforeBatch = null;
      hook?.();
      if (state.batchFault === "before") {
        state.batchFault = null;
        state.queryFailuresRemaining += state.queryFailuresAfterBatch;
        state.queryFailuresAfterBatch = 0;
        throw new Error("batch failed before commit");
      }
      const result = execute(database, statements);
      state.queryFailuresRemaining += state.queryFailuresAfterBatch;
      state.queryFailuresAfterBatch = 0;
      if (state.batchFault === "after") {
        state.batchFault = null;
        throw new Error("batch response lost after commit");
      }
      return result;
    },
    async currentGeneration() {
      requireLock("currentGeneration");
      return {
        generationId: state.generationId,
        sequence: state.generationSequence,
      };
    },
    now() {
      requireLock("now");
      return state.nowSequence.length > 0 ? state.nowSequence.shift() : state.now;
    },
    randomUUID() {
      requireLock("randomUUID");
      const value = generatedUuid(state.uuidIndex);
      state.uuidIndex += 1;
      return value;
    },
    broadcast(reason) {
      requireLock("broadcast");
      state.broadcasts.push(reason);
      if (state.broadcastThrows) throw new Error("broadcast unavailable");
    },
  };
  return {
    database,
    state,
    runtime,
    lifecycle: lifecycle.createCareerLifecycleWriteStorageService(runtime),
    tasks: taskWrites.createCareerTaskWriteStorageService(runtime),
    close() { database.close(); },
  };
}

function insertMixedIdProjectionRows(database, jobId) {
  database.exec(`
    INSERT INTO career_tasks(
      id,job_id,contact_id,title,due_at,kind,priority,status,created_at,
      updated_at,canceled_at,cancellation_reason,lifecycle_previous_status,
      lifecycle_operation_id
    ) VALUES
      ('A','${jobId}',NULL,'A task','${FUTURE_TIME}','跟进',1,'todo',
       '${BASE_TIME}','${BASE_TIME}',NULL,NULL,NULL,NULL),
      ('_','${jobId}',NULL,'underscore task','${FUTURE_TIME}','跟进',1,'todo',
       '${BASE_TIME}','${BASE_TIME}',NULL,NULL,NULL,NULL),
      ('a','${jobId}',NULL,'a task','${FUTURE_TIME}','跟进',1,'todo',
       '${BASE_TIME}','${BASE_TIME}',NULL,NULL,NULL,NULL),
      (char(57344),'${jobId}',NULL,'private-use task','${FUTURE_TIME}','跟进',1,
       'todo','${BASE_TIME}','${BASE_TIME}',NULL,NULL,NULL,NULL),
      (char(128512),'${jobId}',NULL,'astral task','${FUTURE_TIME}','跟进',1,
       'todo','${BASE_TIME}','${BASE_TIME}',NULL,NULL,NULL,NULL);

    INSERT INTO career_interviews(
      id,job_id,round_name,interview_type,scheduled_at,duration,interviewer,
      meeting_url,status,summary,raw_notes,questions_json,reflection,
      created_at,updated_at,canceled_at,cancellation_reason,
      lifecycle_previous_status,lifecycle_operation_id
    ) VALUES
      ('A','${jobId}','A interview','视频面试','${FUTURE_TIME}',45,'','','scheduled',
       '','','[]','','${BASE_TIME}','${BASE_TIME}',NULL,NULL,NULL,NULL),
      ('_','${jobId}','underscore interview','视频面试','${FUTURE_TIME}',45,'','',
       'scheduled','','','[]','','${BASE_TIME}','${BASE_TIME}',NULL,NULL,NULL,NULL),
      ('a','${jobId}','a interview','视频面试','${FUTURE_TIME}',45,'','','scheduled',
       '','','[]','','${BASE_TIME}','${BASE_TIME}',NULL,NULL,NULL,NULL),
      (char(57344),'${jobId}','private-use interview','视频面试','${FUTURE_TIME}',
       45,'','','scheduled','','','[]','','${BASE_TIME}','${BASE_TIME}',NULL,NULL,
       NULL,NULL),
      (char(128512),'${jobId}','astral interview','视频面试','${FUTURE_TIME}',45,
       '','','scheduled','','','[]','','${BASE_TIME}','${BASE_TIME}',NULL,NULL,NULL,
       NULL);

    INSERT INTO career_lifecycle_events(
      id,job_id,entity_type,entity_id,action,previous_status,next_status,
      previous_due_at,next_due_at,reason,created_at
    ) VALUES
      ('A','${jobId}','job','${jobId}','mixed_A',NULL,NULL,NULL,NULL,'test',
       '${BASE_TIME}'),
      ('_','${jobId}','job','${jobId}','mixed_underscore',NULL,NULL,NULL,NULL,
       'test','${BASE_TIME}'),
      ('a','${jobId}','job','${jobId}','mixed_a',NULL,NULL,NULL,NULL,'test',
       '${BASE_TIME}'),
      (char(57344),'${jobId}','job','${jobId}','mixed_private_use',NULL,NULL,NULL,
       NULL,'test','${BASE_TIME}'),
      (char(128512),'${jobId}','job','${jobId}','mixed_astral',NULL,NULL,NULL,NULL,
       'test','${BASE_TIME}');
  `);
}

function row(database, table, id) {
  return { ...database.selectObject(`SELECT * FROM ${table} WHERE id=?`, [id]) };
}

function generation(context) {
  return {
    generationId: context.state.generationId,
    generationSequence: context.state.generationSequence,
  };
}

function displayed(context, jobId, nextStageId = null) {
  const job = row(context.database, "career_jobs", jobId);
  return {
    ...generation(context),
    job,
    currentStage: row(context.database, "career_stages", job.stage_id),
    nextStage: nextStageId === null
      ? null
      : row(context.database, "career_stages", nextStageId),
  };
}

function taskCreateContext(context, jobId = "job-active") {
  if (jobId === null) return { ...generation(context), job: null, stage: null };
  const job = row(context.database, "career_jobs", jobId);
  return {
    ...generation(context),
    job,
    stage: row(context.database, "career_stages", job.stage_id),
  };
}

async function prepareLifecycle(context, intent, choice) {
  const nextStageId = intent.kind === "stage" ? intent.nextStageId : null;
  const preview = await context.lifecycle.previewCareerLifecycleWrite(
    intent,
    displayed(context, intent.jobId, nextStageId),
  );
  const prepared = await context.lifecycle.prepareCareerLifecycleWrite(preview, choice);
  assert.equal(prepared.outcome, "prepared");
  return prepared.receipt;
}

async function prepareTaskComplete(context, taskId = "task-complete") {
  const expected = await context.tasks.loadCareerTaskWriteExpected(
    taskId,
    generation(context),
  );
  return context.tasks.prepareCareerTaskComplete(expected);
}

async function rehash(receipt) {
  const clone = structuredClone(receipt);
  delete clone.projectionSha256;
  clone.projectionSha256 = await marker.hashCareerWriteValue(clone);
  return clone;
}

test("v5 adds an extensible immutable write marker without weakening v4", () => {
  assert.equal(schema.ZHIJI_USER_VERSION, 5);
  assert.equal(
    schema.ZHIJI_V5_MIGRATION_NAME,
    "career-lifecycle-task-write-recovery",
  );
  const database = new sqlite3.oo1.DB(":memory:", "c");
  try {
    execute(database, [
      ...schema.ZHIJI_V1_SCHEMA_STATEMENTS,
      ...schema.ZHIJI_V2_SCHEMA_MIGRATION_STATEMENTS,
      ...schema.ZHIJI_V3_SCHEMA_MIGRATION_STATEMENTS,
      ...schema.ZHIJI_V4_SCHEMA_MIGRATION_STATEMENTS,
    ]);
    database.exec(`INSERT INTO career_core_write_operations(
      operation_id,purpose,receipt_version,kind,entity_id,
      projection_sha256,operation_at
    ) VALUES(
      'career-core-operation-40000000-0000-4000-8000-000000000004',
      'career-core-write',1,'stage-rename','stage_saved','${"a".repeat(64)}',
      '${BASE_TIME}'
    )`);
    execute(database, schema.ZHIJI_V5_SCHEMA_MIGRATION_STATEMENTS);
    assert.equal(
      database.selectValue("SELECT COUNT(*) FROM career_core_write_operations"),
      1,
    );
    assert.equal(
      database.selectValue(`SELECT COUNT(*) FROM sqlite_schema
        WHERE type='table' AND name='career_write_operations'`),
      1,
    );
    database.exec(`INSERT INTO career_write_operations(
      operation_id,purpose,receipt_version,kind,entity_id,
      projection_sha256,operation_at
    ) VALUES('future-operation','career-contact-write',1,'contact-update',
      'contact-1','${"b".repeat(64)}','${BASE_TIME}')`);
    assert.deepEqual(
      database.selectObject(`SELECT purpose,kind
        FROM career_write_operations WHERE operation_id='future-operation'`),
      { purpose: "career-contact-write", kind: "contact-update" },
    );
    assert.throws(() => database.exec(`INSERT INTO career_write_operations(
      operation_id,purpose,receipt_version,kind,entity_id,
      projection_sha256,operation_at
    ) VALUES('blank-purpose','   ',1,'contact-update','contact-1',
      '${"c".repeat(64)}','${BASE_TIME}')`));
  } finally {
    database.close();
  }
});

test("default runtime fails closed before callbacks when Web Locks are unavailable", async (t) => {
  for (const key of Object.keys(defaultRuntimeCalls)) defaultRuntimeCalls[key] = 0;
  const context = fixture();
  t.after(() => context.close());
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: undefined,
  });
  try {
    await assert.rejects(
      lifecycle.previewCareerLifecycleWrite(
        { kind: "archive", jobId: "job-active" },
        displayed(context, "job-active"),
      ),
      (error) => error instanceof marker.CareerWriteError &&
        error.code === "lock_unavailable",
    );
    await assert.rejects(
      taskWrites.loadCareerTaskWriteExpected(
        "task-complete",
        generation(context),
      ),
      (error) => error instanceof marker.CareerWriteError &&
        error.code === "lock_unavailable",
    );
  } finally {
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
  }
  assert.deepEqual(defaultRuntimeCalls, {
    query: 0,
    batch: 0,
    currentGeneration: 0,
    lockCallback: 0,
    broadcast: 0,
  });
});

for (const scenario of [
  {
    name: "active-to-terminal stage transition",
    intent: { kind: "stage", jobId: "job-active", nextStageId: "stage-terminal" },
    choice: "pause",
    kind: "stage-transition",
    reason: "career-job-stage-transitioned",
    assertState(context) {
      assert.equal(row(context.database, "career_jobs", "job-active").stage_id, "stage-terminal");
      assert.equal(row(context.database, "career_tasks", "task-active").status, "canceled");
      assert.equal(
        row(context.database, "career_interviews", "interview-active").status,
        "canceled",
      );
    },
  },
  {
    name: "archive",
    intent: { kind: "archive", jobId: "job-active" },
    choice: "pause",
    kind: "job-archive",
    reason: "career-job-archived",
    assertState(context) {
      assert.equal(row(context.database, "career_jobs", "job-active").archived, 1);
      assert.equal(row(context.database, "career_tasks", "task-active").status, "canceled");
    },
  },
  {
    name: "restore archived lifecycle-owned facts",
    intent: { kind: "restore", jobId: "job-archived" },
    choice: "restore-paused",
    kind: "job-restore",
    reason: "career-job-restored",
    assertState(context) {
      assert.equal(row(context.database, "career_jobs", "job-archived").archived, 0);
      assert.equal(row(context.database, "career_tasks", "task-archived").status, "todo");
      assert.equal(
        row(context.database, "career_interviews", "interview-archived").status,
        "scheduled",
      );
    },
  },
]) {
  test(`${scenario.name} seals, commits, journals, and broadcasts`, async (t) => {
    const context = fixture();
    t.after(() => context.close());
    const receipt = await prepareLifecycle(context, scenario.intent, scenario.choice);
    assert.equal(receipt.kind, scenario.kind);
    assert.equal(context.state.batchCalls, 0, "preview and prepare are read-only");
    assert.equal(
      await context.lifecycle.inspectCareerLifecycleWrite(receipt),
      "expected",
    );
    const result = await context.lifecycle.commitCareerLifecycleWrite(receipt);
    assert.equal(result.outcome, "saved");
    assert.equal(context.state.batchCalls, 1);
    assert.equal(
      await context.lifecycle.inspectCareerLifecycleWrite(receipt),
      "exact_saved",
    );
    assert.deepEqual(context.state.broadcasts, [scenario.reason]);
    assert.deepEqual(
      context.database.selectObject(`SELECT purpose,receipt_version,kind,
        entity_id,projection_sha256,operation_at FROM career_write_operations`),
      {
        purpose: receipt.purpose,
        receipt_version: receipt.version,
        kind: receipt.kind,
        entity_id: result.entityId,
        projection_sha256: receipt.projectionSha256,
        operation_at: receipt.operationAt,
      },
    );
    scenario.assertState(context);
  });
}

test("mixed ASCII and Unicode ids keep SQLite UTF-8 binary projection order", async (t) => {
  assert.doesNotMatch(rawLifecycleJavaScript, /\.localeCompare\(/);
  assert.match(rawLifecycleJavaScript, /TextEncoder/);
  const expectedIds = ["A", "_", "a", "\uE000", "😀"];
  const scenarios = [
    {
      intent: {
        kind: "stage",
        jobId: "job-active",
        nextStageId: "stage-terminal",
      },
      choice: "pause",
    },
    { intent: { kind: "archive", jobId: "job-active" }, choice: "pause" },
    {
      intent: { kind: "restore", jobId: "job-archived" },
      choice: "restore-paused",
    },
  ];

  for (const scenario of scenarios) {
    const context = fixture();
    t.after(() => context.close());
    insertMixedIdProjectionRows(context.database, scenario.intent.jobId);
    const nextStageId = scenario.intent.kind === "stage"
      ? scenario.intent.nextStageId
      : null;
    const preview = await context.lifecycle.previewCareerLifecycleWrite(
      scenario.intent,
      displayed(context, scenario.intent.jobId, nextStageId),
    );
    for (const collection of ["tasks", "interviews", "events"]) {
      assert.deepEqual(
        preview.authorization[collection]
          .map(({ id }) => id)
          .filter((id) => expectedIds.includes(id)),
        expectedIds,
      );
    }
    if (scenario.intent.kind !== "restore") {
      assert.deepEqual(
        preview.impact
          .filter(({ id }) => expectedIds.includes(id))
          .map(({ entityType, id }) => `${entityType}:${id}`),
        [
          "interview:A", "interview:_", "interview:a",
          "interview:\uE000", "interview:😀",
          "task:A", "task:_", "task:a", "task:\uE000", "task:😀",
        ],
      );
    }
    const prepared = await context.lifecycle.prepareCareerLifecycleWrite(
      preview,
      scenario.choice,
    );
    assert.equal(prepared.outcome, "prepared");
    const receipt = prepared.receipt;
    assert.equal(lifecycle.isCareerLifecycleWriteReceipt(receipt), true);
    for (const projection of [receipt.before, receipt.after]) {
      for (const collection of ["tasks", "interviews", "events"]) {
        assert.deepEqual(
          projection[collection]
            .map(({ id }) => id)
            .filter((id) => expectedIds.includes(id)),
          expectedIds,
        );
      }
    }
    assert.equal(
      (await context.lifecycle.commitCareerLifecycleWrite(receipt)).outcome,
      "saved",
    );
    assert.equal(
      await context.lifecycle.inspectCareerLifecycleWrite(receipt),
      "exact_saved",
    );
  }
});

test("new backend covers remaining lifecycle transitions and no-effect choices", async (t) => {
  async function run(context, intent, choice) {
    const nextStageId = intent.kind === "stage" ? intent.nextStageId : null;
    const preview = await context.lifecycle.previewCareerLifecycleWrite(
      intent,
      displayed(context, intent.jobId, nextStageId),
    );
    const prepared = await context.lifecycle.prepareCareerLifecycleWrite(
      preview,
      choice,
    );
    assert.equal(prepared.outcome, "prepared");
    assert.equal(
      (await context.lifecycle.commitCareerLifecycleWrite(prepared.receipt)).outcome,
      "saved",
    );
    return { preview, receipt: prepared.receipt };
  }

  const active = fixture();
  t.after(() => active.close());
  const activeResult = await run(active, {
    kind: "stage",
    jobId: "job-active",
    nextStageId: "stage-next",
  }, "keep");
  assert.equal(activeResult.preview.transition, "active-to-active");
  assert.deepEqual(activeResult.preview.impact, []);
  assert.deepEqual(activeResult.preview.allowedChoices, ["keep"]);
  assert.equal(row(active.database, "career_tasks", "task-active").status, "todo");

  const terminal = fixture();
  t.after(() => terminal.close());
  terminal.database.exec(`INSERT INTO career_stages(
    id,name,color,position,is_terminal,hidden
  ) VALUES('stage-terminal-next','另一终态','#777777',3,1,0)`);
  const terminalResult = await run(terminal, {
    kind: "stage",
    jobId: "job-ended",
    nextStageId: "stage-terminal-next",
  }, "keep");
  assert.equal(terminalResult.preview.transition, "terminal-to-terminal");
  assert.deepEqual(terminalResult.preview.impact, []);
  assert.equal(row(terminal.database, "career_jobs", "job-ended").ended_at, BASE_TIME);
  assert.equal(row(terminal.database, "career_tasks", "task-ended").status, "canceled");

  const restoreTerminal = fixture();
  t.after(() => restoreTerminal.close());
  restoreTerminal.database.exec(`UPDATE career_jobs SET
    stage_id='stage-terminal',ended_at='${BASE_TIME}',
    ended_operation_id='old-terminal-operation'
    WHERE id='job-archived'`);
  const restoreTerminalResult = await run(restoreTerminal, {
    kind: "restore",
    jobId: "job-archived",
  }, "keep-paused");
  assert.equal(restoreTerminalResult.preview.transition, "restore-terminal");
  assert.equal(restoreTerminalResult.preview.requiresChoice, false);
  assert.deepEqual(restoreTerminalResult.preview.allowedChoices, ["keep-paused"]);
  assert.equal(
    row(restoreTerminal.database, "career_tasks", "task-archived").status,
    "canceled",
  );

  const keepPaused = fixture();
  t.after(() => keepPaused.close());
  keepPaused.database.exec(`
    UPDATE career_tasks SET status='done',canceled_at=NULL,
      cancellation_reason=NULL,lifecycle_previous_status=NULL,
      lifecycle_operation_id=NULL WHERE id='task-ended';
    UPDATE career_interviews SET status='completed',canceled_at=NULL,
      cancellation_reason=NULL,lifecycle_previous_status=NULL,
      lifecycle_operation_id=NULL WHERE id='interview-ended';
    DELETE FROM career_lifecycle_events WHERE job_id='job-ended';
  `);
  const keepPausedResult = await run(keepPaused, {
    kind: "stage",
    jobId: "job-ended",
    nextStageId: "stage-active",
  }, "keep-paused");
  assert.equal(keepPausedResult.preview.transition, "terminal-to-active");
  assert.deepEqual(keepPausedResult.preview.impact, []);
  assert.deepEqual(keepPausedResult.preview.allowedChoices, ["keep-paused"]);
  assert.equal(row(keepPaused.database, "career_tasks", "task-ended").status, "done");
});

test("lifecycle causal time survives a backwards clock and rejects equal-time forgery", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const intent = {
    kind: "stage",
    jobId: "job-active",
    nextStageId: "stage-next",
  };
  const preview = await context.lifecycle.previewCareerLifecycleWrite(
    intent,
    displayed(context, intent.jobId, intent.nextStageId),
  );
  const decisionAt = "2026-08-24T02:00:00.000Z";
  context.state.nowSequence = [
    Date.parse(decisionAt),
    Date.parse("2026-08-21T02:00:00.000Z"),
  ];
  const prepared = await context.lifecycle.prepareCareerLifecycleWrite(
    preview,
    "keep",
  );
  assert.equal(prepared.outcome, "prepared");
  const receipt = prepared.receipt;
  assert.equal(receipt.before.decisionAt, decisionAt);
  assert.equal(receipt.operationAt, "2026-08-24T02:00:00.001Z");
  assert.equal(lifecycle.isCareerLifecycleWriteReceipt(receipt), true);

  const equalTime = structuredClone(receipt);
  equalTime.operationAt = equalTime.before.decisionAt;
  equalTime.after = JSON.parse(
    JSON.stringify(equalTime.after).replaceAll(
      receipt.operationAt,
      equalTime.operationAt,
    ),
  );
  const forged = await rehash(equalTime);
  assert.equal(lifecycle.isCareerLifecycleWriteReceipt(forged), false);
  assert.equal(
    await context.lifecycle.inspectCareerLifecycleWrite(forged),
    "invalid_receipt",
  );
  assert.equal(context.state.batchCalls, 0);
});

test("prepare refuses a derived lifecycle event id that already exists", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const operationId = `career-lifecycle-operation-${generatedUuid(1)}`;
  context.database.exec(`INSERT INTO career_lifecycle_events(
    id,job_id,entity_type,entity_id,action,previous_status,next_status,
    previous_due_at,next_due_at,reason,created_at
  ) VALUES('${operationId}','job-active','job','job-active','existing_event',
    NULL,NULL,NULL,NULL,'existing','${BASE_TIME}')`);
  const intent = { kind: "archive", jobId: "job-active" };
  const preview = await context.lifecycle.previewCareerLifecycleWrite(
    intent,
    displayed(context, intent.jobId),
  );
  assert.equal(preview.operationId, operationId);
  await assert.rejects(
    context.lifecycle.prepareCareerLifecycleWrite(preview, "pause"),
    (error) => error instanceof marker.CareerWriteError &&
      error.code === "changed" && error.receipt === undefined,
  );
  assert.equal(context.state.batchCalls, 0);
  assert.equal(
    context.database.selectValue(
      "SELECT COUNT(*) FROM career_write_operations WHERE operation_id=?",
      [operationId],
    ),
    0,
  );
});

test("terminal-to-active restores only exact lifecycle-owned future facts", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const receipt = await prepareLifecycle(context, {
    kind: "stage",
    jobId: "job-ended",
    nextStageId: "stage-active",
  }, "restore-paused");
  assert.equal(receipt.before.transition, "terminal-to-active");
  assert.equal((await context.lifecycle.commitCareerLifecycleWrite(receipt)).outcome, "saved");
  assert.equal(row(context.database, "career_tasks", "task-ended").status, "todo");
  assert.equal(
    row(context.database, "career_interviews", "interview-ended").status,
    "scheduled",
  );
  assert.equal(row(context.database, "career_jobs", "job-ended").ended_at, null);
});

test("task create and complete use sealed projections and one atomic marker transaction", async (t) => {
  const createdContext = fixture();
  t.after(() => createdContext.close());
  const createReceipt = await createdContext.tasks.prepareCareerTaskCreate({
    title: "  Send portfolio  ",
    jobId: "job-active",
    dueAt: FUTURE_TIME,
    kind: " 跟进 ",
    priority: 3,
  }, taskCreateContext(createdContext));
  assert.equal(createReceipt.kind, "task-create");
  assert.equal(createReceipt.after.task.title, "Send portfolio");
  assert.equal(createReceipt.after.task.contact_id, null);
  assert.equal(createdContext.state.batchCalls, 0);
  assert.equal((await createdContext.tasks.commitCareerTaskWrite(createReceipt)).outcome, "saved");
  assert.equal(row(
    createdContext.database,
    "career_tasks",
    createReceipt.after.task.id,
  ).status, "todo");
  assert.deepEqual(createdContext.state.broadcasts, ["career-task-created"]);

  const completedContext = fixture();
  t.after(() => completedContext.close());
  const completeReceipt = await prepareTaskComplete(completedContext);
  assert.equal(completeReceipt.kind, "task-complete");
  assert.equal(
    await completedContext.tasks.inspectCareerTaskWrite(completeReceipt),
    "expected",
  );
  assert.equal(
    (await completedContext.tasks.commitCareerTaskWrite(completeReceipt)).outcome,
    "saved",
  );
  assert.equal(row(completedContext.database, "career_tasks", "task-complete").status, "done");
  assert.equal(
    completedContext.database.selectValue(`SELECT COUNT(*)
      FROM career_lifecycle_events WHERE id=?`, [completeReceipt.operationId]),
    1,
  );
  assert.deepEqual(completedContext.state.broadcasts, ["career-task-completed"]);
});

for (const [name, prepareReceipt, serviceName] of [
  [
    "lifecycle",
    (context) => prepareLifecycle(
      context,
      { kind: "archive", jobId: "job-active" },
      "pause",
    ),
    "lifecycle",
  ],
  ["task", (context) => prepareTaskComplete(context), "tasks"],
]) {
  test(`${name} response loss settles from immutable proof and retry stays idempotent`, async (t) => {
    const context = fixture();
    t.after(() => context.close());
    const receipt = await prepareReceipt(context);
    context.state.batchFault = "after";
    context.state.queryFailuresAfterBatch = 1;
    const service = context[serviceName];
    const commit = serviceName === "lifecycle"
      ? service.commitCareerLifecycleWrite
      : service.commitCareerTaskWrite;
    const inspect = serviceName === "lifecycle"
      ? service.inspectCareerLifecycleWrite
      : service.inspectCareerTaskWrite;
    const uncertain = await commit(receipt);
    assert.equal(uncertain.outcome, "outcome_uncertain");
    assert.deepEqual(
      context.state.broadcasts,
      [],
      "an uncertain response cannot announce success",
    );
    assert.equal(context.state.batchCalls, 1);
    if (serviceName === "lifecycle") {
      context.database.exec(
        "UPDATE career_jobs SET note='edited after durable proof' WHERE id='job-active'",
      );
    } else {
      context.database.exec(
        "UPDATE career_tasks SET title='edited after durable proof' WHERE id='task-complete'",
      );
    }
    assert.equal(await inspect(receipt), "exact_saved");
    assert.equal((await commit(receipt)).outcome, "already_saved");
    assert.equal(context.state.batchCalls, 1);
    assert.equal(
      context.database.selectValue(
        "SELECT COUNT(*) FROM career_write_operations WHERE operation_id=?",
        [receipt.operationId],
      ),
      1,
    );
    assert.equal(context.state.broadcasts.length, 1);
  });
}

test("a definite precommit failure keeps the same task receipt retryable", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const receipt = await prepareTaskComplete(context);
  context.state.batchFault = "before";
  await assert.rejects(
    context.tasks.commitCareerTaskWrite(receipt),
    (error) => error instanceof marker.CareerWriteError &&
      error.code === "write_failed" && error.receipt.operationId === receipt.operationId,
  );
  assert.deepEqual(context.state.broadcasts, []);
  assert.equal(await context.tasks.inspectCareerTaskWrite(receipt), "expected");
  assert.equal((await context.tasks.commitCareerTaskWrite(receipt)).outcome, "saved");
});

test("generation id plus sequence blocks G1 to G2 to G1 ABA for both services", async (t) => {
  const lifecycleContext = fixture();
  t.after(() => lifecycleContext.close());
  const lifecycleReceipt = await prepareLifecycle(lifecycleContext, {
    kind: "stage",
    jobId: "job-active",
    nextStageId: "stage-next",
  }, "keep");
  lifecycleContext.state.generationId = GENERATION_TWO;
  lifecycleContext.state.generationSequence = 2;
  assert.equal(
    await lifecycleContext.lifecycle.inspectCareerLifecycleWrite(lifecycleReceipt),
    "changed",
  );
  lifecycleContext.state.generationId = GENERATION_ONE;
  lifecycleContext.state.generationSequence = 3;
  assert.equal(
    (await lifecycleContext.lifecycle.commitCareerLifecycleWrite(lifecycleReceipt)).outcome,
    "changed",
  );
  assert.equal(lifecycleContext.state.batchCalls, 0);

  const taskContext = fixture();
  t.after(() => taskContext.close());
  const taskReceipt = await prepareTaskComplete(taskContext);
  taskContext.state.generationId = GENERATION_TWO;
  taskContext.state.generationSequence = 2;
  taskContext.state.generationId = GENERATION_ONE;
  taskContext.state.generationSequence = 3;
  assert.equal(
    (await taskContext.tasks.commitCareerTaskWrite(taskReceipt)).outcome,
    "changed",
  );
  assert.equal(taskContext.state.batchCalls, 0);
  assert.deepEqual(taskContext.state.broadcasts, []);
});

test("deleted lifecycle facts are symmetrically changed, not storage-unknown", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const receipt = await prepareLifecycle(context, {
    kind: "archive",
    jobId: "job-active",
  }, "pause");
  context.database.exec("DELETE FROM career_jobs WHERE id='job-active'");
  assert.equal(
    await context.lifecycle.inspectCareerLifecycleWrite(receipt),
    "changed",
  );
  assert.equal(
    (await context.lifecycle.commitCareerLifecycleWrite(receipt)).outcome,
    "changed",
  );
  assert.equal(context.state.batchCalls, 0);
  assert.deepEqual(context.state.broadcasts, []);

  const stageContext = fixture();
  t.after(() => stageContext.close());
  const stageReceipt = await prepareLifecycle(stageContext, {
    kind: "stage",
    jobId: "job-active",
    nextStageId: "stage-next",
  }, "keep");
  stageContext.database.exec("DELETE FROM career_stages WHERE id='stage-next'");
  assert.equal(
    await stageContext.lifecycle.inspectCareerLifecycleWrite(stageReceipt),
    "changed",
  );
  assert.equal(
    (await stageContext.lifecycle.commitCareerLifecycleWrite(stageReceipt)).outcome,
    "changed",
  );
  assert.equal(stageContext.state.batchCalls, 0);
  assert.deepEqual(stageContext.state.broadcasts, []);
});

test("lifecycle full-row CAS catches an unrelated job edit without partial writes", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const receipt = await prepareLifecycle(context, {
    kind: "stage",
    jobId: "job-active",
    nextStageId: "stage-terminal",
  }, "pause");
  context.state.beforeBatch = () => {
    context.database.exec(
      "UPDATE career_jobs SET source='referral' WHERE id='job-active'",
    );
  };
  const result = await context.lifecycle.commitCareerLifecycleWrite(receipt);
  assert.equal(result.outcome, "changed");
  assert.deepEqual(
    context.database.selectObject(`SELECT source,stage_id,ended_at
      FROM career_jobs WHERE id='job-active'`),
    { source: "referral", stage_id: "stage-active", ended_at: null },
  );
  assert.equal(row(context.database, "career_tasks", "task-active").status, "todo");
  assert.equal(
    context.database.selectValue(
      "SELECT COUNT(*) FROM career_write_operations WHERE operation_id=?",
      [receipt.operationId],
    ),
    0,
  );
  assert.equal(
    context.database.selectValue(
      "SELECT COUNT(*) FROM career_lifecycle_events WHERE id=?",
      [receipt.operationId],
    ),
    0,
  );
  assert.deepEqual(context.state.broadcasts, []);
});

test("lifecycle exact-set CAS catches an inserted child and rolls back every mutation", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const receipt = await prepareLifecycle(context, {
    kind: "archive",
    jobId: "job-active",
  }, "pause");
  context.state.beforeBatch = () => {
    context.database.exec(`INSERT INTO career_tasks(
      id,job_id,contact_id,title,due_at,kind,priority,status,created_at,
      updated_at,canceled_at,cancellation_reason,lifecycle_previous_status,
      lifecycle_operation_id
    ) VALUES('task-concurrent','job-active',NULL,'Concurrent','${FUTURE_TIME}',
      '跟进',1,'todo','${BASE_TIME}','${BASE_TIME}',NULL,NULL,NULL,NULL)`);
  };
  const result = await context.lifecycle.commitCareerLifecycleWrite(receipt);
  assert.equal(result.outcome, "changed");
  assert.equal(row(context.database, "career_jobs", "job-active").archived, 0);
  assert.equal(row(context.database, "career_tasks", "task-active").status, "todo");
  assert.equal(row(context.database, "career_tasks", "task-concurrent").status, "todo");
  assert.equal(
    context.database.selectValue("SELECT COUNT(*) FROM career_write_operations"),
    0,
  );
  assert.equal(
    context.database.selectValue(
      "SELECT COUNT(*) FROM career_lifecycle_events WHERE id LIKE 'career-lifecycle-operation-%'",
    ),
    0,
  );
});

test("chunked CAS commits over 1000 affected events and rolls back stale peers", async (t) => {
  function insertAffectedTasks(context) {
    context.database.exec(`WITH RECURSIVE sequence(value) AS (
      VALUES(1)
      UNION ALL SELECT value + 1 FROM sequence WHERE value < 1001
    )
    INSERT INTO career_tasks(
      id,job_id,contact_id,title,due_at,kind,priority,status,created_at,
      updated_at,canceled_at,cancellation_reason,lifecycle_previous_status,
      lifecycle_operation_id
    ) SELECT printf('bulk-task-%04d',value),'job-active',NULL,
      printf('Bulk task %04d',value),'${FUTURE_TIME}','跟进',1,'todo',
      '${BASE_TIME}','${BASE_TIME}',NULL,NULL,NULL,NULL FROM sequence`);
  }

  const saved = fixture();
  t.after(() => saved.close());
  insertAffectedTasks(saved);
  const savedReceipt = await prepareLifecycle(saved, {
    kind: "archive",
    jobId: "job-active",
  }, "pause");
  assert.ok(
    savedReceipt.after.events.filter(({ id }) =>
      id.includes("_task_bulk-task-")).length > 1000,
  );
  assert.equal(
    (await saved.lifecycle.commitCareerLifecycleWrite(savedReceipt)).outcome,
    "saved",
  );
  assert.equal(
    saved.database.selectValue(`SELECT COUNT(*) FROM career_tasks
      WHERE id LIKE 'bulk-task-%' AND status='canceled'`),
    1001,
  );
  assert.equal(
    saved.database.selectValue(`SELECT COUNT(*) FROM career_lifecycle_events
      WHERE id LIKE '%_task_bulk-task-%'`),
    1001,
  );

  const stale = fixture();
  t.after(() => stale.close());
  insertAffectedTasks(stale);
  const staleReceipt = await prepareLifecycle(stale, {
    kind: "archive",
    jobId: "job-active",
  }, "pause");
  stale.state.beforeBatch = () => {
    stale.database.exec(
      "UPDATE career_tasks SET kind='peer edit' WHERE id='bulk-task-1000'",
    );
  };
  assert.equal(
    (await stale.lifecycle.commitCareerLifecycleWrite(staleReceipt)).outcome,
    "changed",
  );
  assert.equal(row(stale.database, "career_jobs", "job-active").archived, 0);
  assert.deepEqual(
    stale.database.selectObject(`SELECT kind,status FROM career_tasks
      WHERE id='bulk-task-1000'`),
    { kind: "peer edit", status: "todo" },
  );
  assert.equal(
    stale.database.selectValue(`SELECT COUNT(*) FROM career_tasks
      WHERE id LIKE 'bulk-task-%' AND status<>'todo'`),
    0,
  );
  assert.equal(
    stale.database.selectValue(`SELECT COUNT(*) FROM career_lifecycle_events
      WHERE id LIKE '%_task_bulk-task-%'`),
    0,
  );
  assert.equal(stale.database.selectValue("SELECT COUNT(*) FROM career_write_operations"), 0);
  assert.deepEqual(stale.state.broadcasts, []);
});

test("task full-row and active-parent CAS never overwrite concurrent edits", async (t) => {
  const completeContext = fixture();
  t.after(() => completeContext.close());
  const completeReceipt = await prepareTaskComplete(completeContext);
  completeContext.state.beforeBatch = () => {
    completeContext.database.exec(
      "UPDATE career_tasks SET kind='concurrent edit' WHERE id='task-complete'",
    );
  };
  assert.equal(
    (await completeContext.tasks.commitCareerTaskWrite(completeReceipt)).outcome,
    "changed",
  );
  assert.deepEqual(
    completeContext.database.selectObject(`SELECT kind,status
      FROM career_tasks WHERE id='task-complete'`),
    { kind: "concurrent edit", status: "todo" },
  );
  assert.equal(
    completeContext.database.selectValue("SELECT COUNT(*) FROM career_write_operations"),
    0,
  );

  const createContext = fixture();
  t.after(() => createContext.close());
  const createReceipt = await createContext.tasks.prepareCareerTaskCreate({
    title: "New task",
    jobId: "job-active",
  }, taskCreateContext(createContext));
  createContext.state.beforeBatch = () => {
    createContext.database.exec(
      "UPDATE career_jobs SET note='concurrent parent edit' WHERE id='job-active'",
    );
  };
  assert.equal(
    (await createContext.tasks.commitCareerTaskWrite(createReceipt)).outcome,
    "changed",
  );
  assert.equal(
    createContext.database.selectValue("SELECT COUNT(*) FROM career_tasks WHERE id=?", [
      createReceipt.after.task.id,
    ]),
    0,
  );
});

test("prepare rechecks preview facts under the lock and returns a fresh changed preview", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const intent = {
    kind: "stage",
    jobId: "job-active",
    nextStageId: "stage-terminal",
  };
  const preview = await context.lifecycle.previewCareerLifecycleWrite(
    intent,
    displayed(context, intent.jobId, intent.nextStageId),
  );
  context.database.exec(
    "UPDATE career_tasks SET title='changed after preview' WHERE id='task-active'",
  );
  const prepared = await context.lifecycle.prepareCareerLifecycleWrite(preview, "pause");
  assert.equal(prepared.outcome, "changed");
  assert.equal(prepared.preview.authorization.tasks.find(
    ({ id }) => id === "task-active",
  ).title, "changed after preview");
  assert.equal(context.state.batchCalls, 0);
});

test("tampered and semantically forged receipts fail before any storage call", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const receipt = await prepareTaskComplete(context);
  const tampered = structuredClone(receipt);
  tampered.after.task.title = "tampered";
  context.state.lockCalls = 0;
  context.state.queryCalls = 0;
  assert.equal(await context.tasks.inspectCareerTaskWrite(tampered), "invalid_receipt");
  assert.deepEqual([context.state.lockCalls, context.state.queryCalls], [0, 0]);

  const forged = structuredClone(receipt);
  forged.after.task.job_id = "job-archived";
  const forgedWithHash = await rehash(forged);
  assert.equal(
    await context.tasks.inspectCareerTaskWrite(forgedWithHash),
    "invalid_receipt",
  );
  await assert.rejects(
    context.tasks.commitCareerTaskWrite(forgedWithHash),
    (error) => error instanceof marker.CareerWriteError &&
      error.code === "invalid_receipt",
  );
  assert.deepEqual(
    [context.state.lockCalls, context.state.queryCalls, context.state.batchCalls],
    [0, 0, 0],
  );

  const invalidPriorVersion = structuredClone(receipt);
  invalidPriorVersion.before.task.updated_at = "not-a-time";
  assert.equal(
    await context.tasks.inspectCareerTaskWrite(
      await rehash(invalidPriorVersion),
    ),
    "invalid_receipt",
  );

  const lifecycleReceipt = await prepareLifecycle(context, {
    kind: "archive",
    jobId: "job-active",
  }, "keep");
  const regressiveLifecycle = structuredClone(lifecycleReceipt);
  const regressiveAt = "2026-08-19T01:00:00.000Z";
  regressiveLifecycle.operationAt = regressiveAt;
  regressiveLifecycle.after = JSON.parse(
    JSON.stringify(regressiveLifecycle.after).replaceAll(
      lifecycleReceipt.operationAt,
      regressiveAt,
    ),
  );
  context.state.lockCalls = 0;
  context.state.queryCalls = 0;
  assert.equal(
    await context.lifecycle.inspectCareerLifecycleWrite(
      await rehash(regressiveLifecycle),
    ),
    "invalid_receipt",
  );
  assert.equal(context.state.lockCalls, 0);

  const futurePurpose = structuredClone(receipt);
  futurePurpose.purpose = "career-contact-write";
  const futurePurposeWithHash = await rehash(futurePurpose);
  assert.equal(
    await context.tasks.inspectCareerTaskWrite(futurePurposeWithHash),
    "invalid_receipt",
  );
  assert.equal(context.state.lockCalls, 0);
});

test("exported receipt guards enforce exact keys and frozen current purposes", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const taskReceipt = await prepareTaskComplete(context);
  assert.equal(taskWrites.isCareerTaskWriteReceipt(taskReceipt), true);
  assert.equal(taskWrites.isCareerTaskWriteReceipt({
    ...taskReceipt,
    unexpected: true,
  }), false);
  const missingTaskProjection = structuredClone(taskReceipt);
  delete missingTaskProjection.after.event;
  assert.equal(
    taskWrites.isCareerTaskWriteReceipt(missingTaskProjection),
    false,
  );
  assert.equal(taskWrites.isCareerTaskWriteReceipt({
    ...taskReceipt,
    purpose: "career-contact-write",
  }), false);

  const lifecycleReceipt = await prepareLifecycle(context, {
    kind: "stage",
    jobId: "job-active",
    nextStageId: "stage-next",
  }, "keep");
  assert.equal(
    lifecycle.isCareerLifecycleWriteReceipt(lifecycleReceipt),
    true,
  );
  assert.equal(lifecycle.isCareerLifecycleWriteReceipt({
    ...lifecycleReceipt,
    unexpected: true,
  }), false);
  const missingLifecycleProjection = structuredClone(lifecycleReceipt);
  delete missingLifecycleProjection.after.job;
  assert.equal(
    lifecycle.isCareerLifecycleWriteReceipt(missingLifecycleProjection),
    false,
  );
});

test("tampered lifecycle preview projections are rejected before reacquiring the lock", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const intent = { kind: "archive", jobId: "job-active" };
  const preview = await context.lifecycle.previewCareerLifecycleWrite(
    intent,
    displayed(context, intent.jobId),
  );
  const tampered = structuredClone(preview);
  tampered.job.company = "Misleading company";
  context.state.lockCalls = 0;
  await assert.rejects(
    context.lifecycle.prepareCareerLifecycleWrite(tampered, "pause"),
    (error) => error instanceof marker.CareerWriteError &&
      error.code === "invalid_input",
  );
  assert.equal(context.state.lockCalls, 0);
});

test("lifecycle after-projection forgery and oversized receipts are rejected locally", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const receipt = await prepareLifecycle(context, {
    kind: "archive",
    jobId: "job-active",
  }, "keep");
  const forged = structuredClone(receipt);
  forged.after.job.note = "forged overwrite";
  const forgedWithHash = await rehash(forged);
  context.state.lockCalls = 0;
  assert.equal(
    await context.lifecycle.inspectCareerLifecycleWrite(forgedWithHash),
    "invalid_receipt",
  );
  assert.equal(context.state.lockCalls, 0);

  const oversized = structuredClone(receipt);
  oversized.before.job.note = "x".repeat(
    marker.CAREER_WRITE_RECEIPT_MAX_JSON_BYTES + 1,
  );
  assert.equal(
    await context.lifecycle.inspectCareerLifecycleWrite(oversized),
    "invalid_receipt",
  );
  assert.equal(context.state.lockCalls, 0);
});

test("broadcast failure cannot reverse a durable commit", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const receipt = await prepareTaskComplete(context);
  context.state.broadcastThrows = true;
  assert.equal((await context.tasks.commitCareerTaskWrite(receipt)).outcome, "saved");
  assert.equal(row(context.database, "career_tasks", "task-complete").status, "done");
  assert.equal(
    await context.tasks.inspectCareerTaskWrite(receipt),
    "exact_saved",
  );
});

test("task create boundary keeps contact semantics explicitly out of this slice", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  await assert.rejects(
    context.tasks.prepareCareerTaskCreate({
      title: "No implicit contact write",
      jobId: "job-active",
      contactId: "contact-out-of-scope",
    }, taskCreateContext(context)),
    (error) => error instanceof marker.CareerWriteError &&
      error.code === "invalid_input",
  );
  assert.equal(context.state.batchCalls, 0);
});

test("lifecycle intents reject unknown executable fields", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  await assert.rejects(
    context.lifecycle.previewCareerLifecycleWrite({
      kind: "archive",
      jobId: "job-active",
      futureAction: "contact-import",
    }, displayed(context, "job-active")),
    (error) => error instanceof marker.CareerWriteError &&
      error.code === "invalid_input",
  );
  assert.equal(context.state.queryCalls, 0, "no business facts are read");
  assert.equal(context.state.batchCalls, 0);
});
