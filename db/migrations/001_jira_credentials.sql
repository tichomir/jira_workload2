-- Migration: 001_jira_credentials
-- Description: Creates the jira_credentials table for OAuth 2.0 (3LO) credential storage.
-- Idempotent: safe to run multiple times (IF NOT EXISTS guards).
-- Supports: SQLite (primary) and Postgres (see inline comments for dialect differences).
--
-- Atomic write semantics: access_token and refresh_token are ALWAYS updated together
-- in a single transaction (BEGIN IMMEDIATE on SQLite; BEGIN on Postgres).
-- See docs/architecture/jira-oauth.md §3 for the rotation procedure.

-- ─────────────────────────────────────────────
-- SQLite dialect (default)
-- For Postgres: replace DEFAULT (lower(hex(randomblob(16)))) with gen_random_uuid()::text
--               replace DEFAULT (unixepoch()) with EXTRACT(EPOCH FROM NOW())::bigint
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jira_credentials (
  -- Surrogate primary key — opaque identifier for this credential row
  id                      TEXT    NOT NULL PRIMARY KEY
                                  DEFAULT (lower(hex(randomblob(16)))),

  -- Atlassian site cloud ID (from /oauth/token/accessible-resources)
  cloud_id                TEXT    NOT NULL,

  -- Public-facing URL of the Jira Cloud site (e.g. https://myorg.atlassian.net)
  site_url                TEXT    NOT NULL,

  -- Atlassian accountId of the authorizing user (from GET /me)
  account_id              TEXT    NOT NULL,

  -- OAuth application client ID used to obtain these tokens
  oauth_client_id         TEXT    NOT NULL,

  -- Current access token (Bearer). Rotated on every refresh.
  access_token            TEXT    NOT NULL,

  -- Rotating refresh token. MUST be updated atomically with access_token.
  refresh_token           TEXT    NOT NULL,

  -- Expiry of the current access_token as Unix epoch seconds (UTC).
  -- Set to: (token_issue_time + expires_in - 30) for a 30-second safety buffer.
  access_token_expires_at INTEGER NOT NULL,

  -- Discriminator for multi-connector deployments (jira | confluence | …)
  connector_type          TEXT    NOT NULL DEFAULT 'jira',

  -- Audit timestamps (Unix epoch seconds, UTC)
  created_at              INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at              INTEGER NOT NULL DEFAULT (unixepoch()),

  -- A single Atlassian site may have at most one active credential per connector type
  CONSTRAINT uq_jira_credentials_cloud_connector
    UNIQUE (cloud_id, connector_type)
);

-- Fast lookup by cloud_id (used on every authenticated request)
CREATE INDEX IF NOT EXISTS idx_jira_credentials_cloud_id
  ON jira_credentials (cloud_id);

-- ─────────────────────────────────────────────
-- Token rotation procedure (reference — execute as a transaction in application code)
--
-- BEGIN IMMEDIATE;  -- SQLite: acquires write lock upfront, serialises concurrent rotations
--                   -- Postgres: plain BEGIN; (row-level locking handles concurrency)
--
-- UPDATE jira_credentials
-- SET
--   access_token             = :newAccessToken,
--   refresh_token            = :newRefreshToken,
--   access_token_expires_at  = :newExpiresAt,
--   updated_at               = unixepoch()         -- Postgres: EXTRACT(EPOCH FROM NOW())::bigint
-- WHERE cloud_id       = :cloudId
--   AND connector_type = :connectorType;
--
-- -- Application MUST check that exactly 1 row was affected; ROLLBACK if not.
--
-- COMMIT;
-- ─────────────────────────────────────────────
