import { randomUUID } from "node:crypto";
import {
  Instant,
  PlanningRequest,
  type PlanningSnapshot,
  type PlanningTask,
  type PlanningBlock,
} from "@kb/contracts";
import { observedTasks } from "../tasks/identity";
import { Reconciliation } from "../tasks/reconcile";
import { digest } from "../workspace/registry";
import { readBusy, type BusyProvider } from "../calendar/freebusy";
import { localDayStart, normalize, taskDeadline } from "./time";
import { AppError } from "../errors";

export async function planningSnapshot(
  db: Reconciliation,
  raw: unknown,
  policyVersion: number,
  epoch: number,
  provider?: BusyProvider,
): Promise<PlanningSnapshot> {
  const request = PlanningRequest.parse(raw);
  const evaluatedAt = db.now();
  const head = db.head();
  if (!head.complete || evaluatedAt - head.observedAt > 30000)
    throw new AppError("BASELINE", 409, "先在 TaskNotes 完成可靠清点。");
  const observed = observedTasks(db.store);
  const paths = new Map(observed.map((t) => [t.fact.path, t]));
  const tasks: PlanningTask[] = observed
    .filter(
      (t) =>
        !["done", "cancelled", "deleted"].includes(t.fact.lifecycle) &&
        t.sync !== "deleted",
    )
    .map((t) => {
      const spans: { start: number; end: number }[] = [];
      let validLogs = true,
        activeLog = false;
      for (const e of t.fact.timeEntries) {
        if (!e.endTime) {
          activeLog = true;
          continue;
        }
        const a = Date.parse(e.startTime),
          b = Date.parse(e.endTime);
        if (
          !Instant.safeParse(e.startTime).success ||
          !Instant.safeParse(e.endTime).success ||
          !Number.isFinite(a) ||
          !Number.isFinite(b) ||
          b < a
        )
          validLogs = false;
        else spans.push({ start: a, end: b });
      }
      const logged = normalize(spans).reduce(
        (total, span) => total + (span.end - span.start) / 60000,
        0,
      );
      return {
        id: t.taskId,
        revision: t.revision,
        path: t.fact.path,
        title: t.fact.title,
        minutes:
          t.fact.minutes === null || !validLogs
            ? null
            : Math.max(0, Math.ceil(t.fact.minutes - logged)),
        activeLog,
        remainingSource:
          t.fact.minutes === null || !validLogs
            ? ("未估计" as const)
            : ("TaskNotes 估计减已记录时长" as const),
        deadline: taskDeadline(t.fact.due, t.fact.timezone),
        deadlineInvalid:
          t.fact.due !== null &&
          taskDeadline(t.fact.due, t.fact.timezone) === null,
        location: t.fact.planLocation ?? null,
        device: t.fact.planDevice ?? null,
        priority: t.fact.planPriority ?? null,
        earliest: t.fact.earliestDay
          ? localDayStart(t.fact.earliestDay, t.fact.timezone)
          : null,
        desiredDay: t.fact.desiredDay,
        dependencies: t.fact.dependencies.map((p) => {
          const d = paths.get(p);
          return !d || d.sync !== "current"
            ? `missing:${p}`
            : d.fact.lifecycle === "done"
              ? `done:${d.taskId}`
              : d.taskId;
        }),
        lifecycle: t.fact.lifecycle,
        sync: t.sync,
      };
    });
  const basePlanId =
    (db.store.get("tasks.acceptedPlan") as string | undefined) ?? null;
  const old = basePlanId
    ? (db.store.db
        .prepare("SELECT value FROM task_plan_reads WHERE id=?")
        .get(basePlanId) as { value: string } | undefined)
    : undefined;
  const oldBlocks = old
    ? (
        JSON.parse(old.value) as {
          blocks: {
            id: string;
            taskId: string | null;
            kind: string;
            start: number;
            end: number;
            started: boolean;
            locked?: boolean;
            location?: string;
            device?: string;
          }[];
        }
      ).blocks
    : [];
  const previous: PlanningBlock[] = oldBlocks
    .filter((b) => b.taskId && b.kind === "flexible")
    .map((b) => ({
      ...b,
      taskId: b.taskId!,
      kind: "flexible",
      locked: b.locked ?? false,
    }));
  const starts = request.windows.map((w) => Date.parse(w.start)),
    ends = request.windows.map((w) => Date.parse(w.end));
  const { busy: calendarBusy, coverage } = await readBusy(
    provider,
    request.calendarIds,
    starts.length ? Math.min(...starts) : evaluatedAt,
    ends.length ? Math.max(...ends) : evaluatedAt,
    evaluatedAt,
  );
  const busy = [
    ...calendarBusy,
    ...oldBlocks
      .filter((b) => b.kind === "fixed")
      .map((b) => ({ start: b.start, end: b.end })),
  ];
  const core = {
    evaluatedAt,
    basePlanId,
    generation: head.generation,
    policyVersion,
    epoch,
    request,
    tasks,
    previous,
    busy,
    coverage,
  };
  return { id: randomUUID(), ...core, hash: digest(core) };
}
