import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Principal,
  PublicationInput,
  PublicationManifest,
  PublicationPreview,
} from "@kb/contracts";
import { AppError } from "../errors";
import { EvidenceStore } from "../evidence/locator";
import { hashBytes } from "../ingestion/objects";
import { Policy } from "../security/policy";
import { digest } from "../workspace/registry";
import { buildPublication, BUILD_FINGERPRINT } from "./build";
import { PublicationManifestBuilder } from "./manifest";
import { scanPublication } from "./scan";
import { readPublicAttachment } from "./attachments";
import { readPage } from "../wiki/impact";

export type PublicationRelease = {
  id: string;
  previewId: string;
  manifestDigest: string;
  outputDigest: string;
  target: "local-static-site";
  approvedBy: string;
  releasedBy: string;
  sourceIds: string[];
  previousId: string | null;
  state:
    | "uploading"
    | "partial"
    | "published-local"
    | "needs-takedown"
    | "withdrawn";
  confirmed: string[];
  unconfirmed: string[];
  externalReleaseId: string | null;
  at: number;
  historical: boolean;
  localPresent?: boolean;
};

function verifyOutputFile(path: string, expectedHash: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      hashBytes(readFileSync(fd)) !== expectedHash
    )
      throw new AppError("HASH_MISMATCH");
  } finally {
    closeSync(fd);
  }
}

export class Publications {
  readonly builder: PublicationManifestBuilder;
  private publishing = false;
  constructor(
    readonly evidence: EvidenceStore,
    readonly buildFiles = buildPublication,
  ) {
    this.builder = new PublicationManifestBuilder(evidence);
  }
  get registry() {
    return this.evidence.registry;
  }
  get store() {
    return this.evidence.store;
  }
  private key(id: string) {
    return `publication:preview:${id}`;
  }
  private releaseKey(id: string) {
    return `publication:release:${id}`;
  }
  preview(id: string, p: Principal): PublicationPreview {
    this.evidence.checkPrincipal(p);
    const value = this.store.get(this.key(id)) as
      PublicationPreview | undefined;
    if (!value) throw new AppError("NOT_FOUND", 404);
    if (
      digest({ ...value.manifest, digest: "", outputDigest: "" }) !==
      value.manifest.digest
    )
      throw new AppError("HASH_MISMATCH");
    for (const expected of value.manifest.pages) {
      const page = readPage(this.builder.proposals, expected.revisionId, p);
      if (
        page.pageId !== expected.pageId ||
        digest(this.builder.sourceIds(page)) !== digest(expected.sourceIds)
      )
        throw new AppError("BASELINE");
    }
    this.verifyFiles(value);
    return value;
  }
  private verifyFiles(value: PublicationPreview) {
    if (new Set(value.files.map((f) => f.path)).size !== value.files.length)
      throw new AppError("HASH_MISMATCH");
    const files = Object.fromEntries(
      value.files.map((f) => [f.path, f.content]),
    );
    const scanned = scanPublication(
      files,
      value.manifest.pages.map((p) => p.file),
      value.manifest.outboundLinks,
      value.manifest.attachments.map((a) => a.path),
    );
    if (
      scanned.outputDigest !== value.manifest.outputDigest ||
      digest(scanned.output) !== digest(value.manifest.output)
    )
      throw new AppError("HASH_MISMATCH");
  }
  private recheck(
    value: PublicationPreview,
    principal: Principal,
    historical = false,
  ) {
    const w = this.registry.get();
    if (
      (!historical && w.policyVersion !== value.manifest.policyVersion) ||
      w.epoch !== value.manifest.epoch ||
      value.manifest.buildFingerprint !== BUILD_FINGERPRINT
    )
      throw new AppError("BASELINE");
    if (!historical) {
      const pages = this.builder.pages(
        value.manifest.pages.map((p) => p.revisionId),
        principal,
      );
      for (let i = 0; i < pages.length; i++) {
        const expected = value.manifest.pages[i]!;
        if (
          pages[i]!.pageId !== expected.pageId ||
          digest(this.builder.sourceIds(pages[i]!)) !==
            digest(expected.sourceIds)
        )
          throw new AppError("BASELINE");
      }
    } else {
      // A rollback may use a non-current Wiki revision, but its saved evidence must still be readable.
      for (const page of value.manifest.pages) {
        const row = this.store.db
          .prepare("SELECT value FROM wiki_revisions WHERE id=?")
          .get(page.revisionId) as { value: string } | undefined;
        if (!row) throw new AppError("BASELINE");
        const old = JSON.parse(row.value) as {
          hash: string;
          evidenceIds: string[];
        };
        if (
          old.evidenceIds.some(
            (id) => !page.sourceIds.includes(this.evidence.read(id).sourceId),
          )
        )
          throw new AppError("BASELINE");
      }
    }
    const sources = [
      ...new Set(value.manifest.pages.flatMap((page) => page.sourceIds)),
    ];
    new Policy(this.registry).allow(
      principal,
      w.policyVersion,
      "publish",
      value.manifest.routeId,
      sources,
    );
    for (const dependency of value.manifest.dependencies.filter(
      (d) => d.action === "include",
    )) {
      const current = readPublicAttachment(w.vaultPath, dependency.token);
      const approved = value.manifest.attachments.find(
        (a) => a.path === current.path,
      );
      if (
        !approved ||
        approved.hash !== current.hash ||
        approved.bytes !== current.bytes
      )
        throw new AppError("BASELINE");
    }
    this.verifyFiles(value);
  }
  async build(
    input: PublicationInput,
    principal: Principal,
  ): Promise<PublicationPreview> {
    const operationKey = `publication:build-op:${principal.id}:${input.operationId}`;
    const old = this.store.get(operationKey) as
      { inputDigest: string; previewId: string } | undefined;
    if (old) {
      if (old.inputDigest !== digest(input)) throw new AppError("CONFLICT");
      return this.preview(old.previewId, principal);
    }
    const prepared = this.builder.prepare(input, principal);
    const w = this.registry.get();
    const files = await this.buildFiles(prepared.pages, prepared.attachments);
    const scanned = scanPublication(
      files,
      prepared.pages.map((p) => p.file),
      prepared.outboundLinks,
      prepared.attachments.map((a) => a.path),
    );
    for (const attachment of prepared.attachments)
      if (
        scanned.output.find((o) => o.path === attachment.path)?.hash !==
        attachment.hash
      )
        throw new AppError(
          "PUBLICATION_OUTPUT",
          409,
          "构建后的附件与预览来源不一致。",
        );
    const manifest: PublicationManifest = {
      id: randomUUID(),
      routeId: input.routeId,
      pages: prepared.pages.map(
        ({ pageId, revisionId, title, sourceIds, bodyHash, file }) => ({
          pageId,
          revisionId,
          title,
          sourceIds,
          bodyHash,
          file,
        }),
      ),
      dependencies: prepared.dependencies,
      attachments: prepared.attachments.map(({ path, hash, bytes }) => ({
        path,
        hash,
        bytes,
      })),
      outboundLinks: prepared.outboundLinks,
      publicMetadata: prepared.pages.map(({ title, kind }) => ({
        title,
        kind,
      })),
      buildFingerprint: BUILD_FINGERPRINT,
      output: scanned.output,
      policyVersion: w.policyVersion,
      epoch: w.epoch,
      target: "local-static-site",
      digest: "",
      outputDigest: scanned.outputDigest,
    };
    manifest.digest = digest({ ...manifest, digest: "", outputDigest: "" });
    const value: PublicationPreview = {
      manifest,
      files: Object.entries(files).map(([path, content]) => ({
        path,
        content,
      })),
      approvedBy: null,
      approvedAt: null,
    };
    this.recheck(value, principal);
    this.store.tx(() => {
      if (this.store.get(operationKey)) throw new AppError("CONFLICT");
      this.store.set(this.key(manifest.id), value);
      this.store.set(operationKey, {
        inputDigest: digest(input),
        previewId: manifest.id,
      });
      this.store.event("publication.previewed", manifest.id);
    });
    return value;
  }
  approve(
    id: string,
    manifestDigest: string,
    outputDigest: string,
    principal: Principal,
  ) {
    return this.store.tx(() => {
      const value = this.preview(id, principal);
      this.recheck(value, principal);
      if (
        manifestDigest !== value.manifest.digest ||
        outputDigest !== value.manifest.outputDigest
      )
        throw new AppError("BASELINE");
      if (value.approvedBy && value.approvedBy !== principal.id)
        throw new AppError("CONFLICT");
      value.approvedBy = principal.id;
      value.approvedAt ??= Date.now();
      this.store.set(this.key(id), value);
      this.store.event("publication.approved", id);
      return { id, approvedBy: value.approvedBy, approvedAt: value.approvedAt };
    });
  }
  release(
    id: string,
    operationId: string,
    manifestDigest: string,
    outputDigest: string,
    principal: Principal,
  ) {
    const value = this.preview(id, principal);
    const historical = this.list(principal).some(
      (r) => r.previewId === id && r.state === "published-local",
    );
    this.recheck(value, principal, historical);
    if (
      !value.approvedBy ||
      value.manifest.digest !== manifestDigest ||
      value.manifest.outputDigest !== outputDigest
    )
      throw new AppError("BASELINE", 409, "批准摘要或实际产物已变化。");
    const key = `publication:release-op:${principal.id}:${operationId}`;
    const inputHash = digest({ id, manifestDigest, outputDigest });
    const old = this.store.get(key) as
      { id: string; inputHash: string } | undefined;
    if (old) {
      if (old.inputHash !== inputHash) throw new AppError("CONFLICT");
      return this.finishRelease(old.id, value, principal);
    }
    const releaseId = randomUUID();
    const current = this.store.get("publication:current") as
      { id: string } | undefined;
    const record: PublicationRelease = {
      id: releaseId,
      previewId: id,
      manifestDigest,
      outputDigest,
      target: "local-static-site",
      approvedBy: value.approvedBy,
      releasedBy: principal.id,
      sourceIds: [...new Set(value.manifest.pages.flatMap((p) => p.sourceIds))],
      previousId: current?.id ?? null,
      state: "uploading",
      confirmed: [],
      unconfirmed: value.manifest.output.map((f) => f.path),
      externalReleaseId: null,
      at: Date.now(),
      historical,
    };
    this.store.tx(() => {
      this.store.set(this.releaseKey(releaseId), record);
      this.store.set(key, { id: releaseId, inputHash });
      this.store.event("publication.uploading", releaseId);
    });
    return this.finishRelease(releaseId, value, principal);
  }
  private async finishRelease(
    id: string,
    value: PublicationPreview,
    principal: Principal,
  ): Promise<PublicationRelease> {
    const record = this.store.get(this.releaseKey(id)) as PublicationRelease;
    if (record.state === "published-local") return record;
    if (!["uploading", "partial"].includes(record.state))
      throw new AppError("CONFLICT");
    if (this.publishing)
      throw new AppError(
        "CONFLICT",
        409,
        "另一份公开副本正在写入，请稍后核对发布记录。",
      );
    this.publishing = true;
    const root = join(this.registry.dataPath, "public-site");
    const releaseDir = join(root, "releases", id);
    try {
      await mkdir(releaseDir, { recursive: true, mode: 0o700 });
      for (const dir of [root, join(root, "releases"), releaseDir]) {
        const stat = lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new AppError("FORBIDDEN", 403);
      }
      for (const item of value.manifest.output) {
        const path = join(releaseDir, item.path);
        if (!record.confirmed.includes(item.path)) {
          const content = value.files.find(
            (f) => f.path === item.path,
          )!.content;
          try {
            await writeFile(path, content, { flag: "wx", mode: 0o600 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
        verifyOutputFile(path, item.hash);
        if (!record.confirmed.includes(item.path)) {
          record.confirmed.push(item.path);
          record.unconfirmed = record.unconfirmed.filter(
            (p) => p !== item.path,
          );
          this.store.set(this.releaseKey(id), record);
        }
      }
      // No await between the final policy check and current-link switch: a
      // synchronous retraction cannot interleave and publish a revoked source.
      this.recheck(value, principal, record.historical);
      for (const item of value.manifest.output)
        verifyOutputFile(join(releaseDir, item.path), item.hash);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const next = join(root, `.current-${id}`);
      rmSync(next, { force: true });
      symlinkSync(join("releases", id), next);
      renameSync(next, join(root, "current"));
      record.state = "published-local";
      record.externalReleaseId = id;
      this.store.tx(() => {
        this.store.set(this.releaseKey(id), record);
        this.store.set("publication:current", { id });
        this.store.event("publication.released-local", id);
      });
      return record;
    } catch (error) {
      const latest = this.store.get(this.releaseKey(id)) as PublicationRelease;
      if (!["withdrawn", "needs-takedown"].includes(latest.state)) {
        record.state = "partial";
        this.store.set(this.releaseKey(id), record);
      }
      throw error;
    } finally {
      this.publishing = false;
    }
  }
  list(principal: Principal) {
    this.evidence.checkPrincipal(principal);
    const rows = this.store.db
      .prepare(
        "SELECT value FROM kv WHERE key LIKE 'publication:release:%' ORDER BY rowid DESC LIMIT 100",
      )
      .all() as { value: string }[];
    const releases = rows.map((r) => {
      const release = JSON.parse(r.value) as PublicationRelease;
      return {
        ...release,
        localPresent: existsSync(
          join(this.registry.dataPath, "public-site", "releases", release.id),
        ),
      };
    });
    return principal.role === "reader"
      ? releases.filter((r) =>
          r.sourceIds.every((id) => this.evidence.readable(id)),
        )
      : releases;
  }
}
