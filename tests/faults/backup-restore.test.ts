import { expect, test } from "vitest";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fixture } from "../helpers";
import { publish } from "../evidence-helpers";
import { backupSet, sha } from "../../apps/service/src/lifecycle/backup";
import {
  verifyBackupSet,
  restoreSet,
} from "../../apps/service/src/lifecycle/restore";
import {
  restoreAudit,
  restoreResume,
} from "../../apps/service/src/lifecycle/resume-gates";
import { Retraction } from "../../apps/service/src/lifecycle/retraction";
import { Store } from "../../apps/service/src/storage/store";
import { WorkspaceRegistry } from "../../apps/service/src/workspace/registry";
import { Sessions } from "../../apps/service/src/http/auth";
import { Jobs } from "../../apps/service/src/runtime/jobs";
import { createServer } from "../../apps/service/src/http/server";
import { randomUUID } from "node:crypto";

test("a complete set restores into a held directory and resumes only after equal-ledger audit", async () => {
  const f = await fixture();
  try {
    publish(f, "备份原件");
    const setPath = join(f.root, "backup-set");
    const stagePath = join(f.root, "rehearsal");
    const set = await backupSet(f.registry, setPath);
    expect(set.complete, JSON.stringify(set.errors)).toBe(true);
    expect((await verifyBackupSet(setPath)).files).toBeGreaterThan(1);
    const stage = await restoreSet(setPath, stagePath);
    expect(stage.mode).toBe("diagnostic-only");
    const held = new Store(join(stagePath, "state.db"));
    expect(held.restoreHeld).toBe(true);
    expect(() => held.writable()).toThrow();
    expect(
      held.db.prepare("SELECT COUNT(*) n FROM sessions WHERE revoked=0").get(),
    ).toEqual({ n: 0 });
    expect(held.get("recovery:paid")).toBe("review-required");
    held.close();
    const audit = await restoreAudit(setPath, f.data);
    expect(audit.conflicts).toEqual([]);
    expect(audit.confirmDigest).toBeTruthy();
    await expect(
      restoreResume(stagePath, setPath, f.data, "wrong"),
    ).rejects.toThrow();
    expect(
      (await restoreResume(stagePath, setPath, f.data, audit.confirmDigest!))
        .resumed,
    ).toBe(true);
    const resumed = new Store(join(stagePath, "state.db"));
    expect(resumed.restoreHeld).toBe(false);
    expect(resumed.reminderPaused).toBe(false);
    const registry = new WorkspaceRegistry(resumed, stagePath);
    const sessions = new Sessions(registry);
    const paired = await sessions.pair({
      code: sessions.issuePairing(),
      deviceId: randomUUID(),
      vaultPath: registry.get().vaultPath,
    });
    const app = createServer(registry, sessions, new Jobs(resumed));
    try {
      expect(
        (
          await app.inject({
            url: "/v1/recovery/paid-gate",
            headers: {
              host: "127.0.0.1:27124",
              authorization: `Bearer ${paired.token}`,
            },
          })
        ).json().state,
      ).toBe("review-required");
      const reopened = await app.inject({
        method: "POST",
        url: "/v1/recovery/paid-gate/reopen",
        headers: {
          host: "127.0.0.1:27124",
          authorization: `Bearer ${paired.token}`,
          "x-policy-version": String(registry.get().policyVersion),
          "x-operation-key": randomUUID(),
        },
        payload: { reviewedUnknownCalls: 0, confirm: true },
      });
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json().state).toBe("open");
    } finally {
      await app.close();
      resumed.close();
    }
  } finally {
    await f.close();
  }
});

test("tampering, changed Vault, and newer retraction cannot silently revive a backup", async () => {
  const f = await fixture();
  try {
    publish(f, "需要撤回的原件");
    const sourceId = (
      f.store.db.prepare("SELECT id FROM sources").get() as { id: string }
    ).id;
    const setPath = join(f.root, "backup-set");
    const stagePath = join(f.root, "rehearsal");
    expect((await backupSet(f.registry, setPath)).complete).toBe(true);
    await restoreSet(setPath, stagePath);
    new Retraction(f.registry).retract(
      sourceId,
      f.principal.id,
      "验证较新撤回",
    );
    const audit = await restoreAudit(setPath, f.data);
    expect(audit.canResume).toBe(false);
    expect(audit.conflicts).toContain("policy-and-task-facts");
    await expect(
      restoreResume(stagePath, setPath, f.data, "anything"),
    ).rejects.toThrow();
    const vaultFile = join(f.registry.get().vaultPath, "note.md");
    await writeFile(vaultFile, "人工修改");
    expect((await restoreAudit(setPath, f.data)).conflicts).toContain(
      "vault-files",
    );
    const saved = await readFile(join(setPath, "state.db.reminder-fence"));
    await writeFile(join(setPath, "state.db.reminder-fence"), "999");
    await expect(verifyBackupSet(setPath)).rejects.toThrow();
    await writeFile(join(setPath, "state.db.reminder-fence"), saved);
  } finally {
    await f.close();
  }
});

test("a correctly rehashed set with an unknown database schema still cannot restore", async () => {
  const f = await fixture();
  try {
    const setPath = join(f.root, "backup-set");
    expect((await backupSet(f.registry, setPath)).complete).toBe(true);
    const dbPath = join(setPath, "state.db");
    f.store.db.prepare("ATTACH DATABASE ? AS tampered").run(dbPath);
    f.store.db.pragma("tampered.user_version = 999");
    f.store.db.exec("DETACH DATABASE tampered");
    const bytes = await readFile(dbPath);
    const manifest = JSON.parse(
      await readFile(join(setPath, "manifest.json"), "utf8"),
    ) as {
      files: { path: string; hash: string; size: number }[];
    };
    const file = manifest.files.find((entry) => entry.path === "state.db")!;
    file.hash = sha(bytes);
    file.size = bytes.length;
    const json = JSON.stringify(manifest, null, 2);
    await writeFile(join(setPath, "manifest.json"), json);
    await writeFile(join(setPath, "COMPLETE"), sha(json));
    await expect(verifyBackupSet(setPath)).rejects.toThrow("SCHEMA");
  } finally {
    await f.close();
  }
});

test("a staged ledger changed after isolation cannot pass resume", async () => {
  const f = await fixture();
  try {
    const setPath = join(f.root, "backup-set");
    const stagePath = join(f.root, "rehearsal");
    expect((await backupSet(f.registry, setPath)).complete).toBe(true);
    await restoreSet(setPath, stagePath);
    const audit = await restoreAudit(setPath, f.data);
    const staged = new Store(join(stagePath, "state.db"));
    staged.db
      .prepare("UPDATE kv SET value=? WHERE key='settings'")
      .run('"tampered"');
    staged.close();
    await expect(
      restoreResume(stagePath, setPath, f.data, audit.confirmDigest!),
    ).rejects.toThrow("BASELINE");
  } finally {
    await f.close();
  }
});
