import type { PlanningCandidate, PlanningBlock } from "@kb/contracts";
import { intersects } from "./time";

// Separate from solver: adoption calls this again against the stored candidate.
export function validateCandidate(c: PlanningCandidate): string[] {
  const s = c.snapshot,
    issues: string[] = [];
  const tasks = new Map(s.tasks.map((t) => [t.id, t]));
  const ids = new Set<string>();
  const windows = s.request.windows.map((w) => ({
    start: Date.parse(w.start),
    end: Date.parse(w.end),
    location: w.location,
    device: w.device,
  }));
  const blocked = [
    ...s.busy,
    ...s.request.unavailable.map((w) => ({
      start: Date.parse(w.start),
      end: Date.parse(w.end),
    })),
  ];
  if (s.coverage.state === "unknown") issues.push("外部日历覆盖未知");
  for (const b of c.blocks) {
    const task = tasks.get(b.taskId);
    if (
      !task ||
      task.sync !== "current" ||
      task.lifecycle === "unmapped" ||
      task.activeLog ||
      task.minutes === null ||
      task.minutes <= 0 ||
      task.deadlineInvalid
    ) {
      issues.push(`任务 ${b.taskId} 不可排`);
      continue;
    }
    if (ids.has(b.id)) issues.push(`重复块 ${b.id}`);
    ids.add(b.id);
    if (
      !Number.isSafeInteger(b.start) ||
      !Number.isSafeInteger(b.end) ||
      b.start >= b.end ||
      b.end - b.start !== task.minutes * 60000
    )
      issues.push(`时长不符 ${b.taskId}`);
    if (task.deadline !== null && b.end > task.deadline)
      issues.push(`超过截止 ${b.taskId}`);
    if (task.earliest !== null && b.start < task.earliest)
      issues.push(`早于允许日期 ${b.taskId}`);
    const window = windows.find(
      (w) =>
        b.start >= w.start &&
        b.end <= w.end &&
        (!task.location || w.location === task.location) &&
        (!task.device || w.device === task.device) &&
        (!b.location || w.location === b.location) &&
        (!b.device || w.device === b.device),
    );
    if (
      !window ||
      (b.location && b.location !== window.location) ||
      (b.device && b.device !== window.device) ||
      (task.location &&
        (task.location !== b.location || task.location !== window?.location)) ||
      (task.device &&
        (task.device !== b.device || task.device !== window?.device))
    )
      issues.push(`可用窗口或资源不符 ${b.taskId}`);
    if (blocked.some((v) => intersects(b, v)))
      issues.push(`不可用时间冲突 ${b.taskId}`);
    for (const d of task.dependencies) {
      if (d.startsWith("missing:")) issues.push(`缺失前置 ${b.taskId}`);
      const before = c.blocks.find((x) => x.taskId === d);
      if (tasks.has(d) && (!before || before.end > b.start))
        issues.push(`前置顺序不符 ${b.taskId}`);
    }
  }
  for (let i = 0; i < c.blocks.length; i++)
    for (let j = i + 1; j < c.blocks.length; j++) {
      const a = c.blocks[i]!,
        b = c.blocks[j]!;
      if (intersects(a, b)) issues.push(`时间重叠 ${a.id} ${b.id}`);
      if (a.taskId === b.taskId)
        issues.push(`任务重复或未授权拆分 ${a.taskId}`);
    }
  for (const old of s.previous.filter(
    (b) =>
      b.end > s.evaluatedAt &&
      (b.started ||
        b.locked ||
        b.start < s.evaluatedAt + s.request.policy.freezeMinutes * 60000),
  )) {
    if (!tasks.has(old.taskId)) continue;
    const same = c.blocks.find((b) => b.id === old.id);
    if (!same || same.start !== old.start || same.end !== old.end)
      issues.push(`冻结块变化 ${old.id}`);
  }
  const all = new Set([
    ...c.blocks.map((b: PlanningBlock) => b.taskId),
    ...c.unscheduled.map((u) => u.taskId),
  ]);
  for (const t of s.tasks) if (!all.has(t.id)) issues.push(`遗漏任务 ${t.id}`);
  return issues;
}
