import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import {
  AcquisitionPlan,
  type CollectionManifest,
  type ManifestEntry,
  type Principal,
  type Parsed,
  type SourceRevision,
  type ParseArtifact,
  type Job,
} from "@kb/contracts";
import { WorkspaceRegistry, digest } from "../workspace/registry";
import { authorize } from "../http/auth";
import { Jobs } from "../runtime/jobs";
import { AppError } from "../errors";
import { inside } from "../security/paths";
import { hashBytes, putObject, getObject } from "./objects";
import { fetchScoped, normalizeUrl, withinScope } from "./fetcher";
import { listGranted, readGranted, unzipBounded } from "./file-reader";
import {
  codeGap,
  excludeCode,
  gitBlob,
  localRevision,
  remoteRevision,
} from "./repository";
import { parseIsolated } from "./parser";
export class Ingestion {
  constructor(
    readonly registry: WorkspaceRegistry,
    readonly jobs: Jobs,
    readonly parse = parseIsolated,
    readonly fetch = fetchScoped,
  ) {}
  get(id: string): CollectionManifest {
    const row = this.registry.store.db
      .prepare("SELECT value FROM ingestions WHERE id=?")
      .get(id) as { value: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404);
    const batch = JSON.parse(row.value) as CollectionManifest;
    if (batch.state === "running" && batch.jobId) {
      const job = this.jobs.get(batch.jobId);
      if (job.state === "failed" || job.state === "cancelled") {
        batch.state = job.state === "cancelled" ? "cancelled" : "ready";
        for (const entry of batch.entries)
          if (entry.selected && entry.status === "pending") {
            entry.status = "failed";
            entry.reason = "JOB_INTERRUPTED";
          }
        this.save(batch);
      }
    }
    return batch;
  }
  list(): CollectionManifest[] {
    return (
      this.registry.store.db
        .prepare("SELECT value FROM ingestions ORDER BY rowid DESC LIMIT 50")
        .all() as { value: string }[]
    ).map((row) => this.get((JSON.parse(row.value) as CollectionManifest).id));
  }
  save(batch: CollectionManifest) {
    this.registry.store.writable();
    this.registry.store.db
      .prepare("UPDATE ingestions SET value=? WHERE id=?")
      .run(JSON.stringify(batch), batch.id);
  }
  check(principal: Principal, policyVersion: number) {
    authorize(this.registry, principal, ["admin", "user"], policyVersion, true);
    const session = this.registry.store.db
      .prepare(
        "SELECT revoked FROM sessions WHERE json_extract(principal,'$.id')=?",
      )
      .get(principal.id) as { revoked: number } | undefined;
    if (!session || session.revoked) throw new AppError("AUTH", 401);
  }
  async preview(value: unknown, principal: Principal) {
    const plan = AcquisitionPlan.parse(value);
    this.check(principal, principal.policyVersion);
    const prior = this.registry.store.db
      .prepare("SELECT input_digest FROM ingestions WHERE id=?")
      .get(plan.id) as { input_digest: string } | undefined;
    if (prior) {
      if (prior.input_digest !== digest(plan)) throw new AppError("CONFLICT");
      return this.get(plan.id);
    }
    const started = Date.now();
    const signal = AbortSignal.timeout(plan.maxDurationMs);
    const entries: ManifestEntry[] = [];
    const warnings: string[] = [];
    let totalBytes = 0;
    let selected = 0;
    const add = (
      original: string,
      kind: ManifestEntry["kind"],
      via: string,
      metadata: ManifestEntry["metadata"] = {},
      excluded?: string,
    ) => {
      const identity = `${kind === "collection" ? "web" : kind}:${original}`;
      const old = entries.find((e) => e.identity === identity);
      if (old) {
        if (!old.via.includes(via)) old.via.push(via);
        return old;
      }
      const reason =
        excluded ??
        (selected >= plan.maxPages ? "超过本次选定数量上限" : undefined);
      const entry: ManifestEntry = {
        id: randomUUID(),
        identity,
        original,
        final: original,
        kind,
        via: [via],
        selected: !reason,
        status: reason ? "excluded" : "pending",
        reason,
        metadata: {
          kind,
          language: plan.language,
          version: plan.version,
          collection: plan.collection,
          sourceType: plan.sourceType,
          ...metadata,
        },
      };
      if (!reason) selected++;
      entries.push(entry);
      return entry;
    };
    const stage = (entry: ManifestEntry, bytes: Buffer) => {
      this.check(principal, principal.policyVersion);
      signal.throwIfAborted();
      totalBytes += bytes.length;
      if (totalBytes > plan.maxBytes || bytes.length > 20_000_000)
        throw new AppError("FETCH_LIMIT");
      entry.objectHash = putObject(this.registry.store, bytes);
      entry.fetchedAt = Date.now();
    };
    const failure = (entry: ManifestEntry, error: unknown) => {
      entry.status = "failed";
      entry.reason =
        error instanceof AppError ? error.code : "ACQUISITION_FAILED";
    };
    if (plan.clip !== undefined) {
      const entry = add(plan.entry, "text", "manual-clip", {
        excerpt: plan.excerpt,
      });
      stage(entry, Buffer.from(plan.clip));
    } else if (
      plan.kind === "web" ||
      plan.kind === "collection" ||
      (plan.kind === "pdf" && plan.entry.startsWith("https://"))
    ) {
      const queue = [{ url: normalizeUrl(plan.entry), depth: 0, via: "entry" }];
      const visited = new Set<string>();
      while (queue.length && entries.length < 1000 && !signal.aborted) {
        const item = queue.shift()!;
        if (visited.has(item.url)) continue;
        visited.add(item.url);
        const excluded = !withinScope(new URL(item.url), plan)
          ? "不在批准域名或路径内"
          : item.depth > plan.maxDepth
            ? "超过发现深度"
            : undefined;
        const entry = add(
          item.url,
          plan.kind,
          item.via,
          { depth: item.depth },
          excluded,
        );
        if (!entry.selected) continue;
        try {
          const response = await this.fetch(
            item.url,
            plan,
            signal,
            plan.maxBytes - totalBytes,
          );
          stage(entry, response.body);
          entry.final = response.finalUrl;
          entry.metadata.contentType = response.contentType;
          if (plan.kind === "collection") {
            const plain =
              /text\/plain|markdown/.test(response.contentType) ||
              /\/llms(?:-full)?\.txt/.test(item.url);
            const parsed = await this.parse(
              {
                bytes: response.body,
                kind: plain ? "text" : "web",
                title: "",
                url: response.finalUrl,
                encoding: plan.encoding,
              },
              signal,
            );
            const links = plain
              ? [...parsed.text.matchAll(/https:\/\/[^\s<>\])"']+/g)].map(
                  (m) => ({ url: m[0], via: "machine-index" }),
                )
              : parsed.links;
            for (const link of links) {
              try {
                const url = normalizeUrl(
                  new URL(link.url, response.finalUrl).href,
                );
                const priorEntry = entries.find((e) => e.original === url);
                if (priorEntry && !priorEntry.via.includes(item.url))
                  priorEntry.via.push(item.url);
                if (!visited.has(url) && queue.length < 1000)
                  queue.push({
                    url,
                    depth: item.depth + 1,
                    via: `${link.via}:${item.url}`,
                  });
              } catch {
                /* Non-HTTP links are not acquisition candidates. */
              }
            }
            if (links.length >= 1000 || queue.length >= 1000)
              warnings.push("链接候选上限已到；扩大范围需新预览。");
          }
        } catch (error) {
          failure(entry, error);
        }
      }
      if (queue.length || signal.aborted)
        warnings.push("发现达到时间或候选上限；这份清单不代表全站。");
      if (plan.kind === "collection")
        warnings.push(
          "请核对并列导航、llms.txt、语言和版本入口；新增页须创建下一版清单。",
        );
    } else if (
      plan.kind === "repository" &&
      plan.entry.startsWith("https://")
    ) {
      const remote = await remoteRevision(plan, signal);
      totalBytes += remote.bytes;
      if (remote.truncated)
        warnings.push("上游树列表被截断；不能确认完整快照。");
      for (const item of remote.tree.slice(0, 1000)) {
        if (item.type === "tree") continue;
        const url = `https://raw.githubusercontent.com/${remote.repo}/${remote.commit}/${item.path.split("/").map(encodeURIComponent).join("/")}`;
        const entry = add(
          url,
          "repository",
          `commit:${remote.commit}`,
          {
            commit: remote.commit,
            requestedRef: plan.ref,
            path: item.path,
            sourceType: plan.sourceType,
            dirty: false,
          },
          excludeCode(item.path, plan.sourceType) ??
            (item.mode === "160000"
              ? "SUBMODULE：未取得子模块"
              : item.mode === "120000"
                ? "SYMLINK：不跟随符号链接"
                : undefined),
        );
        // Identity follows repository + path; commit belongs to immutable revision metadata.
        entry.identity = `repository:https://github.com/${remote.repo}/${item.path}`;
        if (!entry.selected) continue;
        try {
          stage(
            entry,
            (await this.fetch(url, plan, signal, plan.maxBytes - totalBytes))
              .body,
          );
        } catch (error) {
          failure(entry, error);
        }
      }
      if (remote.tree.length > 1000)
        warnings.push("仓库条目超过 1000，需缩小研究范围。");
    } else {
      const root = resolve(plan.entry);
      const actual = await realpath(root);
      if (
        inside(this.registry.get().vaultPath, actual) ||
        inside(this.registry.dataPath, actual)
      )
        throw new AppError(
          "FORBIDDEN",
          403,
          "请授权原始资料文件或目录；生成目录与应用数据不能再次收录。",
        );
      const info = await lstat(root);
      if (info.isSymbolicLink()) throw new AppError("FORBIDDEN", 403);
      const isZip = !info.isDirectory() && /\.zip$/i.test(root);
      const zip = isZip
        ? await unzipBounded(
            await readGranted(dirname(root), basename(root), plan.maxBytes),
            plan.maxBytes,
            1000,
          )
        : null;
      const paths = zip
        ? [...zip.keys()].sort()
        : info.isDirectory()
          ? await listGranted(root, 2000)
          : [basename(root)];
      const git =
        plan.kind === "repository" && info.isDirectory()
          ? await localRevision(root, plan.ref)
          : {
              commit: null,
              files: new Map<string, { mode: string; hash: string }>(),
            };
      const snapshot: { path: string; hash: string }[] = [];
      let dirty = false;
      for (const path of paths.slice(0, 1000)) {
        const kind =
          plan.kind === "repository"
            ? "repository"
            : /\.pdf$/i.test(path)
              ? "pdf"
              : "text";
        const original = `${actual}${info.isDirectory() || isZip ? "/" + path : ""}`;
        const entry = add(
          original,
          kind,
          zip ? "archive" : "explicit-local-grant",
          {
            path,
            sourceType: plan.sourceType,
            requestedRef: plan.ref,
            commit: git.commit,
          },
          excludeCode(path, plan.sourceType) ?? undefined,
        );
        if (!entry.selected) continue;
        try {
          const bytes =
            zip?.get(path) ??
            (await readGranted(
              info.isDirectory() ? root : dirname(root),
              path,
              Math.min(plan.maxBytes - totalBytes, 20_000_000),
            ));
          stage(entry, bytes);
          snapshot.push({ path, hash: hashBytes(bytes) });
          if (git.commit && git.files.get(path)?.hash !== gitBlob(bytes))
            dirty = true;
        } catch (error) {
          failure(entry, error);
        }
      }
      for (const [path, item] of git.files)
        if (item.mode === "160000")
          add(
            `${actual}/${path}`,
            "repository",
            "git-tree",
            { path, commit: git.commit },
            "SUBMODULE：未取得子模块",
          );
      // Verify the selected directory snapshot did not change while copying.
      if (info.isDirectory())
        for (const item of snapshot) {
          try {
            if (
              hashBytes(await readGranted(root, item.path, plan.maxBytes)) !==
              item.hash
            )
              throw new AppError("BASELINE");
          } catch {
            const entry = entries.find((e) => e.metadata.path === item.path)!;
            entry.status = "failed";
            entry.reason = "SNAPSHOT_CHANGED";
          }
        }
      if (git.commit) {
        if (
          [...git.files.keys()].some(
            (path) =>
              !paths.includes(path) && !excludeCode(path, plan.sourceType),
          )
        )
          dirty = true;
        const after = await localRevision(root, plan.ref);
        if (after.commit !== git.commit)
          warnings.push(
            "分支在复制期间移动；保留已固定 commit 和实际文件清单，标记脏快照。",
          );
        dirty ||= after.commit !== git.commit;
      }
      for (const entry of entries) {
        entry.metadata.dirty = git.commit ? dirty : true;
        entry.metadata.snapshotHash = digest(snapshot);
      }
      if (paths.length > 1000)
        warnings.push("目录超过条目上限；扩大范围需新预览。");
    }
    this.check(principal, principal.policyVersion);
    const previous = this.list().find(
      (b) =>
        b.plan.entry === plan.entry &&
        b.plan.kind === plan.kind &&
        b.state !== "preview",
    );
    const batch: CollectionManifest = {
      id: plan.id,
      plan: { ...plan, clip: undefined },
      entries,
      digest: "",
      state: "preview",
      warnings: [...new Set(warnings)],
      previousMissing:
        previous?.entries
          .filter(
            (e) =>
              e.selected && !entries.some((n) => n.identity === e.identity),
          )
          .map((e) => e.original) ?? [],
      createdAt: started,
      finishedAt: null,
      jobId: null,
      policyVersion: principal.policyVersion,
      epoch: principal.epoch,
      principalId: principal.id,
      selectedCount: entries.filter((e) => e.selected).length,
    };
    batch.digest = digest({
      plan: batch.plan,
      entries: batch.entries,
      warnings: batch.warnings,
      previousMissing: batch.previousMissing,
    });
    return this.registry.store.tx(() => {
      const existing = this.registry.store.db
        .prepare("SELECT input_digest FROM ingestions WHERE id=?")
        .get(batch.id) as { input_digest: string } | undefined;
      if (existing) {
        if (existing.input_digest !== digest(plan))
          throw new AppError("CONFLICT");
        return this.get(batch.id);
      }
      this.registry.store.db
        .prepare("INSERT INTO ingestions VALUES(?,?,?)")
        .run(batch.id, digest(plan), JSON.stringify(batch));
      this.registry.store.event("ingestion.preview", batch.id);
      return batch;
    });
  }
  freeze(
    id: string,
    expected: string,
    selectedIds: string[],
    principal: Principal,
  ) {
    this.check(principal, principal.policyVersion);
    return this.registry.store.tx(() => {
      const batch = this.get(id);
      if (
        batch.state !== "preview" ||
        batch.digest !== expected ||
        batch.policyVersion !== principal.policyVersion ||
        batch.epoch !== principal.epoch
      )
        throw new AppError("BASELINE");
      if (
        !selectedIds.length ||
        new Set(selectedIds).size !== selectedIds.length ||
        selectedIds.some(
          (id) => !batch.entries.some((e) => e.id === id && e.selected),
        )
      )
        throw new AppError("VALIDATION", 400);
      for (const entry of batch.entries)
        if (!selectedIds.includes(entry.id)) {
          entry.selected = false;
          entry.status = "excluded";
          entry.reason ??= "用户排除";
        }
      batch.selectedCount = selectedIds.length;
      batch.principalId = principal.id;
      batch.state = "running";
      batch.digest = digest({
        preview: expected,
        selectedIds: [...selectedIds].sort(),
      });
      batch.jobId = this.jobs.enqueue(
        { kind: "ingestion", queue: "batch", operationKey: `ingestion:${id}` },
        0,
      ).id;
      this.save(batch);
      return batch;
    });
  }
  cancel(id: string) {
    const batch = this.get(id);
    if (batch.jobId) this.jobs.cancel(batch.jobId);
    batch.state = "cancelled";
    this.save(batch);
    return batch;
  }
  retry(id: string, principal: Principal) {
    this.check(principal, principal.policyVersion);
    const batch = this.get(id);
    if (
      batch.state !== "ready" ||
      batch.policyVersion !== principal.policyVersion ||
      batch.epoch !== principal.epoch
    )
      throw new AppError("BASELINE");
    for (const entry of batch.entries)
      if (
        entry.selected &&
        entry.status === "failed" &&
        entry.reason !== "SNAPSHOT_CHANGED"
      ) {
        entry.status = "pending";
        delete entry.reason;
      }
    batch.state = "running";
    batch.principalId = principal.id;
    batch.jobId = this.jobs.enqueue(
      {
        kind: "ingestion",
        queue: "batch",
        operationKey: `ingestion:${id}:${randomUUID()}`,
        parentId: batch.jobId,
      },
      0,
    ).id;
    this.save(batch);
    return batch;
  }
  active(batch: CollectionManifest, job: Job) {
    this.jobs.active(job.id, job.fence);
    const current = this.get(batch.id);
    if (current.state === "cancelled") throw new AppError("CANCELLED");
    const row = this.registry.store.db
      .prepare(
        "SELECT principal FROM sessions WHERE json_extract(principal,'$.id')=? AND revoked=0",
      )
      .get(batch.principalId) as { principal: string } | undefined;
    if (!row) throw new AppError("AUTH", 401);
    const principal = JSON.parse(row.principal) as Principal;
    if (principal.epoch !== batch.epoch) throw new AppError("MASTER");
    this.check(principal, batch.policyVersion);
  }
  register(entry: ManifestEntry, parsed: Parsed, encoding: string) {
    const store = this.registry.store;
    return store.tx(() => {
      if (!entry.objectHash) throw new AppError("HASH_MISMATCH");
      getObject(store, entry.objectHash);
      store.db
        .prepare("INSERT OR IGNORE INTO sources VALUES(?,?)")
        .run(randomUUID(), entry.identity);
      const source = store.db
        .prepare("SELECT id FROM sources WHERE identity=?")
        .get(entry.identity) as { id: string };
      const existing = store.db
        .prepare(
          "SELECT id FROM source_revisions WHERE source_id=? AND object_hash=?",
        )
        .get(source.id, entry.objectHash) as { id: string } | undefined;
      const revision: SourceRevision = {
        id: existing?.id ?? randomUUID(),
        sourceId: source.id,
        identity: entry.identity,
        objectHash: entry.objectHash,
        fetchedAt: entry.fetchedAt!,
        original: entry.original,
        final: entry.final,
        metadata: entry.metadata,
        committed: false,
      };
      store.db
        .prepare("INSERT OR IGNORE INTO source_revisions VALUES(?,?,?,?,0)")
        .run(
          revision.id,
          source.id,
          entry.objectHash,
          JSON.stringify(revision),
        );
      const fingerprint = digest({
        parser: parsed.parser,
        encoding,
        locator: parsed.locatorVersion,
        content: {
          ...parsed,
          peakMemoryBytes: undefined,
          durationMs: undefined,
        },
      });
      const oldParse = store.db
        .prepare(
          "SELECT id FROM parse_artifacts WHERE revision_id=? AND fingerprint=?",
        )
        .get(revision.id, fingerprint) as { id: string } | undefined;
      const artifact: ParseArtifact = {
        ...parsed,
        id: oldParse?.id ?? randomUUID(),
        revisionId: revision.id,
        objectHash: hashBytes(parsed.text),
        createdAt: Date.now(),
        committed: false,
      };
      store.db
        .prepare("INSERT OR IGNORE INTO parse_artifacts VALUES(?,?,?,?,0)")
        .run(artifact.id, revision.id, fingerprint, JSON.stringify(artifact));
      entry.revisionId = revision.id;
      entry.parseId = artifact.id;
      const committed = store.db
        .prepare("SELECT committed FROM parse_artifacts WHERE id=?")
        .get(artifact.id) as { committed: number };
      entry.status = committed.committed
        ? "committed"
        : parsed.gaps.length
          ? "partial_parse"
          : "acquired";
      delete entry.reason;
      return artifact;
    });
  }
  async run(job: Job, signal: AbortSignal) {
    const batch = this.registry.store.db
      .prepare(
        "SELECT value FROM ingestions WHERE json_extract(value,'$.jobId')=?",
      )
      .get(job.id) as { value: string } | undefined;
    if (!batch) {
      this.jobs.finish(job.id, job.fence, false);
      return;
    }
    const manifest = JSON.parse(batch.value) as CollectionManifest;
    try {
      for (const entry of manifest.entries) {
        if (
          !entry.selected ||
          entry.reason === "SNAPSHOT_CHANGED" ||
          !["pending", "failed"].includes(entry.status)
        )
          continue;
        this.active(manifest, job);
        signal.throwIfAborted();
        this.jobs.heartbeat(job.id, job.fence, "acquiring");
        try {
          if (!entry.objectHash) {
            if (!entry.original.startsWith("https://"))
              throw new AppError(
                "LOCAL_REPREVIEW_REQUIRED",
                409,
                "本地文件获取失败，请重新预览并授权。",
              );
            const used = manifest.entries.reduce(
              (n, e) =>
                n +
                (e.objectHash
                  ? getObject(this.registry.store, e.objectHash).length
                  : 0),
              0,
            );
            if (used >= manifest.plan.maxBytes)
              throw new AppError("FETCH_LIMIT");
            const response = await this.fetch(
              entry.original,
              manifest.plan,
              signal,
              manifest.plan.maxBytes - used,
            );
            this.active(manifest, job);
            entry.objectHash = putObject(this.registry.store, response.body);
            entry.final = response.finalUrl;
            entry.fetchedAt = Date.now();
            this.save(manifest);
          }
          const bytes = getObject(this.registry.store, entry.objectHash);
          const parsed = await this.parse(
            {
              bytes,
              kind:
                ["web", "collection"].includes(entry.kind) &&
                (/text\/plain|markdown/.test(
                  String(entry.metadata.contentType),
                ) ||
                  /\/llms(?:-full)?\.txt/.test(entry.original))
                  ? "text"
                  : entry.kind,
              title: manifest.plan.title || basename(entry.original),
              url: entry.final,
              encoding: manifest.plan.encoding,
              path:
                entry.kind === "repository"
                  ? String(entry.metadata.path)
                  : undefined,
            },
            signal,
          );
          if (manifest.plan.excerpt)
            parsed.gaps.push("EXCERPT：用户确认仅保留节选。");
          const gap =
            entry.kind === "repository"
              ? codeGap(String(entry.metadata.path), bytes)
              : null;
          if (gap) parsed.gaps.push(gap);
          this.active(manifest, job);
          this.register(entry, parsed, manifest.plan.encoding);
        } catch (error) {
          this.active(manifest, job);
          entry.status = "failed";
          entry.reason =
            error instanceof AppError ? error.code : "PARSE_FAILED";
        }
        this.save(manifest);
      }
      this.active(manifest, job);
      manifest.state = "ready";
      manifest.finishedAt = Date.now();
      this.save(manifest);
      this.jobs.finish(job.id, job.fence, true);
    } catch {
      try {
        this.jobs.finish(job.id, job.fence, false);
        const current = this.get(manifest.id);
        if (current.state !== "cancelled") {
          current.state = "ready";
          this.save(current);
        }
      } catch {
        /* Fence/lease loss: next runner resumes persisted entries. */
      }
    }
  }
  async reparse(
    id: string,
    entryId: string,
    encoding: string,
    password: string | undefined,
    principal: Principal,
  ) {
    const batch = this.get(id);
    this.check(principal, batch.policyVersion);
    if (batch.state !== "ready") throw new AppError("BASELINE");
    const entry = batch.entries.find((e) => e.id === entryId && e.objectHash);
    if (!entry) throw new AppError("NOT_FOUND", 404);
    const parsed = await this.parse({
      bytes: getObject(this.registry.store, entry.objectHash!),
      kind: entry.kind,
      title: batch.plan.title || basename(entry.original),
      url: entry.final,
      encoding,
      password,
      path:
        entry.kind === "repository" ? String(entry.metadata.path) : undefined,
    });
    if (batch.plan.excerpt) parsed.gaps.push("EXCERPT：用户确认仅保留节选。");
    if (entry.kind === "repository") {
      const gap = codeGap(
        String(entry.metadata.path),
        getObject(this.registry.store, entry.objectHash!),
      );
      if (gap) parsed.gaps.push(gap);
    }
    this.check(principal, batch.policyVersion);
    if (this.get(id).state !== "ready") throw new AppError("CANCELLED");
    this.register(entry, parsed, encoding);
    this.save(batch);
    return batch;
  }
}
