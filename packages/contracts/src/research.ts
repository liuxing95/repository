import { z } from "zod";
import { Id } from "./workspace";
import { Claim, Scope, type EvidenceRead } from "./evidence";

export const ResearchQuestion = z
  .object({
    id: Id,
    question: z.string().trim().min(1).max(500),
    query: z.string().trim().min(1).max(500),
    counterQuery: z.string().trim().min(1).max(500),
    scope: Scope,
    requiredTypes: z.array(z.string().trim().min(1).max(100)).min(1).max(8),
  })
  .strict();
export type ResearchQuestion = z.infer<typeof ResearchQuestion>;
export const ResearchBrief = z
  .object({
    topic: z.string().trim().min(1).max(200),
    audience: z.string().trim().min(1).max(200),
    outputType: z.enum(["overview", "comparison", "project"]),
    questions: z.array(ResearchQuestion).min(1).max(10),
    scopes: z.array(Scope).min(1).max(10),
    timeIntent: z.enum(["version", "current", "evolution", "historical"]),
    cutoff: z.string().datetime().nullable().default(null),
    mode: z.enum(["library_only", "fill_gaps"]),
    acquisitionScope: z
      .object({
        hosts: z.array(z.string().min(1).max(253)).max(10),
        paths: z.array(z.string().startsWith("/").max(1024)).min(1).max(10),
      })
      .strict()
      .default({ hosts: [], paths: ["/"] }),
    projectEvidenceIds: z.array(z.string().length(64)).max(10).default([]),
    limits: z
      .object({
        cost: z.number().int().nonnegative().max(1_000_000_000),
        calls: z.number().int().min(0).max(30),
        discoveries: z.number().int().min(0).max(3),
        materials: z.number().int().min(1).max(30),
        chapters: z.number().int().min(1).max(10),
      })
      .strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.timeIntent === "historical" && !v.cutoff)
      ctx.addIssue({
        code: "custom",
        path: ["cutoff"],
        message: "历史时点必须明确截止时间",
      });
    if (new Set(v.questions.map((q) => q.id)).size !== v.questions.length)
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: "问题编号不能重复",
      });
    if (v.questions.length > v.limits.chapters)
      ctx.addIssue({
        code: "custom",
        path: ["limits", "chapters"],
        message: "章节上限不足以覆盖必答问题",
      });
    if (v.timeIntent === "version" && v.scopes.some((s) => !s.version))
      ctx.addIssue({
        code: "custom",
        path: ["scopes"],
        message: "指定版本研究需要版本范围",
      });
    if (
      v.outputType === "project" &&
      (!v.projectEvidenceIds.length || v.scopes.some((s) => !s.version))
    )
      ctx.addIssue({
        code: "custom",
        path: ["projectEvidenceIds"],
        message: "具体项目需要版本及已收录的锁文件或配置依据",
      });
  });
export type ResearchBrief = z.infer<typeof ResearchBrief>;
export type ResearchRole =
  "eligible" | "later-explanation" | "publication-unknown";
export type ResearchSnapshot = {
  id: string;
  researchId: string;
  previousId: string | null;
  createdAt: number;
  generation: string;
  digest: string;
  evidence: EvidenceRead[];
  questions: {
    questionId: string;
    evidenceIds: string[];
    counterIds: string[];
    warnings: string[];
  }[];
  affectedQuestions: string[];
  added: string[];
  removed: string[];
};
export type ResearchCoverage = {
  questionId: string;
  state: "unsearched" | "partial" | "supported" | "conflict" | "unanswerable";
  evidence: { id: string; role: ResearchRole; counterLead: boolean }[];
  gaps: string[];
  familyCount: number;
  reviewNote: string | null;
};
export const ChapterOutput = z
  .object({
    claims: z.array(Claim).max(8),
    unresolved: z.array(z.string().min(1).max(1000)).max(20),
  })
  .strict();
export type ResearchChapter = z.infer<typeof ChapterOutput> & {
  id: string;
  researchId: string;
  questionId: string;
  snapshotId: string;
  mode: "extractive" | "model";
  model: string;
  createdAt: number;
};
export type Research = {
  id: string;
  brief: ResearchBrief;
  digest: string;
  rootId: string;
  snapshotId: string | null;
  state: "active" | "cancelled";
  createdAt: number;
  calls: number;
  discoveries: number;
  materialReservations: number;
  materialIds: string[];
};
export type ResearchReport = {
  id: string;
  researchId: string;
  snapshotId: string;
  version: number;
  createdAt: number;
  content: string;
  digest: string;
  chapters: ResearchChapter[];
  evidence: EvidenceRead[];
  coverage: ResearchCoverage[];
  checks: {
    mechanical: "passed";
    semantic: "not-reviewed";
    warnings: string[];
  };
  usage: { calls: number; actual: number; reserved: number; rootId: string };
};
