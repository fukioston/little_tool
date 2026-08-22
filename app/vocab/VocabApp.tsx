"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { errorMessage, explainInChinese, explainSelection } from "@/lib/vocab/api";
import { exportCompleteVocabBackup } from "@/lib/vocab/backup";
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
  loadVocabSettingsExpectedState,
  type VocabItemWriteSnapshot,
  prepareVocabOccurrenceWrite,
  prepareVocabSettingsSave,
  saveLexemeNote,
  saveOccurrence,
  toggleLexemeStar,
  updateLexemeStatus,
  VocabSettingsMutationError,
  VocabWriteConflictError,
  VocabWriteNotSavedError,
  VocabWriteUncertainError,
  type VocabOccurrenceWriteReceipt,
  type VocabSettingsWriteReceipt,
  type VocabSettingsWriteSnapshot,
} from "@/lib/vocab/store";
import type { AiExplanation, LibraryItem, SelectionTarget, VocabSettings, VocabSnapshot, VocabView } from "@/lib/vocab/types";
import { subscribeVocabChanges } from "@/lib/vocab/lock";
import { ContextPanel, ImportWizard, WordDetail } from "./overlays";
import { LibraryView, PodcastView, ReaderView, ReviewView, SettingsView, StatsView, TodayView, WordsView } from "./views";
import { Loader, Logo } from "./ui";
import { useOverlayDialog } from "./useOverlayDialog";
import { SearchPalette } from "./SearchPalette";
import {
  VocabSettingsWriteBanner,
  VocabSettingsWriteRecovery,
  useVocabSettingsWriteFlow,
  type VocabSettingsRefreshOutcome,
} from "./VocabSettingsWriteFlow";
import {
  VocabItemWriteBanner,
  VocabItemWriteRecovery,
  useVocabItemWriteFlow,
  type VocabItemExpectedMap,
  type VocabItemRefreshOutcome,
} from "./VocabItemWriteFlow";
import {
  firstVocabItemRecoveryFocusTarget,
  vocabItemExitDecision,
  vocabItemHistoryBackDecision,
} from "./item-write-state";

const VOCAB_ITEM_HISTORY_GUARD = "__privateAiSuiteVocabItemGuard";

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

type VocabSnapshotReadStatus = "loading" | "ready" | "stale";
type VocabFactsReadBundle = Readonly<{
  snapshot: VocabSnapshot;
  expected: VocabSettingsWriteSnapshot;
  itemExpectedById: VocabItemExpectedMap;
}>;
type VocabSettingsDraft = Readonly<{
  settings: VocabSettings;
  expected: VocabSettingsWriteSnapshot;
  revision: number;
}>;

function claimVocabSettingsDraftFlush(
  flushedRevision: { current: number | null },
  draft: Pick<VocabSettingsDraft, "revision">,
) {
  if (flushedRevision.current === draft.revision) return false;
  flushedRevision.current = draft.revision;
  return true;
}

function vocabSettingsOutboundBlocked(
  confirmedLocalLock: boolean,
  journalLoaded: boolean,
  busy: boolean,
  storageUnavailable: boolean,
  unreadableCount: number,
  entryCount: number,
  operationInProgress = false,
) {
  return confirmedLocalLock || !journalLoaded || busy || storageUnavailable ||
    unreadableCount > 0 || entryCount > 0 || operationInProgress;
}

function sameVocabSettings(left: VocabSettings, right: VocabSettings) {
  return left.chinese_explanation === right.chinese_explanation &&
    left.font_scale === right.font_scale &&
    left.line_height === right.line_height &&
    left.local_lock === right.local_lock &&
    left.auto_follow === right.auto_follow &&
    left.daily_new_limit === right.daily_new_limit;
}

function sameVocabSettingsExpectedState(
  left: VocabSettingsWriteSnapshot,
  right: VocabSettingsWriteSnapshot,
) {
  return left.generationId === right.generationId &&
    left.generationSequence === right.generationSequence &&
    sameVocabSettings(left.settings, right.settings) &&
    left.rows.length === right.rows.length &&
    left.rows.every((row, index) => {
      const other = right.rows[index];
      return row === null || other === null
        ? row === other
        : row.key === other.key && row.value === other.value && row.updated_at === other.updated_at;
    });
}

async function loadVocabFactsWithSettingsExpected(): Promise<VocabFactsReadBundle> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const expectedBefore = await loadVocabSettingsExpectedState();
    const facts = await loadVocabSnapshot();
    const expectedAfter = await loadVocabSettingsExpectedState();
    if (sameVocabSettingsExpectedState(expectedBefore, expectedAfter) &&
        sameVocabSettings(facts.settings, expectedAfter.settings)) {
      const itemExpectedById = new Map<string, VocabItemWriteSnapshot>();
      const items = facts.items.map((source) => {
        const item = { ...source };
        itemExpectedById.set(item.id, {
          generationId: expectedAfter.generationId,
          generationSequence: expectedAfter.generationSequence,
          item,
        });
        return item;
      });
      return {
        snapshot: { ...facts, items, settings: expectedAfter.settings },
        expected: expectedAfter,
        itemExpectedById,
      };
    }
  }
  throw new Error("设置在读取期间持续变化；这次没有拼接新旧词库资料，请重新尝试。");
}

class VocabSnapshotSupersededError extends Error {
  constructor() {
    super("另一次较新的词库读取已经开始；等画面确认后再结束这次操作");
    this.name = "VocabSnapshotSupersededError";
  }
}

function selectionIdentity(target: SelectionTarget) {
  return [target.itemId, target.blockId ?? "", target.segmentId ?? "", target.startUtf16, target.endUtf16, target.surface, target.sentence].join("\u001f");
}

function useVocabMobileLayout() {
  const [mobile, setMobile] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const sync = () => {
      setMobile(query.matches);
      if (!query.matches) setSideOpen(false);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return { mobile, sideOpen, setSideOpen };
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
  const { mobile, sideOpen, setSideOpen } = useVocabMobileLayout();
  const [snapshot, setSnapshot] = useState<VocabSnapshot>(empty);
  const [settingsExpected, setSettingsExpected] = useState<VocabSettingsWriteSnapshot | null>(null);
  const [snapshotReadStatus, setSnapshotReadStatus] = useState<VocabSnapshotReadStatus>("loading");
  const [snapshotReadError, setSnapshotReadError] = useState("");
  const [settingsDraft, setSettingsDraft] = useState<VocabSettingsDraft | null>(null);
  const [settingsExternalPending, setSettingsExternalPending] = useState(false);
  const [settingsWriteNotice, setSettingsWriteNotice] = useState("");
  const [settingsRecoveryOpen, setSettingsRecoveryOpen] = useState(false);
  const [itemRecoveryOpen, setItemRecoveryOpen] = useState(false);
  const [itemExternalPending, setItemExternalPending] = useState(false);
  const [itemExitConfirmOpen, setItemExitConfirmOpen] = useState(false);
  const [itemExitDestination, setItemExitDestination] = useState<"suite" | "history">("suite");
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [storageStatus, setStorageStatus] = useState<LocalStorageEstimate | null>(null);
  const [wordSavePhase, setWordSavePhase] = useState<WordSavePhase>("idle");
  const [wordSaveBusy, setWordSaveBusy] = useState(false);
  const [wordSaveMessage, setWordSaveMessage] = useState("");
  const [wordAbandonConfirm, setWordAbandonConfirm] = useState(false);
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
  const wordAbandonOpenerRef = useRef<HTMLElement | null>(null);
  const snapshotReadRequestRef = useRef(0);
  const snapshotRef = useRef(snapshot);
  const settingsExpectedRef = useRef<VocabSettingsWriteSnapshot | null>(null);
  const itemExpectedByIdRef = useRef<VocabItemExpectedMap>(new Map());
  const itemWriteGuardRef = useRef<(next: VocabItemExpectedMap) => boolean>(() => false);
  const settingsDraftRef = useRef<VocabSettingsDraft | null>(null);
  const flushedSettingsDraftRevisionRef = useRef<number | null>(null);
  const pendingSettingsBundleRef = useRef<Readonly<{ requestId: number; bundle: VocabFactsReadBundle }> | null>(null);
  const pendingItemBundleRef = useRef<Readonly<{ requestId: number; bundle: VocabFactsReadBundle }> | null>(null);
  const settingsPrepareBindingRef = useRef<Readonly<{
    trigger: HTMLElement;
    revision: number | null;
    expected: VocabSettingsWriteSnapshot;
  }> | null>(null);
  const submittedSettingsRef = useRef<Readonly<{
    operationId: string;
    trigger: HTMLElement;
    revision: number | null;
    expected: VocabSettingsWriteSnapshot;
  }> | null>(null);
  const settingsFocusFrame = useRef<number | null>(null);
  const itemRecoveryOpenRef = useRef(false);
  const itemRecoveryOpenerRef = useRef<HTMLElement | null>(null);
  const itemRecoveryFocusFrame = useRef<number | null>(null);
  const snapshotReadFocusFrame = useRef<number | null>(null);
  const itemExitOpenerRef = useRef<HTMLElement | null>(null);
  const itemExitFocusFrame = useRef<number | null>(null);
  const itemHistoryGuardRef = useRef<string | null>(null);
  const itemHistoryRestoringRef = useRef(false);
  const itemHistoryConfirmAfterRestoreRef = useRef(false);
  const rememberItemRecoveryOpener = useCallback((trigger: HTMLButtonElement) => {
    itemRecoveryOpenerRef.current = trigger;
    itemRecoveryOpenRef.current = true;
    setItemRecoveryOpen(true);
  }, []);
  const restoreItemRecoveryFocus = useCallback(() => {
    if (itemRecoveryFocusFrame.current !== null) {
      window.cancelAnimationFrame(itemRecoveryFocusFrame.current);
    }
    itemRecoveryFocusFrame.current = window.requestAnimationFrame(() => {
      itemRecoveryFocusFrame.current = window.requestAnimationFrame(() => {
        itemRecoveryFocusFrame.current = null;
        const target = firstVocabItemRecoveryFocusTarget([
          itemRecoveryOpenerRef.current,
          document.querySelector<HTMLElement>(".sc-item-write-banner button:not(:disabled)"),
          document.querySelector<HTMLElement>(
            ".sc-main h1",
          ),
          document.querySelector<HTMLElement>(".sc-menu:not(:disabled)"),
        ], (candidate) => {
          if (
            !candidate.isConnected || candidate.hidden ||
            candidate.matches(":disabled") || candidate.getClientRects().length === 0
          ) return false;
          const style = window.getComputedStyle(candidate);
          return style.display !== "none" && style.visibility !== "hidden";
        });
        itemRecoveryOpenerRef.current = null;
        if (!target) return;
        if (target.matches("h1")) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      });
    });
  }, []);
  const restoreItemExitFocus = useCallback(() => {
    if (itemExitFocusFrame.current !== null) {
      window.cancelAnimationFrame(itemExitFocusFrame.current);
    }
    itemExitFocusFrame.current = window.requestAnimationFrame(() => {
      itemExitFocusFrame.current = window.requestAnimationFrame(() => {
        itemExitFocusFrame.current = null;
        const target = firstVocabItemRecoveryFocusTarget([
          itemExitOpenerRef.current,
          document.querySelector<HTMLElement>(
            ".sc-library .sc-page-title h1, .sc-reader h1, .sc-podcast-head h1, .sc-main h1",
          ),
          document.querySelector<HTMLElement>(".sc-menu:not(:disabled)"),
        ], (candidate) => {
          if (
            !candidate.isConnected || candidate === document.body || candidate.hidden ||
            candidate.matches(":disabled") || candidate.getClientRects().length === 0
          ) return false;
          const style = window.getComputedStyle(candidate);
          return style.display !== "none" && style.visibility !== "hidden";
        });
        itemExitOpenerRef.current = null;
        if (!target) return;
        if (target.matches("h1")) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      });
    });
  }, []);
  const sidebarOpener = useRef<HTMLButtonElement>(null);
  const sidebarFocusFrame = useRef<number | null>(null);
  const focusSidebarOpenerAfterClose = useCallback(() => {
    if (sidebarFocusFrame.current !== null) {
      window.cancelAnimationFrame(sidebarFocusFrame.current);
    }
    sidebarFocusFrame.current = window.requestAnimationFrame(() => {
      sidebarFocusFrame.current = window.requestAnimationFrame(() => {
        sidebarFocusFrame.current = null;
        const opener = sidebarOpener.current;
        if (!opener?.isConnected || opener.hidden || opener.getClientRects().length === 0) {
          return;
        }
        const style = window.getComputedStyle(opener);
        if (style.display === "none" || style.visibility === "hidden") return;
        opener.focus({ preventScroll: true });
      });
    });
  }, []);
  const closeMobileSidebar = useCallback(() => {
    const shouldRestoreFocus = mobile && sideOpen;
    setSideOpen(false);
    if (shouldRestoreFocus) focusSidebarOpenerAfterClose();
  }, [focusSidebarOpenerAfterClose, mobile, setSideOpen, sideOpen]);
  const sidebarDialog = useOverlayDialog<HTMLElement>(
    mobile && sideOpen,
    closeMobileSidebar,
    "button[data-sidebar-close]",
  );
  const closeItemExitConfirm = useCallback(() => {
    setItemExitConfirmOpen(false);
    restoreItemExitFocus();
  }, [restoreItemExitFocus]);
  const itemExitDialog = useOverlayDialog<HTMLElement>(
    itemExitConfirmOpen,
    closeItemExitConfirm,
    "[data-item-exit-stay]",
  );

  useEffect(() => () => {
    if (sidebarFocusFrame.current !== null) {
      window.cancelAnimationFrame(sidebarFocusFrame.current);
    }
    if (itemRecoveryFocusFrame.current !== null) {
      window.cancelAnimationFrame(itemRecoveryFocusFrame.current);
    }
    if (snapshotReadFocusFrame.current !== null) {
      window.cancelAnimationFrame(snapshotReadFocusFrame.current);
    }
    if (itemExitFocusFrame.current !== null) {
      window.cancelAnimationFrame(itemExitFocusFrame.current);
    }
  }, []);

  const applyVocabFactsBundle = useCallback((bundle: VocabFactsReadBundle) => {
    snapshotRef.current = bundle.snapshot;
    settingsExpectedRef.current = bundle.expected;
    itemExpectedByIdRef.current = bundle.itemExpectedById;
    setSnapshot(bundle.snapshot);
    setSettingsExpected(bundle.expected);
    setSnapshotReadStatus("ready");
    setSnapshotReadError("");
    setReady(true);
    pendingItemBundleRef.current = null;
    setItemExternalPending(false);
  }, []);

  const readVocabFacts = useCallback(async (): Promise<Readonly<{
    outcome: VocabSettingsRefreshOutcome;
    snapshot: VocabSnapshot;
  }>> => {
    const requestId = ++snapshotReadRequestRef.current;
    try {
      const bundle = await loadVocabFactsWithSettingsExpected();
      if (requestId !== snapshotReadRequestRef.current) {
        return { outcome: "superseded", snapshot: snapshotRef.current };
      }
      if (itemWriteGuardRef.current(bundle.itemExpectedById)) {
        pendingItemBundleRef.current = { requestId, bundle };
        setItemExternalPending(true);
        return { outcome: "deferred", snapshot: snapshotRef.current };
      }
      const draft = settingsDraftRef.current;
      if (draft) {
        const settingsChanged = !sameVocabSettingsExpectedState(draft.expected, bundle.expected);
        if (settingsChanged) {
          pendingSettingsBundleRef.current = { requestId, bundle };
          setSettingsExternalPending(true);
          return { outcome: "deferred", snapshot: snapshotRef.current };
        }
        const nextSnapshot = { ...bundle.snapshot, settings: draft.expected.settings };
        snapshotRef.current = nextSnapshot;
        itemExpectedByIdRef.current = bundle.itemExpectedById;
        setSnapshot(nextSnapshot);
        setSnapshotReadStatus("ready");
        setSnapshotReadError("");
        setReady(true);
        pendingSettingsBundleRef.current = null;
        pendingItemBundleRef.current = null;
        setItemExternalPending(false);
        setSettingsExternalPending(false);
        return { outcome: "applied", snapshot: nextSnapshot };
      }
      pendingSettingsBundleRef.current = null;
      setSettingsExternalPending(false);
      applyVocabFactsBundle(bundle);
      return { outcome: "applied", snapshot: bundle.snapshot };
    } catch (reason) {
      if (requestId === snapshotReadRequestRef.current) {
        setSnapshotReadStatus("stale");
        setSnapshotReadError(errorMessage(reason));
      }
      throw reason;
    }
  }, [applyVocabFactsBundle]);

  const retryVocabFactsRead = useCallback((trigger: HTMLButtonElement) => {
    setSnapshotReadError("");
    void readVocabFacts().catch(() => undefined).finally(() => {
      if (snapshotReadFocusFrame.current !== null) {
        window.cancelAnimationFrame(snapshotReadFocusFrame.current);
      }
      snapshotReadFocusFrame.current = window.requestAnimationFrame(() => {
        snapshotReadFocusFrame.current = window.requestAnimationFrame(() => {
          snapshotReadFocusFrame.current = null;
          const target = firstVocabItemRecoveryFocusTarget([
            trigger,
            document.querySelector<HTMLElement>(".sc-item-truth-notice button:not(:disabled)"),
            document.querySelector<HTMLElement>(".sc-main h1"),
            document.querySelector<HTMLElement>(".sc-menu:not(:disabled)"),
          ], (candidate) => candidate.isConnected && !candidate.hidden &&
            !candidate.matches(":disabled") && candidate.getClientRects().length > 0 &&
            window.getComputedStyle(candidate).visibility !== "hidden");
          if (!target) return;
          if (target.matches("h1")) target.tabIndex = -1;
          target.focus({ preventScroll: true });
        });
      });
    });
  }, [readVocabFacts]);

  const readAndApplySnapshot = useCallback(async () => {
    const result = await readVocabFacts();
    if (result.outcome === "superseded") throw new VocabSnapshotSupersededError();
    return result.snapshot;
  }, [readVocabFacts]);

  const refresh = useCallback(async () => {
    await readAndApplySnapshot();
  }, [readAndApplySnapshot]);

  const refreshSettingsFacts = useCallback(async (): Promise<VocabSettingsRefreshOutcome> => {
    return (await readVocabFacts()).outcome;
  }, [readVocabFacts]);

  const refreshItemFacts = useCallback(async (): Promise<VocabItemRefreshOutcome> => {
    return (await readVocabFacts()).outcome;
  }, [readVocabFacts]);

  const getItemExpected = useCallback((itemId: string) => {
    return itemExpectedByIdRef.current.get(itemId) ?? null;
  }, []);

  const clearSettingsDraft = useCallback(() => {
    settingsDraftRef.current = null;
    flushedSettingsDraftRevisionRef.current = null;
    setSettingsDraft(null);
  }, []);

  const rememberPreparedSettings = useCallback((receipt: VocabSettingsWriteReceipt) => {
    const binding = settingsPrepareBindingRef.current;
    settingsPrepareBindingRef.current = null;
    if (!binding || !sameVocabSettingsExpectedState(binding.expected, receipt.before)) return;
    submittedSettingsRef.current = {
      operationId: receipt.operationId,
      trigger: binding.trigger,
      revision: binding.revision,
      expected: binding.expected,
    };
  }, []);

  const consumeCommittedSettingsDraft = useCallback((receipt: VocabSettingsWriteReceipt) => {
    const submitted = submittedSettingsRef.current;
    const draft = settingsDraftRef.current;
    if (!submitted || submitted.operationId !== receipt.operationId || submitted.revision === null ||
        !draft || draft.revision !== submitted.revision || draft.expected !== submitted.expected ||
        !sameVocabSettingsExpectedState(draft.expected, receipt.before) ||
        !sameVocabSettings(draft.settings, receipt.after.settings)) return;
    clearSettingsDraft();
    pendingSettingsBundleRef.current = null;
    setSettingsExternalPending(false);
  }, [clearSettingsDraft]);

  const settleSettingsWrite = useCallback((receipt: VocabSettingsWriteReceipt) => {
    const submitted = submittedSettingsRef.current;
    if (!submitted || submitted.operationId !== receipt.operationId) return;
    submittedSettingsRef.current = null;
    settingsPrepareBindingRef.current = null;
    setSettingsRecoveryOpen(false);
    setSettingsWriteNotice("");
    if (settingsFocusFrame.current !== null) window.cancelAnimationFrame(settingsFocusFrame.current);
    settingsFocusFrame.current = window.requestAnimationFrame(() => {
      settingsFocusFrame.current = window.requestAnimationFrame(() => {
        settingsFocusFrame.current = null;
        const trigger = submitted.trigger;
        const target = trigger.isConnected && trigger.getClientRects().length > 0
          ? trigger
          : document.querySelector<HTMLElement>(".sc-settings-page .sc-page-title h1, .sc-podcast-head h1, .sc-page .sc-page-title h1");
        if (!target?.isConnected || target.getClientRects().length === 0) return;
        if (target.matches("h1")) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      });
    });
  }, []);

  const settingsWrites = useVocabSettingsWriteFlow({
    refresh: refreshSettingsFacts,
    onToast: setToast,
    onAttention: () => setSettingsRecoveryOpen(true),
    onDurablePrepared: rememberPreparedSettings,
    onDurableCommitted: consumeCommittedSettingsDraft,
    onDurableSettled: settleSettingsWrite,
  });
  const settingsDatabaseWriteLocked = settingsWrites.writeLocked ||
    settingsWrites.operationInProgress();
  const itemWrites = useVocabItemWriteFlow({
    refresh: refreshItemFacts,
    getExpected: getItemExpected,
    externalWriteLocked: settingsDatabaseWriteLocked ||
      snapshotReadStatus !== "ready",
    onToast: setToast,
    onAttention: (background) => {
      if (!background) {
        if (!itemRecoveryOpenRef.current) {
          const active = document.activeElement instanceof HTMLElement &&
              document.activeElement !== document.body &&
              !document.activeElement.closest(".sc-item-write-recovery")
            ? document.activeElement
            : null;
          itemRecoveryOpenerRef.current = active;
        }
        itemRecoveryOpenRef.current = true;
        setItemRecoveryOpen(true);
      }
    },
  });
  useEffect(() => {
    itemWriteGuardRef.current = itemWrites.shouldDeferBundle;
  }, [itemWrites.shouldDeferBundle]);
  const effectiveLocalLock = vocabSettingsOutboundBlocked(
    snapshot.settings.local_lock,
    settingsWrites.journal.loaded,
    settingsWrites.busy,
    settingsWrites.journal.storageUnavailable,
    settingsWrites.journal.unreadable.length,
    settingsWrites.journal.entries.length,
  );
  const settingsOutboundBlocked = useCallback(() => vocabSettingsOutboundBlocked(
    snapshotRef.current.settings.local_lock,
    settingsWrites.journal.loaded,
    settingsWrites.busy,
    settingsWrites.journal.storageUnavailable,
    settingsWrites.journal.unreadable.length,
    settingsWrites.journal.entries.length,
    settingsWrites.operationInProgress(),
  ), [settingsWrites]);

  const updateSettingsDraft = useCallback((patch: Partial<VocabSettings>) => {
    if (snapshotReadStatus !== "ready" || settingsWrites.writeLocked || settingsWrites.operationInProgress()) return;
    const current = settingsDraftRef.current;
    const expected = current?.expected ?? settingsExpectedRef.current;
    if (!expected || (!current && snapshotRef.current.settings !== expected.settings)) {
      setSnapshotReadStatus("stale");
      setSettingsWriteNotice("设置与安全读取凭据没有成对就绪；没有改动草稿，请先只重新读取。");
      return;
    }
    const next: VocabSettingsDraft = {
      settings: { ...(current?.settings ?? expected.settings), ...patch },
      expected,
      revision: (current?.revision ?? 0) + 1,
    };
    settingsDraftRef.current = next;
    setSettingsDraft(next);
    setSettingsWriteNotice("");
  }, [settingsWrites, snapshotReadStatus]);

  const requestSettingsSave = useCallback(async (
    next: VocabSettings,
    expected: VocabSettingsWriteSnapshot,
    trigger: HTMLElement,
    revision: number | null,
  ) => {
    if (snapshotReadStatus !== "ready" || settingsWrites.writeLocked || settingsWrites.operationInProgress() ||
        settingsExpectedRef.current !== expected || snapshotRef.current.settings !== expected.settings) {
      setSnapshotReadStatus("stale");
      setSettingsWriteNotice("当前设置与安全读取凭据不再属于同一次读取；仍显示上次确认内容，请先只重新读取。");
      return;
    }
    setSettingsWriteNotice("");
    const binding = { trigger, revision, expected } as const;
    settingsPrepareBindingRef.current = binding;
    try {
      await settingsWrites.start(
        () => prepareVocabSettingsSave(next, expected),
        "设置已保存在当前浏览器的本地词库",
      );
    } catch (reason) {
      setSnapshotReadStatus("stale");
      setSettingsWriteNotice(reason instanceof VocabSettingsMutationError && reason.code === "changed"
        ? "另一页已经更新了设置；这次没有写入，当前草稿仍保留。请明确放弃草稿后只重新读取。"
        : `${errorMessage(reason)} 没有确认安全收据是否完整保留；当前显示不会冒充已保存。`);
    } finally {
      if (settingsPrepareBindingRef.current === binding) settingsPrepareBindingRef.current = null;
    }
  }, [settingsWrites, snapshotReadStatus]);

  const submitSettingsDraft = useCallback((trigger: HTMLElement) => {
    const draft = settingsDraftRef.current;
    if (!draft || !claimVocabSettingsDraftFlush(flushedSettingsDraftRevisionRef, draft)) return;
    void requestSettingsSave(draft.settings, draft.expected, trigger, draft.revision);
  }, [requestSettingsSave]);

  const requestSettingsChange = useCallback((
    patch: Partial<VocabSettings>,
    trigger: HTMLElement,
  ) => {
    if (settingsDraftRef.current) {
      if (!settingsWrites.operationInProgress()) {
        setSettingsWriteNotice("先松开或离开正在调整的滑块；这次开关没有另起一笔写入。");
      }
      return;
    }
    const expected = settingsExpectedRef.current;
    if (!expected) {
      setSnapshotReadStatus("stale");
      setSettingsWriteNotice("设置读取凭据尚未就绪；开关没有改动。");
      return;
    }
    void requestSettingsSave({ ...expected.settings, ...patch }, expected, trigger, null);
  }, [requestSettingsSave, settingsWrites]);

  const discardSettingsDraftAndRead = useCallback(() => {
    clearSettingsDraft();
    const pending = pendingSettingsBundleRef.current;
    pendingSettingsBundleRef.current = null;
    setSettingsExternalPending(false);
    setSettingsWriteNotice("");
    if (pending && pending.requestId === snapshotReadRequestRef.current) {
      if (itemWriteGuardRef.current(pending.bundle.itemExpectedById)) {
        pendingItemBundleRef.current = pending;
        setItemExternalPending(true);
        return;
      }
      applyVocabFactsBundle(pending.bundle);
      return;
    }
    void readVocabFacts().catch((reason) => {
      setSettingsWriteNotice(`${errorMessage(reason)} 仍显示上次成功读取的设置。`);
    });
  }, [applyVocabFactsBundle, clearSettingsDraft, readVocabFacts]);

  const rereadSettingsTruth = useCallback(() => {
    if (settingsDraftRef.current) {
      discardSettingsDraftAndRead();
      return;
    }
    setSettingsWriteNotice("");
    void readVocabFacts().catch((reason) => {
      setSettingsWriteNotice(`${errorMessage(reason)} 仍显示上次成功读取的设置。`);
    });
  }, [discardSettingsDraftAndRead, readVocabFacts]);

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
        const data = await readAndApplySnapshot();
        if (!live) return;
        setShowChinese(data.settings.chinese_explanation);
        setActiveItemId(data.items.find((item) => item.status === "in_progress")?.id ?? data.items[0]?.id ?? null);
        void refreshStorageStatus().catch(() => undefined);
      } catch (error) {
        if (live) setFatal(errorMessage(error));
      }
    })();
    return () => {
      live = false;
      snapshotReadRequestRef.current += 1;
    };
  }, [readAndApplySnapshot, refreshStorageStatus]);

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

  useEffect(() => {
    if (!ready) return;
    return subscribeVocabChanges(() => { void refresh().catch(() => undefined); });
  }, [ready, refresh]);

  useEffect(() => {
    if (!ready) return;
    const refreshVisibleFacts = () => { void refresh().catch(() => undefined); };
    const onVisibility = () => { if (document.visibilityState === "visible") refreshVisibleFacts(); };
    window.addEventListener("focus", refreshVisibleFacts);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refreshVisibleFacts);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ready, refresh]);

  useEffect(() => {
    if (!settingsDraft) return;
    const protectDraft = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [settingsDraft]);

  useEffect(() => () => {
    if (settingsFocusFrame.current !== null) window.cancelAnimationFrame(settingsFocusFrame.current);
  }, []);

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

  useEffect(() => {
    if (effectiveLocalLock) aiRequest.current?.controller.abort();
  }, [effectiveLocalLock]);

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

  const cancelWordAbandon = useCallback(() => {
    setWordAbandonConfirm(false);
    setWordSaveMessage("恢复提醒会继续保留；词库和查询次数都没有改动。");
    window.requestAnimationFrame(() => {
      const opener = wordAbandonOpenerRef.current;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    });
  }, []);

  const requestCloseSelection = useCallback(() => {
    if (wordAbandonConfirm) {
      cancelWordAbandon();
      return;
    }
    clearSelection();
  }, [cancelWordAbandon, clearSelection, wordAbandonConfirm]);

  useEffect(() => {
    if (!wordAbandonConfirm) return;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[data-word-reminder-keep]")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [wordAbandonConfirm]);

  useEffect(() => () => aiRequest.current?.controller.abort(), []);

  const go = useCallback((next: VocabView) => {
    setView(next); closeMobileSidebar();
    if (next !== "reader" && next !== "podcast") clearSelection();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
  }, [clearSelection, closeMobileSidebar]);

  const openItem = useCallback((item: LibraryItem) => {
    setActiveItemId(item.id);
    setView(item.kind === "article" ? "reader" : "podcast");
    clearSelection();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
  }, [clearSelection]);

  const askAiFor = useCallback(async (target: SelectionTarget, includeChinese: boolean) => {
    const key = selectionIdentity(target);
    if (settingsOutboundBlocked()) {
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
  }, [settingsOutboundBlocked]);

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
    if (settingsOutboundBlocked()) { setAiError("本地锁已开启或正在安全确认；没有发送内容。"); return; }
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
  }, [explanation, settingsOutboundBlocked]);

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

  const requestAbandonConflictedWord = useCallback(() => {
    if (wordSaveBusyRef.current) return;
    wordAbandonOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setWordAbandonConfirm(true);
    setWordSaveMessage(
      "只结束这条提醒吗？这不会改动词库、查询次数或任何已保存内容。",
    );
  }, []);

  const abandonConflictedWord = useCallback(async () => {
    if (wordSaveBusyRef.current) return;
    const receipt = occurrenceRecoveryRef.current ?? pendingOccurrenceRef.current?.receipt;
    if (!receipt) return;
    if (!removeOccurrenceRecovery(receipt)) {
      setWordSaveMessage("提醒已发生变化或暂时无法访问，因此没有移除。可以稍后再次只读核对。");
      return;
    }
    setWordAbandonConfirm(false);
    occurrenceRecoveryRef.current = null;
    setOccurrenceRecovery(null);
    pendingOccurrenceRef.current = null;
    if (!activateNextOccurrenceRecovery()) {
      setWordSavePhase("idle");
      setWordSaveMessage("只移除了这条恢复提醒；词库和查询次数都没有改动。");
    }
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[data-word-recovery-primary]:not(:disabled), .sc-menu:not(:disabled)")?.focus({ preventScroll: true });
    });
  }, [activateNextOccurrenceRecovery]);

  const wordPrimaryAction = useCallback((note = "") => {
    if (wordSavePhase === "uncertain") return inspectPendingWord();
    if (wordSavePhase === "conflict") return requestAbandonConflictedWord();
    if (wordSavePhase === "refresh_failed") return refreshCommittedWord();
    return savePickedWord(note);
  }, [inspectPendingWord, refreshCommittedWord, requestAbandonConflictedWord, savePickedWord, wordSavePhase]);

  const queueItemCheckpoint = itemWrites.queueCheckpoint;
  const recordItemProgressCandidate = useCallback((item: LibraryItem, progress: number) => {
    return queueItemCheckpoint(item, progress);
  }, [queueItemCheckpoint]);

  const discardItemCheckpointsAndRefresh = itemWrites.discardCheckpointsAndRefresh;
  const discardAllItemCheckpoints = itemWrites.discardCheckpoints;
  const allowDiscardedItemNavigation = itemWrites.allowDiscardedNavigation;
  const itemOperationInProgress = itemWrites.operationInProgress;
  const itemWriteBusy = itemWrites.busy;
  const itemHasDirtyCheckpoint = itemWrites.hasDirtyCheckpoint;
  const itemHasVolatileReceipt = itemWrites.hasVolatileHeldReceipt;
  const discardItemPositionsAndReadLatest = useCallback(async (
    trigger: HTMLButtonElement,
  ) => {
    await discardItemCheckpointsAndRefresh(true, trigger);
  }, [discardItemCheckpointsAndRefresh]);

  const requestSuiteExit = useCallback((event: ReactMouseEvent<HTMLAnchorElement>) => {
    const decision = vocabItemExitDecision(
      itemWriteBusy || itemOperationInProgress() || itemHasVolatileReceipt,
      itemHasDirtyCheckpoint,
    );
    if (decision === "leave") {
      if (itemHistoryGuardRef.current !== null) {
        event.preventDefault();
        itemHistoryGuardRef.current = null;
        window.location.replace("/");
      }
      return;
    }
    event.preventDefault();
    if (decision === "block") {
      setToast("正在安全确认条目；结果明确前先留在本页。");
      return;
    }
    itemExitOpenerRef.current = event.currentTarget;
    setItemExitDestination("suite");
    setItemExitConfirmOpen(true);
  }, [itemHasDirtyCheckpoint, itemHasVolatileReceipt, itemOperationInProgress, itemWriteBusy]);

  useEffect(() => {
    const hasRisk = itemWriteBusy || itemOperationInProgress() ||
      itemHasDirtyCheckpoint || itemHasVolatileReceipt;
    if (hasRisk && itemHistoryGuardRef.current === null) {
      const token = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `vocab-item-${Date.now()}`;
      const current = window.history.state;
      const state = current && typeof current === "object"
        ? { ...current, [VOCAB_ITEM_HISTORY_GUARD]: token }
        : { [VOCAB_ITEM_HISTORY_GUARD]: token };
      window.history.pushState(state, "", window.location.href);
      itemHistoryGuardRef.current = token;
    }
    const token = itemHistoryGuardRef.current;
    if (!token) return;
    // popstate cannot cancel an arbitrary multi-entry history.go jump. This
    // sentinel protects normal one-step Back/Forward; beforeunload protects a
    // document exit while volatile work is still present.
    const onPopState = () => {
      if (itemHistoryGuardRef.current !== token) return;
      if (itemHistoryRestoringRef.current) {
        itemHistoryRestoringRef.current = false;
        if (itemHistoryConfirmAfterRestoreRef.current) {
          itemHistoryConfirmAfterRestoreRef.current = false;
          const active = document.activeElement;
          itemExitOpenerRef.current = active instanceof HTMLElement &&
              active !== document.body && !active.closest(".sc-item-exit-dialog")
            ? active
            : null;
          setItemExitDestination("history");
          setItemExitConfirmOpen(true);
        }
        return;
      }
      const current = window.history.state;
      if (
        current && typeof current === "object" &&
        current[VOCAB_ITEM_HISTORY_GUARD] === token
      ) return;
      const decision = vocabItemHistoryBackDecision(
        itemWriteBusy || itemOperationInProgress() || itemHasVolatileReceipt,
        itemHasDirtyCheckpoint,
      );
      if (decision === "continue") {
        itemHistoryGuardRef.current = null;
        window.queueMicrotask(() => window.history.back());
        return;
      }
      itemHistoryRestoringRef.current = true;
      itemHistoryConfirmAfterRestoreRef.current = decision === "restore-confirm";
      window.history.forward();
      if (decision === "restore-block") {
        setToast("正在安全确认条目；结果明确前已阻止离开本页。");
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [itemHasDirtyCheckpoint, itemHasVolatileReceipt, itemOperationInProgress, itemWriteBusy]);

  const abandonItemPositionAndLeaveSuite = useCallback(() => {
    if (itemWriteBusy || itemOperationInProgress() || itemHasVolatileReceipt) return;
    const guarded = itemHistoryGuardRef.current !== null;
    discardAllItemCheckpoints();
    allowDiscardedItemNavigation();
    itemHistoryGuardRef.current = null;
    setItemExitConfirmOpen(false);
    if (guarded) window.location.replace("/");
    else window.location.assign("/");
  }, [allowDiscardedItemNavigation, discardAllItemCheckpoints, itemHasVolatileReceipt, itemOperationInProgress, itemWriteBusy]);

  const abandonItemPositionAndContinueHistory = useCallback(() => {
    if (itemWriteBusy || itemOperationInProgress() || itemHasVolatileReceipt) return;
    discardAllItemCheckpoints();
    setItemExitConfirmOpen(false);
    const guarded = itemHistoryGuardRef.current !== null;
    itemHistoryGuardRef.current = null;
    window.history.go(guarded ? -2 : -1);
  }, [discardAllItemCheckpoints, itemHasVolatileReceipt, itemOperationInProgress, itemWriteBusy]);

  useEffect(() => {
    if (!itemRecoveryOpen || itemWrites.flow.phase !== "idle") return;
    if (
      itemWrites.journal.storageUnavailable || itemWrites.journal.lockUnavailable ||
      itemWrites.journal.entries.length > 0 || itemWrites.journal.unreadable.length > 0 ||
      itemWrites.hasHeldReceipt
    ) return;
    const frame = window.requestAnimationFrame(() => {
      itemRecoveryOpenRef.current = false;
      setItemRecoveryOpen(false);
      restoreItemRecoveryFocus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [itemRecoveryOpen, itemWrites.flow.phase, itemWrites.hasHeldReceipt, itemWrites.journal, restoreItemRecoveryFocus]);

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

  const refreshAfterBackupActivation = useCallback(async () => {
    await initializeVocabDatabase();
    await refresh();
    await refreshStorageStatus().catch(() => null);
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
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [askAi, selection, wordPrimaryAction]);

  if (fatal) return <main className="shici sc-fatal"><Logo /><section><span>词库暂时没有完整打开</span><h1>你的内容没有被改动。</h1><p>{fatal}</p><button onClick={() => window.location.reload()}>重新尝试</button></section></main>;
  if (!ready) return <Loader />;

  const pageLabel = navigation.find((entry) => entry.id === view)?.label ?? (view === "reader" ? "阅读" : view === "podcast" ? "收听" : "设置");
  const persistenceSupported = supportsPersistentLocalStorage();
  const sidebarHidden = mobile && !sideOpen;
  const displayedSettings = settingsDraft?.settings ?? snapshot.settings;
  const settingsPairBound = settingsExpected !== null && snapshot.settings === settingsExpected.settings &&
    (!settingsDraft || settingsDraft.expected === settingsExpected);
  const settingsControlsLocked = snapshotReadStatus !== "ready" || !settingsPairBound || settingsWrites.writeLocked;
  const itemWritePermanentReadOnly = snapshotReadStatus !== "ready" ||
    !itemWrites.journal.loaded || itemWrites.journal.storageUnavailable ||
    itemWrites.journal.lockUnavailable || itemWrites.journal.unreadable.length > 0 ||
    itemWrites.hasConflictedCheckpoint;
  const itemDatabaseMutationLocked = itemWrites.busy || itemWrites.operationInProgress() ||
    itemWrites.hasDirtyCheckpoint || itemWrites.hasConflictedCheckpoint ||
    itemWrites.hasHeldReceipt ||
    !itemWrites.journal.loaded || itemWrites.journal.storageUnavailable ||
    itemWrites.journal.lockUnavailable || itemWrites.journal.entries.length > 0 ||
    itemWrites.journal.unreadable.length > 0;
  const settingsControlStatus = settingsWrites.busy
    ? "正在安全确认设置；结果明确前不会开始另一笔写入。"
    : snapshotReadStatus !== "ready"
      ? "当前显示上次成功读取的设置；明确重新读取前，设置控件保持停用。"
      : !settingsPairBound
        ? "设置与安全读取凭据没有成对就绪；没有据此写入。"
        : settingsWrites.writeLocked
          ? "先处理页面上方的设置核对提醒；当前确认内容仍完整显示。"
          : settingsExternalPending
            ? "另一页的设置已经变化；当前滑块草稿仍按开始调整时的完整设置保留，不会自动重签。"
            : settingsDraft
              ? "这只是尚未确认的本地预览；松开滑块或离开控件时才会准备一张安全收据。"
              : "";
  const globalSettingsNotice = settingsWriteNotice || (settingsExternalPending
    ? "另一页有更新的设置；当前草稿与原读取凭据仍成对保留。"
    : "");
  return <main className="shici" style={{ "--reader-scale": displayedSettings.font_scale, "--reader-leading": displayedSettings.line_height } as CSSProperties}>
    <aside ref={sidebarDialog} id="sc-navigation" className={`sc-sidebar ${sideOpen ? "open" : ""}`} role={mobile && sideOpen ? "dialog" : undefined} aria-modal={mobile && sideOpen ? true : undefined} aria-label="拾词导航" aria-hidden={sidebarHidden || undefined} inert={sidebarHidden || undefined} tabIndex={sidebarHidden ? -1 : mobile && sideOpen ? -1 : undefined}>
      <button data-sidebar-close className="sc-sidebar-close" tabIndex={sidebarHidden ? -1 : undefined} onClick={closeMobileSidebar} aria-label="关闭导航">×</button>
      <Link href="/" className="sc-brand" aria-label="返回私人工作台" tabIndex={sidebarHidden ? -1 : undefined} onClick={requestSuiteExit}><Logo /></Link>
      <nav>{navigation.map((item) => <button key={item.id} tabIndex={sidebarHidden ? -1 : undefined} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "active" : ""} onClick={() => go(item.id)}><i>{item.glyph}</i><span>{item.label}</span></button>)}</nav>
      <div className="sc-side-foot"><button tabIndex={sidebarHidden ? -1 : undefined} className={view === "settings" ? "active" : ""} onClick={() => go("settings")}><i>设</i><span>设置</span></button><div><i className={storageStatus?.persisted === true ? "persisted" : ""} /><span>当前浏览器<small>{storageStatus?.persisted === true ? "已获持久化保护" : !persistenceSupported ? "未提供持久化保护接口" : storageStatus?.persisted === false ? "请定期导出备份" : "保护状态暂时未知"}</small></span></div></div>
    </aside>
    <section className="sc-main">
      <header className="sc-topbar"><button ref={sidebarOpener} className="sc-menu" onClick={() => setSideOpen((value) => !value)} aria-expanded={sideOpen} aria-controls="sc-navigation" aria-label={sideOpen ? "关闭导航" : "打开导航"}>拾</button><div className="sc-crumb"><span>拾词</span><b>/</b><strong>{pageLabel}</strong></div><div className="sc-top-actions"><button className="sc-search-jump" aria-label="搜索资料、词和语境" onClick={() => setSearchOpen(true)}>⌕ <span>搜索</span><kbd>⌘ K</kbd></button><button className="sc-import" aria-label="导入内容" onClick={() => setImportOpen(true)}>＋ <span>导入内容</span></button></div></header>
      <VocabSettingsWriteBanner controller={settingsWrites} />
      {settingsRecoveryOpen && <VocabSettingsWriteRecovery controller={settingsWrites} />}
      <VocabItemWriteBanner controller={itemWrites} onOpen={rememberItemRecoveryOpener} />
      {itemRecoveryOpen && <VocabItemWriteRecovery controller={itemWrites} />}
      {snapshotReadStatus === "stale" && !itemExternalPending &&
        !settingsExternalPending && !globalSettingsNotice &&
        <section className="sc-item-truth-notice sc-snapshot-read-notice" role="alert">
          <span>{snapshotReadError
            ? `${snapshotReadError} 当前仍显示上次成功读取的完整资料；所有条目写入保持暂停。`
            : "当前仍显示上次成功读取的完整资料；所有条目写入保持暂停。"}</span>
          <button type="button" disabled={itemWrites.busy || settingsWrites.busy} onClick={(event) => retryVocabFactsRead(event.currentTarget)}>只重新读取</button>
        </section>}
      {itemExternalPending && <section className="sc-item-truth-notice" role="status"><span>另一页的条目已经变化；当前阅读位置仍按原完整条目保留，没有拼接或覆盖。</span><button type="button" disabled={itemWrites.busy} onClick={(event) => void discardItemPositionsAndReadLatest(event.currentTarget)}>放弃本页位置并读取最新</button></section>}
      {globalSettingsNotice && <section className="sc-settings-truth-notice" role="status"><span>{globalSettingsNotice}</span><button type="button" disabled={settingsWrites.busy} onClick={rereadSettingsTruth}>{settingsDraft ? "放弃草稿并读取最新设置" : "只重新读取"}</button></section>}
      <div className="sc-view">
        {view === "today" && <TodayView snapshot={snapshot} due={dueCards.length} onOpen={openItem} onGo={go} onImport={() => setImportOpen(true)} onWord={setWordId} />}
        {view === "library" && <LibraryView items={snapshot.items} itemWriteLocked={snapshotReadStatus !== "ready" || itemWrites.writeLocked} itemWriteBusy={itemWrites.busy} itemWriteStatus={itemWrites.error || itemWrites.status} onOpen={openItem} onImport={() => setImportOpen(true)} onArchive={(item, trigger) => void itemWrites.startLifecycle(item.status === "archived" ? "restore" : "archive", item, trigger)} />}
        {view === "reader" && <ReaderView item={activeItem?.kind === "article" ? activeItem : snapshot.items.find((item) => item.kind === "article") ?? null} blocks={snapshot.blocks} occurrences={snapshot.occurrences} bookmarks={snapshot.bookmarks} itemWriteLocked={snapshotReadStatus !== "ready" || itemWrites.writeLocked} itemWriteBusy={itemWrites.busy} itemWriteStatus={itemWrites.error || itemWrites.status} onSelect={selectText} onBack={() => go("library")} onProgress={recordItemProgressCandidate} onFinish={(item, trigger) => void itemWrites.startLifecycle("complete", item, trigger)} onBookmark={async (item, block) => { await createBookmark(item.id, block?.id ?? "top", block?.text.slice(0, 30) ?? item.title); await refresh(); setToast("已收藏当前位置"); }} />}
        {view === "podcast" && <PodcastView key={(activeItem?.kind === "podcast" ? activeItem : snapshot.items.find((item) => item.kind === "podcast"))?.id ?? "empty-podcast"} item={activeItem?.kind === "podcast" ? activeItem : snapshot.items.find((item) => item.kind === "podcast") ?? null} segments={snapshot.segments} occurrences={snapshot.occurrences} autoFollow={snapshot.settings.auto_follow} autoFollowWriteLocked={settingsControlsLocked} autoFollowWriteBusy={settingsWrites.busy} autoFollowStatus={settingsControlStatus} itemWriteLocked={snapshotReadStatus !== "ready" || itemWrites.writeLocked} itemWritePermanentReadOnly={itemWritePermanentReadOnly} itemWriteBusy={itemWrites.busy} itemWriteStatus={itemWrites.error || itemWrites.status} localLock={effectiveLocalLock} onAutoFollow={(value, trigger) => requestSettingsChange({ auto_follow: value }, trigger)} onSelect={selectText} onProgress={recordItemProgressCandidate} onFinish={(item, trigger) => void itemWrites.startLifecycle("complete", item, trigger)} onBookmark={async (item, ms, label) => { await createBookmark(item.id, `t:${ms}`, label); await refresh(); setToast("已收藏此刻"); }} />}
        {view === "words" && <WordsView lexemes={snapshot.lexemes} occurrences={snapshot.occurrences} onOpen={setWordId} onStar={async (word) => { await toggleLexemeStar(word.id, !word.starred); await refresh(); }} />}
        {view === "review" && <ReviewView cards={snapshot.reviewCards} onRefresh={refresh} onGo={go} />}
        {view === "stats" && <StatsView snapshot={snapshot} />}
        {view === "settings" && <SettingsView settings={displayedSettings} settingsDraftDirty={Boolean(settingsDraft)} settingsWriteLocked={settingsControlsLocked} settingsWriteBusy={settingsWrites.busy} databaseMutationLocked={itemDatabaseMutationLocked} settingsWriteStatus={settingsControlStatus} storage={storageStatus} persistenceSupported={persistenceSupported} onDraftChange={updateSettingsDraft} onDraftCommit={submitSettingsDraft} onToggle={(patch, trigger) => requestSettingsChange(patch, trigger)} onDiscardDraft={discardSettingsDraftAndRead} onExport={exportBackup} onRestoreRefresh={refreshAfterBackupActivation} onPersist={async () => { const granted = await requestPersistentLocalStorage(); const checked = await refreshStorageStatus(); return checked.persisted ?? granted; }} onTestAi={async () => { if (settingsOutboundBlocked()) throw new Error("本地锁已开启或正在安全确认；没有发出检查请求"); const response = await fetch("/api/health", { headers: { Accept: "application/json" } }); const health = await response.json() as { ai?: { configured?: boolean } }; if (!response.ok) throw new Error("无法检查 AI 服务状态"); if (!health.ai?.configured) throw new Error("DeepSeek API Key 尚未配置"); }} />}
      </div>
    </section>
    <nav className="sc-mobile-tabs" aria-label="拾词页面">{navigation.slice(0, 4).map((item) => <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "active" : ""} onClick={() => go(item.id)}><i>{item.glyph}</i><span>{item.label}</span></button>)}</nav>
    {selection && <ContextPanel target={selection} explanation={explanation} loading={aiBusy} error={aiError} showChinese={showChinese} saveBusy={wordSaveBusy} saveLabel={wordSavePhase === "uncertain" ? "只读核对" : wordSavePhase === "conflict" ? "移除这条提醒" : wordSavePhase === "refresh_failed" ? "只刷新词库" : "＋ 收入词库"} saveMessage={wordSaveMessage} confirmReminderRemoval={wordAbandonConfirm} onChinese={async (value) => { setShowChinese(value); if (value && explanation && !explanation.sense?.explanation_zh) await addChinese(); }} onExplain={() => void askAi()} onSave={wordPrimaryAction} onCancelReminderRemoval={cancelWordAbandon} onConfirmReminderRemoval={abandonConflictedWord} onClose={requestCloseSelection} />}
    {wordId && <WordDetail key={wordId} word={snapshot.lexemes.find((word) => word.id === wordId) ?? null} occurrences={snapshot.occurrences.filter((item) => item.lexeme_id === wordId)} onClose={() => setWordId(null)} onNote={async (id, note) => { await saveLexemeNote(id, note); await refresh(); setToast("笔记已保存"); }} onStatus={async (id, status) => { await updateLexemeStatus(id, status); await refresh(); }} />}
    {importOpen && <ImportWizard localLock={effectiveLocalLock} onClose={() => setImportOpen(false)} onImported={async (id) => { const data = await readAndApplySnapshot(); setImportOpen(false); const item = data.items.find((entry) => entry.id === id); if (item) openItem(item); setToast("内容已存入本地资料库"); }} />}
    {searchOpen && <SearchPalette snapshot={snapshot} onClose={() => setSearchOpen(false)} onOpenItem={openItem} onOpenWord={(id) => { setWordId(id); }} />}
    {itemExitConfirmOpen && <>
      <div className="sc-item-exit-scrim" aria-hidden="true" />
      <section ref={itemExitDialog} className="sc-item-exit-dialog" role="dialog" aria-modal="true" aria-labelledby="sc-item-exit-title" tabIndex={-1}>
        <h2 id="sc-item-exit-title">还有未保存的阅读位置</h2>
        <p>默认留在本页继续安全保存。若现在离开，只会放弃本页尚未写入的位置；已保存资料和安全收据不会删除。</p>
        <footer>
          <button data-item-exit-stay type="button" onClick={closeItemExitConfirm}>继续留在本页</button>
          {itemExitDestination === "suite" ? <button className="danger" type="button" disabled={itemWrites.busy || itemWrites.hasVolatileHeldReceipt} onClick={abandonItemPositionAndLeaveSuite}>放弃本页位置并离开</button> : <button className="danger" type="button" disabled={itemWrites.busy || itemWrites.hasVolatileHeldReceipt} onClick={abandonItemPositionAndContinueHistory}>放弃本页位置并返回</button>}
        </footer>
      </section>
    </>}
    {!selection && !toast && (occurrenceRecovery || (wordSavePhase === "refresh_failed" && committedOccurrence)) && (wordAbandonConfirm ? <div className="sc-toast sc-toast-confirm" role="group" aria-label="是否只移除这条恢复提醒"><span>词库内容会原样保留</span><div><button data-word-reminder-keep onClick={cancelWordAbandon}>继续保留提醒</button><button className="danger" onClick={() => void abandonConflictedWord()}>只移除提醒</button></div></div> : <button data-word-recovery-primary className="sc-toast" disabled={wordSaveBusy} aria-label={wordSavePhase === "refresh_failed" ? "上次收词已保存，只刷新词库" : wordSavePhase === "conflict" ? "移除这条冲突提醒" : "只读核对上次收词结果"} onClick={() => void wordPrimaryAction()}><span>{wordSaveBusy ? "正在确认…" : wordSavePhase === "refresh_failed" ? "上次收词已保存" : wordSavePhase === "conflict" ? "发现冲突，不会改库" : "上次收词待核对"}</span>{wordSavePhase === "refresh_failed" ? "只刷新词库" : wordSavePhase === "conflict" ? "移除提醒" : "只读核对"}</button>)}
    {toast && <div className="sc-toast" role="status"><span>✓</span>{toast}</div>}
    {mobile && sideOpen && <button className="sc-nav-scrim" onClick={closeMobileSidebar} aria-label="关闭导航" />}
  </main>;
}
