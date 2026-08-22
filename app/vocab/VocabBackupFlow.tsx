"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  activatePreparedVocabRestore,
  discardPreparedVocabRestore,
  inspectVocabRestoreActivation,
  prepareVocabBackupRestore,
  recoverVocabBackupPrepare,
  retryVocabPrepareCleanup,
  VocabActivationUncertainError,
  VocabCurrentGenerationChangedError,
  VocabDiscardUncertainError,
  VocabPrepareCleanupIncompleteError,
  VocabPrepareUncertainError,
  type VocabPrepareCleanupReceipt,
  type VocabRestoreReceipt,
  type VocabRestoreSummary,
} from "@/lib/vocab/backup";
import {
  VOCAB_BACKUP_RECOVERY_PREFIX,
  checkVocabBackupRecoveryEntry,
  readVocabBackupRecoveryStorage,
  removeVocabBackupRecoveryEntry,
  replaceVocabBackupRecoveryTicket,
  retainVocabBackupVolatileTransition,
  vocabBackupRecoveryStorageKey,
  type VocabBackupRecoveryEntry,
  type VocabBackupRecoveryTicket,
  type VocabBackupUnreadableEntry,
  type VocabBackupVolatileTransition,
} from "./backup-recovery";

type VocabBackupFlowState =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "preparing"; fileName: string }>
  | Readonly<{ phase: "checking"; title: string; message: string }>
  | Readonly<{ phase: "review"; entry: VocabBackupRecoveryEntry; message?: string }>
  | Readonly<{ phase: "activating"; entry: VocabBackupRecoveryEntry }>
  | Readonly<{ phase: "activation-check"; entry: VocabBackupRecoveryEntry; message: string }>
  | Readonly<{ phase: "discard-only"; entry: VocabBackupRecoveryEntry; message: string }>
  | Readonly<{ phase: "discarding"; entry: VocabBackupRecoveryEntry }>
  | Readonly<{ phase: "prepare-cleanup"; entry: VocabBackupRecoveryEntry; message: string }>
  | Readonly<{ phase: "cleaning"; entry: VocabBackupRecoveryEntry }>
  | Readonly<{ phase: "refreshing"; entry: VocabBackupRecoveryEntry; message: string }>
  | Readonly<{ phase: "refresh-only"; entry: VocabBackupRecoveryEntry; message: string }>
  | Readonly<{ phase: "error"; title: string; message: string }>;

type VocabBackupFlowProps = Readonly<{
  controlsDisabled?: boolean;
  externalWriteInProgress(): boolean;
  onDatabaseOperationChange?(inProgress: boolean): void;
  onExport(): Promise<string>;
  onRefreshActivated(): Promise<void>;
  onNotice(message: string): void;
}>;

function recordedAt(): string {
  return new Date().toISOString();
}

function prepareTicket(
  receipt: Parameters<typeof recoverVocabBackupPrepare>[0],
): VocabBackupRecoveryTicket {
  return { version: 1, kind: "prepare", receipt, recordedAt: recordedAt() };
}

function candidateTicket(
  receipt: VocabRestoreReceipt,
  mode: "review" | "activation-check" | "discard-only",
): VocabBackupRecoveryTicket {
  return { version: 1, kind: "candidate", mode, receipt, recordedAt: recordedAt() };
}

function cleanupTicket(
  receipt: VocabPrepareCleanupReceipt,
): VocabBackupRecoveryTicket {
  return { version: 1, kind: "prepare-cleanup", receipt, recordedAt: recordedAt() };
}

function refreshTicket(receipt: VocabRestoreReceipt): VocabBackupRecoveryTicket {
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

function ticketActionLabel(entry: VocabBackupRecoveryEntry): string {
  if (entry.ticket.kind === "refresh-only") return "只重新读取";
  if (entry.ticket.kind === "prepare-cleanup") return "继续收尾";
  if (entry.ticket.kind === "prepare") return "继续核对";
  if (entry.ticket.mode === "activation-check") return "只核对当前版本";
  if (entry.ticket.mode === "discard-only") return "继续收尾";
  return "继续核对";
}

function entryReceipt(entry: VocabBackupRecoveryEntry): VocabRestoreReceipt | null {
  return entry.ticket.kind === "candidate" || entry.ticket.kind === "refresh-only"
    ? entry.ticket.receipt
    : null;
}

export function VocabBackupFlow({
  controlsDisabled = false,
  externalWriteInProgress,
  onDatabaseOperationChange,
  onExport,
  onRefreshActivated,
  onNotice,
}: VocabBackupFlowProps) {
  const [flow, setFlow] = useState<VocabBackupFlowState>({ phase: "idle" });
  const [entries, setEntries] = useState<readonly VocabBackupRecoveryEntry[]>([]);
  const [unreadableEntries, setUnreadableEntries] = useState<readonly VocabBackupUnreadableEntry[]>([]);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [volatileTransition, setVolatileTransition] = useState<VocabBackupVolatileTransition | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [prepareStopping, setPrepareStopping] = useState(false);
  const operationRef = useRef(false);
  const prepareControllerRef = useRef<AbortController | null>(null);
  const pickerInputRef = useRef<HTMLInputElement>(null);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const flowHeadingRef = useRef<HTMLHeadingElement>(null);
  const shouldFocusFlowRef = useRef(false);
  const backendRejectedRef = useRef(new Set<string>());

  const externalDatabaseWriteBlocked = useCallback(() => {
    try {
      return externalWriteInProgress();
    } catch {
      return true;
    }
  }, [externalWriteInProgress]);

  const reloadRecoveries = useCallback(() => {
    const result = readVocabBackupRecoveryStorage();
    if (result.storageUnavailable) {
      setStorageUnavailable(true);
      setLoaded(true);
      return result;
    }
    const rejected: VocabBackupUnreadableEntry[] = [];
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

  const present = useCallback((next: VocabBackupFlowState) => {
    shouldFocusFlowRef.current = true;
    setFlow(next);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(reloadRecoveries);
    function onStorage(event: StorageEvent) {
      if (!event.key || event.key.startsWith(VOCAB_BACKUP_RECOVERY_PREFIX)) {
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
  const restoreLocked = !loaded || operationBusy || Boolean(activeEntry) ||
    unreadableEntries.length > 0 || storageUnavailable ||
    Boolean(volatileTransition);

  async function writeTicket(
    ticket: VocabBackupRecoveryTicket,
    expected: VocabBackupRecoveryEntry | null,
  ) {
    const result = await replaceVocabBackupRecoveryTicket(ticket, expected);
    if (result.outcome === "written") {
      setVolatileTransition(null);
      reloadRecoveries();
      return result;
    }
    if (result.outcome === "unavailable") {
      setVolatileTransition({ ticket, expected });
      setStorageUnavailable(true);
    } else {
      reloadRecoveries();
    }
    return result;
  }

  async function ensureCurrent(entry: VocabBackupRecoveryEntry): Promise<boolean> {
    const result = await checkVocabBackupRecoveryEntry(entry);
    if (result.outcome === "current") return true;
    if (result.outcome === "unavailable") {
      setStorageUnavailable(true);
      present({
        phase: "error",
        title: "暂时无法查看继续信息",
        message: "没有开始新的恢复、启用或清理。恢复浏览器存储后再继续。",
      });
    } else {
      reloadRecoveries();
      present({
        phase: "error",
        title: "另一个页面更新了这次核对",
        message: "这里没有沿用旧步骤。已重新读取继续信息，请从最新提醒继续。",
      });
    }
    return false;
  }

  function markBackendRejected(entry: VocabBackupRecoveryEntry) {
    backendRejectedRef.current.add(`${entry.storageKey}\u001f${entry.raw}`);
    reloadRecoveries();
    present({
      phase: "error",
      title: "这条继续信息无法核对",
      message: "没有启用或删除任何内容。可以保留本机候选，只清除这条提醒；清除后无法在这里继续它。",
    });
  }

  async function removeEntry(entry: VocabBackupRecoveryEntry): Promise<boolean> {
    const result = await removeVocabBackupRecoveryEntry(entry);
    if (result.outcome === "removed") {
      backendRejectedRef.current.delete(`${entry.storageKey}\u001f${entry.raw}`);
      reloadRecoveries();
      return true;
    }
    if (result.outcome === "unavailable") setStorageUnavailable(true);
    else reloadRecoveries();
    return false;
  }

  async function transitionOrExplain(
    ticket: VocabBackupRecoveryTicket,
    expected: VocabBackupRecoveryEntry,
    unavailableMessage: string,
  ): Promise<VocabBackupRecoveryEntry | null> {
    const result = await writeTicket(ticket, expected);
    if (result.outcome === "written") return result.entry;
    present({
      phase: "error",
      title: result.outcome === "stale"
        ? "另一个页面更新了这次核对"
        : "继续信息还没有安全保存",
      message: result.outcome === "stale"
        ? "这里没有执行旧步骤。请从最新提醒继续。"
        : unavailableMessage,
    });
    return null;
  }

  async function persistRefreshThenRead(
    receipt: VocabRestoreReceipt,
    expected: VocabBackupRecoveryEntry,
    message: string,
  ) {
    const next = await transitionOrExplain(
      refreshTicket(receipt),
      expected,
      "备份的启用结果会由原提醒继续保护。恢复浏览器存储后，只会先确认当前版本，不会重复启用。",
    );
    if (!next) return;
    await refreshActivated(next, message, true);
  }

  async function refreshActivated(
    entry: VocabBackupRecoveryEntry,
    message: string,
    continueCurrentOperation = false,
  ) {
    if (
      entry.ticket.kind !== "refresh-only" ||
      (operationRef.current && !continueCurrentOperation)
    ) return;
    const ownsOperation = !operationRef.current;
    if (ownsOperation) operationRef.current = true;
    try {
      if (!await ensureCurrent(entry)) return;
      present({ phase: "refreshing", entry, message });
      await onRefreshActivated();
      if (await removeEntry(entry)) {
        setFlow({ phase: "idle" });
        onNotice("备份已经启用，页面资料也已重新读取。");
        window.requestAnimationFrame(() =>
          pickerButtonRef.current?.focus({ preventScroll: true }));
      } else {
        present({
          phase: "refresh-only",
          entry,
          message: "备份已经启用，页面资料也已更新；本页暂时没能清除继续提醒。再次操作仍只会重新读取。",
        });
      }
    } catch {
      present({
        phase: "refresh-only",
        entry,
        message: "备份已经启用。页面暂时没有重新读到它，只需重新读取，不会重复启用。",
      });
    } finally {
      if (ownsOperation) operationRef.current = false;
    }
  }

  async function inspectCandidate(
    entry: VocabBackupRecoveryEntry,
    continueCurrentOperation = false,
  ) {
    if (
      entry.ticket.kind !== "candidate" ||
      (operationRef.current && !continueCurrentOperation)
    ) return;
    const ownsOperation = !operationRef.current;
    if (ownsOperation) operationRef.current = true;
    try {
      if (!await ensureCurrent(entry)) return;
      present({
        phase: "checking",
        title: "正在核对当前版本",
        message: "只读取版本状态，不会再次启用，也不会清理候选。",
      });
      const { receipt, mode } = entry.ticket;
      const inspection = await inspectVocabRestoreActivation(receipt);
      if (inspection.status === "current") {
        await persistRefreshThenRead(
          receipt,
          entry,
          "这份备份已经启用，只需让页面重新读取资料。",
        );
        return;
      }
      const baselineUnchanged =
        inspection.currentGenerationId === receipt.expectedCurrentGenerationId &&
        inspection.currentSequence === receipt.expectedCurrentSequence;
      if (mode === "review" && baselineUnchanged) {
        if (!await ensureCurrent(entry)) return;
        present({
          phase: "review",
          entry,
          message: "候选与当前词库仍然匹配，请核对后再决定。",
        });
        return;
      }
      const next = await transitionOrExplain(
        candidateTicket(receipt, "discard-only"),
        entry,
        "没有开始收尾。恢复浏览器存储后，只会继续处理未启用的候选。",
      );
      if (!next) return;
      present({
        phase: "discard-only",
        entry: next,
        message: mode === "activation-check" && baselineUnchanged
          ? "已经确认这次没有切换。为避免重复启用，现在只收起这份候选。"
          : "当前词库在候选建立后有过切换。这份候选不会覆盖它，现在只收起候选。",
      });
    } catch (error) {
      if (errorCode(error) === "INVALID_RECEIPT") {
        markBackendRejected(entry);
      } else if (entry.ticket.mode === "activation-check") {
        present({
          phase: "activation-check",
          entry,
          message: "当前版本暂时没有读到。继续时仍只会重新核对，不会重复启用。",
        });
      } else {
        present({
          phase: "error",
          title: "当前版本暂时没有读到",
          message: "候选与继续信息仍保留着。稍后再点继续即可，不需要重新选择备份。",
        });
      }
    } finally {
      if (ownsOperation) operationRef.current = false;
    }
  }

  async function recoverPreparation(entry: VocabBackupRecoveryEntry) {
    if (entry.ticket.kind !== "prepare" || operationRef.current) return;
    operationRef.current = true;
    try {
      if (!await ensureCurrent(entry)) return;
      present({
        phase: "checking",
        title: "正在继续同一次准备",
        message: "沿用上次留下的凭据，不会重新读取备份文件，也不会切换当前词库。",
      });
      const recovered = await recoverVocabBackupPrepare(entry.ticket.receipt);
      if (recovered.status === "ready") {
        const next = await transitionOrExplain(
          candidateTicket(recovered.receipt, "review"),
          entry,
          "候选已经建立，但新继续信息还没有安全保存。恢复浏览器存储后再继续。",
        );
        if (next) await inspectCandidate(next, true);
        return;
      }
      if (recovered.status === "cleanup-pending") {
        const next = await transitionOrExplain(
          cleanupTicket(recovered.cleanupReceipt),
          entry,
          "没有开始清理。恢复浏览器存储后，只会继续临时音频收尾。",
        );
        if (next) {
          present({
            phase: "prepare-cleanup",
            entry: next,
            message: "当前词库没有改变。只需收起这次没有启用的临时音频。",
          });
        }
        return;
      }
      if (await removeEntry(entry)) {
        setFlow({ phase: "idle" });
        onNotice(recovered.status === "discarded"
          ? "上次未完成的候选已经收起，当前词库没有改变。"
          : "上次的临时音频已经收尾，当前词库没有改变。");
      } else if (recovered.status === "cleanup-complete") {
        present({
          phase: "error",
          title: "临时音频已经收尾",
          message: "当前词库没有改变；本页暂时没能清除继续提醒。",
        });
      }
    } catch (error) {
      if (errorCode(error) === "INVALID_RECEIPT") {
        markBackendRejected(entry);
      } else {
        present({
          phase: "error",
          title: "这次核对还没完成",
          message: "继续信息仍保留着。稍后再试即可，不需要重新选择备份。",
        });
      }
    } finally {
      operationRef.current = false;
    }
  }

  async function activateCandidate(entry: VocabBackupRecoveryEntry) {
    if (
      entry.ticket.kind !== "candidate" ||
      entry.ticket.mode !== "review" ||
      operationRef.current || externalDatabaseWriteBlocked()
    ) return;
    operationRef.current = true;
    try {
      onDatabaseOperationChange?.(true);
      const checkingEntry = await transitionOrExplain(
        candidateTicket(entry.ticket.receipt, "activation-check"),
        entry,
        "当前网址的浏览器存储暂时不能保存启用后的继续信息，因此没有启用。恢复存储后再试。",
      );
      if (!checkingEntry) return;
      if (externalDatabaseWriteBlocked()) {
        const restoredEntry = await transitionOrExplain(
          candidateTicket(entry.ticket.receipt, "review"),
          checkingEntry,
          "另一笔数据库安全操作已经开始，因此没有启用这份备份。候选与原继续信息仍保留。",
        );
        if (restoredEntry) {
          present({
            phase: "review",
            entry: restoredEntry,
            message: "另一笔数据库安全操作正在进行；这次没有启用备份，稍后仍可重新确认。",
          });
        }
        return;
      }
      present({ phase: "activating", entry: checkingEntry });
      try {
        await activatePreparedVocabRestore(entry.ticket.receipt);
        await persistRefreshThenRead(
          entry.ticket.receipt,
          checkingEntry,
          "备份已经启用，正在重新读取页面资料。",
        );
      } catch (error) {
        if (error instanceof VocabCurrentGenerationChangedError) {
          const next = await transitionOrExplain(
            candidateTicket(entry.ticket.receipt, "discard-only"),
            checkingEntry,
            "没有开始收尾。恢复浏览器存储后，只会处理未启用的候选。",
          );
          if (next) {
            present({
              phase: "discard-only",
              entry: next,
              message: "当前词库刚刚有过切换，这次没有覆盖它。现在只收起候选。",
            });
          }
        } else if (errorCode(error) === "INVALID_RECEIPT") {
          markBackendRejected(checkingEntry);
        } else {
          const receipt = error instanceof VocabActivationUncertainError
            ? error.receipt
            : entry.ticket.receipt;
          let uncertainEntry = checkingEntry;
          if (receipt !== entry.ticket.receipt) {
            const next = await transitionOrExplain(
              candidateTicket(receipt, "activation-check"),
              checkingEntry,
              "切换结果尚未确认。原提醒仍会保护这次操作；恢复浏览器存储后只核对当前版本。",
            );
            if (!next) return;
            uncertainEntry = next;
          }
          present({
            phase: "activation-check",
            entry: uncertainEntry,
            message: "切换结果暂时没有确认。下一步只会读取当前版本，不会重复启用。",
          });
        }
      }
    } finally {
      operationRef.current = false;
      try {
        onDatabaseOperationChange?.(false);
      } catch {
        // Reporting must not strand this component's own operation claim.
      }
    }
  }

  async function discardCandidate(entry: VocabBackupRecoveryEntry) {
    if (entry.ticket.kind !== "candidate" || operationRef.current) return;
    operationRef.current = true;
    try {
      let cleanupEntry = entry;
      if (entry.ticket.mode !== "discard-only") {
        const next = await transitionOrExplain(
          candidateTicket(entry.ticket.receipt, "discard-only"),
          entry,
          "当前网址的浏览器存储暂时不能保存收尾信息，因此没有开始收尾。",
        );
        if (!next) return;
        cleanupEntry = next;
      } else if (!await ensureCurrent(entry)) return;
      if (cleanupEntry.ticket.kind !== "candidate") return;
      const cleanupReceipt = cleanupEntry.ticket.receipt;
      present({ phase: "discarding", entry: cleanupEntry });
      try {
        const discarded = await discardPreparedVocabRestore(
          cleanupReceipt,
        );
        if (discarded.audioCleanup === "incomplete") {
          present({
            phase: "discard-only",
            entry: cleanupEntry,
            message: `候选已经收起，还有 ${discarded.failedAudioKeys.length} 个临时音频等待收尾。继续时不会启用候选。`,
          });
          return;
        }
        if (await removeEntry(cleanupEntry)) {
          setFlow({ phase: "idle" });
          onNotice("候选已经收起，当前词库没有改变。");
          window.requestAnimationFrame(() =>
            pickerButtonRef.current?.focus({ preventScroll: true }));
        } else {
          present({
            phase: "discard-only",
            entry: cleanupEntry,
            message: "候选已经收起，本页暂时没能清除继续提醒。再次操作仍只会收尾。",
          });
        }
      } catch (error) {
        if (errorCode(error) === "INVALID_RECEIPT") {
          markBackendRejected(cleanupEntry);
          return;
        }
        const receipt = error instanceof VocabDiscardUncertainError
          ? error.receipt
          : cleanupReceipt;
        let uncertainEntry = cleanupEntry;
        if (receipt !== cleanupReceipt) {
          const next = await transitionOrExplain(
            candidateTicket(receipt, "discard-only"),
            cleanupEntry,
            "收尾结果尚未确认。原提醒仍保留；恢复浏览器存储后只会继续收尾。",
          );
          if (!next) return;
          uncertainEntry = next;
        }
        present({
          phase: "discard-only",
          entry: uncertainEntry,
          message: "收尾结果暂时没有确认。继续时只会重试收尾，不会启用候选。",
        });
      }
    } finally {
      operationRef.current = false;
    }
  }

  async function cleanPreparedAudio(entry: VocabBackupRecoveryEntry) {
    if (entry.ticket.kind !== "prepare-cleanup" || operationRef.current) return;
    operationRef.current = true;
    try {
      if (!await ensureCurrent(entry)) return;
      present({ phase: "cleaning", entry });
      await retryVocabPrepareCleanup(entry.ticket.receipt);
      if (await removeEntry(entry)) {
        setFlow({ phase: "idle" });
        onNotice("未启用的临时音频已经收尾，当前词库没有改变。");
        window.requestAnimationFrame(() =>
          pickerButtonRef.current?.focus({ preventScroll: true }));
      } else {
        present({
          phase: "prepare-cleanup",
          entry,
          message: "临时音频已经收尾，本页暂时没能清除继续提醒。",
        });
      }
    } catch (error) {
      if (errorCode(error) === "INVALID_RECEIPT") {
        markBackendRejected(entry);
      } else {
        present({
          phase: "prepare-cleanup",
          entry,
          message: "临时音频暂时没有全部收尾。当前词库没有改变，稍后继续即可。",
        });
      }
    } finally {
      operationRef.current = false;
    }
  }

  async function continueEntry(entry: VocabBackupRecoveryEntry) {
    if (entry.ticket.kind === "refresh-only") {
      await refreshActivated(
        entry,
        "这份备份已经启用，只需让页面重新读取资料。",
      );
      return;
    }
    if (entry.ticket.kind === "prepare-cleanup") {
      await cleanPreparedAudio(entry);
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
    let checkpointEntry: VocabBackupRecoveryEntry | null = null;
    let checkpointGenerationId: string | null = null;
    try {
      const receipt = await prepareVocabBackupRestore(file, {
        signal: controller.signal,
        onRecoveryPrepared: async (recoveryReceipt) => {
          checkpointGenerationId = recoveryReceipt.generationId;
          const result = await writeTicket(prepareTicket(recoveryReceipt), null);
          if (result.outcome !== "written") {
            throw new Error("The prepare recovery ticket could not be saved.");
          }
          checkpointEntry = result.entry;
        },
      });
      if (!checkpointEntry) {
        throw new Error("恢复候选没有留下可核对的继续信息。");
      }
      const next = await transitionOrExplain(
        candidateTicket(receipt, "review"),
        checkpointEntry,
        "候选已经建立，但新继续信息还没有安全保存。恢复浏览器存储后再继续。",
      );
      if (next) present({ phase: "review", entry: next });
    } catch (error) {
      if (error instanceof VocabPrepareUncertainError) {
        present({
          phase: "error",
          title: "候选还在核对中",
          message: "继续信息已经保留。下一步只会核对同一次准备，不会重新导入。",
        });
      } else if (error instanceof VocabPrepareCleanupIncompleteError) {
        const ticket = cleanupTicket(error.receipt);
        if (checkpointEntry) {
          const next = await transitionOrExplain(
            ticket,
            checkpointEntry,
            "当前词库没有改变。恢复浏览器存储后，只会继续临时音频收尾。",
          );
          if (!next) return;
          present({
            phase: "prepare-cleanup",
            entry: next,
            message: "当前词库没有改变。还有临时音频等待收尾。",
          });
        } else {
          setVolatileTransition((current) =>
            retainVocabBackupVolatileTransition(ticket, current));
          setStorageUnavailable(true);
          present({
            phase: "error",
            title: "需要先保存收尾信息",
            message: "当前词库没有改变。临时音频还没全部收尾；这页会保留清理凭据，浏览器存储恢复前不会开始新的恢复。",
          });
        }
      } else if (error instanceof VocabDiscardUncertainError && checkpointEntry) {
        const next = await transitionOrExplain(
          candidateTicket(error.receipt, "discard-only"),
          checkpointEntry,
          "当前词库没有改变。恢复浏览器存储后，只会继续候选收尾。",
        );
        if (next) {
          present({
            phase: "discard-only",
            entry: next,
            message: "当前词库没有改变。候选的收尾结果还没确认，只需继续收尾。",
          });
        }
      } else {
        if (checkpointEntry) await removeEntry(checkpointEntry);
        if (checkpointGenerationId) {
          setVolatileTransition((current) =>
            current?.ticket.receipt.generationId === checkpointGenerationId
              ? null
              : current);
        }
        if (errorCode(error) === "PREPARE_ABORTED") {
          setFlow({ phase: "idle" });
          onNotice("已停止核对，当前词库没有改变。");
          window.requestAnimationFrame(() =>
            pickerButtonRef.current?.focus({ preventScroll: true }));
        } else {
          present({
            phase: "error",
            title: "没有使用这个文件",
            message: error instanceof Error
              ? error.message
              : "这个文件暂时无法核对，当前词库没有改变。",
          });
        }
      }
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

  async function clearUnreadable(entry: VocabBackupUnreadableEntry) {
    if (operationRef.current || storageUnavailable) return;
    operationRef.current = true;
    try {
      const result = await removeVocabBackupRecoveryEntry({
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
        onNotice("只清除了这条提醒；本机候选与当前词库都没有被改动。");
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
        const result = await replaceVocabBackupRecoveryTicket(
          pending.ticket,
          pending.expected,
        );
        if (result.outcome === "written") {
          setVolatileTransition(null);
          setStorageUnavailable(false);
          reloadRecoveries();
          if (pending.ticket.kind === "prepare-cleanup") {
            present({
              phase: "prepare-cleanup",
              entry: result.entry,
              message: "清理继续信息已经安全保存。当前词库没有改变；现在只需继续收尾临时音频。",
            });
            onNotice("清理继续信息已经安全保存，当前词库没有改变。");
          } else {
            setFlow({ phase: "idle" });
            onNotice("继续信息已经安全保存；需要时再从提醒继续。");
          }
          return;
        }
        if (result.outcome === "stale") {
          const latest = reloadRecoveries();
          const storageKey = vocabBackupRecoveryStorageKey(pending.ticket);
          const hasReadablePeer = latest.entries.some(
            (entry) => entry.storageKey === storageKey,
          );
          const hasUnreadablePeer = latest.unreadableEntries.some(
            (entry) => entry.storageKey === storageKey,
          );
          if (hasReadablePeer) {
            present({
              phase: "error",
              title: "另一个页面更新了同一次收尾",
              message: "这里没有覆盖它，可信的清理凭据也仍留在这页。请先从最新提醒继续，再重试浏览器存储。",
            });
          } else {
            present({
              phase: "error",
              title: "没有覆盖变化后的继续信息",
              message: hasUnreadablePeer
                ? "同一次提醒已经变化，但暂时无法安全读取。清理凭据仍留在这页；先处理损坏提醒，再重试浏览器存储。"
                : "存储状态又发生变化，清理凭据仍留在这页。确认继续信息前不会开始新的恢复。",
            });
          }
          return;
        }
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

  const renderSummary = (summary: VocabRestoreSummary) =>
    <dl className="sc-backup-summary">
      <div><dt>文件</dt><dd>{summary.fileName ?? "名称未提供"}</dd></div>
      <div><dt>类型</dt><dd>{summary.kind === "complete-backup" ? "完整拾词备份" : "旧版拾词数据库"}</dd></div>
      <div><dt>已核对</dt><dd>{summary.verification === "container-and-payload-verified" ? "数据库与本地音频内容" : "拾词数据库结构"}</dd></div>
      <div><dt>大小</dt><dd>{formatBackupBytes(summary.byteSize)}</dd></div>
      {summary.exportedAt && <div><dt>导出时间</dt><dd>{formatBackupDate(summary.exportedAt)}</dd></div>}
      <div><dt>本地音频</dt><dd>{summary.kind === "complete-backup" ? `${summary.audioCount} 个已验证音频` : "不包含音频原件"}</dd></div>
    </dl>;

  const renderFlow = () => {
    if (flow.phase === "idle") return null;
    const alert = flow.phase === "error";
    const receipt = "entry" in flow ? entryReceipt(flow.entry) : null;
    return <section className={`sc-backup-flow ${flow.phase}`} role={alert ? "alert" : "status"} aria-labelledby="sc-backup-flow-title">
      <header><span aria-hidden="true">{operationBusy ? "⋯" : "✓"}</span><div><small>RESTORE</small><h3 id="sc-backup-flow-title" ref={flowHeadingRef} tabIndex={-1}>{
        flow.phase === "preparing" ? "正在核对这个文件" :
        flow.phase === "checking" ? flow.title :
        flow.phase === "review" ? "启用前，再看一眼" :
        flow.phase === "activating" ? "正在启用已核对的备份" :
        flow.phase === "activation-check" ? "先确认当前版本" :
        flow.phase === "discard-only" ? "只收起这份候选" :
        flow.phase === "discarding" ? "正在收起候选" :
        flow.phase === "prepare-cleanup" ? "还有临时音频待收尾" :
        flow.phase === "cleaning" ? "正在收尾临时音频" :
        flow.phase === "refreshing" ? "正在重新读取页面资料" :
        flow.phase === "refresh-only" ? "备份已经启用" : flow.title
      }</h3></div></header>
      {flow.phase === "preparing" && <><p>{prepareStopping ? "正在安全停止。如果候选已经开始建立，会保留同一次继续信息。" : <>正在判断“<b className="sc-backup-file-name">{flow.fileName}</b>”是什么，并建立独立候选。核对完成前，当前词库不会切换。</>}</p><footer><button className="secondary" disabled={prepareStopping} onClick={stopPreparation}>{prepareStopping ? "正在停止…" : "停止核对"}</button></footer></>}
      {flow.phase === "checking" && <p>{flow.message}</p>}
      {flow.phase === "review" && <>{flow.message && <p>{flow.message}</p>}{receipt && renderSummary(receipt.summary)}{receipt?.summary.kind === "legacy-vocab-sqlite" && <p className="sc-backup-calm-note">旧版数据库不带本地音频；启用后会清空其中的本地音频引用，避免显示并不存在的音频。</p>}<p className="sc-backup-calm-note">当前词库此刻还没有改变。只有选择“启用这份备份”后才会切换。</p><p className="sc-backup-calm-note">启用后会保留上一代数据库恢复快照；它不是可下载备份，也不代表这里提供一键回退，请仍保留原备份文件。</p><footer><button className="secondary" onClick={() => void discardCandidate(flow.entry)}>暂不使用</button><button className="primary" data-backup-initial disabled={controlsDisabled || externalDatabaseWriteBlocked()} onClick={() => void activateCandidate(flow.entry)}>启用这份备份</button></footer></>}
      {flow.phase === "activating" && <p>候选已经通过核对。这里只执行一次版本切换，完成后再单独重新读取页面资料。</p>}
      {flow.phase === "activation-check" && <><p>{flow.message}</p><footer><button className="primary" onClick={() => void inspectCandidate(flow.entry)}>只核对当前版本</button></footer></>}
      {flow.phase === "discard-only" && <><p>{flow.message}</p><footer><button className="secondary" onClick={() => void discardCandidate(flow.entry)}>继续收尾</button></footer></>}
      {flow.phase === "discarding" && <p>只处理未启用的候选与它的临时音频，不会切换当前词库。</p>}
      {flow.phase === "prepare-cleanup" && <><p>{flow.message}</p><footer><button className="secondary" onClick={() => void cleanPreparedAudio(flow.entry)}>继续收尾临时音频</button></footer></>}
      {flow.phase === "cleaning" && <p>只重试同一次准备留下的临时音频，不会重新导入或启用。</p>}
      {flow.phase === "refreshing" && <p>{flow.message} 这一步不会重新导入或启用。</p>}
      {flow.phase === "refresh-only" && <><p>{flow.message}</p><footer><button className="primary" onClick={() => void refreshActivated(flow.entry, flow.message)}>只重新读取</button></footer></>}
      {flow.phase === "error" && <><p>{flow.message}</p>{activeEntry && unreadableEntries.length === 0 && !storageUnavailable && <footer><button className="secondary" onClick={() => void continueEntry(activeEntry)}>{ticketActionLabel(activeEntry)}</button></footer>}</>}
    </section>;
  };

  return <div className="sc-backup-area">
    <div className="sc-data-actions">
      <button disabled={controlsDisabled || exportBusy || operationBusy} onClick={() => void exportBackup()}><i>{exportBusy ? "…" : "↓"}</i><span><b>{exportBusy ? "正在校验并打包…" : "导出完整备份"}</b><small>内容、词语、复习与本地音频</small></span></button>
      <button ref={pickerButtonRef} disabled={controlsDisabled || restoreLocked} onClick={() => pickerInputRef.current?.click()}><i>{flow.phase === "preparing" ? "…" : "↑"}</i><span><b>选择备份并核对</b><small>先识别与验证，确认前不会切换</small></span></button>
      <input ref={pickerInputRef} aria-label="选择要核对的拾词备份" hidden disabled={controlsDisabled || restoreLocked} type="file" accept=".vocab-backup,.sqlite,.sqlite3,.db,application/x-sqlite3,application/octet-stream" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) void prepareSelectedBackup(file); }}/>
    </div>
    {!loaded && <p className="sc-backup-quiet-status" role="status">正在查看是否有上次未完成的核对</p>}
    {entries.length > 1 && <p className="sc-backup-quiet-status" role="status">还有 {entries.length} 次独立恢复等待处理；每次只处理自己的候选。</p>}
    {flow.phase === "idle" && activeEntry && <div className="sc-backup-warning" role="status"><span aria-hidden="true">◇</span><div><b>有一次恢复等待继续</b><p>它可能来自上次打开或另一个标签页。页面不会自动执行，也不会抢走焦点。</p></div><button onClick={() => void continueEntry(activeEntry)}>{ticketActionLabel(activeEntry)}</button></div>}
    {unreadableEntries.length > 0 && <div className="sc-backup-warning conflict" role="alert"><span aria-hidden="true">◇</span><div><b>有 {unreadableEntries.length} 条继续提醒无法读取</b><p>没有调用恢复或清理。可以保留本机候选，只清除最早这条提醒；清除后无法在这里继续它。</p></div><button disabled={storageUnavailable} onClick={() => void clearUnreadable(unreadableEntries[0])}>我知道了，只清除一条提醒</button></div>}
    {(storageUnavailable || volatileTransition) && <div className="sc-backup-warning conflict" role="status"><span aria-hidden="true">◇</span><div><b>继续信息暂时无法安全保存</b><p>{volatileTransition ? "先不要关闭页面。恢复浏览器存储后，才能安全继续这次操作。" : "现在无法查看是否有未完成恢复，因此不会开始新的核对。"}</p></div><button onClick={() => void retryRecoveryStorage()}>重试浏览器存储</button></div>}
    {renderFlow()}
  </div>;
}
