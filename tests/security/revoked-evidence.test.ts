import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "../helpers";
import { publish } from "../evidence-helpers";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
import { SearchService } from "../../apps/service/src/search/search";
import {
  AnswerService,
  type AnswerProvider,
} from "../../apps/service/src/answers/answer";
import { Policy } from "../../apps/service/src/security/policy";
import { createServer } from "../../apps/service/src/http/server";
import { modelFixture } from "../model-helpers";
test("revocation blocks old snapshot, evidence ID, cached answer and candidate saving over HTTP", async () => {
  const f = await fixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
  try {
    publish(f, "权限私密说明");
    const e = new EvidenceStore(f.registry),
      s = new SearchService(e),
      a = new AnswerService(s);
    const r = await s.search({ query: "权限" }, f.principal);
    const answer = await a.answer(
      { snapshotId: r.snapshot.id, operationId: randomUUID() },
      f.principal,
    );
    const hit = r.hits[0]!;
    f.store.set(`source:${hit.sourceId}`, { retracted: true });
    const headers = {
      host: "127.0.0.1:27124",
      authorization: `Bearer ${f.token}`,
      "x-policy-version": String(f.registry.get().policyVersion),
    };
    for (const [method, url, payload] of [
      ["GET", `/v1/evidence/${hit.id}`, undefined],
      ["GET", `/v1/answers/${answer.id}`, undefined],
      ["POST", `/v1/answers/${answer.id}/candidate`, {}],
      ["POST", "/v1/search", { query: "权限", snapshotId: r.snapshot.id }],
    ] as const) {
      const res = await app.inject({ method, url, headers, payload });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain("权限私密");
    }
    expect((await s.search({ query: "权限" }, f.principal)).hits).toHaveLength(
      0,
    );
  } finally {
    await app.close();
    await f.close();
  }
});
test("another session cannot read a cached answer even with the answer or snapshot UUID", async () => {
  const f = await fixture();
  try {
    publish(f, "权限");
    const s = new SearchService(new EvidenceStore(f.registry)),
      a = new AnswerService(s);
    const r = await s.search({ query: "权限" }, f.principal);
    const answer = await a.answer(
      { snapshotId: r.snapshot.id, operationId: randomUUID() },
      f.principal,
    );
    const other = await f.sessions.pair({
      code: f.sessions.issuePairing("reader"),
      deviceId: randomUUID(),
      vaultPath: f.registry.get().vaultPath,
    });
    expect(() => a.byId(answer.id, other.principal)).toThrow("FORBIDDEN");
  } finally {
    await f.close();
  }
});
test("revocation during generation aborts the provider; no stale body or candidate is returned", async () => {
  const { f, search, ref } = await modelFixture();
  try {
    let aborted = false;
    const provider: AnswerProvider = {
      model: "pending-fixture",
      generate: async (_pack, { signal }) => {
        new Policy(f.registry).setSource({
          sourceId: ref.sourceId,
          retracted: true,
          routes: {
            read: [],
            fetch: [],
            model: [],
            ocr: [],
            embedding: [],
            rerank: [],
            notification: [],
            calendar: [],
            publish: [],
          },
        });
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          ),
        );
      },
    };
    const r = await search.search({ query: "权限" }, f.principal);
    await expect(
      new AnswerService(search, new Map([["test-model", provider]])).answer(
        {
          snapshotId: r.snapshot.id,
          operationId: randomUUID(),
          routeId: "test-model",
        },
        f.principal,
      ),
    ).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(
      f.store.db.prepare("SELECT COUNT(*) n FROM answer_cache").get(),
    ).toEqual({ n: 0 });
    expect(f.store.db.prepare("SELECT state FROM calls").get()).toEqual({
      state: "unknown",
    });
  } finally {
    await f.close();
  }
});

test("explicit local-read denial also protects original and parse endpoints", async () => {
  const f = await fixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
  try {
    const parsed = publish(f, "只允许特定用途的资料");
    const e = new EvidenceStore(f.registry);
    const ref = e.register(parsed)[0]!;
    new Policy(f.registry).setSource({
      sourceId: ref.sourceId,
      retracted: false,
      routes: {
        read: [],
        fetch: [],
        model: ["test-model"],
        ocr: [],
        embedding: [],
        rerank: [],
        notification: [],
        calendar: [],
        publish: [],
      },
    });
    for (const url of [
      `/v1/parses/${parsed.id}`,
      `/v1/originals/${parsed.revisionId}`,
    ]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: {
          host: "127.0.0.1:27124",
          authorization: `Bearer ${f.token}`,
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain("特定用途");
    }
  } finally {
    await app.close();
    await f.close();
  }
});
