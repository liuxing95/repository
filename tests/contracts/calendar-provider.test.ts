import { expect, it } from "vitest";
import {
  parseFreeBusy,
  readBusy,
} from "../../apps/service/src/calendar/freebusy";
it("逐日历错误即使整体成功仍视作覆盖未知，并排除自己的计划日历", async () => {
  const now = Date.now(),
    end = now + 3600000;
  const response = {
    calendars: {
      meeting: {
        busy: [
          {
            start: new Date(now + 1000).toISOString(),
            end: new Date(now + 2000).toISOString(),
          },
        ],
      },
      broken: { errors: [{ reason: "notFound" }], busy: [] },
      "kb-plan": {
        busy: [
          {
            start: new Date(now).toISOString(),
            end: new Date(end).toISOString(),
          },
        ],
      },
    },
  };
  const result = parseFreeBusy(
    response,
    ["meeting", "broken", "kb-plan"],
    "kb-plan",
    now,
    end,
    now,
  );
  expect(result.coverage.state).toBe("unknown");
  expect(result.coverage.calendarIds).toEqual(["meeting", "broken"]);
  expect(result.busy).toHaveLength(1);
  expect(
    (await readBusy(undefined, ["meeting"], now, end, now)).coverage.state,
  ).toBe("unknown");
  expect((await readBusy(undefined, [], now, end, now)).coverage.state).toBe(
    "unconnected",
  );
});
