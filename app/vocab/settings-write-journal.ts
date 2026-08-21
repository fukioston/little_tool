import {
  isVocabSettingsWriteReceipt,
  type VocabSettingsWriteReceipt,
} from "@/lib/vocab/store";

export const VOCAB_SETTINGS_WRITE_PREFIX = "vocab.settings-write.v1:";
export const VOCAB_SETTINGS_WRITE_JOURNAL_LOCK =
  "private-ai-suite:vocab:settings-write-journal";
export const VOCAB_SETTINGS_WRITE_MAX_CHARS = 1024 * 1024;

export type VocabSettingsWriteTicket = Readonly<{
  version: 1;
  kind: "check" | "committed" | "changed";
  receipt: VocabSettingsWriteReceipt;
  recordedAt: string;
}>;

export type VocabSettingsWriteEntry = Readonly<{
  storageKey: string;
  raw: string;
  ticket: VocabSettingsWriteTicket;
}>;

export type UnreadableVocabSettingsWrite = Readonly<{
  storageKey: string;
  raw: string;
}>;

export type VocabSettingsWriteJournal = Readonly<{
  entries: readonly VocabSettingsWriteEntry[];
  unreadable: readonly UnreadableVocabSettingsWrite[];
  storageUnavailable: boolean;
  lockUnavailable: boolean;
}>;

export type VocabSettingsWriteJournalStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;

export type VocabSettingsWriteJournalLockManager = Pick<LockManager, "request">;

export type VocabSettingsWriteLease = Readonly<{
  committed(): VocabSettingsWriteEntry;
  changed(): VocabSettingsWriteEntry;
  remove(): void;
}>;

export type VocabSettingsWriteRunResult<Result> =
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "blocked"; reason: "storage" | "unreadable" }>
  | Readonly<{ outcome: "ran"; value: Result; entry: VocabSettingsWriteEntry | null }>;

export type VocabSettingsWriteToken = symbol;
type OperationRef = { current: VocabSettingsWriteToken | null };

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function browserStorage(): VocabSettingsWriteJournalStorage {
  if (typeof window === "undefined") {
    throw new Error("当前页面无法读取设置核对线索；没有开始写入。");
  }
  return window.localStorage;
}

function browserLocks(): VocabSettingsWriteJournalLockManager | null {
  if (typeof navigator === "undefined") return null;
  return navigator.locks ?? null;
}

async function withJournalLock<Result>(
  locks: VocabSettingsWriteJournalLockManager | null,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  if (!locks) {
    throw new Error("当前浏览器无法跨页面锁定设置核对线索；没有继续改动。");
  }
  return locks.request(VOCAB_SETTINGS_WRITE_JOURNAL_LOCK, operation);
}

export function vocabSettingsWriteKey(ticket: VocabSettingsWriteTicket): string {
  return `${VOCAB_SETTINGS_WRITE_PREFIX}${ticket.receipt.operationId}`;
}

export function isVocabSettingsWriteTicket(
  value: unknown,
): value is VocabSettingsWriteTicket {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [
    "version", "kind", "receipt", "recordedAt",
  ])) return false;
  const ticket = value as Record<string, unknown>;
  return ticket.version === 1 &&
    (ticket.kind === "check" || ticket.kind === "committed" || ticket.kind === "changed") &&
    typeof ticket.recordedAt === "string" && ticket.recordedAt.length === 24 &&
    Number.isFinite(Date.parse(ticket.recordedAt)) &&
    new Date(ticket.recordedAt).toISOString() === ticket.recordedAt &&
    isVocabSettingsWriteReceipt(ticket.receipt);
}

export function createVocabSettingsWriteTicket(
  receipt: VocabSettingsWriteReceipt,
  recordedAt = new Date().toISOString(),
): VocabSettingsWriteTicket {
  const ticket = { version: 1, kind: "check", receipt, recordedAt } as const;
  if (!isVocabSettingsWriteTicket(ticket)) {
    throw new Error("设置核对凭据无效；没有开始写入。");
  }
  return ticket;
}

export function readVocabSettingsWriteJournal(
  storage: VocabSettingsWriteJournalStorage = browserStorage(),
  locks: VocabSettingsWriteJournalLockManager | null = browserLocks(),
): VocabSettingsWriteJournal {
  const entries: VocabSettingsWriteEntry[] = [];
  const unreadable: UnreadableVocabSettingsWrite[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const storageKey = storage.key(index);
      if (!storageKey?.startsWith(VOCAB_SETTINGS_WRITE_PREFIX)) continue;
      let raw = "";
      try {
        raw = storage.getItem(storageKey) ?? "";
        if (!raw || raw.length > VOCAB_SETTINGS_WRITE_MAX_CHARS) {
          throw new Error("invalid ticket size");
        }
        const parsed: unknown = JSON.parse(raw);
        if (!isVocabSettingsWriteTicket(parsed)) throw new Error("invalid ticket");
        if (storageKey !== vocabSettingsWriteKey(parsed)) throw new Error("misbound ticket");
        entries.push({ storageKey, raw, ticket: parsed });
      } catch {
        unreadable.push({ storageKey, raw });
      }
    }
  } catch {
    return { entries: [], unreadable: [], storageUnavailable: true, lockUnavailable: !locks };
  }
  entries.sort((left, right) =>
    left.ticket.recordedAt.localeCompare(right.ticket.recordedAt) ||
    left.storageKey.localeCompare(right.storageKey));
  return { entries, unreadable, storageUnavailable: false, lockUnavailable: !locks };
}

function persistToStorage(
  storage: VocabSettingsWriteJournalStorage,
  ticket: VocabSettingsWriteTicket,
): VocabSettingsWriteEntry {
  if (!isVocabSettingsWriteTicket(ticket)) {
    throw new Error("设置核对凭据无效；没有开始写入。");
  }
  const storageKey = vocabSettingsWriteKey(ticket);
  const raw = JSON.stringify(ticket);
  if (raw.length > VOCAB_SETTINGS_WRITE_MAX_CHARS) {
    throw new Error("这次设置内容过大，无法安全保留核对线索；没有开始写入。");
  }
  const existing = storage.getItem(storageKey);
  if (existing !== null && existing !== raw) {
    throw new Error("另一页保留了同一动作的不同核对线索；没有开始写入。");
  }
  storage.setItem(storageKey, raw);
  if (storage.getItem(storageKey) !== raw) {
    throw new Error("浏览器没有确认保留设置核对线索；没有开始写入。");
  }
  return { storageKey, raw, ticket };
}

export async function persistVocabSettingsWrite(
  ticket: VocabSettingsWriteTicket,
  options?: Readonly<{
    storage?: VocabSettingsWriteJournalStorage;
    locks?: VocabSettingsWriteJournalLockManager | null;
  }>,
): Promise<VocabSettingsWriteEntry> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, () => {
    const journal = readVocabSettingsWriteJournal(storage, locks);
    if (journal.storageUnavailable) {
      throw new Error("暂时无法读取全部设置核对线索；没有开始写入。");
    }
    if (journal.unreadable.length > 0) {
      throw new Error("先处理无法验证的设置提醒；没有开始新的写入。");
    }
    if (journal.entries.length > 0) {
      throw new Error("先处理上一条设置核对线索；没有开始新的写入。");
    }
    return persistToStorage(storage, ticket);
  });
}

function replaceInStorage(
  storage: VocabSettingsWriteJournalStorage,
  entry: VocabSettingsWriteEntry,
  kind: VocabSettingsWriteTicket["kind"],
): VocabSettingsWriteEntry {
  if (storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error("另一页已经处理了这条设置核对线索。");
  }
  const ticket = { ...entry.ticket, kind };
  const raw = JSON.stringify(ticket);
  if (raw.length > VOCAB_SETTINGS_WRITE_MAX_CHARS) {
    throw new Error("最新设置核对线索过大；没有覆盖原提醒。");
  }
  storage.setItem(entry.storageKey, raw);
  if (storage.getItem(entry.storageKey) !== raw) {
    throw new Error("浏览器没有确认保留最新设置核对线索。");
  }
  return { storageKey: entry.storageKey, raw, ticket };
}

function removeFromStorage(
  storage: VocabSettingsWriteJournalStorage,
  entry: Pick<VocabSettingsWriteEntry, "storageKey" | "raw">,
): boolean {
  const current = storage.getItem(entry.storageKey);
  if (current === null) return true;
  if (current !== entry.raw) return false;
  storage.removeItem(entry.storageKey);
  return storage.getItem(entry.storageKey) !== entry.raw;
}

export async function runWithCurrentVocabSettingsWrite<Result>(
  entry: VocabSettingsWriteEntry,
  operation: (lease: VocabSettingsWriteLease) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: VocabSettingsWriteJournalStorage;
    locks?: VocabSettingsWriteJournalLockManager | null;
  }>,
): Promise<VocabSettingsWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, async () => {
    const journal = readVocabSettingsWriteJournal(storage, locks);
    if (journal.storageUnavailable) return { outcome: "blocked", reason: "storage" } as const;
    if (journal.unreadable.length > 0) return { outcome: "blocked", reason: "unreadable" } as const;
    if (storage.getItem(entry.storageKey) !== entry.raw) return { outcome: "stale" } as const;
    let current: VocabSettingsWriteEntry | null = entry;
    const lease: VocabSettingsWriteLease = {
      committed() {
        if (!current) throw new Error("设置核对线索已经结束。");
        current = replaceInStorage(storage, current, "committed");
        return current;
      },
      changed() {
        if (!current) throw new Error("设置核对线索已经结束。");
        current = replaceInStorage(storage, current, "changed");
        return current;
      },
      remove() {
        if (!current || !removeFromStorage(storage, current)) {
          throw new Error("另一页已经处理了这条设置核对线索。");
        }
        current = null;
      },
    };
    const value = await operation(lease);
    return { outcome: "ran", value, entry: current } as const;
  });
}

export async function removeUnreadableVocabSettingsWrite(
  entry: UnreadableVocabSettingsWrite,
  options?: Readonly<{
    storage?: VocabSettingsWriteJournalStorage;
    locks?: VocabSettingsWriteJournalLockManager | null;
  }>,
): Promise<boolean> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options ? options.locks ?? null : browserLocks();
  return withJournalLock(locks, () => removeFromStorage(storage, entry));
}

export function claimVocabSettingsWrite(
  operationRef: OperationRef,
): VocabSettingsWriteToken | null {
  if (operationRef.current) return null;
  const token = Symbol("vocab-settings-write");
  operationRef.current = token;
  return token;
}

export function releaseVocabSettingsWrite(
  operationRef: OperationRef,
  token: VocabSettingsWriteToken,
): boolean {
  if (operationRef.current !== token) return false;
  operationRef.current = null;
  return true;
}
