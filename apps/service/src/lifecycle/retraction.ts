import { AppError } from "../errors";
import { Policy } from "../security/policy";
import type { WorkspaceRegistry } from "../workspace/registry";

const emptyRoutes = {
  read: [],
  fetch: [],
  model: [],
  ocr: [],
  embedding: [],
  rerank: [],
  notification: [],
  calendar: [],
  publish: [],
};

export class Retraction {
  constructor(readonly registry: WorkspaceRegistry) {}
  retract(sourceId: string, actorId: string, reason: string) {
    if (!reason.trim() || reason.length > 500)
      throw new AppError("VALIDATION", 400, "请填写撤回原因。");
    this.requireSource(sourceId);
    new Policy(this.registry).setSource(
      { sourceId, retracted: true, routes: emptyRoutes },
      actorId,
      reason,
    );
    return this.impact(sourceId);
  }
  impact(sourceId: string) {
    this.requireSource(sourceId);
    const store = this.registry.store;
    const record = store.get(`retraction:${sourceId}`) ?? null;
    const count = (sql: string, ...args: unknown[]) =>
      (store.db.prepare(sql).get(...args) as { n: number }).n;
    return {
      sourceId,
      record,
      evidence: count(
        "SELECT COUNT(*) n FROM evidence WHERE json_extract(value,'$.sourceId')=?",
        sourceId,
      ),
      wikiPages: count(
        "SELECT COUNT(DISTINCT r.page_id) n FROM wiki_revisions r JOIN wiki_edges w ON w.revision_id=r.id JOIN evidence e ON e.id=w.evidence_id WHERE json_extract(e.value,'$.sourceId')=?",
        sourceId,
      ),
      researchReportsToReview: count(
        "SELECT COUNT(*) n FROM research_reports WHERE instr(value,?)>0",
        sourceId,
      ),
      learningAttemptsToReview: count(
        "SELECT COUNT(*) n FROM learning_attempts WHERE instr(value,?)>0",
        sourceId,
      ),
      cachedAnswersToReview: count(
        "SELECT COUNT(*) n FROM answer_cache WHERE instr(value,?)>0",
        sourceId,
      ),
      external:
        "已发出的提供方内容与副本无法撤回；当前没有远端提醒 relay，未执行外部取消。",
    };
  }
  private requireSource(sourceId: string) {
    if (
      !this.registry.store.db
        .prepare("SELECT 1 FROM sources WHERE id=?")
        .get(sourceId)
    )
      throw new AppError("NOT_FOUND", 404);
  }
}
