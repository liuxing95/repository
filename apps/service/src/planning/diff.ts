import type { PlanningBlock, PlanningCandidate } from "@kb/contracts";
export function planDiff(
  previous: PlanningBlock[],
  next: PlanningBlock[],
): PlanningCandidate["diff"] {
  const old = new Map(previous.map((b) => [b.id, b]));
  const current = new Map(next.map((b) => [b.id, b]));
  return {
    kept: next
      .filter(
        (b) => old.get(b.id)?.start === b.start && old.get(b.id)?.end === b.end,
      )
      .map((b) => b.taskId),
    moved: next
      .filter(
        (b) =>
          old.has(b.id) &&
          (old.get(b.id)!.start !== b.start || old.get(b.id)!.end !== b.end),
      )
      .map((b) => ({
        taskId: b.taskId,
        from: old.get(b.id)!.start,
        to: b.start,
        reason: "新任务、截止或可用时间约束改变",
      })),
    added: next.filter((b) => !old.has(b.id)).map((b) => b.taskId),
    removed: previous.filter((b) => !current.has(b.id)).map((b) => b.taskId),
  };
}
