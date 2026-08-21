export type FitnessFactsRefreshOutcome = "applied" | "deferred" | "superseded";

export function fitnessFactsRefreshApplied(outcome: FitnessFactsRefreshOutcome) {
  return outcome === "applied";
}

export function resolveFitnessFactsRead(
  requestId: number,
  latestRequestId: number,
  hasDirtyConflict: boolean,
): FitnessFactsRefreshOutcome {
  if (requestId !== latestRequestId) return "superseded";
  return hasDirtyConflict ? "deferred" : "applied";
}

export function shouldMarkFitnessFactsReadStale(requestId: number, latestRequestId: number) {
  return requestId === latestRequestId;
}

export function fitnessActiveSessionRouteChanged(
  before: readonly Readonly<{ id: string; status: string }>[],
  after: readonly Readonly<{ id: string; status: string }>[],
) {
  const route = (sessions: readonly Readonly<{ id: string; status: string }>[]) => sessions
    .filter(({ status }) => status === "active")
    .map(({ id }) => id)
    .sort();
  return JSON.stringify(route(before)) !== JSON.stringify(route(after));
}

export function fitnessDirtyConfigDialogBlocksRouteChange(
  dialogDirty: boolean,
  before: readonly Readonly<{ id: string; status: string }>[],
  after: readonly Readonly<{ id: string; status: string }>[],
) {
  return dialogDirty && fitnessActiveSessionRouteChanged(before, after);
}

export function resolveFitnessReflectionDraftAction(
  snapshotPending: boolean,
  action: "change" | "cancel",
  matchesExpected: boolean,
) {
  if (action === "cancel") return { dirty: false, applyPending: snapshotPending } as const;
  if (snapshotPending && matchesExpected) return { dirty: false, applyPending: true } as const;
  return {
    dirty: !matchesExpected,
    applyPending: false,
  } as const;
}
