export const research = `
CREATE TABLE research_jobs(id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE research_snapshots(id TEXT PRIMARY KEY, research_id TEXT NOT NULL REFERENCES research_jobs(id), value TEXT NOT NULL);
CREATE TABLE research_assessments(snapshot_id TEXT NOT NULL REFERENCES research_snapshots(id), question_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(snapshot_id,question_id));
CREATE TABLE research_chapters(id TEXT PRIMARY KEY, research_id TEXT NOT NULL REFERENCES research_jobs(id), snapshot_id TEXT NOT NULL REFERENCES research_snapshots(id), question_id TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(snapshot_id,question_id));
CREATE TABLE research_attempts(operation_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, job_id TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE research_reports(id TEXT PRIMARY KEY, research_id TEXT NOT NULL REFERENCES research_jobs(id), fingerprint TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(research_id,fingerprint));
PRAGMA user_version=5;
`;
