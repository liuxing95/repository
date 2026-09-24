import { expect } from "@playwright/test";
import { access } from "node:fs/promises";
import { join } from "node:path";

export async function planningSmoke({ page, vaultPage, root, vaultPath }) {
  const ui = page.locator(".kb-planning");
  const start = Date.now() + 3600000;
  await ui.getByLabel("计划时区", { exact: true }).fill("Asia/Shanghai");
  await ui
    .getByLabel("可用开始", { exact: true })
    .fill(new Date(start).toISOString());
  await ui
    .getByLabel("可用结束", { exact: true })
    .fill(new Date(start + 8 * 3600000).toISOString());
  await ui.getByLabel("最多尝试节点数", { exact: true }).fill("10000");
  await ui.getByLabel("冻结未来多少分钟", { exact: true }).fill("0");
  await ui.getByLabel("日历核对有效毫秒数", { exact: true }).fill("30000");
  await ui.getByRole("button", { name: "核对任务并预览", exact: true }).click();
  await ui.getByText("与现有计划的差异", { exact: true }).waitFor();
  await ui.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await ui
    .locator(":scope > div")
    .last()
    .screenshot({ path: join(root, "obsidian-planning-preview.png") });
  const adopt = ui.getByRole("button", {
    name: "核对后采用此计划",
    exact: true,
  });
  if (!(await adopt.count()))
    throw Error("No plan to adopt in TaskNotes synthetic vault");
  await adopt.click();
  await ui.getByText(/正式计划已采用/).waitFor();
  const current = await vaultPage.evaluate(async () => {
    const c = window.app.plugins.plugins["knowledge-task-center"].connection;
    return {
      today: await c.request("/v1/tasks/today"),
      current: await c.request("/v1/planning/current"),
    };
  });
  expect(current.today.plan?.id).toBe(current.current.id);
  await expect
    .poll(
      async () => {
        try {
          await access(join(vaultPath, "KB-Plans", `${current.current.id}.md`));
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        vaultPage.evaluate(async () => {
          const c =
            window.app.plugins.plugins["knowledge-task-center"].connection;
          const state = await c.request("/v1/tasks/today");
          return state.receipts.some(
            (r) => r.target === "note" && r.state === "applied",
          );
        }),
      { timeout: 30000 },
    )
    .toBe(true);
  await ui
    .getByRole("button", { name: "预览撤销上一次采用", exact: true })
    .click();
  await ui.getByText("与现有计划的差异", { exact: true }).waitFor();
  await ui
    .locator(":scope > div")
    .last()
    .screenshot({ path: join(root, "obsidian-planning-undo-preview.png") });
}
