import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors";

export const SANDBOX_IMAGE =
  "node:24.14.1-alpine@sha256:8510330d3eb72c804231a834b1a8ebb55cb3796c3e4431297a24d246b8add4d5";
const exec = promisify(execFile);
export class Sandbox {
  async available() {
    try {
      const { stdout } = await exec(
        "docker",
        ["image", "inspect", SANDBOX_IMAGE, "--format", "{{.Id}}"],
        { timeout: 5000, maxBuffer: 4096 },
      );
      return stdout.trim().startsWith("sha256:");
    } catch {
      return false;
    }
  }
  // Called only by trusted adapters. No image, mounts, env or Docker flags from content.
  async run(program: string, input: Buffer, timeoutMs = 10_000) {
    if (!(await this.available())) throw new AppError("UNAVAILABLE", 503);
    if (
      input.length > 2_000_000 ||
      Buffer.byteLength(program) > 32_768 ||
      timeoutMs > 15_000 ||
      timeoutMs < 100
    )
      throw new AppError("VALIDATION", 400);
    const root = await mkdtemp(join(tmpdir(), "kb-sandbox-"));
    const source = join(root, "input");
    const output = join(root, "output");
    const name = `kb-worker-${randomUUID()}`;
    try {
      await mkdir(source, { mode: 0o755 });
      await mkdir(output, { mode: 0o777 });
      await chmod(output, 0o777);
      await writeFile(join(source, "worker.cjs"), program, { mode: 0o444 });
      await writeFile(join(source, "data"), input, { mode: 0o444 });
      const args = [
        "run",
        "--rm",
        "--name",
        name,
        "--pull=never",
        "--read-only",
        "--network=none",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=32",
        "--memory=128m",
        "--memory-swap=128m",
        "--cpus=1",
        "--user=65534:65534",
        "--ulimit",
        "nofile=256:256",
        "--ulimit",
        "fsize=2048:2048",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=8388608",
        "--mount",
        `type=bind,src=${source},dst=/input,readonly`,
        "--mount",
        `type=bind,src=${output},dst=/output`,
        SANDBOX_IMAGE,
        "node",
        "--max-old-space-size=64",
        "/input/worker.cjs",
      ];
      await new Promise<void>((resolve, reject) => {
        const child = spawn("docker", args, {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let length = 0;
        let exceeded = false;
        const timer = setTimeout(() => {
          exceeded = true;
          child.kill("SIGKILL");
          void exec("docker", ["rm", "-f", name], { timeout: 5000 }).catch(
            () => {},
          );
        }, timeoutMs);
        const onData = (chunk: Buffer) => {
          length += chunk.length;
          if (length > 64_000) {
            exceeded = true;
            child.kill("SIGKILL");
          }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", () => {
          clearTimeout(timer);
          reject(new AppError("UNAVAILABLE", 503));
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          if (code === 0 && !exceeded) resolve();
          else
            reject(new AppError(exceeded ? "SANDBOX_LIMIT" : "SANDBOX_FAILED"));
        });
      });
      const files: Record<string, Buffer> = {};
      let total = 0;
      for (const name of await readdir(output)) {
        const path = join(output, name);
        const stat = await lstat(path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size > 2_000_000 ||
          Object.keys(files).length >= 20
        )
          throw new AppError("FORBIDDEN", 403);
        total += stat.size;
        if (total > 4_000_000) throw new AppError("SANDBOX_LIMIT");
        files[name] = await readFile(path);
      }
      return files;
    } finally {
      // Always remove the container before trusting or deleting its output directory.
      await exec("docker", ["rm", "-f", name], {
        timeout: 5000,
        maxBuffer: 4096,
      }).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }
}
