export const rag = `
CREATE TABLE retrieval_chunks (generation TEXT NOT NULL REFERENCES search_generations(id), evidence_id TEXT NOT NULL REFERENCES evidence(id), parse_id TEXT NOT NULL REFERENCES parse_artifacts(id), ordinal INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, chunker TEXT NOT NULL, PRIMARY KEY(generation,evidence_id));
CREATE INDEX retrieval_chunks_parse ON retrieval_chunks(generation,parse_id);
CREATE TABLE retrieval_vectors (generation TEXT NOT NULL REFERENCES search_generations(id), evidence_id TEXT NOT NULL REFERENCES evidence(id), model_fingerprint TEXT NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(generation,evidence_id,model_fingerprint));
PRAGMA user_version = 10;
`;
