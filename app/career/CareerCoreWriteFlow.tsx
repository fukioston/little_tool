"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  CareerCoreWriteError,
  commitCareerCoreWrite,
  inspectCareerCoreWrite,
  prepareCareerInterviewCreate,
  prepareCareerInterviewUpdate,
  prepareCareerJobCreate,
  prepareCareerJobUpdate,
  prepareCareerStageRename,
  type CareerCoreWriteKind,
  type CareerCoreWriteReceipt,
  type CareerInterviewWriteExpectedState,
  type CareerJobWriteExpectedState,
  type CareerStageWriteExpectedState,
  type CreateCareerInterviewCoreInput,
  type CreateCareerJobCoreInput,
  type UpdateCareerInterviewCoreInput,
  type UpdateCareerJobCoreInput,
} from "@/lib/career/core-writes";
import {
  CAREER_CORE_WRITE_PREFIX,
  CAREER_LIFECYCLE_TASK_WRITE_PREFIX,
  careerCoreHeldReceiptBarrier,
  claimCareerCoreWrite,
  createCareerCoreWriteEntry,
  createCareerCoreWriteTicket,
  persistCareerCoreWrite,
  readCareerCoreWriteJournal,
  releaseCareerCoreWrite,
  removeUnreadableCareerCoreWrite,
  runWithCurrentCareerCoreWrite,
  runWithMissingCareerCoreWrite,
  selectCareerCoreWriteRecoveryEntry,
  type CareerCoreWriteEntry,
  type CareerCoreWriteJournal,
  type CareerCoreWriteLease,
  type CareerCoreWriteToken,
} from "./core-write-journal";
import {
  careerCoreBackupGate,
  careerCoreUnloadRisk,
  careerCoreWritePreflightOpen,
  createCareerCoreEditorSettlementRegistry,
  runCareerCoreClaimedUiAction,
  type CareerCoreEditorSettlement,
  type CareerCoreEditorSettlementLifecycle,
  type CareerDatabaseMutationToken,
} from "./core-write-state";

export type CareerCoreRefreshOutcome = "applied" | "superseded" | "deferred";
export type CareerCoreDurableSettlement = CareerCoreEditorSettlement;
export type CareerCoreSubmitLifecycle = CareerCoreEditorSettlementLifecycle;
export type CareerCoreSubmitResult =
  | Readonly<{
      outcome: "saved";
      entityId: string;
      receipt: CareerCoreWriteReceipt;
    }>
  | Readonly<{
      outcome: "changed";
      entityId: string;
      receipt: CareerCoreWriteReceipt;
    }>
  | Readonly<{ outcome: "attention"; entityId: string | null }>
  | Readonly<{ outcome: "blocked"; entityId: null }>;

type JournalView = CareerCoreWriteJournal & Readonly<{ loaded: boolean }>;
type WorkingAction = "prepare" | "commit" | "inspect" | "refresh" | "journal";
export type CareerCoreFlowState =
  | Readonly<{ phase: "idle" }>
  | Readonly<{
      phase: "working";
      action: WorkingAction;
      kind: CareerCoreWriteKind | null;
    }>
  | Readonly<{
      phase: "check" | "expected" | "changed" | "refresh-only" | "invalid";
      entry: CareerCoreWriteEntry;
      message: string;
    }>;

const EMPTY_JOURNAL: JournalView = {
  loaded: false,
  entries: [],
  peerEntries: [],
  unreadable: [],
  storageUnavailable: false,
  lockUnavailable: false,
};

const ACTION_LABEL: Record<CareerCoreWriteKind, string> = {
  "stage-rename": "阶段名称",
  "job-create": "新职位",
  "job-update": "职位资料",
  "interview-create": "面试日程",
  "interview-update": "面经资料",
};

function reasonMessage(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : "这次职迹操作没有完成；现有资料没有被静默覆盖。";
}

function receiptEntityId(receipt: CareerCoreWriteReceipt): string {
  switch (receipt.kind) {
    case "stage-rename": return receipt.after.stage.id;
    case "job-create": return receipt.after.job.id;
    case "job-update": return receipt.after.job.id;
    case "interview-create": return receipt.after.interview.id;
    case "interview-update": return receipt.after.interview.id;
  }
}

function phaseForEntry(entry: CareerCoreWriteEntry): CareerCoreFlowState {
  const label = ACTION_LABEL[entry.ticket.receipt.kind];
  if (entry.ticket.kind === "committed") {
    return {
      phase: "refresh-only",
      entry,
      message: `${label}已经确认写入。下一步只重新读取画面，不会再次提交。`,
    };
  }
  if (entry.ticket.kind === "changed") {
    return {
      phase: "changed",
      entry,
      message: "相关资料已经变化；旧输入不会覆盖当前内容，也不会再次提交。",
    };
  }
  return {
    phase: "check",
    entry,
    message: "这次写入结果还没有确认。先只读核对，不会重复写入。",
  };
}

class CareerCoreExternalWritePausedError extends Error {
  readonly name = "CareerCoreExternalWritePausedError";
}

export function useCareerCoreWriteFlow({
  refresh,
  snapshotStale,
  snapshotStaleNow,
  externalWriteLocked,
  externalWriteInProgress,
  dirtyEditorCount,
  onToast,
  onAttention,
  claimDatabaseMutation,
  releaseDatabaseMutation,
  databaseMutationActiveExcept,
}: {
  refresh: (
    receipt: CareerCoreWriteReceipt,
    reason: "committed" | "changed",
    ownedCommittedReceipt: boolean,
  ) => Promise<CareerCoreRefreshOutcome>;
  snapshotStale: boolean;
  snapshotStaleNow: () => boolean;
  externalWriteLocked: boolean;
  externalWriteInProgress: () => boolean;
  dirtyEditorCount: number;
  onToast: (message: string) => void;
  onAttention: () => void;
  claimDatabaseMutation: () => CareerDatabaseMutationToken | null;
  releaseDatabaseMutation: (token: CareerDatabaseMutationToken) => void;
  databaseMutationActiveExcept: () => boolean;
}) {
  const [journal, setJournal] = useState<JournalView>(EMPTY_JOURNAL);
  const [flow, setFlow] = useState<CareerCoreFlowState>({ phase: "idle" });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [heldEntries, setHeldEntries] = useState<readonly CareerCoreWriteEntry[]>([]);
  const [focusRequest, setFocusRequest] = useState(0);
  const journalRef = useRef<JournalView>(EMPTY_JOURNAL);
  const operationRef = useRef<CareerCoreWriteToken | null>(null);
  const heldEntriesRef = useRef(new Map<string, CareerCoreWriteEntry>());
  const triggerRef = useRef(new Map<string, HTMLElement>());
  const mountedRef = useRef(false);
  const attentionRef = useRef<HTMLDivElement>(null);
  const externalWriteLockedRef = useRef(externalWriteLocked);
  const externalWriteInProgressRef = useRef(externalWriteInProgress);
  const snapshotStaleNowRef = useRef(snapshotStaleNow);
  const dirtyEditorCountRef = useRef(dirtyEditorCount);
  const focusFrameRef = useRef<number | null>(null);
  const settlementRef = useRef(createCareerCoreEditorSettlementRegistry());

  const busy = flow.phase === "working";
  const heldBarrier = careerCoreHeldReceiptBarrier(
    heldEntries.map((entry) => entry.ticket.receipt.operationId),
    journal.entries.map((entry) => entry.ticket.receipt.operationId),
  );
  const writeLocked = !careerCoreWritePreflightOpen({
    journalLoaded: journal.loaded,
    storageUnavailable: journal.storageUnavailable,
    lockUnavailable: journal.lockUnavailable,
    unreadableCount: journal.unreadable.length,
    entryCount: journal.entries.length + journal.peerEntries.length,
    hasHeldReceipt: heldBarrier.blocksWrites,
    operationInProgress: busy,
    snapshotStale,
    externalWriteLocked,
  });
  const databaseMutationLocked = careerCoreBackupGate({
    busy,
    hasHeldReceipt: heldBarrier.blocksWrites,
    journalLoaded: journal.loaded,
    storageUnavailable: journal.storageUnavailable,
    lockUnavailable: journal.lockUnavailable,
    unreadableCount: journal.unreadable.length,
    entryCount: journal.entries.length + journal.peerEntries.length,
    snapshotStale,
  });
  const hasVolatileWork = busy || heldBarrier.volatile;

  useLayoutEffect(() => {
    externalWriteLockedRef.current = externalWriteLocked;
    externalWriteInProgressRef.current = externalWriteInProgress;
    snapshotStaleNowRef.current = snapshotStaleNow;
    dirtyEditorCountRef.current = dirtyEditorCount;
  }, [dirtyEditorCount, externalWriteInProgress, externalWriteLocked, snapshotStaleNow]);

  const externalBlockedNow = useCallback(() =>
    externalWriteLockedRef.current ||
    externalWriteInProgressRef.current() ||
    snapshotStaleNowRef.current(), []);

  const rememberSettlement = useCallback((
    receipt: CareerCoreWriteReceipt,
    lifecycle: CareerCoreSubmitLifecycle | undefined,
  ) => settlementRef.current.remember(receipt, lifecycle), []);

  const notifySettlement = useCallback((
    receipt: CareerCoreWriteReceipt,
    outcome: CareerCoreDurableSettlement["outcome"],
  ) => settlementRef.current.notify(receipt, outcome), []);

  const ownsSettlement = useCallback((receipt: CareerCoreWriteReceipt) =>
    settlementRef.current.ownsExact(receipt), []);

  const abandonChangedSettlement = useCallback((receipt: CareerCoreWriteReceipt) =>
    settlementRef.current.abandonChanged(receipt), []);

  const forgetSettlement = useCallback((receipt: CareerCoreWriteReceipt) =>
    settlementRef.current.forget(receipt), []);

  const reloadJournal = useCallback(() => {
    let next: CareerCoreWriteJournal;
    try {
      next = readCareerCoreWriteJournal();
    } catch {
      next = {
        entries: [],
        peerEntries: [],
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

  const holdEntry = useCallback((entry: CareerCoreWriteEntry) => {
    heldEntriesRef.current.set(entry.ticket.receipt.operationId, entry);
    setHeldEntries([...heldEntriesRef.current.values()]);
  }, []);

  const clearHeldEntry = useCallback((receipt: CareerCoreWriteReceipt) => {
    heldEntriesRef.current.delete(receipt.operationId);
    setHeldEntries([...heldEntriesRef.current.values()]);
  }, []);

  const present = useCallback((next: CareerCoreFlowState, foreground = true) => {
    if ("entry" in next) holdEntry(next.entry);
    setFlow(next);
    if (foreground) {
      setFocusRequest((current) => current + 1);
      onAttention();
    }
  }, [holdEntry, onAttention]);

  const claim = useCallback((action: WorkingAction, kind: CareerCoreWriteKind | null) => {
    const token = claimCareerCoreWrite(operationRef);
    if (token) {
      setError("");
      setFlow({ phase: "working", action, kind });
    }
    return token;
  }, []);

  const release = useCallback((token: CareerCoreWriteToken) => {
    releaseCareerCoreWrite(operationRef, token);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    function passiveScan() {
      const current = reloadJournal();
      const entry = selectCareerCoreWriteRecoveryEntry(
        [...heldEntriesRef.current.values()],
        current.entries,
      );
      if (operationRef.current) return;
      if (entry) {
        holdEntry(entry);
        setFlow(phaseForEntry(entry));
      } else {
        setFlow({ phase: "idle" });
      }
    }
    passiveScan();
    function onStorage(event: StorageEvent) {
      if (
        event.storageArea === window.localStorage &&
        (event.key === null || event.key.startsWith(CAREER_CORE_WRITE_PREFIX) ||
          event.key.startsWith(CAREER_LIFECYCLE_TASK_WRITE_PREFIX))
      ) passiveScan();
    }
    const onFocus = () => passiveScan();
    const onVisibility = () => {
      if (document.visibilityState === "visible") passiveScan();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false;
      if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [holdEntry, reloadJournal]);

  useEffect(() => {
    function protect(event: BeforeUnloadEvent) {
      const current = journalRef.current;
      const barrier = careerCoreHeldReceiptBarrier(
        heldEntriesRef.current.keys(),
        current.entries.map((entry) => entry.ticket.receipt.operationId),
      );
      if (careerCoreUnloadRisk({
        operationInProgress: Boolean(operationRef.current),
        dirtyEditorCount: dirtyEditorCountRef.current,
        volatileHeldReceipt: barrier.volatile,
      })) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);

  useEffect(() => {
    if (focusRequest === 0) return;
    if (document.querySelector('[aria-modal="true"]')) return;
    const frame = window.requestAnimationFrame(() =>
      attentionRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);

  const restoreTrigger = useCallback((receipt: CareerCoreWriteReceipt) => {
    const trigger = triggerRef.current.get(receipt.operationId) ?? null;
    triggerRef.current.delete(receipt.operationId);
    if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = window.requestAnimationFrame(() => {
        focusFrameRef.current = null;
        if (trigger?.isConnected && !trigger.matches(":disabled") &&
          trigger.getClientRects().length > 0) {
          trigger.focus({ preventScroll: true });
          return;
        }
        document.querySelector<HTMLElement>(
          "[data-career-core-focus]:not(:disabled), #career-page-title",
        )?.focus({ preventScroll: true });
      });
    });
  }, []);

  const safelyIdle = useCallback((receipt: CareerCoreWriteReceipt) => {
    clearHeldEntry(receipt);
    const latest = reloadJournal();
    const next = selectCareerCoreWriteRecoveryEntry(
      [...heldEntriesRef.current.values()],
      latest.entries,
    );
    if (next) holdEntry(next);
    setFlow(next ? phaseForEntry(next) : { phase: "idle" });
  }, [clearHeldEntry, holdEntry, reloadJournal]);

  const restoreLatestFlowOrIdle = useCallback(() => {
    const latest = reloadJournal();
    const next = selectCareerCoreWriteRecoveryEntry(
      [...heldEntriesRef.current.values()],
      latest.entries,
    );
    if (next) holdEntry(next);
    setFlow(next ? phaseForEntry(next) : { phase: "idle" });
    return next;
  }, [holdEntry, reloadJournal]);

  const reopenLatest = useCallback((entry: CareerCoreWriteEntry) => {
    holdEntry(entry);
    const latest = reloadJournal();
    const next = selectCareerCoreWriteRecoveryEntry(
      [...heldEntriesRef.current.values()],
      latest.entries,
    );
    present(next && latest.entries.includes(next)
      ? phaseForEntry(next)
      : {
          phase: "check",
          entry: next ?? entry,
          message: "另一页移除了提醒，但原收据仍在本页；只能重新 checkpoint 后只读核对。",
        });
  }, [holdEntry, present, reloadJournal]);

  const removeCurrent = useCallback(async (entry: CareerCoreWriteEntry) => {
    const result = await runWithCurrentCareerCoreWrite(
      entry,
      (lease) => lease.remove(),
    );
    reloadJournal();
    return result.outcome;
  }, [reloadJournal]);

  const finishTerminal = useCallback(async (
    entry: CareerCoreWriteEntry,
    reason: "committed" | "changed",
  ): Promise<CareerCoreSubmitResult> => {
    const receipt = entry.ticket.receipt;
    const entityId = receiptEntityId(receipt);
    holdEntry(entry);
    setFlow({ phase: "working", action: "refresh", kind: receipt.kind });
    setStatus(reason === "committed"
      ? `${ACTION_LABEL[receipt.kind]}已写入，正在重新读取…`
      : "资料已变化，正在读取当前内容…");
    const ownedCommittedReceipt = reason === "committed" && ownsSettlement(receipt);
    if (reason === "committed") notifySettlement(receipt, "saved");
    else notifySettlement(receipt, "changed");
    try {
      const outcome = await refresh(receipt, reason, ownedCommittedReceipt);
      if (outcome !== "applied") {
        present({
          phase: reason === "committed" ? "refresh-only" : "changed",
          entry,
          message: reason === "committed"
            ? "写入已经确认，但这次页面刷新被更新的读取取代。这里只会继续刷新。"
            : "资料已经变化，当前输入仍保留；页面还没有读到最新内容。",
        });
        return reason === "changed"
          ? { outcome: "changed", entityId, receipt }
          : { outcome: "attention", entityId };
      }
      const removal = await removeCurrent(entry);
      if (removal === "stale") {
        reopenLatest(entry);
        return { outcome: "attention", entityId };
      }
      if (removal === "blocked") {
        present({
          phase: reason === "committed" ? "refresh-only" : "changed",
          entry,
          message: "画面已重新读取，但核对提醒暂时无法安全收起。",
        });
        return { outcome: "attention", entityId };
      }
      safelyIdle(receipt);
      restoreTrigger(receipt);
      forgetSettlement(receipt);
      if (reason === "committed") {
        const message = `${ACTION_LABEL[receipt.kind]}已确认保存。`;
        setStatus(message);
        onToast(message);
        return { outcome: "saved", entityId, receipt };
      }
      setStatus("资料已在别处变化；旧输入没有覆盖当前内容。");
      return { outcome: "changed", entityId, receipt };
    } catch (reasonValue) {
      setError(reasonMessage(reasonValue));
      present({
        phase: reason === "committed" ? "refresh-only" : "changed",
        entry,
        message: reason === "committed"
          ? "写入已经确认；页面暂时没有重新读取。这里只会继续刷新。"
          : "资料已经变化；当前输入仍保留，等待只读刷新。",
      });
      return reason === "changed"
        ? { outcome: "changed", entityId, receipt }
        : { outcome: "attention", entityId };
    }
  }, [forgetSettlement, holdEntry, notifySettlement, onToast, ownsSettlement, present, refresh, removeCurrent, reopenLatest, restoreTrigger, safelyIdle]);

  const inspectWithLease = useCallback((
    entry: CareerCoreWriteEntry,
    missing: boolean,
  ) => {
    const operation = async (lease: CareerCoreWriteLease) => {
      const inspection = await inspectCareerCoreWrite(entry.ticket.receipt);
      if (inspection === "exact_saved") lease.committed();
      else if (inspection === "changed") lease.changed();
      return inspection;
    };
    return missing
      ? runWithMissingCareerCoreWrite(entry, operation)
      : runWithCurrentCareerCoreWrite(entry, operation);
  }, []);

  const inspectEntry = useCallback(async (
    entry: CareerCoreWriteEntry,
  ): Promise<CareerCoreSubmitResult> => {
    const entityId = receiptEntityId(entry.ticket.receipt);
    setFlow({ phase: "working", action: "inspect", kind: entry.ticket.receipt.kind });
    let result = await inspectWithLease(entry, false);
    if (result.outcome === "stale") {
      holdEntry(entry);
      result = await inspectWithLease(entry, true);
    }
    reloadJournal();
    if (result.outcome === "blocked") {
      present({ phase: "check", entry, message: "无法完整验证全部核对提醒；没有调用写入。" });
      return { outcome: "attention", entityId };
    }
    if (result.outcome === "stale") {
      reopenLatest(entry);
      return { outcome: "attention", entityId };
    }
    if (result.value === "exact_saved" && result.entry) {
      return finishTerminal(result.entry, "committed");
    }
    if (result.value === "changed" && result.entry) {
      return finishTerminal(result.entry, "changed");
    }
    const current = result.entry ?? entry;
    if (result.value === "expected") {
      present({
        phase: "expected",
        entry: current,
        message: "已确认这次写入还没有提交。可以放弃，或明确继续同一张收据。",
      });
    } else if (result.value === "invalid_receipt") {
      present({
        phase: "invalid",
        entry: current,
        message: "这份收据无法验证；没有据此写入。",
      });
    } else {
      present({
        phase: "check",
        entry: current,
        message: "结果仍无法确认；收据继续保留，只允许再次只读核对。",
      });
    }
    return { outcome: "attention", entityId };
  }, [finishTerminal, holdEntry, inspectWithLease, present, reloadJournal, reopenLatest]);

  const commitEntry = useCallback(async (
    entry: CareerCoreWriteEntry,
  ): Promise<CareerCoreSubmitResult> => {
    const receipt = entry.ticket.receipt;
    const entityId = receiptEntityId(receipt);
    setFlow({ phase: "working", action: "commit", kind: receipt.kind });
    try {
      const result = await runWithCurrentCareerCoreWrite(entry, async (lease) => {
        if (externalBlockedNow()) return "external-blocked" as const;
        try {
          const committed = await commitCareerCoreWrite(receipt);
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
          if (reason instanceof CareerCoreWriteError && reason.code === "write_failed") {
            return "expected" as const;
          }
          throw reason;
        }
      });
      reloadJournal();
      if (result.outcome === "blocked") {
        reopenLatest(entry);
        return { outcome: "attention", entityId };
      }
      if (result.outcome === "stale") return inspectEntry(entry);
      if (result.value === "saved" && result.entry) {
        return finishTerminal(result.entry, "committed");
      }
      if (result.value === "changed" && result.entry) {
        return finishTerminal(result.entry, "changed");
      }
      if (result.value === "expected") {
        present({
          phase: "expected",
          entry,
          message: "这次写入确定没有提交。可以放弃，或明确继续同一张收据。",
        });
      } else if (result.value === "external-blocked") {
        present({
          phase: "check",
          entry,
          message: "另一笔数据库操作已经开始；收据仍保留，没有调用核心写入。",
        });
      } else {
        present({
          phase: "check",
          entry,
          message: "这次结果需要只读核对；不会凭猜测重复提交。",
        });
      }
      return { outcome: "attention", entityId };
    } catch (reason) {
      reloadJournal();
      present({
        phase: "check",
        entry,
        message: "这次结果需要只读核对；收据仍保留。",
      });
      setError(reasonMessage(reason));
      return { outcome: "attention", entityId };
    }
  }, [externalBlockedNow, finishTerminal, inspectEntry, present, reloadJournal, reopenLatest]);

  const startPrepared = useCallback(async (
    kind: CareerCoreWriteKind,
    prepare: () => Promise<CareerCoreWriteReceipt>,
    trigger: HTMLElement,
    lifecycle?: CareerCoreSubmitLifecycle,
  ): Promise<CareerCoreSubmitResult> => {
    const databaseToken = claimDatabaseMutation();
    if (!databaseToken) {
      setError("另一笔数据库操作已经开始；没有准备核心写入。");
      return { outcome: "blocked", entityId: null };
    }
    const token = claim("prepare", kind);
    if (!token) {
      releaseDatabaseMutation(databaseToken);
      return { outcome: "blocked", entityId: null };
    }
    let held: CareerCoreWriteEntry | null = null;
    try {
      if (externalBlockedNow() || databaseMutationActiveExcept()) {
        throw new CareerCoreExternalWritePausedError(
          "另一笔数据库操作正在进行，或画面不是最新版本；没有准备写入。",
        );
      }
      const current = reloadJournal();
      if (!careerCoreWritePreflightOpen({
        journalLoaded: true,
        storageUnavailable: current.storageUnavailable,
        lockUnavailable: current.lockUnavailable,
        unreadableCount: current.unreadable.length,
        entryCount: current.entries.length + current.peerEntries.length,
        hasHeldReceipt: heldEntriesRef.current.size > 0,
        operationInProgress: false,
        snapshotStale: snapshotStaleNowRef.current(),
        externalWriteLocked: externalWriteLockedRef.current ||
          externalWriteInProgressRef.current(),
      })) {
        throw new Error("职迹安全门尚未开放；没有准备新的写入。");
      }
      const receipt = await prepare();
      if (receipt.kind !== kind) {
        throw new Error("准备返回的收据不属于当前动作；没有保存或提交。");
      }
      if (externalBlockedNow() || databaseMutationActiveExcept()) {
        throw new CareerCoreExternalWritePausedError(
          "准备期间另一笔数据库操作开始；输入仍保留，没有保存或提交收据。",
        );
      }
      held = createCareerCoreWriteEntry(createCareerCoreWriteTicket(receipt));
      rememberSettlement(receipt, lifecycle);
      holdEntry(held);
      triggerRef.current.set(receipt.operationId, trigger);
      const durable = await persistCareerCoreWrite(held.ticket);
      holdEntry(durable);
      reloadJournal();
      if (externalBlockedNow() || databaseMutationActiveExcept()) {
        present({
          phase: "check",
          entry: durable,
          message: "收据已经安全保留；另一笔数据库操作结束前不会提交。",
        });
        return { outcome: "attention", entityId: receiptEntityId(receipt) };
      }
      return await commitEntry(durable);
    } catch (reason) {
      if (held) {
        holdEntry(held);
        present({
          phase: "check",
          entry: held,
          message: "收据暂时只保留在本页；必须先 checkpoint 并只读核对。",
        });
        setError(reasonMessage(reason));
        return { outcome: "attention", entityId: receiptEntityId(held.ticket.receipt) };
      }
      setFlow({ phase: "idle" });
      setError(reasonMessage(reason));
      return { outcome: "blocked", entityId: null };
    } finally {
      release(token);
      releaseDatabaseMutation(databaseToken);
    }
  }, [claim, claimDatabaseMutation, commitEntry, databaseMutationActiveExcept, externalBlockedNow, holdEntry, present, release, releaseDatabaseMutation, reloadJournal, rememberSettlement]);

  const submitStageRename = useCallback((
    name: string,
    expected: CareerStageWriteExpectedState,
    trigger: HTMLElement,
    lifecycle?: CareerCoreSubmitLifecycle,
  ) => startPrepared(
    "stage-rename",
    () => prepareCareerStageRename(name, expected),
    trigger,
    lifecycle,
  ), [startPrepared]);

  const submitJobCreate = useCallback((
    input: CreateCareerJobCoreInput,
    expected: CareerStageWriteExpectedState,
    trigger: HTMLElement,
    lifecycle?: CareerCoreSubmitLifecycle,
  ) => startPrepared(
    "job-create",
    () => prepareCareerJobCreate(input, expected),
    trigger,
    lifecycle,
  ), [startPrepared]);

  const submitJobUpdate = useCallback((
    input: UpdateCareerJobCoreInput,
    expected: CareerJobWriteExpectedState,
    trigger: HTMLElement,
    lifecycle?: CareerCoreSubmitLifecycle,
  ) => startPrepared(
    "job-update",
    () => prepareCareerJobUpdate(input, expected),
    trigger,
    lifecycle,
  ), [startPrepared]);

  const submitInterviewCreate = useCallback((
    input: CreateCareerInterviewCoreInput,
    expected: CareerJobWriteExpectedState,
    trigger: HTMLElement,
    lifecycle?: CareerCoreSubmitLifecycle,
  ) => startPrepared(
    "interview-create",
    () => prepareCareerInterviewCreate(input, expected),
    trigger,
    lifecycle,
  ), [startPrepared]);

  const submitInterviewUpdate = useCallback((
    input: UpdateCareerInterviewCoreInput,
    expected: CareerInterviewWriteExpectedState,
    trigger: HTMLElement,
    lifecycle?: CareerCoreSubmitLifecycle,
  ) => startPrepared(
    "interview-update",
    () => prepareCareerInterviewUpdate(input, expected),
    trigger,
    lifecycle,
  ), [startPrepared]);

  const inspectActive = useCallback(async () => {
    if (!("entry" in flow) || operationRef.current) return;
    const token = claim("inspect", flow.entry.ticket.receipt.kind);
    if (!token) return;
    await runCareerCoreClaimedUiAction(
      () => inspectEntry(flow.entry),
      (reason) => {
        restoreLatestFlowOrIdle();
        setError(reasonMessage(reason));
      },
      () => release(token),
    );
  }, [claim, flow, inspectEntry, release, restoreLatestFlowOrIdle]);

  const continueExpected = useCallback(async () => {
    if (flow.phase !== "expected" || operationRef.current || externalBlockedNow()) return;
    const databaseToken = claimDatabaseMutation();
    if (!databaseToken) return;
    const token = claim("commit", flow.entry.ticket.receipt.kind);
    if (!token) {
      releaseDatabaseMutation(databaseToken);
      return;
    }
    try { await commitEntry(flow.entry); }
    finally {
      release(token);
      releaseDatabaseMutation(databaseToken);
    }
  }, [claim, claimDatabaseMutation, commitEntry, externalBlockedNow, flow, release, releaseDatabaseMutation]);

  const discardTerminal = useCallback(async () => {
    if (!(flow.phase === "expected" || flow.phase === "invalid") || operationRef.current) return;
    const token = claim("journal", flow.entry.ticket.receipt.kind);
    if (!token) return;
    await runCareerCoreClaimedUiAction(async () => {
      const removal = await removeCurrent(flow.entry);
      if (removal === "ran") {
        notifySettlement(flow.entry.ticket.receipt, "discarded");
        forgetSettlement(flow.entry.ticket.receipt);
        safelyIdle(flow.entry.ticket.receipt);
        restoreTrigger(flow.entry.ticket.receipt);
        setStatus("这张确定未写入的收据已放弃；现有资料没有改变。");
      } else reopenLatest(flow.entry);
    }, (reason) => {
      restoreLatestFlowOrIdle();
      setError(reasonMessage(reason));
    }, () => release(token));
  }, [claim, flow, forgetSettlement, notifySettlement, release, removeCurrent, reopenLatest, restoreLatestFlowOrIdle, restoreTrigger, safelyIdle]);

  const retryTerminalRefresh = useCallback(async () => {
    if (!(flow.phase === "refresh-only" || flow.phase === "changed") || operationRef.current) return;
    const token = claim("refresh", flow.entry.ticket.receipt.kind);
    if (!token) return;
    try {
      await finishTerminal(
        flow.entry,
        flow.phase === "refresh-only" ? "committed" : "changed",
      );
    } finally { release(token); }
  }, [claim, finishTerminal, flow, release]);

  const discardChangedAndRefresh = useCallback(async () => {
    if (flow.phase !== "changed" || operationRef.current) return;
    const token = claim("refresh", flow.entry.ticket.receipt.kind);
    if (!token) return;
    abandonChangedSettlement(flow.entry.ticket.receipt);
    try { await finishTerminal(flow.entry, "changed"); }
    finally { release(token); }
  }, [abandonChangedSettlement, claim, finishTerminal, flow, release]);

  const removeFirstUnreadable = useCallback(async () => {
    const first = journalRef.current.unreadable[0];
    if (!first || operationRef.current) return;
    const token = claim("journal", null);
    if (!token) return;
    try {
      if (!await removeUnreadableCareerCoreWrite(first)) {
        throw new Error("这条提醒已经变化或暂时无法清除。");
      }
      restoreLatestFlowOrIdle();
      setStatus("无法验证的提醒已清除；没有据此写入。这里只清除了浏览器提醒。");
    } catch (reason) {
      restoreLatestFlowOrIdle();
      setError(reasonMessage(reason));
    } finally { release(token); }
  }, [claim, release, restoreLatestFlowOrIdle]);

  const retryStorage = useCallback(() => {
    setError("");
    restoreLatestFlowOrIdle();
  }, [restoreLatestFlowOrIdle]);

  return {
    journal,
    flow,
    status,
    error,
    busy,
    writeLocked,
    databaseMutationLocked,
    hasHeldReceipt: heldBarrier.blocksWrites,
    hasVolatileWork,
    attentionRef: attentionRef as RefObject<HTMLDivElement>,
    isWriteInProgress: () => Boolean(operationRef.current),
    submitStageRename,
    submitJobCreate,
    submitJobUpdate,
    submitInterviewCreate,
    submitInterviewUpdate,
    inspectActive,
    continueExpected,
    discardTerminal,
    retryTerminalRefresh,
    discardChangedAndRefresh,
    removeFirstUnreadable,
    retryStorage,
  } as const;
}
