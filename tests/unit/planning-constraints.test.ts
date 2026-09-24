import { expect, it } from "vitest";
import type {
  PlanningSnapshot,
  PlanningTask,
  PlanningBlock,
} from "@kb/contracts";
import { solve } from "../../apps/service/src/planning/solver";
import { validateCandidate } from "../../apps/service/src/planning/validator";
const now = Date.now(),
  minute = 60000;
function task(id: string, overrides: Partial<PlanningTask> = {}): PlanningTask {
  return {
    id,
    path: `Tasks/${id}.md`,
    title: id,
    revision: id,
    minutes: 20,
    activeLog: false,
    remainingSource: "TaskNotes 估计减已记录时长",
    deadline: null,
    deadlineInvalid: false,
    location: null,
    device: null,
    priority: null,
    earliest: null,
    desiredDay: null,
    dependencies: [],
    lifecycle: "todo",
    sync: "current",
    ...overrides,
  };
}
function block(id: string, start: number, locked = false): PlanningBlock {
  return {
    id,
    taskId: id,
    start,
    end: start + 20 * minute,
    kind: "flexible",
    started: false,
    locked,
  };
}
function snapshot(
  tasks: PlanningTask[],
  previous: PlanningBlock[] = [],
  maxNodes = 100,
): PlanningSnapshot {
  return {
    id: "snapshot",
    evaluatedAt: now,
    basePlanId: null,
    generation: 1,
    policyVersion: 1,
    epoch: 1,
    request: {
      timezone: "UTC",
      windows: [
        {
          start: new Date(now + minute).toISOString(),
          end: new Date(now + 90 * minute).toISOString(),
        },
      ],
      unavailable: [],
      calendarIds: [],
      policy: { maxNodes, freezeMinutes: 0, freshnessMs: 30000 },
    },
    tasks,
    previous,
    busy: [],
    coverage: {
      state: "unconnected",
      calendarIds: [],
      checkedAt: null,
      reason: "未核对外部日历",
      hash: "none",
    },
    hash: "test",
  };
}
it("紧急插入移动原弹性块，锁定块不能移动", () => {
  const old = block("ordinary", now + minute);
  const urgent = task("urgent", { deadline: now + 25 * minute });
  const c = solve(snapshot([task("ordinary"), urgent], [old]));
  expect(validateCandidate(c)).toEqual([]);
  expect(c.blocks.find((b) => b.taskId === "urgent")?.start).toBe(now + minute);
  expect(c.diff.moved[0]?.taskId).toBe("ordinary");
  const locked = solve(
    snapshot([task("ordinary"), urgent], [{ ...old, locked: true }]),
  );
  expect(locked.blocks.find((b) => b.taskId === "ordinary")?.start).toBe(
    old.start,
  );
  expect(locked.unscheduled.find((u) => u.taskId === "urgent")?.reason).toMatch(
    /硬条件证明/,
  );
  expect(validateCandidate(locked)).toEqual([]);
});
it("前置必须先结束；循环依赖和缺失前置留在未排项", () => {
  const a = task("a", { dependencies: ["b"] }),
    b = task("b");
  const c = solve(snapshot([a, b]));
  expect(c.blocks.find((x) => x.taskId === "b")!.end).toBeLessThanOrEqual(
    c.blocks.find((x) => x.taskId === "a")!.start,
  );
  expect(validateCandidate(c)).toEqual([]);
  const cycle = solve(
    snapshot([
      a,
      task("b", { dependencies: ["a"] }),
      task("lost", { dependencies: ["missing:x"] }),
    ]),
  );
  expect(cycle.blocks).toHaveLength(0);
  expect(cycle.unscheduled).toHaveLength(3);
  expect(validateCandidate(cycle)).toEqual([]);
});
it("节点预算耗尽给出部分结果，独立校验器拒绝碰撞与缩短时长", () => {
  const c = solve(snapshot([task("a"), task("b")], [], 1));
  expect(c.unscheduled.length).toBeGreaterThan(0);
  expect(c.stopReason).toMatch(/节点/);
  expect(validateCandidate(c)).toEqual([]);
  const normal = solve(snapshot([task("a"), task("b")]));
  normal.blocks[1]!.start = normal.blocks[0]!.start;
  normal.blocks[1]!.end = normal.blocks[1]!.start + 10 * minute;
  expect(validateCandidate(normal).join(" ")).toMatch(/时长不符|时间重叠/);
});
it("原计划无变化不创建候选版本", () => {
  const old = block("a", now + minute);
  const c = solve(snapshot([task("a")], [old]));
  expect(c.status).toBe("no-op");
  expect(validateCandidate(c)).toEqual([]);
});
it("任务地点与设备是硬条件，优先级不能突破地点限制", () => {
  const s = snapshot([
    task("desk", { location: "家", device: "电脑", priority: 5 }),
    task("phone", { priority: 0 }),
  ]);
  s.request.windows = [
    {
      start: new Date(now + minute).toISOString(),
      end: new Date(now + 50 * minute).toISOString(),
      location: "办公室",
      device: "电脑",
    },
  ];
  const c = solve(s);
  expect(c.unscheduled.find((u) => u.taskId === "desk")).toBeTruthy();
  expect(c.blocks.map((b) => b.taskId)).toEqual(["phone"]);
  expect(validateCandidate(c)).toEqual([]);
  c.blocks[0]!.taskId = "desk";
  expect(validateCandidate(c).join(" ")).toMatch(/资源不符/);
});
it("重叠可用窗口中存在匹配资源时，独立校验器不误拒绝", () => {
  const s = snapshot([task("desk", { location: "家", device: "电脑" })]);
  s.request.windows = [
    {
      start: new Date(now + minute).toISOString(),
      end: new Date(now + 50 * minute).toISOString(),
      location: "办公室",
      device: "电脑",
    },
    {
      start: new Date(now + minute).toISOString(),
      end: new Date(now + 50 * minute).toISOString(),
      location: "家",
      device: "电脑",
    },
  ];
  const c = solve(s);
  expect(c.blocks).toHaveLength(1);
  expect(validateCandidate(c)).toEqual([]);
});
it("不可拆时长超过所有硬可用空档才称为有证据不可行", () => {
  const s = snapshot([task("large", { minutes: 100 })]);
  const c = solve(s);
  expect(c.unscheduled[0]?.reason).toMatch(/硬条件证明/);
  expect(c.capacityGapMinutes).toBeGreaterThan(0);
  expect(validateCandidate(c)).toEqual([]);
});
