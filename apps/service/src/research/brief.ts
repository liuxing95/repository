import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Id,
  ResearchBrief,
  type Principal,
  type Research,
} from "@kb/contracts";
import { Proposals } from "../review/proposals";
import { Jobs } from "../runtime/jobs";
import { digest } from "../workspace/registry";
import { AppError } from "../errors";
export function draftBrief(value: unknown) {
  const parsed = ResearchBrief.safeParse(value);
  return {
    brief: parsed.success ? parsed.data : value,
    ready: parsed.success,
    digest: parsed.success ? digest(parsed.data) : null,
    missing: parsed.success
      ? []
      : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}
export class ResearchStore {
  readonly jobs: Jobs;
  constructor(readonly proposals: Proposals) {
    this.jobs = new Jobs(proposals.store);
  }
  get store() {
    return this.proposals.store;
  }
  get evidence() {
    return this.proposals.evidence;
  }
  get(id: string, p: Principal): Research {
    this.evidence.checkPrincipal(p);
    const row = this.store.db
      .prepare("SELECT value FROM research_jobs WHERE id=?")
      .get(id) as { value: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    const r = JSON.parse(row.value) as Research;
    if (digest(r.brief) !== r.digest) throw new AppError("HASH_MISMATCH");
    return r;
  }
  active(id: string, p: Principal) {
    this.proposals.write(p);
    const r = this.get(id, p);
    if (r.state === "cancelled" || this.jobs.get(r.rootId).cancelled)
      throw new AppError("CANCELLED");
    return r;
  }
  save(r: Research) {
    this.store.writable();
    this.store.db
      .prepare("UPDATE research_jobs SET value=? WHERE id=?")
      .run(JSON.stringify(r), r.id);
  }
  confirm(value: unknown, p: Principal) {
    this.proposals.write(p);
    const input = z
      .object({
        operationId: Id,
        digest: z.string().length(64),
        brief: ResearchBrief,
      })
      .strict()
      .parse(value);
    if (digest(input.brief) !== input.digest) throw new AppError("BASELINE");
    for (const id of input.brief.projectEvidenceIds) {
      const e = this.evidence.read(id);
      if (
        !e.profile.scope.version ||
        !["lockfile", "configuration"].includes(
          e.profile.scope.sourceType ?? "",
        ) ||
        !input.brief.scopes.some((s) => s.version === e.profile.scope.version)
      )
        throw new AppError(
          "PROJECT_EVIDENCE",
          409,
          "项目依据需要已确认版本的锁文件或配置原文。",
        );
    }
    return this.store.tx(() => {
      const key = `research:${p.id}:${input.operationId}`;
      const old = this.store.db
        .prepare(
          "SELECT id,input_hash FROM research_jobs WHERE operation_key=?",
        )
        .get(key) as { id: string; input_hash: string } | undefined;
      if (old) {
        if (old.input_hash !== input.digest) throw new AppError("CONFLICT");
        return this.get(old.id, p);
      }
      const root = this.jobs.enqueue(
        { operationKey: key, queue: "batch", kind: "research-budget" },
        input.brief.limits.cost,
      );
      const holder = this.jobs.claim(
        "batch",
        30000,
        "research-budget",
        root.id,
      )!;
      this.jobs.finish(holder.id, holder.fence, true);
      const r: Research = {
        id: randomUUID(),
        brief: input.brief,
        digest: input.digest,
        rootId: root.id,
        snapshotId: null,
        state: "active",
        createdAt: Date.now(),
        calls: 0,
        discoveries: 0,
        materialReservations: 0,
        materialIds: [],
      };
      this.store.db
        .prepare("INSERT INTO research_jobs VALUES(?,?,?,?)")
        .run(r.id, key, input.digest, JSON.stringify(r));
      this.store.event("research.confirmed", r.id);
      return r;
    });
  }
  admitMaterial(r: Research, sourceId: string) {
    if (r.materialIds.includes(sourceId)) return true;
    // Convert a research acquisition's reserved slot only after its source really committed.
    const reserved =
      r.materialReservations > 0 &&
      this.store.db
        .prepare(
          `SELECT 1 FROM kv k JOIN ingestions b ON b.id=json_extract(k.value,'$.batchId') JOIN json_each(b.value,'$.entries') e JOIN source_revisions v ON v.id=json_extract(e.value,'$.revisionId') WHERE k.key LIKE ? AND v.source_id=? AND v.committed=1 LIMIT 1`,
        )
        .get(`research-acquisition:${r.id}:%`, sourceId);
    if (reserved) r.materialReservations--;
    else if (
      r.materialIds.length + r.materialReservations >=
      r.brief.limits.materials
    )
      return false;
    r.materialIds.push(sourceId);
    return true;
  }
  cancel(id: string, p: Principal) {
    this.proposals.write(p);
    const r = this.get(id, p);
    this.store.tx(() => {
      this.jobs.cancel(r.rootId);
      r.state = "cancelled";
      this.save(r);
      this.store.event("research.cancelled", id);
    });
    return r;
  }
  usage(r: Research) {
    const sums = this.store.db
      .prepare(
        "SELECT COALESCE(SUM(actual),0) actual,COALESCE(SUM(CASE WHEN actual IS NULL AND state!='released' THEN reserved ELSE 0 END),0) reserved FROM calls WHERE root_id=?",
      )
      .get(r.rootId) as { actual: number; reserved: number };
    return { ...sums, calls: r.calls, rootId: r.rootId };
  }
}
