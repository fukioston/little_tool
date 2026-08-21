import { localDb } from "@/lib/local-db/client";
import {
  assertLocalFileKeyAvailable,
  deleteOwnedLocalFile,
  deleteLocalFile,
  getLocalFile,
  listLocalFiles,
  saveLocalFileAtKey,
  sha256Blob,
  type LocalFileMetadata,
  type LocalFileResult,
  type SaveLocalFileOptions,
} from "@/lib/local-db/files";
import type { CurrentDatabaseGeneration } from "@/lib/local-db/types";
import { getFitnessExercise } from "./catalog";
import { broadcastFitnessChange, withFitnessWriteLock } from "./lock";
import type { FitnessFile } from "./types";

const DATABASE = "fitness" as const;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const PENDING_SHA256 = "0".repeat(64);
const MANAGED_CATEGORY_PREFIX = "fitness-file:";
const CANONICAL_DATABASE = "shilian" as const;
const SAVE_RECEIPT_KIND = "fitness-file-save" as const;
const DELETE_RECEIPT_KIND = "fitness-file-delete" as const;
const RECEIPT_VERSION = 1 as const;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

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

export type FitnessFileSaveReceipt = Readonly<{
  version: typeof RECEIPT_VERSION;
  kind: typeof SAVE_RECEIPT_KIND;
  operationId: string;
  database: typeof CANONICAL_DATABASE;
  generationId: string;
  generationSequence: number;
  expectedRow: Readonly<StoredFitnessFile>;
  expectedFile: Readonly<{
    version: 1;
    key: string;
    namespace: typeof DATABASE;
    originalName: string;
    mimeType: string;
    category: string;
    byteSize: number;
    sha256: string;
    createdAt: string;
    updatedAt: string;
    stagingOwner: string;
  }>;
}>;

export type FitnessFileSaveInspection =
  | "exact_saved"
  | "staged"
  | "absent"
  | "conflict"
  | "generation_changed"
  | "still_unknown";

export type FitnessFileSafeSaveResult =
  | Readonly<{
      outcome: "saved" | "already_saved";
      record: FitnessFileRecord;
      receipt: FitnessFileSaveReceipt;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      receipt: FitnessFileSaveReceipt;
      retryable: true;
    }>;

export type FitnessFileDiscardSaveResult =
  | Readonly<{
      outcome: "discarded" | "already_absent";
      receipt: FitnessFileSaveReceipt;
    }>
  | Readonly<{
      outcome: "blocked";
      reason: "saved" | "conflict" | "generation_changed";
      receipt: FitnessFileSaveReceipt;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      receipt: FitnessFileSaveReceipt;
      retryable: true;
    }>;

export type FitnessFileDeleteReceipt = Readonly<{
  version: typeof RECEIPT_VERSION;
  kind: typeof DELETE_RECEIPT_KIND;
  operationId: string;
  database: typeof CANONICAL_DATABASE;
  generationId: string;
  generationSequence: number;
  expectedRow: Readonly<StoredFitnessFile>;
  deletingUpdatedAt: number;
  expectedFile:
    | Readonly<{ state: "absent" }>
    | Readonly<{
        state: "exact";
        metadata: LocalFileMetadata;
      }>;
}>;

export type FitnessFileDeleteInspection =
  | "exact_present"
  | "deleting"
  | "absent"
  | "conflict"
  | "generation_changed"
  | "still_unknown";

export type FitnessFileSafeDeleteResult =
  | Readonly<{
      outcome: "deleted" | "already_deleted";
      receipt: FitnessFileDeleteReceipt;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      receipt: FitnessFileDeleteReceipt;
      retryable: true;
    }>
  | Readonly<{
      outcome: "conflict";
      receipt: FitnessFileDeleteReceipt;
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

export class FitnessFileOutcomeUncertainError extends FitnessFileError {
  constructor(
    message: string,
    readonly receipt: FitnessFileSaveReceipt | FitnessFileDeleteReceipt,
  ) {
    super(message, "FITNESS_FILE_OUTCOME_UNCERTAIN");
    this.name = "FitnessFileOutcomeUncertainError";
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
  currentGeneration(): Promise<CurrentDatabaseGeneration>;
  assertFileKeyAvailable(key: string): Promise<void>;
  saveFileAtKey(
    key: string,
    blob: Blob,
    options: SaveLocalFileOptions,
    stagingOwner: string,
  ): Promise<LocalFileMetadata>;
  deleteOwnedFile(key: string, stagingOwner: string): Promise<boolean>;
  getFile(key: string): Promise<LocalFileResult>;
  listFiles(): Promise<readonly LocalFileMetadata[]>;
  deleteFile(key: string): Promise<boolean>;
  hashBlob(blob: Blob): Promise<string>;
  getBuiltInExercise(id: string): ReturnType<typeof getFitnessExercise>;
  randomUUID(): string;
  randomOwner(): string;
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
  currentGeneration: () => localDb.currentGeneration(DATABASE),
  assertFileKeyAvailable: (key) => assertLocalFileKeyAvailable(DATABASE, key),
  saveFileAtKey: (key, blob, options, stagingOwner) =>
    saveLocalFileAtKey(DATABASE, key, blob, options, stagingOwner),
  deleteOwnedFile: (key, stagingOwner) =>
    deleteOwnedLocalFile(DATABASE, key, stagingOwner),
  getFile: (key) => getLocalFile(DATABASE, key),
  listFiles: () => listLocalFiles(DATABASE),
  deleteFile: (key) => deleteLocalFile(DATABASE, key),
  hashBlob: sha256Blob,
  getBuiltInExercise: getFitnessExercise,
  randomUUID: () => crypto.randomUUID(),
  randomOwner: () => Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join(""),
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

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function validGeneration(value: CurrentDatabaseGeneration): boolean {
  return value.database === CANONICAL_DATABASE &&
    typeof value.generationId === "string" &&
    value.generationId.length > 0 &&
    value.generationId.length <= 240 &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0;
}

function generationMatches(
  value: CurrentDatabaseGeneration,
  receipt: Pick<FitnessFileSaveReceipt, "database" | "generationId" | "generationSequence">,
): boolean {
  return validGeneration(value) &&
    value.database === receipt.database &&
    value.generationId === receipt.generationId &&
    value.sequence === receipt.generationSequence;
}

function validStoredRow(value: unknown): value is StoredFitnessFile {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<StoredFitnessFile>;
  return exactKeys(value, [
    "id", "entity_type", "entity_id", "purpose", "file_key", "file_name",
    "mime_type", "byte_size", "sha256", "status", "created_at", "updated_at",
  ]) &&
    typeof row.id === "string" && row.id.length > 0 && row.id.length <= 255 &&
    ["venue", "equipment", "exercise", "session"].includes(row.entity_type ?? "") &&
    typeof row.entity_id === "string" && row.entity_id.length > 0 && row.entity_id.length <= 255 &&
    ["photo", "instruction", "other"].includes(row.purpose ?? "") &&
    typeof row.file_key === "string" && UUID_V4_PATTERN.test(row.file_key) &&
    typeof row.file_name === "string" && row.file_name.length > 0 && row.file_name.length <= 255 &&
    typeof row.mime_type === "string" && row.mime_type.length > 0 && row.mime_type.length <= 127 &&
    Number.isSafeInteger(row.byte_size) && Number(row.byte_size) >= 0 &&
    typeof row.sha256 === "string" && SHA256_PATTERN.test(row.sha256) &&
    ["ready", "missing", "deleting"].includes(row.status ?? "") &&
    Number.isSafeInteger(row.created_at) && Number(row.created_at) >= 0 &&
    Number.isSafeInteger(row.updated_at) && Number(row.updated_at) >= Number(row.created_at);
}

function validMetadata(value: unknown): value is LocalFileMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<LocalFileMetadata>;
  const allowed = [
    "version", "key", "namespace", "originalName", "mimeType", "category",
    "byteSize", "sha256", "createdAt", "updatedAt", "stagingOwner",
  ];
  return Object.keys(value).every((key) => allowed.includes(key)) &&
    metadata.version === 1 &&
    typeof metadata.key === "string" && UUID_V4_PATTERN.test(metadata.key) &&
    metadata.namespace === DATABASE &&
    typeof metadata.originalName === "string" &&
    metadata.originalName.length > 0 && metadata.originalName.length <= 255 &&
    typeof metadata.mimeType === "string" &&
    metadata.mimeType.length > 0 && metadata.mimeType.length <= 127 &&
    (metadata.category === null ||
      (typeof metadata.category === "string" && metadata.category.length <= 255)) &&
    Number.isSafeInteger(metadata.byteSize) && Number(metadata.byteSize) >= 0 &&
    typeof metadata.sha256 === "string" && SHA256_PATTERN.test(metadata.sha256) &&
    typeof metadata.createdAt === "string" && Number.isFinite(Date.parse(metadata.createdAt)) &&
    typeof metadata.updatedAt === "string" && Number.isFinite(Date.parse(metadata.updatedAt)) &&
    (metadata.stagingOwner === undefined ||
      (typeof metadata.stagingOwner === "string" && SHA256_PATTERN.test(metadata.stagingOwner)));
}

function exactIsoTimestamp(value: number): string | null {
  try {
    const result = new Date(value).toISOString();
    return Number.isFinite(Date.parse(result)) ? result : null;
  } catch {
    return null;
  }
}

function rowsEqual(left: StoredFitnessFile, right: StoredFitnessFile): boolean {
  return left.id === right.id &&
    left.entity_type === right.entity_type &&
    left.entity_id === right.entity_id &&
    left.purpose === right.purpose &&
    left.file_key === right.file_key &&
    left.file_name === right.file_name &&
    left.mime_type === right.mime_type &&
    left.byte_size === right.byte_size &&
    left.sha256.toLowerCase() === right.sha256.toLowerCase() &&
    left.status === right.status &&
    left.created_at === right.created_at &&
    left.updated_at === right.updated_at;
}

function metadataEqual(left: LocalFileMetadata, right: LocalFileMetadata): boolean {
  return left.version === right.version &&
    left.key === right.key &&
    left.namespace === right.namespace &&
    left.originalName === right.originalName &&
    left.mimeType === right.mimeType &&
    left.category === right.category &&
    left.byteSize === right.byteSize &&
    left.sha256.toLowerCase() === right.sha256.toLowerCase() &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.stagingOwner === right.stagingOwner;
}

function expectedSaveMetadata(
  receipt: FitnessFileSaveReceipt,
): LocalFileMetadata {
  return receipt.expectedFile;
}

export function isFitnessFileSaveReceipt(
  value: unknown,
): value is FitnessFileSaveReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<FitnessFileSaveReceipt>;
  if (!exactKeys(value, [
    "version", "kind", "operationId", "database", "generationId",
    "generationSequence", "expectedRow", "expectedFile",
  ])) return false;
  if (
    receipt.version !== RECEIPT_VERSION ||
    receipt.kind !== SAVE_RECEIPT_KIND ||
    typeof receipt.operationId !== "string" ||
    !UUID_V4_PATTERN.test(receipt.operationId) ||
    receipt.database !== CANONICAL_DATABASE ||
    typeof receipt.generationId !== "string" ||
    receipt.generationId.length === 0 || receipt.generationId.length > 240 ||
    !Number.isSafeInteger(receipt.generationSequence) ||
    Number(receipt.generationSequence) < 0 ||
    !validStoredRow(receipt.expectedRow) ||
    !validMetadata(receipt.expectedFile)
  ) return false;
  const row = receipt.expectedRow;
  const file = receipt.expectedFile;
  const createdAt = exactIsoTimestamp(row.created_at);
  const updatedAt = exactIsoTimestamp(row.updated_at);
  return row.id === `fitness-file-${receipt.operationId.toLowerCase()}` &&
    row.status === "ready" &&
    row.file_key === file.key &&
    row.file_name === file.originalName &&
    row.mime_type === file.mimeType &&
    row.byte_size === file.byteSize &&
    row.sha256.toLowerCase() === file.sha256.toLowerCase() &&
    file.category === managedCategory(row.id) &&
    typeof file.stagingOwner === "string" && SHA256_PATTERN.test(file.stagingOwner) &&
    createdAt !== null && updatedAt !== null &&
    file.createdAt === createdAt &&
    file.updatedAt === updatedAt;
}

export function isFitnessFileDeleteReceipt(
  value: unknown,
): value is FitnessFileDeleteReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<FitnessFileDeleteReceipt>;
  if (!exactKeys(value, [
    "version", "kind", "operationId", "database", "generationId",
    "generationSequence", "expectedRow", "deletingUpdatedAt", "expectedFile",
  ])) return false;
  if (
    receipt.version !== RECEIPT_VERSION ||
    receipt.kind !== DELETE_RECEIPT_KIND ||
    typeof receipt.operationId !== "string" ||
    !UUID_V4_PATTERN.test(receipt.operationId) ||
    receipt.database !== CANONICAL_DATABASE ||
    typeof receipt.generationId !== "string" ||
    receipt.generationId.length === 0 || receipt.generationId.length > 240 ||
    !Number.isSafeInteger(receipt.generationSequence) || Number(receipt.generationSequence) < 0 ||
    !validStoredRow(receipt.expectedRow) ||
    receipt.expectedRow.status === "deleting" ||
    !Number.isSafeInteger(receipt.deletingUpdatedAt) ||
    Number(receipt.deletingUpdatedAt) < receipt.expectedRow.updated_at ||
    !receipt.expectedFile || typeof receipt.expectedFile !== "object"
  ) return false;
  if (receipt.expectedFile.state === "absent") {
    return exactKeys(receipt.expectedFile, ["state"]);
  }
  if (
    receipt.expectedFile.state !== "exact" ||
    !exactKeys(receipt.expectedFile, ["state", "metadata"]) ||
    !validMetadata(receipt.expectedFile.metadata)
  ) return false;
  const metadata = receipt.expectedFile.metadata;
  return metadataMatchesRow(metadata, receipt.expectedRow) &&
    metadata.category === managedCategory(receipt.expectedRow.id);
}

function assertSaveReceipt(value: unknown): asserts value is FitnessFileSaveReceipt {
  if (!isFitnessFileSaveReceipt(value)) {
    fail("附件保存凭据无效，没有读取或改动本地数据。", "INVALID_SAVE_RECEIPT");
  }
}

function assertDeleteReceipt(value: unknown): asserts value is FitnessFileDeleteReceipt {
  if (!isFitnessFileDeleteReceipt(value)) {
    fail("附件删除凭据无效，没有读取或改动本地数据。", "INVALID_DELETE_RECEIPT");
  }
}

type LocalFileTruth = "exact" | "absent" | "conflict" | "unknown";

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : null;
}

async function inspectLocalFileUnlocked(
  runtime: FitnessFileServiceRuntime,
  key: string,
  expected: LocalFileMetadata | null,
): Promise<LocalFileTruth> {
  if (expected === null) {
    try {
      await runtime.assertFileKeyAvailable(key);
      return "absent";
    } catch (error) {
      return errorCode(error) === "FILE_KEY_COLLISION" ? "conflict" : "unknown";
    }
  }
  try {
    const stored = await runtime.getFile(key);
    if (!metadataEqual(stored.metadata, expected)) return "conflict";
    const hash = await runtime.hashBlob(stored.file);
    return stored.file.size === expected.byteSize &&
        hash.toLowerCase() === expected.sha256.toLowerCase()
      ? "exact"
      : "conflict";
  } catch {
    try {
      await runtime.assertFileKeyAvailable(key);
      return "absent";
    } catch (error) {
      return errorCode(error) === "FILE_KEY_COLLISION" ? "unknown" : "unknown";
    }
  }
}

type SaveTruth = Readonly<{
  state: FitnessFileSaveInspection;
  row: StoredFitnessFile | null;
  file: LocalFileTruth;
}>;

async function inspectSaveUnlocked(
  runtime: FitnessFileServiceRuntime,
  receipt: FitnessFileSaveReceipt,
): Promise<SaveTruth> {
  try {
    const before = await runtime.currentGeneration();
    if (!generationMatches(before, receipt)) {
      return { state: "generation_changed", row: null, file: "unknown" };
    }
    const [row, file] = await Promise.all([
      findRow(runtime, receipt.expectedRow.id),
      inspectLocalFileUnlocked(runtime, receipt.expectedFile.key, expectedSaveMetadata(receipt)),
    ]);
    const after = await runtime.currentGeneration();
    if (!generationMatches(after, receipt)) {
      return { state: "generation_changed", row, file };
    }
    if (row && !rowsEqual(row, receipt.expectedRow)) {
      return { state: "conflict", row, file };
    }
    if (file === "conflict") return { state: "conflict", row, file };
    if (row && file === "exact") return { state: "exact_saved", row, file };
    if (!row && file === "exact") return { state: "staged", row, file };
    if (!row && file === "absent") return { state: "absent", row, file };
    return { state: "still_unknown", row, file };
  } catch {
    return { state: "still_unknown", row: null, file: "unknown" };
  }
}

function deletingRow(receipt: FitnessFileDeleteReceipt): StoredFitnessFile {
  return {
    ...receipt.expectedRow,
    status: "deleting",
    updated_at: receipt.deletingUpdatedAt,
  };
}

type DeleteTruth = Readonly<{
  state: FitnessFileDeleteInspection;
  row: StoredFitnessFile | null;
  file: LocalFileTruth;
}>;

async function inspectDeleteUnlocked(
  runtime: FitnessFileServiceRuntime,
  receipt: FitnessFileDeleteReceipt,
): Promise<DeleteTruth> {
  try {
    const before = await runtime.currentGeneration();
    if (!generationMatches(before, receipt)) {
      return { state: "generation_changed", row: null, file: "unknown" };
    }
    const expectedMetadata = receipt.expectedFile.state === "exact"
      ? receipt.expectedFile.metadata
      : null;
    const [row, file] = await Promise.all([
      findRow(runtime, receipt.expectedRow.id),
      inspectLocalFileUnlocked(runtime, receipt.expectedRow.file_key, expectedMetadata),
    ]);
    const after = await runtime.currentGeneration();
    if (!generationMatches(after, receipt)) {
      return { state: "generation_changed", row, file };
    }
    const isExpected = row ? rowsEqual(row, receipt.expectedRow) : false;
    const isDeleting = row ? rowsEqual(row, deletingRow(receipt)) : false;
    if (row && !isExpected && !isDeleting) {
      return { state: "conflict", row, file };
    }
    if (file === "conflict") return { state: "conflict", row, file };
    const expectedFileMatches = receipt.expectedFile.state === "exact"
      ? file === "exact"
      : file === "absent";
    if (isExpected && expectedFileMatches) {
      return { state: "exact_present", row, file };
    }
    if (isExpected && (file === "exact" || file === "absent")) {
      return { state: "conflict", row, file };
    }
    if ((isDeleting || !row) && file === "exact") {
      return { state: "deleting", row, file };
    }
    if (isDeleting && file === "absent") {
      return { state: "deleting", row, file };
    }
    if (!row && file === "absent") return { state: "absent", row, file };
    return { state: "still_unknown", row, file };
  } catch {
    return { state: "still_unknown", row: null, file: "unknown" };
  }
}

function safeBroadcast(runtime: FitnessFileServiceRuntime, reason: string): void {
  try {
    runtime.broadcast(reason);
  } catch {
    // Notifications are advisory. Durable storage truth never rolls back because
    // another tab could not be notified.
  }
}

const FULL_ROW_CAS_PREDICATE = `id = ? AND entity_type = ? AND entity_id = ?
  AND purpose = ? AND file_key = ? AND file_name = ? AND mime_type = ?
  AND byte_size = ? AND sha256 = ? AND status = ? AND created_at = ?
  AND updated_at = ?`;

function fullRowParams(row: StoredFitnessFile): readonly (string | number)[] {
  return [
    row.id,
    row.entity_type,
    row.entity_id,
    row.purpose,
    row.file_key,
    row.file_name,
    row.mime_type,
    row.byte_size,
    row.sha256,
    row.status,
    row.created_at,
    row.updated_at,
  ];
}

function markDeletingCas(
  runtime: FitnessFileServiceRuntime,
  expected: StoredFitnessFile,
  updatedAt: number,
): Promise<RunResult> {
  return runtime.run(
    `UPDATE fitness_files SET status = 'deleting', updated_at = ?
      WHERE ${FULL_ROW_CAS_PREDICATE}`,
    [updatedAt, ...fullRowParams(expected)],
  );
}

function deleteRowCas(
  runtime: FitnessFileServiceRuntime,
  expected: StoredFitnessFile,
): Promise<RunResult> {
  return runtime.run(
    `DELETE FROM fitness_files WHERE ${FULL_ROW_CAS_PREDICATE}`,
    fullRowParams(expected),
  );
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
      // A deleting row alone does not carry the operation's owner capability.
      // Reconciliation may finish only the non-destructive half when OPFS proves
      // the key wholly absent. A persisted delete receipt performs owned cleanup.
      try {
        await runtime.assertFileKeyAvailable(row.file_key);
        const removed = await deleteRowCas(runtime, row);
        if (removed.changes === 1) {
          survivingRows.delete(row.id);
          result.completedDeletes += 1;
        }
      } catch {
        // Present, partial, foreign, or temporarily unreadable bytes are retained.
      }
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
          if (!metadata.stagingOwner) {
            await runtime.deleteFile(metadata.key);
            deletedLocalKeys.add(metadata.key);
          }
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
        const update = await runtime.run(
          `UPDATE fitness_files
             SET file_key = ?, file_name = ?, mime_type = ?, byte_size = ?, sha256 = ?,
                 status = 'ready', updated_at = ?
           WHERE ${FULL_ROW_CAS_PREDICATE}`,
          [
            adopted.key,
            adopted.originalName,
            adopted.mimeType,
            adopted.byteSize,
            adopted.sha256,
            now,
            ...fullRowParams(row),
          ],
        );
        if (update.changes !== 1) continue;
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
          if (duplicate.stagingOwner) continue;
          await runtime.deleteFile(duplicate.key);
          deletedLocalKeys.add(duplicate.key);
        }
      } else {
        const removed = await deleteRowCas(runtime, row);
        if (removed.changes !== 1) continue;
        survivingRows.delete(row.id);
        result.discardedPending += 1;
        for (const metadata of valid) {
          if (metadata.stagingOwner) continue;
          await runtime.deleteFile(metadata.key);
          deletedLocalKeys.add(metadata.key);
        }
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
    // New safe writes keep an owner on their staged object. Only their persisted
    // receipt may clean it; a refresh must not convert uncertainty into deletion.
    if (metadata.stagingOwner) continue;
    // A legacy managed abandoned/duplicate object remains safe to clean. Unknown
    // OPFS files and complete user files with another category are never touched.
    await runtime.deleteFile(metadata.key);
    result.deletedManagedOrphans += 1;
  }
  return result;
}

export function createFitnessFileService(runtime: FitnessFileServiceRuntime) {
  async function reconcile(): Promise<FitnessFileReconcileResult> {
    return runtime.withExclusiveLock(async () => {
      const result = await reconcileUnlocked(runtime);
      if (reconcileChanged(result)) safeBroadcast(runtime, "fitness-files-reconciled");
      return result;
    });
  }

  async function prepareSave(
    input: SaveFitnessFileInput,
  ): Promise<FitnessFileSaveReceipt> {
    assertEntityType(input.entityType);
    assertPurpose(input.purpose);
    const entityId = normalizeIdentifier(input.entityId, "附件归属 ID");
    const format = await validateFile(input.file, input.purpose);
    const fileSha256 = (await runtime.hashBlob(input.file)).toLowerCase();
    if (!SHA256_PATTERN.test(fileSha256)) {
      fail("无法核对待保存附件的完整性。", "FILE_HASH_FAILED");
    }

    return runtime.withExclusiveLock(async () => {
      const generation = await runtime.currentGeneration();
      if (!validGeneration(generation)) {
        fail("无法确认当前适练数据版本，没有开始附件写入。", "GENERATION_UNAVAILABLE");
      }
      await requireEntity(runtime, input.entityType, entityId);
      const afterEntity = await runtime.currentGeneration();
      if (
        afterEntity.generationId !== generation.generationId ||
        afterEntity.sequence !== generation.sequence ||
        afterEntity.database !== generation.database
      ) {
        fail("适练数据版本刚刚发生变化，请重新选择附件。", "GENERATION_CHANGED");
      }
      const operationId = runtime.randomUUID().toLowerCase();
      const fileKey = runtime.randomUUID().toLowerCase();
      const stagingOwner = runtime.randomOwner().toLowerCase();
      if (
        !UUID_V4_PATTERN.test(operationId) ||
        !UUID_V4_PATTERN.test(fileKey) ||
        !SHA256_PATTERN.test(stagingOwner)
      ) {
        fail("无法生成安全的附件标识。", "INVALID_GENERATED_KEY");
      }
      const now = runtime.now();
      const timestamp = Number.isSafeInteger(now) && now >= 0
        ? exactIsoTimestamp(now)
        : null;
      if (timestamp === null) {
        fail("无法建立可靠的附件时间标记。", "INVALID_TIMESTAMP");
      }
      const id = `fitness-file-${operationId}`;
      const fileName = safeFileName(input.file.name);
      const expectedRow: StoredFitnessFile = {
        id,
        entity_type: input.entityType,
        entity_id: entityId,
        purpose: input.purpose,
        file_key: fileKey,
        file_name: fileName,
        mime_type: format.mimeType,
        byte_size: input.file.size,
        sha256: fileSha256,
        status: "ready",
        created_at: now,
        updated_at: now,
      };
      const expectedFile = {
        version: 1 as const,
        key: fileKey,
        namespace: DATABASE,
        originalName: fileName,
        mimeType: format.mimeType,
        category: managedCategory(id),
        byteSize: input.file.size,
        sha256: fileSha256,
        createdAt: timestamp,
        updatedAt: timestamp,
        stagingOwner,
      };
      return Object.freeze({
        version: RECEIPT_VERSION,
        kind: SAVE_RECEIPT_KIND,
        operationId,
        database: CANONICAL_DATABASE,
        generationId: generation.generationId,
        generationSequence: generation.sequence,
        expectedRow: Object.freeze(expectedRow),
        expectedFile: Object.freeze(expectedFile),
      });
    });
  }

  async function assertInputMatchesSaveReceipt(
    input: SaveFitnessFileInput,
    receipt: FitnessFileSaveReceipt,
  ): Promise<void> {
    assertEntityType(input.entityType);
    assertPurpose(input.purpose);
    const entityId = normalizeIdentifier(input.entityId, "附件归属 ID");
    const format = await validateFile(input.file, input.purpose);
    const hash = (await runtime.hashBlob(input.file)).toLowerCase();
    const row = receipt.expectedRow;
    if (
      input.entityType !== row.entity_type ||
      entityId !== row.entity_id ||
      input.purpose !== row.purpose ||
      safeFileName(input.file.name) !== row.file_name ||
      format.mimeType !== row.mime_type ||
      input.file.size !== row.byte_size ||
      hash !== row.sha256.toLowerCase()
    ) {
      fail("当前附件与已保存的恢复凭据不一致，没有写入。", "SAVE_RECEIPT_INPUT_MISMATCH");
    }
  }

  async function inspectSave(
    receiptInput: FitnessFileSaveReceipt,
  ): Promise<FitnessFileSaveInspection> {
    assertSaveReceipt(receiptInput);
    return runtime.withExclusiveLock(async () =>
      (await inspectSaveUnlocked(runtime, receiptInput)).state
    );
  }

  async function cleanupAbsentSaveStageUnlocked(
    receipt: FitnessFileSaveReceipt,
  ): Promise<boolean> {
    try {
      const generation = await runtime.currentGeneration();
      if (!generationMatches(generation, receipt)) return false;
      if (await findRow(runtime, receipt.expectedRow.id)) return false;
      const file = await inspectLocalFileUnlocked(
        runtime,
        receipt.expectedFile.key,
        expectedSaveMetadata(receipt),
      );
      if (file === "absent") return true;
      await runtime.deleteOwnedFile(
        receipt.expectedFile.key,
        receipt.expectedFile.stagingOwner,
      );
      const afterGeneration = await runtime.currentGeneration();
      if (!generationMatches(afterGeneration, receipt)) return false;
      if (await findRow(runtime, receipt.expectedRow.id)) return false;
      return await inspectLocalFileUnlocked(
        runtime,
        receipt.expectedFile.key,
        expectedSaveMetadata(receipt),
      ) === "absent";
    } catch {
      return false;
    }
  }

  async function resumeSave(
    receiptInput: FitnessFileSaveReceipt,
  ): Promise<FitnessFileSafeSaveResult> {
    assertSaveReceipt(receiptInput);
    const receipt = receiptInput;
    return runtime.withExclusiveLock(async () => {
      let truth = await inspectSaveUnlocked(runtime, receipt);
      if (truth.state === "exact_saved") {
        return {
          outcome: "already_saved",
          record: publicRecord(receipt.expectedRow),
          receipt,
        };
      }
      if (truth.state === "generation_changed") {
        fail("适练数据版本已变化，这张附件票据没有改动新版本。", "GENERATION_CHANGED");
      }
      if (truth.state === "conflict") {
        fail("附件恢复票据与当前数据冲突，没有覆盖任何内容。", "SAVE_CONFLICT");
      }
      if (truth.state === "absent") {
        fail("这张票据没有可恢复的附件字节，请重新选择原文件。", "SAVE_STAGE_ABSENT");
      }
      if (truth.state === "still_unknown") {
        return { outcome: "outcome_uncertain", receipt, retryable: true };
      }

      await requireEntity(
        runtime,
        receipt.expectedRow.entity_type,
        receipt.expectedRow.entity_id,
      );
      const generation = await runtime.currentGeneration();
      if (!generationMatches(generation, receipt)) {
        fail("适练数据版本已变化，没有把旧附件关联到新版本。", "GENERATION_CHANGED");
      }
      const row = receipt.expectedRow;
      try {
        await runtime.run(
          `INSERT INTO fitness_files(
             id,entity_type,entity_id,purpose,file_key,file_name,mime_type,
             byte_size,sha256,status,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            row.id,
            row.entity_type,
            row.entity_id,
            row.purpose,
            row.file_key,
            row.file_name,
            row.mime_type,
            row.byte_size,
            row.sha256,
            row.status,
            row.created_at,
            row.updated_at,
          ],
        );
      } catch {
        // A committed INSERT is accepted only after the exact read below.
      }
      truth = await inspectSaveUnlocked(runtime, receipt);
      if (truth.state === "exact_saved") {
        safeBroadcast(runtime, "fitness-file-saved");
        return {
          outcome: "saved",
          record: publicRecord(receipt.expectedRow),
          receipt,
        };
      }
      if (truth.state === "conflict") {
        fail("附件恢复时出现了另一份记录，没有覆盖它。", "SAVE_CONFLICT");
      }
      return { outcome: "outcome_uncertain", receipt, retryable: true };
    });
  }

  async function discardSave(
    receiptInput: FitnessFileSaveReceipt,
  ): Promise<FitnessFileDiscardSaveResult> {
    assertSaveReceipt(receiptInput);
    const receipt = receiptInput;
    return runtime.withExclusiveLock(async () => {
      const generation = await runtime.currentGeneration();
      if (!generationMatches(generation, receipt)) {
        return { outcome: "blocked", reason: "generation_changed", receipt };
      }
      let row: StoredFitnessFile | null;
      try {
        row = await findRow(runtime, receipt.expectedRow.id);
      } catch {
        return { outcome: "outcome_uncertain", receipt, retryable: true };
      }
      if (row) {
        return rowsEqual(row, receipt.expectedRow)
          ? { outcome: "blocked", reason: "saved", receipt }
          : { outcome: "blocked", reason: "conflict", receipt };
      }
      const fileBeforeCleanup = await inspectLocalFileUnlocked(
        runtime,
        receipt.expectedFile.key,
        expectedSaveMetadata(receipt),
      );
      if (fileBeforeCleanup === "absent") {
        return { outcome: "already_absent", receipt };
      }
      const cleaned = await cleanupAbsentSaveStageUnlocked(receipt);
      if (!cleaned) {
        return fileBeforeCleanup === "conflict"
          ? { outcome: "blocked", reason: "conflict", receipt }
          : { outcome: "outcome_uncertain", receipt, retryable: true };
      }
      const finalGeneration = await runtime.currentGeneration();
      if (!generationMatches(finalGeneration, receipt)) {
        return { outcome: "outcome_uncertain", receipt, retryable: true };
      }
      return { outcome: "discarded", receipt };
    });
  }

  async function saveSafely(
    input: SaveFitnessFileInput,
    receiptInput: FitnessFileSaveReceipt,
  ): Promise<FitnessFileSafeSaveResult> {
    assertSaveReceipt(receiptInput);
    await assertInputMatchesSaveReceipt(input, receiptInput);
    const receipt = receiptInput;
    return runtime.withExclusiveLock(async () => {
      let truth = await inspectSaveUnlocked(runtime, receipt);
      if (truth.state === "exact_saved") {
        return {
          outcome: "already_saved",
          record: publicRecord(receipt.expectedRow),
          receipt,
        };
      }
      if (truth.state === "generation_changed") {
        fail("适练数据版本已变化，这张附件票据没有改动新版本。", "GENERATION_CHANGED");
      }
      if (truth.state === "conflict") {
        const cleaned = await cleanupAbsentSaveStageUnlocked(receipt);
        if (cleaned) {
          fail("附件字节校验失败；已按本次 owner 凭据清理，没有写入记录。", "FILE_METADATA_MISMATCH");
        }
        fail("附件标识已对应另一份数据，没有覆盖现有内容。", "SAVE_CONFLICT");
      }
      if (truth.state === "still_unknown") {
        return { outcome: "outcome_uncertain", receipt, retryable: true };
      }

      await requireEntity(
        runtime,
        receipt.expectedRow.entity_type,
        receipt.expectedRow.entity_id,
      );
      const beforeWrite = await runtime.currentGeneration();
      if (!generationMatches(beforeWrite, receipt)) {
        fail("适练数据版本已变化，这张附件票据没有改动新版本。", "GENERATION_CHANGED");
      }

      if (truth.state === "absent") {
        try {
          await runtime.assertFileKeyAvailable(receipt.expectedFile.key);
          await runtime.saveFileAtKey(
            receipt.expectedFile.key,
            input.file,
            {
              originalName: receipt.expectedFile.originalName,
              mimeType: receipt.expectedFile.mimeType,
              category: receipt.expectedFile.category,
              createdAt: receipt.expectedFile.createdAt,
              updatedAt: receipt.expectedFile.updatedAt,
            },
            receipt.expectedFile.stagingOwner,
          );
        } catch {
          // A worker response can be lost after the exact object is durable.
        }
        truth = await inspectSaveUnlocked(runtime, receipt);
        if (truth.state === "absent") {
          fail("附件字节没有写入，原文件仍可直接重试。", "FILE_WRITE_FAILED");
        }
        if (truth.state === "generation_changed") {
          fail("适练数据版本已变化，未把附件关联到新版本。", "GENERATION_CHANGED");
        }
        if (truth.state === "conflict") {
          const cleaned = await cleanupAbsentSaveStageUnlocked(receipt);
          if (cleaned) {
            fail("附件字节校验失败；已按本次 owner 凭据清理，没有写入记录。", "FILE_METADATA_MISMATCH");
          }
          fail("附件键已被其他内容占用，没有覆盖它。", "SAVE_CONFLICT");
        }
        if (truth.state === "still_unknown") {
          return { outcome: "outcome_uncertain", receipt, retryable: true };
        }
      }

      if (truth.state === "exact_saved") {
        safeBroadcast(runtime, "fitness-file-saved");
        return {
          outcome: "saved",
          record: publicRecord(receipt.expectedRow),
          receipt,
        };
      }

      const beforeInsert = await runtime.currentGeneration();
      if (!generationMatches(beforeInsert, receipt)) {
        fail("适练数据版本已变化，未把附件关联到新版本。", "GENERATION_CHANGED");
      }
      try {
        const row = receipt.expectedRow;
        await runtime.run(
          `INSERT INTO fitness_files(
             id,entity_type,entity_id,purpose,file_key,file_name,mime_type,
             byte_size,sha256,status,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            row.id,
            row.entity_type,
            row.entity_id,
            row.purpose,
            row.file_key,
            row.file_name,
            row.mime_type,
            row.byte_size,
            row.sha256,
            row.status,
            row.created_at,
            row.updated_at,
          ],
        );
      } catch {
        // Inspect below distinguishes a committed INSERT from a definite absence.
      }

      truth = await inspectSaveUnlocked(runtime, receipt);
      if (truth.state === "exact_saved") {
        safeBroadcast(runtime, "fitness-file-saved");
        return {
          outcome: "saved",
          record: publicRecord(receipt.expectedRow),
          receipt,
        };
      }
      if (truth.state === "generation_changed") {
        return { outcome: "outcome_uncertain", receipt, retryable: true };
      }
      if (truth.state === "conflict") {
        fail("附件记录已出现另一份内容，没有覆盖现有数据。", "SAVE_CONFLICT");
      }
      if (truth.state === "staged") {
        const cleaned = await cleanupAbsentSaveStageUnlocked(receipt);
        if (cleaned) {
          fail("附件记录没有写入；本次明确无引用的暂存字节已清理。", "SAVE_NOT_COMMITTED");
        }
      }
      if (truth.state === "absent") {
        fail("附件记录没有写入，原文件仍可直接重试。", "SAVE_NOT_COMMITTED");
      }
      return { outcome: "outcome_uncertain", receipt, retryable: true };
    });
  }

  async function save(input: SaveFitnessFileInput): Promise<FitnessFileRecord> {
    const receipt = await prepareSave(input);
    const result = await saveSafely(input, receipt);
    if (result.outcome === "outcome_uncertain") {
      throw new FitnessFileOutcomeUncertainError(
        "附件保存结果暂时无法确认；请保留恢复凭据并只做核对。",
        receipt,
      );
    }
    return result.record;
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
        safeBroadcast(runtime, "fitness-file-missing");
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
      if (reconcileChanged(reconciled)) safeBroadcast(runtime, "fitness-files-reconciled");
      return rows.filter((row) =>
        (input.entityType === undefined || row.entity_type === input.entityType) &&
        (entityId === undefined || row.entity_id === entityId) &&
        (input.status === undefined || row.status === input.status),
      );
    });
  }

  async function prepareDelete(
    idInput: string,
  ): Promise<FitnessFileDeleteReceipt | null> {
    const id = normalizeIdentifier(idInput, "附件 ID");
    return runtime.withExclusiveLock(async () => {
      const generation = await runtime.currentGeneration();
      if (!validGeneration(generation)) {
        fail("无法确认当前适练数据版本，没有开始删除。", "GENERATION_UNAVAILABLE");
      }
      const row = await findRow(runtime, id);
      if (!row) return null;
      if (row.status === "deleting" || isPending(row)) {
        fail("这条附件已有未完成操作，请先完成核对。", "DELETE_PREPARE_CONFLICT");
      }
      let expectedFile: FitnessFileDeleteReceipt["expectedFile"];
      try {
        const stored = await runtime.getFile(row.file_key);
        const hash = (await runtime.hashBlob(stored.file)).toLowerCase();
        if (
          !metadataMatchesRow(stored.metadata, row) ||
          stored.metadata.category !== managedCategory(row.id) ||
          stored.file.size !== row.byte_size ||
          hash !== row.sha256.toLowerCase()
        ) {
          fail("附件记录与本地字节不一致，没有开始删除。", "DELETE_FILE_CONFLICT");
        }
        expectedFile = {
          state: "exact",
          metadata: Object.freeze({ ...stored.metadata, sha256: stored.metadata.sha256.toLowerCase() }),
        };
      } catch (error) {
        if (error instanceof FitnessFileError) throw error;
        try {
          await runtime.assertFileKeyAvailable(row.file_key);
          expectedFile = { state: "absent" };
        } catch {
          fail("暂时无法确认附件字节归属，没有开始删除。", "DELETE_FILE_INSPECTION_FAILED");
        }
      }
      const afterRead = await runtime.currentGeneration();
      if (
        afterRead.database !== generation.database ||
        afterRead.generationId !== generation.generationId ||
        afterRead.sequence !== generation.sequence
      ) {
        fail("适练数据版本刚刚发生变化，没有删除任何内容。", "GENERATION_CHANGED");
      }
      const operationId = runtime.randomUUID().toLowerCase();
      if (!UUID_V4_PATTERN.test(operationId)) {
        fail("无法生成安全的删除标识。", "INVALID_GENERATED_KEY");
      }
      const deletionTime = runtime.now();
      if (!Number.isSafeInteger(deletionTime) || deletionTime < 0) {
        fail("无法建立可靠的删除时间标记。", "INVALID_TIMESTAMP");
      }
      return Object.freeze({
        version: RECEIPT_VERSION,
        kind: DELETE_RECEIPT_KIND,
        operationId,
        database: CANONICAL_DATABASE,
        generationId: generation.generationId,
        generationSequence: generation.sequence,
        expectedRow: Object.freeze({ ...row }),
        deletingUpdatedAt: Math.max(row.updated_at, deletionTime),
        expectedFile: Object.freeze(expectedFile),
      });
    });
  }

  async function inspectDelete(
    receiptInput: FitnessFileDeleteReceipt,
  ): Promise<FitnessFileDeleteInspection> {
    assertDeleteReceipt(receiptInput);
    return runtime.withExclusiveLock(async () =>
      (await inspectDeleteUnlocked(runtime, receiptInput)).state
    );
  }

  async function deleteExpectedFileUnlocked(
    receipt: FitnessFileDeleteReceipt,
  ): Promise<LocalFileTruth> {
    const expected = receipt.expectedFile;
    let truth = await inspectLocalFileUnlocked(
      runtime,
      receipt.expectedRow.file_key,
      expected.state === "exact" ? expected.metadata : null,
    );
    if (truth === "absent") return truth;
    if (truth !== "exact" || expected.state !== "exact") return truth;
    try {
      if (expected.metadata.stagingOwner) {
        await runtime.deleteOwnedFile(
          expected.metadata.key,
          expected.metadata.stagingOwner,
        );
      } else {
        await runtime.deleteFile(expected.metadata.key);
      }
    } catch {
      // The removal response can be lost after both OPFS entries disappear.
    }
    truth = await inspectLocalFileUnlocked(
      runtime,
      receipt.expectedRow.file_key,
      expected.metadata,
    );
    return truth;
  }

  async function deleteSafely(
    receiptInput: FitnessFileDeleteReceipt,
  ): Promise<FitnessFileSafeDeleteResult> {
    assertDeleteReceipt(receiptInput);
    const receipt = receiptInput;
    return runtime.withExclusiveLock(async () => {
      let truth = await inspectDeleteUnlocked(runtime, receipt);
      if (truth.state === "absent") {
        return { outcome: "already_deleted", receipt };
      }
      if (truth.state === "generation_changed" || truth.state === "conflict") {
        return { outcome: "conflict", receipt };
      }
      if (truth.state === "still_unknown") {
        return { outcome: "outcome_uncertain", receipt, retryable: true };
      }

      if (truth.state === "exact_present") {
        const generation = await runtime.currentGeneration();
        if (!generationMatches(generation, receipt)) {
          return { outcome: "conflict", receipt };
        }
        try {
          await markDeletingCas(
            runtime,
            receipt.expectedRow,
            receipt.deletingUpdatedAt,
          );
        } catch {
          // Inspect the complete old/deleting projection before any file delete.
        }
        truth = await inspectDeleteUnlocked(runtime, receipt);
        if (truth.state === "exact_present") {
          fail("删除标记没有写入，附件和记录都保持原样。", "DELETE_NOT_STARTED");
        }
        if (truth.state === "generation_changed" || truth.state === "conflict") {
          return { outcome: "conflict", receipt };
        }
        if (truth.state === "still_unknown") {
          return { outcome: "outcome_uncertain", receipt, retryable: true };
        }
        if (truth.state === "absent") {
          safeBroadcast(runtime, "fitness-file-deleted");
          return { outcome: "deleted", receipt };
        }
      }

      const generationBeforeFile = await runtime.currentGeneration();
      if (!generationMatches(generationBeforeFile, receipt)) {
        return { outcome: "conflict", receipt };
      }
      const current = await findRow(runtime, receipt.expectedRow.id);
      if (current && !rowsEqual(current, deletingRow(receipt))) {
        return { outcome: "conflict", receipt };
      }
      const fileTruth = await deleteExpectedFileUnlocked(receipt);
      if (fileTruth === "conflict") return { outcome: "conflict", receipt };
      if (fileTruth !== "absent") {
        return { outcome: "outcome_uncertain", receipt, retryable: true };
      }

      const generationBeforeRowDelete = await runtime.currentGeneration();
      if (!generationMatches(generationBeforeRowDelete, receipt)) {
        return { outcome: "conflict", receipt };
      }
      const beforeDelete = await findRow(runtime, receipt.expectedRow.id);
      if (beforeDelete && !rowsEqual(beforeDelete, deletingRow(receipt))) {
        return { outcome: "conflict", receipt };
      }
      if (beforeDelete) {
        try {
          await deleteRowCas(runtime, deletingRow(receipt));
        } catch {
          // Final read below is authoritative if the response was lost.
        }
      }
      truth = await inspectDeleteUnlocked(runtime, receipt);
      if (truth.state === "absent") {
        safeBroadcast(runtime, "fitness-file-deleted");
        return { outcome: "deleted", receipt };
      }
      if (truth.state === "generation_changed" || truth.state === "conflict") {
        return { outcome: "conflict", receipt };
      }
      return { outcome: "outcome_uncertain", receipt, retryable: true };
    });
  }

  async function remove(idInput: string): Promise<boolean> {
    const receipt = await prepareDelete(idInput);
    if (!receipt) return false;
    const result = await deleteSafely(receipt);
    if (result.outcome === "conflict") {
      fail("附件在删除前已发生变化，没有删除新内容。", "DELETE_CONFLICT");
    }
    if (result.outcome === "outcome_uncertain") {
      throw new FitnessFileOutcomeUncertainError(
        "附件删除结果暂时无法确认；请保留恢复凭据并只做核对。",
        receipt,
      );
    }
    return true;
  }

  return {
    initializeFitnessFiles: reconcile,
    prepareFitnessFileSave: prepareSave,
    saveFitnessFileSafely: saveSafely,
    resumeFitnessFileSave: resumeSave,
    discardFitnessFileSave: discardSave,
    inspectFitnessFileSave: inspectSave,
    saveFitnessFile: save,
    getFitnessFile: get,
    getFitnessFileBlob: getBlob,
    listFitnessFiles: list,
    prepareFitnessFileDelete: prepareDelete,
    deleteFitnessFileSafely: deleteSafely,
    inspectFitnessFileDelete: inspectDelete,
    deleteFitnessFile: remove,
  } as const;
}

const service = createFitnessFileService(defaultRuntime);

export const initializeFitnessFiles = service.initializeFitnessFiles;
export const prepareFitnessFileSave = service.prepareFitnessFileSave;
export const saveFitnessFileSafely = service.saveFitnessFileSafely;
export const resumeFitnessFileSave = service.resumeFitnessFileSave;
export const discardFitnessFileSave = service.discardFitnessFileSave;
export const inspectFitnessFileSave = service.inspectFitnessFileSave;
export const saveFitnessFile = service.saveFitnessFile;
export const getFitnessFile = service.getFitnessFile;
export const getFitnessFileBlob = service.getFitnessFileBlob;
export const listFitnessFiles = service.listFitnessFiles;
export const prepareFitnessFileDelete = service.prepareFitnessFileDelete;
export const deleteFitnessFileSafely = service.deleteFitnessFileSafely;
export const inspectFitnessFileDelete = service.inspectFitnessFileDelete;
export const deleteFitnessFile = service.deleteFitnessFile;
