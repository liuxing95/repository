import { UnitChoice, type Principal } from "@kb/contracts";
import { LearningStore } from "./goals";
export function choice(
  db: LearningStore,
  goalId: string,
  unitId: string,
): UnitChoice {
  const row = db.store.db
    .prepare("SELECT value FROM learning_choices WHERE goal_id=? AND unit_id=?")
    .get(goalId, unitId) as { value: string } | undefined;
  return row
    ? UnitChoice.parse(JSON.parse(row.value))
    : { state: "reference", rank: 0, reason: "" };
}
export function choose(
  db: LearningStore,
  goalId: string,
  unitId: string,
  value: unknown,
  p: Principal,
) {
  db.write(p);
  db.unit(db.baseline(db.goal(goalId).baselineId), unitId);
  const c = UnitChoice.parse(value);
  db.store.db
    .prepare(
      "INSERT INTO learning_choices VALUES(?,?,?) ON CONFLICT(goal_id,unit_id) DO UPDATE SET value=excluded.value",
    )
    .run(goalId, unitId, JSON.stringify(c));
  db.store.event("learning.unit.choice", unitId, db.now());
  return c;
}
