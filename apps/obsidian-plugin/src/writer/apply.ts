import type { App, MarkdownView, TFile } from "obsidian";
import type { WriterPatch, WriterGrant } from "@kb/contracts";
import { Connection } from "../connection";
import { guardGrant, guardPath, guardPathSync, writerHash } from "./guard";
export type WriterHost = {
  root: string;
  ensureRoot?: (path: string) => Promise<void>;
  process?: (path: string, fn: (current: string) => string) => Promise<void>;
  isEditing(path: string): boolean;
  read(path: string): Promise<string | null>;
  create(path: string, content: string): Promise<void>;
};
export function obsidianHost(app: App, root: string): WriterHost {
  return {
    root,
    ensureRoot: async (path) => {
      const folder = path.split("/")[0]!;
      if (!(await app.vault.adapter.exists(folder)))
        await app.vault.createFolder(folder);
    },
    isEditing: (path) => {
      let editing = false;
      app.workspace.iterateAllLeaves((leaf) => {
        if ((leaf.view as MarkdownView).file?.path === path) editing = true;
      });
      return editing;
    },
    read: async (path) =>
      (await app.vault.adapter.exists(path))
        ? await app.vault.adapter.read(path)
        : null,
    process: async (path, fn) => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!file || !("extension" in file)) throw new Error("WRITER_CONFLICT");
      await app.vault.process(file as TFile, fn);
    },
    create: async (path, content) => {
      await app.vault.create(path, content);
    },
  };
}
export async function applyGrant(
  host: WriterHost,
  connection: Connection,
  grant: WriterGrant,
) {
  guardGrant(connection, grant);
  await host.ensureRoot?.(grant.patch.path);
  guardGrant(connection, grant);
  await guardPath(host.root, grant.patch.path);
  if (host.isEditing(grant.patch.path)) throw new Error("WRITER_EDITING");
  const before = await host.read(grant.patch.path);
  guardGrant(connection, grant);
  if (host.isEditing(grant.patch.path)) throw new Error("WRITER_EDITING");
  if (before === null) {
    if (grant.patch.beforeHash !== null) throw new Error("WRITER_CONFLICT");
    await guardPath(host.root, grant.patch.path);
    guardGrant(connection, grant);
    if (host.isEditing(grant.patch.path)) throw new Error("WRITER_EDITING");
    await host.create(grant.patch.path, grant.patch.content);
  } else if (writerHash(before) !== grant.patch.afterHash) {
    if (
      grant.patch.path.startsWith("KB-Sources/") ||
      !host.process ||
      writerHash(before) !== grant.patch.beforeHash
    )
      throw new Error("WRITER_CONFLICT");
    await host.process(grant.patch.path, (current) => {
      guardGrant(connection, grant);
      guardPathSync(host.root, grant.patch.path);
      if (host.isEditing(grant.patch.path)) throw new Error("WRITER_EDITING");
      if (writerHash(current) !== grant.patch.beforeHash)
        throw new Error("WRITER_CONFLICT");
      return grant.patch.content;
    });
  }
  // A matching afterHash recovers an applied write whose receipt was lost.
  await guardPath(host.root, grant.patch.path);
  guardGrant(connection, grant);
  if (host.isEditing(grant.patch.path)) throw new Error("WRITER_EDITING");
  const after = await host.read(grant.patch.path);
  if (after === null || writerHash(after) !== grant.patch.afterHash)
    throw new Error("WRITER_CONFLICT");
  return grant.patch.afterHash;
}
export async function applyChange(
  host: WriterHost,
  connection: Connection,
  change: { id: string; digest: string; patches: WriterPatch[] },
  route = "/v1/changes",
) {
  await connection.refresh();
  for (const patch of change.patches) {
    const grant = await connection.request<WriterGrant>(
      `${route}/${change.id}/grant`,
      "POST",
      { sequence: patch.sequence },
    );
    if (
      grant.digest !== change.digest ||
      grant.patch.afterHash !== patch.afterHash ||
      grant.patch.path !== patch.path ||
      grant.patch.beforeHash !== patch.beforeHash ||
      grant.patch.content !== patch.content ||
      grant.patch.sequence !== patch.sequence
    )
      throw new Error("WRITER_CONFLICT");
    if (route === "/v1/wiki/changes")
      await connection.request(`${route}/${change.id}/validate`, "POST", {
        token: grant.token,
      });
    const afterHash = await applyGrant(host, connection, grant);
    await connection.request(`${route}/${change.id}/receipt`, "POST", {
      token: grant.token,
      afterHash,
    });
  }
  const hashes: string[] = [];
  for (const patch of change.patches) {
    await guardPath(host.root, patch.path);
    if (host.isEditing(patch.path)) throw new Error("WRITER_EDITING");
    const value = await host.read(patch.path);
    if (value === null) throw new Error("WRITER_CONFLICT");
    hashes.push(writerHash(value));
  }
  return connection.request<{ state: string }>(
    `${route}/${change.id}/finish`,
    "POST",
    { hashes },
  );
}
