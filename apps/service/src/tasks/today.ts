import type { TaskToday, LearningTaskIntent } from "@kb/contracts";
import { observedTasks, dependencyCycles } from "./identity";
import { Reconciliation } from "./reconcile";
import { TaskCommands } from "./commands";
import { projectionReceipts } from "../projections/receipts";
export function today(db: Reconciliation): TaskToday {
  const head = db.head(),
    tasks = observedTasks(db.store),
    risks: string[] = [];
  const complete = head.complete && db.now() - head.observedAt <= 30000;
  if (!complete)
    risks.push("事实尚未完成可靠核对；显示最后确认结果，暂停自动创建。");
  if (tasks.some((t) => ["conflict", "unknown"].includes(t.sync)))
    risks.push("存在重复身份或读取未知的任务，请在 TaskNotes 中核对。");
  if (tasks.some((t) => t.fact.lifecycle === "unmapped"))
    risks.push("存在未映射状态，不自动视为已完成。");
  if (dependencyCycles(tasks).length)
    risks.push("任务依赖存在环；相关任务不能自动排程。");
  const planId = db.store.get("tasks.acceptedPlan") as string | undefined;
  const row = planId
    ? (db.store.db
        .prepare("SELECT value FROM task_plan_reads WHERE id=?")
        .get(planId) as { value: string } | undefined)
    : undefined;
  const plan = row
    ? (JSON.parse(row.value) as NonNullable<TaskToday["plan"]>)
    : null;
  if (plan) {
    const invalid = new Set(
      (
        db.store.db
          .prepare("SELECT task_id FROM task_invalidations WHERE at>=?")
          .all(
            (JSON.parse(row!.value) as { acceptedAt: number }).acceptedAt ?? 0,
          ) as { task_id: string }[]
      ).map((r) => r.task_id),
    );
    plan.blocks = plan.blocks.filter(
      (b) =>
        b.started ||
        !b.taskId ||
        (!invalid.has(b.taskId) &&
          tasks.some(
            (t) =>
              t.taskId === b.taskId &&
              t.sync === "current" &&
              !["done", "cancelled"].includes(t.fact.lifecycle),
          )),
    );
  }
  const learningLinks = (
    db.store.db.prepare("SELECT value FROM learning_task_intents").all() as {
      value: string;
    }[]
  )
    .map((r) => JSON.parse(r.value) as LearningTaskIntent)
    .filter((i) =>
      tasks.some((t) => t.taskId === i.taskId && t.sync === "current"),
    )
    .map((i) => ({ taskId: i.taskId, goalId: i.goalId, unitId: i.unitId }));
  if (!plan) risks.push("精确排程与日历覆盖尚未接入，当前任务均按未排项展示。");
  return {
    observedAt: head.observedAt || null,
    complete,
    tasks,
    unmanaged: head.unmanaged,
    commands: new TaskCommands(db).list(),
    risks,
    learningLinks,
    plan,
    receipts: plan ? projectionReceipts(db.store, plan.id) : [],
  };
}
