import { z } from "zod";
import { Id } from "./workspace";
import type { Block } from "./ingestion";
const term = z.string().min(1).max(200).nullable().default(null);
export const Scope = z
  .object({
    topic: term,
    version: term,
    channel: term,
    stage: term,
    configuration: term,
    modality: term,
    sourceType: term,
  })
  .strict();
export type Scope = z.infer<typeof Scope>;
export const Profile = z
  .object({
    scope: Scope.default(() => Scope.parse({})),
    collection: z.string().max(100).default("默认集合"),
    review: z.enum(["unreviewed", "reviewed"]).default("unreviewed"),
    kind: z
      .enum(["original", "mirror", "reprint", "summary", "wiki", "answer"])
      .default("original"),
    originalEvidence: z.array(z.string().length(64)).max(100).default([]),
    confirmedPublishedAt: z.string().datetime().nullable().default(null),
    publicationEvidence: z.string().min(1).max(2000).nullable().default(null),
  })
  .strict();
export type Profile = z.infer<typeof Profile>;
export type Evidence = {
  id: string;
  parseId: string;
  revisionId: string;
  sourceId: string;
  blockId: string;
  start: number;
  end: number;
  hash: string;
  parseHash: string;
  originalHash: string;
  locator: Block["locator"];
};
export type EvidenceRead = Evidence & {
  text: string;
  context: string;
  title: string;
  familyId: string;
  profile: Profile;
  original: string;
  fetchedAt: number;
  declaredPublishedAt: string | null;
  confirmedPublishedAt: string | null;
  gaps: string[];
};
export const SearchInput = z
  .object({
    query: z.string().trim().min(1).max(500),
    scope: Scope.default(() => Scope.parse({})),
    collection: z.string().max(100).optional(),
    review: z.enum(["unreviewed", "reviewed"]).optional(),
    limit: z.number().int().min(1).max(50).default(10),
    asOf: z.string().datetime().optional(),
    snapshotId: Id.optional(),
  })
  .strict();
export type SearchInput = z.infer<typeof SearchInput>;
export type QuerySnapshot = {
  id: string;
  generation: string;
  principalId: string;
  createdAt: number;
  expiresAt: number;
  parseIds: string[];
  revisionIds: string[];
  pageRevisions: string[];
  evidenceIds: string[];
  evidenceState: string;
  warnings: string[];
  policyVersion: number;
  input: SearchInput;
};
export type SearchResult = {
  snapshot: QuerySnapshot;
  hits: (EvidenceRead & { score: number; scopeMatch: "overlap" | "unknown" })[];
  index: {
    generation: string;
    state: "complete" | "partial";
    blocks: number;
    fingerprint: string;
  };
  warnings: string[];
};
export const Claim = z
  .object({
    id: Id,
    text: z.string().min(1).max(4000),
    kind: z.enum(["sourced", "inferred", "user-stated"]),
    review: z.enum(["unreviewed", "reviewed"]).default("unreviewed"),
    scope: Scope,
    evidenceIds: z.array(z.string().length(64)).max(30),
  })
  .strict();
export type Claim = z.infer<typeof Claim>;
export const Relation = z
  .object({
    from: Id,
    to: Id,
    type: z.enum([
      "supports",
      "contradicts",
      "qualifies",
      "supersedes",
      "related-to",
    ]),
  })
  .strict();
export type Relation = z.infer<typeof Relation>;
export const ModelAnswer = z
  .object({
    claims: z.array(Claim).max(20),
    relations: z.array(Relation).max(40),
    gaps: z.array(z.string().max(1000)).max(30),
  })
  .strict();
export type AnswerResult = z.infer<typeof ModelAnswer> & {
  id: string;
  snapshotId: string;
  status: "supported" | "insufficient" | "conflict";
  mode: "extractive" | "model";
  semanticReview: "not-reviewed";
  evidence: EvidenceRead[];
  familyCount: number;
  model: string;
  promptVersion: string;
};
