import { test, expect } from "vitest";
import { symlink, rm, link, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "../helpers";
import {
  guardPath,
  guardPathSync,
} from "../../apps/obsidian-plugin/src/writer/guard";
test("Writer refuses traversal, symlink folders, symlink files and hardlinks", async () => {
  const f = await fixture();
  try {
    const root = f.registry.get().vaultPath;
    const file = `KB-Wiki/${randomUUID()}.md`;
    for (const path of [
      "../note.md",
      "KB-Wiki/../note.md",
      "note.md",
      "KB-Plans/a.md",
      "KB-Wiki/name.md",
    ]) {
      await expect(guardPath(root, path)).rejects.toThrow("WRITER_PATH");
      expect(() => guardPathSync(root, path)).toThrow("WRITER_PATH");
    }
    await symlink(join(f.source, "note.md"), join(root, file));
    await expect(guardPath(root, file)).rejects.toThrow("WRITER_PATH");
    await rm(join(root, file));
    await writeFile(join(root, file), "safe");
    await link(join(root, file), join(f.root, "hardlink"));
    await expect(guardPath(root, file)).rejects.toThrow("WRITER_PATH");
    await rm(join(root, file));
    await rm(join(root, "KB-Wiki"), { recursive: true });
    await symlink(f.source, join(root, "KB-Wiki"));
    await expect(guardPath(root, file)).rejects.toThrow("WRITER_PATH");
  } finally {
    await f.close();
  }
});

test("source Writer rejects traversal and symlinked managed roots", async () => {
  const f = await fixture();
  try {
    const root = f.registry.get().vaultPath;
    await expect(guardPath(root, "KB-Sources/../note.md")).rejects.toThrow(
      "WRITER_PATH",
    );
    const name = `KB-Sources/${randomUUID()}.md`;
    await expect(guardPath(root, name)).resolves.toBeUndefined();
    await rename(join(root, "KB-Sources"), join(root, "saved-source-root"));
    await symlink(f.source, join(root, "KB-Sources"));
    await expect(guardPath(root, name)).rejects.toThrow("WRITER_PATH");
  } finally {
    await f.close();
  }
});
