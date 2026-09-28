import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { wikiFixture } from "../wiki-helpers";
import { WritingDrafts } from "../../apps/service/src/review/drafts";
import { createServer } from "../../apps/service/src/http/server";
import { Connection } from "../../apps/obsidian-plugin/src/connection";
import { applyChange } from "../../apps/obsidian-plugin/src/writer/apply";
import type { WritingDraft, WikiChangeSet } from "@kb/contracts";

test("HTTP draft edits persist, freeze idempotently and preserve readable prose through the real candidate and Wiki writer", async () => {
  const f = await wikiFixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
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
  try {
    await c.pair(f.sessions.issuePairing());
    const d = await c.request<WritingDraft>(
      `/v1/answers/${f.answer.id}/draft`,
      "POST",
      { title: "权限简介" },
    );
    const input = {
      title: d.title,
      revision: d.revision,
      paragraphs: [
        {
          text: "开发者应先核对权限，再启用功能。",
          evidenceIds: [d.answer.evidence[0]!.id],
        },
      ],
    };
    const saved = await c.request<WritingDraft>(
      `/v1/drafts/${d.id}`,
      "PUT",
      input,
    );
    expect(saved.revision).toBe(2);
    expect(await c.request(`/v1/drafts/${d.id}`, "PUT", input)).toEqual(saved);
    expect(
      new WritingDrafts(f.answers).get(d.id, c.principal!).paragraphs,
    ).toEqual(input.paragraphs);
    const frozen = await c.request<{ id: string }>(
      `/v1/drafts/${d.id}/candidate`,
      "POST",
      { revision: 2 },
    );
    expect(
      await c.request(`/v1/drafts/${d.id}/candidate`, "POST", { revision: 2 }),
    ).toEqual(frozen);
    let content = "";
    for (const destination of ["candidate", "wiki"]) {
      const change = await c.request<WikiChangeSet>(
        "/v1/wiki/changes",
        "POST",
        {
          candidateId: frozen.id,
          destination,
          operationId: randomUUID(),
          title: d.title,
        },
      );
      expect(change.patches[0]!.content).toContain(
        "开发者应先核对权限，再启用功能。[^1]",
      );
      expect(change.patches[0]!.content).toContain(d.answer.evidence[0]!.id);
      expect(change.patches[0]!.claims[0]!.kind).toBe("user-stated");
      if (content) expect(change.patches[0]!.content).toBe(content);
      content = change.patches[0]!.content;
      await c.request(`/v1/wiki/changes/${change.id}/approve`, "POST", {
        digest: change.digest,
      });
      await applyChange(f.host, c, change, "/v1/wiki/changes");
      expect(await f.host.read(change.patches[0]!.path)).toBe(content);
    }
  } finally {
    await app.close();
    await f.close();
  }
});

test("stale edits and invented citations fail; editing invalidates an already approved writer grant", async () => {
  const f = await wikiFixture();
  try {
    const drafts = new WritingDrafts(f.answers);
    const d = drafts.create(f.answer.id, { title: "简介" }, f.principal);
    const candidate = drafts.freeze(d.id, d.revision, f.principal);
    expect(() => f.proposals.prepare({ operationId: randomUUID(), candidateId: candidate.id, destination: "candidate", title: "与草稿不一致的标题" }, f.principal)).toThrow("VALIDATION");
    const change = f.proposals.prepare(
      {
        operationId: randomUUID(),
        candidateId: candidate.id,
        destination: "candidate",
        title: d.title,
      },
      f.principal,
    );
    f.approvals.approve(change.id, change.digest, f.principal);
    const grant = f.writer.grant(change.id, 0, f.principal);
    const edit = {
      title: "人工标题",
      revision: d.revision,
      paragraphs: d.paragraphs,
    };
    drafts.save(d.id, edit, f.principal);
    expect(() => f.writer.validate(grant.token, f.principal)).toThrow(
      "BASELINE",
    );
    expect(() =>
      drafts.save(d.id, { ...edit, title: "另一台设备的旧编辑" }, f.principal),
    ).toThrow("BASELINE");
    expect(() => drafts.freeze(d.id, 1, f.principal)).toThrow("BASELINE");
    expect(() =>
      drafts.save(
        d.id,
        {
          ...edit,
          revision: 2,
          paragraphs: [{ text: "伪造", evidenceIds: ["f".repeat(64)] }],
        },
        f.principal,
      ),
    ).toThrow("INVALID_CITATION");
    f.store.set(`source:${d.answer.evidence[0]!.sourceId}`, {
      retracted: true,
    });
    expect(() => drafts.get(d.id, f.principal)).toThrow();
    expect(drafts.list(f.principal)).toEqual([]);
  } finally {
    await f.close();
  }
});
