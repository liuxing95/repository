import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Id,
  type LearningTaskIntent,
  type Principal,
  type TaskCapacitySnapshot,
} from "@kb/contracts";
import { LearningStore } from "./goals";
import { Suggestions } from "./review-suggestions";
import { choice } from "./units";
import { AppError } from "../errors";
export type TaskCreationResult =
  | { state: "created"; taskId: string }
  | { state: "not-created" }
  | { state: "unknown" };
export interface LearningTaskAdapter {
  snapshot(timezone: string): Promise<TaskCapacitySnapshot>;
  create(
    input: {
      taskId: string;
      operationId: string;
      title: string;
      goalId: string;
      unitId: string;
      baselineId: string;
      day: string;
      minutes: number;
    },
    signal: AbortSignal,
  ): Promise<TaskCreationResult>;
  lookup(taskId: string, operationId: string): Promise<TaskCreationResult>;
}
export function capacityDay(at: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
const Snapshot = z
  .object({
    complete: z.literal(true),
    observedAt: z.number().int(),
    tasks: z
      .array(
        z
          .object({
            taskId: Id,
            active: z.boolean(),
            day: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .nullable(),
            minutes: z.number().int().min(0).max(1440),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export class Capacity {
  private readonly inFlight = new Set<string>();
  readonly suggestions: Suggestions;
  constructor(
    readonly db: LearningStore,
    readonly adapter?: LearningTaskAdapter,
    readonly timeoutMs = 8000,
  ) {
    this.suggestions = new Suggestions(db);
  }
  intent(id: string): LearningTaskIntent {
    const row = this.db.store.db
      .prepare("SELECT value FROM learning_task_intents WHERE id=?")
      .get(id) as { value: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    return JSON.parse(row.value);
  }
  save(i: LearningTaskIntent) {
    this.db.store.db
      .prepare("UPDATE learning_task_intents SET value=? WHERE id=?")
      .run(JSON.stringify(i), i.id);
  }
  private settle(id: string, result: TaskCreationResult) {
    return this.db.store.tx(() => {
      const i = this.intent(id),
        s = this.suggestions.raw(i.suggestionId);
      if (i.state === "created" || i.state === "failed") return i;
      if (result.state === "created" && result.taskId === i.taskId) {
        i.state = "created";
        s.state = "created";
      } else if (result.state === "not-created") {
        i.state = "failed";
        s.state = "paused";
        s.choiceNote = "已确认未创建；保留本次意图，不自动重试。";
      } else i.state = "unknown";
      this.save(i);
      this.suggestions.save(s);
      this.db.store.event(`learning.task.${i.state}`, id, this.db.now());
      return i;
    });
  }
  async create(id: string, p: Principal) {
    this.db.write(p);
    const prior = this.db.store.db
      .prepare("SELECT id FROM learning_task_intents WHERE suggestion_id=?")
      .get(id) as { id: string } | undefined;
    if (prior) {
      this.suggestions.readable(this.suggestions.raw(id));
      return this.intent(prior.id);
    }
    const settings = this.db.settings(),
      cap = settings.capacity;
    if (!cap)
      throw new AppError(
        "CAPACITY_UNCONFIGURED",
        409,
        "没有容量设置，只保留建议。",
      );
    if (!this.adapter)
      throw new AppError(
        "TASK_ADAPTER_UNAVAILABLE",
        409,
        "TaskNotes 尚未接入，只保留建议。",
      );
    const snapshot = Snapshot.parse(await this.adapter.snapshot(cap.timezone));
    if (
      Math.abs(this.db.now() - snapshot.observedAt) > 30000 ||
      new Set(snapshot.tasks.map((t) => t.taskId)).size !==
        snapshot.tasks.length
    )
      throw new AppError("BASELINE");
    let dispatch = false;
    const intent = this.db.store.tx(() => {
      this.db.write(p);
      if (JSON.stringify(this.db.settings()) !== JSON.stringify(settings))
        throw new AppError("BASELINE");
      const old = this.db.store.db
        .prepare("SELECT id FROM learning_task_intents WHERE suggestion_id=?")
        .get(id) as { id: string } | undefined;
      if (old) return this.intent(old.id);
      const s = this.suggestions.readable(this.suggestions.raw(id)),
        g = this.db.goal(s.goalId),
        b = this.db.baseline(g.baselineId);
      if (
        g.state !== "active" ||
        g.baselineId !== s.baselineId ||
        choice(this.db, g.id, s.unitId).state !== "selected" ||
        !["suggested", "deferred"].includes(s.state)
      )
        throw new AppError("BASELINE");
      if (s.dueAt > this.db.now())
        throw new AppError(
          "NOT_DUE",
          409,
          "建议窗口尚未到；当前不提前占用今日容量。",
        );
      const day = capacityDay(this.db.now(), cap.timezone);
      const intents = (
        this.db.store.db
          .prepare(
            "SELECT value FROM learning_task_intents WHERE json_extract(value,'$.state')!='failed'",
          )
          .all() as { value: string }[]
      ).map((r) => JSON.parse(r.value) as LearningTaskIntent);
      const known = new Set(intents.map((i) => i.taskId));
      let wip = snapshot.tasks.filter(
        (t) => t.active && !known.has(t.taskId),
      ).length;
      let minutes = snapshot.tasks
        .filter((t) => t.day === day && !known.has(t.taskId))
        .reduce((n, t) => n + t.minutes, 0);
      for (const i of intents) {
        const fact = snapshot.tasks.find((t) => t.taskId === i.taskId);
        if (i.state !== "created" || !fact || fact.active) wip++;
        if (i.day === day)
          minutes += Math.max(i.minutes, fact?.day === day ? fact.minutes : 0);
        else if (fact?.day === day) minutes += fact.minutes;
      }
      if (wip >= cap.wip || minutes + s.minutes > cap.dayMinutes)
        throw new AppError(
          "CAPACITY",
          409,
          "同时进行或今日复习容量已满；待创建和未知结果也占容量。",
        );
      const i: LearningTaskIntent = {
        id: randomUUID(),
        suggestionId: id,
        taskId: randomUUID(),
        goalId: g.id,
        baselineId: b.id,
        unitId: s.unitId,
        day,
        timezone: cap.timezone,
        minutes: s.minutes,
        state: "reserved",
        createdAt: this.db.now(),
      };
      this.db.store.db
        .prepare("INSERT INTO learning_task_intents VALUES(?,?,?)")
        .run(i.id, id, JSON.stringify(i));
      s.state = "creating";
      this.suggestions.save(s);
      dispatch = true;
      this.db.store.event("learning.task.reserved", i.id, i.createdAt);
      return i;
    });
    if (!dispatch) return intent;
    this.inFlight.add(intent.id);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: TaskCreationResult;
    try {
      result = await Promise.race([
        this.adapter.create(
          {
            taskId: intent.taskId,
            operationId: intent.id,
            goalId: intent.goalId,
            unitId: intent.unitId,
            baselineId: intent.baselineId,
            day: intent.day,
            minutes: intent.minutes,
            title: this.db.unit(
              this.db.baseline(intent.baselineId),
              intent.unitId,
            ).title,
          },
          controller.signal,
        ),
        new Promise<TaskCreationResult>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ state: "unknown" });
          }, this.timeoutMs);
        }),
      ]);
    } catch {
      result = { state: "unknown" };
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(intent.id);
    }
    const settled = this.settle(intent.id, result);
    this.db.read(p);
    this.suggestions.readable(this.suggestions.raw(id));
    return settled;
  }
  async reconcile(id: string, p: Principal) {
    this.db.write(p);
    const i = this.intent(id);
    this.suggestions.readable(this.suggestions.raw(i.suggestionId));
    if (!this.adapter) throw new AppError("TASK_ADAPTER_UNAVAILABLE");
    if (["created", "failed"].includes(i.state)) return i;
    if (this.inFlight.has(id)) return i;
    let result: TaskCreationResult;
    try {
      result = await this.adapter.lookup(i.taskId, i.id);
    } catch {
      result = { state: "unknown" };
    }
    const settled = this.settle(id, result);
    this.db.read(p);
    this.suggestions.readable(this.suggestions.raw(i.suggestionId));
    return settled;
  }
}
