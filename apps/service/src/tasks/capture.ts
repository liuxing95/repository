import { TaskDay, TaskDraft, TaskZone } from "@kb/contracts";
// Date-only upper bound: binary search the next local calendar day, including DST transitions.
export function deadlineExclusive(day: string, timezone: string) {
  TaskDay.parse(day);
  TaskZone.parse(timezone);
  const date = new Date(day);
  date.setUTCDate(date.getUTCDate() + 1);
  const next = date.toISOString().slice(0, 10);
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const local = (at: number) => {
    const p = format.formatToParts(at),
      g = (s: string) => p.find((x) => x.type === s)!.value;
    return `${g("year")}-${g("month")}-${g("day")}`;
  };
  let low = +date - 36 * 3600000,
    high = +date + 36 * 3600000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (local(mid) < next) low = mid + 1;
    else high = mid;
  }
  return low;
}
export function capture(raw: unknown) {
  const input = TaskDraft.parse(raw);
  return {
    input,
    provenance: Object.fromEntries(
      Object.keys(input).map((key) => [key, "用户表单确认"]),
    ),
    deadlineExclusive: input.deadlineDay
      ? deadlineExclusive(input.deadlineDay, input.timezone)
      : null,
  };
}

// Deliberately bounded local extraction; every inferred field remains a candidate.
export function textCapture(text: string, timezone: string, now = Date.now()) {
  TaskZone.parse(timezone);
  if (!text.trim() || text.length > 500) throw new Error("VALIDATION");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (name: string) => parts.find((p) => p.type === name)!.value;
  const date = new Date(
    `${get("year")}-${get("month")}-${get("day")}T12:00:00Z`,
  );
  const phrase = text.match(/后天|明天|今天/)?.[0];
  if (phrase)
    date.setUTCDate(
      date.getUTCDate() + ({ 今天: 0, 明天: 1, 后天: 2 }[phrase] ?? 0),
    );
  const minutesMatch = text.match(/(\d{1,4})\s*分钟/),
    minutes = minutesMatch ? Number(minutesMatch[1]) : null;
  return {
    input: TaskDraft.parse({
      title: text.trim(),
      desiredDay: phrase ? date.toISOString().slice(0, 10) : null,
      earliestDay: null,
      deadlineDay: null,
      timezone,
      minutes: minutes && minutes <= 1440 ? minutes : null,
      details: "",
    }),
    provenance: {
      title: "原文",
      desiredDay: phrase
        ? `原文“${phrase}”，按所选时区生成的建议，需确认`
        : "未推断",
      earliestDay: "未推断",
      deadlineDay: "未推断；硬截止必须人工确认",
      minutes: minutesMatch ? `原文“${minutesMatch[0]}”，需确认` : "未推断",
      timezone: "用户选择",
    },
  };
}
