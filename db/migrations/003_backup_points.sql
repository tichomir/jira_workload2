-- Migration 003: backup_points table
-- Stores the JSON manifest for each backup job.
-- Written per docs/architecture/context-capture-pipeline.md §Appendix.

CREATE TABLE IF NOT EXISTS backup_points (
  id            TEXT    NOT NULL PRIMARY KEY,
  cloud_id      TEXT    NOT NULL,
  site_url      TEXT    NOT NULL,
  started_at    INTEGER NOT NULL,  -- Unix epoch seconds
  finalised_at  INTEGER,           -- NULL while job is in progress
  status        TEXT    NOT NULL DEFAULT 'in_progress',
                                   -- 'in_progress' | 'completed' | 'completed_with_errors' | 'halted'
  manifest_json TEXT,              -- Full BackupPointManifest JSON; written at job completion/halt
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_backup_points_cloud_id ON backup_points (cloud_id);
CREATE INDEX IF NOT EXISTS idx_backup_points_started_at ON backup_points (started_at DESC);
