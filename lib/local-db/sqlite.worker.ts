import sqlite3InitModule, {
  type BindingSpec,
  type Database,
  type Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";

import {
  DATABASE_FILES,
  type BatchResult,
  type DatabaseExportResult,
  type DatabaseImportResult,
  type DatabaseInitResult,
  type LocalDatabaseName,
  type LocalDbWorkerRequest,
  type LocalDbWorkerResponse,
  type QueryResult,
  type RunResult,
  type SerializedWorkerError,
  type SqlParams,
  type SqlRow,
  type SqlStatement,
} from "./types";

type WorkerScope = {
  onmessage: ((event: MessageEvent<LocalDbWorkerRequest>) => void) | null;
  postMessage(message: LocalDbWorkerResponse, transfer?: Transferable[]): void;
};

type OpenDatabase = {
  db: Database;
  name: LocalDatabaseName;
  filename: `${string}.sqlite3`;
};

class LocalDbWorkerError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "LocalDbWorkerError";
  }
}

const workerScope = globalThis as unknown as WorkerScope;
const openDatabases = new Map<LocalDatabaseName, OpenDatabase>();
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
let sqlitePromise: Promise<Sqlite3Static> | undefined;
let operationQueue = Promise.resolve();

function getSqlite(): Promise<Sqlite3Static> {
  sqlitePromise ??= sqlite3InitModule().then((sqlite3) => {
    if (typeof SharedArrayBuffer === "undefined") {
      throw new LocalDbWorkerError(
        "SQLite OPFS needs a cross-origin-isolated page. Serve COOP: same-origin and COEP: require-corp headers.",
        "CROSS_ORIGIN_ISOLATION_REQUIRED",
      );
    }

    if (!sqlite3.capi.sqlite3_vfs_find("opfs")) {
      throw new LocalDbWorkerError(
        "This browser does not expose the SQLite OPFS VFS. Use a supported non-private browser context.",
        "OPFS_UNAVAILABLE",
      );
    }

    return sqlite3;
  });

  return sqlitePromise;
}

function configureDatabase(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA trusted_schema = OFF;
  `);
}

function schemaVersion(db: Database): number {
  return Number(db.selectValue("PRAGMA user_version") ?? 0);
}

async function openDatabase(
  name: LocalDatabaseName,
): Promise<{ state: OpenDatabase; opened: boolean }> {
  const existing = openDatabases.get(name);
  if (existing?.db.isOpen()) return { state: existing, opened: false };

  const sqlite3 = await getSqlite();
  const filename = DATABASE_FILES[name];
  const db = new sqlite3.oo1.OpfsDb(`/${filename}`, "c");

  try {
    configureDatabase(db);
    const state = { db, name, filename } satisfies OpenDatabase;
    openDatabases.set(name, state);
    return { state, opened: true };
  } catch (error) {
    db.close();
    throw error;
  }
}

async function initDatabase(name: LocalDatabaseName): Promise<DatabaseInitResult> {
  const sqlite3 = await getSqlite();
  const { state } = await openDatabase(name);

  return {
    database: name,
    filename: state.filename,
    persistent: true,
    sqliteVersion: sqlite3.version.libVersion,
    schemaVersion: schemaVersion(state.db),
    seeded: false,
  };
}

function bindStatement(statement: ReturnType<Database["prepare"]>, params?: SqlParams): void {
  const hasValues = Array.isArray(params)
    ? params.length > 0
    : params !== undefined && Object.keys(params).length > 0;
  if (hasValues) statement.bind(params as BindingSpec);
}

function executeQuery<Row extends object = SqlRow>(
  db: Database,
  sql: string,
  params?: SqlParams,
): QueryResult<Row> {
  const statement = db.prepare(sql);
  const columns = statement.columnCount > 0 ? statement.getColumnNames([]) : [];
  const rows: Row[] = [];

  try {
    bindStatement(statement, params);
    while (statement.step()) {
      rows.push(statement.get({}) as Row);
    }
  } finally {
    statement.finalize();
  }

  return { columns, rows, rowCount: rows.length };
}

function executeRun(db: Database, sql: string, params?: SqlParams): RunResult {
  const statement = db.prepare(sql);

  try {
    bindStatement(statement, params);
    while (statement.step()) {
      // Consume RETURNING rows so the statement completes before finalization.
    }
  } finally {
    statement.finalize();
  }

  const lastInsertRowId = db.selectValue("SELECT last_insert_rowid()") ?? null;
  return {
    changes: Number(db.changes()),
    lastInsertRowId:
      typeof lastInsertRowId === "number" || typeof lastInsertRowId === "bigint"
        ? lastInsertRowId
        : null,
  };
}

function executeBatch(
  db: Database,
  statements: readonly SqlStatement[],
  useTransaction = true,
): BatchResult {
  const runStatements = () => statements.map(({ sql, params }) => executeRun(db, sql, params));
  const results = useTransaction
    ? db.transaction("IMMEDIATE", runStatements)
    : runStatements();

  return {
    results,
    changes: results.reduce((total, result) => total + result.changes, 0),
  };
}

function exportBytes(sqlite3: Sqlite3Static, db: Database): Uint8Array {
  db.exec("PRAGMA optimize");
  return sqlite3.capi.sqlite3_js_db_export(db).slice();
}

function assertSQLiteFile(data: Uint8Array): void {
  const header = "SQLite format 3\0";
  if (data.byteLength < 100) {
    throw new LocalDbWorkerError("The import is too small to be a SQLite database.", "INVALID_IMPORT");
  }
  if (data.byteLength > MAX_IMPORT_BYTES) {
    throw new LocalDbWorkerError(
      "The SQLite import exceeds the 512 MiB safety limit.",
      "IMPORT_TOO_LARGE",
    );
  }

  for (let index = 0; index < header.length; index += 1) {
    if (data[index] !== header.charCodeAt(index)) {
      throw new LocalDbWorkerError("The import is not a SQLite 3 database.", "INVALID_IMPORT");
    }
  }
}

function assertIntegrity(db: Database): void {
  const integrity = db.selectValue("PRAGMA integrity_check");
  if (integrity !== "ok") {
    throw new LocalDbWorkerError(
      `SQLite integrity check failed: ${String(integrity ?? "unknown error")}`,
      "IMPORT_INTEGRITY_FAILED",
    );
  }

  const foreignKeyFailures = db.selectObjects("PRAGMA foreign_key_check");
  if (foreignKeyFailures.length > 0) {
    throw new LocalDbWorkerError(
      `SQLite foreign-key check found ${foreignKeyFailures.length} violation(s).`,
      "IMPORT_FOREIGN_KEY_FAILED",
    );
  }
}

async function replaceDatabase(
  name: LocalDatabaseName,
  replacement: Uint8Array,
): Promise<DatabaseInitResult> {
  const sqlite3 = await getSqlite();
  const { state } = await openDatabase(name);
  const backup = exportBytes(sqlite3, state.db);
  const filename = state.filename;

  state.db.close();
  openDatabases.delete(name);

  let replacementDb: Database | undefined;
  try {
    await sqlite3.oo1.OpfsDb.importDb(`/${filename}`, replacement);
    replacementDb = new sqlite3.oo1.OpfsDb(`/${filename}`, "c");
    configureDatabase(replacementDb);
    assertIntegrity(replacementDb);
    openDatabases.set(name, { db: replacementDb, name, filename });

    return {
      database: name,
      filename,
      persistent: true,
      sqliteVersion: sqlite3.version.libVersion,
      schemaVersion: schemaVersion(replacementDb),
      seeded: false,
    };
  } catch (error) {
    replacementDb?.close();
    openDatabases.delete(name);

    try {
      await sqlite3.oo1.OpfsDb.importDb(`/${filename}`, backup);
      const restored = new sqlite3.oo1.OpfsDb(`/${filename}`, "c");
      configureDatabase(restored);
      openDatabases.set(name, { db: restored, name, filename });
    } catch {
      // Preserve the original import error; a subsequent init will retry opening.
    }

    throw error;
  }
}

function createEmptyDatabase(sqlite3: Sqlite3Static): Uint8Array {
  const memoryDb = new sqlite3.oo1.DB(":memory:", "c");
  try {
    // Force SQLite to materialize a valid, non-empty database image.
    memoryDb.exec(`
      CREATE TABLE __local_db_reset_sentinel (id INTEGER PRIMARY KEY);
      DROP TABLE __local_db_reset_sentinel;
      VACUUM;
    `);
    return sqlite3.capi.sqlite3_js_db_export(memoryDb).slice();
  } finally {
    memoryDb.close();
  }
}

async function handleRequest(request: LocalDbWorkerRequest): Promise<unknown> {
  const { state } = await openDatabase(request.database);

  switch (request.operation) {
    case "init":
      return initDatabase(request.database);
    case "query":
      return executeQuery(state.db, request.sql, request.params);
    case "run":
      return executeRun(state.db, request.sql, request.params);
    case "batch":
      return executeBatch(
        state.db,
        request.statements,
        request.transaction ?? true,
      );
    case "export": {
      const sqlite3 = await getSqlite();
      const data = exportBytes(sqlite3, state.db);
      return {
        database: request.database,
        filename: state.filename,
        schemaVersion: schemaVersion(state.db),
        exportedAt: new Date().toISOString(),
        data,
      } satisfies DatabaseExportResult;
    }
    case "import": {
      const data = new Uint8Array(request.data);
      assertSQLiteFile(data);
      const result = await replaceDatabase(request.database, data);
      return { ...result, importedBytes: data.byteLength } satisfies DatabaseImportResult;
    }
    case "reset": {
      const sqlite3 = await getSqlite();
      return replaceDatabase(request.database, createEmptyDatabase(sqlite3));
    }
  }
}

function serializeError(error: unknown): SerializedWorkerError {
  if (error instanceof LocalDbWorkerError) {
    return { name: error.name, message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

function transferablesFor(result: unknown): Transferable[] {
  if (
    result &&
    typeof result === "object" &&
    "data" in result &&
    (result as { data?: unknown }).data instanceof Uint8Array
  ) {
    return [(result as { data: Uint8Array }).data.buffer];
  }
  return [];
}

async function respond(request: LocalDbWorkerRequest): Promise<void> {
  try {
    const result = await handleRequest(request);
    workerScope.postMessage(
      { id: request.id, ok: true, result },
      transferablesFor(result),
    );
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      ok: false,
      error: serializeError(error),
    });
  }
}

workerScope.onmessage = (event) => {
  operationQueue = operationQueue.then(() => respond(event.data));
};
