import { randomUUID } from "node:crypto";
import {
  TaskBaselineInput,
  type TaskBaseline,
  type Principal,
} from "@kb/contracts";
import { AppError } from "../errors";
import type { Reconciliation } from "./reconcile";
import { observedTasks } from "./identity";
export function freezeBaseline(db: Reconciliation, raw: unknown, p: Principal) {
  db.guard.write(p);
  const input = TaskBaselineInput.parse(raw);
  return db.store.tx(() => {
    const current = db.store.get("tasks.baseline") as string | undefined;
    if ((current ?? null) !== input.previousId) throw new AppError("BASELINE");
    if (
      new Set(input.leaves.map((l) => l.id)).size !== input.leaves.length ||
      new Set(input.leaves.map((l) => l.taskId)).size !== input.leaves.length
    )
      throw new AppError("VALIDATION", 400);
    if (current) {
      const row = db.store.db
        .prepare("SELECT value FROM task_baselines WHERE id=?")
        .get(current) as { value: string };
      const previous = JSON.parse(row.value) as TaskBaseline;
      for (const old of previous.input.leaves) {
        const next = input.leaves.find((l) => l.id === old.id);
        if (!next || JSON.stringify(next) !== JSON.stringify(old))
          throw new AppError("BASELINE");
      }
    }
    const b: TaskBaseline = { id: randomUUID(), createdAt: db.now(), input };
    db.store.db
      .prepare("INSERT INTO task_baselines VALUES(?,?)")
      .run(b.id, JSON.stringify(b));
    db.store.set("tasks.baseline", b.id);
    return b;
  });
}
export function taskProgress(db: Reconciliation) {
  const id = db.store.get("tasks.baseline") as string | undefined;
  if (!id)
    return {
      baseline: null,
      percent: null,
      message: "没有冻结叶子验收基线，不计算精确百分比。",
    };
  const b = JSON.parse(
    (
      db.store.db
        .prepare("SELECT value FROM task_baselines WHERE id=?")
        .get(id) as { value: string }
    ).value,
  ) as TaskBaseline;
  const tasks = new Map(observedTasks(db.store).map((t) => [t.taskId, t]));
  let done = 0,
    cancelled = 0,
    unknown = 0;
  const total = b.input.leaves.reduce((n, l) => n + l.weight, 0);
  for (const leaf of b.input.leaves) {
    const t = tasks.get(leaf.taskId);
    if (!t || t.sync !== "current") unknown += leaf.weight;
    else if (t.fact.lifecycle === "done") done += leaf.weight;
    else if (t.fact.lifecycle === "cancelled") cancelled += leaf.weight;
  }
  return {
    baseline: b,
    percent: (100 * done) / total,
    done,
    total,
    cancelled,
    unknown,
  };
}
