"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  CareerDatabaseMutationToken,
} from "./core-write-state";
import { careerLifecycleTaskRecoveryAttention } from "./core-write-state";
import {
  careerContactImportMaterialEntityId,
  careerContactImportMaterialLabel,
  careerContactImportMaterialOwner,
  commitCareerContactImportMaterialWrite,
  inspectCareerContactImportMaterialWrite,
  inspectCareerMaterialFileCleanup,
  materialWriteNeedsCleanup,
  prepareCareerContactArchive,
  prepareCareerContactCreate,
  prepareCareerContactInteraction,
  prepareCareerContactRestore,
  prepareCareerContactTask,
  prepareCareerContactUpdate,
  prepareCareerImportWrite,
  prepareCareerMaterialDeleteWriteForUi,
  prepareCareerMaterialSaveWrite,
  retryCareerMaterialFileCleanup,
  type CareerContactDisplayedExpected,
  type CareerContactImportMaterialOwner,
  type CareerImportCommitItem,
  type CareerImportDisplayedExpected,
  type CareerMaterialDeleteUiDisplayedExpected,
  type CareerMaterialSaveDisplayedExpected,
  type CareerMaterialWriteSaveInput,
  type CreateCareerContactInput,
  type CreateCareerContactTaskInput,
  type RecordCareerContactInteractionInput,
  type UpdateCareerContactInput,
} from "./contact-import-material-write-adapter";
import {
  createCareerContactImportMaterialSettlementRegistry,
  type CareerContactImportMaterialSettlementLifecycle,
} from "./contact-import-material-write-state";
import {
  CAREER_CONTACT_IMPORT_MATERIAL_WRITE_PREFIX,
  CAREER_CORE_WRITE_PREFIX,
  CAREER_LIFECYCLE_TASK_WRITE_PREFIX,
} from "./core-write-journal";
import {
  careerContactImportMaterialHeldBarrier,
  createCareerContactImportMaterialWriteEntry,
  createCareerContactImportMaterialWriteTicket,
  createCareerMaterialCleanupWriteTicket,
  readCareerContactImportMaterialWriteJournal,
  removeUnreadableCareerContactImportMaterialWrite,
  runWithCurrentCareerContactImportMaterialWrite,
  runWithEmptyCareerContactImportMaterialWrite,
  runWithMissingCareerContactImportMaterialWrite,
  type CareerContactImportMaterialWriteEntry,
  type CareerContactImportMaterialWriteJournal,
  type CareerContactImportMaterialWriteLease,
  type CareerContactImportMaterialWriteReceipt,
} from "./contact-import-material-write-journal";

type RefreshOutcome = "applied" | "superseded" | "deferred";
type JournalView = CareerContactImportMaterialWriteJournal &
  Readonly<{ loaded: boolean }>;

export type CareerContactImportMaterialFlowState =
  | Readonly<{ phase: "idle" }>
  | Readonly<{
      phase: "working";
      action: "prepare" | "commit" | "inspect" | "cleanup" | "refresh";
    }>
  | Readonly<{
      phase: "check" | "expected" | "cleanup" | "changed" |
        "refresh-only" | "invalid";
      entry: CareerContactImportMaterialWriteEntry;
      message: string;
    }>;

export type CareerContactImportMaterialSubmitResult =
  | Readonly<{
      outcome: "saved" | "changed";
      entityId: string;
      receipt: CareerContactImportMaterialWriteReceipt;
    }>
  | Readonly<{ outcome: "attention"; entityId: string | null }>
  | Readonly<{ outcome: "blocked"; entityId: null }>;

const EMPTY_JOURNAL: JournalView = {
  loaded: false,
  entries: [],
  peerEntries: [],
  unreadable: [],
  storageUnavailable: false,
  lockUnavailable: false,
};

function operationId(entry: CareerContactImportMaterialWriteEntry): string {
  return entry.ticket.kind === "material-cleanup"
    ? entry.ticket.operationId
    : entry.ticket.receipt.operationId;
}

function receiptOf(
  entry: CareerContactImportMaterialWriteEntry,
): CareerContactImportMaterialWriteReceipt | null {
  return entry.ticket.kind === "material-cleanup"
    ? null
    : entry.ticket.receipt;
}

function messageOf(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : "这次联系人/导入/材料操作没有完成；现有资料没有被静默覆盖。";
}

function phaseFor(
  entry: CareerContactImportMaterialWriteEntry,
): CareerContactImportMaterialFlowState {
  if (entry.ticket.kind === "material-cleanup") {
    return {
      phase: "check",
      entry,
      message: "附件暂存后的清理状态尚未确认。先只读核对，不会保存材料。",
    };
  }
  const receipt = entry.ticket.receipt;
  if (entry.ticket.kind === "committed") {
    return {
      phase: "refresh-only",
      entry,
      message: `${careerContactImportMaterialLabel(receipt)}已经确认写入；这里只会重新读取。`,
    };
  }
  if (entry.ticket.kind === "changed") {
    return {
      phase: "changed",
      entry,
      message: "相关资料已经变化；旧动作不会覆盖当前内容。",
    };
  }
  return {
    phase: "check",
    entry,
    message: "这次写入结果尚未确认。先只读核对，不会重复写入。",
  };
}

function receiptCanBeDiscarded(
  receipt: CareerContactImportMaterialWriteReceipt,
): boolean {
  if (receipt.purpose !== "career-material-write") return true;
  if (receipt.kind === "material-save") {
    return receipt.after.cleanupReceipt === null;
  }
  return receipt.before.fileReceipt === null;
}

export function useCareerContactImportMaterialWriteFlow({
  refresh,
  snapshotStale,
  snapshotStaleNow,
  externalBlockedNow,
  claimDatabaseMutation,
  releaseDatabaseMutation,
  databaseMutationActiveExcept,
  dirtyEditorCount,
  onToast,
  onAttention,
}: {
  refresh: (
    receipt?: CareerContactImportMaterialWriteReceipt,
    reason?: "committed" | "changed",
    ownedCommittedReceipt?: boolean,
  ) => Promise<RefreshOutcome>;
  snapshotStale: boolean;
  snapshotStaleNow: () => boolean;
  externalBlockedNow: () => boolean;
  claimDatabaseMutation: (
    owner: CareerContactImportMaterialOwner,
  ) => CareerDatabaseMutationToken | null;
  releaseDatabaseMutation: (token: CareerDatabaseMutationToken) => void;
  databaseMutationActiveExcept: (
    owner: CareerContactImportMaterialOwner,
  ) => boolean;
  dirtyEditorCount: number;
  onToast: (message: string) => void;
  onAttention: () => void;
}) {
  const [journal, setJournal] = useState<JournalView>(EMPTY_JOURNAL);
  const [flow, setFlow] = useState<CareerContactImportMaterialFlowState>({
    phase: "idle",
  });
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [heldEntries, setHeldEntries] = useState<
    readonly CareerContactImportMaterialWriteEntry[]
  >([]);
  const [focusRequest, setFocusRequest] = useState(0);
  const journalRef = useRef<JournalView>(EMPTY_JOURNAL);
  const heldRef = useRef(new Map<
    string,
    CareerContactImportMaterialWriteEntry
  >());
  const operationRef = useRef(false);
  const triggerRef = useRef(new Map<string, HTMLElement>());
  const focusFrameRef = useRef<number | null>(null);
  const attentionRef = useRef<HTMLDivElement>(null);
  const pendingAttentionFocusRef = useRef(false);
  const mountedRef = useRef(false);
  const snapshotStaleNowRef = useRef(snapshotStaleNow);
  const dirtyCountRef = useRef(dirtyEditorCount);
  const settlementRegistryRef = useRef(
    createCareerContactImportMaterialSettlementRegistry(),
  );

  useLayoutEffect(() => {
    snapshotStaleNowRef.current = snapshotStaleNow;
    dirtyCountRef.current = dirtyEditorCount;
  }, [dirtyEditorCount, snapshotStaleNow]);

  const durableOperationIds = journal.entries.map(operationId);
  const barrier = careerContactImportMaterialHeldBarrier(
    heldEntries.map(operationId),
    durableOperationIds,
  );
  const hasRecoveryAttention = careerLifecycleTaskRecoveryAttention({
    heldReceiptCount: heldEntries.length,
    journalEntryCount: journal.entries.length,
    peerEntryCount: journal.peerEntries.length,
    unreadableCount: journal.unreadable.length,
    storageUnavailable: journal.storageUnavailable,
    lockUnavailable: journal.lockUnavailable,
  });
  const busy = flow.phase === "working";
  const databaseMutationLocked = busy || barrier.blocksWrites ||
    !journal.loaded || journal.storageUnavailable || journal.lockUnavailable ||
    journal.unreadable.length > 0 || journal.entries.length > 0 ||
    journal.peerEntries.length > 0 || snapshotStale;
  const hasVolatileWork = busy || barrier.volatile;

  const reload = useCallback(() => {
    let next: CareerContactImportMaterialWriteJournal;
    try {
      next = readCareerContactImportMaterialWriteJournal();
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

  const hold = useCallback((entry: CareerContactImportMaterialWriteEntry) => {
    heldRef.current.set(operationId(entry), entry);
    setHeldEntries([...heldRef.current.values()]);
  }, []);

  const clearHeld = useCallback((entry: CareerContactImportMaterialWriteEntry) => {
    heldRef.current.delete(operationId(entry));
    setHeldEntries([...heldRef.current.values()]);
  }, []);

  const latest = useCallback(() => {
    const scan = reload();
    for (const held of heldRef.current.values()) {
      return scan.entries.find((entry) => entry.storageKey !== held.storageKey) ??
        scan.entries.find((entry) => entry.storageKey === held.storageKey) ??
        held;
    }
    return scan.entries[0] ?? null;
  }, [reload]);

  const present = useCallback((next: CareerContactImportMaterialFlowState) => {
    if ("entry" in next) hold(next.entry);
    setFlow(next);
    pendingAttentionFocusRef.current = true;
    setFocusRequest((value) => value + 1);
    onAttention();
  }, [hold, onAttention]);

  useEffect(() => {
    mountedRef.current = true;
    const scan = () => {
      const next = latest();
      if (!operationRef.current) {
        setFlow(next ? phaseFor(next) : { phase: "idle" });
      }
    };
    scan();
    const storage = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage &&
        (event.key === null ||
          event.key.startsWith(CAREER_CONTACT_IMPORT_MATERIAL_WRITE_PREFIX) ||
          event.key.startsWith(CAREER_CORE_WRITE_PREFIX) ||
          event.key.startsWith(CAREER_LIFECYCLE_TASK_WRITE_PREFIX))) scan();
    };
    const visible = () => {
      if (document.visibilityState === "visible") scan();
    };
    window.addEventListener("storage", storage);
    window.addEventListener("focus", scan);
    document.addEventListener("visibilitychange", visible);
    return () => {
      mountedRef.current = false;
      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
      window.removeEventListener("storage", storage);
      window.removeEventListener("focus", scan);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [latest]);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      const current = journalRef.current;
      const heldBarrier = careerContactImportMaterialHeldBarrier(
        heldRef.current.keys(),
        current.entries.map(operationId),
      );
      if (operationRef.current || heldBarrier.volatile ||
        dirtyCountRef.current > 0) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);

  useEffect(() => {
    if (focusRequest === 0) return;
    let frame: number | null = null;
    const focusWhenClear = () => {
      if (!pendingAttentionFocusRef.current ||
        document.querySelector('[aria-modal="true"]')) return;
      pendingAttentionFocusRef.current = false;
      frame = window.requestAnimationFrame(() =>
        attentionRef.current?.focus({ preventScroll: true }));
    };
    focusWhenClear();
    const observer = new MutationObserver(focusWhenClear);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-modal"],
    });
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [focusRequest]);

  const restoreTrigger = useCallback((
    receipt: CareerContactImportMaterialWriteReceipt,
  ) => {
    const trigger = triggerRef.current.get(receipt.operationId) ?? null;
    triggerRef.current.delete(receipt.operationId);
    if (focusFrameRef.current !== null) {
      window.cancelAnimationFrame(focusFrameRef.current);
    }
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = window.requestAnimationFrame(() => {
        focusFrameRef.current = null;
        if (trigger?.isConnected && !trigger.matches(":disabled") &&
          trigger.getClientRects().length > 0) {
          trigger.focus({ preventScroll: true });
          return;
        }
        document.querySelector<HTMLElement>(
          "[data-career-contact-import-material-focus]:not(:disabled), #career-page-title",
        )?.focus({ preventScroll: true });
      });
    });
  }, []);

  const removeCurrent = useCallback(async (
    entry: CareerContactImportMaterialWriteEntry,
  ) => {
    const result = await runWithCurrentCareerContactImportMaterialWrite(
      entry,
      (lease) => lease.remove(),
    );
    reload();
    return result.outcome;
  }, [reload]);

  const finish = useCallback(async (
    entry: CareerContactImportMaterialWriteEntry,
    reason: "committed" | "changed",
  ): Promise<CareerContactImportMaterialSubmitResult> => {
    const receipt = receiptOf(entry);
    if (!receipt) {
      present(phaseFor(entry));
      return { outcome: "attention", entityId: null };
    }
    setError("");
    setFlow({ phase: "working", action: "refresh" });
    setStatus(reason === "committed"
      ? "写入已确认，正在重新读取…"
      : "资料已变化，正在重新读取…");
    try {
      const owned = settlementRegistryRef.current.ownsExact(receipt);
      const outcome = await refresh(receipt, reason, owned);
      if (outcome !== "applied") {
        present({
          phase: reason === "committed" ? "refresh-only" : "changed",
          entry,
          message: reason === "committed"
            ? "写入已经确认；页面尚未应用最新读取。这里只会继续刷新。"
            : "资料已经变化；页面尚未应用最新读取。",
        });
        return {
          outcome: "attention",
          entityId: careerContactImportMaterialEntityId(receipt),
        };
      }
      if (reason === "changed") {
        settlementRegistryRef.current.notify(receipt, "changed");
      } else {
        settlementRegistryRef.current.notify(receipt, "saved");
      }
      if (await removeCurrent(entry) !== "ran") {
        present(phaseFor(latest() ?? entry));
        return {
          outcome: "attention",
          entityId: careerContactImportMaterialEntityId(receipt),
        };
      }
      clearHeld(entry);
      settlementRegistryRef.current.forget(receipt);
      setFlow({ phase: "idle" });
      restoreTrigger(receipt);
      if (reason === "committed") {
        const message = `${careerContactImportMaterialLabel(receipt)}已确认保存。`;
        setStatus(message);
        onToast(message);
        return {
          outcome: "saved",
          entityId: careerContactImportMaterialEntityId(receipt),
          receipt,
        };
      }
      setStatus("资料已在别处变化；旧动作没有覆盖当前内容。");
      return {
        outcome: "changed",
        entityId: careerContactImportMaterialEntityId(receipt),
        receipt,
      };
    } catch (reasonValue) {
      setError(messageOf(reasonValue));
      present({
        phase: reason === "committed" ? "refresh-only" : "changed",
        entry,
        message: reason === "committed"
          ? "写入已经确认；页面暂时没有重新读取。这里只会继续刷新。"
          : "资料已经变化；等待只读刷新。",
      });
      return {
        outcome: "attention",
        entityId: careerContactImportMaterialEntityId(receipt),
      };
    }
  }, [clearHeld, latest, onToast, present, refresh, removeCurrent, restoreTrigger]);

  const inspectEntry = useCallback(async (
    entry: CareerContactImportMaterialWriteEntry,
  ): Promise<CareerContactImportMaterialSubmitResult> => {
    setError("");
    setFlow({ phase: "working", action: "inspect" });
    const operation = async (lease: CareerContactImportMaterialWriteLease) => {
      if (entry.ticket.kind === "material-cleanup") {
        return inspectCareerMaterialFileCleanup({
          operationId: entry.ticket.operationId,
          materialId: entry.ticket.materialId,
          cleanupReceipt: entry.ticket.cleanupReceipt,
        });
      }
      const result = await inspectCareerContactImportMaterialWrite(
        entry.ticket.receipt,
      );
      if (result === "exact_saved" || result === "exact_saved_completed") {
        lease.committed();
      } else if (result === "changed") {
        lease.changed();
      }
      return result;
    };
    let result = await runWithCurrentCareerContactImportMaterialWrite(
      entry,
      operation,
    );
    if (result.outcome === "stale") {
      hold(entry);
      result = await runWithMissingCareerContactImportMaterialWrite(
        entry,
        operation,
      );
    }
    reload();
    if (result.outcome !== "ran") {
      present({
        phase: "check",
        entry,
        message: "无法完整验证全部核对提醒；没有调用写入。",
      });
      return {
        outcome: "attention",
        entityId: receiptOf(entry)
          ? careerContactImportMaterialEntityId(receiptOf(entry)!)
          : null,
      };
    }
    const current = result.entry ?? entry;
    if (entry.ticket.kind === "material-cleanup") {
      const inspected = result.value;
      if (typeof inspected === "object" && inspected !== null &&
        "state" in inspected) {
        if (inspected.state === "cleanup_ready" ||
          inspected.state === "already_clean") {
          present({
            phase: "cleanup",
            entry: current,
            message: "已确认附件没有进入材料记录；可以继续清理私有暂存。",
          });
        } else if (inspected.state === "blocked") {
          present({
            phase: "changed",
            entry: current,
            message: "附件清理条件已经变化；没有删除任何无法核对的文件。",
          });
        } else {
          present({
            phase: "check",
            entry: current,
            message: "附件清理状态仍无法确认；只允许再次只读核对。",
          });
        }
      }
      return { outcome: "attention", entityId: entry.ticket.materialId };
    }
    const inspected = result.value;
    if ((inspected === "exact_saved" ||
        inspected === "exact_saved_completed") && result.entry) {
      return finish(result.entry, "committed");
    }
    if (inspected === "exact_saved_cleanup_pending") {
      present({
        phase: "cleanup",
        entry: current,
        message: "数据库写入已确认，但私有附件能力尚未完成收尾；收据会继续保留。",
      });
    } else if (inspected === "changed" && result.entry) {
      return finish(result.entry, "changed");
    } else if (inspected === "expected") {
      present({
        phase: "expected",
        entry: current,
        message: "已确认写入尚未提交。可以放弃安全收据，或继续同一次写入。",
      });
    } else if (inspected === "invalid_receipt") {
      present({
        phase: "invalid",
        entry: current,
        message: "这份收据无法验证；没有据此写入。",
      });
    } else {
      present({
        phase: "check",
        entry: current,
        message: "结果仍无法确认；只允许再次只读核对。",
      });
    }
    return {
      outcome: "attention",
      entityId: careerContactImportMaterialEntityId(entry.ticket.receipt),
    };
  }, [finish, hold, present, reload]);

  const finishCleanup = useCallback(async (
    entry: CareerContactImportMaterialWriteEntry,
  ): Promise<CareerContactImportMaterialSubmitResult> => {
    setFlow({ phase: "working", action: "refresh" });
    try {
      const outcome = await refresh();
      if (outcome !== "applied" || await removeCurrent(entry) !== "ran") {
        present({
          phase: "cleanup",
          entry: latest() ?? entry,
          message: "附件已清理，但提醒尚未完成只读刷新与精确移除。",
        });
        return { outcome: "attention", entityId: null };
      }
      clearHeld(entry);
      setFlow({ phase: "idle" });
      setStatus("附件暂存已安全清理。");
      onToast("附件暂存已安全清理。");
      return { outcome: "attention", entityId: null };
    } catch (reason) {
      setError(messageOf(reason));
      present({
        phase: "cleanup",
        entry,
        message: "附件已清理，但页面尚未完成只读刷新。",
      });
      return { outcome: "attention", entityId: null };
    }
  }, [clearHeld, latest, onToast, present, refresh, removeCurrent]);

  const commitEntry = useCallback(async (
    entry: CareerContactImportMaterialWriteEntry,
    owner: CareerContactImportMaterialOwner,
  ): Promise<CareerContactImportMaterialSubmitResult> => {
    if (databaseMutationActiveExcept(owner) || externalBlockedNow()) {
      present({
        phase: "check",
        entry,
        message: "另一笔数据库操作已经开始；收据仍保留，没有提交。",
      });
      return {
        outcome: "attention",
        entityId: receiptOf(entry)
          ? careerContactImportMaterialEntityId(receiptOf(entry)!)
          : null,
      };
    }
    setFlow({ phase: "working", action: "commit" });
    try {
      const result = await runWithCurrentCareerContactImportMaterialWrite(
        entry,
        async (lease) => {
          if (databaseMutationActiveExcept(owner) || externalBlockedNow()) {
            return { state: "blocked" as const };
          }
          const receipt = receiptOf(entry);
          if (!receipt) return { state: "blocked" as const };
          const committed = await commitCareerContactImportMaterialWrite(
            receipt,
          );
          if ((committed.outcome === "saved" ||
              committed.outcome === "already_saved") &&
            !materialWriteNeedsCleanup(committed)) {
            lease.committed();
            return { state: "saved" as const, committed };
          }
          if (committed.outcome === "changed" &&
            !materialWriteNeedsCleanup(committed)) {
            lease.changed();
            return { state: "changed" as const, committed };
          }
          return {
            state: materialWriteNeedsCleanup(committed)
              ? "cleanup" as const
              : "uncertain" as const,
            committed,
          };
        },
      );
      reload();
      if (result.outcome === "stale") return inspectEntry(entry);
      if (result.outcome !== "ran") {
        present({
          phase: "check",
          entry,
          message: "核对线索暂时无法独占；没有重复提交。",
        });
        return { outcome: "attention", entityId: null };
      }
      if (result.value.state === "saved" && result.entry) {
        return finish(result.entry, "committed");
      }
      if (result.value.state === "changed" && result.entry) {
        return finish(result.entry, "changed");
      }
      const current = result.entry ?? entry;
      present({
        phase: result.value.state === "cleanup" ? "cleanup" : "check",
        entry: current,
        message: result.value.state === "blocked"
          ? "另一笔数据库操作已经开始；收据仍保留，没有提交。"
          : result.value.state === "cleanup"
            ? "数据库标记已确认，但私有附件收尾尚未完成；收据仍保留。"
            : "这次结果需要只读核对；不会凭猜测重复提交。",
      });
      return {
        outcome: "attention",
        entityId: receiptOf(entry)
          ? careerContactImportMaterialEntityId(receiptOf(entry)!)
          : null,
      };
    } catch (reason) {
      reload();
      setError(messageOf(reason));
      present({
        phase: "check",
        entry,
        message: "这次结果需要只读核对；收据仍保留。",
      });
      return { outcome: "attention", entityId: null };
    }
  }, [
    databaseMutationActiveExcept,
    externalBlockedNow,
    finish,
    inspectEntry,
    present,
    reload,
  ]);

  type Prepared = Readonly<{
    receipt: CareerContactImportMaterialWriteReceipt;
    cleanupCheckpointed: boolean;
  }>;

  const submitPrepare = useCallback(async (
    owner: CareerContactImportMaterialOwner,
    prepare: (lease: CareerContactImportMaterialWriteLease) => Promise<Prepared>,
    trigger: HTMLElement,
    lifecycle?: CareerContactImportMaterialSettlementLifecycle,
  ): Promise<CareerContactImportMaterialSubmitResult> => {
    if (operationRef.current || snapshotStaleNowRef.current()) {
      return { outcome: "blocked", entityId: null };
    }
    const token = claimDatabaseMutation(owner);
    if (!token) return { outcome: "blocked", entityId: null };
    operationRef.current = true;
    setError("");
    setFlow({ phase: "working", action: "prepare" });
    try {
      const result = await runWithEmptyCareerContactImportMaterialWrite(
        async (lease) => {
          if (databaseMutationActiveExcept(owner) || externalBlockedNow() ||
            snapshotStaleNowRef.current()) {
            return { state: "blocked" as const };
          }
          const prepared = await prepare(lease);
          const volatile = createCareerContactImportMaterialWriteEntry(
            createCareerContactImportMaterialWriteTicket(prepared.receipt),
          );
          hold(volatile);
          if (prepared.cleanupCheckpointed) {
            if (prepared.receipt.purpose !== "career-material-write") {
              throw new Error("清理凭据只能提升为材料写入回执。");
            }
            lease.promote(prepared.receipt);
          } else {
            lease.checkpoint(prepared.receipt);
          }
          settlementRegistryRef.current.remember(
            prepared.receipt,
            lifecycle,
          );
          triggerRef.current.set(prepared.receipt.operationId, trigger);
          if (databaseMutationActiveExcept(owner) || externalBlockedNow() ||
            snapshotStaleNowRef.current()) {
            return {
              state: "prepared" as const,
              receipt: prepared.receipt,
            };
          }
          const committed = await commitCareerContactImportMaterialWrite(
            prepared.receipt,
          );
          if ((committed.outcome === "saved" ||
              committed.outcome === "already_saved") &&
            !materialWriteNeedsCleanup(committed)) {
            lease.committed();
            return {
              state: "saved" as const,
              receipt: prepared.receipt,
              committed,
            };
          }
          if (committed.outcome === "changed" &&
            !materialWriteNeedsCleanup(committed)) {
            lease.changed();
            return {
              state: "changed" as const,
              receipt: prepared.receipt,
              committed,
            };
          }
          return {
            state: materialWriteNeedsCleanup(committed)
              ? "cleanup" as const
              : "uncertain" as const,
            receipt: prepared.receipt,
            committed,
          };
        },
      );
      reload();
      if (result.outcome !== "ran") {
        const pending = latest();
        if (pending) present(phaseFor(pending));
        return { outcome: "attention", entityId: null };
      }
      if (result.value.state === "blocked") {
        setFlow({ phase: "idle" });
        return { outcome: "blocked", entityId: null };
      }
      const entry = result.entry;
      if (!entry) {
        setFlow({ phase: "idle" });
        return { outcome: "blocked", entityId: null };
      }
      hold(entry);
      if (result.value.state === "saved") return finish(entry, "committed");
      if (result.value.state === "changed") return finish(entry, "changed");
      present({
        phase: result.value.state === "cleanup" ? "cleanup" : "check",
        entry,
        message: result.value.state === "cleanup"
          ? "数据库结果已确认，但私有附件收尾尚未完成；收据仍保留。"
          : result.value.state === "prepared"
            ? "准备期间资料发生变化；收据已保留，只允许先核对。"
            : "提交结果暂时无法确认；收据已持久保留。",
      });
      return {
        outcome: "attention",
        entityId: careerContactImportMaterialEntityId(result.value.receipt),
      };
    } catch (reason) {
      reload();
      setError(messageOf(reason));
      const pending = latest();
      if (pending) present(phaseFor(pending));
      else setFlow({ phase: "idle" });
      return pending
        ? { outcome: "attention", entityId: null }
        : { outcome: "blocked", entityId: null };
    } finally {
      operationRef.current = false;
      releaseDatabaseMutation(token);
    }
  }, [
    claimDatabaseMutation,
    databaseMutationActiveExcept,
    externalBlockedNow,
    finish,
    hold,
    latest,
    present,
    reload,
    releaseDatabaseMutation,
  ]);

  const simplePrepare = useCallback((
    owner: "contact" | "import",
    prepare: () => Promise<CareerContactImportMaterialWriteReceipt>,
    trigger: HTMLElement,
    lifecycle?: CareerContactImportMaterialSettlementLifecycle,
  ) => submitPrepare(
    owner,
    async () => ({ receipt: await prepare(), cleanupCheckpointed: false }),
    trigger,
    lifecycle,
  ), [submitPrepare]);

  const submitContactCreate = useCallback((
    input: CreateCareerContactInput,
    expected: CareerContactDisplayedExpected,
    trigger: HTMLElement,
    lifecycle?: CareerContactImportMaterialSettlementLifecycle,
  ) => simplePrepare(
    "contact",
    () => prepareCareerContactCreate(input, expected),
    trigger,
    lifecycle,
  ), [simplePrepare]);

  const submitContactUpdate = useCallback((
    input: UpdateCareerContactInput,
    expected: CareerContactDisplayedExpected,
    trigger: HTMLElement,
    lifecycle?: CareerContactImportMaterialSettlementLifecycle,
  ) => simplePrepare(
    "contact",
    () => prepareCareerContactUpdate(input, expected),
    trigger,
    lifecycle,
  ), [simplePrepare]);

  const submitContactArchive = useCallback((
    expected: CareerContactDisplayedExpected,
    trigger: HTMLElement,
    lifecycle?: CareerContactImportMaterialSettlementLifecycle,
  ) => simplePrepare(
    "contact",
    () => prepareCareerContactArchive(expected),
    trigger,
    lifecycle,
  ), [simplePrepare]);

  const submitContactRestore = useCallback((
    expected: CareerContactDisplayedExpected,
    trigger: HTMLElement,
    lifecycle?: CareerContactImportMaterialSettlementLifecycle,
  ) => simplePrepare(
    "contact",
    () => prepareCareerContactRestore(expected),
    trigger,
    lifecycle,
  ), [simplePrepare]);

  const submitContactInteraction = useCallback((
    input: RecordCareerContactInteractionInput,
    expected: CareerContactDisplayedExpected,
    trigger: HTMLElement,
    lifecycle?: CareerContactImportMaterialSettlementLifecycle,
  ) => simplePrepare(
    "contact",
    () => prepareCareerContactInteraction(input, expected),
    trigger,
    lifecycle,
  ), [simplePrepare]);

  const submitContactTask = useCallback((
    input: CreateCareerContactTaskInput,
    expected: CareerContactDisplayedExpected,
    trigger: HTMLElement,
    lifecycle?: CareerContactImportMaterialSettlementLifecycle,
  ) => simplePrepare(
    "contact",
    () => prepareCareerContactTask(input, expected),
    trigger,
    lifecycle,
  ), [simplePrepare]);

  const submitImport = useCallback((
    items: readonly CareerImportCommitItem[],
    expected: CareerImportDisplayedExpected,
    trigger: HTMLElement,
    lifecycle?: CareerContactImportMaterialSettlementLifecycle,
  ) => simplePrepare(
    "import",
    () => prepareCareerImportWrite(items, expected),
    trigger,
    lifecycle,
  ), [simplePrepare]);

  const submitMaterialSave = useCallback((
    input: CareerMaterialWriteSaveInput,
    expected: CareerMaterialSaveDisplayedExpected,
    trigger: HTMLElement,
    lifecycle?: CareerContactImportMaterialSettlementLifecycle,
  ) => submitPrepare(
    "material",
    async (lease) => {
      let cleanupCheckpointed = false;
      const receipt = await prepareCareerMaterialSaveWrite(input, expected, {
        onCleanupPrepared(prepared) {
          const volatile = createCareerContactImportMaterialWriteEntry(
            createCareerMaterialCleanupWriteTicket(prepared),
          );
          hold(volatile);
          lease.checkpointCleanup(prepared);
          cleanupCheckpointed = true;
        },
      });
      return { receipt, cleanupCheckpointed };
    },
    trigger,
    lifecycle,
  ), [hold, submitPrepare]);

  const submitMaterialDelete = useCallback((
    expected: CareerMaterialDeleteUiDisplayedExpected,
    trigger: HTMLElement,
    lifecycle?: CareerContactImportMaterialSettlementLifecycle,
  ) => submitPrepare(
    "material",
    async () => ({
      receipt: await prepareCareerMaterialDeleteWriteForUi(expected),
      cleanupCheckpointed: false,
    }),
    trigger,
    lifecycle,
  ), [submitPrepare]);

  const inspectActive = useCallback(async () => {
    if (!("entry" in flow) || operationRef.current) return;
    operationRef.current = true;
    try {
      await inspectEntry(flow.entry);
    } catch (reason) {
      setError(messageOf(reason));
      setFlow(phaseFor(latest() ?? flow.entry));
    } finally {
      operationRef.current = false;
    }
  }, [flow, inspectEntry, latest]);

  const continueActive = useCallback(async () => {
    if (!(flow.phase === "expected" || flow.phase === "cleanup") ||
      operationRef.current) return;
    const entry = flow.entry;
    const owner: CareerContactImportMaterialOwner = "material";
    const receipt = receiptOf(entry);
    const resolvedOwner = receipt
      ? careerContactImportMaterialOwner(receipt)
      : owner;
    const token = claimDatabaseMutation(resolvedOwner);
    if (!token) return;
    operationRef.current = true;
    setError("");
    try {
      if (entry.ticket.kind !== "material-cleanup") {
        await commitEntry(entry, resolvedOwner);
        return;
      }
      setFlow({ phase: "working", action: "cleanup" });
      const result = await runWithCurrentCareerContactImportMaterialWrite(
        entry,
        async () => retryCareerMaterialFileCleanup({
          operationId: entry.ticket.kind === "material-cleanup"
            ? entry.ticket.operationId
            : "",
          materialId: entry.ticket.kind === "material-cleanup"
            ? entry.ticket.materialId
            : "",
          cleanupReceipt: entry.ticket.kind === "material-cleanup"
            ? entry.ticket.cleanupReceipt
            : { purpose: "career-material-cleanup", version: 1, handle: "" },
        }),
      );
      reload();
      if (result.outcome === "ran" &&
        (result.value.outcome === "cleaned" ||
          result.value.outcome === "already_cleaned")) {
        await finishCleanup(result.entry ?? entry);
      } else {
        present({
          phase: "cleanup",
          entry: result.outcome === "ran" ? result.entry ?? entry : entry,
          message: "附件清理尚未确认完成；凭据仍保留。",
        });
      }
    } catch (reason) {
      setError(messageOf(reason));
      present({
        phase: "cleanup",
        entry,
        message: "附件清理尚未确认完成；凭据仍保留。",
      });
    } finally {
      operationRef.current = false;
      releaseDatabaseMutation(token);
    }
  }, [
    claimDatabaseMutation,
    commitEntry,
    finishCleanup,
    flow,
    present,
    reload,
    releaseDatabaseMutation,
  ]);

  const retryRefresh = useCallback(async () => {
    if (!(flow.phase === "refresh-only" || flow.phase === "changed") ||
      operationRef.current) return;
    const receipt = receiptOf(flow.entry);
    if (!receipt) return;
    operationRef.current = true;
    try {
      await finish(
        flow.entry,
        flow.phase === "refresh-only" ? "committed" : "changed",
      );
    } finally {
      operationRef.current = false;
    }
  }, [finish, flow]);

  const abandonChangedAndRefresh = useCallback(async () => {
    if (flow.phase !== "changed" || operationRef.current) return;
    const receipt = receiptOf(flow.entry);
    if (receipt) settlementRegistryRef.current.abandonChanged(receipt);
    operationRef.current = true;
    try { await finish(flow.entry, "changed"); }
    finally { operationRef.current = false; }
  }, [finish, flow]);

  const discardTerminal = useCallback(async () => {
    if (!(flow.phase === "expected" || flow.phase === "invalid") ||
      operationRef.current) return;
    const entry = flow.entry;
    const receipt = receiptOf(entry);
    if (receipt && !receiptCanBeDiscarded(receipt)) {
      setError("这张材料收据仍绑定私有附件能力；请继续同一次操作或先完成安全收尾。");
      return;
    }
    operationRef.current = true;
    setError("");
    try {
      if (await removeCurrent(entry) === "ran") {
        clearHeld(entry);
        if (receipt) {
          settlementRegistryRef.current.notify(receipt, "discarded");
          settlementRegistryRef.current.forget(receipt);
          restoreTrigger(receipt);
        }
        setFlow({ phase: "idle" });
        setStatus("这张确定未写入的收据已放弃；现有资料没有改变。");
      } else {
        setFlow(phaseFor(latest() ?? entry));
      }
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      operationRef.current = false;
    }
  }, [clearHeld, flow, latest, removeCurrent, restoreTrigger]);

  const removeFirstUnreadable = useCallback(async () => {
    const first = journalRef.current.unreadable[0];
    if (!first || operationRef.current) return;
    operationRef.current = true;
    setError("");
    try {
      if (!await removeUnreadableCareerContactImportMaterialWrite(first)) {
        throw new Error("这条提醒已经变化或暂时无法清除。");
      }
      const next = latest();
      setFlow(next ? phaseFor(next) : { phase: "idle" });
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      operationRef.current = false;
    }
  }, [latest]);

  return {
    journal,
    flow,
    error,
    status,
    busy,
    databaseMutationLocked,
    hasHeldReceipt: barrier.blocksWrites,
    hasRecoveryAttention,
    hasVolatileWork,
    attentionRef: attentionRef as RefObject<HTMLDivElement>,
    isWriteInProgress: () => operationRef.current,
    ownsExactReceipt: (
      receipt: CareerContactImportMaterialWriteReceipt,
    ) => settlementRegistryRef.current.ownsExact(receipt),
    submitContactCreate,
    submitContactUpdate,
    submitContactArchive,
    submitContactRestore,
    submitContactInteraction,
    submitContactTask,
    submitImport,
    submitMaterialSave,
    submitMaterialDelete,
    inspectActive,
    continueActive,
    retryRefresh,
    abandonChangedAndRefresh,
    discardTerminal,
    removeFirstUnreadable,
    retryStorage: () => {
      setError("");
      const next = latest();
      setFlow(next ? phaseFor(next) : { phase: "idle" });
    },
  } as const;
}
