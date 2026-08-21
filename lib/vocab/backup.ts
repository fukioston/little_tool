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
  ): Promise<StagedDatabaseImportResult>;
  activateStaged(staged: StagedDatabaseImportResult): Promise<void>;
  currentGeneration(): Promise<CurrentDatabaseGeneration>;
  discardStaged(staged: StagedDatabaseImportResult): Promise<void>;
  getFile(key: string): Promise<Readonly<{ metadata: LocalFileMetadata; file: File }>>;
  saveFile(blob: Blob, options: SaveLocalFileOptions): Promise<LocalFileMetadata>;
  deleteFile(key: string): Promise<unknown>;
  hashBlob(blob: Blob): Promise<string>;
  broadcastGenerationChanged(generationId: string): void;
  now(): Date;
}>;

export class VocabActivationUncertainError extends Error {
  constructor() {
    super("恢复切换结果暂时无法确认。请保留页面并刷新；结果不明时不会清理候选数据。");
    this.name = "VocabActivationUncertainError";
  }
}

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
  stageImport: (database, statements) =>
    localDb.stageImport(DATABASE, database, statements, VOCAB_SCHEMA_REQUIREMENTS),
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

function sqliteUserVersion(database: Uint8Array): number {
  if (database.byteLength < 64) {
    throw new Error("这份 SQLite 备份不完整，已在迁移前拒绝");
  }
  return new DataView(
    database.buffer,
    database.byteOffset,
    database.byteLength,
  ).getUint32(60, false);
}

function assertSupportedSourceVersion(userVersion: number): void {
  if (!Number.isSafeInteger(userVersion) || userVersion < 0 || userVersion > VOCAB_USER_VERSION) {
    throw new Error("这份拾词备份来自尚不支持的未来版本，当前数据没有被改动");
  }
}

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

async function stageAudio(
  parsed: ParsedVocabBackup,
  runtime: VocabBackupRuntime,
): Promise<StagedAudio[]> {
  const staged: StagedAudio[] = [];
  try {
    for (const audio of parsed.audio) {
      const metadata = await runtime.saveFile(audio.blob, {
        originalName: audio.metadata.originalName,
        mimeType: audio.metadata.mimeType,
        category: audio.metadata.category ?? undefined,
        createdAt: audio.metadata.createdAt,
        updatedAt: audio.metadata.updatedAt,
      });
      // Record the object before validating its returned metadata so a
      // partially successful OPFS write is also cleaned on a definite error.
      staged.push({ original: audio.metadata, staged: metadata });
      if (
        metadata.version !== 1 ||
        metadata.namespace !== DATABASE ||
        !LOCAL_AUDIO_PATTERN.test(`local:${metadata.key}`) ||
        metadata.originalName !== audio.metadata.originalName ||
        metadata.mimeType !== audio.metadata.mimeType ||
        metadata.category !== audio.metadata.category ||
        metadata.byteSize !== audio.metadata.byteSize ||
        metadata.sha256 !== audio.metadata.sha256 ||
        metadata.createdAt !== audio.metadata.createdAt ||
        metadata.updatedAt !== audio.metadata.updatedAt
      ) {
        throw new Error(`暂存音频「${audio.metadata.originalName}」时校验失败`);
      }
    }
    return staged;
  } catch (error) {
    await deleteStagedAudio(staged, runtime);
    throw error;
  }
}

async function deleteStagedAudio(
  staged: readonly StagedAudio[],
  runtime: VocabBackupRuntime,
): Promise<void> {
  await Promise.allSettled(staged.map(({ staged: metadata }) => runtime.deleteFile(metadata.key)));
}

async function discardCandidate(
  staged: StagedDatabaseImportResult | null,
  runtime: VocabBackupRuntime,
): Promise<void> {
  if (!staged) return;
  await runtime.discardStaged(staged).catch(() => undefined);
}

async function activateCandidate(
  staged: StagedDatabaseImportResult,
  runtime: VocabBackupRuntime,
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
      throw new VocabActivationUncertainError();
    }
    throw activationError;
  }
}

async function stageAndActivate(
  database: Uint8Array,
  statements: readonly SqlStatement[],
  stagedAudio: readonly StagedAudio[],
  runtime: VocabBackupRuntime,
): Promise<void> {
  let stagedDatabase: StagedDatabaseImportResult | null = null;
  let activated = false;
  try {
    stagedDatabase = await runtime.stageImport(database, statements);
    if (stagedDatabase.database !== CANONICAL_DATABASE) {
      throw new Error("候选数据库被错误地暂存到另一个产品空间");
    }
    await activateCandidate(stagedDatabase, runtime);
    activated = true;
    runtime.broadcastGenerationChanged(stagedDatabase.generationId);
  } catch (error) {
    if (!activated && !(error instanceof VocabActivationUncertainError)) {
      await discardCandidate(stagedDatabase, runtime);
      await deleteStagedAudio(stagedAudio, runtime);
    }
    throw error;
  }
}

export function createVocabBackupService(runtime: VocabBackupRuntime = defaultRuntime) {
  return {
    async isCompleteBackup(blob: Blob): Promise<boolean> {
      if (blob.size < backupMagicBytes.byteLength) return false;
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

    async restoreCompleteBackup(backup: Blob): Promise<CompleteVocabBackupRestore> {
      const parsed = await parseVocabBackupBlob(backup, runtime.hashBlob);
      assertSupportedSourceVersion(parsed.manifest.database.userVersion);
      return runtime.withExclusiveLock(async () => {
        const staged = await stageAudio(parsed, runtime);
        let statements: readonly SqlStatement[];
        try {
          statements = createCompleteVocabRestoreStatements(
            staged,
            parsed.manifest.database.userVersion,
            runtime.now().getTime(),
          );
        } catch (error) {
          await deleteStagedAudio(staged, runtime);
          throw error;
        }
        await stageAndActivate(parsed.database, statements, staged, runtime);
        return {
          audioCount: parsed.audio.length,
          byteSize: backup.size,
          exportedAt: parsed.manifest.exportedAt,
          previousRecoverySnapshotRetained: true,
        };
      });
    },

    async restoreLegacyDatabase(backup: Blob): Promise<LegacyVocabBackupRestore> {
      if (backup.size > VOCAB_BACKUP_LIMITS.databaseBytes) {
        throw new Error("旧版 SQLite 备份超过 512 MB，已在读取前拒绝");
      }
      const database = new Uint8Array(await backup.arrayBuffer());
      const sourceUserVersion = sqliteUserVersion(database);
      assertSupportedSourceVersion(sourceUserVersion);
      return runtime.withExclusiveLock(async () => {
        await stageAndActivate(
          database,
          createLegacyVocabRestoreStatements(
            sourceUserVersion,
            runtime.now().getTime(),
          ),
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

const defaultService = createVocabBackupService();

export const isCompleteVocabBackup = defaultService.isCompleteBackup;
export const exportCompleteVocabBackup = defaultService.exportCompleteBackup;
export const restoreCompleteVocabBackup = defaultService.restoreCompleteBackup;
export const restoreLegacyVocabDatabase = defaultService.restoreLegacyDatabase;
