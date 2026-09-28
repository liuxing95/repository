import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "../helpers";
import { publish } from "../evidence-helpers";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
import { SearchService } from "../../apps/service/src/search/search";
import {
  AnswerService,
  type AnswerProvider,
} from "../../apps/service/src/answers/answer";
import { setupLocalWriting } from "../../apps/service/src/answers/local-setup";

test("local setup authorizes only selected source, preserves other routes and enables generation through the zero-cost broker", async () => {
  const f = await fixture();
  try {
    const e = new EvidenceStore(f.registry),
      s = new SearchService(e);
    e.register(publish(f, "权限说明", "选定资料"));
    const other = e.register(publish(f, "别的资料", "另一集合"))[0]!;
    const provider: AnswerProvider = {
      model: "local-fixture",
      localOnly: true,
      generate: async (pack) => ({
        requestId: randomUUID(),
        cost: 0,
        value: {
          claims: [
            {
              id: randomUUID(),
              text: "需要核对权限",
              kind: "inferred",
              scope: pack.scope,
              evidenceIds: [pack.evidence[0]!.id],
            },
          ],
          relations: [],
          gaps: [],
        },
      }),
    };
    const a = new AnswerService(s, new Map([["local-ollama", provider]]));
    const r = await s.search({ query: "权限" }, f.principal);
    const settings = f.registry.settings();
    setupLocalWriting(
      a,
      { snapshotId: r.snapshot.id, evidenceIds: [r.hits[0]!.id] },
      f.principal,
    );
    expect(f.store.get(`source:${other.sourceId}`)).toBeUndefined();
    expect(
      f.registry.settings().routes.filter((r) => r.id !== "local-ollama"),
    ).toEqual(settings.routes);
    f.principal = f.sessions.refresh(f.token);
    const refreshed = await s.search({ query: "权限" }, f.principal);
    expect(
      (
        await a.answer(
          {
            snapshotId: refreshed.snapshot.id,
            routeId: "local-ollama",
            operationId: randomUUID(),
          },
          f.principal,
        )
      ).mode,
    ).toBe("model");
    expect(f.store.db.prepare("SELECT actual,state FROM calls").all()).toEqual([
      { actual: 0, state: "settled" },
    ]);
    expect(() =>
      setupLocalWriting(
        a,
        { snapshotId: refreshed.snapshot.id, evidenceIds: [other.id] },
        f.principal,
      ),
    ).toThrow("INVALID_CITATION");
    expect(() =>
      setupLocalWriting(
        a,
        {
          snapshotId: refreshed.snapshot.id,
          evidenceIds: [refreshed.hits[0]!.id],
        },
        { ...f.principal, role: "user" },
      ),
    ).toThrow("FORBIDDEN");
  } finally {
    await f.close();
  }
});

test("a slow real HTTP generation keeps the response open and persists a draft before replying", async () => {
  const { createServer } = await import("../../apps/service/src/http/server");
  const { createServer: netServer } = await import("node:net");
  const { request } = await import("node:http");
  const f = await fixture();
  const portProbe = netServer();
  await new Promise<void>((resolve) =>
    portProbe.listen(0, "127.0.0.1", resolve),
  );
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const provider: AnswerProvider = {
    model: "local-fixture",
    localOnly: true,
    generate: async (pack) => {
      entered();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        requestId: randomUUID(),
        cost: 0,
        value: {
          claims: [
            {
              id: randomUUID(),
              text: "需要先检查权限",
              kind: "inferred",
              scope: pack.scope,
              evidenceIds: [pack.evidence[0]!.id],
            },
          ],
          relations: [],
          gaps: [],
        },
      };
    },
  };
  const app = createServer(
    f.registry,
    f.sessions,
    f.jobs,
    port,
    new Map([["local-ollama", provider]]),
  );
  try {
    const e = new EvidenceStore(f.registry),
      s = new SearchService(e),
      a = new AnswerService(s, new Map([["local-ollama", provider]]));
    e.register(publish(f, "权限说明"));
    const initial = await s.search({ query: "权限" }, f.principal);
    setupLocalWriting(
      a,
      { snapshotId: initial.snapshot.id, evidenceIds: [initial.hits[0]!.id] },
      f.principal,
    );
    f.principal = f.sessions.refresh(f.token);
    const search = await s.search({ query: "权限" }, f.principal);
    await app.listen({ port, host: "127.0.0.1" });
    app.server.setTimeout(100);
    const body = JSON.stringify({
      snapshotId: search.snapshot.id,
      evidenceIds: [search.hits[0]!.id],
      routeId: "local-ollama",
      operationId: randomUUID(),
      title: "权限简介",
      writingInstruction: "写一段简介",
    });
    const pending = new Promise<{ id: string; revision: number }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/v1/writing",
            method: "POST",
            headers: {
              authorization: `Bearer ${f.token}`,
              "x-policy-version": String(f.principal.policyVersion),
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (res) => {
            let text = "";
            res.on("data", (part) => (text += part));
            res.on("end", () => {
              if (res.statusCode !== 200) reject(new Error(text));
              else resolve(JSON.parse(text));
            });
          },
        );
        req.on("error", reject);
        req.end(body);
      },
    );
    await started;
    const result = await pending;
    expect(result.revision).toBe(1);
    expect(f.store.get(`writing-draft:${result.id}`)).toBeDefined();
  } finally {
    await app.close();
    await f.close();
  }
});
