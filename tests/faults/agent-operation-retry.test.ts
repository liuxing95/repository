import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { modelFixture } from "../model-helpers";
import { createServer } from "../../apps/service/src/http/server";
import type { AnswerProvider } from "../../apps/service/src/answers/answer";

test("model Agent call has one dispatch, reports usage, and cannot deliver after revocation", async () => {
  const { f, ref } = await modelFixture();
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const provider: AnswerProvider = {
    model: "agent-test-model",
    generate: async (pack) => {
      calls++;
      started();
      await released;
      const evidence = pack.evidence[0]!;
      return {
        requestId: randomUUID(),
        cost: 7,
        value: {
          claims: [
            {
              id: randomUUID(),
              text: evidence.text,
              kind: "sourced",
              scope: evidence.profile.scope,
              evidenceIds: [evidence.id],
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
    27124,
    new Map([["test-model", provider]]),
  );
  try {
    const admin = {
      host: "127.0.0.1:27124",
      authorization: `Bearer ${f.token}`,
      "x-policy-version": String(f.registry.get().policyVersion),
      "x-operation-key": randomUUID(),
    };
    const created = await app.inject({
      method: "POST",
      url: "/v1/agents/clients",
      headers: admin,
      payload: {
        name: "模型测试",
        sourceIds: [ref.sourceId],
        receiver: { kind: "model", routeId: "test-model" },
        expiresInMinutes: 60,
      },
    });
    expect(created.statusCode).toBe(200);
    const { client, secret } = created.json() as {
      client: { id: string };
      secret: string;
    };
    const requestId = randomUUID();
    const invoke = (tool: string, args: unknown, id = requestId) =>
      app.inject({
        method: "POST",
        url: "/v1/agents/invoke",
        headers: {
          host: "127.0.0.1:27124",
          "x-agent-id": client.id,
          authorization: `Bearer ${secret}`,
        },
        payload: { requestId: id, tool, args },
      });
    const inFlight = invoke("kb_answer", { question: "权限" });
    await dispatched;
    const pending = await invoke("kb_operation", { requestId }, randomUUID());
    expect(pending.json().state).toBe("unknown");
    expect(pending.json().billing.state).toBe("dispatched");
    const retry = await invoke("kb_answer", { question: "权限" });
    expect(retry.json().state).toBe("unknown");
    expect(calls).toBe(1);
    const revoked = await app.inject({
      method: "POST",
      url: `/v1/agents/clients/${client.id}/revoke`,
      headers: { ...admin, "x-operation-key": randomUUID() },
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    finish();
    const completed = await inFlight;
    expect(completed.statusCode).toBeGreaterThanOrEqual(400);
    expect(completed.body).not.toContain("权限不允许");
    expect(
      (await invoke("kb_operation", { requestId }, randomUUID())).statusCode,
    ).toBe(401);
    expect(calls).toBe(1);
  } finally {
    finish();
    await app.close();
    await f.close();
  }
}, 30_000);
