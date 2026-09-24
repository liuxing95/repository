import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { AppError } from "../errors";
import { hashBytes } from "../ingestion/objects";

export function readPublicAttachment(vaultPath: string, token: string) {
  const name = token.match(
    /^!\[\[KB-Wiki\/PublicAssets\/([a-zA-Z0-9_-][a-zA-Z0-9._-]{0,79}\.txt)\]\]$/,
  )?.[1];
  if (!name || name.startsWith("."))
    throw new AppError(
      "FORBIDDEN",
      403,
      "仅支持 KB-Wiki/PublicAssets 下直接放置的 UTF-8 文本附件。",
    );
  const wiki = join(vaultPath, "KB-Wiki"),
    directory = join(wiki, "PublicAssets"),
    path = join(directory, name);
  try {
    if (
      ![wiki, directory].every(
        (part) =>
          lstatSync(part).isDirectory() && !lstatSync(part).isSymbolicLink(),
      )
    )
      throw new AppError("FORBIDDEN", 403);
  } catch {
    throw new AppError("FORBIDDEN", 403, "公开附件目录不存在或不是可信目录。");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 100_000)
      throw new AppError("FORBIDDEN", 403);
    const bytes = readFileSync(fd);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new AppError("VALIDATION", 400, "附件必须是有效的 UTF-8 文本。");
    }
    if (content.includes("\0")) throw new AppError("FORBIDDEN", 403);
    const hash = hashBytes(bytes);
    return { path: `asset-${hash}.txt`, hash, bytes: bytes.length, content };
  } finally {
    closeSync(fd);
  }
}
