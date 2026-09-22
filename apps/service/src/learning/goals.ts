import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Id,
  LearningGoalInput,
  LearningSettings,
  type LearningGoal,
  type LearningBaseline,
  type Principal,
} from "@kb/contracts";
import { Proposals } from "../review/proposals";
import { digest } from "../workspace/registry";
import { AppError } from "../errors";
export class LearningStore {
  constructor(
    readonly proposals: Proposals,
    readonly now = Date.now,
  ) {}
  get store() {
    return this.proposals.store;
  }
  get evidence() {
    return this.proposals.evidence;
  }
  read(p: Principal) {
    this.evidence.checkPrincipal(p);
  }
  write(p: Principal) {
    this.proposals.write(p);
  }
  goal(id: string): LearningGoal {
    const row = this.store.db
      .prepare("SELECT value FROM learning_goals WHERE id=?")
      .get(id) as { value: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    return JSON.parse(row.value);
  }
  baseline(id: string): LearningBaseline {
    const row = this.store.db
      .prepare("SELECT value FROM learning_baselines WHERE id=?")
      .get(id) as { value: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    const b = JSON.parse(row.value) as LearningBaseline;
    if (digest(b.input) !== b.digest) throw new AppError("HASH_MISMATCH");
    return b;
  }
  unit(b: LearningBaseline, id: string) {
    const u = b.input.units.find((u) => u.id === id);
    if (!u) throw new AppError("NOT_FOUND", 404);
    return u;
  }
  operation(
    kind: string,
    operationId: string,
    input: unknown,
    p: Principal,
    fn: () => string,
  ) {
    this.write(p);
    Id.parse(operationId);
    const key = `learning:${p.id}:${kind}:${operationId}`,
      hash = digest(input);
    return this.store.tx(() => {
      const old = this.store.db
        .prepare("SELECT digest,result_id FROM learning_operations WHERE key=?")
        .get(key) as { digest: string; result_id: string } | undefined;
      if (old) {
        if (old.digest !== hash) throw new AppError("CONFLICT");
        return old.result_id;
      }
      const id = fn();
      this.store.db
        .prepare("INSERT INTO learning_operations VALUES(?,?,?)")
        .run(key, hash, id);
      return id;
    });
  }
  confirm(value: unknown, p: Principal) {
    const i = z
      .object({
        operationId: Id,
        input: LearningGoalInput,
        digest: z.string().length(64),
        goalId: Id.optional(),
        previousId: Id.optional(),
      })
      .strict()
      .parse(value);
    if (digest(i.input) !== i.digest) throw new AppError("BASELINE");
    const id = this.operation("baseline", i.operationId, i, p, () => {
      let previous: LearningBaseline | undefined;
      const goalId = i.goalId ?? randomUUID();
      if (i.goalId) {
        const g = this.goal(goalId);
        if (i.previousId !== g.baselineId) throw new AppError("BASELINE");
        previous = this.baseline(g.baselineId);
        // A new baseline adds scope; skipping/cancelling leaves never shrinks its denominator.
        for (const old of previous.input.units) {
          const next = i.input.units.find((u) => u.id === old.id);
          if (
            !next ||
            old.criteria.some(
              (c) => !next.criteria.some((n) => digest(n) === digest(c)),
            )
          )
            throw new AppError(
              "BASELINE",
              409,
              "保留已有单元和叶子验收项；取消不能删除分母。",
            );
        }
      } else if (i.previousId) throw new AppError("BASELINE");
      for (const u of i.input.units)
        for (const ref of [...u.necessary, ...u.optional])
          this.evidence.read(ref);
      const b: LearningBaseline = {
        id: randomUUID(),
        goalId,
        previousId: previous?.id ?? null,
        input: i.input,
        digest: i.digest,
        createdAt: this.now(),
      };
      const g: LearningGoal = {
        id: goalId,
        baselineId: b.id,
        state: i.goalId ? this.goal(goalId).state : "active",
        createdAt: i.goalId ? this.goal(goalId).createdAt : this.now(),
      };
      this.store.db
        .prepare(
          "INSERT INTO learning_goals VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        )
        .run(g.id, JSON.stringify(g));
      this.store.db
        .prepare("INSERT INTO learning_baselines VALUES(?,?,?)")
        .run(b.id, g.id, JSON.stringify(b));
      this.store.event("learning.baseline.confirmed", b.id, this.now());
      return b.id;
    });
    return this.baseline(id);
  }
  settings(): LearningSettings {
    return LearningSettings.parse(
      this.store.get("learning:settings") ?? { capacity: null, review: null },
    );
  }
  configure(value: unknown, p: Principal) {
    this.write(p);
    const s = LearningSettings.parse(value);
    if (s.capacity) {
      try {
        new Intl.DateTimeFormat("en-US", {
          timeZone: s.capacity.timezone,
        }).format();
      } catch {
        throw new AppError("VALIDATION", 400, "未知时区");
      }
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM learning_task_intents WHERE json_extract(value,'$.timezone')!=? LIMIT 1",
          )
          .get(s.capacity.timezone)
      )
        throw new AppError(
          "BASELINE",
          409,
          "已有容量记录时保留原时区，避免重复取得同一自然日额度。",
        );
    }
    this.store.set("learning:settings", s);
    return s;
  }
  setState(id: string, state: "active" | "paused", p: Principal) {
    this.write(p);
    const g = this.goal(id);
    g.state = state;
    this.store.db
      .prepare("UPDATE learning_goals SET value=? WHERE id=?")
      .run(JSON.stringify(g), id);
    return g;
  }
}
