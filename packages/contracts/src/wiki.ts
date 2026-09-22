import { z } from "zod";
import { Id } from "./workspace";
import type { Claim, EvidenceRead } from "./evidence";
import type { WriterPatch } from "./changeset";
export const PageKind = z.enum(["concept", "system", "comparison", "decision"]);
export const ProposalInput = z
  .object({
    operationId: Id,
    candidateId: Id,
    destination: z.enum(["candidate", "wiki"]),
    title: z.string().trim().min(1).max(120),
    kind: PageKind.default("concept"),
    confirmedDecision: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export type ProposalInput = z.infer<typeof ProposalInput>;
export type WikiPatch = WriterPatch & {
  pageId: string;
  revisionId: string;
  title: string;
  kind: z.infer<typeof PageKind>;
  beforeRevision: string | null;
  beforeContent: string | null;
  observationId: string | null;
  evidenceIds: string[];
  claims: Claim[];
};
export type WikiChangeSet = {
  id: string;
  candidateId: string;
  candidateHash: string;
  destination: "candidate" | "wiki";
  purpose: string;
  patches: WikiPatch[];
  evidence: EvidenceRead[];
  deferred: string[];
  digest: string;
  policyVersion: number;
  epoch: number;
  createdBy: string;
  createdAt: number;
  state: "prepared" | "approved" | "rejected" | "committed" | "no_change";
  approvedBy: string | null;
  approvalId: string | null;
  expiresAt: number | null;
  receipts: number[];
  rejection: string | null;
};
export type WikiPage = {
  pageId: string;
  revisionId: string;
  path: string;
  title: string;
  kind: z.infer<typeof PageKind>;
  content: string;
  hash: string;
  evidenceIds: string[];
  claims: Claim[];
  committedAt: number;
  review: "reviewed" | "needs-review";
};
