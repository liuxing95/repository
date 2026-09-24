import { WorkspaceRegistry } from "../workspace/registry";
export function diagnostics(registry: WorkspaceRegistry) {
  const store = registry.store;
  let policyVersion: number | null = null;
  try {
    policyVersion = registry.get().policyVersion;
  } catch {
    /* Unknown schema remains diagnostic-only. */
  }
  const base = {
    serviceVersion: "0.1.0",
    policyVersion,
    supportedSchemaVersion: 9,
    databaseSchemaVersion: store.db.pragma("user_version", { simple: true }),
    schemaVersion: 1,
    node: process.versions.node,
    sqlite: store.sqliteVersion,
    readOnly: store.readOnly,
    restoreHeld: store.restoreHeld,
    uptimeSeconds: Math.floor(process.uptime()),
    capabilities: registry.capabilities(),
  };
  if (store.readOnly) return { ...base, queues: [], cost: null };
  return {
    ...base,
    queues: store.db
      .prepare(
        "SELECT queue,state,count(*) count FROM jobs GROUP BY queue,state",
      )
      .all(),
    cost: store.db
      .prepare(
        "SELECT 'USD' currency, COALESCE(SUM(CASE WHEN state='settled' THEN actual ELSE 0 END),0) settledMicroUsd, COALESCE(SUM(CASE WHEN state IN ('reserved','dispatched','unknown') THEN reserved ELSE 0 END),0) reservedMicroUsd, COALESCE(SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END),0) unknownCount FROM calls",
      )
      .get(),
  };
}
