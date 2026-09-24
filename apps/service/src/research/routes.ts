import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { Id } from "@kb/contracts";
import { Sessions, authorize, bearer } from "../http/auth";
import { EvidenceStore } from "../evidence/locator";
import { Proposals } from "../review/proposals";
import { ResearchStore, draftBrief } from "./brief";
import { Snapshots } from "./snapshots";
import { coverage, assess } from "./coverage";
import { Chapters, type ResearchProvider } from "./chapters";
import { Artifacts } from "./artifacts";
import { Acquisition } from "./acquisition";
import { AppError } from "../errors";
export function researchRoutes(
  app: FastifyInstance,
  evidence: EvidenceStore,
  sessions: Sessions,
  providers?: ReadonlyMap<string, ResearchProvider>,
) {
  const db = new ResearchStore(new Proposals(evidence)),
    snapshots = new Snapshots(db),
    chapters = new Chapters(db, providers),
    artifacts = new Artifacts(db),
    acquisition = new Acquisition(db);
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
  app.get("/v1/research/options", (req) => {
    principal(req);
    return {
      routes: [...chapters.providers].map(([id, p]) => ({
        id,
        model: p.model,
      })),
      modelEnabled: chapters.providers.size > 0,
      discovery: "explicit-scoped-entry",
      semanticReview: "not-reviewed",
    };
  });
  app.post("/v1/research/draft", (req) => {
    principal(req, true);
    return draftBrief(req.body);
  });
  app.post("/v1/research", (req) => db.confirm(req.body, principal(req, true)));
  app.get("/v1/research", (req) => {
    const p = principal(req);
    return (
      db.store.db
        .prepare("SELECT id FROM research_jobs ORDER BY rowid DESC LIMIT 100")
        .all() as { id: string }[]
    ).flatMap(({ id }) => {
      try {
        const r = db.get(id, p);
        if (r.snapshotId) snapshots.current(r, p);
        return [{ id, topic: r.brief.topic, state: r.state }];
      } catch (e) {
        if (e instanceof AppError) return [];
        throw e;
      }
    });
  });
  app.get("/v1/research/:id", (req) => {
    const p = principal(req),
      r = db.get(id(req), p),
      s = r.snapshotId ? snapshots.current(r, p) : null;
    const reports = (
      db.store.db
        .prepare(
          "SELECT id FROM research_reports WHERE research_id=? ORDER BY rowid DESC LIMIT 50",
        )
        .all(r.id) as { id: string }[]
    ).flatMap(({ id }) => {
      try {
        const report = artifacts.get(id, p);
        return [{ id, version: report.version, snapshotId: report.snapshotId }];
      } catch (e) {
        if (e instanceof AppError) return [];
        throw e;
      }
    });
    return {
      ...r,
      snapshot: s,
      coverage: s
        ? r.brief.questions.map((q) => coverage(db, r.brief, s, q))
        : [],
      chapters: s
        ? r.brief.questions.map((q) => chapters.get(s, q.id)).filter(Boolean)
        : [],
      reports,
      usage: db.usage(r),
    };
  });
  app.post("/v1/research/:id/snapshots", (req) =>
    snapshots.propose(id(req), principal(req, true)),
  );
  app.post("/v1/research/:id/advance", (req) => {
    const input = z
      .object({ snapshotId: Id, digest: z.string().length(64) })
      .strict()
      .parse(req.body);
    return snapshots.advance(
      id(req),
      input.snapshotId,
      input.digest,
      principal(req, true),
    );
  });
  app.post("/v1/research/:id/coverage/:questionId", (req) => {
    const p = principal(req, true),
      r = db.active(id(req), p),
      s = snapshots.current(r, p);
    const { snapshotId, assessment } = z
      .object({ snapshotId: Id, assessment: z.unknown() })
      .strict()
      .parse(req.body);
    if (s.id !== snapshotId) throw new AppError("BASELINE");
    const qid = z.object({ questionId: Id }).parse(req.params).questionId,
      q = r.brief.questions.find((q) => q.id === qid);
    if (!q) throw new AppError("NOT_FOUND", 404);
    return assess(db, r.brief, s, q, assessment, p);
  });
  app.post("/v1/research/:id/chapters/:questionId", (req) =>
    chapters.generate(
      id(req),
      z.object({ questionId: Id }).parse(req.params).questionId,
      req.body,
      principal(req, true),
    ),
  );
  app.post("/v1/research/:id/cancel", (req) =>
    chapters.cancel(id(req), principal(req, true)),
  );
  app.post("/v1/research/:id/acquisition", (req) =>
    acquisition.preview(id(req), req.body, principal(req, true)),
  );
  app.post("/v1/research/:id/reports", (req) =>
    artifacts.freeze(id(req), principal(req, true)),
  );
  app.get("/v1/research-reports/:id", (req) =>
    artifacts.get(id(req), principal(req)),
  );
  app.post("/v1/research-reports/:id/candidate", (req) =>
    artifacts.candidate(id(req), principal(req, true)),
  );
}
