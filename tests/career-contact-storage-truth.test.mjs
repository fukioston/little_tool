import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const CONTACT_ID = "contact_10000000-0000-4000-8000-000000000001";
const INTERACTION_ID = "interaction_20000000-0000-4000-8000-000000000001";
const INTERACTION_ID_2 = "interaction_20000000-0000-4000-8000-000000000002";
const TASK_ID = "task_30000000-0000-4000-8000-000000000001";
const TASK_ID_2 = "task_30000000-0000-4000-8000-000000000002";
const BASE_TIME = "2026-08-21T01:00:00.000Z";
const COMMAND_TIME = "2026-08-21T02:00:00.000Z";

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

const [source, lockSource, planJavaScript, rawServiceJavaScript] = await Promise.all([
  readFile(new URL("lib/career/contacts.ts", projectRoot), "utf8"),
  readFile(new URL("lib/career/lock.ts", projectRoot), "utf8"),
  transpile("lib/career/contact-plan.ts"),
  transpile("lib/career/contacts.ts"),
]);
const planUrl = moduleUrl(planJavaScript);
const dependencies = {
  "@/lib/local-db/client": moduleUrl(`
    export const localDb = {
      query(){ throw new Error("default runtime not used"); }
    };
  `),
  "./contact-plan": planUrl,
  "./db": moduleUrl(`
    export function newId(){ throw new Error("legacy id generator not used"); }
    export function runCareerBatch(){ throw new Error("default runtime not used"); }
  `),
  "./lock": moduleUrl(`
    export function broadcastCareerDataChanged(){ throw new Error("default runtime not used"); }
    export function withCareerReadLock(task){ return task(); }
    export function withCareerWriteLock(task){ return task(); }
  `),
};
let serviceJavaScript = rawServiceJavaScript;
for (const [specifier, url] of Object.entries(dependencies)) {
  serviceJavaScript = serviceJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const contacts = await import(moduleUrl(serviceJavaScript));
const sqlite3 = await sqlite3InitModule();

function execute(database, statements) {
  let changes = 0;
  database.transaction("IMMEDIATE", () => {
    for (const { sql, params = [] } of statements) {
      const statement = database.prepare(sql);
      try {
        if (params.length) statement.bind(params);
        while (statement.step()) {
          // Consume any rows before finalization.
        }
        changes += Number(database.changes());
      } finally {
        statement.finalize();
      }
    }
  });
  return { changes };
}

function fixture(options = {}) {
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE career_jobs (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE career_contacts (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      last_contact_at TEXT,
      next_follow_up TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE career_contact_jobs (
      contact_id TEXT NOT NULL REFERENCES career_contacts(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES career_jobs(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(contact_id,job_id)
    );
    CREATE TABLE career_contact_interactions (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES career_contacts(id) ON DELETE CASCADE,
      job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
      interaction_type TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('outbound','inbound','mutual')),
      channel TEXT NOT NULL,
      summary TEXT NOT NULL,
      notes TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE career_tasks (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
      contact_id TEXT REFERENCES career_contacts(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      due_at TEXT,
      kind TEXT NOT NULL,
      priority INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      canceled_at TEXT,
      cancellation_reason TEXT,
      lifecycle_previous_status TEXT,
      lifecycle_operation_id TEXT
    );
    INSERT INTO career_jobs VALUES
      ('job-a','Arc','${BASE_TIME}',0),
      ('job-b','Notion','${BASE_TIME}',1);
  `);

  const state = {
    activeLocks: 0,
    maxActiveLocks: 0,
    lockCalls: 0,
    tail: Promise.resolve(),
    batchCalls: 0,
    queryCalls: 0,
    batchFault: null,
    queryFailuresAfterBatch: 0,
    queryFailuresRemaining: 0,
    broadcasts: [],
    broadcastThrows: Boolean(options.broadcastThrows),
    now: options.now ?? Date.parse("2020-01-01T00:00:00.000Z"),
  };
  const requireLock = (label) => {
    assert.equal(state.activeLocks, 1, `${label} must hold one exclusive lock`);
  };
  const runtime = {
    async withExclusiveLock(operation) {
      state.lockCalls += 1;
      const previous = state.tail;
      let release;
      state.tail = new Promise((resolve) => {
        release = resolve;
      });
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
        throw new Error("SELECT response unavailable");
      }
      const rows = database.selectObjects(sql, params);
      return { rows, rowCount: rows.length, columns: [] };
    },
    async batch(statements) {
      requireLock("batch");
      state.batchCalls += 1;
      if (state.batchFault === "before") {
        state.batchFault = null;
        state.queryFailuresRemaining += state.queryFailuresAfterBatch;
        state.queryFailuresAfterBatch = 0;
        throw new Error("batch failed before commit");
      }
      const result = execute(database, statements);
      if (state.batchFault === "after") {
        state.batchFault = null;
        state.queryFailuresRemaining += state.queryFailuresAfterBatch;
        state.queryFailuresAfterBatch = 0;
        throw new Error("batch committed but response was lost");
      }
      return result;
    },
    now() {
      requireLock("clock");
      return state.now;
    },
    broadcast(reason) {
      requireLock("broadcast");
      state.broadcasts.push(reason);
      if (state.broadcastThrows) throw new Error("BroadcastChannel closed");
    },
  };
  return {
    database,
    state,
    runtime,
    service: contacts.createCareerContactStorageService(runtime),
    close() {
      database.close();
    },
  };
}

function createInput(overrides = {}) {
  return {
    contactId: CONTACT_ID,
    createdAt: BASE_TIME,
    name: "  林   然  ",
    company: " Arc ",
    role: "招聘顾问",
    channel: "",
    email: "",
    phone: "",
    notes: "  只记录事实\r\n第二行  ",
    jobIds: ["job-a", "job-a"],
    ...overrides,
  };
}

function insertContact(context, overrides = {}) {
  const row = {
    id: CONTACT_ID,
    company: "Arc",
    name: "林然",
    role: "招聘顾问",
    channel: "",
    email: "",
    phone: "",
    last: "2001-01-01T00:00:00.000Z",
    next: "2001-01-02T00:00:00.000Z",
    notes: "只记录事实",
    created: BASE_TIME,
    updated: BASE_TIME,
    archived: 0,
    ...overrides,
  };
  context.database.exec({
    sql: `INSERT INTO career_contacts
      (id,company,name,role,channel,email,phone,last_contact_at,next_follow_up,
        notes,created_at,updated_at,archived)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    bind: [
      row.id, row.company, row.name, row.role, row.channel, row.email, row.phone,
      row.last, row.next, row.notes, row.created, row.updated, row.archived,
    ],
  });
  context.database.exec({
    sql: `INSERT INTO career_contact_jobs(contact_id,job_id,created_at)
      VALUES(?,?,?)`,
    bind: [row.id, "job-a", row.created],
  });
  return row;
}

function expectedState(database, contactId = CONTACT_ID) {
  const contact = database.selectObject(
    "SELECT updated_at,archived FROM career_contacts WHERE id=?",
    [contactId],
  );
  return {
    expectedUpdatedAt: contact.updated_at,
    expectedArchived: Number(contact.archived) === 1,
    expectedJobIds: database.selectObjects(
      "SELECT job_id FROM career_contact_jobs WHERE contact_id=? ORDER BY job_id",
      [contactId],
    ).map(({ job_id }) => job_id),
  };
}

function interactionInput(database, overrides = {}) {
  return {
    interactionId: INTERACTION_ID,
    contactId: CONTACT_ID,
    createdAt: COMMAND_TIME,
    occurredAt: "2026-08-21T01:30:00.000Z",
    direction: "outbound",
    summary: "确认技术二面安排",
    jobId: "job-b",
    expectedContact: expectedState(database),
    followUp: {
      taskId: TASK_ID,
      title: "发送案例链接",
      dueAt: "2026-08-22T02:00:00.000Z",
      jobId: "job-b",
    },
    ...overrides,
  };
}

test("source exposes stable safe APIs, derives ordering, and never writes legacy facts", () => {
  for (const api of [
    "createCareerContactSafely",
    "recordCareerContactInteractionSafely",
    "createCareerContactTaskSafely",
    "inspectCareerContactWrite",
    "updateCareerContactSafely",
    "archiveCareerContactSafely",
    "restoreCareerContactSafely",
    "loadCareerContactExpectedState",
  ]) assert.match(source, new RegExp(`export function ${api}\\b|export async function ${api}\\b`));
  assert.doesNotMatch(source, /interactionType\s*:\s*[^\n]*"message"/);
  assert.doesNotMatch(source, /channel\s*:\s*[^\n]*"其他"/);
  assert.doesNotMatch(source, /direction\s*:\s*[^\n]*\?\?/);
  assert.match(source, /SELECT MAX\(interaction\.occurred_at\)/);
  assert.match(source, /SELECT MIN\(task\.due_at\)/);
  assert.doesNotMatch(source, /SET last_contact_at|SET next_follow_up/);
  assert.match(lockSource, /type: "data-changed", reason/);
  assert.match(lockSource, /event\.data\.type === "generation-changed"/);
});

test("simultaneous stable contact writes normalize exactly and insert once", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  const [first, second] = await Promise.all([
    context.service.createCareerContactSafely(createInput()),
    context.service.createCareerContactSafely(createInput()),
  ]);
  assert.deepEqual([first.outcome, second.outcome].sort(), ["already_saved", "saved"]);
  assert.equal(context.state.batchCalls, 1);
  assert.equal(context.state.maxActiveLocks, 1);
  assert.deepEqual(context.database.selectObject(
    "SELECT name,company,notes,last_contact_at,next_follow_up FROM career_contacts",
  ), {
    name: "林 然",
    company: "Arc",
    notes: "只记录事实\n第二行",
    last_contact_at: null,
    next_follow_up: null,
  });
  await assert.rejects(
    context.service.createCareerContactSafely(createInput({ name: "另一人" })),
    (error) => error.code === "conflict",
  );
  assert.equal(context.state.batchCalls, 1);
});

test("lost create response resolves exact, definite absence, or a JSON-safe receipt", async (t) => {
  const exact = fixture();
  const absent = fixture();
  const unknownExact = fixture();
  const unknownAbsent = fixture();
  t.after(() => {
    exact.close();
    absent.close();
    unknownExact.close();
    unknownAbsent.close();
  });

  exact.state.batchFault = "after";
  assert.equal(
    (await exact.service.createCareerContactSafely(createInput())).outcome,
    "saved",
  );

  absent.state.batchFault = "before";
  await assert.rejects(
    absent.service.createCareerContactSafely(createInput()),
    (error) => error.code === "write_failed",
  );
  assert.equal(Number(absent.database.selectValue("SELECT COUNT(*) FROM career_contacts")), 0);

  unknownExact.state.batchFault = "after";
  unknownExact.state.queryFailuresAfterBatch = 1;
  const exactPending = await unknownExact.service.createCareerContactSafely(createInput());
  assert.equal(exactPending.outcome, "outcome_uncertain");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(exactPending.receipt)));
  assert.equal(
    await unknownExact.service.inspectCareerContactWrite(exactPending.receipt),
    "exact_saved",
  );

  unknownAbsent.state.batchFault = "before";
  unknownAbsent.state.queryFailuresAfterBatch = 1;
  const absentPending = await unknownAbsent.service.createCareerContactSafely(createInput());
  assert.equal(absentPending.outcome, "outcome_uncertain");
  assert.equal(
    await unknownAbsent.service.inspectCareerContactWrite(absentPending.receipt),
    "absent",
  );
});

test("interaction, optional task, associations, and contact version are one exact unit", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  insertContact(context);
  const input = interactionInput(context.database);
  const first = await context.service.recordCareerContactInteractionSafely(input);
  assert.equal(first.outcome, "saved");
  assert.deepEqual(context.database.selectObject(
    `SELECT interaction_type,channel,direction,summary
      FROM career_contact_interactions WHERE id=?`,
    [INTERACTION_ID],
  ), {
    interaction_type: "",
    channel: "",
    direction: "outbound",
    summary: input.summary,
  });
  assert.equal(Number(context.database.selectValue(
    "SELECT COUNT(*) FROM career_tasks WHERE id=?",
    [TASK_ID],
  )), 1);
  assert.deepEqual(context.database.selectObjects(
    "SELECT job_id FROM career_contact_jobs WHERE contact_id=? ORDER BY job_id",
    [CONTACT_ID],
  ).map(({ job_id }) => job_id), ["job-a", "job-b"]);
  assert.deepEqual(context.database.selectObject(
    "SELECT last_contact_at,next_follow_up,updated_at FROM career_contacts WHERE id=?",
    [CONTACT_ID],
  ), {
    last_contact_at: "2001-01-01T00:00:00.000Z",
    next_follow_up: "2001-01-02T00:00:00.000Z",
    updated_at: COMMAND_TIME,
  });
  assert.equal(
    (await context.service.recordCareerContactInteractionSafely(input)).outcome,
    "already_saved",
  );
  assert.equal(context.state.batchCalls, 1);
  await assert.rejects(
    context.service.recordCareerContactInteractionSafely({
      ...input,
      summary: "另一份摘要",
    }),
    (error) => error.code === "conflict",
  );
  assert.equal(Number(context.database.selectValue(
    "SELECT COUNT(*) FROM career_contact_interactions",
  )), 1);
});

test("lost interaction response inspects the linked task and full association set", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  insertContact(context);
  context.state.batchFault = "after";
  context.state.queryFailuresAfterBatch = 1;
  const result = await context.service.recordCareerContactInteractionSafely(
    interactionInput(context.database),
  );
  assert.equal(result.outcome, "outcome_uncertain");
  assert.equal(await context.service.inspectCareerContactWrite(result.receipt), "exact_saved");

  context.database.exec({
    sql: "UPDATE career_tasks SET title='被改动' WHERE id=?",
    bind: [TASK_ID],
  });
  assert.equal(await context.service.inspectCareerContactWrite(result.receipt), "conflict");
});

test("an invalid interaction association rolls back every row and legacy value", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  insertContact(context);
  const before = context.database.selectObject(
    "SELECT * FROM career_contacts WHERE id=?",
    [CONTACT_ID],
  );
  await assert.rejects(
    context.service.recordCareerContactInteractionSafely(interactionInput(
      context.database,
      {
        interactionId: INTERACTION_ID_2,
        jobId: "missing-job",
        followUp: {
          taskId: TASK_ID_2,
          title: "不应留下",
          jobId: "missing-job",
        },
      },
    )),
    (error) => error.code === "write_failed",
  );
  assert.equal(Number(context.database.selectValue(
    "SELECT COUNT(*) FROM career_contact_interactions",
  )), 0);
  assert.equal(Number(context.database.selectValue("SELECT COUNT(*) FROM career_tasks")), 0);
  assert.deepEqual(
    context.database.selectObject("SELECT * FROM career_contacts WHERE id=?", [CONTACT_ID]),
    before,
  );
  assert.deepEqual(context.database.selectObjects(
    "SELECT job_id FROM career_contact_jobs WHERE contact_id=?",
    [CONTACT_ID],
  ).map(({ job_id }) => job_id), ["job-a"]);
});

test("standalone tasks use stable ids and keep legacy reminders untouched", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  insertContact(context);
  const input = {
    taskId: TASK_ID,
    contactId: CONTACT_ID,
    createdAt: COMMAND_TIME,
    title: "下周礼貌跟进",
    dueAt: "2026-08-29T00:00:00.000Z",
    jobId: "job-b",
    expectedContact: expectedState(context.database),
  };
  assert.equal((await context.service.createCareerContactTaskSafely(input)).outcome, "saved");
  assert.equal(
    (await context.service.createCareerContactTaskSafely(input)).outcome,
    "already_saved",
  );
  assert.deepEqual(context.database.selectObject(
    "SELECT last_contact_at,next_follow_up FROM career_contacts WHERE id=?",
    [CONTACT_ID],
  ), {
    last_contact_at: "2001-01-01T00:00:00.000Z",
    next_follow_up: "2001-01-02T00:00:00.000Z",
  });
});

test("CAS rejects stale update, archive, and restore with zero writes or link loss", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  insertContact(context);
  const snapshotA = expectedState(context.database);
  const updateB = await context.service.updateCareerContactSafely(
    CONTACT_ID,
    { name: "林然 B", jobIds: ["job-b"] },
    snapshotA,
  );
  assert.equal(updateB.outcome, "saved");
  assert.ok(Date.parse(updateB.updatedAt) > Date.parse(snapshotA.expectedUpdatedAt));
  const callsAfterB = context.state.batchCalls;

  assert.equal((await context.service.updateCareerContactSafely(
    CONTACT_ID,
    { notes: "来自旧标签页" },
    snapshotA,
  )).outcome, "changed");
  assert.equal((await context.service.archiveCareerContactSafely(
    CONTACT_ID,
    snapshotA,
  )).outcome, "changed");
  assert.equal(context.state.batchCalls, callsAfterB);
  assert.deepEqual(context.database.selectObjects(
    "SELECT job_id FROM career_contact_jobs WHERE contact_id=?",
    [CONTACT_ID],
  ).map(({ job_id }) => job_id), ["job-b"]);

  const current = expectedState(context.database);
  const archived = await context.service.archiveCareerContactSafely(CONTACT_ID, current);
  assert.equal(archived.outcome, "saved");
  const staleArchived = expectedState(context.database);
  const editArchived = await context.service.updateCareerContactSafely(
    CONTACT_ID,
    { role: "People Partner" },
    staleArchived,
  );
  assert.equal(editArchived.outcome, "saved");
  const beforeStaleRestoreCalls = context.state.batchCalls;
  assert.equal((await context.service.restoreCareerContactSafely(
    CONTACT_ID,
    staleArchived,
  )).outcome, "changed");
  assert.equal(context.state.batchCalls, beforeStaleRestoreCalls);
  assert.equal(Number(context.database.selectValue(
    "SELECT archived FROM career_contacts WHERE id=?",
    [CONTACT_ID],
  )), 1);

  const restored = await context.service.restoreCareerContactSafely(
    CONTACT_ID,
    expectedState(context.database),
  );
  assert.equal(restored.outcome, "saved");
  assert.equal(Number(context.database.selectValue(
    "SELECT archived FROM career_contacts WHERE id=?",
    [CONTACT_ID],
  )), 0);
});

test("archive response loss confirms full target and broadcast failure cannot reverse it", async (t) => {
  const context = fixture({ broadcastThrows: true });
  t.after(() => context.close());
  insertContact(context);
  context.state.batchFault = "after";
  const result = await context.service.archiveCareerContactSafely(
    CONTACT_ID,
    expectedState(context.database),
  );
  assert.equal(result.outcome, "saved");
  assert.equal(Number(context.database.selectValue(
    "SELECT archived FROM career_contacts WHERE id=?",
    [CONTACT_ID],
  )), 1);
  assert.deepEqual(context.database.selectObjects(
    "SELECT job_id FROM career_contact_jobs WHERE contact_id=?",
    [CONTACT_ID],
  ).map(({ job_id }) => job_id), ["job-a"]);
  assert.deepEqual(context.state.broadcasts, ["career-contact-archived"]);
});

test("direction omission is rejected before any database write", async (t) => {
  const context = fixture();
  t.after(() => context.close());
  insertContact(context);
  const input = interactionInput(context.database);
  delete input.direction;
  await assert.rejects(
    context.service.recordCareerContactInteractionSafely(input),
    (error) => error.code === "invalid_input",
  );
  assert.equal(context.state.lockCalls, 0);
  assert.equal(context.state.batchCalls, 0);
});
