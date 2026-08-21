"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  activatePreparedFitnessRestore,
  discardPreparedFitnessRestore,
  inspectFitnessRestoreActivation,
  prepareFitnessBackupRestore,
  recoverFitnessBackupPrepare,
  retryFitnessPrepareCleanup,
  FitnessActivationUncertainError,
  FitnessCurrentGenerationChangedError,
  FitnessDiscardUncertainError,
  FitnessPrepareCleanupIncompleteError,
  FitnessPrepareUncertainError,
  type FitnessPrepareCleanupReceipt,
  type FitnessRestoreReceipt,
  type FitnessRestoreSummary,
} from "@/lib/fitness/backup";
import {
  FITNESS_BACKUP_RECOVERY_PREFIX,
  readFitnessBackupRecoveryStorage,
  reconcileFitnessBackupVolatileTransition,
  removeFitnessBackupRecoveryEntry,
  runNewFitnessBackupRecovery,
  runWithCurrentFitnessBackupEntry,
  type FitnessBackupRecoveryEntry,
  type FitnessBackupRecoveryLease,
  type FitnessBackupRecoveryTicket,
  type FitnessBackupUnreadableEntry,
  type FitnessBackupVolatileTransition,
} from "./backup-recovery";

type FitnessBackupFlowState =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "preparing"; fileName: string }>
  | Readonly<{ phase: "checking"; title: string; message: string }>
  | Readonly<{ phase: "review"; entry: FitnessBackupRecoveryEntry; message?: string }>
  | Readonly<{ phase: "activating"; entry: FitnessBackupRecoveryEntry }>
  | Readonly<{ phase: "activation-check"; entry: FitnessBackupRecoveryEntry; message: string }>
  | Readonly<{ phase: "discard-only"; entry: FitnessBackupRecoveryEntry; message: string }>
  | Readonly<{ phase: "discarding"; entry: FitnessBackupRecoveryEntry }>
  | Readonly<{ phase: "prepare-cleanup"; entry: FitnessBackupRecoveryEntry; message: string }>
  | Readonly<{ phase: "cleaning"; entry: FitnessBackupRecoveryEntry }>
  | Readonly<{ phase: "refreshing"; entry: FitnessBackupRecoveryEntry; message: string }>
  | Readonly<{ phase: "refresh-only"; entry: FitnessBackupRecoveryEntry; message: string }>
  | Readonly<{ phase: "error"; title: string; message: string }>;

type FitnessBackupFlowProps = Readonly<{
  controlsDisabled?: boolean;
  onExport(): Promise<string>;
  onRefreshActivated(): Promise<void>;
  onNotice(message: string): void;
}>;

function recordedAt(): string {
  return new Date().toISOString();
}

function prepareTicket(
  receipt: Parameters<typeof recoverFitnessBackupPrepare>[0],
): FitnessBackupRecoveryTicket {
  return { version: 1, kind: "prepare", receipt, recordedAt: recordedAt() };
}

function candidateTicket(
  receipt: FitnessRestoreReceipt,
  mode: "review" | "activation-check" | "discard-only",
): FitnessBackupRecoveryTicket {
  return { version: 1, kind: "candidate", mode, receipt, recordedAt: recordedAt() };
}

function cleanupTicket(
  receipt: FitnessPrepareCleanupReceipt,
): FitnessBackupRecoveryTicket {
  return { version: 1, kind: "prepare-cleanup", receipt, recordedAt: recordedAt() };
}

function refreshTicket(receipt: FitnessRestoreReceipt): FitnessBackupRecoveryTicket {
  return { version: 1, kind: "refresh-only", receipt, recordedAt: recordedAt() };
}

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : null;
}

function safeDisplayFileName(file: File): string {
  const name = Array.from(file.name || "所选文件").slice(0, 255).join("");
  return name || "所选文件";
}

function formatBackupBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "大小未确认";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(
      value < 10 * 1024 * 1024 ? 1 : 0,
    )} MB`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatBackupDate(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function ticketActionLabel(entry: FitnessBackupRecoveryEntry): string {
  if (entry.ticket.kind === "refresh-only") return "只重新读取";
  if (entry.ticket.kind === "prepare-cleanup") return "继续收尾";
  if (entry.ticket.kind === "prepare") return "继续核对";
  if (entry.ticket.mode === "activation-check") return "只核对当前版本";
  if (entry.ticket.mode === "discard-only") return "继续收尾";
  return "继续核对";
}

function entryReceipt(entry: FitnessBackupRecoveryEntry): FitnessRestoreReceipt | null {
  return entry.ticket.kind === "candidate" || entry.ticket.kind === "refresh-only"
    ? entry.ticket.receipt
    : null;
}

type TransitionTracker = {
  current: FitnessBackupVolatileTransition | null;
};

function trackedReplace(
  lease: FitnessBackupRecoveryLease,
  ticket: FitnessBackupRecoveryTicket,
  tracker: TransitionTracker,
): FitnessBackupRecoveryEntry {
  tracker.current = { ticket, expected: lease.current() };
  const next = lease.replace(ticket);
  tracker.current = null;
  return next;
}

export function FitnessBackupFlow({
  controlsDisabled = false,
  onExport,
  onRefreshActivated,
  onNotice,
}: FitnessBackupFlowProps) {
  const [flow, setFlow] = useState<FitnessBackupFlowState>({ phase: "idle" });
  const [entries, setEntries] = useState<readonly FitnessBackupRecoveryEntry[]>([]);
  const [unreadableEntries, setUnreadableEntries] = useState<readonly FitnessBackupUnreadableEntry[]>([]);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [volatileTransition, setVolatileTransition] = useState<FitnessBackupVolatileTransition | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [prepareStopping, setPrepareStopping] = useState(false);
  const operationRef = useRef(false);
  const prepareControllerRef = useRef<AbortController | null>(null);
  const pickerInputRef = useRef<HTMLInputElement>(null);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const recoveryButtonRef = useRef<HTMLButtonElement>(null);
  const flowHeadingRef = useRef<HTMLHeadingElement>(null);
  const shouldFocusFlowRef = useRef(false);
  const backendRejectedRef = useRef(new Set<string>());

  const reloadRecoveries = useCallback(() => {
    if (!navigator.locks) {
      setEntries([]);
      setUnreadableEntries([]);
      setStorageUnavailable(true);
      setLoaded(true);
      return {
        entries: [] as readonly FitnessBackupRecoveryEntry[],
        unreadableEntries: [] as readonly FitnessBackupUnreadableEntry[],
        storageUnavailable: true,
      };
    }
    const result = readFitnessBackupRecoveryStorage();
    if (result.storageUnavailable) {
      setStorageUnavailable(true);
      setLoaded(true);
      return result;
    }
    const rejected: FitnessBackupUnreadableEntry[] = [];
    const valid = result.entries.filter((entry) => {
      const key = `${entry.storageKey}\u001f${entry.raw}`;
      if (!backendRejectedRef.current.has(key)) return true;
      rejected.push({ storageKey: entry.storageKey, raw: entry.raw });
      return false;
    });
    const unreadable = [...result.unreadableEntries, ...rejected];
    setEntries(valid);
    setUnreadableEntries(unreadable);
    setStorageUnavailable(false);
    setLoaded(true);
    return {
      entries: valid,
      unreadableEntries: unreadable,
      storageUnavailable: false,
    };
  }, []);

  const present = useCallback((next: FitnessBackupFlowState) => {
    shouldFocusFlowRef.current = true;
    setFlow(next);
  }, []);

  const focusCompletionTarget = useCallback(() => {
    window.requestAnimationFrame(() =>
      (recoveryButtonRef.current ?? pickerButtonRef.current)?.focus({
        preventScroll: true,
      }));
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(reloadRecoveries);
    function onStorage(event: StorageEvent) {
      if (!event.key || event.key.startsWith(FITNESS_BACKUP_RECOVERY_PREFIX)) {
        reloadRecoveries();
      }
    }
    function onFocus() {
      reloadRecoveries();
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
    };
  }, [reloadRecoveries]);

  useEffect(() => {
    if (flow.phase !== "preparing" && !volatileTransition) return;
    function protectUnfinishedRestore(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", protectUnfinishedRestore);
    return () => window.removeEventListener("beforeunload", protectUnfinishedRestore);
  }, [flow.phase, volatileTransition]);

  useEffect(() => {
    if (!shouldFocusFlowRef.current || flow.phase === "idle") return;
    shouldFocusFlowRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      flowHeadingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [flow.phase]);

  const operationBusy = flow.phase === "preparing" ||
    flow.phase === "checking" ||
    flow.phase === "activating" ||
    flow.phase === "discarding" ||
    flow.phase === "cleaning" ||
    flow.phase === "refreshing";
  const activeEntry = entries[0] ?? null;
  const recoveryActionsLocked = !loaded || storageUnavailable ||
    Boolean(volatileTransition) || unreadableEntries.length > 0;
  const restoreLocked = exportBusy || operationBusy || Boolean(activeEntry) ||
    recoveryActionsLocked;

  function explainStaleRunner() {
    reloadRecoveries();
    present({
      phase: "error",
      title: "另一个页面更新了这次核对",
      message: "这里没有沿用旧步骤，也没有调用后端。请从最新提醒继续。",
    });
  }

  function explainRunnerGate(
    outcome: "stale" | "blocked" | "unavailable",
  ) {
    if (outcome === "stale") {
      explainStaleRunner();
      return;
    }
    if (outcome === "blocked") {
      reloadRecoveries();
      present({
        phase: "error",
        title: "先处理无法读取的继续提醒",
        message: "检测到另一条无法安全读取的提醒，因此没有调用恢复、核对或清理后端。只清除损坏提醒后，才能继续原候选。",
      });
      return;
    }
    setStorageUnavailable(true);
    present({
      phase: "error",
      title: "暂时无法安全读取继续信息",
      message: "没有调用恢复、核对或清理后端。浏览器存储恢复后，只重试存储检查。",
    });
  }

  function explainJournalFailure(
    tracker: TransitionTracker,
    fallback: string,
  ) {
    if (tracker.current) {
      setVolatileTransition(tracker.current);
      setStorageUnavailable(true);
    } else {
      reloadRecoveries();
    }
    present({
      phase: "error",
      title: "继续信息暂时无法安全保存",
      message: tracker.current
        ? "原提醒与下一步凭据都保留在这页。先不要关闭；浏览器存储恢复前不会重复调用后端。"
        : fallback,
    });
  }

  function markBackendRejected(entry: FitnessBackupRecoveryEntry) {
    backendRejectedRef.current.add(`${entry.storageKey}\u001f${entry.raw}`);
    reloadRecoveries();
    present({
      phase: "error",
      title: "这条继续信息无法核对",
      message: "没有启用或删除任何内容。可以保留本机候选，只清除这条提醒；清除后无法在这里继续它。",
    });
  }

  async function refreshWithinLease(
    lease: FitnessBackupRecoveryLease,
    entry: FitnessBackupRecoveryEntry,
    message: string,
  ) {
    present({ phase: "refreshing", entry, message });
    try {
      await onRefreshActivated();
    } catch {
      return { kind: "refresh-only", entry } as const;
    }
    lease.remove();
    return { kind: "refreshed" } as const;
  }

  async function refreshActivated(
    entry: FitnessBackupRecoveryEntry,
    message: string,
    continueCurrentOperation = false,
  ) {
    if (
      recoveryActionsLocked ||
      entry.ticket.kind !== "refresh-only" ||
      (operationRef.current && !continueCurrentOperation)
    ) return;
    const ownsOperation = !operationRef.current;
    if (ownsOperation) operationRef.current = true;
    const tracker: TransitionTracker = { current: null };
    try {
      const result = await runWithCurrentFitnessBackupEntry(
        entry,
        async (lease) => await refreshWithinLease(lease, entry, message),
      );
      if (result.outcome !== "ran") {
        explainRunnerGate(result.outcome);
        return;
      }
      if (result.value.kind === "refreshed") {
        backendRejectedRef.current.delete(`${entry.storageKey}\u001f${entry.raw}`);
        reloadRecoveries();
        setFlow({ phase: "idle" });
        onNotice("备份已经启用，页面资料也已重新读取。");
        focusCompletionTarget();
      } else {
        present({
          phase: "refresh-only",
          entry: result.value.entry,
          message: "备份已经启用。页面暂时没有重新读到它，只需重新读取，不会重复启用。",
        });
      }
    } catch {
      explainJournalFailure(
        tracker,
        "页面没有重复启用备份。恢复浏览器存储后，只会沿原提醒重新读取。",
      );
    } finally {
      if (ownsOperation) operationRef.current = false;
    }
  }

  async function inspectCandidate(
    entry: FitnessBackupRecoveryEntry,
    continueCurrentOperation = false,
  ) {
    if (
      recoveryActionsLocked ||
      entry.ticket.kind !== "candidate" ||
      (operationRef.current && !continueCurrentOperation)
    ) return;
    const { receipt, mode } = entry.ticket;
    const ownsOperation = !operationRef.current;
    if (ownsOperation) operationRef.current = true;
    const tracker: TransitionTracker = { current: null };
    try {
      present({
        phase: "checking",
        title: "正在核对当前版本",
        message: "只读取版本状态，不会再次启用，也不会清理候选。",
      });
      const result = await runWithCurrentFitnessBackupEntry(entry, async (lease) => {
        let inspection: Awaited<ReturnType<typeof inspectFitnessRestoreActivation>>;
        try {
          inspection = await inspectFitnessRestoreActivation(receipt);
        } catch (error) {
          return {
            kind: errorCode(error) === "INVALID_RECEIPT"
              ? "invalid"
              : mode === "activation-check"
                ? "activation-check-error"
                : "inspect-error",
            entry: lease.current() ?? entry,
          } as const;
        }
        if (inspection.status === "current") {
          const refreshEntry = trackedReplace(
            lease,
            refreshTicket(receipt),
            tracker,
          );
          return await refreshWithinLease(
            lease,
            refreshEntry,
            "这份备份已经启用，只需让页面重新读取资料。",
          );
        }
        const baselineUnchanged =
          inspection.currentGenerationId === receipt.expectedCurrentGenerationId &&
          inspection.currentSequence === receipt.expectedCurrentSequence;
        if (mode === "review" && baselineUnchanged) {
          return { kind: "review", entry: lease.current() ?? entry } as const;
        }
        const next = trackedReplace(
          lease,
          candidateTicket(receipt, "discard-only"),
          tracker,
        );
        return {
          kind: "discard-only",
          entry: next,
          message: mode === "activation-check" && baselineUnchanged
            ? "已经确认这次没有切换。为避免重复启用，现在只收起这份候选。"
            : "当前健身资料版本在候选建立后已有变化。这份候选不会覆盖它，现在只收起候选。",
        } as const;
      });
      if (result.outcome !== "ran") {
        explainRunnerGate(result.outcome);
        return;
      }
      const outcome = result.value;
      if (outcome.kind === "refreshed") {
        reloadRecoveries();
        setFlow({ phase: "idle" });
        onNotice("备份已经启用，页面资料也已重新读取。");
        focusCompletionTarget();
      } else if (outcome.kind === "refresh-only") {
        present({
          phase: "refresh-only",
          entry: outcome.entry,
          message: "备份已经启用。页面暂时没有重新读到它，只需重新读取，不会重复启用。",
        });
      } else if (outcome.kind === "review") {
        present({
          phase: "review",
          entry: outcome.entry,
          message: "候选与当前健身资料仍然匹配，请核对后再决定。",
        });
      } else if (outcome.kind === "discard-only") {
        reloadRecoveries();
        present({
          phase: "discard-only",
          entry: outcome.entry,
          message: outcome.message,
        });
      } else if (outcome.kind === "invalid") {
        markBackendRejected(outcome.entry);
      } else if (outcome.kind === "activation-check-error") {
        present({
          phase: "activation-check",
          entry: outcome.entry,
          message: "当前版本暂时没有读到。继续时仍只会重新核对，不会重复启用。",
        });
      } else {
        present({
          phase: "error",
          title: "当前版本暂时没有读到",
          message: "候选与继续信息仍保留着。稍后再点继续即可，不需要重新选择备份。",
        });
      }
    } catch {
      explainJournalFailure(
        tracker,
        "没有调用新的恢复动作。恢复浏览器存储后，再从原提醒继续只读核对。",
      );
    } finally {
      if (ownsOperation) operationRef.current = false;
    }
  }

  async function recoverPreparation(entry: FitnessBackupRecoveryEntry) {
    if (
      recoveryActionsLocked || entry.ticket.kind !== "prepare" ||
      operationRef.current
    ) return;
    const prepareReceiptValue = entry.ticket.receipt;
    operationRef.current = true;
    const tracker: TransitionTracker = { current: null };
    try {
      present({
        phase: "checking",
        title: "正在继续同一次准备",
        message: "沿用上次留下的凭据，不会重新读取备份文件，也不会切换当前健身资料。",
      });
      const result = await runWithCurrentFitnessBackupEntry(entry, async (lease) => {
        let recovered: Awaited<ReturnType<typeof recoverFitnessBackupPrepare>>;
        try {
          recovered = await recoverFitnessBackupPrepare(prepareReceiptValue);
        } catch (error) {
          return {
            kind: errorCode(error) === "INVALID_RECEIPT" ? "invalid" : "recover-error",
            entry: lease.current() ?? entry,
          } as const;
        }
        if (recovered.status === "ready") {
          const candidate = trackedReplace(
            lease,
            candidateTicket(recovered.receipt, "review"),
            tracker,
          );
          let inspection: Awaited<ReturnType<typeof inspectFitnessRestoreActivation>>;
          try {
            inspection = await inspectFitnessRestoreActivation(recovered.receipt);
          } catch (error) {
            return {
              kind: errorCode(error) === "INVALID_RECEIPT" ? "invalid" : "inspect-error",
              entry: lease.current() ?? candidate,
            } as const;
          }
          if (inspection.status === "current") {
            const refreshEntry = trackedReplace(
              lease,
              refreshTicket(recovered.receipt),
              tracker,
            );
            return await refreshWithinLease(
              lease,
              refreshEntry,
              "这份备份已经启用，只需让页面重新读取资料。",
            );
          }
          const baselineUnchanged =
            inspection.currentGenerationId === recovered.receipt.expectedCurrentGenerationId &&
            inspection.currentSequence === recovered.receipt.expectedCurrentSequence;
          if (baselineUnchanged) return { kind: "review", entry: candidate } as const;
          const discardEntry = trackedReplace(
            lease,
            candidateTicket(recovered.receipt, "discard-only"),
            tracker,
          );
          return { kind: "discard-only", entry: discardEntry } as const;
        }
        if (recovered.status === "cleanup-pending") {
          const cleanupEntry = trackedReplace(
            lease,
            cleanupTicket(recovered.cleanupReceipt),
            tracker,
          );
          return { kind: "prepare-cleanup", entry: cleanupEntry } as const;
        }
        lease.remove();
        return { kind: "cleared", status: recovered.status } as const;
      });
      if (result.outcome !== "ran") {
        explainRunnerGate(result.outcome);
        return;
      }
      const outcome = result.value;
      if (outcome.kind === "review") {
        reloadRecoveries();
        present({
          phase: "review",
          entry: outcome.entry,
          message: "候选与当前健身资料仍然匹配，请核对后再决定。",
        });
      } else if (outcome.kind === "discard-only") {
        reloadRecoveries();
        present({
          phase: "discard-only",
          entry: outcome.entry,
          message: "当前健身资料版本在候选建立后已有变化。这份候选不会覆盖它，现在只收起候选。",
        });
      } else if (outcome.kind === "prepare-cleanup") {
        reloadRecoveries();
        present({
          phase: "prepare-cleanup",
          entry: outcome.entry,
          message: "当前健身资料没有改变。只需收起这次没有启用的临时附件。",
        });
      } else if (outcome.kind === "refreshed") {
        reloadRecoveries();
        setFlow({ phase: "idle" });
        onNotice("备份已经启用，页面资料也已重新读取。");
        focusCompletionTarget();
      } else if (outcome.kind === "refresh-only") {
        present({
          phase: "refresh-only",
          entry: outcome.entry,
          message: "备份已经启用。页面暂时没有重新读到它，只需重新读取，不会重复启用。",
        });
      } else if (outcome.kind === "cleared") {
        reloadRecoveries();
        setFlow({ phase: "idle" });
        onNotice(outcome.status === "discarded"
          ? "上次未完成的候选已经收起，当前健身资料没有改变。"
          : "上次的临时附件已经收尾，当前健身资料没有改变。");
        focusCompletionTarget();
      } else if (outcome.kind === "invalid") {
        markBackendRejected(outcome.entry);
      } else {
        present({
          phase: "error",
          title: outcome.kind === "inspect-error" ? "当前版本暂时没有读到" : "这次核对还没完成",
          message: "继续信息仍保留着。稍后再试即可，不需要重新选择备份。",
        });
      }
    } catch {
      explainJournalFailure(
        tracker,
        "没有重新导入或切换。恢复浏览器存储后，再沿原准备收据继续。",
      );
    } finally {
      operationRef.current = false;
    }
  }

  async function activateCandidate(entry: FitnessBackupRecoveryEntry) {
    if (
      recoveryActionsLocked ||
      entry.ticket.kind !== "candidate" ||
      entry.ticket.mode !== "review" ||
      operationRef.current
    ) return;
    const restoreReceipt = entry.ticket.receipt;
    operationRef.current = true;
    const tracker: TransitionTracker = { current: null };
    try {
      const result = await runWithCurrentFitnessBackupEntry(entry, async (lease) => {
        const checkingEntry = trackedReplace(
          lease,
          candidateTicket(restoreReceipt, "activation-check"),
          tracker,
        );
        present({ phase: "activating", entry: checkingEntry });
        try {
          await activatePreparedFitnessRestore(restoreReceipt);
          const refreshEntry = trackedReplace(
            lease,
            refreshTicket(restoreReceipt),
            tracker,
          );
          return await refreshWithinLease(
            lease,
            refreshEntry,
            "备份已经启用，正在重新读取页面资料。",
          );
        } catch (error) {
          if (error instanceof FitnessCurrentGenerationChangedError) {
            const discardEntry = trackedReplace(
              lease,
              candidateTicket(restoreReceipt, "discard-only"),
              tracker,
            );
            return { kind: "discard-only", entry: discardEntry } as const;
          }
          if (errorCode(error) === "INVALID_RECEIPT") {
            return { kind: "invalid", entry: lease.current() ?? checkingEntry } as const;
          }
          const receipt = error instanceof FitnessActivationUncertainError
            ? error.receipt
            : restoreReceipt;
          const uncertainEntry = trackedReplace(
            lease,
            candidateTicket(receipt, "activation-check"),
            tracker,
          );
          return { kind: "activation-check", entry: uncertainEntry } as const;
        }
      });
      if (result.outcome !== "ran") {
        explainRunnerGate(result.outcome);
        return;
      }
      const outcome = result.value;
      if (outcome.kind === "refreshed") {
        reloadRecoveries();
        setFlow({ phase: "idle" });
        onNotice("备份已经启用，页面资料也已重新读取。");
        focusCompletionTarget();
      } else if (outcome.kind === "refresh-only") {
        reloadRecoveries();
        present({
          phase: "refresh-only",
          entry: outcome.entry,
          message: "备份已经启用。页面暂时没有重新读到它，只需重新读取，不会重复启用。",
        });
      } else if (outcome.kind === "discard-only") {
        reloadRecoveries();
        present({
          phase: "discard-only",
          entry: outcome.entry,
          message: "当前健身资料刚刚有过切换，这次没有覆盖它。现在只收起候选。",
        });
      } else if (outcome.kind === "invalid") {
        markBackendRejected(outcome.entry);
      } else {
        reloadRecoveries();
        present({
          phase: "activation-check",
          entry: outcome.entry,
          message: "切换结果暂时没有确认。下一步只会读取当前版本，不会重复启用。",
        });
      }
    } catch {
      explainJournalFailure(
        tracker,
        "没有再次启用候选。恢复浏览器存储后，原提醒只允许核对当前版本。",
      );
    } finally {
      operationRef.current = false;
    }
  }

  async function discardCandidate(entry: FitnessBackupRecoveryEntry) {
    if (
      recoveryActionsLocked || entry.ticket.kind !== "candidate" ||
      operationRef.current
    ) return;
    const { receipt: discardReceipt, mode: discardMode } = entry.ticket;
    operationRef.current = true;
    const tracker: TransitionTracker = { current: null };
    try {
      const result = await runWithCurrentFitnessBackupEntry(entry, async (lease) => {
        const cleanupEntry = discardMode === "discard-only"
          ? lease.current() ?? entry
          : trackedReplace(
              lease,
              candidateTicket(discardReceipt, "discard-only"),
              tracker,
            );
        present({ phase: "discarding", entry: cleanupEntry });
        try {
          const discarded = await discardPreparedFitnessRestore(
            discardReceipt,
          );
          if (discarded.fileCleanup === "incomplete") {
            return {
              kind: "incomplete",
              entry: lease.current() ?? cleanupEntry,
              failedFileCount: discarded.failedFileKeys.length,
            } as const;
          }
          lease.remove();
          return { kind: "discarded" } as const;
        } catch (error) {
          if (errorCode(error) === "INVALID_RECEIPT") {
            return { kind: "invalid", entry: lease.current() ?? cleanupEntry } as const;
          }
          const receipt = error instanceof FitnessDiscardUncertainError
            ? error.receipt
            : discardReceipt;
          const uncertainEntry = trackedReplace(
            lease,
            candidateTicket(receipt, "discard-only"),
            tracker,
          );
          return { kind: "uncertain", entry: uncertainEntry } as const;
        }
      });
      if (result.outcome !== "ran") {
        explainRunnerGate(result.outcome);
        return;
      }
      const outcome = result.value;
      if (outcome.kind === "discarded") {
        reloadRecoveries();
        setFlow({ phase: "idle" });
        onNotice("候选已经收起，当前健身资料没有改变。");
        focusCompletionTarget();
      } else if (outcome.kind === "invalid") {
        markBackendRejected(outcome.entry);
      } else {
        reloadRecoveries();
        present({
          phase: "discard-only",
          entry: outcome.entry,
          message: outcome.kind === "incomplete"
            ? `候选已经收起，还有 ${outcome.failedFileCount} 个临时附件等待收尾。继续时不会启用候选。`
            : "收尾结果暂时没有确认。继续时只会重试同一收据，不会启用候选。",
        });
      }
    } catch {
      explainJournalFailure(
        tracker,
        "没有启用候选。恢复浏览器存储后，只会沿原收据继续收尾。",
      );
    } finally {
      operationRef.current = false;
    }
  }

  async function cleanPreparedFile(entry: FitnessBackupRecoveryEntry) {
    if (
      recoveryActionsLocked || entry.ticket.kind !== "prepare-cleanup" ||
      operationRef.current
    ) return;
    const cleanupReceipt = entry.ticket.receipt;
    operationRef.current = true;
    const tracker: TransitionTracker = { current: null };
    try {
      present({ phase: "cleaning", entry });
      const result = await runWithCurrentFitnessBackupEntry(entry, async (lease) => {
        try {
          await retryFitnessPrepareCleanup(cleanupReceipt);
          lease.remove();
          return { kind: "cleaned" } as const;
        } catch (error) {
          return {
            kind: errorCode(error) === "INVALID_RECEIPT" ? "invalid" : "incomplete",
            entry: lease.current() ?? entry,
          } as const;
        }
      });
      if (result.outcome !== "ran") {
        explainRunnerGate(result.outcome);
        return;
      }
      if (result.value.kind === "cleaned") {
        reloadRecoveries();
        setFlow({ phase: "idle" });
        onNotice("未启用的临时附件已经收尾，当前健身资料没有改变。");
        focusCompletionTarget();
      } else if (result.value.kind === "invalid") {
        markBackendRejected(result.value.entry);
      } else {
        present({
          phase: "prepare-cleanup",
          entry: result.value.entry,
          message: "临时附件暂时没有全部收尾。当前健身资料没有改变，稍后只重试同一清理收据。",
        });
      }
    } catch {
      explainJournalFailure(
        tracker,
        "没有启用候选。恢复浏览器存储后，只会重试同一清理收据。",
      );
    } finally {
      operationRef.current = false;
    }
  }

  async function continueEntry(entry: FitnessBackupRecoveryEntry) {
    if (recoveryActionsLocked || operationRef.current) return;
    if (entry.ticket.kind === "refresh-only") {
      await refreshActivated(
        entry,
        "这份备份已经启用，只需让页面重新读取资料。",
      );
      return;
    }
    if (entry.ticket.kind === "prepare-cleanup") {
      await cleanPreparedFile(entry);
      return;
    }
    if (entry.ticket.kind === "prepare") {
      await recoverPreparation(entry);
      return;
    }
    if (entry.ticket.mode === "discard-only") {
      await discardCandidate(entry);
      return;
    }
    await inspectCandidate(entry);
  }

  async function prepareSelectedBackup(file: File) {
    if (restoreLocked || controlsDisabled || operationRef.current) return;
    operationRef.current = true;
    const controller = new AbortController();
    prepareControllerRef.current = controller;
    setPrepareStopping(false);
    present({ phase: "preparing", fileName: safeDisplayFileName(file) });
    const tracker: TransitionTracker = { current: null };
    try {
      const result = await runNewFitnessBackupRecovery(async (lease) => {
        try {
          const receipt = await prepareFitnessBackupRestore(file, {
            signal: controller.signal,
            onRecoveryPrepared: async (recoveryReceipt) => {
              trackedReplace(
                lease,
                prepareTicket(recoveryReceipt),
                tracker,
              );
            },
          });
          const candidate = trackedReplace(
            lease,
            candidateTicket(receipt, "review"),
            tracker,
          );
          let inspection: Awaited<ReturnType<typeof inspectFitnessRestoreActivation>>;
          try {
            inspection = await inspectFitnessRestoreActivation(receipt);
          } catch (error) {
            return {
              kind: errorCode(error) === "INVALID_RECEIPT" ? "invalid" : "inspect-error",
              entry: lease.current() ?? candidate,
            } as const;
          }
          if (inspection.status === "current") {
            const refreshEntry = trackedReplace(
              lease,
              refreshTicket(receipt),
              tracker,
            );
            return await refreshWithinLease(
              lease,
              refreshEntry,
              "这份备份已经启用，只需让页面重新读取资料。",
            );
          }
          const baselineUnchanged =
            inspection.currentGenerationId === receipt.expectedCurrentGenerationId &&
            inspection.currentSequence === receipt.expectedCurrentSequence;
          if (baselineUnchanged) return { kind: "review", entry: candidate } as const;
          const discardEntry = trackedReplace(
            lease,
            candidateTicket(receipt, "discard-only"),
            tracker,
          );
          return { kind: "discard-only", entry: discardEntry } as const;
        } catch (error) {
          if (tracker.current) throw error;
          if (error instanceof FitnessPrepareUncertainError) {
            const pending = trackedReplace(
              lease,
              prepareTicket(error.receipt),
              tracker,
            );
            return { kind: "prepare-uncertain", entry: pending } as const;
          }
          if (error instanceof FitnessPrepareCleanupIncompleteError) {
            const cleanup = trackedReplace(
              lease,
              cleanupTicket(error.receipt),
              tracker,
            );
            return { kind: "prepare-cleanup", entry: cleanup } as const;
          }
          if (error instanceof FitnessDiscardUncertainError) {
            const discard = trackedReplace(
              lease,
              candidateTicket(error.receipt, "discard-only"),
              tracker,
            );
            return { kind: "discard-only", entry: discard } as const;
          }
          if (lease.current()) lease.remove();
          return {
            kind: errorCode(error) === "PREPARE_ABORTED" ? "aborted" : "prepare-error",
            message: error instanceof Error
              ? error.message
              : "这个文件暂时无法核对，当前健身资料没有改变。",
          } as const;
        }
      });
      if (result.outcome === "blocked") {
        reloadRecoveries();
        present({
          phase: "error",
          title: "已有一次恢复等待处理",
          message: "这里没有读取文件或调用恢复后端。请先从最新提醒继续。",
        });
        return;
      }
      const outcome = result.value;
      reloadRecoveries();
      if (outcome.kind === "review") {
        present({
          phase: "review",
          entry: outcome.entry,
          message: "候选与当前健身资料仍然匹配，请核对后再决定。",
        });
      } else if (outcome.kind === "discard-only") {
        present({
          phase: "discard-only",
          entry: outcome.entry,
          message: "当前健身资料版本在候选建立后已有变化。这份候选不会覆盖它，现在只收起候选。",
        });
      } else if (outcome.kind === "prepare-cleanup") {
        present({
          phase: "prepare-cleanup",
          entry: outcome.entry,
          message: "当前健身资料没有改变。还有临时附件等待收尾。",
        });
      } else if (outcome.kind === "prepare-uncertain") {
        present({
          phase: "error",
          title: "候选还在核对中",
          message: "继续信息已经保留。下一步只会核对同一次准备，不会重新导入。",
        });
      } else if (outcome.kind === "refreshed") {
        setFlow({ phase: "idle" });
        onNotice("备份已经启用，页面资料也已重新读取。");
        focusCompletionTarget();
      } else if (outcome.kind === "refresh-only") {
        present({
          phase: "refresh-only",
          entry: outcome.entry,
          message: "备份已经启用。页面暂时没有重新读到它，只需重新读取，不会重复启用。",
        });
      } else if (outcome.kind === "invalid") {
        markBackendRejected(outcome.entry);
      } else if (outcome.kind === "inspect-error") {
        present({
          phase: "error",
          title: "候选已经建立，当前版本暂时没有读到",
          message: "继续信息仍保留着。下一步只会先核对当前版本，不会直接启用。",
        });
      } else if (outcome.kind === "aborted") {
        setFlow({ phase: "idle" });
        onNotice("已停止核对，当前健身资料没有改变。");
        focusCompletionTarget();
      } else {
        present({
          phase: "error",
          title: "没有使用这个文件",
          message: outcome.message ?? "这个文件暂时无法核对，当前健身资料没有改变。",
        });
      }
    } catch {
      explainJournalFailure(
        tracker,
        "没有在缺少可靠继续信息时开始恢复。请恢复浏览器存储后再试。",
      );
    } finally {
      if (prepareControllerRef.current === controller) {
        prepareControllerRef.current = null;
      }
      setPrepareStopping(false);
      operationRef.current = false;
      reloadRecoveries();
    }
  }

  function stopPreparation() {
    const controller = prepareControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    setPrepareStopping(true);
    controller.abort();
  }

  async function clearUnreadable(entry: FitnessBackupUnreadableEntry) {
    if (operationRef.current || storageUnavailable) return;
    operationRef.current = true;
    try {
      const result = await removeFitnessBackupRecoveryEntry({
        storageKey: entry.storageKey,
        raw: entry.raw ?? "",
      });
      if (result.outcome === "removed" ||
        (entry.raw === null && result.outcome === "stale")) {
        for (const key of backendRejectedRef.current) {
          if (key.startsWith(`${entry.storageKey}\u001f`)) {
            backendRejectedRef.current.delete(key);
          }
        }
        reloadRecoveries();
        setFlow({ phase: "idle" });
        onNotice("只清除了这条提醒；本机候选与当前健身资料都没有被改动。");
        focusCompletionTarget();
      } else if (result.outcome === "unavailable") {
        setStorageUnavailable(true);
        present({
          phase: "error",
          title: "提醒暂时没有清除",
          message: "没有启用或删除任何本机内容。恢复浏览器存储后再试。",
        });
      } else {
        reloadRecoveries();
      }
    } finally {
      operationRef.current = false;
    }
  }

  async function retryRecoveryStorage() {
    if (operationRef.current) return;
    operationRef.current = true;
    try {
      if (volatileTransition) {
        const pending = volatileTransition;
        const result = await reconcileFitnessBackupVolatileTransition(pending);
        if (
          result.outcome === "written" ||
          result.outcome === "persisted" ||
          result.outcome === "adopted"
        ) {
          setVolatileTransition(null);
          setStorageUnavailable(false);
          reloadRecoveries();
          if (result.entry.ticket.kind === "prepare-cleanup") {
            present({
              phase: "prepare-cleanup",
              entry: result.entry,
              message: "清理继续信息已经安全保存。当前健身资料没有改变；现在只需继续收尾临时附件。",
            });
            onNotice("清理继续信息已经安全保存，当前健身资料没有改变。");
          } else {
            setFlow({ phase: "idle" });
            onNotice(result.outcome === "adopted"
              ? "已采用另一页留下的最新继续信息；这里没有调用恢复后端。"
              : "继续信息已经安全保存；需要时再从提醒继续。");
            focusCompletionTarget();
          }
          return;
        }
        if (result.outcome === "conflict") {
          reloadRecoveries();
          setStorageUnavailable(true);
          present({
            phase: "error",
            title: "同一次提醒暂时无法安全读取",
            message: "没有覆盖它，也没有调用恢复后端。待损坏提醒处理后，再只重试浏览器存储。",
          });
          return;
        }
        setStorageUnavailable(true);
        present({
          phase: "error",
          title: "继续信息仍未确认",
          message: "没有调用恢复后端。请保持此页打开，稍后只重试浏览器存储。",
        });
        return;
      }
      reloadRecoveries();
    } finally {
      operationRef.current = false;
    }
  }

  async function exportBackup() {
    if (
      exportBusy || operationBusy || operationRef.current || controlsDisabled
    ) return;
    operationRef.current = true;
    setExportBusy(true);
    onNotice("");
    try {
      onNotice(await onExport());
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "暂时无法导出备份。");
    } finally {
      setExportBusy(false);
      operationRef.current = false;
    }
  }

  const renderSummary = (summary: FitnessRestoreSummary) =>
    <dl className="sl-backup-summary">
      <div><dt>文件</dt><dd>{summary.fileName ?? "名称未提供"}</dd></div>
      <div><dt>类型</dt><dd>{summary.kind === "complete-backup" ? "完整适练备份" : "旧版适练数据库"}</dd></div>
      <div><dt>已核对</dt><dd>{summary.verification === "container-and-payload-verified" ? "数据库与本地附件内容" : "适练数据库结构"}</dd></div>
      <div><dt>大小</dt><dd>{formatBackupBytes(summary.byteSize)}</dd></div>
      {summary.exportedAt && <div><dt>导出时间</dt><dd>{formatBackupDate(summary.exportedAt)}</dd></div>}
      <div><dt>本地附件</dt><dd>{summary.kind === "complete-backup" ? `${summary.fileCount} 个已验证附件` : "不包含附件原件"}</dd></div>
    </dl>;

  const renderFlow = () => {
    if (flow.phase === "idle") return null;
    const alert = flow.phase === "error";
    const receipt = "entry" in flow ? entryReceipt(flow.entry) : null;
    return <section className={`sl-backup-flow ${flow.phase}`} role={alert ? "alert" : "status"} aria-labelledby="sl-backup-flow-title">
      <header><span aria-hidden="true">{operationBusy ? "⋯" : "✓"}</span><div><small>RESTORE</small><h3 id="sl-backup-flow-title" ref={flowHeadingRef} tabIndex={-1}>{
        flow.phase === "preparing" ? "正在核对这个文件" :
        flow.phase === "checking" ? flow.title :
        flow.phase === "review" ? "启用前，再看一眼" :
        flow.phase === "activating" ? "正在启用已核对的备份" :
        flow.phase === "activation-check" ? "先确认当前版本" :
        flow.phase === "discard-only" ? "只收起这份候选" :
        flow.phase === "discarding" ? "正在收起候选" :
        flow.phase === "prepare-cleanup" ? "还有临时附件待收尾" :
        flow.phase === "cleaning" ? "正在收尾临时附件" :
        flow.phase === "refreshing" ? "正在重新读取页面资料" :
        flow.phase === "refresh-only" ? "备份已经启用" : flow.title
      }</h3></div></header>
      {flow.phase === "preparing" && <><p>{prepareStopping ? "正在安全停止。如果候选已经开始建立，会保留同一次继续信息。" : <>正在判断“<b className="sl-backup-file-name">{flow.fileName}</b>”是什么，并建立独立候选。核对完成前，当前健身资料不会切换。</>}</p><footer><button className="secondary" disabled={prepareStopping} onClick={stopPreparation}>{prepareStopping ? "正在停止…" : "停止核对"}</button></footer></>}
      {flow.phase === "checking" && <p>{flow.message}</p>}
      {flow.phase === "review" && <>{flow.message && <p>{flow.message}</p>}{receipt && renderSummary(receipt.summary)}{receipt?.summary.kind === "legacy-fitness-sqlite" && <p className="sl-backup-calm-note">旧版数据库不含器材照片原件；启用后会清空失效的附件引用，避免显示并不存在的照片。</p>}<p className="sl-backup-calm-note">当前健身资料此刻还没有改变。只有选择“启用这份备份”后才会切换。</p><p className="sl-backup-calm-note">启用后会保留上一代数据库恢复快照；它不是可下载备份，也不代表这里提供一键回退，请仍保留原备份文件。</p><footer><button className="secondary" disabled={controlsDisabled || recoveryActionsLocked} onClick={() => void discardCandidate(flow.entry)}>暂不使用</button><button className="primary" data-backup-initial disabled={controlsDisabled || recoveryActionsLocked} onClick={() => void activateCandidate(flow.entry)}>启用这份备份</button></footer></>}
      {flow.phase === "activating" && <p>候选已经通过核对。这里只执行一次版本切换，完成后再单独重新读取页面资料。</p>}
      {flow.phase === "activation-check" && <><p>{flow.message}</p><footer><button className="primary" disabled={controlsDisabled || recoveryActionsLocked} onClick={() => void inspectCandidate(flow.entry)}>只核对当前版本</button></footer></>}
      {flow.phase === "discard-only" && <><p>{flow.message}</p><footer><button className="secondary" disabled={controlsDisabled || recoveryActionsLocked} onClick={() => void discardCandidate(flow.entry)}>继续收尾</button></footer></>}
      {flow.phase === "discarding" && <p>只处理未启用的候选与它的临时附件，不会切换当前健身资料。</p>}
      {flow.phase === "prepare-cleanup" && <><p>{flow.message}</p><footer><button className="secondary" disabled={controlsDisabled || recoveryActionsLocked} onClick={() => void cleanPreparedFile(flow.entry)}>继续收尾临时附件</button></footer></>}
      {flow.phase === "cleaning" && <p>只重试同一次准备留下的临时附件，不会重新导入或启用。</p>}
      {flow.phase === "refreshing" && <p>{flow.message} 这一步不会重新导入或启用。</p>}
      {flow.phase === "refresh-only" && <><p>{flow.message}</p><footer><button className="primary" disabled={controlsDisabled || recoveryActionsLocked} onClick={() => void refreshActivated(flow.entry, flow.message)}>只重新读取</button></footer></>}
      {flow.phase === "error" && <><p>{flow.message}</p>{activeEntry && !recoveryActionsLocked && <footer><button className="secondary" disabled={controlsDisabled || recoveryActionsLocked} onClick={() => void continueEntry(activeEntry)}>{ticketActionLabel(activeEntry)}</button></footer>}</>}
    </section>;
  };

  return <div className="sl-backup-area">
    <div className="sl-backup-actions">
      <button disabled={controlsDisabled || exportBusy || operationBusy} onClick={() => void exportBackup()}><i>{exportBusy ? "…" : "↓"}</i><span><b>{exportBusy ? "正在校验并打包…" : "导出完整备份"}</b><small>偏好、场地、计划、记录与器材照片</small></span></button>
      <button ref={pickerButtonRef} disabled={controlsDisabled || restoreLocked} onClick={() => pickerInputRef.current?.click()}><i>{flow.phase === "preparing" ? "…" : "↑"}</i><span><b>选择备份并核对</b><small>先识别与验证，确认前不会切换</small></span></button>
      <input ref={pickerInputRef} aria-label="选择要核对的适练备份" hidden disabled={controlsDisabled || restoreLocked} type="file" accept=".fitness-backup,.sqlite,.sqlite3,.db,application/x-sqlite3,application/octet-stream" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) void prepareSelectedBackup(file); }}/>
    </div>
    {!loaded && <p className="sl-backup-quiet-status" role="status">正在查看是否有上次未完成的核对</p>}
    {entries.length > 1 && <p className="sl-backup-quiet-status" role="status">还有 {entries.length} 次独立恢复等待处理；每次只处理自己的候选。</p>}
    {flow.phase === "idle" && activeEntry && !recoveryActionsLocked && <div className="sl-backup-warning" role="status"><span aria-hidden="true">◇</span><div><b>有一次恢复等待继续</b><p>它可能来自上次打开或另一个标签页。页面不会自动执行，也不会抢走焦点。</p></div><button ref={recoveryButtonRef} disabled={controlsDisabled || recoveryActionsLocked} onClick={() => void continueEntry(activeEntry)}>{ticketActionLabel(activeEntry)}</button></div>}
    {unreadableEntries.length > 0 && <div className="sl-backup-warning conflict" role="alert"><span aria-hidden="true">◇</span><div><b>有 {unreadableEntries.length} 条继续提醒无法读取</b><p>没有调用恢复或清理。可以保留本机候选，只清除最早这条提醒；清除后无法在这里继续它。</p></div><button disabled={storageUnavailable} onClick={() => void clearUnreadable(unreadableEntries[0])}>我知道了，只清除一条提醒</button></div>}
    {(storageUnavailable || volatileTransition) && <div className="sl-backup-warning conflict" role="status"><span aria-hidden="true">◇</span><div><b>继续信息暂时无法安全保存</b><p>{volatileTransition ? "先不要关闭页面。恢复浏览器存储后，才能安全继续这次操作。" : "现在无法查看是否有未完成恢复，因此不会开始新的核对。"}</p></div><button onClick={() => void retryRecoveryStorage()}>重试浏览器存储</button></div>}
    {renderFlow()}
  </div>;
}
