import { afterEach, expect, test } from "vitest";
import { fixture, settings } from "../helpers";
import { Store } from "../../apps/service/src/storage/store";
import { WorkspaceRegistry } from "../../apps/service/src/workspace/registry";
import { Jobs } from "../../apps/service/src/runtime/jobs";
import { Budget } from "../../apps/service/src/runtime/budget";
import { join } from "node:path";
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of close.splice(0)) await f();
});
async function setup(now = Date.now) {
  const f = await fixture(now);
  close.push(f.close);
  f.registry.saveSettings(settings, 1);
  return f;
}
test("two SQLite connections cannot spend the last reservation twice; idempotency preserves call", async () => {
  const f = await setup();
  const job = f.jobs.enqueue(
    { operationKey: "operation-1", queue: "batch", kind: "diagnostic-check" },
    100,
  );
  const active = f.jobs.claim("batch")!;
  const input = {
    operationKey: "call-1",
    jobId: job.id,
    fence: active.fence,
    routeId: "test-model",
    inputTokens: 1,
  };
  const first = f.budget.reserve(input);
  expect(f.budget.reserve(input).id).toBe(first.id);
  const other = new Store(join(f.data, "state.db"));
  try {
    const registry = new WorkspaceRegistry(other, f.data);
    const budget = new Budget(registry, new Jobs(other));
    expect(() => budget.reserve({ ...input, operationKey: "call-2" })).toThrow(
      "BUDGET",
    );
  } finally {
    other.close();
  }
  expect(() => f.budget.reserve({ ...input, inputTokens: 2 })).toThrow(
    "CONFLICT",
  );
});
test("unknown usage survives midnight and restart; root cap shared with children", async () => {
  let time = Date.parse("2026-09-21T23:59:59Z");
  const f = await setup(() => time);
  const root = f.jobs.enqueue(
    {
      operationKey: "root-operation",
      queue: "batch",
      kind: "diagnostic-check",
    },
    100,
  );
  const active = f.jobs.claim("batch")!;
  const call = f.budget.reserve({
    operationKey: "call-1",
    jobId: root.id,
    fence: active.fence,
    routeId: "test-model",
    inputTokens: 1,
  });
  f.budget.dispatch(call.id, active.fence);
  time += 2000;
  f.budget.recover();
  expect(f.budget.get(call.id).state).toBe("unknown");
  expect(f.budget.get(call.id).day).toBe("2026-09-21");
  const child = f.jobs.enqueue(
    {
      operationKey: "child-operation",
      parentId: root.id,
      queue: "interactive",
      kind: "diagnostic-check",
    },
    9999,
  );
  const worker = f.jobs.claim("interactive")!;
  expect(child.rootId).toBe(root.id);
  expect(() =>
    f.budget.reserve({
      operationKey: "call-2",
      jobId: child.id,
      fence: worker.fence,
      routeId: "test-model",
      inputTokens: 1,
    }),
  ).toThrow("BUDGET");
  expect(() => f.budget.release(call.id)).toThrow("UNKNOWN_COST");
  f.jobs.cancel(root.id);
  expect(f.jobs.get(child.id).state).toBe("cancelled");
  expect(f.budget.settle(call.id, "provider-1", 120).actual).toBe(120);
  expect(f.budget.settle(call.id, "provider-1", 120).actual).toBe(120);
  expect(() => f.budget.settle(call.id, "provider-1", 121)).toThrow("CONFLICT");
});
test("expired worker and reused operation with different payload rejected", async () => {
  let time = Date.now();
  const f = await setup(() => time);
  const job = f.jobs.enqueue(
    {
      operationKey: "root-operation",
      queue: "batch",
      kind: "diagnostic-check",
    },
    100,
  );
  const old = f.jobs.claim("batch", 1)!;
  time += 2;
  const current = f.jobs.claim("batch")!;
  expect(current.fence).toBe(old.fence + 1);
  expect(() => f.jobs.finish(job.id, old.fence, true)).toThrow("STALE_WORKER");
  expect(f.jobs.finish(job.id, current.fence, true).state).toBe("succeeded");
  expect(() =>
    f.jobs.enqueue(
      {
        operationKey: "root-operation",
        queue: "interactive",
        kind: "diagnostic-check",
      },
      100,
    ),
  ).toThrow("CONFLICT");
});

test("two independent processes racing the last quota reserve exactly once", async () => {
  const { build } = await import("esbuild");
  const { fork } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const f = await setup();
  const job = f.jobs.enqueue(
    { operationKey: "process-race", queue: "batch", kind: "diagnostic-check" },
    100,
  );
  const worker = f.jobs.claim("batch")!;
  const entry = join(f.root, "contender.cjs");
  await build({
    entryPoints: ["tests/fixtures/budget-contender.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    alias: { "@kb/contracts": resolve("packages/contracts/src/index.ts") },
  });
  const children = [1, 2].map((n) =>
    fork(entry, [f.data, job.id, String(worker.fence), `racing-call-${n}`], {
      env: { NODE_PATH: resolve("apps/service/node_modules") },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    }),
  );
  try {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.once("message", () => resolve());
            child.once("error", reject);
          }),
      ),
    );
    const outcomes = children.map(
      (child) =>
        new Promise<string>((resolve, reject) => {
          child.once("message", (message) =>
            resolve((message as { code: string }).code),
          );
          child.once("error", reject);
        }),
    );
    children.forEach((child) => child.send("go"));
    expect((await Promise.all(outcomes)).sort()).toEqual([
      "BUDGET",
      "RESERVED",
    ]);
  } finally {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null) return resolve();
            child.once("exit", () => resolve());
            child.kill();
          }),
      ),
    );
  }
});

test("settlement above estimate records truth and stops further root spending; cancellation cannot release dispatched cost", async () => {
  const f = await setup();
  f.registry.saveSettings(
    {
      ...settings,
      budget: {
        ...settings.budget,
        jobLimit: 1000,
        dayLimit: 1000,
        monthLimit: 1000,
      },
    },
    2,
  );
  const job = f.jobs.enqueue(
    { operationKey: "overrun-root", queue: "batch", kind: "diagnostic-check" },
    1000,
  );
  const active = f.jobs.claim("batch")!;
  const input = {
    jobId: job.id,
    fence: active.fence,
    routeId: "test-model",
    inputTokens: 1,
  };
  const call = f.budget.reserve({ ...input, operationKey: "overrun-call" });
  f.budget.dispatch(call.id, active.fence);
  f.budget.settle(call.id, "overrun-provider", 70);
  expect(f.budget.get(call.id).actual).toBe(70);
  expect(() =>
    f.budget.reserve({ ...input, operationKey: "overrun-next" }),
  ).toThrow("BUDGET");
});
