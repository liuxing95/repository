import { z } from "zod";
import type {
  ResearchBrief,
  ResearchQuestion,
  ResearchSnapshot,
  ResearchCoverage,
  EvidenceRead,
  ResearchRole,
  Principal,
} from "@kb/contracts";
import { matchScope } from "../evidence/scope";
import { AppError } from "../errors";
import type { ResearchStore } from "./brief";
export function evidenceRole(
  brief: ResearchBrief,
  e: EvidenceRead,
): ResearchRole {
  if (brief.timeIntent !== "historical") return "eligible";
  if (!e.confirmedPublishedAt || !e.profile.publicationEvidence)
    return "publication-unknown";
  return Date.parse(e.confirmedPublishedAt) <= Date.parse(brief.cutoff!)
    ? "eligible"
    : "later-explanation";
}
export const Assessment = z
  .object({
    state: z.enum(["supported", "partial", "conflict", "unanswerable"]),
    supportingIds: z.array(z.string().length(64)).max(8),
    opposingIds: z.array(z.string().length(64)).max(8),
    counterChecked: z.boolean(),
    note: z.string().trim().min(1).max(2000),
  })
  .strict();
export function coverage(
  db: ResearchStore,
  brief: ResearchBrief,
  snapshot: ResearchSnapshot,
  q: ResearchQuestion,
): ResearchCoverage {
  const found = snapshot.questions.find((x) => x.questionId === q.id);
  if (!found)
    return {
      questionId: q.id,
      state: "unsearched",
      evidence: [],
      gaps: ["尚未检索"],
      familyCount: 0,
      reviewNote: null,
    };
  const refs = found.evidenceIds.map((id) =>
    snapshot.evidence.find((e) => e.id === id)!,
  );
  const eligible = refs.filter((e) => evidenceRole(brief, e) === "eligible");
  const gaps = [...found.warnings];
  for (const t of q.requiredTypes)
    if (!eligible.some((e) => e.profile.scope.sourceType === t))
      gaps.push(`缺少必要证据类型：${t}`);
  if (!eligible.length) gaps.push("没有可用于本题结论的原文");
  if (
    eligible.some(
      (e) =>
        matchScope(q.scope, e.profile.scope) === "unknown" ||
        !brief.scopes.some((s) => matchScope(s, e.profile.scope) === "overlap"),
    )
  )
    gaps.push("部分原文适用条件仍未知");
  const row = db.store.db
    .prepare(
      "SELECT value FROM research_assessments WHERE snapshot_id=? AND question_id=?",
    )
    .get(snapshot.id, q.id) as { value: string } | undefined;
  const review = row ? Assessment.parse(JSON.parse(row.value)) : null;
  if (!review) gaps.push("尚未人工核对问题覆盖与反证；命中数不代表已回答");
  return {
    questionId: q.id,
    state: review?.state ?? (eligible.length ? "partial" : "unanswerable"),
    evidence: refs.map((e) => ({
      id: e.id,
      role: evidenceRole(brief, e),
      counterLead: found.counterIds.includes(e.id),
    })),
    gaps,
    familyCount: new Set(eligible.map((e) => e.familyId)).size,
    reviewNote: review?.note ?? null,
  };
}
export function assess(
  db: ResearchStore,
  brief: ResearchBrief,
  snapshot: ResearchSnapshot,
  q: ResearchQuestion,
  value: unknown,
  p: Principal,
) {
  db.proposals.write(p);
  const a = Assessment.parse(value),
    found = snapshot.questions.find((x) => x.questionId === q.id)!;
  const refs = [...a.supportingIds, ...a.opposingIds].map((id) => {
    const e = snapshot.evidence.find((e) => e.id === id);
    if (
      !e ||
      !found.evidenceIds.includes(id) ||
      evidenceRole(brief, e) !== "eligible"
    )
      throw new AppError("INVALID_CITATION");
    return e;
  });
  if (
    a.state === "supported" &&
    (!a.supportingIds.length ||
      !a.counterChecked ||
      refs.some(
        (e) =>
          matchScope(q.scope, e.profile.scope) !== "overlap" ||
          !brief.scopes.some(
            (s) => matchScope(s, e.profile.scope) === "overlap",
          ),
      ) ||
      q.requiredTypes.some(
        (t) => !refs.some((e) => e.profile.scope.sourceType === t),
      ))
  )
    throw new AppError("INSUFFICIENT_EVIDENCE");
  if (a.state === "supported" && a.opposingIds.length)
    throw new AppError("CONFLICT");
  if (
    a.state === "conflict" &&
    (!a.supportingIds.length || !a.opposingIds.length)
  )
    throw new AppError("INVALID_CITATION");
  db.store.db
    .prepare(
      "INSERT INTO research_assessments VALUES(?,?,?) ON CONFLICT(snapshot_id,question_id) DO UPDATE SET value=excluded.value",
    )
    .run(snapshot.id, q.id, JSON.stringify(a));
  db.store.event("research.coverage.reviewed", snapshot.researchId);
  return coverage(db, brief, snapshot, q);
}
