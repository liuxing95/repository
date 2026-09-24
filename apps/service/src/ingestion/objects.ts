import { createHash } from "node:crypto";
import { Store } from "../storage/store";
import { AppError } from "../errors";
export const hashBytes = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function putObject(store: Store, bytes: Buffer) {
  const hash = hashBytes(bytes);
  store.writable();
  store.db
    .prepare("INSERT OR IGNORE INTO objects VALUES (?,?)")
    .run(hash, bytes);
  if (!getObject(store, hash).equals(bytes))
    throw new AppError("HASH_MISMATCH");
  return hash;
}
export function getObject(store: Store, hash: string) {
  const row = store.db
    .prepare("SELECT bytes FROM objects WHERE hash=?")
    .get(hash) as { bytes: Buffer } | undefined;
  if (!row || hashBytes(row.bytes) !== hash)
    throw new AppError("HASH_MISMATCH");
  return row.bytes;
}
