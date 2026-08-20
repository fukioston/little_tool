import type { LocalDatabaseName } from "../schemas";

export type { LocalDatabaseName } from "../schemas";

export type LocalDatabaseId = "career" | "vocab";
export type LocalDatabaseSelector = LocalDatabaseId | LocalDatabaseName;

export type SqlValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Uint8Array;

// Keep the public boundary permissive so feature repositories can accept
// unparsed form values. SQLite remains the final runtime validator.
export type SqlParams =
  | readonly unknown[]
  | Readonly<Record<string, unknown>>;

export type SqlRow = Record<string, Exclude<SqlValue, boolean | undefined>>;

export type SqlStatement = Readonly<{
  sql: string;
  params?: SqlParams;
}>;

export type DatabaseInitResult = Readonly<{
  database: LocalDatabaseName;
  filename: `${string}.sqlite3`;
  persistent: true;
  sqliteVersion: string;
  schemaVersion: number;
  seeded: false;
}>;

export type QueryResult<Row extends object = SqlRow> = Readonly<{
  columns: readonly string[];
  rows: readonly Row[];
  rowCount: number;
}>;

export type RunResult = Readonly<{
  changes: number;
  lastInsertRowId: number | bigint | null;
}>;

export type BatchResult = Readonly<{
  results: readonly RunResult[];
  changes: number;
}>;

export type DatabaseExportResult = Readonly<{
  database: LocalDatabaseName;
  filename: `${string}.sqlite3`;
  schemaVersion: number;
  exportedAt: string;
  data: Uint8Array;
}>;

export type DatabaseImportResult = DatabaseInitResult &
  Readonly<{
    importedBytes: number;
  }>;

export type InitAllResult = Readonly<{
  career: DatabaseInitResult;
  vocab: DatabaseInitResult;
}>;

export type WorkerOperation =
  | "init"
  | "query"
  | "run"
  | "batch"
  | "export"
  | "import"
  | "reset";

type RequestBase<Operation extends WorkerOperation> = Readonly<{
  id: number;
  operation: Operation;
  database: LocalDatabaseName;
}>;

export type LocalDbWorkerRequest =
  | RequestBase<"init">
  | (RequestBase<"query"> & { sql: string; params?: SqlParams })
  | (RequestBase<"run"> & { sql: string; params?: SqlParams })
  | (RequestBase<"batch"> & {
      statements: readonly SqlStatement[];
      transaction?: boolean;
    })
  | RequestBase<"export">
  | (RequestBase<"import"> & { data: ArrayBuffer })
  | RequestBase<"reset">;

type WithoutRequestId<Request> = Request extends unknown
  ? Omit<Request, "id">
  : never;

export type LocalDbWorkerRequestInput = WithoutRequestId<LocalDbWorkerRequest>;

export type SerializedWorkerError = Readonly<{
  name: string;
  message: string;
  code?: string;
}>;

export type LocalDbWorkerResponse =
  | Readonly<{ id: number; ok: true; result: unknown }>
  | Readonly<{ id: number; ok: false; error: SerializedWorkerError }>;

export const DATABASE_FILES: Readonly<
  Record<LocalDatabaseName, `${string}.sqlite3`>
> = {
  zhiji: "zhiji.sqlite3",
  shici: "shici.sqlite3",
};

export function canonicalDatabaseName(
  database: LocalDatabaseSelector,
): LocalDatabaseName {
  if (database === "career") return "zhiji";
  if (database === "vocab") return "shici";
  return database;
}
