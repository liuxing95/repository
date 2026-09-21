export const schemaVersion = 1;
export const foundation = `
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sessions (hash TEXT PRIMARY KEY, principal TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE jobs (id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, root_id TEXT NOT NULL, parent_id TEXT, queue TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, stage TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, fence INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, cancelled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX jobs_queue ON jobs(queue,state,created_at);
CREATE TABLE roots (id TEXT PRIMARY KEY REFERENCES jobs(id), limit_amount INTEGER NOT NULL, currency TEXT NOT NULL);
CREATE TABLE calls (id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, root_id TEXT NOT NULL REFERENCES roots(id), job_id TEXT NOT NULL REFERENCES jobs(id), route TEXT NOT NULL, price_version TEXT NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL, reserved INTEGER NOT NULL, actual INTEGER, state TEXT NOT NULL, provider_id TEXT UNIQUE);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_id TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE commands (key TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
PRAGMA user_version = 1;
`;
