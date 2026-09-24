import { z } from "zod";
import { Id } from "./workspace";

export const AgentReceiver = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  z
    .object({
      kind: z.literal("model"),
      routeId: z.string().regex(/^[a-z0-9-]{1,64}$/),
    })
    .strict(),
]);
export type AgentReceiver = z.infer<typeof AgentReceiver>;

export const AgentCreateInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    sourceIds: z.array(Id).min(1).max(100),
    receiver: AgentReceiver,
    expiresInMinutes: z.number().int().min(5).max(10080),
  })
  .strict();
export type AgentCreateInput = z.infer<typeof AgentCreateInput>;

export const AgentTool = z.enum([
  "kb_search",
  "kb_read_evidence",
  "kb_answer",
  "kb_operation",
]);
export const AgentInvokeInput = z
  .object({
    requestId: Id,
    tool: AgentTool,
    args: z.unknown(),
  })
  .strict();
export type AgentInvokeInput = z.infer<typeof AgentInvokeInput>;

export const AgentSearchArgs = z
  .object({
    query: z.string().trim().min(1).max(500),
    sourceIds: z.array(Id).min(1).max(100).optional(),
    offset: z.number().int().min(0).max(45).default(0),
    limit: z.number().int().min(1).max(5).default(5),
  })
  .strict();
export const AgentReadArgs = z
  .object({ evidenceId: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const AgentAnswerArgs = z
  .object({
    question: z.string().trim().min(1).max(500),
    sourceIds: z.array(Id).min(1).max(100).optional(),
  })
  .strict();
export const AgentOperationArgs = z.object({ requestId: Id }).strict();
