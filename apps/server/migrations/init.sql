-- SQLite schema at the end of migration 0009. Run on an empty database in a transaction.

CREATE TABLE migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE administrators (
  id TEXT PRIMARY KEY CHECK(id='admin'),
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE storage_backends (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('local','s3')),
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX one_default_storage ON storage_backends(is_default) WHERE is_default=1;

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('public','private')),
  effective_visibility TEXT NOT NULL DEFAULT 'private',
  storage_id TEXT REFERENCES storage_backends(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  processing_policy TEXT,
  ai_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX folder_parent ON folders(parent_id,sort_order);

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE RESTRICT,
  storage_id TEXT NOT NULL REFERENCES storage_backends(id),
  object_key TEXT NOT NULL,
  thumb_key TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  effective_visibility TEXT NOT NULL DEFAULT 'private',
  access_version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'ready',
  thumbnail_state TEXT NOT NULL DEFAULT 'pending',
  tags TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  source_key TEXT,
  source_size INTEGER NOT NULL DEFAULT 0,
  source_format TEXT,
  source_checksum TEXT,
  processing_status TEXT NOT NULL DEFAULT 'skipped',
  classification_status TEXT NOT NULL DEFAULT 'skipped',
  content_version INTEGER NOT NULL DEFAULT 1,
  organization_version INTEGER NOT NULL DEFAULT 1,
  publication_hold INTEGER NOT NULL DEFAULT 0,
  processing_info TEXT NOT NULL DEFAULT '{}',
  storage_version INTEGER NOT NULL DEFAULT 1,
  migration_lock TEXT
);

CREATE INDEX image_candidates ON images(effective_visibility,state,deleted_at,folder_id,id);

CREATE INDEX image_folder ON images(folder_id,created_at,id);

CREATE INDEX image_deleted ON images(deleted_at);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  permissions TEXT NOT NULL,
  expires INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER,
  rate_limit INTEGER NOT NULL DEFAULT 120,
  created_at INTEGER NOT NULL
);

CREATE TABLE api_grants (
  id INTEGER PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  resource_id TEXT NOT NULL DEFAULT '',
  descendants INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX grant_key ON api_grants(key_id);

CREATE TABLE random_endpoints (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private',
  enabled INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'image',
  include_children INTEGER NOT NULL DEFAULT 0,
  rate_limit INTEGER NOT NULL DEFAULT 60,
  calls INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  last_called INTEGER,
  slug TEXT,
  media_type TEXT NOT NULL DEFAULT 'image' CHECK (media_type IN ('image','video','mixed'))
);

CREATE UNIQUE INDEX one_folder_endpoint ON random_endpoints(folder_id) WHERE kind='folder';

CREATE TABLE random_rules (
  id INTEGER PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES random_endpoints(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  descendants INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX rule_endpoint ON random_rules(endpoint_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  image_id TEXT REFERENCES images(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX jobs_pending ON jobs(state,next_run);

CREATE TABLE upload_operations (
  id TEXT PRIMARY KEY,
  storage_id TEXT NOT NULL REFERENCES storage_backends(id),
  object_key TEXT NOT NULL,
  thumb_key TEXT NOT NULL,
  temp_path TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE cleanup_objects (
  id TEXT PRIMARY KEY,
  storage_id TEXT NOT NULL REFERENCES storage_backends(id),
  object_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE UNIQUE INDEX one_image_job ON jobs(image_id,kind);

CREATE INDEX jobs_kind_pending ON jobs(kind,state,next_run,created_at);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  image_id TEXT NOT NULL UNIQUE,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  folder_id TEXT NOT NULL REFERENCES folders(id),
  storage_id TEXT NOT NULL REFERENCES storage_backends(id),
  name TEXT NOT NULL,
  visibility TEXT NOT NULL,
  length INTEGER NOT NULL,
  expected_hash TEXT,
  confirmed_offset INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'created',
  policy TEXT NOT NULL,
  classify INTEGER NOT NULL DEFAULT 0,
  explicit_folder INTEGER NOT NULL DEFAULT 0,
  explicit_storage INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  tus_metadata TEXT
);

CREATE INDEX upload_sessions_owner ON upload_sessions(actor_kind,actor_id,created_at);

CREATE INDEX upload_sessions_state ON upload_sessions(state,expires_at);

CREATE TABLE storage_migrations (
  id TEXT PRIMARY KEY,
  target_id TEXT REFERENCES storage_backends(id) ON DELETE SET NULL,
  target_name TEXT NOT NULL,
  target_fingerprint TEXT NOT NULL,
  selection TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  cleanup_state TEXT NOT NULL DEFAULT 'retained',
  error TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  canceled_count INTEGER NOT NULL DEFAULT 0,
  estimated_bytes INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE migration_items (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES storage_migrations(id) ON DELETE CASCADE,
  image_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_id TEXT REFERENCES storage_backends(id) ON DELETE SET NULL,
  source_name TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  phase TEXT NOT NULL DEFAULT 'waiting',
  estimated_bytes INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id,image_id)
);

CREATE INDEX migration_items_task ON migration_items(task_id,state,created_at,id);

CREATE INDEX migration_items_queue ON migration_items(state,next_run,created_at);

CREATE UNIQUE INDEX migration_image_reservation ON migration_items(image_id) WHERE state IN ('pending','copying','paused');

CREATE TABLE migration_objects (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES migration_items(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES storage_backends(id) ON DELETE SET NULL,
  source_key TEXT NOT NULL,
  target_id TEXT REFERENCES storage_backends(id) ON DELETE SET NULL,
  target_key TEXT NOT NULL,
  roles TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER,
  checksum TEXT,
  state TEXT NOT NULL DEFAULT 'planned',
  source_state TEXT NOT NULL DEFAULT 'untouched',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  UNIQUE(item_id,source_key)
);

CREATE INDEX migration_source_objects ON migration_objects(source_id,source_state);

CREATE INDEX migration_target_objects ON migration_objects(target_id,state);

CREATE TRIGGER migration_item_insert AFTER INSERT ON migration_items BEGIN
 UPDATE storage_migrations SET total_count=total_count+1,
 success_count=success_count+(NEW.state='committed'), failed_count=failed_count+(NEW.state='failed'),
 skipped_count=skipped_count+(NEW.state='skipped'), canceled_count=canceled_count+(NEW.state='canceled'),
 estimated_bytes=estimated_bytes+NEW.estimated_bytes WHERE id=NEW.task_id;
END;

CREATE TRIGGER migration_item_update AFTER UPDATE OF state ON migration_items BEGIN
 UPDATE storage_migrations SET success_count=success_count+(NEW.state='committed')-(OLD.state='committed'),
 failed_count=failed_count+(NEW.state='failed')-(OLD.state='failed'),
 skipped_count=skipped_count+(NEW.state='skipped')-(OLD.state='skipped'),
 canceled_count=canceled_count+(NEW.state='canceled')-(OLD.state='canceled') WHERE id=NEW.task_id;
END;

CREATE INDEX migration_items_pages ON migration_items(task_id,created_at,id);

CREATE INDEX migration_items_image ON migration_items(image_id);

CREATE INDEX migration_source_cleanup ON migration_objects(source_state,next_run,item_id);

CREATE INDEX migration_target_cleanup ON migration_objects(state,next_run);

CREATE INDEX migration_object_target_key ON migration_objects(target_id,target_key);

CREATE INDEX migration_object_source_key ON migration_objects(source_id,source_key,source_state);

CREATE UNIQUE INDEX random_endpoint_slug ON random_endpoints(slug) WHERE slug IS NOT NULL;

INSERT INTO migrations (name, applied_at) VALUES
  ('0001.sql', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('0002_p1.sql', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('0003_image_filenames.sql', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('0004_storage_migrations.sql', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('0005_migration_counters.sql', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('0006_migration_indexes.sql', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('0007_random_slug.sql', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('0008_random_media_type.sql', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('0009_mixed_random_default.sql', CAST(unixepoch('subsec') * 1000 AS INTEGER));
