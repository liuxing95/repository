import { randomUUID } from "node:crypto";
import type { Principal, ResearchReport, AnswerResult } from "@kb/contracts";
import { ResearchStore } from "./brief";
import { checkReport } from "./report-check";
import { digest } from "../workspace/registry";
import { literal } from "../wiki/bounded-compiler";
import { AppError } from "../errors";
export function reportDigest(report: ResearchReport) {
  return digest({ ...report, digest: undefined });
}
export class Artifacts {
  constructor(readonly db: ResearchStore) {}
  get(id: string, p: Principal): ResearchReport {
    this.db.evidence.checkPrincipal(p);
    const row = this.db.store.db
      .prepare("SELECT value FROM research_reports WHERE id=?")
      .get(id) as { value: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    const report = JSON.parse(row.value) as ResearchReport;
    if (reportDigest(report) !== report.digest)
      throw new AppError("HASH_MISMATCH");
    for (const e of report.evidence)
      if (digest(e) !== digest(this.db.evidence.read(e.id)))
        throw new AppError("BASELINE");
    return report;
  }
  freeze(id: string, p: Principal) {
    this.db.proposals.write(p);
    const { r, s, chapters, coverage, checks } = checkReport(this.db, id, p);
    const usage = this.db.usage(this.db.get(id, p));
    const fingerprint = digest({
      snapshot: s.id,
      chapters,
      coverage,
      usage,
      checks,
    });
    const old = this.db.store.db
      .prepare(
        "SELECT id FROM research_reports WHERE research_id=? AND fingerprint=?",
      )
      .get(id, fingerprint) as { id: string } | undefined;
    if (old) return this.get(old.id, p);
    const version =
      (
        this.db.store.db
          .prepare(
            "SELECT count(*) n FROM research_reports WHERE research_id=?",
          )
          .get(id) as { n: number }
      ).n + 1;
    const content =
      [
        "# 研究候选报告",
        literal(r.brief.topic),
        `报告版本：${version}；最终快照：${s.id}；模式：${r.brief.timeIntent}；语义审阅：尚未完成。`,
        "## 研究范围",
        literal(
          JSON.stringify(
            {
              audience: r.brief.audience,
              outputType: r.brief.outputType,
              scopes: r.brief.scopes,
              cutoff: r.brief.cutoff,
            },
            null,
            2,
          ),
        ),
        ...r.brief.questions.flatMap((q) => {
          const chapter = chapters.find((c) => c.questionId === q.id),
            row = coverage.find((c) => c.questionId === q.id)!;
          return [
            "## 研究问题",
            literal(q.question),
            `覆盖：${row.state}；独立来源家族：${row.familyCount}。`,
            ...(chapter
              ? chapter.claims.flatMap((c) => [
                  "### 原文陈述（须结合条件阅读）",
                  literal(c.text),
                  literal(JSON.stringify(c.scope)),
                  `固定证据：${c.evidenceIds.join(", ")}`,
                ])
              : ["本章尚未生成；保留为未完成问题。"]),
            "### 未解决项",
            literal(
              [...row.gaps, ...(chapter?.unresolved ?? [])].join("\n") ||
                "仍需人工核对语义与反证",
            ),
          ];
        }),
        "## 来源及版本清单",
        ...s.evidence.flatMap((e) => [
          literal(
            `${e.title}\n${e.original}\n修订 ${e.revisionId}；解析 ${e.parseId}；证据 ${e.id}\n确认公开时间：${e.confirmedPublishedAt ?? "未知"}\n范围：${JSON.stringify(e.profile.scope)}`,
          ),
        ]),
        "## 问题覆盖与历史证据资格",
        literal(JSON.stringify(coverage, null, 2)),
        "## 全文检查与待核验项",
        literal(checks.warnings.join("\n")),
        "## 费用摘要（微美元）",
        literal(JSON.stringify(usage, null, 2)),
      ].join("\n\n") + "\n";
    if (Buffer.byteLength(content) > 128000)
      throw new AppError(
        "LIMIT",
        409,
        "报告超过 128 KB，请减少问题或拆分研究；不会静默截断报告。",
      );
    const report: ResearchReport = {
      id: randomUUID(),
      researchId: id,
      snapshotId: s.id,
      version,
      createdAt: Date.now(),
      content,
      digest: "",
      chapters,
      evidence: s.evidence,
      coverage,
      checks,
      usage,
    };
    report.digest = reportDigest(report);
    this.db.store.db
      .prepare("INSERT INTO research_reports VALUES(?,?,?,?)")
      .run(report.id, id, fingerprint, JSON.stringify(report));
    this.db.store.event("research.report.frozen", id);
    return report;
  }
  candidate(id: string, p: Principal) {
    this.db.proposals.write(p);
    const report = this.get(id, p),
      r = this.db.get(report.researchId, p);
    const answer: AnswerResult = {
      id: report.id,
      snapshotId: report.snapshotId,
      status: report.coverage.some((c) => c.state === "conflict")
        ? "conflict"
        : "insufficient",
      mode: "extractive",
      semanticReview: "not-reviewed",
      claims: report.chapters.flatMap((c) => c.claims),
      relations: [],
      gaps: report.checks.warnings,
      evidence: report.evidence,
      familyCount: new Set(report.evidence.map((e) => e.familyId)).size,
      model: "research-report-v1",
      promptVersion: "research-report-v1",
    };
    const candidate = {
      id: report.id,
      answer,
      createdBy: p.id,
      state: "awaiting_scene04_review",
      report: {
        id: report.id,
        digest: report.digest,
        content: report.content,
        title: r.brief.topic,
      },
    };
    this.db.store.db
      .prepare("INSERT OR IGNORE INTO answer_candidates VALUES(?,?)")
      .run(candidate.id, JSON.stringify(candidate));
    this.db.store.event("research.candidate.saved", id);
    return this.db.proposals.candidates.get(candidate.id, p);
  }
}
