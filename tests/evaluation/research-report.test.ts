import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { researchFixture } from "../research-helpers";
import {
  chapterPack,
  checkChapter,
} from "../../apps/service/src/research/chapters";
test("report checks reject lost negation, invented speedups, changed scope and unknown citations", async () => {
  const f = await researchFixture();
  try {
    const s = await f.activate(),
      q = f.b.questions[0]!,
      pack = chapterPack(f.b, s, q),
      e = pack.evidence[0]!;
    const claim = {
      id: randomUUID(),
      text: e.text,
      kind: "sourced",
      scope: e.profile.scope,
      evidenceIds: [e.id],
    };
    expect(
      checkChapter({ claims: [claim], unresolved: [] }, pack).claims,
    ).toHaveLength(1);
    for (const altered of [
      { ...claim, text: "权限默认开启。" },
      { ...claim, text: "运行实验确认快 100 倍。" },
      { ...claim, scope: { ...claim.scope, version: "99" } },
      { ...claim, kind: "user-stated" },
    ])
      expect(() =>
        checkChapter({ claims: [altered], unresolved: [] }, pack),
      ).toThrow("UNSUPPORTED_CLAIM");
    expect(() =>
      checkChapter(
        {
          claims: [{ ...claim, evidenceIds: ["0".repeat(64)] }],
          unresolved: [],
        },
        pack,
      ),
    ).toThrow("INVALID_CITATION");
    const report = f.artifacts.freeze(f.r.id, f.principal);
    expect(report.checks.semantic).toBe("not-reviewed");
    expect(report.checks.warnings.join()).toContain("未完成章节");
  } finally {
    await f.close();
  }
});
