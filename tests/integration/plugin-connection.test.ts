import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "../helpers";
import { createServer } from "../../apps/service/src/http/server";
import {
  Connection,
  type Transport,
} from "../../apps/obsidian-plugin/src/connection";

test("plugin pairs, refreshes and performs bodyless actions through real HTTP handlers", async () => {
  const f = await fixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
  try {
    const transport: Transport = async (url, options) => {
      const res = await app.inject({
        url: new URL(url).pathname,
        method: options.method as "GET" | "POST" | "PUT",
        headers: { ...options.headers, host: "127.0.0.1:27124" },
        payload: options.body,
      });
      return { status: res.statusCode, json: res.json() };
    };
    const connection = new Connection(
      transport,
      f.registry.get().vaultPath,
      randomUUID(),
    );
    await connection.pair(f.sessions.issuePairing());
    expect(connection.principal?.role).toBe("admin");
    await connection.disconnect();
    expect(connection.principal).toBeUndefined();
  } finally {
    await app.close();
    await f.close();
  }
});

test("lost mutation response can be retried after reads without repeating a side effect", async () => {
  const f = await fixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
  let lose = false;
  try {
    const transport: Transport = async (url, options) => {
      const path = new URL(url).pathname;
      const res = await app.inject({
        url: path,
        method: options.method as "GET" | "POST" | "PUT",
        headers: { ...options.headers, host: "127.0.0.1:27124" },
        payload: options.body,
      });
      if (lose && options.method === "PUT" && res.statusCode === 200) {
        lose = false;
        throw new Error("connection lost after commit");
      }
      return { status: res.statusCode, json: res.json() };
    };
    const connection = new Connection(
      transport,
      f.registry.get().vaultPath,
      f.deviceId,
    );
    await connection.pair(f.sessions.issuePairing());
    const settings = await connection.settings();
    lose = true;
    await expect(connection.saveSettings(settings)).rejects.toThrow(
      "connection lost",
    );
    expect(f.registry.get().policyVersion).toBe(2);
    await connection.diagnostics();
    await connection.saveSettings(settings);
    expect(f.registry.get().policyVersion).toBe(2);
    const headers = {
      host: "127.0.0.1:27124",
      authorization: `Bearer ${f.token}`,
      "x-policy-version": "2",
      "x-operation-key": randomUUID(),
    };
    const payload = {
      operationKey: "same-payload-test",
      queue: "interactive",
      kind: "diagnostic-check",
    };
    expect(
      (await app.inject({ method: "POST", url: "/v1/jobs", headers, payload }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/jobs",
          headers,
          payload: { ...payload, queue: "batch" },
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await app.close();
    await f.close();
  }
});
