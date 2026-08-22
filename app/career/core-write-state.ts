import type {
  CareerCoreWriteExpectedSet,
  CareerCoreWriteReceipt,
  CareerInterviewWriteExpectedState,
  CareerJobWriteExpectedState,
  CareerStageWriteExpectedState,
} from "@/lib/career/core-writes";
import type { CareerLifecycleSnapshot } from "@/lib/career/lifecycle";
import type {
  CareerData,
  Interview,
  InterviewQuestion,
  Job,
  Stage,
} from "@/lib/career/types";

const STAGE_KEYS = [
  "id", "name", "color", "position", "is_terminal", "hidden",
] as const;
const JOB_KEYS = [
  "id", "company", "role", "location", "source", "source_url",
  "stage_id", "priority", "salary", "work_mode", "description",
  "applied_at", "deadline", "contact_name", "note", "tags",
  "created_at", "updated_at", "archived", "position", "archived_at",
  "ended_at", "archived_operation_id", "ended_operation_id",
] as const;
const INTERVIEW_KEYS = [
  "id", "job_id", "round_name", "interview_type", "scheduled_at",
  "duration", "interviewer", "meeting_url", "status", "summary",
  "raw_notes", "questions_json", "reflection", "created_at", "updated_at",
  "canceled_at", "cancellation_reason", "lifecycle_previous_status",
  "lifecycle_operation_id",
] as const;

export type CareerCoreBindings = Readonly<{
  generationId: string;
  generationSequence: number;
  stages: ReadonlyMap<string, Readonly<{
    display: Readonly<Stage>;
    expected: CareerStageWriteExpectedState;
  }>>;
  jobs: ReadonlyMap<string, Readonly<{
    display: Readonly<Job>;
    expected: CareerJobWriteExpectedState;
  }>>;
  interviews: ReadonlyMap<string, Readonly<{
    display: Readonly<Interview>;
    expected: CareerInterviewWriteExpectedState;
  }>>;
}>;

export type CareerCoreReadBundle = Readonly<{
  base: CareerData;
  all: CareerLifecycleSnapshot;
  scoped: CareerLifecycleSnapshot;
  expectedSet: CareerCoreWriteExpectedSet;
  bindings: CareerCoreBindings;
}>;

export type CareerInterviewEditorSnapshot = Readonly<{
  status: Interview["status"];
  summary: string;
  rawNotes: string;
  questions: readonly Readonly<InterviewQuestion>[];
  reflection: string;
}>;

export type CareerInterviewLocalDraftV2 = Readonly<{
  version: 2;
  interviewId: string;
  source: CareerInterviewWriteExpectedState;
  savedAt: string;
  snapshot: CareerInterviewEditorSnapshot;
}>;

export type CareerInterviewLocalDraftV1 = Readonly<{
  version: 1;
  interviewId: string;
  sourceUpdatedAt: string;
  savedAt: string;
  snapshot: CareerInterviewEditorSnapshot;
}>;

export type CareerInterviewLocalDraft =
  | CareerInterviewLocalDraftV1
  | CareerInterviewLocalDraftV2;

const GENERATION_ID_PATTERN =
  /^(?:legacy|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStoredStage(value: unknown): value is Readonly<Stage> {
  if (!isRecord(value) || !hasExactKeys(value, STAGE_KEYS)) return false;
  return typeof value.id === "string" && value.id.length > 0 && value.id.length <= 240 &&
    typeof value.name === "string" && typeof value.color === "string" &&
    isSafeInteger(value.position) &&
    (value.is_terminal === 0 || value.is_terminal === 1) &&
    (value.hidden === 0 || value.hidden === 1);
}

function isStoredJob(value: unknown): value is Readonly<Job> {
  if (!isRecord(value) || !hasExactKeys(value, JOB_KEYS)) return false;
  return typeof value.id === "string" && value.id.length > 0 && value.id.length <= 240 &&
    typeof value.company === "string" && typeof value.role === "string" &&
    typeof value.location === "string" && typeof value.source === "string" &&
    typeof value.source_url === "string" && typeof value.stage_id === "string" &&
    value.stage_id.length > 0 && isSafeInteger(value.priority) &&
    typeof value.salary === "string" && typeof value.work_mode === "string" &&
    typeof value.description === "string" && isNullableString(value.applied_at) &&
    isNullableString(value.deadline) && typeof value.contact_name === "string" &&
    typeof value.note === "string" && typeof value.tags === "string" &&
    typeof value.created_at === "string" && typeof value.updated_at === "string" &&
    (value.archived === 0 || value.archived === 1) && isSafeInteger(value.position) &&
    isNullableString(value.archived_at) && isNullableString(value.ended_at) &&
    isNullableString(value.archived_operation_id) &&
    isNullableString(value.ended_operation_id);
}

function isStoredInterview(value: unknown): value is Readonly<Interview> {
  if (!isRecord(value) || !hasExactKeys(value, INTERVIEW_KEYS)) return false;
  return typeof value.id === "string" && value.id.length > 0 && value.id.length <= 240 &&
    typeof value.job_id === "string" && value.job_id.length > 0 &&
    typeof value.round_name === "string" && typeof value.interview_type === "string" &&
    isNullableString(value.scheduled_at) && isSafeInteger(value.duration) &&
    value.duration >= 1 && typeof value.interviewer === "string" &&
    typeof value.meeting_url === "string" &&
    (value.status === "scheduled" || value.status === "completed" || value.status === "canceled") &&
    typeof value.summary === "string" && typeof value.raw_notes === "string" &&
    typeof value.questions_json === "string" && typeof value.reflection === "string" &&
    typeof value.created_at === "string" && typeof value.updated_at === "string" &&
    isNullableString(value.canceled_at) && isNullableString(value.cancellation_reason) &&
    (value.lifecycle_previous_status === null || value.lifecycle_previous_status === "scheduled") &&
    isNullableString(value.lifecycle_operation_id);
}

function isInterviewExpectedState(
  value: unknown,
): value is CareerInterviewWriteExpectedState {
  if (!isRecord(value) || !hasExactKeys(value, [
    "generationId", "generationSequence", "interview", "job", "stage",
  ])) return false;
  return typeof value.generationId === "string" &&
    GENERATION_ID_PATTERN.test(value.generationId) &&
    isSafeInteger(value.generationSequence) && value.generationSequence >= 0 &&
    isStoredInterview(value.interview) && isStoredJob(value.job) &&
    isStoredStage(value.stage) && value.interview.job_id === value.job.id &&
    value.job.stage_id === value.stage.id;
}

function isInterviewEditorSnapshot(
  value: unknown,
): value is CareerInterviewEditorSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, [
    "status", "summary", "rawNotes", "questions", "reflection",
  ])) return false;
  return (value.status === "scheduled" || value.status === "completed" ||
      value.status === "canceled") &&
    typeof value.summary === "string" && typeof value.rawNotes === "string" &&
    Array.isArray(value.questions) && value.questions.every((question) =>
      isRecord(question) && hasExactKeys(question, ["question", "answer", "note"]) &&
      typeof question.question === "string" && typeof question.answer === "string" &&
      typeof question.note === "string") &&
    typeof value.reflection === "string";
}

/** Parse untrusted localStorage data without accepting partial or widened shapes. */
export function parseCareerInterviewLocalDraft(
  value: unknown,
  interviewId: string,
): CareerInterviewLocalDraft | null {
  if (!isRecord(value) || value.interviewId !== interviewId) return null;
  if (value.version === 1) {
    if (!hasExactKeys(value, [
      "version", "interviewId", "sourceUpdatedAt", "savedAt", "snapshot",
    ]) || typeof value.sourceUpdatedAt !== "string" ||
      typeof value.savedAt !== "string" ||
      !isInterviewEditorSnapshot(value.snapshot)) return null;
    return {
      version: 1,
      interviewId: value.interviewId,
      sourceUpdatedAt: value.sourceUpdatedAt,
      savedAt: value.savedAt,
      snapshot: value.snapshot,
    };
  }
  if (value.version === 2) {
    if (!hasExactKeys(value, [
      "version", "interviewId", "source", "savedAt", "snapshot",
    ]) || typeof value.savedAt !== "string" ||
      !isInterviewExpectedState(value.source) ||
      value.source.interview.id !== interviewId ||
      !isInterviewEditorSnapshot(value.snapshot)) return null;
    return {
      version: 2,
      interviewId: value.interviewId,
      source: value.source,
      savedAt: value.savedAt,
      snapshot: value.snapshot,
    };
  }
  return null;
}

function sameKeys<Row extends object>(
  left: Row,
  right: Row,
  keys: readonly (keyof Row)[],
): boolean {
  return keys.every((key) => left[key] === right[key]);
}

export function sameCareerCoreStage(left: Stage, right: Stage): boolean {
  return sameKeys(left, right, STAGE_KEYS);
}

export function sameCareerCoreJob(left: Job, right: Job): boolean {
  return sameKeys(left, right, JOB_KEYS);
}

export function sameCareerCoreInterview(
  left: Interview,
  right: Interview,
): boolean {
  return sameKeys(left, right, INTERVIEW_KEYS);
}

function uniqueById<Row extends Readonly<{ id: string }>>(
  rows: readonly Row[],
): Map<string, Row> | null {
  const result = new Map<string, Row>();
  for (const row of rows) {
    if (result.has(row.id)) return null;
    result.set(row.id, row);
  }
  return result;
}

export function sameCareerCoreExpectedSet(
  left: CareerCoreWriteExpectedSet,
  right: CareerCoreWriteExpectedSet,
): boolean {
  if (
    left.generationId !== right.generationId ||
    left.generationSequence !== right.generationSequence ||
    left.stages.length !== right.stages.length ||
    left.jobs.length !== right.jobs.length ||
    left.interviews.length !== right.interviews.length
  ) return false;
  const leftStages = uniqueById(left.stages);
  const leftJobs = uniqueById(left.jobs);
  const leftInterviews = uniqueById(left.interviews);
  const rightStages = uniqueById(right.stages);
  const rightJobs = uniqueById(right.jobs);
  const rightInterviews = uniqueById(right.interviews);
  if (!leftStages || !leftJobs || !leftInterviews ||
    !rightStages || !rightJobs || !rightInterviews) return false;
  return left.stages.every((row) => {
    const other = rightStages.get(row.id);
    return Boolean(other && sameCareerCoreStage(row, other));
  }) && left.jobs.every((row) => {
    const other = rightJobs.get(row.id);
    return Boolean(other && sameCareerCoreJob(row, other));
  }) && left.interviews.every((row) => {
    const other = rightInterviews.get(row.id);
    return Boolean(other && sameCareerCoreInterview(row, other));
  });
}

function replaceExactRow<Row extends Readonly<{ id: string }>>(
  rows: readonly Row[],
  before: Row,
  after: Row,
  same: (left: Row, right: Row) => boolean,
): readonly Row[] | null {
  const index = rows.findIndex((row) => row.id === before.id);
  if (index < 0 || before.id !== after.id || !same(rows[index], before)) return null;
  return rows.map((row, rowIndex) => rowIndex === index ? after : row);
}

/**
 * Reconstruct the only full expected set that may follow this exact receipt.
 * This lets a dirty editor accept its own committed rebase without treating an
 * unrelated whole-bundle read as fresh authorization.
 */
export function careerCoreExpectedSetAfterReceipt(
  current: CareerCoreWriteExpectedSet,
  receipt: CareerCoreWriteReceipt,
): CareerCoreWriteExpectedSet | null {
  if (
    current.generationId !== receipt.generationId ||
    current.generationSequence !== receipt.generationSequence ||
    receipt.after.generationId !== current.generationId ||
    receipt.after.generationSequence !== current.generationSequence
  ) return null;

  switch (receipt.kind) {
    case "stage-rename": {
      const stages = replaceExactRow(
        current.stages,
        receipt.before.stage,
        receipt.after.stage,
        sameCareerCoreStage,
      );
      return stages ? { ...current, stages } : null;
    }
    case "job-create": {
      const stage = current.stages.find((row) => row.id === receipt.before.stage.id);
      if (!stage || !sameCareerCoreStage(stage, receipt.before.stage) ||
        !sameCareerCoreStage(receipt.before.stage, receipt.after.stage) ||
        current.jobs.some((row) => row.id === receipt.before.jobId) ||
        receipt.after.job.id !== receipt.before.jobId) return null;
      return { ...current, jobs: [...current.jobs, receipt.after.job] };
    }
    case "job-update": {
      const stage = current.stages.find((row) => row.id === receipt.before.stage.id);
      const jobs = replaceExactRow(
        current.jobs,
        receipt.before.job,
        receipt.after.job,
        sameCareerCoreJob,
      );
      if (!jobs || !stage || !sameCareerCoreStage(stage, receipt.before.stage) ||
        !sameCareerCoreStage(receipt.before.stage, receipt.after.stage)) return null;
      return { ...current, jobs };
    }
    case "interview-create": {
      const stage = current.stages.find((row) => row.id === receipt.before.stage.id);
      const job = current.jobs.find((row) => row.id === receipt.before.job.id);
      if (!stage || !job ||
        !sameCareerCoreStage(stage, receipt.before.stage) ||
        !sameCareerCoreStage(receipt.before.stage, receipt.after.stage) ||
        !sameCareerCoreJob(job, receipt.before.job) ||
        !sameCareerCoreJob(receipt.before.job, receipt.after.job) ||
        current.interviews.some((row) => row.id === receipt.before.interviewId) ||
        receipt.after.interview.id !== receipt.before.interviewId) return null;
      return { ...current, interviews: [...current.interviews, receipt.after.interview] };
    }
    case "interview-update": {
      const stage = current.stages.find((row) => row.id === receipt.before.stage.id);
      const job = current.jobs.find((row) => row.id === receipt.before.job.id);
      const interviews = replaceExactRow(
        current.interviews,
        receipt.before.interview,
        receipt.after.interview,
        sameCareerCoreInterview,
      );
      if (!interviews || !stage || !job ||
        !sameCareerCoreStage(stage, receipt.before.stage) ||
        !sameCareerCoreStage(receipt.before.stage, receipt.after.stage) ||
        !sameCareerCoreJob(job, receipt.before.job) ||
        !sameCareerCoreJob(receipt.before.job, receipt.after.job)) return null;
      return { ...current, interviews };
    }
  }
}

export function careerCoreBundleApplyDecision(input: Readonly<{
  current: CareerCoreWriteExpectedSet | null;
  next: CareerCoreWriteExpectedSet;
  dirtyEditorCount: number;
  committedReceipt?: CareerCoreWriteReceipt;
  committedReceiptOwned?: boolean;
}>): "apply" | "defer" {
  if (input.dirtyEditorCount === 0 || !input.current ||
    sameCareerCoreExpectedSet(input.current, input.next)) return "apply";
  if (!input.committedReceipt || input.committedReceiptOwned !== true) return "defer";
  const authorized = careerCoreExpectedSetAfterReceipt(
    input.current,
    input.committedReceipt,
  );
  return authorized && sameCareerCoreExpectedSet(authorized, input.next)
    ? "apply"
    : "defer";
}

export function careerCoreGenerationChangeBarrier(
  markStale: () => void,
  reload: () => void,
): void {
  markStale();
  reload();
}

export function careerCoreHistoryBackDecision(
  hasVolatileWork: boolean,
  dirtyEditorCount: number,
): "continue" | "restore-block" | "restore-confirm" {
  if (hasVolatileWork) return "restore-block";
  return dirtyEditorCount > 0 ? "restore-confirm" : "continue";
}

export function careerCoreHistoryGuardResolution(
  hasRisk: boolean,
  hasGuard: boolean,
): "none" | "keep" | "consume" {
  if (!hasGuard) return "none";
  return hasRisk ? "keep" : "consume";
}

export const CAREER_DATABASE_MUTATION_OWNERS = [
  "core", "lifecycle", "task", "backup", "contact", "import", "material",
] as const;

export type CareerDatabaseMutationOwner =
  (typeof CAREER_DATABASE_MUTATION_OWNERS)[number];
export type CareerDatabaseMutationToken = Readonly<{
  owner: CareerDatabaseMutationOwner;
  nonce: symbol;
}>;

/**
 * Same-tick, owner-aware database mutation registry. A token is minted only
 * while the registry is empty; releasing a stale or foreign token is a no-op.
 * `isActiveExcept` lets the current owner recheck after an awaited prepare or
 * lock acquisition without deadlocking itself.
 */
export function createCareerDatabaseMutationRegistry() {
  const claims = new Map<CareerDatabaseMutationOwner, CareerDatabaseMutationToken>();
  return {
    tryClaim(owner: CareerDatabaseMutationOwner): CareerDatabaseMutationToken | null {
      if (claims.size > 0) return null;
      const token = Object.freeze({ owner, nonce: Symbol(`career-${owner}-mutation`) });
      claims.set(owner, token);
      return token;
    },
    release(token: CareerDatabaseMutationToken): boolean {
      if (claims.get(token.owner) !== token) return false;
      claims.delete(token.owner);
      return true;
    },
    isActiveExcept(owner: CareerDatabaseMutationOwner): boolean {
      for (const claimedOwner of claims.keys()) {
        if (claimedOwner !== owner) return true;
      }
      return false;
    },
    isOwned(token: CareerDatabaseMutationToken): boolean {
      return claims.get(token.owner) === token;
    },
    count(): number {
      return claims.size;
    },
    isActive(): boolean {
      return claims.size > 0;
    },
  } as const;
}

export function careerLifecycleTaskRecoveryAttention(input: Readonly<{
  heldReceiptCount: number;
  journalEntryCount: number;
  peerEntryCount: number;
  unreadableCount: number;
  storageUnavailable: boolean;
  lockUnavailable: boolean;
}>): boolean {
  return input.heldReceiptCount > 0 || input.journalEntryCount > 0 ||
    input.peerEntryCount > 0 || input.unreadableCount > 0 ||
    input.storageUnavailable || input.lockUnavailable;
}

/** @deprecated Use the token registry; kept as a compatibility facade for tests. */
export function createCareerCoreExternalMutationGate() {
  const claims = new Set<string>();
  return {
    set(key: string, claimed: boolean): number {
      if (claimed) claims.add(key);
      else claims.delete(key);
      return claims.size;
    },
    isActive(): boolean { return claims.size > 0; },
  } as const;
}

export async function runCareerCoreClaimedUiAction<Result>(
  operation: () => Promise<Result>,
  recover: (reason: unknown) => void,
  release: () => void,
): Promise<Result | undefined> {
  try {
    return await operation();
  } catch (reason) {
    recover(reason);
    return undefined;
  } finally {
    release();
  }
}

export type CareerCoreEditorSettlement = Readonly<{
  outcome: "saved" | "changed" | "discarded";
  receipt: CareerCoreWriteReceipt;
}>;

export type CareerCoreEditorSettlementLifecycle = Readonly<{
  onPrepared?: (receipt: CareerCoreWriteReceipt) => void;
  onSettled?: (settlement: CareerCoreEditorSettlement) => void;
  onAbandonChanged?: (receipt: CareerCoreWriteReceipt) => void;
}>;

function canonicalCareerCoreReceiptValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCareerCoreReceiptValue).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalCareerCoreReceiptValue(object[key])}`).join(",")}}`;
}

function careerCoreReceiptOwnershipKey(receipt: CareerCoreWriteReceipt): string {
  return canonicalCareerCoreReceiptValue(receipt);
}

/** Exact receipt ownership survives UI settlement until terminal journal removal. */
export function createCareerCoreEditorSettlementRegistry() {
  const ownedReceipts = new Map<string, string>();
  const callbacks = new Map<string, Readonly<{
    receiptKey: string;
    lifecycle: CareerCoreEditorSettlementLifecycle;
  }>>();
  const changedNotified = new Set<string>();
  return {
    remember(receipt: CareerCoreWriteReceipt, lifecycle?: CareerCoreEditorSettlementLifecycle) {
      const receiptKey = careerCoreReceiptOwnershipKey(receipt);
      ownedReceipts.set(receipt.operationId, receiptKey);
      if (!lifecycle) return;
      callbacks.set(receipt.operationId, { receiptKey, lifecycle });
      try { lifecycle.onPrepared?.(receipt); }
      catch { /* UI callbacks cannot weaken the durable receipt. */ }
    },
    ownsExact(receipt: CareerCoreWriteReceipt) {
      return ownedReceipts.get(receipt.operationId) ===
        careerCoreReceiptOwnershipKey(receipt);
    },
    notify(receipt: CareerCoreWriteReceipt, outcome: CareerCoreEditorSettlement["outcome"]) {
      const receiptKey = careerCoreReceiptOwnershipKey(receipt);
      if (ownedReceipts.get(receipt.operationId) !== receiptKey) return false;
      const registration = callbacks.get(receipt.operationId);
      const lifecycle = registration?.receiptKey === receiptKey
        ? registration.lifecycle
        : undefined;
      if (outcome === "changed") {
        if (changedNotified.has(receiptKey)) return true;
        changedNotified.add(receiptKey);
      } else {
        callbacks.delete(receipt.operationId);
        changedNotified.delete(receiptKey);
      }
      try { lifecycle?.onSettled?.({ outcome, receipt }); }
      catch { /* An unmounted editor does not change receipt authority. */ }
      return true;
    },
    abandonChanged(receipt: CareerCoreWriteReceipt) {
      const receiptKey = careerCoreReceiptOwnershipKey(receipt);
      if (ownedReceipts.get(receipt.operationId) !== receiptKey) return false;
      const registration = callbacks.get(receipt.operationId);
      try {
        if (registration?.receiptKey === receiptKey) {
          registration.lifecycle.onAbandonChanged?.(receipt);
        }
      }
      catch { /* Explicit abandonment still continues through refresh-only. */ }
      return true;
    },
    forget(receipt: CareerCoreWriteReceipt) {
      const receiptKey = careerCoreReceiptOwnershipKey(receipt);
      if (ownedReceipts.get(receipt.operationId) !== receiptKey) return false;
      ownedReceipts.delete(receipt.operationId);
      callbacks.delete(receipt.operationId);
      changedNotified.delete(receiptKey);
      return true;
    },
  } as const;
}

function canonicalSubset<Row extends Readonly<{ id: string }>>(
  rows: readonly Row[],
  canonical: ReadonlyMap<string, Row>,
  same: (left: Row, right: Row) => boolean,
): Row[] | null {
  const seen = new Set<string>();
  const result: Row[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) return null;
    seen.add(row.id);
    const expected = canonical.get(row.id);
    if (!expected || !same(row, expected)) return null;
    result.push(expected);
  }
  return result;
}

function createBindings(
  expected: CareerCoreWriteExpectedSet,
): CareerCoreBindings | null {
  const stages = uniqueById(expected.stages);
  const jobs = uniqueById(expected.jobs);
  const interviews = uniqueById(expected.interviews);
  if (!stages || !jobs || !interviews) return null;
  const stageBindings = new Map<string, {
    display: Readonly<Stage>;
    expected: CareerStageWriteExpectedState;
  }>();
  const jobBindings = new Map<string, {
    display: Readonly<Job>;
    expected: CareerJobWriteExpectedState;
  }>();
  const interviewBindings = new Map<string, {
    display: Readonly<Interview>;
    expected: CareerInterviewWriteExpectedState;
  }>();
  for (const stage of expected.stages) {
    stageBindings.set(stage.id, {
      display: stage,
      expected: {
        generationId: expected.generationId,
        generationSequence: expected.generationSequence,
        stage,
      },
    });
  }
  for (const job of expected.jobs) {
    const stage = stages.get(job.stage_id);
    if (!stage) return null;
    jobBindings.set(job.id, {
      display: job,
      expected: {
        generationId: expected.generationId,
        generationSequence: expected.generationSequence,
        job,
        stage,
      },
    });
  }
  for (const interview of expected.interviews) {
    const job = jobs.get(interview.job_id);
    const stage = job ? stages.get(job.stage_id) : null;
    if (!job || !stage) return null;
    interviewBindings.set(interview.id, {
      display: interview,
      expected: {
        generationId: expected.generationId,
        generationSequence: expected.generationSequence,
        interview,
        job,
        stage,
      },
    });
  }
  return {
    generationId: expected.generationId,
    generationSequence: expected.generationSequence,
    stages: stageBindings,
    jobs: jobBindings,
    interviews: interviewBindings,
  };
}

/**
 * E1/S/E2 truth gate. S may contain filtered subsets, but every displayed core
 * row must equal E2 and the full all-scope rows must be complete. The returned
 * snapshots reuse E2 objects, so click handlers can require object identity.
 */
export function createCareerCoreReadBundle(
  base: CareerData,
  all: CareerLifecycleSnapshot,
  scoped: CareerLifecycleSnapshot,
  expectedBefore: CareerCoreWriteExpectedSet,
  expectedAfter: CareerCoreWriteExpectedSet,
): CareerCoreReadBundle | null {
  if (!sameCareerCoreExpectedSet(expectedBefore, expectedAfter)) return null;
  const stages = uniqueById(expectedAfter.stages);
  const jobs = uniqueById(expectedAfter.jobs);
  const interviews = uniqueById(expectedAfter.interviews);
  const bindings = createBindings(expectedAfter);
  if (!stages || !jobs || !interviews || !bindings) return null;

  const baseStages = canonicalSubset(base.stages, stages, sameCareerCoreStage);
  const baseJobs = canonicalSubset(base.jobs, jobs, sameCareerCoreJob);
  const baseInterviews = canonicalSubset(
    base.interviews,
    interviews,
    sameCareerCoreInterview,
  );
  const allJobs = canonicalSubset(all.jobs, jobs, sameCareerCoreJob);
  const allInterviews = canonicalSubset(
    all.interviews,
    interviews,
    sameCareerCoreInterview,
  );
  const scopedJobs = canonicalSubset(scoped.jobs, jobs, sameCareerCoreJob);
  const scopedInterviews = canonicalSubset(
    scoped.interviews,
    interviews,
    sameCareerCoreInterview,
  );
  if (
    !baseStages || !baseJobs || !baseInterviews || !allJobs ||
    !allInterviews || !scopedJobs || !scopedInterviews ||
    baseStages.length !== expectedAfter.stages.length ||
    allJobs.length !== expectedAfter.jobs.length ||
    allInterviews.length !== expectedAfter.interviews.length
  ) return null;

  return {
    base: {
      ...base,
      stages: baseStages,
      jobs: baseJobs,
      interviews: baseInterviews,
    },
    all: { ...all, jobs: allJobs, interviews: allInterviews },
    scoped: {
      ...scoped,
      jobs: scopedJobs,
      interviews: scopedInterviews,
    },
    expectedSet: expectedAfter,
    bindings,
  };
}

export function getBoundCareerStageExpected(
  bindings: CareerCoreBindings,
  display: Stage,
): CareerStageWriteExpectedState | null {
  const binding = bindings.stages.get(display.id);
  return binding?.display === display ? binding.expected : null;
}

export function getBoundCareerJobExpected(
  bindings: CareerCoreBindings,
  display: Job,
): CareerJobWriteExpectedState | null {
  const binding = bindings.jobs.get(display.id);
  return binding?.display === display ? binding.expected : null;
}

export function getBoundCareerInterviewExpected(
  bindings: CareerCoreBindings,
  display: Interview,
): CareerInterviewWriteExpectedState | null {
  const binding = bindings.interviews.get(display.id);
  return binding?.display === display ? binding.expected : null;
}

export function careerCoreReceiptEntityId(
  receipt: CareerCoreWriteReceipt,
): string {
  switch (receipt.kind) {
    case "stage-rename": return receipt.after.stage.id;
    case "job-create": return receipt.after.job.id;
    case "job-update": return receipt.after.job.id;
    case "interview-create": return receipt.after.interview.id;
    case "interview-update": return receipt.after.interview.id;
  }
}

export function sameCareerInterviewExpectedState(
  left: CareerInterviewWriteExpectedState,
  right: CareerInterviewWriteExpectedState,
): boolean {
  return left.generationId === right.generationId &&
    left.generationSequence === right.generationSequence &&
    sameCareerCoreInterview(left.interview, right.interview) &&
    sameCareerCoreJob(left.job, right.job) &&
    sameCareerCoreStage(left.stage, right.stage);
}

export function careerInterviewDraftRestoreMode(
  draft: CareerInterviewLocalDraftV2,
  current: CareerInterviewWriteExpectedState,
): "auto" | "confirm" {
  return draft.interviewId === current.interview.id &&
    sameCareerInterviewExpectedState(draft.source, current)
    ? "auto"
    : "confirm";
}

export function careerCoreWritePreflightOpen(input: Readonly<{
  journalLoaded: boolean;
  storageUnavailable: boolean;
  lockUnavailable: boolean;
  unreadableCount: number;
  entryCount: number;
  hasHeldReceipt: boolean;
  operationInProgress: boolean;
  snapshotStale: boolean;
  externalWriteLocked: boolean;
}>): boolean {
  return input.journalLoaded && !input.storageUnavailable &&
    !input.lockUnavailable && input.unreadableCount === 0 &&
    input.entryCount === 0 && !input.hasHeldReceipt &&
    !input.operationInProgress && !input.snapshotStale &&
    !input.externalWriteLocked;
}

export function careerCoreUnloadRisk(input: Readonly<{
  operationInProgress: boolean;
  dirtyEditorCount: number;
  volatileHeldReceipt: boolean;
}>): boolean {
  return input.operationInProgress || input.dirtyEditorCount > 0 ||
    input.volatileHeldReceipt;
}

export function careerCoreBackupGate(input: Readonly<{
  busy: boolean;
  hasHeldReceipt: boolean;
  journalLoaded: boolean;
  storageUnavailable: boolean;
  lockUnavailable: boolean;
  unreadableCount: number;
  entryCount: number;
  snapshotStale: boolean;
}>): boolean {
  return input.busy || input.hasHeldReceipt || !input.journalLoaded ||
    input.storageUnavailable || input.lockUnavailable ||
    input.unreadableCount > 0 || input.entryCount > 0 || input.snapshotStale;
}
