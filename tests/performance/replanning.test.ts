import { expect, it } from "vitest";
import type { PlanningSnapshot, PlanningTask } from "@kb/contracts";
import { solve } from "../../apps/service/src/planning/solver";
import { validateCandidate } from "../../apps/service/src/planning/validator";
it("中等规模无模型重排 p95 在五秒内且结果可验证", () => {
  const now = Date.now(),
    day = 86400000;
  const tasks: PlanningTask[] = Array.from({ length: 200 }, (_, i) => ({
    id: `task-${i}`,
    path: `Tasks/${i}.md`,
    title: `${i}`,
    revision: `${i}`,
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
  }));
  const snapshot: PlanningSnapshot = {
    id: "perf",
    evaluatedAt: now,
    basePlanId: null,
    generation: 1,
    policyVersion: 1,
    epoch: 1,
    request: {
      timezone: "UTC",
      windows: Array.from({ length: 7 }, (_, i) => ({
        start: new Date(now + day * i + 60000).toISOString(),
        end: new Date(now + day * i + 10 * 3600000).toISOString(),
      })),
      unavailable: [],
      calendarIds: [],
      policy: { maxNodes: 5000, freezeMinutes: 0, freshnessMs: 30000 },
    },
    tasks,
    previous: [],
    busy: [],
    coverage: {
      state: "unconnected",
      calendarIds: [],
      checkedAt: null,
      reason: "local",
      hash: "local",
    },
    hash: "perf",
  };
  const durations: number[] = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    const candidate = solve(snapshot);
    durations.push(performance.now() - started);
    expect(validateCandidate(candidate)).toEqual([]);
    expect(candidate.blocks.length + candidate.unscheduled.length).toBe(200);
  }
  durations.sort((a, b) => a - b);
  expect(durations[4]).toBeLessThan(5000);
});
