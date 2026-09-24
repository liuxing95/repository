import { randomUUID } from "node:crypto";
import type { Principal, WikiChangeSet } from "@kb/contracts";
import { Proposals } from "./proposals";
import { AppError } from "../errors";
export class Approvals {
  constructor(readonly proposals: Proposals) {}
  approve(id: string, expected: string, p: Principal) {
    return this.proposals.store.tx(() => {
      const c = this.proposals.read(id, p);
      this.proposals.write(p, c.policyVersion);
      if (
        c.digest !== expected ||
        c.epoch !== p.epoch ||
        c.state === "rejected"
      )
        throw new AppError("BASELINE");
      if (c.state === "committed" || c.state === "no_change") return c;
      this.proposals.baseline(c);
      c.approvedBy = p.id;
      c.approvalId = randomUUID();
      c.expiresAt = this.proposals.now() + 600000;
      c.state = "approved";
      this.proposals.store.db
        .prepare("INSERT INTO wiki_approvals VALUES(?,?,?)")
        .run(
          c.approvalId,
          c.id,
          JSON.stringify({
            digest: c.digest,
            principal: p,
            expiresAt: c.expiresAt,
            action: "approve",
          }),
        );
      this.proposals.save(c);
      this.proposals.store.event("wiki.approved", c.id);
      return c;
    });
  }
  reject(id: string, expected: string, reason: string, p: Principal) {
    return this.proposals.store.tx(() => {
      const c = this.proposals.read(id, p);
      this.proposals.write(p);
      if (c.digest !== expected || c.state === "committed")
        throw new AppError("BASELINE");
      c.state = "rejected";
      c.rejection = reason;
      c.approvalId = null;
      c.expiresAt = null;
      this.proposals.store.db
        .prepare("INSERT INTO wiki_approvals VALUES(?,?,?)")
        .run(
          randomUUID(),
          id,
          JSON.stringify({
            digest: c.digest,
            principalId: p.id,
            reason,
            action: "reject",
            at: this.proposals.now(),
          }),
        );
      this.proposals.save(c);
      this.proposals.store.event("wiki.rejected", id);
      return c;
    });
  }
  check(c: WikiChangeSet, p: Principal) {
    this.proposals.write(p, c.policyVersion);
    this.proposals.references(c);
    this.proposals.baseline(c);
    if (
      c.state !== "approved" ||
      c.approvedBy !== p.id ||
      c.epoch !== p.epoch ||
      !c.approvalId ||
      (c.expiresAt ?? 0) <= this.proposals.now()
    )
      throw new AppError(
        "APPROVAL_EXPIRED",
        409,
        "重新打开审核，核对已应用和剩余文件后再次批准。",
      );
    const row = this.proposals.store.db
      .prepare("SELECT value FROM wiki_approvals WHERE id=?")
      .get(c.approvalId) as { value: string } | undefined;
    if (!row || JSON.parse(row.value).digest !== c.digest)
      throw new AppError("HASH_MISMATCH");
  }
}
