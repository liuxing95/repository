import { test, expect } from "vitest";
import { wikiFixture } from "../wiki-helpers";
import { applyGrant } from "../../apps/obsidian-plugin/src/writer/apply";
import { readPage, searchPages } from "../../apps/service/src/wiki/impact";
import { randomUUID } from "node:crypto";
import { proposalDigest } from "../../apps/service/src/review/proposals";
import { Store } from "../../apps/service/src/storage/store";
import { WorkspaceRegistry } from "../../apps/service/src/workspace/registry";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
import { Proposals } from "../../apps/service/src/review/proposals";
import { WikiCommit } from "../../apps/service/src/review/commit";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
test("every file boundary recovers lost receipts; final transaction never publishes partial pages", async () => {
  const f = await wikiFixture();
  try {
    await f.apply(f.prepare("candidate"));
    const c = f.prepare("wiki");
    // Exercise the shared commit protocol with two pages; the current native compiler emits at most one.
    const secondId = randomUUID();
    c.patches.push({
      ...c.patches[0]!,
      sequence: 1,
      pageId: secondId,
      revisionId: randomUUID(),
      path: `KB-Wiki/${secondId}.md`,
      title: "权限系统",
    });
    c.digest = proposalDigest(c);
    f.proposals.save(c);
    f.approvals.approve(c.id, c.digest, f.principal);
    for (const patch of c.patches) {
      const g = f.writer.grant(c.id, patch.sequence, f.principal);
      expect(searchPages(f.proposals, "权限", f.principal)).toHaveLength(0);
      await applyGrant(f.host, f.connection, g); // crash after write, before receipt
      const recovered = f.writer.grant(c.id, patch.sequence, f.principal);
      f.writer.receipt(
        recovered.token,
        await applyGrant(f.host, f.connection, recovered),
        f.principal,
      );
      expect(searchPages(f.proposals, "权限", f.principal)).toHaveLength(0);
    }
    f.store.close();
    const reopenedStore = new Store(join(f.data, "state.db"));
    const reopened = new Proposals(
      new EvidenceStore(new WorkspaceRegistry(reopenedStore, f.data)),
    ); // actual database close/reopen

    expect(reopened.read(c.id, f.principal).receipts).toEqual([0, 1]);
    const finished = new WikiCommit(reopened).finish(
      c.id,
      c.patches.map((p) => p.afterHash),
      f.principal,
    );
    expect(finished.state).toBe("committed");
    expect(searchPages(reopened, "权限", f.principal)).toHaveLength(2);
    expect(
      readPage(reopened, c.patches[0]!.revisionId, f.principal).content,
    ).toBe(c.patches[0]!.content);
    new WikiCommit(reopened).finish(
      c.id,
      c.patches.map((p) => p.afterHash),
      f.principal,
    );
    expect(
      reopenedStore.db.prepare("SELECT count(*) n FROM wiki_revisions").get(),
    ).toEqual({ n: 2 });
    reopenedStore.close();
  } finally {
    await f.close();
  }
});
test("expiry pauses remaining work; third version remains untouched; receipt alone cannot finish", async () => {
  const f = await wikiFixture();
  try {
    const c = f.prepare("candidate");
    f.approvals.approve(c.id, c.digest, f.principal);
    const g = f.writer.grant(c.id, 0, f.principal);
    await applyGrant(f.host, f.connection, g);
    f.advance(600001);
    expect(() =>
      f.writer.receipt(g.token, g.patch.afterHash, f.principal),
    ).toThrow("APPROVAL_EXPIRED");
    f.approvals.approve(c.id, c.digest, f.principal);
    const renewed = f.writer.grant(c.id, 0, f.principal);
    // Wall clock is real at the bridge, service clock advanced only for the expiration fixture.
    f.writer.receipt(
      renewed.token,
      await applyGrant(f.host, f.connection, renewed),
      f.principal,
    );
    expect(() => f.commit.finish(c.id, ["0".repeat(64)], f.principal)).toThrow(
      "INCOMPLETE",
    );
    await writeFile(join(f.host.root, g.patch.path), "人工第三版本");
    await expect(applyGrant(f.host, f.connection, renewed)).rejects.toThrow(
      "WRITER_CONFLICT",
    );
    expect(await readFile(join(f.host.root, g.patch.path), "utf8")).toBe(
      "人工第三版本",
    );
    expect(f.proposals.raw(c.id).state).toBe("approved");
  } finally {
    await f.close();
  }
});
