export const sources = `
CREATE TABLE objects (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
CREATE TABLE ingestions (id TEXT PRIMARY KEY, input_digest TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE sources (id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE);
CREATE TABLE source_revisions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), object_hash TEXT NOT NULL REFERENCES objects(hash), value TEXT NOT NULL, committed INTEGER NOT NULL DEFAULT 0, UNIQUE(source_id,object_hash));
CREATE TABLE parse_artifacts (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES source_revisions(id), fingerprint TEXT NOT NULL, value TEXT NOT NULL, committed INTEGER NOT NULL DEFAULT 0, UNIQUE(revision_id,fingerprint));
CREATE TABLE changesets (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES ingestions(id), value TEXT NOT NULL);
CREATE TABLE writer_grants (token_hash TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changesets(id), principal_id TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE writer_receipts (change_id TEXT NOT NULL REFERENCES changesets(id), sequence INTEGER NOT NULL, after_hash TEXT NOT NULL, PRIMARY KEY(change_id,sequence));
PRAGMA user_version = 2;
`;
