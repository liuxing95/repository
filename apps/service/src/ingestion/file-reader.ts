import { constants } from "node:fs";
import { lstat, open, realpath, readdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import yauzl from "yauzl";
import { AppError } from "../errors";
import { inside } from "../security/paths";
export async function readGranted(
  root: string,
  path: string,
  maxBytes: number,
) {
  const canonical = await realpath(root);
  if ((await lstat(root)).isSymbolicLink())
    throw new AppError("FORBIDDEN", 403);
  const target = resolve(root, path);
  if (!inside(resolve(root), target)) throw new AppError("FORBIDDEN", 403);
  let cursor = root;
  for (const part of relative(root, target).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink())
      throw new AppError("FORBIDDEN", 403);
  }
  const actual = await realpath(target);
  if (!inside(canonical, actual)) throw new AppError("FORBIDDEN", 403);
  const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxBytes)
      throw new AppError("FETCH_LIMIT");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      (await realpath(target)) !== actual
    )
      throw new AppError("BASELINE");
    return bytes;
  } finally {
    await file.close();
  }
}
export async function listGranted(root: string, maxEntries: number) {
  if (
    !(await lstat(root)).isDirectory() ||
    (await lstat(root)).isSymbolicLink()
  )
    throw new AppError("FORBIDDEN", 403);
  const result: string[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number) => {
    if (depth > 20) throw new AppError("FETCH_LIMIT");
    for (const entry of await readdir(join(root, dir), {
      withFileTypes: true,
    })) {
      if (++visited > maxEntries) throw new AppError("FETCH_LIMIT");
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.name === ".git") continue;
      if (entry.isSymbolicLink()) {
        result.push(name);
        continue;
      }
      if (entry.isDirectory()) await walk(name, depth + 1);
      else result.push(name);
    }
  };
  await walk("", 0);
  return result.sort();
}
export function unzipBounded(
  bytes: Buffer,
  maxBytes: number,
  maxEntries: number,
): Promise<Map<string, Buffer>> {
  return new Promise((resolveResult, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new AppError("ARCHIVE_INVALID"));
          return;
        }
        const result = new Map<string, Buffer>();
        let total = 0;
        let count = 0;
        let failed = false;
        const fail = () => {
          if (failed) return;
          failed = true;
          zip.close();
          reject(new AppError("ARCHIVE_LIMIT"));
        };
        zip.on("error", fail);
        zip.on("entry", (entry: yauzl.Entry) => {
          const name = entry.fileName;
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (
            ++count > maxEntries ||
            isAbsolute(name) ||
            name.length > 1024 ||
            name.includes("\0") ||
            /^[A-Za-z]:/.test(name) ||
            name.split("/").length > 21 ||
            name.includes("\\") ||
            name.split("/").some((p) => p === ".." || p === ".") ||
            mode === 0o120000 ||
            entry.generalPurposeBitFlag & 1 ||
            total + entry.uncompressedSize > maxBytes
          ) {
            fail();
            return;
          }
          if (name.endsWith("/")) {
            zip.readEntry();
            return;
          }
          if (result.has(name)) {
            fail();
            return;
          }
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) {
              fail();
              return;
            }
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => {
              total += chunk.length;
              if (total > maxBytes) {
                stream.destroy();
                fail();
              } else chunks.push(chunk);
            });
            stream.on("error", fail);
            stream.on("end", () => {
              if (!failed) {
                result.set(name, Buffer.concat(chunks));
                zip.readEntry();
              }
            });
          });
        });
        zip.on("end", () => {
          if (!failed) resolveResult(result);
        });
        zip.readEntry();
      },
    );
  });
}
