import { test, expect } from "vitest";
import { symlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "../helpers";
import { guardPath } from "../../apps/obsidian-plugin/src/writer/guard";
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
