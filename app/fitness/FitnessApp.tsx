"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  EQUIPMENT_KIND_LABELS,
  FITNESS_EXERCISES,
  MOVEMENT_PATTERN_LABELS,
  equipmentResourcesForExercise,
  exerciseFitsEquipment,
  exercisesForVenue,
  getFitnessExercise,
} from "@/lib/fitness/catalog";
import { createPlanDraft, fitnessAiErrorMessage } from "@/lib/fitness/api";
import { buildPrivateFitnessPlanInput } from "@/lib/fitness/ai-input";
import type { PlanDraft as AiPlanDraft } from "@/lib/fitness/ai-contract";
import {
  buildFitnessPlanDraft,
  validateFitnessPlanDraft,
  type FitnessPlannerContext,
} from "@/lib/fitness/planner";
import {
  addSessionExercise,
  archiveVenue,
  completeSessionExercise,
  finishFitnessSession,
  initializeFitnessDatabase,
  loadFitnessSnapshot,
  markCalendarEventNotPerformed,
  recordFitnessSet,
  rescheduleCalendarEvent,
  restoreVenue,
  saveConstraint,
  saveEquipmentWithLoads,
  saveFitnessProfile,
  saveFitnessSettings,
  saveProgramDraft,
  saveVenue,
  scheduleProgramWeek,
  setFitnessConstraintActive,
  setEquipmentStatus,
  startFitnessSession,
  substituteSessionExercise,
  undoFitnessSet,
  updateSessionReflection,
  type SaveConstraintInput,
  type SaveEquipmentInput,
  type SaveFitnessProfileInput,
  type SaveVenueInput,
} from "@/lib/fitness/store";
import { initializeFitnessFiles } from "@/lib/fitness/files";
import { subscribeFitnessChanges } from "@/lib/fitness/lock";
import { localDayBounds, resolveLocalDateTimeInput, toLocalDateTimeInputValue } from "@/lib/fitness/time";
import type {
  FitnessCalendarEvent,
  FitnessConstraint,
  FitnessEquipment,
  FitnessEquipmentLoad,
  FitnessExercise,
  FitnessPlanDraft,
  FitnessProgramDay,
  FitnessProgramItem,
  FitnessSnapshot,
  FitnessVenue,
  FitnessView,
} from "@/lib/fitness/types";
import {
  estimateLocalStorage,
  requestPersistentLocalStorage,
  type LocalStorageEstimate,
} from "@/lib/local-db/files";
import {
  ConstraintForm,
  EquipmentForm,
  EquipmentRequirementList,
  FitnessDialog,
  ProfileForm,
  VenueForm,
} from "./forms";
import { useFitnessDialog } from "./useFitnessDialog";
import { EquipmentPhotos, FitnessDataControls } from "./data-panels";

const navigation: Array<{ id: FitnessView; label: string; glyph: string }> = [
  { id: "today", label: "今日", glyph: "今" },
  { id: "plan", label: "计划", glyph: "划" },
  { id: "calendar", label: "日历", glyph: "日" },
  { id: "venues", label: "场地", glyph: "场" },
  { id: "history", label: "记录", glyph: "记" },
];

const emptySnapshot: FitnessSnapshot = {
  profile: null,
  venues: [],
  equipment: [],
  equipmentLoads: [],
  constraints: [],
  programs: [],
  programDays: [],
  programItems: [],
  events: [],
  sessions: [],
  sessionExercises: [],
  sets: [],
  cardioEntries: [],
  capabilities: [],
  files: [],
  settings: { unit: "kg", rest_timer_enabled: true, sound_enabled: false, ai_enabled: true },
};

const weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const goalLabels = {
  strength: "力量",
  muscle: "增肌",
  cardio: "心肺",
  general_health: "一般健康",
  sport: "运动专项",
  mobility: "活动度",
} as const;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作没有完成，请稍后重试。";
}

function formatDate(value: number, includeTime = false) {
  return new Intl.DateTimeFormat("zh-CN", includeTime
    ? { month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }
    : { month: "long", day: "numeric", weekday: "short" }).format(new Date(value));
}

function formatMinutes(milliseconds: number) {
  if (milliseconds < 60_000) return "少于 1";
  return String(Math.round(milliseconds / 60_000));
}

function displayLoad(grams: number | null, unit: "kg" | "lb") {
  if (grams === null) return "重量未记录";
  const value = unit === "kg" ? grams / 1_000 : grams / 453.59237;
  return `${Number(value.toFixed(2))} ${unit}`;
}

function equipmentSummary(equipment: FitnessEquipment, loads: readonly FitnessEquipmentLoad[], unit: "kg" | "lb") {
  const ownLoads = loads.filter((entry) => entry.equipment_id === equipment.id && entry.available);
  if (equipment.kind === "barbell" || equipment.kind === "smith_machine") {
    return equipment.bar_weight_grams === null ? "杆重待确认" : `杆重 ${displayLoad(equipment.bar_weight_grams, unit)}`;
  }
  if (ownLoads.length) {
    const first = ownLoads[0];
    const last = ownLoads.at(-1)!;
    return first.load_grams === last.load_grams
      ? `${displayLoad(first.load_grams, unit)} · ${first.quantity} 件`
      : `${displayLoad(first.load_grams, unit)} – ${displayLoad(last.load_grams, unit)} · ${ownLoads.length} 档`;
  }
  if (equipment.load_mode === "none") return "无需录入重量";
  return "重量档位待确认";
}

function dayStart(value = Date.now()) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function resourcesForExercise(
  exercise: FitnessExercise,
  equipment: readonly FitnessEquipment[],
  loads: readonly FitnessEquipmentLoad[],
) {
  return equipmentResourcesForExercise(exercise, equipment, loads)?.map((entry) => entry.id) ?? null;
}

function plannerContext(
  snapshot: FitnessSnapshot,
  venue: FitnessVenue,
  equipment: readonly FitnessEquipment[],
): FitnessPlannerContext {
  return {
    profile: snapshot.profile!,
    venue,
    equipment,
    equipmentLoads: snapshot.equipmentLoads,
    constraints: snapshot.constraints,
    loadHistory: snapshot.capabilities.flatMap((entry) =>
      entry.equipment_id && entry.load_grams !== null
        ? [{
            exercise_id: entry.exercise_id,
            equipment_id: entry.equipment_id,
            load_grams: entry.load_grams,
            completed_at: entry.recorded_at,
            completed: true,
          }]
        : [],
    ),
  };
}

function aiDraftToLocal(
  ai: AiPlanDraft,
  snapshot: FitnessSnapshot,
  venue: FitnessVenue,
): FitnessPlanDraft {
  const equipment = snapshot.equipment.filter((entry) => entry.venue_id === venue.id);
  const profile = snapshot.profile;
  if (!profile) throw new Error("请先保存训练偏好");
  const days = ai.days.map((day, dayIndex) => {
    const weekday = Number(day.day_key);
    const items = day.items.map((item, itemIndex) => {
      const definition = getFitnessExercise(item.exercise_id);
      if (!definition) throw new Error(`AI 引用了不在本地动作池中的动作：${item.exercise_id}`);
      const resources = resourcesForExercise(definition, equipment, snapshot.equipmentLoads);
      if (!resources) throw new Error(`动作「${definition.name_zh}」缺少当前场地的完整器材`);
      if (item.equipment_id && !resources.includes(item.equipment_id)) {
        throw new Error(`动作「${definition.name_zh}」的器材与本地需求不一致`);
      }
      return {
        exercise_id: definition.id,
        equipment_id: item.equipment_id,
        resource_equipment_ids: resources,
        order_index: itemIndex,
        sets: item.sets,
        rep_min: item.rep_range?.min ?? null,
        rep_max: item.rep_range?.max ?? null,
        duration_seconds: item.duration_seconds,
        target_rir: item.load_rule.target_rir,
        rest_seconds: item.rest_seconds,
        load_grams: null,
        load_guidance: item.load_rule.instruction,
        rationale: item.reason,
        substitution_exercise_ids: item.alternatives.map((entry) => entry.exercise_id),
        equipment_snapshot: JSON.stringify(resources.map((id) => {
          const resource = equipment.find((entry) => entry.id === id)!;
          return { id: resource.id, name: resource.name, kind: resource.kind };
        })),
      } satisfies Omit<FitnessProgramItem, "id" | "program_day_id" | "created_at">;
    });
    return {
      weekday: Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
        ? weekday
        : profile.preferred_weekdays[dayIndex] ?? null,
      kind: day.session_type === "cardio" ? "cardio" as const : day.session_type === "rest" || day.session_type === "recovery" ? "rest" as const : "resistance" as const,
      name: day.label,
      focus: day.items.map((item) => item.movement_pattern).filter(Boolean).slice(0, 3).join(" · ") || "按现场调整",
      estimated_minutes: day.estimated_minutes,
      items,
    };
  });
  return {
    name: ai.title,
    venue_id: venue.id,
    goal: profile.goals[0] ?? "general_health",
    split: profile.split,
    assumptions: [ai.rationale, ...ai.assumptions],
    warnings: [...ai.questions, ...ai.warnings],
    days,
  };
}

function Logo() {
  return <span className="sl-logo"><i>适</i><span>适练<small>SHÌ LIÀN</small></span></span>;
}

type DialogState =
  | null
  | "venue"
  | "equipment"
  | "equipment-photos"
  | "profile"
  | "constraint"
  | "plan-preview"
  | "ai-preview"
  | "exercise-picker"
  | "substitution"
  | "reschedule"
  | "history-detail"
  | "more";

export default function FitnessApp() {
  const [snapshot, setSnapshot] = useState<FitnessSnapshot>(emptySnapshot);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState("");
  const [view, setView] = useState<FitnessView>("today");
  const [venueId, setVenueId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [editingVenue, setEditingVenue] = useState<FitnessVenue | null>(null);
  const [editingEquipment, setEditingEquipment] = useState<FitnessEquipment | null>(null);
  const [editingConstraint, setEditingConstraint] = useState<FitnessConstraint | null>(null);
  const [planDraft, setPlanDraft] = useState<FitnessPlanDraft | null>(null);
  const [aiDraft, setAiDraft] = useState<AiPlanDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [storage, setStorage] = useState<LocalStorageEstimate | null>(null);
  const [rescheduleEvent, setRescheduleEvent] = useState<FitnessCalendarEvent | null>(null);
  const [sessionExerciseId, setSessionExerciseId] = useState<string | null>(null);
  const [historySessionId, setHistorySessionId] = useState<string | null>(null);
  const [dialogMutationBusy, setDialogMutationBusy] = useState(false);
  const [elapsedNow, setElapsedNow] = useState(() => Date.now());
  const [firstRunDismissed, setFirstRunDismissed] = useState(false);
  const dialogWasOpen = useRef(false);
  const activeDialog = useRef<DialogState>(dialog);
  const dialogMutationBusyRef = useRef(false);

  const refresh = useCallback(async () => {
    const next = await loadFitnessSnapshot();
    setSnapshot(next);
    setVenueId((current) => current && next.venues.some((venue) => venue.id === current && venue.status === "active")
      ? current
      : next.venues.find((venue) => venue.is_default && venue.status === "active")?.id ?? next.venues.find((venue) => venue.status === "active")?.id ?? null);
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await initializeFitnessDatabase();
        await initializeFitnessFiles();
        const data = await loadFitnessSnapshot();
        if (!live) return;
        setSnapshot(data);
        setVenueId(data.venues.find((venue) => venue.is_default && venue.status === "active")?.id ?? data.venues.find((venue) => venue.status === "active")?.id ?? null);
        setReady(true);
        void (async () => {
          try {
            const current = await estimateLocalStorage();
            if (!live) return;
            setStorage(current);
          } catch {
            // Storage details are informative and never gate local CRUD.
          }
        })();
      } catch (reason) {
        if (live) setFatal(errorMessage(reason));
      }
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => subscribeFitnessChanges(() => { void refresh().catch(() => undefined); }), [refresh]);
  useEffect(() => {
    activeDialog.current = dialog;
  }, [dialog]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const active = snapshot.sessions.some((session) => session.status === "active");
    if (!active) return;
    const timer = window.setInterval(() => setElapsedNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [snapshot.sessions]);
  useEffect(() => {
    if (!firstRunDismissed || view !== "exercises") return;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>(".sl-filterbar input")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [firstRunDismissed, view]);
  useEffect(() => {
    if (dialog !== null) {
      dialogWasOpen.current = true;
      return;
    }
    if (!dialogWasOpen.current) return;
    dialogWasOpen.current = false;
    const frame = window.requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return;
      const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>(
        ".sl-topbar nav button[aria-current='page'], .sl-mobile-tabs button[aria-current='page']",
      ));
      candidates.find((candidate) => candidate.getClientRects().length > 0)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dialog]);

  const venue = snapshot.venues.find((entry) => entry.id === venueId && entry.status === "active") ?? null;
  const venueEquipment = snapshot.equipment.filter((entry) => entry.venue_id === venueId);
  const activeSession = snapshot.sessions.find((session) => session.status === "active") ?? null;

  const setDialogBusy = useCallback((next: boolean) => {
    dialogMutationBusyRef.current = next;
    setDialogMutationBusy(next);
  }, []);

  const closeDialog = useCallback(() => {
    setDialog(null); setError(""); setEditingEquipment(null); setEditingVenue(null); setEditingConstraint(null);
    setRescheduleEvent(null); setSessionExerciseId(null); setHistorySessionId(null);
    setDialogBusy(false);
  }, [setDialogBusy]);

  const requestDialogClose = useCallback(() => {
    if (!dialogMutationBusyRef.current) closeDialog();
  }, [closeDialog]);

  const run = useCallback(async (operation: () => Promise<void>, success?: string) => {
    setBusy(true); setError("");
    try {
      await operation();
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
      return;
    }
    try {
      await refresh();
      if (success) setToast(success);
    } catch {
      setError("更改已经保存在本地，但当前页面没有重新读取成功。请刷新页面，不要重复提交。");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const finalizePersistedDialogWrite = useCallback(async (success: string, apply?: () => void) => {
    apply?.();
    try {
      await refresh();
      setToast(success);
    } catch {
      setError("更改已经保存在本地，但当前页面没有重新读取成功。请刷新页面，不要重复提交。");
    } finally {
      closeDialog();
    }
  }, [closeDialog, refresh]);

  const runDialogMutation = useCallback(async (
    expectedDialog: Exclude<DialogState, null>,
    operation: () => Promise<void>,
    success: string,
    after?: () => void,
  ) => {
    if (dialogMutationBusyRef.current) return;
    setDialogBusy(true); setBusy(true); setError("");
    try {
      await operation();
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false); setDialogBusy(false);
      return;
    }
    try {
      await refresh();
      setToast(success);
    } catch {
      setError("更改已经保存在本地，但当前页面没有重新读取成功。请刷新页面，不要重复提交。");
    }
    if (activeDialog.current === expectedDialog) {
      after?.();
      closeDialog();
    }
    setBusy(false); setDialogBusy(false);
  }, [closeDialog, refresh, setDialogBusy]);

  const saveAndSchedulePlanDraft = useCallback(async () => {
    const draft = planDraft;
    if (!draft || dialogMutationBusyRef.current) return;
    setDialogBusy(true); setBusy(true); setError("");
    let programId: string;
    try {
      programId = await saveProgramDraft(draft, "local", true);
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false); setDialogBusy(false);
      return;
    }

    try {
      await scheduleProgramWeek(programId);
    } catch (reason) {
      try {
        await refresh();
      } catch {
        // The plan write already succeeded; the message below prevents a duplicate retry.
      }
      if (activeDialog.current === "plan-preview") {
        setPlanDraft(null);
        closeDialog();
        setView("plan");
      }
      setError(`计划已保存为新版本，但没有放入日历：${errorMessage(reason)}。可以在周蓝图中再次安排，不要重新保存同一草稿。`);
      setBusy(false); setDialogBusy(false);
      return;
    }

    try {
      await refresh();
      setToast("计划已保存为新版本并放入日历");
    } catch {
      setError("计划与日历已经保存在本地，但当前页面没有重新读取成功。请刷新页面，不要重复提交。");
    }
    if (activeDialog.current === "plan-preview") {
      setPlanDraft(null);
      setView("plan");
      closeDialog();
    }
    setBusy(false); setDialogBusy(false);
  }, [closeDialog, planDraft, refresh, setDialogBusy]);

  const generateLocal = useCallback(() => {
    if (!snapshot.profile || !venue) {
      setError("请先保存训练偏好并选择场地");
      return;
    }
    try {
      const context = plannerContext(snapshot, venue, venueEquipment);
      const draft = buildFitnessPlanDraft(context);
      const validation = validateFitnessPlanDraft(draft, context);
      if (!validation.valid) throw new Error(validation.errors[0] ?? "计划没有通过本地校验");
      setPlanDraft(draft);
      setDialog("plan-preview");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, [snapshot, venue, venueEquipment]);

  const generateAi = useCallback(async () => {
    if (!snapshot.profile || !venue) return;
    setBusy(true); setError("");
    try {
      const result = await createPlanDraft(buildPrivateFitnessPlanInput(snapshot, venue));
      setAiDraft(result);
      setDialog("ai-preview");
    } catch (reason) {
      setError(fitnessAiErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  }, [snapshot, venue]);

  if (fatal) return <main className="shilian sl-fatal"><Logo /><section><span>数据库没有打开</span><h1>你的训练资料没有被改动。</h1><p>{fatal}</p><button onClick={() => window.location.reload()}>重新尝试</button></section></main>;
  if (!ready) return <main className="shilian sl-loading"><Logo /><i /><p>正在打开你的训练空间…</p></main>;

  if (activeSession) {
    return <LiveSession
      snapshot={snapshot}
      sessionId={activeSession.id}
      now={elapsedNow}
      onRefresh={refresh}
      onToast={setToast}
      toast={toast}
      error={error}
      setError={setError}
      dialog={dialog}
      setDialog={setDialog}
      selectedExerciseId={sessionExerciseId}
      setSelectedExerciseId={setSessionExerciseId}
      onExit={() => { setView("history"); void refresh(); }}
    />;
  }

  return <main className="shilian">
    <header className="sl-topbar">
      <Link href="/" className="sl-brand" aria-label="返回私人工作台"><Logo /></Link>
      <nav aria-label="适练页面">{navigation.map((item) => <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "active" : ""} onClick={() => { setView(item.id); window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }}><span>{item.label}</span></button>)}</nav>
      <div className="sl-top-actions"><label><span>当前场地</span><select aria-label="当前场地" value={venueId ?? ""} onChange={(event) => setVenueId(event.target.value || null)}><option value="">尚未建立</option>{snapshot.venues.filter((entry) => entry.status === "active").map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><button className="sl-more" aria-label="更多页面" onClick={() => setDialog("more")}>•••</button></div>
    </header>

    <nav className="sl-mobile-tabs" aria-label="适练页面">{navigation.map((item) => <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><i>{item.glyph}</i><span>{item.label}</span></button>)}</nav>

    <section className="sl-workspace">
      {view === "today" && <TodayView
        now={elapsedNow}
        snapshot={snapshot}
        venue={venue}
        onView={setView}
        onAddVenue={() => setDialog("venue")}
        onStart={(event) => void run(async () => {
          await startFitnessSession({
            eventId: event?.id ?? null,
            venueId: event?.venue_id ?? venue?.id ?? "",
            programDayId: event?.program_day_id ?? null,
            availableMinutes: event?.planned_minutes ?? snapshot.profile?.session_minutes ?? 60,
          });
        }, "训练已在本地开始")}
      />}
      {view === "venues" && <VenuesView snapshot={snapshot} venue={venue} busy={busy} onSelect={setVenueId} onAdd={() => { setEditingVenue(null); setDialog("venue"); }} onEditVenue={(entry) => { setEditingVenue(entry); setDialog("venue"); }} onArchive={(entry) => { if (!window.confirm(`归档「${entry.name}」吗？它的未来计划会停用，尚未开始的安排会取消；历史记录会保留。`)) return; void run(async () => { await archiveVenue(entry.id); }, `「${entry.name}」已归档，历史仍保留`); }} onRestore={(entry) => void run(async () => { await restoreVenue(entry.id); }, `「${entry.name}」已恢复为可用场地；旧计划和已取消安排没有被复活`)} onAddEquipment={() => setDialog("equipment")} onEditEquipment={(entry) => { setEditingEquipment(entry); setDialog("equipment"); }} onStatus={(entry, status) => void run(async () => { await setEquipmentStatus(entry.id, status); }, status === "maintenance" ? "已标记为临时停用，未来计划会避开它" : "器材状态已更新")} />}
      {view === "plan" && <PlanView snapshot={snapshot} venue={venue} busy={busy} error={error} onProfile={() => setDialog("profile")} onVenue={() => setDialog("venue")} onEquipment={() => setDialog("equipment")} onGenerate={generateLocal} onAi={() => void generateAi()} onSchedule={(program) => void run(async () => { await scheduleProgramWeek(program.id); }, "这一周已放入日历；随时可以改期或不进行")} />}
      {view === "calendar" && <CalendarView snapshot={snapshot} onPlan={() => setView("plan")} onStart={(event) => void run(async () => { if (!event.venue_id) throw new Error("请先为这次训练选择场地"); await startFitnessSession({ eventId: event.id, venueId: event.venue_id, programDayId: event.program_day_id, availableMinutes: event.planned_minutes }); }, "训练已在本地开始")} onReschedule={(event) => { setRescheduleEvent(event); setDialog("reschedule"); }} onSkip={(event) => { if (window.confirm("只记录“这次未进行”，不会把它变成欠账，也不会自动堆到明天。继续吗？")) void run(async () => { await markCalendarEventNotPerformed(event.id); }, "已记为这次未进行，其他安排没有改变"); }} />}
      {view === "history" && <HistoryView snapshot={snapshot} onOpen={(sessionId) => { setHistorySessionId(sessionId); setDialog("history-detail"); }} onStart={() => { if (!venue) setDialog("venue"); else void run(async () => { await startFitnessSession({ venueId: venue.id, availableMinutes: snapshot.profile?.session_minutes ?? venue.default_session_minutes }); }, "临时训练已开始"); }} />}
      {view === "exercises" && <ExercisesView equipment={venueEquipment} equipmentLoads={snapshot.equipmentLoads} venue={venue} />}
      {view === "profile" && <ProfileView snapshot={snapshot} busy={busy} onProfile={() => setDialog("profile")} onConstraint={(entry) => { setEditingConstraint(entry); setDialog("constraint"); }} onToggleConstraint={(entry) => void run(async () => { await setFitnessConstraintActive(entry.id, !entry.active); }, entry.active ? "这条身体边界已暂时结束；记录仍保留" : "这条身体边界已重新启用；它只影响未来草稿和现场选项，不改写历史")} />}
      {view === "settings" && <SettingsView snapshot={snapshot} storage={storage} onPersist={() => void run(async () => { await requestPersistentLocalStorage(); setStorage(await estimateLocalStorage()); }, "已重新请求浏览器保护；状态见下方")} onChange={(settings) => void run(async () => { await saveFitnessSettings(settings); }, "设置已保存在当前浏览器")} onRestored={refresh} />}
    </section>

    {!snapshot.venues.length && !firstRunDismissed && <FirstRun onStart={() => { setFirstRunDismissed(true); setDialog("venue"); }} onExercises={() => { setFirstRunDismissed(true); setView("exercises"); }} />}

    <FitnessDialog open={dialog === "venue"} eyebrow="REAL PLACE FIRST" title={editingVenue ? "编辑场地" : "建立训练场地"} busy={dialogMutationBusy} onClose={requestDialogClose}><VenueForm venue={editingVenue} onBusyChange={setDialogBusy} onClose={requestDialogClose} onSave={async (input: SaveVenueInput) => { const id = await saveVenue(input); await finalizePersistedDialogWrite("场地已保存。接下来可以从眼前看得到的器材开始录入", () => setVenueId(id)); }} /></FitnessDialog>
    <FitnessDialog open={dialog === "equipment"} eyebrow="WHAT IS ACTUALLY HERE" title={editingEquipment ? "编辑器材" : "录入器材"} busy={dialogMutationBusy} onClose={requestDialogClose} wide>{venue ? <><EquipmentForm venueId={venue.id} equipment={editingEquipment} loads={snapshot.equipmentLoads.filter((entry) => entry.equipment_id === editingEquipment?.id)} unit={snapshot.profile?.unit ?? snapshot.settings.unit} onBusyChange={setDialogBusy} onClose={requestDialogClose} onSave={async (input: SaveEquipmentInput) => { await saveEquipmentWithLoads(input); await finalizePersistedDialogWrite("器材与真实重量档位已保存"); }} />{editingEquipment && <div className="sl-equipment-photo-entry"><span><b>器材照片</b><small>{snapshot.files.filter((file) => file.entity_type === "equipment" && file.entity_id === editingEquipment.id && file.status === "ready").length} 张本地照片 · 不会发送给 AI</small></span><button type="button" disabled={dialogMutationBusy} onClick={() => setDialog("equipment-photos")}>查看与添加</button></div>}</> : <DialogNeed copy="先建立或选择一个场地，器材才有明确归属。" action={() => { closeDialog(); setDialog("venue"); }} label="建立场地" />}</FitnessDialog>
    <FitnessDialog open={dialog === "equipment-photos"} eyebrow="LOCAL EQUIPMENT REFERENCE" title={editingEquipment ? `${editingEquipment.name}的照片` : "器材照片"} onClose={closeDialog} wide>{editingEquipment && <EquipmentPhotos equipment={editingEquipment} onChanged={refresh}/>}</FitnessDialog>
    <FitnessDialog open={dialog === "profile"} eyebrow="YOUR TIME & PREFERENCES" title="训练偏好" busy={dialogMutationBusy} onClose={requestDialogClose} wide><ProfileForm profile={snapshot.profile} onBusyChange={setDialogBusy} onClose={requestDialogClose} onSave={async (input: SaveFitnessProfileInput) => { await saveFitnessProfile(input); await finalizePersistedDialogWrite("偏好已保存；它是规划输入，不是必须完成的配额"); }} /></FitnessDialog>
    <FitnessDialog open={dialog === "constraint"} eyebrow="BODY BOUNDARIES" title={editingConstraint ? "编辑身体边界" : "记录身体边界"} busy={dialogMutationBusy} onClose={requestDialogClose} wide><ConstraintForm constraint={editingConstraint} onBusyChange={setDialogBusy} onClose={requestDialogClose} onSave={async (input: SaveConstraintInput) => { await saveConstraint(input); await finalizePersistedDialogWrite(!input.active ? "内容已保存；这条边界仍是已结束状态" : input.severity === "avoid" ? "身体边界已保存；未来草稿与现场选项会避开指定范围，历史不会被改写" : "身体边界已保存；现场会显示原文提醒，不会自动推断调整方式"); }} /></FitnessDialog>
    <FitnessDialog open={dialog === "plan-preview"} eyebrow="LOCAL · VERIFIED" title="可执行计划草稿" busy={dialogMutationBusy} onClose={requestDialogClose} wide>{planDraft && <PlanDraftPreview draft={planDraft} snapshot={snapshot} busy={busy} onSave={() => void saveAndSchedulePlanDraft()} />}</FitnessDialog>
    <FitnessDialog open={dialog === "ai-preview"} eyebrow="AI DRAFT · NOT SAVED" title="AI 计划草稿" onClose={closeDialog} wide>{aiDraft && <AiDraftPreview draft={aiDraft} busy={busy} onApply={() => { try { const local = aiDraftToLocal(aiDraft, snapshot, venue!); const validation = validateFitnessPlanDraft(local, plannerContext(snapshot, venue!, venueEquipment)); if (!validation.valid) throw new Error(validation.errors[0] ?? "AI 草稿没有通过本地校验"); setPlanDraft(local); setDialog("plan-preview"); } catch (reason) { setError(errorMessage(reason)); } }} />}</FitnessDialog>
    <FitnessDialog open={dialog === "reschedule"} eyebrow="MOVE, DON'T OWE" title="把它放到更合适的一天" busy={dialogMutationBusy} onClose={requestDialogClose}>{rescheduleEvent && <RescheduleForm event={rescheduleEvent} busy={dialogMutationBusy} onClose={requestDialogClose} onSave={(startsAt) => void runDialogMutation("reschedule", async () => { await rescheduleCalendarEvent(rescheduleEvent.id, startsAt); }, "已改期，原来的训练没有被算作失败")} />}</FitnessDialog>
    <FitnessDialog open={dialog === "history-detail"} eyebrow="WHAT YOU ACTUALLY SAVED" title="训练详情" onClose={closeDialog} wide>{historySessionId && <HistoryDetail key={historySessionId} snapshot={snapshot} sessionId={historySessionId} unit={snapshot.profile?.unit ?? snapshot.settings.unit} onSaveReflection={async (sessionId, reflection) => {
      await updateSessionReflection(sessionId, reflection);
      try {
        await refresh();
        setToast("复盘已保存在这条训练记录里");
      } catch {
        setError("复盘已经保存在本地，但当前页面没有重新读取成功。请刷新页面，不要重复提交。");
      }
    }} />}</FitnessDialog>
    <MoreDialog open={dialog === "more"} current={view} onClose={closeDialog} onView={(next) => { setView(next); closeDialog(); }} />
    {error && <div className="sl-error-toast" role="alert"><span>需要确认</span>{error}<button onClick={() => setError("")} aria-label="关闭错误">×</button></div>}
    {toast && <div className="sl-toast" role="status"><i>✓</i>{toast}</div>}
  </main>;
}

function FirstRun({ onStart, onExercises }: { onStart: () => void; onExercises: () => void }) {
  const dialog = useFitnessDialog<HTMLDivElement>(true, onExercises, "button");
  return <div className="sl-first-run"><div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="sl-first-run-title" tabIndex={-1}><Logo /><span>场地先于计划</span><h1 id="sl-first-run-title">先告诉适练，<br/>你在哪里练。</h1><p>从眼前看得到的器材开始，不必一次录完。没有场地资料时，适练不会凭空生成一张标准训练表。</p><footer><button className="sl-primary" onClick={onStart}>建立第一个场地</button><button onClick={onExercises}>先浏览动作</button></footer></div></div>;
}

function DialogNeed({ copy, action, label }: { copy: string; action: () => void; label: string }) {
  return <div className="sl-dialog-need"><span>先完成一步</span><p>{copy}</p><button className="sl-primary" onClick={action}>{label}</button></div>;
}

function TodayView({ now, snapshot, venue, onView, onAddVenue, onStart }: { now: number; snapshot: FitnessSnapshot; venue: FitnessVenue | null; onView: (view: FitnessView) => void; onAddVenue: () => void; onStart: (event: FitnessCalendarEvent | null) => void }) {
  const upcoming = snapshot.events.filter((event) => event.status === "planned" && event.starts_at >= dayStart(now)).sort((a, b) => a.starts_at - b.starts_at);
  const next = upcoming[0] ?? null;
  const nextDay = next?.program_day_id ? snapshot.programDays.find((day) => day.id === next.program_day_id) ?? null : null;
  const items = nextDay ? snapshot.programItems.filter((item) => item.program_day_id === nextDay.id) : [];
  const currentVenueEquipment = snapshot.equipment.filter((entry) => entry.venue_id === venue?.id && (entry.status === "available" || entry.status === "limited"));
  const nextVenueEquipment = snapshot.equipment.filter((entry) => entry.venue_id === next?.venue_id && (entry.status === "available" || entry.status === "limited"));
  const nextEquipmentReady = items.length > 0 && items.every((item) => item.resource_equipment_ids.every((id) => nextVenueEquipment.some((entry) => entry.id === id)));
  const nextBoundaryConflict = next ? calendarEventHasBoundaryConflict(next, snapshot) : false;
  return <div className="sl-page sl-today">
    <header className="sl-hero"><div><span>{formatDate(now)}</span><h1>今天在真实条件里，<br/><em>做得到什么？</em></h1><p>计划可以调整，实际发生的训练才会成为记录。</p></div><div className="sl-hero-place"><span>当前场地</span><strong>{venue?.name ?? "还没有场地"}</strong><small>{venue ? `${currentVenueEquipment.length} 类已录器材 · 上次核对 ${venue.last_verified_at ? formatDate(venue.last_verified_at) : "待记录"}` : "先从你实际训练的地方开始"}</small></div></header>
    {next ? <section className={`sl-next-session${nextBoundaryConflict ? " conflict" : ""}`}><div className="sl-next-time"><span>{new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(new Date(next.starts_at))}</span><strong>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(next.starts_at))}</strong><small>约 {next.planned_minutes} 分钟</small></div><div className="sl-next-copy"><span>NEXT · {next.kind === "cardio" ? "心肺" : "力量"}</span><h2>{next.title}</h2><p>{nextBoundaryConflict ? "身体边界已经更新；这项安排原样保留，但开始前需要生成适用版本。" : nextDay?.focus || "开始前会再次核对场地和时间。"}</p><div>{items.slice(0, 5).map((item) => <span key={item.id}>{getFitnessExercise(item.exercise_id)?.name_zh ?? item.exercise_id}</span>)}</div><footer>{nextBoundaryConflict ? <button className="sl-primary" onClick={() => onView("plan")}>查看并生成适用版本</button> : <button className="sl-primary" onClick={() => onStart(next)}>开始这场训练</button>}<button onClick={() => onView("calendar")}>改期或查看安排</button></footer></div><aside><i className={nextBoundaryConflict ? "check" : nextEquipmentReady ? "ok" : "check"}/><strong>{nextBoundaryConflict ? "当前身体边界与旧计划冲突" : nextEquipmentReady ? "已找到计划引用的器材" : "安排场地有器材需要重新确认"}</strong><small>{nextBoundaryConflict ? "不会把这项旧安排算成失败，也不会直接开始一场已知不适用的训练。" : `${snapshot.venues.find((entry) => entry.id === next.venue_id)?.name ?? "场地待确认"} · 开始时会重新核对数量、档位和当前状态。`}</small></aside></section> : <section className="sl-open-day"><div><span>OPEN DAY</span><h2>今天没有安排。</h2><p>可以休息，也可以按当前时间开始一小段临时训练。</p></div><footer>{venue ? <button className="sl-primary" onClick={() => onStart(null)}>开始临时训练</button> : <button className="sl-primary" onClick={onAddVenue}>建立场地</button>}<button onClick={() => onView("plan")}>看看计划</button></footer></section>}
    <section className="sl-today-grid"><article><header><span>接下来的安排</span><button onClick={() => onView("calendar")}>打开日历 →</button></header>{upcoming.length ? <div className="sl-mini-agenda">{upcoming.slice(0, 4).map((event) => <div key={event.id}><time>{formatDate(event.starts_at)}</time><span><strong>{event.title}</strong><small>{snapshot.venues.find((entry) => entry.id === event.venue_id)?.name ?? "场地待选"} · {event.planned_minutes} 分钟</small></span></div>)}</div> : <p className="sl-empty-copy">还没有后续安排。计划不会自动制造欠账。</p>}</article><article><header><span>这个场地</span><button onClick={() => onView("venues")}>查看器材 →</button></header>{venue ? <div className="sl-place-facts"><span><b>{currentVenueEquipment.length}</b><small>类可用器材</small></span><span><b>{currentVenueEquipment.filter((entry) => entry.busy_level === "high").length}</b><small>类常需替代</small></span><p>{venue.busy_notes || "还没有记录拥挤规律；现场观察后再补也可以。"}</p></div> : <p className="sl-empty-copy">没有场地时，适练不会假定你拥有任何器材。</p>}</article></section>
  </div>;
}

function VenuesView({ snapshot, venue, busy, onSelect, onAdd, onEditVenue, onArchive, onRestore, onAddEquipment, onEditEquipment, onStatus }: {
  snapshot: FitnessSnapshot;
  venue: FitnessVenue | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onEditVenue: (venue: FitnessVenue) => void;
  onArchive: (venue: FitnessVenue) => void;
  onRestore: (venue: FitnessVenue) => void;
  onAddEquipment: () => void;
  onEditEquipment: (equipment: FitnessEquipment) => void;
  onStatus: (equipment: FitnessEquipment, status: FitnessEquipment["status"]) => void;
}) {
  const activeVenues = snapshot.venues.filter((entry) => entry.status === "active");
  const archivedVenues = snapshot.venues.filter((entry) => entry.status === "archived");
  const equipment = snapshot.equipment.filter((entry) => entry.venue_id === venue?.id && entry.status !== "removed");
  return <div className="sl-page">
    <header className="sl-page-title"><div><span>REAL EQUIPMENT, REAL LOADS</span><h1>场地与器材</h1><p>只录真实存在的器材；重量不确定时可以先留空。</p></div><button className="sl-primary" onClick={onAdd}>＋ 新建场地</button></header>
    <div className="sl-venue-tabs" role="group" aria-label="选择训练场地">{activeVenues.map((entry) => <button aria-pressed={venue?.id === entry.id} className={venue?.id === entry.id ? "active" : ""} key={entry.id} onClick={() => onSelect(entry.id)}><i>{entry.name.slice(0, 1)}</i><span><strong>{entry.name}</strong><small>{entry.venue_type === "home" ? "家中" : entry.venue_type === "office" ? "公司" : "训练场地"}</small></span></button>)}</div>
    {venue ? <>
      <section className="sl-venue-overview"><div><span>当前场地</span><h2>{venue.name}</h2><p>{venue.location || "位置没有记录"}</p></div><dl><div><dt>通常时长</dt><dd>{venue.default_session_minutes} 分钟</dd></div><div><dt>上次核对</dt><dd>{venue.last_verified_at ? formatDate(venue.last_verified_at) : "待核对"}</dd></div><div><dt>跨器材组合</dt><dd>{venue.supersets_allowed ? "可以" : "尽量避免"}</dd></div></dl><footer><button onClick={() => onEditVenue(venue)}>编辑场地</button><button disabled={busy} onClick={() => onArchive(venue)}>归档</button></footer></section>
      <section className="sl-equipment-head"><div><span>器材清单</span><p>{equipment.length ? `${equipment.length} 条真实记录，不用一次补完。` : "从眼前看得到的开始，不必一次录完。"}</p></div><button className="sl-primary" onClick={onAddEquipment}>＋ 录入器材</button></section>
      {equipment.length ? <div className="sl-equipment-grid">{equipment.map((entry) => <article key={entry.id} className={entry.status}><header><i>{EQUIPMENT_KIND_LABELS[entry.kind].slice(0, 1)}</i><span><small>{EQUIPMENT_KIND_LABELS[entry.kind]} · {entry.area || "区域待记录"}</small><h3>{entry.name}</h3></span><button aria-label={`编辑${entry.name}`} onClick={() => onEditEquipment(entry)}>•••</button></header><div className="sl-load-summary"><strong>{equipmentSummary(entry, snapshot.equipmentLoads, snapshot.profile?.unit ?? snapshot.settings.unit)}</strong><span>{entry.quantity} 件 · {entry.load_semantics === "per_hand" ? "每只手" : entry.load_semantics === "per_side" ? "每侧" : entry.load_semantics === "stack_label" ? "面板档位" : "总负荷"}</span></div><p>{entry.notes || "还没有个人设置备注。"}</p><footer><span className={`sl-status ${entry.status}`}>{entry.status === "available" ? "已确认可用" : entry.status === "limited" ? "部分可用" : "临时停用"}</span>{entry.status === "maintenance" ? <button onClick={() => onStatus(entry, "available")}>恢复可用</button> : <button onClick={() => onStatus(entry, "maintenance")}>临时停用</button>}</footer></article>)}</div> : <div className="sl-empty-card"><i>场</i><h3>这里还没有器材记录</h3><p>先保存名称也可以；重量档位以后在现场慢慢补。</p><button className="sl-primary" onClick={onAddEquipment}>录入第一件器材</button></div>}
    </> : <div className="sl-empty-card"><i>＋</i><h3>{archivedVenues.length ? "当前没有可用场地" : "先建立一个训练场地"}</h3><p>{archivedVenues.length ? "可以建立新的场地，也可以从下方恢复一条旧记录。" : "每个场地都有独立器材清单，计划不会把不同健身房混在一起。"}</p><button className="sl-primary" onClick={onAdd}>建立场地</button></div>}
    {archivedVenues.length > 0 && <section className="sl-archived-venues"><header><div><span>已归档场地</span><p>恢复只让场地重新可选；旧计划和已取消安排不会自动复活。</p></div><strong>{archivedVenues.length}</strong></header><div>{archivedVenues.map((entry) => <article key={entry.id}><span><b>{entry.name}</b><small>{entry.location || "位置没有记录"} · 器材与历史仍保留</small></span><button disabled={busy} onClick={() => onRestore(entry)}>恢复为可用场地</button></article>)}</div></section>}
  </div>;
}

function exerciseMatchesActiveAvoid(exerciseId: string, constraints: readonly FitnessConstraint[]) {
  const exercise = getFitnessExercise(exerciseId);
  return Boolean(exercise && constraints.some((constraint) =>
    constraint.active && constraint.severity === "avoid" &&
    (constraint.exercise_ids.includes(exercise.id) || constraint.movement_patterns.includes(exercise.pattern)),
  ));
}

function calendarEventHasBoundaryConflict(event: FitnessCalendarEvent, snapshot: FitnessSnapshot) {
  if (event.status !== "planned" || !event.program_day_id) return false;
  return snapshot.programItems.some((item) =>
    item.program_day_id === event.program_day_id && exerciseMatchesActiveAvoid(item.exercise_id, snapshot.constraints));
}

function PlanView({ snapshot, venue, busy, error, onProfile, onVenue, onEquipment, onGenerate, onAi, onSchedule }: { snapshot: FitnessSnapshot; venue: FitnessVenue | null; busy: boolean; error: string; onProfile: () => void; onVenue: () => void; onEquipment: () => void; onGenerate: () => void; onAi: () => void; onSchedule: (program: FitnessSnapshot["programs"][number]) => void }) {
  const active = snapshot.programs.find((entry) => entry.status === "active") ?? null;
  const days = active ? snapshot.programDays.filter((entry) => entry.program_id === active.id) : [];
  const activeDayIds = new Set(days.map((day) => day.id));
  const conflictingExerciseIds = new Set(snapshot.programItems
    .filter((item) => activeDayIds.has(item.program_day_id) && exerciseMatchesActiveAvoid(item.exercise_id, snapshot.constraints))
    .map((item) => item.exercise_id));
  const conflictNames = [...conflictingExerciseIds].map((id) => getFitnessExercise(id)?.name_zh ?? id);
  const hasBoundaryConflict = conflictNames.length > 0;
  const ready = Boolean(snapshot.profile && venue && snapshot.equipment.some((entry) => entry.venue_id === venue.id && (entry.status === "available" || entry.status === "limited")));
  return <div className="sl-page"><header className="sl-page-title"><div><span>AN EXECUTABLE WEEK</span><h1>周蓝图</h1><p>计划是可协商的版本，不是必须偿还的训练清单。</p></div>{ready && <div className="sl-title-actions"><button disabled={busy || !snapshot.settings.ai_enabled} onClick={onAi}>AI 草稿</button><button className="sl-primary" disabled={busy} onClick={onGenerate}>生成本地计划</button></div>}</header>
    {!ready && <section className="sl-prerequisites"><header><span>让计划先认识现实</span><h2>还需要几项真实输入</h2></header><div><button className={snapshot.profile ? "done" : ""} onClick={onProfile}><i>{snapshot.profile ? "✓" : "1"}</i><span><b>训练偏好</b><small>{snapshot.profile ? `${snapshot.profile.resistance_days_per_week} 次力量 · ${snapshot.profile.cardio_days_per_week} 次有氧` : "频次、时间、经验与目标"}</small></span></button><button className={venue ? "done" : ""} onClick={onVenue}><i>{venue ? "✓" : "2"}</i><span><b>训练场地</b><small>{venue?.name ?? "你实际在哪里练"}</small></span></button><button className={venue && snapshot.equipment.some((entry) => entry.venue_id === venue.id) ? "done" : ""} onClick={onEquipment}><i>{venue && snapshot.equipment.some((entry) => entry.venue_id === venue.id) ? "✓" : "3"}</i><span><b>真实器材</b><small>{venue ? `${snapshot.equipment.filter((entry) => entry.venue_id === venue.id).length} 条记录` : "器材与重量档位"}</small></span></button></div></section>}
    {error && <p className="sl-inline-error" role="alert">{error}</p>}
    {ready && <p className="sl-ai-privacy"><b>AI 输入边界</b>只发送器材类型、数量、状态、明确重量、训练频次与能力数字。场地名、器材备注、偏好备注和身体边界文字都留在本地；避用动作会先由本地规则移出动作池。</p>}
    {active ? <><section className={`sl-program-summary${hasBoundaryConflict ? " conflict" : ""}`}><div><span>ACTIVE VERSION · V{active.version}</span><h2>{active.name}</h2><p>{goalLabels[active.goal]} · {active.split === "full_body" ? "全身" : active.split === "upper_lower" ? "上下肢" : active.split === "push_pull_legs" ? "推拉腿" : "自适应分化"} · {snapshot.venues.find((entry) => entry.id === active.venue_id)?.name}</p></div><aside><span>{hasBoundaryConflict ? "身体边界已更新" : "生成依据"}</span><p>{hasBoundaryConflict ? `这版包含现在避用的动作：${conflictNames.join("、")}` : active.assumptions[0] || "来自当前场地、时间与身体边界。"}</p></aside><button disabled={busy || hasBoundaryConflict} onClick={() => onSchedule(active)}>{hasBoundaryConflict ? "先生成适用版本" : "放入接下来一周"}</button></section>{hasBoundaryConflict && <p className="sl-plan-conflict" role="status">旧版会原样保留作参考，也不会计作失败；重新生成后才会允许排期。</p>}<div className="sl-program-days">{days.map((day) => <ProgramDayCard key={day.id} day={day} items={snapshot.programItems.filter((item) => item.program_day_id === day.id)} equipment={snapshot.equipment} unit={snapshot.profile?.unit ?? snapshot.settings.unit} conflictingExerciseIds={conflictingExerciseIds} />)}</div></> : ready && <div className="sl-empty-card"><i>划</i><h3>还没有启用的计划</h3><p>本地规则可以离线生成；AI 只生成待核对草稿，最终仍要通过同一器材校验。</p><div><button className="sl-primary" onClick={onGenerate}>用本地规则生成</button><button disabled={!snapshot.settings.ai_enabled} onClick={onAi}>让 AI 提一个草稿</button></div></div>}
  </div>;
}

function ProgramDayCard({ day, items, equipment, unit, conflictingExerciseIds }: { day: FitnessProgramDay; items: readonly FitnessProgramItem[]; equipment: readonly FitnessEquipment[]; unit: "kg" | "lb"; conflictingExerciseIds: ReadonlySet<string> }) {
  return <article><header><div><span>{day.weekday === null ? `第 ${day.day_index + 1} 天` : weekdayNames[day.weekday]}</span><h3>{day.name}</h3><p>{day.focus}</p></div><strong>{day.estimated_minutes}<small> 分钟</small></strong></header><div>{items.map((item, index) => { const exercise = getFitnessExercise(item.exercise_id); const primary = equipment.find((entry) => entry.id === item.equipment_id); const load = item.equipment_id === null ? "自重" : item.load_grams === null ? "现场确认重量" : displayLoad(item.load_grams, unit); const conflicts = conflictingExerciseIds.has(item.exercise_id); return <div className={`sl-program-item${conflicts ? " conflict" : ""}`} key={item.id}><i>{index + 1}</i><span><b>{exercise?.name_zh ?? item.exercise_id}</b><small>{primary?.name ?? "自重"} · {item.duration_seconds !== null ? `${Number((item.duration_seconds / 60).toFixed(1))} 分钟` : `${item.sets} 组 × ${item.rep_min ?? "自定"}${item.rep_max && item.rep_max !== item.rep_min ? `–${item.rep_max}` : ""}`} · RIR {item.target_rir ?? "自定"}</small></span><em>{conflicts ? "当前边界避用" : load}</em></div>; })}</div></article>;
}

function calendarEventCopy(event: FitnessCalendarEvent): string {
  if (event.status === "completed") return "已有真实训练记录";
  if (event.status === "not_performed") return "这次未进行，后续安排未改变";
  if (event.status === "cancelled") return "安排已取消，不计为未完成";
  if (event.status === "in_progress") return "训练正在进行，实际内容会逐条保存";
  return `${event.planned_minutes} 分钟 · 计划`;
}

function CalendarView({ snapshot, onPlan, onStart, onReschedule, onSkip }: { snapshot: FitnessSnapshot; onPlan: () => void; onStart: (event: FitnessCalendarEvent) => void; onReschedule: (event: FitnessCalendarEvent) => void; onSkip: (event: FitnessCalendarEvent) => void }) {
  const [mode, setMode] = useState<"agenda" | "month">("agenda");
  const events = [...snapshot.events].sort((a, b) => a.starts_at - b.starts_at);
  const grouped = new Map<string, FitnessCalendarEvent[]>();
  for (const event of events) {
    const key = new Intl.DateTimeFormat("en-CA").format(new Date(event.starts_at));
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }
  return <div className="sl-page"><header className="sl-page-title"><div><span>PLAN AND ACTUAL STAY SEPARATE</span><h1>日历</h1><p>可以改期、缩短或不进行；历史只记录实际发生的部分。</p></div><div className="sl-segmented"><button aria-pressed={mode === "agenda"} className={mode === "agenda" ? "active" : ""} onClick={() => setMode("agenda")}>议程</button><button aria-pressed={mode === "month"} className={mode === "month" ? "active" : ""} onClick={() => setMode("month")}>月视图</button></div></header>
    {events.length ? mode === "agenda" ? <div className="sl-agenda">{Array.from(grouped).map(([key, rows]) => <section key={key}><header><time>{formatDate(rows[0].starts_at)}</time><span>{key}</span></header><div>{rows.map((event) => {
      const boundaryConflict = calendarEventHasBoundaryConflict(event, snapshot);
      return <article key={event.id} className={`${event.status}${boundaryConflict ? " conflict" : ""}`}><i>{event.kind === "cardio" ? "心" : event.kind === "rest" ? "休" : "力"}</i><span><small>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(event.starts_at))} · {snapshot.venues.find((entry) => entry.id === event.venue_id)?.name ?? "场地待选"}</small><h3>{event.title}</h3><p>{boundaryConflict ? "身体边界已更新；这项安排保留，但需要先生成适用版本" : calendarEventCopy(event)}</p></span><footer>{event.status === "planned" && <>{boundaryConflict ? <button className="sl-primary" onClick={onPlan}>查看并生成适用版本</button> : <button className="sl-primary" onClick={() => onStart(event)}>开始</button>}<button onClick={() => onReschedule(event)}>改期</button><button onClick={() => onSkip(event)}>这次不进行</button></>}</footer></article>;
    })}</div></section>)}</div> : <MonthCalendar events={events} /> : <div className="sl-empty-card"><i>日</i><h3>日历还是空的</h3><p>保存计划后可以把训练放到合适的星期；空白日不代表失败。</p></div>}
  </div>;
}

function MonthCalendar({ events }: { events: readonly FitnessCalendarEvent[] }) {
  const [anchor, setAnchor] = useState(() => new Date());
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first); start.setDate(first.getDate() - first.getDay());
  const days = Array.from({ length: 42 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return date; });
  const monthLabel = `${anchor.getFullYear()}年${anchor.getMonth() + 1}月`;
  const moveMonth = (delta: number) => setAnchor((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  return <section className="sl-month-shell">
    <header className="sl-month-controls"><button aria-label="查看上个月" onClick={() => moveMonth(-1)}>‹</button><strong>{monthLabel}</strong><button aria-label="查看下个月" onClick={() => moveMonth(1)}>›</button></header>
    {/* Keyboard focus is required because the 319px calendar is an intentional horizontal scroll region. */}
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
    <div className="sl-month" role="region" tabIndex={0} aria-label={`${monthLabel}训练日历，可横向滚动`}><header>{weekdayNames.map((day) => <span key={day}>{day.slice(1)}</span>)}</header><div>{days.map((date) => { const bounds = localDayBounds(date.getTime()); const rows = events.filter((event) => event.starts_at >= bounds.start && event.starts_at < bounds.end); const dateLabel = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(date); return <article aria-label={dateLabel} key={date.toISOString()} className={date.getMonth() === anchor.getMonth() ? "" : "muted"}><time dateTime={`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`}>{date.getDate()}</time>{rows.map((event) => { const status = event.status === "completed" ? "已练" : event.status === "not_performed" ? "未进行" : event.status === "cancelled" ? "已取消" : event.status === "in_progress" ? "进行中" : event.kind === "cardio" ? "心肺" : event.kind === "rest" ? "休息" : "力量"; return <span aria-label={`${event.title}，${calendarEventCopy(event)}`} title={event.title} key={event.id} className={`${event.kind} ${event.status}`}>{status}</span>; })}</article>; })}</div></div>
  </section>;
}

function HistoryView({ snapshot, onStart, onOpen }: { snapshot: FitnessSnapshot; onStart: () => void; onOpen: (sessionId: string) => void }) {
  const sessions = snapshot.sessions.filter((entry) => entry.status !== "active");
  return <div className="sl-page"><header className="sl-page-title"><div><span>WHAT ACTUALLY HAPPENED</span><h1>训练记录</h1><p>计划与实际分开保存；这里不计算连续天数或完成率。</p></div><button className="sl-primary" onClick={onStart}>＋ 临时训练</button></header>
    {sessions.length ? <div className="sl-history-list">{sessions.map((session) => {
      const rows = snapshot.sessionExercises.filter((entry) => entry.session_id === session.id);
      const actualRows = rows.filter((row) => row.substituted_for_exercise_id || snapshot.sets.some((set) => set.session_exercise_id === row.id && set.completed));
      const actualSets = snapshot.sets.filter((set) => actualRows.some((row) => row.id === set.session_exercise_id) && set.completed);
      const summary = actualRows.map((row) => getFitnessExercise(row.exercise_id)?.name_zh ?? row.exercise_id).join(" · ");
      const hasPainNote = actualSets.some((set) => set.pain_note);
      return <button type="button" className="sl-history-card" key={session.id} onClick={() => onOpen(session.id)} aria-label={`查看${new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(session.started_at))}训练详情`}><time><strong>{new Date(session.started_at).getDate()}</strong><span>{new Intl.DateTimeFormat("zh-CN", { month: "short" }).format(new Date(session.started_at))}</span></time><span className="sl-history-card-copy"><span>{snapshot.venues.find((entry) => entry.id === session.venue_id)?.name ?? "历史场地"}</span><span className="sl-history-card-title">{session.status === "ended_early" ? "保存到这里的训练" : "训练记录"}</span><span className="sl-history-card-summary">{summary || "这次只保存了训练时段，没有把未做的计划动作算作实际"}</span><span className="sl-history-card-facts"><b>{session.ended_at ? formatMinutes(session.ended_at - session.started_at) : 0} 分钟</b><b>{actualSets.length} 条实际记录</b>{actualRows.some((row) => row.substituted_for_exercise_id) && <b>有现场替代</b>}{hasPainNote && <b>有当时的不适记录</b>}</span></span><i aria-hidden="true">›</i></button>;
    })}</div> : <div className="sl-empty-card"><i>记</i><h3>第一条真实训练会从这里开始</h3><p>没有样例成绩，也不会把计划冒充成实际训练。</p><button className="sl-primary" onClick={onStart}>开始临时训练</button></div>}
  </div>;
}

function HistoryDetail({ snapshot, sessionId, unit, onSaveReflection }: {
  snapshot: FitnessSnapshot;
  sessionId: string;
  unit: "kg" | "lb";
  onSaveReflection: (sessionId: string, reflection: string) => Promise<void>;
}) {
  const session = snapshot.sessions.find((entry) => entry.id === sessionId) ?? null;
  const [editingReflection, setEditingReflection] = useState(false);
  const [reflectionDraft, setReflectionDraft] = useState(session?.reflection ?? "");
  const [savedReflection, setSavedReflection] = useState(session?.reflection ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  if (!session) return <p className="sl-empty-copy padded">这条训练记录已经不在当前数据库中。</p>;
  const rows = snapshot.sessionExercises.filter((entry) => entry.session_id === session.id).sort((a, b) => a.order_index - b.order_index);
  const actualRows = rows.filter((row) => row.substituted_for_exercise_id || snapshot.sets.some((set) => set.session_exercise_id === row.id && set.completed));
  const unperformed = rows.length - actualRows.length;
  const venue = snapshot.venues.find((entry) => entry.id === session.venue_id)?.name ?? "历史场地";
  const saveReflection = async () => {
    if (saving) return;
    setSaving(true); setSaveError(""); setSaved(false);
    try {
      await onSaveReflection(session.id, reflectionDraft);
      setSavedReflection(reflectionDraft.trim());
      setEditingReflection(false);
      setSaved(true);
    } catch (reason) {
      setSaveError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };
  return <div className="sl-history-detail">
    <header className="sl-history-detail-summary"><div><span>{new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(new Date(session.started_at))}</span><h3>{venue}</h3><p>{session.status === "ended_early" ? "这次训练保存到这里" : "这次训练已保存"} · {session.ended_at ? formatMinutes(session.ended_at - session.started_at) : 0} 分钟</p></div><strong>{actualRows.length}<small> 个实际动作</small></strong></header>
    {actualRows.length ? <section className="sl-history-actions" aria-label="实际训练内容">{actualRows.map((row) => {
      const exercise = getFitnessExercise(row.exercise_id);
      const original = row.substituted_for_exercise_id ? getFitnessExercise(row.substituted_for_exercise_id) : null;
      const sets = snapshot.sets.filter((set) => set.session_exercise_id === row.id && set.completed).sort((a, b) => a.set_index - b.set_index);
      const exerciseName = exercise?.name_zh ?? row.exercise_id;
      return <article key={row.id}><header><div><span>{exercise ? MOVEMENT_PATTERN_LABELS[exercise.pattern] : "历史动作"}</span><h4>{exerciseName}</h4></div><strong>{sets.length ? `${sets.length} 条记录` : "仅保存替代"}</strong></header>{original && <p className="sl-history-substitution">现场从「{original.name_zh}」换成这个动作{row.substitution_reason ? ` · ${row.substitution_reason}` : ""}</p>}{sets.length ? <ol aria-label={`${exerciseName}的实际组记录`}>{sets.map((set) => {
        const facts = set.duration_seconds !== null
          ? [`${Number((set.duration_seconds / 60).toFixed(1))} 分钟`, set.rpe !== null ? `RPE ${set.rpe}` : null]
          : [set.load_grams !== null ? displayLoad(set.load_grams, unit) : null, set.reps !== null ? `${set.reps} 次` : null, set.rir !== null ? `RIR ${set.rir}` : null];
        return <li key={set.id}><i aria-hidden="true">{set.set_index + 1}</i><div><span>{facts.filter(Boolean).join(" · ") || "只保存了这一条组记录"}</span>{set.pain_note && <div className="sl-history-pain" role="note" aria-label="当时的不适记录"><b>你当时写下</b><p>{set.pain_note}</p><small>这是你的原始记录，不是诊断，也不会自动改变计划或身体边界。</small></div>}</div></li>;
      })}</ol> : <p className="sl-history-no-sets">这次保存了现场替代关系，但没有保存组数或时长；适练不会把它补成已完成数据。</p>}</article>;
    })}</section> : <p className="sl-empty-copy padded">这次只保存了训练时段，没有把计划动作算作实际完成。</p>}
    {unperformed > 0 && <p className="sl-history-unperformed">另有 {unperformed} 个计划动作没有实际记录，因此没有列在上面。</p>}
    <section className="sl-history-reflection"><header><div><span>训练复盘</span><p>只保存在这条本地记录中；空白也可以。</p></div>{!editingReflection && <button type="button" onClick={() => { setReflectionDraft(savedReflection); setSaveError(""); setSaved(false); setEditingReflection(true); }}>{savedReflection ? "编辑" : "写一点"}</button>}</header>{editingReflection ? <><label><span className="sl-visually-hidden">训练复盘</span><textarea value={reflectionDraft} onChange={(event) => setReflectionDraft(event.target.value)} maxLength={4000} placeholder="例如：哪个动作更顺、下次想保留什么。无需做评价。" /></label><footer><button type="button" disabled={saving} onClick={() => { setReflectionDraft(savedReflection); setSaveError(""); setEditingReflection(false); }}>取消</button><button type="button" className="sl-primary" disabled={saving} onClick={() => void saveReflection()}>{saving ? "正在保存…" : "保存复盘"}</button></footer></> : <p>{savedReflection || "这次没有写复盘。"}</p>}{saveError && <p className="sl-inline-error" role="alert">{saveError}</p>}{saved && <p className="sl-inline-success" role="status">复盘已保存。</p>}</section>
  </div>;
}

function ExercisesView({ equipment, equipmentLoads, venue }: { equipment: readonly FitnessEquipment[]; equipmentLoads: readonly FitnessEquipmentLoad[]; venue: FitnessVenue | null }) {
  const [query, setQuery] = useState("");
  const [showOther, setShowOther] = useState(false);
  const visible = FITNESS_EXERCISES.filter((exercise) => (showOther || exerciseFitsEquipment(exercise, equipment, equipmentLoads)) && `${exercise.name_zh}${exercise.name_en}${exercise.primary_muscles.join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="sl-page"><header className="sl-page-title"><div><span>MOVEMENT LIBRARY</span><h1>动作库</h1><p>{venue ? `默认只显示能在「${venue.name}」完成的动作。` : "选择场地后才能判断动作是否真实可执行。"}</p></div></header><div className="sl-filterbar"><label><span aria-hidden="true">⌕</span><input aria-label="搜索动作或肌群" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索动作或肌群" /></label><button aria-pressed={showOther} className={showOther ? "active" : ""} onClick={() => setShowOther((value) => !value)}>{showOther ? "正在查看所有动作" : "查看其他场地动作"}</button></div>{visible.length ? <div className="sl-exercise-grid">{visible.map((exercise) => { const fits = exerciseFitsEquipment(exercise, equipment, equipmentLoads); return <article key={exercise.id}><header><i>{MOVEMENT_PATTERN_LABELS[exercise.pattern].slice(0, 1)}</i><span>{MOVEMENT_PATTERN_LABELS[exercise.pattern]}</span></header><h2>{exercise.name_zh}</h2><p>{exercise.name_en}</p><dl><div><dt>主要</dt><dd>{exercise.primary_muscles.join("、")}</dd></div><div><dt>需要</dt><dd><EquipmentRequirementList kinds={exercise.requirements.map((entry) => entry.kind)} /></dd></div></dl><footer><span className={fits ? "available" : "other"}>{fits ? `可在${venue ? `「${venue.name}」` : "当前场地"}完成` : "当前场地缺少器材或成对档位"}</span></footer></article>; })}</div> : <div className="sl-empty-card"><i>动</i><h3>当前场地没有符合条件的动作</h3><p>补充器材清单、换一个搜索词，或显式查看其他场地动作。</p></div>}</div>;
}

function constraintScopeText(entry: FitnessConstraint) {
  const patterns = entry.movement_patterns.map((pattern) => MOVEMENT_PATTERN_LABELS[pattern]);
  const exercises = entry.exercise_ids.map((id) => getFitnessExercise(id)?.name_zh ?? id);
  const scope = [...patterns, ...exercises];
  return scope.length ? scope.join("、") : "范围待补充，当前不参与规划";
}

function ProfileView({ snapshot, busy, onProfile, onConstraint, onToggleConstraint }: {
  snapshot: FitnessSnapshot;
  busy: boolean;
  onProfile: () => void;
  onConstraint: (constraint: FitnessConstraint | null) => void;
  onToggleConstraint: (constraint: FitnessConstraint) => void;
}) {
  return <div className="sl-page">
    <header className="sl-page-title"><div><span>TIME, GOALS & BOUNDARIES</span><h1>身体与偏好</h1><p>只记录真正影响规划的内容；身体状态不会被压成一个分数。</p></div><button className="sl-primary" onClick={onProfile}>{snapshot.profile ? "编辑偏好" : "建立偏好"}</button></header>
    {snapshot.profile ? <section className="sl-profile-card"><div><span>规划输入</span><h2>{snapshot.profile.goals.map((goal) => goalLabels[goal]).join(" · ")}</h2><p>{snapshot.profile.resistance_days_per_week} 次力量 · {snapshot.profile.cardio_days_per_week} 次有氧 · 单次约 {snapshot.profile.session_minutes} 分钟</p></div><dl><div><dt>经验</dt><dd>{snapshot.profile.experience === "new" ? "刚开始" : snapshot.profile.experience === "returning" ? "重新开始" : snapshot.profile.experience === "consistent" ? "稳定训练" : "自主规划"}</dd></div><div><dt>训练日</dt><dd>{snapshot.profile.preferred_weekdays.map((day) => weekdayNames[day]).join("、") || "随时调整"}</dd></div><div><dt>默认余力</dt><dd>RIR {snapshot.profile.preferred_rir}</dd></div></dl></section> : <div className="sl-empty-card"><i>人</i><h3>偏好还是空的</h3><p>没有填写的内容就是未知，适练不会用默认值冒充你的选择。</p><button className="sl-primary" onClick={onProfile}>保存第一组偏好</button></div>}
    <section className="sl-constraint-head"><div><span>身体边界</span><p>硬边界会过滤未来草稿；提醒不会自动变成诊断。</p></div><button onClick={() => onConstraint(null)}>＋ 记录一条</button></section>
    {snapshot.constraints.length ? <div className="sl-constraint-list">{snapshot.constraints.map((entry) => <article key={entry.id} className={entry.active ? "" : "inactive"}><i className={entry.severity}>{entry.severity === "avoid" ? "避" : entry.severity === "modify" ? "调" : "注"}</i><span><h3>{entry.label}</h3><p>{constraintScopeText(entry)}</p>{entry.note && <small>{entry.note}</small>}</span><div className="sl-constraint-controls"><strong>{entry.active ? "生效中" : "已结束"}</strong><button onClick={() => onConstraint(entry)}>编辑</button><button disabled={busy} onClick={() => onToggleConstraint(entry)}>{entry.active ? "暂时结束" : "重新启用"}</button></div></article>)}</div> : <p className="sl-empty-copy padded">没有记录身体边界不等于系统确认“没有限制”；规划只会按已知信息工作。</p>}
  </div>;
}

function SettingsView({ snapshot, storage, onPersist, onChange, onRestored }: { snapshot: FitnessSnapshot; storage: LocalStorageEstimate | null; onPersist: () => void; onChange: (settings: FitnessSnapshot["settings"]) => void; onRestored: () => Promise<void> }) {
  const settings = snapshot.settings;
  return <div className="sl-page"><header className="sl-page-title"><div><span>PRIVACY & DATA</span><h1>设置</h1><p>训练和身体资料留在当前浏览器；AI 只在你点击时收到最小草稿上下文。</p></div></header><div className="sl-settings">
    <section><header><h2>AI 与隐私</h2><p>没有 AI 时，器材、计划、日历与训练记录仍可使用。</p></header><SettingSwitch label="允许 AI 草稿" copy="只发送结构化器材、频次与能力数字；不发送用户填写的自由文本" checked={settings.ai_enabled} onChange={(value) => onChange({ ...settings, ai_enabled: value })}/><div className="sl-privacy-fact"><i/><span><b>DeepSeek Key 只在服务端</b><small>不会进入 SQLite、完整备份或浏览器资源</small></span></div></section>
    <section><header><h2>当前浏览器</h2><p>OPFS 与 SQLite 都绑定当前 origin 和浏览器 profile。</p></header><div className={`sl-storage ${storage?.persisted ? "persisted" : ""}`}><i/><span><b>{storage?.persisted ? "已获浏览器持久化保护" : "仍可能被浏览器清理"}</b><small>{storage ? `当前使用约 ${Math.max(1, Math.round(storage.usage / 1024))} KB` : "正在读取存储状态"}</small></span>{!storage?.persisted && <button onClick={onPersist}>请求保护</button>}</div><p className="sl-data-note">持久化授权不是备份；清理站点数据仍可能删除当前浏览器资料。</p></section>
    <section><header><h2>完整备份与恢复</h2><p>SQLite 与器材照片一起校验；失败时不会原位覆盖当前版本。</p></header><FitnessDataControls onRestored={onRestored}/></section>
  </div></div>;
}

function SettingSwitch({ label, copy, checked, onChange }: { label: string; copy: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <div className="sl-setting-row"><span><b>{label}</b><small>{copy}</small></span><button role="switch" aria-label={label} aria-checked={checked} className={checked ? "on" : ""} onClick={() => onChange(!checked)}><i/></button></div>;
}

function PlanDraftPreview({ draft, snapshot, busy, onSave }: { draft: FitnessPlanDraft; snapshot: FitnessSnapshot; busy: boolean; onSave: () => void }) {
  return <div className="sl-draft"><section className="sl-draft-context"><div><span>使用场地</span><strong>{snapshot.venues.find((entry) => entry.id === draft.venue_id)?.name}</strong></div><div><span>每周安排</span><strong>{draft.days.filter((day) => day.kind === "resistance").length} 力量 · {draft.days.filter((day) => day.kind === "cardio").length} 心肺</strong></div><div><span>精确重量</span><strong>未知时保持待校准</strong></div></section>{draft.assumptions.length > 0 && <aside><span>当前假设</span><ul>{draft.assumptions.map((entry) => <li key={entry}>{entry}</li>)}</ul></aside>}<div className="sl-draft-days">{draft.days.map((day, index) => <article key={`${day.name}-${index}`}><header><span>{day.weekday === null ? `第 ${index + 1} 天` : weekdayNames[day.weekday]}</span><h3>{day.name}</h3><p>{day.focus} · 约 {day.estimated_minutes} 分钟</p></header>{day.items.map((item) => <div key={`${item.exercise_id}-${item.order_index}`}><span><b>{getFitnessExercise(item.exercise_id)?.name_zh}</b><small>{snapshot.equipment.find((entry) => entry.id === item.equipment_id)?.name ?? "自重"} · {item.load_guidance}</small></span><strong>{item.sets} × {item.rep_min ?? "计时"}{item.rep_max && item.rep_max !== item.rep_min ? `–${item.rep_max}` : ""}</strong></div>)}</article>)}</div>{draft.warnings.length > 0 && <aside className="warning"><span>仍需确认</span><ul>{draft.warnings.map((entry) => <li key={entry}>{entry}</li>)}</ul></aside>}<footer><p>保存后会成为新版本；原计划和历史不会被改写。</p><button className="sl-primary" disabled={busy} onClick={onSave}>{busy ? "正在校验…" : "保存并放入日历"}</button></footer></div>;
}

function AiDraftPreview({ draft, busy, onApply }: { draft: AiPlanDraft; busy: boolean; onApply: () => void }) {
  return <div className="sl-ai-draft"><div className="sl-ai-boundary"><i>AI</i><span><b>尚未写入本地计划</b><small>下一步仍会经过本地动作 ID、器材与时长校验。</small></span></div><h3>{draft.title}</h3><p>{draft.rationale}</p><div>{draft.days.map((day) => <article key={day.day_key}><header><span>{day.label}</span><strong>{day.estimated_minutes} 分钟</strong></header>{day.items.map((item) => <div key={item.exercise_id}><b>{item.exercise_name}</b><small>{item.sets} 组 · {item.load_rule.instruction}</small></div>)}</article>)}</div>{draft.questions.length > 0 && <aside><span>AI 仍需要你确认</span>{draft.questions.map((question) => <p key={question}>{question}</p>)}</aside>}<footer><button className="sl-primary" disabled={busy} onClick={onApply}>交给本地规则校验</button></footer></div>;
}

function RescheduleForm({ event, busy, onClose, onSave }: { event: FitnessCalendarEvent; busy: boolean; onClose: () => void; onSave: (startsAt: number) => void }) {
  const [localValue, setLocalValue] = useState(() => toLocalDateTimeInputValue(event.starts_at));
  const [validationError, setValidationError] = useState("");
  const errorId = "sl-reschedule-time-error";
  return <form className="sl-form" aria-busy={busy || undefined} onSubmit={(formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (busy) return;
    const resolution = resolveLocalDateTimeInput(localValue, event.starts_at);
    if (resolution.status !== "valid") {
      setValidationError(resolution.status === "ambiguous"
        ? "这个本地时间会在夏令时切换时出现两次。请选择前后一个明确时间。"
        : resolution.status === "nonexistent"
          ? "这个本地时间在夏令时切换时不存在。请选择其他时间。"
          : "请输入有效的日期与时间。");
      return;
    }
    onSave(resolution.timestamp);
  }}><p className="sl-safety-copy">改期只移动计划，不会制造一条“漏练”记录；时区切换时也不会静默改变一小时。</p><label><span>新的日期与时间</span><input required disabled={busy} name="startsAt" type="datetime-local" value={localValue} aria-invalid={validationError ? true : undefined} aria-describedby={validationError ? errorId : undefined} onChange={(changeEvent) => { setLocalValue(changeEvent.target.value); setValidationError(""); }}/></label>{validationError && <p id={errorId} className="sl-form-error" role="alert">{validationError}</p>}{busy && <span className="sl-visually-hidden" role="status">正在保存新的训练时间，请稍候</span>}<footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="sl-primary" disabled={busy}>{busy ? "正在保存…" : "确认改期"}</button></footer></form>;
}

function MoreDialog({ open, current, onClose, onView }: { open: boolean; current: FitnessView; onClose: () => void; onView: (view: FitnessView) => void }) {
  const dialog = useFitnessDialog<HTMLElement>(open, onClose, "button");
  if (!open) return null;
  const pages: Array<[FitnessView, string, string]> = [["exercises", "动作库", "只看当前场地真正可做的动作"], ["profile", "身体与偏好", "目标、时间和身体边界"], ["settings", "设置与隐私", "本地存储、AI 和数据"]];
  return <><button className="sl-scrim" onClick={onClose} aria-label="关闭更多页面"/><aside ref={dialog} className="sl-more-sheet" role="dialog" aria-modal="true" aria-label="更多页面" tabIndex={-1}><header><span>更多</span><button data-dialog-close onClick={onClose} aria-label="关闭更多页面">×</button></header>{pages.map(([id, label, copy]) => <button key={id} aria-current={current === id ? "page" : undefined} onClick={() => onView(id)}><i>{label.slice(0, 1)}</i><span><b>{label}</b><small>{copy}</small></span><strong>→</strong></button>)}<Link href="/"><i>台</i><span><b>私人工作台</b><small>返回各个独立空间的入口</small></span><strong>→</strong></Link></aside></>;
}

function LiveSession({ snapshot, sessionId, now, onRefresh, onToast, toast, error, setError, dialog, setDialog, selectedExerciseId, setSelectedExerciseId, onExit }: { snapshot: FitnessSnapshot; sessionId: string; now: number; onRefresh: () => Promise<void>; onToast: (message: string) => void; toast: string; error: string; setError: (message: string) => void; dialog: DialogState; setDialog: (dialog: DialogState) => void; selectedExerciseId: string | null; setSelectedExerciseId: (id: string | null) => void; onExit: () => void }) {
  const [mutationBusy, setMutationBusy] = useState(false);
  const session = snapshot.sessions.find((entry) => entry.id === sessionId)!;
  const rows = snapshot.sessionExercises.filter((entry) => entry.session_id === sessionId).sort((a, b) => a.order_index - b.order_index);
  const current = rows.find((entry) => entry.status === "active") ?? rows.find((entry) => entry.status === "pending") ?? null;
  const sets = current ? snapshot.sets.filter((entry) => entry.session_exercise_id === current.id) : [];
  const planned = current?.planned_item_id ? snapshot.programItems.find((entry) => entry.id === current.planned_item_id) ?? null : null;
  const equipment = current?.equipment_id ? snapshot.equipment.find((entry) => entry.id === current.equipment_id) ?? null : null;
  const venue = snapshot.venues.find((entry) => entry.id === session.venue_id) ?? null;
  const unit = snapshot.profile?.unit ?? snapshot.settings.unit;
  const sessionEquipment = snapshot.equipment.filter((entry) => entry.venue_id === session.venue_id);
  const sessionEquipmentIds = new Set(sessionEquipment.map((entry) => entry.id));
  const sessionLoads = snapshot.equipmentLoads.filter((entry) => sessionEquipmentIds.has(entry.equipment_id));
  const availableExercises = exercisesForVenue(sessionEquipment, sessionLoads).filter((exercise) =>
    !snapshot.constraints.some((constraint) =>
      constraint.active && constraint.severity === "avoid" &&
      (constraint.exercise_ids.includes(exercise.id) || constraint.movement_patterns.includes(exercise.pattern))),
  );
  const currentExercise = current ? getFitnessExercise(current.exercise_id) : null;
  const isTimed = currentExercise?.pattern === "cardio" || planned?.duration_seconds !== null && planned?.duration_seconds !== undefined;
  const relevantConstraints = currentExercise ? snapshot.constraints.filter((constraint) =>
    constraint.active && (constraint.exercise_ids.includes(currentExercise.id) || constraint.movement_patterns.includes(currentExercise.pattern)),
  ) : [];
  const actualRowCount = rows.filter((row) => snapshot.sets.some((set) => set.session_exercise_id === row.id && set.completed)).length;
  const mutate = async (operation: () => Promise<void>, success: string) => {
    if (mutationBusy) return;
    setMutationBusy(true); setError("");
    try {
      await operation();
      await onRefresh();
      onToast(success);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setMutationBusy(false);
    }
  };
  const record = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (!current || mutationBusy) return;
    const data = new FormData(formEvent.currentTarget);
    const weight = String(data.get("weight") ?? "").trim();
    const durationMinutes = String(data.get("durationMinutes") ?? "").trim();
    setMutationBusy(true); setError("");
    try {
      const id = await recordFitnessSet({
        sessionExerciseId: current.id,
        setIndex: sets.length,
        setKind: "work",
        loadGrams: weight ? Math.round(Number(weight) * (unit === "kg" ? 1_000 : 453.59237)) : null,
        reps: isTimed ? null : String(data.get("reps") ?? "") ? Number(data.get("reps")) : null,
        durationSeconds: isTimed && durationMinutes ? Math.round(Number(durationMinutes) * 60) : null,
        rir: !isTimed && String(data.get("rir") ?? "") ? Number(data.get("rir")) : null,
        rpe: isTimed && String(data.get("rpe") ?? "") ? Number(data.get("rpe")) : null,
        painNote: String(data.get("pain") ?? ""),
        clientMutationId: crypto.randomUUID(),
      });
      await onRefresh();
      onToast(isTimed ? "这段时长已保存在本地" : "这一组已保存在本地");
      (formEvent.currentTarget.elements.namedItem(isTimed ? "durationMinutes" : "reps") as HTMLInputElement | null)?.focus();
      return id;
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setMutationBusy(false);
    }
  };
  const finish = async (endedEarly: boolean) => {
    if (mutationBusy) return;
    if (!window.confirm(endedEarly ? "已经完成的部分会保留。保存到这里并离开吗？" : "结束这场训练并保留实际记录吗？")) return;
    setMutationBusy(true); setError("");
    try {
      await finishFitnessSession(session.id, { endedEarly });
      await onRefresh(); onExit();
      onToast(endedEarly ? "已保存到这里" : "这场训练已保存");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setMutationBusy(false); }
  };
  return <main className="shilian sl-live">
    <header><Logo/><div><span>{venue?.name ?? "当前场地"}</span><strong>{formatMinutes(now - session.started_at)} 分钟</strong><small>每条实际记录即时保存</small></div><button disabled={mutationBusy} onClick={() => void finish(true)}>保存并离开</button></header>
    {rows.length ? <>
      <nav aria-label="本场动作">{rows.map((row, index) => <span key={row.id} aria-current={current?.id === row.id ? "step" : undefined} className={`${row.status} ${current?.id === row.id ? "active" : ""}`}><i>{row.status === "completed" ? "✓" : index + 1}</i><b>{getFitnessExercise(row.exercise_id)?.name_zh ?? row.exercise_id}</b></span>)}</nav>
      {current ? <section className="sl-live-focus">
        <div className="sl-live-index"><span>{isTimed ? "TIME" : "NEXT SET"}</span><strong>{isTimed ? Math.max(1, Math.round((planned?.duration_seconds ?? 60) / 60)) : Math.min(sets.length + 1, planned?.sets ?? sets.length + 1)}</strong><small>{isTimed ? "分钟目标" : `/ ${planned?.sets ?? "自由"}`}</small></div>
        <article>
          <header><div><span>{MOVEMENT_PATTERN_LABELS[currentExercise?.pattern ?? "isolation"]}</span><h1>{currentExercise?.name_zh ?? current.exercise_id}</h1><p>{currentExercise?.name_en}</p></div><aside><span>使用器材</span><strong>{equipment?.name ?? "自重"}</strong><small>{equipment?.notes || "没有个人设置备注"}</small></aside></header>
          <div className="sl-live-prescription"><span><small>目标</small><strong>{isTimed ? `${Math.max(1, Math.round((planned?.duration_seconds ?? 60) / 60))} 分钟` : `${planned?.sets ?? "自定"} 组 × ${planned?.rep_min ?? "自定"}${planned?.rep_max && planned.rep_max !== planned.rep_min ? `–${planned.rep_max}` : ""}`}</strong></span><span><small>{isTimed ? "强度" : "负荷"}</small><strong>{planned?.load_guidance ?? (isTimed ? "以可持续主观强度完成" : "从保守负荷开始")}</strong></span><span><small>休息</small><strong>{planned?.rest_seconds ?? snapshot.profile?.rest_seconds ?? 90} 秒</strong></span></div>
          {relevantConstraints.length > 0 && <aside className="sl-live-boundaries" aria-label="与当前动作相关的身体边界"><span>本场提醒</span><div>{relevantConstraints.map((constraint) => <p key={constraint.id}><b>{constraint.severity === "avoid" ? "停止并换动作" : constraint.severity === "modify" ? "按记录调整" : "留意"}</b>{constraint.label}{constraint.note ? `：${constraint.note}` : ""}</p>)}</div></aside>}
          <form className="sl-set-form" onSubmit={(event) => void record(event)}>
            {isTimed ? <label><span>实际时长 <small>分钟</small></span><input required inputMode="decimal" name="durationMinutes" type="number" min="0.5" max="1440" step="0.5" defaultValue={sets.at(-1)?.duration_seconds ? Number((sets.at(-1)!.duration_seconds! / 60).toFixed(1)) : Math.max(1, Math.round((planned?.duration_seconds ?? 60) / 60))}/></label> : <><label><span>重量 <small>{unit}</small></span><input inputMode="decimal" name="weight" type="number" min="0" step="0.01" defaultValue={sets.at(-1)?.load_grams ? Number((sets.at(-1)!.load_grams! / (unit === "kg" ? 1_000 : 453.59237)).toFixed(2)) : ""} placeholder="可留空"/></label><label><span>次数</span><input required inputMode="numeric" name="reps" type="number" min="0" max="1000" defaultValue={sets.at(-1)?.reps ?? planned?.rep_min ?? ""}/></label></>}
            {isTimed ? <label><span>主观强度 <small>RPE</small></span><input inputMode="numeric" name="rpe" type="number" min="1" max="10" defaultValue={sets.at(-1)?.rpe ?? ""} placeholder="1–10，可跳过"/></label> : <label><span>还可做几次 <small>RIR</small></span><input inputMode="numeric" name="rir" type="number" min="0" max="5" defaultValue={snapshot.profile?.preferred_rir ?? ""} placeholder="可跳过"/></label>}
            <label className="sl-pain-field"><span>有不适？（可选）</span><input name="pain" placeholder="出现疼痛时先停下，不用完成这条记录"/></label>
            <button className="sl-live-record" disabled={mutationBusy}>{mutationBusy ? "正在保存…" : isTimed ? "记录这段时长" : "记录这一组"}</button>
          </form>
          {sets.length > 0 && <div className="sl-set-history"><header><span>这次已经记录</span><small>撤销只删除对应这一条</small></header>{sets.map((set) => <div key={set.id}><i>{set.set_index + 1}</i><span><b>{set.duration_seconds !== null ? `${Number((set.duration_seconds / 60).toFixed(1))} 分钟` : displayLoad(set.load_grams, unit)}</b><small>{set.duration_seconds !== null ? `计时记录 · RPE ${set.rpe ?? "—"}` : `${set.reps ?? "—"} 次 · RIR ${set.rir ?? "—"}`}</small></span>{set.pain_note && <em>已记不适</em>}<button disabled={mutationBusy} aria-label={`撤销第${set.set_index + 1}条记录`} onClick={() => void mutate(() => undoFitnessSet(set.id), "已撤销这一条记录")}>↶</button></div>)}</div>}
          <footer className="sl-live-actions"><button disabled={mutationBusy} onClick={() => { setSelectedExerciseId(current.id); setDialog("substitution"); }}>器材被占 / 换动作</button><button disabled={mutationBusy} onClick={() => void mutate(() => completeSessionExercise(current.id, true), "已跳过这个动作，不会变成欠账")}>今天不做这个动作</button><button disabled={mutationBusy} className="sl-primary" onClick={() => void mutate(() => completeSessionExercise(current.id), "动作已保存到这里")}>完成这个动作</button></footer>
        </article>
      </section> : <section className="sl-live-done"><span>THIS SESSION, SO FAR</span><h1>本场动作已到这里。</h1><p>没有新的记录表单。你可以结束保存，或按当前场地再加一个动作。</p><button disabled={mutationBusy} onClick={() => setDialog("exercise-picker")}>＋ 再加一个动作</button></section>}
    </> : <section className="sl-live-empty"><span>临时训练</span><h1>从现在想做的动作开始。</h1><p>只会显示当前场地真实可完成的动作；第一次负荷不用猜。</p><button disabled={mutationBusy} className="sl-primary" onClick={() => setDialog("exercise-picker")}>＋ 添加一个动作</button></section>}
    <footer className="sl-live-bottom"><span>{actualRowCount} 个动作有实际记录</span><button disabled={mutationBusy} onClick={() => void finish(false)}>结束并保存</button></footer>
    <ExercisePicker open={dialog === "exercise-picker"} title="添加现场动作" exercises={availableExercises} equipment={sessionEquipment} equipmentLoads={sessionLoads} onClose={() => { if (!mutationBusy) { setDialog(null); setSelectedExerciseId(null); } }} onPick={async (exercise) => { const resources = resourcesForExercise(exercise, sessionEquipment, sessionLoads) ?? []; const primary = resources[0] ?? null; await mutate(async () => { await addSessionExercise(session.id, exercise.id, primary, JSON.stringify(resources)); setDialog(null); setSelectedExerciseId(null); }, "动作已加入这次训练"); }} />
    <ExercisePicker open={dialog === "substitution"} title="换一个现在能做的版本" exercises={current ? availableExercises.filter((exercise) => exercise.pattern === currentExercise?.pattern && exercise.id !== current.exercise_id) : []} equipment={sessionEquipment} equipmentLoads={sessionLoads} onClose={() => { if (!mutationBusy) { setDialog(null); setSelectedExerciseId(null); } }} onPick={async (exercise) => { if (!selectedExerciseId) return; const resources = resourcesForExercise(exercise, sessionEquipment, sessionLoads) ?? []; await mutate(async () => { await substituteSessionExercise({ sessionExerciseId: selectedExerciseId, exerciseId: exercise.id, equipmentId: resources[0] ?? null, reason: "器材占用或现场调整" }); setDialog(null); setSelectedExerciseId(null); }, "只调整了本次训练，未来计划没有被悄悄修改"); }} />
    {error && <div className="sl-error-toast" role="alert"><span>需要确认</span>{error}<button onClick={() => setError("")} aria-label="关闭错误">×</button></div>}
    {toast && <div className="sl-toast" role="status"><i>✓</i>{toast}</div>}
  </main>;
}

function ExercisePicker({ open, title, exercises, equipment, equipmentLoads, onClose, onPick }: { open: boolean; title: string; exercises: readonly FitnessExercise[]; equipment: readonly FitnessEquipment[]; equipmentLoads: readonly FitnessEquipmentLoad[]; onClose: () => void; onPick: (exercise: FitnessExercise) => Promise<void> }) {
  const [query, setQuery] = useState("");
  return <FitnessDialog open={open} eyebrow="CURRENT VENUE ONLY" title={title} onClose={onClose} wide><div className="sl-picker"><label><span aria-hidden="true">⌕</span><input aria-label="搜索现场动作" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索动作"/></label><div>{exercises.filter((exercise) => `${exercise.name_zh}${exercise.name_en}`.toLowerCase().includes(query.toLowerCase())).map((exercise) => <button key={exercise.id} onClick={() => void onPick(exercise)}><i>{MOVEMENT_PATTERN_LABELS[exercise.pattern].slice(0, 1)}</i><span><b>{exercise.name_zh}</b><small><EquipmentRequirementList kinds={exercise.requirements.map((entry) => entry.kind)}/></small></span><strong>{exerciseFitsEquipment(exercise, equipment, equipmentLoads) ? "可执行" : "缺器材或成对档位"}</strong></button>)}</div>{!exercises.length && <p className="sl-empty-copy padded">当前场地没有同目的、且器材完整的替代动作。可以先做后续动作。</p>}</div></FitnessDialog>;
}
