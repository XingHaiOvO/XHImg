ALTER TABLE images ADD COLUMN storage_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE images ADD COLUMN migration_lock TEXT;
CREATE TABLE storage_migrations (
 id TEXT PRIMARY KEY, target_id TEXT REFERENCES storage_backends(id) ON DELETE SET NULL,
 target_name TEXT NOT NULL, target_fingerprint TEXT NOT NULL, selection TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'draft', cleanup_state TEXT NOT NULL DEFAULT 'retained',
 error TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE migration_items (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES storage_migrations(id) ON DELETE CASCADE,
 image_id TEXT NOT NULL, name TEXT NOT NULL,
 source_id TEXT REFERENCES storage_backends(id) ON DELETE SET NULL, source_name TEXT NOT NULL,
 snapshot TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft', phase TEXT NOT NULL DEFAULT 'waiting',
 estimated_bytes INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 next_run INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL,
 UNIQUE(task_id,image_id)
);
CREATE INDEX migration_items_task ON migration_items(task_id,state,created_at,id);
CREATE INDEX migration_items_queue ON migration_items(state,next_run,created_at);
CREATE UNIQUE INDEX migration_image_reservation ON migration_items(image_id) WHERE state IN ('pending','copying','paused');
CREATE TABLE migration_objects (
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES migration_items(id) ON DELETE CASCADE,
 source_id TEXT REFERENCES storage_backends(id) ON DELETE SET NULL, source_key TEXT NOT NULL,
 target_id TEXT REFERENCES storage_backends(id) ON DELETE SET NULL, target_key TEXT NOT NULL,
 roles TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER, checksum TEXT,
 state TEXT NOT NULL DEFAULT 'planned', source_state TEXT NOT NULL DEFAULT 'untouched',
 attempts INTEGER NOT NULL DEFAULT 0, next_run INTEGER NOT NULL DEFAULT 0, error TEXT,
 UNIQUE(item_id,source_key)
);
CREATE INDEX migration_source_objects ON migration_objects(source_id,source_state);
CREATE INDEX migration_target_objects ON migration_objects(target_id,state);
