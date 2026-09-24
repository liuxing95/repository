import { afterEach, expect, it } from "vitest";
import { createServer } from "../../apps/service/src/http/server";
import { taskFixture, fact } from "../task-helpers";
const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const x of open.splice(0)) await x.close();
});
it("主端经 HTTP 预览和采用，读者不能写，日历变化要求重预览", async () => {
  const f = await taskFixture();
  open.push(f);
  f.inventory([fact()]);
  let shifted = false;
  const app = createServer(
    f.registry,
    f.sessions,
    f.jobs,
    27124,
    undefined,
    undefined,
    undefined,
    async (ids, start, end) => ({
      calendars: Object.fromEntries(
        ids.map((id) => [
          id,
          {
            busy: shifted
              ? [
                  {
                    start: new Date(start + 30 * 60000).toISOString(),
                    end: new Date(
                      Math.min(end, start + 40 * 60000),
                    ).toISOString(),
                  },
                ]
              : [],
          },
        ]),
      ),
    }),
  );
  try {
    const headers = {
      authorization: `Bearer ${f.token}`,
      host: "127.0.0.1:27124",
      "x-policy-version": String(f.principal.policyVersion),
    };
    const input = {
      timezone: "Asia/Shanghai",
      windows: [
        {
          start: new Date(Date.now() + 60000).toISOString(),
          end: new Date(Date.now() + 7200000).toISOString(),
        },
      ],
      calendarIds: ["meeting"],
      unavailable: [],
      policy: { maxNodes: 100, freezeMinutes: 0, freshnessMs: 30000 },
    };
    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/planning/candidates",
      headers: { host: headers.host },
      payload: input,
    });
    expect(unauthorized.statusCode).toBe(401);
    const preview = await app.inject({
      method: "POST",
      url: "/v1/planning/candidates",
      headers,
      payload: input,
    });
    expect(preview.statusCode).toBe(200);
    const c = preview.json();
    expect(c.snapshot.coverage.state).toBe("complete");
    shifted = true;
    const stale = await app.inject({
      method: "POST",
      url: `/v1/planning/candidates/${c.id}/accept`,
      headers,
      payload: {},
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("BASELINE");
    expect(f.store.get("tasks.acceptedPlan")).toBeUndefined();
  } finally {
    await app.close();
  }
});
