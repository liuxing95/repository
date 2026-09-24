import type { TaskToday } from "@kb/contracts";
import type { Connection } from "../connection";
import type { TaskNotesAdapter } from "../tasknotes/adapter";
import { renderTaskCapture } from "./task-capture";
const labels = {
  inbox: "收集箱",
  todo: "待办",
  "in-progress": "进行中",
  blocked: "阻塞",
  done: "完成",
  cancelled: "取消",
  unmapped: "待映射",
};
export function renderToday(
  root: HTMLElement,
  connection: Connection,
  adapter: TaskNotesAdapter,
  resume: (goalId: string, unitId: string) => Promise<void>,
) {
  root.classList.add("kb-today");
  const el = (tag: string, s: string) => {
    const n = document.createElement(tag);
    n.textContent = s;
    return n;
  };
  root.append(
    el("h3", "10 / Today 与 TaskNotes"),
    el(
      "p",
      "这里显示已核对的任务事实。任务状态与计时请在 TaskNotes 正式入口操作；不会维护第二份勾选状态。",
    ),
  );
  const message = el("p", "尚未读取。"),
    content = document.createElement("div");
  root.append(message, content);
  let busy = false;
  const action = (
    name: string,
    parent: HTMLElement,
    fn: () => Promise<void>,
  ) => {
    const b = document.createElement("button");
    b.textContent = name;
    b.onclick = () => {
      if (busy) return;
      busy = true;
      root.querySelectorAll("button").forEach((b) => (b.disabled = true));
      void fn()
        .catch(
          (e) =>
            (message.textContent =
              e?.message ?? "操作失败，请核对连接与主端。"),
        )
        .finally(() => {
          busy = false;
          root.querySelectorAll("button").forEach((b) => (b.disabled = false));
        });
    };
    parent.append(b);
  };
  async function refresh() {
    const state = await connection.request<TaskToday>("/v1/tasks/today");
    content.replaceChildren();
    message.textContent = `${adapter.lastMessage} 最后确认：${state.observedAt ? new Date(state.observedAt).toLocaleString() : "尚无"}。`;
    for (const risk of state.risks) content.append(el("p", risk));
    if (!state.tasks.length)
      content.append(
        el("p", "暂无受管任务；可确认一个新候选，或预览接管已有 TaskNotes。"),
      );
    content.append(el("h4", "任务事实与时间安排"));
    for (const t of state.tasks) {
      const row = document.createElement("article");
      row.append(
        el("strong", t.fact.title),
        el(
          "p",
          `${labels[t.fact.lifecycle]} · ${{ current: "已核对", conflict: "身份冲突", unknown: "读取未知", deleted: "已确认删除" }[t.sync]} · ${state.plan?.blocks.some((b) => b.taskId === t.taskId) ? "已排时间" : "未排时间"} · ${t.fact.minutes ?? "未知"} 分钟 · 期望 ${t.fact.desiredDay ?? "未填"} · 硬截止 ${t.fact.due ?? "未填"} · ${t.fact.timeEntries.length} 条工作日志`,
        ),
      );
      if (t.sync !== "deleted")
        action("打开 TaskNotes 任务", row, () => adapter.open(t.fact.path));
      const link = state.learningLinks.find((l) => l.taskId === t.taskId);
      if (link)
        action("继续这项学习", row, async () => {
          await resume(link.goalId, link.unitId);
        });
      content.append(row);
    }
    content.append(el("h4", "创建回执"));
    for (const c of state.commands.slice(0, 50)) {
      const row = document.createElement("div");
      row.append(
        el(
          "p",
          `${c.input.title}：${{ queued: "等待本机创建", unknown: "结果未知，只核对不重发", created: "正式任务已确认", conflict: "身份或标记冲突", cancelled: "已取消待创建" }[c.state]}`,
        ),
      );
      if (c.state === "queued") {
        row.append(
          el(
            "p",
            `期望 ${c.input.desiredDay ?? "未填"}；最早 ${c.input.earliestDay ?? "未填"}；硬截止 ${c.input.deadlineDay ?? "未填"}；${c.input.timezone}；${c.input.minutes ?? "未知"} 分钟`,
          ),
        );
        action("重新确认待创建", row, async () => {
          await connection.request(
            `/v1/tasks/commands/${c.id}/confirm`,
            "POST",
            { digest: c.digest },
          );
          await refresh();
        });
      }
      if (c.state === "queued")
        action("取消待创建", row, async () => {
          await connection.request(
            `/v1/tasks/commands/${c.id}/cancel`,
            "POST",
            {},
          );
          await refresh();
        });
      content.append(row);
    }
    if (state.plan) {
      content.append(el("h4", "已采用计划"));
      content.append(
        el(
          "p",
          `采用于 ${state.plan.acceptedAt ? new Date(state.plan.acceptedAt).toLocaleString() : "未记录"}；${state.plan.coverage?.reason ?? "日历覆盖信息未记录"}`,
        ),
      );
      for (const b of state.plan.blocks)
        content.append(
          el(
            "p",
            `${b.kind}：${new Date(b.start).toLocaleString()} — ${new Date(b.end).toLocaleString()}`,
          ),
        );
      for (const r of state.receipts)
        content.append(
          el(
            "p",
            `${{ note: "计划笔记", task: "任务字段", calendar: "日历", reminder: "提醒" }[r.target]}：${{ pending: "待同步", applied: "已同步", failed: "失败", disabled: "未启用" }[r.state]}，版本 ${r.revision}`,
          ),
        );
      for (const u of state.plan.unscheduled ?? [])
        content.append(
          el(
            "p",
            `未排：${state.tasks.find((t) => t.taskId === u.taskId)?.fact.title ?? u.taskId}；${u.reason}`,
          ),
        );
    }
    content.append(
      el(
        "p",
        "进度分开查看：材料收录、任务状态、学习证据、知识审核。计时和任务完成不等于学习掌握。",
      ),
    );
  }
  action("核对 TaskNotes 并刷新 Today", root, async () => {
    await adapter.sync();
    await refresh();
  });
  action("预览已有任务接管", root, async () => {
    const { facts } = await adapter.inventory();
    content.replaceChildren(
      el(
        "p",
        "仅给明确选中的文件补稳定 ID；保留正文和其他字段。列表一次显示前 100 项，接管后可再次预览。",
      ),
    );
    const selected: {
      fact: (typeof facts)[number];
      check: HTMLInputElement;
    }[] = [];
    for (const fact of facts.filter((f) => !f.taskId).slice(0, 100)) {
      const label = document.createElement("label"),
        check = document.createElement("input");
      check.type = "checkbox";
      label.append(
        check,
        document.createTextNode(`${fact.title} · ${fact.path}`),
      );
      content.append(label);
      selected.push({ fact, check });
    }
    action("确认接管所选任务", content, async () => {
      for (const s of selected.filter((s) => s.check.checked))
        await adapter.adopt(s.fact);
      await adapter.sync();
      await refresh();
    });
  });
  renderTaskCapture(root, connection, refresh);
  return { refresh };
}
