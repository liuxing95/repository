export const planning = `
CREATE TABLE planning_candidates (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE plan_revisions (id TEXT PRIMARY KEY, previous_id TEXT, candidate_id TEXT NOT NULL, accepted_at INTEGER NOT NULL, value TEXT NOT NULL);
CREATE TABLE plan_adoptions (id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL, at INTEGER NOT NULL, mode TEXT NOT NULL);
CREATE TABLE plan_outbox (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE plan_note_grants (token_hash TEXT PRIMARY KEY, plan_id TEXT NOT NULL, principal_id TEXT NOT NULL, value TEXT NOT NULL);
PRAGMA user_version = 8;
`;
