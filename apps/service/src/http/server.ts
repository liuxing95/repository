import { taskRoutes } from "../tasks/routes";
import { planningRoutes } from "../planning/routes";
import type { BusyProvider } from "../calendar/freebusy";
import { Reconciliation } from "../tasks/reconcile";
import { TaskLearningAdapter } from "../tasks/learning-adapter";
import { Proposals } from "../review/proposals";
import { researchRoutes } from "../research/routes";
import { learningRoutes } from "../learning/routes";
import type { LearningTaskAdapter } from "../learning/capacity";
import type { ResearchProvider } from "../research/chapters";
import { reviewRoutes } from "../review/routes";
import { searchRoutes } from "../search/routes";
import { EvidenceStore } from "../evidence/locator";
import type { AnswerProvider } from "../answers/answer";
import { Ingestion } from "../ingestion/manifest";
import { ingestionRoutes } from "../ingestion/routes";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import { Id, SourcePolicy, type Principal, type Role } from "@kb/contracts";
import { WorkspaceRegistry, digest } from "../workspace/registry";
import { Sessions, authorize, bearer, localBoundary } from "./auth";
import { AppError, problem } from "../errors";
import { Jobs } from "../runtime/jobs";
import { diagnostics } from "../runtime/diagnostics";
import { Policy } from "../security/policy";
import { ReminderRules } from "../reminders/rules";
import { Retraction } from "../lifecycle/retraction";
import { AgentClients } from "../agents/clients";
import { AgentOperations } from "../agents/operations";

export function createServer(
  registry: WorkspaceRegistry,
  sessions: Sessions,
  jobs: Jobs,
  port = 27124,
  answerProviders?: ReadonlyMap<string, AnswerProvider>,
  researchProviders?: ReadonlyMap<string, ResearchProvider>,
  learningTaskAdapter?: LearningTaskAdapter,
  busyProvider?: BusyProvider,
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 32_768,
    requestTimeout: 10_000,
    connectionTimeout: 10_000,
  });
  let pairAttempts = { count: 0, start: Date.now() };
  app.addHook("onRequest", async (req, reply) => {
    localBoundary(req, port);
    reply.header("cache-control", "no-store");
    if (req.url === "/v1/pair") {
      if (Date.now() - pairAttempts.start > 60_000)
        pairAttempts = { count: 0, start: Date.now() };
      if (++pairAttempts.count > 10) throw new AppError("RATE_LIMIT", 429);
    }
  });
  app.setErrorHandler((error, _req, reply) => {
    const invalid =
      error instanceof z.ZodError ||
      (typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        error.statusCode === 400);
    const safe =
      error instanceof AppError
        ? error
        : new AppError(
            invalid ? "VALIDATION" : "INTERNAL",
            invalid ? 400 : 500,
          );
    reply.code(safe.status).send(problem(safe));
  });
  app.setNotFoundHandler(() => {
    throw new AppError("NOT_FOUND", 404);
  });
  const version = (req: FastifyRequest) => {
    const n = Number(req.headers["x-policy-version"]);
    if (!Number.isSafeInteger(n) || n < 1) throw new AppError("BASELINE");
    return n;
  };
  // Persist command result in the same transaction as its local effects. Retrying an
  // acknowledged-lost request returns that result, even after the policy version advanced.
  const mutate = <T>(
    req: FastifyRequest,
    roles: Role[],
    writer: boolean,
    action: (p: Principal) => T,
  ): T => {
    const p = sessions.authenticate(bearer(req));
    authorize(registry, p, roles);
    const operation = Id.safeParse(req.headers["x-operation-key"]);
    if (!operation.success) throw new AppError("VALIDATION", 400);
    const key = `${p.id}:${operation.data}`;
    const inputDigest = digest({
      method: req.method,
      path: req.url,
      body: req.body ?? null,
    });
    return registry.store.tx(() => {
      const old = registry.store.db
        .prepare("SELECT digest,result FROM commands WHERE key=?")
        .get(key) as { digest: string; result: string } | undefined;
      if (old) {
        if (old.digest !== inputDigest) throw new AppError("CONFLICT");
        return JSON.parse(old.result) as T;
      }
      authorize(registry, p, roles, version(req), writer);
      const result = action(p);
      registry.store.db
        .prepare("INSERT INTO commands(key,digest,result) VALUES(?,?,?)")
        .run(key, inputDigest, JSON.stringify(result));
      return result;
    });
  };
  app.post("/v1/pair", async (req) => sessions.pair(req.body));
  app.get("/v1/diagnostics", async (req) => {
    sessions.authenticate(bearer(req), true);
    return diagnostics(registry);
  });
  app.get("/v1/workspace", async (req) => ({
    principal: sessions.authenticate(bearer(req)),
    workspace: registry.get(),
    capabilities: registry.capabilities(),
  }));
  app.post("/v1/session/heartbeat", async (req) =>
    sessions.heartbeat(bearer(req)),
  );
  app.post("/v1/session/refresh", async (req) => ({
    principal: sessions.refresh(bearer(req)),
  }));
  app.post("/v1/session/revoke", async (req) => {
    sessions.authenticate(bearer(req));
    sessions.revoke(bearer(req));
    return { revoked: true };
  });
  app.get("/v1/settings", async (req) => {
    authorize(registry, sessions.authenticate(bearer(req)), [
      "admin",
      "user",
      "reader",
    ]);
    return registry.settings();
  });
  app.put("/v1/settings", async (req) =>
    mutate(req, ["admin"], false, () => ({
      workspace: registry.saveSettings(req.body, version(req)),
    })),
  );
  app.put("/v1/source-policy", async (req) =>
    mutate(req, ["admin"], false, (p) => {
      new Policy(registry).setSource(SourcePolicy.parse(req.body), p.id);
      return { policyVersion: registry.get().policyVersion };
    }),
  );
  app.post("/v1/sources/:id/retract", (req) =>
    mutate(req, ["admin"], false, (p) => {
      const { id } = z.object({ id: Id }).parse(req.params);
      const { reason } = z
        .object({ reason: z.string().trim().min(1).max(500) })
        .strict()
        .parse(req.body);
      return new Retraction(registry).retract(id, p.id, reason);
    }),
  );
  app.get("/v1/sources/:id/retraction-impact", (req) => {
    authorize(registry, sessions.authenticate(bearer(req)), [
      "admin",
      "user",
      "reader",
    ]);
    const { id } = z.object({ id: Id }).parse(req.params);
    return new Retraction(registry).impact(id);
  });
  app.get("/v1/recovery/paid-gate", (req) => {
    authorize(registry, sessions.authenticate(bearer(req)), ["admin"]);
    return {
      state: registry.store.get("recovery:paid") ?? "not-restored",
      unknownCalls: (
        registry.store.db
          .prepare(
            "SELECT COUNT(*) n FROM calls WHERE state IN ('reserved','dispatched','unknown')",
          )
          .get() as { n: number }
      ).n,
    };
  });
  app.post("/v1/recovery/paid-gate/reopen", (req) =>
    mutate(req, ["admin"], false, () => {
      const input = z
        .object({
          reviewedUnknownCalls: z.number().int().nonnegative(),
          confirm: z.literal(true),
        })
        .strict()
        .parse(req.body);
      if (registry.store.get("recovery:paid") !== "review-required")
        throw new AppError("CONFLICT");
      const count = (
        registry.store.db
          .prepare(
            "SELECT COUNT(*) n FROM calls WHERE state IN ('reserved','dispatched','unknown')",
          )
          .get() as { n: number }
      ).n;
      if (count !== input.reviewedUnknownCalls)
        throw new AppError("BASELINE", 409, "未知费用条数已变化，请重新核对。");
      registry.store.set("recovery:paid", "open");
      registry.store.event("recovery.paid-gate-opened", registry.get().id);
      return { state: "open", reviewedUnknownCalls: count };
    }),
  );
  app.post("/v1/master/claim", async (req) =>
    mutate(req, ["admin"], false, (p) => {
      const { epoch } = z
        .object({ epoch: z.number().int().nonnegative() })
        .strict()
        .parse(req.body);
      const workspace = registry.claimMaster(p.deviceId, epoch);
      sessions.refresh(bearer(req));
      return { workspace };
    }),
  );
  app.post("/v1/master/release", async (req) =>
    mutate(req, ["admin"], false, (p) => {
      const workspace = registry.releaseMaster(p);
      sessions.refresh(bearer(req));
      return { workspace };
    }),
  );
  const agentClients = new AgentClients(registry);
  const agentOperations = new AgentOperations(agentClients, answerProviders);
  app.get("/v1/agents/clients", (req) => {
    authorize(registry, sessions.authenticate(bearer(req)), ["admin"]);
    return agentClients.list();
  });
  app.post("/v1/agents/clients", (req) => {
    const actor = sessions.authenticate(bearer(req));
    authorize(registry, actor, ["admin"], version(req), true);
    const operationKey = Id.parse(req.headers["x-operation-key"]);
    return agentClients.create(req.body, actor, operationKey);
  });
  app.post("/v1/agents/clients/:id/revoke", (req) =>
    mutate(req, ["admin"], true, () => {
      const { id } = z.object({ id: Id }).parse(req.params);
      return agentClients.revoke(id);
    }),
  );
  app.post("/v1/agents/invoke", (req) => {
    const id = Id.parse(req.headers["x-agent-id"]);
    return agentOperations.invoke(id, bearer(req), req.body);
  });
  app.get("/v1/jobs", async (req) => {
    sessions.authenticate(bearer(req));
    return jobs.list();
  });
  app.post("/v1/jobs", async (req) =>
    mutate(req, ["admin", "user"], true, () => {
      z.object({ kind: z.literal("diagnostic-check") }).parse(req.body);
      return jobs.enqueue(req.body, registry.settings().budget?.jobLimit ?? 0);
    }),
  );
  app.post("/v1/jobs/:id/cancel", async (req) =>
    mutate(req, ["admin", "user"], true, () => {
      const { id } = z.object({ id: Id }).parse(req.params);
      return jobs.cancel(id);
    }),
  );
  ingestionRoutes(app, new Ingestion(registry, jobs), sessions, mutate);
  searchRoutes(app, new EvidenceStore(registry), sessions, answerProviders);
  reviewRoutes(app, new EvidenceStore(registry), sessions);
  researchRoutes(app, new EvidenceStore(registry), sessions, researchProviders);
  const taskDb = new Reconciliation(new Proposals(new EvidenceStore(registry)));
  taskRoutes(app, taskDb, sessions);
  planningRoutes(app, taskDb, sessions, busyProvider);
  const reminders = new ReminderRules(registry.store);
  const reminderReader = (req: FastifyRequest) => {
    const p = sessions.authenticate(bearer(req));
    authorize(registry, p, ["admin", "user", "reader"]);
    return p;
  };
  app.get("/v1/reminders", (req) => {
    const p = reminderReader(req);
    const reviewed = registry.store.db
      .prepare("SELECT delivery_key FROM reminder_reviews WHERE owner_id=?")
      .all(p.deviceId) as { delivery_key: string }[];
    return {
      rules: reminders.list(p.deviceId),
      occurrences: reminders.occurrences(p.deviceId),
      reviewedUnknownKeys: reviewed.map((r) => r.delivery_key),
      pausedToday: reminders.pausedToday(p.deviceId),
      paused: registry.store.reminderPaused,
      executor: "本机服务运行且 macOS 通知可用时执行；电脑关机不会提醒",
    };
  });
  app.post("/v1/reminders/rules", (req) =>
    mutate(req, ["admin", "user"], true, (p) => {
      if (process.platform !== "darwin")
        throw new AppError("VALIDATION", 400, "本机通知目前只支持 macOS。");
      return reminders.register(p.deviceId, req.body);
    }),
  );
  app.post("/v1/reminders/rules/:id/disable", (req) =>
    mutate(req, ["admin", "user"], true, (p) =>
      reminders.disable(
        p.deviceId,
        Id.parse(z.object({ id: Id }).parse(req.params).id),
      ),
    ),
  );
  app.post("/v1/reminders/:key/snooze", (req) =>
    mutate(req, ["admin", "user"], true, (p) => {
      const { key } = z
        .object({ key: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(req.params);
      const { until } = z
        .object({ until: z.number().int().positive() })
        .strict()
        .parse(req.body);
      return reminders.snooze(p.deviceId, key, until);
    }),
  );
  app.post("/v1/reminders/:key/review-unknown", (req) =>
    mutate(req, ["admin", "user"], true, (p) => {
      const { key } = z
        .object({ key: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(req.params);
      return reminders.reviewUnknown(p.deviceId, key);
    }),
  );
  app.post("/v1/reminders/pause-today", (req) =>
    mutate(req, ["admin", "user"], true, (p) => {
      const { day, timezone } = z
        .object({ day: z.string(), timezone: z.string() })
        .strict()
        .parse(req.body);
      return reminders.pauseToday(p.deviceId, day, timezone);
    }),
  );
  learningRoutes(
    app,
    new EvidenceStore(registry),
    sessions,
    learningTaskAdapter ?? new TaskLearningAdapter(taskDb),
  );
  return app;
}
