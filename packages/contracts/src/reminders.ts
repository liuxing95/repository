import { z } from "zod";
import { TaskZone } from "./tasks";

const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Common = {
  maxLateMinutes: z.number().int().min(0).max(1440),
  quietStart: Clock.nullable(),
  quietEnd: Clock.nullable(),
  enabled: z.boolean(),
  overlapReviewed: z.literal(true),
};
export const ReminderRuleInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("morning"),
      localTime: Clock,
      timezone: TaskZone,
      catchUp: z.boolean(),
      ...Common,
    })
    .strict(),
  z
    .object({
      kind: z.literal("evening"),
      localTime: Clock,
      timezone: TaskZone,
      catchUp: z.boolean(),
      ...Common,
    })
    .strict(),
  z
    .object({
      kind: z.literal("start"),
      minutesBefore: z.number().int().min(0).max(1440),
      freshnessMinutes: z.number().int().min(1).max(1440),
      resendOnMove: z.boolean(),
      ...Common,
    })
    .strict(),
  z
    .object({
      kind: z.literal("deadline"),
      minutesBefore: z.number().int().min(0).max(10080),
      freshnessMinutes: z.number().int().min(1).max(1440),
      resendOnMove: z.boolean(),
      ...Common,
    })
    .strict(),
]);
export type ReminderRuleInput = z.infer<typeof ReminderRuleInput>;
export type ReminderRule = ReminderRuleInput & {
  id: string;
  ownerId: string;
  createdAt: number;
  channel: "desktop";
  executor: "local";
};
export type ReminderState =
  | "scheduled"
  | "dispatching"
  | "accepted"
  | "failed"
  | "outcome_unknown"
  | "cancelled"
  | "suppressed";
export type ReminderOccurrence = {
  logicalKey: string;
  ruleId: string;
  ownerId: string;
  taskId: string | null;
  planId: string | null;
  taskRevision: string | null;
  dueAt: number;
  baseDueAt: number;
  generation: number;
  cancelGeneration: number;
  deliveryKey: string;
  state: ReminderState;
  reason: string | null;
  day: string | null;
  snoozedUntil: number | null;
};
