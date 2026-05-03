import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';
import { createManualAuthRouter } from './ManualAuthRouter';

// ─── helpers ────────────────────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  JiraCredentialRepository.runMigration(db);
  return db;
}

function makeJsonFetch(status: number, body: unknown): typeof globalThis.fetch {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);
}

function buildApp(
  repo: JiraCredentialRepository,
  fetchFn: typeof globalThis.fetch,
) {
  const app = express();
  app.use(express.json());
  app.use('/api/connections/manual', createManualAuthRouter(repo, fetchFn));
  return app;
}

const VALID_PAYLOAD = {
  siteUrl: 'https://myorg.atlassian.net',
  cloudId: '11111111-2222-3333-4444-555555555555',
  email: 'admin@example.com',
  apiToken: 'ATATT3x_myToken',
};

// ─── test suite ─────────────────────────────────────────────────────────────

describe('ManualAuthRouter — POST /api/connections/manual', () => {
  let db: Database.Database;
  let repo: JiraCredentialRepository;

  beforeEach(() => {
    db = openDb();
    repo = new JiraCredentialRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── input validation ───────────────────────────────────────────────────────

  describe('input validation', () => {
    it('rejects non-https siteUrl with INVALID_URL', async () => {
      const app = buildApp(repo, makeJsonFetch(200, {}));
      const res = await request(app)
        .post('/api/connections/manual')
        .send({ ...VALID_PAYLOAD, siteUrl: 'http://myorg.atlassian.net' })
        .expect(400);
      expect(res.body.error).toBe('INVALID_URL');
    });

    it('rejects non-atlassian.net siteUrl with INVALID_URL', async () => {
      const app = buildApp(repo, makeJsonFetch(200, {}));
      const res = await request(app)
        .post('/api/connections/manual')
        .send({ ...VALID_PAYLOAD, siteUrl: 'https://evil.example.com' })
        .expect(400);
      expect(res.body.error).toBe('INVALID_URL');
    });

    it('rejects missing siteUrl with INVALID_URL', async () => {
      const app = buildApp(repo, makeJsonFetch(200, {}));
      const { siteUrl: _omit, ...rest } = VALID_PAYLOAD;
      const res = await request(app)
        .post('/api/connections/manual')
        .send(rest)
        .expect(400);
      expect(res.body.error).toBe('INVALID_URL');
    });

    it('rejects malformed cloudId (not a UUID) with INVALID_CLOUDID', async () => {
      const app = buildApp(repo, makeJsonFetch(200, {}));
      const res = await request(app)
        .post('/api/connections/manual')
        .send({ ...VALID_PAYLOAD, cloudId: 'not-a-uuid' })
        .expect(400);
      expect(res.body.error).toBe('INVALID_CLOUDID');
    });

    it('rejects missing cloudId with INVALID_CLOUDID', async () => {
      const app = buildApp(repo, makeJsonFetch(200, {}));
      const { cloudId: _omit, ...rest } = VALID_PAYLOAD;
      const res = await request(app)
        .post('/api/connections/manual')
        .send(rest)
        .expect(400);
      expect(res.body.error).toBe('INVALID_CLOUDID');
    });

    it('rejects malformed email with INVALID_EMAIL', async () => {
      const app = buildApp(repo, makeJsonFetch(200, {}));
      const res = await request(app)
        .post('/api/connections/manual')
        .send({ ...VALID_PAYLOAD, email: 'not-an-email' })
        .expect(400);
      expect(res.body.error).toBe('INVALID_EMAIL');
    });

    it('rejects empty apiToken with INVALID_TOKEN', async () => {
      const app = buildApp(repo, makeJsonFetch(200, {}));
      const res = await request(app)
        .post('/api/connections/manual')
        .send({ ...VALID_PAYLOAD, apiToken: '' })
        .expect(400);
      expect(res.body.error).toBe('INVALID_TOKEN');
    });

    it('rejects whitespace-only apiToken with INVALID_TOKEN', async () => {
      const app = buildApp(repo, makeJsonFetch(200, {}));
      const res = await request(app)
        .post('/api/connections/manual')
        .send({ ...VALID_PAYLOAD, apiToken: '   ' })
        .expect(400);
      expect(res.body.error).toBe('INVALID_TOKEN');
    });
  });

  // ── verification via canonical client ─────────────────────────────────────

  describe('credential verification', () => {
    it('calls /rest/api/3/myself with Basic auth through the canonical client', async () => {
      const mockFetch = makeJsonFetch(200, { accountId: 'account-abc' });
      const app = buildApp(repo, mockFetch);

      await request(app)
        .post('/api/connections/manual')
        .send(VALID_PAYLOAD)
        .expect(200);

      const calledUrl = ((mockFetch as jest.Mock).mock.calls[0] as [string])[0];
      expect(calledUrl).toContain('/rest/api/3/myself');

      const [, opts] = (mockFetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      const authHeader = (opts.headers as Record<string, string>)['Authorization'];
      const expectedEncoded = Buffer.from(
        `${VALID_PAYLOAD.email}:${VALID_PAYLOAD.apiToken}`,
      ).toString('base64');
      expect(authHeader).toBe(`Basic ${expectedEncoded}`);
    });

    it('returns AUTH_FAILED when /myself returns 401 — no credential stored', async () => {
      const mockFetch = makeJsonFetch(401, { message: 'Unauthorized' });
      const app = buildApp(repo, mockFetch);

      const res = await request(app)
        .post('/api/connections/manual')
        .send(VALID_PAYLOAD)
        .expect(401);

      expect(res.body.error).toBe('AUTH_FAILED');
      // Verify no partial credential was written
      expect(repo.getApiTokenByCloudId(VALID_PAYLOAD.cloudId)).toBeNull();
    });

    it('returns NETWORK_ERROR when fetch throws', async () => {
      const mockFetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const app = buildApp(repo, mockFetch as unknown as typeof globalThis.fetch);

      const res = await request(app)
        .post('/api/connections/manual')
        .send(VALID_PAYLOAD)
        .expect(502);

      expect(res.body.error).toBe('NETWORK_ERROR');
      expect(repo.getApiTokenByCloudId(VALID_PAYLOAD.cloudId)).toBeNull();
    });
  });

  // ── happy path ─────────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('persists api_token credential atomically and returns accountId on success', async () => {
      const mockFetch = makeJsonFetch(200, { accountId: 'account-xyz' });
      const app = buildApp(repo, mockFetch);

      const res = await request(app)
        .post('/api/connections/manual')
        .send(VALID_PAYLOAD)
        .expect(200);

      expect(res.body.status).toBe('connected');
      expect(res.body.accountId).toBe('account-xyz');

      const stored = repo.getApiTokenByCloudId(VALID_PAYLOAD.cloudId);
      expect(stored).not.toBeNull();
      expect(stored!.cloudId).toBe(VALID_PAYLOAD.cloudId);
      expect(stored!.siteUrl).toBe(VALID_PAYLOAD.siteUrl);
      expect(stored!.email).toBe(VALID_PAYLOAD.email);
      expect(stored!.apiToken).toBe(VALID_PAYLOAD.apiToken);
      expect(stored!.accountId).toBe('account-xyz');
      expect(stored!.connectorType).toBe('api_token');
    });

    it('coexists with an OAuth credential for the same cloudId', async () => {
      // Insert an OAuth credential for the same cloudId first
      repo.upsertConnection(
        VALID_PAYLOAD.cloudId,
        { accessToken: 'oauth_at', refreshToken: 'oauth_rt', accessTokenExpiresAt: 9999999 },
        'oauth-client-id',
        VALID_PAYLOAD.siteUrl,
        'account-oauth',
      );

      const mockFetch = makeJsonFetch(200, { accountId: 'account-token' });
      const app = buildApp(repo, mockFetch);

      await request(app)
        .post('/api/connections/manual')
        .send(VALID_PAYLOAD)
        .expect(200);

      // Both rows present
      expect(repo.getByCloudId(VALID_PAYLOAD.cloudId)).not.toBeNull();
      expect(repo.getApiTokenByCloudId(VALID_PAYLOAD.cloudId)).not.toBeNull();
    });

    it('accepts any valid https://*.atlassian.net subdomain', async () => {
      const mockFetch = makeJsonFetch(200, { accountId: 'acc' });
      const app = buildApp(repo, mockFetch);

      const res = await request(app)
        .post('/api/connections/manual')
        .send({ ...VALID_PAYLOAD, siteUrl: 'https://another-org.atlassian.net' })
        .expect(200);

      expect(res.body.status).toBe('connected');
    });
  });
});
