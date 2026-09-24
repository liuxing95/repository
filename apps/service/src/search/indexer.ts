import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { EvidenceStore } from "../evidence/locator";
import { AppError } from "../errors";
import { TOKENIZER_VERSION, tokenize } from "./tokenizer";
export type Generation = {
  id: string;
  state: string;
  watermark: number;
  fingerprint: string;
  blocks: number;
};
export class Indexer {
  private building?: Promise<Generation>;
  constructor(readonly evidence: EvidenceStore) {}
  get store() {
    return this.evidence.store;
  }
  watermark() {
    return (
      this.store.db
        .prepare(
          "SELECT COALESCE(MAX(id),0) n FROM events WHERE kind IN ('source.index_requested','evidence.profile.changed','source.policy.changed')",
        )
        .get() as { n: number }
    ).n;
  }
  active() {
    const id = this.store.get("search:active");
    return typeof id === "string"
      ? (this.store.db
          .prepare(
            "SELECT * FROM search_generations WHERE id=? AND state='complete'",
          )
          .get(id) as Generation | undefined)
      : undefined;
  }
  status(generation: Generation) {
    return {
      generation: generation.id,
      state: (generation.watermark === this.watermark() &&
      generation.fingerprint === TOKENIZER_VERSION
        ? "complete"
        : "partial") as "complete" | "partial",
      blocks: generation.blocks,
      fingerprint: generation.fingerprint,
    };
  }
  async ensure() {
    this.collect();
    const active = this.active();
    if (active && this.status(active).state === "complete") return active;
    if (this.building && active) return active;
    return this.rebuild();
  }
  rebuild() {
    if (this.building) return this.building;
    this.building = this.build().finally(() => {
      this.building = undefined;
    });
    return this.building;
  }
  private async build(): Promise<Generation> {
    const generation: Generation = {
      id: randomUUID(),
      state: "building",
      watermark: this.watermark(),
      fingerprint: TOKENIZER_VERSION,
      blocks: 0,
    };
    this.store.db
      .prepare("INSERT INTO search_generations VALUES(?,?,?,?,?)")
      .run(
        generation.id,
        generation.state,
        generation.watermark,
        generation.fingerprint,
        0,
      );
    try {
      const parses = this.store.db
        .prepare(
          "SELECT p.id,r.source_id FROM parse_artifacts p JOIN source_revisions r ON r.id=p.revision_id WHERE p.committed=1 AND r.committed=1 ORDER BY p.id",
        )
        .all() as { id: string; source_id: string }[];
      for (const { id, source_id } of parses) {
        if (!this.evidence.readable(source_id)) continue;
        const parsed = this.evidence.commits.parse(id);
        // Explicit read restrictions affect serving, not whether private local index generations exist.
        const rev = this.store.db
          .prepare("SELECT source_id FROM source_revisions WHERE id=?")
          .get(parsed.revisionId) as { source_id: string };
        if (!this.evidence.readable(rev.source_id)) continue;
        this.store.tx(() => {
          const entries = this.evidence.register(parsed);
          const title = tokenize(parsed.title).terms.join(" ");
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i]!;
            const block = parsed.blocks[i]!;
            const tokens = tokenize(
              parsed.title +
                " " +
                block.text +
                " " +
                (block.locator.path ?? ""),
            );
            const row = this.store.db
              .prepare(
                "INSERT INTO search_documents(generation,parse_id,source_id,evidence_id) VALUES(?,?,?,?)",
              )
              .run(generation.id, id, entry.sourceId, entry.id);
            this.store.db
              .prepare(
                "INSERT INTO search_fts(rowid,title,terms,symbols) VALUES(?,?,?,?)",
              )
              .run(
                row.lastInsertRowid,
                title,
                tokens.terms.join(" "),
                tokens.symbols.join(" "),
              );
            generation.blocks++;
          }
        });
        await setImmediate();
      }
      this.store.tx(() => {
        this.store.db
          .prepare(
            "UPDATE search_generations SET state='complete',blocks=? WHERE id=?",
          )
          .run(generation.blocks, generation.id);
        this.store.set("search:active", generation.id);
        this.store.event("search.generation.published", generation.id);
      });
      generation.state = "complete";
      return generation;
    } catch (error) {
      this.store.tx(() => {
        this.store.db
          .prepare(
            "DELETE FROM search_fts WHERE rowid IN (SELECT id FROM search_documents WHERE generation=?)",
          )
          .run(generation.id);
        this.store.db
          .prepare("DELETE FROM search_documents WHERE generation=?")
          .run(generation.id);
        this.store.db
          .prepare("DELETE FROM search_generations WHERE id=?")
          .run(generation.id);
      });
      throw error instanceof AppError ? error : new AppError("INDEX_FAILED");
    }
  }
  collect() {
    this.store.tx(() => {
      this.store.db
        .prepare("DELETE FROM query_snapshots WHERE expires_at<=?")
        .run(Date.now());
      const old = this.store.db
        .prepare(
          "SELECT id FROM search_generations WHERE id!=? AND id NOT IN (SELECT generation FROM query_snapshots)",
        )
        .all(this.active()?.id ?? "") as { id: string }[];
      for (const { id } of old) {
        if (this.building) continue;
        this.store.db
          .prepare(
            "DELETE FROM search_fts WHERE rowid IN (SELECT id FROM search_documents WHERE generation=?)",
          )
          .run(id);
        this.store.db
          .prepare("DELETE FROM search_documents WHERE generation=?")
          .run(id);
        this.store.db
          .prepare("DELETE FROM search_generations WHERE id=?")
          .run(id);
      }
    });
  }
}
