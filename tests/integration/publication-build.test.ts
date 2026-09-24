import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { PUBLICATION_BUILD_PROGRAM } from "../../apps/service/src/publishing/build";
import { scanPublication } from "../../apps/service/src/publishing/scan";
import { wikiFixture } from "../wiki-helpers";
import { createServer } from "../../apps/service/src/http/server";

test("fixed builder escapes page content and emits only selected pages, index and bounded search metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-publication-builder-"));
  const input = join(root, "input"),
    output = join(root, "output");
  await mkdir(input);
  await mkdir(output);
  try {
    const pages = [
      {
        title: "已审核页面",
        body: "# 内容\n<script>alert(1)</script>",
        file: "page.html",
      },
    ];
    await writeFile(
      join(input, "data"),
      JSON.stringify({ pages, attachments: [] }),
    );
    const localProgram = PUBLICATION_BUILD_PROGRAM.replaceAll(
      "/input/data",
      join(input, "data"),
    ).replaceAll("/output/", `${output}/`);
    await writeFile(join(root, "builder.cjs"), localProgram);
    await promisify(execFile)(process.execPath, [join(root, "builder.cjs")], {
      timeout: 5000,
    });
    const files = Object.fromEntries(
      await Promise.all(
        ["index.html", "page.html", "search.json"].map(async (path) => [
          path,
          await readFile(join(output, path), "utf8"),
        ]),
      ),
    );
    expect(files["page.html"]).toContain("&lt;script&gt;");
    expect(files["page.html"]).not.toContain("<script>");
    expect(files["search.json"]).not.toContain("内容");
    expect(scanPublication(files, ["page.html"], []).output).toHaveLength(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real HTTP inspection and draft work without publish route or Docker, but never approve a draft", async () => {
  const f = await wikiFixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
  try {
    await f.apply(f.prepare("candidate"));
    const wiki = await f.apply(f.prepare("wiki"));
    const revisionId = wiki.patches[0]!.revisionId;
    const page = f.proposals.page(wiki.patches[0]!.pageId)!;
    const sourceId = f.evidence.read(page.evidenceIds[0]!).sourceId;
    const headers = {
      host: "127.0.0.1:27124",
      authorization: `Bearer ${f.token}`,
      "x-policy-version": String(f.registry.get().policyVersion),
    };
    const inspected = await app.inject({
      method: "POST",
      url: "/v1/publications/inspect",
      headers,
      payload: { revisionIds: [revisionId] },
    });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().pages).toHaveLength(1);
    const sourcePolicy = await app.inject({
      url: `/v1/source-policy/${sourceId}`,
      headers,
    });
    expect(sourcePolicy.statusCode).toBe(200);
    expect(sourcePolicy.json().routes).toMatchObject({
      read: ["local"],
      publish: [],
    });
    const reader = await f.sessions.pair({
      code: f.sessions.issuePairing("reader"),
      deviceId: crypto.randomUUID(),
      vaultPath: f.registry.get().vaultPath,
    });
    expect(
      (
        await app.inject({
          url: `/v1/source-policy/${sourceId}`,
          headers: { ...headers, authorization: `Bearer ${reader.token}` },
        })
      ).statusCode,
    ).toBe(403);
    const draft = await app.inject({
      method: "POST",
      url: "/v1/publications/draft",
      headers,
      payload: {
        operationId: crypto.randomUUID(),
        revisionIds: [revisionId],
        routeId: "local-site",
        decisions: {},
      },
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({
      publishable: false,
      pages: [{ revisionId }],
    });
    expect(draft.json()).not.toHaveProperty("manifest");
  } finally {
    await app.close();
    await f.close();
  }
});
