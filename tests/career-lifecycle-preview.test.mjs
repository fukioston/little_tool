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
  return { changes: Number(database.changes()) };
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
      assert.equal(
        globalThis.__careerPreviewLockState.mode,
        "exclusive",
        "every lifecycle batch must stay inside the exclusive Career lock",
      );
      state.batches += 1;
      state.transactional.push(options.transaction !== false);
      const run = () => statements.map(({ sql, params = [] }) =>
        executeRun(database, sql, params));
      const results = options.transaction === false
        ? run()
        : database.transaction("IMMEDIATE", run);
      return {
        results,
        changes: results.reduce((sum, result) => sum + result.changes, 0),
      };
    },
  };
}

globalThis.__careerPreviewAdapter = null;
globalThis.__careerPreviewLocks = { reads: 0, writes: 0 };
globalThis.__careerPreviewLockState = {
  mode: null,
  supportsRequired: true,
  onReadAcquired: null,
  onWriteAcquired: null,
};

const [schemaJavaScript, rawLifecycleJavaScript] = await Promise.all([
  transpile("lib/schemas/zhiji.ts"),
  transpile("lib/career/lifecycle.ts"),
]);
const schemaUrl = moduleUrl(schemaJavaScript);
const clientUrl = moduleUrl(`
  export const localDb = {
    query(...args) { return globalThis.__careerPreviewAdapter.query(...args); },
    batch(...args) { return globalThis.__careerPreviewAdapter.batch(...args); }
  };
`);
const lockUrl = moduleUrl(`
  async function run(mode, task, hook) {
    if (globalThis.__careerPreviewLockState.mode !== null) {
      throw new Error("test lock unexpectedly nested");
    }
    globalThis.__careerPreviewLockState.mode = mode;
    try {
      hook?.();
      return await task({ token: Symbol(mode), mode });
    } finally {
      globalThis.__careerPreviewLockState.mode = null;
    }
  }
  export async function withCareerReadLock(task) {
    globalThis.__careerPreviewLocks.reads += 1;
    return run("shared", task, globalThis.__careerPreviewLockState.onReadAcquired);
  }
  export async function withCareerWriteLock(task) {
    globalThis.__careerPreviewLocks.writes += 1;
    return run("exclusive", task, globalThis.__careerPreviewLockState.onWriteAcquired);
  }
  export async function withCareerBackupLock(task) {
    globalThis.__careerPreviewLocks.writes += 1;
    if (!globalThis.__careerPreviewLockState.supportsRequired) {
      throw new Error("当前浏览器不支持安全的跨标签页备份锁，请使用最新版浏览器");
    }
    return run("exclusive", task, globalThis.__careerPreviewLockState.onWriteAcquired);
  }
`);
const lifecycleJavaScript = rawLifecycleJavaScript
  .replaceAll('"@/lib/local-db/client"', `"${clientUrl}"`)
  .replaceAll('"./lock"', `"${lockUrl}"`)
  .replaceAll('"../schemas/zhiji"', `"${schemaUrl}"`);
const lifecycle = await import(moduleUrl(lifecycleJavaScript));

const milliseconds = Date.now();
const PREVIOUS_WEEK = new Date(milliseconds - 7 * 86_400_000).toISOString();
const PAUSE_TIME = new Date(milliseconds - 3 * 86_400_000).toISOString();
const ELAPSED = new Date(milliseconds - 86_400_000).toISOString();
const NOW = new Date(milliseconds).toISOString();
const FUTURE = new Date(milliseconds + 86_400_000).toISOString();
const LATER = new Date(milliseconds + 2 * 86_400_000).toISOString();

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
    ["active-two", "沟通中", 0, 1],
    ["accepted", "已接受", 1, 2],
    ["rejected", "未通过", 1, 3],
  ]) {
    executeRun(
      database,
      "INSERT INTO career_stages(id,name,color,position,is_terminal,hidden) VALUES(?,?,?,?,?,0)",
      [id, name, "#777777", position, terminal],
    );
  }
  const state = { queries: 0, batches: 0, transactional: [] };
  globalThis.__careerPreviewAdapter = adapterFor(database, state);
  globalThis.__careerPreviewLocks = { reads: 0, writes: 0 };
  globalThis.__careerPreviewLockState = {
    mode: null,
    supportsRequired: true,
    onReadAcquired: null,
    onWriteAcquired: null,
  };
  return { database, state };
}

function addJob(database, id, stage = "active") {
  executeRun(
    database,
    `INSERT INTO career_jobs(
      id,company,role,stage_id,created_at,updated_at,archived,position
    ) VALUES(?,?,?,?,?,?,0,0)`,
    [id, `Company ${id}`, "Role", stage, PREVIOUS_WEEK, PREVIOUS_WEEK],
  );
}

function addTask(database, id, jobId, dueAt, status = "todo") {
  executeRun(
    database,
    `INSERT INTO career_tasks(
      id,job_id,title,due_at,kind,priority,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?, ?,?)`,
    [id, jobId, `Task ${id}`, dueAt, "跟进", 1, status, PREVIOUS_WEEK, PREVIOUS_WEEK],
  );
}

function addInterview(database, id, jobId, scheduledAt, status = "scheduled") {
  executeRun(
    database,
    `INSERT INTO career_interviews(
      id,job_id,round_name,scheduled_at,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)`,
    [id, jobId, `Round ${id}`, scheduledAt, status, PREVIOUS_WEEK, PREVIOUS_WEEK],
  );
}

function values(database, sql, params = []) {
  return database.selectObjects(sql, params).map((row) => ({ ...row }));
}

test("preview IDs exactly match the rows committed by a single transaction", async () => {
  const { database, state } = await fixture();
  try {
    addJob(database, "job-preview");
    addTask(database, "future-task", "job-preview", FUTURE);
    addTask(database, "past-task", "job-preview", ELAPSED);
    addInterview(database, "future-interview", "job-preview", FUTURE);
    addInterview(database, "past-interview", "job-preview", ELAPSED);

    const prepared = await lifecycle.prepareCareerLifecycleChange({
      kind: "archive",
      jobId: "job-preview",
      operationId: "preview-archive",
    }, NOW);
    assert.equal(prepared.requiresChoice, true);
    assert.deepEqual(prepared.allowedChoices, ["keep", "pause"]);
    assert.deepEqual(
      prepared.impact
        .filter(({ classification }) => classification === "affected")
        .map(({ id }) => id)
        .sort(),
      ["future-interview", "future-task"],
    );
    assert.deepEqual(
      prepared.impact
        .filter(({ classification }) => classification === "elapsed")
        .map(({ id }) => id)
        .sort(),
      ["past-interview", "past-task"],
    );

    const result = await lifecycle.commitPreparedCareerLifecycleChange(
      prepared,
      "pause",
    );
    assert.equal(result.status, "committed");
    const changedIds = values(
      database,
      `SELECT id FROM career_tasks WHERE lifecycle_operation_id='preview-archive'
       UNION ALL
       SELECT id FROM career_interviews WHERE lifecycle_operation_id='preview-archive'
       ORDER BY id`,
    ).map(({ id }) => id);
    assert.deepEqual(changedIds, ["future-interview", "future-task"]);
    assert.equal(state.batches, 1);
    assert.deepEqual(state.transactional, [true]);
    assert.equal(globalThis.__careerPreviewLocks.reads, 1);
    assert.equal(globalThis.__careerPreviewLocks.writes, 1);
  } finally {
    database.close();
  }
});

test("a cross-tab fact change returns a fresh preview and performs zero writes", async () => {
  const { database, state } = await fixture();
  try {
    addJob(database, "job-stale");
    addTask(database, "stale-task", "job-stale", FUTURE);
    const prepared = await lifecycle.prepareCareerLifecycleChange({
      kind: "archive",
      jobId: "job-stale",
      operationId: "stable-operation",
    }, NOW);

    executeRun(
      database,
      "UPDATE career_tasks SET title='Retitled in another tab' WHERE id='stale-task'",
    );
    const result = await lifecycle.commitPreparedCareerLifecycleChange(
      prepared,
      "pause",
    );
    assert.equal(result.status, "changed");
    assert.equal(result.prepared.operationId, "stable-operation");
    assert.equal(result.prepared.impact[0].label, "Retitled in another tab");
    assert.notEqual(result.prepared.fingerprint, prepared.fingerprint);
    assert.equal(state.batches, 0);
    assert.equal(
      database.selectValue("SELECT archived FROM career_jobs WHERE id='job-stale'"),
      0,
    );
    assert.equal(
      database.selectValue("SELECT status FROM career_tasks WHERE id='stale-task'"),
      "todo",
    );
    assert.equal(
      database.selectValue("SELECT COUNT(*) FROM career_lifecycle_events"),
      0,
    );
  } finally {
    database.close();
  }
});

test("crossing the schedule boundary while the dialog is open refreshes instead of writing", async () => {
  const { database, state } = await fixture();
  try {
    const previewedAt = new Date(milliseconds - 86_400_000).toISOString();
    const crossedAt = new Date(milliseconds - 43_200_000).toISOString();
    addJob(database, "job-time-crossing");
    addTask(database, "crossed-task", "job-time-crossing", crossedAt);
    const prepared = await lifecycle.prepareCareerLifecycleChange({
      kind: "archive",
      jobId: "job-time-crossing",
      operationId: "time-crossing-operation",
    }, previewedAt);
    assert.equal(prepared.counts.affected, 1);

    const RealDate = globalThis.Date;
    let fakeNow = previewedAt;
    let result;
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length === 0 ? [fakeNow] : args));
      }
    };
    globalThis.__careerPreviewLockState.onWriteAcquired = () => {
      fakeNow = NOW;
    };
    try {
      result = await lifecycle.commitPreparedCareerLifecycleChange(
        prepared,
        "pause",
      );
    } finally {
      globalThis.Date = RealDate;
      globalThis.__careerPreviewLockState.onWriteAcquired = null;
    }
    assert.equal(result.status, "changed");
    assert.equal(result.prepared.operationId, "time-crossing-operation");
    assert.deepEqual(result.prepared.counts, {
      affected: 0,
      elapsed: 1,
      edited: 0,
    });
    assert.deepEqual(result.prepared.allowedChoices, ["keep"]);
    assert.equal(state.batches, 0);
    assert.equal(
      database.selectValue("SELECT archived FROM career_jobs WHERE id='job-time-crossing'"),
      0,
    );
    assert.equal(
      database.selectValue("SELECT status FROM career_tasks WHERE id='crossed-task'"),
      "todo",
    );
  } finally {
    database.close();
  }
});

test("default preview time is captured after the shared lock is acquired", async () => {
  const { database } = await fixture();
  const RealDate = globalThis.Date;
  try {
    const beforeWaiting = new Date(milliseconds - 86_400_000).toISOString();
    const whileWaiting = new Date(milliseconds - 43_200_000).toISOString();
    addJob(database, "job-preview-wait");
    addTask(database, "waited-past-task", "job-preview-wait", whileWaiting);
    let fakeNow = beforeWaiting;
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length === 0 ? [fakeNow] : args));
      }
    };
    globalThis.__careerPreviewLockState.onReadAcquired = () => {
      fakeNow = NOW;
    };
    const prepared = await lifecycle.prepareCareerLifecycleChange({
      kind: "archive",
      jobId: "job-preview-wait",
    });
    assert.equal(prepared.preparedAt, NOW);
    assert.equal(prepared.impact[0].classification, "elapsed");
  } finally {
    globalThis.Date = RealDate;
    globalThis.__careerPreviewLockState.onReadAcquired = null;
    database.close();
  }
});

test("prepared commit fails closed when a real cross-tab lock is unavailable", async () => {
  const { database, state } = await fixture();
  try {
    addJob(database, "job-lock-required");
    addTask(database, "lock-task", "job-lock-required", FUTURE);
    const prepared = await lifecycle.prepareCareerLifecycleChange({
      kind: "archive",
      jobId: "job-lock-required",
    }, NOW);
    globalThis.__careerPreviewLockState.supportsRequired = false;
    await assert.rejects(
      lifecycle.commitPreparedCareerLifecycleChange(prepared, "pause"),
      /不支持安全的跨标签页职位变更/,
    );
    assert.equal(state.batches, 0);
    assert.equal(
      database.selectValue("SELECT archived FROM career_jobs WHERE id='job-lock-required'"),
      0,
    );
  } finally {
    database.close();
  }
});

test("choice values are exact and never coerced into a write", async () => {
  const { database, state } = await fixture();
  try {
    addJob(database, "job-choice");
    addTask(database, "choice-task", "job-choice", FUTURE);
    const prepared = await lifecycle.prepareCareerLifecycleChange({
      kind: "archive",
      jobId: "job-choice",
      operationId: "choice-operation",
    }, NOW);

    await assert.rejects(
      lifecycle.commitPreparedCareerLifecycleChange(prepared, "pause "),
      /请选择当前预览/,
    );
    await assert.rejects(
      lifecycle.commitPreparedCareerLifecycleChange(prepared, {
        toString() {
          return "pause";
        },
      }),
      /请选择当前预览/,
    );
    assert.equal(state.batches, 0);
    assert.equal(
      database.selectValue("SELECT archived FROM career_jobs WHERE id='job-choice'"),
      0,
    );
  } finally {
    database.close();
  }
});

test("restore previews classify future, elapsed, and edited rows without reviving the latter two", async () => {
  const { database } = await fixture();
  try {
    addJob(database, "job-restore");
    addTask(database, "task-future", "job-restore", FUTURE);
    addTask(database, "task-elapsed", "job-restore", ELAPSED);
    addTask(database, "task-edited", "job-restore", FUTURE);
    addInterview(database, "interview-future", "job-restore", FUTURE);
    addInterview(database, "interview-elapsed", "job-restore", ELAPSED);
    addInterview(database, "interview-edited", "job-restore", FUTURE);
    await lifecycle.archiveCareerJob("job-restore", {
      relatedAction: "pause",
      now: PAUSE_TIME,
      operationId: "pause-for-restore",
    });
    executeRun(
      database,
      "UPDATE career_tasks SET due_at=? WHERE id='task-edited'",
      [LATER],
    );
    executeRun(
      database,
      "UPDATE career_interviews SET scheduled_at=? WHERE id='interview-edited'",
      [LATER],
    );

    const prepared = await lifecycle.prepareCareerLifecycleChange({
      kind: "restore",
      jobId: "job-restore",
      operationId: "restore-preview",
    }, NOW);
    assert.equal(prepared.transition, "restore-active");
    assert.deepEqual(prepared.counts, { affected: 2, elapsed: 2, edited: 2 });
    assert.deepEqual(prepared.allowedChoices, ["keep-paused", "restore-paused"]);
    const result = await lifecycle.commitPreparedCareerLifecycleChange(
      prepared,
      "restore-paused",
    );
    assert.equal(result.status, "committed");

    assert.deepEqual(
      values(database, `SELECT id,status FROM career_tasks
        WHERE id LIKE 'task-%' ORDER BY id`),
      [
        { id: "task-edited", status: "canceled" },
        { id: "task-elapsed", status: "canceled" },
        { id: "task-future", status: "todo" },
      ],
    );
    assert.deepEqual(
      values(database, `SELECT id,status FROM career_interviews
        WHERE id LIKE 'interview-%' ORDER BY id`),
      [
        { id: "interview-edited", status: "canceled" },
        { id: "interview-elapsed", status: "canceled" },
        { id: "interview-future", status: "scheduled" },
      ],
    );
  } finally {
    database.close();
  }
});

test("the four stage directions expose only their valid choices and reject a no-op", async () => {
  const { database } = await fixture();
  try {
    addJob(database, "job-matrix");
    addTask(database, "matrix-task", "job-matrix", FUTURE);

    const activeToActive = await lifecycle.prepareCareerLifecycleChange({
      kind: "stage",
      jobId: "job-matrix",
      nextStageId: "active-two",
      operationId: "matrix-active",
    }, NOW);
    assert.equal(activeToActive.transition, "active-to-active");
    assert.deepEqual(activeToActive.allowedChoices, ["keep"]);
    assert.equal(activeToActive.requiresChoice, false);
    assert.equal(
      (await lifecycle.commitPreparedCareerLifecycleChange(activeToActive, "keep")).status,
      "committed",
    );
    assert.equal(
      database.selectValue("SELECT stage_id FROM career_jobs WHERE id='job-matrix'"),
      "active-two",
    );
    assert.equal(
      database.selectValue("SELECT status FROM career_tasks WHERE id='matrix-task'"),
      "todo",
    );

    await assert.rejects(
      lifecycle.prepareCareerLifecycleChange({
        kind: "stage",
        jobId: "job-matrix",
        nextStageId: "active-two",
      }, NOW),
      /已经在当前阶段/,
    );

    const activeToTerminal = await lifecycle.prepareCareerLifecycleChange({
      kind: "stage",
      jobId: "job-matrix",
      nextStageId: "accepted",
      operationId: "matrix-end",
    }, NOW);
    assert.equal(activeToTerminal.transition, "active-to-terminal");
    assert.deepEqual(activeToTerminal.allowedChoices, ["keep", "pause"]);
    await lifecycle.commitPreparedCareerLifecycleChange(activeToTerminal, "pause");

    const terminalToTerminal = await lifecycle.prepareCareerLifecycleChange({
      kind: "stage",
      jobId: "job-matrix",
      nextStageId: "rejected",
    }, NOW);
    assert.equal(terminalToTerminal.transition, "terminal-to-terminal");
    assert.deepEqual(terminalToTerminal.allowedChoices, ["keep"]);
    assert.equal(
      (await lifecycle.commitPreparedCareerLifecycleChange(
        terminalToTerminal,
        "keep",
      )).status,
      "committed",
    );
    assert.equal(
      database.selectValue("SELECT stage_id FROM career_jobs WHERE id='job-matrix'"),
      "rejected",
    );
    assert.equal(
      database.selectValue("SELECT status FROM career_tasks WHERE id='matrix-task'"),
      "canceled",
    );

    const terminalToActive = await lifecycle.prepareCareerLifecycleChange({
      kind: "stage",
      jobId: "job-matrix",
      nextStageId: "active-two",
    }, NOW);
    assert.equal(terminalToActive.transition, "terminal-to-active");
    assert.deepEqual(
      terminalToActive.allowedChoices,
      ["keep-paused", "restore-paused"],
    );
    assert.equal(
      (await lifecycle.commitPreparedCareerLifecycleChange(
        terminalToActive,
        "restore-paused",
      )).status,
      "committed",
    );
    assert.equal(
      database.selectValue("SELECT stage_id FROM career_jobs WHERE id='job-matrix'"),
      "active-two",
    );
    assert.equal(
      database.selectValue("SELECT status FROM career_tasks WHERE id='matrix-task'"),
      "todo",
    );

    addJob(database, "job-without-future-pressure");
    addTask(database, "only-elapsed", "job-without-future-pressure", ELAPSED);
    const noAffectedRows = await lifecycle.prepareCareerLifecycleChange({
      kind: "stage",
      jobId: "job-without-future-pressure",
      nextStageId: "accepted",
    }, NOW);
    assert.equal(noAffectedRows.counts.affected, 0);
    assert.equal(noAffectedRows.requiresChoice, false);
    assert.deepEqual(noAffectedRows.allowedChoices, ["keep"]);
  } finally {
    database.close();
  }
});

test("terminal reopen merges ended and archived pause lineages without duplicates", async () => {
  const { database } = await fixture();
  try {
    addJob(database, "job-merged");
    addTask(database, "paused-when-ended", "job-merged", FUTURE);
    await lifecycle.transitionCareerJobStage("job-merged", "accepted", {
      relatedAction: "pause",
      now: PAUSE_TIME,
      operationId: "merged-ended-operation",
    });
    addTask(database, "paused-when-archived", "job-merged", FUTURE);
    await lifecycle.archiveCareerJob("job-merged", {
      relatedAction: "pause",
      now: PAUSE_TIME,
      operationId: "merged-archived-operation",
    });
    await lifecycle.restoreCareerJob("job-merged", {
      relatedAction: "keep-paused",
      now: ELAPSED,
      operationId: "merged-unarchive-operation",
    });

    const prepared = await lifecycle.prepareCareerLifecycleChange({
      kind: "stage",
      jobId: "job-merged",
      nextStageId: "active",
      operationId: "merged-reopen-operation",
    }, NOW);
    assert.equal(prepared.transition, "terminal-to-active");
    assert.deepEqual(
      prepared.impact.map(({ id }) => id).sort(),
      ["paused-when-archived", "paused-when-ended"],
    );
    assert.equal(new Set(prepared.impact.map(({ id }) => id)).size, 2);
    const result = await lifecycle.commitPreparedCareerLifecycleChange(
      prepared,
      "restore-paused",
    );
    assert.equal(result.status, "committed");
    assert.deepEqual(
      values(database, `SELECT id,status FROM career_tasks
        WHERE job_id='job-merged' ORDER BY id`),
      [
        { id: "paused-when-archived", status: "todo" },
        { id: "paused-when-ended", status: "todo" },
      ],
    );
  } finally {
    database.close();
  }
});

test("a terminal archived job can return without reviving paused pressure", async () => {
  const { database } = await fixture();
  try {
    addJob(database, "job-terminal-archive", "accepted");
    addTask(database, "terminal-task", "job-terminal-archive", FUTURE);
    const archive = await lifecycle.prepareCareerLifecycleChange({
      kind: "archive",
      jobId: "job-terminal-archive",
      operationId: "terminal-archive",
    }, NOW);
    await lifecycle.commitPreparedCareerLifecycleChange(archive, "pause");

    await assert.rejects(
      lifecycle.prepareCareerLifecycleChange({
        kind: "stage",
        jobId: "job-terminal-archive",
        nextStageId: "active",
      }, NOW),
      /请先从归档中恢复/,
    );

    const restore = await lifecycle.prepareCareerLifecycleChange({
      kind: "restore",
      jobId: "job-terminal-archive",
      operationId: "terminal-restore",
    }, NOW);
    assert.equal(restore.transition, "restore-terminal");
    assert.equal(restore.counts.affected, 1);
    assert.equal(restore.requiresChoice, false);
    assert.deepEqual(restore.allowedChoices, ["keep-paused"]);
    await lifecycle.commitPreparedCareerLifecycleChange(restore, "keep-paused");
    assert.equal(
      database.selectValue("SELECT archived FROM career_jobs WHERE id='job-terminal-archive'"),
      0,
    );
    assert.equal(
      database.selectValue("SELECT status FROM career_tasks WHERE id='terminal-task'"),
      "canceled",
    );
  } finally {
    database.close();
  }
});

test("the exact future boundary matches SQLite and private interview prose never leaves prepare", async () => {
  const { database, state } = await fixture();
  try {
    addJob(database, "job-boundary");
    addTask(database, "at-boundary", "job-boundary", NOW);
    addTask(database, "after-boundary", "job-boundary", FUTURE);
    addInterview(database, "private-interview", "job-boundary", FUTURE);
    executeRun(
      database,
      `UPDATE career_interviews
        SET summary='PRIVATE SUMMARY TOKEN',
            raw_notes='PRIVATE NOTES TOKEN',
            questions_json='[{"question":"safe","answer":"PRIVATE ANSWER TOKEN","note":"PRIVATE QUESTION NOTE"}]',
            reflection='PRIVATE REFLECTION TOKEN'
        WHERE id='private-interview'`,
    );
    executeRun(
      database,
      "UPDATE career_jobs SET note='PRIVATE JOB NOTE TOKEN' WHERE id='job-boundary'",
    );

    const prepared = await lifecycle.prepareCareerLifecycleChange({
      kind: "archive",
      jobId: "job-boundary",
      operationId: "boundary-archive",
    }, NOW);
    assert.equal(
      prepared.impact.find(({ id }) => id === "at-boundary").classification,
      "elapsed",
    );
    assert.equal(
      prepared.impact.find(({ id }) => id === "after-boundary").classification,
      "affected",
    );
    assert.doesNotMatch(JSON.stringify(prepared), /PRIVATE/);

    executeRun(
      database,
      "UPDATE career_interviews SET summary='PRIVATE SUMMARY CHANGED' WHERE id='private-interview'",
    );
    const result = await lifecycle.commitPreparedCareerLifecycleChange(prepared, "pause");
    assert.equal(result.status, "changed");
    assert.equal(state.batches, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE SUMMARY CHANGED/);
  } finally {
    database.close();
  }
});
