import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "../helpers";
import { Ingestion } from "../../apps/service/src/ingestion/manifest";
import { parseIsolated } from "../../apps/service/src/ingestion/parser";
import { AppError } from "../../apps/service/src/errors";
test("collection freezes parallel navigation, exclusions and missing pages; restart reuses successful items", async () => {
  const f = await fixture();
  let requests = 0;
  let secondRound = false;
  try {
    const pages: Record<string, string> = {
      "https://example.com/docs":
        '<main><p>Index of documentation.</p><nav><a href="/docs/a">A</a><a href="/docs/b">B</a><a href="/fr">French</a><a href="https://elsewhere.example/docs">Outside</a></nav></main>',
      "https://example.com/docs/a": `<main><h1>Same title</h1><p>${"Good paragraph. ".repeat(20)}</p></main>`,
    };
    const ingestion = new Ingestion(
      f.registry,
      f.jobs,
      parseIsolated,
      async (input) => {
        requests++;
        if (!pages[input]) throw new AppError("FETCH_FAILED");
        return {
          body: Buffer.from(pages[input]!),
          finalUrl: input,
          contentType: "text/html",
        };
      },
    );
    const preview = () =>
      ingestion.preview(
        {
          id: randomUUID(),
          kind: "collection",
          entry: "https://example.com/docs",
          allowedHosts: ["example.com"],
          allowedPaths: ["/docs"],
          maxPages: 10,
        },
        f.principal,
      );
    const first = await preview();
    expect(first.selectedCount).toBe(3);
    expect(first.entries.filter((e) => e.status === "excluded")).toHaveLength(
      2,
    );
    ingestion.freeze(
      first.id,
      first.digest,
      first.entries.filter((e) => e.selected).map((e) => e.id),
      f.principal,
    );
    await ingestion.run(
      f.jobs.claim("batch", 30000, "ingestion")!,
      new AbortController().signal,
    );
    const done = ingestion.get(first.id);
    expect(done.selectedCount).toBe(3);
    expect(done.entries.filter((e) => e.status === "failed")).toHaveLength(1);
    const originalParse = done.entries.find((e) =>
      e.original.endsWith("/a"),
    )!.parseId;
    pages["https://example.com/docs/b"] = pages["https://example.com/docs/a"]!;
    const before = requests;
    ingestion.retry(first.id, f.principal);
    await ingestion.run(
      f.jobs.claim("batch", 30000, "ingestion")!,
      new AbortController().signal,
    );
    expect(requests - before).toBe(1);
    expect(
      ingestion.get(first.id).entries.find((e) => e.original.endsWith("/a"))!
        .parseId,
    ).toBe(originalParse);
    pages["https://example.com/docs"] =
      '<main><a href="/docs/new">New</a></main>';
    pages["https://example.com/docs/new"] = "<p>A new document.</p>";
    secondRound = true;
    const next = await preview();
    expect(next.previousMissing).toContain("https://example.com/docs/a");
    expect(ingestion.get(first.id).selectedCount).toBe(3);
    expect(secondRound).toBe(true);
  } finally {
    await f.close();
  }
}, 30000);
