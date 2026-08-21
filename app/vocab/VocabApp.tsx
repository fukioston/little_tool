"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { errorMessage, explainInChinese, explainSelection } from "@/lib/vocab/api";
import {
  createBookmark,
  exportVocabDatabase,
  getDueCards,
  importVocabDatabase,
  initializeVocabDatabase,
  loadVocabSnapshot,
  rateReview,
  saveLexemeNote,
  saveOccurrence,
  saveOccurrenceNote,
  saveSettings,
  toggleLexemeStar,
  undoReview,
  updateItemProgress,
  updateItemStatus,
  updateLexemeStatus,
} from "@/lib/vocab/store";
import type { AiExplanation, LibraryItem, ReviewCard, ReviewRating, SelectionTarget, VocabSettings, VocabSnapshot, VocabView } from "@/lib/vocab/types";
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
  const selectionRef = useRef<SelectionTarget | null>(null);
  const aiSequence = useRef(0);
  const aiRequest = useRef<{ id: number; key: string; controller: AbortController } | null>(null);
  const explanationKey = useRef<string | null>(null);
  const sidebarDialog = useOverlayDialog<HTMLElement>(sideOpen, () => setSideOpen(false), "button");

  const refresh = useCallback(async () => setSnapshot(await loadVocabSnapshot()), []);

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
      } catch (error) {
        if (live) setFatal(errorMessage(error));
      }
    })();
    return () => { live = false; };
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

  const clearSelection = useCallback(() => {
    cancelAi();
    selectionRef.current = null;
    explanationKey.current = null;
    setSelection(null);
    setExplanation(null);
    setAiError("");
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
    cancelAi();
    selectionRef.current = target;
    explanationKey.current = null;
    setSelection(target); setExplanation(null); setAiError("");
    const includeChinese = snapshot.settings.chinese_explanation;
    setShowChinese(includeChinese);
    void askAiFor(target, includeChinese);
  }, [askAiFor, cancelAi, snapshot.settings.chinese_explanation]);

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

  const savePickedWord = useCallback(async (note = "") => {
    const target = selectionRef.current;
    if (!target) return;
    try {
      const boundExplanation = explanationKey.current === selectionIdentity(target) ? explanation : null;
      const saved = await saveOccurrence(target, boundExplanation);
      if (note.trim()) await saveOccurrenceNote(saved.occurrenceId, note.trim());
      await refresh();
      setToast(`已把 “${target.surface}” 收入词库`);
      clearSelection();
    } catch (error) { setAiError(errorMessage(error)); }
  }, [clearSelection, explanation, refresh]);

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
      if (event.key.toLowerCase() === "s" && selection) void savePickedWord();
      if (event.key === "Escape") { clearSelection(); setWordId(null); setImportOpen(false); setSearchOpen(false); }
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [askAi, clearSelection, savePickedWord, selection]);

  if (fatal) return <main className="shici sc-fatal"><Logo /><section><span>数据库未能打开</span><h1>你的内容没有被改动。</h1><p>{fatal}</p><button onClick={() => window.location.reload()}>重新尝试</button></section></main>;
  if (!ready) return <Loader />;

  const pageLabel = navigation.find((entry) => entry.id === view)?.label ?? (view === "reader" ? "阅读" : view === "podcast" ? "收听" : "设置");
  return <main className="shici" style={{ "--reader-scale": snapshot.settings.font_scale, "--reader-leading": snapshot.settings.line_height } as CSSProperties}>
    <aside ref={sidebarDialog} id="sc-navigation" className={`sc-sidebar ${sideOpen ? "open" : ""}`} role={sideOpen ? "dialog" : undefined} aria-modal={sideOpen ? true : undefined} aria-label="拾词导航" tabIndex={sideOpen ? -1 : undefined}>
      <Link href="/" className="sc-brand" aria-label="返回私人工作台"><Logo /></Link>
      <nav>{navigation.map((item) => <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "active" : ""} onClick={() => go(item.id)}><i>{item.glyph}</i><span>{item.label}</span></button>)}</nav>
      <div className="sc-side-foot"><button className={view === "settings" ? "active" : ""} onClick={() => go("settings")}><i>设</i><span>设置</span></button><div><i /><span>本地数据库<small>已安全保存</small></span></div></div>
    </aside>
    <section className="sc-main">
      <header className="sc-topbar"><button className="sc-menu" onClick={() => setSideOpen((value) => !value)} aria-expanded={sideOpen} aria-controls="sc-navigation" aria-label={sideOpen ? "关闭导航" : "打开导航"}>拾</button><div className="sc-crumb"><span>拾词</span><b>/</b><strong>{pageLabel}</strong></div><div className="sc-top-actions"><button className="sc-search-jump" onClick={() => setSearchOpen(true)}>⌕ <span>搜索</span><kbd>⌘ K</kbd></button><button className="sc-import" onClick={() => setImportOpen(true)}>＋ <span>导入内容</span></button></div></header>
      <div className="sc-view">
        {view === "today" && <TodayView snapshot={snapshot} due={dueCards.length} onOpen={openItem} onGo={go} onImport={() => setImportOpen(true)} onWord={setWordId} />}
        {view === "library" && <LibraryView items={snapshot.items} onOpen={openItem} onImport={() => setImportOpen(true)} onArchive={async (item) => { await updateItemStatus(item.id, item.status === "archived" ? "unread" : "archived"); await refresh(); }} />}
        {view === "reader" && <ReaderView item={activeItem?.kind === "article" ? activeItem : snapshot.items.find((item) => item.kind === "article") ?? null} blocks={snapshot.blocks} occurrences={snapshot.occurrences} bookmarks={snapshot.bookmarks} onSelect={selectText} onBack={() => go("library")} onProgress={recordReaderProgress} onFinish={async (item) => { await updateItemProgress(item.id, 1, true); await refresh(); setToast("已标记为读完，随时可以改回阅读中"); }} onBookmark={async (item, block) => { await createBookmark(item.id, block?.id ?? "top", block?.text.slice(0, 30) ?? item.title); await refresh(); setToast("已收藏当前位置"); }} />}
        {view === "podcast" && <PodcastView key={(activeItem?.kind === "podcast" ? activeItem : snapshot.items.find((item) => item.kind === "podcast"))?.id ?? "empty-podcast"} item={activeItem?.kind === "podcast" ? activeItem : snapshot.items.find((item) => item.kind === "podcast") ?? null} segments={snapshot.segments} occurrences={snapshot.occurrences} autoFollow={snapshot.settings.auto_follow} localLock={snapshot.settings.local_lock} onAutoFollow={(value) => void changeSettings({ auto_follow: value })} onSelect={selectText} onProgress={recordPodcastProgress} onBookmark={async (item, ms, label) => { await createBookmark(item.id, `t:${ms}`, label); await refresh(); setToast("已收藏此刻"); }} />}
        {view === "words" && <WordsView lexemes={snapshot.lexemes} occurrences={snapshot.occurrences} onOpen={setWordId} onStar={async (word) => { await toggleLexemeStar(word.id, !word.starred); await refresh(); }} />}
        {view === "review" && <ReviewView cards={snapshot.reviewCards} onRate={async (card: ReviewCard, rating: ReviewRating) => { const id = await rateReview(card, rating); await refresh(); return id; }} onUndo={async (id) => { await undoReview(id); await refresh(); }} />}
        {view === "stats" && <StatsView snapshot={snapshot} />}
        {view === "settings" && <SettingsView settings={snapshot.settings} onChange={changeSettings} onExport={async () => { const bytes = await exportVocabDatabase(); const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/vnd.sqlite3" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `拾词备份-${new Date().toISOString().slice(0, 10)}.sqlite3`; link.click(); URL.revokeObjectURL(url); setToast("完整备份已导出"); }} onImport={async (file) => { await importVocabDatabase(new Uint8Array(await file.arrayBuffer())); await refresh(); setToast("备份已恢复"); }} onTestAi={async () => { if (snapshot.settings.local_lock) throw new Error("请先关闭本地锁"); const response = await fetch("/api/health", { headers: { Accept: "application/json" } }); const health = await response.json() as { ai?: { configured?: boolean } }; if (!response.ok) throw new Error("无法检查 AI 服务状态"); if (!health.ai?.configured) throw new Error("DeepSeek API Key 尚未配置"); }} />}
      </div>
    </section>
    <nav className="sc-mobile-tabs" aria-label="拾词页面">{navigation.slice(0, 4).map((item) => <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "active" : ""} onClick={() => go(item.id)}><i>{item.glyph}</i><span>{item.label}</span></button>)}</nav>
    {selection && <ContextPanel target={selection} explanation={explanation} loading={aiBusy} error={aiError} showChinese={showChinese} onChinese={async (value) => { setShowChinese(value); if (value && explanation && !explanation.sense?.explanation_zh) await addChinese(); }} onExplain={() => void askAi()} onSave={savePickedWord} onClose={clearSelection} />}
    {wordId && <WordDetail key={wordId} word={snapshot.lexemes.find((word) => word.id === wordId) ?? null} occurrences={snapshot.occurrences.filter((item) => item.lexeme_id === wordId)} onClose={() => setWordId(null)} onNote={async (id, note) => { await saveLexemeNote(id, note); await refresh(); setToast("笔记已保存"); }} onStatus={async (id, status) => { await updateLexemeStatus(id, status); await refresh(); }} />}
    {importOpen && <ImportWizard localLock={snapshot.settings.local_lock} onClose={() => setImportOpen(false)} onImported={async (id) => { const data = await loadVocabSnapshot(); setSnapshot(data); setImportOpen(false); const item = data.items.find((entry) => entry.id === id); if (item) openItem(item); setToast("内容已存入本地资料库"); }} />}
    {searchOpen && <SearchPalette snapshot={snapshot} onClose={() => setSearchOpen(false)} onOpenItem={openItem} onOpenWord={(id) => { setWordId(id); }} />}
    {toast && <div className="sc-toast" role="status"><span>✓</span>{toast}</div>}
    {sideOpen && <button className="sc-nav-scrim" onClick={() => setSideOpen(false)} aria-label="关闭导航" />}
  </main>;
}
