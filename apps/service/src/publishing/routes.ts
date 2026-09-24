import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { Id, PublicationInput } from "@kb/contracts";
import { Sessions, authorize, bearer } from "../http/auth";
import { EvidenceStore } from "../evidence/locator";
import { Publications } from "./release";

export function publicationRoutes(
  app: FastifyInstance,
  evidence: EvidenceStore,
  sessions: Sessions,
) {
  const publications = new Publications(evidence);
  const principal = (
    req: FastifyRequest,
    role: "read" | "write" | "release" = "read",
  ) => {
    const p = sessions.authenticate(bearer(req));
    const version =
      role === "read"
        ? undefined
        : z.coerce
            .number()
            .int()
            .positive()
            .parse(req.headers["x-policy-version"]);
    authorize(
      evidence.registry,
      p,
      role === "release"
        ? ["admin", "user"]
        : role === "write"
          ? ["admin", "user"]
          : ["admin", "user", "reader"],
      version,
      role !== "read",
    );
    return p;
  };
  const id = (req: FastifyRequest) =>
    Id.parse(z.object({ id: Id }).parse(req.params).id);
  app.post("/v1/publications/inspect", (req) => {
    const p = principal(req, "write");
    const input = z
      .object({ revisionIds: z.array(Id).min(1).max(10) })
      .strict()
      .parse(req.body);
    return publications.builder.inspect(input.revisionIds, p);
  });
  app.post("/v1/publications/draft", (req) => {
    const p = principal(req, "write");
    const input = PublicationInput.parse(req.body);
    const prepared = publications.builder.prepare(input, p, false);
    return {
      pages: prepared.pages.map(
        ({ pageId, revisionId, title, body, bodyHash }) => ({
          pageId,
          revisionId,
          title,
          body,
          bodyHash,
        }),
      ),
      attachments: prepared.attachments,
      dependencies: prepared.dependencies,
      outboundLinks: prepared.outboundLinks,
      publishable: false,
    };
  });
  app.post("/v1/publications/previews", async (req) =>
    publications.build(
      PublicationInput.parse(req.body),
      principal(req, "write"),
    ),
  );
  app.get("/v1/publications/previews/:id", (req) =>
    publications.preview(id(req), principal(req)),
  );
  app.post("/v1/publications/previews/:id/approve", (req) => {
    const p = principal(req, "write");
    const body = z
      .object({
        manifestDigest: z.string().length(64),
        outputDigest: z.string().length(64),
      })
      .strict()
      .parse(req.body);
    return publications.approve(
      id(req),
      body.manifestDigest,
      body.outputDigest,
      p,
    );
  });
  app.post("/v1/publications/previews/:id/release", (req) => {
    const p = principal(req, "release");
    const body = z
      .object({
        operationId: Id,
        manifestDigest: z.string().length(64),
        outputDigest: z.string().length(64),
      })
      .strict()
      .parse(req.body);
    return publications.release(
      id(req),
      body.operationId,
      body.manifestDigest,
      body.outputDigest,
      p,
    );
  });
  app.get("/v1/publications/releases", (req) =>
    publications.list(principal(req)),
  );
}
