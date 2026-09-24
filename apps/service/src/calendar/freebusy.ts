import { Instant, type TimeRange, type CalendarCoverage } from "@kb/contracts";
import { digest } from "../workspace/registry";

export type BusyProvider = (
  calendarIds: string[],
  start: number,
  end: number,
) => Promise<unknown>;
export function parseFreeBusy(
  raw: unknown,
  ids: string[],
  planCalendarId: string | null,
  start: number,
  end: number,
  checkedAt: number,
): { busy: TimeRange[]; coverage: CalendarCoverage } {
  const required = ids.filter((id) => id !== planCalendarId);
  const calendars =
    raw && typeof raw === "object" && "calendars" in raw
      ? (raw as { calendars?: Record<string, unknown> }).calendars
      : undefined;
  const busy: TimeRange[] = [];
  let unknown = !calendars;
  for (const id of required) {
    const entry = calendars?.[id] as
      | { errors?: unknown[]; busy?: { start: string; end: string }[] }
      | undefined;
    if (
      !entry ||
      !Array.isArray(entry.busy) ||
      entry.busy.length > 10000 ||
      (entry.errors !== undefined && !Array.isArray(entry.errors)) ||
      (entry.errors?.length ?? 0) > 0
    ) {
      unknown = true;
      continue;
    }
    for (const item of entry.busy) {
      if (
        !item ||
        typeof item !== "object" ||
        !Instant.safeParse(item.start).success ||
        !Instant.safeParse(item.end).success
      ) {
        unknown = true;
        continue;
      }
      const a = Date.parse(item.start),
        b = Date.parse(item.end);
      if (
        !Number.isFinite(a) ||
        !Number.isFinite(b) ||
        a >= b ||
        a < start ||
        b > end
      ) {
        unknown = true;
        continue;
      }
      busy.push({ start: a, end: b });
    }
  }
  const coverage: CalendarCoverage = {
    state: unknown ? "unknown" : "complete",
    calendarIds: required,
    checkedAt,
    reason: unknown
      ? "至少一个日历未完整返回忙闲；不能把未知时段当空闲。"
      : "已核对所选外部日历。",
    hash: digest({ required, start, end, busy, unknown }),
  };
  return { busy, coverage };
}
export async function readBusy(
  provider: BusyProvider | undefined,
  ids: string[],
  start: number,
  end: number,
  at: number,
  planCalendarId: string | null = null,
) {
  const required = [...new Set(ids)].filter((id) => id !== planCalendarId);
  if (!required.length)
    return {
      busy: [] as TimeRange[],
      coverage: {
        state: "unconnected",
        calendarIds: [],
        checkedAt: null,
        reason: "未核对外部日历。",
        hash: digest("unconnected"),
      } satisfies CalendarCoverage,
    };
  if (!provider)
    return {
      busy: [] as TimeRange[],
      coverage: {
        state: "unknown",
        calendarIds: required,
        checkedAt: null,
        reason: "已选外部日历，但未配置可用的只读适配器。",
        hash: digest({ required, unavailable: true }),
      } satisfies CalendarCoverage,
    };
  try {
    return parseFreeBusy(
      await provider(required, start, end),
      required,
      planCalendarId,
      start,
      end,
      at,
    );
  } catch {
    return {
      busy: [] as TimeRange[],
      coverage: {
        state: "unknown",
        calendarIds: required,
        checkedAt: null,
        reason: "外部日历读取失败。",
        hash: digest({ required, failed: true }),
      } satisfies CalendarCoverage,
    };
  }
}
