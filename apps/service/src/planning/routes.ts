import { z } from "zod";
import { Id } from "@kb/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Sessions, authorize, bearer } from "../http/auth";
import { AppError } from "../errors";
import { Reconciliation } from "../tasks/reconcile";
import { planningSnapshot } from "./snapshot";
import { solve } from "./solver";
import { validateCandidate } from "./validator";
import { PlanningLedger } from "./accept";
import { undoCandidate } from "./undo";
import { PlanNotes } from "./notes";
import type { BusyProvider } from "../calendar/freebusy";

export function planningRoutes(
  app: FastifyInstance,
  db: Reconciliation,
  sessions: Sessions,
  provider?: BusyProvider,
) {
  const ledger = new PlanningLedger(db, provider);
  const notes = new PlanNotes(ledger);
  const principal = (req: FastifyRequest, write: boolean) => {
    const p = sessions.authenticate(bearer(req));
    authorize(
      db.guard.evidence.registry,
      p,
      write ? ["admin", "user"] : ["admin", "user", "reader"],
      write ? Number(req.headers["x-policy-version"]) : undefined,
      write,
    );
    return p;
  };
  const id = (req: FastifyRequest) =>
    Id.parse(z.object({ id: Id }).parse(req.params).id);
  app.post("/v1/planning/candidates", async (req) => {
    const p = principal(req, true);
    const candidate = solve(
      await planningSnapshot(db, req.body, p.policyVersion, p.epoch, provider),
    );
    const issues = validateCandidate(candidate);
    if (issues.length && candidate.snapshot.coverage.state !== "unknown")
      throw new AppError("VALIDATION", 400, issues[0]);
    return ledger.save(candidate, p);
  });
  app.get("/v1/planning/candidates/:id", (req) => {
    principal(req, false);
    return ledger.candidate(id(req));
  });
  app.post("/v1/planning/candidates/:id/accept", (req) =>
    ledger.accept(id(req), principal(req, true)),
  );
  app.post("/v1/planning/undo", (req) =>
    undoCandidate(
      ledger,
      principal(req, true),
      z
        .object({ request: z.unknown().optional() })
        .strict()
        .parse(req.body ?? {}).request,
    ),
  );
  app.get("/v1/planning/current", (req) => {
    principal(req, false);
    const planId = db.store.get("tasks.acceptedPlan") as string | undefined;
    if (!planId) return null;
    const row = db.store.db
      .prepare("SELECT value FROM plan_revisions WHERE id=?")
      .get(planId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  });
  app.get("/v1/planning/notes/pending", (req) =>
    notes.pending(principal(req, true)),
  );
  app.post("/v1/planning/notes/:id/grant", (req) =>
    notes.grant(id(req), principal(req, true)),
  );
  app.post("/v1/planning/notes/:id/receipt", (req) => {
    const input = z
      .object({
        token: z.string().min(1),
        afterHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(req.body);
    return notes.receipt(
      id(req),
      input.token,
      input.afterHash,
      principal(req, true),
    );
  });
}
