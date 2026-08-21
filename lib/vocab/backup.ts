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
  createVocabBackupBlob,
  parseVocabBackupBlob,
  VOCAB_BACKUP_LIMITS,
  VOCAB_BACKUP_MAGIC,
  type ParsedVocabBackup,
  type VocabBackupAudioInput,
  type VocabBackupAudioMetadata,
} from "./backup-format";
import {
  createCompleteVocabRestoreStatements,
  createLegacyVocabRestoreStatements,
  VOCAB_SCHEMA_REQUIREMENTS,
  VOCAB_USER_VERSION,
} from "./backup-plan";
import { broadcastVocabChange, withVocabWriteLock } from "./lock";

const DATABASE = "vocab" as const;
const CANONICAL_DATABASE = "shici" as const;
const backupMagicBytes = new TextEncoder().encode(VOCAB_BACKUP_MAGIC);
const LOCAL_AUDIO_PATTERN = /^local:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SQLITE_IDENTITY_BYTE_SIZE = 72;
const sqliteHeaderBytes = new TextEncoder().encode("SQLite format 3\u0000");

export type CompleteVocabBackupExport = Readonly<{
  blob: Blob;
  fileName: string;
  audioCount: number;
  byteSize: number;
}>;

export type CompleteVocabBackupRestore = Readonly<{
  audioCount: number;
  byteSize: number;
  exportedAt: string;
  previousRecoverySnapshotRetained: true;
}>;

export type LegacyVocabBackupRestore = Readonly<{
  byteSize: number;
  previousRecoverySnapshotRetained: true;
}>;

/**
 * Counts that require querying the isolated candidate remain null. Reporting
 * the active database's counts here would misdescribe the selected backup.
 */
export type VocabRestoreSummary = Readonly<{
  kind: "complete-backup" | "legacy-vocab-sqlite";
  fileName: string | null;
  byteSize: number;
  databaseByteSize: number;
  exportedAt: string | null;
  sourceUserVersion: number;
  canonicalUserVersion: number;
  audioCount: number;
  itemCount: null;
  lexemeCount: null;
  verification:
    | "container-and-payload-verified"
    | "vocab-schema-verified";
}>;

/**
 * JSON-safe worker-bound capability for one isolated READY generation. Source
 * bytes, audio metadata, names and user prose are intentionally absent.
 */
export type VocabRestoreReceipt = Readonly<{
  version: 1;
  database: "shici";
  generationId: string;
  activationToken: string;
  recoveryToken: string;
  expectedCurrentGenerationId: string;
  expectedCurrentSequence: number;
  canonicalApplicationId: number;
  canonicalUserVersion: number;
  projectionSha256: string;
  preparedAt: string;
  summary: VocabRestoreSummary;
  stagedAudioKeys: readonly string[];
}>;

/** Persist this capability before the first OPFS or database staging write. */
export type VocabPrepareRecoveryReceipt = Readonly<{
  version: 1;
  database: "shici";
  operationId: string;
  generationId: string;
  operationToken: string;
  projectionSha256: string;
  audioKeysSha256: string;
  preparedAt: string;
  summary: VocabRestoreSummary;
  stagedAudioKeys: readonly string[];
}>;

/** Worker-bound authorization to delete only this prepare's staged audio. */
export type VocabPrepareCleanupReceipt = Readonly<{
  version: 1;
  database: "shici";
  operationId: string;
  generationId: string;
  operationToken: string;
  projectionSha256: string;
  audioKeysSha256: string;
  stagedAudioKeys: readonly string[];
}>;

export type VocabPrepareRecovery =
  | Readonly<{ status: "ready"; receipt: VocabRestoreReceipt }>
  | Readonly<{
      status: "cleanup-pending" | "cleanup-complete";
      cleanupReceipt: VocabPrepareCleanupReceipt;
    }>
  | Readonly<{ status: "discarded" }>;

export type VocabBackupRestoreOptions = Readonly<{
  signal?: AbortSignal;
  onRecoveryPrepared?(
    receipt: VocabPrepareRecoveryReceipt,
  ): void | Promise<void>;
}>;

export type VocabRestoreActivation = Readonly<{
  generationId: string;
  summary: VocabRestoreSummary;
  outcome: "activated" | "already-current" | "confirmed-after-lost-response";
  previousRecoverySnapshotRetained: true;
}>;

export type VocabRestoreActivationInspection = Readonly<{
  status: "current" | "different-current";
  currentGenerationId: string;
  currentSequence: number;
}>;

export type VocabRestoreDiscard = Readonly<{
  discarded: true;
  audioCleanup: "complete" | "incomplete";
  failedAudioKeys: readonly string[];
}>;

export type VocabRestoreErrorCode =
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

export class VocabRestoreError extends Error {
  readonly cause?: unknown;

  constructor(
    message: string,
    readonly code: VocabRestoreErrorCode,
    cause?: unknown,
  ) {
    super(message);
    this.name = "VocabRestoreError";
    this.cause = cause;
  }
}

export class VocabRestoreAbortedError extends VocabRestoreError {
  constructor() {
    super("已停止核对备份，当前词库没有改变。", "PREPARE_ABORTED");
    this.name = "AbortError";
  }
}

export class VocabActivationUncertainError extends VocabRestoreError {
  constructor(
    readonly targetGenerationId: string,
    readonly receipt: VocabRestoreReceipt,
    cause?: unknown,
  ) {
    super(
      "恢复切换结果暂时无法确认。候选与核对信息均已保留；请只核对当前版本，不要重新恢复。",
      "ACTIVATION_UNCERTAIN",
      cause,
    );
    this.name = "VocabActivationUncertainError";
  }
}

export class VocabCurrentGenerationChangedError extends VocabRestoreError {
  constructor(
    readonly currentGenerationId: string,
    readonly currentSequence: number,
  ) {
    super(
      "当前词库已在另一个页面更新或切换。这次没有覆盖它，请重新核对后再决定。",
      "CURRENT_GENERATION_CHANGED",
    );
    this.name = "VocabCurrentGenerationChangedError";
  }
}

export class VocabDiscardUncertainError extends VocabRestoreError {
  constructor(readonly receipt: VocabRestoreReceipt, cause?: unknown) {
    super(
      "候选清理结果暂时无法确认。恢复凭据已保留，请稍后只重试清理。",
      "DISCARD_UNCERTAIN",
      cause,
    );
    this.name = "VocabDiscardUncertainError";
  }
}

export class VocabPrepareUncertainError extends VocabRestoreError {
  constructor(readonly receipt: VocabPrepareRecoveryReceipt, cause?: unknown) {
    super(
      "候选建立结果暂时无法确认。操作凭据已保留；请只恢复这次准备，不要重新选择备份。",
      "PREPARE_UNCERTAIN",
      cause,
    );
    this.name = "VocabPrepareUncertainError";
  }
}

export class VocabPrepareCleanupIncompleteError extends VocabRestoreError {
  constructor(readonly receipt: VocabPrepareCleanupReceipt, cause?: unknown) {
    super(
      `有 ${receipt.stagedAudioKeys.length} 个未启用的暂存音频尚未清理。当前词库没有改变；可凭清理收据跨刷新重试。`,
      "PREPARE_CLEANUP_INCOMPLETE",
      cause,
    );
    this.name = "VocabPrepareCleanupIncompleteError";
  }
}

type StagedAudio = Readonly<{
  original: VocabBackupAudioMetadata;
  staged: LocalFileMetadata;
}>;

export type VocabBackupRuntime = Readonly<{
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
      prepareOperation: DatabasePrepareOperationReceipt<"shici">;
    }>,
  ): Promise<StagedDatabaseImportResult>;
  recoverPrepare(
    receipt: DatabasePrepareOperationReceipt<"shici">,
  ): Promise<DatabasePrepareRecoveryResult>;
  registerPrepareCleanup(
    receipt: DatabasePrepareOperationReceipt<"shici">,
  ): Promise<DatabasePrepareRecoveryResult>;
  completePrepareCleanup(
    receipt: DatabasePrepareOperationReceipt<"shici">,
  ): Promise<DatabasePrepareRecoveryResult>;
  activateStaged(
    staged: StagedDatabaseImportResult,
    recovery: DatabaseRecoveryReceipt<"shici">,
  ): Promise<ActivatedDatabaseGeneration | unknown>;
  inspectStaged(
    staged: StagedDatabaseImportResult,
    recovery: DatabaseRecoveryReceipt<"shici">,
  ): Promise<CurrentDatabaseGeneration | unknown>;
  currentGeneration(): Promise<CurrentDatabaseGeneration>;
  discardStaged(
    staged: StagedDatabaseImportResult,
    recovery: DatabaseRecoveryReceipt<"shici">,
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
  return withVocabWriteLock(task);
}

function broadcastGenerationChanged(generationId: string): void {
  broadcastVocabChange(`generation:${generationId}`);
}

const defaultRuntime: VocabBackupRuntime = {
  withExclusiveLock: defaultExclusiveLock,
  query: (sql, params) => localDb.query(DATABASE, sql, params),
  exportDatabase: () => localDb.export(DATABASE),
  stageImport: (database, statements, recovery) => {
    if (!recovery) {
      return localDb.stageImport(DATABASE, database, statements, VOCAB_SCHEMA_REQUIREMENTS);
    }
    return localDb.stageImport(
      DATABASE,
      database,
      statements,
      VOCAB_SCHEMA_REQUIREMENTS,
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
  if (signal?.aborted) throw new VocabRestoreAbortedError();
}

function sqliteIdentity(database: Uint8Array): Readonly<{
  applicationId: number;
  userVersion: number;
}> {
  if (database.byteLength < SQLITE_IDENTITY_BYTE_SIZE) {
    throw new VocabRestoreError(
      "这不是可识别的拾词数据库，当前词库没有改变。",
      "UNRECOGNIZED_SQLITE",
    );
  }
  for (let index = 0; index < sqliteHeaderBytes.byteLength; index += 1) {
    if (database[index] !== sqliteHeaderBytes[index]) {
      throw new VocabRestoreError(
        "这不是可识别的拾词数据库，当前词库没有改变。",
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
  const applicationIds = VOCAB_SCHEMA_REQUIREMENTS.sourceApplicationIds ?? [
    VOCAB_SCHEMA_REQUIREMENTS.applicationId,
  ];
  const minimum = VOCAB_SCHEMA_REQUIREMENTS.sourceMinimumUserVersion ??
    VOCAB_SCHEMA_REQUIREMENTS.minimumUserVersion;
  const maximum = VOCAB_SCHEMA_REQUIREMENTS.sourceMaximumUserVersion ??
    VOCAB_SCHEMA_REQUIREMENTS.maximumUserVersion;
  if (
    !Number.isSafeInteger(applicationId) ||
    !applicationIds.some((value) => value === applicationId) ||
    !Number.isSafeInteger(userVersion) ||
    userVersion < minimum ||
    userVersion > maximum
  ) {
    throw new VocabRestoreError(
      "这份数据库不是当前支持的拾词 v0-v2 版本，当前词库没有改变。",
      "UNSUPPORTED_SOURCE",
    );
  }
}

type PreparedRestoreSource =
  | Readonly<{
      kind: "complete-backup";
      parsed: ParsedVocabBackup;
      database: Uint8Array;
      fileName: string | null;
      byteSize: number;
      sourceUserVersion: number;
      exportedAt: string;
    }>
  | Readonly<{
      kind: "legacy-vocab-sqlite";
      database: Uint8Array;
      fileName: string | null;
      byteSize: number;
      sourceUserVersion: number;
      exportedAt: null;
    }>;

async function referencedAudioKeys(runtime: VocabBackupRuntime): Promise<string[]> {
  const result = await runtime.query<{ audio_url: string }>(
    `SELECT DISTINCT audio_url FROM vocab_items
      WHERE audio_url LIKE 'local:%'
      ORDER BY audio_url`,
  );
  return rowsOf<{ audio_url: string }>(result).map(({ audio_url }) => {
    const match = LOCAL_AUDIO_PATTERN.exec(audio_url);
    if (!match) {
      throw new Error(`数据库包含无法验证的本地音频引用：${audio_url}`);
    }
    return match[1];
  });
}

function newStagedAudioKeys(count: number): readonly string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const key = crypto.randomUUID().toLowerCase();
    if (!UUID_V4_PATTERN.test(key) || seen.has(key)) {
      throw new VocabRestoreError(
        "浏览器无法为暂存音频建立唯一凭据。当前词库没有改变。",
        "PREPARE_FAILED",
      );
    }
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

async function assertAudioKeysAvailable(
  keys: readonly string[],
  runtime: VocabBackupRuntime,
): Promise<void> {
  await Promise.all(keys.map((key) => runtime.assertFileKeyAvailable(key)));
}

function assertStagedAudio(
  original: VocabBackupAudioMetadata,
  staged: LocalFileMetadata,
  expectedKey: string,
  stagingOwner: string,
): void {
  if (
    staged.version !== 1 ||
    staged.namespace !== DATABASE ||
    staged.key !== expectedKey ||
    !UUID_V4_PATTERN.test(staged.key) ||
    staged.originalName !== original.originalName ||
    staged.mimeType !== original.mimeType ||
    staged.category !== original.category ||
    staged.byteSize !== original.byteSize ||
    staged.sha256 !== original.sha256 ||
    staged.createdAt !== original.createdAt ||
    staged.updatedAt !== original.updatedAt ||
    staged.stagingOwner !== stagingOwner
  ) {
    throw new VocabRestoreError(
      `暂存音频「${original.originalName}」时校验失败，当前词库没有改变。`,
      "PREPARE_FAILED",
    );
  }
}

async function stageAudio(
  parsed: ParsedVocabBackup,
  keys: readonly string[],
  stagingOwner: string,
  staged: StagedAudio[],
  runtime: VocabBackupRuntime,
  signal?: AbortSignal,
): Promise<void> {
  if (parsed.audio.length !== keys.length) {
    throw new VocabRestoreError(
      "暂存音频数量与恢复凭据不一致。当前词库没有改变。",
      "PREPARE_FAILED",
    );
  }
  for (let index = 0; index < parsed.audio.length; index += 1) {
    const audio = parsed.audio[index];
    throwIfAborted(signal);
    const metadata = await runtime.saveFileAtKey(
      keys[index],
      audio.blob,
      {
        originalName: audio.metadata.originalName,
        mimeType: audio.metadata.mimeType,
        category: audio.metadata.category ?? undefined,
        createdAt: audio.metadata.createdAt,
        updatedAt: audio.metadata.updatedAt,
      },
      stagingOwner,
    );
    staged.push({ original: audio.metadata, staged: metadata });
    assertStagedAudio(audio.metadata, metadata, keys[index], stagingOwner);
    throwIfAborted(signal);
  }
}

async function deleteAudioKeys(
  keys: readonly string[],
  stagingOwner: string,
  runtime: VocabBackupRuntime,
): Promise<string[]> {
  const results = await Promise.allSettled(
    keys.map((key) => runtime.deleteOwnedFile(key, stagingOwner)),
  );
  return results.flatMap((result, index) =>
    result.status === "rejected" ? [keys[index]] : []);
}

function summaryFor(source: PreparedRestoreSource): VocabRestoreSummary {
  return {
    kind: source.kind,
    fileName: source.fileName,
    byteSize: source.byteSize,
    databaseByteSize: source.database.byteLength,
    exportedAt: source.exportedAt,
    sourceUserVersion: source.sourceUserVersion,
    canonicalUserVersion: VOCAB_USER_VERSION,
    audioCount: source.kind === "complete-backup"
      ? source.parsed.audio.length
      : 0,
    itemCount: null,
    lexemeCount: null,
    verification: source.kind === "complete-backup"
      ? "container-and-payload-verified"
      : "vocab-schema-verified",
  };
}

type VocabRestoreProjection = Readonly<{
  version: 1;
  database: "shici";
  preparedAt: string;
  summary: VocabRestoreSummary;
  stagedAudioKeys: readonly string[];
}>;

function restoreProjection(
  preparedAt: string,
  summary: VocabRestoreSummary,
  stagedAudioKeys: readonly string[],
): VocabRestoreProjection {
  return {
    version: 1,
    database: CANONICAL_DATABASE,
    preparedAt,
    summary,
    stagedAudioKeys: [...stagedAudioKeys],
  };
}

async function projectionSha256(
  projection: VocabRestoreProjection,
  runtime: VocabBackupRuntime,
): Promise<string> {
  return runtime.hashBlob(new Blob([
    JSON.stringify({
      version: projection.version,
      database: projection.database,
      preparedAt: projection.preparedAt,
      summary: {
        kind: projection.summary.kind,
        fileName: projection.summary.fileName,
        byteSize: projection.summary.byteSize,
        databaseByteSize: projection.summary.databaseByteSize,
        exportedAt: projection.summary.exportedAt,
        sourceUserVersion: projection.summary.sourceUserVersion,
        canonicalUserVersion: projection.summary.canonicalUserVersion,
        audioCount: projection.summary.audioCount,
        itemCount: projection.summary.itemCount,
        lexemeCount: projection.summary.lexemeCount,
        verification: projection.summary.verification,
      },
      stagedAudioKeys: projection.stagedAudioKeys,
    }),
  ], { type: "application/json" }));
}

async function audioKeysSha256(
  keys: readonly string[],
  runtime: VocabBackupRuntime,
): Promise<string> {
  return runtime.hashBlob(new Blob([
    JSON.stringify({ version: 1, stagedAudioKeys: keys }),
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
    throw new VocabRestoreError(
      "浏览器无法建立安全的恢复操作凭据。当前词库没有改变。",
      "PREPARE_FAILED",
    );
  }
  return { operationId, operationToken };
}

function databasePrepareReceiptFor(
  receipt: VocabPrepareRecoveryReceipt | VocabPrepareCleanupReceipt,
): DatabasePrepareOperationReceipt<"shici"> {
  return {
    version: 1,
    database: CANONICAL_DATABASE,
    operationId: receipt.operationId,
    generationId: receipt.generationId,
    operationToken: receipt.operationToken,
    projectionSha256: receipt.projectionSha256,
    attachmentKeysSha256: receipt.audioKeysSha256,
    stagedAttachmentKeys: [...receipt.stagedAudioKeys],
  };
}

function prepareRecoveryReceiptFor(
  projection: VocabRestoreProjection,
  projectionDigest: string,
  audioKeysDigest: string,
  capability: Readonly<{ operationId: string; operationToken: string }>,
): VocabPrepareRecoveryReceipt {
  return {
    version: 1,
    database: CANONICAL_DATABASE,
    operationId: capability.operationId,
    generationId: capability.operationId,
    operationToken: capability.operationToken,
    projectionSha256: projectionDigest,
    audioKeysSha256: audioKeysDigest,
    preparedAt: projection.preparedAt,
    summary: projection.summary,
    stagedAudioKeys: [...projection.stagedAudioKeys],
  };
}

function recoveryCheckpointFor(
  receipt: VocabPrepareRecoveryReceipt,
): VocabPrepareRecoveryReceipt {
  return Object.freeze({
    ...receipt,
    summary: Object.freeze({ ...receipt.summary }),
    stagedAudioKeys: Object.freeze([...receipt.stagedAudioKeys]),
  });
}

function parseRestoreSummary(value: unknown): VocabRestoreSummary {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "kind", "fileName", "byteSize", "databaseByteSize", "exportedAt",
      "sourceUserVersion", "canonicalUserVersion", "audioCount",
      "itemCount", "lexemeCount", "verification",
    ]) ||
    (value.kind !== "complete-backup" && value.kind !== "legacy-vocab-sqlite") ||
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
    value.byteSize > VOCAB_BACKUP_LIMITS.totalBytes ||
    typeof value.databaseByteSize !== "number" ||
    !Number.isSafeInteger(value.databaseByteSize) ||
    value.databaseByteSize < SQLITE_IDENTITY_BYTE_SIZE ||
    value.databaseByteSize > VOCAB_BACKUP_LIMITS.databaseBytes ||
    value.databaseByteSize > value.byteSize ||
    !(value.exportedAt === null || (
      typeof value.exportedAt === "string" &&
      isCanonicalIsoTimestamp(value.exportedAt)
    )) ||
    typeof value.sourceUserVersion !== "number" ||
    !Number.isSafeInteger(value.sourceUserVersion) ||
    value.sourceUserVersion < 0 ||
    value.sourceUserVersion > VOCAB_USER_VERSION ||
    value.canonicalUserVersion !== VOCAB_USER_VERSION ||
    typeof value.audioCount !== "number" ||
    !Number.isSafeInteger(value.audioCount) ||
    value.audioCount < 0 ||
    value.audioCount > VOCAB_BACKUP_LIMITS.audioCount ||
    value.itemCount !== null ||
    value.lexemeCount !== null ||
    (value.verification !== "container-and-payload-verified" &&
      value.verification !== "vocab-schema-verified") ||
    (value.kind === "complete-backup" && (
      value.exportedAt === null ||
      value.verification !== "container-and-payload-verified"
    )) ||
    (value.kind === "legacy-vocab-sqlite" && (
      value.exportedAt !== null ||
      value.audioCount !== 0 ||
      value.byteSize !== value.databaseByteSize ||
      value.verification !== "vocab-schema-verified"
    ))
  ) {
    throw new VocabRestoreError(
      "恢复核对信息无效。为保护当前词库，没有继续操作。",
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
    canonicalUserVersion: VOCAB_USER_VERSION,
    audioCount: value.audioCount,
    itemCount: null,
    lexemeCount: null,
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
  audioKeysSha256: string;
  stagedAudioKeys: readonly string[];
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
    typeof value.audioKeysSha256 !== "string" ||
    !SHA256_PATTERN.test(value.audioKeysSha256) ||
    !Array.isArray(value.stagedAudioKeys) ||
    value.stagedAudioKeys.length > VOCAB_BACKUP_LIMITS.audioCount ||
    value.stagedAudioKeys.some((key) =>
      typeof key !== "string" || !UUID_V4_PATTERN.test(key)) ||
    new Set(value.stagedAudioKeys).size !== value.stagedAudioKeys.length
  ) {
    throw new VocabRestoreError(
      "恢复准备凭据无效。为保护当前词库，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  return {
    operationId: value.operationId,
    generationId: value.operationId,
    operationToken: value.operationToken,
    projectionSha256: value.projectionSha256,
    audioKeysSha256: value.audioKeysSha256,
    stagedAudioKeys: [...value.stagedAudioKeys] as string[],
  };
}

async function verifyPrepareRecoveryReceipt(
  value: unknown,
  runtime: VocabBackupRuntime,
): Promise<VocabPrepareRecoveryReceipt> {
  const core = parsePrepareReceiptCore(value, [
    "version", "database", "operationId", "generationId", "operationToken",
    "projectionSha256", "audioKeysSha256", "preparedAt", "summary",
    "stagedAudioKeys",
  ]);
  if (
    !isRecord(value) ||
    typeof value.preparedAt !== "string" ||
    !isCanonicalIsoTimestamp(value.preparedAt)
  ) {
    throw new VocabRestoreError(
      "恢复准备凭据无效。为保护当前词库，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  const summary = parseRestoreSummary(value.summary);
  if (summary.audioCount !== core.stagedAudioKeys.length) {
    throw new VocabRestoreError(
      "恢复准备凭据彼此不一致。为保护当前词库，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  const receipt: VocabPrepareRecoveryReceipt = {
    version: 1,
    database: CANONICAL_DATABASE,
    ...core,
    preparedAt: value.preparedAt,
    summary,
  };
  const digest = await projectionSha256(restoreProjection(
    receipt.preparedAt,
    receipt.summary,
    receipt.stagedAudioKeys,
  ), runtime);
  if (digest !== receipt.projectionSha256) {
    throw new VocabRestoreError(
      "恢复准备凭据与暂存内容不一致。为保护当前词库，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  if (
    await audioKeysSha256(receipt.stagedAudioKeys, runtime) !==
      receipt.audioKeysSha256
  ) {
    throw new VocabRestoreError(
      "恢复准备凭据的音频范围不一致。为保护当前词库，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  return receipt;
}

async function verifyPrepareCleanupReceipt(
  value: unknown,
  runtime: VocabBackupRuntime,
): Promise<VocabPrepareCleanupReceipt> {
  const core = parsePrepareReceiptCore(value, [
    "version", "database", "operationId", "generationId", "operationToken",
    "projectionSha256", "audioKeysSha256", "stagedAudioKeys",
  ]);
  const receipt: VocabPrepareCleanupReceipt = {
    version: 1,
    database: CANONICAL_DATABASE,
    ...core,
  };
  if (
    await audioKeysSha256(receipt.stagedAudioKeys, runtime) !==
      receipt.audioKeysSha256
  ) {
    throw new VocabRestoreError(
      "暂存清理凭据与音频范围不一致。没有删除任何音频。",
      "INVALID_RECEIPT",
    );
  }
  return receipt;
}

function parseStagedRecoveryReceipt(
  value: unknown,
  generationId: string,
  expectedProjectionSha256: string,
): DatabaseRecoveryReceipt<"shici"> {
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
    value.canonicalApplicationId !== VOCAB_SCHEMA_REQUIREMENTS.applicationId ||
    value.canonicalUserVersion !== VOCAB_USER_VERSION ||
    value.projectionSha256 !== expectedProjectionSha256
  ) {
    throw new VocabRestoreError(
      "候选数据库返回了无效的恢复凭据，当前词库没有改变。",
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
  recovery: DatabaseRecoveryReceipt<"shici">,
  projection: VocabRestoreProjection,
  projectionDigest: string,
): VocabRestoreReceipt {
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
    projectionSha256: projectionDigest,
    preparedAt: projection.preparedAt,
    summary: projection.summary,
    stagedAudioKeys: [...projection.stagedAudioKeys],
  };
}

function parseRestoreReceipt(value: unknown): VocabRestoreReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version", "database", "generationId", "activationToken",
      "recoveryToken", "expectedCurrentGenerationId",
      "expectedCurrentSequence", "canonicalApplicationId",
      "canonicalUserVersion", "projectionSha256", "preparedAt", "summary",
      "stagedAudioKeys",
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
    value.canonicalApplicationId !== VOCAB_SCHEMA_REQUIREMENTS.applicationId ||
    value.canonicalUserVersion !== VOCAB_USER_VERSION ||
    typeof value.projectionSha256 !== "string" ||
    !SHA256_PATTERN.test(value.projectionSha256) ||
    typeof value.preparedAt !== "string" ||
    !isCanonicalIsoTimestamp(value.preparedAt) ||
    !Array.isArray(value.stagedAudioKeys) ||
    value.stagedAudioKeys.length > VOCAB_BACKUP_LIMITS.audioCount ||
    value.stagedAudioKeys.some((key) =>
      typeof key !== "string" || !UUID_V4_PATTERN.test(key)) ||
    new Set(value.stagedAudioKeys).size !== value.stagedAudioKeys.length
  ) {
    throw new VocabRestoreError(
      "恢复核对信息无效。为保护当前词库，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  const summary = parseRestoreSummary(value.summary);
  if (
    summary.audioCount !== value.stagedAudioKeys.length ||
    summary.canonicalUserVersion !== value.canonicalUserVersion
  ) {
    throw new VocabRestoreError(
      "恢复核对信息彼此不一致。为保护当前词库，没有继续操作。",
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
    projectionSha256: value.projectionSha256,
    preparedAt: value.preparedAt,
    summary,
    stagedAudioKeys: [...value.stagedAudioKeys] as string[],
  };
}

async function verifyRestoreReceipt(
  value: unknown,
  runtime: VocabBackupRuntime,
): Promise<VocabRestoreReceipt> {
  const receipt = parseRestoreReceipt(value);
  const digest = await projectionSha256(restoreProjection(
    receipt.preparedAt,
    receipt.summary,
    receipt.stagedAudioKeys,
  ), runtime);
  if (digest !== receipt.projectionSha256) {
    throw new VocabRestoreError(
      "恢复核对信息与候选版本不一致。为保护当前词库，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  return receipt;
}

function databaseRecoveryReceiptFor(
  receipt: VocabRestoreReceipt,
): DatabaseRecoveryReceipt<"shici"> {
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

function stagedResultFor(receipt: VocabRestoreReceipt): StagedDatabaseImportResult<"shici"> {
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
): CurrentDatabaseGeneration<"shici"> {
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
    throw new Error("Invalid current Vocabulary database generation response.");
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
  receipt: VocabRestoreReceipt,
): ActivatedDatabaseGeneration<"shici"> {
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
    throw new Error("Invalid staged Vocabulary activation response.");
  }
  return {
    database: CANONICAL_DATABASE,
    filename: value.filename as `shici.${string}.sqlite3`,
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
  receipt: VocabRestoreReceipt,
): boolean {
  return current.database === CANONICAL_DATABASE &&
    current.generationId === receipt.generationId;
}

function isExpectedCurrent(
  current: CurrentDatabaseGeneration,
  receipt: VocabRestoreReceipt,
): boolean {
  return current.database === CANONICAL_DATABASE &&
    current.generationId === receipt.expectedCurrentGenerationId &&
    current.sequence === receipt.expectedCurrentSequence;
}

async function currentGenerationFor(
  runtime: VocabBackupRuntime,
  message: string,
): Promise<CurrentDatabaseGeneration<"shici">> {
  try {
    return parseCurrentGeneration(await runtime.currentGeneration());
  } catch (error) {
    throw new VocabRestoreError(
      message,
      "CURRENT_GENERATION_UNAVAILABLE",
      error,
    );
  }
}

async function inspectBoundCurrentGeneration(
  receipt: VocabRestoreReceipt,
  runtime: VocabBackupRuntime,
): Promise<CurrentDatabaseGeneration<"shici">> {
  try {
    return parseCurrentGeneration(await runtime.inspectStaged(
      stagedResultFor(receipt),
      databaseRecoveryReceiptFor(receipt),
    ));
  } catch (error) {
    if (recoveryCredentialErrorCode(error)) {
      throw new VocabRestoreError(
        "恢复凭据与已核对的候选版本不一致。没有更改当前词库。",
        "INVALID_RECEIPT",
        error,
      );
    }
    throw new VocabRestoreError(
      "暂时无法核对当前词库版本。候选与恢复信息都已保留。",
      "CURRENT_GENERATION_UNAVAILABLE",
      error,
    );
  }
}

function broadcastKnownActivation(
  generationId: string,
  runtime: VocabBackupRuntime,
): void {
  try {
    runtime.broadcastGenerationChanged(generationId);
  } catch {
    // The durable generation pointer is authoritative. A notification failure
    // must never turn success into a retryable restore.
  }
}

async function discardStagedCandidate(
  receipt: VocabRestoreReceipt,
  runtime: VocabBackupRuntime,
): Promise<void> {
  let result: unknown;
  try {
    result = await runtime.discardStaged(
      stagedResultFor(receipt),
      databaseRecoveryReceiptFor(receipt),
    );
  } catch (error) {
    throw new VocabRestoreError(
      "候选状态暂时无法确认，因此没有清理任何暂存音频。",
      "DISCARD_UNCERTAIN",
      error,
    );
  }
  if (
    !isRecord(result) ||
    result.database !== CANONICAL_DATABASE ||
    result.generationId !== receipt.generationId ||
    result.discarded !== true
  ) {
    throw new VocabRestoreError(
      "候选没有返回明确的清理结果，因此没有清理任何暂存音频。",
      "DISCARD_UNCERTAIN",
    );
  }
}

async function discardPreparedInContext(
  rawReceipt: VocabRestoreReceipt,
  runtime: VocabBackupRuntime,
): Promise<VocabRestoreDiscard> {
  const receipt = await verifyRestoreReceipt(rawReceipt, runtime);
  await discardStagedCandidate(receipt, runtime);
  const failedAudioKeys = await deleteAudioKeys(
    receipt.stagedAudioKeys,
    receipt.projectionSha256,
    runtime,
  );
  return {
    discarded: true,
    audioCleanup: failedAudioKeys.length === 0 ? "complete" : "incomplete",
    failedAudioKeys,
  };
}

function cleanupReceiptFromPrepare(
  receipt: VocabPrepareRecoveryReceipt,
): VocabPrepareCleanupReceipt {
  return {
    version: 1,
    database: CANONICAL_DATABASE,
    operationId: receipt.operationId,
    generationId: receipt.generationId,
    operationToken: receipt.operationToken,
    projectionSha256: receipt.projectionSha256,
    audioKeysSha256: receipt.audioKeysSha256,
    stagedAudioKeys: [...receipt.stagedAudioKeys],
  };
}

function assertPrepareCleanupResult(
  value: unknown,
  receipt: VocabPrepareCleanupReceipt,
): Extract<DatabasePrepareRecoveryResult, {
  status: "cleanup-pending" | "cleanup-complete";
}> {
  if (
    !isRecord(value) ||
    value.database !== CANONICAL_DATABASE ||
    value.operationId !== receipt.operationId ||
    (value.status !== "cleanup-pending" && value.status !== "cleanup-complete") ||
    !Array.isArray(value.stagedAttachmentKeys) ||
    value.stagedAttachmentKeys.length !== receipt.stagedAudioKeys.length ||
    value.stagedAttachmentKeys.some(
      (key, index) => key !== receipt.stagedAudioKeys[index],
    )
  ) {
    throw new VocabRestoreError(
      "暂存清理授权无法核对。没有删除任何音频。",
      "INVALID_RECEIPT",
    );
  }
  return value as Extract<DatabasePrepareRecoveryResult, {
    status: "cleanup-pending" | "cleanup-complete";
  }>;
}

async function stageSourceInContext(
  source: PreparedRestoreSource,
  runtime: VocabBackupRuntime,
  signal?: AbortSignal,
  onRecoveryPrepared?: VocabBackupRestoreOptions["onRecoveryPrepared"],
): Promise<VocabRestoreReceipt> {
  throwIfAborted(signal);
  const stagedAudio: StagedAudio[] = [];
  let preparedReceipt: VocabRestoreReceipt | null = null;
  let prepareReceipt: VocabPrepareRecoveryReceipt | null = null;
  let audioStageStarted = false;
  let atomicStageStarted = false;
  try {
    const capability = newPrepareCapability();
    const stagedAudioKeys = newStagedAudioKeys(
      source.kind === "complete-backup" ? source.parsed.audio.length : 0,
    );
    await assertAudioKeysAvailable(stagedAudioKeys, runtime);
    throwIfAborted(signal);

    const projection = restoreProjection(
      runtime.now().toISOString(),
      summaryFor(source),
      stagedAudioKeys,
    );
    const projectionDigest = await projectionSha256(projection, runtime);
    const audioKeysDigest = await audioKeysSha256(stagedAudioKeys, runtime);
    if (
      !SHA256_PATTERN.test(projectionDigest) ||
      !SHA256_PATTERN.test(audioKeysDigest)
    ) {
      throw new VocabRestoreError(
        "浏览器无法建立可核对的恢复摘要。当前词库没有改变。",
        "PREPARE_FAILED",
      );
    }
    prepareReceipt = prepareRecoveryReceiptFor(
      projection,
      projectionDigest,
      audioKeysDigest,
      capability,
    );
    throwIfAborted(signal);

    if (onRecoveryPrepared) {
      try {
        await onRecoveryPrepared(recoveryCheckpointFor(prepareReceipt));
      } catch (error) {
        throw new VocabRestoreError(
          "恢复信息未能安全保存，因此没有开始建立候选。当前词库没有改变。",
          "PREPARE_FAILED",
          error,
        );
      }
    }
    throwIfAborted(signal);

    if (source.kind === "complete-backup" && stagedAudioKeys.length > 0) {
      audioStageStarted = true;
      await stageAudio(
        source.parsed,
        stagedAudioKeys,
        projectionDigest,
        stagedAudio,
        runtime,
        signal,
      );
    }
    throwIfAborted(signal);
    const statements = source.kind === "complete-backup"
      ? createCompleteVocabRestoreStatements(
          stagedAudio,
          source.sourceUserVersion,
          runtime.now().getTime(),
        )
      : createLegacyVocabRestoreStatements(
          source.sourceUserVersion,
          runtime.now().getTime(),
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
      throw new VocabRestoreError(
        "候选数据库返回了无效的核对信息，当前词库没有改变。",
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
      stagedDatabase.schemaVersion !== VOCAB_USER_VERSION
    ) {
      throw new VocabRestoreError(
        "候选数据库返回了无效的核对信息，当前词库没有改变。",
        "PREPARE_FAILED",
      );
    }
    return preparedReceipt;
  } catch (error) {
    if (preparedReceipt) {
      try {
        const discarded = await discardPreparedInContext(preparedReceipt, runtime);
        if (discarded.audioCleanup === "incomplete") {
          throw new VocabDiscardUncertainError(preparedReceipt, {
            prepareError: error,
            failedAudioKeys: discarded.failedAudioKeys,
          });
        }
      } catch (discardError) {
        if (discardError instanceof VocabDiscardUncertainError) throw discardError;
        throw new VocabDiscardUncertainError(
          preparedReceipt,
          { prepareError: error, discardError },
        );
      }
    }
    if (atomicStageStarted && !preparedReceipt && prepareReceipt) {
      throw new VocabPrepareUncertainError(prepareReceipt, error);
    }
    const failed = audioStageStarted && prepareReceipt
      ? await deleteAudioKeys(
          prepareReceipt.stagedAudioKeys,
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
        throw new VocabPrepareCleanupIncompleteError(
          cleanupReceipt,
          { prepareError: error, bindingError },
        );
      }
      throw new VocabPrepareCleanupIncompleteError(cleanupReceipt, error);
    }
    if (error instanceof VocabRestoreError) throw error;
    throw new VocabRestoreError(
      "未能建立安全的恢复候选，当前词库没有改变。",
      "PREPARE_FAILED",
      error,
    );
  }
}

async function recoverPrepareInContext(
  rawReceipt: VocabPrepareRecoveryReceipt,
  runtime: VocabBackupRuntime,
): Promise<VocabPrepareRecovery> {
  const receipt = await verifyPrepareRecoveryReceipt(rawReceipt, runtime);
  let result: DatabasePrepareRecoveryResult;
  try {
    result = await runtime.recoverPrepare(databasePrepareReceiptFor(receipt));
  } catch (error) {
    if (!isRecord(error) || error.code !== "PREPARE_OPERATION_NOT_FOUND") {
      throw new VocabRestoreError(
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
      throw new VocabRestoreError(
        "暂时无法确认这次准备是否可以安全清理。操作凭据已保留，没有删除任何音频。",
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
      staged.schemaVersion !== VOCAB_USER_VERSION
    ) {
      throw new VocabRestoreError(
        "恢复准备结果与操作凭据不一致。当前词库没有改变。",
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
          receipt.preparedAt,
          receipt.summary,
          receipt.stagedAudioKeys,
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
      throw new VocabRestoreError(
        "恢复准备结果与操作凭据不一致。当前词库没有改变。",
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
  rawReceipt: VocabPrepareCleanupReceipt,
  runtime: VocabBackupRuntime,
): Promise<Readonly<{ cleaned: true }>> {
  const receipt = await verifyPrepareCleanupReceipt(rawReceipt, runtime);
  let rawState: DatabasePrepareRecoveryResult;
  try {
    rawState = await runtime.recoverPrepare(databasePrepareReceiptFor(receipt));
  } catch (error) {
    if (!isRecord(error) || error.code !== "PREPARE_OPERATION_NOT_FOUND") {
      throw new VocabPrepareCleanupIncompleteError(receipt, error);
    }
    try {
      rawState = await runtime.registerPrepareCleanup(
        databasePrepareReceiptFor(receipt),
      );
    } catch (registrationError) {
      throw new VocabPrepareCleanupIncompleteError(receipt, registrationError);
    }
  }
  const state = assertPrepareCleanupResult(rawState, receipt);
  if (state.status === "cleanup-complete") return { cleaned: true };

  const failed = await deleteAudioKeys(
    state.stagedAttachmentKeys,
    receipt.projectionSha256,
    runtime,
  );
  if (failed.length > 0) {
    throw new VocabPrepareCleanupIncompleteError(receipt, { failed });
  }
  let completed: DatabasePrepareRecoveryResult;
  try {
    completed = await runtime.completePrepareCleanup(
      databasePrepareReceiptFor(receipt),
    );
  } catch (error) {
    throw new VocabPrepareCleanupIncompleteError(receipt, error);
  }
  const completion = assertPrepareCleanupResult(completed, receipt);
  if (completion.status !== "cleanup-complete") {
    throw new VocabPrepareCleanupIncompleteError(
      receipt,
      new Error("Prepare cleanup completion was not durable."),
    );
  }
  return { cleaned: true };
}

async function activatePreparedInContext(
  rawReceipt: VocabRestoreReceipt,
  runtime: VocabBackupRuntime,
): Promise<VocabRestoreActivation> {
  const receipt = await verifyRestoreReceipt(rawReceipt, runtime);
  const current = await currentGenerationFor(
    runtime,
    "暂时无法读取当前词库版本，因此没有执行恢复切换。",
  );

  if (isCurrentTarget(current, receipt)) {
    const inspected = await inspectBoundCurrentGeneration(receipt, runtime);
    if (!isCurrentTarget(inspected, receipt)) {
      throw new VocabCurrentGenerationChangedError(
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
    throw new VocabCurrentGenerationChangedError(
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
      throw new VocabRestoreError(
        "恢复凭据与已核对的候选版本不一致。没有更改当前词库。",
        "INVALID_RECEIPT",
        activationError,
      );
    }
    let observed: CurrentDatabaseGeneration;
    try {
      observed = await currentGenerationFor(
        runtime,
        "暂时无法核对恢复切换后的当前词库版本。",
      );
    } catch (inspectionError) {
      throw new VocabActivationUncertainError(
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
      throw new VocabCurrentGenerationChangedError(
        observed.generationId,
        observed.sequence,
      );
    }
    if (!isExpectedCurrent(observed, receipt)) {
      throw new VocabCurrentGenerationChangedError(
        observed.generationId,
        observed.sequence,
      );
    }
    throw new VocabRestoreError(
      "恢复候选没有成为当前版本，当前词库保持不变。",
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
  runtime: VocabBackupRuntime,
  signal?: AbortSignal,
): Promise<PreparedRestoreSource> {
  throwIfAborted(signal);
  const parsed = await parseVocabBackupBlob(backup, runtime.hashBlob);
  throwIfAborted(signal);
  assertSupportedSourceIdentity(
    parsed.manifest.database.applicationId,
    parsed.manifest.database.userVersion,
  );
  return {
    kind: "complete-backup",
    parsed,
    database: parsed.database,
    fileName: safeFileName(backup),
    byteSize: backup.size,
    sourceUserVersion: parsed.manifest.database.userVersion,
    exportedAt: parsed.manifest.exportedAt,
  };
}

async function readLegacySource(
  backup: Blob,
  signal?: AbortSignal,
): Promise<PreparedRestoreSource> {
  if (backup.size > VOCAB_BACKUP_LIMITS.databaseBytes) {
    throw new VocabRestoreError(
      "所选文件超过旧版拾词数据库的安全处理上限，当前词库没有改变。",
      "LEGACY_BACKUP_TOO_LARGE",
    );
  }
  throwIfAborted(signal);
  const database = new Uint8Array(await backup.arrayBuffer());
  throwIfAborted(signal);
  const identity = sqliteIdentity(database);
  assertSupportedSourceIdentity(identity.applicationId, identity.userVersion);
  return {
    kind: "legacy-vocab-sqlite",
    database,
    fileName: safeFileName(backup),
    byteSize: backup.size,
    sourceUserVersion: identity.userVersion,
    exportedAt: null,
  };
}

async function readAutoDetectedSource(
  backup: Blob,
  runtime: VocabBackupRuntime,
  signal?: AbortSignal,
): Promise<PreparedRestoreSource> {
  throwIfAborted(signal);
  if (!(backup instanceof Blob)) {
    throw new VocabRestoreError(
      "请选择一个可以读取的拾词备份文件。",
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
    : readLegacySource(backup, signal);
}

async function discardAfterCompatibilityFailure(
  receipt: VocabRestoreReceipt,
  runtime: VocabBackupRuntime,
  error: unknown,
): Promise<never> {
  if (!(error instanceof VocabActivationUncertainError)) {
    try {
      const discarded = await discardPreparedInContext(receipt, runtime);
      if (discarded.audioCleanup === "incomplete") {
        throw new Error(
          `Failed to clean ${discarded.failedAudioKeys.length} staged audio files.`,
        );
      }
    } catch (discardError) {
      throw new VocabDiscardUncertainError(
        receipt,
        { activationError: error, discardError },
      );
    }
  }
  throw error;
}

export function createVocabBackupService(runtime: VocabBackupRuntime = defaultRuntime) {
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

    async exportCompleteBackup(): Promise<CompleteVocabBackupExport> {
      return runtime.withExclusiveLock(async () => {
        const exportedAt = runtime.now();
        const keys = await referencedAudioKeys(runtime);
        const audio: VocabBackupAudioInput[] = [];
        for (const key of keys) {
          const stored = await runtime.getFile(key);
          if (stored.metadata.key !== key || stored.metadata.namespace !== DATABASE) {
            throw new Error("本地音频索引与实际文件不一致，已停止导出");
          }
          audio.push({ metadata: stored.metadata, blob: stored.file });
        }
        const database = databaseBytes(await runtime.exportDatabase());
        const blob = await createVocabBackupBlob(
          {
            database,
            audio: audio.sort((left, right) => left.metadata.key.localeCompare(right.metadata.key)),
            exportedAt: exportedAt.toISOString(),
          },
          runtime.hashBlob,
        );
        return {
          blob,
          fileName: `shici-complete-${exportedAt.toISOString().slice(0, 10)}.vocab-backup`,
          audioCount: audio.length,
          byteSize: blob.size,
        };
      });
    },

    async prepareBackupRestore(
      backup: Blob,
      options: VocabBackupRestoreOptions = {},
    ): Promise<VocabRestoreReceipt> {
      if (!(backup instanceof Blob)) {
        throw new VocabRestoreError(
          "请选择一个可以读取的拾词备份文件。",
          "PREPARE_FAILED",
        );
      }
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new VocabRestoreError(
          "恢复准备配置无效。当前词库没有改变。",
          "PREPARE_FAILED",
        );
      }
      if (
        options.onRecoveryPrepared !== undefined &&
        typeof options.onRecoveryPrepared !== "function"
      ) {
        throw new VocabRestoreError(
          "恢复准备回调无效。当前词库没有改变。",
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
      receipt: VocabPrepareRecoveryReceipt,
    ): Promise<VocabPrepareRecovery> {
      return runtime.withExclusiveLock(() =>
        recoverPrepareInContext(receipt, runtime));
    },

    async retryPrepareCleanup(
      receipt: VocabPrepareCleanupReceipt,
    ): Promise<Readonly<{ cleaned: true }>> {
      return runtime.withExclusiveLock(() =>
        retryPrepareCleanupInContext(receipt, runtime));
    },

    async activatePreparedRestore(
      receipt: VocabRestoreReceipt,
    ): Promise<VocabRestoreActivation> {
      return runtime.withExclusiveLock(() =>
        activatePreparedInContext(receipt, runtime));
    },

    /** Pure recovery read: one bound inspect call and no writes. */
    async inspectRestoreActivation(
      receipt: VocabRestoreReceipt,
    ): Promise<VocabRestoreActivationInspection> {
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
      receipt: VocabRestoreReceipt,
    ): Promise<VocabRestoreDiscard> {
      return runtime.withExclusiveLock(() =>
        discardPreparedInContext(receipt, runtime));
    },

    async restoreCompleteBackup(backup: Blob): Promise<CompleteVocabBackupRestore> {
      const source = await readCompleteSource(backup, runtime);
      return runtime.withExclusiveLock(async () => {
        const receipt = await stageSourceInContext(source, runtime);
        try {
          await activatePreparedInContext(receipt, runtime);
        } catch (error) {
          return discardAfterCompatibilityFailure(receipt, runtime, error);
        }
        return {
          audioCount: receipt.summary.audioCount,
          byteSize: receipt.summary.byteSize,
          exportedAt: receipt.summary.exportedAt!,
          previousRecoverySnapshotRetained: true,
        };
      });
    },

    async restoreLegacyDatabase(backup: Blob): Promise<LegacyVocabBackupRestore> {
      const source = await readLegacySource(backup);
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

const defaultService = createVocabBackupService();

export const isCompleteVocabBackup = defaultService.isCompleteBackup;
export const exportCompleteVocabBackup = defaultService.exportCompleteBackup;
export const prepareVocabBackupRestore = defaultService.prepareBackupRestore;
export const recoverVocabBackupPrepare = defaultService.recoverBackupPrepare;
export const retryVocabPrepareCleanup = defaultService.retryPrepareCleanup;
export const activatePreparedVocabRestore = defaultService.activatePreparedRestore;
export const inspectVocabRestoreActivation = defaultService.inspectRestoreActivation;
export const discardPreparedVocabRestore = defaultService.discardPreparedRestore;
export const restoreCompleteVocabBackup = defaultService.restoreCompleteBackup;
export const restoreLegacyVocabDatabase = defaultService.restoreLegacyDatabase;
