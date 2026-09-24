import { randomUUID } from "node:crypto";
import type { TaskFact } from "@kb/contracts";
import { fixture } from "./helpers";
import { Proposals } from "../apps/service/src/review/proposals";
import { EvidenceStore } from "../apps/service/src/evidence/locator";
import { Reconciliation } from "../apps/service/src/tasks/reconcile";
export function fact(overrides: Partial<TaskFact> = {}): TaskFact {
  return {
    taskId: randomUUID(),
    operationId: null,
    path: "Tasks/example.md",
    title: "示例",
    status: "open",
    lifecycle: "todo",
    desiredDay: null,
    earliestDay: null,
    due: null,
    timezone: "Asia/Shanghai",
    minutes: 20,
    timeEntries: [],
    recurrence: null,
    completeInstances: [],
    skippedInstances: [],
    seriesPath: null,
    originalOccurrence: null,
    dependencies: [],
    contentHash: "a".repeat(64),
    ...overrides,
  };
}
export async function taskFixture() {
  const f = await fixture();
  const db = new Reconciliation(new Proposals(new EvidenceStore(f.registry)));
  const inventory = (
    facts: TaskFact[],
    complete = true,
    existingPaths = facts.map((f) => f.path),
  ) => {
    const { id } = db.begin(f.principal);
    for (let n = 0; n < facts.length; n += 20)
      db.add(id, facts.slice(n, n + 20), f.principal);
    return db.finish(
      id,
      { count: facts.length, complete, existingPaths },
      f.principal,
    );
  };
  return { ...f, db, inventory };
}
