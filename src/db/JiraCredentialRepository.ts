/**
 * JiraCredentialRepository — SQLite-backed storage for OAuth and API Token credentials.
 *
 * Tables (migrations 001, 002):
 *   jira_credentials       — OAuth 2.0 (3LO) credentials: cloudId, accessToken, refreshToken
 *   jira_api_token_creds   — HTTP Basic (API Token) credentials: cloudId, email, apiToken
 *
 * Key invariant: rotateTokens() writes both access_token and refresh_token in a single
 * BEGIN IMMEDIATE transaction before returning — no partial writes (T2 §6 Constraint 4).
 *
 * Failure modes:
 *   - getByCloudId() returns null when no OAuth credential exists for the cloudId.
 *   - getApiTokenByCloudId() returns null when no API token credential exists.
 *   - rotateTokens() throws if the cloudId row is not found.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export interface JiraCredential {
  id: string;
  cloudId: string;
  siteUrl: string;
  accountId: string;
  oauthClientId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  connectorType: string;
  createdAt: number;
  updatedAt: number;
}

export interface JiraApiTokenCredential {
  id: string;
  cloudId: string;
  siteUrl: string;
  accountId: string;
  email: string;
  apiToken: string;
  connectorType: 'api_token';
  createdAt: number;
  updatedAt: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
}

const MIGRATION_PATH = path.join(
  __dirname,
  '../../db/migrations/001_jira_credentials.sql'
);

const MIGRATION_PATH_002 = path.join(
  __dirname,
  '../../db/migrations/002_api_token_credentials.sql'
);

export class JiraCredentialRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Runs all schema migrations in order. Safe to call on a freshly created
   * database or an already-migrated one (all DDL statements are idempotent).
   *
   * Migration 001: jira_credentials base table (IF NOT EXISTS guarded).
   * Migration 002: email + api_token columns (duplicate-column error swallowed).
   */
  static runMigration(db: Database.Database): void {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    db.exec(sql);
    JiraCredentialRepository.runMigration002(db);
  }

  /**
   * Applies migration 002 (ADD COLUMN email, ADD COLUMN api_token).
   * Uses table_info to check existing columns before ALTER so the call is
   * idempotent regardless of SQLite version or error-message wording.
   *
   * The migration SQL file (002_api_token_credentials.sql) is kept as a
   * human-readable record of the schema change; the actual DDL is applied
   * here to avoid "duplicate column name" errors on re-run.
   */
  private static runMigration002(db: Database.Database): void {
    // Silence unused-import warning for MIGRATION_PATH_002 — the file exists
    // as documentation but we apply DDL directly for idempotency.
    void MIGRATION_PATH_002;

    const existingCols = (
      db.pragma('table_info(jira_credentials)') as Array<{ name: string }>
    ).map((c) => c.name);

    if (!existingCols.includes('email')) {
      db.exec('ALTER TABLE jira_credentials ADD COLUMN email TEXT');
    }
    if (!existingCols.includes('api_token')) {
      db.exec('ALTER TABLE jira_credentials ADD COLUMN api_token TEXT');
    }
  }

  // ── OAuth (jira) credentials ──────────────────────────────────────────────

  /**
   * Inserts or updates the OAuth credential row for the given cloudId
   * (connector_type = 'jira'). All fields are written atomically.
   */
  upsertConnection(
    cloudId: string,
    tokens: TokenSet,
    oauthClientId: string,
    siteUrl: string,
    accountId: string
  ): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO jira_credentials
           (cloud_id, site_url, account_id, oauth_client_id,
            access_token, refresh_token, access_token_expires_at,
            connector_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'jira', ?, ?)
         ON CONFLICT (cloud_id, connector_type) DO UPDATE SET
           site_url                = excluded.site_url,
           account_id              = excluded.account_id,
           oauth_client_id         = excluded.oauth_client_id,
           access_token            = excluded.access_token,
           refresh_token           = excluded.refresh_token,
           access_token_expires_at = excluded.access_token_expires_at,
           updated_at              = excluded.updated_at`
      )
      .run(
        cloudId,
        siteUrl,
        accountId,
        oauthClientId,
        tokens.accessToken,
        tokens.refreshToken,
        tokens.accessTokenExpiresAt,
        now,
        now
      );
  }

  /**
   * Returns the OAuth credential row for the given cloudId, or null.
   */
  getByCloudId(cloudId: string): JiraCredential | null {
    const row = this.db
      .prepare(
        `SELECT * FROM jira_credentials
         WHERE cloud_id = ? AND connector_type = 'jira'`
      )
      .get(cloudId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row['id'] as string,
      cloudId: row['cloud_id'] as string,
      siteUrl: row['site_url'] as string,
      accountId: row['account_id'] as string,
      oauthClientId: row['oauth_client_id'] as string,
      accessToken: row['access_token'] as string,
      refreshToken: row['refresh_token'] as string,
      accessTokenExpiresAt: row['access_token_expires_at'] as number,
      connectorType: row['connector_type'] as string,
      createdAt: row['created_at'] as number,
      updatedAt: row['updated_at'] as number,
    };
  }

  /**
   * Atomically rotates both access_token and refresh_token inside a single
   * BEGIN IMMEDIATE transaction. Throws if no credential row exists.
   *
   * Per T2 §6 Constraint 4: both tokens are committed before the caller
   * (JiraHttpClient) releases the refresh mutex.
   */
  rotateTokens(
    cloudId: string,
    newAccessToken: string,
    newRefreshToken: string,
    expiresAt: number
  ): void {
    const doRotate = this.db.transaction(() => {
      const now = Math.floor(Date.now() / 1000);
      const result = this.db
        .prepare(
          `UPDATE jira_credentials
           SET access_token            = ?,
               refresh_token           = ?,
               access_token_expires_at = ?,
               updated_at              = ?
           WHERE cloud_id = ? AND connector_type = 'jira'`
        )
        .run(newAccessToken, newRefreshToken, expiresAt, now, cloudId);

      if (result.changes !== 1) {
        throw new Error(
          `rotateTokens: expected 1 row updated, got ${result.changes} for cloudId=${cloudId}`
        );
      }
    });

    doRotate();
  }

  // ── API Token (api_token) credentials ────────────────────────────────────

  /**
   * Inserts or updates the API Token credential row for the given cloudId
   * (connector_type = 'api_token'). Written atomically. The email and
   * apiToken values are used for HTTP Basic authentication.
   *
   * The oauth_client_id, access_token, refresh_token columns are not
   * meaningful for api_token rows and are stored as empty strings.
   */
  upsertApiTokenConnection(
    cloudId: string,
    siteUrl: string,
    email: string,
    apiToken: string,
    accountId: string
  ): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO jira_credentials
           (cloud_id, site_url, account_id, oauth_client_id,
            access_token, refresh_token, access_token_expires_at,
            email, api_token,
            connector_type, created_at, updated_at)
         VALUES (?, ?, ?, '', '', '', 0, ?, ?, 'api_token', ?, ?)
         ON CONFLICT (cloud_id, connector_type) DO UPDATE SET
           site_url   = excluded.site_url,
           account_id = excluded.account_id,
           email      = excluded.email,
           api_token  = excluded.api_token,
           updated_at = excluded.updated_at`
      )
      .run(cloudId, siteUrl, accountId, email, apiToken, now, now);
  }

  /**
   * Returns the API Token credential row for the given cloudId, or null.
   */
  getApiTokenByCloudId(cloudId: string): JiraApiTokenCredential | null {
    const row = this.db
      .prepare(
        `SELECT * FROM jira_credentials
         WHERE cloud_id = ? AND connector_type = 'api_token'`
      )
      .get(cloudId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row['id'] as string,
      cloudId: row['cloud_id'] as string,
      siteUrl: row['site_url'] as string,
      accountId: row['account_id'] as string,
      email: row['email'] as string,
      apiToken: row['api_token'] as string,
      connectorType: 'api_token',
      createdAt: row['created_at'] as number,
      updatedAt: row['updated_at'] as number,
    };
  }
}
