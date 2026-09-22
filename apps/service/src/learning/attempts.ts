import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AttemptInput,
  EvaluationInput,
  Id,
  type LearningAttempt,
  type LearningEvaluation,
  type Principal,
} from "@kb/contracts";
import { LearningStore } from "./goals";
import { choice } from "./units";
import { AppError } from "../errors";
export class Attempts {
  constructor(readonly db: LearningStore) {}
  raw(id: string): LearningAttempt {
    const row = this.db.store.db
      .prepare("SELECT value FROM learning_attempts WHERE id=?")
      .get(id) as { value: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    return JSON.parse(row.value);
  }
  list(goalId: string, unitId?: string): LearningAttempt[] {
    return (
      this.db.store.db
        .prepare(
          "SELECT value FROM learning_attempts WHERE goal_id=? ORDER BY rowid",
        )
        .all(goalId) as { value: string }[]
    )
      .map((r) => JSON.parse(r.value) as LearningAttempt)
      .filter((a) => !unitId || a.unitId === unitId);
  }
  visible(a: LearningAttempt) {
    try {
      for (const ref of a.sourceRefs) this.db.evidence.read(ref.id);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      return {
        id: a.id,
        baselineId: a.baselineId,
        unitId: a.unitId,
        createdAt: a.createdAt,
        kind: a.kind,
        restricted: true as const,
        message: "关联资料不可读；原始尝试和评价暂不展示。",
      };
    }
    const evaluations = (
      this.db.store.db
        .prepare(
          "SELECT value FROM learning_evaluations WHERE attempt_id=? ORDER BY rowid",
        )
        .all(a.id) as { value: string }[]
    ).map((r) => JSON.parse(r.value) as LearningEvaluation);
    return {
      ...a,
      scope: this.db.baseline(a.baselineId).input.scope,
      restricted: false as const,
      evaluations,
    };
  }
  record(goalId: string, value: unknown, p: Principal) {
    const i = z
      .object({ operationId: Id, attempt: AttemptInput })
      .strict()
      .parse(value);
    const id = this.db.operation(
      "attempt",
      i.operationId,
      { goalId, ...i },
      p,
      () => {
        const g = this.db.goal(goalId),
          b = this.db.baseline(g.baselineId),
          u = this.db.unit(b, i.attempt.unitId);
        if (
          g.state !== "active" ||
          choice(this.db, g.id, u.id).state !== "selected"
        )
          throw new AppError("PAUSED");
        if (b.id !== i.attempt.baselineId) throw new AppError("BASELINE");
        const allowed = new Set([...u.necessary, ...u.optional]);
        if (i.attempt.evidenceIds.some((id) => !allowed.has(id)))
          throw new AppError("BASELINE");
        const sourceRefs = [
          ...new Set([...u.necessary, ...i.attempt.evidenceIds]),
        ].map((id) => {
          const e = this.db.evidence.read(id);
          return {
            id,
            sourceId: e.sourceId,
            revisionId: e.revisionId,
            scope: e.profile.scope,
          };
        });
        const a: LearningAttempt = {
          ...i.attempt,
          id: randomUUID(),
          goalId,
          actorId: p.id,
          createdAt: this.db.now(),
          sourceRefs,
        };
        this.db.store.db
          .prepare("INSERT INTO learning_attempts VALUES(?,?,?,?,?)")
          .run(a.id, goalId, u.id, b.id, JSON.stringify(a));
        this.db.store.event("learning.attempt.recorded", a.id, a.createdAt);
        return a.id;
      },
    );
    return this.visible(this.raw(id));
  }
  evaluate(id: string, value: unknown, p: Principal) {
    const i = z
      .object({ operationId: Id, evaluation: EvaluationInput })
      .strict()
      .parse(value);
    return this.db.operation("evaluation", i.operationId, { id, ...i }, p, () =>
      this.recordEvaluation(id, {
        ...i.evaluation,
        origin: "human",
        evaluator: p.id,
      }),
    );
  }
  // Only trusted service adapters call this; HTTP callers cannot impersonate a checker or model.
  recordEvaluation(
    id: string,
    input: Omit<LearningEvaluation, "id" | "attemptId" | "createdAt">,
  ) {
    const a = this.raw(id),
      b = this.db.baseline(a.baselineId),
      u = this.db.unit(b, a.unitId);
    const data = EvaluationInput.parse({
      criterionId: input.criterionId,
      outcome: input.outcome,
      rationale: input.rationale,
      ruleVersion: input.ruleVersion,
    });
    if (!u.criteria.some((c) => c.id === data.criterionId))
      throw new AppError("BASELINE");
    if (this.visible(a).restricted) throw new AppError("FORBIDDEN", 403);
    if (
      !input.evaluator ||
      !["human", "program", "model"].includes(input.origin) ||
      (input.origin === "model" && (!input.model || !input.promptVersion))
    )
      throw new AppError("VALIDATION");
    const e: LearningEvaluation = {
      ...input,
      ...data,
      id: randomUUID(),
      attemptId: id,
      createdAt: this.db.now(),
    };
    this.db.store.writable();
    this.db.store.db
      .prepare("INSERT INTO learning_evaluations VALUES(?,?,?)")
      .run(e.id, id, JSON.stringify(e));
    this.db.store.event("learning.evaluation.recorded", e.id, e.createdAt);
    return e.id;
  }
}
