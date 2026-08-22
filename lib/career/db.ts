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
  CAREER_V2_SCHEMA_OBJECT_COUNT,
  createCareerRuntimeUpgradeStatements,
  createFreshCareerSchemaStatements,
  createInterruptedCareerV2RuntimeRecoveryStatements,
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

export const CAREER_LEGACY_DEMO_RESOLUTION_SETTING =
  "legacy_demo_v1_resolution";
export const CAREER_LEGACY_DEMO_REVIEW_NEEDED = "review-needed";
const CAREER_LEGACY_DEMO_CLEANED = "cleaned";

export type CareerLegacyDemoResolution =
  | "none"
  | typeof CAREER_LEGACY_DEMO_CLEANED
  | typeof CAREER_LEGACY_DEMO_REVIEW_NEEDED;

/**
 * Stages describe the workflow rather than the person using it. A fresh
 * workspace receives only this structure; it must never imply applications,
 * contacts, goals, interviews, materials, or outcomes that did not happen.
 */
export const CAREER_STRUCTURAL_STAGE_STATEMENTS: readonly SqlStatement[] = [
  {
    sql: `INSERT INTO career_stages
      (id,name,color,position,is_terminal,hidden) VALUES
      ('stage_saved','收藏','#8b8f96',0,0,0),
      ('stage_preparing','准备中','#bd7d45',1,0,0),
      ('stage_applied','已投递','#4d79a7',2,0,0),
      ('stage_assessment','笔试 / 测评','#806bb2',3,0,0),
      ('stage_interview','面试中','#a35673',4,0,0),
      ('stage_offer','Offer','#2b8a6e',5,0,0),
      ('stage_accepted','已接受','#27785f',6,1,0),
      ('stage_rejected','未通过','#9b5b54',7,1,0),
      ('stage_withdrawn','已撤回','#777b80',8,1,0)`,
  },
];

/**
 * Resolve the one historical demo seed conservatively. The temporary guard is
 * populated only when every row and relationship matches the complete v1 demo
 * fingerprint, including generated-id shapes and time relationships. Every
 * destructive statement is conditional on that guard and runs in the same
 * IMMEDIATE transaction. Any deviation keeps every row and leaves a durable,
 * queryable review marker for the UI.
 */
export const CAREER_LEGACY_DEMO_RESOLUTION_STATEMENTS: readonly SqlStatement[] = [
  {
    sql: `CREATE TEMP TABLE IF NOT EXISTS __career_legacy_demo_guard (
      matched INTEGER NOT NULL UNIQUE CHECK (matched = 1)
    )`,
  },
  { sql: "DELETE FROM temp.__career_legacy_demo_guard" },
  {
    sql: `WITH
      expected_stages(id,name,color,position,is_terminal,hidden) AS (VALUES
        ('stage_saved','收藏','#8b8f96',0,0,0),
        ('stage_preparing','准备中','#bd7d45',1,0,0),
        ('stage_applied','已投递','#4d79a7',2,0,0),
        ('stage_assessment','笔试 / 测评','#806bb2',3,0,0),
        ('stage_interview','面试中','#a35673',4,0,0),
        ('stage_offer','Offer','#2b8a6e',5,0,0),
        ('stage_accepted','已接受','#27785f',6,1,0),
        ('stage_rejected','未通过','#9b5b54',7,1,0),
        ('stage_withdrawn','已撤回','#777b80',8,1,0)
      ),
      expected_jobs(
        company,role,location,source,source_url,stage_id,priority,salary,
        work_mode,description,applied_days,applied_suffix,deadline_days,
        deadline_suffix,contact_name,note,tags,archived,position
      ) AS (VALUES
        ('Linear','Product Designer','远程','LinkedIn','https://www.linkedin.com/jobs/','stage_preparing',3,'¥45k–60k / 月','远程','负责复杂协作产品的端到端体验，建立可扩展的设计系统。',NULL,NULL,3,'T10:00:00.000Z','Mina Chen','作品集需要突出复杂工作流项目。','设计系统,远程',0,0),
        ('Notion','Product Engineer','新加坡','LinkedIn','https://www.linkedin.com/jobs/','stage_applied',2,'SGD 150k–190k / 年','混合办公','连接设计和工程，快速构建高质量协作体验。',-4,'T02:00:00.000Z',NULL,NULL,'Evan Lin','等待 recruiter 回复。','产品工程,AI',0,0),
        ('Arc','Design Engineer','上海 / 远程','BOSS直聘','https://www.zhipin.com/','stage_interview',3,'¥40k–55k / 月','混合办公','以工程能力实现有辨识度的浏览器交互与动效。',-9,'T03:00:00.000Z',NULL,NULL,'林然','技术二面重点：性能和交互细节。','前端,交互',0,0),
        ('Figma','Growth Designer','新加坡','官网','https://www.figma.com/careers/','stage_offer',3,'SGD 165k–205k / 年','混合办公','通过产品内增长实验帮助团队理解和采用协作工具。',-28,'T01:00:00.000Z',NULL,NULL,'Sophie Tan','周一前回复薪酬方案。','增长,设计',0,0),
        ('Anthropic','Product Designer, Claude','旧金山 / 远程','LinkedIn','https://www.linkedin.com/jobs/','stage_saved',2,'USD 220k–280k / 年','远程','设计安全、清晰且值得信任的 AI 产品体验。',NULL,NULL,12,'T10:00:00.000Z','','先了解签证与远程政策。','AI,产品设计',0,0),
        ('Stripe','Staff Product Designer','新加坡','内推','https://stripe.com/jobs','stage_assessment',2,'SGD 180k–230k / 年','混合办公','负责金融基础设施的复杂工作流与平台体验。',-14,'T02:00:00.000Z',NULL,NULL,'Kai Wong','Case study 已提交。','B2B,金融科技',0,0)
      ),
      expected_tasks(title,company,due_days,due_suffix,kind,priority,status) AS (VALUES
        ('准备 Arc 技术二面：性能与动效','Arc',1,'T06:00:00.000Z','面试准备',3,'todo'),
        ('回复 Offer 薪酬方案','Figma',2,'T03:00:00.000Z','跟进',3,'todo'),
        ('精修复杂工作流案例页','Linear',0,'T11:00:00.000Z','材料',2,'todo'),
        ('向 Evan 发送礼貌跟进','Notion',-1,'T08:00:00.000Z','跟进',2,'todo')
      ),
      expected_interviews(
        round_name,company,interview_type,scheduled_days,scheduled_suffix,
        duration,interviewer,meeting_url,status,summary,raw_notes,
        questions_json,reflection
      ) AS (VALUES
        ('技术二面','Arc','视频面试',1,'T06:00:00.000Z',60,'Jason · Design Engineering Lead','https://meet.google.com/','scheduled','聚焦前端性能、复杂交互和与设计协作。','','[]',''),
        ('Hiring Manager','Figma','视频面试',-6,'T07:00:00.000Z',45,'Sarah · Growth Design','','completed','讨论增长实验、设计质量与数据之间的取舍。','整体交流顺畅，对 onboarding 实验追问较深。','[{"question":"如何在模糊需求下定义产品方向？","answer":"用目标、约束与验证路径拆解。","note":"补充量化结果"},{"question":"讲一次跨团队推进困难项目的经历","answer":"使用 STAR 结构回答。","note":"强调自己的决策"}]','案例结构清楚；下次应更早说明实验基线。')
      ),
      expected_contacts(
        company,name,role,channel,email,phone,last_days,last_suffix,next_days,
        next_suffix,notes,archived
      ) AS (VALUES
        ('Arc','林然','招聘顾问','BOSS直聘','','',-2,'T02:00:00.000Z',2,'T02:00:00.000Z','回复快，偏好在 BOSS 上沟通。',0),
        ('Notion','Evan Lin','Recruiter','LinkedIn','evan@example.com','',-4,'T02:00:00.000Z',0,'T08:00:00.000Z','通过共同联系人认识。',0),
        ('Figma','Sophie Tan','People Partner','邮件','sophie@example.com','',-1,'T09:00:00.000Z',2,'T03:00:00.000Z','负责 Offer 流程。',0)
      ),
      expected_materials(
        name,kind,version,updated_days,updated_suffix,company,status,notes
      ) AS (VALUES
        ('产品设计主简历','简历','v4.2',-2,'T01:00:00.000Z',NULL,'ready','中文与英文版本内容同步。'),
        ('复杂工作流作品集','作品集','v2.8',-1,'T01:00:00.000Z','Linear','draft','正在补充结果指标和决策过程。'),
        ('Figma 求职信','求职信','v1.1',-12,'T01:00:00.000Z','Figma','sent','已随申请发送。')
      ),
      expected_activity(type,company,detail,created_days,created_suffix) AS (VALUES
        ('offer','Figma','Figma 发来正式 Offer',-1,'T08:00:00.000Z'),
        ('interview','Arc','Arc 技术二面已确认',-2,'T04:00:00.000Z'),
        ('assessment','Stripe','提交 Stripe case study',-3,'T10:00:00.000Z')
      ),
      reference(created_at) AS (
        SELECT created_at FROM career_jobs WHERE company = 'Linear'
      )
      INSERT INTO temp.__career_legacy_demo_guard(matched)
      SELECT 1
      WHERE (SELECT COUNT(*) FROM career_settings) = 2
        AND (SELECT value FROM career_settings WHERE key = 'seed_version') = '1'
        AND (SELECT value FROM career_settings WHERE key = 'weekly_goal') = '8'
        AND (SELECT COUNT(*) FROM career_stages) = 9
        AND NOT EXISTS (
          SELECT 1 FROM career_stages AS actual
          LEFT JOIN expected_stages AS expected ON expected.id = actual.id
          WHERE expected.id IS NULL
            OR actual.name IS NOT expected.name
            OR actual.color IS NOT expected.color
            OR actual.position IS NOT expected.position
            OR actual.is_terminal IS NOT expected.is_terminal
            OR actual.hidden IS NOT expected.hidden
        )
        AND (SELECT COUNT(*) FROM career_jobs) = 6
        AND (SELECT COUNT(DISTINCT company) FROM career_jobs) = 6
        AND NOT EXISTS (
          SELECT 1 FROM career_jobs AS actual
          LEFT JOIN expected_jobs AS expected ON expected.company = actual.company
          WHERE expected.company IS NULL
            OR actual.id NOT GLOB 'job_????????-????-4???-[89ab]???-????????????'
            OR actual.role IS NOT expected.role
            OR actual.location IS NOT expected.location
            OR actual.source IS NOT expected.source
            OR actual.source_url IS NOT expected.source_url
            OR actual.stage_id IS NOT expected.stage_id
            OR actual.priority IS NOT expected.priority
            OR actual.salary IS NOT expected.salary
            OR actual.work_mode IS NOT expected.work_mode
            OR actual.description IS NOT expected.description
            OR actual.applied_at IS NOT CASE
              WHEN expected.applied_days IS NULL THEN NULL
              ELSE date(actual.created_at,'+8 hours',printf('%+d days',expected.applied_days)) || expected.applied_suffix
            END
            OR actual.deadline IS NOT CASE
              WHEN expected.deadline_days IS NULL THEN NULL
              ELSE date(actual.created_at,'+8 hours',printf('%+d days',expected.deadline_days)) || expected.deadline_suffix
            END
            OR actual.contact_name IS NOT expected.contact_name
            OR actual.note IS NOT expected.note
            OR actual.tags IS NOT expected.tags
            OR actual.created_at IS NOT actual.updated_at
            OR actual.created_at IS NOT (SELECT created_at FROM reference)
            OR actual.archived IS NOT expected.archived
            OR actual.position IS NOT expected.position
            OR actual.archived_at IS NOT NULL
            OR actual.ended_at IS NOT NULL
            OR actual.archived_operation_id IS NOT NULL
            OR actual.ended_operation_id IS NOT NULL
        )
        AND (SELECT COUNT(*) FROM career_tasks) = 4
        AND (SELECT COUNT(DISTINCT title) FROM career_tasks) = 4
        AND NOT EXISTS (
          SELECT 1 FROM career_tasks AS actual
          LEFT JOIN career_jobs AS job ON job.id = actual.job_id
          LEFT JOIN expected_tasks AS expected ON expected.title = actual.title
          WHERE expected.title IS NULL
            OR actual.id NOT GLOB 'task_????????-????-4???-[89ab]???-????????????'
            OR job.company IS NOT expected.company
            OR actual.contact_id IS NOT NULL
            OR actual.due_at IS NOT (date((SELECT created_at FROM reference),'+8 hours',printf('%+d days',expected.due_days)) || expected.due_suffix)
            OR actual.kind IS NOT expected.kind
            OR actual.priority IS NOT expected.priority
            OR actual.status IS NOT expected.status
            OR actual.created_at IS NOT (SELECT created_at FROM reference)
            OR actual.updated_at IS NOT actual.created_at
            OR actual.canceled_at IS NOT NULL
            OR actual.cancellation_reason IS NOT NULL
            OR actual.lifecycle_previous_status IS NOT NULL
            OR actual.lifecycle_operation_id IS NOT NULL
        )
        AND (SELECT COUNT(*) FROM career_interviews) = 2
        AND (SELECT COUNT(DISTINCT round_name) FROM career_interviews) = 2
        AND NOT EXISTS (
          SELECT 1 FROM career_interviews AS actual
          LEFT JOIN career_jobs AS job ON job.id = actual.job_id
          LEFT JOIN expected_interviews AS expected ON expected.round_name = actual.round_name
          WHERE expected.round_name IS NULL
            OR actual.id NOT GLOB 'interview_????????-????-4???-[89ab]???-????????????'
            OR job.company IS NOT expected.company
            OR actual.interview_type IS NOT expected.interview_type
            OR actual.scheduled_at IS NOT (date((SELECT created_at FROM reference),'+8 hours',printf('%+d days',expected.scheduled_days)) || expected.scheduled_suffix)
            OR actual.duration IS NOT expected.duration
            OR actual.interviewer IS NOT expected.interviewer
            OR actual.meeting_url IS NOT expected.meeting_url
            OR actual.status IS NOT expected.status
            OR actual.summary IS NOT expected.summary
            OR actual.raw_notes IS NOT expected.raw_notes
            OR actual.questions_json IS NOT expected.questions_json
            OR actual.reflection IS NOT expected.reflection
            OR actual.created_at IS NOT (SELECT created_at FROM reference)
            OR actual.updated_at IS NOT (SELECT created_at FROM reference)
            OR actual.canceled_at IS NOT NULL
            OR actual.cancellation_reason IS NOT NULL
            OR actual.lifecycle_previous_status IS NOT NULL
            OR actual.lifecycle_operation_id IS NOT NULL
        )
        AND (SELECT COUNT(*) FROM career_contacts) = 3
        AND (SELECT COUNT(DISTINCT name) FROM career_contacts) = 3
        AND NOT EXISTS (
          SELECT 1 FROM career_contacts AS actual
          LEFT JOIN expected_contacts AS expected ON expected.name = actual.name
          WHERE expected.name IS NULL
            OR actual.id NOT GLOB 'contact_????????-????-4???-[89ab]???-????????????'
            OR actual.company IS NOT expected.company
            OR actual.role IS NOT expected.role
            OR actual.channel IS NOT expected.channel
            OR actual.email IS NOT expected.email
            OR actual.phone IS NOT expected.phone
            OR actual.last_contact_at IS NOT (date((SELECT created_at FROM reference),'+8 hours',printf('%+d days',expected.last_days)) || expected.last_suffix)
            OR actual.next_follow_up IS NOT (date((SELECT created_at FROM reference),'+8 hours',printf('%+d days',expected.next_days)) || expected.next_suffix)
            OR actual.notes IS NOT expected.notes
            OR actual.created_at IS NOT (SELECT created_at FROM reference)
            OR actual.updated_at IS NOT (SELECT created_at FROM reference)
            OR actual.archived IS NOT expected.archived
        )
        AND (SELECT COUNT(*) FROM career_contact_jobs) = 0
        AND (SELECT COUNT(*) FROM career_contact_interactions) = 0
        AND (SELECT COUNT(*) FROM career_lifecycle_events) = 0
        AND (SELECT COUNT(*) FROM career_core_write_operations) = 0
        AND (SELECT COUNT(*) FROM career_materials) = 3
        AND (SELECT COUNT(DISTINCT name) FROM career_materials) = 3
        AND NOT EXISTS (
          SELECT 1 FROM career_materials AS actual
          LEFT JOIN career_jobs AS job ON job.id = actual.linked_job_id
          LEFT JOIN expected_materials AS expected ON expected.name = actual.name
          WHERE expected.name IS NULL
            OR actual.id NOT GLOB 'material_????????-????-4???-[89ab]???-????????????'
            OR actual.kind IS NOT expected.kind
            OR actual.version IS NOT expected.version
            OR actual.updated_at IS NOT (date((SELECT created_at FROM reference),'+8 hours',printf('%+d days',expected.updated_days)) || expected.updated_suffix)
            OR job.company IS NOT expected.company
            OR actual.status IS NOT expected.status
            OR actual.notes IS NOT expected.notes
            OR actual.file_key IS NOT NULL
            OR actual.file_name IS NOT NULL
            OR actual.mime_type IS NOT NULL
            OR actual.byte_size IS NOT NULL
        )
        AND (SELECT COUNT(*) FROM career_activity) = 3
        AND (SELECT COUNT(DISTINCT type) FROM career_activity) = 3
        AND NOT EXISTS (
          SELECT 1 FROM career_activity AS actual
          LEFT JOIN career_jobs AS job ON job.id = actual.job_id
          LEFT JOIN expected_activity AS expected
            ON expected.type = actual.type AND expected.company = job.company
          WHERE expected.type IS NULL
            OR actual.id NOT GLOB 'activity_????????-????-4???-[89ab]???-????????????'
            OR actual.detail IS NOT expected.detail
            OR actual.created_at IS NOT (date((SELECT created_at FROM reference),'+8 hours',printf('%+d days',expected.created_days)) || expected.created_suffix)
        )`,
  },
  {
    sql: `INSERT INTO career_settings(key,value)
      SELECT 'legacy_demo_v1_resolution','cleaned'
      WHERE EXISTS (SELECT 1 FROM temp.__career_legacy_demo_guard)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  },
  {
    sql: `INSERT INTO career_settings(key,value)
      SELECT 'legacy_demo_v1_resolution','review-needed'
      WHERE NOT EXISTS (SELECT 1 FROM temp.__career_legacy_demo_guard)
        AND EXISTS (
          SELECT 1 FROM career_settings
          WHERE key = 'seed_version' AND value = '1'
        )
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  },
  {
    sql: `DELETE FROM career_contact_interactions
      WHERE EXISTS (SELECT 1 FROM temp.__career_legacy_demo_guard)`,
  },
  {
    sql: `DELETE FROM career_contact_jobs
      WHERE EXISTS (SELECT 1 FROM temp.__career_legacy_demo_guard)`,
  },
  {
    sql: `DELETE FROM career_activity
      WHERE EXISTS (SELECT 1 FROM temp.__career_legacy_demo_guard)`,
  },
  {
    sql: `DELETE FROM career_interviews
      WHERE EXISTS (SELECT 1 FROM temp.__career_legacy_demo_guard)`,
  },
  {
    sql: `DELETE FROM career_tasks
      WHERE EXISTS (SELECT 1 FROM temp.__career_legacy_demo_guard)`,
  },
  {
    sql: `DELETE FROM career_materials
      WHERE EXISTS (SELECT 1 FROM temp.__career_legacy_demo_guard)`,
  },
  {
    sql: `DELETE FROM career_contacts
      WHERE EXISTS (SELECT 1 FROM temp.__career_legacy_demo_guard)`,
  },
  {
    sql: `DELETE FROM career_jobs
      WHERE EXISTS (SELECT 1 FROM temp.__career_legacy_demo_guard)`,
  },
  {
    sql: `DELETE FROM career_settings
      WHERE key IN ('seed_version','weekly_goal')
        AND EXISTS (SELECT 1 FROM temp.__career_legacy_demo_guard)`,
  },
  { sql: "DROP TABLE temp.__career_legacy_demo_guard" },
];

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

    const schemaObjectCount = await query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM sqlite_schema
        WHERE type IN ('table','index','view','trigger')
          AND name NOT LIKE 'sqlite_%'`,
      [],
      lockContext,
    );
    const isEmpty = Number(schemaObjectCount[0]?.count ?? 0) === 0;
    const hasExactV2ObjectCount =
      Number(schemaObjectCount[0]?.count ?? 0) === CAREER_V2_SCHEMA_OBJECT_COUNT;
    const isKnownInterruptedV2 = hasExactV2ObjectCount && (
      (currentApplicationId === CAREER_APPLICATION_ID &&
        (currentUserVersion === 1 || currentUserVersion === 3)) ||
      (currentApplicationId === 0 && currentUserVersion === 0)
    );
    try {
      if (isEmpty) {
        if (currentApplicationId !== 0 || currentUserVersion !== 0) {
          throw new Error("空数据库带有不一致的版本标识");
        }
        await runCareerBatch([
          ...createFreshCareerSchemaStatements(),
          ...CAREER_STRUCTURAL_STAGE_STATEMENTS,
        ], lockContext);
        return;
      }

      await runCareerBatch([
        ...(isKnownInterruptedV2
          ? createInterruptedCareerV2RuntimeRecoveryStatements(
            currentApplicationId,
            currentUserVersion,
          )
          : createCareerRuntimeUpgradeStatements(currentUserVersion)),
        ...CAREER_LEGACY_DEMO_RESOLUTION_STATEMENTS,
      ], lockContext);
    } catch (error) {
      throw new Error(
        "职迹本地数据结构不完整或并非受支持的版本；为保护原记录，本次没有改动它。",
        { cause: error },
      );
    }

    const count = await query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM career_stages",
      [],
      lockContext,
    );
    if (Number(count[0]?.count ?? 0) === 0) {
      await runCareerBatch(CAREER_STRUCTURAL_STAGE_STATEMENTS, lockContext);
    }
  }, context);
}

export async function getCareerLegacyDemoResolution(
  context?: CareerLockContext,
): Promise<CareerLegacyDemoResolution> {
  const rows = await query<{ value: string }>(
    "SELECT value FROM career_settings WHERE key = ?",
    [CAREER_LEGACY_DEMO_RESOLUTION_SETTING],
    context,
  );
  const value = rows[0]?.value;
  if (value === CAREER_LEGACY_DEMO_CLEANED) return value;
  if (value === CAREER_LEGACY_DEMO_REVIEW_NEEDED) return value;
  return "none";
}

export async function loadCareerData(context?: CareerLockContext): Promise<CareerData> {
  return withCareerReadLock(async (lockContext) => {
    const [stages, jobs, tasks, interviews, contacts, materials, activities] = await Promise.all([
      query<Stage>("SELECT * FROM career_stages ORDER BY position", [], lockContext),
      query<Job>("SELECT * FROM career_jobs WHERE archived = 0 ORDER BY position, updated_at DESC", [], lockContext),
      query<Task>(`SELECT task.* FROM career_tasks AS task
        WHERE task.job_id IS NULL OR EXISTS (
          SELECT 1 FROM career_jobs AS job
          WHERE job.id = task.job_id AND job.archived = 0
        )
        ORDER BY task.status,task.due_at`, [], lockContext),
      query<Interview>(`SELECT interview.* FROM career_interviews AS interview
        WHERE EXISTS (
          SELECT 1 FROM career_jobs AS job
          WHERE job.id = interview.job_id AND job.archived = 0
        )
        ORDER BY interview.scheduled_at`, [], lockContext),
      query<Contact>("SELECT * FROM career_contacts WHERE archived = 0 ORDER BY next_follow_up, name", [], lockContext),
      query<Material>("SELECT * FROM career_materials ORDER BY updated_at DESC", [], lockContext),
      query<Activity>(`SELECT activity.* FROM career_activity AS activity
        WHERE activity.job_id IS NULL OR EXISTS (
          SELECT 1 FROM career_jobs AS job
          WHERE job.id = activity.job_id AND job.archived = 0
        )
        ORDER BY activity.created_at DESC LIMIT 40`, [], lockContext),
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
