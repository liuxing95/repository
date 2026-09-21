-- Executable schema draft for one state database per vault.
-- It is a design reference, not a deployed migration. Application-level policy,
-- immutable-object fsync, digest verification, CAS and authorization remain required.
PRAGMA foreign_keys = ON;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE objects (
  hash TEXT PRIMARY KEY CHECK(length(hash)=64 AND hash NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
  relative_path TEXT NOT NULL UNIQUE
);
CREATE TABLE sources (
  id TEXT PRIMARY KEY, canonical_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  capture_kind TEXT NOT NULL CHECK(capture_kind IN ('file','browser_clip','user_note')),
  coverage TEXT NOT NULL CHECK(coverage IN ('full_text','excerpt','unknown')),
  status TEXT NOT NULL CHECK(status IN ('active','retracted','purged')),
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json)), created_at TEXT NOT NULL
);
CREATE TABLE source_revisions (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
  original_hash TEXT NOT NULL REFERENCES objects(hash), captured_at TEXT NOT NULL,
  published_at TEXT, UNIQUE(source_id,original_hash)
);
CREATE TABLE parse_artifacts (
  id TEXT PRIMARY KEY, source_revision_id TEXT NOT NULL REFERENCES source_revisions(id),
  parser_fingerprint TEXT NOT NULL, normalized_hash TEXT NOT NULL REFERENCES objects(hash),
  offset_unit TEXT NOT NULL DEFAULT 'utf16' CHECK(offset_unit='utf16'),
  created_at TEXT NOT NULL, UNIQUE(source_revision_id,parser_fingerprint,normalized_hash)
);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, parse_id TEXT NOT NULL REFERENCES parse_artifacts(id),
  block_id TEXT NOT NULL, start_utf16 INTEGER NOT NULL CHECK(start_utf16>=0),
  end_utf16 INTEGER NOT NULL CHECK(end_utf16>start_utf16),
  quote_hash TEXT NOT NULL CHECK(length(quote_hash)=64 AND quote_hash NOT GLOB '*[^0-9a-f]*'),
  UNIQUE(parse_id,start_utf16,end_utf16)
);
CREATE INDEX evidence_parse ON evidence(parse_id);
CREATE TABLE claims (
  id TEXT PRIMARY KEY, statement TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('sourced','inferred','user-stated')),
  review_state TEXT NOT NULL CHECK(review_state IN ('draft','reviewed','disputed','stale')),
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json))
);
CREATE TABLE claim_evidence (
  claim_id TEXT NOT NULL REFERENCES claims(id), evidence_id TEXT NOT NULL REFERENCES evidence(id),
  relation TEXT NOT NULL CHECK(relation IN ('supports','contradicts','qualifies')),
  PRIMARY KEY(claim_id,evidence_id,relation)
);
CREATE INDEX claim_evidence_reverse ON claim_evidence(evidence_id);
CREATE TABLE pages (
  id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE,
  page_type TEXT NOT NULL CHECK(page_type IN ('concept','system','comparison','decision','query'))
);
CREATE TABLE page_revisions (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id),
  body_hash TEXT NOT NULL REFERENCES objects(hash),
  provenance_hash TEXT NOT NULL REFERENCES objects(hash),
  review_state TEXT NOT NULL CHECK(review_state IN ('draft','reviewed','needs_review','stale')),
  created_at TEXT NOT NULL
);
CREATE TABLE page_revision_claims (
  page_revision_id TEXT NOT NULL REFERENCES page_revisions(id),
  claim_id TEXT NOT NULL REFERENCES claims(id), PRIMARY KEY(page_revision_id,claim_id)
);
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE CHECK(sequence>=0),
  manifest_hash TEXT NOT NULL REFERENCES objects(hash), created_at TEXT NOT NULL
);
-- Manifest contents are runtime-validated against SourceRevision/ParseArtifact/PageRevision.
CREATE TABLE snapshot_members (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id), doc_id TEXT NOT NULL,
  revision_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('source','wiki','human-note')),
  object_hash TEXT NOT NULL REFERENCES objects(hash), PRIMARY KEY(snapshot_id,doc_id)
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','awaiting_writer',
    'waiting_approval','blocked_budget','retry_wait','conflict','failed','cancelled')),
  stage TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt>=0),
  lease_owner TEXT, lease_until_ms INTEGER, fence INTEGER NOT NULL DEFAULT 0 CHECK(fence>=0),
  payload_hash TEXT NOT NULL REFERENCES objects(hash), updated_at TEXT NOT NULL
);
CREATE INDEX jobs_queue ON jobs(state,updated_at);
CREATE TABLE request_keys (
  principal_id TEXT NOT NULL, request_key TEXT NOT NULL,
  body_hash TEXT NOT NULL REFERENCES objects(hash), job_id TEXT NOT NULL REFERENCES jobs(id),
  PRIMARY KEY(principal_id,request_key)
);
CREATE TABLE stage_outputs (
  job_id TEXT NOT NULL REFERENCES jobs(id), stage TEXT NOT NULL,
  input_digest TEXT NOT NULL CHECK(length(input_digest)=64),
  output_hash TEXT NOT NULL REFERENCES objects(hash), PRIMARY KEY(job_id,stage,input_digest)
);
CREATE TABLE changesets (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
  base_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  proposal_digest TEXT NOT NULL CHECK(length(proposal_digest)=64),
  payload_hash TEXT NOT NULL REFERENCES objects(hash), policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('proposed','approved','prepared','applying','committed',
    'conflict','rejected','paused_authorization','rolled_back')),
  UNIQUE(id,proposal_digest,policy_version)
);
CREATE TABLE patches (
  change_set_id TEXT NOT NULL REFERENCES changesets(id), patch_index INTEGER NOT NULL CHECK(patch_index>=0),
  path TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('create','update')),
  before_hash TEXT REFERENCES objects(hash), after_hash TEXT NOT NULL REFERENCES objects(hash),
  CHECK((action='create' AND before_hash IS NULL) OR (action='update' AND before_hash IS NOT NULL)),
  PRIMARY KEY(change_set_id,patch_index), UNIQUE(change_set_id,path)
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, change_set_id TEXT NOT NULL, proposal_digest TEXT NOT NULL,
  policy_version TEXT NOT NULL, principal_id TEXT NOT NULL,
  approved_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
  CHECK(expires_at_ms>approved_at_ms),
  FOREIGN KEY(change_set_id,proposal_digest,policy_version)
    REFERENCES changesets(id,proposal_digest,policy_version)
);
-- A conflict hash can refer to a human edit not copied into the object store.
CREATE TABLE file_receipts (
  change_set_id TEXT NOT NULL, patch_index INTEGER NOT NULL, grant_id TEXT NOT NULL UNIQUE,
  observed_hash TEXT CHECK(observed_hash IS NULL OR
    (length(observed_hash)=64 AND observed_hash NOT GLOB '*[^0-9a-f]*')),
  result TEXT NOT NULL CHECK(result IN ('applied','already_applied','conflict')),
  PRIMARY KEY(change_set_id,patch_index),
  FOREIGN KEY(change_set_id,patch_index) REFERENCES patches(change_set_id,patch_index)
);
CREATE TABLE writer_sessions (
  id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, epoch INTEGER NOT NULL UNIQUE CHECK(epoch>0),
  lease_until_ms INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1))
);
CREATE UNIQUE INDEX only_one_active_writer ON writer_sessions(active) WHERE active=1;
CREATE TABLE model_calls (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt INTEGER NOT NULL CHECK(attempt>=1), route_id TEXT NOT NULL, price_book_version TEXT NOT NULL,
  reserved_microusd INTEGER NOT NULL CHECK(reserved_microusd>=0),
  actual_microusd INTEGER CHECK(actual_microusd>=0),
  input_tokens INTEGER CHECK(input_tokens>=0), output_tokens INTEGER CHECK(output_tokens>=0),
  provider_request_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','settled','outcome_unknown','cancelled'))
);
CREATE TABLE budget_buckets (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('job','day','month')),
  owner_key TEXT NOT NULL, period_key TEXT NOT NULL,
  limit_microusd INTEGER NOT NULL CHECK(limit_microusd>=0),
  spent_microusd INTEGER NOT NULL DEFAULT 0 CHECK(spent_microusd>=0),
  reserved_microusd INTEGER NOT NULL DEFAULT 0 CHECK(reserved_microusd>=0),
  UNIQUE(scope,owner_key,period_key)
);
-- Admission uses a conditional UPDATE in one transaction for all affected buckets.
-- Do not CHECK(spent+reserved<=limit): unexpected real provider charges still need recording.
CREATE TABLE budget_reservations (
  call_id TEXT NOT NULL REFERENCES model_calls(id), bucket_id TEXT NOT NULL REFERENCES budget_buckets(id),
  amount_microusd INTEGER NOT NULL CHECK(amount_microusd>=0), PRIMARY KEY(call_id,bucket_id)
);
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), consumed_at TEXT
);
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, action TEXT NOT NULL,
  resource_id TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json))
);
