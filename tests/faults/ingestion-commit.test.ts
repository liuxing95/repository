import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fixture } from "../helpers";
import { Ingestion } from "../../apps/service/src/ingestion/manifest";
import { SourceCommit } from "../../apps/service/src/ingestion/commit";
import { Connection } from "../../apps/obsidian-plugin/src/connection";
import {
  applyGrant,
  type WriterHost,
} from "../../apps/obsidian-plugin/src/writer/apply";
import { createServer } from "../../apps/service/src/http/server";
import type { CollectionManifest } from "@kb/contracts";
async function ready(
  f: Awaited<ReturnType<typeof fixture>>,
  ingestion: Ingestion,
) {
  const preview = await ingestion.preview(
    { id: randomUUID(), kind: "text", entry: f.source },
    f.principal,
  );
  ingestion.freeze(
    preview.id,
    preview.digest,
    preview.entries.map((e) => e.id),
    f.principal,
  );
  await ingestion.run(
    f.jobs.claim("batch", 30000, "ingestion")!,
    new AbortController().signal,
  );
  return ingestion.get(preview.id);
}
test("partial writes, lost receipts and third hashes never advance source visibility", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, "two.md"), "另一份来源");
    const ingestion = new Ingestion(f.registry, f.jobs);
    const commit = new SourceCommit(ingestion);
    const batch = await ready(f, ingestion);
    const change = commit.prepare(batch.id);
    expect(() => commit.approve(change.id, "bad", f.principal)).toThrow(
      "BASELINE",
    );
    commit.approve(change.id, change.digest, f.principal);
    const connection = new Connection(
      async () => {
        throw new Error("unused");
      },
      f.registry.get().vaultPath,
      f.deviceId,
    );
    connection.principal = f.principal;
    connection.workspace = f.registry.get();
    let editing = false;
    const host: WriterHost = {
      root: connection.vaultPath,
      isEditing: () => editing,
      read: async (path) => {
        try {
          return await readFile(join(connection.vaultPath, path), "utf8");
        } catch {
          return null;
        }
      },
      create: async (path, content) => {
        await writeFile(join(connection.vaultPath, path), content, {
          flag: "wx",
        });
      },
    };
    const first = commit.grant(change.id, 0, f.principal);
    await applyGrant(host, connection, first);
    expect(commit.sources()).toHaveLength(0);
    expect(() =>
      commit.finish(
        change.id,
        change.patches.map((p) => p.afterHash),
        f.principal,
      ),
    ).toThrow("INCOMPLETE");
    const recovered = commit.grant(change.id, 0, f.principal);
    const hash = await applyGrant(host, connection, recovered);
    commit.receipt(recovered.token, hash, f.principal);
    expect(() => commit.receipt(recovered.token, "bad", f.principal)).toThrow(
      "HASH_MISMATCH",
    );
    const second = commit.grant(change.id, 1, f.principal);
    editing = true;
    await expect(applyGrant(host, connection, second)).rejects.toThrow(
      "WRITER_EDITING",
    );
    editing = false;
    await writeFile(join(host.root, second.patch.path), "用户自己的修改");
    await expect(applyGrant(host, connection, second)).rejects.toThrow(
      "WRITER_CONFLICT",
    );
    expect(await readFile(join(host.root, second.patch.path), "utf8")).toBe(
      "用户自己的修改",
    );
    expect(commit.sources()).toHaveLength(0);
    // User explicitly restores the exact approved candidate; recovery records it without overwriting.
    await writeFile(join(host.root, second.patch.path), second.patch.content);
    commit.receipt(
      second.token,
      await applyGrant(host, connection, second),
      f.principal,
    );
    commit.finish(
      change.id,
      change.patches.map((p) => p.afterHash),
      f.principal,
    );
    commit.finish(
      change.id,
      change.patches.map((p) => p.afterHash),
      f.principal,
    );
    expect(commit.sources()).toHaveLength(2);
    expect(
      f.store.db
        .prepare(
          "SELECT count(*) n FROM events WHERE kind='source.index_requested'",
        )
        .get(),
    ).toEqual({ n: 2 });
  } finally {
    await f.close();
  }
});
test("cancelled worker and expired approval cannot register late results", async () => {
  const f = await fixture();
  try {
    const ingestion = new Ingestion(f.registry, f.jobs);
    const batch = await ready(f, ingestion);
    let now = Date.now();
    const commit = new SourceCommit(ingestion, () => now);
    const change = commit.prepare(batch.id);
    commit.approve(change.id, change.digest, f.principal);
    const grant = commit.grant(change.id, 0, f.principal);
    now += 60001;
    expect(() =>
      commit.receipt(grant.token, grant.patch.afterHash, f.principal),
    ).toThrow("HASH_MISMATCH");
    now += 600000;
    expect(() => commit.grant(change.id, 0, f.principal)).toThrow(
      "APPROVAL_EXPIRED",
    );
    ingestion.cancel(batch.id);
    expect(() => commit.approve(change.id, change.digest, f.principal)).toThrow(
      "BASELINE",
    );
    const preview = await ingestion.preview(
      { id: randomUUID(), kind: "text", entry: f.source },
      f.principal,
    );
    ingestion.freeze(
      preview.id,
      preview.digest,
      preview.entries.map((e) => e.id),
      f.principal,
    );
    const job = f.jobs.claim("batch", 30000, "ingestion")!;
    ingestion.cancel(preview.id);
    await ingestion.run(job, new AbortController().signal);
    expect(ingestion.get(preview.id).entries[0]?.parseId).toBeUndefined();
  } finally {
    await f.close();
  }
});
test("real HTTP + plugin transport reaches background parse, approval, receipt and final sources", async () => {
  const f = await fixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
  try {
    const connection = new Connection(
      async (url, options) => {
        const r = await app.inject({
          method: options.method as "POST",
          url: new URL(url).pathname,
          headers: { ...options.headers, host: "127.0.0.1:27124" },
          payload: options.body,
        });
        return { status: r.statusCode, json: r.json() };
      },
      f.registry.get().vaultPath,
      f.deviceId,
    );
    await connection.pair(f.sessions.issuePairing());
    const preview = await connection.request<CollectionManifest>(
      "/v1/ingestion/preview",
      "POST",
      { id: randomUUID(), kind: "text", entry: join(f.source, "note.md") },
    );
    await connection.request(`/v1/ingestion/${preview.id}/freeze`, "POST", {
      digest: preview.digest,
      selectedIds: preview.entries.map((e) => e.id),
    });
    await expect
      .poll(
        async () =>
          (
            await connection.request<CollectionManifest>(
              `/v1/ingestion/${preview.id}`,
            )
          ).state,
        // This exercises a real process, not a sub-second latency SLA. Keep the
        // completion wait bounded while allowing normal process startup variance.
        { timeout: 5000 },
      )
      .toBe("ready");
    expect(await connection.request("/v1/sources")).toEqual([]);
    expect(
      (
        await connection.request<CollectionManifest>(
          `/v1/ingestion/${preview.id}`,
        )
      ).entries[0]!.parseId,
    ).toBeDefined();
  } finally {
    await app.close();
    await f.close();
  }
});

test("changed approval payload and corrupt locators fail closed; policy revocation blocks historical originals", async () => {
  const f = await fixture();
  try {
    const ingestion = new Ingestion(f.registry, f.jobs);
    const commit = new SourceCommit(ingestion);
    const batch = await ready(f, ingestion);
    const change = commit.prepare(batch.id);
    commit.approve(change.id, change.digest, f.principal);
    const corrupted = commit.get(change.id);
    corrupted.patches[0]!.path = "KB-Sources/other.md";
    commit.save(corrupted);
    expect(() => commit.grant(change.id, 0, f.principal)).toThrow(
      "HASH_MISMATCH",
    );
    const entry = batch.entries[0]!;
    const parse = commit.parse(entry.parseId!);
    parse.blocks[0]!.end++;
    f.store.db
      .prepare("UPDATE parse_artifacts SET value=? WHERE id=?")
      .run(JSON.stringify(parse), parse.id);
    expect(() => commit.parse(parse.id)).toThrow("HASH_MISMATCH");
    const source = f.store.db
      .prepare("SELECT source_id FROM source_revisions WHERE id=?")
      .get(entry.revisionId) as { source_id: string };
    f.store.set(`source:${source.source_id}`, { retracted: true });
    expect(() => commit.original(entry.revisionId!)).toThrow("FORBIDDEN");
  } finally {
    await f.close();
  }
});

test("parse failure still exposes the acquired original, and temporary passwords never enter command storage", async () => {
  const f = await fixture();
  const app = createServer(f.registry, f.sessions, f.jobs);
  try {
    const ingestion = new Ingestion(f.registry, f.jobs, async () => {
      throw new Error("PARSER_CRASH");
    });
    const batch = await ready(f, ingestion);
    const entry = batch.entries[0]!;
    expect(entry.status).toBe("failed");
    expect(entry.revisionId).toBeUndefined();
    const response = await app.inject({
      url: `/v1/ingestion/${batch.id}/original/${entry.id}`,
      headers: { host: "127.0.0.1:27124", authorization: `Bearer ${f.token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.json().base64, "base64").toString()).toBe(
      "人工私密正文",
    );
    const secret = "temporary-test-password-never-persist";
    const reparse = await app.inject({
      method: "POST",
      url: `/v1/ingestion/${batch.id}/reparse`,
      headers: {
        host: "127.0.0.1:27124",
        authorization: `Bearer ${f.token}`,
        "x-policy-version": String(f.principal.policyVersion),
      },
      payload: { entryId: entry.id, encoding: "utf-8", password: secret },
    });
    expect(reparse.statusCode).toBe(200);
    for (const table of ["commands", "ingestions", "parse_artifacts", "events"])
      expect(
        JSON.stringify(f.store.db.prepare(`SELECT * FROM ${table}`).all()),
      ).not.toContain(secret);
  } finally {
    await app.close();
    await f.close();
  }
});
