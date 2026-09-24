import { expect, test } from "vitest";
import {
  dependencies,
  transformPage,
} from "../../apps/service/src/publishing/transform";
import { scanPublication } from "../../apps/service/src/publishing/scan";
import { readPublicAttachment } from "../../apps/service/src/publishing/attachments";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("private embeds, attachments, source paths and linked titles block until explicitly removed", () => {
  const body =
    "# 公开页\n\n![[秘密附件.png]]\n[秘密标题](KB-Sources/private.md)\nfile:///Users/Alice/private.txt";
  const found = dependencies("page", body);
  expect(found).toHaveLength(3);
  expect(found.map((d) => d.action)).toEqual(["blocked", "blocked", "blocked"]);
  expect(() => transformPage("page", body, {})).toThrow(
    "PUBLICATION_DEPENDENCY",
  );
  const decisions = Object.fromEntries(
    found.map((d) => [d.token, { action: "remove" as const }]),
  );
  const result = transformPage("page", body, decisions);
  expect(result.body).not.toMatch(/秘密|KB-Sources|file:\/\/|\/Users\//);
  expect(result.body.match(/\[引用已移除\]/g)).toHaveLength(3);
});

test("replacement requires public HTTPS and final output rejects hidden search or graph leaks", () => {
  expect(() =>
    transformPage("page", "[secret](local.md)", {
      "[secret](local.md)": { action: "replace", url: "javascript:alert(1)" },
    }),
  ).toThrow();
  const result = transformPage("page", "[secret](local.md)", {
    "[secret](local.md)": {
      action: "replace",
      url: "https://example.org/public",
    },
  });
  expect(result.body).not.toContain("secret");
  const valid = {
    "index.html": "<html>index</html>",
    "page.html": `<pre>${result.body}</pre>`,
    "search.json": "[]",
  };
  expect(
    scanPublication(valid, ["page.html"], result.outboundLinks).output,
  ).toHaveLength(3);
  expect(() =>
    scanPublication(
      { ...valid, "graph.json": "KB-Sources/private.md" },
      ["page.html"],
      result.outboundLinks,
    ),
  ).toThrow("PUBLICATION_OUTPUT");
  expect(() =>
    scanPublication(
      { ...valid, "search.json": '["/Users/Alice/private"]' },
      ["page.html"],
      result.outboundLinks,
    ),
  ).toThrow("PUBLICATION_OUTPUT");
  const retained = transformPage("page", "https://example.org/open", {
    "https://example.org/open": { action: "retain" },
  });
  expect(retained.outboundLinks).toEqual(["https://example.org/open"]);
  expect(() =>
    transformPage("page", "[secret](local.md)", {
      "[secret](local.md)": { action: "retain" },
    }),
  ).toThrow("VALIDATION");
});

test("only explicitly included, small, regular UTF-8 text attachments are eligible", () => {
  const vault = mkdtempSync(join(tmpdir(), "kb-public-asset-"));
  try {
    mkdirSync(join(vault, "KB-Wiki", "PublicAssets"), { recursive: true });
    writeFileSync(
      join(vault, "KB-Wiki", "PublicAssets", "guide.txt"),
      "公开说明",
    );
    const token = "![[KB-Wiki/PublicAssets/guide.txt]]";
    const asset = readPublicAttachment(vault, token);
    expect(asset.path).toMatch(/^asset-[a-f0-9]{64}\.txt$/);
    expect(
      transformPage(
        "page",
        token,
        { [token]: { action: "include" } },
        { [token]: asset.path },
      ).body,
    ).toContain(asset.path);
    expect(() =>
      readPublicAttachment(vault, "![[KB-Sources/private.txt]]"),
    ).toThrow("FORBIDDEN");
    symlinkSync(
      join(vault, "KB-Wiki", "PublicAssets", "guide.txt"),
      join(vault, "KB-Wiki", "PublicAssets", "link.txt"),
    );
    expect(() =>
      readPublicAttachment(vault, "![[KB-Wiki/PublicAssets/link.txt]]"),
    ).toThrow();
    writeFileSync(
      join(vault, "KB-Wiki", "PublicAssets", "binary.txt"),
      Buffer.from([0xff]),
    );
    expect(() =>
      readPublicAttachment(vault, "![[KB-Wiki/PublicAssets/binary.txt]]"),
    ).toThrow("VALIDATION");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
