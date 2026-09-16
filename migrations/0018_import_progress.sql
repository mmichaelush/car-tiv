-- Reserve a file's budget before execution; failed files remain resumable.
ALTER TABLE catalog_import_log ADD COLUMN completed INTEGER NOT NULL DEFAULT 1
  CHECK (completed IN (0, 1));
