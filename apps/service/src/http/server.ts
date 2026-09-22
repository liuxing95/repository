import { researchRoutes } from "../research/routes";
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

export function createServer(
  registry: WorkspaceRegistry,
  sessions: Sessions,
  jobs: Jobs,
  port = 27124,
  answerProviders?: ReadonlyMap<string, AnswerProvider>,
  researchProviders?: ReadonlyMap<string, ResearchProvider>,
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
    mutate(req, ["admin"], false, () => {
      new Policy(registry).setSource(SourcePolicy.parse(req.body));
      return { policyVersion: registry.get().policyVersion };
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
  return app;
}
