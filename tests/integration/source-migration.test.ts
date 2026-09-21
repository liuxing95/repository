import { test, expect } from "vitest";
import { createRequire } from "node:module";
const Database = createRequire(
  new URL("../../apps/service/package.json", import.meta.url),
)("better-sqlite3") as typeof import("better-sqlite3");
import { mkdtemp, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../apps/service/src/storage/store";
import { foundation } from "../../apps/service/src/storage/migrations/001-foundation";
test("known v1 migrates transactionally with a private recoverable backup; unknown schema stays read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-source-migration-"));
  const path = join(root, "state.db");
  try {
    const old = new Database(path);
    old.exec(foundation);
    old.prepare("INSERT INTO kv VALUES(?,?)").run("retained", '"unchanged"');
    old.close();
    const migrated = new Store(path);
    expect(migrated.readOnly).toBe(false);
    expect(migrated.get("retained")).toBe("unchanged");
    expect(migrated.db.pragma("user_version", { simple: true })).toBe(3);
    migrated.close();
    const backup = (await readdir(root)).find((n) => n.includes("before-v2"))!;
    expect((await stat(join(root, backup))).mode & 0o777).toBe(0o600);
    const restore = new Database(join(root, backup));
    expect(restore.pragma("user_version", { simple: true })).toBe(1);
    restore.close();
    const altered = new Database(path);
    altered.exec("CREATE TABLE unknown(id TEXT)");
    altered.close();
    const protectedStore = new Store(path);
    expect(protectedStore.readOnly).toBe(true);
    expect(() => protectedStore.set("x", 1)).toThrow("SCHEMA");
    protectedStore.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("known v2 preserves source objects and a private v2 backup; reopened v3 schema remains writable", async () => {
  const { sources } =
    await import("../../apps/service/src/storage/migrations/002-sources");
  const root = await mkdtemp(join(tmpdir(), "kb-evidence-migration-"));
  const path = join(root, "state.db");
  try {
    const old = new Database(path);
    old.exec(foundation);
    old.exec(sources);
    old
      .prepare("INSERT INTO objects VALUES(?,?)")
      .run("retained-hash", Buffer.from("original bytes"));
    old.close();
    const upgraded = new Store(path);
    expect(upgraded.db.pragma("user_version", { simple: true })).toBe(3);
    expect(
      upgraded.db
        .prepare("SELECT bytes FROM objects WHERE hash=?")
        .get("retained-hash"),
    ).toEqual({ bytes: Buffer.from("original bytes") });
    upgraded.close();
    const backup = (await readdir(root)).find((n) => n.includes("before-v3"))!;
    expect((await stat(join(root, backup))).mode & 0o777).toBe(0o600);
    const previous = new Database(join(root, backup));
    expect(previous.pragma("user_version", { simple: true })).toBe(2);
    previous.close();
    const reopened = new Store(path);
    expect(reopened.readOnly).toBe(false);
    expect(() =>
      reopened.db
        .prepare("SELECT * FROM search_fts WHERE search_fts MATCH ?")
        .all('"test"'),
    ).not.toThrow();
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
