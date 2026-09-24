import { randomUUID } from "node:crypto";
import type { PlanningCandidate, Principal } from "@kb/contracts";
import { AppError } from "../errors";
import { Reconciliation } from "../tasks/reconcile";
import { observedTasks } from "../tasks/identity";
import { TaskCommands } from "../tasks/commands";
import { readBusy, type BusyProvider } from "../calendar/freebusy";
import { digest } from "../workspace/registry";
import { validateCandidate } from "./validator";
import { ReminderRules } from "../reminders/rules";

export class PlanningLedger {
  constructor(
    readonly db: Reconciliation,
    readonly busyProvider?: BusyProvider,
  ) {}
  get store() {
    return this.db.store;
  }
  candidate(id: string): PlanningCandidate {
    const row = this.store.db
      .prepare("SELECT value FROM planning_candidates WHERE id=?")
      .get(id) as { value: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    return JSON.parse(row.value) as PlanningCandidate;
  }
  private sameTaskFacts(c: PlanningCandidate) {
    const current = observedTasks(this.store).filter(
      (t) =>
        !["done", "cancelled", "deleted"].includes(t.fact.lifecycle) &&
        t.sync !== "deleted",
    );
    const byId = new Map(current.map((t) => [t.taskId, t]));
    return (
      c.snapshot.tasks.length === current.length &&
      c.snapshot.tasks.every((t) => {
        const x = byId.get(t.id);
        return x?.revision === t.revision && x.sync === t.sync;
      })
    );
  }
  save(candidate: PlanningCandidate, p: Principal) {
    return this.store.tx(() => {
      this.db.guard.write(p);
      const head = this.db.head();
      if (
        !head.complete ||
        this.db.now() - head.observedAt > 30000 ||
        !this.sameTaskFacts(candidate) ||
        candidate.snapshot.basePlanId !==
          (this.store.get("tasks.acceptedPlan") ?? null)
      )
        throw new AppError("BASELINE");
      this.store.db
        .prepare("INSERT INTO planning_candidates VALUES(?,?)")
        .run(candidate.id, JSON.stringify(candidate));
      return candidate;
    });
  }
  private verify(c: PlanningCandidate, p: Principal) {
    this.db.guard.write(p);
    const s = c.snapshot,
      head = this.db.head();
    if (
      digest({
        evaluatedAt: s.evaluatedAt,
        basePlanId: s.basePlanId,
        generation: s.generation,
        policyVersion: s.policyVersion,
        epoch: s.epoch,
        request: s.request,
        tasks: s.tasks,
        previous: s.previous,
        busy: s.busy,
        coverage: s.coverage,
      }) !== s.hash
    )
      throw new AppError("HASH_MISMATCH");
    if (
      !head.complete ||
      this.db.now() - head.observedAt > 30000 ||
      s.basePlanId !== (this.store.get("tasks.acceptedPlan") ?? null) ||
      s.policyVersion !== p.policyVersion ||
      s.epoch !== p.epoch
    )
      throw new AppError("BASELINE");
    // A complete TaskNotes reread advances inventory generation even when all business facts stay identical.
    if (!this.sameTaskFacts(c)) throw new AppError("BASELINE");
    if (
      new TaskCommands(this.db)
        .list()
        .some((c) => c.state === "unknown" || c.state === "conflict")
    )
      throw new AppError(
        "CONFLICT",
        409,
        "先核对结果未知或冲突的 TaskNotes 创建命令。",
      );
    const issues = validateCandidate(c);
    if (issues.length) throw new AppError("VALIDATION", 400, issues[0]);
    if (c.status === "no-op" || c.status === "no-window")
      throw new AppError("VALIDATION", 400, "候选没有可采用的变化。");
  }
  async accept(id: string, p: Principal) {
    this.db.guard.write(p);
    const old = this.store.db
      .prepare("SELECT plan_id FROM plan_outbox WHERE id=?")
      .get(`adopt:${id}`) as { plan_id: string } | undefined;
    if (old) return { planId: old.plan_id, alreadyApplied: true };
    const c = this.candidate(id),
      s = c.snapshot;
    this.verify(c, p);
    if (s.coverage.state === "complete") {
      const starts = s.request.windows.map((w) => Date.parse(w.start)),
        ends = s.request.windows.map((w) => Date.parse(w.end));
      const fresh = await readBusy(
        this.busyProvider,
        s.request.calendarIds,
        Math.min(...starts),
        Math.max(...ends),
        this.db.now(),
      );
      if (
        fresh.coverage.state !== "complete" ||
        fresh.coverage.hash !== s.coverage.hash ||
        this.db.now() - fresh.coverage.checkedAt! > s.request.policy.freshnessMs
      )
        throw new AppError(
          "BASELINE",
          409,
          "日历忙闲已变化或覆盖不完整，请重新生成建议。",
        );
    }
    return this.store.tx(() => {
      const existing = this.store.db
        .prepare("SELECT plan_id FROM plan_outbox WHERE id=?")
        .get(`adopt:${id}`) as { plan_id: string } | undefined;
      if (existing) return { planId: existing.plan_id, alreadyApplied: true };
      this.verify(c, p);
      const planId = randomUUID(),
        acceptedAt = this.db.now();
      const value = {
        id: planId,
        candidateId: c.id,
        previousId: s.basePlanId,
        acceptedAt,
        blocks: c.blocks,
        taskRevisions: Object.fromEntries(
          s.tasks.map((t) => [t.id, t.revision]),
        ),
        unscheduled: c.unscheduled,
        coverage: s.coverage,
      };
      this.store.db
        .prepare("INSERT INTO plan_revisions VALUES(?,?,?,?,?)")
        .run(planId, s.basePlanId, c.id, acceptedAt, JSON.stringify(value));
      this.store.db
        .prepare("INSERT INTO plan_adoptions VALUES(?,?,?,?,?)")
        .run(randomUUID(), c.id, p.id, acceptedAt, "user");
      this.store.db
        .prepare("INSERT INTO task_plan_reads VALUES(?,?)")
        .run(planId, JSON.stringify(value));
      this.store.set("tasks.acceptedPlan", planId);
      this.store.db
        .prepare(
          "UPDATE plan_outbox SET state='stale' WHERE target='note' AND state='pending' AND plan_id<>?",
        )
        .run(planId);
      for (const target of ["note", "task", "calendar", "reminder"]) {
        const state = target === "note" ? "pending" : "disabled";
        this.store.db
          .prepare("INSERT INTO plan_outbox VALUES(?,?,?,?,?)")
          .run(
            `${target}:${planId}`,
            planId,
            target,
            state,
            JSON.stringify({ planId, target, blocks: c.blocks }),
          );
      }
      this.store.db
        .prepare("INSERT INTO plan_outbox VALUES(?,?,?,?,?)")
        .run(`adopt:${id}`, planId, "adoption", "applied", "{}");
      this.store.event("plan.accepted", planId, acceptedAt);
      new ReminderRules(this.store, this.db.now).sync();
      return { planId, alreadyApplied: false };
    });
  }
}
