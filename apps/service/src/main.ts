import { mkdir, open, readFile, rm, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./storage/store";
import { WorkspaceRegistry } from "./workspace/registry";
import {
  trustedDirectory,
  canonicalDestination,
  inside,
} from "./security/paths";
import { Sessions } from "./http/auth";
import { createServer } from "./http/server";
import { Jobs } from "./runtime/jobs";
import { Budget } from "./runtime/budget";
import { WorkerPool } from "./runtime/worker-pool";
import { diagnostics } from "./runtime/diagnostics";
import { Credentials } from "./security/credentials";
import { Role } from "@kb/contracts";
import { AppError, problem } from "./errors";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const option = (key: string) => {
  const i = args.indexOf(`--${key}`);
  return i >= 0 ? args[i + 1] : undefined;
};
async function main() {
  if (command === "help") {
    console.log(
      "工作区治理服务\npreview --source <Vault> [--data <目录>]\nadopt --source <Vault> --confirm <预览摘要> [--data <目录>]\nserve [--data <目录>] [--port 27124] [--role admin|user|reader|writer]\ndiagnose [--data <目录>]\ncredential --reference <引用> [--data <目录>]  从标准输入读取密钥到系统凭据库",
    );
    return;
  }
  const defaultData =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "KnowledgeTaskCenter")
      : join(homedir(), ".local", "share", "knowledge-task-center");
  const requested = resolve(option("data") ?? defaultData);
  if (command === "preview" || command === "adopt") {
    const source = option("source");
    if (!source)
      throw new AppError(
        "VALIDATION",
        400,
        "请通过 --source 明确指定资料库目录。",
      );
    const root = await trustedDirectory(source);
    const destination = await canonicalDestination(requested);
    if (inside(root, destination) || inside(destination, root))
      throw new AppError("FORBIDDEN", 403, "应用数据目录必须位于资料库之外。");
  }
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const data = await trustedDirectory(requested);
  await chmod(data, 0o700);
  const store = new Store(join(data, "state.db"));
  const registry = new WorkspaceRegistry(store, data);
  if (command !== "serve") {
    try {
      if (command === "preview") {
        const scan = await registry.preview(option("source") ?? "");
        console.log(
          JSON.stringify(
            { ...scan, files: undefined, fileCount: scan.files.length },
            null,
            2,
          ),
        );
      } else if (command === "adopt")
        console.log(
          JSON.stringify(
            await registry.adopt(
              option("source") ?? "",
              option("confirm") ?? "",
            ),
            null,
            2,
          ),
        );
      else if (command === "diagnose")
        console.log(JSON.stringify(diagnostics(registry), null, 2));
      else if (command === "credential") {
        const value = (await readFile("/dev/stdin", "utf8")).trim();
        if (!value || value.length > 8192)
          throw new AppError("VALIDATION", 400);
        new Credentials(registry.get().id).set(
          option("reference") ?? "",
          value,
        );
        console.log("密钥已保存到操作系统凭据库。");
      } else throw new AppError("VALIDATION", 400);
    } finally {
      store.close();
    }
    return;
  }
  const port = Number(option("port") ?? 27124);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new AppError("VALIDATION", 400);
  const lockPath = join(data, "service.lock");
  const lock = await open(lockPath, "wx", 0o600).catch(() => {
    throw new AppError(
      "SERVICE_LOCK",
      409,
      "确认旧进程已退出后，按 README 清理残留锁。",
    );
  });
  await lock.writeFile(String(process.pid));
  await lock.close();
  const sessions = new Sessions(registry);
  const jobs = new Jobs(store);
  const app = createServer(registry, sessions, jobs, port);
  const allowed = () => sessions.hasMasterSession();
  const pool = new WorkerPool(
    jobs,
    join(dirname(fileURLToPath(import.meta.url)), "runtime", "worker-entry.js"),
    allowed,
  );
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await pool.stop();
    await app.close();
    store.close();
    await rm(lockPath, { force: true });
  };
  try {
    if (!store.readOnly) new Budget(registry, jobs).recover();
    await app.listen({ host: "127.0.0.1", port });
    console.log(`治理服务已启动：http://127.0.0.1:${port}。停止：Ctrl+C。`);
    if (!store.readOnly) {
      const code = sessions.issuePairing(Role.parse(option("role") ?? "admin"));
      console.log(`本机配对码（5 分钟内一次有效，请勿复制到笔记）：${code}`);
      pool.start();
    }
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  } catch (error) {
    await stop();
    throw error;
  }
}
main().catch((error) => {
  console.error(JSON.stringify(problem(error)));
  process.exitCode = 1;
});
