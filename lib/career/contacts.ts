import { localDb } from "@/lib/local-db/client";
import type { SqlStatement } from "@/lib/local-db/types";
import {
  createCareerContactArchiveStatements,
  createCareerContactInsertStatements,
  createCareerContactInteractionStatements,
  createCareerContactTaskStatements,
  createCareerContactUpdateStatements,
  type PlannedContactExpectedState,
} from "./contact-plan";
import { newId, runCareerBatch } from "./db";
import {
  broadcastCareerDataChanged,
  withCareerReadLock,
  withCareerWriteLock,
  type CareerLockContext,
} from "./lock";
import type {
  CareerContactDetail,
  Contact,
  ContactInteraction,
  ContactJobAssociation,
  Job,
  Task,
} from "./types";

export type {
  CareerContactDetail,
  Contact,
  ContactInteraction,
  ContactJobAssociation,
} from "./types";

export type CareerContactScope = "active" | "archived" | "all";

export type CreateCareerContactInput = Readonly<{
  name: string;
  company?: string;
  role?: string;
  channel?: string;
  email?: string;
  phone?: string;
  notes?: string;
  jobIds?: readonly string[];
  /** Compatibility only. New UI code should use createCareerContactSafely. */
  contactId?: string;
  createdAt?: string;
}>;

export type UpdateCareerContactInput = Readonly<{
  name?: string;
  company?: string;
  role?: string;
  channel?: string;
  email?: string;
  phone?: string;
  notes?: string;
  /** When present, replaces the complete explicit job association set. */
  jobIds?: readonly string[];
}>;

export type CareerContactFollowUpInput = Readonly<{
  title: string;
  dueAt?: string | null;
  kind?: string;
  priority?: number;
  jobId?: string | null;
  /** Compatibility only. The safe API requires this stable id. */
  taskId?: string;
}>;

export type RecordCareerContactInteractionInput = Readonly<{
  contactId: string;
  occurredAt?: string;
  interactionType?: string;
  direction?: "outbound" | "inbound" | "mutual";
  channel?: string;
  summary: string;
  notes?: string;
  jobId?: string | null;
  associatedJobIds?: readonly string[];
  followUp?: CareerContactFollowUpInput;
  /** Compatibility only. The safe API requires stable command identity. */
  interactionId?: string;
  createdAt?: string;
}>;

export type RecordCareerContactInteractionResult = Readonly<{
  interactionId: string;
  taskId: string | null;
}>;

export type CreateCareerContactTaskInput = Readonly<{
  contactId: string;
  title: string;
  dueAt?: string | null;
  kind?: string;
  priority?: number;
  jobId?: string | null;
  /** Compatibility only. The safe API requires stable command identity. */
  taskId?: string;
  createdAt?: string;
}>;

export type CareerContactExpectedState = Readonly<{
  expectedUpdatedAt: string;
  expectedArchived: boolean;
  /** Complete association set visible when the command was created. */
  expectedJobIds: readonly string[];
}>;

export type CreateCareerContactSafeInput = Omit<
  CreateCareerContactInput,
  "contactId" | "createdAt"
> & Readonly<{
  /** Generate once when the form opens and reuse for every retry. */
  contactId: string;
  createdAt: string;
}>;

export type RecordCareerContactInteractionSafeInput = Omit<
  RecordCareerContactInteractionInput,
  "interactionId" | "createdAt" | "direction" | "followUp"
> & Readonly<{
  /** Generate once when the form opens and reuse for every retry. */
  interactionId: string;
  createdAt: string;
  /** Direction is a fact. Omission is rejected instead of inferred. */
  direction: "outbound" | "inbound" | "mutual";
  expectedContact: CareerContactExpectedState;
  followUp?: Omit<CareerContactFollowUpInput, "taskId"> & Readonly<{
    taskId: string;
  }>;
}>;

export type CreateCareerContactTaskSafeInput = Omit<
  CreateCareerContactTaskInput,
  "taskId" | "createdAt"
> & Readonly<{
  /** Generate once when the form opens and reuse for every retry. */
  taskId: string;
  createdAt: string;
  expectedContact: CareerContactExpectedState;
}>;

export type CareerContactCasOptions = CareerContactExpectedState;

export type CareerContactCreateExpectedSnapshot = Readonly<{
  contactId: string;
  name: string;
  company: string;
  role: string;
  channel: string;
  email: string;
  phone: string;
  notes: string;
  createdAt: string;
  jobIds: readonly string[];
}>;

export type CareerContactInteractionExpectedSnapshot = Readonly<{
  interactionId: string;
  contactId: string;
  jobId: string | null;
  interactionType: string;
  direction: "outbound" | "inbound" | "mutual";
  channel: string;
  summary: string;
  notes: string;
  occurredAt: string;
  createdAt: string;
  associationJobIds: readonly string[];
  contactUpdatedAt: string;
  followUp: Readonly<{
    taskId: string;
    title: string;
    dueAt: string | null;
    kind: string;
    priority: number;
    jobId: string | null;
  }> | null;
}>;

export type CareerContactTaskExpectedSnapshot = Readonly<{
  taskId: string;
  contactId: string;
  title: string;
  dueAt: string | null;
  kind: string;
  priority: number;
  jobId: string | null;
  createdAt: string;
  associationJobIds: readonly string[];
  contactUpdatedAt: string;
}>;

export type CareerContactWriteReceipt =
  | Readonly<{
      purpose: "career-contact-write";
      version: 1;
      kind: "contact";
      expected: CareerContactCreateExpectedSnapshot;
    }>
  | Readonly<{
      purpose: "career-contact-write";
      version: 1;
      kind: "interaction";
      expected: CareerContactInteractionExpectedSnapshot;
    }>
  | Readonly<{
      purpose: "career-contact-write";
      version: 1;
      kind: "task";
      expected: CareerContactTaskExpectedSnapshot;
    }>;

export type CareerContactWriteInspection =
  | "exact_saved"
  | "absent"
  | "conflict"
  | "still_unknown";

type CertainOutcome = "saved" | "already_saved";

export type CareerContactCreateSafeResult =
  | Readonly<{ outcome: CertainOutcome; contactId: string }>
  | Readonly<{
      outcome: "outcome_uncertain";
      contactId: string;
      receipt: Extract<CareerContactWriteReceipt, { kind: "contact" }>;
      retryable: true;
    }>;

export type CareerContactInteractionSafeResult =
  | Readonly<{
      outcome: CertainOutcome;
      interactionId: string;
      taskId: string | null;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      interactionId: string;
      taskId: string | null;
      receipt: Extract<CareerContactWriteReceipt, { kind: "interaction" }>;
      retryable: true;
    }>;

export type CareerContactTaskSafeResult =
  | Readonly<{ outcome: CertainOutcome; taskId: string }>
  | Readonly<{
      outcome: "outcome_uncertain";
      taskId: string;
      receipt: Extract<CareerContactWriteReceipt, { kind: "task" }>;
      retryable: true;
    }>;

export type CareerContactCasResult =
  | Readonly<{
      outcome: "saved" | "already_saved";
      contactId: string;
      updatedAt: string;
    }>
  | Readonly<{ outcome: "changed"; contactId: string; retryable: false }>
  | Readonly<{
      outcome: "outcome_uncertain";
      contactId: string;
      retryable: true;
    }>;

export type CareerContactMutationErrorCode =
  | "invalid_input"
  | "conflict"
  | "changed"
  | "inspect_failed"
  | "write_failed"
  | "outcome_uncertain";

export class CareerContactMutationError extends Error {
  readonly name = "CareerContactMutationError";

  constructor(
    readonly code: CareerContactMutationErrorCode,
    message: string,
    readonly receipt?: CareerContactWriteReceipt,
  ) {
    super(message);
  }
}

type QueryResult<Row extends object> = Readonly<{ rows: readonly Row[] }>;
type BatchResult = Readonly<{ changes: number }>;

export type CareerContactStorageRuntime = Readonly<{
  withExclusiveLock<Result>(
    operation: (context?: CareerLockContext) => Promise<Result>,
  ): Promise<Result>;
  query<Row extends object>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  batch(
    statements: readonly SqlStatement[],
    context?: CareerLockContext,
  ): Promise<BatchResult>;
  /** Trusted service clock. Tests may inject it; UI callers cannot. */
  now(): number;
  broadcast(reason: string): void;
}>;

type StoredContact = Readonly<{
  id: string;
  company: string;
  name: string;
  role: string;
  channel: string;
  email: string;
  phone: string;
  last_contact_at: string | null;
  next_follow_up: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
  archived: number;
}>;

type StoredInteraction = Readonly<{
  id: string;
  contact_id: string;
  job_id: string | null;
  interaction_type: string;
  direction: string;
  channel: string;
  summary: string;
  notes: string;
  occurred_at: string;
  created_at: string;
}>;

type StoredTask = Readonly<{
  id: string;
  job_id: string | null;
  contact_id: string | null;
  title: string;
  due_at: string | null;
  kind: string;
  priority: number;
  status: string;
  created_at: string;
  updated_at: string | null;
}>;

type NormalizedExpectedState = Readonly<{
  expectedUpdatedAt: string;
  expectedArchived: boolean;
  expectedJobIds: readonly string[];
}>;

const DB = "career" as const;
const RECEIPT_PURPOSE = "career-contact-write" as const;
const RECEIPT_VERSION = 1 as const;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_LIMITS = {
  name: 160,
  company: 240,
  role: 240,
  channel: 80,
  email: 320,
  phone: 80,
  notes: 20_000,
} as const;

const defaultRuntime: CareerContactStorageRuntime = {
  withExclusiveLock: (operation) =>
    withCareerWriteLock((context) => operation(context)),
  query: <Row extends object>(sql: string, params?: readonly unknown[]) =>
    localDb.query<Row>(DB, sql, params),
  batch: (statements, context) => runCareerBatch(statements, context),
  now: () => Date.now(),
  broadcast: (reason) => broadcastCareerDataChanged(reason),
};

function unwrapRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
}

function mutationError(
  code: CareerContactMutationErrorCode,
  message: string,
  receipt?: CareerContactWriteReceipt,
): CareerContactMutationError {
  return new CareerContactMutationError(code, message, receipt);
}

function requiredText(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string") {
    throw mutationError("invalid_input", `${label}不能为空`);
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw mutationError("invalid_input", `${label}不能为空`);
  if (normalized.length > maximum) {
    throw mutationError("invalid_input", `${label}过长`);
  }
  return normalized;
}

function optionalSingleLine(value: unknown, label: string, maximum: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw mutationError("invalid_input", `${label}格式不正确`);
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length > maximum) {
    throw mutationError("invalid_input", `${label}过长`);
  }
  return normalized;
}

function optionalNotes(value: unknown, label: string, maximum: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw mutationError("invalid_input", `${label}格式不正确`);
  }
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length > maximum) {
    throw mutationError("invalid_input", `${label}过长`);
  }
  return normalized;
}

function canonicalDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw mutationError("invalid_input", `${label}不是有效时间`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw mutationError("invalid_input", `${label}不是有效时间`);
  }
  return new Date(milliseconds).toISOString();
}

function optionalDate(value: unknown, label: string): string | null {
  return value === undefined || value === null || value === ""
    ? null
    : canonicalDate(value, label);
}

function priority(value: unknown): number {
  const normalized = value ?? 1;
  if (!Number.isInteger(normalized) || Number(normalized) < 1 || Number(normalized) > 3) {
    throw mutationError("invalid_input", "优先级需要是 1 到 3 的整数");
  }
  return Number(normalized);
}

function databaseId(value: unknown, label: string): string {
  return requiredText(value, label, 240);
}

function entityId(value: unknown, prefix: "contact" | "interaction" | "task"): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw mutationError("invalid_input", `${prefix} 标识无效`);
  }
  const uuid = value.startsWith(`${prefix}_`)
    ? value.slice(prefix.length + 1)
    : value;
  if (!UUID_V4_PATTERN.test(uuid)) {
    throw mutationError("invalid_input", `${prefix} 标识无效`);
  }
  return value;
}

function uniqueJobIds(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    throw mutationError("invalid_input", "岗位关联需要是数组");
  }
  return [...new Set(values.map((value) => databaseId(value, "岗位 ID")))].sort();
}

function unionJobIds(...sets: readonly (readonly string[])[]): string[] {
  return [...new Set(sets.flat())].sort();
}

function sameJobIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function nextVersion(expectedUpdatedAt: string, commandAtMilliseconds: number): string {
  const expected = Date.parse(expectedUpdatedAt);
  if (!Number.isFinite(expected) || !Number.isFinite(commandAtMilliseconds)) {
    throw mutationError("invalid_input", "联系人版本时间无效");
  }
  return new Date(Math.max(commandAtMilliseconds, expected + 1)).toISOString();
}

function normalizeExpectedState(
  input: CareerContactExpectedState,
): NormalizedExpectedState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw mutationError("invalid_input", "联系人版本信息无效");
  }
  if (typeof input.expectedArchived !== "boolean") {
    throw mutationError("invalid_input", "联系人归档状态无效");
  }
  return {
    expectedUpdatedAt: canonicalDate(input.expectedUpdatedAt, "联系人版本时间"),
    expectedArchived: input.expectedArchived,
    expectedJobIds: uniqueJobIds(input.expectedJobIds),
  };
}

function plannedExpected(
  expected: NormalizedExpectedState,
): PlannedContactExpectedState {
  return {
    updatedAt: expected.expectedUpdatedAt,
    archived: expected.expectedArchived,
    jobIds: expected.expectedJobIds,
  };
}

function normalizeCreate(
  input: CreateCareerContactSafeInput,
): CareerContactCreateExpectedSnapshot {
  return {
    contactId: entityId(input.contactId, "contact"),
    name: requiredText(input.name, "姓名", PROFILE_LIMITS.name),
    company: optionalSingleLine(input.company, "公司", PROFILE_LIMITS.company),
    role: optionalSingleLine(input.role, "角色", PROFILE_LIMITS.role),
    channel: optionalSingleLine(input.channel, "渠道", PROFILE_LIMITS.channel),
    email: optionalSingleLine(input.email, "邮箱", PROFILE_LIMITS.email),
    phone: optionalSingleLine(input.phone, "电话", PROFILE_LIMITS.phone),
    notes: optionalNotes(input.notes, "备注", PROFILE_LIMITS.notes),
    createdAt: canonicalDate(input.createdAt, "创建时间"),
    jobIds: uniqueJobIds(input.jobIds),
  };
}

function normalizeDirection(
  value: unknown,
): "outbound" | "inbound" | "mutual" {
  if (value !== "outbound" && value !== "inbound" && value !== "mutual") {
    throw mutationError(
      "invalid_input",
      "请明确选择这次联系的方向；系统不会代替你推断。",
    );
  }
  return value;
}

function normalizeInteraction(input: RecordCareerContactInteractionSafeInput): {
  expectedContact: NormalizedExpectedState;
  snapshot: CareerContactInteractionExpectedSnapshot;
  addedJobIds: readonly string[];
} {
  const expectedContact = normalizeExpectedState(input.expectedContact);
  if (expectedContact.expectedArchived) {
    throw mutationError("changed", "联系人已经归档，没有写入新的联系记录。");
  }
  const interactionId = entityId(input.interactionId, "interaction");
  const contactId = databaseId(input.contactId, "联系人 ID");
  const createdAt = canonicalDate(input.createdAt, "创建时间");
  const jobId = input.jobId ? databaseId(input.jobId, "岗位 ID") : null;
  const followUpJobId = input.followUp?.jobId
    ? databaseId(input.followUp.jobId, "跟进任务岗位 ID")
    : null;
  const addedJobIds = unionJobIds(
    uniqueJobIds(input.associatedJobIds),
    jobId ? [jobId] : [],
    followUpJobId ? [followUpJobId] : [],
  );
  const followUp = input.followUp
    ? {
        taskId: entityId(input.followUp.taskId, "task"),
        title: requiredText(input.followUp.title, "跟进任务", 500),
        dueAt: optionalDate(input.followUp.dueAt, "跟进时间"),
        kind: optionalSingleLine(input.followUp.kind ?? "跟进", "任务类型", 80),
        priority: priority(input.followUp.priority),
        jobId: followUpJobId ?? jobId,
      }
    : null;
  return {
    expectedContact,
    addedJobIds,
    snapshot: {
      interactionId,
      contactId,
      jobId,
      // Empty means “not recorded”; do not invent a message/call type.
      interactionType: optionalSingleLine(input.interactionType, "互动类型", 80),
      direction: normalizeDirection(input.direction),
      // Empty means “not recorded”; do not invent an “other” channel.
      channel: optionalSingleLine(input.channel, "互动渠道", PROFILE_LIMITS.channel),
      summary: requiredText(input.summary, "互动摘要", 1_000),
      notes: optionalNotes(input.notes, "互动备注", PROFILE_LIMITS.notes),
      occurredAt: input.occurredAt
        ? canonicalDate(input.occurredAt, "互动时间")
        : createdAt,
      createdAt,
      associationJobIds: unionJobIds(expectedContact.expectedJobIds, addedJobIds),
      contactUpdatedAt: nextVersion(
        expectedContact.expectedUpdatedAt,
        Date.parse(createdAt),
      ),
      followUp,
    },
  };
}

function normalizeTask(input: CreateCareerContactTaskSafeInput): {
  expectedContact: NormalizedExpectedState;
  snapshot: CareerContactTaskExpectedSnapshot;
} {
  const expectedContact = normalizeExpectedState(input.expectedContact);
  if (expectedContact.expectedArchived) {
    throw mutationError("changed", "联系人已经归档，没有创建新的下一步。");
  }
  const createdAt = canonicalDate(input.createdAt, "创建时间");
  const jobId = input.jobId ? databaseId(input.jobId, "岗位 ID") : null;
  return {
    expectedContact,
    snapshot: {
      taskId: entityId(input.taskId, "task"),
      contactId: databaseId(input.contactId, "联系人 ID"),
      title: requiredText(input.title, "跟进任务", 500),
      dueAt: optionalDate(input.dueAt, "跟进时间"),
      kind: optionalSingleLine(input.kind ?? "跟进", "任务类型", 80),
      priority: priority(input.priority),
      jobId,
      createdAt,
      associationJobIds: unionJobIds(
        expectedContact.expectedJobIds,
        jobId ? [jobId] : [],
      ),
      contactUpdatedAt: nextVersion(
        expectedContact.expectedUpdatedAt,
        Date.parse(createdAt),
      ),
    },
  };
}

function createReceipt(
  expected: CareerContactCreateExpectedSnapshot,
): Extract<CareerContactWriteReceipt, { kind: "contact" }> {
  return { purpose: RECEIPT_PURPOSE, version: RECEIPT_VERSION, kind: "contact", expected };
}

function interactionReceipt(
  expected: CareerContactInteractionExpectedSnapshot,
): Extract<CareerContactWriteReceipt, { kind: "interaction" }> {
  return { purpose: RECEIPT_PURPOSE, version: RECEIPT_VERSION, kind: "interaction", expected };
}

function taskReceipt(
  expected: CareerContactTaskExpectedSnapshot,
): Extract<CareerContactWriteReceipt, { kind: "task" }> {
  return { purpose: RECEIPT_PURPOSE, version: RECEIPT_VERSION, kind: "task", expected };
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function normalizeReceipt(receipt: CareerContactWriteReceipt): CareerContactWriteReceipt {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
    !exactKeys(receipt, ["purpose", "version", "kind", "expected"]) ||
    receipt.purpose !== RECEIPT_PURPOSE || receipt.version !== RECEIPT_VERSION) {
    throw mutationError("invalid_input", "联系人写入核对凭据无效");
  }
  if (receipt.kind === "contact") {
    const expected = receipt.expected;
    if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
      !exactKeys(expected, [
        "contactId", "name", "company", "role", "channel", "email", "phone",
        "notes", "createdAt", "jobIds",
      ])) {
      throw mutationError("invalid_input", "联系人写入核对凭据无效");
    }
    return createReceipt(normalizeCreate(expected));
  }
  if (receipt.kind === "task") {
    const expected = receipt.expected;
    if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
      !exactKeys(expected, [
        "taskId", "contactId", "title", "dueAt", "kind", "priority", "jobId",
        "createdAt", "associationJobIds", "contactUpdatedAt",
      ])) {
      throw mutationError("invalid_input", "联系人写入核对凭据无效");
    }
    return taskReceipt({
      taskId: entityId(expected.taskId, "task"),
      contactId: databaseId(expected.contactId, "联系人 ID"),
      title: requiredText(expected.title, "跟进任务", 500),
      dueAt: optionalDate(expected.dueAt, "跟进时间"),
      kind: optionalSingleLine(expected.kind, "任务类型", 80),
      priority: priority(expected.priority),
      jobId: expected.jobId ? databaseId(expected.jobId, "岗位 ID") : null,
      createdAt: canonicalDate(expected.createdAt, "创建时间"),
      associationJobIds: uniqueJobIds(expected.associationJobIds),
      contactUpdatedAt: canonicalDate(expected.contactUpdatedAt, "联系人版本时间"),
    });
  }
  if (receipt.kind === "interaction") {
    const expected = receipt.expected;
    if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
      !exactKeys(expected, [
        "interactionId", "contactId", "jobId", "interactionType", "direction",
        "channel", "summary", "notes", "occurredAt", "createdAt",
        "associationJobIds", "contactUpdatedAt", "followUp",
      ])) {
      throw mutationError("invalid_input", "联系人写入核对凭据无效");
    }
    let followUp: CareerContactInteractionExpectedSnapshot["followUp"] = null;
    if (expected.followUp !== null) {
      if (!expected.followUp || typeof expected.followUp !== "object" ||
        Array.isArray(expected.followUp) || !exactKeys(expected.followUp, [
          "taskId", "title", "dueAt", "kind", "priority", "jobId",
        ])) {
        throw mutationError("invalid_input", "联系人写入核对凭据无效");
      }
      followUp = {
        taskId: entityId(expected.followUp.taskId, "task"),
        title: requiredText(expected.followUp.title, "跟进任务", 500),
        dueAt: optionalDate(expected.followUp.dueAt, "跟进时间"),
        kind: optionalSingleLine(expected.followUp.kind, "任务类型", 80),
        priority: priority(expected.followUp.priority),
        jobId: expected.followUp.jobId
          ? databaseId(expected.followUp.jobId, "岗位 ID")
          : null,
      };
    }
    return interactionReceipt({
      interactionId: entityId(expected.interactionId, "interaction"),
      contactId: databaseId(expected.contactId, "联系人 ID"),
      jobId: expected.jobId ? databaseId(expected.jobId, "岗位 ID") : null,
      interactionType: optionalSingleLine(expected.interactionType, "互动类型", 80),
      direction: normalizeDirection(expected.direction),
      channel: optionalSingleLine(expected.channel, "互动渠道", PROFILE_LIMITS.channel),
      summary: requiredText(expected.summary, "互动摘要", 1_000),
      notes: optionalNotes(expected.notes, "互动备注", PROFILE_LIMITS.notes),
      occurredAt: canonicalDate(expected.occurredAt, "互动时间"),
      createdAt: canonicalDate(expected.createdAt, "创建时间"),
      associationJobIds: uniqueJobIds(expected.associationJobIds),
      contactUpdatedAt: canonicalDate(expected.contactUpdatedAt, "联系人版本时间"),
      followUp,
    });
  }
  throw mutationError("invalid_input", "联系人写入核对凭据无效");
}

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return unwrapRows<T>(await localDb.query(DB, sql, params));
}

async function runtimeRows<Row extends object>(
  runtime: CareerContactStorageRuntime,
  sql: string,
  params: readonly unknown[] = [],
): Promise<readonly Row[]> {
  return (await runtime.query<Row>(sql, params)).rows;
}

async function readContact(
  runtime: CareerContactStorageRuntime,
  contactId: string,
): Promise<StoredContact | null> {
  const rows = await runtimeRows<StoredContact>(
    runtime,
    `SELECT id,company,name,role,channel,email,phone,last_contact_at,
        next_follow_up,notes,created_at,updated_at,archived
      FROM career_contacts WHERE id = ? LIMIT 1`,
    [contactId],
  );
  return rows[0] ?? null;
}

async function readAssociationIds(
  runtime: CareerContactStorageRuntime,
  contactId: string,
): Promise<string[]> {
  const rows = await runtimeRows<{ job_id: string }>(
    runtime,
    `SELECT job_id FROM career_contact_jobs
      WHERE contact_id = ? ORDER BY job_id`,
    [contactId],
  );
  return rows.map(({ job_id }) => job_id);
}

async function readInteraction(
  runtime: CareerContactStorageRuntime,
  interactionId: string,
): Promise<StoredInteraction | null> {
  const rows = await runtimeRows<StoredInteraction>(
    runtime,
    `SELECT id,contact_id,job_id,interaction_type,direction,channel,summary,
        notes,occurred_at,created_at
      FROM career_contact_interactions WHERE id = ? LIMIT 1`,
    [interactionId],
  );
  return rows[0] ?? null;
}

async function readTask(
  runtime: CareerContactStorageRuntime,
  taskId: string,
): Promise<StoredTask | null> {
  const rows = await runtimeRows<StoredTask>(
    runtime,
    `SELECT id,job_id,contact_id,title,due_at,kind,priority,status,
        created_at,updated_at
      FROM career_tasks WHERE id = ? LIMIT 1`,
    [taskId],
  );
  return rows[0] ?? null;
}

function exactContactCreate(
  row: StoredContact,
  expected: CareerContactCreateExpectedSnapshot,
): boolean {
  return row.id === expected.contactId &&
    row.name === expected.name &&
    row.company === expected.company &&
    row.role === expected.role &&
    row.channel === expected.channel &&
    row.email === expected.email &&
    row.phone === expected.phone &&
    row.notes === expected.notes &&
    row.created_at === expected.createdAt &&
    row.updated_at === expected.createdAt &&
    Number(row.archived) === 0 &&
    row.last_contact_at === null &&
    row.next_follow_up === null;
}

function exactTask(row: StoredTask, expected: {
  taskId: string;
  contactId: string;
  title: string;
  dueAt: string | null;
  kind: string;
  priority: number;
  jobId: string | null;
  createdAt: string;
}): boolean {
  return row.id === expected.taskId &&
    row.contact_id === expected.contactId &&
    row.job_id === expected.jobId &&
    row.title === expected.title &&
    row.due_at === expected.dueAt &&
    row.kind === expected.kind &&
    Number(row.priority) === expected.priority &&
    row.status === "todo" &&
    row.created_at === expected.createdAt &&
    row.updated_at === expected.createdAt;
}

async function inspectCreateUnlocked(
  runtime: CareerContactStorageRuntime,
  expected: CareerContactCreateExpectedSnapshot,
): Promise<CareerContactWriteInspection> {
  try {
    const row = await readContact(runtime, expected.contactId);
    if (!row) return "absent";
    const jobIds = await readAssociationIds(runtime, expected.contactId);
    return exactContactCreate(row, expected) && sameJobIds(jobIds, expected.jobIds)
      ? "exact_saved"
      : "conflict";
  } catch {
    return "still_unknown";
  }
}

async function inspectTaskUnlocked(
  runtime: CareerContactStorageRuntime,
  expected: CareerContactTaskExpectedSnapshot,
): Promise<CareerContactWriteInspection> {
  try {
    const task = await readTask(runtime, expected.taskId);
    if (!task) return "absent";
    const contact = await readContact(runtime, expected.contactId);
    const jobIds = await readAssociationIds(runtime, expected.contactId);
    return contact && exactTask(task, expected) &&
        Number(contact.archived) === 0 &&
        contact.updated_at === expected.contactUpdatedAt &&
        sameJobIds(jobIds, expected.associationJobIds)
      ? "exact_saved"
      : "conflict";
  } catch {
    return "still_unknown";
  }
}

async function inspectInteractionUnlocked(
  runtime: CareerContactStorageRuntime,
  expected: CareerContactInteractionExpectedSnapshot,
): Promise<CareerContactWriteInspection> {
  try {
    const interaction = await readInteraction(runtime, expected.interactionId);
    if (!interaction) {
      if (expected.followUp && await readTask(runtime, expected.followUp.taskId)) {
        return "conflict";
      }
      return "absent";
    }
    const contact = await readContact(runtime, expected.contactId);
    const jobIds = await readAssociationIds(runtime, expected.contactId);
    const followUp = expected.followUp
      ? await readTask(runtime, expected.followUp.taskId)
      : null;
    const interactionExact =
      interaction.id === expected.interactionId &&
      interaction.contact_id === expected.contactId &&
      interaction.job_id === expected.jobId &&
      interaction.interaction_type === expected.interactionType &&
      interaction.direction === expected.direction &&
      interaction.channel === expected.channel &&
      interaction.summary === expected.summary &&
      interaction.notes === expected.notes &&
      interaction.occurred_at === expected.occurredAt &&
      interaction.created_at === expected.createdAt;
    const taskExact = expected.followUp
      ? Boolean(followUp && exactTask(followUp, {
          taskId: expected.followUp.taskId,
          contactId: expected.contactId,
          title: expected.followUp.title,
          dueAt: expected.followUp.dueAt,
          kind: expected.followUp.kind,
          priority: expected.followUp.priority,
          jobId: expected.followUp.jobId,
          createdAt: expected.createdAt,
        }))
      : followUp === null;
    return interactionExact && taskExact && contact &&
        Number(contact.archived) === 0 &&
        contact.updated_at === expected.contactUpdatedAt &&
        sameJobIds(jobIds, expected.associationJobIds)
      ? "exact_saved"
      : "conflict";
  } catch {
    return "still_unknown";
  }
}

async function inspectReceiptUnlocked(
  runtime: CareerContactStorageRuntime,
  receipt: CareerContactWriteReceipt,
): Promise<CareerContactWriteInspection> {
  if (receipt.kind === "contact") {
    return inspectCreateUnlocked(runtime, receipt.expected);
  }
  if (receipt.kind === "interaction") {
    return inspectInteractionUnlocked(runtime, receipt.expected);
  }
  return inspectTaskUnlocked(runtime, receipt.expected);
}

function exactExpectedState(
  contact: StoredContact | null,
  jobIds: readonly string[],
  expected: NormalizedExpectedState,
): boolean {
  return Boolean(contact) &&
    contact!.updated_at === expected.expectedUpdatedAt &&
    Number(contact!.archived) === (expected.expectedArchived ? 1 : 0) &&
    sameJobIds(jobIds, expected.expectedJobIds);
}

async function readContactState(
  runtime: CareerContactStorageRuntime,
  contactId: string,
): Promise<{ contact: StoredContact | null; jobIds: string[] }> {
  const contact = await readContact(runtime, contactId);
  const jobIds = contact ? await readAssociationIds(runtime, contactId) : [];
  return { contact, jobIds };
}

function safeBroadcast(runtime: CareerContactStorageRuntime, reason: string): void {
  try {
    runtime.broadcast(reason);
  } catch {
    // Cross-view refresh is advisory and cannot reverse a durable write.
  }
}

async function resolveWrite(
  runtime: CareerContactStorageRuntime,
  receipt: CareerContactWriteReceipt,
  statements: readonly SqlStatement[],
  context: CareerLockContext | undefined,
  reason: string,
): Promise<CertainOutcome | "outcome_uncertain"> {
  const before = await inspectReceiptUnlocked(runtime, receipt);
  if (before === "exact_saved") return "already_saved";
  if (before === "conflict") {
    throw mutationError(
      "conflict",
      "这个稳定标识已经对应另一份内容，没有覆盖现有记录。",
    );
  }
  if (before === "still_unknown") {
    throw mutationError(
      "inspect_failed",
      "暂时无法确认这个标识是否已经保存，因此没有开始新的写入。",
    );
  }

  try {
    await runtime.batch(statements, context);
  } catch {
    // The transaction can have committed even when its response was lost.
  }

  const after = await inspectReceiptUnlocked(runtime, receipt);
  if (after === "exact_saved") {
    safeBroadcast(runtime, reason);
    return "saved";
  }
  if (after === "absent") {
    throw mutationError(
      "write_failed",
      "这次记录确定没有写入；保留原内容后可以重试。",
    );
  }
  if (after === "conflict") {
    throw mutationError(
      "conflict",
      "稳定标识或关联记录已经对应另一份内容，没有覆盖现有记录。",
    );
  }
  return "outcome_uncertain";
}

function normalizeUpdateFields(input: UpdateCareerContactInput): Record<string, string> {
  const fields: Record<string, string> = {};
  const definitions = [
    ["name", "姓名", PROFILE_LIMITS.name],
    ["company", "公司", PROFILE_LIMITS.company],
    ["role", "角色", PROFILE_LIMITS.role],
    ["channel", "渠道", PROFILE_LIMITS.channel],
    ["email", "邮箱", PROFILE_LIMITS.email],
    ["phone", "电话", PROFILE_LIMITS.phone],
  ] as const;
  for (const [field, label, maximum] of definitions) {
    if (input[field] !== undefined) {
      fields[field] = field === "name"
        ? requiredText(input[field], label, maximum)
        : optionalSingleLine(input[field], label, maximum);
    }
  }
  if (input.notes !== undefined) {
    fields.notes = optionalNotes(input.notes, "备注", PROFILE_LIMITS.notes);
  }
  return fields;
}

function targetPatchMatches(
  contact: StoredContact,
  jobIds: readonly string[],
  fields: Readonly<Record<string, string>>,
  targetJobIds: readonly string[],
  targetUpdatedAt: string,
  targetArchived: boolean,
): boolean {
  return contact.updated_at === targetUpdatedAt &&
    Number(contact.archived) === (targetArchived ? 1 : 0) &&
    Object.entries(fields).every(([field, value]) =>
      contact[field as keyof StoredContact] === value) &&
    sameJobIds(jobIds, targetJobIds);
}

export function createCareerContactStorageService(
  runtime: CareerContactStorageRuntime = defaultRuntime,
) {
  async function inspectWrite(
    receiptInput: CareerContactWriteReceipt,
  ): Promise<CareerContactWriteInspection> {
    const receipt = normalizeReceipt(receiptInput);
    return runtime.withExclusiveLock(() => inspectReceiptUnlocked(runtime, receipt));
  }

  async function createContact(
    input: CreateCareerContactSafeInput,
  ): Promise<CareerContactCreateSafeResult> {
    // Normalize/copy mutable caller data before waiting for the Web Lock.
    const expected = normalizeCreate(input);
    const receipt = createReceipt(expected);
    return runtime.withExclusiveLock(async (context) => {
      const outcome = await resolveWrite(
        runtime,
        receipt,
        createCareerContactInsertStatements({
          id: expected.contactId,
          name: expected.name,
          company: expected.company,
          role: expected.role,
          channel: expected.channel,
          email: expected.email,
          phone: expected.phone,
          notes: expected.notes,
          createdAt: expected.createdAt,
          updatedAt: expected.createdAt,
          jobIds: expected.jobIds,
        }),
        context,
        "career-contact-created",
      );
      return outcome === "outcome_uncertain"
        ? {
            outcome,
            contactId: expected.contactId,
            receipt,
            retryable: true,
          }
        : { outcome, contactId: expected.contactId };
    });
  }

  async function recordInteraction(
    input: RecordCareerContactInteractionSafeInput,
  ): Promise<CareerContactInteractionSafeResult> {
    const { snapshot, expectedContact, addedJobIds } = normalizeInteraction(input);
    const receipt = interactionReceipt(snapshot);
    return runtime.withExclusiveLock(async (context) => {
      const existing = await inspectInteractionUnlocked(runtime, snapshot);
      if (existing === "exact_saved") {
        return {
          outcome: "already_saved",
          interactionId: snapshot.interactionId,
          taskId: snapshot.followUp?.taskId ?? null,
        };
      }
      if (existing === "conflict") {
        throw mutationError("conflict", "这个联系记录标识已被另一份内容占用。");
      }
      if (existing === "still_unknown") {
        throw mutationError("inspect_failed", "暂时无法核对联系记录，没有开始写入。");
      }
      let state: Awaited<ReturnType<typeof readContactState>>;
      try {
        state = await readContactState(runtime, snapshot.contactId);
      } catch {
        throw mutationError("inspect_failed", "暂时无法核对联系人版本，没有开始写入。");
      }
      if (!exactExpectedState(state.contact, state.jobIds, expectedContact)) {
        throw mutationError("changed", "联系人已在别处变化，没有写入这次联系记录。");
      }
      const outcome = await resolveWrite(
        runtime,
        receipt,
        createCareerContactInteractionStatements({
          id: snapshot.interactionId,
          contactId: snapshot.contactId,
          jobId: snapshot.jobId,
          interactionType: snapshot.interactionType,
          direction: snapshot.direction,
          channel: snapshot.channel,
          summary: snapshot.summary,
          notes: snapshot.notes,
          occurredAt: snapshot.occurredAt,
          createdAt: snapshot.createdAt,
          associatedJobIds: addedJobIds,
          contactUpdatedAt: snapshot.contactUpdatedAt,
          expectedContact: plannedExpected(expectedContact),
          followUp: snapshot.followUp
            ? {
                id: snapshot.followUp.taskId,
                title: snapshot.followUp.title,
                dueAt: snapshot.followUp.dueAt,
                kind: snapshot.followUp.kind,
                priority: snapshot.followUp.priority,
                jobId: snapshot.followUp.jobId,
              }
            : null,
        }),
        context,
        "career-contact-interaction-created",
      );
      const taskId = snapshot.followUp?.taskId ?? null;
      return outcome === "outcome_uncertain"
        ? {
            outcome,
            interactionId: snapshot.interactionId,
            taskId,
            receipt,
            retryable: true,
          }
        : { outcome, interactionId: snapshot.interactionId, taskId };
    });
  }

  async function createTask(
    input: CreateCareerContactTaskSafeInput,
  ): Promise<CareerContactTaskSafeResult> {
    const { snapshot, expectedContact } = normalizeTask(input);
    const receipt = taskReceipt(snapshot);
    return runtime.withExclusiveLock(async (context) => {
      const existing = await inspectTaskUnlocked(runtime, snapshot);
      if (existing === "exact_saved") {
        return { outcome: "already_saved", taskId: snapshot.taskId };
      }
      if (existing === "conflict") {
        throw mutationError("conflict", "这个待办标识已被另一份内容占用。");
      }
      if (existing === "still_unknown") {
        throw mutationError("inspect_failed", "暂时无法核对下一步，没有开始写入。");
      }
      let state: Awaited<ReturnType<typeof readContactState>>;
      try {
        state = await readContactState(runtime, snapshot.contactId);
      } catch {
        throw mutationError("inspect_failed", "暂时无法核对联系人版本，没有开始写入。");
      }
      if (!exactExpectedState(state.contact, state.jobIds, expectedContact)) {
        throw mutationError("changed", "联系人已在别处变化，没有创建新的下一步。");
      }
      const outcome = await resolveWrite(
        runtime,
        receipt,
        createCareerContactTaskStatements({
          id: snapshot.taskId,
          contactId: snapshot.contactId,
          title: snapshot.title,
          dueAt: snapshot.dueAt,
          kind: snapshot.kind,
          priority: snapshot.priority,
          jobId: snapshot.jobId,
          createdAt: snapshot.createdAt,
          contactUpdatedAt: snapshot.contactUpdatedAt,
          expectedContact: plannedExpected(expectedContact),
        }),
        context,
        "career-contact-task-created",
      );
      return outcome === "outcome_uncertain"
        ? { outcome, taskId: snapshot.taskId, receipt, retryable: true }
        : { outcome, taskId: snapshot.taskId };
    });
  }

  async function updateContact(
    contactIdInput: string,
    input: UpdateCareerContactInput,
    optionsInput: CareerContactCasOptions,
  ): Promise<CareerContactCasResult> {
    const contactId = databaseId(contactIdInput, "联系人 ID");
    const expected = normalizeExpectedState(optionsInput);
    const fields = normalizeUpdateFields(input);
    const replacementJobIds = input.jobIds === undefined
      ? undefined
      : uniqueJobIds(input.jobIds);
    const targetJobIds = replacementJobIds ?? expected.expectedJobIds;

    return runtime.withExclusiveLock(async (context) => {
      let state: Awaited<ReturnType<typeof readContactState>>;
      try {
        state = await readContactState(runtime, contactId);
      } catch {
        throw mutationError("inspect_failed", "暂时无法核对联系人版本，没有开始写入。");
      }
      if (!exactExpectedState(state.contact, state.jobIds, expected)) {
        return { outcome: "changed", contactId, retryable: false };
      }
      const updatedAt = nextVersion(expected.expectedUpdatedAt, runtime.now());
      try {
        await runtime.batch(createCareerContactUpdateStatements({
          contactId,
          fields,
          updatedAt,
          ...(replacementJobIds === undefined ? {} : { jobIds: replacementJobIds }),
          expected: plannedExpected(expected),
        }), context);
      } catch {
        // Inspect the exact target; the batch response may have been lost.
      }
      try {
        const after = await readContactState(runtime, contactId);
        if (after.contact && targetPatchMatches(
          after.contact,
          after.jobIds,
          fields,
          targetJobIds,
          updatedAt,
          expected.expectedArchived,
        )) {
          safeBroadcast(runtime, "career-contact-updated");
          return { outcome: "saved", contactId, updatedAt };
        }
        if (exactExpectedState(after.contact, after.jobIds, expected)) {
          throw mutationError("write_failed", "联系人确定没有更新，请保留表单后重试。");
        }
        return { outcome: "changed", contactId, retryable: false };
      } catch (error) {
        if (error instanceof CareerContactMutationError) throw error;
        return { outcome: "outcome_uncertain", contactId, retryable: true };
      }
    });
  }

  async function setArchived(
    contactIdInput: string,
    archived: boolean,
    optionsInput: CareerContactCasOptions,
  ): Promise<CareerContactCasResult> {
    const contactId = databaseId(contactIdInput, "联系人 ID");
    const expected = normalizeExpectedState(optionsInput);
    if (expected.expectedArchived === archived) {
      throw mutationError("invalid_input", "归档命令的预期状态与目标状态相同。");
    }
    return runtime.withExclusiveLock(async (context) => {
      let state: Awaited<ReturnType<typeof readContactState>>;
      try {
        state = await readContactState(runtime, contactId);
      } catch {
        throw mutationError("inspect_failed", "暂时无法核对联系人版本，没有开始写入。");
      }
      if (!exactExpectedState(state.contact, state.jobIds, expected)) {
        return { outcome: "changed", contactId, retryable: false };
      }
      const updatedAt = nextVersion(expected.expectedUpdatedAt, runtime.now());
      try {
        await runtime.batch(createCareerContactArchiveStatements(
          contactId,
          archived,
          updatedAt,
          plannedExpected(expected),
        ), context);
      } catch {
        // Inspect the exact target; the batch response may have been lost.
      }
      try {
        const after = await readContactState(runtime, contactId);
        if (after.contact &&
          after.contact.updated_at === updatedAt &&
          Number(after.contact.archived) === (archived ? 1 : 0) &&
          sameJobIds(after.jobIds, expected.expectedJobIds)) {
          safeBroadcast(runtime, archived
            ? "career-contact-archived"
            : "career-contact-restored");
          return { outcome: "saved", contactId, updatedAt };
        }
        if (exactExpectedState(after.contact, after.jobIds, expected)) {
          throw mutationError("write_failed", "联系人状态确定没有更新，请稍后重试。");
        }
        return { outcome: "changed", contactId, retryable: false };
      } catch (error) {
        if (error instanceof CareerContactMutationError) throw error;
        return { outcome: "outcome_uncertain", contactId, retryable: true };
      }
    });
  }

  return {
    inspectCareerContactWrite: inspectWrite,
    createCareerContactSafely: createContact,
    recordCareerContactInteractionSafely: recordInteraction,
    createCareerContactTaskSafely: createTask,
    updateCareerContactSafely: updateContact,
    archiveCareerContactSafely: (
      contactId: string,
      options: CareerContactCasOptions,
    ) => setArchived(contactId, true, options),
    restoreCareerContactSafely: (
      contactId: string,
      options: CareerContactCasOptions,
    ) => setArchived(contactId, false, options),
  } as const;
}

export async function loadCareerContacts(
  scope: CareerContactScope = "active",
): Promise<Contact[]> {
  if (scope !== "active" && scope !== "archived" && scope !== "all") {
    throw mutationError("invalid_input", "联系人范围不受支持");
  }
  const where = scope === "all"
    ? ""
    : `WHERE contact.archived = ${scope === "active" ? 0 : 1}`;
  return withCareerReadLock(() => query<Contact>(
    `SELECT contact.id,contact.company,contact.name,contact.role,contact.channel,
        contact.email,contact.phone,
        (SELECT MAX(interaction.occurred_at)
          FROM career_contact_interactions AS interaction
          WHERE interaction.contact_id = contact.id) AS last_contact_at,
        (SELECT MIN(task.due_at)
          FROM career_tasks AS task
          WHERE task.contact_id = contact.id
            AND task.status = 'todo'
            AND task.due_at IS NOT NULL) AS next_follow_up,
        contact.notes,contact.created_at,contact.updated_at,contact.archived
      FROM career_contacts AS contact ${where}
      ORDER BY contact.archived,
        CASE WHEN next_follow_up IS NULL THEN 1 ELSE 0 END,
        next_follow_up,
        CASE WHEN last_contact_at IS NULL THEN 1 ELSE 0 END,
        last_contact_at DESC,
        contact.name`,
  ));
}

export async function loadCareerContactDetail(
  contactId: string,
): Promise<CareerContactDetail | null> {
  const normalizedId = databaseId(contactId, "联系人 ID");
  return withCareerReadLock(async () => {
    const [contacts, associations, jobs, interactions, tasks] = await Promise.all([
      query<Contact>("SELECT * FROM career_contacts WHERE id = ?", [normalizedId]),
      query<ContactJobAssociation>(
        `SELECT contact_id, job_id, created_at FROM career_contact_jobs
          WHERE contact_id = ? ORDER BY created_at, job_id`,
        [normalizedId],
      ),
      // Archived jobs are deliberate context and remain visible in the detail view.
      query<Job>(
        `SELECT jobs.* FROM career_jobs AS jobs
          INNER JOIN career_contact_jobs AS links ON links.job_id = jobs.id
          WHERE links.contact_id = ?
          ORDER BY jobs.archived, jobs.updated_at DESC`,
        [normalizedId],
      ),
      query<ContactInteraction>(
        `SELECT * FROM career_contact_interactions
          WHERE contact_id = ? ORDER BY occurred_at DESC, created_at DESC`,
        [normalizedId],
      ),
      query<Task>(
        `SELECT * FROM career_tasks WHERE contact_id = ?
          ORDER BY CASE status WHEN 'todo' THEN 0 ELSE 1 END,
            COALESCE(due_at, '9999-12-31T23:59:59.999Z'), created_at DESC`,
        [normalizedId],
      ),
    ]);
    const contact = contacts[0];
    return contact ? { contact, associations, jobs, interactions, tasks } : null;
  });
}

export async function loadCareerContactExpectedState(
  contactIdInput: string,
): Promise<CareerContactExpectedState | null> {
  const contactId = databaseId(contactIdInput, "联系人 ID");
  return withCareerReadLock(async () => {
    const contacts = await query<StoredContact>(
      "SELECT * FROM career_contacts WHERE id = ? LIMIT 1",
      [contactId],
    );
    if (!contacts[0]) return null;
    const links = await query<{ job_id: string }>(
      "SELECT job_id FROM career_contact_jobs WHERE contact_id = ? ORDER BY job_id",
      [contactId],
    );
    return {
      expectedUpdatedAt: contacts[0].updated_at,
      expectedArchived: Number(contacts[0].archived) === 1,
      expectedJobIds: links.map(({ job_id }) => job_id),
    };
  });
}

export function inspectCareerContactWrite(
  receipt: CareerContactWriteReceipt,
  runtime: CareerContactStorageRuntime = defaultRuntime,
): Promise<CareerContactWriteInspection> {
  return createCareerContactStorageService(runtime).inspectCareerContactWrite(receipt);
}

export function createCareerContactSafely(
  input: CreateCareerContactSafeInput,
  runtime: CareerContactStorageRuntime = defaultRuntime,
): Promise<CareerContactCreateSafeResult> {
  return createCareerContactStorageService(runtime).createCareerContactSafely(input);
}

export function recordCareerContactInteractionSafely(
  input: RecordCareerContactInteractionSafeInput,
  runtime: CareerContactStorageRuntime = defaultRuntime,
): Promise<CareerContactInteractionSafeResult> {
  return createCareerContactStorageService(runtime)
    .recordCareerContactInteractionSafely(input);
}

export function createCareerContactTaskSafely(
  input: CreateCareerContactTaskSafeInput,
  runtime: CareerContactStorageRuntime = defaultRuntime,
): Promise<CareerContactTaskSafeResult> {
  return createCareerContactStorageService(runtime).createCareerContactTaskSafely(input);
}

export function updateCareerContactSafely(
  contactId: string,
  input: UpdateCareerContactInput,
  options: CareerContactCasOptions,
  runtime: CareerContactStorageRuntime = defaultRuntime,
): Promise<CareerContactCasResult> {
  return createCareerContactStorageService(runtime)
    .updateCareerContactSafely(contactId, input, options);
}

export function archiveCareerContactSafely(
  contactId: string,
  options: CareerContactCasOptions,
  runtime: CareerContactStorageRuntime = defaultRuntime,
): Promise<CareerContactCasResult> {
  return createCareerContactStorageService(runtime)
    .archiveCareerContactSafely(contactId, options);
}

export function restoreCareerContactSafely(
  contactId: string,
  options: CareerContactCasOptions,
  runtime: CareerContactStorageRuntime = defaultRuntime,
): Promise<CareerContactCasResult> {
  return createCareerContactStorageService(runtime)
    .restoreCareerContactSafely(contactId, options);
}

function throwLegacyUncertain(
  result: { outcome: string; receipt?: CareerContactWriteReceipt },
): void {
  if (result.outcome === "outcome_uncertain") {
    throw mutationError(
      "outcome_uncertain",
      "写入结果暂时无法确认，请使用恢复凭据只读核对，不要直接重复创建。",
      result.receipt,
    );
  }
}

function unwrapLegacyCas(result: CareerContactCasResult): void {
  if (result.outcome === "changed") {
    throw mutationError("changed", "联系人已在别处变化，请刷新后再决定。");
  }
  if (result.outcome === "outcome_uncertain") {
    throw mutationError("outcome_uncertain", "联系人写入结果暂时无法确认，请先刷新核对。");
  }
}

export async function createCareerContact(
  input: CreateCareerContactInput,
): Promise<string> {
  const contactId = input.contactId
    ? entityId(input.contactId, "contact")
    : newId("contact");
  const result = await createCareerContactSafely({
    ...input,
    contactId,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  throwLegacyUncertain(result);
  return contactId;
}

export async function updateCareerContact(
  contactId: string,
  input: UpdateCareerContactInput,
): Promise<void> {
  const expected = await loadCareerContactExpectedState(contactId);
  if (!expected) throw mutationError("changed", "联系人已经不存在，请刷新后再决定。");
  unwrapLegacyCas(await updateCareerContactSafely(contactId, input, expected));
}

export async function recordCareerContactInteraction(
  input: RecordCareerContactInteractionInput,
): Promise<RecordCareerContactInteractionResult> {
  const expectedContact = await loadCareerContactExpectedState(input.contactId);
  if (!expectedContact) {
    throw mutationError("changed", "联系人已经不存在，请刷新后再记录。");
  }
  const interactionId = input.interactionId
    ? entityId(input.interactionId, "interaction")
    : newId("interaction");
  const taskId = input.followUp
    ? (input.followUp.taskId
        ? entityId(input.followUp.taskId, "task")
        : newId("task"))
    : null;
  const result = await recordCareerContactInteractionSafely({
    ...input,
    interactionId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    direction: normalizeDirection(input.direction),
    expectedContact,
    followUp: input.followUp && taskId
      ? { ...input.followUp, taskId }
      : undefined,
  });
  throwLegacyUncertain(result);
  return { interactionId, taskId };
}

export async function createCareerContactTask(
  input: CreateCareerContactTaskInput,
): Promise<string> {
  const expectedContact = await loadCareerContactExpectedState(input.contactId);
  if (!expectedContact) {
    throw mutationError("changed", "联系人已经不存在，请刷新后再安排下一步。");
  }
  const taskId = input.taskId ? entityId(input.taskId, "task") : newId("task");
  const result = await createCareerContactTaskSafely({
    ...input,
    taskId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    expectedContact,
  });
  throwLegacyUncertain(result);
  return taskId;
}

export async function archiveCareerContact(contactId: string): Promise<void> {
  const expected = await loadCareerContactExpectedState(contactId);
  if (!expected) throw mutationError("changed", "联系人已经不存在，请刷新后再决定。");
  if (expected.expectedArchived) return;
  unwrapLegacyCas(await archiveCareerContactSafely(contactId, expected));
}

export async function restoreCareerContact(contactId: string): Promise<void> {
  const expected = await loadCareerContactExpectedState(contactId);
  if (!expected) throw mutationError("changed", "联系人已经不存在，请刷新后再决定。");
  if (!expected.expectedArchived) return;
  unwrapLegacyCas(await restoreCareerContactSafely(contactId, expected));
}
