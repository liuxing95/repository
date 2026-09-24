// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { renderLearning } from "../../apps/obsidian-plugin/src/views/learning";
import { Connection } from "../../apps/obsidian-plugin/src/connection";
test("edited learning drafts cannot resurrect stale confirmation; untrusted ability is literal text", async () => {
  const root = document.createElement("section");
  document.body.append(root);
  const c = new Connection(
    async () => ({ status: 200, json: {} }),
    "/fixture",
    "device",
  );
  let finish!: (value: unknown) => void;
  vi.spyOn(c, "request").mockImplementation(async (path) =>
    path.endsWith("/draft")
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : [{ id: "fixture", ability: "<img src=x onerror=alert(1)>" }],
  );
  try {
    renderLearning(root, c);
    const button = (name: string) =>
      [...root.querySelectorAll("button")].find((b) => b.textContent === name)!;
    button("预览学习目标与固定基线").click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(root.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    root
      .querySelector<HTMLInputElement>("input")!
      .dispatchEvent(new Event("input", { bubbles: true }));
    finish({ ready: true, input: {}, digest: "old", missing: [] });
    await vi.waitFor(() => expect(root.textContent).toContain("表单已修改"));
    expect(button("确认学习基线")).toBeUndefined();
    button("读取学习目标").click();
    await vi.waitFor(() => expect(root.textContent).toContain("<img src=x"));
    expect(root.querySelector("img")).toBeNull();
  } finally {
    root.remove();
    vi.restoreAllMocks();
  }
});

test("retrying a lost goal confirmation keeps the same operation identity", async () => {
  const root = document.createElement("section");
  document.body.append(root);
  const c = new Connection(
      async () => ({ status: 200, json: {} }),
      "/fixture",
      "device",
    ),
    operations: string[] = [];
  vi.spyOn(c, "request").mockImplementation(async (path, _method, body) => {
    if (path.endsWith("/draft"))
      return { ready: true, input: {}, digest: "fixed", missing: [] };
    if (path === "/v1/learning/goals") {
      operations.push((body as { operationId: string }).operationId);
      throw new Error("response lost");
    }
    throw new Error("unexpected");
  });
  try {
    renderLearning(root, c);
    const button = (name: string) =>
      [...root.querySelectorAll("button")].find((b) => b.textContent === name)!;
    button("预览学习目标与固定基线").click();
    await vi.waitFor(() => expect(button("确认学习基线")).toBeDefined());
    const check = root.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    check.checked = true;
    check.dispatchEvent(new Event("change"));
    button("确认学习基线").click();
    await vi.waitFor(() => expect(root.textContent).toContain("response lost"));
    button("确认学习基线").click();
    await vi.waitFor(() => expect(operations).toHaveLength(2));
    expect(operations[1]).toBe(operations[0]);
  } finally {
    root.remove();
    vi.restoreAllMocks();
  }
});
