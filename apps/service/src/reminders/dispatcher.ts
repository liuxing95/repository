import { randomUUID } from "node:crypto";
import type { ReminderOccurrence, ReminderRule } from "@kb/contracts";
import type { Store } from "../storage/store";
import { observedTasks } from "../tasks/identity";
import { inQuietHours, localClock } from "./identity";
import { ReminderRules } from "./rules";
import {
  desktopChannel,
  type LocalChannel,
  type ChannelResult,
} from "./channels/local";

type Attempt = { id: string };

export class ReminderDispatcher {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  readonly rules: ReminderRules;
  readonly startedAt: number;
  constructor(
    readonly store: Store,
    readonly channel: LocalChannel = desktopChannel,
    readonly now = Date.now,
  ) {
    this.rules = new ReminderRules(store, now);
    this.startedAt = now();
  }

  recover() {
    if (this.store.reminderPaused) return;
    this.store.tx(() => {
      this.store.db
        .prepare(
          "UPDATE reminder_attempts SET state='outcome_unknown',detail='服务中断，渠道结果未知' WHERE state='dispatching'",
        )
        .run();
      for (const o of this.rules
        .occurrences()
        .filter((x) => x.state === "dispatching")) {
        o.state = "outcome_unknown";
        o.reason = "服务中断，渠道结果未知；不会盲目重发";
        this.update(o);
      }
    });
  }

  start() {
    this.recover();
    this.timer = setInterval(() => void this.tick().catch(() => {}), 15_000);
    void this.tick().catch(() => {});
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  tick() {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run() {
    if (this.store.readOnly || this.store.reminderPaused) return;
    this.store.tx(() => this.rules.sync());
    const due = this.rules
      .occurrences()
      .filter((o) => o.state === "scheduled" && o.dueAt <= this.now());
    for (const o of due) {
      const claimed = this.claim(o.logicalKey);
      if (!claimed) continue;
      let outcome: ChannelResult = "outcome_unknown";
      try {
        outcome = await this.channel(claimed.rule);
      } catch {
        /* An external side effect may already have occurred. */
      }
      this.finish(claimed.occurrence, claimed.attempt, outcome);
    }
  }

  private update(o: ReminderOccurrence) {
    this.store.db
      .prepare(
        "UPDATE reminder_occurrences SET state=?,generation=?,cancel_generation=?,due_at=?,value=? WHERE logical_key=?",
      )
      .run(
        o.state,
        o.generation,
        o.cancelGeneration,
        o.dueAt,
        JSON.stringify(o),
        o.logicalKey,
      );
  }

  private claim(key: string): {
    occurrence: ReminderOccurrence;
    rule: ReminderRule;
    attempt: Attempt;
  } | null {
    return this.store.tx(() => {
      const row = this.store.db
        .prepare("SELECT value FROM reminder_occurrences WHERE logical_key=?")
        .get(key) as { value: string } | undefined;
      if (!row) return null;
      const o = JSON.parse(row.value) as ReminderOccurrence;
      const rule = this.rules.list(o.ownerId).find((r) => r.id === o.ruleId);
      const workspace = this.store.get("workspace") as
        { deviceId: string | null } | undefined;
      if (
        !rule ||
        !rule.enabled ||
        workspace?.deviceId !== o.ownerId ||
        o.state !== "scheduled" ||
        o.dueAt > this.now() ||
        o.cancelGeneration >= o.generation
      )
        return null;
      const prior = this.store.db
        .prepare("SELECT state FROM reminder_attempts WHERE delivery_key=?")
        .get(o.deliveryKey) as { state: string } | undefined;
      if (prior) {
        o.state =
          prior.state === "dispatching"
            ? "outcome_unknown"
            : (prior.state as ReminderOccurrence["state"]);
        o.reason = "该投递身份已有尝试；未重复发送";
        this.update(o);
        return null;
      }
      let reason: string | null = null;
      if (this.now() - o.baseDueAt > rule.maxLateMinutes * 60_000)
        reason = "超过迟到窗口";
      if (
        (rule.kind === "morning" || rule.kind === "evening") &&
        !rule.catchUp &&
        o.snoozedUntil === null &&
        (rule.createdAt > o.baseDueAt ||
          this.startedAt > o.baseDueAt ||
          this.now() - o.baseDueAt > 30_000)
      )
        reason = "当天提醒已错过；未开启补发";
      if (this.rules.pausedToday(o.ownerId)) reason = "今天已暂停提醒";
      const task = o.taskId
        ? observedTasks(this.store).find((t) => t.taskId === o.taskId)
        : null;
      const zone =
        rule.kind === "morning" || rule.kind === "evening"
          ? rule.timezone
          : task?.fact.timezone;
      if (
        zone &&
        inQuietHours(
          localClock(this.now(), zone),
          rule.quietStart,
          rule.quietEnd,
        )
      )
        reason = "勿扰时段";
      if (o.taskId) {
        const head = this.store.get("tasks.inventory") as
          { complete: boolean; observedAt: number } | undefined;
        if (
          !head?.complete ||
          this.now() < head.observedAt ||
          this.now() - head.observedAt >
            (rule.kind === "start" || rule.kind === "deadline"
              ? rule.freshnessMinutes
              : 0) *
              60_000
        )
          reason = "TaskNotes 事实过旧";
        if (
          !task ||
          task.sync !== "current" ||
          ["done", "cancelled"].includes(task.fact.lifecycle) ||
          task.revision !== o.taskRevision
        )
          reason = "任务事实已失效";
        if (
          rule.kind === "start" &&
          this.store.get("tasks.acceptedPlan") !== o.planId
        )
          reason = "计划版本已失效";
      }
      if (reason) {
        o.state = "suppressed";
        o.reason = reason;
        this.store.advanceReminderFence();
        this.update(o);
        return null;
      }
      const attempt = { id: randomUUID() };
      this.store.advanceReminderFence();
      this.store.db
        .prepare("INSERT INTO reminder_attempts VALUES(?,?,?,?,?,?,?,?)")
        .run(
          attempt.id,
          key,
          o.deliveryKey,
          o.generation,
          this.now(),
          null,
          "dispatching",
          "已调用本机通知渠道，尚无回执",
        );
      o.state = "dispatching";
      o.reason = null;
      this.update(o);
      return { occurrence: o, rule, attempt };
    });
  }

  private finish(
    o: ReminderOccurrence,
    attempt: Attempt,
    outcome: ChannelResult,
  ) {
    this.store.tx(() => {
      this.store.advanceReminderFence();
      this.store.db
        .prepare(
          "UPDATE reminder_attempts SET state=?,finished_at=?,detail=? WHERE id=?",
        )
        .run(
          outcome,
          this.now(),
          outcome === "accepted"
            ? "本机通知命令已接受；未证明用户收到或已读"
            : outcome === "failed"
              ? "本机通知命令明确失败"
              : "本机通知结果未知；不会盲目重发",
          attempt.id,
        );
      const row = this.store.db
        .prepare("SELECT value FROM reminder_occurrences WHERE logical_key=?")
        .get(o.logicalKey) as { value: string } | undefined;
      if (!row) return;
      const current = JSON.parse(row.value) as ReminderOccurrence;
      if (
        current.deliveryKey !== o.deliveryKey ||
        current.state !== "dispatching"
      )
        return;
      current.state = outcome;
      current.reason =
        outcome === "accepted"
          ? "渠道接受，不代表设备送达或用户已读"
          : outcome === "failed"
            ? "本机通知命令失败"
            : "结果未知；不会盲目重发";
      this.update(current);
    });
  }
}
