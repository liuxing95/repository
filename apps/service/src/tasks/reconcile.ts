import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Id,
  TaskFact,
  TaskPath,
  type Principal,
  type ObservedTask,
  type TaskCommand,
} from "@kb/contracts";
import { Proposals } from "../review/proposals";
import { AppError } from "../errors";
import { ReminderRules } from "../reminders/rules";
import {
  observedTasks,
  saveObservation,
  taskRevision,
  occurrenceKey,
} from "./identity";
export type InventoryHead = {
  generation: number;
  observedAt: number;
  complete: boolean;
  unmanaged: TaskFact[];
};
export class Reconciliation {
  constructor(
    readonly guard: Proposals,
    readonly now = Date.now,
  ) {}
  get store() {
    return this.guard.store;
  }
  head(): InventoryHead {
    return (
      (this.store.get("tasks.inventory") as InventoryHead) ?? {
        generation: 0,
        observedAt: 0,
        complete: false,
        unmanaged: [],
      }
    );
  }
  begin(p: Principal) {
    this.guard.write(p);
    const id = randomUUID();
    this.store.db
      .prepare("INSERT INTO task_inventories VALUES(?,?,?,?,?)")
      .run(
        id,
        p.id,
        this.head().generation,
        this.now(),
        JSON.stringify({ epoch: p.epoch, policyVersion: p.policyVersion }),
      );
    return { id };
  }
  private inventory(id: string, p: Principal) {
    this.guard.write(p);
    const r = this.store.db
      .prepare("SELECT * FROM task_inventories WHERE id=?")
      .get(Id.parse(id)) as
      | {
          actor_id: string;
          base_generation: number;
          started_at: number;
          value: string;
        }
      | undefined;
    if (!r || r.actor_id !== p.id) throw new AppError("NOT_FOUND", 404);
    const v = JSON.parse(r.value);
    if (
      v.epoch !== p.epoch ||
      v.policyVersion !== p.policyVersion ||
      r.base_generation !== this.head().generation ||
      this.now() - r.started_at > 60000
    )
      throw new AppError("BASELINE");
    return r;
  }
  add(id: string, raw: unknown, p: Principal) {
    const facts = z.array(TaskFact).max(20).parse(raw);
    return this.store.tx(() => {
      this.inventory(id, p);
      for (const f of facts)
        this.store.db
          .prepare(
            "INSERT INTO task_inventory_items VALUES(?,?,?) ON CONFLICT(inventory_id,path) DO UPDATE SET value=excluded.value",
          )
          .run(id, f.path, JSON.stringify(f));
      const count = (
        this.store.db
          .prepare(
            "SELECT count(*) AS n FROM task_inventory_items WHERE inventory_id=?",
          )
          .get(id) as { n: number }
      ).n;
      if (count > 10000) throw new AppError("VALIDATION", 400);
      return { count };
    });
  }
  event(raw: unknown, p: Principal) {
    this.guard.write(p);
    const i = z
      .object({ id: Id, kind: z.enum(["task", "vault", "reconnect"]) })
      .strict()
      .parse(raw);
    this.store.db
      .prepare("INSERT OR IGNORE INTO task_event_inbox VALUES(?,?,?,?,NULL)")
      .run(i.id, p.id, i.kind, this.now());
    return { recorded: true };
  }
  finish(id: string, raw: unknown, p: Principal) {
    const i = z
      .object({
        count: z.number().int().min(0).max(10000),
        complete: z.boolean(),
        existingPaths: z.array(TaskPath).max(20000),
      })
      .strict()
      .parse(raw);
    return this.store.tx(() => {
      const run = this.inventory(id, p);
      const facts = (
        this.store.db
          .prepare(
            "SELECT value FROM task_inventory_items WHERE inventory_id=? ORDER BY path",
          )
          .all(id) as { value: string }[]
      ).map((r) => TaskFact.parse(JSON.parse(r.value)));
      if (facts.length !== i.count) throw new AppError("BASELINE");
      if (!i.complete) {
        this.store.set("tasks.inventory", { ...this.head(), complete: false });
        return { complete: false };
      }
      const groups = new Map<string, TaskFact[]>();
      for (const f of facts)
        if (f.taskId)
          groups.set(f.taskId, [...(groups.get(f.taskId) ?? []), f]);
      const old = new Map(observedTasks(this.store).map((t) => [t.taskId, t]));
      for (const [taskId, fs] of groups) {
        const previous = old.get(taskId),
          f = fs[0]!,
          revision = taskRevision(f);
        const sync =
          previous?.sync === "deleted"
            ? "deleted"
            : fs.length > 1
              ? "conflict"
              : "current";
        const task: ObservedTask = {
          taskId,
          fact: f,
          revision,
          observedAt: this.now(),
          sync,
          paths: fs.map((f) => f.path),
        };
        saveObservation(this.store, task);
        old.delete(taskId);
        if (sync !== "current" || previous?.revision === revision) continue;
        this.store.event("task.observed", taskId, this.now());
        if (
          ["done", "cancelled"].includes(f.lifecycle) ||
          (previous &&
            (previous.fact.desiredDay !== f.desiredDay ||
              previous.fact.due !== f.due ||
              previous.fact.minutes !== f.minutes))
        )
          this.invalidate(task, "facts-changed");
      }
      for (const t of old.values()) {
        if (t.sync === "deleted") continue;
        t.sync = t.paths.some((path) => i.existingPaths.includes(path))
          ? "unknown"
          : "deleted";
        t.observedAt = this.now();
        saveObservation(this.store, t);
        if (t.sync === "deleted") this.invalidate(t, "deleted");
      }
      const byPath = new Map(
        observedTasks(this.store)
          .filter((t) => t.sync === "current")
          .map((t) => [t.fact.path, t]),
      );
      for (const task of byPath.values()) {
        if (task.sync !== "current") continue;
        if (!task.fact.seriesPath || !task.fact.originalOccurrence) continue;
        const series = byPath.get(task.fact.seriesPath);
        if (!series) {
          task.sync = "unknown";
          saveObservation(this.store, task);
          continue;
        }
        const key = occurrenceKey(
          series.taskId,
          task.fact.originalOccurrence,
          series.fact.timezone,
        );
        const old = this.store.db
          .prepare(
            "SELECT task_id FROM task_occurrences WHERE occurrence_key=?",
          )
          .get(key) as { task_id: string } | undefined;
        if (old && old.task_id !== task.taskId) {
          task.sync = "conflict";
          const previous = [...byPath.values()].find(
            (t) => t.taskId === old.task_id,
          );
          if (previous) {
            previous.sync = "conflict";
            saveObservation(this.store, previous);
          }
        } else {
          this.store.db
            .prepare(
              "INSERT OR IGNORE INTO task_occurrences VALUES(?,?,?,?,?,?)",
            )
            .run(
              key,
              series.taskId,
              task.fact.originalOccurrence,
              series.fact.timezone,
              task.taskId,
              series.revision,
            );
          task.occurrenceKey = key;
        }
        saveObservation(this.store, task);
      }
      const currentById = new Map(
        observedTasks(this.store).map((t) => [t.taskId, t]),
      );
      for (const r of this.store.db
        .prepare("SELECT value FROM task_commands")
        .all() as { value: string }[]) {
        const c = JSON.parse(r.value) as TaskCommand;
        if (["cancelled", "created", "conflict"].includes(c.state)) continue;
        const matched = facts.filter(
          (f) => f.operationId === c.id || f.taskId === c.taskId,
        );
        if (!matched.length) continue;
        c.state =
          matched.length === 1 &&
          matched[0]!.taskId === c.taskId &&
          matched[0]!.operationId === c.id &&
          currentById.get(c.taskId)?.sync === "current"
            ? "created"
            : "conflict";
        c.attributed = c.state === "created";
        this.store.db
          .prepare("UPDATE task_commands SET value=? WHERE id=?")
          .run(JSON.stringify(c), c.id);
      }
      this.store.set("tasks.inventory", {
        generation: this.head().generation + 1,
        observedAt: this.now(),
        complete: true,
        unmanaged: facts.filter((f) => !f.taskId),
      } satisfies InventoryHead);
      new ReminderRules(this.store, this.now).sync();
      // Only events preceding inventory start are covered by this boundary.
      this.store.db
        .prepare(
          "UPDATE task_event_inbox SET processed_at=? WHERE processed_at IS NULL AND received_at<?",
        )
        .run(this.now(), run.started_at);
      this.store.db
        .prepare("DELETE FROM task_inventory_items WHERE inventory_id=?")
        .run(id);
      this.store.db.prepare("DELETE FROM task_inventories WHERE id=?").run(id);
      return { complete: true, generation: this.head().generation };
    });
  }
  private invalidate(t: ObservedTask, reason: string) {
    const id = randomUUID();
    const revision = `${t.revision}:${t.sync}:${reason}:${this.head().generation}`;
    const result = this.store.db
      .prepare("INSERT OR IGNORE INTO task_invalidations VALUES(?,?,?,?,?)")
      .run(id, t.taskId, revision, this.now(), reason);
    if (result.changes)
      this.store.db
        .prepare("INSERT INTO task_cancel_outbox VALUES(?,?)")
        .run(id, "pending");
  }
}
