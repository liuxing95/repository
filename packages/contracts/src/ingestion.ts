import { z } from "zod";
import { Id } from "./workspace";
export const AcquisitionPlan = z
  .object({
    id: Id,
    kind: z.enum(["text", "html", "web", "collection", "repository", "pdf"]),
    entry: z.string().min(1).max(2048),
    title: z.string().max(200).default(""),
    clip: z.string().max(16000).optional(),
    excerpt: z.boolean().default(false),
    allowedHosts: z.array(z.string().min(1).max(253)).max(10).default([]),
    allowedPaths: z
      .array(z.string().startsWith("/").max(1024))
      .min(1)
      .max(20)
      .default(["/"]),
    language: z.string().max(40).default("unknown"),
    version: z.string().max(100).default("unknown"),
    collection: z.string().max(100).default("默认集合"),
    sourceType: z.enum(["source", "artifact"]).default("source"),
    ref: z.string().max(100).default("HEAD"),
    maxPages: z.number().int().min(1).max(100).default(30),
    maxBytes: z.number().int().min(1024).max(50_000_000).default(10_000_000),
    maxDepth: z.number().int().min(0).max(5).default(2),
    maxDurationMs: z.number().int().min(1000).max(120000).default(60000),
    encoding: z
      .enum(["utf-8", "utf-16le", "utf-16be", "gb18030"])
      .default("utf-8"),
  })
  .strict();
export type AcquisitionPlan = z.infer<typeof AcquisitionPlan>;
export type Block = {
  id: string;
  text: string;
  hash: string;
  start: number;
  end: number;
  kind: "text" | "heading" | "code" | "table";
  locator: {
    lineStart?: number;
    lineEnd?: number;
    heading?: string[];
    page?: number;
    pageLabel?: string | null;
    rect?: number[];
    path?: string;
  };
};
export type Parsed = {
  title: string;
  parser: string;
  encoding: string;
  locatorVersion: 1;
  text: string;
  blocks: Block[];
  gaps: string[];
  links: { url: string; via: string }[];
  canonicalClaim: string | null;
  declaredPublishedAt: string | null;
  confirmedPublishedAt: null;
  publicationEvidence: string | null;
  pages?: number;
  pageLabels?: (string | null)[];
  peakMemoryBytes?: number;
  durationMs?: number;
};
export type ManifestEntry = {
  id: string;
  identity: string;
  original: string;
  final: string;
  kind: AcquisitionPlan["kind"];
  via: string[];
  selected: boolean;
  status:
    | "excluded"
    | "pending"
    | "acquired"
    | "partial_parse"
    | "failed"
    | "pending_write"
    | "committed";
  reason?: string;
  objectHash?: string;
  fetchedAt?: number;
  revisionId?: string;
  parseId?: string;
  metadata: Record<string, string | number | boolean | null>;
};
export type CollectionManifest = {
  id: string;
  plan: AcquisitionPlan;
  digest: string;
  state: "preview" | "running" | "ready" | "cancelled";
  entries: ManifestEntry[];
  warnings: string[];
  previousMissing: string[];
  createdAt: number;
  finishedAt: number | null;
  jobId: string | null;
  policyVersion: number;
  epoch: number;
  principalId: string;
  selectedCount: number;
};
export type SourceRevision = {
  id: string;
  sourceId: string;
  objectHash: string;
  identity: string;
  fetchedAt: number;
  original: string;
  final: string;
  metadata: ManifestEntry["metadata"];
  committed: boolean;
};
export type ParseArtifact = Parsed & {
  id: string;
  revisionId: string;
  objectHash: string;
  createdAt: number;
  committed: boolean;
};
export type SourceDetail = {
  revision: SourceRevision;
  parses: ParseArtifact[];
};
