import { randomUUID } from "node:crypto";
import { type Principal, type ReviewSuggestion } from "@kb/contracts";
import { z } from "zod";
import { LearningStore } from "./goals";
import { Attempts } from "./attempts";
import { choice } from "./units";
import { sourceImpact } from "./impact";
import { AppError } from "../errors";
export class Suggestions {
  constructor(readonly db: LearningStore) {}
  raw(id: string): ReviewSuggestion {
    const row = this.db.store.db
      .prepare("SELECT value FROM learning_suggestions WHERE id=?")
      .get(id) as { value: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    return JSON.parse(row.value);
  }
  readable(s: ReviewSuggestion) {
    const b = this.db.baseline(s.baselineId),
      u = this.db.unit(b, s.unitId);
    for (const id of [...u.necessary, ...u.optional]) this.db.evidence.read(id);
    if (
      s.attemptId &&
      new Attempts(this.db).visible(new Attempts(this.db).raw(s.attemptId))
        .restricted
    )
      throw new AppError("FORBIDDEN", 403);
    return s;
  }
  list(goalId: string, p: Principal) {
    this.db.read(p);
    return (
      this.db.store.db
        .prepare(
          "SELECT value FROM learning_suggestions WHERE goal_id=? ORDER BY rowid DESC LIMIT 100",
        )
        .all(goalId) as { value: string }[]
    ).map((r) => {
      const s = JSON.parse(r.value) as ReviewSuggestion;
      try {
        return { ...this.readable(s), restricted: false as const };
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        return {
          id: s.id,
          unitId: s.unitId,
          state: s.state,
          restricted: true as const,
        };
      }
    });
  }
  save(s: ReviewSuggestion) {
    this.db.store.db
      .prepare("UPDATE learning_suggestions SET value=? WHERE id=?")
      .run(JSON.stringify(s), s.id);
  }
  generate(goalId: string, p: Principal) {
    this.db.write(p);
    const rule = this.db.settings().review;
    if (!rule)
      return {
        created: [],
        reason: "先明确复习间隔、窗口和预计时长；不猜测用户参数。",
      };
    const g = this.db.goal(goalId),
      b = this.db.baseline(g.baselineId),
      service = new Attempts(this.db);
    const created: string[] = [];
    if (g.state === "paused") return { created, reason: "目标已暂停" };
    this.db.store.tx(() => {
      for (const u of b.input.units) {
        if (created.length >= 3) break;
        if (choice(this.db, g.id, u.id).state !== "selected") continue;
        const last = service
          .list(g.id, u.id)
          .filter((a) => a.baselineId === b.id)
          .at(-1);
        if (!last || service.visible(last).restricted) continue;
        const key = `review:${b.id}:${u.id}:${last.id}`;
        if (
          this.db.store.db
            .prepare(
              "SELECT 1 FROM learning_suggestions WHERE suggestion_key=?",
            )
            .get(key)
        )
          continue;
        // One outstanding suggestion per unit. A new attempt does not recreate a paused/skipped suggestion.
        if (
          this.db.store.db
            .prepare(
              "SELECT 1 FROM learning_suggestions WHERE goal_id=? AND json_extract(value,'$.unitId')=? AND json_extract(value,'$.baselineId')=? AND json_extract(value,'$.state')!='created'",
            )
            .get(g.id, u.id, b.id)
        )
          continue;
        const dueAt = last.createdAt + rule.intervalDays * 86400000;
        const s: ReviewSuggestion = {
          id: randomUUID(),
          goalId,
          baselineId: b.id,
          unitId: u.id,
          attemptId: last.id,
          kind: "review",
          reason: last.unresolved.length
            ? `上次遗留：${last.unresolved.join("；")}`
            : "按已确认间隔重新回忆并核对条件；不代表此前未掌握。",
          dueAt,
          endAt: dueAt + rule.windowDays * 86400000,
          minutes: rule.minutes,
          state: "suggested",
          choiceNote: "",
          createdAt: this.db.now(),
        };
        this.db.store.db
          .prepare("INSERT INTO learning_suggestions VALUES(?,?,?,?)")
          .run(s.id, key, g.id, JSON.stringify(s));
        created.push(s.id);
      }
    });
    return { created, reason: "每次最多生成 3 项；建议不等于任务。" };
  }
  supplement(goalId: string, unitId: string, reason: string, p: Principal) {
    this.db.write(p);
    z.string().trim().min(1).max(2000).parse(reason);
    const g = this.db.goal(goalId),
      b = this.db.baseline(g.baselineId),
      rule = this.db.settings().review;
    if (
      !rule ||
      g.state !== "active" ||
      choice(this.db, goalId, unitId).state !== "selected"
    )
      throw new AppError("PAUSED");
    const impacts = sourceImpact(this.db, b, unitId).filter(
      (i) => !i.restricted && i.supplementCandidate,
    );
    if (!impacts.length) throw new AppError("BASELINE");
    const key = `version:${b.id}:${unitId}`;
    const old = this.db.store.db
      .prepare("SELECT id FROM learning_suggestions WHERE suggestion_key=?")
      .get(key) as { id: string } | undefined;
    if (old) return this.readable(this.raw(old.id));
    const s: ReviewSuggestion = {
      id: randomUUID(),
      goalId,
      baselineId: b.id,
      unitId,
      attemptId: null,
      kind: "version",
      reason: `人工核对实质差异：${reason}`,
      dueAt: this.db.now(),
      endAt: this.db.now() + rule.windowDays * 86400000,
      minutes: rule.minutes,
      state: "suggested",
      choiceNote: "",
      createdAt: this.db.now(),
    };
    this.db.store.db
      .prepare("INSERT INTO learning_suggestions VALUES(?,?,?,?)")
      .run(s.id, key, goalId, JSON.stringify(s));
    return s;
  }
  decide(id: string, value: unknown, p: Principal) {
    this.db.write(p);
    const s = this.readable(this.raw(id));
    const i = z
      .object({
        state: z.enum(["suggested", "skipped", "deferred", "paused"]),
        reason: z.string().min(1).max(2000),
        dueAt: z.number().int().positive().optional(),
      })
      .strict()
      .parse(value);
    if (["created", "creating"].includes(s.state))
      throw new AppError("CONFLICT");
    if (i.state === "deferred") {
      if (!i.dueAt || i.dueAt <= this.db.now())
        throw new AppError("VALIDATION");
      s.endAt = i.dueAt + (s.endAt - s.dueAt);
      s.dueAt = i.dueAt;
    }
    s.state = i.state;
    s.choiceNote = i.reason;
    this.save(s);
    this.db.store.event("learning.review.choice", id, this.db.now());
    return s;
  }
}
