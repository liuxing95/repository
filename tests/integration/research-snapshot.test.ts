import { test, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { researchFixture } from "../research-helpers";
import { publish } from "../evidence-helpers";
import { Acquisition } from "../../apps/service/src/research/acquisition";
import { Ingestion } from "../../apps/service/src/ingestion/manifest";
test("library-only never fetches; new committed material needs digest confirmation and old sections remain immutable", async () => {
  const f = await researchFixture();
  try {
    const s = await f.activate(),
      qid = f.b.questions[0]!.id;
    const old = await f.chapters.generate(
      f.r.id,
      qid,
      { operationId: randomUUID(), snapshotId: s.id },
      f.principal,
    );
    const fetch = vi.fn();
    const ingestion = new Ingestion(f.registry, f.jobs, undefined, fetch);
    await expect(
      new Acquisition(f.db, ingestion).preview(
        f.r.id,
        {
          operationId: randomUUID(),
          questionId: qid,
          entry: "https://example.com/docs",
          maxPages: 1,
        },
        f.principal,
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(fetch).not.toHaveBeenCalled();
    const report = f.artifacts.freeze(f.r.id, f.principal);
    publish(f, "权限新增的例外需要再次批准。", "权限补充");
    const next = await f.snapshots.propose(f.r.id, f.principal);
    expect(next.added).toHaveLength(1);
    expect(next.affectedQuestions).toContain(qid);
    expect(f.db.get(f.r.id, f.principal).snapshotId).toBe(s.id);
    expect(() =>
      f.snapshots.advance(f.r.id, next.id, "0".repeat(64), f.principal),
    ).toThrow("BASELINE");
    f.snapshots.advance(f.r.id, next.id, next.digest, f.principal);
    expect(f.chapters.get(next, qid)).toBeUndefined();
    expect(f.chapters.get(s, qid)).toEqual(old);
    const incomplete = f.artifacts.freeze(f.r.id, f.principal);
    expect(incomplete.chapters).toHaveLength(0);
    expect(incomplete.checks.warnings.join()).toContain("未完成章节");
    expect(f.artifacts.get(report.id, f.principal).snapshotId).toBe(s.id);
  } finally {
    await f.close();
  }
});
test("scoped acquisition reserves finite discovery/material allowance, summaries never enter research snapshot", async () => {
  const f = await researchFixture({
    mode: "fill_gaps",
    acquisitionScope: { hosts: ["example.com"], paths: ["/docs"] },
    limits: { cost: 0, calls: 0, discoveries: 1, materials: 2, chapters: 1 },
  });
  try {
    const s = await f.activate(),
      qid = f.b.questions[0]!.id;
    const fetch = vi.fn(async () => ({
      body: Buffer.from("<p>权限搜索摘要仍未完成来源提交。</p>"),
      finalUrl: "https://example.com/docs",
      contentType: "text/html",
    }));
    const a = new Acquisition(
      f.db,
      new Ingestion(f.registry, f.jobs, undefined, fetch),
    );
    const input = {
      operationId: randomUUID(),
      questionId: qid,
      entry: "https://example.com/docs",
      maxPages: 1,
    };
    await expect(
      a.preview(
        f.r.id,
        { ...input, entry: "https://outside.example/docs" },
        f.principal,
      ),
    ).rejects.toThrow("FORBIDDEN");
    const batch = await a.preview(f.r.id, input, f.principal);
    expect(batch.state).toBe("preview");
    expect((await a.preview(f.r.id, input, f.principal)).id).toBe(batch.id);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      a.preview(f.r.id, { ...input, operationId: randomUUID() }, f.principal),
    ).rejects.toThrow("LIMIT");
    const next = await f.snapshots.propose(f.r.id, f.principal);
    expect(next.evidence.map((e) => e.id)).toEqual(s.evidence.map((e) => e.id));
    expect(next.added).toEqual([]);
  } finally {
    await f.close();
  }
});
test("unchanged chapters are revalidated at the final snapshot without another model call", async () => {
  const f = await researchFixture();
  try {
    const s = await f.activate(),
      q = f.b.questions[0]!;
    await f.chapters.generate(
      f.r.id,
      q.id,
      { operationId: randomUUID(), snapshotId: s.id },
      f.principal,
    );
    const next = await f.snapshots.propose(f.r.id, f.principal);
    expect(next.affectedQuestions).toEqual([]);
    f.snapshots.advance(f.r.id, next.id, next.digest, f.principal);
    const report = f.artifacts.freeze(f.r.id, f.principal);
    expect(report.chapters).toHaveLength(1);
    expect(report.chapters[0]!.snapshotId).toBe(next.id);
    expect(report.usage.calls).toBe(0);
  } finally {
    await f.close();
  }
});

test("root material slots include library evidence and reserved acquisitions; committed acquisition converts its slot", async () => {
  const f = await researchFixture({
    mode: "fill_gaps",
    acquisitionScope: { hosts: ["example.com"], paths: ["/docs"] },
    limits: { cost: 0, calls: 0, discoveries: 2, materials: 2, chapters: 1 },
  });
  try {
    await f.activate();
    const qid = f.b.questions[0]!.id;
    const text = "权限补采原文保留例外。";
    const { hashBytes } =
      await import("../../apps/service/src/ingestion/objects");
    const ingestion = new Ingestion(
      f.registry,
      f.jobs,
      async () => ({
        ...f.artifact,
        title: "权限补采",
        text,
        blocks: [
          {
            id: "b0",
            text,
            hash: hashBytes(text),
            start: 0,
            end: text.length,
            kind: "text",
            locator: { lineStart: 1, lineEnd: 1 },
          },
        ],
      }),
      async () => ({
        body: Buffer.from(text),
        finalUrl: "https://example.com/docs",
        contentType: "text/plain",
      }),
    );
    const a = new Acquisition(f.db, ingestion),
      input = {
        operationId: randomUUID(),
        questionId: qid,
        entry: "https://example.com/docs",
        maxPages: 1,
      };
    const batch = await a.preview(f.r.id, input, f.principal);
    await expect(
      a.preview(f.r.id, { ...input, operationId: randomUUID() }, f.principal),
    ).rejects.toThrow("LIMIT");
    ingestion.freeze(
      batch.id,
      batch.digest,
      batch.entries.filter((e) => e.selected).map((e) => e.id),
      f.principal,
    );
    await ingestion.run(
      f.jobs.claim("batch", 30000, "ingestion")!,
      new AbortController().signal,
    );
    const { SourceCommit } =
      await import("../../apps/service/src/ingestion/commit");
    const commits = new SourceCommit(ingestion),
      change = commits.prepare(batch.id);
    commits.approve(change.id, change.digest, f.principal);
    for (const patch of change.patches) {
      const g = commits.grant(change.id, patch.sequence, f.principal);
      commits.receipt(g.token, patch.afterHash, f.principal);
    }
    commits.finish(
      change.id,
      change.patches.map((p) => p.afterHash),
      f.principal,
    );
    const next = await f.snapshots.propose(f.r.id, f.principal);
    expect(next.evidence.some((e) => e.text === text)).toBe(true);
    expect(f.db.get(f.r.id, f.principal)).toMatchObject({
      materialReservations: 0,
    });
    expect(f.db.get(f.r.id, f.principal).materialIds).toHaveLength(2);
    publish(f, "权限超额第三份资料。", "权限第三份");
    const bounded = await f.snapshots.propose(f.r.id, f.principal);
    expect(bounded.evidence.some((e) => e.text.includes("超额第三份"))).toBe(
      false,
    );
    expect(bounded.questions[0]!.warnings.join()).toContain("材料上限");
  } finally {
    await f.close();
  }
});
