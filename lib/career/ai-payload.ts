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
  interviewSummary: 4_000,
  interviewRawNotes: 24_000,
  interviewReflection: 12_000,
  interviewQuestions: 24,
  interviewQuestion: 600,
  interviewAnswer: 1_500,
  interviewQuestionNote: 600,
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

const structureInterviewJobFields = Object.freeze([
  Object.freeze({ key: "company", label: "公司", kind: "single-line", maxLength: CAREER_AI_PAYLOAD_LIMITS.company }),
  Object.freeze({ key: "role", label: "职位", kind: "single-line", maxLength: CAREER_AI_PAYLOAD_LIMITS.role }),
] as const satisfies readonly CareerAiFieldSpec[]);

const structureInterviewFields = Object.freeze([
  Object.freeze({ key: "round_name", label: "面试轮次", kind: "single-line", maxLength: CAREER_AI_PAYLOAD_LIMITS.roundName }),
  Object.freeze({ key: "summary", label: "一句话总结", kind: "single-line", maxLength: CAREER_AI_PAYLOAD_LIMITS.interviewSummary }),
  Object.freeze({ key: "raw_notes", label: "原始速记", kind: "multiline", maxLength: CAREER_AI_PAYLOAD_LIMITS.interviewRawNotes }),
  Object.freeze({ key: "reflection", label: "复盘与下一步", kind: "multiline", maxLength: CAREER_AI_PAYLOAD_LIMITS.interviewReflection }),
] as const satisfies readonly CareerAiFieldSpec[]);

const structureInterviewQuestionFields = Object.freeze([
  Object.freeze({ key: "question", label: "问题", kind: "single-line", maxLength: CAREER_AI_PAYLOAD_LIMITS.interviewQuestion }),
  Object.freeze({ key: "answer", label: "回答", kind: "multiline", maxLength: CAREER_AI_PAYLOAD_LIMITS.interviewAnswer }),
  Object.freeze({ key: "note", label: "问题备注", kind: "single-line", maxLength: CAREER_AI_PAYLOAD_LIMITS.interviewQuestionNote }),
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

/** Human-readable disclosure text derived from the exact interview-structure whitelist. */
export const CAREER_STRUCTURE_INTERVIEW_SHARED_FIELDS = fieldLabels([
  ...structureInterviewJobFields,
  ...structureInterviewFields.slice(0, 3),
  ...structureInterviewQuestionFields,
  structureInterviewFields[3],
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

export type CareerStructureInterviewPayload = Readonly<{
  job: Readonly<{
    company: string;
    role: string;
  }>;
  interview: Readonly<{
    round_name: string;
    summary: string;
    raw_notes: string;
    questions: readonly Readonly<{
      question: string;
      answer: string;
      note: string;
    }>[];
    reflection: string;
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

export class CareerAiActionNotAllowedError extends TypeError {
  readonly code = "CAREER_AI_ACTION_NOT_ALLOWED";

  constructor() {
    super("This Career AI action is not available at this privacy boundary.");
    this.name = "CareerAiActionNotAllowedError";
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

function toWellFormedText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index += 1;
      } else {
        result += "\ufffd";
      }
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      result += "\ufffd";
    } else {
      result += value[index];
    }
  }
  return result;
}

function removeUnsafeControls(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const disallowedControl = codePoint <= 8 ||
      (codePoint >= 11 && codePoint <= 12) ||
      (codePoint >= 14 && codePoint <= 31) ||
      (codePoint >= 127 && codePoint <= 159);
    const bidiOverride = codePoint === 0x061c ||
      (codePoint >= 0x200e && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
    if (!disallowedControl && !bidiOverride && codePoint !== 0xfeff) result += character;
  }
  return result;
}

function normalizeText(value: unknown, maximum: number, multiline: boolean): string {
  if (typeof value !== "string") return "";
  const withoutUnsafeControls = removeUnsafeControls(
    toWellFormedText(value)
      .normalize("NFC")
      .replace(/\r\n?/g, "\n")
      .replace(/[\u2028\u2029]/g, "\n"),
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

function selectStructureInterviewQuestions(value: unknown): CareerStructureInterviewPayload["interview"]["questions"] {
  let questions: readonly unknown[];
  try {
    if (!Array.isArray(value)) return Object.freeze([]);
    questions = value;
  } catch {
    return Object.freeze([]);
  }

  const selectedQuestions: Array<CareerStructureInterviewPayload["interview"]["questions"][number]> = [];
  let count = 0;
  try {
    count = Math.min(questions.length, CAREER_AI_PAYLOAD_LIMITS.interviewQuestions);
  } catch {
    return Object.freeze([]);
  }
  for (let index = 0; index < count; index += 1) {
    let question: unknown;
    try {
      question = questions[index];
    } catch {
      question = undefined;
    }
    const selected = selectFields(question, structureInterviewQuestionFields);
    selectedQuestions.push(selected as CareerStructureInterviewPayload["interview"]["questions"][number]);
  }
  return Object.freeze(selectedQuestions);
}

export function buildCareerStructureInterviewPayload(
  job: unknown,
  interview: unknown,
): CareerStructureInterviewPayload {
  const interviewSource = record(interview);
  const selectedJobFields = selectFields(job, structureInterviewJobFields);
  const selectedInterviewFields = selectFields(interview, structureInterviewFields);
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

  const selectedJob = selectedJobFields as CareerStructureInterviewPayload["job"];
  const selectedInterview = Object.freeze({
    round_name: selectedInterviewFields.round_name as string,
    summary: selectedInterviewFields.summary as string,
    raw_notes: selectedInterviewFields.raw_notes as string,
    questions: selectStructureInterviewQuestions(read(interviewSource, "questions")),
    reflection: selectedInterviewFields.reflection as string,
  });
  return Object.freeze({ job: selectedJob, interview: selectedInterview });
}

function normalizeCareerAiAction(action: string): string {
  return action
    .trim()
    .replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)
    .replace(/-/g, "_");
}

/**
 * Rebuild privacy-sensitive AI inputs at the server boundary. Callers are
 * intentionally treated as untrusted even when the UI already used a builder.
 * Actions whose contracts have not been narrowed are rejected before prompting.
 */
export function sanitizeCareerAiRequestPayload(
  action: string,
  payload: unknown,
): CareerRequirementsPayload | CareerInterviewPrepPayload | CareerStructureInterviewPayload {
  const normalizedAction = normalizeCareerAiAction(action);
  if (normalizedAction === "fit_analysis") {
    return buildCareerRequirementsPayload(read(record(payload), "job"));
  }
  if (normalizedAction === "interview_prep") {
    return buildCareerInterviewPrepPayload(
      read(record(payload), "job"),
      read(record(payload), "interview"),
    );
  }
  if (normalizedAction === "structure_interview") {
    return buildCareerStructureInterviewPayload(
      read(record(payload), "job"),
      read(record(payload), "interview"),
    );
  }
  throw new CareerAiActionNotAllowedError();
}
