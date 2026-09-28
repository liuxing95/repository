import { expect, test } from "vitest";
import { fixture } from "../helpers";
import { publish } from "../evidence-helpers";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
import { SearchService } from "../../apps/service/src/search/search";
import { AnswerService } from "../../apps/service/src/answers/answer";
import { randomUUID } from "node:crypto";

test("one document can return evidence from distant sections", async () => {
  const f = await fixture();
  try {
    const blocks = Array.from({ length: 80 }, (_, i) =>
      i === 3
        ? "星河代理的认证令牌只保存在本机凭据库。"
        : i === 75
          ? "星河代理的撤销记录必须保留审计时间。"
          : `第 ${i} 节介绍普通操作。${"背景材料用于填充章节长度。".repeat(10)}`,
    );
    const parsed = publish(f, blocks.join("\n"), "星河代理开发指南", {}, blocks);
    const search = new SearchService(new EvidenceStore(f.registry));
    const result = await search.search(
      { query: "认证令牌 撤销记录", limit: 10 },
      f.principal,
    );
    expect(result.hits.filter((hit) => hit.parseId === parsed.id).length).toBeGreaterThanOrEqual(2);
    expect(result.hits.some((hit) => hit.text.includes(blocks[3]!))).toBe(true);
    expect(result.hits.some((hit) => hit.text.includes(blocks[75]!))).toBe(true);
    expect(new Set(result.snapshot.evidenceIds).size).toBe(result.hits.length);
    const answer = await new AnswerService(search).answer(
      { snapshotId: result.snapshot.id, operationId: randomUUID() },
      f.principal,
    );
    expect(answer.evidence.some((item) => item.text.includes(blocks[3]!))).toBe(true);
    expect(answer.evidence.some((item) => item.text.includes(blocks[75]!))).toBe(true);
  } finally {
    await f.close();
  }
});
