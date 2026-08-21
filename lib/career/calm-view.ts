import type { Interview, Task } from "@/lib/career/types";

export type CareerJobNextItem =
  | Readonly<{ kind: "interview"; at: string; interview: Interview }>
  | Readonly<{ kind: "task"; at: string | null; task: Task }>
  | null;

function futureInstant(value: string | null, now: number) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp >= now ? timestamp : null;
}

/** A watched job is a quiet personal marker, not a three-level score. */
export function careerJobIsWatched(priority: number) {
  return Number.isFinite(priority) && priority >= 2;
}

/**
 * Pick one truthful next item for a job card. Past dates never masquerade as
 * the next step; an undated task remains a valid "time undecided" intention.
 */
export function resolveCareerJobNextItem(
  jobId: string,
  tasks: readonly Task[],
  interviews: readonly Interview[],
  now: number,
): CareerJobNextItem {
  const candidates: Array<
    | { kind: "interview"; timestamp: number; at: string; interview: Interview }
    | { kind: "task"; timestamp: number; at: string | null; task: Task }
  > = [];

  for (const interview of interviews) {
    if (interview.job_id !== jobId || interview.status !== "scheduled") continue;
    const timestamp = futureInstant(interview.scheduled_at, now);
    if (timestamp === null || !interview.scheduled_at) continue;
    candidates.push({ kind: "interview", timestamp, at: interview.scheduled_at, interview });
  }

  for (const task of tasks) {
    if (task.job_id !== jobId || task.status !== "todo") continue;
    if (!task.due_at) {
      candidates.push({ kind: "task", timestamp: Number.POSITIVE_INFINITY, at: null, task });
      continue;
    }
    const timestamp = futureInstant(task.due_at, now);
    if (timestamp === null) continue;
    candidates.push({ kind: "task", timestamp, at: task.due_at, task });
  }

  candidates.sort((left, right) =>
    left.timestamp - right.timestamp ||
    (left.kind === right.kind ? 0 : left.kind === "interview" ? -1 : 1) ||
    (left.kind === "interview" ? left.interview.id : left.task.id)
      .localeCompare(right.kind === "interview" ? right.interview.id : right.task.id),
  );

  const first = candidates[0];
  if (!first) return null;
  return first.kind === "interview"
    ? Object.freeze({ kind: "interview", at: first.at, interview: first.interview })
    : Object.freeze({ kind: "task", at: first.at, task: first.task });
}
