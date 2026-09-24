import { describe, expect, it } from "vitest";
import { PlanningRequest } from "@kb/contracts";
import { deadlineExclusive } from "../../apps/service/src/tasks/capture";
import {
  localDayStart,
  intersects,
  subtract,
} from "../../apps/service/src/planning/time";
describe("排程时间语义", () => {
  it("仅日期截止按当地下一日零点，夏令时当天不是固定 24 小时", () => {
    const start = localDayStart("2026-03-08", "America/New_York");
    const end = deadlineExclusive("2026-03-08", "America/New_York");
    expect(new Date(start).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect((end - start) / 3600000).toBe(23);
  });
  it("拒绝没有偏移的缺失和重复本地小时", () => {
    const base = {
      timezone: "America/New_York",
      unavailable: [],
      calendarIds: [],
      policy: { maxNodes: 100, freezeMinutes: 0, freshnessMs: 30000 },
    };
    expect(
      PlanningRequest.safeParse({
        ...base,
        windows: [{ start: "2026-03-08T02:30:00", end: "2026-03-08T03:30:00" }],
      }).success,
    ).toBe(false);
    expect(
      PlanningRequest.safeParse({
        ...base,
        windows: [{ start: "2026-11-01T01:30:00", end: "2026-11-01T02:30:00" }],
      }).success,
    ).toBe(false);
    expect(
      PlanningRequest.safeParse({
        ...base,
        windows: [
          {
            start: "2026-11-01T01:30:00-04:00",
            end: "2026-11-01T01:30:00-05:00",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      PlanningRequest.safeParse({
        ...base,
        windows: [{ start: "bad-offset", end: "2026-11-01T01:30:00-05:00" }],
      }).success,
    ).toBe(false);
  });
  it("半开区间相接不冲突", () => {
    expect(intersects({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(
      false,
    );
    expect(subtract([{ start: 0, end: 20 }], [{ start: 4, end: 8 }])).toEqual([
      { start: 0, end: 4 },
      { start: 8, end: 20 },
    ]);
  });
});
