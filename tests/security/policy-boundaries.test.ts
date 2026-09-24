import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture, settings } from "../helpers";
import { createServer } from "../../apps/service/src/http/server";
import { Policy } from "../../apps/service/src/security/policy";
import {
  publicAddress,
  validateTarget,
} from "../../apps/service/src/security/egress";
import { Purpose } from "@kb/contracts";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
async function setup() {
  const f = await fixture();
  cleanup.push(f.close);
  return f;
}
test("real API checks Host, Origin, roles, revocation and workspace binding", async () => {
  const f = await setup();
  const app = createServer(f.registry, f.sessions, f.jobs);
  cleanup.unshift(() => app.close());
  const headers = {
    host: "127.0.0.1:27124",
    authorization: `Bearer ${f.token}`,
    "x-policy-version": "1",
  };
  expect((await app.inject({ url: "/v1/workspace", headers })).statusCode).toBe(
    200,
  );
  for (const override of [
    { host: "evil.example:27124" },
    { origin: "https://evil.example" },
    { authorization: "Bearer invalid" },
  ])
    expect(
      (
        await app.inject({
          url: "/v1/workspace",
          headers: { ...headers, ...override },
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
  await expect(
    f.sessions.pair({
      code: f.sessions.issuePairing(),
      deviceId: randomUUID(),
      vaultPath: f.source,
    }),
  ).rejects.toThrow("FORBIDDEN");
  const reader = await f.sessions.pair({
    code: f.sessions.issuePairing("reader"),
    deviceId: randomUUID(),
    vaultPath: f.registry.get().vaultPath,
  });
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/v1/settings",
        headers: { ...headers, authorization: `Bearer ${reader.token}` },
        payload: settings,
      })
    ).statusCode,
  ).toBe(403);
  f.sessions.revoke(f.token);
  expect((await app.inject({ url: "/v1/workspace", headers })).statusCode).toBe(
    401,
  );
});
test("independent purposes, intersecting sources, retraction and stale policy fail closed", async () => {
  const f = await setup();
  f.registry.saveSettings(settings, 1);
  const policy = new Policy(f.registry);
  const routes = Object.fromEntries(
    Purpose.options.map((p) => [p, p === "model" ? ["test-model"] : []]),
  );
  policy.setSource({ sourceId: "a", retracted: false, routes });
  policy.setSource({
    sourceId: "b",
    retracted: false,
    routes: { ...routes, model: [] },
  });
  const p = f.sessions.refresh(f.token);
  const v = f.registry.get().policyVersion;
  expect(policy.allow(p, v, "model", "test-model", ["a"]).id).toBe(
    "test-model",
  );
  expect(() => policy.allow(p, v, "model", "test-model", ["a", "b"])).toThrow(
    "FORBIDDEN",
  );
  expect(() => policy.allow(p, v, "publish", "test-model", ["a"])).toThrow(
    "FORBIDDEN",
  );
  policy.setSource({ sourceId: "a", retracted: true, routes });
  expect(() => policy.allow(p, v, "model", "test-model", ["a"])).toThrow(
    "BASELINE",
  );
  expect(() => policy.allow(p, v + 1, "model", "test-model", ["a"])).toThrow(
    "FORBIDDEN",
  );
});
test("private, mapped IPv6, mixed DNS and redirect destinations rejected before connection", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
  ])
    expect(publicAddress(address)).toBe(false);
  expect(publicAddress("8.8.8.8")).toBe(true);
  await expect(
    validateTarget("https://safe.example/", ["safe.example"], async () => [
      { address: "8.8.8.8", family: 4 },
    ]),
  ).resolves.toHaveProperty("address.address", "8.8.8.8");
  for (const target of [
    "http://safe.example",
    "https://safe.example:123",
    "https://safe.example@evil.example/",
    "https://127.0.0.1/",
  ])
    await expect(validateTarget(target, ["safe.example"])).rejects.toThrow(
      "FORBIDDEN",
    );
  await expect(
    validateTarget(
      "https://safe.example/redirected",
      ["safe.example"],
      async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    ),
  ).rejects.toThrow("FORBIDDEN");
});
test("pairing challenge cannot be reused concurrently, payload cannot self-assign admin", async () => {
  const f = await setup();
  const input = {
    code: f.sessions.issuePairing("reader"),
    deviceId: randomUUID(),
    vaultPath: f.registry.get().vaultPath,
  };
  await expect(f.sessions.pair({ ...input, role: "admin" })).rejects.toThrow(
    "VALIDATION",
  );
  const results = await Promise.allSettled([
    f.sessions.pair(input),
    f.sessions.pair(input),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});

test("master session pauses after missed heartbeats and recovers only on an authenticated heartbeat", async () => {
  let now = Date.now();
  const f = await fixture(() => now);
  try {
    expect(f.sessions.hasMasterSession()).toBe(true);
    now += 45_001;
    expect(f.sessions.hasMasterSession()).toBe(false);
    f.sessions.heartbeat(f.token);
    expect(f.sessions.hasMasterSession()).toBe(true);
    f.sessions.revoke(f.token);
    expect(f.sessions.hasMasterSession()).toBe(false);
    expect(() => f.sessions.heartbeat(f.token)).toThrow("AUTH");
  } finally {
    await f.close();
  }
});
