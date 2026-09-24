import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { learningFixture } from "../learning-helpers";
import { evidenceView } from "../../apps/service/src/learning/evidence-view";
import { resume } from "../../apps/service/src/learning/resume";
import { sourceImpact } from "../../apps/service/src/learning/impact";
import { Suggestions } from "../../apps/service/src/learning/review-suggestions";
import { digest } from "../../apps/service/src/workspace/registry";
import { publish } from "../evidence-helpers";
test("a new target baseline shows added scope and retains old-version passed evidence; source change alone does not create tasks", async () => {
  const f = await learningFixture();
  try {
    f.select();
    const a = f.record();
    f.attempts.recordEvaluation(a.id, {
      criterionId: f.input.units[0]!.criteria[0]!.id,
      outcome: "passed",
      rationale: "核对原版本产物",
      ruleVersion: "r1",
      origin: "program",
      evaluator: "test-checker",
    });
    const input = {
      ...f.input,
      scope: { ...f.input.scope, version: "2" },
      units: [
        ...f.input.units,
        {
          ...f.input.units[0]!,
          id: randomUUID(),
          title: "新版本差异",
          criteria: [{ id: randomUUID(), description: "新验收项", weight: 3 }],
        },
      ],
    };
    const b = f.db.confirm(
      {
        operationId: randomUUID(),
        goalId: f.b.goalId,
        previousId: f.b.id,
        input,
        digest: digest(input),
      },
      f.principal,
    );
    expect(evidenceView(f.db, f.b)).toMatchObject({
      totalWeight: 3,
      passedWeight: 1,
    });
    expect(evidenceView(f.db, b)).toMatchObject({
      totalWeight: 6,
      passedWeight: 0,
      addedCriteria: [input.units[2]!.criteria[0]!.id],
    });
    expect(
      resume(f.db, f.b.goalId, f.input.units[0]!.id, f.principal).latestAttempt,
    ).toMatchObject({
      baselineId: f.b.id,
      scope: { version: "1" },
      expression: "我的理解：先批准再写入",
    });
    // Register a genuine second committed parse, then associate its source identity to
    // emulate a committed upstream revision without fetching a live server.
    const newer = publish(f, "权限新版改变了批准后的恢复步骤。", "新版本", {
      version: "2",
    });
    const revision = f.evidence.revision(newer.revisionId);
    f.store.db
      .prepare("UPDATE source_revisions SET source_id=?,value=? WHERE id=?")
      .run(
        f.ref.sourceId,
        JSON.stringify({ ...revision, sourceId: f.ref.sourceId }),
        revision.id,
      );
    const oldImpact = sourceImpact(f.db, f.b, f.input.units[0]!.id),
      newImpact = sourceImpact(f.db, b, f.input.units[0]!.id);
    expect(oldImpact[0]).toMatchObject({
      changed: true,
      supplementCandidate: false,
    });
    expect(newImpact[0]).toMatchObject({
      changed: true,
      supplementCandidate: true,
    });
    f.db.configure(
      {
        capacity: null,
        review: { intervalDays: 1, windowDays: 3, minutes: 20 },
      },
      f.principal,
    );
    const s = new Suggestions(f.db),
      candidate = s.supplement(
        b.goalId,
        f.input.units[0]!.id,
        "目标已升级，需核对恢复步骤差异",
        f.principal,
      );
    expect(
      s.supplement(b.goalId, f.input.units[0]!.id, "重复确认", f.principal).id,
    ).toBe(candidate.id);
    expect(
      f.store.db.prepare("SELECT count(*) n FROM learning_task_intents").get(),
    ).toEqual({ n: 0 });
    expect(evidenceView(f.db, f.b).passedWeight).toBe(1);
  } finally {
    await f.close();
  }
});
