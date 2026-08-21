"use client";
/* eslint-disable jsx-a11y/media-has-caption -- Every audio item has a synchronized, keyboard-accessible transcript beside the player. */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type SyntheticEvent } from "react";
import { createLocalFileObjectUrl, type LocalStorageEstimate } from "@/lib/local-db/files";
import { adjacentSentence, formatDuration, formatShortDate, sentenceContext, wordAt, wordRanges } from "@/lib/vocab/content";
import { getDueCards, recordStudySeconds } from "@/lib/vocab/store";
import { scheduleReviewV2 } from "@/lib/vocab/srs";
import type { ContentBlock, Lexeme, LibraryItem, Occurrence, ReviewCard, ReviewRating, SelectionTarget, TranscriptSegment, VocabSettings, VocabSnapshot, VocabView } from "@/lib/vocab/types";
import { AnnotatedText, EmptyState, Metric, Toggle } from "./ui";

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

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest("button,a,input,textarea,select,[contenteditable='true']"));
}

export function TodayView({ snapshot, due, onOpen, onGo, onImport, onWord }: { snapshot: VocabSnapshot; due: number; onOpen: (item: LibraryItem) => void; onGo: (view: VocabView) => void; onImport: () => void; onWord: (id: string) => void }) {
  const hour = new Date().getHours();
  const greeting = hour < 11 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  const resume = snapshot.items.find((item) => item.status === "in_progress") ?? snapshot.items[0];
  const today = localDayKey();
  const activity = snapshot.activity.find((entry) => entry.day === today);
  const minutes = Math.round(((activity?.read_seconds ?? 0) + (activity?.listen_seconds ?? 0)) / 60);
  return <div className="sc-page sc-today">
    <section className="sc-hero"><div><span className="sc-eyebrow">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</span><h1>{greeting}。<br/><em>今天想拾起什么？</em></h1><p>从英文原文里理解词，也把它放回真正的语境里记住。</p></div><button className="sc-pick-orb" onClick={onImport}><i>＋</i><span>导入<br/>新内容</span></button></section>
    {resume ? <button className="sc-resume" onClick={() => onOpen(resume)}><div className={`sc-resume-art ${resume.kind}`}><span>{resume.kind === "article" ? "READ" : "LISTEN"}</span><strong>{resume.title.slice(0, 1)}</strong><i style={{ height: `${Math.max(8, resume.progress * 100)}%` }}/></div><div className="sc-resume-copy"><span>继续{resume.kind === "article" ? "阅读" : "收听"}</span><h2>{resume.title}</h2><p>{resume.description}</p><footer><b>{Math.round(resume.progress * 100)}%</b><i><em style={{ width: `${resume.progress * 100}%` }}/></i><strong>继续 →</strong></footer></div></button> : <EmptyState title="资料库还是空的" copy="导入一篇英文文章或一期播客，从第一个词开始。" action={<button onClick={onImport}>导入内容</button>} />}
    <section className="sc-today-grid"><button className="sc-review-callout" onClick={() => onGo("review")}><header><span>回到语境</span><small>有空时再继续</small></header><div><strong>{due}</strong><span>{due ? "个词现在适合再看一遍" : "现在没有需要回看的词"}</span></div><footer>{due ? "开始这一轮" : "浏览词库"}<b>→</b></footer></button><article className="sc-focus-card"><header><span>今天的记录</span><small>只陈述真实发生的时间</small></header><div className="sc-focus-fact"><strong>{minutes}</strong><small>分钟</small></div><footer><span>阅读 {Math.round((activity?.read_seconds ?? 0) / 60)} 分</span><span>收听 {Math.round((activity?.listen_seconds ?? 0) / 60)} 分</span></footer></article></section>
    <section className="sc-section-head"><div><span className="sc-eyebrow">RECENTLY PICKED</span><h2>最近拾起的词</h2></div><button onClick={() => onGo("words")}>查看全部 →</button></section>
    {snapshot.lexemes.length ? <div className="sc-word-ribbon">{snapshot.lexemes.slice(0, 4).map((word, index) => <button key={word.id} onClick={() => onWord(word.id)}><small>{String(index + 1).padStart(2, "0")}</small><strong>{word.headword}</strong><span>{word.pronunciation || "pronunciation pending"}</span><p>{word.gloss_en || "Explanation pending"}</p></button>)}</div> : <EmptyState title="词会从语境里自然留下" copy="读到想理解的词时点一下；是否保存，由你决定。" />}
  </div>;
}

export function LibraryView({ items, onOpen, onImport, onArchive }: { items: LibraryItem[]; onOpen: (item: LibraryItem) => void; onImport: () => void; onArchive: (item: LibraryItem) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "article" | "podcast" | "archived">("all");
  const visible = items.filter((item) => (filter === "all" ? item.status !== "archived" : filter === "archived" ? item.status === "archived" : item.kind === filter && item.status !== "archived") && `${item.title}${item.source}${item.author}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="sc-page sc-library"><header className="sc-page-title"><div><span className="sc-eyebrow">YOUR LOCAL LIBRARY</span><h1>资料库</h1><p>{items.filter((item) => item.status !== "archived").length} 项英文内容，只属于这台设备。</p></div><button className="sc-primary" onClick={onImport}>＋ 导入内容</button></header><div className="sc-toolbar"><label className="sc-search">⌕<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、作者或来源"/></label><div className="sc-segmented">{([['all','全部'],['article','文章'],['podcast','播客'],['archived','归档']] as const).map(([id,label]) => <button aria-pressed={filter===id} key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>)}</div></div>
    {visible.length ? <div className="sc-library-grid">{visible.map((item,index) => <article className="sc-library-card" key={item.id}><button className="sc-card-main" onClick={() => onOpen(item)}><div className={`sc-cover cover-${index % 4 + 1}`}><span>{item.kind === "article" ? "ARTICLE" : "PODCAST"}</span><strong>{item.title.slice(0,1)}</strong><i>{Math.round(item.progress * 100)}%</i></div><div className="sc-card-copy"><span>{item.source}</span><h2>{item.title}</h2><p>{item.description}</p><footer><small>{item.author || formatShortDate(item.published_at)}</small><b>{item.kind === "article" ? "阅读" : `${Math.max(1, Math.round(item.duration_ms / 60000))} 分钟`} · {Math.round(item.progress * 100)}%</b></footer></div></button><button className="sc-card-menu" onClick={() => onArchive(item)} aria-label={item.status === "archived" ? "恢复到资料库" : "移入归档"}>{item.status === "archived" ? "恢复" : "归档"}</button></article>)}</div> : <EmptyState title="没有找到内容" copy="换一个搜索词，或带回新的英文文章与播客。" action={<button onClick={onImport}>导入内容</button>} />}</div>;
}

export function ReaderView({ item, blocks, occurrences, bookmarks, onSelect, onBack, onProgress, onFinish, onBookmark }: { item: LibraryItem | null; blocks: ContentBlock[]; occurrences: Occurrence[]; bookmarks: VocabSnapshot["bookmarks"]; onSelect: (target: SelectionTarget) => void; onBack: () => void; onProgress: (item: LibraryItem, progress: number) => Promise<unknown>; onFinish: (item: LibraryItem) => void; onBookmark: (item: LibraryItem, block?: ContentBlock) => void }) {
  const prose = useRef<HTMLDivElement>(null);
  const lastActivity = useRef(0);
  const lastSavedProgress = useRef(item?.progress ?? 0);
  const progressTimer = useRef<number | null>(null);
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
        void recordStudySeconds(trackedItemId, "read", 15);
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
    if (restoredItem.current !== item.id) {
      restoredItem.current = item.id;
      const restoredIndex = Math.min(articleBlocks.length - 1, Math.max(0, Math.round(item.progress * (articleBlocks.length - 1))));
      if (item.progress > .02 && item.progress < .98) {
        window.setTimeout(() => document.getElementById(articleBlocks[restoredIndex].id)?.scrollIntoView({ block: "center" }), 0);
      }
    }
    const updatePosition = () => {
      const nodes = Array.from(container.querySelectorAll<HTMLElement>("[data-block-id]"));
      let index = 0;
      nodes.forEach((node, candidate) => { if (node.getBoundingClientRect().top <= Math.max(180, window.innerHeight * .35)) index = candidate; });
      const block = articleBlocks[index];
      if (!block) return;
      setCurrentBlockId(block.id);
      const progress = articleBlocks.length === 1 ? .5 : index / (articleBlocks.length - 1);
      setDisplayProgress(progress);
      if (Math.abs(progress - lastSavedProgress.current) < .02) return;
      lastSavedProgress.current = progress;
      if (progressTimer.current !== null) window.clearTimeout(progressTimer.current);
      progressTimer.current = window.setTimeout(() => { void onProgress(item, progress); }, 650);
    };
    updatePosition();
    window.addEventListener("scroll", updatePosition, { passive: true });
    return () => {
      window.removeEventListener("scroll", updatePosition);
      if (progressTimer.current !== null) window.clearTimeout(progressTimer.current);
      void onProgress(item, lastSavedProgress.current);
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
    })}</div><footer className="sc-reader-end"><span>拾</span><p>You reached the end.</p><button onClick={() => onFinish(item)}>标记为读完</button></footer></article><aside className="sc-reader-meta"><div><span>已拾词</span><strong>{occurrences.filter((entry) => entry.item_id === item.id).length}</strong></div><div><span>书签</span><strong>{bookmarks.filter((entry) => entry.item_id === item.id).length}</strong></div><p>点击一个词、拖选短语，或聚焦段落后用方向键和 Enter。AI 只会收到附近语境。</p></aside></div>;
}

export function PodcastView({ item, segments, occurrences, autoFollow, localLock, onAutoFollow, onSelect, onProgress, onBookmark }: { item: LibraryItem | null; segments: TranscriptSegment[]; occurrences: Occurrence[]; autoFollow: boolean; localLock: boolean; onAutoFollow: (value: boolean) => void; onSelect: (target: SelectionTarget) => void; onProgress: (item: LibraryItem, progress: number) => Promise<unknown>; onBookmark: (item: LibraryItem, ms: number, label: string) => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const activeRow = useRef<HTMLButtonElement>(null);
  const listenStartedAt = useRef<number | null>(null);
  const lastProgressWrite = useRef(0);
  const currentMsRef = useRef(Math.round((item?.progress ?? 0) * (item?.duration_ms ?? 0)));
  const durationRef = useRef(item?.duration_ms ?? 0);
  const [localSrc, setLocalSrc] = useState<string | null>(null);
  const [currentMs, setCurrentMs] = useState(() => Math.round((item?.progress ?? 0) * (item?.duration_ms ?? 0)));
  const [durationMs, setDurationMs] = useState(item?.duration_ms ?? 0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [follow, setFollow] = useState(autoFollow);
  const [mediaError, setMediaError] = useState("");
  const [keyboardWord, setKeyboardWord] = useState<{ segmentId: string; index: number } | null>(null);
  const episodeSegments = useMemo(() => segments.filter((entry) => entry.item_id === item?.id), [item?.id, segments]);
  const alignedTranscript = episodeSegments.some((entry) => entry.end_ms > entry.start_ms);
  const fallbackDuration = item?.duration_ms || (alignedTranscript ? episodeSegments.at(-1)?.end_ms : 0) || 1;
  const duration = durationMs || fallbackDuration;
  const timedIndex = episodeSegments.findIndex((entry) => currentMs >= entry.start_ms && currentMs < entry.end_ms);
  const activeIndex = alignedTranscript ? Math.max(0, timedIndex) : 0;
  const active = episodeSegments[activeIndex] ?? episodeSegments[0];
  const isLocalAudio = item?.audio_url?.startsWith("local:") ?? false;
  const remoteBlocked = Boolean(localLock && item?.audio_url && !isLocalAudio);
  const src = isLocalAudio ? localSrc : !localLock && item?.audio_url ? `/api/media?url=${encodeURIComponent(item.audio_url)}` : null;

  const commitListen = useCallback(() => {
    if (listenStartedAt.current === null || !item) return;
    const seconds = Math.max(0, Math.round((performance.now() - listenStartedAt.current) / 1000));
    listenStartedAt.current = null;
    if (seconds > 0) void recordStudySeconds(item.id, "listen", seconds);
  }, [item]);

  const startListen = useCallback(() => {
    if (document.visibilityState === "visible" && listenStartedAt.current === null) listenStartedAt.current = performance.now();
  }, []);

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
      if (document.visibilityState === "hidden") commitListen();
      else if (!audio.current?.paused) startListen();
      if (document.visibilityState === "hidden" && item) void onProgress(item, currentMsRef.current / Math.max(1, durationRef.current || fallbackDuration));
    };
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); commitListen(); };
  }, [commitListen, fallbackDuration, item, onProgress, startListen]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (isInteractiveTarget(event.target)) return;
      if (event.key === " " && src) { event.preventDefault(); if (audio.current?.paused) void audio.current.play(); else audio.current?.pause(); }
      if (event.key.toLowerCase() === "j") seek(episodeSegments[Math.max(0,activeIndex-1)]?.start_ms ?? 0);
      if (event.key.toLowerCase() === "k") seek(episodeSegments[Math.min(episodeSegments.length-1,activeIndex+1)]?.start_ms ?? currentMs);
    };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, [activeIndex, currentMs, episodeSegments, src]);
  if (!item) return <EmptyState title="还没有播客" copy="从 RSS、音频或英文字幕开始一段听读。"/>;
  function seek(ms: number) { currentMsRef.current = ms; setCurrentMs(ms); if (audio.current) audio.current.currentTime = ms/1000; }
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
    setCurrentMs(next);
    if (next - lastProgressWrite.current >= 10_000) {
      lastProgressWrite.current = next;
      void onProgress(item, next / Math.max(1, duration));
    }
  };
  return <div className="sc-podcast-page">{src && <audio ref={audio} src={src} preload="metadata" onLoadedMetadata={(event) => { const nextDuration=Number.isFinite(event.currentTarget.duration)?event.currentTarget.duration*1000:fallbackDuration;durationRef.current=nextDuration;setDurationMs(nextDuration);const restored=Math.min(nextDuration,Math.max(0,item.progress*nextDuration));currentMsRef.current=restored;event.currentTarget.currentTime=restored/1000;setCurrentMs(restored); }} onTimeUpdate={updateTime} onPlay={() => { setPlaying(true); startListen(); }} onPause={() => { setPlaying(false); commitListen(); void onProgress(item,currentMsRef.current/Math.max(1,durationRef.current||fallbackDuration)); }} onEnded={() => { setPlaying(false); commitListen(); void onProgress(item,1); }} onError={() => setMediaError("音频无法播放，来源可能已失效或格式不受支持。")}/>}<header className="sc-podcast-head"><div><span className="sc-eyebrow">LISTEN IN CONTEXT</span><h1>{item.title}</h1><p>{item.description}</p><div><b>{item.source}</b><span>{item.author}</span><span>{Math.max(1,Math.round(duration/60000))} 分钟</span></div></div><div className="sc-podcast-art"><i/><i/><i/><strong>声</strong></div></header><section className="sc-player" aria-label="音频播放器"><button className="sc-play" aria-label={playing?"暂停":"播放"} disabled={!src} onClick={() => { if (audio.current?.paused) void audio.current.play(); else audio.current?.pause(); }}>{playing ? "Ⅱ" : "▶"}</button><span>{formatDuration(currentMs)}</span><input type="range" aria-label="播放进度" aria-valuetext={`${formatDuration(currentMs)} / ${formatDuration(duration)}`} min={0} max={Math.max(1,duration)} value={Math.min(currentMs,duration)} onChange={(event) => seek(Number(event.target.value))}/><span>{formatDuration(duration)}</span><button className="sc-speed" aria-label={`播放速度 ${speed} 倍，点击切换`} onClick={() => { const next = speed >= 2 ? .75 : speed + .25; setSpeed(next); if (audio.current) audio.current.playbackRate = next; }}>{speed}×</button><button aria-label="收藏当前播放位置" onClick={() => onBookmark(item,currentMs,active?.text.slice(0,24) ?? item.title)}>◇</button></section>{mediaError && <div className="sc-inline-error" role="alert">{mediaError}</div>}{remoteBlocked ? <div className="sc-notice">本地锁阻止了远程音频请求。你仍可阅读字幕；关闭本地锁后才会连接音频来源。</div> : !src && <div className="sc-notice">当前单集没有可播放音频。英文字幕仍可阅读和选词。</div>}{!alignedTranscript && episodeSegments.length > 0 && <div className="sc-notice">这份纯文本字幕没有时间轴，因此不会伪装成同步字幕；你仍可逐段阅读和选词。</div>}<section className="sc-transcript-shell"><aside><span>本期字幕</span><strong>{episodeSegments.length}</strong><p>{alignedTranscript?"段":"段 · 未对齐"}</p><button className={follow ? "active" : ""} disabled={!alignedTranscript} onClick={() => { const next=!follow;setFollow(next);onAutoFollow(next); }}>◎ {follow ? "正在跟随" : "继续跟随"}</button></aside><div className="sc-transcript" onWheel={() => setFollow(false)}>{episodeSegments.length ? episodeSegments.map((segment,index) => { const words=wordRanges(segment.text);const activeRange=keyboardWord?.segmentId===segment.id?words[keyboardWord.index]:null;return <button ref={alignedTranscript&&index === activeIndex ? activeRow : undefined} key={segment.id} className={alignedTranscript&&index === activeIndex ? "active" : ""} aria-current={alignedTranscript&&index===activeIndex?"true":undefined} title="左右方向键选择单词，Enter 或 E 查看解释；Space 跳到此处" onFocus={()=>{if(words.length&&keyboardWord?.segmentId!==segment.id)setKeyboardWord({segmentId:segment.id,index:0});}} onKeyDown={(event)=>transcriptKey(segment,index,event)} onClick={() => { if (alignedTranscript) seek(segment.start_ms); }} onMouseUp={(event) => pick(segment,index,event)}><time>{alignedTranscript?formatDuration(segment.start_ms):"—"}</time><p><AnnotatedText text={segment.text} ranges={occurrences.filter((entry) => entry.segment_id === segment.id)} activeRange={activeRange}/></p>{segment.speaker && <small>{segment.speaker}</small>}</button>;}) : <EmptyState title="没有字幕" copy="导入 VTT、SRT、LRC 或纯文本后，字幕会显示在这里。"/>}</div></section></div>;
}

export function WordsView({ lexemes, occurrences, onOpen, onStar }: { lexemes: Lexeme[]; occurrences: Occurrence[]; onOpen: (id: string) => void; onStar: (word: Lexeme) => void }) {
  const [query,setQuery]=useState(""); const [filter,setFilter]=useState<"all"|Lexeme["status"]|"starred">("all");
  const visible=lexemes.filter((word)=>(filter==="all"?true:filter==="starred"?Boolean(word.starred):word.status===filter)&&`${word.headword}${word.pronunciation}${word.gloss_en}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="sc-page sc-words-page"><header className="sc-page-title"><div><span className="sc-eyebrow">WORDS IN CONTEXT</span><h1>词库</h1><p>{lexemes.length} 个英文词，来自 {new Set(occurrences.map((item)=>item.item_id).filter(Boolean)).size} 份语境。</p></div></header><div className="sc-toolbar"><label className="sc-search">⌕<input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="搜索单词、发音或英文释义"/></label><div className="sc-segmented">{([['all','全部'],['learning','学习中'],['known','已掌握'],['starred','收藏']] as const).map(([id,label])=><button aria-pressed={filter===id} key={id} className={filter===id?"active":""} onClick={()=>setFilter(id)}>{label}</button>)}</div></div>{visible.length?<div className="sc-word-table"><div className="sc-word-table-head"><span>单词</span><span>英文释义</span><span>出现</span><span>状态</span><span/></div>{visible.map((word)=><article key={word.id}><button className="sc-star" onClick={()=>onStar(word)} aria-label={word.starred?"取消收藏":"收藏单词"}>{word.starred?"◆":"◇"}</button><button className="sc-word-open" onClick={()=>onOpen(word.id)}><span className="sc-word-name"><strong>{word.headword}</strong><span>{word.pronunciation||"Pronunciation pending"}</span></span><span className="sc-word-gloss">{word.gloss_en||"No explanation yet"}</span><b>{word.occurrence_count}</b><i className={`status-${word.status}`}>{word.status==="learning"?"学习中":word.status==="known"?"已掌握":word.status==="ignored"?"已忽略":"已保存"}</i><span className="sc-row-arrow">→</span></button></article>)}</div>:<EmptyState title="没有符合条件的词" copy="试试别的搜索，或回到英文原文里拾起一个词。"/>}</div>;
}

export function ReviewView({ cards, onRate, onUndo }: { cards: ReviewCard[]; onRate: (card:ReviewCard,rating:ReviewRating)=>Promise<string>; onUndo:(id:string)=>Promise<void> }) {
  const [reviewClock,setReviewClock]=useState(()=>Date.now()); const due=getDueCards(cards,reviewClock); const [revealed,setRevealed]=useState(false); const [busy,setBusy]=useState(false); const [reviewed,setReviewed]=useState(0); const [lastEvent,setLastEvent]=useState<string|null>(null); const card=due[0]??null;
  const submit=useCallback(async(rating:ReviewRating)=>{if(!card||busy)return;setBusy(true);try{setLastEvent(await onRate(card,rating));setReviewed((n)=>n+1);setRevealed(false);setReviewClock(Date.now());}finally{setBusy(false);}},[busy,card,onRate]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(isInteractiveTarget(event.target))return;if(event.key===" "&&card&&!revealed){event.preventDefault();setRevealed(true);}if(revealed&&["1","2","3","4"].includes(event.key)){const ratings:ReviewRating[]=["again","hard","good","easy"];void submit(ratings[Number(event.key)-1]);}};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[card,revealed,submit]);
  if(!card)return <div className="sc-page sc-review-complete"><span>✓</span><h1>这一轮到这里</h1><p>{reviewed?`刚刚回看了 ${reviewed} 个英文词。`:"现在没有适合回看的词，也可以去读一点新的内容。"}</p>{lastEvent&&<button onClick={async()=>{await onUndo(lastEvent);setLastEvent(null);setReviewed((n)=>Math.max(0,n-1));}}>↶ 撤销上次评分</button>}</div>;
  const nextLabel=(rating:ReviewRating)=>{const delay=scheduleReviewV2(card,rating,reviewClock).due_at-reviewClock;if(delay<3_600_000)return`${Math.max(1,Math.round(delay/60_000))} 分钟`;if(delay<172_800_000)return`${Math.max(1,Math.round(delay/3_600_000))} 小时`;return`${Math.max(1,Math.round(delay/86_400_000))} 天`;};
  const total=reviewed+due.length; return <div className="sc-page sc-review-page"><header><div><span className="sc-eyebrow">BACK TO CONTEXT</span><h1>回到语境</h1></div><div><strong>{reviewed}</strong><span>/ {total}</span></div></header><div className="sc-review-progress"><i style={{width:`${reviewed/Math.max(1,total)*100}%`}}/></div><section className={`sc-review-card ${revealed?"revealed":""}`}><span className="sc-card-label">{revealed?"解释":"还记得这个语境吗？"}</span><h2>{card.headword}</h2><p className="sc-pronunciation">{revealed?card.pronunciation:""}</p><div className="sc-cloze">“{card.cloze_sentence||`Recall “${card.headword}” in context.`}”</div>{!revealed?<button className="sc-reveal" onClick={()=>setRevealed(true)}>查看解释 <kbd>Space</kbd></button>:<div className="sc-answer"><strong>{card.gloss_en||"No definition yet"}</strong><p>{card.context_sentence}</p></div>}</section>{revealed&&<div className="sc-ratings">{([['again','再看一次','1'],['hard','有点难','2'],['good','记得','3'],['easy','很熟','4']] as const).map(([id,label,key])=><button key={id} className={id} disabled={busy} onClick={()=>void submit(id)}><span>{label}</span><small>{nextLabel(id)}</small><kbd>{key}</kbd></button>)}</div>}<footer className="sc-review-footer"><span>{Math.max(0,due.length-1)} 个词可以继续回看</span>{lastEvent&&<button onClick={async()=>{await onUndo(lastEvent);setLastEvent(null);setReviewed((n)=>Math.max(0,n-1));setReviewClock(Date.now());}}>↶ 撤销上一次</button>}</footer></div>;
}

export function StatsView({ snapshot }: { snapshot: VocabSnapshot }) {
  const [now] = useState(() => Date.now());
  const days=Array.from({length:7},(_,index)=>{const date=new Date(now-(6-index)*86400000);const key=localDayKey(date);const row=snapshot.activity.find((item)=>item.day===key);return{key,label:"日一二三四五六"[date.getDay()],minutes:Math.round(((row?.read_seconds??0)+(row?.listen_seconds??0))/60),reviews:row?.review_count??0};});
  const recentKeys=new Set(days.map((day)=>day.key)); const recent=snapshot.activity.filter((row)=>recentKeys.has(row.day)); const maximum=Math.max(1,...days.map((day)=>day.minutes)); const read=Math.round(recent.reduce((sum,row)=>sum+row.read_seconds,0)/60); const listen=Math.round(recent.reduce((sum,row)=>sum+row.listen_seconds,0)/60); const reviews=recent.reduce((sum,row)=>sum+row.review_count,0);
  return <div className="sc-page sc-stats-page"><header className="sc-page-title"><div><span className="sc-eyebrow">A QUIET LOOK BACK</span><h1>最近的记录</h1><p>只呈现最近 7 天真实发生的阅读、收听与回看，不评价完成度。</p></div><div className="sc-date-chip">最近 7 天</div></header><section className="sc-stat-strip"><Metric value={read+listen} suffix="分钟" label="阅读与收听"/><Metric value={snapshot.lexemes.length} label="保存的词"/><Metric value={reviews} label="回到语境"/></section><section className="sc-stats-grid"><article className="sc-chart-card"><header><div><span>有记录的时间</span><strong>{read+listen}<small> 分钟</small></strong></div></header><div className="sc-bar-chart">{days.map((day)=><div key={day.key} aria-label={`${day.key}，${day.minutes} 分钟，回看 ${day.reviews} 次`}><span><i style={{height:`${Math.max(2,day.minutes/maximum*100)}%`}}/></span><small>周{day.label}</small></div>)}</div></article><article className="sc-balance-card"><span>阅读与收听</span><div className="sc-balance-ring" style={{"--read":`${read/Math.max(1,read+listen)*100}%`} as CSSProperties}><strong>{read+listen?Math.round(read/(read+listen)*100):0}%</strong><small>阅读</small></div><footer><span><i/>阅读 <b>{read} 分</b></span><span><i/>收听 <b>{listen} 分</b></span></footer></article></section><section className="sc-memory"><header><div><span>词语状态</span><p>帮助你决定想回到哪里，不是成绩。</p></div></header><div>{([['saved','已保存'],['learning','学习中'],['known','已掌握']] as const).map(([status,label])=>{const count=snapshot.lexemes.filter((word)=>word.status===status).length;return <span key={status}><b>{label}</b><i><em style={{width:`${count/Math.max(1,snapshot.lexemes.length)*100}%`}}/></i><strong>{count}</strong></span>;})}</div></section></div>;
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
  storage: LocalStorageEstimate | null;
  persistenceSupported: boolean;
  onChange: (patch: Partial<VocabSettings>) => Promise<void>;
  onExport: () => Promise<string>;
  onImport: (file: File) => Promise<string>;
  onPersist: () => Promise<boolean | null>;
  onTestAi: () => Promise<void>;
};

export function SettingsView({ settings, storage, persistenceSupported, onChange, onExport, onImport, onPersist, onTestAi }: SettingsViewProps) {
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  const restore=useRef<HTMLInputElement>(null);
  const run=async(action:()=>Promise<string|void>,success:string)=>{setBusy(true);setMessage("");try{const result=await action();setMessage(result||success);}catch(error){setMessage(error instanceof Error?error.message:"操作失败");}finally{setBusy(false);}};
  return <div className="sc-page sc-settings-page">
    <header className="sc-page-title"><div><span className="sc-eyebrow">PREFERENCES & PRIVACY</span><h1>设置</h1><p>调整阅读体验，并掌握哪些内容可以离开设备。</p></div></header>
    <div className="sc-settings-layout"><nav><a href="#reading">阅读体验</a><a href="#ai">AI 与隐私</a><a href="#review-settings">复习节奏</a><a href="#data">数据与备份</a></nav><div className="sc-settings-content">
      <section id="reading"><header><h2>阅读体验</h2><p>即时预览英文正文与字幕排版。</p></header>
        <div className="sc-setting-row"><label htmlFor="sc-font-scale">正文字号<small>文章与字幕</small></label><input id="sc-font-scale" type="range" min=".88" max="1.25" step=".01" value={settings.font_scale} onChange={(event)=>void onChange({font_scale:Number(event.target.value)})}/><b>{Math.round(settings.font_scale*100)}%</b></div>
        <div className="sc-setting-row"><label htmlFor="sc-line-height">行间距<small>让长文更从容</small></label><input id="sc-line-height" type="range" min="1.6" max="2.2" step=".02" value={settings.line_height} onChange={(event)=>void onChange({line_height:Number(event.target.value)})}/><b>{settings.line_height.toFixed(2)}</b></div>
        <Toggle label="字幕自动跟随" copy="播放时让当前句保持在视野中央" value={settings.auto_follow} onChange={(value)=>void onChange({auto_follow:value})}/>
      </section>
      <section id="ai"><header><h2>AI 与隐私</h2><p>选词后会先显示准确字段说明；只有再点“解释这个词”才会发送。</p></header><Toggle label="默认显示简体中文说明" copy="英文释义始终优先" value={settings.chinese_explanation} onChange={(value)=>void onChange({chinese_explanation:value})}/><Toggle label="本地锁" copy="阻止 URL、RSS、AI、转写与远程音频请求" value={settings.local_lock} onChange={(value)=>void onChange({local_lock:value})}/><div className="sc-endpoint"><span><i className={settings.local_lock?"locked":""}/><b>DeepSeek · OpenAI compatible</b><small>{settings.local_lock?"本地锁已开启":"由服务端安全配置"}</small></span><button disabled={busy||settings.local_lock} onClick={()=>void run(onTestAi,"检测到服务端 AI 配置；这次检查没有发送文章或词语内容。")}>检查配置</button></div></section>
      <section id="review-settings"><header><h2>复习节奏</h2><p>新词依照上限加入每日队列。</p></header><div className="sc-setting-row"><label htmlFor="sc-daily-limit">每日新词<small>到期复习不受影响</small></label><input id="sc-daily-limit" type="range" min="1" max="30" value={settings.daily_new_limit} onChange={(event)=>void onChange({daily_new_limit:Number(event.target.value)})}/><b>{settings.daily_new_limit}</b></div></section>
      <section id="data"><header><h2>数据与备份</h2><p>完整备份包含 SQLite 数据与实际保存在拾词里的本地音频。</p></header><div className={`sc-storage-fact ${storage?.persisted===true?"persisted":""}`}><span><i /><b>{storage?.persisted===true?"浏览器已授予持久化保护":!persistenceSupported?"当前浏览器未提供持久化保护接口":storage===null?"正在读取存储状态":storage.persisted===false?"仍可能被浏览器清理":"保护状态暂时未知"}</b><small>{storage?`当前占用 ${formatStorageBytes(storage.usage)} · 可用约 ${formatStorageBytes(storage.available)}`:"正在读取当前浏览器的容量信息"}</small></span>{persistenceSupported&&storage?.persisted!==true&&<button disabled={busy} onClick={()=>void run(async()=>{const result=await onPersist();return result===true?"已获得浏览器持久化保护。":result===false?"浏览器暂未授予持久化保护，请保持定期备份。":"保护请求已完成，但浏览器暂时无法复查状态。";},"")}>请求保护</button>}</div><div className="sc-data-actions"><button disabled={busy} onClick={()=>void run(onExport,"")}><i>↓</i><span><b>导出完整备份</b><small>内容、词语、复习与本地音频</small></span></button><button disabled={busy} onClick={()=>restore.current?.click()}><i>↑</i><span><b>恢复备份</b><small>先校验候选数据，再安全切换</small></span></button><input ref={restore} aria-label="选择拾词完整备份或旧版 SQLite" hidden type="file" accept=".vocab-backup,.sqlite,.sqlite3,.db" onChange={(event)=>{const file=event.target.files?.[0];if(file)void run(()=>onImport(file),"");event.currentTarget.value="";}}/></div><p className="sc-data-note">备份是未加密的私人文件，不含 AI 密钥。请把它保存在受信任的位置；旧版 SQLite 不包含本地音频。</p></section>
      {message&&<div className="sc-settings-message" role="status">{message}</div>}
    </div></div>
  </div>;
}
