"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { errorMessage, postJson } from "@/lib/vocab/api";
import { VOCAB_AI_DISCLOSURE_BY_ACTION } from "@/lib/vocab/ai-payload";
import { subscribeVocabOutboundBlock } from "@/lib/vocab/lock";
import {
  normalizeArticleApi,
  normalizePodcastApi,
  normalizeTranscriptionSegments,
  parseArticleText,
  parseTranscript,
  podcastEpisodeHasImportableMedia,
  readFileText,
  vocabLocalImportFileProblem,
} from "@/lib/vocab/content";
import {
  inspectVocabImportWrite,
  isVocabImportWriteReceipt,
  prepareVocabArticleWrite,
  prepareVocabPodcastWrite,
  saveArticle,
  savePodcast,
  VocabWriteNotSavedError,
  type VocabImportWriteReceipt,
} from "@/lib/vocab/store";
import type { AiExplanation, Lexeme, Occurrence, ParsedPodcast, SelectionTarget } from "@/lib/vocab/types";
import {
  cleanupVocabPodcastAudioWrite,
  inspectVocabPodcastAudioWrite,
  isVocabPodcastAudioWriteReceipt,
  prepareVocabPodcastAudioWrite,
  saveVocabPodcastWithAudio,
  VocabPodcastAudioConflictError,
  VocabPodcastAudioNotSavedError,
  VocabPodcastAudioUncertainError,
  type VocabPodcastAudioWriteReceipt,
} from "@/lib/vocab/write-receipts";
import { Logo } from "./ui";
import { useOverlayDialog } from "./useOverlayDialog";

export function ContextPanel({ target, explanation, loading, error, showChinese, saveBusy, saveLabel, saveMessage, confirmReminderRemoval = false, onChinese, onExplain, onSave, onCancelReminderRemoval, onConfirmReminderRemoval, onClose }: { target: SelectionTarget; explanation: AiExplanation | null; loading: boolean; error: string; showChinese: boolean; saveBusy: boolean; saveLabel: string; saveMessage: string; confirmReminderRemoval?: boolean; onChinese: (value: boolean) => void | Promise<void>; onExplain: () => void; onSave: (note?: string) => void | Promise<void>; onCancelReminderRemoval?: () => void; onConfirmReminderRemoval?: () => void | Promise<void>; onClose: () => void }) {
  const [note, setNote] = useState("");
  const dialog = useOverlayDialog<HTMLElement>(true, onClose, "button[data-dialog-close]");
  const gloss = explanation?.sense?.glosses_en?.join(" · ") || explanation?.sense?.meaning_in_context_en;
  const pronunciation = explanation?.target?.ipa || explanation?.target?.pronunciation;
  return <aside ref={dialog} className="sc-context-panel" role="dialog" aria-modal="true" aria-labelledby="sc-context-title" tabIndex={-1}><header><span id="sc-context-title">语境解释</span><button data-dialog-close disabled={saveBusy} onClick={onClose} aria-label="关闭语境解释">×</button></header><div className="sc-context-word"><div><h2>{explanation?.target?.canonical || target.surface}</h2><span>{pronunciation || "Selected in context"}</span></div><button data-word-recovery-primary className="sc-save-word" disabled={saveBusy} aria-busy={saveBusy} onClick={() => void onSave(note)}>{saveBusy ? "正在确认…" : saveLabel}</button></div>
    {!explanation && !loading && !error && <div className="sc-context-preview"><span>IN THIS CONTEXT</span><p>“{target.sentence}”</p><small>{VOCAB_AI_DISCLOSURE_BY_ACTION.explain}</small><button style={{minHeight:44}} onClick={onExplain}>解释这个词</button></div>}
    {loading && <div className="sc-ai-loading" role="status" aria-live="polite"><i/><span>正在理解这个语境…</span><small>{VOCAB_AI_DISCLOSURE_BY_ACTION.explain}</small></div>}
    {error && <div className="sc-context-error" role="alert"><p>{error}</p><small>{VOCAB_AI_DISCLOSURE_BY_ACTION.explain}</small><button style={{minHeight:44}} onClick={onExplain}>重试解释</button></div>}
    {explanation && <div className="sc-explanation"><span className="sc-pos">{[...(explanation.sense?.parts_of_speech ?? []), explanation.cefr ?? ""].filter(Boolean).join(" · ") || explanation.target?.kind || "IN CONTEXT"}</span><h3>{gloss || "No English gloss returned"}</h3><p>{explanation.sense?.explanation_en || explanation.sense?.meaning_in_context_en}</p>{explanation.example?.sentence_en && <blockquote>{explanation.example.sentence_en}</blockquote>}<button className="sc-zh-toggle" disabled={saveBusy} onClick={() => void onChinese(!showChinese)}>{showChinese ? "隐藏简体中文" : "显示简体中文"}<span>{showChinese ? "−" : "+"}</span></button><small>{VOCAB_AI_DISCLOSURE_BY_ACTION.explain_chinese}</small>{showChinese && <div className="sc-zh-copy"><p>{explanation.sense?.explanation_zh || (loading ? "正在生成中文说明…" : "尚未返回中文说明。")}</p>{explanation.context_translation_zh && <small>{explanation.context_translation_zh}</small>}</div>}{explanation.collocations && explanation.collocations.length > 0 && <div className="sc-collocations">{explanation.collocations.map((entry) => <span key={entry}>{entry}</span>)}</div>}</div>}
    {saveMessage && <div className="sc-context-error" role="status"><p>{saveMessage}</p>{confirmReminderRemoval && <div className="sc-reminder-confirm"><button data-word-reminder-keep onClick={onCancelReminderRemoval}>继续保留提醒</button><button className="danger" onClick={() => void onConfirmReminderRemoval?.()}>只移除提醒</button></div>}</div>}
    <label className="sc-quick-note"><span>随手记</span><textarea value={note} disabled={saveBusy || saveLabel !== "＋ 收入词库"} onChange={(event) => setNote(event.target.value)} placeholder="为什么想记住它？"/></label><footer><span>Esc 关闭</span><span>E 解释</span><span>S 保存</span></footer></aside>;
}

const IMPORT_RECOVERY_PREFIX = "vocab.pending-import-write.v1:";

type ImportRecovery =
  | Readonly<{ version: 1; type: "database"; receipt: VocabImportWriteReceipt }>
  | Readonly<{ version: 1; type: "podcast-audio"; receipt: VocabPodcastAudioWriteReceipt }>;

function isImportRecovery(value: unknown): value is ImportRecovery {
  if (!value || typeof value !== "object") return false;
  const recovery = value as Partial<ImportRecovery>;
  return recovery.version === 1 && (
    recovery.type === "database"
      ? isVocabImportWriteReceipt(recovery.receipt)
      : recovery.type === "podcast-audio" &&
        isVocabPodcastAudioWriteReceipt(recovery.receipt)
  );
}

function importRecoveryOperationId(recovery: ImportRecovery): string {
  return recovery.type === "database"
    ? recovery.receipt.operationId
    : recovery.receipt.operationId;
}

function importRecoveryKey(recovery: ImportRecovery): string {
  return `${IMPORT_RECOVERY_PREFIX}${importRecoveryOperationId(recovery)}`;
}

function readImportRecovery(): ImportRecovery | null {
  if (typeof window === "undefined") return null;
  const recoveries: ImportRecovery[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(IMPORT_RECOVERY_PREFIX)) continue;
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) continue;
        const parsed: unknown = JSON.parse(raw);
        if (
          isImportRecovery(parsed) &&
          key === importRecoveryKey(parsed)
        ) {
          recoveries.push(parsed);
        }
      } catch {
        // One damaged entry must not hide another operation's valid receipt.
      }
    }
  } catch {
    // Recovery storage may be unavailable in a locked-down browser.
    return null;
  }
  return recoveries.sort((left, right) => {
    const leftTime = left.type === "database"
      ? left.receipt.createdAt
      : left.receipt.database.createdAt;
    const rightTime = right.type === "database"
      ? right.receipt.createdAt
      : right.receipt.database.createdAt;
    return leftTime - rightTime;
  })[0] ?? null;
}

function writeImportRecovery(recovery: ImportRecovery): void {
  window.localStorage.setItem(importRecoveryKey(recovery), JSON.stringify(recovery));
}

function removeImportRecovery(recovery: ImportRecovery): boolean {
  try {
    const key = importRecoveryKey(recovery);
    const raw = window.localStorage.getItem(key);
    if (!raw) return false;
    const current: unknown = JSON.parse(raw);
    if (
      isImportRecovery(current) &&
      JSON.stringify(current) === JSON.stringify(recovery)
    ) {
      window.localStorage.removeItem(key);
      return window.localStorage.getItem(key) !== raw;
    }
  } catch {
    // A confirmed database commit never depends on clearing this UI hint.
  }
  return false;
}

type WordDetailProps = Readonly<{
  word: Lexeme | null;
  occurrences: Occurrence[];
  note: string;
  noteDirty: boolean;
  writeLocked: boolean;
  statusWriteLocked: boolean;
  writeBusy: boolean;
  writeStatus: string;
  onClose: () => void;
  onNoteChange: (note: string) => void;
  onNoteSave: (trigger: HTMLButtonElement) => void | Promise<void>;
  onStatus: (
    word: Lexeme,
    status: Lexeme["status"],
    trigger: HTMLButtonElement,
  ) => void | Promise<void>;
}>;

export function WordDetail({
  word,
  occurrences,
  note,
  noteDirty,
  writeLocked,
  statusWriteLocked,
  writeBusy,
  writeStatus,
  onClose,
  onNoteChange,
  onNoteSave,
  onStatus,
}: WordDetailProps) {
  const dialog = useOverlayDialog<HTMLElement>(Boolean(word), onClose, "[data-dialog-heading]");
  if (!word) return null;
  const statusLocked = statusWriteLocked || writeLocked || writeBusy || noteDirty;
  return <>
    <button
      className="sc-drawer-scrim"
      disabled={writeBusy}
      onClick={onClose}
      aria-label="关闭词语详情"
    />
    <aside ref={dialog} className="sc-word-drawer" role="dialog" aria-modal="true" aria-labelledby="sc-word-title" tabIndex={-1}>
      <header>
        <span>单词详情</span>
        <button data-dialog-close disabled={writeBusy} onClick={onClose} aria-label="关闭词语详情">×</button>
      </header>
      <div className="sc-word-hero">
        <span>{word.pronunciation || "PRONUNCIATION PENDING"}</span>
        <h2 id="sc-word-title" data-dialog-heading tabIndex={-1}>{word.headword}</h2>
        <p>{word.gloss_en || "No explanation yet"}</p>
      </div>
      <section>
        <span>ENGLISH IN CONTEXT</span>
        <p>{word.explanation_en || "在文章或字幕中再次请求 AI，即可补充英文语境解释。"}</p>
        {word.explanation_zh && <p className="sc-muted">{word.explanation_zh}</p>}
      </section>
      <section>
        <header><span>出现过 {occurrences.length} 次</span></header>
        <div className="sc-occurrence-list">
          {occurrences.map((occurrence) => <article key={occurrence.id}>
            <small>{occurrence.item_title || "来源已移除"}</small>
            <p>{occurrence.context_sentence}</p>
            {occurrence.note && <em>{occurrence.note}</em>}
          </article>)}
        </div>
      </section>
      <section>
        <label className="sc-note-editor">
          <span>我的笔记</span>
          <textarea
            value={note}
            onChange={(event) => onNoteChange(event.target.value)}
            placeholder="写下辨析、联想或记忆线索…"
            aria-describedby="sc-lexeme-note-state"
          />
          <button
            disabled={!noteDirty || writeLocked || writeBusy}
            aria-busy={writeBusy}
            onClick={(event) => void onNoteSave(event.currentTarget)}
          >{writeBusy ? "正在确认…" : "保存笔记"}</button>
        </label>
        <p id="sc-lexeme-note-state" className="sc-lexeme-editor-state" role="status" aria-live="polite">
          {writeStatus || (noteDirty ? "草稿只保留在当前页面；保存前不会改动词库。" : "笔记已与当前词条同步。")}
        </p>
      </section>
      <footer>
        <span>学习状态</span>
        <div>{([['saved','已保存'],['learning','学习中'],['known','已掌握'],['ignored','已忽略']] as const).map(([status,label]) => <button
          aria-pressed={word.status === status}
          aria-busy={writeBusy}
          className={word.status === status ? "active" : ""}
          disabled={statusLocked || word.status === status}
          key={status}
          onClick={(event) => void onStatus(word, status, event.currentTarget)}
        >{label}</button>)}</div>
      </footer>
    </aside>
  </>;
}

export function LexemeDraftExitDialog({
  open,
  busy,
  onStay,
  onDiscard,
}: Readonly<{
  open: boolean;
  busy: boolean;
  onStay: () => void;
  onDiscard: () => void;
}>) {
  const dialog = useOverlayDialog<HTMLElement>(open, onStay, "[data-lexeme-stay]");
  if (!open) return null;
  return <>
    <button className="sc-item-exit-scrim" onClick={onStay} aria-label="继续编辑词语笔记" />
    <section
      ref={dialog}
      className="sc-item-exit-dialog sc-lexeme-exit-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="sc-lexeme-exit-title"
      aria-describedby="sc-lexeme-exit-copy"
      tabIndex={-1}
    >
      <h2 id="sc-lexeme-exit-title">放弃还没保存的笔记？</h2>
      <p id="sc-lexeme-exit-copy">继续编辑是安全默认选项。放弃草稿后会重新读取整个词库，不会提交这段文字。</p>
      <footer>
        <button data-lexeme-stay onClick={onStay}>继续编辑</button>
        <button className="danger" disabled={busy} onClick={onDiscard}>放弃草稿并读取最新</button>
      </footer>
    </section>
  </>;
}

type ImportPhase = "idle" | "preparing" | "committing" | "refreshing" | "uncertain" | "conflict" | "recovery_absent" | "refresh_failed";

class VocabLocalLockImportError extends Error {
  constructor(message = "本地锁已开启；远程读取已经停止，没有继续发送内容。") {
    super(message);
    this.name = "VocabLocalLockImportError";
  }
}

class VocabImportCancelledError extends Error {
  constructor(message = "已取消转写；没有写入文章、字幕或音频。") {
    super(message);
    this.name = "VocabImportCancelledError";
  }
}

function assertVocabExternalImportAllowed(
  localLock: boolean,
  signal: AbortSignal,
  message: string,
) {
  throwIfVocabImportAborted(signal);
  if (localLock) throw new VocabLocalLockImportError(message);
}

function throwIfVocabImportAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
}

function isVocabLocalLockImportError(reason: unknown): reason is VocabLocalLockImportError {
  return reason instanceof VocabLocalLockImportError;
}

function isVocabImportCancelledError(reason: unknown): reason is VocabImportCancelledError {
  return reason instanceof VocabImportCancelledError;
}

function vocabImportErrorMessage(reason: unknown): string {
  const code = reason && typeof reason === "object"
    ? String((reason as { code?: unknown }).code ?? "")
    : "";
  if (code === "CROSS_ORIGIN_ISOLATION_REQUIRED") {
    return "当前页面缺少安全打开 SQLite 所需的跨源隔离（COOP/COEP）。请从受支持的正式地址打开后再导入；没有写入任何内容。";
  }
  if (code === "OPFS_UNAVAILABLE") {
    return "当前浏览器或隐私模式不支持保存本地音频所需的 OPFS。请改用最新版 Chrome、Edge 或 Safari 的普通窗口；没有写入任何内容。";
  }
  if (code === "BROWSER_STORAGE_UNAVAILABLE" || code === "BROWSER_REQUIRED") {
    return "当前环境无法使用浏览器本地存储。请在受支持浏览器的普通窗口中重试；没有写入任何内容。";
  }
  return errorMessage(reason);
}

function localAudioStorageProblem(): string | null {
  if (typeof navigator === "undefined" || !navigator.storage) {
    return "当前环境无法使用浏览器本地存储，不能保存这份音频。";
  }
  if (typeof navigator.storage.getDirectory !== "function") {
    return "当前浏览器或隐私模式不支持 OPFS，不能保存这份本地音频。";
  }
  return null;
}

function remoteTranscriptPayload(value: unknown): Readonly<{
  text: string;
  url: string;
  transcriptType: string;
}> {
  const root = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const data = root.data && typeof root.data === "object" && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : root;
  if (typeof data.text !== "string" || !data.text.trim()) {
    throw new Error("远程字幕为空。出版社没有返回可导入的字幕内容。");
  }
  return {
    text: data.text,
    url: typeof data.url === "string" ? data.url : "transcript.txt",
    transcriptType: typeof data.transcriptType === "string"
      ? data.transcriptType
      : typeof data.contentType === "string" ? data.contentType : "",
  };
}

type PendingAudioOnlyImport = Readonly<{
  episode: ParsedPodcast;
  reason: string;
}>;

export function ImportWizard({ localLock, onClose, onImported }: { localLock: boolean; onClose: () => void; onImported: (id: string) => void | Promise<void> }) {
  const [kind, setKind] = useState<"article" | "rss" | "audio">("article");
  const [articleMode, setArticleMode] = useState<"url" | "paste" | "file">("url");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [paste, setPaste] = useState("");
  const [articleFile, setArticleFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [transcriptFile, setTranscriptFile] = useState<File | null>(null);
  const [transcribe, setTranscribe] = useState(false);
  const [episodes, setEpisodes] = useState<ParsedPodcast[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [recovery, setRecovery] = useState<ImportRecovery | null>(null);
  const [phase, setPhase] = useState<ImportPhase>("idle");
  const [error, setError] = useState("");
  const [committedId, setCommittedId] = useState<string | null>(null);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [transcriptionConfigured, setTranscriptionConfigured] = useState<boolean | null>(null);
  const [pendingAudioOnly, setPendingAudioOnly] = useState<PendingAudioOnlyImport | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const healthOperation = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const closed = useRef(false);
  const activeRecovery = useRef<ImportRecovery | null>(null);
  const abandonOpener = useRef<HTMLElement | null>(null);
  const keepReminderButton = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    if (busyRef.current) return;
    if (confirmAbandon) {
      setConfirmAbandon(false);
      setError("恢复提醒会继续保留；没有写入、覆盖或删除任何内容。");
      window.requestAnimationFrame(() => abandonOpener.current?.focus({ preventScroll: true }));
      return;
    }
    closed.current = true;
    operation.current?.abort();
    onClose();
  }, [confirmAbandon, onClose]);
  const dialog = useOverlayDialog<HTMLElement>(true, close, "button[data-dialog-close]");

  useEffect(() => {
    closed.current = false;
    let live = true;
    queueMicrotask(() => {
      if (!live || closed.current) return;
      const pending = readImportRecovery();
      if (!pending) return;
      activeRecovery.current = pending;
      setRecovery(pending);
      setPhase("uncertain");
      setError("上次导入没有留下完整回执。先只读核对，不会重复写入或删除文件。");
    });
    return () => {
      live = false;
      closed.current = true;
      healthOperation.current?.abort();
      operation.current?.abort();
    };
  }, []);

  useEffect(() => subscribeVocabOutboundBlock(() => {
    healthOperation.current?.abort(new VocabLocalLockImportError());
    operation.current?.abort(new VocabLocalLockImportError());
  }), []);

  useEffect(() => {
    healthOperation.current?.abort();
    healthOperation.current = null;
    if (localLock) {
      const active = operation.current;
      if (active && !active.signal.aborted) active.abort(new VocabLocalLockImportError());
      return;
    }
    const controller = new AbortController();
    healthOperation.current = controller;
    assertVocabExternalImportAllowed(localLock, controller.signal, "本地锁已开启；没有检查外部服务状态。");
    void fetch("/api/health", {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await response.json() as { transcription?: { configured?: boolean } };
      if (!closed.current && healthOperation.current === controller) {
        setTranscriptionConfigured(Boolean(response.ok && payload.transcription?.configured));
      }
    }).catch(() => {
      if (!closed.current && !controller.signal.aborted && healthOperation.current === controller) {
        setTranscriptionConfigured(false);
      }
    });
    return () => {
      controller.abort();
      if (healthOperation.current === controller) healthOperation.current = null;
    };
  }, [localLock]);

  useEffect(() => {
    if (!confirmAbandon) return;
    const frame = window.requestAnimationFrame(() => keepReminderButton.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [confirmAbandon]);

  const begin = () => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setCancelRequested(false);
    return true;
  };
  const finish = (controller?: AbortController) => {
    if (controller && operation.current === controller) operation.current = null;
    busyRef.current = false;
    if (!closed.current) {
      setBusy(false);
      setCancelRequested(false);
    }
  };

  const cancelCurrentOperation = () => {
    const active = operation.current;
    if (!active || active.signal.aborted) return;
    setCancelRequested(true);
    active.abort(new VocabImportCancelledError());
  };
  const checkpoint = (next: ImportRecovery) => {
    writeImportRecovery(next);
    activeRecovery.current = next;
    setRecovery(next);
  };
  const activateNextCheckpoint = () => {
    const next = readImportRecovery();
    activeRecovery.current = next;
    setRecovery(next);
    if (!next) return false;
    setPhase("uncertain");
    setError("还有一次导入结果待核对。只读核对完成前，不会发起新的导入写入。");
    return true;
  };
  const clearCheckpoint = () => {
    if (activeRecovery.current) removeImportRecovery(activeRecovery.current);
    activeRecovery.current = null;
    setRecovery(null);
    return activateNextCheckpoint();
  };

  const finishCommitted = async (id: string) => {
    clearCheckpoint();
    setCommittedId(id);
    setPhase("refreshing");
    setStage(3);
    try {
      await onImported(id);
    } catch (caught) {
      if (!closed.current) {
        setPhase("refresh_failed");
        setError(`内容已经保存，只是页面暂未更新：${errorMessage(caught)}`);
      }
    }
  };

  const handleFailure = (caught: unknown, checkpointed: boolean) => {
    if (closed.current) return;
    setStage(0);
    if (
      caught instanceof VocabWriteNotSavedError ||
      caught instanceof VocabPodcastAudioNotSavedError
    ) {
      if (!clearCheckpoint()) {
        setPhase("idle");
        setError(vocabImportErrorMessage(caught));
      }
      return;
    }
    if (checkpointed) {
      setPhase("uncertain");
      setError(`${errorMessage(caught)} 现在只允许核对，不会重复导入。`);
      return;
    }
    if (
      caught instanceof VocabPodcastAudioConflictError ||
      caught instanceof VocabPodcastAudioUncertainError
    ) {
      setPhase("idle");
      setError("音频在写入前没有通过完整核对。数据库和文件都没有改动；可以稍后重新选择后再试。");
      return;
    }
    setPhase("idle");
    setError(vocabImportErrorMessage(caught));
  };

  const submit = async () => {
    if (!begin()) return;
    const controller = new AbortController();
    operation.current = controller;
    setPhase("preparing");
    setStage(0);
    setError("");
    let checkpointed = false;
    try {
      if (kind === "article") {
        let article;
        if (articleMode === "url") {
          assertVocabExternalImportAllowed(localLock, controller.signal, "本地锁已开启。可以改用粘贴或文件导入；没有读取这个网址。");
          if (!/^https?:\/\//i.test(url)) throw new Error("请输入完整的 http 或 https 地址");
          setStage(1);
          article = normalizeArticleApi(
            await postJson("/api/import/article", { url }, controller.signal),
          );
          assertVocabExternalImportAllowed(localLock, controller.signal, "本地锁已开启；网页读取已经停止，没有继续处理远程内容。");
          article.sourceUrl ||= url;
        } else if (articleMode === "paste") {
          if (!paste.trim()) throw new Error("请先粘贴英文文章内容");
          article = parseArticleText(paste, title || "Pasted article");
        } else {
          if (!articleFile) throw new Error("请选择 txt、md 或 html 文件");
          const fileProblem = vocabLocalImportFileProblem(articleFile, "article");
          if (fileProblem) throw new Error(fileProblem);
          const articleText = await readFileText(articleFile);
          throwIfVocabImportAborted(controller.signal);
          if (!articleText) throw new Error("文章文件没有可导入的文字内容。");
          article = parseArticleText(
            articleText,
            title || articleFile.name.replace(/\.[^.]+$/, ""),
          );
        }
        if (title.trim()) article.title = title.trim();
        throwIfVocabImportAborted(controller.signal);
        const receipt = await prepareVocabArticleWrite(article, articleMode);
        throwIfVocabImportAborted(controller.signal);
        checkpoint({ version: 1, type: "database", receipt });
        checkpointed = true;
        setPhase("committing");
        setStage(2);
        await finishCommitted(await saveArticle(article, articleMode, receipt));
      } else if (kind === "rss") {
        assertVocabExternalImportAllowed(localLock, controller.signal, "本地锁已开启，没有访问 RSS。");
        if (!/^https?:\/\//i.test(url)) throw new Error("请输入完整的 RSS 地址");
        setStage(1);
        const found = normalizePodcastApi(
          await postJson("/api/import/rss", { url }, controller.signal),
        );
        assertVocabExternalImportAllowed(localLock, controller.signal, "本地锁已开启；RSS 读取已经停止，没有继续处理节目。");
        if (!found.length) throw new Error("订阅中没有找到可导入的单集");
        setEpisodes(found);
        setPhase("idle");
        setStage(0);
      } else {
        if (!audioFile && !transcriptFile) throw new Error("请添加音频或字幕文件");
        if (audioFile) {
          const audioProblem = vocabLocalImportFileProblem(audioFile, "audio", {
            forTranscription: transcribe,
          });
          if (audioProblem) throw new Error(audioProblem);
          const storageProblem = localAudioStorageProblem();
          if (storageProblem) throw new Error(storageProblem);
        }
        let segments: ParsedPodcast["segments"] = [];
        if (transcriptFile) {
          const transcriptProblem = vocabLocalImportFileProblem(transcriptFile, "transcript");
          if (transcriptProblem) throw new Error(transcriptProblem);
          const transcriptText = await readFileText(transcriptFile);
          throwIfVocabImportAborted(controller.signal);
          segments = parseTranscript(transcriptText, transcriptFile.name, transcriptFile.type);
          if (!segments.length) throw new Error("字幕文件没有可导入的文字内容。");
        }
        let durationMs = segments.at(-1)?.end_ms ?? 0;
        if (transcribe && audioFile && segments.length === 0) {
          assertVocabExternalImportAllowed(localLock, controller.signal, "本地锁已开启，没有发送音频转写。");
          if (!transcriptionConfigured) {
            throw new Error("尚未配置语音转写服务。可以直接导入 VTT、SRT、LRC 或纯文本字幕。");
          }
          setStage(1);
          const form = new FormData();
          form.append("file", audioFile);
          form.append("language", "en");
          const response = await fetch("/api/transcribe", {
            method: "POST",
            body: form,
            signal: controller.signal,
          });
          const payload = await response.json().catch(() => ({}));
          assertVocabExternalImportAllowed(localLock, controller.signal, "本地锁已开启；音频转写已经停止，没有继续处理远程结果。");
          if (!response.ok) {
            throw new Error(String((payload as Record<string, unknown>).error ?? "转写失败"));
          }
          const data = ((payload as Record<string, unknown>).data ?? payload) as Record<string, unknown>;
          segments = normalizeTranscriptionSegments(data.segments);
          const reportedDuration = Number(data.duration_ms);
          durationMs = Number.isFinite(reportedDuration) && reportedDuration >= 0
            ? Math.round(reportedDuration)
            : segments.at(-1)?.end_ms ?? 0;
          throwIfVocabImportAborted(controller.signal);
          if (!segments.length) {
            throw new Error("转写服务没有返回可导入的字幕；没有写入仅音频条目。");
          }
        }
        throwIfVocabImportAborted(controller.signal);
        const podcast: ParsedPodcast = {
          title: title.trim() ||
            audioFile?.name.replace(/\.[^.]+$/, "") ||
            transcriptFile?.name.replace(/\.[^.]+$/, "") ||
            "Local podcast",
          description: transcriptFile
            ? `Transcript: ${transcriptFile.name}`
            : "Locally imported English audio",
          source: "本地导入",
          durationMs,
          segments,
        };
        setPhase("committing");
        setStage(2);
        if (audioFile) {
          const receipt = await prepareVocabPodcastAudioWrite(
            podcast,
            "file",
            audioFile,
          );
          throwIfVocabImportAborted(controller.signal);
          const result = await saveVocabPodcastWithAudio(
            podcast,
            "file",
            audioFile,
            {
              receipt,
              onRecoveryPrepared: (prepared) => {
                checkpoint({ version: 1, type: "podcast-audio", receipt: prepared });
                checkpointed = true;
              },
            },
          );
          await finishCommitted(result.itemId);
        } else {
          const receipt = await prepareVocabPodcastWrite(podcast, "file");
          throwIfVocabImportAborted(controller.signal);
          checkpoint({ version: 1, type: "database", receipt });
          checkpointed = true;
          await finishCommitted(await savePodcast(podcast, "file", receipt));
        }
      }
    } catch (caught) {
      const localLockError = isVocabLocalLockImportError(caught)
        ? caught
        : isVocabLocalLockImportError(controller.signal.reason) ? controller.signal.reason : null;
      const cancelled = isVocabImportCancelledError(caught)
        ? caught
        : isVocabImportCancelledError(controller.signal.reason) ? controller.signal.reason : null;
      if (cancelled && !checkpointed) {
        setPhase("idle");
        setStage(0);
        setError(cancelled.message);
      } else if (localLockError && !checkpointed) {
        setPhase("idle");
        setError(localLockError.message);
      } else if (!controller.signal.aborted || checkpointed) {
        handleFailure(caught, checkpointed);
      }
    } finally {
      finish(controller);
    }
  };

  const importEpisode = async (episode: ParsedPodcast, audioOnlyConfirmed = false) => {
    if (!begin()) return;
    const controller = new AbortController();
    operation.current = controller;
    setPhase("preparing");
    setStage(0);
    setError("");
    let checkpointed = false;
    try {
      if (!podcastEpisodeHasImportableMedia(episode)) {
        throw new Error("这一集既没有音频，也没有受支持的字幕，不能导入。");
      }
      if (audioOnlyConfirmed && !episode.audioUrl) {
        throw new Error("这一集没有音频，不能跳过失败的字幕。");
      }
      let ready: ParsedPodcast = audioOnlyConfirmed
        ? { ...episode, transcriptUrl: undefined, transcriptType: undefined, segments: [] }
        : episode;
      if (!audioOnlyConfirmed && !episode.segments.length && episode.transcriptUrl) {
        try {
          assertVocabExternalImportAllowed(localLock, controller.signal, "本地锁已开启，没有读取这一集的远程字幕。");
          setStage(1);
          const transcript = remoteTranscriptPayload(await postJson(
            "/api/import/rss",
            {
              kind: "transcript",
              url: episode.transcriptUrl,
              transcriptType: episode.transcriptType,
            },
            controller.signal,
          ));
          assertVocabExternalImportAllowed(localLock, controller.signal, "本地锁已开启；远程字幕读取已经停止，没有继续处理。");
          const segments = parseTranscript(
            transcript.text,
            transcript.url,
            transcript.transcriptType || episode.transcriptType,
          );
          if (!segments.length) throw new Error("远程字幕没有可导入的文字内容。");
          ready = {
            ...episode,
            segments,
          };
        } catch (caught) {
          if (controller.signal.aborted || isVocabLocalLockImportError(caught)) throw caught;
          const reason = vocabImportErrorMessage(caught);
          setPhase("idle");
          setStage(0);
          if (episode.audioUrl) {
            setPendingAudioOnly({ episode, reason });
            setError(`远程字幕读取失败：${reason} 请明确选择是否仍导入仅音频。`);
            return;
          }
          throw new Error(`远程字幕读取失败：${reason} 这一集也没有音频，因此不能导入。`);
        }
      }
      throwIfVocabImportAborted(controller.signal);
      setPendingAudioOnly(null);
      const receipt = await prepareVocabPodcastWrite(ready, "rss");
      throwIfVocabImportAborted(controller.signal);
      checkpoint({ version: 1, type: "database", receipt });
      checkpointed = true;
      setPhase("committing");
      setStage(2);
      await finishCommitted(await savePodcast(ready, "rss", receipt));
    } catch (caught) {
      const localLockError = isVocabLocalLockImportError(caught)
        ? caught
        : isVocabLocalLockImportError(controller.signal.reason) ? controller.signal.reason : null;
      const cancelled = isVocabImportCancelledError(caught)
        ? caught
        : isVocabImportCancelledError(controller.signal.reason) ? controller.signal.reason : null;
      if (cancelled && !checkpointed) {
        setPhase("idle");
        setStage(0);
        setError(cancelled.message);
      } else if (localLockError && !checkpointed) {
        setPhase("idle");
        setError(localLockError.message);
      } else if (!controller.signal.aborted || checkpointed) {
        handleFailure(caught, checkpointed);
      }
    } finally {
      finish(controller);
    }
  };

  const inspectRecovery = async () => {
    if (!recovery || !begin()) return;
    setError("");
    try {
      if (recovery.type === "database") {
        const status = await inspectVocabImportWrite(recovery.receipt);
        if (status === "exact_saved") {
          clearCheckpoint();
          setCommittedId(recovery.receipt.itemId);
          setPhase("refresh_failed");
          setError("已只读确认：内容已经保存。下一步只刷新页面，不会再次写入。");
        } else if (status === "absent") {
          if (!clearCheckpoint()) {
            setPhase("idle");
            setError("已只读确认：这次内容没有写入。你可以重新发起导入。");
          }
        } else {
          setPhase(status === "conflict" ? "conflict" : "uncertain");
          setError(status === "conflict"
            ? "回执与数据库里的内容不一致，已保持只读并停止重试。"
            : "数据库暂时仍无法核对。没有写入、覆盖或删除任何内容。");
        }
      } else {
        const status = await inspectVocabPodcastAudioWrite(recovery.receipt);
        if (
          status.database === "exact_saved" &&
          status.file === "exact_staged"
        ) {
          clearCheckpoint();
          setCommittedId(recovery.receipt.database.itemId);
          setPhase("refresh_failed");
          setError("已只读确认：内容和音频都已保存。下一步只刷新页面。");
        } else if (status.database === "exact_saved") {
          setPhase(status.file === "conflict" ? "conflict" : "uncertain");
          setError(
            "内容已经保存，但本地音频尚未完整确认。回执会继续保留；只能再次只读核对，不会删除或覆盖音频。",
          );
        } else if (
          status.database === "absent" &&
          status.file !== "unknown"
        ) {
          setPhase("recovery_absent");
          setError(status.file === "conflict"
            ? "已确认数据库没有保存，但暂存音频并不完整。可以尝试收尾；只有底层再次证明它属于这个回执时才会删除，否则会原样保留。"
            : "已只读确认：数据库没有保存。若要清理，只会删除这个回执拥有的暂存音频。");
        } else {
          const conflict = status.database === "conflict" || status.file === "conflict";
          setPhase(conflict ? "conflict" : "uncertain");
          setError(conflict
            ? "数据库或音频回执发生冲突，本地音频已原样保留；不会自动清理。"
            : "数据库或音频暂时仍无法核对，本地音频已原样保留。");
        }
      }
    } catch (caught) {
      setPhase("uncertain");
      setError(`核对没有完成：${errorMessage(caught)}。没有执行写入或删除。`);
    } finally {
      finish();
    }
  };

  const cleanupRecovery = async () => {
    if (recovery?.type !== "podcast-audio" || !begin()) return;
    try {
      const result = await cleanupVocabPodcastAudioWrite(recovery.receipt);
      if (result === "blocked") {
        setPhase("uncertain");
        setError("底层没有再次证明暂存音频属于这个回执，因此没有删除；原文件会保留。");
      } else {
        if (!clearCheckpoint()) {
          setPhase("idle");
          setError(result === "deleted"
            ? "只清理了这次回执拥有的未完成暂存音频。你可以重新导入。"
            : "没有发现需要清理的暂存音频。你可以重新导入。");
        }
      }
    } catch (caught) {
      setPhase("uncertain");
      setError(`暂存音频没有被删除：${errorMessage(caught)}`);
    } finally {
      finish();
    }
  };

  const requestAbandonConflict = () => {
    if (!recovery || busyRef.current) return;
    abandonOpener.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setConfirmAbandon(true);
    setError(recovery.type === "podcast-audio"
      ? "只结束这条提醒吗？数据库和本地音频都会原样保留。"
      : "只结束这条提醒吗？数据库内容会原样保留。");
  };

  const abandonConflict = async () => {
    if (!recovery || busyRef.current) return;
    if (!removeImportRecovery(recovery)) {
      setError("提醒已发生变化或暂时无法访问，因此没有移除。可以稍后再次只读核对。");
      return;
    }
    setConfirmAbandon(false);
    activeRecovery.current = null;
    setRecovery(null);
    if (!activateNextCheckpoint()) {
      setPhase("idle");
      setError(recovery.type === "podcast-audio"
        ? "只移除了这条恢复提醒；数据库和本地音频都保持原样。"
        : "只移除了这条恢复提醒；数据库内容保持原样。");
    }
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".sc-import-modal .sc-primary:not(:disabled), .sc-import-modal button[data-dialog-close]:not(:disabled)")?.focus({ preventScroll: true });
    });
  };

  const refreshOnly = async () => {
    if (!committedId || !begin()) return;
    setPhase("refreshing");
    setStage(3);
    setError("");
    try {
      await onImported(committedId);
    } catch (caught) {
      setPhase("refresh_failed");
      setError(`内容仍然安全保存在本地，只是页面刷新失败：${errorMessage(caught)}`);
    } finally {
      finish();
    }
  };

  const controlsLocked = busy || Boolean(recovery) || Boolean(committedId) || Boolean(pendingAudioOnly);
  const recoveryAction = phase === "uncertain" || phase === "conflict" || phase === "recovery_absent" || phase === "refresh_failed";
  const primaryLabel = busy
    ? phase === "refreshing" ? "只刷新中…" : "正在确认…"
    : phase === "uncertain" ? "只读核对"
    : phase === "conflict" ? "移除这条提醒"
    : phase === "recovery_absent" ? "清理这次暂存"
    : phase === "refresh_failed" ? "只刷新页面"
    : kind === "rss" ? "读取节目" : "导入到拾词";
  const primaryAction = phase === "uncertain"
    ? inspectRecovery
    : phase === "conflict"
      ? requestAbandonConflict
    : phase === "recovery_absent"
      ? cleanupRecovery
      : phase === "refresh_failed"
        ? refreshOnly
        : submit;
  const transcriptionSizeProblem = audioFile
    ? vocabLocalImportFileProblem(audioFile, "audio", { forTranscription: true })
    : null;
  const canCancelTranscription = busy && kind === "audio" &&
    phase === "preparing" && stage === 1 && transcribe;

  const chooseArticleFile = (file: File | null) => {
    setError("");
    if (file) {
      const problem = vocabLocalImportFileProblem(file, "article");
      if (problem) {
        setArticleFile(null);
        setError(problem);
        return;
      }
    }
    setArticleFile(file);
  };

  const chooseTranscriptFile = (file: File | null) => {
    setError("");
    if (file) {
      const problem = vocabLocalImportFileProblem(file, "transcript");
      if (problem) {
        setTranscriptFile(null);
        setError(problem);
        return;
      }
      setTranscribe(false);
    }
    setTranscriptFile(file);
  };

  const chooseAudioFile = (file: File | null) => {
    setError("");
    if (file) {
      const problem = vocabLocalImportFileProblem(file, "audio") ?? localAudioStorageProblem();
      if (problem) {
        setAudioFile(null);
        setTranscribe(false);
        setError(problem);
        return;
      }
      const transcriptionProblem = vocabLocalImportFileProblem(file, "audio", {
        forTranscription: true,
      });
      if (transcribe && transcriptionProblem) {
        setTranscribe(false);
        setError(`${transcriptionProblem} 已关闭外部转写；仍可仅在本地导入音频。`);
      }
    } else {
      setTranscribe(false);
    }
    setAudioFile(file);
  };

  const chooseTranscription = (checked: boolean) => {
    setError("");
    if (checked) {
      if (!audioFile) {
        setError("请先选择要转写的音频文件。");
        return;
      }
      const problem = vocabLocalImportFileProblem(audioFile, "audio", {
        forTranscription: true,
      });
      if (problem) {
        setError(problem);
        return;
      }
    }
    setTranscribe(checked);
  };

  return <>
    <button className="sc-modal-scrim" disabled={busy} onClick={close} aria-label="关闭导入" />
    <section ref={dialog} className="sc-import-modal" role="dialog" aria-modal="true" aria-labelledby="sc-import-title" tabIndex={-1}>
      <header><Logo /><div><span>添加到资料库</span><h2 id="sc-import-title">从哪里开始？</h2></div><button data-dialog-close disabled={busy} onClick={close} aria-label="关闭导入内容">×</button></header>
      <div className="sc-import-types">{([['article', '英文文章'], ['rss', 'RSS 播客'], ['audio', '音频 / 字幕']] as const).map(([id, label]) => <button key={id} disabled={controlsLocked} aria-pressed={kind === id} className={kind === id ? "active" : ""} onClick={() => { setKind(id); setError(""); setEpisodes([]); setPendingAudioOnly(null); }}>{label}</button>)}</div>
      <div className="sc-import-body">
        {kind === "article" && <>
          <div className="sc-import-subtabs">{([['url', '网页地址'], ['paste', '粘贴文本'], ['file', '本地文件']] as const).map(([id, label]) => <button key={id} disabled={controlsLocked} aria-pressed={articleMode === id} className={articleMode === id ? "active" : ""} onClick={() => setArticleMode(id)}>{label}</button>)}</div>
          {articleMode === "url" && <label className="sc-field"><span>文章地址</span><input disabled={controlsLocked} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /><small>网页会经安全提取，只保留可读正文。</small></label>}
          {articleMode === "paste" && <label className="sc-field"><span>英文文章内容</span><textarea disabled={controlsLocked} value={paste} onChange={(event) => setPaste(event.target.value)} placeholder="Paste an English article here…" /></label>}
          {articleMode === "file" && <FileDrop disabled={controlsLocked} file={articleFile} accept=".txt,.md,.html,text/plain,text/markdown,text/html" label="TXT、Markdown 或 HTML" onFile={chooseArticleFile} />}
          <label className="sc-field compact"><span>标题（可选）</span><input disabled={controlsLocked} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="自动识别，也可以手动覆盖" /></label>
        </>}
        {kind === "rss" && !episodes.length && <>
          <label className="sc-field"><span>RSS 地址</span><input disabled={controlsLocked} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/feed.xml" /><small>先读取节目目录，再由你选择要保存的单集。</small></label>
          <div className="sc-privacy-hint"><i>隐</i><p>只有 RSS 地址会发送到导入服务；单集不会自动下载。</p></div>
        </>}
        {kind === "rss" && episodes.length > 0 && <div className="sc-episode-picker">
          <header><span>选择一集</span><small>显示全部 {episodes.length} 个结果</small></header>
          {episodes.map((episode, index) => {
            const importable = podcastEpisodeHasImportableMedia(episode);
            const media = episode.audioUrl && episode.transcriptUrl
              ? "音频与字幕"
              : episode.audioUrl ? "仅音频" : episode.transcriptUrl ? "仅字幕" : "没有可导入媒体";
            return <button key={`${episode.title}-${index}`} disabled={controlsLocked || !importable} aria-disabled={!importable} onClick={() => void importEpisode(episode)}>
              <i>{String(index + 1).padStart(2, "0")}</i><span><b>{episode.title}</b><small>{episode.source} · {episode.durationMs ? `${Math.round(episode.durationMs / 60000)} 分钟` : "时长未知"} · {media}</small></span><strong>{importable ? "导入 →" : "不可导入"}</strong>
            </button>;
          })}
        </div>}
        {pendingAudioOnly && <div className="sc-import-error" role="alert">
          <p>字幕失败原因：{pendingAudioOnly.reason}</p>
          <p>尚未写入这一集。只有你明确确认后，才会保存不含字幕的音频条目。</p>
          <div className="sc-reminder-confirm"><button onClick={() => { setPendingAudioOnly(null); setError("已停止这次单集导入；没有写入任何内容。"); }}>不导入</button><button className="danger" onClick={() => void importEpisode(pendingAudioOnly.episode, true)}>仍导入仅音频</button></div>
        </div>}
        {kind === "audio" && <>
          <FileDrop disabled={controlsLocked} file={audioFile} accept="audio/*,.mp3,.m4a,.wav,.ogg" label="音频文件" onFile={chooseAudioFile} />
          <FileDrop disabled={controlsLocked} file={transcriptFile} accept=".vtt,.srt,.lrc,.txt,.json,.html,text/vtt,text/html,text/plain,application/json" label="VTT、SRT、LRC、JSON、HTML 或纯文本字幕" onFile={chooseTranscriptFile} />
          <label className="sc-field compact"><span>节目标题</span><input disabled={controlsLocked} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Untitled podcast" /></label>
          <label className="sc-check"><input aria-label="没有字幕时请求外部转写" type="checkbox" checked={transcribe} disabled={controlsLocked || !audioFile || Boolean(transcriptFile) || Boolean(transcriptionSizeProblem) || localLock || transcriptionConfigured !== true} onChange={(event) => chooseTranscription(event.target.checked)} /><span><b>没有字幕时，请求外部转写</b><small>{transcriptFile ? "已选择字幕；字幕只在本地读取，不会上传音频。" : localLock ? "本地锁已开启，不会上传音频。" : transcriptionSizeProblem ? `${transcriptionSizeProblem} 音频仍可只保存在本机。` : transcriptionConfigured === null ? "正在检查是否配置了转写服务…" : transcriptionConfigured ? "勾选后会把完整音频上传到已配置的外部转写端点；不勾选不会上传。" : "当前未配置转写服务；音频和字幕文件不会上传。"}</small></span></label>
        </>}
        {error && !pendingAudioOnly && <div className="sc-import-error" role={confirmAbandon ? "status" : "alert"}>{error}</div>}
        {busy && <div className="sc-import-progress" role="status" aria-live="polite"><i><em style={{ width: stage === 1 ? "58%" : stage === 2 ? "82%" : stage === 3 ? "94%" : "22%" }} /></i><span>{cancelRequested ? "正在取消转写；不会写入…" : phase === "refreshing" ? "内容已保存，正在刷新页面…" : stage === 1 ? (kind === "audio" ? "正在转写英文音频…" : "正在读取远程内容…") : stage === 2 ? "正在核对并写入本地资料库…" : "正在准备…"}</span></div>}
      </div>
      {(!episodes.length || recoveryAction) && (confirmAbandon?<footer className="sc-reminder-confirm"><button ref={keepReminderButton} onClick={close}>继续保留提醒</button><button className="danger" onClick={() => void abandonConflict()}>只移除提醒</button></footer>
        : canCancelTranscription
          ? <footer><button className="danger" disabled={cancelRequested} onClick={cancelCurrentOperation}>{cancelRequested ? "正在取消…" : "取消转写"}</button></footer>
          : <footer><button disabled={busy} onClick={close}>关闭</button><button className="sc-primary" disabled={busy} onClick={() => void primaryAction()}>{primaryLabel}</button></footer>)}
    </section>
  </>;
}

function FileDrop({file,accept,label,disabled=false,onFile}:{file:File|null;accept:string;label:string;disabled?:boolean;onFile:(file:File|null)=>void}){
  const drop=(event:DragEvent<HTMLLabelElement>)=>{event.preventDefault();if(!disabled)onFile(event.dataTransfer.files[0]??null);};
  return <label aria-disabled={disabled} className={`sc-file-drop ${file?"has-file":""}`} onDragOver={(event)=>event.preventDefault()} onDrop={drop}><input aria-label={`选择${label}`} type="file" accept={accept} disabled={disabled} hidden onChange={(event:ChangeEvent<HTMLInputElement>)=>onFile(event.target.files?.[0]??null)}/><i>{file?"✓":"↑"}</i><span><b>{file?.name||`选择${label}`}</b><small>{file?`${(file.size/1024).toFixed(1)} KB`:"点击或拖放，文件会留在本地"}</small></span></label>;
}
