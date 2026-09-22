import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { wikiFixture } from "../wiki-helpers";
import { createServer } from "../../apps/service/src/http/server";
import { Connection } from "../../apps/obsidian-plugin/src/connection";
import { applyChange } from "../../apps/obsidian-plugin/src/writer/apply";
import type { WikiChangeSet } from "@kb/contracts";
import { observe } from "../../apps/service/src/wiki/observations";
import { searchPages } from "../../apps/service/src/wiki/impact";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
test("real HTTP and bridge save candidate then promote; matching page updates, unchanged input emits zero changes", async () => {
  const f = await wikiFixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
  try {
    const c = new Connection(
      async (url, options) => {
        const r = await app.inject({
          method: options.method as "POST",
          url: new URL(url).pathname,
          headers: { ...options.headers, host: "127.0.0.1:27124" },
          payload: options.body,
        });
        return { status: r.statusCode, json: r.json() };
      },
      f.host.root,
      f.deviceId,
    );
    await c.pair(f.sessions.issuePairing());
    const input = {
      operationId: randomUUID(),
      candidateId: f.answer.id,
      title: "权限概念",
      destination: "wiki",
    };
    await expect(
      c.request("/v1/wiki/changes", "POST", input),
    ).rejects.toMatchObject({ code: "CANDIDATE_NOT_SAVED" });
    for (const destination of ["candidate", "wiki"]) {
      const change = await c.request<WikiChangeSet>(
        "/v1/wiki/changes",
        "POST",
        { ...input, operationId: randomUUID(), destination },
      );
      await c.request(`/v1/wiki/changes/${change.id}/approve`, "POST", {
        digest: change.digest,
      });
      await applyChange(f.host, c, change, "/v1/wiki/changes");
    }
    expect(
      await c.request("/v1/wiki/search", "POST", { query: "权限" }),
    ).toHaveLength(1);
    expect(f.prepare("wiki").state).toBe("no_change");
    const page = searchPages(f.proposals, "权限", f.principal)[0]!;
    await writeFile(join(f.host.root, page.path), "人工说明需重新审核");
    observe(
      f.proposals,
      { pageId: page.pageId, content: "人工说明需重新审核" },
      f.principal,
    );
    const update = f.prepare("wiki");
    expect(update.patches[0]!.pageId).toBe(page.pageId);
    expect(update.patches[0]!.beforeContent).toBe("人工说明需重新审核");
    await f.apply(update);
    expect(
      f.store.db.prepare("SELECT count(*) n FROM wiki_pages").get(),
    ).toEqual({ n: 1 });
    expect(
      f.store.db.prepare("SELECT count(*) n FROM wiki_revisions").get(),
    ).toEqual({ n: 2 });
  } finally {
    await app.close();
    await f.close();
  }
});
test("source withdrawal hides candidates, before/after review and committed page bodies including known IDs", async () => {
  const f = await wikiFixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
  try {
    await f.apply(f.prepare("candidate"));
    const c = await f.apply(f.prepare("wiki"));
    f.store.set(`source:${f.answer.evidence[0]!.sourceId}`, {
      retracted: true,
    });
    for (const url of [
      `/v1/wiki/changes/${c.id}`,
      `/v1/wiki/pages/${c.patches[0]!.revisionId}`,
    ]) {
      const r = await app.inject({
        url,
        headers: {
          host: "127.0.0.1:27124",
          authorization: `Bearer ${f.token}`,
        },
      });
      expect(r.statusCode).toBe(403);
      expect(r.body).not.toContain("权限默认关闭");
    }
    expect(searchPages(f.proposals, "权限", f.principal)).toEqual([]);
    expect(f.proposals.candidates.list(f.principal)).toEqual([]);
  } finally {
    await app.close();
    await f.close();
  }
});

test("reversal creates a separately approved candidate against current bytes and retains all history", async () => {
  const { reverse } = await import("../../apps/service/src/review/reverse");
  const f = await wikiFixture();
  try {
    await f.apply(f.prepare("candidate"));
    const initial = await f.apply(f.prepare("wiki"));
    expect(() =>
      reverse(f.proposals, initial.id, randomUUID(), f.principal),
    ).toThrow("REVERSE_UNAVAILABLE");
    const page = initial.patches[0]!;
    await writeFile(join(f.host.root, page.path), "人工原始内容\r\n😀");
    observe(
      f.proposals,
      { pageId: page.pageId, content: "人工原始内容\r\n😀" },
      f.principal,
    );
    const updated = await f.apply(f.prepare("wiki"));
    const reversal = reverse(
      f.proposals,
      updated.id,
      randomUUID(),
      f.principal,
    );
    expect(() => f.writer.grant(reversal.id, 0, f.principal)).toThrow(
      "APPROVAL_EXPIRED",
    );
    await f.apply(reversal);
    expect(await f.host.read(page.path)).toBe("人工原始内容\r\n😀");
    expect(
      f.store.db.prepare("SELECT count(*) n FROM wiki_revisions").get(),
    ).toEqual({ n: 3 });
  } finally {
    await f.close();
  }
});
