import type { SqlStatement } from "@/lib/local-db/types";
import type {
  Contact,
  ContactInteraction,
  ContactJobAssociation,
  Job,
  Task,
} from "./types";
import type {
  CreateCareerContactInput,
  CreateCareerContactTaskInput,
  RecordCareerContactInteractionInput,
  UpdateCareerContactInput,
} from "./contacts";
import {
  CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
  CAREER_WRITE_RECEIPT_VERSION,
  type CareerWriteCommitResult,
  type CareerWriteGenerationExpectation,
  type CareerWriteInspection,
  type CareerWriteReceiptBase,
  type CareerWriteStorageRuntime,
  abortUnless,
  careerWriteError,
  careerWriteReceiptHashIsValid,
  compareSqliteBinaryText,
  defaultCareerWriteStorageRuntime,
  exactCareerWriteMarker,
  exactKeys,
  generatedCareerWriteOperationId,
  isCanonicalIsoTimestamp,
  isCareerWriteGeneration,
  isCareerWriteOperationId,
  isNullableString,
  isSafeInteger,
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
} from "./write-marker";

const PURPOSE = "career-contact-write" as const;
const ENTITY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTACT_KEYS = [
  "id", "company", "name", "role", "channel", "email", "phone",
  "last_contact_at", "next_follow_up", "notes", "created_at", "updated_at",
  "archived",
] as const;
const ASSOCIATION_KEYS = ["contact_id", "job_id", "created_at"] as const;
const JOB_KEYS = [
  "id", "company", "role", "location", "source", "source_url", "stage_id",
  "priority", "salary", "work_mode", "description", "applied_at", "deadline",
  "contact_name", "note", "tags", "created_at", "updated_at", "archived",
  "position", "archived_at", "ended_at", "archived_operation_id",
  "ended_operation_id",
] as const;
const INTERACTION_KEYS = [
  "id", "contact_id", "job_id", "interaction_type", "direction", "channel",
  "summary", "notes", "occurred_at", "created_at",
] as const;
const TASK_KEYS = [
  "id", "job_id", "contact_id", "title", "due_at", "kind", "priority",
  "status", "created_at", "updated_at", "canceled_at", "cancellation_reason",
  "lifecycle_previous_status", "lifecycle_operation_id",
] as const;

type ContactKind =
  | "contact-create"
  | "contact-update"
  | "contact-archive"
  | "contact-restore"
  | "contact-interaction-create"
  | "contact-task-create";

export type CareerContactDisplayedExpected = CareerWriteGenerationExpectation & Readonly<{
  contact: Readonly<Contact> | null;
  associations: readonly Readonly<ContactJobAssociation>[];
  /** Exact full rows for every existing or newly requested association. */
  jobs: readonly Readonly<Job>[];
}>;

type ContactBefore = CareerContactDisplayedExpected & Readonly<{
  interactionId: string | null;
  taskId: string | null;
}>;

type ContactAfter = CareerWriteGenerationExpectation & Readonly<{
  contact: Readonly<Contact>;
  associations: readonly Readonly<ContactJobAssociation>[];
  interaction: Readonly<ContactInteraction> | null;
  task: Readonly<Task> | null;
}>;

type ContactIntentBase<Kind extends ContactKind, Command> = Readonly<{
  kind: Kind;
  operationId: string;
  operationAt: string;
  contactId: string;
  command: Command;
}>;

export type CareerContactWriteIntent =
  | ContactIntentBase<"contact-create", ContactProfileInput>
  | ContactIntentBase<"contact-update", ContactProfilePatch>
  | ContactIntentBase<"contact-archive" | "contact-restore", null>
  | (ContactIntentBase<"contact-interaction-create", InteractionInput> & Readonly<{
      interactionId: string;
      taskId: string | null;
    }>)
  | (ContactIntentBase<"contact-task-create", TaskInput> & Readonly<{
      taskId: string;
    }>);

export type CareerContactWriteReceipt = CareerWriteReceiptBase<
  typeof PURPOSE,
  ContactKind,
  ContactBefore,
  ContactAfter
> & Readonly<{ intent: CareerContactWriteIntent }>;

export type CareerContactWriteResult = CareerWriteCommitResult<CareerContactWriteReceipt>;

type ContactProfileInput = Readonly<{
  name: string;
  company: string;
  role: string;
  channel: string;
  email: string;
  phone: string;
  notes: string;
  jobIds: readonly string[];
}>;

type ContactProfilePatch = Readonly<{
  name?: string;
  company?: string;
  role?: string;
  channel?: string;
  email?: string;
  phone?: string;
  notes?: string;
  jobIds?: readonly string[];
}>;

type InteractionInput = Readonly<{
  contactId: string;
  occurredAt: string | null;
  interactionType: string;
  direction: "outbound" | "inbound" | "mutual";
  channel: string;
  summary: string;
  notes: string;
  jobId: string | null;
  associatedJobIds: readonly string[];
  followUp: Readonly<{
    title: string;
    dueAt: string | null;
    kind: string;
    priority: number;
    jobId: string | null;
  }> | null;
}>;

type TaskInput = Readonly<{
  contactId: string;
  title: string;
  dueAt: string | null;
  kind: string;
  priority: number;
  jobId: string | null;
}>;

function optionalLine(value: unknown, label: string, maximum: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw careerWriteError("invalid_input", `${label}格式无效。`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length > maximum) throw careerWriteError("invalid_input", `${label}过长。`);
  return normalized;
}

function optionalNotes(value: unknown, label: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw careerWriteError("invalid_input", `${label}格式无效。`);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length > 20_000) throw careerWriteError("invalid_input", `${label}过长。`);
  return normalized;
}

function optionalDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw careerWriteError("invalid_input", `${label}无效。`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw careerWriteError("invalid_input", `${label}无效。`);
  return new Date(milliseconds).toISOString();
}

function priority(value: unknown): number {
  const normalized = value ?? 1;
  if (!Number.isSafeInteger(normalized) || Number(normalized) < 1 || Number(normalized) > 3) {
    throw careerWriteError("invalid_input", "优先级需要是 1 到 3 的整数。");
  }
  return Number(normalized);
}

function sortedIds(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw careerWriteError("invalid_input", "职位关联无效。");
  return [...new Set(values.map((value) => requiredText(value, "职位 ID", 240)))]
    .sort(compareSqliteBinaryText);
}

function generatedId(runtime: CareerWriteStorageRuntime, prefix: "contact" | "interaction" | "task"): string {
  const id = `${prefix}_${runtime.randomUUID()}`;
  return /^\w+_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? id
    : (() => { throw careerWriteError("invalid_input", `无法生成${prefix}标识。`); })();
}

function normalizeProfile(input: CreateCareerContactInput): ContactProfileInput {
  return {
    name: requiredText(input.name, "姓名", 160),
    company: optionalLine(input.company, "公司", 240),
    role: optionalLine(input.role, "角色", 240),
    channel: optionalLine(input.channel, "渠道", 80),
    email: optionalLine(input.email, "邮箱", 320),
    phone: optionalLine(input.phone, "电话", 80),
    notes: optionalNotes(input.notes, "备注"),
    jobIds: sortedIds(input.jobIds),
  };
}

function normalizeProfilePatch(input: UpdateCareerContactInput): ContactProfilePatch {
  return {
    ...(input.name === undefined ? {} : { name: requiredText(input.name, "姓名", 160) }),
    ...(input.company === undefined ? {} : { company: optionalLine(input.company, "公司", 240) }),
    ...(input.role === undefined ? {} : { role: optionalLine(input.role, "角色", 240) }),
    ...(input.channel === undefined ? {} : { channel: optionalLine(input.channel, "渠道", 80) }),
    ...(input.email === undefined ? {} : { email: optionalLine(input.email, "邮箱", 320) }),
    ...(input.phone === undefined ? {} : { phone: optionalLine(input.phone, "电话", 80) }),
    ...(input.notes === undefined ? {} : { notes: optionalNotes(input.notes, "备注") }),
    ...(input.jobIds === undefined ? {} : { jobIds: sortedIds(input.jobIds) }),
  };
}

function normalizeInteraction(input: RecordCareerContactInteractionInput): InteractionInput {
  if (input.direction !== "outbound" && input.direction !== "inbound" && input.direction !== "mutual") {
    throw careerWriteError("invalid_input", "请明确选择联系方向。");
  }
  const jobId = input.jobId ? requiredText(input.jobId, "职位 ID", 240) : null;
  const followJobId = input.followUp?.jobId
    ? requiredText(input.followUp.jobId, "跟进职位 ID", 240)
    : null;
  const associatedJobIds = sortedIds([
    ...(input.associatedJobIds ?? []),
    ...(jobId ? [jobId] : []),
    ...(followJobId ? [followJobId] : []),
  ]);
  return {
    contactId: requiredText(input.contactId, "联系人 ID", 240),
    occurredAt: optionalDate(input.occurredAt, "联系时间"),
    interactionType: optionalLine(input.interactionType, "联系类型", 80),
    direction: input.direction,
    channel: optionalLine(input.channel, "联系渠道", 80),
    summary: requiredText(input.summary, "联系摘要", 1_000),
    notes: optionalNotes(input.notes, "联系备注"),
    jobId,
    associatedJobIds,
    followUp: input.followUp ? {
      title: requiredText(input.followUp.title, "跟进任务", 500),
      dueAt: optionalDate(input.followUp.dueAt, "跟进时间"),
      kind: optionalLine(input.followUp.kind ?? "跟进", "任务类型", 80),
      priority: priority(input.followUp.priority),
      jobId: followJobId ?? jobId,
    } : null,
  };
}

function normalizeTask(input: CreateCareerContactTaskInput): TaskInput {
  return {
    contactId: requiredText(input.contactId, "联系人 ID", 240),
    title: requiredText(input.title, "跟进任务", 500),
    dueAt: optionalDate(input.dueAt, "跟进时间"),
    kind: optionalLine(input.kind ?? "跟进", "任务类型", 80),
    priority: priority(input.priority),
    jobId: input.jobId ? requiredText(input.jobId, "职位 ID", 240) : null,
  };
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key]));
}

function isNormalizedContactIntent(value: unknown): value is CareerContactWriteIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as CareerContactWriteIntent;
  const baseKeys = ["kind", "operationId", "operationAt", "contactId", "command"];
  if (!isCareerWriteOperationId(intent.operationId, PURPOSE) ||
    !isCanonicalIsoTimestamp(intent.operationAt) || typeof intent.contactId !== "string" ||
    intent.contactId.trim() !== intent.contactId || !intent.contactId || intent.contactId.length > 240) return false;
  try {
    switch (intent.kind) {
      case "contact-create":
        return exactKeys(intent, baseKeys) && isEntityId(intent.contactId, "contact") &&
          sameJsonValue(intent.command, normalizeProfile(intent.command));
      case "contact-update": {
        if (!exactKeys(intent, baseKeys) || !intent.command || typeof intent.command !== "object" ||
          Array.isArray(intent.command)) return false;
        const allowed = ["name", "company", "role", "channel", "email", "phone", "notes", "jobIds"];
        return Object.keys(intent.command).every((key) => allowed.includes(key)) &&
          sameJsonValue(intent.command, normalizeProfilePatch(intent.command));
      }
      case "contact-archive":
      case "contact-restore":
        return exactKeys(intent, baseKeys) && intent.command === null;
      case "contact-interaction-create":
        return exactKeys(intent, [...baseKeys, "interactionId", "taskId"]) &&
          isEntityId(intent.interactionId, "interaction") &&
          (intent.taskId === null || isEntityId(intent.taskId, "task")) &&
          sameJsonValue(intent.command, normalizeInteraction(
            intent.command as unknown as RecordCareerContactInteractionInput,
          ));
      case "contact-task-create":
        return exactKeys(intent, [...baseKeys, "taskId"]) && isEntityId(intent.taskId, "task") &&
          sameJsonValue(intent.command, normalizeTask(intent.command));
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function sameRow<Row extends object>(left: Row, right: Row, keys: readonly (keyof Row)[]) {
  return keys.every((key) => left[key] === right[key]);
}

function sortedRows<Row extends Readonly<{ id?: string; job_id?: string }>>(rows: readonly Row[]): Row[] {
  return [...rows].sort((left, right) => compareSqliteBinaryText(
    String(left.id ?? left.job_id ?? ""),
    String(right.id ?? right.job_id ?? ""),
  ));
}

function sameRows<Row extends object>(
  left: readonly Row[],
  right: readonly Row[],
  keys: readonly (keyof Row)[],
): boolean {
  return left.length === right.length && left.every((row, index) => sameRow(row, right[index], keys));
}

function isContact(value: unknown): value is Contact {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [...CONTACT_KEYS])) return false;
  const row = value as Contact;
  return typeof row.id === "string" && typeof row.name === "string" &&
    CONTACT_KEYS.filter((key) => !["last_contact_at", "next_follow_up", "archived"].includes(key))
      .every((key) => typeof row[key] === "string") &&
    isNullableString(row.last_contact_at) && isNullableString(row.next_follow_up) &&
    isCanonicalIsoTimestamp(row.created_at) && isCanonicalIsoTimestamp(row.updated_at) &&
    canonicalOrNull(row.last_contact_at) && canonicalOrNull(row.next_follow_up) &&
    (row.archived === 0 || row.archived === 1);
}

function isEntityId(value: unknown, prefix: "contact" | "interaction" | "task"): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}_${ENTITY_UUID_PATTERN.source.slice(1, -1)}$`, "i").test(value);
}

function canonicalOrNull(value: string | null): boolean {
  return value === null || isCanonicalIsoTimestamp(value);
}

function isAssociation(value: unknown): value is ContactJobAssociation {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    exactKeys(value as object, [...ASSOCIATION_KEYS]) &&
    ASSOCIATION_KEYS.every((key) => typeof (value as Record<string, unknown>)[key] === "string") &&
    isCanonicalIsoTimestamp((value as ContactJobAssociation).created_at);
}

function isJob(value: unknown): value is Job {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [...JOB_KEYS])) return false;
  const row = value as Job;
  return typeof row.id === "string" && JOB_KEYS.filter((key) => ![
    "priority", "position", "archived", "applied_at", "deadline", "archived_at",
    "ended_at", "archived_operation_id", "ended_operation_id",
  ].includes(key)).every((key) => typeof row[key] === "string") &&
    isSafeInteger(row.priority) && isSafeInteger(row.position) &&
    (row.archived === 0 || row.archived === 1) &&
    canonicalOrNull(row.applied_at) && canonicalOrNull(row.deadline) &&
    canonicalOrNull(row.archived_at) && canonicalOrNull(row.ended_at) &&
    isCanonicalIsoTimestamp(row.created_at) && isCanonicalIsoTimestamp(row.updated_at) &&
    isNullableString(row.archived_operation_id) && isNullableString(row.ended_operation_id);
}

function isInteraction(value: unknown): value is ContactInteraction {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [...INTERACTION_KEYS])) return false;
  const row = value as ContactInteraction;
  return typeof row.id === "string" && typeof row.contact_id === "string" &&
    isNullableString(row.job_id) &&
    ["interaction_type", "channel", "summary", "notes"].every((key) =>
      typeof (row as unknown as Record<string, unknown>)[key] === "string") &&
    isCanonicalIsoTimestamp(row.occurred_at) && isCanonicalIsoTimestamp(row.created_at) &&
    (row.direction === "outbound" || row.direction === "inbound" || row.direction === "mutual");
}

function isTask(value: unknown): value is Task {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [...TASK_KEYS])) return false;
  const row = value as Task;
  return typeof row.id === "string" && isNullableString(row.job_id) &&
    isNullableString(row.contact_id) && typeof row.title === "string" && typeof row.kind === "string" &&
    canonicalOrNull(row.due_at) && isCanonicalIsoTimestamp(row.created_at) &&
    isSafeInteger(row.priority) &&
    (row.status === "todo" || row.status === "done" || row.status === "canceled") &&
    canonicalOrNull(row.updated_at) && canonicalOrNull(row.canceled_at) &&
    isNullableString(row.cancellation_reason) &&
    (row.lifecycle_previous_status === null || row.lifecycle_previous_status === "todo") &&
    isNullableString(row.lifecycle_operation_id);
}

function isDisplayed(value: unknown): value is CareerContactDisplayedExpected {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value, ["generationId", "generationSequence", "contact", "associations", "jobs"]) ||
    !isCareerWriteGeneration({
      generationId: (value as CareerContactDisplayedExpected).generationId,
      generationSequence: (value as CareerContactDisplayedExpected).generationSequence,
    })) return false;
  const displayed = value as CareerContactDisplayedExpected;
  return (displayed.contact === null || isContact(displayed.contact)) &&
    Array.isArray(displayed.associations) && displayed.associations.every(isAssociation) &&
    Array.isArray(displayed.jobs) && displayed.jobs.every(isJob);
}

function isReceipt(value: unknown): value is CareerContactWriteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value, [
      "purpose", "version", "kind", "operationId", "generationId",
      "generationSequence", "operationAt", "intent", "before", "after", "projectionSha256",
    ])) return false;
  const receipt = value as CareerContactWriteReceipt;
  const kinds: readonly ContactKind[] = [
    "contact-create", "contact-update", "contact-archive", "contact-restore",
    "contact-interaction-create", "contact-task-create",
  ];
  if (receipt.purpose !== PURPOSE || receipt.version !== CAREER_WRITE_RECEIPT_VERSION ||
    !kinds.includes(receipt.kind) || !isCareerWriteOperationId(receipt.operationId, PURPOSE) ||
    !isNormalizedContactIntent(receipt.intent) || receipt.intent.kind !== receipt.kind ||
    receipt.intent.operationId !== receipt.operationId || receipt.intent.operationAt !== receipt.operationAt ||
    !isCareerWriteGeneration({
      generationId: receipt.generationId,
      generationSequence: receipt.generationSequence,
    }) || !isCanonicalIsoTimestamp(receipt.operationAt) ||
    !isDisplayed({
      generationId: receipt.before.generationId,
      generationSequence: receipt.before.generationSequence,
      contact: receipt.before.contact,
      associations: receipt.before.associations,
      jobs: receipt.before.jobs,
    }) || !exactKeys(receipt.before, [
      "generationId", "generationSequence", "contact", "associations", "jobs",
      "interactionId", "taskId",
    ]) || !(receipt.before.interactionId === null || typeof receipt.before.interactionId === "string") ||
    !(receipt.before.taskId === null || typeof receipt.before.taskId === "string") ||
    !receipt.after || typeof receipt.after !== "object" || Array.isArray(receipt.after) ||
    !exactKeys(receipt.after, [
      "generationId", "generationSequence", "contact", "associations", "interaction", "task",
    ]) || !isCareerWriteGeneration({
      generationId: receipt.after.generationId,
      generationSequence: receipt.after.generationSequence,
    }) || !isContact(receipt.after.contact) ||
    !Array.isArray(receipt.after.associations) || !receipt.after.associations.every(isAssociation) ||
    !(receipt.after.interaction === null || isInteraction(receipt.after.interaction)) ||
    !(receipt.after.task === null || isTask(receipt.after.task)) ||
    !sameCareerWriteGeneration(receipt, receipt.before) ||
    !sameCareerWriteGeneration(receipt, receipt.after)) return false;
  const shapeMatchesKind = receipt.kind === "contact-create"
    ? receipt.before.contact === null && receipt.after.interaction === null && receipt.after.task === null
    : receipt.before.contact !== null &&
      (receipt.kind === "contact-interaction-create"
        ? receipt.after.interaction !== null && receipt.before.interactionId === receipt.after.interaction.id
        : receipt.after.interaction === null) &&
      (receipt.kind === "contact-task-create"
        ? receipt.after.task !== null && receipt.before.taskId === receipt.after.task.id
        : receipt.kind !== "contact-interaction-create" ||
          (receipt.after.task?.id ?? null) === receipt.before.taskId);
  return shapeMatchesKind && receiptSemanticsValid(receipt);
}

function uniqueSortedIds(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length && ids.every((id, index) =>
    index === 0 || compareSqliteBinaryText(ids[index - 1], id) < 0);
}

function recomputedContactAfter(receipt: CareerContactWriteReceipt): ContactAfter | null {
  const { before, intent, operationAt } = receipt;
  const generation = {
    generationId: receipt.generationId,
    generationSequence: receipt.generationSequence,
  };
  if (intent.contactId !== receipt.after.contact.id) return null;
  switch (intent.kind) {
    case "contact-create": {
      if (before.contact !== null || before.interactionId !== null || before.taskId !== null) return null;
      const command = intent.command;
      const contact: Contact = {
        id: intent.contactId,
        company: command.company,
        name: command.name,
        role: command.role,
        channel: command.channel,
        email: command.email,
        phone: command.phone,
        last_contact_at: null,
        next_follow_up: null,
        notes: command.notes,
        created_at: operationAt,
        updated_at: operationAt,
        archived: 0,
      };
      return {
        ...generation,
        contact,
        associations: nextAssociations(before, command.jobIds, intent.contactId, operationAt),
        interaction: null,
        task: null,
      };
    }
    case "contact-update": {
      if (!before.contact || before.contact.id !== intent.contactId ||
        before.interactionId !== null || before.taskId !== null ||
        !(Date.parse(operationAt) > Date.parse(before.contact.updated_at))) return null;
      const command = intent.command;
      const targetJobs = command.jobIds ?? associationJobIds(before);
      return {
        ...generation,
        contact: {
          ...before.contact,
          ...(command.name === undefined ? {} : { name: command.name }),
          ...(command.company === undefined ? {} : { company: command.company }),
          ...(command.role === undefined ? {} : { role: command.role }),
          ...(command.channel === undefined ? {} : { channel: command.channel }),
          ...(command.email === undefined ? {} : { email: command.email }),
          ...(command.phone === undefined ? {} : { phone: command.phone }),
          ...(command.notes === undefined ? {} : { notes: command.notes }),
          updated_at: operationAt,
        },
        associations: nextAssociations(before, targetJobs, intent.contactId, operationAt),
        interaction: null,
        task: null,
      };
    }
    case "contact-archive":
    case "contact-restore": {
      const archived = intent.kind === "contact-archive" ? 1 : 0;
      if (!before.contact || before.contact.id !== intent.contactId ||
        before.contact.archived !== 1 - archived || before.interactionId !== null ||
        before.taskId !== null || !(Date.parse(operationAt) > Date.parse(before.contact.updated_at))) return null;
      return {
        ...generation,
        contact: { ...before.contact, archived, updated_at: operationAt },
        associations: sortedRows(before.associations),
        interaction: null,
        task: null,
      };
    }
    case "contact-interaction-create": {
      const command = intent.command;
      if (!before.contact || before.contact.id !== intent.contactId || before.contact.archived !== 0 ||
        command.contactId !== intent.contactId || before.interactionId !== intent.interactionId ||
        before.taskId !== intent.taskId || !(Date.parse(operationAt) > Date.parse(before.contact.updated_at))) return null;
      const targetJobs = sortedIds([
        ...associationJobIds(before),
        ...command.associatedJobIds,
      ]);
      const interaction: ContactInteraction = {
        id: intent.interactionId,
        contact_id: intent.contactId,
        job_id: command.jobId,
        interaction_type: command.interactionType,
        direction: command.direction,
        channel: command.channel,
        summary: command.summary,
        notes: command.notes,
        occurred_at: command.occurredAt ?? operationAt,
        created_at: operationAt,
      };
      const task = command.followUp && intent.taskId
        ? taskRow(intent.taskId, intent.contactId, {
          title: command.followUp.title,
          dueAt: command.followUp.dueAt,
          kind: command.followUp.kind,
          priority: command.followUp.priority,
          jobId: command.followUp.jobId,
        }, operationAt)
        : null;
      if (Boolean(command.followUp) !== Boolean(task)) return null;
      return {
        ...generation,
        contact: { ...before.contact, updated_at: operationAt },
        associations: nextAssociations(before, targetJobs, intent.contactId, operationAt),
        interaction,
        task,
      };
    }
    case "contact-task-create": {
      const command = intent.command;
      if (!before.contact || before.contact.id !== intent.contactId || before.contact.archived !== 0 ||
        command.contactId !== intent.contactId || before.interactionId !== null ||
        before.taskId !== intent.taskId || !(Date.parse(operationAt) > Date.parse(before.contact.updated_at))) return null;
      const targetJobs = sortedIds([
        ...associationJobIds(before),
        ...(command.jobId ? [command.jobId] : []),
      ]);
      return {
        ...generation,
        contact: { ...before.contact, updated_at: operationAt },
        associations: nextAssociations(before, targetJobs, intent.contactId, operationAt),
        interaction: null,
        task: taskRow(intent.taskId, intent.contactId, command, operationAt),
      };
    }
    default:
      return null;
  }
}

function receiptSemanticsValid(receipt: CareerContactWriteReceipt): boolean {
  const { before, after } = receipt;
  const beforeContact = before.contact;
  const contactId = after.contact.id;
  const beforeAssociations = sortedRows(before.associations);
  const afterAssociations = sortedRows(after.associations);
  const beforeAssociationIds = before.associations.map(({ job_id }) => job_id);
  const afterAssociationIds = after.associations.map(({ job_id }) => job_id);
  const jobIds = before.jobs.map(({ id }) => id);
  const coveredIds = [...new Set([...beforeAssociationIds, ...afterAssociationIds])]
    .sort(compareSqliteBinaryText);
  if (!uniqueSortedIds(jobIds) || !uniqueSortedIds(beforeAssociationIds) ||
    !uniqueSortedIds(afterAssociationIds) || !sameRows(before.associations, beforeAssociations, ASSOCIATION_KEYS) ||
    !sameRows(after.associations, afterAssociations, ASSOCIATION_KEYS) ||
    jobIds.length !== coveredIds.length || jobIds.some((id, index) => id !== coveredIds[index]) ||
    before.associations.some((row) => row.contact_id !== (beforeContact?.id ?? "")) ||
    after.associations.some((row) => row.contact_id !== contactId)) return false;
  const expected = recomputedContactAfter(receipt);
  return Boolean(expected && sameRow(after.contact, expected.contact, CONTACT_KEYS) &&
    sameRows(after.associations, expected.associations, ASSOCIATION_KEYS) &&
    ((after.interaction === null && expected.interaction === null) ||
      Boolean(after.interaction && expected.interaction &&
        sameRow(after.interaction, expected.interaction, INTERACTION_KEYS))) &&
    ((after.task === null && expected.task === null) ||
      Boolean(after.task && expected.task && sameRow(after.task, expected.task, TASK_KEYS))));
}

async function rows<Row extends object>(
  runtime: CareerWriteStorageRuntime,
  sql: string,
  params: readonly unknown[] = [],
): Promise<readonly Row[]> {
  return (await runtime.query<Row>(sql, params)).rows;
}

async function readContact(runtime: CareerWriteStorageRuntime, id: string): Promise<Contact | null> {
  return (await rows<Contact>(runtime,
    `SELECT ${CONTACT_KEYS.join(",")} FROM career_contacts WHERE id=? ORDER BY id LIMIT 2`, [id]))[0] ?? null;
}

async function readAssociations(runtime: CareerWriteStorageRuntime, contactId: string): Promise<ContactJobAssociation[]> {
  return sortedRows(await rows<ContactJobAssociation>(runtime,
    `SELECT ${ASSOCIATION_KEYS.join(",")} FROM career_contact_jobs WHERE contact_id=? ORDER BY job_id`,
    [contactId]));
}

async function readJobs(runtime: CareerWriteStorageRuntime, ids: readonly string[]): Promise<Job[]> {
  if (ids.length === 0) return [];
  const result: Job[] = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const chunk = ids.slice(offset, offset + 200);
    const found = await rows<Job>(runtime,
      `SELECT ${JOB_KEYS.join(",")} FROM career_jobs WHERE id IN (${chunk.map(() => "?").join(",")}) ORDER BY id`,
      chunk);
    result.push(...found);
  }
  return sortedRows(result);
}

async function idExists(runtime: CareerWriteStorageRuntime, table: string, id: string): Promise<boolean> {
  return (await rows<{ id: string }>(runtime, `SELECT id FROM ${table} WHERE id=? ORDER BY id LIMIT 2`, [id])).length > 0;
}

function displayedJobIds(displayed: CareerContactDisplayedExpected): string[] {
  return sortedIds(displayed.jobs.map(({ id }) => id));
}

function associationJobIds(displayed: CareerContactDisplayedExpected): string[] {
  return sortedIds(displayed.associations.map(({ job_id }) => job_id));
}

async function displayedStateExact(
  runtime: CareerWriteStorageRuntime,
  displayed: CareerContactDisplayedExpected,
): Promise<boolean> {
  const contactId = displayed.contact?.id;
  if (!contactId) {
    return displayed.associations.length === 0 &&
      sameRows(await readJobs(runtime, displayedJobIds(displayed)), sortedRows(displayed.jobs), [...JOB_KEYS]);
  }
  const [contact, associations, jobs] = await Promise.all([
    readContact(runtime, contactId),
    readAssociations(runtime, contactId),
    readJobs(runtime, displayedJobIds(displayed)),
  ]);
  return Boolean(contact && sameRow(contact, displayed.contact!, [...CONTACT_KEYS])) &&
    sameRows(associations, sortedRows(displayed.associations), [...ASSOCIATION_KEYS]) &&
    sameRows(jobs, sortedRows(displayed.jobs), [...JOB_KEYS]);
}

function requireJobCoverage(displayed: CareerContactDisplayedExpected, required: readonly string[]): void {
  const actual = new Set(displayed.jobs.map(({ id }) => id));
  if (required.some((id) => !actual.has(id)) ||
    associationJobIds(displayed).some((id) => !actual.has(id))) {
    throw careerWriteError("invalid_input", "职位显示快照不完整。没有准备联系人写入。");
  }
}

function nextAssociations(
  before: CareerContactDisplayedExpected,
  targetIds: readonly string[],
  contactId: string,
  operationAt: string,
): ContactJobAssociation[] {
  const previous = new Map(before.associations.map((row) => [row.job_id, row]));
  return targetIds.map((jobId) => previous.get(jobId) ?? {
    contact_id: contactId,
    job_id: jobId,
    created_at: operationAt,
  }).sort((left, right) => compareSqliteBinaryText(left.job_id, right.job_id));
}

function taskRow(
  id: string,
  contactId: string,
  input: Omit<TaskInput, "contactId">,
  operationAt: string,
): Task {
  return {
    id,
    job_id: input.jobId,
    contact_id: contactId,
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
}

function operationAt(runtime: CareerWriteStorageRuntime, contact: Contact | null): string {
  return contact
    ? strictlyLaterTimestamp(runtime.now(), [contact.updated_at])
    : new Date(runtime.now()).toISOString();
}

function receiptEntityId(receipt: CareerContactWriteReceipt): string {
  if (receipt.kind === "contact-interaction-create") return receipt.after.interaction!.id;
  if (receipt.kind === "contact-task-create") return receipt.after.task!.id;
  return receipt.after.contact.id;
}

function broadcastReason(kind: ContactKind): string {
  return `career-${kind.replaceAll("contact-", "contact-")}`;
}

function sqlEquals(prefix: string, row: Record<string, unknown>, keys: readonly string[]) {
  return {
    sql: `${prefix} AND ${keys.map((key) => `${key} IS ?`).join(" AND ")}`,
    params: keys.map((key) => row[key]),
  };
}

function beforePredicates(receipt: CareerContactWriteReceipt) {
  const predicates = [markerAbsentPredicate(receipt.operationId)];
  const before = receipt.before;
  if (before.contact === null) {
    predicates.push({
      sql: "NOT EXISTS(SELECT 1 FROM career_contacts WHERE id=?)",
      params: [receipt.after.contact.id],
    });
  } else {
    predicates.push(sqlEquals(
      "EXISTS(SELECT 1 FROM career_contacts WHERE id=?",
      before.contact as unknown as Record<string, unknown>,
      CONTACT_KEYS.filter((key) => key !== "id"),
    ));
    const last = predicates[predicates.length - 1];
    predicates[predicates.length - 1] = {
      sql: `${last.sql})`,
      params: [before.contact.id, ...last.params],
    };
    predicates.push({
      sql: "(SELECT COUNT(*) FROM career_contact_jobs WHERE contact_id=?)=?",
      params: [before.contact.id, before.associations.length],
    });
    for (const association of before.associations) {
      predicates.push({
        sql: `EXISTS(SELECT 1 FROM career_contact_jobs
          WHERE contact_id=? AND job_id=? AND created_at IS ?)`,
        params: [association.contact_id, association.job_id, association.created_at],
      });
    }
  }
  for (const job of before.jobs) {
    const keys = JOB_KEYS.filter((key) => key !== "id");
    predicates.push({
      sql: `EXISTS(SELECT 1 FROM career_jobs WHERE id=? AND ${keys.map((key) => `${key} IS ?`).join(" AND ")})`,
      params: [job.id, ...keys.map((key) => job[key])],
    });
  }
  if (before.interactionId) predicates.push({
    sql: "NOT EXISTS(SELECT 1 FROM career_contact_interactions WHERE id=?)",
    params: [before.interactionId],
  });
  if (before.taskId) predicates.push({
    sql: "NOT EXISTS(SELECT 1 FROM career_tasks WHERE id=?)",
    params: [before.taskId],
  });
  return predicates;
}

function contactInsert(row: Contact): SqlStatement {
  return {
    sql: `INSERT INTO career_contacts(${CONTACT_KEYS.join(",")}) VALUES(${CONTACT_KEYS.map(() => "?").join(",")})`,
    params: CONTACT_KEYS.map((key) => row[key]),
  };
}

function contactUpdate(row: Contact): SqlStatement {
  const keys = CONTACT_KEYS.filter((key) => key !== "id");
  return {
    sql: `UPDATE career_contacts SET ${keys.map((key) => `${key}=?`).join(",")} WHERE id=?`,
    params: [...keys.map((key) => row[key]), row.id],
  };
}

function associationStatements(contactId: string, rowsValue: readonly ContactJobAssociation[]): SqlStatement[] {
  return [
    { sql: "DELETE FROM career_contact_jobs WHERE contact_id=?", params: [contactId] },
    ...rowsValue.map((row) => ({
      sql: "INSERT INTO career_contact_jobs(contact_id,job_id,created_at) VALUES(?,?,?)",
      params: [row.contact_id, row.job_id, row.created_at],
    })),
  ];
}

function receiptStatements(receipt: CareerContactWriteReceipt): SqlStatement[] {
  const statements: SqlStatement[] = beforePredicates(receipt).map(abortUnless);
  const after = receipt.after;
  statements.push(receipt.before.contact === null ? contactInsert(after.contact) : contactUpdate(after.contact));
  statements.push(...associationStatements(after.contact.id, after.associations));
  if (after.interaction) statements.push({
    sql: `INSERT INTO career_contact_interactions(${INTERACTION_KEYS.join(",")}) VALUES(${INTERACTION_KEYS.map(() => "?").join(",")})`,
    params: INTERACTION_KEYS.map((key) => after.interaction![key]),
  });
  if (after.task) statements.push({
    sql: `INSERT INTO career_tasks(${TASK_KEYS.join(",")}) VALUES(${TASK_KEYS.map(() => "?").join(",")})`,
    params: TASK_KEYS.map((key) => after.task![key]),
  });
  statements.push(markerStatement(receipt, receiptEntityId(receipt)));
  return statements;
}

export function createCareerContactWriteStorageService(
  runtime: CareerWriteStorageRuntime = defaultCareerWriteStorageRuntime,
) {
  async function prepareBase(
    displayedValue: CareerContactDisplayedExpected,
    build: (
      displayed: CareerContactDisplayedExpected,
      operationId: string,
      at: string,
    ) => {
      kind: ContactKind;
      intent: CareerContactWriteIntent;
      before: ContactBefore;
      after: ContactAfter;
    },
  ): Promise<CareerContactWriteReceipt> {
    const displayedInput = jsonClone<CareerContactDisplayedExpected>(
      displayedValue,
      CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
      "联系人显示快照",
    );
    if (!isDisplayed(displayedInput)) throw careerWriteError("invalid_input", "联系人显示快照无效。");
    const displayed: CareerContactDisplayedExpected = {
      ...displayedInput,
      associations: sortedRows(displayedInput.associations),
      jobs: sortedRows(displayedInput.jobs),
    };
    return withCareerWritePrepareLock(runtime, async () => {
      const generation = await readCurrentCareerWriteGeneration(runtime);
      requireCurrentCareerWriteGeneration(generation, displayed);
      if (!await displayedStateExact(runtime, displayed)) {
        throw careerWriteError("changed", "联系人或关联职位已经变化；没有准备写入。");
      }
      const operationId = generatedCareerWriteOperationId(runtime, PURPOSE);
      if (await readCareerWriteMarker(runtime, operationId)) {
        throw careerWriteError("changed", "联系人操作标识已被占用；没有准备写入。");
      }
      const at = operationAt(runtime, displayed.contact);
      const planned = build(displayed, operationId, at);
      const coveredJobIds = [...new Set([
        ...planned.before.associations.map(({ job_id }) => job_id),
        ...planned.after.associations.map(({ job_id }) => job_id),
      ])].sort(compareSqliteBinaryText);
      const projectedJobIds = planned.before.jobs.map(({ id }) => id);
      if (coveredJobIds.length !== projectedJobIds.length ||
        coveredJobIds.some((id, index) => id !== projectedJobIds[index])) {
        throw careerWriteError("invalid_input", "职位显示快照包含未被本次联系人命令使用的记录。");
      }
      if (planned.before.contact === null &&
        await idExists(runtime, "career_contacts", planned.after.contact.id)) {
        throw careerWriteError("changed", "新的联系人标识已被占用；没有准备写入。");
      }
      if (planned.before.interactionId && await idExists(runtime, "career_contact_interactions", planned.before.interactionId)) {
        throw careerWriteError("changed", "新的联系记录标识已被占用；没有准备写入。");
      }
      if (planned.before.taskId && await idExists(runtime, "career_tasks", planned.before.taskId)) {
        throw careerWriteError("changed", "新的待办标识已被占用；没有准备写入。");
      }
      return sealCareerWriteReceipt<CareerContactWriteReceipt>({
        purpose: PURPOSE,
        version: CAREER_WRITE_RECEIPT_VERSION,
        kind: planned.kind,
        operationId,
        ...generation,
        operationAt: at,
        intent: planned.intent,
        before: planned.before,
        after: planned.after,
      });
    });
  }

  async function prepareCreate(
    inputValue: CreateCareerContactInput,
    displayedValue: CareerContactDisplayedExpected,
  ) {
    const input = normalizeProfile(jsonClone(inputValue, CAREER_WRITE_RECEIPT_MAX_JSON_BYTES, "联系人输入"));
    return prepareBase(displayedValue, (displayed, operationId, at) => {
      if (displayed.contact !== null || displayed.associations.length !== 0) {
        throw careerWriteError("invalid_input", "联系人创建快照必须为空。");
      }
      requireJobCoverage(displayed, input.jobIds);
      if (displayedJobIds(displayed).some((id) => !input.jobIds.includes(id))) {
        throw careerWriteError("invalid_input", "联系人创建职位快照包含多余记录。");
      }
      const contactId = generatedId(runtime, "contact");
      const contact: Contact = {
        id: contactId,
        company: input.company,
        name: input.name,
        role: input.role,
        channel: input.channel,
        email: input.email,
        phone: input.phone,
        last_contact_at: null,
        next_follow_up: null,
        notes: input.notes,
        created_at: at,
        updated_at: at,
        archived: 0,
      };
      return {
        kind: "contact-create",
        intent: {
          kind: "contact-create",
          operationId,
          operationAt: at,
          contactId,
          command: input,
        },
        before: { ...displayed, interactionId: null, taskId: null },
        after: {
          generationId: displayed.generationId,
          generationSequence: displayed.generationSequence,
          contact,
          associations: nextAssociations(displayed, input.jobIds, contactId, at),
          interaction: null,
          task: null,
        },
      };
    });
  }

  async function prepareUpdate(
    inputValue: UpdateCareerContactInput,
    displayedValue: CareerContactDisplayedExpected,
  ) {
    const input = normalizeProfilePatch(jsonClone(inputValue, CAREER_WRITE_RECEIPT_MAX_JSON_BYTES, "联系人输入"));
    return prepareBase(displayedValue, (displayed, operationId, at) => {
      if (!displayed.contact) throw careerWriteError("invalid_input", "联系人更新快照为空。");
      const jobIds = input.jobIds ?? associationJobIds(displayed);
      requireJobCoverage(displayed, jobIds);
      const contact: Contact = {
        ...displayed.contact,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.company === undefined ? {} : { company: input.company }),
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.channel === undefined ? {} : { channel: input.channel }),
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.phone === undefined ? {} : { phone: input.phone }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        updated_at: at,
      };
      return {
        kind: "contact-update",
        intent: {
          kind: "contact-update",
          operationId,
          operationAt: at,
          contactId: displayed.contact.id,
          command: input,
        },
        before: { ...displayed, interactionId: null, taskId: null },
        after: {
          generationId: displayed.generationId,
          generationSequence: displayed.generationSequence,
          contact,
          associations: nextAssociations(displayed, jobIds, contact.id, at),
          interaction: null,
          task: null,
        },
      };
    });
  }

  async function prepareArchiveState(
    displayedValue: CareerContactDisplayedExpected,
    archived: boolean,
  ) {
    return prepareBase(displayedValue, (displayed, operationId, at) => {
      if (!displayed.contact || Boolean(displayed.contact.archived) === archived) {
        throw careerWriteError("invalid_input", "联系人归档目标与显示状态不匹配。");
      }
      return {
        kind: archived ? "contact-archive" : "contact-restore",
        intent: {
          kind: archived ? "contact-archive" : "contact-restore",
          operationId,
          operationAt: at,
          contactId: displayed.contact.id,
          command: null,
        },
        before: { ...displayed, interactionId: null, taskId: null },
        after: {
          generationId: displayed.generationId,
          generationSequence: displayed.generationSequence,
          contact: { ...displayed.contact, archived: archived ? 1 : 0, updated_at: at },
          associations: sortedRows(displayed.associations),
          interaction: null,
          task: null,
        },
      };
    });
  }

  async function prepareInteraction(
    inputValue: RecordCareerContactInteractionInput,
    displayedValue: CareerContactDisplayedExpected,
  ) {
    const input = normalizeInteraction(jsonClone(inputValue, CAREER_WRITE_RECEIPT_MAX_JSON_BYTES, "联系记录输入"));
    return prepareBase(displayedValue, (displayed, operationId, at) => {
      if (!displayed.contact || displayed.contact.archived === 1) {
        throw careerWriteError("changed", "联系人已归档或不存在；没有准备联系记录。");
      }
      if (input.contactId !== displayed.contact.id) {
        throw careerWriteError("changed", "联系人标识与显示快照不一致；没有准备联系记录。");
      }
      const requiredJobs = sortedIds([
        ...associationJobIds(displayed),
        ...input.associatedJobIds,
      ]);
      requireJobCoverage(displayed, requiredJobs);
      const interactionId = generatedId(runtime, "interaction");
      const taskId = input.followUp ? generatedId(runtime, "task") : null;
      const interaction: ContactInteraction = {
        id: interactionId,
        contact_id: displayed.contact.id,
        job_id: input.jobId,
        interaction_type: input.interactionType,
        direction: input.direction,
        channel: input.channel,
        summary: input.summary,
        notes: input.notes,
        occurred_at: input.occurredAt ?? at,
        created_at: at,
      };
      const task = input.followUp && taskId ? taskRow(taskId, displayed.contact.id, {
        title: input.followUp.title,
        dueAt: input.followUp.dueAt,
        kind: input.followUp.kind,
        priority: input.followUp.priority,
        jobId: input.followUp.jobId,
      }, at) : null;
      return {
        kind: "contact-interaction-create",
        intent: {
          kind: "contact-interaction-create",
          operationId,
          operationAt: at,
          contactId: displayed.contact.id,
          interactionId,
          taskId,
          command: input,
        },
        before: { ...displayed, interactionId, taskId },
        after: {
          generationId: displayed.generationId,
          generationSequence: displayed.generationSequence,
          contact: { ...displayed.contact, updated_at: at },
          associations: nextAssociations(displayed, requiredJobs, displayed.contact.id, at),
          interaction,
          task,
        },
      };
    });
  }

  async function prepareTask(
    inputValue: CreateCareerContactTaskInput,
    displayedValue: CareerContactDisplayedExpected,
  ) {
    const input = normalizeTask(jsonClone(inputValue, CAREER_WRITE_RECEIPT_MAX_JSON_BYTES, "联系人待办输入"));
    return prepareBase(displayedValue, (displayed, operationId, at) => {
      if (!displayed.contact || displayed.contact.archived === 1) {
        throw careerWriteError("changed", "联系人已归档或不存在；没有准备待办。");
      }
      if (input.contactId !== displayed.contact.id) {
        throw careerWriteError("changed", "联系人标识与显示快照不一致；没有准备待办。");
      }
      const targetJobs = sortedIds([
        ...associationJobIds(displayed),
        ...(input.jobId ? [input.jobId] : []),
      ]);
      requireJobCoverage(displayed, targetJobs);
      const taskId = generatedId(runtime, "task");
      return {
        kind: "contact-task-create",
        intent: {
          kind: "contact-task-create",
          operationId,
          operationAt: at,
          contactId: displayed.contact.id,
          taskId,
          command: input,
        },
        before: { ...displayed, interactionId: null, taskId },
        after: {
          generationId: displayed.generationId,
          generationSequence: displayed.generationSequence,
          contact: { ...displayed.contact, updated_at: at },
          associations: nextAssociations(displayed, targetJobs, displayed.contact.id, at),
          interaction: null,
          task: taskRow(taskId, displayed.contact.id, input, at),
        },
      };
    });
  }

  async function stateUnlocked(
    receipt: CareerContactWriteReceipt,
  ): Promise<Exclude<CareerWriteInspection, "still_unknown" | "invalid_receipt">> {
    const generation = await readCurrentCareerWriteGeneration(runtime);
    if (!sameCareerWriteGeneration(generation, receipt)) return "changed";
    const marker = await readCareerWriteMarker(runtime, receipt.operationId);
    if (marker) return exactCareerWriteMarker(marker, receipt, receiptEntityId(receipt))
      ? "exact_saved"
      : "changed";
    const displayed: CareerContactDisplayedExpected = {
      generationId: receipt.before.generationId,
      generationSequence: receipt.before.generationSequence,
      contact: receipt.before.contact,
      associations: receipt.before.associations,
      jobs: receipt.before.jobs,
    };
    if (!await displayedStateExact(runtime, displayed)) return "changed";
    if (receipt.before.contact === null && await idExists(runtime, "career_contacts", receipt.after.contact.id)) return "changed";
    if (receipt.before.interactionId && await idExists(runtime, "career_contact_interactions", receipt.before.interactionId)) return "changed";
    if (receipt.before.taskId && await idExists(runtime, "career_tasks", receipt.before.taskId)) return "changed";
    return "expected";
  }

  async function inspect(value: unknown): Promise<CareerWriteInspection> {
    let receipt: CareerContactWriteReceipt;
    try {
      receipt = jsonClone<CareerContactWriteReceipt>(value);
      if (!isReceipt(receipt) || !await careerWriteReceiptHashIsValid(receipt)) return "invalid_receipt";
    } catch {
      return "invalid_receipt";
    }
    try { return await runtime.withExclusiveLock(() => stateUnlocked(receipt)); }
    catch { return "still_unknown"; }
  }

  async function commit(value: unknown): Promise<CareerContactWriteResult> {
    let receipt: CareerContactWriteReceipt;
    try {
      receipt = jsonClone<CareerContactWriteReceipt>(value);
      if (!isReceipt(receipt) || !await careerWriteReceiptHashIsValid(receipt)) {
        throw careerWriteError("invalid_receipt", "联系人写入回执无效；没有改动资料。");
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "invalid_receipt") throw error;
      throw careerWriteError("invalid_receipt", "联系人写入回执无法验证；没有改动资料。");
    }
    const entityId = receiptEntityId(receipt);
    let entered = false;
    try {
      return await runtime.withExclusiveLock(async () => {
        entered = true;
        const before = await stateUnlocked(receipt);
        if (before === "exact_saved") {
          safeCareerWriteBroadcast(runtime, broadcastReason(receipt.kind));
          return { outcome: "already_saved", receipt, entityId };
        }
        if (before === "changed") return { outcome: "changed", receipt, entityId, retryable: false };
        try { await runtime.batch(receiptStatements(receipt)); }
        catch { /* Transaction may have committed before the response was lost. */ }
        const after = await stateUnlocked(receipt);
        if (after === "exact_saved") {
          safeCareerWriteBroadcast(runtime, broadcastReason(receipt.kind));
          return { outcome: "saved", receipt, entityId };
        }
        if (after === "expected") {
          throw careerWriteError("write_failed", "这次联系人写入确定没有提交；可保留原回执重试。", receipt);
        }
        return { outcome: "changed", receipt, entityId, retryable: false };
      });
    } catch (error) {
      if (error instanceof Error && "code" in error) throw error;
      if (!entered) throw careerWriteError("lock_unavailable", "无法取得安全的联系人写入锁；没有开始写入。");
      return { outcome: "outcome_uncertain", receipt, entityId, retryable: true };
    }
  }

  return {
    prepareCareerContactCreate: prepareCreate,
    prepareCareerContactUpdate: prepareUpdate,
    prepareCareerContactArchive: (displayed: CareerContactDisplayedExpected) => prepareArchiveState(displayed, true),
    prepareCareerContactRestore: (displayed: CareerContactDisplayedExpected) => prepareArchiveState(displayed, false),
    prepareCareerContactInteraction: prepareInteraction,
    prepareCareerContactTask: prepareTask,
    inspectCareerContactWrite: inspect,
    commitCareerContactWrite: commit,
  } as const;
}

const defaultService = createCareerContactWriteStorageService();

/** Strict synchronous envelope validation for durable UI journals. */
export function isCareerContactWriteReceipt(
  value: unknown,
): value is CareerContactWriteReceipt {
  return isReceipt(value);
}

export const prepareCareerContactCreate = defaultService.prepareCareerContactCreate;
export const prepareCareerContactUpdate = defaultService.prepareCareerContactUpdate;
export const prepareCareerContactArchive = defaultService.prepareCareerContactArchive;
export const prepareCareerContactRestore = defaultService.prepareCareerContactRestore;
export const prepareCareerContactInteraction = defaultService.prepareCareerContactInteraction;
export const prepareCareerContactTask = defaultService.prepareCareerContactTask;
export const inspectCareerContactWrite = defaultService.inspectCareerContactWrite;
export const commitCareerContactWrite = defaultService.commitCareerContactWrite;
