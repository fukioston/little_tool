import {
  isFitnessConfigWriteReceipt,
  type FitnessConfigWriteReceipt,
} from "@/lib/fitness/store";

export const FITNESS_CONFIG_WRITE_PREFIX = "fitness.config-write.v1:";
export const FITNESS_CONFIG_WRITE_MAX_CHARS = 1024 * 1024;
export const FITNESS_CONFIG_WRITE_JOURNAL_LOCK = "fitness-config-write-journal";

export type FitnessConfigWriteTicket = Readonly<{
  version: 1;
  kind: "check" | "committed";
  receipt: FitnessConfigWriteReceipt;
  recordedAt: string;
}>;

export type FitnessConfigWriteEntry = Readonly<{
  storageKey: string;
  raw: string;
  ticket: FitnessConfigWriteTicket;
}>;

export type UnreadableFitnessConfigWrite = Readonly<{
  storageKey: string;
  raw: string;
}>;

export type FitnessConfigWriteJournal = Readonly<{
  entries: readonly FitnessConfigWriteEntry[];
  unreadable: readonly UnreadableFitnessConfigWrite[];
  unavailable: boolean;
}>;

export type FitnessConfigWriteJournalStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;

export type FitnessConfigWriteJournalLockManager = Pick<LockManager, "request">;

export type FitnessConfigWriteLease = Readonly<{
  committed(): FitnessConfigWriteEntry;
  remove(): void;
}>;

export type FitnessConfigWriteRunResult<Result> =
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "blocked"; reason: "unavailable" | "unreadable" }>
  | Readonly<{
      outcome: "ran";
      value: Result;
      entry: FitnessConfigWriteEntry | null;
    }>;

export type FitnessConfigWriteToken = symbol;
type OperationRef = { current: FitnessConfigWriteToken | null };

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

export function fitnessConfigWriteKey(ticket: FitnessConfigWriteTicket): string {
  return `${FITNESS_CONFIG_WRITE_PREFIX}${ticket.receipt.operationId}`;
}

export function isFitnessConfigWriteTicket(value: unknown): value is FitnessConfigWriteTicket {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [
    "version", "kind", "receipt", "recordedAt",
  ])) return false;
  const ticket = value as Record<string, unknown>;
  return ticket.version === 1 &&
    (ticket.kind === "check" || ticket.kind === "committed") &&
    typeof ticket.recordedAt === "string" &&
    ticket.recordedAt.length <= 64 &&
    Number.isFinite(Date.parse(ticket.recordedAt)) &&
    isFitnessConfigWriteReceipt(ticket.receipt);
}

export function createFitnessConfigWriteTicket(
  receipt: FitnessConfigWriteReceipt,
  recordedAt = new Date().toISOString(),
): FitnessConfigWriteTicket {
  const ticket = { version: 1, kind: "check", receipt, recordedAt } as const;
  if (!isFitnessConfigWriteTicket(ticket)) {
    throw new Error("资料写入核对凭据无效；没有开始写入。");
  }
  return ticket;
}

export function readFitnessConfigWriteJournal(
  storage?: FitnessConfigWriteJournalStorage,
): FitnessConfigWriteJournal {
  const entries: FitnessConfigWriteEntry[] = [];
  const unreadable: UnreadableFitnessConfigWrite[] = [];
  if (!storage && (typeof navigator === "undefined" || !navigator.locks)) {
    return { entries, unreadable, unavailable: true };
  }
  try {
    const source = storage ?? window.localStorage;
    for (let index = 0; index < source.length; index += 1) {
      const storageKey = source.key(index);
      if (!storageKey?.startsWith(FITNESS_CONFIG_WRITE_PREFIX)) continue;
      let raw = "";
      try {
        raw = source.getItem(storageKey) ?? "";
        if (!raw || raw.length > FITNESS_CONFIG_WRITE_MAX_CHARS) {
          throw new Error("invalid ticket size");
        }
        const parsed: unknown = JSON.parse(raw);
        if (!isFitnessConfigWriteTicket(parsed)) throw new Error("invalid ticket");
        if (storageKey !== fitnessConfigWriteKey(parsed)) throw new Error("misbound ticket");
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

function browserStorage(): FitnessConfigWriteJournalStorage {
  if (typeof window === "undefined") {
    throw new Error("当前页面无法保存资料写入核对线索；没有开始写入。");
  }
  return window.localStorage;
}

async function withJournalLock<Result>(
  operation: () => Result | Promise<Result>,
  locks?: FitnessConfigWriteJournalLockManager,
): Promise<Result> {
  const manager = locks ?? (typeof navigator !== "undefined" ? navigator.locks : undefined);
  if (!manager) {
    throw new Error("当前浏览器无法跨页面锁定资料核对线索；没有继续改动。");
  }
  return manager.request(FITNESS_CONFIG_WRITE_JOURNAL_LOCK, operation);
}

export function persistFitnessConfigWriteToStorage(
  storage: FitnessConfigWriteJournalStorage,
  ticket: FitnessConfigWriteTicket,
): FitnessConfigWriteEntry {
  if (!isFitnessConfigWriteTicket(ticket)) {
    throw new Error("资料写入核对凭据无效；没有开始写入。");
  }
  const storageKey = fitnessConfigWriteKey(ticket);
  const raw = JSON.stringify(ticket);
  if (raw.length > FITNESS_CONFIG_WRITE_MAX_CHARS) {
    throw new Error("这次资料内容过大，浏览器无法安全保留核对线索；没有开始写入。");
  }
  const existing = storage.getItem(storageKey);
  if (existing !== null && existing !== raw) {
    throw new Error("另一页已保存同一动作的不同核对线索；没有开始写入。");
  }
  storage.setItem(storageKey, raw);
  if (storage.getItem(storageKey) !== raw) {
    throw new Error("浏览器没有保留资料核对线索；没有开始写入。");
  }
  return { storageKey, raw, ticket };
}

export async function persistFitnessConfigWrite(
  ticket: FitnessConfigWriteTicket,
): Promise<FitnessConfigWriteEntry> {
  return withJournalLock(() =>
    persistFitnessConfigWriteToStorage(browserStorage(), ticket));
}

export function removeFitnessConfigWriteFromStorage(
  storage: FitnessConfigWriteJournalStorage,
  entry: FitnessConfigWriteEntry | UnreadableFitnessConfigWrite,
): boolean {
  const current = storage.getItem(entry.storageKey);
  if (current === null) return true;
  if (current !== entry.raw) return false;
  storage.removeItem(entry.storageKey);
  return storage.getItem(entry.storageKey) !== entry.raw;
}

export async function removeFitnessConfigWrite(
  entry: FitnessConfigWriteEntry | UnreadableFitnessConfigWrite,
): Promise<boolean> {
  return withJournalLock(() =>
    removeFitnessConfigWriteFromStorage(browserStorage(), entry));
}

function committedTicket(ticket: FitnessConfigWriteTicket): FitnessConfigWriteTicket {
  return ticket.kind === "committed" ? ticket : { ...ticket, kind: "committed" };
}

function replaceFitnessConfigWriteInStorage(
  storage: FitnessConfigWriteJournalStorage,
  entry: FitnessConfigWriteEntry,
  ticket: FitnessConfigWriteTicket,
): FitnessConfigWriteEntry {
  if (fitnessConfigWriteKey(ticket) !== entry.storageKey) {
    throw new Error("资料核对线索与原动作不一致；没有覆盖现有提醒。");
  }
  if (storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error("另一页已经处理了这条资料核对线索。");
  }
  const raw = JSON.stringify(ticket);
  if (raw.length > FITNESS_CONFIG_WRITE_MAX_CHARS) {
    throw new Error("资料核对线索过大；没有覆盖现有提醒。");
  }
  storage.setItem(entry.storageKey, raw);
  if (storage.getItem(entry.storageKey) !== raw) {
    throw new Error("浏览器没有保留最新资料核对线索。");
  }
  return { storageKey: entry.storageKey, raw, ticket };
}

export async function runWithCurrentFitnessConfigWrite<Result>(
  entry: FitnessConfigWriteEntry,
  operation: (lease: FitnessConfigWriteLease) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: FitnessConfigWriteJournalStorage;
    locks?: FitnessConfigWriteJournalLockManager | null;
  }>,
): Promise<FitnessConfigWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options
    ? options.locks ?? undefined
    : typeof navigator !== "undefined"
      ? navigator.locks
      : undefined;
  if (!locks) {
    throw new Error("当前浏览器无法跨页面锁定资料核对线索；没有继续改动。");
  }
  return withJournalLock(async () => {
    const journal = readFitnessConfigWriteJournal(storage);
    if (journal.unavailable) {
      return { outcome: "blocked", reason: "unavailable" } as const;
    }
    if (journal.unreadable.length > 0) {
      return { outcome: "blocked", reason: "unreadable" } as const;
    }
    if (storage.getItem(entry.storageKey) !== entry.raw) {
      return { outcome: "stale" } as const;
    }
    let current: FitnessConfigWriteEntry | null = entry;
    const lease: FitnessConfigWriteLease = {
      committed() {
        if (!current) throw new Error("资料核对线索已经结束。");
        current = replaceFitnessConfigWriteInStorage(storage, current, committedTicket(current.ticket));
        return current;
      },
      remove() {
        if (!current || !removeFitnessConfigWriteFromStorage(storage, current)) {
          throw new Error("另一页已经处理了这条资料核对线索。");
        }
        current = null;
      },
    };
    const value = await operation(lease);
    return { outcome: "ran", value, entry: current } as const;
  }, locks);
}

export function claimFitnessConfigWrite(operationRef: OperationRef): FitnessConfigWriteToken | null {
  if (operationRef.current) return null;
  const token = Symbol("fitness-config-write");
  operationRef.current = token;
  return token;
}

export function releaseFitnessConfigWrite(
  operationRef: OperationRef,
  token: FitnessConfigWriteToken,
): boolean {
  if (operationRef.current !== token) return false;
  operationRef.current = null;
  return true;
}
