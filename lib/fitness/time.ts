function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function toLocalDateTimeInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new TypeError("日期时间无效");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type LocalDateTimeResolution =
  | Readonly<{ status: "valid"; timestamp: number }>
  | Readonly<{ status: "invalid" | "nonexistent" | "ambiguous" }>;

/**
 * Resolve a timezone-less `datetime-local` value without silently normalizing a
 * daylight-saving gap or choosing one side of a repeated wall-clock time.
 * Passing the original timestamp preserves its exact offset when the user has
 * not changed the visible value.
 */
export function resolveLocalDateTimeInput(
  value: string,
  originalTimestamp?: number,
): LocalDateTimeResolution {
  if (originalTimestamp !== undefined && toLocalDateTimeInputValue(originalTimestamp) === value) {
    return { status: "valid", timestamp: originalTimestamp };
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return { status: "invalid" };
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return { status: "invalid" };
  if (toLocalDateTimeInputValue(timestamp) !== value) return { status: "nonexistent" };

  let matches = 0;
  for (let minuteDelta = -180; minuteDelta <= 180; minuteDelta += 1) {
    if (toLocalDateTimeInputValue(timestamp + minuteDelta * 60_000) === value) matches += 1;
    if (matches > 1) return { status: "ambiguous" };
  }
  return { status: "valid", timestamp };
}

export function localDayBounds(timestamp: number): Readonly<{ start: number; end: number }> {
  const start = new Date(timestamp);
  if (!Number.isFinite(start.getTime())) throw new TypeError("日期无效");
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}
