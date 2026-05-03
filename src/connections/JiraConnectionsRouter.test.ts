import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';
import { createJiraConnectionsRouter } from './JiraConnectionsRouter';

function buildApp(repo: JiraCredentialRepository) {
  const app = express();
  app.use(express.json());
  app.use('/api/jira/connections', createJiraConnectionsRouter(repo));
  return app;
}

describe('JiraConnectionsRouter', () => {
  let db: Database.Database;
  let repo: JiraCredentialRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    JiraCredentialRepository.runMigration(db);
    repo = new JiraCredentialRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns 400 when cloudId is missing', async () => {
    const app = buildApp(repo);
    const res = await request(app).post('/api/jira/connections/select').send({}).expect(400);
    expect(res.body.error).toBe('missing_cloud_id');
  });

  it('returns 404 when cloudId has no stored credential', async () => {
    const app = buildApp(repo);
    const res = await request(app)
      .post('/api/jira/connections/select')
      .send({ cloudId: 'nonexistent-id' })
      .expect(404);
    expect(res.body.error).toBe('cloud_id_not_found');
  });

  it('returns 200 with site info for a known cloudId', async () => {
    repo.upsertConnection(
      'cloud-abc',
      { accessToken: 'at', refreshToken: 'rt', accessTokenExpiresAt: 9999999999 },
      'client-id',
      'https://myorg.atlassian.net',
      'account-123'
    );

    const app = buildApp(repo);
    const res = await request(app)
      .post('/api/jira/connections/select')
      .send({ cloudId: 'cloud-abc' })
      .expect(200);

    expect(res.body.status).toBe('connected');
    expect(res.body.site.id).toBe('cloud-abc');
    expect(res.body.site.url).toBe('https://myorg.atlassian.net');
  });
});
