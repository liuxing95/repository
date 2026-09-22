import { test, expect } from "vitest";
import { wikiFixture } from "../wiki-helpers";
import { observe } from "../../apps/service/src/wiki/observations";
import { impact, readPage } from "../../apps/service/src/wiki/impact";
test("manual observations preserve bytes, invalidate old approval and never replace committed revision", async () => {
  const f = await wikiFixture();
  try {
    await f.apply(f.prepare("candidate"));
    const c = await f.apply(f.prepare("wiki"));
    const page = c.patches[0]!;
    observe(
      f.proposals,
      { pageId: page.pageId, content: "人工 A\r\n😀" },
      f.principal,
    );
    const update = f.prepare("wiki");
    f.approvals.approve(update.id, update.digest, f.principal);
    observe(
      f.proposals,
      { pageId: page.pageId, content: "人工 B\r\n😀" },
      f.principal,
    );
    expect(() => f.writer.grant(update.id, 0, f.principal)).toThrow("BASELINE");
    expect(readPage(f.proposals, page.revisionId, f.principal).content).toBe(
      page.content,
    );
    expect(impact(f.proposals, f.principal).items[0]).toMatchObject({
      pageId: page.pageId,
      reasons: ["manual-change"],
    });
    expect(
      f.store.db.prepare("SELECT count(*) n FROM wiki_observations").get(),
    ).toEqual({ n: 2 });
    f.store.set(`source:${f.answer.evidence[0]!.sourceId}`, {
      retracted: true,
    });
    expect(impact(f.proposals, f.principal).items[0]).toMatchObject({
      reasons: ["source-unavailable"],
      evidenceIds: [],
    });
  } finally {
    await f.close();
  }
});

test("large impact lists stop at 100 pages and return an explicit continuation", async () => {
  const f = await wikiFixture();
  try {
    await f.apply(f.prepare("candidate"));
    for (let i = 0; i < 101; i++) {
      const c = f.prepare("wiki", `权限页 ${i}`);
      f.approvals.approve(c.id, c.digest, f.principal);
      const g = f.writer.grant(c.id, 0, f.principal);
      f.writer.receipt(g.token, g.patch.afterHash, f.principal);
      f.commit.finish(c.id, [g.patch.afterHash], f.principal);
    }
    const first = impact(f.proposals, f.principal);
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBe(100);
    const second = impact(f.proposals, f.principal, 100);
    expect(second.truncated).toBe(false);
    expect(second.nextOffset).toBeNull();
  } finally {
    await f.close();
  }
});

test("generated Wiki cannot be reingested; deletion is observed and offers a reviewed recreation", async () => {
  const { Ingestion } =
    await import("../../apps/service/src/ingestion/manifest");
  const { randomUUID } = await import("node:crypto");
  const { join } = await import("node:path");
  const f = await wikiFixture();
  try {
    await f.apply(f.prepare("candidate"));
    const c = await f.apply(f.prepare("wiki"));
    const page = c.patches[0]!;
    await expect(
      new Ingestion(f.registry, f.jobs).preview(
        { id: randomUUID(), kind: "text", entry: join(f.host.root, page.path) },
        f.principal,
      ),
    ).rejects.toThrow("FORBIDDEN");
    observe(f.proposals, { pageId: page.pageId, content: null }, f.principal);
    const recovery = f.prepare("wiki");
    expect(recovery.state).toBe("prepared");
    expect(recovery.patches[0]!.beforeHash).toBeNull();
    expect(readPage(f.proposals, page.revisionId, f.principal).review).toBe(
      "needs-review",
    );
  } finally {
    await f.close();
  }
});
