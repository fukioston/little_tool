"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getFitnessExercise } from "@/lib/fitness/catalog";
import {
  commitFitnessLiveWrite,
  commitFitnessLiveStructureWrite,
  inspectFitnessLiveWrite,
  inspectFitnessLiveStructureWrite,
  type FitnessLiveWriteReceipt,
} from "@/lib/fitness/store";
import {
  FITNESS_LIVE_WRITE_PREFIX,
  claimFitnessLiveWrite,
  createFitnessLiveWriteTicket,
  persistFitnessLiveWrite,
  readFitnessLiveWriteJournal,
  releaseFitnessLiveWrite,
  removeFitnessLiveWrite,
  runWithCurrentFitnessLiveWrite,
  type FitnessLiveWriteEntry,
  type FitnessLiveWriteJournal,
  type FitnessLiveWriteToken,
  type FitnessDurableLiveWriteReceipt,
} from "./live-write-journal";

type JournalView = FitnessLiveWriteJournal & Readonly<{ loaded: boolean }>;
const EMPTY_JOURNAL: JournalView = { loaded: false, entries: [], unreadable: [], unavailable: false };
type Action = "prepare" | "commit" | "inspect" | "refresh" | "journal";
export type FitnessLiveFlow =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "working"; action: Action }>
  | Readonly<{ phase: "check" | "expected" | "changed" | "refresh-only" | "reminder-only" | "invalid"; entry: FitnessLiveWriteEntry; message: string }>;

function reasonMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : "训练记录没有完成；现有事实没有被静默覆盖。";
}

function receiptLabel(receipt: FitnessDurableLiveWriteReceipt) {
  switch (receipt.kind) {
    case "set-record": return "这一条训练记录";
    case "set-undo": return "这一条撤销";
    case "session-finish": return "这场训练";
    case "session-cancel": return "误开的训练取消";
    case "session-start": return "这场训练的开始";
    case "exercise-add": return "这次新增动作";
    case "exercise-complete": return "这个动作的现场状态";
    case "exercise-substitute": return "这次现场替代";
    case "session-reflection": return "这段训练感受";
  }
}

function successCopy(receipt: FitnessDurableLiveWriteReceipt) {
  switch (receipt.kind) {
    case "set-record": return "这一条已经保存在本地";
    case "set-undo": return "这一条记录已经撤销";
    case "session-finish": return receipt.after.session.status === "ended_early" ? "已保存到这里" : "这场训练已保存";
    case "session-cancel": return receipt.before.event ? "已取消误开的训练，原安排仍可进行" : "已取消误开的临时训练，没有留下记录";
    case "session-start": return "训练已在本地开始";
    case "exercise-add": return "动作已加入这次训练";
    case "exercise-complete": {
      const target = receipt.after.exercises.find((exercise) =>
        (exercise.status === "completed" || exercise.status === "skipped") &&
        receipt.before.exercises.some((before) => before.id === exercise.id && before.status === "active"));
      return target?.status === "skipped" ? "已跳过这个动作，不会变成欠账" : "动作已保存到这里";
    }
    case "exercise-substitute": return "只调整了本次训练，未来计划没有改变";
    case "session-reflection": return "训练感受已保存在这条记录里";
  }
}

function nextView(receipt: FitnessDurableLiveWriteReceipt): "history" | "calendar" | "today" | null {
  if (receipt.kind === "session-finish") return "history";
  if (receipt.kind === "session-cancel") return receipt.before.event ? "calendar" : "today";
  return null;
}

export function useFitnessLiveWriteFlow({
  refresh,
  onToast,
  onAttention,
  onNavigate,
  onDurablePrepared,
  onDurableCommitted,
}: {
  refresh: () => Promise<"applied" | "deferred" | "superseded">;
  onToast: (message: string) => void;
  onAttention: () => void;
  onNavigate: (view: "history" | "calendar" | "today") => void;
  onDurablePrepared?: (receipt: FitnessDurableLiveWriteReceipt) => void;
  onDurableCommitted?: (receipt: FitnessDurableLiveWriteReceipt) => void;
}) {
  const [journal, setJournal] = useState<JournalView>(EMPTY_JOURNAL);
  const [flow, setFlow] = useState<FitnessLiveFlow>({ phase: "idle" });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [operationActive, setOperationActive] = useState(false);
  const operationRef = useRef<FitnessLiveWriteToken | null>(null);
  const mounted = useRef(false);
  const busy = operationActive;
  const writeLocked = !journal.loaded || journal.unavailable || journal.entries.length > 0 ||
    journal.unreadable.length > 0 || busy;

  const reloadJournal = useCallback(() => {
    let next: FitnessLiveWriteJournal;
    try { next = readFitnessLiveWriteJournal(); }
    catch { next = { entries: [], unreadable: [], unavailable: true }; }
    if (mounted.current) setJournal({ ...next, loaded: true });
    return next;
  }, []);

  const showAttention = useCallback((next: FitnessLiveFlow) => {
    setFlow(next);
    onAttention();
  }, [onAttention]);
  const claim = useCallback((action: Action) => {
    const token = claimFitnessLiveWrite(operationRef);
    if (token) { setOperationActive(true); setError(""); setFlow({ phase: "working", action }); }
    return token;
  }, []);
  const release = useCallback((token: FitnessLiveWriteToken) => {
    if (releaseFitnessLiveWrite(operationRef, token)) setOperationActive(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setTimeout(reloadJournal, 0);
    return () => { mounted.current = false; window.clearTimeout(timer); };
  }, [reloadJournal]);
  useEffect(() => {
    const reloadOnly = () => {
      reloadJournal();
      setStatus("已重新读取训练核对提醒；没有自动核对或写入。");
    };
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(FITNESS_LIVE_WRITE_PREFIX)) reloadOnly();
    };
    window.addEventListener("storage", storage);
    window.addEventListener("focus", reloadOnly);
    return () => {
      window.removeEventListener("storage", storage);
      window.removeEventListener("focus", reloadOnly);
    };
  }, [reloadJournal]);
  useEffect(() => {
    if (!busy) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [busy]);

  const reopenLatest = useCallback((entry: FitnessLiveWriteEntry) => {
    const latest = reloadJournal().entries.find((candidate) => candidate.storageKey === entry.storageKey);
    if (!latest) {
      setFlow({ phase: "idle" });
      setStatus("另一页已经处理了这条训练核对线索；这里只重新读取提醒。");
      return;
    }
    showAttention(latest.ticket.kind === "committed"
      ? { phase: "refresh-only", entry: latest, message: `${receiptLabel(latest.ticket.receipt)}已确认写入；只需重新读取。` }
      : { phase: "check", entry: latest, message: "另一页已经推进了这条线索；先只核对结果。" });
  }, [reloadJournal, showAttention]);

  const removeCurrent = useCallback(async (entry: FitnessLiveWriteEntry) => {
    const locked = await runWithCurrentFitnessLiveWrite(entry, (lease) => lease.remove());
    reloadJournal();
    return locked.outcome;
  }, [reloadJournal]);

  const finishCommitted = useCallback(async (entry: FitnessLiveWriteEntry, token: FitnessLiveWriteToken) => {
    setFlow({ phase: "working", action: "refresh" });
    onDurableCommitted?.(entry.ticket.receipt);
    try {
      const refreshOutcome = await refresh();
      if (refreshOutcome !== "applied") {
        showAttention({ phase: "refresh-only", entry, message: refreshOutcome === "deferred" ? `${receiptLabel(entry.ticket.receipt)}已确认写入；未提交的表单仍保留。请先明确保留或舍弃表单，再重新读取；回执不会提前清除。` : `${receiptLabel(entry.ticket.receipt)}已确认写入；这次读取已被更新的读取请求取代，回执仍保留。` });
        release(token);
        return "attention" as const;
      }
    } catch {
      showAttention({ phase: "refresh-only", entry, message: `${receiptLabel(entry.ticket.receipt)}已确认写入；页面尚未重新读取，请勿重复。` });
      release(token);
      return "attention" as const;
    }
    try {
      const removal = await removeCurrent(entry);
      if (removal === "blocked") {
        showAttention({ phase: "reminder-only", entry, message: "页面已更新；出现无法验证的同类提醒，所以这条提醒仍保留。" });
        return "attention" as const;
      }
      if (removal === "stale") {
        reopenLatest(entry);
        return "attention" as const;
      }
      setFlow({ phase: "idle" });
      const success = successCopy(entry.ticket.receipt);
      setStatus(success);
      onToast(success);
      const destination = nextView(entry.ticket.receipt);
      if (destination) onNavigate(destination);
      return "fresh" as const;
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({ phase: "reminder-only", entry, message: "页面已更新；只是提醒暂时没有收起，不需要再次写入。" });
      return "attention" as const;
    } finally {
      release(token);
    }
  }, [onDurableCommitted, onNavigate, onToast, refresh, release, removeCurrent, reopenLatest, showAttention]);

  const commitEntry = useCallback(async (entry: FitnessLiveWriteEntry, token: FitnessLiveWriteToken) => {
    setFlow({ phase: "working", action: "commit" });
    try {
      const locked = await runWithCurrentFitnessLiveWrite(entry, async (lease) => {
        const result = entry.ticket.receipt.purpose === "fitness-live-structure-write"
          ? await commitFitnessLiveStructureWrite(entry.ticket.receipt)
          : await commitFitnessLiveWrite(entry.ticket.receipt);
        if (result.outcome === "saved" || result.outcome === "already_saved") lease.committed();
        return result;
      });
      if (locked.outcome === "blocked") {
        reloadJournal();
        showAttention({ phase: "expected", entry, message: "训练核对线索无法完整验证；没有调用写入。" });
        setError("没有调用训练写入；现有事实没有改变。");
        release(token);
        return "attention" as const;
      }
      if (locked.outcome === "stale") {
        reopenLatest(entry); release(token); return "attention" as const;
      }
      if (locked.value.outcome === "outcome_uncertain") {
        showAttention({ phase: "check", entry, message: "写入结果暂时无法确认；下一步只核对，不会重复写入。" });
        release(token); return "attention" as const;
      }
      if (locked.value.outcome === "changed") {
        showAttention({ phase: "changed", entry, message: "训练现场已经变化；这张旧回执没有覆盖当前事实。" });
        release(token); return "attention" as const;
      }
      if (!locked.entry) throw new Error("训练已写入，但刷新线索没有保留。");
      reloadJournal();
      return finishCommitted(locked.entry, token);
    } catch (reason) {
      showAttention({ phase: "check", entry, message: "写入结果需要核对；核对不会重复保存。" });
      setError(`${reasonMessage(reason)} 回执仍保留。`);
      release(token);
      return "attention" as const;
    }
  }, [finishCommitted, release, reloadJournal, reopenLatest, showAttention]);

  const start = useCallback(async (prepare: () => Promise<FitnessDurableLiveWriteReceipt>) => {
    const token = claim("prepare");
    if (!token) return "attention" as const;
    let entry: FitnessLiveWriteEntry | null = null;
    try {
      const current = reloadJournal();
      if (current.unavailable) throw new Error("无法安全保留跨页面核对线索；没有开始写入。");
      if (current.unreadable.length) throw new Error("先处理无法验证的训练提醒；没有开始写入。");
      if (current.entries.length) throw new Error("先处理上一条训练写入；没有开始新的写入。");
      const receipt = await prepare();
      entry = await persistFitnessLiveWrite(createFitnessLiveWriteTicket(receipt));
      onDurablePrepared?.(receipt);
      reloadJournal();
      return await commitEntry(entry, token);
    } catch (reason) {
      if (entry) {
        showAttention({ phase: "check", entry, message: "写入结果需要核对；核对不会重复保存。" });
        setError(`${reasonMessage(reason)} 回执仍保留。`);
        release(token);
        return "attention" as const;
      }
      setFlow({ phase: "idle" }); release(token); throw reason;
    }
  }, [claim, commitEntry, onDurablePrepared, release, reloadJournal, showAttention]);

  const open = useCallback((entry?: FitnessLiveWriteEntry) => {
    if (operationRef.current) return;
    const next = entry ?? reloadJournal().entries[0] ?? null;
    setError("");
    if (!next) { setFlow({ phase: "idle" }); onAttention(); return; }
    showAttention(next.ticket.kind === "committed"
      ? { phase: "refresh-only", entry: next, message: `${receiptLabel(next.ticket.receipt)}已确认写入；只重新读取。` }
      : { phase: "check", entry: next, message: "这条训练写入尚未确认；先只核对结果。" });
  }, [onAttention, reloadJournal, showAttention]);

  const recheckJournal = useCallback(() => {
    if (operationRef.current) return;
    reloadJournal();
  }, [reloadJournal]);
  const operationInProgress = useCallback(() => operationRef.current !== null, []);

  const inspect = useCallback(async (entry: FitnessLiveWriteEntry) => {
    const token = claim("inspect");
    if (!token) return;
    try {
      const locked = await runWithCurrentFitnessLiveWrite(entry, async (lease) => {
        const result = entry.ticket.receipt.purpose === "fitness-live-structure-write"
          ? await inspectFitnessLiveStructureWrite(entry.ticket.receipt)
          : await inspectFitnessLiveWrite(entry.ticket.receipt);
        if (result === "exact_saved") lease.committed();
        return result;
      });
      if (locked.outcome === "blocked") {
        reloadJournal(); showAttention({ phase: "check", entry, message: "核对线索无法完整验证；没有调用结果核对。" }); return;
      }
      if (locked.outcome === "stale") { reopenLatest(entry); return; }
      if (locked.value === "exact_saved") {
        if (!locked.entry) throw new Error("保存事实已确认，但刷新线索没有保留。");
        reloadJournal(); await finishCommitted(locked.entry, token); return;
      }
      if (locked.value === "expected") { showAttention({ phase: "expected", entry, message: "这次确定还没有写入。只有明确继续才会使用同一张回执。" }); return; }
      if (locked.value === "changed") { showAttention({ phase: "changed", entry, message: "当前训练事实已经变化；旧回执没有覆盖，也不能再写入。" }); return; }
      if (locked.value === "invalid_receipt") { showAttention({ phase: "invalid", entry, message: "这张回执无法验证；系统没有据此写入。" }); return; }
      showAttention({ phase: "check", entry, message: "现在仍无法确认；可以稍后再次只核对。" });
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({ phase: "check", entry, message: "现在仍无法确认；可以稍后再次只核对。" });
    } finally { release(token); }
  }, [claim, finishCommitted, release, reloadJournal, reopenLatest, showAttention]);

  const continueExpected = useCallback(async (entry: FitnessLiveWriteEntry) => {
    const token = claim("commit"); if (token) await commitEntry(entry, token);
  }, [claim, commitEntry]);
  const refreshCommitted = useCallback(async (entry: FitnessLiveWriteEntry) => {
    const token = claim("refresh"); if (token) await finishCommitted(entry, token);
  }, [claim, finishCommitted]);

  const clearEntry = useCallback(async (entry: FitnessLiveWriteEntry, phase: "expected" | "changed" | "reminder-only" | "invalid", refreshFirst: boolean) => {
    const token = claim(refreshFirst ? "refresh" : "journal");
    if (!token) return;
    try {
      if (refreshFirst) {
        const refreshOutcome = await refresh();
        if (refreshOutcome !== "applied") {
          showAttention({ phase, entry, message: refreshOutcome === "deferred" ? "未提交的表单仍保留；请先明确保留或舍弃，再重新读取。旧回执没有清除。" : "这次读取已被更新的读取请求取代；旧回执没有清除。" });
          return;
        }
      }
      const removal = await removeCurrent(entry);
      if (removal === "stale") { reopenLatest(entry); return; }
      if (removal === "blocked") { showAttention({ phase, entry, message: "出现无法验证的同类提醒；这张回执仍保留。" }); return; }
      setFlow({ phase: "idle" });
      setStatus(refreshFirst ? "已重新读取当前训练事实；旧回执没有覆盖。" : "提醒已清除；现有训练事实没有再次改变。");
    } catch (reason) {
      setError(reasonMessage(reason)); showAttention({ phase, entry, message: "操作没有完成；回执仍保留。" });
    } finally { release(token); }
  }, [claim, refresh, release, removeCurrent, reopenLatest, showAttention]);

  const clearUnreadable = useCallback(async () => {
    const token = claim("journal"); if (!token) return;
    try {
      const current = reloadJournal();
      for (const entry of current.unreadable) if (!await removeFitnessLiveWrite(entry)) throw new Error("另一页已改动提醒。");
      reloadJournal(); setStatus("无法验证的提醒已清除；现有训练事实没有改变。"); setFlow({ phase: "idle" });
    } catch (reason) { setError(reasonMessage(reason)); }
    finally { release(token); }
  }, [claim, release, reloadJournal]);

  return {
    journal, flow, busy, writeLocked, status, error, start, open, inspect, continueExpected,
    operationInProgress,
    refreshCommitted,
    discardExpected: (entry: FitnessLiveWriteEntry) => clearEntry(entry, "expected", false),
    refreshChanged: (entry: FitnessLiveWriteEntry) => clearEntry(entry, "changed", true),
    dismissReminder: (entry: FitnessLiveWriteEntry, invalid = false) => clearEntry(entry, invalid ? "invalid" : "reminder-only", false),
    clearUnreadable,
    recheckJournal,
  } as const;
}

export type FitnessLiveWriteController = ReturnType<typeof useFitnessLiveWriteFlow>;

export function FitnessLiveWriteBanner({ controller }: { controller: FitnessLiveWriteController }) {
  const { journal } = controller;
  if (!journal.loaded || (!journal.unavailable && journal.entries.length === 0 && journal.unreadable.length === 0)) return null;
  return <section className="sl-live-write-banner" role="status" aria-live="polite"><div><b>{journal.unavailable ? "训练核对线索暂时不可用" : journal.entries.length ? `有 ${journal.entries.length} 条训练写入待核对` : "有无法验证的训练提醒"}</b><p>不会自动重写、核对或把训练变成欠账；由你打开后决定下一步。</p></div><button type="button" disabled={controller.busy} onClick={() => controller.open()}>{controller.busy ? "正在安全处理…" : journal.entries.length ? "打开下一条" : "查看安全说明"}</button></section>;
}

function receiptSummary(receipt: FitnessDurableLiveWriteReceipt) {
  const exerciseText = (id: string) => {
    const exercise = getFitnessExercise(id);
    return exercise ? `${exercise.name_zh}（${exercise.name_en}）` : `当前版本不识别的动作标识：${id}`;
  };
  const loadText = (grams: number | null) => grams === null
    ? "未记录"
    : grams >= 1_000
      ? `${Number((grams / 1_000).toFixed(3))} 千克`
      : `${grams} 克`;
  const setText = (set: FitnessLiveWriteReceipt["before"]["sets"][number]) =>
    `组序号：${set.set_index + 1}\n重量：${loadText(set.load_grams)}\n次数：${set.reps ?? "未记录"}\n时长：${set.duration_seconds ?? "未记录"} 秒\nRIR：${set.rir ?? "未记录"}\nRPE：${set.rpe ?? "未记录"}\n不适原文：${set.pain_note || "未填写"}`;
  if (receipt.kind === "set-record") {
    const added = receipt.after.sets.find((set) => !receipt.before.sets.some(({ id }) => id === set.id));
    return added ? setText(added) : "这张回执没有可显示的新增组。";
  }
  if (receipt.kind === "set-undo") {
    const removed = receipt.before.sets.find((set) => !receipt.after.sets.some(({ id }) => id === set.id));
    return removed ? `撤销的记录\n${setText(removed)}` : "这张回执没有可显示的撤销记录。";
  }
  if (receipt.kind === "session-finish") return `结束方式：${receipt.after.session.status === "ended_early" ? "保存到这里" : "正常结束"}\n实际组记录：${receipt.after.sets.length} 条\n训练感受：${receipt.after.session.reflection || "未填写"}`;
  if (receipt.kind === "session-cancel") return `取消误开的训练\n原日历安排：${receipt.before.event ? "回到待进行" : "没有关联安排"}\n不会留下训练记录。`;
  if (receipt.kind === "session-start") return `开始场地：${receipt.context.venue.name}\n计划动作：${receipt.after.exercises.length} 个\n可用时长：${receipt.after.session.available_minutes === null ? "未限定" : `${receipt.after.session.available_minutes} 分钟`}`;
  if (receipt.kind === "exercise-add") {
    const added = receipt.after.exercises.find((exercise) => !receipt.before.exercises.some(({ id }) => id === exercise.id));
    return `新增动作：${added ? exerciseText(added.exercise_id) : "未识别"}\n只加入这次训练，不修改未来计划。`;
  }
  if (receipt.kind === "exercise-complete") {
    const changed = receipt.after.exercises.find((exercise) =>
      (exercise.status === "completed" || exercise.status === "skipped") &&
      receipt.before.exercises.some((before) => before.id === exercise.id && before.status === "active"));
    return `动作：${changed ? exerciseText(changed.exercise_id) : "未识别"}\n现场状态：${changed?.status === "skipped" ? "这次不做" : "完成到这里"}\n已有组记录：${changed ? receipt.after.sets.filter((set) => set.session_exercise_id === changed.id).length : 0} 条`;
  }
  if (receipt.kind === "exercise-substitute") {
    const changed = receipt.after.exercises.find((exercise) => {
      const before = receipt.before.exercises.find(({ id }) => id === exercise.id);
      return before && before.exercise_id !== exercise.exercise_id;
    });
    const before = changed ? receipt.before.exercises.find(({ id }) => id === changed.id) : null;
    return `原动作：${before ? exerciseText(before.exercise_id) : "未识别"}\n现场替代：${changed ? exerciseText(changed.exercise_id) : "未识别"}\n原因：${changed?.substitution_reason || "现场调整"}`;
  }
  return `训练感受\n${receipt.after.reflection || "留空"}`;
}

export function FitnessLiveWriteRecovery({ controller }: { controller: FitnessLiveWriteController }) {
  const { flow, journal, busy, error, status } = controller;
  const entry = "entry" in flow ? flow.entry : null;
  const blocked = journal.unavailable || journal.unreadable.length > 0;
  return <section className="sl-live-write-recovery" aria-busy={busy}>
    <header><b>{flow.phase === "working" ? "正在安全处理" : entry ? `${receiptLabel(entry.ticket.receipt)}需要核对` : "训练写入核对"}</b><p>{"message" in flow ? flow.message : journal.unavailable ? "当前浏览器无法安全协调跨页面线索。" : journal.unreadable.length ? "有无法验证的提醒；没有据此写入。" : "当前没有待处理写入。"}</p></header>
    {entry && flow.phase !== "invalid" && <details><summary>查看这张回执记录的内容</summary><pre>{receiptSummary(entry.ticket.receipt)}</pre></details>}
    {error && <p className="sl-form-error" role="alert">{error}</p>}{status && <p className="sl-data-status" role="status">{status}</p>}
    <footer>
      {journal.unavailable && <button type="button" disabled={busy} onClick={controller.recheckJournal}>重新检查</button>}
      {!journal.unavailable && journal.unreadable.length > 0 && <button type="button" disabled={busy} onClick={() => void controller.clearUnreadable()}>保留训练事实并清除提醒</button>}
      {entry && flow.phase === "check" && <button className="sl-primary" type="button" disabled={busy || blocked} onClick={() => void controller.inspect(entry)}>只核对结果</button>}
      {entry && flow.phase === "expected" && <><button type="button" disabled={busy} onClick={() => void controller.discardExpected(entry)}>不写入并清除回执</button><button className="sl-primary" type="button" disabled={busy || blocked} onClick={() => void controller.continueExpected(entry)}>继续同一份写入</button></>}
      {entry && flow.phase === "changed" && <button type="button" disabled={busy} onClick={() => void controller.refreshChanged(entry)}>放弃旧回执并只重新读取</button>}
      {entry && flow.phase === "refresh-only" && <button className="sl-primary" type="button" disabled={busy} onClick={() => void controller.refreshCommitted(entry)}>只重新读取</button>}
      {entry && (flow.phase === "reminder-only" || flow.phase === "invalid") && <button type="button" disabled={busy} onClick={() => void controller.dismissReminder(entry, flow.phase === "invalid")}>保留事实并清除提醒</button>}
    </footer>
  </section>;
}
