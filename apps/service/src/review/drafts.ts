import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DraftContent,
  DraftEdit,
  type WritingDraft,
  type Principal,
} from "@kb/contracts";
import type { AnswerService } from "../answers/answer";
import { Candidates, type SavedCandidate } from "./candidates";
import { authorize } from "../http/auth";
import { AppError } from "../errors";
import { digest } from "../workspace/registry";

export class WritingDrafts {
  constructor(readonly answers: AnswerService) {}
  get store() {
    return this.answers.search.store;
  }
  get evidence() {
    return this.answers.search.evidence;
  }
  private write(p: Principal) {
    this.evidence.checkPrincipal(p);
    authorize(
      this.evidence.registry,
      p,
      ["admin", "user"],
      p.policyVersion,
      true,
    );
  }
  get(id: string, p: Principal): WritingDraft {
    this.evidence.checkPrincipal(p);
    const d = this.store.get(`writing-draft:${id}`) as WritingDraft | undefined;
    if (!d) throw new AppError("NOT_FOUND", 404);
    for (const e of d.answer.evidence)
      if (digest(this.evidence.read(e.id)) !== digest(e))
        throw new AppError("BASELINE");
    return d;
  }
  list(p: Principal) {
    this.evidence.checkPrincipal(p);
    return (
      this.store.db
        .prepare(
          "SELECT key FROM kv WHERE key LIKE 'writing-draft:%' ORDER BY json_extract(value,'$.updatedAt') DESC LIMIT 100",
        )
        .all() as { key: string }[]
    ).flatMap(({ key }) => {
      try {
        const { id, title, revision, updatedAt } = this.get(
          key.slice("writing-draft:".length),
          p,
        );
        return [{ id, title, revision, updatedAt }];
      } catch (error) {
        if (error instanceof AppError) return [];
        throw error;
      }
    });
  }
  create(answerId: string, value: unknown, p: Principal) {
    this.write(p);
    const { title } = z
      .object({ title: DraftContent.shape.title })
      .strict()
      .parse(value);
    // Answers and research candidates both have fixed evidence. Never trust a client-supplied answer body.
    const answer = this.store.db
      .prepare("SELECT 1 FROM answer_candidates WHERE id=?")
      .get(answerId)
      ? new Candidates(this.evidence).get(answerId, p).answer
      : this.answers.byId(answerId, p);
    const key = `writing-origin:${p.id}:${answerId}`;
    const previous = this.store.get(key);
    if (typeof previous === "string") return this.get(previous, p);
    if (answer.claims.length > 20)
      throw new AppError("LIMIT", 409, "草稿最多包含 20 段，请先拆分候选；未截断原报告。");
    const content = DraftContent.parse({
      title,
      paragraphs: answer.claims.map(({ text, evidenceIds }) => ({
        text,
        evidenceIds,
      })),
    });
    const d: WritingDraft = {
      ...content,
      id: randomUUID(),
      revision: 1,
      answer,
      createdBy: p.id,
      updatedAt: Date.now(),
    };
    this.store.tx(() => {
      this.store.set(`writing-draft:${d.id}`, d);
      this.store.set(key, d.id);
      this.store.event("draft.created", d.id);
    });
    return d;
  }
  save(id: string, value: unknown, p: Principal) {
    this.write(p);
    const { revision, ...content } = DraftEdit.parse(value);
    return this.store.tx(() => {
      const current = this.get(id, p);
      for (const paragraph of content.paragraphs)
        if (
          paragraph.evidenceIds.some(
            (ref) => !current.answer.evidence.some((e) => e.id === ref),
          )
        )
          throw new AppError("INVALID_CITATION");
      const same =
        digest(content) ===
        digest({ title: current.title, paragraphs: current.paragraphs });
      if (
        current.revision !== revision &&
        !(current.revision === revision + 1 && same)
      )
        throw new AppError(
          "BASELINE",
          409,
          "草稿已被更新。当前输入仍保留，请核对已保存版本后再合并。",
        );
      if (same) return current;
      const updated = {
        ...current,
        ...content,
        revision: current.revision + 1,
        updatedAt: Date.now(),
      };
      this.store.set(`writing-draft:${id}`, updated);
      this.store.event("draft.edited", id);
      return updated;
    });
  }
  freeze(id: string, revision: number, p: Principal): SavedCandidate {
    this.write(p);
    return this.store.tx(() => {
      const d = this.get(id, p);
      if (d.revision !== revision) throw new AppError("BASELINE");
      const frozenKey = `writing-frozen:${id}:${revision}`;
      const old = this.store.get(frozenKey);
      if (typeof old === "string")
        return new Candidates(this.evidence).get(old, p);
      const content = {
        id,
        revision,
        title: d.title,
        paragraphs: d.paragraphs,
      };
      const candidate: SavedCandidate = {
        id: randomUUID(),
        createdBy: p.id,
        state: "awaiting_scene04_review",
        draft: { ...content, digest: digest(content) },
        answer: {
          ...d.answer,
          semanticReview: "not-reviewed",
          relations: [],
          claims: d.paragraphs.map((paragraph) => {
            const original = d.answer.claims.find(
              (claim) =>
                claim.text === paragraph.text &&
                digest(claim.evidenceIds) === digest(paragraph.evidenceIds),
            );
            return {
              id: randomUUID(),
              ...paragraph,
              review: "unreviewed",
              kind: original?.kind ?? "user-stated",
              scope: original?.scope ?? d.answer.evidence[0]!.profile.scope,
            };
          }),
        },
      };
      this.store.db
        .prepare("INSERT INTO answer_candidates VALUES(?,?)")
        .run(candidate.id, JSON.stringify(candidate));
      this.store.set(frozenKey, candidate.id);
      this.store.event("draft.frozen", id);
      return candidate;
    });
  }
}
