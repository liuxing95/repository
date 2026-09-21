import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../apps/service/src/storage/store";
import { WorkspaceRegistry } from "../../apps/service/src/workspace/registry";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kb-onboard-"));
  const source = join(root, "source");
  const data = join(root, "data");
  await mkdir(source);
  await mkdir(data);
  await writeFile(join(source, "note.md"), "人工正文");
  const db = new Store(join(data, "state.db"));
  cleanup.push(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, data, db, registry: new WorkspaceRegistry(db, data) };
}
test("preview then create isolated pilot and verified backup without touching source", async () => {
  const f = await fixture();
  const preview = await f.registry.preview(f.source);
  expect(preview.conflicts).toEqual([]);
  const w = await f.registry.adopt(f.source, preview.digest);
  expect(await readFile(join(w.vaultPath, "note.md"), "utf8")).toBe("人工正文");
  expect(await readFile(join(w.backupPath, "note.md"), "utf8")).toBe(
    "人工正文",
  );
  expect(w.deviceId).toBeNull();
  expect(await readFile(join(f.source, "note.md"), "utf8")).toBe("人工正文");
  expect(() => f.registry.claimMaster(randomUUID(), 0)).not.toThrow();
  expect(() => f.registry.claimMaster(randomUUID(), 1)).toThrow(/MASTER/);
});
test("symlink, duplicate IDs, managed directory and changed preview block adoption", async () => {
  const f = await fixture();
  const preview = await f.registry.preview(f.source);
  await writeFile(join(f.source, "note.md"), "changed");
  await expect(f.registry.adopt(f.source, preview.digest)).rejects.toThrow(
    /BASELINE/,
  );
  await symlink("/etc", join(f.source, "escape"));
  expect((await f.registry.preview(f.source)).conflicts).toContain("SYMLINK");
  await expect(
    f.registry.adopt(f.source, (await f.registry.preview(f.source)).digest),
  ).rejects.toThrow(/CONFLICT/);
});
test("newer schema opens in diagnostic read-only mode", async () => {
  const f = await fixture();
  f.db.db.pragma("user_version = 900");
  const other = new Store(join(f.data, "state.db"));
  expect(other.readOnly).toBe(true);
  expect(() => other.writable()).toThrow(/SCHEMA/);
  other.close();
});

test("duplicate task IDs and managed directories are reported; empty directories and plugin config are backed up", async () => {
  const f = await fixture();
  await writeFile(
    join(f.source, "note.md"),
    "---\ntaskId: duplicate\n---\n正文",
  );
  await writeFile(
    join(f.source, "second.md"),
    "---\ntaskId: duplicate\n---\n正文",
  );
  expect((await f.registry.preview(f.source)).conflicts).toContain(
    "DUPLICATE_ID",
  );
  await rm(join(f.source, "second.md"));
  await mkdir(join(f.source, "KB-Wiki"));
  expect((await f.registry.preview(f.source)).conflicts).toContain(
    "MANAGED_DIRECTORY",
  );
  await rm(join(f.source, "KB-Wiki"), { recursive: true });
  await mkdir(join(f.source, "empty"));
  await mkdir(join(f.source, ".obsidian", "plugins", "fixture"), {
    recursive: true,
  });
  await writeFile(
    join(f.source, ".obsidian", "plugins", "fixture", "manifest.json"),
    JSON.stringify({ version: "1.2.3" }),
  );
  const scan = await f.registry.preview(f.source);
  expect(scan.plugins).toEqual([{ id: "fixture", version: "1.2.3" }]);
  const w = await f.registry.adopt(f.source, scan.digest);
  const { stat } = await import("node:fs/promises");
  expect((await stat(join(w.backupPath, "empty"))).isDirectory()).toBe(true);
  await expect(stat(join(w.vaultPath, ".obsidian"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    await readFile(
      join(w.backupPath, ".obsidian", "plugins", "fixture", "manifest.json"),
      "utf8",
    ),
  ).toContain("1.2.3");
});

test("a known version number with an unrecognized table structure is diagnostic-only", async () => {
  const f = await fixture();
  f.db.db.exec("CREATE TABLE unexpected_private_table (value TEXT)");
  const other = new Store(join(f.data, "state.db"));
  try {
    expect(other.readOnly).toBe(true);
    expect(() => other.writable()).toThrow("SCHEMA");
  } finally {
    other.close();
  }
});
