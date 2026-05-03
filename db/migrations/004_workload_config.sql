-- Migration 004: workload_config table
-- Stores per-site workload configuration (project scope selection).
-- Written during Sprint 3 onboarding wizard implementation.

CREATE TABLE IF NOT EXISTS workload_config (
  cloud_id       TEXT    NOT NULL PRIMARY KEY,
  scope          TEXT    NOT NULL DEFAULT 'all',  -- 'all' | 'selected'
  selected_keys  TEXT,                            -- JSON array of project keys; NULL when scope='all'
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
