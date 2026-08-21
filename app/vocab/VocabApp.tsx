"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { errorMessage, explainInChinese, explainSelection } from "@/lib/vocab/api";
import {
  exportCompleteVocabBackup,
  isCompleteVocabBackup,
  restoreCompleteVocabBackup,
  restoreLegacyVocabDatabase,
} from "@/lib/vocab/backup";
import {
  estimateLocalStorage,
  requestPersistentLocalStorage,
  supportsPersistentLocalStorage,
  type LocalStorageEstimate,
} from "@/lib/local-db/files";
import {
  createBookmark,
  getDueCards,
  initializeVocabDatabase,
  isVocabOccurrenceWriteReceipt,
  loadVocabSnapshot,
  inspectVocabOccurrenceWrite,
  prepareVocabOccurrenceWrite,
  rateReview,
  saveLexemeNote,
  saveOccurrence,
  saveSettings,
  toggleLexemeStar,
  undoReview,
  updateItemProgress,
  updateItemStatus,
  updateLexemeStatus,
  VocabWriteConflictError,
  VocabWriteNotSavedError,
  VocabWriteUncertainError,
  type VocabOccurrenceWriteReceipt,
} from "@/lib/vocab/store";
import type { AiExplanation, LibraryItem, ReviewCard, ReviewRating, SelectionTarget, VocabSettings, VocabSnapshot, VocabView } from "@/lib/vocab/types";
import { subscribeVocabChanges } from "@/lib/vocab/lock";
import { ContextPanel, ImportWizard, WordDetail } from "./overlays";
import { LibraryView, PodcastView, ReaderView, ReviewView, SettingsView, StatsView, TodayView, WordsView } from "./views";
import { Loader, Logo } from "./ui";
import { useOverlayDialog } from "./useOverlayDialog";
import { SearchPalette } from "./SearchPalette";

const navigation: Array<{ id: VocabView; label: string; glyph: string }> = [
  { id: "today", label: "今日", glyph: "今" },
  { id: "library", label: "资料库", glyph: "库" },
  { id: "words", label: "词库", glyph: "词" },
  { id: "review", label: "复习", glyph: "习" },
  { id: "stats", label: "数据", glyph: "数" },
];

const empty: VocabSnapshot = {
  items: [], blocks: [], segments: [], lexemes: [], occurrences: [], reviewCards: [], bookmarks: [], activity: [],
  settings: { chinese_explanation: false, font_scale: 1, line_height: 1.92, local_lock: false, auto_follow: true, daily_new_limit: 8 },
};

function selectionIdentity(target: SelectionTarget) {
  return [target.itemId, target.blockId ?? "", target.segmentId ?? "", target.startUtf16, target.endUtf16, target.surface, target.sentence].join("\u001f");
}

const OCCURRENCE_RECOVERY_PREFIX = "vocab.pending-occurrence-write.v1:";

function occurrenceRecoveryKey(receipt: VocabOccurrenceWriteReceipt): string {
  return `${OCCURRENCE_RECOVERY_PREFIX}${receipt.operationId}`;
}

function readOccurrenceRecovery(): VocabOccurrenceWriteReceipt | null {
  if (typeof window === "undefined") return null;
  const receipts: VocabOccurrenceWriteReceipt[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(OCCURRENCE_RECOVERY_PREFIX)) continue;
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) continue;
        const receipt: unknown = JSON.parse(raw);
        if (
          isVocabOccurrenceWriteReceipt(receipt) &&
          key === occurrenceRecoveryKey(receipt)
        ) receipts.push(receipt);
      } catch {
        // One damaged entry must not hide another operation's valid receipt.
      }
    }
  } catch {
    return null;
  }
  return receipts.sort((left, right) => left.createdAt - right.createdAt)[0] ?? null;
}

function writeOccurrenceRecovery(receipt: VocabOccurrenceWriteReceipt): void {
  window.localStorage.setItem(occurrenceRecoveryKey(receipt), JSON.stringify(receipt));
}

function removeOccurrenceRecovery(receipt: VocabOccurrenceWriteReceipt): boolean {
  try {
    const key = occurrenceRecoveryKey(receipt);
    if (window.localStorage.getItem(key) === JSON.stringify(receipt)) {
      window.localStorage.removeItem(key);
      return window.localStorage.getItem(key) !== JSON.stringify(receipt);
    }
  } catch {
    // A stale receipt is safe: the next load can only inspect it, never replay it.
  }
  return false;
}

type WordSavePhase =
  | "idle"
  | "committing"
  | "refreshing"
  | "uncertain"
  | "conflict"
  | "refresh_failed";

type PendingOccurrenceWrite = Readonly<{
  inputKey: string;
  target: SelectionTarget;
  explanation: AiExplanation | null;
  note: string;
  receipt: VocabOccurrenceWriteReceipt;
}>;

export default function VocabApp() {
  const [snapshot, setSnapshot] = useState<VocabSnapshot>(empty);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState("");
  const [view, setView] = useState<VocabView>("today");
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionTarget | null>(null);
  const [explanation, setExplanation] = useState<AiExplanation | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [showChinese, setShowChinese] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [wordId, setWordId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [sideOpen, setSideOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [storageStatus, setStorageStatus] = useState<LocalStorageEstimate | null>(null);
  const [wordSavePhase, setWordSavePhase] = useState<WordSavePhase>("idle");
  const [wordSaveBusy, setWordSaveBusy] = useState(false);
  const [wordSaveMessage, setWordSaveMessage] = useState("");
  const [occurrenceRecovery, setOccurrenceRecovery] = useState<VocabOccurrenceWriteReceipt | null>(null);
  const [committedOccurrence, setCommittedOccurrence] = useState<{ surface: string } | null>(null);
  const selectionRef = useRef<SelectionTarget | null>(null);
  const aiSequence = useRef(0);
  const aiRequest = useRef<{ id: number; key: string; controller: AbortController } | null>(null);
  const explanationKey = useRef<string | null>(null);
  const wordSaveBusyRef = useRef(false);
  const pendingOccurrenceRef = useRef<PendingOccurrenceWrite | null>(null);
  const occurrenceRecoveryRef = useRef<VocabOccurrenceWriteReceipt | null>(null);
  const committedOccurrenceRef = useRef<{ surface: string } | null>(null);
  const sidebarDialog = useOverlayDialog<HTMLElement>(sideOpen, () => setSideOpen(false), "button");

  const refresh = useCallback(async () => setSnapshot(await loadVocabSnapshot()), []);

  const refreshStorageStatus = useCallback(async () => {
    const next = await estimateLocalStorage();
    setStorageStatus(next);
    return next;
  }, []);

  const activateNextOccurrenceRecovery = useCallback(() => {
    const next = readOccurrenceRecovery();
    occurrenceRecoveryRef.current = next;
    setOccurrenceRecovery(next);
    if (!next) return null;
    if (pendingOccurrenceRef.current?.receipt.operationId !== next.operationId) {
      pendingOccurrenceRef.current = null;
    }
    setWordSavePhase("uncertain");
    setWordSaveMessage(
      "还有一次收词结果待核对。只读核对完成前，不会发起新的收词写入。",
    );
    return next;
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await initializeVocabDatabase();
        const data = await loadVocabSnapshot();
        if (!live) return;
        setSnapshot(data);
        setShowChinese(data.settings.chinese_explanation);
        setActiveItemId(data.items.find((item) => item.status === "in_progress")?.id ?? data.items[0]?.id ?? null);
        setReady(true);
        void refreshStorageStatus().catch(() => undefined);
      } catch (error) {
        if (live) setFatal(errorMessage(error));
      }
    })();
    return () => { live = false; };
  }, [refreshStorageStatus]);

  useEffect(() => {
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      const receipt = readOccurrenceRecovery();
      if (!receipt) return;
      occurrenceRecoveryRef.current = receipt;
      setOccurrenceRecovery(receipt);
      setWordSavePhase("uncertain");
      setWordSaveMessage(
        "上次收词没有留下完整结果。先只读核对；回执不含所选文字、语境、释义或笔记。",
      );
    });
    return () => { live = false; };
  }, []);

  useEffect(() => subscribeVocabChanges(() => { void refresh().catch(() => undefined); }), [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const activeItem = useMemo(() => snapshot.items.find((item) => item.id === activeItemId) ?? null, [activeItemId, snapshot.items]);
  const dueCards = useMemo(() => getDueCards(snapshot.reviewCards), [snapshot.reviewCards]);

  const cancelAi = useCallback(() => {
    aiRequest.current?.controller.abort();
    aiRequest.current = null;
    setAiBusy(false);
  }, []);

  const clearSelection = useCallback(() => {
    if (wordSaveBusyRef.current) return;
    const keepRecovery = Boolean(
      occurrenceRecoveryRef.current || committedOccurrenceRef.current,
    );
    cancelAi();
    selectionRef.current = null;
    explanationKey.current = null;
    setSelection(null);
    setExplanation(null);
    setAiError("");
    if (!keepRecovery) {
      setWordSavePhase("idle");
      setWordSaveMessage("");
      pendingOccurrenceRef.current = null;
    }
    window.getSelection()?.removeAllRanges();
  }, [cancelAi]);

  useEffect(() => () => aiRequest.current?.controller.abort(), []);

  const go = useCallback((next: VocabView) => {
    setView(next); setSideOpen(false);
    if (next !== "reader" && next !== "podcast") clearSelection();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
  }, [clearSelection]);

  const openItem = useCallback((item: LibraryItem) => {
    setActiveItemId(item.id);
    setView(item.kind === "article" ? "reader" : "podcast");
    clearSelection();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
  }, [clearSelection]);

  const askAiFor = useCallback(async (target: SelectionTarget, includeChinese: boolean) => {
    const key = selectionIdentity(target);
    if (snapshot.settings.local_lock) {
      setAiError("本地锁已开启。这个语境仍可保存在本地，但不会发送给 AI。");
      return;
    }
    aiRequest.current?.controller.abort();
    const controller = new AbortController();
    const id = ++aiSequence.current;
    aiRequest.current = { id, key, controller };
    setAiBusy(true); setAiError("");
    try {
      const result = await explainSelection(target, includeChinese, controller.signal);
      if (aiRequest.current?.id !== id || selectionIdentity(selectionRef.current ?? target) !== key) return;
      explanationKey.current = key;
      setExplanation(result);
    } catch (error) {
      if (controller.signal.aborted || aiRequest.current?.id !== id) return;
      setAiError(errorMessage(error));
    } finally {
      if (aiRequest.current?.id === id) {
        aiRequest.current = null;
        setAiBusy(false);
      }
    }
  }, [snapshot.settings.local_lock]);

  const selectText = useCallback((target: SelectionTarget) => {
    if (
      wordSaveBusyRef.current ||
      occurrenceRecoveryRef.current ||
      committedOccurrenceRef.current
    ) {
      setWordSaveMessage(
        occurrenceRecoveryRef.current
          ? "先只读核对上次收词结果，再选择新的词。"
          : "上次收词已经保存；先只刷新词库，再选择新的词。",
      );
      return;
    }
    cancelAi();
    selectionRef.current = target;
    explanationKey.current = null;
    pendingOccurrenceRef.current = null;
    committedOccurrenceRef.current = null;
    setWordSavePhase("idle");
    setWordSaveMessage("");
    setSelection(target); setExplanation(null); setAiError("");
    const includeChinese = snapshot.settings.chinese_explanation;
    setShowChinese(includeChinese);
  }, [cancelAi, snapshot.settings.chinese_explanation]);

  const askAi = useCallback(async (includeChinese = showChinese) => {
    const target = selectionRef.current;
    if (target) await askAiFor(target, includeChinese);
  }, [askAiFor, showChinese]);

  const addChinese = useCallback(async () => {
    const target = selectionRef.current;
    if (!target || !explanation) return;
    if (snapshot.settings.local_lock) { setAiError("本地锁已开启。"); return; }
    const key = selectionIdentity(target);
    if (explanationKey.current !== key) return;
    aiRequest.current?.controller.abort();
    const controller = new AbortController();
    const id = ++aiSequence.current;
    aiRequest.current = { id, key, controller };
    setAiBusy(true); setAiError("");
    try {
      const zh = await explainInChinese(explanation, target, controller.signal);
      if (aiRequest.current?.id !== id || selectionIdentity(selectionRef.current ?? target) !== key) return;
      setExplanation({ ...explanation, sense: { ...explanation.sense, explanation_zh: zh.explanation_zh ?? null }, context_translation_zh: zh.context_translation_zh ?? null });
    } catch (error) {
      if (!controller.signal.aborted && aiRequest.current?.id === id) setAiError(errorMessage(error));
    } finally {
      if (aiRequest.current?.id === id) {
        aiRequest.current = null;
        setAiBusy(false);
      }
    }
  }, [explanation, snapshot.settings.local_lock]);

  const finishWordBusy = useCallback(() => {
    wordSaveBusyRef.current = false;
    setWordSaveBusy(false);
  }, []);

  const savePickedWord = useCallback(async (rawNote = "") => {
    if (wordSaveBusyRef.current) return;
    const target = selectionRef.current;
    if (!target) return;
    wordSaveBusyRef.current = true;
    setWordSaveBusy(true);
    setWordSavePhase("committing");
    setWordSaveMessage("");
    const note = rawNote.trim();
    let pending = pendingOccurrenceRef.current;
    let recoveryPrepared = false;
    let closeForNextRecovery = false;
    try {
      const boundExplanation = explanationKey.current === selectionIdentity(target)
        ? explanation
        : null;
      const inputKey = [
        selectionIdentity(target),
        note,
        JSON.stringify(boundExplanation),
      ].join("\u001e");
      if (!pending || pending.inputKey !== inputKey) {
        pendingOccurrenceRef.current = null;
        pending = null;
        const receipt = await prepareVocabOccurrenceWrite(
          target,
          boundExplanation,
          note,
        );
        pending = {
          inputKey,
          target,
          explanation: boundExplanation,
          note,
          receipt,
        };
        pendingOccurrenceRef.current = pending;
      }
      writeOccurrenceRecovery(pending.receipt);
      occurrenceRecoveryRef.current = pending.receipt;
      setOccurrenceRecovery(pending.receipt);
      recoveryPrepared = true;
      await saveOccurrence(pending.target, pending.explanation, {
        note: pending.note,
        receipt: pending.receipt,
      });
      removeOccurrenceRecovery(pending.receipt);
      occurrenceRecoveryRef.current = null;
      setOccurrenceRecovery(null);
      committedOccurrenceRef.current = { surface: target.surface };
      setCommittedOccurrence({ surface: target.surface });
      pendingOccurrenceRef.current = null;
      setWordSavePhase("refreshing");
      try {
        await refresh();
      } catch (refreshError) {
        setWordSavePhase("refresh_failed");
        setWordSaveMessage(
          `“${target.surface}” 已经收入词库，只是页面暂未更新：${errorMessage(refreshError)}`,
        );
        return;
      }
      finishWordBusy();
      setToast(`已把 “${target.surface}” 收入词库`);
      committedOccurrenceRef.current = null;
      setCommittedOccurrence(null);
      clearSelection();
      activateNextOccurrenceRecovery();
    } catch (caught) {
      if (pending && !recoveryPrepared) {
        setWordSavePhase("idle");
        setWordSaveMessage(
          "浏览器无法保存这次安全回执，因此没有写入词库。请检查浏览器存储后再试。",
        );
      } else if (caught instanceof VocabWriteNotSavedError) {
        if (pending) removeOccurrenceRecovery(pending.receipt);
        occurrenceRecoveryRef.current = null;
        setOccurrenceRecovery(null);
        const nextRecovery = activateNextOccurrenceRecovery();
        if (!nextRecovery) {
          setWordSavePhase("idle");
          setWordSaveMessage(`${errorMessage(caught)} 可以使用同一回执安全重试。`);
        } else {
          closeForNextRecovery = nextRecovery.operationId !== pending?.receipt.operationId;
        }
      } else if (caught instanceof VocabWriteConflictError) {
        setWordSavePhase("conflict");
        setWordSaveMessage(`${errorMessage(caught)} 现在只允许只读核对。`);
      } else if (caught instanceof VocabWriteUncertainError || pending) {
        setWordSavePhase("uncertain");
        setWordSaveMessage(`${errorMessage(caught)} 现在只允许只读核对，不会重复收词。`);
      } else {
        setWordSavePhase("idle");
        setWordSaveMessage(errorMessage(caught));
      }
    } finally {
      finishWordBusy();
      if (closeForNextRecovery) clearSelection();
    }
  }, [activateNextOccurrenceRecovery, clearSelection, explanation, finishWordBusy, refresh]);

  const inspectPendingWord = useCallback(async () => {
    if (wordSaveBusyRef.current) return;
    const pending = pendingOccurrenceRef.current;
    const receipt = occurrenceRecoveryRef.current ?? pending?.receipt;
    if (!receipt) {
      setWordSavePhase("idle");
      setWordSaveMessage("没有待核对的收词回执。可以重新保存。");
      return;
    }
    wordSaveBusyRef.current = true;
    setWordSaveBusy(true);
    setWordSaveMessage("");
    try {
      const status = await inspectVocabOccurrenceWrite(receipt);
      if (status === "exact_saved") {
        removeOccurrenceRecovery(receipt);
        occurrenceRecoveryRef.current = null;
        setOccurrenceRecovery(null);
        pendingOccurrenceRef.current = null;
        const surface = pending?.receipt.operationId === receipt.operationId
          ? pending.target.surface
          : "上次选择";
        committedOccurrenceRef.current = { surface };
        setCommittedOccurrence({ surface });
        setWordSavePhase("refresh_failed");
        setWordSaveMessage(
          `已只读确认：${surface === "上次选择" ? "上次选择" : `“${surface}”`} 已经保存。下一步只刷新词库。`,
        );
      } else if (status === "absent") {
        removeOccurrenceRecovery(receipt);
        occurrenceRecoveryRef.current = null;
        setOccurrenceRecovery(null);
        if (!activateNextOccurrenceRecovery()) {
          setWordSavePhase("idle");
          setWordSaveMessage("已只读确认：这次收词没有写入，也没有增加查询次数。可以安全重试。");
        }
      } else {
        setWordSavePhase(status === "conflict" ? "conflict" : "uncertain");
        setWordSaveMessage(status === "conflict"
          ? "回执与数据库里的语境不一致，已保持只读并停止重试。"
          : "数据库暂时仍无法核对。没有写入、覆盖或增加查询次数。");
      }
    } catch (caught) {
      setWordSavePhase("uncertain");
      setWordSaveMessage(`核对没有完成：${errorMessage(caught)}。没有重复收词。`);
    } finally {
      finishWordBusy();
    }
  }, [activateNextOccurrenceRecovery, finishWordBusy]);

  const refreshCommittedWord = useCallback(async () => {
    if (wordSaveBusyRef.current || !committedOccurrenceRef.current) return;
    wordSaveBusyRef.current = true;
    setWordSaveBusy(true);
    setWordSavePhase("refreshing");
    setWordSaveMessage("");
    const committed = committedOccurrenceRef.current;
    try {
      await refresh();
      committedOccurrenceRef.current = null;
      setCommittedOccurrence(null);
      finishWordBusy();
      setToast(`已把 “${committed.surface}” 收入词库`);
      clearSelection();
      activateNextOccurrenceRecovery();
    } catch (caught) {
      setWordSavePhase("refresh_failed");
      setWordSaveMessage(
        `内容仍然安全保存在词库，只是页面刷新失败：${errorMessage(caught)}`,
      );
    } finally {
      finishWordBusy();
    }
  }, [activateNextOccurrenceRecovery, clearSelection, finishWordBusy, refresh]);

  const abandonConflictedWord = useCallback(async () => {
    if (wordSaveBusyRef.current) return;
    const receipt = occurrenceRecoveryRef.current ?? pendingOccurrenceRef.current?.receipt;
    if (!receipt) return;
    const approved = window.confirm(
      "只移除这条恢复提醒吗？这不会改动词库、查询次数或任何已保存内容；若数据库里已有冲突记录，也会原样保留。",
    );
    if (!approved) return;
    if (!removeOccurrenceRecovery(receipt)) {
      setWordSaveMessage("提醒已发生变化或暂时无法访问，因此没有移除。可以稍后再次只读核对。");
      return;
    }
    occurrenceRecoveryRef.current = null;
    setOccurrenceRecovery(null);
    pendingOccurrenceRef.current = null;
    if (!activateNextOccurrenceRecovery()) {
      setWordSavePhase("idle");
      setWordSaveMessage("只移除了这条恢复提醒；词库和查询次数都没有改动。");
    }
  }, [activateNextOccurrenceRecovery]);

  const wordPrimaryAction = useCallback((note = "") => {
    if (wordSavePhase === "uncertain") return inspectPendingWord();
    if (wordSavePhase === "conflict") return abandonConflictedWord();
    if (wordSavePhase === "refresh_failed") return refreshCommittedWord();
    return savePickedWord(note);
  }, [abandonConflictedWord, inspectPendingWord, refreshCommittedWord, savePickedWord, wordSavePhase]);

  const changeSettings = useCallback(async (patch: Partial<VocabSettings>) => {
    const next = { ...snapshot.settings, ...patch };
    setSnapshot((current) => ({ ...current, settings: next }));
    await saveSettings(next);
  }, [snapshot.settings]);

  const recordReaderProgress = useCallback(async (item: LibraryItem, progress: number) => {
    await updateItemProgress(item.id, Math.max(0, Math.min(.99, progress)));
  }, []);

  const recordPodcastProgress = useCallback(async (item: LibraryItem, progress: number) => {
    await updateItemProgress(item.id, Math.max(0, Math.min(1, progress)), progress > .98);
  }, []);

  const exportBackup = useCallback(async () => {
    const backup = await exportCompleteVocabBackup();
    const url = URL.createObjectURL(backup.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = backup.fileName;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return `备份文件已交给浏览器下载，包含 ${backup.audioCount} 个本地音频。`;
  }, []);

  const restoreBackup = useCallback(async (file: File) => {
    const complete = await isCompleteVocabBackup(file);
    const approved = window.confirm(
      complete
        ? "将从完整备份恢复拾词数据与本地音频。恢复前会完整校验，并保留上一代恢复快照。确定继续吗？"
        : "这是旧版 SQLite 备份，只能恢复数据库内容；其中原有的本地音频无法随文件恢复。恢复前会先校验，确定继续吗？",
    );
    if (!approved) return "已取消恢复，当前数据没有改动。";

    const result = complete
      ? await restoreCompleteVocabBackup(file)
      : await restoreLegacyVocabDatabase(file);
    await initializeVocabDatabase();
    await refresh();
    await refreshStorageStatus().catch(() => null);
    if ("audioCount" in result) {
      return `完整备份已恢复，校验了 ${result.audioCount} 个本地音频；上一代恢复快照仍保留。`;
    }
    return "旧版 SQLite 已恢复；本地音频引用已安全清除，上一代恢复快照仍保留。";
  }, [refresh, refreshStorageStatus]);

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (event.key.toLowerCase() === "i") setImportOpen(true);
      if (event.key.toLowerCase() === "e" && selection) void askAi();
      if (event.key.toLowerCase() === "s" && selection) void wordPrimaryAction();
      if (event.key === "Escape") { clearSelection(); setWordId(null); setImportOpen(false); setSearchOpen(false); }
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [askAi, clearSelection, selection, wordPrimaryAction]);

  if (fatal) return <main className="shici sc-fatal"><Logo /><section><span>数据库未能打开</span><h1>你的内容没有被改动。</h1><p>{fatal}</p><button onClick={() => window.location.reload()}>重新尝试</button></section></main>;
  if (!ready) return <Loader />;

  const pageLabel = navigation.find((entry) => entry.id === view)?.label ?? (view === "reader" ? "阅读" : view === "podcast" ? "收听" : "设置");
  const persistenceSupported = supportsPersistentLocalStorage();
  return <main className="shici" style={{ "--reader-scale": snapshot.settings.font_scale, "--reader-leading": snapshot.settings.line_height } as CSSProperties}>
    <aside ref={sidebarDialog} id="sc-navigation" className={`sc-sidebar ${sideOpen ? "open" : ""}`} role={sideOpen ? "dialog" : undefined} aria-modal={sideOpen ? true : undefined} aria-label="拾词导航" tabIndex={sideOpen ? -1 : undefined}>
      <Link href="/" className="sc-brand" aria-label="返回私人工作台"><Logo /></Link>
      <nav>{navigation.map((item) => <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "active" : ""} onClick={() => go(item.id)}><i>{item.glyph}</i><span>{item.label}</span></button>)}</nav>
      <div className="sc-side-foot"><button className={view === "settings" ? "active" : ""} onClick={() => go("settings")}><i>设</i><span>设置</span></button><div><i className={storageStatus?.persisted === true ? "persisted" : ""} /><span>当前浏览器<small>{storageStatus?.persisted === true ? "已获持久化保护" : !persistenceSupported ? "未提供持久化保护接口" : storageStatus?.persisted === false ? "请定期导出备份" : "保护状态暂时未知"}</small></span></div></div>
    </aside>
    <section className="sc-main">
      <header className="sc-topbar"><button className="sc-menu" onClick={() => setSideOpen((value) => !value)} aria-expanded={sideOpen} aria-controls="sc-navigation" aria-label={sideOpen ? "关闭导航" : "打开导航"}>拾</button><div className="sc-crumb"><span>拾词</span><b>/</b><strong>{pageLabel}</strong></div><div className="sc-top-actions"><button className="sc-search-jump" aria-label="搜索资料、词和语境" onClick={() => setSearchOpen(true)}>⌕ <span>搜索</span><kbd>⌘ K</kbd></button><button className="sc-import" aria-label="导入内容" onClick={() => setImportOpen(true)}>＋ <span>导入内容</span></button></div></header>
      <div className="sc-view">
        {view === "today" && <TodayView snapshot={snapshot} due={dueCards.length} onOpen={openItem} onGo={go} onImport={() => setImportOpen(true)} onWord={setWordId} />}
        {view === "library" && <LibraryView items={snapshot.items} onOpen={openItem} onImport={() => setImportOpen(true)} onArchive={async (item) => { await updateItemStatus(item.id, item.status === "archived" ? "unread" : "archived"); await refresh(); }} />}
        {view === "reader" && <ReaderView item={activeItem?.kind === "article" ? activeItem : snapshot.items.find((item) => item.kind === "article") ?? null} blocks={snapshot.blocks} occurrences={snapshot.occurrences} bookmarks={snapshot.bookmarks} onSelect={selectText} onBack={() => go("library")} onProgress={recordReaderProgress} onFinish={async (item) => { await updateItemProgress(item.id, 1, true); await refresh(); setToast("已标记为读完，随时可以改回阅读中"); }} onBookmark={async (item, block) => { await createBookmark(item.id, block?.id ?? "top", block?.text.slice(0, 30) ?? item.title); await refresh(); setToast("已收藏当前位置"); }} />}
        {view === "podcast" && <PodcastView key={(activeItem?.kind === "podcast" ? activeItem : snapshot.items.find((item) => item.kind === "podcast"))?.id ?? "empty-podcast"} item={activeItem?.kind === "podcast" ? activeItem : snapshot.items.find((item) => item.kind === "podcast") ?? null} segments={snapshot.segments} occurrences={snapshot.occurrences} autoFollow={snapshot.settings.auto_follow} localLock={snapshot.settings.local_lock} onAutoFollow={(value) => void changeSettings({ auto_follow: value })} onSelect={selectText} onProgress={recordPodcastProgress} onBookmark={async (item, ms, label) => { await createBookmark(item.id, `t:${ms}`, label); await refresh(); setToast("已收藏此刻"); }} />}
        {view === "words" && <WordsView lexemes={snapshot.lexemes} occurrences={snapshot.occurrences} onOpen={setWordId} onStar={async (word) => { await toggleLexemeStar(word.id, !word.starred); await refresh(); }} />}
        {view === "review" && <ReviewView cards={snapshot.reviewCards} onRate={async (card: ReviewCard, rating: ReviewRating) => { const id = await rateReview(card, rating); await refresh(); return id; }} onUndo={async (id) => { await undoReview(id); await refresh(); }} />}
        {view === "stats" && <StatsView snapshot={snapshot} />}
        {view === "settings" && <SettingsView settings={snapshot.settings} storage={storageStatus} persistenceSupported={persistenceSupported} onChange={changeSettings} onExport={exportBackup} onImport={restoreBackup} onPersist={async () => { const granted = await requestPersistentLocalStorage(); const checked = await refreshStorageStatus(); return checked.persisted ?? granted; }} onTestAi={async () => { if (snapshot.settings.local_lock) throw new Error("请先关闭本地锁"); const response = await fetch("/api/health", { headers: { Accept: "application/json" } }); const health = await response.json() as { ai?: { configured?: boolean } }; if (!response.ok) throw new Error("无法检查 AI 服务状态"); if (!health.ai?.configured) throw new Error("DeepSeek API Key 尚未配置"); }} />}
      </div>
    </section>
    <nav className="sc-mobile-tabs" aria-label="拾词页面">{navigation.slice(0, 4).map((item) => <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "active" : ""} onClick={() => go(item.id)}><i>{item.glyph}</i><span>{item.label}</span></button>)}</nav>
    {selection && <ContextPanel target={selection} explanation={explanation} loading={aiBusy} error={aiError} showChinese={showChinese} saveBusy={wordSaveBusy} saveLabel={wordSavePhase === "uncertain" ? "只读核对" : wordSavePhase === "conflict" ? "移除这条提醒" : wordSavePhase === "refresh_failed" ? "只刷新词库" : "＋ 收入词库"} saveMessage={wordSaveMessage} onChinese={async (value) => { setShowChinese(value); if (value && explanation && !explanation.sense?.explanation_zh) await addChinese(); }} onExplain={() => void askAi()} onSave={wordPrimaryAction} onClose={clearSelection} />}
    {wordId && <WordDetail key={wordId} word={snapshot.lexemes.find((word) => word.id === wordId) ?? null} occurrences={snapshot.occurrences.filter((item) => item.lexeme_id === wordId)} onClose={() => setWordId(null)} onNote={async (id, note) => { await saveLexemeNote(id, note); await refresh(); setToast("笔记已保存"); }} onStatus={async (id, status) => { await updateLexemeStatus(id, status); await refresh(); }} />}
    {importOpen && <ImportWizard localLock={snapshot.settings.local_lock} onClose={() => setImportOpen(false)} onImported={async (id) => { const data = await loadVocabSnapshot(); setSnapshot(data); setImportOpen(false); const item = data.items.find((entry) => entry.id === id); if (item) openItem(item); setToast("内容已存入本地资料库"); }} />}
    {searchOpen && <SearchPalette snapshot={snapshot} onClose={() => setSearchOpen(false)} onOpenItem={openItem} onOpenWord={(id) => { setWordId(id); }} />}
    {!selection && !toast && (occurrenceRecovery || (wordSavePhase === "refresh_failed" && committedOccurrence)) && <button className="sc-toast" disabled={wordSaveBusy} aria-label={wordSavePhase === "refresh_failed" ? "上次收词已保存，只刷新词库" : wordSavePhase === "conflict" ? "移除这条冲突提醒" : "只读核对上次收词结果"} onClick={() => void wordPrimaryAction()}><span>{wordSaveBusy ? "正在确认…" : wordSavePhase === "refresh_failed" ? "上次收词已保存" : wordSavePhase === "conflict" ? "发现冲突，不会改库" : "上次收词待核对"}</span>{wordSavePhase === "refresh_failed" ? "只刷新词库" : wordSavePhase === "conflict" ? "移除提醒" : "只读核对"}</button>}
    {toast && <div className="sc-toast" role="status"><span>✓</span>{toast}</div>}
    {sideOpen && <button className="sc-nav-scrim" onClick={() => setSideOpen(false)} aria-label="关闭导航" />}
  </main>;
}
