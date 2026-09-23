import { randomUUID } from "node:crypto";
import { test, expect } from "vitest";
import { taskFixture, fact } from "../task-helpers";
import {
  observedTasks,
  dependencyCycles,
} from "../../apps/service/src/tasks/identity";
test("three completion hints and body saves create one completion invalidation and durable cancellation outbox", async () => {
  const f = await taskFixture();
  try {
    const a = fact();
    f.inventory([a]);
    for (let n = 0; n < 3; n++)
      f.db.event({ id: randomUUID(), kind: "task" }, f.principal);
    const done = { ...a, status: "done", lifecycle: "done" as const };
    f.inventory([done]);
    f.inventory([{ ...done, contentHash: "b".repeat(64) }]);
    expect(
      f.store.db.prepare("SELECT count(*) n FROM task_cancel_outbox").get(),
    ).toEqual({ n: 1 });
    expect(
      f.store.db
        .prepare("SELECT count(*) n FROM events WHERE kind=?")
        .get("task.observed"),
    ).toEqual({ n: 2 });
    f.inventory([a]);
    expect(
      f.store.db.prepare("SELECT count(*) n FROM task_invalidations").get(),
    ).toEqual({ n: 1 });
  } finally {
    await f.close();
  }
});
test("old inventory cannot overwrite a newer boundary; old event is only a hint; dependency cycles remain visible", async () => {
  const f = await taskFixture();
  try {
    const a = fact(),
      b = fact({ path: "Tasks/b.md", dependencies: [a.path] });
    a.dependencies = [b.path];
    const old = f.db.begin(f.principal);
    f.db.add(old.id, [a], f.principal);
    f.inventory([a, b]);
    expect(() =>
      f.db.finish(
        old.id,
        { count: 1, complete: true, existingPaths: [a.path] },
        f.principal,
      ),
    ).toThrow("BASELINE");
    expect(dependencyCycles(observedTasks(f.store))).toHaveLength(2);
    f.db.event({ id: randomUUID(), kind: "task" }, f.principal);
    expect(observedTasks(f.store)).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("reopening and completing again registers a new cancellation intent without erasing the first one", async () => {
  const f = await taskFixture();
  try {
    const a = fact(),
      done = { ...a, status: "done", lifecycle: "done" as const };
    f.inventory([a]);
    f.inventory([done]);
    f.inventory([a]);
    f.inventory([done]);
    expect(
      f.store.db.prepare("SELECT count(*) n FROM task_cancel_outbox").get(),
    ).toEqual({ n: 2 });
  } finally {
    await f.close();
  }
});
