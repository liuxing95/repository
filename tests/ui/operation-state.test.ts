// @vitest-environment jsdom
import { expect, test } from "vitest";
import { OperationState } from "../../apps/obsidian-plugin/src/ui/operation-state";
import { renderSettings } from "../../apps/obsidian-plugin/src/views/settings";
import { Connection } from "../../apps/obsidian-plugin/src/connection";

test("duplicate clicks share one in-flight action and render actionable budget failure", async () => {
  const root = document.createElement("div");
  const state = new OperationState(root);
  let reject!: (reason: unknown) => void;
  let count = 0;
  const action = () => {
    count++;
    return new Promise((_resolve, r) => {
      reject = r;
    });
  };
  const first = state.run(action);
  const second = state.run(action);
  expect(first).toBe(second);
  await Promise.resolve();
  expect(count).toBe(1);
  reject({ code: "BUDGET", message: "额度不足", nextStep: "调整额度后重试" });
  await expect(first).rejects.toMatchObject({ code: "BUDGET" });
  expect(state.status).toBe("blocked_budget");
  expect(root.textContent).toContain("调整额度后重试");
  expect(root.getAttribute("aria-live")).toBe("polite");
});
test("disconnect preserves form values and keyboard focus; drafts survive view recreation", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const drafts = { budget: "{未完成的输入" };
  const connection = new Connection(
    async () => {
      throw new Error("offline");
    },
    "/pilot",
    crypto.randomUUID(),
  );
  renderSettings(root, connection, drafts);
  const textarea = root.querySelector("textarea")!;
  textarea.focus();
  textarea.value = "新的草稿";
  textarea.dispatchEvent(new Event("input"));
  const button = [...root.querySelectorAll("button")].find(
    (b) => b.textContent === "读取配置",
  )!;
  button.click();
  await new Promise((r) => setTimeout(r, 0));
  expect(textarea.value).toBe("新的草稿");
  expect(document.activeElement).toBe(textarea);
  expect(root.textContent).toContain("输入已保留");
  renderSettings(root, connection, drafts);
  expect(root.querySelector("textarea")!.value).toBe("新的草稿");
  expect(root.querySelectorAll("label").length).toBe(2);
  root.remove();
});
test("partial completion has an explicit readable state", () => {
  const root = document.createElement("div");
  const state = new OperationState(root);
  state.status = "partial";
  state.render({
    message: "作业已创建，列表刷新失败。",
    nextStep: "刷新作业列表。",
  });
  expect(root.textContent).toContain("部分完成");
});

test("a late settings response cannot overwrite edits made while waiting", async () => {
  const root = document.createElement("div");
  const drafts = { budget: "原草稿" };
  let resolve!: (value: { status: number; json: unknown }) => void;
  const connection = new Connection(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    "/pilot",
    crypto.randomUUID(),
  );
  const state = renderSettings(root, connection, drafts);
  [...root.querySelectorAll("button")]
    .find((b) => b.textContent === "读取配置")!
    .click();
  await Promise.resolve();
  const editor = root.querySelector("textarea")!;
  editor.value = "等待期间写下的新草稿";
  editor.dispatchEvent(new Event("input"));
  resolve({
    status: 200,
    json: { schemaVersion: 1, budget: null, routes: [] },
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(drafts.budget).toBe("等待期间写下的新草稿");
  expect(editor.value).toBe(drafts.budget);
  expect(state.status).toBe("partial");
  expect(root.textContent).toContain("草稿已保留");
});
