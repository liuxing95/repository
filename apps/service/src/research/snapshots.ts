import { randomUUID } from "node:crypto";
import type {
  Principal,
  Research,
  ResearchSnapshot,
  EvidenceRead,
} from "@kb/contracts";
import { Indexer } from "../search/indexer";
import { matchExpression } from "../search/tokenizer";
import { matchScope } from "../evidence/scope";
import { digest } from "../workspace/registry";
import { AppError } from "../errors";
import { ResearchStore } from "./brief";
export function snapshotDigest(s: ResearchSnapshot) {
  return digest({ ...s, digest: undefined });
}
export class Snapshots {
  readonly indexer: Indexer;
  constructor(readonly db: ResearchStore) {
    this.indexer = new Indexer(db.evidence);
  }
  get(
    id: string,
    researchId: string,
    p: Principal,
    validate = true,
  ): ResearchSnapshot {
    this.db.evidence.checkPrincipal(p);
    const row = this.db.store.db
      .prepare(
        "SELECT value FROM research_snapshots WHERE id=? AND research_id=?",
      )
      .get(id, researchId) as { value: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    const s = JSON.parse(row.value) as ResearchSnapshot;
    if (snapshotDigest(s) !== s.digest) throw new AppError("HASH_MISMATCH");
    if (validate) this.validate(s, p);
    return s;
  }
  validate(s: ResearchSnapshot, p: Principal) {
    this.db.evidence.checkPrincipal(p);
    for (const e of s.evidence)
      if (digest(e) !== digest(this.db.evidence.read(e.id)))
        throw new AppError(
          "BASELINE",
          409,
          "研究依据的权限、范围或原文已变化，请准备并确认新快照。",
        );
  }
  async propose(id: string, p: Principal) {
    let r = this.db.active(id, p);
    const generation = await this.indexer.ensure();
    r = this.db.active(id, p);
    if (this.indexer.status(generation).state !== "complete")
      throw new AppError("INDEX_UNAVAILABLE");
    const previous = r.snapshotId
      ? this.get(r.snapshotId, r.id, p, false)
      : null;
    const evidence = new Map<string, EvidenceRead>(),
      sources = new Set<string>();
    const questions: ResearchSnapshot["questions"] = [];
    for (const q of r.brief.questions) {
      const ids = new Set<string>(),
        counterIds = new Set<string>(),
        warnings = new Set<string>();
      for (const [query, counter] of [
        [q.query, false],
        [q.counterQuery, true],
      ] as const) {
        const expression = matchExpression(query);
        if (!expression) continue;
        const rows = this.db.store.db
          .prepare(
            `SELECT d.evidence_id FROM search_fts JOIN search_documents d ON d.id=search_fts.rowid WHERE search_fts MATCH ? AND d.generation=? ORDER BY bm25(search_fts,4,1,8),d.evidence_id LIMIT 3000`,
          )
          .all(expression, generation.id) as { evidence_id: string }[];
        if (rows.length === 3000)
          warnings.add("检索候选达到 3000 条上限，需缩小问题范围");
        for (const row of rows) {
          let e: EvidenceRead;
          try {
            e = this.db.evidence.read(row.evidence_id);
          } catch (err) {
            if (
              err instanceof AppError &&
              ["FORBIDDEN", "RETRACTED"].includes(err.code)
            )
              continue;
            throw err;
          }
          if (
            matchScope(q.scope, e.profile.scope) === "disjoint" ||
            !r.brief.scopes.some(
              (s) => matchScope(s, e.profile.scope) !== "disjoint",
            )
          )
            continue;
          if (e.text.length > 4000) {
            warnings.add("存在超长原文块，需重新分块；未截断引用");
            continue;
          }
          if (!ids.has(e.id) && ids.size >= 8) {
            warnings.add("本题最多 8 条原文，剩余需拆题核对");
            continue;
          }
          // Reprints of the same original and scope do not count as independent support.
          if (
            [...ids].some((id) => {
              const old = evidence.get(id)!;
              return (
                old.id !== e.id &&
                old.familyId === e.familyId &&
                old.text === e.text &&
                digest(old.profile.scope) === digest(e.profile.scope)
              );
            })
          )
            continue;
          if (
            !sources.has(e.sourceId) &&
            !this.db.admitMaterial(r, e.sourceId)
          ) {
            warnings.add("研究材料上限已到，仍有候选未核对");
            continue;
          }
          evidence.set(e.id, e);
          sources.add(e.sourceId);
          ids.add(e.id);
          if (counter) counterIds.add(e.id);
        }
      }
      questions.push({
        questionId: q.id,
        evidenceIds: [...ids],
        counterIds: [...counterIds],
        warnings: [...warnings],
      });
    }
    for (const id of r.brief.projectEvidenceIds) {
      const e = this.db.evidence.read(id);
      if (!this.db.admitMaterial(r, e.sourceId))
        throw new AppError("LIMIT", 409, "根材料额度不足以容纳项目依据。");
      evidence.set(id, e);
    }
    const oldIds = previous?.evidence.map((e) => e.id) ?? [],
      newIds = [...evidence.keys()];
    const affected = questions
      .filter((q) => {
        const before = previous?.questions.find(
          (old) => old.questionId === q.questionId,
        );
        const state = (x: typeof q | undefined, refs: EvidenceRead[]) => ({
          q: x,
          refs: x?.evidenceIds.map((id) => refs.find((e) => e.id === id)),
        });
        return (
          digest(state(q, [...evidence.values()])) !==
          digest(state(before, previous?.evidence ?? []))
        );
      })
      .map((q) => q.questionId);
    const s: ResearchSnapshot = {
      id: randomUUID(),
      researchId: r.id,
      previousId: r.snapshotId,
      createdAt: Date.now(),
      generation: generation.id,
      evidence: [...evidence.values()],
      questions,
      affectedQuestions: affected,
      added: newIds.filter((id) => !oldIds.includes(id)),
      removed: oldIds.filter((id) => !newIds.includes(id)),
      digest: "",
    };
    s.digest = snapshotDigest(s);
    if (Buffer.byteLength(JSON.stringify(s)) > 1_000_000)
      throw new AppError("LIMIT");
    this.db.store.tx(() => {
      this.db.save(r);
      this.db.store.db
        .prepare("INSERT INTO research_snapshots VALUES(?,?,?)")
        .run(s.id, r.id, JSON.stringify(s));
    });
    return s;
  }
  advance(
    id: string,
    snapshotId: string,
    expectedDigest: string,
    p: Principal,
  ) {
    return this.db.store.tx(() => {
      const r = this.db.active(id, p),
        s = this.get(snapshotId, id, p);
      if (s.digest !== expectedDigest) throw new AppError("BASELINE");
      if (r.snapshotId === s.id) return r;
      if (s.previousId !== r.snapshotId) throw new AppError("BASELINE");
      r.snapshotId = s.id;
      this.db.save(r);
      this.db.store.event("research.snapshot.advanced", id);
      return r;
    });
  }
  current(r: Research, p: Principal) {
    if (!r.snapshotId) throw new AppError("SNAPSHOT_REQUIRED");
    return this.get(r.snapshotId, r.id, p);
  }
}
