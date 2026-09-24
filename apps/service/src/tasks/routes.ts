import { z } from "zod";
import { Id } from "@kb/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Sessions, authorize, bearer } from "../http/auth";
import { Reconciliation } from "./reconcile";
import { TaskCommands } from "./commands";
import { capture, textCapture } from "./capture";
import { today } from "./today";
import { taskProgress, freezeBaseline } from "./progress";
export function taskRoutes(
  app: FastifyInstance,
  db: Reconciliation,
  sessions: Sessions,
) {
  const commands = new TaskCommands(db);
  const principal = (req: FastifyRequest, write = false) => {
    const p = sessions.authenticate(bearer(req));
    authorize(
      db.guard.evidence.registry,
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
  app.get("/v1/tasks/today", (req) => {
    principal(req);
    return { ...today(db), progress: taskProgress(db) };
  });
  app.post("/v1/tasks/text-draft", (req) => {
    principal(req, true);
    const i = z
      .object({ text: z.string().min(1).max(500), timezone: z.string() })
      .strict()
      .parse(req.body);
    return textCapture(i.text, i.timezone, db.now());
  });
  app.post("/v1/tasks/draft", (req) => {
    principal(req, true);
    return capture(req.body);
  });
  app.post("/v1/tasks/commands", (req) =>
    commands.enqueue(req.body, principal(req, true)),
  );
  app.post("/v1/tasks/commands/claim", (req) =>
    commands.claim(principal(req, true)),
  );
  app.post("/v1/tasks/commands/:id/confirm", (req) =>
    commands.reauthorize(
      id(req),
      z.object({ digest: z.string() }).strict().parse(req.body).digest,
      principal(req, true),
    ),
  );
  app.post("/v1/tasks/commands/:id/cancel", (req) =>
    commands.cancel(id(req), principal(req, true)),
  );
  app.post("/v1/tasks/adoption-check", (req) => {
    db.guard.write(principal(req, true));
    return { allowed: true };
  });
  app.post("/v1/tasks/events", (req) =>
    db.event(req.body, principal(req, true)),
  );
  app.post("/v1/tasks/inventories", (req) => db.begin(principal(req, true)));
  app.post("/v1/tasks/inventories/:id/items", (req) =>
    db.add(id(req), req.body, principal(req, true)),
  );
  app.post("/v1/tasks/inventories/:id/finish", (req) =>
    db.finish(id(req), req.body, principal(req, true)),
  );
  app.post("/v1/tasks/baselines", (req) =>
    freezeBaseline(db, req.body, principal(req, true)),
  );
}
