import { localDb } from "@/lib/local-db/client";
import { deleteLocalFile } from "@/lib/local-db/files";
import { withCareerWriteLock } from "./lock";

const DATABASE = "career" as const;
const DELETING_STATUS = "deleting";
const MATERIALS_CHANGE_REASON = "career-materials-changed";

type MaterialDeletionRow = Readonly<{
  id: string;
  status: string;
  file_key: string | null;
}>;

type QueryResult<Row> = Readonly<{ rows: readonly Row[] }>;
type RunResult = Readonly<{ changes: number }>;

export type CareerMaterialsServiceRuntime = Readonly<{
  withExclusiveLock<Result>(operation: () => Promise<Result>): Promise<Result>;
  query<Row extends object>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  run(
    sql: string,
    params?: readonly unknown[],
  ): Promise<RunResult>;
  deleteFile(key: string): Promise<boolean>;
  broadcast(reason: string): void;
}>;

export type CareerMaterialDeletionErrorCode =
  | "invalid_id"
  | "inspect_failed"
  | "mark_failed";

/**
 * Deliberately contains only safe, user-facing Chinese messages. The worker's
 * SQL and OPFS errors stay behind this boundary.
 */
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
  | Readonly<{
      outcome: "already_absent";
      materialId: string;
    }>
  | Readonly<{
      outcome: "cleanup_pending";
      materialId: string;
      reason: CareerMaterialDeletionPendingReason;
      retryable: true;
    }>
  | Readonly<{
      /**
       * The final SQLite response and its verification were both unavailable.
       * Call the inspector or repeat the same deletion; never infer absence.
       */
      outcome: "outcome_uncertain";
      materialId: string;
      retryable: true;
    }>;

export type CareerMaterialDeletionState =
  | Readonly<{
      state: "already_absent";
      materialId: string;
    }>
  | Readonly<{
      state: "present";
      materialId: string;
      hasAttachment: boolean;
      sharesAttachment: boolean;
    }>
  | Readonly<{
      /** The durable row is intentionally visible so cleanup can be retried. */
      state: "cleanup_pending";
      materialId: string;
      hasAttachment: boolean;
      sharesAttachment: boolean;
      retryable: true;
    }>;

const defaultRuntime: CareerMaterialsServiceRuntime = {
  withExclusiveLock: (operation) => withCareerWriteLock(() => operation()),
  query: <Row extends object>(sql: string, params?: readonly unknown[]) =>
    localDb.query<Row>(DATABASE, sql, params),
  run: (sql, params) => localDb.run(DATABASE, sql, params),
  deleteFile: (key) => deleteLocalFile(DATABASE, key),
  // Material changes must not impersonate a database-generation switch: the
  // existing generation channel intentionally reloads the whole page. A
  // future material-specific data channel can be supplied through the service
  // runtime without changing deletion semantics.
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

async function findMaterial(
  runtime: CareerMaterialsServiceRuntime,
  id: string,
): Promise<MaterialDeletionRow | null> {
  const result = await runtime.query<MaterialDeletionRow>(
    `SELECT id,status,file_key
       FROM career_materials
      WHERE id = ?
      LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
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

function sameDeletionIdentity(
  left: MaterialDeletionRow,
  right: MaterialDeletionRow,
): boolean {
  return left.id === right.id && left.file_key === right.file_key;
}

function safeBroadcast(runtime: CareerMaterialsServiceRuntime): void {
  try {
    runtime.broadcast(MATERIALS_CHANGE_REASON);
  } catch {
    // A notification is advisory. It must never reverse a durable result.
  }
}

function pending(
  runtime: CareerMaterialsServiceRuntime,
  materialIdValue: string,
  reason: CareerMaterialDeletionPendingReason,
): CareerMaterialDeletionResult {
  safeBroadcast(runtime);
  return {
    outcome: "cleanup_pending",
    materialId: materialIdValue,
    reason,
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

export function createCareerMaterialsService(
  runtime: CareerMaterialsServiceRuntime = defaultRuntime,
) {
  async function inspect(
    idInput: string,
  ): Promise<CareerMaterialDeletionState> {
    const id = materialId(idInput);
    return runtime.withExclusiveLock(async () => {
      try {
        const row = await findMaterial(runtime, id);
        if (!row) return { state: "already_absent", materialId: id };
        const sharesAttachment = await hasOtherFileReference(runtime, row);
        const common = {
          materialId: id,
          hasAttachment: Boolean(row.file_key),
          sharesAttachment,
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
    idInput: string,
  ): Promise<CareerMaterialDeletionResult> {
    const id = materialId(idInput);
    return runtime.withExclusiveLock(async () => {
      let row: MaterialDeletionRow;
      try {
        const found = await findMaterial(runtime, id);
        if (!found) return { outcome: "already_absent", materialId: id };
        row = found;
      } catch {
        throw new CareerMaterialDeletionError(
          "inspect_failed",
          "暂时无法读取这份材料，请稍后重试。",
        );
      }

      if (row.status !== DELETING_STATUS) {
        try {
          const result = await runtime.run(
            `UPDATE career_materials
                SET status = 'deleting'
              WHERE id = ? AND status = ? AND file_key IS ?`,
            [row.id, row.status, row.file_key],
          );
          if (result.changes !== 1) {
            const recovered = await findMaterial(runtime, id);
            if (
              recovered?.status !== DELETING_STATUS ||
              !sameDeletionIdentity(row, recovered)
            ) {
              return uncertain(runtime, id);
            }
            row = recovered;
          } else {
            row = { ...row, status: DELETING_STATUS };
          }
        } catch {
          let recovered: MaterialDeletionRow | null;
          try {
            recovered = await findMaterial(runtime, id);
          } catch {
            return uncertain(runtime, id);
          }
          if (
            recovered?.status === DELETING_STATUS &&
            sameDeletionIdentity(row, recovered)
          ) {
            row = recovered;
          } else if (recovered && sameDeletionIdentity(row, recovered)) {
            throw new CareerMaterialDeletionError(
              "mark_failed",
              "暂时无法把这份材料放入安全删除队列，请稍后重试。",
            );
          } else {
            return uncertain(runtime, id);
          }
        }
      }

      let sharedReference: boolean;
      try {
        sharedReference = await hasOtherFileReference(runtime, row);
      } catch {
        return pending(runtime, id, "reference_check_failed");
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
          return pending(runtime, id, "file_cleanup_failed");
        }
      }

      try {
        const result = await runtime.run(
          `DELETE FROM career_materials
            WHERE id = ? AND status = 'deleting' AND file_key IS ?`,
          [row.id, row.file_key],
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
        if (
          recovered.status === DELETING_STATUS &&
          sameDeletionIdentity(row, recovered)
        ) {
          return pending(runtime, id, "database_cleanup_failed");
        }
        return uncertain(runtime, id);
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
