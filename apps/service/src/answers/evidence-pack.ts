import { queryAspects, queryCoverage } from "../search/tokenizer";
import { matchScope } from "../evidence/scope";
import type { Claim, EvidenceRead, SearchResult } from "@kb/contracts";
import type { EvidenceStore } from "../evidence/locator";
export const PROMPT_VERSION = "bounded-multi-evidence-v3";
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
            "SELECT 1 FROM search_documents WHERE generation=? AND parse_id=? AND source_id=? LIMIT 1",
          )
          .get(result.snapshot.generation, item.parseId, item.sourceId)
      ) {
        gaps.push("原始证据不属于当前索引快照，请重新搜索。");
        continue;
      }
      const searchable = item.text + " " + item.title;
      const aspectRelevant = queryAspects(result.snapshot.input.query).some(
        (aspect) =>
          queryCoverage(aspect, searchable) >= 0.8 ||
          queryCoverage(aspect, item.locator.heading?.at(-1) ?? "") >= 0.35,
      );
      if (queryCoverage(result.snapshot.input.query, searchable) < 0.35 && !aspectRelevant) {
        gaps.push(
          "命中只覆盖问题中的少量词语，无法确认能够回答问题；请缩小问题或人工核对。",
        );
        continue;
      }
      // The model receives these five fields; `context`, hashes and transport
      // metadata stay in the returned evidence, not in the prompt budget.
      const promptChars = JSON.stringify({
        id: item.id, heading: item.locator.heading ?? [], text: item.text,
        scope: item.profile.scope, title: item.title,
      }).length;
      if (size + promptChars > maxChars || item.text.length > 4000) {
        gaps.push("完整证据超出上下文上限，请缩小范围；没有截断原文条件。");
        continue;
      }
      evidence.push(item);
      size += promptChars;
      gaps.push(...item.gaps);
    }
  }
  if (!evidence.length)
    gaps.push("没有足够的可用原文；不能据此断言资料中不存在答案。");
  const combinedCoverage = queryCoverage(
    result.snapshot.input.query,
    evidence.map((item) => item.text + " " + item.title).join(" "),
  );
  const aspects = queryAspects(result.snapshot.input.query);
  const coveredAspects = aspects.filter((aspect) => evidence.some((item) =>
    queryCoverage(aspect, item.text + " " + (item.locator.heading?.at(-1) ?? "")) >= 0.35,
  )).length;
  const answerable = evidence.length > 0 &&
    (combinedCoverage >= 0.6 || (aspects.length > 1 && coveredAspects === aspects.length));
  if (evidence.length && !answerable)
    gaps.push("现有证据仅覆盖问题的部分要点；请补充检索或人工核对后再下结论。");
  return {
    question: result.snapshot.input.query,
    scope: result.snapshot.input.scope,
    snapshotId: result.snapshot.id,
    evidence,
    answerable,
    gaps: [...new Set(gaps)],
    promptVersion: PROMPT_VERSION,
  };
}
export type EvidencePack = ReturnType<typeof evidencePack>;

// Small local models lose the answer when a long-document search contributes
// many weakly related passages. Preserve the full extractive view, but send a
// focused, auditable subset to the model.
export function focusedModelPack(pack: EvidencePack): EvidencePack {
  const asksForLocation = /在哪|哪里|哪节|哪些章节|哪些部分/.test(pack.question);
  const aspects = queryAspects(pack.question);
  const selected: EvidenceRead[] = [];
  if (asksForLocation && aspects.length) {
    const missing = new Set(aspects);
    for (const item of pack.evidence) {
      const heading = item.locator.heading?.at(-1) ?? "";
      const covered = [...missing].filter((aspect) =>
        heading.includes(aspect) || queryCoverage(aspect, heading) >= 0.35,
      );
      if (!covered.length) continue;
      selected.push(item);
      for (const aspect of covered) missing.delete(aspect);
      if (!missing.size || selected.length >= 4) break;
    }
  }
  for (const item of pack.evidence) {
    if (selected.length >= (asksForLocation ? 4 : 5)) break;
    if (!selected.some((existing) => existing.id === item.id)) selected.push(item);
    if (asksForLocation && selected.length >= 2) break;
  }
  const covered = aspects.every((aspect) => selected.some((item) =>
    queryCoverage(aspect, item.text + " " + (item.locator.heading?.at(-1) ?? "")) >= 0.35,
  ));
  const answerable = pack.answerable && (asksForLocation
    ? covered
    : covered || queryCoverage(
      pack.question, selected.map((item) => item.text + " " + (item.locator.heading?.at(-1) ?? "")).join(" "),
    ) >= 0.6);
  return {
    ...pack,
    evidence: selected,
    answerable,
    gaps: [
      ...pack.gaps,
      ...(selected.length < pack.evidence.length
        ? ["本机模型只接收优先覆盖问题要点的证据；其余命中仍可在原文整理中核对。"]
        : []),
      ...(!answerable && pack.answerable
        ? ["模型所见证据仍缺少部分问题要点；请回到原文整理核对。"]
        : []),
    ],
  };
}

export function modelLocationSupported(
  question: string,
  claims: readonly Claim[],
  evidence: readonly EvidenceRead[],
) {
  if (!/在哪|哪里|哪节|哪些章节|哪些部分/.test(question)) return true;
  const chapters = (text: string) => text.match(/\b(?:\d+(?:\.\d+)+|[A-Z]\.\d+)\b/g) ?? [];
  return claims.length > 0 && claims.every((claim) => {
    const cited = claim.evidenceIds.flatMap((id) => {
      const item = evidence.find((entry) => entry.id === id);
      return chapters(item?.locator.heading?.at(-1) ?? "");
    });
    if (!cited.length) return true;
    const mentioned = chapters(claim.text);
    return mentioned.length > 0 && mentioned.every((chapter) => cited.includes(chapter));
  });
}
