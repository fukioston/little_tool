import type { ReactNode } from "react";

export function Logo() {
  return <span className="sc-logo"><b>拾</b><span>拾词<small>SHÍ CÍ</small></span></span>;
}

export function EmptyState({ title, copy, action }: { title: string; copy: string; action?: ReactNode }) {
  return <div className="sc-empty"><span>拾</span><h3>{title}</h3><p>{copy}</p>{action}</div>;
}

export function Metric({ value, label, suffix }: { value: string | number; label: string; suffix?: string }) {
  return <div className="sc-metric"><div><strong>{value}</strong>{suffix && <small>{suffix}</small>}</div><span>{label}</span></div>;
}

export function Loader() {
  return <main className="shici sc-loading"><div className="sc-loader-mark">拾</div><div className="sc-loader-line" /><p>正在打开你的词库…</p></main>;
}

export function AnnotatedText({ text, ranges }: { text: string; ranges: Array<{ id: string; surface: string; start_utf16: number; end_utf16: number }> }) {
  const located = ranges.map((entry) => {
    const stored = text.slice(entry.start_utf16, entry.end_utf16);
    const start = stored.toLowerCase() === entry.surface.toLowerCase() ? entry.start_utf16 : text.toLowerCase().indexOf(entry.surface.toLowerCase());
    return { id: entry.id, start, end: start + entry.surface.length };
  }).filter((entry) => entry.start >= 0).sort((a, b) => a.start - b.start);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  located.forEach((entry) => {
    if (entry.start < cursor) return;
    nodes.push(text.slice(cursor, entry.start));
    nodes.push(<mark key={entry.id}>{text.slice(entry.start, entry.end)}</mark>);
    cursor = entry.end;
  });
  nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

export function Toggle({ label, copy, value, onChange }: { label: string; copy: string; value: boolean; onChange: (value: boolean) => void }) {
  return <div className="sc-toggle-row"><label>{label}<small>{copy}</small></label><button type="button" role="switch" aria-checked={value} className={value ? "on" : ""} onClick={() => onChange(!value)}><i /></button></div>;
}
