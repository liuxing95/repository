import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fixture } from "../helpers";

// Run after build in pnpm check; source-only tests do not catch emitted entry paths.
test.skipIf(process.env.KB_TEST_BUILT !== "1")(
  "built service starts the actual emitted worker and shuts down cleanly",
  async () => {
    const f = await fixture();
    const socket = createServer();
    await new Promise<void>((resolve) =>
      socket.listen(0, "127.0.0.1", resolve),
    );
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const child = spawn(
      process.execPath,
      [
        "apps/service/dist/main.js",
        "serve",
        "--data",
        f.data,
        "--port",
        String(port),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
        child.once("exit", () => reject(new Error("service exited")));
      });
      const headers = {
        "content-type": "application/json",
        authorization: `Bearer ${f.token}`,
        "x-policy-version": "1",
        "x-operation-key": crypto.randomUUID(),
      };
      const res = await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          operationKey: "built-worker-test",
          queue: "interactive",
          kind: "diagnostic-check",
        }),
      });
      expect(res.status).toBe(200);
      const job = (await res.json()) as { id: string };
      for (let n = 0; n < 60 && f.jobs.get(job.id).state !== "succeeded"; n++)
        await new Promise((r) => setTimeout(r, 50));
      expect(f.jobs.get(job.id).state).toBe("succeeded");
    } finally {
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
      await f.close();
    }
  },
);

test.skipIf(process.env.KB_TEST_BUILT !== "1")(
  "invalid data directory cannot write into the source vault during preview",
  async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stat, symlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const f = await fixture();
    try {
      const alias = join(f.root, "source-alias");
      await symlink(f.source, alias);
      await expect(
        promisify(execFile)(process.execPath, [
          "apps/service/dist/main.js",
          "preview",
          "--source",
          f.source,
          "--data",
          join(alias, "new-state"),
        ]),
      ).rejects.toThrow();
      await expect(stat(join(f.source, "new-state"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await f.close();
    }
  },
);
