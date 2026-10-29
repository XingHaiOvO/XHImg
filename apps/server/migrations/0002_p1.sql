ALTER TABLE folders ADD COLUMN processing_policy TEXT;
ALTER TABLE folders ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN source_key TEXT;
ALTER TABLE images ADD COLUMN source_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN source_format TEXT;
ALTER TABLE images ADD COLUMN source_checksum TEXT;
ALTER TABLE images ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'skipped';
ALTER TABLE images ADD COLUMN classification_status TEXT NOT NULL DEFAULT 'skipped';
ALTER TABLE images ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE images ADD COLUMN organization_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE images ADD COLUMN publication_hold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN processing_info TEXT NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN payload TEXT NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX one_image_job ON jobs(image_id,kind);
CREATE INDEX jobs_kind_pending ON jobs(kind,state,next_run,created_at);
CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY, image_id TEXT NOT NULL UNIQUE,
  actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL,
  folder_id TEXT NOT NULL REFERENCES folders(id), storage_id TEXT NOT NULL REFERENCES storage_backends(id),
  name TEXT NOT NULL, visibility TEXT NOT NULL, length INTEGER NOT NULL,
  expected_hash TEXT, confirmed_offset INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'created', policy TEXT NOT NULL,
  classify INTEGER NOT NULL DEFAULT 0, explicit_folder INTEGER NOT NULL DEFAULT 0,
  explicit_storage INTEGER NOT NULL DEFAULT 0,
  error TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  tus_metadata TEXT
);
CREATE INDEX upload_sessions_owner ON upload_sessions(actor_kind,actor_id,created_at);
CREATE INDEX upload_sessions_state ON upload_sessions(state,expires_at);
