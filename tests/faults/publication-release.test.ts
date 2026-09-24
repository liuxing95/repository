import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Purpose } from "@kb/contracts";
import { wikiFixture } from "../wiki-helpers";
import { Policy } from "../../apps/service/src/security/policy";
import { Publications } from "../../apps/service/src/publishing/release";
import { Retraction } from "../../apps/service/src/lifecycle/retraction";
import { digest } from "../../apps/service/src/workspace/registry";

test("approved final bytes publish locally, retry is idempotent, and source retraction withdraws current link", async () => {
  const f = await wikiFixture();
  try {
    await f.apply(f.prepare("candidate"));
    const wiki = await f.apply(f.prepare("wiki"));
    const page = f.proposals.page(wiki.patches[0]!.pageId)!;
    const sourceId = f.evidence.read(page.evidenceIds[0]!).sourceId;
    f.registry.saveSettings(
      {
        schemaVersion: 1,
        budget: null,
        routes: [
          { id: "local-site", purpose: "publish", enabled: true, price: null },
        ],
      },
      f.registry.get().policyVersion,
    );
    new Policy(f.registry).setSource({
      sourceId,
      retracted: false,
      routes: Object.fromEntries(
        Purpose.options.map((purpose) => [
          purpose,
          purpose === "read"
            ? ["local"]
            : purpose === "publish"
              ? ["local-site"]
              : [],
        ]),
      ),
    });
    const principal = f.sessions.refresh(f.token);
    const publications = new Publications(f.evidence, async (pages) => ({
      "index.html": `<html>${pages.map((p) => p.title).join(" ")}</html>`,
      "search.json": JSON.stringify(
        pages.map((p) => ({ title: p.title, path: p.file })),
      ),
      ...Object.fromEntries(
        pages.map((p) => [p.file, `<html><pre>${p.body}</pre></html>`]),
      ),
    }));
    const input = {
      operationId: randomUUID(),
      revisionIds: [page.revisionId],
      routeId: "local-site",
      decisions: {},
    };
    const preview = await publications.build(input, principal);
    expect(() =>
      publications.release(
        preview.manifest.id,
        randomUUID(),
        preview.manifest.digest,
        preview.manifest.outputDigest,
        principal,
      ),
    ).toThrow("BASELINE");
    expect(() =>
      publications.approve(
        preview.manifest.id,
        "0".repeat(64),
        preview.manifest.outputDigest,
        principal,
      ),
    ).toThrow("BASELINE");
    publications.approve(
      preview.manifest.id,
      preview.manifest.digest,
      preview.manifest.outputDigest,
      principal,
    );
    const operationId = randomUUID();
    const first = await publications.release(
      preview.manifest.id,
      operationId,
      preview.manifest.digest,
      preview.manifest.outputDigest,
      principal,
    );
    const second = await publications.release(
      preview.manifest.id,
      operationId,
      preview.manifest.digest,
      preview.manifest.outputDigest,
      principal,
    );
    expect(second).toEqual(first);
    expect(first.state).toBe("published-local");
    expect(
      publications.list(principal).find((r) => r.id === first.id)?.localPresent,
    ).toBe(true);
    const link = join(f.data, "public-site", "current");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(link, "index.html"), "utf8")).toBe(
      preview.files.find((f) => f.path === "index.html")!.content,
    );
    const impact = new Retraction(f.registry).retract(
      sourceId,
      principal.id,
      "来源不再允许公开",
    );
    expect(impact.publications).toMatchObject([
      { releaseId: first.id, state: "withdrawn" },
    ]);
    expect(
      publications.list(principal).find((r) => r.id === first.id)?.localPresent,
    ).toBe(false);
    await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() =>
      publications.preview(preview.manifest.id, f.sessions.refresh(f.token)),
    ).toThrow();
    expect(() =>
      publications.release(
        preview.manifest.id,
        randomUUID(),
        preview.manifest.digest,
        preview.manifest.outputDigest,
        f.sessions.refresh(f.token),
      ),
    ).toThrow();
  } finally {
    await f.close();
  }
});

test("tampering with saved output after approval fails before release", async () => {
  const f = await wikiFixture();
  try {
    await f.apply(f.prepare("candidate"));
    const wiki = await f.apply(f.prepare("wiki"));
    const page = f.proposals.page(wiki.patches[0]!.pageId)!;
    const sourceId = f.evidence.read(page.evidenceIds[0]!).sourceId;
    f.registry.saveSettings(
      {
        schemaVersion: 1,
        budget: null,
        routes: [
          { id: "local-site", purpose: "publish", enabled: true, price: null },
        ],
      },
      f.registry.get().policyVersion,
    );
    new Policy(f.registry).setSource({
      sourceId,
      retracted: false,
      routes: Object.fromEntries(
        Purpose.options.map((purpose) => [
          purpose,
          purpose === "read"
            ? ["local"]
            : purpose === "publish"
              ? ["local-site"]
              : [],
        ]),
      ),
    });
    const principal = f.sessions.refresh(f.token);
    const publications = new Publications(f.evidence, async (pages) => ({
      "index.html": "index",
      "search.json": "[]",
      [pages[0]!.file]: "page",
    }));
    const preview = await publications.build(
      {
        operationId: randomUUID(),
        revisionIds: [page.revisionId],
        routeId: "local-site",
        decisions: {},
      },
      principal,
    );
    publications.approve(
      preview.manifest.id,
      preview.manifest.digest,
      preview.manifest.outputDigest,
      principal,
    );
    preview.files[0]!.content = "changed after approval";
    f.store.set(`publication:preview:${preview.manifest.id}`, preview);
    expect(() =>
      publications.release(
        preview.manifest.id,
        randomUUID(),
        preview.manifest.digest,
        preview.manifest.outputDigest,
        principal,
      ),
    ).toThrow("HASH_MISMATCH");
  } finally {
    await f.close();
  }
});

test("partial local upload confirms only matching files and retries the same release", async () => {
  const f = await wikiFixture();
  try {
    await f.apply(f.prepare("candidate"));
    const wiki = await f.apply(f.prepare("wiki"));
    const page = f.proposals.page(wiki.patches[0]!.pageId)!;
    const sourceId = f.evidence.read(page.evidenceIds[0]!).sourceId;
    f.registry.saveSettings(
      {
        schemaVersion: 1,
        budget: null,
        routes: [
          { id: "local-site", purpose: "publish", enabled: true, price: null },
        ],
      },
      f.registry.get().policyVersion,
    );
    new Policy(f.registry).setSource({
      sourceId,
      retracted: false,
      routes: Object.fromEntries(
        Purpose.options.map((purpose) => [
          purpose,
          purpose === "read"
            ? ["local"]
            : purpose === "publish"
              ? ["local-site"]
              : [],
        ]),
      ),
    });
    const principal = f.sessions.refresh(f.token);
    const publications = new Publications(f.evidence, async (pages) => ({
      "index.html": "index",
      "search.json": "[]",
      [pages[0]!.file]: "page",
    }));
    const preview = await publications.build(
      {
        operationId: randomUUID(),
        revisionIds: [page.revisionId],
        routeId: "local-site",
        decisions: {},
      },
      principal,
    );
    publications.approve(
      preview.manifest.id,
      preview.manifest.digest,
      preview.manifest.outputDigest,
      principal,
    );
    const releaseId = randomUUID(),
      operationId = randomUUID();
    const record = {
      id: releaseId,
      previewId: preview.manifest.id,
      manifestDigest: preview.manifest.digest,
      outputDigest: preview.manifest.outputDigest,
      target: "local-static-site",
      approvedBy: principal.id,
      releasedBy: principal.id,
      sourceIds: [sourceId],
      previousId: null,
      state: "uploading",
      confirmed: [],
      unconfirmed: preview.manifest.output.map((o) => o.path),
      externalReleaseId: null,
      at: Date.now(),
      historical: false,
    };
    f.store.set(`publication:release:${releaseId}`, record);
    f.store.set(`publication:release-op:${principal.id}:${operationId}`, {
      id: releaseId,
      inputHash: digest({
        id: preview.manifest.id,
        manifestDigest: preview.manifest.digest,
        outputDigest: preview.manifest.outputDigest,
      }),
    });
    const dir = join(f.data, "public-site", "releases", releaseId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.html"), "wrong bytes");
    await expect(
      publications.release(
        preview.manifest.id,
        operationId,
        preview.manifest.digest,
        preview.manifest.outputDigest,
        principal,
      ),
    ).rejects.toThrow("HASH_MISMATCH");
    const partial = publications
      .list(principal)
      .find((r) => r.id === releaseId)!;
    expect(partial).toMatchObject({
      state: "partial",
      unconfirmed: expect.arrayContaining(["index.html"]),
    });
    const confirmedPath = partial.confirmed[0]!;
    await writeFile(join(dir, confirmedPath), "changed after confirmation");
    await rm(join(dir, "index.html"));
    await expect(
      publications.release(
        preview.manifest.id,
        operationId,
        preview.manifest.digest,
        preview.manifest.outputDigest,
        principal,
      ),
    ).rejects.toThrow("HASH_MISMATCH");
    await writeFile(
      join(dir, confirmedPath),
      preview.files.find((file) => file.path === confirmedPath)!.content,
    );
    const completed = await publications.release(
      preview.manifest.id,
      operationId,
      preview.manifest.digest,
      preview.manifest.outputDigest,
      principal,
    );
    expect(completed.state).toBe("published-local");
    expect(completed.unconfirmed).toEqual([]);
  } finally {
    await f.close();
  }
});

test("rollback reuses an approved older artifact after Wiki changes only while its source remains allowed", async () => {
  const f = await wikiFixture();
  try {
    await f.apply(f.prepare("candidate"));
    const firstWiki = await f.apply(f.prepare("wiki"));
    const firstPage = f.proposals.page(firstWiki.patches[0]!.pageId)!;
    const sourceId = f.evidence.read(firstPage.evidenceIds[0]!).sourceId;
    f.registry.saveSettings(
      {
        schemaVersion: 1,
        budget: null,
        routes: [
          { id: "local-site", purpose: "publish", enabled: true, price: null },
        ],
      },
      f.registry.get().policyVersion,
    );
    new Policy(f.registry).setSource({
      sourceId,
      retracted: false,
      routes: Object.fromEntries(
        Purpose.options.map((purpose) => [
          purpose,
          purpose === "read"
            ? ["local"]
            : purpose === "publish"
              ? ["local-site"]
              : [],
        ]),
      ),
    });
    const principal = f.sessions.refresh(f.token);
    Object.assign(f.principal, principal);
    f.connection.principal = principal;
    f.connection.workspace = f.registry.get();
    const publications = new Publications(f.evidence, async (pages) => ({
      "index.html": "index",
      "search.json": "[]",
      [pages[0]!.file]: `page:${pages[0]!.body}`,
    }));
    const first = await publications.build(
      {
        operationId: randomUUID(),
        revisionIds: [firstPage.revisionId],
        routeId: "local-site",
        decisions: {},
      },
      principal,
    );
    publications.approve(
      first.manifest.id,
      first.manifest.digest,
      first.manifest.outputDigest,
      principal,
    );
    await publications.release(
      first.manifest.id,
      randomUUID(),
      first.manifest.digest,
      first.manifest.outputDigest,
      principal,
    );
    const update = f.proposals.prepare(
      {
        operationId: randomUUID(),
        candidateId: f.answer.id,
        destination: "wiki",
        title: "权限概念",
        kind: "concept",
        confirmedDecision: "公开版二",
      },
      principal,
    );
    await f.apply(update);
    const latest = f.proposals.page(firstPage.pageId)!;
    expect(latest.revisionId).not.toBe(firstPage.revisionId);
    const second = await publications.build(
      {
        operationId: randomUUID(),
        revisionIds: [latest.revisionId],
        routeId: "local-site",
        decisions: {},
      },
      principal,
    );
    publications.approve(
      second.manifest.id,
      second.manifest.digest,
      second.manifest.outputDigest,
      principal,
    );
    const secondRelease = await publications.release(
      second.manifest.id,
      randomUUID(),
      second.manifest.digest,
      second.manifest.outputDigest,
      principal,
    );
    const rollback = await publications.release(
      first.manifest.id,
      randomUUID(),
      first.manifest.digest,
      first.manifest.outputDigest,
      principal,
    );
    expect(rollback.historical).toBe(true);
    expect(rollback.previousId).toBe(secondRelease.id);
    const file = first.manifest.pages[0]!.file;
    expect(
      await readFile(join(f.data, "public-site", "current", file), "utf8"),
    ).toBe(first.files.find((entry) => entry.path === file)!.content);
    new Retraction(f.registry).retract(sourceId, principal.id, "来源撤回");
    expect(
      publications
        .list(principal)
        .every(
          (record) => record.state === "withdrawn" && !record.localPresent,
        ),
    ).toBe(true);
    expect(() =>
      publications.release(
        first.manifest.id,
        randomUUID(),
        first.manifest.digest,
        first.manifest.outputDigest,
        f.sessions.refresh(f.token),
      ),
    ).toThrow();
  } finally {
    await f.close();
  }
});
