import sqlite3InitModule, {
  type BindingSpec,
  type Database,
  type Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";

import {
  databaseGenerationFilename,
  databaseGenerationPointerChecksumInput,
  DATABASE_FILES,
  isDatabaseActivationToken,
  isDatabaseGenerationId,
  rankDatabaseGenerationPointers,
  type ActivatedDatabaseGeneration,
  type BatchResult,
  type DatabaseGenerationPointerCore,
  type CurrentDatabaseGeneration,
  type DatabaseExportResult,
  type DatabaseImportResult,
  type DatabaseInitResult,
  type DatabaseRecoveryReceipt,
  type DatabaseRecoveryStageOptions,
  type DatabaseSchemaRequirements,
  type DiscardedDatabaseGeneration,
  type LocalDatabaseName,
  type LocalDbWorkerRequest,
  type LocalDbWorkerResponse,
  type QueryResult,
  type RankedDatabaseGenerationPointer,
  type RunResult,
  type SerializedWorkerError,
  type SqlParams,
  type SqlRow,
  type SqlStatement,
  type StagedDatabaseImportResult,
} from "./types";

type WorkerScope = {
  onmessage: ((event: MessageEvent<LocalDbWorkerRequest>) => void) | null;
  postMessage(message: LocalDbWorkerResponse, transfer?: Transferable[]): void;
};

type OpenDatabase = {
  db: Database;
  name: LocalDatabaseName;
  filename: `${string}.sqlite3`;
  generationId: string;
  sequence: number;
  pointerSlot: "a" | "b" | null;
};

type NormalizedSchemaRequirements = Readonly<{
  applicationId: number;
  minimumUserVersion: number;
  maximumUserVersion: number;
  sourceApplicationIds: readonly number[];
  sourceMinimumUserVersion: number;
  sourceMaximumUserVersion: number;
  sourceRequiredTables: readonly Readonly<{
    name: string;
    columns: readonly string[];
  }>[];
  requiredTables: readonly Readonly<{
    name: string;
    columns: readonly string[];
  }>[];
  allowedViews: readonly string[];
  allowedTriggers: readonly string[];
}>;

type StoredGenerationPointer = DatabaseGenerationPointerCore &
  Readonly<{ checksum: string }>;

type StagedGenerationReadyV1Core = Readonly<{
  version: 1;
  generationId: string;
  filename: `${string}.sqlite3`;
  tokenSha256: string;
  databaseSha256: string;
  importedBytes: number;
  requirements: NormalizedSchemaRequirements;
}>;

type StagedGenerationRecoveryBinding = Readonly<{
  version: 1;
  database: LocalDatabaseName;
  recoveryTokenSha256: string;
  expectedCurrentGenerationId: string;
  expectedCurrentSequence: number;
  expectedCurrentDatabaseSha256: string;
  canonicalApplicationId: number;
  canonicalUserVersion: number;
  projectionSha256: string;
}>;

type StagedGenerationReadyV2Core = Readonly<{
  version: 2;
  generationId: string;
  filename: `${string}.sqlite3`;
  tokenSha256: string;
  databaseSha256: string;
  importedBytes: number;
  requirements: NormalizedSchemaRequirements;
  recovery: StagedGenerationRecoveryBinding;
}>;

type StagedGenerationReadyCore =
  | StagedGenerationReadyV1Core
  | StagedGenerationReadyV2Core;

type StagedGenerationReady = StagedGenerationReadyCore &
  Readonly<{ checksum: string }>;

type DiscardedBoundGenerationCore = Readonly<{
  version: 1;
  status: "pending" | "complete";
  database: LocalDatabaseName;
  generationId: string;
  filename: `${string}.sqlite3`;
  activationTokenSha256: string;
  recovery: StagedGenerationRecoveryBinding;
}>;

type DiscardedBoundGeneration = DiscardedBoundGenerationCore &
  Readonly<{ checksum: string }>;

class LocalDbWorkerError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "LocalDbWorkerError";
  }
}

const workerScope = globalThis as unknown as WorkerScope;
const openDatabases = new Map<LocalDatabaseName, OpenDatabase>();
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const MAX_MAPPING_STATEMENTS = 10_000;
const MAX_MAPPING_SQL_CHARACTERS = 1024 * 1024;
const MAX_POINTER_BYTES = 16 * 1024;
const GENERATION_FILES = {
  zhiji: {
    label: "Career",
    pointerFiles: {
      a: "zhiji.active-a.json",
      b: "zhiji.active-b.json",
    },
    legacyFilename: DATABASE_FILES.zhiji,
  },
  shici: {
    label: "Vocabulary",
    pointerFiles: {
      a: "shici.active-a.json",
      b: "shici.active-b.json",
    },
    legacyFilename: DATABASE_FILES.shici,
  },
  shilian: {
    label: "Fitness",
    pointerFiles: {
      a: "shilian.active-a.json",
      b: "shilian.active-b.json",
    },
    legacyFilename: DATABASE_FILES.shilian,
  },
} as const satisfies Record<
  LocalDatabaseName,
  {
    label: string;
    pointerFiles: Record<"a" | "b", string>;
    legacyFilename: `${string}.sqlite3`;
  }
>;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
let sqlitePromise: Promise<Sqlite3Static> | undefined;
let operationQueue = Promise.resolve();

function getSqlite(): Promise<Sqlite3Static> {
  sqlitePromise ??= sqlite3InitModule().then((sqlite3) => {
    if (typeof SharedArrayBuffer === "undefined") {
      throw new LocalDbWorkerError(
        "SQLite OPFS needs a cross-origin-isolated page. Serve COOP: same-origin and COEP: require-corp headers.",
        "CROSS_ORIGIN_ISOLATION_REQUIRED",
      );
    }

    if (!sqlite3.capi.sqlite3_vfs_find("opfs")) {
      throw new LocalDbWorkerError(
        "This browser does not expose the SQLite OPFS VFS. Use a supported non-private browser context.",
        "OPFS_UNAVAILABLE",
      );
    }

    return sqlite3;
  });

  return sqlitePromise;
}

function configureDatabase(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA trusted_schema = OFF;
  `);
}

function schemaVersion(db: Database): number {
  return Number(db.selectValue("PRAGMA user_version") ?? 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const copy = bytes.slice().buffer;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy)));
}

async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

function equalDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function generationIdFromFilename(
  name: LocalDatabaseName,
  filename: string,
): string | null {
  if (filename === GENERATION_FILES[name].legacyFilename) return "legacy";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}\\.([^.]+)\\.sqlite3$`).exec(filename);
  return match && isDatabaseGenerationId(match[1]) ? match[1] : null;
}

function stagedReadyFilename(
  name: LocalDatabaseName,
  generationId: string,
): string {
  return `${name}.${generationId}.ready.json`;
}

function activatedGenerationFilename(
  name: LocalDatabaseName,
  generationId: string,
): string {
  return `${name}.${generationId}.activated.json`;
}

function discardedGenerationFilename(
  name: LocalDatabaseName,
  generationId: string,
): string {
  return `${name}.${generationId}.discarded.json`;
}

function assertIntegerInRange(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new LocalDbWorkerError(`${label} is invalid.`, "INVALID_SCHEMA_REQUIREMENTS");
  }
}

function normalizeIdentifiers(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new LocalDbWorkerError(`${label} must be an array.`, "INVALID_SCHEMA_REQUIREMENTS");
  }
  const unique = new Set<string>();
  for (const identifier of value) {
    if (typeof identifier !== "string" || !IDENTIFIER_PATTERN.test(identifier)) {
      throw new LocalDbWorkerError(
        `${label} contains an invalid SQLite identifier.`,
        "INVALID_SCHEMA_REQUIREMENTS",
      );
    }
    if (unique.has(identifier)) {
      throw new LocalDbWorkerError(
        `${label} contains a duplicate SQLite identifier.`,
        "INVALID_SCHEMA_REQUIREMENTS",
      );
    }
    unique.add(identifier);
  }
  return [...unique].sort();
}

function normalizeTableRequirements(
  value: unknown,
  label: string,
): Array<{ name: string; columns: string[] }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new LocalDbWorkerError(
      `${label} must declare at least one database table.`,
      "INVALID_SCHEMA_REQUIREMENTS",
    );
  }
  const tableNames = new Set<string>();
  return value.map((table, index) => {
    if (!isRecord(table) || typeof table.name !== "string" || !IDENTIFIER_PATTERN.test(table.name)) {
      throw new LocalDbWorkerError(
        `${label}[${index}] has an invalid name.`,
        "INVALID_SCHEMA_REQUIREMENTS",
      );
    }
    if (tableNames.has(table.name)) {
      throw new LocalDbWorkerError(
        `${label} contains duplicate table ${table.name}.`,
        "INVALID_SCHEMA_REQUIREMENTS",
      );
    }
    tableNames.add(table.name);
    const columns = normalizeIdentifiers(table.columns, `${label}[${index}].columns`);
    if (columns.length === 0) {
      throw new LocalDbWorkerError(
        `${label}[${index}] must declare at least one column.`,
        "INVALID_SCHEMA_REQUIREMENTS",
      );
    }
    return { name: table.name, columns };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeSchemaRequirements(
  value: unknown,
): NormalizedSchemaRequirements {
  if (!isRecord(value)) {
    throw new LocalDbWorkerError(
      "The staged import schema requirements are invalid.",
      "INVALID_SCHEMA_REQUIREMENTS",
    );
  }

  assertIntegerInRange(value.applicationId, "applicationId", 0, 0x7fffffff);
  assertIntegerInRange(value.minimumUserVersion, "minimumUserVersion", 0, 0x7fffffff);
  assertIntegerInRange(value.maximumUserVersion, "maximumUserVersion", 0, 0x7fffffff);
  if (value.minimumUserVersion > value.maximumUserVersion) {
    throw new LocalDbWorkerError(
      "The canonical user_version range is reversed.",
      "INVALID_SCHEMA_REQUIREMENTS",
    );
  }

  const sourceIdsValue = value.sourceApplicationIds ?? [value.applicationId];
  if (!Array.isArray(sourceIdsValue) || sourceIdsValue.length === 0) {
    throw new LocalDbWorkerError(
      "sourceApplicationIds must contain at least one identity.",
      "INVALID_SCHEMA_REQUIREMENTS",
    );
  }
  const sourceApplicationIds = [...new Set(sourceIdsValue.map((entry) => {
    assertIntegerInRange(entry, "sourceApplicationIds", 0, 0x7fffffff);
    return entry;
  }))].sort((left, right) => left - right);
  if (sourceApplicationIds.length !== sourceIdsValue.length) {
    throw new LocalDbWorkerError(
      "sourceApplicationIds contains a duplicate identity.",
      "INVALID_SCHEMA_REQUIREMENTS",
    );
  }

  const sourceMinimumUserVersion =
    value.sourceMinimumUserVersion ?? value.minimumUserVersion;
  const sourceMaximumUserVersion =
    value.sourceMaximumUserVersion ?? value.maximumUserVersion;
  assertIntegerInRange(
    sourceMinimumUserVersion,
    "sourceMinimumUserVersion",
    0,
    0x7fffffff,
  );
  assertIntegerInRange(
    sourceMaximumUserVersion,
    "sourceMaximumUserVersion",
    0,
    0x7fffffff,
  );
  if (sourceMinimumUserVersion > sourceMaximumUserVersion) {
    throw new LocalDbWorkerError(
      "The source user_version range is reversed.",
      "INVALID_SCHEMA_REQUIREMENTS",
    );
  }

  const requiredTables = normalizeTableRequirements(
    value.requiredTables,
    "requiredTables",
  );
  const sourceRequiredTables = value.sourceRequiredTables === undefined
    ? requiredTables
    : normalizeTableRequirements(value.sourceRequiredTables, "sourceRequiredTables");

  return {
    applicationId: value.applicationId,
    minimumUserVersion: value.minimumUserVersion,
    maximumUserVersion: value.maximumUserVersion,
    sourceApplicationIds,
    sourceMinimumUserVersion,
    sourceMaximumUserVersion,
    sourceRequiredTables,
    requiredTables,
    allowedViews: normalizeIdentifiers(value.allowedViews ?? [], "allowedViews"),
    allowedTriggers: normalizeIdentifiers(value.allowedTriggers ?? [], "allowedTriggers"),
  };
}

function assertMappingStatements(statements: readonly SqlStatement[]): void {
  if (!Array.isArray(statements) || statements.length > MAX_MAPPING_STATEMENTS) {
    throw new LocalDbWorkerError(
      "The staged import contains too many mapping statements.",
      "INVALID_IMPORT_MAPPINGS",
    );
  }
  const forbidden = /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|VACUUM)\b/i;
  const unsafePragma = /^PRAGMA\s+(?:writable_schema|journal_mode|locking_mode)\b/i;
  for (const statement of statements) {
    if (
      !isRecord(statement) ||
      typeof statement.sql !== "string" ||
      statement.sql.trim().length === 0 ||
      statement.sql.length > MAX_MAPPING_SQL_CHARACTERS ||
      forbidden.test(statement.sql.trim()) ||
      unsafePragma.test(statement.sql.trim())
    ) {
      throw new LocalDbWorkerError(
        "A staged import mapping statement is invalid or unsafe.",
        "INVALID_IMPORT_MAPPINGS",
      );
    }
  }
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage || typeof navigator.storage.getDirectory !== "function") {
    throw new LocalDbWorkerError(
      "This browser does not expose the Origin Private File System.",
      "OPFS_UNAVAILABLE",
    );
  }
  return navigator.storage.getDirectory();
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.name === "NotFoundError";
}

async function readOptionalFile(filename: string): Promise<File | null> {
  const root = await opfsRoot();
  try {
    return await (await root.getFileHandle(filename)).getFile();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function writeJsonFile(filename: string, value: unknown): Promise<void> {
  const root = await opfsRoot();
  const handle = await root.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(JSON.stringify(value));
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

async function removeOpfsEntryIfPresent(filename: string): Promise<boolean> {
  const root = await opfsRoot();
  try {
    await root.removeEntry(filename);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function readGenerationPointer(
  name: LocalDatabaseName,
  slot: "a" | "b",
): Promise<RankedDatabaseGenerationPointer | null> {
  const file = await readOptionalFile(GENERATION_FILES[name].pointerFiles[slot]);
  if (!file || file.size > MAX_POINTER_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["version", "sequence", "filename", "checksum"]) ||
    parsed.version !== 1 ||
    typeof parsed.sequence !== "number" ||
    !Number.isSafeInteger(parsed.sequence) ||
    parsed.sequence < 1 ||
    typeof parsed.filename !== "string" ||
    generationIdFromFilename(name, parsed.filename) === null ||
    typeof parsed.checksum !== "string" ||
    !SHA256_PATTERN.test(parsed.checksum)
  ) {
    return null;
  }
  const pointer: DatabaseGenerationPointerCore = {
    version: 1,
    sequence: parsed.sequence,
    filename: parsed.filename as `${string}.sqlite3`,
  };
  const checksum = await sha256Text(
    databaseGenerationPointerChecksumInput(name, pointer),
  );
  if (!equalDigest(checksum, parsed.checksum)) return null;
  return { ...pointer, slot, checksum };
}

async function readRankedGenerationPointers(
  name: LocalDatabaseName,
): Promise<RankedDatabaseGenerationPointer[]> {
  const [a, b] = await Promise.all([
    readGenerationPointer(name, "a"),
    readGenerationPointer(name, "b"),
  ]);
  return rankDatabaseGenerationPointers([a, b].filter(
    (pointer): pointer is RankedDatabaseGenerationPointer => pointer !== null,
  ));
}

async function writeGenerationPointer(
  name: LocalDatabaseName,
  slot: "a" | "b",
  sequence: number,
  filename: `${string}.sqlite3`,
): Promise<RankedDatabaseGenerationPointer> {
  if (generationIdFromFilename(name, filename) === null) {
    throw new LocalDbWorkerError(
      `The ${GENERATION_FILES[name].label} generation pointer targets another database.`,
      "GENERATION_DATABASE_MISMATCH",
    );
  }
  const core: DatabaseGenerationPointerCore = { version: 1, sequence, filename };
  const checksum = await sha256Text(
    databaseGenerationPointerChecksumInput(name, core),
  );
  const stored: StoredGenerationPointer = { ...core, checksum };
  await writeJsonFile(GENERATION_FILES[name].pointerFiles[slot], stored);
  // createWritable() commits atomically when close() resolves. Do not add an
  // awaited verification read here: an error after that durable commit would
  // leave the running worker on the old handle while recovery selects new.
  return { ...core, slot, checksum };
}

function stagedReadyChecksumInput(value: StagedGenerationReadyCore): string {
  return JSON.stringify(value);
}

async function writeStagedReady(
  name: LocalDatabaseName,
  value: StagedGenerationReadyCore,
): Promise<void> {
  const checksum = await sha256Text(stagedReadyChecksumInput(value));
  await writeJsonFile(stagedReadyFilename(name, value.generationId), {
    ...value,
    checksum,
  } satisfies StagedGenerationReady);
}

async function readStagedReady(
  name: LocalDatabaseName,
  generationId: string,
): Promise<StagedGenerationReady> {
  const label = GENERATION_FILES[name].label;
  const file = await readOptionalFile(stagedReadyFilename(name, generationId));
  if (!file || file.size > 512 * 1024) {
    throw new LocalDbWorkerError(
      `The staged ${label} generation is not READY.`,
      "STAGED_GENERATION_NOT_READY",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new LocalDbWorkerError(
      `The staged ${label} generation READY record is corrupt.`,
      "STAGED_GENERATION_NOT_READY",
    );
  }
  const commonKeys = [
    "version",
    "generationId",
    "filename",
    "tokenSha256",
    "databaseSha256",
    "importedBytes",
    "requirements",
    "checksum",
  ] as const;
  if (
    !isRecord(parsed) ||
    (parsed.version !== 1 && parsed.version !== 2) ||
    !hasExactKeys(parsed, parsed.version === 1 ? commonKeys : [...commonKeys, "recovery"]) ||
    parsed.generationId !== generationId ||
    parsed.filename !== databaseGenerationFilename(name, generationId) ||
    typeof parsed.tokenSha256 !== "string" ||
    !SHA256_PATTERN.test(parsed.tokenSha256) ||
    typeof parsed.databaseSha256 !== "string" ||
    !SHA256_PATTERN.test(parsed.databaseSha256) ||
    typeof parsed.importedBytes !== "number" ||
    !Number.isSafeInteger(parsed.importedBytes) ||
    parsed.importedBytes < 100 ||
    parsed.importedBytes > MAX_IMPORT_BYTES ||
    typeof parsed.checksum !== "string" ||
    !SHA256_PATTERN.test(parsed.checksum)
  ) {
    throw new LocalDbWorkerError(
      `The staged ${label} generation READY record is invalid.`,
      "STAGED_GENERATION_NOT_READY",
    );
  }
  const common = {
    generationId,
    filename: parsed.filename as `${string}.sqlite3`,
    tokenSha256: parsed.tokenSha256,
    databaseSha256: parsed.databaseSha256,
    importedBytes: parsed.importedBytes,
    requirements: normalizeSchemaRequirements(parsed.requirements),
  };
  let core: StagedGenerationReadyCore;
  if (parsed.version === 1) {
    core = { version: 1, ...common };
  } else {
    const recovery = parseStoredRecoveryBinding(name, parsed.recovery);
    if (
      recovery.canonicalApplicationId !== common.requirements.applicationId ||
      recovery.canonicalUserVersion < common.requirements.minimumUserVersion ||
      recovery.canonicalUserVersion > common.requirements.maximumUserVersion
    ) {
      throw new LocalDbWorkerError(
        `The staged ${label} recovery identity is inconsistent.`,
        "STAGED_GENERATION_NOT_READY",
      );
    }
    core = { version: 2, ...common, recovery };
  }
  const checksum = await sha256Text(stagedReadyChecksumInput(core));
  if (!equalDigest(checksum, parsed.checksum)) {
    throw new LocalDbWorkerError(
      `The staged ${label} generation READY checksum is invalid.`,
      "STAGED_GENERATION_NOT_READY",
    );
  }
  return { ...core, checksum };
}

function normalizeRecoveryStageOptions(
  value: DatabaseRecoveryStageOptions | undefined,
): DatabaseRecoveryStageOptions | null {
  if (value === undefined) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["projectionSha256"]) ||
    typeof value.projectionSha256 !== "string" ||
    !SHA256_PATTERN.test(value.projectionSha256)
  ) {
    throw new LocalDbWorkerError(
      "The staged recovery projection digest is invalid.",
      "INVALID_RECOVERY_PROJECTION",
    );
  }
  return { projectionSha256: value.projectionSha256 };
}

function parseStoredRecoveryBinding(
  name: LocalDatabaseName,
  value: unknown,
): StagedGenerationRecoveryBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "database",
      "recoveryTokenSha256",
      "expectedCurrentGenerationId",
      "expectedCurrentSequence",
      "expectedCurrentDatabaseSha256",
      "canonicalApplicationId",
      "canonicalUserVersion",
      "projectionSha256",
    ]) ||
    value.version !== 1 ||
    value.database !== name ||
    typeof value.recoveryTokenSha256 !== "string" ||
    !SHA256_PATTERN.test(value.recoveryTokenSha256) ||
    typeof value.expectedCurrentGenerationId !== "string" ||
    !(value.expectedCurrentGenerationId === "legacy" ||
      isDatabaseGenerationId(value.expectedCurrentGenerationId)) ||
    typeof value.expectedCurrentSequence !== "number" ||
    !Number.isSafeInteger(value.expectedCurrentSequence) ||
    value.expectedCurrentSequence < 0 ||
    (value.expectedCurrentGenerationId === "legacy" &&
      value.expectedCurrentSequence !== 0) ||
    typeof value.expectedCurrentDatabaseSha256 !== "string" ||
    !SHA256_PATTERN.test(value.expectedCurrentDatabaseSha256) ||
    typeof value.canonicalApplicationId !== "number" ||
    !Number.isSafeInteger(value.canonicalApplicationId) ||
    value.canonicalApplicationId < 0 ||
    value.canonicalApplicationId > 0x7fffffff ||
    typeof value.canonicalUserVersion !== "number" ||
    !Number.isSafeInteger(value.canonicalUserVersion) ||
    value.canonicalUserVersion < 0 ||
    value.canonicalUserVersion > 0x7fffffff ||
    typeof value.projectionSha256 !== "string" ||
    !SHA256_PATTERN.test(value.projectionSha256)
  ) {
    throw new LocalDbWorkerError(
      `The staged ${GENERATION_FILES[name].label} recovery binding is invalid.`,
      "STAGED_GENERATION_NOT_READY",
    );
  }
  return {
    version: 1,
    database: name,
    recoveryTokenSha256: value.recoveryTokenSha256,
    expectedCurrentGenerationId: value.expectedCurrentGenerationId,
    expectedCurrentSequence: value.expectedCurrentSequence,
    expectedCurrentDatabaseSha256: value.expectedCurrentDatabaseSha256,
    canonicalApplicationId: value.canonicalApplicationId,
    canonicalUserVersion: value.canonicalUserVersion,
    projectionSha256: value.projectionSha256,
  };
}

function discardedGenerationChecksumInput(
  value: DiscardedBoundGenerationCore,
): string {
  return JSON.stringify(value);
}

async function writeDiscardedBoundGeneration(
  name: LocalDatabaseName,
  value: DiscardedBoundGenerationCore,
): Promise<void> {
  const checksum = await sha256Text(discardedGenerationChecksumInput(value));
  await writeJsonFile(discardedGenerationFilename(name, value.generationId), {
    ...value,
    checksum,
  } satisfies DiscardedBoundGeneration);
}

async function readDiscardedBoundGeneration(
  name: LocalDatabaseName,
  generationId: string,
): Promise<DiscardedBoundGeneration | null> {
  const file = await readOptionalFile(discardedGenerationFilename(name, generationId));
  if (!file) return null;
  if (file.size > 64 * 1024) {
    throw new LocalDbWorkerError(
      "The staged discard record is invalid.",
      "DISCARD_RECORD_INVALID",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new LocalDbWorkerError(
      "The staged discard record is invalid.",
      "DISCARD_RECORD_INVALID",
    );
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      "version", "status", "database", "generationId", "filename",
      "activationTokenSha256", "recovery", "checksum",
    ]) ||
    parsed.version !== 1 ||
    (parsed.status !== "pending" && parsed.status !== "complete") ||
    parsed.database !== name ||
    parsed.generationId !== generationId ||
    parsed.filename !== databaseGenerationFilename(name, generationId) ||
    typeof parsed.activationTokenSha256 !== "string" ||
    !SHA256_PATTERN.test(parsed.activationTokenSha256) ||
    typeof parsed.checksum !== "string" ||
    !SHA256_PATTERN.test(parsed.checksum)
  ) {
    throw new LocalDbWorkerError(
      "The staged discard record is invalid.",
      "DISCARD_RECORD_INVALID",
    );
  }
  const core: DiscardedBoundGenerationCore = {
    version: 1,
    status: parsed.status,
    database: name,
    generationId,
    filename: parsed.filename as `${string}.sqlite3`,
    activationTokenSha256: parsed.activationTokenSha256,
    recovery: parseStoredRecoveryBinding(name, parsed.recovery),
  };
  const checksum = await sha256Text(discardedGenerationChecksumInput(core));
  if (!equalDigest(checksum, parsed.checksum)) {
    throw new LocalDbWorkerError(
      "The staged discard record checksum is invalid.",
      "DISCARD_RECORD_INVALID",
    );
  }
  return { ...core, checksum };
}

async function assertActivationToken(
  name: LocalDatabaseName,
  ready: StagedGenerationReady,
  activationToken: string,
): Promise<void> {
  const label = GENERATION_FILES[name].label;
  if (!isDatabaseActivationToken(activationToken)) {
    throw new LocalDbWorkerError(
      `The staged ${label} activation token is invalid.`,
      "INVALID_ACTIVATION_TOKEN",
    );
  }
  const digest = await sha256Text(activationToken);
  if (!equalDigest(digest, ready.tokenSha256)) {
    throw new LocalDbWorkerError(
      `The staged ${label} activation token does not match.`,
      "INVALID_ACTIVATION_TOKEN",
    );
  }
}

async function assertRecoveryReceipt(
  name: LocalDatabaseName,
  ready: StagedGenerationReady,
  value: DatabaseRecoveryReceipt | undefined,
): Promise<StagedGenerationRecoveryBinding | null> {
  if (ready.version === 1) {
    if (value !== undefined) {
      throw new LocalDbWorkerError(
        "This staged generation does not have a recovery binding.",
        "RECOVERY_BINDING_MISMATCH",
      );
    }
    return null;
  }
  if (value === undefined) {
    throw new LocalDbWorkerError(
      "This staged generation requires its recovery receipt.",
      "RECOVERY_BINDING_REQUIRED",
    );
  }
  await assertRecoveryReceiptMatches(
    name,
    ready.generationId,
    ready.recovery,
    value,
  );
  return ready.recovery;
}

async function assertRecoveryReceiptMatches(
  name: LocalDatabaseName,
  generationId: string,
  recovery: StagedGenerationRecoveryBinding,
  value: DatabaseRecoveryReceipt,
): Promise<void> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "database",
      "generationId",
      "recoveryToken",
      "expectedCurrentGenerationId",
      "expectedCurrentSequence",
      "canonicalApplicationId",
      "canonicalUserVersion",
      "projectionSha256",
    ]) ||
    value.version !== 1 ||
    value.database !== name ||
    value.generationId !== generationId ||
    typeof value.recoveryToken !== "string" ||
    !SHA256_PATTERN.test(value.recoveryToken) ||
    value.expectedCurrentGenerationId !== recovery.expectedCurrentGenerationId ||
    value.expectedCurrentSequence !== recovery.expectedCurrentSequence ||
    value.canonicalApplicationId !== recovery.canonicalApplicationId ||
    value.canonicalUserVersion !== recovery.canonicalUserVersion ||
    value.projectionSha256 !== recovery.projectionSha256
  ) {
    throw new LocalDbWorkerError(
      "The staged recovery receipt does not match its durable binding.",
      "RECOVERY_BINDING_MISMATCH",
    );
  }
  const recoveryTokenSha256 = await sha256Text(value.recoveryToken);
  if (!equalDigest(recoveryTokenSha256, recovery.recoveryTokenSha256)) {
    throw new LocalDbWorkerError(
      "The staged recovery receipt does not match its durable binding.",
      "RECOVERY_BINDING_MISMATCH",
    );
  }
}

async function openDatabase(
  name: LocalDatabaseName,
): Promise<{ state: OpenDatabase; opened: boolean }> {
  const cached = openDatabases.get(name);
  const existing = cached?.db.isOpen() ? cached : undefined;
  if (cached && !existing) openDatabases.delete(name);
  const sqlite3 = await getSqlite();
  // Workers are tab-local, so a BroadcastChannel refresh cannot invalidate
  // another tab's handle. Durable pointers are the authority on every request.
  const pointers = await readRankedGenerationPointers(name);
  for (const pointer of pointers) {
    if (existing?.filename === pointer.filename) {
      const generationId = generationIdFromFilename(name, pointer.filename);
      if (!generationId) continue;
      existing.generationId = generationId;
      existing.sequence = pointer.sequence;
      existing.pointerSlot = pointer.slot;
      return { state: existing, opened: false };
    }

    let db: Database | undefined;
    let state: OpenDatabase | undefined;
    try {
      db = new sqlite3.oo1.OpfsDb(`/${pointer.filename}`, "w");
      configureDatabase(db);
      assertIntegrity(db);
      const generationId = generationIdFromFilename(name, pointer.filename);
      if (!generationId) throw new Error("Invalid generation filename.");
      state = {
        db,
        name,
        filename: pointer.filename,
        generationId,
        sequence: pointer.sequence,
        pointerSlot: pointer.slot,
      } satisfies OpenDatabase;
    } catch {
      db?.close();
      // A corrupt or missing newer generation must not mask the older valid
      // pointer. The legacy path below remains the final recovery anchor.
      continue;
    }
    openDatabases.set(name, state);
    try {
      existing?.db.close();
    } catch {
      // The newly selected durable generation is already authoritative.
    }
    return { state, opened: true };
  }

  const filename = DATABASE_FILES[name];
  if (existing?.filename === filename) {
    existing.generationId = "legacy";
    existing.sequence = 0;
    existing.pointerSlot = null;
    return { state: existing, opened: false };
  }
  const db = new sqlite3.oo1.OpfsDb(`/${filename}`, "c");
  try {
    configureDatabase(db);
    assertIntegrity(db);
    const state = {
      db,
      name,
      filename,
      generationId: "legacy",
      sequence: 0,
      pointerSlot: null,
    } satisfies OpenDatabase;
    openDatabases.set(name, state);
    try {
      existing?.db.close();
    } catch {
      // The legacy recovery handle is already selected in the cache.
    }
    return { state, opened: true };
  } catch (error) {
    db.close();
    throw error;
  }
}

async function initDatabase(name: LocalDatabaseName): Promise<DatabaseInitResult> {
  const sqlite3 = await getSqlite();
  const { state } = await openDatabase(name);

  return {
    database: name,
    filename: state.filename,
    persistent: true,
    sqliteVersion: sqlite3.version.libVersion,
    schemaVersion: schemaVersion(state.db),
    seeded: false,
  };
}

function bindStatement(statement: ReturnType<Database["prepare"]>, params?: SqlParams): void {
  const hasValues = Array.isArray(params)
    ? params.length > 0
    : params !== undefined && Object.keys(params).length > 0;
  if (hasValues) statement.bind(params as BindingSpec);
}

function executeQuery<Row extends object = SqlRow>(
  db: Database,
  sql: string,
  params?: SqlParams,
): QueryResult<Row> {
  const statement = db.prepare(sql);
  const columns = statement.columnCount > 0 ? statement.getColumnNames([]) : [];
  const rows: Row[] = [];

  try {
    bindStatement(statement, params);
    while (statement.step()) {
      rows.push(statement.get({}) as Row);
    }
  } finally {
    statement.finalize();
  }

  return { columns, rows, rowCount: rows.length };
}

function executeRun(db: Database, sql: string, params?: SqlParams): RunResult {
  const statement = db.prepare(sql);

  try {
    bindStatement(statement, params);
    while (statement.step()) {
      // Consume RETURNING rows so the statement completes before finalization.
    }
  } finally {
    statement.finalize();
  }

  const lastInsertRowId = db.selectValue("SELECT last_insert_rowid()") ?? null;
  return {
    changes: Number(db.changes()),
    lastInsertRowId:
      typeof lastInsertRowId === "number" || typeof lastInsertRowId === "bigint"
        ? lastInsertRowId
        : null,
  };
}

function executeBatch(
  db: Database,
  statements: readonly SqlStatement[],
  useTransaction = true,
): BatchResult {
  const runStatements = () => statements.map(({ sql, params }) => executeRun(db, sql, params));
  const results = useTransaction
    ? db.transaction("IMMEDIATE", runStatements)
    : runStatements();

  return {
    results,
    changes: results.reduce((total, result) => total + result.changes, 0),
  };
}

function exportBytes(sqlite3: Sqlite3Static, db: Database): Uint8Array {
  db.exec("PRAGMA optimize");
  return sqlite3.capi.sqlite3_js_db_export(db).slice();
}

function assertSQLiteFile(data: Uint8Array): void {
  const header = "SQLite format 3\0";
  if (data.byteLength < 100) {
    throw new LocalDbWorkerError("The import is too small to be a SQLite database.", "INVALID_IMPORT");
  }
  if (data.byteLength > MAX_IMPORT_BYTES) {
    throw new LocalDbWorkerError(
      "The SQLite import exceeds the 512 MiB safety limit.",
      "IMPORT_TOO_LARGE",
    );
  }

  for (let index = 0; index < header.length; index += 1) {
    if (data[index] !== header.charCodeAt(index)) {
      throw new LocalDbWorkerError("The import is not a SQLite 3 database.", "INVALID_IMPORT");
    }
  }
}

function assertIntegrity(db: Database): void {
  const integrity = db.selectValue("PRAGMA integrity_check");
  if (integrity !== "ok") {
    throw new LocalDbWorkerError(
      `SQLite integrity check failed: ${String(integrity ?? "unknown error")}`,
      "IMPORT_INTEGRITY_FAILED",
    );
  }

  const foreignKeyFailures = db.selectObjects("PRAGMA foreign_key_check");
  if (foreignKeyFailures.length > 0) {
    throw new LocalDbWorkerError(
      `SQLite foreign-key check found ${foreignKeyFailures.length} violation(s).`,
      "IMPORT_FOREIGN_KEY_FAILED",
    );
  }
}

function configureReadOnlyDatabase(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA trusted_schema = OFF;
  `);
}

function assertDatabaseContract(
  db: Database,
  requirements: NormalizedSchemaRequirements,
  phase: "source" | "canonical",
): void {
  const applicationId = Number(db.selectValue("PRAGMA application_id") ?? 0);
  const userVersion = schemaVersion(db);
  const allowedApplicationIds =
    phase === "source"
      ? requirements.sourceApplicationIds
      : [requirements.applicationId];
  const minimumUserVersion =
    phase === "source"
      ? requirements.sourceMinimumUserVersion
      : requirements.minimumUserVersion;
  const maximumUserVersion =
    phase === "source"
      ? requirements.sourceMaximumUserVersion
      : requirements.maximumUserVersion;

  if (!allowedApplicationIds.includes(applicationId)) {
    throw new LocalDbWorkerError(
      `The ${phase} database application_id is not allowed.`,
      "IMPORT_IDENTITY_MISMATCH",
    );
  }
  if (userVersion < minimumUserVersion || userVersion > maximumUserVersion) {
    throw new LocalDbWorkerError(
      `The ${phase} database user_version is unsupported.`,
      "IMPORT_SCHEMA_VERSION_UNSUPPORTED",
    );
  }

  const requiredTables = phase === "source"
    ? requirements.sourceRequiredTables
    : requirements.requiredTables;
  for (const table of requiredTables) {
    const tableType = db.selectValue(
      "SELECT type FROM sqlite_schema WHERE name=?",
      [table.name],
    );
    if (tableType !== "table") {
      throw new LocalDbWorkerError(
        `The import is missing required table ${table.name}.`,
        "IMPORT_SCHEMA_MISMATCH",
      );
    }
    const escapedName = table.name.replaceAll('"', '""');
    const columns = new Set(
      (db.selectObjects(`PRAGMA table_info("${escapedName}")`) as Array<{ name?: unknown }>)
        .flatMap((column) => typeof column.name === "string" ? [column.name] : []),
    );
    const missing = table.columns.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new LocalDbWorkerError(
        `Table ${table.name} is missing required column(s): ${missing.join(", ")}.`,
        "IMPORT_SCHEMA_MISMATCH",
      );
    }
  }

  const allowedObjects = {
    view: new Set(requirements.allowedViews),
    trigger: new Set(requirements.allowedTriggers),
  };
  const schemaObjects = db.selectObjects(
    "SELECT type,name FROM sqlite_schema WHERE type IN ('view','trigger') AND name NOT LIKE 'sqlite_%'",
  ) as Array<{ type?: unknown; name?: unknown }>;
  for (const object of schemaObjects) {
    if (
      (object.type !== "view" && object.type !== "trigger") ||
      typeof object.name !== "string" ||
      !allowedObjects[object.type].has(object.name)
    ) {
      throw new LocalDbWorkerError(
        "The import contains an unknown view or trigger.",
        "IMPORT_UNSAFE_SCHEMA_OBJECT",
      );
    }
  }
}

function exportUnmodifiedBytes(sqlite3: Sqlite3Static, db: Database): Uint8Array {
  return sqlite3.capi.sqlite3_js_db_export(db).slice();
}

function newActivationToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

async function stageDatabaseImport(
  name: LocalDatabaseName,
  replacement: Uint8Array,
  statements: readonly SqlStatement[],
  rawRequirements: DatabaseSchemaRequirements,
  rawRecovery: DatabaseRecoveryStageOptions | undefined,
): Promise<StagedDatabaseImportResult> {
  const label = GENERATION_FILES[name].label;
  assertSQLiteFile(replacement);
  assertMappingStatements(statements);
  const requirements = normalizeSchemaRequirements(rawRequirements);
  const recoveryOptions = normalizeRecoveryStageOptions(rawRecovery);
  const sqlite3 = await getSqlite();
  // The worker, not the caller, captures the durable baseline. This happens
  // before candidate writes and is persisted in READY for the later compare.
  const recoveryBaselineState = recoveryOptions
    ? (await openDatabase(name)).state
    : null;
  // Never retain a mutable OpenDatabase object across the long import. The
  // READY baseline is the exact primitive snapshot observed before staging.
  const recoveryBaseline = recoveryBaselineState
    ? {
        generationId: recoveryBaselineState.generationId,
        sequence: recoveryBaselineState.sequence,
        databaseSha256: await sha256Bytes(
          exportUnmodifiedBytes(sqlite3, recoveryBaselineState.db),
        ),
      }
    : null;
  const generationId = crypto.randomUUID().toLowerCase();
  if (!isDatabaseGenerationId(generationId)) {
    throw new LocalDbWorkerError(
      `The browser could not create a safe ${label} generation id.`,
      "GENERATION_ID_UNAVAILABLE",
    );
  }
  const filename = databaseGenerationFilename(name, generationId);
  const readyFilename = stagedReadyFilename(name, generationId);
  const activationToken = newActivationToken();
  const recoveryToken = recoveryOptions ? newActivationToken() : null;
  let canonicalSchemaVersion = requirements.minimumUserVersion;
  let candidate: Database | undefined;

  const [
    existingCandidate,
    existingReady,
    existingActivation,
    existingDiscard,
  ] = await Promise.all([
    readOptionalFile(filename),
    readOptionalFile(readyFilename),
    readOptionalFile(activatedGenerationFilename(name, generationId)),
    readOptionalFile(discardedGenerationFilename(name, generationId)),
  ]);
  if (existingCandidate || existingReady || existingActivation || existingDiscard) {
    throw new LocalDbWorkerError(
      `The random ${label} generation id already exists; retry the staged import.`,
      "GENERATION_ID_COLLISION",
    );
  }

  try {
    await sqlite3.oo1.OpfsDb.importDb(`/${filename}`, replacement);
    candidate = new sqlite3.oo1.OpfsDb(`/${filename}`, "w");
    configureDatabase(candidate);
    assertIntegrity(candidate);
    assertDatabaseContract(candidate, requirements, "source");
    executeBatch(candidate, statements, true);
    assertIntegrity(candidate);
    assertDatabaseContract(candidate, requirements, "canonical");
    candidate.close();
    candidate = undefined;

    // A close/reopen boundary catches failures hidden by the importing
    // connection and is the point after which the candidate is immutable.
    candidate = new sqlite3.oo1.OpfsDb(`/${filename}`, "r");
    configureReadOnlyDatabase(candidate);
    assertIntegrity(candidate);
    assertDatabaseContract(candidate, requirements, "canonical");
    canonicalSchemaVersion = schemaVersion(candidate);
    const databaseSha256 = await sha256Bytes(
      exportUnmodifiedBytes(sqlite3, candidate),
    );
    candidate.close();
    candidate = undefined;

    const tokenSha256 = await sha256Text(activationToken);
    let recoveryReceipt: DatabaseRecoveryReceipt | undefined;
    if (recoveryOptions && recoveryBaseline && recoveryToken) {
      const recovery: StagedGenerationRecoveryBinding = {
        version: 1,
        database: name,
        recoveryTokenSha256: await sha256Text(recoveryToken),
        expectedCurrentGenerationId: recoveryBaseline.generationId,
        expectedCurrentSequence: recoveryBaseline.sequence,
        expectedCurrentDatabaseSha256: recoveryBaseline.databaseSha256,
        canonicalApplicationId: requirements.applicationId,
        canonicalUserVersion: canonicalSchemaVersion,
        projectionSha256: recoveryOptions.projectionSha256,
      };
      await writeStagedReady(name, {
        version: 2,
        generationId,
        filename,
        tokenSha256,
        databaseSha256,
        importedBytes: replacement.byteLength,
        requirements,
        recovery,
      });
      recoveryReceipt = {
        version: 1,
        database: name,
        generationId,
        recoveryToken,
        expectedCurrentGenerationId: recovery.expectedCurrentGenerationId,
        expectedCurrentSequence: recovery.expectedCurrentSequence,
        canonicalApplicationId: recovery.canonicalApplicationId,
        canonicalUserVersion: recovery.canonicalUserVersion,
        projectionSha256: recovery.projectionSha256,
      };
    } else {
      await writeStagedReady(name, {
        version: 1,
        generationId,
        filename,
        tokenSha256,
        databaseSha256,
        importedBytes: replacement.byteLength,
        requirements,
      });
    }

    return {
      database: name,
      generationId,
      filename,
      activationToken,
      importedBytes: replacement.byteLength,
      schemaVersion: canonicalSchemaVersion,
      ...(recoveryReceipt ? { recoveryReceipt } : {}),
    };
  } catch (error) {
    candidate?.close();
    await Promise.allSettled([
      removeOpfsEntryIfPresent(readyFilename),
      removeOpfsEntryIfPresent(activatedGenerationFilename(name, generationId)),
      removeOpfsEntryIfPresent(filename),
    ]);
    throw error;
  }
}

async function validateReadyCandidate(
  name: LocalDatabaseName,
  ready: StagedGenerationReady,
): Promise<void> {
  const sqlite3 = await getSqlite();
  let candidate: Database | undefined;
  try {
    candidate = new sqlite3.oo1.OpfsDb(`/${ready.filename}`, "r");
    configureReadOnlyDatabase(candidate);
    assertIntegrity(candidate);
    assertDatabaseContract(candidate, ready.requirements, "canonical");
    const digest = await sha256Bytes(exportUnmodifiedBytes(sqlite3, candidate));
    if (!equalDigest(digest, ready.databaseSha256)) {
      throw new LocalDbWorkerError(
        `The staged ${GENERATION_FILES[name].label} database changed after it became READY.`,
        "STAGED_GENERATION_CHANGED",
      );
    }
  } finally {
    candidate?.close();
  }
}

async function activateStagedDatabaseGeneration(
  name: LocalDatabaseName,
  generationId: string,
  activationToken: string,
  recoveryReceipt: DatabaseRecoveryReceipt | undefined,
): Promise<ActivatedDatabaseGeneration> {
  const label = GENERATION_FILES[name].label;
  if (!isDatabaseGenerationId(generationId)) {
    throw new LocalDbWorkerError(
      `The staged ${label} generation id is invalid.`,
      "INVALID_GENERATION_ID",
    );
  }
  if (await readOptionalFile(discardedGenerationFilename(name, generationId))) {
    throw new LocalDbWorkerError(
      `The staged ${label} generation is being discarded.`,
      "STAGED_GENERATION_DISCARDING",
    );
  }
  const ready = await readStagedReady(name, generationId);
  await assertActivationToken(name, ready, activationToken);
  const recovery = await assertRecoveryReceipt(name, ready, recoveryReceipt);
  const { state: active } = await openDatabase(name);
  const sqlite3 = await getSqlite();

  // Idempotent retry: the caller may have lost the successful response after
  // the durable pointer commit.
  if (active.filename === ready.filename) {
    return {
      database: name,
      filename: active.filename,
      persistent: true,
      sqliteVersion: sqlite3.version.libVersion,
      schemaVersion: schemaVersion(active.db),
      seeded: false,
      generationId,
      sequence: active.sequence,
    };
  }

  if (
    recovery &&
    (active.generationId !== recovery.expectedCurrentGenerationId ||
      active.sequence !== recovery.expectedCurrentSequence ||
      !equalDigest(
        await sha256Bytes(exportUnmodifiedBytes(sqlite3, active.db)),
        recovery.expectedCurrentDatabaseSha256,
      ))
  ) {
    throw new LocalDbWorkerError(
      `The current ${label} generation changed after this restore was prepared.`,
      "STAGED_BASELINE_CHANGED",
    );
  }

  await validateReadyCandidate(name, ready);
  let candidate: Database | undefined;
  try {
    candidate = new sqlite3.oo1.OpfsDb(`/${ready.filename}`, "w");
    configureDatabase(candidate);

    let pointers = await readRankedGenerationPointers(name);
    if (active.pointerSlot === null) {
      const presentSlots = new Set(pointers.map((pointer) => pointer.slot));
      const baselineSlot: "a" | "b" = !presentSlots.has("a")
        ? "a"
        : !presentSlots.has("b")
          ? "b"
          : pointers.at(-1)?.slot ?? "a";
      const baselineSequence = Math.max(0, ...pointers.map((pointer) => pointer.sequence)) + 1;
      const baseline = await writeGenerationPointer(
        name,
        baselineSlot,
        baselineSequence,
        active.filename,
      );
      active.pointerSlot = baseline.slot;
      active.sequence = baseline.sequence;
      pointers = await readRankedGenerationPointers(name);
    }

    const targetSlot: "a" | "b" = active.pointerSlot === "a" ? "b" : "a";
    const nextSequence = Math.max(active.sequence, ...pointers.map((pointer) => pointer.sequence)) + 1;

    // This durable intent precedes the pointer commit. It may conservatively
    // retain a candidate if the next write fails, but it guarantees discard
    // can never delete a generation which was active in the past after both
    // pointer slots have subsequently rotated.
    await writeJsonFile(activatedGenerationFilename(name, generationId), {
      version: 1,
      generationId,
      filename: ready.filename,
    });
    const committed = await writeGenerationPointer(
      name,
      targetSlot,
      nextSequence,
      ready.filename,
    );

    // No awaited or validation work belongs after the durable pointer commit:
    // from this instruction onward the in-memory handle mirrors disk state.
    const nextState: OpenDatabase = {
      db: candidate,
      name,
      filename: ready.filename,
      generationId,
      sequence: committed.sequence,
      pointerSlot: committed.slot,
    };
    candidate = undefined;
    openDatabases.set(name, nextState);
    try {
      active.db.close();
    } catch {
      // The durable pointer and replacement handle are already authoritative.
    }

    return {
      database: name,
      filename: nextState.filename,
      persistent: true,
      sqliteVersion: sqlite3.version.libVersion,
      schemaVersion: schemaVersion(nextState.db),
      seeded: false,
      generationId,
      sequence: nextState.sequence,
    };
  } finally {
    candidate?.close();
  }
}

async function currentDatabaseGeneration(
  name: LocalDatabaseName,
): Promise<CurrentDatabaseGeneration> {
  const { state } = await openDatabase(name);
  return {
    database: name,
    generationId: state.generationId,
    filename: state.filename,
    sequence: state.sequence,
    legacy: state.filename === GENERATION_FILES[name].legacyFilename,
  };
}

async function inspectStagedDatabaseGeneration(
  name: LocalDatabaseName,
  generationId: string,
  activationToken: string,
  recoveryReceipt: DatabaseRecoveryReceipt | undefined,
): Promise<CurrentDatabaseGeneration> {
  const label = GENERATION_FILES[name].label;
  if (!isDatabaseGenerationId(generationId)) {
    throw new LocalDbWorkerError(
      `The staged ${label} generation id is invalid.`,
      "INVALID_GENERATION_ID",
    );
  }
  const ready = await readStagedReady(name, generationId);
  await assertActivationToken(name, ready, activationToken);
  await assertRecoveryReceipt(name, ready, recoveryReceipt);
  return currentDatabaseGeneration(name);
}

async function rawPointerReferences(
  name: LocalDatabaseName,
  filename: string,
): Promise<boolean> {
  for (const pointerFilename of Object.values(GENERATION_FILES[name].pointerFiles)) {
    const file = await readOptionalFile(pointerFilename);
    if (!file || file.size > MAX_POINTER_BYTES) continue;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (isRecord(parsed) && parsed.filename === filename) return true;
    } catch {
      // A corrupt pointer with no readable target cannot prove activation.
    }
  }
  return false;
}

async function discardStagedDatabaseGeneration(
  name: LocalDatabaseName,
  generationId: string,
  activationToken: string,
  recoveryReceipt: DatabaseRecoveryReceipt | undefined,
): Promise<DiscardedDatabaseGeneration> {
  const label = GENERATION_FILES[name].label;
  if (!isDatabaseGenerationId(generationId)) {
    throw new LocalDbWorkerError(
      `The staged ${label} generation id is invalid.`,
      "INVALID_GENERATION_ID",
    );
  }
  const discarded = await readDiscardedBoundGeneration(name, generationId);
  if (discarded) {
    if (!isDatabaseActivationToken(activationToken)) {
      throw new LocalDbWorkerError(
        `The staged ${label} activation token is invalid.`,
        "INVALID_ACTIVATION_TOKEN",
      );
    }
    const activationTokenSha256 = await sha256Text(activationToken);
    if (!equalDigest(activationTokenSha256, discarded.activationTokenSha256)) {
      throw new LocalDbWorkerError(
        `The staged ${label} activation token does not match.`,
        "INVALID_ACTIVATION_TOKEN",
      );
    }
    if (recoveryReceipt === undefined) {
      throw new LocalDbWorkerError(
        "This staged generation requires its recovery receipt.",
        "RECOVERY_BINDING_REQUIRED",
      );
    }
    await assertRecoveryReceiptMatches(
      name,
      generationId,
      discarded.recovery,
      recoveryReceipt,
    );
    if (discarded.status === "pending") {
      await removeOpfsEntryIfPresent(discarded.filename);
      await removeOpfsEntryIfPresent(stagedReadyFilename(name, generationId));
      await writeDiscardedBoundGeneration(name, {
        version: 1,
        status: "complete",
        database: name,
        generationId,
        filename: discarded.filename,
        activationTokenSha256: discarded.activationTokenSha256,
        recovery: discarded.recovery,
      });
    }
    return { database: name, generationId, discarded: true };
  }
  const ready = await readStagedReady(name, generationId);
  await assertActivationToken(name, ready, activationToken);
  await assertRecoveryReceipt(name, ready, recoveryReceipt);
  const active = openDatabases.get(name);
  const activationMarker = await readOptionalFile(
    activatedGenerationFilename(name, generationId),
  );
  if (
    activationMarker !== null ||
    active?.filename === ready.filename ||
    await rawPointerReferences(name, ready.filename)
  ) {
    throw new LocalDbWorkerError(
      `An activated ${label} generation cannot be discarded.`,
      "GENERATION_ALREADY_ACTIVATED",
    );
  }

  if (ready.version === 2) {
    const pending: DiscardedBoundGenerationCore = {
      version: 1,
      status: "pending",
      database: name,
      generationId,
      filename: ready.filename,
      activationTokenSha256: ready.tokenSha256,
      recovery: ready.recovery,
    };
    await writeDiscardedBoundGeneration(name, pending);
    await removeOpfsEntryIfPresent(ready.filename);
    await removeOpfsEntryIfPresent(stagedReadyFilename(name, generationId));
    await writeDiscardedBoundGeneration(name, { ...pending, status: "complete" });
  } else {
    await removeOpfsEntryIfPresent(ready.filename);
    await removeOpfsEntryIfPresent(stagedReadyFilename(name, generationId));
  }
  return { database: name, generationId, discarded: true };
}

async function replaceDatabase(
  name: LocalDatabaseName,
  replacement: Uint8Array,
): Promise<DatabaseInitResult> {
  const sqlite3 = await getSqlite();
  const { state } = await openDatabase(name);
  const backup = exportBytes(sqlite3, state.db);
  const filename = state.filename;

  state.db.close();
  openDatabases.delete(name);

  let replacementDb: Database | undefined;
  try {
    await sqlite3.oo1.OpfsDb.importDb(`/${filename}`, replacement);
    replacementDb = new sqlite3.oo1.OpfsDb(`/${filename}`, "c");
    configureDatabase(replacementDb);
    assertIntegrity(replacementDb);
    openDatabases.set(name, { ...state, db: replacementDb });

    return {
      database: name,
      filename,
      persistent: true,
      sqliteVersion: sqlite3.version.libVersion,
      schemaVersion: schemaVersion(replacementDb),
      seeded: false,
    };
  } catch (error) {
    replacementDb?.close();
    openDatabases.delete(name);

    try {
      await sqlite3.oo1.OpfsDb.importDb(`/${filename}`, backup);
      const restored = new sqlite3.oo1.OpfsDb(`/${filename}`, "c");
      configureDatabase(restored);
      openDatabases.set(name, { ...state, db: restored });
    } catch {
      // Preserve the original import error; a subsequent init will retry opening.
    }

    throw error;
  }
}

function createEmptyDatabase(sqlite3: Sqlite3Static): Uint8Array {
  const memoryDb = new sqlite3.oo1.DB(":memory:", "c");
  try {
    // Force SQLite to materialize a valid, non-empty database image.
    memoryDb.exec(`
      CREATE TABLE __local_db_reset_sentinel (id INTEGER PRIMARY KEY);
      DROP TABLE __local_db_reset_sentinel;
      VACUUM;
    `);
    return sqlite3.capi.sqlite3_js_db_export(memoryDb).slice();
  } finally {
    memoryDb.close();
  }
}

async function handleRequest(request: LocalDbWorkerRequest): Promise<unknown> {
  switch (request.operation) {
    case "init":
      return initDatabase(request.database);
    case "query": {
      const { state } = await openDatabase(request.database);
      return executeQuery(state.db, request.sql, request.params);
    }
    case "run": {
      const { state } = await openDatabase(request.database);
      return executeRun(state.db, request.sql, request.params);
    }
    case "batch": {
      const { state } = await openDatabase(request.database);
      return executeBatch(
        state.db,
        request.statements,
        request.transaction ?? true,
      );
    }
    case "export": {
      const sqlite3 = await getSqlite();
      const { state } = await openDatabase(request.database);
      const data = exportBytes(sqlite3, state.db);
      return {
        database: request.database,
        filename: state.filename,
        schemaVersion: schemaVersion(state.db),
        exportedAt: new Date().toISOString(),
        data,
      } satisfies DatabaseExportResult;
    }
    case "import": {
      const data = new Uint8Array(request.data);
      assertSQLiteFile(data);
      const result = await replaceDatabase(request.database, data);
      return { ...result, importedBytes: data.byteLength } satisfies DatabaseImportResult;
    }
    case "stageImport":
      return stageDatabaseImport(
        request.database,
        new Uint8Array(request.data),
        request.statements,
        request.requirements,
        request.recovery,
      );
    case "activateStaged":
      return activateStagedDatabaseGeneration(
        request.database,
        request.generationId,
        request.activationToken,
        request.recoveryReceipt,
      );
    case "inspectStaged":
      return inspectStagedDatabaseGeneration(
        request.database,
        request.generationId,
        request.activationToken,
        request.recoveryReceipt,
      );
    case "currentGeneration":
      return currentDatabaseGeneration(request.database);
    case "discardStaged":
      return discardStagedDatabaseGeneration(
        request.database,
        request.generationId,
        request.activationToken,
        request.recoveryReceipt,
      );
    case "reset": {
      const sqlite3 = await getSqlite();
      return replaceDatabase(request.database, createEmptyDatabase(sqlite3));
    }
  }
}

function serializeError(error: unknown): SerializedWorkerError {
  if (error instanceof LocalDbWorkerError) {
    return { name: error.name, message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

function transferablesFor(result: unknown): Transferable[] {
  if (
    result &&
    typeof result === "object" &&
    "data" in result &&
    (result as { data?: unknown }).data instanceof Uint8Array
  ) {
    return [(result as { data: Uint8Array }).data.buffer];
  }
  return [];
}

async function respond(request: LocalDbWorkerRequest): Promise<void> {
  try {
    const result = await handleRequest(request);
    workerScope.postMessage(
      { id: request.id, ok: true, result },
      transferablesFor(result),
    );
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      ok: false,
      error: serializeError(error),
    });
  }
}

workerScope.onmessage = (event) => {
  operationQueue = operationQueue.then(() => respond(event.data));
};
