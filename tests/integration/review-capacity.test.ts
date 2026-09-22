import { test, expect, vi } from "vitest";
import { learningFixture } from "../learning-helpers";
import { Suggestions } from "../../apps/service/src/learning/review-suggestions";
import {
  Capacity,
  capacityDay,
  type LearningTaskAdapter,
} from "../../apps/service/src/learning/capacity";
import { Store } from "../../apps/service/src/storage/store";
import { WorkspaceRegistry } from "../../apps/service/src/workspace/registry";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
import { Proposals } from "../../apps/service/src/review/proposals";
import { LearningStore } from "../../apps/service/src/learning/goals";
import { join } from "node:path";
async function ready() {
  const f = await learningFixture();
  for (const u of f.input.units) {
    f.select(u.id);
    f.record(u.id);
  }
  f.db.configure(
    { capacity: null, review: { intervalDays: 1, windowDays: 3, minutes: 20 } },
    f.principal,
  );
  const suggestions = new Suggestions(f.db),
    ids = suggestions.generate(f.b.goalId, f.principal).created;
  f.advance(86400001);
  return { ...f, suggestions, ids };
}
const configure = (
  f: Awaited<ReturnType<typeof ready>>,
  wip = 1,
  dayMinutes = 30,
) =>
  f.db.configure(
    {
      capacity: { wip, dayMinutes, timezone: "Asia/Shanghai" },
      review: { intervalDays: 1, windowDays: 3, minutes: 20 },
    },
    f.principal,
  );
test("no config or adapter means suggestions only; skips and pauses survive regeneration", async () => {
  const f = await ready();
  try {
    await expect(
      new Capacity(f.db).create(f.ids[0]!, f.principal),
    ).rejects.toThrow("CAPACITY_UNCONFIGURED");
    configure(f);
    await expect(
      new Capacity(f.db).create(f.ids[0]!, f.principal),
    ).rejects.toThrow("TASK_ADAPTER_UNAVAILABLE");
    f.suggestions.decide(
      f.ids[0]!,
      { state: "skipped", reason: "已经熟悉" },
      f.principal,
    );
    f.record();
    expect(f.suggestions.generate(f.b.goalId, f.principal).created).toEqual([]);
    expect(f.suggestions.raw(f.ids[0]!).state).toBe("skipped");
    expect(
      f.store.db.prepare("SELECT count(*) n FROM learning_task_intents").get(),
    ).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});
test("concurrent confirmations share persistent reservations and stable task IDs; unknown requests are not retried after restart", async () => {
  const f = await ready();
  try {
    configure(f);
    let sent = 0;
    const adapter: LearningTaskAdapter = {
      snapshot: async () => ({
        complete: true,
        observedAt: f.db.now(),
        tasks: [],
      }),
      create: async () => {
        sent++;
        return { state: "unknown" };
      },
      lookup: async (taskId) => ({ state: "created", taskId }),
    };
    const capacity = new Capacity(f.db, adapter);
    const results = await Promise.allSettled(
      f.ids.map((id) => capacity.create(id, f.principal)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(sent).toBe(1);
    const intent = (
      results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<
        Awaited<ReturnType<Capacity["create"]>>
      >
    ).value;
    expect(intent.state).toBe("unknown");
    f.store.close();
    const reopened = new Store(join(f.data, "state.db"));
    try {
      const db = new LearningStore(
          new Proposals(
            new EvidenceStore(new WorkspaceRegistry(reopened, f.data)),
          ),
          f.db.now,
        ),
        resumed = new Capacity(db, adapter);
      expect((await resumed.create(intent.suggestionId, f.principal)).id).toBe(
        intent.id,
      );
      expect(sent).toBe(1);
      expect(await resumed.reconcile(intent.id, f.principal)).toMatchObject({
        state: "created",
        taskId: intent.taskId,
      });
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});
test("definitive not-created releases capacity; timeout holds it; external WIP and incomplete observations block dispatch", async () => {
  const f = await ready();
  try {
    configure(f, 2, 20);
    const adapter: LearningTaskAdapter = {
      snapshot: async () => ({
        complete: true,
        observedAt: f.db.now(),
        tasks: [],
      }),
      create: vi.fn(async () => ({ state: "not-created" as const })),
      lookup: async () => ({ state: "unknown" }),
    };
    const capacity = new Capacity(f.db, adapter, 10);
    expect((await capacity.create(f.ids[0]!, f.principal)).state).toBe(
      "failed",
    );
    adapter.create = async () => new Promise(() => {});
    expect((await capacity.create(f.ids[1]!, f.principal)).state).toBe(
      "unknown",
    );
    expect(
      f.store.db
        .prepare(
          "SELECT count(*) n FROM learning_task_intents WHERE json_extract(value,'$.state')!='failed'",
        )
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    await f.close();
  }
  const g = await ready();
  try {
    configure(g);
    const create = vi.fn();
    const adapter: LearningTaskAdapter = {
      snapshot: async () => ({
        complete: false,
        observedAt: g.db.now(),
        tasks: [],
      }),
      create,
      lookup: async () => ({ state: "unknown" }),
    };
    await expect(
      new Capacity(g.db, adapter).create(g.ids[0]!, g.principal),
    ).rejects.toThrow();
    adapter.snapshot = async () => ({
      complete: true,
      observedAt: g.db.now(),
      tasks: [
        { taskId: crypto.randomUUID(), active: true, day: null, minutes: 0 },
      ],
    });
    await expect(
      new Capacity(g.db, adapter).create(g.ids[0]!, g.principal),
    ).rejects.toThrow("CAPACITY");
    expect(create).not.toHaveBeenCalled();
  } finally {
    await g.close();
  }
});
test("capacity dates use configured natural day across DST, not a UTC date", () => {
  expect(
    capacityDay(Date.parse("2026-03-09T03:30:00Z"), "America/New_York"),
  ).toBe("2026-03-08");
  expect(
    capacityDay(Date.parse("2026-03-09T04:30:00Z"), "America/New_York"),
  ).toBe("2026-03-09");
});

test("turning capacity off cannot allow a new timezone over an existing reservation", async () => {
  const f = await ready();
  try {
    configure(f);
    const adapter: LearningTaskAdapter = {
      snapshot: async () => ({
        complete: true,
        observedAt: f.db.now(),
        tasks: [],
      }),
      create: async () => ({ state: "unknown" }),
      lookup: async () => ({ state: "unknown" }),
    };
    await new Capacity(f.db, adapter).create(f.ids[0]!, f.principal);
    f.db.configure({ capacity: null, review: null }, f.principal);
    expect(() =>
      f.db.configure(
        { capacity: { wip: 1, dayMinutes: 30, timezone: "UTC" }, review: null },
        f.principal,
      ),
    ).toThrow("BASELINE");
  } finally {
    await f.close();
  }
});
test("reconciliation cannot release a reservation while its create request is still in flight", async () => {
  const f = await ready();
  try {
    configure(f);
    let finish!: (value: { state: "created"; taskId: string }) => void;
    const lookup = vi.fn(async () => ({ state: "not-created" as const }));
    const adapter: LearningTaskAdapter = {
      snapshot: async () => ({
        complete: true,
        observedAt: f.db.now(),
        tasks: [],
      }),
      create: async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      lookup,
    };
    const capacity = new Capacity(f.db, adapter),
      promise = capacity.create(f.ids[0]!, f.principal);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const row = f.store.db
      .prepare("SELECT id FROM learning_task_intents")
      .get() as { id: string };
    try {
      expect((await capacity.reconcile(row.id, f.principal)).state).toBe(
        "reserved",
      );
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      finish({ state: "created", taskId: capacity.intent(row.id).taskId });
      await promise;
    }
  } finally {
    await f.close();
  }
});
