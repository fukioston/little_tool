import { localDb } from "@/lib/local-db/client";
import {
  deleteLocalFile,
  getLocalFile,
  saveLocalFile,
  sha256Blob,
  type LocalFileMetadata,
  type LocalFileResult,
  type SaveLocalFileOptions,
} from "@/lib/local-db/files";
import { withCareerWriteLock } from "./lock";

const DATABASE = "career" as const;
const FILE_CATEGORY = "career-material";
const CHANGE_REASON = "career-material-saved";
const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

type QueryResult<Row> = Readonly<{ rows: readonly Row[] }>;
type RunResult = Readonly<{ changes: number }>;

type StoredMaterial = Readonly<{
  id: string;
  name: string;
  kind: string;
  version: string;
  updated_at: string;
  linked_job_id: string | null;
  status: string;
  notes: string;
  file_key: string | null;
  file_name: string | null;
  mime_type: string | null;
  byte_size: number | null;
}>;

export type CareerMaterialSaveRuntime = Readonly<{
  withExclusiveLock<Result>(operation: () => Promise<Result>): Promise<Result>;
  query<Row extends object>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  run(sql: string, params?: readonly unknown[]): Promise<RunResult>;
  saveFile(blob: Blob, options: SaveLocalFileOptions): Promise<LocalFileMetadata>;
  getFile(key: string): Promise<LocalFileResult>;
  deleteFile(key: string): Promise<boolean>;
  hashBlob(blob: Blob): Promise<string>;
  broadcast(reason: string): void;
}>;

export type CareerMaterialSaveAttachmentInput = Readonly<{
  blob: Blob;
  originalName: string;
  mimeType?: string;
}>;

export type CareerMaterialSaveInput = Readonly<{
  /** Generate once when the form opens and reuse for every retry. */
  materialId: string;
  name: string;
  kind: string;
  version: string;
  updatedAt: string;
  linkedJobId?: string | null;
  status: "ready" | "draft" | "sent";
  notes?: string;
  attachment?: CareerMaterialSaveAttachmentInput | null;
}>;

export type CareerMaterialSaveAttachmentSnapshot = Readonly<{
  originalName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}>;

/** Complete persisted facts except the private OPFS key. */
export type CareerMaterialSaveExpectedSnapshot = Readonly<{
  name: string;
  kind: string;
  version: string;
  updatedAt: string;
  linkedJobId: string | null;
  status: "ready" | "draft" | "sent";
  notes: string;
  attachment: CareerMaterialSaveAttachmentSnapshot | null;
}>;

export type CareerMaterialSaveResult =
  | Readonly<{
      outcome: "saved" | "already_saved";
      materialId: string;
      fileKey?: string;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      materialId: string;
      /** Lets the UI perform a check-only retry without exposing file_key. */
      expectedSnapshot: CareerMaterialSaveExpectedSnapshot;
      retryable: true;
    }>;

export type CareerMaterialSaveInspection =
  | "exact_saved"
  | "absent"
  | "conflict"
  | "still_unknown";

export type CareerMaterialSaveErrorCode =
  | "invalid_input"
  | "conflict"
  | "inspect_failed"
  | "attachment_read_failed"
  | "attachment_write_failed"
  | "attachment_metadata_mismatch"
  | "temporary_file_cleanup_failed"
  | "write_failed";

export class CareerMaterialSaveError extends Error {
  readonly name = "CareerMaterialSaveError";

  constructor(
    readonly code: CareerMaterialSaveErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type NormalizedAttachmentInput = Readonly<{
  blob: Blob;
  originalName: string;
  mimeType: string;
  byteSize: number;
}>;

type NormalizedSaveInput = Readonly<{
  materialId: string;
  name: string;
  kind: string;
  version: string;
  updatedAt: string;
  linkedJobId: string | null;
  status: "ready" | "draft" | "sent";
  notes: string;
  attachment: NormalizedAttachmentInput | null;
}>;

const defaultRuntime: CareerMaterialSaveRuntime = {
  withExclusiveLock: (operation) => withCareerWriteLock(() => operation()),
  query: <Row extends object>(sql: string, params?: readonly unknown[]) =>
    localDb.query<Row>(DATABASE, sql, params),
  run: (sql, params) => localDb.run(DATABASE, sql, params),
  saveFile: (blob, options) => saveLocalFile(DATABASE, blob, options),
  getFile: (key) => getLocalFile(DATABASE, key),
  deleteFile: (key) => deleteLocalFile(DATABASE, key),
  hashBlob: (blob) => sha256Blob(blob),
  // Ordinary data writes must not impersonate a database-generation switch.
  broadcast: () => undefined,
};

function invalid(message: string): never {
  throw new CareerMaterialSaveError("invalid_input", message);
}

function hasUnsafeControl(value: string, allowNewlines = false): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    if (allowNewlines && (point === 9 || point === 10 || point === 13)) return false;
    return point <= 31 || point === 127;
  });
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 240 ||
    value !== value.trim() ||
    hasUnsafeControl(value)
  ) {
    invalid(`${label}无效，请刷新后再试。`);
  }
  return value;
}

function oneLineText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (typeof value !== "string" || hasUnsafeControl(value)) {
    invalid(`${label}无效。`);
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) invalid(`${label}不能为空。`);
  if (Array.from(normalized).length > maximum) invalid(`${label}过长。`);
  return normalized;
}

function notesText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || hasUnsafeControl(value, true)) {
    invalid("材料备注包含无法保存的字符。");
  }
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (Array.from(normalized).length > 20_000) invalid("材料备注过长。");
  return normalized;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    invalid("材料更新时间无效。");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalid("材料更新时间无效。");
  return new Date(milliseconds).toISOString();
}

function optionalIdentifier(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return identifier(value, label);
}

function safeFileName(value: unknown): string {
  if (typeof value !== "string") invalid("附件名称无效。");
  const safe = Array.from(value, (character) => {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 31 || point === 127) return " ";
    if (character === "/" || character === "\\") return "_";
    return character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(safe || "attachment").slice(0, 255).join("");
}

function safeMimeType(value: unknown): string {
  if (value !== undefined && typeof value !== "string") {
    invalid("附件 MIME 类型无效。");
  }
  const safe = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9!#$&^_.+\-/]/g, "")
    .slice(0, 127);
  return safe.includes("/") ? safe : "application/octet-stream";
}

function normalizedStatus(value: unknown): NormalizedSaveInput["status"] {
  if (value !== "ready" && value !== "draft" && value !== "sent") {
    invalid("材料状态无效。");
  }
  return value;
}

function normalizeInput(input: CareerMaterialSaveInput): NormalizedSaveInput {
  if (!input || typeof input !== "object") invalid("材料内容无效。");
  let attachment: NormalizedAttachmentInput | null = null;
  if (input.attachment !== undefined && input.attachment !== null) {
    if (
      !input.attachment ||
      typeof input.attachment !== "object" ||
      !(input.attachment.blob instanceof Blob)
    ) {
      invalid("请选择浏览器提供的真实附件。");
    }
    const byteSize = input.attachment.blob.size;
    if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
      invalid("空附件不能保存。");
    }
    if (byteSize > MAX_ATTACHMENT_BYTES) {
      invalid("单个材料附件不能超过 512 MiB。");
    }
    attachment = Object.freeze({
      blob: input.attachment.blob,
      originalName: safeFileName(input.attachment.originalName),
      mimeType: safeMimeType(input.attachment.mimeType ?? input.attachment.blob.type),
      byteSize,
    });
  }
  return Object.freeze({
    materialId: identifier(input.materialId, "材料标识"),
    name: oneLineText(input.name, "材料名称", 240),
    kind: oneLineText(input.kind, "材料类型", 80),
    version: oneLineText(input.version, "材料版本", 80),
    updatedAt: canonicalTimestamp(input.updatedAt),
    linkedJobId: optionalIdentifier(input.linkedJobId, "关联职位标识"),
    status: normalizedStatus(input.status),
    notes: notesText(input.notes),
    attachment,
  });
}

function freezeSnapshot(
  input: Omit<CareerMaterialSaveExpectedSnapshot, "attachment"> &
    Readonly<{ attachment: CareerMaterialSaveAttachmentSnapshot | null }>,
): CareerMaterialSaveExpectedSnapshot {
  const attachment = input.attachment
    ? Object.freeze({ ...input.attachment })
    : null;
  return Object.freeze({ ...input, attachment });
}

function snapshotWithoutAttachment(
  input: NormalizedSaveInput,
): CareerMaterialSaveExpectedSnapshot {
  return freezeSnapshot({
    name: input.name,
    kind: input.kind,
    version: input.version,
    updatedAt: input.updatedAt,
    linkedJobId: input.linkedJobId,
    status: input.status,
    notes: input.notes,
    attachment: null,
  });
}

function snapshotWithAttachment(
  input: NormalizedSaveInput,
  attachment: CareerMaterialSaveAttachmentSnapshot,
): CareerMaterialSaveExpectedSnapshot {
  return freezeSnapshot({
    name: input.name,
    kind: input.kind,
    version: input.version,
    updatedAt: input.updatedAt,
    linkedJobId: input.linkedJobId,
    status: input.status,
    notes: input.notes,
    attachment,
  });
}

function normalizeExpectedSnapshot(
  input: CareerMaterialSaveExpectedSnapshot,
): CareerMaterialSaveExpectedSnapshot {
  if (!input || typeof input !== "object") invalid("材料核对快照无效。");
  const base: Omit<CareerMaterialSaveExpectedSnapshot, "attachment"> = {
    name: oneLineText(input.name, "材料名称", 240),
    kind: oneLineText(input.kind, "材料类型", 80),
    version: oneLineText(input.version, "材料版本", 80),
    updatedAt: canonicalTimestamp(input.updatedAt),
    linkedJobId: optionalIdentifier(input.linkedJobId, "关联职位标识"),
    status: normalizedStatus(input.status),
    notes: notesText(input.notes),
  };
  if (input.attachment === null) {
    return freezeSnapshot({ ...base, attachment: null });
  }
  if (!input.attachment || typeof input.attachment !== "object") {
    invalid("材料附件核对快照无效。");
  }
  const byteSize = input.attachment.byteSize;
  if (
    !Number.isSafeInteger(byteSize) ||
    byteSize <= 0 ||
    byteSize > MAX_ATTACHMENT_BYTES
  ) {
    invalid("材料附件大小无效。");
  }
  const sha256 = String(input.attachment.sha256 ?? "").toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) invalid("材料附件校验值无效。");
  return freezeSnapshot({
    ...base,
    attachment: {
      originalName: safeFileName(input.attachment.originalName),
      mimeType: safeMimeType(input.attachment.mimeType),
      byteSize,
      sha256,
    },
  });
}

async function snapshotFromExistingInput(
  runtime: CareerMaterialSaveRuntime,
  input: NormalizedSaveInput,
): Promise<CareerMaterialSaveExpectedSnapshot> {
  if (!input.attachment) return snapshotWithoutAttachment(input);
  let sha256: string;
  try {
    sha256 = (await runtime.hashBlob(input.attachment.blob)).toLowerCase();
  } catch {
    throw new CareerMaterialSaveError(
      "attachment_read_failed",
      "暂时无法读取所选附件，材料记录没有改动。",
    );
  }
  if (!SHA256_PATTERN.test(sha256)) {
    throw new CareerMaterialSaveError(
      "attachment_read_failed",
      "所选附件没有返回可核对的内容校验值，材料记录没有改动。",
    );
  }
  return snapshotWithAttachment(input, {
    originalName: input.attachment.originalName,
    mimeType: input.attachment.mimeType,
    byteSize: input.attachment.byteSize,
    sha256,
  });
}

function snapshotFromSavedMetadata(
  input: NormalizedSaveInput,
  metadata: LocalFileMetadata,
): CareerMaterialSaveExpectedSnapshot {
  const attachment = input.attachment;
  if (!attachment) return snapshotWithoutAttachment(input);
  if (
    metadata.namespace !== DATABASE ||
    !UUID_V4_PATTERN.test(metadata.key) ||
    metadata.category !== FILE_CATEGORY ||
    metadata.originalName !== attachment.originalName ||
    metadata.mimeType !== attachment.mimeType ||
    metadata.byteSize !== attachment.byteSize ||
    !SHA256_PATTERN.test(metadata.sha256)
  ) {
    throw new CareerMaterialSaveError(
      "attachment_metadata_mismatch",
      "浏览器返回的附件信息与所选文件不一致，材料记录没有写入。",
    );
  }
  return snapshotWithAttachment(input, {
    originalName: metadata.originalName,
    mimeType: metadata.mimeType,
    byteSize: metadata.byteSize,
    sha256: metadata.sha256.toLowerCase(),
  });
}

async function readMaterial(
  runtime: CareerMaterialSaveRuntime,
  materialId: string,
): Promise<StoredMaterial | null> {
  const result = await runtime.query<StoredMaterial>(
    `SELECT id,name,kind,version,updated_at,linked_job_id,status,notes,
            file_key,file_name,mime_type,byte_size
       FROM career_materials
      WHERE id = ?
      LIMIT 1`,
    [materialId],
  );
  return result.rows[0] ?? null;
}

function baseFieldsMatch(
  row: StoredMaterial,
  expected: CareerMaterialSaveExpectedSnapshot,
): boolean {
  return row.name === expected.name &&
    row.kind === expected.kind &&
    row.version === expected.version &&
    row.updated_at === expected.updatedAt &&
    row.linked_job_id === expected.linkedJobId &&
    row.status === expected.status &&
    row.notes === expected.notes;
}

async function inspectRow(
  runtime: CareerMaterialSaveRuntime,
  row: StoredMaterial,
  expected: CareerMaterialSaveExpectedSnapshot,
): Promise<Exclude<CareerMaterialSaveInspection, "absent">> {
  if (!baseFieldsMatch(row, expected)) return "conflict";
  if (expected.attachment === null) {
    return row.file_key === null &&
      row.file_name === null &&
      row.mime_type === null &&
      row.byte_size === null
      ? "exact_saved"
      : "conflict";
  }
  if (
    !row.file_key ||
    row.file_name !== expected.attachment.originalName ||
    row.mime_type !== expected.attachment.mimeType ||
    Number(row.byte_size) !== expected.attachment.byteSize
  ) {
    return "conflict";
  }
  try {
    const stored = await runtime.getFile(row.file_key);
    if (
      stored.metadata.namespace !== DATABASE ||
      stored.metadata.key !== row.file_key ||
      stored.metadata.category !== FILE_CATEGORY ||
      stored.metadata.originalName !== row.file_name ||
      stored.metadata.mimeType !== row.mime_type ||
      stored.metadata.byteSize !== Number(row.byte_size) ||
      stored.metadata.sha256.toLowerCase() !== expected.attachment.sha256
    ) {
      return "conflict";
    }
    const actualHash = (await runtime.hashBlob(stored.file)).toLowerCase();
    return SHA256_PATTERN.test(actualHash) &&
      actualHash === expected.attachment.sha256
      ? "exact_saved"
      : "conflict";
  } catch {
    return "still_unknown";
  }
}

async function inspectUnlocked(
  runtime: CareerMaterialSaveRuntime,
  materialId: string,
  expected: CareerMaterialSaveExpectedSnapshot,
): Promise<CareerMaterialSaveInspection> {
  let row: StoredMaterial | null;
  try {
    row = await readMaterial(runtime, materialId);
  } catch {
    return "still_unknown";
  }
  return row ? inspectRow(runtime, row, expected) : "absent";
}

function safeBroadcast(runtime: CareerMaterialSaveRuntime): void {
  try {
    runtime.broadcast(CHANGE_REASON);
  } catch {
    // Advisory UI refreshes must never reverse a durable save.
  }
}

function successfulResult(
  outcome: "saved" | "already_saved",
  materialId: string,
  fileKey: string | null,
): CareerMaterialSaveResult {
  return fileKey
    ? { outcome, materialId, fileKey }
    : { outcome, materialId };
}

function uncertainResult(
  materialId: string,
  expectedSnapshot: CareerMaterialSaveExpectedSnapshot,
): CareerMaterialSaveResult {
  return {
    outcome: "outcome_uncertain",
    materialId,
    expectedSnapshot,
    retryable: true,
  };
}

async function cleanupDefiniteTemporaryFile(
  runtime: CareerMaterialSaveRuntime,
  metadata: LocalFileMetadata | null,
): Promise<void> {
  if (!metadata) return;
  try {
    await runtime.deleteFile(metadata.key);
  } catch {
    throw new CareerMaterialSaveError(
      "temporary_file_cleanup_failed",
      "材料记录没有写入；浏览器仍有一个未关联的暂存文件待清理。",
    );
  }
}

export function createCareerMaterialSaveService(
  runtime: CareerMaterialSaveRuntime = defaultRuntime,
) {
  async function inspect(
    materialIdInput: string,
    expectedSnapshotInput: CareerMaterialSaveExpectedSnapshot,
  ): Promise<CareerMaterialSaveInspection> {
    const materialId = identifier(materialIdInput, "材料标识");
    const expected = normalizeExpectedSnapshot(expectedSnapshotInput);
    return runtime.withExclusiveLock(() =>
      inspectUnlocked(runtime, materialId, expected));
  }

  async function save(
    input: CareerMaterialSaveInput,
  ): Promise<CareerMaterialSaveResult> {
    // Copy every mutable caller-owned field before waiting for the Web Lock.
    const normalized = normalizeInput(input);
    return runtime.withExclusiveLock(async () => {
      let existing: StoredMaterial | null;
      try {
        existing = await readMaterial(runtime, normalized.materialId);
      } catch {
        throw new CareerMaterialSaveError(
          "inspect_failed",
          "暂时无法确认这份材料是否已经保存，没有开始新的写入。",
        );
      }

      if (existing) {
        const expected = await snapshotFromExistingInput(runtime, normalized);
        const result = await inspectRow(runtime, existing, expected);
        if (result === "exact_saved") {
          return successfulResult(
            "already_saved",
            normalized.materialId,
            existing.file_key,
          );
        }
        if (result === "conflict") {
          throw new CareerMaterialSaveError(
            "conflict",
            "这个材料标识已经对应另一份内容，没有覆盖原记录。",
          );
        }
        return uncertainResult(normalized.materialId, expected);
      }

      let metadata: LocalFileMetadata | null = null;
      let expected = snapshotWithoutAttachment(normalized);
      if (normalized.attachment) {
        try {
          metadata = await runtime.saveFile(normalized.attachment.blob, {
            originalName: normalized.attachment.originalName,
            mimeType: normalized.attachment.mimeType,
            category: FILE_CATEGORY,
            createdAt: normalized.updatedAt,
            updatedAt: normalized.updatedAt,
          });
        } catch {
          throw new CareerMaterialSaveError(
            "attachment_write_failed",
            "暂时无法把附件保存到当前浏览器，材料记录没有写入。",
          );
        }
        try {
          expected = snapshotFromSavedMetadata(normalized, metadata);
        } catch (error) {
          await cleanupDefiniteTemporaryFile(runtime, metadata);
          throw error;
        }
      }

      try {
        const result = await runtime.run(
          `INSERT INTO career_materials(
             id,name,kind,version,updated_at,linked_job_id,status,notes,
             file_key,file_name,mime_type,byte_size
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            normalized.materialId,
            expected.name,
            expected.kind,
            expected.version,
            expected.updatedAt,
            expected.linkedJobId,
            expected.status,
            expected.notes,
            metadata?.key ?? null,
            expected.attachment?.originalName ?? null,
            expected.attachment?.mimeType ?? null,
            expected.attachment?.byteSize ?? null,
          ],
        );
        if (result.changes === 1) {
          safeBroadcast(runtime);
          return successfulResult(
            "saved",
            normalized.materialId,
            metadata?.key ?? null,
          );
        }
      } catch {
        // The row may have committed before its worker response was lost.
      }

      const inspection = await inspectUnlocked(
        runtime,
        normalized.materialId,
        expected,
      );
      if (inspection === "exact_saved") {
        safeBroadcast(runtime);
        return successfulResult(
          "saved",
          normalized.materialId,
          metadata?.key ?? null,
        );
      }
      if (inspection === "absent") {
        await cleanupDefiniteTemporaryFile(runtime, metadata);
        throw new CareerMaterialSaveError(
          "write_failed",
          "这次材料记录没有写入，表单内容可以保留后重试。",
        );
      }
      if (inspection === "conflict") {
        throw new CareerMaterialSaveError(
          "conflict",
          "这个材料标识已经对应另一份内容，没有覆盖原记录。",
        );
      }
      return uncertainResult(normalized.materialId, expected);
    });
  }

  return {
    saveCareerMaterial: save,
    inspectCareerMaterialSave: inspect,
  } as const;
}

export function saveCareerMaterial(
  input: CareerMaterialSaveInput,
  runtime: CareerMaterialSaveRuntime = defaultRuntime,
) {
  return createCareerMaterialSaveService(runtime).saveCareerMaterial(input);
}

export function inspectCareerMaterialSave(
  materialId: string,
  expectedSnapshot: CareerMaterialSaveExpectedSnapshot,
  runtime: CareerMaterialSaveRuntime = defaultRuntime,
) {
  return createCareerMaterialSaveService(runtime).inspectCareerMaterialSave(
    materialId,
    expectedSnapshot,
  );
}
