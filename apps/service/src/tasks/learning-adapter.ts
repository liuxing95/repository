import type { Principal, TaskCapacitySnapshot } from "@kb/contracts";
import type {
  LearningTaskAdapter,
  TaskCreationResult,
} from "../learning/capacity";
import { Reconciliation } from "./reconcile";
import { observedTasks } from "./identity";
import { TaskCommands } from "./commands";
import { AppError } from "../errors";
export class TaskLearningAdapter implements LearningTaskAdapter {
  constructor(readonly db: Reconciliation) {}
  async snapshot(timezone: string): Promise<TaskCapacitySnapshot> {
    const head = this.db.head(),
      tasks = observedTasks(this.db.store);
    const pending = new TaskCommands(this.db)
      .list()
      .filter(
        (c) =>
          ["queued", "unknown"].includes(c.state) &&
          !tasks.some((t) => t.taskId === c.taskId),
      );
    return {
      complete:
        head.complete &&
        pending.every(
          (c) => c.input.minutes !== null && c.input.timezone === timezone,
        ) &&
        head.unmanaged.length === 0 &&
        tasks.every(
          (t) =>
            t.sync === "deleted" ||
            (t.sync === "current" &&
              t.fact.lifecycle !== "unmapped" &&
              !t.fact.recurrence &&
              t.fact.timezone === timezone &&
              (["done", "cancelled"].includes(t.fact.lifecycle) ||
                t.fact.minutes !== null)),
        ),
      observedAt: head.observedAt,
      tasks: [
        ...pending.map((c) => ({
          taskId: c.taskId,
          active: true,
          day: c.input.desiredDay,
          minutes: c.input.minutes ?? 0,
        })),
        ...tasks
          .filter((t) => t.sync !== "deleted")
          .map((t) => ({
            taskId: t.taskId,
            active: !["done", "cancelled"].includes(t.fact.lifecycle),
            day: t.fact.desiredDay,
            minutes: t.fact.minutes ?? 0,
          })),
      ],
    };
  }
  async create(
    input: Parameters<LearningTaskAdapter["create"]>[0],
    _signal: AbortSignal,
    p?: Principal,
  ): Promise<TaskCreationResult> {
    if (!p) throw new AppError("FORBIDDEN");
    new TaskCommands(this.db).reserve(
      input.operationId,
      input.taskId,
      {
        title: input.title,
        desiredDay: input.day,
        earliestDay: null,
        deadlineDay: null,
        timezone: input.timezone ?? "UTC",
        minutes: input.minutes,
        details: "",
      },
      p,
      {
        goalId: input.goalId,
        unitId: input.unitId,
        baselineId: input.baselineId,
      },
    );
    return { state: "unknown" };
  }
  async lookup(
    taskId: string,
    operationId: string,
  ): Promise<TaskCreationResult> {
    const c = new TaskCommands(this.db)
      .list()
      .find((c) => c.id === operationId && c.taskId === taskId);
    return c?.state === "created" && c.attributed
      ? { state: "created", taskId }
      : c?.state === "cancelled"
        ? { state: "not-created" }
        : { state: "unknown" };
  }
}
