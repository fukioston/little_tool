export function formatFitnessStorageBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return "暂时未知";
  }
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted = value >= 10 || unitIndex === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${formatted} ${units[unitIndex]}`;
}

export function resolveFitnessNavigationBehavior(prefersReducedMotion: boolean): ScrollBehavior {
  return prefersReducedMotion ? "auto" : "smooth";
}

export function resolveScheduledFitnessStartRoute(
  currentVenueId: string | null,
  plannedVenueId: string | null,
): "missing-planned-venue" | "start-planned" | "choose-venue" {
  if (!plannedVenueId) return "missing-planned-venue";
  return currentVenueId === plannedVenueId ? "start-planned" : "choose-venue";
}

export function resolveFitnessPainDraftAfterRecord(current: string, persisted: boolean): string {
  return persisted ? "" : current;
}

export async function runFitnessPersistThenRefresh<T>(
  persist: () => Promise<T>,
  refresh: () => Promise<void>,
): Promise<Readonly<{ status: "refreshed" | "refresh-failed"; value: T }>> {
  const value = await persist();
  try {
    await refresh();
    return { status: "refreshed", value };
  } catch {
    return { status: "refresh-failed", value };
  }
}
