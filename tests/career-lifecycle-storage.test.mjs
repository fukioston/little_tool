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
    if (params.length > 0) statement.bind(params);
    while (statement.step()) {
      // Consume PRAGMA or RETURNING rows.
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
    async query(name, sql, params = []) {
      assert.equal(name, "career");
      state.queries += 1;
      const rows = database.selectObjects(sql, params);
      return { columns: [], rows, rowCount: rows.length };
    },
    async batch(name, statements, options = {}) {
      assert.equal(name, "career");
      state.batches += 1;
      state.transactional.push(options.transaction !== false);
      const operation = () => statements.map(({ sql, params = [] }) =>
        executeRun(database, sql, params));
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

globalThis.__careerLifecycleAdapter = null;
globalThis.__careerLifecycleLocks = { reads: 0, writes: 0 };

const rawLifecycleJavaScript = await transpile("lib/career/lifecycle.ts");
const clientUrl = moduleUrl(`
  export const localDb = {
    query(...args) { return globalThis.__careerLifecycleAdapter.query(...args); },
    batch(...args) { return globalThis.__careerLifecycleAdapter.batch(...args); }
  };
`);
const lockUrl = moduleUrl(`
  export async function withCareerReadLock(task) {
    globalThis.__careerLifecycleLocks.reads += 1;
    return task({ token: Symbol("read"), mode: "shared" });
  }
  export async function withCareerWriteLock(task) {
    globalThis.__careerLifecycleLocks.writes += 1;
    return task({ token: Symbol("write"), mode: "exclusive" });
  }
`);
const lifecycleJavaScript = rawLifecycleJavaScript
  .replaceAll('"@/lib/local-db/client"', `"${clientUrl}"`)
  .replaceAll('"./lock"', `"${lockUrl}"`);
const lifecycle = await import(moduleUrl(lifecycleJavaScript));

const NOW = "2026-08-21T08:00:00.000Z";
const PAST = "2026-08-20T08:00:00.000Z";
const FUTURE = "2026-08-22T08:00:00.000Z";
const LATER = "2026-08-23T08:00:00.000Z";

async function fixture() {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec(`
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
      source TEXT NOT NULL DEFAULT '',
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
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE career_tasks (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
      contact_id TEXT,
      title TEXT NOT NULL,
      due_at TEXT,
      kind TEXT NOT NULL DEFAULT '跟进',
      priority INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'todo',
      created_at TEXT NOT NULL
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
      updated_at TEXT NOT NULL
    );
  `);
  database.transaction("IMMEDIATE", () => {
    for (const { sql, params = [] } of lifecycle.CAREER_LIFECYCLE_V3_MIGRATION_STATEMENTS) {
      executeRun(database, sql, params);
    }
  });
  for (const [id, name, terminal, position] of [
    ["active", "面试中", 0, 0],
    ["accepted", "已接受", 1, 1],
    ["rejected", "未通过", 1, 2],
    ["withdrawn", "已撤回", 1, 3],
  ]) {
    executeRun(
      database,
      "INSERT INTO career_stages(id,name,color,position,is_terminal,hidden) VALUES(?,?,?,?,?,0)",
      [id, name, "#777777", position, terminal],
    );
  }
  const state = { queries: 0, batches: 0, transactional: [] };
  globalThis.__careerLifecycleAdapter = adapterFor(database, state);
  globalThis.__careerLifecycleLocks = { reads: 0, writes: 0 };
  return { database, state };
}

function addJob(database, id, stage = "active") {
  executeRun(
    database,
    `INSERT INTO career_jobs(
      id,company,role,stage_id,created_at,updated_at,archived,position
    ) VALUES(?,?,?,?,?,?,0,0)`,
    [id, `Company ${id}`, "Role", stage, PAST, PAST],
  );
}

function addTask(database, id, jobId, dueAt, status = "todo") {
  executeRun(
    database,
    `INSERT INTO career_tasks(
      id,job_id,title,due_at,kind,priority,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?, ?,?)`,
    [id, jobId, `Task ${id}`, dueAt, "跟进", 1, status, PAST, PAST],
  );
}

function addInterview(database, id, jobId, scheduledAt, status = "scheduled") {
  executeRun(
    database,
    `INSERT INTO career_interviews(
      id,job_id,round_name,scheduled_at,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)`,
    [id, jobId, `Round ${id}`, scheduledAt, status, PAST, PAST],
  );
}

function objects(database, sql, params = []) {
  return database.selectObjects(sql, params).map((row) => ({ ...row }));
}

test("v3 migration adds reversible operation markers and only canonical canceled", async () => {
  const { database } = await fixture();
  try {
    for (const [table, expected] of [
      ["career_jobs", [
        "archived_at",
        "ended_at",
        "archived_operation_id",
        "ended_operation_id",
      ]],
      ["career_tasks", [
        "updated_at",
        "canceled_at",
        "cancellation_reason",
        "lifecycle_previous_status",
        "lifecycle_operation_id",
      ]],
      ["career_interviews", [
        "canceled_at",
        "cancellation_reason",
        "lifecycle_previous_status",
        "lifecycle_operation_id",
      ]],
    ]) {
      const columns = new Set(
        database.selectObjects(`PRAGMA table_info(${table})`).map(({ name }) => name),
      );
      for (const column of expected) assert.equal(columns.has(column), true, `${table}.${column}`);
    }
    assert.equal(
      database.selectValue(
        "SELECT type FROM sqlite_schema WHERE name='career_lifecycle_events'",
      ),
      "table",
    );
    const source = await readFile(
      new URL("lib/career/lifecycle.ts", projectRoot),
      "utf8",
    );
    assert.doesNotMatch(source, /cancelled/i);
    assert.match(source, /status = 'canceled'/);
  } finally {
    database.close();
  }
});

test("archive pause hides future pressure, preserves history, and restores only untouched rows from that operation", async () => {
  const { database, state } = await fixture();
  try {
    addJob(database, "job-a");
    addJob(database, "job-b");
    addTask(database, "future-untouched", "job-a", FUTURE);
    addTask(database, "future-edited", "job-a", FUTURE);
    addTask(database, "past", "job-a", PAST);
    addTask(database, "undated", "job-a", null);
    addTask(database, "done", "job-a", FUTURE, "done");
    addTask(database, "other", "job-b", FUTURE);
    addInterview(database, "future-interview", "job-a", FUTURE);
    addInterview(database, "past-interview", "job-a", PAST);
    addInterview(database, "completed-interview", "job-a", FUTURE, "completed");
    addInterview(database, "canceled-interview", "job-a", FUTURE, "canceled");
    addInterview(database, "other-interview", "job-b", FUTURE);

    await lifecycle.archiveCareerJob("job-a", {
      relatedAction: "pause",
      now: NOW,
      operationId: "archive-a",
    });

    assert.deepEqual(
      objects(database, `SELECT id,status,due_at,lifecycle_operation_id
        FROM career_tasks ORDER BY id`),
      [
        { id: "done", status: "done", due_at: FUTURE, lifecycle_operation_id: null },
        { id: "future-edited", status: "canceled", due_at: FUTURE, lifecycle_operation_id: "archive-a" },
        { id: "future-untouched", status: "canceled", due_at: FUTURE, lifecycle_operation_id: "archive-a" },
        { id: "other", status: "todo", due_at: FUTURE, lifecycle_operation_id: null },
        { id: "past", status: "todo", due_at: PAST, lifecycle_operation_id: null },
        { id: "undated", status: "todo", due_at: null, lifecycle_operation_id: null },
      ],
    );
    assert.deepEqual(
      objects(database, `SELECT id,status,lifecycle_operation_id
        FROM career_interviews ORDER BY id`),
      [
        { id: "canceled-interview", status: "canceled", lifecycle_operation_id: null },
        { id: "completed-interview", status: "completed", lifecycle_operation_id: null },
        { id: "future-interview", status: "canceled", lifecycle_operation_id: "archive-a" },
        { id: "other-interview", status: "scheduled", lifecycle_operation_id: null },
        { id: "past-interview", status: "scheduled", lifecycle_operation_id: null },
      ],
    );

    const active = await lifecycle.loadCareerLifecycleScope("active");
    assert.deepEqual(active.jobs.map(({ id }) => id), ["job-b"]);
    assert.deepEqual(active.tasks.map(({ id }) => id), ["other"]);
    assert.deepEqual(active.interviews.map(({ id }) => id), ["other-interview"]);
    const archived = await lifecycle.loadCareerLifecycleScope("archived");
    assert.deepEqual(archived.jobs.map(({ id }) => id), ["job-a"]);
    assert.equal(archived.tasks.length, 5);
    assert.equal(archived.interviews.length, 4);

    executeRun(
      database,
      "UPDATE career_tasks SET due_at=?,updated_at=? WHERE id='future-edited'",
      [LATER, LATER],
    );
    await lifecycle.restoreCareerJob("job-a", {
      relatedAction: "restore-paused",
      now: LATER,
      operationId: "restore-a",
    });

    assert.deepEqual(
      objects(database, `SELECT id,status,due_at,lifecycle_operation_id
        FROM career_tasks WHERE id LIKE 'future-%' ORDER BY id`),
      [
        { id: "future-edited", status: "canceled", due_at: LATER, lifecycle_operation_id: "archive-a" },
        { id: "future-untouched", status: "todo", due_at: FUTURE, lifecycle_operation_id: null },
      ],
    );
    assert.deepEqual(
      objects(database, `SELECT id,status,lifecycle_operation_id
        FROM career_interviews WHERE id='future-interview'`),
      [{ id: "future-interview", status: "scheduled", lifecycle_operation_id: null }],
    );
    assert.equal(
      Number(database.selectValue(
        "SELECT COUNT(*) FROM career_lifecycle_events WHERE job_id='job-a'",
      )),
      7,
    );
    assert.equal(state.batches, 2);
    assert.deepEqual(state.transactional, [true, true]);
    assert.equal(globalThis.__careerLifecycleLocks.writes, 2);
    assert.equal(globalThis.__careerLifecycleLocks.reads, 2);
  } finally {
    database.close();
  }
});

test("keep has no dependent side effects and accepted requires an explicit choice", async () => {
  const { database } = await fixture();
  try {
    addJob(database, "job-archive");
    addTask(database, "archive-task", "job-archive", FUTURE);
    addInterview(database, "archive-interview", "job-archive", FUTURE);

    assert.throws(
      () => lifecycle.planArchiveCareerJob("job-archive"),
      /明确选择/,
    );
    await lifecycle.archiveCareerJob("job-archive", {
      relatedAction: "keep",
      now: NOW,
      operationId: "archive-keep",
    });
    assert.equal(
      database.selectValue("SELECT status FROM career_tasks WHERE id='archive-task'"),
      "todo",
    );
    assert.equal(
      database.selectValue("SELECT status FROM career_interviews WHERE id='archive-interview'"),
      "scheduled",
    );
    assert.equal(
      Number(database.selectValue(
        "SELECT COUNT(*) FROM career_lifecycle_events WHERE entity_type<>'job'",
      )),
      0,
    );

    addJob(database, "job-accepted");
    addTask(database, "accepted-task", "job-accepted", FUTURE);
    addInterview(database, "accepted-interview", "job-accepted", FUTURE);
    assert.throws(
      () => lifecycle.planTransitionCareerJobStage("job-accepted", "accepted"),
      /明确选择/,
    );
    await lifecycle.transitionCareerJobStage("job-accepted", "accepted", {
      relatedAction: "keep",
      now: NOW,
      operationId: "accept-keep",
    });
    assert.equal(
      database.selectValue("SELECT status FROM career_tasks WHERE id='accepted-task'"),
      "todo",
    );
    assert.equal(
      database.selectValue("SELECT status FROM career_interviews WHERE id='accepted-interview'"),
      "scheduled",
    );
  } finally {
    database.close();
  }
});

test("terminal pause and reopen respect keep-paused versus restore-paused", async () => {
  const { database } = await fixture();
  try {
    addJob(database, "job-rejected");
    addTask(database, "rejected-task", "job-rejected", FUTURE);
    addInterview(database, "rejected-interview", "job-rejected", FUTURE);

    await lifecycle.transitionCareerJobStage("job-rejected", "rejected", {
      relatedAction: "pause",
      now: NOW,
      operationId: "end-one",
    });
    assert.deepEqual(
      objects(database, `SELECT stage_id,ended_operation_id
        FROM career_jobs WHERE id='job-rejected'`),
      [{ stage_id: "rejected", ended_operation_id: "end-one" }],
    );
    assert.equal(
      database.selectValue("SELECT status FROM career_tasks WHERE id='rejected-task'"),
      "canceled",
    );

    await lifecycle.transitionCareerJobStage("job-rejected", "active", {
      relatedAction: "keep-paused",
      now: LATER,
      operationId: "reopen-keep",
    });
    assert.equal(
      database.selectValue("SELECT status FROM career_tasks WHERE id='rejected-task'"),
      "canceled",
    );

    await lifecycle.restoreCareerTask("rejected-task", LATER);
    assert.equal(
      database.selectValue("SELECT status FROM career_tasks WHERE id='rejected-task'"),
      "todo",
    );
    addInterview(database, "withdrawn-interview", "job-rejected", FUTURE);

    await lifecycle.transitionCareerJobStage("job-rejected", "withdrawn", {
      relatedAction: "pause",
      now: NOW,
      operationId: "end-two",
    });
    await lifecycle.transitionCareerJobStage("job-rejected", "active", {
      relatedAction: "restore-paused",
      now: LATER,
      operationId: "reopen-restore",
    });
    assert.equal(
      database.selectValue("SELECT status FROM career_tasks WHERE id='rejected-task'"),
      "todo",
    );
    assert.equal(
      database.selectValue("SELECT status FROM career_interviews WHERE id='rejected-interview'"),
      "canceled",
      "a prior keep-paused choice is not undone by a later lifecycle operation",
    );
    assert.equal(
      database.selectValue("SELECT status FROM career_interviews WHERE id='withdrawn-interview'"),
      "scheduled",
    );
    assert.equal(
      database.selectValue(
        "SELECT ended_operation_id FROM career_jobs WHERE id='job-rejected'",
      ),
      null,
    );
  } finally {
    database.close();
  }
});

test("an archived terminal job cannot discard a still-paused recovery marker", async () => {
  const { database } = await fixture();
  try {
    addJob(database, "job-terminal-archive", "rejected");
    addTask(database, "terminal-archive-task", "job-terminal-archive", FUTURE);
    addInterview(
      database,
      "terminal-archive-interview",
      "job-terminal-archive",
      FUTURE,
    );
    await lifecycle.archiveCareerJob("job-terminal-archive", {
      relatedAction: "pause",
      now: NOW,
      operationId: "archive-terminal",
    });

    await assert.rejects(
      lifecycle.restoreCareerJob("job-terminal-archive", {
        relatedAction: "restore-paused",
        now: LATER,
        operationId: "invalid-terminal-restore",
      }),
      /constraint/i,
    );
    assert.deepEqual(
      objects(database, `SELECT archived,archived_operation_id
        FROM career_jobs WHERE id='job-terminal-archive'`),
      [{ archived: 1, archived_operation_id: "archive-terminal" }],
    );
    assert.equal(
      database.selectValue(
        "SELECT status FROM career_tasks WHERE id='terminal-archive-task'",
      ),
      "canceled",
    );
    assert.equal(
      Number(database.selectValue(
        "SELECT COUNT(*) FROM career_lifecycle_events WHERE action='restore_job'",
      )),
      0,
      "the rejected transaction does not leave a false restore event",
    );

    await lifecycle.restoreCareerJob("job-terminal-archive", {
      relatedAction: "keep-paused",
      now: LATER,
      operationId: "terminal-keep-paused",
    });
    assert.deepEqual(
      objects(database, `SELECT archived,archived_operation_id
        FROM career_jobs WHERE id='job-terminal-archive'`),
      [{ archived: 0, archived_operation_id: "archive-terminal" }],
    );
    assert.equal(
      database.selectValue(
        "SELECT status FROM career_interviews WHERE id='terminal-archive-interview'",
      ),
      "canceled",
    );
  } finally {
    database.close();
  }
});

test("task reschedule, remove-date, cancel, and restore retain an audit trail", async () => {
  const { database } = await fixture();
  try {
    addTask(database, "personal-task", null, FUTURE);
    await lifecycle.rescheduleCareerTask("personal-task", LATER, NOW);
    await lifecycle.rescheduleCareerTask("personal-task", null, LATER);
    await lifecycle.cancelCareerTask(
      "personal-task",
      "no_longer_needed",
      "2026-08-24T08:00:00.000Z",
    );
    await lifecycle.restoreCareerTask(
      "personal-task",
      "2026-08-25T08:00:00.000Z",
    );

    assert.deepEqual(
      objects(database, `SELECT status,due_at,canceled_at,cancellation_reason
        FROM career_tasks WHERE id='personal-task'`),
      [{ status: "todo", due_at: null, canceled_at: null, cancellation_reason: null }],
    );
    assert.deepEqual(
      objects(database, `SELECT action,previous_due_at,next_due_at,reason
        FROM career_lifecycle_events
        WHERE entity_type='task' AND entity_id='personal-task'
        ORDER BY created_at,id`),
      [
        { action: "reschedule_task", previous_due_at: FUTURE, next_due_at: LATER, reason: "user" },
        { action: "unschedule_task", previous_due_at: LATER, next_due_at: null, reason: "user" },
        { action: "cancel_task", previous_due_at: null, next_due_at: null, reason: "no_longer_needed" },
        { action: "restore_task", previous_due_at: null, next_due_at: null, reason: "no_longer_needed" },
      ],
    );
  } finally {
    database.close();
  }
});

test("a failed lifecycle write rolls back the job, dependents, events, and guard", async () => {
  const { database } = await fixture();
  try {
    addJob(database, "job-fail");
    addTask(database, "task-fail", "job-fail", FUTURE);
    addInterview(database, "interview-fail", "job-fail", FUTURE);
    database.exec(`CREATE TRIGGER fail_archive
      BEFORE UPDATE OF archived ON career_jobs
      WHEN NEW.id='job-fail'
      BEGIN SELECT RAISE(ABORT,'forced failure'); END`);

    await assert.rejects(
      lifecycle.archiveCareerJob("job-fail", {
        relatedAction: "pause",
        now: NOW,
        operationId: "archive-fail",
      }),
      /forced failure/,
    );
    assert.deepEqual(
      objects(database, "SELECT archived,archived_at FROM career_jobs WHERE id='job-fail'"),
      [{ archived: 0, archived_at: null }],
    );
    assert.equal(
      database.selectValue("SELECT status FROM career_tasks WHERE id='task-fail'"),
      "todo",
    );
    assert.equal(
      database.selectValue("SELECT status FROM career_interviews WHERE id='interview-fail'"),
      "scheduled",
    );
    assert.equal(
      Number(database.selectValue("SELECT COUNT(*) FROM career_lifecycle_events")),
      0,
    );
    assert.equal(
      Number(database.selectValue(`SELECT COUNT(*) FROM sqlite_temp_schema
        WHERE name LIKE '__career_lifecycle_guard_%'`)),
      0,
    );
  } finally {
    database.close();
  }
});
