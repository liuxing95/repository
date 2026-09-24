import { queryCoverage } from "../search/tokenizer";
import { matchScope } from "../evidence/scope";
import type { EvidenceRead, SearchResult } from "@kb/contracts";
import type { EvidenceStore } from "../evidence/locator";
export const PROMPT_VERSION = "fixed-evidence-quotes-v1";
export function evidencePack(
  result: SearchResult,
  store: EvidenceStore,
  maxChars = 16000,
) {
  const evidence: EvidenceRead[] = [];
  const gaps = [...result.warnings];
  let size = 0;
  for (const hit of result.hits) {
    const originals = ["summary", "wiki", "answer"].includes(hit.profile.kind)
      ? hit.profile.originalEvidence.map((id) => store.read(id))
      : [store.read(hit.id)];
    if (!originals.length)
      gaps.push("派生内容没有固定原始证据，不能用于支持事实。");
    for (const item of originals) {
      if (evidence.some((e) => e.id === item.id)) continue;
      const input = result.snapshot.input;
      if (
        (input.collection && item.profile.collection !== input.collection) ||
        (input.review && item.profile.review !== input.review) ||
        (input.asOf &&
          (!item.confirmedPublishedAt ||
            Date.parse(item.confirmedPublishedAt) > Date.parse(input.asOf)))
      ) {
        gaps.push("追溯到的原始证据不满足本次集合、审核或历史时点条件。");
        continue;
      }
      if (
        matchScope(result.snapshot.input.scope, item.profile.scope) !==
        "overlap"
      ) {
        gaps.push(
          "原始证据适用范围不匹配或仍未知，不能作为当前条件下的事实依据。",
        );
        continue;
      }
      if (
        !store.store.db
          .prepare(
            "SELECT 1 FROM search_documents WHERE generation=? AND evidence_id=?",
          )
          .get(result.snapshot.generation, item.id)
      ) {
        gaps.push("原始证据不属于当前索引快照，请重新搜索。");
        continue;
      }
      if (
        queryCoverage(
          result.snapshot.input.query,
          item.text + " " + item.title,
        ) < 0.35
      ) {
        gaps.push(
          "命中只覆盖问题中的少量词语，无法确认能够回答问题；请缩小问题或人工核对。",
        );
        continue;
      }
      const bytes = JSON.stringify(item).length;
      if (size + bytes > maxChars || item.text.length > 4000) {
        gaps.push("完整证据超出上下文上限，请缩小范围；没有截断原文条件。");
        continue;
      }
      evidence.push(item);
      size += bytes;
      gaps.push(...item.gaps);
    }
  }
  if (!evidence.length)
    gaps.push("没有足够的可用原文；不能据此断言资料中不存在答案。");
  return {
    question: result.snapshot.input.query,
    scope: result.snapshot.input.scope,
    snapshotId: result.snapshot.id,
    evidence,
    gaps: [...new Set(gaps)],
    promptVersion: PROMPT_VERSION,
  };
}
export type EvidencePack = ReturnType<typeof evidencePack>;
