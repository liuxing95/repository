import { test, expect } from "vitest";
import { cpus, totalmem } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { fixture } from "../helpers";
import { publish } from "../evidence-helpers";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
import { SearchService } from "../../apps/service/src/search/search";
test("10,000 indexed blocks have hot keyword p95 below 500ms", async () => {
  const f = await fixture();
  try {
    let bytes = 0;
    for (let i = 0; i < 100; i++) {
      const blocks = Array.from(
        { length: 100 },
        (_, j) =>
          `模块${i} 条目${j} 权限不可默认开放。Node.js supports parseValue${i} and exact C++ symbols. 重排必须授权。`,
      );
      const text = blocks.join("\n");
      bytes += Buffer.byteLength(text);
      publish(f, text, `模块 ${i}`, {}, blocks);
    }
    const s = new SearchService(new EvidenceStore(f.registry));
    await s.indexer.rebuild();
    const times: number[] = [];
    for (let i = 0; i < 25; i++) {
      const started = performance.now();
      const r = await s.search(
        { query: ["权限", "Node.js", "重排", "C++", "parseValue42"][i % 5] },
        f.principal,
      );
      expect(r.hits.length).toBeGreaterThan(0);
      if (i >= 5) times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    await mkdir(".context/runtime-validation", { recursive: true });
    await writeFile(
      ".context/runtime-validation/search-benchmark.json",
      JSON.stringify(
        {
          blocks: 10000,
          bytes,
          p95Ms: p95,
          samples: times.length,
          cpu: cpus()[0]?.model,
          totalMemory: totalmem(),
          platform: process.platform,
          arch: process.arch,
          node: process.version,
        },
        null,
        2,
      ),
    );
    expect(p95).toBeLessThan(500);
  } finally {
    await f.close();
  }
}, 30000);
