import { createRequire } from "node:module";
import { expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function taskTodaySmoke({ page, vaultPage, root }) {
  const ui = page.locator(".kb-today"),
    title = `普通任务 ${Date.now()}`,
    checks = [];
  await vaultPage.waitForFunction(() =>
    window.app.plugins.plugins.tasknotes?.api?.lifecycle.isReady(),
  );
  const unmanaged = await vaultPage.evaluate(async () => {
    const app = window.app,
      task = await app.plugins.plugins.tasknotes.api.tasks.create({
        title: `待接管 ${Date.now()}`,
        status: "open",
        timeEstimate: 20,
        details: "合成正文，接管不得改变。",
        customFrontmatter: { unknownFixture: "keep" },
      });
    return {
      path: task.path,
      title: task.title,
      before: await app.vault.read(app.vault.getAbstractFileByPath(task.path)),
    };
  });
  await expect
    .poll(
      () =>
        vaultPage.evaluate(async (path) => {
          try {
            return (
              await window.app.plugins.plugins[
                "knowledge-task-center"
              ].tasks.inventory()
            ).facts.some((f) => f.path === path);
          } catch {
            return false;
          }
        }, unmanaged.path),
      { timeout: 20000 },
    )
    .toBe(true);
  await ui
    .getByRole("button", { name: "预览已有任务接管", exact: true })
    .click();
  await ui
    .getByLabel(`${unmanaged.title} · ${unmanaged.path}`, { exact: true })
    .check();
  await ui
    .getByRole("button", { name: "确认接管所选任务", exact: true })
    .click();
  await expect
    .poll(
      () =>
        vaultPage.evaluate(async (path) => {
          const s =
            await window.app.plugins.plugins[
              "knowledge-task-center"
            ].connection.request("/v1/tasks/today");
          return s.tasks.some(
            (t) => t.fact.path === path && t.sync === "current",
          );
        }, unmanaged.path),
      { timeout: 20000 },
    )
    .toBe(true);
  const adopted = await vaultPage.evaluate(
    async (path) =>
      await window.app.vault.read(window.app.vault.getAbstractFileByPath(path)),
    unmanaged.path,
  );
  if (adopted.replace(/^taskId: .*\n/m, "") !== unmanaged.before)
    throw Error("Adoption changed unknown fields or body");
  await vaultPage.evaluate(
    async (path) =>
      await window.app.plugins.plugins.tasknotes.api.tasks.setStatus(
        path,
        "done",
      ),
    unmanaged.path,
  );
  checks.push("explicit-adoption-preserves-unknown-fields-and-body");
  await ui.getByLabel("任务标题", { exact: true }).fill(title);
  await ui.getByLabel("预估分钟", { exact: true }).fill("20");
  await ui.getByRole("button", { name: "预览任务候选", exact: true }).click();
  await ui.getByText(/依据：用户填写/).waitFor();
  await ui.getByLabel("我已核对标题、日期含义与时区，确认登记创建").check();
  await ui.getByRole("button", { name: "确认登记任务", exact: true }).click();
  await ui.getByText(/等待本机 TaskNotes 创建/).waitFor();
  await expect
    .poll(
      () =>
        vaultPage.evaluate(async (title) => {
          const p = window.app.plugins.plugins["knowledge-task-center"];
          const s = await p.connection.request("/v1/tasks/today");
          return s.commands.some(
            (c) => c.input.title === title && c.state === "created",
          );
        }, title),
      { timeout: 45000 },
    )
    .toBe(true);
  checks.push("manual-candidate-create-real-tasknotes-marker-reconciliation");
  const target = await vaultPage.evaluate(async (title) => {
    const p = window.app.plugins.plugins["knowledge-task-center"];
    const s = await p.connection.request("/v1/tasks/today");
    return s.tasks.find((t) => t.fact.title === title);
  }, title);
  await vaultPage.evaluate(async (path) => {
    await window.app.plugins.plugins.tasknotes.api.tasks.setStatus(
      path,
      "done",
    );
  }, target.fact.path);
  await expect
    .poll(
      () =>
        vaultPage.evaluate(async (id) => {
          const s =
            await window.app.plugins.plugins[
              "knowledge-task-center"
            ].connection.request("/v1/tasks/today");
          return s.tasks.some(
            (t) => t.taskId === id && t.fact.lifecycle === "done",
          );
        }, target.taskId),
      { timeout: 20000 },
    )
    .toBe(true);
  checks.push("native-status-change-observed-no-second-checkbox");
  await vaultPage.evaluate(async (path) => {
    const app = window.app,
      file = app.vault.getAbstractFileByPath(path);
    await app.fileManager.renameFile(file, path.replace(".md", "-moved.md"));
  }, target.fact.path);
  await expect
    .poll(
      () =>
        vaultPage.evaluate(async (id) => {
          const s =
            await window.app.plugins.plugins[
              "knowledge-task-center"
            ].connection.request("/v1/tasks/today");
          return s.tasks
            .find((t) => t.taskId === id)
            ?.fact.path.endsWith("-moved.md");
        }, target.taskId),
      { timeout: 20000 },
    )
    .toBe(true);
  checks.push("rename-retains-stable-task-id");
  const cacheGuard = await vaultPage.evaluate(async (id) => {
    const p = window.app.plugins.plugins["knowledge-task-center"],
      api = window.app.plugins.plugins.tasknotes.api;
    const state = await p.connection.request("/v1/tasks/today"),
      path = state.tasks.find((t) => t.taskId === id).fact.path;
    const original = api.tasks.list;
    api.tasks.list = async () =>
      (await original()).filter((t) => t.path !== path);
    try {
      await p.tasks.inventory();
      return false;
    } catch (error) {
      return error.message.includes("已移动");
    } finally {
      api.tasks.list = original;
    }
  }, target.taskId);
  if (!cacheGuard) throw Error("Cache omission was mistaken for deletion");
  checks.push("real-file-with-delayed-tasknotes-cache-prevents-false-deletion");

  await ui
    .getByRole("button", { name: "核对 TaskNotes 并刷新 Today", exact: true })
    .click();
  await ui.getByText(title + "-moved", { exact: true }).waitFor();
  const learning = page.locator(".kb-learning");
  // Date fixture only: make the synthetic attempt 2 days old; no user data or product route is modified.
  const Database = createRequire(
    new URL("../apps/service/package.json", import.meta.url),
  )("better-sqlite3");
  const fixtureDb = new Database(join(root, "data/state.db"));
  const row = fixtureDb
    .prepare(
      "SELECT id,value FROM learning_attempts ORDER BY rowid DESC LIMIT 1",
    )
    .get();
  const attempt = JSON.parse(row.value);
  attempt.createdAt -= 2 * 86400000;
  fixtureDb
    .prepare("UPDATE learning_attempts SET value=? WHERE id=?")
    .run(JSON.stringify(attempt), row.id);
  fixtureDb.close();
  await learning
    .getByText("复习规则与容量（未配置时不猜测）", { exact: true })
    .click();
  for (const [name, value] of [
    ["同时进行任务上限", "10"],
    ["每日复习分钟上限", "1000"],
    ["容量时区", "Asia/Shanghai"],
    ["复习间隔天数", "1"],
    ["复习窗口天数", "3"],
    ["单次复习预计分钟", "20"],
  ])
    await learning.getByLabel(name, { exact: true }).fill(value);
  await learning
    .getByRole("button", { name: "保存学习设置", exact: true })
    .click();
  await learning
    .getByText("设置已保存，不自动创建任务。", { exact: true })
    .waitFor();
  await learning
    .getByRole("button", { name: "生成少量复习建议", exact: true })
    .click();
  await learning
    .getByRole("button", { name: "确认创建复习任务", exact: true })
    .click();
  await expect
    .poll(
      () =>
        vaultPage.evaluate(async (goalId) => {
          const s =
            await window.app.plugins.plugins[
              "knowledge-task-center"
            ].connection.request("/v1/tasks/today");
          return s.commands.some(
            (c) => c.learning?.goalId === goalId && c.state === "created",
          );
        }, attempt.goalId),
      { timeout: 45000 },
    )
    .toBe(true);
  await ui
    .getByRole("button", { name: "核对 TaskNotes 并刷新 Today", exact: true })
    .click();
  await ui
    .getByRole("button", { name: "继续这项学习", exact: true })
    .last()
    .click();
  await learning.getByText(/继续上次活动/).waitFor();
  checks.push(
    "due-review-real-tasknotes-create-and-today-resume-original-attempt",
  );
  await vaultPage.evaluate(async () => {
    await window.app.plugins.plugins[
      "knowledge-task-center"
    ].connection.request("/v1/learning/settings", "POST", {
      capacity: null,
      review: null,
    });
  });
  await ui.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: join(root, "obsidian-task-today.png") });
  const diagnostics = await vaultPage.evaluate(async () => ({
    message:
      window.app.plugins.plugins["knowledge-task-center"].tasks.lastMessage,
    version: window.app.plugins.plugins.tasknotes.manifest.version,
  }));
  await writeFile(
    join(root, "task-today-checks.json"),
    JSON.stringify({ checks, diagnostics }, null, 2),
  );
}
