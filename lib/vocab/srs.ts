import type { Lexeme, ReviewCard, ReviewRating } from "./types";

export type ReviewSchedulingCard = Pick<
  ReviewCard,
  | "state"
  | "due_at"
  | "interval_days"
  | "ease"
  | "reps"
  | "lapses"
  | "last_review_at"
>;

export type ReviewScheduleV2 = ReviewSchedulingCard & Readonly<{
  algorithm_version: 2;
}>;

export type ReviewSuspension = Pick<
  ReviewCard,
  "state" | "suspended_from_state" | "suspended_reason"
>;

const DAY_MS = 86_400_000;
const MANAGED_SUSPENSION_REASONS = new Set([
  "missing_explanation",
  "lexeme_known",
  "lexeme_ignored",
]);
const EMPTY_EXPLANATION_LABELS = new Set([
  "n/a",
  "na",
  "none",
  "null",
  "unknown",
  "undefined",
  "not available",
  "no definition",
  "no definition yet",
  "no explanation",
  "no explanation yet",
  "no english gloss returned",
]);

function finiteAtLeast(value: number, minimum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

export function scheduleReviewV2(
  card: ReviewSchedulingCard,
  rating: ReviewRating,
  reviewedAt = Date.now(),
): ReviewScheduleV2 {
  const previousInterval = finiteAtLeast(card.interval_days, 0, 0);
  const previousEase = finiteAtLeast(card.ease, 1.3, 2.5);
  const previousReps = Math.floor(finiteAtLeast(card.reps, 0, 0));
  const previousLapses = Math.floor(finiteAtLeast(card.lapses, 0, 0));
  let intervalDays = previousInterval;
  let ease = previousEase;
  let state: ReviewCard["state"] = "review";
  let lapses = previousLapses;

  if (rating === "again") {
    intervalDays = 10 / 1440;
    ease = Math.max(1.3, previousEase - 0.2);
    state = previousReps > 0 ? "relearning" : "learning";
    if (previousReps > 0) lapses += 1;
  } else if (rating === "hard") {
    intervalDays = Math.max(1, previousInterval > 0 ? previousInterval * 1.2 : 1);
    ease = Math.max(1.3, previousEase - 0.05);
  } else if (rating === "good") {
    intervalDays = Math.max(1, previousInterval > 0 ? previousInterval * previousEase : 1);
  } else {
    intervalDays = Math.max(
      4,
      previousInterval > 0 ? previousInterval * (previousEase + 0.35) : 4,
    );
    ease = Math.min(3.2, previousEase + 0.1);
  }

  return {
    state,
    due_at: reviewedAt + intervalDays * DAY_MS,
    interval_days: intervalDays,
    ease,
    reps: previousReps + 1,
    lapses,
    last_review_at: reviewedAt,
    algorithm_version: 2,
  };
}

export function applyDailyNewLimit(
  cards: readonly ReviewCard[],
  dailyNewLimit: number,
  reviewedNewToday: number,
  now = Date.now(),
): ReviewCard[] {
  let remaining = Math.max(
    0,
    Math.floor(finiteAtLeast(dailyNewLimit, 0, 0)) -
      Math.floor(finiteAtLeast(reviewedNewToday, 0, 0)),
  );
  return cards.map((card) => {
    if (card.state === "suspended") return { ...card, queue_eligible: false };
    if (card.state !== "new" || card.due_at > now) {
      return { ...card, queue_eligible: true };
    }
    const eligible = remaining > 0;
    if (eligible) remaining -= 1;
    return { ...card, queue_eligible: eligible };
  });
}

export function lexemeStatusSuspendsReview(status: Lexeme["status"]): boolean {
  return status === "known" || status === "ignored";
}

export function hasUsefulEnglishExplanation(...values: readonly string[]): boolean {
  return values.some((value) => {
    const normalized = value.trim().toLocaleLowerCase("en").replace(/[.!?]+$/, "");
    if (!normalized || EMPTY_EXPLANATION_LABELS.has(normalized)) return false;
    return (normalized.match(/[a-z]/g) ?? []).length >= 2;
  });
}

export function reconcileReviewSuspension(
  card: ReviewSuspension,
  status: Lexeme["status"],
  hasExplanation: boolean,
): ReviewSuspension {
  const managed = card.suspended_reason !== null &&
    MANAGED_SUSPENSION_REASONS.has(card.suspended_reason);
  if (lexemeStatusSuspendsReview(status)) {
    if (card.state === "suspended" && !managed) return card;
    return {
      state: "suspended",
      suspended_from_state: card.state === "suspended"
        ? card.suspended_from_state ?? "new"
        : card.state,
      suspended_reason: `lexeme_${status}`,
    };
  }
  if (!hasExplanation) {
    if (card.state === "suspended" && !managed) return card;
    return {
      state: "suspended",
      suspended_from_state: card.state === "suspended"
        ? card.suspended_from_state ?? "new"
        : card.state,
      suspended_reason: "missing_explanation",
    };
  }
  if (card.state === "suspended" && managed) {
    return {
      state: card.suspended_from_state ?? "new",
      suspended_from_state: null,
      suspended_reason: null,
    };
  }
  return card.state === "suspended"
    ? card
    : { state: card.state, suspended_from_state: null, suspended_reason: null };
}

export function createContextCloze(sentence: string, surface: string): string {
  const target = surface.trim();
  if (!sentence || !target) return sentence;
  const index = sentence.toLocaleLowerCase("en").indexOf(target.toLocaleLowerCase("en"));
  if (index < 0) return sentence;
  return `${sentence.slice(0, index)}____${sentence.slice(index + target.length)}`;
}

export function localDayKey(timestamp = Date.now()): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function localDayBounds(timestamp = Date.now()): Readonly<{
  start: number;
  end: number;
}> {
  const date = new Date(timestamp);
  const start = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const end = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1,
  ).getTime();
  return { start, end };
}

export function reviewEventStartedAsNew(beforeJson: string): boolean {
  try {
    const value = JSON.parse(beforeJson) as { state?: unknown };
    return value.state === "new";
  } catch {
    return false;
  }
}
