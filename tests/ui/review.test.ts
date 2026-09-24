// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { renderReview } from "../../apps/obsidian-plugin/src/views/review";
import { Connection } from "../../apps/obsidian-plugin/src/connection";
import type { WikiChangeSet } from "@kb/contracts";
test("new proposals remove stale approval controls before async work and lock concurrent actions", async () => {
  vi.useFakeTimers();
  const root = document.createElement("section");
  document.body.append(root);
  try {
    const c = new Connection(
      async () => ({ status: 200, json: {} }),
      "/fixture",
      "device",
    );
    const change = {
      id: "old",
      purpose: "<script>untrusted</script>",
      state: "prepared",
      receipts: [],
      patches: [],
      evidence: [],
      deferred: [],
      digest: "frozen",
    } as unknown as WikiChangeSet;
    const request = vi.spyOn(c, "request").mockImplementation(async (path) => {
      if (path === "/v1/wiki/candidates")
        return [{ id: "candidate", title: "候选", status: "supported" }];
      if (path === "/v1/wiki/pages") return [];
      return change;
    });
    vi.spyOn(c, "refresh").mockResolvedValue(
      {} as Awaited<ReturnType<Connection["refresh"]>>,
    );
    renderReview(root, c, {
      root: "/fixture",
      isEditing: () => false,
      read: async () => null,
      create: async () => {},
    });
    const button = (name: string) =>
      [...root.querySelectorAll("button")].find((b) => b.textContent === name)!;
    button("读取待审核候选").click();
    await vi.waitFor(() => expect(button("审核保存到候选区")).toBeDefined());
    button("审核保存到候选区").click();
    await vi.waitFor(() => expect(button("批准并应用本次变更")).toBeDefined());
    expect(root.querySelector("script")).toBeNull();
    let resolve: () => void = () => {};
    vi.spyOn(c, "refresh").mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = () => r({} as Awaited<ReturnType<Connection["refresh"]>>);
        }),
    );
    button("审核提升为 Wiki").click();
    expect(button("批准并应用本次变更")).toBeUndefined();
    expect(button("读取待审核候选").disabled).toBe(true);
    const count = request.mock.calls.length;
    button("读取待审核候选").click();
    expect(request.mock.calls).toHaveLength(count);
    resolve();
    await vi.waitFor(() => expect(button("批准并应用本次变更")).toBeDefined());
    expect(button("批准并应用本次变更").disabled).toBe(true);
  } finally {
    root.remove();
    await vi.advanceTimersByTimeAsync(5000);
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
