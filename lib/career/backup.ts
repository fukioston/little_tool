import { localDb } from "@/lib/local-db/client";
import {
  deleteLocalFile,
  getLocalFile,
  saveLocalFile,
  sha256Blob,
  type LocalFileMetadata,
} from "@/lib/local-db/files";
import type {
  SqlStatement,
  StagedDatabaseImportResult,
} from "@/lib/local-db/types";
import {
  CAREER_BACKUP_LIMITS,
  CAREER_BACKUP_MAGIC,
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
const careerBackupMagicBytes = new TextEncoder().encode(CAREER_BACKUP_MAGIC);

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

type StagedAttachment = Readonly<{
  original: CareerBackupAttachmentMetadata;
  staged: LocalFileMetadata;
}>;

class CareerActivationUncertainError extends Error {
  constructor() {
    super("恢复切换结果暂时无法确认。请保留页面并刷新；应用不会在结果不明时清理候选数据。");
    this.name = "CareerActivationUncertainError";
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

async function activateCandidate(staged: StagedDatabaseImportResult) {
  try {
    await localDb.activateStaged(DB, staged.generationId, staged.activationToken);
    return;
  } catch (activationError) {
    try {
      const current = await localDb.currentGeneration(DB);
      if (current.generationId === staged.generationId) {
        return;
      }
    } catch {
      throw new CareerActivationUncertainError();
    }
    throw activationError;
  }
}

async function discardCandidate(staged: StagedDatabaseImportResult | null) {
  if (!staged) return;
  await localDb.discardStaged(DB, staged.generationId, staged.activationToken).catch(() => undefined);
}

async function deleteStagedAttachments(staged: readonly StagedAttachment[]) {
  await Promise.allSettled(staged.map(({ staged: metadata }) =>
    deleteLocalFile(DB, metadata.key)));
}

async function stageAttachments(parsed: ParsedCareerBackup): Promise<StagedAttachment[]> {
  const staged: StagedAttachment[] = [];
  try {
    for (const attachment of parsed.attachments) {
      const metadata = await saveLocalFile(DB, attachment.blob, {
        originalName: attachment.metadata.originalName,
        mimeType: attachment.metadata.mimeType,
        category: attachment.metadata.category ?? undefined,
        createdAt: attachment.metadata.createdAt,
        updatedAt: attachment.metadata.updatedAt,
      });
      if (
        metadata.byteSize !== attachment.metadata.byteSize ||
        metadata.sha256 !== attachment.metadata.sha256
      ) {
        throw new Error(`暂存附件「${attachment.metadata.originalName}」时校验失败`);
      }
      staged.push({ original: attachment.metadata, staged: metadata });
    }
    return staged;
  } catch (error) {
    await deleteStagedAttachments(staged);
    throw error;
  }
}

async function stageAndActivate(
  database: Uint8Array,
  statements: readonly SqlStatement[],
  context: CareerLockContext,
  stagedAttachments: readonly StagedAttachment[],
) {
  if (context.mode !== "exclusive") {
    throw new Error("恢复需要独占职迹存储锁");
  }
  let stagedDatabase: StagedDatabaseImportResult | null = null;
  let activated = false;
  try {
    stagedDatabase = await localDb.stageImport(
      DB,
      database,
      statements,
      CAREER_SCHEMA_REQUIREMENTS,
    );
    await activateCandidate(stagedDatabase);
    activated = true;
    broadcastCareerGenerationChanged(stagedDatabase.generationId);
  } catch (error) {
    if (!activated && !(error instanceof CareerActivationUncertainError)) {
      await discardCandidate(stagedDatabase);
      await deleteStagedAttachments(stagedAttachments);
    }
    throw error;
  }
}

export async function isCompleteCareerBackup(blob: Blob): Promise<boolean> {
  if (blob.size < careerBackupMagicBytes.byteLength) return false;
  const prefix = new Uint8Array(await blob.slice(0, careerBackupMagicBytes.byteLength).arrayBuffer());
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
    const blob = await createCareerBackupBlob({ database: exportedDatabase, attachments }, sha256Blob);
    return {
      blob,
      fileName: `zhiji-complete-${new Date().toISOString().slice(0, 10)}.career-backup`,
      attachmentCount: attachments.length,
      byteSize: blob.size,
    };
  });
}

export async function restoreCompleteCareerBackup(
  backup: Blob,
): Promise<CompleteCareerBackupRestore> {
  // The complete container and every digest are verified before the first
  // local write. The exclusive lock begins only after this CPU-bound parse.
  const parsed = await parseCareerBackupBlob(backup, sha256Blob);
  return withCareerBackupLock(async (context) => {
    const stagedAttachments = await stageAttachments(parsed);
    await stageAndActivate(
      parsed.database,
      createCompleteCareerRestoreStatements(stagedAttachments),
      context,
      stagedAttachments,
    );
    return {
      attachmentCount: parsed.attachments.length,
      byteSize: backup.size,
      exportedAt: parsed.manifest.exportedAt,
      previousRecoverySnapshotRetained: true,
    };
  });
}

export async function restoreLegacyCareerDatabase(
  backup: Blob,
): Promise<LegacyCareerBackupRestore> {
  if (backup.size > CAREER_BACKUP_LIMITS.databaseBytes) {
    throw new Error("旧版 SQLite 备份超过 512 MB，已在读取前拒绝");
  }
  const database = new Uint8Array(await backup.arrayBuffer());
  return withCareerBackupLock(async (context) => {
    await stageAndActivate(
      database,
      createLegacyCareerRestoreStatements(),
      context,
      [],
    );
    return { byteSize: database.byteLength, previousRecoverySnapshotRetained: true };
  });
}
