"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getFitnessExercise } from "@/lib/fitness/catalog";
import {
  commitFitnessCalendarWrite,
  commitFitnessProgramWrite,
  inspectFitnessCalendarWrite,
  inspectFitnessProgramWrite,
} from "@/lib/fitness/store";
import {
  FITNESS_PLAN_CALENDAR_WRITE_PREFIX,
  claimFitnessPlanCalendarWrite,
  createFitnessPlanCalendarWriteTicket,
  persistFitnessPlanCalendarWrite,
  readFitnessPlanCalendarWriteJournal,
  releaseFitnessPlanCalendarWrite,
  removeFitnessPlanCalendarWrite,
  runWithCurrentFitnessPlanCalendarWrite,
  type FitnessPlanCalendarWriteEntry,
  type FitnessPlanCalendarWriteJournal,
  type FitnessPlanCalendarWriteReceipt,
  type FitnessPlanCalendarWriteToken,
} from "./plan-calendar-write-journal";

type JournalView = FitnessPlanCalendarWriteJournal & Readonly<{ loaded: boolean }>;
const EMPTY_JOURNAL: JournalView = {
  loaded: false,
  entries: [],
  unreadable: [],
  unavailable: false,
};
type Action = "prepare" | "commit" | "inspect" | "refresh" | "journal";
export type FitnessPlanCalendarFlow =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "working"; action: Action }>
  | Readonly<{
      phase: "check" | "expected" | "changed" | "refresh-only" | "reminder-only" | "invalid";
      entry: FitnessPlanCalendarWriteEntry;
      message: string;
    }>;

function reasonMessage(reason: unknown) {
  return reason instanceof Error
    ? reason.message
    : "计划或日历操作没有完成；现有安排没有被静默覆盖。";
}

function receiptLabel(receipt: FitnessPlanCalendarWriteReceipt) {
  switch (receipt.kind) {
    case "program-version-schedule": return "这版计划与首周安排";
    case "program-week-schedule": return "这一周的计划安排";
    case "calendar-reschedule": return "这次日历改期";
    case "calendar-not-performed": return "这次未进行标记";
  }
}

function successCopy(receipt: FitnessPlanCalendarWriteReceipt) {
  switch (receipt.kind) {
    case "program-version-schedule": return "计划已保存为新版本并放入日历";
    case "program-week-schedule": return receipt.after.createdEventIds.length
      ? "这一周已放入日历；随时可以改期或不进行"
      : "这一周原本已在日历中，没有重复安排";
    case "calendar-reschedule": return "已改期；原来的训练没有被算作失败";
    case "calendar-not-performed": return "已记为这次未进行；其他安排没有改变";
  }
}

function nextView(receipt: FitnessPlanCalendarWriteReceipt): "plan" | "calendar" {
  return receipt.purpose === "fitness-program-write" ? "plan" : "calendar";
}

export function useFitnessPlanCalendarWriteFlow({
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
  onNavigate: (
    view: "plan" | "calendar",
    receipt: FitnessPlanCalendarWriteReceipt,
  ) => void;
  onDurablePrepared?: (receipt: FitnessPlanCalendarWriteReceipt) => void;
  onDurableCommitted?: (receipt: FitnessPlanCalendarWriteReceipt) => void;
}) {
  const [journal, setJournal] = useState<JournalView>(EMPTY_JOURNAL);
  const [flow, setFlow] = useState<FitnessPlanCalendarFlow>({ phase: "idle" });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [operationActive, setOperationActive] = useState(false);
  const operationRef = useRef<FitnessPlanCalendarWriteToken | null>(null);
  const mounted = useRef(false);
  const busy = operationActive;
  const writeLocked = !journal.loaded || journal.unavailable || journal.entries.length > 0 ||
    journal.unreadable.length > 0 || busy;

  const reloadJournal = useCallback(() => {
    let next: FitnessPlanCalendarWriteJournal;
    try { next = readFitnessPlanCalendarWriteJournal(); }
    catch { next = { entries: [], unreadable: [], unavailable: true }; }
    if (mounted.current) setJournal({ ...next, loaded: true });
    return next;
  }, []);

  const showAttention = useCallback((next: FitnessPlanCalendarFlow) => {
    setFlow(next);
    onAttention();
  }, [onAttention]);
  const claim = useCallback((action: Action) => {
    const token = claimFitnessPlanCalendarWrite(operationRef);
    if (token) {
      setOperationActive(true);
      setError("");
      setFlow({ phase: "working", action });
    }
    return token;
  }, []);
  const release = useCallback((token: FitnessPlanCalendarWriteToken) => {
    if (releaseFitnessPlanCalendarWrite(operationRef, token)) setOperationActive(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setTimeout(reloadJournal, 0);
    return () => { mounted.current = false; window.clearTimeout(timer); };
  }, [reloadJournal]);
  useEffect(() => {
    const reloadOnly = () => {
      reloadJournal();
      setStatus("已重新读取计划与日历核对提醒；没有自动核对或写入。");
    };
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(FITNESS_PLAN_CALENDAR_WRITE_PREFIX)) {
        reloadOnly();
      }
    };
    const visible = () => {
      if (document.visibilityState === "visible") reloadOnly();
    };
    window.addEventListener("storage", storage);
    window.addEventListener("focus", reloadOnly);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("storage", storage);
      window.removeEventListener("focus", reloadOnly);
      document.removeEventListener("visibilitychange", visible);
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

  const reopenLatest = useCallback((entry: FitnessPlanCalendarWriteEntry) => {
    const latest = reloadJournal().entries.find(({ storageKey }) => storageKey === entry.storageKey);
    if (!latest) {
      setFlow({ phase: "idle" });
      setStatus("另一页已经处理了这条核对线索；这里只重新读取提醒。");
      return;
    }
    showAttention(latest.ticket.kind === "committed"
      ? {
          phase: "refresh-only",
          entry: latest,
          message: `${receiptLabel(latest.ticket.receipt)}已确认写入；只需重新读取。`,
        }
      : {
          phase: "check",
          entry: latest,
          message: "另一页已经推进了这条线索；先只核对结果。",
        });
  }, [reloadJournal, showAttention]);

  const removeCurrent = useCallback(async (entry: FitnessPlanCalendarWriteEntry) => {
    const locked = await runWithCurrentFitnessPlanCalendarWrite(entry, (lease) => lease.remove());
    reloadJournal();
    return locked.outcome;
  }, [reloadJournal]);

  const finishCommitted = useCallback(async (
    entry: FitnessPlanCalendarWriteEntry,
    token: FitnessPlanCalendarWriteToken,
  ) => {
    setFlow({ phase: "working", action: "refresh" });
    onDurableCommitted?.(entry.ticket.receipt);
    try {
      const refreshOutcome = await refresh();
      if (refreshOutcome !== "applied") {
        showAttention({
          phase: "refresh-only",
          entry,
          message: refreshOutcome === "deferred"
            ? `${receiptLabel(entry.ticket.receipt)}已确认写入；未提交的表单仍保留。请先明确保留或舍弃，再重新读取；回执不会提前清除。`
            : `${receiptLabel(entry.ticket.receipt)}已确认写入；这次读取被更新的请求取代，回执仍保留。`,
        });
        release(token);
        return "attention" as const;
      }
    } catch {
      showAttention({
        phase: "refresh-only",
        entry,
        message: `${receiptLabel(entry.ticket.receipt)}已确认写入；页面尚未重新读取，请勿重复。`,
      });
      release(token);
      return "attention" as const;
    }
    try {
      const removal = await removeCurrent(entry);
      if (removal === "blocked") {
        showAttention({
          phase: "reminder-only",
          entry,
          message: "页面已更新；出现无法验证的同类提醒，所以这条提醒仍保留。",
        });
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
      onNavigate(nextView(entry.ticket.receipt), entry.ticket.receipt);
      return "fresh" as const;
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({
        phase: "reminder-only",
        entry,
        message: "页面已更新；只是提醒暂时没有收起，不需要再次写入。",
      });
      return "attention" as const;
    } finally {
      release(token);
    }
  }, [onDurableCommitted, onNavigate, onToast, refresh, release, removeCurrent, reopenLatest, showAttention]);

  const commitEntry = useCallback(async (
    entry: FitnessPlanCalendarWriteEntry,
    token: FitnessPlanCalendarWriteToken,
  ) => {
    setFlow({ phase: "working", action: "commit" });
    try {
      const locked = await runWithCurrentFitnessPlanCalendarWrite(entry, async (lease) => {
        const result = entry.ticket.receipt.purpose === "fitness-program-write"
          ? await commitFitnessProgramWrite(entry.ticket.receipt)
          : await commitFitnessCalendarWrite(entry.ticket.receipt);
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
          message: "核对线索无法完整验证；没有调用写入。",
        });
        setError("没有调用计划或日历写入；现有安排没有改变。");
        release(token);
        return "attention" as const;
      }
      if (locked.outcome === "stale") {
        reopenLatest(entry);
        release(token);
        return "attention" as const;
      }
      if (locked.value.outcome === "outcome_uncertain") {
        showAttention({
          phase: "check",
          entry,
          message: "写入结果暂时无法确认；下一步只核对，不会重复写入。",
        });
        release(token);
        return "attention" as const;
      }
      if (locked.value.outcome === "changed") {
        showAttention({
          phase: "changed",
          entry,
          message: "计划或日历事实已经变化；这张旧回执没有覆盖当前安排。",
        });
        release(token);
        return "attention" as const;
      }
      if (!locked.entry) throw new Error("写入已确认，但刷新线索没有保留。");
      reloadJournal();
      return finishCommitted(locked.entry, token);
    } catch (reason) {
      showAttention({
        phase: "check",
        entry,
        message: "写入结果需要核对；核对不会重复保存。",
      });
      setError(`${reasonMessage(reason)} 回执仍保留。`);
      release(token);
      return "attention" as const;
    }
  }, [finishCommitted, release, reloadJournal, reopenLatest, showAttention]);

  const start = useCallback(async (
    prepare: () => Promise<FitnessPlanCalendarWriteReceipt>,
  ) => {
    const token = claim("prepare");
    if (!token) return "attention" as const;
    let entry: FitnessPlanCalendarWriteEntry | null = null;
    try {
      const current = reloadJournal();
      if (current.unavailable) {
        throw new Error("无法安全保留跨页面核对线索；没有开始写入。");
      }
      if (current.unreadable.length) {
        throw new Error("先处理无法验证的计划或日历提醒；没有开始写入。");
      }
      if (current.entries.length) {
        throw new Error("先处理上一条计划或日历写入；没有开始新的写入。");
      }
      const receipt = await prepare();
      entry = await persistFitnessPlanCalendarWrite(
        createFitnessPlanCalendarWriteTicket(receipt),
      );
      onDurablePrepared?.(receipt);
      reloadJournal();
      return await commitEntry(entry, token);
    } catch (reason) {
      if (entry) {
        showAttention({
          phase: "check",
          entry,
          message: "写入结果需要核对；核对不会重复保存。",
        });
        setError(`${reasonMessage(reason)} 回执仍保留。`);
        release(token);
        return "attention" as const;
      }
      setFlow({ phase: "idle" });
      release(token);
      throw reason;
    }
  }, [claim, commitEntry, onDurablePrepared, release, reloadJournal, showAttention]);

  const open = useCallback((entry?: FitnessPlanCalendarWriteEntry) => {
    if (operationRef.current) return;
    const next = entry ?? reloadJournal().entries[0] ?? null;
    setError("");
    if (!next) {
      setFlow({ phase: "idle" });
      onAttention();
      return;
    }
    showAttention(next.ticket.kind === "committed"
      ? {
          phase: "refresh-only",
          entry: next,
          message: `${receiptLabel(next.ticket.receipt)}已确认写入；只重新读取。`,
        }
      : {
          phase: "check",
          entry: next,
          message: "这条计划或日历写入尚未确认；先只核对结果。",
        });
  }, [onAttention, reloadJournal, showAttention]);

  const recheckJournal = useCallback(() => {
    if (!operationRef.current) reloadJournal();
  }, [reloadJournal]);
  const operationInProgress = useCallback(() => operationRef.current !== null, []);

  const inspect = useCallback(async (entry: FitnessPlanCalendarWriteEntry) => {
    const token = claim("inspect");
    if (!token) return;
    try {
      const locked = await runWithCurrentFitnessPlanCalendarWrite(entry, async (lease) => {
        const result = entry.ticket.receipt.purpose === "fitness-program-write"
          ? await inspectFitnessProgramWrite(entry.ticket.receipt)
          : await inspectFitnessCalendarWrite(entry.ticket.receipt);
        if (result === "exact_saved") lease.committed();
        return result;
      });
      if (locked.outcome === "blocked") {
        reloadJournal();
        showAttention({
          phase: "check",
          entry,
          message: "核对线索无法完整验证；没有调用结果核对。",
        });
        return;
      }
      if (locked.outcome === "stale") {
        reopenLatest(entry);
        return;
      }
      if (locked.value === "exact_saved") {
        if (!locked.entry) throw new Error("保存事实已确认，但刷新线索没有保留。");
        reloadJournal();
        await finishCommitted(locked.entry, token);
        return;
      }
      if (locked.value === "expected") {
        showAttention({
          phase: "expected",
          entry,
          message: "这次确定还没有写入。只有明确继续才会使用同一张回执。",
        });
        return;
      }
      if (locked.value === "changed") {
        showAttention({
          phase: "changed",
          entry,
          message: "当前计划或日历事实已经变化；旧回执没有覆盖，也不能再写入。",
        });
        return;
      }
      if (locked.value === "invalid_receipt") {
        showAttention({
          phase: "invalid",
          entry,
          message: "这张回执无法验证；系统没有据此写入。",
        });
        return;
      }
      showAttention({
        phase: "check",
        entry,
        message: "现在仍无法确认；可以稍后再次只核对。",
      });
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({
        phase: "check",
        entry,
        message: "现在仍无法确认；可以稍后再次只核对。",
      });
    } finally {
      release(token);
    }
  }, [claim, finishCommitted, release, reloadJournal, reopenLatest, showAttention]);

  const continueExpected = useCallback(async (entry: FitnessPlanCalendarWriteEntry) => {
    const token = claim("commit");
    if (token) await commitEntry(entry, token);
  }, [claim, commitEntry]);
  const refreshCommitted = useCallback(async (entry: FitnessPlanCalendarWriteEntry) => {
    const token = claim("refresh");
    if (token) await finishCommitted(entry, token);
  }, [claim, finishCommitted]);

  const clearEntry = useCallback(async (
    entry: FitnessPlanCalendarWriteEntry,
    phase: "expected" | "changed" | "reminder-only" | "invalid",
    refreshFirst: boolean,
  ) => {
    const token = claim(refreshFirst ? "refresh" : "journal");
    if (!token) return;
    try {
      if (refreshFirst) {
        const refreshOutcome = await refresh();
        if (refreshOutcome !== "applied") {
          showAttention({
            phase,
            entry,
            message: refreshOutcome === "deferred"
              ? "未提交的表单仍保留；请先明确保留或舍弃，再重新读取。旧回执没有清除。"
              : "这次读取被更新的请求取代；旧回执没有清除。",
          });
          return;
        }
      }
      const removal = await removeCurrent(entry);
      if (removal === "stale") {
        reopenLatest(entry);
        return;
      }
      if (removal === "blocked") {
        showAttention({ phase, entry, message: "出现无法验证的同类提醒；这张回执仍保留。" });
        return;
      }
      setFlow({ phase: "idle" });
      setStatus(refreshFirst
        ? "已重新读取当前计划与日历；旧回执没有覆盖。"
        : "提醒已清除；现有计划与日历没有再次改变。");
    } catch (reason) {
      setError(reasonMessage(reason));
      showAttention({ phase, entry, message: "操作没有完成；回执仍保留。" });
    } finally {
      release(token);
    }
  }, [claim, refresh, release, removeCurrent, reopenLatest, showAttention]);

  const clearUnreadable = useCallback(async () => {
    const token = claim("journal");
    if (!token) return;
    try {
      const current = reloadJournal();
      for (const entry of current.unreadable) {
        if (!await removeFitnessPlanCalendarWrite(entry)) {
          throw new Error("另一页已改动提醒。");
        }
      }
      reloadJournal();
      setStatus("无法验证的提醒已清除；现有计划与日历没有改变。");
      setFlow({ phase: "idle" });
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
    start,
    open,
    inspect,
    continueExpected,
    operationInProgress,
    refreshCommitted,
    discardExpected: (entry: FitnessPlanCalendarWriteEntry) =>
      clearEntry(entry, "expected", false),
    refreshChanged: (entry: FitnessPlanCalendarWriteEntry) =>
      clearEntry(entry, "changed", true),
    dismissReminder: (entry: FitnessPlanCalendarWriteEntry, invalid = false) =>
      clearEntry(entry, invalid ? "invalid" : "reminder-only", false),
    clearUnreadable,
    recheckJournal,
  } as const;
}

export type FitnessPlanCalendarWriteController =
  ReturnType<typeof useFitnessPlanCalendarWriteFlow>;

export function FitnessPlanCalendarWriteBanner({
  controller,
}: {
  controller: FitnessPlanCalendarWriteController;
}) {
  const { journal } = controller;
  if (!journal.loaded || (!journal.unavailable && journal.entries.length === 0 &&
      journal.unreadable.length === 0)) return null;
  return <section className="sl-plan-calendar-write-banner" role="status" aria-live="polite">
    <div><b>{journal.unavailable
      ? "计划与日历核对线索暂时不可用"
      : journal.entries.length
        ? `有 ${journal.entries.length} 条计划或日历写入待核对`
        : "有无法验证的计划或日历提醒"}</b><p>不会自动核对、重放或移动安排；由你打开后决定下一步。</p></div>
    <button type="button" disabled={controller.busy} onClick={() => controller.open()}>{controller.busy
      ? "正在安全处理…"
      : journal.entries.length ? "打开下一条" : "查看安全说明"}</button>
  </section>;
}

function receiptSummary(receipt: FitnessPlanCalendarWriteReceipt) {
  const dateTime = (value: number, timeZone?: string) => new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(value));
  const kindText = (kind: "resistance" | "cardio" | "rest" | "note") =>
    kind === "resistance" ? "力量" : kind === "cardio" ? "心肺" : kind === "rest" ? "休息" : "提醒";
  const exerciseText = (id: string) => {
    const exercise = getFitnessExercise(id);
    return exercise
      ? `${exercise.name_zh}（${exercise.name_en}）`
      : `当前版本不识别的动作标识：${id}`;
  };
  const goalText: Record<string, string> = {
    strength: "力量",
    muscle: "增肌",
    cardio: "心肺",
    general_health: "一般健康",
    sport: "运动专项",
    mobility: "活动度",
  };
  const splitText: Record<string, string> = {
    auto: "根据频次安排",
    full_body: "全身",
    upper_lower: "上下肢",
    push_pull_legs: "推拉腿",
    custom: "自定义",
  };
  if (receipt.kind === "program-version-schedule") {
    const days = receipt.request.draft.days.map((day, dayIndex) => {
      const items = day.items.map((item, index) =>
        `  ${index + 1}. ${exerciseText(item.exercise_id)}；${item.sets} 组；${item.rep_min ?? "计时"}${item.rep_max && item.rep_max !== item.rep_min ? `–${item.rep_max}` : ""}；${item.load_guidance}`).join("\n");
      return `${day.weekday === null ? `第 ${dayIndex + 1} 天` : `星期${"日一二三四五六"[day.weekday]}`}：${day.name}（${kindText(day.kind)}，约 ${day.estimated_minutes} 分钟）${items ? `\n${items}` : ""}`;
    }).join("\n");
    const events = receipt.after.events.map((event) =>
      `${dateTime(event.starts_at, receipt.request.scheduleTimeZone)} · ${event.title} · 约 ${event.planned_minutes} 分钟`).join("\n");
    return `计划名称：${receipt.request.draft.name}\n场地：${receipt.before.venue.name}\n目标：${goalText[receipt.request.draft.goal] ?? receipt.request.draft.goal}\n分化：${splitText[receipt.request.draft.split] ?? receipt.request.draft.split}\n新版本：V${receipt.after.program.version}\n排期时区：${receipt.request.scheduleTimeZone}\n首周安排：${receipt.after.events.length} 条${events ? `\n${events}` : ""}\n${days}\n当前假设：${receipt.request.draft.assumptions.join("；") || "无"}\n仍需确认：${receipt.request.draft.warnings.join("；") || "无"}\n原计划会收进历史版本；既有训练记录不会改写或删除。`;
  }
  if (receipt.kind === "program-week-schedule") {
    return `计划：${receipt.before.program.name} · V${receipt.before.program.version}\n场地：${receipt.before.venue.name}\n排期时区：${receipt.request.scheduleTimeZone}\n这一周新增：${receipt.after.createdEventIds.length} 条\n${receipt.after.events.map((event) => `${dateTime(event.starts_at, receipt.request.scheduleTimeZone)} · ${event.title} · ${kindText(event.kind)} · 约 ${event.planned_minutes} 分钟`).join("\n")}`;
  }
  if (receipt.kind === "calendar-reschedule") {
    return `安排：${receipt.before.title}\n原时间：${dateTime(receipt.before.starts_at)}\n新时间：${dateTime(receipt.after.starts_at)}\n只移动这次安排，不新增未完成记录。`;
  }
  return `安排：${receipt.before.title}\n原时间：${dateTime(receipt.before.starts_at)}\n结果：这次未进行\n说明：${receipt.after.note || "未填写"}\n后续安排不会自动顺延。`;
}

export function FitnessPlanCalendarWriteRecovery({
  controller,
}: {
  controller: FitnessPlanCalendarWriteController;
}) {
  const { flow, journal, busy, error, status } = controller;
  const entry = "entry" in flow ? flow.entry : null;
  const blocked = journal.unavailable || journal.unreadable.length > 0;
  return <section className="sl-plan-calendar-write-recovery" aria-busy={busy}>
    <header><b>{flow.phase === "working"
      ? "正在安全处理"
      : entry ? `${receiptLabel(entry.ticket.receipt)}需要核对` : "计划与日历写入核对"}</b><p>{"message" in flow
      ? flow.message
      : journal.unavailable
        ? "当前浏览器无法安全协调跨页面线索。"
        : journal.unreadable.length
          ? "有无法验证的提醒；没有据此写入。"
          : "当前没有待处理写入。"}</p></header>
    {entry && flow.phase !== "invalid" && <details><summary>查看这张回执记录的内容</summary><pre>{receiptSummary(entry.ticket.receipt)}</pre></details>}
    {error && <p className="sl-form-error" role="alert">{error}</p>}
    {status && <p className="sl-data-status" role="status">{status}</p>}
    <footer>
      {journal.unavailable && <button type="button" disabled={busy} onClick={controller.recheckJournal}>重新检查</button>}
      {!journal.unavailable && journal.unreadable.length > 0 && <button type="button" disabled={busy} onClick={() => void controller.clearUnreadable()}>保留现有安排并清除提醒</button>}
      {entry && flow.phase === "check" && <button className="sl-primary" type="button" disabled={busy || blocked} onClick={() => void controller.inspect(entry)}>只核对结果</button>}
      {entry && flow.phase === "expected" && <><button type="button" disabled={busy} onClick={() => void controller.discardExpected(entry)}>不写入并清除回执</button><button className="sl-primary" type="button" disabled={busy || blocked} onClick={() => void controller.continueExpected(entry)}>继续同一份写入</button></>}
      {entry && flow.phase === "changed" && <button type="button" disabled={busy} onClick={() => void controller.refreshChanged(entry)}>放弃旧回执并只重新读取</button>}
      {entry && flow.phase === "refresh-only" && <button className="sl-primary" type="button" disabled={busy} onClick={() => void controller.refreshCommitted(entry)}>只重新读取</button>}
      {entry && (flow.phase === "reminder-only" || flow.phase === "invalid") && <button type="button" disabled={busy} onClick={() => void controller.dismissReminder(entry, flow.phase === "invalid")}>保留现有安排并清除提醒</button>}
    </footer>
  </section>;
}
