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
  Archive, ArrowRight, ArrowUpRight, Bell, BookOpen,
  BriefcaseBusiness, CalendarDays, Check, CheckCircle2, ChevronRight,
  Circle, Clock3, Command, ContactRound, Download, ExternalLink,
  FileArchive, FileText, Filter, GripVertical, Import, Inbox,
  LayoutDashboard, ListTodo, LoaderCircle, Menu, MessageSquareText,
  PanelTop, Pencil, Phone, Plus, RotateCcw, Search, Settings,
  ShieldCheck, Sparkles, Target, Trash2, Upload, UserRound, UsersRound,
  WandSparkles, X, Zap,
} from "lucide-react";
import {
  FormEvent, ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState,
} from "react";
import Link from "next/link";
import {
  CAREER_LEGACY_DEMO_REVIEW_NEEDED, getCareerLegacyDemoResolution, initializeCareerDb,
  loadCareerData, newId, runCareerBatch, runCareerSql,
} from "@/lib/career/db";
import {
  archiveCareerContactSafely,
  createCareerContactSafely,
  createCareerContactTaskSafely,
  inspectCareerContactWrite,
  loadCareerContactDetail,
  loadCareerContactExpectedState,
  loadCareerContacts,
  recordCareerContactInteractionSafely,
  restoreCareerContactSafely,
  updateCareerContactSafely,
  CareerContactMutationError,
  type CareerContactDetail,
  type CareerContactExpectedState,
  type CareerContactWriteInspection,
  type CareerContactWriteReceipt,
  type CreateCareerContactSafeInput,
  type CreateCareerContactTaskSafeInput,
  type RecordCareerContactInteractionSafeInput,
} from "@/lib/career/contacts";
import {
  CareerActivationUncertainError,
  CareerCurrentGenerationChangedError,
  CareerDiscardUncertainError,
  CareerPrepareCleanupIncompleteError,
  CareerPrepareUncertainError,
  activatePreparedCareerRestore,
  discardPreparedCareerRestore,
  exportCompleteCareerBackup,
  inspectCareerRestoreActivation,
  prepareCareerBackupRestore,
  recoverCareerBackupPrepare,
  retryCareerPrepareCleanup,
  type CareerPrepareCleanupReceipt,
  type CareerPrepareRecoveryReceipt,
  type CareerRestoreReceipt,
  type CareerRestoreSummary,
} from "@/lib/career/backup";
import { createStructuredInterviewDraft } from "@/lib/career/interview-ai";
import {
  CAREER_INTERVIEW_PREP_SHARED_FIELDS,
  CAREER_REQUIREMENTS_SHARED_FIELDS,
  CAREER_STRUCTURE_INTERVIEW_SHARED_FIELDS,
  CareerAiPayloadValidationError,
  sanitizeCareerAiRequestPayload,
} from "@/lib/career/ai-payload";
import {
  commitPreparedCareerLifecycleChange,
  loadCareerLifecycleScope,
  prepareCareerLifecycleChange,
  type CareerLifecycleChoice,
  type CareerLifecycleImpactItem,
  type CareerLifecycleIntent,
  type CareerLifecycleScope,
  type CareerLifecycleSnapshot,
  type CareerPreparedLifecycleChange,
} from "@/lib/career/lifecycle";
import {
  CareerTaskError,
  careerTaskActions,
  type CareerTaskDetail,
} from "@/lib/career/tasks";
import {
  CareerImportCommitUncertainError,
  CareerImportError,
  commitCareerJobImports,
  createCareerJobImportPreview,
  fingerprintCareerImportSource,
  forkCareerJobImportPreview,
  inspectCareerImportCommit,
  parseCareerCsvImportPreview,
  reviseCareerJobImportPreview,
  type CareerImportCandidate,
  type CareerImportCandidateField,
  type CareerImportConfidenceLevel,
  type CareerImportWarning,
  type CareerJobImportPreview,
} from "@/lib/career/imports";
import { careerJobIsWatched, resolveCareerJobNextItem, type CareerJobNextItem } from "@/lib/career/calm-view";
import {
  CareerMaterialSaveError,
  inspectCareerMaterialSaveCleanup,
  inspectCareerMaterialSave,
  retryCareerMaterialSaveCleanup,
  saveCareerMaterial,
  type CareerMaterialSaveCleanupBlockedReason,
  type CareerMaterialSaveCleanupReceipt,
  type CareerMaterialSaveExpectedSnapshot,
  type CareerMaterialSaveInput,
} from "@/lib/career/material-save";
import {
  CareerMaterialDeletionError,
  deleteCareerMaterial,
  loadCareerMaterialDeletionState,
  type CareerMaterialDeletedFileAction,
  type CareerMaterialDeletionPendingReason,
  type CareerMaterialDeletionReceipt,
  type CareerMaterialDeletionState,
} from "@/lib/career/materials";
import { subscribeToCareerDataChanges, subscribeToCareerGenerationChanges } from "@/lib/career/lock";
import { createLocalFileObjectUrl } from "@/lib/local-db/files";
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
  { id: "analytics", label: "过程回顾", compact: "回顾", icon: BookOpen },
  { id: "settings", label: "设置", compact: "设置", icon: Settings },
];

const emptyData: CareerData = { stages: [], jobs: [], tasks: [], interviews: [], contacts: [], materials: [], activities: [] };
const emptyLifecycleSnapshot: CareerLifecycleSnapshot = { jobs: [], tasks: [], interviews: [] };
type CareerJobScope = Exclude<CareerLifecycleScope, "all">;

const CAREER_MATERIAL_SAVE_RECOVERY_PREFIX = "career.material-save-recovery.v1:";
const CAREER_MATERIAL_SAVE_RECOVERY_MAX_BYTES = 256 * 1024;
const CAREER_MATERIAL_ATTACHMENT_MAX_BYTES = 512 * 1024 * 1024;
const CAREER_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CAREER_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAREER_BACKUP_RECOVERY_PREFIX = "career.backup-recovery.v1:";
const CAREER_BACKUP_RECOVERY_MAX_BYTES = 256 * 1024;

type CareerBackupCandidateMode = "review" | "activation-check" | "discard-only";

type CareerBackupRecoveryTicket =
  | Readonly<{
      version: 1;
      kind: "prepare";
      receipt: CareerPrepareRecoveryReceipt;
      recordedAt: string;
    }>
  | Readonly<{
      version: 1;
      kind: "candidate";
      mode: CareerBackupCandidateMode;
      receipt: CareerRestoreReceipt;
      recordedAt: string;
    }>
  | Readonly<{
      version: 1;
      kind: "prepare-cleanup";
      receipt: CareerPrepareCleanupReceipt;
      recordedAt: string;
    }>
  | Readonly<{
      version: 1;
      kind: "refresh-only";
      receipt: CareerRestoreReceipt;
      recordedAt: string;
    }>;

type CareerBackupRecoveryEntry = Readonly<{
  storageKey: string;
  ticket: CareerBackupRecoveryTicket;
  persisted: boolean;
}>;

type CareerBackupFlow =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "preparing"; fileName: string }>
  | Readonly<{ phase: "checking"; title: string; text: string }>
  | Readonly<{ phase: "review"; receipt: CareerRestoreReceipt; message?: string }>
  | Readonly<{ phase: "activating"; receipt: CareerRestoreReceipt }>
  | Readonly<{ phase: "activation-check"; receipt: CareerRestoreReceipt; message: string }>
  | Readonly<{ phase: "discard-only"; receipt: CareerRestoreReceipt; message: string }>
  | Readonly<{ phase: "discarding"; receipt: CareerRestoreReceipt }>
  | Readonly<{ phase: "prepare-cleanup"; receipt: CareerPrepareCleanupReceipt; message: string }>
  | Readonly<{ phase: "cleaning"; receipt: CareerPrepareCleanupReceipt }>
  | Readonly<{ phase: "refresh-only"; receipt: CareerRestoreReceipt; message: string }>
  | Readonly<{ phase: "error"; title: string; message: string }>;

type CareerMaterialSaveRecoveryTicket =
  | Readonly<{
      version: 1;
      kind: "uncertain-save";
      materialId: string;
      expectedSnapshot: CareerMaterialSaveExpectedSnapshot;
      cleanupReceipt: CareerMaterialSaveCleanupReceipt | null;
      recordedAt: string;
    }>
  | Readonly<{
      version: 1;
      kind: "cleanup-only";
      cleanupReceipt: CareerMaterialSaveCleanupReceipt;
      recordedAt: string;
    }>;

type CareerMaterialSaveRecoveryEntry = Readonly<{
  ticket: CareerMaterialSaveRecoveryTicket;
  persisted: boolean;
}>;

function materialSaveRecoveryKey(ticket: CareerMaterialSaveRecoveryTicket) {
  if (ticket.kind === "cleanup-only") return `attachment:${ticket.cleanupReceipt.digest}`;
  if (ticket.cleanupReceipt) return `attachment:${ticket.cleanupReceipt.digest}`;
  return `save:${ticket.materialId}`;
}

function hasExactObjectKeys(value: object, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isRecoveryIdentifier(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 240 &&
    value === value.trim() && !Array.from(value).some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || point === 127;
    });
}

function isRecoveryText(value: unknown, maximum: number, allowNewlines = false) {
  return typeof value === "string" && Array.from(value).length <= maximum &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0) ?? 0;
      if (allowNewlines && (point === 9 || point === 10 || point === 13)) return false;
      return point <= 31 || point === 127;
    });
}

function isMaterialSaveExpectedSnapshot(value: unknown): value is CareerMaterialSaveExpectedSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactObjectKeys(value, [
    "name", "kind", "version", "updatedAt", "linkedJobId", "status", "notes", "attachment",
  ])) return false;
  const snapshot = value as Record<string, unknown>;
  if (!isRecoveryText(snapshot.name, 240) || !String(snapshot.name).trim() ||
    !isRecoveryText(snapshot.kind, 80) || !String(snapshot.kind).trim() ||
    !isRecoveryText(snapshot.version, 80) || !String(snapshot.version).trim() ||
    typeof snapshot.updatedAt !== "string" || !Number.isFinite(Date.parse(snapshot.updatedAt)) ||
    (snapshot.linkedJobId !== null && !isRecoveryIdentifier(snapshot.linkedJobId)) ||
    (snapshot.status !== "ready" && snapshot.status !== "draft" && snapshot.status !== "sent") ||
    !isRecoveryText(snapshot.notes, 20_000, true)) return false;
  if (snapshot.attachment === null) return true;
  if (!snapshot.attachment || typeof snapshot.attachment !== "object" || Array.isArray(snapshot.attachment) ||
    !hasExactObjectKeys(snapshot.attachment, ["originalName", "mimeType", "byteSize", "sha256"])) return false;
  const attachment = snapshot.attachment as Record<string, unknown>;
  return isRecoveryText(attachment.originalName, 255) && Boolean(String(attachment.originalName).trim()) &&
    isRecoveryText(attachment.mimeType, 127) && Boolean(String(attachment.mimeType).includes("/")) &&
    Number.isSafeInteger(attachment.byteSize) && Number(attachment.byteSize) > 0 &&
    Number(attachment.byteSize) <= CAREER_MATERIAL_ATTACHMENT_MAX_BYTES &&
    typeof attachment.sha256 === "string" && CAREER_SHA256_PATTERN.test(attachment.sha256);
}

function isMaterialCleanupReceipt(value: unknown): value is CareerMaterialSaveCleanupReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !hasExactObjectKeys(value, ["purpose", "version", "opaquePayload", "digest"])) return false;
  const receipt = value as Record<string, unknown>;
  return receipt.purpose === "career-material-save-cleanup" && receipt.version === 1 &&
    typeof receipt.opaquePayload === "string" && receipt.opaquePayload.length > 0 &&
    receipt.opaquePayload.length <= CAREER_MATERIAL_SAVE_RECOVERY_MAX_BYTES &&
    typeof receipt.digest === "string" && CAREER_SHA256_PATTERN.test(receipt.digest);
}

function isMaterialSaveRecoveryTicket(value: unknown): value is CareerMaterialSaveRecoveryTicket {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ticket = value as Record<string, unknown>;
  if (ticket.version !== 1 || typeof ticket.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(ticket.recordedAt))) return false;
  if (ticket.kind === "cleanup-only") {
    return hasExactObjectKeys(ticket, ["version", "kind", "cleanupReceipt", "recordedAt"]) &&
      isMaterialCleanupReceipt(ticket.cleanupReceipt);
  }
  return ticket.kind === "uncertain-save" &&
    hasExactObjectKeys(ticket, ["version", "kind", "materialId", "expectedSnapshot", "cleanupReceipt", "recordedAt"]) &&
    isRecoveryIdentifier(ticket.materialId) && isMaterialSaveExpectedSnapshot(ticket.expectedSnapshot) &&
    (ticket.cleanupReceipt === null || isMaterialCleanupReceipt(ticket.cleanupReceipt));
}

function readMaterialSaveRecoveryStorage() {
  const tickets: CareerMaterialSaveRecoveryTicket[] = [];
  const unreadableKeys: string[] = [];
  if (typeof window === "undefined") return { tickets, unreadableKeys, storageUnavailable: false };
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(CAREER_MATERIAL_SAVE_RECOVERY_PREFIX)) continue;
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw || raw.length > CAREER_MATERIAL_SAVE_RECOVERY_MAX_BYTES) throw new Error("invalid recovery size");
        const parsed: unknown = JSON.parse(raw);
        if (!isMaterialSaveRecoveryTicket(parsed)) throw new Error("invalid recovery ticket");
        if (key !== `${CAREER_MATERIAL_SAVE_RECOVERY_PREFIX}${materialSaveRecoveryKey(parsed)}`) throw new Error("misbound recovery key");
        tickets.push(parsed);
      } catch {
        unreadableKeys.push(key);
      }
    }
  } catch {
    return { tickets, unreadableKeys, storageUnavailable: true };
  }
  tickets.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  return { tickets, unreadableKeys, storageUnavailable: false };
}

function isBackupRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBackupIsoDate(value: unknown) {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isBackupGenerationId(value: unknown, allowLegacy = false) {
  return typeof value === "string" &&
    ((allowLegacy && value === "legacy") || CAREER_UUID_V4_PATTERN.test(value));
}

function isBackupAttachmentKeys(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 10_000 &&
    value.every((key) => typeof key === "string" && CAREER_UUID_V4_PATTERN.test(key)) &&
    new Set(value).size === value.length;
}

function isCareerRestoreSummary(value: unknown): value is CareerRestoreSummary {
  if (!isBackupRecord(value) || !hasExactObjectKeys(value, [
    "kind", "fileName", "byteSize", "databaseByteSize", "exportedAt",
    "sourceUserVersion", "canonicalUserVersion", "attachmentCount", "jobCount",
    "materialCount", "verification",
  ])) return false;
  return (value.kind === "complete-backup" || value.kind === "legacy-career-sqlite") &&
    (value.fileName === null || (typeof value.fileName === "string" && isRecoveryText(value.fileName, 512) && Boolean(value.fileName.trim()))) &&
    Number.isSafeInteger(value.byteSize) && Number(value.byteSize) >= 0 &&
    Number.isSafeInteger(value.databaseByteSize) && Number(value.databaseByteSize) > 0 &&
    (value.exportedAt === null || isBackupIsoDate(value.exportedAt)) &&
    Number.isSafeInteger(value.sourceUserVersion) && Number(value.sourceUserVersion) >= 0 &&
    Number.isSafeInteger(value.canonicalUserVersion) && Number(value.canonicalUserVersion) >= 0 &&
    Number.isSafeInteger(value.attachmentCount) && Number(value.attachmentCount) >= 0 &&
    value.jobCount === null && value.materialCount === null &&
    (value.verification === "container-and-payload-verified" || value.verification === "career-schema-verified");
}

function isCareerRestoreReceipt(value: unknown): value is CareerRestoreReceipt {
  if (!isBackupRecord(value) || !hasExactObjectKeys(value, [
    "version", "database", "generationId", "activationToken", "recoveryToken",
    "expectedCurrentGenerationId", "expectedCurrentSequence", "canonicalApplicationId",
    "canonicalUserVersion", "projectionSha256", "preparedAt", "summary",
    "stagedAttachmentKeys",
  ])) return false;
  return value.version === 1 && value.database === "zhiji" &&
    isBackupGenerationId(value.generationId) &&
    typeof value.activationToken === "string" && CAREER_SHA256_PATTERN.test(value.activationToken) &&
    typeof value.recoveryToken === "string" && CAREER_SHA256_PATTERN.test(value.recoveryToken) &&
    isBackupGenerationId(value.expectedCurrentGenerationId, true) &&
    Number.isSafeInteger(value.expectedCurrentSequence) && Number(value.expectedCurrentSequence) >= 0 &&
    Number.isSafeInteger(value.canonicalApplicationId) && Number(value.canonicalApplicationId) > 0 &&
    Number.isSafeInteger(value.canonicalUserVersion) && Number(value.canonicalUserVersion) >= 0 &&
    typeof value.projectionSha256 === "string" && CAREER_SHA256_PATTERN.test(value.projectionSha256) &&
    isBackupIsoDate(value.preparedAt) && isCareerRestoreSummary(value.summary) &&
    isBackupAttachmentKeys(value.stagedAttachmentKeys);
}

function isCareerPrepareRecoveryReceipt(value: unknown): value is CareerPrepareRecoveryReceipt {
  if (!isBackupRecord(value) || !hasExactObjectKeys(value, [
    "version", "database", "operationId", "generationId", "operationToken",
    "projectionSha256", "attachmentKeysSha256", "preparedAt", "summary",
    "stagedAttachmentKeys",
  ])) return false;
  return value.version === 1 && value.database === "zhiji" &&
    isBackupGenerationId(value.operationId) && value.generationId === value.operationId &&
    typeof value.operationToken === "string" && CAREER_SHA256_PATTERN.test(value.operationToken) &&
    typeof value.projectionSha256 === "string" && CAREER_SHA256_PATTERN.test(value.projectionSha256) &&
    typeof value.attachmentKeysSha256 === "string" && CAREER_SHA256_PATTERN.test(value.attachmentKeysSha256) &&
    isBackupIsoDate(value.preparedAt) && isCareerRestoreSummary(value.summary) &&
    isBackupAttachmentKeys(value.stagedAttachmentKeys);
}

function isCareerPrepareCleanupReceipt(value: unknown): value is CareerPrepareCleanupReceipt {
  if (!isBackupRecord(value) || !hasExactObjectKeys(value, [
    "version", "database", "operationId", "generationId", "operationToken",
    "projectionSha256", "attachmentKeysSha256", "stagedAttachmentKeys",
  ])) return false;
  return value.version === 1 && value.database === "zhiji" &&
    isBackupGenerationId(value.operationId) && value.generationId === value.operationId &&
    typeof value.operationToken === "string" && CAREER_SHA256_PATTERN.test(value.operationToken) &&
    typeof value.projectionSha256 === "string" && CAREER_SHA256_PATTERN.test(value.projectionSha256) &&
    typeof value.attachmentKeysSha256 === "string" && CAREER_SHA256_PATTERN.test(value.attachmentKeysSha256) &&
    isBackupAttachmentKeys(value.stagedAttachmentKeys);
}

function careerBackupRecoveryIdentity(ticket: CareerBackupRecoveryTicket) {
  return `operation:${ticket.receipt.generationId}`;
}

function careerBackupRecoveryStorageKey(ticket: CareerBackupRecoveryTicket) {
  return `${CAREER_BACKUP_RECOVERY_PREFIX}${careerBackupRecoveryIdentity(ticket)}`;
}

function isCareerBackupRecoveryTicket(value: unknown): value is CareerBackupRecoveryTicket {
  if (!isBackupRecord(value) || value.version !== 1 || !isBackupIsoDate(value.recordedAt)) return false;
  if (value.kind === "prepare") {
    return hasExactObjectKeys(value, ["version", "kind", "receipt", "recordedAt"]) &&
      isCareerPrepareRecoveryReceipt(value.receipt);
  }
  if (value.kind === "prepare-cleanup") {
    return hasExactObjectKeys(value, ["version", "kind", "receipt", "recordedAt"]) &&
      isCareerPrepareCleanupReceipt(value.receipt);
  }
  if (value.kind === "refresh-only") {
    return hasExactObjectKeys(value, ["version", "kind", "receipt", "recordedAt"]) &&
      isCareerRestoreReceipt(value.receipt);
  }
  return value.kind === "candidate" &&
    hasExactObjectKeys(value, ["version", "kind", "mode", "receipt", "recordedAt"]) &&
    (value.mode === "review" || value.mode === "activation-check" || value.mode === "discard-only") &&
    isCareerRestoreReceipt(value.receipt);
}

function careerBackupRecoveryPriority(ticket: CareerBackupRecoveryTicket) {
  if (ticket.kind === "refresh-only") return 0;
  if (ticket.kind === "candidate") {
    if (ticket.mode === "activation-check") return 1;
    if (ticket.mode === "discard-only") return 2;
    return 3;
  }
  return ticket.kind === "prepare-cleanup" ? 4 : 5;
}

function readCareerBackupRecoveryStorage() {
  const entries: CareerBackupRecoveryEntry[] = [];
  const unreadableKeys: string[] = [];
  if (typeof window === "undefined") return { entries, unreadableKeys, storageUnavailable: false };
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const storageKey = window.localStorage.key(index);
      if (!storageKey?.startsWith(CAREER_BACKUP_RECOVERY_PREFIX)) continue;
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw || raw.length > CAREER_BACKUP_RECOVERY_MAX_BYTES) throw new Error("invalid recovery size");
        const parsed: unknown = JSON.parse(raw);
        if (!isCareerBackupRecoveryTicket(parsed)) throw new Error("invalid recovery ticket");
        if (storageKey !== careerBackupRecoveryStorageKey(parsed)) throw new Error("misbound recovery key");
        entries.push({ storageKey, ticket: parsed, persisted: true });
      } catch {
        unreadableKeys.push(storageKey);
      }
    }
  } catch {
    return { entries, unreadableKeys, storageUnavailable: true };
  }
  entries.sort((left, right) =>
    careerBackupRecoveryPriority(left.ticket) - careerBackupRecoveryPriority(right.ticket) ||
    left.ticket.recordedAt.localeCompare(right.ticket.recordedAt));
  return { entries, unreadableKeys, storageUnavailable: false };
}

function formatCareerBackupBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "大小未确认";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const CAREER_AI_SHARED_FIELDS_BY_ACTION = Object.freeze({
  fit_analysis: CAREER_REQUIREMENTS_SHARED_FIELDS,
  interview_prep: CAREER_INTERVIEW_PREP_SHARED_FIELDS,
  structure_interview: CAREER_STRUCTURE_INTERVIEW_SHARED_FIELDS,
} satisfies Record<AiAction, readonly string[]>);

function isCareerAiClientAction(action: unknown): action is AiAction {
  return action === "fit_analysis" || action === "interview_prep" || action === "structure_interview";
}

function createCareerAiClientRequest(
  action: unknown,
  payload: unknown,
  sanitize: typeof sanitizeCareerAiRequestPayload = sanitizeCareerAiRequestPayload,
) {
  if (!isCareerAiClientAction(action)) {
    const error = new TypeError("This Career AI action is not available at the client boundary.");
    Object.defineProperty(error, "code", { value: "CAREER_AI_ACTION_NOT_ALLOWED" });
    throw error;
  }
  return Object.freeze({ action, payload: sanitize(action, payload) });
}

async function fetchCareerAiClientRequest(
  requestBody: ReturnType<typeof createCareerAiClientRequest>,
  signal: AbortSignal | undefined,
  request: typeof fetch = fetch,
) {
  return request("/api/ai/career", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
    signal,
  });
}

function careerAiDisclosureText(
  action: AiAction,
  fields: readonly string[] = CAREER_AI_SHARED_FIELDS_BY_ACTION[action],
) {
  const localOnly = action === "structure_interview" ? "；不发送面试状态、会议链接或职位备注" : "";
  return `发送给 DeepSeek：${fields.join("、")}${localOnly}。结果不会自动保存。`;
}

function careerAiClientIssueText(action: unknown, error: unknown) {
  if (error instanceof CareerAiPayloadValidationError && isCareerAiClientAction(action)) {
    if (action === "fit_analysis") return "请先补全公司、职位和职位描述，再拆解职位要求；这次没有发送任何内容。";
    if (action === "interview_prep") return "请先补全公司、职位和面试轮次，再生成面试准备；这次没有发送任何内容。";
    return "请先补全公司、职位和面试轮次，再整理面经；这次没有发送任何内容。";
  }
  const code = error !== null && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "CAREER_AI_ACTION_NOT_ALLOWED") return "这个 AI 功能尚未开放；这次没有发送任何内容。";
  return "这次无法整理要发送的内容；没有发送任何内容，请核对当前记录后再试。";
}

type CareerLifecycleDialogState =
  | { phase: "decision"; prepared: CareerPreparedLifecycleChange; choice: CareerLifecycleChoice | null; changed: boolean; error: string; rememberUndo: boolean }
  | { phase: "refresh-recovery"; prepared: CareerPreparedLifecycleChange; error: string; rememberUndo: boolean };

type CareerTaskSheetRequest = Readonly<{
  taskId: string;
  nonce: string;
  initialState?: "stale" | "refresh-only";
}>;

export async function runCareerTaskUiOnce<T>(pending: Set<string>, taskId: string, action: () => Promise<T>): Promise<T | undefined> {
  if (pending.has(taskId)) return undefined;
  pending.add(taskId);
  try { return await action(); }
  finally { pending.delete(taskId); }
}

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

function useCareerMobileLayout() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const sync = () => setMobile(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return mobile;
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

function formatAbsoluteDate(value: string | null) {
  if (!value) return "未安排时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间待确认";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "long", day: "numeric", weekday: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

function relativeDate(value: string | null, clock: number) {
  return formatCareerTaskDate(value, clock);
}

function localDayBounds(clock: number) {
  const start = new Date(clock);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

function localDayKey(value: string | number | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "invalid";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function resolveCareerTaskDateGroup(value: string | null, clock: number) {
  if (!value) return "unscheduled" as const;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "unscheduled" as const;
  const { start, end } = localDayBounds(clock);
  if (timestamp < start) return "past" as const;
  if (timestamp < end) return "today" as const;
  return "future" as const;
}

export function formatCareerTaskDate(value: string | null, clock: number) {
  if (!value) return "以后再说";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间待确认";
  const group = resolveCareerTaskDateGroup(value, clock);
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  if (group === "past") return `原计划 ${new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(date)} ${time}`;
  if (group === "today") return `今天 ${time}`;
  const tomorrow = new Date(clock);
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (localDayKey(date) === localDayKey(tomorrow)) return `明天 ${time}`;
  const sixDaysLater = new Date(clock);
  sixDaysLater.setHours(0, 0, 0, 0);
  sixDaysLater.setDate(sixDaysLater.getDate() + 6);
  if (date.getTime() <= sixDaysLater.getTime() + 86_400_000) {
    return `${new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date)} ${time}`;
  }
  return `${new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(date)} ${time}`;
}

function neutralActivityDetail(detail: string) {
  return detail.replace(/^推进至(?=「)/, "阶段改为");
}

export function projectCareerLifecycleScope(
  snapshot: CareerLifecycleSnapshot,
  stages: Stage[],
  scope: CareerLifecycleScope,
): CareerLifecycleSnapshot {
  if (scope === "all") return snapshot;
  const terminalStageIds = new Set(stages.filter((stage) => stage.is_terminal === 1).map((stage) => stage.id));
  const jobs = snapshot.jobs.filter((job) => {
    if (scope === "archived") return job.archived === 1;
    if (job.archived === 1) return false;
    return scope === "ended" ? terminalStageIds.has(job.stage_id) : !terminalStageIds.has(job.stage_id);
  });
  const jobIds = new Set(jobs.map((job) => job.id));
  return {
    jobs,
    tasks: snapshot.tasks.filter((task) => (scope === "active" && task.job_id === null) || (task.job_id !== null && jobIds.has(task.job_id))),
    interviews: snapshot.interviews.filter((interview) => jobIds.has(interview.job_id)),
  };
}

function careerJobContext(job: Job | undefined, stages: Stage[]) {
  if (!job) return "";
  if (job.archived === 1) return "职位已归档";
  return stages.some((stage) => stage.id === job.stage_id && stage.is_terminal === 1) ? "职位已结束" : "";
}

export function isCareerLifecyclePaused(item: Pick<Task | Interview, "status" | "cancellation_reason" | "lifecycle_operation_id">) {
  return item.status === "canceled" && item.lifecycle_operation_id !== null &&
    (item.cancellation_reason === "job_ended" || item.cancellation_reason === "job_archived");
}

async function loadCareerUiState(scope: CareerJobScope) {
  const [base, all, scoped] = await Promise.all([
    loadCareerData(),
    loadCareerLifecycleScope("all"),
    loadCareerLifecycleScope(scope),
  ]);
  return { base, all, scoped };
}

export function resolveCareerTodayFocus(data: CareerData, now: number) {
  const terminalStages = new Set(data.stages.filter((stage) => stage.is_terminal === 1).map((stage) => stage.id));
  const eligibleJobs = data.jobs.filter((job) => job.archived !== 1 && !terminalStages.has(job.stage_id));
  const eligibleJobsById = new Map(eligibleJobs.map((job) => [job.id, job]));
  const { start: startOfToday, end: endOfToday } = localDayBounds(now);

  const interview = data.interviews
    .filter((item) => {
      const scheduledAt = item.scheduled_at ? new Date(item.scheduled_at).getTime() : Number.NaN;
      return item.status === "scheduled" && eligibleJobsById.has(item.job_id) &&
        Number.isFinite(scheduledAt) && scheduledAt >= now && scheduledAt < endOfToday;
    })
    .sort((left, right) => new Date(left.scheduled_at!).getTime() - new Date(right.scheduled_at!).getTime())[0];
  if (interview) return { kind: "interview" as const, interviewId: interview.id, jobId: interview.job_id };

  const task = data.tasks
    .filter((item) => {
      if (item.status !== "todo" || (item.job_id && !eligibleJobsById.has(item.job_id)) || !item.due_at) return false;
      const scheduledAt = new Date(item.due_at).getTime();
      return Number.isFinite(scheduledAt) && scheduledAt >= startOfToday && scheduledAt < endOfToday;
    })
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

type CareerCapturedSource = Readonly<{ url: string; selectedText: string }>;

function readCaptureParams(): CareerCapturedSource | null {
  if (typeof window === "undefined") return null;
  const params = new URL(window.location.href).searchParams;
  const capture = {
    url: params.get("capture")?.trim() ?? "",
    selectedText: params.get("text")?.trim() ?? "",
  };
  return capture.url || capture.selectedText ? capture : null;
}

const dialogFocusable = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

function useDialogA11y(onClose: () => void, inertToasts = false) {
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
        if (!(child instanceof HTMLElement) || child === layer || (!inertToasts && child.classList.contains("career-toast-stack"))) return;
        inertState.set(child, child.inert);
        child.inert = true;
      });
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      const initial = dialog.querySelector<HTMLElement>("[data-dialog-initial]:not([disabled])")
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
      if (!(document.activeElement instanceof HTMLElement) || !items.includes(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
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
  }, [inertToasts]);

  return dialogRef;
}

type CareerContactUndoState = Readonly<{
  id: string;
  name: string;
  expected: CareerContactExpectedState;
  phase: "ready" | "writing" | "refresh-only";
  message: string;
}>;

export default function CareerApp() {
  const careerClock = useCareerClock();
  const mobileLayout = useCareerMobileLayout();
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
  const [jobScope, setJobScope] = useState<CareerJobScope>("active");
  const [allLifecycle, setAllLifecycle] = useState<CareerLifecycleSnapshot>(emptyLifecycleSnapshot);
  const [scopedLifecycle, setScopedLifecycle] = useState<CareerLifecycleSnapshot>(emptyLifecycleSnapshot);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [scopeError, setScopeError] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [capturedDraft] = useState(readCaptureParams);
  const [modal, setModal] = useState<"job" | "task" | "interview" | "material" | "import" | null>(() => capturedDraft ? "import" : null);
  const [importInitial, setImportInitial] = useState<CareerCapturedSource | null>(capturedDraft);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedInterviewId, setSelectedInterviewId] = useState<string | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [materialRemoval, setMaterialRemoval] = useState<Pick<Material, "id" | "name" | "file_key"> | null>(null);
  const [materialListStale, setMaterialListStale] = useState(false);
  const [materialRefreshBusy, setMaterialRefreshBusy] = useState(false);
  const [materialRecoveryLoaded, setMaterialRecoveryLoaded] = useState(false);
  const [materialRecoveryStorageUnavailable, setMaterialRecoveryStorageUnavailable] = useState(false);
  const [materialRecoveryUnreadableKeys, setMaterialRecoveryUnreadableKeys] = useState<string[]>([]);
  const [persistedMaterialRecoveries, setPersistedMaterialRecoveries] = useState<CareerMaterialSaveRecoveryTicket[]>([]);
  const [volatileMaterialRecoveries, setVolatileMaterialRecoveries] = useState<CareerMaterialSaveRecoveryTicket[]>([]);
  const [contactEditorId, setContactEditorId] = useState<string | null | undefined>(undefined);
  const [contactAction, setContactAction] = useState<{ kind: "interaction" | "task"; contactId: string } | null>(null);
  const [contactRevision, setContactRevision] = useState(0);
  const [contactUndo, setContactUndo] = useState<CareerContactUndoState | null>(null);
  const [contactDataHint, setContactDataHint] = useState("");
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [undo, setUndo] = useState<{ jobId: string; from: string; to: string } | null>(null);
  const [taskSheet, setTaskSheet] = useState<CareerTaskSheetRequest | null>(null);
  const [lifecycleDialog, setLifecycleDialog] = useState<CareerLifecycleDialogState | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecyclePendingJobId, setLifecyclePendingJobId] = useState<string | null>(null);
  const [aiState, setAiState] = useState<{ action: AiAction; title: string; loading: boolean; result?: unknown; error?: string; applyLabel?: string; onApply?: (result: unknown) => void | Promise<void> } | null>(null);
  const aiRequestRef = useRef<{ id: string; controller: AbortController } | null>(null);
  const jobScopeRef = useRef<CareerJobScope>("active");
  const lifecycleTriggerRef = useRef<HTMLElement | null>(null);
  const lifecycleWriteRef = useRef(false);
  const taskCompletionRef = useRef(new Set<string>());
  const lifecycleRefreshOnlyRef = useRef(false);
  const scopeRequestRef = useRef(0);
  const uiReadRequestRef = useRef(0);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const importOpenerRef = useRef<HTMLButtonElement | null>(null);
  const importFocusReturnPendingRef = useRef(false);
  const materialRemovalOpenerRef = useRef<HTMLButtonElement | null>(null);
  const materialRemovalFocusPendingRef = useRef(false);
  const materialModalFocusPendingRef = useRef(false);
  const materialStaleFocusPendingRef = useRef(false);
  const materialRefreshRef = useRef(false);
  const contactUndoWriteRef = useRef(false);
  const contactRemovalFocusRef = useRef<HTMLElement | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const materialSaveRecoveryEntries = useMemo<CareerMaterialSaveRecoveryEntry[]>(() => {
    const entries = new Map<string, CareerMaterialSaveRecoveryEntry>();
    persistedMaterialRecoveries.forEach((ticket) => entries.set(materialSaveRecoveryKey(ticket), { ticket, persisted: true }));
    volatileMaterialRecoveries.forEach((ticket) => {
      const key = materialSaveRecoveryKey(ticket);
      if (!entries.has(key)) entries.set(key, { ticket, persisted: false });
    });
    return Array.from(entries.values()).sort((left, right) => left.ticket.recordedAt.localeCompare(right.ticket.recordedAt));
  }, [persistedMaterialRecoveries, volatileMaterialRecoveries]);

  const reloadMaterialSaveRecoveries = useCallback(() => {
    const stored = readMaterialSaveRecoveryStorage();
    const storedKeys = new Set(stored.tickets.map(materialSaveRecoveryKey));
    setPersistedMaterialRecoveries(stored.tickets);
    setVolatileMaterialRecoveries((current) => current.filter((ticket) => !storedKeys.has(materialSaveRecoveryKey(ticket))));
    setMaterialRecoveryUnreadableKeys(stored.unreadableKeys);
    setMaterialRecoveryStorageUnavailable(stored.storageUnavailable);
    setMaterialRecoveryLoaded(true);
  }, []);

  const persistMaterialSaveRecovery = useCallback((ticket: CareerMaterialSaveRecoveryTicket) => {
    const logicalKey = materialSaveRecoveryKey(ticket);
    const storageKey = `${CAREER_MATERIAL_SAVE_RECOVERY_PREFIX}${logicalKey}`;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(ticket));
      setPersistedMaterialRecoveries((current) => [...current.filter((item) => materialSaveRecoveryKey(item) !== logicalKey), ticket]);
      setVolatileMaterialRecoveries((current) => current.filter((item) => materialSaveRecoveryKey(item) !== logicalKey));
      setMaterialRecoveryUnreadableKeys((current) => current.filter((key) => key !== storageKey));
      setMaterialRecoveryStorageUnavailable(false);
      return true;
    } catch {
      setVolatileMaterialRecoveries((current) => [...current.filter((item) => materialSaveRecoveryKey(item) !== logicalKey), ticket]);
      setMaterialRecoveryStorageUnavailable(true);
      return false;
    }
  }, []);

  const clearMaterialSaveRecovery = useCallback((ticket: CareerMaterialSaveRecoveryTicket, persisted: boolean) => {
    const logicalKey = materialSaveRecoveryKey(ticket);
    const storageKey = `${CAREER_MATERIAL_SAVE_RECOVERY_PREFIX}${logicalKey}`;
    if (!persisted) {
      try { window.localStorage.removeItem(storageKey); } catch { /* No durable entry was created for this volatile ticket. */ }
      setVolatileMaterialRecoveries((current) => current.filter((item) => materialSaveRecoveryKey(item) !== logicalKey));
      setPersistedMaterialRecoveries((current) => current.filter((item) => materialSaveRecoveryKey(item) !== logicalKey));
      return true;
    }
    try {
      window.localStorage.removeItem(storageKey);
      setPersistedMaterialRecoveries((current) => current.filter((item) => materialSaveRecoveryKey(item) !== logicalKey));
      setVolatileMaterialRecoveries((current) => current.filter((item) => materialSaveRecoveryKey(item) !== logicalKey));
      setMaterialRecoveryUnreadableKeys((current) => current.filter((key) => key !== storageKey));
      return true;
    } catch {
      setMaterialRecoveryStorageUnavailable(true);
      return false;
    }
  }, []);

  const refresh = useCallback(async (requestedScope: CareerJobScope = jobScopeRef.current) => {
    const requestToken = ++uiReadRequestRef.current;
    const next = await loadCareerUiState(requestedScope);
    if (uiReadRequestRef.current !== requestToken) return false;
    setData(next.base);
    setAllLifecycle(next.all);
    if (jobScopeRef.current === requestedScope) setScopedLifecycle(next.scoped);
    return true;
  }, []);
  const requireRefresh = useCallback(async (requestedScope: CareerJobScope = jobScopeRef.current) => {
    if (!await refresh(requestedScope)) throw new Error("A newer Career read superseded this refresh.");
  }, [refresh]);
  const refreshContacts = useCallback(async () => {
    await requireRefresh();
    setContactRevision((current) => current + 1);
    setContactDataHint("");
  }, [requireRefresh]);
  const refreshTasks = useCallback(async () => {
    await requireRefresh();
    setContactRevision((current) => current + 1);
  }, [requireRefresh]);

  useEffect(() => {
    let live = true;
    async function boot() {
      const requestToken = ++uiReadRequestRef.current;
      try {
        await initializeCareerDb();
        const requestedScope = jobScopeRef.current;
        const next = await loadCareerUiState(requestedScope);
        const legacyResolution = await getCareerLegacyDemoResolution().catch(() => "none" as const);
        if (live && uiReadRequestRef.current === requestToken) {
          setData(next.base);
          setAllLifecycle(next.all);
          setScopedLifecycle(next.scoped);
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

  useEffect(() => {
    reloadMaterialSaveRecoveries();
    function handleRecoveryStorage(event: StorageEvent) {
      if (event.key === null || event.key.startsWith(CAREER_MATERIAL_SAVE_RECOVERY_PREFIX)) reloadMaterialSaveRecoveries();
    }
    window.addEventListener("storage", handleRecoveryStorage);
    window.addEventListener("focus", reloadMaterialSaveRecoveries);
    return () => {
      window.removeEventListener("storage", handleRecoveryStorage);
      window.removeEventListener("focus", reloadMaterialSaveRecoveries);
    };
  }, [reloadMaterialSaveRecoveries]);

  useEffect(() => {
    if (volatileMaterialRecoveries.length === 0) return;
    function protectVolatileMaterialRecovery(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", protectVolatileMaterialRecovery);
    return () => window.removeEventListener("beforeunload", protectVolatileMaterialRecovery);
  }, [volatileMaterialRecoveries.length]);

  useEffect(() => {
    if (modal === "import" || !importFocusReturnPendingRef.current) return;
    importFocusReturnPendingRef.current = false;
    const opener = importOpenerRef.current;
    const focusFrame = window.requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      importOpenerRef.current = null;
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [modal]);

  useEffect(() => {
    if (materialRemoval || !materialRemovalFocusPendingRef.current) return;
    materialRemovalFocusPendingRef.current = false;
    const opener = materialRemovalOpenerRef.current;
    const focusFrame = window.requestAnimationFrame(() => {
      const fallback = document.querySelector<HTMLButtonElement>("[data-material-refresh]") ?? document.querySelector<HTMLButtonElement>("[data-material-add]");
      if (opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
      else fallback?.focus({ preventScroll: true });
      materialRemovalOpenerRef.current = null;
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [materialRemoval]);

  useEffect(() => {
    if (modal === "material" || !materialModalFocusPendingRef.current || materialListStale) return;
    materialModalFocusPendingRef.current = false;
    const focusFrame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLButtonElement>("[data-material-recover]") ??
        document.querySelector<HTMLButtonElement>("[data-material-recovery-clear]") ??
        document.querySelector<HTMLButtonElement>("[data-material-add]:not(:disabled)") ??
        document.querySelector<HTMLButtonElement>(".career-material-actions button:not(:disabled)");
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [materialListStale, modal]);

  useEffect(() => {
    if (!materialListStale || !materialStaleFocusPendingRef.current || modal === "material" || materialRemoval) return;
    materialStaleFocusPendingRef.current = false;
    const focusFrame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>("[data-material-refresh]")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [materialListStale, materialRemoval, modal]);

  useEffect(() => subscribeToCareerGenerationChanges(() => window.location.reload()), []);

  useEffect(() => subscribeToCareerDataChanges((reason) => {
    if (!reason.startsWith("career-contact")) return;
    if (contactEditorId !== undefined || contactAction) {
      setContactDataHint("联系人资料刚在另一个页面发生了变化。当前输入没有被替换；保存时会先核对版本。");
      return;
    }
    if (view === "contacts" || selectedContactId || contactUndo) {
      void refreshContacts().catch(() => {
        setContactDataHint("另一个页面更新了联系人，但这里暂时没有重新读到。现有画面没有被当成最新版本。");
      });
    }
  }), [contactAction, contactEditorId, contactUndo, refreshContacts, selectedContactId, view]);

  useEffect(() => {
    function refreshVisibleContactsOnFocus() {
      if (contactEditorId !== undefined || contactAction) return;
      if (view !== "contacts" && !selectedContactId && !contactUndo) return;
      void refreshContacts().catch(() => {
        setContactDataHint("回到页面后暂时没有重新读到联系人资料；现有画面没有被当成最新版本。");
      });
    }
    window.addEventListener("focus", refreshVisibleContactsOnFocus);
    return () => window.removeEventListener("focus", refreshVisibleContactsOnFocus);
  }, [contactAction, contactEditorId, contactUndo, refreshContacts, selectedContactId, view]);

  useEffect(() => {
    if (!contactUndo || contactUndo.phase !== "ready") return;
    const timer = window.setTimeout(() => setContactUndo(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [contactUndo]);

  useEffect(() => {
    if (selectedContactId || !contactRemovalFocusRef.current) return;
    const target = contactRemovalFocusRef.current;
    contactRemovalFocusRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      if (target.isConnected) target.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>(".career-segmented button[aria-pressed='true'], #career-page-title")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedContactId, contactRevision]);

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
      if (document.querySelector('[aria-modal="true"]')) return;
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

  async function refreshMaterials() {
    if (materialRefreshRef.current) return;
    materialRefreshRef.current = true;
    const restoreMaterialFocus = document.activeElement?.matches("[data-material-refresh]") ?? false;
    setMaterialRefreshBusy(true);
    try {
      await requireRefresh();
      setMaterialListStale(false);
      if (restoreMaterialFocus) {
        notify("材料列表已更新。", "info");
        window.requestAnimationFrame(() => {
          const target = document.querySelector<HTMLButtonElement>("[data-material-recover]") ??
            document.querySelector<HTMLButtonElement>("[data-material-recovery-clear]") ??
            document.querySelector<HTMLButtonElement>("[data-material-add]:not(:disabled)") ??
            document.querySelector<HTMLButtonElement>(".career-material-actions button:not(:disabled)");
          target?.focus({ preventScroll: true });
        });
      }
    } finally {
      materialRefreshRef.current = false;
      setMaterialRefreshBusy(false);
    }
  }

  function clearUnreadableMaterialRecoveryEntries() {
    let failed = false;
    for (const key of materialRecoveryUnreadableKeys) {
      try { window.localStorage.removeItem(key); }
      catch { failed = true; }
    }
    if (failed) {
      setMaterialRecoveryStorageUnavailable(true);
      notify("浏览器暂时无法清除这条提醒；没有自动删除任何原件。", "error");
      return;
    }
    setMaterialRecoveryUnreadableKeys([]);
    notify("无法读取的收尾提醒已清除；没有自动删除任何原件。", "info");
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>("[data-material-add]:not(:disabled)")?.focus({ preventScroll: true });
    });
  }

  function retryMaterialRecoveryStorage() {
    reloadMaterialSaveRecoveries();
    window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLButtonElement>("[data-material-recovery-retry]") ??
        document.querySelector<HTMLButtonElement>("[data-material-recover]") ??
        document.querySelector<HTMLButtonElement>("[data-material-recovery-clear]") ??
        document.querySelector<HTMLButtonElement>("[data-material-add]:not(:disabled)");
      target?.focus({ preventScroll: true });
    });
  }

  function closeMaterialWithStaleList() {
    materialModalFocusPendingRef.current = false;
    materialStaleFocusPendingRef.current = true;
    setMaterialListStale(true);
    setModal(null);
  }

  function closeMaterialModal() {
    materialModalFocusPendingRef.current = true;
    setModal(null);
  }

  function closeRemovalWithStaleList() {
    setMaterialListStale(true);
    closeMaterialRemoval();
  }

  const activeLifecycle = useMemo(
    () => projectCareerLifecycleScope(allLifecycle, data.stages, "active"),
    [allLifecycle, data.stages],
  );
  const allData = useMemo<CareerData>(() => ({
    ...data,
    jobs: allLifecycle.jobs,
    tasks: allLifecycle.tasks,
    interviews: allLifecycle.interviews,
  }), [allLifecycle, data]);
  const boardData = useMemo<CareerData>(() => ({
    ...data,
    jobs: activeLifecycle.jobs,
    tasks: activeLifecycle.tasks,
    interviews: activeLifecycle.interviews,
  }), [activeLifecycle, data]);
  const scopedData = useMemo<CareerData>(() => ({
    ...data,
    jobs: scopedLifecycle.jobs,
    tasks: scopedLifecycle.tasks,
    interviews: scopedLifecycle.interviews,
  }), [data, scopedLifecycle]);

  const filterJobs = useCallback((jobs: Job[]) => {
    const needle = query.trim().toLowerCase();
    return jobs.filter((job) => {
      const matchesText = !needle || [job.company, job.role, job.location, job.tags, job.note].join(" ").toLowerCase().includes(needle);
      return matchesText && (stageFilter === "all" || job.stage_id === stageFilter) &&
        (sourceFilter === "all" || job.source === sourceFilter) && (!priorityOnly || careerJobIsWatched(job.priority));
    });
  }, [priorityOnly, query, sourceFilter, stageFilter]);
  const boardJobs = useMemo(() => filterJobs(activeLifecycle.jobs), [activeLifecycle.jobs, filterJobs]);
  const scopedJobs = useMemo(() => filterJobs(scopedLifecycle.jobs), [filterJobs, scopedLifecycle.jobs]);

  const selectedJob = allLifecycle.jobs.find((job) => job.id === selectedJobId) ?? null;
  const selectedInterview = allLifecycle.interviews.find((item) => item.id === selectedInterviewId) ?? null;
  const activeJob = activeLifecycle.jobs.find((job) => job.id === activeDragId) ?? null;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }));
  const lifecycleLocked = lifecyclePendingJobId !== null || lifecycleBusy || lifecycleDialog !== null || lifecycleRefreshOnlyRef.current;

  function lifecycleDefaultChoice(prepared: CareerPreparedLifecycleChange) {
    return prepared.requiresChoice ? null : prepared.allowedChoices[0] ?? null;
  }

  function focusAfterLifecycle() {
    window.requestAnimationFrame(() => {
      const trigger = lifecycleTriggerRef.current;
      if (trigger?.isConnected) { trigger.focus(); return; }
      const scopeControl = document.querySelector<HTMLElement>(`[data-career-scope="${jobScopeRef.current}"]`);
      (scopeControl ?? document.getElementById("career-page-title"))?.focus();
    });
  }

  function updateLifecycleUndo(prepared: CareerPreparedLifecycleChange, rememberUndo: boolean) {
    if (
      rememberUndo &&
      prepared.transition === "active-to-active" &&
      prepared.intent.kind === "stage" &&
      prepared.job.nextStage
    ) {
      setUndo({
        jobId: prepared.job.id,
        from: prepared.job.currentStage.id,
        to: prepared.job.nextStage.id,
      });
      return;
    }
    setUndo(null);
  }

  async function finishPreparedLifecycle(
    prepared: CareerPreparedLifecycleChange,
    choice: CareerLifecycleChoice,
    rememberUndo = true,
  ) {
    setLifecycleBusy(true);
    setLifecyclePendingJobId(prepared.job.id);
    try {
      const result = await commitPreparedCareerLifecycleChange(prepared, choice);
      if (result.status === "changed") {
        setLifecycleDialog({
          phase: "decision",
          prepared: result.prepared,
          choice: lifecycleDefaultChoice(result.prepared),
          changed: true,
          error: "",
          rememberUndo,
        });
        return false;
      }

      lifecycleRefreshOnlyRef.current = true;
      try {
        await requireRefresh();
      } catch {
        setLifecycleDialog({
          phase: "refresh-recovery",
          prepared,
          error: "更改已保存在本机，页面暂未重新读取，请不要重复提交。",
          rememberUndo,
        });
        return false;
      }
      lifecycleRefreshOnlyRef.current = false;
      setLifecycleDialog(null);
      updateLifecycleUndo(prepared, rememberUndo);
      focusAfterLifecycle();
      return true;
    } catch (error) {
      setLifecycleDialog({
        phase: "decision",
        prepared,
        choice,
        changed: false,
        error: error instanceof Error ? `更改没有保存。${error.message}` : "更改没有保存，请检查后重试。",
        rememberUndo,
      });
      return false;
    } finally {
      setLifecycleBusy(false);
      setLifecyclePendingJobId(null);
    }
  }

  async function requestLifecycleChange(
    intent: CareerLifecycleIntent,
    options: { rememberUndo?: boolean; choice?: CareerLifecycleChoice; expectedUndo?: { from: string; to: string } } = {},
  ) {
    if (lifecycleWriteRef.current || lifecycleRefreshOnlyRef.current) return false;
    const currentJob = allLifecycle.jobs.find((job) => job.id === intent.jobId);
    if (!currentJob) {
      notify("职位记录刚有变化，请重新打开后再试。", "info");
      return false;
    }
    if (
      (intent.kind === "stage" && currentJob.stage_id === intent.nextStageId) ||
      (intent.kind === "archive" && currentJob.archived === 1) ||
      (intent.kind === "restore" && currentJob.archived !== 1)
    ) return true;
    lifecycleWriteRef.current = true;
    lifecycleTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLifecyclePendingJobId(intent.jobId);
    try {
      const prepared = await prepareCareerLifecycleChange(intent);
      if (options.expectedUndo && (
        prepared.transition !== "active-to-active" ||
        prepared.job.currentStage.id !== options.expectedUndo.to ||
        prepared.job.nextStage?.id !== options.expectedUndo.from
      )) {
        setUndo(null);
        notify("职位状态已经变化，这次撤销已失效。", "info");
        return false;
      }
      const direct = !prepared.requiresChoice &&
        (prepared.transition === "active-to-active" || prepared.transition === "terminal-to-terminal");
      const requestedChoice = options.choice;
      const choice = requestedChoice && prepared.allowedChoices.includes(requestedChoice)
        ? requestedChoice
        : lifecycleDefaultChoice(prepared);
      if (direct && choice) return await finishPreparedLifecycle(prepared, choice, options.rememberUndo !== false);
      setLifecycleDialog({ phase: "decision", prepared, choice, changed: false, error: "", rememberUndo: options.rememberUndo !== false });
      return false;
    } catch (error) {
      notify(error instanceof Error ? error.message : "暂时无法读取这次变更的影响", "error");
      return false;
    } finally {
      lifecycleWriteRef.current = false;
      setLifecyclePendingJobId(null);
    }
  }

  async function confirmLifecycleChange() {
    if (!lifecycleDialog || lifecycleDialog.phase !== "decision" || !lifecycleDialog.choice || lifecycleWriteRef.current || lifecycleRefreshOnlyRef.current) return;
    lifecycleWriteRef.current = true;
    try { await finishPreparedLifecycle(lifecycleDialog.prepared, lifecycleDialog.choice, lifecycleDialog.rememberUndo); }
    finally { lifecycleWriteRef.current = false; }
  }

  async function retryLifecycleRefresh() {
    if (!lifecycleDialog || lifecycleDialog.phase !== "refresh-recovery" || lifecycleWriteRef.current) return;
    lifecycleWriteRef.current = true;
    setLifecycleBusy(true);
    try {
      await requireRefresh();
      lifecycleRefreshOnlyRef.current = false;
      updateLifecycleUndo(lifecycleDialog.prepared, lifecycleDialog.rememberUndo);
      setLifecycleDialog(null);
      focusAfterLifecycle();
    } catch {
      setLifecycleDialog((current) => current?.phase === "refresh-recovery" ? {
        ...current,
        error: "更改仍已保存在本机，页面还没有重新读取。请只重试刷新，不要重复提交。",
      } : current);
    } finally {
      lifecycleWriteRef.current = false;
      setLifecycleBusy(false);
    }
  }

  async function handleUndo() {
    if (!undo || lifecycleWriteRef.current || lifecycleRefreshOnlyRef.current) return;
    const item = undo;
    const currentJob = allLifecycle.jobs.find((job) => job.id === item.jobId);
    const currentStage = data.stages.find((stage) => stage.id === currentJob?.stage_id);
    if (!currentJob || currentJob.archived === 1 || currentStage?.is_terminal === 1 || currentJob.stage_id !== item.to) {
      setUndo(null);
      notify("职位状态已经变化，这次撤销已失效。", "info");
      return;
    }
    const restored = await requestLifecycleChange(
      { kind: "stage", jobId: item.jobId, nextStageId: item.from },
      { rememberUndo: false, choice: "keep", expectedUndo: item },
    );
    if (restored) { setUndo(null); notify("已恢复到原阶段", "info"); }
  }

  function openTask(taskId: string, initialState?: CareerTaskSheetRequest["initialState"]) {
    setTaskSheet({ taskId, initialState, nonce: crypto.randomUUID() });
  }

  async function completeTask(task: Task) {
    if (task.status !== "todo") { openTask(task.id); return; }
    const expectedUpdatedAt = task.updated_at;
    if (!expectedUpdatedAt) { openTask(task.id, "stale"); return; }
    await runCareerTaskUiOnce(taskCompletionRef.current, task.id, async () => {
      let committed = false;
      try {
        await careerTaskActions.complete(task.id, {
          expectedUpdatedAt,
          operationId: `task_complete_${crypto.randomUUID()}`,
        });
        committed = true;
        await refreshTasks();
        notify(`已完成「${task.title}」`, "info");
      } catch (error) {
        if (committed) {
          openTask(task.id, "refresh-only");
          return;
        }
        if (error instanceof CareerTaskError && error.code === "changed") {
          openTask(task.id, "stale");
          return;
        }
        notify(error instanceof Error ? error.message : "这次更改没有保存，原记录仍保持不变。", "error");
      }
    });
  }

  async function changeJobScope(nextScope: CareerJobScope) {
    if (nextScope === jobScopeRef.current || scopeLoading) return;
    const requestToken = ++scopeRequestRef.current;
    const uiReadToken = ++uiReadRequestRef.current;
    setScopeLoading(true);
    setScopeError("");
    try {
      const next = await loadCareerUiState(nextScope);
      if (scopeRequestRef.current !== requestToken || uiReadRequestRef.current !== uiReadToken) return;
      jobScopeRef.current = nextScope;
      setJobScope(nextScope);
      setStageFilter("all");
      setSourceFilter("all");
      setData(next.base);
      setAllLifecycle(next.all);
      setScopedLifecycle(next.scoped);
    } catch {
      if (scopeRequestRef.current === requestToken) setScopeError("这个职位范围暂时没有打开。原来的记录仍保留在画面上，可以稍后重试。");
    } finally {
      if (scopeRequestRef.current === requestToken) setScopeLoading(false);
    }
  }

  async function runAi(action: AiAction, title: string, payload: unknown, apply?: { label: string; onApply: (result: unknown) => void | Promise<void> }) {
    let clientRequest: ReturnType<typeof createCareerAiClientRequest>;
    try {
      clientRequest = createCareerAiClientRequest(action, payload);
    } catch (error) {
      notify(careerAiClientIssueText(action, error), "info");
      return;
    }
    aiRequestRef.current?.controller.abort();
    const request = { id: crypto.randomUUID(), controller: new AbortController() };
    aiRequestRef.current = request;
    setAiState({ action, title, loading: true, applyLabel: apply?.label, onApply: apply?.onApply });
    try {
      const response = await fetchCareerAiClientRequest(clientRequest, request.controller.signal);
      const body = await response.json().catch(() => null);
      if (aiRequestRef.current?.id !== request.id) return;
      if (!response.ok) throw new Error((body as { error?: string } | null)?.error || "AI 服务暂时不可用");
      setAiState((current) => current ? { ...current, loading: false, result: parseAiContent(body), error: undefined } : current);
    } catch (error) {
      if (request.controller.signal.aborted || aiRequestRef.current?.id !== request.id) return;
      setAiState((current) => current ? { ...current, loading: false, error: error instanceof Error ? error.message : "请求失败" } : current);
    }
  }

  function rememberContactRemovalFocus(contactId: string) {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".career-contact-open"));
    const index = buttons.findIndex((button) => button.dataset.contactId === contactId);
    contactRemovalFocusRef.current = buttons[index + 1] ?? buttons[index - 1] ??
      document.querySelector<HTMLElement>(".career-segmented button[aria-pressed='true']");
  }

  async function handleContactUndo() {
    const ticket = contactUndo;
    if (!ticket || contactUndoWriteRef.current) return;
    contactUndoWriteRef.current = true;
    if (ticket.phase === "refresh-only") {
      setContactUndo({ ...ticket, phase: "writing", message: "正在只读核对联系人状态…" });
      try {
        await refreshContacts();
        const latest = await loadCareerContactExpectedState(ticket.id);
        if (!latest || !latest.expectedArchived) {
          setContactUndo(null);
          notify(latest ? `已确认恢复「${ticket.name}」` : `「${ticket.name}」已在别处变化`, "info");
        } else {
          setContactUndo({ ...ticket, phase: "refresh-only", message: "仍无法确认恢复结果；再次核对只会读取，不会重复恢复。" });
        }
      } catch {
        setContactUndo({ ...ticket, phase: "refresh-only", message: "暂时没有读到最新状态；再次核对不会重复恢复。" });
      } finally { contactUndoWriteRef.current = false; }
      return;
    }
    setContactUndo({ ...ticket, phase: "writing", message: "正在恢复联系人…" });
    try {
      const result = await restoreCareerContactSafely(ticket.id, ticket.expected);
      if (result.outcome === "saved" || result.outcome === "already_saved") {
        setContactUndo({ ...ticket, phase: "refresh-only", message: "恢复写入已结束，正在只读刷新…" });
        try {
          await refreshContacts();
          setContactUndo(null);
          notify(`已恢复「${ticket.name}」`, "info");
        } catch {
          setContactUndo({ ...ticket, phase: "refresh-only", message: "联系人已恢复，但画面还没有重新读到；这里只会继续核对。" });
        }
      } else if (result.outcome === "changed") {
        setContactUndo({ ...ticket, phase: "refresh-only", message: "联系人已在别处变化。旧恢复命令已停止；这里只会重新读取。" });
        try {
          await refreshContacts();
          setContactUndo(null);
          notify(`「${ticket.name}」已在别处变化，没有依据旧状态恢复`, "info");
        } catch { /* The refresh-only ticket remains visible and cannot write again. */ }
      } else {
        setContactUndo({ ...ticket, phase: "refresh-only", message: "恢复结果暂时无法确认；接下来只核对，不会重复恢复。" });
      }
    } catch (error) {
      if (error instanceof CareerContactMutationError && error.code === "changed") {
        try { await refreshContacts(); } catch { /* The stale command still stays stopped. */ }
        setContactUndo(null);
        notify(`「${ticket.name}」已在别处变化，没有覆盖新状态`, "info");
      } else {
        setContactUndo({ ...ticket, phase: "ready", message: error instanceof Error ? error.message : "这次没有恢复，归档状态保持不变。" });
      }
    } finally { contactUndoWriteRef.current = false; }
  }

  function navigate(next: CareerView) {
    setView(next);
    setSidebarOpen(false);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
  }
  function openCareerImport(opener: HTMLButtonElement) {
    importOpenerRef.current = opener;
    importFocusReturnPendingRef.current = false;
    setModal("import");
  }
  function closeCareerImport() {
    importFocusReturnPendingRef.current = true;
    setModal(null);
    setImportInitial(null);
  }
  function closeMaterialRemoval() {
    materialRemovalFocusPendingRef.current = true;
    setMaterialRemoval(null);
  }
  if (loading) return <CareerLoading />;
  if (loadError) return <CareerError message={loadError} onRetry={() => { setLoading(true); setLoadError(""); setRefreshKey((key) => key + 1); }} />;

  return <main className="career-app">
    <Sidebar sidebarRef={sidebarRef} view={view} open={sidebarOpen} mobile={mobileLayout} onNavigate={navigate} onClose={() => setSidebarOpen(false)} />
    <section className="career-main">
      <Topbar title={navItems.find((item) => item.id === view)?.label ?? "职迹"} query={query} menuOpen={sidebarOpen} onQuery={setQuery} onSearch={() => setSearchOpen(true)} onMenu={() => setSidebarOpen(true)} onAdd={() => setModal("job")} onSettings={() => navigate("settings")} />
      <div className="career-content">
        {legacyReviewNeeded && <div className="career-legacy-review-note" role="status"><ShieldCheck size={19} /><div><b>旧版资料需要你看一眼</b><p>旧版可能含示例内容，未自动删除以保护你的编辑。我们不会替你判断哪些记录属于你，也不会自行清理。</p></div></div>}
        {view === "today" && <TodayView data={allData} now={careerClock} onNavigate={navigate} onSelectJob={setSelectedJobId} onSelectInterview={setSelectedInterviewId} onOpenTask={openTask} onCompleteTask={completeTask} onAddJob={() => setModal("job")} onAi={runAi} />}
        {view === "board" && <BoardView data={boardData} jobs={boardJobs} now={careerClock} query={query} sourceFilter={sourceFilter} priorityOnly={priorityOnly} onSourceFilter={setSourceFilter} onPriorityOnly={setPriorityOnly} onClear={() => { setQuery(""); setSourceFilter("all"); setPriorityOnly(false); }} onSelectJob={setSelectedJobId} onAddJob={() => setModal("job")} onMove={async (jobId, stageId) => { await requestLifecycleChange({ kind: "stage", jobId, nextStageId: stageId }); }} lifecycleLocked={lifecycleLocked} sensors={sensors} activeJob={activeJob} onDragStart={(event) => { if (!lifecycleWriteRef.current && !lifecycleRefreshOnlyRef.current) setActiveDragId(String(event.active.id)); }} onDragEnd={async (event) => { setActiveDragId(null); if (!event.over || lifecycleWriteRef.current || lifecycleRefreshOnlyRef.current) return; const stageId = String(event.over.id).replace(/^stage:/, ""); if (data.stages.some((stage) => stage.id === stageId)) await requestLifecycleChange({ kind: "stage", jobId: String(event.active.id), nextStageId: stageId }); }} />}
        {view === "jobs" && <JobsView data={scopedData} jobs={scopedJobs} now={careerClock} scope={jobScope} scopeLoading={scopeLoading} scopeError={scopeError} stageFilter={stageFilter} sourceFilter={sourceFilter} priorityOnly={priorityOnly} onScope={(scope) => { void changeJobScope(scope); }} onStageFilter={setStageFilter} onSourceFilter={setSourceFilter} onPriorityOnly={setPriorityOnly} onSelectJob={setSelectedJobId} onImport={openCareerImport} />}
        {view === "calendar" && <CalendarView data={allData} now={careerClock} onOpenTask={openTask} onCompleteTask={completeTask} onAddTask={() => setModal("task")} onAddInterview={() => setModal("interview")} onSelectInterview={setSelectedInterviewId} />}
        {view === "interviews" && <InterviewsView data={data} now={careerClock} onAdd={() => setModal("interview")} onSelect={setSelectedInterviewId} onAi={runAi} />}
        {view === "contacts" && <ContactsView data={data} now={careerClock} revision={contactRevision} externalHint={contactDataHint} onAdd={() => setContactEditorId(null)} onSelect={(contactId) => setSelectedContactId(contactId)} />}
        {view === "materials" && <MaterialsView
          data={data}
          stale={materialListStale}
          refreshBusy={materialRefreshBusy}
          recoveryLoaded={materialRecoveryLoaded}
          recoveryCount={materialSaveRecoveryEntries.length}
          recoveryUnreadable={materialRecoveryUnreadableKeys.length > 0}
          recoveryStorageUnavailable={materialRecoveryStorageUnavailable || volatileMaterialRecoveries.length > 0}
          onRefresh={refreshMaterials}
          onAdd={() => setModal("material")}
          onRecover={() => setModal("material")}
          onClearUnreadable={clearUnreadableMaterialRecoveryEntries}
          onRetryRecoveryStorage={retryMaterialRecoveryStorage}
          onRemove={(material, opener) => { materialRemovalOpenerRef.current = opener; materialRemovalFocusPendingRef.current = false; setMaterialRemoval({ id: material.id, name: material.name, file_key: material.file_key }); }}
          notify={notify}
        />}
        {view === "analytics" && <AnalyticsView data={allData} now={careerClock} />}
        {view === "settings" && <SettingsView data={data} onRefresh={requireRefresh} onExport={async () => {
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
        }} notify={notify} />}
      </div>
    </section>
    <MobileNav view={view} onNavigate={navigate} onMore={() => setSidebarOpen(true)} />
    {selectedJob && <JobDrawer key={`${selectedJob.id}:${selectedJob.archived}`} job={selectedJob} data={allData} now={careerClock} lifecyclePending={lifecycleLocked} onClose={() => setSelectedJobId(null)} onLifecycle={(intent) => requestLifecycleChange(intent)} onRefresh={requireRefresh} onOpenTask={openTask} onCompleteTask={completeTask} onAi={runAi} onSelectContact={(contactId) => { setSelectedJobId(null); setSelectedContactId(contactId); }} notify={notify} />}
    {selectedInterview && <InterviewDrawer interview={selectedInterview} data={allData} onClose={() => setSelectedInterviewId(null)} onRefresh={requireRefresh} onAi={runAi} notify={notify} />}
    {lifecycleDialog && <CareerLifecycleModal
      state={lifecycleDialog}
      busy={lifecycleBusy}
      onChoice={(choice) => setLifecycleDialog((current) => current?.phase === "decision" ? { ...current, choice, error: "" } : current)}
      onClose={() => {
        if (!lifecycleBusy && lifecycleDialog.phase === "decision") {
          setLifecycleDialog(null);
          focusAfterLifecycle();
        }
      }}
      onConfirm={() => { void confirmLifecycleChange(); }}
      onRetryRefresh={() => { void retryLifecycleRefresh(); }}
    />}
    {selectedContactId && <ContactDrawer
      contactId={selectedContactId}
      revision={contactRevision}
      now={careerClock}
      onClose={() => setSelectedContactId(null)}
      onEdit={() => setContactEditorId(selectedContactId)}
      onRecord={() => setContactAction({ kind: "interaction", contactId: selectedContactId })}
      onAddTask={() => setContactAction({ kind: "task", contactId: selectedContactId })}
      onOpenTask={openTask}
      onCompleteTask={completeTask}
      onRefresh={refreshContacts}
      externalHint={contactDataHint}
      onArchived={(contact, expected) => {
        rememberContactRemovalFocus(contact.id);
        setSelectedContactId(null);
        setContactUndo({ id: contact.id, name: contact.name, expected, phase: "ready", message: "联系人已归档" });
        notify("联系人已移入归档；历史、关联与待办都保留", "info");
      }}
      onRestored={(contact) => {
        rememberContactRemovalFocus(contact.id);
        setSelectedContactId(null);
        notify("联系人已恢复", "info");
      }}
      notify={notify}
    />}
    {modal === "job" && <JobModal data={data} onClose={() => setModal(null)} onSaved={async (id) => { setModal(null); await requireRefresh(); setSelectedJobId(id); notify("职位已加入职迹"); }} />}
    {modal === "task" && <TaskModal data={data} initialJobId={selectedJobId} onClose={() => { setModal(null); setSelectedJobId(null); }} onSaved={async () => { await refreshTasks(); setModal(null); setSelectedJobId(null); notify("待办已创建"); }} />}
    {modal === "interview" && <InterviewModal data={data} onClose={() => setModal(null)} onSaved={async () => { setModal(null); await requireRefresh(); notify("面试轮次已安排"); }} />}
    {modal === "material" && <MaterialModal
      data={data}
      initialRecovery={materialSaveRecoveryEntries[0] ?? null}
      otherRecoveryPending={materialSaveRecoveryEntries.length > (materialSaveRecoveryEntries[0] ? 1 : 0) || materialRecoveryUnreadableKeys.length > 0}
      onRecoveryUpsert={persistMaterialSaveRecovery}
      onRecoveryClear={clearMaterialSaveRecovery}
      onClose={closeMaterialModal}
      onStaleClose={closeMaterialWithStaleList}
      onRefresh={refreshMaterials}
      notify={notify}
    />}
    {materialRemoval && <MaterialDeletionModal material={materialRemoval} onClose={closeMaterialRemoval} onStaleClose={closeRemovalWithStaleList} onRefresh={refreshMaterials} notify={notify} />}
    {modal === "import" && <CareerImportModal data={allData} initialCapture={importInitial} onClose={closeCareerImport} onRefresh={requireRefresh} notify={notify} />}
    {searchOpen && <CommandPalette data={data} onClose={() => setSearchOpen(false)} onNavigate={navigate} onSelectJob={(id) => { setSearchOpen(false); setSelectedJobId(id); }} onAdd={() => { setSearchOpen(false); setModal("job"); }} />}
    {contactEditorId !== undefined && <ContactModal
      contactId={contactEditorId}
      data={data}
      externalHint={contactDataHint}
      onClose={() => setContactEditorId(undefined)}
      onRefresh={refreshContacts}
      onSaved={(id) => {
        setContactEditorId(undefined);
        setSelectedContactId(id);
        notify(contactEditorId ? "联系人资料已更新" : "联系人已保存");
      }}
      notify={notify}
    />}
    {contactAction?.kind === "interaction" && <ContactInteractionModal
      contactId={contactAction.contactId}
      data={data}
      externalHint={contactDataHint}
      onClose={() => setContactAction(null)}
      onRefresh={refreshContacts}
      onSaved={() => {
        setContactAction(null);
        notify("真实联系已记录");
      }}
      notify={notify}
    />}
    {contactAction?.kind === "task" && <ContactTaskModal
      contactId={contactAction.contactId}
      data={data}
      externalHint={contactDataHint}
      onClose={() => setContactAction(null)}
      onRefresh={refreshTasks}
      onSaved={() => {
        setContactAction(null);
        notify("下一步已安排");
      }}
      notify={notify}
    />}
    {taskSheet && <TaskDetailSheet
      key={taskSheet.nonce}
      request={taskSheet}
      now={careerClock}
      onClose={() => setTaskSheet(null)}
      onRefresh={refreshTasks}
      notify={notify}
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
    <div className="career-toast-stack" aria-live="polite">{contactUndo && <button className="career-toast undo career-contact-undo" disabled={contactUndo.phase === "writing"} onClick={() => void handleContactUndo()} aria-label={contactUndo.phase === "refresh-only" ? `核对恢复「${contactUndo.name}」` : `撤销归档「${contactUndo.name}」`}>{contactUndo.phase === "writing" ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}<span>{contactUndo.message}</span> <b>{contactUndo.phase === "refresh-only" ? "只读核对" : contactUndo.phase === "writing" ? "请稍候" : "撤销"}</b></button>}{undo && <button className="career-toast undo" onClick={handleUndo}><RotateCcw size={16} />阶段已更新 <b>撤销</b></button>}{notices.map((notice) => <div className={`career-toast ${notice.tone}`} key={notice.id}>{notice.tone === "success" ? <Check size={16} /> : notice.tone === "error" ? <X size={16} /> : <Bell size={16} />}{notice.text}</div>)}</div>
  </main>;
}

function CareerLoading() { return <main className="career-loading" role="status"><div className="career-loading-mark">职</div><LoaderCircle className="spin" size={20} /><p>正在打开你的求职工作台…</p></main>; }
function CareerError({ message, onRetry }: { message: string; onRetry: () => void }) { return <main className="career-error"><ShieldCheck size={30} /><h1>本地资料暂时没有打开</h1><p>{message}</p><button className="career-button primary" onClick={onRetry}><RotateCcw size={16} />重新尝试</button></main>; }

function Sidebar({ sidebarRef, view, open, mobile, onNavigate, onClose }: { sidebarRef: { current: HTMLElement | null }; view: CareerView; open: boolean; mobile: boolean; onNavigate: (view: CareerView) => void; onClose: () => void }) {
  const hidden = mobile && !open;
  return <><button className={`career-scrim ${open ? "show" : ""}`} tabIndex={-1} aria-label="关闭导航" onClick={onClose} /><aside ref={sidebarRef} id="career-sidebar" className={`career-sidebar ${open ? "open" : ""}`} role={open ? "dialog" : undefined} aria-modal={open ? "true" : undefined} aria-label={open ? "职迹导航" : undefined} aria-hidden={hidden || undefined} inert={hidden || undefined} tabIndex={open ? -1 : undefined}>
    <Link href="/" className="career-brand" aria-label="返回私人工作台" tabIndex={hidden ? -1 : undefined}><span>职</span><div><b>职迹</b><small>每一步，都算数</small></div></Link><button data-sidebar-close className="career-icon-button mobile-only" tabIndex={hidden ? -1 : undefined} style={{ position: "absolute", insetBlockStart: 29, insetInlineEnd: 24 }} onClick={onClose} aria-label="关闭导航"><X size={18} /></button>
    <nav className="career-nav" aria-label="职迹主导航">{navItems.map((item) => <button key={item.id} tabIndex={hidden ? -1 : undefined} aria-label={item.label} className={view === item.id ? "active" : ""} onClick={() => onNavigate(item.id)}><item.icon size={18} strokeWidth={1.8} /><span>{item.label}</span></button>)}</nav>
    <div className="career-sidebar-spacer" /><div className="career-sidebar-calm"><ShieldCheck size={15} /><div><b>这里不评价进度</b><p>等待、暂停或暂时没有新变化，都是正常状态。</p></div></div><div className="career-privacy"><ShieldCheck size={15} /><span>资料保存在本地 SQLite</span><i /></div>
  </aside></>;
}

function Topbar({ title, query, menuOpen, onQuery, onSearch, onMenu, onAdd, onSettings }: { title: string; query: string; menuOpen: boolean; onQuery: (value: string) => void; onSearch: () => void; onMenu: () => void; onAdd: () => void; onSettings: () => void }) {
  return <header className="career-topbar"><div className="career-topbar-title"><button className="career-icon-button mobile-only" onClick={onMenu} aria-label="打开导航" aria-expanded={menuOpen} aria-controls="career-sidebar"><Menu size={20} /></button><h1 id="career-page-title" tabIndex={-1}>{title}</h1></div><div className="career-topbar-actions"><label className="career-search"><Search size={16} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索职位、公司、标签" aria-label="搜索" /><kbd>⌘ K</kbd></label><button className="career-icon-button command-compact" onClick={onSearch} aria-label="打开搜索"><Search size={18} /></button><button className="career-button primary" onClick={onAdd}><Plus size={17} />记录职位</button><button className="career-avatar" aria-label="个人设置" onClick={onSettings}>FK<span /></button></div></header>;
}

function MobileNav({ view, onNavigate, onMore }: { view: CareerView; onNavigate: (view: CareerView) => void; onMore: () => void }) {
  const visible = navItems.filter((item) => ["today", "board", "calendar", "interviews"].includes(item.id));
  const overflowActive = !visible.some((item) => item.id === view);
  return <nav className="career-mobile-nav" aria-label="移动端主导航">{visible.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => onNavigate(item.id)}><item.icon size={20} /><span>{item.compact}</span></button>)}<button onClick={onMore} className={overflowActive ? "active" : ""} aria-haspopup="dialog"><Menu size={20} /><span>更多</span></button></nav>;
}

function SectionHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) { return <div className="career-section-heading"><div>{eyebrow && <span>{eyebrow}</span>}<h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>; }
function CompanyMark({ company, small = false, decorative = false }: { company: string; small?: boolean; decorative?: boolean }) {
  const colors = ["mint", "lavender", "peach", "blue", "sand", "rose"];
  const index = Array.from(company).reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length;
  return <span className={`career-company-mark ${colors[index]} ${small ? "small" : ""}`} aria-hidden={decorative || undefined}>{initials(company)}</span>;
}

function SourceBadge({ source }: { source: string }) { return <span className={`career-source ${sourceClass[source] ?? "other"}`}>{source === "LinkedIn" ? "in" : source === "BOSS直聘" ? "BOSS" : source}</span>; }

function careerTaskStatusCopy(task: Task) {
  if (task.status === "done") return "已完成";
  if (task.status === "canceled") return isCareerLifecyclePaused(task) ? "随职位暂停" : "已放下";
  return "待办";
}

function CareerTaskRow({ task, data, now, onOpen, onComplete, compact = false }: {
  task: Task;
  data: CareerData;
  now: number;
  onOpen: (taskId: string) => void;
  onComplete: (task: Task) => void | Promise<void>;
  compact?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const job = data.jobs.find((item) => item.id === task.job_id);
  const context = careerJobContext(job, data.stages);
  async function handleComplete() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try { await onComplete(task); }
    finally { pendingRef.current = false; setPending(false); }
  }
  return <article className={`career-task-row ${compact ? "compact" : ""}`} data-task-status={task.status}>
    {task.status === "todo" ? <button type="button" className="career-task-complete" disabled={pending} aria-busy={pending || undefined} onClick={() => void handleComplete()} aria-label={`完成「${task.title}」`}>{pending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}</button> : <span className={`career-task-state ${task.status}`} aria-hidden="true">{task.status === "done" ? <Check size={15} /> : <Circle size={13} />}</span>}
    <button type="button" className="career-task-open" onClick={() => onOpen(task.id)} aria-label={`打开待办「${task.title}」`}><b>{task.title}</b><small>{job ? `${job.company} · ${job.role}` : task.contact_id ? "联系人待办" : "个人待办"}<i>{formatCareerTaskDate(task.due_at, now)}</i>{context && <i className="career-action-context">{context}</i>}</small></button>
    <span className="career-task-kind"><em>{careerTaskStatusCopy(task)}</em><small>{task.kind}</small></span>
  </article>;
}

function TodayView({ data, now, onNavigate, onSelectJob, onSelectInterview, onOpenTask, onCompleteTask, onAddJob, onAi }: { data: CareerData; now: number; onNavigate: (view: CareerView) => void; onSelectJob: (id: string) => void; onSelectInterview: (id: string) => void; onOpenTask: (id: string) => void; onCompleteTask: (task: Task) => void | Promise<void>; onAddJob: () => void; onAi: (action: AiAction, title: string, payload: unknown) => void }) {
  const today = new Date(now);
  const date = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(today);
  const greeting = today.getHours() < 11 ? "早上好" : today.getHours() < 14 ? "中午好" : today.getHours() < 18 ? "下午好" : "晚上好";
  const terminalStages = new Set(data.stages.filter((stage) => stage.is_terminal === 1).map((stage) => stage.id));
  const activeJobs = data.jobs.filter((job) => job.archived !== 1 && !terminalStages.has(job.stage_id));
  const activeJobIds = new Set(activeJobs.map((job) => job.id));
  const { start: todayStart, end: todayEnd } = localDayBounds(now);
  const agendaEnd = new Date(todayEnd);
  agendaEnd.setDate(agendaEnd.getDate() + 6);
  const activeOpenTasks = data.tasks.filter((task) => {
    if (task.status !== "todo" || (task.job_id && !activeJobIds.has(task.job_id)) || !task.due_at) return false;
    const timestamp = new Date(task.due_at).getTime();
    return Number.isFinite(timestamp) && timestamp >= todayStart && timestamp < todayEnd;
  }).sort((a, b) => (a.due_at ?? "").localeCompare(b.due_at ?? ""));
  const agendaTasks = data.tasks
    .filter((task) => {
      if (task.status !== "todo" || !task.due_at) return false;
      const timestamp = new Date(task.due_at).getTime();
      return Number.isFinite(timestamp) && timestamp >= todayStart && timestamp < agendaEnd.getTime();
    })
    .sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"));
  const agendaItems = [
    ...agendaTasks.map((task) => ({ kind: "task" as const, at: task.due_at ?? "9999", task })),
    ...data.interviews
      .filter((interview) => interview.status === "scheduled" && Boolean(interview.scheduled_at))
      .filter((interview) => {
        const timestamp = new Date(interview.scheduled_at ?? "").getTime();
        return Number.isFinite(timestamp) && timestamp >= now && timestamp < agendaEnd.getTime();
      })
      .map((interview) => ({ kind: "interview" as const, at: interview.scheduled_at ?? "9999", interview })),
  ].sort((left, right) => left.at.localeCompare(right.at));
  const focus = resolveCareerTodayFocus(data, now);
  const focusJob = focus?.jobId ? activeJobs.find((job) => job.id === focus.jobId) ?? null : null;
  const focusInterview = focus?.kind === "interview" ? data.interviews.find((item) => item.id === focus.interviewId) ?? null : null;
  const focusTask = focus?.kind === "task" ? activeOpenTasks.find((item) => item.id === focus.taskId) ?? null : null;
  const interviewStillAhead = Boolean(focusInterview?.scheduled_at && new Date(focusInterview.scheduled_at).getTime() >= now);

  return <div className="career-view career-today"><section className="career-welcome"><div><span>{date}</span><h2>{greeting}，按自己的节奏来。</h2><p>这里只放你真实安排过的事项；没有必须处理的事，也是一种正常状态。</p></div><div className="career-welcome-actions"><button className="career-button secondary" onClick={() => onNavigate("calendar")}><CalendarDays size={16} />查看日程</button><button className="career-button primary" onClick={onAddJob}><Plus size={16} />记录职位</button></div></section>
    <section className="career-today-grid"><div className="career-panel career-focus-panel"><SectionHeading eyebrow="TODAY" title="今天的落点" />
      {focus?.kind === "interview" && focusJob && focusInterview ? <div className="career-focus-card"><CompanyMark company={focusJob.company} /><div className="career-focus-copy"><span>{focusJob.company}</span><h3>{focusInterview.round_name} · {focusJob.role}</h3><p>{formatDate(focusInterview.scheduled_at, true)} · {focusInterview.interviewer || "面试官待确认"}</p></div><div className="career-focus-actions">{interviewStillAhead && <button className="career-button primary career-ai-trigger" onClick={() => onAi("interview_prep", "AI 面试准备", { job: focusJob, interview: focusInterview })}><WandSparkles size={16} />AI 准备</button>}<button className="career-button secondary" onClick={() => onSelectInterview(focusInterview.id)}><MessageSquareText size={16} />打开面经</button></div>{interviewStillAhead && <CareerAiDisclosure action="interview_prep" className="on-dark" />}</div> : focus?.kind === "task" && focusTask ? <div className="career-focus-card"><span className="career-focus-symbol"><ListTodo size={20} /></span><div className="career-focus-copy"><span>{focusJob?.company ?? "个人待办"}</span><h3>{focusTask.title}</h3><p>{formatCareerTaskDate(focusTask.due_at, now)}</p></div><div className="career-focus-actions"><button className="career-button primary" onClick={() => onOpenTask(focusTask.id)}><ListTodo size={16} />打开待办</button>{focusJob && <button className="career-icon-button" onClick={() => onSelectJob(focusJob.id)} aria-label="打开关联职位"><ArrowUpRight size={18} /></button>}</div></div> : focus?.kind === "offer" && focusJob ? <div className="career-focus-card"><CompanyMark company={focusJob.company} /><div className="career-focus-copy"><span>{focusJob.company}</span><h3>{focusJob.role} · Offer 待决定</h3><p>这是需要你亲自权衡的选择，不必为了尽快清空状态而仓促决定。</p></div><div className="career-focus-actions"><button className="career-button primary" onClick={() => onSelectJob(focusJob.id)}>查看记录 <ArrowRight size={14} /></button></div></div> : <div className="career-focus-rest"><span><ShieldCheck size={21} /></span><div><h3>今天没有安排待办</h3><p>原来的安排仍在日历里，需要时再处理。今天不必为了清空列表做决定。</p></div></div>}
      {focus?.kind === "interview" && interviewStillAhead && <div className="career-focus-tips"><span><i />准备到让自己安心就好，不需要把每一种问题都预测完。</span></div>}
    </div>
      <div className="career-panel career-agenda-panel"><SectionHeading title="今天与接下来" action={<button className="career-text-button" onClick={() => onNavigate("calendar")}>全部日程 <ChevronRight size={14} /></button>} /><div className="career-agenda-list">{agendaItems.slice(0, 5).map((item) => { if (item.kind === "task") return <CareerTaskRow compact key={`task:${item.task.id}`} task={item.task} data={data} now={now} onOpen={onOpenTask} onComplete={onCompleteTask} />; const interview = item.interview; const job = data.jobs.find((entry) => entry.id === interview.job_id); const context = careerJobContext(job, data.stages); return <button className="career-agenda-item" key={`interview:${interview.id}`} onClick={() => onSelectInterview(interview.id)}><span className="career-agenda-symbol"><CalendarDays size={14} /></span><span><b>{interview.round_name}</b><small>{job ? `${job.company} · ` : ""}{formatDate(interview.scheduled_at, true)}{context && <i className="career-action-context">{context}</i>}</small></span><em>面试</em></button>; })}{agendaItems.length === 0 && <p className="career-agenda-calm">今天和最近几天没有安排。更早或未定时间的记录仍安静地留在日历里。</p>}</div></div>
    </section><section className="career-panel career-recent"><SectionHeading title="最近发生的事" description="只保留事实，不把安静的日子解释成落后" action={<button className="career-text-button" onClick={() => onNavigate("jobs")}>查看职位</button>} /><div className="career-activity-row">{data.activities.slice(0, 4).map((item) => { const job = data.jobs.find((entry) => entry.id === item.job_id); return <button key={item.id} onClick={() => job && onSelectJob(job.id)}><span className={`career-activity-icon ${item.type}`}><Zap size={15} /></span><span><b>{neutralActivityDetail(item.detail)}</b><small>{job ? `${job.company} · ${job.role}` : "职迹"}</small></span><time>{formatDate(item.created_at)}</time></button>; })}{data.activities.length === 0 && <p className="career-calm-empty">还没有变化需要回看。等真实发生了什么，这里再出现。</p>}</div></section>
  </div>;
}

type SensorValue = ReturnType<typeof useSensors>;
function BoardView({ data, jobs, now, query, sourceFilter, priorityOnly, onSourceFilter, onPriorityOnly, onClear, onSelectJob, onAddJob, onMove, lifecycleLocked, sensors, activeJob, onDragStart, onDragEnd }: { data: CareerData; jobs: Job[]; now: number; query: string; sourceFilter: string; priorityOnly: boolean; onSourceFilter: (value: string) => void; onPriorityOnly: (value: boolean) => void; onClear: () => void; onSelectJob: (id: string) => void; onAddJob: () => void; onMove: (jobId: string, stageId: string) => Promise<void>; lifecycleLocked: boolean; sensors: SensorValue; activeJob: Job | null; onDragStart: (event: DragStartEvent) => void; onDragEnd: (event: DragEndEvent) => void }) {
  const stages = data.stages.filter((stage) => !stage.hidden && stage.is_terminal !== 1);
  return <div className="career-view career-board-view"><SectionHeading eyebrow="PIPELINE" title="求职看板" description="只放还在进行中的职位；拖动或阶段菜单都会先让你看清影响。" action={<div className="career-view-actions"><button className={`career-chip ${priorityOnly ? "active" : ""}`} aria-pressed={priorityOnly} onClick={() => onPriorityOnly(!priorityOnly)}><Target size={14} />只看已关注</button><select className="career-select compact" value={sourceFilter} onChange={(event) => onSourceFilter(event.target.value)} aria-label="来源筛选"><option value="all">全部来源</option>{[...new Set(data.jobs.map((job) => job.source))].map((source) => <option key={source}>{source}</option>)}</select><button className="career-icon-button" onClick={onClear} aria-label="清除筛选"><RotateCcw size={16} /></button></div>} />{(query || sourceFilter !== "all" || priorityOnly) && <div className="career-filter-summary"><Filter size={14} />已按当前条件筛选<button onClick={onClear}>清除全部</button></div>}
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}><div className="career-board-scroll">{stages.map((stage) => <BoardColumn key={stage.id} stage={stage} jobs={jobs.filter((job) => job.stage_id === stage.id)} data={data} now={now} onSelectJob={onSelectJob} onAddJob={onAddJob} onMove={onMove} lifecycleLocked={lifecycleLocked} />)}</div><DragOverlay>{activeJob ? <div aria-hidden="true"><JobCard job={activeJob} data={data} now={now} overlay onSelect={() => undefined} /></div> : null}</DragOverlay></DndContext>
  </div>;
}

function BoardColumn({ stage, jobs, data, now, onSelectJob, onAddJob, onMove, lifecycleLocked }: { stage: Stage; jobs: Job[]; data: CareerData; now: number; onSelectJob: (id: string) => void; onAddJob: () => void; onMove: (jobId: string, stageId: string) => Promise<void>; lifecycleLocked: boolean }) {
  const { isOver, setNodeRef } = useDroppable({ id: `stage:${stage.id}` });
  return <section ref={setNodeRef} className={`career-board-column ${isOver ? "over" : ""}`}><header><div><i style={{ background: stage.color }} /><b>{stage.name}</b><span>{jobs.length}</span></div><button onClick={onAddJob} aria-label={`在${stage.name}添加职位`}><Plus size={16} /></button></header><div className="career-board-cards">{jobs.map((job) => <DraggableJobCard key={job.id} job={job} data={data} now={now} onSelect={() => onSelectJob(job.id)} onMove={onMove} pending={lifecycleLocked} />)}{jobs.length === 0 && <div className="career-board-empty">拖到这里</div>}</div><button className="career-add-inline" onClick={onAddJob}><Plus size={15} />添加职位</button></section>;
}

function DraggableJobCard({ job, data, now, onSelect, onMove, pending }: { job: Job; data: CareerData; now: number; onSelect: () => void; onMove: (jobId: string, stageId: string) => Promise<void>; pending: boolean }) {
  const { listeners, setNodeRef, transform, isDragging } = useDraggable({ id: job.id, disabled: pending });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  return <div ref={setNodeRef} style={style} className={isDragging ? "dragging" : ""}><JobCard job={job} data={data} now={now} onSelect={onSelect} onMove={onMove} pending={pending} dragProps={listeners ?? {}} /></div>;
}

function careerJobNextLabel(next: CareerJobNextItem, now: number) {
  if (next?.kind === "interview") return `${formatDate(next.at, true)} · ${next.interview.round_name}`;
  if (next?.kind === "task") return `${next.at ? formatCareerTaskDate(next.at, now) : "时间未定"} · ${next.task.title}`;
  return null;
}

function JobCard({ job, data, now, onSelect, onMove, overlay = false, pending = false, dragProps = {} }: { job: Job; data: CareerData; now: number; onSelect: () => void; onMove?: (jobId: string, stageId: string) => Promise<void>; overlay?: boolean; pending?: boolean; dragProps?: Record<string, unknown> }) {
  const next = resolveCareerJobNextItem(job.id, data.tasks, data.interviews, now);
  const draggable = Object.keys(dragProps).length > 0;
  const nextCopy = careerJobNextLabel(next, now) ?? "还没有明确安排下一步";
  return <article className={`career-job-card ${overlay ? "overlay" : ""}`}><div className="career-job-card-top"><CompanyMark company={job.company} small />{draggable && <span className="career-grip" {...dragProps} tabIndex={-1} aria-hidden="true"><GripVertical size={16} /></span>}</div><button className="career-job-card-open" onClick={onSelect} aria-label={`打开 ${job.company} ${job.role}`}><h3>{job.role}</h3><p>{job.company}</p><div className="career-card-meta"><span>{job.location || "地点待定"}</span>{job.work_mode && <span>{job.work_mode}</span>}</div><div className="career-card-tags">{job.tags.split(",").filter(Boolean).slice(0, 2).map((tag) => <i key={tag}>{tag}</i>)}</div><div className="career-next"><Clock3 size={13} /><span>{nextCopy}</span></div></button><footer><SourceBadge source={job.source} />{onMove ? <select value={job.stage_id} disabled={pending} onChange={(event) => void onMove(job.id, event.target.value)} aria-label={`移动 ${job.company} ${job.role} 到阶段`}>{data.stages.filter((stage) => !stage.hidden).map((stage) => <option value={stage.id} key={stage.id}>{stage.name}</option>)}</select> : careerJobIsWatched(job.priority) ? <span className="career-watch"><Target size={13} />已关注</span> : <span className="career-watch quiet">普通记录</span>}</footer></article>;
}

function JobsView({ data, jobs, now, scope, scopeLoading, scopeError, stageFilter, sourceFilter, priorityOnly, onScope, onStageFilter, onSourceFilter, onPriorityOnly, onSelectJob, onImport }: { data: CareerData; jobs: Job[]; now: number; scope: CareerJobScope; scopeLoading: boolean; scopeError: string; stageFilter: string; sourceFilter: string; priorityOnly: boolean; onScope: (value: CareerJobScope) => void; onStageFilter: (value: string) => void; onSourceFilter: (value: string) => void; onPriorityOnly: (value: boolean) => void; onSelectJob: (id: string) => void; onImport: (opener: HTMLButtonElement) => void }) {
  const emptyCopy = scope === "active"
    ? { title: "没有匹配的进行中职位", text: "可以调整筛选，也可以在遇到合适机会时再记录。" }
    : scope === "ended"
      ? { title: "还没有已结束的记录", text: "结果只是一段经历的状态，不是对你的评分。" }
      : { title: "归档里很安静", text: "收起的职位仍保留记录，需要时可以再取回。" };
  return <div className="career-view"><SectionHeading eyebrow="APPLICATIONS" title="职位" description="把进行中、已结束和收起的记录分开放，不让数量给你压力。" action={<button className="career-button secondary" onClick={(event) => onImport(event.currentTarget)}><Import size={16} />从原文添加</button>} />
    <div className="career-job-scope" aria-label="职位范围">{([["active", "进行中"], ["ended", "已结束"], ["archived", "已归档"]] as const).map(([value, label]) => <button key={value} data-career-scope={value} className={scope === value ? "active" : ""} aria-pressed={scope === value} disabled={scopeLoading} onClick={() => onScope(value)}>{label}</button>)}</div>
    <div className="career-toolbar"><select className="career-select" value={stageFilter} onChange={(event) => onStageFilter(event.target.value)} aria-label="按阶段筛选"><option value="all">全部阶段</option>{data.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select><select className="career-select" value={sourceFilter} onChange={(event) => onSourceFilter(event.target.value)} aria-label="按来源筛选"><option value="all">全部来源</option>{[...new Set(data.jobs.map((job) => job.source))].map((source) => <option key={source}>{source}</option>)}</select><button className={`career-chip ${priorityOnly ? "active" : ""}`} aria-pressed={priorityOnly} onClick={() => onPriorityOnly(!priorityOnly)}><Target size={14} />只看已关注</button></div>
    {scopeLoading && <div className="career-scope-loading" role="status"><LoaderCircle className="spin" size={16} />正在打开这部分记录…</div>}
    {scopeError && <div className="career-scope-error" role="alert"><ShieldCheck size={17} /><span>{scopeError}</span></div>}
    <div className="career-mobile-job-list">{jobs.map((job) => { const stage = data.stages.find((item) => item.id === job.stage_id); const next = resolveCareerJobNextItem(job.id, data.tasks, data.interviews, now); return <article className="career-mobile-job-card" key={job.id}><button onClick={() => onSelectJob(job.id)} aria-label={`打开 ${job.company} ${job.role}`}><header><CompanyMark company={job.company} small /><span><b>{job.role}</b><small>{job.company}</small></span><ChevronRight size={18} /></header><div className="career-mobile-job-meta"><span className="career-stage-pill"><i style={{ background: stage?.color }} />{stage?.name}</span><SourceBadge source={job.source} /><span>{job.location || "地点待确认"}</span></div><div className="career-mobile-job-next"><Clock3 size={14} /><span>{careerJobNextLabel(next, now) ?? "还没有明确安排下一步"}</span></div></button></article>; })}{!scopeLoading && jobs.length === 0 && <EmptyState icon={<Inbox />} title={emptyCopy.title} text={emptyCopy.text} />}</div>
    <div className="career-table-wrap"><table className="career-table"><thead><tr><th>职位</th><th>阶段</th><th>来源</th><th>地点</th><th>投递时间</th><th>下一步</th><th /></tr></thead><tbody>{jobs.map((job) => { const stage = data.stages.find((item) => item.id === job.stage_id); const next = resolveCareerJobNextItem(job.id, data.tasks, data.interviews, now); return <tr key={job.id}><td><button className="career-job-row-button" onClick={() => onSelectJob(job.id)}><span className="career-job-cell"><CompanyMark company={job.company} small /><span><b>{job.role}</b><small>{job.company}</small></span></span></button></td><td><span className="career-stage-pill"><i style={{ background: stage?.color }} />{stage?.name}</span></td><td><SourceBadge source={job.source} /></td><td>{job.location || "—"}</td><td>{job.applied_at ? formatDate(job.applied_at) : "尚未投递"}</td><td>{careerJobNextLabel(next, now) ?? "还没有明确安排下一步"}</td><td><button className="career-row-open" onClick={() => onSelectJob(job.id)} aria-label={`打开 ${job.company} ${job.role}`}><ChevronRight size={16} /></button></td></tr>; })}</tbody></table>{!scopeLoading && jobs.length === 0 && <EmptyState icon={<Inbox />} title={emptyCopy.title} text={emptyCopy.text} />}</div>
  </div>;
}

function CalendarView({ data: sourceData, now, onOpenTask, onCompleteTask, onAddTask, onAddInterview, onSelectInterview }: { data: CareerData; now: number; onOpenTask: (id: string) => void; onCompleteTask: (task: Task) => void | Promise<void>; onAddTask: () => void; onAddInterview: () => void; onSelectInterview: (id: string) => void }) {
  const data = { ...sourceData, interviews: sourceData.interviews.filter((item) => item.status === "scheduled") };
  const [mode, setMode] = useState<"agenda" | "week">("agenda");
  const [showCompleted, setShowCompleted] = useState(false);
  const [showPaused, setShowPaused] = useState(false);
  const [selectedDay, setSelectedDay] = useState(() => localDayKey(now));
  const open = data.tasks.filter((task) => task.status === "todo").sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"));
  const completed = data.tasks.filter((task) => task.status === "done").sort((a, b) => (b.due_at ?? b.created_at).localeCompare(a.due_at ?? a.created_at));
  const paused = data.tasks.filter((task) => task.status === "canceled").sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at));
  const grouped = {
    today: open.filter((task) => resolveCareerTaskDateGroup(task.due_at, now) === "today"),
    past: open.filter((task) => resolveCareerTaskDateGroup(task.due_at, now) === "past"),
    future: open.filter((task) => resolveCareerTaskDateGroup(task.due_at, now) === "future"),
    unscheduled: open.filter((task) => resolveCareerTaskDateGroup(task.due_at, now) === "unscheduled"),
  };
  const days = Array.from({ length: 7 }, (_, index) => { const date = new Date(now); date.setDate(date.getDate() + index); date.setHours(0, 0, 0, 0); return date; });
  const taskGroup = (key: keyof typeof grouped, title: string, description?: string) => grouped[key].length > 0 && <section className={`career-task-group ${key}`}><header><h3>{title}</h3>{description && <p>{description}</p>}</header><div>{grouped[key].map((task) => <CareerTaskRow key={task.id} task={task} data={data} now={now} onOpen={onOpenTask} onComplete={onCompleteTask} />)}</div></section>;
  const selectedTasks = open.filter((task) => task.due_at && localDayKey(task.due_at) === selectedDay);
  const selectedInterviews = data.interviews.filter((item) => item.scheduled_at && localDayKey(item.scheduled_at) === selectedDay);
  return <div className="career-view"><SectionHeading eyebrow="PLAN" title="待办与日历" description="安排可以放下，也可以重新拾起。时间经过不会被写成你的欠账。" action={<div className="career-view-actions"><button className="career-button secondary" onClick={onAddInterview}><CalendarDays size={16} />安排面试</button><button className="career-button primary" onClick={onAddTask}><Plus size={16} />新建待办</button></div>} /><div className="career-segmented"><button className={mode === "agenda" ? "active" : ""} onClick={() => setMode("agenda")}>议程</button><button className={mode === "week" ? "active" : ""} onClick={() => setMode("week")}>未来 7 天</button></div>
    {mode === "agenda" ? <div className="career-plan-grid"><section className="career-panel career-task-list"><header><h3>待办清单</h3><span>按你安排过的时间整理</span></header>{taskGroup("today", "今天")}{taskGroup("past", "原计划更早", "这些安排的时间已经过去。可以重新安排，也可以放下；它们不代表你做得不够好。")}{taskGroup("future", "接下来")}{taskGroup("unscheduled", "以后再说")}{open.length === 0 && <p className="career-task-calm-empty">目前没有待办。需要时再记录下一步就好。</p>}{completed.length > 0 && <div className="career-completed-block"><button className="career-completed-toggle" onClick={() => setShowCompleted((current) => !current)} aria-expanded={showCompleted}><span><CheckCircle2 size={15} />已完成</span><small>{showCompleted ? "收起" : "查看"}</small><ChevronRight size={15} /></button>{showCompleted && <div className="career-completed-list">{completed.map((task) => <CareerTaskRow key={task.id} task={task} data={data} now={now} onOpen={onOpenTask} onComplete={onCompleteTask} />)}</div>}</div>}{paused.length > 0 && <div className="career-completed-block"><button className="career-completed-toggle" onClick={() => setShowPaused((current) => !current)} aria-expanded={showPaused}><span><Circle size={15} />已放下与暂停</span><small>{showPaused ? "收起" : "查看"}</small><ChevronRight size={15} /></button>{showPaused && <div className="career-completed-list">{paused.map((task) => <CareerTaskRow key={task.id} task={task} data={data} now={now} onOpen={onOpenTask} onComplete={onCompleteTask} />)}</div>}</div>}</section><section className="career-panel career-upcoming"><header><h3>面试日程</h3><span>按时间排序</span></header>{data.interviews.map((item) => { const job = data.jobs.find((entry) => entry.id === item.job_id); const context = careerJobContext(job, data.stages); return <button key={item.id} onClick={() => onSelectInterview(item.id)}><time><b>{new Date(item.scheduled_at ?? "").getDate() || "—"}</b><small>{formatDate(item.scheduled_at)}</small></time><span><b>{job?.company} · {item.round_name}</b><small>{formatDate(item.scheduled_at, true)} · {item.duration} 分钟{context && <i className="career-action-context">{context}</i>}</small></span><ChevronRight size={16} /></button>; })}{data.interviews.length === 0 && <p className="career-task-calm-empty">还没有安排面试，需要时再记录。</p>}</section></div> : <><div className="career-week-grid">{days.map((day) => { const key = localDayKey(day); const tasks = open.filter((task) => task.due_at && localDayKey(task.due_at) === key); const interviews = data.interviews.filter((item) => item.scheduled_at && localDayKey(item.scheduled_at) === key); return <section key={key} className={key === localDayKey(now) ? "today" : ""}><header><span>{new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(day)}</span><b>{day.getDate()}</b></header><div>{interviews.map((item) => { const job = data.jobs.find((job) => job.id === item.job_id); const context = careerJobContext(job, data.stages); return <button className="career-week-entry event" key={item.id} onClick={() => onSelectInterview(item.id)}><CalendarDays size={13} /><b>{job?.company}</b><small>{item.round_name}</small>{context && <small className="career-action-context">{context}</small>}</button>; })}{tasks.map((task) => <button className="career-week-entry" key={task.id} onClick={() => onOpenTask(task.id)}><Circle size={12} /><b>{task.title}</b><small>{dateInputValue(task.due_at).slice(11)}</small></button>)}</div></section>; })}</div><div className="career-week-mobile"><div className="career-week-day-picker" aria-label="选择日期">{days.map((day) => { const key = localDayKey(day); return <button key={key} className={selectedDay === key ? "active" : ""} aria-pressed={selectedDay === key} onClick={() => setSelectedDay(key)}><span>{new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(day)}</span><b>{day.getDate()}</b></button>; })}</div><section className="career-week-selected" aria-live="polite">{selectedInterviews.map((item) => { const job = data.jobs.find((entry) => entry.id === item.job_id); return <button key={item.id} onClick={() => onSelectInterview(item.id)}><CalendarDays size={16} /><span><b>{job?.company} · {item.round_name}</b><small>{formatDate(item.scheduled_at, true)}</small></span><ChevronRight size={16} /></button>; })}{selectedTasks.map((task) => <CareerTaskRow key={task.id} task={task} data={data} now={now} onOpen={onOpenTask} onComplete={onCompleteTask} compact />)}{selectedInterviews.length === 0 && selectedTasks.length === 0 && <p>这一天没有安排。</p>}</section><button className="career-text-button career-unscheduled-link" onClick={() => setMode("agenda")}>查看“以后再说”</button></div></>}
  </div>;
}

function InterviewsView({ data, now, onAdd, onSelect, onAi }: { data: CareerData; now: number; onAdd: () => void; onSelect: (id: string) => void; onAi: (action: AiAction, title: string, payload: unknown) => void }) {
  const [tab, setTab] = useState<"upcoming" | "archive">("upcoming");
  const shown = data.interviews.filter((item) => tab === "archive" ? item.status !== "scheduled" : item.status === "scheduled");
  return <div className="career-view">
    <SectionHeading eyebrow="INTERVIEW LOG" title="面试与面经" description="每一轮都有准备、有记录，也有下一次会用到的经验" action={<button className="career-button primary" onClick={onAdd}><Plus size={16} />安排面试</button>} />
    <div className="career-segmented" aria-label="面试记录范围"><button className={tab === "upcoming" ? "active" : ""} aria-pressed={tab === "upcoming"} onClick={() => setTab("upcoming")}>即将进行</button><button className={tab === "archive" ? "active" : ""} aria-pressed={tab === "archive"} onClick={() => setTab("archive")}>面经档案</button></div>
    <div className="career-interview-grid">{shown.map((item) => {
      const job = data.jobs.find((entry) => entry.id === item.job_id);
      const questions = parseQuestions(item.questions_json);
      const title = `${job?.company ?? "待确认公司"} · ${item.round_name}`;
      const lifecyclePaused = isCareerLifecyclePaused(item);
      return <article className="career-interview-card" key={item.id}>
        <header><CompanyMark company={job?.company ?? "职"} /><div><span>{item.status === "completed" ? "已完成" : lifecyclePaused ? "随职位暂停" : item.status === "canceled" ? "已取消" : relativeDate(item.scheduled_at, now)}</span><h3>{title}</h3><p>{job?.role}</p></div><button className="career-icon-button" onClick={() => onSelect(item.id)} aria-label={`打开 ${title} 面经`}><ArrowUpRight size={17} /></button></header>
        <div className="career-interview-meta"><span><CalendarDays size={14} />{formatDate(item.scheduled_at, true)}</span><span><Clock3 size={14} />{item.duration} 分钟</span><span><UserRound size={14} />{item.interviewer || "面试官待确认"}</span></div>
        {item.status === "scheduled" ? <div className="career-interview-ai"><div className="career-interview-actions"><button className="career-button secondary career-ai-trigger" onClick={() => onAi("interview_prep", "生成面试准备包", { job, interview: item })}><Sparkles size={15} />AI 准备包</button>{safeLink(item.meeting_url) && <a className="career-button ghost" href={item.meeting_url} target="_blank" rel="noreferrer">加入会议 <ExternalLink size={14} /></a>}</div><CareerAiDisclosure action="interview_prep" /></div> : <div className="career-experience-preview"><p>{lifecyclePaused ? item.summary || "这轮面试随职位暂停，记录仍完整保留。" : item.status === "canceled" ? item.summary || "这轮面试已取消。" : item.summary || "可随时补充这轮面试的记录。"}</p>{item.status === "completed" && (questions.length > 0 || item.reflection) && <footer>{questions.length > 0 && <span>{questions.length} 个问题</span>}{item.reflection && <span>已记录复盘</span>}</footer>}</div>}
      </article>;
    })}</div>
    {shown.length === 0 && <EmptyState icon={<MessageSquareText />} title={tab === "archive" ? "还没有面经" : "暂未安排面试"} text="记录每一轮问题、回答和复盘，让经验真正沉淀下来。" action={<button className="career-button primary" onClick={onAdd}>安排第一轮</button>} />}
  </div>;
}

function ContactsView({ data, now, revision, externalHint, onAdd, onSelect }: { data: CareerData; now: number; revision: number; externalHint: string; onAdd: () => void; onSelect: (contactId: string, opener: HTMLButtonElement) => void }) {
  const [scope, setScope] = useState<"active" | "archived">("active");
  const [archived, setArchived] = useState<Contact[]>([]);
  const [details, setDetails] = useState<Record<string, CareerContactDetail>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, true>>({});
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState("");
  const [readRevision, setReadRevision] = useState(0);
  const contacts = scope === "active" ? data.contacts : archived;

  useEffect(() => {
    let live = true;
    void (async () => {
      setReadError("");
      const list = scope === "active" ? data.contacts : await loadCareerContacts("archived");
      const loaded = await Promise.allSettled(list.map((contact) => loadCareerContactDetail(contact.id)));
      if (!live) return;
      if (scope === "archived") setArchived(list);
      setDetails((current) => ({ ...current, ...Object.fromEntries(loaded.flatMap((item) => item.status === "fulfilled" && item.value ? [[item.value.contact.id, item.value]] : [])) }));
      setDetailErrors(Object.fromEntries(loaded.flatMap((item, index) => item.status === "rejected" ? [[list[index].id, true]] : [])));
      setLoading(false);
    })().catch(() => { if (live) { setReadError("联系人列表暂时没有打开。已有资料不会因此变成空记录。"); setLoading(false); } });
    return () => { live = false; };
  }, [data.contacts, readRevision, revision, scope]);

  return <div className="career-view"><SectionHeading eyebrow="RELATIONSHIPS" title="联系人" description="只记录真实发生的沟通，以及你愿意安排的下一步" action={<button className="career-button primary" onClick={onAdd}><Plus size={16} />添加联系人</button>} /><div className="career-segmented" aria-label="联系人范围"><button className={scope === "active" ? "active" : ""} aria-pressed={scope === "active"} onClick={() => { if (scope !== "active") { setLoading(true); setScope("active"); } }}>联系人</button><button className={scope === "archived" ? "active" : ""} aria-pressed={scope === "archived"} onClick={() => { if (scope !== "archived") { setLoading(true); setScope("archived"); } }}>已归档</button></div>{externalHint && <div className="career-contact-external-hint" role="status"><ShieldCheck size={17} /><span>{externalHint}</span></div>}{readError && <div className="career-scope-error" role="alert"><ShieldCheck size={17} /><span>{readError}</span><button onClick={() => { setLoading(true); setReadRevision((current) => current + 1); }}>重新读取</button></div>}{loading && contacts.length === 0 ? <div className="career-contact-loading"><LoaderCircle className="spin" size={18} />正在打开联系人…</div> : <div className="career-contact-grid">{contacts.map((contact) => {
    const detail = details[contact.id];
    const latest = detail?.interactions[0];
    const next = detail?.tasks.filter((task) => task.status === "todo").sort((left, right) => (left.due_at ?? "9999").localeCompare(right.due_at ?? "9999"))[0];
    const jobs = detail?.jobs.slice(0, 2) ?? [];
    const detailFailed = detailErrors[contact.id];
    const identity = [contact.role, contact.company].filter(Boolean).join(" · ");
    return <article className="career-contact-card" key={contact.id}><button className="career-contact-open" data-contact-id={contact.id} onClick={(event) => onSelect(contact.id, event.currentTarget)} aria-label={`打开联系人 ${contact.name}`}><header><span className="career-contact-avatar">{initials(contact.name)}</span><div><h3>{contact.name}</h3>{identity && <p>{identity}</p>}</div><ChevronRight size={18} /></header>{jobs.length > 0 && <div className="career-contact-jobs">{jobs.map((job) => <span key={job.id}>{job.company} · {job.role}</span>)}</div>}<div className="career-contact-truth">{detailFailed ? <><span><ContactRound size={14} />相关记录暂时没有读到</span><span><CalendarDays size={14} />没有把它当成“没有安排”</span></> : <><span><ContactRound size={14} />{latest ? `${formatDate(latest.occurred_at)} · ${latest.channel || "已记录沟通"}` : "等一次真实沟通"}</span><span><CalendarDays size={14} />{next ? `${formatCareerTaskDate(next.due_at, now)} · ${next.title}` : "没有安排下一步"}</span></>}</div></button></article>;
  })}</div>}{!loading && !readError && contacts.length === 0 && <EmptyState icon={<UsersRound />} title={scope === "archived" ? "归档里很安静" : "还没有联系人"} text={scope === "archived" ? "移入归档的联系人会保留全部历史，也可以随时恢复。" : "不需要为了数量而添加。下一次真实认识某个人时，再把关系记下来。"} action={scope === "active" ? <button className="career-button primary" onClick={onAdd}>添加第一位联系人</button> : undefined} />}</div>;
}

function careerMaterialStatusText(status: string) {
  if (status === "deleting") return "待收尾";
  if (status === "sent") return "已发送";
  if (status === "draft") return "编辑中";
  if (status === "ready") return "可使用";
  return "状态待确认";
}

function careerMaterialFileDetails(fileName: string, byteSize: number | null | undefined) {
  if (!Number.isSafeInteger(byteSize) || Number(byteSize) <= 0) return `${fileName} · 大小未记录`;
  const bytes = Number(byteSize);
  if (bytes < 1024) return `${fileName} · ${bytes} B`;
  const kilobytes = bytes / 1024;
  return `${fileName} · ${kilobytes >= 10 ? Math.round(kilobytes) : Number(kilobytes.toFixed(1))} KB`;
}

function MaterialsView({ data, stale, refreshBusy, recoveryLoaded, recoveryCount, recoveryUnreadable, recoveryStorageUnavailable, onRefresh, onAdd, onRecover, onClearUnreadable, onRetryRecoveryStorage, onRemove, notify }: { data: CareerData; stale: boolean; refreshBusy: boolean; recoveryLoaded: boolean; recoveryCount: number; recoveryUnreadable: boolean; recoveryStorageUnavailable: boolean; onRefresh: () => Promise<void>; onAdd: () => void; onRecover: () => void; onClearUnreadable: () => void; onRetryRecoveryStorage: () => void; onRemove: (material: Material, opener: HTMLButtonElement) => void; notify: (text: string, tone?: Notice["tone"]) => void }) {
  const recoveryLocked = !recoveryLoaded || recoveryCount > 0 || recoveryUnreadable || recoveryStorageUnavailable;
  const actionsLocked = stale || recoveryLocked;
  async function openFile(fileKey: string) {
    try {
      const object = await createLocalFileObjectUrl("career", fileKey);
      const anchor = document.createElement("a");
      anchor.href = object.url;
      anchor.download = object.metadata.originalName;
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      anchor.click();
      window.setTimeout(() => object.revoke(), 30_000);
    } catch {
      notify("附件原件暂时没有打开；材料记录没有改动。", "error");
    }
  }
  return <div className="career-view">
    <SectionHeading eyebrow="MATERIALS" title="求职材料" description="保留每一个版本，也记住哪一份发给了谁" action={<button className="career-button primary" data-material-add disabled={actionsLocked} onClick={onAdd}><Plus size={16} />添加材料</button>} />
    {stale && <div className="career-material-stale" role="status"><ShieldCheck size={20} /><div><b>材料列表需要重新读取</b><p>刚才的本机操作可能已完成；在读取最新状态前，材料按钮会暂时停用，避免重复保存或移除。</p></div><button className="career-button primary" data-material-refresh disabled={refreshBusy} onClick={() => { void onRefresh().catch(() => notify("材料列表暂时没有读到最新状态；不会重复保存或移除。", "error")); }}>{refreshBusy ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}{refreshBusy ? "正在读取…" : "重新读取"}</button></div>}
    {!stale && !recoveryLoaded && <div className="career-material-recovery-banner" role="status"><LoaderCircle className="spin" size={20} /><div><b>正在核对附件收尾记录</b><p>核对完成前先不开放新附件，避免重复写入。</p></div></div>}
    {!stale && recoveryLoaded && recoveryCount > 0 && <div className="career-material-recovery-banner" role="status"><ShieldCheck size={20} /><div><b>有材料保存需要继续核对</b><p>{recoveryStorageUnavailable ? "这条核对线索目前只留在本次打开的页面；刷新前请先继续收尾。" : "先把已有保存核对清楚，再开放新的附件；不会重复上传或盲目删除原件。"}</p></div><button className="career-button primary" data-material-recover onClick={onRecover}><RotateCcw size={16} />继续核对与收尾</button></div>}
    {!stale && recoveryLoaded && recoveryCount === 0 && recoveryUnreadable && <div className="career-material-recovery-banner warning" role="status"><ShieldCheck size={20} /><div><b>有一条旧的收尾线索无法验证</b><p>系统没有据此删除任何原件。你可以明确保留原件，并只清除这条不可用的提醒。</p></div><button className="career-button secondary" data-material-recovery-clear onClick={onClearUnreadable}>保留原件并清除提醒</button></div>}
    {!stale && recoveryLoaded && recoveryCount === 0 && !recoveryUnreadable && recoveryStorageUnavailable && <div className="career-material-recovery-banner warning" role="status"><ShieldCheck size={20} /><div><b>暂时无法读取附件收尾记录</b><p>为避免重复写入，新建材料暂时停用；现有材料没有改动。</p></div><button className="career-button secondary" data-material-recovery-retry onClick={onRetryRecoveryStorage}><RotateCcw size={16} />重新检查</button></div>}
    <div className="career-material-grid">
      {data.materials.map((material) => {
        const job = data.jobs.find((item) => item.id === material.linked_job_id);
        const cleanupPending = material.status === "deleting";
        const statusText = careerMaterialStatusText(material.status);
        return <article className={`career-material-card ${cleanupPending ? "cleanup-pending" : ""}`} key={material.id}>
          <span className={`career-file-icon ${material.kind}`}><FileText size={23} /></span>
          <div>
            <header><span>{material.kind}</span><em className={material.status}>{statusText}</em>{material.file_key && !cleanupPending && <em className="attached">已关联本机原件</em>}</header>
            <h3>{material.name}</h3>
            <p>{cleanupPending ? "上次移除还在收尾；继续时会重新核对原件状态与其他引用。" : material.notes}</p>
            <footer><span>{material.version} · 更新于 {formatDate(material.updated_at)}</span>{job && <small>用于 {job.company}</small>}{material.file_name && !cleanupPending && <small>{careerMaterialFileDetails(material.file_name, material.byte_size)}</small>}{cleanupPending && <small>原件状态会在继续收尾时核对</small>}</footer>
          </div>
          <div className="career-material-actions">
            {cleanupPending
              ? <button className="career-button secondary" disabled={actionsLocked} onClick={(event) => onRemove(material, event.currentTarget)}><RotateCcw size={15} />继续收尾</button>
              : <>{material.file_key
                ? <button className="career-icon-button" disabled={stale} onClick={() => void openFile(material.file_key!)} aria-label={`打开 ${material.file_name ?? material.name}`}><Download size={17} /></button>
                : <button className="career-button ghost" disabled={actionsLocked} onClick={onAdd}>新建带附件版本</button>}
                <button className="career-icon-button danger" disabled={actionsLocked} onClick={(event) => onRemove(material, event.currentTarget)} aria-label={`移除 ${material.name}`}><Trash2 size={16} /></button></>}
          </div>
        </article>;
      })}
      {!stale && !recoveryLocked && data.materials.length === 0 && <EmptyState icon={<FileText />} title="还没有材料版本" text="需要保存一份真实材料时再添加；空白不会影响其他求职记录。" action={<button className="career-button primary" data-material-add onClick={onAdd}>添加第一份材料</button>} />}
    </div>
  </div>;
}

function AnalyticsView({ data, now }: { data: CareerData; now: number }) {
  const jobsById = new Map(data.jobs.map((job) => [job.id, job]));
  const stagesById = new Map(data.stages.map((stage) => [stage.id, stage]));
  const terminalStageIds = new Set(data.stages.filter((stage) => stage.is_terminal === 1).map((stage) => stage.id));
  const activeJobs = data.jobs
    .filter((job) => job.archived !== 1 && !terminalStageIds.has(job.stage_id))
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const settledJobs = data.jobs
    .filter((job) => job.archived === 1 || terminalStageIds.has(job.stage_id))
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const scheduled = [
    ...data.tasks.flatMap((task) => {
      const timestamp = task.due_at ? new Date(task.due_at).getTime() : Number.NaN;
      return task.status === "todo" && Number.isFinite(timestamp) && timestamp >= now
        ? [{ kind: "task" as const, id: task.id, at: task.due_at!, title: task.title, jobId: task.job_id }]
        : [];
    }),
    ...data.interviews.flatMap((interview) => {
      const timestamp = interview.scheduled_at ? new Date(interview.scheduled_at).getTime() : Number.NaN;
      return interview.status === "scheduled" && Number.isFinite(timestamp) && timestamp >= now
        ? [{ kind: "interview" as const, id: interview.id, at: interview.scheduled_at!, title: interview.round_name, jobId: interview.job_id }]
        : [];
    }),
  ].sort((left, right) => left.at.localeCompare(right.at));
  const reflections = data.interviews
    .filter((item) => item.status === "completed" && (item.summary.trim() || item.reflection.trim() || parseQuestions(item.questions_json).length > 0))
    .sort((left, right) => (right.scheduled_at ?? "").localeCompare(left.scheduled_at ?? ""));
  return <div className="career-view career-reflection-view">
    <SectionHeading eyebrow="REFLECTION" title="过程回顾" description="回看已经发生的事实，不统计你做得够不够多" action={<span className="career-no-score-note"><ShieldCheck size={15} />没有结果评分</span>} />
    <p className="career-reflection-care-note"><ShieldCheck size={17} /><span>等待有时会很长。这里不把 Offer 或阶段当成你的分数，也不会因为一段时间没有变化就催你推进。</span></p>
    <section className="career-panel career-reflection-places">
      <header><span><BriefcaseBusiness size={17} /></span><div><h3>职位现在放在哪里</h3><p>阶段和来源只帮你找回上下文，不代表做得好或不好。</p></div></header>
      <div className="career-reflection-place-list" role="list" aria-label="进行中的职位位置">{activeJobs.slice(0, 6).map((job) => { const stage = stagesById.get(job.stage_id); return <article role="listitem" key={job.id}><CompanyMark company={job.company} small decorative /><div><b>{job.company} · {job.role}</b><small>进行中的记录</small></div><span><i style={{ background: stage?.color }} />阶段 · {stage?.name || "待确认"}</span><span className="career-reflection-source">来源 · {job.source.trim() || "未记录"}</span></article>; })}{activeJobs.length === 0 && <p className="career-calm-empty">{settledJobs.length > 0 ? "现在没有进行中的职位。结束或收起只是记录状态，不是对你的结论。" : "还没有职位记录。遇到想记住的机会时再添加，不需要先填满这里。"}</p>}</div>
      {activeJobs.length > 6 && <p className="career-reflection-more-note">这里只先展示最近有变化的记录；其余仍完整保留在“职位”里。</p>}
      {settledJobs.length > 0 && <details className="career-reflection-settled"><summary><span><Archive size={16} /><span><b>已结束与已归档</b><small>按需展开；记录仍完整保留</small></span></span><ChevronRight size={17} /></summary><div className="career-reflection-place-list" role="list" aria-label="已结束与已归档的职位位置">{settledJobs.slice(0, 6).map((job) => { const stage = stagesById.get(job.stage_id); return <article role="listitem" key={job.id}><CompanyMark company={job.company} small decorative /><div><b>{job.company} · {job.role}</b><small>{job.archived === 1 ? "已归档 · 只是收好记录" : "已结束 · 只记录结果"}</small></div><span><i style={{ background: stage?.color }} />阶段 · {stage?.name || "待确认"}</span><span className="career-reflection-source">来源 · {job.source.trim() || "未记录"}</span></article>; })}</div>{settledJobs.length > 6 && <p className="career-reflection-more-note">这里只先展示最近有变化的记录；其余仍完整保留在“职位”里。</p>}</details>}
    </section>
    <div className="career-reflection-grid">
      <section className="career-panel career-reflection-next"><header><span><CalendarDays size={17} /></span><div><h3>接下来已明确安排</h3><p>只显示你自己定过时间的待办和面试。</p></div></header><div>{scheduled.slice(0, 5).map((item) => { const job = item.jobId ? jobsById.get(item.jobId) : null; const stage = job ? stagesById.get(job.stage_id) : null; const context = job?.archived === 1 ? "职位已归档" : stage?.is_terminal === 1 ? "职位已结束" : stage?.name || "阶段待确认"; return <article key={`${item.kind}:${item.id}`}><span>{item.kind === "interview" ? <MessageSquareText size={15} /> : <ListTodo size={15} />}</span><div><b>{item.title}</b><small>{job ? `${job.company} · ${context}` : "个人待办"}</small></div><time>{formatDate(item.at, true)}</time></article>; })}{scheduled.length === 0 && <p className="career-calm-empty">没有已经定下时间的安排。这里不会替你补一个“应该做”的下一步。</p>}</div></section>
      <section className="career-panel career-reflection-facts"><header><span><Zap size={17} /></span><div><h3>最近发生的事</h3><p>这里只按时间保留变化，不排名，也不计算转化。</p></div></header><div>{data.activities.slice(0, 6).map((item) => { const job = item.job_id ? jobsById.get(item.job_id) : null; return <article key={item.id}><span className={`career-activity-icon ${item.type}`}><Zap size={14} /></span><div><b>{neutralActivityDetail(item.detail)}</b><small>{job ? `${job.company} · ${job.role}` : "职迹"}</small></div><time>{formatDate(item.created_at)}</time></article>; })}{data.activities.length === 0 && <p className="career-calm-empty">还没有变化需要回看。页面安静并不代表你落后。</p>}</div></section>
    </div>
    <section className="career-panel career-reflection-notes"><header><span><MessageSquareText size={17} /></span><div><h3>最近想保留的面经</h3><p>只摘录你亲自写下的内容，不用数量衡量是否复盘充分。</p></div></header><div>{reflections.slice(0, 3).map((interview) => { const job = jobsById.get(interview.job_id); const note = interview.summary.trim() || interview.reflection.trim() || "已保留问题与回答。"; return <article key={interview.id}><div><b>{job ? `${job.company} · ${interview.round_name}` : interview.round_name}</b><small>{job?.role || "职位待确认"} · {formatDate(interview.scheduled_at)}</small></div><p>{note}</p></article>; })}{reflections.length === 0 && <p className="career-calm-empty">还没有想留在这里的面经。什么时候愿意写，再写也来得及。</p>}</div></section>
  </div>;
}

function SettingsView({ data, onRefresh, onExport, notify }: {
  data: CareerData;
  onRefresh: () => Promise<void>;
  onExport: () => Promise<void>;
  notify: (text: string, tone?: Notice["tone"]) => void;
}) {
  const [savingStage, setSavingStage] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [backupPrepareStopping, setBackupPrepareStopping] = useState(false);
  const [backupFlow, setBackupFlow] = useState<CareerBackupFlow>({ phase: "idle" });
  const [persistedBackupRecoveries, setPersistedBackupRecoveries] = useState<CareerBackupRecoveryEntry[]>([]);
  const [volatileBackupRecoveries, setVolatileBackupRecoveries] = useState<CareerBackupRecoveryEntry[]>([]);
  const [backupRecoveryUnreadableKeys, setBackupRecoveryUnreadableKeys] = useState<string[]>([]);
  const [backupRecoveryStorageUnavailable, setBackupRecoveryStorageUnavailable] = useState(false);
  const [backupRecoveryLoaded, setBackupRecoveryLoaded] = useState(false);
  const [aiHealth, setAiHealth] = useState<{ status: "checking" | "configured" | "missing" | "error"; model: string }>({ status: "checking", model: "" });
  const backupOperationRef = useRef(false);
  const backupPrepareControllerRef = useRef<AbortController | null>(null);
  const allowInitialBackupResumeRef = useRef(true);
  const handledBackupTicketRef = useRef("");
  const backupFlowHeadingRef = useRef<HTMLHeadingElement>(null);
  const backupFileInputRef = useRef<HTMLInputElement>(null);
  const backupPickerButtonRef = useRef<HTMLButtonElement>(null);
  const durableBackupRecoveryKeysRef = useRef<Set<string>>(new Set());

  const reloadBackupRecoveries = useCallback(() => {
    const result = readCareerBackupRecoveryStorage();
    if (!result.storageUnavailable) {
      durableBackupRecoveryKeysRef.current = new Set([
        ...result.entries.map((entry) => entry.storageKey),
        ...result.unreadableKeys,
      ]);
    }
    setPersistedBackupRecoveries(result.entries);
    setBackupRecoveryUnreadableKeys(result.unreadableKeys);
    setBackupRecoveryStorageUnavailable(result.storageUnavailable);
    setBackupRecoveryLoaded(true);
  }, []);

  const backupRecoveryEntries = useMemo(() => {
    const byKey = new Map<string, CareerBackupRecoveryEntry>();
    for (const entry of persistedBackupRecoveries) byKey.set(entry.storageKey, entry);
    for (const entry of volatileBackupRecoveries) byKey.set(entry.storageKey, entry);
    return [...byKey.values()].sort((left, right) =>
      careerBackupRecoveryPriority(left.ticket) - careerBackupRecoveryPriority(right.ticket) ||
      left.ticket.recordedAt.localeCompare(right.ticket.recordedAt));
  }, [persistedBackupRecoveries, volatileBackupRecoveries]);
  const activeBackupRecovery = backupRecoveryEntries[0] ?? null;
  const backupStorageNeedsAttention = backupRecoveryStorageUnavailable || volatileBackupRecoveries.length > 0;
  const backupFlowBusy = backupFlow.phase === "preparing" || backupFlow.phase === "checking" ||
    backupFlow.phase === "activating" || backupFlow.phase === "discarding" || backupFlow.phase === "cleaning";
  const backupWriteLocked = !backupRecoveryLoaded || backupFlowBusy || Boolean(activeBackupRecovery) ||
    backupRecoveryUnreadableKeys.length > 0 || backupStorageNeedsAttention;

  const persistBackupRecovery = useCallback((ticket: CareerBackupRecoveryTicket) => {
    const storageKey = careerBackupRecoveryStorageKey(ticket);
    const entry = { storageKey, ticket, persisted: true } satisfies CareerBackupRecoveryEntry;
    try {
      const serialized = JSON.stringify(ticket);
      if (serialized.length > CAREER_BACKUP_RECOVERY_MAX_BYTES) throw new Error("recovery ticket is too large");
      window.localStorage.setItem(storageKey, serialized);
      durableBackupRecoveryKeysRef.current.add(storageKey);
      setPersistedBackupRecoveries((current) => [...current.filter((item) => item.storageKey !== storageKey), entry]);
      setVolatileBackupRecoveries((current) => current.filter((item) => item.storageKey !== storageKey));
      return true;
    } catch {
      setVolatileBackupRecoveries((current) => [
        ...current.filter((item) => item.storageKey !== storageKey),
        { storageKey, ticket, persisted: false },
      ]);
      setBackupRecoveryStorageUnavailable(true);
      return false;
    }
  }, []);

  const removeBackupRecoveryKeys = useCallback((storageKeys: readonly string[]) => {
    const cleared = new Set<string>();
    let failed = false;
    for (const storageKey of storageKeys) {
      if (!durableBackupRecoveryKeysRef.current.has(storageKey)) {
        cleared.add(storageKey);
        continue;
      }
      try {
        window.localStorage.removeItem(storageKey);
        cleared.add(storageKey);
      } catch {
        failed = true;
      }
    }
    if (cleared.size > 0) {
      cleared.forEach((storageKey) => durableBackupRecoveryKeysRef.current.delete(storageKey));
      setPersistedBackupRecoveries((current) => current.filter((entry) => !cleared.has(entry.storageKey)));
      setVolatileBackupRecoveries((current) => current.filter((entry) => !cleared.has(entry.storageKey)));
      setBackupRecoveryUnreadableKeys((current) => current.filter((key) => !cleared.has(key)));
    }
    if (failed) setBackupRecoveryStorageUnavailable(true);
    return !failed;
  }, []);

  function removeBackupRecoveryFor(receipt: CareerRestoreReceipt | CareerPrepareRecoveryReceipt | CareerPrepareCleanupReceipt) {
    return removeBackupRecoveryKeys([`${CAREER_BACKUP_RECOVERY_PREFIX}operation:${receipt.generationId}`]);
  }

  function markBackupRecoveryUnreadable(storageKey: string) {
    durableBackupRecoveryKeysRef.current.add(storageKey);
    setPersistedBackupRecoveries((current) => current.filter((entry) => entry.storageKey !== storageKey));
    setVolatileBackupRecoveries((current) => current.filter((entry) => entry.storageKey !== storageKey));
    setBackupRecoveryUnreadableKeys((current) => current.includes(storageKey) ? current : [...current, storageKey]);
  }

  useEffect(() => {
    const initialFrame = window.requestAnimationFrame(reloadBackupRecoveries);
    function onStorage(event: StorageEvent) {
      if (!event.key || event.key.startsWith(CAREER_BACKUP_RECOVERY_PREFIX)) {
        allowInitialBackupResumeRef.current = false;
        reloadBackupRecoveries();
      }
    }
    function onFocus() {
      allowInitialBackupResumeRef.current = false;
      reloadBackupRecoveries();
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    return () => {
      window.cancelAnimationFrame(initialFrame);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
    };
  }, [reloadBackupRecoveries]);

  useEffect(() => {
    if (backupFlow.phase !== "preparing" && volatileBackupRecoveries.length === 0) return;
    function protectUnfinishedRestore(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", protectUnfinishedRestore);
    return () => window.removeEventListener("beforeunload", protectUnfinishedRestore);
  }, [backupFlow.phase, volatileBackupRecoveries.length]);

  useEffect(() => {
    if (backupFlow.phase === "idle") return;
    const frame = window.requestAnimationFrame(() => backupFlowHeadingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [backupFlow.phase]);

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

  async function rename(stage: Stage, name: string) {
    if (!name.trim() || name === stage.name) return;
    setSavingStage(stage.id);
    try {
      await runCareerSql("UPDATE career_stages SET name = ? WHERE id = ?", [name.trim(), stage.id]);
      await onRefresh();
    } finally {
      setSavingStage(null);
    }
  }

  const aiStatusLabel = aiHealth.status === "checking" ? "正在检查" : aiHealth.status === "configured" ? "已配置" : aiHealth.status === "missing" ? "尚未配置" : "检查失败";

  async function copyHelper() {
    try {
      const careerAddress = new URL("/career", window.location.origin).toString();
      const bookmarklet = `javascript:(()=>{const t=window.getSelection()?.toString().trim()||'';const u=${JSON.stringify(careerAddress)}+'?capture='+encodeURIComponent(location.href)+'&text='+encodeURIComponent(t);window.open(u,'_blank')})()`;
      await navigator.clipboard.writeText(bookmarklet);
      notify("采集器已复制，会回到当前这一个职迹地址", "info");
    } catch {
      notify("浏览器暂时不允许复制，请在安全页面重试", "error");
    }
  }

  async function exportBackup() {
    setExportBusy(true);
    try { await onExport(); }
    finally { setExportBusy(false); }
  }

  function candidateTicket(receipt: CareerRestoreReceipt, mode: CareerBackupCandidateMode): CareerBackupRecoveryTicket {
    return { version: 1, kind: "candidate", mode, receipt, recordedAt: new Date().toISOString() };
  }

  function refreshTicket(receipt: CareerRestoreReceipt): CareerBackupRecoveryTicket {
    return { version: 1, kind: "refresh-only", receipt, recordedAt: new Date().toISOString() };
  }

  async function finishBackupRefresh(receipt: CareerRestoreReceipt, message: string) {
    persistBackupRecovery(refreshTicket(receipt));
    setBackupFlow({ phase: "refresh-only", receipt, message });
    try {
      await onRefresh();
      if (removeBackupRecoveryFor(receipt)) {
        handledBackupTicketRef.current = "";
        setBackupFlow({ phase: "idle" });
        notify("备份已经启用，页面资料也已重新读取");
        window.requestAnimationFrame(() => backupPickerButtonRef.current?.focus({ preventScroll: true }));
      } else {
        setBackupFlow({
          phase: "refresh-only",
          receipt,
          message: "备份已经启用，页面资料也已更新；本页暂时没能清除继续提醒。",
        });
      }
    } catch {
      setBackupFlow({
        phase: "refresh-only",
        receipt,
        message: "备份已经启用。页面暂时没有重新读到它，只需再刷新资料，不会重复启用。",
      });
    }
  }

  async function inspectCandidate(entry: CareerBackupRecoveryEntry) {
    if (entry.ticket.kind !== "candidate") return;
    const { receipt, mode } = entry.ticket;
    backupOperationRef.current = true;
    setBackupFlow({ phase: "checking", title: "正在核对当前版本", text: "只读取版本状态，不会再次启用或删除候选。" });
    try {
      const inspection = await inspectCareerRestoreActivation(receipt);
      if (inspection.status === "current") {
        await finishBackupRefresh(receipt, "这份备份已经启用，只需让页面重新读取资料。");
        return;
      }
      const baselineUnchanged = inspection.currentGenerationId === receipt.expectedCurrentGenerationId &&
        inspection.currentSequence === receipt.expectedCurrentSequence;
      if (mode === "review" && baselineUnchanged) {
        setBackupFlow({ phase: "review", receipt, message: "候选与当前职迹仍然匹配，请核对后再决定。" });
        return;
      }
      const next = candidateTicket(receipt, "discard-only");
      persistBackupRecovery(next);
      setBackupFlow({
        phase: "discard-only",
        receipt,
        message: mode === "activation-check" && baselineUnchanged
          ? "已经确认这次没有切换。为避免重复启用，现在只收起这份候选。"
          : "当前职迹在候选建立后有过变化。这份候选不会覆盖它，现在只收起候选。",
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "INVALID_RECEIPT") {
        markBackupRecoveryUnreadable(entry.storageKey);
        setBackupFlow({ phase: "error", title: "这条继续信息无法核对", message: "没有启用或删除任何内容。你可以保留本机候选，并只清除这条提醒。" });
      } else {
        persistBackupRecovery(candidateTicket(receipt, "activation-check"));
        setBackupFlow({ phase: "activation-check", receipt, message: "当前版本暂时没有读到。继续时只会重新核对，不会重复启用。" });
      }
    } finally {
      backupOperationRef.current = false;
    }
  }

  async function recoverPreparation(entry: CareerBackupRecoveryEntry) {
    if (entry.ticket.kind !== "prepare") return;
    backupOperationRef.current = true;
    setBackupFlow({ phase: "checking", title: "正在继续核对", text: "沿用上次留下的核对信息，不会重新读取或写入备份文件。" });
    try {
      const recovered = await recoverCareerBackupPrepare(entry.ticket.receipt);
      if (recovered.status === "ready") {
        const next = candidateTicket(recovered.receipt, "review");
        persistBackupRecovery(next);
        await inspectCandidate({ storageKey: careerBackupRecoveryStorageKey(next), ticket: next, persisted: true });
        return;
      }
      if (recovered.status === "cleanup-pending") {
        const next: CareerBackupRecoveryTicket = { version: 1, kind: "prepare-cleanup", receipt: recovered.cleanupReceipt, recordedAt: new Date().toISOString() };
        persistBackupRecovery(next);
        setBackupFlow({ phase: "prepare-cleanup", receipt: recovered.cleanupReceipt, message: "当前职迹没有改变。只需收起这次没有启用的临时内容。" });
        return;
      }
      if (removeBackupRecoveryFor(entry.ticket.receipt)) {
        handledBackupTicketRef.current = "";
        setBackupFlow({ phase: "idle" });
        notify(recovered.status === "discarded" ? "上次未完成的候选已经收起" : "上次的临时内容已经收尾", "info");
      } else if (recovered.status === "cleanup-complete") {
        setBackupFlow({ phase: "prepare-cleanup", receipt: recovered.cleanupReceipt, message: "临时内容已经收尾，本页暂时没能清除继续提醒。" });
      } else {
        setBackupFlow({ phase: "error", title: "候选已经收起", message: "当前职迹没有改变；本页暂时没能清除继续提醒。" });
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "INVALID_RECEIPT") {
        markBackupRecoveryUnreadable(entry.storageKey);
        setBackupFlow({ phase: "error", title: "这条继续信息无法核对", message: "没有启用或删除任何内容。你可以保留本机候选，并只清除这条提醒。" });
      } else {
        setBackupFlow({ phase: "error", title: "这次核对还没完成", message: "继续信息仍保留着。稍后再试即可，不需要重新选择备份。" });
      }
    } finally {
      backupOperationRef.current = false;
    }
  }

  async function resumeBackupRecovery(entry: CareerBackupRecoveryEntry) {
    if (entry.ticket.kind === "refresh-only") {
      setBackupFlow({ phase: "refresh-only", receipt: entry.ticket.receipt, message: "这份备份已经启用，只需让页面重新读取资料。" });
      return;
    }
    if (entry.ticket.kind === "prepare-cleanup") {
      setBackupFlow({ phase: "prepare-cleanup", receipt: entry.ticket.receipt, message: "当前职迹没有改变。只需收起这次没有启用的临时内容。" });
      return;
    }
    if (entry.ticket.kind === "prepare") {
      await recoverPreparation(entry);
      return;
    }
    await inspectCandidate(entry);
  }

  useEffect(() => {
    if (!allowInitialBackupResumeRef.current || !backupRecoveryLoaded || !activeBackupRecovery || backupOperationRef.current || backupFlow.phase !== "idle") return;
    const fingerprint = `${activeBackupRecovery.storageKey}:${JSON.stringify(activeBackupRecovery.ticket)}`;
    if (handledBackupTicketRef.current === fingerprint) return;
    allowInitialBackupResumeRef.current = false;
    handledBackupTicketRef.current = fingerprint;
    void resumeBackupRecovery(activeBackupRecovery);
  // resumeBackupRecovery deliberately consumes the latest serialized capability exactly once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBackupRecovery, backupFlow.phase, backupRecoveryLoaded]);

  async function prepareSelectedBackup(file: File) {
    if (backupWriteLocked || backupOperationRef.current) return;
    allowInitialBackupResumeRef.current = false;
    backupOperationRef.current = true;
    const controller = new AbortController();
    backupPrepareControllerRef.current = controller;
    setBackupPrepareStopping(false);
    setBackupFlow({ phase: "preparing", fileName: file.name || "所选文件" });
    const checkpoint = { current: null as CareerPrepareRecoveryReceipt | null };
    try {
      const receipt = await prepareCareerBackupRestore(file, {
        signal: controller.signal,
        onRecoveryPrepared: async (recoveryReceipt) => {
          checkpoint.current = recoveryReceipt;
          const ticket: CareerBackupRecoveryTicket = { version: 1, kind: "prepare", receipt: recoveryReceipt, recordedAt: new Date().toISOString() };
          if (!persistBackupRecovery(ticket)) {
            throw new Error("The prepare recovery receipt could not be saved on this device.");
          }
        },
      });
      const next = candidateTicket(receipt, "review");
      persistBackupRecovery(next);
      setBackupFlow({ phase: "review", receipt });
    } catch (error) {
      if (error instanceof CareerPrepareUncertainError) {
        const next: CareerBackupRecoveryTicket = { version: 1, kind: "prepare", receipt: error.receipt, recordedAt: new Date().toISOString() };
        persistBackupRecovery(next);
        setBackupFlow({ phase: "error", title: "候选还在核对中", message: "继续信息已经保留。下一步只会核对这一次准备，不会重复导入。" });
      } else if (error instanceof CareerPrepareCleanupIncompleteError) {
        const next: CareerBackupRecoveryTicket = { version: 1, kind: "prepare-cleanup", receipt: error.receipt, recordedAt: new Date().toISOString() };
        persistBackupRecovery(next);
        setBackupFlow({ phase: "prepare-cleanup", receipt: error.receipt, message: "当前职迹没有改变。还有少量临时内容等待收尾。" });
      } else if (error instanceof CareerDiscardUncertainError) {
        const next = candidateTicket(error.receipt, "discard-only");
        persistBackupRecovery(next);
        setBackupFlow({ phase: "discard-only", receipt: error.receipt, message: "当前职迹没有改变。候选的收尾结果还没确认，只需继续收尾。" });
      } else if (error instanceof Error && "code" in error && error.code === "PREPARE_ABORTED") {
        if (checkpoint.current) removeBackupRecoveryFor(checkpoint.current);
        setBackupFlow({ phase: "idle" });
        notify("已停止核对，当前职迹没有改变", "info");
        window.requestAnimationFrame(() => backupPickerButtonRef.current?.focus({ preventScroll: true }));
      } else {
        if (checkpoint.current) removeBackupRecoveryFor(checkpoint.current);
        setBackupFlow({
          phase: "error",
          title: "没有使用这个文件",
          message: error instanceof Error ? error.message : "这个文件暂时无法核对，当前职迹没有改变。",
        });
      }
    } finally {
      if (backupPrepareControllerRef.current === controller) backupPrepareControllerRef.current = null;
      setBackupPrepareStopping(false);
      backupOperationRef.current = false;
    }
  }

  function stopBackupPreparation() {
    if (!backupPrepareControllerRef.current || backupPrepareControllerRef.current.signal.aborted) return;
    setBackupPrepareStopping(true);
    backupPrepareControllerRef.current.abort();
  }

  async function activateCandidate(receipt: CareerRestoreReceipt) {
    if (backupOperationRef.current) return;
    const checkingTicket = candidateTicket(receipt, "activation-check");
    if (!persistBackupRecovery(checkingTicket)) {
      setBackupFlow({ phase: "activation-check", receipt, message: "当前网址的浏览器存储暂时不能保存继续信息，因此没有启用。恢复存储后，只会先核对当前版本。" });
      return;
    }
    backupOperationRef.current = true;
    setBackupFlow({ phase: "activating", receipt });
    try {
      await activatePreparedCareerRestore(receipt);
      await finishBackupRefresh(receipt, "备份已经启用，正在重新读取页面资料。");
    } catch (error) {
      if (error instanceof CareerCurrentGenerationChangedError) {
        const next = candidateTicket(receipt, "discard-only");
        persistBackupRecovery(next);
        setBackupFlow({ phase: "discard-only", receipt, message: "当前职迹刚刚有过变化，这次没有覆盖它。现在只收起候选。" });
      } else {
        const uncertainReceipt = error instanceof CareerActivationUncertainError ? error.receipt : receipt;
        persistBackupRecovery(candidateTicket(uncertainReceipt, "activation-check"));
        setBackupFlow({ phase: "activation-check", receipt: uncertainReceipt, message: "切换结果暂时没有确认。下一步只会读取当前版本，不会重复启用。" });
      }
    } finally {
      backupOperationRef.current = false;
    }
  }

  async function discardCandidate(receipt: CareerRestoreReceipt) {
    if (backupOperationRef.current) return;
    const cleanupTicket = candidateTicket(receipt, "discard-only");
    if (!persistBackupRecovery(cleanupTicket)) {
      setBackupFlow({ phase: "discard-only", receipt, message: "当前网址的浏览器存储暂时不能保存收尾信息，因此没有开始收尾。" });
      return;
    }
    backupOperationRef.current = true;
    setBackupFlow({ phase: "discarding", receipt });
    try {
      const discarded = await discardPreparedCareerRestore(receipt);
      if (discarded.attachmentCleanup === "incomplete") {
        setBackupFlow({ phase: "discard-only", receipt, message: "候选已经放下，还有临时附件等待收尾。继续时只会重试收尾。" });
        return;
      }
      if (removeBackupRecoveryFor(receipt)) {
        handledBackupTicketRef.current = "";
        setBackupFlow({ phase: "idle" });
        notify("候选已经收起，当前职迹没有改变", "info");
        window.requestAnimationFrame(() => backupPickerButtonRef.current?.focus({ preventScroll: true }));
      } else {
        setBackupFlow({ phase: "discard-only", receipt, message: "候选已经收起，本页暂时没能清除继续提醒。" });
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "INVALID_RECEIPT") {
        markBackupRecoveryUnreadable(careerBackupRecoveryStorageKey(cleanupTicket));
        setBackupFlow({ phase: "error", title: "这条收尾信息无法核对", message: "没有删除任何内容。你可以保留本机候选，并只清除这条提醒。" });
      } else {
        setBackupFlow({ phase: "discard-only", receipt, message: "收尾结果暂时没有确认。继续时只会重试收尾，不会启用候选。" });
      }
    } finally {
      backupOperationRef.current = false;
    }
  }

  async function cleanPreparedAttachments(receipt: CareerPrepareCleanupReceipt) {
    if (backupOperationRef.current) return;
    backupOperationRef.current = true;
    setBackupFlow({ phase: "cleaning", receipt });
    try {
      await retryCareerPrepareCleanup(receipt);
      if (removeBackupRecoveryFor(receipt)) {
        handledBackupTicketRef.current = "";
        setBackupFlow({ phase: "idle" });
        notify("未启用的临时内容已经收尾，当前职迹没有改变", "info");
        window.requestAnimationFrame(() => backupPickerButtonRef.current?.focus({ preventScroll: true }));
      } else {
        setBackupFlow({ phase: "prepare-cleanup", receipt, message: "临时内容已经收尾，本页暂时没能清除继续提醒。" });
      }
    } catch {
      setBackupFlow({ phase: "prepare-cleanup", receipt, message: "临时内容暂时没有全部收尾。当前职迹没有改变，稍后继续即可。" });
    } finally {
      backupOperationRef.current = false;
    }
  }

  async function continueActiveRecovery() {
    if (!activeBackupRecovery || backupOperationRef.current) return;
    handledBackupTicketRef.current = "";
    await resumeBackupRecovery(activeBackupRecovery);
  }

  function clearUnreadableBackupRecovery() {
    if (!removeBackupRecoveryKeys(backupRecoveryUnreadableKeys)) {
      setBackupFlow({ phase: "error", title: "提醒暂时没有清除", message: "没有启用或删除任何本机内容。请恢复浏览器存储后再试。" });
      return;
    }
    handledBackupTicketRef.current = "";
    setBackupFlow({ phase: "idle" });
    notify("提醒已经清除，本机候选与当前职迹都没有被改动", "info");
    window.requestAnimationFrame(() => backupPickerButtonRef.current?.focus({ preventScroll: true }));
  }

  function retryBackupRecoveryStorage() {
    const remaining: CareerBackupRecoveryEntry[] = [];
    for (const entry of volatileBackupRecoveries) {
      try {
        const serialized = JSON.stringify(entry.ticket);
        if (serialized.length > CAREER_BACKUP_RECOVERY_MAX_BYTES) throw new Error("recovery ticket is too large");
        window.localStorage.setItem(entry.storageKey, serialized);
        durableBackupRecoveryKeysRef.current.add(entry.storageKey);
      } catch {
        remaining.push(entry);
      }
    }
    setVolatileBackupRecoveries(remaining);
    setBackupRecoveryStorageUnavailable(remaining.length > 0);
    reloadBackupRecoveries();
  }

  const renderBackupSummary = (summary: CareerRestoreSummary) => <dl className="career-backup-summary">
    <div><dt>文件</dt><dd>{summary.fileName ?? "名称未提供"}</dd></div>
    <div><dt>类型</dt><dd>{summary.kind === "complete-backup" ? "完整职迹备份" : "旧版职迹数据库"}</dd></div>
    <div><dt>已核对</dt><dd>{summary.verification === "container-and-payload-verified" ? "数据库与附件内容" : "职迹数据库结构"}</dd></div>
    <div><dt>大小</dt><dd>{formatCareerBackupBytes(summary.byteSize)}</dd></div>
    {summary.exportedAt && <div><dt>导出时间</dt><dd>{formatDate(summary.exportedAt, true)}</dd></div>}
    <div><dt>材料原件</dt><dd>{summary.kind === "complete-backup" ? `${summary.attachmentCount} 个已验证附件` : "不包含附件原件"}</dd></div>
  </dl>;

  const renderBackupFlow = () => {
    if (backupFlow.phase === "idle") return null;
    const statusProps = backupFlow.phase === "error" ? { role: "alert" as const } : { role: "status" as const };
    return <section className={`career-backup-flow ${backupFlow.phase}`} aria-labelledby="career-backup-flow-title" {...statusProps}>
      <header>
        <span>{backupFlowBusy ? <LoaderCircle className="spin" size={20} /> : <ShieldCheck size={20} />}</span>
        <div>
          <small>RESTORE</small>
          <h4 id="career-backup-flow-title" ref={backupFlowHeadingRef} tabIndex={-1}>
            {backupFlow.phase === "preparing" ? "正在核对这个文件" :
              backupFlow.phase === "checking" ? backupFlow.title :
              backupFlow.phase === "review" ? "启用前，再看一眼" :
              backupFlow.phase === "activating" ? "正在启用已核对的备份" :
              backupFlow.phase === "activation-check" ? "先确认当前版本" :
              backupFlow.phase === "discard-only" ? "只收起这份候选" :
              backupFlow.phase === "discarding" ? "正在收起候选" :
              backupFlow.phase === "prepare-cleanup" ? "还有一点临时内容待收尾" :
              backupFlow.phase === "cleaning" ? "正在收尾临时内容" :
              backupFlow.phase === "refresh-only" ? "备份已经启用" : backupFlow.title}
          </h4>
        </div>
      </header>
      {backupFlow.phase === "preparing" && <><p>{backupPrepareStopping ? "正在安全结束核对。如果候选已经开始建立，会保留同一次继续信息，不会悄悄丢下它。" : <>正在判断“{backupFlow.fileName}”是什么，并建立独立候选。核对完成前，当前职迹不会切换。</>}</p><footer><button className="career-button ghost" disabled={backupPrepareStopping} onClick={stopBackupPreparation}>{backupPrepareStopping ? "正在停止…" : "停止核对"}</button></footer></>}
      {backupFlow.phase === "checking" && <p>{backupFlow.text}</p>}
      {backupFlow.phase === "review" && <>
        {backupFlow.message && <p>{backupFlow.message}</p>}
        {renderBackupSummary(backupFlow.receipt.summary)}
        {backupFlow.receipt.summary.kind === "legacy-career-sqlite" && <p className="career-backup-calm-note">旧版数据库不带材料原件；启用后会清空旧附件索引，避免显示并不存在的原件。</p>}
        <p className="career-backup-calm-note">当前职迹此刻还没有改变。只有你选择“启用这份备份”后，才会切换。</p>
        <footer><button className="career-button ghost" onClick={() => void discardCandidate(backupFlow.receipt)}>暂不使用</button><button className="career-button primary" data-backup-initial onClick={() => void activateCandidate(backupFlow.receipt)}>启用这份备份</button></footer>
      </>}
      {backupFlow.phase === "activating" && <p>候选已经通过核对。这里只执行一次版本切换，完成后再单独刷新页面资料。</p>}
      {backupFlow.phase === "activation-check" && <><p>{backupFlow.message}</p><footer><button className="career-button primary" onClick={() => { const entry: CareerBackupRecoveryEntry = { storageKey: careerBackupRecoveryStorageKey(candidateTicket(backupFlow.receipt, "activation-check")), ticket: candidateTicket(backupFlow.receipt, "activation-check"), persisted: true }; void inspectCandidate(entry); }}>只核对当前版本</button></footer></>}
      {backupFlow.phase === "discard-only" && <><p>{backupFlow.message}</p><footer><button className="career-button secondary" onClick={() => void discardCandidate(backupFlow.receipt)}>继续收尾</button></footer></>}
      {backupFlow.phase === "discarding" && <p>只处理未启用的候选与它的临时附件，不会改动当前职迹。</p>}
      {backupFlow.phase === "prepare-cleanup" && <><p>{backupFlow.message}</p><footer><button className="career-button secondary" onClick={() => void cleanPreparedAttachments(backupFlow.receipt)}>继续收尾</button></footer></>}
      {backupFlow.phase === "cleaning" && <p>只重试这次准备留下的临时附件，不会重新导入或启用。</p>}
      {backupFlow.phase === "refresh-only" && <><p>{backupFlow.message}</p><footer><button className="career-button primary" onClick={() => void finishBackupRefresh(backupFlow.receipt, backupFlow.message)}>重新读取页面资料</button></footer></>}
      {backupFlow.phase === "error" && <><p>{backupFlow.message}</p>{activeBackupRecovery && backupRecoveryUnreadableKeys.length === 0 && <footer><button className="career-button secondary" onClick={() => void continueActiveRecovery()}>继续核对</button></footer>}</>}
    </section>;
  };

  return <div className="career-view">
    <SectionHeading eyebrow="PREFERENCES" title="设置" description="隐私、流程与数据，都由你掌控" />
    <div className="career-settings-layout">
      <nav><a href="#workflow">求职流程</a><a href="#privacy">AI 与隐私</a><a href="#data">数据与备份</a><a href="#capture">浏览器采集器</a></nav>
      <div>
        <section className="career-settings-card" id="workflow"><header><div><h3>看板阶段</h3><p>按你的求职习惯调整名称，工作台会保持一致。</p></div></header><div className="career-stage-settings">{data.stages.map((stage) => <label key={stage.id}><i style={{ background: stage.color }} /><input defaultValue={stage.name} onBlur={(event) => void rename(stage, event.target.value)} aria-label={`${stage.name}阶段名称`} /><span>{savingStage === stage.id ? <LoaderCircle className="spin" size={14} /> : stage.is_terminal ? "终态" : "进行中"}</span></label>)}</div></section>
        <section className="career-settings-card" id="privacy"><header><div><h3>AI 与隐私</h3><p>只有你主动使用 AI 时，所选内容才会发送至配置的服务。</p></div><span className={aiHealth.status === "configured" ? "career-status-good" : "career-status-neutral"} aria-live="polite"><i />{aiStatusLabel}</span></header><div className="career-setting-row"><span><b>当前模型</b><small>由服务器环境安全配置</small></span><code>{aiHealth.model || "DeepSeek"}</code></div><div className="career-setting-row"><span><b>结果保留方式</b><small>关闭预览不会自动保存，也不会留下隐藏副本</small></span><code>核对后复制或填入草稿</code></div><div className="career-privacy-note"><ShieldCheck size={18} /><p>API 密钥不会进入浏览器、本地数据库或备份。职位描述和面试笔记会被当作不可信数据处理。</p></div></section>
        <section className="career-settings-card career-backup-card" id="data">
          <header><div><h3>数据与备份</h3><p>一个文件带走结构化职迹与已关联的材料原件。</p></div></header>
          <div className="career-data-actions">
            <button disabled={exportBusy || backupWriteLocked} onClick={() => void exportBackup()}><span>{exportBusy ? <LoaderCircle className="spin" size={19} /> : <Download size={19} />}</span><div><b>{exportBusy ? "正在校验并打包…" : "导出完整备份"}</b><small>SQLite、简历、作品集与案例附件</small></div><ChevronRight size={17} /></button>
            <button ref={backupPickerButtonRef} type="button" disabled={backupWriteLocked || exportBusy} onClick={() => backupFileInputRef.current?.click()}><span>{backupFlow.phase === "preparing" ? <LoaderCircle className="spin" size={19} /> : <Upload size={19} />}</span><div><b>选择备份并核对</b><small>先识别与验证，确认前不会切换</small></div><ChevronRight size={17} /></button>
            <input ref={backupFileInputRef} hidden aria-label="选择要核对的职迹备份" disabled={backupWriteLocked || exportBusy} type="file" accept=".career-backup,.sqlite,.sqlite3,.db,application/x-sqlite3,application/octet-stream" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) void prepareSelectedBackup(file); }} />
          </div>
          {!backupRecoveryLoaded && <p className="career-backup-quiet-status" role="status"><LoaderCircle className="spin" size={15} />正在查看是否有上次未完成的核对</p>}
          {backupRecoveryEntries.length > 1 && <p className="career-backup-quiet-status" role="status"><ShieldCheck size={15} />还有 {backupRecoveryEntries.length} 次独立恢复需要依次确认；每次只处理自己的候选。</p>}
          {backupFlow.phase === "idle" && activeBackupRecovery && <div className="career-backup-warning" role="status"><ShieldCheck size={18} /><div><b>有一次恢复等待继续</b><p>它可能来自上次打开或另一个标签页。先由你决定何时继续，页面不会突然抢走焦点。</p></div><button className="career-button secondary" onClick={() => void continueActiveRecovery()}>继续这次核对</button></div>}
          {backupRecoveryUnreadableKeys.length > 0 && <div className="career-backup-warning" role="alert"><ShieldCheck size={18} /><div><b>有一条继续提醒无法读取</b><p>没有调用恢复或清理。可以保留本机候选，只清除这条提醒。</p></div><button className="career-button ghost" onClick={clearUnreadableBackupRecovery}>保留本机候选并清除提醒</button></div>}
          {backupStorageNeedsAttention && <div className="career-backup-warning" role="status"><ShieldCheck size={18} /><div><b>继续信息暂时只在这个页面里</b><p>先不要关闭页面。恢复浏览器存储后，才能安全开始新的核对。</p></div><button className="career-button ghost" onClick={retryBackupRecoveryStorage}>重试保存继续信息</button></div>}
          {renderBackupFlow()}
          <p className="career-settings-footnote">完整备份是明文文件，请安全保管；导出前会校验每个附件。恢复分成“核对”和“启用”两步。旧版 SQLite 不包含附件原件。</p>
        </section>
        <section className="career-settings-card" id="capture"><header><div><h3>浏览器采集器</h3><p>把当前 URL 与你明确选中的 JD 文本带回当前这一个职迹地址，不读取整页正文。</p></div></header><div className="career-capture-steps"><span><b>1</b>在当前职迹复制采集器</span><ArrowRight size={16} /><span><b>2</b>新建书签并粘贴到网址</span><ArrowRight size={16} /><span><b>3</b>选中 JD 后点击书签</span></div><button className="career-button secondary" onClick={() => void copyHelper()}><Command size={16} />复制当前地址的采集器</button><p className="career-settings-footnote">采集器会回到复制它时的职迹地址，并且仅附带来源 URL 与选中文字；不包含 Cookie、登录态或站内消息，也不会自动投递。</p></section>
      </div>
    </div>
  </div>;
}

function Drawer({ label, children, onClose, wide = false, dismissible = true, inertToasts = false }: { label: string; children: ReactNode; onClose: () => void; wide?: boolean; dismissible?: boolean; inertToasts?: boolean }) {
  const dialogRef = useDialogA11y(dismissible ? onClose : () => undefined, inertToasts);
  return <div className="career-layer">{dismissible ? <button className="career-modal-scrim" onClick={onClose} aria-label={`关闭${label}`} /> : <div className="career-modal-scrim" aria-hidden="true" />}<aside ref={dialogRef} tabIndex={-1} className={`career-drawer ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={label}>{children}</aside></div>;
}
function Modal({ title, description, children, onClose, wide = false, dismissible = true, inertToasts = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean; dismissible?: boolean; inertToasts?: boolean }) {
  const dialogRef = useDialogA11y(dismissible ? onClose : () => undefined, inertToasts);
  const titleId = useId();
  const descriptionId = useId();
  return <div className="career-layer">{dismissible ? <button className="career-modal-scrim" onClick={onClose} aria-label={`关闭${title}`} /> : <div className="career-modal-scrim" aria-hidden="true" />}<section ref={dialogRef} tabIndex={-1} className={`career-modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}><header><div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>{dismissible && <button className="career-icon-button" onClick={onClose} aria-label={`关闭${title}`}><X size={19} /></button>}</header>{children}</section></div>;
}

type CareerTaskSheetPhase = "idle" | "loading" | "ready" | "writing" | "refreshing" | "stale" | "refresh-only";
type CareerTaskSheetMode = "summary" | "schedule" | "restore" | "cancel-confirm";
type CareerTaskDueChoice = "later" | "new" | "original" | null;

function TaskDetailSheet({ request, now, onClose, onRefresh, notify }: {
  request: CareerTaskSheetRequest;
  now: number;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  notify: (text: string, tone?: Notice["tone"]) => void;
}) {
  const [phase, setPhase] = useState<CareerTaskSheetPhase>(() => request.initialState ?? "idle");
  const [detail, setDetail] = useState<CareerTaskDetail | null>(null);
  const [mode, setMode] = useState<CareerTaskSheetMode>("summary");
  const [dueChoice, setDueChoice] = useState<CareerTaskDueChoice>(null);
  const [newDueAt, setNewDueAt] = useState("");
  const [message, setMessage] = useState(request.initialState === "stale" ? "这条待办刚在另一个页面发生了变化。这里没有继续保存。" : "");
  const [notFound, setNotFound] = useState(false);
  const requestRef = useRef(0);
  const writeRef = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  const busy = phase === "writing" || phase === "refreshing" || phase === "refresh-only" || phase === "loading";
  function requestClose() {
    if (busy || (mode !== "summary" && phase !== "stale")) return;
    onClose();
  }
  const dialogRef = useDialogA11y(requestClose, true);

  async function readLatest() {
    const token = ++requestRef.current;
    setPhase("loading");
    setMessage("");
    setNotFound(false);
    try {
      const next = await careerTaskActions.load(request.taskId);
      if (requestRef.current !== token) return;
      if (!next) {
        setDetail(null);
        setNotFound(true);
      } else {
        setDetail(next);
        setMode("summary");
        setDueChoice(null);
        setNewDueAt("");
      }
      setPhase("ready");
    } catch {
      if (requestRef.current !== token) return;
      setPhase("ready");
      setMessage("待办资料暂时没有打开。没有把它当成一条空记录。");
    }
  }

  useEffect(() => {
    if (request.initialState) return;
    const frame = window.requestAnimationFrame(() => { void readLatest(); });
    return () => { window.cancelAnimationFrame(frame); requestRef.current += 1; };
    // The request nonce remounts the sheet; task ID is stable for this instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.taskId]);

  useEffect(() => {
    if (mode !== "cancel-confirm") return;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("[data-task-safe-focus]")?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [dialogRef, mode]);

  useEffect(() => {
    if (phase !== "ready" && phase !== "stale") return;
    const dialog = dialogRef.current;
    if (!dialog || dialog.contains(document.activeElement)) return;
    const frame = window.requestAnimationFrame(() => {
      (dialog.querySelector<HTMLElement>("[data-dialog-initial]:not([disabled])") ?? dialog).focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dialogRef, phase]);

  async function finishMutation(action: () => Promise<unknown>, successMessage: string) {
    if (!detail || writeRef.current) return;
    writeRef.current = true;
    setPhase("writing");
    setMessage("");
    try {
      await action();
    } catch (error) {
      writeRef.current = false;
      if (error instanceof CareerTaskError && error.code === "changed") {
        setPhase("stale");
        setMessage("这条待办刚在另一个页面发生了变化。这里没有继续保存。");
        return;
      }
      setPhase("ready");
      setMessage(error instanceof Error ? error.message : "这次更改没有保存，原记录仍保持不变。");
      return;
    }
    setPhase("refreshing");
    try {
      await onRefresh();
      const latest = await careerTaskActions.load(request.taskId);
      if (!latest) {
        setDetail(null);
        setNotFound(true);
      } else setDetail(latest);
      setMode("summary");
      setDueChoice(null);
      setNewDueAt("");
      setPhase("ready");
      notify(successMessage, "info");
    } catch {
      setPhase("refresh-only");
      setMessage("更改已保存在本机，画面还没有重新读取。请只重新读取，不要重复提交。");
    } finally { writeRef.current = false; }
  }

  async function retryRefreshOnly() {
    if (phase !== "refresh-only") return;
    setMessage("");
    try {
      await onRefresh();
      const latest = await careerTaskActions.load(request.taskId);
      setDetail(latest);
      setNotFound(!latest);
      setMode("summary");
      setDueChoice(null);
      setNewDueAt("");
      setPhase("ready");
    } catch {
      setMessage("更改仍已保存在本机。这里只会重新读取，不会再次提交。");
    }
  }

  function chosenDueAt() {
    if (dueChoice === "later") return null;
    if (dueChoice === "original") return detail?.task.due_at ?? null;
    if (dueChoice === "new") return fromDateInput(newDueAt);
    return undefined;
  }

  function submitDueChoice() {
    if (!detail || !detail.task.updated_at) return;
    const dueAt = chosenDueAt();
    if (dueAt === undefined) return;
    const options = { expectedUpdatedAt: detail.task.updated_at, dueAt, operationId: `task_due_${crypto.randomUUID()}` };
    if (mode === "schedule") {
      void finishMutation(() => careerTaskActions.reschedule(detail.task.id, options), dueAt ? "安排已调整" : "已放到“以后再说”");
      return;
    }
    if (detail.task.status === "done") {
      void finishMutation(() => careerTaskActions.reopenCompleted(detail.task.id, options), "待办已重新放回");
      return;
    }
    void finishMutation(() => careerTaskActions.restore(detail.task.id, options), "待办已重新放回");
  }

  const task = detail?.task ?? null;
  const taskVersion = task?.updated_at ?? "";
  const originalFuture = Boolean(task?.due_at && new Date(task.due_at).getTime() > now);
  const canSubmitDue = dueChoice === "later" || dueChoice === "original" || (dueChoice === "new" && Boolean(newDueAt));
  const lifecyclePaused = Boolean(task && isCareerLifecyclePaused(task));
  const statusCopy = task ? careerTaskStatusCopy(task) : "待办";
  const contextCopy = detail?.job?.archived ? "关联职位已归档" : detail?.job?.stage?.isTerminal ? "关联职位已结束" : "";
  const restoreBlockedCopy = task?.status === "done" && detail?.job?.archived
    ? "关联职位已归档，因此先不重新安排。取回职位后，可以再决定。"
    : task?.status === "done" && detail?.job?.stage?.isTerminal
      ? "关联职位已结束，因此先不重新安排。职位重新开始后，可以再决定。"
      : detail?.hardRestoreBlockedReason === "job_archived"
    ? "关联职位已归档，因此先不重新安排。取回职位后，可以再决定。"
    : detail?.hardRestoreBlockedReason === "job_ended"
      ? "关联职位已结束，因此先不重新安排。职位重新开始后，可以再决定。"
      : detail?.hardRestoreBlockedReason && detail.hardRestoreBlockedReason !== "not_canceled"
        ? "关联记录已经变化，这里没有继续操作。"
        : "";

  if (phase === "refresh-only") return <div className="career-layer"><div className="career-modal-scrim" aria-hidden="true" /><aside ref={dialogRef} tabIndex={-1} className="career-task-sheet recovery" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}><div className="career-task-recovery"><ShieldCheck size={24} /><span><h2 id={titleId}>更改已保存在本机</h2><p id={descriptionId}>{message || "画面还没有重新读取。请只重新读取，不要重复提交。"}</p></span><button className="career-button primary" data-dialog-initial onClick={() => void retryRefreshOnly()}><RotateCcw size={16} />重新读取</button></div></aside></div>;

  return <div className="career-layer"><button className="career-modal-scrim" disabled={busy || (mode !== "summary" && phase !== "stale")} onClick={requestClose} aria-label="关闭待办详情" /><aside ref={dialogRef} tabIndex={-1} className={`career-task-sheet ${phase}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy || undefined}>
    <header><div><span>{statusCopy}</span><h2 id={titleId}>{task?.title ?? (notFound ? "待办记录已经变化" : "正在打开待办")}</h2><p id={descriptionId}>{task ? formatCareerTaskDate(task.due_at, now) : "只呈现成功读取到的本地记录。"}</p></div><button className="career-icon-button" data-dialog-initial disabled={busy || (mode !== "summary" && phase !== "stale")} onClick={requestClose} aria-label="关闭待办详情"><X size={19} /></button></header>
    <div className="career-task-sheet-body" aria-live="polite">
      {phase === "loading" && <div className="career-modal-loading" role="status"><LoaderCircle className="spin" size={20} />正在打开待办…</div>}
      {phase === "stale" && <div className="career-task-alert" role="alert"><ShieldCheck size={18} /><div><b>这里没有继续保存</b><p>{message}</p></div><button className="career-button secondary" onClick={() => void readLatest()}><RotateCcw size={16} />查看最新状态</button></div>}
      {message && phase === "ready" && <div className="career-task-alert" role="alert"><ShieldCheck size={18} /><div><b>记录保持原样</b><p>{message}</p></div>{!detail && <button className="career-button secondary" onClick={() => void readLatest()}>重新读取</button>}</div>}
      {notFound && <div className="career-task-empty"><ShieldCheck size={22} /><h3>这条待办已不在当前记录中</h3><p>这里没有进行任何更改。</p></div>}
      {task && phase !== "loading" && <>
        <section className="career-task-facts"><div><span>状态</span><b>{statusCopy}</b></div><div><span>计划时间</span><b>{formatCareerTaskDate(task.due_at, now)}</b></div><div><span>类型</span><b>{task.kind}</b></div><div><span>关联</span><b>{detail?.job ? `${detail.job.company} · ${detail.job.role}` : detail?.contact ? detail.contact.name : "个人待办"}</b></div></section>
        {contextCopy && <div className="career-task-context"><ShieldCheck size={16} /><span><b>{contextCopy}</b><small>保留的安排仍由你决定是否完成、调整或放下。</small></span></div>}
        {lifecyclePaused && <div className="career-task-context"><Archive size={16} /><span><b>随职位暂停</b><small>{task.cancellation_reason === "job_archived" ? "这条安排随职位归档而暂停，记录仍完整保留。" : "这条安排随职位结束而暂停，记录仍完整保留。"}</small></span></div>}
        {mode === "summary" && phase !== "stale" && <div className="career-task-actions">
          {!taskVersion && <p className="career-task-blocked">这条记录缺少可确认的版本，请先查看最新状态。</p>}
          {task.status === "todo" && taskVersion && <><button className="career-button primary" disabled={busy} onClick={() => void finishMutation(() => careerTaskActions.complete(task.id, { expectedUpdatedAt: taskVersion, operationId: `task_complete_${crypto.randomUUID()}` }), "待办已完成")}><Check size={16} />标记为已完成</button><button className="career-button secondary" disabled={busy} onClick={() => { setDueChoice(null); setNewDueAt(""); setMode("schedule"); }}><CalendarDays size={16} />调整安排</button>{task.due_at && <button className="career-button ghost" disabled={busy} onClick={() => void finishMutation(() => careerTaskActions.reschedule(task.id, { expectedUpdatedAt: taskVersion, dueAt: null, operationId: `task_later_${crypto.randomUUID()}` }), "已放到“以后再说”")}>以后再说</button>}<button className="career-button ghost" disabled={busy} onClick={() => setMode("cancel-confirm")}>放下这条待办</button></>}
          {(task.status === "done" || task.status === "canceled") && taskVersion && !restoreBlockedCopy && (task.status === "done" || detail?.canRestoreWithNewDueAt) && <button className="career-button primary" disabled={busy} onClick={() => { setDueChoice(null); setNewDueAt(""); setMode("restore"); }}><RotateCcw size={16} />重新放回待办</button>}
          {restoreBlockedCopy && <p className="career-task-blocked">{restoreBlockedCopy}</p>}
        </div>}
        {(mode === "schedule" || mode === "restore") && <section className="career-task-due-choice"><header><h3>{mode === "restore" ? "重新放回待办" : "调整安排"}</h3><p>{mode === "restore" && task.due_at && !originalFuture ? "原计划时间已经过去。请选择新的时间，或选“以后再说”。" : "先明确选择；这里不会替你沿用旧时间。"}</p></header><fieldset><legend className="sr-only">选择新的计划时间</legend><label aria-label="以后再说"><input type="radio" name="task-due-choice" checked={dueChoice === "later"} onChange={() => setDueChoice("later")} /><span><b>以后再说</b><small>不设时间，记录仍会保留</small></span></label><label aria-label="选择新的时间"><input type="radio" name="task-due-choice" checked={dueChoice === "new"} onChange={() => setDueChoice("new")} /><span><b>选择新的时间</b><small>只接受现在之后的时间</small></span></label>{dueChoice === "new" && <input aria-label="新的计划时间" type="datetime-local" value={newDueAt} onChange={(event) => setNewDueAt(event.target.value)} />}{mode === "restore" && originalFuture && <label aria-label="沿用原计划"><input type="radio" name="task-due-choice" checked={dueChoice === "original"} onChange={() => setDueChoice("original")} /><span><b>沿用原计划</b><small>{formatCareerTaskDate(task.due_at, now)}</small></span></label>}</fieldset><footer><button className="career-button ghost" onClick={() => { setDueChoice(null); setNewDueAt(""); setMode("summary"); }}>先不调整</button><button className="career-button primary" disabled={!canSubmitDue || busy} onClick={submitDueChoice}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{busy ? "正在保存…" : "确认安排"}</button></footer></section>}
        {mode === "cancel-confirm" && <section className="career-task-cancel-confirm"><ShieldCheck size={22} /><h3>放下这条待办？</h3><p>它会留在记录里，不会被删除，也不会被当作失败。</p><footer><button className="career-button primary" data-task-safe-focus onClick={() => setMode("summary")}>继续保留</button><button className="career-button secondary" disabled={busy || !taskVersion} onClick={() => void finishMutation(() => careerTaskActions.cancel(task.id, { expectedUpdatedAt: taskVersion, reason: "changed_plan", operationId: `task_cancel_${crypto.randomUUID()}` }), "待办已放下")}>确认放下</button></footer></section>}
      </>}
    </div>
  </aside></div>;
}

function lifecycleChoiceCopy(choice: CareerLifecycleChoice) {
  switch (choice) {
    case "keep": return { title: "保留安排", text: "待办和已安排面试仍会出现在日历里，并标注职位状态。" };
    case "pause": return { title: "随职位暂停", text: "只暂停未来安排，不把它们写成你主动取消。" };
    case "keep-paused": return { title: "继续暂停", text: "取回职位，但不自动恢复之前随职位暂停的安排。" };
    case "restore-paused": return { title: "恢复仍合适的安排", text: "只恢复仍在未来且之后没有被修改过的待办和面试。" };
  }
}

function lifecycleImpactCopy(item: CareerLifecycleImpactItem) {
  if (item.classification === "elapsed") return "时间已过，不会自动恢复";
  if (item.classification === "edited") return "后来修改过，不会自动改动";
  return item.effect === "restore" ? "会按你的选择恢复" : "会按你的选择处理";
}

function CareerLifecycleModal({ state, busy, onChoice, onClose, onConfirm, onRetryRefresh }: {
  state: CareerLifecycleDialogState;
  busy: boolean;
  onChoice: (choice: CareerLifecycleChoice) => void;
  onClose: () => void;
  onConfirm: () => void;
  onRetryRefresh: () => void;
}) {
  const prepared = state.prepared;
  const target = prepared.intent.kind === "archive"
    ? "归档"
    : prepared.intent.kind === "restore"
      ? "取回"
      : prepared.job.nextStage?.name ?? "新阶段";
  const title = prepared.intent.kind === "archive"
    ? "把职位收进归档？"
    : prepared.intent.kind === "restore"
      ? "从归档取回这个职位？"
      : `将阶段记录为「${target}」？`;
  const description = prepared.intent.kind === "archive"
    ? "归档只是整理，不会删除职位、待办、面试或面经。"
    : prepared.intent.kind === "restore"
      ? "取回职位时，过期或后来修改过的安排不会被擅自恢复。"
      : prepared.job.nextStage?.isTerminal
        ? "这只是记录一个结果，不对你或这段经历评分。"
        : "先确认职位阶段和相关安排，再保存这次变更。";
  const confirmLabel = prepared.intent.kind === "archive"
    ? "确认归档"
    : prepared.intent.kind === "restore"
      ? "确认取回"
      : prepared.job.nextStage?.isTerminal
        ? "记录结果"
        : "确认阶段";

  if (state.phase === "refresh-recovery") {
    return <Modal title="更改已保存" description={`${prepared.job.company} · ${prepared.job.role}`} onClose={() => undefined} dismissible={false} inertToasts>
      <div className="career-lifecycle-body recovery"><div className="career-lifecycle-recovery" role="alert"><ShieldCheck size={21} /><div><b>不要再次提交</b><p>{state.error}</p></div></div><p className="career-lifecycle-calm-note">这里只会重新读取页面，不会再次写入刚才的更改。</p></div>
      <footer className="career-lifecycle-actions"><button data-dialog-initial className="career-button primary" disabled={busy} onClick={onRetryRefresh}>{busy ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}{busy ? "正在重新读取…" : "重试刷新"}</button></footer>
    </Modal>;
  }

  return <Modal title={title} description={description} onClose={onClose} wide inertToasts>
    <div className="career-lifecycle-body">
      <div className="career-lifecycle-job"><CompanyMark company={prepared.job.company} small /><span><b>{prepared.job.role}</b><small>{prepared.job.company} · {prepared.job.currentStage.name}{prepared.job.nextStage && ` → ${prepared.job.nextStage.name}`}</small></span></div>
      {state.changed && <div className="career-lifecycle-changed" role="status"><Clock3 size={18} /><span><b>安排刚有变化，请再看一眼</b><small>下面是重新读取后的实际影响，尚未保存。</small></span></div>}
      {state.error && <div className="career-lifecycle-write-error" role="alert"><ShieldCheck size={18} /><span><b>这次没有保存</b><small>{state.error}</small></span></div>}
      <section className="career-lifecycle-impact" aria-labelledby="career-lifecycle-impact-title"><header><div><h3 id="career-lifecycle-impact-title">会涉及的安排</h3><p>每一项都列在这里，没有隐藏处理。</p></div></header>
        {prepared.impact.length > 0 ? <ul>{prepared.impact.map((item) => <li key={`${item.entityType}:${item.id}`}><span className={`career-lifecycle-kind ${item.entityType}`}>{item.entityType === "task" ? <ListTodo size={15} /> : <CalendarDays size={15} />}</span><span><b>{item.label}</b><small>{item.entityType === "task" ? "待办" : "面试"} · {formatAbsoluteDate(item.scheduledAt)}</small><em className={item.classification}>{lifecycleImpactCopy(item)}</em></span></li>)}</ul> : <p className="career-lifecycle-empty">没有会被一起改动的未来待办或面试。</p>}
      </section>
      {prepared.requiresChoice ? <fieldset className="career-lifecycle-choices"><legend>这些安排怎么处理？</legend>{prepared.allowedChoices.map((choice) => { const copy = lifecycleChoiceCopy(choice); return <label key={choice} className={state.choice === choice ? "selected" : ""}><input aria-label={copy.title} type="radio" name="career-lifecycle-choice" value={choice} checked={state.choice === choice} onChange={() => onChoice(choice)} /><span><b>{copy.title}</b><small>{copy.text}</small></span></label>; })}</fieldset> : <div className="career-lifecycle-single-choice"><ShieldCheck size={18} /><span><b>{lifecycleChoiceCopy(state.choice ?? prepared.allowedChoices[0]).title}</b><small>{lifecycleChoiceCopy(state.choice ?? prepared.allowedChoices[0]).text}</small></span></div>}
    </div>
    <footer className="career-lifecycle-actions"><button className="career-button ghost" disabled={busy} onClick={onClose}>先不改</button><button className="career-button primary" disabled={busy || !state.choice} onClick={onConfirm}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{busy ? "正在保存…" : confirmLabel}</button></footer>
  </Modal>;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="career-field"><span>{label}{hint && <small>{hint}</small>}</span>{children}</label>; }
function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) { return <div className="career-empty"><span>{icon}</span><h3>{title}</h3><p>{text}</p>{action}</div>; }
function CareerAiDisclosure({ action, className = "" }: { action: AiAction; className?: string }) {
  return <p className={`career-ai-disclosure ${className}`.trim()}><ShieldCheck size={15} /><span>{careerAiDisclosureText(action)}</span></p>;
}

function JobDrawer({ job, data, now, lifecyclePending, onClose, onLifecycle, onRefresh, onOpenTask, onCompleteTask, onAi, onSelectContact, notify }: { job: Job; data: CareerData; now: number; lifecyclePending: boolean; onClose: () => void; onLifecycle: (intent: CareerLifecycleIntent) => Promise<boolean>; onRefresh: () => Promise<void>; onOpenTask: (taskId: string) => void; onCompleteTask: (task: Task) => void | Promise<void>; onAi: (action: AiAction, title: string, payload: unknown) => void; onSelectContact: (contactId: string) => void; notify: (text: string, tone?: Notice["tone"]) => void }) {
  const [tab, setTab] = useState<"overview" | "tasks" | "interviews" | "materials">("overview");
  const [editing, setEditing] = useState(false);
  const [linkedContacts, setLinkedContacts] = useState<Contact[]>([]);
  const tasks = data.tasks.filter((task) => task.job_id === job.id);
  const interviews = data.interviews.filter((item) => item.job_id === job.id);
  const materials = data.materials.filter((item) => item.linked_job_id === job.id);
  const currentStage = data.stages.find((stage) => stage.id === job.stage_id);
  const archived = job.archived === 1;
  const ended = currentStage?.is_terminal === 1;
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
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (archived) return; const form = new FormData(event.currentTarget); const result = await runCareerSql("UPDATE career_jobs SET company=?,role=?,location=?,salary=?,work_mode=?,description=?,note=?,tags=?,deadline=?,updated_at=? WHERE id=? AND archived=0", [form.get("company"), form.get("role"), form.get("location"), form.get("salary"), form.get("work_mode"), form.get("description"), form.get("note"), form.get("tags"), fromDateInput(String(form.get("deadline") || "")), new Date().toISOString(), job.id]); await onRefresh(); setEditing(false); if (result.changes === 0) { notify("职位状态刚有变化，这次编辑没有保存。请重新打开后确认。", "info"); return; } notify("职位信息已保存"); }
  return <Drawer label={`${job.company} · ${job.role}`} onClose={onClose} wide><div className="career-job-drawer-head"><CompanyMark company={job.company} /><div><SourceBadge source={job.source} /><h2>{job.role}</h2><p>{job.company} · {job.location || "地点待确认"}</p></div><button className="career-icon-button" onClick={onClose} aria-label="关闭职位详情"><X size={19} /></button></div><div className="career-job-status-row">{archived ? <span className="career-archived-state"><Archive size={14} />已归档 · {currentStage?.name ?? "原阶段"}</span> : <select value={job.stage_id} disabled={lifecyclePending} onChange={(event) => void onLifecycle({ kind: "stage", jobId: job.id, nextStageId: event.target.value })} aria-label="职位阶段">{data.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select>}{ended && !archived && <span className="career-ended-state">已结束 · 只记录结果</span>}{careerJobIsWatched(job.priority) && <span><Target size={14} />已关注</span>}{safeLink(job.source_url) && <a href={job.source_url} target="_blank" rel="noreferrer">查看原职位 <ExternalLink size={14} /></a>}</div><div className="career-drawer-tabs">{[["overview", "职位概览"], ["tasks", `待办 ${tasks.length}`], ["interviews", `面试 ${interviews.length}`], ["materials", `材料 ${materials.length}`]].map(([id, label]) => <button className={tab === id ? "active" : ""} aria-pressed={tab === id} key={id} onClick={() => setTab(id as typeof tab)}>{label}</button>)}</div><div className="career-drawer-body">{tab === "overview" && (editing ? <form className="career-form" onSubmit={save}><Field label="公司"><input name="company" defaultValue={job.company} required /></Field><Field label="职位"><input name="role" defaultValue={job.role} required /></Field><div className="career-form-row"><Field label="地点"><input name="location" defaultValue={job.location} /></Field><Field label="工作方式"><input name="work_mode" defaultValue={job.work_mode} /></Field></div><div className="career-form-row"><Field label="薪资"><input name="salary" defaultValue={job.salary} /></Field><Field label="截止时间"><input name="deadline" type="datetime-local" defaultValue={dateInputValue(job.deadline)} /></Field></div><Field label="标签"><input name="tags" defaultValue={job.tags} /></Field><Field label="职位描述"><textarea name="description" rows={7} defaultValue={job.description} /></Field><Field label="个人备注"><textarea name="note" rows={4} defaultValue={job.note} /></Field><div className="career-form-actions"><button type="button" className="career-button ghost" onClick={() => setEditing(false)}>取消</button><button className="career-button primary">保存修改</button></div></form> : <>{!archived && <div className="career-detail-actions"><button className="career-button secondary career-ai-trigger" onClick={() => onAi("fit_analysis", "AI 职位要求拆解", { job })}><Sparkles size={15} />拆解职位要求</button><button className="career-button ghost" onClick={() => setEditing(true)}><Pencil size={15} />编辑</button><CareerAiDisclosure action="fit_analysis" className="in-job-actions" /></div>}<dl className="career-detail-grid"><div><dt>薪资范围</dt><dd>{job.salary || "未记录"}</dd></div><div><dt>工作方式</dt><dd>{job.work_mode || "未记录"}</dd></div><div><dt>申请来源</dt><dd>{job.source}</dd></div><div><dt>投递时间</dt><dd>{job.applied_at ? formatDate(job.applied_at) : "尚未投递"}</dd></div><div><dt>旧版联系人备注</dt><dd>{job.contact_name || "没有旧版备注"}</dd></div><div><dt>截止时间</dt><dd>{job.deadline ? formatDate(job.deadline, true) : "未记录"}</dd></div></dl><section className="career-detail-section"><h3>已关联联系人</h3>{linkedContacts.length > 0 ? <div className="career-job-contact-links">{linkedContacts.map((contact) => <button key={contact.id} onClick={() => onSelectContact(contact.id)}><span className="career-contact-avatar">{initials(contact.name)}</span><span><b>{contact.name}</b><small>{[contact.role, contact.company, contact.archived === 1 ? "已归档" : ""].filter(Boolean).join(" · ")}</small></span><ChevronRight size={16} /></button>)}</div> : <p className="career-contact-calm-copy">{job.contact_name ? `旧版备注写着“${job.contact_name}”，尚未确认成联系人关系。请从联系人页面明确关联。` : "还没有明确关联的联系人。可在联系人详情中管理职位关系。"}</p>}</section><section className="career-detail-section"><h3>职位描述</h3><p className="career-long-copy">{job.description || "还没有保存职位描述。"}</p></section><section className="career-detail-section"><h3>我的备注</h3><p className="career-long-copy">{job.note || "还没有添加备注。"}</p></section><div className="career-card-tags">{job.tags.split(",").filter(Boolean).map((tag) => <i key={tag}>{tag}</i>)}</div></>)}
    {tab === "tasks" && <div className="career-drawer-list career-drawer-task-list">{tasks.map((task) => <CareerTaskRow key={task.id} task={task} data={data} now={now} onOpen={onOpenTask} onComplete={onCompleteTask} />)}{tasks.length === 0 && <EmptyState icon={<ListTodo />} title="还没有待办" text="为这个职位安排一个具体的下一步。" />}</div>}{tab === "interviews" && <div className="career-drawer-list">{interviews.map((item) => <article key={item.id}><span className="career-list-icon"><MessageSquareText size={16} /></span><div><b>{item.round_name}</b><small>{formatDate(item.scheduled_at, true)} · {item.interviewer || "面试官待确认"}{isCareerLifecyclePaused(item) ? " · 随职位暂停" : item.status === "canceled" ? " · 已取消" : ""}</small><p>{item.summary}</p></div></article>)}{interviews.length === 0 && <EmptyState icon={<MessageSquareText />} title="还没有面试轮次" text="推进到面试后，在这里完整记录每一轮。" />}</div>}{tab === "materials" && <div className="career-drawer-list">{materials.map((item) => <article key={item.id}><span className="career-list-icon"><FileText size={16} /></span><div><b>{item.name}</b><small>{item.kind} · {item.version}{item.status === "deleting" ? " · 等待收尾" : ""}</small><p>{item.status === "deleting" ? "原件状态尚未确认，请到材料页继续或稍后核对。" : item.notes}</p></div></article>)}{materials.length === 0 && <EmptyState icon={<FileText />} title="还没有关联材料" text="关联确切版本，之后随时知道发出的是哪一份。" />}</div>}</div><footer className="career-drawer-footer">{archived ? <button className="career-button secondary" disabled={lifecyclePending} onClick={() => void onLifecycle({ kind: "restore", jobId: job.id })}><RotateCcw size={15} />从归档取回</button> : <button className="career-button ghost" disabled={lifecyclePending} onClick={() => void onLifecycle({ kind: "archive", jobId: job.id })}><Archive size={15} />收进归档</button>}<span>{archived ? "取回不会自动恢复已经过去或后来修改过的安排。" : "归档只是整理，不会删除职位或相关记录。"}</span></footer></Drawer>;
}

type InterviewEditorSnapshot = {
  status: Interview["status"];
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
    const statusIsValid = snapshot && ["scheduled", "completed", "canceled"].includes(snapshot.status);
    if (parsed?.version !== 1 || parsed.interviewId !== interview.id || typeof parsed.savedAt !== "string" ||
      typeof parsed.sourceUpdatedAt !== "string" || !snapshot || !statusIsValid ||
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
  const lifecyclePaused = isCareerLifecyclePaused(interview);
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
    if (lifecyclePaused && status !== "canceled") {
      notify("这轮面试仍随职位暂停，不能从普通状态菜单恢复。请先取回职位并使用恢复安排。", "info");
      return;
    }
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
      notify("面经草稿仅保存在当前完整网址与浏览器资料中", "info");
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
      {draftRestored && <div className="career-local-draft-note" role="status"><FileArchive size={17} /><span><b>已恢复当前网址下的本机草稿</b><small>{formatDate(draftRestored.savedAt, true)} 保存{draftRestored.basedOnOlderVersion ? " · 原面经之后有过更新，请核对再正式保存" : ""}。它不在 SQLite 或导出备份中。</small></span></div>}
      <div className="career-experience-toolbar">
        <select value={status} disabled={lifecyclePaused} onChange={(event) => setStatus(event.target.value as Interview["status"])} aria-label="面试状态"><option value="scheduled">待进行</option><option value="completed">已完成</option><option value="canceled">{lifecyclePaused ? "随职位暂停" : "已取消"}</option></select>
        <button type="button" className="career-button secondary career-ai-trigger" onClick={() => onAi(
          "structure_interview",
          "AI 整理面经",
          { job, interview: { round_name: interview.round_name, summary, raw_notes: rawNotes, questions, reflection } },
          { label: "填入面经草稿", onApply: applyStructuredInterview },
        )}><Sparkles size={15} />AI 整理速记</button>
      </div>
      <CareerAiDisclosure action="structure_interview" />
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
  </Drawer>{closePrompt && <Modal title="保留这次编辑吗？" description="这些修改还没有写入职迹的 SQLite 数据库。" onClose={() => setClosePrompt(false)}><div className="career-draft-choice"><p>你可以继续编辑、暂存在当前网址的浏览器存储，或明确放弃这次修改。</p><div><button type="button" className="career-button primary" data-dialog-initial onClick={() => setClosePrompt(false)}>继续编辑</button><button type="button" className="career-button secondary" onClick={saveLocalDraftAndClose}><FileArchive size={16} />保存本机草稿并关闭</button><button type="button" className="career-button danger" onClick={discardAndClose}><Trash2 size={16} />放弃修改</button></div><small><ShieldCheck size={14} />本机草稿只在当前完整网址与浏览器资料对应的站点存储中，不进入 SQLite 或导出备份；换网址、浏览器资料或清除该网址的站点数据都可能让这里看不到它。</small></div></Modal>}</>;
}

type CareerContactCommandPhase = "editing" | "writing" | "uncertain" | "checking" | "refreshing" | "refresh-only" | "blocked";

function careerContactInspectionDecision(inspection: CareerContactWriteInspection) {
  if (inspection === "exact_saved") return "refresh" as const;
  if (inspection === "absent") return "retry-same-command" as const;
  if (inspection === "conflict") return "block" as const;
  return "inspect-only" as const;
}

function careerContactExpectedState(detail: CareerContactDetail): CareerContactExpectedState {
  return {
    expectedUpdatedAt: detail.contact.updated_at,
    expectedArchived: detail.contact.archived === 1,
    expectedJobIds: detail.associations.map((association) => association.job_id),
  };
}

function careerContactErrorText(error: unknown, fallback: string) {
  if (error instanceof CareerContactMutationError) {
    if (error.code === "changed") return "联系人刚在另一个页面发生了变化。没有依据旧资料继续写入。";
    if (error.code === "conflict") return "这个操作标识已对应另一份内容。没有覆盖，也不会换一个标识重试。";
    if (error.code === "inspect_failed") return "暂时无法核对当前资料，因此没有开始写入。";
    if (error.code === "write_failed") return "已确认这次没有写入；表单内容和原操作标识仍保留。";
  }
  return error instanceof Error ? error.message : fallback;
}

function useCareerContactWorkProtection(protectedWork: boolean) {
  useEffect(() => {
    if (!protectedWork) return;
    function protect(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [protectedWork]);
}

function useCareerContactPhaseFocus(phase: string, secondary: boolean) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const previousSecondaryRef = useRef(secondary);
  useEffect(() => {
    const returningToForm = previousSecondaryRef.current && !secondary;
    previousSecondaryRef.current = secondary;
    if ((phase === "editing" || phase === "ready") && !secondary && !returningToForm) return;
    const frame = window.requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      const target = root.querySelector<HTMLElement>("[data-contact-safe-focus]:not([disabled])") ??
        (returningToForm ? root.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled]), select:not([disabled])") : null) ?? root;
      target.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [phase, secondary]);
  return rootRef;
}

function ContactWriteStatus({ icon, title, message, action }: { icon: "busy" | "safe"; title: string; message: string; action?: ReactNode }) {
  return <div className="career-contact-write-status" role="status"><span>{icon === "busy" ? <LoaderCircle className="spin" size={23} /> : <ShieldCheck size={23} />}</span><h3>{title}</h3><p>{message}</p>{action && <div>{action}</div>}</div>;
}

function ContactDiscardPrompt({ noun, onKeep, onDiscard }: { noun: string; onKeep: () => void; onDiscard: () => void }) {
  return <div className="career-contact-discard" role="status"><ShieldCheck size={23} /><h3>放下还没保存的{noun}？</h3><p>只有表单里的输入会被放下；已经保存的联系人资料不会改变。</p><div><button type="button" className="career-button primary" data-contact-safe-focus onClick={onKeep}>继续填写</button><button type="button" className="career-button ghost" onClick={onDiscard}>放下输入</button></div></div>;
}

function ContactDrawer({ contactId, revision, now, externalHint, onClose, onEdit, onRecord, onAddTask, onOpenTask, onCompleteTask, onRefresh, onArchived, onRestored, notify }: {
  contactId: string;
  revision: number;
  now: number;
  externalHint: string;
  onClose: () => void;
  onEdit: () => void;
  onRecord: () => void;
  onAddTask: () => void;
  onOpenTask: (taskId: string) => void;
  onCompleteTask: (task: Task) => void | Promise<void>;
  onRefresh: () => Promise<void>;
  onArchived: (contact: Contact, expected: CareerContactExpectedState) => void;
  onRestored: (contact: Contact) => void;
  notify: (text: string, tone?: Notice["tone"]) => void;
}) {
  const [detail, setDetail] = useState<CareerContactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState("");
  const [readRevision, setReadRevision] = useState(0);
  const [phase, setPhase] = useState<"ready" | "confirm-archive" | "writing" | "refresh-only" | "refreshing">("ready");
  const [message, setMessage] = useState("");
  const writeRef = useRef(false);
  const targetArchivedRef = useRef<boolean | null>(null);
  const phaseRootRef = useCareerContactPhaseFocus(phase, false);
  const locked = phase === "writing" || phase === "refreshing" || phase === "refresh-only";
  useCareerContactWorkProtection(locked);
  useEffect(() => {
    let live = true;
    void loadCareerContactDetail(contactId).then((next) => { if (live) { setReadError(""); setDetail(next); } }).catch(() => {
      if (live) setReadError("联系人资料暂时没有打开。没有把它当成空记录。");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [contactId, revision, readRevision]);

  if (loading && !detail) return <Drawer label="联系人详情" onClose={onClose} wide><div className="career-drawer-loading"><LoaderCircle className="spin" size={20} /><p>正在打开联系人…</p></div></Drawer>;
  if (readError && !detail) return <Drawer label="联系人详情" onClose={onClose} wide><div className="career-drawer-read-error" role="alert"><ShieldCheck size={22} /><h2>联系人资料暂时没有打开</h2><p>{readError}</p><div><button className="career-button primary" data-dialog-initial onClick={() => setReadRevision((current) => current + 1)}><RotateCcw size={16} />重新读取</button><button className="career-button ghost" onClick={onClose}>关闭</button></div></div></Drawer>;
  if (!detail) return <Drawer label="联系人详情" onClose={onClose} wide><div className="career-drawer-read-error"><ShieldCheck size={22} /><h2>没有找到这位联系人</h2><p>联系人记录可能已经变化，这里没有把它显示成一份空资料。</p><button className="career-button primary" onClick={onClose}>关闭</button></div></Drawer>;
  const { contact } = detail;
  const openTasks = detail.tasks.filter((task) => task.status === "todo").sort((left, right) => (left.due_at ?? "9999").localeCompare(right.due_at ?? "9999"));
  const nextTask = openTasks[0];
  const archived = contact.archived === 1;
  const identity = [contact.role, contact.company].filter(Boolean).join(" · ");

  async function refreshArchiveResult() {
    const targetArchived = targetArchivedRef.current;
    if (targetArchived === null || writeRef.current) return;
    writeRef.current = true;
    setPhase("refreshing");
    setMessage("");
    try {
      await onRefresh();
      const latest = await loadCareerContactExpectedState(contactId);
      if (!latest) {
        onClose();
        notify("联系人已在另一个页面移除；这里没有继续更改", "info");
      } else if (latest.expectedArchived === targetArchived) {
        if (targetArchived) onArchived(contact, latest);
        else onRestored(contact);
      } else {
        setPhase("ready");
        setMessage(targetArchived ? "已重新读到最新资料：联系人仍未归档，没有再次提交。" : "已重新读到最新资料：联系人仍在归档中，没有再次提交。");
        setReadRevision((current) => current + 1);
      }
    } catch {
      setPhase("refresh-only");
      setMessage("状态写入结果还没有重新读到。这里只能继续刷新，不能重复归档或恢复。");
    } finally { writeRef.current = false; }
  }

  async function changeArchive(targetArchived: boolean) {
    if (!detail || writeRef.current) return;
    writeRef.current = true;
    targetArchivedRef.current = targetArchived;
    setPhase("writing");
    setMessage("");
    const expected = careerContactExpectedState(detail);
    try {
      const result = targetArchived
        ? await archiveCareerContactSafely(contactId, expected)
        : await restoreCareerContactSafely(contactId, expected);
      if (result.outcome === "changed") {
        setPhase("refresh-only");
        setMessage("联系人刚在另一个页面发生了变化。没有依据旧状态继续；接下来只重新读取。");
      } else if (result.outcome === "outcome_uncertain") {
        setPhase("refresh-only");
        setMessage("本机是否完成状态更新暂时无法确认。接下来只重新读取，不会重复提交。");
      } else {
        writeRef.current = false;
        await refreshArchiveResult();
        return;
      }
    } catch (error) {
      if (error instanceof CareerContactMutationError && error.code === "changed") {
        setPhase("refresh-only");
        setMessage("联系人刚在另一个页面发生了变化。没有覆盖新状态；接下来只重新读取。");
      } else {
        targetArchivedRef.current = null;
        setPhase("ready");
        setMessage(careerContactErrorText(error, "这次没有更新联系人状态，原记录仍保持不变。"));
      }
    } finally { writeRef.current = false; }
  }
  return <Drawer label={`${contact.name} · 联系人详情`} onClose={onClose} dismissible={!locked} inertToasts={locked} wide>
    <div ref={phaseRootRef} className="career-contact-drawer-phase" tabIndex={-1}>
      <div className="career-contact-drawer-head"><span className="career-contact-avatar large">{initials(contact.name)}</span><div><span>{archived ? "已归档联系人" : "联系人"}</span><h2>{contact.name}</h2>{identity && <p>{identity}</p>}</div>{!locked && <button className="career-icon-button" onClick={onClose} aria-label="关闭联系人详情"><X size={19} /></button>}</div>
      {phase === "confirm-archive" ? <div className="career-contact-archive-confirm" role="status"><Archive size={23} /><h3>把这位联系人移入归档？</h3><p>只会把联系人从常用列表收起。联系历史和职位关联会保留；已经安排的待办仍会出现在“今日”和日历，不会被取消。</p><div><button className="career-button primary" data-contact-safe-focus onClick={() => setPhase("ready")}>继续保留</button><button className="career-button ghost" onClick={() => void changeArchive(true)}>确认移入归档</button></div></div> : phase === "writing" || phase === "refreshing" ? <ContactWriteStatus icon="busy" title={phase === "writing" ? "正在核对并保存" : "已经停止写入，正在重新读取"} message={phase === "writing" ? "会先核对联系人版本；这时不能关闭，以免失去结果。" : "这里只刷新画面，不会再次提交状态更改。"} /> : phase === "refresh-only" ? <ContactWriteStatus icon="safe" title="只重新读取联系人状态" message={message} action={<button className="career-button primary" data-contact-safe-focus onClick={() => void refreshArchiveResult()}><RotateCcw size={16} />只读核对</button>} /> : <>
        <div className="career-contact-drawer-actions">{!archived && <button className="career-button primary" onClick={onRecord}><MessageSquareText size={16} />记录联系</button>}<button className="career-button secondary" onClick={onEdit}><Pencil size={15} />编辑</button></div>
        {externalHint && <div className="career-contact-external-hint" role="status"><ShieldCheck size={16} /><span>{externalHint}</span></div>}
        {message && <div className="career-contact-read-warning" role="status"><ShieldCheck size={16} /><span>{message}</span></div>}
        {readError && <div className="career-contact-read-warning" role="alert"><ShieldCheck size={16} /><span>相关记录暂时没有重新读到，画面保留上一次成功读取的内容。</span><button onClick={() => setReadRevision((current) => current + 1)}>重新读取</button></div>}
        <div className="career-drawer-body career-contact-detail">
          <section><header><div><span>NEXT STEP</span><h3>下一步</h3></div>{!archived && <button className="career-text-button" onClick={onAddTask}>{nextTask ? "再安排一步" : "安排下一步"}<ChevronRight size={14} /></button>}</header>{nextTask ? <CareerTaskRow compact task={nextTask} data={{ ...emptyData, jobs: detail.jobs, stages: [] }} now={now} onOpen={onOpenTask} onComplete={onCompleteTask} /> : <p className="career-contact-calm-copy">没有安排下一步。需要时再决定，不必为了填满而创建提醒。</p>}</section>
          <section><header><div><span>CONTEXT</span><h3>关联职位</h3></div><button className="career-text-button" onClick={onEdit}>管理关联 <ChevronRight size={14} /></button></header>{detail.jobs.length > 0 ? <div className="career-contact-related-jobs">{detail.jobs.map((job) => <span key={job.id}><CompanyMark company={job.company} small /><b>{job.role}</b><small>{job.company}</small></span>)}</div> : <p className="career-contact-calm-copy">还没有关联职位。只有你明确选择后，这里才会建立关系。</p>}</section>
          <section><header><div><span>HISTORY</span><h3>联系记录</h3></div>{!archived && <button className="career-text-button" onClick={onRecord}>记录一次 <Plus size={14} /></button>}</header>{detail.interactions.length > 0 ? <div className="career-contact-timeline">{detail.interactions.map((interaction) => <article key={interaction.id}><i /><div><header><b>{interaction.summary}</b><time>{formatDate(interaction.occurred_at, true)}</time></header><p>{interaction.channel || "未注明渠道"} · {interaction.direction === "outbound" ? "我发出" : interaction.direction === "inbound" ? "对方发来" : "双方交流"}{interaction.job_id ? ` · ${detail.jobs.find((job) => job.id === interaction.job_id)?.role ?? "关联职位"}` : ""}</p>{interaction.notes && <small>{interaction.notes}</small>}</div></article>)}</div> : <p className="career-contact-calm-copy">还没有联系记录。不需要为了填满而补写；下次真实交流后再记。</p>}</section>
          <section><header><div><span>CONTACT</span><h3>联系方式</h3></div></header><div className="career-contact-channels">{contact.email && <a href={`mailto:${contact.email}`}><ContactRound size={16} /><span><b>邮箱</b><small>{contact.email}</small></span><ExternalLink size={14} /></a>}{contact.phone && <a href={`tel:${contact.phone.replace(/[^+\d*#,;]/g, "")}`}><Phone size={16} /><span><b>电话</b><small>{contact.phone}</small></span><ExternalLink size={14} /></a>}{!contact.email && !contact.phone && <p className="career-contact-calm-copy">还没有保存邮箱或电话。</p>}</div>{contact.notes && <p className="career-contact-notes">{contact.notes}</p>}</section>
        </div>
        <footer className="career-drawer-footer"><button className={archived ? "career-button secondary" : "career-button ghost"} onClick={() => archived ? void changeArchive(false) : setPhase("confirm-archive")}>{archived ? <RotateCcw size={15} /> : <Archive size={15} />}{archived ? "恢复联系人" : "移入归档"}</button></footer>
      </>}
    </div>
  </Drawer>;
}

function JobModal({ data, onClose, onSaved }: { data: CareerData; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setSaving(true); const form = new FormData(event.currentTarget); const id = newId("job"); const now = new Date().toISOString(); try { await runCareerBatch([{ sql: `INSERT INTO career_jobs (id,company,role,location,source,source_url,stage_id,priority,salary,work_mode,description,applied_at,deadline,contact_name,note,tags,created_at,updated_at,archived,position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0)`, params: [id, form.get("company"), form.get("role"), form.get("location"), form.get("source"), form.get("source_url"), form.get("stage_id"), Number(form.get("priority")), form.get("salary"), form.get("work_mode"), form.get("description"), form.get("stage_id") === "stage_applied" ? now : null, fromDateInput(String(form.get("deadline") || "")), "", form.get("note"), form.get("tags"), now, now] }, { sql: "INSERT INTO career_activity (id,job_id,type,detail,created_at) VALUES (?,?,?,?,?)", params: [newId("activity"), id, "create", `记录了 ${form.get("company")} · ${form.get("role")}`, now] }]); await onSaved(id); } finally { setSaving(false); } }
  return <Modal title="记录一个新职位" description="先写下关键信息，细节可以随时补充。" onClose={onClose} wide><form className="career-form" onSubmit={submit}><div className="career-form-row"><Field label="公司"><input name="company" required placeholder="例如：Linear" /></Field><Field label="职位"><input name="role" required placeholder="例如：Product Designer" /></Field></div><div className="career-form-row thirds"><Field label="当前阶段"><select name="stage_id" defaultValue="stage_saved">{data.stages.filter((stage) => !stage.is_terminal).map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></Field><Field label="是否关注" hint="只是方便筛选，不是优先级评分"><select name="priority" defaultValue="1"><option value="1">普通记录</option><option value="2">已关注</option></select></Field><Field label="来源"><select name="source" defaultValue="手动记录"><option>手动记录</option><option>LinkedIn</option><option>BOSS直聘</option><option>官网</option><option>内推</option></select></Field></div><div className="career-form-row"><Field label="地点"><input name="location" placeholder="上海 / 远程" /></Field><Field label="工作方式"><select name="work_mode"><option value="">待确认</option><option>现场办公</option><option>混合办公</option><option>远程</option></select></Field></div><div className="career-form-row"><Field label="薪资"><input name="salary" placeholder="¥30k–45k / 月" /></Field><Field label="截止时间"><input name="deadline" type="datetime-local" /></Field></div><Field label="原职位链接"><input name="source_url" type="url" placeholder="https://" /></Field><Field label="标签" hint="用逗号分隔"><input name="tags" placeholder="AI, 产品设计, 远程" /></Field><Field label="职位描述"><textarea name="description" rows={5} placeholder="粘贴岗位职责和要求…" /></Field><Field label="个人备注"><textarea name="note" rows={3} placeholder="为什么感兴趣？下一步要确认什么？" /></Field><div className="career-form-actions"><button type="button" className="career-button ghost" onClick={onClose}>取消</button><button className="career-button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}保存职位</button></div></form></Modal>;
}

function TaskModal({ data, initialJobId, onClose, onSaved }: { data: CareerData; initialJobId: string | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [phase, setPhase] = useState<"idle" | "writing" | "refresh-only">("idle");
  const [error, setError] = useState("");
  const savingRef = useRef(false);
  const stableIdRef = useRef(newId("task"));
  const activeStageIds = new Set(data.stages.filter((stage) => stage.is_terminal !== 1).map((stage) => stage.id));
  const availableJobs = data.jobs.filter((job) => job.archived !== 1 && activeStageIds.has(job.stage_id));
  async function finishRefresh() {
    try { await onSaved(); }
    catch { setPhase("refresh-only"); setError("待办已保存在本机，但画面还没有重新读取。请只重新读取，不要重复提交。"); }
  }
  async function retryRefresh() {
    if (phase !== "refresh-only") return;
    setError("");
    try { await onSaved(); }
    catch { setError("待办仍已保存在本机。这里只会重新读取，不会再次创建。"); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setPhase("writing");
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await careerTaskActions.create({
        id: stableIdRef.current,
        title: String(form.get("title") ?? ""),
        jobId: String(form.get("job_id") ?? "") || null,
        dueAt: fromDateInput(String(form.get("due_at") || "")),
        kind: String(form.get("kind") ?? "跟进"),
        priority: Number(form.get("priority") ?? 1),
      });
      setPhase("refresh-only");
      await finishRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "待办暂时没有保存，请再试一次");
      setPhase("idle");
    } finally {
      savingRef.current = false;
    }
  }
  if (phase === "refresh-only") return <Modal title="待办已保存在本机" description="画面还没有重新读取。请只重新读取，不要重复提交。" onClose={() => undefined} dismissible={false} inertToasts><div className="career-task-refresh-only" role="status"><ShieldCheck size={22} /><p>{error || "这条待办已经写入本地 SQLite；重新读取不会再创建一条。"}</p><button className="career-button primary" data-dialog-initial onClick={() => void retryRefresh()}><RotateCcw size={16} />重新读取</button></div></Modal>;
  return <Modal title="新建待办" description="记录你主动决定的下一步；计划时间可以留空。" onClose={phase === "writing" ? () => undefined : onClose}><form className="career-form" onSubmit={submit}><Field label="要做什么"><input name="title" required placeholder="例如：发送面试感谢邮件" /></Field><Field label="关联职位" hint="可选"><select name="job_id" defaultValue={initialJobId ?? ""}><option value="">个人待办</option>{availableJobs.map((job) => <option key={job.id} value={job.id}>{job.company} · {job.role}</option>)}</select></Field><div className="career-form-row"><Field label="计划时间（可选）" hint="不设时间会放在“以后再说”"><input name="due_at" type="datetime-local" /></Field><Field label="类型"><select name="kind"><option>跟进</option><option>面试准备</option><option>材料</option><option>截止事项</option><option>其他</option></select></Field></div><Field label="优先级"><select name="priority" defaultValue="1"><option value="1">普通</option><option value="2">重点</option><option value="3">时间敏感</option></select></Field>{error && <div className="career-inline-error" role="alert"><X size={15} />{error}</div>}<div className="career-form-actions"><button type="button" className="career-button ghost" disabled={phase === "writing"} onClick={onClose}>取消</button><button className="career-button primary" disabled={phase === "writing"}>{phase === "writing" ? <LoaderCircle className="spin" size={16} /> : <ListTodo size={16} />}{phase === "writing" ? "正在创建…" : "创建待办"}</button></div></form></Modal>;
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

function ContactModal({ contactId, data, externalHint, onClose, onRefresh, onSaved, notify }: { contactId: string | null; data: CareerData; externalHint: string; onClose: () => void; onRefresh: () => Promise<void>; onSaved: (contactId: string) => void; notify: (text: string, tone?: Notice["tone"]) => void }) {
  const [detail, setDetail] = useState<CareerContactDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(contactId));
  const [readError, setReadError] = useState("");
  const [readRevision, setReadRevision] = useState(0);
  const [phase, setPhase] = useState<CareerContactCommandPhase>("editing");
  const [dirty, setDirty] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<CareerContactWriteReceipt | null>(null);
  const [stableContactId] = useState(() => newId("contact"));
  const [stableCreatedAt] = useState(() => new Date().toISOString());
  const commandRef = useRef<CreateCareerContactSafeInput | null>(null);
  const writeRef = useRef(false);
  const refreshOutcomeRef = useRef<"saved" | "changed">("saved");
  const phaseRootRef = useCareerContactPhaseFocus(phase, discardPrompt);
  const locked = phase === "writing" || phase === "checking" || phase === "refreshing" || phase === "refresh-only" || phase === "uncertain";
  useCareerContactWorkProtection(dirty || locked);
  useEffect(() => {
    if (!contactId) return;
    let live = true;
    void loadCareerContactDetail(contactId).then((next) => {
      if (!live) return;
      if (next) setDetail(next);
      else setReadError("没有找到这位联系人。资料可能已在另一个页面发生变化。");
    }).catch(() => {
      if (live) setReadError("联系人资料暂时没有打开；这里没有把未知内容当成空表单。");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [contactId, readRevision]);
  function retryRead() {
    setLoading(true);
    setReadError("");
    setReadRevision((current) => current + 1);
  }
  function requestClose() {
    if (locked) return;
    if (dirty && phase === "editing") { setDiscardPrompt(true); return; }
    onClose();
  }
  async function refreshOnly(id: string) {
    if (writeRef.current) return;
    writeRef.current = true;
    setPhase("refreshing");
    setError("");
    try {
      await onRefresh();
      setDirty(false);
      if (refreshOutcomeRef.current === "saved") onSaved(id);
      else {
        onClose();
        notify("联系人资料已变化；没有覆盖新版本，已重新读取", "info");
      }
    } catch {
      setPhase("refresh-only");
      setError(refreshOutcomeRef.current === "saved"
        ? "联系人已保存在本机，但画面还没有重新读取。这里只会刷新，不会重复保存。"
        : "旧版本写入已经停止；这里只会重新读取，不会依据旧资料继续保存。");
    } finally { writeRef.current = false; }
  }
  async function inspectUncertain() {
    if (!receipt || writeRef.current) return;
    writeRef.current = true;
    setPhase("checking");
    setError("");
    try {
      const inspection = await inspectCareerContactWrite(receipt);
      const decision = careerContactInspectionDecision(inspection);
      if (decision === "refresh") {
        refreshOutcomeRef.current = "saved";
        writeRef.current = false;
        await refreshOnly(stableContactId);
        return;
      }
      if (decision === "retry-same-command") {
        setReceipt(null);
        setPhase("editing");
        setError("已确认这次没有保存。表单和原联系人标识都保留；再次保存会复用同一个标识。");
      } else if (decision === "block") {
        setPhase("blocked");
        setError("这个联系人标识已经对应另一份内容。没有覆盖；请关闭后核对联系人列表。");
      } else {
        setPhase("uncertain");
        setError("本机仍无法确认是否已经保存。继续核对不会重复创建联系人。");
      }
    } catch {
      setPhase("uncertain");
      setError("暂时无法核对保存结果。这里只保留原核对凭据，不会重新提交。");
    } finally { writeRef.current = false; }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writeRef.current) return;
    writeRef.current = true;
    setPhase("writing");
    setError("");
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
      if (contactId && detail) {
        const result = await updateCareerContactSafely(contactId, input, careerContactExpectedState(detail));
        if (result.outcome === "changed" || result.outcome === "outcome_uncertain") {
          refreshOutcomeRef.current = "changed";
          setPhase("refresh-only");
          setError(result.outcome === "changed"
            ? "联系人刚在另一个页面发生了变化。没有覆盖新版本；接下来只重新读取。"
            : "是否完成更新暂时无法确认。接下来只重新读取，不会再次保存表单。");
        } else {
          refreshOutcomeRef.current = "saved";
          writeRef.current = false;
          await refreshOnly(contactId);
          return;
        }
      } else if (!contactId) {
        const command: CreateCareerContactSafeInput = { ...input, contactId: stableContactId, createdAt: stableCreatedAt };
        commandRef.current = command;
        const result = await createCareerContactSafely(command);
        if (result.outcome === "outcome_uncertain") {
          setReceipt(result.receipt);
          setPhase("uncertain");
          setError("本机是否完成保存暂时无法确认。下一步只能核对同一份凭据，不能直接再创建。");
        } else {
          refreshOutcomeRef.current = "saved";
          writeRef.current = false;
          await refreshOnly(stableContactId);
          return;
        }
      }
    } catch (caught) {
      if (caught instanceof CareerContactMutationError && caught.code === "changed") {
        refreshOutcomeRef.current = "changed";
        setPhase("refresh-only");
        setError("联系人刚在另一个页面发生了变化。没有覆盖新版本；接下来只重新读取。");
      } else if (caught instanceof CareerContactMutationError && caught.code === "conflict") {
        setPhase("blocked");
        setError(careerContactErrorText(caught, "操作标识发生冲突，没有覆盖已有记录。"));
      } else {
        setPhase("editing");
        setError(careerContactErrorText(caught, "这次没有保存，表单内容仍保留。"));
      }
    } finally { writeRef.current = false; }
  }
  const contact = detail?.contact;
  const linked = new Set(detail?.associations.map((association) => association.job_id) ?? []);
  const jobsForPicker = Array.from(new Map(
    [...(detail?.jobs ?? []), ...data.jobs].map((job) => [job.id, job]),
  ).values());
  const canDismiss = phase === "editing" || phase === "blocked" || Boolean(readError);
  // Nested semantic text labels each checkbox; the configured static-depth rule cannot follow it.
  // eslint-disable-next-line jsx-a11y/label-has-associated-control
  return <Modal title={contactId ? "编辑联系人" : "添加联系人"} description="只保存你确认过的资料与职位关系；联系事实需要单独记录。" onClose={requestClose} dismissible={canDismiss} inertToasts={!canDismiss} wide><div ref={phaseRootRef} className="career-contact-modal-phase" tabIndex={-1}>{loading ? <div className="career-modal-loading"><LoaderCircle className="spin" size={20} />正在打开资料…</div> : contactId && (!detail || readError) ? <div className="career-drawer-read-error" role="status"><ShieldCheck size={22} /><h3>联系人资料暂时没有打开</h3><p>{readError || "没有把它显示成一份可覆盖的空表单。"}</p><div><button type="button" className="career-button primary" data-dialog-initial onClick={retryRead}><RotateCcw size={16} />重新读取</button><button type="button" className="career-button ghost" onClick={onClose}>关闭</button></div></div> : <>{phase === "writing" || phase === "checking" || phase === "refreshing" ? <ContactWriteStatus icon="busy" title={phase === "writing" ? "正在核对并保存" : phase === "checking" ? "正在只读核对保存结果" : "已经停止写入，正在重新读取"} message={phase === "checking" ? "只核对原凭据，不会再次创建联系人。" : phase === "refreshing" ? "这一步只刷新画面，不会再次保存。" : "写入期间会保留表单，暂时不能关闭。"} /> : phase === "uncertain" ? <ContactWriteStatus icon="safe" title="先核对这次保存" message={error} action={<button className="career-button primary" data-contact-safe-focus onClick={() => void inspectUncertain()}><Search size={16} />只读核对</button>} /> : phase === "refresh-only" ? <ContactWriteStatus icon="safe" title="只重新读取联系人" message={error} action={<button className="career-button primary" data-contact-safe-focus onClick={() => void refreshOnly(contactId ?? stableContactId)}><RotateCcw size={16} />重新读取</button>} /> : phase === "blocked" ? <ContactWriteStatus icon="safe" title="没有覆盖已有记录" message={error} action={<button className="career-button primary" data-contact-safe-focus onClick={onClose}>返回联系人</button>} /> : null}{phase === "editing" && discardPrompt && <ContactDiscardPrompt noun="联系人输入" onKeep={() => setDiscardPrompt(false)} onDiscard={() => { setDirty(false); onClose(); }} />}<form hidden={phase !== "editing" || discardPrompt} className="career-form" onChange={() => setDirty(true)} onSubmit={submit}>{externalHint && <div className="career-contact-external-hint" role="status"><ShieldCheck size={16} /><span>{externalHint}</span></div>}<div className="career-form-row"><Field label="姓名"><input name="name" required defaultValue={contact?.name ?? ""} /></Field><Field label="公司" hint="可选"><input name="company" defaultValue={contact?.company ?? ""} /></Field></div><div className="career-form-row"><Field label="身份 / 关系" hint="可选"><input name="role" defaultValue={contact?.role ?? ""} placeholder="Recruiter / 内推人" /></Field><Field label="常用渠道" hint="可选"><select name="channel" defaultValue={contact?.channel ?? ""}><option value="">不设置</option><option>LinkedIn</option><option>BOSS直聘</option><option>邮件</option><option>微信</option><option>电话</option><option>其他</option></select></Field></div><div className="career-form-row"><Field label="邮箱" hint="可选"><input name="email" type="email" defaultValue={contact?.email ?? ""} /></Field><Field label="电话" hint="可选"><input name="phone" defaultValue={contact?.phone ?? ""} /></Field></div><fieldset className="career-contact-job-picker"><legend>关联职位 <small>只建立你明确选择的关系</small></legend>{jobsForPicker.length > 0 ? <div>{jobsForPicker.map((job) => { const stage = data.stages.find((item) => item.id === job.stage_id); const context = job.archived === 1 ? "已归档" : stage?.is_terminal ? "已结束" : "进行中"; return <label key={job.id}><input type="checkbox" name="jobIds" value={job.id} defaultChecked={linked.has(job.id)} /><span><b>{job.role}</b><small>{job.company} · {context}</small></span></label>; })}</div> : <p>还没有可关联的职位。</p>}</fieldset><Field label="备注" hint="可选"><textarea name="notes" rows={4} defaultValue={contact?.notes ?? ""} placeholder="怎么认识、希望记住什么；不用重复写沟通记录。" /></Field>{error && <div className="career-inline-error" role="status"><ShieldCheck size={15} />{error}</div>}<div className="career-form-actions"><button type="button" className="career-button ghost" onClick={requestClose}>取消</button><button className="career-button primary"><Check size={16} />保存联系人</button></div></form></>}</div></Modal>;
}

function ContactInteractionModal({ contactId, data, externalHint, onClose, onRefresh, onSaved, notify }: { contactId: string; data: CareerData; externalHint: string; onClose: () => void; onRefresh: () => Promise<void>; onSaved: () => void; notify: (text: string, tone?: Notice["tone"]) => void }) {
  const [detail, setDetail] = useState<CareerContactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [scheduleNext, setScheduleNext] = useState(false);
  const [readError, setReadError] = useState("");
  const [readRevision, setReadRevision] = useState(0);
  const [phase, setPhase] = useState<CareerContactCommandPhase>("editing");
  const [dirty, setDirty] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<CareerContactWriteReceipt | null>(null);
  const [stableInteractionId] = useState(() => newId("interaction"));
  const [stableFollowUpTaskId] = useState(() => newId("task"));
  const [stableCreatedAt] = useState(() => new Date().toISOString());
  const commandRef = useRef<RecordCareerContactInteractionSafeInput | null>(null);
  const writeRef = useRef(false);
  const refreshOutcomeRef = useRef<"saved" | "changed">("saved");
  const phaseRootRef = useCareerContactPhaseFocus(phase, discardPrompt);
  const locked = phase === "writing" || phase === "checking" || phase === "refreshing" || phase === "refresh-only" || phase === "uncertain";
  useCareerContactWorkProtection(dirty || locked);
  useEffect(() => {
    let live = true;
    void loadCareerContactDetail(contactId).then((next) => {
      if (!live) return;
      if (next) setDetail(next);
      else setReadError("没有找到这位联系人。资料可能已在另一个页面发生变化。");
    }).catch(() => {
      if (live) setReadError("联系人资料暂时没有打开；这里不会把未知内容写成一次真实联系。");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [contactId, readRevision]);
  function retryRead() {
    setLoading(true);
    setReadError("");
    setReadRevision((current) => current + 1);
  }
  function requestClose() {
    if (locked) return;
    if (dirty && phase === "editing") { setDiscardPrompt(true); return; }
    onClose();
  }
  async function refreshOnly() {
    if (writeRef.current) return;
    writeRef.current = true;
    setPhase("refreshing");
    setError("");
    try {
      await onRefresh();
      setDirty(false);
      if (refreshOutcomeRef.current === "saved") onSaved();
      else {
        onClose();
        notify("联系人资料已变化；没有补写联系记录，已重新读取", "info");
      }
    } catch {
      setPhase("refresh-only");
      setError(refreshOutcomeRef.current === "saved"
        ? "联系记录已保存在本机，但画面还没有重新读取。这里只会刷新，不会再创建。"
        : "旧版本写入已经停止。这里只会重新读取，不会补写联系记录。");
    } finally { writeRef.current = false; }
  }
  async function inspectUncertain() {
    if (!receipt || writeRef.current) return;
    writeRef.current = true;
    setPhase("checking");
    setError("");
    try {
      const inspection = await inspectCareerContactWrite(receipt);
      const decision = careerContactInspectionDecision(inspection);
      if (decision === "refresh") {
        refreshOutcomeRef.current = "saved";
        writeRef.current = false;
        await refreshOnly();
        return;
      }
      if (decision === "retry-same-command") {
        setReceipt(null);
        setPhase("editing");
        setError("已确认这次没有保存。表单、联系记录标识和跟进待办标识都保留；可用同一份操作重试。");
      } else if (decision === "block") {
        setPhase("blocked");
        setError("这个联系记录标识已经对应另一份内容。没有覆盖；请关闭后核对联系历史。");
      } else {
        setPhase("uncertain");
        setError("本机仍无法确认是否已经保存。继续核对不会重复创建联系记录或待办。");
      }
    } catch {
      setPhase("uncertain");
      setError("暂时无法核对保存结果。这里只保留原核对凭据，不会重新提交。");
    } finally { writeRef.current = false; }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || writeRef.current) return;
    writeRef.current = true;
    setPhase("writing");
    setError("");
    const form = new FormData(event.currentTarget);
    const jobId = String(form.get("job_id") ?? "") || null;
    try {
      const followUpDueAt = scheduleNext
        ? fromDateInput(String(form.get("follow_up_due_at") ?? ""))
        : null;
      if (scheduleNext && !followUpDueAt) throw new Error("请为下一步选择时间");
      const direction = String(form.get("direction") ?? "");
      if (direction !== "outbound" && direction !== "inbound" && direction !== "mutual") throw new Error("请选择这次联系的真实方向");
      const command: RecordCareerContactInteractionSafeInput = {
        contactId,
        interactionId: stableInteractionId,
        createdAt: stableCreatedAt,
        occurredAt: fromDateInput(String(form.get("occurred_at") ?? "")) ?? stableCreatedAt,
        interactionType: "conversation",
        direction,
        channel: String(form.get("channel") ?? ""),
        summary: String(form.get("summary") ?? ""),
        notes: String(form.get("notes") ?? ""),
        jobId,
        associatedJobIds: jobId ? [jobId] : [],
        expectedContact: careerContactExpectedState(detail),
        followUp: scheduleNext ? {
          taskId: stableFollowUpTaskId,
          title: String(form.get("follow_up_title") ?? ""),
          dueAt: followUpDueAt!,
          kind: "跟进",
          priority: 1,
          jobId,
        } : undefined,
      };
      commandRef.current = command;
      const result = await recordCareerContactInteractionSafely(command);
      if (result.outcome === "outcome_uncertain") {
        setReceipt(result.receipt);
        setPhase("uncertain");
        setError("本机是否完成保存暂时无法确认。下一步只能核对同一份凭据，不能直接再创建。");
      } else {
        refreshOutcomeRef.current = "saved";
        writeRef.current = false;
        await refreshOnly();
        return;
      }
    } catch (caught) {
      if (caught instanceof CareerContactMutationError && caught.code === "changed") {
        refreshOutcomeRef.current = "changed";
        setPhase("refresh-only");
        setError("联系人刚在另一个页面发生了变化。没有补写这次联系；接下来只重新读取。");
      } else if (caught instanceof CareerContactMutationError && caught.code === "conflict") {
        setPhase("blocked");
        setError(careerContactErrorText(caught, "操作标识发生冲突，没有覆盖已有记录。"));
      } else {
        setPhase("editing");
        setError(careerContactErrorText(caught, "这次没有保存，表单内容仍保留。"));
      }
    } finally { writeRef.current = false; }
  }
  if (loading) return <Modal title="记录一次真实联系" description="只记录已经发生的沟通。" onClose={onClose} wide><div className="career-modal-loading"><LoaderCircle className="spin" size={20} />正在打开联系人…</div></Modal>;
  if (!detail || readError) return <Modal title="记录一次真实联系" description="先确认联系人资料，再记录已经发生的沟通。" onClose={onClose} wide><div className="career-drawer-read-error" role="status"><ShieldCheck size={22} /><h3>联系人资料暂时没有打开</h3><p>{readError || "这里没有把未知资料当成一份空记录。"}</p><div><button type="button" className="career-button primary" data-dialog-initial onClick={retryRead}><RotateCcw size={16} />重新读取</button><button type="button" className="career-button ghost" onClick={onClose}>关闭</button></div></div></Modal>;
  const contact = detail.contact;
  const jobsForPicker = Array.from(new Map([...(detail.jobs ?? []), ...data.jobs].map((job) => [job.id, job])).values());
  const canDismiss = phase === "editing" || phase === "blocked";
  // The visible title and explanation are nested so the whole row remains one generous target.
  // eslint-disable-next-line jsx-a11y/label-has-associated-control
  return <Modal title="记录一次真实联系" description={`记录与 ${contact.name} 已经发生的沟通；不会自动发送消息。`} onClose={requestClose} dismissible={canDismiss} inertToasts={!canDismiss} wide><div ref={phaseRootRef} className="career-contact-modal-phase" tabIndex={-1}>{discardPrompt ? <ContactDiscardPrompt noun="联系记录" onKeep={() => setDiscardPrompt(false)} onDiscard={() => { setDirty(false); onClose(); }} /> : <>{phase === "writing" || phase === "checking" || phase === "refreshing" ? <ContactWriteStatus icon="busy" title={phase === "writing" ? "正在核对并保存" : phase === "checking" ? "正在只读核对保存结果" : "已经停止写入，正在重新读取"} message={phase === "checking" ? "只核对原凭据，不会再次创建联系记录或待办。" : phase === "refreshing" ? "这一步只刷新画面，不会再次保存。" : "写入期间会保留表单，暂时不能关闭。"} /> : phase === "uncertain" ? <ContactWriteStatus icon="safe" title="先核对这次联系" message={error} action={<button className="career-button primary" data-contact-safe-focus onClick={() => void inspectUncertain()}><Search size={16} />只读核对</button>} /> : phase === "refresh-only" ? <ContactWriteStatus icon="safe" title="只重新读取联系人" message={error} action={<button className="career-button primary" data-contact-safe-focus onClick={() => void refreshOnly()}><RotateCcw size={16} />重新读取</button>} /> : phase === "blocked" ? <ContactWriteStatus icon="safe" title="没有覆盖已有记录" message={error} action={<button className="career-button primary" data-contact-safe-focus onClick={onClose}>返回联系历史</button>} /> : null}{phase === "editing" && discardPrompt && <ContactDiscardPrompt noun="联系记录" onKeep={() => setDiscardPrompt(false)} onDiscard={() => { setDirty(false); onClose(); }} />}<form hidden={phase !== "editing" || discardPrompt} className="career-form" onChange={() => setDirty(true)} onSubmit={submit}>{externalHint && <div className="career-contact-external-hint" role="status"><ShieldCheck size={16} /><span>{externalHint}</span></div>}<div className="career-form-row thirds"><Field label="发生时间"><input name="occurred_at" type="datetime-local" required defaultValue={dateInputValue(stableCreatedAt)} /></Field><Field label="方向"><select name="direction" required defaultValue=""><option value="" disabled>请选择</option><option value="outbound">我发出</option><option value="inbound">对方发来</option><option value="mutual">双方交流</option></select></Field><Field label="渠道"><select name="channel" defaultValue=""><option value="">未注明</option><option>LinkedIn</option><option>BOSS直聘</option><option>邮件</option><option>微信</option><option>电话</option><option>当面</option><option>其他</option></select></Field></div><Field label="沟通摘要" hint="必填，写事实而不是评价"><input name="summary" required placeholder="例如：确认了作品集评审时间" /></Field><Field label="关联职位" hint="可选；选择即明确建立关系"><select name="job_id" defaultValue=""><option value="">不关联职位</option>{jobsForPicker.map((job) => <option key={job.id} value={job.id}>{job.company} · {job.role}{job.archived === 1 ? "（已归档）" : ""}</option>)}</select></Field><Field label="补充备注" hint="可选"><textarea name="notes" rows={4} placeholder="关键信息、对方提到的事项…" /></Field><label className="career-contact-follow-toggle"><input type="checkbox" checked={scheduleNext} onChange={(event) => setScheduleNext(event.target.checked)} /><span><b>顺手安排下一步</b><small>只有你选择后才创建待办</small></span></label>{scheduleNext && <div className="career-contact-follow-fields"><Field label="下一步动作"><input name="follow_up_title" required placeholder="例如：发送更新后的案例页" /></Field><Field label="时间"><input name="follow_up_due_at" type="datetime-local" required /></Field></div>}{error && <div className="career-inline-error" role="status"><ShieldCheck size={15} />{error}</div>}<div className="career-form-actions"><button type="button" className="career-button ghost" onClick={requestClose}>取消</button><button className="career-button primary"><MessageSquareText size={16} />保存联系记录</button></div></form></>}</div></Modal>;
}

function ContactTaskModal({ contactId, data, externalHint, onClose, onRefresh, onSaved, notify }: { contactId: string; data: CareerData; externalHint: string; onClose: () => void; onRefresh: () => Promise<void>; onSaved: () => void; notify: (text: string, tone?: Notice["tone"]) => void }) {
  const [detail, setDetail] = useState<CareerContactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState("");
  const [readRevision, setReadRevision] = useState(0);
  const [phase, setPhase] = useState<CareerContactCommandPhase>("editing");
  const [dirty, setDirty] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<CareerContactWriteReceipt | null>(null);
  const [stableTaskId] = useState(() => newId("task"));
  const [stableCreatedAt] = useState(() => new Date().toISOString());
  const commandRef = useRef<CreateCareerContactTaskSafeInput | null>(null);
  const writeRef = useRef(false);
  const refreshOutcomeRef = useRef<"saved" | "changed">("saved");
  const phaseRootRef = useCareerContactPhaseFocus(phase, discardPrompt);
  const locked = phase === "writing" || phase === "checking" || phase === "refreshing" || phase === "refresh-only" || phase === "uncertain";
  useCareerContactWorkProtection(dirty || locked);
  useEffect(() => {
    let live = true;
    void loadCareerContactDetail(contactId).then((next) => {
      if (!live) return;
      if (next) setDetail(next);
      else setReadError("没有找到这位联系人。资料可能已在另一个页面发生变化。");
    }).catch(() => {
      if (live) setReadError("联系人资料暂时没有打开；这里不会把未知内容写成一条真实待办。");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [contactId, readRevision]);
  function retryRead() {
    setLoading(true);
    setReadError("");
    setReadRevision((current) => current + 1);
  }
  function requestClose() {
    if (locked) return;
    if (dirty && phase === "editing") { setDiscardPrompt(true); return; }
    onClose();
  }
  async function refreshOnly() {
    if (writeRef.current) return;
    writeRef.current = true;
    setPhase("refreshing");
    setError("");
    try {
      await onRefresh();
      setDirty(false);
      if (refreshOutcomeRef.current === "saved") onSaved();
      else {
        onClose();
        notify("联系人资料已变化；没有补建待办，已重新读取", "info");
      }
    } catch {
      setPhase("refresh-only");
      setError(refreshOutcomeRef.current === "saved"
        ? "下一步已保存在本机，但画面还没有重新读取。这里只会刷新，不会再次创建。"
        : "旧版本写入已经停止。这里只会重新读取，不会补建待办。");
    } finally { writeRef.current = false; }
  }
  async function inspectUncertain() {
    if (!receipt || writeRef.current) return;
    writeRef.current = true;
    setPhase("checking");
    setError("");
    try {
      const inspection = await inspectCareerContactWrite(receipt);
      const decision = careerContactInspectionDecision(inspection);
      if (decision === "refresh") {
        refreshOutcomeRef.current = "saved";
        writeRef.current = false;
        await refreshOnly();
        return;
      }
      if (decision === "retry-same-command") {
        setReceipt(null);
        setPhase("editing");
        setError("已确认这次没有保存。表单和原待办标识都保留；再次创建会复用同一个标识。");
      } else if (decision === "block") {
        setPhase("blocked");
        setError("这个待办标识已经对应另一份内容。没有覆盖；请关闭后核对待办列表。");
      } else {
        setPhase("uncertain");
        setError("本机仍无法确认是否已经保存。继续核对不会重复创建待办。");
      }
    } catch {
      setPhase("uncertain");
      setError("暂时无法核对保存结果。这里只保留原核对凭据，不会重新提交。");
    } finally { writeRef.current = false; }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || writeRef.current) return;
    writeRef.current = true;
    setPhase("writing");
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const command: CreateCareerContactTaskSafeInput = {
        taskId: stableTaskId,
        createdAt: stableCreatedAt,
        contactId,
        title: String(form.get("title") ?? ""),
        jobId: String(form.get("job_id") ?? "") || null,
        dueAt: fromDateInput(String(form.get("due_at") ?? "")),
        kind: String(form.get("kind") ?? "跟进"),
        priority: Number(form.get("priority") ?? 1),
        expectedContact: careerContactExpectedState(detail),
      };
      commandRef.current = command;
      const result = await createCareerContactTaskSafely(command);
      if (result.outcome === "outcome_uncertain") {
        setReceipt(result.receipt);
        setPhase("uncertain");
        setError("本机是否完成保存暂时无法确认。下一步只能核对同一份凭据，不能直接再创建。");
      } else {
        refreshOutcomeRef.current = "saved";
        writeRef.current = false;
        await refreshOnly();
        return;
      }
    } catch (caught) {
      if (caught instanceof CareerContactMutationError && caught.code === "changed") {
        refreshOutcomeRef.current = "changed";
        setPhase("refresh-only");
        setError("联系人刚在另一个页面发生了变化。没有补建下一步；接下来只重新读取。");
      } else if (caught instanceof CareerContactMutationError && caught.code === "conflict") {
        setPhase("blocked");
        setError(careerContactErrorText(caught, "操作标识发生冲突，没有覆盖已有待办。"));
      } else {
        setPhase("editing");
        setError(careerContactErrorText(caught, "这次没有保存，表单内容仍保留。"));
      }
    } finally { writeRef.current = false; }
  }
  if (loading) return <Modal title="安排下一步" description="先确认联系人资料，再安排你主动选择的提醒。" onClose={onClose}><div className="career-modal-loading"><LoaderCircle className="spin" size={20} />正在打开联系人…</div></Modal>;
  if (!detail || readError) return <Modal title="安排下一步" description="先确认联系人资料，再安排你主动选择的提醒。" onClose={onClose}><div className="career-drawer-read-error" role="status"><ShieldCheck size={22} /><h3>联系人资料暂时没有打开</h3><p>{readError || "这里没有把未知资料当成一份空记录。"}</p><div><button type="button" className="career-button primary" data-dialog-initial onClick={retryRead}><RotateCcw size={16} />重新读取</button><button type="button" className="career-button ghost" onClick={onClose}>关闭</button></div></div></Modal>;
  const jobsForPicker = Array.from(new Map([...detail.jobs, ...data.jobs].map((job) => [job.id, job])).values());
  const canDismiss = phase === "editing" || phase === "blocked";
  return <Modal title="安排下一步" description="这是你主动选择的提醒；计划时间可以留空。" onClose={requestClose} dismissible={canDismiss} inertToasts={!canDismiss} wide><div ref={phaseRootRef} className="career-contact-modal-phase" tabIndex={-1}>{discardPrompt ? <ContactDiscardPrompt noun="下一步" onKeep={() => setDiscardPrompt(false)} onDiscard={() => { setDirty(false); onClose(); }} /> : <>{phase === "writing" || phase === "checking" || phase === "refreshing" ? <ContactWriteStatus icon="busy" title={phase === "writing" ? "正在核对并保存" : phase === "checking" ? "正在只读核对保存结果" : "已经停止写入，正在重新读取"} message={phase === "checking" ? "只核对原凭据，不会再次创建待办。" : phase === "refreshing" ? "这一步只刷新画面，不会再次保存。" : "写入期间会保留表单，暂时不能关闭。"} /> : phase === "uncertain" ? <ContactWriteStatus icon="safe" title="先核对这条待办" message={error} action={<button className="career-button primary" data-contact-safe-focus onClick={() => void inspectUncertain()}><Search size={16} />只读核对</button>} /> : phase === "refresh-only" ? <ContactWriteStatus icon="safe" title="只重新读取联系人" message={error} action={<button className="career-button primary" data-contact-safe-focus onClick={() => void refreshOnly()}><RotateCcw size={16} />重新读取</button>} /> : phase === "blocked" ? <ContactWriteStatus icon="safe" title="没有覆盖已有待办" message={error} action={<button className="career-button primary" data-contact-safe-focus onClick={onClose}>返回联系人</button>} /> : null}{phase === "editing" && discardPrompt && <ContactDiscardPrompt noun="下一步" onKeep={() => setDiscardPrompt(false)} onDiscard={() => { setDirty(false); onClose(); }} />}<form hidden={phase !== "editing" || discardPrompt} className="career-form" onChange={() => setDirty(true)} onSubmit={submit}>{externalHint && <div className="career-contact-external-hint" role="status"><ShieldCheck size={16} /><span>{externalHint}</span></div>}<Field label="要做什么"><input name="title" required placeholder="例如：确认下一轮时间" /></Field><Field label="关联职位" hint="可选；不会按公司自动猜"><select name="job_id" defaultValue=""><option value="">不关联职位</option>{jobsForPicker.map((job) => <option key={job.id} value={job.id}>{job.company} · {job.role}{job.archived === 1 ? "（已归档）" : ""}</option>)}</select></Field><div className="career-form-row"><Field label="计划时间（可选）" hint="不设时间会放在“以后再说”"><input name="due_at" type="datetime-local" /></Field><Field label="类型"><select name="kind" defaultValue="跟进"><option>跟进</option><option>材料</option><option>面试准备</option><option>其他</option></select></Field></div><Field label="优先级"><select name="priority" defaultValue="1"><option value="1">普通</option><option value="2">重点</option><option value="3">时间敏感</option></select></Field>{error && <div className="career-inline-error" role="status"><ShieldCheck size={15} />{error}</div>}<div className="career-form-actions"><button type="button" className="career-button ghost" onClick={requestClose}>取消</button><button className="career-button primary"><CalendarDays size={16} />创建待办</button></div></form></>}</div></Modal>;
}

type CareerMaterialSavePhase =
  | "editing"
  | "saving"
  | "uncertain"
  | "checking"
  | "refreshing"
  | "refresh-only"
  | "conflict"
  | "cleanup-review"
  | "cleanup-checking"
  | "cleanup-ready"
  | "cleanup-running"
  | "cleanup-pending"
  | "cleanup-blocked"
  | "cleanup-unavailable";
type CareerMaterialDeletionPhase = "loading" | "ready" | "deleting" | "cleanup" | "uncertain" | "checking" | "refreshing" | "changed" | "refresh-only";

function materialDeletionPendingMessage(reason: CareerMaterialDeletionPendingReason) {
  if (reason === "reference_check_failed") return "本机暂时无法确认这个原件是否仍被其他版本使用，因此没有删除原件。";
  if (reason === "file_cleanup_failed") return "材料记录还在等待收尾，本地原件暂时没有清理完成。";
  return "本地原件已经处理，材料记录还在等待收尾。";
}

function materialDeletionSuccessMessage(action: CareerMaterialDeletedFileAction) {
  if (action === "retained_shared") return "材料记录已移除；同一原件仍被其他版本使用，因此完整保留。";
  if (action === "removed") return "材料记录与这份本地原件已移除。";
  if (action === "already_absent") return "材料记录已移除；本地原件此前已经不存在。";
  return "材料记录已移除。";
}

function materialSaveCleanupBlockedMessage(reason: CareerMaterialSaveCleanupBlockedReason) {
  if (reason === "material_present") return "这个附件现在对应一份材料记录，因此系统保留了原件。";
  if (reason === "file_referenced") return "这个附件仍被其他材料版本使用，因此系统保留了原件。";
  if (reason === "file_changed") return "本机原件与收尾记录已不完全一致，系统没有删除它。";
  return "职迹数据版本已经变化，系统停止了自动清理，也没有删除原件。";
}

function useMaterialPhaseFocus(phase: string, enabled = true) {
  const phaseRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const frame = window.requestAnimationFrame(() => {
      const root = phaseRootRef.current;
      const target = Array.from(root?.querySelectorAll<HTMLElement>("[data-dialog-initial]:not(:disabled)") ?? [])
        .find((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0) ?? root;
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [enabled, phase]);
  return phaseRootRef;
}

function MaterialModal({ data, initialRecovery, otherRecoveryPending, onRecoveryUpsert, onRecoveryClear, onClose, onStaleClose, onRefresh, notify }: { data: CareerData; initialRecovery: CareerMaterialSaveRecoveryEntry | null; otherRecoveryPending: boolean; onRecoveryUpsert: (ticket: CareerMaterialSaveRecoveryTicket) => boolean; onRecoveryClear: (ticket: CareerMaterialSaveRecoveryTicket, persisted: boolean) => boolean; onClose: () => void; onStaleClose: () => void; onRefresh: () => Promise<void>; notify: (text: string, tone?: Notice["tone"]) => void }) {
  const initialSnapshot = initialRecovery?.ticket.kind === "uncertain-save" ? initialRecovery.ticket.expectedSnapshot : null;
  const [materialId] = useState(() => initialRecovery?.ticket.kind === "uncertain-save" ? initialRecovery.ticket.materialId : newId("material"));
  const [phase, setPhase] = useState<CareerMaterialSavePhase>(() => initialRecovery?.ticket.kind === "uncertain-save" ? "uncertain" : initialRecovery ? "cleanup-review" : "editing");
  const [error, setError] = useState(() => initialRecovery?.ticket.kind === "uncertain-save"
    ? "上次保存结果需要继续核对。核对只读取本机记录，不会再次保存。"
    : initialRecovery ? "有一份未关联的暂存附件等待核对；只有确认安全后才会清理。" : "");
  const [dirty, setDirty] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [refreshContext, setRefreshContext] = useState<"saved" | "conflict" | "recovery">("saved");
  const [allowStaleExit, setAllowStaleExit] = useState(false);
  const [activeRecovery, setActiveRecovery] = useState<CareerMaterialSaveRecoveryTicket | null>(initialRecovery?.ticket ?? null);
  const [recoveryPersisted, setRecoveryPersisted] = useState(initialRecovery?.persisted ?? false);
  const [cleanupReceipt, setCleanupReceipt] = useState<CareerMaterialSaveCleanupReceipt | null>(() => initialRecovery?.ticket.cleanupReceipt ?? null);
  const [cleanupBlockedReason, setCleanupBlockedReason] = useState<CareerMaterialSaveCleanupBlockedReason | null>(null);
  const [cleanupContinuation, setCleanupContinuation] = useState<"editing" | "refresh">(initialRecovery ? "refresh" : "editing");
  const expectedRef = useRef<CareerMaterialSaveExpectedSnapshot | null>(initialRecovery?.ticket.kind === "uncertain-save" ? initialRecovery.ticket.expectedSnapshot : null);
  const activeRecoveryRef = useRef<CareerMaterialSaveRecoveryTicket | null>(initialRecovery?.ticket ?? null);
  const recoveryPersistedRef = useRef(initialRecovery?.persisted ?? false);
  const boundRecoveryKeyRef = useRef(initialRecovery ? materialSaveRecoveryKey(initialRecovery.ticket) : null);
  const savingRef = useRef(false);
  const refreshingRef = useRef(false);
  const savedOutcomeRef = useRef<"saved" | "already_saved">("saved");
  const preparedTicketRef = useRef<CareerMaterialSaveRecoveryTicket | null>(null);
  const finalClosePendingRef = useRef(false);
  const resumeEditingFocusPendingRef = useRef(false);
  const closeConfirmReturnRef = useRef<HTMLElement | null>(null);
  const updatedAtRef = useRef<string | null>(initialSnapshot?.updatedAt ?? null);
  const phaseRootRef = useMaterialPhaseFocus(phase);
  const incomingRecoveryKey = initialRecovery ? materialSaveRecoveryKey(initialRecovery.ticket) : null;
  const unboundRecoveryPending = otherRecoveryPending || incomingRecoveryKey !== boundRecoveryKeyRef.current;
  const materialKinds = ["简历", "求职信", "作品集", "案例", "其他"] as const;
  const initialLinkedJobUnavailable = Boolean(initialSnapshot?.linkedJobId && !data.jobs.some((job) => job.id === initialSnapshot.linkedJobId));

  useEffect(() => {
    if (closeConfirm || !finalClosePendingRef.current) return;
    finalClosePendingRef.current = false;
    const frame = window.requestAnimationFrame(onClose);
    return () => window.cancelAnimationFrame(frame);
  }, [closeConfirm, onClose]);

  useEffect(() => {
    if (closeConfirm || !resumeEditingFocusPendingRef.current) return;
    resumeEditingFocusPendingRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const previous = closeConfirmReturnRef.current;
      const fallback = phaseRootRef.current?.querySelector<HTMLInputElement>('input[name="name"]');
      const target = previous?.isConnected && previous.getClientRects().length > 0 ? previous : fallback;
      target?.focus({ preventScroll: true });
      closeConfirmReturnRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [closeConfirm, phaseRootRef]);

  useEffect(() => {
    const writeInFlight = phase === "saving" || phase === "checking" || phase === "refreshing" || phase === "cleanup-checking" || phase === "cleanup-running";
    if (!dirty && !writeInFlight && !(activeRecovery && !recoveryPersisted)) return;
    function protectMaterialWork(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", protectMaterialWork);
    return () => window.removeEventListener("beforeunload", protectMaterialWork);
  }, [activeRecovery, dirty, phase, recoveryPersisted]);

  function rememberRecovery(ticket: CareerMaterialSaveRecoveryTicket) {
    const persisted = onRecoveryUpsert(ticket);
    boundRecoveryKeyRef.current = materialSaveRecoveryKey(ticket);
    setActiveRecovery(ticket);
    activeRecoveryRef.current = ticket;
    setRecoveryPersisted(persisted);
    recoveryPersistedRef.current = persisted;
    return persisted;
  }

  function forgetRecovery(ticket: CareerMaterialSaveRecoveryTicket | null = activeRecoveryRef.current) {
    if (!ticket) return true;
    const cleared = onRecoveryClear(ticket, recoveryPersistedRef.current);
    if (cleared) {
      if (!activeRecoveryRef.current || materialSaveRecoveryKey(activeRecoveryRef.current) === materialSaveRecoveryKey(ticket)) {
        setActiveRecovery(null);
        activeRecoveryRef.current = null;
        boundRecoveryKeyRef.current = null;
        setRecoveryPersisted(false);
        recoveryPersistedRef.current = false;
      }
    }
    return cleared;
  }

  function requestClose() {
    if (phase !== "editing") {
      if (activeRecovery && recoveryPersisted && (phase === "uncertain" || phase === "cleanup-review" || phase === "cleanup-pending" || phase === "cleanup-ready" || phase === "cleanup-blocked")) onClose();
      return;
    }
    if (dirty) {
      closeConfirmReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setCloseConfirm(true);
      return;
    }
    onClose();
  }

  function resumeMaterialEditing() {
    resumeEditingFocusPendingRef.current = true;
    setCloseConfirm(false);
  }

  function recoveryWithCleanupReceipt(receipt: CareerMaterialSaveCleanupReceipt) : CareerMaterialSaveRecoveryTicket {
    if (activeRecoveryRef.current?.kind === "uncertain-save") return { ...activeRecoveryRef.current, cleanupReceipt: receipt };
    return {
      version: 1,
      kind: "cleanup-only",
      cleanupReceipt: receipt,
      recordedAt: activeRecoveryRef.current?.recordedAt ?? new Date().toISOString(),
    };
  }

  function enterCleanupBlocked(receipt: CareerMaterialSaveCleanupReceipt, reason: CareerMaterialSaveCleanupBlockedReason | null, message?: string) {
    const ticket = recoveryWithCleanupReceipt(receipt);
    rememberRecovery(ticket);
    setCleanupReceipt(receipt);
    setCleanupBlockedReason(reason);
    setPhase("cleanup-blocked");
    setError(message ?? (reason ? materialSaveCleanupBlockedMessage(reason) : "这条收尾线索无法继续验证；系统没有删除任何原件。"));
  }

  function finishUnavailableRecovery() {
    const ticket = activeRecoveryRef.current;
    if (ticket && !forgetRecovery(ticket)) {
      setError("系统仍会保留原件，但浏览器暂时无法清除这条提醒。请稍后再试；这里不会删除或重新保存。");
      return;
    }
    expectedRef.current = null;
    setCleanupReceipt(null);
    setDirty(false);
    onClose();
  }

  async function inspectAttachmentCleanup(receiptInput: CareerMaterialSaveCleanupReceipt = cleanupReceipt!) {
    if (savingRef.current || !receiptInput) return;
    savingRef.current = true;
    setPhase("cleanup-checking");
    setError("");
    try {
      const inspected = await inspectCareerMaterialSaveCleanup(receiptInput);
      const ticket = recoveryWithCleanupReceipt(inspected.receipt);
      rememberRecovery(ticket);
      setCleanupReceipt(inspected.receipt);
      if (inspected.state === "cleanup_ready") {
        setPhase("cleanup-ready");
        setError("已确认这是一份未被材料记录引用的暂存附件；只有你继续，才会清理它。");
      } else if (inspected.state === "blocked") {
        enterCleanupBlocked(inspected.receipt, inspected.reason);
      } else {
        setPhase("cleanup-pending");
        setError("本机暂时还无法确认附件状态。稍后继续只读核对，不会重复上传或盲目删除。");
      }
    } catch (caught) {
      if (caught instanceof CareerMaterialSaveError && caught.code === "invalid_cleanup_receipt") {
        setPhase("cleanup-unavailable");
        setError("这条附件收尾线索已经损坏，无法继续验证。系统没有删除任何原件；你可以明确保留原件并结束这条提醒。");
      } else {
        setPhase("cleanup-pending");
        setError(caught instanceof Error ? caught.message : "本机暂时无法核对附件收尾状态；没有删除任何原件。");
      }
    } finally {
      savingRef.current = false;
    }
  }

  async function retryAttachmentCleanup() {
    if (savingRef.current || !cleanupReceipt) return;
    savingRef.current = true;
    setPhase("cleanup-running");
    setError("");
    try {
      const result = await retryCareerMaterialSaveCleanup(cleanupReceipt);
      if (result.outcome === "cleaned" || result.outcome === "already_cleaned") {
        if (!forgetRecovery()) {
          setPhase("cleanup-pending");
          setError("附件已经收尾，但浏览器暂时没有清除恢复提醒。请留在这里再试一次；不会重复清理。");
          return;
        }
        expectedRef.current = null;
        setCleanupReceipt(null);
        setCleanupBlockedReason(null);
        if (cleanupContinuation === "editing") {
          setDirty(true);
          setPhase("editing");
          setError(unboundRecoveryPending
            ? "上次未关联的暂存附件已经收尾，文字内容仍保留在表单中。另一份材料还在等待核对；你可以先查看或复制当前内容，再明确关闭。"
            : "上次未关联的暂存附件已经收尾。文字内容仍保留；需要时可重新选择文件并保存。");
          notify("未关联的暂存附件已收尾。", "info");
        } else {
          setDirty(false);
          await refreshAfterRecovery();
        }
      } else if (result.outcome === "blocked") {
        enterCleanupBlocked(result.receipt, result.reason);
      } else if ("receipt" in result) {
        const ticket = recoveryWithCleanupReceipt(result.receipt);
        rememberRecovery(ticket);
        setCleanupReceipt(result.receipt);
        setPhase("cleanup-pending");
        setError("附件收尾暂时没有完成。恢复线索仍保留；稍后继续不会重复保存材料。");
      }
    } catch (caught) {
      setPhase("cleanup-pending");
      setError(caught instanceof Error ? caught.message : "附件收尾暂时没有完成；恢复线索仍保留。");
    } finally {
      savingRef.current = false;
    }
  }

  async function keepAttachmentAndFinishRecovery() {
    if (!activeRecoveryRef.current || refreshingRef.current) return;
    if (!forgetRecovery()) {
      setError("原件仍会保留，但浏览器暂时无法清除这条提醒。请稍后再试。");
      return;
    }
    refreshingRef.current = true;
    setRefreshContext("recovery");
    setAllowStaleExit(false);
    setPhase("refreshing");
    try {
      await onRefresh();
      notify("已保留本机原件，并结束这条收尾提醒。", "info");
      onClose();
    } catch {
      setPhase("refresh-only");
      setAllowStaleExit(true);
      setError("原件已经保留、收尾提醒已经结束；材料列表暂时没有重新读取。这里只需要刷新画面。");
    } finally {
      refreshingRef.current = false;
    }
  }

  async function refreshAfterRecovery() {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshContext("recovery");
    setAllowStaleExit(false);
    setPhase("refreshing");
    setError("");
    try {
      await onRefresh();
      notify("附件收尾已完成，材料列表已重新读取。", "info");
      onClose();
    } catch {
      setPhase("refresh-only");
      setAllowStaleExit(true);
      setError("附件收尾已经完成，但材料列表暂时没有重新读取。这里只需要刷新画面。");
    } finally {
      refreshingRef.current = false;
    }
  }

  async function refreshAfterSave() {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setAllowStaleExit(false);
    setRefreshContext("saved");
    setPhase("refreshing");
    setError("");
    try {
      await onRefresh();
      notify(savedOutcomeRef.current === "already_saved" ? "这份材料已经保存在本机，没有重复创建。" : "材料已保存在本机。");
      onClose();
    } catch {
      setPhase("refresh-only");
      setAllowStaleExit(true);
      setError("材料已经写入本机 SQLite，但画面暂时没有重新读取。请只重新读取，不要再次保存。");
    } finally {
      refreshingRef.current = false;
    }
  }

  async function inspectUncertainSave() {
    if (savingRef.current || !expectedRef.current) return;
    savingRef.current = true;
    setPhase("checking");
    setError("");
    try {
      const inspection = await inspectCareerMaterialSave(materialId, expectedRef.current);
      if (inspection === "exact_saved") {
        if (!forgetRecovery()) {
          setPhase("uncertain");
          setError("已经确认材料保存在本机，但浏览器暂时没有清除核对提醒。不会重复保存；请稍后再核对一次。");
          return;
        }
        savedOutcomeRef.current = "saved";
        await refreshAfterSave();
      } else if (inspection === "absent") {
        if (cleanupReceipt) {
          setCleanupContinuation("editing");
          setPhase("cleanup-review");
          setError("已确认材料记录没有写入。先核对并收尾这次暂存附件，完成后才会重新开放保存。");
        } else if (forgetRecovery()) {
          expectedRef.current = null;
          setDirty(true);
          setPhase("editing");
          setError(initialSnapshot?.attachment
            ? `已确认材料记录没有写入。文字内容已恢复；浏览器不能重新填入“${initialSnapshot.attachment.originalName}”，请重新选择文件后再保存。`
            : "已确认材料记录没有写入。文字内容已恢复，可以在准备好时重试。");
        } else {
          setPhase("uncertain");
          setError("已确认材料记录没有写入，但浏览器暂时没有清除核对提醒。这里不会重新保存。");
        }
      } else if (inspection === "conflict") {
        if (cleanupReceipt) {
          setCleanupContinuation("refresh");
          setPhase("cleanup-review");
          setError("同一材料标识现在对应不同内容，没有覆盖它。先核对这次暂存附件，再重新读取列表。");
        } else if (forgetRecovery()) {
          setPhase("conflict");
          setError("同一材料标识现在对应不同内容。没有覆盖任何记录，请只重新读取材料列表后再决定。");
        } else {
          setPhase("uncertain");
          setError("没有覆盖另一份内容，但浏览器暂时没有清除核对提醒。这里不会重新保存。");
        }
      } else {
        setPhase("uncertain");
        setError("本机仍无法确认是否已经保存。继续核对不会重复写入，也不会重新上传附件。");
      }
    } catch (caught) {
      if (caught instanceof CareerMaterialSaveError &&
        (caught.code === "invalid_input" || caught.code === "invalid_cleanup_receipt")) {
        setPhase("cleanup-unavailable");
        setError("这条保存核对线索已经损坏，无法继续验证。系统不会重新保存或删除原件；你可以明确保留原件并结束这条提醒。");
      } else {
        setPhase("uncertain");
        setError("本机暂时无法核对保存结果。这里不会重新提交；稍后可以继续只读核对。");
      }
    } finally {
      savingRef.current = false;
    }
  }

  async function refreshAfterConflict() {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setAllowStaleExit(false);
    setRefreshContext("conflict");
    setPhase("refreshing");
    try {
      await onRefresh();
      notify("材料列表已重新读取；没有覆盖另一份内容。", "info");
      onClose();
    } catch {
      setPhase("conflict");
      setAllowStaleExit(true);
      setError("没有覆盖另一份内容，但材料列表暂时没有重新读取。请稍后只重试读取；这里不会覆盖或重新保存。");
    } finally {
      refreshingRef.current = false;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current) return;
    if (unboundRecoveryPending) {
      setError("还有一份材料保存等待核对。先完成已有收尾，再添加新的附件。");
      return;
    }
    savingRef.current = true;
    setPhase("saving");
    setError("");
    const form = new FormData(event.currentTarget);
    const selected = form.get("attachment");
    const file = selected instanceof File && selected.size > 0 ? selected : null;
    updatedAtRef.current ??= new Date().toISOString();
    const input: CareerMaterialSaveInput = {
      materialId,
      name: String(form.get("name") ?? ""),
      kind: String(form.get("kind") ?? ""),
      version: String(form.get("version") ?? ""),
      updatedAt: updatedAtRef.current,
      linkedJobId: String(form.get("linked_job_id") ?? "") || null,
      status: String(form.get("status") ?? "ready") as CareerMaterialSaveInput["status"],
      notes: String(form.get("notes") ?? ""),
      attachment: file ? { blob: file, originalName: file.name, mimeType: file.type } : null,
    };
    preparedTicketRef.current = null;
    try {
      const result = await saveCareerMaterial(input, {
        onRecoveryPrepared(prepared) {
          const ticket: CareerMaterialSaveRecoveryTicket = {
            version: 1,
            kind: "uncertain-save",
            materialId: prepared.materialId,
            expectedSnapshot: prepared.expectedSnapshot,
            cleanupReceipt: prepared.cleanupReceipt,
            recordedAt: new Date().toISOString(),
          };
          preparedTicketRef.current = ticket;
          expectedRef.current = prepared.expectedSnapshot;
          setCleanupReceipt(prepared.cleanupReceipt);
          if (!rememberRecovery(ticket)) throw new Error("recovery storage unavailable");
        },
      });
      const preparedTicket = preparedTicketRef.current as CareerMaterialSaveRecoveryTicket | null;
      if (result.outcome === "outcome_uncertain") {
        expectedRef.current = result.expectedSnapshot;
        setCleanupReceipt(result.cleanupReceipt);
        const ticket = preparedTicket ?? {
          version: 1 as const,
          kind: "uncertain-save" as const,
          materialId: result.materialId,
          expectedSnapshot: result.expectedSnapshot,
          cleanupReceipt: result.cleanupReceipt,
          recordedAt: new Date().toISOString(),
        };
        const persisted = preparedTicket ? recoveryPersistedRef.current : rememberRecovery(ticket);
        setPhase("uncertain");
        setError(persisted
          ? "附件与记录可能已经保存在本机，但最终回执没有返回。请先只读核对，不要再次保存。"
          : "保存结果需要核对，恢复线索目前只留在本次打开的页面。请不要刷新，先继续只读核对。");
      } else {
        if (preparedTicket && !forgetRecovery(preparedTicket)) {
          setPhase("uncertain");
          setError("材料已经保存在本机，但浏览器暂时没有清除核对提醒。不会重复保存；请只读核对。");
          return;
        }
        savedOutcomeRef.current = result.outcome;
        await refreshAfterSave();
      }
    } catch (caught) {
      const preparedTicket = preparedTicketRef.current as CareerMaterialSaveRecoveryTicket | null;
      if (caught instanceof CareerMaterialSaveError && caught.code === "temporary_file_cleanup_failed") {
        if (caught.cleanupReceipt) {
          const ticket: CareerMaterialSaveRecoveryTicket = preparedTicket
            ? { ...preparedTicket, cleanupReceipt: caught.cleanupReceipt }
            : {
                version: 1,
                kind: "cleanup-only",
                cleanupReceipt: caught.cleanupReceipt,
                recordedAt: new Date().toISOString(),
              };
          const persisted = rememberRecovery(ticket);
          setCleanupReceipt(caught.cleanupReceipt);
          if (ticket.kind === "uncertain-save") {
            expectedRef.current = ticket.expectedSnapshot;
            setPhase("uncertain");
            setError(persisted
              ? "这次写入没有拿到完整回执。先只读核对材料记录，再决定是否需要收尾附件；不会重新保存。"
              : "写入结果需要核对，线索目前只留在本次打开的页面。请不要刷新，先继续只读核对。");
          } else {
            setCleanupContinuation("refresh");
            setPhase("cleanup-review");
            setError(persisted
              ? "材料记录没有写入；有一份未关联的暂存附件等待核对。不会重新保存，只有确认安全后才会清理。"
              : "材料记录没有写入；收尾线索目前只留在本次打开的页面。请不要刷新，先继续核对附件。");
          }
        } else {
          if (preparedTicket) forgetRecovery(preparedTicket);
          setPhase("cleanup-unavailable");
          setError("材料记录没有写入，但浏览器没有返回可验证的附件收尾线索。系统不会猜测或删除原件；请保留原件并结束这次操作。");
        }
      } else if (caught instanceof CareerMaterialSaveError && caught.code === "recovery_prepare_failed") {
        if (preparedTicket && forgetRecovery(preparedTicket)) {
          setPhase("editing");
          setError("浏览器没能保留恢复线索，因此没有写入材料；已安全收尾的暂存附件不会显示成材料记录。稍后可以再试。");
        } else {
          setPhase("uncertain");
          setError("材料没有继续写入，但恢复提醒暂时无法清除。这里不会重复保存；请继续只读核对。");
        }
      } else if (caught instanceof CareerMaterialSaveError && caught.code === "conflict") {
        if (preparedTicket && !forgetRecovery(preparedTicket)) {
          setPhase("uncertain");
          setError("没有覆盖另一份内容，但浏览器暂时没有清除核对提醒。请只读核对，不要再次保存。");
        } else {
          setPhase("conflict");
          setAllowStaleExit(true);
          setError(caught.message);
        }
      } else {
        if (preparedTicket && !forgetRecovery(preparedTicket)) {
          setPhase("uncertain");
          setError("这次写入没有继续，但浏览器暂时没有清除核对提醒。请只读核对，不要再次保存。");
          return;
        }
        setPhase("editing");
        setError(caught instanceof Error ? caught.message : "这次没有确认写入；表单内容仍保留。请稍后重试。");
      }
    } finally {
      savingRef.current = false;
    }
  }

  const canPauseRecovery = Boolean(activeRecovery && recoveryPersisted && (phase === "uncertain" || phase === "cleanup-review" || phase === "cleanup-pending" || phase === "cleanup-ready" || phase === "cleanup-blocked"));
  const dismissible = phase === "editing" || canPauseRecovery;
  const cleanupPhase = phase.startsWith("cleanup-");
  const recoveryRefreshPhase = (phase === "refreshing" || phase === "refresh-only") && refreshContext !== "saved";
  const modalTitle = cleanupPhase || (recoveryRefreshPhase && refreshContext === "recovery")
    ? "附件收尾"
    : phase === "uncertain" || phase === "checking"
      ? "核对材料保存"
      : recoveryRefreshPhase || phase === "conflict"
        ? "核对材料列表"
        : phase === "refreshing" || phase === "refresh-only"
          ? "材料已保存在本机"
          : "添加求职材料";
  return <><Modal title={modalTitle} description={cleanupPhase || refreshContext === "recovery" ? "只处理上次未完成的本机附件，不会新增或覆盖材料。" : "记录版本与用途；可选文件会保存到当前完整网址与浏览器资料对应的私有存储。"} onClose={requestClose} dismissible={dismissible} inertToasts={phase !== "editing"}>
    <div ref={phaseRootRef} className="career-material-modal-body" data-material-phase-focus tabIndex={-1}>
    <form className="career-form" hidden={phase !== "editing"} aria-hidden={phase !== "editing"} onChange={() => setDirty(true)} onSubmit={submit}><Field label="材料名称"><input name="name" data-dialog-initial defaultValue={initialSnapshot?.name ?? ""} required placeholder="产品设计主简历" /></Field><div className="career-form-row"><Field label="类型"><select name="kind" defaultValue={initialSnapshot?.kind ?? "简历"}>{initialSnapshot && !materialKinds.includes(initialSnapshot.kind as typeof materialKinds[number]) && <option value={initialSnapshot.kind}>{initialSnapshot.kind}（已恢复）</option>}{materialKinds.map((kind) => <option key={kind}>{kind}</option>)}</select></Field><Field label="版本"><input name="version" defaultValue={initialSnapshot?.version ?? "v1.0"} required /></Field></div><Field label="本地文件" hint="可选；SQLite 只保存文件索引，原件留在浏览器私有存储"><input name="attachment" type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.txt,.md,application/pdf" />{initialSnapshot?.attachment && <small className="career-field-recovery-note">上次选择过“{initialSnapshot.attachment.originalName}”。浏览器不会自动重新选取文件；若核对确认未保存，请重新选择。</small>}</Field><Field label="关联职位"><select name="linked_job_id" defaultValue={initialSnapshot?.linkedJobId ?? ""}><option value="">主材料 / 不关联</option>{initialLinkedJobUnavailable && <option value={initialSnapshot!.linkedJobId!}>原关联职位（当前列表不可用）</option>}{data.jobs.map((job) => <option key={job.id} value={job.id}>{job.company} · {job.role}</option>)}</select></Field><Field label="状态"><select name="status" defaultValue={initialSnapshot?.status ?? "ready"}><option value="ready">可使用</option><option value="draft">编辑中</option><option value="sent">已发送</option></select></Field><Field label="备注"><textarea name="notes" rows={4} defaultValue={initialSnapshot?.notes ?? ""} placeholder="这版材料做了哪些调整？" /></Field>{unboundRecoveryPending && <div className="career-inline-error" role="status"><ShieldCheck size={15} />另一份材料保存正在等待核对。当前输入会保留；请先关闭并处理已有收尾。</div>}{error && <div className="career-inline-error" role="alert"><X size={15} />{error}</div>}<div className="career-form-actions"><button type="button" className="career-button ghost" onClick={requestClose}>取消</button><button className="career-button primary" disabled={unboundRecoveryPending}><Upload size={16} />保存材料</button></div></form>
    {phase === "saving" && <div className="career-material-recovery" role="status"><LoaderCircle className="spin" size={23} /><h3>正在保存到本机</h3><p>先写入附件，再写入材料记录；完成前不会让重复提交。</p></div>}
    {phase === "uncertain" && <div className="career-material-recovery uncertain" role="status" aria-live="polite"><ShieldCheck size={24} /><h3>需要核对保存结果</h3><p>{error}</p><div className="career-material-recovery-actions">{recoveryPersisted && <button className="career-button secondary" onClick={onClose}>稍后继续</button>}<button className="career-button primary" data-dialog-initial onClick={() => void inspectUncertainSave()}><Search size={16} />只读核对</button></div><small>{recoveryPersisted ? "核对线索已留在当前网址的浏览器存储；核对只读取 SQLite 与附件校验值。" : "核对线索只在本次打开期间可用；请先不要刷新或关闭页面。"}</small></div>}
    {phase === "checking" && <div className="career-material-recovery" role="status"><LoaderCircle className="spin" size={23} /><h3>正在只读核对</h3><p>不会再次保存，也不会换一个材料标识。</p></div>}
    {phase === "cleanup-review" && <div className="career-material-recovery cleanup" role="status" aria-live="polite"><ShieldCheck size={24} /><h3>先核对这份暂存附件</h3><p>{error}</p><div className="career-material-recovery-actions">{recoveryPersisted && <button className="career-button secondary" onClick={onClose}>稍后继续</button>}<button className="career-button primary" data-dialog-initial onClick={() => void inspectAttachmentCleanup()}><Search size={16} />只读核对附件</button></div><small>这里只确认附件是否未被材料使用；还不会删除它。</small></div>}
    {phase === "cleanup-checking" && <div className="career-material-recovery" role="status"><LoaderCircle className="spin" size={23} /><h3>正在核对附件状态</h3><p>会再次确认数据版本、材料引用与原件校验值；不会写入材料。</p></div>}
    {phase === "cleanup-ready" && <div className="career-material-recovery cleanup" role="status" aria-live="polite"><ShieldCheck size={24} /><h3>可以安全收尾</h3><p>{error}</p><div className="career-material-recovery-actions">{recoveryPersisted && <button className="career-button secondary" onClick={onClose}>稍后继续</button>}<button className="career-button primary" data-dialog-initial onClick={() => void retryAttachmentCleanup()}><Trash2 size={16} />清理未关联附件</button></div><small>执行前还会重新检查一次；条件变化就会停止，不会盲目删除。</small></div>}
    {phase === "cleanup-running" && <div className="career-material-recovery" role="status"><LoaderCircle className="spin" size={23} /><h3>正在完成附件收尾</h3><p>只处理恢复凭据绑定的那一份未关联附件。</p></div>}
    {phase === "cleanup-pending" && <div className="career-material-recovery cleanup" role="status" aria-live="polite"><ShieldCheck size={24} /><h3>附件暂时还不能收尾</h3><p>{error}</p><div className="career-material-recovery-actions">{recoveryPersisted && <button className="career-button secondary" onClick={onClose}>稍后继续</button>}<button className="career-button primary" data-dialog-initial onClick={() => void inspectAttachmentCleanup()}><RotateCcw size={16} />再次只读核对</button></div><small>{recoveryPersisted ? "恢复线索会保留；页面关闭后也不会把它当作已完成。" : "恢复线索只在本次打开期间可用，请先不要刷新。"}</small></div>}
    {phase === "cleanup-blocked" && <div className="career-material-recovery conflict" role="status" aria-live="polite"><ShieldCheck size={24} /><h3>这份原件会保留</h3><p>{error}</p><div className="career-material-recovery-actions">{recoveryPersisted && <button className="career-button secondary" onClick={onClose}>先保留提醒</button>}<button className="career-button primary" data-dialog-initial onClick={() => void keepAttachmentAndFinishRecovery()}><ShieldCheck size={16} />保留原件并结束提醒</button></div><small>{cleanupBlockedReason === "material_present" || cleanupBlockedReason === "file_referenced" ? "原件与现有材料有关联，保留它是安全默认。" : "无法证明安全时，系统不会删除原件。"}</small></div>}
    {phase === "cleanup-unavailable" && <div className="career-material-recovery conflict" role="status" aria-live="polite"><ShieldCheck size={24} /><h3>这份原件会保留</h3><p>{error}</p><div className="career-material-recovery-actions"><button className="career-button primary" data-dialog-initial onClick={finishUnavailableRecovery}><ShieldCheck size={16} />保留原件并结束提醒</button></div><small>这不会声称原件已清理；也不会自动删除任何本机文件。</small></div>}
    {phase === "refreshing" && <div className="career-material-recovery" role="status"><LoaderCircle className="spin" size={23} /><h3>正在重新读取材料列表</h3><p>{refreshContext === "saved" ? "材料已经写入；这里只更新画面，不会再次保存。" : refreshContext === "conflict" ? "只读取最新内容，不会覆盖或重新保存。" : "附件处理结果已经确定；这里只更新画面。"}</p></div>}
    {phase === "refresh-only" && <div className="career-material-recovery" role="status"><ShieldCheck size={24} /><h3>{refreshContext === "saved" ? "材料已经保存在本机" : "材料状态需要重新读取"}</h3><p>{error || "现在只需重新读取画面；这一步不会创建新材料或再次写入附件。"}</p><div className="career-material-recovery-actions">{allowStaleExit && <button className="career-button secondary" onClick={onStaleClose}>先回材料页</button>}<button className="career-button primary" data-dialog-initial onClick={() => void (refreshContext === "saved" ? refreshAfterSave() : refreshContext === "conflict" ? refreshAfterConflict() : refreshAfterRecovery())}><RotateCcw size={16} />只重新读取</button></div></div>}
    {phase === "conflict" && <div className="career-material-recovery conflict" role="alert"><ShieldCheck size={24} /><h3>没有覆盖另一份内容</h3><p>{error}</p><div className="career-material-recovery-actions">{allowStaleExit && <button className="career-button secondary" onClick={onStaleClose}>先回材料页</button>}<button className="career-button primary" data-dialog-initial onClick={() => void refreshAfterConflict()}><RotateCcw size={16} />重新读取材料列表</button></div></div>}
    </div>
  </Modal>{closeConfirm && <Modal title="放弃这份材料草稿吗？" description="表单和所选文件还没有写入职迹。" onClose={resumeMaterialEditing} inertToasts><div className="career-material-close-choice"><p>继续编辑会保留当前输入；明确放弃只关闭表单，不会影响已经存在的材料。</p><div><button className="career-button primary" data-dialog-initial onClick={resumeMaterialEditing}>继续编辑</button><button className="career-button danger" onClick={() => { resumeEditingFocusPendingRef.current = false; finalClosePendingRef.current = true; setCloseConfirm(false); }}>放弃这次输入</button></div></div></Modal>}</>;
}

function MaterialDeletionModal({ material, onClose, onStaleClose, onRefresh, notify }: { material: Pick<Material, "id" | "name" | "file_key">; onClose: () => void; onStaleClose: () => void; onRefresh: () => Promise<void>; notify: (text: string, tone?: Notice["tone"]) => void }) {
  const [phase, setPhase] = useState<CareerMaterialDeletionPhase>("loading");
  const [state, setState] = useState<CareerMaterialDeletionState | null>(null);
  const [message, setMessage] = useState("");
  const [allowStaleExit, setAllowStaleExit] = useState(false);
  const mutationRef = useRef(false);
  const successMessageRef = useRef("材料记录已经不在当前列表中。");
  const phaseRootRef = useMaterialPhaseFocus(phase);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const inspected = await loadCareerMaterialDeletionState(material.id);
        if (!live) return;
        setState(inspected);
        setPhase(inspected.state === "already_absent" ? "refresh-only" : inspected.state === "cleanup_pending" ? "cleanup" : "ready");
        if (inspected.state === "already_absent") setMessage("这份材料记录已经不存在；现在只需重新读取列表。");
        if (inspected.state === "cleanup_pending") setMessage("这份材料还在等待收尾。继续处理会重新核对引用，不会盲目删除原件。");
      } catch (caught) {
        if (!live) return;
        setPhase("changed");
        setMessage(caught instanceof Error ? caught.message : "暂时无法核对这份材料；没有开始删除。请重新读取后再试。");
      }
    })();
    return () => { live = false; };
  }, [material.id]);

  useEffect(() => {
    if (phase === "loading" || phase === "ready") return;
    function protectDeletionCheck(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", protectDeletionCheck);
    return () => window.removeEventListener("beforeunload", protectDeletionCheck);
  }, [phase]);

  async function closeAfterRead() {
    if (mutationRef.current) return;
    mutationRef.current = true;
    setAllowStaleExit(false);
    const returnPhase = phase;
    setPhase("refreshing");
    try {
      await onRefresh();
      onClose();
    } catch {
      setPhase(returnPhase);
      setAllowStaleExit(true);
      setMessage("材料状态暂时没有重新读取。请留在这里稍后再试；不会重复删除或清理。");
    } finally {
      mutationRef.current = false;
    }
  }

  async function refreshAfterDeletion() {
    if (mutationRef.current) return;
    mutationRef.current = true;
    setAllowStaleExit(false);
    setPhase("refreshing");
    try {
      await onRefresh();
      notify(successMessageRef.current, "info");
      onClose();
    } catch {
      setPhase("refresh-only");
      setAllowStaleExit(true);
      setMessage("删除结果已经写入本机，但画面暂时没有重新读取。请只重新读取，不要再次删除。");
    } finally {
      mutationRef.current = false;
    }
  }

  async function performDeletion() {
    if (mutationRef.current) return;
    const receipt: CareerMaterialDeletionReceipt | null = state?.state === "present" || state?.state === "cleanup_pending" ? state.receipt : null;
    if (!receipt) {
      setPhase("changed");
      setMessage("这份材料的确认信息已经变化。没有开始移除，请重新读取后再决定。");
      return;
    }
    mutationRef.current = true;
    setPhase("deleting");
    setMessage("");
    try {
      const result = await deleteCareerMaterial(receipt);
      if (result.outcome === "deleted") {
        successMessageRef.current = materialDeletionSuccessMessage(result.fileAction);
        mutationRef.current = false;
        await refreshAfterDeletion();
        return;
      }
      if (result.outcome === "already_absent") {
        successMessageRef.current = "这份材料记录已经不存在，没有重复删除。";
        mutationRef.current = false;
        await refreshAfterDeletion();
        return;
      }
      if (result.outcome === "changed") {
        setPhase("changed");
        setAllowStaleExit(true);
        setMessage("材料或本地数据版本刚发生了变化。没有依据旧确认继续移除，请重新读取后再决定。");
        return;
      }
      if (result.outcome === "cleanup_pending") {
        const pendingMessage = materialDeletionPendingMessage(result.reason);
        setState((current) => current?.state === "present" || current?.state === "cleanup_pending"
          ? { ...current, state: "cleanup_pending", receipt: result.receipt, retryable: true }
          : current);
        setPhase("refreshing");
        setMessage(pendingMessage);
        try { await onRefresh(); }
        catch { setAllowStaleExit(true); setMessage(`${pendingMessage} 材料列表暂时没有重新读取；可以稍后只重试读取。`); }
        setPhase("cleanup");
        return;
      }
      setPhase("uncertain");
      setAllowStaleExit(true);
      setMessage("最终删除回执没有返回。本机可能已经完成，也可能仍在清理；请先只读核对，不要再次删除。");
    } catch (caught) {
      if (caught instanceof CareerMaterialDeletionError && (caught.code === "inspect_failed" || caught.code === "mark_failed")) {
        setPhase("ready");
        setMessage(caught.message);
      } else if (caught instanceof CareerMaterialDeletionError && caught.code === "invalid_receipt") {
        setPhase("changed");
        setAllowStaleExit(true);
        setMessage("这份移除确认已经变化。没有依据旧确认继续处理，请重新读取后再决定。");
      } else {
        setPhase("uncertain");
        setAllowStaleExit(true);
        setMessage("移除过程没有返回可确认的结果。请先只读核对，不要复用刚才的确认再次删除。");
      }
    } finally {
      mutationRef.current = false;
    }
  }

  async function inspectUncertainDeletion() {
    if (mutationRef.current) return;
    mutationRef.current = true;
    setPhase("checking");
    setMessage("");
    try {
      const inspected = await loadCareerMaterialDeletionState(material.id);
      setState(inspected);
      if (inspected.state === "already_absent") {
        successMessageRef.current = "核对后确认材料记录已经移除，没有重复删除。";
        mutationRef.current = false;
        await refreshAfterDeletion();
        return;
      }
      let refreshed = true;
      try { await onRefresh(); }
      catch { refreshed = false; setAllowStaleExit(true); }
      if (inspected.state === "cleanup_pending") {
        setPhase("cleanup");
        setMessage(refreshed ? "核对后确认记录仍在等待收尾。可以继续收尾，也可以稍后再回来。" : "核对到记录仍在等待收尾，但材料列表暂时没有重新读取。请留在这里稍后再试。");
      } else {
        setPhase("changed");
        setMessage(refreshed ? "核对后确认材料记录仍在。为避免依据旧信息删除，请回到最新材料卡片重新决定。" : "核对后确认材料记录仍在，但材料列表暂时没有重新读取。请先只重试读取，再重新决定。");
      }
    } catch {
      setPhase("uncertain");
      setAllowStaleExit(true);
      setMessage("本机暂时仍无法确认删除结果。继续核对不会重复删除；也可以稍后再回来。");
    } finally {
      mutationRef.current = false;
    }
  }

  const canClose = phase === "loading" || phase === "ready" || phase === "cleanup" || phase === "uncertain" || phase === "changed";
  const closeSafely = phase === "loading" || phase === "ready" ? onClose : allowStaleExit ? onStaleClose : canClose ? () => { void closeAfterRead(); } : () => undefined;
  const hasAttachment = state?.state === "present" || state?.state === "cleanup_pending" ? state.hasAttachment : Boolean(material.file_key);
  const sharesAttachment = state?.state === "present" || state?.state === "cleanup_pending" ? state.sharesAttachment : false;
  const confirmation = !hasAttachment
    ? "只移除这条材料记录；没有本地原件需要处理。"
    : sharesAttachment
      ? "当前同一原件仍被其他版本使用；移除时会在锁内再次核对，仍共享就保留，只有最后一个引用才会清理原件。"
      : "移除这条材料记录，并在确认没有其他引用后清理本地原件。";
  return <Modal title={phase === "cleanup" ? "继续完成收尾" : `移除「${material.name}」？`} description="这里只整理你选择的这一份材料，不影响职位、投递或其他版本。" onClose={closeSafely} dismissible={canClose} inertToasts>
    <div ref={phaseRootRef} className="career-material-modal-body" data-material-phase-focus tabIndex={-1}>
    {phase === "loading" && <div className="career-material-recovery" role="status"><LoaderCircle className="spin" size={23} /><h3>正在核对材料与原件</h3><p>先确认是否共享同一个本地文件，再显示会发生什么。</p></div>}
    {phase === "ready" && <div className="career-material-delete-confirm" role={message ? "alert" : undefined}><ShieldCheck size={24} /><h3>先看清这次会处理什么</h3><p>{message || confirmation}</p><div><button className="career-button primary" data-dialog-initial onClick={onClose}>继续保留</button><button className="career-button danger" onClick={() => void performDeletion()}><Trash2 size={16} />确认移除</button></div></div>}
    {phase === "deleting" && <div className="career-material-recovery" role="status"><LoaderCircle className="spin" size={23} /><h3>正在安全移除</h3><p>会先留下可重试状态，再核对引用与原件，完成前不会开放重复操作。</p></div>}
    {phase === "cleanup" && <div className="career-material-recovery cleanup" role="status" aria-live="polite"><RotateCcw size={24} /><h3>还有一步没有收尾</h3><p>{message}</p><div className="career-material-recovery-actions"><button className="career-button secondary" data-dialog-initial onClick={allowStaleExit ? onStaleClose : () => void closeAfterRead()}>稍后处理</button><button className="career-button primary" onClick={() => void performDeletion()}><RotateCcw size={16} />继续收尾</button></div><small>材料卡会保留“待收尾”，不会把尚未完成的状态伪装成已删除。</small></div>}
    {phase === "uncertain" && <div className="career-material-recovery uncertain" role="status" aria-live="polite"><ShieldCheck size={24} /><h3>需要核对删除结果</h3><p>{message}</p><div className="career-material-recovery-actions"><button className="career-button secondary" data-dialog-initial onClick={allowStaleExit ? onStaleClose : () => void closeAfterRead()}>稍后再核对</button><button className="career-button primary" onClick={() => void inspectUncertainDeletion()}><Search size={16} />只读核对</button></div></div>}
    {phase === "checking" && <div className="career-material-recovery" role="status"><LoaderCircle className="spin" size={23} /><h3>正在只读核对</h3><p>不会再次删除原件或材料记录。</p></div>}
    {phase === "refreshing" && <div className="career-material-recovery" role="status"><LoaderCircle className="spin" size={23} /><h3>正在重新读取材料状态</h3><p>只更新画面，不会重复删除或清理。</p></div>}
    {phase === "changed" && <div className="career-material-recovery conflict" role="alert"><ShieldCheck size={24} /><h3>没有依据旧信息继续删除</h3><p>{message}</p><button className="career-button primary" data-dialog-initial onClick={allowStaleExit ? onStaleClose : () => void closeAfterRead()}>回到最新材料列表</button></div>}
    {phase === "refresh-only" && <div className="career-material-recovery" role="status"><ShieldCheck size={24} /><h3>删除结果已写入本机</h3><p>{message || "现在只需重新读取画面；不会再次删除记录或原件。"}</p><div className="career-material-recovery-actions">{allowStaleExit && <button className="career-button secondary" onClick={onStaleClose}>先回材料页</button>}<button className="career-button primary" data-dialog-initial onClick={() => void refreshAfterDeletion()}><RotateCcw size={16} />只重新读取</button></div></div>}
    </div>
  </Modal>;
}

type CareerImportMode = "paste" | "capture" | "csv";
type CareerImportPhase = "input" | "fingerprinting" | "requesting-ai" | "preview" | "revising" | "committing" | "commit-check" | "refreshing" | "refresh-only" | "complete" | "conflict";
type CareerImportEditableField = CareerImportCandidateField | "priority";
type CareerImportUiRow = Readonly<{
  id: string;
  preview: CareerJobImportPreview;
  included: boolean;
  confirmedFields: ReadonlySet<CareerImportEditableField>;
}>;

export function selectCareerImportCommitRows(rows: readonly CareerImportUiRow[], allowedRowIds: ReadonlySet<string> | null = null) {
  return rows.filter((row) => row.included && row.preview.duplicateOfRowNumber === undefined && (!allowedRowIds || allowedRowIds.has(row.id)));
}

export function partitionCareerImportInspectionRows<T>(
  rows: readonly T[],
  inspections: readonly { status: "exact_committed" | "absent" | "conflict" | "still_unknown" }[],
) {
  return {
    absentRows: rows.filter((_, index) => inspections[index]?.status === "absent"),
    exactRows: rows.filter((_, index) => inspections[index]?.status === "exact_committed"),
  };
}

export function careerImportCsvFileIssue(size: number) {
  if (size === 0) return "这个 CSV 是空文件，请选择包含表头和职位内容的文件。";
  if (size > 16 * 1024 * 1024) return "这个 CSV 超过 16 MiB。为保护浏览器不卡顿，请拆成较小文件后再试；文件没有读取或写入职迹。";
  return "";
}

export function careerImportAiSourceIssue(snapshot: string) {
  if (new TextEncoder().encode(snapshot).byteLength > 160 * 1024) return "内容较长，请只保留职位正文或改用 CSV。";
  return "";
}

const careerImportModes: ReadonlyArray<{ id: CareerImportMode; label: string; icon: typeof FileText }> = [
  { id: "paste", label: "粘贴", icon: FileText },
  { id: "capture", label: "浏览器采集", icon: Command },
  { id: "csv", label: "CSV", icon: FileArchive },
];
const careerImportCandidateFields: readonly CareerImportCandidateField[] = [
  "company", "role", "location", "source", "sourceUrl", "stageId", "salary", "workMode", "description", "tags",
];

export function careerImportSourceSnapshot(mode: CareerImportMode, values: { paste: string; capture: CareerCapturedSource; csv: string }) {
  if (mode === "paste") return values.paste;
  if (mode === "csv") return values.csv;
  return JSON.stringify({ kind: "career-browser-capture-v1", url: values.capture.url.trim(), selectedText: values.capture.selectedText });
}

function sameCareerJobName(job: Pick<Job, "company" | "role">, candidate: Pick<CareerImportCandidate, "company" | "role">) {
  const normalize = (value: string) => value.trim().toLocaleLowerCase();
  return Boolean(normalize(candidate.company) && normalize(candidate.role)) &&
    normalize(job.company) === normalize(candidate.company) && normalize(job.role) === normalize(candidate.role);
}

export function careerImportFieldNote(level: CareerImportConfidenceLevel, confirmed: boolean) {
  if (confirmed) return "你已确认";
  if (level === "high") return "原文较清楚";
  if (level === "medium") return "建议核对";
  if (level === "low") return "需要你确认";
  return "原文未说明";
}

function CareerImportWarningGroup({ warnings }: { warnings: readonly CareerImportWarning[] }) {
  const blocking = warnings.filter((warning) => warning.severity === "blocking" && warning.code !== "csv_duplicate_row");
  const review = warnings.filter((warning) => warning.severity === "review" && warning.code !== "csv_duplicate_row");
  if (blocking.length === 0 && review.length === 0) return null;
  return <div className="career-import-warning-groups">
    {blocking.length > 0 && <section className="blocking" aria-label="保存前需要补充"><b>补充后再保存</b><ul>{blocking.map((warning, index) => <li key={`${warning.code}:${warning.rowNumber ?? ""}:${index}`}>{warning.message}</li>)}</ul></section>}
    {review.length > 0 && <section className="review" aria-label="建议核对"><b>建议看一眼</b><ul>{review.map((warning, index) => <li key={`${warning.code}:${warning.rowNumber ?? ""}:${index}`}>{warning.message}</li>)}</ul></section>}
  </div>;
}

function CareerImportPreviewEditor({ row, draft, data, sameName, sameNameDecision, busy, csv, selectionLocked, onDraft, onApply, onInclude, onSameNameDecision }: {
  row: CareerImportUiRow;
  draft: CareerImportCandidate;
  data: CareerData;
  sameName: Job | undefined;
  sameNameDecision: "pending" | "save" | "skip";
  busy: boolean;
  csv: boolean;
  selectionLocked: boolean;
  onDraft: (field: CareerImportEditableField, value: string | number) => void;
  onApply: () => void;
  onInclude: (included: boolean) => void;
  onSameNameDecision: (decision: "save" | "skip") => void;
}) {
  const changedFields = careerImportCandidateFields.filter((field) => draft[field] !== row.preview.candidate[field]);
  const priorityChanged = draft.priority !== row.preview.candidate.priority;
  const hasDraftChanges = changedFields.length > 0 || priorityChanged;
  const note = (field: CareerImportCandidateField) => careerImportFieldNote(row.preview.confidence.fields[field], row.confirmedFields.has(field));
  return <article className={`career-import-row-card ${row.included ? "included" : "paused"}`}>
    <header>
      <div><span>{row.preview.rowNumber ? `CSV 第 ${row.preview.rowNumber} 行` : "保存前核对"}</span><h3>{draft.role || "职位待确认"}</h3><p>{draft.company || "公司待确认"}{draft.location ? ` · ${draft.location}` : ""}</p></div>
      {csv && <label className={`career-import-row-toggle ${selectionLocked ? "locked" : ""}`}><input type="checkbox" checked={row.included} disabled={selectionLocked} onChange={(event) => onInclude(event.target.checked)} /><span>{selectionLocked ? "保持原选择" : row.included ? "保存这条" : "这次不保存"}</span></label>}
    </header>
    {row.included && <>
      {sameName && <div className="career-import-same-name"><Bell size={17} /><div><b>本机已有同名记录</b><p>{sameName.company} · {sameName.role}。它可能是同一职位，也可能是不同批次；这里不替你判断。</p><div><button type="button" className={sameNameDecision === "save" ? "active" : ""} aria-pressed={sameNameDecision === "save"} onClick={() => onSameNameDecision("save")}>仍保存这份</button><button type="button" className={sameNameDecision === "skip" ? "active" : ""} aria-pressed={sameNameDecision === "skip"} onClick={() => { onSameNameDecision("skip"); if (csv) onInclude(false); }}>这次先不保存</button></div></div></div>}
      <div className="career-import-edit-grid">
        <Field label="公司" hint={note("company")}><input value={draft.company} onChange={(event) => onDraft("company", event.target.value)} required /></Field>
        <Field label="职位" hint={note("role")}><input value={draft.role} onChange={(event) => onDraft("role", event.target.value)} required /></Field>
        <Field label="地点" hint={note("location")}><input value={draft.location} onChange={(event) => onDraft("location", event.target.value)} /></Field>
        <Field label="工作方式" hint={note("workMode")}><select value={draft.workMode} onChange={(event) => onDraft("workMode", event.target.value)}><option value="">待确认</option><option>现场办公</option><option>混合办公</option><option>远程</option></select></Field>
        <Field label="薪资" hint={note("salary")}><input value={draft.salary} onChange={(event) => onDraft("salary", event.target.value)} placeholder="待确认" /></Field>
        <Field label="来源" hint={note("source")}><input value={draft.source} onChange={(event) => onDraft("source", event.target.value)} /></Field>
        <Field label="保存位置" hint={note("stageId")}><select value={draft.stageId} onChange={(event) => onDraft("stageId", event.target.value)}>{data.stages.filter((stage) => !stage.hidden).map((stage) => <option value={stage.id} key={stage.id}>{stage.name}{stage.id === "stage_saved" ? "（不代表已投递）" : ""}</option>)}</select></Field>
        <Field label="是否关注" hint="只是方便筛选，不是优先级评分"><select value={careerJobIsWatched(draft.priority) ? 2 : 1} onChange={(event) => onDraft("priority", Number(event.target.value))}><option value="1">普通记录</option><option value="2">已关注</option></select></Field>
      </div>
      <Field label="关键词" hint={note("tags")}><input value={draft.tags} onChange={(event) => onDraft("tags", event.target.value)} placeholder="用逗号分隔" /></Field>
      <Field label="原职位链接" hint={note("sourceUrl")}><input type="url" value={draft.sourceUrl} onChange={(event) => onDraft("sourceUrl", event.target.value)} placeholder="https://" /></Field>
      <Field label="职位描述" hint={note("description")}><textarea rows={8} value={draft.description} onChange={(event) => onDraft("description", event.target.value)} /></Field>
      {hasDraftChanges && <div className="career-import-unapplied" role="status"><Pencil size={16} /><span>修改还只在表单里，确认后才会更新这份预览。</span><button type="button" className="career-button secondary" disabled={busy} onClick={onApply}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{busy ? "正在确认…" : "确认这些修改"}</button></div>}
      <CareerImportWarningGroup warnings={row.preview.warnings} />
      {safeLink(draft.sourceUrl) && <a className="career-import-source-link" href={draft.sourceUrl} target="_blank" rel="noreferrer">打开原职位 <ExternalLink size={14} /></a>}
    </>}
  </article>;
}

function CareerImportModal({ data, initialCapture, onClose, onRefresh, notify }: { data: CareerData; initialCapture: CareerCapturedSource | null; onClose: () => void; onRefresh: () => Promise<void>; notify: (text: string, tone?: Notice["tone"]) => void }) {
  const [mode, setMode] = useState<CareerImportMode>(initialCapture ? "capture" : "paste");
  const [paste, setPaste] = useState("");
  const [capture, setCapture] = useState<CareerCapturedSource>(initialCapture ?? { url: "", selectedText: "" });
  const [csvText, setCsvText] = useState("");
  const [csvName, setCsvName] = useState("");
  const [phase, setPhase] = useState<CareerImportPhase>("input");
  const [rows, setRowsState] = useState<CareerImportUiRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, CareerImportCandidate>>({});
  const [previewSource, setPreviewSource] = useState<{ mode: CareerImportMode; snapshot: string; fingerprint: string } | null>(null);
  const [globalWarnings, setGlobalWarnings] = useState<readonly CareerImportWarning[]>([]);
  const [sameNameDecisions, setSameNameDecisions] = useState<Record<string, "pending" | "save" | "skip">>({});
  const [revisingRowId, setRevisingRowId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [checking, setChecking] = useState(false);
  const [absentRowIds, setAbsentRowIds] = useState<ReadonlySet<string> | null>(null);
  const [committedRowIds, setCommittedRowIds] = useState<ReadonlySet<string>>(new Set());
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rowsRef = useRef<CareerImportUiRow[]>([]);
  const commitRef = useRef(false);
  const checkRef = useRef(false);
  const uncertainRowsRef = useRef<CareerImportUiRow[]>([]);
  const finalClosePendingRef = useRef(false);
  const requestRef = useRef<{ token: number; controller: AbortController | null }>({ token: 0, controller: null });
  const valuesRef = useRef({ paste: "", capture: initialCapture ?? { url: "", selectedText: "" }, csv: "" });
  const modeRef = useRef<CareerImportMode>(initialCapture ? "capture" : "paste");

  useEffect(() => () => {
    requestRef.current.controller?.abort();
    requestRef.current = { token: requestRef.current.token + 1, controller: null };
  }, []);

  useEffect(() => {
    if (closeConfirm || !finalClosePendingRef.current) return;
    finalClosePendingRef.current = false;
    onClose();
  }, [closeConfirm, onClose]);

  function setRows(next: CareerImportUiRow[]) {
    rowsRef.current = next;
    setRowsState(next);
  }
  function currentSnapshot(targetMode: CareerImportMode) {
    return careerImportSourceSnapshot(targetMode, valuesRef.current);
  }
  function cancelPendingRequest() {
    requestRef.current.controller?.abort();
    requestRef.current = { token: requestRef.current.token + 1, controller: null };
    if (phase === "fingerprinting" || phase === "requesting-ai") setPhase(rowsRef.current.length > 0 ? "preview" : "input");
  }
  function changeMode(nextMode: CareerImportMode) {
    if (absentRowIds) return;
    if (nextMode === modeRef.current) return;
    cancelPendingRequest();
    modeRef.current = nextMode;
    setMode(nextMode);
    setError("");
  }
  function changePaste(value: string) {
    if (absentRowIds) return;
    valuesRef.current = { ...valuesRef.current, paste: value };
    setPaste(value);
    cancelPendingRequest();
    setError("");
  }
  function changeCapture(patch: Partial<CareerCapturedSource>) {
    if (absentRowIds) return;
    const next = { ...valuesRef.current.capture, ...patch };
    valuesRef.current = { ...valuesRef.current, capture: next };
    setCapture(next);
    cancelPendingRequest();
    setError("");
  }
  function replacePreview(nextRows: CareerImportUiRow[], source: { mode: CareerImportMode; snapshot: string; fingerprint: string }, warnings: readonly CareerImportWarning[] = []) {
    setRows(nextRows);
    setDrafts(Object.fromEntries(nextRows.map((row) => [row.id, row.preview.candidate])));
    setPreviewSource(source);
    setGlobalWarnings(warnings);
    setSameNameDecisions({});
    setAbsentRowIds(null);
    setCommittedRowIds(new Set());
    setMessage("");
    setError("");
    setPhase("preview");
  }
  function requestIsCurrent(token: number, targetMode: CareerImportMode, snapshot: string) {
    return requestRef.current.token === token && modeRef.current === targetMode && currentSnapshot(targetMode) === snapshot;
  }

  async function previewWithAi(targetMode: "paste" | "capture") {
    if (absentRowIds) return;
    const snapshot = currentSnapshot(targetMode);
    const captureValue = valuesRef.current.capture;
    if (targetMode === "paste" ? !snapshot.trim() : !captureValue.url.trim() && !captureValue.selectedText.trim()) return;
    const sourceIssue = careerImportAiSourceIssue(snapshot);
    if (sourceIssue) {
      cancelPendingRequest();
      setMessage("");
      setError(sourceIssue);
      return;
    }
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    const token = requestRef.current.token + 1;
    requestRef.current = { token, controller };
    setError("");
    setMessage("");
    setPhase("fingerprinting");
    try {
      const fingerprint = await fingerprintCareerImportSource(snapshot);
      if (!requestIsCurrent(token, targetMode, snapshot)) return;
      setPhase("requesting-ai");
      const trimmedPaste = valuesRef.current.paste.trim();
      const isStandaloneUrl = targetMode === "paste" && /^https?:\/\/\S+$/i.test(trimmedPaste);
      const requestBody = targetMode === "capture"
        ? { url: captureValue.url.trim(), text: captureValue.selectedText }
        : { url: isStandaloneUrl ? trimmedPaste : "", text: isStandaloneUrl ? "" : valuesRef.current.paste };
      const response = await fetch("/api/import/job", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!requestIsCurrent(token, targetMode, snapshot)) return;
      if (!response.ok) throw new Error((body as { error?: string } | null)?.error || "这次没有整理成功，原文仍保留在这里。");
      const parsed = parseAiContent(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("服务没有返回可核对的职位字段，原文仍保留在这里。");
      const parsedCandidate = { ...(parsed as Record<string, unknown>) };
      for (const untrustedSourceField of [
        "source", "platform", "source_hint", "detected_source", "sourceUrl", "source_url", "url", "original_url",
        "stageId", "stage_id", "stage", "status", "priority",
      ]) {
        delete parsedCandidate[untrustedSourceField];
      }
      const explicitUrl = targetMode === "capture" ? captureValue.url.trim() : isStandaloneUrl ? trimmedPaste : "";
      if (explicitUrl) parsedCandidate.original_url = explicitUrl;
      const previous = previewSource?.snapshot === snapshot && rowsRef.current.length === 1 ? rowsRef.current[0].preview : undefined;
      const preview = await createCareerJobImportPreview({ sourceText: snapshot, parsedCandidate, importOperationId: previous?.importOperationId });
      if (!requestIsCurrent(token, targetMode, snapshot)) return;
      if (preview.sourceFingerprint !== fingerprint) throw new Error("原文核对结果不一致，请按当前内容重新预览。");
      replacePreview([{ id: previous ? rowsRef.current[0].id : crypto.randomUUID(), preview, included: true, confirmedFields: new Set() }], { mode: targetMode, snapshot, fingerprint });
    } catch (caught) {
      if (controller.signal.aborted || requestRef.current.token !== token) return;
      setPhase(rowsRef.current.length > 0 ? "preview" : "input");
      setError(caught instanceof Error ? caught.message : "这次没有整理成功，原文仍保留在这里。");
    } finally {
      if (requestRef.current.token === token) requestRef.current.controller = null;
    }
  }

  async function previewCsv(file: File) {
    if (absentRowIds) return;
    cancelPendingRequest();
    const token = requestRef.current.token + 1;
    requestRef.current = { token, controller: null };
    setCsvName(file.name);
    setError("");
    setMessage("");
    const fileIssue = careerImportCsvFileIssue(file.size);
    if (fileIssue) {
      setError(fileIssue);
      setPhase(rowsRef.current.length > 0 ? "preview" : "input");
      return;
    }
    setPhase("fingerprinting");
    try {
      const text = await file.text();
      if (requestRef.current.token !== token) return;
      valuesRef.current = { ...valuesRef.current, csv: text };
      setCsvText(text);
      const parsed = await parseCareerCsvImportPreview(text);
      if (requestRef.current.token !== token || valuesRef.current.csv !== text || modeRef.current !== "csv") return;
      const nextRows = parsed.rows.map((preview, index) => ({
        id: `${preview.rowNumber ?? index}:${crypto.randomUUID()}`,
        preview,
        included: preview.duplicateOfRowNumber === undefined,
        confirmedFields: new Set<CareerImportEditableField>(),
      }));
      replacePreview(nextRows, { mode: "csv", snapshot: text, fingerprint: parsed.sourceFingerprint }, parsed.warnings);
    } catch (caught) {
      if (requestRef.current.token !== token) return;
      setPhase(rowsRef.current.length > 0 ? "preview" : "input");
      setError(caught instanceof Error ? caught.message : "这个 CSV 暂时无法预览，文件没有写入职迹。");
    }
  }

  function updateDraft(rowId: string, field: CareerImportEditableField, value: string | number) {
    setDrafts((current) => ({ ...current, [rowId]: { ...current[rowId], [field]: value } }));
  }
  async function applyRowChanges(rowId: string) {
    if (revisingRowId) return;
    const row = rowsRef.current.find((item) => item.id === rowId);
    const draft = drafts[rowId];
    if (!row || !draft) return;
    const patch = Object.fromEntries([...careerImportCandidateFields, "priority" as const]
      .filter((field) => draft[field] !== row.preview.candidate[field])
      .map((field) => [field, draft[field]]));
    const changedFields = Object.keys(patch) as CareerImportEditableField[];
    if (changedFields.length === 0) return;
    setRevisingRowId(rowId);
    setPhase("revising");
    setError("");
    try {
      const revised = await reviseCareerJobImportPreview(row.preview, patch);
      const nextRows = rowsRef.current.map((item) => item.id === rowId ? {
        ...item,
        preview: revised,
        confirmedFields: new Set([...item.confirmedFields, ...changedFields]),
      } : item);
      setRows(nextRows);
      setDrafts((current) => ({ ...current, [rowId]: revised.candidate }));
      if (changedFields.includes("company") || changedFields.includes("role")) {
        setSameNameDecisions((current) => ({ ...current, [rowId]: "pending" }));
      }
      setPhase("preview");
    } catch (caught) {
      setPhase("preview");
      setError(caught instanceof Error ? caught.message : "这次修改没有更新预览，表单内容仍保留。");
    } finally { setRevisingRowId(null); }
  }
  async function forkDuplicate(rowId: string) {
    if (revisingRowId || absentRowIds) return;
    const row = rowsRef.current.find((item) => item.id === rowId);
    if (!row) return;
    setRevisingRowId(rowId);
    setPhase("revising");
    setError("");
    try {
      const forked = await forkCareerJobImportPreview(row.preview);
      const nextRows = rowsRef.current.map((item) => item.id === rowId ? { ...item, preview: forked, included: true } : item);
      setRows(nextRows);
      setDrafts((current) => ({ ...current, [rowId]: forked.candidate }));
      setPhase("preview");
    } catch (caught) {
      setPhase("preview");
      setError(caught instanceof Error ? caught.message : "这行仍保持合并，没有另存。");
    } finally { setRevisingRowId(null); }
  }
  function setRowIncluded(rowId: string, included: boolean) {
    if (absentRowIds && !absentRowIds.has(rowId)) return;
    setRows(rowsRef.current.map((row) => row.id === rowId ? { ...row, included } : row));
    if (included) setSameNameDecisions((current) => ({ ...current, [rowId]: "pending" }));
  }
  function setSameNameDecision(rowId: string, decision: "save" | "skip") {
    setSameNameDecisions((current) => ({ ...current, [rowId]: decision }));
  }

  async function refreshAfterCommit() {
    setPhase("refreshing");
    setError("");
    try {
      await onRefresh();
      setPhase("complete");
      notify("职位已保存在本机");
    } catch {
      setPhase("refresh-only");
      setError("职位可能已经保存在本机，只是画面还没重新读取。这里只会刷新画面，不会再次创建。");
    }
  }
  async function commitPreview() {
    if (commitRef.current || phase !== "preview" || !previewSource) return;
    const selected = selectCareerImportCommitRows(rowsRef.current, absentRowIds);
    if (selected.length === 0) return;
    commitRef.current = true;
    setPhase("committing");
    setError("");
    try {
      const snapshot = currentSnapshot(previewSource.mode);
      const fingerprint = await fingerprintCareerImportSource(snapshot);
      if (modeRef.current !== previewSource.mode || snapshot !== previewSource.snapshot || fingerprint !== previewSource.fingerprint) {
        throw new CareerImportError("source_changed", "原文或文件已经变化，请按当前内容重新预览；这次没有保存。");
      }
      await commitCareerJobImports({ items: selected.map((row) => ({ preview: row.preview, currentSourceFingerprint: fingerprint })) });
      await refreshAfterCommit();
    } catch (caught) {
      if (caught instanceof CareerImportCommitUncertainError || (caught instanceof CareerImportError && caught.code === "commit_uncertain")) {
        uncertainRowsRef.current = selected;
        setMessage("本机是否完成写入暂时无法确认。接下来只核对已有记录，不会重新提交。");
        setPhase("commit-check");
      } else if (caught instanceof CareerImportError && caught.code === "operation_conflict") {
        setMessage("这份导入标识对应了不同内容。这里已经停止写入，现有记录不会被覆盖。");
        setPhase("conflict");
      } else {
        setPhase("preview");
        setError(caught instanceof Error ? caught.message : "这次没有保存，预览仍保留在这里。");
      }
    } finally { commitRef.current = false; }
  }
  async function inspectUncertainCommit() {
    if (checkRef.current || uncertainRowsRef.current.length === 0) return;
    checkRef.current = true;
    setChecking(true);
    setError("");
    try {
      const inspections = await Promise.all(uncertainRowsRef.current.map((row) => inspectCareerImportCommit(row.preview)));
      if (inspections.some((item) => item.status === "conflict")) {
        setMessage("核对发现这份导入标识对应了不同内容。这里已经停止写入，现有记录不会被覆盖。");
        setPhase("conflict");
      } else if (inspections.some((item) => item.status === "still_unknown")) {
        setMessage("本机暂时仍无法确认。可以稍后继续核对；这里不会重新提交或换一个标识。");
      } else if (inspections.some((item) => item.status === "absent")) {
        const { absentRows, exactRows } = partitionCareerImportInspectionRows(uncertainRowsRef.current, inspections);
        const absentIds = new Set(absentRows.map((row) => row.id));
        const exactIds = new Set(exactRows.map((row) => row.id));
        setAbsentRowIds(absentIds);
        setCommittedRowIds(exactIds);
        setRows(rowsRef.current.map((row) => exactIds.has(row.id) ? { ...row, included: false } : row));
        uncertainRowsRef.current = [];
        setMessage(exactRows.length > 0
          ? "核对完成：已保存的项目不会再次写入；未写入的原预览和原操作标识仍保留，只能修改并再次保存这些项目。"
          : "核对确认这次没有写入。原预览和原操作标识都已保留；这次只能修改并再次保存原来的选择。");
        setPhase("preview");
      } else {
        await refreshAfterCommit();
      }
    } catch {
      setMessage("本机暂时仍无法确认。可以稍后继续核对；这里不会重新提交或换一个标识。");
    } finally {
      checkRef.current = false;
      setChecking(false);
    }
  }
  async function retryRefreshOnly() {
    setPhase("refreshing");
    setError("");
    try {
      await onRefresh();
      setPhase("complete");
      notify("职位已保存在本机");
    } catch {
      setPhase("refresh-only");
      setError("记录仍保存在本机。可以稍后再重新读取；这里不会重复创建。");
    }
  }

  const renderedSourceSnapshot = previewSource ? careerImportSourceSnapshot(previewSource.mode, { paste, capture, csv: csvText }) : "";
  const sourceChanged = previewSource !== null && (mode !== previewSource.mode || renderedSourceSnapshot !== previewSource.snapshot);
  const selectedRows = selectCareerImportCommitRows(rows, absentRowIds);
  const hasGlobalBlocking = globalWarnings.some((warning) => warning.severity === "blocking");
  const hasBlocking = selectedRows.some((row) => row.preview.warnings.some((warning) => warning.severity === "blocking"));
  const hasUnappliedDraft = selectedRows.some((row) => {
    const draft = drafts[row.id];
    return draft && ([...careerImportCandidateFields, "priority" as const].some((field) => draft[field] !== row.preview.candidate[field]));
  });
  const sameNamePending = selectedRows.some((row) => data.jobs.some((job) => sameCareerJobName(job, row.preview.candidate)) && (sameNameDecisions[row.id] ?? "pending") === "pending");
  const sameNameSkipped = selectedRows.some((row) => data.jobs.some((job) => sameCareerJobName(job, row.preview.candidate)) && sameNameDecisions[row.id] === "skip");
  const originalRecoverySelection = absentRowIds === null || selectedRows.every((row) => absentRowIds.has(row.id));
  const canCommit = phase === "preview" && selectedRows.length > 0 && originalRecoverySelection && !sourceChanged && !hasGlobalBlocking && !hasBlocking && !hasUnappliedDraft && !sameNamePending && !sameNameSkipped;
  const dirty = Boolean(paste.trim() || capture.url.trim() || capture.selectedText.trim() || csvText || rows.length > 0);
  const closeLocked = phase === "committing" || phase === "commit-check" || phase === "refreshing" || phase === "refresh-only";
  const recoveryActive = closeLocked || phase === "conflict" || phase === "complete";
  const statusText = phase === "fingerprinting" ? "正在核对当前原文…" : phase === "requesting-ai" ? "DeepSeek 正在整理你明确提供的内容…" : phase === "revising" ? "正在更新可核对的预览…" : "";
  function requestClose() {
    if (closeLocked) return;
    cancelPendingRequest();
    if (dirty && phase !== "complete" && phase !== "conflict") { setCloseConfirm(true); return; }
    onClose();
  }
  function tabKeydown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % careerImportModes.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + careerImportModes.length) % careerImportModes.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = careerImportModes.length - 1;
    else return;
    event.preventDefault();
    changeMode(careerImportModes[next].id);
    tabRefs.current[next]?.focus();
  }

  return <><Modal title="从职位原文建立记录" description="所有方式都会先生成可编辑预览；只有你确认保存后，才会写入本机职迹。" onClose={requestClose} wide dismissible={!closeLocked} inertToasts={closeLocked}>
    <div className="career-import-shell">
      {!recoveryActive && <>
      <div className="career-import-tabs" role="tablist" aria-label="选择原文来源">{careerImportModes.map((item, index) => <button ref={(element) => { tabRefs.current[index] = element; }} type="button" role="tab" id={`career-import-tab-${item.id}`} aria-controls={`career-import-panel-${item.id}`} aria-selected={mode === item.id} tabIndex={mode === item.id ? 0 : -1} disabled={absentRowIds !== null} className={mode === item.id ? "active" : ""} key={item.id} onClick={() => changeMode(item.id)} onKeyDown={(event) => tabKeydown(event, index)}><item.icon size={16} />{item.label}</button>)}</div>
      <section className="career-import-input-panel" role="tabpanel" id={`career-import-panel-${mode}`} aria-labelledby={`career-import-tab-${mode}`}>
        {mode === "paste" && <><Field label="职位原文或公开链接"><textarea data-dialog-initial rows={7} value={paste} disabled={absentRowIds !== null} onChange={(event) => changePaste(event.target.value)} placeholder="粘贴职位描述、分享文本，或一个公开职位链接…" /></Field><p className="career-import-privacy"><ShieldCheck size={16} />粘贴：只有你在这里明确输入的内容会经 DeepSeek 整理；不会自动投递。</p><button type="button" className="career-button primary import-button" disabled={absentRowIds !== null || !paste.trim() || phase === "fingerprinting" || phase === "requesting-ai"} onClick={() => void previewWithAi("paste")}><WandSparkles size={16} />按当前内容生成预览</button></>}
        {mode === "capture" && <><Field label="当前页面 URL"><input type="url" value={capture.url} disabled={absentRowIds !== null} onChange={(event) => changeCapture({ url: event.target.value })} placeholder="https://…" /></Field><Field label="你选中的文字" hint="可以留空"><textarea rows={7} value={capture.selectedText} disabled={absentRowIds !== null} onChange={(event) => changeCapture({ selectedText: event.target.value })} placeholder="采集器只带回你主动选中的文字，不会读取整页正文。" /></Field><p className="career-import-privacy"><ShieldCheck size={16} />采集：只发送 URL 与选中文字，不包含 Cookie、登录态或站内消息；不会自动投递。</p><button type="button" className="career-button primary import-button" disabled={absentRowIds !== null || (!capture.url.trim() && !capture.selectedText.trim()) || phase === "fingerprinting" || phase === "requesting-ai"} onClick={() => void previewWithAi("capture")}><WandSparkles size={16} />按当前采集生成预览</button></>}
        {mode === "csv" && <div className="career-csv-input"><div><FileArchive size={25} /><span><b>在本机预览 CSV</b><small>支持中英文表头、引号内换行与转义引号。</small></span></div><input className="career-import-file-input" aria-label="选择职位 CSV 文件" type="file" accept=".csv,text/csv" disabled={absentRowIds !== null} onChange={(event) => { const file = event.target.files?.[0]; if (file) void previewCsv(file); event.currentTarget.value = ""; }} />{csvName && <p>当前文件：<b>{csvName}</b></p>}<p className="career-import-privacy"><ShieldCheck size={16} />CSV 只在当前浏览器本机解析，不会发送给 AI。</p></div>}
      </section>
      {statusText && <div className="career-import-status" role="status" aria-live="polite"><LoaderCircle className="spin" size={17} /><span>{statusText}</span>{(phase === "fingerprinting" || phase === "requesting-ai") && <button type="button" className="career-button ghost" onClick={cancelPendingRequest}>停止整理</button>}</div>}
      {error && <div className="career-inline-error" role="alert"><X size={16} /><span>{error}</span></div>}
      {message && phase === "preview" && !absentRowIds && <div className="career-import-message" role="status"><ShieldCheck size={17} /><span>{message}</span></div>}
      {absentRowIds && phase === "preview" && <div className="career-import-source-changed original-operation" role="status"><ShieldCheck size={17} /><div><b>{committedRowIds.size > 0 ? "已保存与未写入的项目已分开" : "核对确认这次没有写入"}</b><p>{committedRowIds.size > 0 ? "已保存的项目只显示核对结果，不会再次编辑、选择或写入。未写入项目保留原操作标识；这次不能更换原文、文件或新增选择。" : "原预览与操作标识已保留。为避免重复记录，这次不能更换原文、文件或新增选择；仍可修改并再次保存原来的预览。"}</p></div></div>}
      {sourceChanged && rows.length > 0 && <div className="career-import-source-changed" role="status"><FileText size={17} /><div><b>原文已经变化</b><p>旧预览仍完整保留，但不能按新原文保存。请按当前内容重新生成预览。</p></div></div>}
      {globalWarnings.length > 0 && previewSource?.mode === "csv" && <CareerImportWarningGroup warnings={globalWarnings} />}
      {rows.length > 0 && <div className={`career-import-preview-list ${previewSource?.mode === "csv" ? "csv" : "single"}`}>{rows.map((row) => committedRowIds.has(row.id) ? <article className="career-import-folded-row committed" key={row.id}><div><CheckCircle2 size={17} /><span><b>{row.preview.candidate.company} · {row.preview.candidate.role} 已确认保存在本机</b><small>这条只显示核对结果，不会再次编辑、选择或写入。</small></span></div></article> : row.preview.duplicateOfRowNumber !== undefined ? <article className="career-import-folded-row" key={row.id}><div><FileArchive size={17} /><span><b>第 {row.preview.rowNumber} 行与第 {row.preview.duplicateOfRowNumber} 行内容相同</b><small>默认合并，只保存一条；这不是错误。</small></span></div><button type="button" className="career-button secondary" disabled={revisingRowId !== null || absentRowIds !== null} onClick={() => void forkDuplicate(row.id)}>仍另存</button></article> : <CareerImportPreviewEditor key={row.id} row={row} draft={drafts[row.id] ?? row.preview.candidate} data={data} sameName={data.jobs.find((job) => sameCareerJobName(job, row.preview.candidate))} sameNameDecision={sameNameDecisions[row.id] ?? "pending"} busy={revisingRowId === row.id} csv={previewSource?.mode === "csv"} selectionLocked={Boolean(absentRowIds && !absentRowIds.has(row.id))} onDraft={(field, value) => updateDraft(row.id, field, value)} onApply={() => void applyRowChanges(row.id)} onInclude={(included) => setRowIncluded(row.id, included)} onSameNameDecision={(decision) => setSameNameDecision(row.id, decision)} />)}</div>}
      {rows.length > 0 && <footer className="career-import-actions"><div>{hasUnappliedDraft ? "先确认表单里的修改" : sameNamePending ? "请先决定同名记录是否保存" : sameNameSkipped ? "你选择了这次不保存；也可以改回“仍保存这份”" : hasGlobalBlocking || hasBlocking ? "补充必要信息后即可保存" : sourceChanged ? "请按当前原文重新生成预览" : selectedRows.length === 0 ? "可以选择要保存的预览" : "保存只会写入本机 SQLite"}</div><button type="button" className="career-button primary" disabled={!canCommit} onClick={() => void commitPreview()}><Check size={16} />{previewSource?.mode === "csv" ? "保存所选预览" : "保存到职迹"}</button></footer>}
      </>}
      {phase === "committing" && <section className="career-import-recovery" role="status" aria-live="polite"><LoaderCircle className="spin" size={25} /><h3>正在保存到本机</h3><p>这份预览正在以原操作标识写入。为了避免重复记录，完成前不会接受第二次提交。</p></section>}
      {phase === "refreshing" && <section className="career-import-recovery" role="status" aria-live="polite"><LoaderCircle className="spin" size={25} /><h3>正在重新读取画面</h3><p>写入步骤已经结束。现在只更新画面，不会再创建职位。</p></section>}
      {phase === "commit-check" && <section className="career-import-recovery" role="status" aria-live="polite"><ShieldCheck size={24} /><h3>先核对，不重复提交</h3><p>{message}</p><button type="button" className="career-button primary" data-dialog-initial disabled={checking} onClick={() => void inspectUncertainCommit()}>{checking ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}{checking ? "正在核对本机记录…" : "核对本机记录"}</button><small>这一步只读取原操作标识，不会创建新职位。</small></section>}
      {phase === "refresh-only" && <section className="career-import-recovery" role="status"><RotateCcw size={24} /><h3>记录已交给本机保存</h3><p>{error}</p><button type="button" className="career-button primary" data-dialog-initial onClick={() => void retryRefreshOnly()}><RotateCcw size={16} />只重新读取</button><small>不会再次提交，也不会创建另一个操作标识。</small></section>}
      {phase === "conflict" && <section className="career-import-recovery neutral" role="status"><ShieldCheck size={24} /><h3>已经停止写入</h3><p>{message}</p><button type="button" className="career-button secondary" data-dialog-initial onClick={onClose}>关闭并稍后核对</button></section>}
      {phase === "complete" && <section className="career-import-recovery complete" role="status"><CheckCircle2 size={25} /><h3>职位已经安稳地留在职迹里</h3><p>预览已保存，画面也重新读取完成。没有自动投递或更改其他记录。</p><button type="button" className="career-button primary" data-dialog-initial onClick={onClose}>回到职位</button></section>}
    </div>
  </Modal>{closeConfirm && <Modal title="放弃这次导入吗？" description="原文、CSV 预览与尚未保存的修改只在当前窗口里。" onClose={() => setCloseConfirm(false)} inertToasts><div className="career-import-close-choice"><p>你可以继续核对；如果放弃，职迹里已经存在的记录不会受影响。</p><div><button type="button" className="career-button primary" data-dialog-initial onClick={() => setCloseConfirm(false)}>继续核对</button><button type="button" className="career-button danger" onClick={() => { cancelPendingRequest(); finalClosePendingRef.current = true; setCloseConfirm(false); }}>放弃这次输入</button></div></div></Modal>}</>;
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
  return <Modal title={state.title} description="先核对结果，再决定是否使用；结果不会自动保存。" onClose={onClose} wide>
    <div className="career-ai-preview">
      <CareerAiDisclosure action={state.action} className="in-preview" />
      {state.loading ? <div className="career-ai-loading"><span><Sparkles size={22} /></span><LoaderCircle className="spin" size={19} /><h3>正在阅读你选择的内容</h3><p>不会自动改动任何职位、材料或面经。</p></div> : state.error ? <div className="career-ai-error"><X size={24} /><h3>这次没有生成成功</h3><p>{state.error}</p><button className="career-button secondary" onClick={onClose}>返回手动编辑</button></div> : <><div className="career-ai-banner"><ShieldCheck size={17} /><span>{onApply ? "填入只会更新总结、问题和复盘草稿；原始速记与面试状态保持不变，仍需你确认。" : "结果只供你核对与复制，不会改动现有记录。"}</span></div><pre>{aiText(state.result)}</pre>{applyError && <div className="career-inline-error" role="alert"><X size={15} />{applyError}</div>}<div className="career-form-actions"><button type="button" className="career-button ghost" onClick={onClose}>关闭预览</button><button type="button" className={`career-button ${onApply ? "secondary" : "primary"}`} disabled={copyState === "copying" || applyState === "applying"} onClick={() => void handleCopy()}><Check size={16} />{copyState === "copying" ? "正在复制…" : copyState === "copied" ? "已复制" : copyState === "failed" ? "请手动选择" : "复制结果"}</button>{onApply && <button type="button" className="career-button primary" disabled={applyState === "applying"} onClick={() => void handleApply()}>{applyState === "applying" ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}{applyState === "applying" ? "正在填入…" : applyLabel || "填入草稿"}</button>}</div></>}
    </div>
  </Modal>;
}
