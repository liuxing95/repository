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
  const vaultPage = page;
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
  // Real plugin Writer contract: stop for an open Markdown editor, then resume
  // the same approved candidate and recover through durable receipts.
  const importFile = join(root, "source", `ingestion-${Date.now()}.md`);
  await writeFile(
    importFile,
    "# 来源测试\n\n这是需要逐文件确认的资料 😀。\n权限默认关闭。Node.js C++ parseValue。\n",
  );
  await page
    .getByLabel("入口 URL 或明确授权的本地文件 / 目录绝对路径")
    .fill(importFile);
  await page.getByRole("button", { name: "预览获取范围", exact: true }).click();
  await page
    .getByRole("heading", { name: "默认集合 · 待确认范围", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "确认清单并解析", exact: true })
    .click();
  for (let i = 0; i < 40; i++) {
    await page.getByRole("button", { name: "刷新本批", exact: true }).click();
    await page.waitForTimeout(200);
    if (
      await page
        .getByRole("button", { name: "审核正式导入文件", exact: true })
        .count()
    )
      break;
  }
  await page
    .getByRole("button", { name: "审核正式导入文件", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "正式导入预览", exact: true })
    .waitFor();
  const patchPath = (
    await page.locator(".kb-source-detail summary").first().innerText()
  ).replace(/^新建 /, "");
  await vaultPage.evaluate(async (path) => {
    if (!(await window.app.vault.adapter.exists("KB-Sources")))
      await window.app.vault.createFolder("KB-Sources");
    const file = await window.app.vault.create(path, "人工草稿，不允许覆盖");
    const leaf = window.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    leaf.view.editor.setValue("尚未确认的编辑缓冲区 😀");
  }, patchPath);
  await page
    .getByRole("button", { name: "批准以上文件并写入", exact: true })
    .click();
  await page
    .getByText("目标文件正在编辑，写入已暂停。", { exact: false })
    .waitFor();
  const protectedEditor = await vaultPage.evaluate((path) => {
    let value = null;
    window.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.file?.path === path) value = leaf.view.editor.getValue();
    });
    return value;
  }, patchPath);
  if (protectedEditor !== "尚未确认的编辑缓冲区 😀")
    throw new Error("writer changed editing buffer");
  await page
    .getByRole("heading", { name: "正式导入预览", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(root, "obsidian-ingestion-conflict.png"),
  });
  // Wait for Obsidian to flush this test buffer before closing its leaf.
  for (let i = 0; i < 30; i++) {
    if (
      (await readFile(join(workspace.vaultPath, patchPath), "utf8")) ===
      "尚未确认的编辑缓冲区 😀"
    )
      break;
    await page.waitForTimeout(100);
  }
  await vaultPage.evaluate(async (path) => {
    const leaves = [];
    window.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.file?.path === path) leaves.push(leaf);
    });
    for (const leaf of leaves) leaf.detach();
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Remove only the synthetic conflicting file created by this smoke test.
    const file = window.app.vault.getAbstractFileByPath(path);
    if (file) await window.app.vault.delete(file);
  }, patchPath);
  await page
    .getByRole("button", { name: "审核正式导入文件", exact: true })
    .click();
  await page
    .getByRole("button", { name: "继续已批准的写入", exact: true })
    .click();
  await page.getByText("来源提交已完成。", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "查看文字与定位", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "原文与定位", exact: true })
    .waitFor();
  await page
    .locator(".kb-source-detail details")
    .first()
    .evaluate((node) => {
      node.open = true;
    });
  await page
    .getByRole("heading", { name: "原文与定位", exact: true })
    .scrollIntoViewIfNeeded();
  await page
    .locator(".kb-source-detail details")
    .first()
    .evaluate((node) => node.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: join(root, "obsidian-ingestion.png") });
  const diskSource = await readFile(
    join(workspace.vaultPath, patchPath),
    "utf8",
  );
  if (!diskSource.includes("这是需要逐文件确认的资料 😀。"))
    throw new Error("source readback mismatch");
  await page.getByLabel("问题、中文短词或代码符号").fill("权限");
  await page.getByRole("button", { name: "搜索原文", exact: true }).click();
  await page.locator(".kb-search details").first().waitFor();
  await page
    .locator(".kb-search details")
    .first()
    .evaluate((node) => {
      node.open = true;
    });
  await page
    .getByRole("heading", { name: "06 / 证据检索与问答", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(root, "obsidian-search.png") });
  await page
    .getByRole("button", { name: "回读固定原文", exact: true })
    .first()
    .click();
  await page
    .locator(".kb-search")
    .getByText("相邻上下文", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "整理本次原文证据", exact: true })
    .click();
  await page
    .getByRole("button", { name: "保存为待审核候选", exact: true })
    .waitFor();
  await page
    .getByRole("heading", { name: "有原文支持的证据", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(root, "obsidian-evidence-answer.png") });
  await page
    .getByRole("button", { name: "保存为待审核候选", exact: true })
    .click();
  await page
    .getByText("已保存固定候选；等待场景 04 审核，不会直接写入 Wiki。", {
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: "查看模型状态", exact: true }).click();
  await page
    .getByText("未配置模型；可以搜索和整理原文证据。", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "检查知识与引用", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector(".kb-search").textContent.includes('"issues"'),
  );
  // Scene 04: real user review, candidate save, promotion, dirty editor guard and Vault.process update.
  const wikiTitle = `权限验收 ${Date.now()}`;
  await page.getByLabel("Wiki 页面标题", { exact: true }).fill(wikiTitle);
  await page
    .getByRole("button", { name: "读取待审核候选", exact: true })
    .click();
  await page
    .getByRole("button", { name: "审核保存到候选区", exact: true })
    .first()
    .click();
  await page.getByLabel("确认本次固定变更", { exact: true }).check();
  await page
    .getByRole("button", { name: "批准并应用本次变更", exact: true })
    .click();
  await page
    .getByText("候选区提交完成；可创建新的 Wiki 提升提案。", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "审核提升为 Wiki", exact: true })
    .first()
    .click();
  await page
    .getByRole("heading", { name: "07 / Wiki 候选与审核", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(root, "obsidian-wiki-review.png") });
  const wikiPath = (
    await page.locator(".kb-review-detail summary").first().innerText()
  ).replace(/^新建：/, "");
  await page.getByLabel("确认本次固定变更", { exact: true }).check();
  await page
    .getByRole("button", { name: "批准并应用本次变更", exact: true })
    .click();
  await page
    .getByText("业务提交完成，正式 Wiki 索引就绪。", { exact: true })
    .waitFor();
  const committedWiki = await readFile(
    join(workspace.vaultPath, wikiPath),
    "utf8",
  );
  await vaultPage.evaluate(async (path) => {
    const file = window.app.vault.getAbstractFileByPath(path);
    const leaf = window.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    leaf.view.editor.setValue("人工未保存输入 😀：不允许被提案覆盖");
  }, wikiPath);
  // Wait for disk flush, close, and observe the manual baseline before preparing its reviewed replacement.
  await vaultPage.waitForFunction(
    async (path) =>
      (await window.app.vault.adapter.read(path)).includes("人工未保存输入"),
    wikiPath,
  );
  await vaultPage.evaluate((path) => {
    const leaves = [];
    window.app.workspace.iterateAllLeaves((l) => {
      if (l.view.file?.path === path) leaves.push(l);
    });
    for (const l of leaves) l.detach();
  }, wikiPath);
  await page
    .getByRole("button", { name: "扫描人工修改与影响", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector(".kb-review").textContent.includes("manual-change"),
  );
  await page
    .getByRole("button", { name: "读取待审核候选", exact: true })
    .click();
  await page
    .getByRole("button", { name: "审核提升为 Wiki", exact: true })
    .first()
    .click();
  await page
    .locator(".kb-review-detail")
    .getByText("人工未保存输入 😀：不允许被提案覆盖", { exact: true })
    .waitFor();
  await vaultPage.evaluate(async (path) => {
    const file = window.app.vault.getAbstractFileByPath(path);
    const leaf = window.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    leaf.view.editor.setValue("新一轮未保存缓冲 😀");
  }, wikiPath);
  await page.getByLabel("确认本次固定变更", { exact: true }).check();
  await page
    .getByRole("button", { name: "批准并应用本次变更", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".kb-review-status")
      .textContent.includes("WRITER_EDITING"),
  );
  const buffer = await vaultPage.evaluate((path) => {
    let value;
    window.app.workspace.iterateAllLeaves((l) => {
      if (l.view.file?.path === path) value = l.view.editor.getValue();
    });
    return value;
  }, wikiPath);
  if (buffer !== "新一轮未保存缓冲 😀")
    throw new Error("wiki writer lost editing buffer");
  await page
    .getByRole("heading", { name: "07 / Wiki 候选与审核", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(root, "obsidian-wiki-editing-blocked.png"),
  });
  await vaultPage.waitForFunction(
    async (path) =>
      (await window.app.vault.adapter.read(path)) === "新一轮未保存缓冲 😀",
    wikiPath,
  );
  await vaultPage.evaluate((path) => {
    const leaves = [];
    window.app.workspace.iterateAllLeaves((l) => {
      if (l.view.file?.path === path) leaves.push(l);
    });
    for (const l of leaves) l.detach();
  }, wikiPath);
  await page
    .getByRole("button", { name: "读取待审核候选", exact: true })
    .click();
  await page
    .getByRole("button", { name: "审核提升为 Wiki", exact: true })
    .first()
    .click();
  await page.getByLabel("确认本次固定变更", { exact: true }).check();
  await page
    .getByRole("button", { name: "批准并应用本次变更", exact: true })
    .click();
  await page
    .getByText("业务提交完成，正式 Wiki 索引就绪。", { exact: true })
    .waitFor();
  if (
    (await readFile(join(workspace.vaultPath, wikiPath), "utf8")) !==
    committedWiki
  )
    throw new Error("wiki process update did not match approved bytes");
  await page.getByLabel("搜索正式 Wiki", { exact: true }).fill(wikiTitle);
  await page
    .getByRole("button", { name: "检索已提交 Wiki", exact: true })
    .click();
  await page.locator(".kb-review details").first().waitFor();
  await page
    .getByRole("heading", { name: "07 / Wiki 候选与审核", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(root, "obsidian-wiki-committed.png") });
  // Scene 05: a confirmed brief, explicit snapshot, chapter and independently reviewed report save.
  const research = page.locator(".kb-research");
  const researchTitle = `权限研究验收 ${Date.now()}`;
  await research.getByLabel("研究课题", { exact: true }).fill(researchTitle);
  await research.getByLabel("目标读者", { exact: true }).fill("刚接手的开发者");
  await research
    .getByLabel("必答问题（每行一个，可修改建议）", { exact: true })
    .fill("权限有什么限制？");
  await research
    .getByLabel("必要证据类型（逗号分隔，与来源范围中的 sourceType 对应）", {
      exact: true,
    })
    .fill("text");
  await research
    .getByRole("button", { name: "预览课题清单", exact: true })
    .click();
  await research.getByLabel("确认课题与根预算确认", { exact: true }).check();
  await research
    .getByRole("button", { name: "确认课题与根预算", exact: true })
    .click();
  await research
    .getByRole("button", { name: "准备研究快照差异", exact: true })
    .click();
  await research.getByLabel("确认推进研究快照确认", { exact: true }).check();
  await research
    .getByRole("button", { name: "确认推进研究快照", exact: true })
    .click();
  await research
    .getByRole("button", { name: "生成本章候选", exact: true })
    .click();
  await research
    .getByText("章节已保存在账本，尚未写文件。", { exact: true })
    .waitFor();
  await research
    .getByRole("button", { name: "冻结报告候选", exact: true })
    .click();
  await research
    .getByRole("button", { name: "送入待审核候选", exact: true })
    .waitFor();
  const reportContent = await research.locator("pre").last().innerText();
  for (const marker of [
    "最终快照",
    "问题覆盖",
    "来源及版本",
    "费用摘要",
    "尚未完成",
  ])
    if (!reportContent.includes(marker))
      throw new Error(`research report missing ${marker}`);
  await research
    .getByRole("heading", { name: "报告候选 v1", exact: true })
    .scrollIntoViewIfNeeded();
  await research
    .getByRole("heading", { name: "报告候选 v1", exact: true })
    .locator("..")
    .screenshot({ path: join(root, "obsidian-research-report.png") });
  await research
    .getByRole("button", { name: "送入待审核候选", exact: true })
    .click();
  await research
    .getByText(
      "已登记固定报告候选，尚未写文件。进入 07 / Wiki 候选与审核，先审核保存到候选区。",
      { exact: true },
    )
    .waitFor();
  await page.getByLabel("Wiki 页面标题", { exact: true }).fill(researchTitle);
  await page
    .getByRole("button", { name: "读取待审核候选", exact: true })
    .click();
  const reportRow = page
    .locator(".kb-review div")
    .filter({ has: page.locator("p").filter({ hasText: researchTitle }) })
    .filter({
      has: page.getByRole("button", { name: "审核保存到候选区", exact: true }),
    })
    .last();
  await reportRow
    .getByRole("button", { name: "审核保存到候选区", exact: true })
    .click();
  const reportPath = (
    await page.locator(".kb-review-detail summary").first().innerText()
  ).replace(/^新建：/, "");
  await page.getByLabel("确认本次固定变更", { exact: true }).check();
  await page
    .getByRole("button", { name: "批准并应用本次变更", exact: true })
    .click();
  await page
    .getByText("候选区提交完成；可创建新的 Wiki 提升提案。", { exact: true })
    .waitFor();
  if (
    (await readFile(join(workspace.vaultPath, reportPath), "utf8")) !==
    reportContent
  )
    throw new Error("reviewed research report differs from preview");
  await research
    .getByRole("button", { name: "取消后续研究", exact: true })
    .click();
  await research.getByText(/状态：cancelled/).waitFor();
  // Scene 06: a small selected unit, actual attempt, resume and a human evaluation.
  const learning = page.locator(".kb-learning");
  const learningTitle = `解释权限与批准边界 ${Date.now()}`;
  const learningRef = await vaultPage.evaluate(async () => {
    const c = window.app.plugins.plugins["knowledge-task-center"].connection;
    const result = await c.request("/v1/search", "POST", { query: "权限" });
    return result.hits[0].id;
  });
  await learning
    .getByLabel("希望能解释、验证或完成什么", { exact: true })
    .fill(learningTitle);
  await learning.getByLabel("学习目标版本", { exact: true }).fill("本地试点");
  await learning
    .getByLabel("可观察的完成证据", { exact: true })
    .fill("用自己的话说明未经批准不会写入");
  await learning
    .getByLabel("单元 1 标题", { exact: true })
    .fill("权限边界练习");
  await learning
    .getByLabel("单元 1 必要 Evidence ID（逗号分隔）", { exact: true })
    .fill(learningRef);
  await learning
    .getByLabel("单元 1 叶子验收项（每行 描述|权重，可留空）", { exact: true })
    .fill("解释未批准时的行为|1");
  await learning
    .getByRole("button", { name: "预览学习目标与固定基线", exact: true })
    .click();
  await learning.getByLabel("确认学习基线", { exact: true }).check();
  await learning
    .getByRole("button", { name: "确认学习基线", exact: true })
    .click();
  await learning
    .getByLabel("单元选择：权限边界练习", { exact: true })
    .selectOption("selected");
  await learning
    .getByRole("button", { name: "保存选择：权限边界练习", exact: true })
    .click();
  await learning
    .getByRole("button", { name: "继续学习：权限边界练习", exact: true })
    .click();
  await learning.getByText(/首次开始：先阅读必要资料/).waitFor();
  await learning
    .getByLabel("我的实际表达", { exact: true })
    .fill("我的理解：没有批准不能写入。超时需要核对回执。");
  await learning
    .getByLabel("已使用提示层级", { exact: true })
    .selectOption("1");
  await learning
    .getByLabel("我报告的结果", { exact: true })
    .fill("自报理解，不代表程序通过");
  await learning
    .getByLabel("遗留问题（每行一个）", { exact: true })
    .fill("回执丢失后怎样继续？");
  await learning
    .getByRole("button", { name: "保存我的实际尝试", exact: true })
    .click();
  await learning
    .getByText("尝试已保存，自报不自动计为验收通过。", { exact: true })
    .waitFor();
  await learning
    .getByRole("button", { name: "继续学习：权限边界练习", exact: true })
    .click();
  await learning.getByText(/继续上次活动/).waitFor();
  if (
    !(await learning.locator("pre").last().innerText()).includes(
      "回执丢失后怎样继续",
    )
  )
    throw new Error("learning resume lost unresolved question");
  await learning
    .getByLabel("人工核对结果", { exact: true })
    .selectOption("passed");
  await learning
    .getByLabel("人工核对依据", { exact: true })
    .fill("本次人工阅读原始尝试，确认限定条件保留");
  await learning
    .getByLabel("验收规则版本", { exact: true })
    .fill("desktop-manual-1");
  await learning
    .getByRole("button", { name: "保存人工评价", exact: true })
    .click();
  await learning
    .getByRole("button", { name: "读取学习目标", exact: true })
    .click();
  await learning
    .getByRole("button", { name: `打开目标：${learningTitle}`, exact: true })
    .click();
  await learning.getByText(/证据通过权重 1\/1/).waitFor();
  await learning
    .getByRole("button", { name: "继续学习：权限边界练习", exact: true })
    .click();
  await learning.getByText(/继续上次活动/).waitFor();
  await learning
    .locator(".kb-learning-context")
    .screenshot({ path: join(root, "obsidian-learning-resume.png") });
  await learning
    .getByRole("button", { name: "生成少量复习建议", exact: true })
    .click();
  await learning
    .getByText("先明确复习间隔、窗口和预计时长；不猜测用户参数。", {
      exact: true,
    })
    .waitFor();
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
          "ingestion-preview-freeze-parse",
          "writer-protects-open-editor",
          "approval-resume-receipts-commit",
          "source-locator-readback",
          "keyword-search-and-fixed-evidence",
          "extractive-answer-and-candidate",
          "model-disabled-and-knowledge-health",
          "wiki-candidate-separate-approval",
          "wiki-promotion-and-committed-search",
          "wiki-dirty-editor-buffer-protected",
          "wiki-observation-and-reviewed-process-update",
          "research-brief-and-snapshot-confirmation",
          "research-chapter-and-frozen-report",
          "research-candidate-reviewed-writer-save",
          "research-cancel-preserves-report",
          "learning-confirmed-baseline-and-selected-unit",
          "learning-actual-attempt-and-resume",
          "learning-manual-evidence-separate-from-self-report",
          "learning-no-rules-no-automatic-tasks",
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
