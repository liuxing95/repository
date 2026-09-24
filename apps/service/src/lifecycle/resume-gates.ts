import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "../errors";
import { trustedDirectory } from "../security/paths";
import { Store } from "../storage/store";
import {
  catalogue,
  checkDatabase,
  ledgerDigest,
  sha,
  type BackupManifest,
} from "./backup";
import { verifyBackupSet } from "./restore";

const criticalTables = [
  "kv",
  "sessions",
  "jobs",
  "roots",
  "calls",
  "commands",
  "events",
  "objects",
  "ingestions",
  "sources",
  "source_revisions",
  "parse_artifacts",
  "changesets",
  "writer_grants",
  "writer_receipts",
  "evidence_profiles",
  "source_lineage",
  "evidence",
  "evidence_claims",
  "evidence_relations",
  "query_snapshots",
  "answer_cache",
  "answer_candidates",
  "wiki_changes",
  "wiki_approvals",
  "wiki_grants",
  "wiki_receipts",
  "wiki_pages",
  "wiki_revisions",
  "wiki_edges",
  "wiki_observations",
  "wiki_impacts",
  "research_jobs",
  "research_snapshots",
  "research_assessments",
  "research_chapters",
  "research_attempts",
  "research_reports",
  "learning_goals",
  "learning_baselines",
  "learning_choices",
  "learning_attempts",
  "learning_evaluations",
  "learning_suggestions",
  "learning_task_intents",
  "learning_operations",
  "task_observations",
  "task_observation_history",
  "task_inventories",
  "task_inventory_items",
  "task_occurrences",
  "task_commands",
  "task_event_inbox",
  "task_invalidations",
  "task_cancel_outbox",
  "task_baselines",
  "task_plan_reads",
  "projection_receipts",
  "planning_candidates",
  "plan_revisions",
  "plan_adoptions",
  "plan_outbox",
  "plan_note_grants",
  "reminder_rules",
  "reminder_occurrences",
  "reminder_attempts",
  "reminder_reviews",
  "reminder_pauses",
  "reminder_meta",
];

export async function restoreAudit(setInput: string, currentInput: string) {
  const set = await verifyBackupSet(setInput);
  const current = await trustedDirectory(currentInput);
  if (existsSync(join(current, "service.lock")))
    throw new AppError("SERVICE_LOCK", 409, "核对时须先停止当前服务。");
  const backup = checkDatabase(join(set.path, "state.db"));
  const live = checkDatabase(join(current, "state.db"));
  const conflicts: string[] = [];
  try {
    if (backup.workspace.id !== live.workspace.id)
      conflicts.push("workspace-id");
    const snapshot = (db: typeof backup.db, table: string) => {
      const digest = createHash("sha256");
      for (const row of db
        .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
        .iterate())
        digest.update(JSON.stringify(row)).update("\n");
      return digest.digest("hex");
    };
    for (const table of criticalTables)
      if (snapshot(backup.db, table) !== snapshot(live.db, table))
        conflicts.push(table);
    const policies = (db: typeof backup.db) =>
      JSON.stringify(
        db
          .prepare(
            "SELECT key,value FROM kv WHERE key='workspace' OR key='settings' OR key LIKE 'source:%' OR key LIKE 'retraction:%' OR key LIKE 'tasks.%' OR key LIKE 'recovery:%' ORDER BY key",
          )
          .all(),
      );
    if (policies(backup.db) !== policies(live.db))
      conflicts.push("policy-and-task-facts");
    const watermark = (db: typeof backup.db) =>
      (
        db.prepare("SELECT COALESCE(MAX(id),0) n FROM events").get() as {
          n: number;
        }
      ).n;
    if (watermark(backup.db) !== watermark(live.db))
      conflicts.push("event-watermark");
    const manifest = JSON.parse(
      await readFile(join(set.path, "manifest.json"), "utf8"),
    ) as BackupManifest;
    const backedData = manifest.files.filter(
      (file) => file.path !== "state.db",
    );
    const currentData = await catalogue(current);
    if (!currentData.some((file) => file.path === "state.db.reminder-fence")) {
      currentData.push({
        path: "state.db.reminder-fence",
        hash: sha("0"),
        size: 1,
      });
    }
    const ordered = (files: typeof backedData) =>
      JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)));
    if (ordered(backedData) !== ordered(currentData))
      conflicts.push("application-files");
    const prefix = `workspace-${manifest.workspaceId}/pilot/`;
    const backedVault = manifest.files
      .filter((f) => f.path.startsWith(prefix))
      .map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
    const currentVault = await catalogue(live.workspace.vaultPath);
    if (JSON.stringify(backedVault) !== JSON.stringify(currentVault))
      conflicts.push("vault-files");
    const anchorPath = new Store(join(current, "state.db"));
    try {
      if (anchorPath.reminderPaused) conflicts.push("reminder-anchor");
    } finally {
      anchorPath.close();
    }
    const digest = sha(
      JSON.stringify({ set: set.id, workspaceId: set.workspaceId, conflicts }),
    );
    return {
      backupSet: set.id,
      workspaceId: set.workspaceId,
      currentData: current,
      conflicts,
      canResume: conflicts.length === 0,
      confirmDigest: conflicts.length === 0 ? digest : null,
      capabilityGates: {
        reads: conflicts.length ? "closed" : "reviewed",
        writer: "closed-until-new-pairing",
        paidCalls: "closed-until-new-pairing-and-budget-review",
        reminders: "closed-until-rules-explicitly-reenabled",
      },
    };
  } finally {
    backup.db.close();
    live.db.close();
  }
}

export async function restoreResume(
  stageInput: string,
  setInput: string,
  currentInput: string,
  confirm: string,
) {
  const stage = await trustedDirectory(stageInput);
  if (!existsSync(join(stage, "state.db.restore-hold")))
    throw new AppError("CONFLICT", 409, "目标目录没有隔离恢复标记。");
  if (existsSync(join(stage, "service.lock")))
    throw new AppError(
      "SERVICE_LOCK",
      409,
      "解除隔离前须停止恢复目录中的服务。",
    );
  const audit = await restoreAudit(setInput, currentInput);
  const marker = (
    await readFile(join(stage, "state.db.restore-hold"), "utf8")
  ).trim();
  if (
    !audit.canResume ||
    !confirm ||
    confirm !== audit.confirmDigest ||
    marker !== audit.backupSet
  )
    throw new AppError("BASELINE", 409, "恢复核对未通过或确认摘要不匹配。");
  const manifest = JSON.parse(
    await readFile(join(setInput, "manifest.json"), "utf8"),
  ) as BackupManifest;
  const allowed = new Set(
    manifest.files
      .filter((entry) => entry.path !== "state.db")
      .map((entry) => entry.path),
  );
  allowed.add("RESTORE-REPORT.json");
  const stagedFiles = await catalogue(stage);
  if (
    stagedFiles.length !== allowed.size ||
    stagedFiles.some((entry) => !allowed.has(entry.path))
  )
    throw new AppError(
      "BASELINE",
      409,
      "隔离目录含未核对的文件或缺少恢复文件。",
    );
  for (const file of manifest.files.filter(
    (entry) => entry.path !== "state.db",
  )) {
    const handle = await open(
      join(stage, file.path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const bytes = await handle.readFile();
      if (bytes.length !== file.size || sha(bytes) !== file.hash)
        throw new AppError(
          "HASH_MISMATCH",
          409,
          `隔离恢复文件不符：${file.path}`,
        );
    } finally {
      await handle.close();
    }
  }
  const staged = checkDatabase(join(stage, "state.db"));
  try {
    if (staged.workspace.id !== audit.workspaceId)
      throw new AppError("BASELINE");
    const report = JSON.parse(
      await readFile(join(stage, "RESTORE-REPORT.json"), "utf8"),
    ) as { backupSet?: string; stagedLedgerDigest?: string };
    if (
      report.backupSet !== audit.backupSet ||
      report.stagedLedgerDigest !== ledgerDigest(staged.db)
    )
      throw new AppError("BASELINE", 409, "隔离恢复账本在演练后发生变化。");
  } finally {
    staged.db.close();
  }
  const store = new Store(join(stage, "state.db"));
  try {
    // The stage path has its own anchor. Only an equal, verified live ledger can initialize it.
    const fence = (await readFile(store.reminderFencePath, "utf8")).trim();
    if (existsSync(store.reminderAnchorPath)) {
      if ((await readFile(store.reminderAnchorPath, "utf8")).trim() !== fence)
        throw new AppError("CONFLICT", 409, "恢复目录已有不同提醒栅栏锚点。");
    } else
      await writeFile(store.reminderAnchorPath, fence, {
        flag: "wx",
        mode: 0o600,
      });
    const report = JSON.stringify(
      {
        backupSet: audit.backupSet,
        at: Date.now(),
        reads: "enabled",
        oldSessions: "revoked",
        writer: "new pairing and review required",
        paidCalls: "unknown costs preserved; new budget review required",
        reminders: "rules disabled; explicit re-registration required",
      },
      null,
      2,
    );
    if (!existsSync(join(stage, "RESUME-REPORT.json")))
      await writeFile(join(stage, "RESUME-REPORT.json"), report, {
        flag: "wx",
        mode: 0o600,
      });
    await rm(store.restoreHoldPath);
    return {
      path: stage,
      resumed: true,
      reminderRulesDisabled: true,
      oldSessionsRevoked: true,
    };
  } finally {
    store.close();
  }
}
