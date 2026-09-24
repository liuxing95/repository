import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { AcquisitionPlan, Parsed } from "@kb/contracts";
import { AppError } from "../errors";
export type ParseInput = {
  bytes: Buffer;
  kind: AcquisitionPlan["kind"];
  title: string;
  url: string;
  encoding: string;
  path?: string;
  password?: string;
};
export function parseIsolated(
  input: ParseInput,
  signal?: AbortSignal,
): Promise<Parsed> {
  const built = resolve(import.meta.dirname, "ingestion/parser-entry.js");
  const entry = existsSync(built)
    ? built
    : resolve(import.meta.dirname, "../../dist/ingestion/parser-entry.js");
  const service = dirname(dirname(dirname(entry)));
  // macOS Seatbelt denies network and writes; Node permissions also restrict reads.
  // The native canvas dependency is trusted code, never supplied by material.
  const reads = [
    entry,
    resolve(service, "package.json"),
    resolve(service, "../../package.json"),
    resolve(service, "node_modules"),
    resolve(service, "../../node_modules"),
  ]
    .filter(existsSync)
    .map((path) => realpathSync(path));
  return new Promise((resolveResult, reject) => {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
      reject(
        new AppError(
          "UNAVAILABLE",
          503,
          "当前解析器仅在已验证的 macOS 隔离环境启用。",
        ),
      );
      return;
    }
    const profile = parserProfile(reads);
    const child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        profile,
        process.execPath,
        "--permission",
        "--allow-addons",
        ...reads.map((path) => `--allow-fs-read=${path}`),
        "--max-old-space-size=256",
        entry,
      ],
      {
        env: { NODE_ENV: "production", TZ: "UTC" },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let result: Parsed | undefined;
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, 20000);
    signal?.addEventListener("abort", kill, { once: true });
    if (signal?.aborted) kill();
    let output = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 8_100_000) kill();
    });
    child.on("error", () => {
      result = undefined;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      try {
        const line = output
          .split("\n")
          .findLast((line) => line.startsWith("KB_RESULT="));
        const message = JSON.parse(line?.slice(10) ?? "{}");
        if (message.ok) result = message.parsed;
      } catch {
        /* Malformed worker result is rejected. */
      }
      if (code === 0 && result && !signal?.aborted) resolveResult(result);
      else reject(new AppError(signal?.aborted ? "CANCELLED" : "PARSE_FAILED"));
    });
    child.stdin!.on("error", kill);
    child.stdin!.end(
      JSON.stringify({ ...input, bytes: input.bytes.toString("base64") }),
    );
  });
}

export function parserProfile(reads: readonly string[]) {
  const quote = (path: string) => JSON.stringify(path);
  return `(version 1)(allow default)(deny network*)(deny file-write*)(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders") (subpath "/private/tmp"))(allow file-read-metadata)(allow file-read* ${reads.map((path) => `(subpath ${quote(path)})`).join(" ")})(deny process-fork)`;
}
