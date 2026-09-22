import type { AnswerResult, Principal, ResearchReport } from "@kb/contracts";
import { EvidenceStore } from "../evidence/locator";
import { AppError } from "../errors";
import { digest } from "../workspace/registry";
export type SavedCandidate = {
  id: string;
  answer: AnswerResult;
  createdBy: string;
  state: string;
  report?: { id: string; digest: string; content: string; title: string };
};
export class Candidates {
  constructor(readonly evidence: EvidenceStore) {}
  get(id: string, p: Principal) {
    this.evidence.checkPrincipal(p);
    const row = this.evidence.store.db
      .prepare("SELECT value FROM answer_candidates WHERE id=?")
      .get(id) as { value: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    const candidate = JSON.parse(row.value) as SavedCandidate;
    if (candidate.report) {
      const row = this.evidence.store.db
        .prepare("SELECT value FROM research_reports WHERE id=?")
        .get(candidate.report.id) as { value: string } | undefined;
      if (!row) throw new AppError("BASELINE");
      const report = JSON.parse(row.value) as ResearchReport;
      const { digest: storedDigest, ...body } = report;
      if (
        digest(body) !== storedDigest ||
        candidate.report.digest !== storedDigest ||
        candidate.report.content !== report.content ||
        candidate.id !== report.id ||
        candidate.answer.snapshotId !== report.snapshotId ||
        digest(candidate.answer.evidence) !== digest(report.evidence) ||
        digest(candidate.answer.claims) !==
          digest(report.chapters.flatMap((c) => c.claims))
      )
        throw new AppError("HASH_MISMATCH");
    }
    for (const original of candidate.answer.evidence) {
      const current = this.evidence.read(original.id);
      if (digest(current) !== digest(original))
        throw new AppError(
          "BASELINE",
          409,
          "候选依据已变化，请重新检索并保存候选。",
        );
    }
    return candidate;
  }
  list(p: Principal) {
    this.evidence.checkPrincipal(p);
    return (
      this.evidence.store.db
        .prepare(
          "SELECT id FROM answer_candidates ORDER BY rowid DESC LIMIT 100",
        )
        .all() as { id: string }[]
    ).flatMap(({ id }) => {
      try {
        const c = this.get(id, p);
        return [
          {
            id,
            title:
              c.report?.title ??
              c.answer.claims[0]?.text.slice(0, 80) ??
              "证据不足",
            status: c.answer.status,
          },
        ];
      } catch (e) {
        if (e instanceof AppError) return [];
        throw e;
      }
    });
  }
}
