import type { OperationStatus, Problem } from "@kb/contracts";
const labels: Record<OperationStatus, string> = {
  idle: "等待操作",
  loading: "正在处理",
  empty: "暂无记录",
  partial: "部分完成",
  success: "已完成",
  waiting_approval: "等待授权",
  awaiting_writer: "等待主设备",
  blocked_budget: "预算不足",
  conflict: "内容已变化",
  failed: "操作未完成",
};
export class OperationState {
  private pending?: Promise<unknown>;
  status: OperationStatus = "idle";
  constructor(readonly element: HTMLElement) {
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    this.render();
  }
  render(problem?: Partial<Problem>) {
    this.element.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = labels[this.status];
    this.element.append(title);
    if (problem) {
      const detail = document.createElement("p");
      detail.textContent = [
        problem.message,
        problem.impact,
        problem.nextStep,
        problem.detailId ? `详情编号：${problem.detailId}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      this.element.append(detail);
    }
    this.element.dataset.status = this.status;
  }
  run<T>(action: () => Promise<T>): Promise<T> {
    if (this.pending) return this.pending as Promise<T>;
    this.status = "loading";
    this.render();
    const task = Promise.resolve()
      .then(action)
      .then(
        (value) => {
          if (this.status === "loading") {
            this.status = "success";
            this.render();
          }
          return value;
        },
        (error: unknown) => {
          const p =
            error && typeof error === "object" && "code" in error
              ? (error as Partial<Problem>)
              : {
                  message: "无法连接本地服务。",
                  nextStep: "启动服务后重试；输入已保留。",
                };
          this.status =
            p.code === "BUDGET"
              ? "blocked_budget"
              : p.code === "MASTER"
                ? "awaiting_writer"
                : ["BASELINE", "CONFLICT"].includes(p.code ?? "")
                  ? "conflict"
                  : p.code === "AUTH"
                    ? "waiting_approval"
                    : "failed";
          this.render(p);
          throw error;
        },
      )
      .finally(() => {
        this.pending = undefined;
      });
    this.pending = task;
    return task;
  }
}
