import { randomUUID } from "node:crypto";
import {
  AcquisitionPlan,
  type CollectionManifest,
  type ManifestEntry,
  type Parsed,
} from "@kb/contracts";
import { fixture } from "./helpers";
import { hashBytes, putObject } from "../apps/service/src/ingestion/objects";
import { Ingestion } from "../apps/service/src/ingestion/manifest";
import { SourceCommit } from "../apps/service/src/ingestion/commit";
// Fixture content enters the same immutable register / approval / receipt transaction used by ingestion.
export function publish(
  f: Awaited<ReturnType<typeof fixture>>,
  text: string,
  title = "原文",
  extra: Record<string, string> = {},
  blockTexts = [text],
) {
  const ingestion = new Ingestion(f.registry, f.jobs);
  const id = randomUUID();
  const original = `https://fixtures.invalid/${id}`;
  const entry: ManifestEntry = {
    id: randomUUID(),
    identity: `text:${original}`,
    original,
    final: original,
    kind: "text",
    via: ["fixture"],
    selected: true,
    status: "acquired",
    objectHash: putObject(f.store, Buffer.from(text)),
    fetchedAt: Date.now(),
    metadata: { kind: "text", ...extra },
  };
  let offset = 0;
  const parsed: Parsed = {
    title,
    parser: "fixture-v1",
    encoding: "utf-8",
    locatorVersion: 1,
    text,
    blocks: blockTexts.map((body, i) => {
      const block = {
        id: `b${i}`,
        text: body,
        hash: hashBytes(body),
        start: offset,
        end: offset + body.length,
        kind: "text" as const,
        locator: { lineStart: i + 1, lineEnd: i + 1 },
      };
      offset += body.length + 1;
      return block;
    }),
    gaps: [],
    links: [],
    canonicalClaim: null,
    declaredPublishedAt: null,
    confirmedPublishedAt: null,
    publicationEvidence: null,
  };
  const artifact = ingestion.register(entry, parsed, "utf-8");
  const batch: CollectionManifest = {
    id,
    plan: AcquisitionPlan.parse({ id, kind: "text", entry: original }),
    digest: hashBytes(text),
    state: "ready",
    entries: [entry],
    warnings: [],
    previousMissing: [],
    createdAt: Date.now(),
    finishedAt: Date.now(),
    jobId: null,
    policyVersion: f.registry.get().policyVersion,
    epoch: f.registry.get().epoch,
    principalId: f.principal.id,
    selectedCount: 1,
  };
  f.store.db
    .prepare("INSERT INTO ingestions VALUES(?,?,?)")
    .run(id, batch.digest, JSON.stringify(batch));
  const commits = new SourceCommit(ingestion);
  const change = commits.prepare(id);
  commits.approve(change.id, change.digest, f.principal);
  for (const patch of change.patches) {
    const grant = commits.grant(change.id, patch.sequence, f.principal);
    commits.receipt(grant.token, patch.afterHash, f.principal);
  }
  commits.finish(
    change.id,
    change.patches.map((p) => p.afterHash),
    f.principal,
  );
  return { ...artifact, committed: true };
}
