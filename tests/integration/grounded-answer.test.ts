import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Scope } from "@kb/contracts";
import { fixture } from "../helpers";
import { publish } from "../evidence-helpers";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
import { SearchService } from "../../apps/service/src/search/search";
import {
  AnswerService,
  type AnswerProvider,
} from "../../apps/service/src/answers/answer";
import { modelFixture } from "../model-helpers";
import { Policy } from "../../apps/service/src/security/policy";
const quoted: AnswerProvider = {
  model: "deterministic-fixture",
  generate: async (pack) => ({
    requestId: randomUUID(),
    cost: 60,
    value: {
      claims: pack.evidence.map((e) => ({
        id: randomUUID(),
        text: e.text,
        kind: "sourced",
        scope: e.profile.scope,
        evidenceIds: [e.id],
      })),
      relations: [],
      gaps: [],
    },
  }),
};
test("no-key evidence answer preserves negation and deduplicates five reprints; empty retrieval is insufficient", async () => {
  const f = await fixture();
  try {
    const e = new EvidenceStore(f.registry),
      s = new SearchService(e),
      a = new AnswerService(s);
    const p = publish(f, "权限不可默认开启。");
    const root = e.register(p)[0]!;
    for (let i = 0; i < 5; i++) {
      const copy = publish(f, p.text);
      e.setFamily(e.register(copy)[0]!.sourceId, root.sourceId);
    }
    const result = await s.search({ query: "权限" }, f.principal);
    const answer = await a.answer(
      { snapshotId: result.snapshot.id, operationId: randomUUID() },
      f.principal,
    );
    expect(answer.familyCount).toBe(1);
    expect(answer.claims[0]!.text).toContain("不可");
    expect(answer.mode).toBe("extractive");
    expect(a.candidate(answer.id, f.principal).state).toBe(
      "awaiting_scene04_review",
    );
    const empty = await s.search({ query: "量子随机xyzunknown" }, f.principal);
    expect(
      (
        await a.answer(
          { snapshotId: empty.snapshot.id, operationId: randomUUID() },
          f.principal,
        )
      ).status,
    ).toBe("insufficient");
  } finally {
    await f.close();
  }
});
test("trusted model path uses actual budget broker and cached answer does not charge twice", async () => {
  const { f, search } = await modelFixture();
  try {
    const a = new AnswerService(search, new Map([["test-model", quoted]]));
    const r = await search.search({ query: "权限" }, f.principal);
    const input = {
      snapshotId: r.snapshot.id,
      operationId: randomUUID(),
      routeId: "test-model",
    };
    const answer = await a.answer(input, f.principal);
    expect(answer.status).toBe("supported");
    expect((await a.answer(input, f.principal)).id).toBe(answer.id);
    expect(f.store.db.prepare("SELECT state,actual FROM calls").all()).toEqual([
      { state: "settled", actual: 60 },
    ]);
  } finally {
    await f.close();
  }
});
test("model structure errors and removal of a negation cannot pass as sourced facts", async () => {
  for (const malformed of [true, false]) {
    const { f, search } = await modelFixture();
    try {
      const provider: AnswerProvider = {
        model: "fixture",
        generate: async (pack) => ({
          requestId: randomUUID(),
          cost: 60,
          value: malformed
            ? { claims: "invalid" }
            : {
                claims: [
                  {
                    id: randomUUID(),
                    text: "权限允许默认开启。",
                    kind: "sourced",
                    scope: Scope.parse({}),
                    evidenceIds: [pack.evidence[0]!.id],
                  },
                ],
                relations: [],
                gaps: [],
              },
        }),
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
      expect(
        f.store.db.prepare("SELECT COUNT(*) n FROM answer_cache").get(),
      ).toEqual({ n: 0 });
    } finally {
      await f.close();
    }
  }
});
test("same-scope model disagreements are shown without selecting the newer source", async () => {
  const { f, e, search, ref } = await modelFixture();
  try {
    const p = publish(f, "在相同默认配置中权限允许开启。", "另一个依据");
    const second = e.register(p)[0]!;
    const full = Scope.parse({
      topic: "权限",
      version: "1",
      channel: "stable",
      stage: "runtime",
      configuration: "default",
      modality: "text",
      sourceType: "manual",
    });
    e.setProfile(ref.parseId, { scope: full });
    e.setProfile(p.id, { scope: full });
    const firstPolicy = f.store.get(`source:${ref.sourceId}`) as object;
    new Policy(f.registry).setSource({
      ...firstPolicy,
      sourceId: second.sourceId,
    });
    f.principal = f.sessions.refresh(f.token);
    const provider: AnswerProvider = {
      model: "conflict-fixture",
      generate: async (pack) => {
        const claims = pack.evidence.map((e) => ({
          id: randomUUID(),
          text: e.text,
          kind: "sourced",
          scope: e.profile.scope,
          evidenceIds: [e.id],
        }));
        return {
          requestId: randomUUID(),
          cost: 60,
          value: {
            claims,
            relations: [
              { from: claims[0]!.id, to: claims[1]!.id, type: "contradicts" },
            ],
            gaps: ["互斥关系仍需人工确认"],
          },
        };
      },
    };
    const r = await search.search({ query: "权限" }, f.principal);
    const answer = await new AnswerService(
      search,
      new Map([["test-model", provider]]),
    ).answer(
      {
        snapshotId: r.snapshot.id,
        operationId: randomUUID(),
        routeId: "test-model",
      },
      f.principal,
    );
    expect(answer.status).toBe("conflict");
    expect(answer.evidence).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("a derived page cannot smuggle later original evidence into a historical answer", async () => {
  const f = await fixture();
  try {
    const e = new EvidenceStore(f.registry),
      s = new SearchService(e),
      a = new AnswerService(s);
    const original = publish(f, "权限在未来版本开启。");
    const ref = e.register(original)[0]!;
    const summary = publish(f, "权限的派生摘要。");
    e.setProfile(original.id, {
      confirmedPublishedAt: "2022-01-01T00:00:00Z",
      publicationEvidence: "fixture publication record",
    });
    e.setProfile(summary.id, {
      kind: "summary",
      originalEvidence: [ref.id],
      confirmedPublishedAt: "2020-01-01T00:00:00Z",
      publicationEvidence: "fixture publication record",
    });
    const r = await s.search(
      { query: "权限", asOf: "2021-01-01T00:00:00Z" },
      f.principal,
    );
    expect(r.hits.map((h) => h.parseId)).toEqual([summary.id]);
    const answer = await a.answer(
      { snapshotId: r.snapshot.id, operationId: randomUUID() },
      f.principal,
    );
    expect(answer.status).toBe("insufficient");
    expect(answer.evidence).toHaveLength(0);
  } finally {
    await f.close();
  }
});
