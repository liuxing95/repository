import { fork, type ChildProcess } from "node:child_process";
import type { Queue } from "@kb/contracts";
import { Jobs } from "./jobs";

// Trusted built-in computation, NOT a security sandbox. Third-party work uses Sandbox.
export class WorkerPool {
  private running = new Map<
    Queue,
    { process: ChildProcess; id: string; fence: number; started: number }
  >();
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly jobs: Jobs,
    readonly entry: string,
    readonly allowed = () => true,
  ) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 200);
    this.timer.unref();
  }
  tick() {
    for (const queue of ["interactive", "notification", "batch"] as const) {
      const active = this.running.get(queue);
      if (active) {
        try {
          this.jobs.active(active.id, active.fence);
          if (!this.allowed() || Date.now() - active.started > 15_000)
            throw new Error("STOP");
        } catch {
          active.process.kill("SIGKILL");
        }
        continue;
      }
      if (!this.allowed()) continue;
      const job = this.jobs.claim(queue);
      if (!job) continue;
      const child = fork(this.entry, [], {
        env: { NODE_ENV: "production", TZ: "UTC" },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: ["--max-old-space-size=64"],
      });
      this.running.set(queue, {
        process: child,
        id: job.id,
        fence: job.fence,
        started: Date.now(),
      });
      let success = false;
      child.on("message", (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          "ok" in message &&
          message.ok === true
        )
          success = true;
      });
      child.on("error", () => {
        success = false;
      });
      child.on("close", (code) => {
        this.running.delete(queue);
        try {
          this.jobs.finish(job.id, job.fence, success && code === 0);
        } catch {
          /* Cancelled or expired results are discarded. */
        }
      });
      child.send({ kind: job.kind });
    }
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all(
      [...this.running.values()].map(
        ({ process: child }) =>
          new Promise<void>((resolve) => {
            child.once("close", () => resolve());
            child.kill("SIGKILL");
          }),
      ),
    );
  }
}
