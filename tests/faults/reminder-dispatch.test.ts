import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { fact, taskFixture } from "../task-helpers";
import { ReminderRules } from "../../apps/service/src/reminders/rules";
import { ReminderDispatcher } from "../../apps/service/src/reminders/dispatcher";
import { observedTasks } from "../../apps/service/src/tasks/identity";

const common = {
  enabled: true,
  overlapReviewed: true as const,
  quietStart: null,
  quietEnd: null,
  maxLateMinutes: 15,
};

test("本地渠道只接受一次；重启后的在途结果保持未知", async () => {
  const f = await taskFixture();
  try {
    const now = Date.parse("2026-09-24T01:00:00Z");
    const rules = new ReminderRules(f.store, () => now);
    rules.register(f.principal.deviceId, {
      ...common,
      kind: "morning",
      localTime: "09:00",
      timezone: "Asia/Shanghai",
      catchUp: false,
    });
    let calls = 0;
    const dispatcher = new ReminderDispatcher(
      f.store,
      async () => {
        calls++;
        return "accepted";
      },
      () => now,
    );
    await dispatcher.tick();
    await dispatcher.tick();
    expect(calls).toBe(1);
    expect(rules.occurrences().find((o) => o.day === "2026-09-24")?.state).toBe(
      "accepted",
    );
    const firstRule = rules.list(f.deviceId)[0]!;
    rules.disable(f.deviceId, firstRule.id);
    rules.register(f.deviceId, {
      ...common,
      kind: "morning",
      localTime: "09:00",
      timezone: "Asia/Shanghai",
      catchUp: true,
    });
    await dispatcher.tick();
    expect(calls).toBe(1);
    const attempt = f.store.db
      .prepare("SELECT id FROM reminder_attempts")
      .get() as { id: string };
    f.store.db
      .prepare("UPDATE reminder_attempts SET state='dispatching' WHERE id=?")
      .run(attempt.id);
    const o = rules.occurrences().find((x) => x.day === "2026-09-24")!;
    o.state = "dispatching";
    f.store.db
      .prepare(
        "UPDATE reminder_occurrences SET state='dispatching',value=? WHERE logical_key=?",
      )
      .run(JSON.stringify(o), o.logicalKey);
    dispatcher.recover();
    await dispatcher.tick();
    expect(calls).toBe(1);
    expect(rules.occurrences().find((x) => x.day === "2026-09-24")?.state).toBe(
      "outcome_unknown",
    );
  } finally {
    await f.close();
  }
});

test("计划改期默认不重发；任务完成取消未发提醒", async () => {
  const f = await taskFixture();
  try {
    const item = fact();
    f.inventory([item]);
    const now = Date.now();
    const task = observedTasks(f.store)[0]!;
    const plan = (start: number) => {
      const id = randomUUID();
      f.store.db.prepare("INSERT INTO plan_revisions VALUES(?,?,?,?,?)").run(
        id,
        null,
        randomUUID(),
        now,
        JSON.stringify({
          id,
          blocks: [{ taskId: task.taskId, start }],
          taskRevisions: { [task.taskId]: task.revision },
        }),
      );
      f.store.set("tasks.acceptedPlan", id);
      return id;
    };
    plan(now - 1000);
    const rules = new ReminderRules(f.store, () => now);
    rules.register(f.principal.deviceId, {
      ...common,
      kind: "start",
      minutesBefore: 0,
      freshnessMinutes: 30,
      resendOnMove: false,
    });
    let calls = 0;
    const dispatcher = new ReminderDispatcher(
      f.store,
      async () => {
        calls++;
        return "accepted";
      },
      () => now,
    );
    await dispatcher.tick();
    expect(calls).toBe(1);
    plan(now + 60_000);
    f.store.tx(() => rules.sync());
    expect(rules.occurrences()[0]?.state).toBe("accepted");
    await dispatcher.tick();
    expect(calls).toBe(1);
    f.inventory([{ ...item, lifecycle: "done" }]);
    const o = rules.occurrences()[0]!;
    expect(o.cancelGeneration).toBe(o.generation);
    expect(o.reason).toContain("已发通知无法撤回");
  } finally {
    await f.close();
  }
});

test("过期与勿扰抑制，任务事实过旧时不发送", async () => {
  const f = await taskFixture();
  try {
    const now = Date.parse("2026-09-24T01:30:00Z");
    const rules = new ReminderRules(f.store, () => now);
    rules.register(f.principal.deviceId, {
      ...common,
      maxLateMinutes: 10,
      kind: "morning",
      localTime: "09:00",
      timezone: "Asia/Shanghai",
      catchUp: false,
    });
    rules.register(f.principal.deviceId, {
      ...common,
      quietStart: "09:00",
      quietEnd: "10:00",
      kind: "evening",
      localTime: "09:30",
      timezone: "Asia/Shanghai",
      catchUp: false,
    });
    let calls = 0;
    await new ReminderDispatcher(
      f.store,
      async () => {
        calls++;
        return "accepted";
      },
      () => now,
    ).tick();
    expect(calls).toBe(0);
    expect(
      rules
        .occurrences()
        .filter((o) => o.day === "2026-09-24")
        .map((o) => o.state),
    ).toEqual(["suppressed", "suppressed"]);
  } finally {
    await f.close();
  }
});

test("任务开始前完成时取消；任务事实过旧时抑制", async () => {
  const f = await taskFixture();
  try {
    const item = fact();
    f.inventory([item]);
    const task = observedTasks(f.store)[0]!;
    const now = Date.now();
    const id = randomUUID();
    f.store.db.prepare("INSERT INTO plan_revisions VALUES(?,?,?,?,?)").run(
      id,
      null,
      randomUUID(),
      now,
      JSON.stringify({
        id,
        blocks: [{ taskId: task.taskId, start: now + 60_000 }],
        taskRevisions: { [task.taskId]: task.revision },
      }),
    );
    f.store.set("tasks.acceptedPlan", id);
    const rules = new ReminderRules(f.store, () => now);
    rules.register(f.principal.deviceId, {
      ...common,
      kind: "start",
      minutesBefore: 0,
      freshnessMinutes: 1,
      resendOnMove: false,
    });
    expect(rules.occurrences()[0]?.state).toBe("scheduled");
    f.inventory([{ ...item, lifecycle: "done" }]);
    expect(rules.occurrences()[0]?.state).toBe("cancelled");
    let calls = 0;
    await new ReminderDispatcher(
      f.store,
      async () => {
        calls++;
        return "accepted";
      },
      () => now + 60_000,
    ).tick();
    expect(calls).toBe(0);
    const fresh = fact({ path: "Tasks/fresh.md" });
    f.inventory([fresh]);
    const observed = observedTasks(f.store).find(
      (t) => t.taskId === fresh.taskId,
    )!;
    const nextId = randomUUID();
    f.store.db.prepare("INSERT INTO plan_revisions VALUES(?,?,?,?,?)").run(
      nextId,
      id,
      randomUUID(),
      now,
      JSON.stringify({
        id: nextId,
        blocks: [{ taskId: observed.taskId, start: now + 60_000 }],
        taskRevisions: { [observed.taskId]: observed.revision },
      }),
    );
    f.store.set("tasks.acceptedPlan", nextId);
    f.store.tx(() => rules.sync());
    await new ReminderDispatcher(
      f.store,
      async () => {
        calls++;
        return "accepted";
      },
      () => now + 120_000,
    ).tick();
    expect(calls).toBe(0);
    expect(
      rules.occurrences().find((o) => o.taskId === fresh.taskId)?.reason,
    ).toBe("TaskNotes 事实过旧");
  } finally {
    await f.close();
  }
});

test("当天遗漏默认不补发；显式补发仍受迟到窗口约束；暂停今天抑制未来提醒", async () => {
  const f = await taskFixture();
  try {
    const now = Date.parse("2026-09-24T01:00:30Z");
    const rules = new ReminderRules(f.store, () => now);
    rules.register(f.deviceId, {
      ...common,
      kind: "morning",
      localTime: "09:00",
      timezone: "Asia/Shanghai",
      catchUp: false,
    });
    rules.register(f.deviceId, {
      ...common,
      kind: "evening",
      localTime: "09:00",
      timezone: "Asia/Shanghai",
      catchUp: true,
    });
    let calls = 0;
    await new ReminderDispatcher(
      f.store,
      async () => {
        calls++;
        return "accepted";
      },
      () => now,
    ).tick();
    expect(calls).toBe(1);
    expect(
      rules
        .occurrences()
        .find((o) => o.day === "2026-09-24" && o.state === "suppressed")
        ?.reason,
    ).toContain("未开启补发");
    rules.pauseToday(f.deviceId, "2026-09-24", "Asia/Shanghai");
    expect(rules.pausedToday(f.deviceId)).toBe(true);
    const later = new ReminderRules(f.store, () => now + 60_000);
    // A new future fixed reminder belongs to the same paused local day.
    rules.disable(
      f.deviceId,
      rules.list(f.deviceId).find((r) => r.kind === "morning")!.id,
    );
    later.register(f.deviceId, {
      ...common,
      kind: "morning",
      localTime: "09:01",
      timezone: "Asia/Shanghai",
      catchUp: false,
    });
    await new ReminderDispatcher(
      f.store,
      async () => {
        calls++;
        return "accepted";
      },
      () => now + 60_000,
    ).tick();
    expect(calls).toBe(1);
    expect(
      later
        .occurrences()
        .find((o) => o.day === "2026-09-24" && o.state === "suppressed")
        ?.reason,
    ).toBe("今天已暂停提醒");
  } finally {
    await f.close();
  }
});

test("取消与渠道调用并发时保留真实尝试结果，旧排期保持取消", async () => {
  const f = await taskFixture();
  try {
    const item = fact();
    f.inventory([item]);
    const now = Date.now();
    const task = observedTasks(f.store)[0]!;
    const id = randomUUID();
    f.store.db.prepare("INSERT INTO plan_revisions VALUES(?,?,?,?,?)").run(
      id,
      null,
      randomUUID(),
      now,
      JSON.stringify({
        id,
        blocks: [{ taskId: task.taskId, start: now - 1000 }],
        taskRevisions: { [task.taskId]: task.revision },
      }),
    );
    f.store.set("tasks.acceptedPlan", id);
    const rules = new ReminderRules(f.store, () => now);
    rules.register(f.deviceId, {
      ...common,
      kind: "start",
      minutesBefore: 0,
      freshnessMinutes: 30,
      resendOnMove: false,
    });
    let complete!: (result: "accepted") => void;
    const channel = new Promise<"accepted">((resolve) => {
      complete = resolve;
    });
    const dispatcher = new ReminderDispatcher(
      f.store,
      () => channel,
      () => now,
    );
    const pending = dispatcher.tick();
    f.inventory([{ ...item, lifecycle: "done" }]);
    expect(rules.occurrences()[0]?.state).toBe("cancelled");
    complete("accepted");
    await pending;
    expect(rules.occurrences()[0]?.state).toBe("cancelled");
    expect(
      (
        f.store.db.prepare("SELECT state FROM reminder_attempts").get() as {
          state: string;
        }
      ).state,
    ).toBe("accepted");
  } finally {
    await f.close();
  }
});

test("已接受的任务开始提醒改期后，仅显式允许时取得第二个投递键", async () => {
  const f = await taskFixture();
  try {
    const item = fact();
    f.inventory([item]);
    const task = observedTasks(f.store)[0]!;
    let now = Date.now();
    const adopt = (start: number) => {
      const id = randomUUID();
      f.store.db.prepare("INSERT INTO plan_revisions VALUES(?,?,?,?,?)").run(
        id,
        null,
        randomUUID(),
        now,
        JSON.stringify({
          id,
          blocks: [{ taskId: task.taskId, start }],
          taskRevisions: { [task.taskId]: task.revision },
        }),
      );
      f.store.set("tasks.acceptedPlan", id);
    };
    adopt(now);
    const rules = new ReminderRules(f.store, () => now);
    rules.register(f.deviceId, {
      ...common,
      kind: "start",
      minutesBefore: 0,
      freshnessMinutes: 30,
      resendOnMove: true,
    });
    let calls = 0;
    const dispatcher = new ReminderDispatcher(
      f.store,
      async () => {
        calls++;
        return "accepted";
      },
      () => now,
    );
    await dispatcher.tick();
    const firstKey = rules.occurrences()[0]!.deliveryKey;
    now += 60_000;
    adopt(now);
    f.store.tx(() => rules.sync());
    expect(rules.occurrences()[0]!.deliveryKey).not.toBe(firstKey);
    await dispatcher.tick();
    expect(calls).toBe(2);
    const second = rules.occurrences()[0]!;
    f.store.db
      .prepare(
        "UPDATE reminder_attempts SET state='outcome_unknown' WHERE delivery_key=?",
      )
      .run(second.deliveryKey);
    second.state = "outcome_unknown";
    f.store.db
      .prepare(
        "UPDATE reminder_occurrences SET state=?,value=? WHERE logical_key=?",
      )
      .run(second.state, JSON.stringify(second), second.logicalKey);
    now += 60_000;
    adopt(now);
    f.store.tx(() => rules.sync());
    expect(rules.occurrences()[0]!.deliveryKey).toBe(second.deliveryKey);
    await dispatcher.tick();
    expect(calls).toBe(2);
  } finally {
    await f.close();
  }
});

test("用户显式稍后提醒可越过默认不补发限制，但仍在有效窗口内", async () => {
  const f = await taskFixture();
  try {
    let now = Date.parse("2026-09-24T01:00:00Z");
    const rules = new ReminderRules(f.store, () => now);
    rules.register(f.deviceId, {
      ...common,
      kind: "morning",
      localTime: "09:01",
      timezone: "Asia/Shanghai",
      catchUp: false,
    });
    const o = rules.occurrences().find((x) => x.day === "2026-09-24")!;
    const delayed = rules.snooze(f.deviceId, o.logicalKey, now + 180_000);
    expect(delayed.deliveryKey).toBe(o.deliveryKey);
    now += 180_000;
    let calls = 0;
    await new ReminderDispatcher(
      f.store,
      async () => {
        calls++;
        return "accepted";
      },
      () => now,
    ).tick();
    expect(calls).toBe(1);
  } finally {
    await f.close();
  }
});

test("确认删除的任务与旧计划重放不能重新取得开始提醒资格", async () => {
  const f = await taskFixture();
  try {
    const item = fact();
    f.inventory([item]);
    const task = observedTasks(f.store)[0]!;
    const now = Date.now();
    const id = randomUUID();
    f.store.db.prepare("INSERT INTO plan_revisions VALUES(?,?,?,?,?)").run(
      id,
      null,
      randomUUID(),
      now,
      JSON.stringify({
        id,
        blocks: [{ taskId: task.taskId, start: now + 60_000 }],
        taskRevisions: { [task.taskId]: task.revision },
      }),
    );
    f.store.set("tasks.acceptedPlan", id);
    const rules = new ReminderRules(f.store, () => now);
    rules.register(f.deviceId, {
      ...common,
      kind: "start",
      minutesBefore: 0,
      freshnessMinutes: 30,
      resendOnMove: false,
    });
    expect(rules.occurrences()[0]?.state).toBe("scheduled");
    f.inventory([], true, []);
    expect(rules.occurrences()[0]?.state).toBe("cancelled");
    f.store.set("tasks.acceptedPlan", id);
    f.store.tx(() => rules.sync());
    let calls = 0;
    await new ReminderDispatcher(
      f.store,
      async () => {
        calls++;
        return "accepted";
      },
      () => now + 60_000,
    ).tick();
    expect(calls).toBe(0);
    expect(rules.occurrences()[0]?.state).toBe("cancelled");
  } finally {
    await f.close();
  }
});
