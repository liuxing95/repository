import type { Principal } from "@kb/contracts";
import { Claim } from "@kb/contracts";
import { EvidenceStore } from "./locator";
export function knowledgeHealth(evidence: EvidenceStore, p: Principal) {
  evidence.checkPrincipal(p);
  const issues: {
    kind: string;
    parseId?: string;
    evidenceId?: string;
    claimId?: string;
    message: string;
  }[] = [];
  const rows = evidence.store.db
    .prepare(
      "SELECT p.id,r.source_id FROM parse_artifacts p JOIN source_revisions r ON r.id=p.revision_id WHERE p.committed=1",
    )
    .all() as { id: string; source_id: string }[];
  for (const row of rows) {
    if (!evidence.readable(row.source_id)) {
      issues.push({
        kind: "restricted",
        message: "一份来源已限制读取；相关结果不可继续使用。",
      });
      continue;
    }
    try {
      const profile = evidence.profile(row.id);
      const parse = evidence.commits.parse(row.id);
      if (
        ["wiki", "summary", "answer"].includes(profile.kind) &&
        !profile.originalEvidence.length
      )
        issues.push({
          kind: "unsourced",
          parseId: row.id,
          message: "派生内容没有原始证据。",
        });
      for (const id of profile.originalEvidence) {
        try {
          evidence.read(id);
        } catch {
          issues.push({
            kind: "broken-origin",
            parseId: row.id,
            message: "原始证据不可读取或定位已失效。",
          });
        }
      }
      if (!parse.blocks.length)
        issues.push({
          kind: "isolated",
          parseId: row.id,
          message: "没有可定位的原文块。",
        });
      if (parse.gaps.length)
        issues.push({
          kind: "coverage",
          parseId: row.id,
          message: parse.gaps.join("；"),
        });
    } catch {
      issues.push({
        kind: "invalid-locator",
        parseId: row.id,
        message: "固定原文定位校验失败。",
      });
    }
  }
  const claims = evidence.store.db
    .prepare("SELECT id,value FROM evidence_claims")
    .all() as { id: string; value: string }[];
  const readableClaims = new Set<string>();
  for (const row of claims) {
    const claim = Claim.parse(JSON.parse(row.value));
    try {
      for (const id of claim.evidenceIds) evidence.read(id);
      readableClaims.add(row.id);
    } catch {
      continue;
    }
    if (!claim.evidenceIds.length)
      issues.push({
        kind: "unsourced-claim",
        claimId: row.id,
        message: "主张没有固定来源。",
      });
  }
  const conflicts = evidence.store.db
    .prepare(
      "SELECT from_id,to_id FROM evidence_relations WHERE kind='contradicts'",
    )
    .all() as { from_id: string; to_id: string }[];
  for (const row of conflicts)
    if (readableClaims.has(row.from_id) && readableClaims.has(row.to_id))
      issues.push({
        kind: "conflict",
        claimId: row.from_id,
        message: "存在同范围分歧候选，需要核对互斥结论。",
      });
  const superseded = evidence.store.db
    .prepare(
      "SELECT from_id,to_id FROM evidence_relations WHERE kind='supersedes'",
    )
    .all() as { from_id: string; to_id: string }[];
  for (const relation of superseded)
    if (
      readableClaims.has(relation.from_id) &&
      readableClaims.has(relation.to_id)
    )
      issues.push({
        kind: "superseded",
        claimId: relation.to_id,
        message:
          "此主张已有显式登记的替代关系，请核对历史适用条件；没有按日期自动覆盖。",
      });
  for (const id of readableClaims)
    if (
      !evidence.store.db
        .prepare("SELECT 1 FROM evidence_relations WHERE from_id=? OR to_id=?")
        .get(id, id)
    )
      issues.push({
        kind: "isolated-claim",
        claimId: id,
        message: "此主张尚无登记的知识关系。",
      });
  return {
    issues,
    limitations: [
      "只检查已登记来源与主张；尚未扫描未来场景 04 的 Wiki 页面。",
      "公开时间未知不能自动判定过期，时间晚也不代表取代旧结论。",
    ],
  };
}
