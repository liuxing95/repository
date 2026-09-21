import type { App, MarkdownView } from "obsidian";
import type { ChangeSet, WriterGrant } from "@kb/contracts";
import { Connection } from "../connection";
import { guardGrant, guardPath, writerHash } from "./guard";
export type WriterHost = {
  root: string;
  ensureRoot?: () => Promise<void>;
  isEditing(path: string): boolean;
  read(path: string): Promise<string | null>;
  create(path: string, content: string): Promise<void>;
};
export function obsidianHost(app: App, root: string): WriterHost {
  return {
    root,
    ensureRoot: async () => {
      if (!(await app.vault.adapter.exists("KB-Sources")))
        await app.vault.createFolder("KB-Sources");
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
  await host.ensureRoot?.();
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
  } else if (writerHash(before) !== grant.patch.afterHash)
    throw new Error("WRITER_CONFLICT");
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
  change: ChangeSet,
) {
  await connection.refresh();
  for (const patch of change.patches) {
    const grant = await connection.request<WriterGrant>(
      `/v1/changes/${change.id}/grant`,
      "POST",
      { sequence: patch.sequence },
    );
    if (
      grant.digest !== change.digest ||
      grant.patch.afterHash !== patch.afterHash ||
      grant.patch.path !== patch.path
    )
      throw new Error("WRITER_CONFLICT");
    const afterHash = await applyGrant(host, connection, grant);
    await connection.request(`/v1/changes/${change.id}/receipt`, "POST", {
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
  return connection.request<ChangeSet>(
    `/v1/changes/${change.id}/finish`,
    "POST",
    { hashes },
  );
}
