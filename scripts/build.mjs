import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await build({
  entryPoints: [
    "apps/service/src/main.ts",
    "apps/service/src/runtime/worker-entry.ts",
    "apps/service/src/ingestion/parser-entry.ts",
  ],
  outdir: "apps/service/dist",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  alias: { "@kb/contracts": "./packages/contracts/src/index.ts" },
  sourcemap: true,
});
await mkdir("apps/obsidian-plugin/dist", { recursive: true });
await build({
  entryPoints: ["apps/agent-gateway/src/stdio.ts"],
  outfile: "apps/agent-gateway/dist/stdio.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  alias: { "@kb/contracts": "./packages/contracts/src/index.ts" },
  sourcemap: true,
});
await build({
  entryPoints: ["apps/obsidian-plugin/src/main.ts"],
  outfile: "apps/obsidian-plugin/dist/main.js",
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "cjs",
  external: [
    "obsidian",
    "node:fs",
    "node:path",
    "node:crypto",
    "node:fs/promises",
  ],
  sourcemap: true,
});
await Promise.all(
  ["manifest.json", "styles.css"].map((file) =>
    copyFile(
      `apps/obsidian-plugin/${file}`,
      `apps/obsidian-plugin/dist/${file}`,
    ),
  ),
);
