import {
  isVocabItemWriteReceipt,
  type VocabItemWriteReceipt,
} from "@/lib/vocab/store";

export const VOCAB_ITEM_WRITE_PREFIX = "vocab.item-write.v1:";
export const VOCAB_ITEM_WRITE_JOURNAL_LOCK =
  "private-ai-suite:vocab:item-write-journal";
export const VOCAB_ITEM_WRITE_MAX_CHARS = 1024 * 1024;

export type VocabItemWriteTicket = Readonly<{
  version: 1;
  kind: "check" | "committed" | "changed";
  receipt: VocabItemWriteReceipt;
  recordedAt: string;
}>;

export type VocabItemWriteEntry = Readonly<{
  storageKey: string;
  raw: string;
  ticket: VocabItemWriteTicket;
}>;

export type UnreadableVocabItemWrite = Readonly<{
  storageKey: string;
  raw: string;
}>;

export type VocabItemWriteJournal = Readonly<{
  entries: readonly VocabItemWriteEntry[];
  unreadable: readonly UnreadableVocabItemWrite[];
  storageUnavailable: boolean;
  lockUnavailable: boolean;
}>;

export function selectVocabItemWriteRecoveryEntry(
  heldEntries: readonly VocabItemWriteEntry[],
  journalEntries: readonly VocabItemWriteEntry[],
): VocabItemWriteEntry | null {
  for (const held of heldEntries) {
    const exact = journalEntries.find((entry) =>
      entry.storageKey === held.storageKey
    );
    if (exact) return exact;
    const itemId = held.ticket.receipt.before.item.id;
    const sameItem = journalEntries.find((entry) =>
      entry.ticket.receipt.before.item.id === itemId
    );
    if (sameItem) return sameItem;
    return held;
  }
  return journalEntries[0] ?? null;
}

export type VocabItemWriteJournalStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;

export type VocabItemWriteJournalLockManager = Pick<LockManager, "request">;

export type VocabItemWriteLease = Readonly<{
  committed(): VocabItemWriteEntry;
  changed(): VocabItemWriteEntry;
  remove(): void;
}>;

export type VocabItemWriteRunResult<Result> =
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "blocked"; reason: "storage" | "unreadable" }>
  | Readonly<{
      outcome: "ran";
      value: Result;
      entry: VocabItemWriteEntry | null;
    }>;

export type VocabItemWriteToken = symbol;
type OperationRef = { current: VocabItemWriteToken | null };

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function browserStorage(): VocabItemWriteJournalStorage {
  if (typeof window === "undefined") {
    throw new Error("当前页面无法读取条目核对线索；没有开始写入。");
  }
  return window.localStorage;
}

function browserLocks(): VocabItemWriteJournalLockManager | null {
  if (typeof navigator === "undefined") return null;
  return navigator.locks ?? null;
}

async function withJournalLock<Result>(
  locks: VocabItemWriteJournalLockManager | null,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  if (!locks) {
    throw new Error("当前浏览器无法跨页面锁定条目核对线索；没有继续写入。");
  }
  return locks.request(VOCAB_ITEM_WRITE_JOURNAL_LOCK, operation);
}

export function vocabItemWriteKey(ticket: VocabItemWriteTicket): string {
  return `${VOCAB_ITEM_WRITE_PREFIX}${ticket.receipt.operationId}`;
}

export function isVocabItemWriteTicket(
  value: unknown,
): value is VocabItemWriteTicket {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value, ["version", "kind", "receipt", "recordedAt"])
  ) return false;
  const ticket = value as Record<string, unknown>;
  return ticket.version === 1 &&
    (ticket.kind === "check" || ticket.kind === "committed" ||
      ticket.kind === "changed") &&
    typeof ticket.recordedAt === "string" &&
    ticket.recordedAt.length === 24 &&
    Number.isFinite(Date.parse(ticket.recordedAt)) &&
    new Date(ticket.recordedAt).toISOString() === ticket.recordedAt &&
    isVocabItemWriteReceipt(ticket.receipt);
}

export function createVocabItemWriteTicket(
  receipt: VocabItemWriteReceipt,
  recordedAt = new Date().toISOString(),
): VocabItemWriteTicket {
  const ticket = { version: 1, kind: "check", receipt, recordedAt } as const;
  if (!isVocabItemWriteTicket(ticket)) {
    throw new Error("条目核对凭据无效；没有开始写入。");
  }
  return ticket;
}

export function createVocabItemWriteEntry(
  ticket: VocabItemWriteTicket,
): VocabItemWriteEntry {
  if (!isVocabItemWriteTicket(ticket)) {
    throw new Error("条目核对凭据无效；没有开始写入。");
  }
  const storageKey = vocabItemWriteKey(ticket);
  const raw = JSON.stringify(ticket);
  if (raw.length > VOCAB_ITEM_WRITE_MAX_CHARS) {
    throw new Error("这次条目内容过大，无法安全保留核对线索；没有开始写入。");
  }
  return { storageKey, raw, ticket };
}

export function readVocabItemWriteJournal(
  storage: VocabItemWriteJournalStorage = browserStorage(),
  locks: VocabItemWriteJournalLockManager | null = browserLocks(),
): VocabItemWriteJournal {
  const entries: VocabItemWriteEntry[] = [];
  const unreadable: UnreadableVocabItemWrite[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const storageKey = storage.key(index);
      if (!storageKey?.startsWith(VOCAB_ITEM_WRITE_PREFIX)) continue;
      let raw = "";
      try {
        raw = storage.getItem(storageKey) ?? "";
        if (!raw || raw.length > VOCAB_ITEM_WRITE_MAX_CHARS) {
          throw new Error("invalid ticket size");
        }
        const parsed: unknown = JSON.parse(raw);
        if (!isVocabItemWriteTicket(parsed)) throw new Error("invalid ticket");
        if (storageKey !== vocabItemWriteKey(parsed)) {
          throw new Error("misbound ticket");
        }
        entries.push({ storageKey, raw, ticket: parsed });
      } catch {
        unreadable.push({ storageKey, raw });
      }
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
  return {
    entries,
    unreadable,
    storageUnavailable: false,
    lockUnavailable: !locks,
  };
}

function persistToStorage(
  storage: VocabItemWriteJournalStorage,
  ticket: VocabItemWriteTicket,
): VocabItemWriteEntry {
  const entry = createVocabItemWriteEntry(ticket);
  const { storageKey, raw } = entry;
  const existing = storage.getItem(storageKey);
  if (existing !== null && existing !== raw) {
    throw new Error("另一页保留了同一动作的不同核对线索；没有开始写入。");
  }
  storage.setItem(storageKey, raw);
  if (storage.getItem(storageKey) !== raw) {
    throw new Error("浏览器没有确认保留条目核对线索；没有开始写入。");
  }
  return entry;
}

export async function persistVocabItemWrite(
  ticket: VocabItemWriteTicket,
  options?: Readonly<{
    storage?: VocabItemWriteJournalStorage;
    locks?: VocabItemWriteJournalLockManager | null;
  }>,
): Promise<VocabItemWriteEntry> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, () => {
    const journal = readVocabItemWriteJournal(storage, locks);
    if (journal.storageUnavailable) {
      throw new Error("暂时无法读取全部条目核对线索；没有开始写入。");
    }
    if (journal.unreadable.length > 0) {
      throw new Error("先处理无法验证的条目提醒；没有开始新的写入。");
    }
    const itemId = ticket.receipt.before.item.id;
    if (
      journal.entries.some((entry) =>
        entry.ticket.receipt.before.item.id === itemId
      )
    ) {
      throw new Error("这个条目已有待处理写入；没有开始新的写入。");
    }
    return persistToStorage(storage, ticket);
  });
}

function replaceInStorage(
  storage: VocabItemWriteJournalStorage,
  entry: VocabItemWriteEntry,
  kind: VocabItemWriteTicket["kind"],
): VocabItemWriteEntry {
  if (storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error("另一页已经处理了这条条目核对线索。");
  }
  const ticket = { ...entry.ticket, kind };
  const raw = JSON.stringify(ticket);
  if (raw.length > VOCAB_ITEM_WRITE_MAX_CHARS) {
    throw new Error("最新条目核对线索过大；没有覆盖原提醒。");
  }
  storage.setItem(entry.storageKey, raw);
  if (storage.getItem(entry.storageKey) !== raw) {
    throw new Error("浏览器没有确认保留最新条目核对线索。");
  }
  return { storageKey: entry.storageKey, raw, ticket };
}

function removeFromStorage(
  storage: VocabItemWriteJournalStorage,
  entry: Pick<VocabItemWriteEntry, "storageKey" | "raw">,
): boolean {
  const current = storage.getItem(entry.storageKey);
  if (current === null) return true;
  if (current !== entry.raw) return false;
  storage.removeItem(entry.storageKey);
  return storage.getItem(entry.storageKey) !== entry.raw;
}

export async function runWithCurrentVocabItemWrite<Result>(
  entry: VocabItemWriteEntry,
  operation: (lease: VocabItemWriteLease) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: VocabItemWriteJournalStorage;
    locks?: VocabItemWriteJournalLockManager | null;
  }>,
): Promise<VocabItemWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, async () => {
    const journal = readVocabItemWriteJournal(storage, locks);
    if (journal.storageUnavailable) {
      return { outcome: "blocked", reason: "storage" } as const;
    }
    if (journal.unreadable.length > 0) {
      return { outcome: "blocked", reason: "unreadable" } as const;
    }
    if (storage.getItem(entry.storageKey) !== entry.raw) {
      return { outcome: "stale" } as const;
    }
    let current: VocabItemWriteEntry | null = entry;
    const lease: VocabItemWriteLease = {
      committed() {
        if (!current) throw new Error("条目核对线索已经结束。");
        current = replaceInStorage(storage, current, "committed");
        return current;
      },
      changed() {
        if (!current) throw new Error("条目核对线索已经结束。");
        current = replaceInStorage(storage, current, "changed");
        return current;
      },
      remove() {
        if (!current || !removeFromStorage(storage, current)) {
          throw new Error("另一页已经处理了这条条目核对线索。");
        }
        current = null;
      },
    };
    const value = await operation(lease);
    return { outcome: "ran", value, entry: current } as const;
  });
}

export async function runWithMissingVocabItemWrite<Result>(
  heldEntry: VocabItemWriteEntry,
  operation: (lease: VocabItemWriteLease) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: VocabItemWriteJournalStorage;
    locks?: VocabItemWriteJournalLockManager | null;
  }>,
): Promise<VocabItemWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, async () => {
    const journal = readVocabItemWriteJournal(storage, locks);
    if (journal.storageUnavailable) {
      return { outcome: "blocked", reason: "storage" } as const;
    }
    if (journal.unreadable.length > 0) {
      return { outcome: "blocked", reason: "unreadable" } as const;
    }
    const itemId = heldEntry.ticket.receipt.before.item.id;
    if (
      storage.getItem(heldEntry.storageKey) !== null ||
      journal.entries.some((entry) =>
        entry.ticket.receipt.before.item.id === itemId
      )
    ) {
      return { outcome: "stale" } as const;
    }

    const checkTicket = { ...heldEntry.ticket, kind: "check" } as const;
    let current: VocabItemWriteEntry | null = persistToStorage(
      storage,
      checkTicket,
    );
    const lease: VocabItemWriteLease = {
      committed() {
        if (!current) throw new Error("条目核对线索已经结束。");
        current = replaceInStorage(storage, current, "committed");
        return current;
      },
      changed() {
        if (!current) throw new Error("条目核对线索已经结束。");
        current = replaceInStorage(storage, current, "changed");
        return current;
      },
      remove() {
        if (!current || !removeFromStorage(storage, current)) {
          throw new Error("另一页已经处理了这条条目核对线索。");
        }
        current = null;
      },
    };
    const value = await operation(lease);
    return { outcome: "ran", value, entry: current } as const;
  });
}

export async function removeUnreadableVocabItemWrite(
  entry: UnreadableVocabItemWrite,
  options?: Readonly<{
    storage?: VocabItemWriteJournalStorage;
    locks?: VocabItemWriteJournalLockManager | null;
  }>,
): Promise<boolean> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, () => removeFromStorage(storage, entry));
}

export function claimVocabItemWrite(
  operationRef: OperationRef,
): VocabItemWriteToken | null {
  if (operationRef.current) return null;
  const token = Symbol("vocab-item-write");
  operationRef.current = token;
  return token;
}

export function releaseVocabItemWrite(
  operationRef: OperationRef,
  token: VocabItemWriteToken,
): boolean {
  if (operationRef.current !== token) return false;
  operationRef.current = null;
  return true;
}
