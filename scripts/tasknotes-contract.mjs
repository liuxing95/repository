import { chromium } from "@playwright/test";
import { mkdir, writeFile, cp, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
// Only a fresh synthetic Vault and separate Electron profile are used.
const root = resolve(".context/tasknotes/contract-" + Date.now());
const vault = join(root, "vault"),
  profile = join(root, "profile");
await mkdir(join(vault, ".obsidian/plugins"), { recursive: true });
await mkdir(profile, { recursive: true });
await cp(
  ".context/tasknotes/plugin",
  join(vault, ".obsidian/plugins/tasknotes"),
  { recursive: true },
);
await writeFile(
  join(vault, ".obsidian/community-plugins.json"),
  JSON.stringify(["tasknotes"]),
);
await writeFile(
  join(profile, "obsidian.json"),
  JSON.stringify({
    vaults: { a123456789abcdef: { path: vault, ts: Date.now(), open: true } },
  }),
);
const child = spawn(
  "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
  [`--user-data-dir=${profile}`, "--remote-debugging-port=0"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let browser;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("CDP timeout")), 20000);
    child.stderr.on("data", (b) => {
      const m = b.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(
    () => window.app?.plugins?.plugins.tasknotes?.api?.lifecycle.isReady(),
    {},
    { timeout: 60000 },
  );
  const result = await page.evaluate(async () => {
    const app = window.app,
      plugin = app.plugins.plugins.tasknotes,
      api = plugin.api;
    const id = crypto.randomUUID(),
      op = crypto.randomUUID();
    const task = await api.tasks.create(
      {
        title: "Contract synthetic task",
        status: "open",
        details: "Body stays byte-for-byte.\n\n第二段。",
        customFrontmatter: {
          taskId: id,
          kbOperationId: op,
          unknownContract: { keep: ["a", "b"] },
        },
      },
      { source: "knowledge-task-center", correlationId: op },
    );
    const file = app.vault.getAbstractFileByPath(task.path);
    const before = await app.vault.read(file);
    await api.tasks.setStatus(task.path, "done");
    const after = await app.vault.read(file);
    const parsed = app.metadataCache.getFileCache(file)?.frontmatter;
    await app.vault.createFolder("ContractMoved");
    await app.fileManager.renameFile(file, "ContractMoved/renamed.md");
    const moved = await app.vault.read(file);
    await app.vault.create("ContractMoved/copy.md", moved);
    const recurring = await api.tasks.create({
      title: "Contract recurring",
      status: "open",
      recurrence: "DTSTART:20260922T090000Z\nRRULE:FREQ=DAILY",
      customFrontmatter: { taskId: crypto.randomUUID() },
    });
    const once = await api.recurring.toggleCompleteInstance(
      recurring.path,
      "2026-09-22",
    );
    const twice = await api.recurring.toggleCompleteInstance(
      recurring.path,
      "2026-09-22",
    );
    const instance = await api.recurring.materializeOccurrence(
      recurring.path,
      "2026-09-23",
    );
    return {
      recurringProof: {
        once: once.complete_instances,
        twice: twice.complete_instances,
        instance,
      },
      version: plugin.manifest.version,
      apiVersion: api.apiVersion,
      capabilities: api.capabilities,
      before,
      after,
      moved,
      parsed,
      task,
      recurring,
      settings: api.catalog.statuses(),
      checks: {
        createMarker: before.includes(id) && before.includes(op),
        unknownField:
          after.includes("unknownContract:") && after.includes("  - a"),
        body:
          before.split("---").slice(2).join("---") ===
          after.split("---").slice(2).join("---"),
        moveIdentity: moved.includes(id),
        duplicateIdentity: (
          await app.vault.read(
            app.vault.getAbstractFileByPath("ContractMoved/copy.md"),
          )
        ).includes(id),
      },
      recurringMethods: Object.keys(api.recurring),
    };
  });
  const bytes = await readFile(".context/tasknotes/plugin/main.js");
  result.assetSha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(
    resolve(".context/tasknotes/contract-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      version: result.version,
      checks: result.checks,
      statuses: result.settings,
      recurringMethods: result.recurringMethods,
      assetSha256: result.assetSha256,
    }),
  );
} finally {
  if (browser) await browser.close();
  child.kill("SIGTERM");
}
