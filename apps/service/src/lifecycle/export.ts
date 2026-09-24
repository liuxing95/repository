import { constants } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError } from "../errors";
import {
  canonicalDestination,
  inside,
  trustedDirectory,
} from "../security/paths";
import type { WorkspaceRegistry } from "../workspace/registry";
import { catalogue, sha } from "./backup";

export async function exitExport(registry: WorkspaceRegistry, output: string) {
  if (!output)
    throw new AppError("VALIDATION", 400, "请指定新的退出导出目录。");
  const workspace = registry.get();
  const target = await canonicalDestination(output);
  if (
    inside(registry.dataPath, target) ||
    inside(target, registry.dataPath) ||
    inside(workspace.vaultPath, target)
  )
    throw new AppError("FORBIDDEN");
  await mkdir(target, { mode: 0o700 });
  const files = await catalogue(workspace.vaultPath);
  for (const file of files) {
    const input = await open(
      join(workspace.vaultPath, file.path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const bytes = await input.readFile().finally(() => input.close());
    if (sha(bytes) !== file.hash)
      throw new AppError("BASELINE", 409, "导出期间 Vault 文件发生变化。");
    const dest = join(target, "Vault", file.path);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await writeFile(dest, bytes, { flag: "wx", mode: 0o600 });
  }
  if (
    JSON.stringify(files) !==
    JSON.stringify(await catalogue(workspace.vaultPath))
  )
    throw new AppError("BASELINE", 409, "导出期间 Vault 文件发生变化。");
  const db = registry.store.db;
  await mkdir(join(target, "originals"), { mode: 0o700 });
  const originals: { hash: string; size: number }[] = [];
  for (const row of db
    .prepare("SELECT hash,bytes FROM objects")
    .iterate() as Iterable<{ hash: string; bytes: Buffer }>) {
    if (sha(row.bytes) !== row.hash) throw new AppError("HASH_MISMATCH");
    await writeFile(join(target, "originals", row.hash), row.bytes, {
      flag: "wx",
      mode: 0o600,
    });
    originals.push({ hash: row.hash, size: row.bytes.length });
  }
  const rows = (sql: string) => db.prepare(sql).all();
  const sourceMap = {
    sources: rows("SELECT id,identity FROM sources ORDER BY id"),
    revisions: rows(
      "SELECT id,source_id,object_hash,value FROM source_revisions ORDER BY id",
    ),
    evidence: rows("SELECT id,value FROM evidence ORDER BY id"),
  };
  const learning = {
    goals: rows("SELECT id,value FROM learning_goals ORDER BY id"),
    baselines: rows(
      "SELECT id,goal_id,value FROM learning_baselines ORDER BY id",
    ),
    attempts: rows(
      "SELECT id,goal_id,unit_id,value FROM learning_attempts ORDER BY id",
    ),
    evaluations: rows(
      "SELECT id,attempt_id,value FROM learning_evaluations ORDER BY id",
    ),
  };
  const plans = {
    revisions: rows("SELECT id,value FROM plan_revisions ORDER BY accepted_at"),
    adoptions: rows(
      "SELECT id,candidate_id,at,mode FROM plan_adoptions ORDER BY at",
    ),
  };
  const pending = {
    jobs: rows(
      "SELECT id,state,stage,cancelled FROM jobs WHERE state IN ('queued','running')",
    ),
    calls: rows(
      "SELECT id,state,route,reserved,actual FROM calls WHERE state IN ('reserved','dispatched','unknown')",
    ),
    reminders: rows(
      "SELECT id,logical_key,state,detail FROM reminder_attempts WHERE state IN ('dispatching','outcome_unknown')",
    ),
    taskCancels: rows(
      "SELECT id,state FROM task_cancel_outbox WHERE state!='done'",
    ),
    planOutbox: rows(
      "SELECT id,target,state FROM plan_outbox WHERE state!='done'",
    ),
  };
  for (const [name, value] of Object.entries({
    "source-map": sourceMap,
    learning,
    plans,
    pending,
  }))
    await writeFile(
      join(target, `${name}.json`),
      JSON.stringify(value, null, 2),
      { flag: "wx", mode: 0o600 },
    );
  const readme = `# 退出导出\n\n这是可独立阅读的本地导出，不会删除原 Vault、撤销凭据或取消已经发送的外部内容。\n\n- Vault/：笔记与受管页面的原始字节，共 ${files.length} 个文件。\n- originals/：按 SHA-256 命名的原件，共 ${originals.length} 个。\n- source-map.json：来源、修订与证据映射。\n- learning.json：目标、基线、尝试与评价历史。\n- plans.json：采用过的计划及历史。\n- pending.json：导出时仍需核对的作业、费用、提醒和投影。\n\n禁用插件不会删除这些文件。密钥保存在操作系统凭据库，没有写入本导出；凭据撤销和外部副本清理须单独执行。\n`;
  await writeFile(join(target, "README.md"), readme, {
    flag: "wx",
    mode: 0o600,
  });
  const packageFiles = await catalogue(target);
  const manifest = {
    format: 1,
    workspaceId: workspace.id,
    files,
    originals,
    packageFiles,
    generatedAt: Date.now(),
    complete: true,
  };
  const json = JSON.stringify(manifest, null, 2);
  await writeFile(join(target, "manifest.json"), json, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(target, "COMPLETE"), sha(json), {
    flag: "wx",
    mode: 0o600,
  });
  return {
    path: target,
    vaultFiles: files.length,
    originals: originals.length,
    pending,
  };
}

export async function verifyExitExport(input: string) {
  if (!input) throw new AppError("VALIDATION", 400, "请指定退出导出目录。");
  const root = await trustedDirectory(input);
  const json = await readFile(join(root, "manifest.json"), "utf8");
  if ((await readFile(join(root, "COMPLETE"), "utf8")) !== sha(json))
    throw new AppError("HASH_MISMATCH", 409, "退出导出的完成标记不一致。");
  const manifest = JSON.parse(json) as {
    format: number;
    workspaceId: string;
    complete: boolean;
    packageFiles: { path: string; hash: string; size: number }[];
  };
  if (
    manifest.format !== 1 ||
    manifest.complete !== true ||
    !Array.isArray(manifest.packageFiles)
  )
    throw new AppError("VALIDATION", 400, "退出导出清单格式不符。");
  const actual = (await catalogue(root)).filter(
    (file) => !["manifest.json", "COMPLETE"].includes(file.path),
  );
  if (JSON.stringify(actual) !== JSON.stringify(manifest.packageFiles))
    throw new AppError(
      "HASH_MISMATCH",
      409,
      "退出导出文件缺失、增加或哈希不符。",
    );
  return {
    path: root,
    workspaceId: manifest.workspaceId,
    complete: true,
    files: actual.length,
  };
}
