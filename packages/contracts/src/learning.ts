import { z } from "zod";
import { Id } from "./workspace";
import { Scope } from "./evidence";
const text = z.string().trim().min(1).max(2000);
const refs = z.array(z.string().length(64)).max(30).default([]);
export const LearningUnitInput = z
  .object({
    id: Id,
    title: text,
    necessary: refs,
    optional: refs,
    prerequisites: z.array(Id).max(30).default([]),
    criteria: z
      .array(
        z
          .object({
            id: Id,
            description: text,
            weight: z.number().int().min(1).max(100),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
export const LearningGoalInput = z
  .object({
    ability: text,
    scope: Scope,
    misconceptions: z.array(text).max(20).default([]),
    completionEvidence: text,
    units: z.array(LearningUnitInput).min(1).max(30),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = v.units.map((u) => u.id),
      leaves = v.units.flatMap((u) => u.criteria.map((c) => c.id));
    if (
      new Set(ids).size !== ids.length ||
      new Set(leaves).size !== leaves.length
    )
      ctx.addIssue({ code: "custom", message: "单元及叶子验收项 ID 必须唯一" });
    if (
      v.units.some((u) =>
        u.prerequisites.some((id) => id === u.id || !ids.includes(id)),
      )
    )
      ctx.addIssue({ code: "custom", message: "先修建议必须引用其他已有单元" });
  });
export type LearningGoalInput = z.infer<typeof LearningGoalInput>;
export type LearningUnit = z.infer<typeof LearningUnitInput>;
export type LearningBaseline = {
  id: string;
  goalId: string;
  previousId: string | null;
  createdAt: number;
  digest: string;
  input: LearningGoalInput;
};
export type LearningGoal = {
  id: string;
  baselineId: string;
  state: "active" | "paused";
  createdAt: number;
};
export const UnitChoice = z
  .object({
    state: z.enum(["reference", "selected", "skipped", "paused", "cancelled"]),
    rank: z.number().int().min(0).max(999),
    reason: z.string().max(2000).default(""),
  })
  .strict();
export type UnitChoice = z.infer<typeof UnitChoice>;
export const AttemptInput = z
  .object({
    baselineId: Id,
    unitId: Id,
    kind: z.enum(["explain", "example", "recall", "variation", "correction"]),
    expression: z.string().trim().min(1).max(12000),
    hintLevel: z.number().int().min(0).max(3),
    evidenceIds: refs,
    artifacts: z.array(text).max(10).default([]),
    selfReport: z.string().max(4000).default(""),
    unresolved: z.array(text).max(20).default([]),
  })
  .strict();
export type LearningAttempt = z.infer<typeof AttemptInput> & {
  id: string;
  goalId: string;
  createdAt: number;
  actorId: string;
  sourceRefs: {
    id: string;
    sourceId: string;
    revisionId: string;
    scope: z.infer<typeof Scope>;
  }[];
};
export const EvaluationInput = z
  .object({
    criterionId: Id,
    outcome: z.enum(["passed", "failed", "uncertain"]),
    rationale: text,
    ruleVersion: text,
  })
  .strict();
export type LearningEvaluation = z.infer<typeof EvaluationInput> & {
  id: string;
  attemptId: string;
  createdAt: number;
  origin: "human" | "program" | "model";
  evaluator: string;
  model?: string;
  promptVersion?: string;
};
export const LearningSettings = z
  .object({
    capacity: z
      .object({
        wip: z.number().int().min(1).max(30),
        dayMinutes: z.number().int().min(1).max(1440),
        timezone: z.string().min(1).max(100),
      })
      .strict()
      .nullable(),
    review: z
      .object({
        intervalDays: z.number().int().min(1).max(365),
        windowDays: z.number().int().min(1).max(30),
        minutes: z.number().int().min(1).max(240),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type LearningSettings = z.infer<typeof LearningSettings>;
export type ReviewSuggestion = {
  id: string;
  goalId: string;
  baselineId: string;
  unitId: string;
  attemptId: string | null;
  kind: "review" | "version";
  reason: string;
  dueAt: number;
  endAt: number;
  minutes: number;
  state:
    "suggested" | "skipped" | "deferred" | "paused" | "creating" | "created";
  choiceNote: string;
  createdAt: number;
};
export type LearningTaskIntent = {
  id: string;
  suggestionId: string;
  taskId: string;
  goalId: string;
  unitId: string;
  baselineId: string;
  day: string;
  timezone: string;
  minutes: number;
  state: "reserved" | "unknown" | "created" | "failed";
  createdAt: number;
};
export type TaskCapacitySnapshot = {
  complete: boolean;
  observedAt: number;
  tasks: {
    taskId: string;
    active: boolean;
    day: string | null;
    minutes: number;
  }[];
};
