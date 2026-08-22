import {
  isVocabEngagementWriteReceipt,
  type VocabEngagementWriteReceipt,
} from "@/lib/vocab/store";

export const VOCAB_ENGAGEMENT_WRITE_PREFIX = "vocab.engagement-write.v1:";
export const VOCAB_ENGAGEMENT_WRITE_JOURNAL_LOCK =
  "private-ai-suite:vocab:engagement-write-journal";
export const VOCAB_ENGAGEMENT_WRITE_MAX_CHARS = 1024 * 1024;

export type VocabEngagementWriteTicket = Readonly<{
  version: 1;
  kind: "check" | "committed" | "changed";
  receipt: VocabEngagementWriteReceipt;
  recordedAt: string;
}>;

export type VocabEngagementWriteEntry = Readonly<{
  storageKey: string;
  raw: string;
  ticket: VocabEngagementWriteTicket;
}>;

export type UnreadableVocabEngagementWrite = Readonly<{
  storageKey: string;
  raw: string;
}>;

export type VocabEngagementWriteJournal = Readonly<{
  entries: readonly VocabEngagementWriteEntry[];
  unreadable: readonly UnreadableVocabEngagementWrite[];
  storageUnavailable: boolean;
  lockUnavailable: boolean;
}>;

export type VocabEngagementWriteJournalStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;

export type VocabEngagementWriteJournalLockManager = Pick<LockManager, "request">;

export type VocabEngagementWriteLease = Readonly<{
  committed(): VocabEngagementWriteEntry;
  changed(): VocabEngagementWriteEntry;
  remove(): void;
}>;

export type VocabEngagementWriteRunResult<Result> =
  | Readonly<{ outcome: "stale" }>
  | Readonly<{
      outcome: "blocked";
      reason: "storage" | "unreadable" | "peer";
    }>
  | Readonly<{
      outcome: "ran";
      value: Result;
      entry: VocabEngagementWriteEntry | null;
    }>;

export type VocabEngagementWriteToken = symbol;
type OperationRef = { current: VocabEngagementWriteToken | null };

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function browserStorage(): VocabEngagementWriteJournalStorage {
  if (typeof window === "undefined") {
    throw new Error("当前页面无法读取学习记录核对线索；没有开始写入。");
  }
  return window.localStorage;
}

function browserLocks(): VocabEngagementWriteJournalLockManager | null {
  if (typeof navigator === "undefined") return null;
  return navigator.locks ?? null;
}

async function withJournalLock<Result>(
  locks: VocabEngagementWriteJournalLockManager | null,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  if (!locks) {
    throw new Error(
      "当前浏览器无法跨页面锁定学习记录核对线索；没有继续写入。",
    );
  }
  return locks.request(VOCAB_ENGAGEMENT_WRITE_JOURNAL_LOCK, operation);
}

export function vocabEngagementWriteKey(
  ticket: VocabEngagementWriteTicket,
): string {
  return `${VOCAB_ENGAGEMENT_WRITE_PREFIX}${ticket.receipt.operationId}`;
}

export function isVocabEngagementWriteTicket(
  value: unknown,
): value is VocabEngagementWriteTicket {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value, ["version", "kind", "receipt", "recordedAt"])
  ) return false;
  const ticket = value as Record<string, unknown>;
  const receipt = ticket.receipt as Partial<VocabEngagementWriteReceipt> | null;
  return ticket.version === 1 &&
    (ticket.kind === "check" || ticket.kind === "committed" ||
      ticket.kind === "changed") &&
    typeof ticket.recordedAt === "string" &&
    ticket.recordedAt.length === 24 &&
    Number.isFinite(Date.parse(ticket.recordedAt)) &&
    new Date(ticket.recordedAt).toISOString() === ticket.recordedAt &&
    receipt?.purpose === "vocab-engagement-write" &&
    isVocabEngagementWriteReceipt(ticket.receipt);
}

export function createVocabEngagementWriteTicket(
  receipt: VocabEngagementWriteReceipt,
  recordedAt = new Date().toISOString(),
): VocabEngagementWriteTicket {
  const ticket = { version: 1, kind: "check", receipt, recordedAt } as const;
  if (!isVocabEngagementWriteTicket(ticket)) {
    throw new Error("学习记录核对凭据无效；没有开始写入。");
  }
  return ticket;
}

export function createVocabEngagementWriteEntry(
  ticket: VocabEngagementWriteTicket,
): VocabEngagementWriteEntry {
  if (!isVocabEngagementWriteTicket(ticket)) {
    throw new Error("学习记录核对凭据无效；没有开始写入。");
  }
  const storageKey = vocabEngagementWriteKey(ticket);
  const raw = JSON.stringify(ticket);
  if (raw.length > VOCAB_ENGAGEMENT_WRITE_MAX_CHARS) {
    throw new Error(
      "这次学习记录过大，无法安全保留核对线索；没有开始写入。",
    );
  }
  return { storageKey, raw, ticket };
}

export function readVocabEngagementWriteJournal(
  storage: VocabEngagementWriteJournalStorage = browserStorage(),
  locks: VocabEngagementWriteJournalLockManager | null = browserLocks(),
): VocabEngagementWriteJournal {
  const entries: VocabEngagementWriteEntry[] = [];
  const unreadable: UnreadableVocabEngagementWrite[] = [];
  try {
    const length = storage.length;
    const seenKeys = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      const storageKey = storage.key(index);
      if (storageKey === null || seenKeys.has(storageKey)) {
        throw new Error("unstable storage enumeration");
      }
      seenKeys.add(storageKey);
      if (!storageKey?.startsWith(VOCAB_ENGAGEMENT_WRITE_PREFIX)) continue;
      let raw = "";
      try {
        raw = storage.getItem(storageKey) ?? "";
        if (!raw || raw.length > VOCAB_ENGAGEMENT_WRITE_MAX_CHARS) {
          throw new Error("invalid ticket size");
        }
        const parsed: unknown = JSON.parse(raw);
        if (!isVocabEngagementWriteTicket(parsed)) {
          throw new Error("invalid ticket");
        }
        if (storageKey !== vocabEngagementWriteKey(parsed)) {
          throw new Error("misbound ticket");
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
      unreadable: [],
      storageUnavailable: true,
      lockUnavailable: !locks,
    };
  }
  entries.sort((left, right) =>
    left.ticket.recordedAt.localeCompare(right.ticket.recordedAt) ||
    left.storageKey.localeCompare(right.storageKey)
  );
  unreadable.sort((left, right) =>
    left.storageKey.localeCompare(right.storageKey)
  );
  return {
    entries,
    unreadable,
    storageUnavailable: false,
    lockUnavailable: !locks,
  };
}

export function selectVocabEngagementWriteRecoveryEntry(
  heldEntries: readonly VocabEngagementWriteEntry[],
  journalEntries: readonly VocabEngagementWriteEntry[],
): VocabEngagementWriteEntry | null {
  for (const held of heldEntries) {
    const peer = journalEntries.find((entry) =>
      entry.storageKey !== held.storageKey
    );
    if (peer) return peer;
    const exact = journalEntries.find((entry) =>
      entry.storageKey === held.storageKey
    );
    if (exact) return exact;
  }
  return journalEntries[0] ?? heldEntries[0] ?? null;
}

export function vocabEngagementHeldReceiptBarrier(
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
  storage: VocabEngagementWriteJournalStorage,
  ticket: VocabEngagementWriteTicket,
): VocabEngagementWriteEntry {
  const entry = createVocabEngagementWriteEntry(ticket);
  const existing = storage.getItem(entry.storageKey);
  if (existing !== null && existing !== entry.raw) {
    throw new Error(
      "另一页保留了同一动作的不同学习记录线索；没有开始写入。",
    );
  }
  storage.setItem(entry.storageKey, entry.raw);
  if (storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error(
      "浏览器没有确认保留学习记录核对线索；没有开始写入。",
    );
  }
  return entry;
}

export async function persistVocabEngagementWrite(
  ticket: VocabEngagementWriteTicket,
  options?: Readonly<{
    storage?: VocabEngagementWriteJournalStorage;
    locks?: VocabEngagementWriteJournalLockManager | null;
  }>,
): Promise<VocabEngagementWriteEntry> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options
    ? options.locks ?? null
    : browserLocks();
  return withJournalLock(locks, () => {
    const journal = readVocabEngagementWriteJournal(storage, locks);
    if (journal.storageUnavailable) {
      throw new Error(
        "暂时无法读取全部学习记录核对线索；没有开始写入。",
      );
    }
    if (journal.unreadable.length > 0) {
      throw new Error(
        "先处理无法验证的学习记录提醒；没有开始新的写入。",
      );
    }
    if (journal.entries.length > 0) {
      throw new Error(
        "先处理上一条学习记录核对线索；没有开始新的写入。",
      );
    }
    return persistToStorage(storage, ticket);
  });
}

function replaceInStorage(
  storage: VocabEngagementWriteJournalStorage,
  entry: VocabEngagementWriteEntry,
  kind: VocabEngagementWriteTicket["kind"],
): VocabEngagementWriteEntry {
  if (storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error("另一页已经处理了这条学习记录核对线索。");
  }
  const ticket = { ...entry.ticket, kind };
  const raw = JSON.stringify(ticket);
  if (raw.length > VOCAB_ENGAGEMENT_WRITE_MAX_CHARS) {
    throw new Error("最新学习记录核对线索过大；没有覆盖原提醒。");
  }
  storage.setItem(entry.storageKey, raw);
  if (storage.getItem(entry.storageKey) !== raw) {
    throw new Error("浏览器没有确认保留最新学习记录核对线索。");
  }
  return { storageKey: entry.storageKey, raw, ticket };
}

function removeFromStorage(
  storage: VocabEngagementWriteJournalStorage,
  entry: Pick<VocabEngagementWriteEntry, "storageKey" | "raw">,
): boolean {
  const current = storage.getItem(entry.storageKey);
  if (current === null) return true;
  if (current !== entry.raw) return false;
  storage.removeItem(entry.storageKey);
  return storage.getItem(entry.storageKey) !== entry.raw;
}

function readCurrentRaw(
  storage: VocabEngagementWriteJournalStorage,
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
  storage: VocabEngagementWriteJournalStorage,
  initial: VocabEngagementWriteEntry,
): Readonly<{
  lease: VocabEngagementWriteLease;
  current: () => VocabEngagementWriteEntry | null;
}> {
  let current: VocabEngagementWriteEntry | null = initial;
  return {
    lease: {
      committed() {
        if (!current) throw new Error("学习记录核对线索已经结束。");
        current = replaceInStorage(storage, current, "committed");
        return current;
      },
      changed() {
        if (!current) throw new Error("学习记录核对线索已经结束。");
        current = replaceInStorage(storage, current, "changed");
        return current;
      },
      remove() {
        if (!current || !removeFromStorage(storage, current)) {
          throw new Error("另一页已经处理了这条学习记录核对线索。");
        }
        current = null;
      },
    },
    current: () => current,
  };
}

export async function runWithCurrentVocabEngagementWrite<Result>(
  entry: VocabEngagementWriteEntry,
  operation: (lease: VocabEngagementWriteLease) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: VocabEngagementWriteJournalStorage;
    locks?: VocabEngagementWriteJournalLockManager | null;
  }>,
): Promise<VocabEngagementWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options
    ? options.locks ?? null
    : browserLocks();
  return withJournalLock(locks, async () => {
    const journal = readVocabEngagementWriteJournal(storage, locks);
    if (journal.storageUnavailable) {
      return { outcome: "blocked", reason: "storage" } as const;
    }
    if (journal.unreadable.length > 0) {
      return { outcome: "blocked", reason: "unreadable" } as const;
    }
    const currentEntry = journal.entries.find((candidate) =>
      candidate.storageKey === entry.storageKey
    );
    const currentRaw = readCurrentRaw(storage, entry.storageKey);
    if (!currentRaw.available) {
      return { outcome: "blocked", reason: "storage" } as const;
    }
    if (
      !currentEntry || currentEntry.raw !== entry.raw ||
      currentRaw.raw !== entry.raw
    ) return { outcome: "stale" } as const;
    if (journal.entries.length !== 1) {
      return { outcome: "blocked", reason: "peer" } as const;
    }
    const leased = leaseFor(storage, currentEntry);
    const value = await operation(leased.lease);
    return { outcome: "ran", value, entry: leased.current() } as const;
  });
}

export const runWithExclusiveCurrentVocabEngagementWrite =
  runWithCurrentVocabEngagementWrite;

export async function runWithMissingVocabEngagementWrite<Result>(
  heldEntry: VocabEngagementWriteEntry,
  operation: (lease: VocabEngagementWriteLease) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: VocabEngagementWriteJournalStorage;
    locks?: VocabEngagementWriteJournalLockManager | null;
  }>,
): Promise<VocabEngagementWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options
    ? options.locks ?? null
    : browserLocks();
  return withJournalLock(locks, async () => {
    const journal = readVocabEngagementWriteJournal(storage, locks);
    if (journal.storageUnavailable) {
      return { outcome: "blocked", reason: "storage" } as const;
    }
    if (journal.unreadable.length > 0) {
      return { outcome: "blocked", reason: "unreadable" } as const;
    }
    const currentRaw = readCurrentRaw(storage, heldEntry.storageKey);
    if (!currentRaw.available) {
      return { outcome: "blocked", reason: "storage" } as const;
    }
    if (journal.entries.length > 0 || currentRaw.raw !== null) {
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

export async function removeUnreadableVocabEngagementWrite(
  entry: UnreadableVocabEngagementWrite,
  options?: Readonly<{
    storage?: VocabEngagementWriteJournalStorage;
    locks?: VocabEngagementWriteJournalLockManager | null;
  }>,
): Promise<boolean> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options
    ? options.locks ?? null
    : browserLocks();
  return withJournalLock(locks, () => {
    const journal = readVocabEngagementWriteJournal(storage, locks);
    if (journal.storageUnavailable) return false;
    const current = journal.unreadable.find((candidate) =>
      candidate.storageKey === entry.storageKey && candidate.raw === entry.raw
    );
    return current ? removeFromStorage(storage, current) : false;
  });
}

export function claimVocabEngagementWrite(
  operationRef: OperationRef,
): VocabEngagementWriteToken | null {
  if (operationRef.current) return null;
  const token = Symbol("vocab-engagement-write");
  operationRef.current = token;
  return token;
}

export function releaseVocabEngagementWrite(
  operationRef: OperationRef,
  token: VocabEngagementWriteToken,
): boolean {
  if (operationRef.current !== token) return false;
  operationRef.current = null;
  return true;
}
