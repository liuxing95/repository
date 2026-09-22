import { type LearningBaseline, type LearningEvaluation } from "@kb/contracts";
import { LearningStore } from "./goals";
import { Attempts } from "./attempts";
import { choice } from "./units";
export function evidenceView(db: LearningStore, b: LearningBaseline) {
  const service = new Attempts(db),
    attempts = service.list(b.goalId).filter((a) => a.baselineId === b.id);
  const readable = new Set(
    attempts.filter((a) => !service.visible(a).restricted).map((a) => a.id),
  );
  const ordered = (
    db.store.db
      .prepare(
        "SELECT e.value FROM learning_evaluations e JOIN learning_attempts a ON a.id=e.attempt_id WHERE a.baseline_id=? ORDER BY e.rowid",
      )
      .all(b.id) as { value: string }[]
  )
    .map((r) => JSON.parse(r.value) as LearningEvaluation)
    .filter((e) => readable.has(e.attemptId) && e.origin !== "model");
  const leaves = b.input.units.flatMap((u) =>
    u.criteria.map((c) => {
      const latest = ordered.filter((e) => e.criterionId === c.id).at(-1);
      return {
        ...c,
        unitId: u.id,
        choice: choice(db, b.goalId, u.id).state,
        outcome: latest?.outcome ?? "unverified",
        evaluationId: latest?.id ?? null,
        origin: latest?.origin ?? null,
      };
    }),
  );
  const totalWeight = leaves.reduce((sum, l) => sum + l.weight, 0),
    passedWeight = leaves
      .filter((l) => l.outcome === "passed")
      .reduce((sum, l) => sum + l.weight, 0);
  const previous = b.previousId ? db.baseline(b.previousId) : null;
  const previousLeaves =
    previous?.input.units.flatMap((u) => u.criteria.map((c) => c.id)) ?? [];
  return {
    baselineId: b.id,
    scope: b.input.scope,
    totalWeight,
    passedWeight,
    percentage: totalWeight ? (100 * passedWeight) / totalWeight : null,
    leaves,
    addedCriteria: previous
      ? leaves.filter((l) => !previousLeaves.includes(l.id)).map((l) => l.id)
      : [],
    previousId: b.previousId,
    attemptCount: attempts.length,
    explanation:
      "仅统计此固定基线的叶子验收证据。模型评分、自报、任务完成和用时不计通过；旧基线单独保留。",
  };
}
