import {
  isFitnessLiveWriteReceipt,
  isFitnessLiveStructureWriteReceipt,
  type FitnessLiveWriteReceipt,
  type FitnessLiveStructureWriteReceipt,
} from "@/lib/fitness/store";

export type FitnessDurableLiveWriteReceipt =
  | FitnessLiveWriteReceipt
  | FitnessLiveStructureWriteReceipt;

export const FITNESS_LIVE_WRITE_PREFIX = "fitness.live-write.v1:";
export const FITNESS_LIVE_WRITE_MAX_CHARS = 1024 * 1024;
export const FITNESS_LIVE_WRITE_JOURNAL_LOCK = "fitness-live-write-journal";

export type FitnessLiveWriteTicket = Readonly<{
  version: 1;
  kind: "check" | "committed";
  receipt: FitnessDurableLiveWriteReceipt;
  recordedAt: string;
}>;

export type FitnessLiveWriteEntry = Readonly<{
  storageKey: string;
  raw: string;
  ticket: FitnessLiveWriteTicket;
}>;

export type UnreadableFitnessLiveWrite = Readonly<{ storageKey: string; raw: string }>;
export type FitnessLiveWriteJournal = Readonly<{
  entries: readonly FitnessLiveWriteEntry[];
  unreadable: readonly UnreadableFitnessLiveWrite[];
  unavailable: boolean;
}>;
export type FitnessLiveWriteStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
export type FitnessLiveWriteLocks = Pick<LockManager, "request">;
export type FitnessLiveWriteLease = Readonly<{
  committed(): FitnessLiveWriteEntry;
  remove(): void;
}>;
export type FitnessLiveWriteRunResult<Result> =
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "blocked"; reason: "unavailable" | "unreadable" }>
  | Readonly<{ outcome: "ran"; value: Result; entry: FitnessLiveWriteEntry | null }>;
export type FitnessLiveWriteToken = symbol;
type OperationRef = { current: FitnessLiveWriteToken | null };

function exactKeys(value: object, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function fitnessLiveWriteKey(ticket: FitnessLiveWriteTicket) {
  return `${FITNESS_LIVE_WRITE_PREFIX}${ticket.receipt.operationId}`;
}

export function isFitnessLiveWriteTicket(value: unknown): value is FitnessLiveWriteTicket {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [
    "version", "kind", "receipt", "recordedAt",
  ])) return false;
  const ticket = value as Record<string, unknown>;
  return ticket.version === 1 &&
    (ticket.kind === "check" || ticket.kind === "committed") &&
    typeof ticket.recordedAt === "string" && ticket.recordedAt.length <= 64 &&
    Number.isFinite(Date.parse(ticket.recordedAt)) &&
    (isFitnessLiveWriteReceipt(ticket.receipt) ||
      isFitnessLiveStructureWriteReceipt(ticket.receipt));
}

export function createFitnessLiveWriteTicket(
  receipt: FitnessDurableLiveWriteReceipt,
  recordedAt = new Date().toISOString(),
): FitnessLiveWriteTicket {
  const ticket = { version: 1, kind: "check", receipt, recordedAt } as const;
  if (!isFitnessLiveWriteTicket(ticket)) throw new Error("训练写入回执无效；没有开始写入。");
  return ticket;
}

export function readFitnessLiveWriteJournal(storage?: FitnessLiveWriteStorage): FitnessLiveWriteJournal {
  const entries: FitnessLiveWriteEntry[] = [];
  const unreadable: UnreadableFitnessLiveWrite[] = [];
  if (!storage && (typeof navigator === "undefined" || !navigator.locks)) {
    return { entries, unreadable, unavailable: true };
  }
  try {
    const source = storage ?? window.localStorage;
    for (let index = 0; index < source.length; index += 1) {
      const storageKey = source.key(index);
      if (!storageKey?.startsWith(FITNESS_LIVE_WRITE_PREFIX)) continue;
      let raw = "";
      try {
        raw = source.getItem(storageKey) ?? "";
        if (!raw || raw.length > FITNESS_LIVE_WRITE_MAX_CHARS) throw new Error("invalid size");
        const parsed: unknown = JSON.parse(raw);
        if (!isFitnessLiveWriteTicket(parsed) || fitnessLiveWriteKey(parsed) !== storageKey) {
          throw new Error("invalid ticket");
        }
        entries.push({ storageKey, raw, ticket: parsed });
      } catch {
        unreadable.push({ storageKey, raw });
      }
    }
  } catch {
    return { entries, unreadable, unavailable: true };
  }
  entries.sort((left, right) => left.ticket.recordedAt.localeCompare(right.ticket.recordedAt) ||
    left.storageKey.localeCompare(right.storageKey));
  return { entries, unreadable, unavailable: false };
}

function browserStorage(): FitnessLiveWriteStorage {
  if (typeof window === "undefined") throw new Error("当前页面无法保存训练核对线索；没有开始写入。");
  return window.localStorage;
}

async function withJournalLock<Result>(
  operation: () => Result | Promise<Result>,
  locks?: FitnessLiveWriteLocks,
) {
  const manager = locks ?? (typeof navigator !== "undefined" ? navigator.locks : undefined);
  if (!manager) throw new Error("当前浏览器无法跨页面锁定训练核对线索；没有继续改动。");
  return manager.request(FITNESS_LIVE_WRITE_JOURNAL_LOCK, operation);
}

export function persistFitnessLiveWriteToStorage(
  storage: FitnessLiveWriteStorage,
  ticket: FitnessLiveWriteTicket,
): FitnessLiveWriteEntry {
  if (!isFitnessLiveWriteTicket(ticket)) throw new Error("训练写入回执无效；没有开始写入。");
  const storageKey = fitnessLiveWriteKey(ticket);
  const raw = JSON.stringify(ticket);
  if (raw.length > FITNESS_LIVE_WRITE_MAX_CHARS) throw new Error("训练回执过大；没有开始写入。");
  const existing = storage.getItem(storageKey);
  if (existing !== null && existing !== raw) throw new Error("另一页已有同一动作的不同回执；没有覆盖。");
  storage.setItem(storageKey, raw);
  if (storage.getItem(storageKey) !== raw) throw new Error("浏览器没有保留训练核对线索；没有开始写入。");
  return { storageKey, raw, ticket };
}

export async function persistFitnessLiveWrite(
  ticket: FitnessLiveWriteTicket,
  options?: Readonly<{ storage?: FitnessLiveWriteStorage; locks?: FitnessLiveWriteLocks | null }>,
) {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? undefined :
    typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) throw new Error("当前浏览器无法跨页面锁定训练核对线索；没有开始写入。");
  return withJournalLock(() => {
    const journal = readFitnessLiveWriteJournal(storage);
    if (journal.unavailable) throw new Error("无法安全读取训练核对线索；没有开始写入。");
    if (journal.unreadable.length > 0) throw new Error("先处理无法验证的训练提醒；没有开始写入。");
    if (journal.entries.length > 0) throw new Error("先处理上一条训练写入；没有开始新的写入。");
    return persistFitnessLiveWriteToStorage(storage, ticket);
  }, locks);
}

export function removeFitnessLiveWriteFromStorage(
  storage: FitnessLiveWriteStorage,
  entry: FitnessLiveWriteEntry | UnreadableFitnessLiveWrite,
) {
  const current = storage.getItem(entry.storageKey);
  if (current === null) return true;
  if (current !== entry.raw) return false;
  storage.removeItem(entry.storageKey);
  return storage.getItem(entry.storageKey) !== entry.raw;
}

export async function removeFitnessLiveWrite(entry: FitnessLiveWriteEntry | UnreadableFitnessLiveWrite) {
  return withJournalLock(() => removeFitnessLiveWriteFromStorage(browserStorage(), entry));
}

function replaceFitnessLiveWriteInStorage(
  storage: FitnessLiveWriteStorage,
  entry: FitnessLiveWriteEntry,
  ticket: FitnessLiveWriteTicket,
) {
  if (fitnessLiveWriteKey(ticket) !== entry.storageKey || storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error("另一页已经处理了这条训练核对线索。");
  }
  const raw = JSON.stringify(ticket);
  if (raw.length > FITNESS_LIVE_WRITE_MAX_CHARS) throw new Error("训练核对线索过大；没有覆盖。");
  storage.setItem(entry.storageKey, raw);
  if (storage.getItem(entry.storageKey) !== raw) throw new Error("浏览器没有保留最新训练核对线索。");
  return { storageKey: entry.storageKey, raw, ticket };
}

export async function runWithCurrentFitnessLiveWrite<Result>(
  entry: FitnessLiveWriteEntry,
  operation: (lease: FitnessLiveWriteLease) => Result | Promise<Result>,
  options?: Readonly<{ storage?: FitnessLiveWriteStorage; locks?: FitnessLiveWriteLocks | null }>,
): Promise<FitnessLiveWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? undefined :
    typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) throw new Error("当前浏览器无法跨页面锁定训练核对线索；没有继续改动。");
  return withJournalLock(async () => {
    const journal = readFitnessLiveWriteJournal(storage);
    if (journal.unavailable) return { outcome: "blocked", reason: "unavailable" } as const;
    if (journal.unreadable.length > 0) return { outcome: "blocked", reason: "unreadable" } as const;
    if (storage.getItem(entry.storageKey) !== entry.raw) return { outcome: "stale" } as const;
    let current: FitnessLiveWriteEntry | null = entry;
    const lease: FitnessLiveWriteLease = {
      committed() {
        if (!current) throw new Error("训练核对线索已经结束。");
        current = replaceFitnessLiveWriteInStorage(storage, current, {
          ...current.ticket,
          kind: "committed",
        });
        return current;
      },
      remove() {
        if (!current || !removeFitnessLiveWriteFromStorage(storage, current)) {
          throw new Error("另一页已经处理了这条训练核对线索。");
        }
        current = null;
      },
    };
    const value = await operation(lease);
    return { outcome: "ran", value, entry: current } as const;
  }, locks);
}

export function claimFitnessLiveWrite(operationRef: OperationRef): FitnessLiveWriteToken | null {
  if (operationRef.current) return null;
  const token = Symbol("fitness-live-write");
  operationRef.current = token;
  return token;
}

export function releaseFitnessLiveWrite(operationRef: OperationRef, token: FitnessLiveWriteToken) {
  if (operationRef.current !== token) return false;
  operationRef.current = null;
  return true;
}
