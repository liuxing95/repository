import { afterEach, expect, it } from "vitest";
import { taskFixture, fact } from "../task-helpers";
import { planningSnapshot } from "../../apps/service/src/planning/snapshot";
import { solve } from "../../apps/service/src/planning/solver";
import type { PlanningRequest } from "@kb/contracts";
const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const x of open.splice(0)) await x.close();
});
const input = (start: number, end: number): PlanningRequest => ({
  timezone: "Asia/Shanghai",
  windows: [
    { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
  ],
  unavailable: [],
  calendarIds: [],
  policy: { maxNodes: 100, freezeMinutes: 0, freshnessMs: 30000 },
});
it("未知估计进入未排项，空窗口要求补充可用时间", async () => {
  const f = await taskFixture();
  open.push(f);
  f.inventory([fact({ minutes: null })]);
  const s = await planningSnapshot(
    f.db,
    input(Date.now() + 60000, Date.now() + 3600000),
    f.principal.policyVersion,
    f.principal.epoch,
  );
  expect(s.tasks[0]?.minutes).toBeNull();
  expect(s.coverage.state).toBe("unconnected");
  expect(solve(s).unscheduled[0]?.reason).toMatch(/剩余时长/);
  expect(
    solve(
      await planningSnapshot(
        f.db,
        { ...input(Date.now(), Date.now() + 3600000), windows: [] },
        f.principal.policyVersion,
        f.principal.epoch,
      ),
    ).status,
  ).toBe("no-window");
});
it("配置外部日历却读取失败，不把未知当空闲", async () => {
  const f = await taskFixture();
  open.push(f);
  f.inventory([fact()]);
  const s = await planningSnapshot(
    f.db,
    {
      ...input(Date.now() + 60000, Date.now() + 3600000),
      calendarIds: ["meeting"],
    },
    f.principal.policyVersion,
    f.principal.epoch,
    async () => {
      throw new Error("offline");
    },
  );
  expect(s.coverage.state).toBe("unknown");
  expect(solve(s).blocks).toHaveLength(0);
  expect(solve(s).unscheduled[0]?.reason).toMatch(/覆盖未知/);
});
it("重叠工作日志只扣一次；无偏移日志不按服务时区猜剩余时长", async () => {
  const f = await taskFixture();
  open.push(f);
  const start = Date.now() - 3600000;
  const iso = (n: number) => new Date(n).toISOString();
  const t = fact({
    minutes: 60,
    timeEntries: [
      { startTime: iso(start), endTime: iso(start + 20 * 60000) },
      { startTime: iso(start + 10 * 60000), endTime: iso(start + 30 * 60000) },
    ],
  });
  f.inventory([t]);
  const planning = () =>
    planningSnapshot(
      f.db,
      input(Date.now() + 60000, Date.now() + 3600000),
      f.principal.policyVersion,
      f.principal.epoch,
    );
  expect((await planning()).tasks[0]?.minutes).toBe(30);
  f.inventory([
    {
      ...t,
      timeEntries: [
        { startTime: "2026-09-24T09:00:00", endTime: "2026-09-24T09:20:00" },
      ],
    },
  ]);
  expect((await planning()).tasks[0]?.minutes).toBeNull();
});
it("既有正式计划的固定会议保留为本地忙时段", async () => {
  const f = await taskFixture();
  open.push(f);
  f.inventory([fact()]);
  const start = Date.now() + 60000;
  const id = "7f31e0e9-310a-44ea-b7cd-8e1eec971c42";
  f.store.set("tasks.acceptedPlan", id);
  f.store.db
    .prepare("INSERT INTO task_plan_reads VALUES(?,?)")
    .run(
      id,
      JSON.stringify({
        id,
        acceptedAt: Date.now(),
        blocks: [
          {
            id: "meeting",
            taskId: null,
            kind: "fixed",
            start,
            end: start + 30 * 60000,
            started: false,
          },
        ],
      }),
    );
  const s = await planningSnapshot(
    f.db,
    input(start, start + 3600000),
    f.principal.policyVersion,
    f.principal.epoch,
  );
  expect(s.busy).toContainEqual({ start, end: start + 30 * 60000 });
  expect(solve(s).blocks[0]?.start).toBeGreaterThanOrEqual(start + 30 * 60000);
});
