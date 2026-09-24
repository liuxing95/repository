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
    expect(migrated.db.pragma("user_version", { simple: true })).toBe(8);
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

test("known v2 preserves source objects and a private v2 backup; reopened v8 schema remains writable", async () => {
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
    expect(upgraded.db.pragma("user_version", { simple: true })).toBe(8);
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

test("v3 upgrades with an exact private snapshot and v8 reopens with Wiki FTS intact", async () => {
  const { sources } =
    await import("../../apps/service/src/storage/migrations/002-sources");
  const { evidence } =
    await import("../../apps/service/src/storage/migrations/003-evidence");
  const root = await mkdtemp(join(tmpdir(), "kb-wiki-migration-")),
    path = join(root, "state.db");
  try {
    const old = new Database(path);
    old.exec(foundation);
    old.exec(sources);
    old.exec(evidence);
    old
      .prepare("INSERT INTO answer_candidates VALUES(?,?)")
      .run("preserved", '{"answer":"unchanged"}');
    old.close();
    const upgraded = new Store(path);
    expect(upgraded.db.pragma("user_version", { simple: true })).toBe(8);
    expect(
      upgraded.db
        .prepare("SELECT value FROM answer_candidates WHERE id='preserved'")
        .get(),
    ).toEqual({ value: '{"answer":"unchanged"}' });
    upgraded.close();
    const file = (await readdir(root)).find((n) => n.includes("before-v4"))!;
    expect((await stat(join(root, file))).mode & 0o777).toBe(0o600);
    const snapshot = new Database(join(root, file));
    expect(snapshot.pragma("user_version", { simple: true })).toBe(3);
    snapshot.close();
    const reopened = new Store(path);
    expect(reopened.readOnly).toBe(false);
    expect(reopened.db.prepare("SELECT * FROM wiki_fts").all()).toEqual([]);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v4 research migration keeps Wiki records and a private v4 backup", async () => {
  const { sources } =
    await import("../../apps/service/src/storage/migrations/002-sources");
  const { evidence } =
    await import("../../apps/service/src/storage/migrations/003-evidence");
  const { changesets } =
    await import("../../apps/service/src/storage/migrations/004-changesets");
  const root = await mkdtemp(join(tmpdir(), "kb-research-migration-")),
    path = join(root, "state.db");
  try {
    const old = new Database(path);
    old.exec(foundation);
    old.exec(sources);
    old.exec(evidence);
    old.exec(changesets);
    old
      .prepare("INSERT INTO wiki_changes VALUES(?,?,?,?)")
      .run("retained", "op", "hash", '{"retained":true}');
    old.close();
    const upgraded = new Store(path);
    expect(upgraded.db.pragma("user_version", { simple: true })).toBe(8);
    expect(
      upgraded.db
        .prepare("SELECT value FROM wiki_changes WHERE id='retained'")
        .get(),
    ).toEqual({ value: '{"retained":true}' });
    upgraded.close();
    const file = (await readdir(root)).find((n) => n.includes("before-v5"))!;
    expect((await stat(join(root, file))).mode & 0o777).toBe(0o600);
    const snapshot = new Database(join(root, file));
    expect(snapshot.pragma("user_version", { simple: true })).toBe(4);
    snapshot.close();
    const reopened = new Store(path);
    expect(reopened.readOnly).toBe(false);
    expect(reopened.db.prepare("SELECT * FROM research_reports").all()).toEqual(
      [],
    );
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v5 learning migration preserves research and creates a private v5 backup", async () => {
  const { sources } =
    await import("../../apps/service/src/storage/migrations/002-sources");
  const { evidence } =
    await import("../../apps/service/src/storage/migrations/003-evidence");
  const { changesets } =
    await import("../../apps/service/src/storage/migrations/004-changesets");
  const { research } =
    await import("../../apps/service/src/storage/migrations/005-research");
  const root = await mkdtemp(join(tmpdir(), "kb-learning-migration-")),
    path = join(root, "state.db");
  try {
    const old = new Database(path);
    old.exec(foundation + sources + evidence + changesets + research);
    old
      .prepare("INSERT INTO research_jobs VALUES(?,?,?,?)")
      .run("retained", "operation", "digest", '{"rootId":"retained-budget"}');
    old.close();
    const upgraded = new Store(path);
    expect(upgraded.db.pragma("user_version", { simple: true })).toBe(8);
    expect(
      upgraded.db
        .prepare("SELECT value FROM research_jobs WHERE id='retained'")
        .get(),
    ).toEqual({ value: '{"rootId":"retained-budget"}' });
    upgraded.close();
    const file = (await readdir(root)).find((n) => n.includes("before-v6"))!;
    expect((await stat(join(root, file))).mode & 0o777).toBe(0o600);
    const before = new Database(join(root, file));
    expect(before.pragma("user_version", { simple: true })).toBe(5);
    before.close();
    const reopened = new Store(path);
    expect(reopened.readOnly).toBe(false);
    expect(
      reopened.db.prepare("SELECT * FROM learning_attempts").all(),
    ).toEqual([]);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v6 tasks migration preserves learning attempts and private recoverable snapshot", async () => {
  const { sources } =
    await import("../../apps/service/src/storage/migrations/002-sources");
  const { evidence } =
    await import("../../apps/service/src/storage/migrations/003-evidence");
  const { changesets } =
    await import("../../apps/service/src/storage/migrations/004-changesets");
  const { research } =
    await import("../../apps/service/src/storage/migrations/005-research");
  const { learning } =
    await import("../../apps/service/src/storage/migrations/006-learning");
  const root = await mkdtemp(join(tmpdir(), "kb-tasks-migration-")),
    path = join(root, "state.db");
  try {
    const old = new Database(path);
    old.exec(
      foundation + sources + evidence + changesets + research + learning,
    );
    old
      .prepare("INSERT INTO learning_attempts VALUES(?,?,?,?,?)")
      .run("attempt", "goal", "unit", "baseline", '{"expression":"retained"}');
    old.close();
    const current = new Store(path);
    expect(current.db.pragma("user_version", { simple: true })).toBe(8);
    expect(
      current.db
        .prepare("SELECT value FROM learning_attempts WHERE id='attempt'")
        .get(),
    ).toEqual({ value: '{"expression":"retained"}' });
    current.close();
    const file = (await readdir(root)).find((n) => n.includes("before-v7"))!;
    expect((await stat(join(root, file))).mode & 0o777).toBe(0o600);
    const snapshot = new Database(join(root, file));
    expect(snapshot.pragma("user_version", { simple: true })).toBe(6);
    snapshot.close();
    const reopened = new Store(path);
    expect(reopened.readOnly).toBe(false);
    expect(
      reopened.db.prepare("SELECT * FROM task_observations").all(),
    ).toEqual([]);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v7 planning migration preserves task observations and a private v7 snapshot", async () => {
  const { sources } =
    await import("../../apps/service/src/storage/migrations/002-sources");
  const { evidence } =
    await import("../../apps/service/src/storage/migrations/003-evidence");
  const { changesets } =
    await import("../../apps/service/src/storage/migrations/004-changesets");
  const { research } =
    await import("../../apps/service/src/storage/migrations/005-research");
  const { learning } =
    await import("../../apps/service/src/storage/migrations/006-learning");
  const { tasks } =
    await import("../../apps/service/src/storage/migrations/007-tasks");
  const root = await mkdtemp(join(tmpdir(), "kb-planning-migration-")),
    path = join(root, "state.db");
  try {
    const old = new Database(path);
    old.exec(
      foundation +
        sources +
        evidence +
        changesets +
        research +
        learning +
        tasks,
    );
    old
      .prepare("INSERT INTO task_observations VALUES(?,?)")
      .run("task", '{"revision":"retained"}');
    old.close();
    const upgraded = new Store(path);
    expect(upgraded.db.pragma("user_version", { simple: true })).toBe(8);
    expect(
      upgraded.db
        .prepare("SELECT value FROM task_observations WHERE task_id='task'")
        .get(),
    ).toEqual({ value: '{"revision":"retained"}' });
    upgraded.close();
    const backup = (await readdir(root)).find((n) => n.includes("before-v8"))!;
    expect((await stat(join(root, backup))).mode & 0o777).toBe(0o600);
    const snapshot = new Database(join(root, backup));
    expect(snapshot.pragma("user_version", { simple: true })).toBe(7);
    snapshot.close();
    const reopened = new Store(path);
    expect(reopened.readOnly).toBe(false);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
