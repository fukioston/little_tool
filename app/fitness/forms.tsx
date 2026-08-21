"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  EQUIPMENT_KIND_LABELS,
  EQUIPMENT_TEMPLATES,
  MOVEMENT_PATTERN_LABELS,
} from "@/lib/fitness/catalog";
import type {
  SaveConstraintInput,
  SaveEquipmentInput,
  SaveFitnessProfileInput,
  SaveVenueInput,
} from "@/lib/fitness/store";
import type {
  EquipmentKind,
  FitnessConstraint,
  FitnessEquipment,
  FitnessEquipmentLoad,
  FitnessGoal,
  FitnessProfile,
  FitnessVenue,
  MovementPattern,
} from "@/lib/fitness/types";
import { useFitnessDialog } from "./useFitnessDialog";

export function FitnessDialog({
  open,
  title,
  eyebrow,
  onClose,
  children,
  wide = false,
  busy = false,
}: {
  open: boolean;
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  busy?: boolean;
}) {
  const requestClose = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  const dialog = useFitnessDialog<HTMLElement>(open, requestClose, "[data-dialog-close]");
  if (!open) return null;
  return <>
    <button type="button" className="sl-scrim" tabIndex={-1} aria-hidden="true" disabled={busy} onClick={requestClose} />
    <section ref={dialog} className={`sl-dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby="sl-dialog-title" tabIndex={-1}>
      <header><div><span>{eyebrow}</span><h2 id="sl-dialog-title">{title}</h2></div><button type="button" data-dialog-close disabled={busy} onClick={requestClose} aria-label={`关闭${title}`}>×</button></header>
      {children}
    </section>
  </>;
}

function FormBusyStatus({ busy }: { busy: boolean }) {
  return busy ? <p className="sl-visually-hidden" role="status">正在保存，请稍候。</p> : null;
}

function submitValues(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return new FormData(event.currentTarget);
}

export type FormBusyController = Readonly<{
  begin: () => (() => void) | null;
  dispose: () => void;
  isBusy: () => boolean;
}>;

export function createFormBusyController(
  onBusyChange: (busy: boolean) => void,
): FormBusyController {
  let activeToken: symbol | null = null;
  let disposed = false;
  let reportedBusy = false;
  const report = (next: boolean) => {
    if (reportedBusy === next) return;
    reportedBusy = next;
    onBusyChange(next);
  };
  return {
    begin() {
      if (disposed || activeToken !== null) return null;
      const token = Symbol("fitness-form-save");
      activeToken = token;
      report(true);
      let settled = false;
      return () => {
        if (settled) return;
        settled = true;
        if (disposed || activeToken !== token) return;
        activeToken = null;
        report(false);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activeToken = null;
      report(false);
    },
    isBusy() {
      return activeToken !== null;
    },
  };
}

export function runReportedFormPersistence(
  beginBusy: () => (() => void) | null,
  persistence: () => Promise<void>,
  onError: (message: string) => void,
  fallbackError: string,
): Promise<void> | null {
  const settle = beginBusy();
  if (!settle) return null;
  let result: Promise<void>;
  try {
    result = persistence();
  } catch (reason) {
    try {
      onError(reason instanceof Error ? reason.message : fallbackError);
    } finally {
      settle();
    }
    return Promise.resolve();
  }
  return Promise.resolve(result)
    .catch((reason) => onError(reason instanceof Error ? reason.message : fallbackError))
    .finally(settle);
}

export function clearOwnedFormError(currentError: string, ownedError: string): string {
  return ownedError && currentError === ownedError ? "" : currentError;
}

export function isActiveConstraintScopeMissing(
  active: boolean,
  movementPatternCount: number,
  exerciseCount: number,
): boolean {
  return active && movementPatternCount === 0 && exerciseCount === 0;
}

export type EquipmentIdentityDraft = Readonly<{
  name: string;
  quantity: string;
  nameCustomized: boolean;
  quantityCustomized: boolean;
}>;

export function suggestedEquipmentQuantity(kind: EquipmentKind): number {
  return kind === "dumbbell" ? 2 : 1;
}

export function createEquipmentIdentityDraft(
  equipment: Pick<FitnessEquipment, "name" | "quantity"> | null | undefined,
  suggestedName: string,
  suggestedQuantity: number,
): EquipmentIdentityDraft {
  if (equipment) {
    return {
      name: equipment.name,
      quantity: String(equipment.quantity),
      nameCustomized: true,
      quantityCustomized: true,
    };
  }
  return {
    name: suggestedName,
    quantity: String(suggestedQuantity),
    nameCustomized: false,
    quantityCustomized: false,
  };
}

export function updateEquipmentIdentityDraft(
  draft: EquipmentIdentityDraft,
  field: "name" | "quantity",
  value: string,
): EquipmentIdentityDraft {
  return field === "name"
    ? { ...draft, name: value, nameCustomized: true }
    : { ...draft, quantity: value, quantityCustomized: true };
}

export function applyEquipmentTemplateSuggestion(
  draft: EquipmentIdentityDraft,
  suggestedName: string,
  suggestedQuantity: number,
): EquipmentIdentityDraft {
  return {
    name: draft.nameCustomized ? draft.name : suggestedName,
    quantity: draft.quantityCustomized ? draft.quantity : String(suggestedQuantity),
    nameCustomized: draft.nameCustomized,
    quantityCustomized: draft.quantityCustomized,
  };
}

function useReportedFormBusy(onBusyChange?: (busy: boolean) => void) {
  const [busy, setBusy] = useState(false);
  const callback = useRef(onBusyChange);
  const controllerRef = useRef<FormBusyController | null>(null);
  useEffect(() => {
    callback.current = onBusyChange;
  }, [onBusyChange]);
  useEffect(() => {
    let mounted = true;
    const controller = createFormBusyController((next) => {
      if (mounted) setBusy(next);
      callback.current?.(next);
    });
    controllerRef.current = controller;
    return () => {
      mounted = false;
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, []);
  const beginBusy = useCallback(() => controllerRef.current?.begin() ?? null, []);
  return { busy, beginBusy };
}

export function resolveVenueVerificationTimestamp(
  verifiedNow: boolean,
  previous: number | null | undefined,
  now = Date.now(),
): number | null {
  return verifiedNow ? now : previous ?? null;
}

export function VenueForm({
  venue,
  onClose,
  onSave,
  onBusyChange,
}: {
  venue?: FitnessVenue | null;
  onClose: () => void;
  onSave: (input: SaveVenueInput) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { busy, beginBusy } = useReportedFormBusy(onBusyChange);
  const [error, setError] = useState("");
  return <form className="sl-form" onSubmit={(event) => {
    const data = submitValues(event);
    const input: SaveVenueInput = {
      id: venue?.id,
      name: String(data.get("name") ?? "").trim(),
      venue_type: String(data.get("venueType") ?? "commercial") as FitnessVenue["venue_type"],
      location: String(data.get("location") ?? "").trim(),
      area_notes: String(data.get("areaNotes") ?? "").trim(),
      busy_notes: String(data.get("busyNotes") ?? "").trim(),
      default_session_minutes: Number(data.get("minutes") ?? 60),
      supersets_allowed: data.get("supersets") === "on",
      is_default: data.get("isDefault") === "on",
      status: venue?.status ?? "active",
      last_verified_at: resolveVenueVerificationTimestamp(
        data.get("verifiedNow") === "on",
        venue?.last_verified_at,
      ),
    };
    setError("");
    void runReportedFormPersistence(beginBusy, () => onSave(input), setError, "场地没有保存");
  }}>
    <div className="sl-field-grid"><label><span>场地名称</span><input required name="name" defaultValue={venue?.name} placeholder="例如：公司楼下健身房" /></label><label><span>场地类型</span><select name="venueType" defaultValue={venue?.venue_type ?? "commercial"}><option value="commercial">商业健身房</option><option value="home">家中</option><option value="office">公司</option><option value="hotel">酒店</option><option value="outdoor">户外</option><option value="other">其他</option></select></label></div>
    <label><span>位置（可选）</span><input name="location" defaultValue={venue?.location} placeholder="只存在当前浏览器，不会发给 AI" /></label>
    <label><span>通常可用多久</span><div className="sl-input-unit"><input name="minutes" type="number" min="10" max="240" defaultValue={venue?.default_session_minutes ?? 60} /><b>分钟</b></div></label>
    <label><span>常去时段与拥挤规律（可选）</span><textarea name="busyNotes" defaultValue={venue?.busy_notes} placeholder="例如：周二晚 7 点深蹲架常要等；这不是实时空闲状态" /></label>
    <label><span>区域与场地规则（可选）</span><textarea name="areaNotes" defaultValue={venue?.area_notes} placeholder="例如：自由重量区在二层；不适合同时占用多台器材" /></label>
    <div className="sl-check-row"><label><input name="supersets" type="checkbox" defaultChecked={venue?.supersets_allowed} /><span>这里适合跨器材超级组</span></label><label><input name="isDefault" type="checkbox" defaultChecked={venue?.is_default ?? true} /><span>设为常用场地</span></label></div>
    <label className="sl-inline-check"><input name="verifiedNow" type="checkbox" /><span>本次已在现场核对器材清单</span></label>
    <p className="sl-form-hint">只有勾选时才会更新“上次核对”；普通编辑不会把旧清单伪装成刚刚确认。</p>
    {error && <p className="sl-form-error" role="alert">{error}</p>}
    <FormBusyStatus busy={busy} />
    <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="sl-primary" disabled={busy}>{busy ? "正在保存…" : "保存场地"}</button></footer>
  </form>;
}

export function parseEquipmentLoadText(
  text: string,
  unit: "kg" | "lb",
  defaultQuantity: number,
): Array<Omit<FitnessEquipmentLoad, "id" | "equipment_id" | "created_at">> {
  if (!text.trim()) return [];

  const factor = unit === "kg" ? 1_000 : 453.59237;
  const seen = new Map<number, number>();
  const tokens = text.split(/[,，;；\n]/);
  const parsed = tokens.map((rawToken, index) => {
    const token = rawToken.trim();
    const position = index + 1;
    if (!token) {
      throw new TypeError(`第 ${position} 项是空的；请删除多余的分隔符。`);
    }
    const match = token.match(/^(\d+(?:\.\d+)?)\s*(?:[x×*]\s*(\d+))?$/i);
    if (!match) {
      throw new TypeError(`第 ${position} 项“${token}”无法识别；请写成“重量×数量”，例如 7.5×2。`);
    }

    const weight = Number(match[1]);
    const grams = Math.round(Number(match[1]) * factor);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new TypeError(`第 ${position} 项的重量必须大于 0 ${unit}。`);
    }
    if (!Number.isSafeInteger(grams) || grams > 10_000_000) {
      throw new TypeError(`第 ${position} 项的重量超出可记录范围（最多 10,000 kg）。`);
    }

    const quantity = match[2] === undefined ? defaultQuantity : Number(match[2]);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000) {
      throw new TypeError(`第 ${position} 项的数量必须是 1 到 1000 的整数；不会把 0 自动改成 1。`);
    }

    const duplicatePosition = seen.get(grams);
    if (duplicatePosition !== undefined) {
      throw new TypeError(`第 ${position} 项与第 ${duplicatePosition} 项是同一重量；请只写一次，并填写这个重量的实际总数量。`);
    }
    seen.set(grams, position);
    return {
      load_grams: grams,
      quantity,
      label: `${match[1]} ${unit}`,
      available: true,
    };
  });
  return parsed.sort((left, right) => left.load_grams - right.load_grams);
}

export function EquipmentForm({
  venueId,
  equipment,
  loads,
  unit,
  onClose,
  onSave,
  onBusyChange,
}: {
  venueId: string;
  equipment?: FitnessEquipment | null;
  loads: readonly FitnessEquipmentLoad[];
  unit: "kg" | "lb";
  onClose: () => void;
  onSave: (input: SaveEquipmentInput) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const initialTemplate = EQUIPMENT_TEMPLATES.find((entry) => entry.kind === equipment?.kind) ?? EQUIPMENT_TEMPLATES[0];
  const [templateKind, setTemplateKind] = useState<EquipmentKind>(initialTemplate.kind);
  const [identityDraft, setIdentityDraft] = useState(() => createEquipmentIdentityDraft(
    equipment,
    initialTemplate.suggestedName,
    suggestedEquipmentQuantity(initialTemplate.kind),
  ));
  const { busy, beginBusy } = useReportedFormBusy(onBusyChange);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const loadInput = useRef<HTMLTextAreaElement>(null);
  const template = EQUIPMENT_TEMPLATES.find((entry) => entry.kind === templateKind)!;
  const loadNeedsLiteralUnit = templateKind === "bands" || templateKind === "cable" || templateKind === "fixed_machine";
  const clearLoadError = () => {
    if (!loadError) return;
    setError((current) => clearOwnedFormError(current, loadError));
    setLoadError("");
  };
  const loadText = loads.map((load) => {
    const value = unit === "kg" ? load.load_grams / 1_000 : load.load_grams / 453.59237;
    return `${Number(value.toFixed(2))}×${load.quantity}`;
  }).join(", ");
  return <form className="sl-form" onSubmit={(event) => {
    const data = submitValues(event);
    const quantity = Number(data.get("quantity") ?? 1);
    let parsedLoads: ReturnType<typeof parseEquipmentLoadText>;
    try {
      parsedLoads = parseEquipmentLoadText(
        String(data.get("loads") ?? ""),
        unit,
        templateKind === "dumbbell" || templateKind === "plates" ? 2 : quantity,
      );
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "器材档位无法识别";
      setLoadError(message);
      setError(message);
      loadInput.current?.focus();
      return;
    }
    const input: SaveEquipmentInput = {
      id: equipment?.id,
      venue_id: venueId,
      name: String(data.get("name") ?? "").trim(),
      kind: templateKind,
      area: String(data.get("area") ?? "").trim(),
      quantity,
      status: String(data.get("status") ?? "available") as FitnessEquipment["status"],
      load_mode: template.loadMode,
      load_semantics: template.loadSemantics,
      min_load_grams: parsedLoads.at(0)?.load_grams ?? null,
      max_load_grams: parsedLoads.at(-1)?.load_grams ?? null,
      increment_grams: null,
      bar_weight_grams: templateKind === "barbell" || templateKind === "smith_machine"
        ? Math.round(Number(data.get("barWeight") || 0) * (unit === "kg" ? 1_000 : 453.59237)) || null
        : null,
      unilateral: data.get("unilateral") === "on",
      busy_level: String(data.get("busyLevel") ?? "unknown") as FitnessEquipment["busy_level"],
      settings: {},
      attachments: String(data.get("attachments") ?? "").split(/[,，]+/).map((value) => value.trim()).filter(Boolean),
      notes: String(data.get("notes") ?? "").trim(),
      loads: parsedLoads,
    };
    setLoadError("");
    setError("");
    void runReportedFormPersistence(beginBusy, () => onSave(input), setError, "器材没有保存");
  }}>
    <fieldset className="sl-template-picker"><legend>器材类型</legend>{EQUIPMENT_TEMPLATES.map((entry) => <button type="button" aria-pressed={templateKind === entry.kind} className={templateKind === entry.kind ? "active" : ""} key={entry.kind} onClick={() => { clearLoadError(); setTemplateKind(entry.kind); setIdentityDraft((current) => applyEquipmentTemplateSuggestion(current, entry.suggestedName, suggestedEquipmentQuantity(entry.kind))); }}><i>{entry.label.slice(0, 1)}</i><span>{entry.label}</span></button>)}</fieldset>
    <p className="sl-form-hint">{templateKind === "bands"
      ? "轻 / 中 / 重和阻力范围都是相对信息，适练不会把它们伪装成公斤；请写进下方备注。只有包装明确标注单一阻力值时才录入数字档位。"
      : templateKind === "cable" || templateKind === "fixed_machine"
        ? "面板若只写 1 / 2 / 3 等无单位数字，它们不是公斤；请写进下方备注。只有面板明确标注重量单位时才录入数字档位。"
        : template.hint}</p>
    <div className="sl-field-grid"><label><span>器材名称</span><input required name="name" value={identityDraft.name} onChange={(event) => setIdentityDraft((current) => updateEquipmentIdentityDraft(current, "name", event.target.value))} /></label><label><span>数量</span><input required name="quantity" type="number" min="1" max="1000" value={identityDraft.quantity} onChange={(event) => setIdentityDraft((current) => updateEquipmentIdentityDraft(current, "quantity", event.target.value))} /></label></div>
    <div className="sl-field-grid"><label><span>所在区域</span><input name="area" defaultValue={equipment?.area} placeholder="自由重量区" /></label><label><span>现在的状态</span><select name="status" defaultValue={equipment?.status ?? "available"}><option value="available">可用</option><option value="limited">部分可用</option><option value="maintenance">临时停用</option><option value="removed">这里已没有</option></select></label></div>
    {template.asksForDiscreteLoads && <label><span>{loadNeedsLiteralUnit ? `明确标有 ${unit} 的档位与数量` : `实际档位与数量（${unit}）`}</span><textarea ref={loadInput} name="loads" defaultValue={loadText} aria-invalid={loadError ? true : undefined} aria-describedby={loadError ? "sl-equipment-load-help sl-equipment-load-error" : "sl-equipment-load-help"} onChange={clearLoadError} placeholder={templateKind === "plates" ? "1.25×4, 2.5×4, 5×4, 10×2" : templateKind === "bands" ? `包装明确标有单一 ${unit} 值时，例如：5×1, 10×1` : "5×2, 7.5×2, 10×2"}/><small id="sl-equipment-load-help">{loadNeedsLiteralUnit ? `只填写器材明确标成 ${unit} 的数字；“轻 / 中 / 重”、阻力范围或无单位面板数字请留空，并写进备注。` : "写成“重量×实际数量”。不在这里的重量不会进入确定计划。"}</small></label>}
    {(templateKind === "barbell" || templateKind === "smith_machine") && <label><span>空杆 / 机器杆重（{unit}，未知可留空）</span><input name="barWeight" type="number" min="0" step="0.01" defaultValue={equipment?.bar_weight_grams ? Number((equipment.bar_weight_grams / (unit === "kg" ? 1_000 : 453.59237)).toFixed(2)) : ""} /></label>}
    <div className="sl-field-grid"><label><span>常见占用情况</span><select name="busyLevel" defaultValue={equipment?.busy_level ?? "unknown"}><option value="unknown">还不知道</option><option value="low">通常容易用到</option><option value="medium">有时需要等</option><option value="high">经常需要替代</option></select></label><label><span>附件（逗号分隔）</span><input name="attachments" defaultValue={equipment?.attachments.join(", ")} placeholder="绳索, V把" /></label></div>
    <label className="sl-inline-check"><input name="unilateral" type="checkbox" defaultChecked={equipment?.unilateral} /><span>左右侧可独立训练</span></label>
    <label><span>个人设置与现场备注</span><textarea name="notes" defaultValue={equipment?.notes} placeholder="座椅 4 档；把手在肩下；面板数字不等于真实公斤" /></label>
    {error && <p id={loadError ? "sl-equipment-load-error" : undefined} className="sl-form-error" role="alert">{error}</p>}
    <FormBusyStatus busy={busy} />
    <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="sl-primary" disabled={busy}>{busy ? "正在保存…" : "保存器材"}</button></footer>
  </form>;
}

const goalOptions: Array<[FitnessGoal, string]> = [
  ["strength", "力量"], ["muscle", "增肌"], ["cardio", "心肺"],
  ["general_health", "一般健康"], ["sport", "运动专项"], ["mobility", "活动度"],
];
const weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function ProfileForm({
  profile,
  onClose,
  onSave,
  onBusyChange,
}: {
  profile: FitnessProfile | null;
  onClose: () => void;
  onSave: (input: SaveFitnessProfileInput) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [goals, setGoals] = useState<FitnessGoal[]>(profile ? [...profile.goals] : ["general_health"]);
  const [days, setDays] = useState<number[]>(profile ? [...profile.preferred_weekdays] : [1, 3, 5]);
  const { busy, beginBusy } = useReportedFormBusy(onBusyChange);
  const [error, setError] = useState("");
  return <form className="sl-form" onSubmit={(event) => {
    const data = submitValues(event);
    const input: SaveFitnessProfileInput = {
      goals,
      experience: String(data.get("experience") ?? "new") as FitnessProfile["experience"],
      resistance_days_per_week: Number(data.get("resistanceDays") ?? 3),
      cardio_days_per_week: Number(data.get("cardioDays") ?? 1),
      session_minutes: Number(data.get("minutes") ?? 60),
      split: String(data.get("split") ?? "auto") as FitnessProfile["split"],
      preferred_weekdays: days,
      preferred_rir: Number(data.get("rir") ?? 3),
      rest_seconds: Number(data.get("rest") ?? 90),
      unit: String(data.get("unit") ?? "kg") as FitnessProfile["unit"],
      notes: String(data.get("notes") ?? "").trim(),
    };
    setError("");
    void runReportedFormPersistence(beginBusy, () => onSave(input), setError, "偏好没有保存");
  }}>
    <fieldset className="sl-chip-picker"><legend>这段时间更在意什么？</legend>{goalOptions.map(([id, label]) => <button type="button" aria-pressed={goals.includes(id)} className={goals.includes(id) ? "active" : ""} key={id} onClick={() => setGoals((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id])}>{label}</button>)}</fieldset>
    <div className="sl-field-grid"><label><span>训练经验</span><select name="experience" defaultValue={profile?.experience ?? "new"}><option value="new">刚开始</option><option value="returning">重新开始</option><option value="consistent">有稳定训练经验</option><option value="advanced">熟悉自主规划</option></select></label><label><span>分化偏好</span><select name="split" defaultValue={profile?.split ?? "auto"}><option value="auto">根据频次给出候选</option><option value="full_body">全身</option><option value="upper_lower">上下肢</option><option value="push_pull_legs">推拉腿</option><option value="custom">自定义</option></select></label></div>
    <div className="sl-field-grid thirds"><label><span>每周力量</span><div className="sl-input-unit"><input name="resistanceDays" type="number" min="0" max="7" defaultValue={profile?.resistance_days_per_week ?? 3}/><b>次</b></div></label><label><span>每周有氧</span><div className="sl-input-unit"><input name="cardioDays" type="number" min="0" max="7" defaultValue={profile?.cardio_days_per_week ?? 1}/><b>次</b></div></label><label><span>单次时间</span><div className="sl-input-unit"><input name="minutes" type="number" min="10" max="240" defaultValue={profile?.session_minutes ?? 60}/><b>分</b></div></label></div>
    <fieldset className="sl-chip-picker"><legend>通常方便训练的星期</legend>{weekdayNames.map((label, index) => <button type="button" aria-pressed={days.includes(index)} className={days.includes(index) ? "active" : ""} key={label} onClick={() => setDays((current) => current.includes(index) ? current.filter((entry) => entry !== index) : [...current, index].sort())}>{label}</button>)}</fieldset>
    <div className="sl-field-grid thirds"><label><span>默认保留余力</span><div className="sl-input-unit"><input name="rir" type="number" min="0" max="5" defaultValue={profile?.preferred_rir ?? 3}/><b>RIR</b></div></label><label><span>默认组间休息</span><div className="sl-input-unit"><input name="rest" type="number" min="15" max="600" defaultValue={profile?.rest_seconds ?? 90}/><b>秒</b></div></label><label><span>重量单位</span><select name="unit" defaultValue={profile?.unit ?? "kg"}><option value="kg">kg</option><option value="lb">lb</option></select></label></div>
    <label><span>动作偏好或其他边界（可选）</span><textarea name="notes" defaultValue={profile?.notes} placeholder="例如：不喜欢跳跃；热身希望保留 8 分钟。这里不会自动发给 AI。" /></label>
    <p className="sl-safety-copy">身体不适、伤病和专业建议请在“身体边界”单独记录。适练不会诊断，也不会把空值当作没有限制。</p>
    {error && <p className="sl-form-error" role="alert">{error}</p>}
    <FormBusyStatus busy={busy} />
    <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="sl-primary" disabled={busy}>{busy ? "正在保存…" : "保存偏好"}</button></footer>
  </form>;
}

export function ConstraintForm({
  constraint,
  onClose,
  onSave,
  onBusyChange,
}: {
  constraint?: FitnessConstraint | null;
  onClose: () => void;
  onSave: (input: SaveConstraintInput) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [patterns, setPatterns] = useState<MovementPattern[]>(constraint ? [...constraint.movement_patterns] : []);
  const { busy, beginBusy } = useReportedFormBusy(onBusyChange);
  const [error, setError] = useState("");
  const [scopeError, setScopeError] = useState("");
  const firstPattern = useRef<HTMLButtonElement>(null);
  const patternOptions = useMemo(() => Object.entries(MOVEMENT_PATTERN_LABELS) as Array<[MovementPattern, string]>, []);
  const clearScopeError = () => {
    if (!scopeError) return;
    setError((current) => clearOwnedFormError(current, scopeError));
    setScopeError("");
  };
  return <form className="sl-form" onSubmit={(event) => {
    const data = submitValues(event);
    if (isActiveConstraintScopeMissing(
      constraint?.active ?? true,
      patterns.length,
      constraint?.exercise_ids.length ?? 0,
    )) {
      const message = "请至少选择一个受影响的动作模式；未知范围不会被保存成“全部训练”。";
      setScopeError(message);
      setError(message);
      firstPattern.current?.focus();
      return;
    }
    const input: SaveConstraintInput = {
      id: constraint?.id,
      label: String(data.get("label") ?? "").trim(),
      body_area: String(data.get("bodyArea") ?? "").trim(),
      severity: String(data.get("severity") ?? "monitor") as FitnessConstraint["severity"],
      movement_patterns: patterns,
      exercise_ids: constraint?.exercise_ids ?? [],
      note: String(data.get("note") ?? "").trim(),
      active: constraint?.active ?? true,
    };
    setScopeError("");
    setError("");
    void runReportedFormPersistence(beginBusy, () => onSave(input), setError, "身体边界没有保存");
  }}>
    <p className="sl-safety-copy strong">这里记录的是你的描述与专业人员建议，不是系统诊断。出现疼痛或异常不适时，先停止相关动作并寻求合格专业人士意见。</p>
    <div className="sl-field-grid"><label><span>怎样称呼这条边界</span><input required name="label" defaultValue={constraint?.label} placeholder="例如：右膝深屈时不舒服" /></label><label><span>身体部位（可选）</span><input name="bodyArea" defaultValue={constraint?.body_area} placeholder="右膝" /></label></div>
    <label><span>规划时如何处理</span><select name="severity" defaultValue={constraint?.severity ?? "monitor"}><option value="monitor">只提醒我留意</option><option value="modify">需要调整动作或幅度</option><option value="avoid">不要安排这些模式</option></select></label>
    <fieldset className="sl-chip-picker compact" aria-invalid={scopeError ? true : undefined} aria-describedby={scopeError ? "sl-constraint-scope-error" : undefined}><legend>影响哪些动作模式？（生效中至少一项）</legend>{patternOptions.map(([id, label], index) => <button ref={index === 0 ? firstPattern : undefined} type="button" aria-pressed={patterns.includes(id)} className={patterns.includes(id) ? "active" : ""} key={id} onClick={() => { clearScopeError(); setPatterns((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]); }}>{label}</button>)}</fieldset>
    <label><span>具体说明或专业建议（可选）</span><textarea name="note" defaultValue={constraint?.note} placeholder="例如：康复师建议暂时避免负重深屈；复查日期由我自己决定" /></label>
    {error && <p id={scopeError ? "sl-constraint-scope-error" : undefined} className="sl-form-error" role="alert">{error}</p>}
    <FormBusyStatus busy={busy} />
    <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="sl-primary" disabled={busy}>{busy ? "正在保存…" : "保存身体边界"}</button></footer>
  </form>;
}

export function EquipmentRequirementList({ kinds }: { kinds: readonly EquipmentKind[] }) {
  return <span>{kinds.length ? kinds.map((kind) => EQUIPMENT_KIND_LABELS[kind]).join(" + ") : "自重"}</span>;
}
