import { randomUUID } from "node:crypto";
import type { Principal, WikiChangeSet, WikiPage } from "@kb/contracts";
import { Proposals, proposalDigest } from "./proposals";
import { AppError } from "../errors";
import { digest } from "../workspace/registry";
import { hashBytes } from "../ingestion/objects";
// Reversal is a new, reviewable proposal; it neither deletes history nor writes files here.
export function reverse(
  proposals: Proposals,
  id: string,
  operationId: string,
  p: Principal,
) {
  proposals.write(p);
  return proposals.store.tx(() => {
    const inputHash = digest({ reverse: id }),
      key = `${p.id}:${operationId}`;
    const existing = proposals.store.db
      .prepare("SELECT id,input_hash FROM wiki_changes WHERE operation_key=?")
      .get(key) as { id: string; input_hash: string } | undefined;
    if (existing) {
      if (existing.input_hash !== inputHash) throw new AppError("CONFLICT");
      return proposals.read(existing.id, p);
    }
    const original = proposals.read(id, p);
    if (
      original.destination !== "wiki" ||
      original.state !== "committed" ||
      original.patches.some((patch) => patch.beforeContent === null)
    )
      throw new AppError(
        "REVERSE_UNAVAILABLE",
        409,
        "只为已有页面更新生成反向提案；首次新建不自动删除文件。",
      );
    const w = proposals.evidence.registry.get();
    const c: WikiChangeSet = {
      ...original,
      id: randomUUID(),
      purpose: `撤销更新：${original.purpose}`,
      digest: "",
      state: "prepared",
      createdBy: p.id,
      createdAt: proposals.now(),
      policyVersion: w.policyVersion,
      epoch: w.epoch,
      approvedBy: null,
      approvalId: null,
      expiresAt: null,
      receipts: [],
      rejection: null,
      deferred: [
        "恢复的是原更新前的完整字节；人工新增内容不自动成为已验证主张。",
      ],
      patches: [],
    };
    for (const patch of original.patches) {
      const current = proposals.page(patch.pageId);
      if (!current) throw new AppError("BASELINE");
      const observation = proposals.observation(patch.pageId);
      const beforeContent = observation
        ? (JSON.parse(observation.value) as { content: string | null }).content
        : current.content;
      const previousRow = proposals.store.db
        .prepare("SELECT value FROM wiki_revisions WHERE id=?")
        .get(patch.beforeRevision) as { value: string } | undefined;
      const previous = previousRow
        ? (JSON.parse(previousRow.value) as WikiPage)
        : undefined;
      const content = patch.beforeContent!;
      const claims =
        previous?.hash === hashBytes(content) ? previous.claims : [];
      const evidenceIds = [
        ...new Set([
          ...patch.evidenceIds,
          ...current.evidenceIds,
          ...(previous?.evidenceIds ?? []),
        ]),
      ];
      c.patches.push({
        ...patch,
        beforeContent,
        beforeHash: beforeContent === null ? null : hashBytes(beforeContent),
        beforeRevision: current.revisionId,
        observationId: observation?.id ?? null,
        revisionId: randomUUID(),
        content,
        afterHash: hashBytes(content),
        claims,
        evidenceIds,
      });
      for (const evidenceId of evidenceIds)
        if (!c.evidence.some((e) => e.id === evidenceId))
          c.evidence.push(proposals.evidence.read(evidenceId));
    }
    c.digest = proposalDigest(c);
    proposals.store.db
      .prepare("INSERT INTO wiki_changes VALUES(?,?,?,?)")
      .run(c.id, key, inputHash, JSON.stringify(c));
    proposals.store.event("wiki.reverse_prepared", c.id);
    return c;
  });
}
