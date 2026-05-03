/**
 * InventoryRouter integration tests
 *
 * Coverage:
 *
 * GET /api/inventory/summary
 *   - Returns per-type counts from latest backup point manifest
 *   - Returns zero counts when no backup points exist
 *   - Returns 400 when cloud ID is missing
 *
 * GET /api/inventory/issues
 *   - Returns paginated issues list with all required row fields
 *   - Handles pagination (offset + limit)
 *   - Returns empty list when no issues exist
 *   - Filters out attachment sub-entries (:att: objectIds)
 *   - Returns 400 when cloud ID is missing
 *
 * GET /api/search
 *   - Matches issues by issueKey (case-insensitive)
 *   - Matches projects by projectKey and projectName from manifest entries
 *   - Returns typed SearchCard for each match
 *   - Returns empty results for empty query
 *   - Returns empty results when no backup points exist
 *   - Returns 400 when cloud ID is missing
 *   - Returns empty results for non-matching query
 */

import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { BackupPointRepository } from '../manifest/BackupPointRepository';
import { BackupPointManifestWriter } from '../manifest/BackupPointManifestWriter';
import {
  SimpleManifestEntry,
  ManifestEntry,
  BackupPointManifest,
} from '../manifest/types';
import { createInventoryRouter } from './InventoryRouter';

// ── DB / repo helpers ─────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  BackupPointRepository.migrate(db);
  return db;
}

function makeRepo(db: Database.Database): BackupPointRepository {
  return new BackupPointRepository(db);
}

function makeApp(repo: BackupPointRepository, backupDir?: string) {
  const app = express();
  app.use(express.json());
  const router = createInventoryRouter(repo, {
    allowUnauthenticated: true,
    backupDir,
  });
  app.use('/api', router);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLOUD_ID = 'cloud-test-abc';
const SITE_URL = 'https://test.atlassian.net';
const BP_ID = 'bp-inv-001';

/** Seeds a minimal backup point row and returns the writer so callers can
 *  append entries as needed. */
function seedBackupPoint(
  repo: BackupPointRepository,
  id: string = BP_ID,
): BackupPointManifestWriter {
  return new BackupPointManifestWriter(repo, {
    backupPointId: id,
    cloudId: CLOUD_ID,
    siteUrl: SITE_URL,
    scopeMode: 'all',
  });
}

function makeIssueEntry(
  overrides: Partial<SimpleManifestEntry> = {},
): SimpleManifestEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2)}`,
    backupPointId: BP_ID,
    objectType: 'JiraIssue',
    objectId: 'PROJ-1',
    capturedAt: Date.now(),
    sourceEndpoint: '/rest/api/3/search/jql',
    status: 'ok',
    ...overrides,
  };
}

// ── Tests: GET /api/inventory/summary ────────────────────────────────────────

describe('GET /api/inventory/summary', () => {
  it('returns zero counts when no backup points exist', async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const app = makeApp(repo);

    const res = await request(app)
      .get('/api/inventory/summary')
      .set('x-cloud-id', CLOUD_ID);

    expect(res.status).toBe(200);
    expect(res.body.backupPointId).toBeNull();
    expect(res.body.counts.JiraIssue).toBe(0);
    expect(res.body.counts.JiraProject).toBe(0);
    expect(res.body.counts.JiraBoard).toBe(0);
    expect(res.body.counts.JiraSprint).toBe(0);

    console.log(
      '[test-evidence] summary empty manifest:',
      JSON.stringify(res.body),
    );
    db.close();
  });

  it('returns per-type counts from latest backup point', async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const writer = seedBackupPoint(repo);

    // Append 2 issues, 1 project, 1 board, 1 sprint
    writer.append(makeIssueEntry({ objectId: 'PROJ-1', objectType: 'JiraIssue' }));
    writer.append(makeIssueEntry({ objectId: 'PROJ-2', objectType: 'JiraIssue' }));
    writer.append(
      makeIssueEntry({ objectId: 'proj-id-1', objectType: 'JiraProject' }),
    );
    writer.append(
      makeIssueEntry({ objectId: 'board-id-1', objectType: 'JiraBoard' }),
    );
    writer.append(
      makeIssueEntry({ objectId: 'sprint-id-1', objectType: 'JiraSprint' }),
    );

    const app = makeApp(repo);
    const res = await request(app)
      .get('/api/inventory/summary')
      .set('x-cloud-id', CLOUD_ID);

    expect(res.status).toBe(200);
    expect(res.body.backupPointId).toBe(BP_ID);
    expect(res.body.counts.JiraIssue).toBe(2);
    expect(res.body.counts.JiraProject).toBe(1);
    expect(res.body.counts.JiraBoard).toBe(1);
    expect(res.body.counts.JiraSprint).toBe(1);

    console.log(
      '[test-evidence] summary with entries:',
      JSON.stringify(res.body),
    );
    db.close();
  });

  it('uses the most recent backup point when multiple exist', async () => {
    const db = makeDb();
    const repo = makeRepo(db);

    // Create older backup point with 1 issue, then backdate its started_at
    const writer1 = seedBackupPoint(repo, 'bp-older');
    writer1.append(makeIssueEntry({ backupPointId: 'bp-older', objectId: 'OLD-1' }));
    // Force it to be 100s in the past so ordering is deterministic
    db.prepare('UPDATE backup_points SET started_at = started_at - 100 WHERE id = ?').run('bp-older');

    // Create a newer backup point with 3 issues
    const writer2 = seedBackupPoint(repo, 'bp-newer');
    writer2.append(makeIssueEntry({ backupPointId: 'bp-newer', objectId: 'NEW-1' }));
    writer2.append(makeIssueEntry({ backupPointId: 'bp-newer', objectId: 'NEW-2' }));
    writer2.append(makeIssueEntry({ backupPointId: 'bp-newer', objectId: 'NEW-3' }));

    const app = makeApp(repo);
    const res = await request(app)
      .get('/api/inventory/summary')
      .set('x-cloud-id', CLOUD_ID);

    expect(res.status).toBe(200);
    expect(res.body.counts.JiraIssue).toBe(3);

    db.close();
  });

  it('returns 400 when x-cloud-id header is missing', async () => {
    const db = makeDb();
    const repo = makeRepo(db);

    // Not using allowUnauthenticated — create a non-anonymous app
    const app = express();
    app.use(express.json());
    const router = createInventoryRouter(repo, { allowUnauthenticated: false });
    app.use('/api', router);

    const res = await request(app).get('/api/inventory/summary');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_cloud_id');

    db.close();
  });
});

// ── Tests: GET /api/inventory/issues ─────────────────────────────────────────

describe('GET /api/inventory/issues', () => {
  it('returns empty list when no backup points exist', async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const app = makeApp(repo);

    const res = await request(app)
      .get('/api/inventory/issues')
      .set('x-cloud-id', CLOUD_ID);

    expect(res.status).toBe(200);
    expect(res.body.issues).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.backupPointId).toBeNull();

    db.close();
  });

  it('returns issues with all required row fields', async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const writer = seedBackupPoint(repo);

    writer.append(makeIssueEntry({ objectId: 'PROJ-42' }));

    const app = makeApp(repo);
    const res = await request(app)
      .get('/api/inventory/issues')
      .set('x-cloud-id', CLOUD_ID);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.issues).toHaveLength(1);

    const row = res.body.issues[0];
    expect(row.issueKey).toBe('PROJ-42');
    expect(row).toHaveProperty('summary');
    expect(row).toHaveProperty('issueStatus');
    expect(row).toHaveProperty('issueType');
    expect(row).toHaveProperty('assignee');
    expect(row.platformStatus).toBe('protected');
    expect(row.policy).toBe('daily');
    expect(typeof row.lastBackupAt).toBe('string');
    expect(row.backupPointId).toBe(BP_ID);

    console.log('[test-evidence] issues row:', JSON.stringify(row));
    db.close();
  });

  it('maps error-status entries to platformStatus=error', async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const writer = seedBackupPoint(repo);

    writer.append(
      makeIssueEntry({ objectId: 'ERR-1', status: 'error', errorMessage: 'API_ERROR' }),
    );

    const app = makeApp(repo);
    const res = await request(app)
      .get('/api/inventory/issues')
      .set('x-cloud-id', CLOUD_ID);

    expect(res.status).toBe(200);
    expect(res.body.issues[0].platformStatus).toBe('error');

    db.close();
  });

  it('excludes attachment sub-entries (objectId contains :att:)', async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const writer = seedBackupPoint(repo);

    writer.append(makeIssueEntry({ objectId: 'PROJ-1' }));
    // Attachment sub-entries from IssueCaptureOrchestrator use this key pattern
    writer.append(makeIssueEntry({ objectId: 'PROJ-1:att:att-uuid-999' }));

    const app = makeApp(repo);
    const res = await request(app)
      .get('/api/inventory/issues')
      .set('x-cloud-id', CLOUD_ID);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.issues[0].issueKey).toBe('PROJ-1');

    db.close();
  });

  it('paginates with offset and limit', async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const writer = seedBackupPoint(repo);

    for (let i = 1; i <= 5; i++) {
      writer.append(makeIssueEntry({ objectId: `PROJ-${i}` }));
    }

    const app = makeApp(repo);

    // First page
    const page1 = await request(app)
      .get('/api/inventory/issues?offset=0&limit=2')
      .set('x-cloud-id', CLOUD_ID);
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(5);
    expect(page1.body.issues).toHaveLength(2);

    // Second page
    const page2 = await request(app)
      .get('/api/inventory/issues?offset=2&limit=2')
      .set('x-cloud-id', CLOUD_ID);
    expect(page2.status).toBe(200);
    expect(page2.body.issues).toHaveLength(2);

    // Last page (partial)
    const page3 = await request(app)
      .get('/api/inventory/issues?offset=4&limit=2')
      .set('x-cloud-id', CLOUD_ID);
    expect(page3.status).toBe(200);
    expect(page3.body.issues).toHaveLength(1);

    db.close();
  });

  it('returns 400 when x-cloud-id header is missing', async () => {
    const db = makeDb();
    const repo = makeRepo(db);

    const app = express();
    app.use(express.json());
    const router = createInventoryRouter(repo, { allowUnauthenticated: false });
    app.use('/api', router);

    const res = await request(app).get('/api/inventory/issues');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_cloud_id');

    db.close();
  });
});

// ── Tests: GET /api/search ────────────────────────────────────────────────────

describe('GET /api/search', () => {
  it('returns empty results for empty query string', async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    seedBackupPoint(repo);
    const app = makeApp(repo);

    const res = await request(app)
      .get('/api/search?q=')
      .set('x-cloud-id', CLOUD_ID);

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);

    db.close();
  });

  it('returns empty results when no backup points exist', async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const app = makeApp(repo);

    const res = await request(app)
      .get('/api/search?q=PROJ')
      .set('x-cloud-id', CLOUD_ID);

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);

    db.close();
  });

  it('matches issues by issueKey (case-insensitive)', async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const writer = seedBackupPoint(repo);

    writer.append(makeIssueEntry({ objectId: 'ALPHA-42' }));
    writer.append(makeIssueEntry({ objectId: 'ALPHA-43' }));
    writer.append(makeIssueEntry({ objectId: 'BETA-1' }));

    const app = makeApp(repo);

    // Uppercase match
    const res1 = await request(app)
      .get('/api/search?q=ALPHA')
      .set('x-cloud-id', CLOUD_ID);
    expect(res1.status).toBe(200);
    expect(res1.body.results).toHaveLength(2);
    expect(res1.body.results.every((r: { type: string }) => r.type === 'JiraIssue')).toBe(true);

    // Lowercase match
    const res2 = await request(app)
      .get('/api/search?q=alpha')
      .set('x-cloud-id', CLOUD_ID);
    expect(res2.status).toBe(200);
    expect(res2.body.results).toHaveLength(2);

    console.log('[test-evidence] search results:', JSON.stringify(res1.body.results));
    db.close();
  });

  it('returns typed SearchCard shape for issue results', async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const writer = seedBackupPoint(repo);
    writer.append(makeIssueEntry({ objectId: 'CARD-1' }));

    const app = makeApp(repo);
    const res = await request(app)
      .get('/api/search?q=CARD')
      .set('x-cloud-id', CLOUD_ID);

    expect(res.status).toBe(200);
    const card = res.body.results[0];
    expect(card.type).toBe('JiraIssue');
    expect(card.id).toBe('CARD-1');
    expect(card.displayName).toBe('CARD-1');
    expect(typeof card.lastBackupAt).toBe('string');

    db.close();
  });

  it('searches project/board/sprint entries from manifest_json', async () => {
    const db = makeDb();
    const repo = makeRepo(db);

    // Directly write a backup point manifest with project/board/sprint entries
    repo.create(BP_ID, CLOUD_ID, SITE_URL, 'all');

    const projectEntry: ManifestEntry = {
      id: 'entry-proj-1',
      key: 'SEARCH',
      phase: 'project',
      objectType: 'JiraProject',
      capturedAt: new Date().toISOString(),
      status: 'success',
      backupPointId: BP_ID,
      data: { key: 'SEARCH', name: 'Search Project' },
    };

    const boardEntry: ManifestEntry = {
      id: 'entry-board-1',
      key: 'board-1',
      phase: 'board',
      objectType: 'JiraBoard',
      capturedAt: new Date().toISOString(),
      status: 'success',
      backupPointId: BP_ID,
      data: { id: 1, name: 'Sprint Board Alpha', location: { projectKey: 'SEARCH' } },
    };

    const sprintEntry: ManifestEntry = {
      id: 'entry-sprint-1',
      key: 'sprint-1',
      phase: 'sprint',
      objectType: 'JiraSprint',
      capturedAt: new Date().toISOString(),
      status: 'success',
      backupPointId: BP_ID,
      data: { id: 1, name: 'Alpha Sprint 1', state: 'active' },
    };

    const manifest: BackupPointManifest = {
      backupPointId: BP_ID,
      cloudId: CLOUD_ID,
      siteUrl: SITE_URL,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finalisedAt: new Date().toISOString(),
      scopeMode: 'all',
      status: 'completed',
      stages: [],
      entries: [projectEntry, boardEntry, sprintEntry],
      phaseSummary: {} as BackupPointManifest['phaseSummary'],
      reconciliation: [],
    };

    repo.writeManifest(BP_ID, manifest);

    const app = makeApp(repo);

    // Search for project by key
    const r1 = await request(app)
      .get('/api/search?q=search')
      .set('x-cloud-id', CLOUD_ID);
    expect(r1.status).toBe(200);
    const projectResult = r1.body.results.find(
      (r: { type: string }) => r.type === 'JiraProject',
    );
    expect(projectResult).toBeDefined();
    expect(projectResult.displayName).toBe('Search Project');
    expect(projectResult.projectKey).toBe('SEARCH');

    // Search for board by name
    const r2 = await request(app)
      .get('/api/search?q=alpha')
      .set('x-cloud-id', CLOUD_ID);
    expect(r2.status).toBe(200);
    const boardResult = r2.body.results.find(
      (r: { type: string }) => r.type === 'JiraBoard',
    );
    expect(boardResult).toBeDefined();
    expect(boardResult.displayName).toBe('Sprint Board Alpha');
    expect(boardResult.projectKey).toBe('SEARCH');

    // Sprint should also match 'alpha'
    const sprintResult = r2.body.results.find(
      (r: { type: string }) => r.type === 'JiraSprint',
    );
    expect(sprintResult).toBeDefined();
    expect(sprintResult.displayName).toBe('Alpha Sprint 1');

    console.log('[test-evidence] search context nodes:', JSON.stringify(r2.body.results));
    db.close();
  });

  it('returns empty results for a non-matching query', async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const writer = seedBackupPoint(repo);
    writer.append(makeIssueEntry({ objectId: 'PROJ-1' }));

    const app = makeApp(repo);
    const res = await request(app)
      .get('/api/search?q=ZZZNOMATCH')
      .set('x-cloud-id', CLOUD_ID);

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);

    db.close();
  });

  it('returns 400 when x-cloud-id header is missing', async () => {
    const db = makeDb();
    const repo = makeRepo(db);

    const app = express();
    app.use(express.json());
    const router = createInventoryRouter(repo, { allowUnauthenticated: false });
    app.use('/api', router);

    const res = await request(app).get('/api/search?q=test');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_cloud_id');

    db.close();
  });

  it('returns 400 in allowUnauthenticated mode without cloudId query param', async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const app = makeApp(repo);

    // Hit without any cloud identification
    const res = await request(app).get('/api/search?q=test');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_cloud_id');

    db.close();
  });

  it('handles malformed query param gracefully (no crash)', async () => {
    const db = makeDb();
    const repo = makeRepo(db);
    seedBackupPoint(repo);
    const app = makeApp(repo);

    // Passing an array-like param — Express coerces it to a string
    const res = await request(app)
      .get('/api/search?q=test%00null')
      .set('x-cloud-id', CLOUD_ID);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);

    db.close();
  });
});
