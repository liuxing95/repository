import {
  Claim,
  Profile,
  Relation,
  Scope,
  SourcePolicy,
  type Evidence,
  type EvidenceRead,
  type ParseArtifact,
  type Principal,
  type SourceRevision,
} from "@kb/contracts";
import { SourceCommit } from "../ingestion/commit";
import { Ingestion } from "../ingestion/manifest";
import { hashBytes } from "../ingestion/objects";
import { Jobs } from "../runtime/jobs";
import { authorize } from "../http/auth";
import { WorkspaceRegistry, digest } from "../workspace/registry";
import { AppError } from "../errors";
import { compareScope } from "./scope";
export class EvidenceStore {
  readonly commits: SourceCommit;
  constructor(readonly registry: WorkspaceRegistry) {
    this.commits = new SourceCommit(
      new Ingestion(registry, new Jobs(registry.store)),
    );
  }
  get store() {
    return this.registry.store;
  }
  checkPrincipal(p: Principal) {
    authorize(this.registry, p, ["admin", "user", "reader"]);
    const row = this.store.db
      .prepare(
        "SELECT 1 FROM sessions WHERE json_extract(principal,'$.id')=? AND revoked=0",
      )
      .get(p.id);
    if (!row) throw new AppError("AUTH", 401);
  }
  readable(sourceId: string) {
    const raw = this.store.get(`source:${sourceId}`);
    if (raw === undefined) return true; // Adopted local sources are readable until explicitly restricted.
    const p = SourcePolicy.safeParse(raw);
    return (
      p.success && !p.data.retracted && p.data.routes.read.includes("local")
    );
  }
  revision(id: string): SourceRevision {
    const r = this.store.db
      .prepare("SELECT value FROM source_revisions WHERE id=? AND committed=1")
      .get(id) as { value: string } | undefined;
    if (!r) throw new AppError("NOT_FOUND", 404);
    const value = JSON.parse(r.value) as SourceRevision;
    if (!this.readable(value.sourceId)) throw new AppError("FORBIDDEN", 403);
    return value;
  }
  profile(parseId: string): Profile {
    const row = this.store.db
      .prepare("SELECT value FROM evidence_profiles WHERE parse_id=?")
      .get(parseId) as { value: string } | undefined;
    if (row) return Profile.parse(JSON.parse(row.value));
    const parse = this.commits.parse(parseId);
    const revision = this.revision(parse.revisionId);
    const meta = revision.metadata;
    const known = (v: unknown) =>
      typeof v === "string" && v !== "unknown" ? v : null;
    return Profile.parse({
      scope: {
        ...Scope.parse({}),
        version: known(meta.version),
        sourceType: known(meta.kind) ?? revision.identity.split(":")[0] ?? null,
      },
      collection: known(meta.collection) ?? "默认集合",
    });
  }
  family(source: string): string {
    const visited = new Set<string>();
    while (true) {
      if (visited.has(source)) throw new AppError("SOURCE_CYCLE");
      visited.add(source);
      const row = this.store.db
        .prepare("SELECT parent FROM source_lineage WHERE child=?")
        .get(source) as { parent: string } | undefined;
      if (!row) return source;
      source = row.parent;
    }
  }
  setFamily(child: string, parent: string) {
    this.store.tx(() => {
      if (!this.readable(child) || !this.readable(parent))
        throw new AppError("FORBIDDEN", 403);
      if (child === parent) throw new AppError("SOURCE_CYCLE");
      this.store.db
        .prepare(
          "INSERT INTO source_lineage VALUES(?,?) ON CONFLICT(child) DO UPDATE SET parent=excluded.parent",
        )
        .run(child, parent);
      this.family(child);
      this.store.event("evidence.profile.changed", child);
    });
  }
  setProfile(parseId: string, value: unknown) {
    return this.store.tx(() => {
      const profile = Profile.parse(value);
      if (profile.confirmedPublishedAt && !profile.publicationEvidence)
        throw new AppError(
          "VALIDATION",
          400,
          "确认公开时间时必须记录核对依据。",
        );
      const parse = this.commits.parse(parseId);
      if (!parse.committed) throw new AppError("BASELINE");
      this.revision(parse.revisionId);
      for (const id of profile.originalEvidence) {
        const original = this.read(id);
        if (
          original.parseId === parseId ||
          original.profile.kind !== "original"
        )
          throw new AppError("SOURCE_CYCLE");
      }
      this.store.db
        .prepare(
          "INSERT INTO evidence_profiles VALUES(?,?) ON CONFLICT(parse_id) DO UPDATE SET value=excluded.value",
        )
        .run(parseId, JSON.stringify(profile));
      this.store.event("evidence.profile.changed", parseId);
      return profile;
    });
  }
  register(parsed: ParseArtifact) {
    const rev = this.revision(parsed.revisionId);
    if (!parsed.committed) throw new AppError("BASELINE");
    return parsed.blocks.map((block) => {
      const value = {
        parseId: parsed.id,
        revisionId: rev.id,
        sourceId: rev.sourceId,
        blockId: block.id,
        start: block.start,
        end: block.end,
        hash: block.hash,
        parseHash: parsed.objectHash,
        originalHash: rev.objectHash,
        locator: block.locator,
      };
      const item: Evidence = { id: digest(value), ...value };
      this.store.db
        .prepare("INSERT OR IGNORE INTO evidence VALUES(?,?,?)")
        .run(item.id, parsed.id, JSON.stringify(item));
      return item;
    });
  }
  read(id: string, cache = new Map<string, ParseArtifact>()): EvidenceRead {
    const row = this.store.db
      .prepare("SELECT value FROM evidence WHERE id=?")
      .get(id) as { value: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    const item = JSON.parse(row.value) as Evidence;
    const identity = {
      parseId: item.parseId,
      revisionId: item.revisionId,
      sourceId: item.sourceId,
      blockId: item.blockId,
      start: item.start,
      end: item.end,
      hash: item.hash,
      parseHash: item.parseHash,
      originalHash: item.originalHash,
      locator: item.locator,
    };
    if (item.id !== id || digest(identity) !== id)
      throw new AppError("HASH_MISMATCH");
    const revision = this.revision(item.revisionId);
    const parsed = cache.get(item.parseId) ?? this.commits.parse(item.parseId);
    cache.set(item.parseId, parsed);
    const block = parsed.blocks.find((b) => b.id === item.blockId);
    if (
      !parsed.committed ||
      parsed.revisionId !== revision.id ||
      revision.sourceId !== item.sourceId ||
      revision.objectHash !== item.originalHash ||
      parsed.objectHash !== item.parseHash ||
      !block ||
      block.start !== item.start ||
      block.end !== item.end ||
      digest(block.locator) !== digest(item.locator) ||
      hashBytes(parsed.text.slice(item.start, item.end)) !== item.hash
    )
      throw new AppError("HASH_MISMATCH");
    const profile = this.profile(item.parseId);
    return {
      ...item,
      text: block.text,
      context: parsed.text.slice(Math.max(0, item.start - 200), item.end + 200),
      title: parsed.title,
      familyId: this.family(item.sourceId),
      profile,
      original: revision.original,
      fetchedAt: revision.fetchedAt,
      declaredPublishedAt: parsed.declaredPublishedAt,
      confirmedPublishedAt:
        profile.confirmedPublishedAt ?? parsed.confirmedPublishedAt,
      gaps: parsed.gaps,
    };
  }
  saveClaim(value: unknown) {
    const claim = Claim.parse(value);
    if (claim.kind === "sourced" && !claim.evidenceIds.length)
      throw new AppError("UNSUPPORTED_CLAIM");
    for (const id of claim.evidenceIds) this.read(id);
    const previous = this.store.db
      .prepare("SELECT value FROM evidence_claims WHERE id=?")
      .get(claim.id) as { value: string } | undefined;
    if (previous && digest(JSON.parse(previous.value)) !== digest(claim))
      throw new AppError(
        "CONFLICT",
        409,
        "主张内容固定；修改时创建新主张并明确关联旧版本。",
      );
    this.store.db
      .prepare("INSERT OR IGNORE INTO evidence_claims VALUES(?,?)")
      .run(claim.id, JSON.stringify(claim));
    return claim;
  }
  relation(value: unknown) {
    const relation = Relation.parse(value);
    const claims = [relation.from, relation.to].map((id) => {
      const row = this.store.db
        .prepare("SELECT value FROM evidence_claims WHERE id=?")
        .get(id) as { value: string } | undefined;
      if (!row) throw new AppError("NOT_FOUND", 404);
      const claim = Claim.parse(JSON.parse(row.value));
      for (const id of claim.evidenceIds) this.read(id);
      return claim;
    });
    if (
      relation.from === relation.to ||
      (relation.type === "contradicts" &&
        compareScope(claims[0]!.scope, claims[1]!.scope) !== "overlap")
    )
      throw new AppError("SCOPE_UNKNOWN");
    this.store.db
      .prepare("INSERT OR IGNORE INTO evidence_relations VALUES(?,?,?)")
      .run(relation.from, relation.to, relation.type);
    return relation;
  }
}
