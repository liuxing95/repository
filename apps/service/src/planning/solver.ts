import { randomUUID } from "node:crypto";
import type {
  PlanningBlock,
  PlanningCandidate,
  PlanningSnapshot,
  PlanningTask,
  TimeRange,
} from "@kb/contracts";
import { planDiff } from "./diff";
import { intersects, subtract } from "./time";

function rank(a: PlanningTask, b: PlanningTask) {
  return (
    (a.deadline ?? Infinity) - (b.deadline ?? Infinity) ||
    (b.priority ?? 0) - (a.priority ?? 0) ||
    (a.desiredDay ?? "9999").localeCompare(b.desiredDay ?? "9999") ||
    a.id.localeCompare(b.id)
  );
}
export function solve(
  snapshot: PlanningSnapshot,
  preferredBlocks = snapshot.previous,
): PlanningCandidate {
  const startedAt = performance.now();
  const { request, tasks, previous } = snapshot;
  const active = new Map(tasks.map((t) => [t.id, t]));
  const frozen = previous
    .filter(
      (b) =>
        b.end > snapshot.evaluatedAt &&
        (b.started ||
          b.locked ||
          b.start <
            snapshot.evaluatedAt + request.policy.freezeMinutes * 60000),
    )
    .filter((b) => active.has(b.taskId));
  const blocks: PlanningBlock[] = [...frozen];
  const frozenTasks = new Set(frozen.map((b) => b.taskId));
  const unscheduled: PlanningCandidate["unscheduled"] = [];
  const windows = request.windows
    .map((w) => ({
      start: Math.max(Date.parse(w.start), snapshot.evaluatedAt),
      end: Date.parse(w.end),
      location: w.location,
      device: w.device,
    }))
    .filter((w) => w.start < w.end)
    .sort((a, b) => a.start - b.start);
  const unavailable = [
    ...request.unavailable.map((w) => ({
      start: Date.parse(w.start),
      end: Date.parse(w.end),
    })),
    ...snapshot.busy,
  ];
  const old = new Map(preferredBlocks.map((b) => [b.taskId, b]));
  let nodes = 0,
    stopReason: string | null = null;
  const pending = tasks.filter((t) => !frozenTasks.has(t.id)).sort(rank);
  const rejected = new Set<string>();
  while (pending.length) {
    let progress = false;
    for (let i = 0; i < pending.length;) {
      const task = pending[i]!;
      const unknown = task.dependencies.find(
        (d) =>
          d.startsWith("missing:") ||
          (active.has(d) && active.get(d)!.sync !== "current"),
      );
      const waiting = task.dependencies.some(
        (d) =>
          active.has(d) &&
          !blocks.some((b) => b.taskId === d) &&
          !rejected.has(d),
      );
      if (waiting && !unknown) {
        i++;
        continue;
      }
      pending.splice(i, 1);
      progress = true;
      const blockedDependency = task.dependencies.find(
        (d) => d.startsWith("missing:") || rejected.has(d),
      );
      let reason = "";
      if (task.sync !== "current" || task.lifecycle === "unmapped")
        reason = "任务事实或身份未确认";
      else if (task.activeLog) reason = "任务正在计时，先核对当前工作";
      else if (task.minutes === null) reason = "需要补充剩余时长";
      else if (task.minutes <= 0) reason = "剩余时长为零，请核对任务状态";
      else if (task.deadlineInvalid)
        reason = "截止时间无法可靠解释，请在 TaskNotes 核对";
      else if (blockedDependency || unknown)
        reason = "前置任务缺失、未知或未排入";
      else if (!windows.length) reason = "需要填写可用时间";
      else if (snapshot.coverage.state === "unknown")
        reason = "外部日历覆盖未知";
      else if (task.lifecycle === "blocked") reason = "任务状态为阻塞";
      else if (
        stopReason ||
        performance.now() - startedAt >= (request.policy.maxMillis ?? 5000)
      ) {
        stopReason ??= "达到配置的求解耗时上限";
        reason = stopReason;
      }
      if (reason) {
        rejected.add(task.id);
        unscheduled.push({ taskId: task.id, reason });
        continue;
      }
      const length = task.minutes! * 60000;
      const dependencyEnd = Math.max(
        snapshot.evaluatedAt,
        ...task.dependencies.flatMap((d) =>
          blocks.filter((b) => b.taskId === d).map((b) => b.end),
        ),
      );
      const free = windows
        .filter(
          (w) =>
            (!task.location || w.location === task.location) &&
            (!task.device || w.device === task.device),
        )
        .flatMap((w) =>
          subtract([w], [...unavailable, ...blocks]).map((gap) => ({
            ...gap,
            location: w.location,
            device: w.device,
          })),
        );
      const preferred = old.get(task.id);
      const starts: number[] = [];
      if (preferred && !preferred.locked && !preferred.started)
        starts.push(preferred.start);
      for (const gap of free)
        starts.push(Math.max(gap.start, task.earliest ?? 0, dependencyEnd));
      let chosen: TimeRange | null = null;
      for (const start of starts) {
        if (
          performance.now() - startedAt >=
          (request.policy.maxMillis ?? 5000)
        ) {
          stopReason = "达到配置的求解耗时上限";
          break;
        }
        if (++nodes > request.policy.maxNodes) {
          stopReason = "达到配置的搜索节点上限";
          break;
        }
        const end = start + length;
        if (task.deadline !== null && end > task.deadline) continue;
        if (start < dependencyEnd || start < (task.earliest ?? 0)) continue;
        if (
          !windows.some(
            (w) =>
              start >= w.start &&
              end <= w.end &&
              (!task.location || w.location === task.location) &&
              (!task.device || w.device === task.device),
          )
        )
          continue;
        if (
          [...unavailable, ...blocks].some((b) => intersects({ start, end }, b))
        )
          continue;
        chosen = { start, end };
        break;
      }
      if (chosen)
        blocks.push({
          id:
            previous.find((b) => b.taskId === task.id)?.id ??
            preferred?.id ??
            randomUUID(),
          taskId: task.id,
          kind: "flexible",
          started: false,
          locked: false,
          ...chosen,
          ...(task.location ? { location: task.location } : {}),
          ...(task.device ? { device: task.device } : {}),
        });
      else {
        rejected.add(task.id);
        const hardGaps = windows
          .filter(
            (w) =>
              (!task.location || w.location === task.location) &&
              (!task.device || w.device === task.device),
          )
          .flatMap((w) => subtract([w], [...unavailable, ...frozen]));
        const provenImpossible =
          !stopReason &&
          !hardGaps.some((gap) => {
            const start = Math.max(gap.start, task.earliest ?? 0);
            return (
              start + length <= gap.end &&
              (task.deadline === null || start + length <= task.deadline)
            );
          });
        unscheduled.push({
          taskId: task.id,
          reason:
            stopReason ??
            (provenImpossible
              ? "硬条件证明当前时域不可行：没有足够长且在截止前的连续窗口"
              : "当前窗口未找到足够连续时间；未证明全局不可行"),
        });
      }
    }
    if (!progress) {
      for (const t of pending) {
        rejected.add(t.id);
        unscheduled.push({ taskId: t.id, reason: "前置任务形成环或无法确认" });
      }
      break;
    }
  }
  blocks.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const diff = planDiff(previous, blocks);
  const freeCapacity = windows.reduce(
    (sum, w) =>
      sum +
      subtract([w], [...unavailable, ...frozen]).reduce(
        (n, gap) => n + (gap.end - gap.start) / 60000,
        0,
      ),
    0,
  );
  const requiredCapacity = tasks
    .filter((t) => !frozenTasks.has(t.id))
    .reduce((sum, t) => sum + (t.minutes ?? 0), 0);
  const same = !diff.added.length && !diff.removed.length && !diff.moved.length;
  return {
    id: randomUUID(),
    snapshot,
    blocks,
    unscheduled,
    status: !windows.length
      ? "no-window"
      : same
        ? "no-op"
        : unscheduled.length
          ? "partial"
          : "complete",
    stopReason,
    capacityGapMinutes: Math.max(0, Math.ceil(requiredCapacity - freeCapacity)),
    diff,
  };
}
