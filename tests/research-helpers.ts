import { randomUUID } from "node:crypto";
import { ResearchBrief, Scope } from "@kb/contracts";
import { wikiFixture } from "./wiki-helpers";
import { ResearchStore } from "../apps/service/src/research/brief";
import { Snapshots } from "../apps/service/src/research/snapshots";
import { Chapters } from "../apps/service/src/research/chapters";
import { Artifacts } from "../apps/service/src/research/artifacts";
import { digest } from "../apps/service/src/workspace/registry";
export function brief(overrides: Record<string, unknown> = {}) {
  return ResearchBrief.parse({
    topic: "权限研究",
    audience: "新接手的开发者",
    outputType: "overview",
    questions: [
      {
        id: randomUUID(),
        question: "权限有什么限制？",
        query: "权限",
        counterQuery: "权限 限制",
        scope: Scope.parse({}),
        requiredTypes: ["text"],
      },
    ],
    scopes: [{}],
    timeIntent: "current",
    mode: "library_only",
    limits: {
      cost: 100,
      calls: 2,
      discoveries: 0,
      materials: 10,
      chapters: 10,
    },
    ...overrides,
  });
}
export async function researchFixture(overrides: Record<string, unknown> = {}) {
  const f = await wikiFixture(),
    db = new ResearchStore(f.proposals),
    snapshots = new Snapshots(db),
    chapters = new Chapters(db),
    artifacts = new Artifacts(db),
    b = brief(overrides);
  const r = db.confirm(
    { operationId: randomUUID(), brief: b, digest: digest(b) },
    f.principal,
  );
  const activate = async () => {
    const s = await snapshots.propose(r.id, f.principal);
    snapshots.advance(r.id, s.id, s.digest, f.principal);
    return s;
  };
  return { ...f, db, snapshots, chapters, artifacts, r, b, activate };
}
