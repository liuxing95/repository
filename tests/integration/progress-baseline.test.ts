import { randomUUID } from "node:crypto";
import { test, expect } from "vitest";
import { taskFixture, fact } from "../task-helpers";
import {
  freezeBaseline,
  taskProgress,
} from "../../apps/service/src/tasks/progress";
test("no precision without baseline; cancellation and added scope preserve historical denominator and parent duplicates rejected", async () => {
  const f = await taskFixture();
  try {
    expect(taskProgress(f.db).percent).toBeNull();
    const a = fact({ lifecycle: "done" }),
      b = fact({ path: "Tasks/b.md", lifecycle: "cancelled" });
    f.inventory([a, b]);
    const leaves = [a, b].map((t) => ({
      id: randomUUID(),
      taskId: t.taskId!,
      label: t.title,
      weight: 1,
    }));
    const first = freezeBaseline(
      f.db,
      { previousId: null, label: "v1", leaves },
      f.principal,
    );
    expect(taskProgress(f.db)).toMatchObject({
      percent: 50,
      total: 2,
      cancelled: 1,
    });
    expect(() =>
      freezeBaseline(
        f.db,
        { previousId: first.id, label: "v2", leaves: [leaves[0]] },
        f.principal,
      ),
    ).toThrow("BASELINE");
    freezeBaseline(
      f.db,
      {
        previousId: first.id,
        label: "v2",
        leaves: [
          ...leaves,
          { id: randomUUID(), taskId: randomUUID(), label: "new", weight: 2 },
        ],
      },
      f.principal,
    );
    expect(taskProgress(f.db)).toMatchObject({
      percent: 25,
      total: 4,
      unknown: 2,
    });
    expect(
      f.store.db.prepare("SELECT count(*) n FROM task_baselines").get(),
    ).toEqual({ n: 2 });
  } finally {
    await f.close();
  }
});
