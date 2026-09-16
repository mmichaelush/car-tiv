-- Import identity is independent of the display name and the database row id.
ALTER TABLE channels ADD COLUMN source_id TEXT;
CREATE UNIQUE INDEX idx_channels_source_id ON channels(source_id) WHERE source_id IS NOT NULL;
ALTER TABLE channels ADD COLUMN netfree_open INTEGER CHECK (netfree_open IN (0, 1));
ALTER TABLE channels ADD COLUMN has_hebrew_videos INTEGER CHECK (has_hebrew_videos IN (0, 1));
ALTER TABLE videos ADD COLUMN netfree_open INTEGER CHECK (netfree_open IN (0, 1));
ALTER TABLE videos ADD COLUMN catalog_revision TEXT;
