"use client";

import { useMemo, useState } from "react";
import type { LibraryItem, VocabSnapshot } from "@/lib/vocab/types";
import { useOverlayDialog } from "./useOverlayDialog";

export function SearchPalette({ snapshot, onClose, onOpenItem, onOpenWord }: {
  snapshot: VocabSnapshot;
  onClose: () => void;
  onOpenItem: (item: LibraryItem) => void;
  onOpenWord: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const dialog = useOverlayDialog<HTMLElement>(true, onClose, "input");
  const normalized = query.trim().toLocaleLowerCase();
  const results = useMemo(() => {
    const items = snapshot.items
      .filter((item) => item.status !== "archived" && (!normalized || `${item.title} ${item.author} ${item.source} ${item.description}`.toLocaleLowerCase().includes(normalized)))
      .slice(0, normalized ? 8 : 4);
    const words = snapshot.lexemes
      .filter((word) => !normalized || `${word.headword} ${word.pronunciation} ${word.gloss_en} ${word.notes}`.toLocaleLowerCase().includes(normalized) || snapshot.occurrences.some((occurrence) => occurrence.lexeme_id === word.id && occurrence.context_sentence.toLocaleLowerCase().includes(normalized)))
      .slice(0, normalized ? 8 : 4);
    return { items, words };
  }, [normalized, snapshot.items, snapshot.lexemes, snapshot.occurrences]);

  return <><button className="sc-modal-scrim sc-search-scrim" aria-label="关闭全局搜索" onClick={onClose}/><section ref={dialog} className="sc-search-modal" role="dialog" aria-modal="true" aria-labelledby="sc-search-title" tabIndex={-1}>
    <header><div><span>全局搜索</span><h2 id="sc-search-title">找到内容，也找到当时的语境</h2></div><button data-dialog-close aria-label="关闭全局搜索" onClick={onClose}>×</button></header>
    <label className="sc-command-input"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资料、词或原句"/><kbd>Esc</kbd></label>
    <div className="sc-search-results">
      {results.items.length > 0 && <section aria-labelledby="sc-result-content"><h3 id="sc-result-content">资料</h3>{results.items.map((item) => <button key={item.id} onClick={() => { onClose(); onOpenItem(item); }}><i>{item.kind === "article" ? "文" : "声"}</i><span><strong>{item.title}</strong><small>{item.source || (item.kind === "article" ? "文章" : "播客")}</small></span><b>打开</b></button>)}</section>}
      {results.words.length > 0 && <section aria-labelledby="sc-result-words"><h3 id="sc-result-words">词与语境</h3>{results.words.map((word) => <button key={word.id} onClick={() => { onClose(); onOpenWord(word.id); }}><i>词</i><span><strong>{word.headword}</strong><small>{word.gloss_en || snapshot.occurrences.find((entry) => entry.lexeme_id === word.id)?.context_sentence || "保存在本地的语境"}</small></span><b>查看</b></button>)}</section>}
      {!results.items.length && !results.words.length && <div className="sc-search-empty"><span>没有找到</span><p>换一个词，或搜索原句中的片段。</p></div>}
    </div>
  </section></>;
}
