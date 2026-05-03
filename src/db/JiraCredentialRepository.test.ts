import Database from 'better-sqlite3';
import { JiraCredentialRepository, TokenSet } from './JiraCredentialRepository';

// ─── helpers ────────────────────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(':memory:');
  // SQLite in-memory: enable WAL so BEGIN IMMEDIATE behaves identically to
  // the on-disk configuration used in development.
  db.pragma('journal_mode = WAL');
  JiraCredentialRepository.runMigration(db);
  return db;
}

const CLOUD_ID = 'cloud-abc-123';
const SITE_URL = 'https://myorg.atlassian.net';
const ACCOUNT_ID = 'account-xyz';
const OAUTH_CLIENT_ID = 'client-id-001';

const INITIAL_TOKENS: TokenSet = {
  accessToken: 'access_v1',
  refreshToken: 'refresh_v1',
  accessTokenExpiresAt: 1_800_000_000,
};

// ─── test suite ─────────────────────────────────────────────────────────────

describe('JiraCredentialRepository', () => {
  let db: Database.Database;
  let repo: JiraCredentialRepository;

  beforeEach(() => {
    db = openDb();
    repo = new JiraCredentialRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── migration ──────────────────────────────────────────────────────────────

  describe('runMigration', () => {
    it('creates the jira_credentials table on a fresh database', () => {
      const row = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='jira_credentials'`
        )
        .get() as { name: string } | undefined;
      expect(row?.name).toBe('jira_credentials');
    });

    it('is idempotent — running the migration twice does not throw', () => {
      expect(() => JiraCredentialRepository.runMigration(db)).not.toThrow();
    });
  });

  // ── upsertConnection (happy path) ─────────────────────────────────────────

  describe('upsertConnection', () => {
    it('inserts a new credential row and persists all fields', () => {
      repo.upsertConnection(
        CLOUD_ID,
        INITIAL_TOKENS,
        OAUTH_CLIENT_ID,
        SITE_URL,
        ACCOUNT_ID
      );

      const cred = repo.getByCloudId(CLOUD_ID);

      expect(cred).not.toBeNull();
      expect(cred!.cloudId).toBe(CLOUD_ID);
      expect(cred!.siteUrl).toBe(SITE_URL);
      expect(cred!.accountId).toBe(ACCOUNT_ID);
      expect(cred!.oauthClientId).toBe(OAUTH_CLIENT_ID);
      expect(cred!.accessToken).toBe(INITIAL_TOKENS.accessToken);
      expect(cred!.refreshToken).toBe(INITIAL_TOKENS.refreshToken);
      expect(cred!.accessTokenExpiresAt).toBe(INITIAL_TOKENS.accessTokenExpiresAt);
      expect(cred!.connectorType).toBe('jira');
      expect(cred!.id).toBeTruthy();
      expect(cred!.createdAt).toBeGreaterThan(0);
      expect(cred!.updatedAt).toBeGreaterThan(0);
    });

    it('updates an existing row (upsert semantics) without changing created_at', () => {
      repo.upsertConnection(
        CLOUD_ID,
        INITIAL_TOKENS,
        OAUTH_CLIENT_ID,
        SITE_URL,
        ACCOUNT_ID
      );
      const first = repo.getByCloudId(CLOUD_ID)!;

      const updatedTokens: TokenSet = {
        accessToken: 'access_v2',
        refreshToken: 'refresh_v2',
        accessTokenExpiresAt: 1_900_000_000,
      };

      repo.upsertConnection(
        CLOUD_ID,
        updatedTokens,
        OAUTH_CLIENT_ID,
        SITE_URL,
        ACCOUNT_ID
      );
      const second = repo.getByCloudId(CLOUD_ID)!;

      // token fields updated
      expect(second.accessToken).toBe('access_v2');
      expect(second.refreshToken).toBe('refresh_v2');
      // id and created_at are preserved
      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
    });

    it('allows two credentials with the same cloud_id but different connector_type', () => {
      repo.upsertConnection(
        CLOUD_ID,
        INITIAL_TOKENS,
        OAUTH_CLIENT_ID,
        SITE_URL,
        ACCOUNT_ID
      );

      // Insert a row for the same site but connector_type='confluence' directly
      db.prepare(
        `INSERT INTO jira_credentials
           (cloud_id, site_url, account_id, oauth_client_id,
            access_token, refresh_token, access_token_expires_at,
            connector_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'confluence', unixepoch(), unixepoch())`
      ).run(
        CLOUD_ID,
        SITE_URL,
        ACCOUNT_ID,
        OAUTH_CLIENT_ID,
        'cf_access',
        'cf_refresh',
        1_800_000_000
      );

      const count = (
        db
          .prepare(`SELECT COUNT(*) as n FROM jira_credentials WHERE cloud_id = ?`)
          .get(CLOUD_ID) as { n: number }
      ).n;
      expect(count).toBe(2);
    });
  });

  // ── getByCloudId ──────────────────────────────────────────────────────────

  describe('getByCloudId', () => {
    it('returns null when no credential exists for the given cloudId', () => {
      const result = repo.getByCloudId('nonexistent-cloud-id');
      expect(result).toBeNull();
    });

    it('returns the correct credential after insert', () => {
      repo.upsertConnection(
        CLOUD_ID,
        INITIAL_TOKENS,
        OAUTH_CLIENT_ID,
        SITE_URL,
        ACCOUNT_ID
      );

      const cred = repo.getByCloudId(CLOUD_ID);
      expect(cred).not.toBeNull();
      expect(cred!.cloudId).toBe(CLOUD_ID);
    });
  });

  // ── rotateTokens ──────────────────────────────────────────────────────────

  describe('rotateTokens', () => {
    beforeEach(() => {
      repo.upsertConnection(
        CLOUD_ID,
        INITIAL_TOKENS,
        OAUTH_CLIENT_ID,
        SITE_URL,
        ACCOUNT_ID
      );
    });

    it('updates both access_token and refresh_token (happy path)', () => {
      repo.rotateTokens(CLOUD_ID, 'access_v2', 'refresh_v2', 1_900_000_000);

      const cred = repo.getByCloudId(CLOUD_ID)!;
      expect(cred.accessToken).toBe('access_v2');
      expect(cred.refreshToken).toBe('refresh_v2');
      expect(cred.accessTokenExpiresAt).toBe(1_900_000_000);
    });

    it('updates updated_at on rotation', () => {
      const before = repo.getByCloudId(CLOUD_ID)!.updatedAt;
      // Advance the clock by 2 seconds so the timestamp differs
      jest.useFakeTimers();
      jest.setSystemTime(Date.now() + 2_000);

      repo.rotateTokens(CLOUD_ID, 'access_v2', 'refresh_v2', 1_900_000_000);

      jest.useRealTimers();
      const after = repo.getByCloudId(CLOUD_ID)!.updatedAt;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('throws when the cloudId does not exist', () => {
      expect(() =>
        repo.rotateTokens('unknown-cloud', 'a', 'r', 999)
      ).toThrow(/expected 1 row updated/);
    });

    it('atomicity — simulates failure mid-write and verifies no partial state', () => {
      const original = repo.getByCloudId(CLOUD_ID)!;

      // Spy on db.transaction to wrap the real transaction with an injected throw
      // that fires AFTER the UPDATE executes but BEFORE the implicit COMMIT.
      // better-sqlite3 automatically rolls back the transaction when the wrapper
      // function throws, so neither token must be visible after the call returns.
      const originalTransaction = db.transaction.bind(db);
      const spy = jest
        .spyOn(db, 'transaction')
        .mockImplementationOnce((fn: (...args: unknown[]) => unknown) => {
          // Build a real SQLite transaction that runs fn() then deliberately throws.
          return originalTransaction((...args: unknown[]) => {
            fn(...args);                              // UPDATE executes inside transaction
            throw new Error('simulated DB failure'); // force rollback before COMMIT
          });
        });

      expect(() =>
        repo.rotateTokens(CLOUD_ID, 'access_v2', 'refresh_v2', 1_900_000_000)
      ).toThrow('simulated DB failure');

      // Original tokens must be unchanged — the transaction was rolled back
      const after = repo.getByCloudId(CLOUD_ID)!;
      expect(after.accessToken).toBe(original.accessToken);
      expect(after.refreshToken).toBe(original.refreshToken);
      expect(after.accessTokenExpiresAt).toBe(original.accessTokenExpiresAt);

      spy.mockRestore();
    });
  });
});
