import { expect, test } from "vitest";
import { fixture } from "../helpers";
import { ReminderRules } from "../../apps/service/src/reminders/rules";
import { localClock } from "../../apps/service/src/reminders/identity";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const Database = createRequire(
  new URL("../../apps/service/package.json", import.meta.url),
)("better-sqlite3") as typeof import("better-sqlite3");

test.skipIf(process.env.KB_TEST_NOTIFICATION !== "1")(
  "Obsidian 未运行时，独立服务经真实 macOS 通知命令接受一条提醒",
  async () => {
    const f = await fixture();
    let service: ReturnType<typeof spawn> | undefined;
    try {
      const now = Date.now();
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      new ReminderRules(f.store, () => now).register(f.deviceId, {
        kind: "morning",
        localTime: localClock(now, timezone),
        timezone,
        catchUp: true,
        enabled: true,
        overlapReviewed: true,
        maxLateMinutes: 15,
        quietStart: null,
        quietEnd: null,
      });
      f.store.close();
      service = spawn(
        process.execPath,
        [
          "apps/service/dist/main.js",
          "serve",
          "--data",
          f.data,
          "--port",
          "27841",
        ],
        { stdio: "ignore" },
      );
      let attempt: { state: string; detail: string } | undefined;
      for (let i = 0; i < 30; i++) {
        const db = new Database(join(f.data, "state.db"), { readonly: true });
        try {
          attempt = db
            .prepare("SELECT state,detail FROM reminder_attempts")
            .get() as typeof attempt;
        } finally {
          db.close();
        }
        if (attempt?.state === "accepted" || service.exitCode !== null) break;
        await delay(200);
      }
      expect(service.exitCode).toBeNull();
      if (!attempt) throw new Error("独立服务没有登记本机通知尝试。");
      expect(attempt.state).toBe("accepted");
      expect(attempt.detail).toContain("未证明用户收到");
    } finally {
      if (service && service.exitCode === null) {
        service.kill("SIGTERM");
        await new Promise<void>((resolve) =>
          service!.once("exit", () => resolve()),
        );
      }
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
