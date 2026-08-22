"use client";
/* eslint-disable jsx-a11y/media-has-caption -- Every audio item has a synchronized, keyboard-accessible transcript beside the player. */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";
import { createLocalFileObjectUrl, type LocalStorageEstimate } from "@/lib/local-db/files";
import { adjacentSentence, formatDuration, formatShortDate, sentenceContext, wordAt, wordRanges } from "@/lib/vocab/content";
import { resolveReviewRound, restoreUndoneCardToRound, startReviewRound } from "@/lib/vocab/review-round";
import {
  commitVocabReviewRating,
  commitVocabReviewUndo,
  getDueCards,
  inspectVocabReviewRating,
  inspectVocabReviewUndo,
  prepareVocabReviewRating,
  prepareVocabReviewUndo,
  recordStudySeconds,
  VocabReviewChangedError,
  VocabReviewConflictError,
  VocabReviewNotSavedError,
  VocabReviewUncertainError,
} from "@/lib/vocab/store";
import { scheduleReviewV2 } from "@/lib/vocab/srs";
import type { ContentBlock, Lexeme, LibraryItem, Occurrence, ReviewCard, ReviewRating, SelectionTarget, TranscriptSegment, VocabSettings, VocabSnapshot, VocabView } from "@/lib/vocab/types";
import {
  shouldReportVocabReaderProgress,
  sameVocabLibraryItemFacts,
  vocabPodcastCompleteActionEnabled,
  vocabPodcastPositionCanReport,
  vocabPodcastPositionReportChanged,
  vocabPodcastSeekShouldReport,
  vocabPodcastSnapshotPositionMode,
} from "./item-write-state";
import { AnnotatedText, EmptyState, Metric, Toggle } from "./ui";
import { VocabBackupFlow } from "./VocabBackupFlow";
import {
  VOCAB_REVIEW_RECOVERY_PREFIX,
  VOCAB_REVIEW_RECENT_UNDO_KEY,
  createVocabReviewRecoveryTicket,
  readBrowserVocabReviewRecentUndo,
  readBrowserVocabReviewRecovery,
  probeVocabReviewJournalLock,
  removeUnreadableVocabReviewRecentUndo,
  removeUnreadableVocabReviewEntry,
  runNewVocabReviewRecoveryTransaction,
  runVocabReviewRecentUndoEntryTransaction,
  runVocabReviewRecoveryEntryTransaction,
  transitionVocabReviewRecoveryTicket,
  type VocabReviewJournalTransactionResult,
  type VocabReviewLockedEntry,
  type VocabReviewRecentUndoEntry,
  type VocabReviewRecentUndoReadResult,
  type VocabReviewRecoveryReadResult,
  type VocabReviewRecoveryTicket,
} from "./review-recovery";

function caretOffset(element: HTMLElement, clientX: number, clientY: number) {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(clientX, clientY);
  const range = position ? document.createRange() : doc.caretRangeFromPoint?.(clientX, clientY) ?? null;
  if (!range && !position) return -1;
  const node = position?.offsetNode ?? range!.startContainer;
  const offset = position?.offset ?? range!.startOffset;
  if (!element.contains(node)) return -1;
  const prefix = document.createRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(node, offset);
  return prefix.toString().length;
}

function pickedText(element: HTMLElement, clientX: number, clientY: number) {
  const text = element.textContent ?? "";
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount) {
    const range = selection.getRangeAt(0);
    if (element.contains(range.startContainer) && element.contains(range.endContainer)) {
      const prefix = document.createRange();
      prefix.selectNodeContents(element);
      prefix.setEnd(range.startContainer, range.startOffset);
      const approximate = prefix.toString().length;
      const surface = selection.toString().trim();
      const start = text.toLowerCase().indexOf(surface.toLowerCase(), Math.max(0, approximate - 2));
      if (surface && start >= 0) return { text: surface, start, end: start + surface.length };
    }
  }
  return wordAt(text, caretOffset(element, clientX, clientY));
}

function localDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatKnownVocabDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "时长未记录";
  if (durationMs < 60_000) return "少于 1 分钟";
  return `${Math.round(durationMs / 60_000)} 分钟`;
}

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest("button,a,input,textarea,select,[contenteditable='true']"));
}

export function TodayView({ snapshot, due, onOpen, onGo, onImport, onWord }: { snapshot: VocabSnapshot; due: number; onOpen: (item: LibraryItem) => void; onGo: (view: VocabView) => void; onImport: () => void; onWord: (id: string) => void }) {
  const hour = new Date().getHours();
  const greeting = hour < 11 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  const resume = snapshot.items.find((item) => item.status === "in_progress") ??
    snapshot.items.find((item) => item.status === "unread");
  const today = localDayKey();
  const activity = snapshot.activity.find((entry) => entry.day === today);
  const minutes = Math.round(((activity?.read_seconds ?? 0) + (activity?.listen_seconds ?? 0)) / 60);
  const hasDue = due > 0;
  return <div className="sc-page sc-today">
    <section className="sc-hero"><div><span className="sc-eyebrow">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</span><h1>{greeting}。<br/><em>今天想拾起什么？</em></h1><p>从英文原文里理解词，也把它放回真正的语境里记住。</p></div><button className="sc-pick-orb" onClick={onImport}><i>＋</i><span>导入<br/>新内容</span></button></section>
    {resume ? <button className="sc-resume" onClick={() => onOpen(resume)}><div className={`sc-resume-art ${resume.kind}`}><span>{resume.kind === "article" ? "READ" : "LISTEN"}</span><strong>{resume.title.slice(0, 1)}</strong><i style={{ height: `${Math.max(8, resume.progress * 100)}%` }}/></div><div className="sc-resume-copy"><span>继续{resume.kind === "article" ? "阅读" : "收听"}</span><h2>{resume.title}</h2><p>{resume.description}</p><footer><b>{Math.round(resume.progress * 100)}%</b><i><em style={{ width: `${resume.progress * 100}%` }}/></i><strong>继续 →</strong></footer></div></button> : <EmptyState title="资料库还是空的" copy="导入一篇英文文章或一期播客，从第一个词开始。" action={<button onClick={onImport}>导入内容</button>} />}
    <section className="sc-today-grid"><button className="sc-review-callout" onClick={() => onGo(hasDue ? "review" : "words")}><header><span>回到语境</span><small>有空时再继续</small></header><div><strong>{hasDue ? "一小轮" : "随时"}</strong><span>{hasDue ? "有词适合再看一遍" : "现在没有适合回看的词"}</span></div><footer>{hasDue ? "开始一小轮" : "浏览词库"}<b>→</b></footer></button><article className="sc-focus-card"><header><span>今天的记录</span><small>只陈述真实发生的时间</small></header><div className="sc-focus-fact"><strong>{minutes}</strong><small>分钟</small></div><footer><span>阅读 {Math.round((activity?.read_seconds ?? 0) / 60)} 分</span><span>收听 {Math.round((activity?.listen_seconds ?? 0) / 60)} 分</span></footer></article></section>
    <section className="sc-section-head"><div><span className="sc-eyebrow">RECENTLY PICKED</span><h2>最近拾起的词</h2></div><button onClick={() => onGo("words")}>查看全部 →</button></section>
    {snapshot.lexemes.length ? <div className="sc-word-ribbon">{snapshot.lexemes.slice(0, 4).map((word, index) => <button key={word.id} onClick={() => onWord(word.id)}><small>{String(index + 1).padStart(2, "0")}</small><strong>{word.headword}</strong><span>{word.pronunciation || "pronunciation pending"}</span><p>{word.gloss_en || "Explanation pending"}</p></button>)}</div> : <EmptyState title="词会从语境里自然留下" copy="读到想理解的词时点一下；是否保存，由你决定。" />}
  </div>;
}

export function LibraryView({ items, itemWriteLocked, itemWriteBusy, itemWriteStatus, onOpen, onImport, onArchive }: { items: LibraryItem[]; itemWriteLocked: boolean; itemWriteBusy: boolean; itemWriteStatus: string; onOpen: (item: LibraryItem) => void; onImport: () => void; onArchive: (item: LibraryItem, trigger: HTMLButtonElement) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "article" | "podcast" | "archived">("all");
  const visible = items.filter((item) => (filter === "all" ? item.status !== "archived" : filter === "archived" ? item.status === "archived" : item.kind === filter && item.status !== "archived") && `${item.title}${item.source}${item.author}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="sc-page sc-library"><header className="sc-page-title"><div><span className="sc-eyebrow">YOUR LOCAL LIBRARY</span><h1>资料库</h1><p>{items.filter((item) => item.status !== "archived").length} 项英文内容，保存在当前完整网址与浏览器资料中。</p></div><button className="sc-primary" onClick={onImport}>＋ 导入内容</button></header><div className="sc-toolbar"><label className="sc-search">⌕<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、作者或来源"/></label><div className="sc-segmented">{([['all','全部'],['article','文章'],['podcast','播客'],['archived','归档']] as const).map(([id,label]) => <button aria-pressed={filter===id} key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>)}</div></div>
    {itemWriteStatus && <p id="sc-library-item-write-status" className="sc-item-inline-status" role="status">{itemWriteStatus}</p>}
    {visible.length ? <div className="sc-library-grid">{visible.map((item,index) => <article className="sc-library-card" key={item.id}><button className="sc-card-main" onClick={() => onOpen(item)}><div className={`sc-cover cover-${index % 4 + 1}`}><span>{item.kind === "article" ? "ARTICLE" : "PODCAST"}</span><strong>{item.title.slice(0,1)}</strong><i>{Math.round(item.progress * 100)}%</i></div><div className="sc-card-copy"><span>{item.source}</span><h2>{item.title}</h2><p>{item.description}</p><footer><small>{item.author || formatShortDate(item.published_at)}</small><b>{item.kind === "article" ? "阅读" : formatKnownVocabDuration(item.duration_ms)} · {Math.round(item.progress * 100)}%</b></footer></div></button><button className="sc-card-menu" disabled={itemWriteLocked || itemWriteBusy} aria-busy={itemWriteBusy || undefined} aria-describedby={itemWriteStatus ? "sc-library-item-write-status" : undefined} onClick={(event) => onArchive(item, event.currentTarget)} aria-label={item.status === "archived" ? "恢复到资料库" : "移入归档"}>{item.status === "archived" ? "恢复" : "归档"}</button></article>)}</div> : <EmptyState title="没有找到内容" copy="换一个搜索词，或带回新的英文文章与播客。" action={<button onClick={onImport}>导入内容</button>} />}</div>;
}

export function ReaderView({ item, blocks, occurrences, bookmarks, itemWriteLocked, itemWriteBusy, itemWriteStatus, onSelect, onBack, onProgress, onFinish, onBookmark }: { item: LibraryItem | null; blocks: ContentBlock[]; occurrences: Occurrence[]; bookmarks: VocabSnapshot["bookmarks"]; itemWriteLocked: boolean; itemWriteBusy: boolean; itemWriteStatus: string; onSelect: (target: SelectionTarget) => void; onBack: () => void; onProgress: (item: LibraryItem, progress: number) => unknown; onFinish: (item: LibraryItem, trigger: HTMLButtonElement) => void; onBookmark: (item: LibraryItem, block?: ContentBlock) => void }) {
  const prose = useRef<HTMLDivElement>(null);
  const lastActivity = useRef(0);
  const lastSavedProgress = useRef(item?.progress ?? 0);
  const restoredItem = useRef<string | null>(null);
  const trackedItemId = item?.id ?? null;
  const articleBlocks = useMemo(() => blocks.filter((block) => block.item_id === trackedItemId), [blocks, trackedItemId]);
  const [currentBlockId, setCurrentBlockId] = useState<string | null>(null);
  const [displayProgress, setDisplayProgress] = useState(item?.progress ?? 0);
  const [keyboardWord, setKeyboardWord] = useState<{ blockId: string; index: number } | null>(null);

  const selectRange = useCallback((block: ContentBlock, range: { text: string; start: number; end: number }) => {
    if (!trackedItemId) return;
    const context = sentenceContext(block.text, range.start, range.end);
    onSelect({ surface: range.text, sentence: context.sentence, before: context.before, after: context.after, itemId: trackedItemId, blockId: block.id, startUtf16: range.start, endUtf16: range.end, contextStartUtf16: context.startUtf16, contextEndUtf16: context.endUtf16 });
  }, [onSelect, trackedItemId]);

  useEffect(() => {
    if (!trackedItemId) return;
    lastActivity.current = Date.now();
    const markActivity = () => { lastActivity.current = Date.now(); };
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - lastActivity.current < 30_000) {
        void recordStudySeconds(trackedItemId, "read", 15).catch(() => undefined);
      }
    }, 15_000);
    window.addEventListener("scroll", markActivity, { passive: true });
    window.addEventListener("pointerdown", markActivity, { passive: true });
    window.addEventListener("keydown", markActivity);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("scroll", markActivity);
      window.removeEventListener("pointerdown", markActivity);
      window.removeEventListener("keydown", markActivity);
    };
  }, [trackedItemId]);

  useEffect(() => {
    const container = prose.current;
    if (!container || !item || !articleBlocks.length) return;
    const needsRestore = restoredItem.current !== item.id;
    const restoredIndex = Math.min(
      articleBlocks.length - 1,
      Math.max(0, Math.round(item.progress * (articleBlocks.length - 1))),
    );
    restoredItem.current = item.id;
    lastSavedProgress.current = item.progress;
    setDisplayProgress(item.progress);
    setCurrentBlockId(articleBlocks[restoredIndex]?.id ?? null);
    let persistenceEnabled = false;
    let setupTimer: number | null = null;
    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    const updatePosition = (fromEnabledScrollListener: boolean) => {
      const nodes = Array.from(container.querySelectorAll<HTMLElement>("[data-block-id]"));
      let index = 0;
      nodes.forEach((node, candidate) => { if (node.getBoundingClientRect().top <= Math.max(180, window.innerHeight * .35)) index = candidate; });
      const block = articleBlocks[index];
      if (!block) return;
      setCurrentBlockId(block.id);
      const progress = articleBlocks.length === 1 ? .5 : index / (articleBlocks.length - 1);
      setDisplayProgress(progress);
      if (!shouldReportVocabReaderProgress(
        fromEnabledScrollListener,
        progress,
        lastSavedProgress.current,
      )) return;
      lastSavedProgress.current = progress;
      void onProgress(item, progress);
    };
    const onScroll = () => updatePosition(persistenceEnabled);
    const enablePersistenceAfterLayout = () => {
      firstFrame = window.requestAnimationFrame(() => {
        firstFrame = null;
        secondFrame = window.requestAnimationFrame(() => {
          secondFrame = null;
          updatePosition(false);
          persistenceEnabled = true;
          window.addEventListener("scroll", onScroll, { passive: true });
        });
      });
    };
    if (needsRestore && item.progress > .02 && item.progress < .98) {
      setupTimer = window.setTimeout(() => {
        setupTimer = null;
        document.getElementById(articleBlocks[restoredIndex].id)?.scrollIntoView({ block: "center" });
        enablePersistenceAfterLayout();
      }, 0);
    } else {
      enablePersistenceAfterLayout();
    }
    return () => {
      if (setupTimer !== null) window.clearTimeout(setupTimer);
      if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
      window.removeEventListener("scroll", onScroll);
    };
  }, [articleBlocks, item, onProgress]);

  useEffect(() => {
    const container = prose.current;
    if (!container || !trackedItemId) return;
    const handlePick = (event: MouseEvent) => {
      const element = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-block-id]");
      if (!element || !container.contains(element)) return;
      const block = articleBlocks.find((entry) => entry.id === element.dataset.blockId);
      if (!block) return;
      const value = pickedText(element, event.clientX, event.clientY);
      if (value && value.text.length <= 80) selectRange(block, value);
    };
    container.addEventListener("mouseup", handlePick);
    return () => container.removeEventListener("mouseup", handlePick);
  }, [articleBlocks, selectRange, trackedItemId]);

  const keyboardProps = (block: ContentBlock) => {
    const words = wordRanges(block.text);
    const currentIndex = keyboardWord?.blockId === block.id ? keyboardWord.index : 0;
    return {
      tabIndex: 0,
      onFocus: () => { if (words.length && keyboardWord?.blockId !== block.id) setKeyboardWord({ blockId: block.id, index: 0 }); },
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
        if (!words.length) return;
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault();
          const direction = event.key === "ArrowRight" ? 1 : -1;
          setKeyboardWord({ blockId: block.id, index: Math.min(words.length - 1, Math.max(0, currentIndex + direction)) });
        } else if (event.key === "Enter" || event.key.toLowerCase() === "e") {
          event.preventDefault();
          selectRange(block, words[currentIndex]);
        }
      },
      title: "左右方向键选择单词，Enter 或 E 查看语境解释",
    };
  };

  if (!item) return <EmptyState title="还没有文章" copy="先从资料库导入一篇英文文章。"/>;
  const bookmarkBlock = articleBlocks.find((block) => block.id === currentBlockId) ?? articleBlocks[0];
  return <div className="sc-reader-layout"><aside className="sc-reader-rail"><button onClick={onBack}>← 返回资料库</button><span>阅读位置</span><strong>{Math.round(displayProgress * 100)}%</strong><i><em style={{ height: `${displayProgress * 100}%` }}/></i><nav>{articleBlocks.filter((block) => block.kind === "heading").map((block,index) => <a href={`#${block.id}`} key={block.id}><b>{String(index + 1).padStart(2,"0")}</b>{block.text}</a>)}</nav></aside><article className="sc-reader"><header><div><span>{item.source || "LOCAL ARTICLE"}</span><i>·</i><span>{Math.max(1, Math.ceil(articleBlocks.reduce((sum,block) => sum + block.text.length,0)/900))} MIN READ</span></div><button onClick={() => onBookmark(item, bookmarkBlock)}>◇ 收藏当前位置</button></header><h1>{item.title}</h1><p className="sc-deck">{item.description}</p><div className="sc-byline"><span>{(item.author || "拾").slice(0,1)}</span><div><strong>{item.author || "Local import"}</strong><small>{item.published_at || "刚刚导入"}</small></div><i/></div><div ref={prose} className="sc-prose">{articleBlocks.map((block) => {
      const words = wordRanges(block.text);
      const activeRange = keyboardWord?.blockId === block.id ? words[keyboardWord.index] : null;
      const body = <AnnotatedText text={block.text} ranges={occurrences.filter((entry) => entry.block_id === block.id)} activeRange={activeRange}/>;
      if (block.kind === "heading") return <h2 id={block.id} data-block-id={block.id} key={block.id} {...keyboardProps(block)}>{body}</h2>;
      if (block.kind === "quote") return <blockquote id={block.id} data-block-id={block.id} key={block.id} {...keyboardProps(block)}>{body}</blockquote>;
      return <p id={block.id} data-block-id={block.id} key={block.id} {...keyboardProps(block)}>{body}</p>;
    })}</div><footer className="sc-reader-end"><span>拾</span><p>You reached the end.</p><button disabled={itemWriteLocked || itemWriteBusy || item.status === "complete" || item.status === "archived"} aria-busy={itemWriteBusy || undefined} aria-describedby={itemWriteStatus ? "sc-reader-item-write-status" : undefined} onClick={(event) => onFinish(item, event.currentTarget)}>{item.status === "complete" ? "已经读完" : itemWriteBusy ? "正在安全确认…" : "标记为读完"}</button>{itemWriteStatus && <small id="sc-reader-item-write-status" className="sc-item-inline-status" role="status">{itemWriteStatus}</small>}</footer></article><aside className="sc-reader-meta"><div><span>已拾词</span><strong>{occurrences.filter((entry) => entry.item_id === item.id).length}</strong></div><div><span>书签</span><strong>{bookmarks.filter((entry) => entry.item_id === item.id).length}</strong></div><p>点击一个词、拖选短语，或聚焦段落后用方向键和 Enter。AI 只会收到附近语境。</p></aside></div>;
}

export function PodcastView({ item, segments, occurrences, autoFollow, autoFollowWriteLocked, autoFollowWriteBusy, autoFollowStatus, itemWriteLocked, itemWritePermanentReadOnly, itemWriteBusy, itemWriteStatus, localLock, onAutoFollow, onSelect, onProgress, onFinish, onBookmark }: { item: LibraryItem | null; segments: TranscriptSegment[]; occurrences: Occurrence[]; autoFollow: boolean; autoFollowWriteLocked: boolean; autoFollowWriteBusy: boolean; autoFollowStatus: string; itemWriteLocked: boolean; itemWritePermanentReadOnly: boolean; itemWriteBusy: boolean; itemWriteStatus: string; localLock: boolean; onAutoFollow: (value: boolean, trigger: HTMLButtonElement) => void; onSelect: (target: SelectionTarget) => void; onProgress: (item: LibraryItem, progress: number) => unknown; onFinish: (item: LibraryItem, trigger: HTMLButtonElement | null) => void; onBookmark: (item: LibraryItem, ms: number, label: string) => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const activeRow = useRef<HTMLButtonElement>(null);
  const listenStartedAt = useRef<number | null>(null);
  const lastProgressReportAt = useRef(0);
  const currentMsRef = useRef(Math.round((item?.progress ?? 0) * (item?.duration_ms ?? 0)));
  const durationRef = useRef(item?.duration_ms ?? 0);
  const terminalIntent = useRef(false);
  const positionActivityRef = useRef(false);
  const sliderActivityRef = useRef(false);
  const lastReportedPositionRef = useRef<Readonly<{
    item: LibraryItem;
    progress: number;
  }> | null>(null);
  const displayedItemRef = useRef(item);
  const onProgressRef = useRef(onProgress);
  const [localSrc, setLocalSrc] = useState<string | null>(null);
  const [currentMs, setCurrentMs] = useState(() => Math.round((item?.progress ?? 0) * (item?.duration_ms ?? 0)));
  const [durationMs, setDurationMs] = useState(item?.duration_ms ?? 0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [followPaused, setFollowPaused] = useState(false);
  const [mediaError, setMediaError] = useState("");
  const [terminalRetry, setTerminalRetry] = useState(false);
  const [keyboardWord, setKeyboardWord] = useState<{ segmentId: string; index: number } | null>(null);
  const episodeSegments = useMemo(() => segments.filter((entry) => entry.item_id === item?.id), [item?.id, segments]);
  const alignedTranscript = episodeSegments.some((entry) => entry.end_ms > entry.start_ms);
  const knownDuration = durationMs || item?.duration_ms ||
    (alignedTranscript ? episodeSegments.at(-1)?.end_ms : 0) || 0;
  const fallbackDuration = knownDuration || 1;
  const duration = knownDuration || fallbackDuration;
  const timedIndex = episodeSegments.findIndex((entry) => currentMs >= entry.start_ms && currentMs < entry.end_ms);
  const activeIndex = alignedTranscript ? Math.max(0, timedIndex) : 0;
  const active = episodeSegments[activeIndex] ?? episodeSegments[0];
  const isLocalAudio = item?.audio_url?.startsWith("local:") ?? false;
  const remoteBlocked = Boolean(localLock && item?.audio_url && !isLocalAudio);
  const src = isLocalAudio ? localSrc : !localLock && item?.audio_url ? `/api/media?url=${encodeURIComponent(item.audio_url)}` : null;
  const follow = autoFollow && !followPaused;
  const canResumeLocally = autoFollow && followPaused;
  const followStatusId = "sc-podcast-follow-status";
  const trackedItemId = item?.id ?? null;

  useEffect(() => {
    positionActivityRef.current = false;
    sliderActivityRef.current = false;
  }, [src, trackedItemId]);

  useEffect(() => {
    const previousItem = displayedItemRef.current;
    const positionMode = vocabPodcastSnapshotPositionMode(
      !sameVocabLibraryItemFacts(previousItem, item),
      audio.current?.paused ?? !playing,
    );
    displayedItemRef.current = item;
    onProgressRef.current = onProgress;
    if (positionMode !== "sync-baseline" || !item) return;
    positionActivityRef.current = false;
    sliderActivityRef.current = false;
    if (item.status !== "complete" && item.status !== "archived") {
      terminalIntent.current = false;
    }
    const mediaDuration = audio.current && Number.isFinite(audio.current.duration)
      ? audio.current.duration * 1000
      : 0;
    const nextDuration = mediaDuration || item.duration_ms || durationRef.current;
    const restored = Math.min(
      nextDuration,
      Math.max(0, item.progress * nextDuration),
    );
    durationRef.current = nextDuration;
    currentMsRef.current = restored;
    lastProgressReportAt.current = performance.now();
    if (audio.current) audio.current.currentTime = restored / 1000;
    const frame = window.requestAnimationFrame(() => {
      setDurationMs(nextDuration);
      setCurrentMs(restored);
      setTerminalRetry(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [item, onProgress, playing]);

  const commitListen = useCallback(() => {
    if (listenStartedAt.current === null || !trackedItemId) return;
    const seconds = Math.max(0, Math.round((performance.now() - listenStartedAt.current) / 1000));
    listenStartedAt.current = null;
    if (seconds > 0) void recordStudySeconds(trackedItemId, "listen", seconds).catch(() => undefined);
  }, [trackedItemId]);

  const startListen = useCallback(() => {
    positionActivityRef.current = true;
    if (document.visibilityState === "visible" && listenStartedAt.current === null) listenStartedAt.current = performance.now();
  }, []);

  const reportCurrentPosition = useCallback(() => {
    const currentItem = displayedItemRef.current;
    if (!currentItem || !vocabPodcastPositionCanReport(
      positionActivityRef.current,
      terminalIntent.current,
      Boolean(audio.current?.ended),
      currentItem.status,
    )) return;
    const progress = Math.min(.99, currentMsRef.current /
      Math.max(1, durationRef.current || currentItem.duration_ms || 1));
    const last = lastReportedPositionRef.current;
    if (!vocabPodcastPositionReportChanged(last, currentItem, progress)) return;
    lastReportedPositionRef.current = { item: currentItem, progress };
    void onProgressRef.current(currentItem, progress);
  }, []);

  const seek = useCallback((
    ms: number,
    source: "explicit-user" | "slider-input" = "explicit-user",
  ) => {
    currentMsRef.current = ms;
    positionActivityRef.current = true;
    if (source === "slider-input") sliderActivityRef.current = true;
    setCurrentMs(ms);
    if (audio.current) audio.current.currentTime = ms / 1000;
    if (vocabPodcastSeekShouldReport(source)) {
      lastProgressReportAt.current = performance.now();
      reportCurrentPosition();
      if (source === "slider-input") sliderActivityRef.current = false;
    }
  }, [reportCurrentPosition]);

  useEffect(() => {
    if (!item?.audio_url?.startsWith("local:")) return;
    let live = true;
    let dispose: (() => void) | undefined;
    void createLocalFileObjectUrl("vocab", item.audio_url.slice(6)).then((result) => {
      if (!live) { result.revoke(); return; }
      dispose = result.revoke;
      setLocalSrc(result.url);
    }).catch((error: unknown) => { if (live) setMediaError(error instanceof Error ? error.message : "无法打开本地音频"); });
    return () => { live = false; dispose?.(); };
  }, [item?.audio_url]);
  useEffect(() => {
    if (!follow || !playing || !alignedTranscript) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    activeRow.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  }, [activeIndex, alignedTranscript, follow, playing]);
  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        commitListen();
        reportCurrentPosition();
      }
      else if (!audio.current?.paused) startListen();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); commitListen(); };
  }, [commitListen, reportCurrentPosition, startListen]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (isInteractiveTarget(event.target)) return;
      if (event.key === " " && src) { event.preventDefault(); if (audio.current?.paused) void audio.current.play(); else audio.current?.pause(); }
      if (event.key.toLowerCase() === "j") seek(episodeSegments[Math.max(0,activeIndex-1)]?.start_ms ?? 0);
      if (event.key.toLowerCase() === "k") seek(episodeSegments[Math.min(episodeSegments.length-1,activeIndex+1)]?.start_ms ?? currentMs);
    };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, [activeIndex, currentMs, episodeSegments, seek, src]);
  if (!item) return <EmptyState title="还没有播客" copy="从 RSS、音频或英文字幕开始一段听读。"/>;
  const selectRange = (segment: TranscriptSegment, index: number, range: { text: string; start: number; end: number }) => {
    const context = sentenceContext(segment.text,range.start,range.end);
    onSelect({ surface:range.text,sentence:context.sentence,before:context.before || adjacentSentence(episodeSegments[index-1]?.text ?? "", "preceding"),after:context.after || adjacentSentence(episodeSegments[index+1]?.text ?? "", "following"),itemId:item.id,segmentId:segment.id,startUtf16:range.start,endUtf16:range.end,contextStartUtf16:context.startUtf16,contextEndUtf16:context.endUtf16,startMs:alignedTranscript?segment.start_ms:undefined });
  };
  const pick = (segment: TranscriptSegment, index: number, event: ReactMouseEvent<HTMLElement>) => { const value = pickedText(event.currentTarget,event.clientX,event.clientY); if (value && value.text.length <= 80) selectRange(segment,index,value); };
  const transcriptKey = (segment: TranscriptSegment, index: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const words = wordRanges(segment.text);
    if (!words.length) return;
    const currentIndex = keyboardWord?.segmentId === segment.id ? keyboardWord.index : 0;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      setKeyboardWord({ segmentId: segment.id, index: Math.min(words.length - 1, Math.max(0, currentIndex + direction)) });
    } else if (event.key === "Enter" || event.key.toLowerCase() === "e") {
      event.preventDefault();
      selectRange(segment,index,words[currentIndex]);
    }
  };
  const updateTime = (event: SyntheticEvent<HTMLAudioElement>) => {
    const next = event.currentTarget.currentTime * 1000;
    currentMsRef.current = next;
    if (!event.currentTarget.paused) positionActivityRef.current = true;
    setCurrentMs(next);
    const now = performance.now();
    if (now - lastProgressReportAt.current >= 10_000) {
      lastProgressReportAt.current = now;
      reportCurrentPosition();
    }
  };
  const completeActionEnabled = vocabPodcastCompleteActionEnabled(
    item.status,
    itemWriteLocked,
    itemWriteBusy,
  );
  return <div className="sc-podcast-page">{src && <audio ref={audio} src={src} preload="metadata" onLoadedMetadata={(event) => { const nextDuration=Number.isFinite(event.currentTarget.duration)?event.currentTarget.duration*1000:fallbackDuration;durationRef.current=nextDuration;setDurationMs(nextDuration);const restored=Math.min(nextDuration,Math.max(0,item.progress*nextDuration));currentMsRef.current=restored;event.currentTarget.currentTime=restored/1000;setCurrentMs(restored); }} onTimeUpdate={updateTime} onPlay={() => { terminalIntent.current=false;setTerminalRetry(false);setPlaying(true);startListen(); }} onPause={() => { setPlaying(false);commitListen();reportCurrentPosition(); }} onEnded={() => { terminalIntent.current=true;setTerminalRetry(true);setPlaying(false);commitListen();if(item.status!=="complete"&&item.status!=="archived")onFinish(item, null); }} onError={() => setMediaError("音频无法播放，来源可能已失效或格式不受支持。")}/>}<header className="sc-podcast-head"><div><span className="sc-eyebrow">LISTEN IN CONTEXT</span><h1>{item.title}</h1><p>{item.description}</p><div><b>{item.source}</b><span>{item.author}</span><span>{formatKnownVocabDuration(knownDuration)}</span></div></div><div className="sc-podcast-art"><i/><i/><i/><strong>声</strong></div></header><section className="sc-player" aria-label="音频播放器"><button className="sc-play" aria-label={playing?"暂停":"播放"} disabled={!src} onClick={() => { if (audio.current?.paused) void audio.current.play(); else audio.current?.pause(); }}>{playing ? "Ⅱ" : "▶"}</button><span>{formatDuration(currentMs)}</span><input type="range" aria-label="播放进度" aria-valuetext={`${formatDuration(currentMs)} / ${formatDuration(duration)}`} min={0} max={Math.max(1,duration)} value={Math.min(currentMs,duration)} onChange={(event) => seek(Number(event.target.value), "slider-input")} onPointerUp={reportCurrentPosition} onBlur={reportCurrentPosition}/><span>{formatDuration(duration)}</span><button className="sc-speed" aria-label={`播放速度 ${speed} 倍，点击切换`} onClick={() => { const next = speed >= 2 ? .75 : speed + .25; setSpeed(next); if (audio.current) audio.current.playbackRate = next; }}>{speed}×</button><button aria-label="收藏当前播放位置" onClick={() => onBookmark(item,currentMs,active?.text.slice(0,24) ?? item.title)}>◇</button></section>{item.status !== "complete" && item.status !== "archived" && <div className="sc-podcast-terminal-actions"><button type="button" disabled={!completeActionEnabled} aria-busy={itemWriteBusy || undefined} aria-describedby={itemWriteStatus ? "sc-podcast-item-write-status" : undefined} onClick={(event) => { setTerminalRetry(false);onFinish(item, event.currentTarget); }}>{itemWriteBusy ? "正在安全确认…" : terminalRetry ? "重新标记已听完" : "标记已听完"}</button></div>}{itemWriteStatus && <div id="sc-podcast-item-write-status" className="sc-item-inline-status" role="status">{itemWriteStatus}</div>}{itemWriteLocked && !itemWriteStatus && <div className="sc-item-inline-status" role="status">{itemWritePermanentReadOnly ? "当前只读开放；播放和字幕可用，位置只留在本页且不会用不安全的凭据写入。" : "当前位置先暂存在本页；安全操作结束后会再尝试保存。"}</div>}{mediaError && <div className="sc-inline-error" role="alert">{mediaError}</div>}{remoteBlocked ? <div className="sc-notice">本地锁阻止了远程音频请求。你仍可阅读字幕；关闭本地锁后才会连接音频来源。</div> : !src && <div className="sc-notice">当前单集没有可播放音频。英文字幕仍可阅读和选词。</div>}{!alignedTranscript && episodeSegments.length > 0 && <div className="sc-notice">这份纯文本字幕没有时间轴，因此不会伪装成同步字幕；你仍可逐段阅读和选词。</div>}<section className="sc-transcript-shell"><aside><span>本期字幕</span><strong>{episodeSegments.length}</strong><p>{alignedTranscript?"段":"段 · 未对齐"}</p><button type="button" className={follow ? "active" : ""} aria-pressed={follow} aria-busy={autoFollowWriteBusy || undefined} aria-describedby={autoFollowStatus ? followStatusId : undefined} disabled={!alignedTranscript || (autoFollowWriteLocked && !canResumeLocally)} onClick={(event) => { if (canResumeLocally) setFollowPaused(false); else { if (!autoFollow) setFollowPaused(false); onAutoFollow(!autoFollow, event.currentTarget); } }}>◎ {autoFollowWriteBusy ? "正在确认偏好…" : follow ? "正在跟随" : autoFollow ? "继续这次跟随" : "开启自动跟随"}</button>{autoFollowStatus && <small id={followStatusId} className="sc-podcast-follow-status" role="status">{autoFollowStatus}</small>}</aside><div className="sc-transcript" onWheel={() => { if (autoFollow) setFollowPaused(true); }}>{episodeSegments.length ? episodeSegments.map((segment,index) => { const words=wordRanges(segment.text);const activeRange=keyboardWord?.segmentId===segment.id?words[keyboardWord.index]:null;return <button ref={alignedTranscript&&index === activeIndex ? activeRow : undefined} key={segment.id} className={alignedTranscript&&index === activeIndex ? "active" : ""} aria-current={alignedTranscript&&index===activeIndex?"true":undefined} title="左右方向键选择单词，Enter 或 E 查看解释；Space 跳到此处" onFocus={()=>{if(words.length&&keyboardWord?.segmentId!==segment.id)setKeyboardWord({segmentId:segment.id,index:0});}} onKeyDown={(event)=>transcriptKey(segment,index,event)} onClick={() => { if (alignedTranscript) seek(segment.start_ms); }} onMouseUp={(event) => pick(segment,index,event)}><time>{alignedTranscript?formatDuration(segment.start_ms):"—"}</time><p><AnnotatedText text={segment.text} ranges={occurrences.filter((entry) => entry.segment_id === segment.id)} activeRange={activeRange}/></p>{segment.speaker && <small>{segment.speaker}</small>}</button>;}) : <EmptyState title="没有字幕" copy="导入 VTT、SRT、LRC 或纯文本后，字幕会显示在这里。"/>}</div></section></div>;
}

export function WordsView({ lexemes, occurrences, onOpen, onStar }: { lexemes: Lexeme[]; occurrences: Occurrence[]; onOpen: (id: string) => void; onStar: (word: Lexeme) => void }) {
  const [query,setQuery]=useState(""); const [filter,setFilter]=useState<"all"|Lexeme["status"]|"starred">("all");
  const visible=lexemes.filter((word)=>(filter==="all"?true:filter==="starred"?Boolean(word.starred):word.status===filter)&&`${word.headword}${word.pronunciation}${word.gloss_en}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="sc-page sc-words-page"><header className="sc-page-title"><div><span className="sc-eyebrow">WORDS IN CONTEXT</span><h1>词库</h1><p>{lexemes.length} 个英文词，来自 {new Set(occurrences.map((item)=>item.item_id).filter(Boolean)).size} 份语境。</p></div></header><div className="sc-toolbar"><label className="sc-search">⌕<input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="搜索单词、发音或英文释义"/></label><div className="sc-segmented">{([['all','全部'],['learning','学习中'],['known','已掌握'],['starred','收藏']] as const).map(([id,label])=><button aria-pressed={filter===id} key={id} className={filter===id?"active":""} onClick={()=>setFilter(id)}>{label}</button>)}</div></div>{visible.length?<div className="sc-word-table"><div className="sc-word-table-head"><span>单词</span><span>英文释义</span><span>出现</span><span>状态</span><span/></div>{visible.map((word)=><article key={word.id}><button className="sc-star" onClick={()=>onStar(word)} aria-label={word.starred?"取消收藏":"收藏单词"}>{word.starred?"◆":"◇"}</button><button className="sc-word-open" onClick={()=>onOpen(word.id)}><span className="sc-word-name"><strong>{word.headword}</strong><span>{word.pronunciation||"Pronunciation pending"}</span></span><span className="sc-word-gloss">{word.gloss_en||"No explanation yet"}</span><b>{word.occurrence_count}</b><i className={`status-${word.status}`}>{word.status==="learning"?"学习中":word.status==="known"?"已掌握":word.status==="ignored"?"已忽略":"已保存"}</i><span className="sc-row-arrow">→</span></button></article>)}</div>:<EmptyState title="没有符合条件的词" copy="试试别的搜索，或回到英文原文里拾起一个词。"/>}</div>;
}

type ReviewViewProps = {
  cards: ReviewCard[];
  onRefresh: () => Promise<void>;
  onGo: (view: VocabView) => void;
};

type ReviewJournalState = VocabReviewRecoveryReadResult & Readonly<{
  loaded: boolean;
}>;

const EMPTY_REVIEW_JOURNAL: ReviewJournalState = {
  loaded: false,
  entries: [],
  unreadableEntries: [],
  storageUnavailable: false,
};

type ReviewRecentUndoState = VocabReviewRecentUndoReadResult & Readonly<{
  loaded: boolean;
}>;

const EMPTY_RECENT_UNDO: ReviewRecentUndoState = {
  loaded: false,
  entry: null,
  unreadable: null,
  storageUnavailable: false,
};

function reviewActionLabel(ticket: VocabReviewRecoveryTicket): string {
  return ticket.action === "rating" ? "这次选择" : "这次撤销";
}

export function ReviewView({ cards, onRefresh, onGo }: ReviewViewProps) {
  const [reviewClock, setReviewClock] = useState(() => Date.now());
  const due = getDueCards(cards, reviewClock);
  const [roundIds, setRoundIds] = useState(() => startReviewRound(due));
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const [locallyRatedVersions, setLocallyRatedVersions] = useState<Record<string, number>>({});
  const [locallyRestoredCard, setLocallyRestoredCard] = useState<ReviewCard | null>(null);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [journal, setJournal] = useState<ReviewJournalState>(EMPTY_REVIEW_JOURNAL);
  const [recentUndo, setRecentUndo] = useState<ReviewRecentUndoState>(EMPTY_RECENT_UNDO);
  const [journalLockUnavailable, setJournalLockUnavailable] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const [undoNotice, setUndoNotice] = useState("");
  const revealButton = useRef<HTMLButtonElement>(null);
  const completeHeading = useRef<HTMLHeadingElement>(null);
  const recoveryHeading = useRef<HTMLHeadingElement>(null);
  const recentUndoHeading = useRef<HTMLHeadingElement>(null);
  const handOffFocus = useRef(false);
  const focusAnnouncement = useRef("");
  const focusRecoveryAfterAction = useRef(false);
  const recoveryFocusTarget = useRef<"operation" | "recent-undo">("operation");
  const operationClaim = useRef(false);
  const locallySettledOperations = useRef(new Set<string>());
  const seenRecentEvent = useRef<string | null>(null);
  const availableDue = due.filter((dueCard) => {
    const beforeVersion = locallyRatedVersions[dueCard.id];
    return beforeVersion === undefined || dueCard.updated_at !== beforeVersion;
  });
  const roundSource = locallyRestoredCard && !availableDue.some(({ id }) => id === locallyRestoredCard.id)
    ? [locallyRestoredCard, ...availableDue]
    : availableDue;
  const round = resolveReviewRound(roundSource, roundIds);
  const card = round[0] ?? null;
  const activeRecovery = journal.entries[0] ?? null;
  const recoveryBlocksWrites = !journal.loaded || journal.storageUnavailable ||
    journalLockUnavailable || journal.unreadableEntries.length > 0 ||
    journal.entries.length > 0;

  const reloadReviewJournal = useCallback(() => {
    const next = readBrowserVocabReviewRecovery();
    const latest = readBrowserVocabReviewRecentUndo();
    setJournal({ ...next, loaded: true });
    setRecentUndo({ ...latest, loaded: true });
    if (!navigator.locks) setJournalLockUnavailable(true);
    if (!latest.storageUnavailable) {
      const eventId = latest.entry?.ticket.receipt.eventId ?? null;
      if (eventId) {
        seenRecentEvent.current = eventId;
        setLastEvent(eventId);
      } else {
        const previous = seenRecentEvent.current;
        if (previous) {
          setLastEvent((current) => current === previous ? null : current);
          seenRecentEvent.current = null;
        }
      }
    }
  }, []);

  useEffect(() => {
    let live = true;
    queueMicrotask(() => {
      if (live) reloadReviewJournal();
    });
    return () => { live = false; };
  }, [reloadReviewJournal]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (
        event.storageArea === window.localStorage &&
        (
          event.key === null ||
          event.key.startsWith(VOCAB_REVIEW_RECOVERY_PREFIX) ||
          event.key === VOCAB_REVIEW_RECENT_UNDO_KEY
        )
      ) reloadReviewJournal();
    };
    const onFocus = () => reloadReviewJournal();
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
    };
  }, [reloadReviewJournal]);

  const claim = useCallback(() => {
    if (operationClaim.current) return false;
    operationClaim.current = true;
    setBusy(true);
    return true;
  }, []);

  const release = useCallback(() => {
    operationClaim.current = false;
    setBusy(false);
  }, []);

  const focusRecovery = useCallback((target: "operation" | "recent-undo" = "operation") => {
    recoveryFocusTarget.current = target;
    focusRecoveryAfterAction.current = true;
  }, []);

  useEffect(() => {
    if (!focusRecoveryAfterAction.current) return;
    const frame = window.requestAnimationFrame(() => {
      const target = recoveryFocusTarget.current === "recent-undo"
        ? recentUndoHeading.current ?? recoveryHeading.current
        : recoveryHeading.current;
      focusRecoveryAfterAction.current = false;
      if (!target) return;
      target.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeRecovery?.raw, journal.storageUnavailable, journal.unreadableEntries.length, recoveryNotice]);

  const applySettledTicket = useCallback((ticket: VocabReviewRecoveryTicket) => {
    if (locallySettledOperations.current.has(ticket.operationId)) return;
    locallySettledOperations.current.add(ticket.operationId);
    const receipt = ticket.receipt;
    const snapshotCard = cards.find(({ id }) => id === receipt.cardId) ?? null;
    const beforeCard = snapshotCard
      ? { ...snapshotCard, ...receipt.before }
      : null;
    setError("");
    setRevealed(false);
    setReviewClock(Date.now());
    if (ticket.action === "rating") {
      setLastEvent(receipt.eventId);
      setLocallyRatedVersions((current) => ({
        ...current,
        [receipt.cardId]: receipt.before.updated_at,
      }));
      setLocallyRestoredCard((current) =>
        current?.id === receipt.cardId ? null : current);
      setRoundIds((current) => current.filter((id) => id !== receipt.cardId));
      setReviewed((count) => count + 1);
      focusAnnouncement.current = "已记录这次选择，下一张可以开始。";
    } else {
      setRoundIds((current) => restoreUndoneCardToRound(current, receipt.cardId));
      setLocallyRatedVersions((current) => {
        const next = { ...current };
        delete next[receipt.cardId];
        return next;
      });
      setLocallyRestoredCard(beforeCard);
      setLastEvent(null);
      setReviewed((count) => Math.max(0, count - 1));
      focusAnnouncement.current = "已撤销上一次选择。";
    }
    handOffFocus.current = true;
  }, [cards]);

  const noteTransactionGate = useCallback((
    result: VocabReviewJournalTransactionResult<unknown>,
  ) => {
    reloadReviewJournal();
    if (result.outcome === "stale") {
      setRecoveryNotice("另一页已经更新这条线索。这里已重新读取，没有覆盖旧结果。");
    } else if (result.outcome === "unavailable") {
      setJournalLockUnavailable(true);
      setRecoveryNotice("暂时无法取得跨页面恢复锁。没有核对、提交或清除任何结果。");
    } else {
      setJournalLockUnavailable(false);
    }
  }, [reloadReviewJournal]);

  const replaceLockedMode = useCallback((
    locked: VocabReviewLockedEntry,
    mode: VocabReviewRecoveryTicket["mode"],
  ) => locked.replace(transitionVocabReviewRecoveryTicket(
    locked.current().ticket,
    mode,
  )), []);

  const rememberCommitOutcome = useCallback((
    locked: VocabReviewLockedEntry,
    caught: unknown,
  ) => {
    const entry = locked.current();
    let mode: VocabReviewRecoveryTicket["mode"] = "inspect-only";
    let message = `${reviewActionLabel(entry.ticket)}的结果待核对；没有重复记录。`;
    if (caught instanceof VocabReviewNotSavedError) {
      mode = "retry-commit";
      message = `${reviewActionLabel(entry.ticket)}已确认没有写入。想保留时，可以用同一条凭据再试一次。`;
    } else if (
      caught instanceof VocabReviewConflictError ||
      caught instanceof VocabReviewChangedError
    ) {
      mode = "discard-only";
      message = "数据库里已有别的变化。这里不会覆盖它，也不会重复记录。";
    } else if (caught instanceof VocabReviewUncertainError) {
      message = `${reviewActionLabel(entry.ticket)}的结果待核对。下一步只会读取，不会再写一次。`;
    }
    focusRecovery();
    const moved = replaceLockedMode(locked, mode);
    setRecoveryNotice(moved.outcome === "written"
      ? message
      : "本机线索在处理时发生变化。没有覆盖它，也没有再次提交。");
  }, [focusRecovery, replaceLockedMode]);

  const finishCommittedTicket = useCallback(async (
    locked: VocabReviewLockedEntry,
  ) => {
    const entry = locked.current();
    const recentResult = entry.ticket.receipt.kind === "review-rating"
      ? locked.rememberRecentRating(entry.ticket.receipt)
      : locked.clearRecentRating(entry.ticket.receipt.eventId);
    applySettledTicket(entry.ticket);
    setAnnouncement(entry.ticket.action === "rating"
      ? "这次选择已记录。"
      : "上一次选择已撤销。");
    setRecoveryNotice(entry.ticket.action === "rating"
      ? recentResult.outcome === "written"
        ? "这次选择已记录，刷新页面后仍可撤销；正在重新读取页面。"
        : "这次选择已记录，正在重新读取页面；最近一次撤销入口暂时无法持久保留。"
      : "这次撤销已记录，正在重新读取页面。");
    const moved = replaceLockedMode(locked, "refresh-only");
    if (moved.outcome !== "written") {
      setRecoveryNotice("记录已经完成，但本机线索暂时无法转为只刷新状态。没有再次提交。");
      return;
    }
    try {
      await onRefresh();
    } catch {
      setRecoveryNotice(
        `${reviewActionLabel(entry.ticket)}已经保存在本机，只是页面暂时没有重新读到。只需稍后重新读取，不会再次提交。`,
      );
      return;
    }
    const removed = locked.remove();
    if (removed.outcome === "removed") {
      setRecoveryNotice(entry.ticket.action === "rating"
        ? "这次选择已记录，页面也已重新读取。"
        : "这次撤销已完成，页面也已重新读取。");
    } else {
      setRecoveryNotice(removed.outcome === "stale"
        ? "另一页已经接手这条线索；这里没有清除它的新状态。"
        : "页面已经重新读取，但本机提醒暂时无法清除。没有再次提交。");
    }
  }, [applySettledTicket, onRefresh, replaceLockedMode]);

  const commitRecoveryEntry = useCallback(async (
    locked: VocabReviewLockedEntry,
  ) => {
    const receipt = locked.current().ticket.receipt;
    try {
      if (receipt.kind === "review-rating") {
        await commitVocabReviewRating(receipt);
      } else {
        await commitVocabReviewUndo(receipt);
      }
      await finishCommittedTicket(locked);
    } catch (caught) {
      rememberCommitOutcome(locked, caught);
    }
  }, [finishCommittedTicket, rememberCommitOutcome]);

  const submit = useCallback(async (rating: ReviewRating) => {
    if (!card || recoveryBlocksWrites || !claim()) return;
    setError("");
    setUndoNotice("");
    try {
      const receipt = await prepareVocabReviewRating(card, rating);
      const ticket = createVocabReviewRecoveryTicket(receipt, "inspect-only");
      const result = await runNewVocabReviewRecoveryTransaction(
        ticket,
        commitRecoveryEntry,
      );
      noteTransactionGate(result);
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : "这次选择还没有提交；当前卡片会留在这里。");
    } finally {
      release();
    }
  }, [card, claim, commitRecoveryEntry, noteTransactionGate, recoveryBlocksWrites, release]);

  const settleUnavailableRecentUndo = useCallback(async (
    source: VocabReviewRecentUndoEntry,
    alreadyDefinite: boolean,
  ): Promise<"handled" | "exact" | "unknown"> => {
    const result = await runVocabReviewRecentUndoEntryTransaction(
      source,
      async (locked) => {
        const status = alreadyDefinite
          ? "definite" as const
          : await inspectVocabReviewRating(locked.current().ticket.receipt);
        const removed = status === "definite" || status === "absent" ||
            status === "changed" || status === "conflict"
          ? locked.remove()
          : null;
        return { status, removed };
      },
    );
    noteTransactionGate(result);
    if (result.outcome === "stale") {
      setUndoNotice("另一页已经更新最近一次评分；这里没有清除新的撤销入口，也没有改动记录。");
      return "handled";
    }
    if (result.outcome === "unavailable") {
      setUndoNotice("暂时无法安全核对撤销入口；它仍保留，复习记录没有改动。");
      return "unknown";
    }
    if (result.value.status === "exact") return "exact";
    if (result.value.status === "still_unknown") {
      setUndoNotice("这次评分与当前词库的关系仍待核对；撤销入口会保留，复习记录没有改动。");
      return "unknown";
    }
    const removed = result.value.removed;
    if (removed?.outcome === "removed") {
      setUndoNotice("当前词库没有这次评分，未改动记录；旧的撤销入口已清除。");
      setAnnouncement("当前词库没有这次评分，未改动记录。");
      focusAnnouncement.current = "当前词库没有这次评分，未改动记录。";
      handOffFocus.current = true;
    } else if (removed?.outcome === "stale") {
      setUndoNotice("另一页已经更新最近一次评分；这里没有清除新的撤销入口，也没有改动记录。");
    } else {
      setUndoNotice("当前词库没有这次评分，记录未改动；旧的撤销入口暂时无法安全清除。");
    }
    return "handled";
  }, [noteTransactionGate]);

  const undoLast = useCallback(async () => {
    if (!lastEvent || recoveryBlocksWrites || !claim()) return;
    const source = recentUndo.entry?.ticket.receipt.eventId === lastEvent
      ? recentUndo.entry
      : null;
    setError("");
    setUndoNotice("");
    try {
      const receipt = await prepareVocabReviewUndo(lastEvent);
      const ticket = createVocabReviewRecoveryTicket(receipt, "inspect-only");
      const result = await runNewVocabReviewRecoveryTransaction(
        ticket,
        commitRecoveryEntry,
      );
      noteTransactionGate(result);
    } catch (caught) {
      if (source && caught instanceof VocabReviewUncertainError) {
        setUndoNotice("这次评分与当前词库的关系仍待核对；撤销入口会保留，复习记录没有改动。");
        return;
      }
      if (source) {
        const definitelyUnavailable = caught instanceof VocabReviewNotSavedError ||
          caught instanceof VocabReviewConflictError ||
          caught instanceof VocabReviewChangedError;
        const disposition = await settleUnavailableRecentUndo(
          source,
          definitelyUnavailable,
        );
        if (disposition !== "exact") return;
      }
      setError(caught instanceof Error
        ? caught.message
        : "这次撤销还没有提交；上一次选择没有被改动。");
    } finally {
      release();
    }
  }, [claim, commitRecoveryEntry, lastEvent, noteTransactionGate, recentUndo.entry, recoveryBlocksWrites, release, settleUnavailableRecentUndo]);

  const inspectActiveRecovery = useCallback(async () => {
    if (!activeRecovery || activeRecovery.ticket.mode !== "inspect-only" || !claim()) return;
    setError("");
    focusRecovery();
    try {
      const result = await runVocabReviewRecoveryEntryTransaction(
        activeRecovery,
        async (locked) => {
          const receipt = locked.current().ticket.receipt;
          const status = receipt.kind === "review-rating"
            ? await inspectVocabReviewRating(receipt)
            : await inspectVocabReviewUndo(receipt);
          if (status === "exact") {
            const moved = replaceLockedMode(locked, "refresh-only");
            if (moved.outcome === "written") setRecoveryNotice(
              `${reviewActionLabel(activeRecovery.ticket)}已经存在，没有重复记录。下一步只重新读取页面。`,
            );
          } else if (status === "absent") {
            const moved = replaceLockedMode(locked, "retry-commit");
            if (moved.outcome === "written") setRecoveryNotice(
              `${reviewActionLabel(activeRecovery.ticket)}已确认没有写入。想保留时，可以用同一条凭据再试一次。`,
            );
          } else if (status === "conflict" || status === "changed") {
            const moved = replaceLockedMode(locked, "discard-only");
            if (moved.outcome === "written") setRecoveryNotice(
              "数据库里已有别的变化。这里不会覆盖它；可以重新读取或只清除提醒。",
            );
          } else {
            setRecoveryNotice("结果暂时仍无法核对。没有写入，也没有重复记录；稍后可以再次只读核对。");
          }
        },
      );
      noteTransactionGate(result);
    } finally {
      release();
    }
  }, [activeRecovery, claim, focusRecovery, noteTransactionGate, release, replaceLockedMode]);

  const retryActiveRecovery = useCallback(async () => {
    if (!activeRecovery || activeRecovery.ticket.mode !== "retry-commit" || !claim()) return;
    setError("");
    focusRecovery();
    try {
      const result = await runVocabReviewRecoveryEntryTransaction(
        activeRecovery,
        commitRecoveryEntry,
      );
      noteTransactionGate(result);
    } finally {
      release();
    }
  }, [activeRecovery, claim, commitRecoveryEntry, focusRecovery, noteTransactionGate, release]);

  const refreshLockedRecovery = useCallback(async (
    locked: VocabReviewLockedEntry,
    applySettled: boolean,
  ) => {
    const entry = locked.current();
    try {
      await onRefresh();
    } catch {
      setRecoveryNotice(applySettled
        ? `${reviewActionLabel(entry.ticket)}已保存在本机，只是页面暂时没有重新读到。没有再次提交。`
        : "页面暂时没有重新读到数据库现状。没有覆盖或重复记录；提醒仍保留。",
      );
      return;
    }
    if (applySettled) {
      if (entry.ticket.receipt.kind === "review-rating") {
        locked.rememberRecentRating(entry.ticket.receipt);
      } else {
        locked.clearRecentRating(entry.ticket.receipt.eventId);
      }
      applySettledTicket(entry.ticket);
    }
    const removed = locked.remove();
    if (removed.outcome === "removed") {
      setRecoveryNotice(applySettled
        ? `${reviewActionLabel(entry.ticket)}已确认，页面也已重新读取。`
        : "页面已按数据库现状重新读取，只清除了这条提醒。");
      if (!applySettled) {
        focusAnnouncement.current = "页面已重新读取，没有覆盖数据库现状。";
        handOffFocus.current = true;
      }
    } else {
      setRecoveryNotice(removed.outcome === "stale"
        ? "另一页已经更新这条线索；这里没有清除它的新状态。"
        : "页面已经重新读取，但提醒暂时无法清除。没有再次提交。");
    }
  }, [applySettledTicket, onRefresh]);

  const refreshActiveRecovery = useCallback(async () => {
    if (!activeRecovery || activeRecovery.ticket.mode !== "refresh-only" || !claim()) return;
    focusRecovery();
    try {
      const result = await runVocabReviewRecoveryEntryTransaction(
        activeRecovery,
        (locked) => refreshLockedRecovery(locked, true),
      );
      noteTransactionGate(result);
    } finally {
      release();
    }
  }, [activeRecovery, claim, focusRecovery, noteTransactionGate, refreshLockedRecovery, release]);

  const refreshChangedRecovery = useCallback(async () => {
    if (!activeRecovery || activeRecovery.ticket.mode !== "discard-only" || !claim()) return;
    focusRecovery();
    try {
      const result = await runVocabReviewRecoveryEntryTransaction(
        activeRecovery,
        (locked) => refreshLockedRecovery(locked, false),
      );
      noteTransactionGate(result);
    } finally {
      release();
    }
  }, [activeRecovery, claim, focusRecovery, noteTransactionGate, refreshLockedRecovery, release]);

  const clearActiveRecovery = useCallback(async () => {
    if (!activeRecovery || activeRecovery.ticket.mode !== "discard-only" || !claim()) return;
    focusRecovery();
    try {
      const result = await runVocabReviewRecoveryEntryTransaction(
        activeRecovery,
        async (locked) => {
          const removed = locked.remove();
          setRecoveryNotice(removed.outcome === "removed"
            ? "只清除了这条提醒；数据库现状保持不变。"
            : removed.outcome === "stale"
              ? "另一页已经更新这条线索；这里没有清除它的新状态。"
              : "暂时无法清除提醒；数据库现状没有改变。");
          if (removed.outcome === "removed") {
            focusAnnouncement.current = "只清除了恢复提醒，数据库现状没有改变。";
            handOffFocus.current = true;
          }
        },
      );
      noteTransactionGate(result);
    } finally {
      release();
    }
  }, [activeRecovery, claim, focusRecovery, noteTransactionGate, release]);

  const clearUnreadableRecovery = useCallback(async () => {
    const unreadable = journal.unreadableEntries[0];
    if (!unreadable || !claim()) return;
    focusRecovery();
    try {
      const removed = await removeUnreadableVocabReviewEntry(unreadable);
      reloadReviewJournal();
      setRecoveryNotice(removed.outcome === "removed"
        ? "只清除了无法验证的提醒；它没有被交给数据库，现有记录保持不变。"
        : removed.outcome === "stale"
          ? "另一页已经更新这条提醒；这里没有清除它的新内容。"
          : "暂时无法清除提醒；数据库现状没有改变。");
    } finally {
      release();
    }
  }, [claim, focusRecovery, journal.unreadableEntries, release, reloadReviewJournal]);

  const clearUnreadableRecentUndo = useCallback(async () => {
    const unreadable = recentUndo.unreadable;
    if (!unreadable || !claim()) return;
    focusRecovery("recent-undo");
    try {
      const removed = await removeUnreadableVocabReviewRecentUndo(unreadable);
      reloadReviewJournal();
      setRecoveryNotice(removed.outcome === "removed"
        ? "只清除了无法验证的撤销提醒；复习记录保持不变。"
        : removed.outcome === "stale"
          ? "另一页已经更新这条撤销提醒；这里没有清除它的新内容。"
          : "暂时无法清除撤销提醒；复习记录没有改变。");
      if (removed.outcome === "removed") {
        focusAnnouncement.current = "只清除了无法验证的撤销提醒，复习记录没有改变。";
        handOffFocus.current = true;
      }
    } finally {
      release();
    }
  }, [claim, focusRecovery, recentUndo.unreadable, release, reloadReviewJournal]);

  const retryJournalProtection = useCallback(async () => {
    if (!claim()) return;
    focusRecovery();
    try {
      const outcome = await probeVocabReviewJournalLock();
      setJournalLockUnavailable(outcome !== "available");
      reloadReviewJournal();
      setRecoveryNotice(outcome === "available"
        ? "跨页面保护已经恢复；没有自动核对或提交。"
        : "跨页面保护仍不可用。没有核对、提交或清除任何结果。");
    } finally {
      release();
    }
  }, [claim, focusRecovery, release, reloadReviewJournal]);

  const startAnotherRound = () => {
    setRoundIds(startReviewRound(roundSource));
    setReviewed(0);
    setRevealed(false);
    setError("");
    focusAnnouncement.current = "新的一小轮已经开始。";
    handOffFocus.current = true;
  };

  useEffect(() => {
    if (!handOffFocus.current || busy) return;
    const frame = window.requestAnimationFrame(() => {
      const target = card ? revealButton.current : completeHeading.current;
      if (!target) return;
      target.focus({ preventScroll: true });
      setAnnouncement(
        focusAnnouncement.current || (card
          ? "已记录，下一张可以开始。"
          : "已记录，这一小轮到这里。"),
      );
      focusAnnouncement.current = "";
      handOffFocus.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [busy, card]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (isInteractiveTarget(event.target)) return;
      if (event.key === " " && card && !revealed) {
        event.preventDefault();
        setRevealed(true);
      }
      if (
        revealed &&
        !recoveryBlocksWrites &&
        ["1", "2", "3", "4"].includes(event.key)
      ) {
        const ratings: ReviewRating[] = ["again", "hard", "good", "easy"];
        void submit(ratings[Number(event.key) - 1]);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [card, recoveryBlocksWrites, revealed, submit]);

  const recoveryPanel = (() => {
    let title = "";
    let copy = "";
    let actions: React.ReactNode = null;
    let tone = "quiet";
    if (!journal.loaded) {
      title = "正在查看本机核对线索";
      copy = "确认完成前，评分按钮会先保持停用。";
    } else if (journal.storageUnavailable) {
      title = "暂时无法读取复习核对线索";
      copy = "为避免重复记录，新选择先停用；已经保存的内容没有因此改变。";
      tone = "warning";
      actions = <button disabled={busy} onClick={() => {
        focusRecovery();
        reloadReviewJournal();
        setRecoveryNotice("已重新查看本机线索；不会自动核对或提交。");
      }}>重新查看本机线索</button>;
    } else if (journalLockUnavailable) {
      title = "暂时无法取得跨页面保护";
      copy = "为避免两页同时改动，新选择与恢复动作先停用；复习记录没有因此改变。";
      tone = "warning";
      actions = <button disabled={busy} onClick={() => void retryJournalProtection()}>
        重新检查跨页面保护
      </button>;
    } else if (journal.unreadableEntries.length > 0) {
      title = "有一条核对提醒无法验证";
      copy = "它不会被交给数据库，也不会触发评分或撤销。可以保留数据库现状并清除这条提醒。";
      tone = "warning";
      actions = <button disabled={busy} onClick={() => void clearUnreadableRecovery()}>
        保留数据库现状并清除提醒
      </button>;
    } else if (activeRecovery) {
      const label = reviewActionLabel(activeRecovery.ticket);
      if (activeRecovery.ticket.mode === "inspect-only") {
        title = "有一次结果待核对";
        copy = `${label}只会做只读核对；不会自动再写一次，也不会抢走当前焦点。`;
        actions = <button disabled={busy} onClick={() => void inspectActiveRecovery()}>
          只读核对结果
        </button>;
      } else if (activeRecovery.ticket.mode === "retry-commit") {
        title = `${label}已确认没有记录`;
        copy = "如果仍想保留，可以用同一条凭据再试一次；不会生成第二条操作。";
        actions = <button disabled={busy} onClick={() => void retryActiveRecovery()}>
          用同一条凭据再试一次
        </button>;
      } else if (activeRecovery.ticket.mode === "refresh-only") {
        title = activeRecovery.ticket.action === "rating"
          ? "这次选择已记录"
          : "这次撤销已记录";
        copy = "数据库已经完成，只需重新读取页面；这个动作不会再次提交。";
        actions = <button disabled={busy} onClick={() => void refreshActiveRecovery()}>
          只重新读取页面
        </button>;
      } else {
        title = "数据库里已有别的变化";
        copy = "这里不会覆盖它。可以按数据库现状重新读取，也可以只清除这条提醒。";
        tone = "warning";
        actions = <>
          <button disabled={busy} onClick={() => void refreshChangedRecovery()}>
            只刷新页面并清除提醒
          </button>
          <button className="secondary" disabled={busy} onClick={() => void clearActiveRecovery()}>
            保留现状并清除提醒
          </button>
        </>;
      }
    }
    if (!title) return null;
    return <section className={`sc-review-recovery ${tone}`} role={tone === "warning" ? "alert" : "status"}>
      <div>
        <h2 ref={recoveryHeading} tabIndex={-1}>{title}</h2>
        <p>{copy}</p>
        {recoveryNotice && <small>{recoveryNotice}</small>}
        {journal.entries.length > 1 && <small>另有 {journal.entries.length - 1} 条线索，会逐条处理。</small>}
      </div>
      {actions && <footer>{actions}</footer>}
    </section>;
  })();
  const recentUndoNote = recentUndo.loaded && recentUndo.unreadable
    ? <section className="sc-review-recent-note" role="status">
        <div>
          <h2 ref={recentUndoHeading} tabIndex={-1}>最近一次撤销提醒无法验证</h2>
          <p>它不会被交给数据库；新选择不受影响。</p>
          {recoveryNotice && <small>{recoveryNotice}</small>}
        </div>
        <button disabled={busy} onClick={() => void clearUnreadableRecentUndo()}>
          保留复习记录，只清除无法验证的撤销提醒
        </button>
      </section>
    : null;

  if (!card) {
    const startedEmpty = roundIds.length === 0 && reviewed === 0;
    return <div className="sc-page sc-review-complete">
      <span aria-hidden="true">{startedEmpty ? "○" : "✓"}</span>
      <h1 ref={completeHeading} tabIndex={-1}>{startedEmpty ? "现在没有适合回看的词" : "这一小轮到这里"}</h1>
      <p>{startedEmpty
        ? "不需要凑数量。想读一点新的内容可以，先停在这里也可以。"
        : `刚刚回看了 ${reviewed} 个词。${roundSource.length ? "其他词会留在原处，想继续时再来。" : "现在可以停下，合适的时候再回来。"}`}</p>
      {recoveryPanel}
      {recentUndoNote}
      {undoNotice && <div className="sc-review-undo-note" role="status">{undoNotice}</div>}
      {error && <div className="sc-review-error" role="alert">{error}</div>}
      <div className="sc-review-complete-actions">
        <button onClick={() => onGo("today")}>{startedEmpty ? "回到今日" : "先停在这里"}</button>
        {startedEmpty
          ? <button className="primary" onClick={() => onGo("library")}>去资料库</button>
          : roundSource.length > 0 && <button className="primary" onClick={startAnotherRound}>再来一小轮</button>}
        {lastEvent && <button disabled={busy || recoveryBlocksWrites} onClick={() => void undoLast()}>↶ 撤销上次选择</button>}
      </div>
      <div className="sc-visually-hidden" role="status" aria-live="polite">{announcement}</div>
    </div>;
  }

  const nextLabel = (rating: ReviewRating) => {
    const delay = scheduleReviewV2(card, rating, reviewClock).due_at - reviewClock;
    if (delay < 3_600_000) return `${Math.max(1, Math.round(delay / 60_000))} 分钟`;
    if (delay < 172_800_000) return `${Math.max(1, Math.round(delay / 3_600_000))} 小时`;
    return `${Math.max(1, Math.round(delay / 86_400_000))} 天`;
  };

  return <div className="sc-page sc-review-page">
    <header><div><span className="sc-eyebrow">BACK TO CONTEXT</span><h1>这一小轮</h1></div><div className="sc-review-pause"><strong>随时停</strong><span>已记录的评分会留在本机</span></div></header>
    {recoveryPanel}
    {recentUndoNote}
    {undoNotice && <div className="sc-review-undo-note" role="status">{undoNotice}</div>}
    <section className={`sc-review-card ${revealed ? "revealed" : ""}`}><span className="sc-card-label">{revealed ? "解释" : "还记得这个语境吗？"}</span><h2>{card.headword}</h2><p className="sc-pronunciation">{revealed ? card.pronunciation : ""}</p><div className="sc-cloze">“{card.cloze_sentence || `Recall “${card.headword}” in context.`}”</div>{!revealed ? <button ref={revealButton} className="sc-reveal" onClick={() => setRevealed(true)}>查看解释 <kbd>Space</kbd></button> : <div className="sc-answer"><strong>{card.gloss_en || "No definition yet"}</strong><p>{card.context_sentence}</p></div>}</section>
    {revealed && <div className="sc-ratings">{([['again', '再看一次', '1'], ['hard', '有点难', '2'], ['good', '记得', '3'], ['easy', '很熟', '4']] as const).map(([id, label, key]) => <button key={id} className={id} disabled={busy || recoveryBlocksWrites} onClick={() => void submit(id)}><span>{label}</span><small>{nextLabel(id)}</small><kbd>{key}</kbd></button>)}</div>}
    {error && <div className="sc-review-error" role="alert">{error}</div>}
    <footer className="sc-review-footer"><span>随时停在这里，下次会从仍适合回看的词继续。</span>{lastEvent && <button disabled={busy || recoveryBlocksWrites} onClick={() => void undoLast()}>↶ 撤销上一次选择</button>}</footer>
    <div className="sc-visually-hidden" role="status" aria-live="polite">{announcement}</div>
  </div>;
}

export function StatsView({ snapshot }: { snapshot: VocabSnapshot }) {
  const [now] = useState(() => Date.now());
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now - (6 - index) * 86_400_000);
    const key = localDayKey(date);
    const row = snapshot.activity.find((item) => item.day === key);
    return {
      key,
      label: "日一二三四五六"[date.getDay()],
      seconds: (row?.read_seconds ?? 0) + (row?.listen_seconds ?? 0),
      reviews: row?.review_count ?? 0,
    };
  });
  const recentKeys = new Set(days.map((day) => day.key));
  const recent = snapshot.activity.filter((row) => recentKeys.has(row.day));
  const maximumSeconds = Math.max(1, ...days.map((day) => day.seconds));
  const readSeconds = recent.reduce((sum, row) => sum + row.read_seconds, 0);
  const listenSeconds = recent.reduce((sum, row) => sum + row.listen_seconds, 0);
  const totalSeconds = readSeconds + listenSeconds;
  const reviews = recent.reduce((sum, row) => sum + row.review_count, 0);
  const minuteValue = (seconds: number) => seconds === 0 ? "0" : seconds < 60 ? "<1" : String(Math.round(seconds / 60));
  const durationLabel = (seconds: number) => seconds === 0 ? "无记录" : seconds < 60 ? "少于 1 分钟" : `${Math.round(seconds / 60)} 分钟`;

  return <div className="sc-page sc-stats-page">
    <header className="sc-page-title"><div><span className="sc-eyebrow">A QUIET LOOK BACK</span><h1>最近的记录</h1><p>只呈现最近 7 天真实发生的阅读、收听与回看，不评价完成度。</p></div><div className="sc-date-chip">最近 7 天</div></header>
    <section className="sc-stat-strip"><Metric value={minuteValue(totalSeconds)} suffix="分钟" label="阅读与收听"/><Metric value={snapshot.lexemes.length} label="保存的词"/><Metric value={reviews} label="回到语境"/></section>
    <section className="sc-stats-grid">
      <article className="sc-chart-card"><header><div><span>有记录的时间</span><strong>{minuteValue(totalSeconds)}<small> 分钟</small></strong></div></header>{totalSeconds === 0
        ? <div className="sc-chart-empty"><strong>这 7 天还没有时间记录</strong><p>空白只表示没有记录，不代表落后。</p></div>
        : <div className="sc-bar-chart">{days.map((day) => <div key={day.key} aria-label={`${day.key}，${durationLabel(day.seconds)}，回看 ${day.reviews} 次`}><span>{day.seconds > 0 && <i style={{ height: `${Math.max(2, day.seconds / maximumSeconds * 100)}%` }}/>}</span><small>周{day.label}</small></div>)}</div>}</article>
      <article className="sc-balance-card"><span>阅读与收听</span>{totalSeconds > 0
        ? <div className="sc-balance-ring" style={{ "--read": `${readSeconds / totalSeconds * 100}%` } as CSSProperties}><strong>{Math.round(readSeconds / totalSeconds * 100)}%</strong><small>阅读</small></div>
        : <div className="sc-balance-empty"><strong>暂无</strong><small>时间记录</small></div>}<footer><span><i/>阅读 <b>{durationLabel(readSeconds)}</b></span><span><i/>收听 <b>{durationLabel(listenSeconds)}</b></span></footer></article>
    </section>
    <section className="sc-memory"><header><div><span>词语状态</span><p>帮助你决定想回到哪里，不是成绩。</p></div></header><div>{([['saved', '已保存'], ['learning', '学习中'], ['known', '已掌握']] as const).map(([status, label]) => { const count = snapshot.lexemes.filter((word) => word.status === status).length; return <span key={status}><b>{label}</b><i><em style={{ width: `${count / Math.max(1, snapshot.lexemes.length) * 100}%` }}/></i><strong>{count}</strong></span>; })}</div></section>
  </div>;
}

function formatStorageBytes(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "尚未报告";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

type SettingsViewProps = {
  settings: VocabSettings;
  settingsDraftDirty: boolean;
  settingsWriteLocked: boolean;
  settingsWriteBusy: boolean;
  databaseMutationLocked: boolean;
  settingsWriteStatus: string;
  storage: LocalStorageEstimate | null;
  persistenceSupported: boolean;
  onDraftChange: (patch: Partial<VocabSettings>) => void;
  onDraftCommit: (trigger: HTMLInputElement) => void;
  onToggle: (patch: Partial<VocabSettings>, trigger: HTMLButtonElement) => void;
  onDiscardDraft: () => void;
  onExport: () => Promise<string>;
  onRestoreRefresh: () => Promise<void>;
  onPersist: () => Promise<boolean | null>;
  onTestAi: () => Promise<void>;
};

export function SettingsView({ settings, settingsDraftDirty, settingsWriteLocked, settingsWriteBusy, databaseMutationLocked, settingsWriteStatus, storage, persistenceSupported, onDraftChange, onDraftCommit, onToggle, onDiscardDraft, onExport, onRestoreRefresh, onPersist, onTestAi }: SettingsViewProps) {
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  const run=async(action:()=>Promise<string|void>,success:string)=>{setBusy(true);setMessage("");try{const result=await action();setMessage(result||success);}catch(error){setMessage(error instanceof Error?error.message:"操作失败");}finally{setBusy(false);}};
  const settingsStatusId = "sc-settings-safe-write-status";
  const rangeProps = {
    disabled: settingsWriteLocked,
    "aria-describedby": settingsWriteStatus ? settingsStatusId : undefined,
    onPointerUp: (event: ReactPointerEvent<HTMLInputElement>) => onDraftCommit(event.currentTarget),
    onBlur: (event: ReactFocusEvent<HTMLInputElement>) => onDraftCommit(event.currentTarget),
  };
  return <div className="sc-page sc-settings-page" aria-busy={settingsWriteBusy || undefined}>
    <header className="sc-page-title"><div><span className="sc-eyebrow">PREFERENCES & PRIVACY</span><h1>设置</h1><p>调整阅读体验，并掌握哪些内容可以离开设备。</p></div></header>
    <div className="sc-settings-layout"><nav><a href="#reading">阅读体验</a><a href="#ai">AI 与隐私</a><a href="#review-settings">复习节奏</a><a href="#data">数据与备份</a></nav><div className="sc-settings-content">
      <section id="reading"><header><h2>阅读体验</h2><p>即时预览英文正文与字幕排版。</p></header>
        <div className="sc-setting-row"><label htmlFor="sc-font-scale">正文字号<small>文章与字幕</small></label><input {...rangeProps} id="sc-font-scale" type="range" min=".88" max="1.25" step=".01" value={settings.font_scale} onChange={(event)=>onDraftChange({font_scale:Number(event.target.value)})}/><b>{Math.round(settings.font_scale*100)}%</b></div>
        <div className="sc-setting-row"><label htmlFor="sc-line-height">行间距<small>让长文更从容</small></label><input {...rangeProps} id="sc-line-height" type="range" min="1.6" max="2.2" step=".02" value={settings.line_height} onChange={(event)=>onDraftChange({line_height:Number(event.target.value)})}/><b>{settings.line_height.toFixed(2)}</b></div>
        <Toggle label="字幕自动跟随" copy="播放时让当前句保持在视野中央" value={settings.auto_follow} disabled={settingsWriteLocked} describedBy={settingsWriteStatus ? settingsStatusId : undefined} onChange={(value, trigger)=>onToggle({auto_follow:value}, trigger)}/>
      </section>
      <section id="ai"><header><h2>AI 与隐私</h2><p>选词后会先显示准确字段说明；只有再点“解释这个词”才会发送。</p></header><Toggle label="默认显示简体中文说明" copy="英文释义始终优先" value={settings.chinese_explanation} disabled={settingsWriteLocked} describedBy={settingsWriteStatus ? settingsStatusId : undefined} onChange={(value, trigger)=>onToggle({chinese_explanation:value}, trigger)}/><Toggle label="本地锁" copy="阻止 URL、RSS、AI、转写与远程音频请求" value={settings.local_lock} disabled={settingsWriteLocked} describedBy={settingsWriteStatus ? settingsStatusId : undefined} onChange={(value, trigger)=>onToggle({local_lock:value}, trigger)}/><div className="sc-endpoint"><span><i className={settings.local_lock?"locked":""}/><b>DeepSeek · OpenAI compatible</b><small>{settings.local_lock?"本地锁已开启":"由服务端安全配置"}</small></span><button disabled={busy||settingsWriteLocked||settingsWriteBusy||settings.local_lock} onClick={()=>void run(onTestAi,"检测到服务端 AI 配置；这次检查没有发送文章或词语内容。")}>检查配置</button></div></section>
      <section id="review-settings"><header><h2>复习节奏</h2><p>这里只控制每天首次加入复习的新词，不会隐藏旧卡。</p></header><div className="sc-setting-row"><label htmlFor="sc-daily-limit">每日新词<small>0 只暂停新词；已到期、学习中和重新学习的词不受影响</small></label><input {...rangeProps} id="sc-daily-limit" type="range" min="0" max="30" value={settings.daily_new_limit} aria-valuetext={settings.daily_new_limit === 0 ? "暂停加入新词" : `每天最多 ${settings.daily_new_limit} 个新词`} onChange={(event)=>onDraftChange({daily_new_limit:Number(event.target.value)})}/><b>{settings.daily_new_limit === 0 ? "暂停" : `${settings.daily_new_limit} 个`}</b></div></section>
      <section id="data"><header><h2>数据与备份</h2><p>完整备份包含 SQLite 数据与实际保存在拾词里的本地音频。</p></header><div className={`sc-storage-fact ${storage?.persisted===true?"persisted":""}`}><span><i /><b>{storage?.persisted===true?"浏览器已授予持久化保护":!persistenceSupported?"当前浏览器未提供持久化保护接口":storage===null?"正在读取存储状态":storage.persisted===false?"仍可能被浏览器清理":"保护状态暂时未知"}</b><small>{storage?`当前占用 ${formatStorageBytes(storage.usage)} · 可用约 ${formatStorageBytes(storage.available)}`:"正在读取当前浏览器的容量信息"}</small></span>{persistenceSupported&&storage?.persisted!==true&&<button disabled={busy || settingsWriteLocked || settingsWriteBusy || databaseMutationLocked} onClick={()=>void run(async()=>{const result=await onPersist();return result===true?"已获得浏览器持久化保护。":result===false?"浏览器暂未授予持久化保护，请保持定期备份。":"保护请求已完成，但浏览器暂时无法复查状态。";},"")}>请求保护</button>}</div><VocabBackupFlow controlsDisabled={busy || settingsWriteLocked || settingsWriteBusy || databaseMutationLocked} onExport={onExport} onRefreshActivated={onRestoreRefresh} onNotice={setMessage}/>{(settingsWriteLocked || settingsWriteBusy || databaseMutationLocked) && <p className="sc-settings-backup-lock" role="status">先核对完页面上方的设置或条目收据，并处理未保存的阅读位置，再开始备份或切换资料库。</p>}<p className="sc-data-note">备份是未加密的私人文件，不含 AI 密钥。请把它保存在受信任的位置；旧版拾词数据库不包含本地音频原件。</p></section>
      {settingsWriteStatus&&<div id={settingsStatusId} className="sc-settings-safe-status" role="status"><span>{settingsWriteStatus}</span>{settingsDraftDirty&&<button type="button" disabled={settingsWriteBusy} onClick={onDiscardDraft}>放弃这次预览并读取最新设置</button>}</div>}
      {message&&<div className="sc-settings-message" role="status">{message}</div>}
    </div></div>
  </div>;
}
