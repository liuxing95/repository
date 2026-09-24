export const changesets = `
CREATE TABLE wiki_changes (id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE wiki_approvals (id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES wiki_changes(id), value TEXT NOT NULL);
CREATE TABLE wiki_grants (token_hash TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES wiki_changes(id), principal_id TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE wiki_receipts (change_id TEXT NOT NULL REFERENCES wiki_changes(id), sequence INTEGER NOT NULL, after_hash TEXT NOT NULL, PRIMARY KEY(change_id,sequence));
CREATE TABLE wiki_pages (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, match_key TEXT NOT NULL UNIQUE, revision_id TEXT NOT NULL);
CREATE TABLE wiki_revisions (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, change_id TEXT NOT NULL REFERENCES wiki_changes(id), value TEXT NOT NULL);
CREATE TABLE wiki_edges (revision_id TEXT NOT NULL REFERENCES wiki_revisions(id), evidence_id TEXT NOT NULL REFERENCES evidence(id), PRIMARY KEY(revision_id,evidence_id));
CREATE TABLE wiki_observations (id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES wiki_pages(id), hash TEXT, value TEXT NOT NULL);
CREATE INDEX wiki_observations_page ON wiki_observations(page_id);
CREATE TABLE wiki_impacts (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE wiki_fts USING fts5(revision_id UNINDEXED, title, terms, tokenize='ascii');
PRAGMA user_version = 4;
`;
