import type { WorkspaceRegistry } from "../workspace/registry";
import { AppError } from "../errors";
import { Retraction } from "./retraction";

export function purgeInventory(registry: WorkspaceRegistry, sourceId: string) {
  if (!sourceId) throw new AppError("VALIDATION", 400, "请指定来源 ID。");
  const db = registry.store.db;
  const source = db
    .prepare("SELECT identity FROM sources WHERE id=?")
    .get(sourceId) as { identity: string } | undefined;
  if (!source) throw new AppError("NOT_FOUND", 404);
  const rows = db
    .prepare("SELECT id,object_hash FROM source_revisions WHERE source_id=?")
    .all(sourceId) as { id: string; object_hash: string }[];
  return {
    sourceId,
    identity: source.identity,
    retraction: new Retraction(registry).impact(sourceId),
    originalObjects: rows.map((row) => ({
      revisionId: row.id,
      hash: row.object_hash,
      otherSourceReferences: (
        db
          .prepare(
            "SELECT COUNT(DISTINCT source_id) n FROM source_revisions WHERE object_hash=? AND source_id<>?",
          )
          .get(row.object_hash, sourceId) as { n: number }
      ).n,
    })),
    localCopies: [
      "state.db 当前页与 WAL",
      "迁移前快照",
      "接入时 backup/",
      "用户配置的备份集",
      "Vault 人工笔记与受管页面",
      "日志与缓存",
    ],
    externalCopies:
      "已发往提供方的内容、用户另存副本和未来远端服务须另行核对。",
    status: "inventory-only",
    physicalDeletionPerformed: false,
    reason:
      "不能仅删业务行宣称物理清除；共享对象、派生正文、SQLite 页与备份需要逐副本处理。",
  };
}
