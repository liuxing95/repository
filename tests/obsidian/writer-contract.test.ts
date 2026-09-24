import { test, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { wikiFixture } from "../wiki-helpers";
import { applyGrant } from "../../apps/obsidian-plugin/src/writer/apply";
import { observe } from "../../apps/service/src/wiki/observations";
test("updates compare inside synchronous process and never replace editor buffers or third hashes", async () => {
  const f = await wikiFixture();
  try {
    await f.apply(f.prepare("candidate"));
    const first = await f.apply(f.prepare("wiki"));
    const patch = first.patches[0]!;
    const manual = "人工内容：不可覆盖，需审核差异。";
    await writeFile(join(f.host.root, patch.path), manual);
    observe(
      f.proposals,
      { pageId: patch.pageId, content: manual },
      f.principal,
    );
    const update = f.prepare("wiki");
    f.approvals.approve(update.id, update.digest, f.principal);
    const grant = f.writer.grant(update.id, 0, f.principal);
    f.setEditing(true);
    await expect(applyGrant(f.host, f.connection, grant)).rejects.toThrow(
      "WRITER_EDITING",
    );
    f.setEditing(false);
    const originalProcess = f.host.process!;
    f.host.process = async (path, fn) => {
      await writeFile(join(f.host.root, path), "新的人工第三版本");
      await originalProcess(path, fn);
    };
    await expect(applyGrant(f.host, f.connection, grant)).rejects.toThrow(
      "WRITER_CONFLICT",
    );
    expect(await readFile(join(f.host.root, patch.path), "utf8")).toBe(
      "新的人工第三版本",
    );
    await writeFile(join(f.host.root, patch.path), manual);
    f.host.process = originalProcess;
    expect(await applyGrant(f.host, f.connection, grant)).toBe(
      grant.patch.afterHash,
    );
  } finally {
    await f.close();
  }
});
test("new-file collisions, session mismatch and unload invalidate a grant before write", async () => {
  const f = await wikiFixture();
  try {
    const c = f.prepare("candidate");
    f.approvals.approve(c.id, c.digest, f.principal);
    const g = f.writer.grant(c.id, 0, f.principal);
    await writeFile(join(f.host.root, g.patch.path), "existing note");
    await expect(applyGrant(f.host, f.connection, g)).rejects.toThrow(
      "WRITER_CONFLICT",
    );
    await expect(
      applyGrant(f.host, f.connection, { ...g, sessionId: "other" }),
    ).rejects.toThrow("WRITER_EXPIRED");
    f.connection.principal = undefined;
    await expect(applyGrant(f.host, f.connection, g)).rejects.toThrow(
      "WRITER_EXPIRED",
    );
  } finally {
    await f.close();
  }
});
