import { test, expect } from "vitest";
import { brief, researchFixture } from "../research-helpers";
import { draftBrief } from "../../apps/service/src/research/brief";
import { publish } from "../evidence-helpers";
import { coverage, assess } from "../../apps/service/src/research/coverage";
import { Scope } from "@kb/contracts";
import { randomUUID } from "node:crypto";
test("draft surfaces missing fields, project basis is mandatory, overview may span explicitly separate scopes", () => {
  expect(draftBrief({ topic: "权限" }).ready).toBe(false);
  expect(() => brief({ outputType: "project" })).toThrow();
  const b = brief({
    scopes: [
      { version: "7", channel: "standard" },
      { version: "7", channel: "preview" },
    ],
    timeIntent: "evolution",
  });
  expect(b.scopes).toHaveLength(2);
  expect(draftBrief(b).ready).toBe(true);
  expect(() => brief({ timeIntent: "historical" })).toThrow();
});
test("historical cutoff classifies original, later guide and undated source; hit count never declares support", async () => {
  const f = await researchFixture({
    timeIntent: "historical",
    cutoff: "2025-01-01T00:00:00Z",
  });
  try {
    f.evidence.setProfile(f.artifact.id, {
      scope: { sourceType: "text" },
      confirmedPublishedAt: "2024-01-01T00:00:00Z",
      publicationEvidence: "合成资料发布日期标注",
    });
    const late = publish(f, "权限后来增加了新规则。", "权限后发说明"),
      unknown = publish(f, "权限现在可能可用。", "权限无日期说明");
    f.evidence.setProfile(late.id, {
      scope: { sourceType: "text" },
      confirmedPublishedAt: "2026-01-01T00:00:00Z",
      publicationEvidence: "合成资料后发日期",
    });
    const s = await f.activate(),
      q = f.b.questions[0]!,
      c = coverage(f.db, f.b, s, q);
    expect(new Set(c.evidence.map((e) => e.role))).toEqual(
      new Set(["eligible", "later-explanation", "publication-unknown"]),
    );
    expect(c.state).toBe("partial");
    const eligible = c.evidence.find((e) => e.role === "eligible")!.id,
      lateId = c.evidence.find((e) => e.role === "later-explanation")!.id;
    expect(() =>
      assess(
        f.db,
        f.b,
        s,
        q,
        {
          state: "supported",
          supportingIds: [lateId],
          opposingIds: [],
          counterChecked: true,
          note: "后发指南",
        },
        f.principal,
      ),
    ).toThrow("INVALID_CITATION");
    const good = assess(
      f.db,
      f.b,
      s,
      q,
      {
        state: "supported",
        supportingIds: [eligible],
        opposingIds: [],
        counterChecked: true,
        note: "核对当时原文及反证，限于所引规则",
      },
      f.principal,
    );
    expect(good.state).toBe("supported");
    const chapter = await f.chapters.generate(
      f.r.id,
      q.id,
      { operationId: randomUUID(), snapshotId: s.id },
      f.principal,
    );
    expect(chapter.claims.map((c) => c.text)).toEqual([
      "权限默认关闭。未经批准不能自动写入。",
    ]);
    expect(s.evidence.some((e) => e.parseId === unknown.id)).toBe(true);
  } finally {
    await f.close();
  }
});
test("distribution and phase boundaries are filtered, unknown conditions cannot be marked sufficient", async () => {
  const q = {
    id: randomUUID(),
    question: "权限",
    query: "权限",
    counterQuery: "权限",
    scope: Scope.parse({
      version: "7",
      channel: "standard",
      stage: "production",
    }),
    requiredTypes: ["text"],
  };
  const f = await researchFixture({ questions: [q] });
  try {
    f.evidence.setProfile(f.artifact.id, {
      scope: {
        version: "7",
        channel: "preview",
        stage: "production",
        sourceType: "text",
      },
    });
    publish(f, "权限未知范围不能确认。", "权限缺少条件");
    const s = await f.activate();
    expect(s.evidence.every((e) => e.parseId !== f.artifact.id)).toBe(true);
    expect(() =>
      assess(
        f.db,
        f.b,
        s,
        q,
        {
          state: "supported",
          supportingIds: [s.evidence[0]!.id],
          opposingIds: [],
          counterChecked: true,
          note: "未核范围",
        },
        f.principal,
      ),
    ).toThrow("INSUFFICIENT_EVIDENCE");
  } finally {
    await f.close();
  }
});

test("brief-wide version is also required before a broad question can be marked supported", async () => {
  const f = await researchFixture({ scopes: [{ version: "7" }] });
  try {
    const s = await f.activate(),
      q = f.b.questions[0]!;
    expect(() =>
      assess(
        f.db,
        f.b,
        s,
        q,
        {
          state: "supported",
          supportingIds: [s.evidence[0]!.id],
          opposingIds: [],
          counterChecked: true,
          note: "缺少版本仍不能确认",
        },
        f.principal,
      ),
    ).toThrow("INSUFFICIENT_EVIDENCE");
  } finally {
    await f.close();
  }
});
