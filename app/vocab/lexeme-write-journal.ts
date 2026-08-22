import {
  isVocabLexemeWriteReceipt,
  type VocabLexemeWriteReceipt,
} from "@/lib/vocab/store";

export const VOCAB_LEXEME_WRITE_PREFIX = "vocab.lexeme-write.v1:";
export const VOCAB_LEXEME_WRITE_JOURNAL_LOCK =
  "private-ai-suite:vocab:lexeme-write-journal";
export const VOCAB_LEXEME_WRITE_MAX_CHARS = 1024 * 1024;

export type VocabLexemeWriteTicket = Readonly<{
  version: 1;
  kind: "check" | "committed" | "changed";
  receipt: VocabLexemeWriteReceipt;
  recordedAt: string;
}>;

export type VocabLexemeWriteEntry = Readonly<{
  storageKey: string;
  raw: string;
  ticket: VocabLexemeWriteTicket;
}>;

export type UnreadableVocabLexemeWrite = Readonly<{
  storageKey: string;
  raw: string;
}>;

export type VocabLexemeWriteJournal = Readonly<{
  entries: readonly VocabLexemeWriteEntry[];
  unreadable: readonly UnreadableVocabLexemeWrite[];
  storageUnavailable: boolean;
  lockUnavailable: boolean;
}>;

export type VocabLexemeWriteJournalStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;

export type VocabLexemeWriteJournalLockManager = Pick<LockManager, "request">;

export type VocabLexemeWriteLease = Readonly<{
  committed(): VocabLexemeWriteEntry;
  changed(): VocabLexemeWriteEntry;
  remove(): void;
}>;

export type VocabLexemeWriteRunResult<Result> =
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "blocked"; reason: "storage" | "unreadable" }>
  | Readonly<{
      outcome: "ran";
      value: Result;
      entry: VocabLexemeWriteEntry | null;
    }>;

export type VocabLexemeWriteToken = symbol;
type OperationRef = { current: VocabLexemeWriteToken | null };

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function browserStorage(): VocabLexemeWriteJournalStorage {
  if (typeof window === "undefined") {
    throw new Error("当前页面无法读取词条核对线索；没有开始写入。");
  }
  return window.localStorage;
}

function browserLocks(): VocabLexemeWriteJournalLockManager | null {
  if (typeof navigator === "undefined") return null;
  return navigator.locks ?? null;
}

async function withJournalLock<Result>(
  locks: VocabLexemeWriteJournalLockManager | null,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  if (!locks) {
    throw new Error("当前浏览器无法跨页面锁定词条核对线索；没有继续写入。");
  }
  return locks.request(VOCAB_LEXEME_WRITE_JOURNAL_LOCK, operation);
}

export function vocabLexemeWriteKey(ticket: VocabLexemeWriteTicket): string {
  return `${VOCAB_LEXEME_WRITE_PREFIX}${ticket.receipt.operationId}`;
}

export function isVocabLexemeWriteTicket(
  value: unknown,
): value is VocabLexemeWriteTicket {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value, ["version", "kind", "receipt", "recordedAt"])
  ) return false;
  const ticket = value as Record<string, unknown>;
  const receipt = ticket.receipt as { purpose?: unknown } | null;
  return ticket.version === 1 &&
    (ticket.kind === "check" || ticket.kind === "committed" ||
      ticket.kind === "changed") &&
    typeof ticket.recordedAt === "string" &&
    ticket.recordedAt.length === 24 &&
    Number.isFinite(Date.parse(ticket.recordedAt)) &&
    new Date(ticket.recordedAt).toISOString() === ticket.recordedAt &&
    receipt?.purpose === "vocab-lexeme-write" &&
    isVocabLexemeWriteReceipt(ticket.receipt);
}

export function createVocabLexemeWriteTicket(
  receipt: VocabLexemeWriteReceipt,
  recordedAt = new Date().toISOString(),
): VocabLexemeWriteTicket {
  const ticket = { version: 1, kind: "check", receipt, recordedAt } as const;
  if (!isVocabLexemeWriteTicket(ticket)) {
    throw new Error("词条核对凭据无效；没有开始写入。");
  }
  return ticket;
}

export function createVocabLexemeWriteEntry(
  ticket: VocabLexemeWriteTicket,
): VocabLexemeWriteEntry {
  if (!isVocabLexemeWriteTicket(ticket)) {
    throw new Error("词条核对凭据无效；没有开始写入。");
  }
  const storageKey = vocabLexemeWriteKey(ticket);
  const raw = JSON.stringify(ticket);
  if (raw.length > VOCAB_LEXEME_WRITE_MAX_CHARS) {
    throw new Error("这次词条内容过大，无法安全保留核对线索；没有开始写入。");
  }
  return { storageKey, raw, ticket };
}

export function readVocabLexemeWriteJournal(
  storage: VocabLexemeWriteJournalStorage = browserStorage(),
  locks: VocabLexemeWriteJournalLockManager | null = browserLocks(),
): VocabLexemeWriteJournal {
  const entries: VocabLexemeWriteEntry[] = [];
  const unreadable: UnreadableVocabLexemeWrite[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const storageKey = storage.key(index);
      if (!storageKey?.startsWith(VOCAB_LEXEME_WRITE_PREFIX)) continue;
      let raw = "";
      try {
        raw = storage.getItem(storageKey) ?? "";
        if (!raw || raw.length > VOCAB_LEXEME_WRITE_MAX_CHARS) {
          throw new Error("invalid ticket size");
        }
        const parsed: unknown = JSON.parse(raw);
        if (!isVocabLexemeWriteTicket(parsed)) throw new Error("invalid ticket");
        if (storageKey !== vocabLexemeWriteKey(parsed)) {
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
  unreadable.sort((left, right) => left.storageKey.localeCompare(right.storageKey));
  return {
    entries,
    unreadable,
    storageUnavailable: false,
    lockUnavailable: !locks,
  };
}

function persistToStorage(
  storage: VocabLexemeWriteJournalStorage,
  ticket: VocabLexemeWriteTicket,
): VocabLexemeWriteEntry {
  const entry = createVocabLexemeWriteEntry(ticket);
  const existing = storage.getItem(entry.storageKey);
  if (existing !== null && existing !== entry.raw) {
    throw new Error("另一页保留了同一动作的不同词条核对线索；没有开始写入。");
  }
  storage.setItem(entry.storageKey, entry.raw);
  if (storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error("浏览器没有确认保留词条核对线索；没有开始写入。");
  }
  return entry;
}

export async function persistVocabLexemeWrite(
  ticket: VocabLexemeWriteTicket,
  options?: Readonly<{
    storage?: VocabLexemeWriteJournalStorage;
    locks?: VocabLexemeWriteJournalLockManager | null;
  }>,
): Promise<VocabLexemeWriteEntry> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, () => {
    const journal = readVocabLexemeWriteJournal(storage, locks);
    if (journal.storageUnavailable) {
      throw new Error("暂时无法读取全部词条核对线索；没有开始写入。");
    }
    if (journal.unreadable.length > 0) {
      throw new Error("先处理无法验证的词条提醒；没有开始新的写入。");
    }
    const lexemeId = ticket.receipt.before.lexeme.id;
    if (journal.entries.some((entry) =>
      entry.ticket.receipt.before.lexeme.id === lexemeId
    )) {
      throw new Error("这个词条已有待处理写入；没有开始新的写入。");
    }
    return persistToStorage(storage, ticket);
  });
}

function replaceInStorage(
  storage: VocabLexemeWriteJournalStorage,
  entry: VocabLexemeWriteEntry,
  kind: VocabLexemeWriteTicket["kind"],
): VocabLexemeWriteEntry {
  if (storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error("另一页已经处理了这条词条核对线索。");
  }
  const ticket = { ...entry.ticket, kind };
  const next = createVocabLexemeWriteEntry(ticket);
  storage.setItem(entry.storageKey, next.raw);
  if (storage.getItem(entry.storageKey) !== next.raw) {
    throw new Error("浏览器没有确认保留最新词条核对线索。");
  }
  return next;
}

function removeFromStorage(
  storage: VocabLexemeWriteJournalStorage,
  entry: Pick<VocabLexemeWriteEntry, "storageKey" | "raw">,
): boolean {
  const current = storage.getItem(entry.storageKey);
  if (current === null) return true;
  if (current !== entry.raw) return false;
  storage.removeItem(entry.storageKey);
  return storage.getItem(entry.storageKey) !== entry.raw;
}

function leaseFor(
  storage: VocabLexemeWriteJournalStorage,
  initial: VocabLexemeWriteEntry,
): Readonly<{
  lease: VocabLexemeWriteLease;
  current(): VocabLexemeWriteEntry | null;
}> {
  let current: VocabLexemeWriteEntry | null = initial;
  return {
    current: () => current,
    lease: {
      committed() {
        if (!current) throw new Error("词条核对线索已经结束。");
        current = replaceInStorage(storage, current, "committed");
        return current;
      },
      changed() {
        if (!current) throw new Error("词条核对线索已经结束。");
        current = replaceInStorage(storage, current, "changed");
        return current;
      },
      remove() {
        if (!current || !removeFromStorage(storage, current)) {
          throw new Error("另一页已经处理了这条词条核对线索。");
        }
        current = null;
      },
    },
  };
}

export async function runWithCurrentVocabLexemeWrite<Result>(
  entry: VocabLexemeWriteEntry,
  operation: (lease: VocabLexemeWriteLease) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: VocabLexemeWriteJournalStorage;
    locks?: VocabLexemeWriteJournalLockManager | null;
  }>,
): Promise<VocabLexemeWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, async () => {
    const journal = readVocabLexemeWriteJournal(storage, locks);
    if (journal.storageUnavailable) {
      return { outcome: "blocked", reason: "storage" } as const;
    }
    if (journal.unreadable.length > 0) {
      return { outcome: "blocked", reason: "unreadable" } as const;
    }
    if (storage.getItem(entry.storageKey) !== entry.raw) {
      return { outcome: "stale" } as const;
    }
    const locked = leaseFor(storage, entry);
    const value = await operation(locked.lease);
    return { outcome: "ran", value, entry: locked.current() } as const;
  });
}

export async function runWithMissingVocabLexemeWrite<Result>(
  heldEntry: VocabLexemeWriteEntry,
  operation: (lease: VocabLexemeWriteLease) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: VocabLexemeWriteJournalStorage;
    locks?: VocabLexemeWriteJournalLockManager | null;
  }>,
): Promise<VocabLexemeWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, async () => {
    const journal = readVocabLexemeWriteJournal(storage, locks);
    if (journal.storageUnavailable) {
      return { outcome: "blocked", reason: "storage" } as const;
    }
    if (journal.unreadable.length > 0) {
      return { outcome: "blocked", reason: "unreadable" } as const;
    }
    const lexemeId = heldEntry.ticket.receipt.before.lexeme.id;
    if (
      storage.getItem(heldEntry.storageKey) !== null ||
      journal.entries.some((entry) =>
        entry.ticket.receipt.before.lexeme.id === lexemeId
      )
    ) return { outcome: "stale" } as const;

    const checkTicket = { ...heldEntry.ticket, kind: "check" } as const;
    const checkpoint = persistToStorage(storage, checkTicket);
    const locked = leaseFor(storage, checkpoint);
    const value = await operation(locked.lease);
    return { outcome: "ran", value, entry: locked.current() } as const;
  });
}

export async function removeUnreadableVocabLexemeWrite(
  entry: UnreadableVocabLexemeWrite,
  options?: Readonly<{
    storage?: VocabLexemeWriteJournalStorage;
    locks?: VocabLexemeWriteJournalLockManager | null;
  }>,
): Promise<boolean> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, () => {
    const journal = readVocabLexemeWriteJournal(storage, locks);
    if (journal.storageUnavailable) return false;
    const current = journal.unreadable.find((candidate) =>
      candidate.storageKey === entry.storageKey && candidate.raw === entry.raw
    );
    return current ? removeFromStorage(storage, current) : false;
  });
}

export function selectVocabLexemeWriteRecoveryEntry(
  heldEntries: readonly VocabLexemeWriteEntry[],
  journalEntries: readonly VocabLexemeWriteEntry[],
): VocabLexemeWriteEntry | null {
  for (const held of heldEntries) {
    const exact = journalEntries.find((entry) =>
      entry.storageKey === held.storageKey
    );
    if (exact) return exact;
    const lexemeId = held.ticket.receipt.before.lexeme.id;
    const sameLexeme = journalEntries.find((entry) =>
      entry.ticket.receipt.before.lexeme.id === lexemeId
    );
    if (sameLexeme) return sameLexeme;
    return held;
  }
  return journalEntries[0] ?? null;
}

export function claimVocabLexemeWrite(
  operationRef: OperationRef,
): VocabLexemeWriteToken | null {
  if (operationRef.current) return null;
  const token = Symbol("vocab-lexeme-write");
  operationRef.current = token;
  return token;
}

export function releaseVocabLexemeWrite(
  operationRef: OperationRef,
  token: VocabLexemeWriteToken,
): boolean {
  if (operationRef.current !== token) return false;
  operationRef.current = null;
  return true;
}
