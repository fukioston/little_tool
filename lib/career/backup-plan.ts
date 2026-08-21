import type {
  DatabaseSchemaRequirements,
  SqlStatement,
} from "../local-db/types";
import {
  ZHIJI_APPLICATION_ID,
  ZHIJI_SCHEMA_LINEAGES,
  ZHIJI_SCHEMA_OBJECT_SQL_VARIANTS,
  ZHIJI_TABLE_COLUMNS,
  ZHIJI_TABLES,
  ZHIJI_USER_VERSION,
  ZHIJI_V1_SCHEMA_STATEMENTS,
  ZHIJI_V1_TABLE_COLUMNS,
  ZHIJI_V1_TABLES,
  ZHIJI_V1_MIGRATION_NAME,
  ZHIJI_V2_MIGRATION_NAME,
  ZHIJI_V2_SCHEMA_MIGRATION_STATEMENTS,
  ZHIJI_V3_MIGRATION_NAME,
  ZHIJI_V3_SCHEMA_MIGRATION_STATEMENTS,
} from "../schemas/zhiji";

export const CAREER_APPLICATION_ID = ZHIJI_APPLICATION_ID;
export const CAREER_USER_VERSION = ZHIJI_USER_VERSION;
export const CAREER_V2_SCHEMA_OBJECT_COUNT = Object.keys(
  ZHIJI_SCHEMA_OBJECT_SQL_VARIANTS[2],
).length;

const CAREER_V1_REQUIRED_TABLES = ZHIJI_V1_TABLES.map((name) => ({
  name,
  columns: ZHIJI_V1_TABLE_COLUMNS[name],
}));
const CAREER_V3_REQUIRED_TABLES = ZHIJI_TABLES.map((name) => ({
  name,
  columns: ZHIJI_TABLE_COLUMNS[name],
}));

export const CAREER_SCHEMA_REQUIREMENTS = {
  applicationId: CAREER_APPLICATION_ID,
  minimumUserVersion: CAREER_USER_VERSION,
  maximumUserVersion: CAREER_USER_VERSION,
  sourceApplicationIds: [0, CAREER_APPLICATION_ID],
  sourceMinimumUserVersion: 0,
  sourceMaximumUserVersion: CAREER_USER_VERSION,
  sourceRequiredTables: CAREER_V1_REQUIRED_TABLES,
  requiredTables: CAREER_V3_REQUIRED_TABLES,
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

type CareerSchemaVersion = 0 | 1 | 2 | 3;
const SCHEMA_GUARD_TABLE = "temp.__career_restore_schema_guard";

function assertSourceVersion(
  sourceUserVersion: number,
): asserts sourceUserVersion is CareerSchemaVersion {
  if (
    !Number.isSafeInteger(sourceUserVersion) ||
    sourceUserVersion < 0 ||
    sourceUserVersion > CAREER_USER_VERSION
  ) {
    throw new TypeError("Unsupported Career restore source user_version.");
  }
}

function compactSql(value: string): string {
  return value.replace(/\s+/g, "");
}

function compactSqlExpression(column: string): string {
  return `replace(replace(replace(replace(${column},' ',''),char(10),''),char(13),''),char(9),'')`;
}

function schemaObjects(version: CareerSchemaVersion) {
  return Object.entries(ZHIJI_SCHEMA_OBJECT_SQL_VARIANTS[version]).map(
    ([name, sqlVariants]) => ({
      name,
      type: /^CREATE\s+(?:UNIQUE\s+)?TABLE\b/i.test(sqlVariants[0])
        ? "table" as const
        : "index" as const,
      sqlVariants,
    }),
  );
}

/**
 * Verify the complete known DDL, not merely familiar table names. Whitespace is
 * ignored because SQLite rewrites spacing around ALTER TABLE additions. The
 * two v2/v3 lineages are accepted only as coherent pairs, never mixed.
 */
export function createCareerSchemaGuardStatements(
  sourceUserVersion: number,
): SqlStatement[] {
  assertSourceVersion(sourceUserVersion);
  const version = sourceUserVersion;
  const objects = schemaObjects(version);
  const expectedObjectRows = objects.map(() => "(?, ?)").join(", ");
  const allowedApplicationIds = version === 0
    ? [0, CAREER_APPLICATION_ID]
    : [CAREER_APPLICATION_ID];
  const applicationIdPlaceholders = allowedApplicationIds.map(() => "?").join(",");
  const statements: SqlStatement[] = [
    {
      sql: `CREATE TEMP TABLE __career_restore_schema_guard (
        value INTEGER NOT NULL CHECK (value = 1)
      )`,
    },
    {
      sql: `INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN
          (SELECT application_id FROM pragma_application_id)
            IN (${applicationIdPlaceholders})
          AND (SELECT user_version FROM pragma_user_version) = ?
        THEN 1 ELSE 0 END`,
      params: [...allowedApplicationIds, version],
    },
    {
      sql: `WITH expected(type,name) AS (VALUES ${expectedObjectRows}),
        actual AS (
          SELECT type,name FROM sqlite_schema
          WHERE type IN ('table','index','view','trigger')
            AND name NOT LIKE 'sqlite_%'
        )
        INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN
          (SELECT COUNT(*) FROM actual) = ?
          AND NOT EXISTS (
            SELECT 1 FROM actual
            WHERE NOT EXISTS (
              SELECT 1 FROM expected
              WHERE expected.type = actual.type AND expected.name = actual.name
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM expected
            WHERE NOT EXISTS (
              SELECT 1 FROM actual
              WHERE actual.type = expected.type AND actual.name = expected.name
            )
          )
        THEN 1 ELSE 0 END`,
      params: [
        ...objects.flatMap(({ type, name }) => [type, name]),
        objects.length,
      ],
    },
    ...objects.map(({ name, type, sqlVariants }) => ({
      sql: `INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM sqlite_schema
          WHERE type = ? AND name = ?
            AND ${compactSqlExpression("sql")} IN (
              ${sqlVariants.map(() => "?").join(",")}
            )
        ) THEN 1 ELSE 0 END`,
      params: [type, name, ...sqlVariants.map(compactSql)],
    })),
  ];

  if (version === 2 || version === 3) {
    const lineages = ZHIJI_SCHEMA_LINEAGES[version];
    statements.push({
      sql: `WITH expected(contacts_sql,tasks_sql) AS (
          ${lineages.map(() => "SELECT ?,?").join(" UNION ALL ")}
        )
        INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM expected
          WHERE contacts_sql = (
            SELECT ${compactSqlExpression("sql")} FROM sqlite_schema
            WHERE type='table' AND name='career_contacts'
          )
          AND tasks_sql = (
            SELECT ${compactSqlExpression("sql")} FROM sqlite_schema
            WHERE type='table' AND name='career_tasks'
          )
        ) THEN 1 ELSE 0 END`,
      params: lineages.flatMap(({ contactsSql, tasksSql }) => [
        compactSql(contactsSql),
        compactSql(tasksSql),
      ]),
    });
  }

  const taskStatuses = version === 3
    ? ["todo", "done", "canceled"]
    : ["todo", "done", "canceled", "cancelled"];
  const interviewStatuses = version === 3
    ? ["scheduled", "completed", "canceled"]
    : ["scheduled", "completed", "canceled", "cancelled"];
  statements.push({
    sql: `INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
      SELECT CASE WHEN
        NOT EXISTS (
          SELECT 1 FROM career_tasks
          WHERE status NOT IN (${taskStatuses.map(() => "?").join(",")})
        )
        AND NOT EXISTS (
          SELECT 1 FROM career_interviews
          WHERE status NOT IN (${interviewStatuses.map(() => "?").join(",")})
        )
      THEN 1 ELSE 0 END`,
    params: [...taskStatuses, ...interviewStatuses],
  });

  if (version === 3) {
    const expectedLedger = [
      { version: 1, name: ZHIJI_V1_MIGRATION_NAME },
      { version: 2, name: ZHIJI_V2_MIGRATION_NAME },
      { version: 3, name: ZHIJI_V3_MIGRATION_NAME },
    ];
    statements.push({
      sql: `INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN
          (SELECT COUNT(*) FROM career_schema_migrations) = ?
          AND NOT EXISTS (
            SELECT 1 FROM career_schema_migrations AS actual
            WHERE actual.applied_at IS NULL OR actual.applied_at = ''
              OR NOT EXISTS (
                SELECT 1 FROM (
                  ${expectedLedger.map(() => "SELECT ? AS version,? AS name").join(" UNION ALL ")}
                ) AS expected
                WHERE expected.version = actual.version
                  AND expected.name = actual.name
              )
          )
        THEN 1 ELSE 0 END`,
      params: [
        expectedLedger.length,
        ...expectedLedger.flatMap(({ version: ledgerVersion, name }) => [
          ledgerVersion,
          name,
        ]),
      ],
    });
  }

  statements.push(
    {
      sql: `INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN (
          SELECT integrity_check FROM pragma_integrity_check LIMIT 1
        ) = 'ok' THEN 1 ELSE 0 END`,
    },
    {
      sql: `INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM pragma_foreign_key_check
        ) THEN 1 ELSE 0 END`,
    },
    { sql: `DROP TABLE ${SCHEMA_GUARD_TABLE}` },
  );
  return statements;
}

function migrationStatements(sourceUserVersion: CareerSchemaVersion): SqlStatement[] {
  const statements: SqlStatement[] = [];
  if (sourceUserVersion < 2) {
    statements.push(
      ...ZHIJI_V2_SCHEMA_MIGRATION_STATEMENTS,
      { sql: `PRAGMA application_id = ${CAREER_APPLICATION_ID}` },
      { sql: "PRAGMA user_version = 2" },
      ...createCareerSchemaGuardStatements(2),
    );
  }
  if (sourceUserVersion < 3) {
    statements.push(...ZHIJI_V3_SCHEMA_MIGRATION_STATEMENTS);
  }
  statements.push(
    ...canonicalIdentityStatements(),
    ...createCareerSchemaGuardStatements(3),
    { sql: "PRAGMA optimize" },
  );
  return statements;
}

export function createFreshCareerSchemaStatements(): SqlStatement[] {
  return [
    ...ZHIJI_V1_SCHEMA_STATEMENTS,
    ...ZHIJI_V2_SCHEMA_MIGRATION_STATEMENTS,
    ...ZHIJI_V3_SCHEMA_MIGRATION_STATEMENTS,
    ...canonicalIdentityStatements(),
    ...createCareerSchemaGuardStatements(3),
    { sql: "PRAGMA optimize" },
  ];
}

export function createCareerRuntimeUpgradeStatements(
  sourceUserVersion: number,
): SqlStatement[] {
  assertSourceVersion(sourceUserVersion);
  return [
    ...createCareerSchemaGuardStatements(sourceUserVersion),
    ...migrationStatements(sourceUserVersion),
  ];
}

/**
 * Recover only three proven runtime interruptions around the historical v2
 * rollout: v1/migrated-v2, v0/direct-v2, and the development-only
 * v3/migrated-v2 state. Backup restore deliberately never calls this plan,
 * because an external file must match the version it declares.
 */
export function createInterruptedCareerV2RuntimeRecoveryStatements(
  currentApplicationId: number,
  currentUserVersion: number,
): SqlStatement[] {
  const migratedLineage =
    currentApplicationId === CAREER_APPLICATION_ID &&
    (currentUserVersion === 1 || currentUserVersion === 3);
  const directLineage =
    currentApplicationId === 0 && currentUserVersion === 0;
  if (!migratedLineage && !directLineage) {
    throw new TypeError("Unsupported interrupted Career runtime identity.");
  }
  const lineage = ZHIJI_SCHEMA_LINEAGES[2][directLineage ? 1 : 0];
  return [
    {
      sql: `CREATE TEMP TABLE __career_interrupted_v2_guard (
        value INTEGER NOT NULL CHECK (value = 1)
      )`,
    },
    {
      sql: `INSERT INTO temp.__career_interrupted_v2_guard(value)
        SELECT CASE WHEN
          (SELECT application_id FROM pragma_application_id) = ?
          AND (SELECT user_version FROM pragma_user_version) = ?
          AND (SELECT ${compactSqlExpression("sql")} FROM sqlite_schema
            WHERE type='table' AND name='career_contacts') = ?
          AND (SELECT ${compactSqlExpression("sql")} FROM sqlite_schema
            WHERE type='table' AND name='career_tasks') = ?
        THEN 1 ELSE 0 END`,
      params: [
        currentApplicationId,
        currentUserVersion,
        compactSql(lineage.contactsSql),
        compactSql(lineage.tasksSql),
      ],
    },
    { sql: "DROP TABLE temp.__career_interrupted_v2_guard" },
    { sql: `PRAGMA application_id = ${CAREER_APPLICATION_ID}` },
    { sql: "PRAGMA user_version = 2" },
    ...createCareerSchemaGuardStatements(2),
    ...migrationStatements(2),
  ];
}

/**
 * Builds the fixed SQL mapping transaction for a verified complete backup.
 * The caller must execute every returned statement in one transaction.
 */
export function createCompleteCareerRestoreStatements(
  mappings: readonly CareerRestoreAttachmentMapping[],
  sourceUserVersion = CAREER_USER_VERSION,
): SqlStatement[] {
  assertMappings(mappings);
  const original = mappings.map((mapping) => mapping.original);
  const staged = mappings.map((mapping) => mapping.staged);

  return [
    ...createCareerSchemaGuardStatements(sourceUserVersion),
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
    ...migrationStatements(sourceUserVersion as CareerSchemaVersion),
  ];
}

/**
 * A raw legacy SQLite file cannot contain its matching OPFS attachments.
 * Clear every attachment column so the restored database never points at
 * unrelated files left in this browser.
 */
export function createLegacyCareerRestoreStatements(
  sourceUserVersion = CAREER_USER_VERSION,
): SqlStatement[] {
  assertSourceVersion(sourceUserVersion);
  return [
    ...createCareerSchemaGuardStatements(sourceUserVersion),
    {
      sql: `UPDATE career_materials
        SET file_key = NULL, file_name = NULL, mime_type = NULL, byte_size = NULL`,
    },
    ...migrationStatements(sourceUserVersion),
  ];
}
