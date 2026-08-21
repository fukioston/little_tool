import type {
  DatabaseSchemaRequirements,
  SqlStatement,
} from "../local-db/types";

export const CAREER_APPLICATION_ID = 0x5a484a49;
export const CAREER_USER_VERSION = 1;

export const CAREER_SCHEMA_REQUIREMENTS = {
  applicationId: CAREER_APPLICATION_ID,
  minimumUserVersion: CAREER_USER_VERSION,
  maximumUserVersion: CAREER_USER_VERSION,
  sourceApplicationIds: [0, CAREER_APPLICATION_ID],
  sourceMinimumUserVersion: 0,
  sourceMaximumUserVersion: CAREER_USER_VERSION,
  requiredTables: [
    {
      name: "career_stages",
      columns: ["id", "name", "color", "position", "is_terminal", "hidden"],
    },
    {
      name: "career_jobs",
      columns: [
        "id",
        "company",
        "role",
        "location",
        "source",
        "source_url",
        "stage_id",
        "priority",
        "salary",
        "work_mode",
        "description",
        "applied_at",
        "deadline",
        "contact_name",
        "note",
        "tags",
        "created_at",
        "updated_at",
        "archived",
        "position",
      ],
    },
    {
      name: "career_tasks",
      columns: [
        "id",
        "job_id",
        "title",
        "due_at",
        "kind",
        "priority",
        "status",
        "created_at",
      ],
    },
    {
      name: "career_interviews",
      columns: [
        "id",
        "job_id",
        "round_name",
        "interview_type",
        "scheduled_at",
        "duration",
        "interviewer",
        "meeting_url",
        "status",
        "summary",
        "raw_notes",
        "questions_json",
        "reflection",
        "created_at",
        "updated_at",
      ],
    },
    {
      name: "career_contacts",
      columns: [
        "id",
        "company",
        "name",
        "role",
        "channel",
        "email",
        "phone",
        "last_contact_at",
        "next_follow_up",
        "notes",
        "created_at",
      ],
    },
    {
      name: "career_materials",
      columns: [
        "id",
        "name",
        "kind",
        "version",
        "updated_at",
        "linked_job_id",
        "status",
        "notes",
        "file_key",
        "file_name",
        "mime_type",
        "byte_size",
      ],
    },
    {
      name: "career_activity",
      columns: ["id", "job_id", "type", "detail", "created_at"],
    },
    { name: "career_settings", columns: ["key", "value"] },
  ],
  allowedViews: [],
  allowedTriggers: [],
} as const satisfies DatabaseSchemaRequirements;

export type CareerRestoreAttachmentMetadata = Readonly<{
  key: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
}>;

export type CareerRestoreAttachmentMapping = Readonly<{
  original: CareerRestoreAttachmentMetadata;
  staged: CareerRestoreAttachmentMetadata;
}>;

const GUARD_TABLE = "temp.__career_restore_guard";

function assertMetadata(
  metadata: CareerRestoreAttachmentMetadata,
  label: string,
): void {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    typeof metadata.key !== "string" ||
    metadata.key.length === 0 ||
    typeof metadata.originalName !== "string" ||
    metadata.originalName.length === 0 ||
    typeof metadata.mimeType !== "string" ||
    metadata.mimeType.length === 0 ||
    !Number.isSafeInteger(metadata.byteSize) ||
    metadata.byteSize < 0
  ) {
    throw new TypeError(`${label} contains invalid attachment metadata.`);
  }
}

function assertMappings(
  mappings: readonly CareerRestoreAttachmentMapping[],
): void {
  if (!Array.isArray(mappings)) {
    throw new TypeError("Career restore attachment mappings must be an array.");
  }

  const originalKeys = new Set<string>();
  const stagedKeys = new Set<string>();
  for (const [index, mapping] of mappings.entries()) {
    if (!mapping || typeof mapping !== "object") {
      throw new TypeError(`Career restore mapping ${index} is invalid.`);
    }
    assertMetadata(mapping.original, `Career restore mapping ${index}.original`);
    assertMetadata(mapping.staged, `Career restore mapping ${index}.staged`);
    if (originalKeys.has(mapping.original.key)) {
      throw new TypeError("Career restore mappings contain a duplicate original key.");
    }
    if (stagedKeys.has(mapping.staged.key)) {
      throw new TypeError("Career restore mappings contain a duplicate staged key.");
    }
    originalKeys.add(mapping.original.key);
    stagedKeys.add(mapping.staged.key);
  }

  for (const key of stagedKeys) {
    if (originalKeys.has(key)) {
      throw new TypeError(
        "Career restore staged keys must not overlap the original key set.",
      );
    }
  }
}

function materialGuardStatement(
  attachments: readonly CareerRestoreAttachmentMetadata[],
): SqlStatement {
  if (attachments.length === 0) {
    return {
      sql: `INSERT INTO ${GUARD_TABLE}(value)
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM career_materials
          WHERE file_key IS NOT NULL AND file_key <> ''
        ) THEN 1 ELSE 0 END`,
    };
  }

  const expectedRows = attachments.map(() => "(?, ?, ?, ?)").join(", ");
  return {
    sql: `WITH expected(file_key, file_name, mime_type, byte_size) AS (
        VALUES ${expectedRows}
      )
      INSERT INTO ${GUARD_TABLE}(value)
      SELECT CASE WHEN
        (SELECT COUNT(DISTINCT file_key)
          FROM career_materials
          WHERE file_key IS NOT NULL AND file_key <> '') = ?
        AND NOT EXISTS (
          SELECT 1
          FROM career_materials AS actual
          WHERE actual.file_key IS NOT NULL
            AND actual.file_key <> ''
            AND NOT EXISTS (
              SELECT 1
              FROM expected
              WHERE expected.file_key = actual.file_key
                AND expected.file_name = actual.file_name
                AND expected.mime_type = actual.mime_type
                AND expected.byte_size = actual.byte_size
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM expected
          WHERE NOT EXISTS (
            SELECT 1
            FROM career_materials AS actual
            WHERE actual.file_key = expected.file_key
              AND actual.file_name = expected.file_name
              AND actual.mime_type = expected.mime_type
              AND actual.byte_size = expected.byte_size
          )
        )
      THEN 1 ELSE 0 END`,
    params: [
      ...attachments.flatMap((attachment) => [
        attachment.key,
        attachment.originalName,
        attachment.mimeType,
        attachment.byteSize,
      ]),
      attachments.length,
    ],
  };
}

function canonicalIdentityStatements(): SqlStatement[] {
  return [
    { sql: `PRAGMA application_id = ${CAREER_APPLICATION_ID}` },
    { sql: `PRAGMA user_version = ${CAREER_USER_VERSION}` },
  ];
}

/**
 * Builds the fixed SQL mapping transaction for a verified complete backup.
 * The caller must execute every returned statement in one transaction.
 */
export function createCompleteCareerRestoreStatements(
  mappings: readonly CareerRestoreAttachmentMapping[],
): SqlStatement[] {
  assertMappings(mappings);
  const original = mappings.map((mapping) => mapping.original);
  const staged = mappings.map((mapping) => mapping.staged);

  return [
    {
      sql: `CREATE TEMP TABLE __career_restore_guard (
        value INTEGER NOT NULL CHECK (value = 1)
      )`,
    },
    materialGuardStatement(original),
    ...mappings.map((mapping) => ({
      sql: `UPDATE career_materials
        SET file_key = ?, file_name = ?, mime_type = ?, byte_size = ?
        WHERE file_key = ?`,
      params: [
        mapping.staged.key,
        mapping.staged.originalName,
        mapping.staged.mimeType,
        mapping.staged.byteSize,
        mapping.original.key,
      ],
    })),
    materialGuardStatement(staged),
    { sql: `DROP TABLE ${GUARD_TABLE}` },
    ...canonicalIdentityStatements(),
  ];
}

/**
 * A raw legacy SQLite file cannot contain its matching OPFS attachments.
 * Clear every attachment column so the restored database never points at
 * unrelated files left in this browser.
 */
export function createLegacyCareerRestoreStatements(): SqlStatement[] {
  return [
    {
      sql: `UPDATE career_materials
        SET file_key = NULL, file_name = NULL, mime_type = NULL, byte_size = NULL`,
    },
    ...canonicalIdentityStatements(),
  ];
}
