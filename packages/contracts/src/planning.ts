import { z } from "zod";
import { Id } from "./workspace";
import { TaskDay, TaskZone } from "./tasks";

// Requiring an offset keeps ambiguous and missing wall-clock hours out of the API.
export const Instant = z
  .string()
  .refine(
    (s) =>
      /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(
        s,
      ) &&
      TaskDay.safeParse(s.slice(0, 10)).success &&
      Number.isFinite(Date.parse(s)),
    "需要包含时区偏移的日期时间",
  );
export const PlanningWindow = z
  .object({
    start: Instant,
    end: Instant,
    location: z.string().max(100).optional(),
    device: z.string().max(100).optional(),
  })
  .strict()
  .refine((v) => Date.parse(v.start) < Date.parse(v.end));
export const PlanningRequest = z
  .object({
    timezone: TaskZone,
    windows: z.array(PlanningWindow).max(100),
    unavailable: z.array(PlanningWindow).max(100).default([]),
    calendarIds: z.array(z.string().min(1).max(256)).max(10).default([]),
    policy: z
      .object({
        maxNodes: z.number().int().min(1).max(100000),
        freezeMinutes: z.number().int().min(0).max(1440),
        freshnessMs: z.number().int().min(1000).max(300000),
        maxMillis: z.number().int().min(1).max(5000).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, ctx) => {
    const format = new Intl.DateTimeFormat("en-CA", {
      timeZone: request.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    for (const [kind, windows] of [
      ["windows", request.windows],
      ["unavailable", request.unavailable],
    ] as const)
      for (let i = 0; i < windows.length; i++) {
        for (const [edge, raw] of [
          ["start", windows[i]!.start],
          ["end", windows[i]!.end],
        ] as const) {
          if (raw.endsWith("Z") || !Number.isFinite(Date.parse(raw))) continue;
          const parts = format.formatToParts(Date.parse(raw));
          const get = (name: string) =>
            parts.find((p) => p.type === name)?.value;
          const wall = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
          if (raw.slice(0, 16) !== wall)
            ctx.addIssue({
              code: "custom",
              message: "时间偏移与计划时区不一致或处于夏令时缺失小时",
              path: [kind, i, edge],
            });
        }
      }
  });
export type PlanningRequest = z.infer<typeof PlanningRequest>;
export type TimeRange = { start: number; end: number };
export type PlanningBlock = TimeRange & {
  id: string;
  taskId: string;
  kind: "flexible";
  started: boolean;
  locked: boolean;
  location?: string;
  device?: string;
};
export type PlanningTask = {
  id: string;
  revision: string;
  path: string;
  title: string;
  minutes: number | null;
  activeLog: boolean;
  remainingSource: "TaskNotes 估计减已记录时长" | "未估计";
  deadline: number | null;
  deadlineInvalid: boolean;
  location: string | null;
  device: string | null;
  priority: number | null;
  earliest: number | null;
  desiredDay: string | null;
  dependencies: string[];
  lifecycle: string;
  sync: string;
};
export type CalendarCoverage = {
  state: "unconnected" | "complete" | "unknown";
  calendarIds: string[];
  checkedAt: number | null;
  reason: string;
  hash: string;
};
export type PlanningSnapshot = {
  id: string;
  evaluatedAt: number;
  basePlanId: string | null;
  generation: number;
  policyVersion: number;
  epoch: number;
  request: PlanningRequest;
  tasks: PlanningTask[];
  previous: PlanningBlock[];
  busy: TimeRange[];
  coverage: CalendarCoverage;
  hash: string;
};
export type PlanningCandidate = {
  id: string;
  snapshot: PlanningSnapshot;
  blocks: PlanningBlock[];
  unscheduled: { taskId: string; reason: string }[];
  status: "complete" | "partial" | "no-window" | "no-op";
  stopReason: string | null;
  capacityGapMinutes: number;
  diff: {
    kept: string[];
    moved: { taskId: string; from: number; to: number; reason: string }[];
    added: string[];
    removed: string[];
  };
};
export const CandidateId = Id;
