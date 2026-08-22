import type {
  VocabBookmarkCreateInput,
  VocabBookmarkCreateReceipt,
  VocabBookmarkExpectedState,
  VocabEngagementGenerationExpectation,
  VocabEngagementWriteReceipt,
  VocabPreparedStudyActivityInput,
  VocabStudyActivityRecordInput,
} from "@/lib/vocab/store";

export const VOCAB_ENGAGEMENT_ACTIVITY_MAX_SECONDS = 86_400;

export type VocabEngagementApplyOutcome =
  | "applied"
  | "deferred"
  | "superseded";

export type VocabQueuedStudyActivity = Readonly<{
  sequence: number;
  input: VocabPreparedStudyActivityInput;
  displayedGeneration: VocabEngagementGenerationExpectation;
  timezoneOffsetMinutes: number;
  localDay: string;
}>;

export type VocabBookmarkIntent = Readonly<{
  input: VocabBookmarkCreateInput;
  expected: VocabBookmarkExpectedState;
}>;

export type VocabEngagementPreparedIntentResult<Receipt> =
  | Readonly<{ outcome: "ready"; receipt: Receipt }>
  | Readonly<{
      outcome: "external-blocked";
      stage: "before-prepare" | "after-prepare";
    }>
  | Readonly<{ outcome: "receipt-mismatch" }>;

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function deepFreezeJsonValue<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeJsonValue(child);
    Object.freeze(value);
  }
  return value;
}

function cloneJsonValue<Value>(value: Value, label: string): Value {
  try {
    const raw = JSON.stringify(value);
    if (raw === undefined) throw new Error("not JSON");
    return deepFreezeJsonValue(JSON.parse(raw) as Value);
  } catch {
    throw new Error(`${label}必须是完整、可冻结的 JSON 数据。`);
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" ||
      typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) {
    return false;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] &&
      sameJsonValue(leftRecord[key], rightRecord[key])
    );
}

export function vocabEngagementExternalWriteBlocked(
  externalWriteLocked: boolean,
  externalWriteInProgress: () => boolean,
): boolean {
  if (externalWriteLocked) return true;
  try {
    return externalWriteInProgress();
  } catch {
    return true;
  }
}

export async function prepareVocabEngagementIntent<Receipt>(
  externalWriteBlocked: () => boolean,
  prepare: () => Promise<Receipt>,
  receiptMatches: (receipt: Receipt) => boolean,
): Promise<VocabEngagementPreparedIntentResult<Receipt>> {
  const blocked = () => {
    try {
      return externalWriteBlocked();
    } catch {
      return true;
    }
  };
  if (blocked()) {
    return { outcome: "external-blocked", stage: "before-prepare" };
  }
  const receipt = await prepare();
  if (blocked()) {
    return { outcome: "external-blocked", stage: "after-prepare" };
  }
  try {
    return receiptMatches(receipt)
      ? { outcome: "ready", receipt }
      : { outcome: "receipt-mismatch" };
  } catch {
    return { outcome: "receipt-mismatch" };
  }
}

export function freezeVocabBookmarkIntent(
  input: VocabBookmarkCreateInput,
  expected: VocabBookmarkExpectedState,
): VocabBookmarkIntent {
  return {
    input: cloneJsonValue(input, "书签输入"),
    expected: cloneJsonValue(expected, "书签读取快照"),
  };
}

export function vocabBookmarkReceiptMatchesIntent(
  receipt: VocabBookmarkCreateReceipt,
  intent: VocabBookmarkIntent,
): boolean {
  return receipt.purpose === "vocab-engagement-write" &&
    receipt.version === 1 && receipt.kind === "bookmark-create" &&
    sameJsonValue(receipt.request, intent.input) &&
    sameJsonValue(receipt.expected, intent.expected) &&
    receipt.generationId === intent.expected.generationId &&
    receipt.generationSequence === intent.expected.generationSequence &&
    receipt.target.item_id === intent.input.itemId &&
    receipt.target.locator === intent.input.locator &&
    receipt.target.label === intent.input.label &&
    receipt.target.note === "" &&
    exactKeys(receipt.target, [
      "id", "item_id", "locator", "label", "note", "created_at",
    ]);
}

export function vocabEngagementLocalDay(
  recordedAt: number,
  timezoneOffsetMinutes: number,
): string | null {
  if (
    !safeTimestamp(recordedAt) ||
    !Number.isSafeInteger(timezoneOffsetMinutes) ||
    timezoneOffsetMinutes < -1_440 || timezoneOffsetMinutes > 1_440
  ) return null;
  const shifted = recordedAt - timezoneOffsetMinutes * 60_000;
  if (!Number.isSafeInteger(shifted)) return null;
  try {
    const day = new Date(shifted).toISOString().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  } catch {
    return null;
  }
}

export function sameVocabEngagementGeneration(
  left: VocabEngagementGenerationExpectation,
  right: VocabEngagementGenerationExpectation,
): boolean {
  return left.generationId === right.generationId &&
    left.generationSequence === right.generationSequence;
}

export function freezeVocabStudyActivity(
  inputValue: VocabStudyActivityRecordInput,
  displayedGenerationValue: VocabEngagementGenerationExpectation,
  sequence: number,
  now = Date.now(),
  timezoneOffsetAt: (timestamp: number) => number = (timestamp) =>
    new Date(timestamp).getTimezoneOffset(),
): VocabQueuedStudyActivity {
  const inputKeys = ["kind", "seconds"];
  if (inputValue.recordedAt !== undefined) inputKeys.push("recordedAt");
  if (inputValue.timezoneOffsetMinutes !== undefined) {
    inputKeys.push("timezoneOffsetMinutes");
  }
  if (
    !inputValue || typeof inputValue !== "object" ||
    !exactKeys(inputValue, inputKeys) ||
    (inputValue.kind !== "read" && inputValue.kind !== "listen") ||
    !Number.isSafeInteger(inputValue.seconds) || inputValue.seconds < 1 ||
    inputValue.seconds > VOCAB_ENGAGEMENT_ACTIVITY_MAX_SECONDS
  ) {
    throw new Error("学习时间片必须是 1 到 86400 秒的完整记录。");
  }
  if (
    !displayedGenerationValue ||
    typeof displayedGenerationValue !== "object" ||
    !exactKeys(displayedGenerationValue, ["generationId", "generationSequence"]) ||
    typeof displayedGenerationValue.generationId !== "string" ||
    displayedGenerationValue.generationId.length === 0 ||
    !Number.isSafeInteger(displayedGenerationValue.generationSequence) ||
    displayedGenerationValue.generationSequence < 0
  ) {
    throw new Error("当前显示的数据库世代无效；没有排入学习时间。");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("学习时间片序号无效；没有排入学习时间。");
  }
  const recordedAt = inputValue.recordedAt ?? now;
  if (!safeTimestamp(recordedAt)) {
    throw new Error("学习时间片的记录时间无效；没有排入写入队列。");
  }
  if (
    inputValue.timezoneOffsetMinutes !== undefined &&
    (
      inputValue.recordedAt === undefined ||
      !Number.isSafeInteger(inputValue.timezoneOffsetMinutes) ||
      inputValue.timezoneOffsetMinutes < -1_440 ||
      inputValue.timezoneOffsetMinutes > 1_440
    )
  ) {
    throw new Error("学习时间片的时区偏移无效；没有排入写入队列。");
  }
  const timezoneOffsetMinutes = inputValue.timezoneOffsetMinutes ??
    timezoneOffsetAt(recordedAt);
  const localDay = vocabEngagementLocalDay(
    recordedAt,
    timezoneOffsetMinutes,
  );
  if (localDay === null) {
    throw new Error("无法冻结学习时间片的本地日期；没有排入写入队列。");
  }
  return deepFreezeJsonValue({
    sequence,
    input: {
      kind: inputValue.kind,
      seconds: inputValue.seconds,
      recordedAt,
    },
    displayedGeneration: {
      generationId: displayedGenerationValue.generationId,
      generationSequence: displayedGenerationValue.generationSequence,
    },
    timezoneOffsetMinutes,
    localDay,
  });
}

export function vocabStudyActivityTimezoneStillMatches(
  activity: VocabQueuedStudyActivity,
  timezoneOffsetAt: (timestamp: number) => number = (timestamp) =>
    new Date(timestamp).getTimezoneOffset(),
): boolean {
  return timezoneOffsetAt(activity.input.recordedAt) ===
      activity.timezoneOffsetMinutes &&
    vocabEngagementLocalDay(
      activity.input.recordedAt,
      activity.timezoneOffsetMinutes,
    ) === activity.localDay;
}

export function vocabStudyActivityLogicalKey(
  activity: VocabQueuedStudyActivity,
): string {
  return JSON.stringify([
    activity.input.kind,
    activity.input.seconds,
    activity.input.recordedAt,
    activity.displayedGeneration.generationId,
    activity.displayedGeneration.generationSequence,
    activity.timezoneOffsetMinutes,
    activity.localDay,
  ]);
}

export function vocabStudyActivityReceiptMatchesQueue(
  receipt: VocabEngagementWriteReceipt,
  activity: VocabQueuedStudyActivity,
): boolean {
  if (
    receipt.purpose !== "vocab-engagement-write" ||
    receipt.version !== 1 || receipt.kind !== "study-activity-record"
  ) return false;
  const readSeconds = activity.input.kind === "read"
    ? activity.input.seconds
    : 0;
  const listenSeconds = activity.input.kind === "listen"
    ? activity.input.seconds
    : 0;
  return sameJsonValue(receipt.request, activity.input) &&
    sameJsonValue(receipt.expected, activity.displayedGeneration) &&
    receipt.generationId === activity.displayedGeneration.generationId &&
    receipt.generationSequence ===
      activity.displayedGeneration.generationSequence &&
    receipt.timezoneOffsetMinutes === activity.timezoneOffsetMinutes &&
    receipt.target.day === activity.localDay &&
    receipt.target.created_at === activity.input.recordedAt &&
    receipt.target.read_seconds === readSeconds &&
    receipt.target.listen_seconds === listenSeconds &&
    receipt.target.review_count === 0 && receipt.target.lookups === 0 &&
    exactKeys(receipt.target, [
      "id", "day", "read_seconds", "listen_seconds", "review_count",
      "lookups", "created_at",
    ]);
}

export function vocabStudyActivitiesShareBucket(
  left: VocabQueuedStudyActivity,
  right: VocabQueuedStudyActivity,
): boolean {
  return left.input.kind === right.input.kind &&
    sameVocabEngagementGeneration(
      left.displayedGeneration,
      right.displayedGeneration,
    ) &&
    left.timezoneOffsetMinutes === right.timezoneOffsetMinutes &&
    left.localDay === right.localDay &&
    left.input.seconds + right.input.seconds <=
      VOCAB_ENGAGEMENT_ACTIVITY_MAX_SECONDS;
}

export function removeVocabStudyActivityHead(
  queue: readonly VocabQueuedStudyActivity[],
  submitted: VocabQueuedStudyActivity,
): readonly VocabQueuedStudyActivity[] {
  return queue[0]?.sequence === submitted.sequence ? queue.slice(1) : queue;
}

export function vocabEngagementWritePreflightOpen(input: Readonly<{
  journalLoaded: boolean;
  storageUnavailable: boolean;
  lockUnavailable: boolean;
  unreadableCount: number;
  entryCount: number;
  hasHeldReceipt: boolean;
  operationInProgress: boolean;
  externalWriteLocked: boolean;
}>): boolean {
  return input.journalLoaded && !input.storageUnavailable &&
    !input.lockUnavailable && input.unreadableCount === 0 &&
    input.entryCount === 0 && !input.hasHeldReceipt &&
    !input.operationInProgress && !input.externalWriteLocked;
}

export function vocabEngagementBackupGate(input: Readonly<{
  journalLoaded: boolean;
  storageUnavailable: boolean;
  lockUnavailable: boolean;
  unreadableCount: number;
  entryCount: number;
  busy: boolean;
  queuedActivityCount: number;
  hasHeldReceipt: boolean;
  hasVolatileHeldReceipt: boolean;
}>): Readonly<{ blocked: boolean; volatile: boolean }> {
  const volatile = input.busy || input.queuedActivityCount > 0 ||
    input.hasVolatileHeldReceipt;
  return {
    volatile,
    blocked: volatile || input.hasHeldReceipt || !input.journalLoaded ||
      input.storageUnavailable || input.lockUnavailable ||
      input.unreadableCount > 0 || input.entryCount > 0,
  };
}

export function vocabEngagementUnloadRisk(input: Readonly<{
  busy: boolean;
  queuedActivityCount: number;
  hasVolatileHeldReceipt: boolean;
}>): boolean {
  return input.busy || input.queuedActivityCount > 0 ||
    input.hasVolatileHeldReceipt;
}

export function vocabEngagementReceiptIsActivity(
  receipt: VocabEngagementWriteReceipt,
): boolean {
  return receipt.kind === "study-activity-record";
}

export function vocabEngagementApplyRemovesTicket(
  outcome: VocabEngagementApplyOutcome,
): boolean {
  return outcome === "applied";
}
