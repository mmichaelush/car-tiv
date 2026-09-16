-- A bounded state row: repeated writes while dirty do not write it again.
INSERT INTO catalog_counters (key, value) VALUES ('maintenance.catalogDirty', 1);
INSERT INTO catalog_counters (key, value) VALUES ('maintenance.cronSlot', 0);

CREATE TRIGGER catalog_dirty_video_insert AFTER INSERT ON videos BEGIN
  UPDATE catalog_counters SET value = 1 WHERE key = 'maintenance.catalogDirty' AND value = 0;
END;
CREATE TRIGGER catalog_dirty_video_delete AFTER DELETE ON videos BEGIN
  UPDATE catalog_counters SET value = 1 WHERE key = 'maintenance.catalogDirty' AND value = 0;
END;
CREATE TRIGGER catalog_dirty_video_update
AFTER UPDATE OF status, deleted_at, category_id, channel_id, added_at ON videos
WHEN OLD.status IS NOT NEW.status OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.category_id IS NOT NEW.category_id OR OLD.channel_id IS NOT NEW.channel_id
  OR OLD.added_at IS NOT NEW.added_at BEGIN
  UPDATE catalog_counters SET value = 1 WHERE key = 'maintenance.catalogDirty' AND value = 0;
END;
CREATE TRIGGER catalog_dirty_tag_link_insert AFTER INSERT ON video_tags BEGIN
  UPDATE catalog_counters SET value = 1 WHERE key = 'maintenance.catalogDirty' AND value = 0;
END;
CREATE TRIGGER catalog_dirty_tag_link_delete AFTER DELETE ON video_tags BEGIN
  UPDATE catalog_counters SET value = 1 WHERE key = 'maintenance.catalogDirty' AND value = 0;
END;
CREATE TRIGGER catalog_dirty_tag_link_update AFTER UPDATE ON video_tags BEGIN
  UPDATE catalog_counters SET value = 1 WHERE key = 'maintenance.catalogDirty' AND value = 0;
END;
CREATE TRIGGER catalog_dirty_tag_insert AFTER INSERT ON tags BEGIN
  UPDATE catalog_counters SET value = 1 WHERE key = 'maintenance.catalogDirty' AND value = 0;
END;
CREATE TRIGGER catalog_dirty_tag_delete AFTER DELETE ON tags BEGIN
  UPDATE catalog_counters SET value = 1 WHERE key = 'maintenance.catalogDirty' AND value = 0;
END;
CREATE TRIGGER catalog_dirty_tag_visibility AFTER UPDATE OF is_visible ON tags
WHEN OLD.is_visible IS NOT NEW.is_visible BEGIN
  UPDATE catalog_counters SET value = 1 WHERE key = 'maintenance.catalogDirty' AND value = 0;
END;
CREATE TRIGGER catalog_dirty_channel_insert AFTER INSERT ON channels BEGIN
  UPDATE catalog_counters SET value = 1 WHERE key = 'maintenance.catalogDirty' AND value = 0;
END;
CREATE TRIGGER catalog_dirty_channel_delete AFTER DELETE ON channels BEGIN
  UPDATE catalog_counters SET value = 1 WHERE key = 'maintenance.catalogDirty' AND value = 0;
END;
CREATE TRIGGER catalog_dirty_channel_visibility AFTER UPDATE OF is_visible ON channels
WHEN OLD.is_visible IS NOT NEW.is_visible BEGIN
  UPDATE catalog_counters SET value = 1 WHERE key = 'maintenance.catalogDirty' AND value = 0;
END;
CREATE TRIGGER catalog_dirty_category_insert AFTER INSERT ON categories BEGIN
  UPDATE catalog_counters SET value = 1 WHERE key = 'maintenance.catalogDirty' AND value = 0;
END;
CREATE TRIGGER catalog_dirty_category_delete AFTER DELETE ON categories BEGIN
  UPDATE catalog_counters SET value = 1 WHERE key = 'maintenance.catalogDirty' AND value = 0;
END;
CREATE TRIGGER catalog_dirty_category_visibility AFTER UPDATE OF is_visible ON categories
WHEN OLD.is_visible IS NOT NEW.is_visible BEGIN
  UPDATE catalog_counters SET value = 1 WHERE key = 'maintenance.catalogDirty' AND value = 0;
END;
