import {
  isCareerContactWriteReceipt,
  type CareerContactWriteReceipt,
} from "@/lib/career/contact-writes";
import {
  isCareerImportWriteReceipt,
  type CareerImportWriteReceipt,
} from "@/lib/career/import-writes";
import {
  isCareerMaterialFileCleanupReceipt,
  type CareerMaterialFileCleanupReceipt,
} from "@/lib/career/material-write-files";
import {
  isCareerMaterialWriteReceipt,
  type CareerMaterialCleanupPrepared,
  type CareerMaterialWriteReceipt,
} from "@/lib/career/material-writes";
import { isCareerWriteOperationId } from "@/lib/career/write-marker";
import {
  CAREER_CONTACT_IMPORT_MATERIAL_WRITE_MAX_BYTES,
  CAREER_CONTACT_IMPORT_MATERIAL_WRITE_PREFIX,
  CAREER_CORE_WRITE_JOURNAL_LOCK,
  CAREER_CORE_WRITE_MAX_CHARS,
  CAREER_CORE_WRITE_PREFIX,
  CAREER_LIFECYCLE_TASK_WRITE_MAX_BYTES,
  CAREER_LIFECYCLE_TASK_WRITE_PREFIX,
} from "./core-write-journal";

export {
  CAREER_CONTACT_IMPORT_MATERIAL_WRITE_PREFIX,
  CAREER_CORE_WRITE_PREFIX,
  CAREER_LIFECYCLE_TASK_WRITE_PREFIX,
};

export type CareerContactImportMaterialWriteReceipt =
  | CareerContactWriteReceipt
  | CareerImportWriteReceipt
  | CareerMaterialWriteReceipt;

export type CareerContactImportMaterialReceiptTicket = Readonly<{
  version: 1;
  kind: "check" | "committed" | "changed";
  receipt: CareerContactImportMaterialWriteReceipt;
  recordedAt: string;
}>;

/**
 * A save-attachment prepare callback persists this capability-only ticket
 * before the first OPFS byte is staged. It deliberately contains only the
 * opaque public handle; the private file key remains in the OPFS record.
 */
export type CareerMaterialCleanupWriteTicket = Readonly<{
  version: 1;
  kind: "material-cleanup";
  operationId: string;
  materialId: string;
  cleanupReceipt: CareerMaterialFileCleanupReceipt;
  recordedAt: string;
}>;

export type CareerContactImportMaterialWriteTicket =
  | CareerContactImportMaterialReceiptTicket
  | CareerMaterialCleanupWriteTicket;

export type CareerContactImportMaterialWriteEntry = Readonly<{
  storageKey: string;
  raw: string;
  ticket: CareerContactImportMaterialWriteTicket;
}>;

export type UnreadableCareerContactImportMaterialWrite = Readonly<{
  storageKey: string;
  raw: string;
}>;

export type CareerContactImportMaterialWriteJournal = Readonly<{
  entries: readonly CareerContactImportMaterialWriteEntry[];
  peerEntries: readonly Readonly<{ storageKey: string; raw: string }>[];
  unreadable: readonly UnreadableCareerContactImportMaterialWrite[];
  storageUnavailable: boolean;
  lockUnavailable: boolean;
}>;

export type CareerContactImportMaterialWriteStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;
export type CareerContactImportMaterialWriteLocks = Pick<LockManager, "request">;

export type CareerContactImportMaterialWriteLease = Readonly<{
  /** Persist a normal receipt before its first commit attempt. */
  checkpoint(
    receipt: CareerContactImportMaterialWriteReceipt,
  ): CareerContactImportMaterialWriteEntry;
  /** Persist the opaque cleanup handle before attachment staging starts. */
  checkpointCleanup(
    prepared: CareerMaterialCleanupPrepared,
  ): CareerContactImportMaterialWriteEntry;
  /** Raw-CAS replace the matching cleanup ticket with its full save receipt. */
  promote(
    receipt: CareerMaterialWriteReceipt,
  ): CareerContactImportMaterialWriteEntry;
  committed(): CareerContactImportMaterialWriteEntry;
  changed(): CareerContactImportMaterialWriteEntry;
  remove(): void;
}>;

export type CareerContactImportMaterialWriteRunResult<Result> =
  | Readonly<{ outcome: "stale" }>
  | Readonly<{
      outcome: "blocked";
      reason: "storage" | "unreadable" | "peer";
    }>
  | Readonly<{
      outcome: "ran";
      value: Result;
      entry: CareerContactImportMaterialWriteEntry | null;
    }>;

const UTF8_ENCODER = new TextEncoder();

function byteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

function exactKeys(value: object, wanted: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...wanted].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function canonicalIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length === 24 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function browserStorage(): CareerContactImportMaterialWriteStorage {
  if (typeof window === "undefined") {
    throw new Error("当前页面无法读取联系人/导入/材料核对线索；没有开始写入。");
  }
  return window.localStorage;
}

function browserLocks(): CareerContactImportMaterialWriteLocks | null {
  if (typeof navigator === "undefined") return null;
  return navigator.locks ?? null;
}

async function withJournalLock<Result>(
  locks: CareerContactImportMaterialWriteLocks | null,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  if (!locks) {
    throw new Error("当前浏览器无法跨页面锁定联系人/导入/材料核对线索；没有继续写入。");
  }
  return locks.request(CAREER_CORE_WRITE_JOURNAL_LOCK, operation);
}

export function isCareerContactImportMaterialWriteReceipt(
  value: unknown,
): value is CareerContactImportMaterialWriteReceipt {
  return isCareerContactWriteReceipt(value) ||
    isCareerImportWriteReceipt(value) ||
    isCareerMaterialWriteReceipt(value);
}

export function isCareerContactImportMaterialWriteTicket(
  value: unknown,
): value is CareerContactImportMaterialWriteTicket {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ticket = value as Record<string, unknown>;
  if (ticket.kind === "material-cleanup") {
    return exactKeys(value, [
      "version", "kind", "operationId", "materialId", "cleanupReceipt",
      "recordedAt",
    ]) && ticket.version === 1 &&
      isCareerWriteOperationId(ticket.operationId, "career-material-write") &&
      typeof ticket.materialId === "string" &&
      ticket.materialId.trim() === ticket.materialId &&
      ticket.materialId.length > 0 && ticket.materialId.length <= 240 &&
      isCareerMaterialFileCleanupReceipt(ticket.cleanupReceipt) &&
      canonicalIsoTimestamp(ticket.recordedAt);
  }
  return exactKeys(value, ["version", "kind", "receipt", "recordedAt"]) &&
    ticket.version === 1 &&
    (ticket.kind === "check" || ticket.kind === "committed" ||
      ticket.kind === "changed") &&
    isCareerContactImportMaterialWriteReceipt(ticket.receipt) &&
    canonicalIsoTimestamp(ticket.recordedAt);
}

function operationIdOf(
  ticket: CareerContactImportMaterialWriteTicket,
): string {
  return ticket.kind === "material-cleanup"
    ? ticket.operationId
    : ticket.receipt.operationId;
}

export function careerContactImportMaterialWriteKey(
  ticket: CareerContactImportMaterialWriteTicket,
): string {
  return `${CAREER_CONTACT_IMPORT_MATERIAL_WRITE_PREFIX}${operationIdOf(ticket)}`;
}

export function createCareerContactImportMaterialWriteTicket(
  receipt: CareerContactImportMaterialWriteReceipt,
  recordedAt = new Date().toISOString(),
): CareerContactImportMaterialReceiptTicket {
  const ticket = { version: 1, kind: "check", receipt, recordedAt } as const;
  if (!isCareerContactImportMaterialWriteTicket(ticket)) {
    throw new Error("联系人/导入/材料写入核对凭据无效；没有开始写入。");
  }
  return ticket;
}

export function createCareerMaterialCleanupWriteTicket(
  prepared: CareerMaterialCleanupPrepared,
  recordedAt = new Date().toISOString(),
): CareerMaterialCleanupWriteTicket {
  const ticket = {
    version: 1,
    kind: "material-cleanup",
    operationId: prepared.operationId,
    materialId: prepared.materialId,
    cleanupReceipt: prepared.cleanupReceipt,
    recordedAt,
  } as const;
  if (!isCareerContactImportMaterialWriteTicket(ticket) ||
    ticket.kind !== "material-cleanup") {
    throw new Error("材料附件清理凭据无效；没有开始文件写入。");
  }
  return ticket;
}

export function createCareerContactImportMaterialWriteEntry(
  ticket: CareerContactImportMaterialWriteTicket,
): CareerContactImportMaterialWriteEntry {
  if (!isCareerContactImportMaterialWriteTicket(ticket)) {
    throw new Error("联系人/导入/材料写入核对凭据无效；没有开始写入。");
  }
  const raw = JSON.stringify(ticket);
  if (byteLength(raw) > CAREER_CONTACT_IMPORT_MATERIAL_WRITE_MAX_BYTES) {
    throw new Error("这次联系人/导入/材料写入过大，无法安全保留核对线索；没有开始写入。");
  }
  return {
    storageKey: careerContactImportMaterialWriteKey(ticket),
    raw,
    ticket,
  };
}

export function readCareerContactImportMaterialWriteJournal(
  storage: CareerContactImportMaterialWriteStorage = browserStorage(),
  locks: CareerContactImportMaterialWriteLocks | null = browserLocks(),
): CareerContactImportMaterialWriteJournal {
  const entries: CareerContactImportMaterialWriteEntry[] = [];
  const peerEntries: Array<{ storageKey: string; raw: string }> = [];
  const unreadable: UnreadableCareerContactImportMaterialWrite[] = [];
  try {
    const length = storage.length;
    const seen = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      const storageKey = storage.key(index);
      if (storageKey === null || seen.has(storageKey)) {
        throw new Error("unstable storage enumeration");
      }
      seen.add(storageKey);
      const own = storageKey.startsWith(
        CAREER_CONTACT_IMPORT_MATERIAL_WRITE_PREFIX,
      );
      const corePeer = storageKey.startsWith(CAREER_CORE_WRITE_PREFIX);
      const lifecyclePeer = storageKey.startsWith(
        CAREER_LIFECYCLE_TASK_WRITE_PREFIX,
      );
      if (!own && !corePeer && !lifecyclePeer) continue;
      let raw = "";
      try {
        raw = storage.getItem(storageKey) ?? "";
        if (corePeer || lifecyclePeer) {
          const invalidSize = corePeer
            ? raw.length > CAREER_CORE_WRITE_MAX_CHARS
            : byteLength(raw) > CAREER_LIFECYCLE_TASK_WRITE_MAX_BYTES;
          if (!raw || invalidSize) throw new Error("invalid peer size");
          peerEntries.push({ storageKey, raw });
          continue;
        }
        if (!raw ||
          byteLength(raw) > CAREER_CONTACT_IMPORT_MATERIAL_WRITE_MAX_BYTES) {
          throw new Error("invalid ticket size");
        }
        const parsed: unknown = JSON.parse(raw);
        if (!isCareerContactImportMaterialWriteTicket(parsed) ||
          careerContactImportMaterialWriteKey(parsed) !== storageKey) {
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
  peerEntries.sort((left, right) =>
    left.storageKey.localeCompare(right.storageKey));
  unreadable.sort((left, right) =>
    left.storageKey.localeCompare(right.storageKey));
  return {
    entries,
    peerEntries,
    unreadable,
    storageUnavailable: false,
    lockUnavailable: !locks,
  };
}

function persistRaw(
  storage: CareerContactImportMaterialWriteStorage,
  ticket: CareerContactImportMaterialWriteTicket,
): CareerContactImportMaterialWriteEntry {
  const entry = createCareerContactImportMaterialWriteEntry(ticket);
  const current = storage.getItem(entry.storageKey);
  if (current !== null && current !== entry.raw) {
    throw new Error("另一页保留了同一动作的不同核对线索；没有继续写入。");
  }
  storage.setItem(entry.storageKey, entry.raw);
  if (storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error("浏览器没有确认保留联系人/导入/材料核对线索；没有继续写入。");
  }
  return entry;
}

function replaceRaw(
  storage: CareerContactImportMaterialWriteStorage,
  entry: CareerContactImportMaterialWriteEntry,
  ticket: CareerContactImportMaterialWriteTicket,
): CareerContactImportMaterialWriteEntry {
  if (careerContactImportMaterialWriteKey(ticket) !== entry.storageKey ||
    storage.getItem(entry.storageKey) !== entry.raw) {
    throw new Error("另一页已经处理了这条核对线索。");
  }
  const next = createCareerContactImportMaterialWriteEntry(ticket);
  storage.setItem(next.storageKey, next.raw);
  if (storage.getItem(next.storageKey) !== next.raw) {
    throw new Error("浏览器没有确认保留最新核对线索。");
  }
  return next;
}

function removeRaw(
  storage: CareerContactImportMaterialWriteStorage,
  entry: Pick<CareerContactImportMaterialWriteEntry, "storageKey" | "raw">,
): boolean {
  const current = storage.getItem(entry.storageKey);
  if (current === null) return true;
  if (current !== entry.raw) return false;
  storage.removeItem(entry.storageKey);
  return storage.getItem(entry.storageKey) !== entry.raw;
}

function sameCleanupReceipt(
  left: CareerMaterialFileCleanupReceipt,
  right: CareerMaterialFileCleanupReceipt,
): boolean {
  return left.purpose === right.purpose && left.version === right.version &&
    left.handle === right.handle;
}

function leaseFor(
  storage: CareerContactImportMaterialWriteStorage,
  initial: CareerContactImportMaterialWriteEntry | null,
): Readonly<{
  lease: CareerContactImportMaterialWriteLease;
  current: () => CareerContactImportMaterialWriteEntry | null;
}> {
  let current = initial;
  const requireCurrent = (): CareerContactImportMaterialWriteEntry => {
    if (!current) throw new Error("核对线索尚未建立或已经结束。");
    return current;
  };
  return {
    lease: {
      checkpoint(receipt) {
        if (current) throw new Error("核对线索已经建立，不能覆盖为另一条回执。");
        current = persistRaw(
          storage,
          createCareerContactImportMaterialWriteTicket(receipt),
        );
        return current;
      },
      checkpointCleanup(prepared) {
        if (current) throw new Error("核对线索已经建立，不能覆盖为另一条清理凭据。");
        current = persistRaw(
          storage,
          createCareerMaterialCleanupWriteTicket(prepared),
        );
        return current;
      },
      promote(receipt) {
        const existing = requireCurrent();
        if (existing.ticket.kind !== "material-cleanup" ||
          receipt.kind !== "material-save" ||
          receipt.operationId !== existing.ticket.operationId ||
          receipt.after.material.id !== existing.ticket.materialId ||
          !receipt.after.cleanupReceipt ||
          !sameCleanupReceipt(
            receipt.after.cleanupReceipt,
            existing.ticket.cleanupReceipt,
          )) {
          throw new Error("材料回执与已持久化的清理能力不一致。");
        }
        const next = createCareerContactImportMaterialWriteTicket(
          receipt,
          existing.ticket.recordedAt,
        );
        current = replaceRaw(storage, existing, next);
        return current;
      },
      committed() {
        const existing = requireCurrent();
        if (existing.ticket.kind === "material-cleanup") {
          throw new Error("附件清理线索不能标记为数据库已提交。");
        }
        current = replaceRaw(storage, existing, {
          ...existing.ticket,
          kind: "committed",
        });
        return current;
      },
      changed() {
        const existing = requireCurrent();
        if (existing.ticket.kind === "material-cleanup") {
          throw new Error("附件清理线索不能标记为数据已变化。");
        }
        current = replaceRaw(storage, existing, {
          ...existing.ticket,
          kind: "changed",
        });
        return current;
      },
      remove() {
        const existing = requireCurrent();
        if (!removeRaw(storage, existing)) {
          throw new Error("另一页已经处理了这条核对线索。");
        }
        current = null;
      },
    },
    current: () => current,
  };
}

function journalBlocked(
  journal: CareerContactImportMaterialWriteJournal,
): "storage" | "unreadable" | "peer" | null {
  if (journal.storageUnavailable) return "storage";
  if (journal.unreadable.length > 0) return "unreadable";
  if (journal.entries.length > 0 || journal.peerEntries.length > 0) {
    return "peer";
  }
  return null;
}

/**
 * Acquires the same journal Web Lock as the other Career flows, full-scans all
 * three namespaces, and keeps the lease across prepare, raw-CAS checkpoint,
 * and commit. Material save prepare callbacks must call checkpointCleanup
 * directly on this lease; they must never acquire a nested journal lock.
 */
export async function runWithEmptyCareerContactImportMaterialWrite<Result>(
  operation: (
    lease: CareerContactImportMaterialWriteLease,
  ) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: CareerContactImportMaterialWriteStorage;
    locks?: CareerContactImportMaterialWriteLocks | null;
  }>,
): Promise<CareerContactImportMaterialWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options
    ? options.locks ?? null
    : browserLocks();
  return withJournalLock(locks, async () => {
    const journal = readCareerContactImportMaterialWriteJournal(storage, locks);
    const blocked = journalBlocked(journal);
    if (blocked) return { outcome: "blocked", reason: blocked } as const;
    const holder = leaseFor(storage, null);
    const value = await operation(holder.lease);
    return { outcome: "ran", value, entry: holder.current() } as const;
  });
}

export async function runWithCurrentCareerContactImportMaterialWrite<Result>(
  entry: CareerContactImportMaterialWriteEntry,
  operation: (
    lease: CareerContactImportMaterialWriteLease,
  ) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: CareerContactImportMaterialWriteStorage;
    locks?: CareerContactImportMaterialWriteLocks | null;
  }>,
): Promise<CareerContactImportMaterialWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options
    ? options.locks ?? null
    : browserLocks();
  return withJournalLock(locks, async () => {
    const journal = readCareerContactImportMaterialWriteJournal(storage, locks);
    if (journal.storageUnavailable) {
      return { outcome: "blocked", reason: "storage" } as const;
    }
    if (journal.unreadable.length > 0) {
      return { outcome: "blocked", reason: "unreadable" } as const;
    }
    const exact = journal.entries.find((candidate) =>
      candidate.storageKey === entry.storageKey);
    let rawNow: string | null;
    try {
      rawNow = storage.getItem(entry.storageKey);
    } catch {
      return { outcome: "blocked", reason: "storage" } as const;
    }
    if (!exact || exact.raw !== entry.raw || rawNow !== entry.raw) {
      return { outcome: "stale" } as const;
    }
    if (journal.entries.length !== 1 || journal.peerEntries.length > 0) {
      return { outcome: "blocked", reason: "peer" } as const;
    }
    const holder = leaseFor(storage, exact);
    const value = await operation(holder.lease);
    return { outcome: "ran", value, entry: holder.current() } as const;
  });
}

export async function runWithMissingCareerContactImportMaterialWrite<Result>(
  held: CareerContactImportMaterialWriteEntry,
  operation: (
    lease: CareerContactImportMaterialWriteLease,
  ) => Result | Promise<Result>,
  options?: Readonly<{
    storage?: CareerContactImportMaterialWriteStorage;
    locks?: CareerContactImportMaterialWriteLocks | null;
  }>,
): Promise<CareerContactImportMaterialWriteRunResult<Result>> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options
    ? options.locks ?? null
    : browserLocks();
  return withJournalLock(locks, async () => {
    const journal = readCareerContactImportMaterialWriteJournal(storage, locks);
    const blocked = journalBlocked(journal);
    if (blocked) {
      if (blocked === "peer" && journal.entries.length === 0 &&
        journal.peerEntries.length === 0) {
        return { outcome: "stale" } as const;
      }
      return { outcome: "blocked", reason: blocked } as const;
    }
    let rawNow: string | null;
    try {
      rawNow = storage.getItem(held.storageKey);
    } catch {
      return { outcome: "blocked", reason: "storage" } as const;
    }
    if (rawNow !== null) return { outcome: "stale" } as const;
    const checkpointTicket: CareerContactImportMaterialWriteTicket =
      held.ticket.kind === "material-cleanup"
        ? held.ticket
        : { ...held.ticket, kind: "check" };
    const checkpoint = persistRaw(storage, checkpointTicket);
    const holder = leaseFor(storage, checkpoint);
    const value = await operation(holder.lease);
    return { outcome: "ran", value, entry: holder.current() } as const;
  });
}

export async function removeUnreadableCareerContactImportMaterialWrite(
  entry: UnreadableCareerContactImportMaterialWrite,
  options?: Readonly<{
    storage?: CareerContactImportMaterialWriteStorage;
    locks?: CareerContactImportMaterialWriteLocks | null;
  }>,
): Promise<boolean> {
  const storage = options?.storage ?? browserStorage();
  const locks = options && "locks" in options
    ? options.locks ?? null
    : browserLocks();
  return withJournalLock(locks, () => {
    const journal = readCareerContactImportMaterialWriteJournal(storage, locks);
    if (journal.storageUnavailable) return false;
    const exact = journal.unreadable.find((candidate) =>
      candidate.storageKey === entry.storageKey && candidate.raw === entry.raw);
    return exact ? removeRaw(storage, exact) : false;
  });
}

export function careerContactImportMaterialHeldBarrier(
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
