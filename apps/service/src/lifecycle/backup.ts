import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import Database from "better-sqlite3";
import { AppError } from "../errors";
import {
  inside,
  canonicalDestination,
  trustedDirectory,
} from "../security/paths";
import { matchesSchema } from "../storage/store";
import type { WorkspaceRegistry } from "../workspace/registry";

export type BackupFile = { path: string; hash: string; size: number };
export type BackupManifest = {
  format: 1;
  id: string;
  createdAt: number;
  softwareVersion: string;
  schemaVersion: number;
  workspaceId: string;
  vaultPath: string;
  eventWatermark: number;
  reminderFence: number;
  reminderAnchor: number;
  pending: { jobs: number; calls: number; reminders: number };
  files: BackupFile[];
  complete: boolean;
  errors: string[];
};

export const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export function ledgerDigest(db: Database.Database) {
  const digest = createHash("sha256");
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_fts%' AND name NOT LIKE 'wiki_fts%' ORDER BY name",
    )
    .all() as { name: string }[];
  for (const { name } of tables) {
    digest.update(name).update("\0");
    for (const row of db
      .prepare(`SELECT * FROM \"${name}\" ORDER BY rowid`)
      .iterate()) {
      const json = JSON.stringify(row);
      digest
        .update(String(Buffer.byteLength(json)))
        .update(":")
        .update(json);
    }
  }
  return digest.digest("hex");
}
export async function hashFile(
  path: string,
  limit = 2_000_000_000,
): Promise<{ hash: string; size: number }> {
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size > limit) throw new AppError("SCAN_LIMIT");
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    while (true) {
      const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new AppError("SCAN_LIMIT");
      digest.update(chunk.subarray(0, bytesRead));
    }
    if (size !== stat.size)
      throw new AppError("BASELINE", 409, "校验期间文件大小变化。");
    return { hash: digest.digest("hex"), size };
  } finally {
    await input.close();
  }
}
export function safeRelative(path: string) {
  if (
    !path ||
    isAbsolute(path) ||
    path
      .split(/[\\/]/)
      .some((part) => !part || part === "." || part === "..") ||
    path.includes("\\")
  )
    throw new AppError("FORBIDDEN", 403, "备份清单含不安全路径。");
  return path;
}
const excluded = (rel: string) =>
  [
    "state.db",
    "state.db-wal",
    "state.db-shm",
    "service.lock",
    "state.db.restore-hold",
  ].includes(rel);

export async function catalogue(root: string): Promise<BackupFile[]> {
  const files: BackupFile[] = [];
  let total = 0;
  const visit = async (dir: string) => {
    if ((await trustedDirectory(dir)) !== dir) throw new AppError("FORBIDDEN");
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      safeRelative(rel);
      // Publication bytes are already in the SQLite preview ledger. The local
      // site tree contains an active symlink and must be rebuilt after restore.
      if (rel === "public-site") continue;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        throw new AppError("FORBIDDEN", 403, "备份范围含符号链接或特殊文件。");
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (excluded(rel)) continue;
      const file = await hashFile(path, 100_000_000);
      total += file.size;
      if (total > 2_000_000_000 || files.length >= 25000)
        throw new AppError("SCAN_LIMIT");
      files.push({ path: rel, ...file });
    }
  };
  await visit(root);
  return files;
}

export function checkDatabase(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const schemaVersion = db.pragma("user_version", { simple: true }) as number;
    if (schemaVersion !== 9 || !matchesSchema(db, 9))
      throw new AppError("SCHEMA", 409, "备份数据库结构未知；仅能只读诊断。");
    const check = db.pragma("quick_check") as { quick_check: string }[];
    if (check.length !== 1 || check[0]?.quick_check !== "ok")
      throw new AppError("HASH_MISMATCH", 409, "备份数据库完整性检查失败。");
    if ((db.pragma("foreign_key_check") as unknown[]).length)
      throw new AppError("HASH_MISMATCH", 409, "备份数据库引用检查失败。");
    for (const row of db
      .prepare("SELECT hash,bytes FROM objects")
      .iterate() as Iterable<{ hash: string; bytes: Buffer }>)
      if (sha(row.bytes) !== row.hash)
        throw new AppError("HASH_MISMATCH", 409, "原件对象哈希不符。");
    const workspace = db
      .prepare("SELECT value FROM kv WHERE key='workspace'")
      .get() as { value: string } | undefined;
    if (!workspace) throw new AppError("SCHEMA");
    const value = JSON.parse(workspace.value) as {
      id: string;
      vaultPath: string;
    };
    return { db, schemaVersion, workspace: value };
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function backupSet(registry: WorkspaceRegistry, output: string) {
  const store = registry.store;
  store.writable();
  if (store.reminderPaused)
    throw new AppError(
      "CONFLICT",
      409,
      "提醒栅栏不一致，先核对再生成完整备份。",
    );
  if (!output) throw new AppError("VALIDATION", 400, "请指定新的备份集目录。");
  const root = await trustedDirectory(registry.dataPath);
  const target = await canonicalDestination(output);
  const workspace = registry.get();
  if (
    inside(root, target) ||
    inside(target, root) ||
    inside(workspace.vaultPath, target)
  )
    throw new AppError(
      "FORBIDDEN",
      403,
      "备份位置不能包含应用数据或试点 Vault。",
    );
  await mkdir(target, { mode: 0o700 });
  const manifest: BackupManifest = {
    format: 1,
    id: randomUUID(),
    createdAt: Date.now(),
    softwareVersion: "0.1.0",
    schemaVersion: 9,
    workspaceId: workspace.id,
    vaultPath: workspace.vaultPath,
    eventWatermark: 0,
    reminderFence: 0,
    reminderAnchor: 0,
    pending: { jobs: 0, calls: 0, reminders: 0 },
    files: [],
    complete: false,
    errors: [],
  };
  try {
    const before = await catalogue(root);
    const dbPath = join(target, "state.db");
    await store.db.backup(dbPath);
    await chmod(dbPath, 0o600);
    // A backup of a WAL database inherits WAL mode. Seal the standalone copy
    // before hashing it, so verification cannot create unlisted sidecars.
    const sealed = new Database(dbPath);
    try {
      sealed.pragma("journal_mode = DELETE");
    } finally {
      sealed.close();
    }
    const checked = checkDatabase(dbPath);
    try {
      if (
        checked.workspace.id !== workspace.id ||
        checked.workspace.vaultPath !== workspace.vaultPath
      )
        throw new AppError("BASELINE");
      manifest.eventWatermark = (
        checked.db
          .prepare("SELECT COALESCE(MAX(id),0) n FROM events")
          .get() as { n: number }
      ).n;
      manifest.reminderFence = Number(
        (
          checked.db
            .prepare("SELECT value FROM reminder_meta WHERE key='fence'")
            .get() as { value: string }
        ).value,
      );
      manifest.reminderAnchor = Number(
        await readFile(store.reminderAnchorPath, "utf8").catch(() => "0"),
      );
      if (manifest.reminderFence !== manifest.reminderAnchor)
        throw new AppError("CONFLICT", 409, "提醒锚点与数据库不一致。");
      manifest.pending.jobs = (
        checked.db
          .prepare(
            "SELECT COUNT(*) n FROM jobs WHERE state IN ('queued','running')",
          )
          .get() as { n: number }
      ).n;
      manifest.pending.calls = (
        checked.db
          .prepare(
            "SELECT COUNT(*) n FROM calls WHERE state IN ('reserved','dispatched','unknown')",
          )
          .get() as { n: number }
      ).n;
      manifest.pending.reminders = (
        checked.db
          .prepare(
            "SELECT COUNT(*) n FROM reminder_attempts WHERE state IN ('dispatching','outcome_unknown')",
          )
          .get() as { n: number }
      ).n;
    } finally {
      checked.db.close();
    }
    const dbFile = await hashFile(dbPath, 2_000_000_000);
    if (
      before.reduce((size, file) => size + file.size, dbFile.size) >
      2_000_000_000
    )
      throw new AppError("SCAN_LIMIT");
    manifest.files.push({ path: "state.db", ...dbFile });
    for (const file of before) {
      const input = await open(
        join(root, file.path),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const bytes = await input.readFile().finally(() => input.close());
      if (bytes.length !== file.size || sha(bytes) !== file.hash)
        throw new AppError("BASELINE", 409, `备份期间文件变化：${file.path}`);
      const dest = join(target, file.path);
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      await writeFile(dest, bytes, { flag: "wx", mode: 0o600 });
      manifest.files.push(file);
    }
    if (!before.some((file) => file.path === "state.db.reminder-fence")) {
      const fence = String(manifest.reminderFence);
      await writeFile(join(target, "state.db.reminder-fence"), fence, {
        flag: "wx",
        mode: 0o600,
      });
      manifest.files.push({
        path: "state.db.reminder-fence",
        hash: sha(fence),
        size: Buffer.byteLength(fence),
      });
    }
    const after = await catalogue(root);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new AppError("BASELINE", 409, "备份期间 Vault 或应用文件变化。");
    if (
      Number(
        await readFile(store.reminderAnchorPath, "utf8").catch(() => "0"),
      ) !== manifest.reminderAnchor
    )
      throw new AppError("BASELINE", 409, "备份期间提醒锚点变化。");
    manifest.complete = true;
  } catch (error) {
    manifest.errors.push(error instanceof Error ? error.message : "未知错误");
  }
  const json = JSON.stringify(manifest, null, 2);
  await writeFile(join(target, "manifest.json"), json, {
    flag: "wx",
    mode: 0o600,
  });
  if (manifest.complete)
    await writeFile(join(target, "COMPLETE"), sha(json), {
      flag: "wx",
      mode: 0o600,
    });
  return { path: target, ...manifest };
}
