import { z } from "zod";
import { Id, LearningGoalInput } from "@kb/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Sessions, authorize, bearer } from "../http/auth";
import { EvidenceStore } from "../evidence/locator";
import { Proposals } from "../review/proposals";
import { digest } from "../workspace/registry";
import { LearningStore } from "./goals";
import { Attempts } from "./attempts";
import { choose, choice } from "./units";
import { resume } from "./resume";
import { evidenceView } from "./evidence-view";
import { Suggestions } from "./review-suggestions";
import { Capacity, type LearningTaskAdapter } from "./capacity";
export function learningRoutes(
  app: FastifyInstance,
  evidence: EvidenceStore,
  sessions: Sessions,
  adapter?: LearningTaskAdapter,
) {
  const db = new LearningStore(new Proposals(evidence)),
    attempts = new Attempts(db),
    suggestions = new Suggestions(db),
    capacity = new Capacity(db, adapter);
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
  app.get("/v1/learning/settings", (req) => {
    principal(req);
    return { settings: db.settings(), taskAdapterEnabled: !!adapter };
  });
  app.post("/v1/learning/settings", (req) =>
    db.configure(req.body, principal(req, true)),
  );
  app.post("/v1/learning/draft", (req) => {
    principal(req, true);
    const parsed = LearningGoalInput.safeParse(req.body);
    return parsed.success
      ? {
          ready: true,
          input: parsed.data,
          digest: digest(parsed.data),
          missing: [],
        }
      : {
          ready: false,
          input: req.body,
          digest: null,
          missing: parsed.error.issues.map(
            (i) => `${i.path.join(".")}: ${i.message}`,
          ),
        };
  });
  app.post("/v1/learning/goals", (req) =>
    db.confirm(req.body, principal(req, true)),
  );
  app.get("/v1/learning/goals", (req) => {
    principal(req);
    return (
      db.store.db
        .prepare(
          "SELECT value FROM learning_goals ORDER BY rowid DESC LIMIT 100",
        )
        .all() as { value: string }[]
    ).map((r) => {
      const g = JSON.parse(r.value);
      return { ...g, ability: db.baseline(g.baselineId).input.ability };
    });
  });
  app.get("/v1/learning/goals/:id", (req) => {
    const p = principal(req),
      g = db.goal(id(req)),
      b = db.baseline(g.baselineId);
    const baselines = (
      db.store.db
        .prepare(
          "SELECT value FROM learning_baselines WHERE goal_id=? ORDER BY rowid DESC",
        )
        .all(g.id) as { value: string }[]
    ).map((r) => db.baseline(JSON.parse(r.value).id));
    return {
      goal: g,
      baseline: b,
      units: b.input.units.map((u) => ({
        ...u,
        choice: choice(db, g.id, u.id),
      })),
      progress: baselines.map((b) => evidenceView(db, b)),
      suggestions: suggestions.list(g.id, p),
    };
  });
  app.post("/v1/learning/goals/:id/state", (req) =>
    db.setState(
      id(req),
      z
        .object({ state: z.enum(["active", "paused"]) })
        .strict()
        .parse(req.body).state,
      principal(req, true),
    ),
  );
  app.post("/v1/learning/goals/:id/units/:unitId", (req) =>
    choose(
      db,
      id(req),
      z.object({ unitId: Id }).parse(req.params).unitId,
      req.body,
      principal(req, true),
    ),
  );
  app.get("/v1/learning/goals/:id/units/:unitId/resume", (req) =>
    resume(
      db,
      id(req),
      z.object({ unitId: Id }).parse(req.params).unitId,
      principal(req),
    ),
  );
  app.post("/v1/learning/goals/:id/attempts", (req) =>
    attempts.record(id(req), req.body, principal(req, true)),
  );
  app.post("/v1/learning/attempts/:id/evaluations", (req) =>
    attempts.evaluate(id(req), req.body, principal(req, true)),
  );
  app.post("/v1/learning/goals/:id/reviews", (req) =>
    suggestions.generate(id(req), principal(req, true)),
  );
  app.post("/v1/learning/goals/:id/supplement", (req) => {
    const i = z
      .object({ unitId: Id, reason: z.string() })
      .strict()
      .parse(req.body);
    return suggestions.supplement(
      id(req),
      i.unitId,
      i.reason,
      principal(req, true),
    );
  });
  app.post("/v1/learning/reviews/:id/choice", (req) =>
    suggestions.decide(id(req), req.body, principal(req, true)),
  );
  app.post("/v1/learning/reviews/:id/task", (req) =>
    capacity.create(id(req), principal(req, true)),
  );
  app.post("/v1/learning/task-intents/:id/reconcile", (req) =>
    capacity.reconcile(id(req), principal(req, true)),
  );
}
