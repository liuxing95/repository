import { lstat, realpath } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import type { Connection } from "../connection";
import type { WriterGrant } from "@kb/contracts";
export const writerHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export async function guardPath(root: string, path: string) {
  if (!/^KB-(Sources|Wiki|Candidates)\/[a-f0-9-]{36}\.md$/.test(path))
    throw new Error("WRITER_PATH");
  const base = await realpath(root);
  const name = path.split("/")[0]!;
  const folder = resolve(root, name);
  if ((await lstat(folder)).isSymbolicLink()) throw new Error("WRITER_PATH");
  const actualFolder = await realpath(folder);
  const rel = relative(base, actualFolder);
  if (rel.startsWith("..") || isAbsolute(rel) || rel !== name)
    throw new Error("WRITER_PATH");
  try {
    const info = await lstat(resolve(root, path));
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)
      throw new Error("WRITER_PATH");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
}
export function guardGrant(connection: Connection, grant: WriterGrant) {
  const p = connection.principal;
  const w = connection.workspace;
  if (
    !p ||
    !w ||
    p.expiresAt <= Date.now() ||
    (grant.sessionId !== undefined && grant.sessionId !== p.id) ||
    grant.vaultId !== w.id ||
    grant.deviceId !== connection.deviceId ||
    w.deviceId !== connection.deviceId ||
    grant.epoch !== w.epoch ||
    grant.policyVersion !== w.policyVersion ||
    Date.now() >= grant.expiresAt ||
    writerHash(grant.patch.content) !== grant.patch.afterHash
  )
    throw new Error("WRITER_EXPIRED");
}

// Recheck synchronously inside Vault.process; asynchronous checks alone leave a stale baseline window.
export function guardPathSync(root: string, path: string) {
  if (!/^KB-(Sources|Wiki|Candidates)\/[a-f0-9-]{36}\.md$/.test(path))
    throw new Error("WRITER_PATH");
  const base = realpathSync(root),
    name = path.split("/")[0]!;
  const folder = resolve(root, name);
  if (
    lstatSync(folder).isSymbolicLink() ||
    relative(base, realpathSync(folder)) !== name
  )
    throw new Error("WRITER_PATH");
  try {
    const info = lstatSync(resolve(root, path));
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)
      throw new Error("WRITER_PATH");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
}
