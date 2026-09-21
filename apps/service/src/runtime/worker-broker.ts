import { randomBytes } from "node:crypto";
import type { Principal, Purpose } from "@kb/contracts";
import { Policy } from "../security/policy";
import { Budget } from "./budget";
import { Jobs } from "./jobs";
import { AppError } from "../errors";

type Grant = {
  principal: Principal;
  version: number;
  jobId: string;
  fence: number;
  purpose: Purpose;
  routeId: string;
  sourceIds: string[];
  expires: number;
};
type Provider = (input: {
  maxOutputTokens: number;
  signal: AbortSignal;
  idempotencyKey: string;
}) => Promise<{ requestId: string; cost: number; value: unknown }>;
export class WorkerBroker {
  private grants = new Map<string, Grant>();
  // Providers are installed by trusted service code, never by a route in a note or request body.
  constructor(
    readonly policy: Policy,
    readonly budget: Budget,
    readonly jobs: Jobs,
    private providers: ReadonlyMap<string, Provider> = new Map(),
  ) {}
  grant(input: Omit<Grant, "expires">) {
    for (const [token, grant] of this.grants)
      if (grant.expires <= Date.now()) this.grants.delete(token);
    this.policy.allow(
      input.principal,
      input.version,
      input.purpose,
      input.routeId,
      input.sourceIds,
    );
    this.jobs.active(input.jobId, input.fence);
    if (!this.providers.has(input.routeId))
      throw new AppError("UNAVAILABLE", 503);
    const token = randomBytes(32).toString("base64url");
    this.grants.set(token, {
      ...input,
      expires: Math.min(input.principal.expiresAt, Date.now() + 60_000),
    });
    return token;
  }
  async call(
    token: string,
    operationKey: string,
    inputTokens: number,
    signal = AbortSignal.timeout(30_000),
  ) {
    const grant = this.grants.get(token);
    if (!grant || grant.expires <= Date.now()) throw new AppError("AUTH", 401);
    const route = this.policy.allow(
      grant.principal,
      grant.version,
      grant.purpose,
      grant.routeId,
      grant.sourceIds,
    );
    this.jobs.active(grant.jobId, grant.fence);
    const provider = this.providers.get(grant.routeId);
    if (!provider || !route.price) throw new AppError("UNAVAILABLE", 503);
    if (signal.aborted) throw new AppError("CANCELLED");
    const call = this.budget.reserve({
      operationKey,
      jobId: grant.jobId,
      fence: grant.fence,
      routeId: grant.routeId,
      inputTokens,
    });
    // A dispatched/unknown/settled operation is never transparently retried.
    this.budget.dispatch(call.id, grant.fence);
    let abortHandler: (() => void) | undefined;
    try {
      const pending = provider({
        maxOutputTokens: route.price.maxOutputTokens,
        signal,
        idempotencyKey: call.id,
      }).then((result) => {
        this.budget.settle(call.id, result.requestId, result.cost);
        // Account for the real bill, but refuse stale/cancelled output.
        this.jobs.active(grant.jobId, grant.fence);
        this.policy.allow(
          grant.principal,
          grant.version,
          grant.purpose,
          grant.routeId,
          grant.sourceIds,
        );
        return result.value;
      });
      const aborted = new Promise<never>((_resolve, reject) => {
        abortHandler = () =>
          reject(
            new AppError(
              "UNKNOWN_COST",
              504,
              "调用结果尚不明确，请保留预占并核对提供方回执。",
            ),
          );
        signal.addEventListener("abort", abortHandler, { once: true });
        if (signal.aborted) abortHandler();
      });
      return await Promise.race([pending, aborted]);
    } catch (error) {
      this.budget.unknown(call.id);
      throw error;
    } finally {
      if (abortHandler) signal.removeEventListener("abort", abortHandler);
    }
  }
  revokeAll() {
    this.grants.clear();
  }
}
