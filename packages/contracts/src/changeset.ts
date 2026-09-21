export type Patch = {
  sequence: number;
  path: string;
  beforeHash: string | null;
  afterHash: string;
  content: string;
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
  patch: Patch;
  vaultId: string;
  deviceId: string;
  epoch: number;
  policyVersion: number;
  expiresAt: number;
};
