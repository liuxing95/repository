import { test, expect } from "vitest";
import { writeFile, mkdir, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "../helpers";
import { Ingestion } from "../../apps/service/src/ingestion/manifest";
import { SourceCommit } from "../../apps/service/src/ingestion/commit";
import { hashBytes } from "../../apps/service/src/ingestion/objects";

test.skipIf(process.env.KB_TEST_CORPUS !== "1")(
  "30 real materials across text, web, code and PDF produce a provenance/coverage report",
  async () => {
    const f = await fixture();
    const start = Date.now();
    try {
      const ingestion = new Ingestion(f.registry, f.jobs);
      const commits = new SourceCommit(ingestion);
      const pdfNames = [
        "basicapi.pdf",
        "labelled_pages.pdf",
        "encrypted-attachment.pdf",
        "images.pdf",
        "rotation.pdf",
        "bad-PageLabels.pdf",
        "tracemonkey.pdf",
        "scan-bad.pdf",
      ];
      const docs = (await readdir("docs/plans"))
        .filter((n) => n.endsWith(".md"))
        .slice(0, 7);
      const code = [
        "apps/service/src/http/auth.ts",
        "apps/service/src/runtime/budget.ts",
        "apps/service/src/runtime/jobs.ts",
        "apps/service/src/runtime/worker-broker.ts",
        "apps/service/src/storage/store.ts",
        "apps/obsidian-plugin/src/connection.ts",
        "packages/contracts/src/policy.ts",
        "apps/service/node_modules/better-sqlite3/prebuilds/darwin-arm64.node",
      ];
      const web = [
        "https://example.com/",
        "https://github.com/mozilla/readability",
        "https://docs.python.org/3/tutorial/introduction.html",
        "https://www.typescriptlang.org/docs/handbook/2/everyday-types.html",
        "https://nodejs.org/en/learn/getting-started/introduction-to-nodejs",
        "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview",
        "https://ai-sdk.dev/docs/introduction",
      ];
      const materials = [
        ...docs.map((name, i) => ({
          kind: "text",
          entry: resolve("docs/plans", name),
          excerpt: i === 0,
        })),
        ...web.map((entry) => ({ kind: "web", entry, excerpt: false })),
        ...code.map((entry) => ({
          kind: "repository",
          entry: resolve(entry),
          excerpt: false,
        })),
        ...pdfNames.map((entry) => ({
          kind: "pdf",
          entry: resolve("tests/fixtures/ingestion", entry),
          excerpt: false,
        })),
      ];
      const results: Record<string, unknown>[] = [];
      for (const material of materials) {
        const input = {
          ...material,
          id: randomUUID(),
          allowedHosts:
            material.kind === "web" ? [new URL(material.entry).hostname] : [],
          maxBytes: 20_000_000,
          sourceType: "artifact",
        };
        // Heartbeat remains the same authorization; no policy/epoch is silently advanced.
        f.sessions.heartbeat(f.token);
        const preview = await ingestion.preview(input, f.principal);
        ingestion.freeze(
          preview.id,
          preview.digest,
          preview.entries.filter((e) => e.selected).map((e) => e.id),
          f.principal,
        );
        const job = f.jobs.claim("batch", 30000, "ingestion")!;
        await ingestion.run(job, new AbortController().signal);
        const batch = ingestion.get(preview.id);
        const entry = batch.entries[0]!;
        const parsed = entry.parseId ? commits.parse(entry.parseId) : null;
        const original = entry.revisionId
          ? commits.original(entry.revisionId)
          : null;
        const locatorFailures =
          parsed?.blocks.filter(
            (b) =>
              parsed.text.slice(b.start, b.end) !== b.text ||
              hashBytes(b.text) !== b.hash,
          ).length ?? null;
        results.push({
          family: material.kind,
          input:
            material.kind === "web"
              ? material.entry
              : material.entry.replace(resolve(".") + "/", ""),
          originalAvailable: !!original,
          originalSha256: entry.objectHash,
          originalBytes: original?.length ?? 0,
          state: entry.status,
          failure: entry.reason ?? null,
          parser: parsed?.parser,
          blocks: parsed?.blocks.length ?? 0,
          locatorFailures,
          replacementCharacters: parsed?.text.match(/\uFFFD/g)?.length ?? 0,
          extractedUtf16Length: parsed?.text.length ?? 0,
          characterLoss:
            material.kind === "text" && parsed && original
              ? original
                  .toString("utf8")
                  .replace(/\r\n|\r/g, "\n")
                  .trim() === parsed.text.trim()
                ? 0
                : "requires review"
              : "not measurable without manually aligned ground truth",
          tableOmissions:
            material.kind === "pdf"
              ? "not structurally verified; every page marked as gap"
              : parsed?.gaps.includes("MEDIA")
                ? "possible"
                : "see coverage",
          gaps: parsed?.gaps,
          peakMemoryBytes: parsed?.peakMemoryBytes,
          durationMs: parsed?.durationMs,
        });
        console.log(
          `corpus ${results.length}/30 ${material.kind} ${basename(material.entry)} ${entry.status}`,
        );
      }
      const report = {
        capturedAt: new Date().toISOString(),
        node: process.versions.node,
        platform: process.platform,
        elapsedMs: Date.now() - start,
        materials: results,
      };
      await mkdir("docs/implementation/evidence", { recursive: true });
      await writeFile(
        "docs/implementation/evidence/ingestion-corpus.json",
        JSON.stringify(report, null, 2) + "\n",
      );
      expect(results).toHaveLength(30);
      expect(results.every((r) => r.originalAvailable)).toBe(true);
      expect(results.every((r) => r.locatorFailures === 0)).toBe(true);
      for (const family of ["text", "web", "repository", "pdf"])
        expect(
          results.some(
            (r) => r.family === family && r.state === "partial_parse",
          ),
        ).toBe(true);
    } finally {
      await f.close();
    }
  },
  180000,
);
