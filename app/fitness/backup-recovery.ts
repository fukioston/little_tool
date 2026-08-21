import type {
  FitnessPrepareCleanupReceipt,
  FitnessPrepareRecoveryReceipt,
  FitnessRestoreReceipt,
  FitnessRestoreSummary,
} from "@/lib/fitness/backup";

export const FITNESS_BACKUP_RECOVERY_PREFIX = "fitness.backup-recovery.v1:";
export const FITNESS_BACKUP_RECOVERY_MAX_BYTES = 256 * 1024;
export const FITNESS_BACKUP_JOURNAL_LOCK =
  "private-ai-suite:fitness:backup-recovery-journal";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SQLITE_IDENTITY_BYTES = 72;
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILE_COUNT = 1_000;
const FITNESS_APPLICATION_ID = 0x53484c4e;
const FITNESS_USER_VERSION = 2;

export type FitnessBackupCandidateMode =
  | "review"
  | "activation-check"
  | "discard-only";

export type FitnessBackupRecoveryTicket =
  | Readonly<{
      version: 1;
      kind: "prepare";
      receipt: FitnessPrepareRecoveryReceipt;
      recordedAt: string;
    }>
  | Readonly<{
      version: 1;
      kind: "candidate";
      mode: FitnessBackupCandidateMode;
      receipt: FitnessRestoreReceipt;
      recordedAt: string;
    }>
  | Readonly<{
      version: 1;
      kind: "prepare-cleanup";
      receipt: FitnessPrepareCleanupReceipt;
      recordedAt: string;
    }>
  | Readonly<{
      version: 1;
      kind: "refresh-only";
      receipt: FitnessRestoreReceipt;
      recordedAt: string;
    }>;

export type FitnessBackupRecoveryEntry = Readonly<{
  storageKey: string;
  ticket: FitnessBackupRecoveryTicket;
  raw: string;
}>;

export type FitnessBackupVolatileTransition = Readonly<{
  ticket: FitnessBackupRecoveryTicket;
  expected: FitnessBackupRecoveryEntry | null;
}>;

export type FitnessBackupUnreadableEntry = Readonly<{
  storageKey: string;
  raw: string | null;
}>;

export type FitnessBackupRecoveryReadResult = Readonly<{
  entries: readonly FitnessBackupRecoveryEntry[];
  unreadableEntries: readonly FitnessBackupUnreadableEntry[];
  storageUnavailable: boolean;
}>;

type StorageLike = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;

export type FitnessBackupJournalRuntime = Readonly<{
  storage: StorageLike;
  withExclusiveLock<T>(task: () => Promise<T>): Promise<T>;
}>;

export type FitnessBackupRecoveryLease = Readonly<{
  current(): FitnessBackupRecoveryEntry | null;
  replace(ticket: FitnessBackupRecoveryTicket): FitnessBackupRecoveryEntry;
  remove(): void;
}>;

export type FitnessBackupRecoveryRunResult<Result> =
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "blocked" }>
  | Readonly<{ outcome: "unavailable" }>
  | Readonly<{
      outcome: "ran";
      value: Result;
      entry: FitnessBackupRecoveryEntry | null;
    }>;

export type FitnessBackupNewRecoveryRunResult<Result> =
  | Readonly<{ outcome: "blocked" }>
  | Readonly<{
      outcome: "ran";
      value: Result;
      entry: FitnessBackupRecoveryEntry | null;
    }>;

export type FitnessBackupJournalWriteResult =
  | Readonly<{ outcome: "written"; entry: FitnessBackupRecoveryEntry }>
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "unavailable" }>;

export type FitnessBackupJournalCheckResult =
  | Readonly<{ outcome: "current" }>
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "unavailable" }>;

export type FitnessBackupJournalRemoveResult =
  | Readonly<{ outcome: "removed" }>
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "unavailable" }>;

export type FitnessBackupVolatileReconcileResult =
  | Readonly<{
      outcome: "persisted" | "written" | "adopted";
      entry: FitnessBackupRecoveryEntry;
    }>
  | Readonly<{ outcome: "conflict" }>
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

function isSafeFileName(value: unknown): value is string | null {
  return value === null || (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || point === 127;
    })
  );
}

function isGenerationId(value: unknown, allowLegacy = false): value is string {
  return typeof value === "string" &&
    ((allowLegacy && value === "legacy") || UUID_V4_PATTERN.test(value));
}

function isStagedFileKeys(value: unknown): value is readonly string[] {
  return Array.isArray(value) &&
    value.length <= MAX_FILE_COUNT &&
    value.every((key) => typeof key === "string" && UUID_V4_PATTERN.test(key)) &&
    new Set(value).size === value.length;
}

export function isFitnessRestoreSummary(
  value: unknown,
): value is FitnessRestoreSummary {
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind", "fileName", "byteSize", "databaseByteSize", "exportedAt",
    "sourceUserVersion", "canonicalUserVersion", "fileCount",
    "venueCount", "equipmentCount", "exerciseCount", "sessionCount",
    "verification",
  ])) return false;

  if (
    (value.kind !== "complete-backup" &&
      value.kind !== "legacy-fitness-sqlite") ||
    !isSafeFileName(value.fileName) ||
    !Number.isSafeInteger(value.byteSize) ||
    Number(value.byteSize) < SQLITE_IDENTITY_BYTES ||
    Number(value.byteSize) > MAX_BACKUP_BYTES ||
    !Number.isSafeInteger(value.databaseByteSize) ||
    Number(value.databaseByteSize) < SQLITE_IDENTITY_BYTES ||
    Number(value.databaseByteSize) > MAX_DATABASE_BYTES ||
    Number(value.databaseByteSize) > Number(value.byteSize) ||
    !(value.exportedAt === null || isCanonicalIsoTimestamp(value.exportedAt)) ||
    !Number.isSafeInteger(value.sourceUserVersion) ||
    Number(value.sourceUserVersion) < 1 ||
    Number(value.sourceUserVersion) > FITNESS_USER_VERSION ||
    value.canonicalUserVersion !== FITNESS_USER_VERSION ||
    !Number.isSafeInteger(value.fileCount) ||
    Number(value.fileCount) < 0 ||
    Number(value.fileCount) > MAX_FILE_COUNT ||
    value.venueCount !== null ||
    value.equipmentCount !== null ||
    value.exerciseCount !== null ||
    value.sessionCount !== null ||
    (value.verification !== "container-and-payload-verified" &&
      value.verification !== "fitness-schema-verified")
  ) return false;

  if (value.kind === "complete-backup") {
    return value.exportedAt !== null &&
      value.verification === "container-and-payload-verified";
  }
  return value.exportedAt === null &&
    value.fileCount === 0 &&
    value.byteSize === value.databaseByteSize &&
    value.verification === "fitness-schema-verified";
}

export function isFitnessRestoreReceipt(
  value: unknown,
): value is FitnessRestoreReceipt {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "database", "generationId", "activationToken",
    "recoveryToken", "expectedCurrentGenerationId",
    "expectedCurrentSequence", "canonicalApplicationId",
    "canonicalUserVersion", "databaseSha256", "filesSha256",
    "projectionSha256", "preparedAt", "summary", "stagedFileKeys",
  ])) return false;
  if (
    value.version !== 1 ||
    value.database !== "shilian" ||
    !isGenerationId(value.generationId) ||
    typeof value.activationToken !== "string" ||
    !SHA256_PATTERN.test(value.activationToken) ||
    typeof value.recoveryToken !== "string" ||
    !SHA256_PATTERN.test(value.recoveryToken) ||
    !isGenerationId(value.expectedCurrentGenerationId, true) ||
    !Number.isSafeInteger(value.expectedCurrentSequence) ||
    Number(value.expectedCurrentSequence) < 0 ||
    value.canonicalApplicationId !== FITNESS_APPLICATION_ID ||
    value.canonicalUserVersion !== FITNESS_USER_VERSION ||
    typeof value.databaseSha256 !== "string" ||
    !SHA256_PATTERN.test(value.databaseSha256) ||
    typeof value.filesSha256 !== "string" ||
    !SHA256_PATTERN.test(value.filesSha256) ||
    typeof value.projectionSha256 !== "string" ||
    !SHA256_PATTERN.test(value.projectionSha256) ||
    !isCanonicalIsoTimestamp(value.preparedAt) ||
    !isFitnessRestoreSummary(value.summary) ||
    !isStagedFileKeys(value.stagedFileKeys)
  ) return false;
  return value.summary.fileCount === value.stagedFileKeys.length &&
    value.summary.canonicalUserVersion === value.canonicalUserVersion;
}

function isPrepareReceiptCore(
  value: Record<string, unknown>,
): value is Record<string, unknown> & {
  operationId: string;
  generationId: string;
  operationToken: string;
  projectionSha256: string;
  fileKeysSha256: string;
  stagedFileKeys: readonly string[];
} {
  return value.version === 1 &&
    value.database === "shilian" &&
    isGenerationId(value.operationId) &&
    value.generationId === value.operationId &&
    typeof value.operationToken === "string" &&
    SHA256_PATTERN.test(value.operationToken) &&
    typeof value.projectionSha256 === "string" &&
    SHA256_PATTERN.test(value.projectionSha256) &&
    typeof value.fileKeysSha256 === "string" &&
    SHA256_PATTERN.test(value.fileKeysSha256) &&
    isStagedFileKeys(value.stagedFileKeys);
}

export function isFitnessPrepareRecoveryReceipt(
  value: unknown,
): value is FitnessPrepareRecoveryReceipt {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "database", "operationId", "generationId", "operationToken",
    "databaseSha256", "filesSha256", "projectionSha256", "fileKeysSha256",
    "preparedAt", "summary", "stagedFileKeys",
  ])) return false;
  return isPrepareReceiptCore(value) &&
    typeof value.databaseSha256 === "string" &&
    SHA256_PATTERN.test(value.databaseSha256) &&
    typeof value.filesSha256 === "string" &&
    SHA256_PATTERN.test(value.filesSha256) &&
    isCanonicalIsoTimestamp(value.preparedAt) &&
    isFitnessRestoreSummary(value.summary) &&
    value.summary.fileCount === value.stagedFileKeys.length;
}

export function isFitnessPrepareCleanupReceipt(
  value: unknown,
): value is FitnessPrepareCleanupReceipt {
  return isRecord(value) && hasExactKeys(value, [
    "version", "database", "operationId", "generationId", "operationToken",
    "projectionSha256", "fileKeysSha256", "stagedFileKeys",
  ]) && isPrepareReceiptCore(value);
}

export function isFitnessBackupRecoveryTicket(
  value: unknown,
): value is FitnessBackupRecoveryTicket {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isCanonicalIsoTimestamp(value.recordedAt)
  ) return false;
  if (value.kind === "prepare") {
    return hasExactKeys(value, ["version", "kind", "receipt", "recordedAt"]) &&
      isFitnessPrepareRecoveryReceipt(value.receipt);
  }
  if (value.kind === "prepare-cleanup") {
    return hasExactKeys(value, ["version", "kind", "receipt", "recordedAt"]) &&
      isFitnessPrepareCleanupReceipt(value.receipt);
  }
  if (value.kind === "refresh-only") {
    return hasExactKeys(value, ["version", "kind", "receipt", "recordedAt"]) &&
      isFitnessRestoreReceipt(value.receipt);
  }
  return value.kind === "candidate" &&
    hasExactKeys(value, ["version", "kind", "mode", "receipt", "recordedAt"]) &&
    (value.mode === "review" ||
      value.mode === "activation-check" ||
      value.mode === "discard-only") &&
    isFitnessRestoreReceipt(value.receipt);
}

export function fitnessBackupRecoveryIdentity(
  ticket: FitnessBackupRecoveryTicket,
): string {
  return `operation:${ticket.receipt.generationId}`;
}

export function fitnessBackupRecoveryStorageKey(
  ticket: FitnessBackupRecoveryTicket,
): string {
  return `${FITNESS_BACKUP_RECOVERY_PREFIX}${fitnessBackupRecoveryIdentity(ticket)}`;
}

export function retainFitnessBackupVolatileTransition(
  ticket: FitnessBackupRecoveryTicket,
  current: FitnessBackupVolatileTransition | null,
): FitnessBackupVolatileTransition {
  return {
    ticket,
    expected: current?.ticket.receipt.generationId ===
        ticket.receipt.generationId
      ? current.expected
      : null,
  };
}

export function fitnessBackupRecoveryPriority(
  ticket: FitnessBackupRecoveryTicket,
): number {
  if (ticket.kind === "refresh-only") return 0;
  if (ticket.kind === "candidate") {
    if (ticket.mode === "activation-check") return 1;
    if (ticket.mode === "discard-only") return 2;
    return 3;
  }
  return ticket.kind === "prepare-cleanup" ? 4 : 5;
}

export function readFitnessBackupRecoveryStorage(
  storage: StorageLike = window.localStorage,
): FitnessBackupRecoveryReadResult {
  const entries: FitnessBackupRecoveryEntry[] = [];
  const unreadableEntries: FitnessBackupUnreadableEntry[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const storageKey = storage.key(index);
      if (!storageKey?.startsWith(FITNESS_BACKUP_RECOVERY_PREFIX)) continue;
      let raw: string | null = null;
      try {
        raw = storage.getItem(storageKey);
        if (!raw || raw.length > FITNESS_BACKUP_RECOVERY_MAX_BYTES) {
          throw new Error("invalid recovery ticket size");
        }
        const parsed: unknown = JSON.parse(raw);
        if (!isFitnessBackupRecoveryTicket(parsed)) {
          throw new Error("invalid recovery ticket");
        }
        if (storageKey !== fitnessBackupRecoveryStorageKey(parsed)) {
          throw new Error("misbound recovery ticket");
        }
        entries.push({ storageKey, ticket: parsed, raw });
      } catch {
        unreadableEntries.push({ storageKey, raw });
      }
    }
  } catch {
    return { entries: [], unreadableEntries: [], storageUnavailable: true };
  }
  entries.sort((left, right) =>
    fitnessBackupRecoveryPriority(left.ticket) -
      fitnessBackupRecoveryPriority(right.ticket) ||
    left.ticket.recordedAt.localeCompare(right.ticket.recordedAt) ||
    left.storageKey.localeCompare(right.storageKey));
  unreadableEntries.sort((left, right) =>
    left.storageKey.localeCompare(right.storageKey));
  return { entries, unreadableEntries, storageUnavailable: false };
}

function defaultJournalRuntime(): FitnessBackupJournalRuntime {
  const locks = navigator.locks;
  if (!locks) throw new Error("browser locks unavailable");
  async function withExclusiveLock<T>(task: () => Promise<T>): Promise<T> {
    return await locks.request(
      FITNESS_BACKUP_JOURNAL_LOCK,
      { mode: "exclusive" },
      async () => await task(),
    );
  }
  return {
    storage: window.localStorage,
    withExclusiveLock,
  };
}

function serializeTicket(ticket: FitnessBackupRecoveryTicket): string {
  if (!isFitnessBackupRecoveryTicket(ticket)) {
    throw new Error("恢复继续信息无效，没有覆盖已有提醒。");
  }
  const serialized = JSON.stringify(ticket);
  if (serialized.length > FITNESS_BACKUP_RECOVERY_MAX_BYTES) {
    throw new Error("recovery ticket is too large");
  }
  return serialized;
}

function replaceEntryInStorage(
  storage: StorageLike,
  current: FitnessBackupRecoveryEntry | null,
  ticket: FitnessBackupRecoveryTicket,
): FitnessBackupRecoveryEntry {
  const storageKey = fitnessBackupRecoveryStorageKey(ticket);
  if (current && current.storageKey !== storageKey) {
    throw new Error("恢复继续信息不属于同一次操作，没有覆盖已有提醒。");
  }
  if (storage.getItem(storageKey) !== (current?.raw ?? null)) {
    throw new Error("另一页已经更新了这次恢复，没有沿用旧步骤。");
  }
  const raw = serializeTicket(ticket);
  storage.setItem(storageKey, raw);
  if (storage.getItem(storageKey) !== raw) {
    throw new Error("浏览器没有保留最新恢复继续信息。");
  }
  return { storageKey, ticket, raw };
}

function removeEntryFromStorage(
  storage: StorageLike,
  current: FitnessBackupRecoveryEntry,
): void {
  if (storage.getItem(current.storageKey) !== current.raw) {
    throw new Error("另一页已经更新了这次恢复，没有清除它的新提醒。");
  }
  storage.removeItem(current.storageKey);
  if (storage.getItem(current.storageKey) !== null) {
    throw new Error("浏览器暂时没有清除恢复提醒。");
  }
}

function recoveryLease(
  storage: StorageLike,
  initial: FitnessBackupRecoveryEntry | null,
): Readonly<{
  lease: FitnessBackupRecoveryLease;
  current(): FitnessBackupRecoveryEntry | null;
}> {
  let current = initial;
  return {
    lease: {
      current: () => current,
      replace(ticket) {
        current = replaceEntryInStorage(storage, current, ticket);
        return current;
      },
      remove() {
        if (!current) throw new Error("这次恢复提醒已经结束。");
        removeEntryFromStorage(storage, current);
        current = null;
      },
    },
    current: () => current,
  };
}

/**
 * Holds the one Fitness backup-journal lock across raw CAS, backend work and
 * the final ticket transition. A second tab can see the ticket, but cannot run
 * it until the first tab has settled and its old raw value will then be stale.
 */
export async function runWithCurrentFitnessBackupEntry<Result>(
  entry: FitnessBackupRecoveryEntry,
  operation: (lease: FitnessBackupRecoveryLease) => Result | Promise<Result>,
  runtime?: FitnessBackupJournalRuntime,
): Promise<FitnessBackupRecoveryRunResult<Result>> {
  const journal = runtime ?? defaultJournalRuntime();
  return journal.withExclusiveLock(async () => {
    const recoveries = readFitnessBackupRecoveryStorage(journal.storage);
    if (recoveries.storageUnavailable) {
      return { outcome: "unavailable" } as const;
    }
    if (recoveries.unreadableEntries.length > 0) {
      return { outcome: "blocked" } as const;
    }
    let currentRaw: string | null;
    try {
      currentRaw = journal.storage.getItem(entry.storageKey);
    } catch {
      return { outcome: "unavailable" } as const;
    }
    if (currentRaw !== entry.raw) {
      return { outcome: "stale" } as const;
    }
    const state = recoveryLease(journal.storage, entry);
    const value = await operation(state.lease);
    return { outcome: "ran", value, entry: state.current() } as const;
  });
}

/**
 * Serializes file selection and preparation with every existing recovery
 * action. The backend's awaited checkpoint callback writes through the lease,
 * so the lock is never released between checkpoint persistence and prepare
 * settlement.
 */
export async function runNewFitnessBackupRecovery<Result>(
  operation: (lease: FitnessBackupRecoveryLease) => Result | Promise<Result>,
  runtime?: FitnessBackupJournalRuntime,
): Promise<FitnessBackupNewRecoveryRunResult<Result>> {
  const journal = runtime ?? defaultJournalRuntime();
  return journal.withExclusiveLock(async () => {
    const existing = readFitnessBackupRecoveryStorage(journal.storage);
    if (
      existing.storageUnavailable ||
      existing.entries.length > 0 ||
      existing.unreadableEntries.length > 0
    ) return { outcome: "blocked" } as const;
    const state = recoveryLease(journal.storage, null);
    const value = await operation(state.lease);
    return { outcome: "ran", value, entry: state.current() } as const;
  });
}

export async function replaceFitnessBackupRecoveryTicket(
  ticket: FitnessBackupRecoveryTicket,
  expected: FitnessBackupRecoveryEntry | null,
  runtime?: FitnessBackupJournalRuntime,
): Promise<FitnessBackupJournalWriteResult> {
  try {
    const journal = runtime ?? defaultJournalRuntime();
    const storageKey = fitnessBackupRecoveryStorageKey(ticket);
    if (expected && expected.storageKey !== storageKey) return { outcome: "stale" };
    const serialized = serializeTicket(ticket);
    return await journal.withExclusiveLock(async () => {
      const current = journal.storage.getItem(storageKey);
      if (current !== (expected?.raw ?? null)) return { outcome: "stale" };
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

export async function checkFitnessBackupRecoveryEntry(
  entry: FitnessBackupRecoveryEntry,
  runtime?: FitnessBackupJournalRuntime,
): Promise<FitnessBackupJournalCheckResult> {
  try {
    const journal = runtime ?? defaultJournalRuntime();
    return await journal.withExclusiveLock(async () => ({
      outcome: journal.storage.getItem(entry.storageKey) === entry.raw
        ? "current"
        : "stale",
    }));
  } catch {
    return { outcome: "unavailable" };
  }
}

export async function removeFitnessBackupRecoveryEntry(
  entry: Pick<FitnessBackupRecoveryEntry, "storageKey" | "raw">,
  runtime?: FitnessBackupJournalRuntime,
): Promise<FitnessBackupJournalRemoveResult> {
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

/**
 * Reconciles the narrow case where a storage write may have succeeded but its
 * read-back acknowledgement was lost. It never calls a restore backend. A
 * valid same-operation peer is adopted; an absent key is safely recreated as
 * a reminder so a lost acknowledgement cannot permanently lock the UI.
 */
export async function reconcileFitnessBackupVolatileTransition(
  pending: FitnessBackupVolatileTransition,
  runtime?: FitnessBackupJournalRuntime,
): Promise<FitnessBackupVolatileReconcileResult> {
  try {
    const journal = runtime ?? defaultJournalRuntime();
    const storageKey = fitnessBackupRecoveryStorageKey(pending.ticket);
    const raw = serializeTicket(pending.ticket);
    return await journal.withExclusiveLock(async () => {
      const current = journal.storage.getItem(storageKey);
      if (current === raw) {
        return {
          outcome: "persisted",
          entry: { storageKey, raw, ticket: pending.ticket },
        } as const;
      }
      if (current === null || current === (pending.expected?.raw ?? null)) {
        journal.storage.setItem(storageKey, raw);
        if (journal.storage.getItem(storageKey) !== raw) {
          return { outcome: "unavailable" } as const;
        }
        return {
          outcome: "written",
          entry: { storageKey, raw, ticket: pending.ticket },
        } as const;
      }
      if (!current || current.length > FITNESS_BACKUP_RECOVERY_MAX_BYTES) {
        return { outcome: "conflict" } as const;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(current);
      } catch {
        return { outcome: "conflict" } as const;
      }
      if (
        !isFitnessBackupRecoveryTicket(parsed) ||
        fitnessBackupRecoveryStorageKey(parsed) !== storageKey
      ) return { outcome: "conflict" } as const;
      const isNoLessConservative =
        fitnessBackupRecoveryPriority(parsed) <=
          fitnessBackupRecoveryPriority(pending.ticket);
      if (!isNoLessConservative) {
        return { outcome: "conflict" } as const;
      }
      return {
        outcome: "adopted",
        entry: { storageKey, raw: current, ticket: parsed },
      } as const;
    });
  } catch {
    return { outcome: "unavailable" };
  }
}
