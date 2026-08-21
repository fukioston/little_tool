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
      // Consume statements that return rows.
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
      state.batchSizes.push(statements.length);
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

globalThis.__careerTaskAdapter = null;
globalThis.__careerTaskLocks = { reads: 0, writes: 0 };

const rawTaskJavaScript = await transpile("lib/career/tasks.ts");
const clientUrl = moduleUrl(`
  export const localDb = {
    query(...args) { return globalThis.__careerTaskAdapter.query(...args); },
    batch(...args) { return globalThis.__careerTaskAdapter.batch(...args); }
  };
`);
const lockUrl = moduleUrl(`
  export async function withCareerReadLock(task) {
    globalThis.__careerTaskLocks.reads += 1;
    return task({ token: Symbol("read"), mode: "shared" });
  }
  export async function withCareerWriteLock(task) {
    globalThis.__careerTaskLocks.writes += 1;
    return task({ token: Symbol("write"), mode: "exclusive" });
  }
`);
const taskJavaScript = rawTaskJavaScript
  .replaceAll('"@/lib/local-db/client"', `"${clientUrl}"`)
  .replaceAll('"./lock"', `"${lockUrl}"`);
const tasks = await import(moduleUrl(taskJavaScript));

const OLD = "2026-08-20T08:00:00.000Z";
const NOW = "2026-08-21T08:00:00.000Z";
const LATER = "2026-08-22T08:00:00.000Z";
const FUTURE = "2099-08-23T08:00:00.000Z";
const FAR_FUTURE = "2099-08-24T08:00:00.000Z";

async function fixture() {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec(`
    CREATE TABLE career_stages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      is_terminal INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE career_jobs (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      stage_id TEXT NOT NULL REFERENCES career_stages(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE career_contacts (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE career_tasks (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
      contact_id TEXT REFERENCES career_contacts(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      due_at TEXT,
      kind TEXT NOT NULL DEFAULT '跟进',
      priority INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'todo',
      created_at TEXT NOT NULL,
      updated_at TEXT,
      canceled_at TEXT,
      cancellation_reason TEXT,
      lifecycle_previous_status TEXT,
      lifecycle_operation_id TEXT
    );
    CREATE TABLE career_lifecycle_events (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('job','task','interview')),
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      previous_status TEXT,
      next_status TEXT,
      previous_due_at TEXT,
      next_due_at TEXT,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    INSERT INTO career_stages(id,name,is_terminal) VALUES
      ('active','面试中',0),('terminal','已结束',1);
    INSERT INTO career_jobs(id,company,role,stage_id,created_at,updated_at,archived) VALUES
      ('active-job','Active Co','Designer','active','${OLD}','${OLD}',0),
      ('archived-job','Archive Co','Writer','active','${OLD}','${OLD}',1),
      ('ended-job','Ended Co','Engineer','terminal','${OLD}','${OLD}',0);
    INSERT INTO career_contacts(id,company,name,role,created_at,updated_at,archived) VALUES
      ('active-contact','Active Co','Lin','Recruiter','${OLD}','${OLD}',0),
      ('archived-contact','Old Co','Ming','Recruiter','${OLD}','${OLD}',1);
  `);
  const state = { queries: 0, batches: 0, transactional: [], batchSizes: [] };
  globalThis.__careerTaskAdapter = adapterFor(database, state);
  globalThis.__careerTaskLocks = { reads: 0, writes: 0 };
  return { database, state };
}

function addTask(database, {
  id,
  jobId = null,
  contactId = null,
  title = `Task ${id}`,
  dueAt = FUTURE,
  status = "todo",
  updatedAt = OLD,
  canceledAt = null,
  cancellationReason = null,
  lifecyclePreviousStatus = null,
  lifecycleOperationId = null,
}) {
  executeRun(
    database,
    `INSERT INTO career_tasks(
      id,job_id,contact_id,title,due_at,kind,priority,status,created_at,
      updated_at,canceled_at,cancellation_reason,lifecycle_previous_status,
      lifecycle_operation_id
    ) VALUES(?,?,?,?,?,'跟进',1,?,?,?,?,?,?,?)`,
    [
      id,
      jobId,
      contactId,
      title,
      dueAt,
      status,
      OLD,
      updatedAt,
      canceledAt,
      cancellationReason,
      lifecyclePreviousStatus,
      lifecycleOperationId,
    ],
  );
}

function objects(database, sql, params = []) {
  return database.selectObjects(sql, params).map((row) => ({ ...row }));
}

function persistentSnapshot(database) {
  return {
    jobs: objects(database, "SELECT * FROM career_jobs ORDER BY id"),
    contacts: objects(database, "SELECT * FROM career_contacts ORDER BY id"),
    tasks: objects(database, "SELECT * FROM career_tasks ORDER BY id"),
    events: objects(database, "SELECT * FROM career_lifecycle_events ORDER BY id"),
  };
}

function rejectsCode(promise, code) {
  return assert.rejects(
    promise,
    (error) => error instanceof tasks.CareerTaskError &&
      error.code === code && !/\b(?:SELECT|UPDATE|INSERT|SQL)\b/i.test(error.message),
  );
}

test("create is one locked IMMEDIATE batch and a stable ID is safely idempotent", async () => {
  const { database, state } = await fixture();
  try {
    const input = {
      id: "stable-task",
      title: "  Send a thoughtful follow-up  ",
      jobId: "active-job",
      contactId: "active-contact",
      dueAt: FUTURE,
      kind: "跟进",
      priority: 2,
      now: NOW,
    };
    assert.equal(await tasks.createCareerTask(input), "stable-task");
    assert.equal(
      await tasks.createCareerTask({ ...input, now: LATER }),
      "stable-task",
    );

    assert.deepEqual(
      objects(database, `SELECT id,job_id,contact_id,title,due_at,kind,priority,
        status,created_at,updated_at FROM career_tasks`),
      [{
        id: "stable-task",
        job_id: "active-job",
        contact_id: "active-contact",
        title: "Send a thoughtful follow-up",
        due_at: FUTURE,
        kind: "跟进",
        priority: 2,
        status: "todo",
        created_at: NOW,
        updated_at: NOW,
      }],
    );
    assert.deepEqual(
      objects(database, `SELECT id,job_id,entity_type,entity_id,action,
        previous_status,next_status,previous_due_at,next_due_at,reason,created_at
        FROM career_lifecycle_events`),
      [{
        id: "task_create_stable-task",
        job_id: "active-job",
        entity_type: "task",
        entity_id: "stable-task",
        action: "create_task",
        previous_status: null,
        next_status: "todo",
        previous_due_at: null,
        next_due_at: FUTURE,
        reason: "user",
        created_at: NOW,
      }],
    );
    assert.deepEqual(globalThis.__careerTaskLocks, { reads: 0, writes: 2 });
    assert.equal(state.batches, 1);
    assert.deepEqual(state.transactional, [true]);
    assert.ok(state.batchSizes.every((size) => size === 5));
  } finally {
    database.close();
  }
});

test("same-ID conflicts and invalid linked context fail without persistent writes", async () => {
  const { database } = await fixture();
  try {
    const base = {
      id: "collision",
      title: "Original",
      jobId: "active-job",
      now: NOW,
    };
    await tasks.createCareerTask(base);
    const beforeCollision = persistentSnapshot(database);
    await assert.rejects(
      tasks.createCareerTask({ ...base, title: "Different", now: LATER }),
    );
    assert.deepEqual(persistentSnapshot(database), beforeCollision);

    for (const input of [
      { id: "missing-job-task", title: "Missing", jobId: "missing-job" },
      { id: "archived-job-task", title: "Archived", jobId: "archived-job" },
      { id: "ended-job-task", title: "Ended", jobId: "ended-job" },
      { id: "archived-contact-task", title: "Old contact", contactId: "archived-contact" },
    ]) {
      const before = persistentSnapshot(database);
      await assert.rejects(tasks.createCareerTask({ ...input, now: NOW }));
      assert.deepEqual(persistentSnapshot(database), before);
    }
  } finally {
    database.close();
  }
});

test("completion and explicit reopen preserve dates, events, and optimistic truth", async () => {
  const { database } = await fixture();
  try {
    addTask(database, { id: "personal", dueAt: OLD });
    addTask(database, { id: "unrelated", jobId: "active-job" });
    const unrelatedBefore = objects(
      database,
      "SELECT * FROM career_tasks WHERE id='unrelated'",
    );
    const jobBefore = objects(database, "SELECT * FROM career_jobs ORDER BY id");

    await tasks.completeCareerTask("personal", {
      expectedUpdatedAt: OLD,
      now: NOW,
      operationId: "complete-personal",
    });
    assert.deepEqual(
      objects(database, "SELECT status,due_at,updated_at FROM career_tasks WHERE id='personal'"),
      [{ status: "done", due_at: OLD, updated_at: NOW }],
    );
    assert.deepEqual(
      objects(database, `SELECT action,previous_status,next_status,
        previous_due_at,next_due_at,reason FROM career_lifecycle_events
        WHERE entity_id='personal'`),
      [{
        action: "complete_task",
        previous_status: "todo",
        next_status: "done",
        previous_due_at: OLD,
        next_due_at: OLD,
        reason: "user",
      }],
    );

    const afterComplete = persistentSnapshot(database);
    await assert.rejects(tasks.completeCareerTask("personal", {
      expectedUpdatedAt: OLD,
      now: LATER,
      operationId: "stale-complete",
    }));
    assert.deepEqual(persistentSnapshot(database), afterComplete);

    await assert.rejects(
      tasks.reopenCompletedCareerTask("personal", {
        dueAt: NOW,
        expectedUpdatedAt: NOW,
        now: NOW,
      }),
      /晚于当前时间/,
    );
    await assert.rejects(
      tasks.reopenCompletedCareerTask("personal", {
        dueAt: OLD,
        expectedUpdatedAt: NOW,
        now: NOW,
      }),
      /晚于当前时间/,
    );
    assert.deepEqual(persistentSnapshot(database), afterComplete);

    await tasks.reopenCompletedCareerTask("personal", {
      dueAt: null,
      expectedUpdatedAt: NOW,
      now: LATER,
      operationId: "reopen-personal-unscheduled",
    });
    assert.deepEqual(
      objects(database, "SELECT status,due_at,updated_at FROM career_tasks WHERE id='personal'"),
      [{ status: "todo", due_at: null, updated_at: LATER }],
    );
    assert.deepEqual(
      objects(database, `SELECT action,previous_due_at,next_due_at
        FROM career_lifecycle_events WHERE id='reopen-personal-unscheduled'`),
      [{ action: "reopen_completed_task", previous_due_at: OLD, next_due_at: null }],
    );
    assert.deepEqual(
      objects(database, "SELECT * FROM career_tasks WHERE id='unrelated'"),
      unrelatedBefore,
    );
    assert.deepEqual(objects(database, "SELECT * FROM career_jobs ORDER BY id"), jobBefore);
  } finally {
    database.close();
  }
});

test("reopen needs an explicit choice, a fresh version, and an active linked job", async () => {
  const { database } = await fixture();
  try {
    addTask(database, { id: "active-done", jobId: "active-job", status: "done" });
    addTask(database, { id: "archived-done", jobId: "archived-job", status: "done" });
    addTask(database, { id: "ended-done", jobId: "ended-job", status: "done" });
    addTask(database, { id: "already-todo", status: "todo" });
    addTask(database, {
      id: "canceled-choice",
      status: "canceled",
      canceledAt: OLD,
      cancellationReason: "changed_plan",
    });

    const beforeMissingChoice = persistentSnapshot(database);
    await assert.rejects(
      tasks.reopenCompletedCareerTask("active-done", {
        expectedUpdatedAt: OLD,
        now: NOW,
      }),
      /明确选择/,
    );
    assert.deepEqual(persistentSnapshot(database), beforeMissingChoice);

    await rejectsCode(tasks.restoreCareerTask("canceled-choice", {
      expectedUpdatedAt: OLD,
      now: NOW,
    }), "due_at_required");
    await rejectsCode(tasks.restoreCareerTask("canceled-choice", {
      dueAt: OLD,
      expectedUpdatedAt: OLD,
      now: NOW,
    }), "due_at_not_future");
    assert.deepEqual(persistentSnapshot(database), beforeMissingChoice);

    for (const id of ["archived-done", "ended-done", "already-todo", "unknown"]) {
      const before = persistentSnapshot(database);
      await assert.rejects(tasks.reopenCompletedCareerTask(id, {
        dueAt: null,
        expectedUpdatedAt: OLD,
        now: NOW,
        operationId: `blocked-${id}`,
      }));
      assert.deepEqual(persistentSnapshot(database), before);
    }

    const beforeStale = persistentSnapshot(database);
    await assert.rejects(tasks.reopenCompletedCareerTask("active-done", {
      dueAt: FUTURE,
      expectedUpdatedAt: NOW,
      now: LATER,
      operationId: "stale-reopen",
    }));
    assert.deepEqual(persistentSnapshot(database), beforeStale);

    await tasks.reopenCompletedCareerTask("active-done", {
      dueAt: FUTURE,
      expectedUpdatedAt: OLD,
      now: LATER,
      operationId: "fresh-reopen",
    });
    assert.deepEqual(
      objects(database, "SELECT status,due_at,updated_at FROM career_tasks WHERE id='active-done'"),
      [{ status: "todo", due_at: FUTURE, updated_at: LATER }],
    );
  } finally {
    database.close();
  }
});

test("detail exposes proven context and raw cancellation reasons", async () => {
  const { database, state } = await fixture();
  try {
    addTask(database, {
      id: "manual-canceled",
      jobId: "active-job",
      contactId: "active-contact",
      status: "canceled",
      cancellationReason: "no_longer_needed",
      canceledAt: NOW,
    });
    addTask(database, {
      id: "archive-canceled",
      jobId: "archived-job",
      status: "canceled",
      cancellationReason: "job_archived",
      canceledAt: NOW,
      lifecyclePreviousStatus: "todo",
      lifecycleOperationId: "archive-op",
    });
    addTask(database, {
      id: "ended-canceled",
      jobId: "ended-job",
      status: "canceled",
      cancellationReason: "job_ended",
      canceledAt: NOW,
      lifecyclePreviousStatus: "todo",
      lifecycleOperationId: "end-op",
    });
    addTask(database, {
      id: "elapsed-canceled",
      jobId: "active-job",
      dueAt: OLD,
      status: "canceled",
      cancellationReason: "changed_plan",
      canceledAt: NOW,
    });

    const manual = await tasks.loadCareerTaskDetail("manual-canceled");
    assert.equal(manual?.canRestoreWithNewDueAt, true);
    assert.equal(manual?.hardRestoreBlockedReason, null);
    assert.equal(manual?.restoreRequiresDueChoice, true);
    assert.deepEqual(manual?.job, {
      id: "active-job",
      company: "Active Co",
      role: "Designer",
      archived: false,
      stage: { id: "active", name: "面试中", isTerminal: false },
    });
    assert.deepEqual(manual?.contact, {
      id: "active-contact",
      name: "Lin",
      company: "Active Co",
      role: "Recruiter",
      archived: false,
    });
    assert.deepEqual(manual?.cancellation, {
      reason: "no_longer_needed",
      previousStatus: null,
      lifecycleOperationId: null,
      canceledAt: NOW,
    });

    const archived = await tasks.loadCareerTaskDetail("archive-canceled");
    assert.equal(archived?.canRestoreWithNewDueAt, false);
    assert.equal(archived?.hardRestoreBlockedReason, "job_archived");
    assert.equal(archived?.task.cancellation_reason, "job_archived");
    assert.equal(archived?.cancellation?.reason, "job_archived");

    const ended = await tasks.loadCareerTaskDetail("ended-canceled");
    assert.equal(ended?.hardRestoreBlockedReason, "job_ended");
    assert.equal(ended?.cancellation?.reason, "job_ended");

    const elapsed = await tasks.loadCareerTaskDetail("elapsed-canceled");
    assert.equal(elapsed?.hardRestoreBlockedReason, null);
    assert.equal(elapsed?.canRestoreWithNewDueAt, true);
    assert.equal(elapsed?.restoreRequiresDueChoice, true);
    assert.equal(await tasks.loadCareerTaskDetail("missing"), null);
    assert.equal(state.queries, 5);
    assert.deepEqual(globalThis.__careerTaskLocks, { reads: 5, writes: 0 });
  } finally {
    database.close();
  }
});

test("a failed status write rolls back its event, task, and temporary guard", async () => {
  const { database, state } = await fixture();
  try {
    addTask(database, { id: "rollback-task" });
    database.exec(`CREATE TRIGGER fail_task_completion
      BEFORE UPDATE OF status ON career_tasks
      WHEN NEW.id='rollback-task'
      BEGIN SELECT RAISE(ABORT,'forced task failure'); END`);
    const before = persistentSnapshot(database);

    await assert.rejects(tasks.completeCareerTask("rollback-task", {
      expectedUpdatedAt: OLD,
      now: NOW,
      operationId: "rollback-complete",
    }), (error) => error?.code === "write_failed" && !/SQL|forced/i.test(error.message));
    assert.deepEqual(persistentSnapshot(database), before);
    assert.equal(
      Number(database.selectValue(`SELECT COUNT(*) FROM sqlite_temp_schema
        WHERE name LIKE '__career_task_guard_%'`)),
      0,
    );
    assert.equal(state.batches, 1);
    assert.deepEqual(state.transactional, [true]);
    assert.deepEqual(globalThis.__careerTaskLocks, { reads: 0, writes: 1 });
  } finally {
    database.close();
  }
});

test("every facade mutation requires an explicit version before taking a write lock", async () => {
  const { database, state } = await fixture();
  try {
    addTask(database, { id: "version-todo" });
    addTask(database, { id: "version-done", status: "done" });
    addTask(database, {
      id: "version-canceled",
      status: "canceled",
      canceledAt: NOW,
      cancellationReason: "changed_plan",
    });
    const before = persistentSnapshot(database);
    await rejectsCode(tasks.completeCareerTask("version-todo"), "expected_version_required");
    await rejectsCode(
      tasks.rescheduleCareerTask("version-todo", { dueAt: null }),
      "expected_version_required",
    );
    await rejectsCode(
      tasks.cancelCareerTask("version-todo", {}),
      "expected_version_required",
    );
    await rejectsCode(
      tasks.restoreCareerTask("version-canceled", { dueAt: null }),
      "expected_version_required",
    );
    await rejectsCode(
      tasks.reopenCompletedCareerTask("version-done", { dueAt: null }),
      "expected_version_required",
    );
    assert.deepEqual(persistentSnapshot(database), before);
    assert.equal(state.batches, 0);
    assert.deepEqual(globalThis.__careerTaskLocks, { reads: 0, writes: 0 });
  } finally {
    database.close();
  }
});

test("same-clock todo-done-todo is strictly versioned and rejects the original ABA token", async () => {
  const { database } = await fixture();
  try {
    addTask(database, { id: "aba-task", dueAt: FUTURE });
    const completed = await tasks.completeCareerTask("aba-task", {
      expectedUpdatedAt: OLD,
      now: OLD,
      operationId: "aba-complete",
    });
    assert.equal(completed.updatedAt, "2026-08-20T08:00:00.001Z");
    const reopened = await tasks.reopenCompletedCareerTask("aba-task", {
      dueAt: null,
      expectedUpdatedAt: completed.updatedAt,
      now: OLD,
      operationId: "aba-reopen",
    });
    assert.equal(reopened.updatedAt, "2026-08-20T08:00:00.002Z");
    assert.ok(Date.parse(reopened.updatedAt) > Date.parse(completed.updatedAt));
    const beforeStale = persistentSnapshot(database);

    await rejectsCode(tasks.cancelCareerTask("aba-task", {
      expectedUpdatedAt: OLD,
      now: OLD,
      operationId: "aba-stale-cancel",
    }), "changed");
    assert.deepEqual(persistentSnapshot(database), beforeStale);
    assert.deepEqual(
      objects(database, `SELECT action,created_at FROM career_lifecycle_events
        WHERE entity_id='aba-task' ORDER BY created_at`),
      [
        { action: "complete_task", created_at: completed.updatedAt },
        { action: "reopen_completed_task", created_at: reopened.updatedAt },
      ],
    );
  } finally {
    database.close();
  }
});

test("A-read then B-reschedule makes A reschedule and cancel zero-write stale failures", async () => {
  const { database, state } = await fixture();
  try {
    addTask(database, { id: "stale-todo", dueAt: FUTURE });
    const aToken = OLD;
    const bResult = await tasks.rescheduleCareerTask("stale-todo", {
      dueAt: FAR_FUTURE,
      expectedUpdatedAt: aToken,
      now: NOW,
      operationId: "b-reschedule",
    });
    assert.equal(bResult.updatedAt, NOW);
    const afterB = persistentSnapshot(database);
    const batchesAfterB = state.batches;

    await rejectsCode(tasks.rescheduleCareerTask("stale-todo", {
      dueAt: null,
      expectedUpdatedAt: aToken,
      now: LATER,
      operationId: "a-stale-reschedule",
    }), "changed");
    await rejectsCode(tasks.cancelCareerTask("stale-todo", {
      expectedUpdatedAt: aToken,
      now: LATER,
      operationId: "a-stale-cancel",
    }), "changed");
    assert.deepEqual(persistentSnapshot(database), afterB);
    assert.equal(state.batches, batchesAfterB);
    assert.equal(
      Number(database.selectValue("SELECT COUNT(*) FROM career_lifecycle_events")),
      1,
    );
  } finally {
    database.close();
  }
});

test("canceled ABA remains stale after B restores with a date and cancels again", async () => {
  const { database, state } = await fixture();
  try {
    addTask(database, {
      id: "stale-restore",
      jobId: "active-job",
      status: "canceled",
      canceledAt: OLD,
      cancellationReason: "changed_plan",
    });
    const aToken = OLD;
    const restored = await tasks.restoreCareerTask("stale-restore", {
      dueAt: FAR_FUTURE,
      expectedUpdatedAt: aToken,
      now: NOW,
      operationId: "b-restore-with-date",
    });
    const canceledAgain = await tasks.cancelCareerTask("stale-restore", {
      reason: "changed_plan",
      expectedUpdatedAt: restored.updatedAt,
      now: NOW,
      operationId: "b-cancel-again",
    });
    assert.ok(Date.parse(canceledAgain.updatedAt) > Date.parse(restored.updatedAt));
    const afterB = persistentSnapshot(database);
    const batchesAfterB = state.batches;

    await rejectsCode(tasks.restoreCareerTask("stale-restore", {
      dueAt: null,
      expectedUpdatedAt: aToken,
      now: LATER,
      operationId: "a-stale-restore",
    }), "changed");
    assert.deepEqual(persistentSnapshot(database), afterB);
    assert.equal(state.batches, batchesAfterB);
    assert.equal(
      Number(database.selectValue("SELECT COUNT(*) FROM career_lifecycle_events")),
      2,
    );
  } finally {
    database.close();
  }
});

test("typed preflight distinguishes missing, current wrong status, and unavailable job", async () => {
  const { database, state } = await fixture();
  try {
    addTask(database, { id: "fresh-done", status: "done" });
    addTask(database, {
      id: "archived-canceled",
      jobId: "archived-job",
      status: "canceled",
      canceledAt: OLD,
      cancellationReason: "job_archived",
    });
    await rejectsCode(tasks.completeCareerTask("missing-task", {
      expectedUpdatedAt: OLD,
      now: NOW,
    }), "not_found");
    await rejectsCode(tasks.completeCareerTask("fresh-done", {
      expectedUpdatedAt: OLD,
      now: NOW,
    }), "wrong_status");
    await rejectsCode(tasks.restoreCareerTask("archived-canceled", {
      dueAt: null,
      expectedUpdatedAt: OLD,
      now: NOW,
    }), "job_unavailable");
    assert.equal(state.batches, 0);
  } finally {
    database.close();
  }
});

test("the facade exposes only this module's version-protected task actions", () => {
  assert.equal(tasks.careerTaskActions.load, tasks.loadCareerTaskDetail);
  assert.equal(tasks.careerTaskActions.create, tasks.createCareerTask);
  assert.equal(tasks.careerTaskActions.complete, tasks.completeCareerTask);
  assert.equal(tasks.careerTaskActions.reopenCompleted, tasks.reopenCompletedCareerTask);
  assert.equal(tasks.careerTaskActions.reschedule, tasks.rescheduleCareerTask);
  assert.equal(tasks.careerTaskActions.cancel, tasks.cancelCareerTask);
  assert.equal(tasks.careerTaskActions.restore, tasks.restoreCareerTask);
});
