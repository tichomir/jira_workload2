-- Migration 007: restore job tracking tables
-- Supports RestoreJobStore, RestoreWorker, and restore job API.

CREATE TABLE IF NOT EXISTS restore_jobs (
  id                         TEXT    NOT NULL PRIMARY KEY,
  source_backup_point_id     TEXT    NOT NULL,
  scope                      TEXT    NOT NULL,   -- JSON: RestoreScope
  destination                TEXT    NOT NULL,   -- JSON: RestoreDestination
  conflict_mode              TEXT    NOT NULL DEFAULT 'skip',
                                                 -- 'override' | 'skip' | 'ask'
  status                     TEXT    NOT NULL DEFAULT 'pending',
                                                 -- 'pending' | 'running' | 'awaiting_decision' | 'completed' | 'completed_with_errors' | 'failed'
  current_phase              TEXT,              -- RestorePhase or NULL
  phase_progress             TEXT    NOT NULL DEFAULT '[]', -- JSON: PhaseProgress[]
  error_count                INTEGER NOT NULL DEFAULT 0,
  failure_diagnostic         TEXT,
  adf_media_warning_emitted  INTEGER NOT NULL DEFAULT 0,  -- 0=false, 1=true
  adf_media_warnings         TEXT    NOT NULL DEFAULT '[]', -- JSON: string[] of affected issue IDs
  trash_window_blocked       INTEGER NOT NULL DEFAULT 0,  -- 0=false, 1=true
  last_heartbeat_at          INTEGER,           -- Unix epoch ms; NULL until worker starts
  stalled                    INTEGER NOT NULL DEFAULT 0,  -- 0=false, 1=true
  created_at                 TEXT    NOT NULL,   -- ISO 8601
  completed_at               TEXT               -- ISO 8601 or NULL
);

CREATE TABLE IF NOT EXISTS restore_conflicts (
  id                       TEXT NOT NULL PRIMARY KEY,
  job_id                   TEXT NOT NULL,
  object_type              TEXT NOT NULL,
  object_key               TEXT NOT NULL,
  existing_object_summary  TEXT,
  incoming_object_summary  TEXT,
  decision                 TEXT,               -- NULL until decided: 'override' | 'skip'
  created_at               TEXT NOT NULL,      -- ISO 8601
  decided_at               TEXT               -- ISO 8601 or NULL
);

CREATE INDEX IF NOT EXISTS idx_restore_jobs_status      ON restore_jobs (status);
CREATE INDEX IF NOT EXISTS idx_restore_conflicts_job_id ON restore_conflicts (job_id);
