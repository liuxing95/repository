import type { PlanningCandidate, PlanningRequest } from "@kb/contracts";
import type { Connection } from "../connection";
import type { TaskNotesAdapter } from "../tasknotes/adapter";

export function renderPlanReview(
  root: HTMLElement,
  connection: Connection,
  adapter: TaskNotesAdapter,
) {
  root.className = "kb-planning";
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
    const n = document.createElement(tag);
    n.textContent = text;
    return n;
  };
  root.append(
    el("h2", "11 / 安排时间"),
    el(
      "p",
      "先核对 TaskNotes，填写明确的可用时段，再预览差异。时间需带 Z 或 +08:00 等偏移；目前只核对本地时间，尚未连接外部日历。",
    ),
  );
  const form = el("div"),
    status = el("p", "尚未生成建议。"),
    result = el("div");
  status.setAttribute("role", "status");
  root.append(form, status, result);
  const field = (name: string, placeholder = "") => {
    const label = el("label", name),
      input = el("input");
    input.setAttribute("aria-label", name);
    input.placeholder = placeholder;
    label.append(input);
    form.append(label);
    return input;
  };
  const timezone = field("计划时区", "Asia/Shanghai");
  const start = field("可用开始", "2026-09-24T09:00:00+08:00");
  const end = field("可用结束", "2026-09-24T12:00:00+08:00");
  const location = field("可用地点（可空）");
  const device = field("可用设备（可空）");
  const unavailableStart = field("不可用开始（可空）");
  const unavailableEnd = field("不可用结束（可空）");
  const maxNodes = field("最多尝试节点数", "1000");
  const freezeMinutes = field("冻结未来多少分钟", "30");
  const freshnessMs = field("日历核对有效毫秒数", "30000");
  const maxMillis = field("最长求解毫秒（可空，上限 5000）");
  let busy = false,
    candidate: PlanningCandidate | null = null;
  const action = (name: string, fn: () => Promise<void>, parent = form) => {
    const button = el("button", name);
    parent.append(button);
    button.onclick = () => {
      if (busy) return;
      busy = true;
      status.textContent = "处理中…";
      root
        .querySelectorAll<HTMLButtonElement | HTMLInputElement>("button,input")
        .forEach((n) => (n.disabled = true));
      void fn()
        .catch((e: unknown) => {
          const issue = e as { message?: string; nextStep?: string };
          status.textContent = `未完成：${issue.message ?? "请求失败"} ${issue.nextStep ?? ""}`;
        })
        .finally(() => {
          busy = false;
          root
            .querySelectorAll<HTMLButtonElement | HTMLInputElement>(
              "button,input",
            )
            .forEach((n) => (n.disabled = false));
        });
    };
  };
  function show(c: PlanningCandidate) {
    candidate = c;
    result.replaceChildren();
    status.textContent = `${{ complete: "全部排入", partial: "部分排入", "no-window": "需要可用时间", "no-op": "没有实质变化" }[c.status]}。${c.snapshot.coverage.reason}${c.stopReason ? ` ${c.stopReason}。` : ""}`;
    const titles = new Map(c.snapshot.tasks.map((t) => [t.id, t.title]));
    result.append(el("h3", "建议安排"));
    for (const b of c.blocks)
      result.append(
        el(
          "p",
          `${titles.get(b.taskId) ?? b.taskId}：${new Date(b.start).toLocaleString()} — ${new Date(b.end).toLocaleString()}`,
        ),
      );
    result.append(el("h3", "与现有计划的差异"));
    result.append(
      el(
        "p",
        `保留 ${c.diff.kept.length} 项，新增 ${c.diff.added.length} 项，移动 ${c.diff.moved.length} 项，移除 ${c.diff.removed.length} 项。`,
      ),
    );
    if (c.capacityGapMinutes)
      result.append(
        el("p", `明确的容量下界缺口：至少 ${c.capacityGapMinutes} 分钟。`),
      );
    for (const m of c.diff.moved)
      result.append(
        el(
          "p",
          `${titles.get(m.taskId) ?? m.taskId}：${new Date(m.from).toLocaleString()} → ${new Date(m.to).toLocaleString()}；${m.reason}`,
        ),
      );
    result.append(el("h3", "未排项"));
    for (const u of c.unscheduled)
      result.append(
        el("p", `${titles.get(u.taskId) ?? u.taskId}：${u.reason}`),
      );
    if (
      c.status !== "no-op" &&
      c.status !== "no-window" &&
      c.snapshot.coverage.state !== "unknown"
    )
      action(
        "核对后采用此计划",
        async () => {
          await adapter.sync();
          const accepted = await connection.request<{ planId: string }>(
            `/v1/planning/candidates/${c.id}/accept`,
            "POST",
            {},
          );
          status.textContent = `正式计划已采用：${accepted.planId}。请到 Today 核对。`;
          candidate = null;
          result.replaceChildren();
        },
        result,
      );
  }
  function request(): PlanningRequest {
    return {
      timezone: timezone.value,
      windows:
        start.value && end.value
          ? [
              {
                start: start.value,
                end: end.value,
                ...(location.value ? { location: location.value } : {}),
                ...(device.value ? { device: device.value } : {}),
              },
            ]
          : [],
      unavailable:
        unavailableStart.value && unavailableEnd.value
          ? [{ start: unavailableStart.value, end: unavailableEnd.value }]
          : [],
      calendarIds: [],
      policy: {
        maxNodes: Number(maxNodes.value),
        freezeMinutes: Number(freezeMinutes.value),
        freshnessMs: Number(freshnessMs.value),
        ...(maxMillis.value ? { maxMillis: Number(maxMillis.value) } : {}),
      },
    };
  }
  action("核对任务并预览", async () => {
    await adapter.sync();
    show(
      await connection.request<PlanningCandidate>(
        "/v1/planning/candidates",
        "POST",
        request(),
      ),
    );
  });
  action("预览撤销上一次采用", async () => {
    await adapter.sync();
    show(
      await connection.request<PlanningCandidate>("/v1/planning/undo", "POST", {
        request: request(),
      }),
    );
  });
  return { current: () => candidate };
}
