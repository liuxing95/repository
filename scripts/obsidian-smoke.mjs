import { chromium } from "@playwright/test";
import { mkdir, writeFile, cp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";

// Uses a synthetic vault and separate application profile; never opens the user's vault.
const root = resolve(".context/runtime-validation");
await mkdir(join(root, "source"), { recursive: true });
await writeFile(
  join(root, "source", "welcome.md"),
  "# 治理测试\n\n这是独立的合成测试资料。\n",
);
const data = join(root, "data");
function cli(args) {
  const r = spawnSync(
    process.execPath,
    ["apps/service/dist/main.js", ...args, "--data", data],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}
let workspace;
try {
  workspace = JSON.parse(await readFile(join(root, "workspace.json"), "utf8"));
} catch {
  const preview = cli(["preview", "--source", join(root, "source")]);
  workspace = cli([
    "adopt",
    "--source",
    join(root, "source"),
    "--confirm",
    preview.digest,
  ]);
  await writeFile(join(root, "workspace.json"), JSON.stringify(workspace));
}
const config = join(workspace.vaultPath, ".obsidian");
await mkdir(join(config, "plugins", "knowledge-task-center"), {
  recursive: true,
});
await cp(
  "apps/obsidian-plugin/dist",
  join(config, "plugins", "knowledge-task-center"),
  { recursive: true },
);
await writeFile(
  join(config, "community-plugins.json"),
  JSON.stringify(["knowledge-task-center"]),
);
await writeFile(
  join(config, "app.json"),
  JSON.stringify({ alwaysUpdateLinks: true }),
);
const profile = join(root, "obsidian-profile");
await mkdir(profile, { recursive: true });
await writeFile(
  join(profile, "obsidian.json"),
  JSON.stringify({
    vaults: {
      a123456789abcdef: {
        path: workspace.vaultPath,
        ts: Date.now(),
        open: true,
      },
    },
  }),
);
const service = spawn(
  process.execPath,
  ["apps/service/dist/main.js", "serve", "--data", data],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let child, browser;
async function stop(process) {
  if (!process || process.exitCode !== null) return;
  await new Promise((resolve) => {
    process.once("exit", resolve);
    process.kill("SIGTERM");
  });
}
try {
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("pairing timeout")),
      10_000,
    );
    service.stdout.on("data", (buffer) => {
      const match = buffer.toString().match(/本机配对码[^：]*：([\w-]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    service.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("service exited"));
    });
  });
  child = spawn(
    "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    [`--user-data-dir=${profile}`, "--remote-debugging-port=0"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("debug endpoint timeout")),
      15000,
    );
    child.stderr.on("data", (buffer) => {
      const match = buffer
        .toString()
        .match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.on("error", reject);
  });
  browser = await chromium.connectOverCDP(endpoint);
  let page = browser.contexts()[0].pages()[0];
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("BROWSER ERROR", m.text());
  });
  await page.waitForFunction(
    () => window.app?.plugins?.plugins["knowledge-task-center"]?.connection,
  );
  await page.waitForFunction(() => window.app.workspace.layoutReady);
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.app.setting.open();
    window.app.setting.openTabById("knowledge-task-center");
  });
  await page.waitForTimeout(500);
  for (const candidate of browser.contexts()[0].pages()) {
    if (await candidate.locator(".kb-settings").count()) {
      page = candidate;
      break;
    }
  }
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByLabel("一次性配对码").fill(code);
  await page.getByRole("button", { name: "配对并检查", exact: true }).click();
  await page.getByText("会话角色：admin", { exact: false }).waitFor();
  if (
    !(await page
      .getByText("当前设备是主端，可提交已授权作业。", { exact: true })
      .count())
  ) {
    await page
      .getByRole("button", { name: "登记当前设备为主端", exact: true })
      .click();
    await page
      .getByText("当前设备是主端，可提交已授权作业。", { exact: true })
      .waitFor();
  }
  await page.getByRole("button", { name: "读取配置", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".kb-settings textarea")
      .value.includes("schemaVersion"),
  );
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".kb-status").dataset.status === "success",
  );
  await page.getByRole("button", { name: "运行本地自检", exact: true }).click();
  await page.locator(".kb-job").first().waitFor();
  for (let i = 0; i < 30; i++) {
    await page.getByRole("button", { name: "刷新作业", exact: true }).click();
    await page.waitForTimeout(200);
    if (
      (await page.locator(".kb-job").first().getAttribute("data-state")) ===
      "succeeded"
    )
      break;
  }
  if (
    (await page.locator(".kb-job").first().getAttribute("data-state")) !==
    "succeeded"
  )
    throw new Error("self-check did not complete");
  await page
    .getByRole("heading", { name: "工作区与运行治理", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(root, "obsidian-governance.png") });
  await page.getByRole("button", { name: "查看脱敏诊断", exact: true }).click();
  await page.locator(".kb-settings pre").waitFor();
  const diagnostics = await page.locator(".kb-settings pre").innerText();
  if (diagnostics.includes(workspace.vaultPath) || diagnostics.includes(code))
    throw new Error("diagnostic leak");
  await page
    .getByRole("button", { name: "查看脱敏诊断", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(root, "obsidian-diagnostics.png") });
  await writeFile(
    join(root, "app-info.json"),
    JSON.stringify(
      {
        title: await page.title(),
        checks: [
          "plugin-load",
          "pair",
          "master-claim",
          "read-save-settings",
          "worker-success",
          "redacted-diagnostics",
        ],
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  if (errors.length) throw new Error("renderer errors detected");
  await page.getByRole("button", { name: "释放当前主端", exact: true }).click();
  await page.getByText("尚未登记主设备。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "撤销本机会话", exact: true }).click();
  await page
    .getByText("尚未连接。服务与笔记内容分别保存，不会从笔记读取授权。", {
      exact: true,
    })
    .waitFor();
  console.log(
    "Obsidian real desktop smoke passed: pairing, master, settings, process job, diagnostics, release, revoke.",
  );
} catch (error) {
  if (browser) {
    for (const candidate of browser.contexts()[0].pages()) {
      console.log(
        "FAILED PAGE",
        candidate.url(),
        (await candidate.locator("body").innerText()).slice(-6000),
      );
    }
  }
  throw error;
} finally {
  if (browser) await browser.close();
  await stop(child);
  await stop(service);
}
