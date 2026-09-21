import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyRequest } from "fastify";
import { PairInput, type Principal, type Role } from "@kb/contracts";
import { WorkspaceRegistry } from "../workspace/registry";
import { AppError } from "../errors";
import { trustedDirectory } from "../security/paths";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class Sessions {
  private challenge?: { hash: string; expires: number; role: Role };
  constructor(
    readonly registry: WorkspaceRegistry,
    readonly now = Date.now,
  ) {}
  issuePairing(role: Role = "admin") {
    this.registry.store.writable();
    const code = randomBytes(32).toString("base64url");
    this.challenge = { hash: hash(code), expires: this.now() + 300_000, role };
    return code;
  }
  async pair(input: unknown) {
    const parsed = PairInput.safeParse(input);
    if (!parsed.success) throw new AppError("VALIDATION", 400);
    const c = this.challenge;
    const data = parsed.data;
    if (
      !c ||
      c.expires < this.now() ||
      !timingSafeEqual(Buffer.from(c.hash), Buffer.from(hash(data.code)))
    )
      throw new AppError("AUTH", 401);
    const w = this.registry.get();
    if ((await trustedDirectory(data.vaultPath)) !== w.vaultPath)
      throw new AppError("FORBIDDEN", 403);
    // Recheck after the filesystem await: a pairing code is single use even under concurrency.
    if (this.challenge !== c) throw new AppError("AUTH", 401);
    this.challenge = undefined;
    const principal: Principal = {
      id: randomUUID(),
      role: c.role,
      vaultId: w.id,
      deviceId: data.deviceId,
      epoch: w.epoch,
      policyVersion: w.policyVersion,
      expiresAt: this.now() + 3_600_000,
    };
    const token = randomBytes(32).toString("base64url");
    this.registry.store.db
      .prepare("INSERT INTO sessions(hash,principal) VALUES (?,?)")
      .run(hash(token), JSON.stringify(principal));
    this.registry.store.set(`heartbeat:${principal.id}`, this.now());
    return { token, principal };
  }
  authenticate(token: string, diagnostic = false): Principal {
    if (!/^[\w-]{43}$/.test(token)) throw new AppError("AUTH", 401);
    const row = this.registry.store.db
      .prepare("SELECT principal,revoked FROM sessions WHERE hash=?")
      .get(hash(token)) as { principal: string; revoked: number } | undefined;
    if (!row || row.revoked) throw new AppError("AUTH", 401);
    const p = JSON.parse(row.principal) as Principal;
    if (
      p.expiresAt <= this.now() ||
      (!diagnostic && p.vaultId !== this.registry.get().id)
    )
      throw new AppError("AUTH", 401);
    return p;
  }
  refresh(token: string) {
    this.registry.store.writable();
    const p = this.authenticate(token);
    const w = this.registry.get();
    p.epoch = w.epoch;
    p.policyVersion = w.policyVersion;
    this.registry.store.db
      .prepare("UPDATE sessions SET principal=? WHERE hash=?")
      .run(JSON.stringify(p), hash(token));
    this.registry.store.set(`heartbeat:${p.id}`, this.now());
    return p;
  }
  heartbeat(token: string) {
    const p = this.authenticate(token);
    this.registry.store.set(`heartbeat:${p.id}`, this.now());
    return { connected: true };
  }
  hasMasterSession() {
    try {
      if (this.registry.store.readOnly) return false;
      const w = this.registry.get();
      this.registry.settings();
      return (
        !!w.deviceId &&
        (
          this.registry.store.db
            .prepare("SELECT principal FROM sessions WHERE revoked=0")
            .all() as { principal: string }[]
        ).some((row) => {
          const p = JSON.parse(row.principal) as Principal;
          const seen = this.registry.store.get(`heartbeat:${p.id}`);
          return (
            p.deviceId === w.deviceId &&
            p.epoch === w.epoch &&
            p.policyVersion === w.policyVersion &&
            p.expiresAt > this.now() &&
            typeof seen === "number" &&
            this.now() - seen < 45_000 &&
            ["admin", "user"].includes(p.role)
          );
        })
      );
    } catch {
      return false;
    }
  }
  revoke(token: string) {
    this.registry.store.writable();
    this.registry.store.db
      .prepare("UPDATE sessions SET revoked=1 WHERE hash=?")
      .run(hash(token));
  }
}
export function localBoundary(request: FastifyRequest, port: number) {
  if (
    ![`127.0.0.1:${port}`, `localhost:${port}`].includes(
      request.headers.host ?? "",
    )
  )
    throw new AppError("FORBIDDEN", 403);
  const origin = request.headers.origin;
  if (origin && origin !== "app://obsidian.md")
    throw new AppError("FORBIDDEN", 403);
}
export function bearer(request: FastifyRequest) {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) throw new AppError("AUTH", 401);
  return value.slice(7);
}
export function authorize(
  registry: WorkspaceRegistry,
  p: Principal,
  roles: Role[],
  policyVersion?: number,
  writer = false,
) {
  const w = registry.get();
  registry.store.writable();
  if (
    !roles.includes(p.role) ||
    p.vaultId !== w.id ||
    p.expiresAt <= Date.now()
  )
    throw new AppError("FORBIDDEN", 403);
  if (policyVersion !== undefined && policyVersion !== w.policyVersion)
    throw new AppError("BASELINE");
  if (writer && (p.deviceId !== w.deviceId || p.epoch !== w.epoch))
    throw new AppError("MASTER");
  if (writer) {
    const seen = registry.store.get(`heartbeat:${p.id}`);
    if (typeof seen !== "number" || Date.now() - seen >= 45_000)
      throw new AppError("AUTH", 401);
  }
}
