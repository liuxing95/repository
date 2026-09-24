import { hashBytes } from "../ingestion/objects";
import { digest } from "../workspace/registry";
import { AppError } from "../errors";

export function scanPublication(
  files: Record<string, string>,
  pageFiles: string[],
  outboundLinks: string[],
  attachmentFiles: string[] = [],
) {
  const expected = [
    "index.html",
    "search.json",
    ...pageFiles,
    ...attachmentFiles,
  ].sort();
  if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(expected))
    throw new AppError("PUBLICATION_OUTPUT", 409);
  const output = expected.map((path) => {
    const content = files[path]!;
    if (
      /file:\/\/|\/Users\/|\/home\/|KB-Sources\/|KB-Candidates\/|<script\b|javascript:/i.test(
        content,
      )
    )
      throw new AppError(
        "PUBLICATION_OUTPUT",
        409,
        "最终文件含有本地路径或脚本。",
      );
    for (const url of content.match(/https?:\/\/[^\s<>"']+/g) ?? []) {
      const normal = url.replace(/&amp;/g, "&");
      if (!outboundLinks.includes(normal))
        throw new AppError(
          "PUBLICATION_OUTPUT",
          409,
          "最终文件含未列入清单的外链。",
        );
    }
    return {
      path,
      hash: hashBytes(content),
      bytes: Buffer.byteLength(content),
    };
  });
  return { output, outputDigest: digest(output) };
}
