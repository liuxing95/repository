import type { Principal, ResearchChapter } from "@kb/contracts";
import { ResearchStore } from "./brief";
import { Snapshots } from "./snapshots";
import { Chapters, chapterPack, checkChapter } from "./chapters";
import { coverage } from "./coverage";
import { digest } from "../workspace/registry";
export function checkReport(db: ResearchStore, id: string, p: Principal) {
  const r = db.get(id, p),
    snapshots = new Snapshots(db),
    s = snapshots.current(r, p),
    service = new Chapters(db);
  const chapters: ResearchChapter[] = [],
    warnings: string[] = [];
  const coverageTable = r.brief.questions.map((q) =>
    coverage(db, r.brief, s, q),
  );
  for (const q of r.brief.questions) {
    let c = service.get(s, q.id);
    if (!c && s.previousId && !s.affectedQuestions.includes(q.id)) {
      const old = snapshots.get(s.previousId, id, p, false);
      const prior = service.get(old, q.id);
      if (prior) {
        checkChapter(
          { claims: prior.claims, unresolved: prior.unresolved },
          chapterPack(r.brief, s, q),
        );
        c = { ...prior, snapshotId: s.id };
      }
    }
    if (!c) {
      warnings.push(`未完成章节：${q.question}`);
      continue;
    }
    checkChapter(
      { claims: c.claims, unresolved: c.unresolved },
      chapterPack(r.brief, s, q),
    );
    chapters.push(c);
    warnings.push(...c.unresolved.map((g) => `${q.question}：${g}`));
  }
  for (const row of coverageTable)
    if (row.state !== "supported")
      warnings.push(`问题 ${row.questionId}：${row.state}，尚无充分支持结论`);
  const byScope = new Map<string, Set<string>>();
  for (const c of chapters.flatMap((c) => c.claims)) {
    const key = digest(c.scope),
      texts = byScope.get(key) ?? new Set<string>();
    texts.add(c.text);
    byScope.set(key, texts);
  }
  if ([...byScope.values()].some((texts) => texts.size > 1))
    warnings.push(
      "同一适用范围存在多条陈述，需人工核对跨章节关系；机械检查不能自动排除矛盾。",
    );
  warnings.push(
    "没有运行项目实验；原文中的实验与性能表述仅是来源陈述。语义审阅尚未完成。",
  );
  return {
    r,
    s,
    chapters,
    coverage: coverageTable,
    checks: {
      mechanical: "passed" as const,
      semantic: "not-reviewed" as const,
      warnings: [...new Set(warnings)],
    },
  };
}
