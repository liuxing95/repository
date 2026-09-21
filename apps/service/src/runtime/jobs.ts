import { randomUUID } from "node:crypto";
import { JobInput, type Job, type Queue, type Problem } from "@kb/contracts";
import { Store } from "../storage/store";
import { digest } from "../workspace/registry";
import { AppError, problem } from "../errors";

type Row = {
  id: string;
  operation_key: string;
  root_id: string;
  parent_id: string | null;
  queue: Queue;
  kind: string;
  digest: string;
  state: Job["state"];
  stage: string;
  attempt: number;
  fence: number;
  lease_until: number | null;
  cancelled: number;
  created_at: number;
};
const toJob = (r: Row): Job => ({
  id: r.id,
  operationKey: r.operation_key,
  rootId: r.root_id,
  parentId: r.parent_id,
  queue: r.queue,
  kind: r.kind,
  digest: r.digest,
  state: r.state,
  stage: r.stage,
  attempt: r.attempt,
  fence: r.fence,
  leaseUntil: r.lease_until,
  cancelled: !!r.cancelled,
  createdAt: r.created_at,
});
export class Jobs {
  constructor(
    readonly store: Store,
    readonly now = Date.now,
  ) {}
  get(id: string) {
    const r = this.store.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as
      Row | undefined;
    if (!r) throw new AppError("NOT_FOUND", 404);
    return {
      ...toJob(r),
      problem: this.store.get(`jobProblem:${id}`) as Problem | undefined,
    };
  }
  list() {
    return (
      this.store.db
        .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100")
        .all() as Row[]
    ).map((row) => this.get(row.id));
  }
  enqueue(value: unknown, rootLimit: number) {
    const parsed = JobInput.safeParse(value);
    if (!parsed.success || !Number.isSafeInteger(rootLimit) || rootLimit < 0)
      throw new AppError("VALIDATION", 400);
    const input = parsed.data;
    const inputDigest = digest(input);
    return this.store.tx(() => {
      const previous = this.store.db
        .prepare("SELECT * FROM jobs WHERE operation_key=?")
        .get(input.operationKey) as Row | undefined;
      if (previous) {
        if (previous.digest !== inputDigest) throw new AppError("CONFLICT");
        return toJob(previous);
      }
      const parent = input.parentId ? this.get(input.parentId) : undefined;
      if (
        parent &&
        (parent.cancelled ||
          parent.state === "cancelled" ||
          this.get(parent.rootId).cancelled)
      )
        throw new AppError("CANCELLED");
      const id = randomUUID();
      const rootId = parent?.rootId ?? id;
      this.store.db
        .prepare(
          "INSERT INTO jobs(id,operation_key,root_id,parent_id,queue,kind,digest,state,stage,created_at) VALUES(?,?,?,?,?,?,?,'queued','queued',?)",
        )
        .run(
          id,
          input.operationKey,
          rootId,
          input.parentId ?? null,
          input.queue,
          input.kind,
          inputDigest,
          this.now(),
        );
      if (!parent)
        this.store.db
          .prepare(
            "INSERT INTO roots(id,limit_amount,currency) VALUES (?,?,'USD')",
          )
          .run(id, rootLimit);
      this.store.event("job.queued", id);
      return this.get(id);
    });
  }
  claim(queue: Queue, leaseMs = 30_000) {
    return this.store.tx(() => {
      this.store.db
        .prepare(
          "UPDATE jobs SET state='failed',stage='retry-limit',lease_until=NULL WHERE state='running' AND lease_until<=? AND attempt>=3",
        )
        .run(this.now());
      // A killed/expired worker never owns the next execution's fence.
      const row = this.store.db
        .prepare(
          "SELECT * FROM jobs WHERE queue=? AND cancelled=0 AND (state='queued' OR (state='running' AND lease_until<=?)) ORDER BY created_at,id LIMIT 1",
        )
        .get(queue, this.now()) as Row | undefined;
      if (!row) return undefined;
      this.store.db
        .prepare(
          "UPDATE jobs SET state='running',stage='executing',attempt=attempt+1,fence=fence+1,lease_until=? WHERE id=?",
        )
        .run(this.now() + leaseMs, row.id);
      this.store.event("job.claimed", row.id);
      return this.get(row.id);
    });
  }
  active(id: string, fence: number) {
    const job = this.get(id);
    if (
      job.cancelled ||
      job.state !== "running" ||
      job.fence !== fence ||
      (job.leaseUntil ?? 0) <= this.now() ||
      this.get(job.rootId).cancelled
    )
      throw new AppError("STALE_WORKER");
    return job;
  }
  heartbeat(id: string, fence: number, stage: string) {
    this.store.tx(() => {
      this.active(id, fence);
      this.store.db
        .prepare("UPDATE jobs SET lease_until=?,stage=? WHERE id=?")
        .run(this.now() + 30_000, stage.slice(0, 64), id);
    });
  }
  finish(id: string, fence: number, success: boolean) {
    return this.store.tx(() => {
      this.active(id, fence);
      this.store.db
        .prepare("UPDATE jobs SET state=?,stage=?,lease_until=NULL WHERE id=?")
        .run(
          success ? "succeeded" : "failed",
          success ? "complete" : "failed",
          id,
        );
      this.store.event("job.finished", id);
      if (!success)
        this.store.set(
          `jobProblem:${id}`,
          problem(
            new AppError(
              "WORKER_FAILED",
              409,
              "查看诊断并重试；重试仍沿用根作业预算。",
              true,
            ),
          ),
        );
      return this.get(id);
    });
  }
  cancel(id: string) {
    return this.store.tx(() => {
      this.get(id);
      this.store.db
        .prepare(
          "WITH RECURSIVE descendants(id) AS (SELECT id FROM jobs WHERE id=? UNION ALL SELECT j.id FROM jobs j JOIN descendants d ON j.parent_id=d.id) UPDATE jobs SET cancelled=1,state=CASE WHEN state IN ('queued','running') THEN 'cancelled' ELSE state END,lease_until=NULL WHERE id IN (SELECT id FROM descendants)",
        )
        .run(id);
      this.store.event("job.cancelled", id);
      return this.get(id);
    });
  }
}
