import type { LocalDatabaseSchema } from "./types";

/** SQLite application_id for the ASCII-ish marker "ZHJI". */
export const ZHIJI_APPLICATION_ID = 0x5a484a49;
export const ZHIJI_USER_VERSION = 4;
export const ZHIJI_V1_MIGRATION_NAME = "initial-career-runtime";
export const ZHIJI_V2_MIGRATION_NAME = "contact-history";
export const ZHIJI_V3_MIGRATION_NAME = "reversible-lifecycle";
export const ZHIJI_V4_MIGRATION_NAME = "career-core-write-recovery";

export const ZHIJI_V1_TABLE_COLUMNS = {
  career_stages: ["id", "name", "color", "position", "is_terminal", "hidden"],
  career_jobs: [
    "id", "company", "role", "location", "source", "source_url",
    "stage_id", "priority", "salary", "work_mode", "description",
    "applied_at", "deadline", "contact_name", "note", "tags",
    "created_at", "updated_at", "archived", "position",
  ],
  career_tasks: [
    "id", "job_id", "title", "due_at", "kind", "priority", "status",
    "created_at",
  ],
  career_interviews: [
    "id", "job_id", "round_name", "interview_type", "scheduled_at",
    "duration", "interviewer", "meeting_url", "status", "summary",
    "raw_notes", "questions_json", "reflection", "created_at", "updated_at",
  ],
  career_contacts: [
    "id", "company", "name", "role", "channel", "email", "phone",
    "last_contact_at", "next_follow_up", "notes", "created_at",
  ],
  career_materials: [
    "id", "name", "kind", "version", "updated_at", "linked_job_id",
    "status", "notes", "file_key", "file_name", "mime_type", "byte_size",
  ],
  career_activity: ["id", "job_id", "type", "detail", "created_at"],
  career_settings: ["key", "value"],
} as const;

export const ZHIJI_V2_TABLE_COLUMNS = {
  ...ZHIJI_V1_TABLE_COLUMNS,
  career_tasks: [...ZHIJI_V1_TABLE_COLUMNS.career_tasks, "contact_id"],
  career_contacts: [
    ...ZHIJI_V1_TABLE_COLUMNS.career_contacts,
    "updated_at",
    "archived",
  ],
  career_contact_jobs: ["contact_id", "job_id", "created_at"],
  career_contact_interactions: [
    "id", "contact_id", "job_id", "interaction_type", "direction",
    "channel", "summary", "notes", "occurred_at", "created_at",
  ],
} as const;

export const ZHIJI_TABLE_COLUMNS = {
  career_schema_migrations: ["version", "name", "applied_at"],
  ...ZHIJI_V2_TABLE_COLUMNS,
  career_jobs: [
    ...ZHIJI_V2_TABLE_COLUMNS.career_jobs,
    "archived_at",
    "ended_at",
    "archived_operation_id",
    "ended_operation_id",
  ],
  career_tasks: [
    ...ZHIJI_V2_TABLE_COLUMNS.career_tasks,
    "updated_at",
    "canceled_at",
    "cancellation_reason",
    "lifecycle_previous_status",
    "lifecycle_operation_id",
  ],
  career_interviews: [
    ...ZHIJI_V2_TABLE_COLUMNS.career_interviews,
    "canceled_at",
    "cancellation_reason",
    "lifecycle_previous_status",
    "lifecycle_operation_id",
  ],
  career_lifecycle_events: [
    "id", "job_id", "entity_type", "entity_id", "action",
    "previous_status", "next_status", "previous_due_at", "next_due_at",
    "reason", "created_at",
  ],
  career_core_write_operations: [
    "operation_id", "purpose", "receipt_version", "kind", "entity_id",
    "projection_sha256", "operation_at",
  ],
} as const;

export const ZHIJI_V1_TABLES = Object.keys(
  ZHIJI_V1_TABLE_COLUMNS,
) as ReadonlyArray<keyof typeof ZHIJI_V1_TABLE_COLUMNS>;
export const ZHIJI_V2_TABLES = Object.keys(
  ZHIJI_V2_TABLE_COLUMNS,
) as ReadonlyArray<keyof typeof ZHIJI_V2_TABLE_COLUMNS>;
export const ZHIJI_TABLES = Object.keys(
  ZHIJI_TABLE_COLUMNS,
) as ReadonlyArray<keyof typeof ZHIJI_TABLE_COLUMNS>;

export const ZHIJI_V1_INDEXES = [
  "idx_career_jobs_stage",
  "idx_career_tasks_due",
  "idx_career_interviews_date",
] as const;

export const ZHIJI_V2_INDEXES = [
  ...ZHIJI_V1_INDEXES,
  "idx_career_contacts_archived_name",
  "idx_career_tasks_contact_due",
  "idx_career_contact_jobs_job",
  "idx_career_contact_interactions_contact_date",
  "idx_career_contact_interactions_job_date",
] as const;

export const ZHIJI_INDEXES = [
  ...ZHIJI_V2_INDEXES,
  "idx_career_jobs_lifecycle",
  "idx_career_tasks_job_lifecycle",
  "idx_career_interviews_job_lifecycle",
  "idx_career_lifecycle_events_job_date",
  "idx_career_lifecycle_events_entity_date",
] as const;

const V1_CREATE_STATEMENTS: readonly Readonly<{ sql: string }>[] = [
  {
    sql: `CREATE TABLE career_stages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      position INTEGER NOT NULL,
      is_terminal INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0
    )`,
  },
  {
    sql: `CREATE TABLE career_jobs (
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
    sql: `CREATE TABLE career_tasks (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      due_at TEXT,
      kind TEXT NOT NULL DEFAULT '跟进',
      priority INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'todo',
      created_at TEXT NOT NULL
    )`,
  },
  {
    sql: `CREATE TABLE career_interviews (
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
    sql: `CREATE TABLE career_contacts (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT 'LinkedIn',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      last_contact_at TEXT,
      next_follow_up TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`,
  },
  {
    sql: `CREATE TABLE career_materials (
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
    sql: `CREATE TABLE career_activity (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  },
  {
    sql: `CREATE TABLE career_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  },
  { sql: "CREATE INDEX idx_career_jobs_stage ON career_jobs(stage_id, archived, position)" },
  { sql: "CREATE INDEX idx_career_tasks_due ON career_tasks(status, due_at)" },
  { sql: "CREATE INDEX idx_career_interviews_date ON career_interviews(scheduled_at)" },
];

const MATERIAL_ATTACHMENT_COLUMNS = [
  "file_key TEXT",
  "file_name TEXT",
  "mime_type TEXT",
  "byte_size INTEGER",
] as const;

export const ZHIJI_V1_SCHEMA_STATEMENTS: readonly Readonly<{ sql: string }>[] = [
  ...V1_CREATE_STATEMENTS,
  ...MATERIAL_ATTACHMENT_COLUMNS.map((definition) => ({
    sql: `ALTER TABLE career_materials ADD COLUMN ${definition}`,
  })),
];

export const ZHIJI_V2_SCHEMA_MIGRATION_STATEMENTS: readonly Readonly<{ sql: string }>[] = [
  { sql: "ALTER TABLE career_contacts ADD COLUMN updated_at TEXT" },
  { sql: "ALTER TABLE career_contacts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0" },
  {
    sql: "ALTER TABLE career_tasks ADD COLUMN contact_id TEXT REFERENCES career_contacts(id) ON DELETE SET NULL",
  },
  {
    sql: `UPDATE career_contacts
      SET updated_at = created_at
      WHERE updated_at IS NULL OR updated_at = ''`,
  },
  {
    sql: `CREATE TABLE career_contact_jobs (
      contact_id TEXT NOT NULL REFERENCES career_contacts(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES career_jobs(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (contact_id, job_id)
    )`,
  },
  {
    sql: `CREATE TABLE career_contact_interactions (
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
  { sql: "CREATE INDEX idx_career_contacts_archived_name ON career_contacts(archived, name)" },
  { sql: "CREATE INDEX idx_career_tasks_contact_due ON career_tasks(contact_id, status, due_at)" },
  { sql: "CREATE INDEX idx_career_contact_jobs_job ON career_contact_jobs(job_id, contact_id)" },
  { sql: "CREATE INDEX idx_career_contact_interactions_contact_date ON career_contact_interactions(contact_id, occurred_at DESC)" },
  { sql: "CREATE INDEX idx_career_contact_interactions_job_date ON career_contact_interactions(job_id, occurred_at DESC)" },
];

export const ZHIJI_V3_SCHEMA_MIGRATION_STATEMENTS: readonly Readonly<{ sql: string }>[] = [
  {
    sql: `CREATE TEMP TABLE __career_v3_status_guard (
      value INTEGER NOT NULL CHECK (value = 1)
    )`,
  },
  {
    sql: `INSERT INTO temp.__career_v3_status_guard(value)
      SELECT CASE WHEN
        NOT EXISTS (
          SELECT 1 FROM career_tasks
          WHERE status NOT IN ('todo','done','canceled','cancelled')
        )
        AND NOT EXISTS (
          SELECT 1 FROM career_interviews
          WHERE status NOT IN ('scheduled','completed','canceled','cancelled')
        )
      THEN 1 ELSE 0 END`,
  },
  { sql: "DROP TABLE temp.__career_v3_status_guard" },
  {
    sql: `UPDATE career_tasks
      SET status = 'canceled'
      WHERE status = 'cancelled'`,
  },
  {
    sql: `UPDATE career_interviews
      SET status = 'canceled'
      WHERE status = 'cancelled'`,
  },
  {
    sql: `CREATE TABLE career_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL CHECK (length(applied_at) > 0)
    )`,
  },
  { sql: "ALTER TABLE career_jobs ADD COLUMN archived_at TEXT" },
  { sql: "ALTER TABLE career_jobs ADD COLUMN ended_at TEXT" },
  { sql: "ALTER TABLE career_jobs ADD COLUMN archived_operation_id TEXT" },
  { sql: "ALTER TABLE career_jobs ADD COLUMN ended_operation_id TEXT" },
  { sql: "ALTER TABLE career_tasks ADD COLUMN updated_at TEXT" },
  { sql: "ALTER TABLE career_tasks ADD COLUMN canceled_at TEXT" },
  { sql: "ALTER TABLE career_tasks ADD COLUMN cancellation_reason TEXT" },
  { sql: "ALTER TABLE career_tasks ADD COLUMN lifecycle_previous_status TEXT" },
  { sql: "ALTER TABLE career_tasks ADD COLUMN lifecycle_operation_id TEXT" },
  { sql: "ALTER TABLE career_interviews ADD COLUMN canceled_at TEXT" },
  { sql: "ALTER TABLE career_interviews ADD COLUMN cancellation_reason TEXT" },
  { sql: "ALTER TABLE career_interviews ADD COLUMN lifecycle_previous_status TEXT" },
  { sql: "ALTER TABLE career_interviews ADD COLUMN lifecycle_operation_id TEXT" },
  {
    sql: `CREATE TABLE career_lifecycle_events (
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
    )`,
  },
  {
    sql: `UPDATE career_tasks
      SET updated_at = created_at
      WHERE updated_at IS NULL OR updated_at = ''`,
  },
  {
    sql: `UPDATE career_jobs
      SET archived_at = updated_at
      WHERE archived = 1 AND archived_at IS NULL`,
  },
  {
    sql: `UPDATE career_jobs
      SET ended_at = updated_at
      WHERE ended_at IS NULL AND EXISTS (
        SELECT 1 FROM career_stages
        WHERE career_stages.id = career_jobs.stage_id
          AND career_stages.is_terminal = 1
      )`,
  },
  { sql: "CREATE INDEX idx_career_jobs_lifecycle ON career_jobs(archived, ended_at, updated_at)" },
  { sql: "CREATE INDEX idx_career_tasks_job_lifecycle ON career_tasks(job_id, status, lifecycle_operation_id, due_at)" },
  { sql: "CREATE INDEX idx_career_interviews_job_lifecycle ON career_interviews(job_id, status, lifecycle_operation_id, scheduled_at)" },
  { sql: "CREATE INDEX idx_career_lifecycle_events_job_date ON career_lifecycle_events(job_id, created_at DESC)" },
  { sql: "CREATE INDEX idx_career_lifecycle_events_entity_date ON career_lifecycle_events(entity_type, entity_id, created_at DESC)" },
  {
    sql: `INSERT INTO career_schema_migrations(version,name,applied_at) VALUES
      (1,'${ZHIJI_V1_MIGRATION_NAME}',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      (2,'${ZHIJI_V2_MIGRATION_NAME}',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      (3,'${ZHIJI_V3_MIGRATION_NAME}',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  },
];

/**
 * Immutable proof that a recoverable core write committed. These rows have no
 * foreign keys by design: a receipt must remain inspectable after its target
 * is archived, deleted, or superseded. They are never garbage-collected until
 * a future protocol can prove that every durable client journal acknowledged
 * the operation.
 */
export const ZHIJI_V4_SCHEMA_MIGRATION_STATEMENTS: readonly Readonly<{ sql: string }>[] = [
  {
    sql: `CREATE TABLE career_core_write_operations (
      operation_id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL CHECK (purpose = 'career-core-write'),
      receipt_version INTEGER NOT NULL CHECK (receipt_version = 1),
      kind TEXT NOT NULL CHECK (kind IN (
        'stage-rename','job-create','job-update',
        'interview-create','interview-update'
      )),
      entity_id TEXT NOT NULL,
      projection_sha256 TEXT NOT NULL CHECK (
        length(projection_sha256) = 64
        AND projection_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      operation_at TEXT NOT NULL CHECK (length(operation_at) > 0)
    )`,
  },
  {
    sql: `INSERT INTO career_schema_migrations(version,name,applied_at) VALUES
      (4,'${ZHIJI_V4_MIGRATION_NAME}',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  },
];

function objectSql(
  statements: readonly Readonly<{ sql: string }>[],
): Record<string, string> {
  return Object.fromEntries(statements.flatMap(({ sql }) => {
    const match = /^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(
      sql.trim(),
    );
    return match ? [[match[1], sql] as const] : [];
  }));
}

function appendColumns(sql: string, definitions: readonly string[]): string {
  const closing = sql.lastIndexOf(")");
  if (closing < 0) throw new Error("职迹结构缺少表定义结束符");
  return `${sql.slice(0, closing).trimEnd()}${definitions.map((definition) =>
    `,\n      ${definition}`).join("")}\n    )`;
}

const v1Objects = objectSql(V1_CREATE_STATEMENTS);
v1Objects.career_materials = appendColumns(
  v1Objects.career_materials,
  MATERIAL_ATTACHMENT_COLUMNS,
);

const v2MigrationObjects = objectSql(ZHIJI_V2_SCHEMA_MIGRATION_STATEMENTS);
const v2MigratedObjects: Record<string, string> = {
  ...v1Objects,
  ...v2MigrationObjects,
  career_contacts: appendColumns(v1Objects.career_contacts, [
    "updated_at TEXT",
    "archived INTEGER NOT NULL DEFAULT 0",
  ]),
  career_tasks: appendColumns(v1Objects.career_tasks, [
    "contact_id TEXT REFERENCES career_contacts(id) ON DELETE SET NULL",
  ]),
};

const directV2ContactsSql = `CREATE TABLE career_contacts (
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
    )`;
const directV2TasksSql = `CREATE TABLE career_tasks (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
      contact_id TEXT REFERENCES career_contacts(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      due_at TEXT,
      kind TEXT NOT NULL DEFAULT '跟进',
      priority INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'todo',
      created_at TEXT NOT NULL
    )`;

const v2DirectObjects: Record<string, string> = {
  ...v2MigratedObjects,
  career_contacts: directV2ContactsSql,
  career_tasks: directV2TasksSql,
};

const v3MigrationObjects = objectSql(ZHIJI_V3_SCHEMA_MIGRATION_STATEMENTS);
const JOB_V3_COLUMNS = [
  "archived_at TEXT",
  "ended_at TEXT",
  "archived_operation_id TEXT",
  "ended_operation_id TEXT",
] as const;
const TASK_V3_COLUMNS = [
  "updated_at TEXT",
  "canceled_at TEXT",
  "cancellation_reason TEXT",
  "lifecycle_previous_status TEXT",
  "lifecycle_operation_id TEXT",
] as const;
const INTERVIEW_V3_COLUMNS = [
  "canceled_at TEXT",
  "cancellation_reason TEXT",
  "lifecycle_previous_status TEXT",
  "lifecycle_operation_id TEXT",
] as const;

function v3Objects(
  v2Objects: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...v2Objects,
    ...v3MigrationObjects,
    career_jobs: appendColumns(v2Objects.career_jobs, JOB_V3_COLUMNS),
    career_tasks: appendColumns(v2Objects.career_tasks, TASK_V3_COLUMNS),
    career_interviews: appendColumns(
      v2Objects.career_interviews,
      INTERVIEW_V3_COLUMNS,
    ),
  };
}

const v3MigratedObjects: Record<string, string> = v3Objects(v2MigratedObjects);
const v3DirectObjects: Record<string, string> = v3Objects(v2DirectObjects);
const v4MigrationObjects = objectSql(ZHIJI_V4_SCHEMA_MIGRATION_STATEMENTS);
const v4MigratedObjects: Record<string, string> = {
  ...v3MigratedObjects,
  ...v4MigrationObjects,
};
const v4DirectObjects: Record<string, string> = {
  ...v3DirectObjects,
  ...v4MigrationObjects,
};

export const ZHIJI_SCHEMA_OBJECT_SQL_VARIANTS = {
  0: Object.fromEntries(
    Object.entries(v1Objects).map(([name, sql]) => [name, [sql]]),
  ),
  1: Object.fromEntries(
    Object.entries(v1Objects).map(([name, sql]) => [name, [sql]]),
  ),
  2: Object.fromEntries(Object.keys(v2MigratedObjects).map((name) => [
    name,
    name === "career_contacts" || name === "career_tasks"
      ? [v2MigratedObjects[name], v2DirectObjects[name]]
      : [v2MigratedObjects[name]],
  ])),
  3: Object.fromEntries(Object.keys(v3MigratedObjects).map((name) => [
    name,
    name === "career_contacts" || name === "career_tasks"
      ? [v3MigratedObjects[name], v3DirectObjects[name]]
      : [v3MigratedObjects[name]],
  ])),
  4: Object.fromEntries(Object.keys(v4MigratedObjects).map((name) => [
    name,
    name === "career_contacts" || name === "career_tasks"
      ? [v4MigratedObjects[name], v4DirectObjects[name]]
      : [v4MigratedObjects[name]],
  ])),
} as const satisfies Readonly<Record<0 | 1 | 2 | 3 | 4, Readonly<Record<string, readonly string[]>>>>;

export const ZHIJI_SCHEMA_LINEAGES = {
  2: [
    {
      contactsSql: v2MigratedObjects.career_contacts,
      tasksSql: v2MigratedObjects.career_tasks,
    },
    {
      contactsSql: v2DirectObjects.career_contacts,
      tasksSql: v2DirectObjects.career_tasks,
    },
  ],
  3: [
    {
      contactsSql: v3MigratedObjects.career_contacts,
      tasksSql: v3MigratedObjects.career_tasks,
    },
    {
      contactsSql: v3DirectObjects.career_contacts,
      tasksSql: v3DirectObjects.career_tasks,
    },
  ],
  4: [
    {
      contactsSql: v4MigratedObjects.career_contacts,
      tasksSql: v4MigratedObjects.career_tasks,
    },
    {
      contactsSql: v4DirectObjects.career_contacts,
      tasksSql: v4DirectObjects.career_tasks,
    },
  ],
} as const;

export const ZHIJI_STRUCTURAL_SEED_SQL = `
  INSERT INTO career_stages
    (id,name,color,position,is_terminal,hidden) VALUES
    ('stage_saved','收藏','#8b8f96',0,0,0),
    ('stage_preparing','准备中','#bd7d45',1,0,0),
    ('stage_applied','已投递','#4d79a7',2,0,0),
    ('stage_assessment','笔试 / 测评','#806bb2',3,0,0),
    ('stage_interview','面试中','#a35673',4,0,0),
    ('stage_offer','Offer','#2b8a6e',5,0,0),
    ('stage_accepted','已接受','#27785f',6,1,0),
    ('stage_rejected','未通过','#9b5b54',7,1,0),
    ('stage_withdrawn','已撤回','#777b80',8,1,0)
  ON CONFLICT(id) DO NOTHING;
`;

function statementsSql(statements: readonly Readonly<{ sql: string }>[]): string {
  return statements.map(({ sql }) => `${sql};`).join("\n");
}

export const zhijiSchema: LocalDatabaseSchema = {
  name: "zhiji",
  filename: "zhiji.sqlite3",
  applicationId: ZHIJI_APPLICATION_ID,
  seedVersion: 1,
  migrations: [
    {
      version: 1,
      description: ZHIJI_V1_MIGRATION_NAME,
      sql: `PRAGMA application_id = ${ZHIJI_APPLICATION_ID};\n${statementsSql(ZHIJI_V1_SCHEMA_STATEMENTS)}`,
    },
    {
      version: 2,
      description: ZHIJI_V2_MIGRATION_NAME,
      sql: statementsSql(ZHIJI_V2_SCHEMA_MIGRATION_STATEMENTS),
    },
    {
      version: 3,
      description: ZHIJI_V3_MIGRATION_NAME,
      sql: statementsSql(ZHIJI_V3_SCHEMA_MIGRATION_STATEMENTS),
    },
    {
      version: 4,
      description: ZHIJI_V4_MIGRATION_NAME,
      sql: statementsSql(ZHIJI_V4_SCHEMA_MIGRATION_STATEMENTS),
    },
  ],
  seedSql: ZHIJI_STRUCTURAL_SEED_SQL,
};
