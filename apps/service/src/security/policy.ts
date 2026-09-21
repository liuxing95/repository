import { SourcePolicy, type Purpose, type Principal } from "@kb/contracts";
import { WorkspaceRegistry } from "../workspace/registry";
import { authorize } from "../http/auth";
import { AppError } from "../errors";

export class Policy {
  constructor(readonly registry: WorkspaceRegistry) {}
  setSource(value: unknown) {
    const source = SourcePolicy.parse(value);
    this.registry.store.tx(() => {
      this.registry.store.set(`source:${source.sourceId}`, source);
      const w = this.registry.get();
      w.policyVersion++;
      this.registry.store.set("workspace", w);
      this.registry.store.event("source.policy.changed", w.id);
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
