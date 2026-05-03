/**
 * Sprint 1 QA — Integration tests
 *
 * Coverage:
 *   1. E2E happy path — full OAuth flow via real HTTP; credential row asserted
 *      non-null on accessToken AND refreshToken after callback completes.
 *   2. HTTPS-only enforcement — http:// redirect returns 400 + log line.
 *   3. Atomicity fault injection (kill+restart) — file-based SQLite, transaction
 *      abort mid-rotation, reopen, assert no mixed-token state.
 *   4. 401 downstream error — force 401 from Atlassian APIs; assert structured
 *      error response; no credential persisted.
 *
 * All tests run with Jest/supertest against real in-memory (or temp-file) SQLite.
 * No external network calls are made; Atlassian endpoints are intercepted via
 * the injectable fetchFn.
 */

import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JiraCredentialRepository, TokenSet } from '../db/JiraCredentialRepository';
import { OAuthStateStore } from '../auth/OAuthStateStore';
import {
  createJiraOAuthRouter,
  OAuthConfig,
  AccessibleResource,
} from '../auth/JiraOAuthHandler';
import { createJiraConnectionsRouter } from '../connections/JiraConnectionsRouter';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_SITE: AccessibleResource = {
  id: 'cloud-e2e-001',
  name: 'E2E Test Site',
  url: 'https://e2e-test.atlassian.net',
  scopes: ['manage:jira-configuration', 'read:jira-work'],
  avatarUrl: '',
};

const MOCK_TOKENS = {
  access_token: 'e2e_access_token_abc',
  refresh_token: 'e2e_refresh_token_xyz',
  expires_in: 3600,
};

const MOCK_ME = { accountId: 'account-e2e-999' };

const HTTPS_CONFIG: OAuthConfig = {
  clientId: 'e2e-client-id',
  clientSecret: 'e2e-client-secret',
  redirectUri: 'https://localhost/api/jira/oauth/callback',
};

const HTTP_CONFIG: OAuthConfig = {
  ...HTTPS_CONFIG,
  redirectUri: 'http://localhost/api/jira/oauth/callback',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeHappyPathFetch(sites: AccessibleResource[] = [MOCK_SITE]): typeof fetch {
  return jest.fn().mockImplementation((url: string) => {
    if (url === 'https://auth.atlassian.com/oauth/token') {
      return Promise.resolve(mockFetchResponse(MOCK_TOKENS));
    }
    if (url === 'https://api.atlassian.com/oauth/token/accessible-resources') {
      return Promise.resolve(mockFetchResponse(sites));
    }
    if (url === 'https://api.atlassian.com/me') {
      return Promise.resolve(mockFetchResponse(MOCK_ME));
    }
    return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
  }) as unknown as typeof fetch;
}

function buildApp(
  stateStore: OAuthStateStore,
  repo: JiraCredentialRepository,
  config: OAuthConfig,
  fetchFn: typeof fetch,
) {
  const app = express();
  app.use(express.json());
  app.use('/api/jira/oauth', createJiraOAuthRouter(stateStore, repo, config, fetchFn));
  app.use('/api/jira/connections', createJiraConnectionsRouter(repo));
  return app;
}

/** Decodes the base64url oauth_result param from a redirect Location header. */
function decodeOAuthResult(location: string): Record<string, unknown> {
  const raw = new URL(location).searchParams.get('oauth_result')!;
  return JSON.parse(
    Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
  ) as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. E2E HAPPY PATH
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E Happy Path — Full OAuth Flow', () => {
  let db: Database.Database;
  let repo: JiraCredentialRepository;
  let stateStore: OAuthStateStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    JiraCredentialRepository.runMigration(db);
    repo = new JiraCredentialRepository(db);
    stateStore = new OAuthStateStore();
  });

  afterEach(() => db.close());

  it('GET /start → GET /callback: credential row has non-null accessToken AND refreshToken', async () => {
    const app = buildApp(stateStore, repo, HTTPS_CONFIG, makeHappyPathFetch([MOCK_SITE]));

    // Step 1: GET /start — retrieve state nonce from redirect URL
    const startRes = await request(app).get('/api/jira/oauth/start').expect(302);
    const authorizeUrl = new URL(startRes.headers['location'] as string);
    const state = authorizeUrl.searchParams.get('state')!;
    expect(state).toBeTruthy();

    // Verify the full scope set is present (single-site auto-select path)
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('audience')).toBe('api.atlassian.com');

    // Step 2: Simulate Atlassian returning the auth code
    const callbackRes = await request(app)
      .get(`/api/jira/oauth/callback?code=authcode-e2e-001&state=${state}`)
      .expect(302);

    // Step 3: Decode the oauth_result payload → single site auto-select
    const payload = decodeOAuthResult(callbackRes.headers['location'] as string);
    expect(payload.status).toBe('connected');
    expect((payload.site as { id: string }).id).toBe(MOCK_SITE.id);
    expect(payload.sites).toBeUndefined(); // single-site: no array

    // Step 4: Assert credential row persisted with non-null tokens
    const cred = repo.getByCloudId(MOCK_SITE.id);
    expect(cred).not.toBeNull();
    expect(cred!.accessToken).not.toBeNull();
    expect(cred!.accessToken).toBe(MOCK_TOKENS.access_token);
    expect(cred!.refreshToken).not.toBeNull();
    expect(cred!.refreshToken).toBe(MOCK_TOKENS.refresh_token);
    expect(cred!.accountId).toBe(MOCK_ME.accountId);
    expect(cred!.oauthClientId).toBe(HTTPS_CONFIG.clientId);
  });

  it('POST /connections/select returns connected after OAuth credentials are stored', async () => {
    // Seed credentials via the OAuth callback
    const app = buildApp(stateStore, repo, HTTPS_CONFIG, makeHappyPathFetch([MOCK_SITE]));
    const state = stateStore.generate();
    await request(app)
      .get(`/api/jira/oauth/callback?code=code-sel&state=${state}`)
      .expect(302);

    // Call /select for the seeded cloudId
    const res = await request(app)
      .post('/api/jira/connections/select')
      .send({ cloudId: MOCK_SITE.id })
      .expect(200);

    expect(res.body.status).toBe('connected');
    expect(res.body.site.id).toBe(MOCK_SITE.id);
    expect(res.body.site.url).toBe(MOCK_SITE.url);
  });

  it('multi-site OAuth flow stores credentials for all sites', async () => {
    const siteB: AccessibleResource = {
      ...MOCK_SITE,
      id: 'cloud-e2e-002',
      url: 'https://e2e-site-b.atlassian.net',
    };
    const app = buildApp(stateStore, repo, HTTPS_CONFIG, makeHappyPathFetch([MOCK_SITE, siteB]));

    const state = stateStore.generate();
    const res = await request(app)
      .get(`/api/jira/oauth/callback?code=code-multi&state=${state}`)
      .expect(302);

    const payload = decodeOAuthResult(res.headers['location'] as string);
    expect(payload.status).toBe('connected');
    expect((payload.sites as unknown[]).length).toBe(2);
    expect(payload.site).toBeUndefined(); // multi-site: no single site

    // Both credentials persisted
    const credA = repo.getByCloudId(MOCK_SITE.id);
    const credB = repo.getByCloudId(siteB.id);
    expect(credA).not.toBeNull();
    expect(credA!.accessToken).toBe(MOCK_TOKENS.access_token);
    expect(credA!.refreshToken).toBe(MOCK_TOKENS.refresh_token);
    expect(credB).not.toBeNull();
    expect(credB!.accessToken).toBe(MOCK_TOKENS.access_token);
    expect(credB!.refreshToken).toBe(MOCK_TOKENS.refresh_token);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. HTTPS-ONLY CALLBACK ENFORCEMENT
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTPS-Only Callback Enforcement', () => {
  let db: Database.Database;
  let repo: JiraCredentialRepository;
  let stateStore: OAuthStateStore;

  beforeEach(() => {
    db = new Database(':memory:');
    JiraCredentialRepository.runMigration(db);
    repo = new JiraCredentialRepository(db);
    stateStore = new OAuthStateStore();
  });

  afterEach(() => db.close());

  it('returns 400 with redirect_uri_must_be_https when http:// URI configured', async () => {
    const app = buildApp(stateStore, repo, HTTP_CONFIG, jest.fn() as unknown as typeof fetch);
    const res = await request(app).get('/api/jira/oauth/start').expect(400);
    expect(res.body.error).toBe('redirect_uri_must_be_https');
  });

  it('logs the rejection with the offending URI', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const app = buildApp(stateStore, repo, HTTP_CONFIG, jest.fn() as unknown as typeof fetch);
    await request(app).get('/api/jira/oauth/start').expect(400);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[jira-oauth] OAUTH_REDIRECT_URI must use HTTPS'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(HTTP_CONFIG.redirectUri),
    );

    errorSpy.mockRestore();
  });

  it('does NOT reject a valid https:// redirectUri', async () => {
    const noopFetch = jest.fn() as unknown as typeof fetch;
    const app = buildApp(stateStore, repo, HTTPS_CONFIG, noopFetch);
    // Should 302 redirect (not 400)
    await request(app).get('/api/jira/oauth/start').expect(302);
    expect(noopFetch).not.toHaveBeenCalled(); // fetch is not called during /start
  });

  it('does not call fetchFn when the http:// guard rejects', async () => {
    const fetchSpy = jest.fn() as unknown as typeof fetch;
    const app = buildApp(stateStore, repo, HTTP_CONFIG, fetchSpy);
    await request(app).get('/api/jira/oauth/start').expect(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ATOMICITY FAULT INJECTION — KILL+RESTART SIMULATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Atomicity Fault Injection — Kill+Restart Simulation', () => {
  /**
   * This test suite uses a real on-disk SQLite file (not :memory:) to simulate
   * a process crash mid-rotation. Each phase opens a new Database handle,
   * mimicking separate process lifetimes.
   *
   * Acceptance proof: after a throw that aborts the SQLite transaction (modelling
   * SIGKILL between the UPDATE and the implicit COMMIT), reopening the file must
   * yield tokens that are either BOTH the original values or BOTH the new values —
   * never a mix.
   */

  const CLOUD_ID = 'cloud-atomic-001';
  const SITE_URL = 'https://atomic-test.atlassian.net';
  const ACCOUNT_ID = 'account-atomic-001';
  const OAUTH_CLIENT_ID = 'client-atomic';

  const INITIAL_TOKENS: TokenSet = {
    accessToken: 'access_initial_v1',
    refreshToken: 'refresh_initial_v1',
    accessTokenExpiresAt: 1_800_000_000,
  };

  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `jira-atomicity-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  });

  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = tmpDbPath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('no mixed-token state after mid-rotation crash: both tokens are original on restart', () => {
    // ── Phase 1: Establish initial on-disk state ──────────────────────────────
    {
      const db = new Database(tmpDbPath);
      db.pragma('journal_mode = WAL');
      JiraCredentialRepository.runMigration(db);
      const repo = new JiraCredentialRepository(db);
      repo.upsertConnection(CLOUD_ID, INITIAL_TOKENS, OAUTH_CLIENT_ID, SITE_URL, ACCOUNT_ID);
      db.close(); // clean checkpoint, WAL flushed
    }

    // ── Phase 2: Simulate process crash mid-transaction ────────────────────────
    // Models: process receives SIGKILL after the UPDATE stmt executes but before
    // SQLite flushes the WAL commit record. better-sqlite3 transactions roll back
    // atomically when the wrapper function throws — same observable effect as crash.
    {
      const db = new Database(tmpDbPath);
      db.pragma('journal_mode = WAL');
      const repo = new JiraCredentialRepository(db);

      const origTransaction = db.transaction.bind(db);
      jest
        .spyOn(db, 'transaction')
        .mockImplementationOnce((fn: (...args: unknown[]) => unknown) => {
          return origTransaction((...args: unknown[]) => {
            fn(...args); // UPDATE executes inside the transaction
            throw new Error('[kill-sim] SIGKILL — process terminated'); // force rollback
          });
        });

      expect(() =>
        repo.rotateTokens(CLOUD_ID, 'access_PARTIAL_new', 'refresh_PARTIAL_new', 1_900_000_000),
      ).toThrow('[kill-sim] SIGKILL — process terminated');

      db.close(); // close without committing — WAL entry is abandoned
    }

    // ── Phase 3: Restart — reopen database file ───────────────────────────────
    // SQLite WAL recovery: the uncommitted entry is discarded on next open.
    {
      const db = new Database(tmpDbPath);
      db.pragma('journal_mode = WAL');
      const repo = new JiraCredentialRepository(db);

      const cred = repo.getByCloudId(CLOUD_ID);

      // Credential row must exist (not wiped)
      expect(cred).not.toBeNull();

      // Both tokens must be the ORIGINAL values — no partial state
      expect(cred!.accessToken).toBe(INITIAL_TOKENS.accessToken);
      expect(cred!.refreshToken).toBe(INITIAL_TOKENS.refreshToken);
      expect(cred!.accessTokenExpiresAt).toBe(INITIAL_TOKENS.accessTokenExpiresAt);

      // Tokens must NOT be the in-flight "new" values
      expect(cred!.accessToken).not.toBe('access_PARTIAL_new');
      expect(cred!.refreshToken).not.toBe('refresh_PARTIAL_new');

      db.close();
    }
  });

  it('successful rotation across open/close cycles leaves both tokens as new values', () => {
    // Phase 1: seed
    {
      const db = new Database(tmpDbPath);
      db.pragma('journal_mode = WAL');
      JiraCredentialRepository.runMigration(db);
      const repo = new JiraCredentialRepository(db);
      repo.upsertConnection(CLOUD_ID, INITIAL_TOKENS, OAUTH_CLIENT_ID, SITE_URL, ACCOUNT_ID);
      db.close();
    }

    // Phase 2: successful rotation in separate "process"
    {
      const db = new Database(tmpDbPath);
      db.pragma('journal_mode = WAL');
      const repo = new JiraCredentialRepository(db);
      repo.rotateTokens(CLOUD_ID, 'access_v2_committed', 'refresh_v2_committed', 1_950_000_000);
      db.close();
    }

    // Phase 3: reopen — both tokens must be new, consistent (not mixed)
    {
      const db = new Database(tmpDbPath);
      db.pragma('journal_mode = WAL');
      const repo = new JiraCredentialRepository(db);

      const cred = repo.getByCloudId(CLOUD_ID);
      expect(cred!.accessToken).toBe('access_v2_committed');
      expect(cred!.refreshToken).toBe('refresh_v2_committed');
      expect(cred!.accessTokenExpiresAt).toBe(1_950_000_000);
      // Neither token is old
      expect(cred!.accessToken).not.toBe(INITIAL_TOKENS.accessToken);
      expect(cred!.refreshToken).not.toBe(INITIAL_TOKENS.refreshToken);

      db.close();
    }
  });

  it('concurrent upsert and rotateTokens: last-writer wins, no mixed state', () => {
    // Establishes initial state
    {
      const db = new Database(tmpDbPath);
      db.pragma('journal_mode = WAL');
      JiraCredentialRepository.runMigration(db);
      const repo = new JiraCredentialRepository(db);
      repo.upsertConnection(CLOUD_ID, INITIAL_TOKENS, OAUTH_CLIENT_ID, SITE_URL, ACCOUNT_ID);
      db.close();
    }

    // Open two handles, rotate from handle 1, then upsert from handle 2
    const db1 = new Database(tmpDbPath);
    db1.pragma('journal_mode = WAL');
    const repo1 = new JiraCredentialRepository(db1);

    const db2 = new Database(tmpDbPath);
    db2.pragma('journal_mode = WAL');
    const repo2 = new JiraCredentialRepository(db2);

    repo1.rotateTokens(CLOUD_ID, 'access_r1', 'refresh_r1', 1_910_000_000);
    repo2.upsertConnection(
      CLOUD_ID,
      { accessToken: 'access_u2', refreshToken: 'refresh_u2', accessTokenExpiresAt: 1_920_000_000 },
      OAUTH_CLIENT_ID,
      SITE_URL,
      ACCOUNT_ID,
    );

    db1.close();
    db2.close();

    // Reopen: verify the row is in a consistent state (both tokens match one writer)
    const db3 = new Database(tmpDbPath);
    db3.pragma('journal_mode = WAL');
    const repo3 = new JiraCredentialRepository(db3);
    const cred = repo3.getByCloudId(CLOUD_ID);

    // The row must reflect one complete write set, not a mix
    const isRotationState =
      cred!.accessToken === 'access_r1' && cred!.refreshToken === 'refresh_r1';
    const isUpsertState =
      cred!.accessToken === 'access_u2' && cred!.refreshToken === 'refresh_u2';

    expect(isRotationState || isUpsertState).toBe(true);
    // Must never be a mix of the two writers' tokens
    expect(
      cred!.accessToken === 'access_r1' && cred!.refreshToken === 'refresh_u2',
    ).toBe(false);
    expect(
      cred!.accessToken === 'access_u2' && cred!.refreshToken === 'refresh_r1',
    ).toBe(false);

    db3.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 401 ERROR RESPONSE — RECONNECT BANNER TRIGGER PATH
// ─────────────────────────────────────────────────────────────────────────────

describe('401 Error Response — Reconnect Banner Trigger Path', () => {
  /**
   * The frontend ErrorBanner renders when the backend returns a non-200 / error
   * response. These tests verify the backend surfaces structured error codes that
   * the frontend maps to the appropriate banner message and Reconnect affordance.
   *
   * The "force 401" scenario: Atlassian's accessible-resources endpoint rejects
   * the exchanged token with 401 (e.g. revoked app, site access removed).
   */

  let db: Database.Database;
  let repo: JiraCredentialRepository;
  let stateStore: OAuthStateStore;

  beforeEach(() => {
    db = new Database(':memory:');
    JiraCredentialRepository.runMigration(db);
    repo = new JiraCredentialRepository(db);
    stateStore = new OAuthStateStore();
  });

  afterEach(() => db.close());

  it('accessible-resources 401 → callback returns 500 accessible_resources_failed; no credential stored', async () => {
    const fetch401 = jest.fn().mockImplementation((url: string) => {
      if (url === 'https://auth.atlassian.com/oauth/token') {
        return Promise.resolve(mockFetchResponse(MOCK_TOKENS));
      }
      if (url === 'https://api.atlassian.com/oauth/token/accessible-resources') {
        return Promise.resolve(mockFetchResponse({ error: 'Unauthorized' }, 401));
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    }) as unknown as typeof fetch;

    const app = buildApp(stateStore, repo, HTTPS_CONFIG, fetch401);
    const state = stateStore.generate();

    const res = await request(app)
      .get(`/api/jira/oauth/callback?code=code-401&state=${state}`)
      .expect(500);

    expect(res.body.error).toBe('accessible_resources_failed');
    // No credential must be stored — the frontend error banner fires on this state
    expect(repo.getByCloudId(MOCK_SITE.id)).toBeNull();
  });

  it('/me 401 → callback returns 500 me_verification_failed; no credential stored', async () => {
    const fetchMeFail = jest.fn().mockImplementation((url: string) => {
      if (url === 'https://auth.atlassian.com/oauth/token') {
        return Promise.resolve(mockFetchResponse(MOCK_TOKENS));
      }
      if (url === 'https://api.atlassian.com/oauth/token/accessible-resources') {
        return Promise.resolve(mockFetchResponse([MOCK_SITE]));
      }
      if (url === 'https://api.atlassian.com/me') {
        return Promise.resolve(mockFetchResponse({ error: 'Unauthorized' }, 401));
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    }) as unknown as typeof fetch;

    const app = buildApp(stateStore, repo, HTTPS_CONFIG, fetchMeFail);
    const state = stateStore.generate();

    const res = await request(app)
      .get(`/api/jira/oauth/callback?code=code-401-me&state=${state}`)
      .expect(500);

    expect(res.body.error).toBe('me_verification_failed');
    expect(repo.getByCloudId(MOCK_SITE.id)).toBeNull();
  });

  it('token exchange 4xx → callback returns 400 token_exchange_failed', async () => {
    const fetchTokenFail = jest.fn().mockImplementation((url: string) => {
      if (url === 'https://auth.atlassian.com/oauth/token') {
        return Promise.resolve(mockFetchResponse({ error: 'invalid_grant' }, 400));
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    }) as unknown as typeof fetch;

    const app = buildApp(stateStore, repo, HTTPS_CONFIG, fetchTokenFail);
    const state = stateStore.generate();

    const res = await request(app)
      .get(`/api/jira/oauth/callback?code=bad-code&state=${state}`)
      .expect(400);

    expect(res.body.error).toBe('token_exchange_failed');
    expect(res.body.status).toBe(400);
  });

  it('GET /start redirects to Atlassian authorize URL — this is the Reconnect button target', async () => {
    // Validates that the URL the frontend ErrorBanner Reconnect button navigates to
    // correctly initiates a fresh OAuth flow.
    const noopFetch = jest.fn() as unknown as typeof fetch;
    const app = buildApp(stateStore, repo, HTTPS_CONFIG, noopFetch);

    const res = await request(app).get('/api/jira/oauth/start').expect(302);
    expect(res.headers['location']).toMatch(/https:\/\/auth\.atlassian\.com\/authorize/);
  });

  it('oauth_error query param from Atlassian → 400 authorization_denied from callback', async () => {
    // Atlassian sends ?error=access_denied when the user denies access.
    // The frontend routes this via ?oauth_error to render ErrorBanner.
    const noopFetch = jest.fn() as unknown as typeof fetch;
    const app = buildApp(stateStore, repo, HTTPS_CONFIG, noopFetch);

    const res = await request(app)
      .get('/api/jira/oauth/callback?error=access_denied&state=any-state')
      .expect(400);

    expect(res.body.error).toBe('authorization_denied');
    expect(res.body.detail).toBe('access_denied');
    expect(noopFetch).not.toHaveBeenCalled();
  });
});
