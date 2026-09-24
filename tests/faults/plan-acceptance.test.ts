import { afterEach, expect, it } from "vitest";
import { taskFixture, fact } from "../task-helpers";
import { planningSnapshot } from "../../apps/service/src/planning/snapshot";
import { solve } from "../../apps/service/src/planning/solver";
import { PlanningLedger } from "../../apps/service/src/planning/accept";
import { undoCandidate } from "../../apps/service/src/planning/undo";
import { PlanNotes } from "../../apps/service/src/planning/notes";
import { today } from "../../apps/service/src/tasks/today";
import { Store } from "../../apps/service/src/storage/store";
import { join } from "node:path";
import type { PlanningRequest } from "@kb/contracts";
const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const x of open.splice(0)) await x.close();
});
const request = (): PlanningRequest => ({
  timezone: "Asia/Shanghai",
  windows: [
    {
      start: new Date(Date.now() + 60000).toISOString(),
      end: new Date(Date.now() + 7200000).toISOString(),
    },
  ],
  unavailable: [],
  calendarIds: [],
  policy: { maxNodes: 100, freezeMinutes: 0, freshnessMs: 30000 },
});
it("只能采用一个旧基线，重试返回同一版本，撤销产生新版本并保留任务", async () => {
  const f = await taskFixture();
  open.push(f);
  const t = fact();
  f.inventory([t]);
  const ledger = new PlanningLedger(f.db);
  const a = ledger.save(
    solve(
      await planningSnapshot(
        f.db,
        request(),
        f.principal.policyVersion,
        f.principal.epoch,
      ),
    ),
    f.principal,
  );
  const b = ledger.save(
    solve(
      await planningSnapshot(
        f.db,
        request(),
        f.principal.policyVersion,
        f.principal.epoch,
      ),
    ),
    f.principal,
  );
  expect(a.blocks).toHaveLength(1);
  const first = await ledger.accept(a.id, f.principal);
  expect(
    today(f.db)
      .receipts.map((r) => [r.target, r.state])
      .sort(),
  ).toEqual([
    ["calendar", "disabled"],
    ["note", "pending"],
    ["reminder", "disabled"],
    ["task", "disabled"],
  ]);
  expect((await ledger.accept(a.id, f.principal)).planId).toBe(first.planId);
  await expect(ledger.accept(b.id, f.principal)).rejects.toMatchObject({
    code: "BASELINE",
  });
  expect(f.store.get("tasks.acceptedPlan")).toBe(first.planId);
  const notes = new PlanNotes(ledger);
  expect(notes.pending(f.principal)).toEqual([first.planId]);
  const grant = notes.grant(first.planId, f.principal);
  expect(grant.patch.path).toBe(`KB-Plans/${first.planId}.md`);
  expect(
    notes.receipt(
      first.planId,
      grant.token,
      grant.patch.afterHash,
      f.principal,
    ),
  ).toEqual({ state: "applied" });
  const undo = await undoCandidate(ledger, f.principal);
  expect(undo.diff.removed).toContain(t.taskId);
  const restored = await ledger.accept(undo.id, f.principal);
  expect(restored.planId).not.toBe(first.planId);
  expect(f.db.head().complete).toBe(true);
});
it("采用前的任务修改使候选失效", async () => {
  const f = await taskFixture();
  open.push(f);
  const t = fact();
  f.inventory([t]);
  const ledger = new PlanningLedger(f.db);
  const c = ledger.save(
    solve(
      await planningSnapshot(
        f.db,
        request(),
        f.principal.policyVersion,
        f.principal.epoch,
      ),
    ),
    f.principal,
  );
  f.inventory([fact({ ...t, minutes: 45 })]);
  await expect(ledger.accept(c.id, f.principal)).rejects.toMatchObject({
    code: "BASELINE",
  });
  expect(f.store.get("tasks.acceptedPlan")).toBeUndefined();
});
it("完整重读同一批 TaskNotes 事实不会误使候选失效", async () => {
  const f = await taskFixture();
  open.push(f);
  const t = fact();
  f.inventory([t]);
  const ledger = new PlanningLedger(f.db);
  const c = ledger.save(
    solve(
      await planningSnapshot(
        f.db,
        request(),
        f.principal.policyVersion,
        f.principal.epoch,
      ),
    ),
    f.principal,
  );
  f.inventory([t]);
  expect(f.db.head().generation).toBeGreaterThan(c.snapshot.generation);
  expect((await ledger.accept(c.id, f.principal)).planId).toBeTruthy();
});
it("采用后任务资源变化使 Today 隐藏旧未来块，不产生额外取消命令", async () => {
  const f = await taskFixture();
  open.push(f);
  const t = fact();
  f.inventory([t]);
  const ledger = new PlanningLedger(f.db);
  const c = ledger.save(
    solve(
      await planningSnapshot(
        f.db,
        request(),
        f.principal.policyVersion,
        f.principal.epoch,
      ),
    ),
    f.principal,
  );
  await ledger.accept(c.id, f.principal);
  expect(today(f.db).plan?.blocks).toHaveLength(1);
  f.inventory([{ ...t, planLocation: "办公室" }]);
  expect(today(f.db).plan?.blocks).toHaveLength(0);
  expect(today(f.db).risks.join(" ")).toMatch(/重新预览/);
  expect(
    f.store.db.prepare("SELECT count(*) AS n FROM task_cancel_outbox").get(),
  ).toEqual({ n: 0 });
});
it("正式版本与笔记 outbox 进程重开后仍可读；已完成任务撤销不复活", async () => {
  const f = await taskFixture();
  open.push(f);
  const t = fact();
  f.inventory([t]);
  const ledger = new PlanningLedger(f.db);
  const c = ledger.save(
    solve(
      await planningSnapshot(
        f.db,
        request(),
        f.principal.policyVersion,
        f.principal.epoch,
      ),
    ),
    f.principal,
  );
  const accepted = await ledger.accept(c.id, f.principal);
  const reopened = new Store(join(f.data, "state.db"));
  try {
    expect(reopened.get("tasks.acceptedPlan")).toBe(accepted.planId);
    expect(
      reopened.db
        .prepare("SELECT state FROM plan_outbox WHERE id=?")
        .get(`note:${accepted.planId}`),
    ).toEqual({ state: "pending" });
  } finally {
    reopened.close();
  }
  f.inventory([{ ...t, lifecycle: "done" }]);
  const undo = await undoCandidate(ledger, f.principal);
  expect(undo.blocks).toEqual([]);
  expect(undo.snapshot.tasks).toEqual([]);
  await ledger.accept(undo.id, f.principal);
  expect(
    today(f.db).tasks.find((x) => x.taskId === t.taskId)?.fact.lifecycle,
  ).toBe("done");
});
