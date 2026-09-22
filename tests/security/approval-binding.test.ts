import { test, expect } from "vitest";
import { wikiFixture } from "../wiki-helpers";
import { randomUUID } from "node:crypto";
test("approval binds paths, full bytes, provenance, policy and baseline; rejected proposals cannot resume", async () => {
  const f = await wikiFixture();
  try {
    for (const field of [
      "path",
      "content",
      "evidenceIds",
      "beforeHash",
    ] as const) {
      const c = f.prepare("candidate");
      f.approvals.approve(c.id, c.digest, f.principal);
      const changed = f.proposals.raw(c.id);
      const patch = changed.patches[0]!;
      if (field === "evidenceIds") patch[field] = [];
      else patch[field] = "tampered";
      f.proposals.save(changed);
      expect(() => f.writer.grant(c.id, 0, f.principal)).toThrow(
        "HASH_MISMATCH",
      );
    }
    const c = f.prepare("candidate");
    expect(() =>
      f.approvals.approve(c.id, "0".repeat(64), f.principal),
    ).toThrow("BASELINE");
    f.approvals.reject(c.id, c.digest, "需要核对条件", f.principal);
    expect(() => f.approvals.approve(c.id, c.digest, f.principal)).toThrow(
      "BASELINE",
    );
    const next = f.prepare("candidate");
    f.approvals.approve(next.id, next.digest, f.principal);
    const g = f.writer.grant(next.id, 0, f.principal);
    expect(() =>
      f.writer.receipt(g.token, g.patch.afterHash, {
        ...f.principal,
        id: randomUUID(),
      }),
    ).toThrow("FORBIDDEN");
    f.registry.saveSettings(f.registry.settings(), f.principal.policyVersion);
    expect(() => f.writer.grant(next.id, 0, f.principal)).toThrow("BASELINE");
  } finally {
    await f.close();
  }
});
test("expired approvals, renewed approval generations and revoked source prevent old grants", async () => {
  const f = await wikiFixture();
  try {
    const c = f.prepare("candidate");
    f.approvals.approve(c.id, c.digest, f.principal);
    const old = f.writer.grant(c.id, 0, f.principal);
    f.approvals.approve(c.id, c.digest, f.principal);
    expect(() =>
      f.writer.receipt(old.token, old.patch.afterHash, f.principal),
    ).toThrow("APPROVAL_EXPIRED");
    const g = f.writer.grant(c.id, 0, f.principal);
    f.advance(15001);
    expect(() =>
      f.writer.receipt(g.token, g.patch.afterHash, f.principal),
    ).toThrow("APPROVAL_EXPIRED");
    f.advance(600000);
    expect(() => f.writer.grant(c.id, 0, f.principal)).toThrow(
      "APPROVAL_EXPIRED",
    );
    f.store.set(`source:${f.answer.evidence[0]!.sourceId}`, {
      retracted: true,
    });
    expect(() => f.proposals.read(c.id, f.principal)).toThrow("FORBIDDEN");
  } finally {
    await f.close();
  }
});
