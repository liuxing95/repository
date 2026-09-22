import type { WikiChangeSet } from "@kb/contracts";
export function recoverySummary(c: WikiChangeSet) {
  return {
    state: c.state,
    applied: c.receipts,
    remaining: c.patches
      .filter((p) => !c.receipts.includes(p.sequence))
      .map((p) => p.sequence),
    message:
      c.state === "committed"
        ? c.destination === "wiki"
          ? "业务提交完成；Wiki 索引已就绪。"
          : "候选区业务提交完成；不进入正式索引。"
        : c.receipts.length
          ? "提交未完成；已有部分文件落盘，正式知识版本尚未推进。"
          : "尚未完整提交。回执丢失时会按批准后的哈希识别已应用文件。",
  };
}
