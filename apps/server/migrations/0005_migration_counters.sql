ALTER TABLE storage_migrations ADD COLUMN total_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storage_migrations ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storage_migrations ADD COLUMN failed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storage_migrations ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storage_migrations ADD COLUMN canceled_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storage_migrations ADD COLUMN estimated_bytes INTEGER NOT NULL DEFAULT 0;
UPDATE storage_migrations SET
 total_count=(SELECT COUNT(*) FROM migration_items WHERE task_id=storage_migrations.id),
 success_count=(SELECT COUNT(*) FROM migration_items WHERE task_id=storage_migrations.id AND state='committed'),
 failed_count=(SELECT COUNT(*) FROM migration_items WHERE task_id=storage_migrations.id AND state='failed'),
 skipped_count=(SELECT COUNT(*) FROM migration_items WHERE task_id=storage_migrations.id AND state='skipped'),
 canceled_count=(SELECT COUNT(*) FROM migration_items WHERE task_id=storage_migrations.id AND state='canceled'),
 estimated_bytes=(SELECT COALESCE(SUM(estimated_bytes),0) FROM migration_items WHERE task_id=storage_migrations.id);
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
