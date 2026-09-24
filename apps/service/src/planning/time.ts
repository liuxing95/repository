import { TaskDay, TaskZone } from "@kb/contracts";
import { deadlineExclusive } from "../tasks/capture";

export const intersects = (
  a: { start: number; end: number },
  b: { start: number; end: number },
) => a.start < b.end && b.start < a.end;
export function localDayStart(day: string, zone: string): number {
  TaskDay.parse(day);
  TaskZone.parse(zone);
  const preceding = new Date(`${day}T12:00:00Z`);
  preceding.setUTCDate(preceding.getUTCDate() - 1);
  return deadlineExclusive(preceding.toISOString().slice(0, 10), zone);
}
export function taskDeadline(raw: string | null, zone: string): number | null {
  if (!raw) return null;
  if (TaskDay.safeParse(raw).success) return deadlineExclusive(raw, zone);
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
}
export function normalize(ranges: { start: number; end: number }[]) {
  const sorted = ranges
    .filter((r) => r.start < r.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result: { start: number; end: number }[] = [];
  for (const range of sorted) {
    const last = result.at(-1);
    if (last && range.start <= last.end)
      last.end = Math.max(last.end, range.end);
    else result.push({ ...range });
  }
  return result;
}
export function subtract(
  windows: { start: number; end: number }[],
  busy: { start: number; end: number }[],
) {
  const result: { start: number; end: number }[] = [];
  for (const window of normalize(windows)) {
    let cursor = window.start;
    for (const b of normalize(busy)) {
      if (b.end <= cursor || b.start >= window.end) continue;
      if (cursor < b.start)
        result.push({ start: cursor, end: Math.min(b.start, window.end) });
      cursor = Math.max(cursor, b.end);
      if (cursor >= window.end) break;
    }
    if (cursor < window.end) result.push({ start: cursor, end: window.end });
  }
  return result;
}
