import { localDb } from "@/lib/local-db/client";
import type { SqlStatement } from "@/lib/local-db/types";
import {
  broadcastCareerDataChanged,
  withCareerWriteLock,
} from "./lock";

export const CAREER_WRITE_RECEIPT_VERSION = 1 as const;
export const CAREER_WRITE_RECEIPT_MAX_JSON_BYTES = 8 * 1_048_576;

const DATABASE = "career" as const;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATION_ID_PATTERN = new RegExp(
  `^(?:legacy|${UUID_V4_PATTERN.source.slice(1, -1)})$`,
  "i",
);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type CareerWritePurpose =
  | "career-lifecycle-write"
  | "career-task-write"
  | "career-contact-write"
  | "career-import-write"
  | "career-material-write";

export type CareerWriteKind =
  | "stage-transition"
  | "job-archive"
  | "job-restore"
  | "task-create"
  | "task-complete"
  | "contact-create"
  | "contact-update"
  | "contact-archive"
  | "contact-restore"
  | "contact-interaction-create"
  | "contact-task-create"
  | "job-import-batch"
  | "material-save"
  | "material-delete";

export type CareerWriteGenerationExpectation = Readonly<{
  generationId: string;
  generationSequence: number;
}>;

export type CareerWriteReceiptBase<
  Purpose extends CareerWritePurpose,
  Kind extends CareerWriteKind,
  Before,
  After,
> = Readonly<{
  purpose: Purpose;
  version: typeof CAREER_WRITE_RECEIPT_VERSION;
  kind: Kind;
  operationId: string;
  generationId: string;
  generationSequence: number;
  operationAt: string;
  before: Before;
  after: After;
  projectionSha256: string;
}>;

export type CareerWriteInspection =
  | "exact_saved"
  | "expected"
  | "changed"
  | "still_unknown"
  | "invalid_receipt";

export type CareerWriteCommitResult<Receipt> =
  | Readonly<{
      outcome: "saved" | "already_saved";
      receipt: Receipt;
      entityId: string;
    }>
  | Readonly<{
      outcome: "changed";
      receipt: Receipt;
      entityId: string;
      retryable: false;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      receipt: Receipt;
      entityId: string;
      retryable: true;
    }>;

export type CareerWriteErrorCode =
  | "invalid_input"
  | "invalid_receipt"
  | "lock_unavailable"
  | "inspect_failed"
  | "changed"
  | "write_failed";

export class CareerWriteError extends Error {
  readonly name = "CareerWriteError";

  constructor(
    readonly code: CareerWriteErrorCode,
    message: string,
    readonly receipt?: unknown,
  ) {
    super(message);
  }
}

export type CareerWriteQueryResult<Row extends object> = Readonly<{
  rows: readonly Row[];
}>;

export type CareerWriteBatchResult = Readonly<{ changes: number }>;

export type CareerWriteStorageRuntime = Readonly<{
  withExclusiveLock<Result>(operation: () => Promise<Result>): Promise<Result>;
  query<Row extends object>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<CareerWriteQueryResult<Row>>;
  batch(statements: readonly SqlStatement[]): Promise<CareerWriteBatchResult>;
  currentGeneration(): Promise<Readonly<{
    generationId: string;
    sequence: number;
  }>>;
  now(): number;
  randomUUID(): string;
  broadcast(reason: string): void;
}>;

export type StoredCareerWriteMarker = Readonly<{
  operation_id: string;
  purpose: string;
  receipt_version: number;
  kind: string;
  entity_id: string;
  projection_sha256: string;
  operation_at: string;
}>;

export type CareerWriteMarkerIdentity = Readonly<{
  purpose: CareerWritePurpose;
  version: typeof CAREER_WRITE_RECEIPT_VERSION;
  kind: CareerWriteKind;
  operationId: string;
  operationAt: string;
  projectionSha256: string;
}>;

export type SqlPredicate = Readonly<{
  sql: string;
  params: readonly unknown[];
}>;

function requiredBrowserWriteLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const locks = typeof navigator === "undefined"
    ? null
    : (navigator as Navigator & { locks?: unknown }).locks ?? null;
  if (!locks) {
    throw careerWriteError(
      "lock_unavailable",
      "当前浏览器不支持安全的跨标签页写入锁，请使用最新版 Chrome、Edge 或 Safari。",
    );
  }
  return withCareerWriteLock(() => operation());
}

export const defaultCareerWriteStorageRuntime: CareerWriteStorageRuntime = {
  withExclusiveLock: requiredBrowserWriteLock,
  query: <Row extends object>(sql: string, params?: readonly unknown[]) =>
    localDb.query<Row>(DATABASE, sql, params),
  batch: (statements) =>
    localDb.batch(DATABASE, statements, { transaction: true }),
  currentGeneration: () => localDb.currentGeneration(DATABASE),
  now: () => Date.now(),
  randomUUID: () => crypto.randomUUID(),
  broadcast: (reason) => broadcastCareerDataChanged(reason),
};

export function careerWriteError(
  code: CareerWriteErrorCode,
  message: string,
  receipt?: unknown,
): CareerWriteError {
  return new CareerWriteError(code, message, receipt);
}

export function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

export function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isCareerWriteGeneration(
  value: unknown,
): value is CareerWriteGenerationExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const generation = value as Partial<CareerWriteGenerationExpectation>;
  return exactKeys(value, ["generationId", "generationSequence"]) &&
    typeof generation.generationId === "string" &&
    GENERATION_ID_PATTERN.test(generation.generationId) &&
    isSafeInteger(generation.generationSequence) &&
    generation.generationSequence >= 0;
}

export function sameCareerWriteGeneration(
  left: CareerWriteGenerationExpectation,
  right: CareerWriteGenerationExpectation,
): boolean {
  return left.generationId === right.generationId &&
    left.generationSequence === right.generationSequence;
}

export function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}

export function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw careerWriteError("invalid_input", `${label}不是有效时间。`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw careerWriteError("invalid_input", `${label}不是有效时间。`);
  }
  return new Date(milliseconds).toISOString();
}

export function strictlyLaterTimestamp(
  requestedMilliseconds: number,
  previousTimestamps: readonly (string | null)[],
): string {
  const previous = previousTimestamps.reduce((maximum, value) => {
    if (value === null) return maximum;
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) {
      throw careerWriteError("changed", "存储时间无法形成可靠的新版本；没有准备写入。");
    }
    return Math.max(maximum, milliseconds);
  }, Number.NEGATIVE_INFINITY);
  return new Date(Math.max(requestedMilliseconds, previous + 1)).toISOString();
}

export function requiredText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (typeof value !== "string") {
    throw careerWriteError("invalid_input", `${label}不能为空。`);
  }
  const normalized = value.trim();
  if (!normalized) throw careerWriteError("invalid_input", `${label}不能为空。`);
  if (normalized.length > maximum) {
    throw careerWriteError("invalid_input", `${label}过长。`);
  }
  return normalized;
}

export function optionalId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, label, 240);
}

export function generatedCareerWriteOperationId(
  runtime: CareerWriteStorageRuntime,
  purpose: CareerWritePurpose,
): string {
  const family: Record<CareerWritePurpose, string> = {
    "career-lifecycle-write": "lifecycle",
    "career-task-write": "task",
    "career-contact-write": "contact",
    "career-import-write": "import",
    "career-material-write": "material",
  };
  const prefix = family[purpose];
  const operationId = `career-${prefix}-operation-${runtime.randomUUID()}`;
  const pattern = new RegExp(
    `^career-${prefix}-operation-${UUID_V4_PATTERN.source.slice(1, -1)}$`,
    "i",
  );
  if (!pattern.test(operationId)) {
    throw careerWriteError("invalid_input", "无法生成可靠的职迹操作标识。");
  }
  return operationId;
}

export function isCareerWriteOperationId(
  value: unknown,
  purpose: CareerWritePurpose,
): value is string {
  if (typeof value !== "string") return false;
  const family: Record<CareerWritePurpose, string> = {
    "career-lifecycle-write": "lifecycle",
    "career-task-write": "task",
    "career-contact-write": "contact",
    "career-import-write": "import",
    "career-material-write": "material",
  };
  return new RegExp(
    `^career-${family[purpose]}-operation-${UUID_V4_PATTERN.source.slice(1, -1)}$`,
    "i",
  ).test(value);
}

/** SQLite's default BINARY collation compares the UTF-8 bytes, not locale text. */
export function compareSqliteBinaryText(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index];
    }
  }
  return leftBytes.length - rightBytes.length;
}

export function generatedCareerTaskId(runtime: CareerWriteStorageRuntime): string {
  const id = `task_${runtime.randomUUID()}`;
  return new RegExp(`^task_${UUID_V4_PATTERN.source.slice(1, -1)}$`, "i").test(id)
    ? id
    : (() => {
        throw careerWriteError("invalid_input", "无法生成可靠的待办标识。");
      })();
}

export function isGeneratedCareerTaskId(value: unknown): value is string {
  return typeof value === "string" &&
    new RegExp(`^task_${UUID_V4_PATTERN.source.slice(1, -1)}$`, "i").test(value);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number");
      return JSON.stringify(value);
    case "object": {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
    }
    default:
      throw new TypeError("unsupported canonical JSON value");
  }
}

function encodedJsonSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function jsonClone<Value>(
  value: unknown,
  maximumBytes = CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
  label = "职迹写入回执",
): Value {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw careerWriteError("invalid_input", `${label}无法序列化。`);
  }
  if (serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength > maximumBytes) {
    throw careerWriteError("invalid_input", `${label}过大。`);
  }
  try {
    return JSON.parse(serialized) as Value;
  } catch {
    throw careerWriteError("invalid_input", `${label}无法解析。`);
  }
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

export async function hashCareerWriteValue(value: unknown): Promise<string> {
  return sha256(value);
}

export async function sealCareerWriteReceipt<
  Receipt extends { projectionSha256: string },
>(value: Omit<Receipt, "projectionSha256">): Promise<Receipt> {
  const cloned = jsonClone<Omit<Receipt, "projectionSha256"> & object>(
    value,
    CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
  );
  const projectionSha256 = await sha256(cloned);
  const receipt = { ...cloned, projectionSha256 } as Receipt;
  if (encodedJsonSize(receipt) > CAREER_WRITE_RECEIPT_MAX_JSON_BYTES) {
    throw careerWriteError("invalid_input", "职迹写入回执过大。");
  }
  return receipt;
}

export async function careerWriteReceiptHashIsValid(
  receipt: { projectionSha256: unknown } & object,
): Promise<boolean> {
  if (typeof receipt.projectionSha256 !== "string" ||
    !SHA256_PATTERN.test(receipt.projectionSha256)) return false;
  const { projectionSha256, ...payload } = receipt as Record<string, unknown>;
  return await sha256(payload) === projectionSha256;
}

export async function readCurrentCareerWriteGeneration(
  runtime: CareerWriteStorageRuntime,
): Promise<CareerWriteGenerationExpectation> {
  const current = await runtime.currentGeneration();
  const generation = {
    generationId: current?.generationId,
    generationSequence: current?.sequence,
  };
  if (!isCareerWriteGeneration(generation)) {
    throw new Error("无法确认当前职迹数据库世代。");
  }
  return generation;
}

export function requireCurrentCareerWriteGeneration(
  current: CareerWriteGenerationExpectation,
  expected: CareerWriteGenerationExpectation,
): void {
  if (!sameCareerWriteGeneration(current, expected)) {
    throw careerWriteError("changed", "职迹数据库世代已经更换；没有准备写入。");
  }
}

export async function readCareerWriteMarker(
  runtime: CareerWriteStorageRuntime,
  operationId: string,
): Promise<StoredCareerWriteMarker | null> {
  const rows = (await runtime.query<StoredCareerWriteMarker>(
    `SELECT operation_id,purpose,receipt_version,kind,entity_id,
      projection_sha256,operation_at
      FROM career_write_operations
      WHERE operation_id=? ORDER BY operation_id LIMIT 2`,
    [operationId],
  )).rows;
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error("职迹操作标记不唯一。");
  return { ...rows[0] };
}

export function exactCareerWriteMarker(
  marker: StoredCareerWriteMarker,
  receipt: CareerWriteMarkerIdentity,
  entityId: string,
): boolean {
  return marker.operation_id === receipt.operationId &&
    marker.purpose === receipt.purpose &&
    marker.receipt_version === receipt.version &&
    marker.kind === receipt.kind &&
    marker.entity_id === entityId &&
    marker.projection_sha256 === receipt.projectionSha256 &&
    marker.operation_at === receipt.operationAt;
}

export function joinedPredicate(
  predicates: readonly SqlPredicate[],
): SqlPredicate {
  return {
    sql: predicates.length === 0
      ? "1=1"
      : predicates.map(({ sql }) => `(${sql})`).join(" AND "),
    params: predicates.flatMap(({ params }) => params),
  };
}

export function markerAbsentPredicate(operationId: string): SqlPredicate {
  return {
    sql: "NOT EXISTS(SELECT 1 FROM career_write_operations WHERE operation_id=?)",
    params: [operationId],
  };
}

export function idAbsentPredicate(
  table: "career_tasks" | "career_lifecycle_events",
  id: string,
): SqlPredicate {
  return {
    sql: `NOT EXISTS(SELECT 1 FROM ${table} WHERE id=?)`,
    params: [id],
  };
}

export function abortUnless(predicate: SqlPredicate): SqlStatement {
  return {
    sql: `INSERT INTO career_write_operations(
      operation_id,purpose,receipt_version,kind,entity_id,
      projection_sha256,operation_at
      ) SELECT '__career_write_cas_abort__','career-task-write',0,
        'task-complete','__abort__',
        '0000000000000000000000000000000000000000000000000000000000000000',
        '__abort__'
      WHERE NOT (${predicate.sql})`,
    params: predicate.params,
  };
}

export function markerStatement(
  receipt: CareerWriteMarkerIdentity,
  entityId: string,
): SqlStatement {
  return {
    sql: `INSERT INTO career_write_operations(
      operation_id,purpose,receipt_version,kind,entity_id,
      projection_sha256,operation_at
    ) VALUES(?,?,?,?,?,?,?)`,
    params: [
      receipt.operationId,
      receipt.purpose,
      receipt.version,
      receipt.kind,
      entityId,
      receipt.projectionSha256,
      receipt.operationAt,
    ],
  };
}

export function safeCareerWriteBroadcast(
  runtime: CareerWriteStorageRuntime,
  reason: string,
): void {
  try {
    runtime.broadcast(reason);
  } catch {
    // A refresh hint cannot reverse a durable SQLite transaction.
  }
}

export async function withCareerWritePrepareLock<Result>(
  runtime: CareerWriteStorageRuntime,
  operation: () => Promise<Result>,
): Promise<Result> {
  let entered = false;
  try {
    return await runtime.withExclusiveLock(async () => {
      entered = true;
      return operation();
    });
  } catch (error) {
    if (error instanceof CareerWriteError) throw error;
    if (!entered) {
      throw careerWriteError("lock_unavailable", "无法取得安全的职迹写入锁；没有开始写入。");
    }
    throw careerWriteError("inspect_failed", "暂时无法核对最新职迹资料；没有开始写入。");
  }
}
