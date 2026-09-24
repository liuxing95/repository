import { test, expect } from "vitest";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fixture } from "../helpers";
import { publish } from "../evidence-helpers";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
import { SearchService } from "../../apps/service/src/search/search";
import { AnswerService } from "../../apps/service/src/answers/answer";
import { hashBytes } from "../../apps/service/src/ingestion/objects";
import {
  assessEnhancement,
  enhancementStatus,
} from "../../apps/service/src/search/enhancement";
test("20 fixed project questions report family Recall@10 and abstention without model self-scoring", async () => {
  const f = await fixture();
  try {
    const records = JSON.parse(
      await readFile("tests/fixtures/search/provenance.json", "utf8"),
    ) as { id: string; path: string; sha256: string }[];
    const e = new EvidenceStore(f.registry),
      s = new SearchService(e),
      a = new AnswerService(s);
    const families = new Map<string, string>();
    for (const record of records) {
      const text = await readFile(
        `tests/fixtures/search/${record.id}.txt`,
        "utf8",
      );
      expect(hashBytes(text)).toBe(record.sha256);
      const lines = text.split("\n");
      const blocks: string[] = [];
      for (let i = 0; i < lines.length; i += 30)
        blocks.push(lines.slice(i, i + 30).join("\n"));
      const p = publish(f, text, record.path, {}, blocks);
      families.set(e.register(p)[0]!.sourceId, record.id);
    }
    const questions = JSON.parse(
      await readFile("tests/fixtures/search/questions.json", "utf8"),
    ) as {
      id: string;
      question: string;
      expectedFamilies: string[];
      answerable: boolean;
    }[];
    const rows = [];
    for (const q of questions) {
      const start = performance.now();
      const r = await s.search({ query: q.question }, f.principal);
      const actual = r.hits.map((h) => families.get(h.familyId));
      const answer = await a.answer(
        { snapshotId: r.snapshot.id, operationId: randomUUID() },
        f.principal,
      );
      rows.push({
        ...q,
        actual,
        recall:
          q.expectedFamilies.filter((g) => actual.includes(g)).length /
          (q.expectedFamilies.length || 1),
        status: answer.status,
        latencyMs: performance.now() - start,
      });
    }
    const answerable = rows.filter((r) => r.answerable);
    const negatives = rows.filter((r) => !r.answerable);
    const recall =
      answerable.reduce((n, r) => n + r.recall, 0) / answerable.length;
    const report = {
      dataset:
        "7 immutable real project documents/code files, 20 project onboarding questions",
      questions: 20,
      answerable: 17,
      unanswerable: 3,
      familyRecallAt10: recall,
      correctInsufficient: negatives.filter((r) => r.status === "insufficient")
        .length,
      overRefusal: answerable.filter((r) => r.status === "insufficient").length,
      semanticHumanReview: "not-performed",
      modelCalls: 0,
      enhancement: enhancementStatus(),
      rows,
    };
    await mkdir(".context/runtime-validation", { recursive: true });
    await writeFile(
      ".context/runtime-validation/search-evaluation.json",
      JSON.stringify(report, null, 2),
    );
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(report.correctInsufficient).toBe(3);
  } finally {
    await f.close();
  }
});
test("one enhancement candidate must show same-question gain and authorized egress; never auto-enables", () => {
  const report = {
    questions: 20,
    baselineRecall: 0.9,
    enhancedRecall: 0.95,
    p95Ms: 100,
    costMicroUSD: 10,
    externalBytes: 100,
    fingerprint: {
      model: "fixture",
      dimensions: 8,
      chunking: "v1",
      normalization: "v1",
    },
  };
  expect(assessEnhancement(report, false).eligible).toBe(false);
  expect(assessEnhancement(report, true)).toEqual({
    eligible: true,
    enabled: false,
  });
  expect(
    assessEnhancement({ ...report, enhancedRecall: 0.8 }, true).eligible,
  ).toBe(false);
  expect(enhancementStatus().mode).toBe("keyword");
  expect(
    assessEnhancement(
      { ...report, fingerprint: { ...report.fingerprint, model: "" } },
      true,
    ).eligible,
  ).toBe(false);
});
