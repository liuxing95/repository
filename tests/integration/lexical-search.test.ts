import { test, expect } from "vitest";
import { Profile } from "@kb/contracts";
import { fixture } from "../helpers";
import { publish } from "../evidence-helpers";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
import { SearchService } from "../../apps/service/src/search/search";
test("local search covers Chinese short words, trusted aliases, exact code symbols and scopes", async () => {
  const f = await fixture();
  try {
    const p = publish(
      f,
      "权限 重排 C++ Node.js parseValue /src/a.ts",
      "权限指南",
      { version: "24", collection: "开发" },
    );
    publish(f, "权限旧版", "旧版", { version: "22" });
    const e = new EvidenceStore(f.registry),
      s = new SearchService(e);
    for (const query of [
      "权限",
      "重排",
      "permissions",
      "C++",
      "Node.js",
      "parseValue",
      "/src/a.ts",
    ]) {
      const r = await s.search(
        { query, scope: { version: "24" }, collection: "开发" },
        f.principal,
      );
      expect(r.hits[0]?.parseId).toBe(p.id);
      expect(r.hits[0]?.text).toContain("权限");
    }
    const r = await s.search(
      { query: "权限", review: "reviewed" },
      f.principal,
    );
    expect(r.hits).toHaveLength(0);
    e.setProfile(p.id, Profile.parse({ review: "reviewed" }));
    expect(
      (await s.search({ query: "权限", review: "reviewed" }, f.principal)).hits,
    ).toHaveLength(1);
    expect(
      (
        await s.search(
          { query: "权限", asOf: "2020-01-01T00:00:00Z" },
          f.principal,
        )
      ).hits,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test("read filtering precedes rank limit and source families count once", async () => {
  const f = await fixture();
  try {
    const e = new EvidenceStore(f.registry),
      s = new SearchService(e);
    for (let i = 0; i < 12; i++) {
      const p = publish(f, "权限 权限 权限", "权限");
      const id = e.register(p)[0]!.sourceId;
      f.store.set(`source:${id}`, {
        sourceId: id,
        retracted: true,
        routes: { read: [] },
      });
    }
    const p = publish(f, "权限说明", "可读资料");
    const parent = e.register(p)[0]!.sourceId;
    for (let i = 0; i < 5; i++) {
      const copy = publish(f, "权限说明", `转载${i}`);
      e.setFamily(e.register(copy)[0]!.sourceId, parent);
    }
    const r = await s.search({ query: "权限", limit: 1 }, f.principal);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.familyId).toBe(parent);
  } finally {
    await f.close();
  }
});
test("generation publish is atomic, snapshots survive rebuild until released, failed builds preserve active index", async () => {
  const f = await fixture();
  try {
    const e = new EvidenceStore(f.registry),
      s = new SearchService(e);
    publish(f, "权限");
    const first = await s.search({ query: "权限" }, f.principal);
    const p = publish(f, "权限更新");
    const pending = s.indexer.rebuild();
    expect(s.indexer.active()?.id).toBe(first.snapshot.generation);
    const during = await s.search({ query: "权限" }, f.principal);
    expect(during.index.state).toBe("partial");
    await pending;
    expect(
      (
        await s.search(
          { ...first.snapshot.input, snapshotId: first.snapshot.id },
          f.principal,
        )
      ).hits,
    ).toHaveLength(1);
    const current = s.indexer.active()!.id;
    s.indexer.collect();
    expect(s.snapshot(first.snapshot.id, f.principal).generation).toBe(
      first.snapshot.generation,
    );
    f.store.db
      .prepare(
        "UPDATE parse_artifacts SET value=json_set(value,'$.text','损坏') WHERE id=?",
      )
      .run(p.id);
    await expect(s.indexer.rebuild()).rejects.toThrow("HASH_MISMATCH");
    expect(s.indexer.active()!.id).toBe(current);
  } finally {
    await f.close();
  }
});

test("snapshot freezes selected evidence and refuses changed applicability metadata", async () => {
  const f = await fixture();
  try {
    const p = publish(f, "权限说明");
    const e = new EvidenceStore(f.registry),
      s = new SearchService(e);
    const r = await s.search({ query: "权限" }, f.principal);
    e.setProfile(p.id, { scope: { version: "99" } });
    await expect(
      s.search({ ...r.snapshot.input, snapshotId: r.snapshot.id }, f.principal),
    ).rejects.toThrow("BASELINE");
  } finally {
    await f.close();
  }
});

test("historical scope admits verified contemporaneous publication but excludes later and unknown material", async () => {
  const f = await fixture();
  try {
    const e = new EvidenceStore(f.registry),
      s = new SearchService(e);
    const old = publish(f, "权限当时的说明");
    const later = publish(f, "权限后见解释");
    publish(f, "权限未知时间");
    e.setProfile(old.id, {
      confirmedPublishedAt: "2020-01-01T00:00:00Z",
      publicationEvidence: "人工核对原始发布记录",
    });
    e.setProfile(later.id, {
      confirmedPublishedAt: "2022-01-01T00:00:00Z",
      publicationEvidence: "人工核对原始发布记录",
    });
    const result = await s.search(
      { query: "权限", asOf: "2021-01-01T00:00:00Z" },
      f.principal,
    );
    expect(result.hits.map((h) => h.parseId)).toEqual([old.id]);
    expect(() =>
      e.setProfile(old.id, { confirmedPublishedAt: "2020-01-01T00:00:00Z" }),
    ).toThrow("VALIDATION");
  } finally {
    await f.close();
  }
});

test("punctuated symbols do not degrade into loose words or lose absolute path prefixes", async () => {
  const f = await fixture();
  try {
    publish(
      f,
      "C and node and js are unrelated words. src/a.ts is a relative path.",
    );
    const precise = publish(f, "C++ Node.js /src/a.ts");
    const s = new SearchService(new EvidenceStore(f.registry));
    for (const query of ["C++", "Node.js", "/src/a.ts"]) {
      const r = await s.search({ query }, f.principal);
      expect(r.hits.map((h) => h.parseId)).toEqual([precise.id]);
    }
  } finally {
    await f.close();
  }
});
