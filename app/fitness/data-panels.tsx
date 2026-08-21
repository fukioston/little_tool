"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  exportCompleteFitnessBackup,
  isCompleteFitnessBackup,
  restoreCompleteFitnessBackup,
  restoreLegacyFitnessDatabase,
} from "@/lib/fitness/backup";
import {
  deleteFitnessFile,
  getFitnessFileBlob,
  listFitnessFiles,
  saveFitnessFile,
  type FitnessFileRecord,
} from "@/lib/fitness/files";
import type { FitnessEquipment } from "@/lib/fitness/types";

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "操作没有完成，现有数据未被静默覆盖。";
}

type Preview = Readonly<{ record: FitnessFileRecord; url: string | null }>;

export function EquipmentPhotos({
  equipment,
  onChanged,
}: {
  equipment: FitnessEquipment;
  onChanged: () => Promise<void>;
}) {
  const [previews, setPreviews] = useState<readonly Preview[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const previewUrls = useRef<string[]>([]);

  const load = async () => {
    const rows = await listFitnessFiles({ entityType: "equipment", entityId: equipment.id });
    const next = await Promise.all(rows.map(async (record): Promise<Preview> => {
      if (record.status !== "ready" || !record.mime_type.startsWith("image/")) return { record, url: null };
      try {
        const blob = await getFitnessFileBlob(record.id);
        return { record, url: URL.createObjectURL(blob) };
      } catch {
        return { record: { ...record, status: "missing" }, url: null };
      }
    }));
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.current = next.flatMap((entry) => entry.url ? [entry.url] : []);
    setPreviews(next);
  };

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      void load().catch((reason) => { if (live) setError(message(reason)); });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
      previewUrls.current = [];
    };
    // The selected equipment ID defines this panel's complete storage scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equipment.id]);

  const add = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true); setError("");
    try {
      await saveFitnessFile({ entityType: "equipment", entityId: equipment.id, purpose: "photo", file });
      await load();
      await onChanged();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const remove = async (record: FitnessFileRecord) => {
    if (busy || !window.confirm(`删除「${record.file_name}」的本地副本吗？此操作不会删除器材记录。`)) return;
    setBusy(true); setError("");
    try {
      await deleteFitnessFile(record.id);
      await load();
      await onChanged();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  return <div className="sl-file-panel">
    <p className="sl-safety-copy">照片只保存在当前浏览器的适练空间，用于辨认真实器材；不会发送给 AI。支持 JPEG、PNG、WebP、HEIC，单张不超过 20 MiB。</p>
    <div className="sl-file-actions"><input ref={input} type="file" accept=".jpg,.jpeg,.png,.webp,.heic,image/jpeg,image/png,image/webp,image/heic" onChange={(event) => void add(event.target.files?.[0])}/><span>{busy ? "正在核验并保存…" : "选择一张器材照片"}</span></div>
    {previews.length > 0 ? <div className="sl-file-grid">{previews.map(({ record, url }) => <article key={record.id}>{url ? <Image unoptimized width={640} height={420} src={url} alt={`${equipment.name}：${record.file_name}`}/> : <div className="sl-file-missing">{record.status === "pending" ? "正在恢复写入" : "原文件不可用"}</div>}<footer><span><b>{record.file_name}</b><small>{Math.max(1, Math.round(record.byte_size / 1024))} KB · {record.status === "ready" ? "已校验" : "需检查"}</small></span><button disabled={busy} onClick={() => void remove(record)}>删除</button></footer></article>)}</div> : <div className="sl-file-empty">还没有照片。没有照片不会影响器材规划。</div>}
    {error && <p className="sl-form-error" role="alert">{error}</p>}
  </div>;
}

export function FitnessDataControls({ onRestored }: { onRestored: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const exportBackup = async () => {
    if (busy) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const result = await exportCompleteFitnessBackup();
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = result.fileName;
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setStatus(`完整备份已交给浏览器下载，包含 ${result.fileCount} 个附件；请确认下载目录中出现文件。`);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const complete = await isCompleteFitnessBackup(file);
      const confirmed = window.confirm(complete
        ? "恢复这份适练完整备份吗？通过全部校验后才会一次切换；当前版本会保留为恢复快照。"
        : "这是旧版适练 SQLite 备份。它不含器材照片，恢复时会清空失效的附件引用；当前版本会保留为恢复快照。继续吗？");
      if (!confirmed) return;
      if (complete) {
        const result = await restoreCompleteFitnessBackup(file);
        setStatus(`已切换到 ${result.exportedAt.slice(0, 10)} 的完整备份，${result.fileCount} 个附件已逐项校验；上一版本仍作为恢复快照保留。`);
      } else {
        await restoreLegacyFitnessDatabase(file);
        setStatus("旧版 SQLite 数据已恢复；它不包含附件，原附件引用未被伪装成可用文件。上一版本仍作为恢复快照保留。");
      }
      await onRestored();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return <div className="sl-data-controls">
    <div><button disabled={busy} onClick={() => void exportBackup()}>{busy ? "正在校验…" : "下载完整备份"}</button><button disabled={busy} onClick={() => input.current?.click()}>从备份恢复</button></div>
    <input ref={input} hidden type="file" accept=".fitness-backup,.sqlite3,application/vnd.shilian.fitness-backup,application/x-sqlite3" onChange={(event) => void restore(event.target.files?.[0])}/>
    <p>完整备份包含 SQLite 数据与已校验附件，不含 DeepSeek Key。恢复先写入候选版本，全部通过后才切换。</p>
    {status && <p className="sl-data-status" role="status">{status}</p>}
    {error && <p className="sl-form-error" role="alert">{error}</p>}
  </div>;
}
