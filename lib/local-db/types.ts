import type { LocalDatabaseName } from "../schemas";

export type { LocalDatabaseName } from "../schemas";

export type LocalDatabaseId = "career" | "vocab";
export type LocalDatabaseSelector = LocalDatabaseId | LocalDatabaseName;

export type SqlValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Uint8Array;

// Keep the public boundary permissive so feature repositories can accept
// unparsed form values. SQLite remains the final runtime validator.
export type SqlParams =
  | readonly unknown[]
  | Readonly<Record<string, unknown>>;

export type SqlRow = Record<string, Exclude<SqlValue, boolean | undefined>>;

export type SqlStatement = Readonly<{
  sql: string;
  params?: SqlParams;
}>;

export type DatabaseInitResult = Readonly<{
  database: LocalDatabaseName;
  filename: `${string}.sqlite3`;
  persistent: true;
  sqliteVersion: string;
  schemaVersion: number;
  seeded: false;
}>;

export type QueryResult<Row extends object = SqlRow> = Readonly<{
  columns: readonly string[];
  rows: readonly Row[];
  rowCount: number;
}>;

export type RunResult = Readonly<{
  changes: number;
  lastInsertRowId: number | bigint | null;
}>;

export type BatchResult = Readonly<{
  results: readonly RunResult[];
  changes: number;
}>;

export type DatabaseExportResult = Readonly<{
  database: LocalDatabaseName;
  filename: `${string}.sqlite3`;
  schemaVersion: number;
  exportedAt: string;
  data: Uint8Array;
}>;

export type DatabaseImportResult = DatabaseInitResult &
  Readonly<{
    importedBytes: number;
  }>;

export type DatabaseTableRequirement = Readonly<{
  name: string;
  columns: readonly string[];
}>;

/**
 * The identity contract supplied by the trusted restore implementation.
 *
 * These values are deliberately data rather than executable migrations. The
 * worker validates them both before and after the fixed mapping statements so
 * an unrelated SQLite file can never become the live Career database merely
 * because it contains a table with a familiar name.
 */
export type DatabaseSchemaRequirements = Readonly<{
  /** Canonical identity required after the mapping transaction. */
  applicationId: number;
  minimumUserVersion: number;
  maximumUserVersion: number;
  /**
   * Explicit legacy identities accepted before mappings. Omit to accept only
   * `applicationId`. This is the sole path for upgrading old appId=0 files.
   */
  sourceApplicationIds?: readonly number[];
  sourceMinimumUserVersion?: number;
  sourceMaximumUserVersion?: number;
  /**
   * Minimum table contract checked before trusted migrations run. This lets a
   * legacy source be accepted without weakening the stricter canonical
   * contract below. Omit to reuse `requiredTables` for both phases.
   */
  sourceRequiredTables?: readonly DatabaseTableRequirement[];
  requiredTables: readonly DatabaseTableRequirement[];
  allowedViews?: readonly string[];
  allowedTriggers?: readonly string[];
}>;

export type StagedDatabaseImportResult<
  DatabaseName extends LocalDatabaseName = LocalDatabaseName,
> = Readonly<{
  database: DatabaseName;
  generationId: string;
  filename: `${DatabaseName}.${string}.sqlite3`;
  activationToken: string;
  importedBytes: number;
  schemaVersion: number;
}>;

export type ActivatedDatabaseGeneration<
  DatabaseName extends LocalDatabaseName = LocalDatabaseName,
> = DatabaseInitResult &
  Readonly<{
    database: DatabaseName;
    generationId: string;
    sequence: number;
  }>;

export type CurrentDatabaseGeneration<
  DatabaseName extends LocalDatabaseName = LocalDatabaseName,
> = Readonly<{
  database: DatabaseName;
  generationId: string;
  filename: `${string}.sqlite3`;
  sequence: number;
  legacy: boolean;
}>;

export type DiscardedDatabaseGeneration<
  DatabaseName extends LocalDatabaseName = LocalDatabaseName,
> = Readonly<{
  database: DatabaseName;
  generationId: string;
  discarded: true;
}>;

export const DATABASE_GENERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const DATABASE_ACTIVATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

// Backward-compatible aliases retained for callers and recovery tests that
// predate staged generations for the Vocabulary database.
export const CAREER_GENERATION_ID_PATTERN = DATABASE_GENERATION_ID_PATTERN;
export const CAREER_ACTIVATION_TOKEN_PATTERN = DATABASE_ACTIVATION_TOKEN_PATTERN;

export type DatabaseGenerationPointerCore = Readonly<{
  version: 1;
  sequence: number;
  filename: `${string}.sqlite3`;
}>;

export type RankedDatabaseGenerationPointer = DatabaseGenerationPointerCore &
  Readonly<{
    slot: "a" | "b";
    checksum: string;
  }>;

export type CareerGenerationPointerCore = DatabaseGenerationPointerCore;
export type RankedCareerGenerationPointer = RankedDatabaseGenerationPointer;

export function isDatabaseGenerationId(value: string): boolean {
  return DATABASE_GENERATION_ID_PATTERN.test(value);
}

export function isDatabaseActivationToken(value: string): boolean {
  return DATABASE_ACTIVATION_TOKEN_PATTERN.test(value);
}

export function isCareerGenerationId(value: string): boolean {
  return isDatabaseGenerationId(value);
}

export function isCareerActivationToken(value: string): boolean {
  return isDatabaseActivationToken(value);
}

export function databaseGenerationFilename<
  DatabaseName extends LocalDatabaseName,
>(
  database: DatabaseName,
  generationId: string,
): `${DatabaseName}.${string}.sqlite3` {
  if (!isDatabaseGenerationId(generationId)) {
    throw new TypeError("Invalid database generation id.");
  }
  return `${database}.${generationId}.sqlite3`;
}

export function careerGenerationFilename(
  generationId: string,
): `zhiji.${string}.sqlite3` {
  return databaseGenerationFilename("zhiji", generationId);
}

/** Stable byte-for-byte checksum input, namespaced per product database. */
export function databaseGenerationPointerChecksumInput(
  database: LocalDatabaseName,
  pointer: DatabaseGenerationPointerCore,
): string {
  const product = database === "zhiji" ? "career" : "vocab";
  return `private-ai-suite:${product}-pointer:v${pointer.version}\n${pointer.sequence}\n${pointer.filename}\n`;
}

/** Stable byte-for-byte checksum input. Do not replace with object JSON order. */
export function careerGenerationPointerChecksumInput(
  pointer: CareerGenerationPointerCore,
): string {
  return databaseGenerationPointerChecksumInput("zhiji", pointer);
}

/** Highest sequence wins; the slot tie-break keeps recovery deterministic. */
export function rankDatabaseGenerationPointers(
  pointers: readonly RankedDatabaseGenerationPointer[],
): RankedDatabaseGenerationPointer[] {
  return [...pointers].sort(
    (left, right) =>
      right.sequence - left.sequence ||
      right.slot.localeCompare(left.slot) ||
      right.filename.localeCompare(left.filename),
  );
}

export function rankCareerGenerationPointers(
  pointers: readonly RankedCareerGenerationPointer[],
): RankedCareerGenerationPointer[] {
  return rankDatabaseGenerationPointers(pointers);
}

export type InitAllResult = Readonly<{
  career: DatabaseInitResult;
  vocab: DatabaseInitResult;
}>;

export type WorkerOperation =
  | "init"
  | "query"
  | "run"
  | "batch"
  | "export"
  | "import"
  | "stageImport"
  | "activateStaged"
  | "currentGeneration"
  | "discardStaged"
  | "reset";

type RequestBase<Operation extends WorkerOperation> = Readonly<{
  id: number;
  operation: Operation;
  database: LocalDatabaseName;
}>;

export type LocalDbWorkerRequest =
  | RequestBase<"init">
  | (RequestBase<"query"> & { sql: string; params?: SqlParams })
  | (RequestBase<"run"> & { sql: string; params?: SqlParams })
  | (RequestBase<"batch"> & {
      statements: readonly SqlStatement[];
      transaction?: boolean;
    })
  | RequestBase<"export">
  | (RequestBase<"import"> & { data: ArrayBuffer })
  | (RequestBase<"stageImport"> & {
      data: ArrayBuffer;
      statements: readonly SqlStatement[];
      requirements: DatabaseSchemaRequirements;
    })
  | (RequestBase<"activateStaged"> & {
      generationId: string;
      activationToken: string;
    })
  | RequestBase<"currentGeneration">
  | (RequestBase<"discardStaged"> & {
      generationId: string;
      activationToken: string;
    })
  | RequestBase<"reset">;

type WithoutRequestId<Request> = Request extends unknown
  ? Omit<Request, "id">
  : never;

export type LocalDbWorkerRequestInput = WithoutRequestId<LocalDbWorkerRequest>;

export type SerializedWorkerError = Readonly<{
  name: string;
  message: string;
  code?: string;
}>;

export type LocalDbWorkerResponse =
  | Readonly<{ id: number; ok: true; result: unknown }>
  | Readonly<{ id: number; ok: false; error: SerializedWorkerError }>;

export const DATABASE_FILES: Readonly<
  Record<LocalDatabaseName, `${string}.sqlite3`>
> = {
  zhiji: "zhiji.sqlite3",
  shici: "shici.sqlite3",
};

export function canonicalDatabaseName(
  database: LocalDatabaseSelector,
): LocalDatabaseName {
  if (database === "career") return "zhiji";
  if (database === "vocab") return "shici";
  return database;
}
