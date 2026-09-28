// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { renderDrafts } from "../../apps/obsidian-plugin/src/views/drafts";
import { Connection } from "../../apps/obsidian-plugin/src/connection";
import type { WritingDraft } from "@kb/contracts";

test("editing during save preserves new text, blocks freeze until saved, and never renders draft HTML", async () => {
  vi.useFakeTimers();
  const root = document.createElement("section");
  document.body.append(root);
  const d = {
    id: "draft",
    title: "<img src=x>",
    revision: 1,
    updatedAt: 1,
    paragraphs: [{ text: "旧内容", evidenceIds: [] }],
    answer: { model: "local", evidence: [] },
  } as unknown as WritingDraft;
  const c = new Connection(
    async () => ({ status: 200, json: {} }),
    "/fixture",
    "device",
  );
  let save!: (d: WritingDraft) => void;
  vi.spyOn(c, "refresh").mockResolvedValue({} as never);
  const request = vi
    .spyOn(c, "request")
    .mockImplementation(async (path, method) => {
      if (path === "/v1/drafts") return [d];
      if (method === "PUT")
        return new Promise((resolve) => {
          save = resolve;
        });
      return d;
    });
  const click = (text: string) =>
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent === text)!
      .click();
  try {
    renderDrafts(root, c);
    click("读取草稿");
    await vi.waitFor(() =>
      expect(root.textContent).toContain("<img src=x> · 修订 1"),
    );
    click("<img src=x> · 修订 1");
    await vi.waitFor(() =>
      expect(root.querySelector("textarea")).not.toBeNull(),
    );
    expect(root.querySelector("img")).toBeNull();
    const input = root.querySelector("textarea")!;
    input.value = "第一版";
    input.dispatchEvent(new Event("input"));
    click("保存草稿");
    await vi.waitFor(() => expect(save).toBeDefined());
    input.value = "继续编辑";
    input.dispatchEvent(new Event("input"));
    save({
      ...d,
      revision: 2,
      paragraphs: [{ text: "第一版", evidenceIds: [] }],
    });
    await vi.waitFor(() =>
      expect(root.textContent).toContain("之后的编辑仍未保存"),
    );
    expect(input.value).toBe("继续编辑");
    click("提交当前草稿审核");
    await vi.waitFor(() => expect(root.textContent).toContain("请先保存修改"));
    expect(request.mock.calls.some(([p]) => p.endsWith("/candidate"))).toBe(
      false,
    );
    request.mockRejectedValue({ code: "FORBIDDEN" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.textContent).toContain("已清除显示");
  } finally {
    root.remove();
    await vi.advanceTimersByTimeAsync(5000);
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
