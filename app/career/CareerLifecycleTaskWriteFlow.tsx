"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  commitCareerLifecycleWrite,
  inspectCareerLifecycleWrite,
  prepareCareerLifecycleWrite,
  previewCareerLifecycleWrite,
  type CareerLifecycleDisplayedExpected,
  type CareerLifecycleWriteChoice,
  type CareerLifecycleWriteIntent,
  type CareerLifecycleWritePreview,
} from "@/lib/career/lifecycle-writes";
import {
  commitCareerTaskWrite,
  inspectCareerTaskWrite,
  prepareCareerTaskComplete,
  prepareCareerTaskCreate,
  type CareerTaskCreateExpectedContext,
  type CareerTaskWriteExpectedState,
  type CareerTaskWriteReceipt,
  type CreateCareerTaskWriteInput,
} from "@/lib/career/task-writes";
import {
  careerLifecycleTaskRecoveryAttention,
  type CareerDatabaseMutationToken,
} from "./core-write-state";
import {
  CAREER_CONTACT_IMPORT_MATERIAL_WRITE_PREFIX,
  CAREER_LIFECYCLE_TASK_WRITE_PREFIX,
} from "./core-write-journal";
import {
  careerLifecycleTaskHeldBarrier,
  createCareerLifecycleTaskWriteEntry,
  createCareerLifecycleTaskWriteTicket,
  persistCareerLifecycleTaskWrite,
  readCareerLifecycleTaskWriteJournal,
  removeUnreadableCareerLifecycleTaskWrite,
  runWithCurrentCareerLifecycleTaskWrite,
  runWithMissingCareerLifecycleTaskWrite,
  type CareerLifecycleTaskWriteEntry,
  type CareerLifecycleTaskWriteJournal,
  type CareerLifecycleTaskWriteLease,
  type CareerLifecycleTaskWriteReceipt,
} from "./lifecycle-task-write-journal";

type RefreshOutcome = "applied" | "superseded" | "deferred";
type JournalView = CareerLifecycleTaskWriteJournal & Readonly<{ loaded: boolean }>;
export type CareerLifecycleTaskFlowState =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "working"; action: "prepare" | "commit" | "inspect" | "refresh" | "journal" }>
  | Readonly<{
      phase: "check" | "expected" | "changed" | "refresh-only" | "invalid";
      entry: CareerLifecycleTaskWriteEntry;
      message: string;
    }>;

export type CareerLifecycleTaskSubmitResult =
  | Readonly<{ outcome: "saved"; entityId: string; receipt: CareerLifecycleTaskWriteReceipt }>
  | Readonly<{ outcome: "changed"; entityId: string; receipt: CareerLifecycleTaskWriteReceipt }>
  | Readonly<{ outcome: "preview-changed"; preview: CareerLifecycleWritePreview }>
  | Readonly<{ outcome: "attention"; entityId: string | null }>
  | Readonly<{ outcome: "blocked"; entityId: null }>;

const EMPTY_JOURNAL: JournalView = {
  loaded: false,
  entries: [],
  peerEntries: [],
  unreadable: [],
  storageUnavailable: false,
  lockUnavailable: false,
};

function messageOf(reason: unknown) {
  return reason instanceof Error
    ? reason.message
    : "这次职位/待办操作没有完成；现有资料没有被静默覆盖。";
}

function entityId(receipt: CareerLifecycleTaskWriteReceipt) {
  if (receipt.purpose === "career-lifecycle-write") return receipt.before.job.id;
  return receipt.kind === "task-create" ? receipt.after.task.id : receipt.before.task.id;
}

function label(receipt: CareerLifecycleTaskWriteReceipt) {
  if (receipt.purpose === "career-lifecycle-write") return "职位状态";
  return receipt.kind === "task-create" ? "新待办" : "待办状态";
}

function phaseFor(entry: CareerLifecycleTaskWriteEntry): CareerLifecycleTaskFlowState {
  if (entry.ticket.kind === "committed") return {
    phase: "refresh-only", entry,
    message: `${label(entry.ticket.receipt)}已经确认写入；这里只会重新读取，不会再次提交。`,
  };
  if (entry.ticket.kind === "changed") return {
    phase: "changed", entry,
    message: "相关资料已经变化；旧动作不会覆盖当前内容，也不会再次提交。",
  };
  return {
    phase: "check", entry,
    message: "这次写入结果还没有确认。先只读核对，不会重复写入。",
  };
}

export function useCareerLifecycleTaskWriteFlow({
  refresh,
  snapshotStale,
  snapshotStaleNow,
  externalBlockedNow,
  claimDatabaseMutation,
  releaseDatabaseMutation,
  databaseMutationActiveExcept,
  dirtyEditorCount,
  onToast,
  onAttention,
}: {
  refresh: () => Promise<RefreshOutcome>;
  snapshotStale: boolean;
  snapshotStaleNow: () => boolean;
  externalBlockedNow: () => boolean;
  claimDatabaseMutation: (owner: "lifecycle" | "task") => CareerDatabaseMutationToken | null;
  releaseDatabaseMutation: (token: CareerDatabaseMutationToken) => void;
  databaseMutationActiveExcept: (owner: "lifecycle" | "task") => boolean;
  dirtyEditorCount: number;
  onToast: (message: string) => void;
  onAttention: () => void;
}) {
  const [journal, setJournal] = useState<JournalView>(EMPTY_JOURNAL);
  const [flow, setFlow] = useState<CareerLifecycleTaskFlowState>({ phase: "idle" });
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [heldEntries, setHeldEntries] = useState<readonly CareerLifecycleTaskWriteEntry[]>([]);
  const [focusRequest, setFocusRequest] = useState(0);
  const [lifecyclePreviewActive, setLifecyclePreviewActive] = useState(false);
  const journalRef = useRef<JournalView>(EMPTY_JOURNAL);
  const heldRef = useRef(new Map<string, CareerLifecycleTaskWriteEntry>());
  const operationRef = useRef(false);
  const lifecyclePreviewOperationRef = useRef<string | null>(null);
  const triggerRef = useRef(new Map<string, HTMLElement>());
  const focusFrameRef = useRef<number | null>(null);
  const pendingAttentionFocusRef = useRef(false);
  const attentionRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const snapshotStaleNowRef = useRef(snapshotStaleNow);
  const dirtyCountRef = useRef(dirtyEditorCount);

  useLayoutEffect(() => {
    snapshotStaleNowRef.current = snapshotStaleNow;
    dirtyCountRef.current = dirtyEditorCount;
  }, [dirtyEditorCount, snapshotStaleNow]);

  const barrier = careerLifecycleTaskHeldBarrier(
    heldEntries.map((entry) => entry.ticket.receipt.operationId),
    journal.entries.map((entry) => entry.ticket.receipt.operationId),
  );
  const hasRecoveryAttention = careerLifecycleTaskRecoveryAttention({
    heldReceiptCount: heldEntries.length,
    journalEntryCount: journal.entries.length,
    peerEntryCount: journal.peerEntries.length,
    unreadableCount: journal.unreadable.length,
    storageUnavailable: journal.storageUnavailable,
    lockUnavailable: journal.lockUnavailable,
  });
  const busy = flow.phase === "working";
  const databaseMutationLocked = busy || barrier.blocksWrites || !journal.loaded ||
    journal.storageUnavailable || journal.lockUnavailable ||
    journal.unreadable.length > 0 || journal.entries.length > 0 ||
    journal.peerEntries.length > 0 || snapshotStale;
  const hasVolatileWork = busy || barrier.volatile || lifecyclePreviewActive;

  const reload = useCallback(() => {
    let next: CareerLifecycleTaskWriteJournal;
    try { next = readCareerLifecycleTaskWriteJournal(); }
    catch {
      next = {
        entries: [], peerEntries: [], unreadable: [],
        storageUnavailable: true,
        lockUnavailable: typeof navigator === "undefined" || !navigator.locks,
      };
    }
    const loaded = { ...next, loaded: true };
    journalRef.current = loaded;
    if (mountedRef.current) setJournal(loaded);
    return next;
  }, []);

  const hold = useCallback((entry: CareerLifecycleTaskWriteEntry) => {
    heldRef.current.set(entry.ticket.receipt.operationId, entry);
    setHeldEntries([...heldRef.current.values()]);
  }, []);

  const clearHeld = useCallback((entry: CareerLifecycleTaskWriteEntry) => {
    heldRef.current.delete(entry.ticket.receipt.operationId);
    setHeldEntries([...heldRef.current.values()]);
  }, []);

  const latest = useCallback(() => {
    const scan = reload();
    for (const held of heldRef.current.values()) {
      return scan.entries.find((entry) => entry.storageKey !== held.storageKey) ??
        scan.entries.find((entry) => entry.storageKey === held.storageKey) ?? held;
    }
    return scan.entries[0] ?? null;
  }, [reload]);

  const present = useCallback((next: CareerLifecycleTaskFlowState) => {
    if ("entry" in next) hold(next.entry);
    setFlow(next);
    pendingAttentionFocusRef.current = true;
    setFocusRequest((value) => value + 1);
    onAttention();
  }, [hold, onAttention]);

  useEffect(() => {
    mountedRef.current = true;
    const scan = () => {
      const next = latest();
      if (!operationRef.current) setFlow(next ? phaseFor(next) : { phase: "idle" });
    };
    scan();
    const storage = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage &&
        (event.key === null || event.key.startsWith(CAREER_LIFECYCLE_TASK_WRITE_PREFIX) ||
          event.key.startsWith("career.core-write.v1:") ||
          event.key.startsWith(CAREER_CONTACT_IMPORT_MATERIAL_WRITE_PREFIX))) scan();
    };
    const visible = () => { if (document.visibilityState === "visible") scan(); };
    window.addEventListener("storage", storage);
    window.addEventListener("focus", scan);
    document.addEventListener("visibilitychange", visible);
    return () => {
      mountedRef.current = false;
      if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
      window.removeEventListener("storage", storage);
      window.removeEventListener("focus", scan);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [latest]);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      const current = journalRef.current;
      const heldBarrier = careerLifecycleTaskHeldBarrier(
        heldRef.current.keys(),
        current.entries.map((entry) => entry.ticket.receipt.operationId),
      );
      if (operationRef.current || heldBarrier.volatile || dirtyCountRef.current > 0) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);

  useEffect(() => {
    if (focusRequest === 0) return;
    let frame: number | null = null;
    const focusWhenClear = () => {
      if (!pendingAttentionFocusRef.current || document.querySelector('[aria-modal="true"]')) return;
      pendingAttentionFocusRef.current = false;
      frame = window.requestAnimationFrame(() =>
        attentionRef.current?.focus({ preventScroll: true }));
    };
    focusWhenClear();
    const observer = new MutationObserver(focusWhenClear);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal"] });
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [focusRequest]);

  const restoreTrigger = useCallback((receipt: CareerLifecycleTaskWriteReceipt) => {
    const trigger = triggerRef.current.get(receipt.operationId) ?? null;
    triggerRef.current.delete(receipt.operationId);
    if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = window.requestAnimationFrame(() => {
        focusFrameRef.current = null;
        if (trigger?.isConnected && !trigger.matches(":disabled") &&
          trigger.getClientRects().length > 0) {
          trigger.focus({ preventScroll: true });
          return;
        }
        document.querySelector<HTMLElement>(
          "[data-career-lifecycle-task-focus]:not(:disabled), #career-page-title",
        )?.focus({ preventScroll: true });
      });
    });
  }, []);

  const removeCurrent = useCallback(async (entry: CareerLifecycleTaskWriteEntry) => {
    const result = await runWithCurrentCareerLifecycleTaskWrite(entry, (lease) => lease.remove());
    reload();
    return result.outcome;
  }, [reload]);

  const finish = useCallback(async (
    entry: CareerLifecycleTaskWriteEntry,
    reason: "committed" | "changed",
  ): Promise<CareerLifecycleTaskSubmitResult> => {
    const receipt = entry.ticket.receipt;
    setError("");
    setFlow({ phase: "working", action: "refresh" });
    setStatus(reason === "committed" ? "写入已确认，正在重新读取…" : "资料已变化，正在重新读取…");
    try {
      const outcome = await refresh();
      if (outcome !== "applied") {
        present({
          phase: reason === "committed" ? "refresh-only" : "changed",
          entry,
          message: reason === "committed"
            ? "写入已经确认；页面尚未应用最新读取。这里只会继续刷新。"
            : "资料已经变化；页面尚未应用最新读取。",
        });
        return { outcome: "attention", entityId: entityId(receipt) };
      }
      if (await removeCurrent(entry) !== "ran") {
        present(phaseFor(latest() ?? entry));
        return { outcome: "attention", entityId: entityId(receipt) };
      }
      clearHeld(entry);
      setFlow({ phase: "idle" });
      restoreTrigger(receipt);
      if (reason === "committed") {
        const message = `${label(receipt)}已确认保存。`;
        setStatus(message);
        onToast(message);
        return { outcome: "saved", entityId: entityId(receipt), receipt };
      }
      setStatus("资料已在别处变化；旧动作没有覆盖当前内容。");
      return { outcome: "changed", entityId: entityId(receipt), receipt };
    } catch (reasonValue) {
      setError(messageOf(reasonValue));
      present({
        phase: reason === "committed" ? "refresh-only" : "changed",
        entry,
        message: reason === "committed"
          ? "写入已经确认；页面暂时没有重新读取。这里只会继续刷新。"
          : "资料已经变化；等待只读刷新。",
      });
      return { outcome: "attention", entityId: entityId(receipt) };
    }
  }, [clearHeld, latest, onToast, present, refresh, removeCurrent, restoreTrigger]);

  const inspectEntry = useCallback(async (
    entry: CareerLifecycleTaskWriteEntry,
  ): Promise<CareerLifecycleTaskSubmitResult> => {
    setError("");
    setFlow({ phase: "working", action: "inspect" });
    const inspect = entry.ticket.receipt.purpose === "career-lifecycle-write"
      ? inspectCareerLifecycleWrite
      : inspectCareerTaskWrite;
    const operation = async (lease: CareerLifecycleTaskWriteLease) => {
      const result = await inspect(entry.ticket.receipt as never);
      if (result === "exact_saved") lease.committed();
      else if (result === "changed") lease.changed();
      return result;
    };
    let result = await runWithCurrentCareerLifecycleTaskWrite(entry, operation);
    if (result.outcome === "stale") {
      hold(entry);
      result = await runWithMissingCareerLifecycleTaskWrite(entry, operation);
    }
    reload();
    if (result.outcome !== "ran") {
      present({ phase: "check", entry, message: "无法完整验证全部核对提醒；没有调用写入。" });
      return { outcome: "attention", entityId: entityId(entry.ticket.receipt) };
    }
    if (result.value === "exact_saved" && result.entry) return finish(result.entry, "committed");
    if (result.value === "changed" && result.entry) return finish(result.entry, "changed");
    const current = result.entry ?? entry;
    if (result.value === "expected") present({
      phase: "expected", entry: current,
      message: "已确认这次写入尚未提交。可以放弃，或明确继续同一张收据。",
    });
    else if (result.value === "invalid_receipt") present({
      phase: "invalid", entry: current,
      message: "这份收据无法验证；没有据此写入。",
    });
    else present({ phase: "check", entry: current, message: "结果仍无法确认；只允许再次只读核对。" });
    return { outcome: "attention", entityId: entityId(entry.ticket.receipt) };
  }, [finish, hold, present, reload]);

  const commitEntry = useCallback(async (
    entry: CareerLifecycleTaskWriteEntry,
    owner: "lifecycle" | "task",
  ): Promise<CareerLifecycleTaskSubmitResult> => {
    if (databaseMutationActiveExcept(owner) || externalBlockedNow()) {
      present({ phase: "check", entry, message: "另一笔数据库操作已经开始；收据仍保留，没有提交。" });
      return { outcome: "attention", entityId: entityId(entry.ticket.receipt) };
    }
    setFlow({ phase: "working", action: "commit" });
    const commit = entry.ticket.receipt.purpose === "career-lifecycle-write"
      ? commitCareerLifecycleWrite
      : commitCareerTaskWrite;
    try {
      const result = await runWithCurrentCareerLifecycleTaskWrite(entry, async (lease) => {
        if (databaseMutationActiveExcept(owner) || externalBlockedNow()) return "blocked" as const;
        const committed = await commit(entry.ticket.receipt as never);
        if (committed.outcome === "saved" || committed.outcome === "already_saved") {
          lease.committed();
          return "saved" as const;
        }
        if (committed.outcome === "changed") {
          lease.changed();
          return "changed" as const;
        }
        return "uncertain" as const;
      });
      reload();
      if (result.outcome === "stale") return inspectEntry(entry);
      if (result.outcome !== "ran") {
        present({ phase: "check", entry, message: "核对线索暂时无法独占；没有重复提交。" });
        return { outcome: "attention", entityId: entityId(entry.ticket.receipt) };
      }
      if (result.value === "saved" && result.entry) return finish(result.entry, "committed");
      if (result.value === "changed" && result.entry) return finish(result.entry, "changed");
      present({
        phase: result.value === "blocked" ? "check" : "check",
        entry: result.entry ?? entry,
        message: result.value === "blocked"
          ? "另一笔数据库操作已经开始；收据仍保留，没有提交。"
          : "这次结果需要只读核对；不会凭猜测重复提交。",
      });
      return { outcome: "attention", entityId: entityId(entry.ticket.receipt) };
    } catch (reason) {
      reload();
      setError(messageOf(reason));
      present({ phase: "check", entry, message: "这次结果需要只读核对；收据仍保留。" });
      return { outcome: "attention", entityId: entityId(entry.ticket.receipt) };
    }
  }, [databaseMutationActiveExcept, externalBlockedNow, finish, inspectEntry, present, reload]);

  const checkpointAndCommit = useCallback(async (
    receipt: CareerLifecycleTaskWriteReceipt,
    owner: "lifecycle" | "task",
    trigger: HTMLElement,
  ) => {
    const held = createCareerLifecycleTaskWriteEntry(
      createCareerLifecycleTaskWriteTicket(receipt),
    );
    hold(held);
    triggerRef.current.set(receipt.operationId, trigger);
    try {
      const durable = await persistCareerLifecycleTaskWrite(held.ticket);
      hold(durable);
      reload();
      return commitEntry(durable, owner);
    } catch (reason) {
      setError(messageOf(reason));
      present({
        phase: "check", entry: held,
        message: "收据暂时只保留在本页；必须先 checkpoint 并只读核对。",
      });
      return { outcome: "attention", entityId: entityId(receipt) } as const;
    }
  }, [commitEntry, hold, present, reload]);

  const previewLifecycle = useCallback(async (
    intent: CareerLifecycleWriteIntent,
    displayed: CareerLifecycleDisplayedExpected,
    trigger: HTMLElement,
  ) => {
    if (operationRef.current || snapshotStaleNowRef.current()) return null;
    const token = claimDatabaseMutation("lifecycle");
    if (!token) return null;
    setError("");
    setLifecyclePreviewActive(true);
    operationRef.current = true;
    setFlow({ phase: "working", action: "prepare" });
    try {
      if (databaseMutationActiveExcept("lifecycle") || externalBlockedNow()) {
        throw new Error("另一笔数据库操作已经开始；没有准备职位变更。");
      }
      const preview = await previewCareerLifecycleWrite(intent, displayed);
      if (databaseMutationActiveExcept("lifecycle") || snapshotStaleNowRef.current()) {
        throw new Error("准备期间资料已经变化；没有授权后续写入。");
      }
      triggerRef.current.set(preview.operationId, trigger);
      lifecyclePreviewOperationRef.current = preview.operationId;
      setFlow({ phase: "idle" });
      return preview;
    } catch (reason) {
      setError(messageOf(reason));
      lifecyclePreviewOperationRef.current = null;
      setFlow({ phase: "idle" });
      return null;
    } finally {
      operationRef.current = false;
      setLifecyclePreviewActive(false);
      releaseDatabaseMutation(token);
    }
  }, [claimDatabaseMutation, databaseMutationActiveExcept, externalBlockedNow, releaseDatabaseMutation]);

  const cancelLifecyclePreview = useCallback(() => {
    if (operationRef.current) return false;
    setLifecyclePreviewActive(false);
    const operationId = lifecyclePreviewOperationRef.current;
    lifecyclePreviewOperationRef.current = null;
    if (operationId) triggerRef.current.delete(operationId);
    const current = journalRef.current;
    const hasDurableTruth = careerLifecycleTaskRecoveryAttention({
      heldReceiptCount: heldRef.current.size,
      journalEntryCount: current.entries.length,
      peerEntryCount: current.peerEntries.length,
      unreadableCount: current.unreadable.length,
      storageUnavailable: current.storageUnavailable,
      lockUnavailable: current.lockUnavailable,
    });
    if (!hasDurableTruth) setError("");
    return true;
  }, []);

  const submitLifecycle = useCallback(async (
    preview: CareerLifecycleWritePreview,
    choice: CareerLifecycleWriteChoice,
    trigger: HTMLElement,
  ): Promise<CareerLifecycleTaskSubmitResult> => {
    if (operationRef.current || lifecyclePreviewOperationRef.current !== preview.operationId) {
      setError("这份职位变更预览已经失效；请重新打开后再试。");
      return { outcome: "blocked", entityId: null };
    }
    const token = claimDatabaseMutation("lifecycle");
    if (!token) {
      setError("另一笔数据库操作已经开始；这次没有准备或提交，可以稍后重试。");
      return { outcome: "blocked", entityId: null };
    }
    setError("");
    let keepPreview = false;
    operationRef.current = true;
    setFlow({ phase: "working", action: "prepare" });
    try {
      if (databaseMutationActiveExcept("lifecycle") || externalBlockedNow() ||
        lifecyclePreviewOperationRef.current !== preview.operationId) {
        throw new Error("另一笔数据库操作已经开始；这次没有准备或提交，可以稍后重试。");
      }
      const prepared = await prepareCareerLifecycleWrite(preview, choice);
      if (databaseMutationActiveExcept("lifecycle") || snapshotStaleNowRef.current()) {
        throw new Error("确认期间资料已经变化；没有提交职位变更。");
      }
      if (prepared.outcome === "changed") {
        if (prepared.preview.operationId !== preview.operationId) {
          triggerRef.current.delete(preview.operationId);
          triggerRef.current.set(prepared.preview.operationId, trigger);
        }
        lifecyclePreviewOperationRef.current = prepared.preview.operationId;
        keepPreview = true;
        setFlow({ phase: "idle" });
        return { outcome: "preview-changed", preview: prepared.preview };
      }
      return await checkpointAndCommit(prepared.receipt, "lifecycle", trigger);
    } catch (reason) {
      keepPreview = lifecyclePreviewOperationRef.current === preview.operationId;
      setError(messageOf(reason));
      setFlow({ phase: "idle" });
      return { outcome: "blocked", entityId: null };
    } finally {
      operationRef.current = false;
      setLifecyclePreviewActive(false);
      if (!keepPreview) lifecyclePreviewOperationRef.current = null;
      releaseDatabaseMutation(token);
    }
  }, [checkpointAndCommit, claimDatabaseMutation, databaseMutationActiveExcept, externalBlockedNow, releaseDatabaseMutation]);

  const runTaskPrepare = useCallback(async (
    prepare: () => Promise<CareerTaskWriteReceipt>,
    trigger: HTMLElement,
  ): Promise<CareerLifecycleTaskSubmitResult> => {
    if (operationRef.current || snapshotStaleNowRef.current()) {
      return { outcome: "blocked", entityId: null };
    }
    const token = claimDatabaseMutation("task");
    if (!token) return { outcome: "blocked", entityId: null };
    operationRef.current = true;
    setFlow({ phase: "working", action: "prepare" });
    try {
      if (databaseMutationActiveExcept("task") || externalBlockedNow()) {
        throw new Error("另一笔数据库操作已经开始；没有准备待办写入。");
      }
      const receipt = await prepare();
      if (databaseMutationActiveExcept("task") || snapshotStaleNowRef.current()) {
        throw new Error("准备期间资料已经变化；没有提交待办写入。");
      }
      return await checkpointAndCommit(receipt, "task", trigger);
    } catch (reason) {
      setError(messageOf(reason));
      setFlow({ phase: "idle" });
      return { outcome: "blocked", entityId: null };
    } finally {
      operationRef.current = false;
      releaseDatabaseMutation(token);
    }
  }, [checkpointAndCommit, claimDatabaseMutation, databaseMutationActiveExcept, externalBlockedNow, releaseDatabaseMutation]);

  const submitTaskCreate = useCallback((
    input: CreateCareerTaskWriteInput,
    expected: CareerTaskCreateExpectedContext,
    trigger: HTMLElement,
  ) => runTaskPrepare(() => prepareCareerTaskCreate(input, expected), trigger), [runTaskPrepare]);

  const submitTaskComplete = useCallback((
    expected: CareerTaskWriteExpectedState,
    trigger: HTMLElement,
  ) => runTaskPrepare(() => prepareCareerTaskComplete(expected), trigger), [runTaskPrepare]);

  const inspectActive = useCallback(async () => {
    if (!("entry" in flow) || operationRef.current) return;
    operationRef.current = true;
    try { await inspectEntry(flow.entry); }
    catch (reason) { setError(messageOf(reason)); setFlow(phaseFor(latest() ?? flow.entry)); }
    finally { operationRef.current = false; }
  }, [flow, inspectEntry, latest]);

  const continueExpected = useCallback(async () => {
    if (flow.phase !== "expected" || operationRef.current) return;
    const owner = flow.entry.ticket.receipt.purpose === "career-lifecycle-write"
      ? "lifecycle" as const : "task" as const;
    const token = claimDatabaseMutation(owner);
    if (!token) return;
    setError("");
    operationRef.current = true;
    try { await commitEntry(flow.entry, owner); }
    finally { operationRef.current = false; releaseDatabaseMutation(token); }
  }, [claimDatabaseMutation, commitEntry, flow, releaseDatabaseMutation]);

  const retryRefresh = useCallback(async () => {
    if (!(flow.phase === "refresh-only" || flow.phase === "changed") || operationRef.current) return;
    operationRef.current = true;
    try { await finish(flow.entry, flow.phase === "refresh-only" ? "committed" : "changed"); }
    finally { operationRef.current = false; }
  }, [finish, flow]);

  const discardTerminal = useCallback(async () => {
    if (!(flow.phase === "expected" || flow.phase === "invalid") || operationRef.current) return;
    setError("");
    operationRef.current = true;
    try {
      if (await removeCurrent(flow.entry) === "ran") {
        clearHeld(flow.entry);
        setFlow({ phase: "idle" });
        restoreTrigger(flow.entry.ticket.receipt);
        setStatus("这张确定未写入的收据已放弃；现有资料没有改变。");
      } else setFlow(phaseFor(latest() ?? flow.entry));
    } catch (reason) { setError(messageOf(reason)); }
    finally { operationRef.current = false; }
  }, [clearHeld, flow, latest, removeCurrent, restoreTrigger]);

  const removeFirstUnreadable = useCallback(async () => {
    const first = journalRef.current.unreadable[0];
    if (!first || operationRef.current) return;
    setError("");
    operationRef.current = true;
    try {
      if (!await removeUnreadableCareerLifecycleTaskWrite(first)) {
        throw new Error("这条提醒已经变化或暂时无法清除。");
      }
      const next = latest();
      setFlow(next ? phaseFor(next) : { phase: "idle" });
    } catch (reason) { setError(messageOf(reason)); }
    finally { operationRef.current = false; }
  }, [latest]);

  return {
    journal, flow, error, status, busy, databaseMutationLocked,
    hasHeldReceipt: barrier.blocksWrites,
    hasRecoveryAttention,
    hasVolatileWork,
    attentionRef: attentionRef as RefObject<HTMLDivElement>,
    isWriteInProgress: () => operationRef.current,
    previewLifecycle,
    cancelLifecyclePreview,
    submitLifecycle,
    submitTaskCreate,
    submitTaskComplete,
    inspectActive,
    continueExpected,
    retryRefresh,
    discardTerminal,
    removeFirstUnreadable,
    retryStorage: () => {
      setError("");
      const next = latest();
      setFlow(next ? phaseFor(next) : { phase: "idle" });
    },
  } as const;
}
