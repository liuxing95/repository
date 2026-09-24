import {
  isAbsolute,
  relative,
  resolve,
  sep,
  basename,
  dirname,
  join,
} from "node:path";
import { realpath, lstat } from "node:fs/promises";
import { AppError } from "../errors";

export function inside(root: string, path: string) {
  const r = relative(resolve(root), resolve(path));
  return (
    r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r))
  );
}
export async function trustedDirectory(path: string) {
  const absolute = resolve(path);
  const real = await realpath(absolute);
  if (
    (await lstat(absolute)).isSymbolicLink() ||
    !(await lstat(real)).isDirectory()
  )
    throw new AppError("FORBIDDEN");
  return real;
}
export async function canonicalDestination(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    return join(
      await canonicalDestination(dirname(absolute)),
      basename(absolute),
    );
  }
}
