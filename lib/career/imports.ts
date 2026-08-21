import { localDb } from "@/lib/local-db/client";
import type { SqlStatement } from "@/lib/local-db/types";
import { withCareerReadLock, withCareerWriteLock } from "./lock";

const DB = "career" as const;
const IMPORT_VERSION = 1 as const;
const IMPORT_KIND = "career-job-import-preview" as const;
const PENDING_SOURCE = "待确认来源" as const;
const NEUTRAL_STAGE_ID = "stage_saved" as const;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IMPORT_OPERATION_PATTERN = /^import_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const MAX_IMPORT_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_CSV_LOGICAL_RECORDS = 2_001;
const MAX_CSV_COLUMNS = 200;
const MAX_CSV_CELL_CHARACTERS = 200_000;
const MAX_STRUCTURED_LIST_ITEMS = 200;
const MAX_STRUCTURED_LIST_ITEM_CHARACTERS = 2_000;
const MAX_PREVIEW_WARNINGS = 200;
const MAX_WARNING_CHARACTERS = 500;
const MAX_WARNING_TOTAL_CHARACTERS = 50_000;
const MAX_SHORT_TEXT_CHARACTERS = 4_000;

const CANDIDATE_FIELDS = [
  "company",
  "role",
  "location",
  "source",
  "sourceUrl",
  "stageId",
  "salary",
  "workMode",
  "description",
  "tags",
] as const;

export type CareerImportCandidateField = typeof CANDIDATE_FIELDS[number];
export type CareerImportConfidenceLevel = "high" | "medium" | "low" | "unknown";
export type CareerImportWarningSeverity = "review" | "blocking";

export type CareerImportWarningCode =
  | "missing_required"
  | "unknown_source"
  | "unknown_stage"
  | "unsafe_url"
  | "field_too_long"
  | "parser_notice"
  | "csv_empty"
  | "csv_malformed"
  | "csv_missing_header"
  | "csv_unknown_header"
  | "csv_duplicate_header"
  | "csv_column_mismatch"
  | "csv_empty_row"
  | "csv_duplicate_row";

export type CareerImportWarning = Readonly<{
  code: CareerImportWarningCode;
  severity: CareerImportWarningSeverity;
  message: string;
  field?: CareerImportCandidateField;
  rowNumber?: number;
  duplicateOfRowNumber?: number;
}>;

export type CareerImportCandidate = Readonly<{
  company: string;
  role: string;
  location: string;
  source: string;
  sourceUrl: string;
  stageId: string;
  priority: number;
  salary: string;
  workMode: string;
  description: string;
  tags: string;
}>;

export type CareerImportConfidence = Readonly<{
  overall: CareerImportConfidenceLevel;
  fields: Readonly<Record<CareerImportCandidateField, CareerImportConfidenceLevel>>;
}>;

export type CareerJobImportPreview = Readonly<{
  version: typeof IMPORT_VERSION;
  kind: typeof IMPORT_KIND;
  sourceFingerprint: string;
  previewFingerprint: string;
  importOperationId: string;
  jobId: string;
  activityId: string;
  createdAt: string;
  candidate: CareerImportCandidate;
  warnings: readonly CareerImportWarning[];
  confidence: CareerImportConfidence;
  /** The first physical line occupied by this logical CSV record. */
  rowNumber?: number;
  /** Present when an identical CSV record intentionally shares the first row's operation. */
  duplicateOfRowNumber?: number;
}>;

export type CareerCsvImportPreview = Readonly<{
  version: typeof IMPORT_VERSION;
  kind: "career-csv-import-preview";
  sourceFingerprint: string;
  headers: readonly string[];
  rows: readonly CareerJobImportPreview[];
  warnings: readonly CareerImportWarning[];
}>;

export type CareerImportErrorCode =
  | "source_changed"
  | "preview_changed"
  | "invalid_preview"
  | "operation_conflict"
  | "stage_unavailable"
  | "commit_uncertain"
  | "write_failed";

export class CareerImportError extends Error {
  readonly name: string = "CareerImportError";

  constructor(
    readonly code: CareerImportErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type CareerImportCommitIdentity = Readonly<{
  importOperationId: string;
  jobId: string;
  activityId: string;
  previewFingerprint: string;
}>;

export class CareerImportCommitUncertainError extends CareerImportError {
  readonly name = "CareerImportCommitUncertainError";

  constructor(readonly identities: readonly CareerImportCommitIdentity[]) {
    super(
      "commit_uncertain",
      "本机是否完成写入暂时无法确认。请只检查记录并继续使用同一份预览，不要再次新建。",
    );
  }
}

export type CareerImportCommitInspection = Readonly<{
  status: "exact_committed" | "absent" | "conflict" | "still_unknown";
  importOperationId: string;
  jobId: string;
  activityId: string;
  previewFingerprint: string;
}>;

export type CreateCareerJobImportPreviewInput = Readonly<{
  sourceText: string;
  parsedCandidate: Readonly<Record<string, unknown>>;
  /** Reuse this only for an intentional retry or revision of the same import. */
  importOperationId?: string;
  now?: string;
  rowNumber?: number;
}>;

export type CareerImportPreviewPatch = Partial<CareerImportCandidate>;

export type CareerImportCommitItem = Readonly<{
  preview: CareerJobImportPreview;
  /** Re-fingerprint the textarea/file that is visible at the moment of commit. */
  currentSourceFingerprint: string;
}>;

export type CareerImportCommitItemResult = Readonly<{
  committed: true;
  status: "committed" | "already_committed";
  importOperationId: string;
  jobId: string;
  activityId: string;
  previewFingerprint: string;
  storedAt: string;
}>;

export type CareerImportCommitManyResult = Readonly<{
  committed: true;
  writePerformed: boolean;
  writtenCount: number;
  uniqueCount: number;
  results: readonly CareerImportCommitItemResult[];
}>;

type NormalizedCandidate = Readonly<{
  candidate: CareerImportCandidate;
  warnings: readonly CareerImportWarning[];
  confidence: CareerImportConfidence;
}>;

type ExistingJobRow = Readonly<{
  id: string;
  company: string;
  role: string;
  location: string;
  source: string;
  source_url: string;
  stage_id: string;
  priority: number;
  salary: string;
  work_mode: string;
  description: string;
  applied_at: string | null;
  deadline: string | null;
  contact_name: string;
  note: string;
  tags: string;
  created_at: string;
  updated_at: string;
  archived: number;
  position: number;
  archived_at: string | null;
  ended_at: string | null;
  archived_operation_id: string | null;
  ended_operation_id: string | null;
}>;

type ExistingActivityRow = Readonly<{
  id: string;
  job_id: string | null;
  type: string;
  detail: string;
  created_at: string;
}>;

type CsvRecord = Readonly<{
  cells: readonly string[];
  rowNumber: number;
  endRowNumber: number;
  warnings: readonly CareerImportWarning[];
}>;

const TEXT_LIMITS: Readonly<Record<Exclude<CareerImportCandidateField, "stageId">, number>> = {
  company: 500,
  role: 500,
  location: 500,
  source: 120,
  sourceUrl: 4_000,
  salary: 500,
  workMode: 120,
  description: 200_000,
  tags: 4_000,
};

const SOURCE_ALIASES = new Map<string, string>([
  ["linkedin", "LinkedIn"],
  ["领英", "LinkedIn"],
  ["boss", "BOSS直聘"],
  ["boss直聘", "BOSS直聘"],
  ["zhipin", "BOSS直聘"],
  ["zhipin.com", "BOSS直聘"],
  ["官网", "官网"],
  ["company website", "官网"],
  ["website", "官网"],
  ["内推", "内推"],
  ["referral", "内推"],
  ["猎头", "猎头"],
  ["recruiter", "猎头"],
  ["招聘会", "招聘会"],
  ["career fair", "招聘会"],
  ["其他", "其他来源"],
  ["其他来源", "其他来源"],
  [PENDING_SOURCE.toLowerCase(), PENDING_SOURCE],
]);

const STAGE_ALIASES = new Map<string, string>([
  ["stage_saved", "stage_saved"],
  ["saved", "stage_saved"],
  ["收藏", "stage_saved"],
  ["stage_preparing", "stage_preparing"],
  ["preparing", "stage_preparing"],
  ["准备", "stage_preparing"],
  ["准备中", "stage_preparing"],
  ["stage_applied", "stage_applied"],
  ["applied", "stage_applied"],
  ["已申请", "stage_applied"],
  ["已投递", "stage_applied"],
  ["stage_assessment", "stage_assessment"],
  ["assessment", "stage_assessment"],
  ["测评", "stage_assessment"],
  ["笔试", "stage_assessment"],
  ["笔试 / 测评", "stage_assessment"],
  ["stage_interview", "stage_interview"],
  ["interview", "stage_interview"],
  ["面试", "stage_interview"],
  ["面试中", "stage_interview"],
  ["stage_offer", "stage_offer"],
  ["offer", "stage_offer"],
  ["stage_accepted", "stage_accepted"],
  ["accepted", "stage_accepted"],
  ["已接受", "stage_accepted"],
  ["stage_rejected", "stage_rejected"],
  ["rejected", "stage_rejected"],
  ["未通过", "stage_rejected"],
  ["stage_withdrawn", "stage_withdrawn"],
  ["withdrawn", "stage_withdrawn"],
  ["已撤回", "stage_withdrawn"],
]);

const HEADER_ALIASES: Readonly<Record<string, CareerImportCandidateField>> = {
  company: "company",
  "company name": "company",
  公司: "company",
  公司名称: "company",
  title: "role",
  role: "role",
  position: "role",
  职位: "role",
  职位名称: "role",
  岗位: "role",
  location: "location",
  地点: "location",
  工作地点: "location",
  source: "source",
  platform: "source",
  来源: "source",
  平台: "source",
  url: "sourceUrl",
  link: "sourceUrl",
  "job url": "sourceUrl",
  source_url: "sourceUrl",
  链接: "sourceUrl",
  职位链接: "sourceUrl",
  stage: "stageId",
  status: "stageId",
  stage_id: "stageId",
  阶段: "stageId",
  状态: "stageId",
  salary: "salary",
  compensation: "salary",
  薪资: "salary",
  薪酬: "salary",
  "work mode": "workMode",
  work_mode: "workMode",
  工作方式: "workMode",
  description: "description",
  "job description": "description",
  jd: "description",
  描述: "description",
  职位描述: "description",
  tags: "tags",
  keywords: "tags",
  标签: "tags",
  关键词: "tags",
};

function importError(code: CareerImportErrorCode, message: string): CareerImportError {
  return new CareerImportError(code, message);
}

function rawStringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function isInvisibleControl(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/** Short fields are single-line UI labels; invisible distinctions are removed. */
function stringValue(value: unknown): string {
  const raw = rawStringValue(value);
  if (raw.length > MAX_SHORT_TEXT_CHARACTERS) {
    throw importError("invalid_preview", "导入短文本过长，请精简后重新预览");
  }
  return Array.from(raw, (character) => isInvisibleControl(character) ? " " : character)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Descriptions preserve paragraphs and tabs, but never NUL or other C0/C1 controls. */
function longTextValue(value: unknown): string {
  const raw = rawStringValue(value);
  if (raw.length > MAX_CSV_CELL_CHARACTERS) {
    throw importError("invalid_preview", "职位描述过长，请精简后重新预览");
  }
  return Array.from(raw.replace(/\r\n?/g, "\n"), (character) =>
    isInvisibleControl(character) && character !== "\n" && character !== "\t"
      ? ""
      : character)
    .join("")
    .trim();
}

function valueFrom(record: Readonly<Record<string, unknown>>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function boundedStringList(
  value: unknown,
  label: string,
  options: Readonly<{ maxItems?: number; maxItemCharacters?: number }> = {},
): string[] {
  const maxItems = options.maxItems ?? MAX_STRUCTURED_LIST_ITEMS;
  const maxItemCharacters = options.maxItemCharacters ?? MAX_STRUCTURED_LIST_ITEM_CHARACTERS;
  if (Array.isArray(value) && value.length > maxItems) {
    throw importError("invalid_preview", `${label}内容过多，请精简后重新预览`);
  }
  if (typeof value === "string" &&
    value.length > maxItems * (maxItemCharacters + 1)) {
    throw importError("invalid_preview", `${label}内容过多，请精简后重新预览`);
  }
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，\n]/)
      : [];
  if (rawItems.length > maxItems) {
    throw importError("invalid_preview", `${label}内容过多，请精简后重新预览`);
  }
  const result: string[] = [];
  for (const rawItem of rawItems) {
    const item = stringValue(rawItem);
    if (item.length > maxItemCharacters) {
      throw importError("invalid_preview", `${label}内容过多，请精简后重新预览`);
    }
    if (item) result.push(item);
  }
  return result;
}

function normalizeSalary(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return stringValue(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const salary = value as Readonly<Record<string, unknown>>;
  if (typeof salary.raw === "string" && salary.raw.trim()) return salary.raw.trim();
  const minimum = typeof salary.min === "number" && Number.isFinite(salary.min)
    ? salary.min
    : null;
  const maximum = typeof salary.max === "number" && Number.isFinite(salary.max)
    ? salary.max
    : null;
  if (minimum === null && maximum === null) return "";
  const currency = stringValue(salary.currency).toUpperCase();
  const currencyLabel = currency === "CNY"
    ? "¥"
    : currency === "USD"
      ? "$"
      : currency === "SGD"
        ? "S$"
        : currency
          ? `${currency} `
          : "";
  const compact = (amount: number) =>
    amount >= 1_000 && amount % 1_000 === 0 ? `${amount / 1_000}K` : String(amount);
  const range = minimum !== null && maximum !== null
    ? `${compact(minimum)}–${compact(maximum)}`
    : minimum !== null
      ? `${compact(minimum)} 起`
      : `最高 ${compact(maximum!)}`;
  const period = salary.period === "month"
    ? " / 月"
    : salary.period === "year"
      ? " / 年"
      : salary.period === "day"
        ? " / 天"
        : salary.period === "hour"
          ? " / 小时"
          : "";
  const months = typeof salary.months === "number" && salary.months !== 12
    ? ` · ${salary.months} 薪`
    : "";
  return `${currencyLabel}${range}${period}${months}`;
}

function normalizeWorkMode(value: unknown): string {
  const raw = stringValue(value);
  const normalized = raw.toLowerCase();
  if (["remote", "远程"].includes(normalized)) return "远程";
  if (["hybrid", "混合", "混合办公"].includes(normalized)) return "混合办公";
  if (["onsite", "on-site", "on site", "现场", "现场办公"].includes(normalized)) {
    return "现场办公";
  }
  return raw;
}

function normalizeConfidenceLevel(value: unknown): CareerImportConfidenceLevel {
  const normalized = stringValue(value).toLowerCase();
  if (["high", "高", "confident"].includes(normalized)) return "high";
  if (["medium", "中", "moderate"].includes(normalized)) return "medium";
  if (["low", "低", "uncertain"].includes(normalized)) return "low";
  return "unknown";
}

function standaloneHttpUrl(sourceText: string): string {
  const candidate = sourceText.trim();
  return /^https?:\/\/[^\s<>"']+$/i.test(candidate)
    ? candidate.replace(/[),，。；;]+$/, "")
    : "";
}

function validHttpUrl(value: string): boolean {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function sourceFromUrl(value: string): string | null {
  if (!value) return null;
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
    if (hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")) return "LinkedIn";
    if (hostname === "zhipin.com" || hostname.endsWith(".zhipin.com")) return "BOSS直聘";
  } catch {
    // URL validity is reported separately; it never becomes a source hint.
  }
  return null;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw importError("invalid_preview", `${label}无效，请重新预览`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw importError("invalid_preview", `${label}无效，请重新预览`);
  }
  return new Date(milliseconds).toISOString();
}

function timestampOrNow(value: unknown): string {
  return value === undefined
    ? new Date().toISOString()
    : canonicalTimestamp(value, "预览时间");
}

function normalizeOperationId(value: unknown): string {
  const operationId = value === undefined
    ? `import_${crypto.randomUUID()}`
    : stringValue(value);
  if (!IMPORT_OPERATION_PATTERN.test(operationId)) {
    throw importError("invalid_preview", "导入操作标识无效，请重新预览");
  }
  return operationId.toLowerCase();
}

function identityForOperation(importOperationIdInput: unknown) {
  const importOperationId = normalizeOperationId(importOperationIdInput);
  const match = IMPORT_OPERATION_PATTERN.exec(importOperationId)!;
  const suffix = match[1].toLowerCase();
  return {
    importOperationId,
    jobId: `job_${suffix}`,
    activityId: `activity_${suffix}`,
  } as const;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
    case "bigint":
      return JSON.stringify(value.toString());
    case "undefined":
      return "null";
    case "object": {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(",")}}`;
    }
    default:
      return JSON.stringify(String(value));
  }
}

async function sha256(namespace: string, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(`${namespace}\n${canonicalJson(value)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function assertCareerImportSourceSize(source: string): void {
  const sourceBytes = new TextEncoder().encode(source);
  if (sourceBytes.byteLength > MAX_IMPORT_SOURCE_BYTES) {
    throw importError("invalid_preview", "导入内容超过 16 MiB，请缩小文件后重新预览");
  }
}

export async function fingerprintCareerImportSource(source: string): Promise<string> {
  if (typeof source !== "string") {
    throw importError("invalid_preview", "导入原文无效，请重新选择或粘贴");
  }
  assertCareerImportSourceSize(source);
  return sha256("private-ai-suite:career-import-source:v1", source);
}

function descriptionFrom(record: Readonly<Record<string, unknown>>): string {
  const direct = longTextValue(valueFrom(record, ["description", "job_description"]));
  if (direct) return direct;
  const summary = stringValue(record.summary);
  const responsibilities = boundedStringList(record.responsibilities, "职位职责");
  const mustHave = boundedStringList(
    valueFrom(record, ["must_have", "requirements"]),
    "必需条件",
  );
  const niceToHave = boundedStringList(record.nice_to_have, "加分条件");
  return [
    summary,
    responsibilities.length
      ? `职位职责\n${responsibilities.map((item) => `• ${item}`).join("\n")}`
      : "",
    mustHave.length
      ? `必需条件\n${mustHave.map((item) => `• ${item}`).join("\n")}`
      : "",
    niceToHave.length
      ? `加分项\n${niceToHave.map((item) => `• ${item}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n\n");
}

function normalizeCandidate(
  parsed: Readonly<Record<string, unknown>>,
  sourceText: string,
  mode: "parsed" | "direct" = "parsed",
): NormalizedCandidate {
  const warnings: CareerImportWarning[] = [];
  const company = stringValue(valueFrom(parsed, ["company", "company_name"]));
  const role = stringValue(valueFrom(parsed, ["role", "title", "position"]));
  const location = stringValue(parsed.location);
  const sourceUrlRaw = stringValue(valueFrom(parsed, ["sourceUrl", "source_url", "url", "original_url"])) ||
    standaloneHttpUrl(sourceText);
  const sourceRaw = stringValue(valueFrom(parsed, ["source", "platform"]));
  const sourceAlias = sourceRaw ? SOURCE_ALIASES.get(sourceRaw.toLowerCase()) : null;
  const detectedSource = sourceRaw ? null : sourceFromUrl(sourceUrlRaw);
  let source = sourceAlias ?? detectedSource ?? PENDING_SOURCE;
  if (sourceRaw && !sourceAlias) {
    source = PENDING_SOURCE;
    warnings.push({
      code: "unknown_source",
      severity: "review",
      field: "source",
      message: `没有识别来源“${sourceRaw.slice(0, 120)}”，保存时会标为“${PENDING_SOURCE}”。`,
    });
  } else if (!sourceRaw && !detectedSource) {
    warnings.push({
      code: "unknown_source",
      severity: "review",
      field: "source",
      message: `原文没有可确认的来源，保存时会标为“${PENDING_SOURCE}”。`,
    });
  }

  const stageRaw = stringValue(valueFrom(parsed, ["stageId", "stage_id", "stage", "status"]));
  const stageAlias = stageRaw ? STAGE_ALIASES.get(stageRaw.toLowerCase()) : null;
  const stageId = stageAlias ?? NEUTRAL_STAGE_ID;
  if (stageRaw && !stageAlias) {
    warnings.push({
      code: "unknown_stage",
      severity: "review",
      field: "stageId",
      message: `没有识别阶段“${stageRaw}”，会先放在“收藏”，不代表已经投递。`,
    });
  } else if (!stageRaw) {
    warnings.push({
      code: "unknown_stage",
      severity: "review",
      field: "stageId",
      message: "原文没有阶段信息，会先放在“收藏”，不代表已经投递。",
    });
  }

  let sourceUrl = sourceUrlRaw;
  if (sourceUrl && !validHttpUrl(sourceUrl)) {
    sourceUrl = "";
    warnings.push({
      code: "unsafe_url",
      severity: "review",
      field: "sourceUrl",
      message: "原链接不是可安全打开的 HTTP(S) 地址，因此不会保存这个链接。",
    });
  }

  if (!company) {
    warnings.push({
      code: "missing_required",
      severity: "blocking",
      field: "company",
      message: "没有找到公司名称，请补充后再保存。",
    });
  }
  if (!role) {
    warnings.push({
      code: "missing_required",
      severity: "blocking",
      field: "role",
      message: "没有找到职位名称，请补充后再保存。",
    });
  }

  for (const notice of boundedStringList(parsed.warnings, "解析提示", {
    maxItems: 50,
    maxItemCharacters: MAX_WARNING_CHARACTERS,
  })) {
    warnings.push({
      code: "parser_notice",
      severity: "review",
      message: notice,
    });
  }

  const candidate: CareerImportCandidate = {
    company,
    role,
    location,
    source,
    sourceUrl,
    stageId,
    priority: Number.isInteger(parsed.priority) && Number(parsed.priority) >= 1 &&
      Number(parsed.priority) <= 3
      ? Number(parsed.priority)
      : 1,
    salary: normalizeSalary(parsed.salary),
    workMode: normalizeWorkMode(valueFrom(parsed, ["workMode", "work_mode"])),
    description: descriptionFrom(parsed),
    tags: boundedStringList(valueFrom(parsed, ["tags", "keywords"]), "关键词", {
      maxItems: 200,
      maxItemCharacters: 200,
    }).join(", "),
  };

  for (const field of CANDIDATE_FIELDS) {
    if (field === "stageId") continue;
    const limit = TEXT_LIMITS[field];
    if (candidate[field].length > limit) {
      throw importError(
        "invalid_preview",
        `${field === "description" ? "职位描述" : "导入字段"}过长，请精简后重新预览`,
      );
    }
  }

  if (warnings.length > MAX_PREVIEW_WARNINGS ||
    warnings.reduce((total, warning) => total + warning.message.length, 0) >
      MAX_WARNING_TOTAL_CHARACTERS) {
    throw importError("invalid_preview", "导入提示内容过多，请精简原文后重新预览");
  }

  const rawConfidence = valueFrom(parsed, ["field_confidence", "confidence"]);
  const confidenceRecord = rawConfidence && typeof rawConfidence === "object" &&
    !Array.isArray(rawConfidence)
    ? rawConfidence as Readonly<Record<string, unknown>>
    : {};
  const overallInput = typeof rawConfidence === "string"
    ? rawConfidence
    : valueFrom(confidenceRecord, ["overall", "level"]);
  const fields = Object.fromEntries(CANDIDATE_FIELDS.map((field) => {
    const explicit = normalizeConfidenceLevel(confidenceRecord[field]);
    const hasValue = field === "stageId" || candidate[field] !== "";
    const fallback: CareerImportConfidenceLevel = mode === "direct" && hasValue
      ? "high"
      : "unknown";
    return [field, explicit === "unknown" ? fallback : explicit];
  })) as Record<CareerImportCandidateField, CareerImportConfidenceLevel>;
  if (source === PENDING_SOURCE) fields.source = "low";
  if (!stageRaw || !stageAlias) fields.stageId = "low";
  if (!company) fields.company = "low";
  if (!role) fields.role = "low";
  const explicitOverall = normalizeConfidenceLevel(overallInput);
  const knownLevels = Object.values(fields).filter((level) => level !== "unknown");
  const overall = knownLevels.includes("low")
    ? "low"
    : knownLevels.includes("medium")
      ? "medium"
      : explicitOverall !== "unknown"
        ? explicitOverall
        : knownLevels.length > 0
          ? "high"
          : "unknown";
  return { candidate, warnings, confidence: { overall, fields } };
}

function activityDetail(candidate: CareerImportCandidate): string {
  return `导入了 ${candidate.company} · ${candidate.role}`;
}

function commitFacts(preview: Pick<
  CareerJobImportPreview,
  "sourceFingerprint" | "importOperationId" | "jobId" | "activityId" |
  "createdAt" | "candidate"
>) {
  return {
    sourceFingerprint: preview.sourceFingerprint,
    importOperationId: preview.importOperationId,
    jobId: preview.jobId,
    activityId: preview.activityId,
    createdAt: preview.createdAt,
    job: expectedJob(preview),
    activity: expectedActivity(preview),
  };
}

async function fingerprintPreview(
  preview: Omit<CareerJobImportPreview, "previewFingerprint">,
): Promise<string> {
  return sha256("private-ai-suite:career-import-preview:v1", preview);
}

async function assemblePreview(options: Readonly<{
  sourceFingerprint: string;
  importOperationId?: string;
  createdAt: string;
  normalized: NormalizedCandidate;
  rowNumber?: number;
  duplicateOfRowNumber?: number;
}>): Promise<CareerJobImportPreview> {
  const identity = identityForOperation(options.importOperationId);
  const unsigned: Omit<CareerJobImportPreview, "previewFingerprint"> = {
    version: IMPORT_VERSION,
    kind: IMPORT_KIND,
    sourceFingerprint: options.sourceFingerprint,
    ...identity,
    createdAt: options.createdAt,
    candidate: options.normalized.candidate,
    warnings: options.normalized.warnings,
    confidence: options.normalized.confidence,
    ...(options.rowNumber === undefined ? {} : { rowNumber: options.rowNumber }),
    ...(options.duplicateOfRowNumber === undefined
      ? {}
      : { duplicateOfRowNumber: options.duplicateOfRowNumber }),
  };
  return { ...unsigned, previewFingerprint: await fingerprintPreview(unsigned) };
}

export async function createCareerJobImportPreview(
  input: CreateCareerJobImportPreviewInput,
): Promise<CareerJobImportPreview> {
  if (!input || typeof input !== "object" || typeof input.sourceText !== "string" ||
    !input.parsedCandidate || typeof input.parsedCandidate !== "object" ||
    Array.isArray(input.parsedCandidate)) {
    throw importError("invalid_preview", "导入内容无效，请重新预览");
  }
  const sourceText = input.sourceText;
  assertCareerImportSourceSize(sourceText);
  const normalized = normalizeCandidate(input.parsedCandidate, sourceText);
  const importOperationId = input.importOperationId;
  const createdAt = timestampOrNow(input.now);
  const rowNumber = input.rowNumber;
  const sourceFingerprint = await fingerprintCareerImportSource(sourceText);
  return assemblePreview({
    sourceFingerprint,
    importOperationId,
    createdAt,
    normalized,
    rowNumber,
  });
}

export async function reviseCareerJobImportPreview(
  preview: CareerJobImportPreview,
  patch: CareerImportPreviewPatch,
): Promise<CareerJobImportPreview> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw importError("invalid_preview", "导入修改无效，请重新预览");
  }
  for (const key of Object.keys(patch)) {
    if (![...CANDIDATE_FIELDS, "priority"].includes(key as CareerImportCandidateField)) {
      throw importError("invalid_preview", "导入修改包含不支持的字段，请重新预览");
    }
  }
  const stablePreview = snapshotPreview(preview);
  const stablePatch = Object.freeze(Object.fromEntries(Object.keys(patch).map((key) => [
    key,
    patch[key as keyof CareerImportPreviewPatch],
  ]))) as CareerImportPreviewPatch;
  await assertPreviewIntegrity(stablePreview, false);
  const normalized = normalizeCandidate(
    { ...stablePreview.candidate, ...stablePatch },
    "",
    "direct",
  );
  const patchedFields = new Set(Object.keys(stablePatch));
  const separatesFoldedDuplicate = stablePreview.duplicateOfRowNumber !== undefined &&
    canonicalJson(normalized.candidate) !== canonicalJson(stablePreview.candidate);
  const preservedWarnings = stablePreview.warnings.filter(({ code }) =>
    code === "parser_notice" || code === "csv_malformed" ||
    code === "csv_column_mismatch" ||
    code === "csv_unknown_header" || code === "csv_duplicate_header" ||
    code === "csv_empty_row" || (code === "csv_duplicate_row" && !separatesFoldedDuplicate) ||
    (code === "unknown_source" && !patchedFields.has("source")) ||
    (code === "unknown_stage" && !patchedFields.has("stageId")) ||
    (code === "unsafe_url" && !patchedFields.has("sourceUrl")));
  const fields = { ...stablePreview.confidence.fields };
  for (const field of CANDIDATE_FIELDS) {
    if (patchedFields.has(field)) fields[field] = normalized.confidence.fields[field];
  }
  const confidence: CareerImportConfidence = {
    overall: Object.values(fields).includes("low") ? "low" : stablePreview.confidence.overall,
    fields,
  };
  return assemblePreview({
    sourceFingerprint: stablePreview.sourceFingerprint,
    importOperationId: separatesFoldedDuplicate ? undefined : stablePreview.importOperationId,
    createdAt: stablePreview.createdAt,
    normalized: {
      ...normalized,
      warnings: deduplicateWarnings([...normalized.warnings, ...preservedWarnings]),
      confidence,
    },
    rowNumber: stablePreview.rowNumber,
    duplicateOfRowNumber: separatesFoldedDuplicate
      ? undefined
      : stablePreview.duplicateOfRowNumber,
  });
}

/** Create an explicit second record from a preview that was previously folded as a duplicate. */
export async function forkCareerJobImportPreview(
  preview: CareerJobImportPreview,
  options: Readonly<{ now?: string }> = {},
): Promise<CareerJobImportPreview> {
  const stablePreview = snapshotPreview(preview);
  const createdAt = timestampOrNow(options.now);
  await assertPreviewIntegrity(stablePreview);
  return assemblePreview({
    sourceFingerprint: stablePreview.sourceFingerprint,
    createdAt,
    normalized: {
      candidate: stablePreview.candidate,
      warnings: stablePreview.warnings.filter(({ code }) => code !== "csv_duplicate_row"),
      confidence: stablePreview.confidence,
    },
    rowNumber: stablePreview.rowNumber,
  });
}

function csvWarning(
  code: CareerImportWarningCode,
  severity: CareerImportWarningSeverity,
  message: string,
  rowNumber?: number,
): CareerImportWarning {
  const cleanMessage = stringValue(message);
  const boundedMessage = cleanMessage.length > MAX_WARNING_CHARACTERS
    ? `${cleanMessage.slice(0, MAX_WARNING_CHARACTERS - 1)}…`
    : cleanMessage;
  return { code, severity, message: boundedMessage, ...(rowNumber === undefined ? {} : { rowNumber }) };
}

function parseCsvRecords(source: string): CsvRecord[] {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let justClosedQuote = false;
  let rowNumber = 1;
  let recordStart = 1;
  let recordWarnings: CareerImportWarning[] = [];

  const appendCell = (value: string) => {
    if (cell.length + value.length > MAX_CSV_CELL_CHARACTERS) {
      throw importError(
        "invalid_preview",
        "CSV 有单格内容超过 200,000 个字符，请精简文件后重新预览",
      );
    }
    cell += value;
  };

  const finishCell = () => {
    if (cells.length >= MAX_CSV_COLUMNS) {
      throw importError("invalid_preview", "CSV 超过 200 列，请精简文件后重新预览");
    }
    cells.push(cell);
    cell = "";
    justClosedQuote = false;
  };
  const finishRecord = (endRowNumber: number) => {
    if (records.length >= MAX_CSV_LOGICAL_RECORDS) {
      throw importError(
        "invalid_preview",
        "CSV 超过 2,000 条职位，请分成多个文件后重新预览",
      );
    }
    finishCell();
    records.push({
      cells,
      rowNumber: recordStart,
      endRowNumber,
      warnings: recordWarnings,
    });
    cells = [];
    recordWarnings = [];
    recordStart = endRowNumber + 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          appendCell('"');
          index += 1;
        } else {
          inQuotes = false;
          justClosedQuote = true;
        }
      } else {
        appendCell(character);
        if (character === "\n") rowNumber += 1;
        else if (character === "\r" && text[index + 1] !== "\n") rowNumber += 1;
      }
      continue;
    }

    if (character === '"') {
      if (cell.length === 0 && !justClosedQuote) {
        inQuotes = true;
      } else {
        recordWarnings.push(csvWarning(
          "csv_malformed",
          "blocking",
          "引号出现在字段中间，无法确定这一格的边界。",
          recordStart,
        ));
        appendCell(character);
      }
    } else if (character === ",") {
      finishCell();
    } else if (character === "\r" || character === "\n") {
      const isCrLf = character === "\r" && text[index + 1] === "\n";
      finishRecord(rowNumber);
      if (isCrLf) index += 1;
      rowNumber += 1;
    } else if (justClosedQuote) {
      recordWarnings.push(csvWarning(
        "csv_malformed",
        "blocking",
        "结束引号后还有无法识别的字符。",
        recordStart,
      ));
      appendCell(character);
      justClosedQuote = false;
    } else if (!justClosedQuote || character.trim() !== "") {
      appendCell(character);
    }
  }

  if (inQuotes) {
    recordWarnings.push(csvWarning(
      "csv_malformed",
      "blocking",
      "有一个引号字段没有结束，文件不会被提交。",
      recordStart,
    ));
  }
  if (cell.length > 0 || cells.length > 0 || justClosedQuote || recordWarnings.length > 0) {
    finishRecord(rowNumber);
  }
  return records;
}

function normalizedHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isEmptyRecord(record: CsvRecord): boolean {
  return record.cells.every((cell) => cell.trim() === "");
}

function candidateKey(candidate: CareerImportCandidate): string {
  return canonicalJson(candidate);
}

function deduplicateWarnings(
  warnings: readonly CareerImportWarning[],
): CareerImportWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = canonicalJson({
      code: warning.code,
      severity: warning.severity,
      message: warning.message,
      field: warning.field ?? null,
      rowNumber: warning.rowNumber ?? null,
      duplicateOfRowNumber: warning.duplicateOfRowNumber ?? null,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function parseCareerCsvImportPreview(
  csvText: string,
  options: Readonly<{ sourceHint?: string; now?: string }> = {},
): Promise<CareerCsvImportPreview> {
  if (typeof csvText !== "string") {
    throw importError("invalid_preview", "CSV 内容无效，请重新选择文件");
  }
  const sourceHint = options.sourceHint;
  const createdAt = timestampOrNow(options.now);
  const sourceFingerprint = await fingerprintCareerImportSource(csvText);
  const records = parseCsvRecords(csvText);
  const warnings: CareerImportWarning[] = [];
  const firstContentIndex = records.findIndex((record) => !isEmptyRecord(record));
  if (firstContentIndex < 0) {
    return {
      version: IMPORT_VERSION,
      kind: "career-csv-import-preview",
      sourceFingerprint,
      headers: [],
      rows: [],
      warnings: [csvWarning("csv_empty", "blocking", "CSV 没有可预览的数据。")],
    };
  }
  for (const record of records.slice(0, firstContentIndex)) {
    warnings.push(csvWarning(
      "csv_empty_row",
      "review",
      `第 ${record.rowNumber} 行为空，预览时已跳过。`,
      record.rowNumber,
    ));
  }

  const headerRecord = records[firstContentIndex];
  warnings.push(...headerRecord.warnings);
  const headers = headerRecord.cells.map((header) => {
    if (header.length > MAX_SHORT_TEXT_CHARACTERS) {
      throw importError("invalid_preview", "CSV 表头过长，请精简文件后重新预览");
    }
    return normalizedHeader(header);
  });
  const columnForField = new Map<CareerImportCandidateField, number>();
  headers.forEach((header, index) => {
    const field = Object.prototype.hasOwnProperty.call(HEADER_ALIASES, header)
      ? HEADER_ALIASES[header]
      : undefined;
    if (!field) {
      if (header) {
        warnings.push(csvWarning(
          "csv_unknown_header",
          "review",
          `列“${headerRecord.cells[index].trim()}”不会写入职位记录。`,
          headerRecord.rowNumber,
        ));
      }
      return;
    }
    if (columnForField.has(field)) {
      warnings.push(csvWarning(
        "csv_duplicate_header",
        "review",
        `列“${headerRecord.cells[index].trim()}”与前面的列含义重复，只读取第一列。`,
        headerRecord.rowNumber,
      ));
      return;
    }
    columnForField.set(field, index);
  });
  if (!columnForField.has("company")) {
    warnings.push(csvWarning(
      "csv_missing_header",
      "blocking",
      "CSV 缺少 Company / 公司列；公司名称不会被猜测。",
      headerRecord.rowNumber,
    ));
  }
  if (!columnForField.has("role")) {
    warnings.push(csvWarning(
      "csv_missing_header",
      "blocking",
      "CSV 缺少 Title / 职位列；职位名称不会被猜测。",
      headerRecord.rowNumber,
    ));
  }

  const headerBlockingWarnings = warnings.filter(({ severity }) => severity === "blocking");
  const rows: CareerJobImportPreview[] = [];
  const firstByCandidate = new Map<string, CareerJobImportPreview>();
  for (const sourceRecord of records.slice(firstContentIndex + 1)) {
    let record = sourceRecord;
    if (isEmptyRecord(record)) {
      warnings.push(csvWarning(
        "csv_empty_row",
        "review",
        `第 ${record.rowNumber} 行为空，预览时已跳过。`,
        record.rowNumber,
      ));
      continue;
    }
    if (record.cells.length !== headers.length) {
      record = {
        ...record,
        warnings: [
          ...record.warnings,
          csvWarning(
            "csv_column_mismatch",
            "blocking",
            `第 ${record.rowNumber} 行有 ${record.cells.length} 格，表头有 ${headers.length} 列；为避免错位，本行不会提交。`,
            record.rowNumber,
          ),
        ],
      };
    }
    const parsed: Record<string, unknown> = {};
    for (const [field, index] of columnForField) {
      parsed[field] = record.cells[index]?.trim() ?? "";
    }
    if (!columnForField.has("source") && sourceHint !== undefined) {
      parsed.source = sourceHint;
    }
    const normalized = normalizeCandidate(parsed, "", "direct");
    const key = canonicalJson({
      candidate: candidateKey(normalized.candidate),
      blockingRecordWarnings: record.warnings
        .filter(({ severity }) => severity === "blocking")
        .map(({ code, message }) => ({ code, message })),
    });
    const duplicate = firstByCandidate.get(key);
    const duplicateWarning: CareerImportWarning | null = duplicate
      ? {
          code: "csv_duplicate_row",
          severity: "review",
          rowNumber: record.rowNumber,
          duplicateOfRowNumber: duplicate.rowNumber,
          message: `第 ${record.rowNumber} 行可写入的职位字段与第 ${duplicate.rowNumber} 行相同，本次只保存一次；仍可显式另存一条。`,
        }
      : null;
    const preview = await assemblePreview({
      sourceFingerprint,
      importOperationId: duplicate?.importOperationId,
      createdAt,
      normalized: {
        ...normalized,
        warnings: [
          ...headerBlockingWarnings,
          ...record.warnings,
          ...normalized.warnings.map((warning) => ({ ...warning, rowNumber: record.rowNumber })),
          ...(duplicateWarning ? [duplicateWarning] : []),
        ],
      },
      rowNumber: record.rowNumber,
      duplicateOfRowNumber: duplicate?.rowNumber,
    });
    rows.push(preview);
    if (!duplicate) firstByCandidate.set(key, preview);
  }
  if (rows.length === 0) {
    warnings.push(csvWarning("csv_empty", "blocking", "CSV 只有表头，没有可预览的职位。"));
  }
  return {
    version: IMPORT_VERSION,
    kind: "career-csv-import-preview",
    sourceFingerprint,
    headers,
    rows,
    warnings,
  };
}

function expectedJob(preview: Pick<CareerJobImportPreview, "jobId" | "createdAt" | "candidate">): ExistingJobRow {
  return {
    id: preview.jobId,
    company: preview.candidate.company,
    role: preview.candidate.role,
    location: preview.candidate.location,
    source: preview.candidate.source,
    source_url: preview.candidate.sourceUrl,
    stage_id: preview.candidate.stageId,
    priority: preview.candidate.priority,
    salary: preview.candidate.salary,
    work_mode: preview.candidate.workMode,
    description: preview.candidate.description,
    applied_at: null,
    deadline: null,
    contact_name: "",
    note: "",
    tags: preview.candidate.tags,
    created_at: preview.createdAt,
    updated_at: preview.createdAt,
    archived: 0,
    position: 0,
    archived_at: null,
    ended_at: null,
    archived_operation_id: null,
    ended_operation_id: null,
  };
}

function expectedActivity(preview: Pick<CareerJobImportPreview, "activityId" | "jobId" | "createdAt" | "candidate">): ExistingActivityRow {
  return {
    id: preview.activityId,
    job_id: preview.jobId,
    type: "import",
    detail: activityDetail(preview.candidate),
    created_at: preview.createdAt,
  };
}

function exactObjectMatch(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  return Object.keys(expected).every((key) => actual[key] === expected[key]);
}

function unwrapRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? rows as T[] : [];
  }
  return [];
}

function validateCandidate(
  candidate: unknown,
  requireCommittable: boolean,
): asserts candidate is CareerImportCandidate {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw importError("invalid_preview", "导入预览内容无效，请重新预览");
  }
  const record = candidate as Record<string, unknown>;
  for (const field of CANDIDATE_FIELDS) {
    if (typeof record[field] !== "string") {
      throw importError("invalid_preview", "导入预览内容无效，请重新预览");
    }
    if (requireCommittable && field !== "stageId" &&
      record[field].length > TEXT_LIMITS[field]) {
      throw importError("invalid_preview", "导入内容过长，请精简后重新预览");
    }
  }
  const checked = record as unknown as CareerImportCandidate;
  if (requireCommittable && (!checked.company.trim() || !checked.role.trim())) {
    throw importError("invalid_preview", "请补全公司与职位后重新预览");
  }
  if (!SOURCE_ALIASES.has(checked.source.toLowerCase())) {
    throw importError("invalid_preview", "职位来源没有经过确认，请重新预览");
  }
  if (!STAGE_ALIASES.has(checked.stageId.toLowerCase()) ||
    STAGE_ALIASES.get(checked.stageId.toLowerCase()) !== checked.stageId) {
    throw importError("invalid_preview", "职位阶段没有经过确认，请重新预览");
  }
  if (checked.sourceUrl && !validHttpUrl(checked.sourceUrl)) {
    throw importError("invalid_preview", "原职位链接无效，请重新预览");
  }
  if (!Number.isInteger(checked.priority) || checked.priority < 1 ||
    checked.priority > 3) {
    throw importError("invalid_preview", "职位优先级无效，请重新预览");
  }
}

const WARNING_CODES: ReadonlySet<string> = new Set<CareerImportWarningCode>([
  "missing_required",
  "unknown_source",
  "unknown_stage",
  "unsafe_url",
  "field_too_long",
  "parser_notice",
  "csv_empty",
  "csv_malformed",
  "csv_missing_header",
  "csv_unknown_header",
  "csv_duplicate_header",
  "csv_column_mismatch",
  "csv_empty_row",
  "csv_duplicate_row",
]);
const CONFIDENCE_LEVELS: ReadonlySet<string> = new Set<CareerImportConfidenceLevel>([
  "high",
  "medium",
  "low",
  "unknown",
]);

function positiveRowNumber(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && Number(value) >= 1);
}

function validatePreviewMetadata(preview: CareerJobImportPreview): void {
  if (!Array.isArray(preview.warnings) ||
    preview.warnings.length > MAX_PREVIEW_WARNINGS ||
    !preview.confidence || typeof preview.confidence !== "object" ||
    !preview.confidence.fields || typeof preview.confidence.fields !== "object" ||
    !CONFIDENCE_LEVELS.has(preview.confidence.overall) ||
    !positiveRowNumber(preview.rowNumber) ||
    !positiveRowNumber(preview.duplicateOfRowNumber)) {
    throw importError("invalid_preview", "导入预览说明无效，请重新预览");
  }
  let warningCharacters = 0;
  for (const warning of preview.warnings) {
    if (!warning || typeof warning !== "object" || !WARNING_CODES.has(warning.code) ||
      !["review", "blocking"].includes(warning.severity) ||
      typeof warning.message !== "string" || !warning.message.trim() ||
      warning.message.length > MAX_WARNING_CHARACTERS ||
      (warning.field !== undefined && !CANDIDATE_FIELDS.includes(warning.field)) ||
      !positiveRowNumber(warning.rowNumber) ||
      !positiveRowNumber(warning.duplicateOfRowNumber)) {
      throw importError("invalid_preview", "导入预览说明无效，请重新预览");
    }
    warningCharacters += warning.message.length;
  }
  if (warningCharacters > MAX_WARNING_TOTAL_CHARACTERS) {
    throw importError("invalid_preview", "导入预览说明过多，请重新预览");
  }
  const duplicateWarnings = preview.warnings.filter(({ code }) =>
    code === "csv_duplicate_row");
  if (preview.duplicateOfRowNumber !== undefined) {
    const duplicateWarning = duplicateWarnings.find((warning) =>
      warning.rowNumber === preview.rowNumber &&
      warning.duplicateOfRowNumber === preview.duplicateOfRowNumber);
    if (!duplicateWarning || preview.rowNumber === undefined ||
      preview.rowNumber === preview.duplicateOfRowNumber) {
      throw importError("invalid_preview", "CSV 重复行说明无效，请重新预览");
    }
  } else if (duplicateWarnings.length > 0) {
    throw importError("invalid_preview", "CSV 重复行说明无效，请重新预览");
  }
  for (const field of CANDIDATE_FIELDS) {
    if (!CONFIDENCE_LEVELS.has(preview.confidence.fields[field])) {
      throw importError("invalid_preview", "导入预览置信信息无效，请重新预览");
    }
  }
}

async function assertPreviewIntegrity(
  preview: CareerJobImportPreview,
  requireCommittable = true,
): Promise<void> {
  if (!preview || typeof preview !== "object" || preview.version !== IMPORT_VERSION ||
    preview.kind !== IMPORT_KIND || !SHA256_PATTERN.test(preview.sourceFingerprint) ||
    !SHA256_PATTERN.test(preview.previewFingerprint)) {
    throw importError("invalid_preview", "导入预览无效，请重新预览");
  }
  const identity = identityForOperation(preview.importOperationId);
  if (identity.jobId !== preview.jobId || identity.activityId !== preview.activityId) {
    throw importError("invalid_preview", "导入预览标识不一致，请重新预览");
  }
  const createdAt = canonicalTimestamp(preview.createdAt, "预览时间");
  if (createdAt !== preview.createdAt) {
    throw importError("invalid_preview", "导入预览时间无效，请重新预览");
  }
  validateCandidate(preview.candidate, requireCommittable);
  validatePreviewMetadata(preview);
  const { previewFingerprint: _fingerprint, ...unsigned } = preview;
  void _fingerprint;
  const current = await fingerprintPreview(unsigned);
  if (current !== preview.previewFingerprint) {
    throw importError("preview_changed", "预览内容已经变化，请重新核对后再保存");
  }
  if (requireCommittable && preview.warnings.some(({ severity }) => severity === "blocking")) {
    throw importError("invalid_preview", "预览中仍有需要补充的内容，本次没有保存");
  }
}

type PreflightStatus = "new" | "existing";

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function readExistingMany(previews: readonly CareerJobImportPreview[]) {
  const jobsById = new Map<string, ExistingJobRow>();
  const activitiesById = new Map<string, ExistingActivityRow>();
  for (const jobIds of chunks(previews.map(({ jobId }) => jobId), 400)) {
    const placeholders = jobIds.map(() => "?").join(",");
    const rows = unwrapRows<ExistingJobRow>(await localDb.query(
      DB,
      `SELECT id,company,role,location,source,source_url,stage_id,priority,salary,
          work_mode,description,applied_at,deadline,contact_name,note,tags,
          created_at,updated_at,archived,position,archived_at,ended_at,
          archived_operation_id,ended_operation_id
        FROM career_jobs WHERE id IN (${placeholders})`,
      jobIds,
    ));
    for (const row of rows) jobsById.set(row.id, row);
  }
  for (const activityIds of chunks(previews.map(({ activityId }) => activityId), 400)) {
    const placeholders = activityIds.map(() => "?").join(",");
    const rows = unwrapRows<ExistingActivityRow>(await localDb.query(
      DB,
      `SELECT id,job_id,type,detail,created_at
        FROM career_activity WHERE id IN (${placeholders})`,
      activityIds,
    ));
    for (const row of rows) activitiesById.set(row.id, row);
  }
  return { jobsById, activitiesById };
}

function preflightExisting(
  preview: CareerJobImportPreview,
  existing: Awaited<ReturnType<typeof readExistingMany>>,
): PreflightStatus {
  const job = existing.jobsById.get(preview.jobId) ?? null;
  const activity = existing.activitiesById.get(preview.activityId) ?? null;
  if (job === null && activity === null) return "new";
  if (job === null || activity === null) {
    throw importError(
      "operation_conflict",
      "这个导入标识已被不完整或不同的记录占用，本次没有写入任何职位",
    );
  }
  const jobMatches = exactObjectMatch(
    job as unknown as Record<string, unknown>,
    expectedJob(preview) as unknown as Record<string, unknown>,
  );
  const activityMatches = exactObjectMatch(
    activity as unknown as Record<string, unknown>,
    expectedActivity(preview) as unknown as Record<string, unknown>,
  );
  if (!jobMatches || !activityMatches) {
    throw importError(
      "operation_conflict",
      "这个导入标识已经用于另一份内容，本次没有写入任何职位",
    );
  }
  return "existing";
}

function insertStatements(preview: CareerJobImportPreview): readonly SqlStatement[] {
  const job = expectedJob(preview);
  const activity = expectedActivity(preview);
  return [
    {
      sql: `INSERT INTO career_jobs(
          id,company,role,location,source,source_url,stage_id,priority,salary,
          work_mode,description,applied_at,deadline,contact_name,note,tags,
          created_at,updated_at,archived,position,archived_at,ended_at,
          archived_operation_id,ended_operation_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        job.id,
        job.company,
        job.role,
        job.location,
        job.source,
        job.source_url,
        job.stage_id,
        job.priority,
        job.salary,
        job.work_mode,
        job.description,
        job.applied_at,
        job.deadline,
        job.contact_name,
        job.note,
        job.tags,
        job.created_at,
        job.updated_at,
        job.archived,
        job.position,
        job.archived_at,
        job.ended_at,
        job.archived_operation_id,
        job.ended_operation_id,
      ],
    },
    {
      sql: "INSERT INTO career_activity(id,job_id,type,detail,created_at) VALUES(?,?,?,?,?)",
      params: [
        activity.id,
        activity.job_id,
        activity.type,
        activity.detail,
        activity.created_at,
      ],
    },
  ];
}

function snapshotPreview(value: unknown): CareerJobImportPreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw importError("invalid_preview", "导入预览无效，请重新预览");
  }
  const preview = value as CareerJobImportPreview;
  if (!preview.candidate || typeof preview.candidate !== "object" ||
    !Array.isArray(preview.warnings) || !preview.confidence ||
    typeof preview.confidence !== "object" || !preview.confidence.fields ||
    typeof preview.confidence.fields !== "object") {
    throw importError("invalid_preview", "导入预览无效，请重新预览");
  }
  if (preview.warnings.length > MAX_PREVIEW_WARNINGS) {
    throw importError("invalid_preview", "导入预览说明过多，请重新预览");
  }
  const candidate = Object.freeze({
    company: preview.candidate.company,
    role: preview.candidate.role,
    location: preview.candidate.location,
    source: preview.candidate.source,
    sourceUrl: preview.candidate.sourceUrl,
    stageId: preview.candidate.stageId,
    priority: preview.candidate.priority,
    salary: preview.candidate.salary,
    workMode: preview.candidate.workMode,
    description: preview.candidate.description,
    tags: preview.candidate.tags,
  });
  const warnings = Object.freeze(preview.warnings.map((warning) => Object.freeze({
    code: warning?.code,
    severity: warning?.severity,
    message: warning?.message,
    ...(warning?.field === undefined ? {} : { field: warning.field }),
    ...(warning?.rowNumber === undefined ? {} : { rowNumber: warning.rowNumber }),
    ...(warning?.duplicateOfRowNumber === undefined
      ? {}
      : { duplicateOfRowNumber: warning.duplicateOfRowNumber }),
  }))) as unknown as readonly CareerImportWarning[];
  const fields = Object.freeze(Object.fromEntries(CANDIDATE_FIELDS.map((field) => [
    field,
    preview.confidence.fields[field],
  ]))) as Readonly<Record<CareerImportCandidateField, CareerImportConfidenceLevel>>;
  const confidence = Object.freeze({
    overall: preview.confidence.overall,
    fields,
  });
  return Object.freeze({
    version: preview.version,
    kind: preview.kind,
    sourceFingerprint: preview.sourceFingerprint,
    previewFingerprint: preview.previewFingerprint,
    importOperationId: preview.importOperationId,
    jobId: preview.jobId,
    activityId: preview.activityId,
    createdAt: preview.createdAt,
    candidate,
    warnings,
    confidence,
    ...(preview.rowNumber === undefined ? {} : { rowNumber: preview.rowNumber }),
    ...(preview.duplicateOfRowNumber === undefined
      ? {}
      : { duplicateOfRowNumber: preview.duplicateOfRowNumber }),
  });
}

function snapshotCommitItems(input: unknown): readonly CareerImportCommitItem[] {
  try {
    if (!input || typeof input !== "object" ||
      !Array.isArray((input as { items?: unknown }).items)) {
      throw importError("invalid_preview", "请选择至少一条已核对的导入预览");
    }
    const values = (input as { items: readonly unknown[] }).items;
    if (values.length > 2_000) {
      throw importError("invalid_preview", "单次导入内容过多，请分批预览后保存");
    }
    return Object.freeze(values.map((value) => {
      if (!value || typeof value !== "object") {
        throw importError("invalid_preview", "导入预览无效，请重新预览");
      }
      const item = value as CareerImportCommitItem;
      return Object.freeze({
        preview: snapshotPreview(item.preview),
        currentSourceFingerprint: item.currentSourceFingerprint,
      });
    }));
  } catch (error) {
    if (error instanceof CareerImportError) throw error;
    throw importError("invalid_preview", "导入预览无效，请重新预览");
  }
}

function uniqueCommitItems(items: readonly CareerImportCommitItem[]) {
  const byOperation = new Map<string, CareerImportCommitItem>();
  for (const item of items) {
    const existing = byOperation.get(item.preview.importOperationId);
    if (!existing) {
      byOperation.set(item.preview.importOperationId, item);
      continue;
    }
    if (canonicalJson(commitFacts(existing.preview)) !== canonicalJson(commitFacts(item.preview)) ||
      existing.currentSourceFingerprint !== item.currentSourceFingerprint) {
      throw importError(
        "operation_conflict",
        "同一个导入操作包含了不同内容，本次没有写入任何职位",
      );
    }
  }
  return [...byOperation.values()];
}

async function assertStagesAvailable(items: readonly CareerImportCommitItem[]): Promise<void> {
  const stageIds = [...new Set(items.map(({ preview }) => preview.candidate.stageId))];
  const available = new Set<string>();
  for (const stageChunk of chunks(stageIds, 400)) {
    const placeholders = stageChunk.map(() => "?").join(",");
    const rows = unwrapRows<{ id: string }>(await localDb.query(
      DB,
      `SELECT id FROM career_stages WHERE id IN (${placeholders})`,
      stageChunk,
    ));
    for (const row of rows) available.add(row.id);
  }
  for (const stageId of stageIds) {
    if (!available.has(stageId)) {
      throw importError(
        "stage_unavailable",
        "保存位置当前不可用，本次没有写入任何职位；请刷新后重新预览",
      );
    }
  }
}

function uncertainCommitError(
  items: readonly CareerImportCommitItem[],
): CareerImportCommitUncertainError {
  const identities = uniqueCommitItems(items).map(({ preview }) => Object.freeze({
    importOperationId: preview.importOperationId,
    jobId: preview.jobId,
    activityId: preview.activityId,
    previewFingerprint: preview.previewFingerprint,
  }));
  return new CareerImportCommitUncertainError(Object.freeze(identities));
}

export async function commitCareerJobImports(
  input: Readonly<{ items: readonly CareerImportCommitItem[] }>,
): Promise<CareerImportCommitManyResult> {
  // This synchronous, field-by-field snapshot happens before the first await.
  // Caller-owned objects can change while a tab is waiting for the Web Lock;
  // every validation and SQL parameter below uses only this frozen copy.
  const items = snapshotCommitItems(input);
  if (items.length === 0) {
    throw importError("invalid_preview", "请选择至少一条已核对的导入预览");
  }
  if (items.length > 2_000) {
    throw importError("invalid_preview", "单次导入内容过多，请分批预览后保存");
  }
  try {
    for (const item of items) {
      if (!item || typeof item !== "object" || typeof item.currentSourceFingerprint !== "string") {
        throw importError("invalid_preview", "导入预览无效，请重新预览");
      }
      await assertPreviewIntegrity(item.preview);
      if (item.currentSourceFingerprint !== item.preview.sourceFingerprint) {
        throw importError(
          "source_changed",
          "原文或文件在预览后发生了变化，请重新预览；本次没有写入任何职位",
        );
      }
    }
  } catch (error) {
    if (error instanceof CareerImportError) throw error;
    throw importError("write_failed", "暂时无法核对导入预览，本次没有开始写入");
  }
  const uniqueItems = uniqueCommitItems(items);
  let batchAttempted = false;
  let batchConfirmed = false;

  try {
    return await withCareerWriteLock(async () => {
      await assertStagesAvailable(uniqueItems);
      const existing = await readExistingMany(uniqueItems.map(({ preview }) => preview));
      const statuses = new Map<string, PreflightStatus>();
      for (const { preview } of uniqueItems) {
        statuses.set(preview.importOperationId, preflightExisting(preview, existing));
      }
      const freshItems = uniqueItems.filter(({ preview }) =>
        statuses.get(preview.importOperationId) === "new");
      if (freshItems.length > 0) {
        const statements = freshItems.flatMap(({ preview }) => insertStatements(preview));
        batchAttempted = true;
        try {
          await localDb.batch(DB, statements, { transaction: true });
          batchConfirmed = true;
        } catch {
          // A response can be lost after a durable transaction. Re-read under
          // the same lock, but never claim "nothing changed" if that read fails.
          let recovery: Awaited<ReturnType<typeof readExistingMany>>;
          try {
            recovery = await readExistingMany(uniqueItems.map(({ preview }) => preview));
          } catch {
            throw uncertainCommitError(items);
          }
          try {
            for (const { preview } of uniqueItems.filter(({ preview }) =>
              statuses.get(preview.importOperationId) === "existing")) {
              if (preflightExisting(preview, recovery) !== "existing") {
                throw new Error("existing import changed during recovery");
              }
            }
            const freshRecovery = freshItems.map(({ preview }) =>
              preflightExisting(preview, recovery));
            if (freshRecovery.every((status) => status === "existing")) {
              batchConfirmed = true;
            } else if (freshRecovery.every((status) => status === "new")) {
              throw importError("write_failed", "职位没有写入，本次操作未改变任何记录");
            } else {
              throw uncertainCommitError(items);
            }
          } catch (error) {
            if (error instanceof CareerImportError &&
              (error.code === "write_failed" || error.code === "commit_uncertain")) {
              throw error;
            }
            throw uncertainCommitError(items);
          }
        }
      }

      const resultByOperation = new Map<string, Omit<
        CareerImportCommitItemResult,
        "previewFingerprint"
      >>();
      for (const { preview } of uniqueItems) {
        const wasFresh = freshItems.some(({ preview: fresh }) =>
          fresh.importOperationId === preview.importOperationId);
        resultByOperation.set(preview.importOperationId, {
          committed: true,
          status: wasFresh ? "committed" : "already_committed",
          importOperationId: preview.importOperationId,
          jobId: preview.jobId,
          activityId: preview.activityId,
          storedAt: preview.createdAt,
        });
      }
      return {
        committed: true,
        writePerformed: freshItems.length > 0,
        writtenCount: freshItems.length,
        uniqueCount: uniqueItems.length,
        results: items.map(({ preview }) => ({
          ...resultByOperation.get(preview.importOperationId)!,
          previewFingerprint: preview.previewFingerprint,
        })),
      };
    });
  } catch (error) {
    if (error instanceof CareerImportError) throw error;
    if (batchAttempted || batchConfirmed) {
      throw uncertainCommitError(items);
    }
    throw importError(
      "write_failed",
      "暂时无法核对导入状态，本次没有开始写入；请稍后重新读取再试。",
    );
  }
}

/**
 * Read-only reconciliation for an uncertain commit. It never retries a write
 * and never creates a replacement operation ID.
 */
export async function inspectCareerImportCommit(
  previewInput: CareerJobImportPreview,
): Promise<CareerImportCommitInspection> {
  const preview = snapshotPreview(previewInput);
  try {
    await assertPreviewIntegrity(preview);
  } catch (error) {
    if (error instanceof CareerImportError) throw error;
    throw importError("invalid_preview", "暂时无法核对这份导入预览，请稍后再试");
  }
  const identity = {
    importOperationId: preview.importOperationId,
    jobId: preview.jobId,
    activityId: preview.activityId,
    previewFingerprint: preview.previewFingerprint,
  } as const;
  try {
    return await withCareerReadLock(async () => {
      try {
        const existing = await readExistingMany([preview]);
        try {
          const status = preflightExisting(preview, existing);
          return { ...identity, status: status === "existing" ? "exact_committed" : "absent" };
        } catch (error) {
          if (error instanceof CareerImportError && error.code === "operation_conflict") {
            return { ...identity, status: "conflict" };
          }
          return { ...identity, status: "still_unknown" };
        }
      } catch {
        return { ...identity, status: "still_unknown" };
      }
    });
  } catch {
    return { ...identity, status: "still_unknown" };
  }
}

export async function commitCareerJobImport(
  item: CareerImportCommitItem,
): Promise<CareerImportCommitItemResult> {
  const result = await commitCareerJobImports({ items: [item] });
  return result.results[0];
}
