import { execFile } from "node:child_process";
import type { ReminderRule } from "@kb/contracts";

export type ChannelResult = "accepted" | "failed" | "outcome_unknown";
export type LocalChannel = (rule: ReminderRule) => Promise<ChannelResult>;

// argv is data, never AppleScript source. A successful process exit only confirms
// Notification Center accepted the command, not that a person saw it.
export const desktopChannel: LocalChannel = async (rule) => {
  if (process.platform !== "darwin") return "failed";
  const title = "知识与任务中心";
  const body = {
    morning: "请查看今天的计划。",
    evening: "请回顾今天的进展。",
    start: "有计划时间块即将开始，请核对任务。",
    deadline: "有任务接近截止时间，请打开 Today 核对。",
  }[rule.kind];
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      [
        "-e",
        "on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run",
        title,
        body,
      ],
      { timeout: 5000, windowsHide: true },
      (error) =>
        resolve(
          error
            ? "code" in error && error.code === "ENOENT"
              ? "failed"
              : "outcome_unknown"
            : "accepted",
        ),
    );
  });
};
