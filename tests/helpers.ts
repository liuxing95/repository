import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../apps/service/src/storage/store";
import { WorkspaceRegistry } from "../apps/service/src/workspace/registry";
import { Sessions } from "../apps/service/src/http/auth";
import { Jobs } from "../apps/service/src/runtime/jobs";
import { Budget } from "../apps/service/src/runtime/budget";
export async function fixture(now = Date.now) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kb-runtime-")));
  const source = join(root, "source");
  const data = join(root, "data");
  await mkdir(source);
  await mkdir(data);
  await writeFile(join(source, "note.md"), "人工私密正文");
  const store = new Store(join(data, "state.db"));
  const registry = new WorkspaceRegistry(store, data);
  const scan = await registry.preview(source);
  const workspace = await registry.adopt(source, scan.digest);
  const sessions = new Sessions(registry, now);
  const deviceId = randomUUID();
  registry.claimMaster(deviceId, 0);
  const paired = await sessions.pair({
    code: sessions.issuePairing(),
    deviceId,
    vaultPath: workspace.vaultPath,
  });
  const jobs = new Jobs(store, now);
  const budget = new Budget(registry, jobs, now);
  return {
    root,
    data,
    source,
    store,
    registry,
    sessions,
    deviceId,
    ...paired,
    jobs,
    budget,
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export const pricing = {
  version: "test-1",
  expiresAt: Date.now() + 86400_000,
  inputPerMillion: 0,
  outputPerMillion: 0,
  fixedCost: 60,
  maxInputTokens: 100,
  maxOutputTokens: 100,
};
export const settings = {
  schemaVersion: 1,
  budget: {
    currency: "USD",
    timezone: "UTC",
    jobLimit: 100,
    dayLimit: 100,
    monthLimit: 100,
  },
  routes: [
    { id: "test-model", purpose: "model", enabled: true, price: pricing },
  ],
};
