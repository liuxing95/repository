import type { ProjectionReceipt } from "@kb/contracts";
import type { Store } from "../storage/store";
// Internal integration boundary for scene 08/09. No client can declare a projection applied.
export function projectionReceipts(
  store: Store,
  planId: string,
): ProjectionReceipt[] {
  return (
    store.db
      .prepare(
        "SELECT value FROM projection_receipts WHERE plan_id=? ORDER BY target",
      )
      .all(planId) as { value: string }[]
  ).map((r) => JSON.parse(r.value));
}
export function recordProjectionReceipt(store: Store, r: ProjectionReceipt) {
  store.db
    .prepare(
      "INSERT INTO projection_receipts VALUES(?,?,?) ON CONFLICT(plan_id,target) DO UPDATE SET value=excluded.value",
    )
    .run(r.planId, r.target, JSON.stringify(r));
}
