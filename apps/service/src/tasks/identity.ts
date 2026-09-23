import type { ObservedTask, TaskFact } from "@kb/contracts";
import { digest } from "../workspace/registry";
import type { Store } from "../storage/store";
export function taskRevision(f: TaskFact) {
  const business: Partial<TaskFact> = { ...f };
  delete business.path;
  delete business.contentHash;
  return digest(business);
}
export function observedTasks(store: Store): ObservedTask[] {
  return (
    store.db
      .prepare("SELECT value FROM task_observations ORDER BY task_id")
      .all() as { value: string }[]
  ).map((r) => JSON.parse(r.value));
}
export function saveObservation(store: Store, value: ObservedTask) {
  store.db
    .prepare("INSERT OR IGNORE INTO task_observation_history VALUES(?,?,?)")
    .run(value.taskId, value.revision, JSON.stringify(value));
  store.db
    .prepare(
      "INSERT INTO task_observations VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET value=excluded.value",
    )
    .run(value.taskId, JSON.stringify(value));
}
// Original occurrence identity is independent of scheduled/due changes. Do not expand RRULE here.
export function occurrenceKey(
  seriesId: string,
  original: string,
  timezone: string,
) {
  return digest({ seriesId, original, timezone });
}
export function dependencyCycles(tasks: ObservedTask[]) {
  const paths = new Map(tasks.map((t) => [t.fact.path, t.taskId]));
  const edges = new Map(
    tasks.map((t) => [
      t.taskId,
      t.fact.dependencies
        .map((p) => paths.get(p))
        .filter((v): v is string => !!v),
    ]),
  );
  const incoming = new Map([...edges.keys()].map((id) => [id, 0]));
  for (const dependencies of edges.values())
    for (const id of dependencies)
      incoming.set(id, (incoming.get(id) ?? 0) + 1);
  const ready = [...incoming.keys()].filter((id) => incoming.get(id) === 0);
  for (let i = 0; i < ready.length; i++)
    for (const id of edges.get(ready[i]!) ?? []) {
      incoming.set(id, incoming.get(id)! - 1);
      if (incoming.get(id) === 0) ready.push(id);
    }
  return [...incoming.keys()].filter((id) => incoming.get(id)! > 0);
}
