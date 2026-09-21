import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ModelAnswer,
  type AnswerResult,
  type Principal,
  type SearchResult,
} from "@kb/contracts";
import { SearchService } from "../search/search";
import { compareScope, matchScope } from "../evidence/scope";
import {
  evidencePack,
  PROMPT_VERSION,
  type EvidencePack,
} from "./evidence-pack";
import { AnswerCache } from "./cache";
import { digest } from "../workspace/registry";
import { AppError } from "../errors";
import { Jobs } from "../runtime/jobs";
import { Budget } from "../runtime/budget";
import { WorkerBroker } from "../runtime/worker-broker";
import { Policy } from "../security/policy";
// Installed by trusted service code, never by a note, request-supplied URL, or model output.
export type AnswerProvider = {
  model: string;
  generate: (
    pack: EvidencePack,
    input: {
      signal: AbortSignal;
      maxOutputTokens: number;
      idempotencyKey: string;
    },
  ) => Promise<{ requestId: string; cost: number; value: unknown }>;
};
export const AnswerInput = z
  .object({
    snapshotId: z.string().uuid(),
    routeId: z
      .string()
      .regex(/^[a-z0-9-]{1,64}$/)
      .optional(),
    operationId: z.string().uuid(),
  })
  .strict();
function validateClaims(
  output: z.infer<typeof ModelAnswer>,
  pack: EvidencePack,
  model: boolean,
) {
  const claims = output.claims.map((c) => ({
    ...c,
    review: "unreviewed" as const,
  }));
  for (const claim of claims) {
    const refs = claim.evidenceIds.map((id) =>
      pack.evidence.find((e) => e.id === id),
    );
    if (refs.some((e) => !e) || (claim.kind === "sourced" && !refs.length))
      throw new AppError("INVALID_CITATION");
    if (
      refs.some((e) => matchScope(claim.scope, e!.profile.scope) === "disjoint")
    )
      throw new AppError("SCOPE_MISMATCH");
    // Direct facts must preserve the complete cited block. Paraphrases are explicitly inferred.
    if (claim.kind === "sourced" && !refs.some((e) => e!.text === claim.text))
      throw new AppError(
        "UNSUPPORTED_CLAIM",
        409,
        "来源事实必须保留完整原文；改写只能标为推断并等待人工审核。",
      );
    if (
      claim.kind === "sourced" &&
      !refs.some((e) => digest(claim.scope) === digest(e!.profile.scope))
    )
      throw new AppError("SCOPE_MISMATCH");
    if (model && claim.kind === "user-stated")
      throw new AppError("INVALID_CLAIM_KIND");
  }
  const ids = new Set(claims.map((c) => c.id));
  if (ids.size !== claims.length) throw new AppError("INVALID_CITATION");
  for (const relation of output.relations) {
    if (
      !ids.has(relation.from) ||
      !ids.has(relation.to) ||
      relation.from === relation.to
    )
      throw new AppError("INVALID_CITATION");
    if (relation.type === "contradicts") {
      const a = claims.find((c) => c.id === relation.from)!;
      const b = claims.find((c) => c.id === relation.to)!;
      if (compareScope(a.scope, b.scope) !== "overlap")
        throw new AppError("SCOPE_UNKNOWN");
    }
  }
  return claims;
}
export class AnswerService {
  readonly cache: AnswerCache;
  private busy = false;
  constructor(
    readonly search: SearchService,
    readonly providers: ReadonlyMap<string, AnswerProvider> = new Map(),
  ) {
    this.cache = new AnswerCache(search);
  }
  options() {
    return {
      modelEnabled: this.providers.size > 0,
      routes: [...this.providers].map(([id, p]) => ({ id, model: p.model })),
      message: this.providers.size
        ? "模型输出仍需人工核对语义。"
        : "未配置模型；可以搜索和整理原文证据。",
    };
  }
  async answer(value: unknown, p: Principal): Promise<AnswerResult> {
    const input = AnswerInput.parse(value);
    const snapshot = this.search.snapshot(input.snapshotId, p);
    const result: SearchResult = await this.search.search(
      { ...snapshot.input, snapshotId: snapshot.id },
      p,
    );
    const pack = evidencePack(result, this.search.evidence);
    const provider = input.routeId
      ? this.providers.get(input.routeId)
      : undefined;
    if (input.routeId && !provider)
      throw new AppError(
        "UNAVAILABLE",
        503,
        "尚未安装受信模型适配器；可先使用原文证据整理。",
      );
    const registry = this.search.evidence.registry;
    const policy = new Policy(registry);
    const sources = [...new Set(pack.evidence.map((e) => e.sourceId))];
    const check = () => {
      this.search.validate(snapshot, p);
      for (const e of pack.evidence) this.search.evidence.read(e.id);
      if (input.routeId && sources.length)
        policy.allow(
          p,
          registry.get().policyVersion,
          "model",
          input.routeId,
          sources,
        );
    };
    check();
    const key = digest({
      question: pack.question,
      snapshot: snapshot.id,
      policy: registry.get().policyVersion,
      model: provider?.model ?? "local-extractive",
      prompt: PROMPT_VERSION,
      route: input.routeId ?? null,
    });
    const cached = this.cache.get(key, p);
    if (cached) return cached;
    let output: z.infer<typeof ModelAnswer> = {
      claims: pack.evidence.map((e) => ({
        id: randomUUID(),
        text: e.text,
        kind: "sourced",
        review: "unreviewed",
        scope: e.profile.scope,
        evidenceIds: [e.id],
      })),
      relations: [],
      gaps: pack.gaps,
    };
    if (provider && pack.evidence.length) {
      if (this.busy) throw new AppError("BUSY", 429);
      this.busy = true;
      const jobs = new Jobs(this.search.store);
      const operationKey = `answer:${p.id}:${input.operationId}`;
      let job: ReturnType<Jobs["claim"]>;
      const controller = new AbortController();
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        if (this.search.store.get(operationKey))
          throw new AppError(
            "CALL_ALREADY_SENT",
            409,
            "这次调用已经提交过；不要自动重发未知费用的请求。",
          );
        this.search.store.set(operationKey, key);
        const queued = jobs.enqueue(
          { operationKey, queue: "interactive", kind: "evidence-answer" },
          registry.settings().budget?.jobLimit ?? 0,
        );
        job = jobs.claim("interactive", 30000, "evidence-answer", queued.id);
        if (!job || job.id !== queued.id) throw new AppError("BUSY", 429);
        heartbeat = setInterval(() => {
          try {
            check();
            jobs.heartbeat(job!.id, job!.fence, "answering");
          } catch {
            controller.abort();
          }
        }, 100);
        const broker = new WorkerBroker(
          policy,
          new Budget(registry, jobs),
          jobs,
          new Map([[input.routeId!, (args) => provider.generate(pack, args)]]),
        );
        const token = broker.grant({
          principal: p,
          version: registry.get().policyVersion,
          jobId: job.id,
          fence: job.fence,
          purpose: "model",
          routeId: input.routeId!,
          sourceIds: sources,
        });
        const value = await broker.call(
          token,
          operationKey,
          Buffer.byteLength(JSON.stringify(pack)),
          AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
        );
        check();
        output = ModelAnswer.parse(value);
        validateClaims(output, pack, true);
        jobs.finish(job.id, job.fence, true);
      } catch (error) {
        if (job) {
          try {
            jobs.finish(job.id, job.fence, false);
          } catch {
            /* Cancellation already owns the terminal state. */
          }
        }
        throw error;
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        this.busy = false;
      }
    }
    const claims = validateClaims(output, pack, !!provider);
    check();
    const conflict = output.relations.some((r) => r.type === "contradicts");
    const answer: AnswerResult = {
      ...output,
      claims,
      gaps: [...new Set([...pack.gaps, ...output.gaps])],
      id: randomUUID(),
      snapshotId: snapshot.id,
      status: conflict
        ? "conflict"
        : claims.some((c) => c.kind === "sourced")
          ? "supported"
          : "insufficient",
      mode: provider ? "model" : "extractive",
      semanticReview: "not-reviewed",
      evidence: pack.evidence,
      familyCount: new Set(pack.evidence.map((e) => e.familyId)).size,
      model: provider?.model ?? "local-extractive",
      promptVersion: PROMPT_VERSION,
    };
    this.cache.validate(answer, p);
    this.cache.put(key, answer);
    return answer;
  }
  byId(id: string, p: Principal) {
    const row = this.search.store.db
      .prepare(
        "SELECT value FROM answer_cache WHERE json_extract(value,'$.id')=?",
      )
      .get(id) as { value: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    return this.cache.validate(JSON.parse(row.value) as AnswerResult, p);
  }
  candidate(id: string, p: Principal) {
    const answer = this.byId(id, p);
    const candidate = {
      id: answer.id,
      state: "awaiting_scene04_review",
      answer,
      createdBy: p.id,
    };
    this.search.store.db
      .prepare("INSERT OR IGNORE INTO answer_candidates VALUES(?,?)")
      .run(id, JSON.stringify(candidate));
    return candidate;
  }
}
