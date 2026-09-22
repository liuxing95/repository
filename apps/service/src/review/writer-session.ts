import { randomBytes } from "node:crypto";
import type { Principal, WriterGrant } from "@kb/contracts";
import { Approvals } from "./approval";
import { Proposals } from "./proposals";
import { hashBytes } from "../ingestion/objects";
import { AppError } from "../errors";
export class WriterSession {
  readonly approvals: Approvals;
  constructor(readonly proposals: Proposals) {
    this.approvals = new Approvals(proposals);
  }
  grant(id: string, sequence: number, p: Principal): WriterGrant {
    const c = this.proposals.read(id, p);
    this.approvals.check(c, p);
    const patch = c.patches.find((x) => x.sequence === sequence);
    if (!patch) throw new AppError("NOT_FOUND", 404);
    const grant: WriterGrant = {
      token: randomBytes(32).toString("base64url"),
      changeId: id,
      digest: c.digest,
      patch,
      vaultId: p.vaultId,
      deviceId: p.deviceId,
      epoch: p.epoch,
      policyVersion: c.policyVersion,
      sessionId: p.id,
      approvalId: c.approvalId!,
      expiresAt: Math.min(
        c.expiresAt!,
        p.expiresAt,
        this.proposals.now() + 15000,
      ),
    };
    this.proposals.store.db
      .prepare("INSERT INTO wiki_grants VALUES(?,?,?,?)")
      .run(
        hashBytes(grant.token),
        id,
        p.id,
        JSON.stringify({ ...grant, token: undefined }),
      );
    return grant;
  }
  validate(token: string, p: Principal) {
    const row = this.proposals.store.db
      .prepare("SELECT principal_id,value FROM wiki_grants WHERE token_hash=?")
      .get(hashBytes(token)) as
      { principal_id: string; value: string } | undefined;
    if (!row || row.principal_id !== p.id) throw new AppError("FORBIDDEN", 403);
    const g = JSON.parse(row.value) as WriterGrant;
    const c = this.proposals.read(g.changeId, p);
    this.approvals.check(c, p);
    if (
      g.expiresAt <= this.proposals.now() ||
      g.digest !== c.digest ||
      g.approvalId !== c.approvalId
    )
      throw new AppError("APPROVAL_EXPIRED");
    return { grant: g, change: c };
  }
  receipt(token: string, afterHash: string, p: Principal) {
    return this.proposals.store.tx(() => {
      const { grant, change } = this.validate(token, p);
      if (afterHash !== grant.patch.afterHash)
        throw new AppError("HASH_MISMATCH");
      this.proposals.store.db
        .prepare("INSERT OR IGNORE INTO wiki_receipts VALUES(?,?,?)")
        .run(change.id, grant.patch.sequence, afterHash);
      this.proposals.store.event("wiki.file_applied", change.id);
      return this.proposals.read(change.id, p);
    });
  }
}
