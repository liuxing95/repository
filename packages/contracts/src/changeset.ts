export type WriterPatch = {
  sequence: number;
  path: string;
  beforeHash: string | null;
  afterHash: string;
  content: string;
};
export type Patch = WriterPatch & {
  revisionId: string;
  parseId: string;
};
export type ChangeSet = {
  id: string;
  batchId: string;
  digest: string;
  patches: Patch[];
  state: "prepared" | "approved" | "committed";
  policyVersion: number;
  epoch: number;
  approvedBy: string | null;
  expiresAt: number | null;
  receipts: number[];
};
export type WriterGrant = {
  token: string;
  changeId: string;
  digest: string;
  patch: WriterPatch;
  sessionId?: string;
  approvalId?: string;
  vaultId: string;
  deviceId: string;
  epoch: number;
  policyVersion: number;
  expiresAt: number;
};
