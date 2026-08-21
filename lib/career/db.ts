import { localDb } from "@/lib/local-db/client";
import type { SqlStatement } from "@/lib/local-db/types";
import {
  withCareerReadLock,
  withCareerWriteLock,
  type CareerLockContext,
} from "./lock";
import {
  CAREER_APPLICATION_ID,
  CAREER_USER_VERSION,
} from "./backup-plan";
import type {
  Activity,
  CareerData,
  Contact,
  Interview,
  Job,
  Material,
  Stage,
  Task,
} from "./types";

const DB = "career";

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function isoOffset(days: number, hour = 9, minute = 0) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function unwrapRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
}

function assertExclusiveContext(context: CareerLockContext | undefined) {
  if (context && context.mode !== "exclusive") {
    throw new Error("Career database mutations require an exclusive storage lock.");
  }
}

async function query<T>(
  sql: string,
  params: unknown[] = [],
  context?: CareerLockContext,
) {
  return withCareerReadLock(async () =>
    unwrapRows<T>(await localDb.query(DB, sql, params)), context);
}

export async function runCareerSql(
  sql: string,
  params: unknown[] = [],
  context?: CareerLockContext,
) {
  assertExclusiveContext(context);
  return withCareerWriteLock(() => localDb.run(DB, sql, params), context);
}

export async function runCareerBatch(
  statements: readonly SqlStatement[],
  context?: CareerLockContext,
) {
  assertExclusiveContext(context);
  return withCareerWriteLock(() => localDb.batch(DB, statements), context);
}

const schemaStatements: SqlStatement[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS career_stages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      position INTEGER NOT NULL,
      is_terminal INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0
    )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS career_jobs (
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
      position INTEGER NOT NULL DEFAULT 0
    )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS career_tasks (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
      contact_id TEXT REFERENCES career_contacts(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      due_at TEXT,
      kind TEXT NOT NULL DEFAULT '跟进',
      priority INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'todo',
      created_at TEXT NOT NULL
    )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS career_interviews (
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
    )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS career_contacts (
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
    )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS career_contact_jobs (
      contact_id TEXT NOT NULL REFERENCES career_contacts(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES career_jobs(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (contact_id, job_id)
    )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS career_contact_interactions (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES career_contacts(id) ON DELETE CASCADE,
      job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
      interaction_type TEXT NOT NULL DEFAULT 'message',
      direction TEXT NOT NULL DEFAULT 'outbound'
        CHECK (direction IN ('outbound', 'inbound', 'mutual')),
      channel TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS career_materials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT '简历',
      version TEXT NOT NULL DEFAULT 'v1.0',
      updated_at TEXT NOT NULL,
      linked_job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      notes TEXT NOT NULL DEFAULT ''
    )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS career_activity (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS career_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  },
  { sql: "CREATE INDEX IF NOT EXISTS idx_career_jobs_stage ON career_jobs(stage_id, archived, position)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_career_tasks_due ON career_tasks(status, due_at)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_career_interviews_date ON career_interviews(scheduled_at)" },
];

const contactIndexes: SqlStatement[] = [
  { sql: "CREATE INDEX IF NOT EXISTS idx_career_contacts_archived_name ON career_contacts(archived, name)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_career_tasks_contact_due ON career_tasks(contact_id, status, due_at)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_career_contact_jobs_job ON career_contact_jobs(job_id, contact_id)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_career_contact_interactions_contact_date ON career_contact_interactions(contact_id, occurred_at DESC)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_career_contact_interactions_job_date ON career_contact_interactions(job_id, occurred_at DESC)" },
];

function seedStatements(): SqlStatement[] {
  const now = new Date().toISOString();
  const jobs = {
    linear: id("job"),
    notion: id("job"),
    arc: id("job"),
    figma: id("job"),
    anthropic: id("job"),
    stripe: id("job"),
  };
  const q = JSON.stringify([
    { question: "如何在模糊需求下定义产品方向？", answer: "用目标、约束与验证路径拆解。", note: "补充量化结果" },
    { question: "讲一次跨团队推进困难项目的经历", answer: "使用 STAR 结构回答。", note: "强调自己的决策" },
  ]);

  const statements: SqlStatement[] = [
    ...[
      ["stage_saved", "收藏", "#8b8f96", 0, 0],
      ["stage_preparing", "准备中", "#bd7d45", 1, 0],
      ["stage_applied", "已投递", "#4d79a7", 2, 0],
      ["stage_assessment", "笔试 / 测评", "#806bb2", 3, 0],
      ["stage_interview", "面试中", "#a35673", 4, 0],
      ["stage_offer", "Offer", "#2b8a6e", 5, 0],
      ["stage_accepted", "已接受", "#27785f", 6, 1],
      ["stage_rejected", "未通过", "#9b5b54", 7, 1],
      ["stage_withdrawn", "已撤回", "#777b80", 8, 1],
    ].map(([stageId, name, color, position, terminal]) => ({
      sql: "INSERT INTO career_stages (id,name,color,position,is_terminal,hidden) VALUES (?,?,?,?,?,0)",
      params: [stageId, name, color, position, terminal],
    })),
    {
      sql: `INSERT INTO career_jobs
        (id,company,role,location,source,source_url,stage_id,priority,salary,work_mode,description,applied_at,deadline,contact_name,note,tags,created_at,updated_at,archived,position)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      params: [jobs.linear, "Linear", "Product Designer", "远程", "LinkedIn", "https://www.linkedin.com/jobs/", "stage_preparing", 3, "¥45k–60k / 月", "远程", "负责复杂协作产品的端到端体验，建立可扩展的设计系统。", null, isoOffset(3, 18), "Mina Chen", "作品集需要突出复杂工作流项目。", "设计系统,远程", now, now, 0],
    },
    {
      sql: `INSERT INTO career_jobs
        (id,company,role,location,source,source_url,stage_id,priority,salary,work_mode,description,applied_at,deadline,contact_name,note,tags,created_at,updated_at,archived,position)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      params: [jobs.notion, "Notion", "Product Engineer", "新加坡", "LinkedIn", "https://www.linkedin.com/jobs/", "stage_applied", 2, "SGD 150k–190k / 年", "混合办公", "连接设计和工程，快速构建高质量协作体验。", isoOffset(-4, 10), null, "Evan Lin", "等待 recruiter 回复。", "产品工程,AI", now, now, 0],
    },
    {
      sql: `INSERT INTO career_jobs
        (id,company,role,location,source,source_url,stage_id,priority,salary,work_mode,description,applied_at,deadline,contact_name,note,tags,created_at,updated_at,archived,position)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      params: [jobs.arc, "Arc", "Design Engineer", "上海 / 远程", "BOSS直聘", "https://www.zhipin.com/", "stage_interview", 3, "¥40k–55k / 月", "混合办公", "以工程能力实现有辨识度的浏览器交互与动效。", isoOffset(-9, 11), null, "林然", "技术二面重点：性能和交互细节。", "前端,交互", now, now, 0],
    },
    {
      sql: `INSERT INTO career_jobs
        (id,company,role,location,source,source_url,stage_id,priority,salary,work_mode,description,applied_at,deadline,contact_name,note,tags,created_at,updated_at,archived,position)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      params: [jobs.figma, "Figma", "Growth Designer", "新加坡", "官网", "https://www.figma.com/careers/", "stage_offer", 3, "SGD 165k–205k / 年", "混合办公", "通过产品内增长实验帮助团队理解和采用协作工具。", isoOffset(-28, 9), null, "Sophie Tan", "周一前回复薪酬方案。", "增长,设计", now, now, 0],
    },
    {
      sql: `INSERT INTO career_jobs
        (id,company,role,location,source,source_url,stage_id,priority,salary,work_mode,description,applied_at,deadline,contact_name,note,tags,created_at,updated_at,archived,position)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      params: [jobs.anthropic, "Anthropic", "Product Designer, Claude", "旧金山 / 远程", "LinkedIn", "https://www.linkedin.com/jobs/", "stage_saved", 2, "USD 220k–280k / 年", "远程", "设计安全、清晰且值得信任的 AI 产品体验。", null, isoOffset(12, 18), "", "先了解签证与远程政策。", "AI,产品设计", now, now, 0],
    },
    {
      sql: `INSERT INTO career_jobs
        (id,company,role,location,source,source_url,stage_id,priority,salary,work_mode,description,applied_at,deadline,contact_name,note,tags,created_at,updated_at,archived,position)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      params: [jobs.stripe, "Stripe", "Staff Product Designer", "新加坡", "内推", "https://stripe.com/jobs", "stage_assessment", 2, "SGD 180k–230k / 年", "混合办公", "负责金融基础设施的复杂工作流与平台体验。", isoOffset(-14, 10), null, "Kai Wong", "Case study 已提交。", "B2B,金融科技", now, now, 0],
    },
    {
      sql: "INSERT INTO career_tasks (id,job_id,title,due_at,kind,priority,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
      params: [id("task"), jobs.arc, "准备 Arc 技术二面：性能与动效", isoOffset(1, 14), "面试准备", 3, "todo", now],
    },
    {
      sql: "INSERT INTO career_tasks (id,job_id,title,due_at,kind,priority,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
      params: [id("task"), jobs.figma, "回复 Offer 薪酬方案", isoOffset(2, 11), "跟进", 3, "todo", now],
    },
    {
      sql: "INSERT INTO career_tasks (id,job_id,title,due_at,kind,priority,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
      params: [id("task"), jobs.linear, "精修复杂工作流案例页", isoOffset(0, 19), "材料", 2, "todo", now],
    },
    {
      sql: "INSERT INTO career_tasks (id,job_id,title,due_at,kind,priority,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
      params: [id("task"), jobs.notion, "向 Evan 发送礼貌跟进", isoOffset(-1, 16), "跟进", 2, "todo", now],
    },
    {
      sql: `INSERT INTO career_interviews
        (id,job_id,round_name,interview_type,scheduled_at,duration,interviewer,meeting_url,status,summary,raw_notes,questions_json,reflection,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [id("interview"), jobs.arc, "技术二面", "视频面试", isoOffset(1, 14), 60, "Jason · Design Engineering Lead", "https://meet.google.com/", "scheduled", "聚焦前端性能、复杂交互和与设计协作。", "", "[]", "", now, now],
    },
    {
      sql: `INSERT INTO career_interviews
        (id,job_id,round_name,interview_type,scheduled_at,duration,interviewer,meeting_url,status,summary,raw_notes,questions_json,reflection,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [id("interview"), jobs.figma, "Hiring Manager", "视频面试", isoOffset(-6, 15), 45, "Sarah · Growth Design", "", "completed", "讨论增长实验、设计质量与数据之间的取舍。", "整体交流顺畅，对 onboarding 实验追问较深。", q, "案例结构清楚；下次应更早说明实验基线。", now, now],
    },
    {
      sql: "INSERT INTO career_contacts (id,company,name,role,channel,email,phone,last_contact_at,next_follow_up,notes,created_at,updated_at,archived) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)",
      params: [id("contact"), "Arc", "林然", "招聘顾问", "BOSS直聘", "", "", isoOffset(-2, 10), isoOffset(2, 10), "回复快，偏好在 BOSS 上沟通。", now, now],
    },
    {
      sql: "INSERT INTO career_contacts (id,company,name,role,channel,email,phone,last_contact_at,next_follow_up,notes,created_at,updated_at,archived) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)",
      params: [id("contact"), "Notion", "Evan Lin", "Recruiter", "LinkedIn", "evan@example.com", "", isoOffset(-4, 10), isoOffset(0, 16), "通过共同联系人认识。", now, now],
    },
    {
      sql: "INSERT INTO career_contacts (id,company,name,role,channel,email,phone,last_contact_at,next_follow_up,notes,created_at,updated_at,archived) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)",
      params: [id("contact"), "Figma", "Sophie Tan", "People Partner", "邮件", "sophie@example.com", "", isoOffset(-1, 17), isoOffset(2, 11), "负责 Offer 流程。", now, now],
    },
    {
      sql: "INSERT INTO career_materials (id,name,kind,version,updated_at,linked_job_id,status,notes) VALUES (?,?,?,?,?,?,?,?)",
      params: [id("material"), "产品设计主简历", "简历", "v4.2", isoOffset(-2, 9), null, "ready", "中文与英文版本内容同步。"],
    },
    {
      sql: "INSERT INTO career_materials (id,name,kind,version,updated_at,linked_job_id,status,notes) VALUES (?,?,?,?,?,?,?,?)",
      params: [id("material"), "复杂工作流作品集", "作品集", "v2.8", isoOffset(-1, 9), jobs.linear, "draft", "正在补充结果指标和决策过程。"],
    },
    {
      sql: "INSERT INTO career_materials (id,name,kind,version,updated_at,linked_job_id,status,notes) VALUES (?,?,?,?,?,?,?,?)",
      params: [id("material"), "Figma 求职信", "求职信", "v1.1", isoOffset(-12, 9), jobs.figma, "sent", "已随申请发送。"],
    },
    {
      sql: "INSERT INTO career_activity (id,job_id,type,detail,created_at) VALUES (?,?,?,?,?)",
      params: [id("activity"), jobs.figma, "offer", "Figma 发来正式 Offer", isoOffset(-1, 16)],
    },
    {
      sql: "INSERT INTO career_activity (id,job_id,type,detail,created_at) VALUES (?,?,?,?,?)",
      params: [id("activity"), jobs.arc, "interview", "Arc 技术二面已确认", isoOffset(-2, 12)],
    },
    {
      sql: "INSERT INTO career_activity (id,job_id,type,detail,created_at) VALUES (?,?,?,?,?)",
      params: [id("activity"), jobs.stripe, "assessment", "提交 Stripe case study", isoOffset(-3, 18)],
    },
    { sql: "INSERT OR REPLACE INTO career_settings (key,value) VALUES ('seed_version','1')" },
    { sql: "INSERT OR REPLACE INTO career_settings (key,value) VALUES ('weekly_goal','8')" },
  ];
  return statements;
}

export async function initializeCareerDb(context?: CareerLockContext) {
  assertExclusiveContext(context);
  return withCareerWriteLock(async (lockContext) => {
    await localDb.init(DB);

    const [applicationId] = await query<{ application_id: number }>(
      "PRAGMA application_id",
      [],
      lockContext,
    );
    const currentApplicationId = Number(applicationId?.application_id ?? 0);
    if (currentApplicationId !== 0 && currentApplicationId !== CAREER_APPLICATION_ID) {
      throw new Error("当前 SQLite 文件不是职迹数据库，已停止初始化以保护原数据。");
    }

    const [userVersion] = await query<{ user_version: number }>(
      "PRAGMA user_version",
      [],
      lockContext,
    );
    const currentUserVersion = Number(userVersion?.user_version ?? 0);
    if (currentUserVersion > CAREER_USER_VERSION) {
      throw new Error("这份职迹数据库来自更新版本，请升级应用后再打开。");
    }

    await runCareerBatch(schemaStatements, lockContext);
    const materialColumns = await query<{ name: string }>(
      "PRAGMA table_info(career_materials)",
      [],
      lockContext,
    );
    const existingMaterialColumns = new Set(materialColumns.map((column) => column.name));
    const materialMigrations = [
      ["file_key", "TEXT"],
      ["file_name", "TEXT"],
      ["mime_type", "TEXT"],
      ["byte_size", "INTEGER"],
    ] as const;
    const missingMaterialColumns = materialMigrations
      .filter(([column]) => !existingMaterialColumns.has(column))
      .map(([column, type]) => ({
        sql: `ALTER TABLE career_materials ADD COLUMN ${column} ${type}`,
      }));
    if (missingMaterialColumns.length > 0) {
      await runCareerBatch(missingMaterialColumns, lockContext);
    }

    const [contactColumns, taskColumns] = await Promise.all([
      query<{ name: string }>("PRAGMA table_info(career_contacts)", [], lockContext),
      query<{ name: string }>("PRAGMA table_info(career_tasks)", [], lockContext),
    ]);
    const existingContactColumns = new Set(contactColumns.map((column) => column.name));
    const existingTaskColumns = new Set(taskColumns.map((column) => column.name));
    const contactMigrations: SqlStatement[] = [];
    if (!existingContactColumns.has("updated_at")) {
      contactMigrations.push({ sql: "ALTER TABLE career_contacts ADD COLUMN updated_at TEXT" });
    }
    if (!existingContactColumns.has("archived")) {
      contactMigrations.push({
        sql: "ALTER TABLE career_contacts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
      });
    }
    if (!existingTaskColumns.has("contact_id")) {
      contactMigrations.push({
        sql: "ALTER TABLE career_tasks ADD COLUMN contact_id TEXT REFERENCES career_contacts(id) ON DELETE SET NULL",
      });
    }
    if (contactMigrations.length > 0) {
      await runCareerBatch(contactMigrations, lockContext);
    }
    await runCareerBatch([
      {
        sql: `UPDATE career_contacts
          SET updated_at = created_at
          WHERE updated_at IS NULL OR updated_at = ''`,
      },
      ...contactIndexes,
    ], lockContext);

    const count = await query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM career_stages",
      [],
      lockContext,
    );
    if (Number(count[0]?.count ?? 0) === 0) {
      await runCareerBatch(seedStatements(), lockContext);
    }

    await runCareerBatch([
      { sql: `PRAGMA application_id = ${CAREER_APPLICATION_ID}` },
      { sql: `PRAGMA user_version = ${CAREER_USER_VERSION}` },
    ], lockContext);
  }, context);
}

export async function loadCareerData(context?: CareerLockContext): Promise<CareerData> {
  return withCareerReadLock(async (lockContext) => {
    const [stages, jobs, tasks, interviews, contacts, materials, activities] = await Promise.all([
      query<Stage>("SELECT * FROM career_stages ORDER BY position", [], lockContext),
      query<Job>("SELECT * FROM career_jobs WHERE archived = 0 ORDER BY position, updated_at DESC", [], lockContext),
      query<Task>("SELECT * FROM career_tasks ORDER BY status, due_at", [], lockContext),
      query<Interview>("SELECT * FROM career_interviews ORDER BY scheduled_at", [], lockContext),
      query<Contact>("SELECT * FROM career_contacts WHERE archived = 0 ORDER BY next_follow_up, name", [], lockContext),
      query<Material>("SELECT * FROM career_materials ORDER BY updated_at DESC", [], lockContext),
      query<Activity>("SELECT * FROM career_activity ORDER BY created_at DESC LIMIT 40", [], lockContext),
    ]);
    return { stages, jobs, tasks, interviews, contacts, materials, activities };
  }, context);
}

export async function addActivity(
  jobId: string | null,
  type: string,
  detail: string,
  context?: CareerLockContext,
) {
  return runCareerSql(
    "INSERT INTO career_activity (id,job_id,type,detail,created_at) VALUES (?,?,?,?,?)",
    [id("activity"), jobId, type, detail, new Date().toISOString()],
    context,
  );
}

export function newId(prefix: string) {
  return id(prefix);
}

export async function exportCareerDb(context?: CareerLockContext) {
  return withCareerReadLock(() => localDb.export(DB), context);
}

export async function importCareerDb(bytes: Uint8Array, context?: CareerLockContext) {
  assertExclusiveContext(context);
  return withCareerWriteLock(() => localDb.import(DB, bytes), context);
}
