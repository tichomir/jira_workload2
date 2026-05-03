import Database from 'better-sqlite3';
import { JiraCredentialRepository, TokenSet } from '../db/JiraCredentialRepository';
import { JiraHttpClient, AuthError } from './JiraHttpClient';

// ─── helpers ────────────────────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  JiraCredentialRepository.runMigration(db);
  return db;
}

const CLOUD_ID = 'cloud-test-001';
const SITE_URL = 'https://testorg.atlassian.net';
const ACCOUNT_ID = 'account-test-001';
const OAUTH_CLIENT_ID = 'client-test-001';

const INITIAL_TOKENS: TokenSet = {
  accessToken: 'access_v1',
  refreshToken: 'refresh_v1',
  accessTokenExpiresAt: 9_999_999_999,
};

// Minimal Response-shaped objects for mocking (avoids jsdom dependency)
function makeJsonResponse(
  status: number,
  body: unknown,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : String(status),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    headers: new Headers(),
  } as unknown as Response;
}

function makeBinaryResponse(bytes: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.reject(new Error('not JSON')),
    text: () => Promise.resolve(''),
    arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer),
    headers: new Headers(),
  } as unknown as Response;
}

// ─── test suite ─────────────────────────────────────────────────────────────

describe('JiraHttpClient', () => {
  let db: Database.Database;
  let repo: JiraCredentialRepository;

  beforeEach(() => {
    db = openDb();
    repo = new JiraCredentialRepository(db);
    repo.upsertConnection(CLOUD_ID, INITIAL_TOKENS, OAUTH_CLIENT_ID, SITE_URL, ACCOUNT_ID);
  });

  afterEach(() => {
    db.close();
  });

  // ── happy 200 ──────────────────────────────────────────────────────────────

  describe('get() — happy 200', () => {
    it('builds the correct Jira REST base URL and returns parsed JSON', async () => {
      const mockFetch = jest.fn().mockResolvedValue(
        makeJsonResponse(200, { total: 42 }),
      );

      const client = new JiraHttpClient(CLOUD_ID, repo, 'jira', undefined, mockFetch);
      const result = await client.get('/rest/api/3/project/search');

      expect(result).toEqual({ total: 42 });
      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/project/search`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${INITIAL_TOKENS.accessToken}`,
          }),
        }),
      );
    });

    it('passes absolute URLs through unchanged', async () => {
      const mockFetch = jest.fn().mockResolvedValue(
        makeJsonResponse(200, { accountId: 'abc' }),
      );
      const client = new JiraHttpClient(CLOUD_ID, repo, 'jira', undefined, mockFetch);
      await client.get('https://api.atlassian.com/me');

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toBe('https://api.atlassian.com/me');
    });

    it('getBinary returns a Buffer with the raw bytes', async () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const mockFetch = jest.fn().mockResolvedValue(makeBinaryResponse(bytes));
      const client = new JiraHttpClient(CLOUD_ID, repo, 'jira', undefined, mockFetch);
      const buf = await client.getBinary('/rest/api/3/attachment/content/img-001');

      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf).toEqual(Buffer.from(bytes));
    });

    it('post() sends JSON body with Content-Type header', async () => {
      const mockFetch = jest.fn().mockResolvedValue(
        makeJsonResponse(200, { issues: [] }),
      );
      const client = new JiraHttpClient(CLOUD_ID, repo, 'jira', undefined, mockFetch);
      await client.post('/rest/api/3/search/jql', { jql: 'project=TEST', maxResults: 50 });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((options.headers as Record<string, string>)['Content-Type']).toBe(
        'application/json',
      );
      expect(options.body).toBe(JSON.stringify({ jql: 'project=TEST', maxResults: 50 }));
    });
  });

  // ── 401 → refresh → 200 ───────────────────────────────────────────────────

  describe('401-then-refresh-then-200', () => {
    it('refreshes on 401, replays original request with new token, returns result', async () => {
      const newTokens = {
        access_token: 'access_v2',
        refresh_token: 'refresh_v2',
        expires_in: 3600,
      };

      let apiCallCount = 0;
      const mockFetch = jest.fn().mockImplementation(async (url: string) => {
        if (url === 'https://auth.atlassian.com/oauth/token') {
          return makeJsonResponse(200, newTokens);
        }
        apiCallCount++;
        if (apiCallCount === 1) {
          return makeJsonResponse(401, { message: 'Unauthorized' });
        }
        return makeJsonResponse(200, { issues: [{ id: 'PROJ-1' }] });
      });

      const client = new JiraHttpClient(CLOUD_ID, repo, 'jira', undefined, mockFetch);
      const result = await client.get('/rest/api/3/search/jql');

      expect(result).toEqual({ issues: [{ id: 'PROJ-1' }] });

      // Exactly one refresh POST was fired
      const refreshCalls = (mockFetch.mock.calls as [string][]).filter(
        ([url]) => url === 'https://auth.atlassian.com/oauth/token',
      );
      expect(refreshCalls).toHaveLength(1);

      // Verify the refresh body contains grant_type=refresh_token
      // refreshCalls[0] is the full [url, options] tuple for the refresh call.
      const refreshBody = JSON.parse(
        (refreshCalls[0] as unknown as [string, RequestInit])[1].body as string,
      ) as { grant_type: string; refresh_token: string };
      expect(refreshBody.grant_type).toBe('refresh_token');
      expect(refreshBody.refresh_token).toBe(INITIAL_TOKENS.refreshToken);
    });

    it('persists BOTH new access_token AND new refresh_token before returning', async () => {
      const newTokens = {
        access_token: 'new_access',
        refresh_token: 'new_refresh',
        expires_in: 3600,
      };

      let apiCallCount = 0;
      const mockFetch = jest.fn().mockImplementation(async (url: string) => {
        if (url === 'https://auth.atlassian.com/oauth/token') {
          return makeJsonResponse(200, newTokens);
        }
        apiCallCount++;
        return apiCallCount === 1
          ? makeJsonResponse(401, {})
          : makeJsonResponse(200, { ok: true });
      });

      const client = new JiraHttpClient(CLOUD_ID, repo, 'jira', undefined, mockFetch);
      await client.get('/rest/api/3/myself');

      const stored = repo.getByCloudId(CLOUD_ID)!;
      expect(stored.accessToken).toBe('new_access');
      expect(stored.refreshToken).toBe('new_refresh');
    });

    it('does NOT retry on 401 when using explicitBasicAuth (pre-storage mode)', async () => {
      const mockFetch = jest.fn().mockResolvedValue(makeJsonResponse(401, {}));

      const client = new JiraHttpClient(
        CLOUD_ID,
        repo,
        'api_token',
        { email: 'user@example.com', apiToken: 'tok123' },
        mockFetch,
      );

      await expect(client.get('/rest/api/3/myself')).rejects.toThrow(AuthError);

      // Only one API call; no refresh POST
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [calledUrl] = mockFetch.mock.calls[0] as [string];
      expect(calledUrl).not.toBe('https://auth.atlassian.com/oauth/token');
    });
  });

  // ── concurrent refresh queueing ───────────────────────────────────────────

  describe('concurrent refresh queueing', () => {
    it('fires only one refresh POST when two concurrent requests both hit 401', async () => {
      let refreshCallCount = 0;
      let apiCallCount = 0;
      let resolveRefresh!: () => void;

      const mockFetch = jest.fn().mockImplementation(async (url: string) => {
        if (url === 'https://auth.atlassian.com/oauth/token') {
          refreshCallCount++;
          // Hold the refresh open until we explicitly release it
          await new Promise<void>((res) => {
            resolveRefresh = res;
          });
          return makeJsonResponse(200, {
            access_token: 'access_new',
            refresh_token: 'refresh_new',
            expires_in: 3600,
          });
        }
        apiCallCount++;
        if (apiCallCount <= 2) {
          // Both initial requests return 401
          return makeJsonResponse(401, {});
        }
        // Retries succeed
        return makeJsonResponse(200, { result: 'ok' });
      });

      const client = new JiraHttpClient(CLOUD_ID, repo, 'jira', undefined, mockFetch);

      // Fire two concurrent requests — both will hit 401 and queue on the mutex
      const p1 = client.get('/rest/api/3/project/search');
      const p2 = client.get('/rest/api/3/issue/PROJ-1');

      // Allow microtasks to run so both requests hit their 401 responses
      await new Promise((res) => setTimeout(res, 0));

      // Release the single in-flight refresh
      resolveRefresh();

      await Promise.all([p1, p2]);

      expect(refreshCallCount).toBe(1);
    });
  });

  // ── refresh failure → AuthError ───────────────────────────────────────────

  describe('refresh failure', () => {
    it('throws AuthError with code REFRESH_FAILED when the refresh endpoint returns non-200', async () => {
      const mockFetch = jest.fn().mockImplementation(async (url: string) => {
        if (url === 'https://auth.atlassian.com/oauth/token') {
          return {
            ok: false,
            status: 400,
            text: () => Promise.resolve('invalid_grant'),
          } as unknown as Response;
        }
        return makeJsonResponse(401, {});
      });

      const client = new JiraHttpClient(CLOUD_ID, repo, 'jira', undefined, mockFetch);
      const err = await client.get('/rest/api/3/myself').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe('REFRESH_FAILED');
    });

    it('throws AuthError with code REFRESH_NETWORK_ERROR when fetch throws', async () => {
      const mockFetch = jest.fn().mockImplementation(async (url: string) => {
        if (url === 'https://auth.atlassian.com/oauth/token') {
          throw new Error('ECONNREFUSED');
        }
        return makeJsonResponse(401, {});
      });

      const client = new JiraHttpClient(CLOUD_ID, repo, 'jira', undefined, mockFetch);
      const err = await client.get('/rest/api/3/myself').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe('REFRESH_NETWORK_ERROR');
    });
  });

  // ── Basic auth mode (api_token) ───────────────────────────────────────────

  describe('Basic auth mode', () => {
    it('sends HTTP Basic Authorization header for api_token connector type', async () => {
      repo.upsertApiTokenConnection(
        CLOUD_ID,
        SITE_URL,
        'user@example.com',
        'myApiToken',
        ACCOUNT_ID,
      );

      const mockFetch = jest.fn().mockResolvedValue(makeJsonResponse(200, { accountId: 'acc' }));
      const client = new JiraHttpClient(CLOUD_ID, repo, 'api_token', undefined, mockFetch);
      await client.get('/rest/api/3/myself');

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const expectedEncoded = Buffer.from('user@example.com:myApiToken').toString('base64');
      expect((options.headers as Record<string, string>)['Authorization']).toBe(
        `Basic ${expectedEncoded}`,
      );
    });

    it('uses explicitBasicAuth header when provided (pre-storage verification)', async () => {
      const mockFetch = jest.fn().mockResolvedValue(makeJsonResponse(200, { accountId: 'acc' }));
      const client = new JiraHttpClient(
        CLOUD_ID,
        repo,
        'api_token',
        { email: 'verify@test.com', apiToken: 'token_abc' },
        mockFetch,
      );
      await client.get('/rest/api/3/myself');

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const expectedEncoded = Buffer.from('verify@test.com:token_abc').toString('base64');
      expect((options.headers as Record<string, string>)['Authorization']).toBe(
        `Basic ${expectedEncoded}`,
      );
    });
  });
});
