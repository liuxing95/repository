import { expect, test } from "vitest";
import { fixture } from "../helpers";
import { WorkerPool } from "../../apps/service/src/runtime/worker-pool";
import { build } from "esbuild";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("worker timeout");
}
test("separate queue processes run with a restricted environment and recover from killed work", async () => {
  const f = await fixture();
  const entry = join(f.root, "worker.cjs");
  await build({
    entryPoints: ["apps/service/src/runtime/worker-entry.ts"],
    outfile: entry,
    platform: "node",
    format: "cjs",
    bundle: true,
  });
  const pool = new WorkerPool(f.jobs, entry);
  try {
    const batch = f.jobs.enqueue(
      { operationKey: "batch-test", queue: "batch", kind: "diagnostic-check" },
      0,
    );
    const interactive = f.jobs.enqueue(
      {
        operationKey: "interactive-test",
        queue: "interactive",
        kind: "diagnostic-check",
      },
      0,
    );
    pool.start();
    await until(
      () =>
        f.jobs.get(interactive.id).state === "succeeded" &&
        f.jobs.get(batch.id).state === "succeeded",
    );
    await pool.stop();
    await writeFile(
      entry,
      "if (Object.keys(process.env).some(k=>!['NODE_ENV','TZ','NODE_CHANNEL_FD','NODE_CHANNEL_SERIALIZATION_MODE'].includes(k))) process.exit(2); process.once('message',()=>setInterval(()=>{},1000));",
    );
    const cancelled = f.jobs.enqueue(
      {
        operationKey: "cancelled-test",
        queue: "batch",
        kind: "diagnostic-check",
      },
      0,
    );
    pool.start();
    await until(() => f.jobs.get(cancelled.id).state === "running");
    f.jobs.cancel(cancelled.id);
    await pool.stop();
    expect(f.jobs.get(cancelled.id).state).toBe("cancelled");
  } finally {
    await pool.stop();
    await f.close();
  }
});
