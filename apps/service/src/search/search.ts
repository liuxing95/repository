import { randomUUID } from "node:crypto";
import {
  SearchInput,
  type Principal,
  type QuerySnapshot,
  type SearchResult,
  type ParseArtifact,
} from "@kb/contracts";
import { EvidenceStore } from "../evidence/locator";
import { matchScope } from "../evidence/scope";
import { AppError } from "../errors";
import { digest } from "../workspace/registry";
import { Indexer, type Generation } from "./indexer";
import { matchExpression } from "./tokenizer";
export class SearchService {
  readonly indexer: Indexer;
  constructor(readonly evidence: EvidenceStore) {
    this.indexer = new Indexer(evidence);
  }
  get store() {
    return this.evidence.store;
  }
  snapshot(id: string, p: Principal) {
    this.evidence.checkPrincipal(p);
    const row = this.store.db
      .prepare("SELECT value FROM query_snapshots WHERE id=? AND expires_at>?")
      .get(id, Date.now()) as { value: string } | undefined;
    if (!row) throw new AppError("SNAPSHOT_EXPIRED");
    const snapshot = JSON.parse(row.value) as QuerySnapshot;
    if (snapshot.principalId !== p.id) throw new AppError("FORBIDDEN", 403);
    return snapshot;
  }
  validate(snapshot: QuerySnapshot, p: Principal) {
    this.snapshot(snapshot.id, p);
    for (const revisionId of snapshot.revisionIds)
      this.evidence.revision(revisionId);
    const state = snapshot.evidenceIds.map((id) => {
      const e = this.evidence.read(id);
      return { id, profile: e.profile, family: e.familyId };
    });
    if (digest(state) !== snapshot.evidenceState)
      throw new AppError(
        "BASELINE",
        409,
        "证据范围或来源关系已变化，请重新搜索。",
      );
  }
  async search(value: unknown, p: Principal): Promise<SearchResult> {
    this.evidence.checkPrincipal(p);
    const input = SearchInput.parse(value);
    let snapshot = input.snapshotId
      ? this.snapshot(input.snapshotId, p)
      : undefined;
    if (
      snapshot &&
      digest({ ...input, snapshotId: undefined }) !==
        digest({ ...snapshot.input, snapshotId: undefined })
    )
      throw new AppError("BASELINE");
    if (snapshot) this.validate(snapshot, p);
    const generation = snapshot
      ? (this.store.db
          .prepare(
            "SELECT * FROM search_generations WHERE id=? AND state='complete'",
          )
          .get(snapshot.generation) as Generation | undefined)
      : await this.indexer.ensure();
    this.evidence.checkPrincipal(p);
    if (!generation) throw new AppError("INDEX_UNAVAILABLE");
    if (snapshot) {
      const hits = snapshot.evidenceIds.map((id) => {
        const e = this.evidence.read(id);
        return {
          ...e,
          score: 0,
          scopeMatch: matchScope(input.scope, e.profile.scope) as
            "overlap" | "unknown",
        };
      });
      return {
        snapshot,
        hits,
        index: this.indexer.status(generation),
        warnings: snapshot.warnings,
      };
    }
    const expression = matchExpression(input.query);
    // Filter current local-read policy inside the candidate query, before ranking/truncation.
    const rows = expression
      ? (this.store.db
          .prepare(
            `SELECT d.evidence_id, d.parse_id, bm25(search_fts,4,1,8) score
      FROM search_fts JOIN search_documents d ON d.id=search_fts.rowid
      WHERE search_fts MATCH ? AND d.generation=?
      AND NOT EXISTS (SELECT 1 FROM kv WHERE key='source:'||d.source_id AND
        (json_extract(value,'$.retracted')!=0 OR NOT EXISTS (SELECT 1 FROM json_each(kv.value,'$.routes.read') allowed WHERE allowed.value='local')))
      ORDER BY score,d.evidence_id`,
          )
          .all(expression, generation.id) as {
          evidence_id: string;
          parse_id: string;
          score: number;
        }[])
      : [];
    const hits: SearchResult["hits"] = [];
    const warnings = new Set<string>();
    if (this.indexer.status(generation).state === "partial")
      warnings.add("索引尚未覆盖最新提交，请完成重建后再确认缺失内容。");
    const cache = new Map<string, ParseArtifact>();
    const families = new Set<string>();
    for (const row of rows) {
      const read = this.evidence.read(row.evidence_id, cache);
      const match = matchScope(input.scope, read.profile.scope);
      if (
        match === "disjoint" ||
        (input.collection && read.profile.collection !== input.collection) ||
        (input.review && read.profile.review !== input.review)
      )
        continue;
      if (
        input.asOf &&
        (!read.confirmedPublishedAt ||
          Date.parse(read.confirmedPublishedAt) > Date.parse(input.asOf))
      ) {
        warnings.add(
          "已排除公开时间未知或晚于历史时点的资料；抓取时间不代表公开时间。",
        );
        continue;
      }
      if (families.has(read.familyId)) continue;
      families.add(read.familyId);
      hits.push({ ...read, score: -row.score, scopeMatch: match });
      if (hits.length >= input.limit) break;
    }
    if (!snapshot) {
      snapshot = {
        id: randomUUID(),
        generation: generation.id,
        principalId: p.id,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        parseIds: hits.map((h) => h.parseId),
        revisionIds: [...new Set(hits.map((h) => h.revisionId))],
        pageRevisions: [],
        evidenceIds: hits.map((h) => h.id),
        evidenceState: digest(
          hits.map((h) => ({
            id: h.id,
            profile: h.profile,
            family: h.familyId,
          })),
        ),
        warnings: [...warnings],
        policyVersion: this.evidence.registry.get().policyVersion,
        input,
      };
      this.store.db
        .prepare("INSERT INTO query_snapshots VALUES(?,?,?,?)")
        .run(
          snapshot.id,
          snapshot.generation,
          snapshot.expiresAt,
          JSON.stringify(snapshot),
        );
    }
    this.validate(snapshot, p);
    return {
      snapshot,
      hits,
      index: this.indexer.status(generation),
      warnings: [...warnings],
    };
  }
}
