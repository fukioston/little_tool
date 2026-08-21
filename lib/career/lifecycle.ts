import { localDb } from "@/lib/local-db/client";
import type { SqlStatement } from "@/lib/local-db/types";
import {
  withCareerReadLock,
  withCareerWriteLock,
  type CareerLockContext,
} from "./lock";
import type { Interview, Job, Task } from "./types";

const DB = "career" as const;

export type CareerLifecycleScope = "active" | "ended" | "archived" | "all";
export type CareerRelatedPauseAction = "keep" | "pause";
export type CareerRelatedRestoreAction = "keep-paused" | "restore-paused";
export type CareerStageRelatedAction =
  | CareerRelatedPauseAction
  | CareerRelatedRestoreAction;

export type CareerLifecycleOptions<Action extends string> = Readonly<{
  relatedAction: Action;
  now?: string;
  operationId?: string;
}>;

export type CareerLifecycleEvent = Readonly<{
  id: string;
  job_id: string | null;
  entity_type: "job" | "task" | "interview";
  entity_id: string;
  action: string;
  previous_status: string | null;
  next_status: string | null;
  previous_due_at: string | null;
  next_due_at: string | null;
  reason: string;
  created_at: string;
}>;

export type CareerLifecycleSnapshot = Readonly<{
  jobs: Job[];
  tasks: Task[];
  interviews: Interview[];
}>;

export type CareerTaskCancellationReason =
  | "no_longer_needed"
  | "duplicate"
  | "changed_plan"
  | "other";

/**
 * Additive v3 migration. A current row carries the exact lifecycle operation
 * that paused it; the immutable ledger retains every earlier decision. This
 * lets a later restore touch only rows paused by the matching job operation.
 */
export const CAREER_LIFECYCLE_V3_MIGRATION_STATEMENTS: readonly SqlStatement[] = [
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
  {
    sql: "CREATE INDEX idx_career_jobs_lifecycle ON career_jobs(archived, ended_at, updated_at)",
  },
  {
    sql: "CREATE INDEX idx_career_tasks_job_lifecycle ON career_tasks(job_id, status, lifecycle_operation_id, due_at)",
  },
  {
    sql: "CREATE INDEX idx_career_interviews_job_lifecycle ON career_interviews(job_id, status, lifecycle_operation_id, scheduled_at)",
  },
  {
    sql: "CREATE INDEX idx_career_lifecycle_events_job_date ON career_lifecycle_events(job_id, created_at DESC)",
  },
  {
    sql: "CREATE INDEX idx_career_lifecycle_events_entity_date ON career_lifecycle_events(entity_type, entity_id, created_at DESC)",
  },
];

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function requireId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) {
    throw new TypeError(`${label}不能为空且不能超过 240 个字符`);
  }
  return normalized;
}

function requireTimestamp(value: string, label: string): string {
  const normalized = value.trim();
  const milliseconds = Date.parse(normalized);
  if (!normalized || !Number.isFinite(milliseconds)) {
    throw new TypeError(`${label}不是有效时间`);
  }
  return new Date(milliseconds).toISOString();
}

function requireReason(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) {
    throw new TypeError("取消原因不能为空且不能超过 240 个字符");
  }
  return normalized;
}

function normalizedOptions<Action extends string>(
  options: CareerLifecycleOptions<Action>,
): Readonly<{ relatedAction: Action; now: string; operationId: string }> {
  if (!options || typeof options !== "object") {
    throw new TypeError("必须明确选择如何处理关联待办和面试");
  }
  return {
    relatedAction: options.relatedAction,
    now: options.now === undefined
      ? new Date().toISOString()
      : requireTimestamp(options.now, "操作时间"),
    operationId: options.operationId === undefined
      ? uid("lifecycle")
      : requireId(options.operationId, "操作 ID"),
  };
}

function requirePauseAction(value: string): asserts value is CareerRelatedPauseAction {
  if (value !== "keep" && value !== "pause") {
    throw new TypeError("必须明确选择保留关联安排或暂停关联安排");
  }
}

function requireRestoreAction(value: string): asserts value is CareerRelatedRestoreAction {
  if (value !== "keep-paused" && value !== "restore-paused") {
    throw new TypeError("必须明确选择继续暂停或恢复此前暂停的安排");
  }
}

function guardName(operationId: string): string {
  return `__career_lifecycle_guard_${operationId.replace(/[^a-zA-Z0-9_]/g, "")}`;
}

function guardStatements(
  operationId: string,
  conditionSql: string,
  params: readonly unknown[],
): readonly [SqlStatement, SqlStatement] {
  const table = guardName(operationId);
  return [
    { sql: `CREATE TEMP TABLE ${table} (value INTEGER NOT NULL CHECK (value = 1))` },
    {
      sql: `INSERT INTO ${table}(value)
        SELECT CASE WHEN (${conditionSql}) THEN 1 ELSE 0 END`,
      params,
    },
  ];
}

function dropGuardStatement(operationId: string): SqlStatement {
  return { sql: `DROP TABLE ${guardName(operationId)}` };
}

function eventIdPrefix(operationId: string, entity: string): string {
  return `${operationId}_${entity}_`;
}

function suspendJobDependents(
  jobId: string,
  reason: "job_archived" | "job_ended",
  operationId: string,
  now: string,
): SqlStatement[] {
  const action = reason === "job_archived"
    ? "auto_pause_job_archived"
    : "auto_pause_job_ended";
  return [
    {
      sql: `INSERT INTO career_lifecycle_events(
          id,job_id,entity_type,entity_id,action,previous_status,next_status,
          previous_due_at,next_due_at,reason,created_at
        )
        SELECT ? || id,job_id,'task',id,?,status,'canceled',due_at,due_at,?,?
        FROM career_tasks
        WHERE job_id = ?
          AND status = 'todo'
          AND due_at IS NOT NULL
          AND due_at > ?
          AND lifecycle_operation_id IS NULL`,
      params: [
        eventIdPrefix(operationId, "task"),
        action,
        reason,
        now,
        jobId,
        now,
      ],
    },
    {
      sql: `UPDATE career_tasks
        SET lifecycle_previous_status = status,
            lifecycle_operation_id = ?,
            status = 'canceled',
            canceled_at = ?,
            cancellation_reason = ?,
            updated_at = ?
        WHERE job_id = ?
          AND status = 'todo'
          AND due_at IS NOT NULL
          AND due_at > ?
          AND lifecycle_operation_id IS NULL`,
      params: [operationId, now, reason, now, jobId, now],
    },
    {
      sql: `INSERT INTO career_lifecycle_events(
          id,job_id,entity_type,entity_id,action,previous_status,next_status,
          previous_due_at,next_due_at,reason,created_at
        )
        SELECT ? || id,job_id,'interview',id,?,status,'canceled',scheduled_at,scheduled_at,?,?
        FROM career_interviews
        WHERE job_id = ?
          AND status = 'scheduled'
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND lifecycle_operation_id IS NULL`,
      params: [
        eventIdPrefix(operationId, "interview"),
        action,
        reason,
        now,
        jobId,
        now,
      ],
    },
    {
      sql: `UPDATE career_interviews
        SET lifecycle_previous_status = status,
            lifecycle_operation_id = ?,
            status = 'canceled',
            canceled_at = ?,
            cancellation_reason = ?,
            updated_at = ?
        WHERE job_id = ?
          AND status = 'scheduled'
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND lifecycle_operation_id IS NULL`,
      params: [operationId, now, reason, now, jobId, now],
    },
  ];
}

function restoreJobDependents(
  jobId: string,
  reason: "job_archived" | "job_ended",
  pausedOperationColumn: "archived_operation_id" | "ended_operation_id",
  restoreOperationId: string,
  now: string,
): SqlStatement[] {
  return [
    {
      sql: `INSERT INTO career_lifecycle_events(
          id,job_id,entity_type,entity_id,action,previous_status,next_status,
          previous_due_at,next_due_at,reason,created_at
        )
        SELECT ? || id,job_id,'task',id,'auto_restore_job_active',status,
          lifecycle_previous_status,due_at,due_at,?,?
        FROM career_tasks
        WHERE job_id = ?
          AND status = 'canceled'
          AND cancellation_reason = ?
          AND lifecycle_operation_id = (
            SELECT ${pausedOperationColumn} FROM career_jobs WHERE id = ?
          )
          AND lifecycle_previous_status = 'todo'
          AND updated_at = canceled_at
          AND EXISTS (
            SELECT 1
            FROM career_jobs AS active_job
            JOIN career_stages AS active_stage
              ON active_stage.id = active_job.stage_id
            WHERE active_job.id = career_tasks.job_id
              AND active_job.archived = 0
              AND active_stage.is_terminal = 0
          )`,
      params: [
        eventIdPrefix(restoreOperationId, "task"),
        reason,
        now,
        jobId,
        reason,
        jobId,
      ],
    },
    {
      sql: `UPDATE career_tasks
        SET status = lifecycle_previous_status,
            lifecycle_previous_status = NULL,
            lifecycle_operation_id = NULL,
            canceled_at = NULL,
            cancellation_reason = NULL,
            updated_at = ?
        WHERE job_id = ?
          AND status = 'canceled'
          AND cancellation_reason = ?
          AND lifecycle_operation_id = (
            SELECT ${pausedOperationColumn} FROM career_jobs WHERE id = ?
          )
          AND lifecycle_previous_status = 'todo'
          AND updated_at = canceled_at
          AND EXISTS (
            SELECT 1
            FROM career_jobs AS active_job
            JOIN career_stages AS active_stage
              ON active_stage.id = active_job.stage_id
            WHERE active_job.id = career_tasks.job_id
              AND active_job.archived = 0
              AND active_stage.is_terminal = 0
          )`,
      params: [now, jobId, reason, jobId],
    },
    {
      sql: `INSERT INTO career_lifecycle_events(
          id,job_id,entity_type,entity_id,action,previous_status,next_status,
          previous_due_at,next_due_at,reason,created_at
        )
        SELECT ? || id,job_id,'interview',id,'auto_restore_job_active',status,
          lifecycle_previous_status,scheduled_at,scheduled_at,?,?
        FROM career_interviews
        WHERE job_id = ?
          AND status = 'canceled'
          AND cancellation_reason = ?
          AND lifecycle_operation_id = (
            SELECT ${pausedOperationColumn} FROM career_jobs WHERE id = ?
          )
          AND lifecycle_previous_status = 'scheduled'
          AND updated_at = canceled_at
          AND EXISTS (
            SELECT 1
            FROM career_jobs AS active_job
            JOIN career_stages AS active_stage
              ON active_stage.id = active_job.stage_id
            WHERE active_job.id = career_interviews.job_id
              AND active_job.archived = 0
              AND active_stage.is_terminal = 0
          )`,
      params: [
        eventIdPrefix(restoreOperationId, "interview"),
        reason,
        now,
        jobId,
        reason,
        jobId,
      ],
    },
    {
      sql: `UPDATE career_interviews
        SET status = lifecycle_previous_status,
            lifecycle_previous_status = NULL,
            lifecycle_operation_id = NULL,
            canceled_at = NULL,
            cancellation_reason = NULL,
            updated_at = ?
        WHERE job_id = ?
          AND status = 'canceled'
          AND cancellation_reason = ?
          AND lifecycle_operation_id = (
            SELECT ${pausedOperationColumn} FROM career_jobs WHERE id = ?
          )
          AND lifecycle_previous_status = 'scheduled'
          AND updated_at = canceled_at
          AND EXISTS (
            SELECT 1
            FROM career_jobs AS active_job
            JOIN career_stages AS active_stage
              ON active_stage.id = active_job.stage_id
            WHERE active_job.id = career_interviews.job_id
              AND active_job.archived = 0
              AND active_stage.is_terminal = 0
          )`,
      params: [now, jobId, reason, jobId],
    },
  ];
}

export function planArchiveCareerJob(
  jobIdInput: string,
  optionsInput: CareerLifecycleOptions<CareerRelatedPauseAction>,
): SqlStatement[] {
  const jobId = requireId(jobIdInput, "职位 ID");
  const { relatedAction, now, operationId } = normalizedOptions(optionsInput);
  requirePauseAction(relatedAction);
  return [
    ...guardStatements(
      operationId,
      "(SELECT COUNT(*) FROM career_jobs WHERE id = ? AND archived = 0) = 1",
      [jobId],
    ),
    {
      sql: `INSERT INTO career_lifecycle_events(
          id,job_id,entity_type,entity_id,action,previous_status,next_status,
          previous_due_at,next_due_at,reason,created_at
        )
        SELECT ?,id,'job',id,'archive_job',stage_id,'archived',NULL,NULL,?,?
        FROM career_jobs WHERE id = ? AND archived = 0`,
      params: [operationId, relatedAction, now, jobId],
    },
    {
      sql: `UPDATE career_jobs
        SET archived = 1,
            archived_at = ?,
            archived_operation_id = ?,
            updated_at = ?
        WHERE id = ? AND archived = 0`,
      params: [
        now,
        relatedAction === "pause" ? operationId : null,
        now,
        jobId,
      ],
    },
    ...(relatedAction === "pause"
      ? suspendJobDependents(jobId, "job_archived", operationId, now)
      : []),
    dropGuardStatement(operationId),
  ];
}

export function planRestoreCareerJob(
  jobIdInput: string,
  optionsInput: CareerLifecycleOptions<CareerRelatedRestoreAction>,
): SqlStatement[] {
  const jobId = requireId(jobIdInput, "职位 ID");
  const { relatedAction, now, operationId } = normalizedOptions(optionsInput);
  requireRestoreAction(relatedAction);
  return [
    ...guardStatements(
      operationId,
      `(SELECT COUNT(*)
        FROM career_jobs AS job
        JOIN career_stages AS stage ON stage.id = job.stage_id
        WHERE job.id = ?
          AND job.archived = 1
          AND (
            ? = 'keep-paused'
            OR (? = 'restore-paused' AND stage.is_terminal = 0)
          )) = 1`,
      [jobId, relatedAction, relatedAction],
    ),
    {
      sql: `INSERT INTO career_lifecycle_events(
          id,job_id,entity_type,entity_id,action,previous_status,next_status,
          previous_due_at,next_due_at,reason,created_at
        )
        SELECT ?,id,'job',id,'restore_job','archived',stage_id,NULL,NULL,?,?
        FROM career_jobs WHERE id = ? AND archived = 1`,
      params: [operationId, relatedAction, now, jobId],
    },
    {
      sql: `UPDATE career_jobs
        SET archived = 0, archived_at = NULL, updated_at = ?
        WHERE id = ? AND archived = 1`,
      params: [now, jobId],
    },
    ...(relatedAction === "restore-paused"
      ? restoreJobDependents(
        jobId,
        "job_archived",
        "archived_operation_id",
        operationId,
        now,
      )
      : []),
    {
      sql: `UPDATE career_jobs
        SET archived_operation_id = CASE
          WHEN ? = 'restore-paused' THEN NULL ELSE archived_operation_id END
        WHERE id = ?`,
      params: [relatedAction, jobId],
    },
    dropGuardStatement(operationId),
  ];
}

export function planTransitionCareerJobStage(
  jobIdInput: string,
  nextStageIdInput: string,
  optionsInput: CareerLifecycleOptions<CareerStageRelatedAction>,
): SqlStatement[] {
  const jobId = requireId(jobIdInput, "职位 ID");
  const nextStageId = requireId(nextStageIdInput, "阶段 ID");
  const { relatedAction, now, operationId } = normalizedOptions(optionsInput);
  if (![
    "keep",
    "pause",
    "keep-paused",
    "restore-paused",
  ].includes(relatedAction)) {
    throw new TypeError("关联安排处理方式无效");
  }
  const ending = relatedAction === "keep" || relatedAction === "pause";
  return [
    ...guardStatements(
      operationId,
      `(SELECT COUNT(*)
        FROM career_jobs AS job
        JOIN career_stages AS previous_stage ON previous_stage.id = job.stage_id
        JOIN career_stages AS next_stage ON next_stage.id = ?
        WHERE job.id = ?
          AND job.archived = 0
          AND (
            (previous_stage.is_terminal = 0 AND next_stage.is_terminal = 1
              AND ? IN ('keep','pause'))
            OR (previous_stage.is_terminal = 1 AND next_stage.is_terminal = 1
              AND ? = 'keep')
            OR (previous_stage.is_terminal = 1 AND next_stage.is_terminal = 0
              AND ? IN ('keep-paused','restore-paused'))
            OR (previous_stage.is_terminal = 0 AND next_stage.is_terminal = 0
              AND ? = 'keep')
          )) = 1`,
      [
        nextStageId,
        jobId,
        relatedAction,
        relatedAction,
        relatedAction,
        relatedAction,
      ],
    ),
    {
      sql: `INSERT INTO career_lifecycle_events(
          id,job_id,entity_type,entity_id,action,previous_status,next_status,
          previous_due_at,next_due_at,reason,created_at
        )
        SELECT ?,job.id,'job',job.id,
          CASE
            WHEN next_stage.is_terminal = 1 AND previous_stage.is_terminal = 0
              THEN 'end_job'
            WHEN next_stage.is_terminal = 0 AND previous_stage.is_terminal = 1
              THEN 'reopen_job'
            ELSE 'transition_job'
          END,
          job.stage_id,next_stage.id,NULL,NULL,?,?
        FROM career_jobs AS job
        JOIN career_stages AS previous_stage ON previous_stage.id = job.stage_id
        JOIN career_stages AS next_stage ON next_stage.id = ?
        WHERE job.id = ?`,
      params: [operationId, relatedAction, now, nextStageId, jobId],
    },
    {
      sql: `UPDATE career_jobs
        SET stage_id = ?,
            ended_at = CASE
              WHEN (SELECT is_terminal FROM career_stages WHERE id = ?) = 1
                THEN COALESCE(ended_at, ?)
              ELSE NULL
            END,
            ended_operation_id = CASE
              WHEN (SELECT is_terminal FROM career_stages WHERE id = ?) = 1
                AND EXISTS (
                  SELECT 1 FROM career_stages AS previous_stage
                  WHERE previous_stage.id = career_jobs.stage_id
                    AND previous_stage.is_terminal = 0
                )
                THEN CASE WHEN ? = 'pause' THEN ? ELSE NULL END
              ELSE ended_operation_id
            END,
            updated_at = ?
        WHERE id = ?`,
      params: [
        nextStageId,
        nextStageId,
        now,
        nextStageId,
        relatedAction,
        operationId,
        now,
        jobId,
      ],
    },
    ...(ending && relatedAction === "pause"
      ? suspendJobDependents(jobId, "job_ended", operationId, now)
      : []),
    ...(!ending && relatedAction === "restore-paused"
      ? restoreJobDependents(
        jobId,
        "job_ended",
        "ended_operation_id",
        operationId,
        now,
      )
      : []),
    ...(!ending
      ? [{
        sql: `UPDATE career_jobs
          SET ended_operation_id = CASE
            WHEN ? = 'restore-paused' THEN NULL ELSE ended_operation_id END
          WHERE id = ?`,
        params: [relatedAction, jobId],
      } satisfies SqlStatement]
      : []),
    dropGuardStatement(operationId),
  ];
}

export function planRescheduleCareerTask(
  taskIdInput: string,
  dueAtInput: string | null,
  nowInput?: string,
  operationIdInput = uid("lifecycle"),
): SqlStatement[] {
  const taskId = requireId(taskIdInput, "待办 ID");
  const dueAt = dueAtInput === null
    ? null
    : requireTimestamp(dueAtInput, "待办时间");
  const operationId = requireId(operationIdInput, "操作 ID");
  const now = nowInput === undefined
    ? new Date().toISOString()
    : requireTimestamp(nowInput, "操作时间");
  return [
    ...guardStatements(
      operationId,
      "(SELECT COUNT(*) FROM career_tasks WHERE id = ? AND status = 'todo') = 1",
      [taskId],
    ),
    {
      sql: `INSERT INTO career_lifecycle_events(
          id,job_id,entity_type,entity_id,action,previous_status,next_status,
          previous_due_at,next_due_at,reason,created_at
        )
        SELECT ?,job_id,'task',id,?,status,status,due_at,?,'user',?
        FROM career_tasks WHERE id = ? AND status = 'todo'`,
      params: [
        operationId,
        dueAt === null ? "unschedule_task" : "reschedule_task",
        dueAt,
        now,
        taskId,
      ],
    },
    {
      sql: `UPDATE career_tasks
        SET due_at = ?, updated_at = ?
        WHERE id = ? AND status = 'todo'`,
      params: [dueAt, now, taskId],
    },
    dropGuardStatement(operationId),
  ];
}

export function planCancelCareerTask(
  taskIdInput: string,
  reasonInput: CareerTaskCancellationReason | string = "no_longer_needed",
  nowInput?: string,
  operationIdInput = uid("lifecycle"),
): SqlStatement[] {
  const taskId = requireId(taskIdInput, "待办 ID");
  const reason = requireReason(reasonInput);
  const operationId = requireId(operationIdInput, "操作 ID");
  const now = nowInput === undefined
    ? new Date().toISOString()
    : requireTimestamp(nowInput, "操作时间");
  return [
    ...guardStatements(
      operationId,
      "(SELECT COUNT(*) FROM career_tasks WHERE id = ? AND status = 'todo') = 1",
      [taskId],
    ),
    {
      sql: `INSERT INTO career_lifecycle_events(
          id,job_id,entity_type,entity_id,action,previous_status,next_status,
          previous_due_at,next_due_at,reason,created_at
        )
        SELECT ?,job_id,'task',id,'cancel_task',status,'canceled',due_at,due_at,?,?
        FROM career_tasks WHERE id = ? AND status = 'todo'`,
      params: [operationId, reason, now, taskId],
    },
    {
      sql: `UPDATE career_tasks
        SET status = 'canceled',
            canceled_at = ?,
            cancellation_reason = ?,
            lifecycle_previous_status = NULL,
            lifecycle_operation_id = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'todo'`,
      params: [now, reason, now, taskId],
    },
    dropGuardStatement(operationId),
  ];
}

export function planRestoreCareerTask(
  taskIdInput: string,
  nowInput?: string,
  operationIdInput = uid("lifecycle"),
): SqlStatement[] {
  const taskId = requireId(taskIdInput, "待办 ID");
  const operationId = requireId(operationIdInput, "操作 ID");
  const now = nowInput === undefined
    ? new Date().toISOString()
    : requireTimestamp(nowInput, "操作时间");
  return [
    ...guardStatements(
      operationId,
      `(SELECT COUNT(*)
        FROM career_tasks AS task
        LEFT JOIN career_jobs AS job ON job.id = task.job_id
        LEFT JOIN career_stages AS stage ON stage.id = job.stage_id
        WHERE task.id = ?
          AND task.status = 'canceled'
          AND (task.job_id IS NULL
            OR (job.archived = 0 AND stage.is_terminal = 0))) = 1`,
      [taskId],
    ),
    {
      sql: `INSERT INTO career_lifecycle_events(
          id,job_id,entity_type,entity_id,action,previous_status,next_status,
          previous_due_at,next_due_at,reason,created_at
        )
        SELECT ?,job_id,'task',id,
          CASE WHEN lifecycle_operation_id IS NULL THEN 'restore_task'
            ELSE 'restore_paused_task' END,
          status,'todo',due_at,due_at,cancellation_reason,?
        FROM career_tasks WHERE id = ? AND status = 'canceled'`,
      params: [operationId, now, taskId],
    },
    {
      sql: `UPDATE career_tasks
        SET status = 'todo',
            canceled_at = NULL,
            cancellation_reason = NULL,
            lifecycle_previous_status = NULL,
            lifecycle_operation_id = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'canceled'`,
      params: [now, taskId],
    },
    dropGuardStatement(operationId),
  ];
}

async function executeLifecyclePlan(statements: readonly SqlStatement[]): Promise<void> {
  await withCareerWriteLock(async () => {
    await localDb.batch(DB, statements, { transaction: true });
  });
}

export async function archiveCareerJob(
  jobId: string,
  options: CareerLifecycleOptions<CareerRelatedPauseAction>,
): Promise<void> {
  await executeLifecyclePlan(planArchiveCareerJob(jobId, options));
}

export async function restoreCareerJob(
  jobIdInput: string,
  options: CareerLifecycleOptions<CareerRelatedRestoreAction>,
): Promise<void> {
  const jobId = requireId(jobIdInput, "职位 ID");
  await executeLifecyclePlan(planRestoreCareerJob(jobId, options));
}

export async function transitionCareerJobStage(
  jobIdInput: string,
  nextStageId: string,
  options: CareerLifecycleOptions<CareerStageRelatedAction>,
): Promise<void> {
  const jobId = requireId(jobIdInput, "职位 ID");
  await executeLifecyclePlan(
    planTransitionCareerJobStage(jobId, nextStageId, options),
  );
}

export async function rescheduleCareerTask(
  taskId: string,
  dueAt: string | null,
  now?: string,
): Promise<void> {
  await executeLifecyclePlan(planRescheduleCareerTask(taskId, dueAt, now));
}

export async function cancelCareerTask(
  taskId: string,
  reason: CareerTaskCancellationReason | string = "no_longer_needed",
  now?: string,
): Promise<void> {
  await executeLifecyclePlan(planCancelCareerTask(taskId, reason, now));
}

export async function restoreCareerTask(taskId: string, now?: string): Promise<void> {
  await executeLifecyclePlan(planRestoreCareerTask(taskId, now));
}

function unwrapRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? rows as T[] : [];
  }
  return [];
}

async function query<T>(
  sql: string,
  params: readonly unknown[],
  context: CareerLockContext,
): Promise<T[]> {
  void context;
  return unwrapRows<T>(await localDb.query(DB, sql, params));
}

function scopeCondition(scope: CareerLifecycleScope): string {
  switch (scope) {
    case "active":
      return "job.archived = 0 AND stage.is_terminal = 0";
    case "ended":
      return "job.archived = 0 AND stage.is_terminal = 1";
    case "archived":
      return "job.archived = 1";
    case "all":
      return "1 = 1";
  }
}

export async function loadCareerLifecycleScope(
  scope: CareerLifecycleScope,
): Promise<CareerLifecycleSnapshot> {
  const condition = scopeCondition(scope);
  return withCareerReadLock(async (context) => {
    const jobsSql = `SELECT job.*
      FROM career_jobs AS job
      JOIN career_stages AS stage ON stage.id = job.stage_id
      WHERE ${condition}
      ORDER BY job.position,job.updated_at DESC`;
    const dependentCondition = `EXISTS (
      SELECT 1 FROM career_jobs AS job
      JOIN career_stages AS stage ON stage.id = job.stage_id
      WHERE job.id = dependent.job_id AND ${condition}
    )`;
    const includeUnlinked = scope === "active" || scope === "all";
    const [jobs, tasks, interviews] = await Promise.all([
      query<Job>(jobsSql, [], context),
      query<Task>(
        `SELECT dependent.* FROM career_tasks AS dependent
          WHERE ${includeUnlinked ? "dependent.job_id IS NULL OR " : ""}${dependentCondition}
          ORDER BY dependent.status,dependent.due_at`,
        [],
        context,
      ),
      query<Interview>(
        `SELECT dependent.* FROM career_interviews AS dependent
          WHERE ${dependentCondition}
          ORDER BY dependent.scheduled_at`,
        [],
        context,
      ),
    ]);
    return { jobs, tasks, interviews };
  });
}

export async function loadCareerLifecycleEvents(
  filter: Readonly<{
    jobId?: string;
    entityType?: CareerLifecycleEvent["entity_type"];
    entityId?: string;
  }> = {},
): Promise<CareerLifecycleEvent[]> {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.jobId !== undefined) {
    clauses.push("job_id = ?");
    params.push(requireId(filter.jobId, "职位 ID"));
  }
  if (filter.entityType !== undefined) {
    if (!["job", "task", "interview"].includes(filter.entityType)) {
      throw new TypeError("记录类型无效");
    }
    clauses.push("entity_type = ?");
    params.push(filter.entityType);
  }
  if (filter.entityId !== undefined) {
    clauses.push("entity_id = ?");
    params.push(requireId(filter.entityId, "记录 ID"));
  }
  return withCareerReadLock((context) => query<CareerLifecycleEvent>(
    `SELECT * FROM career_lifecycle_events
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC,id DESC`,
    params,
    context,
  ));
}
