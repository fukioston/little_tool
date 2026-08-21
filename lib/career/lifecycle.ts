import { localDb } from "@/lib/local-db/client";
import type { SqlStatement } from "@/lib/local-db/types";
import {
  withCareerBackupLock,
  withCareerReadLock,
  withCareerWriteLock,
  type CareerLockContext,
} from "./lock";
import { ZHIJI_V3_SCHEMA_MIGRATION_STATEMENTS } from "../schemas/zhiji";
import type { Interview, Job, Stage, Task } from "./types";

const DB = "career" as const;

export type CareerLifecycleScope = "active" | "ended" | "archived" | "all";
export type CareerRelatedPauseAction = "keep" | "pause";
export type CareerRelatedRestoreAction = "keep-paused" | "restore-paused";
export type CareerStageRelatedAction =
  | CareerRelatedPauseAction
  | CareerRelatedRestoreAction;

export type CareerLifecycleChoice = CareerStageRelatedAction;

export type CareerLifecycleIntent =
  | Readonly<{
      kind: "stage";
      jobId: string;
      nextStageId: string;
      operationId?: string;
    }>
  | Readonly<{
      kind: "archive";
      jobId: string;
      operationId?: string;
    }>
  | Readonly<{
      kind: "restore";
      jobId: string;
      operationId?: string;
    }>;

export type CareerPreparedLifecycleIntent =
  | Readonly<{
      kind: "stage";
      jobId: string;
      nextStageId: string;
      operationId: string;
    }>
  | Readonly<{
      kind: "archive";
      jobId: string;
      operationId: string;
    }>
  | Readonly<{
      kind: "restore";
      jobId: string;
      operationId: string;
    }>;

export type CareerLifecycleImpactItem = Readonly<{
  entityType: "task" | "interview";
  id: string;
  /** A task title or interview round only; private notes are never returned. */
  label: string;
  scheduledAt: string | null;
  status: string;
  classification: "affected" | "elapsed" | "edited";
  effect: "pause" | "restore";
}>;

export type CareerLifecycleTransition =
  | "active-to-active"
  | "active-to-terminal"
  | "terminal-to-active"
  | "terminal-to-terminal"
  | "archive"
  | "restore-active"
  | "restore-terminal";

export type CareerLifecycleStageSummary = Readonly<{
  id: string;
  name: string;
  isTerminal: boolean;
}>;

export type CareerPreparedLifecycleChange = Readonly<{
  intent: CareerPreparedLifecycleIntent;
  operationId: string;
  preparedAt: string;
  transition: CareerLifecycleTransition;
  job: Readonly<{
    id: string;
    company: string;
    role: string;
    archived: boolean;
    currentStage: CareerLifecycleStageSummary;
    nextStage: CareerLifecycleStageSummary | null;
  }>;
  impact: readonly CareerLifecycleImpactItem[];
  counts: Readonly<{
    affected: number;
    elapsed: number;
    edited: number;
  }>;
  requiresChoice: boolean;
  allowedChoices: readonly CareerLifecycleChoice[];
  /** Opaque digest of every fact used to produce this preview. */
  fingerprint: string;
}>;

export type CareerLifecycleCommitResult =
  | Readonly<{
      status: "committed";
      operationId: string;
      committedAt: string;
    }>
  | Readonly<{
      status: "changed";
      prepared: CareerPreparedLifecycleChange;
    }>;

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

export type CareerTaskRestoreOptions = Readonly<{
  /** Omit to retain an existing safe date; pass null to restore without one. */
  dueAt?: string | null;
  now?: string;
  operationId?: string;
}>;

export type CareerInterviewRestoreOptions = Readonly<{
  /** Omit to retain an existing future schedule. */
  scheduledAt?: string;
  now?: string;
  operationId?: string;
}>;

/**
 * Additive v3 migration. A current row carries the exact lifecycle operation
 * that paused it; the immutable ledger retains every earlier decision. This
 * lets a later restore touch only rows paused by the matching job operation.
 */
export const CAREER_LIFECYCLE_V3_MIGRATION_STATEMENTS:
readonly SqlStatement[] = ZHIJI_V3_SCHEMA_MIGRATION_STATEMENTS;

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

function normalizedTaskRestoreOptions(
  optionsOrNow: CareerTaskRestoreOptions | string | undefined,
  legacyOperationId: string,
): Readonly<{
  replaceDueAt: boolean;
  dueAt: string | null;
  now: string;
  operationId: string;
}> {
  if (typeof optionsOrNow === "string" || optionsOrNow === undefined) {
    return {
      replaceDueAt: false,
      dueAt: null,
      now: optionsOrNow === undefined
        ? new Date().toISOString()
        : requireTimestamp(optionsOrNow, "操作时间"),
      operationId: requireId(legacyOperationId, "操作 ID"),
    };
  }
  if (!optionsOrNow || typeof optionsOrNow !== "object") {
    throw new TypeError("恢复待办参数无效");
  }
  const replaceDueAt = Object.prototype.hasOwnProperty.call(
    optionsOrNow,
    "dueAt",
  );
  if (replaceDueAt && optionsOrNow.dueAt === undefined) {
    throw new TypeError("新的待办时间必须是有效时间或 null");
  }
  return {
    replaceDueAt,
    dueAt: optionsOrNow.dueAt === null || optionsOrNow.dueAt === undefined
      ? null
      : requireTimestamp(optionsOrNow.dueAt, "新的待办时间"),
    now: optionsOrNow.now === undefined
      ? new Date().toISOString()
      : requireTimestamp(optionsOrNow.now, "操作时间"),
    operationId: optionsOrNow.operationId === undefined
      ? requireId(legacyOperationId, "操作 ID")
      : requireId(optionsOrNow.operationId, "操作 ID"),
  };
}

function normalizedInterviewRestoreOptions(
  options: CareerInterviewRestoreOptions | undefined,
  generatedOperationId: string,
): Readonly<{
  replaceScheduledAt: boolean;
  scheduledAt: string | null;
  now: string;
  operationId: string;
}> {
  if (options !== undefined && (!options || typeof options !== "object")) {
    throw new TypeError("恢复面试参数无效");
  }
  const replaceScheduledAt = options !== undefined &&
    Object.prototype.hasOwnProperty.call(options, "scheduledAt");
  if (replaceScheduledAt && options?.scheduledAt === undefined) {
    throw new TypeError("新的面试时间必须是有效时间");
  }
  return {
    replaceScheduledAt,
    scheduledAt: options?.scheduledAt === undefined
      ? null
      : requireTimestamp(options.scheduledAt, "新的面试时间"),
    now: options?.now === undefined
      ? new Date().toISOString()
      : requireTimestamp(options.now, "操作时间"),
    operationId: options?.operationId === undefined
      ? requireId(generatedOperationId, "操作 ID")
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
  const pauseAction = reason === "job_archived"
    ? "auto_pause_job_archived"
    : "auto_pause_job_ended";
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
          AND due_at IS NOT NULL
          AND due_at > ?
          AND EXISTS (
            SELECT 1 FROM career_lifecycle_events AS pause_event
            WHERE pause_event.id = career_tasks.lifecycle_operation_id
                || '_task_' || career_tasks.id
              AND pause_event.job_id IS career_tasks.job_id
              AND pause_event.entity_type = 'task'
              AND pause_event.entity_id = career_tasks.id
              AND pause_event.action = ?
              AND pause_event.previous_status = career_tasks.lifecycle_previous_status
              AND pause_event.next_status = career_tasks.status
              AND pause_event.previous_due_at IS career_tasks.due_at
              AND pause_event.next_due_at IS career_tasks.due_at
              AND pause_event.reason = ?
              AND pause_event.created_at = career_tasks.canceled_at
          )
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
        now,
        pauseAction,
        reason,
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
          AND due_at IS NOT NULL
          AND due_at > ?
          AND EXISTS (
            SELECT 1 FROM career_lifecycle_events AS pause_event
            WHERE pause_event.id = career_tasks.lifecycle_operation_id
                || '_task_' || career_tasks.id
              AND pause_event.job_id IS career_tasks.job_id
              AND pause_event.entity_type = 'task'
              AND pause_event.entity_id = career_tasks.id
              AND pause_event.action = ?
              AND pause_event.previous_status = career_tasks.lifecycle_previous_status
              AND pause_event.next_status = career_tasks.status
              AND pause_event.previous_due_at IS career_tasks.due_at
              AND pause_event.next_due_at IS career_tasks.due_at
              AND pause_event.reason = ?
              AND pause_event.created_at = career_tasks.canceled_at
          )
          AND EXISTS (
            SELECT 1
            FROM career_jobs AS active_job
            JOIN career_stages AS active_stage
              ON active_stage.id = active_job.stage_id
            WHERE active_job.id = career_tasks.job_id
              AND active_job.archived = 0
              AND active_stage.is_terminal = 0
          )`,
      params: [now, jobId, reason, jobId, now, pauseAction, reason],
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
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND EXISTS (
            SELECT 1 FROM career_lifecycle_events AS pause_event
            WHERE pause_event.id = career_interviews.lifecycle_operation_id
                || '_interview_' || career_interviews.id
              AND pause_event.job_id IS career_interviews.job_id
              AND pause_event.entity_type = 'interview'
              AND pause_event.entity_id = career_interviews.id
              AND pause_event.action = ?
              AND pause_event.previous_status = career_interviews.lifecycle_previous_status
              AND pause_event.next_status = career_interviews.status
              AND pause_event.previous_due_at IS career_interviews.scheduled_at
              AND pause_event.next_due_at IS career_interviews.scheduled_at
              AND pause_event.reason = ?
              AND pause_event.created_at = career_interviews.canceled_at
          )
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
        now,
        pauseAction,
        reason,
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
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND EXISTS (
            SELECT 1 FROM career_lifecycle_events AS pause_event
            WHERE pause_event.id = career_interviews.lifecycle_operation_id
                || '_interview_' || career_interviews.id
              AND pause_event.job_id IS career_interviews.job_id
              AND pause_event.entity_type = 'interview'
              AND pause_event.entity_id = career_interviews.id
              AND pause_event.action = ?
              AND pause_event.previous_status = career_interviews.lifecycle_previous_status
              AND pause_event.next_status = career_interviews.status
              AND pause_event.previous_due_at IS career_interviews.scheduled_at
              AND pause_event.next_due_at IS career_interviews.scheduled_at
              AND pause_event.reason = ?
              AND pause_event.created_at = career_interviews.canceled_at
          )
          AND EXISTS (
            SELECT 1
            FROM career_jobs AS active_job
            JOIN career_stages AS active_stage
              ON active_stage.id = active_job.stage_id
            WHERE active_job.id = career_interviews.job_id
              AND active_job.archived = 0
              AND active_stage.is_terminal = 0
          )`,
      params: [now, jobId, reason, jobId, now, pauseAction, reason],
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
            archived_operation_id = COALESCE(?, archived_operation_id),
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
                THEN CASE
                  WHEN ? = 'pause' THEN ? ELSE ended_operation_id END
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
      ? [
          ...restoreJobDependents(
            jobId,
            "job_ended",
            "ended_operation_id",
            operationId,
            now,
          ),
          ...restoreJobDependents(
            jobId,
            "job_archived",
            "archived_operation_id",
            operationId,
            now,
          ),
        ]
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
  optionsOrNow?: CareerTaskRestoreOptions | string,
  operationIdInput = uid("lifecycle"),
): SqlStatement[] {
  const taskId = requireId(taskIdInput, "待办 ID");
  const {
    replaceDueAt,
    dueAt,
    now,
    operationId,
  } = normalizedTaskRestoreOptions(optionsOrNow, operationIdInput);
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
            OR (job.archived = 0 AND stage.is_terminal = 0))
          AND (
            CASE WHEN ? = 1 THEN ? ELSE task.due_at END IS NULL
            OR CASE WHEN ? = 1 THEN ? ELSE task.due_at END > ?
          )) = 1`,
      [
        taskId,
        replaceDueAt ? 1 : 0,
        dueAt,
        replaceDueAt ? 1 : 0,
        dueAt,
        now,
      ],
    ),
    {
      sql: `INSERT INTO career_lifecycle_events(
          id,job_id,entity_type,entity_id,action,previous_status,next_status,
          previous_due_at,next_due_at,reason,created_at
        )
        SELECT ?,job_id,'task',id,
          CASE WHEN lifecycle_operation_id IS NULL THEN 'restore_task'
            ELSE 'restore_paused_task' END,
          status,'todo',due_at,
          CASE WHEN ? = 1 THEN ? ELSE due_at END,
          COALESCE(cancellation_reason,''),?
        FROM career_tasks WHERE id = ? AND status = 'canceled'`,
      params: [operationId, replaceDueAt ? 1 : 0, dueAt, now, taskId],
    },
    {
      sql: `UPDATE career_tasks
        SET status = 'todo',
            due_at = CASE WHEN ? = 1 THEN ? ELSE due_at END,
            canceled_at = NULL,
            cancellation_reason = NULL,
            lifecycle_previous_status = NULL,
            lifecycle_operation_id = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'canceled'`,
      params: [replaceDueAt ? 1 : 0, dueAt, now, taskId],
    },
    dropGuardStatement(operationId),
  ];
}

export function planRestoreCareerInterview(
  interviewIdInput: string,
  options?: CareerInterviewRestoreOptions,
  operationIdInput = uid("lifecycle"),
): SqlStatement[] {
  const interviewId = requireId(interviewIdInput, "面试 ID");
  const {
    replaceScheduledAt,
    scheduledAt,
    now,
    operationId,
  } = normalizedInterviewRestoreOptions(options, operationIdInput);
  return [
    ...guardStatements(
      operationId,
      `(SELECT COUNT(*)
        FROM career_interviews AS interview
        JOIN career_jobs AS job ON job.id = interview.job_id
        JOIN career_stages AS stage ON stage.id = job.stage_id
        WHERE interview.id = ?
          AND interview.status = 'canceled'
          AND job.archived = 0
          AND stage.is_terminal = 0
          AND CASE WHEN ? = 1 THEN ? ELSE interview.scheduled_at END IS NOT NULL
          AND CASE WHEN ? = 1 THEN ? ELSE interview.scheduled_at END > ?
      ) = 1`,
      [
        interviewId,
        replaceScheduledAt ? 1 : 0,
        scheduledAt,
        replaceScheduledAt ? 1 : 0,
        scheduledAt,
        now,
      ],
    ),
    {
      sql: `INSERT INTO career_lifecycle_events(
          id,job_id,entity_type,entity_id,action,previous_status,next_status,
          previous_due_at,next_due_at,reason,created_at
        )
        SELECT ?,job_id,'interview',id,
          CASE WHEN lifecycle_operation_id IS NULL THEN 'restore_interview'
            ELSE 'restore_paused_interview' END,
          status,'scheduled',scheduled_at,
          CASE WHEN ? = 1 THEN ? ELSE scheduled_at END,
          COALESCE(cancellation_reason,''),?
        FROM career_interviews WHERE id = ? AND status = 'canceled'`,
      params: [
        operationId,
        replaceScheduledAt ? 1 : 0,
        scheduledAt,
        now,
        interviewId,
      ],
    },
    {
      sql: `UPDATE career_interviews
        SET status = 'scheduled',
            scheduled_at = CASE WHEN ? = 1 THEN ? ELSE scheduled_at END,
            canceled_at = NULL,
            cancellation_reason = NULL,
            lifecycle_previous_status = NULL,
            lifecycle_operation_id = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'canceled'`,
      params: [
        replaceScheduledAt ? 1 : 0,
        scheduledAt,
        now,
        interviewId,
      ],
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

export async function restoreCareerTask(
  taskId: string,
  optionsOrNow?: CareerTaskRestoreOptions | string,
): Promise<void> {
  await executeLifecyclePlan(planRestoreCareerTask(taskId, optionsOrNow));
}

export async function restoreCareerInterview(
  interviewId: string,
  options?: CareerInterviewRestoreOptions,
): Promise<void> {
  await executeLifecyclePlan(planRestoreCareerInterview(interviewId, options));
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

type CareerPauseSource = Readonly<{
  operationId: string;
  reason: "job_archived" | "job_ended";
  action: "auto_pause_job_archived" | "auto_pause_job_ended";
}>;

function normalizeLifecycleIntent(
  intent: CareerLifecycleIntent,
): CareerPreparedLifecycleIntent {
  if (!intent || typeof intent !== "object") {
    throw new TypeError("职位变更意图无效");
  }
  const operationId = intent.operationId === undefined
    ? uid("lifecycle")
    : requireId(intent.operationId, "操作 ID");
  switch (intent.kind) {
    case "stage":
      return {
        kind: "stage",
        jobId: requireId(intent.jobId, "职位 ID"),
        nextStageId: requireId(intent.nextStageId, "阶段 ID"),
        operationId,
      };
    case "archive":
      return {
        kind: "archive",
        jobId: requireId(intent.jobId, "职位 ID"),
        operationId,
      };
    case "restore":
      return {
        kind: "restore",
        jobId: requireId(intent.jobId, "职位 ID"),
        operationId,
      };
    default:
      throw new TypeError("职位变更意图无效");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
    case "bigint":
      return JSON.stringify(value.toString());
    case "undefined":
      return "null";
    case "object": {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(",")}}`;
    }
    default:
      return JSON.stringify(String(value));
  }
}

async function fingerprintLifecycleFacts(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function sortedById<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

function sortedImpact(
  impact: readonly CareerLifecycleImpactItem[],
): CareerLifecycleImpactItem[] {
  return [...impact].sort((left, right) =>
    left.entityType.localeCompare(right.entityType) ||
    left.id.localeCompare(right.id));
}

function pauseImpact(
  tasks: readonly Task[],
  interviews: readonly Interview[],
  now: string,
): CareerLifecycleImpactItem[] {
  const impact: CareerLifecycleImpactItem[] = [];
  for (const task of tasks) {
    if (
      task.status !== "todo" ||
      task.due_at === null ||
      task.lifecycle_operation_id !== null
    ) continue;
    impact.push({
      entityType: "task",
      id: task.id,
      label: task.title,
      scheduledAt: task.due_at,
      status: task.status,
      classification: task.due_at > now ? "affected" : "elapsed",
      effect: "pause",
    });
  }
  for (const interview of interviews) {
    if (
      interview.status !== "scheduled" ||
      interview.scheduled_at === null ||
      interview.lifecycle_operation_id !== null
    ) continue;
    impact.push({
      entityType: "interview",
      id: interview.id,
      label: interview.round_name,
      scheduledAt: interview.scheduled_at,
      status: interview.status,
      classification: interview.scheduled_at > now ? "affected" : "elapsed",
      effect: "pause",
    });
  }
  return sortedImpact(impact);
}

function matchingPauseEvent(
  events: readonly CareerLifecycleEvent[],
  source: CareerPauseSource,
  entityType: "task" | "interview",
  entityId: string,
): CareerLifecycleEvent | undefined {
  return events.find((event) =>
    event.id === `${source.operationId}_${entityType}_${entityId}` &&
    event.entity_type === entityType &&
    event.entity_id === entityId);
}

function restoreClassification(
  row: Task | Interview,
  entityType: "task" | "interview",
  scheduledAt: string | null,
  sources: readonly CareerPauseSource[],
  events: readonly CareerLifecycleEvent[],
  now: string,
): CareerLifecycleImpactItem["classification"] | null {
  let associated = false;
  let elapsed = false;
  for (const source of sources) {
    const event = matchingPauseEvent(events, source, entityType, row.id);
    const belongsToSource = row.lifecycle_operation_id === source.operationId ||
      event !== undefined;
    if (!belongsToSource) continue;
    associated = true;
    const expectedPreviousStatus = entityType === "task" ? "todo" : "scheduled";
    const exactPauseFingerprint =
      row.status === "canceled" &&
      row.cancellation_reason === source.reason &&
      row.lifecycle_operation_id === source.operationId &&
      row.lifecycle_previous_status === expectedPreviousStatus &&
      row.canceled_at !== null &&
      row.updated_at === row.canceled_at &&
      scheduledAt !== null &&
      event !== undefined &&
      event.job_id === row.job_id &&
      event.action === source.action &&
      event.previous_status === expectedPreviousStatus &&
      event.next_status === row.status &&
      event.previous_due_at === scheduledAt &&
      event.next_due_at === scheduledAt &&
      event.reason === source.reason &&
      event.created_at === row.canceled_at;
    if (!exactPauseFingerprint) continue;
    if (scheduledAt > now) return "affected";
    elapsed = true;
  }
  if (elapsed) return "elapsed";
  return associated ? "edited" : null;
}

function restoreImpact(
  tasks: readonly Task[],
  interviews: readonly Interview[],
  sources: readonly CareerPauseSource[],
  events: readonly CareerLifecycleEvent[],
  now: string,
): CareerLifecycleImpactItem[] {
  const impact: CareerLifecycleImpactItem[] = [];
  for (const task of tasks) {
    const classification = restoreClassification(
      task,
      "task",
      task.due_at,
      sources,
      events,
      now,
    );
    if (classification === null) continue;
    impact.push({
      entityType: "task",
      id: task.id,
      label: task.title,
      scheduledAt: task.due_at,
      status: task.status,
      classification,
      effect: "restore",
    });
  }
  for (const interview of interviews) {
    const classification = restoreClassification(
      interview,
      "interview",
      interview.scheduled_at,
      sources,
      events,
      now,
    );
    if (classification === null) continue;
    impact.push({
      entityType: "interview",
      id: interview.id,
      label: interview.round_name,
      scheduledAt: interview.scheduled_at,
      status: interview.status,
      classification,
      effect: "restore",
    });
  }
  return sortedImpact(impact);
}

function pauseSource(
  operationId: string | null,
  reason: CareerPauseSource["reason"],
): CareerPauseSource | null {
  if (!operationId) return null;
  return {
    operationId,
    reason,
    action: reason === "job_archived"
      ? "auto_pause_job_archived"
      : "auto_pause_job_ended",
  };
}

function stageSummary(stage: Stage): CareerLifecycleStageSummary {
  return {
    id: stage.id,
    name: stage.name,
    isTerminal: stage.is_terminal === 1,
  };
}

async function prepareCareerLifecycleChangeInLock(
  intent: CareerPreparedLifecycleIntent,
  now: string,
  context: CareerLockContext,
): Promise<CareerPreparedLifecycleChange> {
  const jobs = await query<Job>(
    "SELECT * FROM career_jobs WHERE id = ?",
    [intent.jobId],
    context,
  );
  if (jobs.length !== 1) throw new Error("没有找到这个职位");
  const job = jobs[0];
  const [currentStages, tasks, interviews, events] = await Promise.all([
    query<Stage>(
      "SELECT * FROM career_stages WHERE id = ?",
      [job.stage_id],
      context,
    ),
    query<Task>(
      "SELECT * FROM career_tasks WHERE job_id = ? ORDER BY id",
      [job.id],
      context,
    ),
    query<Interview>(
      "SELECT * FROM career_interviews WHERE job_id = ? ORDER BY id",
      [job.id],
      context,
    ),
    query<CareerLifecycleEvent>(
      "SELECT * FROM career_lifecycle_events WHERE job_id = ? ORDER BY id",
      [job.id],
      context,
    ),
  ]);
  if (currentStages.length !== 1) throw new Error("职位当前阶段不存在");
  const currentStage = currentStages[0];
  let nextStage: Stage | null = null;
  if (intent.kind === "stage") {
    const nextStages = await query<Stage>(
      "SELECT * FROM career_stages WHERE id = ?",
      [intent.nextStageId],
      context,
    );
    if (nextStages.length !== 1) throw new Error("目标阶段不存在");
    nextStage = nextStages[0];
    if (nextStage.id === currentStage.id) {
      throw new Error("这个职位已经在当前阶段，不需要重复记录");
    }
  }

  let transition: CareerLifecycleTransition;
  let impact: CareerLifecycleImpactItem[];
  let allowedChoices: readonly CareerLifecycleChoice[];
  let requiresChoice: boolean;
  const currentIsTerminal = currentStage.is_terminal === 1;

  if (intent.kind === "archive") {
    if (job.archived !== 0) throw new Error("这个职位已经归档");
    transition = "archive";
    impact = pauseImpact(tasks, interviews, now);
    requiresChoice = impact.some(({ classification }) => classification === "affected");
    allowedChoices = requiresChoice ? ["keep", "pause"] : ["keep"];
  } else if (intent.kind === "restore") {
    if (job.archived !== 1) throw new Error("这个职位没有归档");
    transition = currentIsTerminal ? "restore-terminal" : "restore-active";
    const source = pauseSource(job.archived_operation_id, "job_archived");
    impact = restoreImpact(
      tasks,
      interviews,
      source === null ? [] : [source],
      events,
      now,
    );
    requiresChoice = !currentIsTerminal &&
      impact.some(({ classification }) => classification === "affected");
    allowedChoices = requiresChoice
      ? ["keep-paused", "restore-paused"]
      : ["keep-paused"];
  } else {
    if (job.archived !== 0) {
      throw new Error("请先从归档中恢复这个职位，再调整阶段");
    }
    const nextIsTerminal = nextStage!.is_terminal === 1;
    if (!currentIsTerminal && nextIsTerminal) {
      transition = "active-to-terminal";
      impact = pauseImpact(tasks, interviews, now);
      requiresChoice = impact.some(({ classification }) =>
        classification === "affected");
      allowedChoices = requiresChoice ? ["keep", "pause"] : ["keep"];
    } else if (currentIsTerminal && !nextIsTerminal) {
      transition = "terminal-to-active";
      const sources = [
        pauseSource(job.ended_operation_id, "job_ended"),
        pauseSource(job.archived_operation_id, "job_archived"),
      ].filter((source): source is CareerPauseSource => source !== null);
      impact = restoreImpact(tasks, interviews, sources, events, now);
      requiresChoice = impact.some(({ classification }) =>
        classification === "affected");
      allowedChoices = requiresChoice
        ? ["keep-paused", "restore-paused"]
        : ["keep-paused"];
    } else {
      transition = currentIsTerminal
        ? "terminal-to-terminal"
        : "active-to-active";
      impact = [];
      requiresChoice = false;
      allowedChoices = ["keep"];
    }
  }

  const counts = {
    affected: impact.filter(({ classification }) =>
      classification === "affected").length,
    elapsed: impact.filter(({ classification }) =>
      classification === "elapsed").length,
    edited: impact.filter(({ classification }) =>
      classification === "edited").length,
  };
  const fingerprint = await fingerprintLifecycleFacts({
    version: 1,
    intent,
    job,
    currentStage,
    nextStage,
    tasks: sortedById(tasks),
    interviews: sortedById(interviews),
    events: sortedById(events),
    transition,
    impact,
    allowedChoices,
  });
  return {
    intent,
    operationId: intent.operationId,
    preparedAt: now,
    transition,
    job: {
      id: job.id,
      company: job.company,
      role: job.role,
      archived: job.archived === 1,
      currentStage: stageSummary(currentStage),
      nextStage: nextStage === null ? null : stageSummary(nextStage),
    },
    impact,
    counts,
    requiresChoice,
    allowedChoices,
    fingerprint,
  };
}

export async function prepareCareerLifecycleChange(
  intentInput: CareerLifecycleIntent,
  nowInput?: string,
): Promise<CareerPreparedLifecycleChange> {
  const intent = normalizeLifecycleIntent(intentInput);
  const requestedNow = nowInput === undefined
    ? null
    : requireTimestamp(nowInput, "预览时间");
  return withCareerReadLock((context) => {
    const now = requestedNow ?? new Date().toISOString();
    return prepareCareerLifecycleChangeInLock(intent, now, context);
  });
}

function planPreparedLifecycleChange(
  prepared: CareerPreparedLifecycleChange,
  choice: CareerLifecycleChoice,
  now: string,
): SqlStatement[] {
  const options = {
    relatedAction: choice,
    operationId: prepared.operationId,
    now,
  };
  switch (prepared.intent.kind) {
    case "stage":
      return planTransitionCareerJobStage(
        prepared.intent.jobId,
        prepared.intent.nextStageId,
        options,
      );
    case "archive":
      requirePauseAction(choice);
      return planArchiveCareerJob(prepared.intent.jobId, {
        ...options,
        relatedAction: choice,
      });
    case "restore":
      requireRestoreAction(choice);
      return planRestoreCareerJob(prepared.intent.jobId, {
        ...options,
        relatedAction: choice,
      });
  }
}

export async function commitPreparedCareerLifecycleChange(
  prepared: CareerPreparedLifecycleChange,
  choice: CareerLifecycleChoice,
): Promise<CareerLifecycleCommitResult> {
  if (
    !prepared ||
    typeof prepared !== "object" ||
    typeof prepared.fingerprint !== "string" ||
    prepared.operationId !== prepared.intent?.operationId
  ) {
    throw new TypeError("职位变更预览无效，请重新预览");
  }
  const intent = normalizeLifecycleIntent(prepared.intent);
  try {
    return await withCareerBackupLock(async (context) => {
      // Capture time only after the exclusive lock is acquired. A schedule can
      // cross the future boundary while this tab is waiting for another tab.
      const committedAt = new Date().toISOString();
      const current = await prepareCareerLifecycleChangeInLock(
        intent,
        committedAt,
        context,
      );
      if (current.fingerprint !== prepared.fingerprint) {
        return { status: "changed", prepared: current };
      }
      if (!current.allowedChoices.includes(choice)) {
        throw new TypeError("请选择当前预览中可用的处理方式");
      }
      await localDb.batch(
        DB,
        planPreparedLifecycleChange(current, choice, committedAt),
        { transaction: true },
      );
      return {
        status: "committed",
        operationId: current.operationId,
        committedAt,
      };
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("不支持安全的跨标签页备份锁")
    ) {
      throw new Error("当前浏览器不支持安全的跨标签页职位变更，请升级浏览器后重试");
    }
    throw error;
  }
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
