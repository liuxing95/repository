import { expect, test } from "vitest";
import { mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixture } from "../helpers";
import {
  readGranted,
  unzipBounded,
} from "../../apps/service/src/ingestion/file-reader";
import {
  normalizeUrl,
  withinScope,
} from "../../apps/service/src/ingestion/fetcher";
import { AcquisitionPlan } from "@kb/contracts";
import { randomUUID } from "node:crypto";
import {
  parseText,
  parseWeb,
} from "../../apps/service/src/ingestion/web-parser";
import { validateTarget } from "../../apps/service/src/security/egress";

test("explicit file grants reject symlink escape, oversized files and invalid encodings without replacement", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.source, "folder"));
    await writeFile(join(f.root, "outside"), "private");
    await symlink(join(f.root, "outside"), join(f.source, "escape"));
    await expect(readGranted(f.source, "escape", 1000)).rejects.toThrow(
      "FORBIDDEN",
    );
    await expect(readGranted(f.source, "../outside", 1000)).rejects.toThrow(
      "FORBIDDEN",
    );
    await expect(readGranted(f.source, "note.md", 1)).rejects.toThrow(
      "FETCH_LIMIT",
    );
    expect(
      parseText(Buffer.from([0xff, 0xfe, 0x00]), "bad", "utf-8").gaps.join(),
    ).toContain("ENCODING_INVALID");
  } finally {
    await f.close();
  }
});
test("archive traversal, symlinks and decompression bombs are refused before materialization", async () => {
  const f = await fixture();
  try {
    await promisify(execFile)("python3", [
      "-c",
      `import zipfile,sys\np=sys.argv[1]\nfor name,item,data,mode in [('escape.zip','../outside',b'bad',0),('bomb.zip','large.txt',b'x'*100000,0),('link.zip','link',b'/etc/passwd',0o120777),('good.zip','dist/index.js',b'export const n=1',0)]:\n with zipfile.ZipFile(p+'/'+name,'w',zipfile.ZIP_DEFLATED) as z:\n  i=zipfile.ZipInfo(item);i.external_attr=mode<<16;i.compress_type=zipfile.ZIP_DEFLATED;z.writestr(i,data)`,
      f.root,
    ]);
    for (const name of ["escape.zip", "bomb.zip", "link.zip"])
      await expect(
        unzipBounded(await readFile(join(f.root, name)), 2000, 10),
      ).rejects.toThrow();
    expect(
      (await unzipBounded(await readFile(join(f.root, "good.zip")), 2000, 10))
        .get("dist/index.js")
        ?.toString(),
    ).toBe("export const n=1");
  } finally {
    await f.close();
  }
});
test("URL identity retains semantic queries; redirects and DNS rebindings must stay in approved scope", async () => {
  const plan = AcquisitionPlan.parse({
    id: randomUUID(),
    kind: "collection",
    entry: "https://example.com/docs?v=1",
    allowedHosts: ["example.com"],
    allowedPaths: ["/docs"],
  });
  expect(normalizeUrl(plan.entry + "#h")).toBe(plan.entry);
  expect(normalizeUrl(plan.entry)).not.toBe(
    normalizeUrl("https://example.com/docs?v=2"),
  );
  expect(withinScope(new URL("https://example.com/docs2"), plan)).toBe(false);
  expect(
    withinScope(new URL("https://example.com/docs/%2e%2e/private"), plan),
  ).toBe(false);
  await expect(
    validateTarget(plan.entry, plan.allowedHosts, async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    validateTarget("https://169.254.169.254/metadata", ["169.254.169.254"]),
  ).rejects.toThrow("FORBIDDEN");
});
test("static extraction does not trust canonical or run HTML; tables retain headers, units and code", () => {
  const parsed = parseWeb(
    Buffer.from(
      `<title>Test</title><link rel="canonical" href="https://unrelated.example/source"><main><h1>Data</h1><table><tr><th>Time (ms)</th><th>Count</th></tr><tr><td>1.2</td><td>3</td></tr></table><pre>run(false)</pre><div role="tab">Python</div><p>${"Real prose. ".repeat(50)}</p><img src="http://localhost/leak"><script>throw new Error('executed')</script></main>`,
    ),
    "https://example.com/docs",
  );
  expect(parsed.canonicalClaim).toBe("https://unrelated.example/source");
  expect(parsed.blocks.find((b) => b.kind === "table")?.text).toContain(
    "Time (ms)\tCount",
  );
  expect(parsed.gaps.join()).toContain("CODE_TABS");
  expect(parsed.text).not.toContain("executed");
});
