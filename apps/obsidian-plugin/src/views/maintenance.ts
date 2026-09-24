import type { Connection } from "../connection";

type Impact = {
  sourceId: string;
  record: { at: number; reason: string } | null;
  evidence: number;
  wikiPages: number;
  researchReportsToReview: number;
  learningAttemptsToReview: number;
  cachedAnswersToReview: number;
  external: string;
};

export function renderMaintenance(root: HTMLElement, connection: Connection) {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  };
  root.append(
    el("h2", "13 / 撤回与维护"),
    el(
      "p",
      "撤回会立即停止本机继续使用这份来源。它不会删除原件、备份、人工任务，已发出的外部内容也无法收回。撤回后不能直接重新授权。",
    ),
  );
  const source = el("input"),
    reason = el("input"),
    check = el("input");
  source.placeholder = "正式来源 ID";
  source.setAttribute("aria-label", "正式来源 ID");
  reason.placeholder = "撤回原因";
  reason.setAttribute("aria-label", "撤回原因");
  check.type = "checkbox";
  const confirmation = el("label", "我已核对来源 ID，确认停止本机继续使用");
  confirmation.prepend(check);
  const inspect = el("button", "查看影响"),
    retract = el("button", "确认撤回来源");
  const status = el("p", "输入正式来源 ID 后查看影响。");
  status.setAttribute("role", "status");
  const details = el("div");
  root.append(source, reason, confirmation, inspect, retract, status, details);
  const show = (impact: Impact) => {
    details.replaceChildren(
      el(
        "p",
        `证据 ${impact.evidence} 条、Wiki 页面 ${impact.wikiPages} 篇、待复核研究报告 ${impact.researchReportsToReview} 份、学习尝试 ${impact.learningAttemptsToReview} 条、缓存答案 ${impact.cachedAnswersToReview} 条。`,
      ),
      el("p", impact.external),
    );
    status.textContent = impact.record
      ? `已于 ${new Date(impact.record.at).toLocaleString()} 撤回：${impact.record.reason}`
      : "尚未撤回；影响数仅供检查，派生内容仍需逐项复核。";
  };
  const fail = (error: unknown) => {
    status.textContent = `操作未完成：${(error as { message?: string }).message ?? "请检查连接与来源 ID"}`;
  };
  inspect.onclick = () => {
    void connection
      .request<Impact>(
        `/v1/sources/${encodeURIComponent(source.value.trim())}/retraction-impact`,
      )
      .then(show)
      .catch(fail);
  };
  retract.onclick = () => {
    if (!check.checked || !reason.value.trim()) {
      status.textContent = "请先填写原因并勾选确认。";
      return;
    }
    void connection
      .request<Impact>(
        `/v1/sources/${encodeURIComponent(source.value.trim())}/retract`,
        "POST",
        { reason: reason.value.trim() },
      )
      .then(async (impact) => {
        await connection.refresh();
        show(impact);
      })
      .catch(fail);
  };
  root.append(
    el(
      "p",
      "完整备份、隔离恢复、退出导出与清除清单需在停止服务后执行维护命令；操作步骤见仓库的“撤回、备份恢复与退出接手说明”。",
    ),
  );
}
