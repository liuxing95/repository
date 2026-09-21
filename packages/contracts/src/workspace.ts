import { z } from "zod";

export const Id = z.string().uuid();
export const Role = z.enum(["admin", "user", "writer", "reader"]);
export type Role = z.infer<typeof Role>;
export const Workspace = z
  .object({
    id: Id,
    schemaVersion: z.literal(1),
    vaultPath: z.string(),
    sourcePath: z.string(),
    deviceId: Id.nullable(),
    epoch: z.number().int().nonnegative(),
    policyVersion: z.number().int().positive(),
    managedDirectories: z.array(z.string()),
    backupPath: z.string(),
  })
  .strict();
export type Workspace = z.infer<typeof Workspace>;
export const PairInput = z
  .object({
    code: z.string().min(20).max(200),
    deviceId: Id,
    vaultPath: z.string().min(1).max(4096),
  })
  .strict();
export type Principal = {
  id: string;
  role: Role;
  vaultId: string;
  deviceId: string;
  epoch: number;
  policyVersion: number;
  expiresAt: number;
};
export const Capability = z.object({
  id: z.string(),
  available: z.boolean(),
  enabled: z.boolean(),
  reason: z.string(),
});
export type Capability = z.infer<typeof Capability>;
