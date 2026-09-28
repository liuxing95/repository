import type { SavedCandidate } from "../review/candidates";
import type { ProposalInput } from "@kb/contracts";
import { AppError } from "../errors";
// Deterministic compilation has no capabilities: no filesystem, network, model or executable output.
export const COMPILER_VERSION = "native-evidence-page-v1";
// Draft prose is text, not a channel for HTML, embeds, commands or remote images.
export const prose = (value: string) => value.replace(/([\\`*_{}\[\]()<>#+.!|~-])/g, "\\$1");
export function literal(value: string) {
  const fence = "`".repeat(
    Math.max(3, ...[...value.matchAll(/`+/g)].map((m) => m[0].length + 1)),
  );
  return `${fence}text\n${value}\n${fence}`;
}
export function compileCandidate(
  candidate: SavedCandidate,
  input: ProposalInput,
) {
  if (input.kind === "decision" && !input.confirmedDecision)
    throw new AppError(
      "USER_CONFIRMATION_REQUIRED",
      409,
      "决定页需要填写本人确认的决定；模型建议不能自动提升为决定。",
    );
  if (candidate.draft) {
    const refs = candidate.answer.evidence.filter((e) => candidate.draft!.paragraphs.some((p) => p.evidenceIds.includes(e.id)));
    const content = [
      `# ${prose(candidate.draft.title)}`,
      ...candidate.draft.paragraphs.map((p) => `${prose(p.text)}${p.evidenceIds.map((id) => {
        const index = refs.findIndex((e) => e.id === id);
        if (index < 0) throw new AppError("INVALID_CITATION");
        return `[^${index + 1}]`;
      }).join("")}${p.evidenceIds.length ? "" : "（本段未附来源，需人工核对）"}`),
      ...(input.confirmedDecision ? ["## 用户明确决定", prose(input.confirmedDecision)] : []),
      "## 来源与审核说明",
      `本机草稿修订 ${candidate.draft.revision}。模型综合及人工编辑均需核对；引用有效不等于语义已经证实。`,
      ...refs.map((e, i) => `[^${i + 1}]: ${prose(e.title)}；${prose(e.locator.heading?.join(" / ") ?? "")}。证据：\`${e.id}\`；来源修订：\`${e.revisionId}\`。`),
      ...(candidate.answer.gaps.length ? ["## 资料缺口", ...candidate.answer.gaps.map(prose)] : []),
    ].join("\n\n") + "\n";
    if (Buffer.byteLength(content) > 128000) throw new AppError("LIMIT");
    return { content, claims: candidate.answer.claims, deferred: candidate.answer.gaps, evidenceIds: refs.map((e) => e.id) };
  }
  if (candidate.report && input.destination === "candidate") {
    if (Buffer.byteLength(candidate.report.content) > 128000)
      throw new AppError("LIMIT");
    return {
      content: candidate.report.content,
      claims: candidate.answer.claims,
      deferred: candidate.answer.gaps,
      evidenceIds: candidate.answer.evidence.map((e) => e.id),
    };
  }
  const all = candidate.answer.claims;
  const claims = all.slice(0, 20);
  const evidence = candidate.answer.evidence;
  for (const c of claims) {
    if (c.evidenceIds.some((id) => !evidence.some((e) => e.id === id)))
      throw new AppError("INVALID_CITATION");
    if (
      c.kind === "sourced" &&
      !c.evidenceIds.some((id) =>
        evidence.some((e) => e.id === id && e.text === c.text),
      )
    )
      throw new AppError("UNSUPPORTED_CLAIM");
  }
  const deferred =
    all.length > 20
      ? [`剩余 ${all.length - 20} 条主张待处理，本次最多 20 条。`]
      : [];
  const content =
    [
      `# ${input.title.replace(/[\r\n]/g, " ").replace(/[<>\[\]#!]/g, "")}`,
      `类型：${input.kind}。编排：${COMPILER_VERSION}。原始结果：${candidate.answer.status}。`,
      "页面审核不等于自动证明语义正确；条件、推断与原文分别保留。",
      ...(input.confirmedDecision
        ? ["## 用户明确决定", literal(input.confirmedDecision)]
        : []),
      ...claims.flatMap((c, i) => [
        `## 主张 ${i + 1}（${c.kind === "sourced" ? "原文" : c.kind === "inferred" ? "推断，待核对" : "用户陈述"}）`,
        literal(c.text),
        "适用条件：",
        literal(JSON.stringify(c.scope, null, 2)),
        `证据：${c.evidenceIds.join(", ") || "无来源证据"}`,
      ]),
      "## 不足与冲突",
      literal(
        [
          ...candidate.answer.gaps,
          ...deferred,
          ...candidate.answer.relations.map(
            (r) => `${r.from} ${r.type} ${r.to}`,
          ),
        ].join("\n") || "未登记；不代表已经排除全部分歧。",
      ),
    ].join("\n\n") + "\n";
  if (Buffer.byteLength(content) > 128000)
    throw new AppError("LIMIT", 409, "页面超出 128 KB，请拆分候选。");
  return {
    content,
    claims,
    deferred,
    evidenceIds: [...new Set(claims.flatMap((c) => c.evidenceIds))],
  };
}
