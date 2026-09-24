import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { learningFixture } from "../learning-helpers";
import { publish } from "../evidence-helpers";
import { evidenceView } from "../../apps/service/src/learning/evidence-view";
import { choose } from "../../apps/service/src/learning/units";
import { digest } from "../../apps/service/src/workspace/registry";
test("100 archived pages do not generate units, attempts, tasks or mastery; skip never shrinks weighted denominator", async () => {
  const f = await learningFixture();
  try {
    for (let n = 0; n < 100; n++) publish(f, `资料归档 ${n}`);
    expect(f.db.baseline(f.b.id).input.units).toHaveLength(2);
    expect(evidenceView(f.db, f.b)).toMatchObject({
      totalWeight: 3,
      passedWeight: 0,
      attemptCount: 0,
    });
    for (const table of [
      "learning_attempts",
      "learning_task_intents",
      "learning_suggestions",
    ])
      expect(
        f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get(),
      ).toEqual({ n: 0 });
    f.select();
    const a = f.record();
    expect(evidenceView(f.db, f.b).passedWeight).toBe(0);
    f.attempts.evaluate(
      a.id,
      {
        operationId: randomUUID(),
        evaluation: {
          criterionId: f.input.units[0]!.criteria[0]!.id,
          outcome: "passed",
          rationale: "人工逐项核对原始尝试和产物",
          ruleVersion: "manual-v1",
        },
      },
      f.principal,
    );
    choose(
      f.db,
      f.b.goalId,
      f.input.units[1]!.id,
      { state: "cancelled", rank: 2 },
      f.principal,
    );
    expect(evidenceView(f.db, f.b)).toMatchObject({
      totalWeight: 3,
      passedWeight: 1,
    });
    const removed = { ...f.input, units: f.input.units.slice(0, 1) };
    expect(() =>
      f.db.confirm(
        {
          operationId: randomUUID(),
          goalId: f.b.goalId,
          previousId: f.b.id,
          input: removed,
          digest: digest(removed),
        },
        f.principal,
      ),
    ).toThrow("BASELINE");
  } finally {
    await f.close();
  }
});
test("baseline confirmation is digest-bound and idempotent; an unweighted activity has no fake percentage", async () => {
  const f = await learningFixture();
  try {
    const input = {
        ...f.input,
        units: f.input.units.map((u) => ({ ...u, criteria: [] })),
      },
      operationId = randomUUID();
    expect(() =>
      f.db.confirm({ operationId, input, digest: "0".repeat(64) }, f.principal),
    ).toThrow("BASELINE");
    const request = { operationId, input, digest: digest(input) },
      b = f.db.confirm(request, f.principal);
    expect(f.db.confirm(request, f.principal).id).toBe(b.id);
    expect(evidenceView(f.db, b).percentage).toBeNull();
    expect(() =>
      f.db.confirm(
        {
          ...request,
          input: { ...input, ability: "another" },
          digest: digest({ ...input, ability: "another" }),
        },
        f.principal,
      ),
    ).toThrow("CONFLICT");
  } finally {
    await f.close();
  }
});
