import { randomUUID } from "node:crypto";
import {
  ReminderRuleInput,
  TaskDay,
  TaskZone,
  type ReminderOccurrence,
  type ReminderRule,
} from "@kb/contracts";
import type { Store } from "../storage/store";
import { observedTasks } from "../tasks/identity";
import { deliveryKey, localDay, reminderKey, resolveWall } from "./identity";
import { AppError } from "../errors";
import { taskDeadline } from "../planning/time";

type Row = { value: string };
type Planned = {
  id: string;
  blocks: { taskId: string; start: number }[];
  taskRevisions: Record<string, string>;
};

export class ReminderRules {
  constructor(
    readonly store: Store,
    readonly now = Date.now,
  ) {}

  list(ownerId?: string): ReminderRule[] {
    const rows = ownerId
      ? this.store.db
          .prepare(
            "SELECT value FROM reminder_rules WHERE owner_id=? ORDER BY id",
          )
          .all(ownerId)
      : this.store.db
          .prepare("SELECT value FROM reminder_rules ORDER BY id")
          .all();
    return (rows as Row[]).map((r) => JSON.parse(r.value));
  }

  occurrences(ownerId?: string): ReminderOccurrence[] {
    const rows = ownerId
      ? this.store.db
          .prepare(
            "SELECT value FROM reminder_occurrences WHERE owner_id=? ORDER BY due_at,logical_key",
          )
          .all(ownerId)
      : this.store.db
          .prepare(
            "SELECT value FROM reminder_occurrences ORDER BY due_at,logical_key",
          )
          .all();
    return (rows as Row[]).map((r) => JSON.parse(r.value));
  }

  register(ownerId: string, raw: unknown) {
    const input = ReminderRuleInput.parse(raw);
    if ((input.quietStart === null) !== (input.quietEnd === null))
      throw new AppError("VALIDATION", 400, "勿扰开始与结束需同时填写。");
    if (this.list(ownerId).some((r) => r.kind === input.kind && r.enabled))
      throw new AppError("CONFLICT", 409, "同类本机提醒已开启；先关闭旧规则。");
    const rule: ReminderRule = {
      ...input,
      id: randomUUID(),
      ownerId,
      createdAt: this.now(),
      channel: "desktop",
      executor: "local",
    };
    return this.store.tx(() => {
      this.store.advanceReminderFence();
      this.store.db
        .prepare("INSERT INTO reminder_rules VALUES(?,?,?,?)")
        .run(rule.id, ownerId, Number(rule.enabled), JSON.stringify(rule));
      this.sync();
      return rule;
    });
  }

  disable(ownerId: string, id: string) {
    return this.store.tx(() => {
      const row = this.store.db
        .prepare("SELECT value FROM reminder_rules WHERE id=? AND owner_id=?")
        .get(id, ownerId) as Row | undefined;
      if (!row) throw new AppError("NOT_FOUND", 404);
      const rule = JSON.parse(row.value) as ReminderRule;
      rule.enabled = false;
      this.store.advanceReminderFence();
      this.store.db
        .prepare("UPDATE reminder_rules SET enabled=0,value=? WHERE id=?")
        .run(JSON.stringify(rule), id);
      this.sync();
      return rule;
    });
  }

  snooze(ownerId: string, logicalKey: string, until: number) {
    return this.store.tx(() => {
      const row = this.store.db
        .prepare(
          "SELECT value FROM reminder_occurrences WHERE logical_key=? AND owner_id=?",
        )
        .get(logicalKey, ownerId) as Row | undefined;
      if (!row) throw new AppError("NOT_FOUND", 404);
      const o = JSON.parse(row.value) as ReminderOccurrence;
      const rule = this.list(ownerId).find((r) => r.id === o.ruleId);
      if (
        !rule ||
        !rule.enabled ||
        o.state !== "scheduled" ||
        until <= this.now() ||
        until > o.baseDueAt + rule.maxLateMinutes * 60_000
      )
        throw new AppError("VALIDATION", 400, "只能在提醒有效期内稍后提醒。");
      o.generation++;
      o.snoozedUntil = until;
      o.dueAt = until;
      this.store.advanceReminderFence();
      this.save(o);
      return o;
    });
  }

  reviewUnknown(ownerId: string, logicalKey: string) {
    return this.store.tx(() => {
      const occurrence = this.store.db
        .prepare(
          "SELECT delivery_key FROM reminder_occurrences WHERE logical_key=? AND owner_id=?",
        )
        .get(logicalKey, ownerId) as { delivery_key: string } | undefined;
      if (!occurrence) throw new AppError("NOT_FOUND", 404);
      const attempt = this.store.db
        .prepare("SELECT state FROM reminder_attempts WHERE delivery_key=?")
        .get(occurrence.delivery_key) as { state: string } | undefined;
      if (attempt?.state !== "outcome_unknown")
        throw new AppError("VALIDATION", 400, "只有结果未知的提醒可人工核对。");
      const existing = this.store.db
        .prepare("SELECT 1 FROM reminder_reviews WHERE delivery_key=?")
        .get(occurrence.delivery_key);
      if (!existing) {
        this.store.advanceReminderFence();
        this.store.db
          .prepare("INSERT INTO reminder_reviews VALUES(?,?,?)")
          .run(occurrence.delivery_key, ownerId, this.now());
      }
      return {
        reviewed: true,
        deliveryKey: occurrence.delivery_key,
        stillUnknown: true,
      };
    });
  }

  pauseToday(ownerId: string, rawDay: string, rawTimezone: string) {
    const day = TaskDay.parse(rawDay),
      timezone = TaskZone.parse(rawTimezone);
    if (localDay(this.now(), timezone) !== day)
      throw new AppError("VALIDATION", 400, "只能暂停当前当地日期。");
    return this.store.tx(() => {
      const old = this.store.db
        .prepare("SELECT 1 FROM reminder_pauses WHERE owner_id=? AND day=?")
        .get(ownerId, day);
      if (!old) {
        this.store.advanceReminderFence();
        this.store.db
          .prepare("INSERT INTO reminder_pauses VALUES(?,?,?,?)")
          .run(ownerId, day, timezone, this.now());
      }
      return { day, paused: true };
    });
  }

  pausedToday(ownerId: string) {
    const rows = this.store.db
      .prepare("SELECT day,timezone FROM reminder_pauses WHERE owner_id=?")
      .all(ownerId) as { day: string; timezone: string }[];
    return rows.some((r) => localDay(this.now(), r.timezone) === r.day);
  }

  private save(o: ReminderOccurrence) {
    this.store.db
      .prepare(
        "INSERT INTO reminder_occurrences VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(logical_key) DO UPDATE SET task_id=excluded.task_id,due_at=excluded.due_at,generation=excluded.generation,cancel_generation=excluded.cancel_generation,state=excluded.state,delivery_key=excluded.delivery_key,value=excluded.value",
      )
      .run(
        o.logicalKey,
        o.ruleId,
        o.ownerId,
        o.taskId,
        o.dueAt,
        o.generation,
        o.cancelGeneration,
        o.state,
        o.deliveryKey,
        JSON.stringify(o),
      );
  }

  sync() {
    this.store.writable();
    const desired = new Set<string>();
    const now = this.now();
    const planId = this.store.get("tasks.acceptedPlan") as string | undefined;
    const planRow = planId
      ? (this.store.db
          .prepare("SELECT value FROM plan_revisions WHERE id=?")
          .get(planId) as Row | undefined)
      : undefined;
    const plan = planRow ? (JSON.parse(planRow.value) as Planned) : null;
    const tasks = observedTasks(this.store);
    const byTaskId = new Map(tasks.map((task) => [task.taskId, task]));
    const workspace = this.store.get("workspace") as
      { deviceId: string | null } | undefined;
    for (const rule of this.list().filter(
      (r) => r.enabled && r.ownerId === workspace?.deviceId,
    )) {
      const candidates: {
        subject: string;
        taskId: string | null;
        planId: string | null;
        revision: string | null;
        due: number;
        day: string | null;
      }[] = [];
      if (rule.kind === "morning" || rule.kind === "evening") {
        const today = localDay(now, rule.timezone);
        for (const offset of [0, 1]) {
          const day = offset
            ? new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000)
                .toISOString()
                .slice(0, 10)
            : today;
          const due = resolveWall(day, rule.localTime, rule.timezone);
          if (due !== null)
            candidates.push({
              subject: day,
              taskId: null,
              planId: null,
              revision: null,
              due,
              day,
            });
        }
      } else if (rule.kind === "start" && plan) {
        for (const block of plan.blocks) {
          const task = byTaskId.get(block.taskId);
          if (
            !task ||
            task.sync !== "current" ||
            ["done", "cancelled"].includes(task.fact.lifecycle) ||
            plan.taskRevisions[task.taskId] !== task.revision
          )
            continue;
          candidates.push({
            subject: task.occurrenceKey ?? task.taskId,
            taskId: task.taskId,
            planId: plan.id,
            revision: task.revision,
            due: block.start - rule.minutesBefore * 60_000,
            day: null,
          });
        }
      } else if (rule.kind === "deadline") {
        for (const task of tasks) {
          if (
            task.sync !== "current" ||
            ["done", "cancelled"].includes(task.fact.lifecycle)
          )
            continue;
          const due = taskDeadline(task.fact.due, task.fact.timezone);
          if (due !== null)
            candidates.push({
              subject: task.occurrenceKey ?? task.taskId,
              taskId: task.taskId,
              planId: null,
              revision: task.revision,
              due: due - rule.minutesBefore * 60_000,
              day: null,
            });
        }
      }
      for (const c of candidates) {
        const key = reminderKey(rule.ownerId, rule.id, c.subject);
        desired.add(key);
        const old = this.store.db
          .prepare("SELECT value FROM reminder_occurrences WHERE logical_key=?")
          .get(key) as Row | undefined;
        const previous = old
          ? (JSON.parse(old.value) as ReminderOccurrence)
          : null;
        if (
          previous &&
          previous.baseDueAt === c.due &&
          previous.planId === c.planId &&
          previous.taskRevision === c.revision &&
          previous.cancelGeneration < previous.generation &&
          previous.state !== "cancelled"
        )
          continue;
        const generation = (previous?.generation ?? 0) + 1;
        const wasSent = !!this.store.db
          .prepare(
            "SELECT 1 FROM reminder_attempts WHERE logical_key=? AND state IN ('accepted','outcome_unknown','dispatching') LIMIT 1",
          )
          .get(key);
        const latest = this.store.db
          .prepare(
            "SELECT state FROM reminder_attempts WHERE logical_key=? ORDER BY rowid DESC LIMIT 1",
          )
          .get(key) as { state: string } | undefined;
        const mayResend =
          (rule.kind === "start" || rule.kind === "deadline") &&
          rule.resendOnMove &&
          latest?.state === "accepted" &&
          previous?.baseDueAt !== c.due;
        const state =
          wasSent && !mayResend ? (previous?.state ?? "accepted") : "scheduled";
        this.store.advanceReminderFence();
        const delivery = c.day
          ? reminderKey(rule.ownerId, rule.kind, c.day)
          : wasSent && !mayResend && previous
            ? previous.deliveryKey
            : deliveryKey(key, generation, !!mayResend);
        this.save({
          logicalKey: key,
          ruleId: rule.id,
          ownerId: rule.ownerId,
          taskId: c.taskId,
          planId: c.planId,
          taskRevision: c.revision,
          baseDueAt: c.due,
          dueAt: c.due,
          generation,
          cancelGeneration: previous?.cancelGeneration ?? 0,
          deliveryKey: delivery,
          state,
          reason: wasSent && !mayResend ? "已尝试投递；默认不重发" : null,
          day: c.day,
          snoozedUntil: null,
        });
      }
    }
    for (const o of this.occurrences()) {
      if (
        desired.has(o.logicalKey) ||
        o.cancelGeneration >= o.generation ||
        o.state === "cancelled"
      )
        continue;
      o.generation++;
      o.cancelGeneration = o.generation;
      o.state =
        o.state === "accepted" || o.state === "outcome_unknown"
          ? o.state
          : "cancelled";
      o.reason = "规则、计划或任务事实已失效；已发通知无法撤回";
      this.store.advanceReminderFence();
      this.save(o);
    }
  }
}
