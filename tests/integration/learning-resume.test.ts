import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Purpose, SourcePolicy } from "@kb/contracts";
import { learningFixture } from "../learning-helpers";
import { resume } from "../../apps/service/src/learning/resume";
import { evidenceView } from "../../apps/service/src/learning/evidence-view";
import { createServer } from "../../apps/service/src/http/server";
import { Connection } from "../../apps/obsidian-plugin/src/connection";
test("HTTP activity/resume preserves user's expression and hints; forbids forged checker provenance and rechecks withdrawal", async () => {
  const f = await learningFixture(),
    app = createServer(f.registry, f.sessions, f.jobs);
  const c = new Connection(
    async (url, opts) => {
      const r = await app.inject({
        method: opts.method as "POST",
        url: new URL(url).pathname,
        headers: { ...opts.headers, host: "127.0.0.1:27124" },
        payload: opts.body,
      });
      return { status: r.statusCode, json: r.json() };
    },
    f.registry.get().vaultPath,
    f.deviceId,
  );
  try {
    await c.pair(f.sessions.issuePairing());
    const unitId = f.input.units[0]!.id;
    const path = `/v1/learning/goals/${f.b.goalId}/units/${unitId}/resume`;
    expect((await c.request<{ firstStart: boolean }>(path)).firstStart).toBe(
      true,
    );
    f.select();
    const payload = {
      operationId: randomUUID(),
      attempt: {
        baselineId: f.b.id,
        unitId,
        kind: "explain",
        expression: "<script>我的表达</script>",
        hintLevel: 2,
        selfReport: "成功",
        unresolved: ["还有一个条件没理解"],
      },
    };
    const a = await c.request<{ id: string }>(
      `/v1/learning/goals/${f.b.goalId}/attempts`,
      "POST",
      payload,
    );
    expect(
      (
        await c.request<{ id: string }>(
          `/v1/learning/goals/${f.b.goalId}/attempts`,
          "POST",
          payload,
        )
      ).id,
    ).toBe(a.id);
    const view = resume(f.db, f.b.goalId, unitId, f.principal);
    expect(view.latestAttempt).toMatchObject({
      expression: payload.attempt.expression,
      hintLevel: 2,
      unresolved: ["还有一个条件没理解"],
      restricted: false,
    });
    expect(view.progress.passedWeight).toBe(0);
    await expect(
      c.request(`/v1/learning/attempts/${a.id}/evaluations`, "POST", {
        operationId: randomUUID(),
        evaluation: {
          criterionId: f.input.units[0]!.criteria[0]!.id,
          origin: "program",
          outcome: "passed",
          rationale: "假程序",
          ruleVersion: "1",
        },
      }),
    ).rejects.toThrow();
    f.store.set(
      `source:${f.ref.sourceId}`,
      SourcePolicy.parse({
        sourceId: f.ref.sourceId,
        retracted: true,
        routes: Object.fromEntries(Purpose.options.map((p) => [p, []])),
      }),
    );
    const redacted = await c.request(path);
    expect(JSON.stringify(redacted)).not.toContain("<script>");
    expect(JSON.stringify(redacted)).not.toContain("还有一个条件没理解");
    expect(JSON.stringify(redacted)).not.toContain(f.ref.text);
    expect(
      resume(f.db, f.b.goalId, unitId, f.principal).latestAttempt,
    ).toMatchObject({ id: a.id, restricted: true });
  } finally {
    await app.close();
    await f.close();
  }
});
test("self reports and model scores never pass criteria; trusted program and human evaluations remain separate", async () => {
  const f = await learningFixture();
  try {
    f.select();
    const a = f.record(),
      criterionId = f.input.units[0]!.criteria[0]!.id;
    const e = {
      criterionId,
      outcome: "passed" as const,
      rationale: "评分依据",
      ruleVersion: "rubric-1",
      origin: "model" as const,
      evaluator: "trusted-test",
    };
    expect(() => f.attempts.recordEvaluation(a.id, e)).toThrow("VALIDATION");
    f.attempts.recordEvaluation(a.id, {
      ...e,
      model: "test-only",
      promptVersion: "p1",
    });
    expect(evidenceView(f.db, f.b).passedWeight).toBe(0);
    f.attempts.recordEvaluation(a.id, {
      ...e,
      origin: "program",
      evaluator: "fixture-checker-v1",
    });
    expect(evidenceView(f.db, f.b).passedWeight).toBe(1);
    const read = f.attempts.visible(f.attempts.raw(a.id));
    expect(!read.restricted && read.evaluations.map((e) => e.origin)).toEqual([
      "model",
      "program",
    ]);
    f.db.setState(f.b.goalId, "paused", f.principal);
    expect(() => f.record()).toThrow("PAUSED");
  } finally {
    await f.close();
  }
});

test("latest stored human correction wins even when two attempts and evaluations share a clock tick", async () => {
  const f = await learningFixture();
  try {
    f.select();
    const first = f.record(),
      second = f.record();
    const e = {
      criterionId: f.input.units[0]!.criteria[0]!.id,
      rationale: "逐项人工复核",
      ruleVersion: "r1",
      origin: "human" as const,
      evaluator: f.principal.id,
    };
    f.attempts.recordEvaluation(second.id, { ...e, outcome: "passed" });
    f.attempts.recordEvaluation(first.id, { ...e, outcome: "failed" });
    expect(evidenceView(f.db, f.b).passedWeight).toBe(0);
  } finally {
    await f.close();
  }
});
