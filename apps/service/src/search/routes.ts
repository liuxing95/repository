import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { Id, Profile, Claim, Relation } from "@kb/contracts";
import { Sessions, authorize, bearer } from "../http/auth";
import { EvidenceStore } from "../evidence/locator";
import { SearchService } from "./search";
import { AnswerService, type AnswerProvider } from "../answers/answer";
import { knowledgeHealth } from "../evidence/health";
import { enhancementStatus } from "./enhancement";
export function searchRoutes(
  app: FastifyInstance,
  evidence: EvidenceStore,
  sessions: Sessions,
  providers?: ReadonlyMap<string, AnswerProvider>,
) {
  const search = new SearchService(evidence);
  const answers = new AnswerService(search, providers);
  const principal = (req: FastifyRequest, write = false) => {
    const p = sessions.authenticate(bearer(req));
    authorize(
      evidence.registry,
      p,
      write ? ["admin", "user"] : ["admin", "user", "reader"],
      write ? Number(req.headers["x-policy-version"]) : undefined,
      write,
    );
    return p;
  };
  const id = (req: FastifyRequest) => z.object({ id: Id }).parse(req.params).id;
  app.post("/v1/search", (req) => search.search(req.body, principal(req)));
  app.post("/v1/search/rebuild", async (req) => {
    principal(req, true);
    await search.indexer.rebuild();
    search.indexer.collect();
    return search.indexer.status(search.indexer.active()!);
  });
  app.get("/v1/evidence/:id", async (req) => {
    principal(req);
    return evidence.read(
      z.object({ id: z.string().length(64) }).parse(req.params).id,
    );
  });
  app.put("/v1/evidence/profiles/:id", async (req) => {
    principal(req, true);
    return evidence.setProfile(id(req), Profile.parse(req.body));
  });
  app.put("/v1/evidence/family", async (req) => {
    principal(req, true);
    const input = z.object({ child: Id, parent: Id }).strict().parse(req.body);
    evidence.setFamily(input.child, input.parent);
    return { linked: true };
  });
  app.put("/v1/evidence/claims", async (req) => {
    principal(req, true);
    return evidence.saveClaim(Claim.parse(req.body));
  });
  app.put("/v1/evidence/relations", async (req) => {
    principal(req, true);
    return evidence.relation(Relation.parse(req.body));
  });
  app.get("/v1/answers/options", async (req) => {
    principal(req);
    return answers.options();
  });
  app.post("/v1/answers", (req) =>
    answers.answer(req.body, principal(req, true)),
  );
  app.get("/v1/answers/:id", async (req) =>
    answers.byId(id(req), principal(req)),
  );
  // Revalidate on every attempt, including idempotent candidate saves; never return stale command bodies.
  app.post("/v1/answers/:id/candidate", async (req) =>
    answers.candidate(id(req), principal(req, true)),
  );
  app.get("/v1/knowledge-health", async (req) =>
    knowledgeHealth(evidence, principal(req)),
  );
  app.get("/v1/search/enhancement", async (req) => {
    principal(req);
    return enhancementStatus();
  });
}
