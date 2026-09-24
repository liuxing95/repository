import type {
  ReminderOccurrence,
  ReminderRule,
  ReminderRuleInput,
} from "@kb/contracts";
import type { Connection } from "../connection";

type Listing = {
  rules: ReminderRule[];
  occurrences: ReminderOccurrence[];
  reviewedUnknownKeys: string[];
  pausedToday: boolean;
  paused: boolean;
  executor: string;
};

export function renderReminders(root: HTMLElement, connection: Connection) {
  root.className = "kb-reminders";
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, value = "") => {
    const node = document.createElement(tag);
    node.textContent = value;
    return node;
  };
  root.append(
    el("h2", "12 / 本机提醒"),
    el(
      "p",
      "规则由本机服务执行。电脑关机、服务停止或系统通知不可用时无法提醒；渠道接受不代表手机送达或已读。启用任务提醒前，请检查 TaskNotes 是否已有同类提醒，避免两边重复。",
    ),
  );
  const form = el("div"),
    status = el("p", "尚未读取提醒。"),
    list = el("div");
  status.setAttribute("role", "status");
  root.append(form, status, list);
  const kind = el("select"),
    options = [
      ["morning", "晨间查看计划"],
      ["evening", "晚间复盘"],
      ["start", "任务开始"],
      ["deadline", "截止风险"],
    ] as const;
  for (const [value, label] of options) {
    const o = el("option", label);
    o.value = value;
    kind.append(o);
  }
  const labeled = (label: string, initial: string) => {
    const wrap = el("label", label),
      input = el("input");
    input.value = initial;
    input.setAttribute("aria-label", label);
    wrap.append(input);
    form.append(wrap);
    return input;
  };
  const kindLabel = el("label", "提醒类型");
  kind.setAttribute("aria-label", "提醒类型");
  kindLabel.append(kind);
  form.append(kindLabel);
  const clock = labeled("当地时间（晨间／晚间，HH:mm）", "09:00");
  const zone = labeled(
    "时区（晨间／晚间）",
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const before = labeled("提前分钟数（任务开始／截止）", "0");
  const freshness = labeled("任务事实最多滞后分钟数", "30");
  const late = labeled("最多迟到分钟数", "15");
  const quietStart = labeled("勿扰开始（可空，HH:mm）", "");
  const quietEnd = labeled("勿扰结束（可空，HH:mm）", "");
  for (const input of [clock, quietStart, quietEnd]) input.type = "time";
  for (const input of [before, freshness, late]) input.type = "number";
  before.min = "0";
  freshness.min = "1";
  late.min = "0";
  const resendLabel = el("label", "任务改期后允许再次提醒"),
    resend = el("input");
  resend.type = "checkbox";
  resendLabel.append(resend);
  form.append(resendLabel);
  const catchUpLabel = el("label", "补发当天遗漏的查看提醒（仅在迟到窗口内）"),
    catchUp = el("input");
  catchUp.type = "checkbox";
  catchUpLabel.append(catchUp);
  form.append(catchUpLabel);
  const updateFields = () => {
    const fixed = kind.value === "morning" || kind.value === "evening";
    for (const input of [clock, zone]) input.parentElement!.hidden = !fixed;
    for (const input of [before, freshness, resend])
      input.parentElement!.hidden = fixed;
    catchUpLabel.hidden = !fixed;
  };
  kind.onchange = updateFields;
  updateFields();
  const overlapLabel = el(
      "label",
      "我已核对 TaskNotes 的同类提醒，不会重复开启",
    ),
    overlap = el("input");
  overlap.type = "checkbox";
  overlapLabel.append(overlap);
  form.append(overlapLabel);
  const refresh = el("button", "读取提醒"),
    create = el("button", "登记本机提醒"),
    pause = el("button", "暂停今天的提醒");
  form.append(refresh, create, pause);
  const act = (fn: () => Promise<void>) => {
    status.textContent = "处理中…";
    void fn().catch((e: unknown) => {
      status.textContent = `未完成：${(e as { message?: string }).message ?? "请求失败"}`;
    });
  };
  const load = async () => {
    const data = await connection.request<Listing>("/v1/reminders");
    status.textContent = data.paused
      ? "检测到提醒账本恢复或栅栏不一致：已暂停发送，先核对恢复。"
      : data.pausedToday
        ? "今天的提醒已暂停；已发通知无法撤回。"
        : data.executor;
    pause.disabled = data.pausedToday || data.paused;
    list.replaceChildren(el("h3", "已登记规则"));
    for (const rule of data.rules) {
      const row = el(
        "p",
        `${options.find(([id]) => id === rule.kind)?.[1]} · ${rule.enabled ? "已开启" : "已关闭"} · ${rule.kind === "morning" || rule.kind === "evening" ? `${rule.timezone} ${rule.localTime}` : `提前 ${rule.minutesBefore} 分钟`}`,
      );
      if (rule.enabled) {
        const off = el("button", "关闭此规则");
        off.onclick = () =>
          act(async () => {
            await connection.request(
              `/v1/reminders/rules/${rule.id}/disable`,
              "POST",
              {},
            );
            await load();
          });
        row.append(off);
      }
      list.append(row);
    }
    list.append(el("h3", "最近排期与结果"));
    for (const o of [...data.occurrences]
      .sort(
        (a, b) =>
          Math.abs(a.dueAt - Date.now()) - Math.abs(b.dueAt - Date.now()),
      )
      .slice(0, 30)) {
      const rule = data.rules.find((r) => r.id === o.ruleId);
      const row = el(
        "p",
        `${rule?.kind ?? "提醒"} · ${new Date(o.dueAt).toLocaleString()} · ${o.state}${o.reason ? ` · ${o.reason}` : ""}`,
      );
      if (o.state === "scheduled") {
        const later = el("button", "10 分钟后提醒");
        later.onclick = () =>
          act(async () => {
            await connection.request(
              `/v1/reminders/${o.logicalKey}/snooze`,
              "POST",
              { until: Date.now() + 600_000 },
            );
            await load();
          });
        row.append(later);
      }
      if (o.state === "outcome_unknown") {
        if (data.reviewedUnknownKeys.includes(o.deliveryKey))
          row.append(" · 已人工核对，仍未知且不重发");
        else {
          const review = el("button", "已核对并接受结果未知");
          review.onclick = () =>
            act(async () => {
              await connection.request(
                `/v1/reminders/${o.logicalKey}/review-unknown`,
                "POST",
                {},
              );
              await load();
            });
          row.append(review);
        }
      }
      list.append(row);
    }
  };
  refresh.onclick = () => act(load);
  pause.onclick = () =>
    act(async () => {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const day = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(Date.now());
      await connection.request("/v1/reminders/pause-today", "POST", {
        day,
        timezone,
      });
      await load();
    });
  create.onclick = () =>
    act(async () => {
      if (!overlap.checked)
        throw new Error("请先核对 TaskNotes 是否已有同类提醒。");
      const common = {
        enabled: true,
        overlapReviewed: true,
        maxLateMinutes: Number(late.value),
        quietStart: quietStart.value || null,
        quietEnd: quietEnd.value || null,
      } as const;
      const value: ReminderRuleInput =
        kind.value === "morning" || kind.value === "evening"
          ? {
              ...common,
              kind: kind.value,
              localTime: clock.value,
              timezone: zone.value,
              catchUp: catchUp.checked,
            }
          : ({
              ...common,
              kind: kind.value as "start" | "deadline",
              minutesBefore: Number(before.value),
              freshnessMinutes: Number(freshness.value),
              resendOnMove: resend.checked,
            } as ReminderRuleInput);
      await connection.request("/v1/reminders/rules", "POST", value);
      await load();
    });
  if (connection.principal) act(load);
}
