import { Store } from "../../apps/service/src/storage/store";
import { WorkspaceRegistry } from "../../apps/service/src/workspace/registry";
import { Jobs } from "../../apps/service/src/runtime/jobs";
import { Budget } from "../../apps/service/src/runtime/budget";
import { join } from "node:path";
const [data, jobId, fence, operationKey] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const store = new Store(join(data, "state.db"));
const budget = new Budget(new WorkspaceRegistry(store, data), new Jobs(store));
process.once("message", () => {
  let code = "RESERVED";
  try {
    budget.reserve({
      jobId,
      fence: Number(fence),
      operationKey,
      routeId: "test-model",
      inputTokens: 1,
    });
  } catch (error) {
    code = error instanceof Error ? error.message : "ERROR";
  } finally {
    store.close();
  }
  process.send?.({ code }, () => process.exit(0));
});
process.send?.({ ready: true });
