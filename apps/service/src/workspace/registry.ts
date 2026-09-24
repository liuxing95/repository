import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  writeFile,
  rm,
  lstat,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  Workspace,
  Settings,
  defaultSettings,
  type Principal,
} from "@kb/contracts";
import { Store } from "../storage/store";
import { AppError } from "../errors";
import { inside, trustedDirectory } from "../security/paths";

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const managed = ["KB-Sources", "KB-Wiki", "KB-Candidates", "KB-Plans"];
type FileEntry = { path: string; hash: string; size: number };

export class WorkspaceRegistry {
  constructor(
    readonly store: Store,
    readonly dataPath: string,
  ) {}
  get(): Workspace {
    const r = Workspace.safeParse(this.store.get("workspace"));
    if (!r.success) throw new AppError("SCHEMA");
    return r.data;
  }
  settings(): Settings {
    const r = Settings.safeParse(this.store.get("settings"));
    if (!r.success) throw new AppError("SCHEMA");
    return r.data;
  }
  async preview(input: string) {
    const root = await trustedDirectory(input);
    const conflicts: string[] = [];
    const files: FileEntry[] = [];
    const folders: string[] = [];
    const plugins: { id: string; version: string | null }[] = [];
    const ids = new Set<string>();
    let total = 0;
    const data = await trustedDirectory(this.dataPath);
    if (inside(root, data) || inside(data, root))
      throw new AppError("FORBIDDEN");
    let directories = 0;
    const walk = async (dir: string, depth = 0) => {
      if (++directories > 5000 || depth > 40) throw new AppError("SCAN_LIMIT");
      if ((await trustedDirectory(dir)) !== dir)
        throw new AppError("FORBIDDEN", 403);
      const names = new Set<string>();
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        const path = join(dir, entry.name);
        const key = entry.name.normalize("NFC").toLowerCase();
        if (names.has(key)) conflicts.push("NAME_COLLISION");
        names.add(key);
        if (entry.isSymbolicLink()) {
          conflicts.push("SYMLINK");
          continue;
        }
        if (entry.isDirectory()) {
          folders.push(relative(root, path));
          if (
            dir === root &&
            managed.some((name) => name.toLowerCase() === key)
          )
            conflicts.push("MANAGED_DIRECTORY");
          await walk(path, depth + 1);
          continue;
        }
        if (!entry.isFile()) {
          conflicts.push("SPECIAL_FILE");
          continue;
        }
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stat = await handle.stat();
          total += stat.size;
          if (
            stat.size > 20_000_000 ||
            total > 512_000_000 ||
            files.length >= 20_000
          )
            throw new AppError("SCAN_LIMIT");
          const bytes = await handle.readFile();
          const rel = relative(root, path);
          files.push({
            path: rel,
            hash: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.length,
          });
          const plugin = rel.match(
            /^\.obsidian\/plugins\/([^/]+)\/manifest\.json$/,
          );
          if (plugin) {
            let version: string | null = null;
            try {
              const manifest = JSON.parse(bytes.toString("utf8"));
              if (
                typeof manifest.version === "string" &&
                /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)
              )
                version = manifest.version;
            } catch {
              conflicts.push("PLUGIN_CONFIG");
            }
            plugins.push({ id: plugin[1]!, version });
          }
          if (rel.endsWith(".md")) {
            const frontmatter = bytes
              .toString("utf8")
              .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
            const id = frontmatter?.match(
              /^taskId:\s*["']?([\w-]+)["']?\s*$/m,
            )?.[1];
            if (id) {
              if (ids.has(id)) conflicts.push("DUPLICATE_ID");
              ids.add(id);
            }
          }
        } finally {
          await handle.close();
        }
      }
    };
    await walk(root);
    return {
      root,
      files,
      folders,
      plugins,
      conflicts: [...new Set(conflicts)],
      digest: digest({ files, folders }),
      totalBytes: total,
    };
  }
  async adopt(source: string, expectedDigest: string): Promise<Workspace> {
    this.store.writable();
    if (this.store.get("workspace")) throw new AppError("CONFLICT");
    const scan = await this.preview(source);
    if (scan.conflicts.length) throw new AppError("CONFLICT");
    if (scan.digest !== expectedDigest) throw new AppError("BASELINE");
    const id = randomUUID();
    const staging = join(
      await trustedDirectory(this.dataPath),
      `workspace-${id}`,
    );
    const vaultPath = join(staging, "pilot");
    const backupPath = join(staging, "backup");
    await mkdir(vaultPath, { recursive: true, mode: 0o700 });
    await mkdir(backupPath, { mode: 0o700 });
    try {
      const copyToPilot = (path: string) =>
        ![".obsidian", ".git"].some(
          (excluded) => path === excluded || path.startsWith(`${excluded}/`),
        );
      for (const folder of scan.folders) {
        await mkdir(join(backupPath, folder), { recursive: true, mode: 0o700 });
        if (copyToPilot(folder))
          await mkdir(join(vaultPath, folder), {
            recursive: true,
            mode: 0o700,
          });
      }
      for (const file of scan.files) {
        const path = join(scan.root, file.path);
        if ((await lstat(path)).isSymbolicLink())
          throw new AppError("BASELINE");
        if ((await trustedDirectory(dirname(path))) !== dirname(path))
          throw new AppError("BASELINE");
        const sourceHandle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const bytes = await sourceHandle
          .readFile()
          .finally(() => sourceHandle.close());
        if (createHash("sha256").update(bytes).digest("hex") !== file.hash)
          throw new AppError("BASELINE");
        for (const target of [
          backupPath,
          ...(copyToPilot(file.path) ? [vaultPath] : []),
        ]) {
          const dest = join(target, file.path);
          await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
          const out = await open(dest, "wx", 0o600);
          try {
            await out.writeFile(bytes);
            await out.sync();
          } finally {
            await out.close();
          }
          if (
            createHash("sha256")
              .update(await readFile(dest))
              .digest("hex") !== file.hash
          )
            throw new AppError("BACKUP");
        }
      }
      const finalScan = await this.preview(source);
      if (finalScan.digest !== expectedDigest || finalScan.conflicts.length)
        throw new AppError("BASELINE");
      await writeFile(
        join(staging, "backup-manifest.json"),
        JSON.stringify({
          source: scan.root,
          files: scan.files,
          folders: scan.folders,
          complete: true,
        }),
        { flag: "wx", mode: 0o600 },
      );
      for (const folder of managed)
        await mkdir(join(vaultPath, folder), { mode: 0o700 });
      const workspace: Workspace = {
        id,
        schemaVersion: 1,
        vaultPath,
        sourcePath: scan.root,
        deviceId: null,
        epoch: 0,
        policyVersion: 1,
        managedDirectories: managed,
        backupPath,
      };
      this.store.tx(() => {
        if (this.store.get("workspace")) throw new AppError("CONFLICT");
        this.store.set("workspace", workspace);
        this.store.set("settings", defaultSettings);
        this.store.event("workspace.adopted", id);
      });
      return workspace;
    } catch (e) {
      await rm(staging, { recursive: true, force: true });
      throw e;
    }
  }
  claimMaster(deviceId: string, expectedEpoch: number) {
    return this.store.tx(() => {
      const w = this.get();
      if (w.epoch !== expectedEpoch || w.deviceId) throw new AppError("MASTER");
      w.deviceId = deviceId;
      w.epoch++;
      this.store.set("workspace", w);
      this.store.event("master.claimed", w.id);
      return w;
    });
  }
  releaseMaster(principal: Principal) {
    return this.store.tx(() => {
      const w = this.get();
      if (principal.deviceId !== w.deviceId || principal.epoch !== w.epoch)
        throw new AppError("MASTER");
      const running = this.store.db
        .prepare(
          "SELECT count(*) n FROM jobs WHERE state IN ('queued','running')",
        )
        .get() as { n: number };
      const unsettled = this.store.db
        .prepare(
          "SELECT count(*) n FROM calls WHERE state IN ('reserved','dispatched','unknown')",
        )
        .get() as { n: number };
      const grants = this.store.db
        .prepare(
          "SELECT count(*) n FROM writer_grants g JOIN changesets c ON c.id=g.change_id WHERE json_extract(g.value,'$.expiresAt')>? AND json_extract(c.value,'$.state')='approved'",
        )
        .get(Date.now()) as { n: number };
      const reminders = this.store.db
        .prepare(
          "SELECT count(*) AS n FROM reminder_rules WHERE enabled=1 AND owner_id=?",
        )
        .get(principal.deviceId) as { n: number };
      const inFlightReminders = this.store.db
        .prepare(
          "SELECT count(*) AS n FROM reminder_attempts a LEFT JOIN reminder_reviews r ON r.delivery_key=a.delivery_key WHERE a.state='dispatching' OR (a.state='outcome_unknown' AND r.delivery_key IS NULL)",
        )
        .get() as { n: number };
      if (reminders.n || inFlightReminders.n)
        throw new AppError(
          "MASTER",
          409,
          "先关闭本机提醒规则，并核对在途或结果未知的发送尝试。",
        );
      if (running.n || unsettled.n || grants.n)
        throw new AppError("MASTER", 409, "请先停止并核对未完成作业。");
      w.deviceId = null;
      w.epoch++;
      this.store.set("workspace", w);
      this.store.event("master.released", w.id);
      return w;
    });
  }
  saveSettings(value: unknown, expectedVersion: number) {
    const parsed = Settings.safeParse(value);
    if (!parsed.success) throw new AppError("VALIDATION", 400);
    return this.store.tx(() => {
      const w = this.get();
      if (w.policyVersion !== expectedVersion) throw new AppError("BASELINE");
      const ids = parsed.data.routes.map((r) => r.id);
      if (new Set(ids).size !== ids.length)
        throw new AppError("VALIDATION", 400);
      const old = this.settings();
      const timezone = this.store.get("budgetTimezone") ?? old.budget?.timezone;
      if (
        timezone &&
        parsed.data.budget &&
        timezone !== parsed.data.budget.timezone &&
        (
          this.store.db.prepare("SELECT count(*) n FROM calls").get() as {
            n: number;
          }
        ).n
      )
        throw new AppError("CONFLICT", 409, "已有费用记录，不能改变预算时区。");
      if (parsed.data.budget)
        this.store.set("budgetTimezone", parsed.data.budget.timezone);
      w.policyVersion++;
      this.store.set("settings", parsed.data);
      this.store.set("workspace", w);
      this.store.event("policy.changed", w.id);
      return w;
    });
  }
  capabilities() {
    let valid = !this.store.readOnly && !this.store.restoreHeld;
    try {
      this.get();
      this.settings();
    } catch {
      valid = false;
    }
    return [
      {
        id: "governance",
        available: valid,
        enabled: valid,
        reason: valid ? "运行治理已就绪" : "数据版本待核对，仅诊断",
      },
      {
        id: "ingestion",
        available: valid && process.platform === "darwin",
        enabled: valid && process.platform === "darwin",
        reason: "静态获取、来源追踪与本机隔离解析；OCR 关闭",
      },
      {
        id: "writer",
        available: valid,
        enabled: valid,
        reason: "来源与候选新建、Wiki 受控更新；逐文件批准、同步基线保护与回读",
      },
      {
        id: "search",
        available: valid,
        enabled: valid,
        reason: "本地中文、别名与代码符号检索；固定引用、原文整理和知识检查",
      },
      {
        id: "tasknotes",
        available: valid,
        enabled:
          valid &&
          !!(
            this.store.get("tasks.inventory") as
              { complete?: boolean; observedAt?: number } | undefined
          )?.complete &&
          Date.now() -
            ((
              this.store.get("tasks.inventory") as
                { observedAt: number } | undefined
            )?.observedAt ?? 0) <
            30000,
        reason:
          "TaskNotes 4.13.4 Runtime 接入；完整核对后开放候选创建，自动字段更新关闭",
      },
      ...[
        "model",
        "ocr",
        "embedding",
        "rerank",
        "notification",
        "calendar",
        "publish",
      ].map((id) => ({
        id,
        available: false,
        enabled: false,
        reason: "对应业务适配器尚未接入；本轮不启用",
      })),
    ];
  }
}
