import type { SqlStatement } from "@/lib/local-db/types";
import type { Interview, Job, Stage, Task } from "./types";
import {
  CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
  CAREER_WRITE_RECEIPT_VERSION,
  CareerWriteError,
  abortUnless,
  careerWriteError,
  careerWriteReceiptHashIsValid,
  defaultCareerWriteStorageRuntime,
  exactCareerWriteMarker,
  exactKeys,
  generatedCareerWriteOperationId,
  hashCareerWriteValue,
  isCanonicalIsoTimestamp,
  isCareerWriteGeneration,
  isCareerWriteOperationId,
  isNullableString,
  isSafeInteger,
  joinedPredicate,
  jsonClone,
  markerAbsentPredicate,
  markerStatement,
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

const PURPOSE = "career-lifecycle-write" as const;
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
const INTERVIEW_KEYS = [
  "id", "job_id", "round_name", "interview_type", "scheduled_at",
  "duration", "interviewer", "meeting_url", "status", "summary",
  "raw_notes", "questions_json", "reflection", "created_at", "updated_at",
  "canceled_at", "cancellation_reason", "lifecycle_previous_status",
  "lifecycle_operation_id",
] as const;
const EVENT_KEYS = [
  "id", "job_id", "entity_type", "entity_id", "action",
  "previous_status", "next_status", "previous_due_at", "next_due_at",
  "reason", "created_at",
] as const;

export type CareerLifecycleWriteChoice =
  | "keep"
  | "pause"
  | "keep-paused"
  | "restore-paused";

export type CareerLifecycleWriteIntent =
  | Readonly<{ kind: "stage"; jobId: string; nextStageId: string }>
  | Readonly<{ kind: "archive"; jobId: string }>
  | Readonly<{ kind: "restore"; jobId: string }>;

type PreparedIntent =
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

export type CareerLifecycleWriteTransition =
  | "active-to-active"
  | "active-to-terminal"
  | "terminal-to-active"
  | "terminal-to-terminal"
  | "archive"
  | "restore-active"
  | "restore-terminal";

export type CareerLifecycleWriteEvent = Readonly<{
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

export type CareerLifecycleDisplayedExpected =
  CareerWriteGenerationExpectation & Readonly<{
    job: Readonly<Job>;
    currentStage: Readonly<Stage>;
    nextStage: Readonly<Stage> | null;
  }>;

type LifecycleFacts = CareerWriteGenerationExpectation & Readonly<{
  intent: PreparedIntent;
  job: Readonly<Job>;
  currentStage: Readonly<Stage>;
  nextStage: Readonly<Stage> | null;
  tasks: readonly Readonly<Task>[];
  interviews: readonly Readonly<Interview>[];
  events: readonly CareerLifecycleWriteEvent[];
}>;

export type CareerLifecycleWriteImpactItem = Readonly<{
  entityType: "task" | "interview";
  id: string;
  label: string;
  scheduledAt: string | null;
  status: string;
  classification: "affected" | "elapsed" | "edited";
  effect: "pause" | "restore";
}>;

export type CareerLifecycleWritePreview = Readonly<{
  version: 1;
  operationId: string;
  generationId: string;
  generationSequence: number;
  preparedAt: string;
  intent: PreparedIntent;
  transition: CareerLifecycleWriteTransition;
  job: Readonly<{
    id: string;
    company: string;
    role: string;
    archived: boolean;
    currentStage: Readonly<{ id: string; name: string; isTerminal: boolean }>;
    nextStage: Readonly<{ id: string; name: string; isTerminal: boolean }> | null;
  }>;
  impact: readonly CareerLifecycleWriteImpactItem[];
  counts: Readonly<{ affected: number; elapsed: number; edited: number }>;
  requiresChoice: boolean;
  allowedChoices: readonly CareerLifecycleWriteChoice[];
  authorization: LifecycleFacts;
  fingerprint: string;
}>;

type LifecycleReceiptBefore = LifecycleFacts & Readonly<{
  decisionAt: string;
  transition: CareerLifecycleWriteTransition;
  choice: CareerLifecycleWriteChoice;
}>;

type LifecycleReceiptAfter = CareerWriteGenerationExpectation & Readonly<{
  job: Readonly<Job>;
  tasks: readonly Readonly<Task>[];
  interviews: readonly Readonly<Interview>[];
  events: readonly CareerLifecycleWriteEvent[];
}>;

export type CareerLifecycleStageTransitionReceipt = CareerWriteReceiptBase<
  typeof PURPOSE,
  "stage-transition",
  LifecycleReceiptBefore,
  LifecycleReceiptAfter
>;
export type CareerLifecycleJobArchiveReceipt = CareerWriteReceiptBase<
  typeof PURPOSE,
  "job-archive",
  LifecycleReceiptBefore,
  LifecycleReceiptAfter
>;
export type CareerLifecycleJobRestoreReceipt = CareerWriteReceiptBase<
  typeof PURPOSE,
  "job-restore",
  LifecycleReceiptBefore,
  LifecycleReceiptAfter
>;
export type CareerLifecycleWriteReceipt =
  | CareerLifecycleStageTransitionReceipt
  | CareerLifecycleJobArchiveReceipt
  | CareerLifecycleJobRestoreReceipt;
export type CareerLifecycleWriteResult =
  CareerWriteCommitResult<CareerLifecycleWriteReceipt>;
export type CareerLifecyclePrepareResult =
  | Readonly<{ outcome: "prepared"; receipt: CareerLifecycleWriteReceipt }>
  | Readonly<{ outcome: "changed"; preview: CareerLifecycleWritePreview }>;

type PauseSource = Readonly<{
  operationId: string;
  reason: "job_archived" | "job_ended";
  action: "auto_pause_job_archived" | "auto_pause_job_ended";
}>;

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
    (row.lifecycle_previous_status === null || row.lifecycle_previous_status === "todo") &&
    isNullableString(row.lifecycle_operation_id);
}

function isInterview(value: unknown): value is Readonly<Interview> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<Interview>;
  return exactKeys(value, INTERVIEW_KEYS) &&
    typeof row.id === "string" && row.id.length > 0 && row.id.length <= 240 &&
    typeof row.job_id === "string" && typeof row.round_name === "string" &&
    typeof row.interview_type === "string" && isNullableString(row.scheduled_at) &&
    isSafeInteger(row.duration) && typeof row.interviewer === "string" &&
    typeof row.meeting_url === "string" &&
    (row.status === "scheduled" || row.status === "completed" || row.status === "canceled") &&
    typeof row.summary === "string" && typeof row.raw_notes === "string" &&
    typeof row.questions_json === "string" && typeof row.reflection === "string" &&
    typeof row.created_at === "string" && typeof row.updated_at === "string" &&
    isNullableString(row.canceled_at) && isNullableString(row.cancellation_reason) &&
    (row.lifecycle_previous_status === null ||
      row.lifecycle_previous_status === "scheduled") &&
    isNullableString(row.lifecycle_operation_id);
}

function isEvent(value: unknown): value is CareerLifecycleWriteEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<CareerLifecycleWriteEvent>;
  return exactKeys(value, EVENT_KEYS) && typeof row.id === "string" &&
    isNullableString(row.job_id) &&
    (row.entity_type === "job" || row.entity_type === "task" ||
      row.entity_type === "interview") && typeof row.entity_id === "string" &&
    typeof row.action === "string" && isNullableString(row.previous_status) &&
    isNullableString(row.next_status) && isNullableString(row.previous_due_at) &&
    isNullableString(row.next_due_at) && typeof row.reason === "string" &&
    typeof row.created_at === "string";
}

const UTF8_ENCODER = new TextEncoder();

function compareSqliteBinaryText(left: string, right: string): number {
  const leftBytes = UTF8_ENCODER.encode(left);
  const rightBytes = UTF8_ENCODER.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] < rightBytes[index] ? -1 : 1;
    }
  }
  return leftBytes.length < rightBytes.length
    ? -1
    : leftBytes.length > rightBytes.length ? 1 : 0;
}

function sortedUnique<Row extends { id: string }>(
  rows: readonly Row[],
): boolean {
  return rows.every((row, index) =>
    index === 0 || compareSqliteBinaryText(rows[index - 1].id, row.id) < 0);
}

function isPreparedIntent(value: unknown): value is PreparedIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Partial<PreparedIntent>;
  if (!isCareerWriteOperationId(intent.operationId, PURPOSE) ||
    typeof intent.jobId !== "string" || !intent.jobId || intent.jobId.length > 240) {
    return false;
  }
  if (intent.kind === "stage") {
    return exactKeys(value, ["kind", "jobId", "nextStageId", "operationId"]) &&
      typeof intent.nextStageId === "string" && intent.nextStageId.length > 0 &&
      intent.nextStageId.length <= 240;
  }
  return (intent.kind === "archive" || intent.kind === "restore") &&
    exactKeys(value, ["kind", "jobId", "operationId"]);
}

function isFacts(value: unknown): value is LifecycleFacts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const facts = value as Partial<LifecycleFacts>;
  if (!exactKeys(value, [
    "generationId", "generationSequence", "intent", "job", "currentStage",
    "nextStage", "tasks", "interviews", "events",
  ]) || generationFrom(facts) === null || !isPreparedIntent(facts.intent) ||
    !isJob(facts.job) || !isStage(facts.currentStage) ||
    !(facts.nextStage === null || isStage(facts.nextStage)) ||
    !Array.isArray(facts.tasks) || !facts.tasks.every(isTask) ||
    !Array.isArray(facts.interviews) || !facts.interviews.every(isInterview) ||
    !Array.isArray(facts.events) || !facts.events.every(isEvent) ||
    !sortedUnique(facts.tasks) || !sortedUnique(facts.interviews) ||
    !sortedUnique(facts.events) || facts.job.id !== facts.intent.jobId ||
    facts.job.stage_id !== facts.currentStage.id ||
    !facts.tasks.every(({ job_id }) => job_id === facts.job!.id) ||
    !facts.interviews.every(({ job_id }) => job_id === facts.job!.id) ||
    !facts.events.every(({ job_id }) => job_id === facts.job!.id)) return false;
  return facts.intent.kind === "stage"
    ? facts.nextStage !== null && facts.nextStage.id === facts.intent.nextStageId
    : facts.nextStage === null;
}

function sameRow<Row extends object>(
  left: Row,
  right: Row,
  keys: readonly (keyof Row & string)[],
): boolean {
  return keys.every((key) => left[key] === right[key]);
}

function sameRows<Row extends object & { id: string }>(
  left: readonly Row[],
  right: readonly Row[],
  keys: readonly (keyof Row & string)[],
): boolean {
  return left.length === right.length && left.every((row, index) =>
    row.id === right[index]?.id && sameRow(row, right[index], keys));
}

function normalizeIntent(
  value: CareerLifecycleWriteIntent,
  operationId: string,
): PreparedIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw careerWriteError("invalid_input", "职位变更意图无效。");
  }
  const jobId = requiredText(value.jobId, "职位 ID", 240);
  if (value.kind === "stage") {
    if (!exactKeys(value, ["kind", "jobId", "nextStageId"])) {
      throw careerWriteError("invalid_input", "职位变更意图包含不受支持的字段。");
    }
    return {
      kind: "stage",
      jobId,
      nextStageId: requiredText(value.nextStageId, "目标阶段 ID", 240),
      operationId,
    };
  }
  if (value.kind === "archive" || value.kind === "restore") {
    if (!exactKeys(value, ["kind", "jobId"])) {
      throw careerWriteError("invalid_input", "职位变更意图包含不受支持的字段。");
    }
    return { kind: value.kind, jobId, operationId };
  }
  throw careerWriteError("invalid_input", "职位变更意图无效。");
}

function stageSummary(stage: Stage) {
  return { id: stage.id, name: stage.name, isTerminal: stage.is_terminal === 1 };
}

function pauseSource(
  operationId: string | null,
  reason: PauseSource["reason"],
): PauseSource | null {
  if (!operationId) return null;
  return {
    operationId,
    reason,
    action: reason === "job_archived"
      ? "auto_pause_job_archived"
      : "auto_pause_job_ended",
  };
}

function pauseImpact(
  facts: LifecycleFacts,
  now: string,
): CareerLifecycleWriteImpactItem[] {
  const items: CareerLifecycleWriteImpactItem[] = [];
  for (const task of facts.tasks) {
    if (task.status !== "todo" || task.due_at === null ||
      task.lifecycle_operation_id !== null) continue;
    items.push({
      entityType: "task",
      id: task.id,
      label: task.title,
      scheduledAt: task.due_at,
      status: task.status,
      classification: task.due_at > now ? "affected" : "elapsed",
      effect: "pause",
    });
  }
  for (const interview of facts.interviews) {
    if (interview.status !== "scheduled" || interview.scheduled_at === null ||
      interview.lifecycle_operation_id !== null) continue;
    items.push({
      entityType: "interview",
      id: interview.id,
      label: interview.round_name,
      scheduledAt: interview.scheduled_at,
      status: interview.status,
      classification: interview.scheduled_at > now ? "affected" : "elapsed",
      effect: "pause",
    });
  }
  return items.sort((left, right) =>
    compareSqliteBinaryText(left.entityType, right.entityType) ||
    compareSqliteBinaryText(left.id, right.id));
}

function matchingPauseEvent(
  facts: LifecycleFacts,
  source: PauseSource,
  entityType: "task" | "interview",
  entityId: string,
): CareerLifecycleWriteEvent | undefined {
  return facts.events.find((event) =>
    event.id === `${source.operationId}_${entityType}_${entityId}` &&
    event.entity_type === entityType && event.entity_id === entityId);
}

function restoreClassification(
  row: Task | Interview,
  type: "task" | "interview",
  scheduledAt: string | null,
  sources: readonly PauseSource[],
  facts: LifecycleFacts,
  now: string,
): CareerLifecycleWriteImpactItem["classification"] | null {
  let associated = false;
  let elapsed = false;
  for (const source of sources) {
    const event = matchingPauseEvent(facts, source, type, row.id);
    if (row.lifecycle_operation_id !== source.operationId && !event) continue;
    associated = true;
    const previous = type === "task" ? "todo" : "scheduled";
    const exact = row.status === "canceled" &&
      row.cancellation_reason === source.reason &&
      row.lifecycle_operation_id === source.operationId &&
      row.lifecycle_previous_status === previous && row.canceled_at !== null &&
      row.updated_at === row.canceled_at && scheduledAt !== null && event &&
      event.job_id === row.job_id && event.action === source.action &&
      event.previous_status === previous && event.next_status === "canceled" &&
      event.previous_due_at === scheduledAt && event.next_due_at === scheduledAt &&
      event.reason === source.reason && event.created_at === row.canceled_at;
    if (!exact) continue;
    if (scheduledAt > now) return "affected";
    elapsed = true;
  }
  if (elapsed) return "elapsed";
  return associated ? "edited" : null;
}

function restoreImpact(
  facts: LifecycleFacts,
  sources: readonly PauseSource[],
  now: string,
): CareerLifecycleWriteImpactItem[] {
  const items: CareerLifecycleWriteImpactItem[] = [];
  for (const task of facts.tasks) {
    const classification = restoreClassification(
      task, "task", task.due_at, sources, facts, now,
    );
    if (classification) items.push({
      entityType: "task", id: task.id, label: task.title,
      scheduledAt: task.due_at, status: task.status,
      classification, effect: "restore",
    });
  }
  for (const interview of facts.interviews) {
    const classification = restoreClassification(
      interview, "interview", interview.scheduled_at, sources, facts, now,
    );
    if (classification) items.push({
      entityType: "interview", id: interview.id, label: interview.round_name,
      scheduledAt: interview.scheduled_at, status: interview.status,
      classification, effect: "restore",
    });
  }
  return items.sort((left, right) =>
    compareSqliteBinaryText(left.entityType, right.entityType) ||
    compareSqliteBinaryText(left.id, right.id));
}

function previewDecision(facts: LifecycleFacts, now: string) {
  const currentTerminal = facts.currentStage.is_terminal === 1;
  let transition: CareerLifecycleWriteTransition;
  let impact: CareerLifecycleWriteImpactItem[];
  let allowedChoices: readonly CareerLifecycleWriteChoice[];
  let requiresChoice: boolean;
  if (facts.intent.kind === "archive") {
    if (facts.job.archived !== 0) {
      throw careerWriteError("changed", "这个职位已经归档；没有准备写入。");
    }
    transition = "archive";
    impact = pauseImpact(facts, now);
    requiresChoice = impact.some(({ classification }) => classification === "affected");
    allowedChoices = requiresChoice ? ["keep", "pause"] : ["keep"];
  } else if (facts.intent.kind === "restore") {
    if (facts.job.archived !== 1) {
      throw careerWriteError("changed", "这个职位没有归档；没有准备写入。");
    }
    transition = currentTerminal ? "restore-terminal" : "restore-active";
    const source = pauseSource(facts.job.archived_operation_id, "job_archived");
    impact = restoreImpact(facts, source ? [source] : [], now);
    requiresChoice = !currentTerminal &&
      impact.some(({ classification }) => classification === "affected");
    allowedChoices = requiresChoice
      ? ["keep-paused", "restore-paused"]
      : ["keep-paused"];
  } else {
    if (facts.job.archived !== 0 || !facts.nextStage) {
      throw careerWriteError("changed", "职位当前不能调整阶段；没有准备写入。");
    }
    if (facts.nextStage.id === facts.currentStage.id) {
      throw careerWriteError("invalid_input", "这个职位已经在目标阶段。");
    }
    const nextTerminal = facts.nextStage.is_terminal === 1;
    if (!currentTerminal && nextTerminal) {
      transition = "active-to-terminal";
      impact = pauseImpact(facts, now);
      requiresChoice = impact.some(({ classification }) => classification === "affected");
      allowedChoices = requiresChoice ? ["keep", "pause"] : ["keep"];
    } else if (currentTerminal && !nextTerminal) {
      transition = "terminal-to-active";
      const sources = [
        pauseSource(facts.job.ended_operation_id, "job_ended"),
        pauseSource(facts.job.archived_operation_id, "job_archived"),
      ].filter((source): source is PauseSource => source !== null);
      impact = restoreImpact(facts, sources, now);
      requiresChoice = impact.some(({ classification }) => classification === "affected");
      allowedChoices = requiresChoice
        ? ["keep-paused", "restore-paused"]
        : ["keep-paused"];
    } else {
      transition = currentTerminal ? "terminal-to-terminal" : "active-to-active";
      impact = [];
      requiresChoice = false;
      allowedChoices = ["keep"];
    }
  }
  return { transition, impact, allowedChoices, requiresChoice };
}

function previewFingerprintValue(
  facts: LifecycleFacts,
  decision: ReturnType<typeof previewDecision>,
) {
  return {
    version: 1,
    authorization: facts,
    transition: decision.transition,
    impact: decision.impact,
    allowedChoices: decision.allowedChoices,
  };
}

async function buildPreview(
  facts: LifecycleFacts,
  now: string,
): Promise<CareerLifecycleWritePreview> {
  const decision = previewDecision(facts, now);
  const fingerprint = await hashCareerWriteValue(
    previewFingerprintValue(facts, decision),
  );
  const counts = {
    affected: decision.impact.filter(({ classification }) =>
      classification === "affected").length,
    elapsed: decision.impact.filter(({ classification }) =>
      classification === "elapsed").length,
    edited: decision.impact.filter(({ classification }) =>
      classification === "edited").length,
  };
  return {
    version: 1,
    operationId: facts.intent.operationId,
    generationId: facts.generationId,
    generationSequence: facts.generationSequence,
    preparedAt: now,
    intent: facts.intent,
    transition: decision.transition,
    job: {
      id: facts.job.id,
      company: facts.job.company,
      role: facts.job.role,
      archived: facts.job.archived === 1,
      currentStage: stageSummary(facts.currentStage),
      nextStage: facts.nextStage ? stageSummary(facts.nextStage) : null,
    },
    impact: decision.impact,
    counts,
    requiresChoice: decision.requiresChoice,
    allowedChoices: decision.allowedChoices,
    authorization: facts,
    fingerprint,
  };
}

async function readSingle<Row extends object>(
  runtime: CareerWriteStorageRuntime,
  sql: string,
  params: readonly unknown[],
  validator: (value: unknown) => value is Row,
  label: string,
): Promise<Readonly<Row> | null> {
  const rows = (await runtime.query<Row>(sql, params)).rows;
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !validator(rows[0])) {
    throw new Error(`${label}不符合 canonical 格式。`);
  }
  return { ...rows[0] };
}

async function readFacts(
  runtime: CareerWriteStorageRuntime,
  generation: CareerWriteGenerationExpectation,
  intent: PreparedIntent,
): Promise<LifecycleFacts> {
  const job = await readSingle<Job>(
    runtime,
    `SELECT id,company,role,location,source,source_url,stage_id,priority,
      salary,work_mode,description,applied_at,deadline,contact_name,note,tags,
      created_at,updated_at,archived,position,archived_at,ended_at,
      archived_operation_id,ended_operation_id
      FROM career_jobs WHERE id=? ORDER BY id LIMIT 2`,
    [intent.jobId], isJob, "职位行",
  );
  if (!job) throw careerWriteError("changed", "没有找到这个职位；没有准备写入。");
  const [currentStage, nextStage, tasksResult, interviewsResult, eventsResult] =
    await Promise.all([
      readSingle<Stage>(runtime,
        `SELECT id,name,color,position,is_terminal,hidden FROM career_stages
          WHERE id=? ORDER BY id LIMIT 2`,
        [job.stage_id], isStage, "当前阶段行"),
      intent.kind === "stage"
        ? readSingle<Stage>(runtime,
            `SELECT id,name,color,position,is_terminal,hidden FROM career_stages
              WHERE id=? ORDER BY id LIMIT 2`,
            [intent.nextStageId], isStage, "目标阶段行")
        : Promise.resolve(null),
      runtime.query<Task>(
        `SELECT id,job_id,contact_id,title,due_at,kind,priority,status,created_at,
          updated_at,canceled_at,cancellation_reason,lifecycle_previous_status,
          lifecycle_operation_id FROM career_tasks WHERE job_id=? ORDER BY id`,
        [job.id],
      ),
      runtime.query<Interview>(
        `SELECT id,job_id,round_name,interview_type,scheduled_at,duration,
          interviewer,meeting_url,status,summary,raw_notes,questions_json,
          reflection,created_at,updated_at,canceled_at,cancellation_reason,
          lifecycle_previous_status,lifecycle_operation_id
          FROM career_interviews WHERE job_id=? ORDER BY id`,
        [job.id],
      ),
      runtime.query<CareerLifecycleWriteEvent>(
        `SELECT id,job_id,entity_type,entity_id,action,previous_status,
          next_status,previous_due_at,next_due_at,reason,created_at
          FROM career_lifecycle_events WHERE job_id=? ORDER BY id`,
        [job.id],
      ),
    ]);
  if (intent.kind === "stage" && !nextStage) {
    throw careerWriteError("changed", "目标阶段已经不存在；没有准备写入。");
  }
  if (!currentStage || !tasksResult.rows.every(isTask) ||
    !interviewsResult.rows.every(isInterview) ||
    !eventsResult.rows.every(isEvent)) {
    throw new Error("职位生命周期事实不符合 canonical 格式。");
  }
  return {
    ...generation,
    intent,
    job,
    currentStage,
    nextStage,
    tasks: tasksResult.rows.map((row) => ({ ...row })),
    interviews: interviewsResult.rows.map((row) => ({ ...row })),
    events: eventsResult.rows.map((row) => ({ ...row })),
  };
}

function sameDisplayed(
  facts: LifecycleFacts,
  expected: CareerLifecycleDisplayedExpected,
): boolean {
  return sameCareerWriteGeneration(facts, expected) &&
    sameRow(facts.job, expected.job, JOB_KEYS) &&
    sameRow(facts.currentStage, expected.currentStage, STAGE_KEYS) &&
    ((facts.nextStage === null && expected.nextStage === null) ||
      (facts.nextStage !== null && expected.nextStage !== null &&
        sameRow(facts.nextStage, expected.nextStage, STAGE_KEYS)));
}

function pauseEvent(
  operationId: string,
  reason: PauseSource["reason"],
  type: "task" | "interview",
  id: string,
  jobId: string,
  previous: string,
  dueAt: string,
  operationAt: string,
): CareerLifecycleWriteEvent {
  return {
    id: `${operationId}_${type}_${id}`,
    job_id: jobId,
    entity_type: type,
    entity_id: id,
    action: reason === "job_archived"
      ? "auto_pause_job_archived"
      : "auto_pause_job_ended",
    previous_status: previous,
    next_status: "canceled",
    previous_due_at: dueAt,
    next_due_at: dueAt,
    reason,
    created_at: operationAt,
  };
}

function rootEvent(
  before: LifecycleReceiptBefore,
  operationAt: string,
): CareerLifecycleWriteEvent {
  const { job, intent, currentStage, nextStage, choice } = before;
  if (intent.kind === "archive") return {
    id: intent.operationId, job_id: job.id, entity_type: "job", entity_id: job.id,
    action: "archive_job", previous_status: job.stage_id, next_status: "archived",
    previous_due_at: null, next_due_at: null, reason: choice,
    created_at: operationAt,
  };
  if (intent.kind === "restore") return {
    id: intent.operationId, job_id: job.id, entity_type: "job", entity_id: job.id,
    action: "restore_job", previous_status: "archived", next_status: job.stage_id,
    previous_due_at: null, next_due_at: null, reason: choice,
    created_at: operationAt,
  };
  const action = nextStage!.is_terminal === 1 && currentStage.is_terminal === 0
    ? "end_job"
    : nextStage!.is_terminal === 0 && currentStage.is_terminal === 1
      ? "reopen_job"
      : "transition_job";
  return {
    id: intent.operationId, job_id: job.id, entity_type: "job", entity_id: job.id,
    action, previous_status: job.stage_id, next_status: nextStage!.id,
    previous_due_at: null, next_due_at: null, reason: choice,
    created_at: operationAt,
  };
}

function exactRestoreSource(
  row: Task | Interview,
  type: "task" | "interview",
  sources: readonly PauseSource[],
  facts: LifecycleFacts,
  decisionAt: string,
): PauseSource | null {
  const scheduledAt = type === "task"
    ? (row as Task).due_at
    : (row as Interview).scheduled_at;
  for (const source of sources) {
    if (restoreClassification(
      row, type, scheduledAt, [source], facts, decisionAt,
    ) === "affected") return source;
  }
  return null;
}

function deriveAfter(
  before: LifecycleReceiptBefore,
  operationAt: string,
): LifecycleReceiptAfter {
  const tasks = before.tasks.map((row) => ({ ...row })) as Task[];
  const interviews = before.interviews.map((row) => ({ ...row })) as Interview[];
  const events = before.events.map((row) => ({ ...row })) as CareerLifecycleWriteEvent[];
  let job: Job = { ...before.job };
  events.push(rootEvent(before, operationAt));

  const pause = (reason: PauseSource["reason"]) => {
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      if (task.status !== "todo" || task.due_at === null ||
        task.due_at <= before.decisionAt || task.lifecycle_operation_id !== null) continue;
      events.push(pauseEvent(
        before.intent.operationId, reason, "task", task.id, job.id,
        "todo", task.due_at, operationAt,
      ));
      tasks[index] = {
        ...task, status: "canceled", canceled_at: operationAt,
        cancellation_reason: reason, lifecycle_previous_status: "todo",
        lifecycle_operation_id: before.intent.operationId,
        updated_at: operationAt,
      };
    }
    for (let index = 0; index < interviews.length; index += 1) {
      const interview = interviews[index];
      if (interview.status !== "scheduled" || interview.scheduled_at === null ||
        interview.scheduled_at <= before.decisionAt ||
        interview.lifecycle_operation_id !== null) continue;
      events.push(pauseEvent(
        before.intent.operationId, reason, "interview", interview.id, job.id,
        "scheduled", interview.scheduled_at, operationAt,
      ));
      interviews[index] = {
        ...interview, status: "canceled", canceled_at: operationAt,
        cancellation_reason: reason, lifecycle_previous_status: "scheduled",
        lifecycle_operation_id: before.intent.operationId,
        updated_at: operationAt,
      };
    }
  };

  const restore = (sources: readonly PauseSource[]) => {
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      const source = exactRestoreSource(
        task, "task", sources, before, before.decisionAt,
      );
      if (!source) continue;
      events.push({
        id: `${before.intent.operationId}_task_${task.id}`,
        job_id: job.id, entity_type: "task", entity_id: task.id,
        action: "auto_restore_job_active", previous_status: task.status,
        next_status: "todo", previous_due_at: task.due_at,
        next_due_at: task.due_at, reason: source.reason, created_at: operationAt,
      });
      tasks[index] = {
        ...task, status: "todo", canceled_at: null, cancellation_reason: null,
        lifecycle_previous_status: null, lifecycle_operation_id: null,
        updated_at: operationAt,
      };
    }
    for (let index = 0; index < interviews.length; index += 1) {
      const interview = interviews[index];
      const source = exactRestoreSource(
        interview, "interview", sources, before, before.decisionAt,
      );
      if (!source) continue;
      events.push({
        id: `${before.intent.operationId}_interview_${interview.id}`,
        job_id: job.id, entity_type: "interview", entity_id: interview.id,
        action: "auto_restore_job_active", previous_status: interview.status,
        next_status: "scheduled", previous_due_at: interview.scheduled_at,
        next_due_at: interview.scheduled_at, reason: source.reason,
        created_at: operationAt,
      });
      interviews[index] = {
        ...interview, status: "scheduled", canceled_at: null,
        cancellation_reason: null, lifecycle_previous_status: null,
        lifecycle_operation_id: null, updated_at: operationAt,
      };
    }
  };

  if (before.intent.kind === "archive") {
    job = {
      ...job, archived: 1, archived_at: operationAt,
      archived_operation_id: before.choice === "pause"
        ? before.intent.operationId
        : job.archived_operation_id,
      updated_at: operationAt,
    };
    if (before.choice === "pause") pause("job_archived");
  } else if (before.intent.kind === "restore") {
    job = { ...job, archived: 0, archived_at: null, updated_at: operationAt };
    if (before.choice === "restore-paused") {
      const source = pauseSource(job.archived_operation_id, "job_archived");
      restore(source ? [source] : []);
    }
  } else {
    const next = before.nextStage!;
    const currentTerminal = before.currentStage.is_terminal === 1;
    const nextTerminal = next.is_terminal === 1;
    job = {
      ...job,
      stage_id: next.id,
      ended_at: nextTerminal ? job.ended_at ?? operationAt : null,
      ended_operation_id: !currentTerminal && nextTerminal && before.choice === "pause"
        ? before.intent.operationId
        : job.ended_operation_id,
      updated_at: operationAt,
    };
    if (!currentTerminal && nextTerminal && before.choice === "pause") {
      pause("job_ended");
    } else if (currentTerminal && !nextTerminal &&
      before.choice === "restore-paused") {
      const sources = [
        pauseSource(before.job.ended_operation_id, "job_ended"),
        pauseSource(before.job.archived_operation_id, "job_archived"),
      ].filter((source): source is PauseSource => source !== null);
      restore(sources);
    }
  }

  return {
    generationId: before.generationId,
    generationSequence: before.generationSequence,
    job,
    tasks: tasks.sort((left, right) => compareSqliteBinaryText(left.id, right.id)),
    interviews: interviews.sort((left, right) =>
      compareSqliteBinaryText(left.id, right.id)),
    events: events.sort((left, right) => compareSqliteBinaryText(left.id, right.id)),
  };
}

function isChoice(value: unknown): value is CareerLifecycleWriteChoice {
  return value === "keep" || value === "pause" || value === "keep-paused" ||
    value === "restore-paused";
}

function receiptKind(intent: PreparedIntent): CareerLifecycleWriteReceipt["kind"] {
  if (intent.kind === "stage") return "stage-transition";
  return intent.kind === "archive" ? "job-archive" : "job-restore";
}

function isAfter(value: unknown): value is LifecycleReceiptAfter {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const after = value as Partial<LifecycleReceiptAfter>;
  return exactKeys(value, [
    "generationId", "generationSequence", "job", "tasks", "interviews", "events",
  ]) && generationFrom(after) !== null && isJob(after.job) &&
    Array.isArray(after.tasks) && after.tasks.every(isTask) && sortedUnique(after.tasks) &&
    Array.isArray(after.interviews) && after.interviews.every(isInterview) &&
    sortedUnique(after.interviews) && Array.isArray(after.events) &&
    after.events.every(isEvent) && sortedUnique(after.events);
}

function isReceiptBefore(value: unknown): value is LifecycleReceiptBefore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const before = value as Partial<LifecycleReceiptBefore>;
  if (!exactKeys(value, [
    "generationId", "generationSequence", "intent", "job", "currentStage",
    "nextStage", "tasks", "interviews", "events", "decisionAt",
    "transition", "choice",
  ]) || !isCanonicalIsoTimestamp(before.decisionAt) || !isChoice(before.choice) ||
    typeof before.transition !== "string") return false;
  const facts = {
    generationId: before.generationId,
    generationSequence: before.generationSequence,
    intent: before.intent,
    job: before.job,
    currentStage: before.currentStage,
    nextStage: before.nextStage,
    tasks: before.tasks,
    interviews: before.interviews,
    events: before.events,
  };
  if (!isFacts(facts)) return false;
  try {
    const decision = previewDecision(facts, before.decisionAt);
    return decision.transition === before.transition &&
      decision.allowedChoices.includes(before.choice);
  } catch {
    return false;
  }
}

export function isCareerLifecycleWriteReceipt(
  value: unknown,
): value is CareerLifecycleWriteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<CareerLifecycleWriteReceipt>;
  if (!exactKeys(value, [
    "purpose", "version", "kind", "operationId", "generationId",
    "generationSequence", "operationAt", "before", "after",
    "projectionSha256",
  ]) || receipt.purpose !== PURPOSE ||
    receipt.version !== CAREER_WRITE_RECEIPT_VERSION ||
    !isCareerWriteOperationId(receipt.operationId, PURPOSE) ||
    !isCanonicalIsoTimestamp(receipt.operationAt) ||
    typeof receipt.projectionSha256 !== "string" ||
    generationFrom(receipt) === null || !isReceiptBefore(receipt.before) ||
    !isAfter(receipt.after) || receipt.operationId !== receipt.before.intent.operationId ||
    receipt.kind !== receiptKind(receipt.before.intent)) return false;
  const generation = generationFrom(receipt)!;
  if (!sameCareerWriteGeneration(generation, receipt.before) ||
    !sameCareerWriteGeneration(generation, receipt.after)) return false;
  const derived = deriveAfter(receipt.before, receipt.operationAt);
  const operationMilliseconds = Date.parse(receipt.operationAt);
  const isStrictlyLater = (previous: string | null) =>
    isCanonicalIsoTimestamp(previous) &&
    operationMilliseconds > Date.parse(previous);
  const changedRowsAdvanceVersion = <Row extends {
    id: string;
    updated_at: string | null;
  }>(
    before: readonly Row[],
    after: readonly Row[],
    keys: readonly (keyof Row & string)[],
  ) => before.every((row, index) => {
    const next = after[index];
    return next !== undefined && (sameRow(row, next, keys) ||
      (next.updated_at === receipt.operationAt && isStrictlyLater(row.updated_at)));
  });
  return receipt.after.job.updated_at === receipt.operationAt &&
    isStrictlyLater(receipt.before.decisionAt) &&
    isStrictlyLater(receipt.before.job.updated_at) &&
    changedRowsAdvanceVersion(receipt.before.tasks, receipt.after.tasks, TASK_KEYS) &&
    changedRowsAdvanceVersion(
      receipt.before.interviews,
      receipt.after.interviews,
      INTERVIEW_KEYS,
    ) && sameRow(derived.job, receipt.after.job, JOB_KEYS) &&
    sameRows(derived.tasks, receipt.after.tasks, TASK_KEYS) &&
    sameRows(derived.interviews, receipt.after.interviews, INTERVIEW_KEYS) &&
    sameRows(derived.events, receipt.after.events, EVENT_KEYS);
}

function isPreview(value: unknown): value is CareerLifecycleWritePreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preview = value as Partial<CareerLifecycleWritePreview>;
  if (!(exactKeys(value, [
    "version", "operationId", "generationId", "generationSequence",
    "preparedAt", "intent", "transition", "job", "impact", "counts",
    "requiresChoice", "allowedChoices", "authorization", "fingerprint",
  ]) && preview.version === 1 &&
    isCareerWriteOperationId(preview.operationId, PURPOSE) &&
    isCanonicalIsoTimestamp(preview.preparedAt) && isFacts(preview.authorization) &&
    isPreparedIntent(preview.intent) &&
    preview.operationId === preview.intent.operationId &&
    JSON.stringify(preview.intent) === JSON.stringify(preview.authorization.intent) &&
    typeof preview.fingerprint === "string" &&
    Array.isArray(preview.allowedChoices) && preview.allowedChoices.every(isChoice) &&
    Array.isArray(preview.impact) && typeof preview.requiresChoice === "boolean" &&
    generationFrom(preview) !== null &&
    sameCareerWriteGeneration(
      preview as CareerWriteGenerationExpectation,
      preview.authorization,
    ))) return false;
  try {
    const decision = previewDecision(preview.authorization, preview.preparedAt);
    const expectedJob = {
      id: preview.authorization.job.id,
      company: preview.authorization.job.company,
      role: preview.authorization.job.role,
      archived: preview.authorization.job.archived === 1,
      currentStage: stageSummary(preview.authorization.currentStage),
      nextStage: preview.authorization.nextStage
        ? stageSummary(preview.authorization.nextStage)
        : null,
    };
    const expectedCounts = {
      affected: decision.impact.filter(({ classification }) =>
        classification === "affected").length,
      elapsed: decision.impact.filter(({ classification }) =>
        classification === "elapsed").length,
      edited: decision.impact.filter(({ classification }) =>
        classification === "edited").length,
    };
    return preview.transition === decision.transition &&
      JSON.stringify(preview.job) === JSON.stringify(expectedJob) &&
      JSON.stringify(preview.impact) === JSON.stringify(decision.impact) &&
      JSON.stringify(preview.counts) === JSON.stringify(expectedCounts) &&
      preview.requiresChoice === decision.requiresChoice &&
      JSON.stringify(preview.allowedChoices) ===
        JSON.stringify(decision.allowedChoices) &&
      /^[0-9a-f]{64}$/.test(preview.fingerprint);
  } catch {
    return false;
  }
}

function rowPredicate<Row extends object>(
  table: "career_stages" | "career_jobs" | "career_tasks" |
    "career_interviews" | "career_lifecycle_events",
  keys: readonly (keyof Row & string)[],
  row: Row,
): SqlPredicate {
  return {
    sql: `EXISTS(SELECT 1 FROM ${table} WHERE ${keys.map((key) =>
      `${key} IS ?`).join(" AND ")})`,
    params: keys.map((key) => row[key]),
  };
}

function exactSetPredicates<Row extends object & { id: string }>(
  table: "career_tasks" | "career_interviews" | "career_lifecycle_events",
  jobColumn: "job_id",
  jobId: string,
  rows: readonly Row[],
  keys: readonly (keyof Row & string)[],
): SqlPredicate[] {
  return [
    {
      sql: `(SELECT COUNT(*) FROM ${table} WHERE ${jobColumn}=?)=?`,
      params: [jobId, rows.length],
    },
    ...rows.map((row) => rowPredicate(table, keys, row)),
  ];
}

const CAS_PREDICATE_CHUNK_SIZE = 32;

function chunkedCasStatements(predicates: readonly SqlPredicate[]): SqlStatement[] {
  const statements: SqlStatement[] = [];
  for (let index = 0; index < predicates.length; index += CAS_PREDICATE_CHUNK_SIZE) {
    statements.push(abortUnless(joinedPredicate(
      predicates.slice(index, index + CAS_PREDICATE_CHUNK_SIZE),
    )));
  }
  return statements;
}

function newEvents(receipt: CareerLifecycleWriteReceipt) {
  const beforeIds = new Set(receipt.before.events.map(({ id }) => id));
  return receipt.after.events.filter(({ id }) => !beforeIds.has(id));
}

function fullUpdateStatements(receipt: CareerLifecycleWriteReceipt): SqlStatement[] {
  const statements: SqlStatement[] = [{
    sql: `UPDATE career_jobs SET ${JOB_KEYS.slice(1).map((key) =>
      `${key}=?`).join(",")} WHERE id=?`,
    params: [...JOB_KEYS.slice(1).map((key) => receipt.after.job[key]), receipt.after.job.id],
  }];
  const beforeTasks = new Map(receipt.before.tasks.map((row) => [row.id, row]));
  for (const row of receipt.after.tasks) {
    const before = beforeTasks.get(row.id);
    if (before && sameRow(before, row, TASK_KEYS)) continue;
    statements.push({
      sql: `UPDATE career_tasks SET ${TASK_KEYS.slice(1).map((key) =>
        `${key}=?`).join(",")} WHERE id=?`,
      params: [...TASK_KEYS.slice(1).map((key) => row[key]), row.id],
    });
  }
  const beforeInterviews = new Map(receipt.before.interviews.map((row) => [row.id, row]));
  for (const row of receipt.after.interviews) {
    const before = beforeInterviews.get(row.id);
    if (before && sameRow(before, row, INTERVIEW_KEYS)) continue;
    statements.push({
      sql: `UPDATE career_interviews SET ${INTERVIEW_KEYS.slice(1).map((key) =>
        `${key}=?`).join(",")} WHERE id=?`,
      params: [...INTERVIEW_KEYS.slice(1).map((key) => row[key]), row.id],
    });
  }
  for (const event of newEvents(receipt)) {
    statements.push({
      sql: `INSERT INTO career_lifecycle_events(
        id,job_id,entity_type,entity_id,action,previous_status,next_status,
        previous_due_at,next_due_at,reason,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      params: EVENT_KEYS.map((key) => event[key]),
    });
  }
  return statements;
}

function receiptStatements(receipt: CareerLifecycleWriteReceipt): SqlStatement[] {
  const before = receipt.before;
  const predicates: SqlPredicate[] = [
    markerAbsentPredicate(receipt.operationId),
    rowPredicate("career_jobs", JOB_KEYS, before.job),
    rowPredicate("career_stages", STAGE_KEYS, before.currentStage),
    ...exactSetPredicates(
      "career_tasks", "job_id", before.job.id, before.tasks, TASK_KEYS,
    ),
    ...exactSetPredicates(
      "career_interviews", "job_id", before.job.id,
      before.interviews, INTERVIEW_KEYS,
    ),
    ...exactSetPredicates(
      "career_lifecycle_events", "job_id", before.job.id,
      before.events, EVENT_KEYS,
    ),
  ];
  if (before.nextStage) {
    predicates.push(rowPredicate("career_stages", STAGE_KEYS, before.nextStage));
  }
  for (const event of newEvents(receipt)) {
    predicates.push({
      sql: "NOT EXISTS(SELECT 1 FROM career_lifecycle_events WHERE id=?)",
      params: [event.id],
    });
  }
  return [
    ...chunkedCasStatements(predicates),
    ...fullUpdateStatements(receipt),
    markerStatement(receipt, receipt.before.job.id),
  ];
}

function factsEqual(left: LifecycleFacts, right: LifecycleFacts): boolean {
  return sameCareerWriteGeneration(left, right) &&
    JSON.stringify(left.intent) === JSON.stringify(right.intent) &&
    sameRow(left.job, right.job, JOB_KEYS) &&
    sameRow(left.currentStage, right.currentStage, STAGE_KEYS) &&
    ((left.nextStage === null && right.nextStage === null) ||
      (left.nextStage !== null && right.nextStage !== null &&
        sameRow(left.nextStage, right.nextStage, STAGE_KEYS))) &&
    sameRows(left.tasks, right.tasks, TASK_KEYS) &&
    sameRows(left.interviews, right.interviews, INTERVIEW_KEYS) &&
    sameRows(left.events, right.events, EVENT_KEYS);
}

function broadcastReason(kind: CareerLifecycleWriteReceipt["kind"]): string {
  switch (kind) {
    case "stage-transition": return "career-job-stage-transitioned";
    case "job-archive": return "career-job-archived";
    case "job-restore": return "career-job-restored";
  }
}

export function createCareerLifecycleWriteStorageService(
  runtime: CareerWriteStorageRuntime = defaultCareerWriteStorageRuntime,
) {
  async function preview(
    intentValue: CareerLifecycleWriteIntent,
    displayedValue: CareerLifecycleDisplayedExpected,
  ): Promise<CareerLifecycleWritePreview> {
    const displayed = jsonClone<CareerLifecycleDisplayedExpected>(
      displayedValue,
      CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
      "职位显示快照",
    );
    if (!displayed || typeof displayed !== "object" ||
      generationFrom(displayed) === null || !isJob(displayed.job) ||
      !isStage(displayed.currentStage) ||
      !(displayed.nextStage === null || isStage(displayed.nextStage)) ||
      displayed.job.stage_id !== displayed.currentStage.id) {
      throw careerWriteError("invalid_input", "职位显示快照无效。");
    }
    return withCareerWritePrepareLock(runtime, async () => {
      const generation = await readCurrentCareerWriteGeneration(runtime);
      requireCurrentCareerWriteGeneration(generation, displayed);
      const intent = normalizeIntent(
        intentValue,
        generatedCareerWriteOperationId(runtime, PURPOSE),
      );
      const facts = await readFacts(runtime, generation, intent);
      if (!sameDisplayed(facts, displayed)) {
        throw careerWriteError("changed", "职位或阶段已经变化；没有准备写入。");
      }
      return buildPreview(facts, new Date(runtime.now()).toISOString());
    });
  }

  async function prepare(
    previewValue: CareerLifecycleWritePreview,
    choiceValue: CareerLifecycleWriteChoice,
  ): Promise<CareerLifecyclePrepareResult> {
    const prepared = jsonClone<CareerLifecycleWritePreview>(
      previewValue,
      CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
      "职位变更预览",
    );
    if (!isPreview(prepared) || !isChoice(choiceValue)) {
      throw careerWriteError("invalid_input", "职位变更预览或处理方式无效。");
    }
    const expectedFingerprint = await hashCareerWriteValue(
      previewFingerprintValue(
        prepared.authorization,
        previewDecision(prepared.authorization, prepared.preparedAt),
      ),
    );
    if (expectedFingerprint !== prepared.fingerprint) {
      throw careerWriteError("invalid_input", "职位变更预览无法验证。");
    }
    return withCareerWritePrepareLock(runtime, async () => {
      const generation = await readCurrentCareerWriteGeneration(runtime);
      if (!sameCareerWriteGeneration(generation, prepared)) {
        throw careerWriteError("changed", "职迹数据库世代已经更换；没有准备写入。");
      }
      const decisionAt = new Date(runtime.now()).toISOString();
      const facts = await readFacts(runtime, generation, prepared.intent);
      const fresh = await buildPreview(facts, decisionAt);
      if (fresh.fingerprint !== prepared.fingerprint) {
        return { outcome: "changed", preview: fresh };
      }
      if (!fresh.allowedChoices.includes(choiceValue)) {
        throw careerWriteError("invalid_input", "请选择当前预览中可用的处理方式。");
      }
      const operationId = prepared.operationId;
      if (await readCareerWriteMarker(runtime, operationId)) {
        throw careerWriteError("changed", "职位变更操作标识已被占用；没有准备写入。");
      }
      const decision = previewDecision(facts, decisionAt);
      const affectedIds = new Set(
        decision.impact.filter(({ classification }) => classification === "affected")
          .map(({ entityType, id }) => `${entityType}:${id}`),
      );
      const versionTimes: Array<string | null> = [decisionAt, facts.job.updated_at];
      for (const task of facts.tasks) {
        if (affectedIds.has(`task:${task.id}`)) versionTimes.push(task.updated_at);
      }
      for (const interview of facts.interviews) {
        if (affectedIds.has(`interview:${interview.id}`)) {
          versionTimes.push(interview.updated_at);
        }
      }
      const operationAt = strictlyLaterTimestamp(runtime.now(), versionTimes);
      const before: LifecycleReceiptBefore = {
        ...facts,
        decisionAt,
        transition: decision.transition,
        choice: choiceValue,
      };
      const after = deriveAfter(before, operationAt);
      const afterEventIds = after.events.map(({ id }) => id);
      if (new Set(afterEventIds).size !== afterEventIds.length) {
        throw careerWriteError(
          "changed",
          "新的职位变更事件标识与现有事件冲突；没有准备写入。",
        );
      }
      const beforeEventIds = new Set(before.events.map(({ id }) => id));
      const newEventIds = after.events
        .filter(({ id }) => !beforeEventIds.has(id))
        .map(({ id }) => id);
      if (newEventIds.length > 0) {
        const placeholders = newEventIds.map(() => "?").join(",");
        const existingEvents = (await runtime.query<{ id: string }>(
          `SELECT id FROM career_lifecycle_events WHERE id IN (${placeholders})`,
          newEventIds,
        )).rows;
        if (existingEvents.length !== 0) {
          throw careerWriteError(
            "changed",
            "新的职位变更事件标识已被占用；没有准备写入。",
          );
        }
      }
      const receipt = await sealCareerWriteReceipt<CareerLifecycleWriteReceipt>({
        purpose: PURPOSE,
        version: CAREER_WRITE_RECEIPT_VERSION,
        kind: receiptKind(facts.intent),
        operationId,
        ...generation,
        operationAt,
        before,
        after,
      });
      return { outcome: "prepared", receipt };
    });
  }

  async function receiptStateUnlocked(
    receipt: CareerLifecycleWriteReceipt,
  ): Promise<Exclude<CareerWriteInspection, "still_unknown" | "invalid_receipt">> {
    const generation = await readCurrentCareerWriteGeneration(runtime);
    if (!sameCareerWriteGeneration(generation, receipt)) return "changed";
    const marker = await readCareerWriteMarker(runtime, receipt.operationId);
    if (marker) {
      return exactCareerWriteMarker(marker, receipt, receipt.before.job.id)
        ? "exact_saved"
        : "changed";
    }
    let current: LifecycleFacts;
    try {
      current = await readFacts(runtime, generation, receipt.before.intent);
    } catch (error) {
      if (error instanceof CareerWriteError && error.code === "changed") {
        return "changed";
      }
      throw error;
    }
    if (!factsEqual(current, receipt.before)) return "changed";
    const ids = newEvents(receipt).map(({ id }) => id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const rows = (await runtime.query<{ id: string }>(
        `SELECT id FROM career_lifecycle_events WHERE id IN (${placeholders})`,
        ids,
      )).rows;
      if (rows.length !== 0) return "changed";
    }
    return "expected";
  }

  async function inspect(value: unknown): Promise<CareerWriteInspection> {
    let receipt: CareerLifecycleWriteReceipt;
    try {
      receipt = jsonClone<CareerLifecycleWriteReceipt>(
        value,
        CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
      );
      if (!isCareerLifecycleWriteReceipt(receipt) ||
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

  async function commit(value: unknown): Promise<CareerLifecycleWriteResult> {
    let receipt: CareerLifecycleWriteReceipt;
    try {
      receipt = jsonClone<CareerLifecycleWriteReceipt>(
        value,
        CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
      );
      if (!isCareerLifecycleWriteReceipt(receipt) ||
        !await careerWriteReceiptHashIsValid(receipt)) {
        throw careerWriteError("invalid_receipt", "职位变更回执无效；没有改动资料。");
      }
    } catch (error) {
      if (error instanceof CareerWriteError && error.code === "invalid_receipt") throw error;
      throw careerWriteError("invalid_receipt", "职位变更回执无法验证；没有改动资料。");
    }
    const entityId = receipt.before.job.id;
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
            "这次职位变更确定没有提交；保留原回执后可以重试。",
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
      return { outcome: "outcome_uncertain", receipt, entityId, retryable: true };
    }
  }

  return {
    previewCareerLifecycleWrite: preview,
    prepareCareerLifecycleWrite: prepare,
    inspectCareerLifecycleWrite: inspect,
    commitCareerLifecycleWrite: commit,
  } as const;
}

const defaultService = createCareerLifecycleWriteStorageService();

export const previewCareerLifecycleWrite =
  defaultService.previewCareerLifecycleWrite;
export const prepareCareerLifecycleWrite =
  defaultService.prepareCareerLifecycleWrite;
export const inspectCareerLifecycleWrite =
  defaultService.inspectCareerLifecycleWrite;
export const commitCareerLifecycleWrite =
  defaultService.commitCareerLifecycleWrite;
