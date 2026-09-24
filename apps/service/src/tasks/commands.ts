import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Id, TaskDraft, type Principal, type TaskCommand } from "@kb/contracts";
import { digest } from "../workspace/registry";
import { AppError } from "../errors";
import { Reconciliation } from "./reconcile";
import { LearningStore } from "../learning/goals";
import { Suggestions } from "../learning/review-suggestions";
import { choice } from "../learning/units";
export class TaskCommands {
  constructor(readonly reconciliation: Reconciliation) {}
  get store() {
    return this.reconciliation.store;
  }
  list(): TaskCommand[] {
    return (
      this.store.db
        .prepare(
          "SELECT value FROM task_commands ORDER BY rowid DESC LIMIT 10000",
        )
        .all() as { value: string }[]
    ).map((r) => JSON.parse(r.value));
  }
  enqueue(raw: unknown, p: Principal) {
    this.reconciliation.guard.write(p);
    const i = z
      .object({ operationId: Id, input: TaskDraft })
      .strict()
      .parse(raw);
    return this.reserve(i.operationId, randomUUID(), i.input, p);
  }
  reserve(
    id: string,
    taskId: string,
    input: TaskDraft,
    p: Principal,
    learning?: TaskCommand["learning"],
  ) {
    return this.store.tx(() => {
      this.reconciliation.guard.write(p);
      const hash = digest({ input, learning: learning ?? null });
      const row = this.store.db
        .prepare("SELECT value FROM task_commands WHERE id=?")
        .get(id) as { value: string } | undefined;
      const old = row ? (JSON.parse(row.value) as TaskCommand) : undefined;
      if (old) {
        if (old.digest !== hash || old.actorId !== p.id)
          throw new AppError("CONFLICT");
        return old;
      }
      const c: TaskCommand = {
        id,
        taskId,
        input,
        digest: hash,
        state: "queued",
        createdAt: this.reconciliation.now(),
        actorId: p.id,
        epoch: p.epoch,
        policyVersion: p.policyVersion,
        attributed: false,
        ...(learning ? { learning } : {}),
      };
      this.store.db
        .prepare("INSERT INTO task_commands VALUES(?,?)")
        .run(id, JSON.stringify(c));
      return c;
    });
  }
  claim(p: Principal) {
    return this.store.tx(() => {
      this.reconciliation.guard.write(p);
      const head = this.reconciliation.head();
      if (!head.complete || this.reconciliation.now() - head.observedAt > 30000)
        throw new AppError("BASELINE");
      const c = this.list()
        .reverse()
        .find(
          (c) =>
            c.state === "queued" &&
            c.actorId === p.id &&
            c.epoch === p.epoch &&
            c.policyVersion === p.policyVersion,
        );
      if (!c) return null;
      if (
        c.epoch !== p.epoch ||
        c.policyVersion !== p.policyVersion ||
        c.actorId !== p.id
      )
        throw new AppError("BASELINE");
      try {
        if (c.learning) {
          const db = new LearningStore(this.reconciliation.guard);
          const goal = db.goal(c.learning.goalId);
          if (
            goal.state !== "active" ||
            goal.baselineId !== c.learning.baselineId ||
            choice(db, goal.id, c.learning.unitId).state !== "selected"
          )
            throw new AppError("BASELINE");
          const row = this.store.db
            .prepare("SELECT value FROM learning_task_intents WHERE id=?")
            .get(c.id) as { value: string } | undefined;
          if (!row) throw new AppError("BASELINE");
          const intent = JSON.parse(row.value);
          new Suggestions(db).readable(
            new Suggestions(db).raw(intent.suggestionId),
          );
        }
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        // It has never left the queue, so invalidated learning scope proves non-dispatch.
        c.state = "cancelled";
        this.store.db
          .prepare("UPDATE task_commands SET value=? WHERE id=?")
          .run(JSON.stringify(c), c.id);
        return null;
      }
      c.state = "unknown";
      this.store.db
        .prepare("UPDATE task_commands SET value=? WHERE id=?")
        .run(JSON.stringify(c), c.id);
      return c;
    });
  }
  reauthorize(id: string, expectedDigest: string, p: Principal) {
    this.reconciliation.guard.write(p);
    const c = this.list().find((c) => c.id === id);
    if (!c || c.state !== "queued" || c.digest !== expectedDigest)
      throw new AppError("BASELINE");
    c.actorId = p.id;
    c.epoch = p.epoch;
    c.policyVersion = p.policyVersion;
    this.store.db
      .prepare("UPDATE task_commands SET value=? WHERE id=?")
      .run(JSON.stringify(c), id);
    return c;
  }
  cancel(id: string, p: Principal) {
    this.reconciliation.guard.write(p);
    const c = this.list().find((c) => c.id === id);
    if (!c) throw new AppError("NOT_FOUND", 404);
    if (c.state !== "queued") throw new AppError("CONFLICT");
    c.state = "cancelled";
    this.store.db
      .prepare("UPDATE task_commands SET value=? WHERE id=?")
      .run(JSON.stringify(c), id);
    return c;
  }
}
