import { localDb } from "@/lib/local-db/client";
import {
  deleteLocalFile,
  getLocalFile,
  saveLocalFile,
  sha256Blob,
  type LocalFileMetadata,
} from "@/lib/local-db/files";
import type {
  ActivatedDatabaseGeneration,
  CurrentDatabaseGeneration,
  DatabasePrepareOperationReceipt,
  DatabasePrepareRecoveryResult,
  DatabaseRecoveryReceipt,
  SqlStatement,
  StagedDatabaseImportResult,
} from "@/lib/local-db/types";
import {
  CAREER_BACKUP_LIMITS,
  CAREER_BACKUP_MAGIC,
  CareerBackupFormatError,
  createCareerBackupBlob,
  parseCareerBackupBlob,
  type CareerBackupAttachmentMetadata,
  type CareerBackupAttachmentInput,
  type ParsedCareerBackup,
} from "./backup-format";
import {
  CAREER_SCHEMA_REQUIREMENTS,
  createCompleteCareerRestoreStatements,
  createLegacyCareerRestoreStatements,
} from "./backup-plan";
import { exportCareerDb, loadCareerData } from "./db";
import {
  broadcastCareerGenerationChanged,
  withCareerBackupLock,
  type CareerLockContext,
} from "./lock";
import type { Material } from "./types";

const DB = "career" as const;
const CANONICAL_DB = "zhiji" as const;
const SQLITE_IDENTITY_BYTE_SIZE = 72;
const sqliteHeaderBytes = new TextEncoder().encode("SQLite format 3\u0000");
const careerBackupMagicBytes = new TextEncoder().encode(CAREER_BACKUP_MAGIC);
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type CompleteCareerBackupExport = Readonly<{
  blob: Blob;
  fileName: string;
  attachmentCount: number;
  byteSize: number;
}>;

export type CompleteCareerBackupRestore = Readonly<{
  attachmentCount: number;
  byteSize: number;
  exportedAt: string;
  previousRecoverySnapshotRetained: true;
}>;

export type LegacyCareerBackupRestore = Readonly<{
  byteSize: number;
  previousRecoverySnapshotRetained: true;
}>;

/**
 * Counts which require a read-only query against the staged generation stay
 * null until local-db exposes that narrow capability. They must never be
 * substituted with counts from the currently active Career database.
 */
export type CareerRestoreSummary = Readonly<{
  kind: "complete-backup" | "legacy-career-sqlite";
  fileName: string | null;
  byteSize: number;
  databaseByteSize: number;
  exportedAt: string | null;
  sourceUserVersion: number;
  canonicalUserVersion: number;
  attachmentCount: number;
  jobCount: null;
  materialCount: null;
  verification:
    | "container-and-payload-verified"
    | "career-schema-verified";
}>;

/**
 * A JSON-safe capability receipt. The source Blob, SQL statements, attachment
 * names and attachment bytes are deliberately absent, so a refresh can resume
 * activation or cleanup without retaining the selected file in JavaScript.
 */
export type CareerRestoreReceipt = Readonly<{
  version: 1;
  database: "zhiji";
  generationId: string;
  activationToken: string;
  recoveryToken: string;
  expectedCurrentGenerationId: string;
  expectedCurrentSequence: number;
  canonicalApplicationId: number;
  canonicalUserVersion: number;
  projectionSha256: string;
  preparedAt: string;
  summary: CareerRestoreSummary;
  stagedAttachmentKeys: readonly string[];
}>;

/**
 * Serializable capability retained before the atomic database stage starts.
 * It contains no backup bytes or SQL and can therefore be stored across a
 * refresh to recover exactly this operation without staging it twice.
 */
export type CareerPrepareRecoveryReceipt = Readonly<{
  version: 1;
  database: "zhiji";
  operationId: string;
  generationId: string;
  operationToken: string;
  projectionSha256: string;
  attachmentKeysSha256: string;
  preparedAt: string;
  summary: CareerRestoreSummary;
  stagedAttachmentKeys: readonly string[];
}>;

/** Worker-bound authorization to retry deletion of only these staged files. */
export type CareerPrepareCleanupReceipt = Readonly<{
  version: 1;
  database: "zhiji";
  operationId: string;
  generationId: string;
  operationToken: string;
  projectionSha256: string;
  attachmentKeysSha256: string;
  stagedAttachmentKeys: readonly string[];
}>;

export type CareerPrepareRecovery =
  | Readonly<{ status: "ready"; receipt: CareerRestoreReceipt }>
  | Readonly<{
      status: "cleanup-pending" | "cleanup-complete";
      cleanupReceipt: CareerPrepareCleanupReceipt;
    }>
  | Readonly<{ status: "discarded" }>;

export type CareerRestoreActivation = Readonly<{
  generationId: string;
  summary: CareerRestoreSummary;
  outcome: "activated" | "already-current" | "confirmed-after-lost-response";
  previousRecoverySnapshotRetained: true;
}>;

export type CareerRestoreActivationInspection = Readonly<{
  status: "current" | "different-current";
  currentGenerationId: string;
  currentSequence: number;
}>;

export type CareerRestoreDiscard = Readonly<{
  discarded: true;
  attachmentCleanup: "complete" | "incomplete";
  failedAttachmentKeys: readonly string[];
}>;

export type CareerRestoreErrorCode =
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

export class CareerRestoreError extends Error {
  readonly cause?: unknown;

  constructor(
    message: string,
    readonly code: CareerRestoreErrorCode,
    cause?: unknown,
  ) {
    super(message);
    this.name = "CareerRestoreError";
    this.cause = cause;
  }
}

export class CareerRestoreAbortedError extends CareerRestoreError {
  constructor() {
    super("已停止核对备份，当前资料没有改变。", "PREPARE_ABORTED");
    this.name = "AbortError";
  }
}

export class CareerActivationUncertainError extends CareerRestoreError {
  constructor(
    readonly targetGenerationId: string,
    readonly receipt: CareerRestoreReceipt,
    cause?: unknown,
  ) {
    super(
      "恢复切换结果暂时无法确认。候选与核对信息均已保留；请只核对当前版本，不要重新恢复。",
      "ACTIVATION_UNCERTAIN",
      cause,
    );
    this.name = "CareerActivationUncertainError";
  }
}

export class CareerCurrentGenerationChangedError extends CareerRestoreError {
  constructor(
    readonly currentGenerationId: string,
    readonly currentSequence: number,
  ) {
    super(
      "当前职迹已在另一个页面更新或切换。这次没有覆盖它，请重新核对后再决定。",
      "CURRENT_GENERATION_CHANGED",
    );
    this.name = "CareerCurrentGenerationChangedError";
  }
}

export class CareerDiscardUncertainError extends CareerRestoreError {
  constructor(
    readonly receipt: CareerRestoreReceipt,
    cause?: unknown,
  ) {
    super(
      "候选清理结果暂时无法确认。恢复凭据已保留，请稍后只重试清理。",
      "DISCARD_UNCERTAIN",
      cause,
    );
    this.name = "CareerDiscardUncertainError";
  }
}

export class CareerPrepareUncertainError extends CareerRestoreError {
  constructor(
    readonly receipt: CareerPrepareRecoveryReceipt,
    cause?: unknown,
  ) {
    super(
      "候选建立结果暂时无法确认。操作凭据已保留；请只恢复这次准备，不要重新选择备份。",
      "PREPARE_UNCERTAIN",
      cause,
    );
    this.name = "CareerPrepareUncertainError";
  }
}

export class CareerPrepareCleanupIncompleteError extends CareerRestoreError {
  readonly failedAttachmentCount: number;

  constructor(
    readonly receipt: CareerPrepareCleanupReceipt,
    cause?: unknown,
  ) {
    super(
      `有 ${receipt.stagedAttachmentKeys.length} 个未启用的暂存附件尚未清理。当前职迹没有改变；可凭清理收据跨刷新重试。`,
      "PREPARE_CLEANUP_INCOMPLETE",
      cause,
    );
    this.name = "CareerPrepareCleanupIncompleteError";
    this.failedAttachmentCount = receipt.stagedAttachmentKeys.length;
  }

  async retryCleanup(): Promise<Readonly<{ cleaned: true }>> {
    return retryCareerPrepareCleanup(this.receipt);
  }
}

type StagedAttachment = Readonly<{
  original: CareerBackupAttachmentMetadata;
  staged: LocalFileMetadata;
}>;

type PreparedRestoreSource =
  | Readonly<{
      kind: "complete-backup";
      parsed: ParsedCareerBackup;
      database: Uint8Array;
      fileName: string | null;
      byteSize: number;
      sourceUserVersion: number;
      exportedAt: string;
    }>
  | Readonly<{
      kind: "legacy-career-sqlite";
      database: Uint8Array;
      fileName: string | null;
      byteSize: number;
      sourceUserVersion: number;
      exportedAt: null;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return value.length === 24 && !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
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
  if (signal?.aborted) throw new CareerRestoreAbortedError();
}

function assertExclusiveContext(context: CareerLockContext): void {
  if (context.mode !== "exclusive") {
    throw new CareerRestoreError(
      "恢复需要独占职迹存储锁。当前资料没有改变。",
      "PREPARE_FAILED",
    );
  }
}

function databaseBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (value && typeof value === "object" && "data" in value) {
    const data = (value as { data?: unknown }).data;
    if (data instanceof Uint8Array) return data.slice();
  }
  throw new Error("本地数据库没有返回可导出的 SQLite 字节");
}

function sqliteIdentity(database: Uint8Array): Readonly<{
  applicationId: number;
  userVersion: number;
}> {
  if (database.byteLength < SQLITE_IDENTITY_BYTE_SIZE) {
    throw new CareerRestoreError(
      "这不是可识别的职迹数据库，当前资料没有改变。",
      "UNRECOGNIZED_SQLITE",
    );
  }
  for (let index = 0; index < sqliteHeaderBytes.byteLength; index += 1) {
    if (database[index] !== sqliteHeaderBytes[index]) {
      throw new CareerRestoreError(
        "这不是可识别的职迹数据库，当前资料没有改变。",
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
  const sourceApplicationIds = CAREER_SCHEMA_REQUIREMENTS.sourceApplicationIds ?? [
    CAREER_SCHEMA_REQUIREMENTS.applicationId,
  ];
  const minimum = CAREER_SCHEMA_REQUIREMENTS.sourceMinimumUserVersion ??
    CAREER_SCHEMA_REQUIREMENTS.minimumUserVersion;
  const maximum = CAREER_SCHEMA_REQUIREMENTS.sourceMaximumUserVersion ??
    CAREER_SCHEMA_REQUIREMENTS.maximumUserVersion;
  if (
    !Number.isSafeInteger(applicationId) ||
    !sourceApplicationIds.some((supportedId) => supportedId === applicationId) ||
    !Number.isSafeInteger(userVersion) ||
    userVersion < minimum ||
    userVersion > maximum
  ) {
    throw new CareerRestoreError(
      "这份数据库不是当前支持的职迹版本，当前资料没有改变。",
      "UNSUPPORTED_SOURCE",
    );
  }
}

function attachedMaterials(materials: readonly Material[]) {
  return materials.filter((material): material is Material & { file_key: string } =>
    typeof material.file_key === "string" && material.file_key.length > 0);
}

function assertMaterialMetadata(material: Material, metadata: LocalFileMetadata) {
  if (
    material.file_key !== metadata.key ||
    material.file_name !== metadata.originalName ||
    material.mime_type !== metadata.mimeType ||
    material.byte_size !== metadata.byteSize
  ) {
    throw new Error(`材料「${material.name}」的附件索引与本地原件不一致，请重新关联后再导出`);
  }
}

function assertStagedAttachment(
  original: CareerBackupAttachmentMetadata,
  staged: LocalFileMetadata,
): void {
  if (
    staged.version !== 1 ||
    staged.namespace !== DB ||
    !UUID_V4_PATTERN.test(staged.key) ||
    staged.originalName !== original.originalName ||
    staged.mimeType !== original.mimeType ||
    staged.category !== original.category ||
    staged.byteSize !== original.byteSize ||
    staged.sha256 !== original.sha256 ||
    staged.createdAt !== original.createdAt ||
    staged.updatedAt !== original.updatedAt
  ) {
    throw new CareerRestoreError(
      `暂存附件「${original.originalName}」时校验失败，当前资料没有改变。`,
      "PREPARE_FAILED",
    );
  }
}

async function deleteAttachmentKeys(keys: readonly string[]): Promise<string[]> {
  const results = await Promise.allSettled(keys.map((key) => deleteLocalFile(DB, key)));
  return results.flatMap((result, index) => result.status === "rejected" ? [keys[index]] : []);
}

async function deleteStagedAttachments(staged: readonly StagedAttachment[]): Promise<string[]> {
  return deleteAttachmentKeys(staged.map(({ staged: metadata }) => metadata.key));
}

async function stageAttachments(
  parsed: ParsedCareerBackup,
  staged: StagedAttachment[],
  signal?: AbortSignal,
): Promise<void> {
  for (const attachment of parsed.attachments) {
    throwIfAborted(signal);
    const metadata = await saveLocalFile(DB, attachment.blob, {
      originalName: attachment.metadata.originalName,
      mimeType: attachment.metadata.mimeType,
      category: attachment.metadata.category ?? undefined,
      createdAt: attachment.metadata.createdAt,
      updatedAt: attachment.metadata.updatedAt,
    });
    staged.push({ original: attachment.metadata, staged: metadata });
    assertStagedAttachment(attachment.metadata, metadata);
    throwIfAborted(signal);
  }
}

function summaryFor(source: PreparedRestoreSource): CareerRestoreSummary {
  return {
    kind: source.kind,
    fileName: source.fileName,
    byteSize: source.byteSize,
    databaseByteSize: source.database.byteLength,
    exportedAt: source.exportedAt,
    sourceUserVersion: source.sourceUserVersion,
    canonicalUserVersion: CAREER_SCHEMA_REQUIREMENTS.maximumUserVersion,
    attachmentCount: source.kind === "complete-backup"
      ? source.parsed.attachments.length
      : 0,
    jobCount: null,
    materialCount: null,
    verification: source.kind === "complete-backup"
      ? "container-and-payload-verified"
      : "career-schema-verified",
  };
}

type CareerRestoreProjection = Readonly<{
  version: 1;
  database: "zhiji";
  preparedAt: string;
  summary: CareerRestoreSummary;
  stagedAttachmentKeys: readonly string[];
}>;

function restoreProjection(
  preparedAt: string,
  summary: CareerRestoreSummary,
  stagedAttachmentKeys: readonly string[],
): CareerRestoreProjection {
  return {
    version: 1,
    database: CANONICAL_DB,
    preparedAt,
    summary,
    stagedAttachmentKeys: [...stagedAttachmentKeys],
  };
}

async function restoreProjectionSha256(
  projection: CareerRestoreProjection,
): Promise<string> {
  return sha256Blob(new Blob([
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
        attachmentCount: projection.summary.attachmentCount,
        jobCount: projection.summary.jobCount,
        materialCount: projection.summary.materialCount,
        verification: projection.summary.verification,
      },
      stagedAttachmentKeys: projection.stagedAttachmentKeys,
    }),
  ], { type: "application/json" }));
}

async function cleanupProjectionSha256(
  operationId: string,
  stagedAttachmentKeys: readonly string[],
): Promise<string> {
  return sha256Blob(new Blob([JSON.stringify({
    version: 1,
    database: CANONICAL_DB,
    operationId,
    generationId: operationId,
    stagedAttachmentKeys,
  })], { type: "application/json" }));
}

async function attachmentKeysSha256(
  stagedAttachmentKeys: readonly string[],
): Promise<string> {
  return sha256Blob(new Blob([
    JSON.stringify({ version: 1, stagedAttachmentKeys }),
  ], { type: "application/json" }));
}

function newPrepareOperationCapability(): Readonly<{
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
    throw new CareerRestoreError(
      "浏览器无法建立安全的恢复操作凭据。当前资料没有改变。",
      "PREPARE_FAILED",
    );
  }
  return { operationId, operationToken };
}

function databasePrepareReceiptFor(
  receipt: CareerPrepareRecoveryReceipt | CareerPrepareCleanupReceipt,
): DatabasePrepareOperationReceipt<"zhiji"> {
  return {
    version: 1,
    database: CANONICAL_DB,
    operationId: receipt.operationId,
    generationId: receipt.generationId,
    operationToken: receipt.operationToken,
    projectionSha256: receipt.projectionSha256,
    attachmentKeysSha256: receipt.attachmentKeysSha256,
    stagedAttachmentKeys: [...receipt.stagedAttachmentKeys],
  };
}

async function cleanupReceiptFor(
  keys: readonly string[],
): Promise<CareerPrepareCleanupReceipt> {
  const capability = newPrepareOperationCapability();
  return {
    version: 1,
    database: CANONICAL_DB,
    operationId: capability.operationId,
    generationId: capability.operationId,
    operationToken: capability.operationToken,
    projectionSha256: await cleanupProjectionSha256(
      capability.operationId,
      keys,
    ),
    attachmentKeysSha256: await attachmentKeysSha256(keys),
    stagedAttachmentKeys: [...keys],
  };
}

function prepareRecoveryReceiptFor(
  projection: CareerRestoreProjection,
  projectionSha256: string,
  attachmentDigest: string,
  capability: Readonly<{ operationId: string; operationToken: string }>,
): CareerPrepareRecoveryReceipt {
  return {
    version: 1,
    database: CANONICAL_DB,
    operationId: capability.operationId,
    generationId: capability.operationId,
    operationToken: capability.operationToken,
    projectionSha256,
    attachmentKeysSha256: attachmentDigest,
    preparedAt: projection.preparedAt,
    summary: projection.summary,
    stagedAttachmentKeys: [...projection.stagedAttachmentKeys],
  };
}

function parseStagedRecoveryReceipt(
  value: unknown,
  generationId: string,
  projectionSha256: string,
): DatabaseRecoveryReceipt<"zhiji"> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version", "database", "generationId", "recoveryToken",
      "expectedCurrentGenerationId", "expectedCurrentSequence",
      "canonicalApplicationId", "canonicalUserVersion", "projectionSha256",
    ]) ||
    value.version !== 1 ||
    value.database !== CANONICAL_DB ||
    value.generationId !== generationId ||
    typeof value.recoveryToken !== "string" ||
    !SHA256_PATTERN.test(value.recoveryToken) ||
    typeof value.expectedCurrentGenerationId !== "string" ||
    !(value.expectedCurrentGenerationId === "legacy" ||
      UUID_V4_PATTERN.test(value.expectedCurrentGenerationId)) ||
    typeof value.expectedCurrentSequence !== "number" ||
    !Number.isSafeInteger(value.expectedCurrentSequence) ||
    value.expectedCurrentSequence < 0 ||
    (value.expectedCurrentGenerationId === "legacy" &&
      value.expectedCurrentSequence !== 0) ||
    value.canonicalApplicationId !== CAREER_SCHEMA_REQUIREMENTS.applicationId ||
    value.canonicalUserVersion !== CAREER_SCHEMA_REQUIREMENTS.maximumUserVersion ||
    value.projectionSha256 !== projectionSha256
  ) {
    throw new CareerRestoreError(
      "候选数据库返回了无效的恢复凭据，当前资料没有改变。",
      "PREPARE_FAILED",
    );
  }
  return {
    version: 1,
    database: CANONICAL_DB,
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
  recovery: DatabaseRecoveryReceipt,
  projection: CareerRestoreProjection,
  projectionSha256: string,
): CareerRestoreReceipt {
  return {
    version: 1,
    database: CANONICAL_DB,
    generationId: staged.generationId,
    activationToken: staged.activationToken,
    recoveryToken: recovery.recoveryToken,
    expectedCurrentGenerationId: recovery.expectedCurrentGenerationId,
    expectedCurrentSequence: recovery.expectedCurrentSequence,
    canonicalApplicationId: recovery.canonicalApplicationId,
    canonicalUserVersion: recovery.canonicalUserVersion,
    projectionSha256,
    preparedAt: projection.preparedAt,
    summary: projection.summary,
    stagedAttachmentKeys: [...projection.stagedAttachmentKeys],
  };
}

function parseRestoreSummary(value: unknown): CareerRestoreSummary {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "kind", "fileName", "byteSize", "databaseByteSize", "exportedAt",
      "sourceUserVersion", "canonicalUserVersion", "attachmentCount",
      "jobCount", "materialCount", "verification",
    ]) ||
    (value.kind !== "complete-backup" && value.kind !== "legacy-career-sqlite") ||
    !(value.fileName === null || (
      typeof value.fileName === "string" && value.fileName.length > 0 && value.fileName.length <= 255
    )) ||
    typeof value.byteSize !== "number" || !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 0 || value.byteSize > CAREER_BACKUP_LIMITS.totalBytes ||
    typeof value.databaseByteSize !== "number" || !Number.isSafeInteger(value.databaseByteSize) ||
    value.databaseByteSize < SQLITE_IDENTITY_BYTE_SIZE ||
    value.databaseByteSize > CAREER_BACKUP_LIMITS.databaseBytes ||
    !(value.exportedAt === null || (
      typeof value.exportedAt === "string" && isCanonicalIsoTimestamp(value.exportedAt)
    )) ||
    typeof value.sourceUserVersion !== "number" || !Number.isSafeInteger(value.sourceUserVersion) ||
    value.sourceUserVersion < 0 || value.sourceUserVersion > CAREER_SCHEMA_REQUIREMENTS.maximumUserVersion ||
    typeof value.canonicalUserVersion !== "number" || !Number.isSafeInteger(value.canonicalUserVersion) ||
    value.canonicalUserVersion !== CAREER_SCHEMA_REQUIREMENTS.maximumUserVersion ||
    typeof value.attachmentCount !== "number" || !Number.isSafeInteger(value.attachmentCount) ||
    value.attachmentCount < 0 || value.attachmentCount > CAREER_BACKUP_LIMITS.attachmentCount ||
    value.jobCount !== null || value.materialCount !== null ||
    (value.verification !== "container-and-payload-verified" && value.verification !== "career-schema-verified") ||
    (value.kind === "complete-backup" && (
      value.exportedAt === null || value.verification !== "container-and-payload-verified"
    )) ||
    (value.kind === "legacy-career-sqlite" && (
      value.exportedAt !== null || value.attachmentCount !== 0 ||
      value.verification !== "career-schema-verified"
    ))
  ) {
    throw new CareerRestoreError(
      "恢复核对信息无效。为保护当前资料，没有继续操作。",
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
    canonicalUserVersion: value.canonicalUserVersion,
    attachmentCount: value.attachmentCount,
    jobCount: null,
    materialCount: null,
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
  attachmentKeysSha256: string;
  stagedAttachmentKeys: readonly string[];
}> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, expectedKeys) ||
    value.version !== 1 ||
    value.database !== CANONICAL_DB ||
    typeof value.operationId !== "string" ||
    !UUID_V4_PATTERN.test(value.operationId) ||
    value.generationId !== value.operationId ||
    typeof value.operationToken !== "string" ||
    !SHA256_PATTERN.test(value.operationToken) ||
    typeof value.projectionSha256 !== "string" ||
    !SHA256_PATTERN.test(value.projectionSha256) ||
    typeof value.attachmentKeysSha256 !== "string" ||
    !SHA256_PATTERN.test(value.attachmentKeysSha256) ||
    !Array.isArray(value.stagedAttachmentKeys) ||
    value.stagedAttachmentKeys.length > CAREER_BACKUP_LIMITS.attachmentCount ||
    value.stagedAttachmentKeys.some((key) =>
      typeof key !== "string" || !UUID_V4_PATTERN.test(key)) ||
    new Set(value.stagedAttachmentKeys).size !== value.stagedAttachmentKeys.length
  ) {
    throw new CareerRestoreError(
      "恢复准备凭据无效。为保护当前资料，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  return {
    operationId: value.operationId,
    generationId: value.operationId,
    operationToken: value.operationToken,
    projectionSha256: value.projectionSha256,
    attachmentKeysSha256: value.attachmentKeysSha256,
    stagedAttachmentKeys: [...value.stagedAttachmentKeys] as string[],
  };
}

async function verifyPrepareRecoveryReceipt(
  value: unknown,
): Promise<CareerPrepareRecoveryReceipt> {
  const core = parsePrepareReceiptCore(value, [
    "version", "database", "operationId", "generationId", "operationToken",
    "projectionSha256", "attachmentKeysSha256", "preparedAt", "summary",
    "stagedAttachmentKeys",
  ]);
  if (
    !isRecord(value) ||
    typeof value.preparedAt !== "string" ||
    !isCanonicalIsoTimestamp(value.preparedAt)
  ) {
    throw new CareerRestoreError(
      "恢复准备凭据无效。为保护当前资料，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  const summary = parseRestoreSummary(value.summary);
  if (summary.attachmentCount !== core.stagedAttachmentKeys.length) {
    throw new CareerRestoreError(
      "恢复准备凭据彼此不一致。为保护当前资料，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  const receipt: CareerPrepareRecoveryReceipt = {
    version: 1,
    database: CANONICAL_DB,
    ...core,
    preparedAt: value.preparedAt,
    summary,
  };
  const projectionDigest = await restoreProjectionSha256(restoreProjection(
    receipt.preparedAt,
    receipt.summary,
    receipt.stagedAttachmentKeys,
  ));
  if (projectionDigest !== receipt.projectionSha256) {
    throw new CareerRestoreError(
      "恢复准备凭据与暂存内容不一致。为保护当前资料，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  if (
    await attachmentKeysSha256(receipt.stagedAttachmentKeys) !==
      receipt.attachmentKeysSha256
  ) {
    throw new CareerRestoreError(
      "恢复准备凭据的附件范围不一致。为保护当前资料，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  return receipt;
}

async function verifyPrepareCleanupReceipt(
  value: unknown,
): Promise<CareerPrepareCleanupReceipt> {
  const core = parsePrepareReceiptCore(value, [
    "version", "database", "operationId", "generationId", "operationToken",
    "projectionSha256", "attachmentKeysSha256", "stagedAttachmentKeys",
  ]);
  const receipt: CareerPrepareCleanupReceipt = {
    version: 1,
    database: CANONICAL_DB,
    ...core,
  };
  if (
    await attachmentKeysSha256(receipt.stagedAttachmentKeys) !==
      receipt.attachmentKeysSha256
  ) {
    throw new CareerRestoreError(
      "暂存清理凭据与附件范围不一致。没有删除任何附件。",
      "INVALID_RECEIPT",
    );
  }
  return receipt;
}

function parseRestoreReceipt(value: unknown): CareerRestoreReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version", "database", "generationId", "activationToken", "recoveryToken",
      "expectedCurrentGenerationId", "expectedCurrentSequence",
      "canonicalApplicationId", "canonicalUserVersion", "projectionSha256",
      "preparedAt", "summary", "stagedAttachmentKeys",
    ]) ||
    value.version !== 1 ||
    value.database !== CANONICAL_DB ||
    typeof value.generationId !== "string" || !UUID_V4_PATTERN.test(value.generationId) ||
    typeof value.activationToken !== "string" || !SHA256_PATTERN.test(value.activationToken) ||
    typeof value.recoveryToken !== "string" || !SHA256_PATTERN.test(value.recoveryToken) ||
    typeof value.expectedCurrentGenerationId !== "string" ||
    !(value.expectedCurrentGenerationId === "legacy" || UUID_V4_PATTERN.test(value.expectedCurrentGenerationId)) ||
    typeof value.expectedCurrentSequence !== "number" || !Number.isSafeInteger(value.expectedCurrentSequence) ||
    value.expectedCurrentSequence < 0 ||
    value.canonicalApplicationId !== CAREER_SCHEMA_REQUIREMENTS.applicationId ||
    value.canonicalUserVersion !== CAREER_SCHEMA_REQUIREMENTS.maximumUserVersion ||
    typeof value.projectionSha256 !== "string" ||
    !SHA256_PATTERN.test(value.projectionSha256) ||
    typeof value.preparedAt !== "string" || !isCanonicalIsoTimestamp(value.preparedAt) ||
    !Array.isArray(value.stagedAttachmentKeys) ||
    value.stagedAttachmentKeys.length > CAREER_BACKUP_LIMITS.attachmentCount ||
    value.stagedAttachmentKeys.some((key) => typeof key !== "string" || !UUID_V4_PATTERN.test(key)) ||
    new Set(value.stagedAttachmentKeys).size !== value.stagedAttachmentKeys.length
  ) {
    throw new CareerRestoreError(
      "恢复核对信息无效。为保护当前资料，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  const summary = parseRestoreSummary(value.summary);
  if (
    summary.attachmentCount !== value.stagedAttachmentKeys.length ||
    summary.canonicalUserVersion !== value.canonicalUserVersion ||
    (value.expectedCurrentGenerationId === "legacy" && value.expectedCurrentSequence !== 0)
  ) {
    throw new CareerRestoreError(
      "恢复核对信息彼此不一致。为保护当前资料，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  return {
    version: 1,
    database: CANONICAL_DB,
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
    stagedAttachmentKeys: [...value.stagedAttachmentKeys] as string[],
  };
}

async function verifyRestoreReceipt(value: unknown): Promise<CareerRestoreReceipt> {
  const receipt = parseRestoreReceipt(value);
  const digest = await restoreProjectionSha256(restoreProjection(
    receipt.preparedAt,
    receipt.summary,
    receipt.stagedAttachmentKeys,
  ));
  if (digest !== receipt.projectionSha256) {
    throw new CareerRestoreError(
      "恢复核对信息与候选版本不一致。为保护当前资料，没有继续操作。",
      "INVALID_RECEIPT",
    );
  }
  return receipt;
}

function databaseRecoveryReceiptFor(
  receipt: CareerRestoreReceipt,
): DatabaseRecoveryReceipt<"zhiji"> {
  return {
    version: 1,
    database: CANONICAL_DB,
    generationId: receipt.generationId,
    recoveryToken: receipt.recoveryToken,
    expectedCurrentGenerationId: receipt.expectedCurrentGenerationId,
    expectedCurrentSequence: receipt.expectedCurrentSequence,
    canonicalApplicationId: receipt.canonicalApplicationId,
    canonicalUserVersion: receipt.canonicalUserVersion,
    projectionSha256: receipt.projectionSha256,
  };
}

function isCurrentTarget(current: CurrentDatabaseGeneration, receipt: CareerRestoreReceipt): boolean {
  return current.database === CANONICAL_DB && current.generationId === receipt.generationId;
}

function isExpectedCurrent(current: CurrentDatabaseGeneration, receipt: CareerRestoreReceipt): boolean {
  return current.database === CANONICAL_DB &&
    current.generationId === receipt.expectedCurrentGenerationId &&
    current.sequence === receipt.expectedCurrentSequence;
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

function parseCurrentGeneration(value: unknown): CurrentDatabaseGeneration<"zhiji"> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "database", "generationId", "filename", "sequence", "legacy",
    ]) ||
    value.database !== CANONICAL_DB ||
    typeof value.generationId !== "string" ||
    !(value.generationId === "legacy" || UUID_V4_PATTERN.test(value.generationId)) ||
    typeof value.filename !== "string" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    typeof value.legacy !== "boolean" ||
    (value.generationId === "legacy"
      ? value.filename !== "zhiji.sqlite3" || value.sequence !== 0 || value.legacy !== true
      : value.filename !== `zhiji.${value.generationId}.sqlite3` || value.legacy !== false)
  ) {
    throw new Error("Invalid current Career database generation response.");
  }
  return {
    database: CANONICAL_DB,
    generationId: value.generationId,
    filename: value.filename as `${string}.sqlite3`,
    sequence: value.sequence,
    legacy: value.legacy,
  };
}

function parseActivatedGeneration(
  value: unknown,
  receipt: CareerRestoreReceipt,
): ActivatedDatabaseGeneration<"zhiji"> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "database", "filename", "persistent", "sqliteVersion", "schemaVersion",
      "seeded", "generationId", "sequence",
    ]) ||
    value.database !== CANONICAL_DB ||
    value.filename !== `${CANONICAL_DB}.${receipt.generationId}.sqlite3` ||
    value.persistent !== true ||
    typeof value.sqliteVersion !== "string" || value.sqliteVersion.length === 0 ||
    value.schemaVersion !== receipt.canonicalUserVersion ||
    value.seeded !== false ||
    value.generationId !== receipt.generationId ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) || value.sequence < 1
  ) {
    throw new Error("Invalid staged Career activation response.");
  }
  return {
    database: CANONICAL_DB,
    filename: value.filename as `zhiji.${string}.sqlite3`,
    persistent: true,
    sqliteVersion: value.sqliteVersion,
    schemaVersion: value.schemaVersion,
    seeded: false,
    generationId: receipt.generationId,
    sequence: value.sequence,
  };
}

async function currentGenerationFor(message: string): Promise<CurrentDatabaseGeneration> {
  try {
    return parseCurrentGeneration(await localDb.currentGeneration(DB));
  } catch (error) {
    throw new CareerRestoreError(message, "CURRENT_GENERATION_UNAVAILABLE", error);
  }
}

async function inspectBoundCurrentGeneration(
  receipt: CareerRestoreReceipt,
): Promise<CurrentDatabaseGeneration> {
  try {
    return parseCurrentGeneration(await localDb.inspectStaged(
      DB,
      receipt.generationId,
      receipt.activationToken,
      databaseRecoveryReceiptFor(receipt),
    ));
  } catch (error) {
    if (recoveryCredentialErrorCode(error)) {
      throw new CareerRestoreError(
        "恢复凭据与已核对的候选版本不一致。没有更改当前资料。",
        "INVALID_RECEIPT",
        error,
      );
    }
    throw new CareerRestoreError(
      "暂时无法核对当前职迹版本。候选与恢复信息都已保留。",
      "CURRENT_GENERATION_UNAVAILABLE",
      error,
    );
  }
}

function broadcastKnownActivation(generationId: string): void {
  try {
    broadcastCareerGenerationChanged(generationId);
  } catch {
    // The durable pointer is already authoritative. Cross-tab notification is
    // best effort and must never turn success into a retryable restore.
  }
}

async function discardStagedCandidate(receipt: CareerRestoreReceipt): Promise<void> {
  let result: unknown;
  try {
    result = await localDb.discardStaged(
      DB,
      receipt.generationId,
      receipt.activationToken,
      databaseRecoveryReceiptFor(receipt),
    );
  } catch (error) {
    throw new CareerRestoreError(
      "候选状态暂时无法确认，因此没有清理任何暂存附件。",
      "DISCARD_UNCERTAIN",
      error,
    );
  }
  if (!isRecord(result) || result.database !== CANONICAL_DB ||
      result.generationId !== receipt.generationId || result.discarded !== true) {
    throw new CareerRestoreError(
      "候选没有返回明确的清理结果，因此没有清理任何暂存附件。",
      "DISCARD_UNCERTAIN",
    );
  }
}

async function discardPreparedInContext(
  rawReceipt: CareerRestoreReceipt,
  context: CareerLockContext,
): Promise<CareerRestoreDiscard> {
  assertExclusiveContext(context);
  const receipt = await verifyRestoreReceipt(rawReceipt);
  await discardStagedCandidate(receipt);
  const failedAttachmentKeys = await deleteAttachmentKeys(receipt.stagedAttachmentKeys);
  return {
    discarded: true,
    attachmentCleanup: failedAttachmentKeys.length === 0 ? "complete" : "incomplete",
    failedAttachmentKeys,
  };
}

async function stageSourceInContext(
  source: PreparedRestoreSource,
  context: CareerLockContext,
  signal?: AbortSignal,
): Promise<CareerRestoreReceipt> {
  assertExclusiveContext(context);
  throwIfAborted(signal);

  const stagedAttachments: StagedAttachment[] = [];
  let stagedDatabase: StagedDatabaseImportResult | null = null;
  let preparedReceipt: CareerRestoreReceipt | null = null;
  let prepareRecoveryReceipt: CareerPrepareRecoveryReceipt | null = null;
  let atomicStageStarted = false;
  try {
    if (source.kind === "complete-backup") {
      await stageAttachments(source.parsed, stagedAttachments, signal);
    }
    throwIfAborted(signal);
    const statements: readonly SqlStatement[] = source.kind === "complete-backup"
      ? createCompleteCareerRestoreStatements(stagedAttachments, source.sourceUserVersion)
      : createLegacyCareerRestoreStatements(source.sourceUserVersion);
    throwIfAborted(signal);

    const projection = restoreProjection(
      new Date().toISOString(),
      summaryFor(source),
      stagedAttachments.map(({ staged: metadata }) => metadata.key),
    );
    const projectionSha256 = await restoreProjectionSha256(projection);
    const attachmentDigest = await attachmentKeysSha256(
      projection.stagedAttachmentKeys,
    );
    prepareRecoveryReceipt = prepareRecoveryReceiptFor(
      projection,
      projectionSha256,
      attachmentDigest,
      newPrepareOperationCapability(),
    );
    throwIfAborted(signal);

    // Once atomic worker staging starts, a late AbortSignal is ignored. A
    // returned receipt is safer than an unreachable READY candidate.
    atomicStageStarted = true;
    stagedDatabase = await localDb.stageImport(
      DB,
      source.database,
      statements,
      CAREER_SCHEMA_REQUIREMENTS,
      {
        recovery: {
          projectionSha256,
          prepareOperation: databasePrepareReceiptFor(prepareRecoveryReceipt),
        },
      },
    );
    if (
      stagedDatabase.database !== CANONICAL_DB ||
      stagedDatabase.generationId !== prepareRecoveryReceipt.operationId ||
      !UUID_V4_PATTERN.test(stagedDatabase.generationId) ||
      !SHA256_PATTERN.test(stagedDatabase.activationToken) ||
      stagedDatabase.filename !==
        `${CANONICAL_DB}.${stagedDatabase.generationId}.sqlite3`
    ) {
      throw new CareerRestoreError(
        "候选数据库返回了无效的核对信息，当前资料没有改变。",
        "PREPARE_FAILED",
      );
    }
    const recovery = parseStagedRecoveryReceipt(
      stagedDatabase.recoveryReceipt,
      stagedDatabase.generationId,
      projectionSha256,
    );
    preparedReceipt = receiptFor(
      stagedDatabase,
      recovery,
      projection,
      projectionSha256,
    );
    if (
      stagedDatabase.importedBytes !== source.database.byteLength ||
      !Number.isSafeInteger(stagedDatabase.schemaVersion) ||
      stagedDatabase.schemaVersion !== CAREER_SCHEMA_REQUIREMENTS.maximumUserVersion
    ) {
      throw new CareerRestoreError(
        "候选数据库返回了无效的核对信息，当前资料没有改变。",
        "PREPARE_FAILED",
      );
    }
    return preparedReceipt;
  } catch (error) {
    if (preparedReceipt) {
      try {
        await discardStagedCandidate(preparedReceipt);
      } catch (discardError) {
        throw new CareerDiscardUncertainError(
          preparedReceipt,
          { prepareError: error, discardError },
        );
      }
    }
    if (atomicStageStarted && !preparedReceipt && prepareRecoveryReceipt) {
      throw new CareerPrepareUncertainError(prepareRecoveryReceipt, error);
    }
    const failed = await deleteStagedAttachments(stagedAttachments);
    if (failed.length > 0) {
      const cleanupReceipt = await cleanupReceiptFor(failed);
      try {
        const bound = await localDb.registerPrepareCleanup(
          DB,
          databasePrepareReceiptFor(cleanupReceipt),
        );
        if (
          !isRecord(bound) ||
          bound.database !== CANONICAL_DB ||
          bound.operationId !== cleanupReceipt.operationId ||
          (bound.status !== "cleanup-pending" &&
            bound.status !== "cleanup-complete") ||
          !Array.isArray(bound.stagedAttachmentKeys) ||
          bound.stagedAttachmentKeys.length !== failed.length ||
          bound.stagedAttachmentKeys.some(
            (key, index) => key !== failed[index],
          )
        ) {
          throw new Error("Invalid prepare cleanup binding response.");
        }
      } catch (bindingError) {
        throw new CareerPrepareCleanupIncompleteError(
          cleanupReceipt,
          { prepareError: error, bindingError },
        );
      }
      throw new CareerPrepareCleanupIncompleteError(cleanupReceipt, error);
    }
    if (error instanceof CareerRestoreError || error instanceof CareerBackupFormatError) throw error;
    throw new CareerRestoreError(
      "未能建立安全的恢复候选，当前资料没有改变。",
      "PREPARE_FAILED",
      error,
    );
  }
}

function cleanupReceiptFromPrepare(
  receipt: CareerPrepareRecoveryReceipt,
): CareerPrepareCleanupReceipt {
  return {
    version: 1,
    database: CANONICAL_DB,
    operationId: receipt.operationId,
    generationId: receipt.generationId,
    operationToken: receipt.operationToken,
    projectionSha256: receipt.projectionSha256,
    attachmentKeysSha256: receipt.attachmentKeysSha256,
    stagedAttachmentKeys: [...receipt.stagedAttachmentKeys],
  };
}

function assertPrepareCleanupResult(
  value: unknown,
  receipt: CareerPrepareCleanupReceipt,
): Extract<DatabasePrepareRecoveryResult, {
  status: "cleanup-pending" | "cleanup-complete";
}> {
  if (
    !isRecord(value) ||
    value.database !== CANONICAL_DB ||
    value.operationId !== receipt.operationId ||
    (value.status !== "cleanup-pending" &&
      value.status !== "cleanup-complete") ||
    !Array.isArray(value.stagedAttachmentKeys) ||
    value.stagedAttachmentKeys.length !== receipt.stagedAttachmentKeys.length ||
    value.stagedAttachmentKeys.some(
      (key, index) => key !== receipt.stagedAttachmentKeys[index],
    )
  ) {
    throw new CareerRestoreError(
      "暂存清理授权无法核对。没有删除任何附件。",
      "INVALID_RECEIPT",
    );
  }
  return value as Extract<DatabasePrepareRecoveryResult, {
    status: "cleanup-pending" | "cleanup-complete";
  }>;
}

async function recoverPrepareInContext(
  rawReceipt: CareerPrepareRecoveryReceipt,
  context: CareerLockContext,
): Promise<CareerPrepareRecovery> {
  assertExclusiveContext(context);
  const receipt = await verifyPrepareRecoveryReceipt(rawReceipt);
  let result: DatabasePrepareRecoveryResult;
  try {
    result = await localDb.recoverPrepare(
      DB,
      databasePrepareReceiptFor(receipt),
    );
  } catch (error) {
    if (!isRecord(error) || error.code !== "PREPARE_OPERATION_NOT_FOUND") {
      throw new CareerRestoreError(
        "暂时无法核对这次恢复准备。操作凭据已保留，请不要重新选择备份。",
        "PREPARE_UNCERTAIN",
        error,
      );
    }
    // Input validation can fail before the worker creates its operation
    // tombstone. Registration checks every generation artifact before it can
    // authorize attachment cleanup, so an in-flight/READY candidate fails
    // closed here.
    try {
      result = await localDb.registerPrepareCleanup(
        DB,
        databasePrepareReceiptFor(receipt),
      );
    } catch (registrationError) {
      throw new CareerRestoreError(
        "暂时无法确认这次准备是否可以安全清理。操作凭据已保留，没有删除任何附件。",
        "PREPARE_UNCERTAIN",
        registrationError,
      );
    }
  }

  if (result.status === "ready") {
    const staged = result.staged;
    if (
      result.database !== CANONICAL_DB ||
      result.operationId !== receipt.operationId ||
      staged.database !== CANONICAL_DB ||
      staged.generationId !== receipt.generationId ||
      staged.filename !== `${CANONICAL_DB}.${receipt.generationId}.sqlite3` ||
      !SHA256_PATTERN.test(staged.activationToken) ||
      staged.importedBytes !== receipt.summary.databaseByteSize ||
      staged.schemaVersion !== CAREER_SCHEMA_REQUIREMENTS.maximumUserVersion
    ) {
      throw new CareerRestoreError(
        "恢复准备结果与操作凭据不一致。当前资料没有改变。",
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
          receipt.stagedAttachmentKeys,
        ),
        receipt.projectionSha256,
      ),
    };
  }
  if (result.status === "discarded") {
    if (
      result.database !== CANONICAL_DB ||
      result.operationId !== receipt.operationId
    ) {
      throw new CareerRestoreError(
        "恢复准备结果与操作凭据不一致。当前资料没有改变。",
        "INVALID_RECEIPT",
      );
    }
    return { status: "discarded" };
  }
  const cleanupReceipt = cleanupReceiptFromPrepare(receipt);
  const cleanup = assertPrepareCleanupResult(result, cleanupReceipt);
  return { status: cleanup.status, cleanupReceipt };
}

async function activatePreparedInContext(
  rawReceipt: CareerRestoreReceipt,
  context: CareerLockContext,
): Promise<CareerRestoreActivation> {
  assertExclusiveContext(context);
  const receipt = await verifyRestoreReceipt(rawReceipt);
  const current = await currentGenerationFor(
    "暂时无法读取当前职迹版本，因此没有执行恢复切换。",
  );

  const wasAlreadyCurrent = isCurrentTarget(current, receipt);
  if (wasAlreadyCurrent) {
    const inspected = await inspectBoundCurrentGeneration(receipt);
    if (!isCurrentTarget(inspected, receipt)) {
      throw new CareerCurrentGenerationChangedError(
        inspected.generationId,
        inspected.sequence,
      );
    }
    broadcastKnownActivation(receipt.generationId);
    return {
      generationId: receipt.generationId,
      summary: receipt.summary,
      outcome: "already-current",
      previousRecoverySnapshotRetained: true,
    };
  }
  if (!isExpectedCurrent(current, receipt)) {
    throw new CareerCurrentGenerationChangedError(current.generationId, current.sequence);
  }

  try {
    parseActivatedGeneration(
      await localDb.activateStaged(
        DB,
        receipt.generationId,
        receipt.activationToken,
        databaseRecoveryReceiptFor(receipt),
      ),
      receipt,
    );
  } catch (activationError) {
    if (recoveryCredentialErrorCode(activationError)) {
      throw new CareerRestoreError(
        "恢复凭据与已核对的候选版本不一致。没有更改当前资料。",
        "INVALID_RECEIPT",
        activationError,
      );
    }
    let observed: CurrentDatabaseGeneration;
    try {
      observed = await currentGenerationFor(
        "暂时无法核对恢复切换后的当前职迹版本。",
      );
    } catch (inspectionError) {
      throw new CareerActivationUncertainError(
        receipt.generationId,
        receipt,
        { activationError, inspectionError },
      );
    }
    if (isCurrentTarget(observed, receipt)) {
      broadcastKnownActivation(receipt.generationId);
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
      throw new CareerCurrentGenerationChangedError(
        observed.generationId,
        observed.sequence,
      );
    }
    if (!isExpectedCurrent(observed, receipt)) {
      throw new CareerCurrentGenerationChangedError(observed.generationId, observed.sequence);
    }
    throw new CareerRestoreError(
      "恢复候选没有成为当前版本，当前职迹保持不变。",
      "ACTIVATION_FAILED",
      activationError,
    );
  }

  broadcastKnownActivation(receipt.generationId);
  return {
    generationId: receipt.generationId,
    summary: receipt.summary,
    outcome: "activated",
    previousRecoverySnapshotRetained: true,
  };
}

async function readCompleteSource(
  backup: Blob,
  signal?: AbortSignal,
): Promise<PreparedRestoreSource> {
  throwIfAborted(signal);
  const parsed = await parseCareerBackupBlob(backup, sha256Blob);
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
  if (backup.size > CAREER_BACKUP_LIMITS.databaseBytes) {
    throw new CareerRestoreError(
      "所选文件超过旧版职迹数据库的安全处理上限，当前资料没有改变。",
      "LEGACY_BACKUP_TOO_LARGE",
    );
  }
  throwIfAborted(signal);
  const database = new Uint8Array(await backup.arrayBuffer());
  throwIfAborted(signal);
  const identity = sqliteIdentity(database);
  assertSupportedSourceIdentity(identity.applicationId, identity.userVersion);
  return {
    kind: "legacy-career-sqlite",
    database,
    fileName: safeFileName(backup),
    byteSize: backup.size,
    sourceUserVersion: identity.userVersion,
    exportedAt: null,
  };
}

async function readAutoDetectedSource(
  backup: Blob,
  signal?: AbortSignal,
): Promise<PreparedRestoreSource> {
  throwIfAborted(signal);
  const complete = await isCompleteCareerBackup(backup);
  throwIfAborted(signal);
  return complete ? readCompleteSource(backup, signal) : readLegacySource(backup, signal);
}

async function discardAfterLegacyApiFailure(
  receipt: CareerRestoreReceipt,
  context: CareerLockContext,
  error: unknown,
): Promise<never> {
  if (!(error instanceof CareerActivationUncertainError)) {
    try {
      await discardPreparedInContext(receipt, context);
    } catch (discardError) {
      throw new CareerDiscardUncertainError(
        receipt,
        { activationError: error, discardError },
      );
    }
  }
  throw error;
}

export async function isCompleteCareerBackup(blob: Blob): Promise<boolean> {
  if (!(blob instanceof Blob) || blob.size < careerBackupMagicBytes.byteLength) return false;
  const prefix = new Uint8Array(
    await blob.slice(0, careerBackupMagicBytes.byteLength).arrayBuffer(),
  );
  return prefix.every((byte, index) => byte === careerBackupMagicBytes[index]);
}

export async function exportCompleteCareerBackup(): Promise<CompleteCareerBackupExport> {
  return withCareerBackupLock(async (context) => {
    const data = await loadCareerData(context);
    const exportedDatabase = databaseBytes(await exportCareerDb(context));
    const materials = attachedMaterials(data.materials);
    const byKey = new Map<string, CareerBackupAttachmentInput>();
    for (const material of materials) {
      const stored = await getLocalFile(DB, material.file_key);
      assertMaterialMetadata(material, stored.metadata);
      byKey.set(material.file_key, { metadata: stored.metadata, blob: stored.file });
    }
    const attachments = [...byKey.values()].sort((left, right) =>
      left.metadata.key.localeCompare(right.metadata.key));
    const blob = await createCareerBackupBlob(
      { database: exportedDatabase, attachments },
      sha256Blob,
    );
    return {
      blob,
      fileName: `zhiji-complete-${new Date().toISOString().slice(0, 10)}.career-backup`,
      attachmentCount: attachments.length,
      byteSize: blob.size,
    };
  });
}

/** Validate and migrate into an isolated READY generation without activation. */
export async function prepareCareerBackupRestore(
  backup: Blob,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<CareerRestoreReceipt> {
  if (!(backup instanceof Blob)) {
    throw new CareerRestoreError("请选择一个可以读取的职迹备份文件。", "PREPARE_FAILED");
  }
  const source = await readAutoDetectedSource(backup, options.signal);
  return withCareerBackupLock((context) =>
    stageSourceInContext(source, context, options.signal));
}

/**
 * Recover a prepare whose worker response was lost. This never resubmits the
 * backup bytes and never activates a candidate.
 */
export async function recoverCareerBackupPrepare(
  receipt: CareerPrepareRecoveryReceipt,
): Promise<CareerPrepareRecovery> {
  return withCareerBackupLock((context) =>
    recoverPrepareInContext(receipt, context));
}

/**
 * Delete only the attachment keys authorized by a durable worker tombstone.
 * Repeating this after a lost response is idempotent.
 */
export async function retryCareerPrepareCleanup(
  rawReceipt: CareerPrepareCleanupReceipt,
): Promise<Readonly<{ cleaned: true }>> {
  return withCareerBackupLock(async (context) => {
    assertExclusiveContext(context);
    const receipt = await verifyPrepareCleanupReceipt(rawReceipt);
    let rawState: unknown;
    try {
      rawState = await localDb.recoverPrepare(
        DB,
        databasePrepareReceiptFor(receipt),
      );
    } catch (error) {
      if (!isRecord(error) || error.code !== "PREPARE_OPERATION_NOT_FOUND") {
        throw new CareerPrepareCleanupIncompleteError(receipt, error);
      }
      try {
        rawState = await localDb.registerPrepareCleanup(
          DB,
          databasePrepareReceiptFor(receipt),
        );
      } catch (registrationError) {
        throw new CareerPrepareCleanupIncompleteError(
          receipt,
          registrationError,
        );
      }
    }
    const state = assertPrepareCleanupResult(rawState, receipt);
    if (state.status === "cleanup-complete") return { cleaned: true };

    const failed = await deleteAttachmentKeys(state.stagedAttachmentKeys);
    if (failed.length > 0) {
      throw new CareerPrepareCleanupIncompleteError(receipt, { failed });
    }
    let completed: unknown;
    try {
      completed = await localDb.completePrepareCleanup(
        DB,
        databasePrepareReceiptFor(receipt),
      );
    } catch (error) {
      // The deletes are idempotent. Keeping the pending receipt lets the next
      // retry prove completion instead of expanding the deletion scope.
      throw new CareerPrepareCleanupIncompleteError(receipt, error);
    }
    const completion = assertPrepareCleanupResult(completed, receipt);
    if (completion.status !== "cleanup-complete") {
      throw new CareerPrepareCleanupIncompleteError(
        receipt,
        new Error("Prepare cleanup completion was not durable."),
      );
    }
    return { cleaned: true };
  });
}

export async function activatePreparedCareerRestore(
  receipt: CareerRestoreReceipt,
): Promise<CareerRestoreActivation> {
  return withCareerBackupLock((context) =>
    activatePreparedInContext(receipt, context));
}

/** Pure recovery read: exactly one currentGeneration call, with no writes. */
export async function inspectCareerRestoreActivation(
  receipt: CareerRestoreReceipt,
): Promise<CareerRestoreActivationInspection> {
  const parsedReceipt = await verifyRestoreReceipt(receipt);
  const current = await inspectBoundCurrentGeneration(parsedReceipt);
  return {
    status: isCurrentTarget(current, parsedReceipt) ? "current" : "different-current",
    currentGenerationId: current.generationId,
    currentSequence: current.sequence,
  };
}

/** Only an explicitly discarded candidate authorizes attachment deletion. */
export async function discardPreparedCareerRestore(
  receipt: CareerRestoreReceipt,
): Promise<CareerRestoreDiscard> {
  return withCareerBackupLock((context) =>
    discardPreparedInContext(receipt, context));
}

export async function restoreCompleteCareerBackup(
  backup: Blob,
): Promise<CompleteCareerBackupRestore> {
  const source = await readCompleteSource(backup);
  return withCareerBackupLock(async (context) => {
    const receipt = await stageSourceInContext(source, context);
    try {
      await activatePreparedInContext(receipt, context);
    } catch (error) {
      return discardAfterLegacyApiFailure(receipt, context, error);
    }
    return {
      attachmentCount: receipt.summary.attachmentCount,
      byteSize: receipt.summary.byteSize,
      exportedAt: receipt.summary.exportedAt!,
      previousRecoverySnapshotRetained: true,
    };
  });
}

export async function restoreLegacyCareerDatabase(
  backup: Blob,
): Promise<LegacyCareerBackupRestore> {
  const source = await readLegacySource(backup);
  return withCareerBackupLock(async (context) => {
    const receipt = await stageSourceInContext(source, context);
    try {
      await activatePreparedInContext(receipt, context);
    } catch (error) {
      return discardAfterLegacyApiFailure(receipt, context, error);
    }
    return {
      byteSize: receipt.summary.byteSize,
      previousRecoverySnapshotRetained: true,
    };
  });
}
