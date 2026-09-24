import { type LearningBaseline } from "@kb/contracts";
import { LearningStore } from "./goals";
import { AppError } from "../errors";
import { digest } from "../workspace/registry";
export function sourceImpact(
  db: LearningStore,
  b: LearningBaseline,
  unitId: string,
) {
  const u = db.unit(b, unitId);
  return [...new Set([...u.necessary, ...u.optional])].map((id) => {
    try {
      const e = db.evidence.read(id);
      const latest = db.store.db
        .prepare(
          "SELECT id FROM source_revisions WHERE source_id=? AND committed=1 ORDER BY rowid DESC LIMIT 1",
        )
        .get(e.sourceId) as { id: string } | undefined;
      const row =
        latest &&
        (db.store.db
          .prepare(
            "SELECT id FROM parse_artifacts WHERE revision_id=? AND committed=1 ORDER BY rowid DESC LIMIT 1",
          )
          .get(latest.id) as { id: string } | undefined);
      const parse = row ? db.evidence.commits.parse(row.id) : null;
      const targetVersion = b.input.scope.version;
      const changed =
        !!parse &&
        digest(parse.text) !==
          digest(db.evidence.commits.parse(e.parseId).text);
      const relevant =
        changed &&
        !!targetVersion &&
        targetVersion !== e.profile.scope.version &&
        db.evidence.profile(parse!.id).scope.version === targetVersion;
      return {
        id,
        restricted: false as const,
        necessary: u.necessary.includes(id),
        evidence: e,
        newerRevisionId: latest?.id !== e.revisionId ? latest?.id : null,
        changed,
        supplementCandidate: relevant,
        message: relevant
          ? "目标版本已有不同原文，请人工核对是否需要补学。"
          : changed
            ? "资料有新修订；旧尝试仍属于原版本。"
            : "",
      };
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      return {
        id,
        restricted: true as const,
        necessary: u.necessary.includes(id),
        message: "资料不可读；保留关联，暂不展示正文。",
      };
    }
  });
}
