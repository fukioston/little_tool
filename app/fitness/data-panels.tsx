"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  exportCompleteFitnessBackup,
} from "@/lib/fitness/backup";
import {
  deleteFitnessFileSafely,
  discardFitnessFileSave,
  getFitnessFileBlob,
  inspectFitnessFileDelete,
  inspectFitnessFileSave,
  listFitnessFiles,
  prepareFitnessFileDelete,
  prepareFitnessFileSave,
  resumeFitnessFileSave,
  saveFitnessFileSafely,
  type FitnessFileRecord,
} from "@/lib/fitness/files";
import { subscribeFitnessChanges } from "@/lib/fitness/lock";
import type { FitnessEquipment } from "@/lib/fitness/types";
import {
  FITNESS_FILE_OPERATION_PREFIX,
  claimFitnessFileOperation,
  createFitnessFileDeleteTicket,
  createFitnessFileSaveTicket,
  formatFitnessFileByteSize,
  persistFitnessFileOperation,
  readFitnessFileOperationJournal,
  releaseFitnessFileOperation,
  removeFitnessFileOperation,
  runWithCurrentFitnessFileOperation,
  type FitnessFileOperationEntry,
  type FitnessFileOperationJournal,
  type FitnessFileOperationToken,
} from "./file-operation-journal";
import { FitnessBackupFlow } from "./FitnessBackupFlow";

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "操作没有完成，现有数据未被静默覆盖。";
}

type Preview = Readonly<{ record: FitnessFileRecord; url: string | null }>;

type PhotoCommit = "saved" | "deleted";

type PhotoFlow =
  | Readonly<{ phase: "idle" }>
  | Readonly<{
      phase: "working";
      action: "prepare-save" | "save" | "prepare-delete" | "delete" | "inspect" | "resume" | "discard" | "journal" | "refresh";
    }>
  | Readonly<{ phase: "check"; entry: FitnessFileOperationEntry; message: string }>
  | Readonly<{
      phase: "decision";
      entry: FitnessFileOperationEntry;
      decision: "save-staged" | "delete-present" | "delete-finishing";
      message: string;
    }>
  | Readonly<{ phase: "changed"; entry: FitnessFileOperationEntry; message: string }>
  | Readonly<{ phase: "refresh-only"; entry: FitnessFileOperationEntry; commit: PhotoCommit; message: string }>
  | Readonly<{ phase: "reminder-only"; entry: FitnessFileOperationEntry; commit: PhotoCommit; message: string }>;

type JournalState = FitnessFileOperationJournal & Readonly<{ loaded: boolean }>;

const EMPTY_JOURNAL: JournalState = {
  loaded: false,
  entries: [],
  unreadable: [],
  unavailable: false,
};

function fileAvailability(preview: Preview): string {
  if (preview.url) return "原件已核对";
  if (preview.record.status === "pending") return "写入尚待核对";
  if (preview.record.status === "deleting") return "移除尚待收尾";
  return "记录仍在 · 原件没有读到";
}

export function EquipmentPhotos({
  equipment,
  currentOrigin,
  recoveryOnly = false,
  onChanged,
  onBusyChange,
  onJournalChange,
  onBack,
}: {
  equipment: Pick<FitnessEquipment, "id" | "name">;
  currentOrigin: string;
  recoveryOnly?: boolean;
  onChanged: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  onJournalChange?: (journal: FitnessFileOperationJournal) => void;
  onBack: () => void;
}) {
  const [previews, setPreviews] = useState<readonly Preview[]>([]);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [journal, setJournal] = useState<JournalState>(EMPTY_JOURNAL);
  const [flow, setFlow] = useState<PhotoFlow>({ phase: "idle" });
  const [deleteCandidate, setDeleteCandidate] = useState<FitnessFileRecord | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const recoveryAction = useRef<HTMLButtonElement>(null);
  const statusHeading = useRef<HTMLElement>(null);
  const keepPhoto = useRef<HTMLButtonElement>(null);
  const backAction = useRef<HTMLButtonElement>(null);
  const deleteOpener = useRef<HTMLButtonElement | null>(null);
  const previewUrls = useRef<string[]>([]);
  const mounted = useRef(false);
  const loadGeneration = useRef(0);
  const initialFocusDone = useRef(false);
  const operationRef = useRef<FitnessFileOperationToken | null>(null);
  const workingWasActive = useRef(false);

  const working = flow.phase === "working";
  const beginWorking = useCallback((action: Extract<PhotoFlow, { phase: "working" }>["action"]) => {
    onBusyChange(true);
    setFlow({ phase: "working", action });
  }, [onBusyChange]);

  const claimOperation = useCallback((action: Extract<PhotoFlow, { phase: "working" }>["action"]) => {
    const token = claimFitnessFileOperation(operationRef);
    if (token) beginWorking(action);
    return token;
  }, [beginWorking]);

  const releaseOperation = useCallback((token: FitnessFileOperationToken) => {
    if (releaseFitnessFileOperation(operationRef, token)) onBusyChange(false);
  }, [onBusyChange]);

  const reloadJournal = useCallback(() => {
    try {
      const next = readFitnessFileOperationJournal();
      setJournal({ ...next, loaded: true });
      onJournalChange?.(next);
      return next;
    } catch {
      const next = { entries: [], unreadable: [], unavailable: true } as const;
      setJournal({ ...next, loaded: true });
      onJournalChange?.(next);
      return next;
    }
  }, [onJournalChange]);

  const load = useCallback(async () => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    if (mounted.current) setLoading(true);
    try {
      const rows = await listFitnessFiles({ entityType: "equipment", entityId: equipment.id });
      const next = await Promise.all(rows.map(async (record): Promise<Preview> => {
        if (record.status !== "ready" || !record.mime_type.startsWith("image/")) return { record, url: null };
        try {
          const blob = await getFitnessFileBlob(record.id);
          return { record, url: URL.createObjectURL(blob) };
        } catch {
          return { record: { ...record, status: "missing" }, url: null };
        }
      }));
      if (!mounted.current || generation !== loadGeneration.current) {
        next.forEach((entry) => { if (entry.url) URL.revokeObjectURL(entry.url); });
        return;
      }
      previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
      previewUrls.current = next.flatMap((entry) => entry.url ? [entry.url] : []);
      setPreviews(next);
      setStale(false);
    } catch (reason) {
      if (mounted.current && generation === loadGeneration.current) setStale(true);
      throw reason;
    } finally {
      if (mounted.current && generation === loadGeneration.current) setLoading(false);
    }
  }, [equipment.id]);

  useEffect(() => {
    mounted.current = true;
    let live = true;
    const timer = window.setTimeout(() => {
      reloadJournal();
      void load().catch((reason) => {
        if (live) setError(`${message(reason)} 已有照片没有被当作空白。`);
      });
    }, 0);
    return () => {
      live = false;
      mounted.current = false;
      loadGeneration.current += 1;
      window.clearTimeout(timer);
      previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
      previewUrls.current = [];
      onBusyChange(false);
    };
  }, [equipment.id, load, onBusyChange, reloadJournal]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(FITNESS_FILE_OPERATION_PREFIX)) {
        reloadJournal();
        if (!operationRef.current) setFlow({ phase: "idle" });
        setStale(true);
        setStatus("另一页的照片操作线索已经变化；这里只重新读取提醒，照片列表需由你确认刷新。");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [reloadJournal]);

  useEffect(() => subscribeFitnessChanges(() => {
    if (!mounted.current) return;
    setStale(true);
    setStatus("另一页可能更新了器材照片；重新读取后再继续改动。");
  }), []);

  useEffect(() => {
    const closeLocked = working || deleteCandidate !== null;
    onBusyChange(closeLocked);
    if (!closeLocked) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [deleteCandidate, onBusyChange, working]);

  const relevantRecoveries = useMemo(() => journal.entries.filter((entry) =>
    entry.ticket.receipt.expectedRow.entity_id === equipment.id), [equipment.id, journal.entries]);
  const activeRecovery = relevantRecoveries[0] ?? null;
  const otherRecoveryCount = journal.entries.length - relevantRecoveries.length;

  useEffect(() => {
    if (!journal.loaded || loading || initialFocusDone.current) return;
    initialFocusDone.current = true;
    const frame = window.requestAnimationFrame(() =>
      (activeRecovery || journal.unavailable || journal.unreadable.length > 0 || stale
        ? recoveryAction.current
        : recoveryOnly
          ? backAction.current
          : input.current)?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [activeRecovery, journal.loaded, journal.unavailable, journal.unreadable.length, loading, recoveryOnly, stale]);

  useEffect(() => {
    if (!deleteCandidate) return;
    const frame = window.requestAnimationFrame(() => keepPhoto.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [deleteCandidate]);

  useEffect(() => {
    if (flow.phase !== "check" && flow.phase !== "decision" && flow.phase !== "changed" && flow.phase !== "refresh-only" && flow.phase !== "reminder-only") return;
    const frame = window.requestAnimationFrame(() => statusHeading.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [flow]);

  useEffect(() => {
    const settled = workingWasActive.current && !working;
    workingWasActive.current = working;
    if (!settled || flow.phase !== "idle") return;
    const frame = window.requestAnimationFrame(() =>
      (recoveryAction.current ?? (recoveryOnly ? backAction.current : input.current))?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [flow.phase, recoveryOnly, working]);

  const reloadAfterJournalChange = useCallback(() => {
    reloadJournal();
  }, [reloadJournal]);

  const finishCommitted = useCallback(async (
    entry: FitnessFileOperationEntry,
    commit: PhotoCommit,
    borrowedToken?: FitnessFileOperationToken,
  ) => {
    const token = borrowedToken ?? claimOperation("refresh");
    if (!token) return;
    const success = commit === "saved"
      ? "照片已经保存并关联到这件器材。"
      : (entry.ticket.kind === "delete-check" || entry.ticket.kind === "delete-committed") && entry.ticket.receipt.expectedFile.state === "absent"
        ? "照片记录已经移除；核对前本地原件就没有读到。器材记录没有改变。"
        : "照片记录和对应的本地原件已经移除。器材记录没有改变。";
    beginWorking("refresh");
    setStatus(success);
    setError("");
    try {
      await load();
      await onChanged();
    } catch {
      if (mounted.current) {
        setStale(true);
        setFlow({
          phase: "refresh-only",
          entry,
          commit,
          message: `${success} 页面暂时没有重新读到最新状态；只需重新读取，不要重复${commit === "saved" ? "选择照片" : "移除"}。`,
        });
      }
      if (!borrowedToken) releaseOperation(token);
      return;
    }
    try {
      if (!await removeFitnessFileOperation(entry)) throw new Error("附件提醒已在另一页变化。");
      reloadAfterJournalChange();
      setStale(false);
      setFlow({ phase: "idle" });
      setStatus(success);
    } catch {
      if (mounted.current) {
        setStale(false);
        setFlow({
          phase: "reminder-only",
          entry,
          commit,
          message: `${success} 照片列表已经是最新；只是核对提醒暂时没有收起，不需要重新读取或重复${commit === "saved" ? "选择照片" : "移除"}。`,
        });
      }
    } finally {
      if (!borrowedToken) releaseOperation(token);
    }
  }, [beginWorking, claimOperation, load, onChanged, releaseOperation, reloadAfterJournalChange]);

  const refreshVisible = useCallback(async () => {
    const token = claimOperation("refresh");
    if (!token) return;
    setError("");
    try {
      await load();
      await onChanged();
      if (mounted.current) {
        setFlow({ phase: "idle" });
        setStatus("照片列表已经重新读取。");
      }
    } catch (reason) {
      if (mounted.current) {
        setStale(true);
        setFlow({ phase: "idle" });
        setError(`${message(reason)} 旧列表仍保留，没有据此重复改动。`);
      }
    } finally {
      releaseOperation(token);
    }
  }, [claimOperation, load, onChanged, releaseOperation]);

  const add = async (file: File | undefined) => {
    if (!file) return;
    const token = claimOperation("prepare-save");
    if (!token) return;
    let entry: FitnessFileOperationEntry | null = null;
    setStatus(""); setError("");
    try {
      const inputValue = { entityType: "equipment", entityId: equipment.id, purpose: "photo", file } as const;
      const receipt = await prepareFitnessFileSave(inputValue);
      entry = await persistFitnessFileOperation(createFitnessFileSaveTicket(receipt));
      reloadJournal();
      beginWorking("save");
      const locked = await runWithCurrentFitnessFileOperation(entry, async (lease) => {
        const result = await saveFitnessFileSafely(inputValue, receipt);
        if (result.outcome !== "outcome_uncertain") lease.committed();
        return result;
      });
      if (locked.outcome === "stale") {
        reloadJournal();
        setStale(true);
        setFlow({ phase: "idle" });
        setStatus("另一页已经处理了这条保存线索；没有从这个页面重复写入。");
        return;
      }
      const result = locked.value;
      if (result.outcome === "outcome_uncertain") {
        setFlow({ phase: "check", entry, message: "照片保存结果暂时无法确认。先只核对，不会重复保存。" });
        return;
      }
      if (!locked.entry) throw new Error("照片已经保存，但浏览器没有保留刷新线索。");
      entry = locked.entry;
      reloadJournal();
      await finishCommitted(entry, "saved", token);
    } catch (reason) {
      if (!mounted.current) return;
      if (entry) {
        setFlow({ phase: "check", entry, message: "照片保存结果需要核对。核对动作不会重做保存。" });
        setError(`${message(reason)} 收据仍保留，请先核对结果。`);
      } else {
        setFlow({ phase: "idle" });
        setError(`${message(reason)} 没有开始写入照片。`);
      }
    } finally {
      if (input.current) input.current.value = "";
      releaseOperation(token);
    }
  };

  const remove = async (record: FitnessFileRecord) => {
    const token = claimOperation("prepare-delete");
    if (!token) return;
    setDeleteCandidate(null);
    let entry: FitnessFileOperationEntry | null = null;
    setStatus(""); setError("");
    try {
      const receipt = await prepareFitnessFileDelete(record.id);
      if (!receipt) {
        setStale(true);
        setFlow({ phase: "idle" });
        setStatus("这张照片已不在最新记录里；重新读取即可，不会重复移除。");
        return;
      }
      entry = await persistFitnessFileOperation(createFitnessFileDeleteTicket(receipt));
      reloadJournal();
      beginWorking("delete");
      const locked = await runWithCurrentFitnessFileOperation(entry, async (lease) => {
        const result = await deleteFitnessFileSafely(receipt);
        if (result.outcome === "deleted" || result.outcome === "already_deleted") lease.committed();
        return result;
      });
      if (locked.outcome === "stale") {
        reloadJournal();
        setStale(true);
        setFlow({ phase: "idle" });
        setStatus("另一页已经处理了这条移除线索；没有从这个页面重复移除。");
        return;
      }
      const result = locked.value;
      if (result.outcome === "outcome_uncertain") {
        setFlow({ phase: "check", entry, message: "照片移除结果暂时无法确认。先只核对，不会重复移除。" });
        return;
      }
      if (result.outcome === "conflict") {
        setFlow({ phase: "changed", entry, message: "照片或适练数据版本已经变化；没有删除现在的内容。" });
        return;
      }
      if (!locked.entry) throw new Error("照片已经移除，但浏览器没有保留刷新线索。");
      entry = locked.entry;
      reloadJournal();
      await finishCommitted(entry, "deleted", token);
    } catch (reason) {
      if (!mounted.current) return;
      if (entry) {
        setFlow({ phase: "check", entry, message: "照片移除结果需要核对。核对动作不会重复移除。" });
        setError(`${message(reason)} 收据仍保留，请先核对结果。`);
      } else {
        setFlow({ phase: "idle" });
        setError(`${message(reason)} 没有开始移除照片。`);
      }
    } finally {
      releaseOperation(token);
    }
  };

  const inspectRecovery = async (entry: FitnessFileOperationEntry) => {
    const ticket = entry.ticket;
    const token = claimOperation("inspect");
    if (!token) return;
    setError("");
    try {
      const locked = await runWithCurrentFitnessFileOperation(entry, async (lease) => {
        if (ticket.kind === "save-check" || ticket.kind === "save-committed") {
          const inspection = await inspectFitnessFileSave(ticket.receipt);
          if (ticket.kind === "save-check" && inspection === "exact_saved") lease.committed();
          if (ticket.kind === "save-check" && inspection === "absent") lease.remove();
          return { kind: "save", inspection, wasCommitted: ticket.kind === "save-committed" } as const;
        }
        const inspection = await inspectFitnessFileDelete(ticket.receipt);
        if (ticket.kind === "delete-check" && inspection === "absent") lease.committed();
        return { kind: "delete", inspection, wasCommitted: ticket.kind === "delete-committed" } as const;
      });
      if (locked.outcome === "stale") {
        reloadJournal();
        setStale(true);
        setFlow({ phase: "idle" });
        setStatus("另一页已经处理了这条核对线索；这个页面没有重做任何动作。");
        return;
      }
      const result = locked.value;
      if (result.kind === "save") {
        const inspection = result.inspection;
        if (result.wasCommitted && inspection !== "exact_saved") {
          setFlow({ phase: "changed", entry, message: "这次保存曾经确认完成，但当前数据版本或照片归属后来已经变化；旧收据没有改动现在的内容。" });
          return;
        }
        if (inspection === "exact_saved") {
          if (!locked.entry) throw new Error("保存事实已确认，但浏览器没有保留刷新线索。");
          reloadJournal();
          return void await finishCommitted(locked.entry, "saved", token);
        }
        if (inspection === "staged") {
          setFlow({ phase: "decision", entry, decision: "save-staged", message: "照片原件已完整写入，但还没有关联到器材。可以继续关联，或只清理这次收据所属的暂存。" });
          return;
        }
        if (inspection === "absent") {
          reloadJournal();
          setFlow({ phase: "idle" });
          setStatus("照片没有写入，可以重新选择。");
          return;
        }
        if (inspection === "conflict" || inspection === "generation_changed") {
          setFlow({ phase: "changed", entry, message: "适练数据或附件归属已经变化；这张旧收据没有改动现在的内容。" });
          return;
        }
        setFlow({ phase: "check", entry, message: "现在仍无法确认保存结果。可以稍后再次只做核对。" });
        return;
      }
      const inspection = result.inspection;
      if (result.wasCommitted && inspection !== "absent") {
        setFlow({ phase: "changed", entry, message: "这次移除曾经确认完成，但当前数据版本或照片归属后来已经变化；旧收据没有删除现在的内容。" });
        return;
      }
      if (inspection === "absent") {
        if (!locked.entry) throw new Error("移除事实已确认，但浏览器没有保留刷新线索。");
        reloadJournal();
        return void await finishCommitted(locked.entry, "deleted", token);
      }
      if (inspection === "exact_present") {
        setFlow({ phase: "decision", entry, decision: "delete-present", message: "照片记录与原件都仍在；刚才没有开始移除。" });
        return;
      }
      if (inspection === "deleting") {
        setFlow({ phase: "decision", entry, decision: "delete-finishing", message: "移除已经开始，但最后结果还没有确认。" });
        return;
      }
      if (inspection === "conflict" || inspection === "generation_changed") {
        setFlow({ phase: "changed", entry, message: "适练数据或照片已经变化；这张旧收据没有删除现在的内容。" });
        return;
      }
      setFlow({ phase: "check", entry, message: "现在仍无法确认移除结果。可以稍后再次只做核对。" });
    } catch (reason) {
      if (mounted.current) {
        setFlow({ phase: "check", entry, message: "结果暂时没有核对清楚；没有因此重做保存或移除。" });
        setError(message(reason));
      }
    } finally {
      releaseOperation(token);
    }
  };

  const resumeSave = async (entry: FitnessFileOperationEntry) => {
    const ticket = entry.ticket;
    if (ticket.kind !== "save-check") return;
    const token = claimOperation("resume");
    if (!token) return;
    setError("");
    try {
      const locked = await runWithCurrentFitnessFileOperation(entry, async (lease) => {
        const result = await resumeFitnessFileSave(ticket.receipt);
        if (result.outcome !== "outcome_uncertain") lease.committed();
        return result;
      });
      if (locked.outcome === "stale") {
        reloadJournal();
        setStale(true);
        setFlow({ phase: "idle" });
        setStatus("另一页已经处理了这条核对线索；没有重复关联照片。");
        return;
      }
      const result = locked.value;
      if (result.outcome === "outcome_uncertain") {
        setFlow({ phase: "check", entry, message: "照片关联结果仍待核对；不会重复写入原件。" });
        return;
      }
      if (!locked.entry) throw new Error("照片已关联，但浏览器没有保留刷新线索。");
      reloadJournal();
      await finishCommitted(locked.entry, "saved", token);
    } catch (reason) {
      if (mounted.current) {
        setFlow({ phase: "check", entry, message: "照片关联结果需要再次核对。" });
        setError(message(reason));
      }
    } finally {
      releaseOperation(token);
    }
  };

  const discardSave = async (entry: FitnessFileOperationEntry) => {
    const ticket = entry.ticket;
    if (ticket.kind !== "save-check") return;
    const token = claimOperation("discard");
    if (!token) return;
    setError("");
    try {
      const locked = await runWithCurrentFitnessFileOperation(entry, async (lease) => {
        const result = await discardFitnessFileSave(ticket.receipt);
        if (result.outcome === "discarded" || result.outcome === "already_absent") lease.remove();
        if (result.outcome === "blocked" && result.reason === "saved") lease.committed();
        return result;
      });
      if (locked.outcome === "stale") {
        reloadJournal();
        setStale(true);
        setFlow({ phase: "idle" });
        setStatus("另一页已经处理了这条核对线索；没有清理任何额外内容。");
        return;
      }
      const result = locked.value;
      if (result.outcome === "discarded" || result.outcome === "already_absent") {
        reloadJournal();
        setFlow({ phase: "idle" });
        setStatus("这次未完成的照片保存已放弃；没有改动器材记录。");
        return;
      }
      if (result.outcome === "blocked") {
        if (result.reason === "saved") {
          if (!locked.entry) throw new Error("保存事实已确认，但浏览器没有保留刷新线索。");
          reloadJournal();
          return void await finishCommitted(locked.entry, "saved", token);
        }
        setFlow({ phase: "changed", entry, message: "数据版本或附件归属已经变化；没有清理可能属于当前内容的原件。" });
        return;
      }
      setFlow({ phase: "check", entry, message: "暂存清理结果仍待核对；没有盲目删除原件。" });
    } catch (reason) {
      if (mounted.current) {
        setFlow({ phase: "check", entry, message: "暂存清理结果需要再次核对。" });
        setError(message(reason));
      }
    } finally {
      releaseOperation(token);
    }
  };

  const continueDelete = async (entry: FitnessFileOperationEntry) => {
    const ticket = entry.ticket;
    if (ticket.kind !== "delete-check") return;
    const token = claimOperation("delete");
    if (!token) return;
    setError("");
    try {
      const locked = await runWithCurrentFitnessFileOperation(entry, async (lease) => {
        const result = await deleteFitnessFileSafely(ticket.receipt);
        if (result.outcome === "deleted" || result.outcome === "already_deleted") lease.committed();
        return result;
      });
      if (locked.outcome === "stale") {
        reloadJournal();
        setStale(true);
        setFlow({ phase: "idle" });
        setStatus("另一页已经处理了这条核对线索；没有重复移除照片。");
        return;
      }
      const result = locked.value;
      if (result.outcome === "outcome_uncertain") {
        setFlow({ phase: "check", entry, message: "照片移除结果仍待核对。" });
        return;
      }
      if (result.outcome === "conflict") {
        setFlow({ phase: "changed", entry, message: "照片或数据版本已经变化；没有删除现在的内容。" });
        return;
      }
      if (!locked.entry) throw new Error("照片已移除，但浏览器没有保留刷新线索。");
      reloadJournal();
      await finishCommitted(locked.entry, "deleted", token);
    } catch (reason) {
      if (mounted.current) {
        setFlow({ phase: "check", entry, message: "照片移除结果需要再次核对。" });
        setError(message(reason));
      }
    } finally {
      releaseOperation(token);
    }
  };

  const keepExistingPhoto = async (entry: FitnessFileOperationEntry) => {
    const token = claimOperation("journal");
    if (!token) return;
    try {
      const locked = await runWithCurrentFitnessFileOperation(entry, (lease) => lease.remove());
      if (locked.outcome === "stale") {
        reloadJournal();
        setStale(true);
        setFlow({ phase: "idle" });
        setStatus("另一页先处理了这条线索；无法再承诺照片仍保留，请重新读取。");
        return;
      }
      reloadJournal();
      setFlow({ phase: "idle" });
      setStatus("照片完整保留，没有继续移除。");
    } catch (reason) {
      setFlow({ phase: "check", entry, message: "照片仍完整保留；核对提醒暂时没有收起。" });
      setError(message(reason));
    } finally {
      releaseOperation(token);
    }
  };

  const clearChangedReminder = async (entry: FitnessFileOperationEntry) => {
    const token = claimOperation("journal");
    if (!token) return;
    try {
      const locked = await runWithCurrentFitnessFileOperation(entry, (lease) => lease.remove());
      if (locked.outcome === "stale") {
        reloadJournal();
        setStale(true);
        setFlow({ phase: "idle" });
        setStatus("提醒已在另一页变化；没有清理任何本地原件。");
        return;
      }
      reloadJournal();
      setFlow({ phase: "idle" });
      setStale(true);
      setStatus("只清除了旧提醒；可能存在的旧原件保持原样。重新读取后再继续改动。");
    } catch (reason) {
      setFlow({ phase: "changed", entry, message: "当前内容保持不变；旧提醒暂时没有收起。" });
      setError(message(reason));
    } finally {
      releaseOperation(token);
    }
  };

  const clearCommittedReminder = async (entry: FitnessFileOperationEntry, commit: PhotoCommit) => {
    const token = claimOperation("journal");
    if (!token) return;
    try {
      if (!await removeFitnessFileOperation(entry)) {
        reloadJournal();
        setFlow({ phase: "idle" });
        setStale(true);
        setStatus("核对提醒已在另一页变化；照片列表需重新读取，但不会重复改动。");
        return;
      }
      reloadJournal();
      setFlow({ phase: "idle" });
      setStatus(`${commit === "saved" ? "照片已保存" : "照片已移除"}；核对提醒也已经收起。`);
    } catch (reason) {
      setFlow({ phase: "reminder-only", entry, commit, message: "照片列表已经是最新；只是核对提醒暂时没有收起。" });
      setError(message(reason));
    } finally {
      releaseOperation(token);
    }
  };

  const clearUnreadable = async () => {
    const token = claimOperation("journal");
    if (!token) return;
    try {
      const results = await Promise.all(journal.unreadable.map(removeFitnessFileOperation));
      reloadJournal();
      if (results.some((result) => !result)) throw new Error("有提醒已在另一页变化，请重新检查。");
      setFlow({ phase: "idle" });
      setStatus("只清除了无法验证的提醒；没有据此保存或删除任何照片。");
    } catch (reason) {
      reloadJournal();
      setFlow({ phase: "idle" });
      setError(message(reason));
    } finally {
      releaseOperation(token);
    }
  };

  const recoveryEntry = flow.phase === "working"
    ? null
    : flow.phase === "check" || flow.phase === "decision" || flow.phase === "changed" || flow.phase === "refresh-only" || flow.phase === "reminder-only"
    ? flow.entry
    : activeRecovery;
  const recoveryCommitted = recoveryEntry?.ticket.kind === "save-committed" || recoveryEntry?.ticket.kind === "delete-committed";
  const recoveryCommit: PhotoCommit | null = recoveryEntry?.ticket.kind === "save-committed"
    ? "saved"
    : recoveryEntry?.ticket.kind === "delete-committed"
      ? "deleted"
      : null;
  const recoveryMessage = flow.phase === "check" || flow.phase === "decision" || flow.phase === "changed" || flow.phase === "refresh-only" || flow.phase === "reminder-only"
    ? flow.message
    : recoveryEntry
      ? recoveryCommitted
        ? `上次${recoveryCommit === "saved" ? "保存" : "移除"}曾经确认完成；先只核对它是否仍属于当前数据版本，不会重做动作。`
        : `上次${recoveryEntry.ticket.kind === "save-check" ? "保存" : "移除"}没有留下可确认的页面结果。先只核对，不会重做动作。`
      : "";
  const actionsLocked = loading || stale || working || deleteCandidate !== null ||
    !journal.loaded || journal.unavailable || journal.unreadable.length > 0 || relevantRecoveries.length > 0;
  const showUnreadable = !journal.unavailable && journal.unreadable.length > 0;
  const showRecovery = !working && !journal.unavailable && !showUnreadable && Boolean(recoveryEntry);
  const showStale = !working && !journal.unavailable && !showUnreadable && !showRecovery && stale;

  return <div className="sl-file-panel" aria-busy={loading || working}>
    <p className="sl-safety-copy">照片保存在当前完整网址 <strong>{currentOrigin || "正在确认当前网址…"}</strong> 与当前浏览器资料（profile）共同对应的本地适练空间。两者任一不同，看到的就不是同一套照片；不会发送给 AI。支持 JPEG、PNG、WebP、HEIC，单张不超过 20 MiB。</p>
    {recoveryOnly && <p className="sl-file-recovery-mode">这里只处理已留下的核对线索，不会新增照片，也不会因为打开面板就自动继续保存或移除。</p>}
    {journal.unavailable && <section className="sl-file-recovery warning" role="status"><div><b>暂时无法安全协调附件操作</b><p>浏览器没有提供可用的跨页面锁或核对存储。新保存与移除先停用；已核对的现有照片仍可打开。</p></div><button ref={recoveryAction} onClick={reloadJournal}>重新检查</button></section>}
    {working && <p className="sl-file-working" role="status">{flow.action === "refresh" ? "正在重新读取照片状态…" : flow.action === "inspect" ? "正在只读核对结果…" : flow.action === "journal" ? "正在更新核对提醒…" : "正在安全处理照片，请保持此页打开…"}</p>}
    {showUnreadable && <section className="sl-file-recovery warning" role="status"><div><b>有 {journal.unreadable.length} 条旧的附件提醒无法验证</b><p>系统没有据此保存或删除照片。可以保留所有本地内容，只清除这些不可用提醒。</p></div><button ref={recoveryAction} onClick={() => void clearUnreadable()}>保留内容并清除提醒</button></section>}
    {showStale && <section className="sl-file-recovery" role="status"><div><b>照片列表需要重新读取</b><p>刚才的操作可能已经完成；读取最新状态前不会重复保存或移除。</p></div><button ref={recoveryAction} disabled={working} onClick={() => void refreshVisible()}>{working ? "正在读取…" : "重新读取"}</button></section>}
    {showRecovery && recoveryEntry && <section className={`sl-file-recovery ${flow.phase === "changed" ? "warning" : ""}`} aria-live="polite"><div><b ref={statusHeading} tabIndex={-1}>{flow.phase === "reminder-only" ? "照片列表已更新，提醒待收起" : flow.phase === "refresh-only" ? "照片事实已确认，页面待刷新" : flow.phase === "idle" && recoveryCommitted ? "已完成的操作待与当前版本核对" : flow.phase === "decision" ? "核对后需要你的选择" : flow.phase === "changed" ? "当前内容已经变化" : "有一条照片操作需要核对"}</b><p>{recoveryMessage}</p>{relevantRecoveries.length > 1 && <small>这件器材另有 {relevantRecoveries.length - 1} 条独立核对线索，会逐条显示。</small>}</div><div className="sl-file-recovery-actions">
      {(flow.phase === "idle" || flow.phase === "check") && !recoveryCommitted && <button ref={recoveryAction} disabled={working} onClick={() => void inspectRecovery(recoveryEntry)}>核对结果</button>}
      {flow.phase === "idle" && recoveryCommitted && <button ref={recoveryAction} onClick={() => void inspectRecovery(recoveryEntry)}>只核对当前版本</button>}
      {flow.phase === "decision" && flow.decision === "save-staged" && <><button onClick={() => void resumeSave(flow.entry)}>继续关联照片</button><button className="danger" onClick={() => void discardSave(flow.entry)}>放弃并清理暂存</button></>}
      {flow.phase === "decision" && flow.decision === "delete-present" && <><button onClick={() => void continueDelete(flow.entry)}>继续移除</button><button onClick={() => void keepExistingPhoto(flow.entry)}>保留照片并结束</button></>}
      {flow.phase === "decision" && flow.decision === "delete-finishing" && <button onClick={() => void continueDelete(flow.entry)}>继续收尾</button>}
      {flow.phase === "changed" && <button onClick={() => void clearChangedReminder(flow.entry)}>保留可能的旧原件并清除提醒</button>}
      {flow.phase === "refresh-only" && <button onClick={() => void finishCommitted(flow.entry, flow.commit)}>只重新读取</button>}
      {flow.phase === "reminder-only" && <button onClick={() => void clearCommittedReminder(flow.entry, flow.commit)}>只收起核对提醒</button>}
    </div></section>}
    {recoveryOnly && !showRecovery && !showUnreadable && !journal.unavailable && otherRecoveryCount > 0 && <section className="sl-file-recovery" role="status"><div><b>这件器材的线索已经处理到当前状态</b><p>另有 {otherRecoveryCount} 条属于其他器材的独立线索；返回后由你逐条打开。</p></div><button ref={recoveryAction} onClick={onBack}>返回待核对列表</button></section>}
    {deleteCandidate && <section className="sl-file-delete-confirm" aria-labelledby="sl-file-delete-title"><div><b id="sl-file-delete-title">移除「{deleteCandidate.file_name}」？</b><p>会移除适练里的照片记录与它对应的本地原件；器材记录、档位和备注保持不变。</p></div><div><button ref={keepPhoto} onClick={() => { onBusyChange(false); setDeleteCandidate(null); window.requestAnimationFrame(() => deleteOpener.current?.focus({ preventScroll: true })); }}>保留照片</button><button className="danger" onClick={() => void remove(deleteCandidate)}>确认移除</button></div></section>}
    {!recoveryOnly && <div className={`sl-file-actions ${actionsLocked ? "disabled" : ""}`}><input ref={input} disabled={actionsLocked} aria-label={`为${equipment.name}选择器材照片`} type="file" accept=".jpg,.jpeg,.png,.webp,.heic,image/jpeg,image/png,image/webp,image/heic" onChange={(event) => void add(event.target.files?.[0])}/><span>{working && (flow.action === "prepare-save" || flow.action === "save") ? "正在核验并保存…" : actionsLocked ? "先完成上方核对或重新读取" : "选择一张器材照片"}</span></div>}
    {previews.length > 0 ? <div className="sl-file-grid">{previews.map((preview) => <article key={preview.record.id}>{preview.url ? <a className="sl-file-preview" href={preview.url} target="_blank" rel="noreferrer" aria-label={`打开${preview.record.file_name}原图`}><Image unoptimized width={640} height={420} src={preview.url} alt={`${equipment.name}：${preview.record.file_name}`}/></a> : <div className="sl-file-missing">{fileAvailability(preview)}</div>}<footer><span><b>{preview.record.file_name}</b><small>{formatFitnessFileByteSize(preview.record.byte_size)} · {fileAvailability(preview)}</small></span>{!recoveryOnly && <button aria-label={`移除${preview.record.file_name}的本地照片`} disabled={actionsLocked} onClick={(event) => { onBusyChange(true); deleteOpener.current = event.currentTarget; setDeleteCandidate(preview.record); }}>移除</button>}</footer></article>)}</div> : <div className="sl-file-empty" role="status">{loading ? "正在读取本地照片…" : stale ? "旧列表没有显示照片；重新读取前不会把它当成空白。" : recoveryOnly ? "当前没有可显示的照片记录；上方核对线索仍按其自身收据判断。" : "还没有照片。没有照片不会影响器材规划。"}</div>}
    {status && <p className="sl-data-status" role="status">{status}</p>}
    {error && <p className="sl-form-error" role="alert">{error}</p>}
    <div className="sl-file-panel-footer"><button ref={backAction} type="button" disabled={working || deleteCandidate !== null} onClick={onBack}>{recoveryOnly ? "返回待核对列表" : "返回器材信息"}</button></div>
  </div>;
}

export function FitnessDataControls({ onRestored }: { onRestored: () => Promise<void> }) {
  const [status, setStatus] = useState("");

  const exportBackup = async (): Promise<string> => {
    const result = await exportCompleteFitnessBackup();
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return `完整备份已交给浏览器下载，包含 ${result.fileCount} 个已校验附件；请确认下载目录中出现文件。`;
  };

  return <div className="sl-data-controls">
    <FitnessBackupFlow
      onExport={exportBackup}
      onRefreshActivated={onRestored}
      onNotice={setStatus}
    />
    <p>完整备份是未加密的私人文件，包含 SQLite 数据与已校验附件，不含 DeepSeek Key。请保存在受信任的位置；选择恢复文件后，只有你确认启用才会切换。</p>
    {status && <p className="sl-data-status" role="status">{status}</p>}
  </div>;
}
