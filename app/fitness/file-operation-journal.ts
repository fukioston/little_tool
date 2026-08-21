import {
  isFitnessFileDeleteReceipt,
  isFitnessFileSaveReceipt,
  type FitnessFileDeleteReceipt,
  type FitnessFileSaveReceipt,
} from "@/lib/fitness/files";

export const FITNESS_FILE_OPERATION_PREFIX = "fitness.file-operation.v1:";
export const FITNESS_FILE_OPERATION_MAX_BYTES = 128 * 1024;

export type FitnessFileOperationTicket =
  | Readonly<{
      version: 1;
      kind: "save-check";
      receipt: FitnessFileSaveReceipt;
      recordedAt: string;
    }>
  | Readonly<{
      version: 1;
      kind: "delete-check";
      receipt: FitnessFileDeleteReceipt;
      recordedAt: string;
    }>
  | Readonly<{
      version: 1;
      kind: "save-committed";
      receipt: FitnessFileSaveReceipt;
      recordedAt: string;
    }>
  | Readonly<{
      version: 1;
      kind: "delete-committed";
      receipt: FitnessFileDeleteReceipt;
      recordedAt: string;
    }>;

export type FitnessFileOperationEntry = Readonly<{
  storageKey: string;
  raw: string;
  ticket: FitnessFileOperationTicket;
}>;

export type UnreadableFitnessFileOperation = Readonly<{
  storageKey: string;
  raw: string;
}>;

export type FitnessFileOperationJournal = Readonly<{
  entries: readonly FitnessFileOperationEntry[];
  unreadable: readonly UnreadableFitnessFileOperation[];
  unavailable: boolean;
}>;

export type FitnessFileJournalStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

export type FitnessFileJournalLockManager = Pick<LockManager, "request">;

export type FitnessFileOperationLease = Readonly<{
  committed(): FitnessFileOperationEntry;
  remove(): void;
}>;

export type FitnessFileOperationRunResult<Result> =
  | Readonly<{ outcome: "stale" }>
  | Readonly<{
      outcome: "ran";
      value: Result;
      entry: FitnessFileOperationEntry | null;
    }>;

export type FitnessFileOperationToken = symbol;

type OperationRef = { current: FitnessFileOperationToken | null };

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function operationId(ticket: FitnessFileOperationTicket): string {
  return ticket.receipt.operationId;
}

export function fitnessFileOperationKey(ticket: FitnessFileOperationTicket): string {
  return `${FITNESS_FILE_OPERATION_PREFIX}${operationId(ticket)}`;
}

export function isFitnessFileOperationTicket(value: unknown): value is FitnessFileOperationTicket {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [
    "version", "kind", "receipt", "recordedAt",
  ])) return false;
  const ticket = value as Record<string, unknown>;
  if (
    ticket.version !== 1 ||
    typeof ticket.recordedAt !== "string" ||
    ticket.recordedAt.length > 64 ||
    !Number.isFinite(Date.parse(ticket.recordedAt))
  ) return false;
  if (ticket.kind === "save-check" || ticket.kind === "save-committed") {
    return isFitnessFileSaveReceipt(ticket.receipt) &&
      ticket.receipt.expectedRow.entity_type === "equipment" &&
      ticket.receipt.expectedRow.purpose === "photo";
  }
  return (ticket.kind === "delete-check" || ticket.kind === "delete-committed") &&
    isFitnessFileDeleteReceipt(ticket.receipt) &&
    ticket.receipt.expectedRow.entity_type === "equipment" &&
    ticket.receipt.expectedRow.purpose === "photo";
}

export function createFitnessFileSaveTicket(
  receipt: FitnessFileSaveReceipt,
  recordedAt = new Date().toISOString(),
): FitnessFileOperationTicket {
  const ticket = { version: 1, kind: "save-check", receipt, recordedAt } as const;
  if (!isFitnessFileOperationTicket(ticket)) throw new Error("附件保存核对凭据无效。没有开始写入。");
  return ticket;
}

export function createFitnessFileDeleteTicket(
  receipt: FitnessFileDeleteReceipt,
  recordedAt = new Date().toISOString(),
): FitnessFileOperationTicket {
  const ticket = { version: 1, kind: "delete-check", receipt, recordedAt } as const;
  if (!isFitnessFileOperationTicket(ticket)) throw new Error("附件删除核对凭据无效。没有开始删除。");
  return ticket;
}

export function readFitnessFileOperationJournal(
  storage?: FitnessFileJournalStorage,
): FitnessFileOperationJournal {
  const entries: FitnessFileOperationEntry[] = [];
  const unreadable: UnreadableFitnessFileOperation[] = [];
  if (!storage && (typeof navigator === "undefined" || !navigator.locks)) {
    return { entries, unreadable, unavailable: true };
  }
  try {
    const source = storage ?? window.localStorage;
    for (let index = 0; index < source.length; index += 1) {
      const storageKey = source.key(index);
      if (!storageKey?.startsWith(FITNESS_FILE_OPERATION_PREFIX)) continue;
      let raw = "";
      try {
        raw = source.getItem(storageKey) ?? "";
        if (!raw || raw.length > FITNESS_FILE_OPERATION_MAX_BYTES) throw new Error("invalid ticket size");
        const parsed: unknown = JSON.parse(raw);
        if (!isFitnessFileOperationTicket(parsed)) throw new Error("invalid ticket");
        if (storageKey !== fitnessFileOperationKey(parsed)) throw new Error("misbound ticket");
        entries.push({ storageKey, raw, ticket: parsed });
      } catch {
        unreadable.push({ storageKey, raw });
      }
    }
  } catch {
    return { entries, unreadable, unavailable: true };
  }
  entries.sort((left, right) =>
    left.ticket.recordedAt.localeCompare(right.ticket.recordedAt) ||
    left.storageKey.localeCompare(right.storageKey));
  return { entries, unreadable, unavailable: false };
}

function browserStorage(): FitnessFileJournalStorage {
  if (typeof window === "undefined") throw new Error("当前页面无法保存附件核对线索。没有开始改动。");
  return window.localStorage;
}

async function withJournalLock<Result>(
  storageKey: string,
  operation: () => Result | Promise<Result>,
  locks?: FitnessFileJournalLockManager,
): Promise<Result> {
  const manager = locks ?? (typeof navigator !== "undefined" ? navigator.locks : undefined);
  if (manager) {
    return manager.request(`fitness-file-journal:${storageKey}`, operation);
  }
  throw new Error("当前浏览器无法安全协调多个页面的附件操作；没有开始改动。");
}

export function persistFitnessFileOperationToStorage(
  storage: FitnessFileJournalStorage,
  ticket: FitnessFileOperationTicket,
): FitnessFileOperationEntry {
  if (!isFitnessFileOperationTicket(ticket)) throw new Error("附件核对凭据无效。没有开始改动。");
  const storageKey = fitnessFileOperationKey(ticket);
  const raw = JSON.stringify(ticket);
  if (raw.length > FITNESS_FILE_OPERATION_MAX_BYTES) throw new Error("附件核对线索过大。没有开始改动。");
  const existing = storage.getItem(storageKey);
  if (existing !== null && existing !== raw) throw new Error("另一页已保存同一动作的不同核对线索。没有开始改动。");
  storage.setItem(storageKey, raw);
  if (storage.getItem(storageKey) !== raw) throw new Error("浏览器没有保留附件核对线索。没有开始改动。");
  return { storageKey, raw, ticket };
}

export async function persistFitnessFileOperation(
  ticket: FitnessFileOperationTicket,
): Promise<FitnessFileOperationEntry> {
  const storageKey = fitnessFileOperationKey(ticket);
  return withJournalLock(storageKey, () =>
    persistFitnessFileOperationToStorage(browserStorage(), ticket));
}

export function removeFitnessFileOperationFromStorage(
  storage: FitnessFileJournalStorage,
  entry: FitnessFileOperationEntry | UnreadableFitnessFileOperation,
): boolean {
  const current = storage.getItem(entry.storageKey);
  if (current === null) return true;
  if (current !== entry.raw) return false;
  storage.removeItem(entry.storageKey);
  return storage.getItem(entry.storageKey) !== entry.raw;
}

export async function removeFitnessFileOperation(
  entry: FitnessFileOperationEntry | UnreadableFitnessFileOperation,
): Promise<boolean> {
  return withJournalLock(entry.storageKey, () =>
    removeFitnessFileOperationFromStorage(browserStorage(), entry));
}

function committedTicket(ticket: FitnessFileOperationTicket): FitnessFileOperationTicket {
  if (ticket.kind === "save-check") return { ...ticket, kind: "save-committed" };
  if (ticket.kind === "delete-check") return { ...ticket, kind: "delete-committed" };
  return ticket;
}

function replaceFitnessFileOperationInStorage(
  storage: FitnessFileJournalStorage,
  entry: FitnessFileOperationEntry,
  ticket: FitnessFileOperationTicket,
): FitnessFileOperationEntry {
  if (fitnessFileOperationKey(ticket) !== entry.storageKey) {
    throw new Error("附件核对线索与原动作不一致；没有覆盖现有提醒。");
  }
  if (storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error("另一页已经处理了这条附件核对线索。");
  }
  const raw = JSON.stringify(ticket);
  if (raw.length > FITNESS_FILE_OPERATION_MAX_BYTES) {
    throw new Error("附件核对线索过大；没有覆盖现有提醒。");
  }
  storage.setItem(entry.storageKey, raw);
  if (storage.getItem(entry.storageKey) !== raw) {
    throw new Error("浏览器没有保留最新附件核对线索。");
  }
  return { storageKey: entry.storageKey, raw, ticket };
}

/**
 * Serializes one durable receipt across tabs. The exact raw CAS is checked while
 * the Web Lock is held, and the callback may transition or remove that same
 * ticket before the lock is released.
 */
export async function runWithCurrentFitnessFileOperation<Result>(
  entry: FitnessFileOperationEntry,
  operation: (lease: FitnessFileOperationLease) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: FitnessFileJournalStorage;
    locks?: FitnessFileJournalLockManager | null;
  }>,
): Promise<FitnessFileOperationRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options
    ? options.locks ?? undefined
    : typeof navigator !== "undefined"
      ? navigator.locks
      : undefined;
  if (!locks) {
    throw new Error("当前浏览器无法跨页面锁定附件核对线索；没有继续改动。");
  }
  return withJournalLock(entry.storageKey, async () => {
    if (storage.getItem(entry.storageKey) !== entry.raw) return { outcome: "stale" } as const;
    let current: FitnessFileOperationEntry | null = entry;
    const lease: FitnessFileOperationLease = {
      committed() {
        if (!current) throw new Error("附件核对线索已经结束。");
        current = replaceFitnessFileOperationInStorage(storage, current, committedTicket(current.ticket));
        return current;
      },
      remove() {
        if (!current || !removeFitnessFileOperationFromStorage(storage, current)) {
          throw new Error("另一页已经处理了这条附件核对线索。");
        }
        current = null;
      },
    };
    const value = await operation(lease);
    return { outcome: "ran", value, entry: current } as const;
  }, locks);
}

export function claimFitnessFileOperation(operationRef: OperationRef): FitnessFileOperationToken | null {
  if (operationRef.current) return null;
  const token = Symbol("fitness-file-operation");
  operationRef.current = token;
  return token;
}

export function releaseFitnessFileOperation(
  operationRef: OperationRef,
  token: FitnessFileOperationToken,
): boolean {
  if (operationRef.current !== token) return false;
  operationRef.current = null;
  return true;
}

export function formatFitnessFileByteSize(byteSize: number | null | undefined): string {
  if (!Number.isFinite(byteSize) || Number(byteSize) <= 0) return "大小未记录";
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(byteSize);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const shown = value >= 10 || index === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${shown} ${units[index]}`;
}
