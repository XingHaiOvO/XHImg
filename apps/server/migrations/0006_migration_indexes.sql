CREATE INDEX migration_items_pages ON migration_items(task_id,created_at,id);
CREATE INDEX migration_items_image ON migration_items(image_id);
CREATE INDEX migration_source_cleanup ON migration_objects(source_state,next_run,item_id);
CREATE INDEX migration_target_cleanup ON migration_objects(state,next_run);
CREATE INDEX migration_object_target_key ON migration_objects(target_id,target_key);
CREATE INDEX migration_object_source_key ON migration_objects(source_id,source_key,source_state);
