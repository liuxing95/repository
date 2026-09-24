import { randomUUID } from "node:crypto";
import type { Problem } from "@kb/contracts";

export class AppError extends Error {
  constructor(
    public code: string,
    public status = 409,
    public nextStep = "请核对设置后重试。",
    public retryable = false,
  ) {
    super(code);
  }
}
export function problem(error: unknown): Problem {
  const e = error instanceof AppError ? error : new AppError("INTERNAL", 500);
  const labels: Record<string, string> = {
    AUTH: "连接凭据无效或已过期。",
    FORBIDDEN: "当前操作没有相应用途的授权。",
    BUDGET: "预算不足，尚未发起调用。",
    BASELINE: "内容或设置已变化。",
    SCHEMA: "数据版本无法识别，当前仅允许诊断。",
    MASTER: "主设备尚未完成交接。",
    CONFLICT: "发现需要核对的冲突。",
    VALIDATION: "输入不符合要求。",
    UNAVAILABLE: "所需能力尚未通过验证。",
  };
  const nextSteps: Record<string, string> = {
    AUTH: "重新获取本机配对码并连接。",
    FORBIDDEN: "请配置管理员核对角色、用途和来源授权。",
    BUDGET: "核对额度、价格有效期和待结算调用后重试。",
    MASTER: "在原主设备停止作业并完成费用核对，再释放主端。",
    BASELINE: "刷新当前设置，核对差异后重新提交。",
    SCHEMA: "保留数据并导出诊断，使用匹配数据版本的服务。",
    UNAVAILABLE: "检查本地环境；尚未接入的业务能力保持关闭。",
  };
  return {
    code: e.code,
    message: labels[e.code] ?? "操作未完成。",
    impact: "已有数据保留，本次操作未确认完成。",
    nextStep:
      e.nextStep === "请核对设置后重试。"
        ? (nextSteps[e.code] ?? e.nextStep)
        : e.nextStep,
    retryable: e.retryable,
    detailId: randomUUID(),
  };
}
