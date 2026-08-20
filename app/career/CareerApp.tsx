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
  PanelTop, Pencil, Plus, RotateCcw, Search, Settings,
  ShieldCheck, Sparkles, Target, Trash2, Upload, UserRound, UsersRound,
  WandSparkles, X, Zap,
} from "lucide-react";
import {
  FormEvent, ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState,
} from "react";
import {
  addActivity, exportCareerDb, importCareerDb, initializeCareerDb,
  loadCareerData, newId, runCareerBatch, runCareerSql,
} from "@/lib/career/db";
import { createStructuredInterviewDraft } from "@/lib/career/interview-ai";
import { createLocalFileObjectUrl, deleteLocalFile, saveLocalFile } from "@/lib/local-db/files";
import type {
  AiAction, CareerData, CareerView, Contact, Interview, InterviewQuestion,
  Job, Notice, Stage, Task,
} from "@/lib/career/types";

const navItems: Array<{ id: CareerView; label: string; compact: string; icon: typeof LayoutDashboard }> = [
  { id: "today", label: "今日", compact: "今日", icon: LayoutDashboard },
  { id: "board", label: "求职看板", compact: "看板", icon: PanelTop },
  { id: "jobs", label: "全部职位", compact: "职位", icon: BriefcaseBusiness },
  { id: "calendar", label: "待办日历", compact: "待办", icon: CalendarDays },
  { id: "interviews", label: "面经", compact: "面经", icon: MessageSquareText },
  { id: "contacts", label: "人脉", compact: "人脉", icon: UsersRound },
  { id: "materials", label: "材料", compact: "材料", icon: FileText },
  { id: "analytics", label: "分析", compact: "分析", icon: BarChart3 },
  { id: "settings", label: "设置", compact: "设置", icon: Settings },
];

const emptyData: CareerData = { stages: [], jobs: [], tasks: [], interviews: [], contacts: [], materials: [], activities: [] };
const sourceClass: Record<string, string> = { LinkedIn: "linkedin", BOSS直聘: "boss", 官网: "website", 内推: "referral" };
const CAREER_CLOCK = Date.now();
const CAREER_TODAY = new Date(CAREER_CLOCK);

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

function relativeDate(value: string | null) {
  if (!value) return "未安排";
  const days = Math.ceil((new Date(value).getTime() - CAREER_CLOCK) / 86_400_000);
  if (days < 0) return `逾期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天";
  if (days === 1) return "明天";
  return `${days} 天后`;
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
  const [data, setData] = useState<CareerData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<CareerView>("today");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [priorityOnly, setPriorityOnly] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [capturedDraft] = useState(readCaptureParams);
  const [modal, setModal] = useState<"job" | "task" | "interview" | "contact" | "material" | "import" | null>(() => capturedDraft ? "import" : null);
  const [importInitial, setImportInitial] = useState(capturedDraft);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedInterviewId, setSelectedInterviewId] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [undo, setUndo] = useState<{ jobId: string; from: string; to: string } | null>(null);
  const [taskUndo, setTaskUndo] = useState<{ taskId: string; from: Task["status"]; title: string; token: string } | null>(null);
  const [aiState, setAiState] = useState<{ action: AiAction; title: string; loading: boolean; result?: unknown; error?: string; applyLabel?: string; onApply?: (result: unknown) => void | Promise<void> } | null>(null);
  const aiRequestRef = useRef<{ id: string; controller: AbortController } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async () => setData(await loadCareerData()), []);

  useEffect(() => {
    let live = true;
    async function boot() {
      try {
        await initializeCareerDb();
        const next = await loadCareerData();
        if (live) setData(next);
      } catch (error) {
        if (live) setLoadError(error instanceof Error ? error.message : "本地数据库暂时无法打开");
      } finally { if (live) setLoading(false); }
    }
    void boot();
    return () => { live = false; };
  }, [refreshKey]);

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
    if (!job || job.stage_id === stageId) return;
    const previous = job.stage_id;
    const nextStage = data.stages.find((stage) => stage.id === stageId);
    setData((current) => ({ ...current, jobs: current.jobs.map((item) => item.id === jobId ? { ...item, stage_id: stageId, updated_at: new Date().toISOString() } : item) }));
    try {
      const now = new Date().toISOString();
      await runCareerBatch([
        { sql: "UPDATE career_jobs SET stage_id = ?, applied_at = CASE WHEN ? = 'stage_applied' AND applied_at IS NULL THEN ? ELSE applied_at END, updated_at = ? WHERE id = ?", params: [stageId, stageId, now, now, jobId] },
        { sql: "INSERT INTO career_activity (id,job_id,type,detail,created_at) VALUES (?,?,?,?,?)", params: [newId("activity"), jobId, "stage", `推进至「${nextStage?.name ?? "新阶段"}」`, now] },
      ]);
      if (rememberUndo) setUndo({ jobId, from: previous, to: stageId });
    } catch (error) {
      setData((current) => ({ ...current, jobs: current.jobs.map((item) => item.id === jobId ? { ...item, stage_id: previous } : item) }));
      notify(error instanceof Error ? error.message : "进度更新失败", "error");
    }
  }

  async function handleUndo() {
    if (!undo) return;
    const item = undo; setUndo(null);
    await moveJob(item.jobId, item.from, false);
    notify("已恢复到原阶段", "info");
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
    <Sidebar view={view} open={sidebarOpen} data={data} onNavigate={navigate} onClose={() => setSidebarOpen(false)} />
    <section className="career-main">
      <Topbar title={navItems.find((item) => item.id === view)?.label ?? "职迹"} query={query} menuOpen={sidebarOpen} onQuery={setQuery} onSearch={() => setSearchOpen(true)} onMenu={() => setSidebarOpen(true)} onAdd={() => setModal("job")} onSettings={() => navigate("settings")} />
      <div className="career-content">
        {view === "today" && <TodayView data={data} onNavigate={navigate} onSelectJob={setSelectedJobId} onToggleTask={toggleTask} onAddJob={() => setModal("job")} onAi={runAi} />}
        {view === "board" && <BoardView data={data} jobs={filteredJobs} query={query} sourceFilter={sourceFilter} priorityOnly={priorityOnly} onSourceFilter={setSourceFilter} onPriorityOnly={setPriorityOnly} onClear={() => { setQuery(""); setSourceFilter("all"); setPriorityOnly(false); }} onSelectJob={setSelectedJobId} onAddJob={() => setModal("job")} onMove={moveJob} sensors={sensors} activeJob={activeJob} onDragStart={(event) => setActiveDragId(String(event.active.id))} onDragEnd={async (event) => { setActiveDragId(null); if (!event.over) return; const stageId = String(event.over.id).replace(/^stage:/, ""); if (data.stages.some((stage) => stage.id === stageId)) await moveJob(String(event.active.id), stageId); }} />}
        {view === "jobs" && <JobsView data={data} jobs={filteredJobs} stageFilter={stageFilter} sourceFilter={sourceFilter} priorityOnly={priorityOnly} onStageFilter={setStageFilter} onSourceFilter={setSourceFilter} onPriorityOnly={setPriorityOnly} onSelectJob={setSelectedJobId} onImport={() => setModal("import")} />}
        {view === "calendar" && <CalendarView data={data} onToggleTask={toggleTask} onAddTask={() => setModal("task")} onAddInterview={() => setModal("interview")} onSelectJob={setSelectedJobId} />}
        {view === "interviews" && <InterviewsView data={data} onAdd={() => setModal("interview")} onSelect={setSelectedInterviewId} onAi={runAi} />}
        {view === "contacts" && <ContactsView data={data} onAdd={() => setModal("contact")} onCreateTask={(contact) => { setSelectedJobId(data.jobs.find((job) => job.company === contact.company)?.id ?? null); setModal("task"); }} />}
        {view === "materials" && <MaterialsView data={data} onAdd={() => setModal("material")} />}
        {view === "analytics" && <AnalyticsView data={data} />}
        {view === "settings" && <SettingsView data={data} onRefresh={refresh} onExport={async () => {
          try {
            const exported = await exportCareerDb();
            const payload = exported && typeof exported === "object" && "data" in exported ? (exported as { data: Uint8Array }).data : exported as Uint8Array;
            const copy = new Uint8Array(payload); const blob = new Blob([copy.buffer], { type: "application/x-sqlite3" });
            const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
            anchor.href = url; anchor.download = `zhiji-${new Date().toISOString().slice(0, 10)}.sqlite3`; anchor.click(); URL.revokeObjectURL(url); notify("SQLite 数据已导出，不含附件原件");
          } catch (error) { notify(error instanceof Error ? error.message : "导出失败", "error"); }
        }} onImport={async (file) => {
          if (!window.confirm("恢复备份会替换当前职迹数据库。确定继续吗？")) return;
          try { await importCareerDb(new Uint8Array(await file.arrayBuffer())); await initializeCareerDb(); await refresh(); notify("SQLite 数据已恢复；附件原件未包含在备份中"); }
          catch (error) { notify(error instanceof Error ? error.message : "恢复失败", "error"); }
        }} notify={notify} />}
      </div>
    </section>
    <MobileNav view={view} onNavigate={navigate} />
    {selectedJob && <JobDrawer job={selectedJob} data={data} onClose={() => setSelectedJobId(null)} onMove={moveJob} onArchive={removeJob} onRefresh={refresh} onAi={runAi} notify={notify} />}
    {selectedInterview && <InterviewDrawer interview={selectedInterview} data={data} onClose={() => setSelectedInterviewId(null)} onRefresh={refresh} onAi={runAi} notify={notify} />}
    {modal === "job" && <JobModal data={data} onClose={() => setModal(null)} onSaved={async (id) => { setModal(null); await refresh(); setSelectedJobId(id); notify("职位已加入职迹"); }} />}
    {modal === "task" && <TaskModal data={data} initialJobId={selectedJobId} onClose={() => { setModal(null); setSelectedJobId(null); }} onSaved={async () => { setModal(null); setSelectedJobId(null); await refresh(); notify("待办已创建"); }} />}
    {modal === "interview" && <InterviewModal data={data} onClose={() => setModal(null)} onSaved={async () => { setModal(null); await refresh(); notify("面试轮次已安排"); }} />}
    {modal === "contact" && <ContactModal onClose={() => setModal(null)} onSaved={async () => { setModal(null); await refresh(); notify("联系人已保存"); }} />}
    {modal === "material" && <MaterialModal data={data} onClose={() => setModal(null)} onSaved={async () => { setModal(null); await refresh(); notify("材料已保存"); }} />}
    {modal === "import" && <SmartImportModal data={data} initialInput={importInitial} onClose={() => { setModal(null); setImportInitial(""); }} onSaved={async () => { setModal(null); setImportInitial(""); await refresh(); notify("职位已导入"); }} notify={notify} />}
    {searchOpen && <CommandPalette data={data} onClose={() => setSearchOpen(false)} onNavigate={navigate} onSelectJob={(id) => { setSearchOpen(false); setSelectedJobId(id); }} onAdd={() => { setSearchOpen(false); setModal("job"); }} />}
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
    <div className="career-toast-stack" aria-live="polite">{taskUndo && <button className="career-toast undo" onClick={() => void handleTaskUndo()} aria-label={`撤销「${taskUndo.title}」的状态变化`}><RotateCcw size={16} />{taskUndo.from === "todo" ? "待办已完成" : "待办已恢复"} <b>撤销</b></button>}{undo && <button className="career-toast undo" onClick={handleUndo}><RotateCcw size={16} />阶段已更新 <b>撤销</b></button>}{notices.map((notice) => <div className={`career-toast ${notice.tone}`} key={notice.id}>{notice.tone === "success" ? <Check size={16} /> : notice.tone === "error" ? <X size={16} /> : <Bell size={16} />}{notice.text}</div>)}</div>
  </main>;
}

function CareerLoading() { return <main className="career-loading" role="status"><div className="career-loading-mark">职</div><LoaderCircle className="spin" size={20} /><p>正在打开你的求职工作台…</p></main>; }
function CareerError({ message, onRetry }: { message: string; onRetry: () => void }) { return <main className="career-error"><ShieldCheck size={30} /><h1>本地资料暂时没有打开</h1><p>{message}</p><button className="career-button primary" onClick={onRetry}><RotateCcw size={16} />重新尝试</button></main>; }

function Sidebar({ view, open, data, onNavigate, onClose }: { view: CareerView; open: boolean; data: CareerData; onNavigate: (view: CareerView) => void; onClose: () => void }) {
  const active = data.jobs.filter((job) => !["stage_accepted", "stage_rejected", "stage_withdrawn"].includes(job.stage_id)).length;
  const recentNotes = data.activities.filter((item) => CAREER_CLOCK - new Date(item.created_at).getTime() < 7 * 86_400_000).length;
  return <><button className={`career-scrim ${open ? "show" : ""}`} aria-label="关闭导航" onClick={onClose} /><aside id="career-sidebar" className={`career-sidebar ${open ? "open" : ""}`}>
    <div className="career-brand"><span>职</span><div><b>职迹</b><small>每一步，都算数</small></div><button className="career-icon-button mobile-only" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
    <nav className="career-nav" aria-label="职迹主导航">{navItems.map((item) => <button key={item.id} aria-label={item.label} className={view === item.id ? "active" : ""} onClick={() => onNavigate(item.id)}><item.icon size={18} strokeWidth={1.8} /><span>{item.label}</span>{item.id === "calendar" && data.tasks.filter((task) => task.status === "todo").length > 0 && <em>{data.tasks.filter((task) => task.status === "todo").length}</em>}</button>)}</nav>
    <div className="career-sidebar-spacer" /><div className="career-goal-card calm"><div><span>近 7 天记录</span><b>{recentNotes}<small> 次变化</small></b></div><div className="career-no-score"><ShieldCheck size={14} /><span>不设目标，也不给你打分</span></div><p>{active} 个机会在工作台里，按自己的节奏来。</p></div><div className="career-privacy"><ShieldCheck size={15} /><span>资料保存在本地 SQLite</span><i /></div>
  </aside></>;
}

function Topbar({ title, query, menuOpen, onQuery, onSearch, onMenu, onAdd, onSettings }: { title: string; query: string; menuOpen: boolean; onQuery: (value: string) => void; onSearch: () => void; onMenu: () => void; onAdd: () => void; onSettings: () => void }) {
  return <header className="career-topbar"><div className="career-topbar-title"><button className="career-icon-button mobile-only" onClick={onMenu} aria-label="打开导航" aria-expanded={menuOpen} aria-controls="career-sidebar"><Menu size={20} /></button><h1>{title}</h1></div><div className="career-topbar-actions"><label className="career-search"><Search size={16} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索职位、公司、标签" aria-label="搜索" /><kbd>⌘ K</kbd></label><button className="career-icon-button command-compact" onClick={onSearch} aria-label="打开搜索"><Search size={18} /></button><button className="career-button primary" onClick={onAdd}><Plus size={17} />记录职位</button><button className="career-avatar" aria-label="个人设置" onClick={onSettings}>FK<span /></button></div></header>;
}

function MobileNav({ view, onNavigate }: { view: CareerView; onNavigate: (view: CareerView) => void }) {
  const visible = navItems.filter((item) => ["today", "board", "calendar", "interviews"].includes(item.id));
  return <nav className="career-mobile-nav" aria-label="移动端主导航">{visible.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => onNavigate(item.id)}><item.icon size={20} /><span>{item.compact}</span></button>)}<button onClick={() => onNavigate("settings")} className={view === "settings" ? "active" : ""}><Menu size={20} /><span>更多</span></button></nav>;
}

function SectionHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) { return <div className="career-section-heading"><div>{eyebrow && <span>{eyebrow}</span>}<h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>; }
function Metric({ label, value, note, icon, tone = "blue" }: { label: string; value: string; note: string; icon: ReactNode; tone?: string }) { return <article className={`career-metric ${tone}`}><div><span>{label}</span><b>{value}</b><small>{note}</small></div><i>{icon}</i></article>; }

function CompanyMark({ company, small = false }: { company: string; small?: boolean }) {
  const colors = ["mint", "lavender", "peach", "blue", "sand", "rose"];
  const index = Array.from(company).reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length;
  return <span className={`career-company-mark ${colors[index]} ${small ? "small" : ""}`}>{initials(company)}</span>;
}

function SourceBadge({ source }: { source: string }) { return <span className={`career-source ${sourceClass[source] ?? "other"}`}>{source === "LinkedIn" ? "in" : source === "BOSS直聘" ? "BOSS" : source}</span>; }

function TodayView({ data, onNavigate, onSelectJob, onToggleTask, onAddJob, onAi }: { data: CareerData; onNavigate: (view: CareerView) => void; onSelectJob: (id: string) => void; onToggleTask: (task: Task) => void; onAddJob: () => void; onAi: (action: AiAction, title: string, payload: unknown) => void }) {
  const date = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(CAREER_TODAY);
  const openTasks = data.tasks.filter((task) => task.status === "todo").sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"));
  const upcoming = data.interviews.filter((item) => item.status === "scheduled" && item.scheduled_at && new Date(item.scheduled_at).getTime() > CAREER_CLOCK).sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""));
  const activeJobs = data.jobs.filter((job) => !["stage_accepted", "stage_rejected", "stage_withdrawn"].includes(job.stage_id));
  const waiting = data.jobs.filter((job) => job.stage_id === "stage_applied");
  const heroJob = upcoming[0] ? data.jobs.find((job) => job.id === upcoming[0].job_id) : data.jobs.find((job) => job.stage_id === "stage_offer") ?? activeJobs[0];
  return <div className="career-view career-today"><section className="career-welcome"><div><span>{date}</span><h2>下午好，今天把最重要的一步走好。</h2><p>你的资料已在本地准备好。这里是下一步最值得关注的事项。</p></div><div className="career-welcome-actions"><button className="career-button secondary" onClick={() => onNavigate("calendar")}><CalendarDays size={16} />查看日程</button><button className="career-button primary" onClick={onAddJob}><Plus size={16} />记录职位</button></div></section>
    <section className="career-today-grid"><div className="career-panel career-focus-panel"><SectionHeading eyebrow="NEXT MOVE" title="最重要的一步" action={heroJob && <button className="career-text-button" onClick={() => onSelectJob(heroJob.id)}>打开职位 <ArrowRight size={14} /></button>} />{heroJob ? <div className="career-focus-card"><CompanyMark company={heroJob.company} /><div className="career-focus-copy"><span>{heroJob.company}</span><h3>{openTasks.find((task) => task.job_id === heroJob.id)?.title ?? `${heroJob.role} · 推进下一步`}</h3><p>{upcoming[0]?.job_id === heroJob.id ? `${formatDate(upcoming[0].scheduled_at, true)} · ${upcoming[0].interviewer || "面试官待确认"}` : heroJob.note}</p></div><div className="career-focus-actions"><button className="career-button primary" onClick={() => onAi("interview_prep", "AI 面试准备", { job: heroJob, interview: upcoming[0] ?? null })}><WandSparkles size={16} />AI 准备</button><button className="career-icon-button" onClick={() => onSelectJob(heroJob.id)} aria-label="打开职位"><ArrowUpRight size={18} /></button></div></div> : <EmptyState icon={<Target />} title="从一个职位开始" text="记录感兴趣的机会，职迹会帮你保持清晰节奏。" action={<button className="career-button primary" onClick={onAddJob}>记录职位</button>} />}<div className="career-focus-tips"><span><i />用 3 分钟写下这次面试最想让对方记住的观点</span><button onClick={() => onAi("interview_prep", "生成 30 分钟准备清单", { job: heroJob, duration: 30 })}>生成 30 分钟清单</button></div></div>
      <div className="career-panel career-agenda-panel"><SectionHeading title="今天与接下来" action={<button className="career-text-button" onClick={() => onNavigate("calendar")}>全部日程 <ChevronRight size={14} /></button>} /><div className="career-agenda-list">{openTasks.slice(0, 5).map((task) => { const job = data.jobs.find((item) => item.id === task.job_id); return <button className="career-agenda-item" key={task.id} onClick={() => onToggleTask(task)}><span className={`career-check ${task.status}`}><Check size={13} /></span><span><b>{task.title}</b><small>{job ? `${job.company} · ` : ""}{relativeDate(task.due_at)}</small></span><em className={task.priority >= 3 ? "urgent" : ""}>{task.kind}</em></button>; })}</div></div>
    </section><section className="career-metric-grid career-today-metrics"><Metric label="活跃机会" value={String(activeJobs.length)} note={`${data.jobs.filter((job) => job.stage_id === "stage_interview").length} 个正在面试`} icon={<BriefcaseBusiness size={18} />} /><Metric label="待办事项" value={String(openTasks.length)} note={`${openTasks.filter((task) => task.due_at && new Date(task.due_at).getTime() < CAREER_CLOCK).length} 项已逾期`} icon={<ListTodo size={18} />} tone="amber" /><Metric label="近期待面" value={String(upcoming.length)} note={upcoming[0] ? `${formatDate(upcoming[0].scheduled_at, true)} · ${upcoming[0].round_name}` : "暂未安排"} icon={<CalendarDays size={18} />} tone="plum" /><Metric label="等待回应" value={String(waiting.length)} note="等待也是流程的一部分" icon={<Clock3 size={18} />} tone="green" /></section><section className="career-panel career-recent"><SectionHeading title="最近动态" description="所有推进都自动留在时间线里" action={<button className="career-text-button" onClick={() => onNavigate("jobs")}>查看全部</button>} /><div className="career-activity-row">{data.activities.slice(0, 4).map((item) => { const job = data.jobs.find((entry) => entry.id === item.job_id); return <button key={item.id} onClick={() => job && onSelectJob(job.id)}><span className={`career-activity-icon ${item.type}`}><Zap size={15} /></span><span><b>{item.detail}</b><small>{job ? `${job.company} · ${job.role}` : "职迹"}</small></span><time>{formatDate(item.created_at)}</time></button>; })}</div></section>
  </div>;
}

type SensorValue = ReturnType<typeof useSensors>;
function BoardView({ data, jobs, query, sourceFilter, priorityOnly, onSourceFilter, onPriorityOnly, onClear, onSelectJob, onAddJob, onMove, sensors, activeJob, onDragStart, onDragEnd }: { data: CareerData; jobs: Job[]; query: string; sourceFilter: string; priorityOnly: boolean; onSourceFilter: (value: string) => void; onPriorityOnly: (value: boolean) => void; onClear: () => void; onSelectJob: (id: string) => void; onAddJob: () => void; onMove: (jobId: string, stageId: string) => Promise<void>; sensors: SensorValue; activeJob: Job | null; onDragStart: (event: DragStartEvent) => void; onDragEnd: (event: DragEndEvent) => void }) {
  const stages = data.stages.filter((stage) => !stage.hidden && !["stage_accepted", "stage_rejected", "stage_withdrawn"].includes(stage.id));
  return <div className="career-view career-board-view"><SectionHeading eyebrow="PIPELINE" title="求职看板" description={`${jobs.length} 个机会 · 拖动卡片，或使用卡片内的阶段菜单`} action={<div className="career-view-actions"><button className={`career-chip ${priorityOnly ? "active" : ""}`} aria-pressed={priorityOnly} onClick={() => onPriorityOnly(!priorityOnly)}><Target size={14} />只看重点</button><select className="career-select compact" value={sourceFilter} onChange={(event) => onSourceFilter(event.target.value)} aria-label="来源筛选"><option value="all">全部来源</option>{[...new Set(data.jobs.map((job) => job.source))].map((source) => <option key={source}>{source}</option>)}</select><button className="career-icon-button" onClick={onClear} aria-label="清除筛选"><RotateCcw size={16} /></button></div>} />{(query || sourceFilter !== "all" || priorityOnly) && <div className="career-filter-summary"><Filter size={14} />当前显示 {jobs.length} 个结果<button onClick={onClear}>清除全部</button></div>}
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}><div className="career-board-scroll">{stages.map((stage) => <BoardColumn key={stage.id} stage={stage} jobs={jobs.filter((job) => job.stage_id === stage.id)} data={data} onSelectJob={onSelectJob} onAddJob={onAddJob} onMove={onMove} />)}</div><DragOverlay>{activeJob ? <JobCard job={activeJob} data={data} overlay onSelect={() => undefined} /> : null}</DragOverlay></DndContext>
  </div>;
}

function BoardColumn({ stage, jobs, data, onSelectJob, onAddJob, onMove }: { stage: Stage; jobs: Job[]; data: CareerData; onSelectJob: (id: string) => void; onAddJob: () => void; onMove: (jobId: string, stageId: string) => Promise<void> }) {
  const { isOver, setNodeRef } = useDroppable({ id: `stage:${stage.id}` });
  return <section ref={setNodeRef} className={`career-board-column ${isOver ? "over" : ""}`}><header><div><i style={{ background: stage.color }} /><b>{stage.name}</b><span>{jobs.length}</span></div><button onClick={onAddJob} aria-label={`在${stage.name}添加职位`}><Plus size={16} /></button></header><div className="career-board-cards">{jobs.map((job) => <DraggableJobCard key={job.id} job={job} data={data} onSelect={() => onSelectJob(job.id)} onMove={onMove} />)}{jobs.length === 0 && <div className="career-board-empty">拖到这里</div>}</div><button className="career-add-inline" onClick={onAddJob}><Plus size={15} />添加职位</button></section>;
}

function DraggableJobCard({ job, data, onSelect, onMove }: { job: Job; data: CareerData; onSelect: () => void; onMove: (jobId: string, stageId: string) => Promise<void> }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: job.id });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  return <div ref={setNodeRef} style={style} className={isDragging ? "dragging" : ""}><JobCard job={job} data={data} onSelect={onSelect} onMove={onMove} dragProps={{ ...attributes, ...listeners }} /></div>;
}

function JobCard({ job, data, onSelect, onMove, overlay = false, dragProps = {} }: { job: Job; data: CareerData; onSelect: () => void; onMove?: (jobId: string, stageId: string) => Promise<void>; overlay?: boolean; dragProps?: Record<string, unknown> }) {
  const nextTask = data.tasks.find((task) => task.job_id === job.id && task.status === "todo");
  const upcoming = data.interviews.find((item) => item.job_id === job.id && item.status === "scheduled");
  const draggable = Object.keys(dragProps).length > 0;
  return <article className={`career-job-card ${overlay ? "overlay" : ""}`}><div className="career-job-card-top"><CompanyMark company={job.company} small />{draggable && <button className="career-grip" {...dragProps} aria-label={`拖动 ${job.company} ${job.role}`}><GripVertical size={16} /></button>}</div><button className="career-job-card-open" onClick={onSelect} aria-label={`打开 ${job.company} ${job.role}`}><h3>{job.role}</h3><p>{job.company}</p><div className="career-card-meta"><span>{job.location || "地点待定"}</span>{job.work_mode && <span>{job.work_mode}</span>}</div><div className="career-card-tags">{job.tags.split(",").filter(Boolean).slice(0, 2).map((tag) => <i key={tag}>{tag}</i>)}</div><div className={`career-next ${nextTask?.due_at && new Date(nextTask.due_at).getTime() < CAREER_CLOCK ? "late" : ""}`}><Clock3 size={13} /><span>{upcoming ? `${formatDate(upcoming.scheduled_at, true)} · ${upcoming.round_name}` : nextTask ? `${relativeDate(nextTask.due_at)} · ${nextTask.title}` : "还没有下一步"}</span></div></button><footer><SourceBadge source={job.source} />{onMove ? <select value={job.stage_id} onChange={(event) => void onMove(job.id, event.target.value)} aria-label={`移动 ${job.company} ${job.role} 到阶段`}>{data.stages.filter((stage) => !stage.hidden).map((stage) => <option value={stage.id} key={stage.id}>{stage.name}</option>)}</select> : <span className="career-priority" aria-label={`优先级 ${job.priority}`}>{[1, 2, 3].map((dot) => <i key={dot} className={dot <= job.priority ? "active" : ""} />)}</span>}</footer></article>;
}

function JobsView({ data, jobs, stageFilter, sourceFilter, priorityOnly, onStageFilter, onSourceFilter, onPriorityOnly, onSelectJob, onImport }: { data: CareerData; jobs: Job[]; stageFilter: string; sourceFilter: string; priorityOnly: boolean; onStageFilter: (value: string) => void; onSourceFilter: (value: string) => void; onPriorityOnly: (value: boolean) => void; onSelectJob: (id: string) => void; onImport: () => void }) {
  return <div className="career-view"><SectionHeading eyebrow="APPLICATIONS" title="全部职位" description={`共 ${data.jobs.length} 个职位，${data.jobs.filter((job) => job.stage_id === "stage_interview").length} 个正在面试`} action={<button className="career-button secondary" onClick={onImport}><Import size={16} />智能导入</button>} />
    <div className="career-toolbar"><select className="career-select" value={stageFilter} onChange={(event) => onStageFilter(event.target.value)} aria-label="按阶段筛选"><option value="all">全部阶段</option>{data.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select><select className="career-select" value={sourceFilter} onChange={(event) => onSourceFilter(event.target.value)} aria-label="按来源筛选"><option value="all">全部来源</option>{[...new Set(data.jobs.map((job) => job.source))].map((source) => <option key={source}>{source}</option>)}</select><button className={`career-chip ${priorityOnly ? "active" : ""}`} aria-pressed={priorityOnly} onClick={() => onPriorityOnly(!priorityOnly)}><Target size={14} />重点关注</button><span className="career-toolbar-count">显示 {jobs.length} 条</span></div>
    <div className="career-mobile-job-list">{jobs.map((job) => { const stage = data.stages.find((item) => item.id === job.stage_id); const task = data.tasks.find((item) => item.job_id === job.id && item.status === "todo"); return <article className="career-mobile-job-card" key={job.id}><button onClick={() => onSelectJob(job.id)} aria-label={`打开 ${job.company} ${job.role}`}><header><CompanyMark company={job.company} small /><span><b>{job.role}</b><small>{job.company}</small></span><ChevronRight size={18} /></header><div className="career-mobile-job-meta"><span className="career-stage-pill"><i style={{ background: stage?.color }} />{stage?.name}</span><SourceBadge source={job.source} /><span>{job.location || "地点待确认"}</span></div><div className={`career-mobile-job-next ${task?.due_at && new Date(task.due_at).getTime() < CAREER_CLOCK ? "late" : ""}`}><Clock3 size={14} /><span>{task ? `${relativeDate(task.due_at)} · ${task.title}` : "还没有安排下一步"}</span></div></button></article>; })}{jobs.length === 0 && <EmptyState icon={<Inbox />} title="没有匹配的职位" text="调整筛选条件，或导入一个新的机会。" />}</div>
    <div className="career-table-wrap"><table className="career-table"><thead><tr><th>职位</th><th>阶段</th><th>来源</th><th>地点</th><th>投递时间</th><th>下一步</th><th /></tr></thead><tbody>{jobs.map((job) => { const stage = data.stages.find((item) => item.id === job.stage_id); const task = data.tasks.find((item) => item.job_id === job.id && item.status === "todo"); return <tr key={job.id}><td><button className="career-job-row-button" onClick={() => onSelectJob(job.id)}><span className="career-job-cell"><CompanyMark company={job.company} small /><span><b>{job.role}</b><small>{job.company}</small></span></span></button></td><td><span className="career-stage-pill"><i style={{ background: stage?.color }} />{stage?.name}</span></td><td><SourceBadge source={job.source} /></td><td>{job.location || "—"}</td><td>{job.applied_at ? formatDate(job.applied_at) : "尚未投递"}</td><td><span className={task?.due_at && new Date(task.due_at).getTime() < CAREER_CLOCK ? "career-late-text" : ""}>{task ? `${relativeDate(task.due_at)} · ${task.title}` : "—"}</span></td><td><button className="career-row-open" onClick={() => onSelectJob(job.id)} aria-label={`打开 ${job.company} ${job.role}`}><ChevronRight size={16} /></button></td></tr>; })}</tbody></table>{jobs.length === 0 && <EmptyState icon={<Inbox />} title="没有匹配的职位" text="调整筛选条件，或导入一个新的机会。" />}</div>
  </div>;
}

function CalendarView({ data: sourceData, onToggleTask, onAddTask, onAddInterview, onSelectJob }: { data: CareerData; onToggleTask: (task: Task) => void; onAddTask: () => void; onAddInterview: () => void; onSelectJob: (id: string) => void }) {
  const data = { ...sourceData, interviews: sourceData.interviews.filter((item) => item.status === "scheduled") };
  const [mode, setMode] = useState<"agenda" | "week">("agenda");
  const [showCompleted, setShowCompleted] = useState(false);
  const open = data.tasks.filter((task) => task.status === "todo").sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"));
  const completed = data.tasks.filter((task) => task.status === "done").sort((a, b) => (b.due_at ?? b.created_at).localeCompare(a.due_at ?? a.created_at));
  const days = Array.from({ length: 7 }, (_, index) => { const date = new Date(CAREER_CLOCK); date.setDate(date.getDate() + index); date.setHours(0, 0, 0, 0); return date; });
  return <div className="career-view"><SectionHeading eyebrow="PLAN" title="待办与日历" description="把投递、面试和跟进放在同一条时间线上" action={<div className="career-view-actions"><button className="career-button secondary" onClick={onAddInterview}><CalendarDays size={16} />安排面试</button><button className="career-button primary" onClick={onAddTask}><Plus size={16} />新建待办</button></div>} /><div className="career-segmented"><button className={mode === "agenda" ? "active" : ""} onClick={() => setMode("agenda")}>议程</button><button className={mode === "week" ? "active" : ""} onClick={() => setMode("week")}>未来 7 天</button></div>
    {mode === "agenda" ? <div className="career-plan-grid"><section className="career-panel career-task-list"><header><h3>待办清单</h3><span>{open.length} 项未完成</span></header>{open.map((task) => { const job = data.jobs.find((item) => item.id === task.job_id); return <article key={task.id}><button className="career-check" onClick={() => onToggleTask(task)} aria-label={`完成「${task.title}」`}><Check size={13} /></button><div><b>{task.title}</b><button onClick={() => job && onSelectJob(job.id)}>{job ? `${job.company} · ${job.role}` : "通用任务"}</button></div><span className={task.due_at && new Date(task.due_at).getTime() < CAREER_CLOCK ? "late" : ""}><Clock3 size={13} />{relativeDate(task.due_at)}</span><em>{task.kind}</em></article>; })}{open.length === 0 && <p className="career-task-calm-empty">目前没有待办。需要时再记录下一步就好。</p>}{completed.length > 0 && <div className="career-completed-block"><button className="career-completed-toggle" onClick={() => setShowCompleted((current) => !current)} aria-expanded={showCompleted}><span><CheckCircle2 size={15} />已完成</span><em>{completed.length}</em><small>{showCompleted ? "收起" : "查看与恢复"}</small><ChevronRight size={15} /></button>{showCompleted && <div className="career-completed-list">{completed.map((task) => { const job = data.jobs.find((item) => item.id === task.job_id); return <article key={task.id}><span><Check size={13} /></span><div><b>{task.title}</b><small>{job ? `${job.company} · ${job.role}` : "通用任务"}</small></div><button onClick={() => onToggleTask(task)} aria-label={`恢复「${task.title}」`}>恢复</button></article>; })}</div>}</div>}</section><section className="career-panel career-upcoming"><header><h3>面试日程</h3><span>按时间排序</span></header>{data.interviews.filter((item) => item.status !== "completed").map((item) => { const job = data.jobs.find((entry) => entry.id === item.job_id); return <button key={item.id} onClick={() => job && onSelectJob(job.id)}><time><b>{new Date(item.scheduled_at ?? "").getDate() || "—"}</b><small>{formatDate(item.scheduled_at)}</small></time><span><b>{job?.company} · {item.round_name}</b><small>{formatDate(item.scheduled_at, true)} · {item.duration} 分钟</small></span><ChevronRight size={16} /></button>; })}</section></div> : <div className="career-week-grid">{days.map((day) => { const key = day.toDateString(); const tasks = open.filter((task) => task.due_at && new Date(task.due_at).toDateString() === key); const interviews = data.interviews.filter((item) => item.scheduled_at && new Date(item.scheduled_at).toDateString() === key); return <section key={key} className={key === CAREER_TODAY.toDateString() ? "today" : ""}><header><span>{new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(day)}</span><b>{day.getDate()}</b></header><div>{interviews.map((item) => <article className="event" key={item.id}><CalendarDays size={13} /><b>{data.jobs.find((job) => job.id === item.job_id)?.company}</b><small>{item.round_name}</small></article>)}{tasks.map((task) => <article key={task.id}><Circle size={12} /><b>{task.title}</b><small>{dateInputValue(task.due_at).slice(11)}</small></article>)}</div></section>; })}</div>}
  </div>;
}

function InterviewsView({ data, onAdd, onSelect, onAi }: { data: CareerData; onAdd: () => void; onSelect: (id: string) => void; onAi: (action: AiAction, title: string, payload: unknown) => void }) {
  const [tab, setTab] = useState<"upcoming" | "archive">("upcoming");
  const shown = data.interviews.filter((item) => tab === "archive" ? item.status !== "scheduled" : item.status === "scheduled");
  return <div className="career-view"><SectionHeading eyebrow="INTERVIEW LOG" title="面试与面经" description="每一轮都有准备、有记录，也有下一次会用到的经验" action={<button className="career-button primary" onClick={onAdd}><Plus size={16} />安排面试</button>} /><div className="career-segmented" aria-label="面试记录范围"><button className={tab === "upcoming" ? "active" : ""} aria-pressed={tab === "upcoming"} onClick={() => setTab("upcoming")}>即将进行</button><button className={tab === "archive" ? "active" : ""} aria-pressed={tab === "archive"} onClick={() => setTab("archive")}>面经档案</button></div><div className="career-interview-grid">{shown.map((item) => { const job = data.jobs.find((entry) => entry.id === item.job_id); const questions = parseQuestions(item.questions_json); const title = `${job?.company ?? "待确认公司"} · ${item.round_name}`; return <article className="career-interview-card" key={item.id}><header><CompanyMark company={job?.company ?? "职"} /><div><span>{item.status === "completed" ? "已完成" : item.status === "canceled" ? "已取消" : relativeDate(item.scheduled_at)}</span><h3>{title}</h3><p>{job?.role}</p></div><button className="career-icon-button" onClick={() => onSelect(item.id)} aria-label={`打开 ${title} 面经`}><ArrowUpRight size={17} /></button></header><div className="career-interview-meta"><span><CalendarDays size={14} />{formatDate(item.scheduled_at, true)}</span><span><Clock3 size={14} />{item.duration} 分钟</span><span><UserRound size={14} />{item.interviewer || "面试官待确认"}</span></div>{item.status === "scheduled" ? <div className="career-interview-actions"><button className="career-button secondary" onClick={() => onAi("interview_prep", "生成面试准备包", { job, interview: item })}><Sparkles size={15} />AI 准备包</button>{safeLink(item.meeting_url) && <a className="career-button ghost" href={item.meeting_url} target="_blank" rel="noreferrer">加入会议 <ExternalLink size={14} /></a>}</div> : <div className="career-experience-preview"><p>{item.status === "canceled" ? item.summary || "这轮面试已取消。" : item.summary || "可随时补充这轮面试的记录。"}</p>{item.status === "completed" && (questions.length > 0 || item.reflection) && <footer>{questions.length > 0 && <span>{questions.length} 个问题</span>}{item.reflection && <span>已记录复盘</span>}</footer>}</div>}</article>; })}</div>{shown.length === 0 && <EmptyState icon={<MessageSquareText />} title={tab === "archive" ? "还没有面经" : "暂未安排面试"} text="记录每一轮问题、回答和复盘，让经验真正沉淀下来。" action={<button className="career-button primary" onClick={onAdd}>安排第一轮</button>} />}</div>;
}

function ContactsView({ data, onAdd, onCreateTask }: { data: CareerData; onAdd: () => void; onCreateTask: (contact: Contact) => void }) {
  return <div className="career-view"><SectionHeading eyebrow="RELATIONSHIPS" title="求职人脉" description="把每次沟通变成清晰、得体的下一步" action={<button className="career-button primary" onClick={onAdd}><Plus size={16} />添加联系人</button>} /><div className="career-contact-grid">{data.contacts.map((contact) => <article className="career-contact-card" key={contact.id}><header><span className="career-contact-avatar">{initials(contact.name)}</span><div><h3>{contact.name}</h3><p>{contact.role} · {contact.company}</p></div></header><div className="career-contact-meta"><span><ContactRound size={14} />{contact.channel}</span><span><Clock3 size={14} />{contact.last_contact_at ? `上次联系 ${formatDate(contact.last_contact_at)}` : "尚未记录联系"}</span></div><p>{contact.notes || "暂无备注"}</p><footer><span className={contact.next_follow_up && new Date(contact.next_follow_up).getTime() < CAREER_CLOCK ? "late" : ""}>下次跟进：{relativeDate(contact.next_follow_up)}</span><button onClick={() => onCreateTask(contact)}>创建待办 <ArrowRight size={14} /></button></footer></article>)}</div></div>;
}

function MaterialsView({ data, onAdd }: { data: CareerData; onAdd: () => void }) {
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
  return <div className="career-view"><SectionHeading eyebrow="MATERIALS" title="求职材料" description="保留每一个版本，也记住哪一份发给了谁" action={<button className="career-button primary" onClick={onAdd}><Plus size={16} />添加材料</button>} /><div className="career-material-grid">{data.materials.map((material) => { const job = data.jobs.find((item) => item.id === material.linked_job_id); return <article className="career-material-card" key={material.id}><span className={`career-file-icon ${material.kind}`}><FileText size={23} /></span><div><header><span>{material.kind}</span><em className={material.status}>{material.status === "sent" ? "已发送" : material.status === "draft" ? "编辑中" : "可使用"}</em>{material.file_key && <em className="attached">本地附件</em>}</header><h3>{material.name}</h3><p>{material.notes}</p><footer><span>{material.version} · 更新于 {formatDate(material.updated_at)}</span>{job && <small>用于 {job.company}</small>}{material.file_name && <small>{material.file_name} · {Math.max(1, Math.round((material.byte_size ?? 0) / 1024))} KB</small>}</footer></div>{material.file_key ? <button className="career-icon-button" onClick={() => void openFile(material.file_key!)} aria-label={`打开 ${material.file_name ?? material.name}`}><Download size={17} /></button> : <button className="career-button ghost" onClick={onAdd}>新建带附件版本</button>}</article>; })}</div></div>;
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

function SettingsView({ data, onRefresh, onExport, onImport, notify }: { data: CareerData; onRefresh: () => Promise<void>; onExport: () => Promise<void>; onImport: (file: File) => Promise<void>; notify: (text: string, tone?: Notice["tone"]) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [savingStage, setSavingStage] = useState<string | null>(null);
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
  return <div className="career-view"><SectionHeading eyebrow="PREFERENCES" title="设置" description="隐私、流程与数据，都由你掌控" /><div className="career-settings-layout"><nav><a href="#workflow">求职流程</a><a href="#privacy">AI 与隐私</a><a href="#data">数据与备份</a><a href="#capture">浏览器采集器</a></nav><div><section className="career-settings-card" id="workflow"><header><div><h3>看板阶段</h3><p>调整名称，保留一致的数据分析口径。</p></div></header><div className="career-stage-settings">{data.stages.map((stage) => <label key={stage.id}><i style={{ background: stage.color }} /><input defaultValue={stage.name} onBlur={(event) => void rename(stage, event.target.value)} aria-label={`${stage.name}阶段名称`} /><span>{savingStage === stage.id ? <LoaderCircle className="spin" size={14} /> : stage.is_terminal ? "终态" : "进行中"}</span></label>)}</div></section>
    <section className="career-settings-card" id="privacy"><header><div><h3>AI 与隐私</h3><p>只有你主动使用 AI 时，所选内容才会发送至配置的服务。</p></div><span className={aiHealth.status === "configured" ? "career-status-good" : "career-status-neutral"} aria-live="polite"><i />{aiStatusLabel}</span></header><div className="career-setting-row"><span><b>当前模型</b><small>由服务器环境安全配置</small></span><code>{aiHealth.model || "DeepSeek"}</code></div><div className="career-setting-row"><span><b>结果保留方式</b><small>关闭预览不会自动保存，也不会留下隐藏副本</small></span><code>复制后手动粘贴</code></div><div className="career-privacy-note"><ShieldCheck size={18} /><p>API 密钥不会进入浏览器、本地数据库或备份。职位描述和面试笔记会被当作不可信数据处理。</p></div></section>
    <section className="career-settings-card" id="data"><header><div><h3>数据与备份</h3><p>导出 SQLite 数据库，随时带走全部结构化职迹。</p></div></header><div className="career-data-actions"><button onClick={() => void onExport()}><span><Download size={19} /></span><div><b>导出 SQLite 备份</b><small>职位、任务、面经、人脉与材料索引</small></div><ChevronRight size={17} /></button><button onClick={() => fileRef.current?.click()}><span><Upload size={19} /></span><div><b>恢复 SQLite 备份</b><small>恢复前会再次确认，当前数据将被替换</small></div><ChevronRight size={17} /></button><input ref={fileRef} hidden type="file" accept=".sqlite,.sqlite3,.db,application/x-sqlite3" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onImport(file); event.currentTarget.value = ""; }} /></div><p className="career-settings-footnote">SQLite 备份包含附件索引，但不包含保存在 OPFS 的简历/作品集文件原件；请另行保留原文件。</p></section>
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

function JobDrawer({ job, data, onClose, onMove, onArchive, onRefresh, onAi, notify }: { job: Job; data: CareerData; onClose: () => void; onMove: (id: string, stage: string) => Promise<void>; onArchive: (job: Job) => Promise<void>; onRefresh: () => Promise<void>; onAi: (action: AiAction, title: string, payload: unknown) => void; notify: (text: string, tone?: Notice["tone"]) => void }) {
  const [tab, setTab] = useState<"overview" | "tasks" | "interviews" | "materials">("overview");
  const [editing, setEditing] = useState(false);
  const tasks = data.tasks.filter((task) => task.job_id === job.id);
  const interviews = data.interviews.filter((item) => item.job_id === job.id);
  const materials = data.materials.filter((item) => item.linked_job_id === job.id);
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await runCareerSql("UPDATE career_jobs SET company=?,role=?,location=?,salary=?,work_mode=?,description=?,note=?,tags=?,deadline=?,updated_at=? WHERE id=?", [form.get("company"), form.get("role"), form.get("location"), form.get("salary"), form.get("work_mode"), form.get("description"), form.get("note"), form.get("tags"), fromDateInput(String(form.get("deadline") || "")), new Date().toISOString(), job.id]); await onRefresh(); setEditing(false); notify("职位信息已保存"); }
  return <Drawer label={`${job.company} · ${job.role}`} onClose={onClose} wide><div className="career-job-drawer-head"><CompanyMark company={job.company} /><div><SourceBadge source={job.source} /><h2>{job.role}</h2><p>{job.company} · {job.location || "地点待确认"}</p></div><button className="career-icon-button" onClick={onClose} aria-label="关闭职位详情"><X size={19} /></button></div><div className="career-job-status-row"><select value={job.stage_id} onChange={(event) => void onMove(job.id, event.target.value)} aria-label="职位阶段">{data.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select><span><Target size={14} />优先级 {job.priority}</span>{safeLink(job.source_url) && <a href={job.source_url} target="_blank" rel="noreferrer">查看原职位 <ExternalLink size={14} /></a>}</div><div className="career-drawer-tabs">{[["overview", "职位概览"], ["tasks", `待办 ${tasks.length}`], ["interviews", `面试 ${interviews.length}`], ["materials", `材料 ${materials.length}`]].map(([id, label]) => <button className={tab === id ? "active" : ""} aria-pressed={tab === id} key={id} onClick={() => setTab(id as typeof tab)}>{label}</button>)}</div><div className="career-drawer-body">{tab === "overview" && (editing ? <form className="career-form" onSubmit={save}><Field label="公司"><input name="company" defaultValue={job.company} required /></Field><Field label="职位"><input name="role" defaultValue={job.role} required /></Field><div className="career-form-row"><Field label="地点"><input name="location" defaultValue={job.location} /></Field><Field label="工作方式"><input name="work_mode" defaultValue={job.work_mode} /></Field></div><div className="career-form-row"><Field label="薪资"><input name="salary" defaultValue={job.salary} /></Field><Field label="截止时间"><input name="deadline" type="datetime-local" defaultValue={dateInputValue(job.deadline)} /></Field></div><Field label="标签"><input name="tags" defaultValue={job.tags} /></Field><Field label="职位描述"><textarea name="description" rows={7} defaultValue={job.description} /></Field><Field label="个人备注"><textarea name="note" rows={4} defaultValue={job.note} /></Field><div className="career-form-actions"><button type="button" className="career-button ghost" onClick={() => setEditing(false)}>取消</button><button className="career-button primary">保存修改</button></div></form> : <><div className="career-detail-actions"><button className="career-button secondary" onClick={() => onAi("fit_analysis", "AI 职位要求拆解", { job })}><Sparkles size={15} />拆解职位要求</button><button className="career-button ghost" onClick={() => setEditing(true)}><Pencil size={15} />编辑</button></div><dl className="career-detail-grid"><div><dt>薪资范围</dt><dd>{job.salary || "未记录"}</dd></div><div><dt>工作方式</dt><dd>{job.work_mode || "未记录"}</dd></div><div><dt>申请来源</dt><dd>{job.source}</dd></div><div><dt>投递时间</dt><dd>{job.applied_at ? formatDate(job.applied_at) : "尚未投递"}</dd></div><div><dt>联系人</dt><dd>{job.contact_name || "未关联"}</dd></div><div><dt>截止时间</dt><dd>{job.deadline ? formatDate(job.deadline, true) : "未记录"}</dd></div></dl><section className="career-detail-section"><h3>职位描述</h3><p className="career-long-copy">{job.description || "还没有保存职位描述。"}</p></section><section className="career-detail-section"><h3>我的备注</h3><p className="career-long-copy">{job.note || "还没有添加备注。"}</p></section><div className="career-card-tags">{job.tags.split(",").filter(Boolean).map((tag) => <i key={tag}>{tag}</i>)}</div></>)}
    {tab === "tasks" && <div className="career-drawer-list">{tasks.map((task) => <article key={task.id}><span className={`career-check ${task.status}`}><Check size={13} /></span><div><b>{task.title}</b><small>{relativeDate(task.due_at)} · {task.kind}</small></div></article>)}{tasks.length === 0 && <EmptyState icon={<ListTodo />} title="还没有待办" text="为这个职位安排一个具体的下一步。" />}</div>}{tab === "interviews" && <div className="career-drawer-list">{interviews.map((item) => <article key={item.id}><span className="career-list-icon"><MessageSquareText size={16} /></span><div><b>{item.round_name}</b><small>{formatDate(item.scheduled_at, true)} · {item.interviewer || "面试官待确认"}</small><p>{item.summary}</p></div></article>)}{interviews.length === 0 && <EmptyState icon={<MessageSquareText />} title="还没有面试轮次" text="推进到面试后，在这里完整记录每一轮。" />}</div>}{tab === "materials" && <div className="career-drawer-list">{materials.map((item) => <article key={item.id}><span className="career-list-icon"><FileText size={16} /></span><div><b>{item.name}</b><small>{item.kind} · {item.version}</small><p>{item.notes}</p></div></article>)}{materials.length === 0 && <EmptyState icon={<FileText />} title="还没有关联材料" text="关联确切版本，之后随时知道发出的是哪一份。" />}</div>}</div><footer className="career-drawer-footer"><button className="career-button danger" onClick={() => void onArchive(job)}><Archive size={15} />归档职位</button></footer></Drawer>;
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
  const [status, setStatus] = useState(interview.status);
  const [summary, setSummary] = useState(interview.summary);
  const [rawNotes, setRawNotes] = useState(interview.raw_notes);
  const [questions, setQuestions] = useState<InterviewQuestion[]>(parseQuestions(interview.questions_json));
  const [reflection, setReflection] = useState(interview.reflection);
  const [saving, setSaving] = useState(false);
  const [structureUndo, setStructureUndo] = useState<{
    summary: string;
    questions: InterviewQuestion[];
    reflection: string;
  } | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await runCareerSql(
        "UPDATE career_interviews SET status=?,summary=?,raw_notes=?,questions_json=?,reflection=?,updated_at=? WHERE id=?",
        [status, summary, rawNotes, JSON.stringify(questions), reflection, new Date().toISOString(), interview.id],
      );
      await onRefresh();
      setStructureUndo(null);
      notify("面经已保存");
    } catch (error) {
      notify(error instanceof Error ? error.message : "面经保存失败", "error");
    } finally {
      setSaving(false);
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

  return <Drawer label={`${job?.company ?? "职迹"} · ${interview.round_name}面经`} onClose={onClose} wide>
    <div className="career-job-drawer-head">
      <CompanyMark company={job?.company ?? "职"} />
      <div><span className="career-eyebrow">INTERVIEW EXPERIENCE</span><h2>{job?.company} · {interview.round_name}</h2><p>{formatDate(interview.scheduled_at, true)} · {interview.interviewer || "面试官待确认"}</p></div>
      <button className="career-icon-button" onClick={onClose} aria-label="关闭面经"><X size={19} /></button>
    </div>
    <form className="career-experience-form" onSubmit={save}>
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
          <div><input value={question.question} onChange={(event) => { markStructuredFieldEdited(); setQuestions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, question: event.target.value } : item)); }} placeholder="面试官问了什么？" aria-label={`第 ${index + 1} 个面试问题`} /><textarea rows={3} value={question.answer} onChange={(event) => { markStructuredFieldEdited(); setQuestions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, answer: event.target.value } : item)); }} placeholder="我是怎么回答的？" aria-label={`第 ${index + 1} 个问题的回答`} /><input value={question.note} onChange={(event) => { markStructuredFieldEdited(); setQuestions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, note: event.target.value } : item)); }} placeholder="追问、反馈或可以改进的地方" aria-label={`第 ${index + 1} 个问题的备注`} /></div>
          <button type="button" onClick={() => { markStructuredFieldEdited(); setQuestions((current) => current.filter((_, itemIndex) => itemIndex !== index)); }} aria-label={`删除第 ${index + 1} 个问题`}><Trash2 size={15} /></button>
        </article>)}
      </div>
      <Field label="复盘与下一步"><textarea rows={5} value={reflection} onChange={(event) => { markStructuredFieldEdited(); setReflection(event.target.value); }} placeholder="哪些地方做得好？下一次会怎么回答？" /></Field>
      <div className="career-form-actions sticky"><button type="button" className="career-button ghost" onClick={onClose}>取消</button><button className="career-button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{saving ? "正在保存…" : "保存面经"}</button></div>
    </form>
  </Drawer>;
}

function JobModal({ data, onClose, onSaved }: { data: CareerData; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setSaving(true); const form = new FormData(event.currentTarget); const id = newId("job"); const now = new Date().toISOString(); try { await runCareerBatch([{ sql: `INSERT INTO career_jobs (id,company,role,location,source,source_url,stage_id,priority,salary,work_mode,description,applied_at,deadline,contact_name,note,tags,created_at,updated_at,archived,position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0)`, params: [id, form.get("company"), form.get("role"), form.get("location"), form.get("source"), form.get("source_url"), form.get("stage_id"), Number(form.get("priority")), form.get("salary"), form.get("work_mode"), form.get("description"), form.get("stage_id") === "stage_applied" ? now : null, fromDateInput(String(form.get("deadline") || "")), "", form.get("note"), form.get("tags"), now, now] }, { sql: "INSERT INTO career_activity (id,job_id,type,detail,created_at) VALUES (?,?,?,?,?)", params: [newId("activity"), id, "create", `记录了 ${form.get("company")} · ${form.get("role")}`, now] }]); await onSaved(id); } finally { setSaving(false); } }
  return <Modal title="记录一个新职位" description="先写下关键信息，细节可以随时补充。" onClose={onClose} wide><form className="career-form" onSubmit={submit}><div className="career-form-row"><Field label="公司"><input name="company" required placeholder="例如：Linear" /></Field><Field label="职位"><input name="role" required placeholder="例如：Product Designer" /></Field></div><div className="career-form-row thirds"><Field label="当前阶段"><select name="stage_id" defaultValue="stage_saved">{data.stages.filter((stage) => !stage.is_terminal).map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></Field><Field label="优先级"><select name="priority" defaultValue="2"><option value="1">普通</option><option value="2">重点</option><option value="3">最高</option></select></Field><Field label="来源"><select name="source" defaultValue="手动记录"><option>手动记录</option><option>LinkedIn</option><option>BOSS直聘</option><option>官网</option><option>内推</option></select></Field></div><div className="career-form-row"><Field label="地点"><input name="location" placeholder="上海 / 远程" /></Field><Field label="工作方式"><select name="work_mode"><option value="">待确认</option><option>现场办公</option><option>混合办公</option><option>远程</option></select></Field></div><div className="career-form-row"><Field label="薪资"><input name="salary" placeholder="¥30k–45k / 月" /></Field><Field label="截止时间"><input name="deadline" type="datetime-local" /></Field></div><Field label="原职位链接"><input name="source_url" type="url" placeholder="https://" /></Field><Field label="标签" hint="用逗号分隔"><input name="tags" placeholder="AI, 产品设计, 远程" /></Field><Field label="职位描述"><textarea name="description" rows={5} placeholder="粘贴岗位职责和要求…" /></Field><Field label="个人备注"><textarea name="note" rows={3} placeholder="为什么感兴趣？下一步要确认什么？" /></Field><div className="career-form-actions"><button type="button" className="career-button ghost" onClick={onClose}>取消</button><button className="career-button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}保存职位</button></div></form></Modal>;
}

function TaskModal({ data, initialJobId, onClose, onSaved }: { data: CareerData; initialJobId: string | null; onClose: () => void; onSaved: () => Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await runCareerSql("INSERT INTO career_tasks (id,job_id,title,due_at,kind,priority,status,created_at) VALUES (?,?,?,?,?,?,?,?)", [newId("task"), form.get("job_id") || null, form.get("title"), fromDateInput(String(form.get("due_at") || "")), form.get("kind"), Number(form.get("priority")), "todo", new Date().toISOString()]); await onSaved(); }
  return <Modal title="新建待办" description="让下一步具体到时间与动作。" onClose={onClose}><form className="career-form" onSubmit={submit}><Field label="要完成什么"><input name="title" required placeholder="例如：发送面试感谢邮件" /></Field><Field label="关联职位"><select name="job_id" defaultValue={initialJobId ?? ""}><option value="">不关联职位</option>{data.jobs.map((job) => <option key={job.id} value={job.id}>{job.company} · {job.role}</option>)}</select></Field><div className="career-form-row"><Field label="截止时间"><input name="due_at" type="datetime-local" /></Field><Field label="类型"><select name="kind"><option>跟进</option><option>面试准备</option><option>材料</option><option>截止事项</option><option>其他</option></select></Field></div><Field label="优先级"><select name="priority" defaultValue="2"><option value="1">普通</option><option value="2">重点</option><option value="3">紧急</option></select></Field><div className="career-form-actions"><button type="button" className="career-button ghost" onClick={onClose}>取消</button><button className="career-button primary">创建待办</button></div></form></Modal>;
}

function InterviewModal({ data, onClose, onSaved }: { data: CareerData; onClose: () => void; onSaved: () => Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); const now = new Date().toISOString(); await runCareerSql(`INSERT INTO career_interviews (id,job_id,round_name,interview_type,scheduled_at,duration,interviewer,meeting_url,status,summary,raw_notes,questions_json,reflection,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [newId("interview"), form.get("job_id"), form.get("round_name"), form.get("interview_type"), fromDateInput(String(form.get("scheduled_at") || "")), Number(form.get("duration")), form.get("interviewer"), form.get("meeting_url"), "scheduled", "", "", "[]", "", now, now]); await onSaved(); }
  return <Modal title="安排面试轮次" description="时间、面试官和会议入口都放在一起。" onClose={onClose}><form className="career-form" onSubmit={submit}><Field label="关联职位"><select required name="job_id" defaultValue=""><option value="" disabled>选择职位</option>{data.jobs.map((job) => <option key={job.id} value={job.id}>{job.company} · {job.role}</option>)}</select></Field><div className="career-form-row"><Field label="轮次名称"><input name="round_name" required placeholder="技术二面" /></Field><Field label="形式"><select name="interview_type"><option>视频面试</option><option>电话沟通</option><option>现场面试</option><option>笔试复盘</option></select></Field></div><div className="career-form-row"><Field label="时间"><input name="scheduled_at" type="datetime-local" required /></Field><Field label="时长"><select name="duration" defaultValue="45"><option value="30">30 分钟</option><option value="45">45 分钟</option><option value="60">60 分钟</option><option value="90">90 分钟</option></select></Field></div><Field label="面试官"><input name="interviewer" placeholder="姓名 · 职位" /></Field><Field label="会议链接"><input name="meeting_url" type="url" placeholder="https://" /></Field><div className="career-form-actions"><button type="button" className="career-button ghost" onClick={onClose}>取消</button><button className="career-button primary">保存日程</button></div></form></Modal>;
}

function ContactModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await runCareerSql("INSERT INTO career_contacts (id,company,name,role,channel,email,phone,last_contact_at,next_follow_up,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [newId("contact"), form.get("company"), form.get("name"), form.get("role"), form.get("channel"), form.get("email"), form.get("phone"), fromDateInput(String(form.get("last_contact_at") || "")), fromDateInput(String(form.get("next_follow_up") || "")), form.get("notes"), new Date().toISOString()]); await onSaved(); }
  return <Modal title="添加联系人" description="记住关系，也记住下一次联系。" onClose={onClose}><form className="career-form" onSubmit={submit}><div className="career-form-row"><Field label="姓名"><input name="name" required /></Field><Field label="公司"><input name="company" required /></Field></div><div className="career-form-row"><Field label="职位 / 关系"><input name="role" placeholder="Recruiter / 内推人" /></Field><Field label="沟通渠道"><select name="channel"><option>LinkedIn</option><option>BOSS直聘</option><option>邮件</option><option>微信</option><option>电话</option></select></Field></div><div className="career-form-row"><Field label="邮箱"><input name="email" type="email" /></Field><Field label="电话"><input name="phone" /></Field></div><div className="career-form-row"><Field label="最近联系" hint="没联系过可以留空"><input name="last_contact_at" type="datetime-local" /></Field><Field label="下次跟进"><input name="next_follow_up" type="datetime-local" /></Field></div><Field label="备注"><textarea name="notes" rows={4} placeholder="怎么认识、聊过什么、需要跟进什么…" /></Field><div className="career-form-actions"><button type="button" className="career-button ghost" onClick={onClose}>取消</button><button className="career-button primary">保存联系人</button></div></form></Modal>;
}

function MaterialModal({ data, onClose, onSaved }: { data: CareerData; onClose: () => void; onSaved: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    const selected = form.get("attachment");
    const file = selected instanceof File && selected.size > 0 ? selected : null;
    let fileKey: string | null = null;
    try {
      const metadata = file ? await saveLocalFile("career", file, { originalName: file.name, mimeType: file.type, category: "career-material" }) : null;
      fileKey = metadata?.key ?? null;
      await runCareerSql("INSERT INTO career_materials (id,name,kind,version,updated_at,linked_job_id,status,notes,file_key,file_name,mime_type,byte_size) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [newId("material"), form.get("name"), form.get("kind"), form.get("version"), new Date().toISOString(), form.get("linked_job_id") || null, form.get("status"), form.get("notes"), metadata?.key ?? null, metadata?.originalName ?? null, metadata?.mimeType ?? null, metadata?.byteSize ?? null]);
      await onSaved();
    } catch (caught) {
      if (fileKey) await deleteLocalFile("career", fileKey).catch(() => undefined);
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
