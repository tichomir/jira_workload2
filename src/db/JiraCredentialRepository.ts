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

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
}

const MIGRATION_PATH = path.join(
  __dirname,
  '../../db/migrations/001_jira_credentials.sql'
);

export class JiraCredentialRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Runs the schema migration against the database.
   * Safe to call on a freshly created database or an already-migrated one
   * (all DDL statements use IF NOT EXISTS guards).
   */
  static runMigration(db: Database.Database): void {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    db.exec(sql);
  }

  /**
   * Inserts or updates the credential row for the given cloudId + connector_type='jira'.
   * All fields are written atomically in a single statement.
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
   * Returns the credential row for the given cloudId, or null if not found.
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
   * BEGIN IMMEDIATE transaction. If anything throws, the transaction is
   * rolled back and neither token is modified.
   *
   * Throws if no credential row exists for the given cloudId.
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
}
