import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  AgentCreateInput,
  Id,
  type AgentReceiver,
  type Principal,
} from "@kb/contracts";
import { z } from "zod";
import { AppError } from "../errors";
import { EvidenceStore } from "../evidence/locator";
import { Policy } from "../security/policy";
import { WorkspaceRegistry, digest } from "../workspace/registry";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export type AgentClient = {
  id: string;
  name: string;
  sourceIds: string[];
  receiver: AgentReceiver;
  vaultId: string;
  epoch: number;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  secretHash: string;
  sessionHash: string;
  principalId: string;
};
export type PublicAgentClient = Omit<
  AgentClient,
  "secretHash" | "sessionHash" | "principalId"
>;

export class AgentClients {
  readonly evidence: EvidenceStore;
  readonly policy: Policy;
  constructor(readonly registry: WorkspaceRegistry) {
    this.evidence = new EvidenceStore(registry);
    this.policy = new Policy(registry);
  }
  private public(client: AgentClient): PublicAgentClient {
    return {
      id: client.id,
      name: client.name,
      sourceIds: client.sourceIds,
      receiver: client.receiver,
      vaultId: client.vaultId,
      epoch: client.epoch,
      createdBy: client.createdBy,
      createdAt: client.createdAt,
      expiresAt: client.expiresAt,
      revokedAt: client.revokedAt,
    };
  }
  private record(id: string): AgentClient {
    const record = this.registry.store.get(`agent-client:${Id.parse(id)}`);
    if (!record) throw new AppError("AUTH", 401);
    return record as AgentClient;
  }
  private checkSources(
    client: AgentClient,
    principal: Principal,
    sourceIds: readonly string[],
  ) {
    if (
      !sourceIds.length ||
      sourceIds.some((id) => !client.sourceIds.includes(id))
    )
      throw new AppError("FORBIDDEN", 403);
    for (const id of sourceIds) {
      const committed = this.registry.store.db
        .prepare(
          "SELECT 1 FROM source_revisions WHERE source_id=? AND committed=1 LIMIT 1",
        )
        .get(id);
      if (!committed || !this.evidence.readable(id))
        throw new AppError("FORBIDDEN", 403);
    }
    if (client.receiver.kind === "model")
      this.policy.allow(
        principal,
        this.registry.get().policyVersion,
        "model",
        client.receiver.routeId,
        [...sourceIds],
      );
  }
  create(value: unknown, actor: Principal, operationKey: string) {
    const input = AgentCreateInput.parse(value);
    const key = Id.parse(operationKey);
    const requestDigest = digest(input);
    return this.registry.store.tx(() => {
      const old = this.registry.store.get(`agent-create:${actor.id}:${key}`) as
        { digest: string; clientId: string } | undefined;
      if (old) {
        if (old.digest !== requestDigest) throw new AppError("CONFLICT");
        return { client: this.public(this.record(old.clientId)), secret: null };
      }
      const w = this.registry.get();
      if (actor.deviceId !== w.deviceId || actor.epoch !== w.epoch)
        throw new AppError("MASTER");
      const clientId = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const sessionHash = hash(randomBytes(32).toString("base64url"));
      const now = Date.now();
      const client: AgentClient = {
        id: clientId,
        name: input.name,
        sourceIds: [...new Set(input.sourceIds)],
        receiver: input.receiver,
        vaultId: w.id,
        epoch: w.epoch,
        createdBy: actor.id,
        createdAt: now,
        expiresAt: now + input.expiresInMinutes * 60_000,
        revokedAt: null,
        secretHash: hash(secret),
        sessionHash,
        principalId: randomUUID(),
      };
      const principal: Principal = {
        id: client.principalId,
        role: "user",
        vaultId: w.id,
        deviceId: w.deviceId!,
        epoch: w.epoch,
        policyVersion: w.policyVersion,
        expiresAt: client.expiresAt,
      };
      this.registry.store.db
        .prepare("INSERT INTO sessions(hash,principal) VALUES (?,?)")
        .run(sessionHash, JSON.stringify(principal));
      this.registry.store.set(`heartbeat:${principal.id}`, now);
      this.checkSources(client, principal, client.sourceIds);
      this.registry.store.set(`agent-client:${client.id}`, client);
      this.registry.store.set(`agent-create:${actor.id}:${key}`, {
        digest: requestDigest,
        clientId,
      });
      this.registry.store.event("agent.client.created", client.id);
      return { client: this.public(client), secret };
    });
  }
  list(): PublicAgentClient[] {
    return (
      this.registry.store.db
        .prepare(
          "SELECT value FROM kv WHERE key LIKE 'agent-client:%' ORDER BY key",
        )
        .all() as { value: string }[]
    ).map((row) => this.public(JSON.parse(row.value) as AgentClient));
  }
  revoke(id: string) {
    return this.registry.store.tx(() => {
      const client = this.record(id);
      if (!client.revokedAt) {
        client.revokedAt = Date.now();
        this.registry.store.set(`agent-client:${client.id}`, client);
        this.registry.store.db
          .prepare("UPDATE sessions SET revoked=1 WHERE hash=?")
          .run(client.sessionHash);
        this.registry.store.event("agent.client.revoked", client.id);
      }
      return this.public(client);
    });
  }
  authenticate(id: string, secret: string) {
    const client = this.record(id);
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new AppError("AUTH", 401);
    const candidate = hash(secret);
    if (
      !timingSafeEqual(Buffer.from(candidate), Buffer.from(client.secretHash))
    )
      throw new AppError("AUTH", 401);
    const w = this.registry.get();
    if (
      client.revokedAt ||
      client.expiresAt <= Date.now() ||
      client.vaultId !== w.id ||
      client.epoch !== w.epoch
    )
      throw new AppError("AUTH", 401);
    const row = this.registry.store.db
      .prepare("SELECT principal,revoked FROM sessions WHERE hash=?")
      .get(client.sessionHash) as
      { principal: string; revoked: number } | undefined;
    if (!row || row.revoked) throw new AppError("AUTH", 401);
    const principal = JSON.parse(row.principal) as Principal;
    this.registry.store.set(`heartbeat:${principal.id}`, Date.now());
    return { client, principal };
  }
  authorizeScope(
    client: AgentClient,
    principal: Principal,
    requested?: string[],
  ) {
    const sourceIds = requested
      ? [...new Set(z.array(Id).parse(requested))]
      : client.sourceIds;
    this.checkSources(client, principal, sourceIds);
    return sourceIds;
  }
  authorizeEvidence(
    client: AgentClient,
    principal: Principal,
    evidenceId: string,
  ) {
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return this.evidence.read(id);
      if (visited.size >= 100) throw new AppError("FORBIDDEN", 403);
      visited.add(id);
      const read = this.evidence.read(id);
      this.authorizeScope(client, principal, [read.sourceId]);
      for (const originalId of read.profile.originalEvidence) visit(originalId);
      return read;
    };
    return visit(evidenceId);
  }
}
