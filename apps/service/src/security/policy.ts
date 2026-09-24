import { SourcePolicy, type Purpose, type Principal } from "@kb/contracts";
import { WorkspaceRegistry } from "../workspace/registry";
import { authorize } from "../http/auth";
import { AppError } from "../errors";

export class Policy {
  constructor(readonly registry: WorkspaceRegistry) {}
  setSource(
    value: unknown,
    actorId = "policy-admin",
    reason = "source-policy",
  ) {
    const source = SourcePolicy.parse(value);
    this.registry.store.tx(() => {
      const previous = SourcePolicy.safeParse(
        this.registry.store.get(`source:${source.sourceId}`),
      );
      const recorded = this.registry.store.get(`retraction:${source.sourceId}`);
      if (
        !source.retracted &&
        (recorded || (previous.success && previous.data.retracted))
      )
        throw new AppError(
          "FORBIDDEN",
          403,
          "已撤回来源不能通过更新策略重新放行。",
        );
      const w = this.registry.get();
      if (source.retracted && !recorded)
        this.registry.store.set(`retraction:${source.sourceId}`, {
          sourceId: source.sourceId,
          actorId,
          reason,
          at: Date.now(),
          policyVersion: w.policyVersion + 1,
          state: "blocked",
        });
      this.registry.store.set(`source:${source.sourceId}`, source);
      w.policyVersion++;
      this.registry.store.set("workspace", w);
      this.registry.store.event("source.policy.changed", w.id);
      if (source.retracted)
        this.registry.store.event("source.retracted", source.sourceId);
    });
  }
  allow(
    principal: Principal,
    version: number,
    purpose: Purpose,
    routeId: string,
    sourceIds: string[],
  ) {
    authorize(this.registry, principal, ["admin", "user"], version, true);
    if (
      purpose !== "read" &&
      this.registry.store.get("recovery:paid") === "review-required"
    )
      throw new AppError("FORBIDDEN", 403, "恢复后外部路线尚未重新开放。");
    const session = this.registry.store.db
      .prepare(
        "SELECT 1 FROM sessions WHERE json_extract(principal,'$.id')=? AND revoked=0",
      )
      .get(principal.id);
    if (!session) throw new AppError("AUTH", 401);
    const seen = this.registry.store.get(`heartbeat:${principal.id}`);
    if (typeof seen !== "number" || Date.now() - seen >= 45_000)
      throw new AppError("AUTH", 401);
    const route = this.registry
      .settings()
      .routes.find(
        (r) => r.id === routeId && r.purpose === purpose && r.enabled,
      );
    if (!route || !sourceIds.length) throw new AppError("FORBIDDEN", 403);
    for (const id of new Set(sourceIds)) {
      const source = SourcePolicy.safeParse(
        this.registry.store.get(`source:${id}`),
      );
      if (
        !source.success ||
        source.data.retracted ||
        !source.data.routes[purpose].includes(routeId)
      )
        throw new AppError("FORBIDDEN", 403);
    }
    return route;
  }
}
