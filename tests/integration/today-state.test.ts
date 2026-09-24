import { randomUUID } from "node:crypto";
import { test, expect } from "vitest";
import { taskFixture, fact } from "../task-helpers";
import { today } from "../../apps/service/src/tasks/today";
import { recordProjectionReceipt } from "../../apps/service/src/projections/receipts";
import { createServer } from "../../apps/service/src/http/server";
import { TaskLearningAdapter } from "../../apps/service/src/tasks/learning-adapter";
test("accepted plan visible before file projection, receipts independent, completed future blocks invalidated while started work retained", async () => {
  const f = await taskFixture();
  try {
    expect(today(f.db).plan).toBeNull();
    const a = fact();
    f.inventory([a]);
    const id = randomUUID(),
      start = Date.now() + 10000;
    const plan = {
      id,
      acceptedAt: Date.now() - 10,
      blocks: [
        {
          id: "future",
          taskId: a.taskId,
          kind: "flexible",
          start,
          end: start + 1000,
          started: false,
        },
        {
          id: "started",
          taskId: a.taskId,
          kind: "fixed",
          start,
          end: start + 1000,
          started: true,
        },
      ],
    };
    f.store.db
      .prepare("INSERT INTO task_plan_reads VALUES(?,?)")
      .run(id, JSON.stringify(plan));
    f.store.set("tasks.acceptedPlan", id);
    recordProjectionReceipt(f.store, {
      planId: id,
      target: "note",
      revision: "r1",
      state: "pending",
    });
    recordProjectionReceipt(f.store, {
      planId: id,
      target: "calendar",
      revision: "r1",
      state: "failed",
    });
    expect(today(f.db).plan?.blocks).toHaveLength(2);
    f.inventory([{ ...a, lifecycle: "done", status: "done" }]);
    expect(today(f.db).plan?.blocks.map((b) => b.id)).toEqual(["started"]);
    f.inventory([a]);
    expect(today(f.db).plan?.blocks.map((b) => b.id)).toEqual(["started"]);
    expect(
      today(f.db)
        .receipts.map((r) => r.state)
        .sort(),
    ).toEqual(["failed", "pending"]);
    expect(
      JSON.parse(
        (
          f.store.db
            .prepare("SELECT value FROM task_plan_reads WHERE id=?")
            .get(id) as { value: string }
        ).value,
      ).blocks,
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
});
test("HTTP TaskNotes chain enforces roles and feeds Today; unmanaged or uncertain work blocks learning quota", async () => {
  const f = await taskFixture(),
    app = createServer(f.registry, f.sessions, f.jobs);
  try {
    const headers = {
      host: "127.0.0.1:27124",
      authorization: `Bearer ${f.token}`,
      "x-policy-version": String(f.principal.policyVersion),
    };
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/tasks/today",
          headers: { host: headers.host },
        })
      ).statusCode,
    ).toBe(401);
    const run = await app.inject({
      method: "POST",
      url: "/v1/tasks/inventories",
      headers,
      payload: {},
    });
    expect(run.statusCode).toBe(200);
    const { id } = run.json();
    const a = fact({ taskId: null });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/tasks/inventories/${id}/items`,
          headers,
          payload: [a],
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/tasks/inventories/${id}/finish`,
          headers,
          payload: { count: 1, complete: true, existingPaths: [a.path] },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({ method: "GET", url: "/v1/tasks/today", headers })
      ).json().unmanaged,
    ).toHaveLength(1);
    expect(
      (await new TaskLearningAdapter(f.db).snapshot("Asia/Shanghai")).complete,
    ).toBe(false);
  } finally {
    await app.close();
    await f.close();
  }
});

test("pending ordinary task commands consume learning capacity even before a TaskNotes receipt exists", async () => {
  const f = await taskFixture();
  try {
    const { TaskCommands } =
      await import("../../apps/service/src/tasks/commands");
    f.inventory([]);
    const c = new TaskCommands(f.db).enqueue(
      {
        operationId: randomUUID(),
        input: {
          title: "等待普通任务",
          desiredDay: "2026-09-23",
          earliestDay: null,
          deadlineDay: null,
          timezone: "Asia/Shanghai",
          minutes: 30,
          details: "",
        },
      },
      f.principal,
    );
    const snapshot = await new TaskLearningAdapter(f.db).snapshot(
      "Asia/Shanghai",
    );
    expect(snapshot.complete).toBe(true);
    expect(snapshot.tasks).toEqual([
      { taskId: c.taskId, active: true, day: "2026-09-23", minutes: 30 },
    ]);
  } finally {
    await f.close();
  }
});
