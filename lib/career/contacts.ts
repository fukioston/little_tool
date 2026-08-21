import { localDb } from "@/lib/local-db/client";
import {
  createCareerContactArchiveStatements,
  createCareerContactInsertStatements,
  createCareerContactInteractionStatements,
  createCareerContactTaskStatements,
  createCareerContactUpdateStatements,
} from "./contact-plan";
import { newId, runCareerBatch } from "./db";
import { withCareerReadLock, withCareerWriteLock } from "./lock";
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
}>;

const DB = "career" as const;
const PROFILE_LIMITS = {
  name: 160,
  company: 240,
  role: 240,
  channel: 80,
  email: 320,
  phone: 80,
  notes: 20_000,
} as const;

function unwrapRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
}

function requiredText(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string") throw new TypeError(`${label}不能为空`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${label}不能为空`);
  if (normalized.length > maximum) throw new TypeError(`${label}过长`);
  return normalized;
}

function optionalText(value: unknown, label: string, maximum: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new TypeError(`${label}格式不正确`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new TypeError(`${label}过长`);
  return normalized;
}

function canonicalDate(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${label}不是有效时间`);
  return parsed.toISOString();
}

function optionalDate(value: string | null | undefined, label: string): string | null {
  return value === undefined || value === null || value === ""
    ? null
    : canonicalDate(value, label);
}

function priority(value: number | undefined): number {
  const normalized = value ?? 1;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 3) {
    throw new TypeError("优先级需要是 1 到 3 的整数");
  }
  return normalized;
}

function databaseId(value: unknown, label: string): string {
  return requiredText(value, label, 200);
}

function uniqueJobIds(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new TypeError("岗位关联需要是数组");
  return [...new Set(values.map((value) => databaseId(value, "岗位 ID")))];
}

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return unwrapRows<T>(await localDb.query(DB, sql, params));
}

export async function loadCareerContacts(
  scope: CareerContactScope = "active",
): Promise<Contact[]> {
  if (scope !== "active" && scope !== "archived" && scope !== "all") {
    throw new TypeError("联系人范围不受支持");
  }
  const where = scope === "all"
    ? ""
    : `WHERE archived = ${scope === "active" ? 0 : 1}`;
  return withCareerReadLock(() => query<Contact>(
    `SELECT * FROM career_contacts ${where}
      ORDER BY archived, COALESCE(next_follow_up, '9999-12-31T23:59:59.999Z'), name`,
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

export async function createCareerContact(
  input: CreateCareerContactInput,
): Promise<string> {
  const contactId = newId("contact");
  const now = new Date().toISOString();
  const statements = createCareerContactInsertStatements({
    id: contactId,
    name: requiredText(input.name, "姓名", PROFILE_LIMITS.name),
    company: optionalText(input.company, "公司", PROFILE_LIMITS.company),
    role: optionalText(input.role, "角色", PROFILE_LIMITS.role),
    channel: optionalText(input.channel, "渠道", PROFILE_LIMITS.channel),
    email: optionalText(input.email, "邮箱", PROFILE_LIMITS.email),
    phone: optionalText(input.phone, "电话", PROFILE_LIMITS.phone),
    notes: optionalText(input.notes, "备注", PROFILE_LIMITS.notes),
    createdAt: now,
    updatedAt: now,
    jobIds: uniqueJobIds(input.jobIds),
  });
  await withCareerWriteLock((context) => runCareerBatch(statements, context));
  return contactId;
}

export async function updateCareerContact(
  contactId: string,
  input: UpdateCareerContactInput,
): Promise<void> {
  const fields: Record<string, string> = {};
  const definitions = [
    ["name", "姓名", PROFILE_LIMITS.name],
    ["company", "公司", PROFILE_LIMITS.company],
    ["role", "角色", PROFILE_LIMITS.role],
    ["channel", "渠道", PROFILE_LIMITS.channel],
    ["email", "邮箱", PROFILE_LIMITS.email],
    ["phone", "电话", PROFILE_LIMITS.phone],
    ["notes", "备注", PROFILE_LIMITS.notes],
  ] as const;
  for (const [field, label, maximum] of definitions) {
    if (input[field] !== undefined) {
      fields[field] = field === "name"
        ? requiredText(input[field], label, maximum)
        : optionalText(input[field], label, maximum);
    }
  }
  const statements = createCareerContactUpdateStatements({
    contactId: databaseId(contactId, "联系人 ID"),
    fields,
    updatedAt: new Date().toISOString(),
    ...(input.jobIds === undefined ? {} : { jobIds: uniqueJobIds(input.jobIds) }),
  });
  await withCareerWriteLock((context) => runCareerBatch(statements, context));
}

export async function recordCareerContactInteraction(
  input: RecordCareerContactInteractionInput,
): Promise<RecordCareerContactInteractionResult> {
  const interactionId = newId("interaction");
  const taskId = input.followUp ? newId("task") : null;
  const now = new Date().toISOString();
  const jobId = input.jobId ? databaseId(input.jobId, "岗位 ID") : null;
  const followUpJobId = input.followUp?.jobId
    ? databaseId(input.followUp.jobId, "跟进任务岗位 ID")
    : null;
  const associatedJobIds = uniqueJobIds([
    ...(input.associatedJobIds ?? []),
    ...(jobId ? [jobId] : []),
    ...(followUpJobId ? [followUpJobId] : []),
  ]);
  const direction = input.direction ?? "outbound";
  if (!(["outbound", "inbound", "mutual"] as const).includes(direction)) {
    throw new TypeError("互动方向不受支持");
  }
  const statements = createCareerContactInteractionStatements({
    id: interactionId,
    contactId: databaseId(input.contactId, "联系人 ID"),
    jobId,
    interactionType: optionalText(input.interactionType ?? "message", "互动类型", 80),
    direction,
    channel: optionalText(input.channel ?? "其他", "互动渠道", PROFILE_LIMITS.channel),
    summary: requiredText(input.summary, "互动摘要", 1_000),
    notes: optionalText(input.notes, "互动备注", PROFILE_LIMITS.notes),
    occurredAt: input.occurredAt
      ? canonicalDate(input.occurredAt, "互动时间")
      : now,
    createdAt: now,
    associatedJobIds,
    followUp: input.followUp && taskId
      ? {
          id: taskId,
          title: requiredText(input.followUp.title, "跟进任务", 500),
          dueAt: optionalDate(input.followUp.dueAt, "跟进时间"),
          kind: optionalText(input.followUp.kind ?? "跟进", "任务类型", 80),
          priority: priority(input.followUp.priority),
          jobId: followUpJobId ?? jobId,
        }
      : null,
  });
  await withCareerWriteLock((context) => runCareerBatch(statements, context));
  return { interactionId, taskId };
}

export async function createCareerContactTask(
  input: CreateCareerContactTaskInput,
): Promise<string> {
  const taskId = newId("task");
  const now = new Date().toISOString();
  const statements = createCareerContactTaskStatements({
    id: taskId,
    contactId: databaseId(input.contactId, "联系人 ID"),
    title: requiredText(input.title, "跟进任务", 500),
    dueAt: optionalDate(input.dueAt, "跟进时间"),
    kind: optionalText(input.kind ?? "跟进", "任务类型", 80),
    priority: priority(input.priority),
    jobId: input.jobId ? databaseId(input.jobId, "岗位 ID") : null,
    createdAt: now,
  });
  await withCareerWriteLock((context) => runCareerBatch(statements, context));
  return taskId;
}

async function setCareerContactArchived(contactId: string, archived: boolean) {
  const statements = createCareerContactArchiveStatements(
    databaseId(contactId, "联系人 ID"),
    archived,
    new Date().toISOString(),
  );
  await withCareerWriteLock((context) => runCareerBatch(statements, context));
}

export function archiveCareerContact(contactId: string): Promise<void> {
  return setCareerContactArchived(contactId, true);
}

export function restoreCareerContact(contactId: string): Promise<void> {
  return setCareerContactArchived(contactId, false);
}
