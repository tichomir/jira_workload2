-- Migration 006: job tracking tables
-- Supports HeartbeatEmitter, StalledJobDetector, and job progress API.

CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT    NOT NULL PRIMARY KEY,
  backup_point_id   TEXT    NOT NULL,
  phase             TEXT    NOT NULL,          -- 'issues' | 'attachments' | 'context'
  status            TEXT    NOT NULL DEFAULT 'running',
                                               -- 'running' | 'stalled' | 'completed' | 'completed_with_errors' | 'failed'
  display_status    TEXT,
  items_processed   INTEGER NOT NULL DEFAULT 0,
  items_failed      INTEGER NOT NULL DEFAULT 0,
  items_total       INTEGER,                   -- NULL until known
  last_heartbeat_at INTEGER NOT NULL,          -- Unix epoch ms
  stalled           INTEGER NOT NULL DEFAULT 0, -- 0=false, 1=true
  created_at        INTEGER NOT NULL,
  completed_at      INTEGER                    -- NULL while active
);

CREATE TABLE IF NOT EXISTS job_events (
  id               TEXT    NOT NULL PRIMARY KEY,
  job_id           TEXT    NOT NULL,
  event_type       TEXT    NOT NULL,           -- 'heartbeat' | 'stalled' | 'terminal'
  phase            TEXT    NOT NULL,
  items_processed  INTEGER NOT NULL DEFAULT 0,
  items_failed     INTEGER NOT NULL DEFAULT 0,
  items_total      INTEGER,
  current_item_key TEXT,
  backup_point_id  TEXT    NOT NULL,
  timestamp        TEXT    NOT NULL            -- ISO 8601
);

CREATE TABLE IF NOT EXISTS job_errors (
  id              TEXT NOT NULL PRIMARY KEY,
  job_id          TEXT NOT NULL,
  backup_point_id TEXT NOT NULL,
  item_type       TEXT NOT NULL,
  item_id         TEXT NOT NULL,
  error_code      TEXT,
  error_message   TEXT,
  timestamp       TEXT NOT NULL               -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_jobs_status         ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_job_events_job_id   ON job_events (job_id);
CREATE INDEX IF NOT EXISTS idx_job_errors_job_id   ON job_errors (job_id);
