import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

async function loadStandaloneTypeScriptModule(relativePath) {
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
    diagnostics.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

const [sqlite3, plan] = await Promise.all([
  sqlite3InitModule(),
  loadStandaloneTypeScriptModule("lib/career/contact-plan.ts"),
]);

function database() {
  const db = new sqlite3.oo1.DB(":memory:", "c");
  db.exec(`
    PRAGMA foreign_keys = ON;
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
      PRIMARY KEY (contact_id, job_id)
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
      created_at TEXT NOT NULL
    );
    INSERT INTO career_jobs VALUES
      ('job-a', 'Arc', '2026-01-01T00:00:00.000Z', 0),
      ('job-b', 'Notion', '2026-01-01T00:00:00.000Z', 0);
  `);
  return db;
}

function execute(db, statements) {
  db.transaction("IMMEDIATE", () => {
    for (const { sql, params } of statements) {
      const statement = db.prepare(sql);
      try {
        if (params?.length) statement.bind(params);
        while (statement.step()) {
          // Consume results so every statement is finalized inside the tx.
        }
      } finally {
        statement.finalize();
      }
    }
  });
}

function rows(db, sql) {
  return db.selectObjects(sql).map((row) => ({ ...row }));
}

const createdAt = "2026-08-21T01:00:00.000Z";

function insertContact(db, jobIds = ["job-a"]) {
  execute(db, plan.createCareerContactInsertStatements({
    id: "contact-a",
    name: "林然",
    company: "Arc",
    role: "招聘顾问",
    channel: "BOSS直聘",
    email: "",
    phone: "",
    notes: "偏好文字沟通",
    createdAt,
    updatedAt: createdAt,
    jobIds,
  }));
}

test("contact creation and explicit association replacement are atomic", () => {
  const db = database();
  try {
    insertContact(db);
    assert.deepEqual(
      rows(db, "SELECT contact_id,job_id FROM career_contact_jobs"),
      [{ contact_id: "contact-a", job_id: "job-a" }],
    );

    execute(db, plan.createCareerContactUpdateStatements({
      contactId: "contact-a",
      fields: { company: "The Browser Company", notes: "二面后跟进" },
      updatedAt: "2026-08-21T02:00:00.000Z",
      jobIds: ["job-b"],
    }));
    assert.deepEqual(
      rows(db, "SELECT company,notes,updated_at FROM career_contacts"),
      [{
        company: "The Browser Company",
        notes: "二面后跟进",
        updated_at: "2026-08-21T02:00:00.000Z",
      }],
    );
    assert.deepEqual(
      rows(db, "SELECT contact_id,job_id FROM career_contact_jobs"),
      [{ contact_id: "contact-a", job_id: "job-b" }],
    );
  } finally {
    db.close();
  }
});

test("an invalid associated job rolls the new contact back completely", () => {
  const db = database();
  try {
    assert.throws(() => insertContact(db, ["missing-job"]));
    assert.equal(Number(db.selectValue("SELECT COUNT(*) FROM career_contacts")), 0);
    assert.equal(Number(db.selectValue("SELECT COUNT(*) FROM career_contact_jobs")), 0);
  } finally {
    db.close();
  }
});

test("recording a real interaction can link jobs and create one follow-up task", () => {
  const db = database();
  try {
    insertContact(db, []);
    execute(db, plan.createCareerContactInteractionStatements({
      id: "interaction-a",
      contactId: "contact-a",
      jobId: "job-a",
      interactionType: "call",
      direction: "mutual",
      channel: "电话",
      summary: "确认技术二面安排",
      notes: "准备性能案例",
      occurredAt: "2026-08-21T03:00:00.000Z",
      createdAt: "2026-08-21T03:05:00.000Z",
      associatedJobIds: ["job-a"],
      followUp: {
        id: "task-a",
        title: "发送案例链接",
        dueAt: "2026-08-22T03:00:00.000Z",
        kind: "跟进",
        priority: 2,
        jobId: "job-a",
      },
    }));

    assert.equal(Number(db.selectValue("SELECT COUNT(*) FROM career_contact_interactions")), 1);
    assert.deepEqual(
      rows(db, "SELECT contact_id,job_id,title,due_at,status FROM career_tasks"),
      [{
        contact_id: "contact-a",
        job_id: "job-a",
        title: "发送案例链接",
        due_at: "2026-08-22T03:00:00.000Z",
        status: "todo",
      }],
    );
    assert.deepEqual(
      rows(db, "SELECT last_contact_at,next_follow_up FROM career_contacts"),
      [{
        last_contact_at: "2026-08-21T03:00:00.000Z",
        next_follow_up: "2026-08-22T03:00:00.000Z",
      }],
    );
    assert.equal(Number(db.selectValue("SELECT COUNT(*) FROM career_contact_jobs")), 1);
  } finally {
    db.close();
  }
});

test("standalone follow-up and archive plans preserve relationship history", () => {
  const db = database();
  try {
    insertContact(db, []);
    execute(db, plan.createCareerContactTaskStatements({
      id: "task-a",
      contactId: "contact-a",
      title: "下周礼貌跟进",
      dueAt: "2026-08-28T01:00:00.000Z",
      kind: "跟进",
      priority: 1,
      jobId: "job-b",
      createdAt: "2026-08-21T04:00:00.000Z",
    }));
    execute(db, plan.createCareerContactArchiveStatements(
      "contact-a",
      true,
      "2026-08-21T05:00:00.000Z",
    ));
    execute(db, plan.createCareerContactArchiveStatements(
      "contact-a",
      false,
      "2026-08-21T06:00:00.000Z",
    ));

    assert.equal(Number(db.selectValue("SELECT archived FROM career_contacts")), 0);
    assert.equal(Number(db.selectValue("SELECT COUNT(*) FROM career_tasks")), 1);
    assert.equal(Number(db.selectValue("SELECT COUNT(*) FROM career_contact_jobs")), 1);
  } finally {
    db.close();
  }
});

test("active-only plans reject archived or missing contacts without side effects", () => {
  const db = database();
  try {
    insertContact(db, []);
    execute(db, plan.createCareerContactArchiveStatements(
      "contact-a",
      true,
      "2026-08-21T05:00:00.000Z",
    ));
    assert.throws(() => execute(db, plan.createCareerContactTaskStatements({
      id: "task-a",
      contactId: "contact-a",
      title: "不应创建",
      dueAt: null,
      kind: "跟进",
      priority: 1,
      jobId: null,
      createdAt: "2026-08-21T06:00:00.000Z",
    })));
    assert.equal(Number(db.selectValue("SELECT COUNT(*) FROM career_tasks")), 0);
  } finally {
    db.close();
  }
});
