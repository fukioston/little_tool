import type { SqlStatement } from "../local-db/types";

export type PlannedContactProfile = Readonly<{
  id: string;
  name: string;
  company: string;
  role: string;
  channel: string;
  email: string;
  phone: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  jobIds: readonly string[];
}>;

export type PlannedContactUpdate = Readonly<{
  contactId: string;
  fields: Readonly<Record<string, string>>;
  updatedAt: string;
  jobIds?: readonly string[];
}>;

export type PlannedContactInteraction = Readonly<{
  id: string;
  contactId: string;
  jobId: string | null;
  interactionType: string;
  direction: "outbound" | "inbound" | "mutual";
  channel: string;
  summary: string;
  notes: string;
  occurredAt: string;
  createdAt: string;
  associatedJobIds: readonly string[];
  followUp: Readonly<{
    id: string;
    title: string;
    dueAt: string | null;
    kind: string;
    priority: number;
    jobId: string | null;
  }> | null;
}>;

export type PlannedContactTask = Readonly<{
  id: string;
  contactId: string;
  title: string;
  dueAt: string | null;
  kind: string;
  priority: number;
  jobId: string | null;
  createdAt: string;
}>;

const GUARD_TABLE = "temp.__career_contact_write_guard";
const PROFILE_COLUMNS = new Set([
  "name",
  "company",
  "role",
  "channel",
  "email",
  "phone",
  "notes",
]);

function contactGuard(contactId: string, activeOnly: boolean): SqlStatement[] {
  return [
    {
      sql: `CREATE TEMP TABLE __career_contact_write_guard (
        value INTEGER NOT NULL CHECK (value = 1)
      )`,
    },
    {
      sql: `INSERT INTO ${GUARD_TABLE}(value)
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM career_contacts
          WHERE id = ?${activeOnly ? " AND archived = 0" : ""}
        ) THEN 1 ELSE 0 END`,
      params: [contactId],
    },
  ];
}

function dropGuard(): SqlStatement {
  return { sql: `DROP TABLE ${GUARD_TABLE}` };
}

function associationStatements(
  contactId: string,
  jobIds: readonly string[],
  createdAt: string,
): SqlStatement[] {
  return jobIds.map((jobId) => ({
    sql: `INSERT OR IGNORE INTO career_contact_jobs
      (contact_id, job_id, created_at) VALUES (?, ?, ?)`,
    params: [contactId, jobId, createdAt],
  }));
}

export function createCareerContactInsertStatements(
  contact: PlannedContactProfile,
): SqlStatement[] {
  return [
    {
      sql: `INSERT INTO career_contacts
        (id, company, name, role, channel, email, phone,
          last_contact_at, next_follow_up, notes, created_at, updated_at, archived)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 0)`,
      params: [
        contact.id,
        contact.company,
        contact.name,
        contact.role,
        contact.channel,
        contact.email,
        contact.phone,
        contact.notes,
        contact.createdAt,
        contact.updatedAt,
      ],
    },
    ...associationStatements(contact.id, contact.jobIds, contact.createdAt),
  ];
}

export function createCareerContactUpdateStatements(
  update: PlannedContactUpdate,
): SqlStatement[] {
  const fields = Object.entries(update.fields);
  for (const [column] of fields) {
    if (!PROFILE_COLUMNS.has(column)) {
      throw new TypeError(`Unsupported Career contact profile field: ${column}`);
    }
  }
  const statements: SqlStatement[] = [
    ...contactGuard(update.contactId, false),
    {
      sql: `UPDATE career_contacts SET ${[
        ...fields.map(([column]) => `${column} = ?`),
        "updated_at = ?",
      ].join(", ")} WHERE id = ?`,
      params: [...fields.map(([, value]) => value), update.updatedAt, update.contactId],
    },
  ];
  if (update.jobIds) {
    statements.push(
      {
        sql: "DELETE FROM career_contact_jobs WHERE contact_id = ?",
        params: [update.contactId],
      },
      ...associationStatements(update.contactId, update.jobIds, update.updatedAt),
    );
  }
  statements.push(dropGuard());
  return statements;
}

export function createCareerContactInteractionStatements(
  interaction: PlannedContactInteraction,
): SqlStatement[] {
  const nextFollowUp = interaction.followUp?.dueAt ?? null;
  return [
    ...contactGuard(interaction.contactId, true),
    {
      sql: `INSERT INTO career_contact_interactions
        (id, contact_id, job_id, interaction_type, direction, channel,
          summary, notes, occurred_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        interaction.id,
        interaction.contactId,
        interaction.jobId,
        interaction.interactionType,
        interaction.direction,
        interaction.channel,
        interaction.summary,
        interaction.notes,
        interaction.occurredAt,
        interaction.createdAt,
      ],
    },
    ...associationStatements(
      interaction.contactId,
      interaction.associatedJobIds,
      interaction.createdAt,
    ),
    ...(interaction.followUp
      ? [{
          sql: `INSERT INTO career_tasks
            (id, job_id, contact_id, title, due_at, kind, priority, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?)`,
          params: [
            interaction.followUp.id,
            interaction.followUp.jobId,
            interaction.contactId,
            interaction.followUp.title,
            interaction.followUp.dueAt,
            interaction.followUp.kind,
            interaction.followUp.priority,
            interaction.createdAt,
          ],
        } satisfies SqlStatement]
      : []),
    {
      sql: `UPDATE career_contacts
        SET last_contact_at = CASE
            WHEN last_contact_at IS NULL OR last_contact_at < ? THEN ?
            ELSE last_contact_at
          END,
          next_follow_up = CASE WHEN ? IS NULL THEN next_follow_up ELSE ? END,
          updated_at = ?
        WHERE id = ?`,
      params: [
        interaction.occurredAt,
        interaction.occurredAt,
        nextFollowUp,
        nextFollowUp,
        interaction.createdAt,
        interaction.contactId,
      ],
    },
    dropGuard(),
  ];
}

export function createCareerContactTaskStatements(
  task: PlannedContactTask,
): SqlStatement[] {
  return [
    ...contactGuard(task.contactId, true),
    {
      sql: `INSERT INTO career_tasks
        (id, job_id, contact_id, title, due_at, kind, priority, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?)`,
      params: [
        task.id,
        task.jobId,
        task.contactId,
        task.title,
        task.dueAt,
        task.kind,
        task.priority,
        task.createdAt,
      ],
    },
    ...(task.jobId
      ? associationStatements(task.contactId, [task.jobId], task.createdAt)
      : []),
    {
      sql: `UPDATE career_contacts
        SET next_follow_up = CASE
            WHEN ? IS NULL THEN next_follow_up
            WHEN next_follow_up IS NULL OR next_follow_up > ? THEN ?
            ELSE next_follow_up
          END,
          updated_at = ?
        WHERE id = ?`,
      params: [task.dueAt, task.dueAt, task.dueAt, task.createdAt, task.contactId],
    },
    dropGuard(),
  ];
}

export function createCareerContactArchiveStatements(
  contactId: string,
  archived: boolean,
  updatedAt: string,
): SqlStatement[] {
  return [
    ...contactGuard(contactId, false),
    {
      sql: "UPDATE career_contacts SET archived = ?, updated_at = ? WHERE id = ?",
      params: [archived ? 1 : 0, updatedAt, contactId],
    },
    dropGuard(),
  ];
}
