import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Profile, Scope } from "@kb/contracts";
import { fixture } from "../helpers";
import { publish } from "../evidence-helpers";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
test("fixed UTF-16 evidence survives new revisions; damaged locator and lineage cycles fail closed", async () => {
  const f = await fixture();
  try {
    const p = publish(f, "甲😀乙\n权限不可默认开启。");
    const e = new EvidenceStore(f.registry);
    const evidence = e.register(p)[0]!;
    expect(e.read(evidence.id).end).toBe(p.text.length);
    publish(f, "另一个版本，旧正文不变。");
    expect(e.read(evidence.id).text).toBe(p.text);
    const other = publish(f, "转载");
    const second = e.register(other)[0]!;
    e.setFamily(second.sourceId, evidence.sourceId);
    expect(e.family(second.sourceId)).toBe(evidence.sourceId);
    expect(() => e.setFamily(evidence.sourceId, second.sourceId)).toThrow(
      "SOURCE_CYCLE",
    );
    expect(e.family(evidence.sourceId)).toBe(evidence.sourceId);
    const changed = {
      ...p,
      blocks: p.blocks.map((b) => ({ ...b, start: b.start + 1 })),
    };
    f.store.db
      .prepare("UPDATE parse_artifacts SET value=? WHERE id=?")
      .run(JSON.stringify(changed), p.id);
    expect(() => e.read(evidence.id)).toThrow("HASH_MISMATCH");
  } finally {
    await f.close();
  }
});
test("generated pages cannot cite themselves and unknown ranges cannot manufacture conflicts", async () => {
  const f = await fixture();
  try {
    const p = publish(f, "权限默认关闭");
    const e = new EvidenceStore(f.registry);
    const ref = e.register(p)[0]!;
    expect(() =>
      e.setProfile(
        p.id,
        Profile.parse({ kind: "wiki", originalEvidence: [ref.id] }),
      ),
    ).toThrow("SOURCE_CYCLE");
    const a = {
      id: randomUUID(),
      text: "关闭",
      kind: "sourced",
      scope: Scope.parse({}),
      evidenceIds: [ref.id],
    };
    const b = { ...a, id: randomUUID(), text: "开启" };
    e.saveClaim(a);
    e.saveClaim(b);
    expect(() =>
      e.relation({ from: a.id, to: b.id, type: "contradicts" }),
    ).toThrow("SCOPE_UNKNOWN");
    expect(e.relation({ from: a.id, to: b.id, type: "related-to" }).type).toBe(
      "related-to",
    );
  } finally {
    await f.close();
  }
});
