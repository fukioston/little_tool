import type {
  VocabItemWriteReceipt,
  VocabItemWriteSnapshot,
} from "@/lib/vocab/store";
import type { LibraryItem } from "@/lib/vocab/types";

export type VocabItemExpectedMap = ReadonlyMap<string, VocabItemWriteSnapshot>;

export type VocabItemCheckpointCandidate = Readonly<{
  itemId: string;
  progress: number;
  expected: VocabItemWriteSnapshot;
  revision: number;
}>;

export type VocabItemRefreshProtection = Readonly<{
  receipt: VocabItemWriteReceipt;
  mode: "before-only" | "after-only" | "any";
  submittedRevision: number | null;
}>;

export function coalesceVocabItemCheckpointSample(
  current: VocabItemCheckpointCandidate | undefined,
  expected: VocabItemWriteSnapshot,
  progress: number,
  revision: number,
  submittedCheckpointInFlight = false,
): VocabItemCheckpointCandidate | null {
  const nextProgress = Math.max(0, Math.min(0.99, progress));
  if (Math.abs(nextProgress - expected.item.progress) < 0.005) {
    if (submittedCheckpointInFlight) {
      return {
        itemId: expected.item.id,
        progress: nextProgress,
        expected,
        revision,
      };
    }
    return current && !sameVocabItemExpected(current.expected, expected)
      ? current
      : null;
  }
  return {
    itemId: expected.item.id,
    progress: nextProgress,
    expected,
    revision,
  };
}

export function shouldReportVocabReaderProgress(
  fromEnabledScrollListener: boolean,
  progress: number,
  lastReportedProgress: number,
): boolean {
  return fromEnabledScrollListener &&
    Math.abs(progress - lastReportedProgress) >= 0.02;
}

export function vocabPodcastSeekShouldReport(
  source: "explicit-user" | "slider-input" | "metadata-restore",
): boolean {
  return source !== "metadata-restore";
}

export function vocabPodcastSnapshotPositionMode(
  displayedItemChanged: boolean,
  playbackPaused: boolean,
): "none" | "sync-baseline" | "keep-active" {
  if (!displayedItemChanged) return "none";
  return playbackPaused ? "sync-baseline" : "keep-active";
}

export function vocabPodcastPositionCanReport(
  hasLocalPositionActivity: boolean,
  terminalIntent: boolean,
  ended: boolean,
  status: LibraryItem["status"],
): boolean {
  return hasLocalPositionActivity && !terminalIntent && !ended &&
    status !== "complete" && status !== "archived";
}

export function vocabPodcastPositionReportChanged(
  last: Readonly<{ item: LibraryItem; progress: number }> | null,
  item: LibraryItem,
  progress: number,
): boolean {
  return last?.item !== item || Math.abs(last.progress - progress) >= 0.0001;
}

export function vocabPodcastCompleteActionEnabled(
  status: LibraryItem["status"],
  itemWriteLocked: boolean,
  itemWriteBusy: boolean,
): boolean {
  return status !== "complete" && status !== "archived" &&
    !itemWriteLocked && !itemWriteBusy;
}

export function firstVocabItemRecoveryFocusTarget<T>(
  candidates: readonly (T | null | undefined)[],
  usable: (candidate: T) => boolean,
): T | null {
  return candidates.find((candidate): candidate is T =>
    candidate != null && usable(candidate)
  ) ?? null;
}

export function vocabItemLifecycleDisplayBound(
  expected: VocabItemWriteSnapshot | null | undefined,
  displayedItem: LibraryItem,
): expected is VocabItemWriteSnapshot {
  return expected?.item === displayedItem;
}

export function vocabItemExitDecision(
  busy: boolean,
  hasVolatileCheckpoint: boolean,
): "block" | "confirm" | "leave" {
  if (busy) return "block";
  if (hasVolatileCheckpoint) return "confirm";
  return "leave";
}

export function vocabItemHistoryBackDecision(
  busy: boolean,
  hasVolatileCheckpoint: boolean,
): "restore-block" | "restore-confirm" | "continue" {
  const decision = vocabItemExitDecision(busy, hasVolatileCheckpoint);
  if (decision === "block") return "restore-block";
  if (decision === "confirm") return "restore-confirm";
  return "continue";
}

export function vocabItemCheckpointSchedulingOpen(input: Readonly<{
  dirtyCount: number;
  operationInProgress: boolean;
  journalLoaded: boolean;
  externalWriteLocked: boolean;
  storageUnavailable: boolean;
  lockUnavailable: boolean;
  unreadableCount: number;
  entryCount: number;
  allDirtyItemsPaused: boolean;
}>): boolean {
  return input.dirtyCount > 0 && !input.operationInProgress &&
    input.journalLoaded && !input.externalWriteLocked &&
    !input.storageUnavailable && !input.lockUnavailable &&
    input.unreadableCount === 0 && input.entryCount === 0 &&
    !input.allDirtyItemsPaused;
}

export function vocabItemExplicitDiscardGateItemIds(
  capturedItemIds: ReadonlySet<string>,
  currentDirty: ReadonlyMap<string, VocabItemCheckpointCandidate>,
): ReadonlySet<string> {
  return new Set([
    ...capturedItemIds,
    ...currentDirty.keys(),
  ]);
}

export function vocabItemHeldReceiptBarrier(
  heldOperationId: string | null,
  durableOperationIds: Iterable<string>,
): Readonly<{ blocksWrites: boolean; volatile: boolean }> {
  if (!heldOperationId) return { blocksWrites: false, volatile: false };
  const durable = new Set(durableOperationIds).has(heldOperationId);
  return { blocksWrites: true, volatile: !durable };
}

const ITEM_KEYS = [
  "id", "kind", "title", "description", "source", "source_url", "author",
  "published_at", "duration_ms", "audio_url", "status", "progress",
  "created_at", "updated_at",
] as const;

export function sameVocabLibraryItemFacts(
  left: LibraryItem | null | undefined,
  right: LibraryItem | null | undefined,
): boolean {
  return Boolean(left && right &&
    ITEM_KEYS.every((key) => left[key] === right[key]));
}

export function sameVocabItemExpected(
  left: VocabItemWriteSnapshot | undefined | null,
  right: VocabItemWriteSnapshot,
): boolean {
  return Boolean(left &&
    left.generationId === right.generationId &&
    left.generationSequence === right.generationSequence &&
    sameVocabLibraryItemFacts(left.item, right.item));
}

export function vocabItemCandidateMatchesSubmission(
  current: VocabItemCheckpointCandidate | undefined,
  submitted: VocabItemCheckpointCandidate,
): boolean {
  return Boolean(current && current.itemId === submitted.itemId &&
    current.revision === submitted.revision &&
    current.progress === submitted.progress &&
    sameVocabItemExpected(current.expected, submitted.expected));
}

export function vocabItemBundleShouldDefer(
  next: VocabItemExpectedMap,
  dirty: ReadonlyMap<string, VocabItemCheckpointCandidate>,
  protection: VocabItemRefreshProtection | null,
  explicitlyDiscardedItemIds: ReadonlySet<string> | null = null,
): boolean {
  if (protection?.mode === "before-only" && !sameVocabItemExpected(
    next.get(protection.receipt.before.item.id),
    protection.receipt.before,
  )) return true;
  for (const candidate of dirty.values()) {
    if (explicitlyDiscardedItemIds?.has(candidate.itemId)) continue;
    if (
      protection?.mode === "after-only" &&
      protection.receipt.kind !== "progress-checkpoint" &&
      candidate.itemId === protection.receipt.before.item.id &&
      sameVocabItemExpected(candidate.expected, protection.receipt.before) &&
      sameVocabItemExpected(
        next.get(candidate.itemId),
        protection.receipt.after,
      )
    ) continue;
    if (
      protection?.mode === "after-only" &&
      candidate.itemId === protection.receipt.before.item.id &&
      protection.receipt.kind === "progress-checkpoint" &&
      (protection.submittedRevision === null ||
        candidate.revision > protection.submittedRevision) &&
      sameVocabItemExpected(candidate.expected, protection.receipt.before)
    ) {
      if (!sameVocabItemExpected(
        next.get(candidate.itemId),
        protection.receipt.after,
      )) return true;
      continue;
    }
    if (protection?.mode === "any" &&
        candidate.itemId === protection.receipt.before.item.id) continue;
    if (!sameVocabItemExpected(
      next.get(candidate.itemId),
      candidate.expected,
    )) return true;
  }
  return false;
}

export function reconcileVocabItemCheckpointAfterApplied(
  candidate: VocabItemCheckpointCandidate | undefined,
  receipt: VocabItemWriteReceipt,
  submittedRevision: number | null,
  current: VocabItemWriteSnapshot | null,
): VocabItemCheckpointCandidate | null {
  if (!candidate) return null;
  if (
    current &&
    sameVocabItemExpected(current, receipt.after) &&
    sameVocabItemExpected(candidate.expected, receipt.after) &&
    current.item.status !== "complete" && current.item.status !== "archived"
  ) return candidate;
  if (
    receipt.kind === "progress-checkpoint" && current &&
    sameVocabItemExpected(current, receipt.after) &&
    sameVocabItemExpected(candidate.expected, receipt.before) &&
    Math.abs(candidate.progress - current.item.progress) < 0.005
  ) return null;
  if (
    receipt.kind === "progress-checkpoint" && current &&
    sameVocabItemExpected(current, receipt.after) &&
    sameVocabItemExpected(candidate.expected, receipt.before) &&
    (submittedRevision === null || candidate.revision > submittedRevision) &&
    current.item.status !== "complete" && current.item.status !== "archived"
  ) return { ...candidate, expected: current };
  return null;
}

export function vocabItemArchiveCheckpointGate(
  hasDirty: boolean,
  flushOutcome: "saved" | "blocked" | "none",
  conflicted = false,
): "archive" | "stop-saved" | "stop-blocked" {
  if (!hasDirty) return "archive";
  if (conflicted) return "stop-blocked";
  return flushOutcome === "saved" ? "stop-saved" : "stop-blocked";
}

export function vocabItemWritePreflightOpen(
  journal: Readonly<{
    loaded: boolean;
    storageUnavailable: boolean;
    lockUnavailable: boolean;
    entryCount: number;
    unreadableCount: number;
  }>,
  externalWriteLocked: boolean,
  itemConflict = false,
): boolean {
  return journal.loaded && !journal.storageUnavailable &&
    !journal.lockUnavailable && journal.entryCount === 0 &&
    journal.unreadableCount === 0 && !externalWriteLocked && !itemConflict;
}

export function vocabItemExpectedContinuationOpen(input: Readonly<{
  externalWriteLocked: boolean;
  hasConflict: boolean;
  storageUnavailable: boolean;
  lockUnavailable: boolean;
  unreadableCount: number;
  selectedReceiptMatches: boolean;
}>): boolean {
  return !input.externalWriteLocked && !input.hasConflict &&
    !input.storageUnavailable && !input.lockUnavailable &&
    input.unreadableCount === 0 && input.selectedReceiptMatches;
}

export function vocabItemJournalFailureRecoveryPhase(
  action: "discard-expected",
): "expected";
export function vocabItemJournalFailureRecoveryPhase(
  action: "dismiss-invalid",
): "invalid";
export function vocabItemJournalFailureRecoveryPhase(
  action: "clear-unreadable",
  hasHeldReceipt?: boolean,
): "check" | "idle";
export function vocabItemJournalFailureRecoveryPhase(
  action: "discard-expected" | "dismiss-invalid" | "clear-unreadable",
  hasHeldReceipt = false,
): "expected" | "invalid" | "check" | "idle" {
  if (action === "discard-expected") return "expected";
  if (action === "dismiss-invalid") return "invalid";
  return hasHeldReceipt ? "check" : "idle";
}

export function resolveVocabItemChangedRefreshCandidate(
  discardedAtClick: VocabItemCheckpointCandidate | null,
  current: VocabItemCheckpointCandidate | undefined,
  refreshApplied: boolean,
): Readonly<{ discardRevision: number | null; keepAsConflict: boolean }> {
  if (!refreshApplied) return { discardRevision: null, keepAsConflict: false };
  if (
    discardedAtClick &&
    vocabItemCandidateMatchesSubmission(current, discardedAtClick)
  ) {
    return {
      discardRevision: discardedAtClick.revision,
      keepAsConflict: false,
    };
  }
  return { discardRevision: null, keepAsConflict: Boolean(current) };
}

export function resolveVocabItemExplicitConflictRefresh(
  captured: VocabItemCheckpointCandidate | null,
  current: VocabItemCheckpointCandidate | undefined,
  refreshApplied: boolean,
): Readonly<{
  discardRevision: number | null;
  keepConflict: boolean;
  clearConflict: boolean;
}> {
  if (!refreshApplied) {
    return {
      discardRevision: null,
      keepConflict: true,
      clearConflict: false,
    };
  }
  if (captured && vocabItemCandidateMatchesSubmission(current, captured)) {
    return {
      discardRevision: captured.revision,
      keepConflict: false,
      clearConflict: true,
    };
  }
  if (current) {
    return {
      discardRevision: null,
      keepConflict: true,
      clearConflict: false,
    };
  }
  return {
    discardRevision: null,
    keepConflict: false,
    clearConflict: true,
  };
}
