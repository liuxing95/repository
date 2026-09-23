export const tasks = `
CREATE TABLE task_observations (task_id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE task_observation_history (task_id TEXT NOT NULL, revision TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(task_id,revision));
CREATE TABLE task_inventories (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, base_generation INTEGER NOT NULL, started_at INTEGER NOT NULL, value TEXT NOT NULL);
CREATE TABLE task_inventory_items (inventory_id TEXT NOT NULL REFERENCES task_inventories(id), path TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(inventory_id,path));
CREATE TABLE task_occurrences (occurrence_key TEXT PRIMARY KEY, series_id TEXT NOT NULL, original TEXT NOT NULL, timezone TEXT NOT NULL, task_id TEXT NOT NULL, rule_digest TEXT NOT NULL);
CREATE TABLE task_commands (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE task_event_inbox (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, kind TEXT NOT NULL, received_at INTEGER NOT NULL, processed_at INTEGER);
CREATE TABLE task_invalidations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL, UNIQUE(task_id,revision));
CREATE TABLE task_cancel_outbox (id TEXT PRIMARY KEY REFERENCES task_invalidations(id), state TEXT NOT NULL);
CREATE TABLE task_baselines (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE task_plan_reads (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE projection_receipts (plan_id TEXT NOT NULL, target TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(plan_id,target));
PRAGMA user_version = 7;
`;
