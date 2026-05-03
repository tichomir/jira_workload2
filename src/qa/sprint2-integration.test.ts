/**
 * Sprint 2 QA — Integration tests
 *
 * Coverage:
 *   1. HTTP client concurrent refresh (N=5) — proves exactly one refresh POST fires
 *      even when five parallel requests all encounter a 401.
 *   2. Atomic write assertion — verifies both tokens are persisted in the credential
 *      store before any queued retry request proceeds.
 *   3. Log-line audit: [jira-http] token_refresh — confirms the structured log
 *      appears on every successful refresh.
 *   4. Log-line audit: [jira-manual-auth] account_verified — confirms the structured
 *      log appears on every successful manual-auth connection.
 *   5. Manual auth integration — covers the full HTTP path from POST /api/connections/manual
 *      through credential persistence.
 *
 * All tests use in-memory SQLite and injected fetch — no external network calls.
 */

import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { JiraCredentialRepository, TokenSet } from '../db/JiraCredentialRepository';
import { JiraHttpClient } from '../http/JiraHttpClient';
import { createManualAuthRouter } from '../connections/ManualAuthRouter';

// ─── helpers ─────────────────────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  JiraCredentialRepository.runMigration(db);
  return db;
}

function makeJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    headers: new Headers(),
  } as unknown as Response;
}

const CLOUD_ID = 'cloud-sprint2-001';
const SITE_URL = 'https://sprint2test.atlassian.net';
const ACCOUNT_ID = 'account-sprint2-001';
const OAUTH_CLIENT_ID = 'client-sprint2-001';

const INITIAL_TOKENS: TokenSet = {
  accessToken: 'access_v1_initial',
  refreshToken: 'refresh_v1_initial',
  accessTokenExpiresAt: 9_999_999_999,
};

const NEW_TOKENS = {
  access_token: 'access_v2_refreshed',
  refresh_token: 'refresh_v2_refreshed',
  expires_in: 3600,
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. CONCURRENT REFRESH — N=5
// ─────────────────────────────────────────────────────────────────────────────

describe('Sprint 2 — HTTP Client: concurrent refresh N=5', () => {
  let db: Database.Database;
  let repo: JiraCredentialRepository;

  beforeEach(() => {
    db = openDb();
    repo = new JiraCredentialRepository(db);
    repo.upsertConnection(CLOUD_ID, INITIAL_TOKENS, OAUTH_CLIENT_ID, SITE_URL, ACCOUNT_ID);
  });

  afterEach(() => db.close());

  it('fires exactly ONE refresh POST when 5 concurrent requests all encounter 401', async () => {
    let refreshCallCount = 0;
    let apiCallCount = 0;
    let resolveRefresh!: () => void;

    const mockFetch = jest.fn().mockImplementation(async (url: string) => {
      if (url === 'https://auth.atlassian.com/oauth/token') {
        refreshCallCount++;
        // Hold refresh open until we explicitly release it — forces all 5
        // initial requests to queue on refreshInFlight before it resolves.
        await new Promise<void>((res) => {
          resolveRefresh = res;
        });
        return makeJsonResponse(200, NEW_TOKENS);
      }
      // Each API call: first 5 get 401, subsequent retries get 200.
      const callIndex = ++apiCallCount;
      if (callIndex <= 5) {
        return makeJsonResponse(401, { message: 'Unauthorized' });
      }
      return makeJsonResponse(200, { result: 'ok', callIndex });
    });

    const client = new JiraHttpClient(CLOUD_ID, repo, 'jira', undefined, mockFetch);

    // Fire 5 concurrent requests — each will hit 401 and queue on the refresh mutex.
    const promises = Array.from({ length: 5 }, (_, i) =>
      client.get(`/rest/api/3/test/concurrent/${i}`),
    );

    // Allow all 5 initial request-and-401 microtasks to settle before releasing
    // the refresh. At this point all 5 coroutines should be awaiting refreshInFlight.
    await new Promise((res) => setTimeout(res, 10));

    // Release the single in-flight refresh.
    resolveRefresh();

    await Promise.all(promises);

    // ── assertion: only ONE refresh POST fired ──────────────────────────────
    expect(refreshCallCount).toBe(1);

    // ── assertion: exactly one refresh call to auth.atlassian.com ──────────
    const refreshCalls = (mockFetch.mock.calls as [string][]).filter(
      ([url]) => url === 'https://auth.atlassian.com/oauth/token',
    );
    expect(refreshCalls).toHaveLength(1);

    // ── assertion: 10 total API calls (5 initial 401s + 5 retries) ─────────
    // (refreshCallCount is separate; apiCallCount only counts non-refresh calls)
    expect(apiCallCount).toBe(10);
  });

  // ── atomic write assertion ─────────────────────────────────────────────────

  it('atomic write: BOTH new tokens are persisted before any queued retry reads the store', async () => {
    /**
     * Verifies T2 §6 Constraint 4: rotateTokens is called inside doRefresh
     * before the mutex is released and before any waiting coroutine resumes.
     *
     * After all 5 concurrent requests complete, the credential store must show
     * both new access_token AND new refresh_token — never a partial state.
     */
    let resolveRefresh!: () => void;
    let apiCallCount = 0;

    // Capture tokens from DB at the moment each retry fires (after refresh).
    const tokensSeenDuringRetry: Array<{
      accessToken: string;
      refreshToken: string;
    }> = [];

    const mockFetch = jest.fn().mockImplementation(async (url: string) => {
      if (url === 'https://auth.atlassian.com/oauth/token') {
        await new Promise<void>((res) => {
          resolveRefresh = res;
        });
        return makeJsonResponse(200, NEW_TOKENS);
      }
      const callIndex = ++apiCallCount;
      if (callIndex <= 5) {
        return makeJsonResponse(401, {});
      }
      // This is a retry — capture current DB state to verify atomicity.
      const stored = repo.getByCloudId(CLOUD_ID)!;
      tokensSeenDuringRetry.push({
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
      });
      return makeJsonResponse(200, { ok: true });
    });

    const client = new JiraHttpClient(CLOUD_ID, repo, 'jira', undefined, mockFetch);

    const promises = Array.from({ length: 5 }, (_, i) =>
      client.get(`/rest/api/3/test/atomic/${i}`),
    );

    await new Promise((res) => setTimeout(res, 10));
    resolveRefresh();
    await Promise.all(promises);

    // ── every retry must see BOTH new tokens (not old, not mixed) ──────────
    expect(tokensSeenDuringRetry).toHaveLength(5);
    for (const seen of tokensSeenDuringRetry) {
      expect(seen.accessToken).toBe(NEW_TOKENS.access_token);
      expect(seen.refreshToken).toBe(NEW_TOKENS.refresh_token);
      // Must never see partial state (old access + new refresh, or vice versa)
      expect(seen.accessToken).not.toBe(INITIAL_TOKENS.accessToken);
      expect(seen.refreshToken).not.toBe(INITIAL_TOKENS.refreshToken);
    }

    // ── final DB state: both tokens are new ────────────────────────────────
    const finalCred = repo.getByCloudId(CLOUD_ID)!;
    expect(finalCred.accessToken).toBe(NEW_TOKENS.access_token);
    expect(finalCred.refreshToken).toBe(NEW_TOKENS.refresh_token);
  });

  // ── log-line audit ─────────────────────────────────────────────────────────

  it('log audit: [jira-http] token_refresh outcome=ok appears on successful refresh', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    let resolveRefresh!: () => void;
    let apiCallCount = 0;

    const mockFetch = jest.fn().mockImplementation(async (url: string) => {
      if (url === 'https://auth.atlassian.com/oauth/token') {
        await new Promise<void>((res) => { resolveRefresh = res; });
        return makeJsonResponse(200, NEW_TOKENS);
      }
      return ++apiCallCount === 1
        ? makeJsonResponse(401, {})
        : makeJsonResponse(200, { ok: true });
    });

    const client = new JiraHttpClient(CLOUD_ID, repo, 'jira', undefined, mockFetch);
    const p = client.get('/rest/api/3/myself');

    await new Promise((res) => setTimeout(res, 0));
    resolveRefresh();
    await p;

    // ── [jira-http] token_refresh structured log line must appear ──────────
    const allLogCalls = logSpy.mock.calls.map((args) => args.join(' '));
    const refreshLogLine = allLogCalls.find((line) =>
      line.includes('[jira-http]') &&
      line.includes('token_refresh') &&
      line.includes('outcome=ok'),
    );
    expect(refreshLogLine).toBeDefined();
    expect(refreshLogLine).toContain(`cloudId=${CLOUD_ID}`);

    logSpy.mockRestore();
  });

  it('log audit: [jira-http] token_refresh outcome=error appears on failed refresh', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const mockFetch = jest.fn().mockImplementation(async (url: string) => {
      if (url === 'https://auth.atlassian.com/oauth/token') {
        return {
          ok: false,
          status: 401,
          text: () => Promise.resolve('invalid_grant'),
        } as unknown as Response;
      }
      return makeJsonResponse(401, {});
    });

    const client = new JiraHttpClient(CLOUD_ID, repo, 'jira', undefined, mockFetch);
    await expect(client.get('/rest/api/3/myself')).rejects.toThrow();

    const allErrorCalls = errorSpy.mock.calls.map((args) => args.join(' '));
    const refreshErrorLine = allErrorCalls.find((line) =>
      line.includes('[jira-http]') &&
      line.includes('token_refresh') &&
      line.includes('outcome=error'),
    );
    expect(refreshErrorLine).toBeDefined();

    errorSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. MANUAL AUTH — integration + log audit
// ─────────────────────────────────────────────────────────────────────────────

const VALID_MANUAL_PAYLOAD = {
  siteUrl: 'https://myorg.atlassian.net',
  cloudId: '11111111-2222-3333-4444-555555555555',
  email: 'admin@example.com',
  apiToken: 'ATATT3x_testToken123',
};

function buildManualAuthApp(
  repo: JiraCredentialRepository,
  fetchFn: typeof globalThis.fetch,
) {
  const app = express();
  app.use(express.json());
  app.use('/api/connections/manual', createManualAuthRouter(repo, fetchFn));
  return app;
}

describe('Sprint 2 — Manual Auth: integration + log audit', () => {
  let db: Database.Database;
  let repo: JiraCredentialRepository;

  beforeEach(() => {
    db = openDb();
    repo = new JiraCredentialRepository(db);
  });

  afterEach(() => db.close());

  // ── happy path ─────────────────────────────────────────────────────────────

  it('happy path: valid credentials → 200 connected + credential row persisted', async () => {
    const mockFetch = jest.fn().mockResolvedValue(
      makeJsonResponse(200, { accountId: 'account-manual-xyz' }),
    );
    const app = buildManualAuthApp(repo, mockFetch);

    const res = await request(app)
      .post('/api/connections/manual')
      .send(VALID_MANUAL_PAYLOAD)
      .expect(200);

    expect(res.body.status).toBe('connected');
    expect(res.body.accountId).toBe('account-manual-xyz');

    const stored = repo.getApiTokenByCloudId(VALID_MANUAL_PAYLOAD.cloudId);
    expect(stored).not.toBeNull();
    expect(stored!.email).toBe(VALID_MANUAL_PAYLOAD.email);
    expect(stored!.apiToken).toBe(VALID_MANUAL_PAYLOAD.apiToken);
    expect(stored!.connectorType).toBe('api_token');
  });

  // ── log-line audit ─────────────────────────────────────────────────────────

  it('log audit: [jira-manual-auth] account_verified appears on successful connection', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const mockFetch = jest.fn().mockResolvedValue(
      makeJsonResponse(200, { accountId: 'account-log-audit' }),
    );
    const app = buildManualAuthApp(repo, mockFetch);

    await request(app)
      .post('/api/connections/manual')
      .send(VALID_MANUAL_PAYLOAD)
      .expect(200);

    // ── [jira-manual-auth] account_verified structured log must appear ──────
    const allLogCalls = logSpy.mock.calls.map((args) => args.join(' '));
    const verifyLogLine = allLogCalls.find((line) =>
      line.includes('[jira-manual-auth]') &&
      line.includes('account_verified'),
    );
    expect(verifyLogLine).toBeDefined();
    expect(verifyLogLine).toContain('accountId=account-log-audit');
    expect(verifyLogLine).toContain(`cloudId=${VALID_MANUAL_PAYLOAD.cloudId}`);

    logSpy.mockRestore();
  });

  it('log audit: [jira-manual-auth] account_verified NOT emitted on auth failure', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const mockFetch = jest.fn().mockResolvedValue(
      makeJsonResponse(401, { message: 'Unauthorized' }),
    );
    const app = buildManualAuthApp(repo, mockFetch);

    await request(app)
      .post('/api/connections/manual')
      .send(VALID_MANUAL_PAYLOAD)
      .expect(401);

    const allLogCalls = logSpy.mock.calls.map((args) => args.join(' '));
    const verifyLogLine = allLogCalls.find((line) =>
      line.includes('[jira-manual-auth]') &&
      line.includes('account_verified'),
    );
    expect(verifyLogLine).toBeUndefined();

    logSpy.mockRestore();
  });

  // ── error paths ────────────────────────────────────────────────────────────

  it('INVALID_URL: non-https URL returns 400 with error code INVALID_URL', async () => {
    const app = buildManualAuthApp(repo, jest.fn() as unknown as typeof globalThis.fetch);
    const res = await request(app)
      .post('/api/connections/manual')
      .send({ ...VALID_MANUAL_PAYLOAD, siteUrl: 'http://myorg.atlassian.net' })
      .expect(400);
    expect(res.body.error).toBe('INVALID_URL');
    expect(res.body.message).toContain('https');
  });

  it('INVALID_URL: non-atlassian.net domain returns 400 with INVALID_URL', async () => {
    const app = buildManualAuthApp(repo, jest.fn() as unknown as typeof globalThis.fetch);
    const res = await request(app)
      .post('/api/connections/manual')
      .send({ ...VALID_MANUAL_PAYLOAD, siteUrl: 'https://evil.example.com' })
      .expect(400);
    expect(res.body.error).toBe('INVALID_URL');
  });

  it('AUTH_FAILED: wrong credentials → 401 with error code AUTH_FAILED; no credential stored', async () => {
    const mockFetch = jest.fn().mockResolvedValue(
      makeJsonResponse(401, { message: 'Unauthorized' }),
    );
    const app = buildManualAuthApp(repo, mockFetch);

    const res = await request(app)
      .post('/api/connections/manual')
      .send(VALID_MANUAL_PAYLOAD)
      .expect(401);

    expect(res.body.error).toBe('AUTH_FAILED');
    // No credential must be persisted on auth failure
    expect(repo.getApiTokenByCloudId(VALID_MANUAL_PAYLOAD.cloudId)).toBeNull();
  });

  it('INVALID_TOKEN: empty apiToken returns 400 with INVALID_TOKEN', async () => {
    const app = buildManualAuthApp(repo, jest.fn() as unknown as typeof globalThis.fetch);
    const res = await request(app)
      .post('/api/connections/manual')
      .send({ ...VALID_MANUAL_PAYLOAD, apiToken: '' })
      .expect(400);
    expect(res.body.error).toBe('INVALID_TOKEN');
  });

  it('NETWORK_ERROR: fetch throws → 502 with NETWORK_ERROR; no credential stored', async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const app = buildManualAuthApp(repo, mockFetch as unknown as typeof globalThis.fetch);

    const res = await request(app)
      .post('/api/connections/manual')
      .send(VALID_MANUAL_PAYLOAD)
      .expect(502);

    expect(res.body.error).toBe('NETWORK_ERROR');
    expect(repo.getApiTokenByCloudId(VALID_MANUAL_PAYLOAD.cloudId)).toBeNull();
  });

  // ── Basic auth header encoding ─────────────────────────────────────────────

  it('verification call uses Basic auth header with correct base64 encoding', async () => {
    const mockFetch = jest.fn().mockResolvedValue(
      makeJsonResponse(200, { accountId: 'account-basic-check' }),
    );
    const app = buildManualAuthApp(repo, mockFetch);

    await request(app)
      .post('/api/connections/manual')
      .send(VALID_MANUAL_PAYLOAD)
      .expect(200);

    const [calledUrl, opts] = (mockFetch.mock.calls[0] as [string, RequestInit]);
    expect(calledUrl).toContain('/rest/api/3/myself');

    const expectedEncoded = Buffer.from(
      `${VALID_MANUAL_PAYLOAD.email}:${VALID_MANUAL_PAYLOAD.apiToken}`,
    ).toString('base64');
    expect(
      (opts.headers as Record<string, string>)['Authorization'],
    ).toBe(`Basic ${expectedEncoded}`);
  });
});
