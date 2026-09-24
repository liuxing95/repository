export const reminders = `
CREATE TABLE reminder_rules (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, enabled INTEGER NOT NULL, value TEXT NOT NULL);
CREATE TABLE reminder_occurrences (logical_key TEXT PRIMARY KEY, rule_id TEXT NOT NULL, owner_id TEXT NOT NULL, task_id TEXT, due_at INTEGER NOT NULL, generation INTEGER NOT NULL, cancel_generation INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, delivery_key TEXT NOT NULL, value TEXT NOT NULL);
CREATE INDEX reminder_due ON reminder_occurrences(state,due_at);
CREATE TABLE reminder_attempts (id TEXT PRIMARY KEY, logical_key TEXT NOT NULL, delivery_key TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, state TEXT NOT NULL, detail TEXT NOT NULL);
CREATE TABLE reminder_reviews (delivery_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, reviewed_at INTEGER NOT NULL);
CREATE TABLE reminder_pauses (owner_id TEXT NOT NULL, day TEXT NOT NULL, timezone TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id,day));
CREATE TABLE reminder_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO reminder_meta VALUES('fence','0');
PRAGMA user_version = 9;
`;
