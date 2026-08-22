import type {
  VocabPrepareCleanupReceipt,
  VocabPrepareRecoveryReceipt,
  VocabRestoreReceipt,
  VocabRestoreSummary,
} from "@/lib/vocab/backup";

export const VOCAB_BACKUP_RECOVERY_PREFIX = "vocab.backup-recovery.v1:";
export const VOCAB_BACKUP_RECOVERY_MAX_BYTES = 256 * 1024;
export const VOCAB_BACKUP_JOURNAL_LOCK =
  "private-ai-suite:vocab:backup-recovery-journal";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SQLITE_IDENTITY_BYTES = 72;
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_AUDIO_COUNT = 1_000;
const VOCAB_APPLICATION_ID = 0x53484349;
const VOCAB_USER_VERSION = 2;

export type VocabBackupCandidateMode =
  | "review"
  | "activation-check"
  | "discard-only";

export type VocabBackupRecoveryTicket =
  | Readonly<{
      version: 1;
      kind: "prepare";
      receipt: VocabPrepareRecoveryReceipt;
      recordedAt: string;
    }>
  | Readonly<{
      version: 1;
      kind: "candidate";
      mode: VocabBackupCandidateMode;
      receipt: VocabRestoreReceipt;
      recordedAt: string;
    }>
  | Readonly<{
      version: 1;
      kind: "prepare-cleanup";
      receipt: VocabPrepareCleanupReceipt;
      recordedAt: string;
    }>
  | Readonly<{
      version: 1;
      kind: "refresh-only";
      receipt: VocabRestoreReceipt;
      recordedAt: string;
    }>;

export type VocabBackupRecoveryEntry = Readonly<{
  storageKey: string;
  ticket: VocabBackupRecoveryTicket;
  raw: string;
}>;

export type VocabBackupVolatileTransition = Readonly<{
  ticket: VocabBackupRecoveryTicket;
  expected: VocabBackupRecoveryEntry | null;
}>;

export type VocabBackupUnreadableEntry = Readonly<{
  storageKey: string;
  raw: string | null;
}>;

export type VocabBackupRecoveryReadResult = Readonly<{
  entries: readonly VocabBackupRecoveryEntry[];
  unreadableEntries: readonly VocabBackupUnreadableEntry[];
  storageUnavailable: boolean;
}>;

export function vocabBackupRecoveryRequiresOutboundBarrier(
  result: VocabBackupRecoveryReadResult,
): boolean {
  return result.storageUnavailable || result.unreadableEntries.length > 0 ||
    result.entries.some(({ ticket }) =>
      ticket.kind === "refresh-only" ||
      (ticket.kind === "candidate" && ticket.mode === "activation-check")
    );
}

type StorageLike = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;

export type VocabBackupJournalRuntime = Readonly<{
  storage: StorageLike;
  withExclusiveLock<T>(task: () => Promise<T>): Promise<T>;
}>;

export type VocabBackupJournalWriteResult =
  | Readonly<{ outcome: "written"; entry: VocabBackupRecoveryEntry }>
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "unavailable" }>;

export type VocabBackupJournalCheckResult =
  | Readonly<{ outcome: "current" }>
  | Readonly<{ outcome: "stale" }>
  | Readonly<{ outcome: "unavailable" }>;

export type VocabBackupJournalRemoveResult =
  | Readonly<{ outcome: "removed" }>
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

function isStagedAudioKeys(value: unknown): value is readonly string[] {
  return Array.isArray(value) &&
    value.length <= MAX_AUDIO_COUNT &&
    value.every((key) => typeof key === "string" && UUID_V4_PATTERN.test(key)) &&
    new Set(value).size === value.length;
}

export function isVocabRestoreSummary(
  value: unknown,
): value is VocabRestoreSummary {
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind", "fileName", "byteSize", "databaseByteSize", "exportedAt",
    "sourceUserVersion", "canonicalUserVersion", "audioCount",
    "itemCount", "lexemeCount", "verification",
  ])) return false;

  if (
    (value.kind !== "complete-backup" &&
      value.kind !== "legacy-vocab-sqlite") ||
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
    Number(value.sourceUserVersion) < 0 ||
    Number(value.sourceUserVersion) > VOCAB_USER_VERSION ||
    value.canonicalUserVersion !== VOCAB_USER_VERSION ||
    !Number.isSafeInteger(value.audioCount) ||
    Number(value.audioCount) < 0 ||
    Number(value.audioCount) > MAX_AUDIO_COUNT ||
    value.itemCount !== null ||
    value.lexemeCount !== null ||
    (value.verification !== "container-and-payload-verified" &&
      value.verification !== "vocab-schema-verified")
  ) return false;

  if (value.kind === "complete-backup") {
    return value.exportedAt !== null &&
      value.verification === "container-and-payload-verified";
  }
  return value.exportedAt === null &&
    value.audioCount === 0 &&
    value.byteSize === value.databaseByteSize &&
    value.verification === "vocab-schema-verified";
}

export function isVocabRestoreReceipt(
  value: unknown,
): value is VocabRestoreReceipt {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "database", "generationId", "activationToken",
    "recoveryToken", "expectedCurrentGenerationId",
    "expectedCurrentSequence", "canonicalApplicationId",
    "canonicalUserVersion", "projectionSha256", "preparedAt", "summary",
    "stagedAudioKeys",
  ])) return false;
  if (
    value.version !== 1 ||
    value.database !== "shici" ||
    !isGenerationId(value.generationId) ||
    typeof value.activationToken !== "string" ||
    !SHA256_PATTERN.test(value.activationToken) ||
    typeof value.recoveryToken !== "string" ||
    !SHA256_PATTERN.test(value.recoveryToken) ||
    !isGenerationId(value.expectedCurrentGenerationId, true) ||
    !Number.isSafeInteger(value.expectedCurrentSequence) ||
    Number(value.expectedCurrentSequence) < 0 ||
    value.canonicalApplicationId !== VOCAB_APPLICATION_ID ||
    value.canonicalUserVersion !== VOCAB_USER_VERSION ||
    typeof value.projectionSha256 !== "string" ||
    !SHA256_PATTERN.test(value.projectionSha256) ||
    !isCanonicalIsoTimestamp(value.preparedAt) ||
    !isVocabRestoreSummary(value.summary) ||
    !isStagedAudioKeys(value.stagedAudioKeys)
  ) return false;
  return value.summary.audioCount === value.stagedAudioKeys.length &&
    value.summary.canonicalUserVersion === value.canonicalUserVersion;
}

function isPrepareReceiptCore(
  value: Record<string, unknown>,
): value is Record<string, unknown> & {
  operationId: string;
  generationId: string;
  operationToken: string;
  projectionSha256: string;
  audioKeysSha256: string;
  stagedAudioKeys: readonly string[];
} {
  return value.version === 1 &&
    value.database === "shici" &&
    isGenerationId(value.operationId) &&
    value.generationId === value.operationId &&
    typeof value.operationToken === "string" &&
    SHA256_PATTERN.test(value.operationToken) &&
    typeof value.projectionSha256 === "string" &&
    SHA256_PATTERN.test(value.projectionSha256) &&
    typeof value.audioKeysSha256 === "string" &&
    SHA256_PATTERN.test(value.audioKeysSha256) &&
    isStagedAudioKeys(value.stagedAudioKeys);
}

export function isVocabPrepareRecoveryReceipt(
  value: unknown,
): value is VocabPrepareRecoveryReceipt {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "database", "operationId", "generationId", "operationToken",
    "projectionSha256", "audioKeysSha256", "preparedAt", "summary",
    "stagedAudioKeys",
  ])) return false;
  return isPrepareReceiptCore(value) &&
    isCanonicalIsoTimestamp(value.preparedAt) &&
    isVocabRestoreSummary(value.summary) &&
    value.summary.audioCount === value.stagedAudioKeys.length;
}

export function isVocabPrepareCleanupReceipt(
  value: unknown,
): value is VocabPrepareCleanupReceipt {
  return isRecord(value) && hasExactKeys(value, [
    "version", "database", "operationId", "generationId", "operationToken",
    "projectionSha256", "audioKeysSha256", "stagedAudioKeys",
  ]) && isPrepareReceiptCore(value);
}

export function isVocabBackupRecoveryTicket(
  value: unknown,
): value is VocabBackupRecoveryTicket {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isCanonicalIsoTimestamp(value.recordedAt)
  ) return false;
  if (value.kind === "prepare") {
    return hasExactKeys(value, ["version", "kind", "receipt", "recordedAt"]) &&
      isVocabPrepareRecoveryReceipt(value.receipt);
  }
  if (value.kind === "prepare-cleanup") {
    return hasExactKeys(value, ["version", "kind", "receipt", "recordedAt"]) &&
      isVocabPrepareCleanupReceipt(value.receipt);
  }
  if (value.kind === "refresh-only") {
    return hasExactKeys(value, ["version", "kind", "receipt", "recordedAt"]) &&
      isVocabRestoreReceipt(value.receipt);
  }
  return value.kind === "candidate" &&
    hasExactKeys(value, ["version", "kind", "mode", "receipt", "recordedAt"]) &&
    (value.mode === "review" ||
      value.mode === "activation-check" ||
      value.mode === "discard-only") &&
    isVocabRestoreReceipt(value.receipt);
}

export function vocabBackupRecoveryIdentity(
  ticket: VocabBackupRecoveryTicket,
): string {
  return `operation:${ticket.receipt.generationId}`;
}

export function vocabBackupRecoveryStorageKey(
  ticket: VocabBackupRecoveryTicket,
): string {
  return `${VOCAB_BACKUP_RECOVERY_PREFIX}${vocabBackupRecoveryIdentity(ticket)}`;
}

export function retainVocabBackupVolatileTransition(
  ticket: VocabBackupRecoveryTicket,
  current: VocabBackupVolatileTransition | null,
): VocabBackupVolatileTransition {
  return {
    ticket,
    expected: current?.ticket.receipt.generationId ===
        ticket.receipt.generationId
      ? current.expected
      : null,
  };
}

export function vocabBackupRecoveryPriority(
  ticket: VocabBackupRecoveryTicket,
): number {
  if (ticket.kind === "refresh-only") return 0;
  if (ticket.kind === "candidate") {
    if (ticket.mode === "activation-check") return 1;
    if (ticket.mode === "discard-only") return 2;
    return 3;
  }
  return ticket.kind === "prepare-cleanup" ? 4 : 5;
}

export function readVocabBackupRecoveryStorage(
  storage: StorageLike = window.localStorage,
): VocabBackupRecoveryReadResult {
  const entries: VocabBackupRecoveryEntry[] = [];
  const unreadableEntries: VocabBackupUnreadableEntry[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const storageKey = storage.key(index);
      if (!storageKey?.startsWith(VOCAB_BACKUP_RECOVERY_PREFIX)) continue;
      let raw: string | null = null;
      try {
        raw = storage.getItem(storageKey);
        if (!raw || raw.length > VOCAB_BACKUP_RECOVERY_MAX_BYTES) {
          throw new Error("invalid recovery ticket size");
        }
        const parsed: unknown = JSON.parse(raw);
        if (!isVocabBackupRecoveryTicket(parsed)) {
          throw new Error("invalid recovery ticket");
        }
        if (storageKey !== vocabBackupRecoveryStorageKey(parsed)) {
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
    vocabBackupRecoveryPriority(left.ticket) -
      vocabBackupRecoveryPriority(right.ticket) ||
    left.ticket.recordedAt.localeCompare(right.ticket.recordedAt) ||
    left.storageKey.localeCompare(right.storageKey));
  unreadableEntries.sort((left, right) =>
    left.storageKey.localeCompare(right.storageKey));
  return { entries, unreadableEntries, storageUnavailable: false };
}

function defaultJournalRuntime(): VocabBackupJournalRuntime {
  const locks = navigator.locks;
  if (!locks) throw new Error("browser locks unavailable");
  async function withExclusiveLock<T>(task: () => Promise<T>): Promise<T> {
    return await locks.request(
      VOCAB_BACKUP_JOURNAL_LOCK,
      { mode: "exclusive" },
      async () => await task(),
    );
  }
  return {
    storage: window.localStorage,
    withExclusiveLock,
  };
}

function serializeTicket(ticket: VocabBackupRecoveryTicket): string {
  const serialized = JSON.stringify(ticket);
  if (serialized.length > VOCAB_BACKUP_RECOVERY_MAX_BYTES) {
    throw new Error("recovery ticket is too large");
  }
  return serialized;
}

export async function replaceVocabBackupRecoveryTicket(
  ticket: VocabBackupRecoveryTicket,
  expected: VocabBackupRecoveryEntry | null,
  runtime?: VocabBackupJournalRuntime,
): Promise<VocabBackupJournalWriteResult> {
  try {
    const journal = runtime ?? defaultJournalRuntime();
    const storageKey = vocabBackupRecoveryStorageKey(ticket);
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

export async function checkVocabBackupRecoveryEntry(
  entry: VocabBackupRecoveryEntry,
  runtime?: VocabBackupJournalRuntime,
): Promise<VocabBackupJournalCheckResult> {
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

export async function removeVocabBackupRecoveryEntry(
  entry: Pick<VocabBackupRecoveryEntry, "storageKey" | "raw">,
  runtime?: VocabBackupJournalRuntime,
): Promise<VocabBackupJournalRemoveResult> {
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
