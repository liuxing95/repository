import { lstatSync, readlinkSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceRegistry } from "../workspace/registry";
import type { PublicationRelease } from "./release";

function releases(registry: WorkspaceRegistry) {
  const rows = registry.store.db
    .prepare(
      "SELECT value FROM kv WHERE key LIKE 'publication:release:%' ORDER BY rowid DESC",
    )
    .all() as { value: string }[];
  return rows.map((r) => JSON.parse(r.value) as PublicationRelease);
}

export function publicationImpact(
  registry: WorkspaceRegistry,
  sourceId: string,
) {
  return releases(registry)
    .filter((r) => r.sourceIds.includes(sourceId))
    .map((r) => ({
      releaseId: r.id,
      state: r.state,
      target: r.target,
      action:
        r.state === "published-local" || r.state === "needs-takedown"
          ? "下架或替换公开副本并核对外部缓存"
          : "核对历史副本与下载",
    }));
}

export function retractPublications(
  registry: WorkspaceRegistry,
  sourceId: string,
) {
  const affected = releases(registry).filter((r) =>
    r.sourceIds.includes(sourceId),
  );
  if (!affected.length) return publicationImpact(registry, sourceId);
  const root = join(registry.dataPath, "public-site");
  const link = join(root, "current");
  const current = registry.store.get("publication:current") as
    { id: string } | null | undefined;
  let linkedId: string | null = null;
  try {
    if (lstatSync(link).isSymbolicLink())
      linkedId =
        readlinkSync(link).match(/^releases\/([a-f\d-]{36})$/)?.[1] ?? null;
  } catch {
    /* no active local link */
  }
  const activeId = linkedId ?? current?.id;
  for (const release of affected) {
    const key = `publication:release:${release.id}`;
    release.state = "needs-takedown";
    registry.store.set(key, release);
    try {
      if (release.id === activeId) {
        if (!lstatSync(link).isSymbolicLink())
          throw new Error("current is not a managed link");
        unlinkSync(link);
        registry.store.set("publication:current", null);
      }
      rmSync(join(root, "releases", release.id), {
        recursive: true,
        force: true,
      });
      release.state = "withdrawn";
      registry.store.set(key, release);
      registry.store.event("publication.withdrawn-local", release.id);
    } catch {
      registry.store.event("publication.takedown-required", release.id);
    }
  }
  return publicationImpact(registry, sourceId);
}
