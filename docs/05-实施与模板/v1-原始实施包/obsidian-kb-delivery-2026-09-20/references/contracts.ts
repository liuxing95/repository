/**
 * Design contract only. No service, plugin, model adapter or writer is implemented here.
 * Runtime schemas must validate all IDs, hashes, paths, ranges and untrusted JSON.
 */
export type Id = string;
export type Sha256 = string;
export type IsoTime = string;
export type MicroUsd = number; // non-negative safe integer, validated at runtime
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Role = 'desktop' | 'reader' | 'agent-reader' | 'admin' | 'writer';
export interface Principal { id: Id; vaultId: Id; role: Role; scopes: readonly string[] }
export interface SourcePolicy { allowedModelRouteIds: readonly string[]; visibility: 'private' | 'public' }
export interface SourceRecord {
  sourceId: Id; title: string; canonicalKey: string;
  captureKind: 'file' | 'browser_clip' | 'user_note';
  coverage: 'full_text' | 'excerpt' | 'unknown';
  status: 'active' | 'retracted' | 'purged'; policy: SourcePolicy;
}
export interface SourceRevision {
  sourceRevisionId: Id; sourceId: Id; originalHash: Sha256;
  capturedAt: IsoTime; publishedAt: IsoTime | null;
}
export interface ParseArtifact {
  parseId: Id; sourceRevisionId: Id; parserFingerprint: string;
  normalizedHash: Sha256; encoding: 'utf-8'; offsetUnit: 'utf16';
}
export interface Evidence {
  evidenceId: Id; parseId: Id; blockId: string;
  startUtf16: number; endUtf16: number; quoteHash: Sha256;
}
export interface Claim {
  claimId: Id; statement: string;
  origin: 'sourced' | 'inferred' | 'user-stated';
  reviewState: 'draft' | 'reviewed' | 'disputed' | 'stale';
  scope: { entityKeys: readonly string[]; version: string | null; conditions: readonly string[] };
  evidence: readonly { evidenceId: Id; relation: 'supports' | 'contradicts' | 'qualifies' }[];
}
export type FilePatch = {
  path: string; afterHash: Sha256; afterObjectHash: Sha256;
} & ({ action: 'create'; beforeHash: null } | { action: 'update'; beforeHash: Sha256 });
export interface ChangeSet {
  changeSetId: Id; vaultId: Id; jobId: Id; baseSnapshotId: Id;
  proposalDigest: Sha256; policyVersion: string;
  sourceRevisionIds: readonly Id[]; parseIds: readonly Id[];
  patches: readonly FilePatch[];
  status: 'proposed' | 'approved' | 'prepared' | 'applying' | 'committed' |
          'conflict' | 'rejected' | 'paused_authorization' | 'rolled_back';
}
export interface Approval {
  approvalId: Id; changeSetId: Id; proposalDigest: Sha256;
  principalId: Id; policyVersion: string; expiresAt: IsoTime;
}
export type JobState = 'queued' | 'running' | 'succeeded' | 'awaiting_writer' |
  'waiting_approval' | 'blocked_budget' | 'retry_wait' | 'conflict' | 'failed' | 'cancelled';
export interface Job {
  jobId: Id; operationKey: string; state: JobState; stage: string;
  leaseFence: number; attempt: number; warnings: readonly string[];
}
export interface SourceInput {
  revision: SourceRevision; parse: ParseArtifact; text: string;
  evidence: readonly Evidence[]; policy: SourcePolicy;
}
export interface CompileInput {
  jobId: Id; baseSnapshotId: Id; policyVersion: string;
  sources: readonly SourceInput[];
  baselinePages: readonly { pageId: Id; pageRevisionId: Id; path: string; body: string; bodyHash: Sha256 }[];
  modelRouteId: string; maxNewPages: number; maxUpdatedPages: number; maxClaims: number;
}
export interface ModelUsage {
  inputTokens: number | null; outputTokens: number | null;
  providerRequestId: string | null; reservedMicroUsd: MicroUsd;
  actualMicroUsd: MicroUsd | null; outcome: 'known' | 'unknown';
}
export interface CompileProposal {
  claims: readonly Claim[];
  pages: readonly {
    pageId: Id | null; title: string; type: 'concept' | 'system' | 'comparison' | 'decision';
    markdown: string; claimIds: readonly Id[];
  }[];
  warnings: readonly string[]; unresolved: readonly string[]; usage: readonly ModelUsage[];
}
export interface CompilerPort {
  propose(input: CompileInput, signal: AbortSignal): Promise<CompileProposal>;
}
export interface SearchHit {
  docId: Id; revisionId: Id; snapshotId: Id; kind: 'source' | 'wiki' | 'human-note';
  text: string; evidenceIds: readonly Id[]; route: 'exact' | 'lexical'; rank: number;
}
export interface Answer {
  answerId: Id; snapshotId: Id;
  status: 'answered' | 'insufficient_evidence' | 'conflicting_evidence';
  claims: readonly { text: string; evidenceIds: readonly Id[] }[];
  markdown: string; warnings: readonly string[]; usage: readonly ModelUsage[];
}
export interface LlmRequest {
  jobId: Id; routeId: string; purpose: 'extract' | 'propose' | 'answer' | 'repair';
  input: string; schemaId: string; maxOutputTokens: number;
}
export interface LlmPort {
  generate(input: LlmRequest, signal: AbortSignal): Promise<{ data: unknown; usage: ModelUsage }>;
}
export interface WriterGrant {
  grantId: Id; sessionId: Id; epoch: number; changeSetId: Id;
  proposalDigest: Sha256; patchIndex: number; afterHash: Sha256; expiresAt: IsoTime;
}
export interface WriterReceipt {
  changeSetId: Id; patchIndex: number; grantId: Id;
  observedHash: Sha256 | null; status: 'applied' | 'already_applied' | 'conflict';
}
export interface WriterPort {
  apply(grant: WriterGrant, approval: Approval, patch: FilePatch, text: string): Promise<WriterReceipt>;
}
export interface ErrorBody { code: string; message: string; retryable: boolean; jobId?: Id; detailId?: Id }
