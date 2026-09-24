// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { renderPublication } from "../../apps/obsidian-plugin/src/views/publication";
import { Connection } from "../../apps/obsidian-plugin/src/connection";

test("untrusted Wiki titles are text and build approval is absent from the read-only draft", async () => {
  const root = document.createElement("section");
  document.body.append(root);
  try {
    const connection = new Connection(
      async () => ({ status: 200, json: {} }),
      "/fixture",
      "device",
    );
    vi.spyOn(connection, "refresh").mockResolvedValue(
      {} as Awaited<ReturnType<Connection["refresh"]>>,
    );
    vi.spyOn(connection, "request").mockImplementation(async (path) => {
      if (path === "/v1/wiki/pages")
        return [
          {
            title: "<script>alert(1)</script>",
            revisionId: "revision",
            review: "reviewed",
          },
        ];
      if (path === "/v1/publications/inspect")
        return {
          pages: [
            { title: "<script>alert(1)</script>", sourceIds: ["source"] },
          ],
          dependencies: [],
        };
      if (path === "/v1/publications/draft")
        return {
          pages: [{ title: "公开", body: "<img src=x>", bodyHash: "hash" }],
          attachments: [],
        };
      return [];
    });
    renderPublication(root, connection);
    const click = (label: string) =>
      [...root.querySelectorAll("button")]
        .find((b) => b.textContent === label)!
        .click();
    click("读取已审核 Wiki");
    await vi.waitFor(() =>
      expect(
        root.querySelector(
          'input[aria-label="选择公开 <script>alert(1)</script>"]',
        ),
      ).not.toBeNull(),
    );
    (root.querySelector('input[type="checkbox"]') as HTMLInputElement).checked =
      true;
    click("检查直接依赖");
    await vi.waitFor(() => expect(root.textContent).toContain("没有直接链接"));
    (
      root.querySelector('input[aria-label="发布路线 ID"]') as HTMLInputElement
    ).value = "local-site";
    click("只读导出草稿（无 Docker 可用）");
    await vi.waitFor(() =>
      expect(root.textContent).toContain("此草稿未隔离构建"),
    );
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x>");
    expect(root.textContent).not.toContain("批准此公开副本");
  } finally {
    root.remove();
    vi.restoreAllMocks();
  }
});
