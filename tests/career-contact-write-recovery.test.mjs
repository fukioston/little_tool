import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const BASE = "2026-08-20T01:00:00.000Z";
const NOW = "2026-08-22T02:00:00.000Z";
const GEN1 = "10000000-0000-4000-8000-000000000001";
const GEN2 = "20000000-0000-4000-8000-000000000002";

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function transpile(path) {
  const source = await readFile(new URL(path, root), "utf8");
  const result = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  assert.deepEqual(result.diagnostics.filter(({ category }) =>
    category === ts.DiagnosticCategory.Error), []);
  return result.outputText;
}

const [schemaJs, markerRaw, contactRaw] = await Promise.all([
  transpile("lib/schemas/zhiji.ts"),
  transpile("lib/career/write-marker.ts"),
  transpile("lib/career/contact-writes.ts"),
]);
const calls = { query: 0, batch: 0, generation: 0, lockCallback: 0, broadcast: 0 };
globalThis.__contactDefaultCalls = calls;
const clientUrl = moduleUrl(`
  const c=()=>globalThis.__contactDefaultCalls;
  export const localDb={
    query(){c().query++;throw new Error('unexpected');},
    batch(){c().batch++;throw new Error('unexpected');},
    currentGeneration(){c().generation++;throw new Error('unexpected');}
  };
`);
const lockUrl = moduleUrl(`
  const c=()=>globalThis.__contactDefaultCalls;
  export function broadcastCareerDataChanged(){c().broadcast++;}
  export function withCareerWriteLock(task){c().lockCallback++;return task();}
`);
const markerUrl = moduleUrl(markerRaw
  .replaceAll('"@/lib/local-db/client"', `"${clientUrl}"`)
  .replaceAll('"./lock"', `"${lockUrl}"`));
const contactUrl = moduleUrl(contactRaw.replaceAll('"./write-marker"', `"${markerUrl}"`));
const [schema, marker, contactWrites, sqlite3] = await Promise.all([
  import(moduleUrl(schemaJs)), import(markerUrl), import(contactUrl), sqlite3InitModule(),
]);

function execute(database, statements) {
  let changes = 0;
  database.transaction("IMMEDIATE", () => {
    for (const { sql, params = [] } of statements) {
      const statement = database.prepare(sql);
      try {
        if (params.length) statement.bind(params);
        while (statement.step()) { /* consume */ }
        changes += Number(database.changes());
      } finally { statement.finalize(); }
    }
  });
  return { changes };
}

function install(database) {
  execute(database, [
    ...schema.ZHIJI_V1_SCHEMA_STATEMENTS,
    ...schema.ZHIJI_V2_SCHEMA_MIGRATION_STATEMENTS,
    ...schema.ZHIJI_V3_SCHEMA_MIGRATION_STATEMENTS,
    ...schema.ZHIJI_V4_SCHEMA_MIGRATION_STATEMENTS,
    ...schema.ZHIJI_V5_SCHEMA_MIGRATION_STATEMENTS,
  ]);
  database.exec(`PRAGMA application_id=${schema.ZHIJI_APPLICATION_ID}; PRAGMA user_version=5;`);
}

function insertBase(database) {
  database.exec(`
    INSERT INTO career_stages(id,name,color,position,is_terminal,hidden)
      VALUES('stage','进行中','#4488aa',0,0,0);
    INSERT INTO career_jobs(
      id,company,role,location,source,source_url,stage_id,priority,salary,
      work_mode,description,applied_at,deadline,contact_name,note,tags,
      created_at,updated_at,archived,position,archived_at,ended_at,
      archived_operation_id,ended_operation_id
    ) VALUES('job','Acme','Designer','','手动记录','','stage',1,'','','',NULL,NULL,
      '','','','${BASE}','${BASE}',0,0,NULL,NULL,NULL,NULL);
    INSERT INTO career_contacts(
      id,company,name,role,channel,email,phone,last_contact_at,next_follow_up,
      notes,created_at,updated_at,archived
    ) VALUES('contact','Acme','Ada','Recruiter','Email','','',NULL,NULL,'',
      '${BASE}','${BASE}',0);
    INSERT INTO career_contact_jobs(contact_id,job_id,created_at)
      VALUES('contact','job','${BASE}');
  `);
}

function uuid(index) {
  return `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function fixture() {
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  install(database);
  insertBase(database);
  const state = {
    active: 0,
    generationId: GEN1,
    generationSequence: 1,
    now: Date.parse(NOW),
    uuid: 1,
    batchFault: null,
    beforeBatch: null,
    broadcasts: [],
    queryCalls: 0,
    batchCalls: 0,
    lockCalls: 0,
  };
  const runtime = {
    async withExclusiveLock(operation) {
      state.lockCalls += 1;
      state.active += 1;
      try { return await operation(); }
      finally { state.active -= 1; }
    },
    async query(sql, params = []) {
      assert.equal(state.active, 1);
      state.queryCalls += 1;
      return { rows: database.selectObjects(sql, params) };
    },
    async batch(statements) {
      assert.equal(state.active, 1);
      state.batchCalls += 1;
      state.beforeBatch?.();
      state.beforeBatch = null;
      if (state.batchFault === "before") {
        state.batchFault = null;
        throw new Error("before commit");
      }
      const result = execute(database, statements);
      if (state.batchFault === "after") {
        state.batchFault = null;
        throw new Error("response lost");
      }
      return result;
    },
    async currentGeneration() {
      assert.equal(state.active, 1);
      return { generationId: state.generationId, sequence: state.generationSequence };
    },
    now() { assert.equal(state.active, 1); return state.now; },
    randomUUID() { assert.equal(state.active, 1); return uuid(state.uuid++); },
    broadcast(reason) { assert.equal(state.active, 1); state.broadcasts.push(reason); },
  };
  return {
    database,
    state,
    service: contactWrites.createCareerContactWriteStorageService(runtime),
    close() { database.close(); },
  };
}

async function resign(receipt, mutate) {
  const cloned = structuredClone(receipt);
  mutate(cloned);
  const { projectionSha256: _old, ...payload } = cloned;
  void _old;
  return marker.sealCareerWriteReceipt(payload);
}

function job(database, id = "job") {
  return database.selectObject(`SELECT id,company,role,location,source,source_url,
    stage_id,priority,salary,work_mode,description,applied_at,deadline,contact_name,
    note,tags,created_at,updated_at,archived,position,archived_at,ended_at,
    archived_operation_id,ended_operation_id FROM career_jobs WHERE id=?`, [id]);
}

function displayed(value, contactId = "contact") {
  const contact = contactId === null ? null : value.database.selectObject(`SELECT
    id,company,name,role,channel,email,phone,last_contact_at,next_follow_up,notes,
    created_at,updated_at,archived FROM career_contacts WHERE id=?`, [contactId]);
  const associations = contactId === null ? [] : value.database.selectObjects(
    "SELECT contact_id,job_id,created_at FROM career_contact_jobs WHERE contact_id=? ORDER BY job_id",
    [contactId]);
  const ids = associations.map(({ job_id }) => job_id);
  return {
    generationId: value.state.generationId,
    generationSequence: value.state.generationSequence,
    contact,
    associations,
    jobs: ids.length ? ids.map((id) => job(value.database, id)) : [],
  };
}

test("contact create writes marker atomically and historical proof survives later edits", async () => {
  const value = fixture();
  try {
    const expected = { ...displayed(value, null), jobs: [job(value.database)] };
    const receipt = await value.service.prepareCareerContactCreate({
      name: "Grace", company: "Beta", jobIds: ["job"],
    }, expected);
    assert.equal(await value.service.inspectCareerContactWrite(receipt), "expected");
    const result = await value.service.commitCareerContactWrite(receipt);
    assert.equal(result.outcome, "saved");
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_write_operations"), 1);
    value.database.exec(`UPDATE career_contacts SET notes='later' WHERE id='${receipt.after.contact.id}'`);
    assert.equal(await value.service.inspectCareerContactWrite(receipt), "exact_saved");
  } finally { value.close(); }
});

test("contact update converges after a lost batch response and stale peers cannot partially write", async () => {
  const value = fixture();
  try {
    const receipt = await value.service.prepareCareerContactUpdate({
      name: "Ada Lovelace", company: "Acme", role: "Recruiter", channel: "Email",
      email: "ada@example.test", phone: "", notes: "updated", jobIds: ["job"],
    }, displayed(value));
    value.state.batchFault = "after";
    assert.equal((await value.service.commitCareerContactWrite(receipt)).outcome, "saved");
    assert.equal(value.database.selectValue("SELECT name FROM career_contacts WHERE id='contact'"), "Ada Lovelace");

    const next = await value.service.prepareCareerContactUpdate({
      name: "Changed again", company: "Acme", role: "Recruiter", channel: "Email",
      email: "", phone: "", notes: "", jobIds: ["job"],
    }, displayed(value));
    value.database.exec("UPDATE career_contact_jobs SET created_at='2026-09-01T00:00:00.000Z' WHERE contact_id='contact'");
    assert.equal((await value.service.commitCareerContactWrite(next)).outcome, "changed");
    assert.equal(value.database.selectValue("SELECT name FROM career_contacts WHERE id='contact'"), "Ada Lovelace");
  } finally { value.close(); }
});

test("a partial contact update preserves every omitted field and association", async () => {
  const value = fixture();
  try {
    const before = displayed(value);
    const receipt = await value.service.prepareCareerContactUpdate({ notes: "only this changed" }, before);
    assert.equal(receipt.after.contact.name, before.contact.name);
    assert.equal(receipt.after.contact.company, before.contact.company);
    assert.equal(JSON.stringify(receipt.after.associations), JSON.stringify(before.associations));
    assert.equal((await value.service.commitCareerContactWrite(receipt)).outcome, "saved");
    assert.equal(value.database.selectValue("SELECT notes FROM career_contacts WHERE id='contact'"), "only this changed");
  } finally { value.close(); }
});

test("re-signed semantic forgeries for all six kinds are rejected before the lock", async () => {
  const cases = [
    async (value) => ({
      receipt: await value.service.prepareCareerContactCreate({ name: "Grace", jobIds: ["job"] }, {
        ...displayed(value, null), jobs: [job(value.database)],
      }),
      mutate(receipt) { receipt.after.associations[0].contact_id = "contact_other"; },
    }),
    async (value) => ({
      receipt: await value.service.prepareCareerContactUpdate({ notes: "updated" }, displayed(value)),
      mutate(receipt) { receipt.after.contact.id = "contact_other"; },
    }),
    async (value) => ({
      receipt: await value.service.prepareCareerContactArchive(displayed(value)),
      mutate(receipt) { receipt.after.contact.name = "redirected profile"; },
    }),
    async (value) => {
      value.database.exec("UPDATE career_contacts SET archived=1 WHERE id='contact'");
      return {
        receipt: await value.service.prepareCareerContactRestore(displayed(value)),
        mutate(receipt) { receipt.after.contact.archived = 1; },
      };
    },
    async (value) => ({
      receipt: await value.service.prepareCareerContactInteraction({
        contactId: "contact", direction: "mutual", summary: "Hello", jobId: "job",
      }, displayed(value)),
      mutate(receipt) { receipt.after.associations = []; },
    }),
    async (value) => ({
      receipt: await value.service.prepareCareerContactTask({
        contactId: "contact", title: "Follow up", jobId: "job",
      }, displayed(value)),
      mutate(receipt) { receipt.after.task.contact_id = "contact_other"; },
    }),
  ];
  for (const build of cases) {
    const value = fixture();
    try {
      const { receipt, mutate } = await build(value);
      const forged = await resign(receipt, mutate);
      const before = {
        lock: value.state.lockCalls,
        query: value.state.queryCalls,
        batch: value.state.batchCalls,
        broadcast: value.state.broadcasts.length,
      };
      assert.equal(await value.service.inspectCareerContactWrite(forged), "invalid_receipt");
      await assert.rejects(() => value.service.commitCareerContactWrite(forged),
        (error) => error.code === "invalid_receipt");
      assert.deepEqual({
        lock: value.state.lockCalls,
        query: value.state.queryCalls,
        batch: value.state.batchCalls,
        broadcast: value.state.broadcasts.length,
      }, before);
    } finally { value.close(); }
  }
});

test("canonical command intent rejects coordinated payload and operationAt re-signing before hooks", async () => {
  const cases = [
    async (value) => ({
      receipt: await value.service.prepareCareerContactCreate({ name: "Grace", jobIds: ["job"] }, {
        ...displayed(value, null), jobs: [job(value.database)],
      }),
      mutate(receipt, at) {
        receipt.after.contact.name = "Forged create";
        receipt.after.contact.created_at = at;
        receipt.after.contact.updated_at = at;
        receipt.after.associations[0].created_at = at;
      },
    }),
    async (value) => ({
      receipt: await value.service.prepareCareerContactUpdate({ notes: "updated" }, displayed(value)),
      mutate(receipt, at) { receipt.after.contact.notes = "forged update"; receipt.after.contact.updated_at = at; },
    }),
    async (value) => ({
      receipt: await value.service.prepareCareerContactInteraction({
        contactId: "contact", direction: "mutual", summary: "Hello", jobId: "job",
      }, displayed(value)),
      mutate(receipt, at) {
        receipt.after.contact.updated_at = at;
        receipt.after.interaction.summary = "forged interaction";
        receipt.after.interaction.created_at = at;
        receipt.after.interaction.occurred_at = at;
      },
    }),
    async (value) => ({
      receipt: await value.service.prepareCareerContactTask({
        contactId: "contact", title: "Follow up", jobId: "job",
      }, displayed(value)),
      mutate(receipt, at) {
        receipt.after.contact.updated_at = at;
        receipt.after.task.title = "forged task";
        receipt.after.task.created_at = at;
        receipt.after.task.updated_at = at;
      },
    }),
  ];
  for (const build of cases) {
    const value = fixture();
    try {
      const { receipt, mutate } = await build(value);
      const forged = await resign(receipt, (candidate) => {
        const at = "2026-08-22T03:00:00.000Z";
        candidate.operationAt = at;
        mutate(candidate, at);
      });
      const before = {
        lock: value.state.lockCalls,
        query: value.state.queryCalls,
        batch: value.state.batchCalls,
        broadcast: value.state.broadcasts.length,
      };
      assert.equal(await value.service.inspectCareerContactWrite(forged), "invalid_receipt");
      await assert.rejects(() => value.service.commitCareerContactWrite(forged),
        (error) => error.code === "invalid_receipt");
      assert.deepEqual({
        lock: value.state.lockCalls,
        query: value.state.queryCalls,
        batch: value.state.batchCalls,
        broadcast: value.state.broadcasts.length,
      }, before);
    } finally { value.close(); }
  }
});

test("prepare rejects a displayed job row not used by the canonical command", async () => {
  const value = fixture();
  try {
    const extra = { ...job(value.database), id: "job-extra" };
    execute(value.database, [{
      sql: `INSERT INTO career_jobs(${Object.keys(extra).join(",")}) VALUES(${Object.keys(extra).map(() => "?").join(",")})`,
      params: Object.keys(extra).map((key) => extra[key]),
    }]);
    const expected = displayed(value);
    expected.jobs.push(job(value.database, "job-extra"));
    await assert.rejects(() => value.service.prepareCareerContactUpdate({ notes: "updated" }, expected),
      /未被本次联系人命令使用/);
  } finally { value.close(); }
});

test("archive and restore markers remain exact across same-generation ABA", async () => {
  const value = fixture();
  try {
    const archive = await value.service.prepareCareerContactArchive(displayed(value));
    assert.equal((await value.service.commitCareerContactWrite(archive)).outcome, "saved");
    const restore = await value.service.prepareCareerContactRestore(displayed(value));
    assert.equal((await value.service.commitCareerContactWrite(restore)).outcome, "saved");
    assert.equal(await value.service.inspectCareerContactWrite(archive), "exact_saved");
    assert.equal(await value.service.inspectCareerContactWrite(restore), "exact_saved");
    value.state.generationId = GEN2;
    value.state.generationSequence = 2;
    assert.equal(await value.service.inspectCareerContactWrite(archive), "changed");
  } finally { value.close(); }
});

test("interaction and optional follow-up are one atomic marked transaction", async () => {
  const value = fixture();
  try {
    const receipt = await value.service.prepareCareerContactInteraction({
      contactId: "contact",
      occurredAt: NOW,
      direction: "mutual",
      summary: "Agreed next step",
      jobId: "job",
      associatedJobIds: ["job"],
      followUp: { title: "Send portfolio", dueAt: null, jobId: "job" },
    }, displayed(value));
    value.state.batchFault = "before";
    await assert.rejects(() => value.service.commitCareerContactWrite(receipt),
      (error) => error.code === "write_failed");
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_contact_interactions"), 0);
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_tasks"), 0);
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_write_operations"), 0);
    assert.equal((await value.service.commitCareerContactWrite(receipt)).outcome, "saved");
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_contact_interactions"), 1);
    assert.equal(value.database.selectValue("SELECT COUNT(*) FROM career_tasks"), 1);
  } finally { value.close(); }
});

test("contact task uses full displayed projection and marker wins over later task edits", async () => {
  const value = fixture();
  try {
    const receipt = await value.service.prepareCareerContactTask({
      contactId: "contact", title: "Follow up", jobId: "job", priority: 2,
    }, displayed(value));
    assert.equal((await value.service.commitCareerContactWrite(receipt)).outcome, "saved");
    value.database.exec(`UPDATE career_tasks SET title='later' WHERE id='${receipt.after.task.id}'`);
    assert.equal(await value.service.inspectCareerContactWrite(receipt), "exact_saved");
  } finally { value.close(); }
});

test("more than one thousand associations use chunk-safe preconditions", async () => {
  const value = fixture();
  try {
    const statements = [];
    for (let index = 0; index < 1_025; index += 1) {
      const id = `bulk-${String(index).padStart(4, "0")}`;
      statements.push({
        sql: `INSERT INTO career_jobs(id,company,role,location,source,source_url,
          stage_id,priority,salary,work_mode,description,applied_at,deadline,
          contact_name,note,tags,created_at,updated_at,archived,position,
          archived_at,ended_at,archived_operation_id,ended_operation_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [id,"Bulk","Role","","手动记录","","stage",1,"","","",null,null,"","","",BASE,BASE,0,index,null,null,null,null],
      }, {
        sql: "INSERT INTO career_contact_jobs(contact_id,job_id,created_at) VALUES('contact',?,?)",
        params: [id, BASE],
      });
    }
    execute(value.database, statements);
    const before = displayed(value);
    const receipt = await value.service.prepareCareerContactArchive(before);
    assert.equal((await value.service.commitCareerContactWrite(receipt)).outcome, "saved");
    assert.equal(value.database.selectValue("SELECT archived FROM career_contacts WHERE id='contact'"), 1);
  } finally { value.close(); }
});

test("a refused Web Lock enters no storage callback", async () => {
  let callbackEntered = false;
  let storageCalls = 0;
  const runtime = {
    async withExclusiveLock() { throw new Error("no lock"); },
    async query() { storageCalls += 1; throw new Error("query"); },
    async batch() { storageCalls += 1; throw new Error("batch"); },
    async currentGeneration() { storageCalls += 1; throw new Error("generation"); },
    now() { storageCalls += 1; return 0; },
    randomUUID() { storageCalls += 1; return uuid(1); },
    broadcast() { storageCalls += 1; },
  };
  const service = contactWrites.createCareerContactWriteStorageService(runtime);
  await assert.rejects(() => service.prepareCareerContactArchive({
    generationId: GEN1, generationSequence: 1, contact: null, associations: [], jobs: [],
  }), (error) => {
    callbackEntered = true;
    return error.code === "lock_unavailable";
  });
  assert.equal(callbackEntered, true);
  assert.equal(storageCalls, 0);
});
