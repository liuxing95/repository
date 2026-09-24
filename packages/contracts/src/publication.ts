import { z } from "zod";
import { Id } from "./workspace";

export const PublicationDecision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("remove") }).strict(),
  z
    .object({ action: z.literal("replace"), url: z.string().url().max(2048) })
    .strict(),
  z.object({ action: z.literal("include") }).strict(),
  z.object({ action: z.literal("retain") }).strict(),
]);
export type PublicationDecision = z.infer<typeof PublicationDecision>;
export const PublicationInput = z
  .object({
    operationId: Id,
    revisionIds: z.array(Id).min(1).max(10),
    routeId: z.string().regex(/^[a-z0-9-]{1,64}$/),
    decisions: z
      .record(z.string().min(1).max(500), PublicationDecision)
      .default({}),
  })
  .strict();
export type PublicationInput = z.infer<typeof PublicationInput>;
export type PublicationDependency = {
  pageId: string;
  token: string;
  kind: "link" | "embed" | "attachment" | "external";
  action: "remove" | "replace" | "include" | "retain" | "blocked";
  replacement: string | null;
};
export type PublicationManifest = {
  id: string;
  routeId: string;
  pages: {
    pageId: string;
    revisionId: string;
    title: string;
    sourceIds: string[];
    bodyHash: string;
    file: string;
  }[];
  dependencies: PublicationDependency[];
  attachments: { path: string; hash: string; bytes: number }[];
  outboundLinks: string[];
  publicMetadata: { title: string; kind: string }[];
  buildFingerprint: string;
  output: { path: string; hash: string; bytes: number }[];
  policyVersion: number;
  epoch: number;
  target: "local-static-site";
  digest: string;
  outputDigest: string;
};
export type PublicationPreview = {
  manifest: PublicationManifest;
  files: { path: string; content: string }[];
  approvedBy: string | null;
  approvedAt: number | null;
};
