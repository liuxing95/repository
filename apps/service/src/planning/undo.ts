import { randomUUID } from "node:crypto";
import type {
  PlanningCandidate,
  PlanningBlock,
  Principal,
} from "@kb/contracts";
import { AppError } from "../errors";
import { planDiff } from "./diff";
import { solve } from "./solver";
import { planningSnapshot } from "./snapshot";
import { PlanningLedger } from "./accept";

export async function undoCandidate(
  ledger: PlanningLedger,
  p: Principal,
  requestOverride?: unknown,
): Promise<PlanningCandidate> {
  ledger.db.guard.write(p);
  const currentId = ledger.store.get("tasks.acceptedPlan") as
    string | undefined;
  if (!currentId) throw new AppError("NOT_FOUND", 404);
  const current = ledger.store.db
    .prepare("SELECT previous_id,candidate_id FROM plan_revisions WHERE id=?")
    .get(currentId) as
    { previous_id: string | null; candidate_id: string } | undefined;
  if (!current) throw new AppError("BASELINE");
  const previous = current.previous_id
    ? (ledger.store.db
        .prepare("SELECT value FROM plan_revisions WHERE id=?")
        .get(current.previous_id) as { value: string } | undefined)
    : undefined;
  const target = previous
    ? (JSON.parse(previous.value) as { blocks: PlanningBlock[] }).blocks
    : [];
  const request =
    requestOverride ?? ledger.candidate(current.candidate_id).snapshot.request;
  const snapshot = await planningSnapshot(
    ledger.db,
    request,
    p.policyVersion,
    p.epoch,
    ledger.busyProvider,
  );
  if (snapshot.basePlanId !== currentId) throw new AppError("BASELINE");
  let result: PlanningCandidate;
  if (target.length) result = solve(snapshot, target);
  else {
    const frozen = snapshot.previous.filter(
      (b) =>
        b.end > snapshot.evaluatedAt &&
        (b.started ||
          b.locked ||
          b.start <
            snapshot.evaluatedAt +
              snapshot.request.policy.freezeMinutes * 60000),
    );
    const diff = planDiff(snapshot.previous, frozen);
    result = {
      id: randomUUID(),
      snapshot,
      blocks: frozen,
      unscheduled: snapshot.tasks
        .filter((t) => !frozen.some((b) => b.taskId === t.id))
        .map((t) => ({ taskId: t.id, reason: "撤销后转为未排；任务事实保留" })),
      status: diff.removed.length ? "partial" : "no-op",
      stopReason: null,
      capacityGapMinutes: 0,
      diff,
    };
  }
  return ledger.save(result, p);
}
