import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { fixture } from "../helpers";
import { createServer } from "../../apps/service/src/http/server";

test("提醒接口要求认证和主端，重试同一操作只登记一次", async () => {
  const f = await fixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
  try {
    const payload = {
      kind: "morning",
      localTime: "09:00",
      timezone: "Asia/Shanghai",
      catchUp: false,
      enabled: true,
      overlapReviewed: true,
      maxLateMinutes: 15,
      quietStart: null,
      quietEnd: null,
    };
    const headers = {
      authorization: `Bearer ${f.token}`,
      host: "127.0.0.1:27124",
      "x-policy-version": String(f.principal.policyVersion),
      "x-operation-key": randomUUID(),
    };
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/reminders",
          headers: { host: headers.host },
        })
      ).statusCode,
    ).toBe(401);
    const first = await app.inject({
      method: "POST",
      url: "/v1/reminders/rules",
      headers,
      payload,
    });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/v1/reminders/rules",
      headers,
      payload,
    });
    expect(replay.json().id).toBe(first.json().id);
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/reminders/rules",
      headers: { ...headers, "x-operation-key": randomUUID() },
      payload,
    });
    expect(duplicate.statusCode).toBe(409);
    const listing = await app.inject({
      method: "GET",
      url: "/v1/reminders",
      headers,
    });
    expect(listing.json().rules).toHaveLength(1);
    expect(listing.json().occurrences).toHaveLength(2);
    expect(() => f.registry.releaseMaster(f.principal)).toThrow();
    const disabled = await app.inject({
      method: "POST",
      url: `/v1/reminders/rules/${first.json().id}/disable`,
      headers: { ...headers, "x-operation-key": randomUUID() },
      payload: {},
    });
    expect(disabled.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/v1/reminders", headers }))
        .json()
        .occurrences.every(
          (o: { cancelGeneration: number; generation: number }) =>
            o.cancelGeneration === o.generation,
        ),
    ).toBe(true);
    const occurrence = (
      await app.inject({ method: "GET", url: "/v1/reminders", headers })
    ).json().occurrences[0];
    f.store.db
      .prepare("INSERT INTO reminder_attempts VALUES(?,?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        occurrence.logicalKey,
        occurrence.deliveryKey,
        occurrence.generation,
        Date.now(),
        null,
        "outcome_unknown",
        "合成未知结果",
      );
    expect(() => f.registry.releaseMaster(f.principal)).toThrow();
    const reviewed = await app.inject({
      method: "POST",
      url: `/v1/reminders/${occurrence.logicalKey}/review-unknown`,
      headers: { ...headers, "x-operation-key": randomUUID() },
      payload: {},
    });
    expect(reviewed.json()).toMatchObject({
      reviewed: true,
      stillUnknown: true,
    });
    expect(
      (
        f.store.db.prepare("SELECT state FROM reminder_attempts").get() as {
          state: string;
        }
      ).state,
    ).toBe("outcome_unknown");
    expect(f.registry.releaseMaster(f.principal).deviceId).toBeNull();
  } finally {
    await app.close();
    await f.close();
  }
});
