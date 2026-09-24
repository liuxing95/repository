import { test, expect } from "vitest";
import { taskFixture, fact } from "../task-helpers";
import {
  observedTasks,
  occurrenceKey,
} from "../../apps/service/src/tasks/identity";
test("rename preserves identity and business revision; duplicate IDs block facts and recovery does not resurrect tombstones", async () => {
  const f = await taskFixture();
  try {
    const a = fact();
    f.inventory([a]);
    const revision = observedTasks(f.store)[0]!.revision;
    f.inventory([{ ...a, path: "Moved/new.md" }]);
    expect(observedTasks(f.store)[0]).toMatchObject({
      taskId: a.taskId,
      revision,
      sync: "current",
      paths: ["Moved/new.md"],
    });
    f.inventory([a, { ...a, path: "Copy/copy.md" }]);
    expect(observedTasks(f.store)[0]!.sync).toBe("conflict");
    f.inventory([a]);
    expect(observedTasks(f.store)[0]!.sync).toBe("current");
    f.inventory([]);
    expect(observedTasks(f.store)[0]!.sync).toBe("deleted");
    f.inventory([a]);
    expect(observedTasks(f.store)[0]!.sync).toBe("deleted");
  } finally {
    await f.close();
  }
});
test("incomplete listing and still-existing files never imply deletion; occurrence key uses original date and timezone", async () => {
  const f = await taskFixture();
  try {
    const a = fact();
    f.inventory([a]);
    f.inventory([], false);
    expect(observedTasks(f.store)[0]!.sync).toBe("current");
    f.inventory([], true, [a.path]);
    expect(observedTasks(f.store)[0]!.sync).toBe("unknown");
    expect(occurrenceKey(a.taskId!, "2026-09-22", "Asia/Shanghai")).not.toBe(
      occurrenceKey(a.taskId!, "2026-09-22", "UTC"),
    );
  } finally {
    await f.close();
  }
});

test("materialized occurrence keeps original identity when schedule moves; duplicate occurrence mapping becomes conflict", async () => {
  const f = await taskFixture();
  try {
    const series = fact({ recurrence: "FREQ=DAILY" }),
      instance = fact({
        path: "Tasks/instance.md",
        seriesPath: series.path,
        originalOccurrence: "2026-09-22",
      });
    f.inventory([series, instance]);
    const key = observedTasks(f.store).find(
      (t) => t.taskId === instance.taskId,
    )!.occurrenceKey;
    expect(key).toBeTruthy();
    f.inventory([series, { ...instance, desiredDay: "2026-09-24" }]);
    expect(
      observedTasks(f.store).find((t) => t.taskId === instance.taskId)!
        .occurrenceKey,
    ).toBe(key);
    const copy = fact({
      path: "Tasks/other-instance.md",
      seriesPath: series.path,
      originalOccurrence: "2026-09-22",
    });
    f.inventory([series, instance, copy]);
    expect(
      observedTasks(f.store).filter((t) => t.sync === "conflict"),
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
});
