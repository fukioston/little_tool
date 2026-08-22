"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  commitVocabItemWrite,
  inspectVocabItemWrite,
  prepareVocabItemArchive,
  prepareVocabItemComplete,
  prepareVocabItemProgressCheckpoint,
  prepareVocabItemRestore,
  VocabItemMutationError,
  type VocabItemWriteKind,
  type VocabItemWriteReceipt,
  type VocabItemWriteSnapshot,
} from "@/lib/vocab/store";
import type { LibraryItem } from "@/lib/vocab/types";
import {
  VOCAB_ITEM_WRITE_PREFIX,
  claimVocabItemWrite,
  createVocabItemWriteEntry,
  createVocabItemWriteTicket,
  persistVocabItemWrite,
  readVocabItemWriteJournal,
  releaseVocabItemWrite,
  removeUnreadableVocabItemWrite,
  runWithCurrentVocabItemWrite,
  runWithMissingVocabItemWrite,
  selectVocabItemWriteRecoveryEntry,
  type VocabItemWriteEntry,
  type VocabItemWriteJournal,
  type VocabItemWriteLease,
  type VocabItemWriteToken,
} from "./item-write-journal";
import {
  coalesceVocabItemCheckpointSample,
  reconcileVocabItemCheckpointAfterApplied,
  resolveVocabItemExplicitConflictRefresh,
  sameVocabItemExpected,
  vocabItemArchiveCheckpointGate,
  vocabItemBundleShouldDefer,
  vocabItemCandidateMatchesSubmission,
  vocabItemCheckpointSchedulingOpen,
  vocabItemExplicitDiscardGateItemIds,
  vocabItemExpectedContinuationOpen,
  vocabItemHeldReceiptBarrier,
  vocabItemJournalFailureRecoveryPhase,
  vocabItemLifecycleDisplayBound,
  vocabItemWritePreflightOpen,
  type VocabItemCheckpointCandidate,
  type VocabItemExpectedMap,
  type VocabItemRefreshProtection,
} from "./item-write-state";

export type { VocabItemExpectedMap } from "./item-write-state";
export type VocabItemRefreshOutcome = "applied" | "deferred" | "superseded";
type LifecycleKind = Exclude<VocabItemWriteKind, "progress-checkpoint">;
type WorkingAction = "prepare" | "commit" | "inspect" | "refresh" | "journal";

type JournalView = VocabItemWriteJournal & Readonly<{ loaded: boolean }>;
type Flow =
  | Readonly<{ phase: "idle" }>
  | Readonly<{
      phase: "working";
      action: WorkingAction;
      itemId: string | null;
      background: boolean;
    }>
  | Readonly<{
      phase: "check" | "expected" | "changed" | "refresh-only" | "invalid";
      entry: VocabItemWriteEntry;
      message: string;
    }>;

const EMPTY_JOURNAL: JournalView = {
  loaded: false,
  entries: [],
  unreadable: [],
  storageUnavailable: false,
  lockUnavailable: false,
};

function reasonMessage(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : "条目操作没有完成；现有资料没有被静默覆盖。";
}

function savedCopy(receipt: VocabItemWriteReceipt): string {
  if (receipt.kind === "complete") return "已确认标记为完成。";
  if (receipt.kind === "archive") return "已确认移入归档。";
  if (receipt.kind === "restore") return "已确认恢复到资料库。";
  return "阅读位置已经安全保存在当前浏览器。";
}

function phaseForEntry(entry: VocabItemWriteEntry): Flow {
  if (entry.ticket.kind === "committed") {
    return {
      phase: "refresh-only",
      entry,
      message: `${savedCopy(entry.ticket.receipt)} 这里只先只读核对，再重新读取页面；不会再次写入。`,
    };
  }
  if (entry.ticket.kind === "changed") {
    return {
      phase: "changed",
      entry,
      message: "这个条目已经变化；旧内容不会覆盖新内容，只能重新读取后清除提醒。",
    };
  }
  return {
    phase: "check",
    entry,
    message: "这次条目写入结果还没有确认。先只读核对，不会重复写入。",
  };
}

function lifecycleLabel(kind: LifecycleKind): string {
  if (kind === "complete") return "标记完成";
  if (kind === "archive") return "移入归档";
  return "恢复到资料库";
}

export function useVocabItemWriteFlow({
  refresh,
  getExpected,
  externalWriteLocked,
  externalWriteInProgress,
  onToast,
  onAttention,
}: {
  refresh: () => Promise<VocabItemRefreshOutcome>;
  getExpected: (itemId: string) => VocabItemWriteSnapshot | null;
  externalWriteLocked: boolean;
  externalWriteInProgress: () => boolean;
  onToast: (message: string) => void;
  onAttention: (background: boolean) => void;
}) {
  const [journal, setJournal] = useState<JournalView>(EMPTY_JOURNAL);
  const [flow, setFlow] = useState<Flow>({ phase: "idle" });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);
  const [dirtyVersion, setDirtyVersion] = useState(0);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [conflictCount, setConflictCount] = useState(0);
  const [heldEntries, setHeldEntries] = useState<readonly VocabItemWriteEntry[]>([]);
  const journalRef = useRef<JournalView>(EMPTY_JOURNAL);
  const operationRef = useRef<VocabItemWriteToken | null>(null);
  const operationPromiseRef = useRef<Promise<unknown> | null>(null);
  const externalWriteLockedRef = useRef(externalWriteLocked);
  const externalWriteInProgressRef = useRef(externalWriteInProgress);
  const mounted = useRef(false);
  const discardedNavigationAllowedRef = useRef(false);
  const dirtyRef = useRef(new Map<string, VocabItemCheckpointCandidate>());
  const checkpointRevisionRef = useRef(0);
  const submittedCheckpointRef = useRef(
    new Map<string, VocabItemCheckpointCandidate>(),
  );
  const checkpointPausedRef = useRef(new Set<string>());
  const checkpointConflictRef = useRef(new Set<string>());
  const explicitDiscardRefreshRef = useRef<Readonly<{
    itemIds: ReadonlySet<string>;
    candidates: ReadonlyMap<string, VocabItemCheckpointCandidate>;
  }> | null>(null);
  const checkpointTimer = useRef<number | null>(null);
  const refreshProtectionRef = useRef<VocabItemRefreshProtection | null>(null);
  const explicitTriggerRef = useRef<Readonly<{
    itemId: string;
    operationId: string;
    kind: LifecycleKind;
    trigger: HTMLElement;
  }> | null>(null);
  const heldEntriesRef = useRef(new Map<string, VocabItemWriteEntry>());
  const focusFrame = useRef<number | null>(null);

  const externalWriteBlockedNow = useCallback(() => {
    if (externalWriteLockedRef.current) return true;
    try {
      return externalWriteInProgressRef.current();
    } catch {
      return true;
    }
  }, []);

  const externalWriteBlocked = externalWriteLocked;
  const busy = flow.phase === "working";
  const hasDirtyCheckpoint = dirtyCount > 0;
  const hasConflictedCheckpoint = conflictCount > 0;
  const durableOperationIds = journal.entries.map((entry) =>
    entry.ticket.receipt.operationId
  );
  const hasHeldReceipt = heldEntries.length > 0;
  const hasVolatileHeldReceipt = heldEntries.some((entry) =>
    vocabItemHeldReceiptBarrier(
      entry.ticket.receipt.operationId,
      durableOperationIds,
    ).volatile
  );
  const writeLocked = !vocabItemWritePreflightOpen({
    loaded: journal.loaded,
    storageUnavailable: journal.storageUnavailable,
    lockUnavailable: journal.lockUnavailable,
    entryCount: journal.entries.length,
    unreadableCount: journal.unreadable.length,
  }, externalWriteBlocked, hasConflictedCheckpoint || hasHeldReceipt) || busy;
  const expectedContinuationBlocked = externalWriteBlocked ||
    hasConflictedCheckpoint || !journal.loaded || journal.storageUnavailable ||
    journal.lockUnavailable || journal.unreadable.length > 0;

  const reloadJournal = useCallback(() => {
    let next: VocabItemWriteJournal;
    try {
      next = readVocabItemWriteJournal();
    } catch {
      next = {
        entries: [],
        unreadable: [],
        storageUnavailable: true,
        lockUnavailable: typeof navigator === "undefined" || !navigator.locks,
      };
    }
    const loaded = { ...next, loaded: true };
    journalRef.current = loaded;
    let addedConflict = false;
    for (const entry of next.entries) {
      if (entry.ticket.kind !== "changed") continue;
      const itemId = entry.ticket.receipt.before.item.id;
      if (!checkpointConflictRef.current.has(itemId)) addedConflict = true;
      checkpointPausedRef.current.add(itemId);
      checkpointConflictRef.current.add(itemId);
    }
    if (mounted.current) {
      setJournal(loaded);
      if (addedConflict) {
        setConflictCount(checkpointConflictRef.current.size);
        setDirtyVersion((current) => current + 1);
      }
    }
    return next;
  }, []);

  const operationInProgress = useCallback(() => Boolean(operationRef.current), []);
  const blocksExternalWritesNow = useCallback(() => {
    const current = journalRef.current;
    return Boolean(
      operationRef.current || dirtyRef.current.size > 0 ||
      checkpointConflictRef.current.size > 0 ||
      heldEntriesRef.current.size > 0 || !current.loaded ||
      current.storageUnavailable || current.lockUnavailable ||
      current.entries.length > 0 || current.unreadable.length > 0
    );
  }, []);

  const holdEntry = useCallback((entry: VocabItemWriteEntry) => {
    heldEntriesRef.current.set(entry.ticket.receipt.operationId, entry);
    setHeldEntries([...heldEntriesRef.current.values()]);
  }, []);

  const clearHeldEntry = useCallback((receipt?: VocabItemWriteReceipt) => {
    if (receipt) heldEntriesRef.current.delete(receipt.operationId);
    else heldEntriesRef.current.clear();
    setHeldEntries([...heldEntriesRef.current.values()]);
  }, []);

  const setSafelyIdle = useCallback((receipt?: VocabItemWriteReceipt) => {
    clearHeldEntry(receipt);
    const held = heldEntriesRef.current.values().next().value ?? null;
    setFlow(held
      ? {
          phase: "check",
          entry: held,
          message: "还有一条原收据待只读核对；不会自动重试。",
        }
      : { phase: "idle" });
  }, [clearHeldEntry]);

  const restoreHeldFlowOrIdle = useCallback((message: string) => {
    const held = heldEntriesRef.current.values().next().value ?? null;
    setFlow(held
      ? { phase: "check", entry: held, message }
      : { phase: "idle" });
  }, []);

  const showAttention = useCallback((next: Flow, background: boolean) => {
    if ("entry" in next) holdEntry(next.entry);
    setFlow(next);
    if (!background) setFocusRequest((current) => current + 1);
    onAttention(background);
  }, [holdEntry, onAttention]);

  const claim = useCallback((
    action: WorkingAction,
    itemId: string | null,
    background: boolean,
  ) => {
    const token = claimVocabItemWrite(operationRef);
    if (token) {
      discardedNavigationAllowedRef.current = false;
      setError("");
      setFlow({ phase: "working", action, itemId, background });
    }
    return token;
  }, []);

  const release = useCallback((token: VocabItemWriteToken) => {
    releaseVocabItemWrite(operationRef, token);
  }, []);

  const clearCheckpointTimer = useCallback(() => {
    if (checkpointTimer.current === null) return;
    window.clearTimeout(checkpointTimer.current);
    checkpointTimer.current = null;
  }, []);

  useLayoutEffect(() => {
    externalWriteLockedRef.current = externalWriteLocked;
    externalWriteInProgressRef.current = externalWriteInProgress;
    if (externalWriteBlockedNow()) clearCheckpointTimer();
  }, [clearCheckpointTimer, externalWriteBlockedNow, externalWriteInProgress, externalWriteLocked]);

  const publishDirty = useCallback(() => {
    setDirtyCount(dirtyRef.current.size);
    setConflictCount(checkpointConflictRef.current.size);
    setDirtyVersion((current) => current + 1);
  }, []);

  const clearDirty = useCallback((itemId?: string, revision?: number) => {
    if (itemId) {
      const current = dirtyRef.current.get(itemId);
      if (!current || (revision !== undefined && current.revision !== revision)) return;
      dirtyRef.current.delete(itemId);
      checkpointPausedRef.current.delete(itemId);
      checkpointConflictRef.current.delete(itemId);
    } else {
      dirtyRef.current.clear();
      checkpointPausedRef.current.clear();
      checkpointConflictRef.current.clear();
    }
    if (dirtyRef.current.size === 0) clearCheckpointTimer();
    publishDirty();
  }, [clearCheckpointTimer, publishDirty]);

  const clearCheckpointCandidate = useCallback((
    itemId: string,
    revision?: number,
  ) => {
    const current = dirtyRef.current.get(itemId);
    if (!current || (revision !== undefined && current.revision !== revision)) return;
    dirtyRef.current.delete(itemId);
    if (!checkpointConflictRef.current.has(itemId)) {
      checkpointPausedRef.current.delete(itemId);
    }
    if (dirtyRef.current.size === 0) clearCheckpointTimer();
    publishDirty();
  }, [clearCheckpointTimer, publishDirty]);

  useEffect(() => {
    mounted.current = true;
    reloadJournal();
    const onStorage = (event: StorageEvent) => {
      if (
        event.storageArea === window.localStorage &&
        (event.key === null || event.key.startsWith(VOCAB_ITEM_WRITE_PREFIX))
      ) reloadJournal();
    };
    const onFocus = () => reloadJournal();
    const onVisibility = () => {
      if (document.visibilityState === "visible") reloadJournal();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted.current = false;
      clearCheckpointTimer();
      if (focusFrame.current !== null) window.cancelAnimationFrame(focusFrame.current);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [clearCheckpointTimer, reloadJournal]);

  useEffect(() => {
    if (!busy && !hasDirtyCheckpoint && !hasVolatileHeldReceipt) return;
    const protect = (event: BeforeUnloadEvent) => {
      if (!discardedNavigationAllowedRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [busy, dirtyVersion, hasDirtyCheckpoint, hasVolatileHeldReceipt]);

  const restoreVisibleFocus = useCallback((preferred: HTMLElement | null) => {
    if (focusFrame.current !== null) window.cancelAnimationFrame(focusFrame.current);
    focusFrame.current = window.requestAnimationFrame(() => {
      focusFrame.current = window.requestAnimationFrame(() => {
        focusFrame.current = null;
        const target = preferred?.isConnected && !preferred.matches(":disabled") &&
            preferred.getClientRects().length > 0 &&
            window.getComputedStyle(preferred).visibility !== "hidden"
          ? preferred
          : document.querySelector<HTMLElement>(
              ".sc-main h1, .sc-menu:not(:disabled)",
            );
        if (!target?.isConnected || target.getClientRects().length === 0) return;
        if (target.matches("h1")) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      });
    });
  }, []);

  const restoreExplicitFocus = useCallback((receipt: VocabItemWriteReceipt) => {
    const binding = explicitTriggerRef.current;
    if (
      !binding || binding.itemId !== receipt.before.item.id ||
      binding.operationId !== receipt.operationId || binding.kind !== receipt.kind
    ) return;
    explicitTriggerRef.current = null;
    restoreVisibleFocus(binding.trigger);
  }, [restoreVisibleFocus]);

  const clearExplicitBinding = useCallback((receipt: VocabItemWriteReceipt) => {
    if (explicitTriggerRef.current?.operationId === receipt.operationId) {
      explicitTriggerRef.current = null;
    }
  }, []);

  const reopenLatest = useCallback((
    entry: VocabItemWriteEntry,
    background: boolean,
  ) => {
    holdEntry(entry);
    const latestJournal = reloadJournal();
    const next = selectVocabItemWriteRecoveryEntry(
      [...heldEntriesRef.current.values()],
      latestJournal.entries,
    );
    const durable = Boolean(next && latestJournal.entries.includes(next));
    if (!next || !durable) {
      showAttention({
        phase: "check",
        entry: next ?? entry,
        message: "另一页移除了这条提醒；当前页仍保留原收据。下一步只读核对，不会重复写入。",
      }, background);
      setError("原收据暂时只保留在本页；核对完成前，所有条目写入保持暂停。");
      return;
    }
    if (next.ticket.receipt.operationId !== entry.ticket.receipt.operationId) {
      setStatus("同一条目还有另一张耐久收据；先处理画面上的这张，再回到原收据。");
    }
    showAttention(phaseForEntry(next), background);
  }, [holdEntry, reloadJournal, showAttention]);

  const removeCurrent = useCallback(async (entry: VocabItemWriteEntry) => {
    const result = await runWithCurrentVocabItemWrite(
      entry,
      (lease) => lease.remove(),
    );
    reloadJournal();
    return result.outcome;
  }, [reloadJournal]);

  const inspectEntryWithLease = useCallback((
    entry: VocabItemWriteEntry,
    missing: boolean,
  ) => {
    const operation = async (lease: VocabItemWriteLease) => {
      const inspection = await inspectVocabItemWrite(entry.ticket.receipt);
      if (inspection === "exact_saved") lease.committed();
      else if (inspection === "changed") lease.changed();
      else if (
        inspection === "expected" &&
        entry.ticket.receipt.kind === "progress-checkpoint"
      ) lease.remove();
      return inspection;
    };
    return missing
      ? runWithMissingVocabItemWrite(entry, operation)
      : runWithCurrentVocabItemWrite(entry, operation);
  }, []);

  const shouldDeferBundle = useCallback((next: VocabItemExpectedMap) => {
    return vocabItemBundleShouldDefer(
      next,
      dirtyRef.current,
      refreshProtectionRef.current,
      explicitDiscardRefreshRef.current?.itemIds ?? null,
    );
  }, []);

  const settleQueuedAfterRefresh = useCallback((receipt: VocabItemWriteReceipt) => {
    const queued = dirtyRef.current.get(receipt.before.item.id);
    if (!queued) return;
    const current = getExpected(queued.itemId);
    const submittedRevision = refreshProtectionRef.current?.submittedRevision ?? null;
    const reconciled = reconcileVocabItemCheckpointAfterApplied(
      queued,
      receipt,
      submittedRevision,
      current,
    );
    if (reconciled) {
      dirtyRef.current.set(queued.itemId, reconciled);
      publishDirty();
      return;
    }
    clearDirty(queued.itemId);
  }, [clearDirty, getExpected, publishDirty]);

  const finishCommitted = useCallback(async (
    entry: VocabItemWriteEntry,
    token: VocabItemWriteToken,
    background: boolean,
  ): Promise<void> => {
    const receipt = entry.ticket.receipt;
    const submittedRevision = refreshProtectionRef.current?.receipt.operationId ===
        receipt.operationId
      ? refreshProtectionRef.current.submittedRevision
      : null;
    refreshProtectionRef.current = {
      receipt,
      mode: "after-only",
      submittedRevision,
    };
    setFlow({
      phase: "working",
      action: "refresh",
      itemId: receipt.before.item.id,
      background,
    });
    setStatus(savedCopy(receipt));
    setError("");
    try {
      let outcome: VocabItemRefreshOutcome;
      try {
        outcome = await refresh();
      } catch {
        showAttention({
          phase: "refresh-only",
          entry,
          message: `${savedCopy(receipt)} 页面暂时没有读到最新条目；只需重新读取，不要重复提交。`,
        }, background);
        return;
      }
      if (outcome !== "applied") {
        showAttention({
          phase: "refresh-only",
          entry,
          message: outcome === "deferred"
            ? `${savedCopy(receipt)} 页面仍有未提交内容或外部变化；收据不会提前清除。`
            : `${savedCopy(receipt)} 这次读取已被更新请求取代；收据仍保留。`,
        }, background);
        return;
      }
      settleQueuedAfterRefresh(receipt);
      const removal = await removeCurrent(entry);
      if (removal === "blocked") {
        showAttention({
          phase: "refresh-only",
          entry,
          message: `${savedCopy(receipt)} 页面已更新，但核对提醒仍无法完整验证。`,
        }, background);
        return;
      }
      if (removal === "stale") {
        reopenLatest(entry, background);
        return;
      }
      setSafelyIdle(receipt);
      setStatus(savedCopy(receipt));
      if (receipt.kind !== "progress-checkpoint") {
        onToast(savedCopy(receipt));
        restoreExplicitFocus(receipt);
      }
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({
        phase: "refresh-only",
        entry,
        message: `${savedCopy(receipt)} 页面已经更新；只是提醒暂时没有收起。`,
      }, background);
    } finally {
      refreshProtectionRef.current = null;
      release(token);
    }
  }, [onToast, refresh, release, removeCurrent, reopenLatest, restoreExplicitFocus, setSafelyIdle, settleQueuedAfterRefresh, showAttention]);

  const restoreCheckpointCandidate = useCallback((receipt: VocabItemWriteReceipt) => {
    if (receipt.kind !== "progress-checkpoint") return;
    const itemId = receipt.before.item.id;
    const existing = dirtyRef.current.get(itemId);
    if (!existing) {
      const expected = getExpected(itemId);
      if (expected && sameVocabItemExpected(expected, receipt.before)) {
        dirtyRef.current.set(itemId, {
          itemId,
          progress: receipt.after.item.progress,
          expected,
          revision: ++checkpointRevisionRef.current,
        });
      }
    }
    checkpointPausedRef.current.add(itemId);
    publishDirty();
  }, [getExpected, publishDirty]);

  const settleExpectedCheckpoint = useCallback((
    receipt: VocabItemWriteReceipt,
  ) => {
    const candidate = dirtyRef.current.get(receipt.before.item.id);
    const alreadySatisfied = Boolean(
      candidate && sameVocabItemExpected(candidate.expected, receipt.before) &&
      Math.abs(candidate.progress - receipt.before.item.progress) < 0.005
    );
    if (alreadySatisfied && candidate) {
      clearCheckpointCandidate(candidate.itemId, candidate.revision);
    } else {
      restoreCheckpointCandidate(receipt);
    }
    setSafelyIdle(receipt);
    setStatus(alreadySatisfied
      ? "这次阅读位置确定没有写入；当前本页位置已经与资料一致。"
      : "这次阅读位置确定没有写入；候选仍保留在本页，下一次移动后会再尝试保存。");
  }, [clearCheckpointCandidate, restoreCheckpointCandidate, setSafelyIdle]);

  const settleInspectionResult = useCallback(async (
    result: Awaited<ReturnType<typeof inspectEntryWithLease>>,
    held: VocabItemWriteEntry,
    token: VocabItemWriteToken,
    background: boolean,
  ): Promise<void> => {
    reloadJournal();
    if (result.outcome === "blocked") {
      refreshProtectionRef.current = null;
      showAttention({
        phase: "check",
        entry: held,
        message: "当前无法完整验证全部条目提醒；原收据仍保留在本页，没有调用写入。",
      }, background);
      setError("核对存储尚未安全可用；所有条目写入保持暂停。");
      return;
    }
    if (result.outcome === "stale") {
      refreshProtectionRef.current = null;
      reopenLatest(held, background);
      return;
    }
    if (result.value === "exact_saved" && result.entry) {
      await finishCommitted(result.entry, token, background);
      return;
    }
    refreshProtectionRef.current = null;
    if (
      result.value === "expected" &&
      held.ticket.receipt.kind === "progress-checkpoint"
    ) {
      settleExpectedCheckpoint(held.ticket.receipt);
      return;
    }
    const entry = result.entry ?? held;
    if (result.value === "expected") {
      showAttention({
        phase: "expected",
        entry,
        message: "这次确定还没有写入。可以清除提醒，或明确继续同一动作。",
      }, background);
    } else if (result.value === "changed") {
      const itemId = held.ticket.receipt.before.item.id;
      checkpointPausedRef.current.add(itemId);
      checkpointConflictRef.current.add(itemId);
      publishDirty();
      clearExplicitBinding(held.ticket.receipt);
      showAttention({
        phase: "changed",
        entry,
        message: "当前条目已经变化；旧内容没有覆盖现在的资料，也不会再次写入。",
      }, background);
    } else if (result.value === "invalid_receipt") {
      showAttention({
        phase: "invalid",
        entry,
        message: "这份条目收据无法验证；没有据此写入。",
      }, background);
    } else {
      showAttention({
        phase: "check",
        entry,
        message: "结果仍无法确认；收据继续保留，不会自动重试。",
      }, background);
    }
  }, [clearExplicitBinding, finishCommitted, publishDirty, reloadJournal, reopenLatest, settleExpectedCheckpoint, showAttention]);

  const commitEntry = useCallback(async (
    entry: VocabItemWriteEntry,
    token: VocabItemWriteToken,
    background: boolean,
  ): Promise<void> => {
    const receipt = entry.ticket.receipt;
    const submittedRevision = refreshProtectionRef.current?.receipt.operationId ===
        receipt.operationId
      ? refreshProtectionRef.current.submittedRevision
      : null;
    refreshProtectionRef.current = {
      receipt,
      mode: "before-only",
      submittedRevision,
    };
    setFlow({
      phase: "working",
      action: "commit",
      itemId: receipt.before.item.id,
      background,
    });
    try {
      const result = await runWithCurrentVocabItemWrite(entry, async (lease) => {
        if (externalWriteBlockedNow()) return "external-blocked" as const;
        try {
          const committed = await commitVocabItemWrite(receipt);
          if (committed.outcome === "saved" || committed.outcome === "already_saved") {
            lease.committed();
            return "saved" as const;
          }
          if (committed.outcome === "changed") {
            lease.changed();
            return "changed" as const;
          }
          return "uncertain" as const;
        } catch (reason) {
          if (
            reason instanceof VocabItemMutationError &&
            reason.code === "write_failed"
          ) {
            if (receipt.kind === "progress-checkpoint") lease.remove();
            return "expected" as const;
          }
          throw reason;
        }
      });
      reloadJournal();
      if (result.outcome === "blocked") {
        refreshProtectionRef.current = null;
        showAttention({
          phase: "check",
          entry,
          message: "条目核对线索暂时无法完整验证；没有调用条目写入。",
        }, background);
        setError("现有条目没有改变；先处理全局安全提醒。");
        release(token);
        return;
      }
      if (result.outcome === "stale") {
        holdEntry(entry);
        const inspection = await inspectEntryWithLease(entry, true);
        await settleInspectionResult(
          inspection,
          entry,
          token,
          background,
        );
        return;
      }
      if (result.value === "external-blocked") {
        refreshProtectionRef.current = null;
        showAttention({
          phase: entry.ticket.receipt.kind === "progress-checkpoint"
            ? "check"
            : "expected",
          entry,
          message: "另一笔数据库安全操作正在进行；这张收据仍保留，没有调用条目写入。",
        }, background);
        setError("请先完成整包重新读取或另一笔数据库安全操作，再明确继续。");
        return;
      }
      if (result.value === "saved" && result.entry) {
        await finishCommitted(result.entry, token, background);
        return;
      }
      refreshProtectionRef.current = null;
      if (result.value === "changed" && result.entry) {
        const itemId = receipt.before.item.id;
        checkpointPausedRef.current.add(itemId);
        checkpointConflictRef.current.add(itemId);
        publishDirty();
        clearExplicitBinding(receipt);
        showAttention({
          phase: "changed",
          entry: result.entry,
          message: "条目已经在别处变化；旧内容没有覆盖当前内容，也不会再次写入。",
        }, background);
        release(token);
        return;
      }
      if (result.value === "expected" && receipt.kind === "progress-checkpoint") {
        settleExpectedCheckpoint(receipt);
        return;
      }
      if (result.value === "expected") {
        showAttention({
          phase: "expected",
          entry,
          message: "这次确定还没有写入。可以清除提醒，或明确继续同一动作。",
        }, background);
      } else {
        showAttention({
          phase: "check",
          entry,
          message: "这次条目结果仍需只读核对；不会凭猜测重复写入。",
        }, background);
      }
    } catch (reason) {
      refreshProtectionRef.current = null;
      reloadJournal();
      showAttention({
        phase: "check",
        entry,
        message: "这次条目结果需要只读核对；收据仍保留。",
      }, background);
      setError(reasonMessage(reason));
    } finally {
      if (operationRef.current === token) release(token);
    }
  }, [clearExplicitBinding, externalWriteBlockedNow, finishCommitted, holdEntry, inspectEntryWithLease, publishDirty, reloadJournal, release, settleExpectedCheckpoint, settleInspectionResult, showAttention]);

  const startPrepared = useCallback(async (
    prepare: () => Promise<VocabItemWriteReceipt>,
    itemId: string,
    background: boolean,
    submittedCandidate: VocabItemCheckpointCandidate | null = null,
    trigger: HTMLElement | null = null,
    operationBoundaryRevision: number | null = null,
  ): Promise<void> => {
    const token = claim("prepare", itemId, background);
    if (!token) return;
    if (submittedCandidate) {
      submittedCheckpointRef.current.set(itemId, submittedCandidate);
    }
    let entry: VocabItemWriteEntry | null = null;
    let receipt: VocabItemWriteReceipt | null = null;
    try {
      if (externalWriteBlockedNow()) {
        throw new Error("先处理另一笔数据库安全操作；当前位置仍保留在本页。");
      }
      const current = reloadJournal();
      if (current.storageUnavailable) {
        throw new Error("暂时无法读取条目核对存储；没有开始写入。");
      }
      if (current.lockUnavailable) {
        throw new Error("当前浏览器没有安全跨页面写入锁；没有开始写入。");
      }
      if (current.unreadable.length > 0) {
        throw new Error("先处理无法验证的条目提醒；没有开始写入。");
      }
      if (current.entries.length > 0) {
        throw new Error("先处理上一条条目核对线索；没有开始写入。");
      }
      if (externalWriteBlockedNow()) {
        throw new Error("先处理另一笔数据库安全操作；当前位置仍保留在本页。");
      }
      const preparedReceipt = await prepare();
      if (externalWriteBlockedNow()) {
        throw new Error("准备期间另一笔数据库安全操作开始；原条目动作仍保留，且没有保存或提交收据。");
      }
      receipt = preparedReceipt;
      refreshProtectionRef.current = {
        receipt,
        mode: "before-only",
        submittedRevision: operationBoundaryRevision ??
          submittedCandidate?.revision ?? null,
      };
      entry = await persistVocabItemWrite(createVocabItemWriteTicket(receipt));
      if (externalWriteBlockedNow()) {
        throw new Error("条目收据已经安全保留；另一笔数据库操作结束前不会提交。");
      }
      if (trigger && receipt.kind !== "progress-checkpoint") {
        explicitTriggerRef.current = {
          itemId,
          operationId: receipt.operationId,
          kind: receipt.kind,
          trigger,
        };
      }
      if (submittedCandidate && vocabItemCandidateMatchesSubmission(
        dirtyRef.current.get(itemId),
        submittedCandidate,
      )) clearDirty(itemId, submittedCandidate.revision);
      reloadJournal();
      await commitEntry(entry, token, background);
    } catch (reason) {
      refreshProtectionRef.current = null;
      if (entry) {
        showAttention({
          phase: "check",
          entry,
          message: "这次条目结果需要只读核对；收据仍保留。",
        }, background);
        setError(reasonMessage(reason));
        release(token);
        return;
      }
      const recovered = reloadJournal();
      const recoveredEntry = receipt
        ? recovered.entries.find((candidate) =>
            candidate.ticket.receipt.operationId === receipt?.operationId
          )
        : null;
      if (recoveredEntry) {
        if (trigger && recoveredEntry.ticket.receipt.kind !== "progress-checkpoint") {
          explicitTriggerRef.current = {
            itemId,
            operationId: recoveredEntry.ticket.receipt.operationId,
            kind: recoveredEntry.ticket.receipt.kind,
            trigger,
          };
        }
        if (submittedCandidate && vocabItemCandidateMatchesSubmission(
          dirtyRef.current.get(itemId),
          submittedCandidate,
        )) clearDirty(itemId, submittedCandidate.revision);
        showAttention({
          phase: "check",
          entry: recoveredEntry,
          message: "安全收据可能已经保留；先只读核对结果，不会重复写入。",
        }, background);
        setError(`${reasonMessage(reason)} 请先按已保留的线索核对。`);
      } else if (receipt) {
        const held = createVocabItemWriteEntry(
          createVocabItemWriteTicket(receipt),
        );
        holdEntry(held);
        refreshProtectionRef.current = {
          receipt,
          mode: "before-only",
          submittedRevision: operationBoundaryRevision ??
            submittedCandidate?.revision ?? null,
        };
        if (trigger && receipt.kind !== "progress-checkpoint") {
          explicitTriggerRef.current = {
            itemId,
            operationId: receipt.operationId,
            kind: receipt.kind,
            trigger,
          };
        }
        try {
          const inspection = await inspectEntryWithLease(held, true);
          await settleInspectionResult(
            inspection,
            held,
            token,
            background,
          );
        } catch (recoveryReason) {
          refreshProtectionRef.current = null;
          reloadJournal();
          showAttention({
            phase: "check",
            entry: held,
            message: "原收据暂时只保留在本页；只读核对尚未完成，所有条目写入保持暂停。",
          }, background);
          setError(reasonMessage(recoveryReason));
        } finally {
          if (operationRef.current === token) release(token);
        }
        return;
      } else {
        restoreHeldFlowOrIdle("原收据仍保留在本页；下一步只读核对，不会重复写入。");
        setError(reasonMessage(reason));
        const expectedChanged = reason instanceof VocabItemMutationError &&
          reason.code === "changed";
        if (expectedChanged) {
          checkpointPausedRef.current.add(itemId);
          checkpointConflictRef.current.add(itemId);
          setStatus("另一页已经改变这个条目；旧显示凭据已停用，不会重试。请放弃本页位置并读取最新。");
          publishDirty();
        } else if (background) {
          checkpointPausedRef.current.add(itemId);
          setStatus("当前位置仍保留在本页，但尚未安全写入；下一次移动后会重新尝试。");
          publishDirty();
        }
      }
      release(token);
    } finally {
      if (
        submittedCandidate &&
        submittedCheckpointRef.current.get(itemId)?.revision ===
          submittedCandidate.revision
      ) submittedCheckpointRef.current.delete(itemId);
    }
  }, [claim, clearDirty, commitEntry, externalWriteBlockedNow, holdEntry, inspectEntryWithLease, publishDirty, reloadJournal, release, restoreHeldFlowOrIdle, settleInspectionResult, showAttention]);

  const flushCheckpoint = useCallback(async (): Promise<"saved" | "blocked" | "none"> => {
    clearCheckpointTimer();
    if (heldEntriesRef.current.size > 0) {
      setStatus("有一条原收据仍待只读核对；核对完成前，所有条目写入保持暂停。");
      return "blocked";
    }
    if (checkpointConflictRef.current.size > 0) {
      setStatus("另一页已改变条目；读取最新资料前，所有条目写入都保持暂停。当前位置仍留在本页。");
      return "blocked";
    }
    const candidate = [...dirtyRef.current.values()].find((entry) =>
      !checkpointPausedRef.current.has(entry.itemId)
    );
    if (!candidate || operationRef.current) return "none";
    if (externalWriteBlockedNow()) {
      setStatus("当前位置仍保留在本页；另一笔数据库安全操作结束前不会开始条目写入。");
      return "blocked";
    }
    const expected = getExpected(candidate.itemId);
    if (
      !expected || !sameVocabItemExpected(expected, candidate.expected) ||
      expected.item.status === "complete" || expected.item.status === "archived"
    ) {
      checkpointPausedRef.current.add(candidate.itemId);
      publishDirty();
      setStatus("页面里的条目已经变化；旧阅读位置仍保留在本页，没有写入。请放弃本页位置后读取最新资料。");
      return "blocked";
    }
    await startPrepared(
      () => prepareVocabItemProgressCheckpoint(candidate.progress, expected),
      candidate.itemId,
      true,
      candidate,
    );
    const applied = getExpected(candidate.itemId);
    const currentJournal = reloadJournal();
    const saved = Boolean(
      applied && applied.generationId === candidate.expected.generationId &&
      applied.generationSequence === candidate.expected.generationSequence &&
      applied.item.updated_at > candidate.expected.item.updated_at &&
      applied.item.progress === candidate.progress &&
      !dirtyRef.current.has(candidate.itemId) &&
      !currentJournal.storageUnavailable && currentJournal.entries.length === 0 &&
      currentJournal.unreadable.length === 0,
    );
    return saved ? "saved" : "blocked";
  }, [clearCheckpointTimer, externalWriteBlockedNow, getExpected, publishDirty, reloadJournal, startPrepared]);

  const scheduleCheckpoint = useCallback(() => {
    clearCheckpointTimer();
    checkpointTimer.current = window.setTimeout(() => {
      checkpointTimer.current = null;
      if (externalWriteBlockedNow() || operationRef.current) return;
      const running = flushCheckpoint();
      operationPromiseRef.current = running.finally(() => {
        operationPromiseRef.current = null;
      });
    }, 800);
  }, [clearCheckpointTimer, externalWriteBlockedNow, flushCheckpoint]);

  const queueCheckpoint = useCallback((item: LibraryItem, progress: number) => {
    const currentJournal = journalRef.current;
    if (
      !currentJournal.loaded || currentJournal.storageUnavailable ||
      currentJournal.lockUnavailable || currentJournal.unreadable.length > 0 ||
      item.status === "complete" || item.status === "archived"
    ) return false;
    const expected = getExpected(item.id);
    if (!expected || expected.item !== item) return false;
    discardedNavigationAllowedRef.current = false;
    const previous = dirtyRef.current.get(item.id);
    const submitted = submittedCheckpointRef.current.get(item.id);
    const protection = refreshProtectionRef.current;
    const durableProgressAdvance = journalRef.current.entries.some((entry) =>
      entry.ticket.kind !== "changed" &&
      entry.ticket.receipt.kind === "progress-checkpoint" &&
      sameVocabItemExpected(entry.ticket.receipt.before, expected)
    );
    const protectedProgressAdvance = Boolean(
      protection && protection.receipt.kind === "progress-checkpoint" &&
      sameVocabItemExpected(protection.receipt.before, expected),
    );
    const heldProgressAdvance = [...heldEntriesRef.current.values()].some((entry) =>
      entry.ticket.kind !== "changed" &&
      entry.ticket.receipt.kind === "progress-checkpoint" &&
      sameVocabItemExpected(entry.ticket.receipt.before, expected)
    );
    const candidate = coalesceVocabItemCheckpointSample(
      previous,
      expected,
      progress,
      ++checkpointRevisionRef.current,
      Boolean(
        submitted && sameVocabItemExpected(submitted.expected, expected) ||
        durableProgressAdvance || protectedProgressAdvance ||
        heldProgressAdvance
      ),
    );
    if (!candidate) {
      if (previous) clearCheckpointCandidate(item.id, previous.revision);
      return true;
    }
    if (candidate === previous) return false;
    dirtyRef.current.set(item.id, candidate);
    const conflicted = checkpointConflictRef.current.has(item.id);
    const hasAnyConflict = checkpointConflictRef.current.size > 0;
    const hasHeldReceiptBarrier = heldEntriesRef.current.size > 0;
    if (!conflicted) checkpointPausedRef.current.delete(item.id);
    publishDirty();
    if (!hasAnyConflict && !hasHeldReceiptBarrier && !externalWriteBlockedNow() && !operationRef.current && currentJournal.entries.length === 0) {
      scheduleCheckpoint();
    }
    else if (hasAnyConflict) {
      setStatus("有条目已经在另一页改变；本页位置已更新，但所有旧凭据都不会重试。请放弃本页位置并读取最新。");
    }
    else if (hasHeldReceiptBarrier) {
      setStatus("本页位置已更新；原收据只读核对完成前不会开始新的条目写入。");
    }
    else if (currentJournal.entries.length > 0) {
      setStatus("阅读位置已暂存在本页；处理完安全提醒后才会继续保存。");
    }
    return true;
  }, [clearCheckpointCandidate, externalWriteBlockedNow, getExpected, publishDirty, scheduleCheckpoint]);

  useEffect(() => {
    if (!vocabItemCheckpointSchedulingOpen({
      dirtyCount: dirtyRef.current.size,
      operationInProgress: Boolean(operationRef.current),
      journalLoaded: journal.loaded,
      externalWriteLocked: externalWriteBlocked,
      storageUnavailable: journal.storageUnavailable,
      lockUnavailable: journal.lockUnavailable,
      unreadableCount: journal.unreadable.length,
      entryCount: journal.entries.length,
      allDirtyItemsPaused: hasHeldReceipt || checkpointConflictRef.current.size > 0 ||
        [...dirtyRef.current.keys()].every((itemId) =>
          checkpointPausedRef.current.has(itemId)
        ),
    })) {
      clearCheckpointTimer();
      return;
    }
    scheduleCheckpoint();
  }, [busy, clearCheckpointTimer, dirtyVersion, externalWriteBlocked, hasHeldReceipt, journal, scheduleCheckpoint]);

  const cancelCheckpoint = useCallback((itemId: string) => {
    clearDirty(itemId);
  }, [clearDirty]);

  const discardCheckpoints = useCallback((itemId?: string) => {
    clearDirty(itemId);
    setStatus("已放弃本页尚未写入的阅读位置；词库里的既有内容没有改变。");
  }, [clearDirty]);

  const allowDiscardedNavigation = useCallback(() => {
    discardedNavigationAllowedRef.current = true;
  }, []);

  const discardCheckpointsAndRefresh = useCallback(async (
    forceRefresh = false,
    trigger: HTMLElement | null = null,
  ) => {
    const itemIds = new Set([
      ...dirtyRef.current.keys(),
      ...checkpointConflictRef.current,
    ]);
    if (itemIds.size === 0 && !forceRefresh) return "none" as const;
    const token = claim("refresh", null, false);
    if (!token) return "blocked" as const;
    const candidates = new Map<string, VocabItemCheckpointCandidate>();
    for (const itemId of itemIds) {
      const candidate = dirtyRef.current.get(itemId);
      if (candidate) candidates.set(itemId, candidate);
      checkpointPausedRef.current.add(itemId);
      checkpointConflictRef.current.add(itemId);
    }
    explicitDiscardRefreshRef.current = { itemIds, candidates };
    publishDirty();
    setStatus("正在放弃所选本页位置并整包读取最新资料；读取成功前旧凭据仍保持停用。");
    try {
      const outcome = await refresh();
      if (outcome !== "applied") {
        const gatedItemIds = vocabItemExplicitDiscardGateItemIds(
          itemIds,
          dirtyRef.current,
        );
        for (const itemId of gatedItemIds) {
          checkpointPausedRef.current.add(itemId);
          checkpointConflictRef.current.add(itemId);
        }
        publishDirty();
        restoreHeldFlowOrIdle("原收据仍保留在本页；下一步只读核对，不会重复写入。");
        setStatus(outcome === "deferred"
          ? "最新资料尚未应用；旧凭据与本页位置仍保留且不会重试。请先处理页面上的其他草稿。"
          : "这次读取已被更新请求取代；旧凭据与本页位置仍保留且不会重试。");
        return "blocked" as const;
      }
      let keptNewerCandidate = false;
      const settledItemIds = vocabItemExplicitDiscardGateItemIds(
        itemIds,
        dirtyRef.current,
      );
      for (const itemId of settledItemIds) {
        const captured = candidates.get(itemId) ?? null;
        const current = dirtyRef.current.get(itemId);
        const resolution = resolveVocabItemExplicitConflictRefresh(
          captured,
          current,
          true,
        );
        if (resolution.discardRevision !== null) {
          dirtyRef.current.delete(itemId);
          checkpointPausedRef.current.delete(itemId);
          checkpointConflictRef.current.delete(itemId);
        } else if (resolution.keepConflict) {
          checkpointPausedRef.current.add(itemId);
          checkpointConflictRef.current.add(itemId);
          keptNewerCandidate = true;
        } else if (resolution.clearConflict) {
          checkpointPausedRef.current.delete(itemId);
          checkpointConflictRef.current.delete(itemId);
        }
      }
      if (dirtyRef.current.size === 0) clearCheckpointTimer();
      publishDirty();
      restoreHeldFlowOrIdle("原收据仍保留在本页；下一步只读核对，不会重复写入。");
      setError("");
      setStatus(keptNewerCandidate
        ? "已读取最新条目；读取期间产生的新位置仍保留为冲突草稿，不会自动重试。"
        : "已放弃所选本页位置并读取最新条目；旧凭据现在才解除停用。");
      if (trigger) restoreVisibleFocus(trigger);
      return "applied" as const;
    } catch (reason) {
      const gatedItemIds = vocabItemExplicitDiscardGateItemIds(
        itemIds,
        dirtyRef.current,
      );
      for (const itemId of gatedItemIds) {
        checkpointPausedRef.current.add(itemId);
        checkpointConflictRef.current.add(itemId);
      }
      publishDirty();
      restoreHeldFlowOrIdle("原收据仍保留在本页；下一步只读核对，不会重复写入。");
      setError(reasonMessage(reason));
      setStatus("最新资料没有完整读取；旧凭据与本页位置仍保留且不会重试。");
      return "blocked" as const;
    } finally {
      explicitDiscardRefreshRef.current = null;
      release(token);
    }
  }, [claim, clearCheckpointTimer, publishDirty, refresh, release, restoreHeldFlowOrIdle, restoreVisibleFocus]);

  const startLifecycle = useCallback(async (
    kind: LifecycleKind,
    item: LibraryItem,
    trigger: HTMLElement | null,
  ) => {
    const background = trigger === null;
    const displayedExpected = getExpected(item.id);
    if (!vocabItemLifecycleDisplayBound(displayedExpected, item)) {
      setError("当前画面与最新安全读取凭据不再是同一条显示资料；没有处理进度或准备动作，请只重新读取。");
      return;
    }
    if (heldEntriesRef.current.size > 0) {
      setError("有一条原收据仍待只读核对；核对完成前没有开始新的条目动作。");
      return;
    }
    if (checkpointConflictRef.current.size > 0) {
      setError("有条目的旧显示凭据已停用；所有条目动作都保持暂停。请放弃本页位置并读取最新。");
      return;
    }
    if (kind === "archive" && dirtyRef.current.has(item.id)) {
      if (checkpointConflictRef.current.has(item.id)) {
        const gate = vocabItemArchiveCheckpointGate(true, "none", true);
        if (gate === "stop-blocked") {
          setStatus("另一页已经改变这个条目；旧阅读位置不会重试，也没有归档。请放弃本页位置并读取最新。");
        }
        return;
      }
      checkpointPausedRef.current.delete(item.id);
      clearCheckpointTimer();
      const running = flushCheckpoint();
      operationPromiseRef.current = running.finally(() => {
        operationPromiseRef.current = null;
      });
      const outcome = await running;
      const gate = vocabItemArchiveCheckpointGate(true, outcome);
      setStatus(gate === "stop-saved"
        ? "当前位置已确认保存。请再次选择归档。"
        : "当前位置尚未确认保存；没有归档。请先处理页面上的安全提醒。");
      return;
    }
    const pending = operationPromiseRef.current;
    if (pending) {
      await pending.catch(() => undefined);
      if (kind === "archive") {
        setStatus("已先处理当前阅读位置。请确认页面状态后再次选择归档。");
        return;
      }
    }
    if (operationRef.current) return;
    if (heldEntriesRef.current.size > 0) {
      setError("有一条原收据仍待只读核对；核对完成前没有开始新的条目动作。");
      return;
    }
    if (externalWriteBlockedNow()) {
      setError("先处理另一笔数据库安全操作；没有开始条目动作。");
      return;
    }
    const expected = getExpected(item.id);
    if (!vocabItemLifecycleDisplayBound(expected, item)) {
      setError("当前画面与最新安全读取凭据不再是同一条显示资料；没有开始写入，请只重新读取。");
      return;
    }
    const current = reloadJournal();
    if (
      current.storageUnavailable || current.lockUnavailable ||
      current.unreadable.length > 0 || current.entries.length > 0
    ) {
      setError("先处理条目写入安全提醒；没有开始新的动作。");
      onAttention(background);
      return;
    }
    const prepare = kind === "complete"
      ? () => prepareVocabItemComplete(expected)
      : kind === "archive"
        ? () => prepareVocabItemArchive(expected)
        : () => prepareVocabItemRestore(expected);
    const supersededCandidate = kind === "complete"
      ? dirtyRef.current.get(item.id) ?? null
      : null;
    const operationBoundaryRevision = kind === "complete"
      ? checkpointRevisionRef.current
      : null;
    const running = startPrepared(
      prepare,
      item.id,
      background,
      supersededCandidate,
      trigger,
      operationBoundaryRevision,
    );
    operationPromiseRef.current = running.finally(() => {
      operationPromiseRef.current = null;
    });
    await running;
  }, [clearCheckpointTimer, externalWriteBlockedNow, flushCheckpoint, getExpected, onAttention, reloadJournal, startPrepared]);

  const open = useCallback((entry?: VocabItemWriteEntry) => {
    if (operationRef.current) return;
    const current = reloadJournal();
    const next = entry ?? selectVocabItemWriteRecoveryEntry(
      [...heldEntriesRef.current.values()],
      current.entries,
    );
    setError("");
    const durable = Boolean(next && current.entries.includes(next));
    showAttention(next
      ? durable
        ? phaseForEntry(next)
        : {
            phase: "check",
            entry: next,
            message: "原收据暂时只保留在本页；先只读核对，不会重复写入。",
          }
      : { phase: "idle" }, false);
  }, [reloadJournal, showAttention]);

  const inspect = useCallback(async (entry: VocabItemWriteEntry) => {
    const token = claim("inspect", entry.ticket.receipt.before.item.id, false);
    if (!token) return;
    try {
      let result = await inspectEntryWithLease(entry, false);
      if (result.outcome === "stale") {
        holdEntry(entry);
        result = await inspectEntryWithLease(entry, true);
      }
      await settleInspectionResult(result, entry, token, false);
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({
        phase: "check",
        entry,
        message: "只读核对没有完成；收据仍保留。",
      }, false);
    } finally {
      if (operationRef.current === token) release(token);
    }
  }, [claim, holdEntry, inspectEntryWithLease, release, settleInspectionResult, showAttention]);

  const continueExpected = useCallback(async (entry: VocabItemWriteEntry) => {
    if (entry.ticket.receipt.kind === "progress-checkpoint") return;
    if (externalWriteBlockedNow()) {
      showAttention({
        phase: "expected",
        entry,
        message: "这张收据仍保留；另一笔数据库安全操作结束前不会继续写入。",
      }, false);
      setError("当前安全门尚未开放；没有调用条目写入。");
      return;
    }
    const current = reloadJournal();
    const selected = selectVocabItemWriteRecoveryEntry(
      [...heldEntriesRef.current.values()],
      current.entries,
    );
    const selectedReceiptMatches = Boolean(
      selected && selected.storageKey === entry.storageKey &&
      selected.raw === entry.raw && current.entries.some((candidate) =>
        candidate.storageKey === entry.storageKey && candidate.raw === entry.raw
      ),
    );
    if (!vocabItemExpectedContinuationOpen({
      externalWriteLocked: externalWriteBlockedNow(),
      hasConflict: checkpointConflictRef.current.size > 0,
      storageUnavailable: current.storageUnavailable,
      lockUnavailable: current.lockUnavailable,
      unreadableCount: current.unreadable.length,
      selectedReceiptMatches,
    })) {
      showAttention({
        phase: "expected",
        entry,
        message: "这张收据仍保留；整包读取与其他安全操作明确结束前不会继续写入。",
      }, false);
      setError("当前安全门尚未开放；没有调用条目写入。请稍后再次明确继续。");
      return;
    }
    const token = claim("commit", entry.ticket.receipt.before.item.id, false);
    if (!token) return;
    if (externalWriteBlockedNow()) {
      showAttention({
        phase: "expected",
        entry,
        message: "这张收据仍保留；另一笔数据库安全操作结束前不会继续写入。",
      }, false);
      setError("当前安全门尚未开放；没有调用条目写入。");
      release(token);
      return;
    }
    await commitEntry(entry, token, false);
  }, [claim, commitEntry, externalWriteBlockedNow, release, reloadJournal, showAttention]);

  const discardExpected = useCallback(async (entry: VocabItemWriteEntry) => {
    const token = claim("journal", entry.ticket.receipt.before.item.id, false);
    if (!token) return;
    try {
      const result = await removeCurrent(entry);
      if (result === "blocked") {
        showAttention({
          phase: "expected",
          entry,
          message: "出现了无法验证的跨页面提醒；这条收据仍保留。",
        }, false);
      } else if (result === "stale") reopenLatest(entry, false);
      else {
        clearExplicitBinding(entry.ticket.receipt);
        setSafelyIdle(entry.ticket.receipt);
        setStatus("这次确定未写入的条目收据已经清除；原资料没有改变。");
      }
    } catch (reason) {
      reloadJournal();
      setError(reasonMessage(reason));
      showAttention({
        phase: vocabItemJournalFailureRecoveryPhase("discard-expected"),
        entry,
        message: "清除提醒没有完成；原收据仍保留，可以再次尝试。",
      }, false);
    } finally {
      release(token);
    }
  }, [claim, clearExplicitBinding, release, reloadJournal, removeCurrent, reopenLatest, setSafelyIdle, showAttention]);

  const refreshCommitted = inspect;

  const refreshChanged = useCallback(async (entry: VocabItemWriteEntry) => {
    const token = claim("refresh", entry.ticket.receipt.before.item.id, false);
    if (!token) return;
    const itemId = entry.ticket.receipt.before.item.id;
    const discardedCandidate = dirtyRef.current.get(itemId) ?? null;
    checkpointPausedRef.current.add(itemId);
    checkpointConflictRef.current.add(itemId);
    publishDirty();
    clearExplicitBinding(entry.ticket.receipt);
    refreshProtectionRef.current = {
      receipt: entry.ticket.receipt,
      mode: "any",
      submittedRevision: null,
    };
    try {
      const outcome = await refresh();
      if (outcome !== "applied") {
        showAttention({
          phase: "changed",
          entry,
          message: "当前条目还没有完整重新读取；旧收据继续保留。",
        }, false);
        return;
      }
      const candidateResolution = resolveVocabItemExplicitConflictRefresh(
        discardedCandidate,
        dirtyRef.current.get(itemId),
        true,
      );
      if (candidateResolution.discardRevision !== null) {
        const current = dirtyRef.current.get(itemId);
        if (current?.revision === candidateResolution.discardRevision) {
          dirtyRef.current.delete(itemId);
        }
      }
      if (candidateResolution.keepConflict) {
        checkpointConflictRef.current.add(itemId);
        checkpointPausedRef.current.add(itemId);
        setStatus("读取期间产生了更新的本页位置；它仍保留但不会套用到外部条目。请明确放弃后再读取。");
      } else if (candidateResolution.clearConflict) {
        checkpointConflictRef.current.delete(itemId);
        checkpointPausedRef.current.delete(itemId);
      }
      if (dirtyRef.current.size === 0) clearCheckpointTimer();
      publishDirty();
      const removal = await removeCurrent(entry);
      if (removal === "blocked") {
        showAttention({
          phase: "changed",
          entry,
          message: "页面已读取，但旧收据暂时不能安全清除。",
        }, false);
      } else if (removal === "stale") reopenLatest(entry, false);
      else {
        setSafelyIdle(entry.ticket.receipt);
        setStatus(candidateResolution.keepConflict
          ? "已经读取当前条目；读取期间产生的本页位置仍保留且不会自动重试。请明确放弃它后继续。"
          : "已经读取当前条目；旧内容没有覆盖或改写它。");
      }
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({
        phase: "changed",
        entry,
        message: "当前条目尚未重新读取；旧收据继续保留。",
      }, false);
    } finally {
      refreshProtectionRef.current = null;
      release(token);
    }
  }, [claim, clearCheckpointTimer, clearExplicitBinding, publishDirty, refresh, release, removeCurrent, reopenLatest, setSafelyIdle, showAttention]);

  const dismissInvalid = useCallback(async (entry: VocabItemWriteEntry) => {
    const token = claim("journal", entry.ticket.receipt.before.item.id, false);
    if (!token) return;
    try {
      const result = await removeCurrent(entry);
      if (result === "stale") reopenLatest(entry, false);
      else if (result === "blocked") {
        showAttention({
          phase: "invalid",
          entry,
          message: "出现了无法验证的提醒；这条旧提醒仍保留。",
        }, false);
      } else {
        clearExplicitBinding(entry.ticket.receipt);
        setSafelyIdle(entry.ticket.receipt);
      }
    } catch (reason) {
      reloadJournal();
      setError(reasonMessage(reason));
      showAttention({
        phase: vocabItemJournalFailureRecoveryPhase("dismiss-invalid"),
        entry,
        message: "清除旧提醒没有完成；原提醒仍保留，可以再次尝试。",
      }, false);
    } finally {
      release(token);
    }
  }, [claim, clearExplicitBinding, release, reloadJournal, removeCurrent, reopenLatest, setSafelyIdle, showAttention]);

  const clearUnreadable = useCallback(async () => {
    const token = claim("journal", null, false);
    if (!token) return;
    try {
      const current = reloadJournal();
      for (const entry of current.unreadable) {
        if (!await removeUnreadableVocabItemWrite(entry)) {
          throw new Error("另一页已经改动了一条无法验证的条目提醒。");
        }
      }
      reloadJournal();
      restoreHeldFlowOrIdle("原收据仍保留在本页；下一步只读核对，不会重复写入。");
      setStatus("无法验证的条目提醒已经清除；现有资料没有改变。");
    } catch (reason) {
      reloadJournal();
      const recoveryPhase = vocabItemJournalFailureRecoveryPhase(
        "clear-unreadable",
        heldEntriesRef.current.size > 0,
      );
      restoreHeldFlowOrIdle(recoveryPhase === "check"
        ? "无法验证的提醒尚未全部清除；原收据仍保留，只能继续只读核对。"
        : "无法验证的提醒尚未全部清除；清除动作仍可见并可重试。");
      setError(reasonMessage(reason));
    } finally {
      release(token);
    }
  }, [claim, release, reloadJournal, restoreHeldFlowOrIdle]);

  return {
    journal,
    flow,
    busy,
    writeLocked,
    expectedContinuationBlocked,
    hasDirtyCheckpoint,
    hasConflictedCheckpoint,
    hasHeldReceipt,
    hasVolatileHeldReceipt,
    status,
    error,
    focusRequest,
    queueCheckpoint,
    cancelCheckpoint,
    discardCheckpoints,
    allowDiscardedNavigation,
    discardCheckpointsAndRefresh,
    flushCheckpoint,
    startLifecycle,
    open,
    inspect,
    continueExpected,
    discardExpected,
    refreshCommitted,
    refreshChanged,
    dismissInvalid,
    clearUnreadable,
    recheckJournal: reloadJournal,
    shouldDeferBundle,
    operationInProgress,
    blocksExternalWritesNow,
  } as const;
}

type Controller = ReturnType<typeof useVocabItemWriteFlow>;

export function VocabItemWriteBanner({
  controller,
  onOpen,
}: {
  controller: Controller;
  onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const {
    journal,
    busy,
    hasDirtyCheckpoint,
    hasConflictedCheckpoint,
    hasHeldReceipt,
  } = controller;
  if (
    !journal.loaded ||
    (!journal.storageUnavailable && !journal.lockUnavailable &&
      journal.entries.length === 0 && journal.unreadable.length === 0 &&
      !hasDirtyCheckpoint && !hasConflictedCheckpoint && !hasHeldReceipt)
  ) return null;
  const title = journal.storageUnavailable
    ? "条目核对线索暂时无法读取"
    : journal.lockUnavailable
      ? "这个浏览器可以阅读资料，但暂不能安全保存条目进度"
      : journal.unreadable.length > 0
        ? "有无法验证的条目提醒"
        : hasConflictedCheckpoint
          ? "本页条目凭据已停用，自动重试已停止"
        : hasHeldReceipt
          ? "原条目收据仍待只读核对"
        : journal.entries.length > 0
          ? `有 ${journal.entries.length} 条条目写入待核对`
          : "阅读位置正在等待安全保存";
  return <section className="sc-item-write-banner" role="status">
    <div><b>{title}</b><p>文章、字幕和词库仍可阅读；安全条件明确前不会覆盖条目。</p></div>
    <div className="sc-item-write-actions">{(journal.entries.length > 0 || hasHeldReceipt ||
      journal.storageUnavailable || journal.lockUnavailable || journal.unreadable.length > 0) &&
      <button type="button" disabled={busy} onClick={(event) => {
        onOpen(event.currentTarget);
        controller.open();
      }}>
        {journal.entries.length || hasHeldReceipt ? "打开待核对收据" : "查看安全说明"}
      </button>}
    {(hasDirtyCheckpoint || hasConflictedCheckpoint) &&
      <button type="button" disabled={busy} onClick={(event) => {
        void controller.discardCheckpointsAndRefresh(false, event.currentTarget);
      }}>
        放弃本页未保存位置并读取最新
      </button>}</div>
  </section>;
}

function receiptText(receipt: VocabItemWriteReceipt): string {
  return [
    receipt.after.item.title,
    `动作：${receipt.kind === "progress-checkpoint" ? "保存阅读位置" : lifecycleLabel(receipt.kind)}`,
    `原状态：${receipt.before.item.status} · ${Math.round(receipt.before.item.progress * 100)}%`,
    `目标状态：${receipt.after.item.status} · ${Math.round(receipt.after.item.progress * 100)}%`,
  ].join("\n");
}

export function VocabItemWriteRecovery({ controller }: { controller: Controller }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { flow, journal, busy, error, status, focusRequest } = controller;
  useEffect(() => {
    if (!focusRequest) return;
    const frame = window.requestAnimationFrame(() =>
      heading.current?.focus({ preventScroll: true })
    );
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);
  const entry = "entry" in flow ? flow.entry : null;
  const message = "message" in flow ? flow.message : "";
  const backendBlocked = journal.storageUnavailable || journal.lockUnavailable ||
    journal.unreadable.length > 0;
  const title = journal.storageUnavailable
    ? "暂时无法查看条目核对线索"
    : journal.lockUnavailable
      ? "当前浏览器只读开放"
      : journal.unreadable.length > 0
        ? "有无法验证的条目提醒"
        : flow.phase === "working"
          ? "正在安全处理条目"
          : flow.phase === "expected"
            ? "这次确定还没有写入"
            : flow.phase === "changed"
              ? "当前条目已经变化"
              : flow.phase === "refresh-only"
                ? "保存事实已确认，页面待刷新"
                : flow.phase === "invalid"
                  ? "条目收据无法验证"
                  : entry ? "有一条条目写入待核对" : "条目写入安全说明";
  return <section className="sc-item-write-recovery" aria-live="polite">
    <header><h2 ref={heading} tabIndex={-1}>{title}</h2><p>
      {flow.phase === "working"
        ? flow.action === "inspect" ? "正在只读核对结果…"
          : flow.action === "refresh" ? "正在重新读取页面…"
            : "正在安全处理，请保持此页打开…"
        : entry ? message
          : journal.lockUnavailable
            ? "缺少跨页面写入锁时，不会调用条目写入；已有资料仍可照常阅读。"
            : "重新检查只会读取页面与核对线索，不会自动修改条目。"}
    </p></header>
    {error && <p className="sc-item-write-error" role="alert">{error}</p>}
    {status && <p className="sc-item-write-status" role="status">{status}</p>}
    {entry && <details className="sc-item-receipt" open={flow.phase === "changed"}>
      <summary>查看这次条目动作</summary>
      <pre>{receiptText(entry.ticket.receipt)}</pre>
    </details>}
    <footer>
      {(journal.storageUnavailable || journal.lockUnavailable) &&
        <button type="button" disabled={busy} onClick={controller.recheckJournal}>重新检查</button>}
      {!journal.storageUnavailable && !journal.lockUnavailable &&
        journal.unreadable.length > 0 &&
        <button type="button" disabled={busy} onClick={() => void controller.clearUnreadable()}>
          保留资料并清除无法验证的提醒
        </button>}
      {entry && flow.phase === "check" &&
        <button className="primary" type="button" disabled={busy || backendBlocked} onClick={() => void controller.inspect(entry)}>只读核对结果</button>}
      {entry && flow.phase === "expected" && <>
        <button type="button" disabled={busy} onClick={() => void controller.discardExpected(entry)}>不执行并清除提醒</button>
        {entry.ticket.receipt.kind !== "progress-checkpoint" &&
          controller.expectedContinuationBlocked &&
          <span className="sc-item-write-action-note" role="status">整包读取或其他安全操作结束前，继续动作保持停用。</span>}
        {entry.ticket.receipt.kind !== "progress-checkpoint" &&
          <button className="primary" type="button" disabled={busy || backendBlocked || controller.expectedContinuationBlocked} onClick={() => void controller.continueExpected(entry)}>继续同一动作</button>}
      </>}
      {entry && flow.phase === "changed" &&
        <button className="primary" type="button" disabled={busy} onClick={() => void controller.refreshChanged(entry)}>放弃本页未保存位置，读取当前条目并清除旧收据</button>}
      {entry && flow.phase === "refresh-only" &&
        <button className="primary" type="button" disabled={busy} onClick={() => void controller.refreshCommitted(entry)}>只读核对并重新读取</button>}
      {entry && flow.phase === "invalid" &&
        <button type="button" disabled={busy} onClick={() => void controller.dismissInvalid(entry)}>保留资料并清除提醒</button>}
    </footer>
  </section>;
}
