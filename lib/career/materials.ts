import { localDb } from "@/lib/local-db/client";
import { deleteLocalFile } from "@/lib/local-db/files";
import { withCareerWriteLock } from "./lock";

const DATABASE = "career" as const;
const CANONICAL_DATABASE = "zhiji" as const;
const DELETING_STATUS = "deleting";
const MATERIALS_CHANGE_REASON = "career-materials-changed";
const RECEIPT_PURPOSE = "career-material-deletion" as const;
const RECEIPT_VERSION = 1 as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type MaterialDeletionRow = Readonly<{
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

type CurrentCareerGeneration = Readonly<{
  database: string;
  generationId: string;
  sequence: number;
}>;

type MaterialDeletionReceiptPayload = Readonly<{
  database: typeof CANONICAL_DATABASE;
  generationId: string;
  generationSequence: number;
  material: Readonly<{
    id: string;
    name: string;
    kind: string;
    version: string;
    updatedAt: string;
    linkedJobId: string | null;
    status: string;
    notes: string;
    fileKey: string | null;
    fileName: string | null;
    mimeType: string | null;
    byteSize: number | null;
  }>;
}>;

type QueryResult<Row> = Readonly<{ rows: readonly Row[] }>;
type RunResult = Readonly<{ changes: number }>;

export type CareerMaterialsServiceRuntime = Readonly<{
  withExclusiveLock<Result>(operation: () => Promise<Result>): Promise<Result>;
  currentGeneration(): Promise<CurrentCareerGeneration>;
  query<Row extends object>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  run(sql: string, params?: readonly unknown[]): Promise<RunResult>;
  deleteFile(key: string): Promise<boolean>;
  broadcast(reason: string): void;
}>;

/** JSON-safe but opaque to the UI; binds a confirmation to one exact row. */
export type CareerMaterialDeletionReceipt = Readonly<{
  purpose: typeof RECEIPT_PURPOSE;
  version: typeof RECEIPT_VERSION;
  payload: string;
  digest: string;
}>;

export type CareerMaterialDeletionErrorCode =
  | "invalid_id"
  | "invalid_receipt"
  | "inspect_failed"
  | "mark_failed";

export class CareerMaterialDeletionError extends Error {
  readonly name = "CareerMaterialDeletionError";

  constructor(
    readonly code: CareerMaterialDeletionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type CareerMaterialDeletedFileAction =
  | "not_attached"
  | "retained_shared"
  | "removed"
  | "already_absent";

export type CareerMaterialDeletionPendingReason =
  | "reference_check_failed"
  | "file_cleanup_failed"
  | "database_cleanup_failed";

export type CareerMaterialDeletionResult =
  | Readonly<{
      outcome: "deleted";
      materialId: string;
      fileAction: CareerMaterialDeletedFileAction;
    }>
  | Readonly<{ outcome: "already_absent"; materialId: string }>
  | Readonly<{ outcome: "changed"; materialId: string; retryable: true }>
  | Readonly<{
      outcome: "cleanup_pending";
      materialId: string;
      reason: CareerMaterialDeletionPendingReason;
      /** A retry must use this receipt, not the pre-mark confirmation. */
      receipt: CareerMaterialDeletionReceipt;
      retryable: true;
    }>
  | Readonly<{
      /** Inspect again; never infer absence or reuse the old receipt. */
      outcome: "outcome_uncertain";
      materialId: string;
      retryable: true;
    }>;

export type CareerMaterialDeletionState =
  | Readonly<{ state: "already_absent"; materialId: string }>
  | Readonly<{
      state: "present";
      materialId: string;
      hasAttachment: boolean;
      sharesAttachment: boolean;
      receipt: CareerMaterialDeletionReceipt;
    }>
  | Readonly<{
      state: "cleanup_pending";
      materialId: string;
      hasAttachment: boolean;
      sharesAttachment: boolean;
      receipt: CareerMaterialDeletionReceipt;
      retryable: true;
    }>;

const defaultRuntime: CareerMaterialsServiceRuntime = {
  withExclusiveLock: (operation) => withCareerWriteLock(() => operation()),
  currentGeneration: () => localDb.currentGeneration(DATABASE),
  query: <Row extends object>(sql: string, params?: readonly unknown[]) =>
    localDb.query<Row>(DATABASE, sql, params),
  run: (sql, params) => localDb.run(DATABASE, sql, params),
  deleteFile: (key) => deleteLocalFile(DATABASE, key),
  // Ordinary data changes must not impersonate a generation switch.
  broadcast: () => undefined,
};

function materialId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 240 ||
    value !== value.trim() ||
    Array.from(value).some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || point === 127;
    })
  ) {
    throw new CareerMaterialDeletionError(
      "invalid_id",
      "材料标识无效，请刷新后再试。",
    );
  }
  return value;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]);
}

function optionalText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parsePayload(value: unknown): MaterialDeletionReceiptPayload {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value, ["database", "generationId", "generationSequence", "material"])) {
    throw new Error("invalid payload");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.database !== CANONICAL_DATABASE ||
    typeof candidate.generationId !== "string" ||
    candidate.generationId.length === 0 ||
    candidate.generationId.length > 240 ||
    !Number.isSafeInteger(candidate.generationSequence) ||
    Number(candidate.generationSequence) < 0
  ) {
    throw new Error("invalid generation");
  }
  const material = candidate.material;
  if (!material || typeof material !== "object" || Array.isArray(material) ||
    !exactKeys(material, [
      "id", "name", "kind", "version", "updatedAt", "linkedJobId",
      "status", "notes", "fileKey", "fileName", "mimeType", "byteSize",
    ])) {
    throw new Error("invalid material");
  }
  const row = material as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.name !== "string" ||
    typeof row.kind !== "string" ||
    typeof row.version !== "string" ||
    typeof row.updatedAt !== "string" ||
    typeof row.status !== "string" ||
    typeof row.notes !== "string" ||
    !optionalText(row.linkedJobId) ||
    !optionalText(row.fileKey) ||
    !optionalText(row.fileName) ||
    !optionalText(row.mimeType) ||
    !(row.byteSize === null ||
      (Number.isSafeInteger(row.byteSize) && Number(row.byteSize) >= 0))
  ) {
    throw new Error("invalid material fields");
  }
  materialId(row.id);
  return value as MaterialDeletionReceiptPayload;
}

function canonicalPayload(
  generation: CurrentCareerGeneration,
  row: MaterialDeletionRow,
): MaterialDeletionReceiptPayload {
  return {
    database: CANONICAL_DATABASE,
    generationId: generation.generationId,
    generationSequence: generation.sequence,
    material: {
      id: row.id,
      name: row.name,
      kind: row.kind,
      version: row.version,
      updatedAt: row.updated_at,
      linkedJobId: row.linked_job_id,
      status: row.status,
      notes: row.notes,
      fileKey: row.file_key,
      fileName: row.file_name,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
    },
  };
}

function receiptDigestInput(payload: string): string {
  return `private-ai-suite:${RECEIPT_PURPOSE}:v${RECEIPT_VERSION}\n${payload}\n`;
}

async function sha256(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("digest unavailable");
  const bytes = new TextEncoder().encode(value);
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

async function issueReceipt(
  generation: CurrentCareerGeneration,
  row: MaterialDeletionRow,
): Promise<CareerMaterialDeletionReceipt> {
  const payload = JSON.stringify(canonicalPayload(generation, row));
  return {
    purpose: RECEIPT_PURPOSE,
    version: RECEIPT_VERSION,
    payload,
    digest: await sha256(receiptDigestInput(payload)),
  };
}

async function consumeReceipt(
  input: unknown,
): Promise<MaterialDeletionReceiptPayload> {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      !exactKeys(input, ["purpose", "version", "payload", "digest"])) {
      throw new Error("invalid receipt");
    }
    const receipt = input as Record<string, unknown>;
    if (
      receipt.purpose !== RECEIPT_PURPOSE ||
      receipt.version !== RECEIPT_VERSION ||
      typeof receipt.payload !== "string" ||
      typeof receipt.digest !== "string" ||
      !SHA256_PATTERN.test(receipt.digest)
    ) {
      throw new Error("invalid receipt envelope");
    }
    const digest = await sha256(receiptDigestInput(receipt.payload));
    if (digest !== receipt.digest) throw new Error("receipt digest mismatch");
    return parsePayload(JSON.parse(receipt.payload));
  } catch {
    throw new CareerMaterialDeletionError(
      "invalid_receipt",
      "这次删除确认已失效，请重新打开材料后再试。",
    );
  }
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
  receipt: MaterialDeletionReceiptPayload,
): boolean {
  return generation.database === receipt.database &&
    generation.generationId === receipt.generationId &&
    generation.sequence === receipt.generationSequence;
}

async function findMaterial(
  runtime: CareerMaterialsServiceRuntime,
  id: string,
): Promise<MaterialDeletionRow | null> {
  const result = await runtime.query<MaterialDeletionRow>(
    `SELECT id,name,kind,version,updated_at,linked_job_id,status,notes,
            file_key,file_name,mime_type,byte_size
       FROM career_materials
      WHERE id = ?
      LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

function payloadMatchesRow(
  payload: MaterialDeletionReceiptPayload,
  row: MaterialDeletionRow,
): boolean {
  return JSON.stringify(payload.material) ===
    JSON.stringify(canonicalPayload({
      database: payload.database,
      generationId: payload.generationId,
      sequence: payload.generationSequence,
    }, row).material);
}

async function hasOtherFileReference(
  runtime: CareerMaterialsServiceRuntime,
  row: MaterialDeletionRow,
): Promise<boolean> {
  if (!row.file_key) return false;
  const result = await runtime.query<{ has_reference: number }>(
    `SELECT EXISTS(
       SELECT 1
         FROM career_materials
        WHERE file_key = ? AND id <> ?
     ) AS has_reference`,
    [row.file_key, row.id],
  );
  return Number(result.rows[0]?.has_reference ?? 0) === 1;
}

function sameStoredRow(
  left: MaterialDeletionRow,
  right: MaterialDeletionRow,
): boolean {
  return left.id === right.id &&
    left.name === right.name &&
    left.kind === right.kind &&
    left.version === right.version &&
    left.updated_at === right.updated_at &&
    left.linked_job_id === right.linked_job_id &&
    left.status === right.status &&
    left.notes === right.notes &&
    left.file_key === right.file_key &&
    left.file_name === right.file_name &&
    left.mime_type === right.mime_type &&
    left.byte_size === right.byte_size;
}

function deletingRow(row: MaterialDeletionRow): MaterialDeletionRow {
  return { ...row, status: DELETING_STATUS };
}

function rowCasParams(row: MaterialDeletionRow): readonly unknown[] {
  return [
    row.id, row.name, row.kind, row.version, row.updated_at,
    row.linked_job_id, row.status, row.notes, row.file_key,
    row.file_name, row.mime_type, row.byte_size,
  ];
}

const ROW_CAS_WHERE = `id = ? AND name = ? AND kind = ? AND version = ?
  AND updated_at = ? AND linked_job_id IS ? AND status = ? AND notes = ?
  AND file_key IS ? AND file_name IS ? AND mime_type IS ? AND byte_size IS ?`;

function safeBroadcast(runtime: CareerMaterialsServiceRuntime): void {
  try {
    runtime.broadcast(MATERIALS_CHANGE_REASON);
  } catch {
    // A notification is advisory. It must never reverse a durable result.
  }
}

async function pending(
  runtime: CareerMaterialsServiceRuntime,
  generation: CurrentCareerGeneration,
  row: MaterialDeletionRow,
  reason: CareerMaterialDeletionPendingReason,
): Promise<CareerMaterialDeletionResult> {
  const receipt = await issueReceipt(generation, row);
  safeBroadcast(runtime);
  return {
    outcome: "cleanup_pending",
    materialId: row.id,
    reason,
    receipt,
    retryable: true,
  };
}

function uncertain(
  runtime: CareerMaterialsServiceRuntime,
  materialIdValue: string,
): CareerMaterialDeletionResult {
  safeBroadcast(runtime);
  return {
    outcome: "outcome_uncertain",
    materialId: materialIdValue,
    retryable: true,
  };
}

function changed(materialIdValue: string): CareerMaterialDeletionResult {
  return { outcome: "changed", materialId: materialIdValue, retryable: true };
}

export function createCareerMaterialsService(
  runtime: CareerMaterialsServiceRuntime = defaultRuntime,
) {
  async function inspect(
    idInput: string,
  ): Promise<CareerMaterialDeletionState> {
    const id = materialId(idInput);
    return runtime.withExclusiveLock(async () => {
      try {
        const generation = await runtime.currentGeneration();
        if (!validGeneration(generation)) throw new Error("invalid generation");
        const row = await findMaterial(runtime, id);
        if (!row) return { state: "already_absent", materialId: id };
        const sharesAttachment = await hasOtherFileReference(runtime, row);
        const receipt = await issueReceipt(generation, row);
        const common = {
          materialId: id,
          hasAttachment: Boolean(row.file_key),
          sharesAttachment,
          receipt,
        };
        return row.status === DELETING_STATUS
          ? { state: "cleanup_pending", ...common, retryable: true as const }
          : { state: "present", ...common };
      } catch {
        throw new CareerMaterialDeletionError(
          "inspect_failed",
          "暂时无法确认这份材料的删除状态，请稍后重试。",
        );
      }
    });
  }

  async function remove(
    receiptInput: CareerMaterialDeletionReceipt,
  ): Promise<CareerMaterialDeletionResult> {
    const receipt = await consumeReceipt(receiptInput);
    const id = receipt.material.id;
    return runtime.withExclusiveLock(async () => {
      let generation: CurrentCareerGeneration;
      let row: MaterialDeletionRow;
      try {
        generation = await runtime.currentGeneration();
        if (!validGeneration(generation)) throw new Error("invalid generation");
        if (!sameGeneration(generation, receipt)) return changed(id);
        const found = await findMaterial(runtime, id);
        if (!found) return { outcome: "already_absent", materialId: id };
        if (!payloadMatchesRow(receipt, found)) return changed(id);
        row = found;
      } catch {
        throw new CareerMaterialDeletionError(
          "inspect_failed",
          "暂时无法读取这份材料，请稍后重试。",
        );
      }

      if (row.status !== DELETING_STATUS) {
        const marked = deletingRow(row);
        try {
          const result = await runtime.run(
            `UPDATE career_materials
                SET status = 'deleting'
              WHERE ${ROW_CAS_WHERE}`,
            rowCasParams(row),
          );
          if (result.changes !== 1) {
            const recovered = await findMaterial(runtime, id);
            if (!recovered || !sameStoredRow(marked, recovered)) {
              return changed(id);
            }
            row = recovered;
          } else {
            row = marked;
          }
        } catch {
          let recovered: MaterialDeletionRow | null;
          try {
            recovered = await findMaterial(runtime, id);
          } catch {
            return uncertain(runtime, id);
          }
          if (recovered && sameStoredRow(marked, recovered)) {
            row = recovered;
          } else if (recovered && sameStoredRow(row, recovered)) {
            throw new CareerMaterialDeletionError(
              "mark_failed",
              "暂时无法准备这份材料的移除，请稍后重试。",
            );
          } else {
            return changed(id);
          }
        }
      }

      let sharedReference: boolean;
      try {
        sharedReference = await hasOtherFileReference(runtime, row);
      } catch {
        return pending(runtime, generation, row, "reference_check_failed");
      }

      let fileAction: CareerMaterialDeletedFileAction;
      if (!row.file_key) {
        fileAction = "not_attached";
      } else if (sharedReference) {
        fileAction = "retained_shared";
      } else {
        try {
          fileAction = await runtime.deleteFile(row.file_key)
            ? "removed"
            : "already_absent";
        } catch {
          return pending(runtime, generation, row, "file_cleanup_failed");
        }
      }

      try {
        const result = await runtime.run(
          `DELETE FROM career_materials
            WHERE ${ROW_CAS_WHERE}`,
          rowCasParams(row),
        );
        if (result.changes === 1) {
          safeBroadcast(runtime);
          return { outcome: "deleted", materialId: id, fileAction };
        }
      } catch {
        // The statement may have committed before its worker response was lost.
      }

      try {
        const recovered = await findMaterial(runtime, id);
        if (!recovered) {
          safeBroadcast(runtime);
          return { outcome: "deleted", materialId: id, fileAction };
        }
        if (sameStoredRow(row, recovered)) {
          return pending(runtime, generation, row, "database_cleanup_failed");
        }
        return changed(id);
      } catch {
        return uncertain(runtime, id);
      }
    });
  }

  return {
    deleteCareerMaterial: remove,
    inspectCareerMaterialDeletion: inspect,
    loadCareerMaterialDeletionState: inspect,
  } as const;
}

const service = createCareerMaterialsService();

export const deleteCareerMaterial = service.deleteCareerMaterial;
export const inspectCareerMaterialDeletion = service.inspectCareerMaterialDeletion;
export const loadCareerMaterialDeletionState = service.loadCareerMaterialDeletionState;
