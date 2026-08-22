import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const BASE_TIME = "2026-08-20T01:00:00.000Z";
const OPERATION_TIME = "2026-08-22T02:00:00.000Z";
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
  source,
  schemaSource,
  rawServiceJavaScript,
  schemaJavaScript,
  rawBackupPlanJavaScript,
] =
  await Promise.all([
    readFile(new URL("lib/career/core-writes.ts", projectRoot), "utf8"),
    readFile(new URL("lib/schemas/zhiji.ts", projectRoot), "utf8"),
    transpile("lib/career/core-writes.ts"),
    transpile("lib/schemas/zhiji.ts"),
    transpile("lib/career/backup-plan.ts"),
  ]);

const dependencies = {
  "@/lib/local-db/client": moduleUrl(`
    export const localDb = {
      query(){ throw new Error("default runtime not used"); },
      batch(){ throw new Error("default runtime not used"); },
      currentGeneration(){ throw new Error("default runtime not used"); }
    };
  `),
  "./lock": moduleUrl(`
    export function broadcastCareerDataChanged(){}
    export function withCareerWriteLock(task){ return task(); }
  `),
};
let serviceJavaScript = rawServiceJavaScript;
for (const [specifier, url] of Object.entries(dependencies)) {
  serviceJavaScript = serviceJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const schemaUrl = moduleUrl(schemaJavaScript);
const backupPlanJavaScript = rawBackupPlanJavaScript.replaceAll(
  '"../schemas/zhiji"',
  `"${schemaUrl}"`,
);
const [core, schema, backupPlan, sqlite3] = await Promise.all([
  import(moduleUrl(serviceJavaScript)),
  import(schemaUrl),
  import(moduleUrl(backupPlanJavaScript)),
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

function fixture() {
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE career_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL CHECK(length(applied_at)>0)
    );
    INSERT INTO career_schema_migrations(version,name,applied_at) VALUES
      (1,'initial-career-runtime','${BASE_TIME}'),
      (2,'contact-history','${BASE_TIME}'),
      (3,'reversible-lifecycle','${BASE_TIME}');
    CREATE TABLE career_stages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      position INTEGER NOT NULL,
      is_terminal INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE career_jobs (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '手动记录',
      source_url TEXT NOT NULL DEFAULT '',
      stage_id TEXT NOT NULL REFERENCES career_stages(id),
      priority INTEGER NOT NULL DEFAULT 1,
      salary TEXT NOT NULL DEFAULT '',
      work_mode TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      applied_at TEXT,
      deadline TEXT,
      contact_name TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      ended_at TEXT,
      archived_operation_id TEXT,
      ended_operation_id TEXT
    );
    CREATE TABLE career_interviews (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES career_jobs(id) ON DELETE CASCADE,
      round_name TEXT NOT NULL,
      interview_type TEXT NOT NULL DEFAULT '视频面试',
      scheduled_at TEXT,
      duration INTEGER NOT NULL DEFAULT 45,
      interviewer TEXT NOT NULL DEFAULT '',
      meeting_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'scheduled',
      summary TEXT NOT NULL DEFAULT '',
      raw_notes TEXT NOT NULL DEFAULT '',
      questions_json TEXT NOT NULL DEFAULT '[]',
      reflection TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      canceled_at TEXT,
      cancellation_reason TEXT,
      lifecycle_previous_status TEXT,
      lifecycle_operation_id TEXT
    );
    CREATE TABLE career_activity (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  execute(database, schema.ZHIJI_V4_SCHEMA_MIGRATION_STATEMENTS);
  database.exec(`
    INSERT INTO career_stages(id,name,color,position,is_terminal,hidden) VALUES
      ('stage_saved','收藏','#888',0,0,0),
      ('stage_terminal','已结束','#999',1,1,0),
      ('stage_hidden','隐藏','#777',2,0,1);
    INSERT INTO career_jobs(
      id,company,role,location,source,source_url,stage_id,priority,salary,
      work_mode,description,applied_at,deadline,contact_name,note,tags,
      created_at,updated_at,archived,position,archived_at,ended_at,
      archived_operation_id,ended_operation_id
    ) VALUES
      ('job-active','Arc','Designer','Remote','官网','https://example.com',
       'stage_saved',2,'100','远程','Original description',NULL,NULL,'',
       'Original note','design','${BASE_TIME}','${BASE_TIME}',0,0,
       NULL,NULL,NULL,NULL),
      ('job-ended','Done Co','Engineer','','手动记录','','stage_terminal',1,
       '','','',NULL,NULL,'','','','${BASE_TIME}','${BASE_TIME}',0,0,
       NULL,'${BASE_TIME}',NULL,'lifecycle-ended'),
      ('job-archived','Archive Co','Researcher','','手动记录','',
       'stage_terminal',1,'','','',NULL,NULL,'','','','${BASE_TIME}',
       '${BASE_TIME}',1,0,'${BASE_TIME}','${BASE_TIME}',
       'lifecycle-archive','lifecycle-ended');
    INSERT INTO career_interviews(
      id,job_id,round_name,interview_type,scheduled_at,duration,interviewer,
      meeting_url,status,summary,raw_notes,questions_json,reflection,
      created_at,updated_at,canceled_at,cancellation_reason,
      lifecycle_previous_status,lifecycle_operation_id
    ) VALUES
      ('interview-active','job-active','一面','视频面试',
       '2026-08-24T02:00:00.000Z',45,'Lee','https://meet.example.com',
       'scheduled','Before summary','Before raw','[]','Before reflection',
       '${BASE_TIME}','${BASE_TIME}',NULL,NULL,NULL,NULL),
      ('interview-paused','job-archived','归档面试','视频面试',
       '2026-08-25T02:00:00.000Z',60,'Kai','',
       'canceled','Paused summary','Paused raw','[]','Paused reflection',
       '${BASE_TIME}','${BASE_TIME}','${BASE_TIME}','job_archived',
       'scheduled','lifecycle-archive');
  `);

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
    generationId: GENERATION_ONE,
    generationSequence: 1,
    uuidIndex: 1,
    now: Date.parse(OPERATION_TIME),
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
      const rows = database.selectObjects(sql, params);
      return { rows };
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
      return state.now;
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
    },
  };
  return {
    database,
    state,
    runtime,
    service: core.createCareerCoreWriteStorageService(runtime),
    close() { database.close(); },
  };
}

function stageExpected(set, stageId = "stage_saved") {
  const stage = set.stages.find(({ id }) => id === stageId);
  assert.ok(stage);
  return {
    generationId: set.generationId,
    generationSequence: set.generationSequence,
    stage,
  };
}

function jobExpected(set, jobId = "job-active") {
  const job = set.jobs.find(({ id }) => id === jobId);
  assert.ok(job);
  const stage = set.stages.find(({ id }) => id === job.stage_id);
  assert.ok(stage);
  return {
    generationId: set.generationId,
    generationSequence: set.generationSequence,
    job,
    stage,
  };
}

function interviewExpected(set, interviewId = "interview-active") {
  const interview = set.interviews.find(({ id }) => id === interviewId);
  assert.ok(interview);
  const parent = jobExpected(set, interview.job_id);
  return { ...parent, interview };
}

const jobCreateInput = {
  company: "Linear",
  role: "Product Designer",
  location: "Remote",
  source: "官网",
  sourceUrl: "https://linear.app/careers",
  priority: 2,
  salary: "120",
  workMode: "远程",
  description: "A real role",
  deadline: "2026-08-30T02:00:00.000Z",
  note: "Check scope",
  tags: "design, remote",
};

const jobUpdateInput = {
  company: "Arc Updated",
  role: "Senior Designer",
  location: "Singapore",
  salary: "200",
  workMode: "混合办公",
  description: "Updated description",
  deadline: "2026-09-01T02:00:00.000Z",
  note: "Updated note",
  tags: "design, senior",
};

const interviewCreateInput = {
  roundName: "技术二面",
  interviewType: "视频面试",
  scheduledAt: "2026-08-28T02:00:00.000Z",
  duration: 60,
  interviewer: "Morgan",
  meetingUrl: "https://meet.example.com/second",
};

const interviewUpdateInput = {
  status: "completed",
  summary: "Updated summary",
  rawNotes: "Updated raw",
  questions: [{ question: "Why?", answer: "Because.", note: "Clear" }],
  reflection: "Updated reflection",
};

async function prepare(context, kind) {
  const set = await context.service.loadCareerCoreWriteExpectedSet();
  switch (kind) {
    case "stage-rename":
      return context.service.prepareCareerStageRename(
        "稍后跟进",
        stageExpected(set),
      );
    case "job-create":
      return context.service.prepareCareerJobCreate(
        jobCreateInput,
        stageExpected(set),
      );
    case "job-update":
      return context.service.prepareCareerJobUpdate(
        jobUpdateInput,
        jobExpected(set),
      );
    case "interview-create":
      return context.service.prepareCareerInterviewCreate(
        interviewCreateInput,
        jobExpected(set),
      );
    case "interview-update":
      return context.service.prepareCareerInterviewUpdate(
        interviewUpdateInput,
        interviewExpected(set),
      );
    default:
      throw new Error(`unknown kind ${kind}`);
  }
}

test("v4 schema owns an immutable, payload-free core write marker", () => {
  assert.equal(schema.ZHIJI_USER_VERSION, 4);
  assert.equal(schema.ZHIJI_V4_MIGRATION_NAME, "career-core-write-recovery");
  assert.match(schemaSource, /CREATE TABLE career_core_write_operations/);
  assert.match(schemaSource, /projection_sha256 NOT GLOB '\*\[\^0-9a-f\]\*'/);
  assert.doesNotMatch(source, /DELETE\s+FROM\s+career_core_write_operations/i);
  assert.doesNotMatch(schemaSource, /career_core_write_operations[\s\S]{0,800}\bpayload\b/i);
  assert.match(source, /withRequiredCareerCoreWriteLock/);
  assert.match(source, /navigator[\s\S]{0,100}locks/);
});

test("exact v0 through v4 runtime and restore plans migrate to canonical v4", () => {
  function sourceDatabase(version) {
    const database = new sqlite3.oo1.DB(":memory:", "c");
    const apply = (statements) => execute(database, statements);
    apply(schema.ZHIJI_V1_SCHEMA_STATEMENTS);
    if (version >= 2) apply(schema.ZHIJI_V2_SCHEMA_MIGRATION_STATEMENTS);
    if (version >= 3) apply(schema.ZHIJI_V3_SCHEMA_MIGRATION_STATEMENTS);
    if (version >= 4) apply(schema.ZHIJI_V4_SCHEMA_MIGRATION_STATEMENTS);
    database.exec(`PRAGMA application_id=${version === 0
      ? 0
      : schema.ZHIJI_APPLICATION_ID}`);
    database.exec(`PRAGMA user_version=${version}`);
    if (version === 4) {
      database.exec(`INSERT INTO career_core_write_operations(
        operation_id,purpose,receipt_version,kind,entity_id,
        projection_sha256,operation_at
      ) VALUES(
        'career-core-operation-40000000-0000-4000-8000-000000000004',
        'career-core-write',1,'stage-rename','stage_saved',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '${BASE_TIME}'
      )`);
    }
    return database;
  }

  function assertCanonical(database, version) {
      assert.equal(database.selectValue("PRAGMA user_version"), 4);
      assert.equal(
        database.selectValue("PRAGMA application_id"),
        schema.ZHIJI_APPLICATION_ID,
      );
      assert.equal(database.selectValue(`SELECT COUNT(*) FROM sqlite_schema
        WHERE type='table' AND name='career_core_write_operations'`), 1);
      assert.equal(database.selectValue(
        "SELECT COUNT(*) FROM career_core_write_operations",
      ), version === 4 ? 1 : 0);
      assert.deepEqual(
        database.selectObjects(`SELECT version,name
          FROM career_schema_migrations ORDER BY version`)
          .map((row) => ({ ...row })),
        [
          { version: 1, name: "initial-career-runtime" },
          { version: 2, name: "contact-history" },
          { version: 3, name: "reversible-lifecycle" },
          { version: 4, name: "career-core-write-recovery" },
        ],
      );
      execute(database, backupPlan.createCareerSchemaGuardStatements(4));
  }

  for (const version of [0, 1, 2, 3, 4]) {
    const planners = [
      () => backupPlan.createCareerRuntimeUpgradeStatements(version),
      () => backupPlan.createCompleteCareerRestoreStatements([], version),
      () => backupPlan.createLegacyCareerRestoreStatements(version),
    ];
    for (const plan of planners) {
      const database = sourceDatabase(version);
      try {
        execute(database, plan());
        assertCanonical(database, version);
      } finally {
        database.close();
      }
    }
  }
});

test("expected set and all five prepare APIs are read-only and seal stable facts", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const set = await context.service.loadCareerCoreWriteExpectedSet();
  assert.deepEqual(set.stages.map(({ id }) => id), [
    "stage_hidden", "stage_saved", "stage_terminal",
  ]);
  const receipts = await Promise.all([
    context.service.prepareCareerStageRename("稍后跟进", stageExpected(set)),
    context.service.prepareCareerJobCreate(jobCreateInput, stageExpected(set)),
    context.service.prepareCareerJobUpdate(jobUpdateInput, jobExpected(set)),
    context.service.prepareCareerInterviewCreate(interviewCreateInput, jobExpected(set)),
    context.service.prepareCareerInterviewUpdate(
      interviewUpdateInput,
      interviewExpected(set),
    ),
  ]);
  assert.equal(context.state.batchCalls, 0);
  assert.equal(context.database.selectValue(
    "SELECT COUNT(*) FROM career_core_write_operations",
  ), 0);
  assert.deepEqual(receipts.map(({ kind }) => kind), [
    "stage-rename", "job-create", "job-update", "interview-create",
    "interview-update",
  ]);
  for (const receipt of receipts) {
    assert.equal(core.isCareerCoreWriteReceipt(receipt), true);
    assert.equal(receipt.generationId, GENERATION_ONE);
    assert.equal(receipt.generationSequence, 1);
    assert.equal(receipt.operationAt, OPERATION_TIME);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(receipt)));
  }
  const created = receipts[1];
  assert.match(created.after.job.id, /^job_30000000-/);
  assert.match(created.after.activity.id, /^activity_30000000-/);
  assert.equal(created.after.job.created_at, created.operationAt);
  assert.equal(created.after.activity.created_at, created.operationAt);
});

for (const kind of [
  "stage-rename",
  "job-create",
  "job-update",
  "interview-create",
  "interview-update",
]) {
  test(`${kind} commits one transaction and becomes exactly inspectable`, async (t) => {
    const context = fixture();
    t.after(() => context.close());
    const receipt = await prepare(context, kind);
    const result = await context.service.commitCareerCoreWrite(receipt);
    assert.equal(result.outcome, "saved");
    assert.equal(context.state.batchCalls, 1);
    assert.equal(context.database.selectValue(
      "SELECT COUNT(*) FROM career_core_write_operations",
    ), 1);
    assert.equal(
      await context.service.inspectCareerCoreWrite(receipt),
      "exact_saved",
    );
    assert.deepEqual(
      context.database.selectObject(`SELECT purpose,receipt_version,kind,
        entity_id,projection_sha256,operation_at
        FROM career_core_write_operations`),
      {
        purpose: receipt.purpose,
        receipt_version: receipt.version,
        kind: receipt.kind,
        entity_id: result.entityId,
        projection_sha256: receipt.projectionSha256,
        operation_at: receipt.operationAt,
      },
    );
  });
}

test("a lost response, concurrent retry, and later edits never duplicate or erase proof", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const receipt = await prepare(context, "job-create");
  context.state.batchFault = "after";
  const lost = await context.service.commitCareerCoreWrite(receipt);
  assert.equal(lost.outcome, "saved");
  assert.equal(await context.service.inspectCareerCoreWrite(receipt), "exact_saved");

  context.database.exec({
    sql: "UPDATE career_jobs SET note='later edit' WHERE id=?",
    bind: [receipt.after.job.id],
  });
  assert.equal(await context.service.inspectCareerCoreWrite(receipt), "exact_saved");
  assert.equal(
    (await context.service.commitCareerCoreWrite(receipt)).outcome,
    "already_saved",
  );
  assert.equal(context.state.batchCalls, 1);

  const second = fixture();
  t.after(() => second.close());
  const concurrentReceipt = await prepare(second, "interview-create");
  const outcomes = await Promise.all([
    second.service.commitCareerCoreWrite(concurrentReceipt),
    second.service.commitCareerCoreWrite(concurrentReceipt),
  ]);
  assert.deepEqual(
    outcomes.map(({ outcome }) => outcome).sort(),
    ["already_saved", "saved"],
  );
  assert.equal(second.state.batchCalls, 1);
  assert.equal(second.state.maxActiveLocks, 1);
});

test("tampered receipts fail before the lock or any storage call", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const receipt = await prepare(context, "interview-update");
  const forged = structuredClone(receipt);
  forged.after.interview.summary = "forged private overwrite";
  context.state.lockCalls = 0;
  context.state.queryCalls = 0;
  context.state.batchCalls = 0;
  assert.equal(await context.service.inspectCareerCoreWrite(forged), "invalid_receipt");
  await assert.rejects(
    context.service.commitCareerCoreWrite(forged),
    (error) => error instanceof core.CareerCoreWriteError &&
      error.code === "invalid_receipt",
  );
  assert.deepEqual(
    [context.state.lockCalls, context.state.queryCalls, context.state.batchCalls],
    [0, 0, 0],
  );
});

test("G1 to G2 to G1 sequence ABA blocks every mutation", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const receipt = await prepare(context, "stage-rename");
  context.state.generationId = GENERATION_TWO;
  context.state.generationSequence = 2;
  assert.equal(await context.service.inspectCareerCoreWrite(receipt), "changed");
  context.state.generationId = GENERATION_ONE;
  context.state.generationSequence = 3;
  const result = await context.service.commitCareerCoreWrite(receipt);
  assert.equal(result.outcome, "changed");
  assert.equal(context.state.batchCalls, 0);
  assert.equal(
    context.database.selectValue("SELECT name FROM career_stages WHERE id='stage_saved'"),
    "收藏",
  );
});

test("create transactions recheck exact active parents after preflight", async (t) => {
  const jobContext = fixture();
  t.after(() => jobContext.close());
  const jobReceipt = await prepare(jobContext, "job-create");
  jobContext.state.beforeBatch = () => {
    jobContext.database.exec(
      "UPDATE career_stages SET hidden=1 WHERE id='stage_saved'",
    );
  };
  const jobResult = await jobContext.service.commitCareerCoreWrite(jobReceipt);
  assert.equal(jobResult.outcome, "changed");
  assert.equal(jobContext.database.selectValue(
    "SELECT COUNT(*) FROM career_jobs WHERE id=?",
    [jobReceipt.after.job.id],
  ), 0);
  assert.equal(jobContext.database.selectValue(
    "SELECT COUNT(*) FROM career_core_write_operations",
  ), 0);

  const interviewContext = fixture();
  t.after(() => interviewContext.close());
  const interviewReceipt = await prepare(interviewContext, "interview-create");
  interviewContext.state.beforeBatch = () => {
    interviewContext.database.exec(
      "UPDATE career_jobs SET archived=1 WHERE id='job-active'",
    );
  };
  const interviewResult = await interviewContext.service.commitCareerCoreWrite(
    interviewReceipt,
  );
  assert.equal(interviewResult.outcome, "changed");
  assert.equal(interviewContext.database.selectValue(
    "SELECT COUNT(*) FROM career_interviews WHERE id=?",
    [interviewReceipt.after.interview.id],
  ), 0);
});

test("full-row job CAS catches an unrelated stored fact inside the transaction", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const receipt = await prepare(context, "job-update");
  context.state.beforeBatch = () => {
    context.database.exec(
      "UPDATE career_jobs SET source='内推' WHERE id='job-active'",
    );
  };
  const result = await context.service.commitCareerCoreWrite(receipt);
  assert.equal(result.outcome, "changed");
  assert.deepEqual(
    context.database.selectObject(
      "SELECT company,source,note FROM career_jobs WHERE id='job-active'",
    ),
    { company: "Arc", source: "内推", note: "Original note" },
  );
  assert.equal(context.database.selectValue(
    "SELECT COUNT(*) FROM career_core_write_operations",
  ), 0);
});

test("interview notes may update under archived parents without touching lifecycle facts", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const set = await context.service.loadCareerCoreWriteExpectedSet();
  const expected = interviewExpected(set, "interview-paused");
  assert.equal(expected.job.archived, 1);
  assert.equal(expected.stage.is_terminal, 1);
  const receipt = await context.service.prepareCareerInterviewUpdate({
    status: "canceled",
    summary: "Edited while archived",
    rawNotes: "Kept as history",
    questions: [],
    reflection: "New reflection",
  }, expected);
  const beforeLifecycle = context.database.selectObject(`SELECT canceled_at,
    cancellation_reason,lifecycle_previous_status,lifecycle_operation_id
    FROM career_interviews WHERE id='interview-paused'`);
  assert.equal((await context.service.commitCareerCoreWrite(receipt)).outcome, "saved");
  assert.deepEqual(
    context.database.selectObject(`SELECT canceled_at,cancellation_reason,
      lifecycle_previous_status,lifecycle_operation_id
      FROM career_interviews WHERE id='interview-paused'`),
    beforeLifecycle,
  );
  assert.equal(context.database.selectValue(
    "SELECT summary FROM career_interviews WHERE id='interview-paused'",
  ), "Edited while archived");

  const blocked = fixture();
  t.after(() => blocked.close());
  const blockedSet = await blocked.service.loadCareerCoreWriteExpectedSet();
  await assert.rejects(
    blocked.service.prepareCareerInterviewUpdate({
      status: "scheduled",
      summary: "ordinary restore",
      rawNotes: "",
      questions: [],
      reflection: "",
    }, interviewExpected(blockedSet, "interview-paused")),
    (error) => error instanceof core.CareerCoreWriteError &&
      error.code === "invalid_input",
  );
  assert.equal(blocked.state.batchCalls, 0);
});

test("job facts remain editable in a terminal stage without treating the stage as active", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const set = await context.service.loadCareerCoreWriteExpectedSet();
  const expected = jobExpected(set, "job-ended");
  assert.equal(expected.job.archived, 0);
  assert.equal(expected.stage.is_terminal, 1);
  const receipt = await context.service.prepareCareerJobUpdate({
    company: "Done Co",
    role: "Engineer",
    location: "Singapore",
    salary: "",
    workMode: "",
    description: "",
    deadline: null,
    note: "Historical context",
    tags: "",
  }, expected);
  assert.equal((await context.service.commitCareerCoreWrite(receipt)).outcome, "saved");
  assert.deepEqual(
    context.database.selectObject(`SELECT stage_id,archived,location,note,
      ended_at,ended_operation_id FROM career_jobs WHERE id='job-ended'`),
    {
      stage_id: "stage_terminal",
      archived: 0,
      location: "Singapore",
      note: "Historical context",
      ended_at: BASE_TIME,
      ended_operation_id: "lifecycle-ended",
    },
  );
});

test("a lifecycle race cannot be overwritten by an interview content update", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const set = await context.service.loadCareerCoreWriteExpectedSet();
  const receipt = await context.service.prepareCareerInterviewUpdate({
    status: "canceled",
    summary: "User note edit",
    rawNotes: "User raw edit",
    questions: [],
    reflection: "User reflection edit",
  }, interviewExpected(set, "interview-paused"));
  context.state.beforeBatch = () => {
    context.database.exec(`UPDATE career_interviews
      SET canceled_at='2026-08-23T02:00:00.000Z',
        lifecycle_operation_id='new-lifecycle-operation',
        updated_at='2026-08-23T02:00:00.000Z'
      WHERE id='interview-paused'`);
  };
  const result = await context.service.commitCareerCoreWrite(receipt);
  assert.equal(result.outcome, "changed");
  assert.deepEqual(
    context.database.selectObject(`SELECT summary,canceled_at,
      lifecycle_operation_id FROM career_interviews
      WHERE id='interview-paused'`),
    {
      summary: "Paused summary",
      canceled_at: "2026-08-23T02:00:00.000Z",
      lifecycle_operation_id: "new-lifecycle-operation",
    },
  );
  assert.equal(context.database.selectValue(
    "SELECT COUNT(*) FROM career_core_write_operations",
  ), 0);
});

test("definite precommit failure keeps one receipt retryable; unknown inspection stays calm", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const receipt = await prepare(context, "stage-rename");
  context.state.batchFault = "before";
  await assert.rejects(
    context.service.commitCareerCoreWrite(receipt),
    (error) => error instanceof core.CareerCoreWriteError &&
      error.code === "write_failed" && error.receipt.operationId === receipt.operationId,
  );
  assert.equal(await context.service.inspectCareerCoreWrite(receipt), "expected");
  assert.equal(
    (await context.service.commitCareerCoreWrite(receipt)).outcome,
    "saved",
  );

  const uncertain = fixture();
  t.after(() => uncertain.close());
  const uncertainReceipt = await prepare(uncertain, "job-update");
  uncertain.state.batchFault = "before";
  uncertain.state.queryFailuresAfterBatch = 1;
  const result = await uncertain.service.commitCareerCoreWrite(uncertainReceipt);
  assert.equal(result.outcome, "outcome_uncertain");
  assert.equal(uncertain.state.batchCalls, 1);
  assert.equal(uncertain.database.selectValue(
    "SELECT COUNT(*) FROM career_core_write_operations",
  ), 0);
  assert.equal(
    await uncertain.service.inspectCareerCoreWrite(uncertainReceipt),
    "expected",
  );
});

test("marker inspection compares every immutable proof field", async (t) => {
  for (const [field, replacement] of [
    ["purpose", "career-core-write-x"],
    ["receipt_version", 2],
    ["kind", "job-update"],
    ["entity_id", "different-entity"],
    ["projection_sha256", "0".repeat(64)],
    ["operation_at", "2026-08-22T03:00:00.000Z"],
  ]) {
    const context = fixture();
    t.after(() => context.close());
    const receipt = await prepare(context, "stage-rename");
    assert.equal((await context.service.commitCareerCoreWrite(receipt)).outcome, "saved");
    const originalQuery = context.runtime.query;
    context.runtime.query = async (sql, params = []) => {
      const result = await originalQuery(sql, params);
      if (!sql.includes("FROM career_core_write_operations")) return result;
      return {
        rows: result.rows.map((row) => ({ ...row, [field]: replacement })),
      };
    };
    assert.equal(await context.service.inspectCareerCoreWrite(receipt), "changed");
  }
});
