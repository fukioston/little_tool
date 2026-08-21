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
  const result = ts.transpileModule(source, {
    fileName: relativePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  assert.deepEqual(
    (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  return result.outputText;
}

function executeRun(database, sql, params = []) {
  const statement = database.prepare(sql);
  try {
    if (params.length) statement.bind(params);
    while (statement.step()) {
      // Consume all rows returned by PRAGMAs or RETURNING clauses.
    }
  } finally {
    statement.finalize();
  }
  return {
    changes: Number(database.changes()),
    lastInsertRowId: database.selectValue("SELECT last_insert_rowid()") ?? null,
  };
}

function adapterFor(database, { failOnSql = null } = {}) {
  return {
    async init() {
      return {
        database: "zhiji",
        filename: "zhiji.sqlite3",
        persistent: true,
        sqliteVersion: "test",
        schemaVersion: Number(database.selectValue("PRAGMA user_version") ?? 0),
        seeded: false,
      };
    },
    async query(_name, sql, params = []) {
      const rows = database.selectObjects(sql, params);
      return { columns: [], rows, rowCount: rows.length };
    },
    async run(_name, sql, params = []) {
      return executeRun(database, sql, params);
    },
    async batch(_name, statements, options = {}) {
      const operation = () => statements.map(({ sql, params = [] }) => {
        if (failOnSql && sql.includes(failOnSql)) {
          throw new Error(`injected storage failure at ${failOnSql}`);
        }
        return executeRun(database, sql, params);
      });
      const results = options.transaction === false
        ? operation()
        : database.transaction("IMMEDIATE", operation);
      return {
        results,
        changes: results.reduce((sum, result) => sum + result.changes, 0),
      };
    },
    async export() {
      throw new Error("not needed in this test");
    },
    async import() {
      throw new Error("not needed in this test");
    },
  };
}

globalThis.__careerLocalDbProxy = {
  init(...args) {
    return globalThis.__careerLocalDbAdapter.init(...args);
  },
  query(...args) {
    return globalThis.__careerLocalDbAdapter.query(...args);
  },
  run(...args) {
    return globalThis.__careerLocalDbAdapter.run(...args);
  },
  batch(...args) {
    return globalThis.__careerLocalDbAdapter.batch(...args);
  },
  export(...args) {
    return globalThis.__careerLocalDbAdapter.export(...args);
  },
  import(...args) {
    return globalThis.__careerLocalDbAdapter.import(...args);
  },
};

const schemaJavaScript = await transpile("lib/schemas/zhiji.ts");
const schemaModuleUrl = moduleUrl(schemaJavaScript);
const careerSchema = await import(schemaModuleUrl);
let backupPlanJavaScript = await transpile("lib/career/backup-plan.ts");
backupPlanJavaScript = backupPlanJavaScript.replaceAll(
  '"../schemas/zhiji"',
  `"${schemaModuleUrl}"`,
);
const backupPlanModuleUrl = moduleUrl(backupPlanJavaScript);
const [lockJavaScript, rawDatabaseJavaScript] = await Promise.all([
  transpile("lib/career/lock.ts"),
  transpile("lib/career/db.ts"),
]);
const dependencyUrls = {
  "@/lib/local-db/client": moduleUrl(
    "export const localDb = globalThis.__careerLocalDbProxy;",
  ),
  "./lock": moduleUrl(lockJavaScript),
  "./backup-plan": backupPlanModuleUrl,
};
let databaseJavaScript = rawDatabaseJavaScript;
for (const [specifier, url] of Object.entries(dependencyUrls)) {
  databaseJavaScript = databaseJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const careerDb = await import(moduleUrl(databaseJavaScript));
const sqlite3 = await sqlite3InitModule();

async function databaseFixture() {
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  globalThis.__careerLocalDbAdapter = adapterFor(database);
  await careerDb.initializeCareerDb();
  return database;
}

function legacyDatabaseFixture(version, adapterOptions = {}) {
  assert.ok(version === 1 || version === 2);
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  database.transaction("IMMEDIATE", () => {
    for (const statement of careerSchema.ZHIJI_V1_SCHEMA_STATEMENTS) {
      executeRun(database, statement.sql, statement.params ?? []);
    }
    if (version === 2) {
      for (const statement of careerSchema.ZHIJI_V2_SCHEMA_MIGRATION_STATEMENTS) {
        executeRun(database, statement.sql, statement.params ?? []);
      }
    }
    for (const statement of careerDb.CAREER_STRUCTURAL_STAGE_STATEMENTS) {
      executeRun(database, statement.sql, statement.params ?? []);
    }
    database.exec(`PRAGMA application_id=${careerSchema.ZHIJI_APPLICATION_ID}`);
    database.exec(`PRAGMA user_version=${version}`);
  });
  globalThis.__careerLocalDbAdapter = adapterFor(database, adapterOptions);
  return database;
}

function directVersionTwoDatabaseFixture({
  applicationId = careerSchema.ZHIJI_APPLICATION_ID,
  userVersion = 2,
} = {}) {
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  const objectSql = Object.entries(
    careerSchema.ZHIJI_SCHEMA_OBJECT_SQL_VARIANTS[2],
  ).map(([name, variants]) => ({
    name,
    sql: name === "career_contacts" || name === "career_tasks"
      ? variants[1]
      : variants[0],
  }));
  database.transaction("IMMEDIATE", () => {
    for (const { sql } of objectSql.filter(({ sql }) =>
      /^CREATE\s+TABLE\b/i.test(sql))) database.exec(sql);
    for (const { sql } of objectSql.filter(({ sql }) =>
      /^CREATE\s+INDEX\b/i.test(sql))) database.exec(sql);
    for (const statement of careerDb.CAREER_STRUCTURAL_STAGE_STATEMENTS) {
      executeRun(database, statement.sql, statement.params ?? []);
    }
    database.exec(`PRAGMA application_id=${applicationId}`);
    database.exec(`PRAGMA user_version=${userVersion}`);
  });
  globalThis.__careerLocalDbAdapter = adapterFor(database);
  return database;
}

function generatedId(prefix, number) {
  return `${prefix}_00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function insert(database, sql, params) {
  executeRun(database, sql, params);
}

function hasColumn(database, table, column) {
  return database.selectObjects(`PRAGMA table_info(${table})`)
    .some((candidate) => candidate.name === column);
}

function installUntouchedLegacyDemo(database, sourceUserVersion = 3) {
  const now = "2026-08-21T06:15:32.456Z";
  const jobs = {
    Linear: generatedId("job", 1),
    Notion: generatedId("job", 2),
    Arc: generatedId("job", 3),
    Figma: generatedId("job", 4),
    Anthropic: generatedId("job", 5),
    Stripe: generatedId("job", 6),
  };
  const jobRows = [
    [jobs.Linear,"Linear","Product Designer","远程","LinkedIn","https://www.linkedin.com/jobs/","stage_preparing",3,"¥45k–60k / 月","远程","负责复杂协作产品的端到端体验，建立可扩展的设计系统。",null,"2026-08-24T10:00:00.000Z","Mina Chen","作品集需要突出复杂工作流项目。","设计系统,远程"],
    [jobs.Notion,"Notion","Product Engineer","新加坡","LinkedIn","https://www.linkedin.com/jobs/","stage_applied",2,"SGD 150k–190k / 年","混合办公","连接设计和工程，快速构建高质量协作体验。","2026-08-17T02:00:00.000Z",null,"Evan Lin","等待 recruiter 回复。","产品工程,AI"],
    [jobs.Arc,"Arc","Design Engineer","上海 / 远程","BOSS直聘","https://www.zhipin.com/","stage_interview",3,"¥40k–55k / 月","混合办公","以工程能力实现有辨识度的浏览器交互与动效。","2026-08-12T03:00:00.000Z",null,"林然","技术二面重点：性能和交互细节。","前端,交互"],
    [jobs.Figma,"Figma","Growth Designer","新加坡","官网","https://www.figma.com/careers/","stage_offer",3,"SGD 165k–205k / 年","混合办公","通过产品内增长实验帮助团队理解和采用协作工具。","2026-07-24T01:00:00.000Z",null,"Sophie Tan","周一前回复薪酬方案。","增长,设计"],
    [jobs.Anthropic,"Anthropic","Product Designer, Claude","旧金山 / 远程","LinkedIn","https://www.linkedin.com/jobs/","stage_saved",2,"USD 220k–280k / 年","远程","设计安全、清晰且值得信任的 AI 产品体验。",null,"2026-09-02T10:00:00.000Z","","先了解签证与远程政策。","AI,产品设计"],
    [jobs.Stripe,"Stripe","Staff Product Designer","新加坡","内推","https://stripe.com/jobs","stage_assessment",2,"SGD 180k–230k / 年","混合办公","负责金融基础设施的复杂工作流与平台体验。","2026-08-07T02:00:00.000Z",null,"Kai Wong","Case study 已提交。","B2B,金融科技"],
  ];
  for (const row of jobRows) {
    insert(database, `INSERT INTO career_jobs
      (id,company,role,location,source,source_url,stage_id,priority,salary,
       work_mode,description,applied_at,deadline,contact_name,note,tags,
       created_at,updated_at,archived,position)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0)`, [...row, now, now]);
  }

  const taskRows = [
    [jobs.Arc,"准备 Arc 技术二面：性能与动效","2026-08-22T06:00:00.000Z","面试准备",3],
    [jobs.Figma,"回复 Offer 薪酬方案","2026-08-23T03:00:00.000Z","跟进",3],
    [jobs.Linear,"精修复杂工作流案例页","2026-08-21T11:00:00.000Z","材料",2],
    [jobs.Notion,"向 Evan 发送礼貌跟进","2026-08-20T08:00:00.000Z","跟进",2],
  ];
  const taskHasContactId = hasColumn(database, "career_tasks", "contact_id");
  taskRows.forEach((row, index) => insert(database,
    taskHasContactId
      ? `INSERT INTO career_tasks
        (id,job_id,contact_id,title,due_at,kind,priority,status,created_at)
        VALUES (?,?,NULL,?,?,?,?, 'todo',?)`
      : `INSERT INTO career_tasks
        (id,job_id,title,due_at,kind,priority,status,created_at)
        VALUES (?,?,?,?,?,?,'todo',?)`,
    [generatedId("task", index + 1), ...row, now],
  ));

  const questions = JSON.stringify([
    { question: "如何在模糊需求下定义产品方向？", answer: "用目标、约束与验证路径拆解。", note: "补充量化结果" },
    { question: "讲一次跨团队推进困难项目的经历", answer: "使用 STAR 结构回答。", note: "强调自己的决策" },
  ]);
  const interviewRows = [
    [jobs.Arc,"技术二面","视频面试","2026-08-22T06:00:00.000Z",60,"Jason · Design Engineering Lead","https://meet.google.com/","scheduled","聚焦前端性能、复杂交互和与设计协作。","","[]",""],
    [jobs.Figma,"Hiring Manager","视频面试","2026-08-15T07:00:00.000Z",45,"Sarah · Growth Design","","completed","讨论增长实验、设计质量与数据之间的取舍。","整体交流顺畅，对 onboarding 实验追问较深。",questions,"案例结构清楚；下次应更早说明实验基线。"],
  ];
  interviewRows.forEach((row, index) => insert(database,
    `INSERT INTO career_interviews
      (id,job_id,round_name,interview_type,scheduled_at,duration,interviewer,
       meeting_url,status,summary,raw_notes,questions_json,reflection,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [generatedId("interview", index + 1), ...row, now, now],
  ));

  const contacts = [
    ["Arc","林然","招聘顾问","BOSS直聘","","","2026-08-19T02:00:00.000Z","2026-08-23T02:00:00.000Z","回复快，偏好在 BOSS 上沟通。"],
    ["Notion","Evan Lin","Recruiter","LinkedIn","evan@example.com","","2026-08-17T02:00:00.000Z","2026-08-21T08:00:00.000Z","通过共同联系人认识。"],
    ["Figma","Sophie Tan","People Partner","邮件","sophie@example.com","","2026-08-20T09:00:00.000Z","2026-08-23T03:00:00.000Z","负责 Offer 流程。"],
  ];
  const contactIds = [];
  const contactsHaveV2Columns = hasColumn(
    database,
    "career_contacts",
    "updated_at",
  );
  contacts.forEach((row, index) => {
    const contactId = generatedId("contact", index + 1);
    contactIds.push(contactId);
    insert(database, contactsHaveV2Columns
      ? `INSERT INTO career_contacts
        (id,company,name,role,channel,email,phone,last_contact_at,next_follow_up,
         notes,created_at,updated_at,archived)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`
      : `INSERT INTO career_contacts
        (id,company,name,role,channel,email,phone,last_contact_at,next_follow_up,
         notes,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    contactsHaveV2Columns ? [contactId, ...row, now, now] : [contactId, ...row, now]);
  });

  const materials = [
    ["产品设计主简历","简历","v4.2","2026-08-19T01:00:00.000Z",null,"ready","中文与英文版本内容同步。"],
    ["复杂工作流作品集","作品集","v2.8","2026-08-20T01:00:00.000Z",jobs.Linear,"draft","正在补充结果指标和决策过程。"],
    ["Figma 求职信","求职信","v1.1","2026-08-09T01:00:00.000Z",jobs.Figma,"sent","已随申请发送。"],
  ];
  const materialIds = [];
  materials.forEach((row, index) => {
    const materialId = generatedId("material", index + 1);
    materialIds.push(materialId);
    insert(database, `INSERT INTO career_materials
      (id,name,kind,version,updated_at,linked_job_id,status,notes,
       file_key,file_name,mime_type,byte_size)
      VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL)`, [materialId, ...row]);
  });

  const activities = [
    [jobs.Figma,"offer","Figma 发来正式 Offer","2026-08-20T08:00:00.000Z"],
    [jobs.Arc,"interview","Arc 技术二面已确认","2026-08-19T04:00:00.000Z"],
    [jobs.Stripe,"assessment","提交 Stripe case study","2026-08-18T10:00:00.000Z"],
  ];
  activities.forEach((row, index) => insert(database,
    "INSERT INTO career_activity (id,job_id,type,detail,created_at) VALUES (?,?,?,?,?)",
    [generatedId("activity", index + 1), ...row],
  ));
  insert(database, "INSERT INTO career_settings(key,value) VALUES ('seed_version','1')", []);
  insert(database, "INSERT INTO career_settings(key,value) VALUES ('weekly_goal','8')", []);
  if (hasColumn(database, "career_tasks", "updated_at")) {
    database.exec("UPDATE career_tasks SET updated_at=created_at");
  }
  database.exec(`PRAGMA user_version=${sourceUserVersion}`);
  return { jobs, contactIds, materialIds };
}

const businessTables = [
  "career_jobs",
  "career_tasks",
  "career_interviews",
  "career_contacts",
  "career_contact_jobs",
  "career_contact_interactions",
  "career_materials",
  "career_activity",
  "career_lifecycle_events",
];

function count(database, table) {
  return Number(database.selectValue(`SELECT COUNT(*) FROM ${table}`));
}

function assertIntegrity(database) {
  assert.equal(database.selectValue("PRAGMA integrity_check"), "ok");
  assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
  assert.equal(Number(database.selectValue("PRAGMA application_id")), 0x5a484a49);
  assert.equal(Number(database.selectValue("PRAGMA user_version")), 3);
  assert.deepEqual(
    database.selectObjects(
      "SELECT version,name FROM career_schema_migrations ORDER BY version",
    ).map((row) => ({ ...row })),
    [
      { version: 1, name: "initial-career-runtime" },
      { version: 2, name: "contact-history" },
      { version: 3, name: "reversible-lifecycle" },
    ],
  );
}

test("fresh Career runtime contains workflow structure and no invented life history", async () => {
  const database = await databaseFixture();
  try {
    assert.equal(count(database, "career_stages"), 9);
    for (const table of businessTables) assert.equal(count(database, table), 0, table);
    assert.equal(count(database, "career_settings"), 0);
    assert.equal(await careerDb.getCareerLegacyDemoResolution(), "none");
    assertIntegrity(database);
  } finally {
    database.close();
  }
});

test("an untouched legacy demo is removed atomically and only once", async () => {
  const database = await databaseFixture();
  try {
    installUntouchedLegacyDemo(database);
    await careerDb.initializeCareerDb();
    for (const table of businessTables) assert.equal(count(database, table), 0, table);
    assert.equal(count(database, "career_stages"), 9);
    assert.deepEqual(
      database.selectObjects("SELECT key,value FROM career_settings ORDER BY key")
        .map((row) => ({ ...row })),
      [{ key: "legacy_demo_v1_resolution", value: "cleaned" }],
    );
    assert.equal(await careerDb.getCareerLegacyDemoResolution(), "cleaned");

    await careerDb.initializeCareerDb();
    for (const table of businessTables) assert.equal(count(database, table), 0, table);
    assert.equal(count(database, "career_stages"), 9);
    assert.equal(await careerDb.getCareerLegacyDemoResolution(), "cleaned");
    assertIntegrity(database);
  } finally {
    database.close();
  }
});

test("an untouched v1 demo migrates atomically to canonical v3 before cleanup", async () => {
  const database = legacyDatabaseFixture(1);
  try {
    installUntouchedLegacyDemo(database, 1);
    await careerDb.initializeCareerDb();

    assert.equal(hasColumn(database, "career_contacts", "updated_at"), true);
    assert.equal(hasColumn(database, "career_contacts", "archived"), true);
    assert.equal(hasColumn(database, "career_tasks", "contact_id"), true);
    assert.equal(
      database.selectValue(
        "SELECT type FROM sqlite_schema WHERE name='career_contact_interactions'",
      ),
      "table",
    );
    assert.equal(hasColumn(database, "career_jobs", "archived_at"), true);
    assert.equal(hasColumn(database, "career_tasks", "canceled_at"), true);
    assert.equal(
      database.selectValue(
        "SELECT type FROM sqlite_schema WHERE name='career_lifecycle_events'",
      ),
      "table",
    );
    for (const table of businessTables) assert.equal(count(database, table), 0, table);
    assert.equal(count(database, "career_stages"), 9);
    assert.equal(await careerDb.getCareerLegacyDemoResolution(), "cleaned");
    assertIntegrity(database);
  } finally {
    database.close();
  }
});

test("v2 runtime migration preserves facts and backfills canonical v3 history", async () => {
  const database = legacyDatabaseFixture(2);
  try {
    const createdAt = "2026-08-20T01:00:00.000Z";
    const updatedAt = "2026-08-21T01:00:00.000Z";
    const terminalJob = generatedId("job", 81);
    const archivedJob = generatedId("job", 82);
    for (const [jobId, company, stageId, archived] of [
      [terminalJob, "Terminal fact", "stage_rejected", 0],
      [archivedJob, "Archived fact", "stage_applied", 1],
    ]) {
      insert(database, `INSERT INTO career_jobs
        (id,company,role,stage_id,created_at,updated_at,archived)
        VALUES (?,?,?,?,?,?,?)`, [
        jobId, company, "Role", stageId, createdAt, updatedAt, archived,
      ]);
    }
    insert(database, `INSERT INTO career_tasks
      (id,job_id,title,status,created_at) VALUES (?,?,?,'todo',?)`, [
      generatedId("task", 81), terminalJob, "Preserved task", createdAt,
    ]);
    insert(database, `INSERT INTO career_interviews
      (id,job_id,round_name,status,created_at,updated_at)
      VALUES (?,?,?,'completed',?,?)`, [
      generatedId("interview", 81), terminalJob, "Preserved interview",
      createdAt, updatedAt,
    ]);

    await careerDb.initializeCareerDb();

    assert.equal(count(database, "career_jobs"), 2);
    assert.equal(count(database, "career_tasks"), 1);
    assert.equal(count(database, "career_interviews"), 1);
    assert.deepEqual(
      database.selectObjects(`SELECT company,archived_at,ended_at
        FROM career_jobs ORDER BY company`).map((row) => ({ ...row })),
      [
        { company: "Archived fact", archived_at: updatedAt, ended_at: null },
        { company: "Terminal fact", archived_at: null, ended_at: updatedAt },
      ],
    );
    assert.equal(
      database.selectValue("SELECT updated_at FROM career_tasks"),
      createdAt,
    );
    assert.equal(count(database, "career_lifecycle_events"), 0);
    assertIntegrity(database);
  } finally {
    database.close();
  }
});

test("v2 migration normalizes only the known cancelled status alias", async () => {
  const database = legacyDatabaseFixture(2);
  try {
    const now = "2026-08-21T01:00:00.000Z";
    const jobId = generatedId("job", 86);
    insert(database, `INSERT INTO career_jobs
      (id,company,role,stage_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?)`, [
      jobId, "Alias fact", "Role", "stage_applied", now, now,
    ]);
    insert(database, `INSERT INTO career_tasks
      (id,job_id,title,status,created_at) VALUES (?,?,?,?,?)`, [
      generatedId("task", 86), jobId, "Alias task", "cancelled", now,
    ]);
    insert(database, `INSERT INTO career_interviews
      (id,job_id,round_name,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?)`, [
      generatedId("interview", 86), jobId, "Alias interview", "cancelled", now, now,
    ]);

    await careerDb.initializeCareerDb();

    assert.equal(database.selectValue("SELECT status FROM career_tasks"), "canceled");
    assert.equal(
      database.selectValue("SELECT status FROM career_interviews"),
      "canceled",
    );
    assertIntegrity(database);
  } finally {
    database.close();
  }
});

for (const entity of ["task", "interview"]) {
  test(`v2 migration rejects an unknown ${entity} status without changing facts`, async () => {
    const database = legacyDatabaseFixture(2);
    try {
      const now = "2026-08-21T01:00:00.000Z";
      const jobId = generatedId("job", entity === "task" ? 87 : 88);
      insert(database, `INSERT INTO career_jobs
        (id,company,role,stage_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?)`, [
        jobId, "Unknown status fact", "Role", "stage_applied", now, now,
      ]);
      if (entity === "task") {
        insert(database, `INSERT INTO career_tasks
          (id,job_id,title,status,created_at) VALUES (?,?,?,?,?)`, [
          generatedId("task", 87), jobId, "Unknown task", "mystery", now,
        ]);
      } else {
        insert(database, `INSERT INTO career_interviews
          (id,job_id,round_name,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?)`, [
          generatedId("interview", 88), jobId, "Unknown interview", "mystery",
          now, now,
        ]);
      }

      await assert.rejects(careerDb.initializeCareerDb(), /本次没有改动它/);

      assert.equal(Number(database.selectValue("PRAGMA user_version")), 2);
      assert.equal(
        database.selectValue(`SELECT status FROM career_${entity === "task" ? "tasks" : "interviews"}`),
        "mystery",
      );
      assert.equal(hasColumn(database, "career_jobs", "archived_at"), false);
      assert.equal(database.selectValue("PRAGMA integrity_check"), "ok");
    } finally {
      database.close();
    }
  });
}

test("the historical direct-v2 lineage upgrades to and reopens as exact direct-v3", async () => {
  const database = directVersionTwoDatabaseFixture();
  try {
    const now = "2026-08-21T01:00:00.000Z";
    const jobId = generatedId("job", 83);
    const contactId = generatedId("contact", 83);
    insert(database, `INSERT INTO career_jobs
      (id,company,role,stage_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?)`, [
      jobId, "Direct lineage fact", "Role", "stage_applied", now, now,
    ]);
    insert(database, `INSERT INTO career_contacts
      (id,name,created_at,updated_at) VALUES (?,?,?,?)`, [
      contactId, "Direct contact", now, now,
    ]);
    insert(database, `INSERT INTO career_tasks
      (id,job_id,contact_id,title,status,created_at)
      VALUES (?,?,?,?,?,?)`, [
      generatedId("task", 83), jobId, contactId, "Direct task", "todo", now,
    ]);

    await careerDb.initializeCareerDb();
    assert.equal(count(database, "career_jobs"), 1);
    assert.equal(count(database, "career_contacts"), 1);
    assert.equal(count(database, "career_tasks"), 1);
    assert.equal(database.selectValue("SELECT updated_at FROM career_tasks"), now);
    assertIntegrity(database);

    await careerDb.initializeCareerDb();
    assert.equal(count(database, "career_jobs"), 1);
    assertIntegrity(database);
  } finally {
    database.close();
  }
});

test("runtime repairs historical user_version 1 after the full migrated-v2 DDL landed", async () => {
  const database = legacyDatabaseFixture(2);
  try {
    const now = "2026-08-21T01:00:00.000Z";
    insert(database, `INSERT INTO career_jobs
      (id,company,role,stage_id,note,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`, [
      generatedId("job", 89), "Interrupted v1 fact", "Role", "stage_applied",
      "must survive", now, now,
    ]);
    database.exec("PRAGMA user_version=1");

    await careerDb.initializeCareerDb();

    assert.equal(database.selectValue("SELECT note FROM career_jobs"), "must survive");
    assertIntegrity(database);
  } finally {
    database.close();
  }
});

test("runtime adopts only the pre-identity v0 exact direct-v2 lineage", async () => {
  const database = directVersionTwoDatabaseFixture({
    applicationId: 0,
    userVersion: 0,
  });
  try {
    const now = "2026-08-21T01:00:00.000Z";
    insert(database, `INSERT INTO career_jobs
      (id,company,role,stage_id,note,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`, [
      generatedId("job", 90), "Interrupted v0 fact", "Role", "stage_applied",
      "must survive", now, now,
    ]);

    await careerDb.initializeCareerDb();

    assert.equal(database.selectValue("SELECT note FROM career_jobs"), "must survive");
    assertIntegrity(database);
  } finally {
    database.close();
  }
});

test("runtime narrowly repairs the known v3-identity with exact migrated-v2 DDL", async () => {
  const database = legacyDatabaseFixture(2);
  try {
    const now = "2026-08-21T01:00:00.000Z";
    insert(database, `INSERT INTO career_jobs
      (id,company,role,stage_id,note,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`, [
      generatedId("job", 84), "Interrupted v3 fact", "Role", "stage_applied",
      "must survive", now, now,
    ]);
    database.exec("PRAGMA user_version=3");

    await careerDb.initializeCareerDb();

    assert.equal(count(database, "career_jobs"), 1);
    assert.equal(
      database.selectValue("SELECT note FROM career_jobs"),
      "must survive",
    );
    assert.equal(hasColumn(database, "career_jobs", "archived_at"), true);
    assert.equal(
      database.selectValue(
        "SELECT type FROM sqlite_schema WHERE name='career_lifecycle_events'",
      ),
      "table",
    );
    assertIntegrity(database);
  } finally {
    database.close();
  }
});

test("interrupted-v3 repair rolls identity, DDL, and facts back on migration failure", async () => {
  const database = legacyDatabaseFixture(2, {
    failOnSql: "ALTER TABLE career_tasks ADD COLUMN canceled_at",
  });
  try {
    const now = "2026-08-21T01:00:00.000Z";
    insert(database, `INSERT INTO career_jobs
      (id,company,role,stage_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?)`, [
      generatedId("job", 85), "Interrupted rollback fact", "Role",
      "stage_applied", now, now,
    ]);
    database.exec("PRAGMA user_version=3");

    await assert.rejects(
      careerDb.initializeCareerDb(),
      /本次没有改动它/,
    );

    assert.equal(Number(database.selectValue("PRAGMA user_version")), 3);
    assert.equal(count(database, "career_jobs"), 1);
    assert.equal(hasColumn(database, "career_jobs", "archived_at"), false);
    assert.equal(
      database.selectValue(
        "SELECT type FROM sqlite_schema WHERE name='career_schema_migrations'",
      ),
      undefined,
    );
    assert.equal(database.selectValue("PRAGMA integrity_check"), "ok");
  } finally {
    database.close();
  }
});

test("a mid-v2-to-v3 storage failure rolls every schema and fact change back", async () => {
  const database = legacyDatabaseFixture(2, {
    failOnSql: "ALTER TABLE career_tasks ADD COLUMN canceled_at",
  });
  try {
    const now = "2026-08-21T01:00:00.000Z";
    insert(database, `INSERT INTO career_jobs
      (id,company,role,stage_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?)`, [
      generatedId("job", 91), "Rollback fact", "Role", "stage_applied", now, now,
    ]);

    await assert.rejects(
      careerDb.initializeCareerDb(),
      /本次没有改动它/,
    );

    assert.equal(Number(database.selectValue("PRAGMA user_version")), 2);
    assert.equal(count(database, "career_jobs"), 1);
    assert.equal(hasColumn(database, "career_jobs", "archived_at"), false);
    assert.equal(hasColumn(database, "career_tasks", "updated_at"), false);
    assert.equal(
      database.selectValue(
        "SELECT type FROM sqlite_schema WHERE name='career_schema_migrations'",
      ),
      undefined,
    );
    assert.equal(database.selectValue("PRAGMA integrity_check"), "ok");
    assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
  } finally {
    database.close();
  }
});

for (const scenario of [
  {
    name: "one edited field",
    mutate(database) {
      database.exec("UPDATE career_jobs SET note='这是我的真实备注' WHERE company='Linear'");
    },
    expectedJobs: 6,
  },
  {
    name: "one added application",
    mutate(database) {
      const now = "2026-08-21T06:15:32.456Z";
      insert(database, `INSERT INTO career_jobs
        (id,company,role,stage_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?)`,
      [generatedId("job", 99), "用户公司", "用户职位", "stage_saved", now, now]);
    },
    expectedJobs: 7,
  },
  {
    name: "one attached local file reference",
    mutate(database, fixture) {
      insert(database, `UPDATE career_materials
        SET file_key=?,file_name=?,mime_type=?,byte_size=? WHERE id=?`,
      ["opfs-user-file", "我的简历.pdf", "application/pdf", 128, fixture.materialIds[0]]);
    },
    expectedJobs: 6,
  },
  {
    name: "one real contact interaction",
    mutate(database, fixture) {
      insert(database, `INSERT INTO career_contact_interactions
        (id,contact_id,job_id,interaction_type,direction,channel,summary,notes,
         occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, [
        generatedId("interaction", 1), fixture.contactIds[0], fixture.jobs.Arc,
        "message", "outbound", "BOSS直聘", "真实沟通", "",
        "2026-08-21T07:00:00.000Z", "2026-08-21T07:00:00.000Z",
      ]);
    },
    expectedJobs: 6,
  },
  {
    name: "one real lifecycle event",
    mutate(database, fixture) {
      insert(database, `INSERT INTO career_lifecycle_events
        (id,job_id,entity_type,entity_id,action,reason,created_at)
        VALUES (?,?,?,?,?,?,?)`, [
        generatedId("lifecycle", 1), fixture.jobs.Arc, "job", fixture.jobs.Arc,
        "note_lifecycle_fact", "真实生命周期事实", "2026-08-21T07:00:00.000Z",
      ]);
    },
    expectedJobs: 6,
    expectedLifecycleEvents: 1,
  },
  {
    name: "one lifecycle operation marker",
    mutate(database) {
      database.exec(`UPDATE career_tasks
        SET lifecycle_operation_id='operation_user_fact'
        WHERE title='准备 Arc 技术二面：性能与动效'`);
    },
    expectedJobs: 6,
    expectedTaskOperationMarker: "operation_user_fact",
  },
]) {
  test(`legacy cleanup preserves everything and flags review after ${scenario.name}`, async () => {
    const database = await databaseFixture();
    try {
      const fixture = installUntouchedLegacyDemo(database);
      scenario.mutate(database, fixture);
      await careerDb.initializeCareerDb();
      assert.equal(count(database, "career_jobs"), scenario.expectedJobs);
      assert.equal(count(database, "career_tasks"), 4);
      assert.equal(count(database, "career_contacts"), 3);
      assert.equal(count(database, "career_materials"), 3);
      assert.equal(count(database, "career_activity"), 3);
      assert.equal(
        count(database, "career_lifecycle_events"),
        scenario.expectedLifecycleEvents ?? 0,
      );
      if (scenario.expectedTaskOperationMarker) {
        assert.equal(
          database.selectValue(`SELECT lifecycle_operation_id
            FROM career_tasks
            WHERE title='准备 Arc 技术二面：性能与动效'`),
          scenario.expectedTaskOperationMarker,
        );
      }
      assert.equal(await careerDb.getCareerLegacyDemoResolution(), "review-needed");

      await careerDb.initializeCareerDb();
      assert.equal(count(database, "career_jobs"), scenario.expectedJobs);
      assert.equal(await careerDb.getCareerLegacyDemoResolution(), "review-needed");
      assertIntegrity(database);
    } finally {
      database.close();
    }
  });
}

test("pre-existing user data without the legacy marker is never treated as demo data", async () => {
  const database = await databaseFixture();
  try {
    const now = "2026-08-21T06:15:32.456Z";
    insert(database, `INSERT INTO career_jobs
      (id,company,role,stage_id,note,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`, [
      generatedId("job", 70), "我的公司", "我的职位", "stage_applied",
      "真实记录", now, now,
    ]);
    await careerDb.initializeCareerDb();
    assert.equal(count(database, "career_jobs"), 1);
    assert.equal(
      database.selectValue("SELECT note FROM career_jobs WHERE company='我的公司'"),
      "真实记录",
    );
    assert.equal(await careerDb.getCareerLegacyDemoResolution(), "none");
    assertIntegrity(database);
  } finally {
    database.close();
  }
});

test("loadCareerData hides archived-job dependents without erasing terminal history", async () => {
  const database = await databaseFixture();
  try {
    const now = "2026-08-21T06:15:32.456Z";
    const jobs = {
      active: generatedId("job", 201),
      terminal: generatedId("job", 202),
      archived: generatedId("job", 203),
    };
    for (const [jobId, company, stageId, archived] of [
      [jobs.active, "Active", "stage_applied", 0],
      [jobs.terminal, "Terminal", "stage_rejected", 0],
      [jobs.archived, "Archived", "stage_interview", 1],
    ]) {
      insert(database, `INSERT INTO career_jobs
        (id,company,role,stage_id,created_at,updated_at,archived,archived_at)
        VALUES (?,?,?,?,?,?,?,?)`, [
        jobId, company, "Role", stageId, now, now, archived,
        archived ? now : null,
      ]);
    }

    for (const [number, jobId, title] of [
      [201, jobs.active, "active task"],
      [202, jobs.terminal, "terminal task"],
      [203, jobs.archived, "archived task"],
      [204, null, "unlinked task"],
    ]) {
      insert(database, `INSERT INTO career_tasks
        (id,job_id,title,status,created_at,updated_at)
        VALUES (?,?,?,'todo',?,?)`, [generatedId("task", number), jobId, title, now, now]);
    }

    for (const [number, jobId, roundName] of [
      [201, jobs.active, "active interview"],
      [202, jobs.terminal, "terminal interview"],
      [203, jobs.archived, "archived interview"],
    ]) {
      insert(database, `INSERT INTO career_interviews
        (id,job_id,round_name,status,created_at,updated_at)
        VALUES (?,?,?,'scheduled',?,?)`, [
        generatedId("interview", number), jobId, roundName, now, now,
      ]);
    }

    for (const [number, jobId, detail] of [
      [201, jobs.active, "active activity"],
      [202, jobs.terminal, "terminal activity"],
      [203, jobs.archived, "archived activity"],
      [204, null, "unlinked activity"],
    ]) {
      insert(database, `INSERT INTO career_activity
        (id,job_id,type,detail,created_at) VALUES (?,?,'test',?,?)`, [
        generatedId("activity", number), jobId, detail, now,
      ]);
    }

    const data = await careerDb.loadCareerData();
    assert.deepEqual(data.jobs.map(({ company }) => company).sort(), ["Active", "Terminal"]);
    assert.deepEqual(data.tasks.map(({ title }) => title).sort(), [
      "active task", "terminal task", "unlinked task",
    ]);
    assert.deepEqual(data.interviews.map(({ round_name }) => round_name).sort(), [
      "active interview", "terminal interview",
    ]);
    assert.deepEqual(data.activities.map(({ detail }) => detail).sort(), [
      "active activity", "terminal activity", "unlinked activity",
    ]);
    assertIntegrity(database);
  } finally {
    database.close();
  }
});

test("legacy resolution is lock-scoped, transactional, and never deletes OPFS", async () => {
  const source = await readFile(new URL("lib/career/db.ts", projectRoot), "utf8");
  assert.match(
    source,
    /withCareerWriteLock\(async \(lockContext\) =>[\s\S]*\.\.\.CAREER_LEGACY_DEMO_RESOLUTION_STATEMENTS[\s\S]*lockContext/,
  );
  assert.match(source, /CREATE TEMP TABLE IF NOT EXISTS __career_legacy_demo_guard/);
  assert.match(source, /CAREER_LEGACY_DEMO_RESOLUTION_SETTING/);
  assert.match(source, /export async function getCareerLegacyDemoResolution/);
  assert.doesNotMatch(source, /localDb\.reset|deleteLocalFile|removeLocalFile|opfs.*(?:delete|remove)/i);
});
