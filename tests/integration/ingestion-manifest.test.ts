import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "../helpers";
import { Ingestion } from "../../apps/service/src/ingestion/manifest";
import { parseIsolated } from "../../apps/service/src/ingestion/parser";
import { hashBytes } from "../../apps/service/src/ingestion/objects";

test("isolated parser preserves UTF-16 block offsets and never executes material scripts", async () => {
  const parsed = await parseIsolated({
    bytes: Buffer.from("甲😀乙\n第二行"),
    kind: "text",
    title: "原文",
    url: "",
    encoding: "utf-8",
  });
  expect(parsed.text).toContain("甲😀乙");
  for (const block of parsed.blocks) {
    expect(parsed.text.slice(block.start, block.end)).toBe(block.text);
    expect(hashBytes(block.text)).toBe(block.hash);
  }
  const web = await parseIsolated({
    bytes: Buffer.from(
      '<html><title>登录</title><script>fetch("https://attacker.invalid"); process.exit(42)</script><form><input type="password"></form><main><h1>可读正文</h1><p>静态正文</p><pre>const a = 1;</pre></main></html>',
    ),
    kind: "web",
    title: "",
    url: "https://example.com/",
    encoding: "utf-8",
  });
  expect(web.gaps.join()).toContain("LOGIN_WALL");
  expect(web.text).not.toContain("attacker.invalid");
  expect(web.text).toContain("const a = 1");
});

test("frozen denominator, byte deduplication, revision/reparse separation and old objects survive refresh", async () => {
  const f = await fixture();
  try {
    const ingestion = new Ingestion(f.registry, f.jobs);
    const preview = async (entry = join(f.source, "note.md")) =>
      ingestion.preview(
        { id: randomUUID(), kind: "text", entry, title: "同标题" },
        f.principal,
      );
    const run = async (batch: Awaited<ReturnType<typeof preview>>) => {
      ingestion.freeze(
        batch.id,
        batch.digest,
        batch.entries.filter((e) => e.selected).map((e) => e.id),
        f.principal,
      );
      const job = f.jobs.claim("batch", 30000, "ingestion")!;
      await ingestion.run(job, new AbortController().signal);
      return ingestion.get(batch.id);
    };
    const first = await run(await preview());
    expect(first.selectedCount).toBe(1);
    expect(first.entries[0]!.status).toBe("acquired");
    const repeated = await run(await preview());
    expect(repeated.entries[0]!.revisionId).toBe(first.entries[0]!.revisionId);
    expect(repeated.entries[0]!.parseId).toBe(first.entries[0]!.parseId);
    await writeFile(join(f.source, "note.md"), "已更新正文😀");
    const changed = await run(await preview());
    expect(changed.entries[0]!.revisionId).not.toBe(
      first.entries[0]!.revisionId,
    );
    await writeFile(join(f.source, "other.md"), "已更新正文😀");
    const other = await run(await preview(join(f.source, "other.md")));
    expect(other.entries[0]!.revisionId).not.toBe(
      changed.entries[0]!.revisionId,
    );
    const reparsed = await ingestion.reparse(
      changed.id,
      changed.entries[0]!.id,
      "utf-16le",
      undefined,
      f.principal,
    );
    expect(reparsed.entries[0]!.revisionId).toBe(
      changed.entries[0]!.revisionId,
    );
    expect(reparsed.entries[0]!.parseId).not.toBe(changed.entries[0]!.parseId);
    expect(
      f.store.db.prepare("SELECT count(*) n FROM source_revisions").get(),
    ).toEqual({ n: 3 });
    expect(() =>
      ingestion.freeze(first.id, first.digest, [], f.principal),
    ).toThrow("BASELINE");
  } finally {
    await f.close();
  }
});

test("failed jobs reconcile to retryable batches, while changed local snapshots require a new preview", async () => {
  const f = await fixture();
  try {
    const ingestion = new Ingestion(f.registry, f.jobs);
    const preview = await ingestion.preview(
      { id: randomUUID(), kind: "text", entry: f.source },
      f.principal,
    );
    ingestion.freeze(
      preview.id,
      preview.digest,
      preview.entries.map((e) => e.id),
      f.principal,
    );
    const job = f.jobs.claim("batch", 30000, "ingestion")!;
    f.jobs.finish(job.id, job.fence, false);
    const interrupted = ingestion.get(preview.id);
    expect(interrupted.state).toBe("ready");
    expect(interrupted.entries[0]!.reason).toBe("JOB_INTERRUPTED");
    // This persisted state is produced by the second filesystem comparison in preview.
    interrupted.entries[0]!.reason = "SNAPSHOT_CHANGED";
    ingestion.save(interrupted);
    ingestion.retry(preview.id, f.principal);
    await ingestion.run(
      f.jobs.claim("batch", 30000, "ingestion")!,
      new AbortController().signal,
    );
    expect(ingestion.get(preview.id).entries[0]).toMatchObject({
      status: "failed",
      reason: "SNAPSHOT_CHANGED",
    });
    expect(ingestion.get(preview.id).entries[0]!.parseId).toBeUndefined();
  } finally {
    await f.close();
  }
});
