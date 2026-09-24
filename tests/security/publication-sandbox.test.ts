import { expect, test } from "vitest";
import { buildPublication } from "../../apps/service/src/publishing/build";
import { scanPublication } from "../../apps/service/src/publishing/scan";

test.skipIf(process.env.KB_TEST_OCI !== "1")(
  "real OCI builder receives only selected text and returns fixed static files",
  async () => {
    const page = {
      title: "公开页",
      body: "<script>require('node:fs').readFileSync('/host/private')</script>",
      file: "page.html",
    };
    const files = await buildPublication(
      [page],
      [{ path: "asset-note.txt", content: "公开附件" }],
    );
    expect(Object.keys(files).sort()).toEqual([
      "asset-note.txt",
      "index.html",
      "page.html",
      "search.json",
    ]);
    expect(files["page.html"]).toContain("&lt;script&gt;");
    expect(files["page.html"]).not.toContain("<script>");
    expect(
      scanPublication(files, ["page.html"], [], ["asset-note.txt"]).output,
    ).toHaveLength(4);
  },
  30_000,
);
