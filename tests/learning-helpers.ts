import { randomUUID } from "node:crypto";
import { LearningGoalInput } from "@kb/contracts";
import { fixture } from "./helpers";
import { publish } from "./evidence-helpers";
import { EvidenceStore } from "../apps/service/src/evidence/locator";
import { SearchService } from "../apps/service/src/search/search";
import { Proposals } from "../apps/service/src/review/proposals";
import { LearningStore } from "../apps/service/src/learning/goals";
import { Attempts } from "../apps/service/src/learning/attempts";
import { choose } from "../apps/service/src/learning/units";
import { digest } from "../apps/service/src/workspace/registry";
export async function learningFixture() {
  let now = Date.now();
  const f = await fixture(() => now);
  const artifact = publish(
    f,
    "权限默认关闭。未经批准不能自动写入。",
    "学习材料",
    { version: "1" },
  );
  const evidence = new EvidenceStore(f.registry),
    search = new SearchService(evidence);
  const result = await search.search({ query: "权限" }, f.principal),
    ref = result.hits[0]!;
  const db = new LearningStore(new Proposals(evidence, () => now), () => now),
    attempts = new Attempts(db);
  const input = LearningGoalInput.parse({
    ability: "解释权限与写入边界",
    scope: { version: "1" },
    completionEvidence: "说明未批准时不会写入",
    units: [1, 2].map((n) => ({
      id: randomUUID(),
      title: `单元 ${n}`,
      necessary: [ref.id],
      criteria: [{ id: randomUUID(), description: `验收 ${n}`, weight: n }],
    })),
  });
  const b = db.confirm(
    { operationId: randomUUID(), input, digest: digest(input) },
    f.principal,
  );
  const select = (unitId = input.units[0]!.id) =>
    choose(db, b.goalId, unitId, { state: "selected", rank: 1 }, f.principal);
  const record = (unitId = input.units[0]!.id, baselineId = b.id) =>
    attempts.record(
      b.goalId,
      {
        operationId: randomUUID(),
        attempt: {
          baselineId,
          unitId,
          kind: "recall",
          expression: "我的理解：先批准再写入",
          hintLevel: 1,
          evidenceIds: [ref.id],
          selfReport: "我觉得理解了一半",
          unresolved: ["超时如何恢复？"],
          artifacts: ["manual-result.txt"],
        },
      },
      f.principal,
    );
  return {
    ...f,
    db,
    attempts,
    input,
    b,
    evidence,
    search,
    ref,
    artifact,
    select,
    record,
    advance: (ms: number) => {
      now += ms;
      f.store.set(`heartbeat:${f.principal.id}`, Date.now());
    },
  };
}
