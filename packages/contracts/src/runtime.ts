import { z } from "zod";
export const Queue = z.enum(["interactive", "notification", "batch"]);
export type Queue = z.infer<typeof Queue>;
export const JobState = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const JobInput = z
  .object({
    operationKey: z.string().min(8).max(160),
    queue: Queue,
    kind: z.enum(["diagnostic-check", "ingestion", "evidence-answer"]),
    parentId: z.string().uuid().optional(),
  })
  .strict();
export type Job = {
  id: string;
  operationKey: string;
  rootId: string;
  parentId: string | null;
  queue: Queue;
  kind: string;
  digest: string;
  state: z.infer<typeof JobState>;
  stage: string;
  attempt: number;
  fence: number;
  leaseUntil: number | null;
  cancelled: boolean;
  createdAt: number;
  problem?: Problem;
};
export type OperationStatus =
  | "idle"
  | "loading"
  | "empty"
  | "partial"
  | "success"
  | "waiting_approval"
  | "awaiting_writer"
  | "blocked_budget"
  | "conflict"
  | "failed";
export type Problem = {
  code: string;
  message: string;
  impact: string;
  nextStep: string;
  retryable: boolean;
  detailId: string;
};
