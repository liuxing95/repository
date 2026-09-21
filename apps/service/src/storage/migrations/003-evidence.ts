export const evidence = `
CREATE TABLE evidence_profiles (parse_id TEXT PRIMARY KEY REFERENCES parse_artifacts(id), value TEXT NOT NULL);
CREATE TABLE source_lineage (child TEXT PRIMARY KEY REFERENCES sources(id), parent TEXT NOT NULL REFERENCES sources(id));
CREATE TABLE evidence (id TEXT PRIMARY KEY, parse_id TEXT NOT NULL REFERENCES parse_artifacts(id), value TEXT NOT NULL);
CREATE TABLE evidence_claims (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE evidence_relations (from_id TEXT NOT NULL REFERENCES evidence_claims(id), to_id TEXT NOT NULL REFERENCES evidence_claims(id), kind TEXT NOT NULL, PRIMARY KEY(from_id,to_id,kind));
CREATE TABLE search_generations (id TEXT PRIMARY KEY, state TEXT NOT NULL, watermark INTEGER NOT NULL, fingerprint TEXT NOT NULL, blocks INTEGER NOT NULL DEFAULT 0);
CREATE TABLE search_documents (id INTEGER PRIMARY KEY, generation TEXT NOT NULL REFERENCES search_generations(id), parse_id TEXT NOT NULL, source_id TEXT NOT NULL, evidence_id TEXT NOT NULL REFERENCES evidence(id));
CREATE INDEX search_documents_generation ON search_documents(generation);
CREATE VIRTUAL TABLE search_fts USING fts5(title, terms, symbols, tokenize='ascii');
CREATE TABLE query_snapshots (id TEXT PRIMARY KEY, generation TEXT NOT NULL REFERENCES search_generations(id), expires_at INTEGER NOT NULL, value TEXT NOT NULL);
CREATE TABLE answer_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE answer_candidates (id TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version = 3;
`;
