import type { Settings } from "@kb/contracts";
import { Connection } from "../connection";
import { OperationState } from "../ui/operation-state";
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}
export function renderSettings(
  root: HTMLElement,
  connection: Connection,
  drafts: { budget: string },
) {
  root.replaceChildren();
  root.classList.add("kb-settings");
  const header = el("header");
  header.append(
    el("span", "LOCAL WORKSPACE · 01"),
    el("h2", "工作区与运行治理"),
    el("p", "先连接隔离试点，再逐项开放能力。原 Vault 保持可独立使用。"),
  );
  root.append(header);
  const status = el("div");
  status.className = "kb-status";
  const state = new OperationState(status);
  root.append(status);
  const action = (
    name: string,
    handler: () => Promise<unknown>,
    parent: HTMLElement,
  ) => {
    const button = el("button", name);
    button.type = "button";
    button.addEventListener("click", () => {
      void state.run(handler).catch(() => {});
    });
    parent.append(button);
    return button;
  };
  const pair = el("section");
  pair.append(el("h3", "01 / 连接本机服务"));
  const label = el("label", "一次性配对码");
  const code = el("input");
  code.type = "password";
  code.autocomplete = "off";
  code.placeholder = "粘贴服务终端显示的配对码";
  label.append(code);
  pair.append(label);
  action(
    "配对并检查",
    async () => {
      await connection.pair(code.value.trim());
      code.value = "";
      renderConnected();
    },
    pair,
  );
  root.append(pair);
  const connected = el("section");
  root.append(connected);
  const renderConnected = () => {
    connected.replaceChildren();
    const workspace = connection.workspace;
    if (!workspace) {
      connected.append(
        el("p", "尚未连接。服务与笔记内容分别保存，不会从笔记读取授权。"),
      );
      return;
    }
    connected.append(
      el("h3", "02 / 主设备与能力"),
      el(
        "p",
        `会话角色：${connection.principal?.role} · 策略版本：${workspace.policyVersion} · 主端代次：${workspace.epoch}`,
      ),
    );
    const master = workspace.deviceId === connection.deviceId;
    connected.append(
      el(
        "p",
        master
          ? "当前设备是主端，可提交已授权作业。"
          : workspace.deviceId
            ? "其他设备是主端；本设备不自动接管。"
            : "尚未登记主设备。",
      ),
    );
    action(
      "登记当前设备为主端",
      async () => {
        await connection.claim();
        renderConnected();
      },
      connected,
    );
    action(
      "释放当前主端",
      async () => {
        await connection.release();
        renderConnected();
      },
      connected,
    );
    action(
      "刷新连接状态",
      async () => {
        await connection.refresh();
        renderConnected();
      },
      connected,
    );
    const list = el("ul");
    list.className = "kb-capabilities";
    for (const capability of connection.capabilities) {
      const item = el("li");
      item.append(
        el(
          "strong",
          `${capability.enabled ? "可用" : "未启用"} · ${capability.id}`,
        ),
        el("span", capability.reason),
      );
      list.append(item);
    }
    connected.append(list);
  };
  renderConnected();
  const budget = el("section");
  budget.append(
    el("h3", "03 / 预算与路线"),
    el(
      "p",
      "金额以微美元整数记录（1 美元 = 1,000,000）。未配置额度、价格或业务适配器时，收费调用不会执行。",
    ),
  );
  const budgetLabel = el("label", "可信配置 JSON");
  const editor = el("textarea");
  editor.rows = 12;
  editor.spellcheck = false;
  editor.value = drafts.budget;
  editor.addEventListener("input", () => {
    drafts.budget = editor.value;
  });
  budgetLabel.append(editor);
  budget.append(budgetLabel);
  action(
    "读取配置",
    async () => {
      const original = drafts.budget;
      const received = await connection.settings();
      if (drafts.budget !== original) {
        state.status = "partial";
        state.render({
          message: "配置已读取，但你在等待期间修改了草稿。",
          nextStep: "草稿已保留；保存或另行保留后再读取配置。",
        });
        return;
      }
      drafts.budget = JSON.stringify(received, null, 2);
      editor.value = drafts.budget;
    },
    budget,
  );
  action(
    "保存配置",
    async () => {
      let settings: Settings;
      try {
        settings = JSON.parse(editor.value);
      } catch {
        throw {
          code: "VALIDATION",
          message: "JSON 格式不正确。",
          nextStep: "检查括号和引号后重试。",
        };
      }
      await connection.saveSettings(settings);
      renderConnected();
    },
    budget,
  );
  root.append(budget);
  const jobs = el("section");
  jobs.append(el("h3", "04 / 作业与诊断"));
  const output = el("div");
  const showJobs = async () => {
    const rows = await connection.jobs();
    output.replaceChildren();
    if (!rows.length) {
      output.append(el("p", "暂无作业。可运行一次本地自检。"));
      return;
    }
    for (const job of rows) {
      const row = el("div");
      row.className = "kb-job";
      const labels = {
        queued: "等待执行",
        running: "执行中",
        succeeded: "已完成",
        failed: "执行失败",
        cancelled: "已取消",
      };
      row.dataset.state = job.state;
      row.append(
        el(
          "span",
          `本地自检 · ${labels[job.state]} · 阶段 ${job.stage} · 尝试 ${job.attempt}`,
        ),
      );
      if (job.problem)
        row.append(
          el(
            "p",
            `${job.problem.message} ${job.problem.nextStep} 详情编号：${job.problem.detailId}`,
          ),
        );
      if (job.state === "failed")
        action(
          "重试作业",
          async () => {
            await connection.retryJob(job.id);
            await showJobs();
          },
          row,
        );
      if (["queued", "running"].includes(job.state))
        action(
          "取消作业",
          async () => {
            await connection.cancel(job.id);
            await showJobs();
          },
          row,
        );
      output.append(row);
    }
  };
  action(
    "运行本地自检",
    async () => {
      await connection.createJob();
      try {
        await showJobs();
      } catch {
        state.status = "partial";
        state.render({
          message: "作业已创建，暂时无法刷新列表。",
          nextStep: "点击“刷新作业”查看进度，无需再次提交。",
        });
      }
    },
    jobs,
  );
  action("刷新作业", showJobs, jobs);
  action(
    "查看脱敏诊断",
    async () => {
      const pre = el(
        "pre",
        JSON.stringify(await connection.diagnostics(), null, 2),
      );
      output.replaceChildren(pre);
    },
    jobs,
  );
  action(
    "撤销本机会话",
    async () => {
      await connection.disconnect();
      renderConnected();
    },
    jobs,
  );
  jobs.append(output);
  root.append(jobs);
  return state;
}
