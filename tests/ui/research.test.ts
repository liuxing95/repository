// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { renderResearch } from "../../apps/obsidian-plugin/src/views/research";
import { Connection } from "../../apps/obsidian-plugin/src/connection";
test("editing a brief invalidates pending confirmation; untrusted research titles render only as text", async () => {
  vi.useFakeTimers();
  const root = document.createElement("section");
  document.body.append(root);
  try {
    const c = new Connection(
      async () => ({ status: 200, json: {} }),
      "/fixture",
      "device",
    );
    let complete!: (value: unknown) => void;
    vi.spyOn(c, "request").mockImplementation(async (path) =>
      path === "/v1/research/draft"
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : [
            {
              id: "fixture",
              topic: "<img src=x onerror=alert(1)>",
              state: "active",
            },
          ],
    );
    renderResearch(root, c);
    const button = (name: string) =>
      [...root.querySelectorAll("button")].find((b) => b.textContent === name)!;
    const topic = root.querySelector<HTMLInputElement>(
      '[aria-label="研究课题"]',
    )!;
    topic.value = "旧课题";
    button("预览课题清单").click();
    await vi.waitFor(() => expect(complete).toBeDefined());
    topic.value = "新课题";
    topic.dispatchEvent(new Event("input"));
    complete({
      ready: true,
      brief: { topic: "旧课题" },
      digest: "old",
      missing: [],
    });
    await vi.waitFor(() => expect(root.textContent).toContain("输入已变化"));
    expect(button("确认课题与根预算")).toBeUndefined();
    button("读取研究记录").click();
    await vi.waitFor(() => expect(root.textContent).toContain("<img src=x"));
    expect(root.querySelector("img")).toBeNull();
  } finally {
    root.remove();
    await vi.advanceTimersByTimeAsync(5000);
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
