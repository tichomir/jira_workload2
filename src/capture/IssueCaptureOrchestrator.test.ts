/**
 * Tests for IssueCaptureOrchestrator.
 *
 * Covers:
 *  - All 8 payload classes present in captured issue JSON
 *  - Per-item failure does not abort run; failure recorded in manifest
 *  - Job status 'Completed with N errors' when N>0, 'Completed successfully' when 0
 *  - Heartbeat events emitted at ≤heartbeatIntervalMs intervals
 *  - Every captured item queryable by backup-point ID + timestamp
 *  - Structured log evidence lines
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { JiraCredentialRepository, TokenSet } from '../db/JiraCredentialRepository';
import { JiraHttpClient, JiraIssue } from '../http/JiraHttpClient';
import { BackupPointRepository } from '../manifest/BackupPointRepository';
import { BackupPointManifestWriter } from '../manifest/BackupPointManifestWriter';
import { IssueCaptureOrchestrator, IssueCaptureConfig, IssueProgressEvent } from './IssueCaptureOrchestrator';
import { JobStore } from '../jobs/JobStore';

// ── Helpers ───────────────────────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  JiraCredentialRepository.runMigration(db);
  BackupPointRepository.migrate(db);
  JobStore.migrate(db);
  return db;
}

const CLOUD_ID = 'cloud-issue-001';
const SITE_URL = 'https://issuetest.atlassian.net';

const TOKENS: TokenSet = {
  accessToken: 'access_test',
  refreshToken: 'refresh_test',
  accessTokenExpiresAt: 9_999_999_999,
};

function makeIssue(
  key: string,
  extraFields: Record<string, unknown> = {},
): JiraIssue {
  return {
    id: `id-${key}`,
    key,
    self: `https://test.atlassian.net/issue/${key}`,
    fields: {
      summary: `Summary of ${key}`,
      status: { name: 'Open' },
      assignee: { accountId: 'user-1' },
      reporter: { accountId: 'user-2' },
      issuetype: { name: 'Bug' },
      priority: { name: 'Medium' },
      labels: ['backend'],
      fixVersions: [],
      components: [],
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-02T00:00:00.000Z',
      // Custom fields
      customfield_10020: [{ id: 1, name: 'Sprint 5', state: 'active' }],
      customfield_10014: 'PROJ-100', // epic link
      customfield_10031: { value: 'High' }, // custom select
      // Issue links
      issuelinks: [
        {
          id: 'link-1',
          type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
          outwardIssue: { key: 'PROJ-OTHER' },
        },
        {
          id: 'link-2',
          type: { name: 'Relates', inward: 'relates to', outward: 'relates to' },
          inwardIssue: { key: 'PROJ-PARENT' },
        },
      ],
      // Subtasks
      subtasks: [
        { id: 'sub-1', key: 'PROJ-SUB1', fields: { summary: 'Subtask 1' } },
      ],
      // Attachment refs
      attachment: [
        {
          id: 'att-1',
          filename: 'screenshot.png',
          mimeType: 'image/png',
          size: 12345,
          content: 'https://test.atlassian.net/attachment/content/att-1',
          created: '2026-01-01T00:00:00.000Z',
        },
      ],
      ...extraFields,
    },
  };
}

function makeCommentResponse(issueKey: string) {
  return {
    comments: [
      {
        id: `c-${issueKey}-1`,
        author: { accountId: 'user-3', displayName: 'Alice' },
        body: { type: 'doc', content: [{ type: 'text', text: 'Test comment' }] },
        created: '2026-01-01T12:00:00.000Z',
        updated: '2026-01-01T12:00:00.000Z',
      },
    ],
    total: 1,
  };
}

function makeWatchersResponse() {
  return {
    watchCount: 2,
    isWatching: true,
    watchers: [
      { accountId: 'user-1', displayName: 'Bob' },
      { accountId: 'user-2', displayName: 'Carol' },
    ],
  };
}

function makeWorklogResponse(issueKey: string) {
  return {
    worklogs: [
      {
        id: `wl-${issueKey}-1`,
        author: { accountId: 'user-1', displayName: 'Bob' },
        started: '2026-01-02T09:00:00.000Z',
        timeSpentSeconds: 3600,
      },
    ],
  };
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

/** Creates a mock fetch that handles search + per-issue supplemental calls + attachment downloads */
function makeMockFetch(issues: JiraIssue[]): jest.Mock {
  return jest.fn().mockImplementation((url: string) => {
    // Search
    if (url.includes('/rest/api/3/search/jql')) {
      return Promise.resolve(makeJsonResponse(200, { issues, total: issues.length }));
    }
    // Comments
    if (url.includes('/comment')) {
      const key = url.match(/\/issue\/([^/]+)\/comment/)?.[1] ?? 'X';
      return Promise.resolve(makeJsonResponse(200, makeCommentResponse(key)));
    }
    // Watchers
    if (url.includes('/watchers')) {
      return Promise.resolve(makeJsonResponse(200, makeWatchersResponse()));
    }
    // Worklogs
    if (url.includes('/worklog')) {
      return Promise.resolve(makeJsonResponse(200, makeWorklogResponse('X')));
    }
    // Attachment binary downloads — return minimal binary content
    if (url.includes('/attachment/content/')) {
      const bytes = Buffer.from('fake-binary-content');
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.reject(new Error('not JSON')),
        text: () => Promise.resolve(''),
        arrayBuffer: () => {
          const ab = new ArrayBuffer(bytes.length);
          new Uint8Array(ab).set(bytes);
          return Promise.resolve(ab);
        },
        headers: new Headers(),
      } as unknown as Response);
    }
    return Promise.resolve(makeJsonResponse(404, { message: 'Not found' }));
  });
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jira-issue-test-'));
}

function makeWriter(
  db: Database.Database,
  backupPointId: string,
): BackupPointManifestWriter {
  const repo = new BackupPointRepository(db);
  return new BackupPointManifestWriter(repo, {
    backupPointId,
    cloudId: CLOUD_ID,
    siteUrl: SITE_URL,
    scopeMode: 'all',
  });
}

function makeConfig(
  backupPointId: string,
  backupDir: string,
  projectKeys: string[],
  overrides: Partial<IssueCaptureConfig> = {},
): IssueCaptureConfig {
  return {
    backupPointId,
    cloudId: CLOUD_ID,
    projectKeys,
    backupDir,
    heartbeatIntervalMs: 100, // fast for tests
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IssueCaptureOrchestrator', () => {
  let db: Database.Database;
  let credRepo: JiraCredentialRepository;
  let backupDir: string;

  beforeEach(() => {
    db = openDb();
    credRepo = new JiraCredentialRepository(db);
    credRepo.upsertConnection(CLOUD_ID, TOKENS, 'client-1', SITE_URL, 'account-1');
    backupDir = makeTempDir();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  // ── Happy path: full payload capture ─────────────────────────────────────

  describe('happy path — full payload capture', () => {
    it('captures all 8 payload classes for a single issue', async () => {
      const issue = makeIssue('PROJ-1');
      const mockFetch = makeMockFetch([issue]);
      const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined, mockFetch);

      const bpId = 'bp-issue-001';
      const writer = makeWriter(db, bpId);
      const orchestrator = new IssueCaptureOrchestrator(
        client,
        writer,
        makeConfig(bpId, backupDir, ['PROJ']),
      );

      const result = await orchestrator.run();

      expect(result.totalIssuesCaptured).toBe(1);
      expect(result.totalErrors).toBe(0);
      expect(result.jobStatus).toBe('Completed successfully');

      // Read back the persisted issue JSON
      const issuePath = path.join(backupDir, bpId, 'issues', 'PROJ-1.json');
      expect(fs.existsSync(issuePath)).toBe(true);
      const payload = JSON.parse(fs.readFileSync(issuePath, 'utf-8'));

      // 1. System fields present
      expect(payload.fields.summary).toBe('Summary of PROJ-1');
      expect(payload.fields.status).toEqual({ name: 'Open' });

      // 2. customFieldValues map: all customfield_* keys captured
      expect(Object.keys(payload.customFieldValues)).toContain('customfield_10020');
      expect(Object.keys(payload.customFieldValues)).toContain('customfield_10014');
      expect(Object.keys(payload.customFieldValues)).toContain('customfield_10031');
      // No system fields in customFieldValues
      expect('summary' in payload.customFieldValues).toBe(false);

      // 3. ADF comments with author + timestamps
      expect(payload.comments).toHaveLength(1);
      expect(payload.comments[0].author.accountId).toBe('user-3');
      expect(payload.comments[0].created).toBeDefined();
      expect(payload.comments[0].body).toBeDefined(); // ADF body

      // 4. Issue links: both inward and outward
      expect(payload.fields.issuelinks).toHaveLength(2);
      expect(payload.fields.issuelinks[0].outwardIssue?.key).toBe('PROJ-OTHER');
      expect(payload.fields.issuelinks[1].inwardIssue?.key).toBe('PROJ-PARENT');

      // 5. Subtask references
      expect(payload.fields.subtasks).toHaveLength(1);
      expect(payload.fields.subtasks[0].key).toBe('PROJ-SUB1');

      // 6. Sprint membership
      expect(payload.sprintMembership).toBeDefined();
      expect(Array.isArray(payload.sprintMembership)).toBe(true);
      expect((payload.sprintMembership as unknown[])[0]).toMatchObject({ name: 'Sprint 5' });

      // 7. Watchers
      expect(payload.watchers).not.toBeNull();
      expect(payload.watchers.watchCount).toBe(2);
      expect(payload.watchers.watchers).toHaveLength(2);

      // 8. Worklogs
      expect(payload.worklogs).toHaveLength(1);
      expect(payload.worklogs[0].timeSpentSeconds).toBe(3600);

      console.log('[test-evidence] full payload: all 8 classes present in PROJ-1.json');
    });

    it('records ok manifest entry queryable by backupPointId', async () => {
      // Issue without attachments for a clean single-entry assertion
      const issue = makeIssue('PROJ-10', { attachment: [] });
      const mockFetch = makeMockFetch([issue]);
      const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined, mockFetch);

      const bpId = 'bp-manifest-001';
      const repo = new BackupPointRepository(db);
      const writer = makeWriter(db, bpId);
      const orchestrator = new IssueCaptureOrchestrator(
        client,
        writer,
        makeConfig(bpId, backupDir, ['PROJ']),
      );

      await orchestrator.run();

      const entries = repo.getEntriesByBackupPoint(bpId);
      expect(entries).toHaveLength(1);
      const issueEntry = entries.find((e) => e.objectId === 'PROJ-10');
      expect(issueEntry).toBeDefined();
      expect(issueEntry!.objectType).toBe('JiraIssue');
      expect(issueEntry!.status).toBe('ok');
      expect(issueEntry!.backupPointId).toBe(bpId);
      expect(issueEntry!.capturedAt).toBeGreaterThan(0);

      console.log(`[test-evidence] manifest entry: ${JSON.stringify(issueEntry)}`);
    });

    it('captures issues across multiple projects', async () => {
      const issues1 = [makeIssue('ALPHA-1'), makeIssue('ALPHA-2')];
      const issues2 = [makeIssue('BETA-1')];

      let callCount = 0;
      const mockFetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/rest/api/3/search/jql')) {
          callCount++;
          const batch = callCount === 1 ? issues1 : issues2;
          return Promise.resolve(makeJsonResponse(200, { issues: batch, total: batch.length }));
        }
        if (url.includes('/comment')) return Promise.resolve(makeJsonResponse(200, { comments: [], total: 0 }));
        if (url.includes('/watchers')) return Promise.resolve(makeJsonResponse(200, { watchCount: 0, isWatching: false, watchers: [] }));
        if (url.includes('/worklog')) return Promise.resolve(makeJsonResponse(200, { worklogs: [] }));
        // Attachment binary downloads — return minimal binary content
        if (url.includes('/attachment/content/')) {
          const bytes = Buffer.from('fake-binary-content');
          return Promise.resolve({
            ok: true, status: 200, statusText: 'OK',
            json: () => Promise.reject(new Error('not JSON')),
            text: () => Promise.resolve(''),
            arrayBuffer: () => { const ab = new ArrayBuffer(bytes.length); new Uint8Array(ab).set(bytes); return Promise.resolve(ab); },
            headers: new Headers(),
          } as unknown as Response);
        }
        return Promise.resolve(makeJsonResponse(404, {}));
      });

      const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined, mockFetch);
      const bpId = 'bp-multi-proj';
      const writer = makeWriter(db, bpId);
      const orchestrator = new IssueCaptureOrchestrator(
        client,
        writer,
        makeConfig(bpId, backupDir, ['ALPHA', 'BETA']),
      );

      const result = await orchestrator.run();
      expect(result.totalIssuesCaptured).toBe(3);
      expect(result.jobStatus).toBe('Completed successfully');
    });
  });

  // ── Per-item error handling ───────────────────────────────────────────────

  describe('per-item error handling', () => {
    it('continues after a per-issue failure and records error in manifest', async () => {
      const goodIssue = makeIssue('PROJ-OK');
      const badIssue = makeIssue('PROJ-FAIL');

      // For PROJ-FAIL: watchers rejects → propagates to per-item catch in captureIssue
      const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined,
        jest.fn().mockImplementation((url: string) => {
          if (url.includes('/rest/api/3/search/jql')) {
            return Promise.resolve(makeJsonResponse(200, {
              issues: [goodIssue, badIssue],
              total: 2,
            }));
          }
          // PROJ-FAIL watchers throws → per-item error
          if (url.includes('PROJ-FAIL') && url.includes('/watchers')) {
            return Promise.reject(new Error('HTTP 403 Forbidden'));
          }
          if (url.includes('/comment')) return Promise.resolve(makeJsonResponse(200, { comments: [], total: 0 }));
          if (url.includes('/watchers')) return Promise.resolve(makeJsonResponse(200, { watchCount: 0, isWatching: false, watchers: [] }));
          if (url.includes('/worklog')) return Promise.resolve(makeJsonResponse(200, { worklogs: [] }));
          // Attachment binary downloads — return minimal binary content for PROJ-OK's attachment
          if (url.includes('/attachment/content/')) {
            const bytes = Buffer.from('fake-binary-content');
            return Promise.resolve({
              ok: true, status: 200, statusText: 'OK',
              json: () => Promise.reject(new Error('not JSON')),
              text: () => Promise.resolve(''),
              arrayBuffer: () => { const ab = new ArrayBuffer(bytes.length); new Uint8Array(ab).set(bytes); return Promise.resolve(ab); },
              headers: new Headers(),
            } as unknown as Response);
          }
          return Promise.resolve(makeJsonResponse(404, {}));
        }),
      );

      const bpId = 'bp-error-001';
      const repo = new BackupPointRepository(db);
      const writer = makeWriter(db, bpId);
      const errors: IssueProgressEvent[] = [];

      const orchestrator = new IssueCaptureOrchestrator(
        client,
        writer,
        makeConfig(bpId, backupDir, ['PROJ'], {
          onProgress: (e) => { if (e.type === 'issue_error') errors.push(e); },
        }),
      );

      const result = await orchestrator.run();

      // PROJ-OK was captured, PROJ-FAIL errored — run continues
      expect(result.totalIssuesCaptured).toBe(1);
      expect(result.totalErrors).toBe(1);
      expect(result.jobStatus).toBe('Completed with 1 errors');

      // Error entry in manifest — find specifically the PROJ-FAIL issue entry
      const entries = repo.getEntriesByBackupPoint(bpId);
      const errorEntry = entries.find(
        (e) => e.status === 'error' && e.objectId === 'PROJ-FAIL',
      );
      expect(errorEntry).toBeDefined();
      expect(errorEntry!.objectId).toBe('PROJ-FAIL');
      expect(errorEntry!.errorMessage).toBeDefined();

      console.log(`[test-evidence] error entry: ${JSON.stringify(errorEntry)}`);
    });

    it('sets jobStatus to "Completed successfully" only when 0 errors', async () => {
      const mockFetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/rest/api/3/search/jql')) return Promise.resolve(makeJsonResponse(200, { issues: [], total: 0 }));
        return Promise.resolve(makeJsonResponse(404, {}));
      });

      const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined, mockFetch);
      const bpId = 'bp-clean';
      const writer = makeWriter(db, bpId);
      const orchestrator = new IssueCaptureOrchestrator(client, writer, makeConfig(bpId, backupDir, ['EMPTY']));

      const result = await orchestrator.run();
      expect(result.jobStatus).toBe('Completed successfully');
      expect(result.totalErrors).toBe(0);
    });

    it('does not write issue file for failed items (only manifest entry)', async () => {
      const badIssue = makeIssue('PROJ-NOFILE');

      const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined,
        jest.fn().mockImplementation((url: string) => {
          if (url.includes('/rest/api/3/search/jql')) {
            return Promise.resolve(makeJsonResponse(200, { issues: [badIssue], total: 1 }));
          }
          // All supplemental calls throw → triggers per-item error
          return Promise.reject(new Error('network failure'));
        }),
      );

      const bpId = 'bp-nofile';
      const repo = new BackupPointRepository(db);
      const writer = makeWriter(db, bpId);
      const orchestrator = new IssueCaptureOrchestrator(client, writer, makeConfig(bpId, backupDir, ['PROJ']));

      const result = await orchestrator.run();
      expect(result.totalErrors).toBe(1);

      const issuePath = path.join(backupDir, bpId, 'issues', 'PROJ-NOFILE.json');
      expect(fs.existsSync(issuePath)).toBe(false);

      const entries = repo.getEntriesByBackupPoint(bpId);
      expect(entries[0].status).toBe('error');
    });
  });

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  describe('heartbeat events', () => {
    it('emits heartbeat events during a run', async () => {
      // 5 issues, heartbeatIntervalMs=0 (always emit on maybeHeartbeat)
      const issues = [
        makeIssue('HB-1'),
        makeIssue('HB-2'),
        makeIssue('HB-3'),
      ];
      const mockFetch = makeMockFetch(issues);
      const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined, mockFetch);

      const bpId = 'bp-heartbeat';
      const writer = makeWriter(db, bpId);
      const events: IssueProgressEvent[] = [];
      let fakeTime = 0;

      const orchestrator = new IssueCaptureOrchestrator(
        client,
        writer,
        makeConfig(bpId, backupDir, ['HB'], {
          heartbeatIntervalMs: 0, // emit on every maybeHeartbeat call
          onProgress: (e) => events.push(e),
          nowMs: () => { fakeTime += 10; return fakeTime; },
        }),
      );

      await orchestrator.run();

      const heartbeats = events.filter((e) => e.type === 'heartbeat');
      // With heartbeatIntervalMs=0 and nowMs advancing by 10 each call, every maybeHeartbeat emits
      expect(heartbeats.length).toBeGreaterThan(0);
      expect(heartbeats[0].timestamp).toBeDefined();

      console.log(`[test-evidence] heartbeat events emitted: ${heartbeats.length}`);
    });

    it('emits job_complete event with final counts', async () => {
      const mockFetch = makeMockFetch([makeIssue('JC-1')]);
      const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined, mockFetch);

      const bpId = 'bp-jc';
      const writer = makeWriter(db, bpId);
      const events: IssueProgressEvent[] = [];

      const orchestrator = new IssueCaptureOrchestrator(
        client,
        writer,
        makeConfig(bpId, backupDir, ['JC'], { onProgress: (e) => events.push(e) }),
      );

      await orchestrator.run();

      const jobComplete = events.find((e) => e.type === 'job_complete');
      expect(jobComplete).toBeDefined();
      expect(jobComplete!.totalIssuesCaptured).toBe(1);
      expect(jobComplete!.totalErrors).toBe(0);
      expect(jobComplete!.message).toBe('Completed successfully');
    });
  });

  // ── Traceability ──────────────────────────────────────────────────────────

  describe('backup-point ID + timestamp traceability', () => {
    it('every manifest entry carries the backup-point ID', async () => {
      const issues = [makeIssue('TR-1'), makeIssue('TR-2')];
      const mockFetch = makeMockFetch(issues);
      const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined, mockFetch);

      const bpId = 'bp-trace-001';
      const repo = new BackupPointRepository(db);
      const writer = makeWriter(db, bpId);
      const orchestrator = new IssueCaptureOrchestrator(
        client,
        writer,
        makeConfig(bpId, backupDir, ['TR']),
      );

      await orchestrator.run();

      const entries = repo.getEntriesByBackupPoint(bpId);
      // 2 issue entries + up to 2 attachment entries (one per issue)
      expect(entries.length).toBeGreaterThanOrEqual(2);
      for (const entry of entries) {
        expect(entry.backupPointId).toBe(bpId);
        expect(entry.capturedAt).toBeGreaterThan(0);
      }
      // Verify both issues have ok entries
      const issueEntries = entries.filter((e) => e.objectId === 'TR-1' || e.objectId === 'TR-2');
      expect(issueEntries).toHaveLength(2);
      expect(issueEntries.every((e) => e.status === 'ok')).toBe(true);
    });
  });

  // ── JobStore integration: getJobSummary + error traceability ─────────────

  describe('JobStore integration — getJobSummary and error traceability', () => {
    it('happy path: 0 errors → status "completed" / displayStatus "Completed successfully"', async () => {
      const issue = makeIssue('SUM-1', { attachment: [] });
      const mockFetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/rest/api/3/search/jql')) return Promise.resolve(makeJsonResponse(200, { issues: [issue], total: 1 }));
        if (url.includes('/comment')) return Promise.resolve(makeJsonResponse(200, { comments: [], total: 0 }));
        if (url.includes('/watchers')) return Promise.resolve(makeJsonResponse(200, { watchCount: 0, isWatching: false, watchers: [] }));
        if (url.includes('/worklog')) return Promise.resolve(makeJsonResponse(200, { worklogs: [] }));
        return Promise.resolve(makeJsonResponse(404, {}));
      });

      const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined, mockFetch);
      const bpId = 'bp-sum-happy';
      const jobId = 'job-sum-happy';
      const jobStore = new JobStore(db);
      jobStore.createJob(jobId, bpId, 'issues');

      const writer = makeWriter(db, bpId);
      const orchestrator = new IssueCaptureOrchestrator(
        client,
        writer,
        makeConfig(bpId, backupDir, ['SUM'], { jobId, jobStore }),
      );

      const result = await orchestrator.run();

      expect(result.totalErrors).toBe(0);
      expect(result.jobStatus).toBe('Completed successfully');

      const summary = jobStore.getJobSummary(jobId);
      expect(summary).not.toBeNull();
      expect(summary!.status).toBe('completed');
      expect(summary!.displayStatus).toBe('Completed successfully');
      expect(summary!.errors).toHaveLength(0);

      console.log('[test-evidence] getJobSummary happy path:', JSON.stringify(summary));
    });

    it('error path: N>0 errors → status "completed_with_errors" / displayStatus "Completed with N errors"', async () => {
      const goodIssue = makeIssue('SUM-OK', { attachment: [] });
      const badIssue = makeIssue('SUM-FAIL', { attachment: [] });

      const mockFetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/rest/api/3/search/jql')) {
          return Promise.resolve(makeJsonResponse(200, { issues: [goodIssue, badIssue], total: 2 }));
        }
        // SUM-FAIL watchers rejects → per-item error
        if (url.includes('SUM-FAIL') && url.includes('/watchers')) {
          return Promise.reject(new Error('HTTP 403'));
        }
        if (url.includes('/comment')) return Promise.resolve(makeJsonResponse(200, { comments: [], total: 0 }));
        if (url.includes('/watchers')) return Promise.resolve(makeJsonResponse(200, { watchCount: 0, isWatching: false, watchers: [] }));
        if (url.includes('/worklog')) return Promise.resolve(makeJsonResponse(200, { worklogs: [] }));
        return Promise.resolve(makeJsonResponse(404, {}));
      });

      const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined, mockFetch);
      const bpId = 'bp-sum-err';
      const jobId = 'job-sum-err';
      const jobStore = new JobStore(db);
      jobStore.createJob(jobId, bpId, 'issues');

      const writer = makeWriter(db, bpId);
      const orchestrator = new IssueCaptureOrchestrator(
        client,
        writer,
        makeConfig(bpId, backupDir, ['SUM'], { jobId, jobStore }),
      );

      const result = await orchestrator.run();

      expect(result.totalErrors).toBe(1);
      expect(result.jobStatus).toBe('Completed with 1 errors');

      const summary = jobStore.getJobSummary(jobId);
      expect(summary!.status).toBe('completed_with_errors');
      expect(summary!.displayStatus).toContain('1 errors');
      expect(summary!.errors).toHaveLength(1);

      // Verify traceability fields on error record
      const errRecord = summary!.errors[0];
      expect(errRecord.backupPointId).toBe(bpId);
      expect(errRecord.itemId).toBe('SUM-FAIL');
      expect(errRecord.itemType).toBe('JiraIssue');
      expect(errRecord.errorCode).toBe('API_ERROR');
      expect(errRecord.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      console.log('[test-evidence] getJobSummary error path:', JSON.stringify(summary!.errors));
    });

    it('failed status takes precedence over completed_with_errors', async () => {
      const bpId = 'bp-sum-failed';
      const jobId = 'job-sum-failed';
      const jobStore = new JobStore(db);
      jobStore.createJob(jobId, bpId, 'issues');
      jobStore.setFailed(jobId, 'unrecoverable network error');

      const summary = jobStore.getJobSummary(jobId);
      expect(summary!.status).toBe('failed');
      expect(summary!.displayStatus).toContain('Failed');
    });

    it('attachment errors are counted in totalErrors and persisted to job_errors', async () => {
      // Issue with one attachment; attachment download fails
      const issue = makeIssue('ATT-FAIL');
      // Override attachment to have exactly one
      issue.fields['attachment'] = [{
        id: 'att-bad',
        filename: 'bad.png',
        mimeType: 'image/png',
        size: 100,
        content: 'https://test.atlassian.net/attachment/content/att-bad',
        created: '2026-01-01T00:00:00.000Z',
      }];

      const mockFetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/rest/api/3/search/jql')) return Promise.resolve(makeJsonResponse(200, { issues: [issue], total: 1 }));
        if (url.includes('/comment')) return Promise.resolve(makeJsonResponse(200, { comments: [], total: 0 }));
        if (url.includes('/watchers')) return Promise.resolve(makeJsonResponse(200, { watchCount: 0, isWatching: false, watchers: [] }));
        if (url.includes('/worklog')) return Promise.resolve(makeJsonResponse(200, { worklogs: [] }));
        // Attachment download fails
        if (url.includes('/attachment/content/')) return Promise.reject(new Error('Storage unavailable'));
        return Promise.resolve(makeJsonResponse(404, {}));
      });

      const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined, mockFetch);
      const bpId = 'bp-att-fail';
      const jobId = 'job-att-fail';
      const jobStore = new JobStore(db);
      jobStore.createJob(jobId, bpId, 'issues');

      const writer = makeWriter(db, bpId);
      const orchestrator = new IssueCaptureOrchestrator(
        client,
        writer,
        makeConfig(bpId, backupDir, ['ATT'], { jobId, jobStore }),
      );

      const result = await orchestrator.run();

      // Issue itself captured OK (1), but attachment failed (1 error)
      expect(result.totalIssuesCaptured).toBe(1);
      expect(result.totalErrors).toBe(1);
      expect(result.jobStatus).toBe('Completed with 1 errors');

      const summary = jobStore.getJobSummary(jobId);
      expect(summary!.status).toBe('completed_with_errors');
      expect(summary!.errors).toHaveLength(1);
      expect(summary!.errors[0].itemType).toBe('JiraAttachment');
      expect(summary!.errors[0].errorCode).toBe('ATTACHMENT_ERROR');
      expect(summary!.errors[0].backupPointId).toBe(bpId);
      expect(summary!.errors[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      console.log('[test-evidence] attachment error record:', JSON.stringify(summary!.errors[0]));
    });
  });
});
