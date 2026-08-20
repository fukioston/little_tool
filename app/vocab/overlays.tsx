"use client";

import { useState, type ChangeEvent, type DragEvent } from "react";
import { deleteLocalFile, saveLocalFile } from "@/lib/local-db/files";
import { errorMessage, postJson } from "@/lib/vocab/api";
import { normalizeArticleApi, normalizePodcastApi, parseArticleText, parseTranscript, readFileText } from "@/lib/vocab/content";
import { saveArticle, savePodcast } from "@/lib/vocab/store";
import type { AiExplanation, Lexeme, Occurrence, ParsedPodcast, SelectionTarget } from "@/lib/vocab/types";
import { Logo } from "./ui";

export function ContextPanel({ target, explanation, loading, error, showChinese, onChinese, onExplain, onSave, onClose }: { target: SelectionTarget; explanation: AiExplanation | null; loading: boolean; error: string; showChinese: boolean; onChinese: (value: boolean) => void | Promise<void>; onExplain: () => void; onSave: (note?: string) => void | Promise<void>; onClose: () => void }) {
  const [note, setNote] = useState("");
  const gloss = explanation?.sense?.glosses_en?.join(" · ") || explanation?.sense?.meaning_in_context_en;
  const pronunciation = explanation?.target?.ipa || explanation?.target?.pronunciation;
  return <aside className="sc-context-panel" aria-label="语境解释"><header><span>语境解释</span><button onClick={onClose} aria-label="关闭">×</button></header><div className="sc-context-word"><div><h2>{explanation?.target?.canonical || target.surface}</h2><span>{pronunciation || "Selected in context"}</span></div><button className="sc-save-word" onClick={() => void onSave(note)}>＋ 收入词库</button></div>
    {!explanation && !loading && <div className="sc-context-preview"><span>IN THIS CONTEXT</span><p>“{target.sentence}”</p><button onClick={onExplain}>用 AI 解释这个语境 <b>→</b></button><small>只发送所选内容与附近句子</small></div>}
    {loading && <div className="sc-ai-loading"><i/><span>正在斟酌语境…</span><small>不会发送整篇内容</small></div>}
    {error && <div className="sc-context-error"><p>{error}</p><button onClick={onExplain}>重试</button></div>}
    {explanation && <div className="sc-explanation"><span className="sc-pos">{[...(explanation.sense?.parts_of_speech ?? []), explanation.cefr ?? ""].filter(Boolean).join(" · ") || explanation.target?.kind || "IN CONTEXT"}</span><h3>{gloss || "No English gloss returned"}</h3><p>{explanation.sense?.explanation_en || explanation.sense?.meaning_in_context_en}</p>{explanation.example?.sentence_en && <blockquote>{explanation.example.sentence_en}</blockquote>}<button className="sc-zh-toggle" onClick={() => void onChinese(!showChinese)}>{showChinese ? "隐藏简体中文" : "显示简体中文"}<span>{showChinese ? "−" : "+"}</span></button>{showChinese && <div className="sc-zh-copy"><p>{explanation.sense?.explanation_zh || (loading ? "正在生成中文说明…" : "尚未返回中文说明。")}</p>{explanation.context_translation_zh && <small>{explanation.context_translation_zh}</small>}</div>}{explanation.collocations && explanation.collocations.length > 0 && <div className="sc-collocations">{explanation.collocations.map((entry) => <span key={entry}>{entry}</span>)}</div>}</div>}
    <label className="sc-quick-note"><span>随手记</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="为什么想记住它？"/></label><footer><span>Esc 关闭</span><span>E 解释</span><span>S 保存</span></footer></aside>;
}

export function WordDetail({ word, occurrences, onClose, onNote, onStatus }: { word: Lexeme | null; occurrences: Occurrence[]; onClose: () => void; onNote: (id: string, note: string) => Promise<void>; onStatus: (id: string, status: Lexeme["status"]) => Promise<void> }) {
  const [note, setNote] = useState(word?.notes ?? "");
  if (!word) return null;
  return <><button className="sc-drawer-scrim" onClick={onClose} aria-label="关闭词语详情"/><aside className="sc-word-drawer"><header><span>单词详情</span><button onClick={onClose}>×</button></header><div className="sc-word-hero"><span>{word.pronunciation || "PRONUNCIATION PENDING"}</span><h2>{word.headword}</h2><p>{word.gloss_en || "No explanation yet"}</p></div><section><span>ENGLISH IN CONTEXT</span><p>{word.explanation_en || "在文章或字幕中再次请求 AI，即可补充英文语境解释。"}</p>{word.explanation_zh && <p className="sc-muted">{word.explanation_zh}</p>}</section><section><header><span>出现过 {occurrences.length} 次</span></header><div className="sc-occurrence-list">{occurrences.map((occurrence) => <article key={occurrence.id}><small>{occurrence.item_title || "来源已移除"}</small><p>{occurrence.context_sentence}</p>{occurrence.note && <em>{occurrence.note}</em>}</article>)}</div></section><section><label className="sc-note-editor"><span>我的笔记</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="写下辨析、联想或记忆线索…"/><button onClick={() => void onNote(word.id, note)}>保存笔记</button></label></section><footer><span>学习状态</span><div>{([['saved','已保存'],['learning','学习中'],['known','已掌握']] as const).map(([status,label]) => <button className={word.status === status ? "active" : ""} key={status} onClick={() => void onStatus(word.id,status)}>{label}</button>)}</div></footer></aside></>;
}

export function ImportWizard({ localLock, onClose, onImported }: { localLock: boolean; onClose: () => void; onImported: (id: string) => void | Promise<void> }) {
  const [kind,setKind]=useState<"article"|"rss"|"audio">("article");
  const [articleMode,setArticleMode]=useState<"url"|"paste"|"file">("url");
  const [url,setUrl]=useState(""); const [title,setTitle]=useState(""); const [paste,setPaste]=useState("");
  const [articleFile,setArticleFile]=useState<File|null>(null); const [audioFile,setAudioFile]=useState<File|null>(null); const [transcriptFile,setTranscriptFile]=useState<File|null>(null); const [transcribe,setTranscribe]=useState(false);
  const [episodes,setEpisodes]=useState<ParsedPodcast[]>([]); const [busy,setBusy]=useState(false); const [error,setError]=useState(""); const [stage,setStage]=useState(0);

  const submit=async()=>{setBusy(true);setError("");let localAudioKey:string|undefined;try{
    if(kind==="article"){
      let article;
      if(articleMode==="url"){
        if(localLock)throw new Error("本地锁已开启。可以改用粘贴或文件导入。");
        if(!/^https?:\/\//i.test(url))throw new Error("请输入完整的 http 或 https 地址");
        setStage(1);article=normalizeArticleApi(await postJson("/api/import/article",{url}));article.sourceUrl ||= url;
      }else if(articleMode==="paste"){
        if(!paste.trim())throw new Error("请先粘贴英文文章内容"); article=parseArticleText(paste,title||"Pasted article");
      }else{
        if(!articleFile)throw new Error("请选择 txt、md 或 html 文件"); article=parseArticleText(await readFileText(articleFile),title||articleFile.name.replace(/\.[^.]+$/, ""));
      }
      if(title.trim())article.title=title.trim();setStage(2);await onImported(await saveArticle(article,articleMode));
    }else if(kind==="rss"){
      if(localLock)throw new Error("本地锁已开启，无法访问 RSS。");
      if(!/^https?:\/\//i.test(url))throw new Error("请输入完整的 RSS 地址");
      setStage(1);const found=normalizePodcastApi(await postJson("/api/import/rss",{url}));if(!found.length)throw new Error("订阅中没有找到可导入的单集");setEpisodes(found);
    }else{
      if(!audioFile&&!transcriptFile)throw new Error("请添加音频或字幕文件");
      let segments: ParsedPodcast["segments"] = transcriptFile?parseTranscript(await readFileText(transcriptFile),transcriptFile.name):[];let durationMs=segments.at(-1)?.end_ms??0;
      if(transcribe&&audioFile){if(localLock)throw new Error("本地锁已开启，无法发送音频转写。");setStage(1);const form=new FormData();form.append("file",audioFile);form.append("language","en");const response=await fetch("/api/transcribe",{method:"POST",body:form});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(String((payload as Record<string,unknown>).error??"转写失败"));const data=((payload as Record<string,unknown>).data??payload) as Record<string,unknown>;if(Array.isArray(data.segments))segments=data.segments.flatMap((entry,index)=>{if(!entry||typeof entry!=="object")return[];const row=entry as Record<string,unknown>;return[{start_ms:Number(row.start_ms??Number(row.start??index*5)*1000),end_ms:Number(row.end_ms??Number(row.end??(index+1)*5)*1000),text:String(row.text??""),speaker:typeof row.speaker==="string"?row.speaker:null}];});durationMs=Number(data.duration_ms??segments.at(-1)?.end_ms??0);}
      if(audioFile){setStage(2);const saved=await saveLocalFile("vocab",audioFile,{originalName:audioFile.name,mimeType:audioFile.type||"audio/mpeg",category:"podcast-audio"});localAudioKey=saved.key;}
      const podcast={title:title.trim()||audioFile?.name.replace(/\.[^.]+$/,"")||transcriptFile?.name.replace(/\.[^.]+$/,"")||"Local podcast",description:transcriptFile?`Transcript: ${transcriptFile.name}`:"Locally imported English audio",source:"本地导入",audioUrl:localAudioKey?`local:${localAudioKey}`:undefined,durationMs,segments};
      await onImported(await savePodcast(podcast,"file"));localAudioKey=undefined;
    }
  }catch(caught){if(localAudioKey)await deleteLocalFile("vocab",localAudioKey).catch(()=>false);setError(errorMessage(caught));setStage(0);}finally{setBusy(false);}};

  const importEpisode=async(episode:ParsedPodcast)=>{setBusy(true);setError("");try{let ready=episode;if(!episode.segments.length&&episode.transcriptUrl){try{const transcript=normalizeArticleApi(await postJson("/api/import/article",{url:episode.transcriptUrl}));ready={...episode,segments:parseTranscript(transcript.blocks.map((block)=>block.text).join("\n\n"),episode.transcriptUrl)};}catch{/* The episode remains importable when its publisher blocks transcript fetching. */}}await onImported(await savePodcast(ready,"rss"));}catch(caught){setError(errorMessage(caught));}finally{setBusy(false);}};
  return <><button className="sc-modal-scrim" onClick={onClose} aria-label="关闭导入"/><section className="sc-import-modal" role="dialog" aria-modal="true" aria-label="导入内容"><header><Logo/><div><span>添加到资料库</span><h2>从哪里开始？</h2></div><button onClick={onClose}>×</button></header><div className="sc-import-types">{([['article','英文文章'],['rss','RSS 播客'],['audio','音频 / 字幕']] as const).map(([id,label])=><button key={id} className={kind===id?"active":""} onClick={()=>{setKind(id);setError("");setEpisodes([]);}}>{label}</button>)}</div><div className="sc-import-body">
    {kind==="article"&&<><div className="sc-import-subtabs">{([['url','网页地址'],['paste','粘贴文本'],['file','本地文件']] as const).map(([id,label])=><button key={id} className={articleMode===id?"active":""} onClick={()=>setArticleMode(id)}>{label}</button>)}</div>{articleMode==="url"&&<label className="sc-field"><span>文章地址</span><input value={url} onChange={(event)=>setUrl(event.target.value)} placeholder="https://…"/><small>网页会经安全提取，只保留可读正文。</small></label>}{articleMode==="paste"&&<label className="sc-field"><span>英文文章内容</span><textarea value={paste} onChange={(event)=>setPaste(event.target.value)} placeholder="Paste an English article here…"/></label>}{articleMode==="file"&&<FileDrop file={articleFile} accept=".txt,.md,.html,text/plain,text/markdown,text/html" label="TXT、Markdown 或 HTML" onFile={setArticleFile}/>}<label className="sc-field compact"><span>标题（可选）</span><input value={title} onChange={(event)=>setTitle(event.target.value)} placeholder="自动识别，也可以手动覆盖"/></label></>}
    {kind==="rss"&&!episodes.length&&<><label className="sc-field"><span>RSS 地址</span><input value={url} onChange={(event)=>setUrl(event.target.value)} placeholder="https://example.com/feed.xml"/><small>先读取节目目录，再由你选择要保存的单集。</small></label><div className="sc-privacy-hint"><i>隐</i><p>只有 RSS 地址会发送到导入服务；单集不会自动下载。</p></div></>}
    {kind==="rss"&&episodes.length>0&&<div className="sc-episode-picker"><header><span>选择一集</span><small>{episodes.length} 个结果</small></header>{episodes.slice(0,20).map((episode,index)=><button key={`${episode.title}-${index}`} disabled={busy} onClick={()=>void importEpisode(episode)}><i>{String(index+1).padStart(2,"0")}</i><span><b>{episode.title}</b><small>{episode.source} · {episode.durationMs?`${Math.round(episode.durationMs/60000)} 分钟`:"时长未知"}</small></span><strong>导入 →</strong></button>)}</div>}
    {kind==="audio"&&<><FileDrop file={audioFile} accept="audio/*,.mp3,.m4a,.wav,.ogg" label="音频文件" onFile={setAudioFile}/><FileDrop file={transcriptFile} accept=".vtt,.srt,.lrc,.txt,text/vtt,text/plain" label="VTT、SRT、LRC 或纯文本字幕" onFile={setTranscriptFile}/><label className="sc-field compact"><span>节目标题</span><input value={title} onChange={(event)=>setTitle(event.target.value)} placeholder="Untitled podcast"/></label><label className="sc-check"><input aria-label="没有字幕时请求外部转写" type="checkbox" checked={transcribe} onChange={(event)=>setTranscribe(event.target.checked)}/><span><b>没有字幕时，请求外部转写</b><small>音频将发送到配置的端点；本地副本保存在 OPFS，不会塞进 SQLite。</small></span></label></>}
    {error&&<div className="sc-import-error">{error}</div>}{busy&&<div className="sc-import-progress"><i><em style={{width:stage===1?"58%":stage===2?"90%":"22%"}}/></i><span>{stage===1?(kind==="audio"?"正在转写英文音频…":"正在读取远程内容…"):stage===2?"正在写入本地资料库…":"正在准备…"}</span></div>}</div>{!episodes.length&&<footer><button onClick={onClose}>取消</button><button className="sc-primary" disabled={busy} onClick={()=>void submit()}>{busy?"处理中…":kind==="rss"?"读取节目":"导入到拾词"}</button></footer>}</section></>;
}

function FileDrop({file,accept,label,onFile}:{file:File|null;accept:string;label:string;onFile:(file:File|null)=>void}){
  const drop=(event:DragEvent<HTMLLabelElement>)=>{event.preventDefault();onFile(event.dataTransfer.files[0]??null);};
  return <label className={`sc-file-drop ${file?"has-file":""}`} onDragOver={(event)=>event.preventDefault()} onDrop={drop}><input aria-label={`选择${label}`} type="file" accept={accept} hidden onChange={(event:ChangeEvent<HTMLInputElement>)=>onFile(event.target.files?.[0]??null)}/><i>{file?"✓":"↑"}</i><span><b>{file?.name||`选择${label}`}</b><small>{file?`${(file.size/1024).toFixed(1)} KB`:"点击或拖放，文件会留在本地"}</small></span></label>;
}
