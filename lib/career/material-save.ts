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
const CANONICAL_DATABASE = "zhiji" as const;
const FILE_CATEGORY = "career-material";
const CHANGE_REASON = "career-material-saved";
const CLEANUP_RECEIPT_PURPOSE = "career-material-save-cleanup" as const;
const CLEANUP_RECEIPT_VERSION = 1 as const;
const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

type QueryResult<Row> = Readonly<{ rows: readonly Row[] }>;
type RunResult = Readonly<{ changes: number }>;

type CurrentCareerGeneration = Readonly<{
  database: string;
  generationId: string;
  sequence: number;
}>;

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
  currentGeneration(): Promise<CurrentCareerGeneration>;
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
      /**
       * Present exactly when this attempt staged an attachment. Persist it
       * until inspection proves the row exact or cleanup finishes.
       */
      cleanupReceipt: CareerMaterialSaveCleanupReceipt | null;
      retryable: true;
    }>;

export type CareerMaterialSaveInspection =
  | "exact_saved"
  | "absent"
  | "conflict"
  | "still_unknown";

/**
 * JSON-safe recovery data for one unreferenced staged attachment. The payload
 * is deliberately encoded so ordinary UI state and logs never expose file_key.
 */
export type CareerMaterialSaveCleanupReceipt = Readonly<{
  purpose: typeof CLEANUP_RECEIPT_PURPOSE;
  version: typeof CLEANUP_RECEIPT_VERSION;
  opaquePayload: string;
  digest: string;
}>;

export type CareerMaterialSaveCleanupBlockedReason =
  | "generation_changed"
  | "material_present"
  | "file_referenced"
  | "file_changed";

export type CareerMaterialSaveCleanupInspection =
  | Readonly<{
      state: "cleanup_ready";
      receipt: CareerMaterialSaveCleanupReceipt;
    }>
  | Readonly<{
      state: "blocked";
      reason: CareerMaterialSaveCleanupBlockedReason;
      receipt: CareerMaterialSaveCleanupReceipt;
    }>
  | Readonly<{
      state: "still_unknown";
      receipt: CareerMaterialSaveCleanupReceipt;
      retryable: true;
    }>;

export type CareerMaterialSaveCleanupResult =
  | Readonly<{ outcome: "cleaned" | "already_cleaned" }>
  | Readonly<{
      outcome: "blocked";
      reason: CareerMaterialSaveCleanupBlockedReason;
      receipt: CareerMaterialSaveCleanupReceipt;
    }>
  | Readonly<{
      outcome: "cleanup_pending";
      receipt: CareerMaterialSaveCleanupReceipt;
      retryable: true;
    }>;

export type CareerMaterialSaveErrorCode =
  | "invalid_input"
  | "conflict"
  | "inspect_failed"
  | "attachment_read_failed"
  | "attachment_write_failed"
  | "attachment_metadata_mismatch"
  | "temporary_file_cleanup_failed"
  | "invalid_cleanup_receipt"
  | "write_failed";

export class CareerMaterialSaveError extends Error {
  readonly name = "CareerMaterialSaveError";

  constructor(
    readonly code: CareerMaterialSaveErrorCode,
    message: string,
    readonly cleanupReceipt?: CareerMaterialSaveCleanupReceipt,
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

type CareerMaterialSaveCleanupPayload = Readonly<{
  database: typeof CANONICAL_DATABASE;
  generationId: string;
  generationSequence: number;
  materialId: string;
  expectedSnapshot: CareerMaterialSaveExpectedSnapshot;
  stagedFile: LocalFileMetadata;
}>;

type CleanupSafety =
  | Readonly<{ safe: true }>
  | Readonly<{
      safe: false;
      reason: Exclude<
        CareerMaterialSaveCleanupBlockedReason,
        "file_changed"
      >;
    }>;

const defaultRuntime: CareerMaterialSaveRuntime = {
  withExclusiveLock: (operation) => withCareerWriteLock(() => operation()),
  currentGeneration: () => localDb.currentGeneration(DATABASE),
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

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]);
}

function validGeneration(value: CurrentCareerGeneration): boolean {
  return value.database === CANONICAL_DATABASE &&
    typeof value.generationId === "string" &&
    value.generationId.length > 0 &&
    value.generationId.length <= 240 &&
    Number.isSafeInteger(value.sequence) && value.sequence >= 0;
}

function sameGeneration(
  generation: CurrentCareerGeneration,
  payload: CareerMaterialSaveCleanupPayload,
): boolean {
  return generation.database === payload.database &&
    generation.generationId === payload.generationId &&
    generation.sequence === payload.generationSequence;
}

function encodeOpaquePayload(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeOpaquePayload(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid encoding");
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (encodeOpaquePayload(decoded) !== value) throw new Error("non-canonical encoding");
  return decoded;
}

function cleanupReceiptDigestInput(opaquePayload: string): string {
  // Corruption checksum, not an authentication boundary: same-origin code can
  // already reach the local database and OPFS. Deletion safety comes from the
  // locked generation, row-absence, reference, metadata, and hash checks.
  return `private-ai-suite:${CLEANUP_RECEIPT_PURPOSE}:v${CLEANUP_RECEIPT_VERSION}\n${opaquePayload}\n`;
}

async function sha256Text(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("digest unavailable");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

function normalizeStagedFileMetadata(value: unknown): LocalFileMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value, [
      "version", "key", "namespace", "originalName", "mimeType", "category",
      "byteSize", "sha256", "createdAt", "updatedAt",
    ])) {
    throw new Error("invalid staged file");
  }
  const file = value as Record<string, unknown>;
  if (
    file.version !== 1 ||
    typeof file.key !== "string" || !UUID_V4_PATTERN.test(file.key) ||
    file.namespace !== DATABASE ||
    typeof file.originalName !== "string" ||
    typeof file.mimeType !== "string" ||
    !(file.category === null || typeof file.category === "string") ||
    !Number.isSafeInteger(file.byteSize) || Number(file.byteSize) < 0 ||
    typeof file.sha256 !== "string" || !SHA256_PATTERN.test(file.sha256) ||
    typeof file.createdAt !== "string" ||
    typeof file.updatedAt !== "string"
  ) {
    throw new Error("invalid staged file fields");
  }
  return Object.freeze({
    version: 1,
    key: file.key,
    namespace: DATABASE,
    originalName: file.originalName,
    mimeType: file.mimeType,
    category: file.category,
    byteSize: Number(file.byteSize),
    sha256: file.sha256.toLowerCase(),
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  });
}

function canonicalCleanupPayload(
  generation: CurrentCareerGeneration,
  materialId: string,
  expectedSnapshot: CareerMaterialSaveExpectedSnapshot,
  stagedFile: LocalFileMetadata,
): CareerMaterialSaveCleanupPayload {
  return {
    database: CANONICAL_DATABASE,
    generationId: generation.generationId,
    generationSequence: generation.sequence,
    materialId,
    expectedSnapshot,
    stagedFile,
  };
}

async function issueCleanupReceipt(
  generation: CurrentCareerGeneration,
  materialId: string,
  expectedSnapshot: CareerMaterialSaveExpectedSnapshot,
  stagedFile: LocalFileMetadata,
): Promise<CareerMaterialSaveCleanupReceipt> {
  const opaquePayload = encodeOpaquePayload(JSON.stringify(canonicalCleanupPayload(
    generation,
    materialId,
    expectedSnapshot,
    stagedFile,
  )));
  return Object.freeze({
    purpose: CLEANUP_RECEIPT_PURPOSE,
    version: CLEANUP_RECEIPT_VERSION,
    opaquePayload,
    digest: await sha256Text(cleanupReceiptDigestInput(opaquePayload)),
  });
}

async function consumeCleanupReceipt(
  input: unknown,
): Promise<Readonly<{
  payload: CareerMaterialSaveCleanupPayload;
  receipt: CareerMaterialSaveCleanupReceipt;
}>> {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      !exactKeys(input, ["purpose", "version", "opaquePayload", "digest"])) {
      throw new Error("invalid receipt");
    }
    const candidate = input as Record<string, unknown>;
    const receipt = Object.freeze({
      purpose: candidate.purpose,
      version: candidate.version,
      opaquePayload: candidate.opaquePayload,
      digest: candidate.digest,
    });
    if (
      receipt.purpose !== CLEANUP_RECEIPT_PURPOSE ||
      receipt.version !== CLEANUP_RECEIPT_VERSION ||
      typeof receipt.opaquePayload !== "string" ||
      typeof receipt.digest !== "string" ||
      !SHA256_PATTERN.test(receipt.digest)
    ) {
      throw new Error("invalid receipt envelope");
    }
    const digest = await sha256Text(cleanupReceiptDigestInput(receipt.opaquePayload));
    if (digest !== receipt.digest) throw new Error("receipt digest mismatch");
    const decoded: unknown = JSON.parse(decodeOpaquePayload(receipt.opaquePayload));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) ||
      !exactKeys(decoded, [
        "database", "generationId", "generationSequence", "materialId",
        "expectedSnapshot", "stagedFile",
      ])) {
      throw new Error("invalid receipt payload");
    }
    const payload = decoded as Record<string, unknown>;
    if (
      payload.database !== CANONICAL_DATABASE ||
      typeof payload.generationId !== "string" ||
      payload.generationId.length === 0 || payload.generationId.length > 240 ||
      !Number.isSafeInteger(payload.generationSequence) ||
      Number(payload.generationSequence) < 0
    ) {
      throw new Error("invalid cleanup generation");
    }
    const materialId = identifier(payload.materialId, "材料标识");
    const expectedSnapshot = normalizeExpectedSnapshot(
      payload.expectedSnapshot as CareerMaterialSaveExpectedSnapshot,
    );
    const stagedFile = normalizeStagedFileMetadata(payload.stagedFile);
    if (
      !expectedSnapshot.attachment ||
      expectedSnapshot.attachment.originalName !== stagedFile.originalName ||
      expectedSnapshot.attachment.mimeType !== stagedFile.mimeType ||
      expectedSnapshot.attachment.byteSize !== stagedFile.byteSize ||
      expectedSnapshot.attachment.sha256 !== stagedFile.sha256
    ) {
      throw new Error("cleanup snapshot does not bind staged file");
    }
    return {
      receipt: receipt as CareerMaterialSaveCleanupReceipt,
      payload: {
        database: CANONICAL_DATABASE,
        generationId: payload.generationId,
        generationSequence: Number(payload.generationSequence),
        materialId,
        expectedSnapshot,
        stagedFile,
      },
    };
  } catch {
    throw new CareerMaterialSaveError(
      "invalid_cleanup_receipt",
      "这次暂存文件清理凭据已失效，请保留当前数据并重新核对。",
    );
  }
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

function snapshotForStagedFileCleanup(
  input: NormalizedSaveInput,
  metadata: LocalFileMetadata,
): CareerMaterialSaveExpectedSnapshot {
  const stagedFile = normalizeStagedFileMetadata(metadata);
  return snapshotWithAttachment(input, {
    originalName: stagedFile.originalName,
    mimeType: stagedFile.mimeType,
    byteSize: stagedFile.byteSize,
    sha256: stagedFile.sha256,
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

async function inspectCleanupSafety(
  runtime: CareerMaterialSaveRuntime,
  payload: CareerMaterialSaveCleanupPayload,
): Promise<CleanupSafety | null> {
  try {
    const before = await runtime.currentGeneration();
    if (!validGeneration(before) || !sameGeneration(before, payload)) {
      return { safe: false, reason: "generation_changed" };
    }
    const result = await runtime.query<{
      material_present: number;
      file_referenced: number;
    }>(
      `SELECT
         EXISTS(
           SELECT 1 FROM career_materials WHERE id = ?
         ) AS material_present,
         EXISTS(
           SELECT 1 FROM career_materials WHERE file_key = ?
         ) AS file_referenced`,
      [payload.materialId, payload.stagedFile.key],
    );
    const facts = result.rows[0];
    if (!facts) return null;
    if (Number(facts.material_present) === 1) {
      return { safe: false, reason: "material_present" };
    }
    if (Number(facts.file_referenced) === 1) {
      return { safe: false, reason: "file_referenced" };
    }
    const after = await runtime.currentGeneration();
    if (!validGeneration(after) || !sameGeneration(after, payload)) {
      return { safe: false, reason: "generation_changed" };
    }
    return { safe: true };
  } catch {
    return null;
  }
}

function sameStagedFile(
  actual: LocalFileMetadata,
  expected: LocalFileMetadata,
): boolean {
  return actual.version === expected.version &&
    actual.key === expected.key &&
    actual.namespace === expected.namespace &&
    actual.originalName === expected.originalName &&
    actual.mimeType === expected.mimeType &&
    actual.category === expected.category &&
    actual.byteSize === expected.byteSize &&
    actual.sha256.toLowerCase() === expected.sha256.toLowerCase() &&
    actual.createdAt === expected.createdAt &&
    actual.updatedAt === expected.updatedAt;
}

function isPartiallyOrFullyAbsentFileError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" &&
    "code" in error &&
    (error.code === "FILE_NOT_FOUND" || error.code === "FILE_BYTES_NOT_FOUND"),
  );
}

type StagedFileInspection =
  | "exact"
  | "parts_missing"
  | "changed"
  | "unknown";

async function inspectStagedFile(
  runtime: CareerMaterialSaveRuntime,
  payload: CareerMaterialSaveCleanupPayload,
): Promise<StagedFileInspection> {
  let stored: LocalFileResult;
  try {
    stored = await runtime.getFile(payload.stagedFile.key);
  } catch (error) {
    return isPartiallyOrFullyAbsentFileError(error) ? "parts_missing" : "unknown";
  }
  if (!sameStagedFile(stored.metadata, payload.stagedFile)) return "changed";
  try {
    const actualHash = (await runtime.hashBlob(stored.file)).toLowerCase();
    return SHA256_PATTERN.test(actualHash) &&
        actualHash === payload.stagedFile.sha256.toLowerCase()
      ? "exact"
      : "changed";
  } catch {
    return "unknown";
  }
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
  cleanupReceipt: CareerMaterialSaveCleanupReceipt | null = null,
): CareerMaterialSaveResult {
  return {
    outcome: "outcome_uncertain",
    materialId,
    expectedSnapshot,
    cleanupReceipt,
    retryable: true,
  };
}

async function tryCleanupStagedFileInCurrentLock(
  runtime: CareerMaterialSaveRuntime,
  payload: CareerMaterialSaveCleanupPayload,
): Promise<boolean> {
  const safety = await inspectCleanupSafety(runtime, payload);
  if (!safety?.safe) return false;
  const file = await inspectStagedFile(runtime, payload);
  if (file !== "exact" && file !== "parts_missing") return false;
  let finalGeneration: CurrentCareerGeneration;
  try {
    finalGeneration = await runtime.currentGeneration();
  } catch {
    return false;
  }
  if (!validGeneration(finalGeneration) ||
    !sameGeneration(finalGeneration, payload)) {
    return false;
  }
  try {
    await runtime.deleteFile(payload.stagedFile.key);
    return true;
  } catch {
    return false;
  }
}

async function cleanupDefiniteTemporaryFile(
  runtime: CareerMaterialSaveRuntime,
  metadata: LocalFileMetadata | null,
  generation: CurrentCareerGeneration | null,
  materialId: string,
  expectedSnapshot: CareerMaterialSaveExpectedSnapshot,
): Promise<void> {
  if (!metadata) return;
  if (!generation || !validGeneration(generation)) {
    throw new CareerMaterialSaveError(
      "temporary_file_cleanup_failed",
      "材料记录没有写入；暂时无法建立安全的暂存文件清理凭据。",
    );
  }
  let receipt: CareerMaterialSaveCleanupReceipt;
  try {
    receipt = await issueCleanupReceipt(
      generation,
      materialId,
      expectedSnapshot,
      normalizeStagedFileMetadata(metadata),
    );
  } catch {
    throw new CareerMaterialSaveError(
      "temporary_file_cleanup_failed",
      "材料记录没有写入；暂时无法建立安全的暂存文件清理凭据。",
    );
  }
  const { payload } = await consumeCleanupReceipt(receipt);
  const safety = await inspectCleanupSafety(runtime, payload);
  if (!safety?.safe) {
    throw new CareerMaterialSaveError(
      "temporary_file_cleanup_failed",
      "材料记录没有写入；暂存文件的安全清理条件需要稍后重新核对。",
      receipt,
    );
  }
  const file = await inspectStagedFile(runtime, payload);
  if (file === "parts_missing") {
    try {
      await runtime.deleteFile(metadata.key);
      return;
    } catch {
      throw new CareerMaterialSaveError(
        "temporary_file_cleanup_failed",
        "材料记录没有写入；暂存文件仍有未完成的本地清理。",
        receipt,
      );
    }
  }
  if (file !== "exact") {
    throw new CareerMaterialSaveError(
      "temporary_file_cleanup_failed",
      "材料记录没有写入；暂存文件的状态需要稍后重新核对。",
      receipt,
    );
  }
  try {
    await runtime.deleteFile(metadata.key);
  } catch {
    throw new CareerMaterialSaveError(
      "temporary_file_cleanup_failed",
      "材料记录没有写入；浏览器仍有一个未关联的暂存文件待清理。",
      receipt,
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

  async function inspectCleanup(
    receiptInput: CareerMaterialSaveCleanupReceipt,
  ): Promise<CareerMaterialSaveCleanupInspection> {
    const { payload, receipt } = await consumeCleanupReceipt(receiptInput);
    return runtime.withExclusiveLock(async () => {
      const safety = await inspectCleanupSafety(runtime, payload);
      if (!safety) return { state: "still_unknown", receipt, retryable: true };
      if (!safety.safe) {
        return { state: "blocked", reason: safety.reason, receipt };
      }
      const file = await inspectStagedFile(runtime, payload);
      if (file === "changed") {
        return { state: "blocked", reason: "file_changed", receipt };
      }
      if (file === "unknown") {
        return { state: "still_unknown", receipt, retryable: true };
      }
      return { state: "cleanup_ready", receipt };
    });
  }

  async function retryCleanup(
    receiptInput: CareerMaterialSaveCleanupReceipt,
  ): Promise<CareerMaterialSaveCleanupResult> {
    const { payload, receipt } = await consumeCleanupReceipt(receiptInput);
    return runtime.withExclusiveLock(async () => {
      const safety = await inspectCleanupSafety(runtime, payload);
      if (!safety) return { outcome: "cleanup_pending", receipt, retryable: true };
      if (!safety.safe) {
        return { outcome: "blocked", reason: safety.reason, receipt };
      }
      const file = await inspectStagedFile(runtime, payload);
      if (file === "changed") {
        return { outcome: "blocked", reason: "file_changed", receipt };
      }
      if (file === "unknown") {
        return { outcome: "cleanup_pending", receipt, retryable: true };
      }
      const finalGeneration = await runtime.currentGeneration().catch(() => null);
      if (!finalGeneration || !validGeneration(finalGeneration) ||
        !sameGeneration(finalGeneration, payload)) {
        return { outcome: "blocked", reason: "generation_changed", receipt };
      }
      try {
        return await runtime.deleteFile(payload.stagedFile.key)
          ? { outcome: "cleaned" }
          : { outcome: "already_cleaned" };
      } catch {
        return { outcome: "cleanup_pending", receipt, retryable: true };
      }
    });
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
      let stagedGeneration: CurrentCareerGeneration | null = null;
      let stagedCleanupReceipt: CareerMaterialSaveCleanupReceipt | null = null;
      let expected = snapshotWithoutAttachment(normalized);
      if (normalized.attachment) {
        try {
          stagedGeneration = await runtime.currentGeneration();
          if (!validGeneration(stagedGeneration)) throw new Error("invalid generation");
        } catch {
          throw new CareerMaterialSaveError(
            "inspect_failed",
            "暂时无法确认当前材料数据版本，没有开始新的附件写入。",
          );
        }
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
          await cleanupDefiniteTemporaryFile(
            runtime,
            metadata,
            stagedGeneration,
            normalized.materialId,
            snapshotForStagedFileCleanup(normalized, metadata),
          );
          throw error;
        }
        const cleanupPayload = canonicalCleanupPayload(
          stagedGeneration,
          normalized.materialId,
          expected,
          normalizeStagedFileMetadata(metadata),
        );
        try {
          // Sign before INSERT: every later ambiguous write can return recovery.
          stagedCleanupReceipt = await issueCleanupReceipt(
            stagedGeneration,
            normalized.materialId,
            expected,
            cleanupPayload.stagedFile,
          );
        } catch {
          const cleaned = await tryCleanupStagedFileInCurrentLock(
            runtime,
            cleanupPayload,
          );
          if (!cleaned) {
            throw new CareerMaterialSaveError(
              "temporary_file_cleanup_failed",
              "材料记录尚未开始写入，但暂存附件仍需手动核对浏览器存储。",
            );
          }
          throw new CareerMaterialSaveError(
            "write_failed",
            "无法建立这次保存的恢复凭据；暂存附件已清理，材料记录没有写入。",
          );
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
        await cleanupDefiniteTemporaryFile(
          runtime,
          metadata,
          stagedGeneration,
          normalized.materialId,
          expected,
        );
        throw new CareerMaterialSaveError(
          "write_failed",
          "这次材料记录没有写入，表单内容可以保留后重试。",
        );
      }
      if (inspection === "conflict") {
        if (metadata && stagedGeneration && stagedCleanupReceipt) {
          const cleaned = await tryCleanupStagedFileInCurrentLock(
            runtime,
            canonicalCleanupPayload(
              stagedGeneration,
              normalized.materialId,
              expected,
              normalizeStagedFileMetadata(metadata),
            ),
          );
          if (!cleaned) {
            throw new CareerMaterialSaveError(
              "temporary_file_cleanup_failed",
              "材料记录出现了另一份内容；暂存附件仍需核对，且没有删除现有材料。",
              stagedCleanupReceipt,
            );
          }
        }
        throw new CareerMaterialSaveError(
          "conflict",
          "这个材料标识已经对应另一份内容，没有覆盖原记录。",
        );
      }
      return uncertainResult(
        normalized.materialId,
        expected,
        stagedCleanupReceipt,
      );
    });
  }

  return {
    saveCareerMaterial: save,
    inspectCareerMaterialSave: inspect,
    inspectCareerMaterialSaveCleanup: inspectCleanup,
    retryCareerMaterialSaveCleanup: retryCleanup,
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

export function inspectCareerMaterialSaveCleanup(
  receipt: CareerMaterialSaveCleanupReceipt,
  runtime: CareerMaterialSaveRuntime = defaultRuntime,
) {
  return createCareerMaterialSaveService(runtime)
    .inspectCareerMaterialSaveCleanup(receipt);
}

export function retryCareerMaterialSaveCleanup(
  receipt: CareerMaterialSaveCleanupReceipt,
  runtime: CareerMaterialSaveRuntime = defaultRuntime,
) {
  return createCareerMaterialSaveService(runtime)
    .retryCareerMaterialSaveCleanup(receipt);
}
