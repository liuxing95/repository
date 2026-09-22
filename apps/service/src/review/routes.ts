import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../errors";
import { Id } from "@kb/contracts";
import { Sessions, authorize, bearer } from "../http/auth";
import { EvidenceStore } from "../evidence/locator";
import { Proposals } from "./proposals";
import { Approvals } from "./approval";
import { WriterSession } from "./writer-session";
import { WikiCommit } from "./commit";
import { reverse } from "./reverse";
import { recoverySummary } from "./recovery";
import { compilerStatus } from "../wiki/compiler-adapter";
import { observe } from "../wiki/observations";
import { impact, readPage, searchPages } from "../wiki/impact";
export function reviewRoutes(
  app: FastifyInstance,
  evidence: EvidenceStore,
  sessions: Sessions,
) {
  const proposals = new Proposals(evidence),
    approvals = new Approvals(proposals),
    writer = new WriterSession(proposals),
    commit = new WikiCommit(proposals);
  const principal = (req: FastifyRequest, write = false) => {
    const p = sessions.authenticate(bearer(req));
    authorize(
      evidence.registry,
      p,
      write ? ["admin", "user"] : ["admin", "user", "reader"],
      write
        ? z.coerce
            .number()
            .int()
            .positive()
            .parse(req.headers["x-policy-version"])
        : undefined,
      write,
    );
    return p;
  };
  const id = (req: FastifyRequest) => z.object({ id: Id }).parse(req.params).id;
  app.get("/v1/wiki/compiler", (req) => {
    principal(req);
    return compilerStatus();
  });
  app.get("/v1/wiki/candidates", (req) =>
    proposals.candidates.list(principal(req)),
  );
  app.get("/v1/wiki/changes", (req) => proposals.list(principal(req)));
  app.post("/v1/wiki/changes", (req) =>
    proposals.prepare(req.body, principal(req, true)),
  );
  app.get("/v1/wiki/changes/:id", (req) => {
    const c = proposals.read(id(req), principal(req));
    return { ...c, recovery: recoverySummary(c) };
  });
  app.post("/v1/wiki/changes/:id/approve", (req) => {
    const v = z
      .object({ digest: z.string().length(64) })
      .strict()
      .parse(req.body);
    return approvals.approve(id(req), v.digest, principal(req, true));
  });
  app.post("/v1/wiki/changes/:id/reject", (req) => {
    const v = z
      .object({
        digest: z.string().length(64),
        reason: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(req.body);
    return approvals.reject(id(req), v.digest, v.reason, principal(req, true));
  });
  app.post("/v1/wiki/changes/:id/grant", (req) =>
    writer.grant(
      id(req),
      z
        .object({ sequence: z.number().int().nonnegative() })
        .strict()
        .parse(req.body).sequence,
      principal(req, true),
    ),
  );
  app.post("/v1/wiki/changes/:id/validate", (req) => {
    const { token } = z
      .object({ token: z.string().length(43) })
      .strict()
      .parse(req.body);
    const result = writer.validate(token, principal(req, true));
    if (result.change.id !== id(req)) throw new AppError("FORBIDDEN", 403);
    return { valid: true };
  });
  app.post("/v1/wiki/changes/:id/receipt", (req) => {
    const v = z
      .object({
        token: z.string().length(43),
        afterHash: z.string().length(64),
      })
      .strict()
      .parse(req.body);
    const p = principal(req, true);
    if (writer.validate(v.token, p).change.id !== id(req))
      throw new AppError("FORBIDDEN", 403);
    return writer.receipt(v.token, v.afterHash, p);
  });
  app.post("/v1/wiki/changes/:id/finish", (req) =>
    commit.finish(
      id(req),
      z
        .object({ hashes: z.array(z.string().length(64)).max(20) })
        .strict()
        .parse(req.body).hashes,
      principal(req, true),
    ),
  );
  app.post("/v1/wiki/changes/:id/reverse", (req) =>
    reverse(
      proposals,
      id(req),
      z.object({ operationId: Id }).strict().parse(req.body).operationId,
      principal(req, true),
    ),
  );
  app.get("/v1/wiki/pages", (req) => {
    const p = principal(req);
    return (
      proposals.store.db
        .prepare("SELECT revision_id FROM wiki_pages ORDER BY id LIMIT 1000")
        .all() as { revision_id: string }[]
    ).flatMap((row) => {
      try {
        return [readPage(proposals, row.revision_id, p)];
      } catch {
        return [];
      }
    });
  });
  app.get("/v1/wiki/pages/:id", (req) =>
    readPage(proposals, id(req), principal(req)),
  );
  app.post("/v1/wiki/search", (req) =>
    searchPages(
      proposals,
      z
        .object({ query: z.string().trim().min(1).max(500) })
        .strict()
        .parse(req.body).query,
      principal(req),
    ),
  );
  app.post("/v1/wiki/observations", { bodyLimit: 600000 }, (req) =>
    observe(proposals, req.body, principal(req, true)),
  );
  app.get("/v1/wiki/impact", (req) =>
    impact(
      proposals,
      principal(req),
      z
        .object({
          offset: z.coerce.number().int().nonnegative().max(1000000).default(0),
        })
        .parse(req.query).offset,
    ),
  );
}
