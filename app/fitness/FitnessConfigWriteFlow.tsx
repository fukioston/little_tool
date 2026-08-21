"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getFitnessExercise } from "@/lib/fitness/catalog";
import {
  commitFitnessConfigWrite,
  inspectFitnessConfigWrite,
  type FitnessConfigWriteReceipt,
} from "@/lib/fitness/store";
import {
  FITNESS_CONFIG_WRITE_PREFIX,
  claimFitnessConfigWrite,
  createFitnessConfigWriteTicket,
  persistFitnessConfigWrite,
  readFitnessConfigWriteJournal,
  releaseFitnessConfigWrite,
  removeFitnessConfigWrite,
  runWithCurrentFitnessConfigWrite,
  type FitnessConfigWriteEntry,
  type FitnessConfigWriteJournal,
  type FitnessConfigWriteToken,
} from "./config-write-journal";
import { fitnessFactsRefreshApplied, type FitnessFactsRefreshOutcome } from "./live-refresh-gate";

type JournalView = FitnessConfigWriteJournal & Readonly<{ loaded: boolean }>;

const EMPTY_JOURNAL: JournalView = {
  loaded: false,
  entries: [],
  unreadable: [],
  unavailable: false,
};

type WorkingAction = "prepare" | "commit" | "inspect" | "refresh" | "journal";

export type FitnessConfigFlow =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "working"; action: WorkingAction }>
  | Readonly<{ phase: "check"; entry: FitnessConfigWriteEntry; message: string }>
  | Readonly<{ phase: "expected"; entry: FitnessConfigWriteEntry; message: string }>
  | Readonly<{ phase: "changed"; entry: FitnessConfigWriteEntry; message: string }>
  | Readonly<{ phase: "refresh-only"; entry: FitnessConfigWriteEntry; message: string }>
  | Readonly<{ phase: "reminder-only"; entry: FitnessConfigWriteEntry; message: string }>
  | Readonly<{ phase: "invalid"; entry: FitnessConfigWriteEntry; message: string }>;

export type FitnessConfigStartResult = "fresh" | "attention";

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "操作没有完成；现有资料没有被静默覆盖。";
}

function receiptLabel(receipt: FitnessConfigWriteReceipt): string {
  switch (receipt.kind) {
    case "profile-save": return "训练偏好";
    case "venue-save": return "场地";
    case "venue-archive": return "场地归档";
    case "venue-restore": return "场地恢复";
    case "equipment-save": return "器材与重量档位";
    case "equipment-status": return "器材状态";
    case "constraint-save": return "身体边界";
    case "constraint-active": return "身体边界状态";
  }
}

function committedCopy(receipt: FitnessConfigWriteReceipt): string {
  return `${receiptLabel(receipt)}已经确认保存在本地。`;
}

export function useFitnessConfigWriteFlow({
  refresh,
  onToast,
  onAttention,
  onDurablePrepared,
  onDurableCommitted,
}: {
  refresh: () => Promise<FitnessFactsRefreshOutcome>;
  onToast: (message: string) => void;
  onAttention: () => void;
  onDurablePrepared?: (receipt: FitnessConfigWriteReceipt) => void;
  onDurableCommitted?: (receipt: FitnessConfigWriteReceipt) => void;
}) {
  const [journal, setJournal] = useState<JournalView>(EMPTY_JOURNAL);
  const [flow, setFlow] = useState<FitnessConfigFlow>({ phase: "idle" });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);
  const operationRef = useRef<FitnessConfigWriteToken | null>(null);
  const mounted = useRef(false);

  const busy = flow.phase === "working";
  const writeLocked = !journal.loaded || journal.unavailable ||
    journal.entries.length > 0 || journal.unreadable.length > 0 || busy;

  const reloadJournal = useCallback(() => {
    let next: FitnessConfigWriteJournal;
    try {
      next = readFitnessConfigWriteJournal();
    } catch {
      next = { entries: [], unreadable: [], unavailable: true };
    }
    if (mounted.current) setJournal({ ...next, loaded: true });
    return next;
  }, []);

  const showAttention = useCallback((next: FitnessConfigFlow) => {
    setFlow(next);
    setFocusRequest((current) => current + 1);
    onAttention();
  }, [onAttention]);

  const claim = useCallback((action: WorkingAction) => {
    const token = claimFitnessConfigWrite(operationRef);
    if (token) {
      setError("");
      setFlow({ phase: "working", action });
    }
    return token;
  }, []);

  const release = useCallback((token: FitnessConfigWriteToken) => {
    releaseFitnessConfigWrite(operationRef, token);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setTimeout(reloadJournal, 0);
    return () => {
      mounted.current = false;
      window.clearTimeout(timer);
    };
  }, [reloadJournal]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(FITNESS_CONFIG_WRITE_PREFIX)) {
        reloadJournal();
        setStatus("另一页的资料核对线索已经变化；这里只重新读取提醒，没有自动核对或写入。");
      }
    };
    const onFocus = () => {
      reloadJournal();
      setStatus("已重新读取资料核对提醒；没有自动核对或写入。");
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
    };
  }, [reloadJournal]);

  useEffect(() => {
    if (!busy) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [busy]);

  const removeCurrent = useCallback(async (entry: FitnessConfigWriteEntry) => {
    const locked = await runWithCurrentFitnessConfigWrite(entry, (lease) => lease.remove());
    reloadJournal();
    return locked.outcome;
  }, [reloadJournal]);

  const reopenLatestAfterStale = useCallback((entry: FitnessConfigWriteEntry) => {
    const latest = reloadJournal().entries.find((candidate) => candidate.storageKey === entry.storageKey);
    if (!latest) {
      setFlow({ phase: "idle" });
      setStatus("另一页已经处理了这条资料核对线索；请以当前页面重新读取的结果为准。");
      return;
    }
    showAttention(latest.ticket.kind === "committed"
      ? {
          phase: "refresh-only",
          entry: latest,
          message: `${committedCopy(latest.ticket.receipt)} 另一页已经推进了这条线索；这里只重新读取，不会再次写入。`,
        }
      : {
          phase: "check",
          entry: latest,
          message: "另一页已经推进了这条核对线索。先按最新线索只核对，不会重复写入。",
        });
  }, [reloadJournal, showAttention]);

  const finishCommitted = useCallback(async (
    entry: FitnessConfigWriteEntry,
    success: string,
    token: FitnessConfigWriteToken,
  ): Promise<FitnessConfigStartResult> => {
    setFlow({ phase: "working", action: "refresh" });
    setStatus(committedCopy(entry.ticket.receipt));
    setError("");
    onDurableCommitted?.(entry.ticket.receipt);
    try {
      const refreshOutcome = await refresh();
      if (!fitnessFactsRefreshApplied(refreshOutcome)) {
        showAttention({
          phase: "refresh-only",
          entry,
          message: refreshOutcome === "deferred"
            ? `${committedCopy(entry.ticket.receipt)} 当前未提交表单仍保留；明确处理后再重新读取，收据不会提前清除。`
            : `${committedCopy(entry.ticket.receipt)} 这次读取已被更新请求取代；收据仍保留。`,
        });
        release(token);
        return "attention";
      }
    } catch {
      showAttention({
        phase: "refresh-only",
        entry,
        message: `${committedCopy(entry.ticket.receipt)} 页面暂时没有重新读到最新资料；只需重新读取，不要重复提交。`,
      });
      release(token);
      return "attention";
    }
    try {
      const removal = await removeCurrent(entry);
      if (removal === "blocked") {
        showAttention({
          phase: "reminder-only",
          entry,
          message: `${committedCopy(entry.ticket.receipt)} 页面已经重新读取；出现了无法完整验证的跨页面提醒，所以这条提醒仍保留。`,
        });
        return "attention";
      }
      if (removal === "stale") {
        reopenLatestAfterStale(entry);
        return "attention";
      }
      setFlow({ phase: "idle" });
      setStatus(success);
      onToast(success);
      return "fresh";
    } catch {
      showAttention({
        phase: "reminder-only",
        entry,
        message: `${committedCopy(entry.ticket.receipt)} 页面已经重新读取；只是提醒暂时没有收起，不需要再次写入。`,
      });
      return "attention";
    } finally {
      release(token);
    }
  }, [onDurableCommitted, onToast, refresh, release, removeCurrent, reopenLatestAfterStale, showAttention]);

  const commitEntry = useCallback(async (
    entry: FitnessConfigWriteEntry,
    success: string,
    token: FitnessConfigWriteToken,
  ): Promise<FitnessConfigStartResult> => {
    setFlow({ phase: "working", action: "commit" });
    try {
      const currentJournal = reloadJournal();
      if (currentJournal.unavailable || currentJournal.unreadable.length > 0) {
        showAttention({
          phase: "expected",
          entry,
          message: "跨页面核对线索暂时无法完整验证；没有继续写入。先处理上方安全提醒。",
        });
        setError("没有调用资料写入；现有资料没有改变。");
        release(token);
        return "attention";
      }
      const locked = await runWithCurrentFitnessConfigWrite(entry, async (lease) => {
        const result = await commitFitnessConfigWrite(entry.ticket.receipt);
        if (result.outcome === "saved" || result.outcome === "already_saved") {
          lease.committed();
        }
        return result;
      });
      if (locked.outcome === "blocked") {
        reloadJournal();
        showAttention({
          phase: "expected",
          entry,
          message: "跨页面核对线索暂时无法完整验证；没有调用资料写入。先处理上方安全提醒。",
        });
        setError("没有调用资料写入；现有资料没有改变。");
        release(token);
        return "attention";
      }
      if (locked.outcome === "stale") {
        reloadJournal();
        setFlow({ phase: "idle" });
        setStatus("另一页已经处理了这条资料核对线索；这个页面没有重复写入。");
        release(token);
        return "attention";
      }
      const result = locked.value;
      if (result.outcome === "outcome_uncertain") {
        showAttention({
          phase: "check",
          entry,
          message: "这次写入结果暂时无法确认。下一步只核对结果，不会重复写入。",
        });
        release(token);
        return "attention";
      }
      if (result.outcome === "changed") {
        showAttention({
          phase: "changed",
          entry,
          message: "这份资料已经在另一页或恢复操作中变化；旧收据没有覆盖当前内容。你刚填写的内容仍保留在下方，可先查看或复制。",
        });
        release(token);
        return "attention";
      }
      if (!locked.entry) throw new Error("资料已保存，但浏览器没有保留刷新线索。");
      reloadJournal();
      return finishCommitted(locked.entry, success, token);
    } catch (reason) {
      showAttention({
        phase: "check",
        entry,
        message: "这次写入结果需要核对。核对动作不会重复保存。",
      });
      setError(`${reasonMessage(reason)} 收据仍保留，请先只核对结果。`);
      release(token);
      return "attention";
    }
  }, [finishCommitted, reloadJournal, release, showAttention]);

  const start = useCallback(async (
    prepare: () => Promise<FitnessConfigWriteReceipt>,
    success: string,
  ): Promise<FitnessConfigStartResult> => {
    const token = claim("prepare");
    if (!token) return "attention";
    let entry: FitnessConfigWriteEntry | null = null;
    try {
      const currentJournal = reloadJournal();
      if (currentJournal.unavailable) {
        throw new Error("暂时无法安全保留跨页面核对线索；没有开始写入。");
      }
      if (currentJournal.unreadable.length > 0) {
        throw new Error("先处理无法验证的旧资料提醒；没有开始新的写入。");
      }
      if (currentJournal.entries.length > 0) {
        throw new Error("先处理上一条资料写入核对线索；没有开始新的写入。");
      }
      const receipt = await prepare();
      entry = await persistFitnessConfigWrite(createFitnessConfigWriteTicket(receipt));
      onDurablePrepared?.(receipt);
      reloadJournal();
      return await commitEntry(entry, success, token);
    } catch (reason) {
      if (entry) {
        showAttention({
          phase: "check",
          entry,
          message: "这次写入结果需要核对。核对动作不会重复保存。",
        });
        setError(`${reasonMessage(reason)} 收据仍保留，请先只核对结果。`);
        release(token);
        return "attention";
      }
      setFlow({ phase: "idle" });
      release(token);
      throw reason;
    }
  }, [claim, commitEntry, onDurablePrepared, reloadJournal, release, showAttention]);

  const open = useCallback((entry?: FitnessConfigWriteEntry) => {
    const next = entry ?? reloadJournal().entries[0] ?? null;
    setError("");
    if (!next) {
      setFlow({ phase: "idle" });
      setFocusRequest((current) => current + 1);
      onAttention();
      return;
    }
    showAttention(next.ticket.kind === "committed"
      ? {
          phase: "refresh-only",
          entry: next,
          message: `${committedCopy(next.ticket.receipt)} 这里只会重新读取页面，不会再次写入。`,
        }
      : {
          phase: "check",
          entry: next,
          message: "这条写入结果还没有确认。先只核对，不会重复写入。",
        });
  }, [onAttention, reloadJournal, showAttention]);

  const inspect = useCallback(async (entry: FitnessConfigWriteEntry) => {
    const token = claim("inspect");
    if (!token) return;
    try {
      const currentJournal = reloadJournal();
      if (currentJournal.unavailable || currentJournal.unreadable.length > 0) {
        showAttention({
          phase: "check",
          entry,
          message: "跨页面核对线索暂时无法完整验证；没有调用资料核对。先处理上方安全提醒。",
        });
        setError("没有调用资料核对；现有资料没有改变。");
        return;
      }
      const locked = await runWithCurrentFitnessConfigWrite(entry, async (lease) => {
        const inspection = await inspectFitnessConfigWrite(entry.ticket.receipt);
        if (inspection === "exact_saved") lease.committed();
        return inspection;
      });
      if (locked.outcome === "blocked") {
        reloadJournal();
        showAttention({
          phase: "check",
          entry,
          message: "跨页面核对线索暂时无法完整验证；没有调用资料核对。先处理上方安全提醒。",
        });
        setError("没有调用资料核对；现有资料没有改变。");
        return;
      }
      if (locked.outcome === "stale") {
        reloadJournal();
        setFlow({ phase: "idle" });
        setStatus("另一页已经处理了这条核对线索；这里只重新读取提醒。");
        return;
      }
      const inspection = locked.value;
      if (inspection === "exact_saved") {
        if (!locked.entry) throw new Error("保存事实已确认，但浏览器没有保留刷新线索。");
        reloadJournal();
        await finishCommitted(locked.entry, committedCopy(entry.ticket.receipt), token);
        return;
      }
      if (inspection === "expected") {
        showAttention({
          phase: "expected",
          entry,
          message: "这次确定还没有写入。只有你明确选择继续时，才会使用同一张收据保存。",
        });
        return;
      }
      if (inspection === "changed") {
        showAttention({
          phase: "changed",
          entry,
          message: "当前资料已经变化；旧收据没有覆盖现在的内容，也不能再用于保存。你刚填写的内容仍保留在下方，可先查看或复制。",
        });
        return;
      }
      if (inspection === "invalid_receipt") {
        showAttention({
          phase: "invalid",
          entry,
          message: "这条核对凭据无法验证。系统没有据此写入；可以保留现有资料并清除提醒。",
        });
        return;
      }
      showAttention({
        phase: "check",
        entry,
        message: "现在仍无法确认写入结果。可以稍后再次只做核对。",
      });
    } catch (reason) {
      showAttention({
        phase: "check",
        entry,
        message: "现在仍无法确认写入结果。可以稍后再次只做核对。",
      });
      setError(reasonMessage(reason));
    } finally {
      release(token);
    }
  }, [claim, finishCommitted, release, reloadJournal, showAttention]);

  const continueExpected = useCallback(async (entry: FitnessConfigWriteEntry) => {
    const token = claim("commit");
    if (!token) return;
    await commitEntry(entry, committedCopy(entry.ticket.receipt), token);
  }, [claim, commitEntry]);

  const refreshCommitted = useCallback(async (entry: FitnessConfigWriteEntry) => {
    const token = claim("refresh");
    if (!token) return;
    await finishCommitted(entry, committedCopy(entry.ticket.receipt), token);
  }, [claim, finishCommitted]);

  const discardExpected = useCallback(async (entry: FitnessConfigWriteEntry) => {
    const token = claim("journal");
    if (!token) return;
    try {
      const removal = await removeCurrent(entry);
      if (removal === "blocked") {
        showAttention({ phase: "expected", entry, message: "这次确定还没有写入；出现了无法完整验证的跨页面提醒，所以这条收据仍保留。" });
        setError("没有清除提醒；现有资料没有改变。");
        return;
      }
      if (removal === "stale") {
        reopenLatestAfterStale(entry);
        return;
      }
      setFlow({ phase: "idle" });
      setStatus("这次确定未写入的收据已经清除；现有资料没有改变。");
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({ phase: "expected", entry, message: "这次确定还没有写入；提醒暂时没有清除。" });
    } finally {
      release(token);
    }
  }, [claim, release, removeCurrent, reopenLatestAfterStale, showAttention]);

  const refreshChanged = useCallback(async (entry: FitnessConfigWriteEntry) => {
    const token = claim("refresh");
    if (!token) return;
    try {
      const refreshOutcome = await refresh();
      if (!fitnessFactsRefreshApplied(refreshOutcome)) {
        showAttention({
          phase: "changed",
          entry,
          message: refreshOutcome === "deferred"
            ? "当前未提交表单仍保留；明确处理前不会清除旧收据。"
            : "这次读取已被更新请求取代；旧收据仍保留。",
        });
        return;
      }
      const removal = await removeCurrent(entry);
      if (removal === "blocked") {
        showAttention({ phase: "changed", entry, message: "当前资料已经变化；页面已重新读取，但出现了无法完整验证的跨页面提醒，所以旧收据仍保留。" });
        return;
      }
      if (removal === "stale") {
        reopenLatestAfterStale(entry);
        return;
      }
      setFlow({ phase: "idle" });
      setStatus("已经重新读取当前资料；旧收据没有写入或覆盖任何内容。");
    } catch (reason) {
      setError(`${reasonMessage(reason)} 仍保留上次成功显示的内容和旧收据。`);
      showAttention({
        phase: "changed",
        entry,
        message: "当前资料已经变化；重新读取成功前，旧收据不会改动现在的内容。",
      });
    } finally {
      release(token);
    }
  }, [claim, refresh, release, removeCurrent, reopenLatestAfterStale, showAttention]);

  const dismissReminder = useCallback(async (entry: FitnessConfigWriteEntry) => {
    const token = claim("journal");
    if (!token) return;
    try {
      const removal = await removeCurrent(entry);
      if (removal === "blocked") {
        showAttention({ phase: "reminder-only", entry, message: "资料内容没有再次改动；出现了无法完整验证的跨页面提醒，所以这条提醒仍保留。" });
        return;
      }
      if (removal === "stale") {
        reopenLatestAfterStale(entry);
        return;
      }
      setFlow({ phase: "idle" });
      setStatus("核对提醒已经收起；资料内容没有再次改动。");
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({ phase: "reminder-only", entry, message: "资料已经是最新；提醒暂时没有收起。" });
    } finally {
      release(token);
    }
  }, [claim, release, removeCurrent, reopenLatestAfterStale, showAttention]);

  const clearUnreadable = useCallback(async () => {
    const token = claim("journal");
    if (!token) return;
    try {
      const current = reloadJournal();
      for (const entry of current.unreadable) {
        if (!await removeFitnessConfigWrite(entry)) {
          throw new Error("另一页已经改动了一条无法验证的提醒。");
        }
      }
      reloadJournal();
      setFlow({ phase: "idle" });
      setStatus("无法验证的提醒已经清除；现有资料没有改变。");
    } catch (reason) {
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
    status,
    error,
    focusRequest,
    start,
    open,
    inspect,
    continueExpected,
    refreshCommitted,
    discardExpected,
    refreshChanged,
    dismissReminder,
    clearUnreadable,
    recheckJournal: reloadJournal,
    clearMessages() { setStatus(""); setError(""); },
  } as const;
}

type ConfigFlowController = ReturnType<typeof useFitnessConfigWriteFlow>;

export function FitnessConfigWriteBanner({
  controller,
  onOpen,
}: {
  controller: ConfigFlowController;
  onOpen: () => void;
}) {
  const { journal } = controller;
  if (!journal.loaded || (!journal.unavailable && journal.entries.length === 0 && journal.unreadable.length === 0)) {
    return null;
  }
  return <section className="sl-global-config-recovery" role="status" aria-live="polite">
    <div><b>{journal.unavailable
      ? "资料核对线索暂时无法安全读取"
      : journal.entries.length > 0
        ? `有 ${journal.entries.length} 条资料写入待核对`
        : "有无法验证的资料写入提醒"}</b><p>{journal.unavailable
      ? "新的偏好、场地、器材和身体边界改动先停用；已有资料没有因此改变。"
      : `这些线索属于当前完整网址与浏览器资料。${journal.unreadable.length ? `其中 ${journal.unreadable.length} 条无法验证；` : ""}打开后才会核对或继续。`}</p></div>
    <button type="button" onClick={onOpen}>{journal.entries.length ? "打开下一条" : "查看安全说明"}</button>
  </section>;
}

export function FitnessConfigWriteRecovery({ controller }: { controller: ConfigFlowController }) {
  const heading = useRef<HTMLElement>(null);
  const { flow, journal, busy, error, status, focusRequest } = controller;
  useEffect(() => {
    if (!focusRequest) return;
    const frame = window.requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);

  const entry = flow.phase === "check" || flow.phase === "expected" ||
    flow.phase === "changed" || flow.phase === "refresh-only" ||
    flow.phase === "reminder-only" || flow.phase === "invalid"
    ? flow.entry
    : null;
  const entryMessage = "message" in flow ? flow.message : "";
  const backendActionsBlocked = journal.unavailable || journal.unreadable.length > 0;
  const title = journal.unavailable
    ? "暂时无法安全协调资料写入"
    : journal.unreadable.length > 0
      ? "有无法验证的资料提醒"
      : flow.phase === "working"
        ? "正在安全处理"
        : flow.phase === "expected"
          ? "这次确定还没有写入"
          : flow.phase === "changed"
            ? "当前资料已经变化"
            : flow.phase === "refresh-only"
              ? "保存事实已确认，页面待刷新"
              : flow.phase === "reminder-only"
                ? "页面已更新，提醒待收起"
                : flow.phase === "invalid"
                  ? "核对凭据无法验证"
                  : entry
                    ? "有一条资料写入需要核对"
                    : "资料写入核对";

  return <section className="sl-config-recovery">
    <header><span ref={heading} tabIndex={-1}>{title}</span><p>{flow.phase === "working"
      ? flow.action === "inspect" ? "正在只读核对结果…" : flow.action === "refresh" ? "正在重新读取页面…" : "正在安全处理，请保持此页打开…"
      : entry ? entryMessage : journal.unavailable
        ? "浏览器没有提供可用的跨页面锁或核对存储。重新检查不会写入资料。"
        : journal.unreadable.length > 0
          ? "系统没有依据这些提醒写入。可以保留所有现有资料，只清除不可用提醒。"
          : "当前没有待处理的资料写入。"}</p></header>
    {error && <p className="sl-form-error" role="alert">{error}</p>}
    {status && <p className="sl-data-status" role="status">{status}</p>}
    {entry && flow.phase !== "invalid" && <FitnessConfigReceiptDraft entry={entry} emphasize={flow.phase === "changed"} />}
    <footer>
      {journal.unavailable && <button type="button" disabled={busy} onClick={controller.recheckJournal}>重新检查</button>}
      {!journal.unavailable && journal.unreadable.length > 0 && <button type="button" disabled={busy} onClick={() => void controller.clearUnreadable()}>保留资料并清除提醒</button>}
      {entry && flow.phase === "check" && <button className="sl-primary" type="button" disabled={busy || backendActionsBlocked} onClick={() => void controller.inspect(entry)}>只核对结果</button>}
      {entry && flow.phase === "expected" && <><button type="button" disabled={busy} onClick={() => void controller.discardExpected(entry)}>不保存并清除提醒</button><button className="sl-primary" type="button" disabled={busy || backendActionsBlocked} onClick={() => void controller.continueExpected(entry)}>继续保存同一份内容</button></>}
      {entry && flow.phase === "changed" && <button className="sl-danger-action" type="button" disabled={busy} onClick={() => void controller.refreshChanged(entry)}>清除这份收据并读取当前资料（不可撤回）</button>}
      {entry && flow.phase === "refresh-only" && <button className="sl-primary" type="button" disabled={busy} onClick={() => void controller.refreshCommitted(entry)}>只重新读取</button>}
      {entry && (flow.phase === "reminder-only" || flow.phase === "invalid") && <button type="button" disabled={busy} onClick={() => void controller.dismissReminder(entry)}>保留资料并清除提醒</button>}
    </footer>
  </section>;
}

const displayValue = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === "" ? "未填写" : String(value);
const yesNo = (value: boolean) => value ? "是" : "否";
const listValue = (values: readonly (string | number)[]) => values.length ? values.join("、") : "未填写";
const goalDraftLabels: Record<string, string> = {
  strength: "力量", muscle: "增肌", cardio: "心肺", general_health: "一般健康",
  sport: "运动专项", mobility: "活动度",
};
const patternDraftLabels: Record<string, string> = {
  squat: "深蹲", hinge: "髋铰链", horizontal_push: "水平推", horizontal_pull: "水平拉",
  vertical_push: "垂直推", vertical_pull: "垂直拉", lunge: "弓步", carry: "负重行走",
  core: "核心", isolation: "孤立动作", cardio: "心肺",
};
const experienceDraftLabels: Record<string, string> = { new: "刚开始", returning: "重新开始", consistent: "有稳定训练经验", advanced: "熟悉自主规划" };
const splitDraftLabels: Record<string, string> = { auto: "根据频次给出候选", full_body: "全身", upper_lower: "上下肢", push_pull_legs: "推拉腿", custom: "自定义" };
const venueTypeDraftLabels: Record<string, string> = { commercial: "商业健身房", home: "家中", office: "公司", hotel: "酒店", outdoor: "户外", other: "其他" };
const equipmentKindDraftLabels: Record<string, string> = {
  barbell: "杠铃", plates: "杠铃片", rack: "深蹲架", bench: "训练凳", dumbbell: "哑铃",
  kettlebell: "壶铃", cable: "绳索器械", fixed_machine: "固定器械", smith_machine: "史密斯机",
  pullup_bar: "单杠", dip_station: "双杠", bands: "弹力带", mat: "训练垫", treadmill: "跑步机",
  bike: "健身车", rower: "划船机", elliptical: "椭圆机", stair_climber: "登阶机",
  open_space: "开放空间", other: "其他",
};
const equipmentStatusDraftLabels: Record<string, string> = { available: "可用", limited: "部分可用", maintenance: "临时停用", removed: "这里已没有" };
const loadModeDraftLabels: Record<string, string> = { none: "无需重量", discrete: "明确档位", range: "连续范围", plate_loaded: "装片式" };
const loadSemanticsDraftLabels: Record<string, string> = { total: "总负荷", per_hand: "每只手", per_side: "每侧", stack_label: "面板档位", resistance_level: "阻力等级" };
const busyDraftLabels: Record<string, string> = { unknown: "还不知道", low: "通常容易用到", medium: "有时需要等", high: "经常需要替代" };
const severityDraftLabels: Record<string, string> = { monitor: "只提醒留意", modify: "需要调整动作或幅度", avoid: "不要安排这些模式" };
const weekdayDraftLabels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const gramsDraftValue = (grams: number | null) => grams === null ? null : `${Number((grams / 1000).toFixed(3))} kg`;
const exerciseDraftValues = (ids: readonly string[]) => ids.length
  ? ids.map((id, index) => {
      const exercise = getFitnessExercise(id);
      return exercise
        ? `${index + 1}. ${exercise.name_zh}（${exercise.name_en}）`
        : `${index + 1}. 当前版本不识别的动作标识：${id}`;
    })
  : ["未填写"];

function fitnessConfigReceiptDraftText(receipt: FitnessConfigWriteReceipt): string {
  const line = (label: string, value: string | number | null | undefined) => `${label}：${displayValue(value)}`;
  switch (receipt.kind) {
    case "profile-save":
      return [
        "训练偏好",
        line("目标", listValue(receipt.after.goals.map((value) => goalDraftLabels[value] ?? value))),
        line("训练经验", experienceDraftLabels[receipt.after.experience] ?? receipt.after.experience),
        line("每周力量训练", `${receipt.after.resistance_days_per_week} 次`),
        line("每周有氧训练", `${receipt.after.cardio_days_per_week} 次`),
        line("单次时间", `${receipt.after.session_minutes} 分钟`),
        line("分化偏好", splitDraftLabels[receipt.after.split] ?? receipt.after.split),
        line("方便训练的星期", listValue(receipt.after.preferred_weekdays.map((value) => weekdayDraftLabels[value] ?? value))),
        line("默认保留余力", `RIR ${receipt.after.preferred_rir}`),
        line("默认休息", `${receipt.after.rest_seconds} 秒`),
        line("重量单位", receipt.after.unit),
        line("备注", receipt.after.notes),
      ].join("\n");
    case "venue-save":
      return [
        "场地",
        line("名称", receipt.after.name),
        line("场地类型", venueTypeDraftLabels[receipt.after.venue_type] ?? receipt.after.venue_type),
        line("位置", receipt.after.location),
        line("区域与规则", receipt.after.area_notes),
        line("拥挤规律", receipt.after.busy_notes),
        line("通常可用时间", `${receipt.after.default_session_minutes} 分钟`),
        line("适合跨器材超级组", yesNo(receipt.after.supersets_allowed)),
        line("设为常用场地", yesNo(receipt.after.is_default)),
        line("现场核对时间", receipt.after.last_verified_at ? new Date(receipt.after.last_verified_at).toLocaleString("zh-CN") : null),
        line("将取消常用标记的场地", listValue(receipt.defaultResets.map(({ before }) => before.name))),
      ].join("\n");
    case "venue-archive":
      return [
        "归档场地",
        line("场地", receipt.after.name),
        line("将停用的计划", `${receipt.programs.length} 条`),
        line("将取消的未开始日历安排", `${receipt.events.length} 条`),
        "训练历史、器材和已经发生的记录会保留。",
      ].join("\n");
    case "venue-restore":
      return ["恢复场地", line("场地", receipt.after.name), "旧计划和已取消安排不会自动恢复。"].join("\n");
    case "equipment-save": {
      const equipment = receipt.after.equipment;
      return [
        "器材与重量档位",
        line("所属场地", "已由安全收据绑定；场地名称未包含在这张收据中"),
        line("名称", equipment.name),
        line("器材类型", equipmentKindDraftLabels[equipment.kind] ?? equipment.kind),
        line("所在区域", equipment.area),
        line("数量", equipment.quantity),
        line("状态", equipmentStatusDraftLabels[equipment.status] ?? equipment.status),
        line("负荷记录方式", loadModeDraftLabels[equipment.load_mode] ?? equipment.load_mode),
        line("负荷含义", loadSemanticsDraftLabels[equipment.load_semantics] ?? equipment.load_semantics),
        line("最低重量", gramsDraftValue(equipment.min_load_grams)),
        line("最高重量", gramsDraftValue(equipment.max_load_grams)),
        line("递增重量", gramsDraftValue(equipment.increment_grams)),
        line("空杆或机器杆重", gramsDraftValue(equipment.bar_weight_grams)),
        line("左右侧可独立训练", yesNo(equipment.unilateral)),
        line("常见占用情况", busyDraftLabels[equipment.busy_level] ?? equipment.busy_level),
        line("附件名称", listValue(equipment.attachments)),
        line("个人设置与现场备注", equipment.notes),
        "重量档位：",
        ...(receipt.after.loads.length
          ? receipt.after.loads.map((load, index) =>
              `${index + 1}. ${load.label || `${load.load_grams} 克`} × ${load.quantity}${load.available ? "" : "（暂不可用）"}`)
          : ["未填写"]),
      ].join("\n");
    }
    case "equipment-status":
      return [
        "器材状态",
        line("器材", receipt.after.name),
        line("原状态", equipmentStatusDraftLabels[receipt.before.status] ?? receipt.before.status),
        line("新状态", equipmentStatusDraftLabels[receipt.after.status] ?? receipt.after.status),
      ].join("\n");
    case "constraint-save":
      return [
        "身体边界",
        line("称呼", receipt.after.label),
        line("身体部位", receipt.after.body_area),
        line("处理方式", severityDraftLabels[receipt.after.severity] ?? receipt.after.severity),
        line("动作模式", listValue(receipt.after.movement_patterns.map((value) => patternDraftLabels[value] ?? value))),
        "指定动作：",
        ...exerciseDraftValues(receipt.after.exercise_ids),
        line("说明或专业建议", receipt.after.note),
        line("是否生效", yesNo(receipt.after.active)),
      ].join("\n");
    case "constraint-active":
      return [
        "身体边界状态",
        line("称呼", receipt.after.label),
        line("原状态", receipt.before.active ? "生效中" : "已结束"),
        line("新状态", receipt.after.active ? "生效中" : "已结束"),
        line("动作模式", listValue(receipt.after.movement_patterns.map((value) => patternDraftLabels[value] ?? value))),
        "指定动作：",
        ...exerciseDraftValues(receipt.after.exercise_ids),
        line("说明或专业建议", receipt.after.note),
      ].join("\n");
  }
}

function FitnessConfigReceiptDraft({ entry, emphasize }: { entry: FitnessConfigWriteEntry; emphasize: boolean }) {
  const [copyStatus, setCopyStatus] = useState("");
  const text = fitnessConfigReceiptDraftText(entry.ticket.receipt);
  return <details className="sl-config-receipt-draft" open={emphasize}>
    <summary>查看我刚填写的完整内容</summary>
    <p>这份内容来自已持久保存的安全收据。当前资料若已变化，它不会覆盖新内容；清除收据不可撤回，请先查看或复制。</p>
    <pre aria-label="我刚填写的收据内容">{text}</pre>
    <button type="button" onClick={() => {
      const attempt = navigator.clipboard?.writeText(text);
      if (!attempt) {
        setCopyStatus("没有自动复制；可在上方文本中手动选择复制。");
        return;
      }
      void attempt.then(
        () => setCopyStatus("已复制收据内容。"),
        () => setCopyStatus("没有自动复制；可在上方文本中手动选择复制。"),
      );
    }}>复制我刚填写的内容</button>
    {copyStatus && <small role="status">{copyStatus}</small>}
  </details>;
}
