import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { researchFixture } from "../research-helpers";
import { createServer } from "../../apps/service/src/http/server";
import { Connection } from "../../apps/obsidian-plugin/src/connection";
import { applyChange } from "../../apps/obsidian-plugin/src/writer/apply";
import type { WikiChangeSet } from "@kb/contracts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
test("report preview and repeated candidate save never write; real HTTP approval/Writer preserves complete report then promotes separately", async () => {
  const f = await researchFixture(),
    app = createServer(f.registry, f.sessions, f.jobs);
  try {
    const s = await f.activate();
    await f.chapters.generate(
      f.r.id,
      f.b.questions[0]!.id,
      { operationId: randomUUID(), snapshotId: s.id },
      f.principal,
    );
    const report = f.artifacts.freeze(f.r.id, f.principal);
    expect(f.artifacts.freeze(f.r.id, f.principal).id).toBe(report.id);
    const candidate = f.artifacts.candidate(report.id, f.principal);
    expect(f.artifacts.candidate(report.id, f.principal).id).toBe(candidate.id);
    expect(
      f.store.db.prepare("SELECT count(*) n FROM wiki_changes").get(),
    ).toEqual({ n: 0 });
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
    const change = await c.request<WikiChangeSet>("/v1/wiki/changes", "POST", {
      operationId: randomUUID(),
      candidateId: candidate.id,
      destination: "candidate",
      title: "权限研究报告",
    });
    expect(change.patches[0]!.content).toBe(report.content);
    await c.request(`/v1/wiki/changes/${change.id}/approve`, "POST", {
      digest: change.digest,
    });
    await applyChange(f.host, c, change, "/v1/wiki/changes");
    expect(
      await readFile(join(f.host.root, change.patches[0]!.path), "utf8"),
    ).toBe(report.content);
    expect(
      await c.request("/v1/wiki/search", "POST", { query: "权限" }),
    ).toEqual([]);
    const promote = await c.request<WikiChangeSet>("/v1/wiki/changes", "POST", {
      operationId: randomUUID(),
      candidateId: candidate.id,
      destination: "wiki",
      title: "权限研究结论",
    });
    expect(promote.state).toBe("prepared");
    expect(promote.id).not.toBe(change.id);
    f.db.cancel(f.r.id, f.principal);
    expect(f.artifacts.get(report.id, f.principal).id).toBe(report.id);
    f.store.set(`source:${report.evidence[0]!.sourceId}`, { retracted: true });
    for (const url of [
      `/v1/research/${f.r.id}`,
      `/v1/research-reports/${report.id}`,
      `/v1/wiki/changes/${change.id}`,
    ])
      await expect(c.request(url)).rejects.toMatchObject({ code: "FORBIDDEN" });
  } finally {
    await app.close();
    await f.close();
  }
});

test("report candidate cannot detach its full content from the frozen source manifest", async () => {
  const f = await researchFixture();
  try {
    await f.activate();
    const report = f.artifacts.freeze(f.r.id, f.principal),
      candidate = f.artifacts.candidate(report.id, f.principal);
    candidate.answer.evidence = [];
    f.store.db
      .prepare("UPDATE answer_candidates SET value=? WHERE id=?")
      .run(JSON.stringify(candidate), candidate.id);
    expect(() => f.proposals.candidates.get(candidate.id, f.principal)).toThrow(
      "HASH_MISMATCH",
    );
  } finally {
    await f.close();
  }
});
