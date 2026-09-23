import { test, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { taskFixture, fact } from "../task-helpers";
import { createServer } from "../../apps/service/src/http/server";
test("Today HTTP remains below 2 seconds p95 during a 1000-task reconciliation workload", async () => {
  const f = await taskFixture(),
    app = createServer(f.registry, f.sessions, f.jobs);
  try {
    const facts = Array.from({ length: 1000 }, (_, i) =>
      fact({ path: `Tasks/${i}.md` }),
    );
    f.inventory(facts);
    const headers = {
      host: "127.0.0.1:27124",
      authorization: `Bearer ${f.token}`,
    };
    const times: number[] = [];
    for (let i = 0; i < 25; i++) {
      const start = performance.now();
      f.inventory(
        facts.map((t, n) =>
          n === i ? { ...t, contentHash: "b".repeat(64) } : t,
        ),
      );
      const r = await app.inject({
        method: "GET",
        url: "/v1/tasks/today",
        headers,
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().tasks).toHaveLength(1000);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(2000);
    await mkdir(".context/tasknotes", { recursive: true });
    await writeFile(
      ".context/tasknotes/today-performance.json",
      JSON.stringify(
        {
          tasks: 1000,
          samples: 25,
          p95Ms: p95,
          scope:
            "service full reconciliation transaction plus HTTP read; no TaskNotes browser disk scan",
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
    await f.close();
  }
});
