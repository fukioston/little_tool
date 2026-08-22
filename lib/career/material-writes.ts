import type { SqlStatement } from "@/lib/local-db/types";
import type { LocalFileMetadata } from "@/lib/local-db/files";
import type { Job, Material } from "./types";
import {
  type CareerMaterialFileCleanupReceipt,
  type CareerMaterialCapabilityBinding,
  type CareerMaterialDeleteFilePayload,
  type CareerMaterialDeleteFileReceipt,
  type CareerMaterialStagedFile,
  type CareerMaterialWriteFileRuntime,
  CareerMaterialCapabilityPersistenceUnknownError,
  careerMaterialDeletionOwner,
  careerMaterialStagingOwner,
  completeCareerMaterialFileCapabilityReceipt,
  createCareerMaterialFileCleanupReceipt,
  defaultCareerMaterialWriteFileRuntime,
  isCareerMaterialDeleteFileReceipt,
  isCareerMaterialFileCleanupReceipt,
  isLocalFileMissingError,
  issueCareerMaterialFileCleanupReceipt,
  issueCareerMaterialDeleteFileReceipt,
  releaseCareerMaterialFileCapabilityReceipt,
  resolveCareerMaterialDeleteFileReceipt,
  resolveCareerMaterialFileCleanupReceipt,
  sameCareerMaterialCapabilityBinding,
  sameCareerMaterialStagedFile,
} from "./material-write-files";
import {
  CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
  CAREER_WRITE_RECEIPT_VERSION,
  type CareerWriteCommitResult,
  type CareerWriteGenerationExpectation,
  type CareerWriteInspection,
  type CareerWriteReceiptBase,
  type CareerWriteStorageRuntime,
  abortUnless,
  careerWriteError,
  careerWriteReceiptHashIsValid,
  compareSqliteBinaryText,
  defaultCareerWriteStorageRuntime,
  exactCareerWriteMarker,
  exactKeys,
  generatedCareerWriteOperationId,
  isCanonicalIsoTimestamp,
  isCareerWriteGeneration,
  isCareerWriteOperationId,
  jsonClone,
  markerAbsentPredicate,
  markerStatement,
  readCareerWriteMarker,
  readCurrentCareerWriteGeneration,
  requireCurrentCareerWriteGeneration,
  safeCareerWriteBroadcast,
  sameCareerWriteGeneration,
  sealCareerWriteReceipt,
  strictlyLaterTimestamp,
  withCareerWritePrepareLock,
} from "./write-marker";

const PURPOSE = "career-material-write" as const;
const CATEGORY = "career-material" as const;
const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const MATERIAL_KEYS = [
  "id", "name", "kind", "version", "updated_at", "linked_job_id", "status",
  "notes", "file_key", "file_name", "mime_type", "byte_size",
] as const;
const MATERIAL_PROJECTION_KEYS = [
  "id", "name", "kind", "version", "updated_at", "linked_job_id", "status",
  "notes", "file_name", "mime_type", "byte_size", "has_attachment",
] as const;
const FILE_PROJECTION_KEYS = [
  "version", "namespace", "originalName", "mimeType", "category", "byteSize",
  "sha256", "createdAt", "updatedAt",
] as const;
const JOB_KEYS = [
  "id", "company", "role", "location", "source", "source_url", "stage_id",
  "priority", "salary", "work_mode", "description", "applied_at", "deadline",
  "contact_name", "note", "tags", "created_at", "updated_at", "archived",
  "position", "archived_at", "ended_at", "archived_operation_id",
  "ended_operation_id",
] as const;

export type CareerMaterialWriteAttachmentInput = Readonly<{
  blob: Blob;
  originalName: string;
  mimeType?: string;
}>;

export type CareerMaterialWriteSaveInput = Readonly<{
  name: string;
  kind: string;
  version: string;
  linkedJobId?: string | null;
  status: "ready" | "draft" | "sent";
  notes?: string;
  attachment?: CareerMaterialWriteAttachmentInput | null;
}>;

export type CareerMaterialSaveDisplayedExpected = CareerWriteGenerationExpectation & Readonly<{
  material: null;
  linkedJob: Readonly<Job> | null;
}>;

export type CareerMaterialDeleteDisplayedExpected = CareerWriteGenerationExpectation & Readonly<{
  material: Readonly<Material>;
  linkedJob: Readonly<Job> | null;
  /** Exact metadata for the displayed attachment, when one exists. */
  file: Readonly<LocalFileMetadata> | null;
  /** Exact full set of material rows currently sharing material.file_key. */
  fileReferences: readonly Readonly<Material>[];
}>;

export type CareerMaterialProjection = Readonly<Omit<Material, "file_key"> & {
  has_attachment: boolean;
}>;

export type CareerMaterialFileProjection = Readonly<Omit<LocalFileMetadata, "key" | "stagingOwner">>;

type MaterialDeleteBefore = CareerWriteGenerationExpectation & Readonly<{
  material: CareerMaterialProjection;
  linkedJob: Readonly<Job> | null;
  file: CareerMaterialFileProjection | null;
  fileReferences: readonly CareerMaterialProjection[];
  fileReceipt: CareerMaterialDeleteFileReceipt | null;
}>;

type MaterialSaveAfter = CareerWriteGenerationExpectation & Readonly<{
  material: CareerMaterialProjection;
  stagedFile: CareerMaterialFileProjection | null;
  cleanupReceipt: CareerMaterialFileCleanupReceipt | null;
}>;

type MaterialDeleteAfter = CareerWriteGenerationExpectation & Readonly<{
  materialId: string;
}>;

type MaterialSaveIntentCommand = Readonly<{
  name: string;
  kind: string;
  version: string;
  linkedJobId: string | null;
  status: "ready" | "draft" | "sent";
  notes: string;
  attachment: Readonly<{
    originalName: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
  }> | null;
}>;

type MaterialDeleteIntentCommand = Readonly<{
  material: CareerMaterialProjection;
  linkedJobId: string | null;
  file: CareerMaterialFileProjection | null;
  fileReferences: readonly CareerMaterialProjection[];
}>;

export type CareerMaterialWriteIntent =
  | Readonly<{
      kind: "material-save";
      operationId: string;
      operationAt: string;
      materialId: string;
      capabilityHandle: string | null;
      command: MaterialSaveIntentCommand;
    }>
  | Readonly<{
      kind: "material-delete";
      operationId: string;
      operationAt: string;
      materialId: string;
      capabilityHandle: string | null;
      command: MaterialDeleteIntentCommand;
    }>;

export type CareerMaterialSaveWriteReceipt = CareerWriteReceiptBase<
  typeof PURPOSE, "material-save", CareerMaterialSaveDisplayedExpected, MaterialSaveAfter
> & Readonly<{ intent: Extract<CareerMaterialWriteIntent, { kind: "material-save" }> }>;
export type CareerMaterialDeleteWriteReceipt = CareerWriteReceiptBase<
  typeof PURPOSE, "material-delete", MaterialDeleteBefore, MaterialDeleteAfter
> & Readonly<{ intent: Extract<CareerMaterialWriteIntent, { kind: "material-delete" }> }>;
export type CareerMaterialWriteReceipt = CareerMaterialSaveWriteReceipt | CareerMaterialDeleteWriteReceipt;
export type CareerMaterialWriteResult = CareerWriteCommitResult<CareerMaterialWriteReceipt> & Readonly<{
  /** Durable private-finalize proof. Journal removal requires `completed`. */
  privateFinalize?: "completed" | "cleanup_pending";
  /** The SQLite marker is exact; only private claim/capability release remains. */
  cleanupPending?: true;
  cleanupRetryable?: true;
}>;

export type CareerMaterialCleanupPrepared = Readonly<{
  operationId: string;
  materialId: string;
  cleanupReceipt: CareerMaterialFileCleanupReceipt;
}>;

export type CareerMaterialFileCleanupTicket = CareerMaterialCleanupPrepared;

export type CareerMaterialWriteInspection =
  | Exclude<CareerWriteInspection, "exact_saved">
  | "exact_saved_cleanup_pending"
  | "exact_saved_completed";

export type CareerMaterialSavePrepareOptions = Readonly<{
  /**
   * Must durably persist the capability before any attachment bytes are staged.
   * The caller must already hold its journal lease and perform only the matching
   * raw CAS here; this callback runs inside the Career storage lock and must not
   * attempt to acquire another Web Lock.
   */
  onCleanupPrepared?(prepared: CareerMaterialCleanupPrepared): void | Promise<void>;
}>;

export type CareerMaterialFileCleanupInspection =
  | Readonly<{ state: "cleanup_ready"; ticket: CareerMaterialFileCleanupTicket }>
  | Readonly<{ state: "already_clean" }>
  | Readonly<{ state: "blocked"; reason: "generation_changed" | "material_present" | "file_referenced" | "file_changed" }>
  | Readonly<{ state: "still_unknown"; ticket: CareerMaterialFileCleanupTicket; retryable: true }>;

export type CareerMaterialFileCleanupResult =
  | Readonly<{ outcome: "cleaned" | "already_cleaned" }>
  | Readonly<{ outcome: "blocked"; reason: "generation_changed" | "material_present" | "file_referenced" | "file_changed" }>
  | Readonly<{ outcome: "cleanup_pending"; ticket: CareerMaterialFileCleanupTicket; retryable: true }>;

export type CareerMaterialFileCleanupGarbageCollectionResult =
  | Readonly<{ outcome: "released" | "cleaned_and_released" }>
  | Readonly<{ outcome: "blocked"; reason: "cleanup_required" | "file_changed" }>
  | Readonly<{ outcome: "cleanup_pending"; ticket: CareerMaterialFileCleanupTicket; retryable: true }>;

type NormalizedSave = Readonly<{
  name: string;
  kind: string;
  version: string;
  linkedJobId: string | null;
  status: "ready" | "draft" | "sent";
  notes: string;
  attachment: Readonly<{ blob: Blob; originalName: string; mimeType: string; byteSize: number }> | null;
}>;

type MaterialRuntime = CareerWriteStorageRuntime & CareerMaterialWriteFileRuntime;

type MaterialReceiptContext = Readonly<{
  receipt: CareerMaterialWriteReceipt;
  material: Material;
  stagedFile: CareerMaterialStagedFile | null;
  deleteFilePayload: CareerMaterialDeleteFilePayload | null;
}>;

type MaterialReceiptContextResolution =
  | Readonly<{ state: "active"; context: MaterialReceiptContext }>
  | Readonly<{ state: "completed" }>
  | Readonly<{ state: "missing" | "malformed" | "unknown" }>;

type MaterialFileState = "exact" | "missing" | "verified_changed" | "unknown";

const defaultRuntime: MaterialRuntime = {
  ...defaultCareerWriteStorageRuntime,
  ...defaultCareerMaterialWriteFileRuntime,
};

function line(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw careerWriteError("invalid_input", `${label}格式无效。`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || Array.from(normalized).length > maximum) throw careerWriteError("invalid_input", `${label}无效。`);
  return normalized;
}

function optionalId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return line(value, label, 240);
}

function notes(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw careerWriteError("invalid_input", "材料备注无效。");
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (Array.from(normalized).length > 20_000) throw careerWriteError("invalid_input", "材料备注过长。");
  return normalized;
}

function fileName(value: unknown): string {
  if (typeof value !== "string") throw careerWriteError("invalid_input", "附件名称无效。");
  const normalized = Array.from(value, (character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || point === 127 ? " " : character === "/" || character === "\\" ? "_" : character;
  }).join("").replace(/\s+/g, " ").trim();
  return Array.from(normalized || "attachment").slice(0, 255).join("");
}

function mimeType(value: unknown): string {
  if (value !== undefined && typeof value !== "string") throw careerWriteError("invalid_input", "附件类型无效。");
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9!#$&^_.+\-/]/g, "").slice(0, 127);
  return normalized.includes("/") ? normalized : "application/octet-stream";
}

function normalizeSave(input: CareerMaterialWriteSaveInput): NormalizedSave {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    !["ready", "draft", "sent"].includes(input.status)) {
    throw careerWriteError("invalid_input", "材料内容无效。");
  }
  let attachment: NormalizedSave["attachment"] = null;
  if (input.attachment !== undefined && input.attachment !== null) {
    if (!(input.attachment.blob instanceof Blob) || input.attachment.blob.size <= 0 ||
      input.attachment.blob.size > MAX_ATTACHMENT_BYTES) {
      throw careerWriteError("invalid_input", "附件需要是 1 字节到 512 MiB 的浏览器文件。");
    }
    attachment = {
      blob: input.attachment.blob,
      originalName: fileName(input.attachment.originalName),
      mimeType: mimeType(input.attachment.mimeType ?? input.attachment.blob.type),
      byteSize: input.attachment.blob.size,
    };
  }
  return {
    name: line(input.name, "材料名称", 240), kind: line(input.kind, "材料类型", 80),
    version: line(input.version, "材料版本", 80), linkedJobId: optionalId(input.linkedJobId, "职位标识"),
    status: input.status, notes: notes(input.notes), attachment,
  };
}

function uuid(runtime: CareerWriteStorageRuntime, prefix: "material" | null): string {
  const raw = runtime.randomUUID().toLowerCase();
  if (!UUID_PATTERN.test(raw)) throw careerWriteError("invalid_input", "无法生成材料写入标识。");
  return prefix ? `${prefix}_${raw}` : raw;
}

function sameRow<Row extends object>(left: Row, right: Row, keys: readonly (keyof Row)[]): boolean {
  return keys.every((key) => left[key] === right[key]);
}

function isMaterial(value: unknown): value is Material {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [...MATERIAL_KEYS])) return false;
  const row = value as Material;
  return typeof row.id === "string" && typeof row.name === "string" && typeof row.kind === "string" &&
    typeof row.version === "string" && isCanonicalIsoTimestamp(row.updated_at) &&
    (row.linked_job_id === null || typeof row.linked_job_id === "string") && typeof row.status === "string" &&
    typeof row.notes === "string" && (row.file_key === null || UUID_PATTERN.test(row.file_key)) &&
    (row.file_name === null || typeof row.file_name === "string") &&
    (row.mime_type === null || typeof row.mime_type === "string") &&
    (row.byte_size === null || Number.isSafeInteger(row.byte_size)) &&
    (row.file_key === null
      ? row.file_name === null && row.mime_type === null && row.byte_size === null
      : row.file_name !== null && row.mime_type !== null && row.byte_size !== null && row.byte_size >= 0);
}

function redactMaterial(row: Readonly<Material>): CareerMaterialProjection {
  const { file_key: fileKey, ...publicRow } = row;
  return { ...publicRow, has_attachment: fileKey !== null };
}

function materialFromProjection(
  projection: CareerMaterialProjection,
  fileKey: string | null,
): Material {
  return {
    id: projection.id,
    name: projection.name,
    kind: projection.kind,
    version: projection.version,
    updated_at: projection.updated_at,
    linked_job_id: projection.linked_job_id,
    status: projection.status,
    notes: projection.notes,
    file_key: fileKey,
    file_name: projection.file_name,
    mime_type: projection.mime_type,
    byte_size: projection.byte_size,
  };
}

function redactFile(file: Readonly<LocalFileMetadata>): CareerMaterialFileProjection {
  const { key: _key, stagingOwner: _owner, ...publicFile } = file;
  void _key;
  void _owner;
  return { ...publicFile };
}

function isMaterialProjection(value: unknown): value is CareerMaterialProjection {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value, [...MATERIAL_PROJECTION_KEYS])) return false;
  const row = value as CareerMaterialProjection;
  return typeof row.has_attachment === "boolean" && isMaterial(materialFromProjection(
    row,
    row.has_attachment ? "00000000-0000-4000-8000-000000000000" : null,
  ));
}

function isFileProjection(value: unknown): value is CareerMaterialFileProjection {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value, [...FILE_PROJECTION_KEYS])) return false;
  const file = value as CareerMaterialFileProjection;
  return file.version === 1 && file.namespace === "career" &&
    typeof file.originalName === "string" && typeof file.mimeType === "string" &&
    (file.category === null || typeof file.category === "string") &&
    Number.isSafeInteger(file.byteSize) && file.byteSize >= 0 && SHA_PATTERN.test(file.sha256) &&
    isCanonicalIsoTimestamp(file.createdAt) && isCanonicalIsoTimestamp(file.updatedAt);
}

function isJob(value: unknown): value is Job {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [...JOB_KEYS])) return false;
  const row = value as Job;
  return JOB_KEYS.filter((key) => ![
    "priority", "position", "archived", "applied_at", "deadline", "archived_at",
    "ended_at", "archived_operation_id", "ended_operation_id",
  ].includes(key)).every((key) => typeof row[key] === "string") &&
    Number.isSafeInteger(row.priority) && row.priority >= 1 && row.priority <= 3 &&
    Number.isSafeInteger(row.position) && (row.archived === 0 || row.archived === 1) &&
    [row.applied_at, row.deadline, row.archived_at, row.ended_at].every((timestamp) =>
      timestamp === null || isCanonicalIsoTimestamp(timestamp)) &&
    [row.archived_operation_id, row.ended_operation_id].every((id) => id === null || typeof id === "string") &&
    isCanonicalIsoTimestamp(row.created_at) && isCanonicalIsoTimestamp(row.updated_at);
}

async function queryRows<Row extends object>(runtime: CareerWriteStorageRuntime, sql: string, params: readonly unknown[] = []) {
  return (await runtime.query<Row>(sql, params)).rows;
}

async function readMaterial(runtime: CareerWriteStorageRuntime, id: string): Promise<Material | null> {
  const found = await queryRows<Material>(runtime, `SELECT ${MATERIAL_KEYS.join(",")} FROM career_materials WHERE id=? ORDER BY id LIMIT 2`, [id]);
  if (found.length > 1) throw new Error("材料标识不唯一。");
  return found[0] ? { ...found[0] } : null;
}

async function readJob(runtime: CareerWriteStorageRuntime, id: string): Promise<Job | null> {
  const found = await queryRows<Job>(runtime, `SELECT ${JOB_KEYS.join(",")} FROM career_jobs WHERE id=? ORDER BY id LIMIT 2`, [id]);
  if (found.length > 1) throw new Error("职位标识不唯一。");
  return found[0] ? { ...found[0] } : null;
}

async function readReferences(runtime: CareerWriteStorageRuntime, key: string): Promise<Material[]> {
  return (await queryRows<Material>(runtime, `SELECT ${MATERIAL_KEYS.join(",")} FROM career_materials WHERE file_key=? ORDER BY id COLLATE BINARY`, [key]))
    .map((row) => ({ ...row }));
}

async function jobExact(runtime: CareerWriteStorageRuntime, expected: Job | null, id: string | null): Promise<boolean> {
  if (id === null) return expected === null;
  if (!expected || expected.id !== id) return false;
  const actual = await readJob(runtime, id);
  return Boolean(actual && sameRow(actual, expected, JOB_KEYS));
}

async function saveBeforeExact(
  runtime: CareerWriteStorageRuntime,
  receipt: CareerMaterialSaveWriteReceipt,
  material: Material,
): Promise<boolean> {
  return await readMaterial(runtime, material.id) === null &&
    await jobExact(runtime, receipt.before.linkedJob, material.linked_job_id);
}

function sortedMaterials(value: readonly Readonly<Material>[]): Material[] {
  return value.map((row) => ({ ...row })).sort((left, right) => compareSqliteBinaryText(left.id, right.id));
}

function deleteExpectedFromContext(
  receipt: CareerMaterialDeleteWriteReceipt,
  payload: CareerMaterialDeleteFilePayload | null,
): CareerMaterialDeleteDisplayedExpected {
  const fileKey = payload?.fileKey ?? null;
  return {
    generationId: receipt.generationId,
    generationSequence: receipt.generationSequence,
    material: materialFromProjection(receipt.before.material, fileKey),
    linkedJob: receipt.before.linkedJob,
    file: payload?.expectedFile ?? null,
    fileReferences: receipt.before.fileReferences.map((row) => materialFromProjection(row, fileKey)),
  };
}

async function deleteBeforeExact(runtime: CareerWriteStorageRuntime, expectedState: CareerMaterialDeleteDisplayedExpected): Promise<boolean> {
  const actual = await readMaterial(runtime, expectedState.material.id);
  if (!actual || !sameRow(actual, expectedState.material, MATERIAL_KEYS) ||
    !await jobExact(runtime, expectedState.linkedJob, expectedState.material.linked_job_id)) return false;
  const references = expectedState.material.file_key
    ? await readReferences(runtime, expectedState.material.file_key)
    : [];
  const expected = sortedMaterials(expectedState.fileReferences);
  return references.length === expected.length && references.every((row, index) =>
    sameRow(row, expected[index], MATERIAL_KEYS));
}

async function inspectExactFile(
  runtime: MaterialRuntime,
  staged: CareerMaterialStagedFile,
): Promise<MaterialFileState> {
  try {
    const result = await runtime.getFile(staged.key);
    if (!sameCareerMaterialStagedFile(result.metadata, staged)) return "verified_changed";
    let digest: string;
    try { digest = (await runtime.hashBlob(result.file)).toLowerCase(); }
    catch { return "unknown"; }
    if (!SHA_PATTERN.test(digest)) return "unknown";
    return digest === staged.sha256 ? "exact" : "verified_changed";
  } catch (error) {
    return isLocalFileMissingError(error) ? "missing" : "unknown";
  }
}

async function inspectFileAbsence(runtime: MaterialRuntime, key: string): Promise<MaterialFileState> {
  try {
    const candidate = await runtime.inspectDeletionCandidate(key, null);
    return candidate.state === "missing" ? "missing" : "verified_changed";
  } catch { return "unknown"; }
}

function sqlExact(table: string, keys: readonly string[], row: Record<string, unknown>) {
  return { sql: `EXISTS(SELECT 1 FROM ${table} WHERE ${keys.map((key) => `${key} IS ?`).join(" AND ")})`, params: keys.map((key) => row[key]) };
}

function jobPredicate(job: Job | null, id: string | null) {
  return id === null
    ? { sql: "1=1", params: [] as unknown[] }
    : job
      ? sqlExact("career_jobs", JOB_KEYS, job as unknown as Record<string, unknown>)
      : { sql: "0=1", params: [] as unknown[] };
}

function saveStatements(receipt: CareerMaterialSaveWriteReceipt, row: Material): SqlStatement[] {
  return [
    abortUnless(markerAbsentPredicate(receipt.operationId)),
    abortUnless({ sql: "NOT EXISTS(SELECT 1 FROM career_materials WHERE id=?)", params: [row.id] }),
    abortUnless(jobPredicate(receipt.before.linkedJob, row.linked_job_id)),
    ...(row.file_key ? [abortUnless({ sql: "NOT EXISTS(SELECT 1 FROM career_materials WHERE file_key=?)", params: [row.file_key] })] : []),
    {
      sql: `INSERT INTO career_materials(${MATERIAL_KEYS.join(",")}) VALUES(${MATERIAL_KEYS.map(() => "?").join(",")})`,
      params: MATERIAL_KEYS.map((key) => row[key]),
    },
    markerStatement(receipt, row.id),
  ];
}

function deleteStatements(
  receipt: CareerMaterialDeleteWriteReceipt,
  expected: CareerMaterialDeleteDisplayedExpected,
): SqlStatement[] {
  const row = expected.material;
  const statements: SqlStatement[] = [
    abortUnless(markerAbsentPredicate(receipt.operationId)),
    abortUnless(sqlExact("career_materials", MATERIAL_KEYS, row as unknown as Record<string, unknown>)),
    abortUnless(jobPredicate(receipt.before.linkedJob, row.linked_job_id)),
  ];
  if (row.file_key) {
    for (const reference of sortedMaterials(expected.fileReferences)) {
      statements.push(abortUnless(sqlExact("career_materials", MATERIAL_KEYS, reference as unknown as Record<string, unknown>)));
    }
    statements.push(abortUnless({
      sql: "(SELECT COUNT(*) FROM career_materials WHERE file_key=?)=?",
      params: [row.file_key, expected.fileReferences.length],
    }));
  }
  statements.push({ sql: "DELETE FROM career_materials WHERE id=?", params: [row.id] });
  statements.push(markerStatement(receipt, row.id));
  return statements;
}

function generatedOperationAt(runtime: CareerWriteStorageRuntime, previous: string | null): string {
  return previous ? strictlyLaterTimestamp(runtime.now(), [previous]) : new Date(runtime.now()).toISOString();
}

function isNormalizedMaterialIntent(value: unknown): value is CareerMaterialWriteIntent {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [
    "kind", "operationId", "operationAt", "materialId", "capabilityHandle", "command",
  ])) return false;
  const intent = value as CareerMaterialWriteIntent;
  if (!isCareerWriteOperationId(intent.operationId, PURPOSE) ||
    !isCanonicalIsoTimestamp(intent.operationAt) || typeof intent.materialId !== "string" ||
    intent.materialId.trim() !== intent.materialId || !intent.materialId || intent.materialId.length > 240 ||
    !(intent.capabilityHandle === null || UUID_PATTERN.test(intent.capabilityHandle))) return false;
  if (intent.kind === "material-delete") {
    if (!intent.command || typeof intent.command !== "object" || Array.isArray(intent.command) ||
      !exactKeys(intent.command, ["material", "linkedJobId", "file", "fileReferences"]) ||
      !isMaterialProjection(intent.command.material) ||
      !(intent.command.linkedJobId === null || typeof intent.command.linkedJobId === "string") ||
      !(intent.command.file === null || isFileProjection(intent.command.file)) ||
      !Array.isArray(intent.command.fileReferences) ||
      !intent.command.fileReferences.every(isMaterialProjection)) return false;
    const ids = intent.command.fileReferences.map(({ id }) => id);
    return new Set(ids).size === ids.length && ids.every((id, index) =>
      index === 0 || compareSqliteBinaryText(ids[index - 1], id) < 0);
  }
  if (intent.kind !== "material-save" ||
    !new RegExp(`^material_${UUID_PATTERN.source.slice(1, -1)}$`, "i").test(intent.materialId) ||
    !intent.command || typeof intent.command !== "object" || Array.isArray(intent.command) ||
    !exactKeys(intent.command, [
      "name", "kind", "version", "linkedJobId", "status", "notes", "attachment",
    ])) return false;
  const command = intent.command;
  try {
    if (line(command.name, "材料名称", 240) !== command.name ||
      line(command.kind, "材料类型", 80) !== command.kind ||
      line(command.version, "材料版本", 80) !== command.version ||
      optionalId(command.linkedJobId, "职位标识") !== command.linkedJobId ||
      !["ready", "draft", "sent"].includes(command.status) || notes(command.notes) !== command.notes) return false;
  } catch { return false; }
  if (command.attachment === null) return intent.capabilityHandle === null;
  if (intent.capabilityHandle === null) return false;
  if (!command.attachment || typeof command.attachment !== "object" || Array.isArray(command.attachment) ||
    !exactKeys(command.attachment, ["originalName", "mimeType", "byteSize", "sha256"])) return false;
  const attachment = command.attachment;
  try {
    return fileName(attachment.originalName) === attachment.originalName &&
      mimeType(attachment.mimeType) === attachment.mimeType &&
      Number.isSafeInteger(attachment.byteSize) && attachment.byteSize > 0 &&
      attachment.byteSize <= MAX_ATTACHMENT_BYTES && SHA_PATTERN.test(attachment.sha256);
  } catch { return false; }
}

function validateSaveReceipt(value: CareerMaterialSaveWriteReceipt): boolean {
  if (!exactKeys(value.before, ["generationId", "generationSequence", "material", "linkedJob"]) ||
    value.before.material !== null || !(value.before.linkedJob === null || isJob(value.before.linkedJob)) ||
    !exactKeys(value.after, ["generationId", "generationSequence", "material", "stagedFile", "cleanupReceipt"]) ||
    !isMaterialProjection(value.after.material)) return false;
  const command = value.intent.command;
  const expectedMaterial: CareerMaterialProjection = {
    id: value.intent.materialId,
    name: command.name,
    kind: command.kind,
    version: command.version,
    updated_at: value.operationAt,
    linked_job_id: command.linkedJobId,
    status: command.status,
    notes: command.notes,
    file_name: command.attachment?.originalName ?? null,
    mime_type: command.attachment?.mimeType ?? null,
    byte_size: command.attachment?.byteSize ?? null,
    has_attachment: command.attachment !== null,
  };
  if (!sameMaterialProjection(value.after.material, expectedMaterial) ||
    command.linkedJobId !== (value.before.linkedJob?.id ?? null)) return false;
  if (command.attachment === null) {
    return value.after.stagedFile === null && value.after.cleanupReceipt === null &&
      value.intent.capabilityHandle === null;
  }
  const expectedFile: CareerMaterialFileProjection = {
    version: 1,
    namespace: "career",
    originalName: command.attachment.originalName,
    mimeType: command.attachment.mimeType,
    category: CATEGORY,
    byteSize: command.attachment.byteSize,
    sha256: command.attachment.sha256,
    createdAt: value.operationAt,
    updatedAt: value.operationAt,
  };
  return isFileProjection(value.after.stagedFile) &&
    sameFileProjection(value.after.stagedFile, expectedFile) &&
    isCareerMaterialFileCleanupReceipt(value.after.cleanupReceipt) &&
    value.after.cleanupReceipt.handle === value.intent.capabilityHandle;
}

function validateDeleteReceipt(value: CareerMaterialDeleteWriteReceipt): boolean {
  if (!(exactKeys(value.before, [
    "generationId", "generationSequence", "material", "linkedJob", "file",
    "fileReferences", "fileReceipt",
  ]) && isMaterialProjection(value.before.material) &&
    (value.before.linkedJob === null || isJob(value.before.linkedJob)) &&
    (value.before.file === null || isFileProjection(value.before.file)) &&
    Array.isArray(value.before.fileReferences) && value.before.fileReferences.every(isMaterialProjection) &&
    ((value.before.fileReceipt === null && value.intent.capabilityHandle === null) ||
      (isCareerMaterialDeleteFileReceipt(value.before.fileReceipt) &&
        value.before.fileReceipt.handle === value.intent.capabilityHandle)) &&
    exactKeys(value.after, ["generationId", "generationSequence", "materialId"]) &&
    value.after.materialId === value.before.material.id)) return false;
  const command = value.intent.command;
  return value.intent.materialId === value.before.material.id &&
    command.linkedJobId === (value.before.linkedJob?.id ?? null) &&
    sameMaterialProjection(command.material, value.before.material) &&
    ((command.file === null && value.before.file === null) ||
      (command.file !== null && value.before.file !== null && sameFileProjection(command.file, value.before.file))) &&
    command.fileReferences.length === value.before.fileReferences.length &&
    command.fileReferences.every((row, index) =>
      sameMaterialProjection(row, value.before.fileReferences[index]));
}

function isReceipt(value: unknown): value is CareerMaterialWriteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [
    "purpose", "version", "kind", "operationId", "generationId", "generationSequence",
    "operationAt", "intent", "before", "after", "projectionSha256",
  ])) return false;
  const receipt = value as CareerMaterialWriteReceipt;
  return receipt.purpose === PURPOSE && receipt.version === CAREER_WRITE_RECEIPT_VERSION &&
    (receipt.kind === "material-save" || receipt.kind === "material-delete") &&
    isCareerWriteOperationId(receipt.operationId, PURPOSE) && typeof receipt.operationAt === "string" &&
    isNormalizedMaterialIntent(receipt.intent) && receipt.intent.kind === receipt.kind &&
    receipt.intent.operationId === receipt.operationId && receipt.intent.operationAt === receipt.operationAt &&
    isCareerWriteGeneration({ generationId: receipt.generationId, generationSequence: receipt.generationSequence }) &&
    isCareerWriteGeneration({ generationId: receipt.before.generationId, generationSequence: receipt.before.generationSequence }) &&
    isCareerWriteGeneration({ generationId: receipt.after.generationId, generationSequence: receipt.after.generationSequence }) &&
    sameCareerWriteGeneration(receipt, receipt.before) && sameCareerWriteGeneration(receipt, receipt.after) &&
    (receipt.kind === "material-save" ? validateSaveReceipt(receipt) : validateDeleteReceipt(receipt));
}

function receiptEntityId(receipt: CareerMaterialWriteReceipt): string {
  return receipt.kind === "material-save" ? receipt.after.material.id : receipt.before.material.id;
}

function sameFileProjection(
  left: CareerMaterialFileProjection,
  right: CareerMaterialFileProjection,
): boolean {
  return FILE_PROJECTION_KEYS.every((key) => left[key] === right[key]);
}

function sameMaterialProjection(
  left: CareerMaterialProjection,
  right: CareerMaterialProjection,
): boolean {
  return MATERIAL_PROJECTION_KEYS.every((key) => left[key] === right[key]);
}

function materialProjectionSemantics(row: CareerMaterialProjection): boolean {
  return row.id.trim() === row.id && row.id.length > 0 && row.id.length <= 240 &&
    row.name.trim() === row.name && row.name.length > 0 && Array.from(row.name).length <= 240 &&
    row.kind.trim() === row.kind && row.kind.length > 0 && Array.from(row.kind).length <= 80 &&
    row.version.trim() === row.version && row.version.length > 0 && Array.from(row.version).length <= 80 &&
    isCanonicalIsoTimestamp(row.updated_at) && Array.from(row.notes).length <= 20_000 &&
    (row.has_attachment
      ? row.file_name !== null && row.mime_type !== null && row.byte_size !== null && row.byte_size >= 0
      : row.file_name === null && row.mime_type === null && row.byte_size === null);
}

function cleanupTicket(value: unknown): CareerMaterialFileCleanupTicket | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [
    "operationId", "materialId", "cleanupReceipt",
  ])) return null;
  const ticket = value as CareerMaterialFileCleanupTicket;
  if (!isCareerWriteOperationId(ticket.operationId, PURPOSE) ||
    typeof ticket.materialId !== "string" || ticket.materialId.trim() !== ticket.materialId ||
    !ticket.materialId || ticket.materialId.length > 240 ||
    !isCareerMaterialFileCleanupReceipt(ticket.cleanupReceipt)) return null;
  return {
    operationId: ticket.operationId,
    materialId: ticket.materialId,
    cleanupReceipt: { ...ticket.cleanupReceipt },
  };
}

async function contextForReceipt(
  receipt: CareerMaterialWriteReceipt,
  runtime: MaterialRuntime,
): Promise<MaterialReceiptContextResolution> {
  const binding: CareerMaterialCapabilityBinding = {
    generationId: receipt.generationId,
    generationSequence: receipt.generationSequence,
    operationId: receipt.operationId,
    materialId: receipt.intent.materialId,
  };
  if (!isCanonicalIsoTimestamp(receipt.operationAt)) return { state: "malformed" };
  if (receipt.kind === "material-save") {
    const projection = receipt.after.material;
    const intent = receipt.intent;
    const command = intent.command;
    if (!materialProjectionSemantics(projection) || intent.materialId !== projection.id ||
      command.linkedJobId !== (receipt.before.linkedJob?.id ?? null)) return { state: "malformed" };
    if (command.attachment === null) {
      const material: Material = {
        id: intent.materialId,
        name: command.name,
        kind: command.kind,
        version: command.version,
        updated_at: receipt.operationAt,
        linked_job_id: command.linkedJobId,
        status: command.status,
        notes: command.notes,
        file_key: null,
        file_name: null,
        mime_type: null,
        byte_size: null,
      };
      if (!sameMaterialProjection(projection, redactMaterial(material))) return { state: "malformed" };
      return { state: "active", context: {
        receipt, material, stagedFile: null, deleteFilePayload: null,
      } };
    }
    if (!receipt.after.cleanupReceipt || !receipt.after.stagedFile) return { state: "malformed" };
    const resolved = await resolveCareerMaterialFileCleanupReceipt(receipt.after.cleanupReceipt, runtime);
    if (resolved.state === "completed") {
      return sameCareerMaterialCapabilityBinding(resolved.binding, binding)
        ? { state: "completed" }
        : { state: "malformed" };
    }
    if (resolved.state !== "active") return { state: resolved.state };
    const payload = resolved.payload;
    let expectedOwner: string;
    try { expectedOwner = await careerMaterialStagingOwner(receipt.operationId); }
    catch { return { state: "unknown" }; }
    const material: Material = {
      id: intent.materialId,
      name: command.name,
      kind: command.kind,
      version: command.version,
      updated_at: receipt.operationAt,
      linked_job_id: command.linkedJobId,
      status: command.status,
      notes: command.notes,
      file_key: payload.stagedFile.key,
      file_name: command.attachment.originalName,
      mime_type: command.attachment.mimeType,
      byte_size: command.attachment.byteSize,
    };
    if (!sameCareerWriteGeneration(receipt, payload) || payload.operationId !== receipt.operationId ||
      payload.materialId !== projection.id || payload.stagedFile.stagingOwner !== expectedOwner ||
      payload.stagedFile.category !== CATEGORY || payload.stagedFile.createdAt !== receipt.operationAt ||
      payload.stagedFile.updatedAt !== receipt.operationAt ||
      payload.stagedFile.originalName !== command.attachment.originalName ||
      payload.stagedFile.mimeType !== command.attachment.mimeType ||
      payload.stagedFile.byteSize !== command.attachment.byteSize ||
      payload.stagedFile.sha256 !== command.attachment.sha256 ||
      !sameFileProjection(receipt.after.stagedFile, redactFile(payload.stagedFile)) ||
      !sameMaterialProjection(projection, redactMaterial(material))) return { state: "malformed" };
    return { state: "active", context: {
      receipt, material, stagedFile: payload.stagedFile, deleteFilePayload: null,
    } };
  }
  const projection = receipt.before.material;
  const references = receipt.before.fileReferences;
  if (!materialProjectionSemantics(projection) || receipt.intent.materialId !== projection.id ||
    receipt.after.materialId !== projection.id ||
    projection.linked_job_id !== (receipt.before.linkedJob?.id ?? null) ||
    !(Date.parse(receipt.operationAt) > Date.parse(projection.updated_at))) return { state: "malformed" };
  const referenceIds = references.map(({ id }) => id);
  if (new Set(referenceIds).size !== referenceIds.length || referenceIds.some((id, index) =>
    index > 0 && compareSqliteBinaryText(referenceIds[index - 1], id) >= 0) ||
    references.some((row) => !materialProjectionSemantics(row))) return { state: "malformed" };
  if (!projection.has_attachment) {
    if (receipt.before.file !== null || receipt.before.fileReceipt !== null || references.length !== 0) {
      return { state: "malformed" };
    }
    return { state: "active", context: {
      receipt,
      material: materialFromProjection(projection, null),
      stagedFile: null,
      deleteFilePayload: null,
    } };
  }
  const targetReference = references.find((row) => row.id === projection.id);
  if (!receipt.before.fileReceipt || !targetReference ||
    !sameMaterialProjection(targetReference, projection) ||
    references.some((row) => !row.has_attachment)) return { state: "malformed" };
  const resolved = await resolveCareerMaterialDeleteFileReceipt(receipt.before.fileReceipt, runtime);
  if (resolved.state === "completed") {
    return sameCareerMaterialCapabilityBinding(resolved.binding, binding)
      ? { state: "completed" }
      : { state: "malformed" };
  }
  if (resolved.state !== "active") return { state: resolved.state };
  const payload = resolved.payload;
  if (!sameCareerWriteGeneration(receipt, payload) || payload.operationId !== receipt.operationId ||
    payload.materialId !== projection.id ||
    (payload.expectedFile === null) !== (receipt.before.file === null) ||
    (payload.expectedFile && receipt.before.file &&
      !sameFileProjection(redactFile(payload.expectedFile), receipt.before.file))) return { state: "malformed" };
  return { state: "active", context: {
    receipt,
    material: materialFromProjection(projection, payload.fileKey),
    stagedFile: null,
    deleteFilePayload: payload,
  } };
}

export function createCareerMaterialWriteStorageService(runtime: MaterialRuntime = defaultRuntime) {
  async function prepareSave(
    inputValue: CareerMaterialWriteSaveInput,
    displayedValue: CareerMaterialSaveDisplayedExpected,
    options: CareerMaterialSavePrepareOptions = {},
  ): Promise<CareerMaterialSaveWriteReceipt> {
    const input = normalizeSave(inputValue);
    const displayed = jsonClone<CareerMaterialSaveDisplayedExpected>(displayedValue, CAREER_WRITE_RECEIPT_MAX_JSON_BYTES, "材料显示快照");
    const onCleanupPrepared = options?.onCleanupPrepared;
    if (input.attachment && typeof onCleanupPrepared !== "function") {
      throw careerWriteError("invalid_input", "保存附件前必须提供持久化清理凭据的回调。");
    }
    return withCareerWritePrepareLock(runtime, async () => {
      const generation = await readCurrentCareerWriteGeneration(runtime);
      requireCurrentCareerWriteGeneration(generation, displayed);
      if (displayed.material !== null || !await jobExact(runtime, displayed.linkedJob, input.linkedJobId)) {
        throw careerWriteError("changed", "材料或关联职位已经变化；没有准备写入。");
      }
      const operationId = generatedCareerWriteOperationId(runtime, PURPOSE);
      const materialId = uuid(runtime, "material");
      const operationAt = generatedOperationAt(runtime, null);
      const capabilityHandle = input.attachment ? uuid(runtime, null) : null;
      let stagedFile: CareerMaterialStagedFile | null = null;
      let cleanupReceipt: CareerMaterialFileCleanupReceipt | null = null;
      if (input.attachment) {
        const key = uuid(runtime, null);
        const stagingOwner = await careerMaterialStagingOwner(operationId);
        let sha256: string;
        try { sha256 = (await runtime.hashBlob(input.attachment.blob)).toLowerCase(); }
        catch { throw careerWriteError("inspect_failed", "无法读取附件内容；没有准备写入。"); }
        if (!SHA_PATTERN.test(sha256)) throw careerWriteError("inspect_failed", "附件没有可核对的校验值；没有准备写入。");
        stagedFile = {
          version: 1, key, namespace: "career", originalName: input.attachment.originalName,
          mimeType: input.attachment.mimeType, category: CATEGORY, byteSize: input.attachment.byteSize,
          sha256, createdAt: operationAt, updatedAt: operationAt, stagingOwner,
        };
        cleanupReceipt = createCareerMaterialFileCleanupReceipt(capabilityHandle!);
        try {
          await issueCareerMaterialFileCleanupReceipt({
            ...generation, operationId, materialId, stagedFile,
          }, capabilityHandle!, runtime);
        } catch (error) {
          throw careerWriteError(
            "write_failed",
            "附件私有清理能力未能持久化；没有开始文件写入。",
            error instanceof CareerMaterialCapabilityPersistenceUnknownError
              ? { operationId, materialId, cleanupReceipt }
              : undefined,
          );
        }
        try {
          await onCleanupPrepared!({ operationId, materialId, cleanupReceipt });
        } catch {
          throw careerWriteError(
            "write_failed",
            "附件清理凭据未能持久化；没有开始文件写入。",
            { operationId, materialId, cleanupReceipt },
          );
        }
        try {
          await runtime.assertFileKeyAvailable(key);
          if ((await queryRows<{ count: number }>(runtime, "SELECT COUNT(*) AS count FROM career_materials WHERE file_key=?", [key]))[0]?.count !== 0) {
            throw new Error("file key referenced");
          }
          const actual = await runtime.saveFileAtKey(key, input.attachment.blob, {
            originalName: stagedFile.originalName, mimeType: stagedFile.mimeType, category: CATEGORY,
            createdAt: operationAt, updatedAt: operationAt,
          }, stagingOwner);
          if (!sameCareerMaterialStagedFile(actual, stagedFile)) throw new Error("metadata mismatch");
        } catch {
          throw careerWriteError("write_failed", "附件暂存失败；请使用已持久化的清理凭据核对。", cleanupReceipt);
        }
      }
      if (await readCareerWriteMarker(runtime, operationId) || await readMaterial(runtime, materialId)) {
        throw careerWriteError("changed", "材料写入标识已被占用；没有准备数据库写入。", cleanupReceipt);
      }
      const material: Material = {
        id: materialId, name: input.name, kind: input.kind, version: input.version,
        updated_at: operationAt, linked_job_id: input.linkedJobId, status: input.status,
        notes: input.notes, file_key: stagedFile?.key ?? null,
        file_name: stagedFile?.originalName ?? null, mime_type: stagedFile?.mimeType ?? null,
        byte_size: stagedFile?.byteSize ?? null,
      };
      return sealCareerWriteReceipt<CareerMaterialSaveWriteReceipt>({
        purpose: PURPOSE, version: CAREER_WRITE_RECEIPT_VERSION, kind: "material-save",
        operationId, ...generation, operationAt,
        intent: {
          kind: "material-save",
          operationId,
          operationAt,
          materialId,
          capabilityHandle,
          command: {
            name: input.name,
            kind: input.kind,
            version: input.version,
            linkedJobId: input.linkedJobId,
            status: input.status,
            notes: input.notes,
            attachment: stagedFile ? {
              originalName: stagedFile.originalName,
              mimeType: stagedFile.mimeType,
              byteSize: stagedFile.byteSize,
              sha256: stagedFile.sha256,
            } : null,
          },
        },
        before: { ...generation, material: null, linkedJob: displayed.linkedJob },
        after: {
          ...generation,
          material: redactMaterial(material),
          stagedFile: stagedFile ? redactFile(stagedFile) : null,
          cleanupReceipt,
        },
      });
    });
  }

  async function prepareDelete(displayedValue: CareerMaterialDeleteDisplayedExpected): Promise<CareerMaterialDeleteWriteReceipt> {
    const displayedInput = jsonClone<CareerMaterialDeleteDisplayedExpected>(displayedValue, CAREER_WRITE_RECEIPT_MAX_JSON_BYTES, "材料删除显示快照");
    return withCareerWritePrepareLock(runtime, async () => {
      const displayed = { ...displayedInput, fileReferences: sortedMaterials(displayedInput.fileReferences) };
      const generation = await readCurrentCareerWriteGeneration(runtime);
      requireCurrentCareerWriteGeneration(generation, displayed);
      if (!await deleteBeforeExact(runtime, displayed)) {
        throw careerWriteError("changed", "材料、关联职位或共享附件已经变化；没有准备删除。");
      }
      if (displayed.material.file_key) {
        const shared = displayed.fileReferences.some((row) => row.id !== displayed.material.id);
        if (!shared && displayed.file) {
          if (displayed.file.key !== displayed.material.file_key) {
            throw careerWriteError("invalid_input", "附件快照与待删除材料不一致。");
          }
          const fileState = await inspectExactFile(runtime, displayed.file as CareerMaterialStagedFile);
          if (fileState === "verified_changed" || fileState === "missing") {
            throw careerWriteError("changed", "附件内容已经变化；没有准备删除。");
          }
          if (fileState === "unknown") {
            throw careerWriteError("inspect_failed", "暂时无法核对附件内容；没有准备删除。");
          }
        } else if (!shared) {
          const absent = await inspectFileAbsence(runtime, displayed.material.file_key);
          if (absent === "verified_changed" || absent === "exact") {
            throw careerWriteError("invalid_input", "现存附件没有完整文件快照；没有准备删除。");
          }
          if (absent === "unknown") {
            throw careerWriteError("inspect_failed", "暂时无法核对附件是否已经清理。");
          }
        }
      } else if (displayed.file !== null || displayed.fileReferences.length !== 0) {
        throw careerWriteError("invalid_input", "无附件材料不能携带文件快照。");
      }
      const operationId = generatedCareerWriteOperationId(runtime, PURPOSE);
      if (await readCareerWriteMarker(runtime, operationId)) throw careerWriteError("changed", "材料删除标识已被占用。");
      const operationAt = generatedOperationAt(runtime, displayed.material.updated_at);
      const capabilityHandle = displayed.material.file_key ? uuid(runtime, null) : null;
      const deletionOwner = displayed.material.file_key &&
        (!displayed.file || displayed.file.stagingOwner === undefined)
        ? await careerMaterialDeletionOwner(
          generation,
          operationId,
          displayed.material.id,
          displayed.material.file_key!,
        )
        : null;
      let fileReceipt: CareerMaterialDeleteFileReceipt | null = null;
      if (displayed.material.file_key) {
        try {
          fileReceipt = await issueCareerMaterialDeleteFileReceipt({
            ...generation,
            operationId,
            materialId: displayed.material.id,
            fileKey: displayed.material.file_key,
            expectedFile: displayed.file,
            deletionOwner,
          }, capabilityHandle!, runtime);
        } catch (error) {
          throw careerWriteError(
            "write_failed",
            "附件删除能力未能持久化；没有开始删除文件或数据库记录。",
            error instanceof CareerMaterialCapabilityPersistenceUnknownError
              ? { operationId, materialId: displayed.material.id, fileReceipt: error.capabilityReceipt }
              : undefined,
          );
        }
      }
      return sealCareerWriteReceipt<CareerMaterialDeleteWriteReceipt>({
        purpose: PURPOSE, version: CAREER_WRITE_RECEIPT_VERSION, kind: "material-delete",
        operationId, ...generation, operationAt,
        intent: {
          kind: "material-delete",
          operationId,
          operationAt,
          materialId: displayed.material.id,
          capabilityHandle,
          command: {
            material: redactMaterial(displayed.material),
            linkedJobId: displayed.material.linked_job_id,
            file: displayed.file ? redactFile(displayed.file) : null,
            fileReferences: displayed.fileReferences.map(redactMaterial),
          },
        },
        before: {
          ...generation,
          material: redactMaterial(displayed.material),
          linkedJob: displayed.linkedJob,
          file: displayed.file ? redactFile(displayed.file) : null,
          fileReferences: displayed.fileReferences.map(redactMaterial),
          fileReceipt,
        },
        after: { ...generation, materialId: displayed.material.id },
      });
    });
  }

  async function markerStateUnlocked(
    receipt: CareerMaterialWriteReceipt,
  ): Promise<"marker_absent" | "exact_saved" | "changed"> {
    const marker = await readCareerWriteMarker(runtime, receipt.operationId);
    if (marker) {
      return exactCareerWriteMarker(marker, receipt, receiptEntityId(receipt))
        ? "exact_saved"
        : "changed";
    }
    const generation = await readCurrentCareerWriteGeneration(runtime);
    return sameCareerWriteGeneration(generation, receipt) ? "marker_absent" : "changed";
  }

  function receiptBinding(receipt: CareerMaterialWriteReceipt): CareerMaterialCapabilityBinding {
    return {
      generationId: receipt.generationId,
      generationSequence: receipt.generationSequence,
      operationId: receipt.operationId,
      materialId: receipt.intent.materialId,
    };
  }

  async function privateFinalizeState(
    receipt: CareerMaterialWriteReceipt,
  ): Promise<"completed" | "cleanup_pending"> {
    const capability = receipt.kind === "material-save"
      ? receipt.after.cleanupReceipt
      : receipt.before.fileReceipt;
    if (!capability) return "completed";
    const resolved = receipt.kind === "material-save"
      ? await resolveCareerMaterialFileCleanupReceipt(capability, runtime)
      : await resolveCareerMaterialDeleteFileReceipt(capability, runtime);
    return resolved.state === "completed" &&
      sameCareerMaterialCapabilityBinding(resolved.binding, receiptBinding(receipt))
      ? "completed"
      : "cleanup_pending";
  }

  async function expectedStateUnlocked(
    context: MaterialReceiptContext,
  ): Promise<"expected" | "changed"> {
    const { receipt } = context;
    return receipt.kind === "material-save"
      ? await saveBeforeExact(runtime, receipt, context.material) ? "expected" : "changed"
      : await deleteBeforeExact(runtime, deleteExpectedFromContext(receipt, context.deleteFilePayload)) ? "expected" : "changed";
  }

  async function parse(value: unknown): Promise<CareerMaterialWriteReceipt | null> {
    try {
      const receipt = jsonClone<CareerMaterialWriteReceipt>(value);
      return isReceipt(receipt) && await careerWriteReceiptHashIsValid(receipt)
        ? receipt
        : null;
    } catch { return null; }
  }

  async function inspect(value: unknown): Promise<CareerMaterialWriteInspection> {
    const receipt = await parse(value);
    if (!receipt) return "invalid_receipt";
    try {
      return await runtime.withExclusiveLock(async () => {
        const markerState = await markerStateUnlocked(receipt);
        if (markerState === "exact_saved") {
          return await privateFinalizeState(receipt) === "completed"
            ? "exact_saved_completed"
            : "exact_saved_cleanup_pending";
        }
        if (markerState === "changed") return "changed";
        const resolved = await contextForReceipt(receipt, runtime);
        if (resolved.state === "unknown") return "still_unknown";
        if (resolved.state !== "active") return resolved.state === "completed"
          ? "changed"
          : "invalid_receipt";
        if (await expectedStateUnlocked(resolved.context) === "changed") return "changed";
        const fileState = await inspectFileAction(resolved.context);
        return fileState === "ready" ? "expected"
          : fileState === "changed" ? "changed"
            : "still_unknown";
      });
    }
    catch { return "still_unknown"; }
  }

  async function inspectFileAction(
    context: MaterialReceiptContext,
  ): Promise<"ready" | "changed" | "unknown"> {
    const { receipt } = context;
    if (receipt.kind === "material-save") {
      if (!context.stagedFile) return "ready";
      const state = await inspectExactFile(runtime, context.stagedFile);
      return state === "exact" ? "ready"
        : state === "unknown" ? "unknown"
          : "changed";
    }
    const expected = deleteExpectedFromContext(receipt, context.deleteFilePayload);
    const { material, fileReferences, file } = expected;
    if (!material.file_key || fileReferences.some((row) => row.id !== material.id)) return "ready";
    const owner = file?.stagingOwner;
    if (owner) {
      const exact = await inspectExactFile(runtime, file as CareerMaterialStagedFile);
      if (exact === "unknown") return "unknown";
      if (exact === "exact") return "ready";
      try {
        const fragments = await runtime.inspectOwnedFragments(material.file_key, owner);
        return fragments.state === "missing" || fragments.state === "owned"
          ? "ready"
          : "changed";
      } catch { return "unknown"; }
    }
    const deletionOwner = context.deleteFilePayload?.deletionOwner;
    if (!deletionOwner) return "changed";
    try {
      const claim = await runtime.inspectClaimedDeletion(material.file_key, file, deletionOwner);
      if (claim.state === "owned") return "ready";
      if (claim.state === "foreign_or_unverifiable") return "changed";
      const candidate = await runtime.inspectDeletionCandidate(material.file_key, file);
      return candidate.state === "exact" || candidate.state === "missing"
        ? "ready"
        : "changed";
    } catch { return "unknown"; }
  }

  async function prepareFileAction(context: MaterialReceiptContext): Promise<"ready" | "changed"> {
    const { receipt } = context;
    const inspected = await inspectFileAction(context);
    if (inspected === "unknown") {
      throw careerWriteError(
        "inspect_failed",
        "暂时无法核对附件状态；可保留同一回执重试。",
        receipt,
      );
    }
    if (inspected === "changed") return "changed";
    if (receipt.kind === "material-save") return "ready";
    const expected = deleteExpectedFromContext(receipt, context.deleteFilePayload);
    const { material, fileReferences, file } = expected;
    if (!material.file_key || fileReferences.some((row) => row.id !== material.id)) return "ready";
    const owner = file?.stagingOwner;
    if (owner) {
      let fragments;
      try { fragments = await runtime.inspectOwnedFragments(material.file_key, owner); }
      catch {
        throw careerWriteError("inspect_failed", "暂时无法核对附件碎片；可保留同一回执重试。", receipt);
      }
      if (fragments.state === "missing") return "ready";
      if (fragments.state !== "owned") return "changed";
      try { await runtime.deleteOwnedFile(material.file_key, owner); }
      catch {
        const afterFailure = await runtime.inspectOwnedFragments(material.file_key, owner).catch(() => null);
        if (afterFailure?.state === "missing") return "ready";
        if (afterFailure?.state === "foreign_or_unverifiable") return "changed";
        throw careerWriteError("write_failed", "附件暂时无法删除；可使用同一回执继续。", receipt);
      }
      return "ready";
    }
    const deletionOwner = context.deleteFilePayload?.deletionOwner;
    if (!deletionOwner) return "changed";
    let claim;
    try { claim = await runtime.inspectClaimedDeletion(material.file_key, file, deletionOwner); }
    catch {
      throw careerWriteError("inspect_failed", "暂时无法核对附件删除声明；可保留同一回执重试。", receipt);
    }
    if (claim.state === "missing_claim") {
      let candidate;
      try { candidate = await runtime.inspectDeletionCandidate(material.file_key, file); }
      catch {
        throw careerWriteError("inspect_failed", "暂时无法核对待删除附件；可保留同一回执重试。", receipt);
      }
      if (candidate.state !== "exact" && candidate.state !== "missing") return "changed";
      try { await runtime.claimFileDeletion(material.file_key, file, deletionOwner); }
      catch {
        const recovered = await runtime.inspectClaimedDeletion(
          material.file_key,
          file,
          deletionOwner,
        ).catch(() => null);
        if (recovered?.state === "foreign_or_unverifiable") return "changed";
        if (recovered?.state !== "owned") {
          let afterCandidate;
          try { afterCandidate = await runtime.inspectDeletionCandidate(material.file_key, file); }
          catch {
            throw careerWriteError("inspect_failed", "附件删除声明结果未知；可保留同一回执重试。", receipt);
          }
          if (afterCandidate.state === "verified_changed" ||
            afterCandidate.state === "foreign_or_unverifiable") return "changed";
          throw careerWriteError("write_failed", "附件删除声明未能持久化；没有删除附件。", receipt);
        }
      }
      try { claim = await runtime.inspectClaimedDeletion(material.file_key, file, deletionOwner); }
      catch {
        throw careerWriteError("inspect_failed", "附件删除声明结果未知；可保留同一回执重试。", receipt);
      }
    }
    if (claim.state !== "owned") return "changed";
    try { await runtime.sweepClaimedDeletion(material.file_key, file, deletionOwner); }
    catch {
      const afterFailure = await runtime.inspectClaimedDeletion(material.file_key, file, deletionOwner).catch(() => null);
      if (afterFailure?.state !== "owned" || afterFailure.phase !== "swept") {
        throw careerWriteError("write_failed", "附件删除尚未完成；可使用同一回执继续。", receipt);
      }
    }
    return "ready";
  }

  async function finalizePrivateCleanup(
    receipt: CareerMaterialWriteReceipt,
    context?: MaterialReceiptContext,
  ): Promise<boolean> {
    const capability = receipt.kind === "material-save"
      ? receipt.after.cleanupReceipt
      : receipt.before.fileReceipt;
    if (!capability) return true;
    const capabilityState = receipt.kind === "material-save"
      ? await resolveCareerMaterialFileCleanupReceipt(capability, runtime)
      : await resolveCareerMaterialDeleteFileReceipt(capability, runtime);
    if (capabilityState.state === "completed") {
      return sameCareerMaterialCapabilityBinding(
        capabilityState.binding,
        receiptBinding(receipt),
      );
    }
    if (capabilityState.state !== "active") return false;
    let resolved = context;
    if (!resolved) {
      const contextState = await contextForReceipt(receipt, runtime);
      if (contextState.state === "active") resolved = contextState.context;
    }
    if (!resolved) return false;
    if (receipt.kind === "material-delete") {
      const payload = resolved.deleteFilePayload;
      if (!payload) return false;
      const expected = payload.expectedFile;
      if (payload.deletionOwner && (!expected || expected.stagingOwner === undefined)) {
        const claim = await runtime.inspectClaimedDeletion(
          payload.fileKey,
          expected,
          payload.deletionOwner,
        );
        if (claim.state === "owned") {
          if (claim.phase !== "swept") return false;
          try {
            await runtime.releaseClaimedDeletion(payload.fileKey, expected, payload.deletionOwner);
          } catch (error) {
            const afterRelease = await runtime.inspectClaimedDeletion(
              payload.fileKey,
              expected,
              payload.deletionOwner,
            ).catch(() => null);
            if (afterRelease?.state !== "missing_claim") throw error;
          }
        } else if (claim.state === "missing_claim") {
          const candidate = await runtime.inspectDeletionCandidate(payload.fileKey, expected);
          if (candidate.state !== "missing") return false;
        } else {
          return false;
        }
      }
    }
    return completeCareerMaterialFileCapabilityReceipt(
      capability,
      receiptBinding(receipt),
      runtime,
    );
  }

  async function savedResult(
    outcome: "saved" | "already_saved",
    receipt: CareerMaterialWriteReceipt,
    entityId: string,
    context?: MaterialReceiptContext,
  ): Promise<CareerMaterialWriteResult> {
    let cleanupComplete = false;
    try { cleanupComplete = await finalizePrivateCleanup(receipt, context); }
    catch { /* The exact SQLite marker remains authoritative. */ }
    safeCareerWriteBroadcast(runtime, receipt.kind === "material-save" ? "career-material-saved" : "career-material-deleted");
    return cleanupComplete
      ? { outcome, receipt, entityId, privateFinalize: "completed" }
      : {
          outcome, receipt, entityId,
          privateFinalize: "cleanup_pending",
          cleanupPending: true,
          cleanupRetryable: true,
        };
  }

  async function completeReceiptCapability(
    receipt: CareerMaterialWriteReceipt,
  ): Promise<boolean> {
    const capability = receipt.kind === "material-save"
      ? receipt.after.cleanupReceipt
      : receipt.before.fileReceipt;
    return capability === null || completeCareerMaterialFileCapabilityReceipt(
      capability,
      receiptBinding(receipt),
      runtime,
    );
  }

  async function deleteOwnedAndConfirmMissing(
    key: string,
    owner: string,
  ): Promise<boolean> {
    try { await runtime.deleteOwnedFile(key, owner); }
    catch {
      const afterFailure = await runtime.inspectOwnedFragments(key, owner).catch(() => null);
      if (afterFailure?.state !== "missing") return false;
    }
    const final = await runtime.inspectOwnedFragments(key, owner);
    return final.state === "missing";
  }

  /**
   * A terminal changed/generation-replaced result may still have private work.
   * Only exact ownership and current reference facts can release that work.
   */
  async function finalizeChangedPrivate(
    receipt: CareerMaterialWriteReceipt,
  ): Promise<boolean> {
    const capability = receipt.kind === "material-save"
      ? receipt.after.cleanupReceipt
      : receipt.before.fileReceipt;
    if (!capability) return true;
    const resolved = await contextForReceipt(receipt, runtime);
    if (resolved.state === "completed") return true;
    if (resolved.state !== "active") return false;
    const context = resolved.context;
    if (receipt.kind === "material-save") {
      const staged = context.stagedFile;
      if (!staged) return completeReceiptCapability(receipt);
      const [material, references] = await Promise.all([
        readMaterial(runtime, receipt.after.material.id),
        readReferences(runtime, staged.key),
      ]);
      if (material?.file_key === staged.key || references.length > 0) {
        return completeReceiptCapability(receipt);
      }
      const fragments = await runtime.inspectOwnedFragments(staged.key, staged.stagingOwner);
      if (fragments.state === "foreign_or_unverifiable") return false;
      if (fragments.state === "owned" &&
        !await deleteOwnedAndConfirmMissing(staged.key, staged.stagingOwner)) return false;
      return completeReceiptCapability(receipt);
    }

    const payload = context.deleteFilePayload;
    if (!payload) return completeReceiptCapability(receipt);
    if (receipt.before.fileReferences.some((row) => row.id !== receipt.before.material.id)) {
      return completeReceiptCapability(receipt);
    }
    const currentReferences = await readReferences(runtime, payload.fileKey);
    const stagingOwner = payload.expectedFile?.stagingOwner;
    if (stagingOwner) {
      const fragments = await runtime.inspectOwnedFragments(payload.fileKey, stagingOwner);
      if (fragments.state === "foreign_or_unverifiable") return false;
      if (fragments.state === "owned") {
        if (currentReferences.length > 0 ||
          !await deleteOwnedAndConfirmMissing(payload.fileKey, stagingOwner)) return false;
      }
      return completeReceiptCapability(receipt);
    }
    if (!payload.deletionOwner) return false;
    let claim = await runtime.inspectClaimedDeletion(
      payload.fileKey,
      payload.expectedFile,
      payload.deletionOwner,
    );
    if (claim.state === "foreign_or_unverifiable") return false;
    if (claim.state === "missing_claim") {
      const candidate = await runtime.inspectDeletionCandidate(
        payload.fileKey,
        payload.expectedFile,
      );
      if (candidate.state === "missing" ||
        (candidate.state === "exact" && currentReferences.length > 0)) {
        return completeReceiptCapability(receipt);
      }
      if (candidate.state !== "exact") return false;
      try {
        await runtime.claimFileDeletion(
          payload.fileKey,
          payload.expectedFile,
          payload.deletionOwner,
        );
      } catch {
        // A lost claim response is settled only by an exact owner-bound readback.
      }
      claim = await runtime.inspectClaimedDeletion(
        payload.fileKey,
        payload.expectedFile,
        payload.deletionOwner,
      );
      if (claim.state !== "owned") return false;
    }
    if (claim.phase === "swept") {
      await runtime.releaseClaimedDeletion(
        payload.fileKey,
        payload.expectedFile,
        payload.deletionOwner,
      );
      return completeReceiptCapability(receipt);
    }
    if (currentReferences.length > 0) {
      if (claim.phase !== "claimed" || !claim.objectPresent || !claim.metadataPresent) return false;
      await runtime.abandonClaimedDeletion(
        payload.fileKey,
        payload.expectedFile,
        payload.deletionOwner,
      );
      return completeReceiptCapability(receipt);
    }
    await runtime.sweepClaimedDeletion(
      payload.fileKey,
      payload.expectedFile,
      payload.deletionOwner,
    );
    const swept = await runtime.inspectClaimedDeletion(
      payload.fileKey,
      payload.expectedFile,
      payload.deletionOwner,
    );
    if (swept.state !== "owned" || swept.phase !== "swept") return false;
    await runtime.releaseClaimedDeletion(
      payload.fileKey,
      payload.expectedFile,
      payload.deletionOwner,
    );
    return completeReceiptCapability(receipt);
  }

  async function changedResult(
    receipt: CareerMaterialWriteReceipt,
    entityId: string,
  ): Promise<CareerMaterialWriteResult> {
    let completed = false;
    try { completed = await finalizeChangedPrivate(receipt); }
    catch { /* Unknown private state must keep the durable ticket. */ }
    return completed
      ? {
          outcome: "changed", receipt, entityId, retryable: false,
          privateFinalize: "completed",
        }
      : {
          outcome: "changed", receipt, entityId, retryable: false,
          privateFinalize: "cleanup_pending",
          cleanupPending: true,
          cleanupRetryable: true,
        };
  }

  async function commit(value: unknown): Promise<CareerMaterialWriteResult> {
    const receipt = await parse(value);
    if (!receipt) throw careerWriteError("invalid_receipt", "材料写入回执无效；没有改动资料。");
    const entityId = receiptEntityId(receipt);
    let entered = false;
    try {
      return await runtime.withExclusiveLock(async () => {
        entered = true;
        const markerState = await markerStateUnlocked(receipt);
        if (markerState === "exact_saved") return savedResult("already_saved", receipt, entityId);
        if (markerState === "changed") {
          return changedResult(receipt, entityId);
        }
        const resolved = await contextForReceipt(receipt, runtime);
        if (resolved.state === "unknown") {
          return { outcome: "outcome_uncertain", receipt, entityId, retryable: true };
        }
        if (resolved.state === "completed") {
          return {
            outcome: "changed", receipt, entityId, retryable: false,
            privateFinalize: "completed",
          };
        }
        if (resolved.state !== "active") {
          throw careerWriteError("invalid_receipt", "材料写入回执的私有能力无效；没有改动资料。");
        }
        const context = resolved.context;
        if (await expectedStateUnlocked(context) === "changed" || await prepareFileAction(context) === "changed") {
          return changedResult(receipt, entityId);
        }
        try {
          await runtime.batch(receipt.kind === "material-save"
            ? saveStatements(receipt, context.material)
            : deleteStatements(receipt, deleteExpectedFromContext(receipt, context.deleteFilePayload)));
        }
        catch { /* The transaction may have committed before its response was lost. */ }
        const afterMarker = await markerStateUnlocked(receipt);
        if (afterMarker === "exact_saved") return savedResult("saved", receipt, entityId, context);
        if (afterMarker === "marker_absent" && await expectedStateUnlocked(context) === "expected") {
          throw careerWriteError("write_failed", "材料数据库写入确定没有提交；可保留同一回执重试。", receipt);
        }
        return changedResult(receipt, entityId);
      });
    } catch (error) {
      if (error instanceof Error && "code" in error) throw error;
      if (!entered) throw careerWriteError("lock_unavailable", "无法取得安全写入锁；没有开始材料写入。", receipt);
      return { outcome: "outcome_uncertain", receipt, entityId, retryable: true };
    }
  }

  async function cleanupSafety(value: unknown): Promise<CareerMaterialFileCleanupInspection> {
    const ticket = cleanupTicket(value);
    if (!ticket) {
      throw careerWriteError("invalid_receipt", "材料附件清理凭据无效。");
    }
    try {
      return await runtime.withExclusiveLock(async () => {
        const resolved = await resolveCareerMaterialFileCleanupReceipt(ticket.cleanupReceipt, runtime);
        if (resolved.state === "completed") {
          return resolved.binding.operationId === ticket.operationId &&
            resolved.binding.materialId === ticket.materialId
            ? { state: "already_clean" }
            : { state: "still_unknown", ticket, retryable: true };
        }
        if (resolved.state !== "active" || resolved.payload.operationId !== ticket.operationId ||
          resolved.payload.materialId !== ticket.materialId) {
          return { state: "still_unknown", ticket, retryable: true };
        }
        const payload = resolved.payload;
        const generation = await readCurrentCareerWriteGeneration(runtime);
        if (!sameCareerWriteGeneration(generation, payload)) return { state: "blocked", reason: "generation_changed" };
        if (await readMaterial(runtime, payload.materialId)) return { state: "blocked", reason: "material_present" };
        const references = await readReferences(runtime, payload.stagedFile.key);
        if (references.length > 0) return { state: "blocked", reason: "file_referenced" };
        const fragments = await runtime.inspectOwnedFragments(
          payload.stagedFile.key,
          payload.stagedFile.stagingOwner,
        );
        return fragments.state === "missing" ? { state: "already_clean" }
          : fragments.state === "owned" ? { state: "cleanup_ready", ticket }
            : { state: "blocked", reason: "file_changed" };
      });
    } catch { return { state: "still_unknown", ticket, retryable: true }; }
  }

  async function retryCleanup(value: unknown): Promise<CareerMaterialFileCleanupResult> {
    const ticket = cleanupTicket(value);
    if (!ticket) {
      throw careerWriteError("invalid_receipt", "材料附件清理凭据无效。");
    }
    try {
      return await runtime.withExclusiveLock(async () => {
        const resolved = await resolveCareerMaterialFileCleanupReceipt(ticket.cleanupReceipt, runtime);
        if (resolved.state === "completed") {
          return resolved.binding.operationId === ticket.operationId &&
            resolved.binding.materialId === ticket.materialId
            ? { outcome: "already_cleaned" }
            : { outcome: "cleanup_pending", ticket, retryable: true };
        }
        if (resolved.state !== "active" || resolved.payload.operationId !== ticket.operationId ||
          resolved.payload.materialId !== ticket.materialId) {
          return { outcome: "cleanup_pending", ticket, retryable: true };
        }
        const payload = resolved.payload;
        const generation = await readCurrentCareerWriteGeneration(runtime);
        if (!sameCareerWriteGeneration(generation, payload)) return { outcome: "blocked", reason: "generation_changed" };
        if (await readMaterial(runtime, payload.materialId)) return { outcome: "blocked", reason: "material_present" };
        if ((await readReferences(runtime, payload.stagedFile.key)).length > 0) return { outcome: "blocked", reason: "file_referenced" };
        const fragments = await runtime.inspectOwnedFragments(
          payload.stagedFile.key,
          payload.stagedFile.stagingOwner,
        );
        let cleaned = false;
        if (fragments.state === "missing") {
          cleaned = false;
        } else if (fragments.state !== "owned") {
          return { outcome: "blocked", reason: "file_changed" };
        } else {
          const finalGeneration = await readCurrentCareerWriteGeneration(runtime);
          if (!sameCareerWriteGeneration(finalGeneration, payload)) {
            return { outcome: "blocked", reason: "generation_changed" };
          }
          try {
            cleaned = await runtime.deleteOwnedFile(
              payload.stagedFile.key,
              payload.stagedFile.stagingOwner,
            );
          } catch {
            const afterFailure = await runtime.inspectOwnedFragments(
              payload.stagedFile.key,
              payload.stagedFile.stagingOwner,
            ).catch(() => null);
            if (afterFailure?.state === "missing") cleaned = true;
            else if (afterFailure?.state === "owned") {
              return { outcome: "cleanup_pending", ticket, retryable: true };
            } else if (afterFailure?.state === "foreign_or_unverifiable") {
              return { outcome: "blocked", reason: "file_changed" };
            } else {
              return { outcome: "cleanup_pending", ticket, retryable: true };
            }
          }
        }
        const binding: CareerMaterialCapabilityBinding = {
          generationId: payload.generationId,
          generationSequence: payload.generationSequence,
          operationId: payload.operationId,
          materialId: payload.materialId,
        };
        if (!await completeCareerMaterialFileCapabilityReceipt(
          ticket.cleanupReceipt,
          binding,
          runtime,
        )) return { outcome: "cleanup_pending", ticket, retryable: true };
        return { outcome: cleaned ? "cleaned" : "already_cleaned" };
      });
    } catch { return { outcome: "cleanup_pending", ticket, retryable: true }; }
  }

  async function garbageCollectCleanupCapability(
    value: unknown,
  ): Promise<CareerMaterialFileCleanupGarbageCollectionResult> {
    const ticket = cleanupTicket(value);
    if (!ticket) {
      throw careerWriteError("invalid_receipt", "材料附件清理凭据无效。");
    }
    try {
      return await runtime.withExclusiveLock(async () => {
        const resolved = await resolveCareerMaterialFileCleanupReceipt(ticket.cleanupReceipt, runtime);
        if (resolved.state === "completed") {
          return resolved.binding.operationId === ticket.operationId &&
            resolved.binding.materialId === ticket.materialId
            ? { outcome: "released" }
            : { outcome: "cleanup_pending", ticket, retryable: true };
        }
        if (resolved.state !== "active" || resolved.payload.operationId !== ticket.operationId ||
          resolved.payload.materialId !== ticket.materialId) {
          return { outcome: "cleanup_pending", ticket, retryable: true };
        }
        const payload = resolved.payload;
        const generation = await readCurrentCareerWriteGeneration(runtime);
        const references = await readReferences(runtime, payload.stagedFile.key);
        const material = await readMaterial(runtime, payload.materialId);
        if (references.length > 0 || material?.file_key === payload.stagedFile.key) {
          return await releaseCareerMaterialFileCapabilityReceipt(ticket.cleanupReceipt, runtime)
            ? { outcome: "released" }
            : { outcome: "cleanup_pending", ticket, retryable: true };
        }
        const fragments = await runtime.inspectOwnedFragments(
          payload.stagedFile.key,
          payload.stagedFile.stagingOwner,
        );
        if (fragments.state === "foreign_or_unverifiable") {
          return { outcome: "blocked", reason: "file_changed" };
        }
        if (fragments.state === "missing") {
          return await releaseCareerMaterialFileCapabilityReceipt(ticket.cleanupReceipt, runtime)
            ? { outcome: "released" }
            : { outcome: "cleanup_pending", ticket, retryable: true };
        }
        if (sameCareerWriteGeneration(generation, payload)) {
          return { outcome: "blocked", reason: "cleanup_required" };
        }
        try { await runtime.deleteOwnedFile(payload.stagedFile.key, payload.stagedFile.stagingOwner); }
        catch {
          const afterFailure = await runtime.inspectOwnedFragments(
            payload.stagedFile.key,
            payload.stagedFile.stagingOwner,
          ).catch(() => null);
          if (afterFailure?.state === "owned") {
            return { outcome: "cleanup_pending", ticket, retryable: true };
          }
          if (afterFailure?.state !== "missing") {
            return afterFailure?.state === "foreign_or_unverifiable"
              ? { outcome: "blocked", reason: "file_changed" }
              : { outcome: "cleanup_pending", ticket, retryable: true };
          }
        }
        const finalFragments = await runtime.inspectOwnedFragments(
          payload.stagedFile.key,
          payload.stagedFile.stagingOwner,
        );
        if (finalFragments.state !== "missing") {
          return finalFragments.state === "owned"
            ? { outcome: "cleanup_pending", ticket, retryable: true }
            : { outcome: "blocked", reason: "file_changed" };
        }
        return await releaseCareerMaterialFileCapabilityReceipt(ticket.cleanupReceipt, runtime)
          ? { outcome: "cleaned_and_released" }
          : { outcome: "cleanup_pending", ticket, retryable: true };
      });
    } catch { return { outcome: "cleanup_pending", ticket, retryable: true }; }
  }

  return {
    prepareCareerMaterialSaveWrite: prepareSave,
    prepareCareerMaterialDeleteWrite: prepareDelete,
    inspectCareerMaterialWrite: inspect,
    commitCareerMaterialWrite: commit,
    inspectCareerMaterialFileCleanup: cleanupSafety,
    retryCareerMaterialFileCleanup: retryCleanup,
    garbageCollectCareerMaterialFileCleanupCapability: garbageCollectCleanupCapability,
  } as const;
}

const defaultService = createCareerMaterialWriteStorageService();
export const prepareCareerMaterialSaveWrite = defaultService.prepareCareerMaterialSaveWrite;
export const prepareCareerMaterialDeleteWrite = defaultService.prepareCareerMaterialDeleteWrite;
export const inspectCareerMaterialWrite = defaultService.inspectCareerMaterialWrite;
export const commitCareerMaterialWrite = defaultService.commitCareerMaterialWrite;
export const inspectCareerMaterialFileCleanup = defaultService.inspectCareerMaterialFileCleanup;
export const retryCareerMaterialFileCleanup = defaultService.retryCareerMaterialFileCleanup;
export const garbageCollectCareerMaterialFileCleanupCapability =
  defaultService.garbageCollectCareerMaterialFileCleanupCapability;
