import { randomBytes, createHash } from "node:crypto";
import type { Principal, WriterGrant } from "@kb/contracts";
import { AppError } from "../errors";
import { recordProjectionReceipt } from "../projections/receipts";
import { PlanningLedger } from "./accept";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const plain = (s: string) =>
  s.replace(/[\r\n]/g, " ").replace(/[\\`*_{}\[\]()#+.!>|]/g, "\\$&");
export class PlanNotes {
  constructor(readonly ledger: PlanningLedger) {}
  get store() {
    return this.ledger.store;
  }
  pending(p: Principal) {
    this.ledger.db.guard.write(p);
    const current = this.store.get("tasks.acceptedPlan") as string | undefined;
    if (!current) return [];
    return (
      this.store.db
        .prepare(
          "SELECT plan_id FROM plan_outbox WHERE target='note' AND state='pending' AND plan_id=?",
        )
        .all(current) as { plan_id: string }[]
    ).map((r) => r.plan_id);
  }
  private content(id: string) {
    const row = this.store.db
      .prepare("SELECT value,candidate_id FROM plan_revisions WHERE id=?")
      .get(id) as { value: string; candidate_id: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    const plan = JSON.parse(row.value) as {
      acceptedAt: number;
      blocks: { taskId: string; start: number; end: number }[];
      unscheduled: { taskId: string; reason: string }[];
      coverage: { reason: string };
    };
    const candidate = this.ledger.candidate(row.candidate_id);
    const names = new Map(
      candidate.snapshot.tasks.map((t) => [t.id, plain(t.title)]),
    );
    const lines = [
      "# 已采用时间计划",
      "",
      `计划 ID：${id}`,
      `采用时间：${new Date(plan.acceptedAt).toISOString()}`,
      `日历覆盖：${plan.coverage.reason}`,
      "",
      "## 时间块",
      "",
    ];
    for (const b of plan.blocks)
      lines.push(
        `- ${new Date(b.start).toISOString()} — ${new Date(b.end).toISOString()}：${names.get(b.taskId) ?? b.taskId}`,
      );
    lines.push("", "## 未排项", "");
    for (const u of plan.unscheduled)
      lines.push(`- ${names.get(u.taskId) ?? u.taskId}：${u.reason}`);
    lines.push(
      "",
      "这是已采用计划的不可变投影。任务状态和工作日志仍以 TaskNotes 为准。",
      "",
    );
    return lines.join("\n");
  }
  grant(id: string, p: Principal): WriterGrant {
    this.ledger.db.guard.write(p);
    if (
      id !== this.store.get("tasks.acceptedPlan") ||
      !this.pending(p).includes(id)
    )
      throw new AppError("BASELINE");
    const content = this.content(id),
      hash = sha(content);
    const grant: WriterGrant = {
      token: randomBytes(32).toString("base64url"),
      changeId: id,
      digest: hash,
      patch: {
        sequence: 0,
        path: `KB-Plans/${id}.md`,
        beforeHash: null,
        afterHash: hash,
        content,
      },
      sessionId: p.id,
      vaultId: p.vaultId,
      deviceId: p.deviceId,
      epoch: p.epoch,
      policyVersion: p.policyVersion,
      expiresAt: Math.min(p.expiresAt, Date.now() + 15000),
    };
    this.store.db
      .prepare("INSERT INTO plan_note_grants VALUES(?,?,?,?)")
      .run(
        sha(grant.token),
        id,
        p.id,
        JSON.stringify({ ...grant, token: undefined }),
      );
    return grant;
  }
  receipt(id: string, token: string, afterHash: string, p: Principal) {
    return this.store.tx(() => {
      this.ledger.db.guard.write(p);
      const row = this.store.db
        .prepare(
          "SELECT principal_id,value FROM plan_note_grants WHERE token_hash=? AND plan_id=?",
        )
        .get(sha(token), id) as
        { principal_id: string; value: string } | undefined;
      if (
        !row ||
        row.principal_id !== p.id ||
        id !== this.store.get("tasks.acceptedPlan")
      )
        throw new AppError("BASELINE");
      const g = JSON.parse(row.value) as WriterGrant;
      if (
        g.expiresAt <= Date.now() ||
        g.epoch !== p.epoch ||
        g.policyVersion !== p.policyVersion ||
        g.patch.afterHash !== afterHash ||
        sha(this.content(id)) !== afterHash
      )
        throw new AppError("BASELINE");
      this.store.db
        .prepare(
          "UPDATE plan_outbox SET state='applied' WHERE id=? AND state='pending'",
        )
        .run(`note:${id}`);
      recordProjectionReceipt(this.store, {
        planId: id,
        target: "note",
        revision: afterHash,
        state: "applied",
      });
      return { state: "applied" };
    });
  }
}
