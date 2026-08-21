import {
  isFitnessCalendarWriteReceipt,
  isFitnessProgramWriteReceipt,
  type FitnessCalendarWriteReceipt,
  type FitnessProgramWriteReceipt,
} from "@/lib/fitness/store";

export type FitnessPlanCalendarWriteReceipt =
  | FitnessProgramWriteReceipt
  | FitnessCalendarWriteReceipt;

export const FITNESS_PLAN_CALENDAR_WRITE_PREFIX = "fitness.plan-calendar-write.v1:";
export const FITNESS_PLAN_CALENDAR_WRITE_MAX_CHARS = 1024 * 1024;
export const FITNESS_PLAN_CALENDAR_WRITE_JOURNAL_LOCK = "fitness-plan-calendar-write-journal";

export type FitnessPlanCalendarWriteTicket = Readonly<{
  version: 1;
  kind: "check" | "committed";
  receipt: FitnessPlanCalendarWriteReceipt;
  recordedAt: string;
}>;

export type FitnessPlanCalendarWriteEntry = Readonly<{
  storageKey: string;
  raw: string;
  ticket: FitnessPlanCalendarWriteTicket;
}>;

export type UnreadableFitnessPlanCalendarWrite = Readonly<{
  storageKey: string;
  raw: string;
}>;

export type FitnessPlanCalendarWriteJournal = Readonly<{
  entries: readonly FitnessPlanCalendarWriteEntry[];
  unreadable: readonly UnreadableFitnessPlanCalendarWrite[];
  unavailable: boolean;
}>;

export type FitnessPlanCalendarWriteStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;
export type FitnessPlanCalendarWriteLocks = Pick<LockManager, "request">;
export type FitnessPlanCalendarWriteLease = Readonly<{
  committed(): FitnessPlanCalendarWriteEntry;
  remove(): void;
}>;
export type FitnessPlanCalendarWriteRunResult<Result> =
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "blocked"; reason: "unavailable" | "unreadable" }>
  | Readonly<{
      outcome: "ran";
      value: Result;
      entry: FitnessPlanCalendarWriteEntry | null;
    }>;
export type FitnessPlanCalendarWriteToken = symbol;
type OperationRef = { current: FitnessPlanCalendarWriteToken | null };

function exactKeys(value: object, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

export function fitnessPlanCalendarWriteKey(ticket: FitnessPlanCalendarWriteTicket) {
  return `${FITNESS_PLAN_CALENDAR_WRITE_PREFIX}${ticket.receipt.operationId}`;
}

export function isFitnessPlanCalendarWriteTicket(
  value: unknown,
): value is FitnessPlanCalendarWriteTicket {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [
    "version", "kind", "receipt", "recordedAt",
  ])) return false;
  const ticket = value as Record<string, unknown>;
  return ticket.version === 1 &&
    (ticket.kind === "check" || ticket.kind === "committed") &&
    typeof ticket.recordedAt === "string" && ticket.recordedAt.length <= 64 &&
    Number.isFinite(Date.parse(ticket.recordedAt)) &&
    (isFitnessProgramWriteReceipt(ticket.receipt) ||
      isFitnessCalendarWriteReceipt(ticket.receipt));
}

export function createFitnessPlanCalendarWriteTicket(
  receipt: FitnessPlanCalendarWriteReceipt,
  recordedAt = new Date().toISOString(),
): FitnessPlanCalendarWriteTicket {
  const ticket = { version: 1, kind: "check", receipt, recordedAt } as const;
  if (!isFitnessPlanCalendarWriteTicket(ticket)) {
    throw new Error("计划或日历写入回执无效；没有开始写入。");
  }
  return ticket;
}

export function readFitnessPlanCalendarWriteJournal(
  storage?: FitnessPlanCalendarWriteStorage,
): FitnessPlanCalendarWriteJournal {
  const entries: FitnessPlanCalendarWriteEntry[] = [];
  const unreadable: UnreadableFitnessPlanCalendarWrite[] = [];
  if (!storage && (typeof navigator === "undefined" || !navigator.locks)) {
    return { entries, unreadable, unavailable: true };
  }
  try {
    const source = storage ?? window.localStorage;
    for (let index = 0; index < source.length; index += 1) {
      const storageKey = source.key(index);
      if (!storageKey?.startsWith(FITNESS_PLAN_CALENDAR_WRITE_PREFIX)) continue;
      let raw = "";
      try {
        raw = source.getItem(storageKey) ?? "";
        if (!raw || raw.length > FITNESS_PLAN_CALENDAR_WRITE_MAX_CHARS) {
          throw new Error("invalid ticket size");
        }
        const parsed: unknown = JSON.parse(raw);
        if (!isFitnessPlanCalendarWriteTicket(parsed) ||
          fitnessPlanCalendarWriteKey(parsed) !== storageKey) {
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
  entries.sort((left, right) =>
    left.ticket.recordedAt.localeCompare(right.ticket.recordedAt) ||
    left.storageKey.localeCompare(right.storageKey));
  return { entries, unreadable, unavailable: false };
}

function browserStorage(): FitnessPlanCalendarWriteStorage {
  if (typeof window === "undefined") {
    throw new Error("当前页面无法保存计划与日历核对线索；没有开始写入。");
  }
  return window.localStorage;
}

async function withJournalLock<Result>(
  operation: () => Result | Promise<Result>,
  locks?: FitnessPlanCalendarWriteLocks,
) {
  const manager = locks ?? (typeof navigator !== "undefined" ? navigator.locks : undefined);
  if (!manager) {
    throw new Error("当前浏览器无法跨页面锁定计划与日历核对线索；没有继续改动。");
  }
  return manager.request(FITNESS_PLAN_CALENDAR_WRITE_JOURNAL_LOCK, operation);
}

export function persistFitnessPlanCalendarWriteToStorage(
  storage: FitnessPlanCalendarWriteStorage,
  ticket: FitnessPlanCalendarWriteTicket,
): FitnessPlanCalendarWriteEntry {
  if (!isFitnessPlanCalendarWriteTicket(ticket)) {
    throw new Error("计划或日历写入回执无效；没有开始写入。");
  }
  const storageKey = fitnessPlanCalendarWriteKey(ticket);
  const raw = JSON.stringify(ticket);
  if (raw.length > FITNESS_PLAN_CALENDAR_WRITE_MAX_CHARS) {
    throw new Error("计划或日历回执过大；没有开始写入。");
  }
  const existing = storage.getItem(storageKey);
  if (existing !== null && existing !== raw) {
    throw new Error("另一页已有同一动作的不同回执；没有覆盖。");
  }
  storage.setItem(storageKey, raw);
  if (storage.getItem(storageKey) !== raw) {
    throw new Error("浏览器没有保留计划与日历核对线索；没有开始写入。");
  }
  return { storageKey, raw, ticket };
}

export async function persistFitnessPlanCalendarWrite(
  ticket: FitnessPlanCalendarWriteTicket,
  options?: Readonly<{
    storage?: FitnessPlanCalendarWriteStorage;
    locks?: FitnessPlanCalendarWriteLocks | null;
  }>,
) {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options
    ? options.locks ?? undefined
    : typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) {
    throw new Error("当前浏览器无法跨页面锁定计划与日历核对线索；没有开始写入。");
  }
  return withJournalLock(() => {
    const journal = readFitnessPlanCalendarWriteJournal(storage);
    if (journal.unavailable) {
      throw new Error("无法安全读取计划与日历核对线索；没有开始写入。");
    }
    if (journal.unreadable.length > 0) {
      throw new Error("先处理无法验证的计划或日历提醒；没有开始写入。");
    }
    if (journal.entries.length > 0) {
      throw new Error("先处理上一条计划或日历写入；没有开始新的写入。");
    }
    return persistFitnessPlanCalendarWriteToStorage(storage, ticket);
  }, locks);
}

export function removeFitnessPlanCalendarWriteFromStorage(
  storage: FitnessPlanCalendarWriteStorage,
  entry: FitnessPlanCalendarWriteEntry | UnreadableFitnessPlanCalendarWrite,
) {
  const current = storage.getItem(entry.storageKey);
  if (current === null) return true;
  if (current !== entry.raw) return false;
  storage.removeItem(entry.storageKey);
  return storage.getItem(entry.storageKey) !== entry.raw;
}

export async function removeFitnessPlanCalendarWrite(
  entry: FitnessPlanCalendarWriteEntry | UnreadableFitnessPlanCalendarWrite,
) {
  return withJournalLock(() =>
    removeFitnessPlanCalendarWriteFromStorage(browserStorage(), entry));
}

function replaceFitnessPlanCalendarWriteInStorage(
  storage: FitnessPlanCalendarWriteStorage,
  entry: FitnessPlanCalendarWriteEntry,
  ticket: FitnessPlanCalendarWriteTicket,
) {
  if (fitnessPlanCalendarWriteKey(ticket) !== entry.storageKey ||
      storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error("另一页已经处理了这条计划或日历核对线索。");
  }
  const raw = JSON.stringify(ticket);
  if (raw.length > FITNESS_PLAN_CALENDAR_WRITE_MAX_CHARS) {
    throw new Error("计划或日历核对线索过大；没有覆盖。");
  }
  storage.setItem(entry.storageKey, raw);
  if (storage.getItem(entry.storageKey) !== raw) {
    throw new Error("浏览器没有保留最新计划或日历核对线索。");
  }
  return { storageKey: entry.storageKey, raw, ticket };
}

export async function runWithCurrentFitnessPlanCalendarWrite<Result>(
  entry: FitnessPlanCalendarWriteEntry,
  operation: (lease: FitnessPlanCalendarWriteLease) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: FitnessPlanCalendarWriteStorage;
    locks?: FitnessPlanCalendarWriteLocks | null;
  }>,
): Promise<FitnessPlanCalendarWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options
    ? options.locks ?? undefined
    : typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) {
    throw new Error("当前浏览器无法跨页面锁定计划与日历核对线索；没有继续改动。");
  }
  return withJournalLock(async () => {
    const journal = readFitnessPlanCalendarWriteJournal(storage);
    if (journal.unavailable) return { outcome: "blocked", reason: "unavailable" } as const;
    if (journal.unreadable.length > 0) {
      return { outcome: "blocked", reason: "unreadable" } as const;
    }
    if (storage.getItem(entry.storageKey) !== entry.raw) {
      return { outcome: "stale" } as const;
    }
    let current: FitnessPlanCalendarWriteEntry | null = entry;
    const lease: FitnessPlanCalendarWriteLease = {
      committed() {
        if (!current) throw new Error("计划或日历核对线索已经结束。");
        current = replaceFitnessPlanCalendarWriteInStorage(storage, current, {
          ...current.ticket,
          kind: "committed",
        });
        return current;
      },
      remove() {
        if (!current || !removeFitnessPlanCalendarWriteFromStorage(storage, current)) {
          throw new Error("另一页已经处理了这条计划或日历核对线索。");
        }
        current = null;
      },
    };
    const value = await operation(lease);
    return { outcome: "ran", value, entry: current } as const;
  }, locks);
}

export function claimFitnessPlanCalendarWrite(
  operationRef: OperationRef,
): FitnessPlanCalendarWriteToken | null {
  if (operationRef.current) return null;
  const token = Symbol("fitness-plan-calendar-write");
  operationRef.current = token;
  return token;
}

export function releaseFitnessPlanCalendarWrite(
  operationRef: OperationRef,
  token: FitnessPlanCalendarWriteToken,
) {
  if (operationRef.current !== token) return false;
  operationRef.current = null;
  return true;
}
