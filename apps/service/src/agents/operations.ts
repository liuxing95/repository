import {
  AgentAnswerArgs,
  AgentInvokeInput,
  AgentOperationArgs,
  AgentReadArgs,
  AgentSearchArgs,
  type EvidenceRead,
} from "@kb/contracts";
import { AppError } from "../errors";
import { AnswerService, type AnswerProvider } from "../answers/answer";
import { SearchService } from "../search/search";
import { digest } from "../workspace/registry";
import { AgentClients, type AgentClient } from "./clients";
import type { Principal } from "@kb/contracts";

type ResultRef =
  | { kind: "search"; evidenceIds: string[]; nextOffset: number | null }
  | { kind: "evidence"; evidenceId: string }
  | { kind: "answer"; answerId: string };
type Operation = {
  digest: string;
  tool: string;
  objectIds: string[];
  state: "running" | "done" | "failed" | "unknown";
  result?: ResultRef;
  error?: string;
  at: number;
};

export class AgentOperations {
  readonly search: SearchService;
  readonly answers: AnswerService;
  constructor(
    readonly clients: AgentClients,
    providers?: ReadonlyMap<string, AnswerProvider>,
  ) {
    this.search = new SearchService(clients.evidence);
    this.answers = new AnswerService(this.search, providers);
  }
  private key(client: AgentClient, requestId: string) {
    return `agent-op:${client.id}:${requestId}`;
  }
  private safeEvidence(e: EvidenceRead, maxChars: number) {
    return {
      id: e.id,
      sourceId: e.sourceId,
      revisionId: e.revisionId,
      title: e.title.slice(0, 160),
      text: e.text.slice(0, maxChars),
      truncated: e.text.length > maxChars,
      start: e.start,
      end: e.end,
      untrusted: true,
    };
  }
  private async execute(
    tool: string,
    args: unknown,
    client: AgentClient,
    principal: Principal,
    requestId: string,
  ): Promise<ResultRef> {
    if (tool === "kb_search") {
      const input = AgentSearchArgs.parse(args);
      const sourceIds = this.clients.authorizeScope(
        client,
        principal,
        input.sourceIds,
      );
      const result = await this.search.search(
        { query: input.query, limit: 50 },
        principal,
        sourceIds,
      );
      const visible = result.hits.filter((hit) => {
        try {
          this.clients.authorizeEvidence(client, principal, hit.id);
          return true;
        } catch (error) {
          if (error instanceof AppError && error.code === "FORBIDDEN")
            return false;
          throw error;
        }
      });
      const page = visible.slice(input.offset, input.offset + input.limit);
      return {
        kind: "search",
        evidenceIds: page.map((hit) => hit.id),
        nextOffset:
          input.offset + input.limit < visible.length
            ? input.offset + input.limit
            : null,
      };
    }
    if (tool === "kb_read_evidence") {
      const { evidenceId } = AgentReadArgs.parse(args);
      this.clients.authorizeEvidence(client, principal, evidenceId);
      return { kind: "evidence", evidenceId };
    }
    if (tool === "kb_answer") {
      const input = AgentAnswerArgs.parse(args);
      const sourceIds = this.clients.authorizeScope(
        client,
        principal,
        input.sourceIds,
      );
      const found = await this.search.search(
        { query: input.question, limit: 5 },
        principal,
        sourceIds,
      );
      // AnswerService may follow a derived hit back to its original evidence.
      for (const hit of found.hits) {
        this.clients.authorizeEvidence(client, principal, hit.id);
        for (const originalId of hit.profile.originalEvidence)
          this.clients.authorizeEvidence(client, principal, originalId);
      }
      const result = await this.answers.answer(
        {
          snapshotId: found.snapshot.id,
          operationId: requestId,
          ...(client.receiver.kind === "model"
            ? { routeId: client.receiver.routeId }
            : {}),
        },
        principal,
      );
      return { kind: "answer", answerId: result.id };
    }
    throw new AppError("VALIDATION", 400);
  }
  private materialize(
    ref: ResultRef,
    client: AgentClient,
    principal: Principal,
  ) {
    if (ref.kind === "evidence") {
      const e = this.clients.authorizeEvidence(
        client,
        principal,
        ref.evidenceId,
      );
      return { evidence: this.safeEvidence(e, 4000) };
    }
    if (ref.kind === "search") {
      const hits = ref.evidenceIds.map((id) =>
        this.safeEvidence(
          this.clients.authorizeEvidence(client, principal, id),
          700,
        ),
      );
      return { hits, nextOffset: ref.nextOffset };
    }
    const answer = this.answers.byId(ref.answerId, principal);
    for (const e of answer.evidence)
      this.clients.authorizeEvidence(client, principal, e.id);
    return {
      status: answer.status,
      mode: answer.mode,
      semanticReview: answer.semanticReview,
      untrusted: true,
      claims: answer.claims.slice(0, 5).map((claim) => ({
        kind: claim.kind,
        text: claim.text.slice(0, 1000),
        truncated: claim.text.length > 1000,
        evidenceIds: claim.evidenceIds,
        untrusted: true,
      })),
      evidence: answer.evidence
        .slice(0, 5)
        .map((e) => this.safeEvidence(e, 700)),
      gaps: answer.gaps.slice(0, 5).map((gap) => gap.slice(0, 300)),
    };
  }
  private status(
    operation: Operation,
    client: AgentClient,
    principal: Principal,
    requestId: string,
  ) {
    const result = operation.result
      ? this.materialize(operation.result, client, principal)
      : undefined;
    const billing =
      operation.tool === "kb_answer"
        ? (this.clients.registry.store.db
            .prepare(
              "SELECT state,reserved,actual FROM calls WHERE operation_key=?",
            )
            .get(`answer:${principal.id}:${requestId}`) as
            | { state: string; reserved: number; actual: number | null }
            | undefined)
        : undefined;
    const response = {
      state: operation.state === "running" ? "unknown" : operation.state,
      result,
      error: operation.error,
      ...(billing
        ? {
            billing: {
              state: billing.state,
              reservedMicroUsd: billing.reserved,
              actualMicroUsd: billing.actual,
            },
          }
        : {}),
    };
    if (Buffer.byteLength(JSON.stringify(response)) > 16_384)
      throw new AppError(
        "VALIDATION",
        400,
        "结果超过 Agent 输出上限，请缩小问题或读取单条证据。",
      );
    return response;
  }
  async invoke(clientId: string, secret: string, value: unknown) {
    const input = AgentInvokeInput.parse(value);
    const { client, principal } = this.clients.authenticate(clientId, secret);
    if (input.tool === "kb_operation") {
      const query = AgentOperationArgs.parse(input.args);
      const operation = this.clients.registry.store.get(
        this.key(client, query.requestId),
      ) as Operation | undefined;
      if (!operation) throw new AppError("NOT_FOUND", 404);
      return this.status(operation, client, principal, query.requestId);
    }
    // Parse before reservation so malformed requests cannot occupy an idempotency key.
    let objectIds: string[];
    if (input.tool === "kb_search")
      objectIds =
        AgentSearchArgs.parse(input.args).sourceIds ?? client.sourceIds;
    else if (input.tool === "kb_read_evidence")
      objectIds = [AgentReadArgs.parse(input.args).evidenceId];
    else
      objectIds =
        AgentAnswerArgs.parse(input.args).sourceIds ?? client.sourceIds;
    const key = this.key(client, input.requestId);
    const bodyDigest = digest({ tool: input.tool, args: input.args });
    const old = this.clients.registry.store.tx(() => {
      const previous = this.clients.registry.store.get(key) as
        Operation | undefined;
      if (previous) {
        if (previous.digest !== bodyDigest) throw new AppError("CONFLICT");
        return previous;
      }
      const prefix = `agent-op:${client.id}:%`;
      this.clients.registry.store.db
        .prepare(
          "DELETE FROM kv WHERE key LIKE ? AND json_extract(value,'$.at')<? AND json_extract(value,'$.state') IN ('done','failed')",
        )
        .run(prefix, Date.now() - 7 * 86_400_000);
      const recent = this.clients.registry.store.db
        .prepare(
          "SELECT COUNT(*) n FROM kv WHERE key LIKE ? AND json_extract(value,'$.at')>?",
        )
        .get(prefix, Date.now() - 3_600_000) as { n: number };
      if (recent.n >= 120) throw new AppError("RATE_LIMIT", 429);
      this.clients.registry.store.set(key, {
        digest: bodyDigest,
        tool: input.tool,
        objectIds,
        state: "running",
        at: Date.now(),
      } satisfies Operation);
      this.clients.registry.store.event("agent.operation.started", client.id);
      return null;
    });
    if (old) return this.status(old, client, principal, input.requestId);
    try {
      const ref = await this.execute(
        input.tool,
        input.args,
        client,
        principal,
        input.requestId,
      );
      const current = this.clients.authenticate(clientId, secret);
      const result = this.materialize(ref, current.client, current.principal);
      const response = { state: "done" as const, result };
      if (Buffer.byteLength(JSON.stringify(response)) > 16_384)
        throw new AppError(
          "VALIDATION",
          400,
          "结果超过 Agent 输出上限，请缩小问题。",
        );
      const operation: Operation = {
        digest: bodyDigest,
        tool: input.tool,
        objectIds,
        state: "done",
        result: ref,
        at: Date.now(),
      };
      this.clients.registry.store.tx(() => {
        this.clients.registry.store.set(key, operation);
        this.clients.registry.store.event("agent.operation.done", client.id);
      });
      return this.status(
        operation,
        current.client,
        current.principal,
        input.requestId,
      );
    } catch (error) {
      const code = error instanceof AppError ? error.code : "UNAVAILABLE";
      const call =
        input.tool === "kb_answer"
          ? (this.clients.registry.store.db
              .prepare("SELECT state FROM calls WHERE operation_key=?")
              .get(`answer:${principal.id}:${input.requestId}`) as
              { state: string } | undefined)
          : undefined;
      const state =
        call && ["dispatched", "unknown", "settled"].includes(call.state)
          ? "unknown"
          : "failed";
      this.clients.registry.store.tx(() => {
        const current = this.clients.registry.store.get(key) as Operation;
        if (current.state === "running") {
          this.clients.registry.store.set(key, {
            digest: bodyDigest,
            tool: input.tool,
            objectIds,
            state,
            error: code,
            at: Date.now(),
          } satisfies Operation);
          this.clients.registry.store.event(
            "agent.operation.failed",
            client.id,
          );
        }
      });
      throw error;
    }
  }
}
