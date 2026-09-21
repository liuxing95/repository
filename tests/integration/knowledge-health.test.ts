import { test, expect } from "vitest";
import { fixture } from "../helpers";
import { publish } from "../evidence-helpers";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
import { knowledgeHealth } from "../../apps/service/src/evidence/health";
test("health reports unsourced pages and broken fixed locators without leaking restricted text", async () => {
  const f = await fixture();
  try {
    const e = new EvidenceStore(f.registry);
    const p = publish(f, "生成页未核实");
    e.setProfile(p.id, { kind: "wiki" });
    const secret = publish(f, "不应泄露的私密正文");
    const ref = e.register(secret)[0]!;
    f.store.set(`source:${ref.sourceId}`, { retracted: true });
    const report = knowledgeHealth(e, f.principal);
    expect(report.issues.some((i) => i.kind === "unsourced")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("私密正文");
    f.store.db
      .prepare(
        "UPDATE parse_artifacts SET value=json_set(value,'$.text','损坏') WHERE id=?",
      )
      .run(p.id);
    expect(
      knowledgeHealth(e, f.principal).issues.some(
        (i) => i.kind === "invalid-locator",
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});
