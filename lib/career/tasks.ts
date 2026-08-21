import { localDb } from "@/lib/local-db/client";
import type { SqlStatement } from "@/lib/local-db/types";
import { withCareerReadLock, withCareerWriteLock } from "./lock";
import type { Task } from "./types";

const DB = "career" as const;

export type CreateCareerTaskInput = Readonly<{
  /** Supply a stable ID when a save may be retried after an uncertain refresh. */
  id?: string;
  title: string;
  jobId?: string | null;
  contactId?: string | null;
  dueAt?: string | null;
  kind?: string;
  priority?: number;
  now?: string;
}>;

export type CareerTaskMutationOptions = Readonly<{
  /** Reject the whole transaction if another tab has changed this task. */
  expectedUpdatedAt: string;
  now?: string;
  operationId?: string;
}>;

export type RescheduleCareerTaskOptions = CareerTaskMutationOptions & Readonly<{
  dueAt: string | null;
}>;

export type CancelCareerTaskOptions = CareerTaskMutationOptions & Readonly<{
  reason?: "no_longer_needed" | "duplicate" | "changed_plan" | "other";
}>;

export type RestoreCareerTaskOptions = CareerTaskMutationOptions & Readonly<{
  dueAt: string | null;
}>;

export type ReopenCompletedCareerTaskOptions = CareerTaskMutationOptions & Readonly<{
  /** Required by design: null means “以后再说”; a date must be in the future. */
  dueAt: string | null;
}>;

export type CareerTaskHardRestoreBlockedReason =
  | "not_canceled"
  | "job_missing"
  | "job_archived"
  | "job_stage_missing"
  | "job_ended";

export type CareerTaskErrorCode =
  | "not_found"
  | "changed"
  | "wrong_status"
  | "job_unavailable"
  | "contact_unavailable"
  | "id_conflict"
  | "expected_version_required"
  | "due_at_required"
  | "due_at_not_future"
  | "write_failed";

export class CareerTaskError extends Error {
  readonly name = "CareerTaskError";

  constructor(
    readonly code: CareerTaskErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type CareerTaskMutationResult = Readonly<{
  id: string;
  status: "todo" | "done" | "canceled";
  dueAt: string | null;
  updatedAt: string;
  operationId: string;
}>;

export type CareerTaskDetail = Readonly<{
  task: Task;
  job: Readonly<{
    id: string;
    company: string;
    role: string;
    archived: boolean;
    stage: Readonly<{
      id: string;
      name: string;
      isTerminal: boolean;
    }> | null;
  }> | null;
  contact: Readonly<{
    id: string;
    name: string;
    company: string;
    role: string;
    archived: boolean;
  }> | null;
  /** Raw cancellation facts only. No personal intent is inferred from them. */
  cancellation: Readonly<{
    reason: string | null;
    previousStatus: "todo" | null;
    lifecycleOperationId: string | null;
    canceledAt: string | null;
  }> | null;
  /** Structural state that no date choice can repair. */
  hardRestoreBlockedReason: CareerTaskHardRestoreBlockedReason | null;
  /** Restoration always asks the user to confirm a future date or “以后再说”. */
  restoreRequiresDueChoice: boolean;
  /** True even when the old date elapsed; a new future date or null is safe. */
  canRestoreWithNewDueAt: boolean;
}>;

type CareerTaskDetailRow = Task & Readonly<{
  job_context_id: string | null;
  job_company: string | null;
  job_role: string | null;
  job_archived: number | null;
  stage_context_id: string | null;
  stage_name: string | null;
  stage_is_terminal: number | null;
  contact_context_id: string | null;
  contact_name: string | null;
  contact_company: string | null;
  contact_role: string | null;
  contact_archived: number | null;
}>;

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label}不能为空`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label}不能为空`);
  if (normalized.length > maximum) throw new TypeError(`${label}过长`);
  return normalized;
}

function optionalId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, label, 240);
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label}不是有效时间`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label}不是有效时间`);
  return new Date(milliseconds).toISOString();
}

function optionalTimestamp(
  value: unknown,
  label: string,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return canonicalTimestamp(value, label);
}

function timestampOrNow(value: unknown): string {
  return value === undefined
    ? new Date().toISOString()
    : canonicalTimestamp(value, "操作时间");
}

function normalizedPriority(value: unknown): number {
  const priority = value === undefined ? 1 : value;
  if (!Number.isInteger(priority) || Number(priority) < 1 || Number(priority) > 3) {
    throw new TypeError("优先级需要是 1 到 3 的整数");
  }
  return Number(priority);
}

function unwrapRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? rows as T[] : [];
  }
  return [];
}

function taskFromDetailRow(row: CareerTaskDetailRow): Task {
  return {
    id: row.id,
    job_id: row.job_id,
    contact_id: row.contact_id,
    title: row.title,
    due_at: row.due_at,
    kind: row.kind,
    priority: Number(row.priority),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    canceled_at: row.canceled_at,
    cancellation_reason: row.cancellation_reason,
    lifecycle_previous_status: row.lifecycle_previous_status,
    lifecycle_operation_id: row.lifecycle_operation_id,
  };
}

function hardRestoreBlock(
  task: Task,
  row: CareerTaskDetailRow,
): CareerTaskHardRestoreBlockedReason | null {
  if (task.status !== "canceled") return "not_canceled";
  if (task.job_id !== null) {
    if (row.job_context_id === null) return "job_missing";
    if (Number(row.job_archived) === 1) return "job_archived";
    if (row.stage_context_id === null) return "job_stage_missing";
    if (Number(row.stage_is_terminal) === 1) return "job_ended";
  }
  return null;
}

async function readTaskDetailRow(taskId: string): Promise<CareerTaskDetailRow | null> {
  const rows = unwrapRows<CareerTaskDetailRow>(await localDb.query(
    DB,
    `SELECT task.*,
        job.id AS job_context_id,
        job.company AS job_company,
        job.role AS job_role,
        job.archived AS job_archived,
        stage.id AS stage_context_id,
        stage.name AS stage_name,
        stage.is_terminal AS stage_is_terminal,
        contact.id AS contact_context_id,
        contact.name AS contact_name,
        contact.company AS contact_company,
        contact.role AS contact_role,
        contact.archived AS contact_archived
      FROM career_tasks AS task
      LEFT JOIN career_jobs AS job ON job.id = task.job_id
      LEFT JOIN career_stages AS stage ON stage.id = job.stage_id
      LEFT JOIN career_contacts AS contact ON contact.id = task.contact_id
      WHERE task.id = ?`,
    [taskId],
  ));
  return rows[0] ?? null;
}

export async function loadCareerTaskDetail(
  taskIdInput: string,
): Promise<CareerTaskDetail | null> {
  const taskId = requiredText(taskIdInput, "待办 ID", 240);
  return withCareerReadLock(async () => {
    const row = await readTaskDetailRow(taskId);
    if (!row) return null;
    const task = taskFromDetailRow(row);
    const hardRestoreBlockedReason = hardRestoreBlock(task, row);
    return {
      task,
      job: row.job_context_id === null
        ? null
        : {
            id: row.job_context_id,
            company: row.job_company ?? "",
            role: row.job_role ?? "",
            archived: Number(row.job_archived) === 1,
            stage: row.stage_context_id === null
              ? null
              : {
                  id: row.stage_context_id,
                  name: row.stage_name ?? "",
                  isTerminal: Number(row.stage_is_terminal) === 1,
                },
          },
      contact: row.contact_context_id === null
        ? null
        : {
            id: row.contact_context_id,
            name: row.contact_name ?? "",
            company: row.contact_company ?? "",
            role: row.contact_role ?? "",
            archived: Number(row.contact_archived) === 1,
          },
      cancellation: task.status === "canceled"
        ? {
            reason: task.cancellation_reason,
            previousStatus: task.lifecycle_previous_status,
            lifecycleOperationId: task.lifecycle_operation_id,
            canceledAt: task.canceled_at,
          }
        : null,
      hardRestoreBlockedReason,
      restoreRequiresDueChoice: task.status === "canceled",
      canRestoreWithNewDueAt: task.status === "canceled" &&
        hardRestoreBlockedReason === null,
    };
  });
}

function createGuardName(operationId: string): string {
  const suffix = operationId.replace(/[^A-Za-z0-9_]/g, "").slice(0, 160);
  return `__career_task_guard_${suffix || "write"}`;
}

function statusGuard(
  operationId: string,
  conditionSql: string,
  params: readonly unknown[],
): readonly [SqlStatement, SqlStatement] {
  const table = createGuardName(operationId);
  return [
    { sql: `CREATE TEMP TABLE ${table} (value INTEGER NOT NULL CHECK (value = 1))` },
    {
      sql: `INSERT INTO ${table}(value)
        SELECT CASE WHEN (${conditionSql}) THEN 1 ELSE 0 END`,
      params,
    },
  ];
}

function dropGuard(operationId: string): SqlStatement {
  return { sql: `DROP TABLE ${createGuardName(operationId)}` };
}

function taskError(code: CareerTaskErrorCode, message: string): CareerTaskError {
  return new CareerTaskError(code, message);
}

function hasActiveJobContext(row: CareerTaskDetailRow): boolean {
  return row.job_id === null || (
    row.job_context_id !== null &&
    Number(row.job_archived) === 0 &&
    row.stage_context_id !== null &&
    Number(row.stage_is_terminal) === 0
  );
}

export async function createCareerTask(
  input: CreateCareerTaskInput,
): Promise<string> {
  if (!input || typeof input !== "object") throw new TypeError("待办内容无效");
  const id = input.id === undefined
    ? uid("task")
    : requiredText(input.id, "待办 ID", 240);
  const title = requiredText(input.title, "待办内容", 500);
  const jobId = optionalId(input.jobId, "职位 ID");
  const contactId = optionalId(input.contactId, "联系人 ID");
  const dueAt = optionalTimestamp(input.dueAt, "待办时间");
  const kind = input.kind === undefined
    ? "跟进"
    : requiredText(input.kind, "待办类型", 80);
  const priority = normalizedPriority(input.priority);
  const now = timestampOrNow(input.now);
  const eventId = `task_create_${id}`;
  return withCareerWriteLock(async () => {
    const existingRow = await readTaskDetailRow(id);
    if (existingRow) {
      const proofRows = unwrapRows<{ event_count: number; matching_count: number }>(
        await localDb.query(
          DB,
          `SELECT COUNT(*) AS event_count,
              SUM(CASE WHEN id = ?
                AND job_id IS ?
                AND action = 'create_task'
                AND previous_status IS NULL
                AND next_status = 'todo'
                AND previous_due_at IS NULL
                AND next_due_at IS ?
                AND reason = 'user'
                AND created_at = ? THEN 1 ELSE 0 END) AS matching_count
            FROM career_lifecycle_events
            WHERE entity_type = 'task' AND entity_id = ?`,
          [eventId, jobId, dueAt, existingRow.created_at, id],
        ),
      );
      const proof = proofRows[0];
      const isExactRetry = existingRow.job_id === jobId &&
        existingRow.contact_id === contactId &&
        existingRow.title === title &&
        existingRow.due_at === dueAt &&
        existingRow.kind === kind &&
        Number(existingRow.priority) === priority &&
        existingRow.status === "todo" &&
        existingRow.updated_at === existingRow.created_at &&
        existingRow.canceled_at === null &&
        existingRow.cancellation_reason === null &&
        existingRow.lifecycle_previous_status === null &&
        existingRow.lifecycle_operation_id === null &&
        Number(proof?.event_count ?? 0) === 1 &&
        Number(proof?.matching_count ?? 0) === 1;
      if (isExactRetry) return id;
      throw taskError("id_conflict", "这个待办保存标识已用于另一条记录，请刷新后再试");
    }

    const availability = unwrapRows<{ job_ok: number; contact_ok: number }>(
      await localDb.query(
        DB,
        `SELECT
          CASE WHEN ? IS NULL THEN 1 ELSE EXISTS (
            SELECT 1 FROM career_jobs AS job
            JOIN career_stages AS stage ON stage.id = job.stage_id
            WHERE job.id = ? AND job.archived = 0 AND stage.is_terminal = 0
          ) END AS job_ok,
          CASE WHEN ? IS NULL THEN 1 ELSE EXISTS (
            SELECT 1 FROM career_contacts AS contact
            WHERE contact.id = ? AND contact.archived = 0
          ) END AS contact_ok`,
        [jobId, jobId, contactId, contactId],
      ),
    )[0];
    if (Number(availability?.job_ok ?? 0) !== 1) {
      throw taskError("job_unavailable", "关联职位当前不可用于新待办，请刷新后确认职位状态");
    }
    if (Number(availability?.contact_ok ?? 0) !== 1) {
      throw taskError("contact_unavailable", "关联联系人当前不可用于新待办，请刷新后确认联系人状态");
    }

    const statements: SqlStatement[] = [
      ...statusGuard(
        eventId,
        `NOT EXISTS (SELECT 1 FROM career_tasks WHERE id = ?)
          AND NOT EXISTS (SELECT 1 FROM career_lifecycle_events WHERE id = ?)
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM career_jobs AS job
            JOIN career_stages AS stage ON stage.id = job.stage_id
            WHERE job.id = ? AND job.archived = 0 AND stage.is_terminal = 0
          ))
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM career_contacts AS contact
            WHERE contact.id = ? AND contact.archived = 0
          ))`,
        [id, eventId, jobId, jobId, contactId, contactId],
      ),
      {
        sql: `INSERT INTO career_tasks(
            id,job_id,contact_id,title,due_at,kind,priority,status,created_at,
            updated_at,canceled_at,cancellation_reason,lifecycle_previous_status,
            lifecycle_operation_id
          ) VALUES(?,?,?,?,?,?,?,'todo',?,?,NULL,NULL,NULL,NULL)`,
        params: [id, jobId, contactId, title, dueAt, kind, priority, now, now],
      },
      {
        sql: `INSERT INTO career_lifecycle_events(
            id,job_id,entity_type,entity_id,action,previous_status,next_status,
            previous_due_at,next_due_at,reason,created_at
          ) VALUES(?,?,'task',?,'create_task',NULL,'todo',NULL,?,'user',?)`,
        params: [eventId, jobId, id, dueAt, now],
      },
      dropGuard(eventId),
    ];
    try {
      await localDb.batch(DB, statements, { transaction: true });
      return id;
    } catch {
      const after = await readTaskDetailRow(id);
      if (after) {
        throw taskError("id_conflict", "这个待办保存标识已用于另一条记录，请刷新后再试");
      }
      throw taskError("write_failed", "待办没有写入，本次操作未改变任何记录");
    }
  });
}

type NormalizedMutationOptions = Readonly<{
  expectedUpdatedAt: string;
  requestedNow: string;
  operationId: string;
}>;

function normalizedMutationOptions(
  options: CareerTaskMutationOptions | undefined,
): NormalizedMutationOptions {
  if (options !== undefined && (!options || typeof options !== "object")) {
    throw taskError("expected_version_required", "请刷新待办后再操作");
  }
  if (!options || !Object.prototype.hasOwnProperty.call(options, "expectedUpdatedAt") ||
    typeof options.expectedUpdatedAt !== "string" || !options.expectedUpdatedAt.trim()) {
    throw taskError("expected_version_required", "请刷新待办后再操作");
  }
  let expectedUpdatedAt: string;
  try {
    expectedUpdatedAt = canonicalTimestamp(options.expectedUpdatedAt, "待办版本时间");
  } catch {
    throw taskError("expected_version_required", "请刷新待办后再操作");
  }
  return {
    expectedUpdatedAt,
    requestedNow: timestampOrNow(options.now),
    operationId: options.operationId === undefined
      ? uid("task_action")
      : requiredText(options.operationId, "操作 ID", 240),
  };
}

function strictlyLaterTimestamp(requestedNow: string, expectedUpdatedAt: string): string {
  const requested = Date.parse(requestedNow);
  const expected = Date.parse(expectedUpdatedAt);
  return new Date(Math.max(requested, expected + 1)).toISOString();
}

function explicitFutureDueAt(
  options: { dueAt?: string | null } | undefined,
  now: string,
): string | null {
  if (!options || !Object.prototype.hasOwnProperty.call(options, "dueAt")) {
    throw taskError("due_at_required", "请明确选择新的待办时间，或选择以后再说");
  }
  if (options.dueAt !== null &&
    (typeof options.dueAt !== "string" || !options.dueAt.trim())) {
    throw taskError("due_at_required", "请明确选择新的待办时间，或选择以后再说");
  }
  let dueAt: string | null;
  try {
    dueAt = optionalTimestamp(options.dueAt, "新的待办时间");
  } catch {
    throw taskError("due_at_not_future", "请选择有效的未来时间，或选择以后再说");
  }
  if (dueAt !== null && Date.parse(dueAt) <= Date.parse(now)) {
    throw taskError("due_at_not_future", "新的待办时间需要晚于当前时间，或选择以后再说");
  }
  return dueAt;
}

type ExpectedTaskStatus = "todo" | "done" | "canceled";

async function executeVersionedTaskMutation(
  taskId: string,
  normalized: NormalizedMutationOptions,
  expectedStatus: ExpectedTaskStatus,
  requireActiveJob: boolean,
  buildStatements: (
    row: CareerTaskDetailRow,
    updatedAt: string,
    operationId: string,
  ) => readonly SqlStatement[],
  result: (
    row: CareerTaskDetailRow,
    updatedAt: string,
    operationId: string,
  ) => CareerTaskMutationResult,
): Promise<CareerTaskMutationResult> {
  const updatedAt = strictlyLaterTimestamp(
    normalized.requestedNow,
    normalized.expectedUpdatedAt,
  );
  return withCareerWriteLock(async () => {
    const row = await readTaskDetailRow(taskId);
    if (!row) throw taskError("not_found", "没有找到这条待办，它可能已在另一处移除");
    if (row.updated_at !== normalized.expectedUpdatedAt) {
      throw taskError("changed", "这条待办已在另一处更新，请先查看最新内容");
    }
    if (row.status !== expectedStatus) {
      throw taskError("wrong_status", "这条待办的状态已不适用于当前操作");
    }
    if (requireActiveJob && !hasActiveJobContext(row)) {
      throw taskError("job_unavailable", "关联职位已结束或归档，请先确认职位状态");
    }

    try {
      await localDb.batch(
        DB,
        buildStatements(row, updatedAt, normalized.operationId),
        { transaction: true },
      );
    } catch {
      const latest = await readTaskDetailRow(taskId);
      if (!latest) throw taskError("not_found", "没有找到这条待办，它可能已在另一处移除");
      if (latest.updated_at !== row.updated_at || latest.status !== row.status ||
        latest.due_at !== row.due_at || latest.job_id !== row.job_id) {
        throw taskError("changed", "这条待办已在另一处更新，请先查看最新内容");
      }
      if (requireActiveJob && !hasActiveJobContext(latest)) {
        throw taskError("job_unavailable", "关联职位已结束或归档，请先确认职位状态");
      }
      throw taskError("write_failed", "待办没有写入，本次操作未改变任何记录");
    }
    return result(row, updatedAt, normalized.operationId);
  });
}

function versionGuard(
  operationId: string,
  taskId: string,
  expectedStatus: ExpectedTaskStatus,
  expectedUpdatedAt: string,
  requireActiveJob = false,
): SqlStatement[] {
  return [
    ...statusGuard(
      operationId,
      `(SELECT COUNT(*) FROM career_tasks AS task
        WHERE task.id = ? AND task.status = ? AND task.updated_at = ?
          ${requireActiveJob
            ? `AND (task.job_id IS NULL OR EXISTS (
                SELECT 1 FROM career_jobs AS job
                JOIN career_stages AS stage ON stage.id = job.stage_id
                WHERE job.id = task.job_id
                  AND job.archived = 0 AND stage.is_terminal = 0
              ))`
            : ""}) = 1`,
      [taskId, expectedStatus, expectedUpdatedAt],
    ),
  ];
}

function mutationResult(
  id: string,
  status: CareerTaskMutationResult["status"],
  dueAt: string | null,
  updatedAt: string,
  operationId: string,
): CareerTaskMutationResult {
  return { id, status, dueAt, updatedAt, operationId };
}

export async function rescheduleCareerTask(
  taskIdInput: string,
  options: RescheduleCareerTaskOptions,
): Promise<CareerTaskMutationResult> {
  const taskId = requiredText(taskIdInput, "待办 ID", 240);
  const normalized = normalizedMutationOptions(options);
  const effectiveNow = strictlyLaterTimestamp(
    normalized.requestedNow,
    normalized.expectedUpdatedAt,
  );
  const dueAt = explicitFutureDueAt(options, effectiveNow);
  return executeVersionedTaskMutation(
    taskId,
    normalized,
    "todo",
    false,
    (_row, updatedAt, operationId) => [
      ...versionGuard(operationId, taskId, "todo", normalized.expectedUpdatedAt),
      {
        sql: `INSERT INTO career_lifecycle_events(
            id,job_id,entity_type,entity_id,action,previous_status,next_status,
            previous_due_at,next_due_at,reason,created_at
          ) SELECT ?,job_id,'task',id,?,status,status,due_at,?,'user',?
            FROM career_tasks WHERE id = ? AND status = 'todo' AND updated_at = ?`,
        params: [
          operationId,
          dueAt === null ? "unschedule_task" : "reschedule_task",
          dueAt,
          updatedAt,
          taskId,
          normalized.expectedUpdatedAt,
        ],
      },
      {
        sql: `UPDATE career_tasks SET due_at = ?, updated_at = ?
          WHERE id = ? AND status = 'todo' AND updated_at = ?`,
        params: [dueAt, updatedAt, taskId, normalized.expectedUpdatedAt],
      },
      dropGuard(operationId),
    ],
    (_row, updatedAt, operationId) =>
      mutationResult(taskId, "todo", dueAt, updatedAt, operationId),
  );
}

export async function cancelCareerTask(
  taskIdInput: string,
  options: CancelCareerTaskOptions,
): Promise<CareerTaskMutationResult> {
  const taskId = requiredText(taskIdInput, "待办 ID", 240);
  const normalized = normalizedMutationOptions(options);
  const reason = options.reason ?? "no_longer_needed";
  if (!["no_longer_needed", "duplicate", "changed_plan", "other"].includes(reason)) {
    throw new TypeError("取消原因不受支持");
  }
  return executeVersionedTaskMutation(
    taskId,
    normalized,
    "todo",
    false,
    (_row, updatedAt, operationId) => [
      ...versionGuard(operationId, taskId, "todo", normalized.expectedUpdatedAt),
      {
        sql: `INSERT INTO career_lifecycle_events(
            id,job_id,entity_type,entity_id,action,previous_status,next_status,
            previous_due_at,next_due_at,reason,created_at
          ) SELECT ?,job_id,'task',id,'cancel_task',status,'canceled',due_at,due_at,?,?
            FROM career_tasks WHERE id = ? AND status = 'todo' AND updated_at = ?`,
        params: [operationId, reason, updatedAt, taskId, normalized.expectedUpdatedAt],
      },
      {
        sql: `UPDATE career_tasks
          SET status='canceled',canceled_at=?,cancellation_reason=?,
            lifecycle_previous_status=NULL,lifecycle_operation_id=NULL,updated_at=?
          WHERE id=? AND status='todo' AND updated_at=?`,
        params: [
          updatedAt,
          reason,
          updatedAt,
          taskId,
          normalized.expectedUpdatedAt,
        ],
      },
      dropGuard(operationId),
    ],
    (row, updatedAt, operationId) =>
      mutationResult(taskId, "canceled", row.due_at, updatedAt, operationId),
  );
}

export async function completeCareerTask(
  taskIdInput: string,
  options: CareerTaskMutationOptions,
): Promise<CareerTaskMutationResult> {
  const taskId = requiredText(taskIdInput, "待办 ID", 240);
  const normalized = normalizedMutationOptions(options);
  return executeVersionedTaskMutation(
    taskId,
    normalized,
    "todo",
    false,
    (_row, updatedAt, operationId) => [
      ...versionGuard(operationId, taskId, "todo", normalized.expectedUpdatedAt),
      {
        sql: `INSERT INTO career_lifecycle_events(
            id,job_id,entity_type,entity_id,action,previous_status,next_status,
            previous_due_at,next_due_at,reason,created_at
          ) SELECT ?,job_id,'task',id,'complete_task',status,'done',due_at,due_at,'user',?
            FROM career_tasks WHERE id = ? AND status = 'todo' AND updated_at = ?`,
        params: [operationId, updatedAt, taskId, normalized.expectedUpdatedAt],
      },
      {
        sql: `UPDATE career_tasks
          SET status='done',canceled_at=NULL,cancellation_reason=NULL,
            lifecycle_previous_status=NULL,lifecycle_operation_id=NULL,updated_at=?
          WHERE id=? AND status='todo' AND updated_at=?`,
        params: [updatedAt, taskId, normalized.expectedUpdatedAt],
      },
      dropGuard(operationId),
    ],
    (row, updatedAt, operationId) =>
      mutationResult(taskId, "done", row.due_at, updatedAt, operationId),
  );
}

function restoreStatements(
  taskId: string,
  expectedStatus: "canceled" | "done",
  expectedUpdatedAt: string,
  dueAt: string | null,
  updatedAt: string,
  operationId: string,
): SqlStatement[] {
  const action = expectedStatus === "done"
    ? "reopen_completed_task"
    : "restore_task";
  return [
    ...versionGuard(operationId, taskId, expectedStatus, expectedUpdatedAt, true),
    {
      sql: `INSERT INTO career_lifecycle_events(
          id,job_id,entity_type,entity_id,action,previous_status,next_status,
          previous_due_at,next_due_at,reason,created_at
        ) SELECT ?,job_id,'task',id,
          CASE WHEN ?='canceled' AND lifecycle_operation_id IS NOT NULL
            THEN 'restore_paused_task' ELSE ? END,
          status,'todo',due_at,?,
          CASE WHEN ?='canceled' THEN COALESCE(cancellation_reason,'') ELSE 'user' END,?
          FROM career_tasks
          WHERE id=? AND status=? AND updated_at=?
            AND (job_id IS NULL OR EXISTS (
              SELECT 1 FROM career_jobs AS job
              JOIN career_stages AS stage ON stage.id=job.stage_id
              WHERE job.id=career_tasks.job_id
                AND job.archived=0 AND stage.is_terminal=0
            ))`,
      params: [
        operationId,
        expectedStatus,
        action,
        dueAt,
        expectedStatus,
        updatedAt,
        taskId,
        expectedStatus,
        expectedUpdatedAt,
      ],
    },
    {
      sql: `UPDATE career_tasks
        SET status='todo',due_at=?,canceled_at=NULL,cancellation_reason=NULL,
          lifecycle_previous_status=NULL,lifecycle_operation_id=NULL,updated_at=?
        WHERE id=? AND status=? AND updated_at=?
          AND (job_id IS NULL OR EXISTS (
            SELECT 1 FROM career_jobs AS job
            JOIN career_stages AS stage ON stage.id=job.stage_id
            WHERE job.id=career_tasks.job_id
              AND job.archived=0 AND stage.is_terminal=0
          ))`,
      params: [dueAt, updatedAt, taskId, expectedStatus, expectedUpdatedAt],
    },
    dropGuard(operationId),
  ];
}

export async function restoreCareerTask(
  taskIdInput: string,
  options: RestoreCareerTaskOptions,
): Promise<CareerTaskMutationResult> {
  const taskId = requiredText(taskIdInput, "待办 ID", 240);
  const normalized = normalizedMutationOptions(options);
  const effectiveNow = strictlyLaterTimestamp(
    normalized.requestedNow,
    normalized.expectedUpdatedAt,
  );
  const dueAt = explicitFutureDueAt(options, effectiveNow);
  return executeVersionedTaskMutation(
    taskId,
    normalized,
    "canceled",
    true,
    (_row, updatedAt, operationId) => restoreStatements(
      taskId,
      "canceled",
      normalized.expectedUpdatedAt,
      dueAt,
      updatedAt,
      operationId,
    ),
    (_row, updatedAt, operationId) =>
      mutationResult(taskId, "todo", dueAt, updatedAt, operationId),
  );
}

export async function reopenCompletedCareerTask(
  taskIdInput: string,
  options: ReopenCompletedCareerTaskOptions,
): Promise<CareerTaskMutationResult> {
  const taskId = requiredText(taskIdInput, "待办 ID", 240);
  const normalized = normalizedMutationOptions(options);
  const effectiveNow = strictlyLaterTimestamp(
    normalized.requestedNow,
    normalized.expectedUpdatedAt,
  );
  const dueAt = explicitFutureDueAt(options, effectiveNow);
  return executeVersionedTaskMutation(
    taskId,
    normalized,
    "done",
    true,
    (_row, updatedAt, operationId) => restoreStatements(
      taskId,
      "done",
      normalized.expectedUpdatedAt,
      dueAt,
      updatedAt,
      operationId,
    ),
    (_row, updatedAt, operationId) =>
      mutationResult(taskId, "todo", dueAt, updatedAt, operationId),
  );
}

/** A single import surface for every task action used by the Career UI. */
export const careerTaskActions = Object.freeze({
  load: loadCareerTaskDetail,
  create: createCareerTask,
  complete: completeCareerTask,
  reopenCompleted: reopenCompletedCareerTask,
  reschedule: rescheduleCareerTask,
  cancel: cancelCareerTask,
  restore: restoreCareerTask,
});
