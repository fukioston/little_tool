"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  commitVocabSettingsWrite,
  inspectVocabSettingsWrite,
  VocabSettingsMutationError,
  type VocabSettingsWriteReceipt,
} from "@/lib/vocab/store";
import {
  VOCAB_SETTINGS_WRITE_PREFIX,
  claimVocabSettingsWrite,
  createVocabSettingsWriteTicket,
  persistVocabSettingsWrite,
  readVocabSettingsWriteJournal,
  releaseVocabSettingsWrite,
  removeUnreadableVocabSettingsWrite,
  runWithCurrentVocabSettingsWrite,
  type VocabSettingsWriteEntry,
  type VocabSettingsWriteJournal,
  type VocabSettingsWriteToken,
} from "./settings-write-journal";

export type VocabSettingsRefreshOutcome = "applied" | "deferred" | "superseded";
export type VocabSettingsStartResult = "fresh" | "attention";

type JournalView = VocabSettingsWriteJournal & Readonly<{ loaded: boolean }>;
type WorkingAction = "prepare" | "commit" | "inspect" | "refresh" | "journal";
type Flow =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "working"; action: WorkingAction }>
  | Readonly<{ phase: "check" | "expected" | "changed" | "refresh-only" | "invalid"; entry: VocabSettingsWriteEntry; message: string }>;

const EMPTY_JOURNAL: JournalView = {
  loaded: false,
  entries: [],
  unreadable: [],
  storageUnavailable: false,
  lockUnavailable: false,
};

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "设置操作没有完成；现有内容没有被静默覆盖。";
}

function savedCopy() {
  return "设置已经确认保存在当前浏览器的本地词库。";
}

function phaseForEntry(entry: VocabSettingsWriteEntry): Flow {
  if (entry.ticket.kind === "committed") {
    return { phase: "refresh-only", entry, message: `${savedCopy()} 这里只重新读取页面，不会再次写入。` };
  }
  if (entry.ticket.kind === "changed") {
    return { phase: "changed", entry, message: "当前设置已经变化；这份旧内容不会覆盖新内容，只能重新读取后清除提醒。" };
  }
  return { phase: "check", entry, message: "这次设置结果还没有确认。先只读核对，不会重复写入。" };
}

export function useVocabSettingsWriteFlow({
  refresh,
  onToast,
  onAttention,
  onDurablePrepared,
  onDurableCommitted,
  onDurableSettled,
}: {
  refresh: () => Promise<VocabSettingsRefreshOutcome>;
  onToast: (message: string) => void;
  onAttention: () => void;
  onDurablePrepared?: (receipt: VocabSettingsWriteReceipt) => void;
  onDurableCommitted?: (receipt: VocabSettingsWriteReceipt) => void;
  onDurableSettled?: (receipt: VocabSettingsWriteReceipt) => void;
}) {
  const [journal, setJournal] = useState<JournalView>(EMPTY_JOURNAL);
  const [flow, setFlow] = useState<Flow>({ phase: "idle" });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);
  const operationRef = useRef<VocabSettingsWriteToken | null>(null);
  const mounted = useRef(false);

  const busy = flow.phase === "working";
  const writeLocked = !journal.loaded || journal.storageUnavailable || journal.lockUnavailable ||
    journal.entries.length > 0 || journal.unreadable.length > 0 || busy;

  const reloadJournal = useCallback(() => {
    let next: VocabSettingsWriteJournal;
    try {
      next = readVocabSettingsWriteJournal();
    } catch {
      next = { entries: [], unreadable: [], storageUnavailable: true, lockUnavailable: typeof navigator === "undefined" || !navigator.locks };
    }
    if (mounted.current) setJournal({ ...next, loaded: true });
    return next;
  }, []);

  const showAttention = useCallback((next: Flow) => {
    setFlow(next);
    setFocusRequest((current) => current + 1);
    onAttention();
  }, [onAttention]);

  const claim = useCallback((action: WorkingAction) => {
    const token = claimVocabSettingsWrite(operationRef);
    if (token) {
      setError("");
      setFlow({ phase: "working", action });
    }
    return token;
  }, []);

  const release = useCallback((token: VocabSettingsWriteToken) => {
    releaseVocabSettingsWrite(operationRef, token);
  }, []);

  useEffect(() => {
    mounted.current = true;
    reloadJournal();
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && event.key?.startsWith(VOCAB_SETTINGS_WRITE_PREFIX)) reloadJournal();
    };
    const onFocus = () => reloadJournal();
    const onVisibility = () => { if (document.visibilityState === "visible") reloadJournal(); };
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
    if (!busy) return;
    const protect = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [busy]);

  const reopenLatest = useCallback((entry: VocabSettingsWriteEntry) => {
    const latestJournal = reloadJournal();
    const latest = latestJournal.entries.find((candidate) => candidate.storageKey === entry.storageKey) ?? latestJournal.entries[0];
    if (!latest) {
      setFlow({ phase: "idle" });
      setError("另一页已经处理了这条提醒；请按页面上的最新状态继续。");
      return;
    }
    showAttention(phaseForEntry(latest));
  }, [reloadJournal, showAttention]);

  const removeCurrent = useCallback(async (entry: VocabSettingsWriteEntry) => {
    const result = await runWithCurrentVocabSettingsWrite(entry, (lease) => lease.remove());
    reloadJournal();
    return result.outcome;
  }, [reloadJournal]);

  const finishCommitted = useCallback(async (
    entry: VocabSettingsWriteEntry,
    success: string,
    token: VocabSettingsWriteToken,
  ): Promise<VocabSettingsStartResult> => {
    setFlow({ phase: "working", action: "refresh" });
    setStatus(savedCopy());
    setError("");
    onDurableCommitted?.(entry.ticket.receipt);
    let refreshOutcome: VocabSettingsRefreshOutcome;
    try {
      refreshOutcome = await refresh();
    } catch {
      showAttention({ phase: "refresh-only", entry, message: `${savedCopy()} 页面暂时没有读到最新设置；只需重新读取，不要重复提交。` });
      release(token);
      return "attention";
    }
    if (refreshOutcome !== "applied") {
      showAttention({
        phase: "refresh-only",
        entry,
        message: refreshOutcome === "deferred"
          ? `${savedCopy()} 当前未提交的设置草稿仍保留；明确处理草稿后再重新读取，收据不会提前清除。`
          : `${savedCopy()} 这次读取已被更新请求取代；收据仍保留。`,
      });
      release(token);
      return "attention";
    }
    try {
      const removal = await removeCurrent(entry);
      if (removal === "blocked") {
        showAttention({ phase: "refresh-only", entry, message: `${savedCopy()} 页面已更新，但出现了无法完整验证的提醒；这条收据仍保留。` });
        return "attention";
      }
      if (removal === "stale") {
        reopenLatest(entry);
        return "attention";
      }
      setFlow({ phase: "idle" });
      setStatus(success);
      onToast(success);
      onDurableSettled?.(entry.ticket.receipt);
      return "fresh";
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({ phase: "refresh-only", entry, message: `${savedCopy()} 页面已经更新；只是提醒暂时没有收起，不需要再次写入。` });
      return "attention";
    } finally {
      release(token);
    }
  }, [onDurableCommitted, onDurableSettled, onToast, refresh, release, removeCurrent, reopenLatest, showAttention]);

  const commitEntry = useCallback(async (
    entry: VocabSettingsWriteEntry,
    success: string,
    token: VocabSettingsWriteToken,
  ): Promise<VocabSettingsStartResult> => {
    setFlow({ phase: "working", action: "commit" });
    try {
      const result = await runWithCurrentVocabSettingsWrite(entry, async (lease) => {
        try {
          const committed = await commitVocabSettingsWrite(entry.ticket.receipt);
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
          if (reason instanceof VocabSettingsMutationError && reason.code === "write_failed") {
            return "expected" as const;
          }
          throw reason;
        }
      });
      reloadJournal();
      if (result.outcome === "blocked") {
        showAttention({ phase: "check", entry, message: "设置核对线索暂时无法完整验证；没有调用设置写入。" });
        setError("现有设置没有改变；先处理全局安全提醒。");
        release(token);
        return "attention";
      }
      if (result.outcome === "stale") {
        reopenLatest(entry);
        release(token);
        return "attention";
      }
      if (result.value === "saved" && result.entry) return finishCommitted(result.entry, success, token);
      if (result.value === "changed" && result.entry) {
        showAttention({ phase: "changed", entry: result.entry, message: "设置已经在别处变化；这份旧内容没有覆盖当前内容，也不会再次写入。" });
      } else if (result.value === "expected") {
        showAttention({ phase: "expected", entry, message: "这次确定还没有写入。可以清除提醒，或明确继续保存同一份内容。" });
      } else {
        showAttention({ phase: "check", entry, message: "这次设置结果仍需只读核对；不会凭猜测重复写入。" });
      }
      release(token);
      return "attention";
    } catch (reason) {
      reloadJournal();
      showAttention({ phase: "check", entry, message: "这次设置结果需要只读核对；收据仍保留。" });
      setError(reasonMessage(reason));
      release(token);
      return "attention";
    }
  }, [finishCommitted, reloadJournal, release, reopenLatest, showAttention]);

  const start = useCallback(async (
    prepare: () => Promise<VocabSettingsWriteReceipt>,
    success: string,
  ): Promise<VocabSettingsStartResult> => {
    const token = claim("prepare");
    if (!token) return "attention";
    let entry: VocabSettingsWriteEntry | null = null;
    let preparedReceipt: VocabSettingsWriteReceipt | null = null;
    try {
      const current = reloadJournal();
      if (current.storageUnavailable) throw new Error("暂时无法读取设置核对存储；没有开始写入。");
      if (current.lockUnavailable) throw new Error("当前浏览器没有安全跨页面写入锁；没有开始写入。");
      if (current.unreadable.length > 0) throw new Error("先处理无法验证的设置提醒；没有开始写入。");
      if (current.entries.length > 0) throw new Error("先处理上一条设置核对线索；没有开始写入。");
      const receipt = await prepare();
      preparedReceipt = receipt;
      entry = await persistVocabSettingsWrite(createVocabSettingsWriteTicket(receipt));
      onDurablePrepared?.(receipt);
      reloadJournal();
      return await commitEntry(entry, success, token);
    } catch (reason) {
      if (entry) {
        showAttention({ phase: "check", entry, message: "这次设置结果需要只读核对；收据仍保留。" });
        setError(reasonMessage(reason));
        release(token);
        return "attention";
      }
      const recovered = reloadJournal();
      const recoveredEntry = preparedReceipt
        ? recovered.entries.find((candidate) => candidate.ticket.receipt.operationId === preparedReceipt?.operationId)
        : null;
      if (recoveredEntry) {
        onDurablePrepared?.(recoveredEntry.ticket.receipt);
        showAttention({ phase: "check", entry: recoveredEntry, message: "安全收据可能已经保留；先只读核对结果，不会重复写入。" });
        setError(`${reasonMessage(reason)} 请先按已保留的线索核对。`);
        release(token);
        return "attention";
      }
      setFlow({ phase: "idle" });
      release(token);
      throw reason;
    }
  }, [claim, commitEntry, onDurablePrepared, reloadJournal, release, showAttention]);

  const open = useCallback((entry?: VocabSettingsWriteEntry) => {
    if (operationRef.current) return;
    const next = entry ?? reloadJournal().entries[0] ?? null;
    setError("");
    showAttention(next ? phaseForEntry(next) : { phase: "idle" });
  }, [reloadJournal, showAttention]);

  const inspect = useCallback(async (entry: VocabSettingsWriteEntry) => {
    const token = claim("inspect");
    if (!token) return;
    try {
      const result = await runWithCurrentVocabSettingsWrite(entry, async (lease) => {
        const inspection = await inspectVocabSettingsWrite(entry.ticket.receipt);
        if (inspection === "exact_saved") lease.committed();
        else if (inspection === "changed") lease.changed();
        return inspection;
      });
      reloadJournal();
      if (result.outcome === "blocked") {
        showAttention({ phase: "check", entry, message: "当前无法完整验证全部设置提醒；没有调用结果核对。" });
        release(token);
        return;
      }
      if (result.outcome === "stale") {
        reopenLatest(entry);
        release(token);
        return;
      }
      if (result.value === "exact_saved" && result.entry) {
        await finishCommitted(result.entry, "设置已确认并重新读取", token);
        return;
      }
      if (result.value === "expected") {
        showAttention({ phase: "expected", entry, message: "这次确定还没有写入。可以清除提醒，或明确继续保存同一份内容。" });
      } else if (result.value === "changed" && result.entry) {
        showAttention({ phase: "changed", entry: result.entry, message: "当前设置已经变化；旧内容没有覆盖现在的设置。" });
      } else if (result.value === "invalid_receipt") {
        showAttention({ phase: "invalid", entry, message: "这份设置收据无法验证；没有据此写入。" });
      } else {
        showAttention({ phase: "check", entry, message: "结果仍无法确认；收据继续保留，不会自动重试。" });
      }
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({ phase: "check", entry, message: "只读核对没有完成；收据仍保留。" });
    } finally {
      release(token);
    }
  }, [claim, finishCommitted, reloadJournal, release, reopenLatest, showAttention]);

  const continueExpected = useCallback(async (entry: VocabSettingsWriteEntry) => {
    const token = claim("commit");
    if (!token) return;
    await commitEntry(entry, "设置已保存并重新读取", token);
  }, [claim, commitEntry]);

  const discardExpected = useCallback(async (entry: VocabSettingsWriteEntry) => {
    const token = claim("journal");
    if (!token) return;
    try {
      const result = await removeCurrent(entry);
      if (result === "blocked") showAttention({ phase: "expected", entry, message: "出现了无法验证的跨页面提醒；这条收据仍保留。" });
      else if (result === "stale") reopenLatest(entry);
      else {
        setFlow({ phase: "idle" });
        setStatus("这次确定未写入的设置收据已经清除；原设置没有改变。");
      }
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({ phase: "expected", entry, message: "提醒没有安全清除；原设置没有改变。" });
    } finally {
      release(token);
    }
  }, [claim, release, removeCurrent, reopenLatest, showAttention]);

  const refreshCommitted = useCallback(async (entry: VocabSettingsWriteEntry) => {
    const token = claim("refresh");
    if (!token) return;
    await finishCommitted(entry, "设置已重新读取", token);
  }, [claim, finishCommitted]);

  const refreshChanged = useCallback(async (entry: VocabSettingsWriteEntry) => {
    const token = claim("refresh");
    if (!token) return;
    try {
      const outcome = await refresh();
      if (outcome !== "applied") {
        showAttention({ phase: "changed", entry, message: "当前设置还没有完整重新读取；旧收据继续保留。" });
        return;
      }
      const removal = await removeCurrent(entry);
      if (removal === "blocked") showAttention({ phase: "changed", entry, message: "页面已读取，但出现了无法验证的提醒；旧收据继续保留。" });
      else if (removal === "stale") reopenLatest(entry);
      else {
        setFlow({ phase: "idle" });
        setStatus("已经读取当前设置；旧内容没有覆盖或改写它。");
      }
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({ phase: "changed", entry, message: "当前设置尚未重新读取；旧收据继续保留。" });
    } finally {
      release(token);
    }
  }, [claim, refresh, release, removeCurrent, reopenLatest, showAttention]);

  const dismissInvalid = useCallback(async (entry: VocabSettingsWriteEntry) => {
    const token = claim("journal");
    if (!token) return;
    try {
      const result = await removeCurrent(entry);
      if (result === "stale") reopenLatest(entry);
      else if (result === "blocked") showAttention({ phase: "invalid", entry, message: "出现了无法验证的提醒；这条旧提醒仍保留。" });
      else setFlow({ phase: "idle" });
    } finally {
      release(token);
    }
  }, [claim, release, removeCurrent, reopenLatest, showAttention]);

  const clearUnreadable = useCallback(async () => {
    const token = claim("journal");
    if (!token) return;
    try {
      const current = reloadJournal();
      for (const entry of current.unreadable) {
        if (!await removeUnreadableVocabSettingsWrite(entry)) {
          throw new Error("另一页已经改动了一条无法验证的设置提醒。");
        }
      }
      reloadJournal();
      setFlow({ phase: "idle" });
      setStatus("无法验证的设置提醒已经清除；现有设置没有改变。");
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
    discardExpected,
    refreshCommitted,
    refreshChanged,
    dismissInvalid,
    clearUnreadable,
    recheckJournal: reloadJournal,
    operationInProgress: () => Boolean(operationRef.current),
  } as const;
}

type Controller = ReturnType<typeof useVocabSettingsWriteFlow>;

export function VocabSettingsWriteBanner({ controller }: { controller: Controller }) {
  const { journal, busy } = controller;
  if (!journal.loaded || (!journal.storageUnavailable && !journal.lockUnavailable && journal.entries.length === 0 && journal.unreadable.length === 0)) return null;
  const title = journal.storageUnavailable
    ? "设置核对线索暂时无法读取"
    : journal.lockUnavailable
      ? "这个浏览器可以读取词库，但暂不能安全改设置"
      : journal.unreadable.length > 0
        ? "有无法验证的设置提醒"
        : `有 ${journal.entries.length} 条设置写入待核对`;
  return <section className="sc-settings-write-banner" role="status">
    <div><b>{title}</b><p>文章、播客和词库仍可阅读；设置写入会保持停用，直到这里可以安全处理。</p></div>
    <button type="button" disabled={busy} onClick={() => controller.open()}>{journal.entries.length ? "打开下一条" : "查看安全说明"}</button>
  </section>;
}

function settingsReceiptText(receipt: VocabSettingsWriteReceipt): string {
  const settings = receipt.after.settings;
  return [
    "拾词设置",
    `默认显示简体中文说明：${settings.chinese_explanation ? "开启" : "关闭"}`,
    `正文字号：${Math.round(settings.font_scale * 100)}%`,
    `行间距：${settings.line_height.toFixed(2)}`,
    `本地锁：${settings.local_lock ? "开启" : "关闭"}`,
    `字幕自动跟随：${settings.auto_follow ? "开启" : "关闭"}`,
    `每日新词：${settings.daily_new_limit === 0 ? "暂停加入新词" : `${settings.daily_new_limit} 个`}`,
  ].join("\n");
}

export function VocabSettingsWriteRecovery({ controller }: { controller: Controller }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { flow, journal, busy, error, status, focusRequest } = controller;
  useEffect(() => {
    if (!focusRequest) return;
    const frame = window.requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);
  const entry = "entry" in flow ? flow.entry : null;
  const message = "message" in flow ? flow.message : "";
  const backendBlocked = journal.storageUnavailable || journal.lockUnavailable || journal.unreadable.length > 0;
  const title = journal.storageUnavailable
    ? "暂时无法查看设置核对线索"
    : journal.lockUnavailable
      ? "当前浏览器只读开放"
      : journal.unreadable.length > 0
        ? "有无法验证的设置提醒"
        : flow.phase === "working"
          ? "正在安全处理设置"
          : flow.phase === "expected"
            ? "这次确定还没有写入"
            : flow.phase === "changed"
              ? "当前设置已经变化"
              : flow.phase === "refresh-only"
                ? "保存事实已确认，页面待刷新"
                : flow.phase === "invalid"
                  ? "设置收据无法验证"
                  : entry ? "有一条设置写入待核对" : "设置写入安全说明";
  return <section className="sc-settings-write-recovery" aria-live="polite">
    <header><h2 ref={heading} tabIndex={-1}>{title}</h2><p>{flow.phase === "working"
      ? flow.action === "inspect" ? "正在只读核对结果…" : flow.action === "refresh" ? "正在重新读取页面…" : "正在安全处理，请保持此页打开…"
      : entry ? message
        : journal.lockUnavailable ? "缺少跨页面写入锁时，不会调用设置写入；已有词库仍可照常阅读。"
          : "重新检查只会读取页面与核对线索，不会自动提交设置。"}</p></header>
    {error && <p className="sc-settings-write-error" role="alert">{error}</p>}
    {status && <p className="sc-settings-write-status" role="status">{status}</p>}
    {entry && <details className="sc-settings-receipt" open={flow.phase === "changed"}>
      <summary>查看这次设置的完整内容</summary>
      <p>这里显示用户可读的六项设置，不包含内部操作标识、数据库世代、时间戳或校验值。</p>
      <pre>{settingsReceiptText(entry.ticket.receipt)}</pre>
    </details>}
    <footer>
      {(journal.storageUnavailable || journal.lockUnavailable) && <button type="button" disabled={busy} onClick={controller.recheckJournal}>重新检查</button>}
      {!journal.storageUnavailable && !journal.lockUnavailable && journal.unreadable.length > 0 && <button type="button" disabled={busy} onClick={() => void controller.clearUnreadable()}>保留设置并清除无法验证的提醒</button>}
      {entry && flow.phase === "check" && <button className="primary" type="button" disabled={busy || backendBlocked} onClick={() => void controller.inspect(entry)}>只读核对结果</button>}
      {entry && flow.phase === "expected" && <><button type="button" disabled={busy} onClick={() => void controller.discardExpected(entry)}>不保存并清除提醒</button><button className="primary" type="button" disabled={busy || backendBlocked} onClick={() => void controller.continueExpected(entry)}>继续保存同一份设置</button></>}
      {entry && flow.phase === "changed" && <button className="primary" type="button" disabled={busy} onClick={() => void controller.refreshChanged(entry)}>只读取当前设置并清除旧收据</button>}
      {entry && flow.phase === "refresh-only" && <button className="primary" type="button" disabled={busy} onClick={() => void controller.refreshCommitted(entry)}>只重新读取</button>}
      {entry && flow.phase === "invalid" && <button type="button" disabled={busy} onClick={() => void controller.dismissInvalid(entry)}>保留设置并清除提醒</button>}
    </footer>
  </section>;
}
