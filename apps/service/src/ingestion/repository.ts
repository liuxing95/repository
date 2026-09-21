import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { lstat, access } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AcquisitionPlan } from "@kb/contracts";
import { AppError } from "../errors";
import { fetchScoped } from "./fetcher";
import { listGranted, readGranted } from "./file-reader";
const exec = promisify(execFile);
const git = async (root: string, args: string[]) =>
  (
    await exec(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        root,
        ...args,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: "/nonexistent",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
        timeout: 5000,
        maxBuffer: 2_000_000,
      },
    )
  ).stdout.trim();
export async function localRevision(root: string, ref: string) {
  if (!/^[\w./-]+$/.test(ref) || ref.startsWith("-"))
    throw new AppError("VALIDATION", 400);
  try {
    const directory = await lstat(join(root, ".git"));
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("EXTERNAL_GIT_METADATA");
    for (const path of ["commondir", "objects/info/alternates"]) {
      const exists = await access(join(root, ".git", path)).then(
        () => true,
        () => false,
      );
      if (exists) throw new Error("EXTERNAL_GIT_METADATA");
    }
    const gitRoot = join(root, ".git");
    for (const path of await listGranted(gitRoot, 20000)) {
      if ((await lstat(join(gitRoot, path))).isSymbolicLink())
        throw new Error("EXTERNAL_GIT_METADATA");
    }
    const config = (await readGranted(gitRoot, "config", 65536)).toString(
      "utf8",
    );
    if (/^\s*\[\s*include(?:If)?\b/im.test(config))
      throw new Error("EXTERNAL_GIT_METADATA");
    const commit = await git(root, [
      "rev-parse",
      "--verify",
      `${ref}^{commit}`,
    ]);
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("INVALID");
    const tree = await git(root, ["ls-tree", "-r", "-z", commit]);
    return {
      commit,
      files: new Map(
        tree
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const [header, path] = line.split("\t");
            const [mode, , hash] = header!.split(" ");
            return [path!, { mode: mode!, hash: hash! }];
          }),
      ),
    };
  } catch {
    return {
      commit: null,
      files: new Map<string, { mode: string; hash: string }>(),
    };
  }
}
export function gitBlob(bytes: Buffer) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}
export function excludeCode(
  path: string,
  sourceType: AcquisitionPlan["sourceType"],
) {
  const parts = path.split("/");
  if (
    parts.some((p) =>
      [
        ".git",
        ".obsidian",
        "KB-Sources",
        "KB-Wiki",
        "KB-Candidates",
        "KB-Plans",
        "node_modules",
        ".env",
      ].includes(p),
    )
  )
    return "排除内部、依赖或凭据目录";
  if (
    sourceType === "source" &&
    parts.some((p) => ["dist", "build", "coverage"].includes(p))
  )
    return "源码模式排除构建产物；研究发布包请选择 artifact";
  return null;
}
export function codeGap(path: string, bytes: Buffer) {
  if (
    bytes
      .subarray(0, 200)
      .toString()
      .startsWith("version https://git-lfs.github.com/spec/v1")
  )
    return "LFS_POINTER：只取得指针，未取得大文件。";
  if (bytes.includes(0)) return "BINARY：原件保留，未解析二进制。";
  if (basename(path) === ".gitmodules")
    return "SUBMODULE：未自动拉取子模块，需独立授权。";
  return null;
}
export async function remoteRevision(
  plan: AcquisitionPlan,
  signal: AbortSignal,
) {
  const url = new URL(plan.entry);
  const match = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (url.hostname !== "github.com" || !match)
    throw new AppError(
      "VALIDATION",
      400,
      "仓库地址请使用 https://github.com/owner/repo。",
    );
  const repo = `${match[1]}/${match[2]}`;
  const response = await fetchScoped(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(plan.ref)}`,
    plan,
    signal,
  );
  const commit = (JSON.parse(response.body.toString()) as { sha?: string }).sha;
  if (!commit || !/^[a-f0-9]{40}$/.test(commit))
    throw new AppError("FETCH_FAILED");
  const treeResponse = await fetchScoped(
    `https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`,
    plan,
    signal,
    plan.maxBytes - response.body.length,
  );
  const tree = JSON.parse(treeResponse.body.toString()) as {
    truncated: boolean;
    tree: { path: string; mode: string; type: string }[];
  };
  return {
    repo,
    commit,
    tree: tree.tree,
    truncated: tree.truncated,
    bytes: response.body.length + treeResponse.body.length,
  };
}
