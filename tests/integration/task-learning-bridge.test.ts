import { expect, test } from "vitest";
import { learningFixture } from "../learning-helpers";
import { fact } from "../task-helpers";
import { Suggestions } from "../../apps/service/src/learning/review-suggestions";
import { Capacity } from "../../apps/service/src/learning/capacity";
import { Reconciliation } from "../../apps/service/src/tasks/reconcile";
import { TaskCommands } from "../../apps/service/src/tasks/commands";
import { TaskLearningAdapter } from "../../apps/service/src/tasks/learning-adapter";
import { today } from "../../apps/service/src/tasks/today";
import { resume } from "../../apps/service/src/learning/resume";
test("due review uses real service command ledger and resumes same attempt; paused queued learning never dispatches", async () => {
  const f = await learningFixture();
  try {
    f.select();
    const attempt = f.record();
    f.db.configure(
      {
        capacity: { wip: 2, dayMinutes: 60, timezone: "Asia/Shanghai" },
        review: { intervalDays: 1, windowDays: 3, minutes: 20 },
      },
      f.principal,
    );
    const s = new Suggestions(f.db).generate(f.b.goalId, f.principal)
      .created[0]!;
    f.advance(86400001);
    const db = new Reconciliation(f.db.proposals, f.db.now),
      bridge = new TaskLearningAdapter(db),
      capacity = new Capacity(f.db, bridge),
      commands = new TaskCommands(db);
    const inventory = (facts: ReturnType<typeof fact>[]) => {
      const { id } = db.begin(f.principal);
      db.add(id, facts, f.principal);
      db.finish(
        id,
        {
          count: facts.length,
          complete: true,
          existingPaths: facts.map((f) => f.path),
        },
        f.principal,
      );
    };
    inventory([]);
    const intent = await capacity.create(s, f.principal);
    expect(intent.state).toBe("unknown");
    const c = commands.claim(f.principal)!;
    expect(c.taskId).toBe(intent.taskId);
    inventory([fact({ taskId: c.taskId, operationId: c.id })]);
    expect((await capacity.reconcile(intent.id, f.principal)).state).toBe(
      "created",
    );
    expect(today(db).learningLinks).toEqual([
      { taskId: c.taskId, goalId: f.b.goalId, unitId: f.input.units[0]!.id },
    ]);
    expect(
      resume(f.db, f.b.goalId, f.input.units[0]!.id, f.principal).latestAttempt
        ?.id,
    ).toBe(attempt.id);
    const second = f.input.units[1]!;
    f.select(second.id);
    f.record(second.id);
    const next = new Suggestions(f.db).generate(f.b.goalId, f.principal)
      .created[0]!;
    f.advance(86400001);
    inventory([fact({ taskId: c.taskId, operationId: c.id })]);
    const queued = await capacity.create(next, f.principal);
    f.db.setState(f.b.goalId, "paused", f.principal);
    expect(commands.claim(f.principal)).toBeNull();
    expect((await capacity.reconcile(queued.id, f.principal)).state).toBe(
      "failed",
    );
  } finally {
    await f.close();
  }
});
