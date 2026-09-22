import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { modelFixture } from "../model-helpers";
import { brief } from "../research-helpers";
import { ResearchStore } from "../../apps/service/src/research/brief";
import { Proposals } from "../../apps/service/src/review/proposals";
import { Snapshots } from "../../apps/service/src/research/snapshots";
import {
  Chapters,
  type ResearchProvider,
} from "../../apps/service/src/research/chapters";
import { digest } from "../../apps/service/src/workspace/registry";
import { Scope } from "@kb/contracts";
import { Store } from "../../apps/service/src/storage/store";
import { WorkspaceRegistry } from "../../apps/service/src/workspace/registry";
import { EvidenceStore } from "../../apps/service/src/evidence/locator";
import { join } from "node:path";
async function setup() {
  const { f, e } = await modelFixture(),
    db = new ResearchStore(new Proposals(e));
  const b = brief({
    questions: [1, 2].map((n) => ({
      id: randomUUID(),
      question: `权限问题 ${n}`,
      query: "权限",
      counterQuery: "权限",
      scope: Scope.parse({}),
      requiredTypes: ["text"],
    })),
  });
  const r = db.confirm(
      { operationId: randomUUID(), brief: b, digest: digest(b) },
      f.principal,
    ),
    snapshots = new Snapshots(db),
    s = await snapshots.propose(r.id, f.principal);
  snapshots.advance(r.id, s.id, s.digest, f.principal);
  return { f, db, b, r, s };
}
test("concurrent chapters share one root reservation; exhausting 100 prevents a second 60-cost dispatch", async () => {
  const { f, db, b, r, s } = await setup();
  let dispatched = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: ResearchProvider = {
    model: "test-only",
    generate: async (pack) => {
      dispatched++;
      await gate;
      return {
        requestId: randomUUID(),
        cost: 60,
        value: {
          claims: pack.evidence.map((e) => ({
            id: randomUUID(),
            text: e.text,
            kind: "sourced",
            scope: e.profile.scope,
            evidenceIds: [e.id],
          })),
          unresolved: [],
        },
      };
    },
  };
  const chapters = new Chapters(db, new Map([["test-model", provider]]));
  try {
    const first = chapters.generate(
      r.id,
      b.questions[0]!.id,
      { operationId: randomUUID(), snapshotId: s.id, routeId: "test-model" },
      f.principal,
    );
    await expect(
      chapters.generate(
        r.id,
        b.questions[1]!.id,
        { operationId: randomUUID(), snapshotId: s.id, routeId: "test-model" },
        f.principal,
      ),
    ).rejects.toThrow("BUDGET");
    expect(dispatched).toBe(1);
    release();
    await first;
    expect(db.usage(db.get(r.id, f.principal))).toMatchObject({
      actual: 60,
      reserved: 0,
      calls: 2,
      rootId: r.rootId,
    });
    expect(
      f.store.db.prepare("SELECT DISTINCT root_id FROM calls").all(),
    ).toEqual([{ root_id: r.rootId }]);
    await expect(
      chapters.generate(
        r.id,
        b.questions[1]!.id,
        { operationId: randomUUID(), snapshotId: s.id, routeId: "test-model" },
        f.principal,
      ),
    ).rejects.toThrow("BUDGET");
  } finally {
    release();
    await f.close();
  }
});
test("cancellation keeps completed chapters and settles a late receipt without accepting cancelled output; database reopen preserves root", async () => {
  const { f, db, b, r, s } = await setup();
  let resolve!: (v: {
    requestId: string;
    cost: number;
    value: unknown;
  }) => void;
  const provider: ResearchProvider = {
    model: "test-only",
    generate: () =>
      new Promise((r) => {
        resolve = r;
      }),
  };
  const chapters = new Chapters(db, new Map([["test-model", provider]]));
  try {
    const done = await chapters.generate(
      r.id,
      b.questions[0]!.id,
      { operationId: randomUUID(), snapshotId: s.id },
      f.principal,
    );
    const pending = chapters.generate(
      r.id,
      b.questions[1]!.id,
      { operationId: randomUUID(), snapshotId: s.id, routeId: "test-model" },
      f.principal,
    );
    const rejected = expect(pending).rejects.toThrow();
    chapters.cancel(r.id, f.principal);
    await rejected;
    expect(db.usage(db.get(r.id, f.principal)).reserved).toBe(60);
    resolve({
      requestId: randomUUID(),
      cost: 60,
      value: { claims: [], unresolved: [] },
    });
    await new Promise((r) => setImmediate(r));
    expect(db.usage(db.get(r.id, f.principal)).actual).toBe(60);
    expect(chapters.get(s, b.questions[0]!.id)).toEqual(done);
    expect(chapters.get(s, b.questions[1]!.id)).toBeUndefined();
    f.store.close();
    const reopened = new Store(join(f.data, "state.db"));
    try {
      const next = new ResearchStore(
        new Proposals(
          new EvidenceStore(new WorkspaceRegistry(reopened, f.data)),
        ),
      );
      expect(next.get(r.id, f.principal).rootId).toBe(r.rootId);
      expect(next.usage(next.get(r.id, f.principal))).toMatchObject({
        actual: 60,
        calls: 1,
      });
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});

test("maximum model unresolved items remain valid when report adds separate coverage gaps", async () => {
  const { f, db, b, r, s } = await setup();
  try {
    const provider: ResearchProvider = {
      model: "test-only",
      generate: async (pack) => ({
        requestId: randomUUID(),
        cost: 60,
        value: {
          claims: pack.evidence.map((e) => ({
            id: randomUUID(),
            text: e.text,
            kind: "sourced",
            scope: e.profile.scope,
            evidenceIds: [e.id],
          })),
          unresolved: Array.from({ length: 20 }, (_, i) => `待核验 ${i}`),
        },
      }),
    };
    const chapters = new Chapters(db, new Map([["test-model", provider]]));
    await chapters.generate(
      r.id,
      b.questions[0]!.id,
      { operationId: randomUUID(), snapshotId: s.id, routeId: "test-model" },
      f.principal,
    );
    const { Artifacts } =
      await import("../../apps/service/src/research/artifacts");
    const report = new Artifacts(db).freeze(r.id, f.principal);
    expect(report.chapters[0]!.unresolved).toHaveLength(20);
    expect(report.coverage[0]!.gaps.join()).toContain("尚未人工");
    expect(report.checks.warnings.join()).toContain("待核验 19");
  } finally {
    await f.close();
  }
});
