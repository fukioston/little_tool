type CareerAiPayloadScalar = string | number | null;

type CareerAiFieldSpec = Readonly<{
  key: string;
  label: string;
  kind: "single-line" | "multiline" | "canonical-instant" | "duration-minutes";
  maxLength?: number;
}>;

export const CAREER_AI_PAYLOAD_LIMITS = Object.freeze({
  company: 200,
  role: 240,
  description: 48_000,
  location: 240,
  workMode: 80,
  roundName: 240,
  interviewer: 240,
  durationMinutes: 1_440,
} as const);

const requirementsJobFields = Object.freeze([
  Object.freeze({ key: "company", label: "公司", kind: "single-line", maxLength: CAREER_AI_PAYLOAD_LIMITS.company }),
  Object.freeze({ key: "role", label: "职位", kind: "single-line", maxLength: CAREER_AI_PAYLOAD_LIMITS.role }),
  Object.freeze({ key: "description", label: "职位描述", kind: "multiline", maxLength: CAREER_AI_PAYLOAD_LIMITS.description }),
] as const satisfies readonly CareerAiFieldSpec[]);

const interviewPrepJobFields = Object.freeze([
  ...requirementsJobFields,
  Object.freeze({ key: "location", label: "地点", kind: "single-line", maxLength: CAREER_AI_PAYLOAD_LIMITS.location }),
  Object.freeze({ key: "work_mode", label: "工作方式", kind: "single-line", maxLength: CAREER_AI_PAYLOAD_LIMITS.workMode }),
] as const satisfies readonly CareerAiFieldSpec[]);

const interviewPrepInterviewFields = Object.freeze([
  Object.freeze({ key: "round_name", label: "面试轮次", kind: "single-line", maxLength: CAREER_AI_PAYLOAD_LIMITS.roundName }),
  Object.freeze({ key: "scheduled_at", label: "计划时间", kind: "canonical-instant" }),
  Object.freeze({ key: "duration", label: "预计时长", kind: "duration-minutes" }),
  Object.freeze({ key: "interviewer", label: "面试官", kind: "single-line", maxLength: CAREER_AI_PAYLOAD_LIMITS.interviewer }),
] as const satisfies readonly CareerAiFieldSpec[]);

function fieldLabels(fields: readonly CareerAiFieldSpec[]) {
  return Object.freeze(fields.map((field) => field.label));
}

/** Human-readable disclosure text derived from the exact requirements whitelist. */
export const CAREER_REQUIREMENTS_SHARED_FIELDS = fieldLabels(requirementsJobFields);

/** Human-readable disclosure text derived from the exact interview-prep whitelist. */
export const CAREER_INTERVIEW_PREP_SHARED_FIELDS = fieldLabels([
  ...interviewPrepJobFields,
  ...interviewPrepInterviewFields,
]);

export type CareerRequirementsPayload = Readonly<{
  job: Readonly<{
    company: string;
    role: string;
    description: string;
  }>;
}>;

export type CareerInterviewPrepPayload = Readonly<{
  job: Readonly<{
    company: string;
    role: string;
    description: string;
    location: string;
    work_mode: string;
  }>;
  interview: Readonly<{
    round_name: string;
    scheduled_at: string | null;
    duration: number | null;
    interviewer: string;
  }>;
}>;

export class CareerAiPayloadValidationError extends TypeError {
  readonly code = "CAREER_AI_PAYLOAD_REQUIRED_FIELDS";
  readonly missingFields: readonly string[];

  constructor(missingFields: readonly string[]) {
    const stableFields = Object.freeze([...missingFields]);
    super(`Career AI payload is missing required fields: ${stableFields.join(", ")}`);
    this.name = "CareerAiPayloadValidationError";
    this.missingFields = stableFields;
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : Object.freeze({});
}

function read(source: Readonly<Record<string, unknown>>, key: string): unknown {
  try {
    return source[key];
  } catch {
    return undefined;
  }
}

function takeCodePoints(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return Array.from(value).slice(0, maximum).join("");
}

function removeUnsafeControls(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const disallowedControl = codePoint <= 8 ||
      (codePoint >= 11 && codePoint <= 12) ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127;
    const bidiOverride = (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
    if (!disallowedControl && !bidiOverride) result += character;
  }
  return result;
}

function normalizeText(value: unknown, maximum: number, multiline: boolean): string {
  if (typeof value !== "string") return "";
  const withoutUnsafeControls = removeUnsafeControls(
    value.normalize("NFC").replace(/\r\n?/g, "\n"),
  );
  const normalized = multiline
    ? withoutUnsafeControls
      .replace(/[^\S\n]+/gu, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
    : withoutUnsafeControls.replace(/\s+/gu, " ").trim();
  return takeCodePoints(normalized, maximum);
}

function normalizeCanonicalInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate)) return null;
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== candidate) return null;
  return candidate;
}

function normalizeDurationMinutes(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= CAREER_AI_PAYLOAD_LIMITS.durationMinutes
    ? value
    : null;
}

function selectFields(
  input: unknown,
  fields: readonly CareerAiFieldSpec[],
): Readonly<Record<string, CareerAiPayloadScalar>> {
  const source = record(input);
  const selected: Record<string, CareerAiPayloadScalar> = {};
  for (const field of fields) {
    const value = read(source, field.key);
    if (field.kind === "canonical-instant") {
      selected[field.key] = normalizeCanonicalInstant(value);
    } else if (field.kind === "duration-minutes") {
      selected[field.key] = normalizeDurationMinutes(value);
    } else {
      selected[field.key] = normalizeText(value, field.maxLength ?? 0, field.kind === "multiline");
    }
  }
  return Object.freeze(selected);
}

function missingNonEmptyText(
  selected: Readonly<Record<string, CareerAiPayloadScalar>>,
  paths: readonly Readonly<{ key: string; path: string }>[],
): string[] {
  return paths
    .filter(({ key }) => {
      const value = selected[key];
      return typeof value !== "string" || value.length === 0;
    })
    .map(({ path }) => path);
}

export function buildCareerRequirementsPayload(job: unknown): CareerRequirementsPayload {
  const selected = selectFields(job, requirementsJobFields);
  const missing = missingNonEmptyText(selected, [
    { key: "company", path: "job.company" },
    { key: "role", path: "job.role" },
    { key: "description", path: "job.description" },
  ]);
  if (missing.length > 0) throw new CareerAiPayloadValidationError(missing);
  const selectedJob = selected as CareerRequirementsPayload["job"];
  return Object.freeze({ job: selectedJob });
}

export function buildCareerInterviewPrepPayload(
  job: unknown,
  interview: unknown,
): CareerInterviewPrepPayload {
  const selectedJobFields = selectFields(job, interviewPrepJobFields);
  const selectedInterviewFields = selectFields(interview, interviewPrepInterviewFields);
  const missing = [
    ...missingNonEmptyText(selectedJobFields, [
      { key: "company", path: "job.company" },
      { key: "role", path: "job.role" },
    ]),
    ...missingNonEmptyText(selectedInterviewFields, [
      { key: "round_name", path: "interview.round_name" },
    ]),
  ];
  if (missing.length > 0) throw new CareerAiPayloadValidationError(missing);
  const selectedJob = selectedJobFields as CareerInterviewPrepPayload["job"];
  const selectedInterview = selectedInterviewFields as CareerInterviewPrepPayload["interview"];
  return Object.freeze({ job: selectedJob, interview: selectedInterview });
}
