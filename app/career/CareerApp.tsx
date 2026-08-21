"use client";

import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  Archive, ArrowRight, ArrowUpRight, BarChart3, Bell,
  BriefcaseBusiness, CalendarDays, Check, CheckCircle2, ChevronRight,
  Circle, Clock3, Command, ContactRound, Download, ExternalLink,
  FileArchive, FileText, Filter, GripVertical, Import, Inbox,
  LayoutDashboard, Link2, ListTodo, LoaderCircle, Menu, MessageSquareText,
  PanelTop, Pencil, Phone, Plus, RotateCcw, Search, Settings,
  ShieldCheck, Sparkles, Target, Trash2, Upload, UserRound, UsersRound,
  WandSparkles, X, Zap,
} from "lucide-react";
import {
  FormEvent, ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState,
} from "react";
import Link from "next/link";
import {
  addActivity, CAREER_LEGACY_DEMO_REVIEW_NEEDED, getCareerLegacyDemoResolution, initializeCareerDb,
  loadCareerData, newId, runCareerBatch, runCareerSql,
} from "@/lib/career/db";
import {
  archiveCareerContact,
  createCareerContact,
  createCareerContactTask,
  loadCareerContactDetail,
  loadCareerContacts,
  recordCareerContactInteraction,
  restoreCareerContact,
  updateCareerContact,
  type CareerContactDetail,
} from "@/lib/career/contacts";
import {
  exportCompleteCareerBackup,
  isCompleteCareerBackup,
  restoreCompleteCareerBackup,
  restoreLegacyCareerDatabase,
} from "@/lib/career/backup";
import { createStructuredInterviewDraft } from "@/lib/career/interview-ai";
import { subscribeToCareerGenerationChanges, withCareerWriteLock } from "@/lib/career/lock";
import { createLocalFileObjectUrl, deleteLocalFile, saveLocalFile } from "@/lib/local-db/files";
import type {
  AiAction, CareerData, CareerView, Contact, Interview, InterviewQuestion,
  Job, Material, Notice, Stage, Task,
} from "@/lib/career/types";

const navItems: Array<{ id: CareerView; label: string; compact: string; icon: typeof LayoutDashboard }> = [
  { id: "today", label: "今日", compact: "今日", icon: LayoutDashboard },
  { id: "board", label: "求职看板", compact: "看板", icon: PanelTop },
  { id: "jobs", label: "全部职位", compact: "职位", icon: BriefcaseBusiness },
  { id: "calendar", label: "待办日历", compact: "待办", icon: CalendarDays },
  { id: "interviews", label: "面经", compact: "面经", icon: MessageSquareText },
  { id: "contacts", label: "联系人", compact: "联系", icon: UsersRound },
  { id: "materials", label: "材料", compact: "材料", icon: FileText },
  { id: "analytics", label: "分析", compact: "分析", icon: BarChart3 },
  { id: "settings", label: "设置", compact: "设置", icon: Settings },
];

const emptyData: CareerData = { stages: [], jobs: [], tasks: [], interviews: [], contacts: [], materials: [], activities: [] };
const sourceClass: Record<string, string> = { LinkedIn: "linkedin", BOSS直聘: "boss", 官网: "website", 内推: "referral" };
function useCareerClock() {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const updateClock = () => setClock(Date.now());
    const timer = window.setInterval(updateClock, 60_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") updateClock();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
  return clock;
}

function dateInputValue(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function fromDateInput(value: string) { return value ? new Date(value).toISOString() : null; }

function formatDate(value: string | null, includeTime = false) {
  if (!value) return "未安排";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日期待确认";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short", day: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).format(date);
}

function relativeDate(value: string | null, clock: number) {
  if (!value) return "未安排";
  const days = Math.ceil((new Date(value).getTime() - clock) / 86_400_000);
  if (days < 0) return `逾期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天";
  if (days === 1) return "明天";
  return `${days} 天后`;
}

function neutralActivityDetail(detail: string) {
  return detail.replace(/^推进至(?=「)/, "阶段改为");
}

export function resolveCareerTodayFocus(data: CareerData, now: number) {
  const terminalStages = new Set(data.stages.filter((stage) => stage.is_terminal === 1).map((stage) => stage.id));
  const eligibleJobs = data.jobs.filter((job) => job.archived !== 1 && !terminalStages.has(job.stage_id));
  const eligibleJobsById = new Map(eligibleJobs.map((job) => [job.id, job]));
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const interview = data.interviews
    .filter((item) => {
      const scheduledAt = item.scheduled_at ? new Date(item.scheduled_at).getTime() : Number.NaN;
      return item.status === "scheduled" && eligibleJobsById.has(item.job_id) &&
        Number.isFinite(scheduledAt) && scheduledAt >= startOfToday.getTime();
    })
    .sort((left, right) => new Date(left.scheduled_at!).getTime() - new Date(right.scheduled_at!).getTime())[0];
  if (interview) return { kind: "interview" as const, interviewId: interview.id, jobId: interview.job_id };

  const task = data.tasks
    .filter((item) => item.status === "todo" && (!item.job_id || eligibleJobsById.has(item.job_id)))
    .sort((left, right) => {
      const leftTime = left.due_at ? new Date(left.due_at).getTime() : Number.POSITIVE_INFINITY;
      const rightTime = right.due_at ? new Date(right.due_at).getTime() : Number.POSITIVE_INFINITY;
      return leftTime - rightTime || right.priority - left.priority || left.created_at.localeCompare(right.created_at);
    })[0];
  if (task) return { kind: "task" as const, taskId: task.id, jobId: task.job_id };

  const offer = eligibleJobs
    .filter((job) => job.stage_id === "stage_offer")
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
  if (offer) return { kind: "offer" as const, jobId: offer.id };
  return null;
}

function parseQuestions(value: string): InterviewQuestion[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

function initials(value: string) {
  const clean = value.trim();
  if (!clean) return "职";
  const words = clean.split(/\s+/);
  return words.length > 1 ? `${words[0][0]}${words[1][0]}`.toUpperCase() : clean.slice(0, 2).toUpperCase();
}

function safeLink(url: string) { return /^https?:\/\//i.test(url) ? url : undefined; }

type JobImportDraft = {
  company: string;
  role: string;
  location: string;
  source: string;
  sourceUrl: string;
  salary: string;
  workMode: string;
  description: string;
  keywords: string;
  warnings: string[];
};

function stringList(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function normalizeWorkMode(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["remote", "远程"].includes(normalized)) return "远程";
  if (["hybrid", "混合", "混合办公"].includes(normalized)) return "混合办公";
  if (["onsite", "on-site", "现场", "现场办公"].includes(normalized)) return "现场办公";
  return String(value ?? "").trim();
}

function normalizeSalary(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const salary = value as Record<string, unknown>;
  if (typeof salary.raw === "string" && salary.raw.trim()) return salary.raw.trim();
  const min = typeof salary.min === "number" ? salary.min : null;
  const max = typeof salary.max === "number" ? salary.max : null;
  if (min === null && max === null) return "";
  const currency = String(salary.currency ?? "").toUpperCase();
  const currencyLabel = currency === "CNY" ? "¥" : currency === "USD" ? "$" : currency === "SGD" ? "S$" : currency ? `${currency} ` : "";
  const compact = (amount: number) => amount >= 1_000 && amount % 1_000 === 0 ? `${amount / 1_000}K` : String(amount);
  const range = min !== null && max !== null ? `${compact(min)}–${compact(max)}` : min !== null ? `${compact(min)} 起` : `最高 ${compact(max!)}`;
  const period = salary.period === "month" ? " / 月" : salary.period === "year" ? " / 年" : salary.period === "day" ? " / 天" : salary.period === "hour" ? " / 小时" : "";
  const months = typeof salary.months === "number" && salary.months !== 12 ? ` · ${salary.months} 薪` : "";
  return `${currencyLabel}${range}${period}${months}`;
}

function createJobImportDraft(parsed: Record<string, unknown>, input: string, detectedSource: string): JobImportDraft {
  const responsibilities = stringList(parsed.responsibilities);
  const mustHave = stringList(parsed.must_have);
  const niceToHave = stringList(parsed.nice_to_have);
  const summary = String(parsed.summary ?? "").trim();
  const sections = [
    summary,
    responsibilities.length ? `职位职责\n${responsibilities.map((item) => `• ${item}`).join("\n")}` : "",
    mustHave.length ? `必需条件\n${mustHave.map((item) => `• ${item}`).join("\n")}` : "",
    niceToHave.length ? `加分项\n${niceToHave.map((item) => `• ${item}`).join("\n")}` : "",
    input.trim() ? `原始分享文本\n${input.trim()}` : "",
  ].filter(Boolean);
  const embeddedUrl = input.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),，。]+$/, "") ?? "";
  const parsedSource = String(parsed.source ?? "").toLowerCase();
  const source = detectedSource !== "智能识别" ? detectedSource : parsedSource === "linkedin" ? "LinkedIn" : parsedSource === "boss" ? "BOSS直聘" : "智能导入";
  return {
    company: String(parsed.company ?? parsed.company_name ?? "").trim(),
    role: String(parsed.role ?? parsed.title ?? "").trim(),
    location: String(parsed.location ?? "").trim(),
    source,
    sourceUrl: String(parsed.url ?? parsed.original_url ?? embeddedUrl).trim(),
    salary: normalizeSalary(parsed.salary),
    workMode: normalizeWorkMode(parsed.work_mode),
    description: sections.join("\n\n") || input.trim(),
    keywords: stringList(parsed.keywords).join(", "),
    warnings: stringList(parsed.warnings),
  };
}

function parseAiContent(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const candidate = record.result ?? record.data ?? record.output ?? record;
  if (typeof candidate === "string") { try { return JSON.parse(candidate); } catch { return candidate; } }
  return candidate;
}

function aiText(value: unknown) {
  if (typeof value === "string") return value;
  if (!value) return "分析完成，但服务没有返回可展示的内容。";
  return JSON.stringify(value, null, 2);
}

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await Promise.race([
        navigator.clipboard.writeText(value),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("clipboard timeout")), 1_500)),
      ]);
      return true;
    }
  } catch { /* fall through to the local selection fallback */ }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function readCaptureParams() {
  if (typeof window === "undefined") return "";
  const params = new URL(window.location.href).searchParams;
  return [params.get("capture")?.trim(), params.get("text")?.trim()].filter(Boolean).join("\n\n");
}

const dialogFocusable = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

function useDialogA11y(onClose: () => void) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer = dialog.closest<HTMLElement>(".career-layer, .career-command-layer");
    const root = dialog.closest<HTMLElement>(".career-app");
    const inertState = new Map<HTMLElement, boolean>();
    if (root && layer) {
      Array.from(root.children).forEach((child) => {
        if (!(child instanceof HTMLElement) || child === layer || child.classList.contains("career-toast-stack")) return;
        inertState.set(child, child.inert);
        child.inert = true;
      });
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      const initial = dialog.querySelector<HTMLElement>("[data-dialog-initial]")
        ?? dialog.querySelector<HTMLElement>("input:not([disabled]):not([type='hidden']), textarea:not([disabled]), select:not([disabled])")
        ?? dialog.querySelector<HTMLElement>("button:not([disabled]), a[href]");
      (initial ?? dialog).focus();
    });

    function focusableItems() {
      return Array.from(dialog!.querySelectorAll<HTMLElement>(dialogFocusable)).filter((element) =>
        !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
    }

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableItems();
      if (items.length === 0) { event.preventDefault(); dialog?.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    dialog.addEventListener("keydown", handleKeydown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      dialog.removeEventListener("keydown", handleKeydown);
      inertState.forEach((wasInert, element) => { element.inert = wasInert; });
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus(); });
    };
  }, []);

  return dialogRef;
}

export default function CareerApp() {
  const careerClock = useCareerClock();
  const [data, setData] = useState<CareerData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [legacyReviewNeeded, setLegacyReviewNeeded] = useState(false);
  const [view, setView] = useState<CareerView>("today");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [priorityOnly, setPriorityOnly] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [capturedDraft] = useState(readCaptureParams);
  const [modal, setModal] = useState<"job" | "task" | "interview" | "material" | "import" | null>(() => capturedDraft ? "import" : null);
  const [importInitial, setImportInitial] = useState(capturedDraft);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedInterviewId, setSelectedInterviewId] = useState<string | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [contactEditorId, setContactEditorId] = useState<string | null | undefined>(undefined);
  const [contactAction, setContactAction] = useState<{ kind: "interaction" | "task"; contactId: string; taskId?: string } | null>(null);
  const [contactRevision, setContactRevision] = useState(0);
  const [contactUndo, setContactUndo] = useState<{ id: string; name: string } | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [undo, setUndo] = useState<{ jobId: string; from: string; to: string } | null>(null);
  const [taskUndo, setTaskUndo] = useState<{ taskId: string; from: Task["status"]; title: string; token: string } | null>(null);
  const [aiState, setAiState] = useState<{ action: AiAction; title: string; loading: boolean; result?: unknown; error?: string; applyLabel?: string; onApply?: (result: unknown) => void | Promise<void> } | null>(null);
  const aiRequestRef = useRef<{ id: string; controller: AbortController } | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async () => setData(await loadCareerData()), []);
  const refreshContacts = useCallback(async () => {
    await refresh();
    setContactRevision((current) => current + 1);
  }, [refresh]);

  useEffect(() => {
    let live = true;
    async function boot() {
      try {
        await initializeCareerDb();
        const next = await loadCareerData();
        const legacyResolution = await getCareerLegacyDemoResolution().catch(() => "none" as const);
        if (live) {
          setData(next);
          setLegacyReviewNeeded(legacyResolution === CAREER_LEGACY_DEMO_REVIEW_NEEDED);
        }
      } catch (error) {
        if (live) setLoadError(error instanceof Error ? error.message : "本地数据库暂时无法打开");
      } finally { if (live) setLoading(false); }
    }
    void boot();
    return () => { live = false; };
  }, [refreshKey]);

  useEffect(() => () => aiRequestRef.current?.controller.abort(), []);

  useEffect(() => subscribeToCareerGenerationChanges(() => window.location.reload()), []);

  useEffect(() => {
    if (!contactUndo) return;
    const timer = window.setTimeout(() => setContactUndo(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [contactUndo]);

  useEffect(() => {
    if (!sidebarOpen || !window.matchMedia("(max-width: 760px)").matches) return;
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const sidebarElement: HTMLElement = sidebar;
    const root = sidebarElement.closest<HTMLElement>(".career-app");
    if (!root) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inertState = new Map<HTMLElement, boolean>();
    Array.from(root.children).forEach((child) => {
      if (
        !(child instanceof HTMLElement) ||
        child === sidebarElement ||
        child.classList.contains("career-scrim") ||
        child.classList.contains("career-toast-stack")
      ) return;
      inertState.set(child, child.inert);
      child.inert = true;
    });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      sidebarElement.querySelector<HTMLElement>("[data-sidebar-close]")?.focus();
    });

    function focusableItems() {
      return Array.from(sidebarElement.querySelectorAll<HTMLElement>(dialogFocusable)).filter((element) =>
        !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
    }
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setSidebarOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableItems();
      if (items.length === 0) { event.preventDefault(); sidebarElement.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    document.addEventListener("keydown", handleKeydown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeydown, true);
      inertState.forEach((wasInert, element) => { element.inert = wasInert; });
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus(); });
    };
  }, [sidebarOpen]);

  useEffect(() => {
    function onKeydown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); }
      if (!typing && event.key === "/") { event.preventDefault(); setSearchOpen(true); }
      if (event.key === "Escape") { setSearchOpen(false); setModal(null); aiRequestRef.current?.controller.abort(); aiRequestRef.current = null; setAiState(null); }
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!capturedDraft) return;
    url.searchParams.delete("capture");
    url.searchParams.delete("text");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [capturedDraft]);

  const notify = useCallback((text: string, tone: Notice["tone"] = "success") => {
    const item = { id: crypto.randomUUID(), tone, text };
    setNotices((current) => [...current, item]);
    window.setTimeout(() => setNotices((current) => current.filter((notice) => notice.id !== item.id)), 3600);
  }, []);

  const filteredJobs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.jobs.filter((job) => {
      const matchesText = !needle || [job.company, job.role, job.location, job.tags, job.note].join(" ").toLowerCase().includes(needle);
      return matchesText && (stageFilter === "all" || job.stage_id === stageFilter) &&
        (sourceFilter === "all" || job.source === sourceFilter) && (!priorityOnly || job.priority >= 3);
    });
  }, [data.jobs, priorityOnly, query, sourceFilter, stageFilter]);

  const selectedJob = data.jobs.find((job) => job.id === selectedJobId) ?? null;
  const selectedInterview = data.interviews.find((item) => item.id === selectedInterviewId) ?? null;
  const activeJob = data.jobs.find((job) => job.id === activeDragId) ?? null;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }));

  async function moveJob(jobId: string, stageId: string, rememberUndo = true) {
    const job = data.jobs.find((item) => item.id === jobId);
    if (!job || job.stage_id === stageId) return true;
    const previous = job.stage_id;
    const nextStage = data.stages.find((stage) => stage.id === stageId);
    setData((current) => ({ ...current, jobs: current.jobs.map((item) => item.id === jobId ? { ...item, stage_id: stageId, updated_at: new Date().toISOString() } : item) }));
    try {
      const now = new Date().toISOString();
      await runCareerBatch([
        { sql: "UPDATE career_jobs SET stage_id = ?, applied_at = CASE WHEN ? = 'stage_applied' AND applied_at IS NULL THEN ? ELSE applied_at END, updated_at = ? WHERE id = ?", params: [stageId, stageId, now, now, jobId] },
        { sql: "INSERT INTO career_activity (id,job_id,type,detail,created_at) VALUES (?,?,?,?,?)", params: [newId("activity"), jobId, "stage", `阶段改为「${nextStage?.name ?? "新阶段"}」`, now] },
      ]);
      if (rememberUndo) setUndo({ jobId, from: previous, to: stageId });
      return true;
    } catch (error) {
      setData((current) => ({ ...current, jobs: current.jobs.map((item) => item.id === jobId ? { ...item, stage_id: previous } : item) }));
      notify(error instanceof Error ? error.message : "进度更新失败", "error");
      return false;
    }
  }

  async function handleUndo() {
    if (!undo) return;
    const item = undo; setUndo(null);
    const restored = await moveJob(item.jobId, item.from, false);
    if (restored) notify("已恢复到原阶段", "info");
    else setUndo(item);
  }

  async function toggleTask(task: Task) {
    const status = task.status === "done" ? "todo" : "done";
    setData((current) => ({ ...current, tasks: current.tasks.map((item) => item.id === task.id ? { ...item, status } : item) }));
    try {
      await runCareerSql("UPDATE career_tasks SET status = ? WHERE id = ?", [status, task.id]);
      const change = { taskId: task.id, from: task.status, title: task.title, token: crypto.randomUUID() };
      setTaskUndo(change);
      window.setTimeout(() => setTaskUndo((current) => current?.token === change.token ? null : current), 6500);
    }
    catch { setData((current) => ({ ...current, tasks: current.tasks.map((item) => item.id === task.id ? task : item) })); notify("待办更新失败", "error"); }
  }

  async function handleTaskUndo() {
    if (!taskUndo) return;
    const change = taskUndo;
    setTaskUndo(null);
    setData((current) => ({ ...current, tasks: current.tasks.map((item) => item.id === change.taskId ? { ...item, status: change.from } : item) }));
    try {
      await runCareerSql("UPDATE career_tasks SET status = ? WHERE id = ?", [change.from, change.taskId]);
      notify("已撤销待办状态", "info");
    } catch {
      const changedStatus = change.from === "todo" ? "done" : "todo";
      setData((current) => ({ ...current, tasks: current.tasks.map((item) => item.id === change.taskId ? { ...item, status: changedStatus } : item) }));
      notify("撤销失败，原状态已保留", "error");
    }
  }

  async function removeJob(job: Job) {
    if (!window.confirm(`将「${job.company} · ${job.role}」移入归档？`)) return;
    await runCareerSql("UPDATE career_jobs SET archived = 1, updated_at = ? WHERE id = ?", [new Date().toISOString(), job.id]);
    setSelectedJobId(null); await refresh(); notify("职位已归档");
  }

  async function runAi(action: AiAction, title: string, payload: unknown, apply?: { label: string; onApply: (result: unknown) => void | Promise<void> }) {
    aiRequestRef.current?.controller.abort();
    const request = { id: crypto.randomUUID(), controller: new AbortController() };
    aiRequestRef.current = request;
    setAiState({ action, title, loading: true, applyLabel: apply?.label, onApply: apply?.onApply });
    try {
      const response = await fetch("/api/ai/career", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, payload }), signal: request.controller.signal });
      const body = await response.json().catch(() => null);
      if (aiRequestRef.current?.id !== request.id) return;
      if (!response.ok) throw new Error((body as { error?: string } | null)?.error || "AI 服务暂时不可用");
      setAiState((current) => current ? { ...current, loading: false, result: parseAiContent(body), error: undefined } : current);
    } catch (error) {
      if (request.controller.signal.aborted || aiRequestRef.current?.id !== request.id) return;
      setAiState((current) => current ? { ...current, loading: false, error: error instanceof Error ? error.message : "请求失败" } : current);
    }
  }

  function navigate(next: CareerView) {
    setView(next);
    setSidebarOpen(false);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
  }
  if (loading) return <CareerLoading />;
  if (loadError) return <CareerError message={loadError} onRetry={() => { setLoading(true); setLoadError(""); setRefreshKey((key) => key + 1); }} />;

  return <main className="career-app">
    <Sidebar sidebarRef={sidebarRef} view={view} open={sidebarOpen} data={data} now={careerClock} onNavigate={navigate} onClose={() => setSidebarOpen(false)} />
    <section className="career-main">
      <Topbar title={navItems.find((item) => item.id === view)?.label ?? "职迹"} query={query} menuOpen={sidebarOpen} onQuery={setQuery} onSearch={() => setSearchOpen(true)} onMenu={() => setSidebarOpen(true)} onAdd={() => setModal("job")} onSettings={() => navigate("settings")} />
      <div className="career-content">
        {view === "today" && <TodayView data={data} now={careerClock} onNavigate={navigate} onSelectJob={setSelectedJobId} onSelectInterview={setSelectedInterviewId} onToggleTask={toggleTask} onAddJob={() => setModal("job")} onAi={runAi} />}
        {view === "board" && <BoardView data={data} jobs={filteredJobs} now={careerClock} query={query} sourceFilter={sourceFilter} priorityOnly={priorityOnly} onSourceFilter={setSourceFilter} onPriorityOnly={setPriorityOnly} onClear={() => { setQuery(""); setSourceFilter("all"); setPriorityOnly(false); }} onSelectJob={setSelectedJobId} onAddJob={() => setModal("job")} onMove={async (jobId, stageId) => { await moveJob(jobId, stageId); }} sensors={sensors} activeJob={activeJob} onDragStart={(event) => setActiveDragId(String(event.active.id))} onDragEnd={async (event) => { setActiveDragId(null); if (!event.over) return; const stageId = String(event.over.id).replace(/^stage:/, ""); if (data.stages.some((stage) => stage.id === stageId)) await moveJob(String(event.active.id), stageId); }} />}
        {view === "jobs" && <JobsView data={data} jobs={filteredJobs} now={careerClock} stageFilter={stageFilter} sourceFilter={sourceFilter} priorityOnly={priorityOnly} onStageFilter={setStageFilter} onSourceFilter={setSourceFilter} onPriorityOnly={setPriorityOnly} onSelectJob={setSelectedJobId} onImport={() => setModal("import")} />}
        {view === "calendar" && <CalendarView data={data} now={careerClock} onToggleTask={toggleTask} onAddTask={() => setModal("task")} onAddInterview={() => setModal("interview")} onSelectJob={setSelectedJobId} />}
        {view === "interviews" && <InterviewsView data={data} now={careerClock} onAdd={() => setModal("interview")} onSelect={setSelectedInterviewId} onAi={runAi} />}
        {view === "contacts" && <ContactsView data={data} now={careerClock} revision={contactRevision} onAdd={() => setContactEditorId(null)} onSelect={setSelectedContactId} />}
        {view === "materials" && <MaterialsView data={data} onAdd={() => setModal("material")} onRemove={async (material) => {
          if (!window.confirm(`移除「${material.name}」${material.file_key ? "及其本地附件原件" : ""}？这个操作无法撤销。`)) return;
          try {
            let fileCleanupFailed = false;
            await withCareerWriteLock(async (context) => {
              await runCareerSql("DELETE FROM career_materials WHERE id = ?", [material.id], context);
              if (material.file_key) {
                try { await deleteLocalFile("career", material.file_key); }
                catch { fileCleanupFailed = true; }
              }
            });
            await refresh();
            if (fileCleanupFailed) { notify("材料记录已移除，但本地附件原件未能清理", "info"); return; }
            notify("材料已移除", "info");
          } catch (error) { notify(error instanceof Error ? error.message : "材料移除失败", "error"); }
        }} />}
        {view === "analytics" && <AnalyticsView data={data} />}
        {view === "settings" && <SettingsView data={data} legacyReviewNeeded={legacyReviewNeeded} onRefresh={refresh} onExport={async () => {
          try {
            const exported = await exportCompleteCareerBackup();
            const url = URL.createObjectURL(exported.blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = exported.fileName;
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
            notify(`完整备份已交给浏览器下载，包含 ${exported.attachmentCount} 个材料附件`);
          } catch (error) { notify(error instanceof Error ? error.message : "导出失败", "error"); }
        }} onImport={async (file) => {
          const complete = await isCompleteCareerBackup(file);
          const confirmation = complete
            ? "恢复完整备份会切换当前职迹数据与已关联材料。文件会先完整校验并写入安全候选，切换前不会改动现有数据。确定继续吗？"
            : "这是旧版 SQLite 备份，只能恢复结构化数据，不包含材料附件原件。它也会先写入安全候选；备份中的附件索引会被清空，避免显示不存在的原件。确定继续吗？";
          if (!window.confirm(confirmation)) return;
          try {
            if (complete) {
              const restored = await restoreCompleteCareerBackup(file);
              await refresh();
              notify(`数据与 ${restored.attachmentCount} 个附件已完整恢复；上一版本已保留作安全回退`);
            } else {
              await restoreLegacyCareerDatabase(file);
              await refresh();
              notify("旧版 SQLite 数据已恢复；附件索引已清空，上一版本已保留作安全回退", "info");
            }
          }
          catch (error) { notify(error instanceof Error ? error.message : "恢复失败", "error"); }
        }} notify={notify} />}
      </div>
    </section>
    <MobileNav view={view} onNavigate={navigate} onMore={() => setSidebarOpen(true)} />
    {selectedJob && <JobDrawer job={selectedJob} data={data} now={careerClock} onClose={() => setSelectedJobId(null)} onMove={async (jobId, stageId) => { await moveJob(jobId, stageId); }} onArchive={removeJob} onRefresh={refresh} onAi={runAi} onSelectContact={(contactId) => { setSelectedJobId(null); setSelectedContactId(contactId); }} notify={notify} />}
    {selectedInterview && <InterviewDrawer interview={selectedInterview} data={data} onClose={() => setSelectedInterviewId(null)} onRefresh={refresh} onAi={runAi} notify={notify} />}
    {selectedContactId && <ContactDrawer
      contactId={selectedContactId}
      revision={contactRevision}
      now={careerClock}
      onClose={() => setSelectedContactId(null)}
      onEdit={() => setContactEditorId(selectedContactId)}
      onRecord={() => setContactAction({ kind: "interaction", contactId: selectedContactId })}
      onTask={(taskId) => setContactAction({ kind: "task", contactId: selectedContactId, taskId })}
      onToggleTask={async (task) => { await toggleTask(task); setContactRevision((current) => current + 1); }}
      onArchive={async (contact) => {
        await archiveCareerContact(contact.id);
        setSelectedContactId(null);
        setContactUndo({ id: contact.id, name: contact.name });
        await refreshContacts();
        notify("联系人已移入归档；历史、关联与待办都保留", "info");
      }}
      onRestore={async (contact) => {
        await restoreCareerContact(contact.id);
        setSelectedContactId(null);
        await refreshContacts();
        notify("联系人已恢复", "info");
      }}
      notify={notify}
    />}
    {modal === "job" && <JobModal data={data} onClose={() => setModal(null)} onSaved={async (id) => { setModal(null); await refresh(); setSelectedJobId(id); notify("职位已加入职迹"); }} />}
    {modal === "task" && <TaskModal data={data} initialJobId={selectedJobId} onClose={() => { setModal(null); setSelectedJobId(null); }} onSaved={async () => { setModal(null); setSelectedJobId(null); await refresh(); notify("待办已创建"); }} />}
    {modal === "interview" && <InterviewModal data={data} onClose={() => setModal(null)} onSaved={async () => { setModal(null); await refresh(); notify("面试轮次已安排"); }} />}
    {modal === "material" && <MaterialModal data={data} onClose={() => setModal(null)} onSaved={async () => { setModal(null); await refresh(); notify("材料已保存"); }} />}
    {modal === "import" && <SmartImportModal data={data} initialInput={importInitial} onClose={() => { setModal(null); setImportInitial(""); }} onSaved={async () => { setModal(null); setImportInitial(""); await refresh(); notify("职位已导入"); }} notify={notify} />}
    {searchOpen && <CommandPalette data={data} onClose={() => setSearchOpen(false)} onNavigate={navigate} onSelectJob={(id) => { setSearchOpen(false); setSelectedJobId(id); }} onAdd={() => { setSearchOpen(false); setModal("job"); }} />}
    {contactEditorId !== undefined && <ContactModal
      contactId={contactEditorId}
      data={data}
      onClose={() => setContactEditorId(undefined)}
      onSaved={async (id) => {
        setContactEditorId(undefined);
        await refreshContacts();
        setSelectedContactId(id);
        notify(contactEditorId ? "联系人资料已更新" : "联系人已保存");
      }}
    />}
    {contactAction?.kind === "interaction" && <ContactInteractionModal
      contactId={contactAction.contactId}
      data={data}
      onClose={() => setContactAction(null)}
      onSaved={async () => {
        setContactAction(null);
        await refreshContacts();
        notify("真实联系已记录");
      }}
    />}
    {contactAction?.kind === "task" && <ContactTaskModal
      contactId={contactAction.contactId}
      taskId={contactAction.taskId}
      data={data}
      onClose={() => setContactAction(null)}
      onSaved={async () => {
        setContactAction(null);
        await refreshContacts();
        notify("下一步已安排");
      }}
    />}
    {aiState && <AiPreview
      state={aiState}
      onClose={() => { aiRequestRef.current?.controller.abort(); aiRequestRef.current = null; setAiState(null); }}
      onCopy={async (result) => {
        const copied = await copyText(aiText(result));
        notify(copied ? "AI 结果已复制，可粘贴到需要保留的位置" : "复制失败，请手动选择结果", copied ? "info" : "error");
        return copied;
      }}
      onApply={aiState.onApply ? async (result) => {
        await aiState.onApply?.(result);
        aiRequestRef.current = null;
        setAiState(null);
        notify("已填入面经草稿；只有点击保存面经后才会写入本地数据库", "info");
      } : undefined}
      applyLabel={aiState.applyLabel}
    />}
    <div className="career-toast-stack" aria-live="polite">{contactUndo && <button className="career-toast undo" onClick={async () => { await restoreCareerContact(contactUndo.id); setContactUndo(null); await refreshContacts(); notify(`已恢复「${contactUndo.name}」`, "info"); }} aria-label={`撤销归档「${contactUndo.name}」`}><RotateCcw size={16} />联系人已归档 <b>撤销</b></button>}{taskUndo && <button className="career-toast undo" onClick={() => void handleTaskUndo()} aria-label={`撤销「${taskUndo.title}」的状态变化`}><RotateCcw size={16} />{taskUndo.from === "todo" ? "待办已完成" : "待办已恢复"} <b>撤销</b></button>}{undo && <button className="career-toast undo" onClick={handleUndo}><RotateCcw size={16} />阶段已更新 <b>撤销</b></button>}{notices.map((notice) => <div className={`career-toast ${notice.tone}`} key={notice.id}>{notice.tone === "success" ? <Check size={16} /> : notice.tone === "error" ? <X size={16} /> : <Bell size={16} />}{notice.text}</div>)}</div>
  </main>;
}

function CareerLoading() { return <main className="career-loading" role="status"><div className="career-loading-mark">职</div><LoaderCircle className="spin" size={20} /><p>正在打开你的求职工作台…</p></main>; }
function CareerError({ message, onRetry }: { message: string; onRetry: () => void }) { return <main className="career-error"><ShieldCheck size={30} /><h1>本地资料暂时没有打开</h1><p>{message}</p><button className="career-button primary" onClick={onRetry}><RotateCcw size={16} />重新尝试</button></main>; }

function Sidebar({ sidebarRef, view, open, data, now, onNavigate, onClose }: { sidebarRef: { current: HTMLElement | null }; view: CareerView; open: boolean; data: CareerData; now: number; onNavigate: (view: CareerView) => void; onClose: () => void }) {
  const active = data.jobs.filter((job) => !["stage_accepted", "stage_rejected", "stage_withdrawn"].includes(job.stage_id)).length;
  const recentNotes = data.activities.filter((item) => now - new Date(item.created_at).getTime() < 7 * 86_400_000).length;
  return <><button className={`career-scrim ${open ? "show" : ""}`} tabIndex={-1} aria-label="关闭导航" onClick={onClose} /><aside ref={sidebarRef} id="career-sidebar" className={`career-sidebar ${open ? "open" : ""}`} role={open ? "dialog" : undefined} aria-modal={open ? "true" : undefined} aria-label={open ? "职迹导航" : undefined} tabIndex={open ? -1 : undefined}>
    <Link href="/" className="career-brand" aria-label="返回私人工作台"><span>职</span><div><b>职迹</b><small>每一步，都算数</small></div></Link><button data-sidebar-close className="career-icon-button mobile-only" style={{ position: "absolute", insetBlockStart: 29, insetInlineEnd: 24 }} onClick={onClose} aria-label="关闭导航"><X size={18} /></button>
    <nav className="career-nav" aria-label="职迹主导航">{navItems.map((item) => <button key={item.id} aria-label={item.label} className={view === item.id ? "active" : ""} onClick={() => onNavigate(item.id)}><item.icon size={18} strokeWidth={1.8} /><span>{item.label}</span>{item.id === "calendar" && data.tasks.filter((task) => task.status === "todo").length > 0 && <em>{data.tasks.filter((task) => task.status === "todo").length}</em>}</button>)}</nav>
    <div className="career-sidebar-spacer" /><div className="career-goal-card calm"><div><span>近 7 天记录</span><b>{recentNotes}<small> 次变化</small></b></div><div className="career-no-score"><ShieldCheck size={14} /><span>不设目标，也不给你打分</span></div><p>{active} 个机会在工作台里，按自己的节奏来。</p></div><div className="career-privacy"><ShieldCheck size={15} /><span>资料保存在本地 SQLite</span><i /></div>
  </aside></>;
}

function Topbar({ title, query, menuOpen, onQuery, onSearch, onMenu, onAdd, onSettings }: { title: string; query: string; menuOpen: boolean; onQuery: (value: string) => void; onSearch: () => void; onMenu: () => void; onAdd: () => void; onSettings: () => void }) {
  return <header className="career-topbar"><div className="career-topbar-title"><button className="career-icon-button mobile-only" onClick={onMenu} aria-label="打开导航" aria-expanded={menuOpen} aria-controls="career-sidebar"><Menu size={20} /></button><h1>{title}</h1></div><div className="career-topbar-actions"><label className="career-search"><Search size={16} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索职位、公司、标签" aria-label="搜索" /><kbd>⌘ K</kbd></label><button className="career-icon-button command-compact" onClick={onSearch} aria-label="打开搜索"><Search size={18} /></button><button className="career-button primary" onClick={onAdd}><Plus size={17} />记录职位</button><button className="career-avatar" aria-label="个人设置" onClick={onSettings}>FK<span /></button></div></header>;
}

function MobileNav({ view, onNavigate, onMore }: { view: CareerView; onNavigate: (view: CareerView) => void; onMore: () => void }) {
  const visible = navItems.filter((item) => ["today", "board", "calendar", "interviews"].includes(item.id));
  const overflowActive = !visible.some((item) => item.id === view);
  return <nav className="career-mobile-nav" aria-label="移动端主导航">{visible.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => onNavigate(item.id)}><item.icon size={20} /><span>{item.compact}</span></button>)}<button onClick={onMore} className={overflowActive ? "active" : ""} aria-haspopup="dialog"><Menu size={20} /><span>更多</span></button></nav>;
}

function SectionHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) { return <div className="career-section-heading"><div>{eyebrow && <span>{eyebrow}</span>}<h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>; }
function Metric({ label, value, note, icon, tone = "blue" }: { label: string; value: string; note: string; icon: ReactNode; tone?: string }) { return <article className={`career-metric ${tone}`}><div><span>{label}</span><b>{value}</b><small>{note}</small></div><i>{icon}</i></article>; }

function CompanyMark({ company, small = false }: { company: string; small?: boolean }) {
  const colors = ["mint", "lavender", "peach", "blue", "sand", "rose"];
  const index = Array.from(company).reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length;
  return <span className={`career-company-mark ${colors[index]} ${small ? "small" : ""}`}>{initials(company)}</span>;
}

function SourceBadge({ source }: { source: string }) { return <span className={`career-source ${sourceClass[source] ?? "other"}`}>{source === "LinkedIn" ? "in" : source === "BOSS直聘" ? "BOSS" : source}</span>; }

function TodayView({ data, now, onNavigate, onSelectJob, onSelectInterview, onToggleTask, onAddJob, onAi }: { data: CareerData; now: number; onNavigate: (view: CareerView) => void; onSelectJob: (id: string) => void; onSelectInterview: (id: string) => void; onToggleTask: (task: Task) => void; onAddJob: () => void; onAi: (action: AiAction, title: string, payload: unknown) => void }) {
  const today = new Date(now);
  const date = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(today);
  const greeting = today.getHours() < 11 ? "早上好" : today.getHours() < 14 ? "中午好" : today.getHours() < 18 ? "下午好" : "晚上好";
  const terminalStages = new Set(data.stages.filter((stage) => stage.is_terminal === 1).map((stage) => stage.id));
  const activeJobs = data.jobs.filter((job) => job.archived !== 1 && !terminalStages.has(job.stage_id));
  const activeJobIds = new Set(activeJobs.map((job) => job.id));
  const openTasks = data.tasks
    .filter((task) => task.status === "todo" && (!task.job_id || activeJobIds.has(task.job_id)))
    .sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"));
  const upcoming = data.interviews
    .filter((item) => item.status === "scheduled" && item.scheduled_at && activeJobIds.has(item.job_id) && new Date(item.scheduled_at).getTime() > now)
    .sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""));
  const waiting = activeJobs.filter((job) => job.stage_id === "stage_applied");
  const focus = resolveCareerTodayFocus(data, now);
  const focusJob = focus?.jobId ? activeJobs.find((job) => job.id === focus.jobId) ?? null : null;
  const focusInterview = focus?.kind === "interview" ? data.interviews.find((item) => item.id === focus.interviewId) ?? null : null;
  const focusTask = focus?.kind === "task" ? openTasks.find((item) => item.id === focus.taskId) ?? null : null;
  const interviewStillAhead = Boolean(focusInterview?.scheduled_at && new Date(focusInterview.scheduled_at).getTime() >= now);

  return <div className="career-view career-today"><section className="career-welcome"><div><span>{date}</span><h2>{greeting}，按自己的节奏来。</h2><p>这里只放你真实安排过的事项；没有必须处理的事，也是一种正常状态。</p></div><div className="career-welcome-actions"><button className="career-button secondary" onClick={() => onNavigate("calendar")}><CalendarDays size={16} />查看日程</button><button className="career-button primary" onClick={onAddJob}><Plus size={16} />记录职位</button></div></section>
    <section className="career-today-grid"><div className="career-panel career-focus-panel"><SectionHeading eyebrow="TODAY" title="今天的落点" />
      {focus?.kind === "interview" && focusJob && focusInterview ? <div className="career-focus-card"><CompanyMark company={focusJob.company} /><div className="career-focus-copy"><span>{focusJob.company}</span><h3>{focusInterview.round_name} · {focusJob.role}</h3><p>{formatDate(focusInterview.scheduled_at, true)} · {focusInterview.interviewer || "面试官待确认"}</p></div><div className="career-focus-actions">{interviewStillAhead && <button className="career-button primary" onClick={() => onAi("interview_prep", "AI 面试准备", { job: focusJob, interview: focusInterview })}><WandSparkles size={16} />AI 准备</button>}<button className="career-button secondary" onClick={() => onSelectInterview(focusInterview.id)}><MessageSquareText size={16} />打开面经</button></div></div> : focus?.kind === "task" && focusTask ? <div className="career-focus-card"><span className="career-focus-symbol"><ListTodo size={20} /></span><div className="career-focus-copy"><span>{focusJob?.company ?? "已记录待办"}</span><h3>{focusTask.title}</h3><p>{focusTask.due_at ? `${formatDate(focusTask.due_at, true)} · ${relativeDate(focusTask.due_at, now)}` : "没有设定时间，可在合适的时候处理"}</p></div><div className="career-focus-actions"><button className="career-button primary" onClick={() => onNavigate("calendar")}><CalendarDays size={16} />查看日程</button>{focusJob && <button className="career-icon-button" onClick={() => onSelectJob(focusJob.id)} aria-label="打开关联职位"><ArrowUpRight size={18} /></button>}</div></div> : focus?.kind === "offer" && focusJob ? <div className="career-focus-card"><CompanyMark company={focusJob.company} /><div className="career-focus-copy"><span>{focusJob.company}</span><h3>{focusJob.role} · Offer 待决定</h3><p>这是需要你亲自权衡的选择，不必为了尽快清空状态而仓促决定。</p></div><div className="career-focus-actions"><button className="career-button primary" onClick={() => onSelectJob(focusJob.id)}>查看记录 <ArrowRight size={14} /></button></div></div> : <div className="career-focus-rest"><span><ShieldCheck size={21} /></span><div><h3>今天没有必须处理的事</h3><p>你可以休息，也可以只在想记录时打开这里。职迹不会替你制造任务。</p></div></div>}
      {focus?.kind === "interview" && interviewStillAhead && <div className="career-focus-tips"><span><i />准备到让自己安心就好，不需要把每一种问题都预测完。</span></div>}
    </div>
      <div className="career-panel career-agenda-panel"><SectionHeading title="今天与接下来" action={<button className="career-text-button" onClick={() => onNavigate("calendar")}>全部日程 <ChevronRight size={14} /></button>} /><div className="career-agenda-list">{openTasks.slice(0, 5).map((task) => { const job = data.jobs.find((item) => item.id === task.job_id); return <button className="career-agenda-item" key={task.id} onClick={() => onToggleTask(task)}><span className={`career-check ${task.status}`}><Check size={13} /></span><span><b>{task.title}</b><small>{job ? `${job.company} · ` : ""}{relativeDate(task.due_at, now)}</small></span><em className={task.priority >= 3 ? "urgent" : ""}>{task.kind}</em></button>; })}{openTasks.length === 0 && <p className="career-agenda-calm">没有待办。需要时再记录下一步，不必为了填满列表而安排。</p>}</div></div>
    </section><section className="career-metric-grid career-today-metrics"><Metric label="活跃机会" value={String(activeJobs.length)} note={`${activeJobs.filter((job) => job.stage_id === "stage_interview").length} 个正在面试`} icon={<BriefcaseBusiness size={18} />} /><Metric label="待办事项" value={String(openTasks.length)} note={`${openTasks.filter((task) => task.due_at && new Date(task.due_at).getTime() < now).length} 项可以重新安排`} icon={<ListTodo size={18} />} tone="amber" /><Metric label="近期待面" value={String(upcoming.length)} note={upcoming[0] ? `${formatDate(upcoming[0].scheduled_at, true)} · ${upcoming[0].round_name}` : "暂未安排"} icon={<CalendarDays size={18} />} tone="plum" /><Metric label="等待回应" value={String(waiting.length)} note="等待也是流程的一部分" icon={<Clock3 size={18} />} tone="green" /></section><section className="career-panel career-recent"><SectionHeading title="最近动态" description="只记录发生过的变化，不评价进度快慢" action={<button className="career-text-button" onClick={() => onNavigate("jobs")}>查看全部</button>} /><div className="career-activity-row">{data.activities.slice(0, 4).map((item) => { const job = data.jobs.find((entry) => entry.id === item.job_id); return <button key={item.id} onClick={() => job && onSelectJob(job.id)}><span className={`career-activity-icon ${item.type}`}><Zap size={15} /></span><span><b>{neutralActivityDetail(item.detail)}</b><small>{job ? `${job.company} · ${job.role}` : "职迹"}</small></span><time>{formatDate(item.created_at)}</time></button>; })}</div></section>
  </div>;
}

type SensorValue = ReturnType<typeof useSensors>;
function BoardView({ data, jobs, now, query, sourceFilter, priorityOnly, onSourceFilter, onPriorityOnly, onClear, onSelectJob, onAddJob, onMove, sensors, activeJob, onDragStart, onDragEnd }: { data: CareerData; jobs: Job[]; now: number; query: string; sourceFilter: string; priorityOnly: boolean; onSourceFilter: (value: string) => void; onPriorityOnly: (value: boolean) => void; onClear: () => void; onSelectJob: (id: string) => void; onAddJob: () => void; onMove: (jobId: string, stageId: string) => Promise<void>; sensors: SensorValue; activeJob: Job | null; onDragStart: (event: DragStartEvent) => void; onDragEnd: (event: DragEndEvent) => void }) {
  const stages = data.stages.filter((stage) => !stage.hidden && !["stage_accepted", "stage_rejected", "stage_withdrawn"].includes(stage.id));
  return <div className="career-view career-board-view"><SectionHeading eyebrow="PIPELINE" title="求职看板" description={`${jobs.length} 个机会 · 拖动卡片，或使用卡片内的阶段菜单`} action={<div className="career-view-actions"><button className={`career-chip ${priorityOnly ? "active" : ""}`} aria-pressed={priorityOnly} onClick={() => onPriorityOnly(!priorityOnly)}><Target size={14} />只看重点</button><select className="career-select compact" value={sourceFilter} onChange={(event) => onSourceFilter(event.target.value)} aria-label="来源筛选"><option value="all">全部来源</option>{[...new Set(data.jobs.map((job) => job.source))].map((source) => <option key={source}>{source}</option>)}</select><button className="career-icon-button" onClick={onClear} aria-label="清除筛选"><RotateCcw size={16} /></button></div>} />{(query || sourceFilter !== "all" || priorityOnly) && <div className="career-filter-summary"><Filter size={14} />当前显示 {jobs.length} 个结果<button onClick={onClear}>清除全部</button></div>}
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}><div className="career-board-scroll">{stages.map((stage) => <BoardColumn key={stage.id} stage={stage} jobs={jobs.filter((job) => job.stage_id === stage.id)} data={data} now={now} onSelectJob={onSelectJob} onAddJob={onAddJob} onMove={onMove} />)}</div><DragOverlay>{activeJob ? <JobCard job={activeJob} data={data} now={now} overlay onSelect={() => undefined} /> : null}</DragOverlay></DndContext>
  </div>;
}

function BoardColumn({ stage, jobs, data, now, onSelectJob, onAddJob, onMove }: { stage: Stage; jobs: Job[]; data: CareerData; now: number; onSelectJob: (id: string) => void; onAddJob: () => void; onMove: (jobId: string, stageId: string) => Promise<void> }) {
  const { isOver, setNodeRef } = useDroppable({ id: `stage:${stage.id}` });
  return <section ref={setNodeRef} className={`career-board-column ${isOver ? "over" : ""}`}><header><div><i style={{ background: stage.color }} /><b>{stage.name}</b><span>{jobs.length}</span></div><button onClick={onAddJob} aria-label={`在${stage.name}添加职位`}><Plus size={16} /></button></header><div className="career-board-cards">{jobs.map((job) => <DraggableJobCard key={job.id} job={job} data={data} now={now} onSelect={() => onSelectJob(job.id)} onMove={onMove} />)}{jobs.length === 0 && <div className="career-board-empty">拖到这里</div>}</div><button className="career-add-inline" onClick={onAddJob}><Plus size={15} />添加职位</button></section>;
}

function DraggableJobCard({ job, data, now, onSelect, onMove }: { job: Job; data: CareerData; now: number; onSelect: () => void; onMove: (jobId: string, stageId: string) => Promise<void> }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: job.id });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  return <div ref={setNodeRef} style={style} className={isDragging ? "dragging" : ""}><JobCard job={job} data={data} now={now} onSelect={onSelect} onMove={onMove} dragProps={{ ...attributes, ...listeners }} /></div>;
}

function JobCard({ job, data, now, onSelect, onMove, overlay = false, dragProps = {} }: { job: Job; data: CareerData; now: number; onSelect: () => void; onMove?: (jobId: string, stageId: string) => Promise<void>; overlay?: boolean; dragProps?: Record<string, unknown> }) {
  const nextTask = data.tasks.find((task) => task.job_id === job.id && task.status === "todo");
  const upcoming = data.interviews.find((item) => item.job_id === job.id && item.status === "scheduled");
  const draggable = Object.keys(dragProps).length > 0;
  return <article className={`career-job-card ${overlay ? "overlay" : ""}`}><div className="career-job-card-top"><CompanyMark company={job.company} small />{draggable && <button className="career-grip" {...dragProps} aria-label={`拖动 ${job.company} ${job.role}`}><GripVertical size={16} /></button>}</div><button className="career-job-card-open" onClick={onSelect} aria-label={`打开 ${job.company} ${job.role}`}><h3>{job.role}</h3><p>{job.company}</p><div className="career-card-meta"><span>{job.location || "地点待定"}</span>{job.work_mode && <span>{job.work_mode}</span>}</div><div className="career-card-tags">{job.tags.split(",").filter(Boolean).slice(0, 2).map((tag) => <i key={tag}>{tag}</i>)}</div><div className={`career-next ${nextTask?.due_at && new Date(nextTask.due_at).getTime() < now ? "late" : ""}`}><Clock3 size={13} /><span>{upcoming ? `${formatDate(upcoming.scheduled_at, true)} · ${upcoming.round_name}` : nextTask ? `${relativeDate(nextTask.due_at, now)} · ${nextTask.title}` : "还没有下一步"}</span></div></button><footer><SourceBadge source={job.source} />{onMove ? <select value={job.stage_id} onChange={(event) => void onMove(job.id, event.target.value)} aria-label={`移动 ${job.company} ${job.role} 到阶段`}>{data.stages.filter((stage) => !stage.hidden).map((stage) => <option value={stage.id} key={stage.id}>{stage.name}</option>)}</select> : <span className="career-priority" aria-label={`优先级 ${job.priority}`}>{[1, 2, 3].map((dot) => <i key={dot} className={dot <= job.priority ? "active" : ""} />)}</span>}</footer></article>;
}

function JobsView({ data, jobs, now, stageFilter, sourceFilter, priorityOnly, onStageFilter, onSourceFilter, onPriorityOnly, onSelectJob, onImport }: { data: CareerData; jobs: Job[]; now: number; stageFilter: string; sourceFilter: string; priorityOnly: boolean; onStageFilter: (value: string) => void; onSourceFilter: (value: string) => void; onPriorityOnly: (value: boolean) => void; onSelectJob: (id: string) => void; onImport: () => void }) {
  return <div className="career-view"><SectionHeading eyebrow="APPLICATIONS" title="全部职位" description={`共 ${data.jobs.length} 个职位，${data.jobs.filter((job) => job.stage_id === "stage_interview").length} 个正在面试`} action={<button className="career-button secondary" onClick={onImport}><Import size={16} />智能导入</button>} />
    <div className="career-toolbar"><select className="career-select" value={stageFilter} onChange={(event) => onStageFilter(event.target.value)} aria-label="按阶段筛选"><option value="all">全部阶段</option>{data.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select><select className="career-select" value={sourceFilter} onChange={(event) => onSourceFilter(event.target.value)} aria-label="按来源筛选"><option value="all">全部来源</option>{[...new Set(data.jobs.map((job) => job.source))].map((source) => <option key={source}>{source}</option>)}</select><button className={`career-chip ${priorityOnly ? "active" : ""}`} aria-pressed={priorityOnly} onClick={() => onPriorityOnly(!priorityOnly)}><Target size={14} />重点关注</button><span className="career-toolbar-count">显示 {jobs.length} 条</span></div>
    <div className="career-mobile-job-list">{jobs.map((job) => { const stage = data.stages.find((item) => item.id === job.stage_id); const task = data.tasks.find((item) => item.job_id === job.id && item.status === "todo"); return <article className="career-mobile-job-card" key={job.id}><button onClick={() => onSelectJob(job.id)} aria-label={`打开 ${job.company} ${job.role}`}><header><CompanyMark company={job.company} small /><span><b>{job.role}</b><small>{job.company}</small></span><ChevronRight size={18} /></header><div className="career-mobile-job-meta"><span className="career-stage-pill"><i style={{ background: stage?.color }} />{stage?.name}</span><SourceBadge source={job.source} /><span>{job.location || "地点待确认"}</span></div><div className={`career-mobile-job-next ${task?.due_at && new Date(task.due_at).getTime() < now ? "late" : ""}`}><Clock3 size={14} /><span>{task ? `${relativeDate(task.due_at, now)} · ${task.title}` : "还没有安排下一步"}</span></div></button></article>; })}{jobs.length === 0 && <EmptyState icon={<Inbox />} title="没有匹配的职位" text="调整筛选条件，或导入一个新的机会。" />}</div>
    <div className="career-table-wrap"><table className="career-table"><thead><tr><th>职位</th><th>阶段</th><th>来源</th><th>地点</th><th>投递时间</th><th>下一步</th><th /></tr></thead><tbody>{jobs.map((job) => { const stage = data.stages.find((item) => item.id === job.stage_id); const task = data.tasks.find((item) => item.job_id === job.id && item.status === "todo"); return <tr key={job.id}><td><button className="career-job-row-button" onClick={() => onSelectJob(job.id)}><span className="career-job-cell"><CompanyMark company={job.company} small /><span><b>{job.role}</b><small>{job.company}</small></span></span></button></td><td><span className="career-stage-pill"><i style={{ background: stage?.color }} />{stage?.name}</span></td><td><SourceBadge source={job.source} /></td><td>{job.location || "—"}</td><td>{job.applied_at ? formatDate(job.applied_at) : "尚未投递"}</td><td><span className={task?.due_at && new Date(task.due_at).getTime() < now ? "career-late-text" : ""}>{task ? `${relativeDate(task.due_at, now)} · ${task.title}` : "—"}</span></td><td><button className="career-row-open" onClick={() => onSelectJob(job.id)} aria-label={`打开 ${job.company} ${job.role}`}><ChevronRight size={16} /></button></td></tr>; })}</tbody></table>{jobs.length === 0 && <EmptyState icon={<Inbox />} title="没有匹配的职位" text="调整筛选条件，或导入一个新的机会。" />}</div>
  </div>;
}

function CalendarView({ data: sourceData, now, onToggleTask, onAddTask, onAddInterview, onSelectJob }: { data: CareerData; now: number; onToggleTask: (task: Task) => void; onAddTask: () => void; onAddInterview: () => void; onSelectJob: (id: string) => void }) {
  const data = { ...sourceData, interviews: sourceData.interviews.filter((item) => item.status === "scheduled") };
  const [mode, setMode] = useState<"agenda" | "week">("agenda");
  const [showCompleted, setShowCompleted] = useState(false);
  const open = data.tasks.filter((task) => task.status === "todo").sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"));
  const completed = data.tasks.filter((task) => task.status === "done").sort((a, b) => (b.due_at ?? b.created_at).localeCompare(a.due_at ?? a.created_at));
  const days = Array.from({ length: 7 }, (_, index) => { const date = new Date(now); date.setDate(date.getDate() + index); date.setHours(0, 0, 0, 0); return date; });
  return <div className="career-view"><SectionHeading eyebrow="PLAN" title="待办与日历" description="把投递、面试和跟进放在同一条时间线上" action={<div className="career-view-actions"><button className="career-button secondary" onClick={onAddInterview}><CalendarDays size={16} />安排面试</button><button className="career-button primary" onClick={onAddTask}><Plus size={16} />新建待办</button></div>} /><div className="career-segmented"><button className={mode === "agenda" ? "active" : ""} onClick={() => setMode("agenda")}>议程</button><button className={mode === "week" ? "active" : ""} onClick={() => setMode("week")}>未来 7 天</button></div>
    {mode === "agenda" ? <div className="career-plan-grid"><section className="career-panel career-task-list"><header><h3>待办清单</h3><span>{open.length} 项未完成</span></header>{open.map((task) => { const job = data.jobs.find((item) => item.id === task.job_id); return <article key={task.id}><button className="career-check" onClick={() => onToggleTask(task)} aria-label={`完成「${task.title}」`}><Check size={13} /></button><div><b>{task.title}</b><button onClick={() => job && onSelectJob(job.id)}>{job ? `${job.company} · ${job.role}` : "通用任务"}</button></div><span className={task.due_at && new Date(task.due_at).getTime() < now ? "late" : ""}><Clock3 size={13} />{relativeDate(task.due_at, now)}</span><em>{task.kind}</em></article>; })}{open.length === 0 && <p className="career-task-calm-empty">目前没有待办。需要时再记录下一步就好。</p>}{completed.length > 0 && <div className="career-completed-block"><button className="career-completed-toggle" onClick={() => setShowCompleted((current) => !current)} aria-expanded={showCompleted}><span><CheckCircle2 size={15} />已完成</span><em>{completed.length}</em><small>{showCompleted ? "收起" : "查看与恢复"}</small><ChevronRight size={15} /></button>{showCompleted && <div className="career-completed-list">{completed.map((task) => { const job = data.jobs.find((item) => item.id === task.job_id); return <article key={task.id}><span><Check size={13} /></span><div><b>{task.title}</b><small>{job ? `${job.company} · ${job.role}` : "通用任务"}</small></div><button onClick={() => onToggleTask(task)} aria-label={`恢复「${task.title}」`}>恢复</button></article>; })}</div>}</div>}</section><section className="career-panel career-upcoming"><header><h3>面试日程</h3><span>按时间排序</span></header>{data.interviews.filter((item) => item.status !== "completed").map((item) => { const job = data.jobs.find((entry) => entry.id === item.job_id); return <button key={item.id} onClick={() => job && onSelectJob(job.id)}><time><b>{new Date(item.scheduled_at ?? "").getDate() || "—"}</b><small>{formatDate(item.scheduled_at)}</small></time><span><b>{job?.company} · {item.round_name}</b><small>{formatDate(item.scheduled_at, true)} · {item.duration} 分钟</small></span><ChevronRight size={16} /></button>; })}</section></div> : <div className="career-week-grid">{days.map((day) => { const key = day.toDateString(); const tasks = open.filter((task) => task.due_at && new Date(task.due_at).toDateString() === key); const interviews = data.interviews.filter((item) => item.scheduled_at && new Date(item.scheduled_at).toDateString() === key); return <section key={key} className={key === new Date(now).toDateString() ? "today" : ""}><header><span>{new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(day)}</span><b>{day.getDate()}</b></header><div>{interviews.map((item) => <article className="event" key={item.id}><CalendarDays size={13} /><b>{data.jobs.find((job) => job.id === item.job_id)?.company}</b><small>{item.round_name}</small></article>)}{tasks.map((task) => <article key={task.id}><Circle size={12} /><b>{task.title}</b><small>{dateInputValue(task.due_at).slice(11)}</small></article>)}</div></section>; })}</div>}
  </div>;
}

function InterviewsView({ data, now, onAdd, onSelect, onAi }: { data: CareerData; now: number; onAdd: () => void; onSelect: (id: string) => void; onAi: (action: AiAction, title: string, payload: unknown) => void }) {
  const [tab, setTab] = useState<"upcoming" | "archive">("upcoming");
  const shown = data.interviews.filter((item) => tab === "archive" ? item.status !== "scheduled" : item.status === "scheduled");
  return <div className="career-view"><SectionHeading eyebrow="INTERVIEW LOG" title="面试与面经" description="每一轮都有准备、有记录，也有下一次会用到的经验" action={<button className="career-button primary" onClick={onAdd}><Plus size={16} />安排面试</button>} /><div className="career-segmented" aria-label="面试记录范围"><button className={tab === "upcoming" ? "active" : ""} aria-pressed={tab === "upcoming"} onClick={() => setTab("upcoming")}>即将进行</button><button className={tab === "archive" ? "active" : ""} aria-pressed={tab === "archive"} onClick={() => setTab("archive")}>面经档案</button></div><div className="career-interview-grid">{shown.map((item) => { const job = data.jobs.find((entry) => entry.id === item.job_id); const questions = parseQuestions(item.questions_json); const title = `${job?.company ?? "待确认公司"} · ${item.round_name}`; return <article className="career-interview-card" key={item.id}><header><CompanyMark company={job?.company ?? "职"} /><div><span>{item.status === "completed" ? "已完成" : item.status === "canceled" ? "已取消" : relativeDate(item.scheduled_at, now)}</span><h3>{title}</h3><p>{job?.role}</p></div><button className="career-icon-button" onClick={() => onSelect(item.id)} aria-label={`打开 ${title} 面经`}><ArrowUpRight size={17} /></button></header><div className="career-interview-meta"><span><CalendarDays size={14} />{formatDate(item.scheduled_at, true)}</span><span><Clock3 size={14} />{item.duration} 分钟</span><span><UserRound size={14} />{item.interviewer || "面试官待确认"}</span></div>{item.status === "scheduled" ? <div className="career-interview-actions"><button className="career-button secondary" onClick={() => onAi("interview_prep", "生成面试准备包", { job, interview: item })}><Sparkles size={15} />AI 准备包</button>{safeLink(item.meeting_url) && <a className="career-button ghost" href={item.meeting_url} target="_blank" rel="noreferrer">加入会议 <ExternalLink size={14} /></a>}</div> : <div className="career-experience-preview"><p>{item.status === "canceled" ? item.summary || "这轮面试已取消。" : item.summary || "可随时补充这轮面试的记录。"}</p>{item.status === "completed" && (questions.length > 0 || item.reflection) && <footer>{questions.length > 0 && <span>{questions.length} 个问题</span>}{item.reflection && <span>已记录复盘</span>}</footer>}</div>}</article>; })}</div>{shown.length === 0 && <EmptyState icon={<MessageSquareText />} title={tab === "archive" ? "还没有面经" : "暂未安排面试"} text="记录每一轮问题、回答和复盘，让经验真正沉淀下来。" action={<button className="career-button primary" onClick={onAdd}>安排第一轮</button>} />}</div>;
}

function ContactsView({ data, now, revision, onAdd, onSelect }: { data: CareerData; now: number; revision: number; onAdd: () => void; onSelect: (contactId: string) => void }) {
  const [scope, setScope] = useState<"active" | "archived">("active");
  const [archived, setArchived] = useState<Contact[]>([]);
  const [details, setDetails] = useState<Record<string, CareerContactDetail>>({});
  const [loading, setLoading] = useState(true);
  const contacts = scope === "active" ? data.contacts : archived;

  useEffect(() => {
    let live = true;
    void (async () => {
      const list = scope === "active" ? data.contacts : await loadCareerContacts("archived");
      const loaded = await Promise.all(list.map((contact) => loadCareerContactDetail(contact.id)));
      if (!live) return;
      if (scope === "archived") setArchived(list);
      setDetails(Object.fromEntries(loaded.filter((item): item is CareerContactDetail => Boolean(item)).map((item) => [item.contact.id, item])));
      setLoading(false);
    })().catch(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [data.contacts, revision, scope]);

  return <div className="career-view"><SectionHeading eyebrow="RELATIONSHIPS" title="联系人" description="只记录真实发生的沟通，以及你愿意安排的下一步" action={<button className="career-button primary" onClick={onAdd}><Plus size={16} />添加联系人</button>} /><div className="career-segmented" aria-label="联系人范围"><button className={scope === "active" ? "active" : ""} aria-pressed={scope === "active"} onClick={() => { if (scope !== "active") { setLoading(true); setScope("active"); } }}>联系人</button><button className={scope === "archived" ? "active" : ""} aria-pressed={scope === "archived"} onClick={() => { if (scope !== "archived") { setLoading(true); setScope("archived"); } }}>已归档</button></div>{loading && contacts.length === 0 ? <div className="career-contact-loading"><LoaderCircle className="spin" size={18} />正在打开联系人…</div> : <div className="career-contact-grid">{contacts.map((contact) => {
    const detail = details[contact.id];
    const latest = detail?.interactions[0];
    const next = detail?.tasks.filter((task) => task.status === "todo").sort((left, right) => (left.due_at ?? "9999").localeCompare(right.due_at ?? "9999"))[0];
    const overdue = next?.due_at && new Date(next.due_at).getTime() < now;
    const jobs = detail?.jobs.slice(0, 2) ?? [];
    const identity = [contact.role, contact.company].filter(Boolean).join(" · ");
    return <article className="career-contact-card" key={contact.id}><button className="career-contact-open" onClick={() => onSelect(contact.id)} aria-label={`打开联系人 ${contact.name}`}><header><span className="career-contact-avatar">{initials(contact.name)}</span><div><h3>{contact.name}</h3>{identity && <p>{identity}</p>}</div><ChevronRight size={18} /></header>{jobs.length > 0 && <div className="career-contact-jobs">{jobs.map((job) => <span key={job.id}>{job.company} · {job.role}</span>)}</div>}<div className="career-contact-truth"><span><ContactRound size={14} />{latest ? `${formatDate(latest.occurred_at)} · ${latest.channel || "已记录沟通"}` : "等一次真实沟通"}</span><span><CalendarDays size={14} />{next ? overdue ? `原计划 ${formatDate(next.due_at)}，可重新安排` : `${relativeDate(next.due_at, now)} · ${next.title}` : "没有安排下一步"}</span></div></button></article>;
  })}</div>}{!loading && contacts.length === 0 && <EmptyState icon={<UsersRound />} title={scope === "archived" ? "归档里很安静" : "还没有联系人"} text={scope === "archived" ? "移入归档的联系人会保留全部历史，也可以随时恢复。" : "不需要为了数量而添加。下一次真实认识某个人时，再把关系记下来。"} action={scope === "active" ? <button className="career-button primary" onClick={onAdd}>添加第一位联系人</button> : undefined} />}</div>;
}

function MaterialsView({ data, onAdd, onRemove }: { data: CareerData; onAdd: () => void; onRemove: (material: Material) => void | Promise<void> }) {
  async function openFile(fileKey: string) {
    const object = await createLocalFileObjectUrl("career", fileKey);
    const anchor = document.createElement("a");
    anchor.href = object.url;
    anchor.download = object.metadata.originalName;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.click();
    window.setTimeout(() => object.revoke(), 30_000);
  }
  return <div className="career-view"><SectionHeading eyebrow="MATERIALS" title="求职材料" description="保留每一个版本，也记住哪一份发给了谁" action={<button className="career-button primary" onClick={onAdd}><Plus size={16} />添加材料</button>} /><div className="career-material-grid">{data.materials.map((material) => { const job = data.jobs.find((item) => item.id === material.linked_job_id); return <article className="career-material-card" key={material.id}><span className={`career-file-icon ${material.kind}`}><FileText size={23} /></span><div><header><span>{material.kind}</span><em className={material.status}>{material.status === "sent" ? "已发送" : material.status === "draft" ? "编辑中" : "可使用"}</em>{material.file_key && <em className="attached">本地附件</em>}</header><h3>{material.name}</h3><p>{material.notes}</p><footer><span>{material.version} · 更新于 {formatDate(material.updated_at)}</span>{job && <small>用于 {job.company}</small>}{material.file_name && <small>{material.file_name} · {Math.max(1, Math.round((material.byte_size ?? 0) / 1024))} KB</small>}</footer></div><div className="career-material-actions">{material.file_key ? <button className="career-icon-button" onClick={() => void openFile(material.file_key!)} aria-label={`打开 ${material.file_name ?? material.name}`}><Download size={17} /></button> : <button className="career-button ghost" onClick={onAdd}>新建带附件版本</button>}<button className="career-icon-button danger" onClick={() => void onRemove(material)} aria-label={`移除 ${material.name}`}><Trash2 size={16} /></button></div></article>; })}</div></div>;
}

function AnalyticsView({ data }: { data: CareerData }) {
  const terminalStages = new Set(["stage_accepted", "stage_rejected", "stage_withdrawn"]);
  const activeJobs = data.jobs.filter((job) => !terminalStages.has(job.stage_id));
  const waiting = activeJobs.filter((job) => job.stage_id === "stage_applied");
  const withNextStep = activeJobs.filter((job) => data.tasks.some((task) => task.job_id === job.id && task.status === "todo") || data.interviews.some((item) => item.job_id === job.id && item.status === "scheduled"));
  const reflections = data.interviews.filter((item) => item.status === "completed" && (item.summary.trim() || item.reflection.trim() || parseQuestions(item.questions_json).length > 0));
  const missingNextStep = activeJobs.filter((job) => !data.tasks.some((task) => task.job_id === job.id && task.status === "todo") && !data.interviews.some((item) => item.job_id === job.id && item.status === "scheduled"));
  const counts = data.stages.filter((stage) => !stage.hidden && !terminalStages.has(stage.id)).map((stage) => ({ stage, count: activeJobs.filter((job) => job.stage_id === stage.id).length }));
  const max = Math.max(1, ...counts.map((item) => item.count));
  const sources = [...new Set(data.jobs.map((job) => job.source))].map((source) => ({ source, total: data.jobs.filter((job) => job.source === source).length, active: activeJobs.filter((job) => job.source === source).length })).sort((a, b) => b.total - a.total);
  return <div className="career-view"><SectionHeading eyebrow="REFLECTION" title="过程回顾" description="整理正在发生的事，不让数字评价你" action={<span className="career-no-score-note"><ShieldCheck size={15} />不做结果评分</span>} /><section className="career-metric-grid analytics"><Metric label="正在推进" value={String(activeJobs.length)} note="当前仍需照顾的机会" icon={<BriefcaseBusiness size={18} />} /><Metric label="等待回应" value={String(waiting.length)} note="无需反复刷新" icon={<Clock3 size={18} />} tone="plum" /><Metric label="已有下一步" value={String(withNextStep.length)} note="待办或面试已就位" icon={<CalendarDays size={18} />} tone="green" /><Metric label="已写面经" value={String(reflections.length)} note="经验已经留在这里" icon={<MessageSquareText size={18} />} tone="amber" /></section><div className="career-analytics-grid"><section className="career-panel career-funnel"><header><div><h3>当前工作台</h3><p>只显示仍可行动的阶段</p></div><span>{activeJobs.length} 个机会</span></header><div className="career-bars">{counts.filter((item) => item.count > 0).map((item) => <div key={item.stage.id}><span>{item.stage.name}</span><i><b style={{ width: `${Math.max(7, item.count / max * 100)}%`, background: item.stage.color }} /></i><em>{item.count}</em></div>)}</div></section><section className="career-panel career-source-performance"><header><div><h3>来源记录</h3><p>只看分布，不评价渠道</p></div></header>{sources.map((item) => <div key={item.source}><SourceBadge source={item.source} /><span><b>{item.total}</b> 个记录</span><em>{item.active} 个进行中</em></div>)}</section></div><section className="career-insight-card"><span><Sparkles size={18} /></span><div><b>给未来的自己一个清楚入口</b><p>{missingNextStep.length > 0 ? `有 ${missingNextStep.length} 个正在推进的机会还没有下一步。如果今天有余力，可以挑一个安排提醒；暂时不处理也没关系。` : "正在推进的机会都已有下一步。今天可以安心按计划进行。"}</p></div></section></div>;
}

function SettingsView({ data, legacyReviewNeeded, onRefresh, onExport, onImport, notify }: { data: CareerData; legacyReviewNeeded: boolean; onRefresh: () => Promise<void>; onExport: () => Promise<void>; onImport: (file: File) => Promise<void>; notify: (text: string, tone?: Notice["tone"]) => void }) {
  const [savingStage, setSavingStage] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState<"export" | "import" | null>(null);
  const [aiHealth, setAiHealth] = useState<{ status: "checking" | "configured" | "missing" | "error"; model: string }>({ status: "checking", model: "" });
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
        const body = await response.json() as { ai?: { configured?: boolean; model?: string } };
        if (!response.ok) throw new Error("health check failed");
        if (active) setAiHealth({ status: body.ai?.configured ? "configured" : "missing", model: body.ai?.model ?? "DeepSeek" });
      } catch { if (active) setAiHealth({ status: "error", model: "" }); }
    })();
    return () => { active = false; };
  }, []);
  async function rename(stage: Stage, name: string) { if (!name.trim() || name === stage.name) return; setSavingStage(stage.id); await runCareerSql("UPDATE career_stages SET name = ? WHERE id = ?", [name.trim(), stage.id]); await onRefresh(); setSavingStage(null); }
  const bookmarklet = `javascript:(()=>{const t=window.getSelection()?.toString()||document.body.innerText.slice(0,12000);const u='http://localhost:3000/career?capture='+encodeURIComponent(location.href)+'&text='+encodeURIComponent(t);window.open(u,'_blank')})()`;
  const aiStatusLabel = aiHealth.status === "checking" ? "正在检查" : aiHealth.status === "configured" ? "已配置" : aiHealth.status === "missing" ? "尚未配置" : "检查失败";
  async function copyHelper() { try { await navigator.clipboard.writeText(bookmarklet); notify("浏览器采集器已复制，可拖到书签栏保存", "info"); } catch { notify("浏览器不允许复制，请在安全页面重试", "error"); } }
  async function exportBackup() { setBackupBusy("export"); try { await onExport(); } finally { setBackupBusy(null); } }
  async function importBackup(file: File) { setBackupBusy("import"); try { await onImport(file); } finally { setBackupBusy(null); } }
  return <div className="career-view"><SectionHeading eyebrow="PREFERENCES" title="设置" description="隐私、流程与数据，都由你掌控" />{legacyReviewNeeded && <div className="career-legacy-review-note" role="status"><ShieldCheck size={19} /><div><b>旧版资料需要你看一眼</b><p>旧版可能含示例内容，未自动删除以保护你的编辑。我们不会替你判断哪些记录属于你，也不会自行清理。</p></div></div>}<div className="career-settings-layout"><nav><a href="#workflow">求职流程</a><a href="#privacy">AI 与隐私</a><a href="#data">数据与备份</a><a href="#capture">浏览器采集器</a></nav><div><section className="career-settings-card" id="workflow"><header><div><h3>看板阶段</h3><p>调整名称，保留一致的数据分析口径。</p></div></header><div className="career-stage-settings">{data.stages.map((stage) => <label key={stage.id}><i style={{ background: stage.color }} /><input defaultValue={stage.name} onBlur={(event) => void rename(stage, event.target.value)} aria-label={`${stage.name}阶段名称`} /><span>{savingStage === stage.id ? <LoaderCircle className="spin" size={14} /> : stage.is_terminal ? "终态" : "进行中"}</span></label>)}</div></section>
    <section className="career-settings-card" id="privacy"><header><div><h3>AI 与隐私</h3><p>只有你主动使用 AI 时，所选内容才会发送至配置的服务。</p></div><span className={aiHealth.status === "configured" ? "career-status-good" : "career-status-neutral"} aria-live="polite"><i />{aiStatusLabel}</span></header><div className="career-setting-row"><span><b>当前模型</b><small>由服务器环境安全配置</small></span><code>{aiHealth.model || "DeepSeek"}</code></div><div className="career-setting-row"><span><b>结果保留方式</b><small>关闭预览不会自动保存，也不会留下隐藏副本</small></span><code>核对后复制或填入草稿</code></div><div className="career-privacy-note"><ShieldCheck size={18} /><p>API 密钥不会进入浏览器、本地数据库或备份。职位描述和面试笔记会被当作不可信数据处理。</p></div></section>
    <section className="career-settings-card" id="data"><header><div><h3>数据与备份</h3><p>一个文件带走结构化职迹与已关联的材料原件。</p></div></header><div className="career-data-actions"><button disabled={backupBusy !== null} onClick={() => void exportBackup()}><span>{backupBusy === "export" ? <LoaderCircle className="spin" size={19} /> : <Download size={19} />}</span><div><b>{backupBusy === "export" ? "正在校验并打包…" : "导出完整备份"}</b><small>SQLite、简历、作品集与案例附件</small></div><ChevronRight size={17} /></button><label className={backupBusy !== null ? "disabled" : ""}><span>{backupBusy === "import" ? <LoaderCircle className="spin" size={19} /> : <Upload size={19} />}</span><div><b>{backupBusy === "import" ? "正在验证并恢复…" : "恢复备份"}</b><small>支持完整备份与旧版 SQLite</small></div><ChevronRight size={17} /><input aria-label="选择要恢复的职迹备份" disabled={backupBusy !== null} type="file" accept=".career-backup,.sqlite,.sqlite3,.db,application/x-sqlite3,application/octet-stream" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importBackup(file); event.currentTarget.value = ""; }} /></label></div><p className="career-settings-footnote">完整备份是明文文件，请安全保管；导出前会校验每个附件。恢复会先建立并验证安全候选，上一版本会暂时保留作回退。旧版 SQLite 不包含附件原件。</p></section>
    <section className="career-settings-card" id="capture"><header><div><h3>浏览器采集器</h3><p>把选中的 JD 文本带回本机职迹，不读取登录态，也不自动抓取。</p></div></header><div className="career-capture-steps"><span><b>1</b>复制下面的采集器</span><ArrowRight size={16} /><span><b>2</b>新建书签并粘贴到网址</span><ArrowRight size={16} /><span><b>3</b>选中 JD 后点击书签</span></div><button className="career-button secondary" onClick={() => void copyHelper()}><Command size={16} />复制采集器</button><p className="career-settings-footnote">采集器仅打开 localhost 职迹并附带当前页面 URL 与选中文字；不是 LinkedIn 或 BOSS直聘官方 API，也不会绕过登录或反爬限制。</p></section>
  </div></div></div>;
}

function Drawer({ label, children, onClose, wide = false }: { label: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialogRef = useDialogA11y(onClose);
  return <div className="career-layer"><button className="career-modal-scrim" onClick={onClose} aria-label={`关闭${label}`} /><aside ref={dialogRef} tabIndex={-1} className={`career-drawer ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={label}>{children}</aside></div>;
}
function Modal({ title, description, children, onClose, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialogRef = useDialogA11y(onClose);
  const titleId = useId();
  const descriptionId = useId();
  return <div className="career-layer"><button className="career-modal-scrim" onClick={onClose} aria-label={`关闭${title}`} /><section ref={dialogRef} tabIndex={-1} className={`career-modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}><header><div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div><button className="career-icon-button" onClick={onClose} aria-label={`关闭${title}`}><X size={19} /></button></header>{children}</section></div>;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="career-field"><span>{label}{hint && <small>{hint}</small>}</span>{children}</label>; }
function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) { return <div className="career-empty"><span>{icon}</span><h3>{title}</h3><p>{text}</p>{action}</div>; }

function JobDrawer({ job, data, now, onClose, onMove, onArchive, onRefresh, onAi, onSelectContact, notify }: { job: Job; data: CareerData; now: number; onClose: () => void; onMove: (id: string, stage: string) => Promise<void>; onArchive: (job: Job) => Promise<void>; onRefresh: () => Promise<void>; onAi: (action: AiAction, title: string, payload: unknown) => void; onSelectContact: (contactId: string) => void; notify: (text: string, tone?: Notice["tone"]) => void }) {
  const [tab, setTab] = useState<"overview" | "tasks" | "interviews" | "materials">("overview");
  const [editing, setEditing] = useState(false);
  const [linkedContacts, setLinkedContacts] = useState<Contact[]>([]);
  const tasks = data.tasks.filter((task) => task.job_id === job.id);
  const interviews = data.interviews.filter((item) => item.job_id === job.id);
  const materials = data.materials.filter((item) => item.linked_job_id === job.id);
  useEffect(() => {
    let live = true;
    void (async () => {
      const contacts = await loadCareerContacts("all");
      const details = await Promise.all(contacts.map((contact) => loadCareerContactDetail(contact.id)));
      const available = details.filter((detail): detail is CareerContactDetail => detail !== null);
      if (live) setLinkedContacts(available.filter((detail) => detail.associations.some((association) => association.job_id === job.id)).map((detail) => detail.contact));
    })().catch(() => { if (live) setLinkedContacts([]); });
    return () => { live = false; };
  }, [job.id]);
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await runCareerSql("UPDATE career_jobs SET company=?,role=?,location=?,salary=?,work_mode=?,description=?,note=?,tags=?,deadline=?,updated_at=? WHERE id=?", [form.get("company"), form.get("role"), form.get("location"), form.get("salary"), form.get("work_mode"), form.get("description"), form.get("note"), form.get("tags"), fromDateInput(String(form.get("deadline") || "")), new Date().toISOString(), job.id]); await onRefresh(); setEditing(false); notify("职位信息已保存"); }
  return <Drawer label={`${job.company} · ${job.role}`} onClose={onClose} wide><div className="career-job-drawer-head"><CompanyMark company={job.company} /><div><SourceBadge source={job.source} /><h2>{job.role}</h2><p>{job.company} · {job.location || "地点待确认"}</p></div><button className="career-icon-button" onClick={onClose} aria-label="关闭职位详情"><X size={19} /></button></div><div className="career-job-status-row"><select value={job.stage_id} onChange={(event) => void onMove(job.id, event.target.value)} aria-label="职位阶段">{data.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select><span><Target size={14} />优先级 {job.priority}</span>{safeLink(job.source_url) && <a href={job.source_url} target="_blank" rel="noreferrer">查看原职位 <ExternalLink size={14} /></a>}</div><div className="career-drawer-tabs">{[["overview", "职位概览"], ["tasks", `待办 ${tasks.length}`], ["interviews", `面试 ${interviews.length}`], ["materials", `材料 ${materials.length}`]].map(([id, label]) => <button className={tab === id ? "active" : ""} aria-pressed={tab === id} key={id} onClick={() => setTab(id as typeof tab)}>{label}</button>)}</div><div className="career-drawer-body">{tab === "overview" && (editing ? <form className="career-form" onSubmit={save}><Field label="公司"><input name="company" defaultValue={job.company} required /></Field><Field label="职位"><input name="role" defaultValue={job.role} required /></Field><div className="career-form-row"><Field label="地点"><input name="location" defaultValue={job.location} /></Field><Field label="工作方式"><input name="work_mode" defaultValue={job.work_mode} /></Field></div><div className="career-form-row"><Field label="薪资"><input name="salary" defaultValue={job.salary} /></Field><Field label="截止时间"><input name="deadline" type="datetime-local" defaultValue={dateInputValue(job.deadline)} /></Field></div><Field label="标签"><input name="tags" defaultValue={job.tags} /></Field><Field label="职位描述"><textarea name="description" rows={7} defaultValue={job.description} /></Field><Field label="个人备注"><textarea name="note" rows={4} defaultValue={job.note} /></Field><div className="career-form-actions"><button type="button" className="career-button ghost" onClick={() => setEditing(false)}>取消</button><button className="career-button primary">保存修改</button></div></form> : <><div className="career-detail-actions"><button className="career-button secondary" onClick={() => onAi("fit_analysis", "AI 职位要求拆解", { job })}><Sparkles size={15} />拆解职位要求</button><button className="career-button ghost" onClick={() => setEditing(true)}><Pencil size={15} />编辑</button></div><dl className="career-detail-grid"><div><dt>薪资范围</dt><dd>{job.salary || "未记录"}</dd></div><div><dt>工作方式</dt><dd>{job.work_mode || "未记录"}</dd></div><div><dt>申请来源</dt><dd>{job.source}</dd></div><div><dt>投递时间</dt><dd>{job.applied_at ? formatDate(job.applied_at) : "尚未投递"}</dd></div><div><dt>旧版联系人备注</dt><dd>{job.contact_name || "没有旧版备注"}</dd></div><div><dt>截止时间</dt><dd>{job.deadline ? formatDate(job.deadline, true) : "未记录"}</dd></div></dl><section className="career-detail-section"><h3>已关联联系人</h3>{linkedContacts.length > 0 ? <div className="career-job-contact-links">{linkedContacts.map((contact) => <button key={contact.id} onClick={() => onSelectContact(contact.id)}><span className="career-contact-avatar">{initials(contact.name)}</span><span><b>{contact.name}</b><small>{[contact.role, contact.company, contact.archived === 1 ? "已归档" : ""].filter(Boolean).join(" · ")}</small></span><ChevronRight size={16} /></button>)}</div> : <p className="career-contact-calm-copy">{job.contact_name ? `旧版备注写着“${job.contact_name}”，尚未确认成联系人关系。请从联系人页面明确关联。` : "还没有明确关联的联系人。可在联系人详情中管理职位关系。"}</p>}</section><section className="career-detail-section"><h3>职位描述</h3><p className="career-long-copy">{job.description || "还没有保存职位描述。"}</p></section><section className="career-detail-section"><h3>我的备注</h3><p className="career-long-copy">{job.note || "还没有添加备注。"}</p></section><div className="career-card-tags">{job.tags.split(",").filter(Boolean).map((tag) => <i key={tag}>{tag}</i>)}</div></>)}
    {tab === "tasks" && <div className="career-drawer-list">{tasks.map((task) => <article key={task.id}><span className={`career-check ${task.status}`}><Check size={13} /></span><div><b>{task.title}</b><small>{relativeDate(task.due_at, now)} · {task.kind}</small></div></article>)}{tasks.length === 0 && <EmptyState icon={<ListTodo />} title="还没有待办" text="为这个职位安排一个具体的下一步。" />}</div>}{tab === "interviews" && <div className="career-drawer-list">{interviews.map((item) => <article key={item.id}><span className="career-list-icon"><MessageSquareText size={16} /></span><div><b>{item.round_name}</b><small>{formatDate(item.scheduled_at, true)} · {item.interviewer || "面试官待确认"}</small><p>{item.summary}</p></div></article>)}{interviews.length === 0 && <EmptyState icon={<MessageSquareText />} title="还没有面试轮次" text="推进到面试后，在这里完整记录每一轮。" />}</div>}{tab === "materials" && <div className="career-drawer-list">{materials.map((item) => <article key={item.id}><span className="career-list-icon"><FileText size={16} /></span><div><b>{item.name}</b><small>{item.kind} · {item.version}</small><p>{item.notes}</p></div></article>)}{materials.length === 0 && <EmptyState icon={<FileText />} title="还没有关联材料" text="关联确切版本，之后随时知道发出的是哪一份。" />}</div>}</div><footer className="career-drawer-footer"><button className="career-button danger" onClick={() => void onArchive(job)}><Archive size={15} />归档职位</button></footer></Drawer>;
}

type InterviewEditorSnapshot = {
  status: string;
  summary: string;
  rawNotes: string;
  questions: InterviewQuestion[];
  reflection: string;
};

type InterviewLocalDraft = {
  version: 1;
  interviewId: string;
  sourceUpdatedAt: string;
  savedAt: string;
  snapshot: InterviewEditorSnapshot;
};

function interviewSnapshot(interview: Interview): InterviewEditorSnapshot {
  return {
    status: interview.status,
    summary: interview.summary,
    rawNotes: interview.raw_notes,
    questions: parseQuestions(interview.questions_json).map((question) => ({ ...question })),
    reflection: interview.reflection,
  };
}

function interviewDraftKey(interviewId: string) {
  return `career.interview-draft.v1:${encodeURIComponent(interviewId)}`;
}

function readInterviewLocalDraft(interview: Interview): InterviewLocalDraft | null {
  if (typeof window === "undefined") return null;
  const key = interviewDraftKey(interview.id);
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<InterviewLocalDraft> | null;
    const snapshot = parsed?.snapshot;
    const questionsAreValid = Array.isArray(snapshot?.questions) && snapshot.questions.every((question) =>
      question && typeof question.question === "string" && typeof question.answer === "string" && typeof question.note === "string");
    if (parsed?.version !== 1 || parsed.interviewId !== interview.id || typeof parsed.savedAt !== "string" ||
      typeof parsed.sourceUpdatedAt !== "string" || !snapshot || typeof snapshot.status !== "string" ||
      typeof snapshot.summary !== "string" || typeof snapshot.rawNotes !== "string" ||
      typeof snapshot.reflection !== "string" || !questionsAreValid) return null;
    return parsed as InterviewLocalDraft;
  } catch {
    return null;
  }
}

function sameInterviewSnapshot(left: InterviewEditorSnapshot, right: InterviewEditorSnapshot) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function resolveInterviewDraftRestoreMode(draftSourceUpdatedAt: string, currentUpdatedAt: string) {
  return draftSourceUpdatedAt === currentUpdatedAt ? "auto" as const : "confirm" as const;
}

function InterviewDrawer({ interview, data, onClose, onRefresh, onAi, notify }: {
  interview: Interview;
  data: CareerData;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onAi: (
    action: AiAction,
    title: string,
    payload: unknown,
    apply?: { label: string; onApply: (result: unknown) => void | Promise<void> },
  ) => void;
  notify: (text: string, tone?: Notice["tone"]) => void;
}) {
  const job = data.jobs.find((item) => item.id === interview.job_id);
  const initialSnapshot = interviewSnapshot(interview);
  const [status, setStatus] = useState(interview.status);
  const [summary, setSummary] = useState(interview.summary);
  const [rawNotes, setRawNotes] = useState(interview.raw_notes);
  const [questions, setQuestions] = useState<InterviewQuestion[]>(parseQuestions(interview.questions_json));
  const [reflection, setReflection] = useState(interview.reflection);
  const [baseline, setBaseline] = useState<InterviewEditorSnapshot>(initialSnapshot);
  const [draftRestored, setDraftRestored] = useState<{ savedAt: string; basedOnOlderVersion: boolean } | null>(null);
  const [pendingStaleDraft, setPendingStaleDraft] = useState<InterviewLocalDraft | null>(null);
  const [closePrompt, setClosePrompt] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const restoredRef = useRef(false);
  const [structureUndo, setStructureUndo] = useState<{
    summary: string;
    questions: InterviewQuestion[];
    reflection: string;
  } | null>(null);
  const currentSnapshot = useMemo<InterviewEditorSnapshot>(() => ({
    status,
    summary,
    rawNotes,
    questions: questions.map((question) => ({ ...question })),
    reflection,
  }), [questions, rawNotes, reflection, status, summary]);
  const dirty = !sameInterviewSnapshot(currentSnapshot, baseline);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const draft = readInterviewLocalDraft(interview);
    if (!draft) return;
    const restoreFrame = window.requestAnimationFrame(() => {
      if (resolveInterviewDraftRestoreMode(draft.sourceUpdatedAt, interview.updated_at) === "confirm") {
        setPendingStaleDraft(draft);
        return;
      }
      setStatus(draft.snapshot.status);
      setSummary(draft.snapshot.summary);
      setRawNotes(draft.snapshot.rawNotes);
      setQuestions(draft.snapshot.questions.map((question) => ({ ...question })));
      setReflection(draft.snapshot.reflection);
      setDraftRestored({ savedAt: draft.savedAt, basedOnOlderVersion: false });
    });
    return () => window.cancelAnimationFrame(restoreFrame);
  }, [interview]);

  useEffect(() => {
    if (!dirty) return;
    const protectUnsavedDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectUnsavedDraft);
    return () => window.removeEventListener("beforeunload", protectUnsavedDraft);
  }, [dirty]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await runCareerSql(
        "UPDATE career_interviews SET status=?,summary=?,raw_notes=?,questions_json=?,reflection=?,updated_at=? WHERE id=?",
        [status, summary, rawNotes, JSON.stringify(questions), reflection, new Date().toISOString(), interview.id],
      );
      try { window.localStorage.removeItem(interviewDraftKey(interview.id)); }
      catch { notify("面经已保存，但浏览器没能清理先前的本机草稿", "info"); }
      setBaseline(currentSnapshot);
      setDraftRestored(null);
      setPendingStaleDraft(null);
      setStructureUndo(null);
      try {
        await onRefresh();
        notify("面经已保存");
      } catch {
        notify("面经已保存在本地；列表暂时没有刷新", "info");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "面经保存失败", "error");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function requestClose() {
    if (savingRef.current) {
      notify("正在保存面经，请稍候", "info");
      return;
    }
    if (!dirty) { onClose(); return; }
    setClosePrompt(true);
  }

  function saveLocalDraftAndClose() {
    const localDraft: InterviewLocalDraft = {
      version: 1,
      interviewId: interview.id,
      sourceUpdatedAt: interview.updated_at,
      savedAt: new Date().toISOString(),
      snapshot: currentSnapshot,
    };
    try {
      window.localStorage.setItem(interviewDraftKey(interview.id), JSON.stringify(localDraft));
      notify("面经草稿仅保存在这台设备的此浏览器中", "info");
      onClose();
    } catch {
      notify("浏览器没能保存本机草稿，当前编辑仍为你保留", "error");
      setClosePrompt(false);
    }
  }

  function discardAndClose() {
    try {
      window.localStorage.removeItem(interviewDraftKey(interview.id));
      setClosePrompt(false);
      onClose();
    } catch {
      notify("浏览器没能清理本机草稿，暂未关闭", "error");
      setClosePrompt(false);
    }
  }

  function loadPendingLocalDraft() {
    if (!pendingStaleDraft) return;
    setStatus(pendingStaleDraft.snapshot.status);
    setSummary(pendingStaleDraft.snapshot.summary);
    setRawNotes(pendingStaleDraft.snapshot.rawNotes);
    setQuestions(pendingStaleDraft.snapshot.questions.map((question) => ({ ...question })));
    setReflection(pendingStaleDraft.snapshot.reflection);
    setDraftRestored({ savedAt: pendingStaleDraft.savedAt, basedOnOlderVersion: true });
    setPendingStaleDraft(null);
  }

  function clearPendingLocalDraft() {
    try {
      window.localStorage.removeItem(interviewDraftKey(interview.id));
      setPendingStaleDraft(null);
      notify("旧本机草稿已清理；SQLite 中的面经没有改动", "info");
    } catch {
      notify("浏览器没能清理这份旧本机草稿", "error");
    }
  }

  function applyStructuredInterview(result: unknown) {
    const draft = createStructuredInterviewDraft(result, { rawNotes, questions });
    setStructureUndo({
      summary,
      questions: questions.map((question) => ({ ...question })),
      reflection,
    });
    if (draft.summary !== null) setSummary(draft.summary);
    if (draft.questions !== null) setQuestions(draft.questions);
    if (draft.reflection !== null) setReflection(draft.reflection);
  }

  function undoStructure() {
    if (!structureUndo) return;
    setSummary(structureUndo.summary);
    setQuestions(structureUndo.questions.map((question) => ({ ...question })));
    setReflection(structureUndo.reflection);
    setStructureUndo(null);
    notify("已撤销 AI 整理，原始速记始终未被改动", "info");
  }

  function markStructuredFieldEdited() {
    if (structureUndo) setStructureUndo(null);
  }

  return <><Drawer label={`${job?.company ?? "职迹"} · ${interview.round_name}面经`} onClose={requestClose} wide>
    <div className="career-job-drawer-head">
      <CompanyMark company={job?.company ?? "职"} />
      <div><span className="career-eyebrow">INTERVIEW EXPERIENCE</span><h2>{job?.company} · {interview.round_name}</h2><p>{formatDate(interview.scheduled_at, true)} · {interview.interviewer || "面试官待确认"}</p></div>
      <button className="career-icon-button" onClick={requestClose} aria-label="关闭面经"><X size={19} /></button>
    </div>
    <form className="career-experience-form" onSubmit={save}>
      {pendingStaleDraft && <div className="career-stale-draft-note" role="status"><FileArchive size={17} /><div><b>发现一份基于较早面经的本机草稿</b><p>SQLite 里已有更新，因此没有自动覆盖。你可以先使用当前已保存内容，或明确载入旧草稿逐项核对。</p><div><button type="button" className="career-button ghost" onClick={() => setPendingStaleDraft(null)}>继续使用当前内容</button><button type="button" className="career-button secondary" onClick={loadPendingLocalDraft}>载入本机草稿核对</button><button type="button" className="career-button ghost danger" onClick={clearPendingLocalDraft}>清除旧草稿</button></div></div></div>}
      {draftRestored && <div className="career-local-draft-note" role="status"><FileArchive size={17} /><span><b>已恢复这台设备上的本机草稿</b><small>{formatDate(draftRestored.savedAt, true)} 保存{draftRestored.basedOnOlderVersion ? " · 原面经之后有过更新，请核对再正式保存" : ""}。它不在 SQLite 或导出备份中。</small></span></div>}
      <div className="career-experience-toolbar">
        <select value={status} onChange={(event) => setStatus(event.target.value as Interview["status"])} aria-label="面试状态"><option value="scheduled">待进行</option><option value="completed">已完成</option><option value="canceled">已取消</option></select>
        <button type="button" className="career-button secondary" onClick={() => onAi(
          "structure_interview",
          "AI 整理面经",
          { job, interview: { ...interview, status, summary, raw_notes: rawNotes, questions, reflection } },
          { label: "填入面经草稿", onApply: applyStructuredInterview },
        )}><Sparkles size={15} />AI 整理速记</button>
      </div>
      <p className="career-ai-context-note"><ShieldCheck size={15} />AI 会读取当前表单里的总结、原始速记、问题和复盘；预览或填入都不会自动保存。</p>
      <Field label="一句话总结"><input value={summary} onChange={(event) => { markStructuredFieldEdited(); setSummary(event.target.value); }} placeholder="这轮主要考察了什么，整体感受如何？" /></Field>
      <Field label="原始速记"><textarea rows={6} value={rawNotes} onChange={(event) => setRawNotes(event.target.value)} placeholder="先把记得的内容都写下来，不必整理…" /></Field>
      {structureUndo && <div className="career-ai-applied-note" role="status"><span><CheckCircle2 size={16} /><span><b>AI 已填入当前表单</b><small>仍可逐项修改，点击“保存面经”前不会写入数据库。</small></span></span><button type="button" onClick={undoStructure}><RotateCcw size={14} />撤销整理</button></div>}
      <div className="career-question-section">
        <header><div><h3>面试问题与回答</h3><p>按实际顺序记录，方便之后复盘。</p></div><button type="button" className="career-button ghost" onClick={() => { markStructuredFieldEdited(); setQuestions((current) => [...current, { question: "", answer: "", note: "" }]); }}><Plus size={15} />添加问题</button></header>
        {questions.map((question, index) => <article key={index}>
          <span>{String(index + 1).padStart(2, "0")}</span>
          <div><input value={question.question} onChange={(event) => { markStructuredFieldEdited(); setQuestions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, question: event.target.value } : item)); }} placeholder="面试官问了什么？" aria-label={`第 ${index + 1} 个面试问题`} /><textarea rows={3} value={question.answer} onChange={(event) => { markStructuredFieldEdited(); setQuestions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, answer: event.target.value } : item)); }} placeholder="我是怎么回答的？" aria-label={`第 ${index + 1} 个问题的回答`} /><input value={question.note} onChange={(event) => { markStructuredFieldEdited(); setQuestions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, note: event.target.value } : item)); }} placeholder="追问、现场反馈或你想保留的线索" aria-label={`第 ${index + 1} 个问题的备注`} /></div>
          <button type="button" onClick={() => { markStructuredFieldEdited(); setQuestions((current) => current.filter((_, itemIndex) => itemIndex !== index)); }} aria-label={`删除第 ${index + 1} 个问题`}><Trash2 size={15} /></button>
        </article>)}
      </div>
      <Field label="复盘与下一步"><textarea rows={5} value={reflection} onChange={(event) => { markStructuredFieldEdited(); setReflection(event.target.value); }} placeholder="这次想记住什么？以后遇到类似问题想怎样表达？" /></Field>
      <div className="career-form-actions sticky"><button type="button" className="career-button ghost" disabled={saving} onClick={requestClose}>关闭</button><button className="career-button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{saving ? "正在保存…" : "保存面经"}</button></div>
    </form>
  </Drawer>{closePrompt && <Modal title="保留这次编辑吗？" description="这些修改还没有写入职迹的 SQLite 数据库。" onClose={() => setClosePrompt(false)}><div className="career-draft-choice"><p>你可以继续编辑、暂存在此浏览器，或明确放弃这次修改。</p><div><button type="button" className="career-button primary" data-dialog-initial onClick={() => setClosePrompt(false)}>继续编辑</button><button type="button" className="career-button secondary" onClick={saveLocalDraftAndClose}><FileArchive size={16} />保存本机草稿并关闭</button><button type="button" className="career-button danger" onClick={discardAndClose}><Trash2 size={16} />放弃修改</button></div><small><ShieldCheck size={14} />本机草稿只在当前设备与此浏览器的站点存储中，不进入 SQLite 或导出备份；清除站点数据会同时清除它。</small></div></Modal>}</>;
}

function ContactDrawer({ contactId, revision, now, onClose, onEdit, onRecord, onTask, onToggleTask, onArchive, onRestore, notify }: {
  contactId: string;
  revision: number;
  now: number;
  onClose: () => void;
  onEdit: () => void;
  onRecord: () => void;
  onTask: (taskId?: string) => void;
  onToggleTask: (task: Task) => Promise<void>;
  onArchive: (contact: Contact) => Promise<void>;
  onRestore: (contact: Contact) => Promise<void>;
  notify: (text: string, tone?: Notice["tone"]) => void;
}) {
  const [detail, setDetail] = useState<CareerContactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void loadCareerContactDetail(contactId).then((next) => { if (live) setDetail(next); }).catch((error) => {
      if (live) notify(error instanceof Error ? error.message : "联系人暂时无法打开", "error");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [contactId, notify, revision]);

  if (loading || !detail) return <Drawer label="联系人详情" onClose={onClose} wide><div className="career-drawer-loading"><LoaderCircle className="spin" size={20} /><p>{loading ? "正在打开联系人…" : "没有找到这位联系人"}</p></div></Drawer>;
  const { contact } = detail;
  const openTasks = detail.tasks.filter((task) => task.status === "todo").sort((left, right) => (left.due_at ?? "9999").localeCompare(right.due_at ?? "9999"));
  const nextTask = openTasks[0];
  const archived = contact.archived === 1;
  const identity = [contact.role, contact.company].filter(Boolean).join(" · ");
  async function changeArchive() {
    if (!detail) return;
    setBusy(true);
    try { if (archived) await onRestore(detail.contact); else await onArchive(detail.contact); }
    catch (error) { notify(error instanceof Error ? error.message : "联系人状态更新失败", "error"); setBusy(false); }
  }
  return <Drawer label={`${contact.name} · 联系人详情`} onClose={onClose} wide><div className="career-contact-drawer-head"><span className="career-contact-avatar large">{initials(contact.name)}</span><div><span>{archived ? "已归档联系人" : "联系人"}</span><h2>{contact.name}</h2>{identity && <p>{identity}</p>}</div><button className="career-icon-button" onClick={onClose} aria-label="关闭联系人详情"><X size={19} /></button></div><div className="career-contact-drawer-actions">{!archived && <button className="career-button primary" onClick={onRecord}><MessageSquareText size={16} />记录联系</button>}<button className="career-button secondary" onClick={onEdit}><Pencil size={15} />编辑</button></div><div className="career-drawer-body career-contact-detail"><section><header><div><span>NEXT STEP</span><h3>下一步</h3></div>{!archived && <button className="career-text-button" onClick={() => onTask(nextTask?.id)}>{nextTask ? "重新安排" : "安排下一步"}<ChevronRight size={14} /></button>}</header>{nextTask ? <article className="career-contact-next-card"><span><CalendarDays size={17} /></span><div><b>{nextTask.title}</b><p>{nextTask.due_at && new Date(nextTask.due_at).getTime() < now ? `原计划 ${formatDate(nextTask.due_at, true)}，可以按现在的节奏重新安排` : `${formatDate(nextTask.due_at, true)} · ${nextTask.kind}`}</p></div><button onClick={() => void onToggleTask(nextTask)} aria-label={`完成「${nextTask.title}」`}><Check size={16} />完成</button></article> : <p className="career-contact-calm-copy">没有安排下一步。需要时再决定，不必为了填满而创建提醒。</p>}{contact.next_follow_up && openTasks.length === 0 && <p className="career-contact-legacy">旧版曾记录 {formatDate(contact.next_follow_up, true)} 的提醒，但没有自动转成待办。</p>}</section><section><header><div><span>CONTEXT</span><h3>关联职位</h3></div><button className="career-text-button" onClick={onEdit}>管理关联 <ChevronRight size={14} /></button></header>{detail.jobs.length > 0 ? <div className="career-contact-related-jobs">{detail.jobs.map((job) => <span key={job.id}><CompanyMark company={job.company} small /><b>{job.role}</b><small>{job.company}</small></span>)}</div> : <p className="career-contact-calm-copy">还没有关联职位。只有你明确选择后，这里才会建立关系。</p>}</section><section><header><div><span>HISTORY</span><h3>联系记录</h3></div>{!archived && <button className="career-text-button" onClick={onRecord}>记录一次 <Plus size={14} /></button>}</header>{detail.interactions.length > 0 ? <div className="career-contact-timeline">{detail.interactions.map((interaction) => <article key={interaction.id}><i /><div><header><b>{interaction.summary}</b><time>{formatDate(interaction.occurred_at, true)}</time></header><p>{interaction.channel || "未注明渠道"} · {interaction.direction === "outbound" ? "我发出" : interaction.direction === "inbound" ? "对方发来" : "双方交流"}{interaction.job_id ? ` · ${detail.jobs.find((job) => job.id === interaction.job_id)?.role ?? "关联职位"}` : ""}</p>{interaction.notes && <small>{interaction.notes}</small>}</div></article>)}</div> : <><p className="career-contact-calm-copy">还没有联系记录。不需要为了填满而补写；下次真实交流后再记。</p>{contact.last_contact_at && <p className="career-contact-legacy">旧版只保存了 {formatDate(contact.last_contact_at, true)} 这个时间，没有沟通内容，因此没有把它冒充成联系记录。</p>}</>}</section><section><header><div><span>CONTACT</span><h3>联系方式</h3></div></header><div className="career-contact-channels">{contact.email && <a href={`mailto:${contact.email}`}><ContactRound size={16} /><span><b>邮箱</b><small>{contact.email}</small></span><ExternalLink size={14} /></a>}{contact.phone && <a href={`tel:${contact.phone.replace(/[^+\d*#,;]/g, "")}`}><Phone size={16} /><span><b>电话</b><small>{contact.phone}</small></span><ExternalLink size={14} /></a>}{!contact.email && !contact.phone && <p className="career-contact-calm-copy">还没有保存邮箱或电话。</p>}</div>{contact.notes && <p className="career-contact-notes">{contact.notes}</p>}</section></div><footer className="career-drawer-footer"><button className={archived ? "career-button secondary" : "career-button ghost"} disabled={busy} onClick={() => void changeArchive()}>{archived ? <RotateCcw size={15} /> : <Archive size={15} />}{busy ? "正在保存…" : archived ? "恢复联系人" : "移入归档"}</button></footer></Drawer>;
}

function JobModal({ data, onClose, onSaved }: { data: CareerData; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setSaving(true); const form = new FormData(event.currentTarget); const id = newId("job"); const now = new Date().toISOString(); try { await runCareerBatch([{ sql: `INSERT INTO career_jobs (id,company,role,location,source,source_url,stage_id,priority,salary,work_mode,description,applied_at,deadline,contact_name,note,tags,created_at,updated_at,archived,position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0)`, params: [id, form.get("company"), form.get("role"), form.get("location"), form.get("source"), form.get("source_url"), form.get("stage_id"), Number(form.get("priority")), form.get("salary"), form.get("work_mode"), form.get("description"), form.get("stage_id") === "stage_applied" ? now : null, fromDateInput(String(form.get("deadline") || "")), "", form.get("note"), form.get("tags"), now, now] }, { sql: "INSERT INTO career_activity (id,job_id,type,detail,created_at) VALUES (?,?,?,?,?)", params: [newId("activity"), id, "create", `记录了 ${form.get("company")} · ${form.get("role")}`, now] }]); await onSaved(id); } finally { setSaving(false); } }
  return <Modal title="记录一个新职位" description="先写下关键信息，细节可以随时补充。" onClose={onClose} wide><form className="career-form" onSubmit={submit}><div className="career-form-row"><Field label="公司"><input name="company" required placeholder="例如：Linear" /></Field><Field label="职位"><input name="role" required placeholder="例如：Product Designer" /></Field></div><div className="career-form-row thirds"><Field label="当前阶段"><select name="stage_id" defaultValue="stage_saved">{data.stages.filter((stage) => !stage.is_terminal).map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></Field><Field label="优先级"><select name="priority" defaultValue="2"><option value="1">普通</option><option value="2">重点</option><option value="3">最高</option></select></Field><Field label="来源"><select name="source" defaultValue="手动记录"><option>手动记录</option><option>LinkedIn</option><option>BOSS直聘</option><option>官网</option><option>内推</option></select></Field></div><div className="career-form-row"><Field label="地点"><input name="location" placeholder="上海 / 远程" /></Field><Field label="工作方式"><select name="work_mode"><option value="">待确认</option><option>现场办公</option><option>混合办公</option><option>远程</option></select></Field></div><div className="career-form-row"><Field label="薪资"><input name="salary" placeholder="¥30k–45k / 月" /></Field><Field label="截止时间"><input name="deadline" type="datetime-local" /></Field></div><Field label="原职位链接"><input name="source_url" type="url" placeholder="https://" /></Field><Field label="标签" hint="用逗号分隔"><input name="tags" placeholder="AI, 产品设计, 远程" /></Field><Field label="职位描述"><textarea name="description" rows={5} placeholder="粘贴岗位职责和要求…" /></Field><Field label="个人备注"><textarea name="note" rows={3} placeholder="为什么感兴趣？下一步要确认什么？" /></Field><div className="career-form-actions"><button type="button" className="career-button ghost" onClick={onClose}>取消</button><button className="career-button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}保存职位</button></div></form></Modal>;
}

function TaskModal({ data, initialJobId, onClose, onSaved }: { data: CareerData; initialJobId: string | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await runCareerSql("INSERT INTO career_tasks (id,job_id,title,due_at,kind,priority,status,created_at) VALUES (?,?,?,?,?,?,?,?)", [newId("task"), form.get("job_id") || null, form.get("title"), fromDateInput(String(form.get("due_at") || "")), form.get("kind"), Number(form.get("priority")), "todo", new Date().toISOString()]);
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "待办暂时没有保存，请再试一次");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  return <Modal title="新建待办" description="让下一步具体到时间与动作。" onClose={saving ? () => undefined : onClose}><form className="career-form" onSubmit={submit}><Field label="要完成什么"><input name="title" required placeholder="例如：发送面试感谢邮件" /></Field><Field label="关联职位"><select name="job_id" defaultValue={initialJobId ?? ""}><option value="">不关联职位</option>{data.jobs.map((job) => <option key={job.id} value={job.id}>{job.company} · {job.role}</option>)}</select></Field><div className="career-form-row"><Field label="截止时间"><input name="due_at" type="datetime-local" /></Field><Field label="类型"><select name="kind"><option>跟进</option><option>面试准备</option><option>材料</option><option>截止事项</option><option>其他</option></select></Field></div><Field label="优先级"><select name="priority" defaultValue="2"><option value="1">普通</option><option value="2">重点</option><option value="3">时间敏感</option></select></Field>{error && <div className="career-inline-error" role="alert"><X size={15} />{error}</div>}<div className="career-form-actions"><button type="button" className="career-button ghost" disabled={saving} onClick={onClose}>取消</button><button className="career-button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <ListTodo size={16} />}{saving ? "正在创建…" : "创建待办"}</button></div></form></Modal>;
}

function InterviewModal({ data, onClose, onSaved }: { data: CareerData; onClose: () => void; onSaved: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const now = new Date().toISOString();
    try {
      await runCareerSql(`INSERT INTO career_interviews (id,job_id,round_name,interview_type,scheduled_at,duration,interviewer,meeting_url,status,summary,raw_notes,questions_json,reflection,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [newId("interview"), form.get("job_id"), form.get("round_name"), form.get("interview_type"), fromDateInput(String(form.get("scheduled_at") || "")), Number(form.get("duration")), form.get("interviewer"), form.get("meeting_url"), "scheduled", "", "", "[]", "", now, now]);
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "面试日程暂时没有保存，请再试一次");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  const availableJobs = data.jobs.filter((job) => job.archived !== 1 && !data.stages.find((stage) => stage.id === job.stage_id)?.is_terminal);
  return <Modal title="安排面试轮次" description="时间、面试官和会议入口都放在一起。" onClose={saving ? () => undefined : onClose}><form className="career-form" onSubmit={submit}><Field label="关联职位"><select required name="job_id" defaultValue=""><option value="" disabled>选择职位</option>{availableJobs.map((job) => <option key={job.id} value={job.id}>{job.company} · {job.role}</option>)}</select></Field><div className="career-form-row"><Field label="轮次名称"><input name="round_name" required placeholder="技术二面" /></Field><Field label="形式"><select name="interview_type"><option>视频面试</option><option>电话沟通</option><option>现场面试</option><option>笔试复盘</option></select></Field></div><div className="career-form-row"><Field label="时间"><input name="scheduled_at" type="datetime-local" required /></Field><Field label="时长"><select name="duration" defaultValue="45"><option value="30">30 分钟</option><option value="45">45 分钟</option><option value="60">60 分钟</option><option value="90">90 分钟</option></select></Field></div><Field label="面试官"><input name="interviewer" placeholder="姓名 · 职位" /></Field><Field label="会议链接"><input name="meeting_url" type="url" placeholder="https://" /></Field>{error && <div className="career-inline-error" role="alert"><X size={15} />{error}</div>}<div className="career-form-actions"><button type="button" className="career-button ghost" disabled={saving} onClick={onClose}>取消</button><button className="career-button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <CalendarDays size={16} />}{saving ? "正在保存…" : "保存日程"}</button></div></form></Modal>;
}

function ContactModal({ contactId, data, onClose, onSaved }: { contactId: string | null; data: CareerData; onClose: () => void; onSaved: (contactId: string) => Promise<void> }) {
  const [detail, setDetail] = useState<CareerContactDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(contactId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!contactId) return;
    let live = true;
    void loadCareerContactDetail(contactId).then((next) => { if (live) setDetail(next); }).catch((caught) => {
      if (live) setError(caught instanceof Error ? caught.message : "联系人资料无法打开");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [contactId]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    const input = {
      name: String(form.get("name") ?? ""),
      company: String(form.get("company") ?? ""),
      role: String(form.get("role") ?? ""),
      channel: String(form.get("channel") ?? ""),
      email: String(form.get("email") ?? ""),
      phone: String(form.get("phone") ?? ""),
      notes: String(form.get("notes") ?? ""),
      jobIds: form.getAll("jobIds").map(String),
    };
    try {
      const id = contactId ?? await createCareerContact(input);
      if (contactId) await updateCareerContact(contactId, input);
      await onSaved(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "联系人保存失败");
    } finally { setSaving(false); }
  }
  const contact = detail?.contact;
  const linked = new Set(detail?.associations.map((association) => association.job_id) ?? []);
  // Nested semantic text labels each checkbox; the configured static-depth rule cannot follow it.
  // eslint-disable-next-line jsx-a11y/label-has-associated-control
  return <Modal title={contactId ? "编辑联系人" : "添加联系人"} description="只保存你确认过的资料与职位关系；联系事实需要单独记录。" onClose={onClose} wide>{loading ? <div className="career-modal-loading"><LoaderCircle className="spin" size={20} />正在打开资料…</div> : <form className="career-form" onSubmit={submit}><div className="career-form-row"><Field label="姓名"><input name="name" required defaultValue={contact?.name ?? ""} /></Field><Field label="公司" hint="可选"><input name="company" defaultValue={contact?.company ?? ""} /></Field></div><div className="career-form-row"><Field label="身份 / 关系" hint="可选"><input name="role" defaultValue={contact?.role ?? ""} placeholder="Recruiter / 内推人" /></Field><Field label="常用渠道" hint="可选"><select name="channel" defaultValue={contact?.channel ?? ""}><option value="">不设置</option><option>LinkedIn</option><option>BOSS直聘</option><option>邮件</option><option>微信</option><option>电话</option><option>其他</option></select></Field></div><div className="career-form-row"><Field label="邮箱" hint="可选"><input name="email" type="email" defaultValue={contact?.email ?? ""} /></Field><Field label="电话" hint="可选"><input name="phone" defaultValue={contact?.phone ?? ""} /></Field></div><fieldset className="career-contact-job-picker"><legend>关联职位 <small>只建立你明确选择的关系</small></legend>{data.jobs.length > 0 ? <div>{data.jobs.map((job) => <label key={job.id}><input type="checkbox" name="jobIds" value={job.id} defaultChecked={linked.has(job.id)} /><span><b>{job.role}</b><small>{job.company}</small></span></label>)}</div> : <p>还没有可关联的职位。</p>}</fieldset><Field label="备注" hint="可选"><textarea name="notes" rows={4} defaultValue={contact?.notes ?? ""} placeholder="怎么认识、希望记住什么；不用重复写沟通记录。" /></Field>{error && <div className="career-inline-error"><X size={15} />{error}</div>}<div className="career-form-actions"><button type="button" className="career-button ghost" onClick={onClose}>取消</button><button className="career-button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{saving ? "正在保存…" : "保存联系人"}</button></div></form>}</Modal>;
}

function ContactInteractionModal({ contactId, data, onClose, onSaved }: { contactId: string; data: CareerData; onClose: () => void; onSaved: () => Promise<void> }) {
  const [detail, setDetail] = useState<CareerContactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [scheduleNext, setScheduleNext] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void loadCareerContactDetail(contactId).then((next) => { if (live) setDetail(next); }).catch((caught) => {
      if (live) setError(caught instanceof Error ? caught.message : "联系人资料无法打开");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [contactId]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    const jobId = String(form.get("job_id") ?? "") || undefined;
    try {
      const followUpDueAt = scheduleNext
        ? fromDateInput(String(form.get("follow_up_due_at") ?? ""))
        : null;
      if (scheduleNext && !followUpDueAt) throw new Error("请为下一步选择时间");
      await recordCareerContactInteraction({
        contactId,
        occurredAt: fromDateInput(String(form.get("occurred_at") ?? "")) ?? undefined,
        interactionType: "conversation",
        direction: String(form.get("direction")) as "outbound" | "inbound" | "mutual",
        channel: String(form.get("channel") ?? ""),
        summary: String(form.get("summary") ?? ""),
        notes: String(form.get("notes") ?? ""),
        jobId,
        associatedJobIds: jobId ? [jobId] : [],
        followUp: scheduleNext ? {
          title: String(form.get("follow_up_title") ?? ""),
          dueAt: followUpDueAt!,
          kind: "跟进",
          priority: 2,
          jobId,
        } : undefined,
      });
      await onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "联系记录保存失败"); }
    finally { setSaving(false); }
  }
  const contact = detail?.contact;
  if (loading) return <Modal title="记录一次真实联系" description="只记录已经发生的沟通。" onClose={onClose} wide><div className="career-modal-loading"><LoaderCircle className="spin" size={20} />正在打开联系人…</div></Modal>;
  // The visible title and explanation are nested so the whole row remains one generous target.
  // eslint-disable-next-line jsx-a11y/label-has-associated-control
  return <Modal title="记录一次真实联系" description={contact ? `记录与 ${contact.name} 已经发生的沟通；不会自动发送消息。` : "只记录已经发生的沟通。"} onClose={onClose} wide><form className="career-form" onSubmit={submit}><div className="career-form-row thirds"><Field label="发生时间"><input name="occurred_at" type="datetime-local" required defaultValue={dateInputValue(new Date().toISOString())} /></Field><Field label="方向"><select name="direction" defaultValue="mutual"><option value="outbound">我发出</option><option value="inbound">对方发来</option><option value="mutual">双方交流</option></select></Field><Field label="渠道"><select name="channel" defaultValue={contact?.channel ?? ""}><option value="">未注明</option><option>LinkedIn</option><option>BOSS直聘</option><option>邮件</option><option>微信</option><option>电话</option><option>当面</option><option>其他</option></select></Field></div><Field label="沟通摘要" hint="必填，写事实而不是评价"><input name="summary" required placeholder="例如：确认了作品集评审时间" /></Field><Field label="关联职位" hint="可选；选择即明确建立关系"><select name="job_id" defaultValue=""><option value="">不关联职位</option>{data.jobs.map((job) => <option key={job.id} value={job.id}>{job.company} · {job.role}</option>)}</select></Field><Field label="补充备注" hint="可选"><textarea name="notes" rows={4} placeholder="关键信息、对方提到的事项…" /></Field><label className="career-contact-follow-toggle"><input type="checkbox" checked={scheduleNext} onChange={(event) => setScheduleNext(event.target.checked)} /><span><b>顺手安排下一步</b><small>只有你选择后才创建待办</small></span></label>{scheduleNext && <div className="career-contact-follow-fields"><Field label="下一步动作"><input name="follow_up_title" required placeholder="例如：发送更新后的案例页" /></Field><Field label="时间"><input name="follow_up_due_at" type="datetime-local" required /></Field></div>}{error && <div className="career-inline-error"><X size={15} />{error}</div>}<div className="career-form-actions"><button type="button" className="career-button ghost" onClick={onClose}>取消</button><button className="career-button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <MessageSquareText size={16} />}{saving ? "正在保存…" : "保存联系记录"}</button></div></form></Modal>;
}

function ContactTaskModal({ contactId, taskId, data, onClose, onSaved }: { contactId: string; taskId?: string; data: CareerData; onClose: () => void; onSaved: () => Promise<void> }) {
  const [detail, setDetail] = useState<CareerContactDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(taskId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void loadCareerContactDetail(contactId).then((next) => { if (live) setDetail(next); }).catch((caught) => {
      if (live) setError(caught instanceof Error ? caught.message : "下一步暂时无法打开");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [contactId]);
  const task = detail?.tasks.find((item) => item.id === taskId);
  if (loading) return <Modal title="重新安排下一步" description="正在读取原来的安排。" onClose={onClose}><div className="career-modal-loading"><LoaderCircle className="spin" size={20} />正在打开下一步…</div></Modal>;
  if (taskId && !task) return <Modal title="下一步没有打开" description="原安排可能已经被完成或移除。" onClose={onClose}><div className="career-form"><div className="career-inline-error"><X size={15} />{error || "没有找到这条安排"}</div><div className="career-form-actions"><button type="button" className="career-button primary" onClick={onClose}>返回联系人</button></div></div></Modal>;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    const jobId = String(form.get("job_id") ?? "") || null;
    const title = String(form.get("title") ?? "");
    const dueAt = fromDateInput(String(form.get("due_at") ?? ""));
    const kind = String(form.get("kind") ?? "跟进");
    const priority = Number(form.get("priority") ?? 2);
    try {
      if (taskId) {
        await withCareerWriteLock(async (context) => runCareerBatch([
          { sql: "UPDATE career_tasks SET title = ?, due_at = ?, kind = ?, priority = ?, job_id = ? WHERE id = ? AND contact_id = ?", params: [title, dueAt, kind, priority, jobId, taskId, contactId] },
          ...(jobId ? [{ sql: "INSERT OR IGNORE INTO career_contact_jobs (contact_id, job_id, created_at) VALUES (?, ?, ?)", params: [contactId, jobId, new Date().toISOString()] }] : []),
        ], context));
      } else {
        await createCareerContactTask({ contactId, title, dueAt, kind, priority, jobId });
      }
      await onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "下一步保存失败"); }
    finally { setSaving(false); }
  }
  return <Modal title={taskId ? "重新安排下一步" : "安排下一步"} description="这是你主动选择的提醒，可以随时调整或完成。" onClose={onClose}><form className="career-form" onSubmit={submit}><Field label="要做什么"><input name="title" required defaultValue={task?.title ?? ""} placeholder="例如：确认下一轮时间" /></Field><Field label="关联职位" hint="可选；不会按公司自动猜"><select name="job_id" defaultValue={task?.job_id ?? ""}><option value="">不关联职位</option>{data.jobs.map((job) => <option key={job.id} value={job.id}>{job.company} · {job.role}</option>)}</select></Field><div className="career-form-row"><Field label="时间"><input name="due_at" type="datetime-local" defaultValue={dateInputValue(task?.due_at)} /></Field><Field label="类型"><select name="kind" defaultValue={task?.kind ?? "跟进"}><option>跟进</option><option>材料</option><option>面试准备</option><option>其他</option></select></Field></div><Field label="优先级"><select name="priority" defaultValue={String(task?.priority ?? 2)}><option value="1">普通</option><option value="2">重点</option><option value="3">时间敏感</option></select></Field>{error && <div className="career-inline-error"><X size={15} />{error}</div>}<div className="career-form-actions"><button type="button" className="career-button ghost" onClick={onClose}>取消</button><button className="career-button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <CalendarDays size={16} />}{saving ? "正在保存…" : taskId ? "保存安排" : "创建待办"}</button></div></form></Modal>;
}

function MaterialModal({ data, onClose, onSaved }: { data: CareerData; onClose: () => void; onSaved: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    const selected = form.get("attachment");
    const file = selected instanceof File && selected.size > 0 ? selected : null;
    try {
      await withCareerWriteLock(async (context) => {
        const metadata = file ? await saveLocalFile("career", file, { originalName: file.name, mimeType: file.type, category: "career-material" }) : null;
        try {
          await runCareerSql("INSERT INTO career_materials (id,name,kind,version,updated_at,linked_job_id,status,notes,file_key,file_name,mime_type,byte_size) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [newId("material"), form.get("name"), form.get("kind"), form.get("version"), new Date().toISOString(), form.get("linked_job_id") || null, form.get("status"), form.get("notes"), metadata?.key ?? null, metadata?.originalName ?? null, metadata?.mimeType ?? null, metadata?.byteSize ?? null], context);
        } catch (caught) {
          if (metadata) await deleteLocalFile("career", metadata.key).catch(() => undefined);
          throw caught;
        }
      });
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "材料保存失败");
    } finally { setSaving(false); }
  }
  return <Modal title="添加求职材料" description="记录版本与用途；可选文件会保存到本机 OPFS。" onClose={onClose}><form className="career-form" onSubmit={submit}><Field label="材料名称"><input name="name" required placeholder="产品设计主简历" /></Field><div className="career-form-row"><Field label="类型"><select name="kind"><option>简历</option><option>求职信</option><option>作品集</option><option>案例</option><option>其他</option></select></Field><Field label="版本"><input name="version" defaultValue="v1.0" required /></Field></div><Field label="本地文件" hint="可选；不会写入 SQLite"><input name="attachment" type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.txt,.md,application/pdf" /></Field><Field label="关联职位"><select name="linked_job_id"><option value="">主材料 / 不关联</option>{data.jobs.map((job) => <option key={job.id} value={job.id}>{job.company} · {job.role}</option>)}</select></Field><Field label="状态"><select name="status"><option value="ready">可使用</option><option value="draft">编辑中</option><option value="sent">已发送</option></select></Field><Field label="备注"><textarea name="notes" rows={4} placeholder="这版材料做了哪些调整？" /></Field>{error && <div className="career-inline-error"><X size={15} />{error}</div>}<div className="career-form-actions"><button type="button" className="career-button ghost" onClick={onClose}>取消</button><button className="career-button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}{saving ? "正在保存…" : "保存材料"}</button></div></form></Modal>;
}

function SmartImportModal({ data, initialInput, onClose, onSaved, notify }: { data: CareerData; initialInput: string; onClose: () => void; onSaved: () => Promise<void>; notify: (text: string, tone?: Notice["tone"]) => void }) {
  const [mode, setMode] = useState<"smart" | "csv">("smart");
  const [input, setInput] = useState(initialInput); const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<JobImportDraft | null>(null); const [error, setError] = useState("");
  const source = /zhipin\.com|BOSS直聘/i.test(input) ? "BOSS直聘" : /linkedin\.com|LinkedIn/i.test(input) ? "LinkedIn" : "智能识别";
  const duplicate = draft && data.jobs.find((job) => job.company.trim().toLowerCase() === draft.company.trim().toLowerCase() && job.role.trim().toLowerCase() === draft.role.trim().toLowerCase());
  function updateDraft<K extends keyof JobImportDraft>(key: K, value: JobImportDraft[K]) { setDraft((current) => current ? { ...current, [key]: value } : current); }
  async function parse() { if (!input.trim()) return; setLoading(true); setError(""); setDraft(null); try { const isUrl = /^https?:\/\/\S+$/i.test(input.trim()); const response = await fetch("/api/import/job", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: isUrl ? input.trim() : "", text: isUrl ? "" : input.trim() }) }); const body = await response.json().catch(() => null); if (!response.ok) throw new Error((body as { error?: string } | null)?.error || "职位解析失败"); const content = parseAiContent(body); if (!content || typeof content !== "object") throw new Error("服务没有返回可用的职位字段"); setDraft(createJobImportDraft(content as Record<string, unknown>, input, source)); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "解析失败"); } finally { setLoading(false); } }
  async function saveDraft() { if (!draft) return; if (!draft.company.trim() || !draft.role.trim()) { notify("请先补全公司与职位", "error"); return; } const id = newId("job"); const now = new Date().toISOString(); await runCareerSql(`INSERT INTO career_jobs (id,company,role,location,source,source_url,stage_id,priority,salary,work_mode,description,applied_at,deadline,contact_name,note,tags,created_at,updated_at,archived,position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0)`, [id, draft.company.trim(), draft.role.trim(), draft.location.trim(), draft.source, safeLink(draft.sourceUrl.trim()) ?? "", "stage_saved", 2, draft.salary.trim(), draft.workMode, draft.description.trim(), null, null, "", "通过分享文本或链接导入，已由用户核对后保存。", draft.keywords, now, now]); await addActivity(id, "import", `从 ${draft.source} 导入 ${draft.company.trim()} · ${draft.role.trim()}`); await onSaved(); }
  function csvImport(file: File) { const reader = new FileReader(); reader.onload = async () => { const text = String(reader.result ?? ""); const lines = text.split(/\r?\n/).filter(Boolean); if (lines.length < 2) { notify("CSV 没有可导入的数据", "error"); return; } const headers = lines[0].split(",").map((item) => item.replace(/^"|"$/g, "").trim().toLowerCase()); const companyIndex = headers.findIndex((item) => /company|公司/.test(item)); const roleIndex = headers.findIndex((item) => /title|position|职位/.test(item)); const urlIndex = headers.findIndex((item) => /url|link|链接/.test(item)); if (companyIndex < 0 || roleIndex < 0) { notify("CSV 需要包含公司和职位列", "error"); return; } const now = new Date().toISOString(); const statements = lines.slice(1).map((line) => { const cells = line.match(/("[^"]*(?:""[^"]*)*"|[^,]*)(?:,|$)/g)?.map((cell) => cell.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')) ?? []; return { sql: `INSERT INTO career_jobs (id,company,role,location,source,source_url,stage_id,priority,salary,work_mode,description,applied_at,deadline,contact_name,note,tags,created_at,updated_at,archived,position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0)`, params: [newId("job"), cells[companyIndex] || "待确认公司", cells[roleIndex] || "待确认职位", "", "LinkedIn", urlIndex >= 0 ? cells[urlIndex] || "" : "", "stage_saved", 1, "", "", "", null, null, "", "从 Saved Jobs CSV 导入", "", now, now] }; }); await runCareerBatch(statements); notify(`已导入 ${statements.length} 个职位`); await onSaved(); }; reader.readAsText(file); }
  return <Modal title="智能导入职位" description="把 LinkedIn 或 BOSS直聘的链接/分享文本整理为可核对的本地草稿。" onClose={onClose} wide>
    <div className="career-import-tabs" role="group" aria-label="导入方式">
      <button type="button" className={mode === "smart" ? "active" : ""} aria-pressed={mode === "smart"} onClick={() => setMode("smart")}><Link2 size={16} />链接 / 分享文本</button>
      <button type="button" className={mode === "csv" ? "active" : ""} aria-pressed={mode === "csv"} onClick={() => setMode("csv")}><FileArchive size={16} />Saved Jobs CSV</button>
    </div>
    {mode === "smart" ? <div className="career-smart-import">
      <div className="career-platform-strip"><span className="linkedin"><b>in</b>LinkedIn</span><span className="boss"><b>BOSS</b>直聘</span><small>优先使用平台的“分享职位”文本</small></div>
      <label className="career-import-box"><textarea aria-label="职位链接或分享文本" value={input} onChange={(event) => { setInput(event.target.value); setDraft(null); }} rows={7} placeholder={"粘贴 LinkedIn / BOSS直聘职位链接\n或粘贴“分享职位”得到的完整文本…"} /><footer><span><ShieldCheck size={14} />只在你点击解析后发送</span><SourceBadge source={source} /></footer></label>
      <button type="button" className="career-button primary import-button" onClick={() => void parse()} disabled={loading || !input.trim()}>{loading ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}{loading ? "正在整理职位…" : "解析为本地草稿"}</button>
      {error && <div className="career-inline-error"><X size={15} />{error}<button type="button" onClick={() => void parse()}>重试</button></div>}
      {draft && <div className="career-import-preview"><header><div><span>保存前核对</span><h3>{draft.role || "职位待确认"}</h3><p>{draft.company || "公司待确认"} · {draft.location || "地点待确认"}</p></div><CheckCircle2 size={21} /></header>
        {duplicate && <div className="career-duplicate-warning"><Bell size={16} /><span><b>已有同名职位</b><small>{duplicate.company} · {duplicate.role}</small></span></div>}
        <div className="career-import-edit-grid"><Field label="公司"><input value={draft.company} onChange={(event) => updateDraft("company", event.target.value)} required /></Field><Field label="职位"><input value={draft.role} onChange={(event) => updateDraft("role", event.target.value)} required /></Field><Field label="地点"><input value={draft.location} onChange={(event) => updateDraft("location", event.target.value)} /></Field><Field label="工作方式"><select value={draft.workMode} onChange={(event) => updateDraft("workMode", event.target.value)}><option value="">待确认</option><option>现场办公</option><option>混合办公</option><option>远程</option></select></Field><Field label="薪资"><input value={draft.salary} onChange={(event) => updateDraft("salary", event.target.value)} placeholder="待确认" /></Field><Field label="来源"><input value={draft.source} readOnly /></Field></div>
        <Field label="关键词" hint="用逗号分隔"><input value={draft.keywords} onChange={(event) => updateDraft("keywords", event.target.value)} /></Field>
        <Field label="原职位链接"><input type="url" value={draft.sourceUrl} onChange={(event) => updateDraft("sourceUrl", event.target.value)} placeholder="https://" /></Field>
        <Field label="职位描述" hint="已保留原始分享文本"><textarea rows={9} value={draft.description} onChange={(event) => updateDraft("description", event.target.value)} /></Field>
        {draft.warnings.length > 0 && <div className="career-import-warnings"><b>保存前留意</b><ul>{draft.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
        <footer>{safeLink(draft.sourceUrl) && <a href={draft.sourceUrl} target="_blank" rel="noreferrer">打开原职位 <ExternalLink size={14} /></a>}<span /><button type="button" className="career-button primary" disabled={!draft.company.trim() || !draft.role.trim()} onClick={() => void saveDraft()}>{duplicate ? "保存一份副本" : "保存到收藏"}</button></footer>
      </div>}
      <div className="career-capture-helper"><span><Command size={17} /></span><div><b>安全的联动方式</b><p>在招聘平台点“分享”或复制链接，再回到这里粘贴。职迹不会读取登录态、站内消息或自动替你投递。</p></div></div>
    </div> : <div className="career-csv-import"><span><FileArchive size={32} /></span><h3>导入 Saved Jobs CSV</h3><p>支持包含 Company / Title / URL 的 LinkedIn 导出，也识别“公司 / 职位 / 链接”中文列。</p><label className="career-button primary"><Upload size={16} />选择 CSV<input hidden type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) csvImport(file); }} /></label><small>导入前建议保留原始导出文件。重复职位会在“全部职位”中便于检查。</small></div>}
  </Modal>;
}

function CommandPalette({ data, onClose, onNavigate, onSelectJob, onAdd }: { data: CareerData; onClose: () => void; onNavigate: (view: CareerView) => void; onSelectJob: (id: string) => void; onAdd: () => void }) {
  const [value, setValue] = useState("");
  const dialogRef = useDialogA11y(onClose);
  const needle = value.toLowerCase(); const jobs = data.jobs.filter((job) => [job.company, job.role, job.tags].join(" ").toLowerCase().includes(needle)).slice(0, 6); const views = navItems.filter((item) => item.label.includes(value));
  return <div className="career-command-layer"><button className="career-modal-scrim" onClick={onClose} aria-label="关闭全局搜索" /><section ref={dialogRef} tabIndex={-1} className="career-command" role="dialog" aria-modal="true" aria-label="全局搜索"><label><Search size={19} /><input data-dialog-initial value={value} onChange={(event) => setValue(event.target.value)} placeholder="搜索职位，或跳转到任意页面…" aria-label="搜索职位或页面" /><kbd>ESC</kbd></label><div><span className="career-command-label">快捷动作</span><button onClick={onAdd}><span><Plus size={17} /></span><b>记录新职位</b><small>新建一条求职机会</small></button>{views.map((item) => <button key={item.id} onClick={() => { onClose(); onNavigate(item.id); }}><span><item.icon size={17} /></span><b>前往{item.label}</b><small>打开{item.label}</small></button>)}{jobs.length > 0 && <span className="career-command-label">职位</span>}{jobs.map((job) => <button key={job.id} onClick={() => onSelectJob(job.id)}><CompanyMark company={job.company} small /><b>{job.role}</b><small>{job.company} · {data.stages.find((stage) => stage.id === job.stage_id)?.name}</small></button>)}</div><footer><span>输入关键词即时筛选</span><span><kbd>ESC</kbd> 关闭</span><span>资料来自本地 SQLite</span></footer></section></div>;
}

function AiPreview({ state, onClose, onCopy, onApply, applyLabel }: {
  state: { action: AiAction; title: string; loading: boolean; result?: unknown; error?: string };
  onClose: () => void;
  onCopy: (result: unknown) => Promise<boolean>;
  onApply?: (result: unknown) => Promise<void>;
  applyLabel?: string;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const [applyState, setApplyState] = useState<"idle" | "applying" | "failed">("idle");
  const [applyError, setApplyError] = useState("");
  async function handleCopy() { setCopyState("copying"); setCopyState(await onCopy(state.result) ? "copied" : "failed"); }
  async function handleApply() {
    if (!onApply) return;
    setApplyState("applying");
    setApplyError("");
    try { await onApply(state.result); }
    catch (error) {
      setApplyState("failed");
      setApplyError(error instanceof Error ? error.message : "AI 结果无法填入，当前草稿没有被改动");
    }
  }
  return <Modal title={state.title} description={onApply ? "先核对结果，再决定是否填入当前表单；填入后仍需手动保存。" : "AI 结果不会自动保存；核对后可以复制到你想保留的位置。"} onClose={onClose} wide><div className="career-ai-preview">{state.loading ? <div className="career-ai-loading"><span><Sparkles size={22} /></span><LoaderCircle className="spin" size={19} /><h3>正在阅读你选择的内容</h3><p>不会自动改动任何职位、材料或面经。</p></div> : state.error ? <div className="career-ai-error"><X size={24} /><h3>这次没有生成成功</h3><p>{state.error}</p><button className="career-button secondary" onClick={onClose}>返回手动编辑</button></div> : <><div className="career-ai-banner"><ShieldCheck size={17} /><span>{onApply ? "填入只会更新总结、问题和复盘草稿；原始速记与面试状态保持不变，生成内容仍需确认。" : "建议来自配置的 DeepSeek 服务；个人经历仍需由你确认。"}</span></div><pre>{aiText(state.result)}</pre>{applyError && <div className="career-inline-error" role="alert"><X size={15} />{applyError}</div>}<div className="career-form-actions"><button type="button" className="career-button ghost" onClick={onClose}>关闭预览</button><button type="button" className={`career-button ${onApply ? "secondary" : "primary"}`} disabled={copyState === "copying" || applyState === "applying"} onClick={() => void handleCopy()}><Check size={16} />{copyState === "copying" ? "正在复制…" : copyState === "copied" ? "已复制" : copyState === "failed" ? "请手动选择" : "复制结果"}</button>{onApply && <button type="button" className="career-button primary" disabled={applyState === "applying"} onClick={() => void handleApply()}>{applyState === "applying" ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}{applyState === "applying" ? "正在填入…" : applyLabel || "填入草稿"}</button>}</div></>}</div></Modal>;
}
