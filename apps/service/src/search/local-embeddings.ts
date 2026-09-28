import { randomUUID } from "node:crypto";
import type { ParseArtifact, Principal } from "@kb/contracts";
import { EvidenceStore } from "../evidence/locator";
import { AppError } from "../errors";
import { Policy } from "../security/policy";
import { CHUNKER_VERSION } from "./chunks";

export type LocalEmbedder = (text: string, signal?: AbortSignal) => Promise<number[]>;

function normalized(input: number[]) {
  if (!input.length || input.length > 4096 || input.some((value) => !Number.isFinite(value)))
    throw new AppError("VALIDATION", 400, "本机嵌入向量无效。");
  const norm = Math.hypot(...input);
  if (norm <= 0) throw new AppError("VALIDATION", 400, "本机嵌入向量不能全为零。");
  return Float32Array.from(input, (value) => value / norm);
}

export class LocalEmbeddings {
  readonly fingerprint: string;
  constructor(
    readonly evidence: EvidenceStore,
    readonly routeId: string,
    readonly modelDigest: string,
    readonly embed: LocalEmbedder,
  ) {
    if (!/^[a-f0-9]{64}$/i.test(modelDigest)) throw new AppError("VALIDATION", 400);
    this.fingerprint = `${CHUNKER_VERSION}:${modelDigest}:cosine-f32-v1`;
  }
  async build(generation: string, principal: Principal, signal = AbortSignal.timeout(600_000)) {
    const db = this.evidence.store.db;
    const policy = new Policy(this.evidence.registry);
    const version = this.evidence.registry.get().policyVersion;
    const temp = `${this.fingerprint}:building:${randomUUID()}`;
    const rows = db.prepare(
      "SELECT d.evidence_id,d.source_id FROM search_documents d WHERE d.generation=? ORDER BY d.id",
    ).all(generation) as { evidence_id: string; source_id: string }[];
    let dimensions = 0;
    let count = 0;
    const parsed = new Map<string, ParseArtifact>();
    try {
      for (const row of rows) {
        if (signal.aborted) throw new AppError("CANCELLED");
        try {
          policy.allow(principal, version, "embedding", this.routeId, [row.source_id]);
        } catch (error) {
          if (error instanceof AppError && error.code === "FORBIDDEN") continue;
          throw error;
        }
        const item = this.evidence.read(row.evidence_id, parsed);
        const vector = normalized(await this.embed(item.text, signal));
        policy.allow(principal, version, "embedding", this.routeId, [row.source_id]);
        this.evidence.read(row.evidence_id, parsed);
        if (dimensions && vector.length !== dimensions)
          throw new AppError("BASELINE", 409, "嵌入模型维度在建索引过程中变化。");
        dimensions = vector.length;
        db.prepare("INSERT INTO retrieval_vectors VALUES(?,?,?,?,?)").run(
          generation, row.evidence_id, temp, dimensions,
          Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        );
        count++;
      }
      this.evidence.store.tx(() => {
        db.prepare("DELETE FROM retrieval_vectors WHERE generation=? AND model_fingerprint=?")
          .run(generation, this.fingerprint);
        db.prepare("UPDATE retrieval_vectors SET model_fingerprint=? WHERE generation=? AND model_fingerprint=?")
          .run(this.fingerprint, generation, temp);
      });
      return { count, dimensions, fingerprint: this.fingerprint };
    } catch (error) {
      db.prepare("DELETE FROM retrieval_vectors WHERE generation=? AND model_fingerprint=?")
        .run(generation, temp);
      throw error;
    }
  }
  async rank(query: string, generation: string, principal: Principal, limit = 10, signal = AbortSignal.timeout(30_000)) {
    const db = this.evidence.store.db;
    const policy = new Policy(this.evidence.registry);
    const version = this.evidence.registry.get().policyVersion;
    const rows = db.prepare(
      `SELECT v.evidence_id,v.dimensions,v.vector,d.source_id FROM retrieval_vectors v
       JOIN search_documents d ON d.generation=v.generation AND d.evidence_id=v.evidence_id
       WHERE v.generation=? AND v.model_fingerprint=?`,
    ).all(generation, this.fingerprint) as {
      evidence_id: string; dimensions: number; vector: Buffer; source_id: string
    }[];
    const permitted = new Map<string, boolean>();
    const visible = rows.filter((row) => {
      if (!this.evidence.readable(row.source_id)) return false;
      if (!permitted.has(row.source_id)) {
        try {
          policy.allow(principal, version, "embedding", this.routeId, [row.source_id]);
          permitted.set(row.source_id, true);
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "FORBIDDEN") throw error;
          permitted.set(row.source_id, false);
        }
      }
      return permitted.get(row.source_id);
    });
    if (!visible.length) return [];
    const question = normalized(await this.embed(query, signal));
    const ranked = visible.map((row) => {
      if (row.dimensions !== question.length || row.vector.length !== question.length * 4)
        throw new AppError("BASELINE", 409, "向量维度与当前模型不一致。");
      let score = 0;
      for (let i = 0; i < question.length; i++)
        score += question[i]! * row.vector.readFloatLE(i * 4);
      return { evidenceId: row.evidence_id, sourceId: row.source_id, score };
    }).sort((a, b) => b.score - a.score || a.evidenceId.localeCompare(b.evidenceId));
    const output = ranked.slice(0, Math.max(1, Math.min(limit, 50)));
    for (const row of output) {
      policy.allow(principal, version, "embedding", this.routeId, [row.sourceId]);
      this.evidence.read(row.evidenceId);
    }
    return output;
  }
}
