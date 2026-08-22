import {
  isCareerLifecycleWriteReceipt,
  type CareerLifecycleWriteReceipt,
} from "@/lib/career/lifecycle-writes";
import {
  isCareerTaskWriteReceipt,
  type CareerTaskWriteReceipt,
} from "@/lib/career/task-writes";
import {
  CAREER_CORE_WRITE_JOURNAL_LOCK,
  CAREER_CORE_WRITE_MAX_CHARS,
  CAREER_CORE_WRITE_PREFIX,
  CAREER_LIFECYCLE_TASK_WRITE_MAX_BYTES,
  CAREER_LIFECYCLE_TASK_WRITE_PREFIX,
} from "./core-write-journal";

const CONTACT_IMPORT_MATERIAL_WRITE_PREFIX =
  "career.contact-import-material-write.v1:";
const CONTACT_IMPORT_MATERIAL_WRITE_MAX_BYTES = 8 * 1024 * 1024;

export type CareerLifecycleTaskWriteReceipt =
  | CareerLifecycleWriteReceipt
  | CareerTaskWriteReceipt;
export type CareerLifecycleTaskWriteTicket = Readonly<{
  version: 1;
  kind: "check" | "committed" | "changed";
  receipt: CareerLifecycleTaskWriteReceipt;
  recordedAt: string;
}>;
export type CareerLifecycleTaskWriteEntry = Readonly<{
  storageKey: string;
  raw: string;
  ticket: CareerLifecycleTaskWriteTicket;
}>;
export type UnreadableCareerLifecycleTaskWrite = Readonly<{
  storageKey: string;
  raw: string;
}>;
export type CareerLifecycleTaskWriteJournal = Readonly<{
  entries: readonly CareerLifecycleTaskWriteEntry[];
  peerEntries: readonly Readonly<{ storageKey: string; raw: string }>[];
  unreadable: readonly UnreadableCareerLifecycleTaskWrite[];
  storageUnavailable: boolean;
  lockUnavailable: boolean;
}>;
export type CareerLifecycleTaskWriteStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;
export type CareerLifecycleTaskWriteLocks = Pick<LockManager, "request">;
export type CareerLifecycleTaskWriteLease = Readonly<{
  committed(): CareerLifecycleTaskWriteEntry;
  changed(): CareerLifecycleTaskWriteEntry;
  remove(): void;
}>;
export type CareerLifecycleTaskWriteRunResult<Result> =
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "blocked"; reason: "storage" | "unreadable" | "peer" }>
  | Readonly<{
      outcome: "ran";
      value: Result;
      entry: CareerLifecycleTaskWriteEntry | null;
    }>;

const UTF8_ENCODER = new TextEncoder();

function byteLength(value: string) {
  return UTF8_ENCODER.encode(value).byteLength;
}

function exactKeys(value: object, wanted: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...wanted].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function browserStorage(): CareerLifecycleTaskWriteStorage {
  if (typeof window === "undefined") {
    throw new Error("当前页面无法读取职位/待办核对线索；没有开始写入。");
  }
  return window.localStorage;
}

function browserLocks(): CareerLifecycleTaskWriteLocks | null {
  if (typeof navigator === "undefined") return null;
  return navigator.locks ?? null;
}

async function withJournalLock<Result>(
  locks: CareerLifecycleTaskWriteLocks | null,
  operation: () => Result | Promise<Result>,
) {
  if (!locks) {
    throw new Error("当前浏览器无法跨页面锁定职位/待办核对线索；没有继续写入。");
  }
  return locks.request(CAREER_CORE_WRITE_JOURNAL_LOCK, operation);
}

export function isCareerLifecycleTaskWriteTicket(
  value: unknown,
): value is CareerLifecycleTaskWriteTicket {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value, ["version", "kind", "receipt", "recordedAt"])) return false;
  const ticket = value as Record<string, unknown>;
  return ticket.version === 1 &&
    (ticket.kind === "check" || ticket.kind === "committed" ||
      ticket.kind === "changed") &&
    typeof ticket.recordedAt === "string" && ticket.recordedAt.length === 24 &&
    Number.isFinite(Date.parse(ticket.recordedAt)) &&
    new Date(ticket.recordedAt).toISOString() === ticket.recordedAt &&
    (isCareerLifecycleWriteReceipt(ticket.receipt) ||
      isCareerTaskWriteReceipt(ticket.receipt));
}

export function careerLifecycleTaskWriteKey(
  ticket: CareerLifecycleTaskWriteTicket,
) {
  return `${CAREER_LIFECYCLE_TASK_WRITE_PREFIX}${ticket.receipt.operationId}`;
}

export function createCareerLifecycleTaskWriteTicket(
  receipt: CareerLifecycleTaskWriteReceipt,
  recordedAt = new Date().toISOString(),
): CareerLifecycleTaskWriteTicket {
  const ticket = { version: 1, kind: "check", receipt, recordedAt } as const;
  if (!isCareerLifecycleTaskWriteTicket(ticket)) {
    throw new Error("职位/待办写入核对凭据无效；没有开始写入。");
  }
  return ticket;
}

export function createCareerLifecycleTaskWriteEntry(
  ticket: CareerLifecycleTaskWriteTicket,
): CareerLifecycleTaskWriteEntry {
  if (!isCareerLifecycleTaskWriteTicket(ticket)) {
    throw new Error("职位/待办写入核对凭据无效；没有开始写入。");
  }
  const raw = JSON.stringify(ticket);
  if (byteLength(raw) > CAREER_LIFECYCLE_TASK_WRITE_MAX_BYTES) {
    throw new Error("这次职位/待办写入过大，无法安全保留核对线索；没有开始写入。");
  }
  return { storageKey: careerLifecycleTaskWriteKey(ticket), raw, ticket };
}

export function readCareerLifecycleTaskWriteJournal(
  storage: CareerLifecycleTaskWriteStorage = browserStorage(),
  locks: CareerLifecycleTaskWriteLocks | null = browserLocks(),
): CareerLifecycleTaskWriteJournal {
  const entries: CareerLifecycleTaskWriteEntry[] = [];
  const peerEntries: Array<{ storageKey: string; raw: string }> = [];
  const unreadable: UnreadableCareerLifecycleTaskWrite[] = [];
  try {
    const length = storage.length;
    const seen = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      const storageKey = storage.key(index);
      if (storageKey === null || seen.has(storageKey)) {
        throw new Error("unstable storage enumeration");
      }
      seen.add(storageKey);
      const own = storageKey.startsWith(CAREER_LIFECYCLE_TASK_WRITE_PREFIX);
      const corePeer = storageKey.startsWith(CAREER_CORE_WRITE_PREFIX);
      const contactImportMaterialPeer = storageKey.startsWith(
        CONTACT_IMPORT_MATERIAL_WRITE_PREFIX,
      );
      const peer = corePeer || contactImportMaterialPeer;
      if (!own && !peer) continue;
      let raw = "";
      try {
        raw = storage.getItem(storageKey) ?? "";
        if (peer) {
          const invalidSize = corePeer
            ? raw.length > CAREER_CORE_WRITE_MAX_CHARS
            : byteLength(raw) > CONTACT_IMPORT_MATERIAL_WRITE_MAX_BYTES;
          if (!raw || invalidSize) {
            throw new Error("invalid peer size");
          }
          peerEntries.push({ storageKey, raw });
          continue;
        }
        if (!raw || byteLength(raw) > CAREER_LIFECYCLE_TASK_WRITE_MAX_BYTES) {
          throw new Error("invalid ticket size");
        }
        const parsed: unknown = JSON.parse(raw);
        if (!isCareerLifecycleTaskWriteTicket(parsed) ||
          careerLifecycleTaskWriteKey(parsed) !== storageKey) {
          throw new Error("invalid or misbound ticket");
        }
        entries.push({ storageKey, raw, ticket: parsed });
      } catch {
        unreadable.push({ storageKey, raw });
      }
    }
    if (storage.length !== length) throw new Error("storage changed during full scan");
  } catch {
    return {
      entries: [], peerEntries: [], unreadable: [],
      storageUnavailable: true, lockUnavailable: !locks,
    };
  }
  entries.sort((a, b) => a.ticket.recordedAt.localeCompare(b.ticket.recordedAt) ||
    a.storageKey.localeCompare(b.storageKey));
  peerEntries.sort((a, b) => a.storageKey.localeCompare(b.storageKey));
  unreadable.sort((a, b) => a.storageKey.localeCompare(b.storageKey));
  return {
    entries, peerEntries, unreadable,
    storageUnavailable: false, lockUnavailable: !locks,
  };
}

function persistRaw(
  storage: CareerLifecycleTaskWriteStorage,
  ticket: CareerLifecycleTaskWriteTicket,
) {
  const entry = createCareerLifecycleTaskWriteEntry(ticket);
  const current = storage.getItem(entry.storageKey);
  if (current !== null && current !== entry.raw) {
    throw new Error("另一页保留了同一动作的不同核对线索；没有开始写入。");
  }
  storage.setItem(entry.storageKey, entry.raw);
  if (storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error("浏览器没有确认保留职位/待办核对线索；没有开始写入。");
  }
  return entry;
}

export async function persistCareerLifecycleTaskWrite(
  ticket: CareerLifecycleTaskWriteTicket,
  options?: Readonly<{
    storage?: CareerLifecycleTaskWriteStorage;
    locks?: CareerLifecycleTaskWriteLocks | null;
  }>,
) {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, () => {
    const journal = readCareerLifecycleTaskWriteJournal(storage, locks);
    if (journal.storageUnavailable) throw new Error("暂时无法读取全部核对线索；没有开始写入。");
    if (journal.unreadable.length > 0) throw new Error("先处理无法验证的职迹提醒；没有开始新的写入。");
    if (journal.entries.length > 0 || journal.peerEntries.length > 0) {
      throw new Error("先处理上一条职迹核对线索；没有开始新的写入。");
    }
    return persistRaw(storage, ticket);
  });
}

function replaceRaw(
  storage: CareerLifecycleTaskWriteStorage,
  entry: CareerLifecycleTaskWriteEntry,
  kind: CareerLifecycleTaskWriteTicket["kind"],
) {
  if (storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error("另一页已经处理了这条核对线索。");
  }
  const next = createCareerLifecycleTaskWriteEntry({ ...entry.ticket, kind });
  storage.setItem(next.storageKey, next.raw);
  if (storage.getItem(next.storageKey) !== next.raw) {
    throw new Error("浏览器没有确认保留最新核对线索。");
  }
  return next;
}

function removeRaw(
  storage: CareerLifecycleTaskWriteStorage,
  entry: Pick<CareerLifecycleTaskWriteEntry, "storageKey" | "raw">,
) {
  const current = storage.getItem(entry.storageKey);
  if (current === null) return true;
  if (current !== entry.raw) return false;
  storage.removeItem(entry.storageKey);
  return storage.getItem(entry.storageKey) !== entry.raw;
}

function leased(
  storage: CareerLifecycleTaskWriteStorage,
  initial: CareerLifecycleTaskWriteEntry,
) {
  let current: CareerLifecycleTaskWriteEntry | null = initial;
  return {
    lease: {
      committed() {
        if (!current) throw new Error("核对线索已经结束。");
        current = replaceRaw(storage, current, "committed");
        return current;
      },
      changed() {
        if (!current) throw new Error("核对线索已经结束。");
        current = replaceRaw(storage, current, "changed");
        return current;
      },
      remove() {
        if (!current || !removeRaw(storage, current)) {
          throw new Error("另一页已经处理了这条核对线索。");
        }
        current = null;
      },
    } satisfies CareerLifecycleTaskWriteLease,
    current: () => current,
  };
}

export async function runWithCurrentCareerLifecycleTaskWrite<Result>(
  entry: CareerLifecycleTaskWriteEntry,
  operation: (lease: CareerLifecycleTaskWriteLease) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: CareerLifecycleTaskWriteStorage;
    locks?: CareerLifecycleTaskWriteLocks | null;
  }>,
): Promise<CareerLifecycleTaskWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, async () => {
    const journal = readCareerLifecycleTaskWriteJournal(storage, locks);
    if (journal.storageUnavailable) return { outcome: "blocked", reason: "storage" } as const;
    if (journal.unreadable.length > 0) return { outcome: "blocked", reason: "unreadable" } as const;
    const exact = journal.entries.find((candidate) => candidate.storageKey === entry.storageKey);
    let rawNow: string | null;
    try { rawNow = storage.getItem(entry.storageKey); }
    catch { return { outcome: "blocked", reason: "storage" } as const; }
    if (!exact || exact.raw !== entry.raw || rawNow !== entry.raw) {
      return { outcome: "stale" } as const;
    }
    if (journal.entries.length !== 1 || journal.peerEntries.length > 0) {
      return { outcome: "blocked", reason: "peer" } as const;
    }
    const holder = leased(storage, exact);
    const value = await operation(holder.lease);
    return { outcome: "ran", value, entry: holder.current() } as const;
  });
}

export async function runWithMissingCareerLifecycleTaskWrite<Result>(
  held: CareerLifecycleTaskWriteEntry,
  operation: (lease: CareerLifecycleTaskWriteLease) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: CareerLifecycleTaskWriteStorage;
    locks?: CareerLifecycleTaskWriteLocks | null;
  }>,
): Promise<CareerLifecycleTaskWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, async () => {
    const journal = readCareerLifecycleTaskWriteJournal(storage, locks);
    if (journal.storageUnavailable) return { outcome: "blocked", reason: "storage" } as const;
    if (journal.unreadable.length > 0) return { outcome: "blocked", reason: "unreadable" } as const;
    let rawNow: string | null;
    try { rawNow = storage.getItem(held.storageKey); }
    catch { return { outcome: "blocked", reason: "storage" } as const; }
    if (journal.entries.length > 0 || journal.peerEntries.length > 0 || rawNow !== null) {
      return { outcome: "stale" } as const;
    }
    const checkpoint = persistRaw(storage, { ...held.ticket, kind: "check" });
    const holder = leased(storage, checkpoint);
    const value = await operation(holder.lease);
    return { outcome: "ran", value, entry: holder.current() } as const;
  });
}

export async function removeUnreadableCareerLifecycleTaskWrite(
  entry: UnreadableCareerLifecycleTaskWrite,
  options?: Readonly<{
    storage?: CareerLifecycleTaskWriteStorage;
    locks?: CareerLifecycleTaskWriteLocks | null;
  }>,
) {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, () => {
    const journal = readCareerLifecycleTaskWriteJournal(storage, locks);
    if (journal.storageUnavailable) return false;
    const exact = journal.unreadable.find((candidate) =>
      candidate.storageKey === entry.storageKey && candidate.raw === entry.raw);
    return exact ? removeRaw(storage, exact) : false;
  });
}

export function careerLifecycleTaskHeldBarrier(
  heldOperationIds: Iterable<string>,
  durableOperationIds: Iterable<string>,
) {
  const held = [...heldOperationIds];
  if (held.length === 0) return { blocksWrites: false, volatile: false } as const;
  const durable = new Set(durableOperationIds);
  return {
    blocksWrites: true,
    volatile: held.some((id) => !durable.has(id)),
  } as const;
}
