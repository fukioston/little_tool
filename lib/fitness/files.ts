import { localDb } from "@/lib/local-db/client";
import {
  deleteLocalFile,
  getLocalFile,
  listLocalFiles,
  saveLocalFile,
  sha256Blob,
  type LocalFileMetadata,
  type SaveLocalFileOptions,
} from "@/lib/local-db/files";
import { getFitnessExercise } from "./catalog";
import { broadcastFitnessChange, withFitnessWriteLock } from "./lock";
import type { FitnessFile } from "./types";

const DATABASE = "fitness" as const;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const PENDING_SHA256 = "0".repeat(64);
const MANAGED_CATEGORY_PREFIX = "fitness-file:";
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FITNESS_FILE_LIMIT_BYTES = MAX_FILE_BYTES;

export type FitnessFileEntityType = FitnessFile["entity_type"];
export type FitnessFilePurpose = FitnessFile["purpose"];
export type FitnessFileStatus = FitnessFile["status"] | "pending";
export type FitnessFileRecord = Readonly<
  Omit<FitnessFile, "status"> & { status: FitnessFileStatus }
>;

export type SaveFitnessFileInput = Readonly<{
  entityType: FitnessFileEntityType;
  entityId: string;
  purpose: FitnessFilePurpose;
  file: File;
}>;

export type ListFitnessFilesInput = Readonly<{
  entityType?: FitnessFileEntityType;
  entityId?: string;
  status?: FitnessFileStatus;
}>;

export type FitnessFileReconcileResult = Readonly<{
  adoptedPending: number;
  discardedPending: number;
  completedDeletes: number;
  markedMissing: number;
  restoredReady: number;
  deletedManagedOrphans: number;
}>;

export class FitnessFileError extends Error {
  constructor(
    message: string,
    readonly code = "FITNESS_FILE_ERROR",
  ) {
    super(message);
    this.name = "FitnessFileError";
  }
}

type QueryResult<Row> = Readonly<{ rows: readonly Row[] }>;
type RunResult = Readonly<{ changes: number }>;

export type FitnessFileServiceRuntime = Readonly<{
  withExclusiveLock<Result>(operation: () => Promise<Result>): Promise<Result>;
  query<Row extends object>(
    sql: string,
    params?: readonly (string | number | null)[],
  ): Promise<QueryResult<Row>>;
  run(
    sql: string,
    params?: readonly (string | number | null)[],
  ): Promise<RunResult>;
  saveFile(blob: Blob, options: SaveLocalFileOptions): Promise<LocalFileMetadata>;
  getFile(key: string): ReturnType<typeof getLocalFile>;
  listFiles(): Promise<readonly LocalFileMetadata[]>;
  deleteFile(key: string): Promise<boolean>;
  hashBlob(blob: Blob): Promise<string>;
  getBuiltInExercise(id: string): ReturnType<typeof getFitnessExercise>;
  randomUUID(): string;
  now(): number;
  broadcast(reason: string): void;
}>;

type StoredFitnessFile = FitnessFile;

type ValidatedFormat = Readonly<{
  mimeType: string;
  extension: string;
  kind: "image" | "document";
}>;

const FORMATS: readonly Readonly<{
  mimeType: string;
  extensions: readonly string[];
  kind: ValidatedFormat["kind"];
  matches(bytes: Uint8Array): boolean;
}>[] = [
  {
    mimeType: "image/jpeg",
    extensions: ["jpg", "jpeg"],
    kind: "image",
    matches: (bytes) =>
      bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    mimeType: "image/png",
    extensions: ["png"],
    kind: "image",
    matches: (bytes) =>
      bytes.length >= 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
        .every((value, index) => bytes[index] === value),
  },
  {
    mimeType: "image/webp",
    extensions: ["webp"],
    kind: "image",
    matches: (bytes) =>
      bytes.length >= 12 &&
      ascii(bytes, 0, 4) === "RIFF" &&
      ascii(bytes, 8, 12) === "WEBP",
  },
  {
    mimeType: "image/heic",
    extensions: ["heic"],
    kind: "image",
    matches: (bytes) => {
      if (bytes.length < 12 || ascii(bytes, 4, 8) !== "ftyp") return false;
      return ["heic", "heix", "hevc", "hevx", "heim", "heis"]
        .includes(ascii(bytes, 8, 12));
    },
  },
  {
    mimeType: "application/pdf",
    extensions: ["pdf"],
    kind: "document",
    matches: (bytes) => bytes.length >= 5 && ascii(bytes, 0, 5) === "%PDF-",
  },
];

const defaultRuntime: FitnessFileServiceRuntime = {
  withExclusiveLock: withFitnessWriteLock,
  query: async <Row extends object>(sql: string, params?: readonly (string | number | null)[]) =>
    localDb.query<Row>(DATABASE, sql, params),
  run: (sql, params) => localDb.run(DATABASE, sql, params),
  saveFile: (blob, options) => saveLocalFile(DATABASE, blob, options),
  getFile: (key) => getLocalFile(DATABASE, key),
  listFiles: () => listLocalFiles(DATABASE),
  deleteFile: (key) => deleteLocalFile(DATABASE, key),
  hashBlob: sha256Blob,
  getBuiltInExercise: getFitnessExercise,
  randomUUID: () => crypto.randomUUID(),
  now: () => Date.now(),
  broadcast: broadcastFitnessChange,
};

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function fail(message: string, code: string): never {
  throw new FitnessFileError(message, code);
}

function assertEntityType(value: string): asserts value is FitnessFileEntityType {
  if (!["venue", "equipment", "exercise", "session"].includes(value)) {
    fail("不支持这个附件归属类型。", "INVALID_ENTITY_TYPE");
  }
}

function assertPurpose(value: string): asserts value is FitnessFilePurpose {
  if (!["photo", "instruction", "other"].includes(value)) {
    fail("不支持这个附件用途。", "INVALID_PURPOSE");
  }
}

function normalizeIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0 || value.length > 255) {
    fail(`${label}无效。`, "INVALID_IDENTIFIER");
  }
  if (Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || point === 127;
  })) {
    fail(`${label}包含不安全字符。`, "INVALID_IDENTIFIER");
  }
  return value;
}

function safeFileName(value: string): string {
  const safe = Array.from(value, (character) => {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 31 || point === 127) return " ";
    if (character === "/" || character === "\\") return "_";
    return character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);
  return safe || "attachment";
}

function fileExtension(name: string): string {
  const match = /\.([^.]+)$/.exec(name);
  return match?.[1]?.toLocaleLowerCase("en-US") ?? "";
}

async function validateFile(file: File, purpose: FitnessFilePurpose): Promise<ValidatedFormat> {
  if (
    typeof file !== "object" ||
    file === null ||
    typeof file.name !== "string" ||
    typeof file.type !== "string" ||
    typeof file.size !== "number" ||
    typeof file.slice !== "function"
  ) {
    fail("请选择浏览器提供的真实文件。", "INVALID_FILE");
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    fail("空文件不能作为附件。", "EMPTY_FILE");
  }
  if (file.size > MAX_FILE_BYTES) {
    fail("单个附件不能超过 20 MiB。", "FILE_TOO_LARGE");
  }

  const mimeType = file.type.trim().toLocaleLowerCase("en-US");
  const extension = fileExtension(file.name);
  const format = FORMATS.find((candidate) =>
    candidate.mimeType === mimeType && candidate.extensions.includes(extension),
  );
  if (!format) {
    fail(
      "文件扩展名和 MIME 类型必须一致；图片仅支持 JPEG、PNG、WebP、HEIC，说明附件另支持 PDF。",
      "UNSUPPORTED_FILE_TYPE",
    );
  }
  if (purpose === "photo" && format.kind !== "image") {
    fail("照片用途只能使用 JPEG、PNG、WebP 或 HEIC 图片。", "PHOTO_MUST_BE_IMAGE");
  }

  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  if (!format.matches(bytes)) {
    fail("文件内容与扩展名或 MIME 类型不一致。", "FILE_SIGNATURE_MISMATCH");
  }
  return { mimeType: format.mimeType, extension, kind: format.kind };
}

function isPending(row: StoredFitnessFile): boolean {
  return row.status === "missing" && row.sha256 === PENDING_SHA256;
}

function publicRecord(row: StoredFitnessFile): FitnessFileRecord {
  return { ...row, status: isPending(row) ? "pending" : row.status };
}

function managedCategory(id: string): string {
  return `${MANAGED_CATEGORY_PREFIX}${id}`;
}

function managedRowId(metadata: LocalFileMetadata): string | null {
  const category = metadata.category;
  if (!category?.startsWith(MANAGED_CATEGORY_PREFIX)) return null;
  const id = category.slice(MANAGED_CATEGORY_PREFIX.length);
  return id.startsWith("fitness-file-") && id.length <= 255 ? id : null;
}

function metadataMatchesRow(metadata: LocalFileMetadata, row: StoredFitnessFile): boolean {
  return metadata.key === row.file_key &&
    metadata.originalName === row.file_name &&
    metadata.mimeType === row.mime_type &&
    metadata.byteSize === row.byte_size &&
    metadata.sha256.toLowerCase() === row.sha256.toLowerCase();
}

async function requireEntity(
  runtime: FitnessFileServiceRuntime,
  entityType: FitnessFileEntityType,
  entityId: string,
): Promise<void> {
  if (entityType === "exercise") {
    // Exercise attachments deliberately target only immutable built-in catalog IDs.
    // There is no persisted custom-exercise truth table in schema v1, so accepting an
    // arbitrary label here would create an unverifiable cross-entity reference.
    if (!runtime.getBuiltInExercise(entityId)) {
      fail("动作附件只能关联适练内置动作目录中的真实动作。", "ENTITY_NOT_FOUND");
    }
    return;
  }
  const table = {
    venue: "fitness_venues",
    equipment: "fitness_equipment",
    session: "fitness_sessions",
  }[entityType];
  const result = await runtime.query<{ id: string }>(
    `SELECT id FROM ${table} WHERE id = ? LIMIT 1`,
    [entityId],
  );
  if (result.rows.length !== 1) {
    fail("附件要关联的记录不存在。", "ENTITY_NOT_FOUND");
  }
}

async function findRow(
  runtime: FitnessFileServiceRuntime,
  id: string,
): Promise<StoredFitnessFile | null> {
  const result = await runtime.query<StoredFitnessFile>(
    "SELECT * FROM fitness_files WHERE id = ? LIMIT 1",
    [id],
  );
  return result.rows[0] ?? null;
}

function emptyReconcileResult(): MutableReconcileResult {
  return {
    adoptedPending: 0,
    discardedPending: 0,
    completedDeletes: 0,
    markedMissing: 0,
    restoredReady: 0,
    deletedManagedOrphans: 0,
  };
}

type MutableReconcileResult = {
  -readonly [Key in keyof FitnessFileReconcileResult]: FitnessFileReconcileResult[Key];
};

function reconcileChanged(result: FitnessFileReconcileResult): boolean {
  return Object.values(result).some((value) => value > 0);
}

async function reconcileUnlocked(
  runtime: FitnessFileServiceRuntime,
): Promise<FitnessFileReconcileResult> {
  const result = emptyReconcileResult();
  const rows = [...(await runtime.query<StoredFitnessFile>(
    "SELECT * FROM fitness_files ORDER BY created_at,id",
  )).rows];
  const localFiles = [...await runtime.listFiles()];
  const localByKey = new Map(localFiles.map((metadata) => [metadata.key, metadata]));
  const localByManagedRow = new Map<string, LocalFileMetadata[]>();
  const deletedLocalKeys = new Set<string>();

  for (const metadata of localFiles) {
    const rowId = managedRowId(metadata);
    if (!rowId) continue;
    const entries = localByManagedRow.get(rowId) ?? [];
    entries.push(metadata);
    localByManagedRow.set(rowId, entries);
  }

  const survivingRows = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (row.status === "deleting") {
      await runtime.deleteFile(row.file_key);
      await runtime.run("DELETE FROM fitness_files WHERE id = ? AND status = 'deleting'", [row.id]);
      survivingRows.delete(row.id);
      result.completedDeletes += 1;
      continue;
    }

    if (isPending(row)) {
      const candidates = localByManagedRow.get(row.id) ?? [];
      const valid: LocalFileMetadata[] = [];
      for (const metadata of candidates) {
        try {
          const stored = await runtime.getFile(metadata.key);
          await validateFile(stored.file, row.purpose);
          if (
            stored.metadata.byteSize === stored.file.size &&
            stored.metadata.sha256 === await runtime.hashBlob(stored.file)
          ) {
            valid.push(stored.metadata);
          }
        } catch {
          await runtime.deleteFile(metadata.key);
          deletedLocalKeys.add(metadata.key);
        }
      }

      let entityExists = true;
      try {
        await requireEntity(runtime, row.entity_type, row.entity_id);
      } catch {
        entityExists = false;
      }
      if (entityExists && valid.length > 0) {
        const adopted = valid[0];
        const now = runtime.now();
        await runtime.run(
          `UPDATE fitness_files
             SET file_key = ?, file_name = ?, mime_type = ?, byte_size = ?, sha256 = ?,
                 status = 'ready', updated_at = ?
           WHERE id = ? AND status = 'missing' AND sha256 = ?`,
          [
            adopted.key,
            adopted.originalName,
            adopted.mimeType,
            adopted.byteSize,
            adopted.sha256,
            now,
            row.id,
            PENDING_SHA256,
          ],
        );
        survivingRows.set(row.id, {
          ...row,
          file_key: adopted.key,
          file_name: adopted.originalName,
          mime_type: adopted.mimeType,
          byte_size: adopted.byteSize,
          sha256: adopted.sha256,
          status: "ready",
          updated_at: now,
        });
        result.adoptedPending += 1;
        for (const duplicate of valid.slice(1)) {
          await runtime.deleteFile(duplicate.key);
          deletedLocalKeys.add(duplicate.key);
        }
      } else {
        for (const metadata of valid) {
          await runtime.deleteFile(metadata.key);
          deletedLocalKeys.add(metadata.key);
        }
        await runtime.run(
          "DELETE FROM fitness_files WHERE id = ? AND status = 'missing' AND sha256 = ?",
          [row.id, PENDING_SHA256],
        );
        survivingRows.delete(row.id);
        result.discardedPending += 1;
      }
      continue;
    }

    const local = localByKey.get(row.file_key);
    if (row.status === "ready" && (!local || !metadataMatchesRow(local, row))) {
      const updatedAt = runtime.now();
      await runtime.run(
        "UPDATE fitness_files SET status = 'missing', updated_at = ? WHERE id = ? AND status = 'ready'",
        [updatedAt, row.id],
      );
      survivingRows.set(row.id, { ...row, status: "missing", updated_at: updatedAt });
      result.markedMissing += 1;
    } else if (row.status === "missing" && local && metadataMatchesRow(local, row)) {
      try {
        const stored = await runtime.getFile(row.file_key);
        await validateFile(stored.file, row.purpose);
        if (await runtime.hashBlob(stored.file) === row.sha256) {
          const updatedAt = runtime.now();
          await runtime.run(
            "UPDATE fitness_files SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'missing'",
            [updatedAt, row.id],
          );
          survivingRows.set(row.id, { ...row, status: "ready", updated_at: updatedAt });
          result.restoredReady += 1;
        }
      } catch {
        // Keep the truthful missing row and the user's bytes. A read can surface
        // the integrity error, but reconciliation never destroys this evidence.
      }
    }
  }

  const referencedKeys = new Set(
    [...survivingRows.values()].map((row) => row.file_key),
  );
  for (const metadata of localFiles) {
    if (deletedLocalKeys.has(metadata.key)) continue;
    const rowId = managedRowId(metadata);
    if (!rowId || referencedKeys.has(metadata.key)) continue;
    // A managed abandoned/duplicate object is safe to clean. Unknown OPFS files
    // and complete user files with another category are never touched.
    await runtime.deleteFile(metadata.key);
    result.deletedManagedOrphans += 1;
  }
  return result;
}

export function createFitnessFileService(runtime: FitnessFileServiceRuntime) {
  async function reconcile(): Promise<FitnessFileReconcileResult> {
    return runtime.withExclusiveLock(async () => {
      const result = await reconcileUnlocked(runtime);
      if (reconcileChanged(result)) runtime.broadcast("fitness-files-reconciled");
      return result;
    });
  }

  async function save(input: SaveFitnessFileInput): Promise<FitnessFileRecord> {
    assertEntityType(input.entityType);
    assertPurpose(input.purpose);
    const entityId = normalizeIdentifier(input.entityId, "附件归属 ID");
    const format = await validateFile(input.file, input.purpose);

    return runtime.withExclusiveLock(async () => {
      await requireEntity(runtime, input.entityType, entityId);
      const id = `fitness-file-${runtime.randomUUID()}`;
      const pendingKey = runtime.randomUUID();
      if (!UUID_V4_PATTERN.test(pendingKey)) {
        fail("无法生成安全的附件标识。", "INVALID_GENERATED_KEY");
      }
      const now = runtime.now();
      const initialName = safeFileName(input.file.name);
      await runtime.run(
        `INSERT INTO fitness_files(
           id,entity_type,entity_id,purpose,file_key,file_name,mime_type,
           byte_size,sha256,status,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,'missing',?,?)`,
        [
          id,
          input.entityType,
          entityId,
          input.purpose,
          pendingKey,
          initialName,
          format.mimeType,
          0,
          PENDING_SHA256,
          now,
          now,
        ],
      );

      let stored: LocalFileMetadata | null = null;
      try {
        stored = await runtime.saveFile(input.file, {
          originalName: input.file.name,
          mimeType: format.mimeType,
          category: managedCategory(id),
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        });
        const actualHash = await runtime.hashBlob(input.file);
        if (
          stored.byteSize !== input.file.size ||
          stored.sha256.toLowerCase() !== actualHash.toLowerCase() ||
          stored.mimeType !== format.mimeType ||
          !UUID_V4_PATTERN.test(stored.key)
        ) {
          fail("浏览器写入的附件元数据与真实文件不一致。", "FILE_METADATA_MISMATCH");
        }

        const updatedAt = Math.max(now, runtime.now());
        const update = await runtime.run(
          `UPDATE fitness_files
             SET file_key = ?, file_name = ?, mime_type = ?, byte_size = ?, sha256 = ?,
                 status = 'ready', updated_at = ?
           WHERE id = ? AND status = 'missing' AND sha256 = ? AND file_key = ?`,
          [
            stored.key,
            stored.originalName,
            stored.mimeType,
            stored.byteSize,
            stored.sha256.toLowerCase(),
            updatedAt,
            id,
            PENDING_SHA256,
            pendingKey,
          ],
        );
        if (update.changes !== 1) {
          fail("附件暂存记录发生变化，已停止写入。", "PENDING_ROW_CHANGED");
        }
        const record: FitnessFileRecord = {
          id,
          entity_type: input.entityType,
          entity_id: entityId,
          purpose: input.purpose,
          file_key: stored.key,
          file_name: stored.originalName,
          mime_type: stored.mimeType,
          byte_size: stored.byteSize,
          sha256: stored.sha256.toLowerCase(),
          status: "ready",
          created_at: now,
          updated_at: updatedAt,
        };
        runtime.broadcast("fitness-file-saved");
        return record;
      } catch (error) {
        if (stored) await runtime.deleteFile(stored.key).catch(() => undefined);
        await runtime.run(
          "DELETE FROM fitness_files WHERE id = ? AND status = 'missing' AND sha256 = ?",
          [id, PENDING_SHA256],
        ).catch(() => undefined);
        throw error;
      }
    });
  }

  async function get(idInput: string): Promise<FitnessFileRecord | null> {
    const id = normalizeIdentifier(idInput, "附件 ID");
    return runtime.withExclusiveLock(async () => {
      const row = await findRow(runtime, id);
      return row ? publicRecord(row) : null;
    });
  }

  async function getBlob(idInput: string): Promise<Blob> {
    const id = normalizeIdentifier(idInput, "附件 ID");
    return runtime.withExclusiveLock(async () => {
      const row = await findRow(runtime, id);
      if (!row) fail("附件不存在。", "FILE_NOT_FOUND");
      if (row.status !== "ready") fail("附件内容目前不可用。", "FILE_NOT_READY");
      try {
        const stored = await runtime.getFile(row.file_key);
        await validateFile(stored.file, row.purpose);
        const hash = await runtime.hashBlob(stored.file);
        if (!metadataMatchesRow(stored.metadata, row) || hash !== row.sha256) {
          fail("附件内容与记录的校验信息不一致。", "FILE_INTEGRITY_MISMATCH");
        }
        return stored.file;
      } catch (error) {
        await runtime.run(
          "UPDATE fitness_files SET status = 'missing', updated_at = ? WHERE id = ? AND status = 'ready'",
          [runtime.now(), row.id],
        );
        runtime.broadcast("fitness-file-missing");
        throw error;
      }
    });
  }

  async function list(input: ListFitnessFilesInput = {}): Promise<readonly FitnessFileRecord[]> {
    if (input.entityType !== undefined) assertEntityType(input.entityType);
    if (input.status !== undefined && !["pending", "ready", "missing", "deleting"].includes(input.status)) {
      fail("不支持这个附件状态。", "INVALID_STATUS");
    }
    const entityId = input.entityId === undefined
      ? undefined
      : normalizeIdentifier(input.entityId, "附件归属 ID");

    return runtime.withExclusiveLock(async () => {
      const reconciled = await reconcileUnlocked(runtime);
      const rows = (await runtime.query<StoredFitnessFile>(
        "SELECT * FROM fitness_files ORDER BY updated_at DESC,id",
      )).rows.map(publicRecord);
      if (reconcileChanged(reconciled)) runtime.broadcast("fitness-files-reconciled");
      return rows.filter((row) =>
        (input.entityType === undefined || row.entity_type === input.entityType) &&
        (entityId === undefined || row.entity_id === entityId) &&
        (input.status === undefined || row.status === input.status),
      );
    });
  }

  async function remove(idInput: string): Promise<boolean> {
    const id = normalizeIdentifier(idInput, "附件 ID");
    return runtime.withExclusiveLock(async () => {
      const row = await findRow(runtime, id);
      if (!row) return false;
      if (row.status !== "deleting") {
        await runtime.run(
          "UPDATE fitness_files SET status = 'deleting', updated_at = ? WHERE id = ?",
          [runtime.now(), id],
        );
      }
      await runtime.deleteFile(row.file_key);
      await runtime.run("DELETE FROM fitness_files WHERE id = ? AND status = 'deleting'", [id]);
      runtime.broadcast("fitness-file-deleted");
      return true;
    });
  }

  return {
    initializeFitnessFiles: reconcile,
    saveFitnessFile: save,
    getFitnessFile: get,
    getFitnessFileBlob: getBlob,
    listFitnessFiles: list,
    deleteFitnessFile: remove,
  } as const;
}

const service = createFitnessFileService(defaultRuntime);

export const initializeFitnessFiles = service.initializeFitnessFiles;
export const saveFitnessFile = service.saveFitnessFile;
export const getFitnessFile = service.getFitnessFile;
export const getFitnessFileBlob = service.getFitnessFileBlob;
export const listFitnessFiles = service.listFitnessFiles;
export const deleteFitnessFile = service.deleteFitnessFile;
