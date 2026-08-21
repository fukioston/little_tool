function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function toLocalDateTimeInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new TypeError("日期时间无效");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function localDayBounds(timestamp: number): Readonly<{ start: number; end: number }> {
  const start = new Date(timestamp);
  if (!Number.isFinite(start.getTime())) throw new TypeError("日期无效");
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}
