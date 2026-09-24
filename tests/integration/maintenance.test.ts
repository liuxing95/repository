import { expect, test } from "vitest";
import { join } from "node:path";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fixture } from "../helpers";
import { publish } from "../evidence-helpers";
import { createServer } from "../../apps/service/src/http/server";
import {
  exitExport,
  verifyExitExport,
} from "../../apps/service/src/lifecycle/export";
import { purgeInventory } from "../../apps/service/src/lifecycle/purge";
import { backupSet } from "../../apps/service/src/lifecycle/backup";
import { verifyBackupSet } from "../../apps/service/src/lifecycle/restore";
import { Policy } from "../../apps/service/src/security/policy";

test("authenticated retraction blocks reauthorization while preserving tasks and reports affected copies", async () => {
  const f = await fixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
  try {
    publish(f, "需要保护的原件");
    const sourceId = (
      f.store.db.prepare("SELECT id FROM sources").get() as { id: string }
    ).id;
    f.store.set("tasks.example", { taskId: "kept" });
    const res = await app.inject({
      method: "POST",
      url: `/v1/sources/${sourceId}/retract`,
      headers: {
        host: "127.0.0.1:27124",
        authorization: `Bearer ${f.token}`,
        "x-policy-version": String(f.registry.get().policyVersion),
        "x-operation-key": randomUUID(),
      },
      payload: { reason: "来源授权到期" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().record.reason).toBe("来源授权到期");
    expect(purgeInventory(f.registry, sourceId).physicalDeletionPerformed).toBe(
      false,
    );
    expect(f.store.get("tasks.example")).toEqual({ taskId: "kept" });
    expect(() =>
      new Policy(f.registry).setSource({
        sourceId,
        retracted: false,
        routes: Object.fromEntries(
          [
            "read",
            "fetch",
            "model",
            "ocr",
            "embedding",
            "rerank",
            "notification",
            "calendar",
            "publish",
          ].map((key) => [key, []]),
        ),
      }),
    ).toThrow();
  } finally {
    await app.close();
    await f.close();
  }
});

test("exit package retains readable Vault and original bytes; incomplete backup cannot verify", async () => {
  const f = await fixture();
  try {
    publish(f, "离线原件");
    const out = await exitExport(f.registry, join(f.root, "exit"));
    expect(out.vaultFiles).toBeGreaterThan(0);
    expect(await readFile(join(out.path, "Vault", "note.md"), "utf8")).toBe(
      "人工私密正文",
    );
    expect(await readFile(join(out.path, "README.md"), "utf8")).toContain(
      "退出导出",
    );
    expect((await verifyExitExport(out.path)).complete).toBe(true);
    await writeFile(join(out.path, "plans.json"), "{}");
    await expect(verifyExitExport(out.path)).rejects.toThrow();
    const setPath = join(f.root, "backup-set");
    const set = await backupSet(f.registry, setPath);
    expect(set.complete, JSON.stringify(set.errors)).toBe(true);
    await writeFile(join(setPath, "COMPLETE"), "bad");
    await expect(verifyBackupSet(setPath)).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("an unsafe application file leaves a partial backup without a completion marker", async () => {
  const f = await fixture();
  try {
    await symlink(f.source, join(f.data, "unexpected-link"));
    const setPath = join(f.root, "backup-set");
    const result = await backupSet(f.registry, setPath);
    expect(result.complete).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    await expect(verifyBackupSet(setPath)).rejects.toThrow();
  } finally {
    await f.close();
  }
});
