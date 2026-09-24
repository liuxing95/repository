import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "../helpers";
import { publish } from "../evidence-helpers";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
import { createServer } from "../../apps/service/src/http/server";

test("Agent reads only granted sources, and revoke blocks stored results", async () => {
  const f = await fixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
  try {
    const allowed = new EvidenceStore(f.registry).register(
      publish(f, "绿色许可说明"),
    )[0]!;
    const denied = new EvidenceStore(f.registry).register(
      publish(f, "红色私密说明"),
    )[0]!;
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
        name: "本地测试",
        sourceIds: [allowed.sourceId],
        receiver: { kind: "local" },
        expiresInMinutes: 60,
      },
    });
    expect(created.statusCode).toBe(200);
    const { client, secret } = created.json() as {
      client: { id: string };
      secret: string;
    };
    expect(created.body).not.toContain("secretHash");
    const wrongEntrance = await app.inject({
      method: "GET",
      url: "/v1/settings",
      headers: { host: "127.0.0.1:27124", authorization: `Bearer ${secret}` },
    });
    expect(wrongEntrance.statusCode).toBe(401);
    const invoke = (tool: string, args: unknown, requestId = randomUUID()) =>
      app.inject({
        method: "POST",
        url: "/v1/agents/invoke",
        headers: {
          host: "127.0.0.1:27124",
          "x-agent-id": client.id,
          authorization: `Bearer ${secret}`,
        },
        payload: { tool, args, requestId },
      });
    const search = await invoke("kb_search", { query: "说明" });
    expect(search.statusCode).toBe(200);
    expect(search.body).toContain("绿色许可");
    expect(search.body).not.toContain("红色私密");
    expect(search.body).not.toContain("fixtures.invalid");
    const outside = await invoke("kb_read_evidence", { evidenceId: denied.id });
    expect(outside.statusCode).toBe(403);
    expect(outside.body).not.toContain("红色私密");
    const readId = randomUUID();
    const read = await invoke(
      "kb_read_evidence",
      { evidenceId: allowed.id },
      readId,
    );
    expect(read.statusCode).toBe(200);
    expect(read.body).toContain("绿色许可");
    const retry = await invoke(
      "kb_read_evidence",
      { evidenceId: allowed.id },
      readId,
    );
    expect(retry.json()).toEqual(read.json());
    const clash = await invoke("kb_search", { query: "说明" }, readId);
    expect(clash.statusCode).toBe(409);
    const operation = await invoke("kb_operation", { requestId: readId });
    expect(operation.statusCode).toBe(200);
    f.store.set(`source:${allowed.sourceId}`, { retracted: true });
    const afterSourceRetraction = await invoke("kb_operation", {
      requestId: readId,
    });
    expect(afterSourceRetraction.statusCode).toBe(403);
    expect(afterSourceRetraction.body).not.toContain("绿色许可");
    const revoked = await app.inject({
      method: "POST",
      url: `/v1/agents/clients/${client.id}/revoke`,
      headers: { ...admin, "x-operation-key": randomUUID() },
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    expect(
      (await invoke("kb_operation", { requestId: readId })).statusCode,
    ).toBe(401);
    expect(
      (await invoke("kb_read_evidence", { evidenceId: allowed.id })).statusCode,
    ).toBe(401);
  } finally {
    await app.close();
    await f.close();
  }
});

test("Agent creation rejects unknown source, unapproved model receiver and secret replay", async () => {
  const f = await fixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
  try {
    const allowed = new EvidenceStore(f.registry).register(
      publish(f, "正式资料"),
    )[0]!;
    const key = randomUUID();
    const headers = {
      host: "127.0.0.1:27124",
      authorization: `Bearer ${f.token}`,
      "x-policy-version": String(f.registry.get().policyVersion),
      "x-operation-key": key,
    };
    const base = {
      name: "测试",
      sourceIds: [allowed.sourceId],
      receiver: { kind: "local" },
      expiresInMinutes: 60,
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/agents/clients",
      headers,
      payload: base,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().secret).toMatch(/^[\w-]{43}$/);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/agents/clients",
          headers,
          payload: base,
        })
      ).json().secret,
    ).toBeNull();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/agents/clients",
          headers,
          payload: { ...base, name: "另一个" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/agents/clients",
          headers: { ...headers, "x-operation-key": randomUUID() },
          payload: { ...base, sourceIds: [randomUUID()] },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/agents/clients",
          headers: { ...headers, "x-operation-key": randomUUID() },
          payload: { ...base, receiver: { kind: "model", routeId: "missing" } },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      JSON.stringify(f.store.get(`agent-create:${f.principal.id}:${key}`)),
    ).not.toContain(first.json().secret);
    const createdId = first.json().client.id as string;
    const client = f.store.get(`agent-client:${createdId}`) as Record<
      string,
      unknown
    >;
    f.store.set(`agent-client:${createdId}`, {
      ...client,
      expiresAt: Date.now() - 1,
    });
    const expired = await app.inject({
      method: "POST",
      url: "/v1/agents/invoke",
      headers: {
        host: "127.0.0.1:27124",
        "x-agent-id": createdId,
        authorization: `Bearer ${first.json().secret}`,
      },
      payload: {
        requestId: randomUUID(),
        tool: "kb_search",
        args: { query: "正式" },
      },
    });
    expect(expired.statusCode).toBe(401);
  } finally {
    await app.close();
    await f.close();
  }
});

test("Agent search paginates inside its grant and bounds excerpts", async () => {
  const f = await fixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
  try {
    const evidence = new EvidenceStore(f.registry);
    const refs = Array.from(
      { length: 7 },
      (_, i) =>
        evidence.register(
          publish(f, `分页内容 ${i} ${"片段".repeat(600)}`),
        )[0]!,
    );
    const created = await app.inject({
      method: "POST",
      url: "/v1/agents/clients",
      headers: {
        host: "127.0.0.1:27124",
        authorization: `Bearer ${f.token}`,
        "x-policy-version": String(f.registry.get().policyVersion),
        "x-operation-key": randomUUID(),
      },
      payload: {
        name: "分页测试",
        sourceIds: refs.map((r) => r.sourceId),
        receiver: { kind: "local" },
        expiresInMinutes: 60,
      },
    });
    expect(created.statusCode).toBe(200);
    const { client, secret } = created.json() as {
      client: { id: string };
      secret: string;
    };
    const page = async (offset: number) =>
      (
        await app.inject({
          method: "POST",
          url: "/v1/agents/invoke",
          headers: {
            host: "127.0.0.1:27124",
            "x-agent-id": client.id,
            authorization: `Bearer ${secret}`,
          },
          payload: {
            requestId: randomUUID(),
            tool: "kb_search",
            args: { query: "分页内容", offset, limit: 5 },
          },
        })
      ).json() as {
        result: {
          hits: { id: string; text: string }[];
          nextOffset: number | null;
        };
      };
    const first = await page(0),
      second = await page(5);
    expect(first.result.hits).toHaveLength(5);
    expect(first.result.nextOffset).toBe(5);
    expect(second.result.hits).toHaveLength(2);
    expect(
      new Set([...first.result.hits, ...second.result.hits].map((h) => h.id))
        .size,
    ).toBe(7);
    expect(first.result.hits.every((hit) => hit.text.length <= 700)).toBe(true);
  } finally {
    await app.close();
    await f.close();
  }
});

test("derived evidence cannot expose an original outside the client's grant", async () => {
  const f = await fixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
  try {
    const evidence = new EvidenceStore(f.registry);
    const original = publish(f, "受限原文仅供内部阅读");
    const originalId = evidence.register(original)[0]!.id;
    const derived = publish(f, "内部摘要不应越过授权");
    const derivedRef = evidence.register(derived)[0]!;
    evidence.setProfile(derived.id, {
      kind: "summary",
      originalEvidence: [originalId],
    });
    const created = await app.inject({
      method: "POST",
      url: "/v1/agents/clients",
      headers: {
        host: "127.0.0.1:27124",
        authorization: `Bearer ${f.token}`,
        "x-policy-version": String(f.registry.get().policyVersion),
        "x-operation-key": randomUUID(),
      },
      payload: {
        name: "摘要测试",
        sourceIds: [derivedRef.sourceId],
        receiver: { kind: "local" },
        expiresInMinutes: 60,
      },
    });
    expect(created.statusCode).toBe(200);
    const { client, secret } = created.json() as {
      client: { id: string };
      secret: string;
    };
    const invoke = (tool: string, args: unknown) =>
      app.inject({
        method: "POST",
        url: "/v1/agents/invoke",
        headers: {
          host: "127.0.0.1:27124",
          "x-agent-id": client.id,
          authorization: `Bearer ${secret}`,
        },
        payload: { requestId: randomUUID(), tool, args },
      });
    const search = await invoke("kb_search", { query: "内部摘要" });
    expect(search.statusCode).toBe(200);
    expect(search.json().result.hits).toEqual([]);
    const read = await invoke("kb_read_evidence", {
      evidenceId: derivedRef.id,
    });
    expect(read.statusCode).toBe(403);
    expect(read.body).not.toContain("内部摘要");
  } finally {
    await app.close();
    await f.close();
  }
});
