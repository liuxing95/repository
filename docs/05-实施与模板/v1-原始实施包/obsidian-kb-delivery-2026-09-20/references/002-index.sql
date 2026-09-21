-- Rebuildable index draft. Stored object hashes are checked against state.db before use.
PRAGMA foreign_keys = ON;
CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE documents (
  row_id INTEGER PRIMARY KEY, snapshot_id TEXT NOT NULL, doc_id TEXT NOT NULL,
  revision_id TEXT NOT NULL, block_id TEXT NOT NULL, object_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('source','wiki','human-note')),
  source_family TEXT NOT NULL, evidence_ids_json TEXT NOT NULL CHECK(json_valid(evidence_ids_json)),
  UNIQUE(snapshot_id,doc_id,revision_id,block_id)
);
CREATE VIRTUAL TABLE lexical USING fts5(title_terms, body_terms, tokenize='unicode61');
-- rowid in lexical is documents.row_id; application writes both in the same index transaction.
CREATE TABLE exact_symbols (
  symbol TEXT NOT NULL, document_row_id INTEGER NOT NULL REFERENCES documents(row_id),
  PRIMARY KEY(symbol,document_row_id)
);
CREATE INDEX document_snapshot ON documents(snapshot_id);
