import {
  isCareerCoreWriteReceipt,
  type CareerCoreWriteReceipt,
} from "@/lib/career/core-writes";

export const CAREER_CORE_WRITE_PREFIX = "career.core-write.v1:";
export const CAREER_LIFECYCLE_TASK_WRITE_PREFIX =
  "career.lifecycle-task-write.v1:";
export const CAREER_CONTACT_IMPORT_MATERIAL_WRITE_PREFIX =
  "career.contact-import-material-write.v1:";
export const CAREER_CORE_WRITE_JOURNAL_LOCK =
  "private-ai-suite:career:core-write-journal";
export const CAREER_CORE_WRITE_MAX_CHARS = 1024 * 1024;
export const CAREER_LIFECYCLE_TASK_WRITE_MAX_BYTES = 8 * 1024 * 1024;
export const CAREER_CONTACT_IMPORT_MATERIAL_WRITE_MAX_BYTES = 8 * 1024 * 1024;

export type CareerCoreWriteTicket = Readonly<{
  version: 1;
  kind: "check" | "committed" | "changed";
  receipt: CareerCoreWriteReceipt;
  recordedAt: string;
}>;

export type CareerCoreWriteEntry = Readonly<{
  storageKey: string;
  raw: string;
  ticket: CareerCoreWriteTicket;
}>;

export type UnreadableCareerCoreWrite = Readonly<{
  storageKey: string;
  raw: string;
}>;

export type CareerCoreWritePeerEntry = Readonly<{
  storageKey: string;
  raw: string;
}>;

export type CareerCoreWriteJournal = Readonly<{
  entries: readonly CareerCoreWriteEntry[];
  peerEntries: readonly CareerCoreWritePeerEntry[];
  unreadable: readonly UnreadableCareerCoreWrite[];
  storageUnavailable: boolean;
  lockUnavailable: boolean;
}>;

export type CareerCoreWriteJournalStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;
export type CareerCoreWriteJournalLockManager = Pick<LockManager, "request">;
export type CareerCoreWriteToken = symbol;
type OperationRef = { current: CareerCoreWriteToken | null };

export type CareerCoreWriteLease = Readonly<{
  committed(): CareerCoreWriteEntry;
  changed(): CareerCoreWriteEntry;
  remove(): void;
}>;

export type CareerCoreWriteRunResult<Result> =
  | Readonly<{ outcome: "stale" }>
  | Readonly<{
      outcome: "blocked";
      reason: "storage" | "unreadable" | "peer";
    }>
  | Readonly<{
      outcome: "ran";
      value: Result;
      entry: CareerCoreWriteEntry | null;
    }>;

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function browserStorage(): CareerCoreWriteJournalStorage {
  if (typeof window === "undefined") {
    throw new Error("当前页面无法读取职迹写入核对线索；没有开始写入。");
  }
  return window.localStorage;
}

function browserLocks(): CareerCoreWriteJournalLockManager | null {
  if (typeof navigator === "undefined") return null;
  return navigator.locks ?? null;
}

async function withJournalLock<Result>(
  locks: CareerCoreWriteJournalLockManager | null,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  if (!locks) {
    throw new Error("当前浏览器无法跨页面锁定职迹核对线索；没有继续写入。");
  }
  return locks.request(CAREER_CORE_WRITE_JOURNAL_LOCK, operation);
}

export function careerCoreWriteKey(ticket: CareerCoreWriteTicket): string {
  return `${CAREER_CORE_WRITE_PREFIX}${ticket.receipt.operationId}`;
}

export function isCareerCoreWriteTicket(
  value: unknown,
): value is CareerCoreWriteTicket {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value, ["version", "kind", "receipt", "recordedAt"])
  ) return false;
  const ticket = value as Record<string, unknown>;
  const receipt = ticket.receipt as Partial<CareerCoreWriteReceipt> | null;
  return ticket.version === 1 &&
    (ticket.kind === "check" || ticket.kind === "committed" ||
      ticket.kind === "changed") &&
    typeof ticket.recordedAt === "string" &&
    ticket.recordedAt.length === 24 &&
    Number.isFinite(Date.parse(ticket.recordedAt)) &&
    new Date(ticket.recordedAt).toISOString() === ticket.recordedAt &&
    receipt?.purpose === "career-core-write" &&
    isCareerCoreWriteReceipt(ticket.receipt);
}

export function createCareerCoreWriteTicket(
  receipt: CareerCoreWriteReceipt,
  recordedAt = new Date().toISOString(),
): CareerCoreWriteTicket {
  const ticket = { version: 1, kind: "check", receipt, recordedAt } as const;
  if (!isCareerCoreWriteTicket(ticket)) {
    throw new Error("职迹写入核对凭据无效；没有开始写入。");
  }
  return ticket;
}

export function createCareerCoreWriteEntry(
  ticket: CareerCoreWriteTicket,
): CareerCoreWriteEntry {
  if (!isCareerCoreWriteTicket(ticket)) {
    throw new Error("职迹写入核对凭据无效；没有开始写入。");
  }
  const storageKey = careerCoreWriteKey(ticket);
  const raw = JSON.stringify(ticket);
  if (raw.length > CAREER_CORE_WRITE_MAX_CHARS) {
    throw new Error("这次职迹写入过大，无法安全保留核对线索；没有开始写入。");
  }
  return { storageKey, raw, ticket };
}

export function readCareerCoreWriteJournal(
  storage: CareerCoreWriteJournalStorage = browserStorage(),
  locks: CareerCoreWriteJournalLockManager | null = browserLocks(),
): CareerCoreWriteJournal {
  const entries: CareerCoreWriteEntry[] = [];
  const peerEntries: CareerCoreWritePeerEntry[] = [];
  const unreadable: UnreadableCareerCoreWrite[] = [];
  try {
    const length = storage.length;
    const seen = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      const storageKey = storage.key(index);
      if (storageKey === null || seen.has(storageKey)) {
        throw new Error("unstable storage enumeration");
      }
      seen.add(storageKey);
      const core = storageKey.startsWith(CAREER_CORE_WRITE_PREFIX);
      const lifecyclePeer = storageKey.startsWith(
        CAREER_LIFECYCLE_TASK_WRITE_PREFIX,
      );
      const contactImportMaterialPeer = storageKey.startsWith(
        CAREER_CONTACT_IMPORT_MATERIAL_WRITE_PREFIX,
      );
      const peer = lifecyclePeer || contactImportMaterialPeer;
      if (!core && !peer) continue;
      let raw = "";
      try {
        raw = storage.getItem(storageKey) ?? "";
        if (peer) {
          const maximumBytes = lifecyclePeer
            ? CAREER_LIFECYCLE_TASK_WRITE_MAX_BYTES
            : CAREER_CONTACT_IMPORT_MATERIAL_WRITE_MAX_BYTES;
          if (!raw || new TextEncoder().encode(raw).byteLength > maximumBytes) {
            throw new Error("invalid peer ticket size");
          }
          peerEntries.push({ storageKey, raw });
          continue;
        }
        if (!raw || raw.length > CAREER_CORE_WRITE_MAX_CHARS) {
          throw new Error("invalid ticket size");
        }
        const parsed: unknown = JSON.parse(raw);
        if (!isCareerCoreWriteTicket(parsed) ||
          careerCoreWriteKey(parsed) !== storageKey) {
          throw new Error("invalid or misbound ticket");
        }
        entries.push({ storageKey, raw, ticket: parsed });
      } catch {
        unreadable.push({ storageKey, raw });
      }
    }
    if (storage.length !== length) {
      throw new Error("storage changed during full scan");
    }
  } catch {
    return {
      entries: [],
      peerEntries: [],
      unreadable: [],
      storageUnavailable: true,
      lockUnavailable: !locks,
    };
  }
  entries.sort((left, right) =>
    left.ticket.recordedAt.localeCompare(right.ticket.recordedAt) ||
    left.storageKey.localeCompare(right.storageKey));
  unreadable.sort((left, right) =>
    left.storageKey.localeCompare(right.storageKey));
  peerEntries.sort((left, right) => left.storageKey.localeCompare(right.storageKey));
  return {
    entries,
    peerEntries,
    unreadable,
    storageUnavailable: false,
    lockUnavailable: !locks,
  };
}

export function selectCareerCoreWriteRecoveryEntry(
  heldEntries: readonly CareerCoreWriteEntry[],
  journalEntries: readonly CareerCoreWriteEntry[],
): CareerCoreWriteEntry | null {
  for (const held of heldEntries) {
    const peer = journalEntries.find((entry) =>
      entry.storageKey !== held.storageKey);
    if (peer) return peer;
    const exact = journalEntries.find((entry) =>
      entry.storageKey === held.storageKey);
    if (exact) return exact;
  }
  return journalEntries[0] ?? heldEntries[0] ?? null;
}

export function careerCoreHeldReceiptBarrier(
  heldOperationIds: Iterable<string>,
  durableOperationIds: Iterable<string>,
): Readonly<{ blocksWrites: boolean; volatile: boolean }> {
  const held = [...heldOperationIds];
  if (held.length === 0) return { blocksWrites: false, volatile: false };
  const durable = new Set(durableOperationIds);
  return {
    blocksWrites: true,
    volatile: held.some((operationId) => !durable.has(operationId)),
  };
}

function persistToStorage(
  storage: CareerCoreWriteJournalStorage,
  ticket: CareerCoreWriteTicket,
): CareerCoreWriteEntry {
  const entry = createCareerCoreWriteEntry(ticket);
  const existing = storage.getItem(entry.storageKey);
  if (existing !== null && existing !== entry.raw) {
    throw new Error("另一页保留了同一动作的不同职迹线索；没有开始写入。");
  }
  storage.setItem(entry.storageKey, entry.raw);
  if (storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error("浏览器没有确认保留职迹核对线索；没有开始写入。");
  }
  return entry;
}

export async function persistCareerCoreWrite(
  ticket: CareerCoreWriteTicket,
  options?: Readonly<{
    storage?: CareerCoreWriteJournalStorage;
    locks?: CareerCoreWriteJournalLockManager | null;
  }>,
): Promise<CareerCoreWriteEntry> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, () => {
    const journal = readCareerCoreWriteJournal(storage, locks);
    if (journal.storageUnavailable) {
      throw new Error("暂时无法读取全部职迹核对线索；没有开始写入。");
    }
    if (journal.unreadable.length > 0) {
      throw new Error("先处理无法验证的职迹提醒；没有开始新的写入。");
    }
    if (journal.entries.length > 0 || journal.peerEntries.length > 0) {
      throw new Error("先处理上一条职迹核对线索；没有开始新的写入。");
    }
    return persistToStorage(storage, ticket);
  });
}

function replaceInStorage(
  storage: CareerCoreWriteJournalStorage,
  entry: CareerCoreWriteEntry,
  kind: CareerCoreWriteTicket["kind"],
): CareerCoreWriteEntry {
  if (storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error("另一页已经处理了这条职迹核对线索。");
  }
  const ticket = { ...entry.ticket, kind };
  const raw = JSON.stringify(ticket);
  if (raw.length > CAREER_CORE_WRITE_MAX_CHARS) {
    throw new Error("最新职迹核对线索过大；没有覆盖原提醒。");
  }
  storage.setItem(entry.storageKey, raw);
  if (storage.getItem(entry.storageKey) !== raw) {
    throw new Error("浏览器没有确认保留最新职迹核对线索。");
  }
  return { storageKey: entry.storageKey, raw, ticket };
}

function removeFromStorage(
  storage: CareerCoreWriteJournalStorage,
  entry: Pick<CareerCoreWriteEntry, "storageKey" | "raw">,
): boolean {
  const current = storage.getItem(entry.storageKey);
  if (current === null) return true;
  if (current !== entry.raw) return false;
  storage.removeItem(entry.storageKey);
  return storage.getItem(entry.storageKey) !== entry.raw;
}

function currentRaw(
  storage: CareerCoreWriteJournalStorage,
  storageKey: string,
): Readonly<{ available: true; raw: string | null }> |
  Readonly<{ available: false }> {
  try {
    return { available: true, raw: storage.getItem(storageKey) };
  } catch {
    return { available: false };
  }
}

function leaseFor(
  storage: CareerCoreWriteJournalStorage,
  initial: CareerCoreWriteEntry,
): Readonly<{
  lease: CareerCoreWriteLease;
  current: () => CareerCoreWriteEntry | null;
}> {
  let current: CareerCoreWriteEntry | null = initial;
  return {
    lease: {
      committed() {
        if (!current) throw new Error("职迹核对线索已经结束。");
        current = replaceInStorage(storage, current, "committed");
        return current;
      },
      changed() {
        if (!current) throw new Error("职迹核对线索已经结束。");
        current = replaceInStorage(storage, current, "changed");
        return current;
      },
      remove() {
        if (!current || !removeFromStorage(storage, current)) {
          throw new Error("另一页已经处理了这条职迹核对线索。");
        }
        current = null;
      },
    },
    current: () => current,
  };
}

export async function runWithCurrentCareerCoreWrite<Result>(
  entry: CareerCoreWriteEntry,
  operation: (lease: CareerCoreWriteLease) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: CareerCoreWriteJournalStorage;
    locks?: CareerCoreWriteJournalLockManager | null;
  }>,
): Promise<CareerCoreWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, async () => {
    const journal = readCareerCoreWriteJournal(storage, locks);
    if (journal.storageUnavailable) return { outcome: "blocked", reason: "storage" } as const;
    if (journal.unreadable.length > 0) return { outcome: "blocked", reason: "unreadable" } as const;
    const entryNow = journal.entries.find((candidate) =>
      candidate.storageKey === entry.storageKey);
    const rawNow = currentRaw(storage, entry.storageKey);
    if (!rawNow.available) return { outcome: "blocked", reason: "storage" } as const;
    if (!entryNow || entryNow.raw !== entry.raw || rawNow.raw !== entry.raw) {
      return { outcome: "stale" } as const;
    }
    if (journal.entries.length !== 1 || journal.peerEntries.length > 0) {
      return { outcome: "blocked", reason: "peer" } as const;
    }
    const leased = leaseFor(storage, entryNow);
    const value = await operation(leased.lease);
    return { outcome: "ran", value, entry: leased.current() } as const;
  });
}

export async function runWithMissingCareerCoreWrite<Result>(
  heldEntry: CareerCoreWriteEntry,
  operation: (lease: CareerCoreWriteLease) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: CareerCoreWriteJournalStorage;
    locks?: CareerCoreWriteJournalLockManager | null;
  }>,
): Promise<CareerCoreWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, async () => {
    const journal = readCareerCoreWriteJournal(storage, locks);
    if (journal.storageUnavailable) return { outcome: "blocked", reason: "storage" } as const;
    if (journal.unreadable.length > 0) return { outcome: "blocked", reason: "unreadable" } as const;
    const rawNow = currentRaw(storage, heldEntry.storageKey);
    if (!rawNow.available) return { outcome: "blocked", reason: "storage" } as const;
    if (journal.entries.length > 0 || journal.peerEntries.length > 0 ||
      rawNow.raw !== null) {
      return { outcome: "stale" } as const;
    }
    const checkpoint = persistToStorage(storage, {
      ...heldEntry.ticket,
      kind: "check",
    });
    const leased = leaseFor(storage, checkpoint);
    const value = await operation(leased.lease);
    return { outcome: "ran", value, entry: leased.current() } as const;
  });
}

export async function removeUnreadableCareerCoreWrite(
  entry: UnreadableCareerCoreWrite,
  options?: Readonly<{
    storage?: CareerCoreWriteJournalStorage;
    locks?: CareerCoreWriteJournalLockManager | null;
  }>,
): Promise<boolean> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, () => {
    const journal = readCareerCoreWriteJournal(storage, locks);
    if (journal.storageUnavailable) return false;
    const current = journal.unreadable.find((candidate) =>
      candidate.storageKey === entry.storageKey && candidate.raw === entry.raw);
    return current ? removeFromStorage(storage, current) : false;
  });
}

export function claimCareerCoreWrite(
  operationRef: OperationRef,
): CareerCoreWriteToken | null {
  if (operationRef.current) return null;
  const token = Symbol("career-core-write");
  operationRef.current = token;
  return token;
}

export function releaseCareerCoreWrite(
  operationRef: OperationRef,
  token: CareerCoreWriteToken,
): boolean {
  if (operationRef.current !== token) return false;
  operationRef.current = null;
  return true;
}
