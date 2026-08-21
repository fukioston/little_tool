import {
  isVocabReviewRatingReceipt,
  isVocabReviewUndoReceipt,
  type VocabReviewRatingReceipt,
  type VocabReviewReceipt,
  type VocabReviewUndoReceipt,
} from "@/lib/vocab/store";

export const VOCAB_REVIEW_RECOVERY_PREFIX = "vocab.review-recovery.v1:";
export const VOCAB_REVIEW_RECOVERY_MAX_BYTES = 64 * 1024;
export const VOCAB_REVIEW_JOURNAL_LOCK =
  "private-ai-suite:vocab:review-recovery-journal";
export const VOCAB_REVIEW_RECENT_UNDO_KEY = "vocab.review-recent-undo.v1";

export type VocabReviewRecoveryMode =
  | "inspect-only"
  | "retry-commit"
  | "refresh-only"
  | "discard-only";

export type VocabReviewRecoveryTicket = Readonly<{
  version: 1;
  operationId: string;
  action: "rating" | "undo";
  mode: VocabReviewRecoveryMode;
  recordedAt: string;
  receipt: VocabReviewReceipt;
}>;

export type VocabReviewRecoveryEntry = Readonly<{
  storageKey: string;
  ticket: VocabReviewRecoveryTicket;
  raw: string;
}>;

export type VocabReviewUnreadableEntry = Readonly<{
  storageKey: string;
  raw: string | null;
}>;

export type VocabReviewRecentUndoTicket = Readonly<{
  version: 1;
  kind: "recent-rating";
  recordedAt: string;
  receipt: VocabReviewRatingReceipt;
}>;

export type VocabReviewRecentUndoEntry = Readonly<{
  storageKey: typeof VOCAB_REVIEW_RECENT_UNDO_KEY;
  ticket: VocabReviewRecentUndoTicket;
  raw: string;
}>;

export type VocabReviewRecentUndoUnreadableEntry = Readonly<{
  storageKey: typeof VOCAB_REVIEW_RECENT_UNDO_KEY;
  raw: string;
}>;

export type VocabReviewRecentUndoReadResult = Readonly<{
  entry: VocabReviewRecentUndoEntry | null;
  unreadable: VocabReviewRecentUndoUnreadableEntry | null;
  storageUnavailable: boolean;
}>;

export type VocabReviewRecoveryReadResult = Readonly<{
  entries: readonly VocabReviewRecoveryEntry[];
  unreadableEntries: readonly VocabReviewUnreadableEntry[];
  storageUnavailable: boolean;
}>;

type StorageLike = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;

export type VocabReviewJournalRuntime = Readonly<{
  storage: StorageLike;
  withExclusiveLock<T>(task: () => Promise<T>): Promise<T>;
}>;

export type VocabReviewJournalWriteResult =
  | Readonly<{ outcome: "written"; entry: VocabReviewRecoveryEntry }>
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "unavailable" }>;

export type VocabReviewJournalRemoveResult =
  | Readonly<{ outcome: "removed" }>
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "unavailable" }>;

export type VocabReviewRecentUndoWriteResult =
  | Readonly<{ outcome: "written"; entry: VocabReviewRecentUndoEntry }>
  | Readonly<{ outcome: "unavailable" }>;

export type VocabReviewLockedEntry = Readonly<{
  current(): VocabReviewRecoveryEntry;
  replace(ticket: VocabReviewRecoveryTicket): VocabReviewJournalWriteResult;
  remove(): VocabReviewJournalRemoveResult;
  rememberRecentRating(
    receipt: VocabReviewRatingReceipt,
  ): VocabReviewRecentUndoWriteResult;
  clearRecentRating(eventId: string): VocabReviewJournalRemoveResult;
}>;

export type VocabReviewLockedRecentUndoEntry = Readonly<{
  current(): VocabReviewRecentUndoEntry;
  remove(): VocabReviewJournalRemoveResult;
}>;

export type VocabReviewJournalTransactionResult<T> =
  | Readonly<{ outcome: "completed"; value: T }>
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "unavailable" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const expected = new Set(expectedKeys);
  const actual = Object.keys(value);
  return actual.length === expected.size &&
    actual.every((key) => expected.has(key));
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function receiptMatchesAction(
  action: unknown,
  receipt: unknown,
): receipt is VocabReviewReceipt {
  if (action === "rating") return isVocabReviewRatingReceipt(receipt);
  if (action === "undo") return isVocabReviewUndoReceipt(receipt);
  return false;
}

export function isVocabReviewRecoveryTicket(
  value: unknown,
): value is VocabReviewRecoveryTicket {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "operationId", "action", "mode", "recordedAt", "receipt",
  ])) return false;
  if (
    value.version !== 1 ||
    typeof value.operationId !== "string" ||
    !isCanonicalIsoTimestamp(value.recordedAt) ||
    (
      value.mode !== "inspect-only" &&
      value.mode !== "retry-commit" &&
      value.mode !== "refresh-only" &&
      value.mode !== "discard-only"
    ) ||
    !receiptMatchesAction(value.action, value.receipt)
  ) return false;
  return value.operationId === value.receipt.operationId;
}

export function isVocabReviewRecentUndoTicket(
  value: unknown,
): value is VocabReviewRecentUndoTicket {
  return isRecord(value) && hasExactKeys(value, [
    "version", "kind", "recordedAt", "receipt",
  ]) && value.version === 1 && value.kind === "recent-rating" &&
    isCanonicalIsoTimestamp(value.recordedAt) &&
    isVocabReviewRatingReceipt(value.receipt);
}

export function createVocabReviewRecentUndoTicket(
  receipt: VocabReviewRatingReceipt,
  recordedAt = new Date().toISOString(),
): VocabReviewRecentUndoTicket {
  const ticket: VocabReviewRecentUndoTicket = {
    version: 1,
    kind: "recent-rating",
    recordedAt,
    receipt,
  };
  if (!isVocabReviewRecentUndoTicket(ticket)) {
    throw new Error("最近一次复习凭据无法严格验证。");
  }
  return ticket;
}

function serializedRecentUndoEntry(
  receipt: VocabReviewRatingReceipt,
): VocabReviewRecentUndoEntry {
  const ticket = createVocabReviewRecentUndoTicket(receipt);
  const raw = JSON.stringify(ticket);
  if (raw.length === 0 || raw.length > VOCAB_REVIEW_RECOVERY_MAX_BYTES) {
    throw new Error("最近一次复习凭据超出安全大小限制。");
  }
  return { storageKey: VOCAB_REVIEW_RECENT_UNDO_KEY, ticket, raw };
}

function parseStoredRecentUndoTicket(
  raw: string,
): VocabReviewRecentUndoTicket | null {
  if (raw.length === 0 || raw.length > VOCAB_REVIEW_RECOVERY_MAX_BYTES) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    return isVocabReviewRecentUndoTicket(value) ? value : null;
  } catch {
    return null;
  }
}

export function readVocabReviewRecentUndoStorage(
  storage: StorageLike,
): VocabReviewRecentUndoReadResult {
  try {
    const raw = storage.getItem(VOCAB_REVIEW_RECENT_UNDO_KEY);
    if (raw === null) {
      return { entry: null, unreadable: null, storageUnavailable: false };
    }
    const value = parseStoredRecentUndoTicket(raw);
    if (!value) {
      return {
        entry: null,
        unreadable: { storageKey: VOCAB_REVIEW_RECENT_UNDO_KEY, raw },
        storageUnavailable: false,
      };
    }
    return {
      entry: { storageKey: VOCAB_REVIEW_RECENT_UNDO_KEY, ticket: value, raw },
      unreadable: null,
      storageUnavailable: false,
    };
  } catch {
    return { entry: null, unreadable: null, storageUnavailable: true };
  }
}

export function readBrowserVocabReviewRecentUndo(): VocabReviewRecentUndoReadResult {
  if (typeof window === "undefined") {
    return { entry: null, unreadable: null, storageUnavailable: true };
  }
  try {
    return readVocabReviewRecentUndoStorage(window.localStorage);
  } catch {
    return { entry: null, unreadable: null, storageUnavailable: true };
  }
}

export function createVocabReviewRecoveryTicket(
  receipt: VocabReviewRatingReceipt | VocabReviewUndoReceipt,
  mode: VocabReviewRecoveryMode = "inspect-only",
  recordedAt = new Date().toISOString(),
): VocabReviewRecoveryTicket {
  const ticket: VocabReviewRecoveryTicket = {
    version: 1,
    operationId: receipt.operationId,
    action: receipt.kind === "review-rating" ? "rating" : "undo",
    mode,
    recordedAt,
    receipt,
  };
  if (!isVocabReviewRecoveryTicket(ticket)) {
    throw new Error("复习恢复凭据无法严格验证。");
  }
  return ticket;
}

export function transitionVocabReviewRecoveryTicket(
  ticket: VocabReviewRecoveryTicket,
  mode: VocabReviewRecoveryMode,
): VocabReviewRecoveryTicket {
  return createVocabReviewRecoveryTicket(ticket.receipt, mode, ticket.recordedAt);
}

export function vocabReviewRecoveryStorageKey(
  ticket: VocabReviewRecoveryTicket,
): string {
  return `${VOCAB_REVIEW_RECOVERY_PREFIX}${ticket.operationId}`;
}

function parseStoredTicket(
  storageKey: string,
  raw: string,
): VocabReviewRecoveryTicket | null {
  if (raw.length === 0 || raw.length > VOCAB_REVIEW_RECOVERY_MAX_BYTES) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!isVocabReviewRecoveryTicket(value)) return null;
    return storageKey === vocabReviewRecoveryStorageKey(value) ? value : null;
  } catch {
    return null;
  }
}

const recoveryModePriority: Record<VocabReviewRecoveryMode, number> = {
  "refresh-only": 0,
  "discard-only": 1,
  "inspect-only": 2,
  "retry-commit": 3,
};

export function readVocabReviewRecoveryStorage(
  storage: StorageLike,
): VocabReviewRecoveryReadResult {
  const entries: VocabReviewRecoveryEntry[] = [];
  const unreadableEntries: VocabReviewUnreadableEntry[] = [];
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(VOCAB_REVIEW_RECOVERY_PREFIX)) keys.push(key);
    }
    for (const storageKey of keys) {
      const raw = storage.getItem(storageKey);
      if (raw === null) {
        unreadableEntries.push({ storageKey, raw });
        continue;
      }
      const ticket = parseStoredTicket(storageKey, raw);
      if (!ticket) {
        unreadableEntries.push({ storageKey, raw });
        continue;
      }
      entries.push({ storageKey, ticket, raw });
    }
  } catch {
    return { entries, unreadableEntries, storageUnavailable: true };
  }
  entries.sort((left, right) => {
    const priority = recoveryModePriority[left.ticket.mode] -
      recoveryModePriority[right.ticket.mode];
    return priority || left.ticket.recordedAt.localeCompare(right.ticket.recordedAt) ||
      left.ticket.operationId.localeCompare(right.ticket.operationId);
  });
  unreadableEntries.sort((left, right) =>
    left.storageKey.localeCompare(right.storageKey));
  return { entries, unreadableEntries, storageUnavailable: false };
}

export function readBrowserVocabReviewRecovery(): VocabReviewRecoveryReadResult {
  if (typeof window === "undefined") {
    return { entries: [], unreadableEntries: [], storageUnavailable: true };
  }
  try {
    return readVocabReviewRecoveryStorage(window.localStorage);
  } catch {
    return { entries: [], unreadableEntries: [], storageUnavailable: true };
  }
}

function defaultJournalRuntime(): VocabReviewJournalRuntime {
  return {
    storage: window.localStorage,
    async withExclusiveLock<T>(task: () => Promise<T>): Promise<T> {
      const manager = navigator.locks;
      if (!manager) {
        throw new Error("当前浏览器无法提供跨页面恢复锁。");
      }
      return manager.request(VOCAB_REVIEW_JOURNAL_LOCK, { mode: "exclusive" }, task);
    },
  };
}

export async function probeVocabReviewJournalLock(
  runtime?: VocabReviewJournalRuntime,
): Promise<"available" | "unavailable"> {
  try {
    const journal = runtime ?? defaultJournalRuntime();
    await journal.withExclusiveLock(async () => undefined);
    return "available";
  } catch {
    return "unavailable";
  }
}

function serializedRecoveryEntry(
  ticket: VocabReviewRecoveryTicket,
): VocabReviewRecoveryEntry {
  if (!isVocabReviewRecoveryTicket(ticket)) {
    throw new Error("复习恢复凭据无法严格验证。");
  }
  const raw = JSON.stringify(ticket);
  if (raw.length === 0 || raw.length > VOCAB_REVIEW_RECOVERY_MAX_BYTES) {
    throw new Error("复习恢复凭据超出安全大小限制。");
  }
  return {
    storageKey: vocabReviewRecoveryStorageKey(ticket),
    ticket,
    raw,
  };
}

function lockedEntryController(
  storage: StorageLike,
  initial: VocabReviewRecoveryEntry,
): VocabReviewLockedEntry {
  let current = initial;
  return {
    current: () => current,
    replace(ticket) {
      try {
        const next = serializedRecoveryEntry(ticket);
        if (
          next.storageKey !== current.storageKey ||
          storage.getItem(current.storageKey) !== current.raw
        ) return { outcome: "stale" };
        storage.setItem(next.storageKey, next.raw);
        if (storage.getItem(next.storageKey) !== next.raw) {
          return { outcome: "unavailable" };
        }
        current = next;
        return { outcome: "written", entry: next };
      } catch {
        return { outcome: "unavailable" };
      }
    },
    remove() {
      try {
        if (storage.getItem(current.storageKey) !== current.raw) {
          return { outcome: "stale" };
        }
        storage.removeItem(current.storageKey);
        return storage.getItem(current.storageKey) === null
          ? { outcome: "removed" }
          : { outcome: "unavailable" };
      } catch {
        return { outcome: "unavailable" };
      }
    },
    rememberRecentRating(receipt) {
      let previous: string | null = null;
      try {
        previous = storage.getItem(VOCAB_REVIEW_RECENT_UNDO_KEY);
        const next = serializedRecentUndoEntry(receipt);
        storage.setItem(next.storageKey, next.raw);
        if (storage.getItem(next.storageKey) === next.raw) {
          return { outcome: "written", entry: next };
        }
      } catch {
        // Remove only the stale affordance we observed before this exact write.
      }
      try {
        if (storage.getItem(VOCAB_REVIEW_RECENT_UNDO_KEY) === previous) {
          storage.removeItem(VOCAB_REVIEW_RECENT_UNDO_KEY);
        }
      } catch {
        // A stale affordance can fail safely: prepareUndo rechecks database truth.
      }
      return { outcome: "unavailable" };
    },
    clearRecentRating(eventId) {
      try {
        const raw = storage.getItem(VOCAB_REVIEW_RECENT_UNDO_KEY);
        if (raw === null) return { outcome: "removed" };
        if (
          raw.length === 0 ||
          raw.length > VOCAB_REVIEW_RECOVERY_MAX_BYTES
        ) return { outcome: "stale" };
        const value: unknown = JSON.parse(raw);
        if (
          !isVocabReviewRecentUndoTicket(value) ||
          value.receipt.eventId !== eventId
        ) return { outcome: "stale" };
        storage.removeItem(VOCAB_REVIEW_RECENT_UNDO_KEY);
        return storage.getItem(VOCAB_REVIEW_RECENT_UNDO_KEY) === null
          ? { outcome: "removed" }
          : { outcome: "unavailable" };
      } catch {
        return { outcome: "unavailable" };
      }
    },
  };
}

function lockedRecentUndoController(
  storage: StorageLike,
  initial: VocabReviewRecentUndoEntry,
): VocabReviewLockedRecentUndoEntry {
  return {
    current: () => initial,
    remove() {
      try {
        if (storage.getItem(initial.storageKey) !== initial.raw) {
          return { outcome: "stale" };
        }
        storage.removeItem(initial.storageKey);
        return storage.getItem(initial.storageKey) === null
          ? { outcome: "removed" }
          : { outcome: "unavailable" };
      } catch {
        return { outcome: "unavailable" };
      }
    },
  };
}

function hasAnyReviewRecoveryKey(storage: StorageLike): boolean {
  for (let index = 0; index < storage.length; index += 1) {
    if (storage.key(index)?.startsWith(VOCAB_REVIEW_RECOVERY_PREFIX)) {
      return true;
    }
  }
  return false;
}

export async function runNewVocabReviewRecoveryTransaction<T>(
  ticket: VocabReviewRecoveryTicket,
  task: (locked: VocabReviewLockedEntry) => Promise<T>,
  runtime?: VocabReviewJournalRuntime,
): Promise<VocabReviewJournalTransactionResult<T>> {
  let initial: VocabReviewRecoveryEntry;
  try {
    initial = serializedRecoveryEntry(ticket);
    const journal = runtime ?? defaultJournalRuntime();
    return await journal.withExclusiveLock(async () => {
      if (hasAnyReviewRecoveryKey(journal.storage)) {
        return { outcome: "stale" } as const;
      }
      journal.storage.setItem(initial.storageKey, initial.raw);
      if (journal.storage.getItem(initial.storageKey) !== initial.raw) {
        return { outcome: "unavailable" } as const;
      }
      const value = await task(lockedEntryController(journal.storage, initial));
      return { outcome: "completed", value } as const;
    });
  } catch {
    return { outcome: "unavailable" };
  }
}

export async function runVocabReviewRecoveryEntryTransaction<T>(
  entry: VocabReviewRecoveryEntry,
  task: (locked: VocabReviewLockedEntry) => Promise<T>,
  runtime?: VocabReviewJournalRuntime,
): Promise<VocabReviewJournalTransactionResult<T>> {
  try {
    const journal = runtime ?? defaultJournalRuntime();
    return await journal.withExclusiveLock(async () => {
      if (journal.storage.getItem(entry.storageKey) !== entry.raw) {
        return { outcome: "stale" } as const;
      }
      const value = await task(lockedEntryController(journal.storage, entry));
      return { outcome: "completed", value } as const;
    });
  } catch {
    return { outcome: "unavailable" };
  }
}

export async function runVocabReviewRecentUndoEntryTransaction<T>(
  entry: VocabReviewRecentUndoEntry,
  task: (locked: VocabReviewLockedRecentUndoEntry) => Promise<T>,
  runtime?: VocabReviewJournalRuntime,
): Promise<VocabReviewJournalTransactionResult<T>> {
  try {
    const parsed = parseStoredRecentUndoTicket(entry.raw);
    if (
      entry.storageKey !== VOCAB_REVIEW_RECENT_UNDO_KEY ||
      !parsed ||
      JSON.stringify(parsed) !== JSON.stringify(entry.ticket)
    ) return { outcome: "unavailable" };
    const journal = runtime ?? defaultJournalRuntime();
    return await journal.withExclusiveLock(async () => {
      if (journal.storage.getItem(entry.storageKey) !== entry.raw) {
        return { outcome: "stale" } as const;
      }
      const value = await task(lockedRecentUndoController(
        journal.storage,
        entry,
      ));
      return { outcome: "completed", value } as const;
    });
  } catch {
    return { outcome: "unavailable" };
  }
}

export async function replaceVocabReviewRecoveryTicket(
  ticket: VocabReviewRecoveryTicket,
  expected: VocabReviewRecoveryEntry | null,
  runtime?: VocabReviewJournalRuntime,
): Promise<VocabReviewJournalWriteResult> {
  if (!isVocabReviewRecoveryTicket(ticket)) {
    throw new Error("复习恢复凭据无法严格验证。");
  }
  const next = serializedRecoveryEntry(ticket);
  const storageKey = next.storageKey;
  const serialized = next.raw;
  if (expected && expected.storageKey !== storageKey) return { outcome: "stale" };

  try {
    const journal = runtime ?? defaultJournalRuntime();
    return await journal.withExclusiveLock(async () => {
      const current = journal.storage.getItem(storageKey);
      if (expected ? current !== expected.raw : current !== null) {
        return { outcome: "stale" };
      }
      journal.storage.setItem(storageKey, serialized);
      if (journal.storage.getItem(storageKey) !== serialized) {
        return { outcome: "unavailable" };
      }
      return {
        outcome: "written",
        entry: { storageKey, ticket, raw: serialized },
      };
    });
  } catch {
    return { outcome: "unavailable" };
  }
}

export async function removeVocabReviewRecoveryEntry(
  entry: VocabReviewRecoveryEntry,
  runtime?: VocabReviewJournalRuntime,
): Promise<VocabReviewJournalRemoveResult> {
  try {
    const journal = runtime ?? defaultJournalRuntime();
    return await journal.withExclusiveLock(async () => {
      if (journal.storage.getItem(entry.storageKey) !== entry.raw) {
        return { outcome: "stale" };
      }
      journal.storage.removeItem(entry.storageKey);
      return journal.storage.getItem(entry.storageKey) === null
        ? { outcome: "removed" }
        : { outcome: "unavailable" };
    });
  } catch {
    return { outcome: "unavailable" };
  }
}

export async function removeUnreadableVocabReviewEntry(
  entry: VocabReviewUnreadableEntry,
  runtime?: VocabReviewJournalRuntime,
): Promise<VocabReviewJournalRemoveResult> {
  try {
    const journal = runtime ?? defaultJournalRuntime();
    return await journal.withExclusiveLock(async () => {
      if (journal.storage.getItem(entry.storageKey) !== entry.raw) {
        return { outcome: "stale" };
      }
      journal.storage.removeItem(entry.storageKey);
      return journal.storage.getItem(entry.storageKey) === null
        ? { outcome: "removed" }
        : { outcome: "unavailable" };
    });
  } catch {
    return { outcome: "unavailable" };
  }
}

export async function removeUnreadableVocabReviewRecentUndo(
  entry: VocabReviewRecentUndoUnreadableEntry,
  runtime?: VocabReviewJournalRuntime,
): Promise<VocabReviewJournalRemoveResult> {
  try {
    const journal = runtime ?? defaultJournalRuntime();
    return await journal.withExclusiveLock(async () => {
      if (journal.storage.getItem(entry.storageKey) !== entry.raw) {
        return { outcome: "stale" };
      }
      journal.storage.removeItem(entry.storageKey);
      return journal.storage.getItem(entry.storageKey) === null
        ? { outcome: "removed" }
        : { outcome: "unavailable" };
    });
  } catch {
    return { outcome: "unavailable" };
  }
}
