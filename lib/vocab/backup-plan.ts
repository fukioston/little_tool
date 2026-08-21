import type {
  DatabaseSchemaRequirements,
  SqlStatement,
} from "../local-db/types";

export const VOCAB_APPLICATION_ID = 0x5348_4349;
export const VOCAB_USER_VERSION = 2;

type TableRequirement = Readonly<{
  name: string;
  columns: readonly string[];
}>;

const VOCAB_LEGACY_REQUIRED_TABLES: readonly TableRequirement[] = [
  {
    name: "vocab_items",
    columns: [
      "id", "kind", "title", "description", "source", "source_url",
      "author", "published_at", "duration_ms", "audio_url", "status",
      "progress", "created_at", "updated_at",
    ],
  },
  {
    name: "vocab_blocks",
    columns: ["id", "item_id", "ordinal", "kind", "text"],
  },
  {
    name: "vocab_transcript_segments",
    columns: ["id", "item_id", "ordinal", "start_ms", "end_ms", "text", "speaker"],
  },
  {
    name: "vocab_lexemes",
    columns: [
      "id", "headword", "normalized_key", "pronunciation", "gloss_en",
      "explanation_en", "explanation_zh", "status", "starred", "notes",
      "lookup_count", "created_at", "updated_at",
    ],
  },
  {
    name: "vocab_occurrences",
    columns: [
      "id", "lexeme_id", "item_id", "block_id", "segment_id", "surface",
      "context_before", "context_sentence", "context_after", "start_utf16",
      "end_utf16", "start_ms", "note", "explanation_json", "created_at",
    ],
  },
  {
    name: "vocab_review_cards",
    columns: [
      "id", "lexeme_id", "state", "due_at", "interval_days", "ease",
      "reps", "lapses", "last_review_at",
    ],
  },
  {
    name: "vocab_review_events",
    columns: [
      "id", "card_id", "rating", "reviewed_at", "before_json",
      "after_json", "undone_at",
    ],
  },
  {
    name: "vocab_bookmarks",
    columns: ["id", "item_id", "locator", "label", "note", "created_at"],
  },
  {
    name: "vocab_activity",
    columns: [
      "id", "day", "read_seconds", "listen_seconds", "review_count",
      "lookups", "created_at",
    ],
  },
  {
    name: "vocab_settings",
    columns: ["key", "value", "updated_at"],
  },
  {
    name: "vocab_imports",
    columns: ["id", "method", "label", "status", "error", "item_id", "created_at"],
  },
] as const;

const MIGRATION_LEDGER_REQUIREMENT: TableRequirement = {
  name: "vocab_schema_migrations",
  columns: ["version", "name", "applied_at"],
};

const VOCAB_V1_REQUIRED_TABLES: readonly TableRequirement[] = [
  ...VOCAB_LEGACY_REQUIRED_TABLES,
  MIGRATION_LEDGER_REQUIREMENT,
];

const VOCAB_REQUIRED_TABLES: readonly TableRequirement[] = [
  ...VOCAB_LEGACY_REQUIRED_TABLES.map((table) => {
    if (table.name === "vocab_review_cards") {
      return {
        ...table,
        columns: [
          ...table.columns,
          "algorithm_version",
          "suspended_from_state",
          "suspended_reason",
          "updated_at",
        ],
      };
    }
    if (table.name === "vocab_review_events") {
      return { ...table, columns: [...table.columns, "activity_id"] };
    }
    return table;
  }),
  MIGRATION_LEDGER_REQUIREMENT,
];

export const VOCAB_SCHEMA_REQUIREMENTS = {
  applicationId: VOCAB_APPLICATION_ID,
  minimumUserVersion: VOCAB_USER_VERSION,
  maximumUserVersion: VOCAB_USER_VERSION,
  // Runtime databases created before crash-safe restore had no explicit
  // SQLite identity. They are accepted only when every Vocabulary table and
  // column below is present.
  sourceApplicationIds: [0, VOCAB_APPLICATION_ID],
  sourceMinimumUserVersion: 0,
  sourceMaximumUserVersion: VOCAB_USER_VERSION,
  sourceRequiredTables: VOCAB_LEGACY_REQUIRED_TABLES,
  requiredTables: VOCAB_REQUIRED_TABLES,
  allowedViews: [],
  allowedTriggers: [],
} as const satisfies DatabaseSchemaRequirements;

export type VocabRestoreAudioMetadata = Readonly<{
  key: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
}>;

export type VocabRestoreAudioMapping = Readonly<{
  original: VocabRestoreAudioMetadata;
  staged: VocabRestoreAudioMetadata;
}>;

const GUARD_TABLE = "temp.__vocab_restore_guard";
const SCHEMA_GUARD_TABLE = "temp.__vocab_restore_schema_guard";

const SCHEMA_V2_STATEMENTS: readonly SqlStatement[] = [
  {
    sql: "ALTER TABLE vocab_review_cards ADD COLUMN algorithm_version INTEGER NOT NULL DEFAULT 2",
  },
  {
    sql: "ALTER TABLE vocab_review_cards ADD COLUMN suspended_from_state TEXT",
  },
  {
    sql: "ALTER TABLE vocab_review_cards ADD COLUMN suspended_reason TEXT",
  },
  {
    sql: "ALTER TABLE vocab_review_cards ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
  },
  {
    sql: "ALTER TABLE vocab_review_events ADD COLUMN activity_id TEXT REFERENCES vocab_activity(id) ON DELETE SET NULL",
  },
  {
    sql: "UPDATE vocab_review_cards SET updated_at=COALESCE(last_review_at,due_at) WHERE updated_at=0",
  },
];

function assertMetadata(metadata: VocabRestoreAudioMetadata, label: string): void {
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
    throw new TypeError(`${label} contains invalid audio metadata.`);
  }
}

function assertMappings(mappings: readonly VocabRestoreAudioMapping[]): void {
  if (!Array.isArray(mappings)) {
    throw new TypeError("Vocabulary restore audio mappings must be an array.");
  }
  const originalKeys = new Set<string>();
  const stagedKeys = new Set<string>();
  for (const [index, mapping] of mappings.entries()) {
    if (!mapping || typeof mapping !== "object") {
      throw new TypeError(`Vocabulary restore mapping ${index} is invalid.`);
    }
    assertMetadata(mapping.original, `Vocabulary restore mapping ${index}.original`);
    assertMetadata(mapping.staged, `Vocabulary restore mapping ${index}.staged`);
    if (originalKeys.has(mapping.original.key)) {
      throw new TypeError("Vocabulary restore mappings contain a duplicate original key.");
    }
    if (stagedKeys.has(mapping.staged.key)) {
      throw new TypeError("Vocabulary restore mappings contain a duplicate staged key.");
    }
    originalKeys.add(mapping.original.key);
    stagedKeys.add(mapping.staged.key);
  }
  for (const key of stagedKeys) {
    if (originalKeys.has(key)) {
      throw new TypeError(
        "Vocabulary restore staged keys must not overlap original keys.",
      );
    }
  }
}

function localAudioGuardStatement(
  audio: readonly VocabRestoreAudioMetadata[],
): SqlStatement {
  if (audio.length === 0) {
    return {
      sql: `INSERT INTO ${GUARD_TABLE}(value)
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM vocab_items
          WHERE audio_url LIKE 'local:%'
        ) THEN 1 ELSE 0 END`,
    };
  }
  const expectedRows = audio.map(() => "(?)").join(", ");
  return {
    sql: `WITH expected(file_key) AS (VALUES ${expectedRows})
      INSERT INTO ${GUARD_TABLE}(value)
      SELECT CASE WHEN
        (SELECT COUNT(DISTINCT substr(audio_url, 7))
          FROM vocab_items WHERE audio_url LIKE 'local:%') = ?
        AND NOT EXISTS (
          SELECT 1 FROM vocab_items AS actual
          WHERE actual.audio_url LIKE 'local:%'
            AND NOT EXISTS (
              SELECT 1 FROM expected
              WHERE expected.file_key = substr(actual.audio_url, 7)
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM expected
          WHERE NOT EXISTS (
            SELECT 1 FROM vocab_items AS actual
            WHERE actual.audio_url = 'local:' || expected.file_key
          )
        )
      THEN 1 ELSE 0 END`,
    params: [...audio.map(({ key }) => key), audio.length],
  };
}

function assertSourceVersion(sourceUserVersion: number): void {
  if (
    !Number.isSafeInteger(sourceUserVersion) ||
    sourceUserVersion < 0 ||
    sourceUserVersion > VOCAB_USER_VERSION
  ) {
    throw new TypeError("Unsupported Vocabulary restore source user_version.");
  }
}

function assertMigrationAppliedAt(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Vocabulary restore migration timestamp is invalid.");
  }
}

function schemaContractGuardStatements(
  tables: readonly TableRequirement[],
  applicationId: number,
  userVersion: number,
  ledgerVersion: 0 | 1 | 2,
): SqlStatement[] {
  const expectedTables = tables.map(() => "(?)").join(", ");
  const statements: SqlStatement[] = [
    {
      sql: `CREATE TEMP TABLE __vocab_restore_schema_guard (
        value INTEGER NOT NULL CHECK (value = 1)
      )`,
    },
    {
      sql: `INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN
          (SELECT application_id FROM pragma_application_id) = ?
          AND (SELECT user_version FROM pragma_user_version) = ?
        THEN 1 ELSE 0 END`,
      params: [applicationId, userVersion],
    },
    {
      sql: `WITH expected(name) AS (VALUES ${expectedTables})
        INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN
          (SELECT COUNT(*) FROM sqlite_schema
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%') = ?
          AND NOT EXISTS (
            SELECT 1 FROM sqlite_schema AS actual
            WHERE actual.type = 'table'
              AND actual.name NOT LIKE 'sqlite_%'
              AND NOT EXISTS (
                SELECT 1 FROM expected WHERE expected.name = actual.name
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM expected
            WHERE NOT EXISTS (
              SELECT 1 FROM sqlite_schema AS actual
              WHERE actual.type = 'table' AND actual.name = expected.name
            )
          )
        THEN 1 ELSE 0 END`,
      params: [...tables.map(({ name }) => name), tables.length],
    },
    ...tables.map(({ name, columns }) => ({
      sql: `INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN (
          SELECT group_concat(name, char(31)) FROM (
            SELECT name FROM pragma_table_info(?) ORDER BY cid
          )
        ) = ? THEN 1 ELSE 0 END`,
      params: [name, columns.join(String.fromCharCode(31))],
    })),
  ];

  if (ledgerVersion > 0) {
    statements.push({
      sql: `INSERT INTO ${SCHEMA_GUARD_TABLE}(value)
        SELECT CASE WHEN
          (SELECT COUNT(*) FROM vocab_schema_migrations) = ?
          AND NOT EXISTS (
            SELECT 1 FROM vocab_schema_migrations
            WHERE version < 1 OR version > ?
          )
          AND NOT EXISTS (
            WITH RECURSIVE expected(version) AS (
              SELECT 1 UNION ALL SELECT version + 1 FROM expected WHERE version < ?
            )
            SELECT 1 FROM expected
            WHERE NOT EXISTS (
              SELECT 1 FROM vocab_schema_migrations AS actual
              WHERE actual.version = expected.version
            )
          )
        THEN 1 ELSE 0 END`,
      params: [ledgerVersion, ledgerVersion, ledgerVersion],
    });
  }

  statements.push({ sql: `DROP TABLE ${SCHEMA_GUARD_TABLE}` });
  return statements;
}

function sourceSchemaContractStatements(sourceUserVersion: number): SqlStatement[] {
  if (sourceUserVersion === 0) {
    return schemaContractGuardStatements(
      VOCAB_LEGACY_REQUIRED_TABLES,
      0,
      0,
      0,
    );
  }
  if (sourceUserVersion === 1) {
    return schemaContractGuardStatements(
      VOCAB_V1_REQUIRED_TABLES,
      VOCAB_APPLICATION_ID,
      1,
      1,
    );
  }
  return schemaContractGuardStatements(
    VOCAB_REQUIRED_TABLES,
    VOCAB_APPLICATION_ID,
    VOCAB_USER_VERSION,
    2,
  );
}

function migrationStatements(
  sourceUserVersion: number,
  migrationAppliedAt: number,
): SqlStatement[] {
  const statements: SqlStatement[] = [];
  if (sourceUserVersion === 0) {
    statements.push(
      {
        sql: `CREATE TABLE vocab_schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        )`,
      },
      {
        sql: "INSERT INTO vocab_schema_migrations(version,name,applied_at) VALUES(?,?,?)",
        params: [1, "adopt-exact-legacy-runtime", migrationAppliedAt],
      },
    );
  }
  if (sourceUserVersion < 2) {
    statements.push(
      ...SCHEMA_V2_STATEMENTS,
      {
        sql: "INSERT INTO vocab_schema_migrations(version,name,applied_at) VALUES(?,?,?)",
        params: [2, "srs-v2", migrationAppliedAt],
      },
    );
  }
  return statements;
}

function canonicalIdentityStatements(): SqlStatement[] {
  return [
    { sql: `PRAGMA application_id = ${VOCAB_APPLICATION_ID}` },
    { sql: `PRAGMA user_version = ${VOCAB_USER_VERSION}` },
  ];
}

function canonicalizeStatements(
  sourceUserVersion: number,
  migrationAppliedAt: number,
): SqlStatement[] {
  return [
    ...migrationStatements(sourceUserVersion, migrationAppliedAt),
    ...canonicalIdentityStatements(),
    ...schemaContractGuardStatements(
      VOCAB_REQUIRED_TABLES,
      VOCAB_APPLICATION_ID,
      VOCAB_USER_VERSION,
      2,
    ),
  ];
}

/**
 * Verify that the container audio is exactly the set referenced by SQLite,
 * remap every local key to its freshly staged OPFS object, then assign the
 * canonical Vocabulary database identity. The worker executes this as one
 * transaction against an inactive candidate.
 */
export function createCompleteVocabRestoreStatements(
  mappings: readonly VocabRestoreAudioMapping[],
  sourceUserVersion = VOCAB_USER_VERSION,
  migrationAppliedAt = Date.now(),
): SqlStatement[] {
  assertSourceVersion(sourceUserVersion);
  assertMigrationAppliedAt(migrationAppliedAt);
  assertMappings(mappings);
  const original = mappings.map(({ original: metadata }) => metadata);
  const staged = mappings.map(({ staged: metadata }) => metadata);
  return [
    ...sourceSchemaContractStatements(sourceUserVersion),
    {
      sql: `CREATE TEMP TABLE __vocab_restore_guard (
        value INTEGER NOT NULL CHECK (value = 1)
      )`,
    },
    localAudioGuardStatement(original),
    ...mappings.map((mapping) => ({
      sql: `UPDATE vocab_items
        SET audio_url = 'local:' || ?
        WHERE audio_url = 'local:' || ?`,
      params: [mapping.staged.key, mapping.original.key],
    })),
    localAudioGuardStatement(staged),
    { sql: `DROP TABLE ${GUARD_TABLE}` },
    ...canonicalizeStatements(sourceUserVersion, migrationAppliedAt),
  ];
}

/**
 * Raw SQLite cannot carry OPFS audio. Clear only local references so remote
 * podcast URLs remain usable and the restored database never binds to an
 * unrelated file already present in this browser.
 */
export function createLegacyVocabRestoreStatements(
  sourceUserVersion = VOCAB_USER_VERSION,
  migrationAppliedAt = Date.now(),
): SqlStatement[] {
  assertSourceVersion(sourceUserVersion);
  assertMigrationAppliedAt(migrationAppliedAt);
  return [
    ...sourceSchemaContractStatements(sourceUserVersion),
    {
      sql: `UPDATE vocab_items SET audio_url = NULL
        WHERE audio_url LIKE 'local:%'`,
    },
    ...canonicalizeStatements(sourceUserVersion, migrationAppliedAt),
  ];
}
