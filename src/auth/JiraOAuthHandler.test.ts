import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';
import { OAuthStateStore } from './OAuthStateStore';
import {
  createJiraOAuthRouter,
  OAuthConfig,
  AccessibleResource,
} from './JiraOAuthHandler';
import { JIRA_OAUTH_SCOPES } from './jiraOAuthScopes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(
  stateStore: OAuthStateStore,
  repo: JiraCredentialRepository,
  config: OAuthConfig,
  fetchFn: typeof globalThis.fetch
) {
  const app = express();
  app.use(express.json());
  app.use('/api/jira/oauth', createJiraOAuthRouter(stateStore, repo, config, fetchFn));
  return app;
}

/** Constructs a minimal Response-like object for fetch mocks. */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_SITE: AccessibleResource = {
  id: 'cloud-abc-123',
  name: 'My Jira Site',
  url: 'https://myorg.atlassian.net',
  scopes: ['manage:jira-configuration', 'read:jira-work'],
  avatarUrl: 'https://site-admin.atlassian.com/avatar.png',
};

const MOCK_TOKENS = {
  access_token: 'at_test_access',
  refresh_token: 'rt_test_refresh',
  expires_in: 3600,
};

const MOCK_ME = { accountId: 'account-xyz-456' };

const VALID_CONFIG: OAuthConfig = {
  clientId: 'client-id-123',
  clientSecret: 'client-secret-xyz',
  redirectUri: 'https://localhost/api/jira/oauth/callback',
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('JiraOAuthHandler', () => {
  let db: Database.Database;
  let repo: JiraCredentialRepository;
  let stateStore: OAuthStateStore;

  beforeEach(() => {
    db = new Database(':memory:');
    JiraCredentialRepository.runMigration(db);
    repo = new JiraCredentialRepository(db);
    stateStore = new OAuthStateStore();
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // GET /start
  // -------------------------------------------------------------------------
  describe('GET /api/jira/oauth/start', () => {
    it('redirects to Atlassian authorize URL containing all T2 §4.2.2 scopes', async () => {
      const app = buildApp(stateStore, repo, VALID_CONFIG, jest.fn() as unknown as typeof fetch);

      const res = await request(app).get('/api/jira/oauth/start').expect(302);

      const location = res.headers['location'] as string;
      expect(location).toMatch(/^https:\/\/auth\.atlassian\.com\/authorize/);

      const url = new URL(location);
      expect(url.searchParams.get('client_id')).toBe(VALID_CONFIG.clientId);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('audience')).toBe('api.atlassian.com');
      expect(url.searchParams.get('redirect_uri')).toBe(VALID_CONFIG.redirectUri);

      const scopeParam = url.searchParams.get('scope') ?? '';
      for (const scope of JIRA_OAUTH_SCOPES) {
        expect(scopeParam).toContain(scope);
      }
    });

    it('includes a state nonce in the redirect URL', async () => {
      const app = buildApp(stateStore, repo, VALID_CONFIG, jest.fn() as unknown as typeof fetch);
      const res = await request(app).get('/api/jira/oauth/start').expect(302);
      const url = new URL(res.headers['location'] as string);
      expect(url.searchParams.get('state')).toBeTruthy();
    });

    it('returns 400 with structured error when redirect_uri uses http://', async () => {
      const httpConfig: OAuthConfig = {
        ...VALID_CONFIG,
        redirectUri: 'http://localhost/api/jira/oauth/callback',
      };
      const app = buildApp(stateStore, repo, httpConfig, jest.fn() as unknown as typeof fetch);

      const res = await request(app).get('/api/jira/oauth/start').expect(400);
      expect(res.body.error).toBe('redirect_uri_must_be_https');
    });
  });

  // -------------------------------------------------------------------------
  // GET /callback — happy paths
  // -------------------------------------------------------------------------
  describe('GET /api/jira/oauth/callback — happy paths', () => {
    function makeFetch(sites: AccessibleResource[] = [MOCK_SITE]): typeof fetch {
      return jest.fn().mockImplementation((url: string) => {
        if (url === 'https://auth.atlassian.com/oauth/token') {
          return Promise.resolve(mockResponse(MOCK_TOKENS));
        }
        if (url === 'https://api.atlassian.com/oauth/token/accessible-resources') {
          return Promise.resolve(mockResponse(sites));
        }
        if (url === 'https://api.atlassian.com/me') {
          return Promise.resolve(mockResponse(MOCK_ME));
        }
        return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
      }) as unknown as typeof fetch;
    }

    /** Decodes the oauth_result base64url param from a redirect Location header. */
    function decodeOAuthResult(location: string): Record<string, unknown> {
      const url = new URL(location);
      const raw = url.searchParams.get('oauth_result')!;
      const json = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      return JSON.parse(json) as Record<string, unknown>;
    }

    it('auto-selects single site: redirects to frontend with site payload', async () => {
      const app = buildApp(stateStore, repo, VALID_CONFIG, makeFetch([MOCK_SITE]));

      const state = stateStore.generate();
      const res = await request(app)
        .get(`/api/jira/oauth/callback?code=auth-code-123&state=${state}`)
        .expect(302);

      const location = res.headers['location'] as string;
      expect(location).toContain('oauth_result=');

      const payload = decodeOAuthResult(location);
      expect(payload.status).toBe('connected');
      expect((payload.site as Record<string, unknown>).id).toBe(MOCK_SITE.id);
      expect(payload.sites).toBeUndefined();

      const cred = repo.getByCloudId(MOCK_SITE.id);
      expect(cred).not.toBeNull();
      expect(cred!.accessToken).toBe(MOCK_TOKENS.access_token);
      expect(cred!.refreshToken).toBe(MOCK_TOKENS.refresh_token);
      expect(cred!.accountId).toBe(MOCK_ME.accountId);
      expect(cred!.oauthClientId).toBe(VALID_CONFIG.clientId);
      expect(cred!.siteUrl).toBe(MOCK_SITE.url);
    });

    it('multi-site: redirects to frontend with sites list payload', async () => {
      const site2: AccessibleResource = {
        ...MOCK_SITE,
        id: 'cloud-def-456',
        url: 'https://other.atlassian.net',
      };
      const app = buildApp(stateStore, repo, VALID_CONFIG, makeFetch([MOCK_SITE, site2]));

      const state = stateStore.generate();
      const res = await request(app)
        .get(`/api/jira/oauth/callback?code=auth-code-123&state=${state}`)
        .expect(302);

      const payload = decodeOAuthResult(res.headers['location'] as string);
      expect(payload.status).toBe('connected');
      expect((payload.sites as unknown[]).length).toBe(2);
      expect(payload.site).toBeUndefined();

      expect(repo.getByCloudId(MOCK_SITE.id)).not.toBeNull();
      expect(repo.getByCloudId(site2.id)).not.toBeNull();
    });

    it('logs [jira-oauth] account verified with accountId and cloudId', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const app = buildApp(stateStore, repo, VALID_CONFIG, makeFetch([MOCK_SITE]));

      const state = stateStore.generate();
      await request(app)
        .get(`/api/jira/oauth/callback?code=auth-code-123&state=${state}`)
        .expect(302);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `[jira-oauth] account verified accountId=${MOCK_ME.accountId} cloudId=${MOCK_SITE.id}`
        )
      );
      logSpy.mockRestore();
    });

    it('persists accessTokenExpiresAt with 30-second buffer', async () => {
      const app = buildApp(stateStore, repo, VALID_CONFIG, makeFetch([MOCK_SITE]));
      const beforeSec = Math.floor(Date.now() / 1000);

      const state = stateStore.generate();
      await request(app)
        .get(`/api/jira/oauth/callback?code=auth-code-123&state=${state}`)
        .expect(302);

      const afterSec = Math.floor(Date.now() / 1000);
      const cred = repo.getByCloudId(MOCK_SITE.id)!;
      const expectedMin = beforeSec + MOCK_TOKENS.expires_in - 30;
      const expectedMax = afterSec + MOCK_TOKENS.expires_in - 30;
      expect(cred.accessTokenExpiresAt).toBeGreaterThanOrEqual(expectedMin);
      expect(cred.accessTokenExpiresAt).toBeLessThanOrEqual(expectedMax);
    });
  });

  // -------------------------------------------------------------------------
  // GET /callback — error paths
  // -------------------------------------------------------------------------
  describe('GET /api/jira/oauth/callback — error paths', () => {
    it('returns 400 for unknown (invalid) state nonce', async () => {
      const noopFetch = jest.fn() as unknown as typeof fetch;
      const app = buildApp(stateStore, repo, VALID_CONFIG, noopFetch);

      const res = await request(app)
        .get('/api/jira/oauth/callback?code=auth-code-123&state=completely-wrong-nonce')
        .expect(400);

      expect(res.body.error).toBe('invalid_state');
      expect(noopFetch).not.toHaveBeenCalled();
    });

    it('returns 400 for expired state nonce', async () => {
      const shortStore = new OAuthStateStore(1); // 1 ms TTL
      const noopFetch = jest.fn() as unknown as typeof fetch;
      const app = buildApp(shortStore, repo, VALID_CONFIG, noopFetch);

      const state = shortStore.generate();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await request(app)
        .get(`/api/jira/oauth/callback?code=auth-code-123&state=${state}`)
        .expect(400);

      expect(res.body.error).toBe('invalid_state');
    });

    it('returns 400 when token exchange returns 4xx', async () => {
      const failFetch = jest.fn().mockImplementation((url: string) => {
        if (url === 'https://auth.atlassian.com/oauth/token') {
          return Promise.resolve(mockResponse({ error: 'invalid_grant' }, 400));
        }
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      }) as unknown as typeof fetch;

      const app = buildApp(stateStore, repo, VALID_CONFIG, failFetch);
      const state = stateStore.generate();

      const res = await request(app)
        .get(`/api/jira/oauth/callback?code=bad-code&state=${state}`)
        .expect(400);

      expect(res.body.error).toBe('token_exchange_failed');
      expect(res.body.status).toBe(400);
    });

    it('returns 400 when Atlassian returns an error query parameter', async () => {
      const noopFetch = jest.fn() as unknown as typeof fetch;
      const app = buildApp(stateStore, repo, VALID_CONFIG, noopFetch);

      const res = await request(app)
        .get('/api/jira/oauth/callback?error=access_denied&state=any-value')
        .expect(400);

      expect(res.body.error).toBe('authorization_denied');
      expect(res.body.detail).toBe('access_denied');
      expect(noopFetch).not.toHaveBeenCalled();
    });

    it('returns 400 for state nonce that has already been consumed (replay prevention)', async () => {
      const mockFetch = jest.fn().mockImplementation((url: string) => {
        if (url === 'https://auth.atlassian.com/oauth/token')
          return Promise.resolve(mockResponse(MOCK_TOKENS));
        if (url === 'https://api.atlassian.com/oauth/token/accessible-resources')
          return Promise.resolve(mockResponse([MOCK_SITE]));
        if (url === 'https://api.atlassian.com/me')
          return Promise.resolve(mockResponse(MOCK_ME));
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      }) as unknown as typeof fetch;

      const app = buildApp(stateStore, repo, VALID_CONFIG, mockFetch);
      const state = stateStore.generate();

      await request(app)
        .get(`/api/jira/oauth/callback?code=code-1&state=${state}`)
        .expect(302);

      // Second use of the same nonce must be rejected
      const res = await request(app)
        .get(`/api/jira/oauth/callback?code=code-2&state=${state}`)
        .expect(400);

      expect(res.body.error).toBe('invalid_state');
    });
  });
});
