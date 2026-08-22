"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  commitVocabLexemeWrite,
  inspectVocabLexemeWrite,
  VocabLexemeMutationError,
  type VocabLexemeWriteReceipt,
} from "@/lib/vocab/store";
import {
  VOCAB_LEXEME_WRITE_PREFIX,
  claimVocabLexemeWrite,
  createVocabLexemeWriteEntry,
  createVocabLexemeWriteTicket,
  persistVocabLexemeWrite,
  readVocabLexemeWriteJournal,
  releaseVocabLexemeWrite,
  removeUnreadableVocabLexemeWrite,
  runWithCurrentVocabLexemeWrite,
  runWithMissingVocabLexemeWrite,
  selectVocabLexemeWriteRecoveryEntry,
  type VocabLexemeWriteEntry,
  type VocabLexemeWriteJournal,
  type VocabLexemeWriteLease,
  type VocabLexemeWriteToken,
} from "./lexeme-write-journal";
import {
  vocabLexemeBundleShouldDefer,
  vocabLexemeExternalGateOpen,
  vocabLexemeHeldReceiptBarrier,
  vocabLexemeRatingPreflightOpen,
  vocabLexemeWritePreflightOpen,
  type VocabLexemeBindingMap,
  type VocabLexemeNoteEditor,
  type VocabLexemeRefreshProtection,
} from "./lexeme-write-state";

export type VocabLexemeRefreshOutcome = "applied" | "deferred" | "superseded";
type WorkingAction = "prepare" | "commit" | "inspect" | "refresh" | "journal";
type JournalView = VocabLexemeWriteJournal & Readonly<{ loaded: boolean }>;
type Flow =
  | Readonly<{ phase: "idle" }>
  | Readonly<{
      phase: "working";
      action: WorkingAction;
      kind: VocabLexemeWriteReceipt["kind"] | null;
    }>
  | Readonly<{
      phase: "check" | "expected" | "changed" | "refresh-only" | "invalid";
      entry: VocabLexemeWriteEntry;
      message: string;
    }>;

const EMPTY_JOURNAL: JournalView = {
  loaded: false,
  entries: [],
  unreadable: [],
  storageUnavailable: false,
  lockUnavailable: false,
};

const STATUS_LABEL = {
  saved: "已保存",
  learning: "学习中",
  known: "已掌握",
  ignored: "已忽略",
} as const;

function reasonMessage(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : "词条操作没有完成；现有内容没有被静默覆盖。";
}

function actionLabel(receipt: VocabLexemeWriteReceipt): string {
  if (receipt.kind === "note-save") return "保存笔记";
  if (receipt.kind === "star-set") {
    return receipt.after.lexeme.starred ? "收藏单词" : "取消收藏";
  }
  return `状态改为“${STATUS_LABEL[receipt.after.lexeme.status]}”`;
}

function savedCopy(receipt: VocabLexemeWriteReceipt): string {
  if (receipt.kind === "note-save") return "词条笔记已确认保存。";
  if (receipt.kind === "star-set") {
    return receipt.after.lexeme.starred
      ? "这个词已确认收藏。"
      : "已确认取消这个词的收藏。";
  }
  return `词条状态已确认改为“${STATUS_LABEL[receipt.after.lexeme.status]}”。`;
}

function phaseForEntry(entry: VocabLexemeWriteEntry): Flow {
  if (entry.ticket.kind === "committed") {
    return {
      phase: "refresh-only",
      entry,
      message: `${savedCopy(entry.ticket.receipt)} 下一步只会核对并重新读取，不会再次写入。`,
    };
  }
  if (entry.ticket.kind === "changed") {
    return {
      phase: "changed",
      entry,
      message: "这个词条已经变化；旧内容不会覆盖当前内容，也不会再次提交。",
    };
  }
  return {
    phase: "check",
    entry,
    message: "这次词条写入结果还没有确认。先只读核对，不会重复写入。",
  };
}

export function useVocabLexemeWriteFlow({
  refresh,
  externalWriteLocked,
  externalWriteInProgress,
  claimStatusMutation,
  releaseStatusMutation,
  onToast,
  onAttention,
  onReceiptPrepared,
  onDurablePrepared,
  onDurableSettled,
  onChangedSettled,
  onReceiptDiscarded,
}: {
  refresh: () => Promise<VocabLexemeRefreshOutcome>;
  externalWriteLocked: boolean;
  externalWriteInProgress: () => boolean;
  claimStatusMutation: () => boolean;
  releaseStatusMutation: () => void;
  onToast: (message: string) => void;
  onAttention: (receipt: VocabLexemeWriteReceipt | null) => boolean | void;
  onReceiptPrepared?: (
    receipt: VocabLexemeWriteReceipt,
    trigger: HTMLElement,
  ) => void;
  onDurablePrepared?: (
    receipt: VocabLexemeWriteReceipt,
    trigger: HTMLElement,
  ) => void;
  onDurableSettled?: (
    receipt: VocabLexemeWriteReceipt,
    trigger: HTMLElement | null,
  ) => void;
  onChangedSettled?: (
    receipt: VocabLexemeWriteReceipt,
    trigger: HTMLElement | null,
  ) => void;
  onReceiptDiscarded?: (
    receipt: VocabLexemeWriteReceipt,
    trigger: HTMLElement | null,
  ) => void;
}) {
  const [journal, setJournal] = useState<JournalView>(EMPTY_JOURNAL);
  const [flow, setFlow] = useState<Flow>({ phase: "idle" });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);
  const [heldEntries, setHeldEntries] = useState<readonly VocabLexemeWriteEntry[]>([]);
  const [activeKind, setActiveKind] = useState<VocabLexemeWriteReceipt["kind"] | null>(null);
  const journalRef = useRef<JournalView>(EMPTY_JOURNAL);
  const heldEntriesRef = useRef(new Map<string, VocabLexemeWriteEntry>());
  const operationRef = useRef<VocabLexemeWriteToken | null>(null);
  const mounted = useRef(false);
  const statusTokenRef = useRef<VocabLexemeWriteToken | null>(null);
  const refreshProtectionRef = useRef<VocabLexemeRefreshProtection | null>(null);
  const triggerRef = useRef(new Map<string, HTMLElement>());

  const busy = flow.phase === "working";
  const durableOperationIds = journal.entries.map((entry) =>
    entry.ticket.receipt.operationId
  );
  const hasHeldReceipt = heldEntries.length > 0;
  const hasVolatileHeldReceipt = heldEntries.some((entry) =>
    vocabLexemeHeldReceiptBarrier(
      entry.ticket.receipt.operationId,
      durableOperationIds,
    ).volatile
  );
  const hasVolatileOperation = busy || hasVolatileHeldReceipt;
  const writeLocked = !vocabLexemeWritePreflightOpen({
    loaded: journal.loaded,
    storageUnavailable: journal.storageUnavailable,
    lockUnavailable: journal.lockUnavailable,
    unreadableCount: journal.unreadable.length,
    entryCount: journal.entries.length,
  }, externalWriteLocked, hasHeldReceipt) || busy;
  const ratingWriteLocked = !vocabLexemeRatingPreflightOpen(
    externalWriteLocked || externalWriteInProgress(),
    {
      loaded: journal.loaded,
      storageUnavailable: journal.storageUnavailable,
      lockUnavailable: journal.lockUnavailable,
      unreadableCount: journal.unreadable.length,
    },
    activeKind === "status-set" || journal.entries.some((entry) =>
      entry.ticket.receipt.kind === "status-set"
    ) || heldEntries.some((entry) =>
      entry.ticket.receipt.kind === "status-set"
    ),
  );

  const externalGateOpen = useCallback(() =>
    vocabLexemeExternalGateOpen(
      externalWriteLocked,
      externalWriteInProgress,
    ), [externalWriteInProgress, externalWriteLocked]);

  const reloadJournal = useCallback(() => {
    let next: VocabLexemeWriteJournal;
    try {
      next = readVocabLexemeWriteJournal();
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
    if (mounted.current) setJournal(loaded);
    return next;
  }, []);

  const holdEntry = useCallback((entry: VocabLexemeWriteEntry) => {
    heldEntriesRef.current.set(entry.ticket.receipt.operationId, entry);
    setHeldEntries([...heldEntriesRef.current.values()]);
  }, []);

  const clearHeldEntry = useCallback((receipt: VocabLexemeWriteReceipt) => {
    heldEntriesRef.current.delete(receipt.operationId);
    setHeldEntries([...heldEntriesRef.current.values()]);
  }, []);

  const showAttention = useCallback((next: Flow) => {
    if ("entry" in next) holdEntry(next.entry);
    setFlow(next);
    const receipt = "entry" in next ? next.entry.ticket.receipt : null;
    if (onAttention(receipt) !== false) {
      setFocusRequest((current) => current + 1);
    }
  }, [holdEntry, onAttention]);

  const claim = useCallback((
    action: WorkingAction,
    kind: VocabLexemeWriteReceipt["kind"] | null,
  ) => {
    if (kind === "status-set" && !claimStatusMutation()) return null;
    const token = claimVocabLexemeWrite(operationRef);
    if (!token) {
      if (kind === "status-set") releaseStatusMutation();
      return null;
    }
    if (kind === "status-set") statusTokenRef.current = token;
    setError("");
    setActiveKind(kind);
    setFlow({ phase: "working", action, kind });
    return token;
  }, [claimStatusMutation, releaseStatusMutation]);

  const release = useCallback((token: VocabLexemeWriteToken) => {
    if (statusTokenRef.current === token) {
      statusTokenRef.current = null;
      releaseStatusMutation();
    }
    if (releaseVocabLexemeWrite(operationRef, token)) {
      setActiveKind(null);
    }
  }, [releaseStatusMutation]);

  useEffect(() => {
    mounted.current = true;
    reloadJournal();
    const onStorage = (event: StorageEvent) => {
      if (
        event.storageArea === window.localStorage &&
        (event.key === null || event.key.startsWith(VOCAB_LEXEME_WRITE_PREFIX))
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
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reloadJournal]);

  useEffect(() => {
    if (!hasVolatileOperation) return;
    const protect = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [hasVolatileOperation]);

  const reopenLatest = useCallback((entry: VocabLexemeWriteEntry) => {
    holdEntry(entry);
    const latest = reloadJournal();
    const next = selectVocabLexemeWriteRecoveryEntry(
      [...heldEntriesRef.current.values()],
      latest.entries,
    );
    const durable = Boolean(next && latest.entries.includes(next));
    if (!next || !durable) {
      showAttention({
        phase: "check",
        entry: next ?? entry,
        message: "另一页移除了这条提醒；当前页仍保留原收据。下一步只读核对，不会重复写入。",
      });
      setError("原收据暂时只保留在本页；核对完成前，词条写入保持暂停。");
      return;
    }
    showAttention(phaseForEntry(next));
  }, [holdEntry, reloadJournal, showAttention]);

  const showNextRecovery = useCallback(() => {
    const latest = reloadJournal();
    const next = selectVocabLexemeWriteRecoveryEntry(
      [...heldEntriesRef.current.values()],
      latest.entries,
    );
    if (!next) return false;
    const durable = latest.entries.some((candidate) =>
      candidate.storageKey === next.storageKey && candidate.raw === next.raw
    );
    showAttention(durable
      ? phaseForEntry(next)
      : {
          phase: "check",
          entry: next,
          message: "原收据暂时只保留在本页；先只读核对，不会重复写入。",
        });
    return true;
  }, [reloadJournal, showAttention]);

  const removeCurrent = useCallback(async (entry: VocabLexemeWriteEntry) => {
    const result = await runWithCurrentVocabLexemeWrite(
      entry,
      (lease) => lease.remove(),
    );
    reloadJournal();
    return result.outcome;
  }, [reloadJournal]);

  const inspectEntryWithLease = useCallback((
    entry: VocabLexemeWriteEntry,
    missing: boolean,
  ) => {
    const operation = async (lease: VocabLexemeWriteLease) => {
      const inspection = await inspectVocabLexemeWrite(entry.ticket.receipt);
      if (inspection === "exact_saved") lease.committed();
      else if (inspection === "changed") lease.changed();
      return inspection;
    };
    return missing
      ? runWithMissingVocabLexemeWrite(entry, operation)
      : runWithCurrentVocabLexemeWrite(entry, operation);
  }, []);

  const shouldDeferBundle = useCallback((
    next: VocabLexemeBindingMap,
    editor: VocabLexemeNoteEditor | null,
  ) => vocabLexemeBundleShouldDefer(
    next,
    editor,
    refreshProtectionRef.current,
  ), []);

  const finishCommitted = useCallback(async (
    entry: VocabLexemeWriteEntry,
    token: VocabLexemeWriteToken,
  ): Promise<void> => {
    const receipt = entry.ticket.receipt;
    holdEntry(entry);
    refreshProtectionRef.current = {
      receipt,
      mode: "after-only",
    };
    setFlow({ phase: "working", action: "refresh", kind: receipt.kind });
    setStatus(savedCopy(receipt));
    setError("");
    try {
      let outcome: VocabLexemeRefreshOutcome;
      try {
        outcome = await refresh();
      } catch {
        showAttention({
          phase: "refresh-only",
          entry,
          message: `${savedCopy(receipt)} 页面暂时没有读到最新词条；只需重新读取，不要重复提交。`,
        });
        return;
      }
      if (outcome !== "applied") {
        showAttention({
          phase: "refresh-only",
          entry,
          message: outcome === "deferred"
            ? `${savedCopy(receipt)} 本页笔记草稿或另一项变化仍需明确处理；收据不会提前清除。`
            : `${savedCopy(receipt)} 这次读取已被更新请求取代；收据仍保留。`,
        });
        return;
      }
      const removal = await removeCurrent(entry);
      if (removal === "blocked") {
        showAttention({
          phase: "refresh-only",
          entry,
          message: `${savedCopy(receipt)} 页面已更新，但核对提醒仍无法完整验证。`,
        });
        return;
      }
      if (removal === "stale") {
        reopenLatest(entry);
        return;
      }
      clearHeldEntry(receipt);
      refreshProtectionRef.current = null;
      setStatus(savedCopy(receipt));
      const trigger = triggerRef.current.get(receipt.operationId) ?? null;
      triggerRef.current.delete(receipt.operationId);
      onDurableSettled?.(receipt, trigger);
      onToast(savedCopy(receipt));
      if (!showNextRecovery()) setFlow({ phase: "idle" });
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({
        phase: "refresh-only",
        entry,
        message: `${savedCopy(receipt)} 页面已经更新；只是提醒暂时没有收起。`,
      });
    } finally {
      if (operationRef.current === token) release(token);
    }
  }, [clearHeldEntry, holdEntry, onDurableSettled, onToast, refresh, release, removeCurrent, reopenLatest, showAttention, showNextRecovery]);

  const settleInspectionResult = useCallback(async (
    result: Awaited<ReturnType<typeof inspectEntryWithLease>>,
    held: VocabLexemeWriteEntry,
    token: VocabLexemeWriteToken,
  ): Promise<void> => {
    reloadJournal();
    if (result.outcome === "blocked") {
      refreshProtectionRef.current = null;
      showAttention({
        phase: "check",
        entry: held,
        message: "当前无法完整验证全部词条提醒；原收据仍保留在本页，没有调用写入。",
      });
      setError("核对存储尚未安全可用；词条写入保持暂停。");
      return;
    }
    if (result.outcome === "stale") {
      refreshProtectionRef.current = null;
      reopenLatest(held);
      return;
    }
    const entry = result.entry ?? held;
    holdEntry(entry);
    if (result.value === "exact_saved" && result.entry) {
      await finishCommitted(result.entry, token);
      return;
    }
    refreshProtectionRef.current = null;
    if (result.value === "expected") {
      showAttention({
        phase: "expected",
        entry,
        message: "这次确定还没有写入。可以清除提醒，或明确继续同一张收据。",
      });
    } else if (result.value === "changed") {
      showAttention({
        phase: "changed",
        entry,
        message: "当前词条已经变化；旧内容没有覆盖现在的内容，也不会再次写入。",
      });
    } else if (result.value === "invalid_receipt") {
      showAttention({
        phase: "invalid",
        entry,
        message: "这份词条收据无法验证；没有据此写入。",
      });
    } else {
      showAttention({
        phase: "check",
        entry,
        message: "结果仍无法确认；收据继续保留，下一步仍只会读取。",
      });
    }
  }, [finishCommitted, holdEntry, reloadJournal, reopenLatest, showAttention]);

  const commitEntry = useCallback(async (
    entry: VocabLexemeWriteEntry,
    token: VocabLexemeWriteToken,
  ): Promise<void> => {
    const receipt = entry.ticket.receipt;
    refreshProtectionRef.current = { receipt, mode: "before-only" };
    setFlow({ phase: "working", action: "commit", kind: receipt.kind });
    try {
      const result = await runWithCurrentVocabLexemeWrite(
        entry,
        async (lease) => {
          if (!externalGateOpen()) return "external-blocked" as const;
          try {
            const committed = await commitVocabLexemeWrite(receipt);
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
              reason instanceof VocabLexemeMutationError &&
              reason.code === "write_failed"
            ) return "expected" as const;
            throw reason;
          }
        },
      );
      reloadJournal();
      if (result.outcome === "blocked") {
        refreshProtectionRef.current = null;
        showAttention({
          phase: "check",
          entry,
          message: "词条核对线索暂时无法完整验证；没有调用词条写入。",
        });
        setError("现有词条没有改变；先处理安全提醒。");
        return;
      }
      if (result.outcome === "stale") {
        holdEntry(entry);
        const inspection = await inspectEntryWithLease(entry, true);
        await settleInspectionResult(inspection, entry, token);
        return;
      }
      if (result.value === "external-blocked") {
        refreshProtectionRef.current = null;
        showAttention({
          phase: "expected",
          entry,
          message: "另一笔数据库安全操作正在进行；这张收据仍保留，没有调用词条写入。",
        });
        return;
      }
      if (result.value === "saved" && result.entry) {
        holdEntry(result.entry);
        await finishCommitted(result.entry, token);
        return;
      }
      refreshProtectionRef.current = null;
      if (result.value === "changed" && result.entry) {
        holdEntry(result.entry);
        showAttention({
          phase: "changed",
          entry: result.entry,
          message: "词条已经在别处变化；旧内容没有覆盖当前内容，也不会再次写入。",
        });
      } else if (result.value === "expected") {
        showAttention({
          phase: "expected",
          entry,
          message: "这次确定还没有写入。可以清除提醒，或明确继续同一张收据。",
        });
      } else {
        showAttention({
          phase: "check",
          entry,
          message: "这次词条结果仍需只读核对；不会凭猜测重复写入。",
        });
      }
    } catch (reason) {
      refreshProtectionRef.current = null;
      reloadJournal();
      showAttention({
        phase: "check",
        entry,
        message: "这次词条结果需要只读核对；原收据仍保留。",
      });
      setError(reasonMessage(reason));
    } finally {
      if (operationRef.current === token) release(token);
    }
  }, [externalGateOpen, finishCommitted, holdEntry, inspectEntryWithLease, reloadJournal, release, settleInspectionResult, showAttention]);

  const start = useCallback(async (
    kind: VocabLexemeWriteReceipt["kind"],
    prepare: () => Promise<VocabLexemeWriteReceipt>,
    trigger: HTMLElement,
  ): Promise<void> => {
    const token = claim("prepare", kind);
    if (!token) {
      setError(kind === "status-set"
        ? "另一笔复习卡操作正在进行；这次状态没有改动。"
        : "另一笔词条操作正在进行；这次没有开始写入。");
      return;
    }
    let held: VocabLexemeWriteEntry | null = null;
    let receipt: VocabLexemeWriteReceipt | null = null;
    try {
      const current = reloadJournal();
      if (current.storageUnavailable) {
        throw new Error("暂时无法读取词条核对存储；没有开始写入。");
      }
      if (current.lockUnavailable) {
        throw new Error("当前浏览器没有安全跨页面写入锁；没有开始写入。");
      }
      if (current.unreadable.length > 0) {
        throw new Error("先处理无法验证的词条提醒；没有开始写入。");
      }
      if (current.entries.length > 0 || heldEntriesRef.current.size > 0) {
        throw new Error("先处理上一条词条核对线索；没有开始新的写入。");
      }
      if (!externalGateOpen()) {
        throw new Error("先完成另一笔数据库安全操作；词条没有改动。");
      }
      receipt = await prepare();
      if (!externalGateOpen()) {
        throw new Error("准备收据期间另一笔数据库操作已开始；没有保留或提交这张词条收据。");
      }
      if (receipt.kind !== kind) {
        throw new Error("词条动作与安全收据不一致；没有调用写入。");
      }
      refreshProtectionRef.current = { receipt, mode: "before-only" };
      held = createVocabLexemeWriteEntry(createVocabLexemeWriteTicket(receipt));
      onReceiptPrepared?.(receipt, trigger);
      holdEntry(held);
      const durable = await persistVocabLexemeWrite(held.ticket);
      held = durable;
      holdEntry(durable);
      triggerRef.current.set(receipt.operationId, trigger);
      onDurablePrepared?.(receipt, trigger);
      reloadJournal();
      await commitEntry(durable, token);
    } catch (reason) {
      refreshProtectionRef.current = null;
      const recovered = reloadJournal();
      const recoveredEntry = receipt
        ? recovered.entries.find((candidate) =>
            candidate.ticket.receipt.operationId === receipt?.operationId
          )
        : null;
      if (recoveredEntry) {
        holdEntry(recoveredEntry);
        triggerRef.current.set(recoveredEntry.ticket.receipt.operationId, trigger);
        onDurablePrepared?.(recoveredEntry.ticket.receipt, trigger);
        showAttention({
          phase: "check",
          entry: recoveredEntry,
          message: "安全收据可能已经保留；先只读核对结果，不会重复写入。",
        });
        setError(`${reasonMessage(reason)} 请先按已保留的线索核对。`);
      } else if (receipt && held) {
        holdEntry(held);
        triggerRef.current.set(receipt.operationId, trigger);
        try {
          const inspection = await inspectEntryWithLease(held, true);
          await settleInspectionResult(inspection, held, token);
        } catch (recoveryReason) {
          showAttention({
            phase: "check",
            entry: held,
            message: "原收据暂时只保留在本页；只读核对尚未完成，词条写入保持暂停。",
          });
          setError(reasonMessage(recoveryReason));
        }
      } else {
        setFlow({ phase: "idle" });
        setError(reasonMessage(reason));
      }
    } finally {
      if (operationRef.current === token) release(token);
    }
  }, [claim, commitEntry, externalGateOpen, holdEntry, inspectEntryWithLease, onDurablePrepared, onReceiptPrepared, release, reloadJournal, settleInspectionResult, showAttention]);

  const open = useCallback((entry?: VocabLexemeWriteEntry) => {
    if (operationRef.current) return;
    const current = reloadJournal();
    const next = entry ?? selectVocabLexemeWriteRecoveryEntry(
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
      : { phase: "idle" });
  }, [reloadJournal, showAttention]);

  const inspect = useCallback(async (entry: VocabLexemeWriteEntry) => {
    const token = claim("inspect", entry.ticket.receipt.kind);
    if (!token) return;
    try {
      let result = await inspectEntryWithLease(entry, false);
      if (result.outcome === "stale") {
        holdEntry(entry);
        result = await inspectEntryWithLease(entry, true);
      }
      await settleInspectionResult(result, entry, token);
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({
        phase: "check",
        entry,
        message: "只读核对没有完成；原收据仍保留。",
      });
    } finally {
      if (operationRef.current === token) release(token);
    }
  }, [claim, holdEntry, inspectEntryWithLease, release, settleInspectionResult, showAttention]);

  const continueExpected = useCallback(async (entry: VocabLexemeWriteEntry) => {
    const current = reloadJournal();
    const selected = selectVocabLexemeWriteRecoveryEntry(
      [...heldEntriesRef.current.values()],
      current.entries,
    );
    const exactDurable = Boolean(
      selected && selected.storageKey === entry.storageKey &&
      selected.raw === entry.raw && current.entries.some((candidate) =>
        candidate.storageKey === entry.storageKey && candidate.raw === entry.raw
      ),
    );
    if (
      !exactDurable || current.storageUnavailable || current.lockUnavailable ||
      current.unreadable.length > 0 || !externalGateOpen()
    ) {
      showAttention({
        phase: "expected",
        entry,
        message: "这张收据仍保留；整包读取与其他安全操作明确结束前不会继续写入。",
      });
      setError("当前安全门尚未开放；没有调用词条写入。请稍后再次明确继续。");
      return;
    }
    const token = claim("commit", entry.ticket.receipt.kind);
    if (!token) return;
    await commitEntry(entry, token);
  }, [claim, commitEntry, externalGateOpen, reloadJournal, showAttention]);

  const discardExpected = useCallback(async (entry: VocabLexemeWriteEntry) => {
    const token = claim("journal", entry.ticket.receipt.kind);
    if (!token) return;
    try {
      const result = await removeCurrent(entry);
      if (result === "blocked") {
        showAttention({
          phase: "expected",
          entry,
          message: "出现了无法验证的跨页面提醒；这张收据仍保留。",
        });
      } else if (result === "stale") {
        reopenLatest(entry);
      } else {
        clearHeldEntry(entry.ticket.receipt);
        const trigger = triggerRef.current.get(
          entry.ticket.receipt.operationId,
        ) ?? null;
        triggerRef.current.delete(entry.ticket.receipt.operationId);
        onReceiptDiscarded?.(entry.ticket.receipt, trigger);
        setStatus("这次确定未写入的词条收据已经清除；词条内容没有改变。");
        if (!showNextRecovery()) setFlow({ phase: "idle" });
      }
    } catch (reason) {
      reloadJournal();
      setError(reasonMessage(reason));
      showAttention({
        phase: "expected",
        entry,
        message: "清除提醒没有完成；原收据仍保留，可以再次尝试。",
      });
    } finally {
      release(token);
    }
  }, [claim, clearHeldEntry, onReceiptDiscarded, release, reloadJournal, removeCurrent, reopenLatest, showAttention, showNextRecovery]);

  const refreshCommitted = useCallback(async (
    entry: VocabLexemeWriteEntry,
  ) => {
    const token = claim("refresh", entry.ticket.receipt.kind);
    if (!token) return;
    try {
      const current = reloadJournal();
      const exact = current.entries.find((candidate) =>
        candidate.storageKey === entry.storageKey && candidate.raw === entry.raw
      ) ?? null;
      if (!exact) {
        holdEntry(entry);
        const inspection = await inspectEntryWithLease(entry, true);
        await settleInspectionResult(inspection, entry, token);
        return;
      }
      const result = await runWithCurrentVocabLexemeWrite(
        exact,
        () => "refresh" as const,
      );
      reloadJournal();
      if (result.outcome === "blocked") {
        showAttention({
          phase: "refresh-only",
          entry,
          message: `${savedCopy(entry.ticket.receipt)} 核对提醒暂时无法完整验证；没有再次提交。`,
        });
        return;
      }
      if (result.outcome === "stale") {
        reopenLatest(entry);
        return;
      }
      await finishCommitted(result.entry ?? exact, token);
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({
        phase: "refresh-only",
        entry,
        message: `${savedCopy(entry.ticket.receipt)} 页面尚未重新读取；没有再次提交。`,
      });
    } finally {
      if (operationRef.current === token) release(token);
    }
  }, [claim, finishCommitted, holdEntry, inspectEntryWithLease, release, reloadJournal, reopenLatest, settleInspectionResult, showAttention]);

  const refreshChanged = useCallback(async (entry: VocabLexemeWriteEntry) => {
    const token = claim("refresh", entry.ticket.receipt.kind);
    if (!token) return;
    refreshProtectionRef.current = {
      receipt: entry.ticket.receipt,
      mode: "any",
    };
    try {
      const outcome = await refresh();
      if (outcome !== "applied") {
        showAttention({
          phase: "changed",
          entry,
          message: "当前词条还没有完整重新读取；旧收据继续保留。",
        });
        return;
      }
      const removal = await removeCurrent(entry);
      if (removal === "blocked") {
        showAttention({
          phase: "changed",
          entry,
          message: "页面已读取，但旧收据暂时不能安全清除。",
        });
      } else if (removal === "stale") {
        reopenLatest(entry);
      } else {
        clearHeldEntry(entry.ticket.receipt);
        const trigger = triggerRef.current.get(
          entry.ticket.receipt.operationId,
        ) ?? null;
        triggerRef.current.delete(entry.ticket.receipt.operationId);
        onChangedSettled?.(entry.ticket.receipt, trigger);
        setStatus("已经读取当前词条；旧内容没有覆盖或改写它。");
        if (!showNextRecovery()) setFlow({ phase: "idle" });
      }
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({
        phase: "changed",
        entry,
        message: "当前词条尚未重新读取；旧收据继续保留。",
      });
    } finally {
      refreshProtectionRef.current = null;
      release(token);
    }
  }, [claim, clearHeldEntry, onChangedSettled, refresh, release, removeCurrent, reopenLatest, showAttention, showNextRecovery]);

  const dismissInvalid = useCallback(async (entry: VocabLexemeWriteEntry) => {
    const token = claim("journal", entry.ticket.receipt.kind);
    if (!token) return;
    try {
      const result = await removeCurrent(entry);
      if (result === "stale") reopenLatest(entry);
      else if (result === "blocked") {
        showAttention({
          phase: "invalid",
          entry,
          message: "出现了无法验证的提醒；这条旧提醒仍保留。",
        });
      } else {
        clearHeldEntry(entry.ticket.receipt);
        const trigger = triggerRef.current.get(
          entry.ticket.receipt.operationId,
        ) ?? null;
        triggerRef.current.delete(entry.ticket.receipt.operationId);
        onReceiptDiscarded?.(entry.ticket.receipt, trigger);
        if (!showNextRecovery()) setFlow({ phase: "idle" });
      }
    } finally {
      release(token);
    }
  }, [claim, clearHeldEntry, onReceiptDiscarded, release, removeCurrent, reopenLatest, showAttention, showNextRecovery]);

  const clearUnreadable = useCallback(async () => {
    const token = claim("journal", null);
    if (!token) return;
    try {
      const current = reloadJournal();
      for (const entry of current.unreadable) {
        if (!await removeUnreadableVocabLexemeWrite(entry)) {
          throw new Error("另一页已经改动了一条无法验证的词条提醒。");
        }
      }
      reloadJournal();
      const held = heldEntriesRef.current.values().next().value ?? null;
      setFlow(held
        ? {
            phase: "check",
            entry: held,
            message: "原收据仍保留在本页；下一步只读核对，不会重复写入。",
          }
        : { phase: "idle" });
      setStatus("无法验证的词条提醒已经清除；词条内容没有改变。");
    } catch (reason) {
      reloadJournal();
      setError(reasonMessage(reason));
    } finally {
      release(token);
    }
  }, [claim, release, reloadJournal]);

  return {
    journal,
    flow,
    busy,
    writeLocked,
    ratingWriteLocked,
    hasHeldReceipt,
    hasVolatileHeldReceipt,
    hasVolatileOperation,
    status,
    error,
    focusRequest,
    start,
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
    operationInProgress: () => Boolean(operationRef.current),
  } as const;
}

type Controller = ReturnType<typeof useVocabLexemeWriteFlow>;

export function VocabLexemeWriteBanner({
  controller,
  onOpen,
}: {
  controller: Controller;
  onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const { journal, busy, hasHeldReceipt } = controller;
  if (
    !journal.loaded ||
    (!journal.storageUnavailable && !journal.lockUnavailable &&
      journal.entries.length === 0 && journal.unreadable.length === 0 &&
      !hasHeldReceipt)
  ) return null;
  const title = journal.storageUnavailable
    ? "词条核对线索暂时无法读取"
    : journal.lockUnavailable
      ? "这个浏览器可以阅读词库，但暂不能安全修改词条"
      : journal.unreadable.length > 0
        ? "有无法验证的词条提醒"
        : hasHeldReceipt && journal.entries.length === 0
          ? "原词条收据仍待只读核对"
          : `有 ${journal.entries.length} 条词条写入待核对`;
  return <section className="sc-lexeme-write-banner" role="status">
    <div><b>{title}</b><p>词库与语境仍可阅读；安全条件明确前不会覆盖词条。</p></div>
    <button type="button" disabled={busy} onClick={(event) => {
      onOpen(event.currentTarget);
      controller.open();
    }}>{journal.entries.length || hasHeldReceipt ? "打开待核对收据" : "查看安全说明"}</button>
  </section>;
}

function receiptText(receipt: VocabLexemeWriteReceipt): string {
  const lines = [
    receipt.after.lexeme.headword,
    `动作：${actionLabel(receipt)}`,
  ];
  if (receipt.kind === "note-save") {
    lines.push(`目标笔记：${receipt.after.lexeme.notes || "（空白）"}`);
  } else if (receipt.kind === "status-set") {
    lines.push(
      `原状态：${STATUS_LABEL[receipt.before.lexeme.status]}`,
      `目标状态：${STATUS_LABEL[receipt.after.lexeme.status]}`,
      "复习卡会与这个状态一起安全核对。",
    );
  }
  return lines.join("\n");
}

export function VocabLexemeWriteRecovery({
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
  const backendBlocked = journal.storageUnavailable || journal.lockUnavailable ||
    journal.unreadable.length > 0;
  const title = journal.storageUnavailable
    ? "暂时无法查看词条核对线索"
    : journal.lockUnavailable
      ? "当前浏览器只读开放"
      : journal.unreadable.length > 0
        ? "有无法验证的词条提醒"
        : flow.phase === "working"
          ? "正在安全处理词条"
          : flow.phase === "expected"
            ? "这次确定还没有写入"
            : flow.phase === "changed"
              ? "当前词条已经变化"
              : flow.phase === "refresh-only"
                ? "保存事实已确认，页面待刷新"
                : flow.phase === "invalid"
                  ? "词条收据无法验证"
                  : entry ? "有一条词条写入待核对" : "词条写入安全说明";
  return <section className="sc-lexeme-write-recovery" aria-live="polite">
    <header><h2 ref={heading} tabIndex={-1}>{title}</h2><p>{
      flow.phase === "working"
        ? flow.action === "inspect" ? "正在只读核对结果…"
          : flow.action === "refresh" ? "正在重新读取页面…"
            : "正在安全处理，请保持此页打开…"
        : entry ? message
          : journal.lockUnavailable
            ? "缺少跨页面写入锁时，不会调用词条写入；已有词库仍可照常阅读。"
            : "重新检查只会读取页面与核对线索，不会自动修改词条。"
    }</p></header>
    {error && <p className="sc-lexeme-write-error" role="alert">{error}</p>}
    {status && <p className="sc-lexeme-write-status" role="status">{status}</p>}
    {entry && <details className="sc-lexeme-receipt" open={flow.phase === "changed"}>
      <summary>查看这次词条动作</summary>
      {entry.ticket.receipt.kind === "status-set" &&
        <p>这里只显示可读状态，不包含内部标识、数据库版本或校验值。</p>}
      <pre>{receiptText(entry.ticket.receipt)}</pre>
    </details>}
    <footer>
      {(journal.storageUnavailable || journal.lockUnavailable) &&
        <button type="button" disabled={busy} onClick={controller.recheckJournal}>重新检查</button>}
      {!journal.storageUnavailable && !journal.lockUnavailable &&
        journal.unreadable.length > 0 &&
        <button type="button" disabled={busy} onClick={() => void controller.clearUnreadable()}>
          保留词条并清除无法验证的提醒
        </button>}
      {entry && flow.phase === "check" &&
        <button className="primary" type="button" disabled={busy || backendBlocked} onClick={() => void controller.inspect(entry)}>只读核对结果</button>}
      {entry && flow.phase === "expected" && <>
        <button type="button" disabled={busy} onClick={() => void controller.discardExpected(entry)}>不执行并清除提醒</button>
        <button className="primary" type="button" disabled={busy || backendBlocked} onClick={() => void controller.continueExpected(entry)}>继续同一张收据</button>
      </>}
      {entry && flow.phase === "changed" &&
        <button className="primary" type="button" disabled={busy} onClick={() => void controller.refreshChanged(entry)}>放弃本页旧内容，读取当前词条并清除旧收据</button>}
      {entry && flow.phase === "refresh-only" &&
        <button className="primary" type="button" disabled={busy} onClick={() => void controller.refreshCommitted(entry)}>只重新读取页面</button>}
      {entry && flow.phase === "invalid" &&
        <button type="button" disabled={busy} onClick={() => void controller.dismissInvalid(entry)}>保留词条并清除提醒</button>}
    </footer>
  </section>;
}
