import {
  canonicalDatabaseName,
  type ActivatedDatabaseGeneration,
  type BatchResult,
  type CurrentDatabaseGeneration,
  type DatabaseExportResult,
  type DatabaseImportResult,
  type DatabaseInitResult,
  type DatabaseSchemaRequirements,
  type DiscardedDatabaseGeneration,
  type InitAllResult,
  type LocalDatabaseId,
  type LocalDatabaseSelector,
  type LocalDbWorkerRequestInput,
  type LocalDbWorkerRequest,
  type LocalDbWorkerResponse,
  type QueryResult,
  type RunResult,
  type SqlParams,
  type SqlRow,
  type SqlStatement,
  type StagedDatabaseImportResult,
} from "./types";

type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
};

export class LocalDatabaseError extends Error {
  constructor(
    message: string,
    readonly code = "LOCAL_DB_ERROR",
  ) {
    super(message);
    this.name = "LocalDatabaseError";
  }
}

class LocalDbRpcClient {
  private worker: Worker | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  request<Result>(
    request: LocalDbWorkerRequestInput,
    transfer: Transferable[] = [],
  ): Promise<Result> {
    const worker = this.getWorker();
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<Result>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as Result),
        reject,
      });

      worker.postMessage({ ...request, id } as LocalDbWorkerRequest, transfer);
    });
  }

  close(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.rejectAll(
      new LocalDatabaseError("The local database worker was closed.", "WORKER_CLOSED"),
    );
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") {
      throw new LocalDatabaseError(
        "The local database is browser-only and cannot be opened during server rendering.",
        "BROWSER_REQUIRED",
      );
    }

    const bundledWorkerUrl = new URL("./sqlite.worker.ts", import.meta.url);
    const workerUrl = bundledWorkerUrl.protocol === "file:" && typeof window !== "undefined"
      ? new URL(`${bundledWorkerUrl.pathname}${bundledWorkerUrl.search}`, window.location.origin)
      : bundledWorkerUrl;
    const worker = new Worker(workerUrl, {
      type: "module",
      name: "private-ai-suite-sqlite",
    });
    worker.onmessage = (event: MessageEvent<LocalDbWorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);

      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(
          new LocalDatabaseError(response.error.message, response.error.code),
        );
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      if (this.worker === worker) this.worker = undefined;
      this.rejectAll(
        new LocalDatabaseError(
          event.message || "The local database worker crashed.",
          "WORKER_CRASHED",
        ),
      );
    };
    worker.onmessageerror = () => {
      worker.terminate();
      if (this.worker === worker) this.worker = undefined;
      this.rejectAll(
        new LocalDatabaseError(
          "The local database worker returned an unreadable response.",
          "WORKER_MESSAGE_ERROR",
        ),
      );
    };

    this.worker = worker;
    return worker;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

const rpc = new LocalDbRpcClient();

export class LocalDatabaseClient {
  readonly database;

  constructor(database: LocalDatabaseSelector) {
    this.database = canonicalDatabaseName(database);
  }

  init(): Promise<DatabaseInitResult> {
    return rpc.request({ operation: "init", database: this.database });
  }

  query<Row extends object = SqlRow>(
    sql: string,
    params?: SqlParams,
  ): Promise<QueryResult<Row>> {
    return rpc.request({ operation: "query", database: this.database, sql, params });
  }

  run(sql: string, params?: SqlParams): Promise<RunResult> {
    return rpc.request({ operation: "run", database: this.database, sql, params });
  }

  batch(
    statements: readonly SqlStatement[],
    options: Readonly<{ transaction?: boolean }> = {},
  ): Promise<BatchResult> {
    return rpc.request({
      operation: "batch",
      database: this.database,
      statements,
      transaction: options.transaction,
    });
  }

  export(): Promise<DatabaseExportResult> {
    return rpc.request({ operation: "export", database: this.database });
  }

  import(data: Uint8Array | ArrayBuffer): Promise<DatabaseImportResult> {
    const transferable =
      data instanceof Uint8Array
        ? data.slice().buffer
        : data.slice(0);
    return rpc.request(
      { operation: "import", database: this.database, data: transferable },
      [transferable],
    );
  }

  stageImport(
    data: Uint8Array | ArrayBuffer,
    statements: readonly SqlStatement[],
    requirements: DatabaseSchemaRequirements,
  ): Promise<StagedDatabaseImportResult> {
    const transferable =
      data instanceof Uint8Array
        ? data.slice().buffer
        : data.slice(0);
    return rpc.request(
      {
        operation: "stageImport",
        database: this.database,
        data: transferable,
        statements,
        requirements,
      },
      [transferable],
    );
  }

  activateStaged(
    generationId: string,
    activationToken: string,
  ): Promise<ActivatedDatabaseGeneration> {
    return rpc.request({
      operation: "activateStaged",
      database: this.database,
      generationId,
      activationToken,
    });
  }

  currentGeneration(): Promise<CurrentDatabaseGeneration> {
    return rpc.request({
      operation: "currentGeneration",
      database: this.database,
    });
  }

  discardStaged(
    generationId: string,
    activationToken: string,
  ): Promise<DiscardedDatabaseGeneration> {
    return rpc.request({
      operation: "discardStaged",
      database: this.database,
      generationId,
      activationToken,
    });
  }

  reset(): Promise<DatabaseInitResult> {
    return rpc.request({ operation: "reset", database: this.database });
  }
}

const databaseClients = {
  zhiji: new LocalDatabaseClient("zhiji"),
  shici: new LocalDatabaseClient("shici"),
} as const;

export function getLocalDatabase(
  database: LocalDatabaseSelector,
): LocalDatabaseClient {
  return databaseClients[canonicalDatabaseName(database)];
}

export const localDb = {
  async init(database?: LocalDatabaseId): Promise<InitAllResult | DatabaseInitResult> {
    if (database) return getLocalDatabase(database).init();
    const [career, vocab] = await Promise.all([
      getLocalDatabase("career").init(),
      getLocalDatabase("vocab").init(),
    ]);
    return { career, vocab };
  },

  query<Row extends object = SqlRow>(
    database: LocalDatabaseId,
    sql: string,
    params?: SqlParams,
  ): Promise<QueryResult<Row>> {
    return getLocalDatabase(database).query<Row>(sql, params);
  },

  run(
    database: LocalDatabaseId,
    sql: string,
    params?: SqlParams,
  ): Promise<RunResult> {
    return getLocalDatabase(database).run(sql, params);
  },

  batch(
    database: LocalDatabaseId,
    statements: readonly SqlStatement[],
    options?: Readonly<{ transaction?: boolean }>,
  ): Promise<BatchResult> {
    return getLocalDatabase(database).batch(statements, options);
  },

  export(database: LocalDatabaseId): Promise<DatabaseExportResult> {
    return getLocalDatabase(database).export();
  },

  import(
    database: LocalDatabaseId,
    data: Uint8Array | ArrayBuffer,
  ): Promise<DatabaseImportResult> {
    return getLocalDatabase(database).import(data);
  },

  stageImport(
    database: "career",
    data: Uint8Array | ArrayBuffer,
    statements: readonly SqlStatement[],
    requirements: DatabaseSchemaRequirements,
  ): Promise<StagedDatabaseImportResult> {
    return getLocalDatabase(database).stageImport(data, statements, requirements);
  },

  activateStaged(
    database: "career",
    generationId: string,
    activationToken: string,
  ): Promise<ActivatedDatabaseGeneration> {
    return getLocalDatabase(database).activateStaged(generationId, activationToken);
  },

  currentGeneration(
    database: "career",
  ): Promise<CurrentDatabaseGeneration> {
    return getLocalDatabase(database).currentGeneration();
  },

  discardStaged(
    database: "career",
    generationId: string,
    activationToken: string,
  ): Promise<DiscardedDatabaseGeneration> {
    return getLocalDatabase(database).discardStaged(generationId, activationToken);
  },

  reset(database: LocalDatabaseId): Promise<DatabaseInitResult> {
    return getLocalDatabase(database).reset();
  },

  close(): void {
    rpc.close();
  },
};
