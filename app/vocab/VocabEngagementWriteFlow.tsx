"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  commitVocabEngagementWrite,
  inspectVocabEngagementWrite,
  prepareVocabBookmarkCreate,
  prepareVocabBookmarkDelete,
  prepareVocabBookmarkNoteSet,
  prepareVocabStudyActivityRecord,
  VocabEngagementMutationError,
  type VocabBookmarkCreateInput,
  type VocabBookmarkCreateReceipt,
  type VocabBookmarkDeleteInput,
  type VocabBookmarkDeleteReceipt,
  type VocabBookmarkExpectedState,
  type VocabBookmarkNoteSetInput,
  type VocabBookmarkNoteSetReceipt,
  type VocabEngagementGenerationExpectation,
  type VocabEngagementWriteReceipt,
  type VocabStudyActivityRecordInput,
} from "@/lib/vocab/store";
import {
  VOCAB_ENGAGEMENT_WRITE_PREFIX,
  claimVocabEngagementWrite,
  createVocabEngagementWriteEntry,
  createVocabEngagementWriteTicket,
  persistVocabEngagementWrite,
  readVocabEngagementWriteJournal,
  releaseVocabEngagementWrite,
  removeUnreadableVocabEngagementWrite,
  runWithCurrentVocabEngagementWrite,
  runWithMissingVocabEngagementWrite,
  selectVocabEngagementWriteRecoveryEntry,
  vocabEngagementHeldReceiptBarrier,
  type VocabEngagementWriteEntry,
  type VocabEngagementWriteJournal,
  type VocabEngagementWriteLease,
  type VocabEngagementWriteToken,
} from "./engagement-write-journal";
import {
  freezeVocabStudyActivity,
  freezeVocabBookmarkIntent,
  freezeVocabBookmarkMutationIntent,
  prepareVocabEngagementIntent,
  removeVocabStudyActivityHead,
  vocabBookmarkReceiptMatchesIntent,
  vocabBookmarkMutationReceiptMatchesIntent,
  vocabEngagementApplyRemovesTicket,
  vocabEngagementBackupGate,
  vocabEngagementExternalWriteBlocked,
  vocabEngagementUnloadRisk,
  vocabEngagementWritePreflightOpen,
  vocabStudyActivityReceiptMatchesQueue,
  type VocabEngagementApplyOutcome,
  type VocabQueuedStudyActivity,
} from "./engagement-write-state";

export type {
  VocabEngagementApplyOutcome,
  VocabQueuedStudyActivity,
} from "./engagement-write-state";

export type VocabEngagementStartResult = "fresh" | "attention";
export type VocabEngagementQueueResult = "queued" | "duplicate";

type JournalView = VocabEngagementWriteJournal & Readonly<{ loaded: boolean }>;
type WorkingAction = "prepare" | "commit" | "inspect" | "apply" | "journal";
type RecoveryPhase = "check" | "expected" | "changed" | "apply-only" | "invalid";
type Flow =
  | Readonly<{ phase: "idle" }>
  | Readonly<{
      phase: "working";
      action: WorkingAction;
      background: boolean;
    }>
  | Readonly<{
      phase: RecoveryPhase;
      entry: VocabEngagementWriteEntry;
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
    : "学习记录操作没有完成；现有资料没有被静默覆盖。";
}

class VocabEngagementPreparedReceiptMismatchError extends Error {
  readonly name = "VocabEngagementPreparedReceiptMismatchError";
}

class VocabEngagementExternalWritePausedError extends Error {
  readonly name = "VocabEngagementExternalWritePausedError";
}

function isActivity(receipt: VocabEngagementWriteReceipt): boolean {
  return receipt.kind === "study-activity-record";
}

function savedCopy(receipt: VocabEngagementWriteReceipt): string {
  if (isActivity(receipt)) return "学习时间已经确认记录。";
  if (receipt.kind === "bookmark-delete") return "书签已经确认删除。";
  if (receipt.kind === "bookmark-note-set") return "书签笔记已经确认保存。";
  return "书签已经确认保存。";
}

function phaseForEntry(entry: VocabEngagementWriteEntry): Flow {
  if (entry.ticket.kind === "committed") {
    return {
      phase: "apply-only",
      entry,
      message: `${savedCopy(entry.ticket.receipt)} 这里只先只读核对，再应用确认结果；不会再次写入。`,
    };
  }
  if (entry.ticket.kind === "changed") {
    return {
      phase: "changed",
      entry,
      message: "当前资料已经变化；旧动作不会覆盖新资料，只能读取并应用当前内容。",
    };
  }
  return {
    phase: "check",
    entry,
    message: "这次学习记录结果还没有确认。先只读核对，不会重复写入。",
  };
}

export function useVocabEngagementWriteFlow({
  applyConfirmed,
  applyCurrent,
  externalWriteLocked,
  externalWriteInProgress,
  onToast,
  onAttention,
}: {
  applyConfirmed: (
    receipt: VocabEngagementWriteReceipt,
  ) => Promise<VocabEngagementApplyOutcome>;
  applyCurrent: (
    receipt: VocabEngagementWriteReceipt,
  ) => Promise<VocabEngagementApplyOutcome>;
  externalWriteLocked: boolean;
  externalWriteInProgress: () => boolean;
  onToast: (message: string) => void;
  onAttention: () => void;
}) {
  const [journal, setJournal] = useState<JournalView>(EMPTY_JOURNAL);
  const [flow, setFlow] = useState<Flow>({ phase: "idle" });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [passiveNotice, setPassiveNotice] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);
  const [heldEntries, setHeldEntries] = useState<
    readonly VocabEngagementWriteEntry[]
  >([]);
  const [activityQueue, setActivityQueue] = useState<
    readonly VocabQueuedStudyActivity[]
  >([]);
  const [activityQueueIssue, setActivityQueueIssue] = useState("");
  const journalRef = useRef<JournalView>(EMPTY_JOURNAL);
  const operationRef = useRef<VocabEngagementWriteToken | null>(null);
  const heldEntriesRef = useRef(
    new Map<string, VocabEngagementWriteEntry>(),
  );
  const activityQueueRef = useRef<readonly VocabQueuedStudyActivity[]>([]);
  const activityQueueIssueRef = useRef("");
  const activitySequenceRef = useRef(0);
  const queuedInputObjectsRef = useRef(new WeakSet<object>());
  const appliedOperationIdsRef = useRef(new Set<string>());
  const activityTimerRef = useRef<number | null>(null);
  const pumpActivityRef = useRef<() => Promise<void>>(async () => undefined);
  const externalWriteLockedRef = useRef(externalWriteLocked);
  const externalWriteInProgressRef = useRef(externalWriteInProgress);
  const bookmarkTriggerRef = useRef<Readonly<{
    operationId: string;
    trigger: HTMLElement;
  }> | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const mountedRef = useRef(false);

  const externalWriteBlockedNow = useCallback(() =>
    vocabEngagementExternalWriteBlocked(
      externalWriteLockedRef.current,
      externalWriteInProgressRef.current,
    ), []);

  const busy = flow.phase === "working";
  const heldBarrier = vocabEngagementHeldReceiptBarrier(
    heldEntries.map((entry) => entry.ticket.receipt.operationId),
    journal.entries.map((entry) => entry.ticket.receipt.operationId),
  );
  const hasHeldReceipt = heldBarrier.blocksWrites;
  const hasVolatileHeldReceipt = heldBarrier.volatile;
  const queuedActivityCount = activityQueue.length;
  const hasQueuedActivity = queuedActivityCount > 0;
  const externalWriteBlocked = externalWriteLocked;
  const expectedContinuationBlocked = busy || externalWriteBlocked ||
    !journal.loaded || journal.storageUnavailable || journal.lockUnavailable ||
    journal.unreadable.length > 0;
  const writeLocked = !vocabEngagementWritePreflightOpen({
    journalLoaded: journal.loaded,
    storageUnavailable: journal.storageUnavailable,
    lockUnavailable: journal.lockUnavailable,
    unreadableCount: journal.unreadable.length,
    entryCount: journal.entries.length,
    hasHeldReceipt,
    operationInProgress: busy,
    externalWriteLocked: externalWriteBlocked,
  }) || hasQueuedActivity;
  const backupGate = vocabEngagementBackupGate({
    journalLoaded: journal.loaded,
    storageUnavailable: journal.storageUnavailable,
    lockUnavailable: journal.lockUnavailable,
    unreadableCount: journal.unreadable.length,
    entryCount: journal.entries.length,
    busy,
    queuedActivityCount,
    hasHeldReceipt,
    hasVolatileHeldReceipt,
  });

  const reloadJournal = useCallback(() => {
    let next: VocabEngagementWriteJournal;
    try {
      next = readVocabEngagementWriteJournal();
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
    if (mountedRef.current) setJournal(loaded);
    return next;
  }, []);

  const publishActivityQueue = useCallback((
    next: readonly VocabQueuedStudyActivity[],
  ) => {
    activityQueueRef.current = next;
    setActivityQueue(next);
  }, []);

  const publishActivityQueueIssue = useCallback((message: string) => {
    activityQueueIssueRef.current = message;
    setActivityQueueIssue(message);
  }, []);

  const clearActivityTimer = useCallback(() => {
    if (activityTimerRef.current === null) return;
    window.clearTimeout(activityTimerRef.current);
    activityTimerRef.current = null;
  }, []);

  const scheduleActivity = useCallback((delay = 0) => {
    if (activityTimerRef.current !== null ||
        activityQueueRef.current.length === 0 ||
        activityQueueIssueRef.current) return;
    const nextDelay = externalWriteBlockedNow()
      ? Math.max(delay, 1_000)
      : delay;
    activityTimerRef.current = window.setTimeout(() => {
      activityTimerRef.current = null;
      void pumpActivityRef.current();
    }, nextDelay);
  }, [externalWriteBlockedNow]);

  const holdEntry = useCallback((entry: VocabEngagementWriteEntry) => {
    heldEntriesRef.current.set(entry.ticket.receipt.operationId, entry);
    setHeldEntries([...heldEntriesRef.current.values()]);
  }, []);

  const clearHeldEntry = useCallback((receipt?: VocabEngagementWriteReceipt) => {
    if (receipt) heldEntriesRef.current.delete(receipt.operationId);
    else heldEntriesRef.current.clear();
    setHeldEntries([...heldEntriesRef.current.values()]);
  }, []);

  const present = useCallback((
    next: Flow,
    background: boolean,
    passiveMessage?: string,
  ) => {
    if ("entry" in next) holdEntry(next.entry);
    if (background) {
      setFlow({ phase: "idle" });
      setPassiveNotice(passiveMessage ?? ("message" in next ? next.message : ""));
      return;
    }
    setFlow(next);
    setFocusRequest((current) => current + 1);
    onAttention();
  }, [holdEntry, onAttention]);

  const claim = useCallback((action: WorkingAction, background: boolean) => {
    const token = claimVocabEngagementWrite(operationRef);
    if (token) {
      setError("");
      setFlow({ phase: "working", action, background });
    }
    return token;
  }, []);

  const release = useCallback((token: VocabEngagementWriteToken) => {
    releaseVocabEngagementWrite(operationRef, token);
    if (activityQueueRef.current.length > 0) scheduleActivity();
  }, [scheduleActivity]);

  useLayoutEffect(() => {
    externalWriteLockedRef.current = externalWriteLocked;
    externalWriteInProgressRef.current = externalWriteInProgress;
    clearActivityTimer();
    if (activityQueueRef.current.length > 0) scheduleActivity();
  }, [clearActivityTimer, externalWriteInProgress, externalWriteLocked, scheduleActivity]);

  useEffect(() => {
    mountedRef.current = true;
    reloadJournal();
    const onStorage = (event: StorageEvent) => {
      if (
        event.storageArea === window.localStorage &&
        (event.key === null ||
          event.key.startsWith(VOCAB_ENGAGEMENT_WRITE_PREFIX))
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
      mountedRef.current = false;
      clearActivityTimer();
      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [clearActivityTimer, reloadJournal]);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      const currentJournal = journalRef.current;
      const barrier = vocabEngagementHeldReceiptBarrier(
        heldEntriesRef.current.keys(),
        currentJournal.entries.map((entry) =>
          entry.ticket.receipt.operationId
        ),
      );
      if (vocabEngagementUnloadRisk({
        busy: Boolean(operationRef.current),
        queuedActivityCount: activityQueueRef.current.length,
        hasVolatileHeldReceipt: barrier.volatile,
      })) event.preventDefault();
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);

  const restoreBookmarkFocus = useCallback((
    receipt: VocabEngagementWriteReceipt,
  ) => {
    const binding = bookmarkTriggerRef.current;
    if (!binding || binding.operationId !== receipt.operationId) return;
    bookmarkTriggerRef.current = null;
    if (focusFrameRef.current !== null) {
      window.cancelAnimationFrame(focusFrameRef.current);
    }
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = window.requestAnimationFrame(() => {
        focusFrameRef.current = null;
        const trigger = binding.trigger;
        const preferred =
          trigger.isConnected && !trigger.matches(":disabled") &&
          trigger.getClientRects().length > 0 &&
          window.getComputedStyle(trigger).visibility !== "hidden"
            ? trigger
            : null;
        const target = preferred ?? document.querySelector<HTMLElement>(
          "[data-bookmark-list] h2, [data-reader-bookmark-fallback], [data-podcast-bookmark-fallback], .sc-reader h1, .sc-podcast-head h1, .sc-main h1",
        );
        if (!target?.isConnected || target.getClientRects().length === 0) return;
        if (target.matches("h1,h2")) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      });
    });
  }, []);

  const clearBookmarkBinding = useCallback((
    receipt: VocabEngagementWriteReceipt,
  ) => {
    if (bookmarkTriggerRef.current?.operationId === receipt.operationId) {
      bookmarkTriggerRef.current = null;
    }
  }, []);

  const setSafelyIdle = useCallback((
    receipt: VocabEngagementWriteReceipt,
    background: boolean,
  ) => {
    clearHeldEntry(receipt);
    const current = reloadJournal();
    const next = selectVocabEngagementWriteRecoveryEntry(
      [...heldEntriesRef.current.values()],
      current.entries,
    );
    if (next) holdEntry(next);
    if (background) setFlow({ phase: "idle" });
    else setFlow(next ? phaseForEntry(next) : { phase: "idle" });
  }, [clearHeldEntry, holdEntry, reloadJournal]);

  const restoreLatestFlowOrIdle = useCallback(() => {
    const latest = reloadJournal();
    const next = selectVocabEngagementWriteRecoveryEntry(
      [...heldEntriesRef.current.values()],
      latest.entries,
    );
    if (next) holdEntry(next);
    setFlow(next
      ? latest.entries.includes(next)
        ? phaseForEntry(next)
        : {
            phase: "check",
            entry: next,
            message: "原收据仍只保留在本页；下一步只能重新 checkpoint 并只读核对。",
          }
      : { phase: "idle" });
    return latest;
  }, [holdEntry, reloadJournal]);

  const reopenLatest = useCallback((
    entry: VocabEngagementWriteEntry,
    background: boolean,
  ) => {
    holdEntry(entry);
    const current = reloadJournal();
    const next = selectVocabEngagementWriteRecoveryEntry(
      [...heldEntriesRef.current.values()],
      current.entries,
    );
    if (!next || !current.entries.includes(next)) {
      present({
        phase: "check",
        entry: next ?? entry,
        message: "另一页移除了这条提醒；原收据仍保留在本页，只能重新 checkpoint 后只读核对。",
      }, background, "有一条仅保留在本页的学习记录收据待核对。");
      setError(
        "原收据暂时只保留在本页；核对完成前不会开始另一笔学习记录写入。",
      );
      return;
    }
    present(phaseForEntry(next), background);
  }, [holdEntry, present, reloadJournal]);

  const removeCurrent = useCallback(async (
    entry: VocabEngagementWriteEntry,
  ) => {
    const result = await runWithCurrentVocabEngagementWrite(
      entry,
      (lease) => lease.remove(),
    );
    reloadJournal();
    return result.outcome;
  }, [reloadJournal]);

  const inspectEntryWithLease = useCallback((
    entry: VocabEngagementWriteEntry,
    missing: boolean,
  ) => {
    const operation = async (lease: VocabEngagementWriteLease) => {
      const inspection = await inspectVocabEngagementWrite(
        entry.ticket.receipt,
      );
      if (inspection === "exact_saved") lease.committed();
      else if (inspection === "changed") lease.changed();
      return inspection;
    };
    return missing
      ? runWithMissingVocabEngagementWrite(entry, operation)
      : runWithCurrentVocabEngagementWrite(entry, operation);
  }, []);

  const finishCommitted = useCallback(async (
    entry: VocabEngagementWriteEntry,
    background: boolean,
  ): Promise<VocabEngagementStartResult> => {
    const receipt = entry.ticket.receipt;
    holdEntry(entry);
    setFlow({ phase: "working", action: "apply", background });
    if (background && isActivity(receipt)) setStatus("");
    else setStatus(savedCopy(receipt));
    setError("");
    let outcome: VocabEngagementApplyOutcome = "applied";
    if (!appliedOperationIdsRef.current.has(receipt.operationId)) {
      try {
        outcome = await applyConfirmed(receipt);
      } catch (reason) {
        setError(reasonMessage(reason));
        present({
          phase: "apply-only",
          entry,
          message: `${savedCopy(receipt)} 页面暂时没有应用确认结果；不要重复提交。`,
        }, background, `${savedCopy(receipt)} 页面待应用确认结果。`);
        return "attention";
      }
      if (vocabEngagementApplyRemovesTicket(outcome)) {
        appliedOperationIdsRef.current.add(receipt.operationId);
      }
    }
    if (!vocabEngagementApplyRemovesTicket(outcome)) {
      present({
        phase: "apply-only",
        entry,
        message: outcome === "deferred"
          ? `${savedCopy(receipt)} 页面仍有需要保留的本地内容；收据不会提前清除。`
          : `${savedCopy(receipt)} 这次应用已被更新请求取代；收据仍保留。`,
      }, background, `${savedCopy(receipt)} 页面待应用确认结果。`);
      return "attention";
    }
    try {
      const removal = await removeCurrent(entry);
      if (removal === "blocked") {
        present({
          phase: "apply-only",
          entry,
          message: `${savedCopy(receipt)} 页面已应用，但核对提醒仍无法完整验证。`,
        }, background, `${savedCopy(receipt)} 核对提醒仍待处理。`);
        return "attention";
      }
      if (removal === "stale") {
        reopenLatest(entry, background);
        return "attention";
      }
      setSafelyIdle(receipt, background);
      if (background && isActivity(receipt)) setStatus("");
      else setStatus(savedCopy(receipt));
      setPassiveNotice("");
      if (!isActivity(receipt) &&
          bookmarkTriggerRef.current?.operationId === receipt.operationId) {
        onToast(savedCopy(receipt));
        restoreBookmarkFocus(receipt);
      }
      return "fresh";
    } catch (reason) {
      setError(reasonMessage(reason));
      present({
        phase: "apply-only",
        entry,
        message: `${savedCopy(receipt)} 页面已经应用；只是提醒暂时没有收起。`,
      }, background, `${savedCopy(receipt)} 核对提醒仍待处理。`);
      return "attention";
    }
  }, [applyConfirmed, holdEntry, onToast, present, removeCurrent, reopenLatest, restoreBookmarkFocus, setSafelyIdle]);

  const settleInspectionResult = useCallback(async (
    result: Awaited<ReturnType<typeof inspectEntryWithLease>>,
    held: VocabEngagementWriteEntry,
    background: boolean,
  ): Promise<VocabEngagementStartResult> => {
    reloadJournal();
    if (result.outcome === "blocked") {
      present({
        phase: "check",
        entry: held,
        message: "当前无法完整验证全部学习记录提醒；原收据仍保留，没有调用写入。",
      }, background, "有学习记录收据等待安全核对。");
      setError("核对存储尚未安全可用；所有学习记录写入保持暂停。");
      return "attention";
    }
    if (result.outcome === "stale") {
      reopenLatest(held, background);
      return "attention";
    }
    if (result.value === "exact_saved" && result.entry) {
      return finishCommitted(result.entry, background);
    }
    const entry = result.entry ?? held;
    if (result.value === "expected") {
      present({
        phase: "expected",
        entry,
        message: isActivity(entry.ticket.receipt)
          ? "这段学习时间确定还没有写入。可以安全放弃，或明确继续同一张收据。"
          : "这个书签确定还没有写入。可以放弃，或明确继续同一张收据。",
      }, background, "有一条确定未写入的学习记录等待选择。");
    } else if (result.value === "changed") {
      clearBookmarkBinding(entry.ticket.receipt);
      present({
        phase: "changed",
        entry,
        message: "当前资料已经变化；旧动作没有覆盖现有资料，也不会再次写入。",
      }, background, "一条学习记录因资料已变化而停止，等待只读更新。");
    } else if (result.value === "invalid_receipt") {
      clearBookmarkBinding(entry.ticket.receipt);
      present({
        phase: "invalid",
        entry,
        message: "这份学习记录收据无法验证；没有据此写入。",
      }, background, "有一条无法验证的学习记录提醒。");
    } else {
      present({
        phase: "check",
        entry,
        message: "结果仍无法确认；收据继续保留，只允许再次只读核对。",
      }, background, "有学习记录结果尚未确认；不会自动重试。");
    }
    return "attention";
  }, [clearBookmarkBinding, finishCommitted, present, reloadJournal, reopenLatest]);

  const inspectEntry = useCallback(async (
    entry: VocabEngagementWriteEntry,
    background: boolean,
  ): Promise<VocabEngagementStartResult> => {
    let result = await inspectEntryWithLease(entry, false);
    if (result.outcome === "stale") {
      holdEntry(entry);
      result = await inspectEntryWithLease(entry, true);
    }
    return settleInspectionResult(result, entry, background);
  }, [holdEntry, inspectEntryWithLease, settleInspectionResult]);

  const commitEntry = useCallback(async (
    entry: VocabEngagementWriteEntry,
    background: boolean,
  ): Promise<VocabEngagementStartResult> => {
    setFlow({ phase: "working", action: "commit", background });
    try {
      const result = await runWithCurrentVocabEngagementWrite(
        entry,
        async (lease) => {
          if (externalWriteBlockedNow()) {
            return "external-blocked" as const;
          }
          try {
            const committed = await commitVocabEngagementWrite(
              entry.ticket.receipt,
            );
            if (
              committed.outcome === "saved" ||
              committed.outcome === "already_saved"
            ) {
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
              reason instanceof VocabEngagementMutationError &&
              reason.code === "write_failed"
            ) return "expected" as const;
            throw reason;
          }
        },
      );
      reloadJournal();
      if (result.outcome === "blocked") {
        reopenLatest(entry, background);
        setError("现有学习记录没有改变；先处理全局安全提醒。");
        return "attention";
      }
      if (result.outcome === "stale") {
        return inspectEntry(entry, background);
      }
      if (result.value === "saved" && result.entry) {
        return finishCommitted(result.entry, background);
      }
      if (result.value === "changed" && result.entry) {
        clearBookmarkBinding(entry.ticket.receipt);
        present({
          phase: "changed",
          entry: result.entry,
          message: "资料已经在别处变化；旧动作没有覆盖当前内容，也不会再次写入。",
        }, background, "一条学习记录因资料已变化而停止，等待只读更新。");
      } else if (result.value === "expected") {
        present({
          phase: "expected",
          entry,
          message: isActivity(entry.ticket.receipt)
            ? "这段学习时间确定没有写入。可以安全放弃，或明确继续同一张收据。"
            : "这个书签确定没有写入。可以放弃，或明确继续同一张收据。",
        }, background, "有一条确定未写入的学习记录等待选择。");
      } else if (result.value === "external-blocked") {
        present({
          phase: "check",
          entry,
          message: "另一笔数据库安全操作正在进行；收据仍保留，没有调用学习记录写入。",
        }, background, "学习记录收据已保留，等待另一笔安全操作结束。");
      } else {
        present({
          phase: "check",
          entry,
          message: "这次学习记录结果仍需只读核对；不会凭猜测重复写入。",
        }, background, "有学习记录结果尚未确认；不会自动重试。");
      }
      return "attention";
    } catch (reason) {
      reloadJournal();
      present({
        phase: "check",
        entry,
        message: "这次学习记录结果需要只读核对；收据仍保留。",
      }, background, "有学习记录结果尚未确认；不会自动重试。");
      setError(reasonMessage(reason));
      return "attention";
    }
  }, [clearBookmarkBinding, externalWriteBlockedNow, finishCommitted, inspectEntry, present, reloadJournal, reopenLatest]);

  const dropSubmittedActivity = useCallback((
    submitted: VocabQueuedStudyActivity,
  ) => {
    publishActivityQueueIssue("");
    publishActivityQueue(removeVocabStudyActivityHead(
      activityQueueRef.current,
      submitted,
    ));
  }, [publishActivityQueue, publishActivityQueueIssue]);

  const startPrepared = useCallback(async (
    prepare: () => Promise<VocabEngagementWriteReceipt>,
    receiptMatches: (receipt: VocabEngagementWriteReceipt) => boolean,
    background: boolean,
    trigger: HTMLElement | null,
    submittedActivity: VocabQueuedStudyActivity | null,
  ): Promise<VocabEngagementStartResult> => {
    const token = claim("prepare", background);
    if (!token) return "attention";
    let preparedEntry: VocabEngagementWriteEntry | null = null;
    let durableEntry: VocabEngagementWriteEntry | null = null;
    try {
      if (externalWriteBlockedNow()) {
        throw new VocabEngagementExternalWritePausedError(
          "另一笔数据库安全操作正在进行；没有准备新的学习记录写入。",
        );
      }
      const current = reloadJournal();
      if (
        submittedActivity
          ? activityQueueRef.current[0]?.sequence !==
            submittedActivity.sequence
          : activityQueueRef.current.length > 0
      ) {
        throw new Error(
          "已有学习时间片按顺序等待处理；没有越过队列准备书签。",
        );
      }
      if (!vocabEngagementWritePreflightOpen({
        journalLoaded: true,
        storageUnavailable: current.storageUnavailable,
        lockUnavailable: current.lockUnavailable,
        unreadableCount: current.unreadable.length,
        entryCount: current.entries.length,
        hasHeldReceipt: heldEntriesRef.current.size > 0,
        operationInProgress: false,
        externalWriteLocked: externalWriteBlockedNow(),
      })) {
        throw new Error(
          "学习记录安全门尚未开放；没有准备新的写入。",
        );
      }
      const prepared = await prepareVocabEngagementIntent(
        externalWriteBlockedNow,
        prepare,
        receiptMatches,
      );
      if (prepared.outcome === "external-blocked") {
        throw new VocabEngagementExternalWritePausedError(
          prepared.stage === "after-prepare"
            ? "准备期间另一笔数据库安全操作开始；原动作仍保留，且没有保存或提交收据。"
            : "另一笔数据库安全操作正在进行；没有准备新的学习记录写入。",
        );
      }
      if (prepared.outcome === "receipt-mismatch") {
        throw new VocabEngagementPreparedReceiptMismatchError(
          "准备返回的收据不属于冻结的原动作；没有保存或提交这张收据。",
        );
      }
      const receipt = prepared.receipt;
      if (externalWriteBlockedNow()) {
        throw new VocabEngagementExternalWritePausedError(
          "准备后另一笔数据库安全操作开始；原动作仍保留，且没有保存或提交收据。",
        );
      }
      preparedEntry = createVocabEngagementWriteEntry(
        createVocabEngagementWriteTicket(receipt),
      );
      holdEntry(preparedEntry);
      if (submittedActivity) dropSubmittedActivity(submittedActivity);
      if (trigger && !isActivity(receipt)) {
        bookmarkTriggerRef.current = {
          operationId: receipt.operationId,
          trigger,
        };
      }
      durableEntry = await persistVocabEngagementWrite(preparedEntry.ticket);
      if (externalWriteBlockedNow()) {
        holdEntry(durableEntry);
        reloadJournal();
        present({
          phase: "check",
          entry: durableEntry,
          message: "收据已经安全保留；另一笔数据库操作结束前不会提交。",
        }, background, "学习记录收据已保留，等待另一笔安全操作结束。");
        return "attention";
      }
      holdEntry(durableEntry);
      reloadJournal();
      return commitEntry(durableEntry, background);
    } catch (reason) {
      if (durableEntry) {
        present({
          phase: "check",
          entry: durableEntry,
          message: "这次学习记录结果需要只读核对；收据仍保留。",
        }, background, "有学习记录结果尚未确认；不会自动重试。");
        setError(reasonMessage(reason));
        return "attention";
      }
      const recovered = reloadJournal();
      const recoveredEntry = preparedEntry
        ? recovered.entries.find((candidate) =>
            candidate.ticket.receipt.operationId ===
              preparedEntry?.ticket.receipt.operationId
          ) ?? null
        : null;
      const selection = preparedEntry
        ? selectVocabEngagementWriteRecoveryEntry(
            [preparedEntry],
            recovered.entries,
          )
        : null;
      if (
        preparedEntry && selection && recovered.entries.includes(selection) &&
        selection.storageKey !== preparedEntry.storageKey
      ) {
        holdEntry(preparedEntry);
        present(phaseForEntry(selection), background,
          "另一张耐久学习记录收据需要先处理。");
        setError(
          `${reasonMessage(reason)} 原收据仍保留在本页，之后只能重新 checkpoint 并只读核对。`,
        );
        return "attention";
      }
      if (recoveredEntry) {
        holdEntry(recoveredEntry);
        return commitEntry(recoveredEntry, background);
      }
      if (preparedEntry) {
        holdEntry(preparedEntry);
        try {
          return await inspectEntry(preparedEntry, background);
        } catch (recoveryReason) {
          const checkpointed = reloadJournal().entries.find((candidate) =>
            candidate.ticket.receipt.operationId ===
              preparedEntry?.ticket.receipt.operationId
          );
          if (checkpointed) holdEntry(checkpointed);
          present({
            phase: "check",
            entry: checkpointed ?? preparedEntry,
            message: checkpointed
              ? "原收据已经重新 checkpoint；只读核对尚未完成，不会自动重试。"
              : "原收据暂时只保留在本页；只读核对尚未完成。",
          }, background, "有一条仅保留在本页的学习记录收据待核对。");
          setError(reasonMessage(recoveryReason));
          return "attention";
        }
      }
      if (reason instanceof VocabEngagementPreparedReceiptMismatchError) {
        if (submittedActivity) {
          publishActivityQueueIssue(
            "准备结果和原学习时间片不一致。队首与后续时间片仍按原顺序保留；请放弃队首后再继续。",
          );
          setPassiveNotice(
            "有一段学习时间因准备结果不一致而暂停；没有保存或提交收据。",
          );
        } else {
          setError(reasonMessage(reason));
        }
        setFlow({ phase: "idle" });
        return "attention";
      }
      if (reason instanceof VocabEngagementExternalWritePausedError) {
        setFlow({ phase: "idle" });
        if (submittedActivity) {
          publishActivityQueueIssue("");
          setPassiveNotice(
            "学习时间仍保留在本页队列；另一笔安全操作结束后会按原时间、原时区与原世代继续准备。",
          );
          scheduleActivity(1_000);
        } else {
          setError(reasonMessage(reason));
        }
        return "attention";
      }
      if (submittedActivity) {
        if (
          reason instanceof VocabEngagementMutationError &&
          (reason.code === "changed" || reason.code === "invalid_input")
        ) {
          dropSubmittedActivity(submittedActivity);
          setFlow({ phase: "idle" });
          setPassiveNotice(
            "一段学习时间不再属于当前数据库世代，已经安全停止；没有改写当前资料。",
          );
        } else {
          publishActivityQueueIssue("");
          setFlow({ phase: "idle" });
          setPassiveNotice(
            "学习时间仍保留在本页队列；安全条件恢复后会按原时间与原世代继续准备。",
          );
          scheduleActivity(1_000);
        }
        return "attention";
      }
      setError(reasonMessage(reason));
      setFlow({ phase: "idle" });
      onAttention();
      setFocusRequest((current) => current + 1);
      return "attention";
    } finally {
      release(token);
    }
  }, [claim, commitEntry, dropSubmittedActivity, externalWriteBlockedNow, holdEntry, inspectEntry, onAttention, present, publishActivityQueueIssue, release, reloadJournal, scheduleActivity]);

  const pumpActivity = useCallback(async () => {
    const submitted = activityQueueRef.current[0];
    if (!submitted || operationRef.current) return;
    if (externalWriteBlockedNow()) {
      scheduleActivity(1_000);
      return;
    }
    const current = reloadJournal();
    if (!vocabEngagementWritePreflightOpen({
      journalLoaded: true,
      storageUnavailable: current.storageUnavailable,
      lockUnavailable: current.lockUnavailable,
      unreadableCount: current.unreadable.length,
      entryCount: current.entries.length,
      hasHeldReceipt: heldEntriesRef.current.size > 0,
      operationInProgress: Boolean(operationRef.current),
      externalWriteLocked: externalWriteBlockedNow(),
    })) {
      scheduleActivity(1_000);
      return;
    }
    publishActivityQueueIssue("");
    await startPrepared(
      () => prepareVocabStudyActivityRecord(
        {
          kind: submitted.input.kind,
          seconds: submitted.input.seconds,
          recordedAt: submitted.input.recordedAt,
          timezoneOffsetMinutes: submitted.timezoneOffsetMinutes,
        },
        submitted.displayedGeneration,
      ),
      (receipt) => vocabStudyActivityReceiptMatchesQueue(receipt, submitted),
      true,
      null,
      submitted,
    );
  }, [externalWriteBlockedNow, publishActivityQueueIssue, reloadJournal, scheduleActivity, startPrepared]);

  useLayoutEffect(() => {
    pumpActivityRef.current = pumpActivity;
  }, [pumpActivity]);

  const queueActivity = useCallback((
    input: VocabStudyActivityRecordInput,
    displayedGeneration: VocabEngagementGenerationExpectation,
  ): VocabEngagementQueueResult => {
    if (queuedInputObjectsRef.current.has(input)) return "duplicate";
    const frozen = freezeVocabStudyActivity(
      input,
      displayedGeneration,
      ++activitySequenceRef.current,
    );
    queuedInputObjectsRef.current.add(input);
    const queueWasEmpty = activityQueueRef.current.length === 0;
    publishActivityQueue([...activityQueueRef.current, frozen]);
    if (queueWasEmpty) publishActivityQueueIssue("");
    scheduleActivity();
    return "queued";
  }, [publishActivityQueue, publishActivityQueueIssue, scheduleActivity]);

  const startBookmark = useCallback(async (
    input: VocabBookmarkCreateInput,
    expected: VocabBookmarkExpectedState,
    trigger: HTMLElement,
    prepare: (
      frozenInput: VocabBookmarkCreateInput,
      frozenExpected: VocabBookmarkExpectedState,
    ) => Promise<VocabBookmarkCreateReceipt> = prepareVocabBookmarkCreate,
  ): Promise<VocabEngagementStartResult> => {
    const intent = freezeVocabBookmarkIntent(input, expected);
    return startPrepared(
      () => prepare(intent.input, intent.expected),
      (receipt) => receipt.kind === "bookmark-create" &&
        vocabBookmarkReceiptMatchesIntent(receipt, intent),
      false,
      trigger,
      null,
    );
  }, [startPrepared]);

  const startBookmarkMutation = useCallback(async (
    kind: "bookmark-note-set" | "bookmark-delete",
    input: VocabBookmarkNoteSetInput | VocabBookmarkDeleteInput,
    expected: VocabBookmarkExpectedState,
    trigger: HTMLElement,
    prepare: (
      frozenInput: VocabBookmarkNoteSetInput | VocabBookmarkDeleteInput,
      frozenExpected: VocabBookmarkExpectedState,
    ) => Promise<VocabBookmarkNoteSetReceipt | VocabBookmarkDeleteReceipt> =
      kind === "bookmark-note-set"
        ? (frozenInput, frozenExpected) => prepareVocabBookmarkNoteSet(
            frozenInput as VocabBookmarkNoteSetInput,
            frozenExpected,
          )
        : (frozenInput, frozenExpected) => prepareVocabBookmarkDelete(
            frozenInput as VocabBookmarkDeleteInput,
            frozenExpected,
          ),
  ): Promise<VocabEngagementStartResult> => {
    const intent = freezeVocabBookmarkMutationIntent(kind, input, expected);
    return startPrepared(
      () => prepare(intent.input, intent.expected),
      (receipt) => (receipt.kind === "bookmark-note-set" ||
          receipt.kind === "bookmark-delete") &&
        vocabBookmarkMutationReceiptMatchesIntent(receipt, intent),
      false,
      trigger,
      null,
    );
  }, [startPrepared]);

  const open = useCallback((entry?: VocabEngagementWriteEntry) => {
    if (operationRef.current) return;
    const current = reloadJournal();
    const next = entry ?? selectVocabEngagementWriteRecoveryEntry(
      [...heldEntriesRef.current.values()],
      current.entries,
    );
    setError("");
    if (next) holdEntry(next);
    setFlow(next
      ? current.entries.includes(next)
        ? phaseForEntry(next)
        : {
            phase: "check",
            entry: next,
            message: "原收据暂时只保留在本页；先重新 checkpoint，再只读核对。",
          }
      : { phase: "idle" });
    setFocusRequest((value) => value + 1);
    onAttention();
  }, [holdEntry, onAttention, reloadJournal]);

  const inspect = useCallback(async (entry: VocabEngagementWriteEntry) => {
    const token = claim("inspect", false);
    if (!token) return;
    try {
      await inspectEntry(entry, false);
    } catch (reason) {
      setError(reasonMessage(reason));
      present({
        phase: "check",
        entry,
        message: "只读核对没有完成；原收据仍保留。",
      }, false);
    } finally {
      release(token);
    }
  }, [claim, inspectEntry, present, release]);

  const continueExpected = useCallback(async (
    entry: VocabEngagementWriteEntry,
  ) => {
    if (externalWriteBlockedNow()) {
      present({
        phase: "expected",
        entry,
        message: "这张收据仍保留；另一笔数据库安全操作结束前不会继续写入。",
      }, false);
      setError("当前安全门尚未开放；没有调用学习记录写入。");
      return;
    }
    const current = reloadJournal();
    const selected = selectVocabEngagementWriteRecoveryEntry(
      [...heldEntriesRef.current.values()],
      current.entries,
    );
    const exactSole = Boolean(
      selected && selected.storageKey === entry.storageKey &&
      selected.raw === entry.raw && current.entries.length === 1 &&
      current.entries[0]?.storageKey === entry.storageKey &&
      current.entries[0]?.raw === entry.raw,
    );
    if (
      current.storageUnavailable || current.lockUnavailable ||
      current.unreadable.length > 0 || !exactSole ||
      externalWriteBlockedNow()
    ) {
      if (selected && current.entries.includes(selected) &&
          selected.storageKey !== entry.storageKey) {
        present(phaseForEntry(selected), false);
      } else {
        present({
          phase: "expected",
          entry,
          message: "这张收据仍保留；安全门完整开放前不会继续写入。",
        }, false);
      }
      setError("当前安全门尚未开放；没有调用学习记录写入。");
      return;
    }
    const token = claim("commit", false);
    if (!token) return;
    try {
      if (externalWriteBlockedNow()) {
        present({
          phase: "expected",
          entry,
          message: "这张收据仍保留；另一笔数据库安全操作结束前不会继续写入。",
        }, false);
        setError("当前安全门尚未开放；没有调用学习记录写入。");
        return;
      }
      await commitEntry(entry, false);
    } catch (reason) {
      restoreLatestFlowOrIdle();
      setError(reasonMessage(reason));
    } finally {
      release(token);
    }
  }, [claim, commitEntry, externalWriteBlockedNow, present, release, reloadJournal, restoreLatestFlowOrIdle]);

  const discardExpected = useCallback(async (
    entry: VocabEngagementWriteEntry,
  ) => {
    const token = claim("journal", false);
    if (!token) return;
    try {
      const result = await removeCurrent(entry);
      if (result === "blocked") {
        present({
          phase: "expected",
          entry,
          message: "出现了无法验证的跨页面提醒；这条收据仍保留。",
        }, false);
      } else if (result === "stale") reopenLatest(entry, false);
      else {
        clearBookmarkBinding(entry.ticket.receipt);
        setSafelyIdle(entry.ticket.receipt, false);
        setStatus("这次确定未写入的学习记录收据已经清除；现有资料没有改变。");
        setPassiveNotice("");
      }
    } catch (reason) {
      setError(reasonMessage(reason));
      present({
        phase: "expected",
        entry,
        message: "清除提醒没有完成；原收据仍保留。",
      }, false);
    } finally {
      release(token);
    }
  }, [claim, clearBookmarkBinding, present, release, removeCurrent, reopenLatest, setSafelyIdle]);

  const applyCommitted = inspect;

  const applyChanged = useCallback(async (
    entry: VocabEngagementWriteEntry,
  ) => {
    const token = claim("apply", false);
    if (!token) return;
    try {
      const outcome = await applyCurrent(entry.ticket.receipt);
      if (!vocabEngagementApplyRemovesTicket(outcome)) {
        present({
          phase: "changed",
          entry,
          message: outcome === "deferred"
            ? "当前内容尚未完整应用；旧收据继续保留。"
            : "这次读取已被更新请求取代；旧收据继续保留。",
        }, false);
        return;
      }
      const removal = await removeCurrent(entry);
      if (removal === "blocked") {
        present({
          phase: "changed",
          entry,
          message: "当前内容已经应用，但旧提醒暂时不能安全清除。",
        }, false);
      } else if (removal === "stale") reopenLatest(entry, false);
      else {
        clearBookmarkBinding(entry.ticket.receipt);
        setSafelyIdle(entry.ticket.receipt, false);
        setStatus("已经读取并应用当前资料；旧动作没有覆盖或改写它。");
        setPassiveNotice("");
      }
    } catch (reason) {
      setError(reasonMessage(reason));
      present({
        phase: "changed",
        entry,
        message: "当前资料尚未完整读取；旧收据继续保留。",
      }, false);
    } finally {
      release(token);
    }
  }, [applyCurrent, claim, clearBookmarkBinding, present, release, removeCurrent, reopenLatest, setSafelyIdle]);

  const dismissInvalid = useCallback(async (
    entry: VocabEngagementWriteEntry,
  ) => {
    const token = claim("journal", false);
    if (!token) return;
    try {
      const result = await removeCurrent(entry);
      if (result === "stale") reopenLatest(entry, false);
      else if (result === "blocked") {
        present({
          phase: "invalid",
          entry,
          message: "出现了无法验证的提醒；这条旧提醒仍保留。",
        }, false);
      } else {
        clearBookmarkBinding(entry.ticket.receipt);
        setSafelyIdle(entry.ticket.receipt, false);
      }
    } catch (reason) {
      setError(reasonMessage(reason));
      present({
        phase: "invalid",
        entry,
        message: "清除旧提醒没有完成；原提醒仍保留。",
      }, false);
    } finally {
      release(token);
    }
  }, [claim, clearBookmarkBinding, present, release, removeCurrent, reopenLatest, setSafelyIdle]);

  const clearUnreadable = useCallback(async () => {
    const token = claim("journal", false);
    if (!token) return;
    try {
      const current = reloadJournal();
      for (const entry of current.unreadable) {
        if (!await removeUnreadableVocabEngagementWrite(entry)) {
          throw new Error(
            "另一页已经改动了一条无法验证的学习记录提醒。",
          );
        }
      }
      const latest = restoreLatestFlowOrIdle();
      if (latest.unreadable.length === 0) {
        setStatus("无法验证的学习记录提醒已经清除；现有资料没有改变。");
      } else {
        setError("仍有无法验证的学习记录提醒；现有资料没有改变。");
      }
    } catch (reason) {
      restoreLatestFlowOrIdle();
      setError(reasonMessage(reason));
    } finally {
      release(token);
    }
  }, [claim, release, reloadJournal, restoreLatestFlowOrIdle]);

  const discardQueuedActivity = useCallback((sequence?: number) => {
    if (operationRef.current) return false;
    const current = activityQueueRef.current;
    const target = sequence === undefined
      ? current[0]
      : current.find((entry) => entry.sequence === sequence);
    if (!target) return false;
    publishActivityQueue(current.filter((entry) =>
      entry.sequence !== target.sequence
    ));
    if (current[0]?.sequence === target.sequence) {
      publishActivityQueueIssue("");
    }
    setPassiveNotice("");
    scheduleActivity();
    return true;
  }, [publishActivityQueue, publishActivityQueueIssue, scheduleActivity]);

  const dismissPassiveNotice = useCallback(() => {
    setPassiveNotice("");
  }, []);

  const blocksExternalWrites = useCallback(() => {
    const current = journalRef.current;
    return Boolean(
      operationRef.current || heldEntriesRef.current.size > 0 ||
      !current.loaded || current.storageUnavailable || current.lockUnavailable ||
      current.entries.length > 0 || current.unreadable.length > 0
    );
  }, []);
  const operationInProgress = useCallback(() => Boolean(operationRef.current), []);
  const blocksBackupActivation = useCallback(() =>
    blocksExternalWrites() || activityQueueRef.current.length > 0,
  [blocksExternalWrites]);
  const hasVolatileWorkNow = useCallback(() => {
    const current = journalRef.current;
    const barrier = vocabEngagementHeldReceiptBarrier(
      heldEntriesRef.current.keys(),
      current.entries.map((entry) => entry.ticket.receipt.operationId),
    );
    return Boolean(
      operationRef.current || activityQueueRef.current.length > 0 ||
      barrier.volatile
    );
  }, []);

  return {
    journal,
    flow,
    busy,
    writeLocked,
    expectedContinuationBlocked,
    backupBlocked: backupGate.blocked,
    hasVolatileWork: backupGate.volatile,
    hasHeldReceipt,
    hasVolatileHeldReceipt,
    hasQueuedActivity,
    queuedActivityCount,
    activityQueue,
    activityQueueIssue,
    passiveNotice,
    status,
    error,
    focusRequest,
    startBookmark,
    startBookmarkMutation,
    queueActivity,
    discardQueuedActivity,
    dismissPassiveNotice,
    open,
    inspect,
    continueExpected,
    discardExpected,
    applyCommitted,
    applyChanged,
    dismissInvalid,
    clearUnreadable,
    recheckJournal: reloadJournal,
    operationInProgress,
    blocksExternalWrites,
    blocksBackupActivation,
    hasVolatileWorkNow,
  } as const;
}

export type VocabEngagementWriteController = ReturnType<
  typeof useVocabEngagementWriteFlow
>;
type Controller = VocabEngagementWriteController;

export function VocabEngagementWriteBanner({
  controller,
  onOpen,
}: {
  controller: Controller;
  onOpen?: (trigger: HTMLButtonElement) => void;
}) {
  const {
    journal,
    busy,
    hasHeldReceipt,
    queuedActivityCount,
    activityQueueIssue,
    passiveNotice,
  } = controller;
  if (
    !journal.loaded ||
    (!journal.storageUnavailable && !journal.lockUnavailable &&
      journal.entries.length === 0 && journal.unreadable.length === 0 &&
      !hasHeldReceipt && queuedActivityCount === 0 && !passiveNotice)
  ) return null;
  const title = journal.storageUnavailable
    ? "学习记录核对线索暂时无法读取"
    : journal.lockUnavailable
      ? "这个浏览器可以阅读资料，但暂不能安全保存学习记录"
      : journal.unreadable.length > 0
        ? "有无法验证的学习记录提醒"
        : activityQueueIssue
          ? "一段学习时间暂停，尚未写入"
          : hasHeldReceipt
            ? "原学习记录收据仍待只读核对"
            : journal.entries.length > 0
              ? "有一条学习记录待核对"
              : queuedActivityCount > 0
                ? `有 ${queuedActivityCount} 段学习时间等待安全记录`
                : "学习记录需要留意";
  return <section className="sc-engagement-write-banner" role="status">
    <div><b>{title}</b><p>{passiveNotice ||
      "阅读与收听仍可继续；结果明确前不会重复计时或覆盖书签。"}</p></div>
    <div className="sc-engagement-write-actions">
      {(journal.entries.length > 0 || hasHeldReceipt ||
        journal.storageUnavailable || journal.lockUnavailable ||
        journal.unreadable.length > 0) &&
        <button type="button" disabled={busy} onClick={(event) => {
          onOpen?.(event.currentTarget);
          controller.open();
        }}>
          {journal.entries.length > 0 || hasHeldReceipt
            ? "打开待核对收据"
            : "查看安全说明"}
        </button>}
      {activityQueueIssue && queuedActivityCount > 0 &&
        <button type="button" disabled={busy} onClick={() => {
          controller.discardQueuedActivity();
        }}>放弃这段未写入时间</button>}
      {passiveNotice && !activityQueueIssue && queuedActivityCount === 0 &&
        journal.entries.length === 0 && !hasHeldReceipt &&
        <button type="button" disabled={busy} onClick={
          controller.dismissPassiveNotice
        }>知道了</button>}
    </div>
  </section>;
}

function receiptText(receipt: VocabEngagementWriteReceipt): string {
  if (receipt.kind === "bookmark-create") {
    return [
      `动作：保存书签`,
      `条目：${receipt.expected.item.title}`,
      `位置：${receipt.request.locator}`,
      `标签：${receipt.request.label || "（无）"}`,
    ].join("\n");
  }
  if (receipt.kind === "bookmark-note-set") {
    return [
      `动作：修改书签笔记`,
      `条目：${receipt.expected.item.title}`,
      `位置：${receipt.request.locator}`,
      `笔记：${receipt.request.note || "（清空）"}`,
    ].join("\n");
  }
  if (receipt.kind === "bookmark-delete") {
    return [
      `动作：删除书签`,
      `条目：${receipt.expected.item.title}`,
      `位置：${receipt.request.locator}`,
    ].join("\n");
  }
  return [
    `动作：记录${receipt.request.kind === "read" ? "阅读" : "收听"}时间`,
    `时长：${receipt.request.seconds} 秒`,
    `本地日期：${receipt.target.day}`,
    `记录时间：${new Date(receipt.request.recordedAt).toISOString()}`,
  ].join("\n");
}

export function VocabEngagementWriteRecovery({
  controller,
}: {
  controller: Controller;
}) {
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
  const backendBlocked = journal.storageUnavailable ||
    journal.lockUnavailable || journal.unreadable.length > 0;
  const title = journal.storageUnavailable
    ? "暂时无法查看学习记录核对线索"
    : journal.lockUnavailable
      ? "当前浏览器只读开放"
      : journal.unreadable.length > 0
        ? "有无法验证的学习记录提醒"
        : flow.phase === "working"
          ? "正在安全处理学习记录"
          : flow.phase === "expected"
            ? "这次确定还没有写入"
            : flow.phase === "changed"
              ? "当前资料已经变化"
              : flow.phase === "apply-only"
                ? "保存事实已确认，页面待应用"
                : flow.phase === "invalid"
                  ? "学习记录收据无法验证"
                  : entry
                    ? "有一条学习记录待核对"
                    : "学习记录安全说明";
  return <section className="sc-engagement-write-recovery" aria-live="polite">
    <header><h2 ref={heading} tabIndex={-1}>{title}</h2><p>
      {flow.phase === "working"
        ? flow.action === "inspect"
          ? "正在只读核对结果…"
          : flow.action === "apply"
            ? "正在应用已确认的结果…"
            : "正在安全处理，请保持此页打开…"
        : entry
          ? message
          : journal.lockUnavailable
            ? "缺少跨页面写入锁时，不会调用学习记录写入；已有资料仍可照常阅读。"
            : "重新检查只会扫描核对线索，不会自动修改资料。"}
    </p></header>
    {error && <p className="sc-engagement-write-error" role="alert">
      {error}
    </p>}
    {status && <p className="sc-engagement-write-status" role="status">
      {status}
    </p>}
    {entry && <details
      className="sc-engagement-receipt"
      open={flow.phase === "changed"}
    >
      <summary>查看这次学习记录动作</summary>
      <pre>{receiptText(entry.ticket.receipt)}</pre>
    </details>}
    <footer>
      {(journal.storageUnavailable || journal.lockUnavailable) &&
        <button
          type="button"
          disabled={busy}
          onClick={controller.recheckJournal}
        >重新检查</button>}
      {!journal.storageUnavailable && !journal.lockUnavailable &&
        journal.unreadable.length > 0 &&
        <button type="button" disabled={busy} onClick={() => {
          void controller.clearUnreadable();
        }}>保留资料并清除无法验证的提醒</button>}
      {entry && flow.phase === "check" &&
        <button
          className="primary"
          type="button"
          disabled={busy || backendBlocked}
          onClick={() => void controller.inspect(entry)}
        >只读核对结果</button>}
      {entry && flow.phase === "expected" && <>
        <button type="button" disabled={busy} onClick={() => {
          void controller.discardExpected(entry);
        }}>{isActivity(entry.ticket.receipt)
            ? "放弃这段未写入时间"
            : "不保存书签并清除提醒"}</button>
        <button
          className="primary"
          type="button"
          disabled={busy || backendBlocked ||
            controller.expectedContinuationBlocked}
          onClick={() => void controller.continueExpected(entry)}
        >继续同一张收据</button>
      </>}
      {entry && flow.phase === "changed" &&
        <button
          className="primary"
          type="button"
          disabled={busy}
          onClick={() => void controller.applyChanged(entry)}
        >只读读取并应用当前资料</button>}
      {entry && flow.phase === "apply-only" &&
        <button
          className="primary"
          type="button"
          disabled={busy || backendBlocked}
          onClick={() => void controller.applyCommitted(entry)}
        >只读核对并应用确认结果</button>}
      {entry && flow.phase === "invalid" &&
        <button type="button" disabled={busy} onClick={() => {
          void controller.dismissInvalid(entry);
        }}>保留资料并清除提醒</button>}
    </footer>
  </section>;
}
