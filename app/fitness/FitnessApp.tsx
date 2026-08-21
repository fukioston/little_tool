"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
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
  FitnessConfigMutationError,
  initializeFitnessDatabase,
  loadFitnessSettingsExpectedState,
  loadFitnessSnapshot,
  prepareFitnessSettingsSave,
  prepareFitnessProgramVersionSchedule,
  prepareFitnessProgramWeekSchedule,
  prepareFitnessCalendarReschedule,
  prepareFitnessCalendarNotPerformed,
  prepareFitnessProfileSave,
  prepareFitnessVenueSave,
  prepareFitnessVenueArchive,
  prepareFitnessVenueRestore,
  prepareFitnessEquipmentSave,
  prepareFitnessEquipmentStatus,
  prepareFitnessConstraintSave,
  prepareFitnessConstraintActive,
  prepareFitnessSetRecord,
  prepareFitnessSetUndo,
  prepareFitnessSessionFinish,
  prepareFitnessEmptySessionCancel,
  prepareFitnessLiveSessionStart,
  prepareFitnessLiveExerciseAdd,
  prepareFitnessLiveExerciseComplete,
  prepareFitnessLiveExerciseSubstitute,
  prepareFitnessLiveSessionReflection,
  fitnessLiveExerciseExpectationFromSnapshot,
  fitnessLiveSessionExpectationFromSnapshot,
  fitnessLiveStartExpectationFromSnapshot,
  fitnessLiveAddExpectationFromSnapshot,
  fitnessLiveSubstituteExpectationFromSnapshot,
  fitnessProgramVersionScheduleExpectationFromSnapshot,
  fitnessProgramWeekScheduleExpectationFromSnapshot,
  type FitnessConfigWriteReceipt,
  type FitnessEquipmentWriteSnapshot,
  type FitnessLiveExerciseExpectation,
  type FitnessLiveWriteReceipt,
  type FitnessLiveStructureWriteReceipt,
  type FitnessProgramVersionScheduleExpectation,
  type FitnessSettingsWriteSnapshot,
  type PrepareFitnessLiveSessionStartInput,
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
  FitnessSession,
  FitnessSnapshot,
  FitnessVenue,
  FitnessView,
} from "@/lib/fitness/types";
import {
  estimateLocalStorage,
  requestPersistentLocalStorage,
  supportsPersistentLocalStorage,
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
import {
  FitnessConfigWriteBanner,
  FitnessConfigWriteRecovery,
  useFitnessConfigWriteFlow,
} from "./FitnessConfigWriteFlow";
import {
  FitnessLiveWriteBanner,
  FitnessLiveWriteRecovery,
  useFitnessLiveWriteFlow,
  type FitnessLiveWriteController,
} from "./FitnessLiveWriteFlow";
import {
  FitnessPlanCalendarWriteBanner,
  FitnessPlanCalendarWriteRecovery,
  useFitnessPlanCalendarWriteFlow,
  type FitnessPlanCalendarWriteController,
} from "./FitnessPlanCalendarWriteFlow";
import type { FitnessPlanCalendarWriteReceipt } from "./plan-calendar-write-journal";
import {
  fitnessActiveSessionRouteChanged,
  fitnessDirtyConfigDialogBlocksRouteChange,
  resolveFitnessFactsRead,
  resolveFitnessReflectionDraftAction,
  shouldMarkFitnessFactsReadStale,
  type FitnessFactsRefreshOutcome,
} from "./live-refresh-gate";
import {
  FITNESS_FILE_OPERATION_PREFIX,
  readFitnessFileOperationJournal,
  type FitnessFileOperationEntry,
  type FitnessFileOperationJournal,
} from "./file-operation-journal";
import {
  formatFitnessStorageBytes,
  resolveFitnessNavigationBehavior,
  resolveScheduledFitnessStartRoute,
} from "./fitness-ui-logic";

const navigation: Array<{ id: FitnessView; label: string; glyph: string }> = [
  { id: "today", label: "今日", glyph: "今" },
  { id: "plan", label: "计划", glyph: "划" },
  { id: "calendar", label: "日历", glyph: "日" },
  { id: "venues", label: "场地", glyph: "场" },
  { id: "history", label: "记录", glyph: "记" },
];

const subscribeToOrigin = () => () => undefined;
const readClientOrigin = () => window.location.origin;
const readServerOrigin = () => "";

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

function equipmentWriteSnapshot(
  snapshot: FitnessSnapshot,
  equipment: FitnessEquipment,
): FitnessEquipmentWriteSnapshot {
  return {
    equipment,
    loads: snapshot.equipmentLoads
      .filter((entry) => entry.equipment_id === equipment.id)
      .sort((left, right) =>
        left.load_grams - right.load_grams ||
        left.label.localeCompare(right.label) ||
        left.id.localeCompare(right.id)),
  };
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
  | "profile"
  | "constraint"
  | "venue-archive"
  | "plan-preview"
  | "ai-preview"
  | "exercise-picker"
  | "substitution"
  | "reschedule"
  | "calendar-not-performed"
  | "venue-start-choice"
  | "history-detail"
  | "config-recovery"
  | "live-recovery"
  | "plan-calendar-recovery"
  | "more";

type ScheduledStartChoice = Readonly<{
  requestId: number;
  event: FitnessCalendarEvent;
}>;

type FitnessStorageReadStatus = "loading" | "ready" | "error";
type FitnessSnapshotReadStatus = "ready" | "stale";
type FitnessLiveDraftGate =
  | Readonly<{ kind: "set"; dirty: true; sessionId: string; exerciseId: string }>
  | Readonly<{ kind: "reflection"; dirty: true; sessionId: string }>;
type EquipmentPanel = "details" | "photos";
type EquipmentPhotoTarget = Readonly<{
  id: string;
  name: string;
  recoveryOnly: boolean;
}>;

type FitnessFileJournalView = FitnessFileOperationJournal & Readonly<{ loaded: boolean }>;
type FitnessFactsReadBundle = Readonly<{
  snapshot: FitnessSnapshot;
  expected: FitnessSettingsWriteSnapshot;
}>;

const EMPTY_FILE_JOURNAL: FitnessFileJournalView = {
  loaded: false,
  entries: [],
  unreadable: [],
  unavailable: false,
};

function sameFitnessSettings(
  left: FitnessSnapshot["settings"],
  right: FitnessSnapshot["settings"],
) {
  return left.unit === right.unit &&
    left.rest_timer_enabled === right.rest_timer_enabled &&
    left.sound_enabled === right.sound_enabled &&
    left.ai_enabled === right.ai_enabled;
}

function sameFitnessSettingsExpectedState(
  left: FitnessSettingsWriteSnapshot,
  right: FitnessSettingsWriteSnapshot,
) {
  return left.generationId === right.generationId &&
    left.generationSequence === right.generationSequence &&
    sameFitnessSettings(left.settings, right.settings) &&
    left.rows.every((row, index) => {
      const other = right.rows[index];
      return row === null || other === null
        ? row === other
        : row.key === other.key && row.value === other.value && row.updated_at === other.updated_at;
    });
}

async function loadFitnessFactsWithSettingsExpected(): Promise<FitnessFactsReadBundle> {
  const expectedBefore = await loadFitnessSettingsExpectedState();
  const facts = await loadFitnessSnapshot();
  const expectedAfter = await loadFitnessSettingsExpectedState();
  if (!sameFitnessSettingsExpectedState(expectedBefore, expectedAfter) ||
      !sameFitnessSettings(facts.settings, expectedAfter.settings)) {
    throw new Error("设置在读取期间发生了变化；这次没有拼接新旧页面资料。");
  }
  return {
    snapshot: { ...facts, settings: expectedAfter.settings },
    expected: expectedAfter,
  };
}

function liveDraftFactsChanged(
  before: FitnessSnapshot,
  after: FitnessSnapshot,
  gate: FitnessLiveDraftGate,
) {
  try {
    if (fitnessActiveSessionRouteChanged(before.sessions, after.sessions)) return true;
    if (gate.kind === "reflection") {
      return JSON.stringify(before.sessions.find(({ id }) => id === gate.sessionId) ?? null) !==
        JSON.stringify(after.sessions.find(({ id }) => id === gate.sessionId) ?? null);
    }
    const beforeSession = fitnessLiveSessionExpectationFromSnapshot(before, gate.sessionId);
    const afterSession = fitnessLiveSessionExpectationFromSnapshot(after, gate.sessionId);
    const beforeExercise = fitnessLiveExerciseExpectationFromSnapshot(before, gate.exerciseId);
    const afterExercise = fitnessLiveExerciseExpectationFromSnapshot(after, gate.exerciseId);
    return JSON.stringify([beforeSession, beforeExercise]) !== JSON.stringify([afterSession, afterExercise]);
  } catch {
    return true;
  }
}

export default function FitnessApp() {
  const [snapshot, setSnapshot] = useState<FitnessSnapshot>(emptySnapshot);
  const [settingsExpected, setSettingsExpected] = useState<FitnessSettingsWriteSnapshot | null>(null);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState("");
  const [view, setView] = useState<FitnessView>("today");
  const [venueId, setVenueId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [editingProfile, setEditingProfile] = useState<FitnessSnapshot["profile"]>(null);
  const [editingVenue, setEditingVenue] = useState<FitnessVenue | null>(null);
  const [archivingVenue, setArchivingVenue] = useState<FitnessVenue | null>(null);
  const [editingEquipment, setEditingEquipment] = useState<FitnessEquipment | null>(null);
  const [editingEquipmentExpected, setEditingEquipmentExpected] = useState<FitnessEquipmentWriteSnapshot | null>(null);
  const [equipmentPanel, setEquipmentPanel] = useState<EquipmentPanel>("details");
  const [equipmentPhotoBusy, setEquipmentPhotoBusy] = useState(false);
  const [equipmentPhotoTarget, setEquipmentPhotoTarget] = useState<EquipmentPhotoTarget | null>(null);
  const [fileJournal, setFileJournal] = useState<FitnessFileJournalView>(EMPTY_FILE_JOURNAL);
  const [editingConstraint, setEditingConstraint] = useState<FitnessConstraint | null>(null);
  const [planDraft, setPlanDraft] = useState<FitnessPlanDraft | null>(null);
  const [planDraftExpectation, setPlanDraftExpectation] = useState<FitnessProgramVersionScheduleExpectation | null>(null);
  const [planDraftSource, setPlanDraftSource] = useState<"local" | "ai">("local");
  const [aiDraft, setAiDraft] = useState<AiPlanDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [storage, setStorage] = useState<LocalStorageEstimate | null>(null);
  const [storageReadStatus, setStorageReadStatus] = useState<FitnessStorageReadStatus>("loading");
  const [storageActionBusy, setStorageActionBusy] = useState(false);
  const [storageActionMessage, setStorageActionMessage] = useState("");
  const currentOrigin = useSyncExternalStore(
    subscribeToOrigin,
    readClientOrigin,
    readServerOrigin,
  );
  const [rescheduleEvent, setRescheduleEvent] = useState<FitnessCalendarEvent | null>(null);
  const [rescheduleValue, setRescheduleValue] = useState("");
  const [notPerformedEvent, setNotPerformedEvent] = useState<FitnessCalendarEvent | null>(null);
  const [notPerformedNote, setNotPerformedNote] = useState("");
  const [scheduledStartChoice, setScheduledStartChoice] = useState<ScheduledStartChoice | null>(null);
  const [scheduledStartBusy, setScheduledStartBusy] = useState(false);
  const [sessionExerciseId, setSessionExerciseId] = useState<string | null>(null);
  const [historySessionId, setHistorySessionId] = useState<string | null>(null);
  const [dialogMutationBusy, setDialogMutationBusy] = useState(false);
  const [dialogDirty, setDialogDirty] = useState(false);
  const [confirmDirtyClose, setConfirmDirtyClose] = useState(false);
  const [configRecoveryReturnsToVenue, setConfigRecoveryReturnsToVenue] = useState(false);
  const [snapshotReadStatus, setSnapshotReadStatus] = useState<FitnessSnapshotReadStatus>("ready");
  const [liveSnapshotPending, setLiveSnapshotPending] = useState(false);
  const [liveDraftKept, setLiveDraftKept] = useState(false);
  const [liveDraftResetVersion, setLiveDraftResetVersion] = useState(0);
  const [historyLiveRecovery, setHistoryLiveRecovery] = useState(false);
  const [configDialogSnapshotPending, setConfigDialogSnapshotPending] = useState(false);
  const [elapsedNow, setElapsedNow] = useState(() => Date.now());
  const [firstRunDismissed, setFirstRunDismissed] = useState(false);
  const dialogWasOpen = useRef(false);
  const snapshotRef = useRef(snapshot);
  const settingsExpectedRef = useRef<FitnessSettingsWriteSnapshot | null>(null);
  const liveDraftGateRef = useRef<FitnessLiveDraftGate | null>(null);
  const pendingLiveSnapshotRef = useRef<FitnessFactsReadBundle | null>(null);
  const fitnessReadRequestRef = useRef(0);
  const submittedLiveDraftRef = useRef<
    | Readonly<{ kind: "set"; operationId: string; sessionId: string; exerciseId: string }>
    | Readonly<{ kind: "reflection"; operationId: string; sessionId: string }>
    | null
  >(null);
  const activeDialog = useRef<DialogState>(dialog);
  const dialogMutationBusyRef = useRef(false);
  const dialogDirtyRef = useRef(false);
  const dirtyReturnFocus = useRef<HTMLElement | null>(null);
  const venueArchiveReturnFocus = useRef<HTMLButtonElement | null>(null);
  const scheduledStartChoiceRef = useRef<ScheduledStartChoice | null>(null);
  const scheduledStartSequence = useRef(0);
  const submittedConfigDialogRef = useRef<Readonly<{ operationId: string; dialog: DialogState }> | null>(null);
  const settingsPrepareTriggerRef = useRef<HTMLButtonElement | null>(null);
  const submittedSettingsFocusRef = useRef<Readonly<{ operationId: string; trigger: HTMLButtonElement }> | null>(null);
  const settingsFocusFrame = useRef<number | null>(null);
  const submittedPlanCalendarDialogRef = useRef<Readonly<{ operationId: string; dialog: DialogState }> | null>(null);
  const consumedPlanCalendarOperationRef = useRef<string | null>(null);
  const planCalendarRecoveryReturnDialog = useRef<DialogState>(null);
  const calendarDialogReturnFocus = useRef<HTMLButtonElement | null>(null);
  const navigationFrame = useRef<number | null>(null);
  const planCalendarFocusFrame = useRef<number | null>(null);
  const storageActionRef = useRef(false);
  const equipmentPhotoOpener = useRef<HTMLButtonElement | null>(null);
  const equipmentPhotoBusyRef = useRef(false);
  const equipmentPanelRef = useRef<EquipmentPanel>("details");
  const equipmentPhotoTargetRef = useRef<EquipmentPhotoTarget | null>(null);
  const globalFileRecoveryAction = useRef<HTMLButtonElement | null>(null);
  const returnFromFileRecovery = useRef(false);

  const rememberScheduledStartChoice = useCallback((choice: ScheduledStartChoice | null) => {
    scheduledStartChoiceRef.current = choice;
    setScheduledStartChoice(choice);
  }, []);

  const showEquipmentPanel = useCallback((next: EquipmentPanel) => {
    equipmentPanelRef.current = next;
    setEquipmentPanel(next);
  }, []);

  const rememberEquipmentPhotoTarget = useCallback((next: EquipmentPhotoTarget | null) => {
    equipmentPhotoTargetRef.current = next;
    setEquipmentPhotoTarget(next);
  }, []);

  const rememberFileJournal = useCallback((next: FitnessFileOperationJournal) => {
    setFileJournal({ ...next, loaded: true });
  }, []);

  const reloadFileJournal = useCallback(() => {
    try {
      rememberFileJournal(readFitnessFileOperationJournal());
    } catch {
      rememberFileJournal({ entries: [], unreadable: [], unavailable: true });
    }
  }, [rememberFileJournal]);

  const navigateToFitnessView = useCallback((next: FitnessView) => {
    if (planCalendarFocusFrame.current !== null) {
      window.cancelAnimationFrame(planCalendarFocusFrame.current);
      planCalendarFocusFrame.current = null;
    }
    setView(next);
    if (navigationFrame.current !== null) window.cancelAnimationFrame(navigationFrame.current);
    navigationFrame.current = window.requestAnimationFrame(() => {
      navigationFrame.current = null;
      window.scrollTo({
        top: 0,
        left: 0,
        behavior: resolveFitnessNavigationBehavior(
          window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        ),
      });
      const heading = document.querySelector<HTMLElement>(".sl-page :is(.sl-page-title, .sl-hero) h1");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    });
  }, []);

  const focusAfterPlanCalendarWrite = useCallback((next: "plan" | "calendar") => {
    if (planCalendarFocusFrame.current !== null) {
      window.cancelAnimationFrame(planCalendarFocusFrame.current);
    }
    planCalendarFocusFrame.current = window.requestAnimationFrame(() => {
      planCalendarFocusFrame.current = window.requestAnimationFrame(() => {
        planCalendarFocusFrame.current = null;
        const selector = next === "plan"
          ? ".sl-plan .sl-page-title h1, .sl-plan .sl-program-summary > button:not([disabled])"
          : ".sl-calendar .sl-page-title h1, .sl-calendar .sl-agenda article";
        const target = Array.from(document.querySelectorAll<HTMLElement>(selector))
          .find((element) => element.isConnected && element.getClientRects().length > 0);
        if (!target) return;
        if (target.matches("h1, article")) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      });
    });
  }, []);

  const applyFitnessSnapshot = useCallback((next: FitnessFactsReadBundle) => {
    snapshotRef.current = next.snapshot;
    settingsExpectedRef.current = next.expected;
    setSnapshot(next.snapshot);
    setSettingsExpected(next.expected);
    setVenueId((current) => current && next.snapshot.venues.some((venue) => venue.id === current && venue.status === "active")
      ? current
      : next.snapshot.venues.find((venue) => venue.is_default && venue.status === "active")?.id ?? next.snapshot.venues.find((venue) => venue.status === "active")?.id ?? null);
    setSnapshotReadStatus("ready");
    setReady(true);
  }, []);

  const readFitnessFacts = useCallback(async (): Promise<FitnessFactsRefreshOutcome> => {
    const requestId = ++fitnessReadRequestRef.current;
    try {
      const next = await loadFitnessFactsWithSettingsExpected();
      const gate = liveDraftGateRef.current;
      const liveConflict = Boolean(gate?.dirty && liveDraftFactsChanged(snapshotRef.current, next.snapshot, gate));
      const configDialogConflict = fitnessDirtyConfigDialogBlocksRouteChange(
        dialogDirtyRef.current,
        snapshotRef.current.sessions,
        next.snapshot.sessions,
      );
      const outcome = resolveFitnessFactsRead(
        requestId,
        fitnessReadRequestRef.current,
        liveConflict || configDialogConflict,
      );
      if (outcome === "superseded") return outcome;
      if (outcome === "deferred") {
        pendingLiveSnapshotRef.current = next;
        setLiveSnapshotPending(liveConflict);
        setConfigDialogSnapshotPending(configDialogConflict);
        setLiveDraftKept(false);
        return outcome;
      }
      pendingLiveSnapshotRef.current = null;
      setLiveSnapshotPending(false);
      setConfigDialogSnapshotPending(false);
      setLiveDraftKept(false);
      applyFitnessSnapshot(next);
      return "applied";
    } catch (reason) {
      if (shouldMarkFitnessFactsReadStale(requestId, fitnessReadRequestRef.current)) setSnapshotReadStatus("stale");
      throw reason;
    }
  }, [applyFitnessSnapshot]);

  const refresh = useCallback(async () => { await readFitnessFacts(); }, [readFitnessFacts]);
  const refreshLiveWrite = useCallback(() => readFitnessFacts(), [readFitnessFacts]);

  const reportLiveDraftGate = useCallback((gate: FitnessLiveDraftGate | null) => {
    liveDraftGateRef.current = gate;
  }, []);

  const keepPendingLiveDraft = useCallback(() => {
    setLiveSnapshotPending(true);
    setLiveDraftKept(true);
  }, []);

  const discardLiveDraftAndRead = useCallback(() => {
    liveDraftGateRef.current = null;
    setLiveDraftResetVersion((current) => current + 1);
    const pending = pendingLiveSnapshotRef.current;
    pendingLiveSnapshotRef.current = null;
    setLiveSnapshotPending(false);
    setLiveDraftKept(false);
    if (pending) applyFitnessSnapshot(pending);
    else void readFitnessFacts().catch(() => undefined);
  }, [applyFitnessSnapshot, readFitnessFacts]);

  const applyPendingConfigDialogSnapshot = useCallback(() => {
    const pending = pendingLiveSnapshotRef.current;
    pendingLiveSnapshotRef.current = null;
    setConfigDialogSnapshotPending(false);
    if (pending) applyFitnessSnapshot(pending);
    else void readFitnessFacts().catch(() => undefined);
  }, [applyFitnessSnapshot, readFitnessFacts]);

  const openConfigRecovery = useCallback(() => {
    const fromVenueArchive = activeDialog.current === "venue-archive";
    dialogDirtyRef.current = false;
    setDialogDirty(false);
    setConfirmDirtyClose(false);
    setConfigRecoveryReturnsToVenue(fromVenueArchive);
    if (fromVenueArchive) setArchivingVenue(null);
    setDialog("config-recovery");
  }, []);

  const rememberPreparedConfigDialog = useCallback((receipt: FitnessConfigWriteReceipt) => {
    if (receipt.kind === "settings-save") {
      const trigger = settingsPrepareTriggerRef.current;
      settingsPrepareTriggerRef.current = null;
      if (trigger) submittedSettingsFocusRef.current = { operationId: receipt.operationId, trigger };
      return;
    }
    const current = activeDialog.current;
    if (dialogDirtyRef.current && (current === "venue" || current === "equipment" || current === "profile" || current === "constraint")) {
      submittedConfigDialogRef.current = { operationId: receipt.operationId, dialog: current };
    }
  }, []);

  const consumeCommittedConfigDialog = useCallback((receipt: FitnessConfigWriteReceipt) => {
    const submitted = submittedConfigDialogRef.current;
    if (!submitted || submitted.operationId !== receipt.operationId || activeDialog.current !== submitted.dialog) return;
    submittedConfigDialogRef.current = null;
    dialogDirtyRef.current = false;
    setDialogDirty(false);
    setConfirmDirtyClose(false);
    setConfigDialogSnapshotPending(false);
  }, []);

  const settleConfigWriteFocus = useCallback((receipt: FitnessConfigWriteReceipt) => {
    if (receipt.kind !== "settings-save") return;
    const submitted = submittedSettingsFocusRef.current;
    if (!submitted || submitted.operationId !== receipt.operationId) return;
    submittedSettingsFocusRef.current = null;
    if (activeDialog.current === "config-recovery") setDialog(null);
    if (settingsFocusFrame.current !== null) window.cancelAnimationFrame(settingsFocusFrame.current);
    settingsFocusFrame.current = window.requestAnimationFrame(() => {
      settingsFocusFrame.current = window.requestAnimationFrame(() => {
        settingsFocusFrame.current = null;
        const trigger = submitted.trigger;
        const target = trigger.isConnected && trigger.getClientRects().length > 0
          ? trigger
          : document.querySelector<HTMLElement>(".sl-settings-page .sl-page-title h1, .sl-page .sl-page-title h1");
        if (!target?.isConnected || target.getClientRects().length === 0) return;
        if (target.matches("h1")) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      });
    });
  }, []);

  const configWrites = useFitnessConfigWriteFlow({
    refresh: refreshLiveWrite,
    onToast: setToast,
    onAttention: openConfigRecovery,
    onDurablePrepared: rememberPreparedConfigDialog,
    onDurableCommitted: consumeCommittedConfigDialog,
    onDurableSettled: settleConfigWriteFocus,
  });

  const saveFitnessSettingsSafely = useCallback(async (
    next: FitnessSnapshot["settings"],
    expected: FitnessSettingsWriteSnapshot,
    trigger: HTMLButtonElement,
  ) => {
    if (snapshotReadStatus !== "ready" || configWrites.writeLocked ||
        settingsExpectedRef.current !== expected || snapshotRef.current.settings !== expected.settings) {
      setSnapshotReadStatus("stale");
      setError("当前设置与安全读取凭据不再属于同一次读取；仍显示上次成功内容。请先只重新读取。");
      return;
    }
    setError("");
    settingsPrepareTriggerRef.current = trigger;
    try {
      await configWrites.start(
        () => prepareFitnessSettingsSave(next, expected),
        "设置已保存在当前完整网址与浏览器资料对应的本地空间",
      );
    } catch (reason) {
      setSnapshotReadStatus("stale");
      setError(reason instanceof FitnessConfigMutationError && reason.code === "changed"
        ? "另一页已经更新了设置；这次没有写入。仍显示上次成功内容，请先只重新读取。"
        : `${errorMessage(reason)} 这次没有确认安全收据是否完整保留；请先只重新读取并处理页面提醒。`);
    } finally {
      if (settingsPrepareTriggerRef.current === trigger) settingsPrepareTriggerRef.current = null;
    }
  }, [configWrites, snapshotReadStatus]);

  const openLiveRecovery = useCallback(() => {
    if (activeDialog.current === "history-detail") setHistoryLiveRecovery(true);
    else setDialog("live-recovery");
  }, []);

  const rememberPreparedLiveDraft = useCallback((receipt: FitnessLiveWriteReceipt | FitnessLiveStructureWriteReceipt) => {
    const gate = liveDraftGateRef.current;
    if (receipt.kind === "set-record" && gate?.kind === "set" &&
      gate.sessionId === receipt.before.session.id && gate.exerciseId === receipt.before.exercise.id) {
      submittedLiveDraftRef.current = {
        kind: "set",
        operationId: receipt.operationId,
        sessionId: gate.sessionId,
        exerciseId: gate.exerciseId,
      };
    } else if (receipt.kind === "session-reflection" && gate?.kind === "reflection" &&
      gate.sessionId === receipt.before.id) {
      submittedLiveDraftRef.current = {
        kind: "reflection",
        operationId: receipt.operationId,
        sessionId: gate.sessionId,
      };
    }
  }, []);

  const consumeCommittedLiveDraft = useCallback((receipt: FitnessLiveWriteReceipt | FitnessLiveStructureWriteReceipt) => {
    if (receipt.kind === "session-start") setVenueId(receipt.after.session.venue_id);
    const submitted = submittedLiveDraftRef.current;
    const gate = liveDraftGateRef.current;
    const matchingSet = receipt.kind === "set-record" && submitted?.kind === "set" && gate?.kind === "set" &&
      submitted.operationId === receipt.operationId && gate.sessionId === submitted.sessionId &&
      gate.exerciseId === submitted.exerciseId;
    const matchingReflection = receipt.kind === "session-reflection" && submitted?.kind === "reflection" &&
      gate?.kind === "reflection" && submitted.operationId === receipt.operationId &&
      gate.sessionId === submitted.sessionId;
    if (!matchingSet && !matchingReflection) return;
    submittedLiveDraftRef.current = null;
    liveDraftGateRef.current = null;
    setLiveSnapshotPending(false);
    setLiveDraftKept(false);
    setLiveDraftResetVersion((current) => current + 1);
  }, []);

  const liveWrites = useFitnessLiveWriteFlow({
    refresh: refreshLiveWrite,
    onToast: setToast,
    onAttention: openLiveRecovery,
    onNavigate: navigateToFitnessView,
    onDurablePrepared: rememberPreparedLiveDraft,
    onDurableCommitted: consumeCommittedLiveDraft,
  });

  const openPlanCalendarRecovery = useCallback(() => {
    const current = activeDialog.current;
    planCalendarRecoveryReturnDialog.current = current === "plan-preview" ||
        current === "reschedule" || current === "calendar-not-performed"
      ? current
      : null;
    setDialog("plan-calendar-recovery");
  }, []);

  const rememberPreparedPlanCalendarDialog = useCallback((
    receipt: FitnessPlanCalendarWriteReceipt,
  ) => {
    const current = activeDialog.current;
    if (current === "plan-preview" || current === "reschedule" ||
        current === "calendar-not-performed") {
      submittedPlanCalendarDialogRef.current = {
        operationId: receipt.operationId,
        dialog: current,
      };
    }
  }, []);

  const consumeCommittedPlanCalendarDialog = useCallback((
    receipt: FitnessPlanCalendarWriteReceipt,
  ) => {
    const submitted = submittedPlanCalendarDialogRef.current;
    const current = planCalendarRecoveryReturnDialog.current ?? activeDialog.current;
    if (!submitted || submitted.operationId !== receipt.operationId ||
        submitted.dialog !== current) return;
    submittedPlanCalendarDialogRef.current = null;
    consumedPlanCalendarOperationRef.current = receipt.operationId;
    dialogDirtyRef.current = false;
    setDialogDirty(false);
    setConfirmDirtyClose(false);
    setConfigDialogSnapshotPending(false);
  }, []);

  const navigateAfterPlanCalendarWrite = useCallback((
    next: "plan" | "calendar",
    receipt: FitnessPlanCalendarWriteReceipt,
  ) => {
    const consumedCurrentDialog = consumedPlanCalendarOperationRef.current === receipt.operationId;
    consumedPlanCalendarOperationRef.current = null;
    const returnDialog = planCalendarRecoveryReturnDialog.current;
    planCalendarRecoveryReturnDialog.current = null;
    if (!consumedCurrentDialog && (
      returnDialog === "plan-preview" && planDraft && planDraftExpectation ||
      returnDialog === "reschedule" && rescheduleEvent ||
      returnDialog === "calendar-not-performed" && notPerformedEvent
    )) {
      setDialog(returnDialog);
      navigateToFitnessView(next);
      return;
    }
    calendarDialogReturnFocus.current = null;
    setPlanDraft(null);
    setPlanDraftExpectation(null);
    setRescheduleEvent(null);
    setRescheduleValue("");
    setNotPerformedEvent(null);
    setNotPerformedNote("");
    dialogDirtyRef.current = false;
    setDialogDirty(false);
    setConfirmDirtyClose(false);
    setDialog(null);
    navigateToFitnessView(next);
    focusAfterPlanCalendarWrite(next);
  }, [focusAfterPlanCalendarWrite, navigateToFitnessView, notPerformedEvent, planDraft, planDraftExpectation, rescheduleEvent]);

  const planCalendarWrites = useFitnessPlanCalendarWriteFlow({
    refresh: refreshLiveWrite,
    onToast: setToast,
    onAttention: openPlanCalendarRecovery,
    onNavigate: navigateAfterPlanCalendarWrite,
    onDurablePrepared: rememberPreparedPlanCalendarDialog,
    onDurableCommitted: consumeCommittedPlanCalendarDialog,
  });

  useEffect(() => {
    if (!dialogDirty) return;
    const rememberFocus = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches(".sl-dialog :is(.sl-form, .sl-draft, .sl-calendar-not-performed) :is(input, select, textarea, button)")) {
        dirtyReturnFocus.current = target;
      }
    };
    document.addEventListener("focusin", rememberFocus, true);
    return () => document.removeEventListener("focusin", rememberFocus, true);
  }, [dialogDirty]);

  const rememberDialogDirty = useCallback((next: boolean) => {
    dialogDirtyRef.current = next;
    setDialogDirty(next);
    if (!next) setConfirmDirtyClose(false);
  }, []);

  const recheckStorage = useCallback(async () => {
    if (storageActionRef.current) return;
    storageActionRef.current = true;
    setStorageActionBusy(true);
    setStorageReadStatus("loading");
    setStorageActionMessage("");
    try {
      const current = await estimateLocalStorage();
      setStorage(current);
      setStorageReadStatus("ready");
      setStorageActionMessage("容量与保护状态已重新读取。");
    } catch {
      setStorage(null);
      setStorageReadStatus("error");
      setStorageActionMessage("这次没有读到容量与保护状态；本地资料没有因此改变。");
    } finally {
      storageActionRef.current = false;
      setStorageActionBusy(false);
    }
  }, []);

  const requestStorageProtection = useCallback(async () => {
    if (storageActionRef.current) return;
    storageActionRef.current = true;
    setStorageActionBusy(true);
    setStorageActionMessage("");
    const hadReadableStatus = storageReadStatus === "ready" && storage !== null;
    if (!supportsPersistentLocalStorage()) {
      const message = "这个浏览器没有提供保护申请接口；它保护的是当前完整网址与浏览器资料对应的空间。现有资料和容量信息没有因此改变，请继续保留定期备份。";
      setStorageActionMessage(message);
      setToast(message);
      storageActionRef.current = false;
      setStorageActionBusy(false);
      return;
    }
    try {
      const granted = await requestPersistentLocalStorage();
      try {
        const current = await estimateLocalStorage();
        setStorage(current);
        setStorageReadStatus("ready");
        const message = current.persisted === true
          ? "浏览器已为这个地址降低自动清理风险。"
          : current.persisted === false
            ? "浏览器暂未授予额外保护；定期备份仍然可用。"
            : granted
              ? "浏览器已报告授予保护，但暂时没有返回复查状态；本地资料没有因此改变。"
              : "浏览器没有报告授予额外保护；容量信息和本地资料没有因此改变。";
        setStorageActionMessage(message);
        setToast(message);
      } catch {
        if (!hadReadableStatus) setStorageReadStatus("error");
        const message = "浏览器已处理保护申请，但容量与保护状态暂时没有重新读到；本地资料没有因此改变。";
        setStorageActionMessage(message);
        setToast(message);
      }
    } catch {
      if (!hadReadableStatus) setStorageReadStatus("error");
      const message = "浏览器没有完成这次保护申请；本地资料和原有容量信息没有因此改变。";
      setStorageActionMessage(message);
      setToast(message);
    } finally {
      storageActionRef.current = false;
      setStorageActionBusy(false);
    }
  }, [storage, storageReadStatus]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await initializeFitnessDatabase();
        await initializeFitnessFiles();
        await readFitnessFacts();
        if (!live) return;
        void (async () => {
          try {
            const current = await estimateLocalStorage();
            if (!live) return;
            setStorage(current);
            setStorageReadStatus("ready");
          } catch {
            if (!live) return;
            setStorage(null);
            setStorageReadStatus("error");
          }
        })();
      } catch (reason) {
        if (live) setFatal(errorMessage(reason));
      }
    })();
    return () => {
      live = false;
      fitnessReadRequestRef.current += 1;
    };
  }, [readFitnessFacts]);

  useEffect(() => subscribeFitnessChanges(() => { void refresh().catch(() => undefined); }), [refresh]);
  useEffect(() => {
    let frame: number | null = null;
    const refreshVisibleFacts = () => {
      if (document.visibilityState !== "visible" || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        void refresh().catch(() => undefined);
      });
    };
    window.addEventListener("focus", refreshVisibleFacts);
    document.addEventListener("visibilitychange", refreshVisibleFacts);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("focus", refreshVisibleFacts);
      document.removeEventListener("visibilitychange", refreshVisibleFacts);
    };
  }, [refresh]);
  useEffect(() => {
    const timer = window.setTimeout(reloadFileJournal, 0);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(FITNESS_FILE_OPERATION_PREFIX)) reloadFileJournal();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("storage", onStorage);
    };
  }, [reloadFileJournal]);
  useEffect(() => () => {
    if (navigationFrame.current !== null) window.cancelAnimationFrame(navigationFrame.current);
    if (planCalendarFocusFrame.current !== null) window.cancelAnimationFrame(planCalendarFocusFrame.current);
    if (settingsFocusFrame.current !== null) window.cancelAnimationFrame(settingsFocusFrame.current);
  }, []);
  useEffect(() => {
    activeDialog.current = dialog;
  }, [dialog]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!dialogDirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dialogDirty]);
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
    const shouldReturnToFileRecovery = returnFromFileRecovery.current;
    returnFromFileRecovery.current = false;
    const frame = window.requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return;
      if (shouldReturnToFileRecovery) {
        const recoveryAction = globalFileRecoveryAction.current;
        if (recoveryAction?.isConnected && recoveryAction.getClientRects().length > 0) {
          recoveryAction.focus({ preventScroll: true });
          return;
        }
      }
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

  const setEquipmentPhotosBusy = useCallback((next: boolean) => {
    equipmentPhotoBusyRef.current = next;
    setEquipmentPhotoBusy(next);
  }, []);

  const closeDialog = useCallback(() => {
    const calendarTarget = calendarDialogReturnFocus.current;
    setDialog(null); setError(""); setEditingProfile(null); setEditingEquipment(null); setEditingEquipmentExpected(null); setEditingVenue(null); setArchivingVenue(null); setEditingConstraint(null);
    setRescheduleEvent(null); setRescheduleValue(""); setNotPerformedEvent(null); setNotPerformedNote(""); setSessionExerciseId(null); setHistorySessionId(null);
    rememberScheduledStartChoice(null);
    showEquipmentPanel("details");
    rememberEquipmentPhotoTarget(null);
    setEquipmentPhotosBusy(false);
    setDialogBusy(false);
    dirtyReturnFocus.current = null;
    venueArchiveReturnFocus.current = null;
    planCalendarRecoveryReturnDialog.current = null;
    calendarDialogReturnFocus.current = null;
    setConfigRecoveryReturnsToVenue(false);
    rememberDialogDirty(false);
    window.requestAnimationFrame(() => {
      if (calendarTarget?.isConnected) calendarTarget.focus({ preventScroll: true });
    });
  }, [rememberDialogDirty, rememberEquipmentPhotoTarget, rememberScheduledStartChoice, setDialogBusy, setEquipmentPhotosBusy, showEquipmentPanel]);

  const requestDialogClose = useCallback(() => {
    if (dialogMutationBusyRef.current || configWrites.busy || planCalendarWrites.busy) return;
    if (dialogDirtyRef.current) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches(".sl-dialog :is(.sl-form, .sl-draft, .sl-calendar-not-performed) :is(input, select, textarea, button)")) {
        dirtyReturnFocus.current = active;
      }
      setConfirmDirtyClose(true);
      return;
    }
    closeDialog();
    if (configDialogSnapshotPending) applyPendingConfigDialogSnapshot();
  }, [applyPendingConfigDialogSnapshot, closeDialog, configDialogSnapshotPending, configWrites.busy, planCalendarWrites.busy]);

  const closeVenueArchiveDialog = useCallback(() => {
    const target = venueArchiveReturnFocus.current;
    venueArchiveReturnFocus.current = null;
    closeDialog();
    window.requestAnimationFrame(() => {
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
        return;
      }
      document.querySelector<HTMLButtonElement>(".sl-venue-tabs button[aria-pressed='true'], .sl-page-title .sl-primary")
        ?.focus({ preventScroll: true });
    });
  }, [closeDialog]);

  const closeConfigRecoveryDialog = useCallback(() => {
    if (configRecoveryReturnsToVenue) {
      closeVenueArchiveDialog();
      return;
    }
    requestDialogClose();
  }, [closeVenueArchiveDialog, configRecoveryReturnsToVenue, requestDialogClose]);

  const closePlanCalendarRecoveryDialog = useCallback(() => {
    if (planCalendarWrites.operationInProgress()) return;
    const target = planCalendarRecoveryReturnDialog.current;
    planCalendarRecoveryReturnDialog.current = null;
    if (target === "plan-preview" && planDraft && planDraftExpectation) {
      setDialog("plan-preview");
      return;
    }
    if (target === "reschedule" && rescheduleEvent) {
      setDialog("reschedule");
      return;
    }
    if (target === "calendar-not-performed" && notPerformedEvent) {
      setDialog("calendar-not-performed");
      return;
    }
    closeDialog();
  }, [closeDialog, notPerformedEvent, planCalendarWrites, planDraft, planDraftExpectation, rescheduleEvent]);

  const discardDirtyDialog = useCallback(() => {
    if (activeDialog.current === "plan-preview") {
      setPlanDraft(null);
      setPlanDraftExpectation(null);
    }
    dialogDirtyRef.current = false;
    setDialogDirty(false);
    setConfirmDirtyClose(false);
    closeDialog();
    if (configDialogSnapshotPending) applyPendingConfigDialogSnapshot();
  }, [applyPendingConfigDialogSnapshot, closeDialog, configDialogSnapshotPending]);

  const keepEditingDialog = useCallback(() => {
    setConfirmDirtyClose(false);
    const target = dirtyReturnFocus.current;
    dirtyReturnFocus.current = null;
    window.requestAnimationFrame(() => {
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
        return;
      }
      document.querySelector<HTMLElement>(".sl-dialog :is(.sl-form, .sl-draft, .sl-calendar-not-performed) :is(input, select, textarea, button)")
        ?.focus({ preventScroll: true });
    });
  }, []);

  const showEquipmentDetails = useCallback(() => {
    if (equipmentPhotoBusyRef.current) return;
    if (equipmentPhotoTargetRef.current?.recoveryOnly) {
      closeDialog();
      return;
    }
    showEquipmentPanel("details");
    rememberEquipmentPhotoTarget(null);
    window.requestAnimationFrame(() => equipmentPhotoOpener.current?.focus({ preventScroll: true }));
  }, [closeDialog, rememberEquipmentPhotoTarget, showEquipmentPanel]);

  const requestEquipmentDialogClose = useCallback(() => {
    if (dialogMutationBusyRef.current || equipmentPhotoBusyRef.current) return;
    if (equipmentPanelRef.current === "photos") {
      showEquipmentDetails();
      return;
    }
    requestDialogClose();
  }, [requestDialogClose, showEquipmentDetails]);

  const openFitnessFileRecovery = useCallback((entry?: FitnessFileOperationEntry) => {
    const equipmentId = entry?.ticket.receipt.expectedRow.entity_id ?? "unreadable-fitness-file-operation";
    const knownEquipment = entry
      ? snapshot.equipment.find((candidate) => candidate.id === equipmentId) ?? null
      : null;
    setEditingEquipment(null);
    setEditingEquipmentExpected(null);
    rememberEquipmentPhotoTarget({
      id: equipmentId,
      name: knownEquipment?.name ?? (entry ? "已不在当前器材清单的记录" : "无法验证归属的附件提醒"),
      recoveryOnly: true,
    });
    returnFromFileRecovery.current = true;
    showEquipmentPanel("photos");
    setDialog("equipment");
  }, [rememberEquipmentPhotoTarget, showEquipmentPanel, snapshot.equipment]);

  const requestScheduledStartChoiceClose = useCallback(() => {
    if (!liveWrites.operationInProgress()) closeDialog();
  }, [closeDialog, liveWrites]);

  const runConfigAction = useCallback(async (
    prepare: () => Promise<FitnessConfigWriteReceipt>,
    success: string,
  ) => {
    if (snapshotReadStatus !== "ready") {
      setError("暂时没有读到最新资料；仍显示上次成功读取的内容。请先只重新读取，再决定是否修改。");
      return;
    }
    setError("");
    try {
      await configWrites.start(prepare, success);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, [configWrites, snapshotReadStatus]);

  const performFitnessStart = useCallback(async (
    event: FitnessCalendarEvent | null,
    mode: "planned" | "current-temporary",
    expectedChoiceId?: number,
  ) => {
    if (liveWrites.operationInProgress() || planCalendarWrites.writeLocked) return;
    setScheduledStartBusy(true);
    setBusy(true);
    setError("");
    const currentVenue = venue;
    const plannedVenue = event?.venue_id
      ? snapshot.venues.find((entry) => entry.id === event.venue_id && entry.status === "active") ?? null
      : null;

    try {
      let input: PrepareFitnessLiveSessionStartInput;
      if (mode === "planned") {
        if (!event?.venue_id || !plannedVenue) throw new Error("这项安排的场地已经不可用，请先调整计划");
        input = {
          eventId: event.id,
          venueId: event.venue_id,
          programDayId: event.program_day_id,
          availableMinutes: event.planned_minutes,
        };
      } else {
        if (!currentVenue) throw new Error("请先选择当前所在的训练场地");
        input = {
          venueId: currentVenue.id,
          availableMinutes: snapshot.profile?.session_minutes ?? currentVenue.default_session_minutes,
        };
      }
      const expected = fitnessLiveStartExpectationFromSnapshot(snapshot, input);
      const result = await liveWrites.start(() => prepareFitnessLiveSessionStart(input, expected));
      if (result === "fresh") {
        setToast(mode === "planned"
          ? expectedChoiceId === undefined
            ? "训练已在本地开始"
            : `已切换到「${plannedVenue!.name}」并开始这场训练`
          : expectedChoiceId === undefined
            ? "临时训练已在本地开始"
            : `已按「${currentVenue!.name}」开始临时训练；原来的日历安排没有改变`);
      }
      if (result === "fresh" &&
        expectedChoiceId !== undefined &&
        activeDialog.current === "venue-start-choice" &&
        scheduledStartChoiceRef.current?.requestId === expectedChoiceId
      ) {
        rememberScheduledStartChoice(null);
        setDialog(null);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setScheduledStartBusy(false);
      setBusy(false);
    }
  }, [liveWrites, planCalendarWrites.writeLocked, rememberScheduledStartChoice, snapshot, venue]);

  const requestFitnessStart = useCallback((event: FitnessCalendarEvent | null) => {
    if (liveWrites.operationInProgress() || liveWrites.writeLocked || planCalendarWrites.writeLocked) return;
    if (!event) {
      if (!venue) {
        setEditingVenue(null);
        setDialog("venue");
        return;
      }
      void performFitnessStart(null, "current-temporary");
      return;
    }

    const route = resolveScheduledFitnessStartRoute(venue?.id ?? null, event.venue_id);
    if (route === "missing-planned-venue") {
      setError("这项安排还没有可用场地，请先调整计划");
      return;
    }
    const plannedVenue = snapshot.venues.find((entry) => entry.id === event.venue_id && entry.status === "active");
    if (!plannedVenue) {
      setError("这项安排的场地已经不可用，请先调整计划");
      return;
    }
    if (route === "start-planned") {
      void performFitnessStart(event, "planned");
      return;
    }

    setError("");
    const choice = { requestId: ++scheduledStartSequence.current, event };
    rememberScheduledStartChoice(choice);
    setDialog("venue-start-choice");
  }, [liveWrites, planCalendarWrites.writeLocked, performFitnessStart, rememberScheduledStartChoice, snapshot.venues, venue]);

  const saveAndSchedulePlanDraft = useCallback(async () => {
    const draft = planDraft;
    const expected = planDraftExpectation;
    if (!draft || !expected || planCalendarWrites.writeLocked) return;
    if (snapshotReadStatus !== "ready" || configDialogSnapshotPending) {
      setError("暂时没有读到可提交的最新计划事实；草稿仍保留。请先处理页面上的读取提醒。");
      return;
    }
    setError("");
    try {
      const anchorAt = Date.now();
      await planCalendarWrites.start(() => prepareFitnessProgramVersionSchedule({
        draft,
        source: planDraftSource === "ai" ? "ai_draft" : "local",
        anchorAt,
      }, expected));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, [configDialogSnapshotPending, planCalendarWrites, planDraft, planDraftExpectation, planDraftSource, snapshotReadStatus]);

  const scheduleProgramWeekSafely = useCallback(async (program: FitnessSnapshot["programs"][number]) => {
    if (planCalendarWrites.writeLocked || snapshotReadStatus !== "ready") return;
    setError("");
    try {
      const anchorAt = Date.now();
      const expected = fitnessProgramWeekScheduleExpectationFromSnapshot(
        snapshot,
        program.id,
        anchorAt,
      );
      await planCalendarWrites.start(() => prepareFitnessProgramWeekSchedule({
        programId: program.id,
        anchorAt,
      }, expected));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, [planCalendarWrites, snapshot, snapshotReadStatus]);

  const saveCalendarReschedule = useCallback(async (startsAt: number) => {
    const expected = rescheduleEvent;
    if (!expected || planCalendarWrites.writeLocked || configDialogSnapshotPending ||
        snapshotReadStatus !== "ready") return;
    setError("");
    try {
      await planCalendarWrites.start(() => prepareFitnessCalendarReschedule({
        eventId: expected.id,
        startsAt,
      }, expected));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, [configDialogSnapshotPending, planCalendarWrites, rescheduleEvent, snapshotReadStatus]);

  const saveCalendarNotPerformed = useCallback(async () => {
    const expected = notPerformedEvent;
    if (!expected || planCalendarWrites.writeLocked || configDialogSnapshotPending ||
        snapshotReadStatus !== "ready") return;
    setError("");
    try {
      await planCalendarWrites.start(() => prepareFitnessCalendarNotPerformed({
        eventId: expected.id,
        note: notPerformedNote,
      }, expected));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, [configDialogSnapshotPending, notPerformedEvent, notPerformedNote, planCalendarWrites, snapshotReadStatus]);

  const generateLocal = useCallback(() => {
    if (planCalendarWrites.writeLocked) return;
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
      setPlanDraftExpectation(fitnessProgramVersionScheduleExpectationFromSnapshot(snapshot, draft));
      setPlanDraftSource("local");
      rememberDialogDirty(true);
      setDialog("plan-preview");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, [planCalendarWrites.writeLocked, rememberDialogDirty, snapshot, venue, venueEquipment]);

  const generateAi = useCallback(async () => {
    if (!snapshot.profile || !venue || planCalendarWrites.writeLocked) return;
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
  }, [planCalendarWrites.writeLocked, snapshot, venue]);

  if (fatal) return <main className="shilian sl-fatal"><Logo /><section><span>数据库没有打开</span><h1>你的训练资料没有被改动。</h1><p>{fatal}</p><button onClick={() => window.location.reload()}>重新尝试</button></section></main>;
  if (!ready) return <main className="shilian sl-loading"><Logo /><i /><p>正在打开你的训练空间…</p></main>;

  if (activeSession) {
    return <LiveSession
      snapshot={snapshot}
      sessionId={activeSession.id}
      now={elapsedNow}
      onToast={setToast}
      toast={toast}
      error={error}
      setError={setError}
      dialog={dialog}
      setDialog={setDialog}
      selectedExerciseId={sessionExerciseId}
      setSelectedExerciseId={setSessionExerciseId}
      liveWrites={liveWrites}
      planCalendarWrites={planCalendarWrites}
      snapshotPending={liveSnapshotPending}
      draftKept={liveDraftKept}
      onDraftGate={reportLiveDraftGate}
      onKeepDraft={keepPendingLiveDraft}
      onDiscardDraft={discardLiveDraftAndRead}
      draftResetVersion={liveDraftResetVersion}
    />;
  }

  return <main className="shilian">
    <header className="sl-topbar">
      <Link href="/" className="sl-brand" aria-label="返回私人工作台"><Logo /></Link>
      <nav aria-label="适练页面">{navigation.map((item) => <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "active" : ""} onClick={() => navigateToFitnessView(item.id)}><span>{item.label}</span></button>)}</nav>
      <div className="sl-top-actions"><label><span>当前场地</span><select aria-label="当前场地" value={venueId ?? ""} onChange={(event) => setVenueId(event.target.value || null)}><option value="">尚未建立</option>{snapshot.venues.filter((entry) => entry.status === "active").map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><button className="sl-more" aria-label="更多页面" onClick={() => setDialog("more")}>•••</button></div>
    </header>

    <nav className="sl-mobile-tabs" aria-label="适练页面">{navigation.map((item) => <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "active" : ""} onClick={() => navigateToFitnessView(item.id)}><i>{item.glyph}</i><span>{item.label}</span></button>)}</nav>

    <section className="sl-workspace">
    {fileJournal.loaded && (fileJournal.entries.length > 0 || fileJournal.unreadable.length > 0 || (fileJournal.unavailable && (view === "venues" || view === "settings"))) && <section className="sl-global-file-recovery" role="status" aria-live="polite"><div><b>{fileJournal.unavailable ? "附件核对线索暂时无法安全读取" : fileJournal.entries.length > 0 ? `有 ${fileJournal.entries.length} 条照片操作待核对` : "有无法验证的照片操作提醒"}</b><p>{fileJournal.unavailable ? "新保存与移除保持停用；打开说明不会自动改动照片。" : `这些线索属于当前完整网址与浏览器资料。${fileJournal.unreadable.length > 0 ? `其中 ${fileJournal.unreadable.length} 条无法验证；` : ""}由你逐条打开后才会核对或选择下一步。`}</p></div>{fileJournal.unreadable.length > 0 || fileJournal.unavailable ? <button ref={globalFileRecoveryAction} type="button" onClick={() => openFitnessFileRecovery()}>查看安全说明</button> : <button ref={globalFileRecoveryAction} type="button" onClick={() => openFitnessFileRecovery(fileJournal.entries[0])}>打开下一条</button>}</section>}
      <FitnessConfigWriteBanner controller={configWrites} onOpen={() => configWrites.open()} />
      <FitnessLiveWriteBanner controller={liveWrites} />
      <FitnessPlanCalendarWriteBanner controller={planCalendarWrites} />
      {snapshotReadStatus === "stale" && <section className="sl-config-snapshot-stale" role="status" aria-live="polite"><div><b>当前显示的是上次成功读取的资料</b><p>刚才没有读到最新状态，所以资料修改暂时停用。重新读取只会刷新页面事实，不会重复任何写入。</p></div><button type="button" disabled={configWrites.busy} onClick={() => void refresh().catch(() => undefined)}>只重新读取</button></section>}
      {view === "today" && <TodayView
        now={elapsedNow}
        snapshot={snapshot}
        venue={venue}
        startBusy={scheduledStartBusy}
        startLocked={liveWrites.writeLocked || planCalendarWrites.writeLocked}
        onView={navigateToFitnessView}
        onAddVenue={() => { setEditingVenue(null); setDialog("venue"); }}
        onStart={requestFitnessStart}
      />}
      {view === "venues" && <VenuesView snapshot={snapshot} venue={venue} busy={busy || configWrites.writeLocked} onSelect={setVenueId} onAdd={() => { setEditingVenue(null); setDialog("venue"); }} onEditVenue={(entry) => { setEditingVenue(entry); setDialog("venue"); }} onArchive={(entry, trigger) => { setArchivingVenue(entry); venueArchiveReturnFocus.current = trigger; setDialog("venue-archive"); }} onRestore={(entry) => void runConfigAction(() => prepareFitnessVenueRestore(entry), `「${entry.name}」已恢复为可用场地；旧计划和已取消安排没有被复活`)} onAddEquipment={() => { setEditingEquipment(null); setEditingEquipmentExpected(null); rememberEquipmentPhotoTarget(null); showEquipmentPanel("details"); setDialog("equipment"); }} onEditEquipment={(entry) => { setEditingEquipment(entry); setEditingEquipmentExpected(equipmentWriteSnapshot(snapshot, entry)); rememberEquipmentPhotoTarget(null); showEquipmentPanel("details"); setDialog("equipment"); }} onStatus={(entry, status) => void runConfigAction(() => prepareFitnessEquipmentStatus(entry, status), status === "maintenance" ? "已标记为临时停用，未来计划会避开它" : "器材状态已更新")} />}
      {view === "plan" && <PlanView snapshot={snapshot} venue={venue} busy={busy || planCalendarWrites.writeLocked} configWriteLocked={configWrites.writeLocked || planCalendarWrites.writeLocked} error={error} onProfile={() => { setEditingProfile(snapshot.profile); setDialog("profile"); }} onVenue={() => { setEditingVenue(null); setDialog("venue"); }} onEquipment={() => { setEditingEquipment(null); setEditingEquipmentExpected(null); rememberEquipmentPhotoTarget(null); showEquipmentPanel("details"); setDialog("equipment"); }} onGenerate={generateLocal} onAi={() => void generateAi()} onSchedule={(program) => void scheduleProgramWeekSafely(program)} />}
      {view === "calendar" && <CalendarView snapshot={snapshot} startBusy={scheduledStartBusy} startLocked={liveWrites.writeLocked || planCalendarWrites.writeLocked} writeLocked={planCalendarWrites.writeLocked || snapshotReadStatus !== "ready"} onPlan={() => navigateToFitnessView("plan")} onStart={requestFitnessStart} onReschedule={(event, trigger) => { setRescheduleEvent(event); setRescheduleValue(toLocalDateTimeInputValue(event.starts_at)); calendarDialogReturnFocus.current = trigger; rememberDialogDirty(false); setDialog("reschedule"); }} onSkip={(event, trigger) => { setNotPerformedEvent(event); setNotPerformedNote(""); calendarDialogReturnFocus.current = trigger; rememberDialogDirty(false); setDialog("calendar-not-performed"); }} />}
      {view === "history" && <HistoryView snapshot={snapshot} startBusy={scheduledStartBusy} startLocked={liveWrites.writeLocked || planCalendarWrites.writeLocked} onOpen={(sessionId) => { setHistoryLiveRecovery(false); setHistorySessionId(sessionId); setDialog("history-detail"); }} onStart={() => requestFitnessStart(null)} />}
      {view === "exercises" && <ExercisesView equipment={venueEquipment} equipmentLoads={snapshot.equipmentLoads} venue={venue} />}
      {view === "profile" && <ProfileView snapshot={snapshot} busy={busy || configWrites.writeLocked} onProfile={() => { setEditingProfile(snapshot.profile); setDialog("profile"); }} onConstraint={(entry) => { setEditingConstraint(entry); setDialog("constraint"); }} onToggleConstraint={(entry) => void runConfigAction(() => prepareFitnessConstraintActive(entry, !entry.active), entry.active ? "这条身体边界已暂时结束；记录仍保留" : "这条身体边界已重新启用；它只影响未来草稿和现场选项，不改写历史")} />}
      {view === "settings" && <SettingsView snapshot={snapshot} expected={settingsExpected} snapshotReadStatus={snapshotReadStatus} configWriteLocked={configWrites.writeLocked} configWriteBusy={configWrites.busy} storage={storage} storageReadStatus={storageReadStatus} storageBusy={storageActionBusy} storageActionMessage={storageActionMessage} currentOrigin={currentOrigin} onPersist={requestStorageProtection} onRecheck={recheckStorage} onChange={(settings, expected, trigger) => void saveFitnessSettingsSafely(settings, expected, trigger)} onRestored={refresh} />}
    </section>

    {!snapshot.venues.length && !firstRunDismissed && <FirstRun onStart={() => { setFirstRunDismissed(true); setEditingVenue(null); setDialog("venue"); }} onExercises={() => { setFirstRunDismissed(true); navigateToFitnessView("exercises"); }} />}

    <FitnessDialog open={dialog === "venue"} eyebrow="REAL PLACE FIRST" title={editingVenue ? "编辑场地" : "建立训练场地"} busy={dialogMutationBusy || configWrites.busy} confirmClose={confirmDirtyClose} onKeepEditing={keepEditingDialog} onDiscard={discardDirtyDialog} onClose={requestDialogClose}>{configDialogSnapshotPending && <ConfigDialogSnapshotNotice />}<VenueForm venue={editingVenue} writeBlocked={configDialogSnapshotPending || configWrites.writeLocked || snapshotReadStatus !== "ready"} onBusyChange={setDialogBusy} onDirtyChange={rememberDialogDirty} onClose={requestDialogClose} onSave={async (input: SaveVenueInput) => {
      if (snapshotReadStatus !== "ready") throw new Error("暂时没有读到最新资料；请先只重新读取，再决定是否保存。");
      const draft = { ...input };
      delete draft.id;
      let savedVenueId: string | null = null;
      const result = await configWrites.start(async () => {
        const receipt = await prepareFitnessVenueSave(draft, editingVenue);
        savedVenueId = receipt.after.id;
        return receipt;
      }, "场地已保存。接下来可以从眼前看得到的器材开始录入");
      if (result === "fresh") {
        if (savedVenueId) setVenueId(savedVenueId);
        closeDialog();
      }
    }} /></FitnessDialog>
    <FitnessDialog
      open={dialog === "equipment"}
      eyebrow={equipmentPanel === "photos" ? "LOCAL EQUIPMENT REFERENCE" : "WHAT IS ACTUALLY HERE"}
      title={equipmentPanel === "photos" && equipmentPhotoTarget ? `${equipmentPhotoTarget.name}的照片` : editingEquipment ? "编辑器材" : "录入器材"}
      busy={dialogMutationBusy || equipmentPhotoBusy}
      confirmClose={confirmDirtyClose}
      onKeepEditing={keepEditingDialog}
      onDiscard={discardDirtyDialog}
      onClose={requestEquipmentDialogClose}
      wide
    >
      {!equipmentPhotoTarget?.recoveryOnly && (venue
        ? <div hidden={equipmentPanel !== "details"}>{configDialogSnapshotPending && <ConfigDialogSnapshotNotice />}<EquipmentForm venueId={venue.id} equipment={editingEquipment} loads={editingEquipmentExpected?.loads ?? []} unit={snapshot.profile?.unit ?? snapshot.settings.unit} writeBlocked={configDialogSnapshotPending || configWrites.writeLocked || snapshotReadStatus !== "ready"} onBusyChange={setDialogBusy} onDirtyChange={rememberDialogDirty} onClose={requestEquipmentDialogClose} onSave={async (input: SaveEquipmentInput) => {
          if (snapshotReadStatus !== "ready") throw new Error("暂时没有读到最新资料；请先只重新读取，再决定是否保存。");
          const draft = { ...input };
          delete draft.id;
          const result = await configWrites.start(() => prepareFitnessEquipmentSave(draft, editingEquipmentExpected), "器材与真实重量档位已保存");
          if (result === "fresh") closeDialog();
        }} />{editingEquipment && <div className="sl-equipment-photo-entry"><span><b>器材照片</b><small>{snapshot.files.filter((file) => file.entity_type === "equipment" && file.entity_id === editingEquipment.id).length} 条照片记录 · 打开后核对本地原件</small></span><button ref={equipmentPhotoOpener} type="button" disabled={dialogMutationBusy || configWrites.busy} onClick={() => { rememberEquipmentPhotoTarget({ id: editingEquipment.id, name: editingEquipment.name, recoveryOnly: false }); showEquipmentPanel("photos"); }}>查看与添加</button></div>}</div>
        : <DialogNeed copy="先建立或选择一个场地，器材才有明确归属。" action={() => { closeDialog(); setDialog("venue"); }} label="建立场地" />)}
      {equipmentPanel === "photos" && equipmentPhotoTarget && <EquipmentPhotos equipment={equipmentPhotoTarget} currentOrigin={currentOrigin} recoveryOnly={equipmentPhotoTarget.recoveryOnly} onBusyChange={setEquipmentPhotosBusy} onJournalChange={rememberFileJournal} onChanged={refresh} onBack={showEquipmentDetails}/>}
    </FitnessDialog>
    <FitnessDialog open={dialog === "profile"} eyebrow="YOUR TIME & PREFERENCES" title="训练偏好" busy={dialogMutationBusy || configWrites.busy} confirmClose={confirmDirtyClose} onKeepEditing={keepEditingDialog} onDiscard={discardDirtyDialog} onClose={requestDialogClose} wide>{configDialogSnapshotPending && <ConfigDialogSnapshotNotice />}<ProfileForm profile={editingProfile} writeBlocked={configDialogSnapshotPending || configWrites.writeLocked || snapshotReadStatus !== "ready"} onBusyChange={setDialogBusy} onDirtyChange={rememberDialogDirty} onClose={requestDialogClose} onSave={async (input: SaveFitnessProfileInput) => {
      if (snapshotReadStatus !== "ready") throw new Error("暂时没有读到最新资料；请先只重新读取，再决定是否保存。");
      const result = await configWrites.start(() => prepareFitnessProfileSave(input, editingProfile), "偏好已保存；它是规划输入，不是必须完成的配额");
      if (result === "fresh") closeDialog();
    }} /></FitnessDialog>
    <FitnessDialog open={dialog === "constraint"} eyebrow="BODY BOUNDARIES" title={editingConstraint ? "编辑身体边界" : "记录身体边界"} busy={dialogMutationBusy || configWrites.busy} confirmClose={confirmDirtyClose} onKeepEditing={keepEditingDialog} onDiscard={discardDirtyDialog} onClose={requestDialogClose} wide>{configDialogSnapshotPending && <ConfigDialogSnapshotNotice />}<ConstraintForm constraint={editingConstraint} writeBlocked={configDialogSnapshotPending || configWrites.writeLocked || snapshotReadStatus !== "ready"} onBusyChange={setDialogBusy} onDirtyChange={rememberDialogDirty} onClose={requestDialogClose} onSave={async (input: SaveConstraintInput) => {
      if (snapshotReadStatus !== "ready") throw new Error("暂时没有读到最新资料；请先只重新读取，再决定是否保存。");
      const draft = { ...input };
      delete draft.id;
      const result = await configWrites.start(() => prepareFitnessConstraintSave(draft, editingConstraint), !input.active ? "内容已保存；这条边界仍是已结束状态" : input.severity === "avoid" ? "身体边界已保存；未来草稿与现场选项会避开指定范围，历史不会被改写" : "身体边界已保存；现场会显示原文提醒，不会自动推断调整方式");
      if (result === "fresh") closeDialog();
    }} /></FitnessDialog>
    <FitnessDialog open={dialog === "venue-archive"} eyebrow="KEEP HISTORY, CHANGE AVAILABILITY" title="确认归档场地" busy={configWrites.busy} initialFocus="[data-archive-keep]" onClose={closeVenueArchiveDialog}>
      {archivingVenue && <section className="sl-config-confirm"><p>归档「{archivingVenue.name}」会停用它关联的启用中或草稿计划，并取消尚未开始的日历安排。训练历史、器材和已经发生的记录都会保留。</p>{configWrites.writeLocked && <p className="sl-form-hint" role="status">资料核对线索处理完成前不能归档。</p>}<footer><button type="button" data-archive-keep onClick={closeVenueArchiveDialog}>继续保留场地</button><button className="sl-danger-action" type="button" disabled={configWrites.writeLocked} onClick={() => {
        void (async () => {
          const result = await configWrites.start(() => prepareFitnessVenueArchive(archivingVenue), `「${archivingVenue.name}」已归档，历史仍保留`);
          if (result === "fresh") closeVenueArchiveDialog();
        })().catch((reason) => setError(errorMessage(reason)));
      }}>确认归档</button></footer></section>}
    </FitnessDialog>
    <FitnessDialog open={dialog === "config-recovery"} eyebrow="SAFE WRITE RECEIPT" title="核对资料写入" busy={configWrites.busy} onClose={closeConfigRecoveryDialog} wide><FitnessConfigWriteRecovery controller={configWrites} /></FitnessDialog>
    <FitnessDialog open={dialog === "live-recovery"} eyebrow="LIVE FACT RECEIPT" title="核对训练写入" busy={liveWrites.busy} initialFocus=".sl-live-write-recovery button:not([disabled]), [data-dialog-close]" onClose={() => { if (!liveWrites.operationInProgress()) setDialog(null); }} wide><FitnessLiveWriteRecovery controller={liveWrites} /></FitnessDialog>
    <FitnessDialog open={dialog === "plan-calendar-recovery"} eyebrow="PLAN & CALENDAR RECEIPT" title="核对计划或日历写入" busy={planCalendarWrites.busy} initialFocus=".sl-plan-calendar-write-recovery button:not([disabled]), [data-dialog-close]" onClose={closePlanCalendarRecoveryDialog} wide><FitnessPlanCalendarWriteRecovery controller={planCalendarWrites} /></FitnessDialog>
    <FitnessDialog open={dialog === "plan-preview"} eyebrow="LOCAL · VERIFIED" title="可执行计划草稿" busy={planCalendarWrites.busy} confirmClose={confirmDirtyClose} onKeepEditing={keepEditingDialog} onDiscard={discardDirtyDialog} onClose={requestDialogClose} wide>{planDraft && planDraftExpectation && <>{configDialogSnapshotPending && <PlanCalendarDialogSnapshotNotice />}<PlanDraftPreview draft={planDraft} expected={planDraftExpectation} writeLocked={planCalendarWrites.writeLocked || configDialogSnapshotPending || snapshotReadStatus !== "ready"} onSave={() => void saveAndSchedulePlanDraft()} /></>}</FitnessDialog>
    <FitnessDialog open={dialog === "ai-preview"} eyebrow="AI DRAFT · NOT SAVED" title="AI 计划草稿" busy={planCalendarWrites.busy} onClose={closeDialog} wide>{aiDraft && <AiDraftPreview draft={aiDraft} busy={busy || planCalendarWrites.writeLocked} onApply={() => { try { const local = aiDraftToLocal(aiDraft, snapshot, venue!); const validation = validateFitnessPlanDraft(local, plannerContext(snapshot, venue!, venueEquipment)); if (!validation.valid) throw new Error(validation.errors[0] ?? "AI 草稿没有通过本地校验"); setPlanDraft(local); setPlanDraftExpectation(fitnessProgramVersionScheduleExpectationFromSnapshot(snapshot, local)); setPlanDraftSource("ai"); rememberDialogDirty(true); setDialog("plan-preview"); } catch (reason) { setError(errorMessage(reason)); } }} />}</FitnessDialog>
    <FitnessDialog open={dialog === "venue-start-choice"} eyebrow="START WHERE YOU ACTUALLY ARE" title="先确认这次从哪里开始" busy={scheduledStartBusy || liveWrites.writeLocked} onClose={requestScheduledStartChoiceClose}>
      {scheduledStartChoice && <VenueStartChoice
        event={scheduledStartChoice.event}
        plannedVenue={snapshot.venues.find((entry) => entry.id === scheduledStartChoice.event.venue_id && entry.status === "active") ?? null}
        currentVenue={venue}
        busy={scheduledStartBusy || liveWrites.writeLocked}
        onPlanned={() => void performFitnessStart(scheduledStartChoice.event, "planned", scheduledStartChoice.requestId)}
        onCurrent={() => void performFitnessStart(scheduledStartChoice.event, "current-temporary", scheduledStartChoice.requestId)}
        onCancel={requestScheduledStartChoiceClose}
      />}
    </FitnessDialog>
    <FitnessDialog open={dialog === "reschedule"} eyebrow="MOVE, DON'T OWE" title="把它放到更合适的一天" busy={planCalendarWrites.busy} initialFocus="[data-calendar-reschedule-keep]" confirmClose={confirmDirtyClose} onKeepEditing={keepEditingDialog} onDiscard={discardDirtyDialog} onClose={requestDialogClose}>{rescheduleEvent && <>{configDialogSnapshotPending && <PlanCalendarDialogSnapshotNotice />}<RescheduleForm event={rescheduleEvent} value={rescheduleValue} writeLocked={planCalendarWrites.writeLocked || configDialogSnapshotPending || snapshotReadStatus !== "ready"} onValueChange={(value) => { setRescheduleValue(value); rememberDialogDirty(value !== toLocalDateTimeInputValue(rescheduleEvent.starts_at)); }} onClose={() => { rememberDialogDirty(false); closeDialog(); }} onSave={(startsAt) => void saveCalendarReschedule(startsAt)} /></>}</FitnessDialog>
    <FitnessDialog open={dialog === "calendar-not-performed"} eyebrow="ONE OCCURRENCE ONLY" title="这次安排可以不进行" busy={planCalendarWrites.busy} initialFocus="[data-calendar-keep]" confirmClose={confirmDirtyClose} onKeepEditing={keepEditingDialog} onDiscard={discardDirtyDialog} onClose={requestDialogClose}>{notPerformedEvent && <>{configDialogSnapshotPending && <PlanCalendarDialogSnapshotNotice />}<CalendarNotPerformedConfirm event={notPerformedEvent} note={notPerformedNote} writeLocked={planCalendarWrites.writeLocked || configDialogSnapshotPending || snapshotReadStatus !== "ready"} onNoteChange={(value) => { setNotPerformedNote(value); rememberDialogDirty(value.length > 0); }} onKeep={() => { rememberDialogDirty(false); closeDialog(); }} onConfirm={() => void saveCalendarNotPerformed()} /></>}</FitnessDialog>
    <FitnessDialog open={dialog === "history-detail"} eyebrow={historyLiveRecovery ? "LIVE FACT RECEIPT" : "WHAT YOU ACTUALLY SAVED"} title={historyLiveRecovery ? "核对训练写入" : "训练详情"} busy={liveWrites.busy} initialFocus={historyLiveRecovery ? ".sl-live-write-recovery button:not([disabled]), [data-dialog-close]" : "[data-dialog-close]"} onClose={() => { if (liveWrites.operationInProgress()) return; if (historyLiveRecovery) { setHistoryLiveRecovery(false); return; } if (liveDraftGateRef.current?.kind === "reflection") { setError("先保存或明确放弃这段训练感受，再关闭详情。"); return; } closeDialog(); }} wide>{historySessionId && <><div hidden={historyLiveRecovery}><HistoryDetail key={historySessionId} snapshot={snapshot} sessionId={historySessionId} unit={snapshot.profile?.unit ?? snapshot.settings.unit} writeLocked={liveWrites.writeLocked} snapshotPending={liveSnapshotPending} draftKept={liveDraftKept} draftResetVersion={liveDraftResetVersion} onDraftGate={reportLiveDraftGate} onKeepDraft={keepPendingLiveDraft} onDiscardDraft={discardLiveDraftAndRead} onSaveReflection={async (sessionId, reflection, expected) => liveWrites.start(() => prepareFitnessLiveSessionReflection(sessionId, reflection, expected))} /></div>{historyLiveRecovery && <FitnessLiveWriteRecovery controller={liveWrites} />}</>}</FitnessDialog>
    <MoreDialog open={dialog === "more"} current={view} onClose={closeDialog} onView={(next) => { navigateToFitnessView(next); closeDialog(); }} />
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

function ConfigDialogSnapshotNotice() {
  return <section className="sl-config-dialog-stale" role="status" aria-live="polite"><b>另一页已开始或结束训练</b><p>当前表单和输入仍完整保留，但旧画面不能提交。继续填写不会进入最新训练；要切换时，请关闭表单并明确选择“舍弃并关闭”。</p></section>;
}

function PlanCalendarDialogSnapshotNotice() {
  return <section className="sl-plan-calendar-dialog-stale" role="status" aria-live="polite"><b>另一页已开始或结束训练</b><p>当前计划或日历输入仍完整保留，但旧画面不能提交。可以继续查看或复制；明确舍弃后才会进入最新训练。</p></section>;
}

function VenueStartChoice({ event, plannedVenue, currentVenue, busy, onPlanned, onCurrent, onCancel }: {
  event: FitnessCalendarEvent;
  plannedVenue: FitnessVenue | null;
  currentVenue: FitnessVenue | null;
  busy: boolean;
  onPlanned: () => void;
  onCurrent: () => void;
  onCancel: () => void;
}) {
  return <div className="sl-start-choice">
    <p>「{event.title}」使用的是计划场地，但你当前选择了另一个地方。适练不会替你假定人已经到了哪间健身房。</p>
    <div className="sl-start-choice-venues" role="list" aria-label="计划与当前场地">
      <span role="listitem"><small>计划场地</small><strong>{plannedVenue?.name ?? "已经不可用"}</strong></span>
      <i aria-hidden="true">→</i>
      <span role="listitem"><small>当前场地</small><strong>{currentVenue?.name ?? "尚未选择"}</strong></span>
    </div>
    <div className="sl-start-choice-actions">
      <button type="button" className="sl-primary" disabled={busy || !plannedVenue} onClick={onPlanned}>切换到计划场地并开始</button>
      <button type="button" disabled={busy || !currentVenue} onClick={onCurrent}>按当前场地开始临时训练</button>
      <button type="button" disabled={busy} onClick={onCancel}>取消</button>
    </div>
    <p className="sl-start-choice-note">选择临时训练时，原来的日历安排仍会保留，不会被算作已完成或未进行。</p>
    {busy && <span className="sl-visually-hidden" role="status">正在开始训练，请稍候</span>}
  </div>;
}

function TodayView({ now, snapshot, venue, startBusy, startLocked, onView, onAddVenue, onStart }: { now: number; snapshot: FitnessSnapshot; venue: FitnessVenue | null; startBusy: boolean; startLocked: boolean; onView: (view: FitnessView) => void; onAddVenue: () => void; onStart: (event: FitnessCalendarEvent | null) => void }) {
  const upcoming = snapshot.events.filter((event) => event.status === "planned" && event.starts_at >= dayStart(now)).sort((a, b) => a.starts_at - b.starts_at);
  const next = upcoming[0] ?? null;
  const nextDay = next?.program_day_id ? snapshot.programDays.find((day) => day.id === next.program_day_id) ?? null : null;
  const items = nextDay ? snapshot.programItems.filter((item) => item.program_day_id === nextDay.id) : [];
  const currentVenueEquipment = snapshot.equipment.filter((entry) => entry.venue_id === venue?.id && (entry.status === "available" || entry.status === "limited"));
  const nextVenueEquipment = snapshot.equipment.filter((entry) => entry.venue_id === next?.venue_id && (entry.status === "available" || entry.status === "limited"));
  const nextEquipmentReady = items.length > 0 && items.every((item) => item.resource_equipment_ids.every((id) => nextVenueEquipment.some((entry) => entry.id === id)));
  const nextBoundaryConflict = next ? calendarEventHasBoundaryConflict(next, snapshot) : false;
  const startDisabled = startBusy || startLocked;
  return <div className="sl-page sl-today">
    <header className="sl-hero"><div><span>{formatDate(now)}</span><h1>今天在真实条件里，<br/><em>做得到什么？</em></h1><p>计划可以调整，实际发生的训练才会成为记录。</p></div><div className="sl-hero-place"><span>当前场地</span><strong>{venue?.name ?? "还没有场地"}</strong><small>{venue ? `${currentVenueEquipment.length} 类已录器材 · 上次核对 ${venue.last_verified_at ? formatDate(venue.last_verified_at) : "待记录"}` : "先从你实际训练的地方开始"}</small></div></header>
    {startLocked && <p id="sl-today-start-locked" className="sl-live-start-locked" role="status">先核对页面上方待处理的写入，再开始另一场训练。</p>}
    {next ? <section className={`sl-next-session${nextBoundaryConflict ? " conflict" : ""}`}><div className="sl-next-time"><span>{new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(new Date(next.starts_at))}</span><strong>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(next.starts_at))}</strong><small>约 {next.planned_minutes} 分钟</small></div><div className="sl-next-copy"><span>NEXT · {next.kind === "cardio" ? "心肺" : "力量"}</span><h2>{next.title}</h2><p>{nextBoundaryConflict ? "身体边界已经更新；这项安排原样保留，但开始前需要生成适用版本。" : nextDay?.focus || "开始前会再次核对场地和时间。"}</p><div>{items.slice(0, 5).map((item) => <span key={item.id}>{getFitnessExercise(item.exercise_id)?.name_zh ?? item.exercise_id}</span>)}</div><footer>{nextBoundaryConflict ? <button className="sl-primary" onClick={() => onView("plan")}>查看并生成适用版本</button> : <button className="sl-primary" aria-describedby={startLocked ? "sl-today-start-locked" : undefined} disabled={startDisabled} onClick={() => onStart(next)}>{startBusy ? "正在开始…" : startLocked ? "先核对训练写入" : "开始这场训练"}</button>}<button onClick={() => onView("calendar")}>改期或查看安排</button></footer></div><aside><i className={nextBoundaryConflict ? "check" : nextEquipmentReady ? "ok" : "check"}/><strong>{nextBoundaryConflict ? "当前身体边界与旧计划冲突" : nextEquipmentReady ? "已找到计划引用的器材" : "安排场地有器材需要重新确认"}</strong><small>{nextBoundaryConflict ? "不会把这项旧安排算成失败，也不会直接开始一场已知不适用的训练。" : `${snapshot.venues.find((entry) => entry.id === next.venue_id)?.name ?? "场地待确认"} · 开始时会重新核对数量、档位和当前状态。`}</small></aside></section> : <section className="sl-open-day"><div><span>OPEN DAY</span><h2>今天没有安排。</h2><p>可以休息，也可以按当前时间开始一小段临时训练。</p></div><footer>{venue ? <button className="sl-primary" aria-describedby={startLocked ? "sl-today-start-locked" : undefined} disabled={startDisabled} onClick={() => onStart(null)}>{startBusy ? "正在开始…" : startLocked ? "先核对训练写入" : "开始临时训练"}</button> : <button className="sl-primary" onClick={onAddVenue}>建立场地</button>}<button onClick={() => onView("plan")}>看看计划</button></footer></section>}
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
  onArchive: (venue: FitnessVenue, trigger: HTMLButtonElement) => void;
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
      <section className="sl-venue-overview"><div><span>当前场地</span><h2>{venue.name}</h2><p>{venue.location || "位置没有记录"}</p></div><dl><div><dt>通常时长</dt><dd>{venue.default_session_minutes} 分钟</dd></div><div><dt>上次核对</dt><dd>{venue.last_verified_at ? formatDate(venue.last_verified_at) : "待核对"}</dd></div><div><dt>跨器材组合</dt><dd>{venue.supersets_allowed ? "可以" : "尽量避免"}</dd></div></dl><footer><button onClick={() => onEditVenue(venue)}>编辑场地</button><button disabled={busy} onClick={(event) => onArchive(venue, event.currentTarget)}>归档</button></footer></section>
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

function PlanView({ snapshot, venue, busy, configWriteLocked, error, onProfile, onVenue, onEquipment, onGenerate, onAi, onSchedule }: { snapshot: FitnessSnapshot; venue: FitnessVenue | null; busy: boolean; configWriteLocked: boolean; error: string; onProfile: () => void; onVenue: () => void; onEquipment: () => void; onGenerate: () => void; onAi: () => void; onSchedule: (program: FitnessSnapshot["programs"][number]) => void }) {
  const active = snapshot.programs.find((entry) => entry.status === "active") ?? null;
  const days = active ? snapshot.programDays.filter((entry) => entry.program_id === active.id) : [];
  const activeDayIds = new Set(days.map((day) => day.id));
  const conflictingExerciseIds = new Set(snapshot.programItems
    .filter((item) => activeDayIds.has(item.program_day_id) && exerciseMatchesActiveAvoid(item.exercise_id, snapshot.constraints))
    .map((item) => item.exercise_id));
  const conflictNames = [...conflictingExerciseIds].map((id) => getFitnessExercise(id)?.name_zh ?? id);
  const hasBoundaryConflict = conflictNames.length > 0;
  const ready = Boolean(snapshot.profile && venue && snapshot.equipment.some((entry) => entry.venue_id === venue.id && (entry.status === "available" || entry.status === "limited")));
  return <div className="sl-page sl-plan"><header className="sl-page-title"><div><span>AN EXECUTABLE WEEK</span><h1>周蓝图</h1><p>计划是可协商的版本，不是必须偿还的训练清单。</p></div>{ready && <div className="sl-title-actions"><button disabled={busy || !snapshot.settings.ai_enabled} onClick={onAi}>AI 草稿</button><button className="sl-primary" disabled={busy} onClick={onGenerate}>生成本地计划</button></div>}</header>
    {!ready && <section className="sl-prerequisites"><header><span>让计划先认识现实</span><h2>还需要几项真实输入</h2></header><div><button disabled={configWriteLocked} className={snapshot.profile ? "done" : ""} onClick={onProfile}><i>{snapshot.profile ? "✓" : "1"}</i><span><b>训练偏好</b><small>{snapshot.profile ? `${snapshot.profile.resistance_days_per_week} 次力量 · ${snapshot.profile.cardio_days_per_week} 次有氧` : "频次、时间、经验与目标"}</small></span></button><button disabled={configWriteLocked} className={venue ? "done" : ""} onClick={onVenue}><i>{venue ? "✓" : "2"}</i><span><b>训练场地</b><small>{venue?.name ?? "你实际在哪里练"}</small></span></button><button disabled={configWriteLocked} className={venue && snapshot.equipment.some((entry) => entry.venue_id === venue.id) ? "done" : ""} onClick={onEquipment}><i>{venue && snapshot.equipment.some((entry) => entry.venue_id === venue.id) ? "✓" : "3"}</i><span><b>真实器材</b><small>{venue ? `${snapshot.equipment.filter((entry) => entry.venue_id === venue.id).length} 条记录` : "器材与重量档位"}</small></span></button></div></section>}
    {error && <p className="sl-inline-error" role="alert">{error}</p>}
    {ready && <p className="sl-ai-privacy"><b>AI 输入边界</b>只发送器材类型、数量、状态、明确重量、训练频次与能力数字。场地名、器材备注、偏好备注和身体边界文字都留在本地；避用动作会先由本地规则移出动作池。</p>}
    {active ? <><section className={`sl-program-summary${hasBoundaryConflict ? " conflict" : ""}`}><div><span>ACTIVE VERSION · V{active.version}</span><h2>{active.name}</h2><p>{goalLabels[active.goal]} · {active.split === "full_body" ? "全身" : active.split === "upper_lower" ? "上下肢" : active.split === "push_pull_legs" ? "推拉腿" : "自适应分化"} · {snapshot.venues.find((entry) => entry.id === active.venue_id)?.name}</p></div><aside><span>{hasBoundaryConflict ? "身体边界已更新" : "生成依据"}</span><p>{hasBoundaryConflict ? `这版包含现在避用的动作：${conflictNames.join("、")}` : active.assumptions[0] || "来自当前场地、时间与身体边界。"}</p></aside><button disabled={busy || hasBoundaryConflict} onClick={() => onSchedule(active)}>{hasBoundaryConflict ? "先生成适用版本" : busy ? "先核对待处理写入" : "放入接下来一周"}</button></section>{hasBoundaryConflict && <p className="sl-plan-conflict" role="status">旧版会原样保留作参考，也不会计作失败；重新生成后才会允许排期。</p>}<div className="sl-program-days">{days.map((day) => <ProgramDayCard key={day.id} day={day} items={snapshot.programItems.filter((item) => item.program_day_id === day.id)} equipment={snapshot.equipment} unit={snapshot.profile?.unit ?? snapshot.settings.unit} conflictingExerciseIds={conflictingExerciseIds} />)}</div></> : ready && <div className="sl-empty-card"><i>划</i><h3>还没有启用的计划</h3><p>本地规则可以离线生成；AI 只生成待核对草稿，最终仍要通过同一器材校验。</p><div><button className="sl-primary" disabled={busy} onClick={onGenerate}>用本地规则生成</button><button disabled={busy || !snapshot.settings.ai_enabled} onClick={onAi}>让 AI 提一个草稿</button></div></div>}
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

function CalendarView({ snapshot, startBusy, startLocked, writeLocked, onPlan, onStart, onReschedule, onSkip }: { snapshot: FitnessSnapshot; startBusy: boolean; startLocked: boolean; writeLocked: boolean; onPlan: () => void; onStart: (event: FitnessCalendarEvent) => void; onReschedule: (event: FitnessCalendarEvent, trigger: HTMLButtonElement) => void; onSkip: (event: FitnessCalendarEvent, trigger: HTMLButtonElement) => void }) {
  const [mode, setMode] = useState<"agenda" | "month">("agenda");
  const events = [...snapshot.events].sort((a, b) => a.starts_at - b.starts_at);
  const grouped = new Map<string, FitnessCalendarEvent[]>();
  for (const event of events) {
    const key = new Intl.DateTimeFormat("en-CA").format(new Date(event.starts_at));
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }
  const startDisabled = startBusy || startLocked;
  return <div className="sl-page sl-calendar"><header className="sl-page-title"><div><span>PLAN AND ACTUAL STAY SEPARATE</span><h1>日历</h1><p>可以改期、缩短或不进行；历史只记录实际发生的部分。</p></div><div className="sl-segmented"><button aria-pressed={mode === "agenda"} className={mode === "agenda" ? "active" : ""} onClick={() => setMode("agenda")}>议程</button><button aria-pressed={mode === "month"} className={mode === "month" ? "active" : ""} onClick={() => setMode("month")}>月视图</button></div></header>
    {startLocked && <p id="sl-calendar-start-locked" className="sl-live-start-locked" role="status">先核对页面上方待处理的写入，再从日历开始训练。</p>}
    {events.length ? mode === "agenda" ? <div className="sl-agenda">{Array.from(grouped).map(([key, rows]) => <section key={key}><header><time>{formatDate(rows[0].starts_at)}</time><span>{key}</span></header><div>{rows.map((event) => {
      const boundaryConflict = calendarEventHasBoundaryConflict(event, snapshot);
      return <article key={event.id} className={`${event.status}${boundaryConflict ? " conflict" : ""}`}><i>{event.kind === "cardio" ? "心" : event.kind === "rest" ? "休" : "力"}</i><span><small>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(event.starts_at))} · {snapshot.venues.find((entry) => entry.id === event.venue_id)?.name ?? "场地待选"}</small><h3>{event.title}</h3><p>{boundaryConflict ? "身体边界已更新；这项安排保留，但需要先生成适用版本" : calendarEventCopy(event)}</p></span><footer>{event.status === "planned" && <>{boundaryConflict ? <button className="sl-primary" disabled={writeLocked} onClick={onPlan}>查看并生成适用版本</button> : <button className="sl-primary" aria-describedby={startLocked ? "sl-calendar-start-locked" : undefined} disabled={startDisabled} onClick={() => onStart(event)}>{startBusy ? "正在开始…" : startLocked ? "先核对待处理写入" : "开始"}</button>}<button disabled={startBusy || writeLocked} onClick={(clickEvent) => onReschedule(event, clickEvent.currentTarget)}>改期</button><button disabled={startBusy || writeLocked} onClick={(clickEvent) => onSkip(event, clickEvent.currentTarget)}>这次不进行</button></>}</footer></article>;
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

function HistoryView({ snapshot, startBusy, startLocked, onStart, onOpen }: { snapshot: FitnessSnapshot; startBusy: boolean; startLocked: boolean; onStart: () => void; onOpen: (sessionId: string) => void }) {
  const sessions = snapshot.sessions.filter((entry) => entry.status !== "active");
  const startDisabled = startBusy || startLocked;
  return <div className="sl-page"><header className="sl-page-title"><div><span>WHAT ACTUALLY HAPPENED</span><h1>训练记录</h1><p>计划与实际分开保存；这里不计算连续天数或完成率。</p></div><button className="sl-primary" aria-describedby={startLocked ? "sl-history-start-locked" : undefined} disabled={startDisabled} onClick={onStart}>{startLocked ? "先核对训练写入" : "＋ 临时训练"}</button></header>
    {startLocked && <p id="sl-history-start-locked" className="sl-live-start-locked" role="status">先核对页面上方待处理的写入，再开始另一场训练。</p>}
    {sessions.length ? <div className="sl-history-list">{sessions.map((session) => {
      const rows = snapshot.sessionExercises.filter((entry) => entry.session_id === session.id);
      const actualRows = rows.filter((row) => row.substituted_for_exercise_id || snapshot.sets.some((set) => set.session_exercise_id === row.id && set.completed));
      const actualSets = snapshot.sets.filter((set) => actualRows.some((row) => row.id === set.session_exercise_id) && set.completed);
      const summary = actualRows.map((row) => getFitnessExercise(row.exercise_id)?.name_zh ?? row.exercise_id).join(" · ");
      const hasPainNote = actualSets.some((set) => set.pain_note);
      return <button type="button" className="sl-history-card" key={session.id} onClick={() => onOpen(session.id)} aria-label={`查看${new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(session.started_at))}训练详情`}><time><strong>{new Date(session.started_at).getDate()}</strong><span>{new Intl.DateTimeFormat("zh-CN", { month: "short" }).format(new Date(session.started_at))}</span></time><span className="sl-history-card-copy"><span>{snapshot.venues.find((entry) => entry.id === session.venue_id)?.name ?? "历史场地"}</span><span className="sl-history-card-title">{session.status === "ended_early" ? "保存到这里的训练" : "训练记录"}</span><span className="sl-history-card-summary">{summary || "这次只保存了训练时段，没有把未做的计划动作算作实际"}</span><span className="sl-history-card-facts"><b>{session.ended_at ? formatMinutes(session.ended_at - session.started_at) : 0} 分钟</b><b>{actualSets.length} 条实际记录</b>{actualRows.some((row) => row.substituted_for_exercise_id) && <b>有现场替代</b>}{hasPainNote && <b>有当时的不适记录</b>}</span></span><i aria-hidden="true">›</i></button>;
    })}</div> : <div className="sl-empty-card"><i>记</i><h3>第一条真实训练会从这里开始</h3><p>没有样例成绩，也不会把计划冒充成实际训练。</p><button className="sl-primary" aria-describedby={startLocked ? "sl-history-start-locked" : undefined} disabled={startDisabled} onClick={onStart}>{startLocked ? "先核对训练写入" : "开始临时训练"}</button></div>}
  </div>;
}

function HistoryDetail({ snapshot, sessionId, unit, writeLocked, snapshotPending, draftKept, draftResetVersion, onDraftGate, onKeepDraft, onDiscardDraft, onSaveReflection }: {
  snapshot: FitnessSnapshot;
  sessionId: string;
  unit: "kg" | "lb";
  writeLocked: boolean;
  snapshotPending: boolean;
  draftKept: boolean;
  draftResetVersion: number;
  onDraftGate: (gate: FitnessLiveDraftGate | null) => void;
  onKeepDraft: () => void;
  onDiscardDraft: () => void;
  onSaveReflection: (sessionId: string, reflection: string, expected: FitnessSession) => Promise<"fresh" | "attention">;
}) {
  const reflectionSectionRef = useRef<HTMLElement>(null);
  const session = snapshot.sessions.find((entry) => entry.id === sessionId) ?? null;
  const [editingReflection, setEditingReflection] = useState(false);
  const [reflectionState, setReflectionState] = useState<Readonly<{
    version: number;
    draft: string;
    dirty: boolean;
    expected: FitnessSession | null;
  }>>({ version: draftResetVersion, draft: session?.reflection ?? "", dirty: false, expected: session });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  const reflectionDirty = reflectionState.version === draftResetVersion && reflectionState.dirty;
  const reflectionDraft = reflectionDirty ? reflectionState.draft : session?.reflection ?? "";
  const reflectionExpected = reflectionDirty ? reflectionState.expected : session;
  const reflectionStale = reflectionDirty && snapshotPending;
  useEffect(() => {
    onDraftGate(reflectionDirty ? { kind: "reflection", dirty: true, sessionId } : null);
    return () => onDraftGate(null);
  }, [onDraftGate, reflectionDirty, sessionId]);
  useEffect(() => {
    if (!reflectionDirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [reflectionDirty]);
  if (!session) return <p className="sl-empty-copy padded">这条训练记录已经不在当前数据库中。</p>;
  const rows = snapshot.sessionExercises.filter((entry) => entry.session_id === session.id).sort((a, b) => a.order_index - b.order_index);
  const actualRows = rows.filter((row) => row.substituted_for_exercise_id || snapshot.sets.some((set) => set.session_exercise_id === row.id && set.completed));
  const unperformed = rows.length - actualRows.length;
  const venue = snapshot.venues.find((entry) => entry.id === session.venue_id)?.name ?? "历史场地";
  const saveReflection = async () => {
    if (saving || writeLocked || reflectionStale || !reflectionExpected) return;
    setSaving(true); setSaveError(""); setSaved(false);
    try {
      const result = await onSaveReflection(session.id, reflectionDraft, reflectionExpected);
      if (result === "fresh") {
        setReflectionState({ version: draftResetVersion, draft: reflectionDraft.trim(), dirty: false, expected: null });
        setEditingReflection(false);
        setSaved(true);
        window.requestAnimationFrame(() => {
          reflectionSectionRef.current?.querySelector<HTMLButtonElement>("header button:not([disabled])")
            ?.focus({ preventScroll: true });
        });
      }
    } catch (reason) {
      setSaveError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };
  const discardStaleReflection = () => {
    onDraftGate(null);
    setReflectionState({ version: draftResetVersion + 1, draft: "", dirty: false, expected: null });
    setEditingReflection(false);
    onDiscardDraft();
  };
  const cancelReflection = () => {
    const action = resolveFitnessReflectionDraftAction(snapshotPending, "cancel", true);
    onDraftGate(null);
    setReflectionState({ version: draftResetVersion, draft: session.reflection, dirty: false, expected: session });
    setSaveError("");
    setEditingReflection(false);
    if (action.applyPending) onDiscardDraft();
  };
  const copyReflection = async () => {
    try { await navigator.clipboard.writeText(reflectionDraft); }
    catch { setSaveError("没有自动复制；这段输入仍保留在当前表单。请手动复制后再决定。"); }
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
    <section ref={reflectionSectionRef} className="sl-history-reflection"><header><div><span>训练复盘</span><p>只保存在这条本地记录中；空白也可以。</p></div>{!editingReflection && <button type="button" disabled={writeLocked} onClick={() => { setReflectionState({ version: draftResetVersion, draft: session.reflection, dirty: false, expected: session }); setSaveError(""); setSaved(false); setEditingReflection(true); }}>{session.reflection ? "编辑" : "写一点"}</button>}</header>{reflectionStale && <section className="sl-live-draft-stale" role="alert"><div><b>{draftKept ? "已继续保留这段未保存的训练感受" : "另一处已经改变了这条训练记录"}</b><p>当前文字仍完整保留，但旧画面不能覆盖最新事实。可以先复制，再明确保留或舍弃。</p></div><footer><button type="button" onClick={() => void copyReflection()}>复制这段文字</button><button type="button" disabled={draftKept} onClick={onKeepDraft}>{draftKept ? "继续保留中" : "保留当前文字"}</button><button type="button" className="sl-danger-action" onClick={discardStaleReflection}>舍弃文字并读取最新事实</button></footer></section>}{editingReflection ? <><label><span className="sl-visually-hidden">训练复盘</span><textarea disabled={writeLocked} value={reflectionDraft} onChange={(event) => { const draft = event.target.value; const expected = reflectionExpected ?? session; const action = resolveFitnessReflectionDraftAction(snapshotPending, "change", draft.trim() === expected.reflection); onDraftGate(action.dirty ? { kind: "reflection", dirty: true, sessionId } : null); setReflectionState({ version: draftResetVersion, draft, dirty: action.dirty, expected }); if (action.applyPending) window.requestAnimationFrame(onDiscardDraft); }} maxLength={4000} placeholder="例如：哪个动作更顺、下次想保留什么。无需做评价。" /></label><footer><button type="button" disabled={saving || writeLocked} onClick={cancelReflection}>放弃这次输入</button><button type="button" className="sl-primary" disabled={saving || writeLocked || reflectionStale || !reflectionDirty} onClick={() => void saveReflection()}>{saving ? "正在安全保存…" : "保存训练感受"}</button></footer></> : <p>{session.reflection || "这次没有写训练感受。"}</p>}{writeLocked && editingReflection && <p className="sl-data-status" role="status">训练写入核对完成前，这段文字会保留但不能保存。</p>}{saveError && <p className="sl-inline-error" role="alert">{saveError}</p>}{saved && <p className="sl-inline-success" role="status">训练感受已保存。</p>}</section>
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

function SettingsView({ snapshot, expected, snapshotReadStatus, configWriteLocked, configWriteBusy, storage, storageReadStatus, storageBusy, storageActionMessage, currentOrigin, onPersist, onRecheck, onChange, onRestored }: {
  snapshot: FitnessSnapshot;
  expected: FitnessSettingsWriteSnapshot | null;
  snapshotReadStatus: FitnessSnapshotReadStatus;
  configWriteLocked: boolean;
  configWriteBusy: boolean;
  storage: LocalStorageEstimate | null;
  storageReadStatus: FitnessStorageReadStatus;
  storageBusy: boolean;
  storageActionMessage: string;
  currentOrigin: string;
  onPersist: () => Promise<void>;
  onRecheck: () => Promise<void>;
  onChange: (settings: FitnessSnapshot["settings"], expected: FitnessSettingsWriteSnapshot, trigger: HTMLButtonElement) => void;
  onRestored: () => Promise<void>;
}) {
  const settings = snapshot.settings;
  const settingsBound = expected !== null && settings === expected.settings;
  const settingsWriteLocked = snapshotReadStatus !== "ready" || !settingsBound || configWriteLocked;
  const settingsWriteStatus = configWriteBusy
    ? "正在安全保存设置；结果确认前不会再次写入。"
    : snapshotReadStatus !== "ready"
      ? "当前显示上次成功读取的设置；只重新读取成功前，开关保持停用。"
      : !settingsBound
        ? "设置与安全读取凭据没有成对就绪；开关保持停用，没有据此写入。"
        : configWriteLocked
          ? "先处理页面上方的资料写入核对提醒；当前设置仍完整显示。"
          : "";
  return <div className="sl-page sl-settings-page"><header className="sl-page-title"><div><span>PRIVACY & DATA</span><h1>设置</h1><p>训练和身体资料留在当前完整网址与浏览器资料对应的本地空间；AI 只在你点击时收到最小草稿上下文。</p></div></header><div className="sl-settings">
    <section className="sl-settings-write" aria-busy={configWriteBusy || undefined}><header><h2>AI 与隐私</h2><p>没有 AI 时，器材、计划、日历与训练记录仍可使用。</p></header><SettingSwitch label="允许 AI 草稿" copy="只发送结构化器材、频次与能力数字；不发送用户填写的自由文本" checked={settings.ai_enabled} disabled={settingsWriteLocked} describedBy={settingsWriteStatus ? "sl-settings-write-status" : undefined} onChange={(value, trigger) => { if (expected && settings === expected.settings) onChange({ ...settings, ai_enabled: value }, expected, trigger); }}/>{settingsWriteStatus && <p id="sl-settings-write-status" className="sl-settings-write-status" role="status">{settingsWriteStatus}</p>}<div className="sl-privacy-fact"><i/><span><b>DeepSeek Key 只在服务端</b><small>不会进入 SQLite、完整备份或浏览器资源</small></span></div></section>
    <section className="sl-local-space"><header><h2>这套本地空间</h2><p>当前完整地址与当前浏览器资料（profile）共同决定资料放在哪里。</p></header>
      <div className="sl-origin-fact"><span>当前完整地址</span><code>{currentOrigin || "正在确认当前地址…"}</code><p>协议、主机名（hostname）或端口不同，就是另一套地址；更换浏览器资料（profile），也会打开另一套本地空间。</p></div>
      <p className="sl-storage-scope">此地址站点数据合计（职迹、拾词、适练和缓存）</p>
      {storageReadStatus === "ready" && storage ? <>
        <dl className="sl-storage-metrics" aria-label="此地址站点数据容量">
          <div><dt>已使用</dt><dd>{formatFitnessStorageBytes(storage.usage)}</dd></div>
          <div><dt>浏览器估算上限</dt><dd>{formatFitnessStorageBytes(storage.quota)}</dd></div>
          <div><dt>估算可用</dt><dd>{formatFitnessStorageBytes(storage.available)}</dd></div>
        </dl>
        <div className={`sl-storage ${storage.persisted === true ? "persisted" : ""}`}><i/><span><b>{storage.persisted === true ? "已降低浏览器自动清理风险" : storage.persisted === false ? "可以申请降低自动清理风险" : "保护状态暂时未知"}</b><small>{storage.persisted === null ? "容量仍可查看；同一完整地址里的三处空间没有因此改变。" : "同一完整地址里的职迹、拾词与适练共享这项浏览器保护。"}</small></span>{storage.persisted !== true && <button type="button" disabled={storageBusy} onClick={() => void onPersist()}>{storage.persisted === null ? "重新申请保护" : "申请降低清理风险"}</button>}</div>
      </> : storageReadStatus === "error" ? <div className="sl-storage-unavailable"><span role="status"><b>暂时无法读取，不代表资料丢失</b><small>这里只是容量与保护状态没有读取成功。</small></span><button type="button" disabled={storageBusy} onClick={() => void onRecheck()}>重新检查</button></div> : <div className="sl-storage-loading" role="status">正在读取此地址的站点数据合计…</div>}
      {storageActionMessage && <p className="sl-storage-action-status" role="status">{storageActionMessage}</p>}
      <p className="sl-data-note">这项保护只降低浏览器自动清理风险，不是备份；手动清理站点数据仍会删除此地址的本地资料。</p>
    </section>
    <section><header><h2>完整备份与恢复</h2><p>SQLite 与器材照片一起校验；失败时不会原位覆盖当前版本。</p></header><FitnessDataControls onRestored={onRestored}/></section>
  </div></div>;
}

function SettingSwitch({ label, copy, checked, disabled, describedBy, onChange }: { label: string; copy: string; checked: boolean; disabled: boolean; describedBy?: string; onChange: (checked: boolean, trigger: HTMLButtonElement) => void }) {
  return <div className="sl-setting-row"><span><b>{label}</b><small>{copy}</small></span><button type="button" role="switch" aria-label={label} aria-checked={checked} aria-describedby={describedBy} disabled={disabled} className={checked ? "on" : ""} onClick={(event) => onChange(!checked, event.currentTarget)}><i/></button></div>;
}

function PlanDraftPreview({ draft, expected, writeLocked, onSave }: { draft: FitnessPlanDraft; expected: FitnessProgramVersionScheduleExpectation; writeLocked: boolean; onSave: () => void }) {
  return <div className="sl-draft"><section className="sl-draft-context"><div><span>使用场地</span><strong>{expected.venue.name}</strong></div><div><span>每周安排</span><strong>{draft.days.filter((day) => day.kind === "resistance").length} 力量 · {draft.days.filter((day) => day.kind === "cardio").length} 心肺</strong></div><div><span>精确重量</span><strong>未知时保持待校准</strong></div></section>{draft.assumptions.length > 0 && <aside><span>当前假设</span><ul>{draft.assumptions.map((entry) => <li key={entry}>{entry}</li>)}</ul></aside>}<div className="sl-draft-days">{draft.days.map((day, index) => <article key={`${day.name}-${index}`}><header><span>{day.weekday === null ? `第 ${index + 1} 天` : weekdayNames[day.weekday]}</span><h3>{day.name}</h3><p>{day.focus} · 约 {day.estimated_minutes} 分钟</p></header>{day.items.map((item) => <div key={`${item.exercise_id}-${item.order_index}`}><span><b>{getFitnessExercise(item.exercise_id)?.name_zh}</b><small>{expected.equipment.find((entry) => entry.id === item.equipment_id)?.name ?? "自重"} · {item.load_guidance}</small></span><strong>{item.sets} × {item.rep_min ?? "计时"}{item.rep_max && item.rep_max !== item.rep_min ? `–${item.rep_max}` : ""}</strong></div>)}</article>)}</div>{draft.warnings.length > 0 && <aside className="warning"><span>仍需确认</span><ul>{draft.warnings.map((entry) => <li key={entry}>{entry}</li>)}</ul></aside>}<footer><p>保存后会成为新版本并原子放入首周日历；原计划会收进历史版本，既有训练记录不会改写或删除。</p>{writeLocked && <span className="sl-data-status" role="status">先处理页面上的计划或日历核对提醒；这份草稿仍保留。</span>}<button className="sl-primary" disabled={writeLocked} onClick={onSave}>{writeLocked ? "暂时不能保存" : "保存新版本并放入日历"}</button></footer></div>;
}

function AiDraftPreview({ draft, busy, onApply }: { draft: AiPlanDraft; busy: boolean; onApply: () => void }) {
  return <div className="sl-ai-draft"><div className="sl-ai-boundary"><i>AI</i><span><b>尚未写入本地计划</b><small>下一步仍会经过本地动作 ID、器材与时长校验。</small></span></div><h3>{draft.title}</h3><p>{draft.rationale}</p><div>{draft.days.map((day) => <article key={day.day_key}><header><span>{day.label}</span><strong>{day.estimated_minutes} 分钟</strong></header>{day.items.map((item) => <div key={item.exercise_id}><b>{item.exercise_name}</b><small>{item.sets} 组 · {item.load_rule.instruction}</small></div>)}</article>)}</div>{draft.questions.length > 0 && <aside><span>AI 仍需要你确认</span>{draft.questions.map((question) => <p key={question}>{question}</p>)}</aside>}<footer><button className="sl-primary" disabled={busy} onClick={onApply}>交给本地规则校验</button></footer></div>;
}

function RescheduleForm({ event, value, writeLocked, onValueChange, onClose, onSave }: { event: FitnessCalendarEvent; value: string; writeLocked: boolean; onValueChange: (value: string) => void; onClose: () => void; onSave: (startsAt: number) => void }) {
  const [validationError, setValidationError] = useState("");
  const errorId = "sl-reschedule-time-error";
  return <form className="sl-form" aria-busy={writeLocked || undefined} onSubmit={(formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (writeLocked) return;
    const resolution = resolveLocalDateTimeInput(value, event.starts_at);
    if (resolution.status !== "valid") {
      setValidationError(resolution.status === "ambiguous"
        ? "这个本地时间会在夏令时切换时出现两次。请选择前后一个明确时间。"
        : resolution.status === "nonexistent"
          ? "这个本地时间在夏令时切换时不存在。请选择其他时间。"
          : "请输入有效的日期与时间。");
      return;
    }
    onSave(resolution.timestamp);
  }}><p className="sl-safety-copy">改期只移动计划，不会制造一条“漏练”记录；时区切换时也不会静默改变一小时。</p><label><span>新的日期与时间</span><input required disabled={writeLocked} name="startsAt" type="datetime-local" value={value} aria-invalid={validationError ? true : undefined} aria-describedby={validationError ? errorId : undefined} onChange={(changeEvent) => { onValueChange(changeEvent.target.value); setValidationError(""); }}/></label>{validationError && <p id={errorId} className="sl-form-error" role="alert">{validationError}</p>}{writeLocked && <span className="sl-data-status" role="status">当前输入仍保留；核对提醒完成前不能改期。</span>}<footer><button type="button" data-calendar-reschedule-keep onClick={onClose}>保留原时间</button><button className="sl-primary" disabled={writeLocked}>{writeLocked ? "暂时不能改期" : "确认改期"}</button></footer></form>;
}

function CalendarNotPerformedConfirm({ event, note, writeLocked, onNoteChange, onKeep, onConfirm }: { event: FitnessCalendarEvent; note: string; writeLocked: boolean; onNoteChange: (value: string) => void; onKeep: () => void; onConfirm: () => void }) {
  return <section className="sl-calendar-not-performed" role="status"><p>只会把「{event.title}」这一次记为未进行。它不会成为欠账，也不会自动堆到明天；其他安排原样保留。</p><label><span>说明（可选）</span><textarea disabled={writeLocked} value={note} maxLength={4000} onChange={(event) => onNoteChange(event.target.value)} placeholder="例如：今天改为休息。无需解释也可以。" /></label>{writeLocked && <p className="sl-data-status" role="status">当前说明仍保留；核对提醒完成前不能提交。</p>}<footer><button type="button" data-calendar-keep onClick={onKeep}>继续保留这次安排</button><button type="button" disabled={writeLocked} onClick={onConfirm}>确认这次未进行</button></footer></section>;
}

function MoreDialog({ open, current, onClose, onView }: { open: boolean; current: FitnessView; onClose: () => void; onView: (view: FitnessView) => void }) {
  const dialog = useFitnessDialog<HTMLElement>(open, onClose, "button");
  if (!open) return null;
  const pages: Array<[FitnessView, string, string]> = [["exercises", "动作库", "只看当前场地真正可做的动作"], ["profile", "身体与偏好", "目标、时间和身体边界"], ["settings", "设置与隐私", "本地存储、AI 和数据"]];
  return <><button type="button" className="sl-scrim" tabIndex={-1} aria-hidden="true" onClick={onClose}/><aside ref={dialog} className="sl-more-sheet" role="dialog" aria-modal="true" aria-label="更多页面" tabIndex={-1}><header><span>更多</span><button data-dialog-close onClick={onClose} aria-label="关闭更多页面">×</button></header>{pages.map(([id, label, copy]) => <button key={id} aria-current={current === id ? "page" : undefined} onClick={() => onView(id)}><i>{label.slice(0, 1)}</i><span><b>{label}</b><small>{copy}</small></span><strong>→</strong></button>)}<Link href="/"><i>台</i><span><b>私人工作台</b><small>返回各个独立空间的入口</small></span><strong>→</strong></Link></aside></>;
}

type FitnessLiveSetDraft = Readonly<{
  sessionId: string;
  exerciseId: string;
  expected: FitnessLiveExerciseExpectation;
  weight: string;
  reps: string;
  durationMinutes: string;
  rir: string;
  rpe: string;
  pain: string;
  dirty: boolean;
}>;

function createFitnessLiveSetDraft(
  snapshot: FitnessSnapshot,
  sessionId: string,
  exerciseId: string,
): FitnessLiveSetDraft {
  const expected = fitnessLiveExerciseExpectationFromSnapshot(snapshot, exerciseId);
  const planned = expected.exercise.planned_item_id
    ? snapshot.programItems.find(({ id }) => id === expected.exercise.planned_item_id) ?? null
    : null;
  const last = expected.sets.at(-1) ?? null;
  const unit = snapshot.profile?.unit ?? snapshot.settings.unit;
  return {
    sessionId,
    exerciseId,
    expected,
    weight: last?.load_grams ? String(Number((last.load_grams / (unit === "kg" ? 1_000 : 453.59237)).toFixed(2))) : "",
    reps: String(last?.reps ?? planned?.rep_min ?? ""),
    durationMinutes: String(last?.duration_seconds
      ? Number((last.duration_seconds / 60).toFixed(1))
      : Math.max(1, Math.round((planned?.duration_seconds ?? 60) / 60))),
    rir: String(snapshot.profile?.preferred_rir ?? ""),
    rpe: String(last?.rpe ?? ""),
    pain: "",
    dirty: false,
  };
}

function LiveSession({ snapshot, sessionId, now, onToast, toast, error, setError, dialog, setDialog, selectedExerciseId, setSelectedExerciseId, liveWrites, planCalendarWrites, snapshotPending, draftKept, draftResetVersion, onDraftGate, onKeepDraft, onDiscardDraft }: { snapshot: FitnessSnapshot; sessionId: string; now: number; onToast: (message: string) => void; toast: string; error: string; setError: (message: string) => void; dialog: DialogState; setDialog: (dialog: DialogState) => void; selectedExerciseId: string | null; setSelectedExerciseId: (id: string | null) => void; liveWrites: FitnessLiveWriteController; planCalendarWrites: FitnessPlanCalendarWriteController; snapshotPending: boolean; draftKept: boolean; draftResetVersion: number; onDraftGate: (gate: FitnessLiveDraftGate | null) => void; onKeepDraft: () => void; onDiscardDraft: () => void }) {
  const [confirmAction, setConfirmAction] = useState<"finish" | "leave" | "cancel" | null>(null);
  const confirmReturnFocus = useRef<HTMLButtonElement | null>(null);
  const setFormRef = useRef<HTMLFormElement>(null);
  const liveMainRef = useRef<HTMLElement>(null);
  const session = snapshot.sessions.find((entry) => entry.id === sessionId)!;
  const rows = snapshot.sessionExercises.filter((entry) => entry.session_id === sessionId).sort((a, b) => a.order_index - b.order_index);
  const snapshotCurrent = rows.find((entry) => entry.status === "active") ?? rows.find((entry) => entry.status === "pending") ?? null;
  const [storedSetDraft, setStoredSetDraft] = useState<Readonly<{ version: number; draft: FitnessLiveSetDraft | null }>>(() => ({
    version: draftResetVersion,
    draft: snapshotCurrent ? createFitnessLiveSetDraft(snapshot, sessionId, snapshotCurrent.id) : null,
  }));
  const focusLivePrimary = useCallback(() => window.requestAnimationFrame(() => {
    liveMainRef.current?.querySelector<HTMLElement>(
      ".sl-set-form input:not([disabled]), .sl-live-done button:not([disabled]), .sl-live-empty button:not([disabled]), .sl-live-bottom-actions button:not([disabled])",
    )?.focus({ preventScroll: true });
  }), []);
  useEffect(() => {
    const frame = focusLivePrimary();
    return () => window.cancelAnimationFrame(frame);
  }, [focusLivePrimary]);
  const setDraft = storedSetDraft.draft?.dirty && storedSetDraft.version === draftResetVersion
    ? storedSetDraft.draft
    : snapshotCurrent
      ? createFitnessLiveSetDraft(snapshot, sessionId, snapshotCurrent.id)
      : null;
  const current = setDraft?.dirty
    ? rows.find((entry) => entry.id === setDraft.exerciseId) ?? snapshotCurrent
    : snapshotCurrent;
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
  const hasActualFacts = rows.some((row) => snapshot.sets.some((set) =>
    set.session_exercise_id === row.id &&
    (set.completed || set.reps !== null || set.duration_seconds !== null),
  )) || snapshot.cardioEntries.some((entry) => entry.session_id === session.id && entry.duration_seconds !== null);
  const actualRowCount = rows.filter((row) => snapshot.sets.some((set) => set.session_exercise_id === row.id && set.completed)).length;
  let draftFactsChanged = false;
  if (setDraft?.dirty) {
    try {
      draftFactsChanged = JSON.stringify(fitnessLiveExerciseExpectationFromSnapshot(snapshot, setDraft.exerciseId)) !== JSON.stringify(setDraft.expected);
    } catch {
      draftFactsChanged = true;
    }
  }
  const draftStale = Boolean(setDraft?.dirty && (snapshotPending || draftFactsChanged));
  const liveWriteLocked = liveWrites.writeLocked || planCalendarWrites.writeLocked;
  const interactionLocked = liveWriteLocked || draftStale;
  useEffect(() => {
    onDraftGate(setDraft?.dirty ? {
      kind: "set",
      dirty: true,
      sessionId: setDraft.sessionId,
      exerciseId: setDraft.exerciseId,
    } : null);
    return () => onDraftGate(null);
  }, [onDraftGate, setDraft]);
  useEffect(() => {
    if (!setDraft?.dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [setDraft?.dirty]);
  const record = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    const form = formEvent.currentTarget;
    if (!current || !setDraft || setDraft.exerciseId !== current.id || draftStale || liveWriteLocked) return;
    try {
      const result = await liveWrites.start(() => prepareFitnessSetRecord({
          sessionExerciseId: current.id,
          setIndex: setDraft.expected.nextSetIndex,
          setKind: "work",
          loadGrams: setDraft.weight ? Math.round(Number(setDraft.weight) * (unit === "kg" ? 1_000 : 453.59237)) : null,
          reps: isTimed ? null : setDraft.reps ? Number(setDraft.reps) : null,
          durationSeconds: isTimed && setDraft.durationMinutes ? Math.round(Number(setDraft.durationMinutes) * 60) : null,
          rir: !isTimed && setDraft.rir ? Number(setDraft.rir) : null,
          rpe: isTimed && setDraft.rpe ? Number(setDraft.rpe) : null,
          painNote: setDraft.pain,
        }, setDraft.expected));
      if (result === "fresh") {
        setStoredSetDraft((stored) => ({
          version: draftResetVersion,
          draft: stored.draft?.exerciseId === current.id ? { ...stored.draft, pain: "", dirty: false } : stored.draft,
        }));
        window.requestAnimationFrame(() => {
          (form.elements.namedItem(isTimed ? "durationMinutes" : "reps") as HTMLInputElement | null)?.focus();
        });
      }
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const requestLiveConfirm = (action: "finish" | "leave" | "cancel", trigger: HTMLButtonElement) => {
    if (interactionLocked || setDraft?.dirty) return;
    confirmReturnFocus.current = trigger;
    setConfirmAction(action);
  };
  const closeLiveConfirm = () => {
    if (liveWrites.operationInProgress()) return;
    const target = confirmReturnFocus.current;
    confirmReturnFocus.current = null;
    setConfirmAction(null);
    window.requestAnimationFrame(() => target?.isConnected && target.focus({ preventScroll: true }));
  };
  const confirmLiveAction = async () => {
    const action = confirmAction;
    if (!action || liveWrites.operationInProgress() || planCalendarWrites.writeLocked) return;
    try {
      if (action === "cancel") {
        await liveWrites.start(() => prepareFitnessEmptySessionCancel(
          session.id,
          fitnessLiveSessionExpectationFromSnapshot(snapshot, session.id),
        ));
      } else {
        await liveWrites.start(() => prepareFitnessSessionFinish(
          session.id,
          { endedEarly: action === "leave" },
          fitnessLiveSessionExpectationFromSnapshot(snapshot, session.id),
        ));
      }
    } catch (reason) {
      setError(errorMessage(reason));
      const target = confirmReturnFocus.current;
      window.requestAnimationFrame(() => target?.isConnected && target.focus({ preventScroll: true }));
    } finally {
      confirmReturnFocus.current = null;
      setConfirmAction(null);
    }
  };
  const updateSetDraft = (field: "weight" | "reps" | "durationMinutes" | "rir" | "rpe" | "pain", value: string) => {
    if (!setDraft) return;
    const next = { ...setDraft, [field]: value, dirty: true };
    onDraftGate({ kind: "set", dirty: true, sessionId: next.sessionId, exerciseId: next.exerciseId });
    setStoredSetDraft({ version: draftResetVersion, draft: next });
  };
  const discardUnrecordedDraft = () => {
    onDraftGate(null);
    if (current) setStoredSetDraft({
      version: draftResetVersion,
      draft: createFitnessLiveSetDraft(snapshot, session.id, current.id),
    });
  };
  const discardStaleDraft = () => {
    onDraftGate(null);
    setStoredSetDraft({ version: draftResetVersion + 1, draft: null });
    onDiscardDraft();
  };
  const copyUnrecordedDraft = async () => {
    if (!setDraft) return;
    const text = `未记录的训练输入\n重量：${setDraft.weight || "未填写"} ${unit}\n次数：${setDraft.reps || "未填写"}\n时长：${setDraft.durationMinutes || "未填写"} 分钟\nRIR：${setDraft.rir || "未填写"}\nRPE：${setDraft.rpe || "未填写"}\n不适原文：${setDraft.pain || "未填写"}`;
    try { await navigator.clipboard.writeText(text); onToast("未记录的输入已复制"); }
    catch { setError("没有自动复制；请保留当前页面并手动记录这些值。"); }
  };
  const undoSet = async (setId: string) => {
    if (!current || setDraft?.dirty || interactionLocked) return;
    try {
      const result = await liveWrites.start(() => prepareFitnessSetUndo(
        setId,
        fitnessLiveExerciseExpectationFromSnapshot(snapshot, current.id),
      ));
      if (result === "fresh") focusLivePrimary();
    } catch (reason) { setError(errorMessage(reason)); }
  };
  const completeExercise = async (skipped: boolean) => {
    if (!current || setDraft?.dirty || interactionLocked) return;
    try {
      const expected = fitnessLiveSessionExpectationFromSnapshot(snapshot, session.id);
      const result = await liveWrites.start(() => prepareFitnessLiveExerciseComplete({
        sessionExerciseId: current.id,
        skipped,
      }, expected));
      if (result === "fresh") focusLivePrimary();
    } catch (reason) { setError(errorMessage(reason)); }
  };
  const addExercise = async (exercise: FitnessExercise) => {
    if (interactionLocked) return;
    const resources = resourcesForExercise(exercise, sessionEquipment, sessionLoads) ?? [];
    const expected = fitnessLiveAddExpectationFromSnapshot(snapshot, session.id);
    try {
      const result = await liveWrites.start(() => prepareFitnessLiveExerciseAdd({
        sessionId: session.id,
        exerciseId: exercise.id,
        equipmentId: resources[0] ?? null,
        equipmentSnapshot: JSON.stringify(resources),
      }, expected));
      if (result === "fresh") {
        setDialog(null);
        setSelectedExerciseId(null);
        focusLivePrimary();
      }
    } catch (reason) { setError(errorMessage(reason)); }
  };
  const substituteExercise = async (exercise: FitnessExercise) => {
    if (!current || selectedExerciseId !== current.id || sets.length > 0 || interactionLocked ||
      exercise.id === current.exercise_id) return;
    const resources = resourcesForExercise(exercise, sessionEquipment, sessionLoads) ?? [];
    const expected = fitnessLiveSubstituteExpectationFromSnapshot(snapshot, session.id);
    try {
      const result = await liveWrites.start(() => prepareFitnessLiveExerciseSubstitute({
        sessionExerciseId: current.id,
        exerciseId: exercise.id,
        equipmentId: resources[0] ?? null,
        equipmentSnapshot: JSON.stringify(resources),
        reason: "器材占用或现场调整",
      }, expected));
      if (result === "fresh") {
        setDialog(null);
        setSelectedExerciseId(null);
        focusLivePrimary();
      }
    } catch (reason) { setError(errorMessage(reason)); }
  };
  const nonRecordLocked = interactionLocked || Boolean(setDraft?.dirty);
  return <main ref={liveMainRef} className="shilian sl-live">
    <header><Logo/><div><span>{venue?.name ?? "当前场地"}</span><strong>{formatMinutes(now - session.started_at)} 分钟</strong><small>每条实际记录即时保存</small></div><button disabled={nonRecordLocked} onClick={(event) => requestLiveConfirm("leave", event.currentTarget)}>{hasActualFacts ? "保存并离开" : "保存空时段"}</button></header>
    <FitnessLiveWriteBanner controller={liveWrites} />
    <FitnessPlanCalendarWriteBanner controller={planCalendarWrites} />
    {draftStale && setDraft && <section className="sl-live-draft-stale" role="alert"><div><b>{draftKept ? "已继续保留这份未记录输入" : "另一处训练事实已经变化"}</b><p>仍显示并保留 {getFitnessExercise(setDraft.expected.exercise.exercise_id)?.name_zh ?? "原动作"} 的未记录输入；旧画面不能提交，也不会把这些值带到另一个动作。</p></div><footer><button type="button" onClick={() => void copyUnrecordedDraft()}>复制这些值</button><button type="button" disabled={draftKept} onClick={onKeepDraft}>{draftKept ? "继续保留中" : "保留当前输入"}</button><button type="button" className="sl-danger-action" onClick={discardStaleDraft}>舍弃输入并读取最新事实</button></footer></section>}
    {rows.length ? <>
      <nav aria-label="本场动作">{rows.map((row, index) => <span key={row.id} aria-current={current?.id === row.id ? "step" : undefined} className={`${row.status} ${current?.id === row.id ? "active" : ""}`}><i>{row.status === "completed" ? "✓" : index + 1}</i><b>{getFitnessExercise(row.exercise_id)?.name_zh ?? row.exercise_id}</b></span>)}</nav>
      {current ? <section className="sl-live-focus">
        <div className="sl-live-index"><span>{isTimed ? "TIME" : "NEXT SET"}</span><strong>{isTimed ? Math.max(1, Math.round((planned?.duration_seconds ?? 60) / 60)) : (setDraft?.expected.nextSetIndex ?? sets.length) + 1}</strong><small>{isTimed ? "分钟目标" : `/ ${planned?.sets ?? "自由"}`}</small></div>
        <article>
          <header><div><span>{MOVEMENT_PATTERN_LABELS[currentExercise?.pattern ?? "isolation"]}</span><h1>{currentExercise?.name_zh ?? current.exercise_id}</h1><p>{currentExercise?.name_en}</p></div><aside><span>使用器材</span><strong>{equipment?.name ?? "自重"}</strong><small>{equipment?.notes || "没有个人设置备注"}</small></aside></header>
          <div className="sl-live-prescription"><span><small>目标</small><strong>{isTimed ? `${Math.max(1, Math.round((planned?.duration_seconds ?? 60) / 60))} 分钟` : `${planned?.sets ?? "自定"} 组 × ${planned?.rep_min ?? "自定"}${planned?.rep_max && planned.rep_max !== planned.rep_min ? `–${planned.rep_max}` : ""}`}</strong></span><span><small>{isTimed ? "强度" : "负荷"}</small><strong>{planned?.load_guidance ?? (isTimed ? "以可持续主观强度完成" : "从保守负荷开始")}</strong></span><span><small>休息</small><strong>{planned?.rest_seconds ?? snapshot.profile?.rest_seconds ?? 90} 秒</strong></span></div>
          {relevantConstraints.length > 0 && <aside className="sl-live-boundaries" aria-label="与当前动作相关的身体边界"><span>本场提醒</span><div>{relevantConstraints.map((constraint) => <p key={constraint.id}><b>{constraint.severity === "avoid" ? "停止并换动作" : constraint.severity === "modify" ? "按记录调整" : "留意"}</b>{constraint.label}{constraint.note ? `：${constraint.note}` : ""}</p>)}</div></aside>}
          <form ref={setFormRef} key={setDraft?.exerciseId ?? current.id} className="sl-set-form" onSubmit={(event) => void record(event)}>
            {isTimed ? <label><span>实际时长 <small>分钟</small></span><input required disabled={liveWriteLocked} inputMode="decimal" name="durationMinutes" type="number" min="0.5" max="1440" step="0.5" value={setDraft?.durationMinutes ?? ""} onChange={(event) => updateSetDraft("durationMinutes", event.target.value)}/></label> : <><label><span>重量 <small>{unit}</small></span><input disabled={liveWriteLocked} inputMode="decimal" name="weight" type="number" min="0" step="0.01" value={setDraft?.weight ?? ""} onChange={(event) => updateSetDraft("weight", event.target.value)} placeholder="可留空"/></label><label><span>次数</span><input required disabled={liveWriteLocked} inputMode="numeric" name="reps" type="number" min="0" max="1000" value={setDraft?.reps ?? ""} onChange={(event) => updateSetDraft("reps", event.target.value)}/></label></>}
            {isTimed ? <label><span>主观强度 <small>RPE</small></span><input disabled={liveWriteLocked} inputMode="numeric" name="rpe" type="number" min="1" max="10" value={setDraft?.rpe ?? ""} onChange={(event) => updateSetDraft("rpe", event.target.value)} placeholder="1–10，可跳过"/></label> : <label><span>还可做几次 <small>RIR</small></span><input disabled={liveWriteLocked} inputMode="numeric" name="rir" type="number" min="0" max="5" value={setDraft?.rir ?? ""} onChange={(event) => updateSetDraft("rir", event.target.value)} placeholder="可跳过"/></label>}
            <label className="sl-pain-field"><span>有不适？（可选）</span><input disabled={liveWriteLocked} name="pain" value={setDraft?.pain ?? ""} onChange={(event) => updateSetDraft("pain", event.target.value)} placeholder="出现疼痛时先停下，不用完成这条记录"/></label>
            <button className="sl-live-record" disabled={interactionLocked}>{liveWrites.busy ? "正在安全保存…" : isTimed ? "记录这段时长" : "记录这一组"}</button>
            {setDraft?.dirty && !draftStale && <button type="button" className="sl-live-draft-reset" disabled={liveWrites.busy} onClick={discardUnrecordedDraft}>放弃这次输入</button>}
          </form>
          {sets.length > 0 && <div className="sl-set-history"><header><span>这次已经记录</span><small>撤销只删除对应这一条</small></header>{sets.map((set) => <div key={set.id}><i>{set.set_index + 1}</i><span><b>{set.duration_seconds !== null ? `${Number((set.duration_seconds / 60).toFixed(1))} 分钟` : displayLoad(set.load_grams, unit)}</b><small>{set.duration_seconds !== null ? `计时记录 · RPE ${set.rpe ?? "—"}` : `${set.reps ?? "—"} 次 · RIR ${set.rir ?? "—"}`}</small></span>{set.pain_note && <em>已记不适</em>}<button disabled={nonRecordLocked} aria-label={`撤销第${set.set_index + 1}条记录`} onClick={() => void undoSet(set.id)}>↶</button></div>)}</div>}
          <footer className="sl-live-actions"><button disabled={nonRecordLocked || sets.length > 0} onClick={() => { setSelectedExerciseId(current.id); setDialog("substitution"); }}>{sets.length > 0 ? "已有记录，不能再替换" : "器材被占 / 换动作"}</button>{sets.length === 0 && <button disabled={nonRecordLocked} onClick={() => void completeExercise(true)}>今天不做这个动作</button>}{sets.length > 0 && <button disabled={nonRecordLocked} className="sl-primary" onClick={() => void completeExercise(false)}>完成这个动作</button>}</footer>
        </article>
      </section> : <section className="sl-live-done"><span>THIS SESSION, SO FAR</span><h1>本场动作已到这里。</h1><p>没有新的记录表单。你可以结束保存，或按当前场地再加一个动作。</p><button disabled={interactionLocked} onClick={() => setDialog("exercise-picker")}>＋ 再加一个动作</button></section>}
    </> : <section className="sl-live-empty"><span>临时训练</span><h1>从现在想做的动作开始。</h1><p>只会显示当前场地真实可完成的动作；第一次负荷不用猜。</p><button disabled={interactionLocked} className="sl-primary" onClick={() => setDialog("exercise-picker")}>＋ 添加一个动作</button></section>}
    <footer className="sl-live-bottom"><span>{hasActualFacts ? `${actualRowCount} 个动作有实际记录` : "还没有实际组数或时长记录"}</span><div className="sl-live-bottom-actions">{!hasActualFacts && <button disabled={nonRecordLocked} onClick={(event) => requestLiveConfirm("cancel", event.currentTarget)}>取消误开的训练</button>}<button disabled={nonRecordLocked} onClick={(event) => requestLiveConfirm("finish", event.currentTarget)}>{hasActualFacts ? "结束并保存" : "保存空时段"}</button></div></footer>
    <ExercisePicker open={dialog === "exercise-picker"} busy={liveWriteLocked} title="添加现场动作" exercises={availableExercises} equipment={sessionEquipment} equipmentLoads={sessionLoads} onClose={() => { if (!liveWrites.operationInProgress()) { setDialog(null); setSelectedExerciseId(null); } }} onPick={addExercise} />
    <ExercisePicker open={dialog === "substitution"} busy={liveWriteLocked} title="换一个现在能做的版本" exercises={current && sets.length === 0 ? availableExercises.filter((exercise) => exercise.pattern === currentExercise?.pattern && exercise.id !== current.exercise_id) : []} equipment={sessionEquipment} equipmentLoads={sessionLoads} onClose={() => { if (!liveWrites.operationInProgress()) { setDialog(null); setSelectedExerciseId(null); } }} onPick={substituteExercise} />
    <FitnessDialog open={confirmAction !== null && dialog !== "live-recovery" && dialog !== "plan-calendar-recovery"} eyebrow="SAVE WHAT HAPPENED" title={confirmAction === "cancel" ? "取消这次误开的训练？" : confirmAction === "leave" ? "保存到这里并离开？" : "结束并保存这场训练？"} busy={liveWrites.busy || planCalendarWrites.busy} initialFocus="[data-live-confirm-keep]" onClose={closeLiveConfirm}>
      <section className="sl-live-confirm"><p>{confirmAction === "cancel" ? "这场训练还没有实际组数或时长记录。取消只移除误开的训练；若来自日历，原安排会回到待进行。" : confirmAction === "leave" ? "只保存已经发生的组数、时长与训练时段；后面的计划动作不会被算作未完成。" : "只保存已经发生的内容；没有记录的计划动作不会变成欠账。"}</p><footer><button type="button" data-live-confirm-keep disabled={liveWrites.busy} onClick={closeLiveConfirm}>继续保留这场训练</button><button type="button" className={confirmAction === "cancel" ? "sl-danger-action" : "sl-primary"} disabled={liveWriteLocked} onClick={() => void confirmLiveAction()}>{liveWrites.busy ? "正在安全处理…" : confirmAction === "cancel" ? "确认取消误开" : confirmAction === "leave" ? "保存到这里" : "结束并保存"}</button></footer></section>
    </FitnessDialog>
    <FitnessDialog open={dialog === "live-recovery"} eyebrow="LIVE FACT RECEIPT" title="核对训练写入" busy={liveWrites.busy} initialFocus=".sl-live-write-recovery button:not([disabled]), [data-dialog-close]" onClose={() => { if (!liveWrites.operationInProgress()) setDialog(null); }} wide><FitnessLiveWriteRecovery controller={liveWrites} /></FitnessDialog>
    <FitnessDialog open={dialog === "plan-calendar-recovery"} eyebrow="PLAN & CALENDAR RECEIPT" title="核对计划或日历写入" busy={planCalendarWrites.busy} initialFocus=".sl-plan-calendar-write-recovery button:not([disabled]), [data-dialog-close]" onClose={() => { if (!planCalendarWrites.operationInProgress()) setDialog(null); }} wide><FitnessPlanCalendarWriteRecovery controller={planCalendarWrites} /></FitnessDialog>
    {error && <div className="sl-error-toast" role="alert"><span>需要确认</span>{error}<button onClick={() => setError("")} aria-label="关闭错误">×</button></div>}
    {toast && <div className="sl-toast" role="status"><i>✓</i>{toast}</div>}
  </main>;
}

function ExercisePicker({ open, busy, title, exercises, equipment, equipmentLoads, onClose, onPick }: { open: boolean; busy: boolean; title: string; exercises: readonly FitnessExercise[]; equipment: readonly FitnessEquipment[]; equipmentLoads: readonly FitnessEquipmentLoad[]; onClose: () => void; onPick: (exercise: FitnessExercise) => Promise<void> }) {
  const [query, setQuery] = useState("");
  return <FitnessDialog open={open} busy={busy} eyebrow="CURRENT VENUE ONLY" title={title} onClose={onClose} wide><div className="sl-picker"><label><span aria-hidden="true">⌕</span><input disabled={busy} aria-label="搜索现场动作" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索动作"/></label><div>{exercises.filter((exercise) => `${exercise.name_zh}${exercise.name_en}`.toLowerCase().includes(query.toLowerCase())).map((exercise) => <button disabled={busy} key={exercise.id} onClick={() => void onPick(exercise)}><i>{MOVEMENT_PATTERN_LABELS[exercise.pattern].slice(0, 1)}</i><span><b>{exercise.name_zh}</b><small><EquipmentRequirementList kinds={exercise.requirements.map((entry) => entry.kind)}/></small></span><strong>{exerciseFitsEquipment(exercise, equipment, equipmentLoads) ? "可执行" : "缺器材或成对档位"}</strong></button>)}</div>{!exercises.length && <p className="sl-empty-copy padded">当前场地没有同目的、且器材完整的替代动作。可以先做后续动作。</p>}</div></FitnessDialog>;
}
