import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { Id, Profile, Claim, Relation } from "@kb/contracts";
import { Sessions, authorize, bearer } from "../http/auth";
import { EvidenceStore } from "../evidence/locator";
import { SearchService } from "./search";
import { AnswerInput, AnswerService, type AnswerProvider } from "../answers/answer";
import { DraftContent } from "@kb/contracts";
import { AppError } from "../errors";
import { knowledgeHealth } from "../evidence/health";
import { enhancementStatus } from "./enhancement";
import { WritingDrafts } from "../review/drafts";
import { setupLocalWriting } from "../answers/local-setup";
export function searchRoutes(
  app: FastifyInstance,
  evidence: EvidenceStore,
  sessions: Sessions,
  providers?: ReadonlyMap<string, AnswerProvider>,
) {
  const search = new SearchService(evidence);
  const answers = new AnswerService(search, providers);
  const drafts = new WritingDrafts(answers);
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
  app.post("/v1/answers", (req, reply) => {
    const p = principal(req, true);
    reply.raw.setTimeout(200000);
    return answers.answer(req.body, p);
  });
  app.post("/v1/writing", async (req, reply) => {
    const p = principal(req, true);
    const { title, ...input } = AnswerInput.extend({ title: DraftContent.shape.title }).parse(req.body);
    if (input.routeId !== "local-ollama" || !providers?.get(input.routeId)?.localOnly)
      throw new AppError("UNAVAILABLE", 503, "正文生成只接受已启动的本机模型。");
    reply.raw.setTimeout(200000);
    const answer = await answers.answer(input, p);
    if (!answer.claims.length) throw new AppError("UNSUPPORTED_CLAIM", 409, "证据不足，模型未生成正文。请更换证据后重试。");
    // Save on the server even if the client closes the view while generation runs.
    return drafts.create(answer.id, { title }, p);
  });
  app.post("/v1/answers/local-setup", (req) => setupLocalWriting(answers, req.body, principal(req, true)));
  app.get("/v1/answers/:id", async (req) =>
    answers.byId(id(req), principal(req)),
  );
  // Revalidate on every attempt, including idempotent candidate saves; never return stale command bodies.
  app.post("/v1/answers/:id/candidate", async (req) =>
    answers.candidate(id(req), principal(req, true)),
  );
  app.post("/v1/answers/:id/draft", (req) => drafts.create(id(req), req.body, principal(req, true)));
  app.get("/v1/drafts", (req) => drafts.list(principal(req)));
  app.get("/v1/drafts/:id", (req) => drafts.get(id(req), principal(req)));
  app.put("/v1/drafts/:id", { bodyLimit: 350000 }, (req) => drafts.save(id(req), req.body, principal(req, true)));
  app.post("/v1/drafts/:id/candidate", (req) => {
    const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(req.body);
    return drafts.freeze(id(req), revision, principal(req, true));
  });
  app.get("/v1/knowledge-health", async (req) =>
    knowledgeHealth(evidence, principal(req)),
  );
  app.get("/v1/search/enhancement", async (req) => {
    principal(req);
    return enhancementStatus();
  });
}
