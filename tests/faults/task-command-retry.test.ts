import { randomUUID } from "node:crypto";
import { test, expect } from "vitest";
import { taskFixture, fact } from "../task-helpers";
import { TaskCommands } from "../../apps/service/src/tasks/commands";
import {
  capture,
  deadlineExclusive,
} from "../../apps/service/src/tasks/capture";
const input = {
  title: "明天学",
  desiredDay: null,
  earliestDay: null,
  deadlineDay: null,
  timezone: "Asia/Shanghai",
  minutes: 20,
  details: "",
};
test("duplicate confirmations share one command; lost dispatch receipt is never resent and marker inventory attributes creation", async () => {
  const f = await taskFixture();
  try {
    f.inventory([]);
    const commands = new TaskCommands(f.db),
      operationId = randomUUID();
    const c = commands.enqueue({ operationId, input }, f.principal);
    expect(commands.enqueue({ operationId, input }, f.principal).taskId).toBe(
      c.taskId,
    );
    expect(() =>
      commands.enqueue(
        { operationId, input: { ...input, title: "changed" } },
        f.principal,
      ),
    ).toThrow("CONFLICT");
    expect(commands.claim(f.principal)?.state).toBe("unknown");
    expect(commands.claim(f.principal)).toBeNull();
    f.inventory([]);
    expect(commands.list()[0]!.state).toBe("unknown");
    f.inventory([fact({ taskId: c.taskId, operationId: c.id })]);
    expect(commands.list()[0]).toMatchObject({
      state: "created",
      attributed: true,
    });
  } finally {
    await f.close();
  }
});
test("target state alone cannot attribute an operation; unknown commands cannot be cancelled as not-created", async () => {
  const f = await taskFixture();
  try {
    f.inventory([]);
    const commands = new TaskCommands(f.db),
      c = commands.enqueue({ operationId: randomUUID(), input }, f.principal);
    commands.claim(f.principal);
    expect(() => commands.cancel(c.id, f.principal)).toThrow("CONFLICT");
    f.inventory([
      fact({
        taskId: c.taskId,
        operationId: null,
        status: "done",
        lifecycle: "done",
      }),
    ]);
    expect(commands.list()[0]).toMatchObject({
      state: "conflict",
      attributed: false,
    });
  } finally {
    await f.close();
  }
});
test("date-only deadline uses next local midnight across DST and natural language title does not invent hard deadline", () => {
  expect(capture(input).input.deadlineDay).toBeNull();
  expect(
    new Date(deadlineExclusive("2026-03-08", "America/New_York")).toISOString(),
  ).toBe("2026-03-09T04:00:00.000Z");
  expect(
    new Date(deadlineExclusive("2026-11-01", "America/New_York")).toISOString(),
  ).toBe("2026-11-02T05:00:00.000Z");
  expect(() => deadlineExclusive("2026-02-30", "UTC")).toThrow();
});

test("local phrase draft keeps original text and proposes desired day only, never hard deadline", async () => {
  const { textCapture } = await import("../../apps/service/src/tasks/capture");
  const r = textCapture(
    "明天学习 20 分钟，记得核对截止",
    "Asia/Shanghai",
    Date.parse("2026-09-22T18:00:00Z"),
  );
  expect(r.input).toMatchObject({
    title: "明天学习 20 分钟，记得核对截止",
    desiredDay: "2026-09-24",
    deadlineDay: null,
    minutes: 20,
  });
  expect(r.provenance.desiredDay).toContain("需确认");
});

test("old-session queued commands do not block new work and need explicit digest-bound reconfirmation", async () => {
  const f = await taskFixture();
  try {
    f.inventory([]);
    const commands = new TaskCommands(f.db),
      old = commands.enqueue({ operationId: randomUUID(), input }, f.principal);
    const paired = await f.sessions.pair({
      code: f.sessions.issuePairing(),
      deviceId: f.deviceId,
      vaultPath: f.registry.get().vaultPath,
    });
    const fresh = commands.enqueue(
      { operationId: randomUUID(), input: { ...input, title: "fresh" } },
      paired.principal,
    );
    expect(commands.claim(paired.principal)?.id).toBe(fresh.id);
    expect(() =>
      commands.reauthorize(old.id, "wrong", paired.principal),
    ).toThrow("BASELINE");
    commands.reauthorize(old.id, old.digest, paired.principal);
    expect(commands.claim(paired.principal)?.id).toBe(old.id);
  } finally {
    await f.close();
  }
});
