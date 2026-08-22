import type { SqlStatement } from "@/lib/local-db/types";
import type { Job, Stage, Task } from "./types";
import {
  CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
  CAREER_WRITE_RECEIPT_VERSION,
  CareerWriteError,
  abortUnless,
  canonicalTimestamp,
  careerWriteError,
  careerWriteReceiptHashIsValid,
  defaultCareerWriteStorageRuntime,
  exactCareerWriteMarker,
  exactKeys,
  generatedCareerTaskId,
  generatedCareerWriteOperationId,
  idAbsentPredicate,
  isCanonicalIsoTimestamp,
  isCareerWriteGeneration,
  isCareerWriteOperationId,
  isGeneratedCareerTaskId,
  isNullableString,
  isSafeInteger,
  joinedPredicate,
  jsonClone,
  markerAbsentPredicate,
  markerStatement,
  optionalId,
  readCareerWriteMarker,
  readCurrentCareerWriteGeneration,
  requireCurrentCareerWriteGeneration,
  requiredText,
  safeCareerWriteBroadcast,
  sameCareerWriteGeneration,
  sealCareerWriteReceipt,
  strictlyLaterTimestamp,
  withCareerWritePrepareLock,
  type CareerWriteCommitResult,
  type CareerWriteGenerationExpectation,
  type CareerWriteInspection,
  type CareerWriteReceiptBase,
  type CareerWriteStorageRuntime,
  type SqlPredicate,
} from "./write-marker";

const PURPOSE = "career-task-write" as const;
const STAGE_KEYS = [
  "id", "name", "color", "position", "is_terminal", "hidden",
] as const;
const JOB_KEYS = [
  "id", "company", "role", "location", "source", "source_url",
  "stage_id", "priority", "salary", "work_mode", "description",
  "applied_at", "deadline", "contact_name", "note", "tags",
  "created_at", "updated_at", "archived", "position", "archived_at",
  "ended_at", "archived_operation_id", "ended_operation_id",
] as const;
const TASK_KEYS = [
  "id", "job_id", "contact_id", "title", "due_at", "kind", "priority",
  "status", "created_at", "updated_at", "canceled_at",
  "cancellation_reason", "lifecycle_previous_status",
  "lifecycle_operation_id",
] as const;

export type CreateCareerTaskWriteInput = Readonly<{
  title: string;
  jobId?: string | null;
  dueAt?: string | null;
  kind?: string;
  priority?: number;
}>;

export type CareerTaskCreateExpectedContext =
  CareerWriteGenerationExpectation & Readonly<{
    job: Readonly<Job> | null;
    stage: Readonly<Stage> | null;
  }>;

export type CareerTaskWriteExpectedState =
  CareerWriteGenerationExpectation & Readonly<{
    task: Readonly<Task>;
  }>;

type TaskCreateBefore = CareerTaskCreateExpectedContext & Readonly<{
  taskId: string;
  eventId: string;
}>;

type TaskCreateAfter = CareerWriteGenerationExpectation & Readonly<{
  task: Readonly<Task>;
  event: Readonly<CareerTaskWriteEvent>;
}>;

type TaskCompleteAfter = CareerWriteGenerationExpectation & Readonly<{
  task: Readonly<Task>;
  event: Readonly<CareerTaskWriteEvent>;
}>;

export type CareerTaskCreateReceipt = CareerWriteReceiptBase<
  typeof PURPOSE,
  "task-create",
  TaskCreateBefore,
  TaskCreateAfter
>;

export type CareerTaskCompleteReceipt = CareerWriteReceiptBase<
  typeof PURPOSE,
  "task-complete",
  CareerTaskWriteExpectedState,
  TaskCompleteAfter
>;

export type CareerTaskWriteReceipt =
  | CareerTaskCreateReceipt
  | CareerTaskCompleteReceipt;

export type CareerTaskWriteResult =
  CareerWriteCommitResult<CareerTaskWriteReceipt>;

type CareerTaskWriteEvent = Readonly<{
  id: string;
  job_id: string | null;
  entity_type: "task";
  entity_id: string;
  action: "create_task" | "complete_task";
  previous_status: "todo" | null;
  next_status: "todo" | "done";
  previous_due_at: string | null;
  next_due_at: string | null;
  reason: "user";
  created_at: string;
}>;

type NormalizedTaskCreate = Readonly<{
  title: string;
  jobId: string | null;
  dueAt: string | null;
  kind: string;
  priority: number;
}>;

function normalizeCreateInput(value: CreateCareerTaskWriteInput): NormalizedTaskCreate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw careerWriteError("invalid_input", "待办内容无效。");
  }
  const allowedKeys = new Set(["title", "jobId", "dueAt", "kind", "priority"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw careerWriteError("invalid_input", "待办创建包含不受支持的字段。");
  }
  const priority = value.priority === undefined ? 1 : value.priority;
  if (!isSafeInteger(priority) || priority < 1 || priority > 3) {
    throw careerWriteError("invalid_input", "优先级需要是 1 到 3 的整数。");
  }
  const dueAt = value.dueAt === undefined || value.dueAt === null ||
      value.dueAt === ""
    ? null
    : canonicalTimestamp(value.dueAt, "待办时间");
  return {
    title: requiredText(value.title, "待办内容", 500),
    jobId: optionalId(value.jobId, "职位 ID"),
    dueAt,
    kind: value.kind === undefined
      ? "跟进"
      : requiredText(value.kind, "待办类型", 80),
    priority,
  };
}

function isStage(value: unknown): value is Readonly<Stage> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<Stage>;
  return exactKeys(value, STAGE_KEYS) &&
    typeof row.id === "string" && row.id.length > 0 && row.id.length <= 240 &&
    typeof row.name === "string" && typeof row.color === "string" &&
    isSafeInteger(row.position) &&
    (row.is_terminal === 0 || row.is_terminal === 1) &&
    (row.hidden === 0 || row.hidden === 1);
}

function isJob(value: unknown): value is Readonly<Job> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<Job>;
  return exactKeys(value, JOB_KEYS) &&
    typeof row.id === "string" && row.id.length > 0 && row.id.length <= 240 &&
    typeof row.company === "string" && typeof row.role === "string" &&
    typeof row.location === "string" && typeof row.source === "string" &&
    typeof row.source_url === "string" && typeof row.stage_id === "string" &&
    isSafeInteger(row.priority) && typeof row.salary === "string" &&
    typeof row.work_mode === "string" && typeof row.description === "string" &&
    isNullableString(row.applied_at) && isNullableString(row.deadline) &&
    typeof row.contact_name === "string" && typeof row.note === "string" &&
    typeof row.tags === "string" && typeof row.created_at === "string" &&
    typeof row.updated_at === "string" &&
    (row.archived === 0 || row.archived === 1) && isSafeInteger(row.position) &&
    isNullableString(row.archived_at) && isNullableString(row.ended_at) &&
    isNullableString(row.archived_operation_id) &&
    isNullableString(row.ended_operation_id);
}

function isTask(value: unknown): value is Readonly<Task> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<Task>;
  return exactKeys(value, TASK_KEYS) &&
    typeof row.id === "string" && row.id.length > 0 && row.id.length <= 240 &&
    isNullableString(row.job_id) && isNullableString(row.contact_id) &&
    typeof row.title === "string" && isNullableString(row.due_at) &&
    typeof row.kind === "string" && isSafeInteger(row.priority) &&
    (row.status === "todo" || row.status === "done" || row.status === "canceled") &&
    typeof row.created_at === "string" && typeof row.updated_at === "string" &&
    isNullableString(row.canceled_at) && isNullableString(row.cancellation_reason) &&
    (row.lifecycle_previous_status === null ||
      row.lifecycle_previous_status === "todo") &&
    isNullableString(row.lifecycle_operation_id);
}

function isEvent(value: unknown): value is CareerTaskWriteEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<CareerTaskWriteEvent>;
  return exactKeys(value, [
    "id", "job_id", "entity_type", "entity_id", "action",
    "previous_status", "next_status", "previous_due_at", "next_due_at",
    "reason", "created_at",
  ]) && typeof row.id === "string" && isNullableString(row.job_id) &&
    row.entity_type === "task" && typeof row.entity_id === "string" &&
    (row.action === "create_task" || row.action === "complete_task") &&
    (row.previous_status === null || row.previous_status === "todo") &&
    (row.next_status === "todo" || row.next_status === "done") &&
    isNullableString(row.previous_due_at) && isNullableString(row.next_due_at) &&
    row.reason === "user" && typeof row.created_at === "string";
}

function generationFrom(value: {
  generationId?: unknown;
  generationSequence?: unknown;
}): CareerWriteGenerationExpectation | null {
  const generation = {
    generationId: value.generationId,
    generationSequence: value.generationSequence,
  };
  return isCareerWriteGeneration(generation) ? generation : null;
}

function isCreateContext(value: unknown): value is CareerTaskCreateExpectedContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Partial<CareerTaskCreateExpectedContext>;
  if (!exactKeys(value, ["generationId", "generationSequence", "job", "stage"]) ||
    generationFrom(context) === null) return false;
  if (context.job === null || context.stage === null) {
    return context.job === null && context.stage === null;
  }
  return isJob(context.job) && isStage(context.stage) &&
    context.job.stage_id === context.stage.id;
}

function isExpectedTask(value: unknown): value is CareerTaskWriteExpectedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expected = value as Partial<CareerTaskWriteExpectedState>;
  return exactKeys(value, ["generationId", "generationSequence", "task"]) &&
    generationFrom(expected) !== null && isTask(expected.task);
}

function sameRow<Row extends object>(
  left: Row,
  right: Row,
  keys: readonly (keyof Row & string)[],
): boolean {
  return keys.every((key) => left[key] === right[key]);
}

function activeContext(context: CareerTaskCreateExpectedContext): boolean {
  return context.job === null || (
    context.stage !== null && context.job.archived === 0 &&
    context.stage.is_terminal === 0 && context.stage.hidden === 0
  );
}

async function readStage(
  runtime: CareerWriteStorageRuntime,
  id: string,
): Promise<Readonly<Stage> | null> {
  const rows = (await runtime.query<Stage>(
    `SELECT id,name,color,position,is_terminal,hidden
      FROM career_stages WHERE id=? ORDER BY id LIMIT 2`,
    [id],
  )).rows;
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !isStage(rows[0])) throw new Error("阶段行不符合 canonical 格式。");
  return { ...rows[0] };
}

async function readJob(
  runtime: CareerWriteStorageRuntime,
  id: string,
): Promise<Readonly<Job> | null> {
  const rows = (await runtime.query<Job>(
    `SELECT id,company,role,location,source,source_url,stage_id,priority,
      salary,work_mode,description,applied_at,deadline,contact_name,note,tags,
      created_at,updated_at,archived,position,archived_at,ended_at,
      archived_operation_id,ended_operation_id
      FROM career_jobs WHERE id=? ORDER BY id LIMIT 2`,
    [id],
  )).rows;
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !isJob(rows[0])) throw new Error("职位行不符合 canonical 格式。");
  return { ...rows[0] };
}

async function readTask(
  runtime: CareerWriteStorageRuntime,
  id: string,
): Promise<Readonly<Task> | null> {
  const rows = (await runtime.query<Task>(
    `SELECT id,job_id,contact_id,title,due_at,kind,priority,status,created_at,
      updated_at,canceled_at,cancellation_reason,lifecycle_previous_status,
      lifecycle_operation_id
      FROM career_tasks WHERE id=? ORDER BY id LIMIT 2`,
    [id],
  )).rows;
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !isTask(rows[0])) throw new Error("待办行不符合 canonical 格式。");
  return { ...rows[0] };
}

async function contextState(
  runtime: CareerWriteStorageRuntime,
  expected: CareerTaskCreateExpectedContext,
): Promise<"expected" | "changed"> {
  if (expected.job === null) return expected.stage === null ? "expected" : "changed";
  if (expected.stage === null) return "changed";
  const [job, stage] = await Promise.all([
    readJob(runtime, expected.job.id),
    readStage(runtime, expected.stage.id),
  ]);
  return job && stage && activeContext(expected) &&
      sameRow(job, expected.job, JOB_KEYS) &&
      sameRow(stage, expected.stage, STAGE_KEYS)
    ? "expected"
    : "changed";
}

function rowPredicate<Row extends object>(
  table: "career_stages" | "career_jobs" | "career_tasks",
  keys: readonly (keyof Row & string)[],
  row: Row,
): SqlPredicate {
  return {
    sql: `EXISTS(SELECT 1 FROM ${table} WHERE ${keys.map((key) =>
      `${key} IS ?`).join(" AND ")})`,
    params: keys.map((key) => row[key]),
  };
}

function createEventId(operationId: string): string {
  return `${operationId}-event`;
}

export function isCareerTaskWriteReceipt(
  value: unknown,
): value is CareerTaskWriteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<CareerTaskWriteReceipt>;
  if (!exactKeys(value, [
    "purpose", "version", "kind", "operationId", "generationId",
    "generationSequence", "operationAt", "before", "after",
    "projectionSha256",
  ]) || receipt.purpose !== PURPOSE ||
    receipt.version !== CAREER_WRITE_RECEIPT_VERSION ||
    !isCareerWriteOperationId(receipt.operationId, PURPOSE) ||
    !isCanonicalIsoTimestamp(receipt.operationAt) ||
    typeof receipt.projectionSha256 !== "string" ||
    generationFrom(receipt) === null) return false;

  if (receipt.kind === "task-create") {
    const before = receipt.before as Partial<TaskCreateBefore>;
    const after = receipt.after as Partial<TaskCreateAfter>;
    const context = {
      generationId: before?.generationId,
      generationSequence: before?.generationSequence,
      job: before?.job,
      stage: before?.stage,
    };
    if (!before || typeof before !== "object" || !after || typeof after !== "object" ||
      !exactKeys(before, [
        "generationId", "generationSequence", "job", "stage", "taskId", "eventId",
      ]) || !exactKeys(after, [
        "generationId", "generationSequence", "task", "event",
      ]) || !isCreateContext(context) || !activeContext(context) ||
      !isGeneratedCareerTaskId(before.taskId) ||
      before.eventId !== createEventId(receipt.operationId) ||
      generationFrom(after) === null || !isTask(after.task) || !isEvent(after.event) ||
      after.task.id !== before.taskId || after.event.id !== before.eventId ||
      after.task.job_id !== (context.job?.id ?? null) ||
      after.task.contact_id !== null || after.task.title.trim() !== after.task.title ||
      after.task.title.length === 0 || after.task.title.length > 500 ||
      after.task.kind.trim() !== after.task.kind || after.task.kind.length === 0 ||
      after.task.kind.length > 80 || after.task.priority < 1 ||
      after.task.priority > 3 || after.task.status !== "todo" ||
      !(after.task.due_at === null || isCanonicalIsoTimestamp(after.task.due_at)) ||
      after.task.created_at !== receipt.operationAt ||
      after.task.updated_at !== receipt.operationAt ||
      after.task.canceled_at !== null || after.task.cancellation_reason !== null ||
      after.task.lifecycle_previous_status !== null ||
      after.task.lifecycle_operation_id !== null ||
      after.event.job_id !== after.task.job_id ||
      after.event.entity_id !== after.task.id ||
      after.event.action !== "create_task" || after.event.previous_status !== null ||
      after.event.next_status !== "todo" || after.event.previous_due_at !== null ||
      after.event.next_due_at !== after.task.due_at ||
      after.event.reason !== "user" ||
      after.event.created_at !== receipt.operationAt) return false;
  } else if (receipt.kind === "task-complete") {
    const before = receipt.before as Partial<CareerTaskWriteExpectedState>;
    const after = receipt.after as Partial<TaskCompleteAfter>;
    if (!isExpectedTask(before) || !after || typeof after !== "object" ||
      !exactKeys(after, ["generationId", "generationSequence", "task", "event"]) ||
      generationFrom(after) === null || !isTask(after.task) || !isEvent(after.event) ||
      before.task.status !== "todo" || after.task.status !== "done" ||
      after.task.id !== before.task.id || after.event.id !== receipt.operationId ||
      !sameRow(after.task, {
        ...before.task,
        status: "done",
        updated_at: receipt.operationAt,
        canceled_at: null,
        cancellation_reason: null,
        lifecycle_previous_status: null,
        lifecycle_operation_id: null,
      }, TASK_KEYS) ||
      !isCanonicalIsoTimestamp(before.task.updated_at) ||
      Date.parse(receipt.operationAt) <= Date.parse(before.task.updated_at!) ||
      after.event.job_id !== before.task.job_id ||
      after.event.entity_id !== after.task.id ||
      after.event.action !== "complete_task" ||
      after.event.previous_status !== "todo" || after.event.next_status !== "done" ||
      after.event.previous_due_at !== before.task.due_at ||
      after.event.next_due_at !== before.task.due_at ||
      after.event.reason !== "user" ||
      after.event.created_at !== receipt.operationAt) {
      return false;
    }
  } else return false;

  const generation = generationFrom(receipt)!;
  const beforeGeneration = generationFrom(receipt.before as never);
  const afterGeneration = generationFrom(receipt.after as never);
  return beforeGeneration !== null && afterGeneration !== null &&
    sameCareerWriteGeneration(generation, beforeGeneration) &&
    sameCareerWriteGeneration(generation, afterGeneration);
}

function receiptEntityId(receipt: CareerTaskWriteReceipt): string {
  return receipt.kind === "task-create"
    ? receipt.after.task.id
    : receipt.before.task.id;
}

function broadcastReason(kind: CareerTaskWriteReceipt["kind"]): string {
  return kind === "task-create" ? "career-task-created" : "career-task-completed";
}

function receiptStatements(receipt: CareerTaskWriteReceipt): SqlStatement[] {
  const predicates: SqlPredicate[] = [markerAbsentPredicate(receipt.operationId)];
  const mutations: SqlStatement[] = [];
  if (receipt.kind === "task-create") {
    predicates.push(
      idAbsentPredicate("career_tasks", receipt.before.taskId),
      idAbsentPredicate("career_lifecycle_events", receipt.before.eventId),
    );
    if (receipt.before.job && receipt.before.stage) {
      predicates.push(
        rowPredicate("career_jobs", JOB_KEYS, receipt.before.job),
        rowPredicate("career_stages", STAGE_KEYS, receipt.before.stage),
        {
          sql: `EXISTS(SELECT 1 FROM career_jobs AS job
            JOIN career_stages AS stage ON stage.id=job.stage_id
            WHERE job.id=? AND stage.id=? AND job.archived=0
              AND stage.is_terminal=0 AND stage.hidden=0)`,
          params: [receipt.before.job.id, receipt.before.stage.id],
        },
      );
    }
    mutations.push(
      {
        sql: `INSERT INTO career_tasks(
          id,job_id,contact_id,title,due_at,kind,priority,status,created_at,
          updated_at,canceled_at,cancellation_reason,lifecycle_previous_status,
          lifecycle_operation_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: TASK_KEYS.map((key) => receipt.after.task[key]),
      },
      {
        sql: `INSERT INTO career_lifecycle_events(
          id,job_id,entity_type,entity_id,action,previous_status,next_status,
          previous_due_at,next_due_at,reason,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          receipt.after.event.id,
          receipt.after.event.job_id,
          receipt.after.event.entity_type,
          receipt.after.event.entity_id,
          receipt.after.event.action,
          receipt.after.event.previous_status,
          receipt.after.event.next_status,
          receipt.after.event.previous_due_at,
          receipt.after.event.next_due_at,
          receipt.after.event.reason,
          receipt.after.event.created_at,
        ],
      },
    );
  } else {
    predicates.push(
      rowPredicate("career_tasks", TASK_KEYS, receipt.before.task),
      idAbsentPredicate("career_lifecycle_events", receipt.after.event.id),
    );
    mutations.push(
      {
        sql: `INSERT INTO career_lifecycle_events(
          id,job_id,entity_type,entity_id,action,previous_status,next_status,
          previous_due_at,next_due_at,reason,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          receipt.after.event.id,
          receipt.after.event.job_id,
          receipt.after.event.entity_type,
          receipt.after.event.entity_id,
          receipt.after.event.action,
          receipt.after.event.previous_status,
          receipt.after.event.next_status,
          receipt.after.event.previous_due_at,
          receipt.after.event.next_due_at,
          receipt.after.event.reason,
          receipt.after.event.created_at,
        ],
      },
      {
        sql: `UPDATE career_tasks SET status=?,updated_at=?,canceled_at=?,
          cancellation_reason=?,lifecycle_previous_status=?,
          lifecycle_operation_id=? WHERE id=?`,
        params: [
          receipt.after.task.status,
          receipt.after.task.updated_at,
          receipt.after.task.canceled_at,
          receipt.after.task.cancellation_reason,
          receipt.after.task.lifecycle_previous_status,
          receipt.after.task.lifecycle_operation_id,
          receipt.after.task.id,
        ],
      },
    );
  }
  return [
    abortUnless(joinedPredicate(predicates)),
    ...mutations,
    markerStatement(receipt, receiptEntityId(receipt)),
  ];
}

export function createCareerTaskWriteStorageService(
  runtime: CareerWriteStorageRuntime = defaultCareerWriteStorageRuntime,
) {
  async function loadExpected(
    taskIdValue: string,
    generationValue: CareerWriteGenerationExpectation,
  ): Promise<CareerTaskWriteExpectedState> {
    const taskId = requiredText(taskIdValue, "待办 ID", 240);
    const generation = jsonClone<CareerWriteGenerationExpectation>(
      generationValue,
      1024,
      "待办世代快照",
    );
    if (!isCareerWriteGeneration(generation)) {
      throw careerWriteError("invalid_input", "待办世代快照无效。");
    }
    return withCareerWritePrepareLock(runtime, async () => {
      const current = await readCurrentCareerWriteGeneration(runtime);
      requireCurrentCareerWriteGeneration(current, generation);
      const task = await readTask(runtime, taskId);
      if (!task) throw careerWriteError("changed", "待办已变化或不存在；没有准备写入。");
      return { ...current, task };
    });
  }

  async function prepareCreate(
    inputValue: CreateCareerTaskWriteInput,
    expectedValue: CareerTaskCreateExpectedContext,
  ): Promise<CareerTaskCreateReceipt> {
    const input = normalizeCreateInput(inputValue);
    const expected = jsonClone<CareerTaskCreateExpectedContext>(
      expectedValue,
      CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
      "待办创建上下文",
    );
    if (!isCreateContext(expected) || !activeContext(expected) ||
      (expected.job?.id ?? null) !== input.jobId) {
      throw careerWriteError("invalid_input", "待办关联上下文无效或已不可用。");
    }
    return withCareerWritePrepareLock(runtime, async () => {
      const generation = await readCurrentCareerWriteGeneration(runtime);
      requireCurrentCareerWriteGeneration(generation, expected);
      if (await contextState(runtime, expected) !== "expected") {
        throw careerWriteError("changed", "关联职位已经变化；没有准备待办。");
      }
      const operationId = generatedCareerWriteOperationId(runtime, PURPOSE);
      const taskId = generatedCareerTaskId(runtime);
      const eventId = createEventId(operationId);
      const [marker, taskAbsent, eventAbsent] = await Promise.all([
        readCareerWriteMarker(runtime, operationId),
        runtime.query<{ id: string }>(
          "SELECT id FROM career_tasks WHERE id=? ORDER BY id LIMIT 2",
          [taskId],
        ).then(({ rows }) => rows.length === 0),
        runtime.query<{ id: string }>(
          "SELECT id FROM career_lifecycle_events WHERE id=? ORDER BY id LIMIT 2",
          [eventId],
        ).then(({ rows }) => rows.length === 0),
      ]);
      if (marker || !taskAbsent || !eventAbsent) {
        throw careerWriteError("changed", "新的待办操作标识已被占用；没有准备写入。");
      }
      const operationAt = new Date(runtime.now()).toISOString();
      const task: Task = {
        id: taskId,
        job_id: input.jobId,
        contact_id: null,
        title: input.title,
        due_at: input.dueAt,
        kind: input.kind,
        priority: input.priority,
        status: "todo",
        created_at: operationAt,
        updated_at: operationAt,
        canceled_at: null,
        cancellation_reason: null,
        lifecycle_previous_status: null,
        lifecycle_operation_id: null,
      };
      const event: CareerTaskWriteEvent = {
        id: eventId,
        job_id: task.job_id,
        entity_type: "task",
        entity_id: task.id,
        action: "create_task",
        previous_status: null,
        next_status: "todo",
        previous_due_at: null,
        next_due_at: task.due_at,
        reason: "user",
        created_at: operationAt,
      };
      return sealCareerWriteReceipt<CareerTaskCreateReceipt>({
        purpose: PURPOSE,
        version: CAREER_WRITE_RECEIPT_VERSION,
        kind: "task-create",
        operationId,
        ...generation,
        operationAt,
        before: {
          ...generation,
          job: expected.job,
          stage: expected.stage,
          taskId,
          eventId,
        },
        after: { ...generation, task, event },
      });
    });
  }

  async function prepareComplete(
    expectedValue: CareerTaskWriteExpectedState,
  ): Promise<CareerTaskCompleteReceipt> {
    const expected = jsonClone<CareerTaskWriteExpectedState>(
      expectedValue,
      CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
      "待办读取快照",
    );
    if (!isExpectedTask(expected) || expected.task.status !== "todo") {
      throw careerWriteError("invalid_input", "只能完成当前仍待处理的待办。");
    }
    return withCareerWritePrepareLock(runtime, async () => {
      const generation = await readCurrentCareerWriteGeneration(runtime);
      requireCurrentCareerWriteGeneration(generation, expected);
      const task = await readTask(runtime, expected.task.id);
      if (!task || !sameRow(task, expected.task, TASK_KEYS) || task.status !== "todo") {
        throw careerWriteError("changed", "待办已在别处变化；没有准备写入。");
      }
      const operationId = generatedCareerWriteOperationId(runtime, PURPOSE);
      const [marker, eventRows] = await Promise.all([
        readCareerWriteMarker(runtime, operationId),
        runtime.query<{ id: string }>(
          "SELECT id FROM career_lifecycle_events WHERE id=? ORDER BY id LIMIT 2",
          [operationId],
        ),
      ]);
      if (marker || eventRows.rows.length !== 0) {
        throw careerWriteError("changed", "新的待办操作标识已被占用；没有准备写入。");
      }
      const operationAt = strictlyLaterTimestamp(runtime.now(), [task.updated_at]);
      const afterTask: Task = {
        ...task,
        status: "done",
        updated_at: operationAt,
        canceled_at: null,
        cancellation_reason: null,
        lifecycle_previous_status: null,
        lifecycle_operation_id: null,
      };
      const event: CareerTaskWriteEvent = {
        id: operationId,
        job_id: task.job_id,
        entity_type: "task",
        entity_id: task.id,
        action: "complete_task",
        previous_status: "todo",
        next_status: "done",
        previous_due_at: task.due_at,
        next_due_at: task.due_at,
        reason: "user",
        created_at: operationAt,
      };
      return sealCareerWriteReceipt<CareerTaskCompleteReceipt>({
        purpose: PURPOSE,
        version: CAREER_WRITE_RECEIPT_VERSION,
        kind: "task-complete",
        operationId,
        ...generation,
        operationAt,
        before: { ...generation, task },
        after: { ...generation, task: afterTask, event },
      });
    });
  }

  async function receiptStateUnlocked(
    receipt: CareerTaskWriteReceipt,
  ): Promise<Exclude<CareerWriteInspection, "still_unknown" | "invalid_receipt">> {
    const generation = await readCurrentCareerWriteGeneration(runtime);
    if (!sameCareerWriteGeneration(generation, receipt)) return "changed";
    const marker = await readCareerWriteMarker(runtime, receipt.operationId);
    if (marker) {
      return exactCareerWriteMarker(marker, receipt, receiptEntityId(receipt))
        ? "exact_saved"
        : "changed";
    }
    if (receipt.kind === "task-create") {
      const [context, taskRows, eventRows] = await Promise.all([
        contextState(runtime, receipt.before),
        runtime.query<{ id: string }>(
          "SELECT id FROM career_tasks WHERE id=? ORDER BY id LIMIT 2",
          [receipt.before.taskId],
        ),
        runtime.query<{ id: string }>(
          "SELECT id FROM career_lifecycle_events WHERE id=? ORDER BY id LIMIT 2",
          [receipt.before.eventId],
        ),
      ]);
      return context === "expected" && taskRows.rows.length === 0 &&
          eventRows.rows.length === 0
        ? "expected"
        : "changed";
    }
    const [task, eventRows] = await Promise.all([
      readTask(runtime, receipt.before.task.id),
      runtime.query<{ id: string }>(
        "SELECT id FROM career_lifecycle_events WHERE id=? ORDER BY id LIMIT 2",
        [receipt.after.event.id],
      ),
    ]);
    return task && sameRow(task, receipt.before.task, TASK_KEYS) &&
        eventRows.rows.length === 0
      ? "expected"
      : "changed";
  }

  async function inspect(value: unknown): Promise<CareerWriteInspection> {
    let receipt: CareerTaskWriteReceipt;
    try {
      receipt = jsonClone<CareerTaskWriteReceipt>(
        value,
        CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
      );
      if (!isCareerTaskWriteReceipt(receipt) ||
        !await careerWriteReceiptHashIsValid(receipt)) {
        return "invalid_receipt";
      }
    } catch (error) {
      if (error instanceof CareerWriteError && error.code === "invalid_input") {
        return "invalid_receipt";
      }
      return "still_unknown";
    }
    try {
      return await runtime.withExclusiveLock(() => receiptStateUnlocked(receipt));
    } catch {
      return "still_unknown";
    }
  }

  async function commit(value: unknown): Promise<CareerTaskWriteResult> {
    let receipt: CareerTaskWriteReceipt;
    try {
      receipt = jsonClone<CareerTaskWriteReceipt>(
        value,
        CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
      );
      if (!isCareerTaskWriteReceipt(receipt) ||
        !await careerWriteReceiptHashIsValid(receipt)) {
        throw careerWriteError("invalid_receipt", "待办写入回执无效；没有改动资料。");
      }
    } catch (error) {
      if (error instanceof CareerWriteError && error.code === "invalid_receipt") throw error;
      throw careerWriteError("invalid_receipt", "待办写入回执无法验证；没有改动资料。");
    }

    const entityId = receiptEntityId(receipt);
    let entered = false;
    try {
      return await runtime.withExclusiveLock(async () => {
        entered = true;
        const before = await receiptStateUnlocked(receipt);
        if (before === "exact_saved") {
          safeCareerWriteBroadcast(runtime, broadcastReason(receipt.kind));
          return { outcome: "already_saved", receipt, entityId };
        }
        if (before === "changed") {
          return { outcome: "changed", receipt, entityId, retryable: false };
        }
        try {
          await runtime.batch(receiptStatements(receipt));
        } catch {
          // The transaction may have committed before its response was lost.
        }
        const after = await receiptStateUnlocked(receipt);
        if (after === "exact_saved") {
          safeCareerWriteBroadcast(runtime, broadcastReason(receipt.kind));
          return { outcome: "saved", receipt, entityId };
        }
        if (after === "expected") {
          throw careerWriteError(
            "write_failed",
            "这次待办写入确定没有提交；保留原回执后可以重试。",
            receipt,
          );
        }
        return { outcome: "changed", receipt, entityId, retryable: false };
      });
    } catch (error) {
      if (error instanceof CareerWriteError) throw error;
      if (!entered) {
        throw careerWriteError("lock_unavailable", "无法取得安全的职迹写入锁；没有开始写入。");
      }
      return {
        outcome: "outcome_uncertain",
        receipt,
        entityId,
        retryable: true,
      };
    }
  }

  return {
    loadCareerTaskWriteExpected: loadExpected,
    prepareCareerTaskCreate: prepareCreate,
    prepareCareerTaskComplete: prepareComplete,
    inspectCareerTaskWrite: inspect,
    commitCareerTaskWrite: commit,
  } as const;
}

const defaultService = createCareerTaskWriteStorageService();

export const loadCareerTaskWriteExpected =
  defaultService.loadCareerTaskWriteExpected;
export const prepareCareerTaskCreate = defaultService.prepareCareerTaskCreate;
export const prepareCareerTaskComplete = defaultService.prepareCareerTaskComplete;
export const inspectCareerTaskWrite = defaultService.inspectCareerTaskWrite;
export const commitCareerTaskWrite = defaultService.commitCareerTaskWrite;
