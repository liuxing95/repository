import { randomUUID } from "node:crypto";
import { Money, type Price } from "@kb/contracts";
import { WorkspaceRegistry, digest } from "../workspace/registry";
import { Jobs } from "./jobs";
import { AppError } from "../errors";

type Call = {
  id: string;
  operation_key: string;
  digest: string;
  root_id: string;
  job_id: string;
  route: string;
  price_version: string;
  day: string;
  month: string;
  reserved: number;
  actual: number | null;
  state: "reserved" | "dispatched" | "unknown" | "settled" | "released";
  provider_id: string | null;
};
export function estimate(price: Price, inputTokens: number) {
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    inputTokens > price.maxInputTokens
  )
    throw new AppError("BUDGET");
  const total =
    (BigInt(inputTokens) * BigInt(price.inputPerMillion) +
      BigInt(price.maxOutputTokens) * BigInt(price.outputPerMillion) +
      999_999n) /
      1_000_000n +
    BigInt(price.fixedCost);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError("BUDGET");
  return Number(total);
}
export function windows(at: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (key: string) => parts.find((p) => p.type === key)!.value;
  const month = `${part("year")}-${part("month")}`;
  return { day: `${month}-${part("day")}`, month };
}
export class Budget {
  constructor(
    readonly registry: WorkspaceRegistry,
    readonly jobs: Jobs,
    readonly now = Date.now,
  ) {}
  get(id: string) {
    const r = this.registry.store.db
      .prepare("SELECT * FROM calls WHERE id=?")
      .get(id) as Call | undefined;
    if (!r) throw new AppError("NOT_FOUND", 404);
    return r;
  }
  reserve(input: {
    operationKey: string;
    jobId: string;
    fence: number;
    routeId: string;
    inputTokens: number;
  }) {
    const store = this.registry.store;
    return store.tx(() => {
      if (store.get("recovery:paid") === "review-required")
        throw new AppError(
          "FORBIDDEN",
          403,
          "恢复后须先核对未知费用并重新开放外部调用。",
        );
      const job = this.jobs.active(input.jobId, input.fence);
      if (store.get(`budgetStopped:${job.rootId}`))
        throw new AppError("BUDGET");
      const inputDigest = digest({
        jobId: input.jobId,
        routeId: input.routeId,
        inputTokens: input.inputTokens,
      });
      const existing = store.db
        .prepare("SELECT * FROM calls WHERE operation_key=?")
        .get(input.operationKey) as Call | undefined;
      if (existing) {
        if (existing.digest !== inputDigest) throw new AppError("CONFLICT");
        return existing;
      }
      const settings = this.registry.settings();
      const config = settings.budget;
      const route = settings.routes.find(
        (r) => r.id === input.routeId && r.enabled,
      );
      if (!config || !route?.price || route.price.expiresAt <= this.now())
        throw new AppError("BUDGET");
      const amount = estimate(route.price, input.inputTokens);
      const window = windows(this.now(), config.timezone);
      const root = store.db
        .prepare("SELECT limit_amount FROM roots WHERE id=?")
        .get(job.rootId) as { limit_amount: number };
      const used = (column: "root_id" | "day" | "month", value: string) =>
        (
          store.db
            .prepare(
              `SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) n FROM calls WHERE ${column}=? AND state!='released'`,
            )
            .get(value) as { n: number }
        ).n;
      if (
        used("root_id", job.rootId) + amount >
          Math.min(root.limit_amount, config.jobLimit) ||
        used("day", window.day) + amount > config.dayLimit ||
        used("month", window.month) + amount > config.monthLimit
      )
        throw new AppError("BUDGET");
      const id = randomUUID();
      store.db
        .prepare(
          "INSERT INTO calls(id,operation_key,digest,root_id,job_id,route,price_version,day,month,reserved,state) VALUES(?,?,?,?,?,?,?,?,?,?,'reserved')",
        )
        .run(
          id,
          input.operationKey,
          inputDigest,
          job.rootId,
          job.id,
          route.id,
          route.price.version,
          window.day,
          window.month,
          amount,
        );
      store.event("cost.reserved", id);
      return this.get(id);
    });
  }
  dispatch(id: string, fence: number) {
    this.registry.store.tx(() => {
      const call = this.get(id);
      this.jobs.active(call.job_id, fence);
      if (call.state !== "reserved") throw new AppError("CALL_ALREADY_SENT");
      this.registry.store.db
        .prepare("UPDATE calls SET state='dispatched' WHERE id=?")
        .run(id);
      this.registry.store.event("cost.dispatched", id);
    });
  }
  unknown(id: string) {
    this.registry.store.writable();
    this.registry.store.db
      .prepare(
        "UPDATE calls SET state='unknown' WHERE id=? AND state='dispatched'",
      )
      .run(id);
  }
  release(id: string) {
    this.registry.store.tx(() => {
      if (this.get(id).state !== "reserved") throw new AppError("UNKNOWN_COST");
      this.registry.store.db
        .prepare("UPDATE calls SET state='released' WHERE id=?")
        .run(id);
    });
  }
  settle(id: string, providerId: string, actual: number) {
    if (
      !Money.safeParse(actual).success ||
      !providerId ||
      providerId.length > 200
    )
      throw new AppError("VALIDATION", 400);
    return this.registry.store.tx(() => {
      const call = this.get(id);
      if (call.state === "settled") {
        if (call.provider_id !== providerId || call.actual !== actual)
          throw new AppError("CONFLICT");
        return call;
      }
      if (!["dispatched", "unknown"].includes(call.state))
        throw new AppError("CONFLICT");
      const duplicate = this.registry.store.db
        .prepare("SELECT id FROM calls WHERE provider_id=?")
        .get(providerId);
      if (duplicate) throw new AppError("CONFLICT");
      this.registry.store.db
        .prepare(
          "UPDATE calls SET state='settled',actual=?,provider_id=? WHERE id=?",
        )
        .run(actual, providerId, id);
      if (actual > call.reserved)
        this.registry.store.set(`budgetStopped:${call.root_id}`, true);
      this.registry.store.event("cost.settled", id);
      return this.get(id);
    });
  }
  recover() {
    this.registry.store.writable();
    this.registry.store.db
      .prepare("UPDATE calls SET state='unknown' WHERE state='dispatched'")
      .run();
  }
}
