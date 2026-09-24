import { getObject } from "./objects";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { Id, type Principal, type Role } from "@kb/contracts";
import { Ingestion } from "./manifest";
import { SourceCommit } from "./commit";
import { Sessions, bearer, authorize } from "../http/auth";
import { AppError } from "../errors";
import { enhancementOptions } from "./enhancement";

type Mutate = <T>(
  req: FastifyRequest,
  roles: Role[],
  writer: boolean,
  action: (p: Principal) => T,
) => T;
export function ingestionRoutes(
  app: FastifyInstance,
  ingestion: Ingestion,
  sessions: Sessions,
  mutate: Mutate,
) {
  const commits = new SourceCommit(ingestion);
  const principal = (req: FastifyRequest, write = false) => {
    const p = sessions.authenticate(bearer(req));
    authorize(
      ingestion.registry,
      p,
      write ? ["admin", "user"] : ["admin", "user", "reader"],
      write ? Number(req.headers["x-policy-version"]) : undefined,
      write,
    );
    return p;
  };
  const id = (req: FastifyRequest) => z.object({ id: Id }).parse(req.params).id;
  let busy = false;
  const asynchronous = async <T>(
    req: FastifyRequest,
    fn: (p: Principal) => Promise<T>,
  ) => {
    const p = principal(req, true);
    if (busy)
      throw new AppError("BUSY", 429, "当前正在准备另一份资料，请稍后重试。");
    busy = true;
    try {
      return await fn(p);
    } finally {
      busy = false;
    }
  };
  app.post("/v1/ingestion/preview", (req) =>
    asynchronous(req, (p) => ingestion.preview(req.body, p)),
  );
  app.get("/v1/ingestion", async (req) => {
    principal(req);
    return ingestion.list();
  });
  app.get("/v1/ingestion/:id", async (req) => {
    principal(req);
    return ingestion.get(id(req));
  });
  app.post("/v1/ingestion/:id/freeze", async (req) =>
    mutate(req, ["admin", "user"], true, (p) => {
      const input = z
        .object({
          digest: z.string().length(64),
          selectedIds: z.array(Id).min(1).max(100),
        })
        .strict()
        .parse(req.body);
      return ingestion.freeze(id(req), input.digest, input.selectedIds, p);
    }),
  );
  app.post("/v1/ingestion/:id/retry", async (req) =>
    mutate(req, ["admin", "user"], true, (p) => ingestion.retry(id(req), p)),
  );
  app.post("/v1/ingestion/:id/cancel", async (req) =>
    mutate(req, ["admin", "user"], true, () => ingestion.cancel(id(req))),
  );
  app.post("/v1/ingestion/:id/reparse", (req) =>
    asynchronous(req, (p) => {
      const input = z
        .object({
          entryId: Id,
          encoding: z.enum(["utf-8", "utf-16le", "utf-16be", "gb18030"]),
          password: z.string().max(200).optional(),
        })
        .strict()
        .parse(req.body);
      // Password is never persisted in commands, manifests, events, or parser arguments.
      return ingestion.reparse(
        id(req),
        input.entryId,
        input.encoding,
        input.password,
        p,
      );
    }),
  );
  app.get("/v1/parses/:id", async (req) => {
    principal(req);
    return commits.parse(id(req));
  });
  app.get("/v1/originals/:id", async (req) => {
    principal(req);
    return { base64: commits.original(id(req)).toString("base64") };
  });
  app.get("/v1/ingestion/:id/original/:entryId", async (req) => {
    principal(req);
    const params = z.object({ id: Id, entryId: Id }).parse(req.params);
    const entry = ingestion
      .get(params.id)
      .entries.find((e) => e.id === params.entryId);
    if (!entry?.objectHash) throw new AppError("NOT_FOUND", 404);
    const bytes = entry.revisionId
      ? commits.original(entry.revisionId)
      : getObject(ingestion.registry.store, entry.objectHash);
    return { base64: bytes.toString("base64") };
  });
  app.get("/v1/sources", async (req) => {
    principal(req);
    return commits.sources();
  });
  app.get("/v1/ingestion-enhancement", async (req) => {
    principal(req);
    return enhancementOptions();
  });
  app.post("/v1/ingestion/:id/prepare", async (req) =>
    mutate(req, ["admin", "user"], true, () => commits.prepare(id(req))),
  );
  app.get("/v1/changes/:id", async (req) => {
    principal(req);
    return commits.get(id(req));
  });
  app.post("/v1/changes/:id/approve", async (req) =>
    mutate(req, ["admin", "user"], true, (p) =>
      commits.approve(
        id(req),
        z
          .object({ digest: z.string().length(64) })
          .strict()
          .parse(req.body).digest,
        p,
      ),
    ),
  );
  // Grants are short-lived; every attempt receives a fresh token rather than a cached expired grant.
  app.post("/v1/changes/:id/grant", async (req) => {
    const p = principal(req, true);
    return commits.grant(
      id(req),
      z
        .object({ sequence: z.number().int().min(0).max(99) })
        .strict()
        .parse(req.body).sequence,
      p,
    );
  });
  app.post("/v1/changes/:id/receipt", async (req) =>
    mutate(req, ["admin", "user"], true, (p) => {
      const input = z
        .object({
          token: z.string().length(43),
          afterHash: z.string().length(64),
        })
        .strict()
        .parse(req.body);
      const result = commits.receipt(input.token, input.afterHash, p);
      if (result.id !== id(req)) throw new AppError("FORBIDDEN", 403);
      return result;
    }),
  );
  app.post("/v1/changes/:id/finish", async (req) =>
    mutate(req, ["admin", "user"], true, (p) =>
      commits.finish(
        id(req),
        z
          .object({ hashes: z.array(z.string().length(64)).max(100) })
          .strict()
          .parse(req.body).hashes,
        p,
      ),
    ),
  );
  let active: { controller: AbortController; done: Promise<void> } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  app.addHook("onReady", async () => {
    if (ingestion.registry.store.readOnly) return;
    timer = setInterval(() => {
      if (active || !sessions.hasMasterSession()) return;
      const job = ingestion.jobs.claim("batch", 30000, "ingestion");
      if (!job) return;
      const controller = new AbortController();
      const heartbeat = setInterval(() => {
        try {
          ingestion.jobs.active(job.id, job.fence);
          if (!sessions.hasMasterSession()) throw new Error("AUTH");
          ingestion.jobs.heartbeat(job.id, job.fence, "parsing");
        } catch {
          controller.abort();
        }
      }, 1000);
      const done = ingestion.run(job, controller.signal).finally(() => {
        clearInterval(heartbeat);
        active = undefined;
      });
      active = { controller, done };
    }, 200);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    if (active) {
      active.controller.abort();
      await active.done;
    }
  });
}
