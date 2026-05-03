-- manifest_entries: individual capture entries persisted per-item.
-- One row per backed-up object (issue, attachment, etc.).
-- Provides getEntriesByBackupPoint() for the Inventory UI.

CREATE TABLE IF NOT EXISTS manifest_entries (
  id              TEXT    NOT NULL PRIMARY KEY,
  backup_point_id TEXT    NOT NULL,
  object_type     TEXT    NOT NULL,
  object_id       TEXT    NOT NULL,
  captured_at     INTEGER NOT NULL,   -- Unix epoch seconds
  source_endpoint TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK(status IN ('ok', 'error')),
  error_message   TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (backup_point_id) REFERENCES backup_points(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_manifest_entries_backup_point
  ON manifest_entries(backup_point_id);

CREATE INDEX IF NOT EXISTS idx_manifest_entries_type
  ON manifest_entries(backup_point_id, object_type);
