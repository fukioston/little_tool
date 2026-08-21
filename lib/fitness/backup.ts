import { localDb } from "@/lib/local-db/client";
import {
  deleteLocalFile,
  getLocalFile,
  saveLocalFile,
  sha256Blob,
  type LocalFileMetadata,
  type SaveLocalFileOptions,
} from "@/lib/local-db/files";
import type {
  CurrentDatabaseGeneration,
  DatabaseExportResult,
  SqlParams,
  SqlStatement,
  StagedDatabaseImportResult,
} from "@/lib/local-db/types";
import {
  createFitnessBackupBlob,
  FITNESS_BACKUP_LIMITS,
  FITNESS_BACKUP_MAGIC,
  parseFitnessBackupBlob,
  type FitnessBackupFileInput,
  type FitnessBackupFileMetadata,
  type ParsedFitnessBackup,
} from "./backup-format";
import {
  createCompleteFitnessRestoreStatements,
  createLegacyFitnessRestoreStatements,
  FITNESS_APPLICATION_ID,
  FITNESS_SCHEMA_REQUIREMENTS,
  FITNESS_USER_VERSION,
  type FitnessRestoreFileMapping,
} from "./backup-plan";
import { broadcastFitnessChange, withFitnessWriteLock } from "./lock";

const DATABASE = "fitness" as const;
const CANONICAL_DATABASE = "shilian" as const;
const SQLITE_HEADER = new TextEncoder().encode("SQLite format 3\u0000");
const SQLITE_IDENTITY_BYTES = 72;
const backupMagicBytes = new TextEncoder().encode(FITNESS_BACKUP_MAGIC);
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

type StagedFitnessFile = Readonly<{
  original: FitnessBackupFileMetadata;
  stagedStorage: LocalFileMetadata;
  mapping: FitnessRestoreFileMapping;
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
  ): Promise<StagedDatabaseImportResult>;
  activateStaged(staged: StagedDatabaseImportResult): Promise<void>;
  currentGeneration(): Promise<CurrentDatabaseGeneration>;
  discardStaged(staged: StagedDatabaseImportResult): Promise<void>;
  getFile(key: string): Promise<Readonly<{
    metadata: LocalFileMetadata;
    file: File;
  }>>;
  saveFile(blob: Blob, options: SaveLocalFileOptions): Promise<LocalFileMetadata>;
  deleteFile(key: string): Promise<unknown>;
  hashBlob(blob: Blob): Promise<string>;
  broadcastGenerationChanged(generationId: string): void;
  now(): Date;
}>;

export class FitnessActivationUncertainError extends Error {
  constructor() {
    super("恢复切换结果暂时无法确认。请保留页面并刷新；结果不明时不会清理候选数据。");
    this.name = "FitnessActivationUncertainError";
  }
}

function defaultExclusiveLock<T>(task: () => Promise<T>): Promise<T> {
  if (
    typeof navigator === "undefined" ||
    !navigator.locks ||
    typeof navigator.locks.request !== "function"
  ) {
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
  stageImport: (database, statements) =>
    localDb.stageImport(
      DATABASE,
      database,
      statements,
      FITNESS_SCHEMA_REQUIREMENTS,
    ),
  activateStaged: async (staged) => {
    await localDb.activateStaged(
      DATABASE,
      staged.generationId,
      staged.activationToken,
    );
  },
  currentGeneration: () => localDb.currentGeneration(DATABASE),
  discardStaged: async (staged) => {
    await localDb.discardStaged(
      DATABASE,
      staged.generationId,
      staged.activationToken,
    );
  },
  getFile: (key) => getLocalFile(DATABASE, key),
  saveFile: (blob, options) => saveLocalFile(DATABASE, blob, options),
  deleteFile: (key) => deleteLocalFile(DATABASE, key),
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

function sqliteIdentity(database: Uint8Array) {
  if (database.byteLength < SQLITE_IDENTITY_BYTES) {
    throw new Error("这份 SQLite 备份不完整，已在迁移前拒绝");
  }
  for (let index = 0; index < SQLITE_HEADER.byteLength; index += 1) {
    if (database[index] !== SQLITE_HEADER[index]) {
      throw new Error("这不是可识别的 SQLite 3 数据库，当前数据没有被改动");
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

function assertSupportedFitnessIdentity(database: Uint8Array): 1 | 2 {
  const identity = sqliteIdentity(database);
  if (
    identity.applicationId !== FITNESS_APPLICATION_ID ||
    (identity.userVersion !== 1 && identity.userVersion !== FITNESS_USER_VERSION)
  ) {
    throw new Error("这份 SQLite 不是当前支持的适练 v1/v2 数据库，当前数据没有被改动");
  }
  return identity.userVersion as 1 | 2;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

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
    !isString(row.file_name) ||
    !isString(row.mime_type) ||
    typeof row.byte_size !== "number" ||
    !Number.isSafeInteger(row.byte_size) ||
    row.byte_size < 0 ||
    !isString(row.sha256) ||
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
  const digest = await runtime.hashBlob(stored.file);
  if (digest !== expected.sha256) {
    throw new Error(`文件「${expected.originalName}」的真实内容校验失败，已停止导出`);
  }
}

function localFileCategory(metadata: FitnessBackupFileMetadata): string {
  // Match the Fitness file service's ownership marker so reconciliation can
  // safely associate a crash-staged object with its durable row id.
  return `fitness-file:${metadata.id}`;
}

function isoTimestamp(value: number, label: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label}的时间戳无法安全恢复`);
  }
  return date.toISOString();
}

async function deleteStagedFiles(
  staged: readonly StagedFitnessFile[],
  runtime: FitnessBackupRuntime,
): Promise<void> {
  await Promise.allSettled(
    staged.map(({ stagedStorage }) => runtime.deleteFile(stagedStorage.key)),
  );
}

async function stageFiles(
  parsed: ParsedFitnessBackup,
  runtime: FitnessBackupRuntime,
): Promise<StagedFitnessFile[]> {
  const staged: StagedFitnessFile[] = [];
  try {
    for (const file of parsed.files) {
      const createdAt = isoTimestamp(file.metadata.createdAt, "文件创建");
      const updatedAt = isoTimestamp(file.metadata.updatedAt, "文件更新");
      const category = localFileCategory(file.metadata);
      const stagedStorage = await runtime.saveFile(file.blob, {
        originalName: file.metadata.originalName,
        mimeType: file.metadata.mimeType,
        category,
        createdAt,
        updatedAt,
      });
      const record: StagedFitnessFile = {
        original: file.metadata,
        stagedStorage,
        mapping: {
          original: file.metadata,
          staged: { ...file.metadata, key: stagedStorage.key },
        },
      };
      // Record the returned object before validating it. If OPFS wrote bytes
      // but returned inconsistent metadata, the definite-error path still
      // knows which key to remove.
      staged.push(record);
      if (
        stagedStorage.version !== 1 ||
        stagedStorage.namespace !== DATABASE ||
        !UUID_V4_PATTERN.test(stagedStorage.key) ||
        stagedStorage.originalName !== file.metadata.originalName ||
        stagedStorage.mimeType !== file.metadata.mimeType ||
        stagedStorage.category !== category ||
        stagedStorage.byteSize !== file.metadata.byteSize ||
        stagedStorage.sha256 !== file.metadata.sha256 ||
        stagedStorage.createdAt !== createdAt ||
        stagedStorage.updatedAt !== updatedAt
      ) {
        throw new Error(`暂存文件「${file.metadata.originalName}」时校验失败`);
      }
    }
    return staged;
  } catch (error) {
    await deleteStagedFiles(staged, runtime);
    throw error;
  }
}

async function discardCandidate(
  staged: StagedDatabaseImportResult | null,
  runtime: FitnessBackupRuntime,
): Promise<void> {
  if (!staged) return;
  await runtime.discardStaged(staged).catch(() => undefined);
}

async function activateCandidate(
  staged: StagedDatabaseImportResult,
  runtime: FitnessBackupRuntime,
): Promise<void> {
  try {
    await runtime.activateStaged(staged);
  } catch (activationError) {
    try {
      const current = await runtime.currentGeneration();
      if (
        current.database === CANONICAL_DATABASE &&
        current.generationId === staged.generationId
      ) {
        return;
      }
    } catch {
      throw new FitnessActivationUncertainError();
    }
    throw activationError;
  }
}

async function stageAndActivate(
  database: Uint8Array,
  statements: readonly SqlStatement[],
  stagedFiles: readonly StagedFitnessFile[],
  runtime: FitnessBackupRuntime,
): Promise<void> {
  let stagedDatabase: StagedDatabaseImportResult | null = null;
  let activated = false;
  try {
    stagedDatabase = await runtime.stageImport(database, statements);
    if (
      stagedDatabase.database !== CANONICAL_DATABASE ||
      stagedDatabase.schemaVersion !== FITNESS_USER_VERSION ||
      stagedDatabase.importedBytes !== database.byteLength
    ) {
      throw new Error("候选数据库被错误地暂存到另一个产品空间或版本");
    }
    await activateCandidate(stagedDatabase, runtime);
    activated = true;
    try {
      runtime.broadcastGenerationChanged(stagedDatabase.generationId);
    } catch {
      // The generation is already durable; a notification failure must not
      // turn a successful restore into a destructive retry.
    }
  } catch (error) {
    if (!activated && !(error instanceof FitnessActivationUncertainError)) {
      await discardCandidate(stagedDatabase, runtime);
      await deleteStagedFiles(stagedFiles, runtime);
    }
    throw error;
  }
}

export function createFitnessBackupService(
  runtime: FitnessBackupRuntime = defaultRuntime,
) {
  return {
    async isCompleteBackup(blob: Blob): Promise<boolean> {
      if (blob.size < backupMagicBytes.byteLength) return false;
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

    async restoreCompleteBackup(
      backup: Blob,
    ): Promise<CompleteFitnessBackupRestore> {
      // Parse and authenticate every byte before entering the write lock or
      // creating any staged OPFS object.
      const parsed = await parseFitnessBackupBlob(backup, runtime.hashBlob);
      return runtime.withExclusiveLock(async () => {
        const staged = await stageFiles(parsed, runtime);
        let statements: readonly SqlStatement[];
        try {
          statements = createCompleteFitnessRestoreStatements(
            staged.map(({ mapping }) => mapping),
            parsed.manifest.database.userVersion,
          );
        } catch (error) {
          await deleteStagedFiles(staged, runtime);
          throw error;
        }
        await stageAndActivate(parsed.database, statements, staged, runtime);
        return {
          fileCount: parsed.files.length,
          byteSize: backup.size,
          exportedAt: parsed.manifest.exportedAt,
          previousRecoverySnapshotRetained: true,
        };
      });
    },

    async restoreLegacyDatabase(
      backup: Blob,
    ): Promise<LegacyFitnessBackupRestore> {
      if (backup.size > FITNESS_BACKUP_LIMITS.databaseBytes) {
        throw new Error("旧版 SQLite 备份超过 512 MB，已在读取前拒绝");
      }
      const database = new Uint8Array(await backup.arrayBuffer());
      const sourceUserVersion = assertSupportedFitnessIdentity(database);
      return runtime.withExclusiveLock(async () => {
        await stageAndActivate(
          database,
          createLegacyFitnessRestoreStatements(sourceUserVersion),
          [],
          runtime,
        );
        return {
          byteSize: database.byteLength,
          previousRecoverySnapshotRetained: true,
        };
      });
    },
  };
}

const defaultService = createFitnessBackupService();

export const isCompleteFitnessBackup = defaultService.isCompleteBackup;
export const exportCompleteFitnessBackup = defaultService.exportCompleteBackup;
export const restoreCompleteFitnessBackup = defaultService.restoreCompleteBackup;
export const restoreLegacyFitnessDatabase = defaultService.restoreLegacyDatabase;
