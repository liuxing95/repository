import { z } from "zod";
import { AcquisitionPlan, Id, type Principal } from "@kb/contracts";
import { ResearchStore } from "./brief";
import { Snapshots } from "./snapshots";
import { Ingestion } from "../ingestion/manifest";
import { withinScope, normalizeUrl } from "../ingestion/fetcher";
import { coverage } from "./coverage";
import { digest } from "../workspace/registry";
import { AppError } from "../errors";
export class Acquisition {
  constructor(
    readonly db: ResearchStore,
    readonly ingestion = new Ingestion(db.evidence.registry, db.jobs),
  ) {}
  async preview(id: string, value: unknown, p: Principal) {
    const input = z
      .object({
        operationId: Id,
        questionId: Id,
        entry: z.string().url().max(2048),
        maxPages: z.number().int().min(1).max(10),
      })
      .strict()
      .parse(value);
    const r = this.db.active(id, p);
    if (r.brief.mode !== "fill_gaps")
      throw new AppError("FORBIDDEN", 403, "库内研究不会获取网络资料。");
    const s = new Snapshots(this.db).current(r, p),
      q = r.brief.questions.find((q) => q.id === input.questionId);
    if (!q) throw new AppError("NOT_FOUND", 404);
    if (coverage(this.db, r.brief, s, q).state === "supported")
      throw new AppError("NO_GAP");
    const plan = AcquisitionPlan.parse({
      id: input.operationId,
      kind: input.maxPages === 1 ? "web" : "collection",
      entry: input.entry,
      allowedHosts: r.brief.acquisitionScope.hosts,
      allowedPaths: r.brief.acquisitionScope.paths,
      maxPages: input.maxPages,
      maxBytes: 2_000_000,
      maxDepth: 1,
      maxDurationMs: 15000,
    });
    if (!withinScope(new URL(normalizeUrl(input.entry)), plan))
      throw new AppError("FORBIDDEN", 403);
    const key = `research-acquisition:${id}:${input.operationId}`,
      signature = digest(input);
    const prior = this.db.store.get(key) as
      { signature: string; batchId: string | null } | undefined;
    if (prior) {
      if (prior.signature !== signature) throw new AppError("CONFLICT");
      if (prior.batchId) return this.ingestion.get(prior.batchId);
      throw new AppError(
        "CALL_ALREADY_SENT",
        409,
        "此次发现已尝试，先检查收录批次；不自动重新请求。",
      );
    }
    this.db.store.tx(() => {
      const current = this.db.active(id, p);
      if (
        current.discoveries >= current.brief.limits.discoveries ||
        current.materialIds.length +
          current.materialReservations +
          input.maxPages >
          current.brief.limits.materials
      )
        throw new AppError("LIMIT");
      current.discoveries++;
      current.materialReservations += input.maxPages;
      this.db.save(current);
      this.db.store.set(key, { signature, batchId: null });
    });
    const batch = await this.ingestion.preview(plan, p);
    this.db.active(id, p);
    this.db.store.set(key, { signature, batchId: batch.id });
    this.db.store.event("research.acquisition.previewed", id);
    return batch;
  }
}
