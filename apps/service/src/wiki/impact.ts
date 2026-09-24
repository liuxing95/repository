import type { Principal, WikiPage } from "@kb/contracts";
import { Proposals } from "../review/proposals";
import { AppError } from "../errors";
import { hashBytes } from "../ingestion/objects";
import { digest } from "../workspace/registry";
import { tokenize } from "../search/tokenizer";
export function readPage(
  proposals: Proposals,
  revisionId: string,
  p: Principal,
) {
  proposals.evidence.checkPrincipal(p);
  const row = proposals.store.db
    .prepare("SELECT value,change_id FROM wiki_revisions WHERE id=?")
    .get(revisionId) as { value: string; change_id: string } | undefined;
  if (!row) throw new AppError("NOT_FOUND", 404);
  const page = JSON.parse(row.value) as WikiPage;
  const change = proposals.raw(row.change_id);
  const patch = change.patches.find((p) => p.revisionId === revisionId);
  if (
    !patch ||
    hashBytes(page.content) !== page.hash ||
    page.hash !== patch.afterHash ||
    digest(page.evidenceIds) !== digest(patch.evidenceIds) ||
    digest(page.claims) !== digest(patch.claims)
  )
    throw new AppError("HASH_MISMATCH");
  for (const id of page.evidenceIds) {
    const current = proposals.evidence.read(id);
    const original = change.evidence.find((e) => e.id === id);
    if (!original || digest(current) !== digest(original))
      throw new AppError("BASELINE");
  }
  const observation = proposals.observation(page.pageId);
  return {
    ...page,
    review:
      observation && observation.hash !== page.hash
        ? ("needs-review" as const)
        : page.review,
  };
}
export function searchPages(proposals: Proposals, query: string, p: Principal) {
  proposals.evidence.checkPrincipal(p);
  const t = tokenize(query, true);
  const strong = t.terms.some((v) => v.startsWith("b"))
    ? t.terms.filter((v) => !v.startsWith("h"))
    : t.terms;
  const expression = [...strong, ...t.symbols]
    .slice(0, 128)
    .map((v) => `"${v}"`)
    .join(" OR ");
  if (!expression) return [];
  const rows = proposals.store.db
    .prepare(
      "SELECT f.revision_id FROM wiki_fts f JOIN wiki_pages p ON p.revision_id=f.revision_id WHERE wiki_fts MATCH ? ORDER BY bm25(wiki_fts)",
    )
    .all(expression) as { revision_id: string }[];
  const result: WikiPage[] = [];
  for (const row of rows) {
    try {
      result.push(readPage(proposals, row.revision_id, p));
      if (result.length === 20) break;
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
    }
  }
  return result;
}
export function impact(proposals: Proposals, p: Principal, offset = 0) {
  proposals.evidence.checkPrincipal(p);
  const pages = proposals.store.db
    .prepare(
      "SELECT id,revision_id FROM wiki_pages ORDER BY id LIMIT 101 OFFSET ?",
    )
    .all(offset) as { id: string; revision_id: string }[];
  const items = [];
  for (const page of pages.slice(0, 100)) {
    try {
      const current = readPage(proposals, page.revision_id, p);
      const reasons: string[] = [];
      if (current.review === "needs-review") reasons.push("manual-change");
      if (!current.evidenceIds.length) reasons.push("unsourced");
      for (const id of current.evidenceIds) {
        const e = proposals.evidence.read(id);
        if (
          proposals.store.db
            .prepare(
              "SELECT id FROM source_revisions WHERE source_id=? AND committed=1 AND id!=? AND rowid>(SELECT rowid FROM source_revisions WHERE id=?) LIMIT 1",
            )
            .get(e.sourceId, e.revisionId, e.revisionId)
        )
          reasons.push("new-source-revision-check-scope");
      }
      if (reasons.length)
        items.push({
          pageId: page.id,
          revisionId: page.revision_id,
          reasons: [...new Set(reasons)],
          evidenceIds: current.evidenceIds,
          observationId: proposals.observation(page.id)?.id ?? null,
        });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      items.push({
        pageId: page.id,
        revisionId: page.revision_id,
        reasons: ["source-unavailable"],
        evidenceIds: [],
        observationId: null,
      });
    }
  }
  return {
    items,
    nextOffset: pages.length > 100 ? offset + 100 : null,
    truncated: pages.length > 100,
    scope: "直接证据与页面；更远关系需人工复审，不递归重写。",
  };
}
