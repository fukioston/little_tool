import { localDb } from "@/lib/local-db/client";
import {
  assertLocalFileKeyAvailable,
  deleteOwnedLocalFile,
  getLocalFile,
  saveLocalFileAtKey,
  sha256Blob,
  type LocalFileMetadata,
  type SaveLocalFileOptions,
} from "@/lib/local-db/files";
import type {
  ActivatedDatabaseGeneration,
  CurrentDatabaseGeneration,
  DatabasePrepareOperationReceipt,
  DatabasePrepareRecoveryResult,
  DatabaseRecoveryReceipt,
  DatabaseExportResult,
  SqlParams,
  SqlStatement,
  StagedDatabaseImportResult,
} from "@/lib/local-db/types";
import {
  createFitnessBackupBlob,
  parseFitnessBackupBlob,
  FITNESS_BACKUP_LIMITS,
  FITNESS_BACKUP_MAGIC,
  type ParsedFitnessBackup,
  type FitnessBackupFileInput,
  type FitnessBackupFileMetadata,
} from "./backup-format";
import {
  createCompleteFitnessRestoreStatements,
  createLegacyFitnessRestoreStatements,
  FITNESS_SCHEMA_REQUIREMENTS,
  FITNESS_USER_VERSION,
  type FitnessRestoreFileMapping,
} from "./backup-plan";
import { broadcastFitnessChange, withFitnessWriteLock } from "./lock";

const DATABASE = "fitness" as const;
const CANONICAL_DATABASE = "shilian" as const;
const backupMagicBytes = new TextEncoder().encode(FITNESS_BACKUP_MAGIC);
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SQLITE_IDENTITY_BYTE_SIZE = 72;
const sqliteHeaderBytes = new TextEncoder().encode("SQLite format 3\u0000");

export type CompleteFitnessBackupExport = Readonly<{
  blob: Blob;
  fileName: string;
  fileCount: number;
  byteSize: number;
}>;

export type CompleteFitnessBackupRestore = Readonly<{
  fileCount: number;
  byteSize: number;
  exportedAt: string;
  previousRecoverySnapshotRetained: true;
}>;

export type LegacyFitnessBackupRestore = Readonly<{
  byteSize: number;
  previousRecoverySnapshotRetained: true;
}>;

/**
 * Counts that require querying the isolated candidate remain null. Reporting
 * the active database's counts here would misdescribe the selected backup.
 */
export type FitnessRestoreSummary = Readonly<{
  kind: "complete-backup" | "legacy-fitness-sqlite";
  fileName: string | null;
  byteSize: number;
  databaseByteSize: number;
  exportedAt: string | null;
  sourceUserVersion: number;
  canonicalUserVersion: number;
  fileCount: number;
  venueCount: null;
  equipmentCount: null;
  exerciseCount: null;
  sessionCount: null;
  verification:
    | "container-and-payload-verified"
    | "fitness-schema-verified";
}>;

/**
 * JSON-safe worker-bound capability for one isolated READY generation. Source
 * bytes, file metadata, names and user prose are intentionally absent.
 */
export type FitnessRestoreReceipt = Readonly<{
  version: 1;
  database: "shilian";
  generationId: string;
  activationToken: string;
  recoveryToken: string;
  expectedCurrentGenerationId: string;
  expectedCurrentSequence: number;
  canonicalApplicationId: number;
  canonicalUserVersion: number;
  databaseSha256: string;
  filesSha256: string;
  projectionSha256: string;
  preparedAt: string;
  summary: FitnessRestoreSummary;
  stagedFileKeys: readonly string[];
}>;

/** Persist this capability before the first OPFS or database staging write. */
export type FitnessPrepareRecoveryReceipt = Readonly<{
  version: 1;
  database: "shilian";
  operationId: string;
  generationId: string;
  operationToken: string;
  databaseSha256: string;
  filesSha256: string;
  projectionSha256: string;
  fileKeysSha256: string;
  preparedAt: string;
  summary: FitnessRestoreSummary;
  stagedFileKeys: readonly string[];
}>;

/** Worker-bound authorization to delete only this prepare's staged files. */
export type FitnessPrepareCleanupReceipt = Readonly<{
  version: 1;
  database: "shilian";
  operationId: string;
  generationId: string;
  operationToken: string;
  projectionSha256: string;
  fileKeysSha256: string;
  stagedFileKeys: readonly string[];
}>;

export type FitnessPrepareRecovery =
  | Readonly<{ status: "ready"; receipt: FitnessRestoreReceipt }>
  | Readonly<{
      status: "cleanup-pending" | "cleanup-complete";
      cleanupReceipt: FitnessPrepareCleanupReceipt;
    }>
  | Readonly<{ status: "discarded" }>;

export type FitnessBackupRestoreOptions = Readonly<{
  signal?: AbortSignal;
  onRecoveryPrepared?(
    receipt: FitnessPrepareRecoveryReceipt,
  ): void | Promise<void>;
}>;

export type FitnessRestoreActivation = Readonly<{
  generationId: string;
  summary: FitnessRestoreSummary;
  outcome: "activated" | "already-current" | "confirmed-after-lost-response";
  previousRecoverySnapshotRetained: true;
}>;

export type FitnessRestoreActivationInspection = Readonly<{
  status: "current" | "different-current";
  currentGenerationId: string;
  currentSequence: number;
}>;

export type FitnessRestoreDiscard = Readonly<{
  discarded: true;
  fileCleanup: "complete" | "incomplete";
  failedFileKeys: readonly string[];
}>;

export type FitnessRestoreErrorCode =
  | "INVALID_RECEIPT"
  | "PREPARE_ABORTED"
  | "LEGACY_BACKUP_TOO_LARGE"
  | "UNRECOGNIZED_SQLITE"
  | "UNSUPPORTED_SOURCE"
  | "PREPARE_FAILED"
  | "PREPARE_CLEANUP_INCOMPLETE"
  | "PREPARE_UNCERTAIN"
  | "CURRENT_GENERATION_UNAVAILABLE"
  | "CURRENT_GENERATION_CHANGED"
  | "ACTIVATION_FAILED"
  | "ACTIVATION_UNCERTAIN"
  | "DISCARD_UNCERTAIN";

export class FitnessRestoreError extends Error {
  readonly cause?: unknown;

  constructor(
    message: string,
    readonly code: FitnessRestoreErrorCode,
    cause?: unknown,
  ) {
    super(message);
    this.name = "FitnessRestoreError";
    this.cause = cause;
  }
}

export class FitnessRestoreAbortedError extends FitnessRestoreError {
  constructor() {
    super("已停止核对备份，当前健身数据没有改变。", "PREPARE_ABORTED");
    this.name = "AbortError";
  }
}

export class FitnessActivationUncertainError extends FitnessRestoreError {
  constructor(
    readonly targetGenerationId: string,
    readonly receipt: FitnessRestoreReceipt,
    cause?: unknown,
  ) {
    super(
      "恢复切换结果暂时无法确认。候选与核对信息均已保留；请只核对当前版本，不要重新恢复。",
      "ACTIVATION_UNCERTAIN",
      cause,
    );
    this.name = "FitnessActivationUncertainError";
  }
}

export class FitnessCurrentGenerationChangedError extends FitnessRestoreError {
  constructor(
    readonly receipt: FitnessRestoreReceipt,
    readonly currentGenerationId: string,
    readonly currentSequence: number,
  ) {
    super(
      "当前健身数据已在另一个页面更新或切换。这次没有覆盖它，请重新核对后再决定。",
      "CURRENT_GENERATION_CHANGED",
    );
    this.name = "FitnessCurrentGenerationChangedError";
  }
}

export class FitnessDiscardUncertainError extends FitnessRestoreError {
  constructor(readonly receipt: FitnessRestoreReceipt, cause?: unknown) {
    super(
      "候选清理结果暂时无法确认。恢复凭据已保留，请稍后只重试清理。",
      "DISCARD_UNCERTAIN",
      cause,
    );
    this.name = "FitnessDiscardUncertainError";
  }
}

export class FitnessPrepareUncertainError extends FitnessRestoreError {
  constructor(readonly receipt: FitnessPrepareRecoveryReceipt, cause?: unknown) {
    super(
      "候选建立结果暂时无法确认。操作凭据已保留；请只恢复这次准备，不要重新选择备份。",
      "PREPARE_UNCERTAIN",
      cause,
    );
    this.name = "FitnessPrepareUncertainError";
  }
}

export class FitnessPrepareCleanupIncompleteError extends FitnessRestoreError {
  constructor(readonly receipt: FitnessPrepareCleanupReceipt, cause?: unknown) {
    super(
      `有 ${receipt.stagedFileKeys.length} 个未启用的暂存附件尚未清理。当前健身数据没有改变；可凭清理收据跨刷新重试。`,
      "PREPARE_CLEANUP_INCOMPLETE",
      cause,
    );
    this.name = "FitnessPrepareCleanupIncompleteError";
  }
}

type StagedFile = Readonly<{
  original: FitnessBackupFileMetadata;
  staged: LocalFileMetadata;
  mapping: FitnessRestoreFileMapping;
}>;

type FitnessFileRow = Readonly<{
  id: string;
  entity_type: FitnessBackupFileMetadata["entityType"];
  entity_id: string;
  purpose: FitnessBackupFileMetadata["purpose"];
  file_key: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  status: "ready";
  created_at: number;
  updated_at: number;
}>;

export type FitnessBackupRuntime = Readonly<{
  withExclusiveLock<T>(task: () => Promise<T>): Promise<T>;
  query<Row extends object>(
    sql: string,
    params?: SqlParams,
  ): Promise<readonly Row[] | Readonly<{
    rows?: readonly Row[];
    results?: readonly Row[];
  }>>;
  exportDatabase(): Promise<DatabaseExportResult | Uint8Array | unknown>;
  stageImport(
    database: Uint8Array,
    statements: readonly SqlStatement[],
    recovery?: Readonly<{
      projectionSha256: string;
      prepareOperation: DatabasePrepareOperationReceipt<"shilian">;
    }>,
  ): Promise<StagedDatabaseImportResult>;
  recoverPrepare(
    receipt: DatabasePrepareOperationReceipt<"shilian">,
  ): Promise<DatabasePrepareRecoveryResult>;
  registerPrepareCleanup(
    receipt: DatabasePrepareOperationReceipt<"shilian">,
  ): Promise<DatabasePrepareRecoveryResult>;
  completePrepareCleanup(
    receipt: DatabasePrepareOperationReceipt<"shilian">,
  ): Promise<DatabasePrepareRecoveryResult>;
  activateStaged(
    staged: StagedDatabaseImportResult,
    recovery: DatabaseRecoveryReceipt<"shilian">,
  ): Promise<ActivatedDatabaseGeneration | unknown>;
  inspectStaged(
    staged: StagedDatabaseImportResult,
    recovery: DatabaseRecoveryReceipt<"shilian">,
  ): Promise<CurrentDatabaseGeneration | unknown>;
  currentGeneration(): Promise<CurrentDatabaseGeneration>;
  discardStaged(
    staged: StagedDatabaseImportResult,
    recovery: DatabaseRecoveryReceipt<"shilian">,
  ): Promise<unknown>;
  getFile(key: string): Promise<Readonly<{ metadata: LocalFileMetadata; file: File }>>;
  assertFileKeyAvailable(key: string): Promise<void>;
  saveFileAtKey(
    key: string,
    blob: Blob,
    options: SaveLocalFileOptions,
    stagingOwner: string,
  ): Promise<LocalFileMetadata>;
  deleteOwnedFile(key: string, stagingOwner: string): Promise<unknown>;
  hashBlob(blob: Blob): Promise<string>;
  broadcastGenerationChanged(generationId: string): void;
  now(): Date;
}>;

function defaultExclusiveLock<T>(task: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    return Promise.reject(
      new Error("当前浏览器不支持安全的跨标签页备份锁，请使用最新版 Chrome、Edge 或 Safari"),
    );
  }
  return withFitnessWriteLock(task);
}

function broadcastGenerationChanged(generationId: string): void {
  broadcastFitnessChange(`generation:${generationId}`);
}

const defaultRuntime: FitnessBackupRuntime = {
  withExclusiveLock: defaultExclusiveLock,
  query: (sql, params) => localDb.query(DATABASE, sql, params),
  exportDatabase: () => localDb.export(DATABASE),
  stageImport: (database, statements, recovery) => {
    if (!recovery) {
      return localDb.stageImport(DATABASE, database, statements, FITNESS_SCHEMA_REQUIREMENTS);
    }
    return localDb.stageImport(
      DATABASE,
      database,
      statements,
      FITNESS_SCHEMA_REQUIREMENTS,
      { recovery },
    );
  },
  recoverPrepare: (receipt) => localDb.recoverPrepare(DATABASE, receipt),
  registerPrepareCleanup: (receipt) =>
    localDb.registerPrepareCleanup(DATABASE, receipt),
  completePrepareCleanup: (receipt) =>
    localDb.completePrepareCleanup(DATABASE, receipt),
  activateStaged: (staged, recovery) =>
    localDb.activateStaged(
      DATABASE,
      staged.generationId,
      staged.activationToken,
      recovery,
    ),
  inspectStaged: (staged, recovery) =>
    localDb.inspectStaged(
      DATABASE,
      staged.generationId,
      staged.activationToken,
      recovery,
    ),
  currentGeneration: () => localDb.currentGeneration(DATABASE),
  discardStaged: (staged, recovery) =>
    localDb.discardStaged(
      DATABASE,
      staged.generationId,
      staged.activationToken,
      recovery,
    ),
  getFile: (key) => getLocalFile(DATABASE, key),
  assertFileKeyAvailable: (key) => assertLocalFileKeyAvailable(DATABASE, key),
  saveFileAtKey: (key, blob, options, stagingOwner) =>
    saveLocalFileAtKey(DATABASE, key, blob, options, stagingOwner),
  deleteOwnedFile: (key, stagingOwner) =>
    deleteOwnedLocalFile(DATABASE, key, stagingOwner),
  hashBlob: sha256Blob,
  broadcastGenerationChanged,
  now: () => new Date(),
};

function rowsOf<Row extends object>(result: unknown): readonly Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === "object") {
    const value = result as { rows?: readonly Row[]; results?: readonly Row[] };
    return value.rows ?? value.results ?? [];
  }
  return [];
}

function databaseBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (value && typeof value === "object" && "data" in value) {
    const data = (value as { data?: unknown }).data;
    if (data instanceof Uint8Array) return data.slice();
  }
  throw new Error("本地数据库没有返回可导出的 SQLite 字节");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size &&
    actual.every((key) => expected.has(key));
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return value.length === 24 &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString() === value;
}

function safeFileName(blob: Blob): string | null {
  const value = (blob as Blob & { name?: unknown }).name;
  if (typeof value !== "string") return null;
  const sanitized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  }).join("").replace(/\s+/g, " ").trim().slice(0, 255);
  return sanitized || null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FitnessRestoreAbortedError();
}

function sqliteIdentity(database: Uint8Array): Readonly<{
  applicationId: number;
  userVersion: number;
}> {
  if (database.byteLength < SQLITE_IDENTITY_BYTE_SIZE) {
    throw new FitnessRestoreError(
      "这不是可识别的适练数据库，当前健身数据没有改变。",
      "UNRECOGNIZED_SQLITE",
    );
  }
  for (let index = 0; index < sqliteHeaderBytes.byteLength; index += 1) {
    if (database[index] !== sqliteHeaderBytes[index]) {
      throw new FitnessRestoreError(
        "这不是可识别的适练数据库，当前健身数据没有改变。",
        "UNRECOGNIZED_SQLITE",
      );
    }
  }
  const view = new DataView(
    database.buffer,
    database.byteOffset,
    database.byteLength,
  );
  return {
    applicationId: view.getUint32(68, false),
    userVersion: view.getUint32(60, false),
  };
}

function assertSupportedSourceIdentity(
  applicationId: number,
  userVersion: number,
): void {
  const applicationIds = FITNESS_SCHEMA_REQUIREMENTS.sourceApplicationIds ?? [
    FITNESS_SCHEMA_REQUIREMENTS.applicationId,
  ];
  const minimum = FITNESS_SCHEMA_REQUIREMENTS.sourceMinimumUserVersion ??
    FITNESS_SCHEMA_REQUIREMENTS.minimumUserVersion;
  const maximum = FITNESS_SCHEMA_REQUIREMENTS.sourceMaximumUserVersion ??
    FITNESS_SCHEMA_REQUIREMENTS.maximumUserVersion;
  if (
    !Number.isSafeInteger(applicationId) ||
    !applicationIds.some((value) => value === applicationId) ||
    !Number.isSafeInteger(userVersion) ||
    userVersion < minimum ||
    userVersion > maximum
  ) {
    throw new FitnessRestoreError(
      "这份数据库不是当前支持的适练 v1-v2 版本，当前健身数据没有改变。",
      "UNSUPPORTED_SOURCE",
    );
  }
}

type PreparedRestoreSource =
  | Readonly<{
      kind: "complete-backup";
      parsed: ParsedFitnessBackup;
      database: Uint8Array;
      fileName: string | null;
      byteSize: number;
      sourceUserVersion: number;
      exportedAt: string;
      databaseSha256: string;
      filesSha256: string;
    }>
  | Readonly<{
      kind: "legacy-fitness-sqlite";
      database: Uint8Array;
      fileName: string | null;
      byteSize: number;
      sourceUserVersion: number;
      exportedAt: null;
      databaseSha256: string;
      filesSha256: string;
    }>;

function portableMetadata(
  row: FitnessFileRow,
  index: number,
): FitnessBackupFileMetadata {
  if (
    !row ||
    typeof row !== "object" ||
    !isString(row.id) ||
    (
      row.entity_type !== "venue" &&
      row.entity_type !== "equipment" &&
      row.entity_type !== "exercise" &&
      row.entity_type !== "session"
    ) ||
    !isString(row.entity_id) ||
    (
      row.purpose !== "photo" &&
      row.purpose !== "instruction" &&
      row.purpose !== "other"
    ) ||
    !isString(row.file_key) ||
    !UUID_V4_PATTERN.test(row.file_key) ||
    !isString(row.file_name) ||
    !isString(row.mime_type) ||
    typeof row.byte_size !== "number" ||
    !Number.isSafeInteger(row.byte_size) ||
    row.byte_size < 0 ||
    !isString(row.sha256) ||
    !SHA256_PATTERN.test(row.sha256) ||
    row.status !== "ready" ||
    typeof row.created_at !== "number" ||
    !Number.isSafeInteger(row.created_at) ||
    row.created_at < 0 ||
    typeof row.updated_at !== "number" ||
    !Number.isSafeInteger(row.updated_at) ||
    row.updated_at < row.created_at
  ) {
    throw new Error(`数据库中的第 ${index + 1} 条文件索引无法验证，已停止导出`);
  }
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    purpose: row.purpose,
    key: row.file_key,
    originalName: row.file_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    status: "ready",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function referencedReadyFiles(
  runtime: FitnessBackupRuntime,
): Promise<FitnessBackupFileMetadata[]> {
  const result = await runtime.query<FitnessFileRow>(
    `SELECT
      id,entity_type,entity_id,purpose,file_key,file_name,mime_type,byte_size,
      sha256,status,created_at,updated_at
    FROM fitness_files
    WHERE status='ready'
    ORDER BY file_key,id`,
  );
  const ids = new Set<string>();
  const keys = new Set<string>();
  return rowsOf<FitnessFileRow>(result).map((row, index) => {
    const metadata = portableMetadata(row, index);
    if (ids.has(metadata.id) || keys.has(metadata.key)) {
      throw new Error("数据库包含重复的文件索引，已停止导出");
    }
    ids.add(metadata.id);
    keys.add(metadata.key);
    return metadata;
  });
}

async function assertStoredFile(
  expected: FitnessBackupFileMetadata,
  stored: Readonly<{ metadata: LocalFileMetadata; file: File }>,
  runtime: FitnessBackupRuntime,
): Promise<void> {
  if (
    !stored ||
    typeof stored !== "object" ||
    !(stored.file instanceof Blob) ||
    stored.metadata.version !== 1 ||
    stored.metadata.namespace !== DATABASE ||
    stored.metadata.key !== expected.key ||
    stored.metadata.originalName !== expected.originalName ||
    stored.metadata.mimeType !== expected.mimeType ||
    stored.metadata.byteSize !== expected.byteSize ||
    stored.metadata.sha256 !== expected.sha256 ||
    stored.file.size !== expected.byteSize ||
    stored.file.type !== expected.mimeType ||
    ("name" in stored.file && stored.file.name !== expected.originalName)
  ) {
    throw new Error(`文件「${expected.originalName}」的数据库索引与本地原件不一致，已停止导出`);
  }
  if (await runtime.hashBlob(stored.file) !== expected.sha256) {
    throw new Error(`文件「${expected.originalName}」的真实内容校验失败，已停止导出`);
  }
}

function newStagedFileKeys(count: number): readonly string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const key = crypto.randomUUID().toLowerCase();
    if (!UUID_V4_PATTERN.test(key) || seen.has(key)) {
      throw new FitnessRestoreError(
        "浏览器无法为暂存附件建立唯一凭据。当前健身数据没有改变。",
        "PREPARE_FAILED",
      );
    }
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

async function assertFileKeysAvailable(
  keys: readonly string[],
  runtime: FitnessBackupRuntime,
): Promise<void> {
  await Promise.all(keys.map((key) => runtime.assertFileKeyAvailable(key)));
}

function assertStagedFile(
  original: FitnessBackupFileMetadata,
  staged: LocalFileMetadata,
  expectedKey: string,
  stagingOwner: string,
): void {
  const createdAt = isoTimestamp(original.createdAt, "文件创建");
  const updatedAt = isoTimestamp(original.updatedAt, "文件更新");
  if (
    staged.version !== 1 ||
    staged.namespace !== DATABASE ||
    staged.key !== expectedKey ||
    !UUID_V4_PATTERN.test(staged.key) ||
    staged.originalName !== original.originalName ||
    staged.mimeType !== original.mimeType ||
    staged.category !== localFileCategory(original) ||
    staged.byteSize !== original.byteSize ||
    staged.sha256 !== original.sha256 ||
    staged.createdAt !== createdAt ||
    staged.updatedAt !== updatedAt ||
    staged.stagingOwner !== stagingOwner
  ) {
    throw new FitnessRestoreError(
      `暂存附件「${original.originalName}」时校验失败，当前健身数据没有改变。`,
      "PREPARE_FAILED",
    );
  }
}

function localFileCategory(metadata: FitnessBackupFileMetadata): string {
  return `fitness-file:${metadata.id}`;
}

function isoTimestamp(value: number, label: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new FitnessRestoreError(
      `${label}时间戳无法安全恢复，当前健身数据没有改变。`,
      "PREPARE_FAILED",
    );
  }
  return date.toISOString();
}

async function stageFile(
  parsed: ParsedFitnessBackup,
  keys: readonly string[],
  stagingOwner: string,
  staged: StagedFile[],
  runtime: FitnessBackupRuntime,
  signal?: AbortSignal,
): Promise<void> {
  if (parsed.files.length !== keys.length) {
    throw new FitnessRestoreError(
      "暂存附件数量与恢复凭据不一致。当前健身数据没有改变。",
      "PREPARE_FAILED",
    );
  }
  for (let index = 0; index < parsed.files.length; index += 1) {
    const file = parsed.files[index];
    throwIfAborted(signal);
    const metadata = await runtime.saveFileAtKey(
      keys[index],
      file.blob,
      {
        originalName: file.metadata.originalName,
        mimeType: file.metadata.mimeType,
        category: localFileCategory(file.metadata),
        createdAt: isoTimestamp(file.metadata.createdAt, "文件创建"),
        updatedAt: isoTimestamp(file.metadata.updatedAt, "文件更新"),
      },
      stagingOwner,
    );
    assertStagedFile(file.metadata, metadata, keys[index], stagingOwner);
    staged.push({
      original: file.metadata,
      staged: metadata,
      mapping: {
        original: file.metadata,
        staged: { ...file.metadata, key: metadata.key },
      },
    });
    throwIfAborted(signal);
  }
}

async function deleteFileKeys(
  keys: readonly string[],
  stagingOwner: string,
  runtime: FitnessBackupRuntime,
): Promise<string[]> {
  const results = await Promise.allSettled(
    keys.map((key) => runtime.deleteOwnedFile(key, stagingOwner)),
  );
  return results.flatMap((result, index) =>
    result.status === "rejected" ? [keys[index]] : []);
}

function summaryFor(source: PreparedRestoreSource): FitnessRestoreSummary {
  return {
    kind: source.kind,
    fileName: source.fileName,
    byteSize: source.byteSize,
    databaseByteSize: source.database.byteLength,
    exportedAt: source.exportedAt,
    sourceUserVersion: source.sourceUserVersion,
    canonicalUserVersion: FITNESS_USER_VERSION,
    fileCount: source.kind === "complete-backup"
      ? source.parsed.files.length
      : 0,
    venueCount: null,
    equipmentCount: null,
    exerciseCount: null,
    sessionCount: null,
    verification: source.kind === "complete-backup"
      ? "container-and-payload-verified"
      : "fitness-schema-verified",
  };
}

type FitnessRestoreProjection = Readonly<{
  version: 1;
  database: "shilian";
  databaseSha256: string;
  filesSha256: string;
  preparedAt: string;
  summary: FitnessRestoreSummary;
  stagedFileKeys: readonly string[];
}>;

function restoreProjection(
  databaseSha256: string,
  filesSha256: string,
  preparedAt: string,
  summary: FitnessRestoreSummary,
  stagedFileKeys: readonly string[],
): FitnessRestoreProjection {
  return {
    version: 1,
    database: CANONICAL_DATABASE,
    databaseSha256,
    filesSha256,
    preparedAt,
    summary,
    stagedFileKeys: [...stagedFileKeys],
  };
}

async function projectionSha256(
  projection: FitnessRestoreProjection,
  runtime: FitnessBackupRuntime,
): Promise<string> {
  return runtime.hashBlob(new Blob([
    JSON.stringify({
      version: projection.version,
      database: projection.database,
      databaseSha256: projection.databaseSha256,
      filesSha256: projection.filesSha256,
      preparedAt: projection.preparedAt,
      summary: {
        kind: projection.summary.kind,
        fileName: projection.summary.fileName,
        byteSize: projection.summary.byteSize,
        databaseByteSize: projection.summary.databaseByteSize,
        exportedAt: projection.summary.exportedAt,
        sourceUserVersion: projection.summary.sourceUserVersion,
        canonicalUserVersion: projection.summary.canonicalUserVersion,
        fileCount: projection.summary.fileCount,
        venueCount: projection.summary.venueCount,
        equipmentCount: projection.summary.equipmentCount,
        exerciseCount: projection.summary.exerciseCount,
        sessionCount: projection.summary.sessionCount,
        verification: projection.summary.verification,
      },
      stagedFileKeys: projection.stagedFileKeys,
    }),
  ], { type: "application/json" }));
}

async function fileKeysSha256(
  keys: readonly string[],
  runtime: FitnessBackupRuntime,
): Promise<string> {
  return runtime.hashBlob(new Blob([
    JSON.stringify({ version: 1, stagedFileKeys: keys }),
  ], { type: "application/json" }));
}

function newPrepareCapability(): Readonly<{
  operationId: string;
  operationToken: string;
}> {
  const operationId = crypto.randomUUID().toLowerCase();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const operationToken = Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (!UUID_V4_PATTERN.test(operationId) || !SHA256_PATTERN.test(operationToken)) {
    throw new FitnessRestoreError(
      "浏览器无法建立安全的恢复操作凭据。当前健身数据没有改变。",
      "PREPARE_FAILED",
    );
  }
  return { operationId, operationToken };
}

function databasePrepareReceiptFor(
  receipt: FitnessPrepareRecoveryReceipt | FitnessPrepareCleanupReceipt,
): DatabasePrepareOperationReceipt<"shilian"> {
  return {
    version: 1,
    database: CANONICAL_DATABASE,
    operationId: receipt.operationId,
    generationId: receipt.generationId,
    operationToken: receipt.operationToken,
    projectionSha256: receipt.projectionSha256,
    attachmentKeysSha256: receipt.fileKeysSha256,
    stagedAttachmentKeys: [...receipt.stagedFileKeys],
  };
}

function prepareRecoveryReceiptFor(
  projection: FitnessRestoreProjection,
  projectionDigest: string,
  fileKeysDigest: string,
  capability: Readonly<{ operationId: string; operationToken: string }>,
): FitnessPrepareRecoveryReceipt {
  return {
    version: 1,
    database: CANONICAL_DATABASE,
    operationId: capability.operationId,
    generationId: capability.operationId,
    operationToken: capability.operationToken,
    databaseSha256: projection.databaseSha256,
    filesSha256: projection.filesSha256,
    projectionSha256: projectionDigest,
    fileKeysSha256: fileKeysDigest,
    preparedAt: projection.preparedAt,
    summary: projection.summary,
    stagedFileKeys: [...projection.stagedFileKeys],
  };
}

function recoveryCheckpointFor(
  receipt: FitnessPrepareRecoveryReceipt,
): FitnessPrepareRecoveryReceipt {
  return Object.freeze({
    ...receipt,
    summary: Object.freeze({ ...receipt.summary }),
    stagedFileKeys: Object.freeze([...receipt.stagedFileKeys]),
  });
}

function parseRestoreSummary(value: unknown): FitnessRestoreSummary {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "kind", "fileName", "byteSize", "databaseByteSize", "exportedAt",
      "sourceUserVersion", "canonicalUserVersion", "fileCount",
      "venueCount", "equipmentCount", "exerciseCount", "sessionCount",
      "verification",
    ]) ||
    (value.kind !== "complete-backup" && value.kind !== "legacy-fitness-sqlite") ||
    !(value.fileName === null || (
      typeof value.fileName === "string" &&
      value.fileName.length > 0 &&
      value.fileName.length <= 255 &&
      !Array.from(value.fileName).some((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point <= 31 || point === 127;
      })
    )) ||
    typeof value.byteSize !== "number" ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < SQLITE_IDENTITY_BYTE_SIZE ||
    value.byteSize > FITNESS_BACKUP_LIMITS.totalBytes ||
    typeof value.databaseByteSize !== "number" ||
    !Number.isSafeInteger(value.databaseByteSize) ||
    value.databaseByteSize < SQLITE_IDENTITY_BYTE_SIZE ||
    value.databaseByteSize > FITNESS_BACKUP_LIMITS.databaseBytes ||
    value.databaseByteSize > value.byteSize ||
    !(value.exportedAt === null || (
      typeof value.exportedAt === "string" &&
      isCanonicalIsoTimestamp(value.exportedAt)
    )) ||
    typeof value.sourceUserVersion !== "number" ||
    !Number.isSafeInteger(value.sourceUserVersion) ||
    value.sourceUserVersion < 1 ||
    value.sourceUserVersion > FITNESS_USER_VERSION ||
    value.canonicalUserVersion !== FITNESS_USER_VERSION ||
    typeof value.fileCount !== "number" ||
    !Number.isSafeInteger(value.fileCount) ||
    value.fileCount < 0 ||
    value.fileCount > FITNESS_BACKUP_LIMITS.fileCount ||
    value.venueCount !== null ||
    value.equipmentCount !== null ||
    value.exerciseCount !== null ||
    value.sessionCount !== null ||
    (value.verification !== "container-and-payload-verified" &&
      value.verification !== "fitness-schema-verified") ||
    (value.kind === "complete-backup" && (
      value.exportedAt === null ||
      value.verification !== "container-and-payload-verified"
    )) ||
    (value.kind === "legacy-fitness-sqlite" && (
      value.exportedAt !== null ||
      value.fileCount !== 0 ||
      value.byteSize !== value.databaseByteSize ||
      value.verification !== "fitness-schema-verified"
    ))
  ) {
    throw new FitnessRestoreError(
      "恢复核对信息无效。为保护当前健身数据，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  return {
    kind: value.kind,
    fileName: value.fileName,
    byteSize: value.byteSize,
    databaseByteSize: value.databaseByteSize,
    exportedAt: value.exportedAt,
    sourceUserVersion: value.sourceUserVersion,
    canonicalUserVersion: FITNESS_USER_VERSION,
    fileCount: value.fileCount,
    venueCount: null,
    equipmentCount: null,
    exerciseCount: null,
    sessionCount: null,
    verification: value.verification,
  };
}

function parsePrepareReceiptCore(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<{
  operationId: string;
  generationId: string;
  operationToken: string;
  projectionSha256: string;
  fileKeysSha256: string;
  stagedFileKeys: readonly string[];
}> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, expectedKeys) ||
    value.version !== 1 ||
    value.database !== CANONICAL_DATABASE ||
    typeof value.operationId !== "string" ||
    !UUID_V4_PATTERN.test(value.operationId) ||
    value.generationId !== value.operationId ||
    typeof value.operationToken !== "string" ||
    !SHA256_PATTERN.test(value.operationToken) ||
    typeof value.projectionSha256 !== "string" ||
    !SHA256_PATTERN.test(value.projectionSha256) ||
    typeof value.fileKeysSha256 !== "string" ||
    !SHA256_PATTERN.test(value.fileKeysSha256) ||
    !Array.isArray(value.stagedFileKeys) ||
    value.stagedFileKeys.length > FITNESS_BACKUP_LIMITS.fileCount ||
    value.stagedFileKeys.some((key) =>
      typeof key !== "string" || !UUID_V4_PATTERN.test(key)) ||
    new Set(value.stagedFileKeys).size !== value.stagedFileKeys.length
  ) {
    throw new FitnessRestoreError(
      "恢复准备凭据无效。为保护当前健身数据，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  return {
    operationId: value.operationId,
    generationId: value.operationId,
    operationToken: value.operationToken,
    projectionSha256: value.projectionSha256,
    fileKeysSha256: value.fileKeysSha256,
    stagedFileKeys: [...value.stagedFileKeys] as string[],
  };
}

async function verifyPrepareRecoveryReceipt(
  value: unknown,
  runtime: FitnessBackupRuntime,
): Promise<FitnessPrepareRecoveryReceipt> {
  const core = parsePrepareReceiptCore(value, [
    "version", "database", "operationId", "generationId", "operationToken",
    "databaseSha256", "filesSha256", "projectionSha256", "fileKeysSha256",
    "preparedAt", "summary", "stagedFileKeys",
  ]);
  if (
    !isRecord(value) ||
    typeof value.databaseSha256 !== "string" ||
    !SHA256_PATTERN.test(value.databaseSha256) ||
    typeof value.filesSha256 !== "string" ||
    !SHA256_PATTERN.test(value.filesSha256) ||
    typeof value.preparedAt !== "string" ||
    !isCanonicalIsoTimestamp(value.preparedAt)
  ) {
    throw new FitnessRestoreError(
      "恢复准备凭据无效。为保护当前健身数据，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  const summary = parseRestoreSummary(value.summary);
  if (summary.fileCount !== core.stagedFileKeys.length) {
    throw new FitnessRestoreError(
      "恢复准备凭据彼此不一致。为保护当前健身数据，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  const receipt: FitnessPrepareRecoveryReceipt = {
    version: 1,
    database: CANONICAL_DATABASE,
    ...core,
    databaseSha256: value.databaseSha256,
    filesSha256: value.filesSha256,
    preparedAt: value.preparedAt,
    summary,
  };
  const digest = await projectionSha256(restoreProjection(
    receipt.databaseSha256,
    receipt.filesSha256,
    receipt.preparedAt,
    receipt.summary,
    receipt.stagedFileKeys,
  ), runtime);
  if (digest !== receipt.projectionSha256) {
    throw new FitnessRestoreError(
      "恢复准备凭据与暂存内容不一致。为保护当前健身数据，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  if (
    await fileKeysSha256(receipt.stagedFileKeys, runtime) !==
      receipt.fileKeysSha256
  ) {
    throw new FitnessRestoreError(
      "恢复准备凭据的附件范围不一致。为保护当前健身数据，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  return receipt;
}

async function verifyPrepareCleanupReceipt(
  value: unknown,
  runtime: FitnessBackupRuntime,
): Promise<FitnessPrepareCleanupReceipt> {
  const core = parsePrepareReceiptCore(value, [
    "version", "database", "operationId", "generationId", "operationToken",
    "projectionSha256", "fileKeysSha256", "stagedFileKeys",
  ]);
  const receipt: FitnessPrepareCleanupReceipt = {
    version: 1,
    database: CANONICAL_DATABASE,
    ...core,
  };
  if (
    await fileKeysSha256(receipt.stagedFileKeys, runtime) !==
      receipt.fileKeysSha256
  ) {
    throw new FitnessRestoreError(
      "暂存清理凭据与附件范围不一致。没有删除任何附件。",
      "INVALID_RECEIPT",
    );
  }
  return receipt;
}

function parseStagedRecoveryReceipt(
  value: unknown,
  generationId: string,
  expectedProjectionSha256: string,
): DatabaseRecoveryReceipt<"shilian"> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version", "database", "generationId", "recoveryToken",
      "expectedCurrentGenerationId", "expectedCurrentSequence",
      "canonicalApplicationId", "canonicalUserVersion", "projectionSha256",
    ]) ||
    value.version !== 1 ||
    value.database !== CANONICAL_DATABASE ||
    value.generationId !== generationId ||
    typeof value.recoveryToken !== "string" ||
    !SHA256_PATTERN.test(value.recoveryToken) ||
    typeof value.expectedCurrentGenerationId !== "string" ||
    !(value.expectedCurrentGenerationId === "legacy" ||
      UUID_V4_PATTERN.test(value.expectedCurrentGenerationId)) ||
    typeof value.expectedCurrentSequence !== "number" ||
    !Number.isSafeInteger(value.expectedCurrentSequence) ||
    value.expectedCurrentSequence < 0 ||
    value.canonicalApplicationId !== FITNESS_SCHEMA_REQUIREMENTS.applicationId ||
    value.canonicalUserVersion !== FITNESS_USER_VERSION ||
    value.projectionSha256 !== expectedProjectionSha256
  ) {
    throw new FitnessRestoreError(
      "候选数据库返回了无效的恢复凭据，当前健身数据没有改变。",
      "PREPARE_FAILED",
    );
  }
  return {
    version: 1,
    database: CANONICAL_DATABASE,
    generationId,
    recoveryToken: value.recoveryToken,
    expectedCurrentGenerationId: value.expectedCurrentGenerationId,
    expectedCurrentSequence: value.expectedCurrentSequence,
    canonicalApplicationId: value.canonicalApplicationId,
    canonicalUserVersion: value.canonicalUserVersion,
    projectionSha256: value.projectionSha256,
  };
}

function receiptFor(
  staged: StagedDatabaseImportResult,
  recovery: DatabaseRecoveryReceipt<"shilian">,
  projection: FitnessRestoreProjection,
  projectionDigest: string,
): FitnessRestoreReceipt {
  return {
    version: 1,
    database: CANONICAL_DATABASE,
    generationId: staged.generationId,
    activationToken: staged.activationToken,
    recoveryToken: recovery.recoveryToken,
    expectedCurrentGenerationId: recovery.expectedCurrentGenerationId,
    expectedCurrentSequence: recovery.expectedCurrentSequence,
    canonicalApplicationId: recovery.canonicalApplicationId,
    canonicalUserVersion: recovery.canonicalUserVersion,
    databaseSha256: projection.databaseSha256,
    filesSha256: projection.filesSha256,
    projectionSha256: projectionDigest,
    preparedAt: projection.preparedAt,
    summary: projection.summary,
    stagedFileKeys: [...projection.stagedFileKeys],
  };
}

function parseRestoreReceipt(value: unknown): FitnessRestoreReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version", "database", "generationId", "activationToken",
      "recoveryToken", "expectedCurrentGenerationId",
      "expectedCurrentSequence", "canonicalApplicationId",
      "canonicalUserVersion", "databaseSha256", "filesSha256",
      "projectionSha256", "preparedAt", "summary", "stagedFileKeys",
    ]) ||
    value.version !== 1 ||
    value.database !== CANONICAL_DATABASE ||
    typeof value.generationId !== "string" ||
    !UUID_V4_PATTERN.test(value.generationId) ||
    typeof value.activationToken !== "string" ||
    !SHA256_PATTERN.test(value.activationToken) ||
    typeof value.recoveryToken !== "string" ||
    !SHA256_PATTERN.test(value.recoveryToken) ||
    typeof value.expectedCurrentGenerationId !== "string" ||
    !(value.expectedCurrentGenerationId === "legacy" ||
      UUID_V4_PATTERN.test(value.expectedCurrentGenerationId)) ||
    typeof value.expectedCurrentSequence !== "number" ||
    !Number.isSafeInteger(value.expectedCurrentSequence) ||
    value.expectedCurrentSequence < 0 ||
    value.canonicalApplicationId !== FITNESS_SCHEMA_REQUIREMENTS.applicationId ||
    value.canonicalUserVersion !== FITNESS_USER_VERSION ||
    typeof value.databaseSha256 !== "string" ||
    !SHA256_PATTERN.test(value.databaseSha256) ||
    typeof value.filesSha256 !== "string" ||
    !SHA256_PATTERN.test(value.filesSha256) ||
    typeof value.projectionSha256 !== "string" ||
    !SHA256_PATTERN.test(value.projectionSha256) ||
    typeof value.preparedAt !== "string" ||
    !isCanonicalIsoTimestamp(value.preparedAt) ||
    !Array.isArray(value.stagedFileKeys) ||
    value.stagedFileKeys.length > FITNESS_BACKUP_LIMITS.fileCount ||
    value.stagedFileKeys.some((key) =>
      typeof key !== "string" || !UUID_V4_PATTERN.test(key)) ||
    new Set(value.stagedFileKeys).size !== value.stagedFileKeys.length
  ) {
    throw new FitnessRestoreError(
      "恢复核对信息无效。为保护当前健身数据，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  const summary = parseRestoreSummary(value.summary);
  if (
    summary.fileCount !== value.stagedFileKeys.length ||
    summary.canonicalUserVersion !== value.canonicalUserVersion
  ) {
    throw new FitnessRestoreError(
      "恢复核对信息彼此不一致。为保护当前健身数据，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  return {
    version: 1,
    database: CANONICAL_DATABASE,
    generationId: value.generationId,
    activationToken: value.activationToken,
    recoveryToken: value.recoveryToken,
    expectedCurrentGenerationId: value.expectedCurrentGenerationId,
    expectedCurrentSequence: value.expectedCurrentSequence,
    canonicalApplicationId: value.canonicalApplicationId,
    canonicalUserVersion: value.canonicalUserVersion,
    databaseSha256: value.databaseSha256,
    filesSha256: value.filesSha256,
    projectionSha256: value.projectionSha256,
    preparedAt: value.preparedAt,
    summary,
    stagedFileKeys: [...value.stagedFileKeys] as string[],
  };
}

async function verifyRestoreReceipt(
  value: unknown,
  runtime: FitnessBackupRuntime,
): Promise<FitnessRestoreReceipt> {
  const receipt = parseRestoreReceipt(value);
  const digest = await projectionSha256(restoreProjection(
    receipt.databaseSha256,
    receipt.filesSha256,
    receipt.preparedAt,
    receipt.summary,
    receipt.stagedFileKeys,
  ), runtime);
  if (digest !== receipt.projectionSha256) {
    throw new FitnessRestoreError(
      "恢复核对信息与候选版本不一致。为保护当前健身数据，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  return receipt;
}

function databaseRecoveryReceiptFor(
  receipt: FitnessRestoreReceipt,
): DatabaseRecoveryReceipt<"shilian"> {
  return {
    version: 1,
    database: CANONICAL_DATABASE,
    generationId: receipt.generationId,
    recoveryToken: receipt.recoveryToken,
    expectedCurrentGenerationId: receipt.expectedCurrentGenerationId,
    expectedCurrentSequence: receipt.expectedCurrentSequence,
    canonicalApplicationId: receipt.canonicalApplicationId,
    canonicalUserVersion: receipt.canonicalUserVersion,
    projectionSha256: receipt.projectionSha256,
  };
}

function stagedResultFor(receipt: FitnessRestoreReceipt): StagedDatabaseImportResult<"shilian"> {
  return {
    database: CANONICAL_DATABASE,
    generationId: receipt.generationId,
    filename: `${CANONICAL_DATABASE}.${receipt.generationId}.sqlite3`,
    activationToken: receipt.activationToken,
    importedBytes: receipt.summary.databaseByteSize,
    schemaVersion: receipt.canonicalUserVersion,
    recoveryReceipt: databaseRecoveryReceiptFor(receipt),
  };
}

function parseCurrentGeneration(
  value: unknown,
): CurrentDatabaseGeneration<"shilian"> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "database", "generationId", "filename", "sequence", "legacy",
    ]) ||
    value.database !== CANONICAL_DATABASE ||
    typeof value.generationId !== "string" ||
    !(value.generationId === "legacy" || UUID_V4_PATTERN.test(value.generationId)) ||
    typeof value.filename !== "string" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    typeof value.legacy !== "boolean" ||
    (value.generationId === "legacy"
      ? value.filename !== `${CANONICAL_DATABASE}.sqlite3` ||
        value.legacy !== true
      : value.filename !== `${CANONICAL_DATABASE}.${value.generationId}.sqlite3` ||
        value.legacy !== false)
  ) {
    throw new Error("Invalid current Fitness database generation response.");
  }
  return {
    database: CANONICAL_DATABASE,
    generationId: value.generationId,
    filename: value.filename as `${string}.sqlite3`,
    sequence: value.sequence,
    legacy: value.legacy,
  };
}

function parseActivatedGeneration(
  value: unknown,
  receipt: FitnessRestoreReceipt,
): ActivatedDatabaseGeneration<"shilian"> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "database", "filename", "persistent", "sqliteVersion",
      "schemaVersion", "seeded", "generationId", "sequence",
    ]) ||
    value.database !== CANONICAL_DATABASE ||
    value.filename !== `${CANONICAL_DATABASE}.${receipt.generationId}.sqlite3` ||
    value.persistent !== true ||
    typeof value.sqliteVersion !== "string" ||
    value.sqliteVersion.length === 0 ||
    value.schemaVersion !== receipt.canonicalUserVersion ||
    value.seeded !== false ||
    value.generationId !== receipt.generationId ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1
  ) {
    throw new Error("Invalid staged Fitness activation response.");
  }
  return {
    database: CANONICAL_DATABASE,
    filename: value.filename as `shilian.${string}.sqlite3`,
    persistent: true,
    sqliteVersion: value.sqliteVersion,
    schemaVersion: value.schemaVersion,
    seeded: false,
    generationId: receipt.generationId,
    sequence: value.sequence,
  };
}

function recoveryCredentialErrorCode(error: unknown): string | null {
  if (!isRecord(error) || typeof error.code !== "string") return null;
  return [
    "RECOVERY_BINDING_REQUIRED",
    "RECOVERY_BINDING_MISMATCH",
    "INVALID_ACTIVATION_TOKEN",
    "INVALID_GENERATION_ID",
  ].includes(error.code) ? error.code : null;
}

function isCurrentTarget(
  current: CurrentDatabaseGeneration,
  receipt: FitnessRestoreReceipt,
): boolean {
  return current.database === CANONICAL_DATABASE &&
    current.generationId === receipt.generationId;
}

function isExpectedCurrent(
  current: CurrentDatabaseGeneration,
  receipt: FitnessRestoreReceipt,
): boolean {
  return current.database === CANONICAL_DATABASE &&
    current.generationId === receipt.expectedCurrentGenerationId &&
    current.sequence === receipt.expectedCurrentSequence;
}

async function currentGenerationFor(
  runtime: FitnessBackupRuntime,
  message: string,
): Promise<CurrentDatabaseGeneration<"shilian">> {
  try {
    return parseCurrentGeneration(await runtime.currentGeneration());
  } catch (error) {
    throw new FitnessRestoreError(
      message,
      "CURRENT_GENERATION_UNAVAILABLE",
      error,
    );
  }
}

async function inspectBoundCurrentGeneration(
  receipt: FitnessRestoreReceipt,
  runtime: FitnessBackupRuntime,
): Promise<CurrentDatabaseGeneration<"shilian">> {
  try {
    return parseCurrentGeneration(await runtime.inspectStaged(
      stagedResultFor(receipt),
      databaseRecoveryReceiptFor(receipt),
    ));
  } catch (error) {
    if (recoveryCredentialErrorCode(error)) {
      throw new FitnessRestoreError(
        "恢复凭据与已核对的候选版本不一致。没有更改当前健身数据。",
        "INVALID_RECEIPT",
        error,
      );
    }
    throw new FitnessRestoreError(
      "暂时无法核对当前健身数据版本。候选与恢复信息都已保留。",
      "CURRENT_GENERATION_UNAVAILABLE",
      error,
    );
  }
}

function broadcastKnownActivation(
  generationId: string,
  runtime: FitnessBackupRuntime,
): void {
  try {
    runtime.broadcastGenerationChanged(generationId);
  } catch {
    // The durable generation pointer is authoritative. A notification failure
    // must never turn success into a retryable restore.
  }
}

async function discardStagedCandidate(
  receipt: FitnessRestoreReceipt,
  runtime: FitnessBackupRuntime,
): Promise<void> {
  let result: unknown;
  try {
    result = await runtime.discardStaged(
      stagedResultFor(receipt),
      databaseRecoveryReceiptFor(receipt),
    );
  } catch (error) {
    throw new FitnessDiscardUncertainError(receipt, error);
  }
  if (
    !isRecord(result) ||
    result.database !== CANONICAL_DATABASE ||
    result.generationId !== receipt.generationId ||
    result.discarded !== true
  ) {
    throw new FitnessDiscardUncertainError(
      receipt,
      new Error("Staged discard did not return a durable acknowledgement."),
    );
  }
}

async function discardPreparedInContext(
  rawReceipt: FitnessRestoreReceipt,
  runtime: FitnessBackupRuntime,
): Promise<FitnessRestoreDiscard> {
  const receipt = await verifyRestoreReceipt(rawReceipt, runtime);
  await discardStagedCandidate(receipt, runtime);
  const failedFileKeys = await deleteFileKeys(
    receipt.stagedFileKeys,
    receipt.projectionSha256,
    runtime,
  );
  return {
    discarded: true,
    fileCleanup: failedFileKeys.length === 0 ? "complete" : "incomplete",
    failedFileKeys,
  };
}

function cleanupReceiptFromPrepare(
  receipt: FitnessPrepareRecoveryReceipt,
): FitnessPrepareCleanupReceipt {
  return {
    version: 1,
    database: CANONICAL_DATABASE,
    operationId: receipt.operationId,
    generationId: receipt.generationId,
    operationToken: receipt.operationToken,
    projectionSha256: receipt.projectionSha256,
    fileKeysSha256: receipt.fileKeysSha256,
    stagedFileKeys: [...receipt.stagedFileKeys],
  };
}

function assertPrepareCleanupResult(
  value: unknown,
  receipt: FitnessPrepareCleanupReceipt,
): Extract<DatabasePrepareRecoveryResult, {
  status: "cleanup-pending" | "cleanup-complete";
}> {
  if (
    !isRecord(value) ||
    value.database !== CANONICAL_DATABASE ||
    value.operationId !== receipt.operationId ||
    (value.status !== "cleanup-pending" && value.status !== "cleanup-complete") ||
    !Array.isArray(value.stagedAttachmentKeys) ||
    value.stagedAttachmentKeys.length !== receipt.stagedFileKeys.length ||
    value.stagedAttachmentKeys.some(
      (key, index) => key !== receipt.stagedFileKeys[index],
    )
  ) {
    throw new FitnessRestoreError(
      "暂存清理授权无法核对。没有删除任何附件。",
      "INVALID_RECEIPT",
    );
  }
  return value as Extract<DatabasePrepareRecoveryResult, {
    status: "cleanup-pending" | "cleanup-complete";
  }>;
}

async function stageSourceInContext(
  source: PreparedRestoreSource,
  runtime: FitnessBackupRuntime,
  signal?: AbortSignal,
  onRecoveryPrepared?: FitnessBackupRestoreOptions["onRecoveryPrepared"],
): Promise<FitnessRestoreReceipt> {
  throwIfAborted(signal);
  const stagedFile: StagedFile[] = [];
  let preparedReceipt: FitnessRestoreReceipt | null = null;
  let prepareReceipt: FitnessPrepareRecoveryReceipt | null = null;
  let fileStageStarted = false;
  let atomicStageStarted = false;
  try {
    const capability = newPrepareCapability();
    const stagedFileKeys = newStagedFileKeys(
      source.kind === "complete-backup" ? source.parsed.files.length : 0,
    );
    await assertFileKeysAvailable(stagedFileKeys, runtime);
    throwIfAborted(signal);

    const projection = restoreProjection(
      source.databaseSha256,
      source.filesSha256,
      runtime.now().toISOString(),
      summaryFor(source),
      stagedFileKeys,
    );
    const projectionDigest = await projectionSha256(projection, runtime);
    const fileKeysDigest = await fileKeysSha256(stagedFileKeys, runtime);
    if (
      !SHA256_PATTERN.test(projectionDigest) ||
      !SHA256_PATTERN.test(fileKeysDigest)
    ) {
      throw new FitnessRestoreError(
        "浏览器无法建立可核对的恢复摘要。当前健身数据没有改变。",
        "PREPARE_FAILED",
      );
    }
    prepareReceipt = prepareRecoveryReceiptFor(
      projection,
      projectionDigest,
      fileKeysDigest,
      capability,
    );
    throwIfAborted(signal);

    if (onRecoveryPrepared) {
      try {
        await onRecoveryPrepared(recoveryCheckpointFor(prepareReceipt));
      } catch (error) {
        throw new FitnessRestoreError(
          "恢复信息未能安全保存，因此没有开始建立候选。当前健身数据没有改变。",
          "PREPARE_FAILED",
          error,
        );
      }
    }
    throwIfAborted(signal);

    if (source.kind === "complete-backup" && stagedFileKeys.length > 0) {
      fileStageStarted = true;
      await stageFile(
        source.parsed,
        stagedFileKeys,
        projectionDigest,
        stagedFile,
        runtime,
        signal,
      );
    }
    throwIfAborted(signal);
    const statements = source.kind === "complete-backup"
      ? createCompleteFitnessRestoreStatements(
          stagedFile.map(({ mapping }) => mapping),
          source.sourceUserVersion,
        )
      : createLegacyFitnessRestoreStatements(
          source.sourceUserVersion,
        );
    throwIfAborted(signal);

    // After this request starts, a late AbortSignal is deliberately ignored.
    // Returning/recovering one worker operation is safer than restaging bytes.
    atomicStageStarted = true;
    const stagedDatabase = await runtime.stageImport(
      source.database,
      statements,
      {
        projectionSha256: projectionDigest,
        prepareOperation: databasePrepareReceiptFor(prepareReceipt),
      },
    );
    if (
      stagedDatabase.database !== CANONICAL_DATABASE ||
      stagedDatabase.generationId !== prepareReceipt.operationId ||
      !UUID_V4_PATTERN.test(stagedDatabase.generationId) ||
      typeof stagedDatabase.activationToken !== "string" ||
      !SHA256_PATTERN.test(stagedDatabase.activationToken) ||
      stagedDatabase.filename !==
        `${CANONICAL_DATABASE}.${stagedDatabase.generationId}.sqlite3`
    ) {
      throw new FitnessRestoreError(
        "候选数据库返回了无效的核对信息，当前健身数据没有改变。",
        "PREPARE_FAILED",
      );
    }
    const recovery = parseStagedRecoveryReceipt(
      stagedDatabase.recoveryReceipt,
      stagedDatabase.generationId,
      projectionDigest,
    );
    preparedReceipt = receiptFor(
      stagedDatabase,
      recovery,
      projection,
      projectionDigest,
    );
    if (
      stagedDatabase.importedBytes !== source.database.byteLength ||
      !Number.isSafeInteger(stagedDatabase.schemaVersion) ||
      stagedDatabase.schemaVersion !== FITNESS_USER_VERSION
    ) {
      throw new FitnessRestoreError(
        "候选数据库返回了无效的核对信息，当前健身数据没有改变。",
        "PREPARE_FAILED",
      );
    }
    return preparedReceipt;
  } catch (error) {
    if (preparedReceipt) {
      try {
        const discarded = await discardPreparedInContext(preparedReceipt, runtime);
        if (discarded.fileCleanup === "incomplete") {
          throw new FitnessDiscardUncertainError(preparedReceipt, {
            prepareError: error,
            failedFileKeys: discarded.failedFileKeys,
          });
        }
      } catch (discardError) {
        if (discardError instanceof FitnessDiscardUncertainError) throw discardError;
        throw new FitnessDiscardUncertainError(
          preparedReceipt,
          { prepareError: error, discardError },
        );
      }
    }
    if (atomicStageStarted && !preparedReceipt && prepareReceipt) {
      throw new FitnessPrepareUncertainError(prepareReceipt, error);
    }
    const failed = fileStageStarted && prepareReceipt
      ? await deleteFileKeys(
          prepareReceipt.stagedFileKeys,
          prepareReceipt.projectionSha256,
          runtime,
        )
      : [];
    if (failed.length > 0 && prepareReceipt) {
      const cleanupReceipt = cleanupReceiptFromPrepare(prepareReceipt);
      try {
        const bound = await runtime.registerPrepareCleanup(
          databasePrepareReceiptFor(cleanupReceipt),
        );
        assertPrepareCleanupResult(bound, cleanupReceipt);
      } catch (bindingError) {
        throw new FitnessPrepareCleanupIncompleteError(
          cleanupReceipt,
          { prepareError: error, bindingError },
        );
      }
      throw new FitnessPrepareCleanupIncompleteError(cleanupReceipt, error);
    }
    if (error instanceof FitnessRestoreError) throw error;
    throw new FitnessRestoreError(
      "未能建立安全的恢复候选，当前健身数据没有改变。",
      "PREPARE_FAILED",
      error,
    );
  }
}

async function recoverPrepareInContext(
  rawReceipt: FitnessPrepareRecoveryReceipt,
  runtime: FitnessBackupRuntime,
): Promise<FitnessPrepareRecovery> {
  const receipt = await verifyPrepareRecoveryReceipt(rawReceipt, runtime);
  let result: DatabasePrepareRecoveryResult;
  try {
    result = await runtime.recoverPrepare(databasePrepareReceiptFor(receipt));
  } catch (error) {
    if (!isRecord(error) || error.code !== "PREPARE_OPERATION_NOT_FOUND") {
      throw new FitnessRestoreError(
        "暂时无法核对这次恢复准备。操作凭据已保留，请不要重新选择备份。",
        "PREPARE_UNCERTAIN",
        error,
      );
    }
    try {
      result = await runtime.registerPrepareCleanup(
        databasePrepareReceiptFor(receipt),
      );
    } catch (registrationError) {
      throw new FitnessRestoreError(
        "暂时无法确认这次准备是否可以安全清理。操作凭据已保留，没有删除任何附件。",
        "PREPARE_UNCERTAIN",
        registrationError,
      );
    }
  }

  if (result.status === "ready") {
    const staged = result.staged;
    if (
      result.database !== CANONICAL_DATABASE ||
      result.operationId !== receipt.operationId ||
      staged.database !== CANONICAL_DATABASE ||
      staged.generationId !== receipt.generationId ||
      staged.filename !== `${CANONICAL_DATABASE}.${receipt.generationId}.sqlite3` ||
      typeof staged.activationToken !== "string" ||
      !SHA256_PATTERN.test(staged.activationToken) ||
      staged.importedBytes !== receipt.summary.databaseByteSize ||
      staged.schemaVersion !== FITNESS_USER_VERSION
    ) {
      throw new FitnessRestoreError(
        "恢复准备结果与操作凭据不一致。当前健身数据没有改变。",
        "INVALID_RECEIPT",
      );
    }
    const recovery = parseStagedRecoveryReceipt(
      staged.recoveryReceipt,
      staged.generationId,
      receipt.projectionSha256,
    );
    return {
      status: "ready",
      receipt: receiptFor(
        staged,
        recovery,
        restoreProjection(
          receipt.databaseSha256,
          receipt.filesSha256,
          receipt.preparedAt,
          receipt.summary,
          receipt.stagedFileKeys,
        ),
        receipt.projectionSha256,
      ),
    };
  }
  if (result.status === "discarded") {
    if (
      result.database !== CANONICAL_DATABASE ||
      result.operationId !== receipt.operationId
    ) {
      throw new FitnessRestoreError(
        "恢复准备结果与操作凭据不一致。当前健身数据没有改变。",
        "INVALID_RECEIPT",
      );
    }
    return { status: "discarded" };
  }
  const cleanupReceipt = cleanupReceiptFromPrepare(receipt);
  const cleanup = assertPrepareCleanupResult(result, cleanupReceipt);
  return { status: cleanup.status, cleanupReceipt };
}

async function retryPrepareCleanupInContext(
  rawReceipt: FitnessPrepareCleanupReceipt,
  runtime: FitnessBackupRuntime,
): Promise<Readonly<{ cleaned: true }>> {
  const receipt = await verifyPrepareCleanupReceipt(rawReceipt, runtime);
  let rawState: DatabasePrepareRecoveryResult;
  try {
    rawState = await runtime.recoverPrepare(databasePrepareReceiptFor(receipt));
  } catch (error) {
    if (!isRecord(error) || error.code !== "PREPARE_OPERATION_NOT_FOUND") {
      throw new FitnessPrepareCleanupIncompleteError(receipt, error);
    }
    try {
      rawState = await runtime.registerPrepareCleanup(
        databasePrepareReceiptFor(receipt),
      );
    } catch (registrationError) {
      throw new FitnessPrepareCleanupIncompleteError(receipt, registrationError);
    }
  }
  const state = assertPrepareCleanupResult(rawState, receipt);
  if (state.status === "cleanup-complete") return { cleaned: true };

  const failed = await deleteFileKeys(
    state.stagedAttachmentKeys,
    receipt.projectionSha256,
    runtime,
  );
  if (failed.length > 0) {
    throw new FitnessPrepareCleanupIncompleteError(receipt, { failed });
  }
  let completed: DatabasePrepareRecoveryResult;
  try {
    completed = await runtime.completePrepareCleanup(
      databasePrepareReceiptFor(receipt),
    );
  } catch (error) {
    throw new FitnessPrepareCleanupIncompleteError(receipt, error);
  }
  const completion = assertPrepareCleanupResult(completed, receipt);
  if (completion.status !== "cleanup-complete") {
    throw new FitnessPrepareCleanupIncompleteError(
      receipt,
      new Error("Prepare cleanup completion was not durable."),
    );
  }
  return { cleaned: true };
}

async function activatePreparedInContext(
  rawReceipt: FitnessRestoreReceipt,
  runtime: FitnessBackupRuntime,
): Promise<FitnessRestoreActivation> {
  const receipt = await verifyRestoreReceipt(rawReceipt, runtime);
  const current = await currentGenerationFor(
    runtime,
    "暂时无法读取当前健身数据版本，因此没有执行恢复切换。",
  );

  if (isCurrentTarget(current, receipt)) {
    const inspected = await inspectBoundCurrentGeneration(receipt, runtime);
    if (!isCurrentTarget(inspected, receipt)) {
      throw new FitnessCurrentGenerationChangedError(
        receipt,
        inspected.generationId,
        inspected.sequence,
      );
    }
    broadcastKnownActivation(receipt.generationId, runtime);
    return {
      generationId: receipt.generationId,
      summary: receipt.summary,
      outcome: "already-current",
      previousRecoverySnapshotRetained: true,
    };
  }
  if (!isExpectedCurrent(current, receipt)) {
    throw new FitnessCurrentGenerationChangedError(
      receipt,
      current.generationId,
      current.sequence,
    );
  }

  try {
    parseActivatedGeneration(
      await runtime.activateStaged(
        stagedResultFor(receipt),
        databaseRecoveryReceiptFor(receipt),
      ),
      receipt,
    );
  } catch (activationError) {
    if (recoveryCredentialErrorCode(activationError)) {
      throw new FitnessRestoreError(
        "恢复凭据与已核对的候选版本不一致。没有更改当前健身数据。",
        "INVALID_RECEIPT",
        activationError,
      );
    }
    let observed: CurrentDatabaseGeneration;
    try {
      observed = await currentGenerationFor(
        runtime,
        "暂时无法核对恢复切换后的当前健身数据版本。",
      );
    } catch (inspectionError) {
      throw new FitnessActivationUncertainError(
        receipt.generationId,
        receipt,
        { activationError, inspectionError },
      );
    }
    if (isCurrentTarget(observed, receipt)) {
      broadcastKnownActivation(receipt.generationId, runtime);
      return {
        generationId: receipt.generationId,
        summary: receipt.summary,
        outcome: "confirmed-after-lost-response",
        previousRecoverySnapshotRetained: true,
      };
    }
    if (
      isRecord(activationError) &&
      activationError.code === "STAGED_BASELINE_CHANGED"
    ) {
      throw new FitnessCurrentGenerationChangedError(
        receipt,
        observed.generationId,
        observed.sequence,
      );
    }
    if (!isExpectedCurrent(observed, receipt)) {
      throw new FitnessCurrentGenerationChangedError(
        receipt,
        observed.generationId,
        observed.sequence,
      );
    }
    throw new FitnessRestoreError(
      "恢复候选没有成为当前版本，当前健身数据保持不变。",
      "ACTIVATION_FAILED",
      activationError,
    );
  }

  broadcastKnownActivation(receipt.generationId, runtime);
  return {
    generationId: receipt.generationId,
    summary: receipt.summary,
    outcome: "activated",
    previousRecoverySnapshotRetained: true,
  };
}

async function readCompleteSource(
  backup: Blob,
  runtime: FitnessBackupRuntime,
  signal?: AbortSignal,
): Promise<PreparedRestoreSource> {
  throwIfAborted(signal);
  const parsed = await parseFitnessBackupBlob(backup, runtime.hashBlob);
  throwIfAborted(signal);
  assertSupportedSourceIdentity(
    parsed.manifest.database.applicationId,
    parsed.manifest.database.userVersion,
  );
  const filesSha256 = await runtime.hashBlob(new Blob([
    JSON.stringify({
      version: 1,
      files: parsed.files.map(({ metadata }) => ({
        id: metadata.id,
        entityType: metadata.entityType,
        entityId: metadata.entityId,
        purpose: metadata.purpose,
        key: metadata.key,
        originalName: metadata.originalName,
        mimeType: metadata.mimeType,
        byteSize: metadata.byteSize,
        sha256: metadata.sha256,
        status: metadata.status,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
      })),
    }),
  ], { type: "application/json" }));
  if (!SHA256_PATTERN.test(filesSha256)) {
    throw new FitnessRestoreError(
      "无法建立附件清单摘要，当前健身数据没有改变。",
      "PREPARE_FAILED",
    );
  }
  return {
    kind: "complete-backup",
    parsed,
    database: parsed.database,
    fileName: safeFileName(backup),
    byteSize: backup.size,
    sourceUserVersion: parsed.manifest.database.userVersion,
    exportedAt: parsed.manifest.exportedAt,
    databaseSha256: parsed.manifest.database.sha256,
    filesSha256,
  };
}

async function readLegacySource(
  backup: Blob,
  runtime: FitnessBackupRuntime,
  signal?: AbortSignal,
): Promise<PreparedRestoreSource> {
  if (backup.size > FITNESS_BACKUP_LIMITS.databaseBytes) {
    throw new FitnessRestoreError(
      "所选文件超过旧版适练数据库的安全处理上限，当前健身数据没有改变。",
      "LEGACY_BACKUP_TOO_LARGE",
    );
  }
  throwIfAborted(signal);
  const database = new Uint8Array(await backup.arrayBuffer());
  throwIfAborted(signal);
  const identity = sqliteIdentity(database);
  assertSupportedSourceIdentity(identity.applicationId, identity.userVersion);
  const [databaseSha256, filesSha256] = await Promise.all([
    runtime.hashBlob(new Blob([database])),
    runtime.hashBlob(new Blob([
      JSON.stringify({ version: 1, files: [] }),
    ], { type: "application/json" })),
  ]);
  if (
    !SHA256_PATTERN.test(databaseSha256) ||
    !SHA256_PATTERN.test(filesSha256)
  ) {
    throw new FitnessRestoreError(
      "无法建立旧版数据库摘要，当前健身数据没有改变。",
      "PREPARE_FAILED",
    );
  }
  return {
    kind: "legacy-fitness-sqlite",
    database,
    fileName: safeFileName(backup),
    byteSize: backup.size,
    sourceUserVersion: identity.userVersion,
    exportedAt: null,
    databaseSha256,
    filesSha256,
  };
}

async function readAutoDetectedSource(
  backup: Blob,
  runtime: FitnessBackupRuntime,
  signal?: AbortSignal,
): Promise<PreparedRestoreSource> {
  throwIfAborted(signal);
  if (!(backup instanceof Blob)) {
    throw new FitnessRestoreError(
      "请选择一个可以读取的适练备份文件。",
      "PREPARE_FAILED",
    );
  }
  const complete = backup.size >= backupMagicBytes.byteLength &&
    new Uint8Array(
      await backup.slice(0, backupMagicBytes.byteLength).arrayBuffer(),
    ).every((byte, index) => byte === backupMagicBytes[index]);
  throwIfAborted(signal);
  return complete
    ? readCompleteSource(backup, runtime, signal)
    : readLegacySource(backup, runtime, signal);
}

async function discardAfterCompatibilityFailure(
  receipt: FitnessRestoreReceipt,
  runtime: FitnessBackupRuntime,
  error: unknown,
): Promise<never> {
  if (!(error instanceof FitnessActivationUncertainError)) {
    try {
      const discarded = await discardPreparedInContext(receipt, runtime);
      if (discarded.fileCleanup === "incomplete") {
        throw new Error(
          `Failed to clean ${discarded.failedFileKeys.length} staged files.`,
        );
      }
    } catch (discardError) {
      throw new FitnessDiscardUncertainError(
        receipt,
        { activationError: error, discardError },
      );
    }
  }
  throw error;
}

export function createFitnessBackupService(runtime: FitnessBackupRuntime = defaultRuntime) {
  return {
    async isCompleteBackup(blob: Blob): Promise<boolean> {
      if (!(blob instanceof Blob) || blob.size < backupMagicBytes.byteLength) {
        return false;
      }
      const prefix = new Uint8Array(
        await blob.slice(0, backupMagicBytes.byteLength).arrayBuffer(),
      );
      return prefix.every((byte, index) => byte === backupMagicBytes[index]);
    },

    async exportCompleteBackup(): Promise<CompleteFitnessBackupExport> {
      return runtime.withExclusiveLock(async () => {
        const exportedAt = runtime.now();
        const metadata = await referencedReadyFiles(runtime);
        const files: FitnessBackupFileInput[] = [];
        for (const expected of metadata) {
          const stored = await runtime.getFile(expected.key);
          await assertStoredFile(expected, stored, runtime);
          files.push({ metadata: expected, blob: stored.file });
        }
        const database = databaseBytes(await runtime.exportDatabase());
        const blob = await createFitnessBackupBlob(
          {
            database,
            files,
            exportedAt: exportedAt.toISOString(),
          },
          runtime.hashBlob,
        );
        return {
          blob,
          fileName: `shilian-complete-${exportedAt.toISOString().slice(0, 10)}.fitness-backup`,
          fileCount: files.length,
          byteSize: blob.size,
        };
      });
    },

    async prepareBackupRestore(
      backup: Blob,
      options: FitnessBackupRestoreOptions = {},
    ): Promise<FitnessRestoreReceipt> {
      if (!(backup instanceof Blob)) {
        throw new FitnessRestoreError(
          "请选择一个可以读取的适练备份文件。",
          "PREPARE_FAILED",
        );
      }
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new FitnessRestoreError(
          "恢复准备配置无效。当前健身数据没有改变。",
          "PREPARE_FAILED",
        );
      }
      if (
        options.onRecoveryPrepared !== undefined &&
        typeof options.onRecoveryPrepared !== "function"
      ) {
        throw new FitnessRestoreError(
          "恢复准备回调无效。当前健身数据没有改变。",
          "PREPARE_FAILED",
        );
      }
      const source = await readAutoDetectedSource(
        backup,
        runtime,
        options.signal,
      );
      return runtime.withExclusiveLock(() => stageSourceInContext(
        source,
        runtime,
        options.signal,
        options.onRecoveryPrepared,
      ));
    },

    async recoverBackupPrepare(
      receipt: FitnessPrepareRecoveryReceipt,
    ): Promise<FitnessPrepareRecovery> {
      return runtime.withExclusiveLock(() =>
        recoverPrepareInContext(receipt, runtime));
    },

    async retryPrepareCleanup(
      receipt: FitnessPrepareCleanupReceipt,
    ): Promise<Readonly<{ cleaned: true }>> {
      return runtime.withExclusiveLock(() =>
        retryPrepareCleanupInContext(receipt, runtime));
    },

    async activatePreparedRestore(
      receipt: FitnessRestoreReceipt,
    ): Promise<FitnessRestoreActivation> {
      return runtime.withExclusiveLock(() =>
        activatePreparedInContext(receipt, runtime));
    },

    /** Pure recovery read: one bound inspect call and no writes. */
    async inspectRestoreActivation(
      receipt: FitnessRestoreReceipt,
    ): Promise<FitnessRestoreActivationInspection> {
      const parsed = await verifyRestoreReceipt(receipt, runtime);
      const current = await inspectBoundCurrentGeneration(parsed, runtime);
      return {
        status: isCurrentTarget(current, parsed)
          ? "current"
          : "different-current",
        currentGenerationId: current.generationId,
        currentSequence: current.sequence,
      };
    },

    async discardPreparedRestore(
      receipt: FitnessRestoreReceipt,
    ): Promise<FitnessRestoreDiscard> {
      return runtime.withExclusiveLock(() =>
        discardPreparedInContext(receipt, runtime));
    },

    async restoreCompleteBackup(backup: Blob): Promise<CompleteFitnessBackupRestore> {
      const source = await readCompleteSource(backup, runtime);
      return runtime.withExclusiveLock(async () => {
        const receipt = await stageSourceInContext(source, runtime);
        try {
          await activatePreparedInContext(receipt, runtime);
        } catch (error) {
          return discardAfterCompatibilityFailure(receipt, runtime, error);
        }
        return {
          fileCount: receipt.summary.fileCount,
          byteSize: receipt.summary.byteSize,
          exportedAt: receipt.summary.exportedAt!,
          previousRecoverySnapshotRetained: true,
        };
      });
    },

    async restoreLegacyDatabase(backup: Blob): Promise<LegacyFitnessBackupRestore> {
      const source = await readLegacySource(backup, runtime);
      return runtime.withExclusiveLock(async () => {
        const receipt = await stageSourceInContext(source, runtime);
        try {
          await activatePreparedInContext(receipt, runtime);
        } catch (error) {
          return discardAfterCompatibilityFailure(receipt, runtime, error);
        }
        return {
          byteSize: receipt.summary.byteSize,
          previousRecoverySnapshotRetained: true,
        };
      });
    },
  };
}

const defaultService = createFitnessBackupService();

export const isCompleteFitnessBackup = defaultService.isCompleteBackup;
export const exportCompleteFitnessBackup = defaultService.exportCompleteBackup;
export const prepareFitnessBackupRestore = defaultService.prepareBackupRestore;
export const recoverFitnessBackupPrepare = defaultService.recoverBackupPrepare;
export const retryFitnessPrepareCleanup = defaultService.retryPrepareCleanup;
export const activatePreparedFitnessRestore = defaultService.activatePreparedRestore;
export const inspectFitnessRestoreActivation = defaultService.inspectRestoreActivation;
export const discardPreparedFitnessRestore = defaultService.discardPreparedRestore;
export const restoreCompleteFitnessBackup = defaultService.restoreCompleteBackup;
export const restoreLegacyFitnessDatabase = defaultService.restoreLegacyDatabase;
