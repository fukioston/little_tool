import { localDb } from "@/lib/local-db/client";
import type { SqlStatement } from "@/lib/local-db/types";
import {
  broadcastCareerDataChanged,
  withCareerWriteLock,
} from "./lock";
import type {
  Activity,
  Interview,
  InterviewQuestion,
  Job,
  Stage,
} from "./types";

const DATABASE = "career" as const;
const RECEIPT_PURPOSE = "career-core-write" as const;
const RECEIPT_VERSION = 1 as const;
const RECEIPT_MAX_JSON_BYTES = 1_048_576;
const EXPECTED_SET_MAX_JSON_BYTES = 16 * 1_048_576;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATION_ID_PATTERN = new RegExp(`^(?:legacy|${UUID_V4_PATTERN.source.slice(1, -1)})$`, "i");
const OPERATION_ID_PATTERN = new RegExp(
  `^career-core-operation-${UUID_V4_PATTERN.source.slice(1, -1)}$`,
  "i",
);
const GENERATED_ENTITY_ID_PATTERN = new RegExp(
  `^(?:job|activity|interview)_${UUID_V4_PATTERN.source.slice(1, -1)}$`,
  "i",
);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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
const INTERVIEW_KEYS = [
  "id", "job_id", "round_name", "interview_type", "scheduled_at",
  "duration", "interviewer", "meeting_url", "status", "summary",
  "raw_notes", "questions_json", "reflection", "created_at", "updated_at",
  "canceled_at", "cancellation_reason", "lifecycle_previous_status",
  "lifecycle_operation_id",
] as const;
const ACTIVITY_KEYS = ["id", "job_id", "type", "detail", "created_at"] as const;

export type CareerCoreWriteKind =
  | "stage-rename"
  | "job-create"
  | "job-update"
  | "interview-create"
  | "interview-update";

export type CareerCoreGenerationExpectation = Readonly<{
  generationId: string;
  generationSequence: number;
}>;

export type CareerCoreWriteExpectedSet = CareerCoreGenerationExpectation & Readonly<{
  stages: readonly Readonly<Stage>[];
  jobs: readonly Readonly<Job>[];
  interviews: readonly Readonly<Interview>[];
}>;

export type CareerStageWriteExpectedState = CareerCoreGenerationExpectation & Readonly<{
  stage: Readonly<Stage>;
}>;

export type CareerJobWriteExpectedState = CareerCoreGenerationExpectation & Readonly<{
  job: Readonly<Job>;
  stage: Readonly<Stage>;
}>;

export type CareerInterviewWriteExpectedState = CareerCoreGenerationExpectation & Readonly<{
  interview: Readonly<Interview>;
  job: Readonly<Job>;
  stage: Readonly<Stage>;
}>;

export type CreateCareerJobCoreInput = Readonly<{
  company: string;
  role: string;
  location?: string;
  source?: string;
  sourceUrl?: string;
  priority?: number;
  salary?: string;
  workMode?: string;
  description?: string;
  deadline?: string | null;
  note?: string;
  tags?: string;
}>;

export type UpdateCareerJobCoreInput = Readonly<{
  company: string;
  role: string;
  location: string;
  salary: string;
  workMode: string;
  description: string;
  deadline: string | null;
  note: string;
  tags: string;
}>;

export type CreateCareerInterviewCoreInput = Readonly<{
  roundName: string;
  interviewType?: string;
  scheduledAt: string;
  duration?: number;
  interviewer?: string;
  meetingUrl?: string;
}>;

export type UpdateCareerInterviewCoreInput = Readonly<{
  status: Interview["status"];
  summary: string;
  rawNotes: string;
  questions: readonly InterviewQuestion[];
  reflection: string;
}>;

type JobCreateBefore = CareerCoreGenerationExpectation & Readonly<{
  stage: Readonly<Stage>;
  jobId: string;
  activityId: string;
}>;

type JobCreateAfter = CareerCoreGenerationExpectation & Readonly<{
  stage: Readonly<Stage>;
  job: Readonly<Job>;
  activity: Readonly<Activity>;
}>;

type InterviewCreateBefore = CareerCoreGenerationExpectation & Readonly<{
  job: Readonly<Job>;
  stage: Readonly<Stage>;
  interviewId: string;
}>;

type InterviewCreateAfter = CareerCoreGenerationExpectation & Readonly<{
  job: Readonly<Job>;
  stage: Readonly<Stage>;
  interview: Readonly<Interview>;
}>;

type CareerCoreWriteReceiptBase<
  Kind extends CareerCoreWriteKind,
  Before,
  After,
> = Readonly<{
  purpose: typeof RECEIPT_PURPOSE;
  version: typeof RECEIPT_VERSION;
  kind: Kind;
  operationId: string;
  generationId: string;
  generationSequence: number;
  operationAt: string;
  before: Before;
  after: After;
  projectionSha256: string;
}>;

export type CareerStageRenameReceipt = CareerCoreWriteReceiptBase<
  "stage-rename",
  CareerStageWriteExpectedState,
  CareerStageWriteExpectedState
>;

export type CareerJobCreateReceipt = CareerCoreWriteReceiptBase<
  "job-create",
  JobCreateBefore,
  JobCreateAfter
>;

export type CareerJobUpdateReceipt = CareerCoreWriteReceiptBase<
  "job-update",
  CareerJobWriteExpectedState,
  CareerJobWriteExpectedState
>;

export type CareerInterviewCreateReceipt = CareerCoreWriteReceiptBase<
  "interview-create",
  InterviewCreateBefore,
  InterviewCreateAfter
>;

export type CareerInterviewUpdateReceipt = CareerCoreWriteReceiptBase<
  "interview-update",
  CareerInterviewWriteExpectedState,
  CareerInterviewWriteExpectedState
>;

export type CareerCoreWriteReceipt =
  | CareerStageRenameReceipt
  | CareerJobCreateReceipt
  | CareerJobUpdateReceipt
  | CareerInterviewCreateReceipt
  | CareerInterviewUpdateReceipt;

export type CareerCoreWriteInspection =
  | "exact_saved"
  | "expected"
  | "changed"
  | "still_unknown"
  | "invalid_receipt";

export type CareerCoreWriteResult =
  | Readonly<{
      outcome: "saved" | "already_saved";
      receipt: CareerCoreWriteReceipt;
      entityId: string;
    }>
  | Readonly<{
      outcome: "changed";
      receipt: CareerCoreWriteReceipt;
      entityId: string;
      retryable: false;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      receipt: CareerCoreWriteReceipt;
      entityId: string;
      retryable: true;
    }>;

export type CareerCoreWriteErrorCode =
  | "invalid_input"
  | "invalid_receipt"
  | "lock_unavailable"
  | "inspect_failed"
  | "changed"
  | "write_failed";

export class CareerCoreWriteError extends Error {
  readonly name = "CareerCoreWriteError";

  constructor(
    readonly code: CareerCoreWriteErrorCode,
    message: string,
    readonly receipt?: CareerCoreWriteReceipt,
  ) {
    super(message);
  }
}

type QueryResult<Row extends object> = Readonly<{ rows: readonly Row[] }>;
type BatchResult = Readonly<{ changes: number }>;
type CurrentGeneration = Readonly<{
  generationId: string;
  sequence: number;
}>;

export type CareerCoreWriteStorageRuntime = Readonly<{
  withExclusiveLock<Result>(operation: () => Promise<Result>): Promise<Result>;
  query<Row extends object>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  batch(statements: readonly SqlStatement[]): Promise<BatchResult>;
  currentGeneration(): Promise<CurrentGeneration>;
  now(): number;
  randomUUID(): string;
  broadcast(reason: string): void;
}>;

type StoredOperation = Readonly<{
  operation_id: string;
  purpose: string;
  receipt_version: number;
  kind: string;
  entity_id: string;
  projection_sha256: string;
  operation_at: string;
}>;

function coreError(
  code: CareerCoreWriteErrorCode,
  message: string,
  receipt?: CareerCoreWriteReceipt,
): CareerCoreWriteError {
  return new CareerCoreWriteError(code, message, receipt);
}

function withRequiredCareerCoreWriteLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const locks = typeof navigator === "undefined"
    ? null
    : (navigator as Navigator & { locks?: unknown }).locks ?? null;
  if (!locks) {
    throw coreError(
      "lock_unavailable",
      "当前浏览器不支持安全的跨标签页写入锁，请使用最新版 Chrome、Edge 或 Safari。",
    );
  }
  return withCareerWriteLock(() => operation());
}

const defaultRuntime: CareerCoreWriteStorageRuntime = {
  withExclusiveLock: withRequiredCareerCoreWriteLock,
  query: <Row extends object>(sql: string, params?: readonly unknown[]) =>
    localDb.query<Row>(DATABASE, sql, params),
  batch: (statements) => localDb.batch(DATABASE, statements, { transaction: true }),
  currentGeneration: () => localDb.currentGeneration(DATABASE),
  now: () => Date.now(),
  randomUUID: () => crypto.randomUUID(),
  broadcast: (reason) => broadcastCareerDataChanged(reason),
};

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isGeneration(value: unknown): value is CareerCoreGenerationExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const generation = value as Partial<CareerCoreGenerationExpectation>;
  return exactKeys(value, ["generationId", "generationSequence"]) &&
    typeof generation.generationId === "string" &&
    GENERATION_ID_PATTERN.test(generation.generationId) &&
    isSafeInteger(generation.generationSequence) &&
    generation.generationSequence >= 0;
}

function isStoredStage(value: unknown): value is Readonly<Stage> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<Stage>;
  return exactKeys(value, STAGE_KEYS) &&
    typeof row.id === "string" && row.id.length > 0 && row.id.length <= 240 &&
    typeof row.name === "string" &&
    typeof row.color === "string" &&
    isSafeInteger(row.position) &&
    (row.is_terminal === 0 || row.is_terminal === 1) &&
    (row.hidden === 0 || row.hidden === 1);
}

function isStoredJob(value: unknown): value is Readonly<Job> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<Job>;
  return exactKeys(value, JOB_KEYS) &&
    typeof row.id === "string" && row.id.length > 0 && row.id.length <= 240 &&
    typeof row.company === "string" &&
    typeof row.role === "string" &&
    typeof row.location === "string" &&
    typeof row.source === "string" &&
    typeof row.source_url === "string" &&
    typeof row.stage_id === "string" && row.stage_id.length > 0 &&
    isSafeInteger(row.priority) &&
    typeof row.salary === "string" &&
    typeof row.work_mode === "string" &&
    typeof row.description === "string" &&
    isNullableString(row.applied_at) &&
    isNullableString(row.deadline) &&
    typeof row.contact_name === "string" &&
    typeof row.note === "string" &&
    typeof row.tags === "string" &&
    typeof row.created_at === "string" &&
    typeof row.updated_at === "string" &&
    (row.archived === 0 || row.archived === 1) &&
    isSafeInteger(row.position) &&
    isNullableString(row.archived_at) &&
    isNullableString(row.ended_at) &&
    isNullableString(row.archived_operation_id) &&
    isNullableString(row.ended_operation_id);
}

function isStoredInterview(value: unknown): value is Readonly<Interview> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<Interview>;
  return exactKeys(value, INTERVIEW_KEYS) &&
    typeof row.id === "string" && row.id.length > 0 && row.id.length <= 240 &&
    typeof row.job_id === "string" && row.job_id.length > 0 &&
    typeof row.round_name === "string" &&
    typeof row.interview_type === "string" &&
    isNullableString(row.scheduled_at) &&
    isSafeInteger(row.duration) && row.duration >= 1 &&
    typeof row.interviewer === "string" &&
    typeof row.meeting_url === "string" &&
    (row.status === "scheduled" || row.status === "completed" ||
      row.status === "canceled") &&
    typeof row.summary === "string" &&
    typeof row.raw_notes === "string" &&
    typeof row.questions_json === "string" &&
    typeof row.reflection === "string" &&
    typeof row.created_at === "string" &&
    typeof row.updated_at === "string" &&
    isNullableString(row.canceled_at) &&
    isNullableString(row.cancellation_reason) &&
    (row.lifecycle_previous_status === null ||
      row.lifecycle_previous_status === "scheduled") &&
    isNullableString(row.lifecycle_operation_id);
}

function isStoredActivity(value: unknown): value is Readonly<Activity> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<Activity>;
  return exactKeys(value, ACTIVITY_KEYS) &&
    typeof row.id === "string" && row.id.length > 0 && row.id.length <= 240 &&
    isNullableString(row.job_id) &&
    typeof row.type === "string" &&
    typeof row.detail === "string" &&
    typeof row.created_at === "string";
}

function sameGeneration(
  left: CareerCoreGenerationExpectation,
  right: CareerCoreGenerationExpectation,
): boolean {
  return left.generationId === right.generationId &&
    left.generationSequence === right.generationSequence;
}

function isStageExpected(value: unknown): value is CareerStageWriteExpectedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<CareerStageWriteExpectedState>;
  return exactKeys(value, ["generationId", "generationSequence", "stage"]) &&
    isGeneration({
      generationId: state.generationId,
      generationSequence: state.generationSequence,
    }) && isStoredStage(state.stage);
}

function isJobExpected(value: unknown): value is CareerJobWriteExpectedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<CareerJobWriteExpectedState>;
  return exactKeys(value, ["generationId", "generationSequence", "job", "stage"]) &&
    isGeneration({
      generationId: state.generationId,
      generationSequence: state.generationSequence,
    }) && isStoredJob(state.job) && isStoredStage(state.stage) &&
    state.job.stage_id === state.stage.id;
}

function isInterviewExpected(
  value: unknown,
): value is CareerInterviewWriteExpectedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<CareerInterviewWriteExpectedState>;
  return exactKeys(value, [
    "generationId", "generationSequence", "interview", "job", "stage",
  ]) && isGeneration({
    generationId: state.generationId,
    generationSequence: state.generationSequence,
  }) && isStoredInterview(state.interview) && isStoredJob(state.job) &&
    isStoredStage(state.stage) && state.interview.job_id === state.job.id &&
    state.job.stage_id === state.stage.id;
}

function isJobCreateBefore(value: unknown): value is JobCreateBefore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<JobCreateBefore>;
  return exactKeys(value, [
    "generationId", "generationSequence", "stage", "jobId", "activityId",
  ]) && isGeneration({
    generationId: state.generationId,
    generationSequence: state.generationSequence,
  }) && isStoredStage(state.stage) &&
    typeof state.jobId === "string" && GENERATED_ENTITY_ID_PATTERN.test(state.jobId) &&
    state.jobId.startsWith("job_") &&
    typeof state.activityId === "string" &&
    GENERATED_ENTITY_ID_PATTERN.test(state.activityId) &&
    state.activityId.startsWith("activity_");
}

function isJobCreateAfter(value: unknown): value is JobCreateAfter {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<JobCreateAfter>;
  return exactKeys(value, [
    "generationId", "generationSequence", "stage", "job", "activity",
  ]) && isGeneration({
    generationId: state.generationId,
    generationSequence: state.generationSequence,
  }) && isStoredStage(state.stage) && isStoredJob(state.job) &&
    isStoredActivity(state.activity) && state.job.stage_id === state.stage.id &&
    state.activity.job_id === state.job.id;
}

function isInterviewCreateBefore(
  value: unknown,
): value is InterviewCreateBefore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<InterviewCreateBefore>;
  return exactKeys(value, [
    "generationId", "generationSequence", "job", "stage", "interviewId",
  ]) && isGeneration({
    generationId: state.generationId,
    generationSequence: state.generationSequence,
  }) && isStoredJob(state.job) && isStoredStage(state.stage) &&
    state.job.stage_id === state.stage.id &&
    typeof state.interviewId === "string" &&
    GENERATED_ENTITY_ID_PATTERN.test(state.interviewId) &&
    state.interviewId.startsWith("interview_");
}

function isInterviewCreateAfter(
  value: unknown,
): value is InterviewCreateAfter {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<InterviewCreateAfter>;
  return exactKeys(value, [
    "generationId", "generationSequence", "job", "stage", "interview",
  ]) && isGeneration({
    generationId: state.generationId,
    generationSequence: state.generationSequence,
  }) && isStoredJob(state.job) && isStoredStage(state.stage) &&
    isStoredInterview(state.interview) && state.job.stage_id === state.stage.id &&
    state.interview.job_id === state.job.id;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError("Value is not JSON-safe");
}

function sameProjection(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function jsonClone(value: unknown, maximumBytes: number, label: string): unknown {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw coreError("invalid_input", `${label}必须是安全、有限的 JSON 数据。`);
  }
  if (typeof encoded !== "string" ||
    new TextEncoder().encode(encoded).byteLength > maximumBytes) {
    throw coreError("invalid_input", `${label}超过安全大小限制。`);
  }
  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    throw coreError("invalid_input", `${label}不是有效 JSON 数据。`);
  }
}

function cloneChecked<Result>(
  value: unknown,
  guard: (candidate: unknown) => candidate is Result,
  label: string,
): Result {
  const cloned = jsonClone(value, RECEIPT_MAX_JSON_BYTES, label);
  if (!guard(cloned)) {
    throw coreError("invalid_input", `${label}格式不正确。`);
  }
  return cloned;
}

async function sha256Hex(value: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("SHA-256 unavailable");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw coreError("invalid_input", `${label}不是有效时间。`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw coreError("invalid_input", `${label}不是有效时间。`);
  }
  return new Date(milliseconds).toISOString();
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}

function nextTimestamp(previous: string, now: number, label: string): string {
  const previousMilliseconds = Date.parse(previous);
  if (!Number.isFinite(previousMilliseconds) || !Number.isFinite(now)) {
    throw coreError("invalid_input", `${label}版本时间无效。`);
  }
  const next = Math.max(Math.trunc(now), previousMilliseconds + 1);
  if (!Number.isSafeInteger(next)) {
    throw coreError("invalid_input", `${label}版本时间超出安全范围。`);
  }
  try {
    return new Date(next).toISOString();
  } catch {
    throw coreError("invalid_input", `${label}版本时间超出安全范围。`);
  }
}

function operationClock(runtime: CareerCoreWriteStorageRuntime): Readonly<{
  milliseconds: number;
  timestamp: string;
}> {
  const now = runtime.now();
  if (!Number.isSafeInteger(now)) {
    throw coreError("invalid_input", "设备时间不在可接受范围。");
  }
  try {
    return { milliseconds: now, timestamp: new Date(now).toISOString() };
  } catch {
    throw coreError("invalid_input", "设备时间不在可接受范围。");
  }
}

function receiptEntityId(receipt: CareerCoreWriteReceipt): string {
  switch (receipt.kind) {
    case "stage-rename": return receipt.after.stage.id;
    case "job-create": return receipt.after.job.id;
    case "job-update": return receipt.after.job.id;
    case "interview-create": return receipt.after.interview.id;
    case "interview-update": return receipt.after.interview.id;
  }
}

function receiptCommonIsValid(receipt: Partial<CareerCoreWriteReceipt>): boolean {
  return receipt.purpose === RECEIPT_PURPOSE &&
    receipt.version === RECEIPT_VERSION &&
    typeof receipt.operationId === "string" &&
    OPERATION_ID_PATTERN.test(receipt.operationId) &&
    typeof receipt.generationId === "string" &&
    GENERATION_ID_PATTERN.test(receipt.generationId) &&
    isSafeInteger(receipt.generationSequence) &&
    receipt.generationSequence >= 0 &&
    isCanonicalTimestamp(receipt.operationAt) &&
    typeof receipt.projectionSha256 === "string" &&
    SHA256_PATTERN.test(receipt.projectionSha256);
}

function sameJobExceptEditable(before: Job, after: Job): boolean {
  const editable = new Set<keyof Job>([
    "company", "role", "location", "salary", "work_mode", "description",
    "deadline", "note", "tags", "updated_at",
  ]);
  return JOB_KEYS.every((key) => editable.has(key) || before[key] === after[key]);
}

function sameInterviewExceptEditable(
  before: Interview,
  after: Interview,
): boolean {
  const editable = new Set<keyof Interview>([
    "status", "summary", "raw_notes", "questions_json", "reflection",
    "updated_at",
  ]);
  return INTERVIEW_KEYS.every((key) =>
    editable.has(key) || before[key] === after[key]);
}

function normalizedRequiredLine(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum &&
    value === value.trim().replace(/\s+/g, " ");
}

function normalizedOptionalLine(value: string, maximum: number): boolean {
  return value.length <= maximum && value === value.trim().replace(/\s+/g, " ");
}

function normalizedMultiline(value: string, maximum: number): boolean {
  return value.length <= maximum &&
    value === value.replace(/\r\n?/g, "\n").trim();
}

function normalizedUrl(value: string): boolean {
  if (!value) return true;
  if (!normalizedOptionalLine(value, 2_048)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function canonicalNullableTimestamp(value: string | null): boolean {
  return value === null || isCanonicalTimestamp(value);
}

function canonicalQuestionsJson(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    const normalized = normalizeQuestions(parsed);
    return JSON.stringify(normalized) === value &&
      new TextEncoder().encode(value).byteLength <= 500_000;
  } catch {
    return false;
  }
}

function validJobEditableFacts(job: Job): boolean {
  return normalizedRequiredLine(job.company, 240) &&
    normalizedRequiredLine(job.role, 240) &&
    normalizedOptionalLine(job.location, 500) &&
    normalizedOptionalLine(job.salary, 500) &&
    normalizedOptionalLine(job.work_mode, 160) &&
    normalizedMultiline(job.description, 200_000) &&
    canonicalNullableTimestamp(job.deadline) &&
    normalizedMultiline(job.note, 200_000) &&
    normalizedOptionalLine(job.tags, 2_000);
}

function validCreatedJob(job: Job): boolean {
  return validJobEditableFacts(job) &&
    normalizedOptionalLine(job.source, 160) &&
    normalizedUrl(job.source_url) &&
    job.priority >= 1 && job.priority <= 3 &&
    job.contact_name === "";
}

function validCreatedInterview(interview: Interview): boolean {
  return normalizedRequiredLine(interview.round_name, 240) &&
    normalizedOptionalLine(interview.interview_type, 160) &&
    interview.scheduled_at !== null &&
    isCanonicalTimestamp(interview.scheduled_at) &&
    interview.duration >= 1 && interview.duration <= 1_440 &&
    normalizedOptionalLine(interview.interviewer, 500) &&
    normalizedUrl(interview.meeting_url);
}

function validInterviewEditableFacts(interview: Interview): boolean {
  return normalizedMultiline(interview.summary, 200_000) &&
    normalizedMultiline(interview.raw_notes, 300_000) &&
    canonicalQuestionsJson(interview.questions_json) &&
    normalizedMultiline(interview.reflection, 200_000);
}

function expectedUpdatedAt(before: string, operationAt: string): string | null {
  const beforeMilliseconds = Date.parse(before);
  const operationMilliseconds = Date.parse(operationAt);
  if (!Number.isFinite(beforeMilliseconds) ||
    !Number.isFinite(operationMilliseconds)) return null;
  try {
    return new Date(Math.max(
      operationMilliseconds,
      beforeMilliseconds + 1,
    )).toISOString();
  } catch {
    return null;
  }
}

function isReceiptTransition(receipt: CareerCoreWriteReceipt): boolean {
  const generation = {
    generationId: receipt.generationId,
    generationSequence: receipt.generationSequence,
  };
  if (!sameGeneration(generation, receipt.before) ||
    !sameGeneration(generation, receipt.after)) return false;

  switch (receipt.kind) {
    case "stage-rename":
      return isStageExpected(receipt.before) && isStageExpected(receipt.after) &&
        STAGE_KEYS.every((key) => key === "name" ||
          receipt.before.stage[key] === receipt.after.stage[key]) &&
        normalizedRequiredLine(receipt.after.stage.name, 160) &&
        receipt.before.stage.name !== receipt.after.stage.name;
    case "job-create": {
      if (!isJobCreateBefore(receipt.before) ||
        !isJobCreateAfter(receipt.after)) return false;
      const { stage, job, activity } = receipt.after;
      return sameProjection(receipt.before.stage, stage) &&
        stage.is_terminal === 0 && stage.hidden === 0 &&
        validCreatedJob(job) &&
        receipt.before.jobId === job.id &&
        receipt.before.activityId === activity.id &&
        job.archived === 0 && job.position === 0 &&
        job.archived_at === null && job.ended_at === null &&
        job.archived_operation_id === null && job.ended_operation_id === null &&
        job.created_at === receipt.operationAt &&
        job.updated_at === receipt.operationAt &&
        job.applied_at === (stage.id === "stage_applied"
          ? receipt.operationAt
          : null) &&
        activity.type === "create" &&
        activity.created_at === receipt.operationAt &&
        activity.detail === `记录了 ${job.company} · ${job.role}`;
    }
    case "job-update":
      return isJobExpected(receipt.before) && isJobExpected(receipt.after) &&
        receipt.before.job.archived === 0 &&
        receipt.after.job.archived === 0 &&
        validJobEditableFacts(receipt.after.job) &&
        sameProjection(receipt.before.stage, receipt.after.stage) &&
        sameJobExceptEditable(receipt.before.job, receipt.after.job) &&
        receipt.after.job.updated_at === expectedUpdatedAt(
          receipt.before.job.updated_at,
          receipt.operationAt,
        ) &&
        [
          "company", "role", "location", "salary", "work_mode",
          "description", "deadline", "note", "tags",
        ].some((key) => receipt.before.job[key as keyof Job] !==
          receipt.after.job[key as keyof Job]);
    case "interview-create": {
      if (!isInterviewCreateBefore(receipt.before) ||
        !isInterviewCreateAfter(receipt.after)) return false;
      const { job, stage, interview } = receipt.after;
      return sameProjection(receipt.before.job, job) &&
        sameProjection(receipt.before.stage, stage) &&
        job.archived === 0 && stage.is_terminal === 0 && stage.hidden === 0 &&
        validCreatedInterview(interview) &&
        receipt.before.interviewId === interview.id &&
        interview.status === "scheduled" && interview.summary === "" &&
        interview.raw_notes === "" && interview.questions_json === "[]" &&
        interview.reflection === "" &&
        interview.created_at === receipt.operationAt &&
        interview.updated_at === receipt.operationAt &&
        interview.canceled_at === null &&
        interview.cancellation_reason === null &&
        interview.lifecycle_previous_status === null &&
        interview.lifecycle_operation_id === null;
    }
    case "interview-update": {
      if (!isInterviewExpected(receipt.before) ||
        !isInterviewExpected(receipt.after)) return false;
      const before = receipt.before.interview;
      const after = receipt.after.interview;
      return sameProjection(receipt.before.job, receipt.after.job) &&
        sameProjection(receipt.before.stage, receipt.after.stage) &&
        validInterviewEditableFacts(after) &&
        sameInterviewExceptEditable(before, after) &&
        before.canceled_at === after.canceled_at &&
        before.cancellation_reason === after.cancellation_reason &&
        before.lifecycle_previous_status === after.lifecycle_previous_status &&
        before.lifecycle_operation_id === after.lifecycle_operation_id &&
        (before.lifecycle_operation_id === null || after.status === "canceled") &&
        after.updated_at === expectedUpdatedAt(
          before.updated_at,
          receipt.operationAt,
        ) &&
        ["status", "summary", "raw_notes", "questions_json", "reflection"]
          .some((key) => before[key as keyof Interview] !==
            after[key as keyof Interview]);
    }
  }
}

function isCareerCoreWriteReceiptUnchecked(
  value: unknown,
): value is CareerCoreWriteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<CareerCoreWriteReceipt>;
  return exactKeys(value, [
    "purpose", "version", "kind", "operationId", "generationId",
    "generationSequence", "operationAt", "before", "after",
    "projectionSha256",
  ]) && receiptCommonIsValid(receipt) &&
    (receipt.kind === "stage-rename" || receipt.kind === "job-create" ||
      receipt.kind === "job-update" || receipt.kind === "interview-create" ||
      receipt.kind === "interview-update") &&
    isReceiptTransition(receipt as CareerCoreWriteReceipt);
}

export function isCareerCoreWriteReceipt(
  value: unknown,
): value is CareerCoreWriteReceipt {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" &&
      new TextEncoder().encode(encoded).byteLength <= RECEIPT_MAX_JSON_BYTES &&
      isCareerCoreWriteReceiptUnchecked(JSON.parse(encoded) as unknown);
  } catch {
    return false;
  }
}

async function sealReceipt<Receipt extends CareerCoreWriteReceipt>(
  draft: Omit<Receipt, "projectionSha256">,
): Promise<Receipt> {
  const projectionSha256 = await sha256Hex(canonicalJson(draft));
  const receipt = { ...draft, projectionSha256 } as Receipt;
  if (!isCareerCoreWriteReceipt(receipt)) {
    throw coreError("invalid_input", "无法生成有效的核心写入回执。");
  }
  return jsonClone(
    receipt,
    RECEIPT_MAX_JSON_BYTES,
    "核心写入回执",
  ) as Receipt;
}

async function receiptHashIsValid(receipt: CareerCoreWriteReceipt): Promise<boolean> {
  const { projectionSha256, ...projection } = receipt;
  return projectionSha256 === await sha256Hex(canonicalJson(projection));
}

function requiredSingleLine(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (typeof value !== "string") {
    throw coreError("invalid_input", `${label}不能为空。`);
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw coreError("invalid_input", `${label}不能为空。`);
  if (normalized.length > maximum) {
    throw coreError("invalid_input", `${label}过长。`);
  }
  return normalized;
}

function optionalSingleLine(
  value: unknown,
  label: string,
  maximum: number,
  fallback = "",
): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") {
    throw coreError("invalid_input", `${label}格式不正确。`);
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length > maximum) {
    throw coreError("invalid_input", `${label}过长。`);
  }
  return normalized;
}

function multiline(
  value: unknown,
  label: string,
  maximum: number,
  fallback = "",
): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") {
    throw coreError("invalid_input", `${label}格式不正确。`);
  }
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length > maximum) {
    throw coreError("invalid_input", `${label}过长。`);
  }
  return normalized;
}

function optionalUrl(value: unknown, label: string): string {
  const normalized = optionalSingleLine(value, label, 2_048);
  if (!normalized) return "";
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw coreError("invalid_input", `${label}不是有效链接。`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw coreError("invalid_input", `${label}只支持 http 或 https。`);
  }
  return normalized;
}

function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return canonicalTimestamp(value, label);
}

function normalizedPriority(value: unknown): number {
  const priority = value === undefined ? 1 : value;
  if (!isSafeInteger(priority) || priority < 1 || priority > 3) {
    throw coreError("invalid_input", "职位关注级别不受支持。");
  }
  return priority;
}

function normalizedDuration(value: unknown): number {
  const duration = value === undefined ? 45 : value;
  if (!isSafeInteger(duration) || duration < 1 || duration > 1_440) {
    throw coreError("invalid_input", "面试时长不在安全范围内。");
  }
  return duration;
}

function normalizeJobCreate(input: CreateCareerJobCoreInput): Readonly<{
  company: string;
  role: string;
  location: string;
  source: string;
  sourceUrl: string;
  priority: number;
  salary: string;
  workMode: string;
  description: string;
  deadline: string | null;
  note: string;
  tags: string;
}> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw coreError("invalid_input", "职位资料格式不正确。");
  }
  return {
    company: requiredSingleLine(input.company, "公司", 240),
    role: requiredSingleLine(input.role, "职位", 240),
    location: optionalSingleLine(input.location, "地点", 500),
    source: optionalSingleLine(input.source, "来源", 160, "手动记录"),
    sourceUrl: optionalUrl(input.sourceUrl, "原职位链接"),
    priority: normalizedPriority(input.priority),
    salary: optionalSingleLine(input.salary, "薪资", 500),
    workMode: optionalSingleLine(input.workMode, "工作方式", 160),
    description: multiline(input.description, "职位描述", 200_000),
    deadline: optionalTimestamp(input.deadline, "截止时间"),
    note: multiline(input.note, "个人备注", 200_000),
    tags: optionalSingleLine(input.tags, "标签", 2_000),
  };
}

function normalizeJobUpdate(input: UpdateCareerJobCoreInput): Readonly<{
  company: string;
  role: string;
  location: string;
  salary: string;
  workMode: string;
  description: string;
  deadline: string | null;
  note: string;
  tags: string;
}> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw coreError("invalid_input", "职位修改格式不正确。");
  }
  return {
    company: requiredSingleLine(input.company, "公司", 240),
    role: requiredSingleLine(input.role, "职位", 240),
    location: optionalSingleLine(input.location, "地点", 500),
    salary: optionalSingleLine(input.salary, "薪资", 500),
    workMode: optionalSingleLine(input.workMode, "工作方式", 160),
    description: multiline(input.description, "职位描述", 200_000),
    deadline: optionalTimestamp(input.deadline, "截止时间"),
    note: multiline(input.note, "个人备注", 200_000),
    tags: optionalSingleLine(input.tags, "标签", 2_000),
  };
}

function normalizeInterviewCreate(
  input: CreateCareerInterviewCoreInput,
): Readonly<{
  roundName: string;
  interviewType: string;
  scheduledAt: string;
  duration: number;
  interviewer: string;
  meetingUrl: string;
}> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw coreError("invalid_input", "面试日程格式不正确。");
  }
  return {
    roundName: requiredSingleLine(input.roundName, "轮次名称", 240),
    interviewType: optionalSingleLine(
      input.interviewType,
      "面试形式",
      160,
      "视频面试",
    ),
    scheduledAt: canonicalTimestamp(input.scheduledAt, "面试时间"),
    duration: normalizedDuration(input.duration),
    interviewer: optionalSingleLine(input.interviewer, "面试官", 500),
    meetingUrl: optionalUrl(input.meetingUrl, "会议链接"),
  };
}

function normalizeQuestions(value: unknown): InterviewQuestion[] {
  if (!Array.isArray(value) || value.length > 1_000) {
    throw coreError("invalid_input", "面试问题列表格式不正确。");
  }
  return value.map((question, index) => {
    if (!question || typeof question !== "object" || Array.isArray(question)) {
      throw coreError("invalid_input", `第 ${index + 1} 个面试问题格式不正确。`);
    }
    const item = question as Partial<InterviewQuestion>;
    if (!exactKeys(question, ["question", "answer", "note"])) {
      throw coreError("invalid_input", `第 ${index + 1} 个面试问题格式不正确。`);
    }
    return {
      question: multiline(item.question, "面试问题", 20_000),
      answer: multiline(item.answer, "面试回答", 100_000),
      note: multiline(item.note, "问题备注", 100_000),
    };
  });
}

function normalizeInterviewUpdate(
  input: UpdateCareerInterviewCoreInput,
): Readonly<{
  status: Interview["status"];
  summary: string;
  rawNotes: string;
  questionsJson: string;
  reflection: string;
}> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw coreError("invalid_input", "面经修改格式不正确。");
  }
  if (input.status !== "scheduled" && input.status !== "completed" &&
    input.status !== "canceled") {
    throw coreError("invalid_input", "面试状态不受支持。");
  }
  const questionsJson = JSON.stringify(normalizeQuestions(input.questions));
  if (new TextEncoder().encode(questionsJson).byteLength > 500_000) {
    throw coreError("invalid_input", "面试问题列表过长。");
  }
  return {
    status: input.status,
    summary: multiline(input.summary, "面试摘要", 200_000),
    rawNotes: multiline(input.rawNotes, "面试原始笔记", 300_000),
    questionsJson,
    reflection: multiline(input.reflection, "面试复盘", 200_000),
  };
}

function generatedOperationId(runtime: CareerCoreWriteStorageRuntime): string {
  const operationId = `career-core-operation-${runtime.randomUUID()}`;
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw coreError("invalid_input", "无法生成可靠的核心操作标识。");
  }
  return operationId;
}

function generatedEntityId(
  runtime: CareerCoreWriteStorageRuntime,
  prefix: "job" | "activity" | "interview",
): string {
  const entityId = `${prefix}_${runtime.randomUUID()}`;
  if (!GENERATED_ENTITY_ID_PATTERN.test(entityId) ||
    !entityId.startsWith(`${prefix}_`)) {
    throw coreError("invalid_input", "无法生成可靠的资料标识。");
  }
  return entityId;
}

function activeStage(stage: Stage): boolean {
  return stage.is_terminal === 0 && stage.hidden === 0;
}

async function readGeneration(
  runtime: CareerCoreWriteStorageRuntime,
): Promise<CareerCoreGenerationExpectation> {
  const current = await runtime.currentGeneration();
  if (!current || typeof current.generationId !== "string" ||
    !GENERATION_ID_PATTERN.test(current.generationId) ||
    !isSafeInteger(current.sequence) || current.sequence < 0) {
    throw new Error("无法确认当前职迹数据库世代。");
  }
  return {
    generationId: current.generationId,
    generationSequence: current.sequence,
  };
}

function requireExpectedGeneration(
  current: CareerCoreGenerationExpectation,
  expected: CareerCoreGenerationExpectation,
): void {
  if (!sameGeneration(current, expected)) {
    throw coreError("changed", "职迹数据库版本已经更换；没有准备写入。");
  }
}

async function readStage(
  runtime: CareerCoreWriteStorageRuntime,
  id: string,
): Promise<Readonly<Stage> | null> {
  const rows = (await runtime.query<Stage>(
    `SELECT id,name,color,position,is_terminal,hidden
      FROM career_stages WHERE id=? ORDER BY id LIMIT 2`,
    [id],
  )).rows;
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !isStoredStage(rows[0])) {
    throw new Error("阶段存储行不符合 canonical 格式。");
  }
  return { ...rows[0] };
}

async function readJob(
  runtime: CareerCoreWriteStorageRuntime,
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
  if (rows.length !== 1 || !isStoredJob(rows[0])) {
    throw new Error("职位存储行不符合 canonical 格式。");
  }
  return { ...rows[0] };
}

async function readInterview(
  runtime: CareerCoreWriteStorageRuntime,
  id: string,
): Promise<Readonly<Interview> | null> {
  const rows = (await runtime.query<Interview>(
    `SELECT id,job_id,round_name,interview_type,scheduled_at,duration,
      interviewer,meeting_url,status,summary,raw_notes,questions_json,
      reflection,created_at,updated_at,canceled_at,cancellation_reason,
      lifecycle_previous_status,lifecycle_operation_id
      FROM career_interviews WHERE id=? ORDER BY id LIMIT 2`,
    [id],
  )).rows;
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !isStoredInterview(rows[0])) {
    throw new Error("面试存储行不符合 canonical 格式。");
  }
  return { ...rows[0] };
}

async function readOperation(
  runtime: CareerCoreWriteStorageRuntime,
  operationId: string,
): Promise<StoredOperation | null> {
  const rows = (await runtime.query<StoredOperation>(
    `SELECT operation_id,purpose,receipt_version,kind,entity_id,
      projection_sha256,operation_at
      FROM career_core_write_operations
      WHERE operation_id=? ORDER BY operation_id LIMIT 2`,
    [operationId],
  )).rows;
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new Error("核心操作标记不唯一。");
  }
  return { ...rows[0] };
}

async function idIsAbsent(
  runtime: CareerCoreWriteStorageRuntime,
  table: "career_jobs" | "career_activity" | "career_interviews",
  id: string,
): Promise<boolean> {
  const rows = (await runtime.query<{ id: string }>(
    `SELECT id FROM ${table} WHERE id=? ORDER BY id LIMIT 2`,
    [id],
  )).rows;
  return rows.length === 0;
}

function exactOperation(
  operation: StoredOperation,
  receipt: CareerCoreWriteReceipt,
): boolean {
  return operation.operation_id === receipt.operationId &&
    operation.purpose === receipt.purpose &&
    operation.receipt_version === receipt.version &&
    operation.kind === receipt.kind &&
    operation.entity_id === receiptEntityId(receipt) &&
    operation.projection_sha256 === receipt.projectionSha256 &&
    operation.operation_at === receipt.operationAt;
}

function safeBroadcast(
  runtime: CareerCoreWriteStorageRuntime,
  reason: string,
): void {
  try {
    runtime.broadcast(reason);
  } catch {
    // A refresh hint cannot reverse a durable SQLite transaction.
  }
}

type SqlPredicate = Readonly<{
  sql: string;
  params: readonly unknown[];
}>;

function rowPredicate<Row extends object>(
  table: "career_stages" | "career_jobs" | "career_interviews",
  keys: readonly (keyof Row & string)[],
  row: Row,
): SqlPredicate {
  return {
    sql: `EXISTS(SELECT 1 FROM ${table} WHERE ${keys.map((key) =>
      `${key} IS ?`).join(" AND ")})`,
    params: keys.map((key) => row[key]),
  };
}

function stagePredicate(stage: Stage): SqlPredicate {
  return rowPredicate<Stage>("career_stages", STAGE_KEYS, stage);
}

function jobPredicate(job: Job): SqlPredicate {
  return rowPredicate<Job>("career_jobs", JOB_KEYS, job);
}

function interviewPredicate(interview: Interview): SqlPredicate {
  return rowPredicate<Interview>("career_interviews", INTERVIEW_KEYS, interview);
}

function joinedPredicate(predicates: readonly SqlPredicate[]): SqlPredicate {
  return {
    sql: predicates.map((predicate) => `(${predicate.sql})`).join(" AND "),
    params: predicates.flatMap((predicate) => predicate.params),
  };
}

function markerAbsentPredicate(receipt: CareerCoreWriteReceipt): SqlPredicate {
  return {
    sql: "NOT EXISTS(SELECT 1 FROM career_core_write_operations WHERE operation_id=?)",
    params: [receipt.operationId],
  };
}

function idAbsentPredicate(
  table: "career_jobs" | "career_activity" | "career_interviews",
  id: string,
): SqlPredicate {
  return {
    sql: `NOT EXISTS(SELECT 1 FROM ${table} WHERE id=?)`,
    params: [id],
  };
}

function abortUnless(predicate: SqlPredicate): SqlStatement {
  return {
    sql: `INSERT INTO career_core_write_operations(
        operation_id,purpose,receipt_version,kind,entity_id,
        projection_sha256,operation_at
      ) SELECT '__career_core_cas_abort__','career-core-write',1,
        '__invalid_kind__','__abort__',
        '0000000000000000000000000000000000000000000000000000000000000000',
        '__abort__'
      WHERE NOT (${predicate.sql})`,
    params: predicate.params,
  };
}

function markerStatement(receipt: CareerCoreWriteReceipt): SqlStatement {
  return {
    sql: `INSERT INTO career_core_write_operations(
      operation_id,purpose,receipt_version,kind,entity_id,
      projection_sha256,operation_at
    ) VALUES(?,?,?,?,?,?,?)`,
    params: [
      receipt.operationId,
      receipt.purpose,
      receipt.version,
      receipt.kind,
      receiptEntityId(receipt),
      receipt.projectionSha256,
      receipt.operationAt,
    ],
  };
}

function receiptStatements(receipt: CareerCoreWriteReceipt): SqlStatement[] {
  let guard: SqlPredicate;
  let mutation: SqlStatement[];
  switch (receipt.kind) {
    case "stage-rename":
      guard = joinedPredicate([
        markerAbsentPredicate(receipt),
        stagePredicate(receipt.before.stage),
      ]);
      mutation = [{
        sql: "UPDATE career_stages SET name=? WHERE id=?",
        params: [receipt.after.stage.name, receipt.after.stage.id],
      }];
      break;
    case "job-create":
      guard = joinedPredicate([
        markerAbsentPredicate(receipt),
        stagePredicate(receipt.before.stage),
        {
          sql: `EXISTS(SELECT 1 FROM career_stages
            WHERE id=? AND is_terminal=0 AND hidden=0)`,
          params: [receipt.before.stage.id],
        },
        idAbsentPredicate("career_jobs", receipt.before.jobId),
        idAbsentPredicate("career_activity", receipt.before.activityId),
      ]);
      mutation = [
        {
          sql: `INSERT INTO career_jobs(
            id,company,role,location,source,source_url,stage_id,priority,
            salary,work_mode,description,applied_at,deadline,contact_name,
            note,tags,created_at,updated_at,archived,position,archived_at,
            ended_at,archived_operation_id,ended_operation_id
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          params: JOB_KEYS.map((key) => receipt.after.job[key]),
        },
        {
          sql: `INSERT INTO career_activity(id,job_id,type,detail,created_at)
            VALUES(?,?,?,?,?)`,
          params: ACTIVITY_KEYS.map((key) => receipt.after.activity[key]),
        },
      ];
      break;
    case "job-update":
      guard = joinedPredicate([
        markerAbsentPredicate(receipt),
        jobPredicate(receipt.before.job),
        stagePredicate(receipt.before.stage),
        {
          sql: "EXISTS(SELECT 1 FROM career_jobs WHERE id=? AND archived=0)",
          params: [receipt.before.job.id],
        },
      ]);
      mutation = [{
        sql: `UPDATE career_jobs SET company=?,role=?,location=?,salary=?,
          work_mode=?,description=?,deadline=?,note=?,tags=?,updated_at=?
          WHERE id=?`,
        params: [
          receipt.after.job.company,
          receipt.after.job.role,
          receipt.after.job.location,
          receipt.after.job.salary,
          receipt.after.job.work_mode,
          receipt.after.job.description,
          receipt.after.job.deadline,
          receipt.after.job.note,
          receipt.after.job.tags,
          receipt.after.job.updated_at,
          receipt.after.job.id,
        ],
      }];
      break;
    case "interview-create":
      guard = joinedPredicate([
        markerAbsentPredicate(receipt),
        jobPredicate(receipt.before.job),
        stagePredicate(receipt.before.stage),
        {
          sql: `EXISTS(SELECT 1 FROM career_jobs
            WHERE id=? AND archived=0 AND stage_id=?)`,
          params: [receipt.before.job.id, receipt.before.stage.id],
        },
        {
          sql: `EXISTS(SELECT 1 FROM career_stages
            WHERE id=? AND is_terminal=0 AND hidden=0)`,
          params: [receipt.before.stage.id],
        },
        idAbsentPredicate("career_interviews", receipt.before.interviewId),
      ]);
      mutation = [{
        sql: `INSERT INTO career_interviews(
          id,job_id,round_name,interview_type,scheduled_at,duration,
          interviewer,meeting_url,status,summary,raw_notes,questions_json,
          reflection,created_at,updated_at,canceled_at,cancellation_reason,
          lifecycle_previous_status,lifecycle_operation_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: INTERVIEW_KEYS.map((key) => receipt.after.interview[key]),
      }];
      break;
    case "interview-update":
      guard = joinedPredicate([
        markerAbsentPredicate(receipt),
        interviewPredicate(receipt.before.interview),
        jobPredicate(receipt.before.job),
        stagePredicate(receipt.before.stage),
      ]);
      mutation = [{
        sql: `UPDATE career_interviews SET status=?,summary=?,raw_notes=?,
          questions_json=?,reflection=?,updated_at=? WHERE id=?`,
        params: [
          receipt.after.interview.status,
          receipt.after.interview.summary,
          receipt.after.interview.raw_notes,
          receipt.after.interview.questions_json,
          receipt.after.interview.reflection,
          receipt.after.interview.updated_at,
          receipt.after.interview.id,
        ],
      }];
      break;
  }
  return [abortUnless(guard), ...mutation, markerStatement(receipt)];
}

function broadcastReason(kind: CareerCoreWriteKind): string {
  switch (kind) {
    case "stage-rename": return "career-stage-renamed";
    case "job-create": return "career-job-created";
    case "job-update": return "career-job-updated";
    case "interview-create": return "career-interview-created";
    case "interview-update": return "career-interview-updated";
  }
}

export function createCareerCoreWriteStorageService(
  runtime: CareerCoreWriteStorageRuntime = defaultRuntime,
) {
  async function lockedPrepare<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    let entered = false;
    try {
      return await runtime.withExclusiveLock(async () => {
        entered = true;
        return operation();
      });
    } catch (error) {
      if (error instanceof CareerCoreWriteError) throw error;
      if (!entered) {
        throw coreError("lock_unavailable", "无法取得安全的职迹写入锁；没有开始写入。");
      }
      throw coreError("inspect_failed", "暂时无法核对最新职迹资料；没有开始写入。");
    }
  }

  async function loadExpectedSet(): Promise<CareerCoreWriteExpectedSet> {
    return lockedPrepare(async () => {
      const generation = await readGeneration(runtime);
      const [stageResult, jobResult, interviewResult] = await Promise.all([
        runtime.query<Stage>(
          `SELECT id,name,color,position,is_terminal,hidden
            FROM career_stages ORDER BY id`,
        ),
        runtime.query<Job>(
          `SELECT id,company,role,location,source,source_url,stage_id,priority,
            salary,work_mode,description,applied_at,deadline,contact_name,note,
            tags,created_at,updated_at,archived,position,archived_at,ended_at,
            archived_operation_id,ended_operation_id
            FROM career_jobs ORDER BY id`,
        ),
        runtime.query<Interview>(
          `SELECT id,job_id,round_name,interview_type,scheduled_at,duration,
            interviewer,meeting_url,status,summary,raw_notes,questions_json,
            reflection,created_at,updated_at,canceled_at,cancellation_reason,
            lifecycle_previous_status,lifecycle_operation_id
            FROM career_interviews ORDER BY id`,
        ),
      ]);
      if (!stageResult.rows.every(isStoredStage) ||
        !jobResult.rows.every(isStoredJob) ||
        !interviewResult.rows.every(isStoredInterview)) {
        throw new Error("核心职迹存储行不符合 canonical 格式。");
      }
      const set: CareerCoreWriteExpectedSet = {
        ...generation,
        stages: stageResult.rows.map((row) => ({ ...row })),
        jobs: jobResult.rows.map((row) => ({ ...row })),
        interviews: interviewResult.rows.map((row) => ({ ...row })),
      };
      const cloned = jsonClone(
        set,
        EXPECTED_SET_MAX_JSON_BYTES,
        "职迹核心读取快照",
      );
      if (!isExpectedSet(cloned)) {
        throw new Error("无法构造可信的职迹核心读取快照。");
      }
      return cloned;
    });
  }

  async function prepareStageRename(
    nameValue: string,
    expectedValue: CareerStageWriteExpectedState,
  ): Promise<CareerStageRenameReceipt> {
    const name = requiredSingleLine(nameValue, "阶段名称", 160);
    const expected = cloneChecked(expectedValue, isStageExpected, "阶段读取快照");
    if (name === expected.stage.name) {
      throw coreError("invalid_input", "阶段名称没有变化。");
    }
    return lockedPrepare(async () => {
      const generation = await readGeneration(runtime);
      requireExpectedGeneration(generation, expected);
      const stage = await readStage(runtime, expected.stage.id);
      if (!stage || !sameProjection(stage, expected.stage)) {
        throw coreError("changed", "阶段已在别处变化；没有准备写入。");
      }
      const operationId = generatedOperationId(runtime);
      if (await readOperation(runtime, operationId)) {
        throw coreError("changed", "新的操作标识已被占用；没有准备写入。");
      }
      const { timestamp: operationAt } = operationClock(runtime);
      const before: CareerStageWriteExpectedState = { ...generation, stage };
      const after: CareerStageWriteExpectedState = {
        ...generation,
        stage: { ...stage, name },
      };
      return sealReceipt<CareerStageRenameReceipt>({
        purpose: RECEIPT_PURPOSE,
        version: RECEIPT_VERSION,
        kind: "stage-rename",
        operationId,
        ...generation,
        operationAt,
        before,
        after,
      });
    });
  }

  async function prepareJobCreate(
    inputValue: CreateCareerJobCoreInput,
    expectedValue: CareerStageWriteExpectedState,
  ): Promise<CareerJobCreateReceipt> {
    const input = normalizeJobCreate(inputValue);
    const expected = cloneChecked(expectedValue, isStageExpected, "阶段读取快照");
    if (!activeStage(expected.stage)) {
      throw coreError("invalid_input", "只能在仍可推进的阶段记录新职位。");
    }
    return lockedPrepare(async () => {
      const generation = await readGeneration(runtime);
      requireExpectedGeneration(generation, expected);
      const stage = await readStage(runtime, expected.stage.id);
      if (!stage || !sameProjection(stage, expected.stage) || !activeStage(stage)) {
        throw coreError("changed", "所选阶段已变化或不再可用；没有准备写入。");
      }
      const operationId = generatedOperationId(runtime);
      const jobId = generatedEntityId(runtime, "job");
      const activityId = generatedEntityId(runtime, "activity");
      const [operation, jobAbsent, activityAbsent] = await Promise.all([
        readOperation(runtime, operationId),
        idIsAbsent(runtime, "career_jobs", jobId),
        idIsAbsent(runtime, "career_activity", activityId),
      ]);
      if (operation || !jobAbsent || !activityAbsent) {
        throw coreError("changed", "新的职位操作标识已被占用；没有准备写入。");
      }
      const { timestamp: operationAt } = operationClock(runtime);
      const job: Job = {
        id: jobId,
        company: input.company,
        role: input.role,
        location: input.location,
        source: input.source,
        source_url: input.sourceUrl,
        stage_id: stage.id,
        priority: input.priority,
        salary: input.salary,
        work_mode: input.workMode,
        description: input.description,
        applied_at: stage.id === "stage_applied" ? operationAt : null,
        deadline: input.deadline,
        contact_name: "",
        note: input.note,
        tags: input.tags,
        created_at: operationAt,
        updated_at: operationAt,
        archived: 0,
        position: 0,
        archived_at: null,
        ended_at: null,
        archived_operation_id: null,
        ended_operation_id: null,
      };
      const activity: Activity = {
        id: activityId,
        job_id: jobId,
        type: "create",
        detail: `记录了 ${job.company} · ${job.role}`,
        created_at: operationAt,
      };
      return sealReceipt<CareerJobCreateReceipt>({
        purpose: RECEIPT_PURPOSE,
        version: RECEIPT_VERSION,
        kind: "job-create",
        operationId,
        ...generation,
        operationAt,
        before: { ...generation, stage, jobId, activityId },
        after: { ...generation, stage, job, activity },
      });
    });
  }

  async function prepareJobUpdate(
    inputValue: UpdateCareerJobCoreInput,
    expectedValue: CareerJobWriteExpectedState,
  ): Promise<CareerJobUpdateReceipt> {
    const input = normalizeJobUpdate(inputValue);
    const expected = cloneChecked(expectedValue, isJobExpected, "职位读取快照");
    if (expected.job.archived !== 0) {
      throw coreError("invalid_input", "已归档职位不能从普通编辑入口修改。");
    }
    return lockedPrepare(async () => {
      const generation = await readGeneration(runtime);
      requireExpectedGeneration(generation, expected);
      const [job, stage] = await Promise.all([
        readJob(runtime, expected.job.id),
        readStage(runtime, expected.stage.id),
      ]);
      if (!job || !stage || job.archived !== 0 ||
        !sameProjection(job, expected.job) ||
        !sameProjection(stage, expected.stage)) {
        throw coreError("changed", "职位或显示阶段已在别处变化；没有准备写入。");
      }
      const candidate = {
        company: input.company,
        role: input.role,
        location: input.location,
        salary: input.salary,
        work_mode: input.workMode,
        description: input.description,
        deadline: input.deadline,
        note: input.note,
        tags: input.tags,
      };
      const unchanged = Object.entries(candidate).every(([key, value]) =>
        job[key as keyof typeof candidate] === value);
      if (unchanged) {
        throw coreError("invalid_input", "职位资料没有变化。");
      }
      const operationId = generatedOperationId(runtime);
      if (await readOperation(runtime, operationId)) {
        throw coreError("changed", "新的操作标识已被占用；没有准备写入。");
      }
      const operation = operationClock(runtime);
      const operationAt = operation.timestamp;
      const updatedAt = nextTimestamp(job.updated_at, operation.milliseconds, "职位");
      const before: CareerJobWriteExpectedState = { ...generation, job, stage };
      const after: CareerJobWriteExpectedState = {
        ...generation,
        job: { ...job, ...candidate, updated_at: updatedAt },
        stage,
      };
      return sealReceipt<CareerJobUpdateReceipt>({
        purpose: RECEIPT_PURPOSE,
        version: RECEIPT_VERSION,
        kind: "job-update",
        operationId,
        ...generation,
        operationAt,
        before,
        after,
      });
    });
  }

  async function prepareInterviewCreate(
    inputValue: CreateCareerInterviewCoreInput,
    expectedValue: CareerJobWriteExpectedState,
  ): Promise<CareerInterviewCreateReceipt> {
    const input = normalizeInterviewCreate(inputValue);
    const expected = cloneChecked(expectedValue, isJobExpected, "职位读取快照");
    if (expected.job.archived !== 0 || !activeStage(expected.stage)) {
      throw coreError("invalid_input", "只能为仍在推进的职位安排面试。");
    }
    return lockedPrepare(async () => {
      const generation = await readGeneration(runtime);
      requireExpectedGeneration(generation, expected);
      const [job, stage] = await Promise.all([
        readJob(runtime, expected.job.id),
        readStage(runtime, expected.stage.id),
      ]);
      if (!job || !stage || job.archived !== 0 || !activeStage(stage) ||
        !sameProjection(job, expected.job) ||
        !sameProjection(stage, expected.stage)) {
        throw coreError("changed", "职位或阶段已变化，不再适合创建面试；没有准备写入。");
      }
      const operationId = generatedOperationId(runtime);
      const interviewId = generatedEntityId(runtime, "interview");
      const [operation, interviewAbsent] = await Promise.all([
        readOperation(runtime, operationId),
        idIsAbsent(runtime, "career_interviews", interviewId),
      ]);
      if (operation || !interviewAbsent) {
        throw coreError("changed", "新的面试操作标识已被占用；没有准备写入。");
      }
      const { timestamp: operationAt } = operationClock(runtime);
      const interview: Interview = {
        id: interviewId,
        job_id: job.id,
        round_name: input.roundName,
        interview_type: input.interviewType,
        scheduled_at: input.scheduledAt,
        duration: input.duration,
        interviewer: input.interviewer,
        meeting_url: input.meetingUrl,
        status: "scheduled",
        summary: "",
        raw_notes: "",
        questions_json: "[]",
        reflection: "",
        created_at: operationAt,
        updated_at: operationAt,
        canceled_at: null,
        cancellation_reason: null,
        lifecycle_previous_status: null,
        lifecycle_operation_id: null,
      };
      return sealReceipt<CareerInterviewCreateReceipt>({
        purpose: RECEIPT_PURPOSE,
        version: RECEIPT_VERSION,
        kind: "interview-create",
        operationId,
        ...generation,
        operationAt,
        before: { ...generation, job, stage, interviewId },
        after: { ...generation, job, stage, interview },
      });
    });
  }

  async function prepareInterviewUpdate(
    inputValue: UpdateCareerInterviewCoreInput,
    expectedValue: CareerInterviewWriteExpectedState,
  ): Promise<CareerInterviewUpdateReceipt> {
    const input = normalizeInterviewUpdate(inputValue);
    const expected = cloneChecked(
      expectedValue,
      isInterviewExpected,
      "面试读取快照",
    );
    if (expected.interview.lifecycle_operation_id !== null &&
      input.status !== "canceled") {
      throw coreError(
        "invalid_input",
        "这轮面试仍由职位生命周期暂停，不能从普通编辑入口恢复。",
      );
    }
    return lockedPrepare(async () => {
      const generation = await readGeneration(runtime);
      requireExpectedGeneration(generation, expected);
      const [interview, job, stage] = await Promise.all([
        readInterview(runtime, expected.interview.id),
        readJob(runtime, expected.job.id),
        readStage(runtime, expected.stage.id),
      ]);
      if (!interview || !job || !stage ||
        !sameProjection(interview, expected.interview) ||
        !sameProjection(job, expected.job) ||
        !sameProjection(stage, expected.stage)) {
        throw coreError(
          "changed",
          "面试、父职位或显示阶段已在别处变化；没有准备写入。",
        );
      }
      if (interview.lifecycle_operation_id !== null &&
        input.status !== "canceled") {
        throw coreError("changed", "这轮面试仍随职位暂停；没有准备普通恢复。");
      }
      const candidate = {
        status: input.status,
        summary: input.summary,
        raw_notes: input.rawNotes,
        questions_json: input.questionsJson,
        reflection: input.reflection,
      };
      const unchanged = Object.entries(candidate).every(([key, value]) =>
        interview[key as keyof typeof candidate] === value);
      if (unchanged) {
        throw coreError("invalid_input", "面经资料没有变化。");
      }
      const operationId = generatedOperationId(runtime);
      if (await readOperation(runtime, operationId)) {
        throw coreError("changed", "新的操作标识已被占用；没有准备写入。");
      }
      const operation = operationClock(runtime);
      const operationAt = operation.timestamp;
      const updatedAt = nextTimestamp(
        interview.updated_at,
        operation.milliseconds,
        "面试",
      );
      const before: CareerInterviewWriteExpectedState = {
        ...generation,
        interview,
        job,
        stage,
      };
      const after: CareerInterviewWriteExpectedState = {
        ...generation,
        interview: {
          ...interview,
          ...candidate,
          updated_at: updatedAt,
          // These facts belong exclusively to lifecycle.ts. Keeping them
          // explicit makes accidental clearing fail receipt validation too.
          canceled_at: interview.canceled_at,
          cancellation_reason: interview.cancellation_reason,
          lifecycle_previous_status: interview.lifecycle_previous_status,
          lifecycle_operation_id: interview.lifecycle_operation_id,
        },
        job,
        stage,
      };
      return sealReceipt<CareerInterviewUpdateReceipt>({
        purpose: RECEIPT_PURPOSE,
        version: RECEIPT_VERSION,
        kind: "interview-update",
        operationId,
        ...generation,
        operationAt,
        before,
        after,
      });
    });
  }

  async function receiptStateUnlocked(
    receipt: CareerCoreWriteReceipt,
  ): Promise<Exclude<
    CareerCoreWriteInspection,
    "still_unknown" | "invalid_receipt"
  >> {
    const generation = await readGeneration(runtime);
    if (!sameGeneration(generation, receipt)) return "changed";
    const operation = await readOperation(runtime, receipt.operationId);
    if (operation) return exactOperation(operation, receipt)
      ? "exact_saved"
      : "changed";

    switch (receipt.kind) {
      case "stage-rename": {
        const stage = await readStage(runtime, receipt.before.stage.id);
        return stage && sameProjection(stage, receipt.before.stage)
          ? "expected"
          : "changed";
      }
      case "job-create": {
        const [stage, jobAbsent, activityAbsent] = await Promise.all([
          readStage(runtime, receipt.before.stage.id),
          idIsAbsent(runtime, "career_jobs", receipt.before.jobId),
          idIsAbsent(runtime, "career_activity", receipt.before.activityId),
        ]);
        return stage && activeStage(stage) &&
          sameProjection(stage, receipt.before.stage) &&
          jobAbsent && activityAbsent
          ? "expected"
          : "changed";
      }
      case "job-update": {
        const [job, stage] = await Promise.all([
          readJob(runtime, receipt.before.job.id),
          readStage(runtime, receipt.before.stage.id),
        ]);
        return job && stage && job.archived === 0 &&
          sameProjection(job, receipt.before.job) &&
          sameProjection(stage, receipt.before.stage)
          ? "expected"
          : "changed";
      }
      case "interview-create": {
        const [job, stage, interviewAbsent] = await Promise.all([
          readJob(runtime, receipt.before.job.id),
          readStage(runtime, receipt.before.stage.id),
          idIsAbsent(runtime, "career_interviews", receipt.before.interviewId),
        ]);
        return job && stage && interviewAbsent && job.archived === 0 &&
          activeStage(stage) && sameProjection(job, receipt.before.job) &&
          sameProjection(stage, receipt.before.stage)
          ? "expected"
          : "changed";
      }
      case "interview-update": {
        const [interview, job, stage] = await Promise.all([
          readInterview(runtime, receipt.before.interview.id),
          readJob(runtime, receipt.before.job.id),
          readStage(runtime, receipt.before.stage.id),
        ]);
        return interview && job && stage &&
          sameProjection(interview, receipt.before.interview) &&
          sameProjection(job, receipt.before.job) &&
          sameProjection(stage, receipt.before.stage)
          ? "expected"
          : "changed";
      }
    }
  }

  async function inspectWrite(value: unknown): Promise<CareerCoreWriteInspection> {
    let receipt: CareerCoreWriteReceipt;
    try {
      const cloned = jsonClone(value, RECEIPT_MAX_JSON_BYTES, "核心写入回执");
      if (!isCareerCoreWriteReceipt(cloned)) return "invalid_receipt";
      receipt = cloned;
      if (!await receiptHashIsValid(receipt)) return "invalid_receipt";
    } catch (error) {
      if (error instanceof CareerCoreWriteError && error.code === "invalid_input") {
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

  async function commitWrite(value: unknown): Promise<CareerCoreWriteResult> {
    let receipt: CareerCoreWriteReceipt;
    try {
      const cloned = jsonClone(value, RECEIPT_MAX_JSON_BYTES, "核心写入回执");
      if (!isCareerCoreWriteReceipt(cloned)) {
        throw coreError("invalid_receipt", "核心写入回执无效；没有改动资料。");
      }
      receipt = cloned;
      if (!await receiptHashIsValid(receipt)) {
        throw coreError("invalid_receipt", "核心写入回执无法验证；没有改动资料。");
      }
    } catch (error) {
      if (error instanceof CareerCoreWriteError && error.code === "invalid_receipt") {
        throw error;
      }
      throw coreError("invalid_receipt", "核心写入回执无法验证；没有改动资料。");
    }

    const entityId = receiptEntityId(receipt);
    let entered = false;
    try {
      return await runtime.withExclusiveLock(async () => {
        entered = true;
        const before = await receiptStateUnlocked(receipt);
        if (before === "exact_saved") {
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
          safeBroadcast(runtime, broadcastReason(receipt.kind));
          return { outcome: "saved", receipt, entityId };
        }
        if (after === "expected") {
          throw coreError(
            "write_failed",
            "这次写入确定没有提交；保留原回执后可以重试。",
            receipt,
          );
        }
        return { outcome: "changed", receipt, entityId, retryable: false };
      });
    } catch (error) {
      if (error instanceof CareerCoreWriteError) throw error;
      if (!entered) {
        throw coreError("lock_unavailable", "无法取得安全的职迹写入锁；没有开始写入。");
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
    loadCareerCoreWriteExpectedSet: loadExpectedSet,
    prepareCareerStageRename: prepareStageRename,
    prepareCareerJobCreate: prepareJobCreate,
    prepareCareerJobUpdate: prepareJobUpdate,
    prepareCareerInterviewCreate: prepareInterviewCreate,
    prepareCareerInterviewUpdate: prepareInterviewUpdate,
    inspectCareerCoreWrite: inspectWrite,
    commitCareerCoreWrite: commitWrite,
  } as const;
}

function isExpectedSet(value: unknown): value is CareerCoreWriteExpectedSet {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const set = value as Partial<CareerCoreWriteExpectedSet>;
  if (!exactKeys(value, [
    "generationId", "generationSequence", "stages", "jobs", "interviews",
  ]) || !isGeneration({
    generationId: set.generationId,
    generationSequence: set.generationSequence,
  }) || !Array.isArray(set.stages) || !Array.isArray(set.jobs) ||
    !Array.isArray(set.interviews) || !set.stages.every(isStoredStage) ||
    !set.jobs.every(isStoredJob) || !set.interviews.every(isStoredInterview)) {
    return false;
  }
  const sortedUnique = (rows: readonly Readonly<{ id: string }>[]) =>
    rows.every((row, index) => index === 0 || rows[index - 1].id < row.id);
  if (!sortedUnique(set.stages) || !sortedUnique(set.jobs) ||
    !sortedUnique(set.interviews)) return false;
  const stageIds = new Set(set.stages.map(({ id }) => id));
  const jobIds = new Set(set.jobs.map(({ id }) => id));
  return set.jobs.every(({ stage_id }) => stageIds.has(stage_id)) &&
    set.interviews.every(({ job_id }) => jobIds.has(job_id));
}

const defaultService = createCareerCoreWriteStorageService();

export const loadCareerCoreWriteExpectedSet =
  defaultService.loadCareerCoreWriteExpectedSet;
export const prepareCareerStageRename = defaultService.prepareCareerStageRename;
export const prepareCareerJobCreate = defaultService.prepareCareerJobCreate;
export const prepareCareerJobUpdate = defaultService.prepareCareerJobUpdate;
export const prepareCareerInterviewCreate =
  defaultService.prepareCareerInterviewCreate;
export const prepareCareerInterviewUpdate =
  defaultService.prepareCareerInterviewUpdate;
export const inspectCareerCoreWrite = defaultService.inspectCareerCoreWrite;
export const commitCareerCoreWrite = defaultService.commitCareerCoreWrite;
