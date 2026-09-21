import { randomBytes, randomUUID } from "node:crypto";
import type {
  ChangeSet,
  WriterGrant,
  Principal,
  ParseArtifact,
  SourceDetail,
  SourceRevision,
} from "@kb/contracts";
import { Ingestion } from "./manifest";
import { hashBytes, getObject } from "./objects";
import { AppError } from "../errors";
import { digest } from "../workspace/registry";
export class SourceCommit {
  constructor(
    readonly ingestion: Ingestion,
    readonly now = Date.now,
  ) {}
  get store() {
    return this.ingestion.registry.store;
  }
  get(id: string): ChangeSet {
    const row = this.store.db
      .prepare("SELECT value FROM changesets WHERE id=?")
      .get(id) as { value: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    const change = JSON.parse(row.value) as ChangeSet;
    change.receipts = (
      this.store.db
        .prepare(
          "SELECT sequence FROM writer_receipts WHERE change_id=? ORDER BY sequence",
        )
        .all(id) as { sequence: number }[]
    ).map((r) => r.sequence);
    return change;
  }
  save(change: ChangeSet) {
    this.store.writable();
    this.store.db
      .prepare("UPDATE changesets SET value=? WHERE id=?")
      .run(JSON.stringify(change), change.id);
  }
  prepare(batchId: string): ChangeSet {
    const batch = this.ingestion.get(batchId);
    if (batch.state !== "ready") throw new AppError("BASELINE");
    const entries = batch.entries.filter(
      (e) => e.selected && e.parseId && e.status !== "committed",
    );
    if (!entries.length) throw new AppError("EMPTY");
    const patches = entries.map((entry, sequence) => {
      const parsed = this.parse(entry.parseId!);
      const metadata = {
        source_revision: entry.revisionId,
        parse_id: entry.parseId,
        original_hash: entry.objectHash,
        original: entry.original,
        fetched_at: entry.fetchedAt,
        coverage: parsed.gaps.length ? "partial" : "text_available",
      };
      // Source material is fenced as text: untrusted Markdown must not transclude or execute.
      const fence = "`".repeat(
        Math.max(
          3,
          ...[...parsed.text.matchAll(/`+/g)].map((m) => m[0].length + 1),
        ),
      );
      const content = `---\n${Object.entries(metadata)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join(
          "\n",
        )}\n---\n\n# 来源原文\n\n定位请使用收录视图；此页是不可变来源投影。\n\n${fence}text\n${parsed.text}\n${fence}\n\n## 覆盖说明\n${parsed.gaps.map((g) => `- ${g}`).join("\n") || "已提取文本；不等于知识审核通过。"}\n`;
      return {
        sequence,
        path: `KB-Sources/${entry.parseId}.md`,
        beforeHash: null,
        afterHash: hashBytes(content),
        content,
        revisionId: entry.revisionId!,
        parseId: entry.parseId!,
      };
    });
    const workspace = this.ingestion.registry.get();
    const input = {
      batchId,
      patches,
      policyVersion: workspace.policyVersion,
      epoch: workspace.epoch,
    };
    const summary = digest(input);
    const existing = this.store.db
      .prepare(
        "SELECT id FROM changesets WHERE batch_id=? AND json_extract(value,'$.digest')=?",
      )
      .get(batchId, summary) as { id: string } | undefined;
    if (existing) return this.get(existing.id);
    const change: ChangeSet = {
      id: randomUUID(),
      ...input,
      digest: summary,
      state: "prepared",
      approvedBy: null,
      expiresAt: null,
      receipts: [],
    };
    this.store.db
      .prepare("INSERT INTO changesets VALUES(?,?,?)")
      .run(change.id, batchId, JSON.stringify(change));
    return change;
  }
  approve(id: string, expectedDigest: string, principal: Principal) {
    const change = this.get(id);
    this.ingestion.check(principal, change.policyVersion);
    if (
      change.digest !== expectedDigest ||
      change.epoch !== principal.epoch ||
      this.ingestion.get(change.batchId).state !== "ready"
    )
      throw new AppError("BASELINE");
    if (change.state === "committed") return change;
    change.approvedBy = principal.id;
    change.expiresAt = this.now() + 10 * 60_000;
    change.state = "approved";
    this.save(change);
    const batch = this.ingestion.get(change.batchId);
    for (const entry of batch.entries)
      if (change.patches.some((p) => p.parseId === entry.parseId))
        entry.status = "pending_write";
    this.ingestion.save(batch);
    this.store.event("source.approved", id);
    return change;
  }
  check(change: ChangeSet, principal: Principal) {
    this.ingestion.check(principal, change.policyVersion);
    if (
      change.state !== "approved" ||
      change.approvedBy !== principal.id ||
      (change.expiresAt ?? 0) <= this.now() ||
      change.epoch !== principal.epoch ||
      this.ingestion.get(change.batchId).state !== "ready"
    )
      throw new AppError(
        "APPROVAL_EXPIRED",
        409,
        "重新核对待写清单，并明确批准剩余提交。",
      );
    const batch = this.ingestion.get(change.batchId);
    for (const patch of change.patches) this.readable(patch.revisionId);
    if (
      change.patches.some(
        (p) =>
          !batch.entries.some(
            (e) =>
              e.parseId === p.parseId &&
              e.revisionId === p.revisionId &&
              e.selected,
          ),
      )
    )
      throw new AppError("BASELINE");
    const { batchId, patches, policyVersion, epoch } = change;
    if (change.digest !== digest({ batchId, patches, policyVersion, epoch }))
      throw new AppError("HASH_MISMATCH");
  }
  grant(id: string, sequence: number, principal: Principal): WriterGrant {
    const change = this.get(id);
    this.check(change, principal);
    const patch = change.patches.find((p) => p.sequence === sequence);
    if (!patch) throw new AppError("NOT_FOUND", 404);
    const grant: WriterGrant = {
      token: randomBytes(32).toString("base64url"),
      changeId: id,
      digest: change.digest,
      patch,
      vaultId: principal.vaultId,
      deviceId: principal.deviceId,
      epoch: principal.epoch,
      policyVersion: principal.policyVersion,
      expiresAt: Math.min(change.expiresAt!, this.now() + 60000),
    };
    this.store.db
      .prepare("INSERT INTO writer_grants VALUES(?,?,?,?)")
      .run(
        hashBytes(grant.token),
        id,
        principal.id,
        JSON.stringify({ ...grant, token: undefined }),
      );
    return grant;
  }
  receipt(token: string, afterHash: string, principal: Principal) {
    const row = this.store.db
      .prepare(
        "SELECT principal_id,value FROM writer_grants WHERE token_hash=?",
      )
      .get(hashBytes(token)) as
      { principal_id: string; value: string } | undefined;
    if (!row || row.principal_id !== principal.id)
      throw new AppError("FORBIDDEN", 403);
    const grant = JSON.parse(row.value) as WriterGrant;
    const change = this.get(grant.changeId);
    this.check(change, principal);
    if (
      grant.expiresAt <= this.now() ||
      grant.digest !== change.digest ||
      afterHash !== grant.patch.afterHash
    )
      throw new AppError("HASH_MISMATCH");
    this.store.db
      .prepare("INSERT OR IGNORE INTO writer_receipts VALUES(?,?,?)")
      .run(change.id, grant.patch.sequence, afterHash);
    return this.get(change.id);
  }
  finish(id: string, hashes: string[], principal: Principal) {
    return this.store.tx(() => {
      const change = this.get(id);
      if (change.state === "committed") return change;
      this.check(change, principal);
      if (
        hashes.length !== change.patches.length ||
        change.receipts.length !== change.patches.length ||
        change.patches.some((patch, i) => hashes[i] !== patch.afterHash)
      )
        throw new AppError("INCOMPLETE");
      const batch = this.ingestion.get(change.batchId);
      for (const patch of change.patches) {
        this.store.db
          .prepare("UPDATE source_revisions SET committed=1 WHERE id=?")
          .run(patch.revisionId);
        this.store.db
          .prepare("UPDATE parse_artifacts SET committed=1 WHERE id=?")
          .run(patch.parseId);
        const entry = batch.entries.find((e) => e.parseId === patch.parseId);
        if (entry) entry.status = "committed";
        this.store.event("source.committed", patch.revisionId);
        this.store.event("source.index_requested", patch.parseId);
      }
      change.state = "committed";
      this.save(change);
      this.ingestion.save(batch);
      this.store.event("changeset.committed", id);
      return change;
    });
  }
  revoked(sourceId: string) {
    return (
      (
        this.store.get(`source:${sourceId}`) as
          { retracted?: boolean } | undefined
      )?.retracted === true
    );
  }
  readable(revisionId: string) {
    const row = this.store.db
      .prepare("SELECT source_id FROM source_revisions WHERE id=?")
      .get(revisionId) as { source_id: string } | undefined;
    if (!row || this.revoked(row.source_id))
      throw new AppError("FORBIDDEN", 403);
  }
  parse(id: string): ParseArtifact {
    const row = this.store.db
      .prepare("SELECT value,committed FROM parse_artifacts WHERE id=?")
      .get(id) as { value: string; committed: number } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    const parsed = JSON.parse(row.value) as ParseArtifact;
    this.readable(parsed.revisionId);
    if (
      hashBytes(parsed.text) !== parsed.objectHash ||
      parsed.blocks.some(
        (block) =>
          block.start < 0 ||
          block.end > parsed.text.length ||
          block.end < block.start ||
          parsed.text.slice(block.start, block.end) !== block.text ||
          hashBytes(block.text) !== block.hash,
      )
    )
      throw new AppError(
        "HASH_MISMATCH",
        409,
        "解析定位校验失败；保留原件并重新解析。",
      );
    return { ...parsed, committed: !!row.committed };
  }
  sources(): SourceDetail[] {
    return (
      this.store.db
        .prepare(
          "SELECT value FROM source_revisions WHERE committed=1 ORDER BY rowid DESC LIMIT 200",
        )
        .all() as { value: string }[]
    )
      .filter(
        (row) =>
          !this.revoked((JSON.parse(row.value) as SourceRevision).sourceId),
      )
      .map((row) => {
        const revision = {
          ...JSON.parse(row.value),
          committed: true,
        } as SourceRevision;
        const parses = (
          this.store.db
            .prepare(
              "SELECT id FROM parse_artifacts WHERE revision_id=? AND committed=1",
            )
            .all(revision.id) as { id: string }[]
        ).map((p) => this.parse(p.id));
        return { revision, parses };
      });
  }
  original(revisionId: string) {
    this.readable(revisionId);
    const row = this.store.db
      .prepare("SELECT object_hash FROM source_revisions WHERE id=?")
      .get(revisionId) as { object_hash: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    return getObject(this.store, row.object_hash);
  }
}
