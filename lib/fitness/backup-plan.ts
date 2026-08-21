import type {
  DatabaseSchemaRequirements,
  SqlStatement,
} from "../local-db/types";
import {
  SHILIAN_APPLICATION_ID,
  SHILIAN_INDEXES,
  SHILIAN_OBJECT_SQL,
  SHILIAN_TABLE_COLUMNS,
  SHILIAN_TABLES,
  SHILIAN_USER_VERSION,
  SHILIAN_V1_INDEXES,
  SHILIAN_V1_MIGRATION_NAME,
  SHILIAN_V1_OBJECT_SQL,
  SHILIAN_V1_TABLE_COLUMNS,
  SHILIAN_V2_MIGRATION_NAME,
  SHILIAN_V2_SCHEMA_MIGRATION_STATEMENTS,
} from "../schemas/shilian";
import type { FitnessBackupFileMetadata } from "./backup-format";

export const FITNESS_APPLICATION_ID = SHILIAN_APPLICATION_ID;
export const FITNESS_USER_VERSION = SHILIAN_USER_VERSION;

const REQUIRED_TABLES = SHILIAN_TABLES.map((name) => ({
  name,
  columns: SHILIAN_TABLE_COLUMNS[name],
}));
const V1_REQUIRED_TABLES = SHILIAN_TABLES.map((name) => ({
  name,
  columns: SHILIAN_V1_TABLE_COLUMNS[name],
}));

export const FITNESS_SCHEMA_REQUIREMENTS = {
  applicationId: FITNESS_APPLICATION_ID,
  minimumUserVersion: FITNESS_USER_VERSION,
  maximumUserVersion: FITNESS_USER_VERSION,
  sourceApplicationIds: [FITNESS_APPLICATION_ID],
  sourceMinimumUserVersion: 1,
  sourceMaximumUserVersion: FITNESS_USER_VERSION,
  sourceRequiredTables: V1_REQUIRED_TABLES,
  requiredTables: REQUIRED_TABLES,
  allowedViews: [],
  allowedTriggers: [],
} as const satisfies DatabaseSchemaRequirements;

export type FitnessRestoreFileMetadata = FitnessBackupFileMetadata;

export type FitnessRestoreFileMapping = Readonly<{
  original: FitnessRestoreFileMetadata;
  staged: FitnessRestoreFileMetadata;
}>;

const FILE_LIMIT = 1_000;
const FILE_GUARD_TABLE = "temp.__fitness_restore_file_guard";
const SCHEMA_GUARD_TABLE = "temp.__fitness_restore_schema_guard";
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MIME_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const FILE_KEYS = [
  "id",
  "entityType",
  "entityId",
  "purpose",
  "key",
  "originalName",
  "mimeType",
  "byteSize",
  "sha256",
  "status",
  "createdAt",
  "updatedAt",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return (
    actual.length === expected.size &&
    actual.every((key) => expected.has(key))
  );
}

function isDisplayText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    Array.from(value).every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point > 31 && point !== 127;
    })
  );
}

function assertMetadata(
  metadata: unknown,
  label: string,
): asserts metadata is FitnessRestoreFileMetadata {
  if (!isRecord(metadata) || !hasExactKeys(metadata, FILE_KEYS)) {
    throw new TypeError(`${label} must contain the exact Fitness file fields.`);
  }
  if (
    !isDisplayText(metadata.id, 255) ||
    !isDisplayText(metadata.entityId, 255) ||
    (
      metadata.entityType !== "venue" &&
      metadata.entityType !== "equipment" &&
      metadata.entityType !== "exercise" &&
      metadata.entityType !== "session"
    ) ||
    (
      metadata.purpose !== "photo" &&
      metadata.purpose !== "instruction" &&
      metadata.purpose !== "other"
    ) ||
    typeof metadata.key !== "string" ||
    !UUID_V4_PATTERN.test(metadata.key) ||
    !isDisplayText(metadata.originalName, 255) ||
    metadata.originalName === "." ||
    metadata.originalName === ".." ||
    metadata.originalName.includes("/") ||
    metadata.originalName.includes("\\") ||
    typeof metadata.mimeType !== "string" ||
    metadata.mimeType.length > 127 ||
    !MIME_PATTERN.test(metadata.mimeType) ||
    typeof metadata.byteSize !== "number" ||
    !Number.isSafeInteger(metadata.byteSize) ||
    metadata.byteSize < 0 ||
    metadata.byteSize > 512 * 1024 * 1024 ||
    typeof metadata.sha256 !== "string" ||
    !SHA256_PATTERN.test(metadata.sha256) ||
    metadata.status !== "ready" ||
    typeof metadata.createdAt !== "number" ||
    !Number.isSafeInteger(metadata.createdAt) ||
    metadata.createdAt < 0 ||
    typeof metadata.updatedAt !== "number" ||
    !Number.isSafeInteger(metadata.updatedAt) ||
    metadata.updatedAt < metadata.createdAt
  ) {
    throw new TypeError(`${label} contains invalid Fitness file metadata.`);
  }
}

function sameMetadataExceptKey(
  original: FitnessRestoreFileMetadata,
  staged: FitnessRestoreFileMetadata,
): boolean {
  return (
    original.id === staged.id &&
    original.entityType === staged.entityType &&
    original.entityId === staged.entityId &&
    original.purpose === staged.purpose &&
    original.originalName === staged.originalName &&
    original.mimeType === staged.mimeType &&
    original.byteSize === staged.byteSize &&
    original.sha256 === staged.sha256 &&
    original.status === staged.status &&
    original.createdAt === staged.createdAt &&
    original.updatedAt === staged.updatedAt
  );
}

function assertMappings(
  mappings: readonly FitnessRestoreFileMapping[],
): void {
  if (!Array.isArray(mappings)) {
    throw new TypeError("Fitness restore file mappings must be an array.");
  }
  if (mappings.length > FILE_LIMIT) {
    throw new TypeError("Fitness restore contains too many file mappings.");
  }

  const originalIds = new Set<string>();
  const originalKeys = new Set<string>();
  const stagedKeys = new Set<string>();
  for (const [index, rawMapping] of mappings.entries()) {
    if (!isRecord(rawMapping) || !hasExactKeys(rawMapping, ["original", "staged"])) {
      throw new TypeError(`Fitness restore mapping ${index} is invalid.`);
    }
    assertMetadata(
      rawMapping.original,
      `Fitness restore mapping ${index}.original`,
    );
    assertMetadata(
      rawMapping.staged,
      `Fitness restore mapping ${index}.staged`,
    );
    const { original, staged } = rawMapping;
    if (!sameMetadataExceptKey(original, staged)) {
      throw new TypeError(
        `Fitness restore mapping ${index} changes immutable file metadata.`,
      );
    }
    if (original.key === staged.key) {
      throw new TypeError(
        `Fitness restore mapping ${index} must use a fresh staged key.`,
      );
    }
    if (originalIds.has(original.id)) {
      throw new TypeError("Fitness restore mappings contain a duplicate file row id.");
    }
    if (originalKeys.has(original.key)) {
      throw new TypeError("Fitness restore mappings contain a duplicate original key.");
    }
    if (stagedKeys.has(staged.key)) {
      throw new TypeError("Fitness restore mappings contain a duplicate staged key.");
    }
    originalIds.add(original.id);
    originalKeys.add(original.key);
    stagedKeys.add(staged.key);
  }

  for (const key of stagedKeys) {
    if (originalKeys.has(key)) {
      throw new TypeError(
        "Fitness restore staged keys must not overlap original keys.",
      );
    }
  }
}

function assertSourceVersion(sourceUserVersion: number): void {
  if (sourceUserVersion !== 1 && sourceUserVersion !== FITNESS_USER_VERSION) {
    throw new TypeError("Unsupported Fitness restore source user_version.");
  }
}

function expectedSchemaObjects(version: 1 | 2) {
  const objectSql = version === 1 ? SHILIAN_V1_OBJECT_SQL : SHILIAN_OBJECT_SQL;
  const indexes = version === 1 ? SHILIAN_V1_INDEXES : SHILIAN_INDEXES;
  return [
    ...SHILIAN_TABLES.map((name) => ({
      type: "table" as const,
      name,
      sql: objectSql[name],
    })),
    ...indexes.map((name) => ({
      type: "index" as const,
      name,
      sql: objectSql[name],
    })),
  ];
}

/**
 * Verifies the whole versioned DDL rather than accepting a database which merely has
 * familiar table names. These statements run inside the candidate transaction.
 */
function exactSchemaGuardStatements(version: 1 | 2): SqlStatement[] {
  const objects = expectedSchemaObjects(version);
  const tableColumns: Readonly<Record<string, readonly string[]>> =
    version === 1 ? SHILIAN_V1_TABLE_COLUMNS : SHILIAN_TABLE_COLUMNS;
  const expectedLedger = version === 1
    ? [{ version: 1, name: SHILIAN_V1_MIGRATION_NAME }]
    : [
      { version: 1, name: SHILIAN_V1_MIGRATION_NAME },
      { version: 2, name: SHILIAN_V2_MIGRATION_NAME },
    ];
  const expectedRows = objects.map(() => "(?, ?, ?)").join(", ");
  const statements: SqlStatement[] = [
    {
      sql: `CREATE TEMP TABLE __fitness_restore_schema_guard (
        value INTEGER NOT NULL CHECK (value = 1)
      )`,
    },
    {
      sql: `INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN
          (SELECT application_id FROM pragma_application_id) = ?
          AND (SELECT user_version FROM pragma_user_version) = ?
        THEN 1 ELSE 0 END`,
      params: [FITNESS_APPLICATION_ID, version],
    },
    {
      sql: `WITH expected(type, name, sql) AS (VALUES ${expectedRows}),
        actual AS (
          SELECT type, name, sql
          FROM sqlite_schema
          WHERE type IN ('table', 'index', 'view', 'trigger')
            AND name NOT LIKE 'sqlite_%'
        )
        INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN
          (SELECT COUNT(*) FROM actual) = ?
          AND NOT EXISTS (
            SELECT 1 FROM actual
            WHERE NOT EXISTS (
              SELECT 1 FROM expected
              WHERE expected.type = actual.type
                AND expected.name = actual.name
                AND expected.sql = actual.sql
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM expected
            WHERE NOT EXISTS (
              SELECT 1 FROM actual
              WHERE actual.type = expected.type
                AND actual.name = expected.name
                AND actual.sql = expected.sql
            )
          )
        THEN 1 ELSE 0 END`,
      params: [
        ...objects.flatMap(({ type, name, sql }) => [type, name, sql]),
        objects.length,
      ],
    },
    ...SHILIAN_TABLES.map((name) => ({
      sql: `INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN (
          SELECT group_concat(name, char(31)) FROM (
            SELECT name FROM pragma_table_info(?) ORDER BY cid
          )
        ) = ? THEN 1 ELSE 0 END`,
      params: [name, tableColumns[name].join(String.fromCharCode(31))],
    })),
    {
      sql: `INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN
          (SELECT COUNT(*) FROM fitness_schema_migrations) = ?
          AND NOT EXISTS (
            SELECT 1 FROM fitness_schema_migrations actual
            WHERE actual.applied_at < 0
              OR NOT EXISTS (
                SELECT 1 FROM (
                  ${expectedLedger.map(() => "SELECT ? version, ? name").join(" UNION ALL ")}
                ) expected
                WHERE expected.version = actual.version
                  AND expected.name = actual.name
              )
          )
        THEN 1 ELSE 0 END`,
      params: [
        expectedLedger.length,
        ...expectedLedger.flatMap(({ version: migrationVersion, name }) => [migrationVersion, name]),
      ],
    },
    {
      sql: `INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM pragma_foreign_key_check
        ) THEN 1 ELSE 0 END`,
    },
    { sql: `DROP TABLE ${SCHEMA_GUARD_TABLE}` },
  ];
  return statements;
}

function migrationStatements(sourceUserVersion: 1 | 2): SqlStatement[] {
  if (sourceUserVersion === FITNESS_USER_VERSION) return [];
  return [
    ...SHILIAN_V2_SCHEMA_MIGRATION_STATEMENTS,
    {
      sql: "INSERT INTO fitness_schema_migrations(version,name,applied_at) VALUES(?,?,?)",
      params: [2, SHILIAN_V2_MIGRATION_NAME, Date.now()],
    },
  ];
}

function fileMetadataValues(metadata: FitnessRestoreFileMetadata) {
  return [
    metadata.id,
    metadata.entityType,
    metadata.entityId,
    metadata.purpose,
    metadata.key,
    metadata.originalName,
    metadata.mimeType,
    metadata.byteSize,
    metadata.sha256,
    metadata.status,
    metadata.createdAt,
    metadata.updatedAt,
  ];
}

function readyFileGuardStatement(
  files: readonly FitnessRestoreFileMetadata[],
): SqlStatement {
  if (files.length === 0) {
    return {
      sql: `INSERT INTO ${FILE_GUARD_TABLE}(value)
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM fitness_files WHERE status = 'ready'
        ) THEN 1 ELSE 0 END`,
    };
  }

  const expectedRows = files.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .join(", ");
  return {
    sql: `WITH expected(
        id, entity_type, entity_id, purpose, file_key, file_name, mime_type,
        byte_size, sha256, status, created_at, updated_at
      ) AS (VALUES ${expectedRows})
      INSERT INTO ${FILE_GUARD_TABLE}(value)
      SELECT CASE WHEN
        (SELECT COUNT(*) FROM fitness_files WHERE status = 'ready') = ?
        AND NOT EXISTS (
          SELECT 1 FROM fitness_files AS actual
          WHERE actual.status = 'ready'
            AND NOT EXISTS (
              SELECT 1 FROM expected
              WHERE expected.id = actual.id
                AND expected.entity_type = actual.entity_type
                AND expected.entity_id = actual.entity_id
                AND expected.purpose = actual.purpose
                AND expected.file_key = actual.file_key
                AND expected.file_name = actual.file_name
                AND expected.mime_type = actual.mime_type
                AND expected.byte_size = actual.byte_size
                AND expected.sha256 = actual.sha256
                AND expected.status = actual.status
                AND expected.created_at = actual.created_at
                AND expected.updated_at = actual.updated_at
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM expected
          WHERE NOT EXISTS (
            SELECT 1 FROM fitness_files AS actual
            WHERE actual.id = expected.id
              AND actual.entity_type = expected.entity_type
              AND actual.entity_id = expected.entity_id
              AND actual.purpose = expected.purpose
              AND actual.file_key = expected.file_key
              AND actual.file_name = expected.file_name
              AND actual.mime_type = expected.mime_type
              AND actual.byte_size = expected.byte_size
              AND actual.sha256 = expected.sha256
              AND actual.status = expected.status
              AND actual.created_at = expected.created_at
              AND actual.updated_at = expected.updated_at
          )
        )
      THEN 1 ELSE 0 END`,
    params: [
      ...files.flatMap(fileMetadataValues),
      files.length,
    ],
  };
}

function canonicalIdentityStatements(): SqlStatement[] {
  return [
    { sql: `PRAGMA application_id = ${FITNESS_APPLICATION_ID}` },
    { sql: `PRAGMA user_version = ${FITNESS_USER_VERSION}` },
  ];
}

/**
 * Build the fixed SQL transaction for a verified complete Fitness backup.
 * The caller stages every payload under a fresh OPFS key before executing it.
 */
export function createCompleteFitnessRestoreStatements(
  mappings: readonly FitnessRestoreFileMapping[],
  sourceUserVersion = FITNESS_USER_VERSION,
): SqlStatement[] {
  assertSourceVersion(sourceUserVersion);
  const sourceVersion = sourceUserVersion as 1 | 2;
  assertMappings(mappings);
  const original = mappings.map(({ original: metadata }) => metadata);
  const staged = mappings.map(({ staged: metadata }) => metadata);

  return [
    ...exactSchemaGuardStatements(sourceVersion),
    {
      sql: `CREATE TEMP TABLE __fitness_restore_file_guard (
        value INTEGER NOT NULL CHECK (value = 1)
      )`,
    },
    readyFileGuardStatement(original),
    ...mappings.map(({ original: before, staged: after }) => ({
      sql: `UPDATE fitness_files
        SET file_key = ?
        WHERE id = ?
          AND entity_type = ?
          AND entity_id = ?
          AND purpose = ?
          AND file_key = ?
          AND file_name = ?
          AND mime_type = ?
          AND byte_size = ?
          AND sha256 = ?
          AND status = 'ready'
          AND created_at = ?
          AND updated_at = ?`,
      params: [
        after.key,
        before.id,
        before.entityType,
        before.entityId,
        before.purpose,
        before.key,
        before.originalName,
        before.mimeType,
        before.byteSize,
        before.sha256,
        before.createdAt,
        before.updatedAt,
      ],
    })),
    readyFileGuardStatement(staged),
    { sql: `DROP TABLE ${FILE_GUARD_TABLE}` },
    ...migrationStatements(sourceVersion),
    ...canonicalIdentityStatements(),
    ...exactSchemaGuardStatements(2),
  ];
}

/**
 * A raw SQLite file carries no OPFS objects. Remove every file row, including
 * non-ready bookkeeping rows, so it cannot bind to unrelated browser files.
 */
export function createLegacyFitnessRestoreStatements(
  sourceUserVersion = FITNESS_USER_VERSION,
): SqlStatement[] {
  assertSourceVersion(sourceUserVersion);
  const sourceVersion = sourceUserVersion as 1 | 2;
  return [
    ...exactSchemaGuardStatements(sourceVersion),
    { sql: "DELETE FROM fitness_files" },
    ...migrationStatements(sourceVersion),
    ...canonicalIdentityStatements(),
    ...exactSchemaGuardStatements(2),
  ];
}
