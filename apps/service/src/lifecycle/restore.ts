import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AppError } from "../errors";
import {
  canonicalDestination,
  inside,
  trustedDirectory,
} from "../security/paths";
import { Store } from "../storage/store";
import {
  checkDatabase,
  hashFile,
  ledgerDigest,
  safeRelative,
  sha,
  type BackupFile,
  type BackupManifest,
} from "./backup";

const manifestSchema = z
  .object({
    format: z.literal(1),
    id: z.string().uuid(),
    createdAt: z.number().int(),
    softwareVersion: z.string(),
    schemaVersion: z.literal(9),
    workspaceId: z.string().uuid(),
    vaultPath: z.string(),
    eventWatermark: z.number().int().nonnegative(),
    reminderFence: z.number().int().nonnegative(),
    reminderAnchor: z.number().int().nonnegative(),
    pending: z.object({
      jobs: z.number().int(),
      calls: z.number().int(),
      reminders: z.number().int(),
    }),
    files: z
      .array(
        z.object({
          path: z.string(),
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          size: z.number().int().nonnegative(),
        }),
      )
      .max(25002),
    complete: z.literal(true),
    errors: z.array(z.string()).length(0),
  })
  .strict();

async function checkedSet(input: string) {
  if (!input) throw new AppError("VALIDATION", 400, "请指定备份集目录。");
  const root = await trustedDirectory(input);
  const json = await readFile(join(root, "manifest.json"), "utf8");
  if ((await readFile(join(root, "COMPLETE"), "utf8")) !== sha(json))
    throw new AppError("HASH_MISMATCH", 409, "备份完成标记与清单不一致。");
  const manifest = manifestSchema.parse(JSON.parse(json)) as BackupManifest;
  const listed = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    safeRelative(file.path);
    if (listed.has(file.path))
      throw new AppError("VALIDATION", 400, "备份清单中有重复路径。");
    listed.add(file.path);
    if (file.path !== "state.db" && file.size > 100_000_000)
      throw new AppError("SCAN_LIMIT");
    total += file.size;
    if (total > 2_000_000_000) throw new AppError("SCAN_LIMIT");
    const checked = await hashFile(
      join(root, file.path),
      file.path === "state.db" ? 2_000_000_000 : 100_000_000,
    );
    if (checked.size !== file.size || checked.hash !== file.hash)
      throw new AppError("HASH_MISMATCH", 409, `备份文件不符：${file.path}`);
  }
  if (!listed.has("state.db") || !listed.has("state.db.reminder-fence"))
    throw new AppError("VALIDATION", 400, "缺少账本或提醒栅栏。");
  const diskFence = Number(
    await readFile(join(root, "state.db.reminder-fence"), "utf8"),
  );
  if (
    diskFence !== manifest.reminderFence ||
    manifest.reminderFence !== manifest.reminderAnchor
  )
    throw new AppError("CONFLICT", 409, "提醒栅栏或外部锚点不一致。");
  const check = checkDatabase(join(root, "state.db"));
  try {
    if (
      check.workspace.id !== manifest.workspaceId ||
      check.workspace.vaultPath !== manifest.vaultPath
    )
      throw new AppError("BASELINE", 409, "备份 Vault 身份与账本不符。");
    const fence = Number(
      (
        check.db
          .prepare("SELECT value FROM reminder_meta WHERE key='fence'")
          .get() as { value: string }
      ).value,
    );
    const watermark = (
      check.db.prepare("SELECT COALESCE(MAX(id),0) n FROM events").get() as {
        n: number;
      }
    ).n;
    if (
      fence !== manifest.reminderFence ||
      watermark !== manifest.eventWatermark
    )
      throw new AppError("BASELINE", 409, "备份水位与账本不符。");
  } finally {
    check.db.close();
  }
  const actual: string[] = [];
  const walk = async (dir: string, prefix = "") => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
        throw new AppError("FORBIDDEN", 403, "备份集包含符号链接或特殊文件。");
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else if (!["manifest.json", "COMPLETE"].includes(rel)) actual.push(rel);
    }
  };
  await walk(root);
  if (actual.length !== listed.size || actual.some((file) => !listed.has(file)))
    throw new AppError("BASELINE", 409, "备份集出现未列出的文件或清单缺项。");
  return { root, manifest };
}

export async function verifyBackupSet(input: string) {
  const { root, manifest } = await checkedSet(input);
  return {
    path: root,
    id: manifest.id,
    complete: true,
    schemaVersion: manifest.schemaVersion,
    workspaceId: manifest.workspaceId,
    eventWatermark: manifest.eventWatermark,
    pending: manifest.pending,
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
  };
}

export async function restoreSet(input: string, output: string) {
  const { root, manifest } = await checkedSet(input);
  if (!output)
    throw new AppError("VALIDATION", 400, "请指定新的隔离恢复目录。");
  const target = await canonicalDestination(output);
  const oldData = dirname(dirname(manifest.vaultPath));
  if (
    inside(root, target) ||
    inside(target, root) ||
    inside(oldData, target) ||
    inside(target, oldData)
  )
    throw new AppError("FORBIDDEN", 403);
  await mkdir(target, { mode: 0o700 });
  // Create the hold before copying any byte. A half-restored directory cannot serve.
  await writeFile(join(target, "state.db.restore-hold"), manifest.id, {
    flag: "wx",
    mode: 0o600,
  });
  for (const file of manifest.files) {
    const dest = join(target, file.path);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await copyVerified(join(root, file.path), dest, file);
  }
  const dbPath = join(target, "state.db");
  const store = new Store(dbPath);
  try {
    if (store.readOnly) throw new AppError("SCHEMA");
    store.db
      .transaction(() => {
        const workspace = store.get("workspace") as {
          vaultPath: string;
          backupPath: string;
          deviceId: string | null;
          epoch: number;
          policyVersion: number;
        };
        if (!inside(target, workspace.vaultPath)) {
          const vaultSuffix = workspace.vaultPath.slice(
            manifest.vaultPath.length,
          );
          if (vaultSuffix) throw new AppError("BASELINE");
          workspace.vaultPath = join(
            target,
            `workspace-${manifest.workspaceId}`,
            "pilot",
          );
          workspace.backupPath = join(
            target,
            `workspace-${manifest.workspaceId}`,
            "backup",
          );
        }
        workspace.deviceId = null;
        workspace.epoch++;
        workspace.policyVersion++;
        store.db
          .prepare("UPDATE kv SET value=? WHERE key='workspace'")
          .run(JSON.stringify(workspace));
        store.db
          .prepare(
            "INSERT OR REPLACE INTO kv(key,value) VALUES('recovery:paid',?)",
          )
          .run(JSON.stringify("review-required"));
        store.db.prepare("UPDATE sessions SET revoked=1").run();
        store.db.prepare("DELETE FROM writer_grants").run();
        store.db.prepare("DELETE FROM wiki_grants").run();
        store.db.prepare("DELETE FROM plan_note_grants").run();
        store.db
          .prepare(
            "UPDATE jobs SET cancelled=1,state='cancelled' WHERE state IN ('queued','running')",
          )
          .run();
        store.db
          .prepare(
            "UPDATE calls SET state='unknown' WHERE state IN ('reserved','dispatched')",
          )
          .run();
        store.db
          .prepare(
            "UPDATE reminder_attempts SET state='outcome_unknown',detail='隔离恢复：原发送结果未知' WHERE state='dispatching'",
          )
          .run();
        for (const row of store.db
          .prepare("SELECT id,value FROM reminder_rules WHERE enabled=1")
          .all() as { id: string; value: string }[]) {
          const rule = JSON.parse(row.value) as { enabled: boolean };
          rule.enabled = false;
          store.db
            .prepare("UPDATE reminder_rules SET enabled=0,value=? WHERE id=?")
            .run(JSON.stringify(rule), row.id);
        }
        for (const row of store.db
          .prepare(
            "SELECT logical_key,value FROM reminder_occurrences WHERE state IN ('scheduled','dispatching')",
          )
          .all() as { logical_key: string; value: string }[]) {
          const occurrence = JSON.parse(row.value) as {
            state: string;
            reason: string | null;
            generation: number;
            cancelGeneration: number;
          };
          occurrence.state = "cancelled";
          occurrence.reason = "隔离恢复：旧排期不可自动续期";
          occurrence.cancelGeneration = Math.max(
            occurrence.cancelGeneration,
            occurrence.generation,
          );
          store.db
            .prepare(
              "UPDATE reminder_occurrences SET state='cancelled',cancel_generation=?,value=? WHERE logical_key=?",
            )
            .run(
              occurrence.cancelGeneration,
              JSON.stringify(occurrence),
              row.logical_key,
            );
        }
      })
      .immediate();
    const result = {
      path: target,
      backupSet: manifest.id,
      workspaceId: manifest.workspaceId,
      mode: "diagnostic-only",
      oldSessionsRevoked: true,
      stagedLedgerDigest: ledgerDigest(store.db),
      reminderRulesDisabled: true,
      pendingAtBackup: manifest.pending,
      nextStep:
        "在独立目录核对人工文件、较新撤回／任务／费用事实和外部提醒记录；当前版本不自动切换生产数据。",
    };
    await writeFile(
      join(target, "RESTORE-REPORT.json"),
      JSON.stringify(result, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    return result;
  } finally {
    store.close();
  }
}

async function copyVerified(
  source: string,
  destination: string,
  file: BackupFile,
) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const output = await open(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const digest = createHash("sha256");
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      let size = 0;
      while (true) {
        const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > file.size) throw new AppError("HASH_MISMATCH");
        digest.update(chunk.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(
            chunk,
            written,
            bytesRead - written,
          );
          if (!result.bytesWritten)
            throw new AppError("BASELINE", 409, "隔离复制未能继续写入。");
          written += result.bytesWritten;
        }
      }
      if (size !== file.size || digest.digest("hex") !== file.hash)
        throw new AppError(
          "HASH_MISMATCH",
          409,
          `隔离复制时文件变化：${file.path}`,
        );
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}
