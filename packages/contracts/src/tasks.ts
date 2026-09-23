import { z } from "zod";
import { Id } from "./workspace";
export const TaskDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v);
    return Number.isFinite(+d) && d.toISOString().slice(0, 10) === v;
  });
export const TaskZone = z
  .string()
  .max(100)
  .refine((v) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  });
export const TaskLifecycle = z.enum([
  "inbox",
  "todo",
  "in-progress",
  "blocked",
  "done",
  "cancelled",
  "unmapped",
]);
export type TaskLifecycle = z.infer<typeof TaskLifecycle>;
export const TaskPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (v) =>
      !v.startsWith("/") &&
      !v.includes("\\") &&
      v.endsWith(".md") &&
      v
        .split("/")
        .every((s) => s && s !== "." && s !== ".." && !s.startsWith(".")),
  );
export const TaskFact = z
  .object({
    taskId: Id.nullable(),
    operationId: Id.nullable(),
    path: TaskPath,
    title: z.string().min(1).max(500),
    status: z.string().max(100),
    lifecycle: TaskLifecycle,
    desiredDay: TaskDay.nullable(),
    earliestDay: TaskDay.nullable(),
    due: z.string().max(100).nullable(),
    timezone: TaskZone,
    minutes: z.number().int().min(0).max(1440).nullable(),
    timeEntries: z
      .array(
        z
          .object({
            startTime: z.string().max(100),
            endTime: z.string().max(100).optional(),
          })
          .strict(),
      )
      .max(1000),
    recurrence: z.string().max(4000).nullable(),
    completeInstances: z.array(z.string().max(100)).max(5000),
    skippedInstances: z.array(z.string().max(100)).max(5000),
    seriesPath: TaskPath.nullable(),
    originalOccurrence: z.string().max(100).nullable(),
    dependencies: z.array(TaskPath).max(100),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type TaskFact = z.infer<typeof TaskFact>;
export type ObservedTask = {
  taskId: string;
  occurrenceKey?: string;
  fact: TaskFact;
  revision: string;
  observedAt: number;
  sync: "current" | "conflict" | "unknown" | "deleted";
  paths: string[];
};
export const TaskDraft = z
  .object({
    title: z.string().trim().min(1).max(500),
    desiredDay: TaskDay.nullable(),
    earliestDay: TaskDay.nullable(),
    deadlineDay: TaskDay.nullable(),
    timezone: TaskZone,
    minutes: z.number().int().min(1).max(1440).nullable(),
    details: z.string().max(8000).default(""),
  })
  .strict();
export type TaskDraft = z.infer<typeof TaskDraft>;
export type TaskCommand = {
  id: string;
  taskId: string;
  digest: string;
  input: TaskDraft;
  state: "queued" | "unknown" | "created" | "conflict" | "cancelled";
  createdAt: number;
  actorId: string;
  epoch: number;
  policyVersion: number;
  attributed: boolean;
  learning?: { goalId: string; unitId: string; baselineId: string };
};
export const TaskBaselineInput = z
  .object({
    previousId: Id.nullable(),
    label: z.string().trim().min(1).max(200),
    leaves: z
      .array(
        z
          .object({
            id: Id,
            taskId: Id,
            label: z.string().min(1).max(200),
            weight: z.number().positive().max(10000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type TaskBaseline = {
  id: string;
  createdAt: number;
  input: z.infer<typeof TaskBaselineInput>;
};
export type TaskToday = {
  observedAt: number | null;
  complete: boolean;
  tasks: ObservedTask[];
  unmanaged: TaskFact[];
  commands: TaskCommand[];
  risks: string[];
  learningLinks: { taskId: string; goalId: string; unitId: string }[];
  plan: null | { id: string; blocks: TodayBlock[] };
  receipts: ProjectionReceipt[];
};
export type TodayBlock = {
  id: string;
  taskId: string | null;
  kind: "fixed" | "free" | "flexible" | "buffer";
  start: number;
  end: number;
  started: boolean;
};
export type ProjectionReceipt = {
  planId: string;
  target: "note" | "task" | "calendar" | "reminder";
  revision: string;
  state: "pending" | "applied" | "failed";
};
