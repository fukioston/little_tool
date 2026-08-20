"use client";
/* eslint-disable jsx-a11y/media-has-caption -- Every audio item has a synchronized, keyboard-accessible transcript beside the player. */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { createLocalFileObjectUrl } from "@/lib/local-db/files";
import { formatDuration, formatShortDate, sentenceContext, wordAt } from "@/lib/vocab/content";
import { getDueCards, recordStudySeconds } from "@/lib/vocab/store";
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

export function TodayView({ snapshot, due, onOpen, onGo, onImport, onWord }: { snapshot: VocabSnapshot; due: number; onOpen: (item: LibraryItem) => void; onGo: (view: VocabView) => void; onImport: () => void; onWord: (id: string) => void }) {
  const hour = new Date().getHours();
  const greeting = hour < 11 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  const resume = snapshot.items.find((item) => item.status === "in_progress") ?? snapshot.items[0];
  const today = new Date().toISOString().slice(0, 10);
  const activity = snapshot.activity.find((entry) => entry.day === today);
  const minutes = Math.round(((activity?.read_seconds ?? 0) + (activity?.listen_seconds ?? 0)) / 60);
  return <div className="sc-page sc-today">
    <section className="sc-hero"><div><span className="sc-eyebrow">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</span><h1>{greeting}。<br/><em>今天想拾起什么？</em></h1><p>从英文原文里理解词，也把它放回真正的语境里记住。</p></div><button className="sc-pick-orb" onClick={onImport}><i>＋</i><span>导入<br/>新内容</span></button></section>
    {resume ? <button className="sc-resume" onClick={() => onOpen(resume)}><div className={`sc-resume-art ${resume.kind}`}><span>{resume.kind === "article" ? "READ" : "LISTEN"}</span><strong>{resume.title.slice(0, 1)}</strong><i style={{ height: `${Math.max(8, resume.progress * 100)}%` }}/></div><div className="sc-resume-copy"><span>继续{resume.kind === "article" ? "阅读" : "收听"}</span><h2>{resume.title}</h2><p>{resume.description}</p><footer><b>{Math.round(resume.progress * 100)}%</b><i><em style={{ width: `${resume.progress * 100}%` }}/></i><strong>继续 →</strong></footer></div></button> : <EmptyState title="资料库还是空的" copy="导入一篇英文文章或一期播客，从第一个词开始。" action={<button onClick={onImport}>导入内容</button>} />}
    <section className="sc-today-grid"><button className="sc-review-callout" onClick={() => onGo("review")}><header><span>今日复习</span><small>按记忆节奏安排</small></header><div><strong>{due}</strong><span>张卡片待复习</span></div><footer>{due ? "开始复习" : "今日已完成"}<b>→</b></footer></button><article className="sc-focus-card"><header><span>今日专注</span><small>仅在本地统计</small></header><div className="sc-focus-ring" style={{ "--ring": `${Math.min(100, minutes / 18 * 100)}%` } as CSSProperties}><strong>{minutes}</strong><small>分钟</small></div><footer><span>阅读 {Math.round((activity?.read_seconds ?? 0) / 60)} 分</span><span>收听 {Math.round((activity?.listen_seconds ?? 0) / 60)} 分</span></footer></article></section>
    <section className="sc-section-head"><div><span className="sc-eyebrow">RECENTLY PICKED</span><h2>最近拾起的词</h2></div><button onClick={() => onGo("words")}>查看全部 →</button></section>
    <div className="sc-word-ribbon">{snapshot.lexemes.slice(0, 6).map((word, index) => <button key={word.id} onClick={() => onWord(word.id)}><small>{String(index + 1).padStart(2, "0")}</small><strong>{word.headword}</strong><span>{word.pronunciation || "pronunciation pending"}</span><p>{word.gloss_en || "Explanation pending"}</p></button>)}</div>
  </div>;
}

export function LibraryView({ items, onOpen, onImport, onArchive }: { items: LibraryItem[]; onOpen: (item: LibraryItem) => void; onImport: () => void; onArchive: (item: LibraryItem) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "article" | "podcast" | "archived">("all");
  const visible = items.filter((item) => (filter === "all" ? item.status !== "archived" : filter === "archived" ? item.status === "archived" : item.kind === filter && item.status !== "archived") && `${item.title}${item.source}${item.author}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="sc-page sc-library"><header className="sc-page-title"><div><span className="sc-eyebrow">YOUR LOCAL LIBRARY</span><h1>资料库</h1><p>{items.filter((item) => item.status !== "archived").length} 项英文内容，只属于这台设备。</p></div><button className="sc-primary" onClick={onImport}>＋ 导入内容</button></header><div className="sc-toolbar"><label className="sc-search">⌕<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、作者或来源"/></label><div className="sc-segmented">{([['all','全部'],['article','文章'],['podcast','播客'],['archived','归档']] as const).map(([id,label]) => <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>)}</div></div>
    {visible.length ? <div className="sc-library-grid">{visible.map((item,index) => <article className="sc-library-card" key={item.id}><button className="sc-card-main" onClick={() => onOpen(item)}><div className={`sc-cover cover-${index % 4 + 1}`}><span>{item.kind === "article" ? "ARTICLE" : "PODCAST"}</span><strong>{item.title.slice(0,1)}</strong><i>{Math.round(item.progress * 100)}%</i></div><div className="sc-card-copy"><span>{item.source}</span><h2>{item.title}</h2><p>{item.description}</p><footer><small>{item.author || formatShortDate(item.published_at)}</small><b>{item.kind === "article" ? "阅读" : `${Math.max(1, Math.round(item.duration_ms / 60000))} 分钟`} · {Math.round(item.progress * 100)}%</b></footer></div></button><button className="sc-card-menu" onClick={() => onArchive(item)} aria-label="归档">{item.status === "archived" ? "↶" : "···"}</button></article>)}</div> : <EmptyState title="没有找到内容" copy="换一个搜索词，或带回新的英文文章与播客。" action={<button onClick={onImport}>导入内容</button>} />}</div>;
}

export function ReaderView({ item, blocks, occurrences, bookmarks, onSelect, onFinish, onBookmark }: { item: LibraryItem | null; blocks: ContentBlock[]; occurrences: Occurrence[]; bookmarks: VocabSnapshot["bookmarks"]; onSelect: (target: SelectionTarget) => void; onFinish: (item: LibraryItem) => void; onBookmark: (item: LibraryItem, block?: ContentBlock) => void }) {
  const session = useRef(0);
  const prose = useRef<HTMLDivElement>(null);
  const trackedItemId = item?.id ?? null;
  const articleBlocks = blocks.filter((block) => block.item_id === item?.id);
  useEffect(() => { session.current = Date.now(); return () => { if (trackedItemId) void recordStudySeconds(trackedItemId, "read", Math.min(1800, Math.round((Date.now() - session.current) / 1000))); }; }, [trackedItemId]);
  useEffect(() => {
    const container = prose.current;
    if (!container || !trackedItemId) return;
    const handlePick = (event: MouseEvent) => {
      const element = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-block-id]");
      if (!element || !container.contains(element)) return;
      const block = blocks.find((entry) => entry.id === element.dataset.blockId && entry.item_id === trackedItemId);
      if (!block) return;
      const value = pickedText(element, event.clientX, event.clientY);
      if (!value || value.text.length > 80) return;
      const context = sentenceContext(block.text, value.start, value.end);
      onSelect({ surface: value.text, sentence: context.sentence, before: context.before, after: context.after, itemId: trackedItemId, blockId: block.id, startUtf16: value.start, endUtf16: value.end });
    };
    container.addEventListener("mouseup", handlePick);
    return () => container.removeEventListener("mouseup", handlePick);
  }, [blocks, onSelect, trackedItemId]);
  if (!item) return <EmptyState title="还没有文章" copy="先从资料库导入一篇英文文章。"/>;
  return <div className="sc-reader-layout"><aside className="sc-reader-rail"><button onClick={() => history.back()}>← 返回</button><span>阅读进度</span><strong>{Math.round(item.progress * 100)}%</strong><i><em style={{ height: `${item.progress * 100}%` }}/></i><nav>{articleBlocks.filter((block) => block.kind === "heading").map((block,index) => <a href={`#${block.id}`} key={block.id}><b>{String(index + 1).padStart(2,"0")}</b>{block.text}</a>)}</nav></aside><article className="sc-reader"><header><div><span>{item.source || "LOCAL ARTICLE"}</span><i>·</i><span>{Math.max(1, Math.ceil(articleBlocks.reduce((sum,block) => sum + block.text.length,0)/900))} MIN READ</span></div><button onClick={() => onBookmark(item, articleBlocks[0])}>◇ 书签</button></header><h1>{item.title}</h1><p className="sc-deck">{item.description}</p><div className="sc-byline"><span>{(item.author || "拾").slice(0,1)}</span><div><strong>{item.author || "Local import"}</strong><small>{item.published_at || "刚刚导入"}</small></div><i/></div><div ref={prose} className="sc-prose">{articleBlocks.map((block) => {
      const body = <AnnotatedText text={block.text} ranges={occurrences.filter((entry) => entry.block_id === block.id)}/>;
      if (block.kind === "heading") return <h2 id={block.id} data-block-id={block.id} key={block.id}>{body}</h2>;
      if (block.kind === "quote") return <blockquote id={block.id} data-block-id={block.id} key={block.id}>{body}</blockquote>;
      return <p id={block.id} data-block-id={block.id} key={block.id}>{body}</p>;
    })}</div><footer className="sc-reader-end"><span>拾</span><p>You reached the end.</p><button onClick={() => onFinish(item)}>标记为读完</button></footer></article><aside className="sc-reader-meta"><div><span>已拾词</span><strong>{occurrences.filter((entry) => entry.item_id === item.id).length}</strong></div><div><span>书签</span><strong>{bookmarks.filter((entry) => entry.item_id === item.id).length}</strong></div><p>点击一个英文词，或拖选一段短语。AI 只会收到附近语境。</p></aside></div>;
}

export function PodcastView({ item, segments, occurrences, autoFollow, onAutoFollow, onSelect, onProgress, onBookmark }: { item: LibraryItem | null; segments: TranscriptSegment[]; occurrences: Occurrence[]; autoFollow: boolean; onAutoFollow: (value: boolean) => void; onSelect: (target: SelectionTarget) => void; onProgress: (item: LibraryItem, progress: number) => Promise<unknown>; onBookmark: (item: LibraryItem, ms: number, label: string) => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const activeRow = useRef<HTMLButtonElement>(null);
  const [localSrc, setLocalSrc] = useState<string | null>(null);
  const [currentMs, setCurrentMs] = useState(() => Math.round((item?.progress ?? 0) * (item?.duration_ms ?? 0)));
  const [playing, setPlaying] = useState(false);
  const [follow, setFollow] = useState(autoFollow);
  const [mediaError, setMediaError] = useState("");
  const episodeSegments = useMemo(() => segments.filter((entry) => entry.item_id === item?.id), [item?.id, segments]);
  const fallbackDuration = item?.duration_ms || episodeSegments.at(-1)?.end_ms || 1;
  const activeIndex = Math.max(0, episodeSegments.findIndex((entry) => currentMs >= entry.start_ms && currentMs < entry.end_ms));
  const active = episodeSegments[activeIndex] ?? episodeSegments[0];
  const isLocalAudio = item?.audio_url?.startsWith("local:") ?? false;
  const src = isLocalAudio ? localSrc : item?.audio_url ? `/api/media?url=${encodeURIComponent(item.audio_url)}` : null;

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
  useEffect(() => { if (follow && playing) activeRow.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }, [activeIndex, follow, playing]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (event.key === " " && src) { event.preventDefault(); if (audio.current?.paused) void audio.current.play(); else audio.current?.pause(); }
      if (event.key.toLowerCase() === "j") seek(episodeSegments[Math.max(0,activeIndex-1)]?.start_ms ?? 0);
      if (event.key.toLowerCase() === "k") seek(episodeSegments[Math.min(episodeSegments.length-1,activeIndex+1)]?.start_ms ?? currentMs);
    };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  });
  if (!item) return <EmptyState title="还没有播客" copy="从 RSS、音频或英文字幕开始一段听读。"/>;
  const duration = Number.isFinite(audio.current?.duration) ? (audio.current?.duration ?? 0) * 1000 : fallbackDuration;
  function seek(ms: number) { setCurrentMs(ms); if (audio.current) audio.current.currentTime = ms/1000; }
  const pick = (segment: TranscriptSegment, event: ReactMouseEvent<HTMLElement>) => { const value = pickedText(event.currentTarget,event.clientX,event.clientY); if (!value || value.text.length > 80) return; const context = sentenceContext(segment.text,value.start,value.end); onSelect({ surface:value.text,sentence:context.sentence,before:context.before,after:context.after,itemId:item.id,segmentId:segment.id,startUtf16:value.start,endUtf16:value.end,startMs:segment.start_ms }); };
  return <div className="sc-podcast-page">{src && <audio ref={audio} src={src} preload="metadata" onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime*1000)} onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); void onProgress(item,currentMs/Math.max(1,duration)); }} onEnded={() => { setPlaying(false); void onProgress(item,1); }} onError={() => setMediaError("音频无法播放，来源可能已失效或格式不受支持。")}/>}<header className="sc-podcast-head"><div><span className="sc-eyebrow">NOW LISTENING</span><h1>{item.title}</h1><p>{item.description}</p><div><b>{item.source}</b><span>{item.author}</span><span>{Math.max(1,Math.round(duration/60000))} 分钟</span></div></div><div className="sc-podcast-art"><i/><i/><i/><strong>声</strong></div></header><section className="sc-player"><button className="sc-play" disabled={!src} onClick={() => { if (audio.current?.paused) void audio.current.play(); else audio.current?.pause(); }}>{playing ? "Ⅱ" : "▶"}</button><span>{formatDuration(currentMs)}</span><input type="range" aria-label="播放进度" min={0} max={Math.max(1,duration)} value={Math.min(currentMs,duration)} onChange={(event) => seek(Number(event.target.value))}/><span>{formatDuration(duration)}</span><button className="sc-speed" onClick={() => { if (audio.current) audio.current.playbackRate = audio.current.playbackRate >= 2 ? .75 : audio.current.playbackRate + .25; }}>{audio.current?.playbackRate ?? 1}×</button><button onClick={() => onBookmark(item,currentMs,active?.text.slice(0,24) ?? item.title)}>◇</button></section>{mediaError && <div className="sc-inline-error">{mediaError}</div>}{!src && <div className="sc-notice">当前单集没有可播放音频。英文字幕仍可阅读、选词和定位。</div>}<section className="sc-transcript-shell"><aside><span>本期字幕</span><strong>{episodeSegments.length}</strong><p>段</p><button className={follow ? "active" : ""} onClick={() => { const next=!follow;setFollow(next);onAutoFollow(next); }}>◎ {follow ? "正在跟随" : "继续跟随"}</button></aside><div className="sc-transcript" onWheel={() => setFollow(false)}>{episodeSegments.length ? episodeSegments.map((segment,index) => <button ref={index === activeIndex ? activeRow : undefined} key={segment.id} className={index === activeIndex ? "active" : ""} onClick={() => seek(segment.start_ms)} onMouseUp={(event) => pick(segment,event)}><time>{formatDuration(segment.start_ms)}</time><p><AnnotatedText text={segment.text} ranges={occurrences.filter((entry) => entry.segment_id === segment.id)}/></p>{segment.speaker && <small>{segment.speaker}</small>}</button>) : <EmptyState title="没有字幕" copy="导入 VTT、SRT、LRC 或纯文本后，字幕会在这里随音频前进。"/>}</div></section></div>;
}

export function WordsView({ lexemes, occurrences, onOpen, onStar }: { lexemes: Lexeme[]; occurrences: Occurrence[]; onOpen: (id: string) => void; onStar: (word: Lexeme) => void }) {
  const [query,setQuery]=useState(""); const [filter,setFilter]=useState<"all"|Lexeme["status"]|"starred">("all");
  const visible=lexemes.filter((word)=>(filter==="all"?true:filter==="starred"?Boolean(word.starred):word.status===filter)&&`${word.headword}${word.pronunciation}${word.gloss_en}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="sc-page sc-words-page"><header className="sc-page-title"><div><span className="sc-eyebrow">WORDS IN CONTEXT</span><h1>词库</h1><p>{lexemes.length} 个英文词，来自 {new Set(occurrences.map((item)=>item.item_id).filter(Boolean)).size} 份语境。</p></div><div className="sc-word-count"><strong>{lexemes.filter((word)=>word.status==="learning").length}</strong><span>正在学习</span></div></header><div className="sc-toolbar"><label className="sc-search">⌕<input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="搜索单词、发音或英文释义"/></label><div className="sc-segmented">{([['all','全部'],['learning','学习中'],['known','已掌握'],['starred','收藏']] as const).map(([id,label])=><button key={id} className={filter===id?"active":""} onClick={()=>setFilter(id)}>{label}</button>)}</div></div>{visible.length?<div className="sc-word-table"><div className="sc-word-table-head"><span>单词</span><span>英文释义</span><span>出现</span><span>状态</span><span/></div>{visible.map((word)=><article key={word.id}><button className="sc-star" onClick={()=>onStar(word)} aria-label={word.starred?"取消收藏":"收藏单词"}>{word.starred?"◆":"◇"}</button><button className="sc-word-open" onClick={()=>onOpen(word.id)}><span className="sc-word-name"><strong>{word.headword}</strong><span>{word.pronunciation||"Pronunciation pending"}</span></span><span className="sc-word-gloss">{word.gloss_en||"No explanation yet"}</span><b>{word.occurrence_count}</b><i className={`status-${word.status}`}>{word.status==="learning"?"学习中":word.status==="known"?"已掌握":word.status==="ignored"?"已忽略":"已保存"}</i><span className="sc-row-arrow">→</span></button></article>)}</div>:<EmptyState title="没有符合条件的词" copy="试试别的搜索，或回到英文原文里拾起一个词。"/>}</div>;
}

export function ReviewView({ cards, onRate, onUndo }: { cards: ReviewCard[]; onRate: (card:ReviewCard,rating:ReviewRating)=>Promise<string>; onUndo:(id:string)=>Promise<void> }) {
  const due=getDueCards(cards); const [revealed,setRevealed]=useState(false); const [busy,setBusy]=useState(false); const [reviewed,setReviewed]=useState(0); const [lastEvent,setLastEvent]=useState<string|null>(null); const card=due[0]??null;
  const submit=useCallback(async(rating:ReviewRating)=>{if(!card||busy)return;setBusy(true);try{setLastEvent(await onRate(card,rating));setReviewed((n)=>n+1);setRevealed(false);}finally{setBusy(false);}},[busy,card,onRate]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if((event.target as HTMLElement|null)?.tagName==="INPUT")return;if(event.key===" "&&card&&!revealed){event.preventDefault();setRevealed(true);}if(revealed&&["1","2","3","4"].includes(event.key)){const ratings:ReviewRating[]=["again","hard","good","easy"];void submit(ratings[Number(event.key)-1]);}};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[card,revealed,submit]);
  if(!card)return <div className="sc-page sc-review-complete"><span>✓</span><h1>{reviewed?"这一轮复习完成了":"今天已经复习完了"}</h1><p>{reviewed?`刚刚稳固了 ${reviewed} 个英文词。`:"下一张卡片会在合适的时候出现。"}</p>{lastEvent&&<button onClick={async()=>{await onUndo(lastEvent);setLastEvent(null);setReviewed((n)=>Math.max(0,n-1));}}>↶ 撤销上次评分</button>}</div>;
  const total=reviewed+due.length; return <div className="sc-page sc-review-page"><header><div><span className="sc-eyebrow">SPACED REPETITION</span><h1>今日复习</h1></div><div><strong>{reviewed}</strong><span>/ {total}</span></div></header><div className="sc-review-progress"><i style={{width:`${reviewed/Math.max(1,total)*100}%`}}/></div><section className={`sc-review-card ${revealed?"revealed":""}`}><span className="sc-card-label">{revealed?"答案":"这是什么意思？"}</span><h2>{card.headword}</h2><p className="sc-pronunciation">{revealed?card.pronunciation:""}</p><div className="sc-cloze">“{card.context_sentence?card.context_sentence.replace(new RegExp(card.headword,"i"),"____"):`Recall “${card.headword}” in context.`}”</div>{!revealed?<button className="sc-reveal" onClick={()=>setRevealed(true)}>显示答案 <kbd>Space</kbd></button>:<div className="sc-answer"><strong>{card.gloss_en||"No definition yet"}</strong><p>{card.context_sentence}</p></div>}</section>{revealed&&<div className="sc-ratings">{([['again','再来','10 分钟','1'],['hard','困难','1 天','2'],['good','记得',`${Math.max(1,Math.round(card.interval_days*card.ease||1))} 天`,'3'],['easy','轻松',`${Math.max(4,Math.round(card.interval_days*(card.ease+.35)||4))} 天`,'4']] as const).map(([id,label,next,key])=><button key={id} className={id} disabled={busy} onClick={()=>void submit(id)}><span>{label}</span><small>{next}</small><kbd>{key}</kbd></button>)}</div>}<footer className="sc-review-footer"><span>{Math.max(0,due.length-1)} 张待复习</span>{lastEvent&&<button onClick={async()=>{await onUndo(lastEvent);setLastEvent(null);setReviewed((n)=>Math.max(0,n-1));}}>↶ 撤销上一次</button>}</footer></div>;
}

export function StatsView({ snapshot }: { snapshot: VocabSnapshot }) {
  const [now] = useState(() => Date.now());
  const days=Array.from({length:7},(_,index)=>{const date=new Date(now-(6-index)*86400000);const key=date.toISOString().slice(0,10);const row=snapshot.activity.find((item)=>item.day===key);return{key,label:"日一二三四五六"[date.getDay()],minutes:Math.round(((row?.read_seconds??0)+(row?.listen_seconds??0))/60)};});
  const maximum=Math.max(1,...days.map((day)=>day.minutes)); const read=Math.round(snapshot.activity.reduce((sum,row)=>sum+row.read_seconds,0)/60); const listen=Math.round(snapshot.activity.reduce((sum,row)=>sum+row.listen_seconds,0)/60); const reviews=snapshot.activity.reduce((sum,row)=>sum+row.review_count,0); const active=new Set(snapshot.activity.filter((row)=>row.read_seconds+row.listen_seconds>120||row.review_count>0).map((row)=>row.day)); let streak=0; for(let i=0;i<365;i+=1){const key=new Date(now-i*86400000).toISOString().slice(0,10);if(active.has(key))streak+=1;else if(i>0)break;}
  return <div className="sc-page sc-stats-page"><header className="sc-page-title"><div><span className="sc-eyebrow">YOUR LEARNING RHYTHM</span><h1>数据</h1><p>由本地学习记录生成，不会离开设备。</p></div><div className="sc-date-chip">最近 7 天</div></header><section className="sc-stat-strip"><Metric value={read+listen} suffix="分钟" label="专注时间"/><Metric value={snapshot.lexemes.length} label="已拾单词"/><Metric value={reviews} label="完成复习"/><Metric value={streak} suffix="天" label="连续学习"/></section><section className="sc-stats-grid"><article className="sc-chart-card"><header><div><span>学习时长</span><strong>{read+listen}<small> 分钟</small></strong></div></header><div className="sc-bar-chart">{days.map((day)=><div key={day.key}><span><i style={{height:`${Math.max(2,day.minutes/maximum*100)}%`}}/></span><small>周{day.label}</small></div>)}</div></article><article className="sc-balance-card"><span>阅读与收听</span><div className="sc-balance-ring" style={{"--read":`${read/Math.max(1,read+listen)*100}%`} as CSSProperties}><strong>{Math.round(read/Math.max(1,read+listen)*100)}%</strong><small>阅读</small></div><footer><span><i/>阅读 <b>{read} 分</b></span><span><i/>收听 <b>{listen} 分</b></span></footer></article></section><section className="sc-memory"><header><div><span>记忆状态</span><p>按当前学习阶段分布</p></div><strong>{snapshot.reviewCards.filter((card)=>card.due_at<=now).length}<small> 今日待复习</small></strong></header><div>{([['saved','已保存'],['learning','学习中'],['known','已掌握']] as const).map(([status,label])=>{const count=snapshot.lexemes.filter((word)=>word.status===status).length;return <span key={status}><b>{label}</b><i><em style={{width:`${count/Math.max(1,snapshot.lexemes.length)*100}%`}}/></i><strong>{count}</strong></span>;})}</div></section></div>;
}

export function SettingsView({ settings, onChange, onExport, onImport, onTestAi }: { settings:VocabSettings; onChange:(patch:Partial<VocabSettings>)=>Promise<void>; onExport:()=>Promise<void>; onImport:(file:File)=>Promise<void>; onTestAi:()=>Promise<void> }) {
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  const restore=useRef<HTMLInputElement>(null);
  const run=async(action:()=>Promise<void>,success:string)=>{setBusy(true);setMessage("");try{await action();setMessage(success);}catch(error){setMessage(error instanceof Error?error.message:"操作失败");}finally{setBusy(false);}};
  return <div className="sc-page sc-settings-page">
    <header className="sc-page-title"><div><span className="sc-eyebrow">PREFERENCES & PRIVACY</span><h1>设置</h1><p>调整阅读体验，并掌握哪些内容可以离开设备。</p></div></header>
    <div className="sc-settings-layout"><nav><a href="#reading">阅读体验</a><a href="#ai">AI 与隐私</a><a href="#review-settings">复习节奏</a><a href="#data">数据与备份</a></nav><div className="sc-settings-content">
      <section id="reading"><header><h2>阅读体验</h2><p>即时预览英文正文与字幕排版。</p></header>
        <div className="sc-setting-row"><label htmlFor="sc-font-scale">正文字号<small>文章与字幕</small></label><input id="sc-font-scale" type="range" min=".88" max="1.25" step=".01" value={settings.font_scale} onChange={(event)=>void onChange({font_scale:Number(event.target.value)})}/><b>{Math.round(settings.font_scale*100)}%</b></div>
        <div className="sc-setting-row"><label htmlFor="sc-line-height">行间距<small>让长文更从容</small></label><input id="sc-line-height" type="range" min="1.6" max="2.2" step=".02" value={settings.line_height} onChange={(event)=>void onChange({line_height:Number(event.target.value)})}/><b>{settings.line_height.toFixed(2)}</b></div>
        <Toggle label="字幕自动跟随" copy="播放时让当前句保持在视野中央" value={settings.auto_follow} onChange={(value)=>void onChange({auto_follow:value})}/>
      </section>
      <section id="ai"><header><h2>AI 与隐私</h2><p>AI 只在你主动请求时收到英文目标和附近语境。</p></header><Toggle label="默认显示简体中文说明" copy="英文释义始终优先" value={settings.chinese_explanation} onChange={(value)=>void onChange({chinese_explanation:value})}/><Toggle label="本地锁" copy="阻止 URL、RSS、AI、转写与远程音频请求" value={settings.local_lock} onChange={(value)=>void onChange({local_lock:value})}/><div className="sc-endpoint"><span><i className={settings.local_lock?"locked":""}/><b>DeepSeek · OpenAI compatible</b><small>{settings.local_lock?"本地锁已开启":"由服务端安全配置"}</small></span><button disabled={busy||settings.local_lock} onClick={()=>void run(onTestAi,"AI 服务已配置")}>检查配置</button></div></section>
      <section id="review-settings"><header><h2>复习节奏</h2><p>新词依照上限加入每日队列。</p></header><div className="sc-setting-row"><label htmlFor="sc-daily-limit">每日新词<small>到期复习不受影响</small></label><input id="sc-daily-limit" type="range" min="1" max="30" value={settings.daily_new_limit} onChange={(event)=>void onChange({daily_new_limit:Number(event.target.value)})}/><b>{settings.daily_new_limit}</b></div></section>
      <section id="data"><header><h2>数据与备份</h2><p>导出完整 SQLite，或从此前备份恢复。</p></header><div className="sc-data-actions"><button disabled={busy} onClick={()=>void run(onExport,"完整备份已下载")}><i>↓</i><span><b>导出完整备份</b><small>文章、字幕、单词、笔记与复习</small></span></button><button disabled={busy} onClick={()=>restore.current?.click()}><i>↑</i><span><b>恢复备份</b><small>校验并替换当前拾词数据库</small></span></button><input ref={restore} aria-label="选择拾词数据库备份" hidden type="file" accept=".sqlite,.sqlite3,.db" onChange={(event)=>{const file=event.target.files?.[0];if(file&&window.confirm("恢复会替换当前拾词数据。确定继续吗？"))void run(()=>onImport(file),"备份恢复完成");event.currentTarget.value="";}}/></div><p className="sc-data-note">备份不会包含 AI 密钥。请把文件保存在受信任的位置。</p></section>
      {message&&<div className="sc-settings-message">{message}</div>}
    </div></div>
  </div>;
}
