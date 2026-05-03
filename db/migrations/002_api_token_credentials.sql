-- Migration: 002_api_token_credentials
-- Description: Extends jira_credentials to support HTTP Basic (API Token) credential rows.
--
-- Adds two nullable columns:
--   email      — the Atlassian account email used for HTTP Basic authentication
--   api_token  — the Atlassian API token (never an OAuth access token)
--
-- These columns are NULL for existing OAuth ('jira') rows and are populated
-- for 'api_token' connector_type rows. The UNIQUE constraint on
-- (cloud_id, connector_type) allows one OAuth row and one api_token row
-- per Jira site to coexist.
--
-- Idempotency: SQLite does not support ADD COLUMN IF NOT EXISTS. The
-- application layer (JiraCredentialRepository.runMigration) handles
-- "duplicate column name" errors silently to make this migration idempotent.
--
-- For Postgres: the same statements work as-is (ADD COLUMN for nullable columns
-- does not require additional syntax changes).

ALTER TABLE jira_credentials ADD COLUMN email TEXT;
ALTER TABLE jira_credentials ADD COLUMN api_token TEXT;
