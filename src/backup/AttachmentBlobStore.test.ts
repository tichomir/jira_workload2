/**
 * Tests for binary-faithful attachment download.
 *
 * Covers:
 *  - Downloaded bytes are byte-identical to source (sha256 match)
 *  - Original MIME type preserved in sidecar
 *  - Original filename preserved in sidecar (from issue metadata, not Content-Disposition)
 *  - Per-attachment failure recorded in manifest without aborting run
 *  - downloadAttachment() lives on canonical JiraHttpClient (no raw fetch in feature code)
 *  - Non-text binary (simulated PNG) round-trips with exact byte identity
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { JiraCredentialRepository, TokenSet } from '../db/JiraCredentialRepository';
import { JiraHttpClient } from '../http/JiraHttpClient';
import { AttachmentBlobStore } from './AttachmentBlobStore';
import { BackupPointRepository } from '../manifest/BackupPointRepository';
import { BackupPointManifestWriter } from '../manifest/BackupPointManifestWriter';
import { IssueCaptureOrchestrator, IssueCaptureConfig } from '../capture/IssueCaptureOrchestrator';

// ── PNG fixture ───────────────────────────────────────────────────────────────
// Minimal valid 1×1 red PNG (67 bytes). Used to test non-text binary round-trip.

const PNG_FIXTURE = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
    '2e00000000c49444154789c6260f8cf000000000200014d5a6800000000049' +
    '454e44ae426082',
  'hex',
);
const PNG_SHA256 = crypto.createHash('sha256').update(PNG_FIXTURE).digest('hex');

// ── Helpers ───────────────────────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  JiraCredentialRepository.runMigration(db);
  BackupPointRepository.migrate(db);
  return db;
}

const CLOUD_ID = 'cloud-att-001';
const SITE_URL = 'https://atttest.atlassian.net';
const TOKENS: TokenSet = {
  accessToken: 'access_att',
  refreshToken: 'refresh_att',
  accessTokenExpiresAt: 9_999_999_999,
};

function makeBinaryResponse(bytes: Buffer): Response {
  return {
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
  } as unknown as Response;
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

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: String(status),
    json: () => Promise.resolve({ message: `HTTP ${status}` }),
    text: () => Promise.resolve(`HTTP ${status}`),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    headers: new Headers(),
  } as unknown as Response;
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jira-att-test-'));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AttachmentBlobStore — binary-faithful storage', () => {
  let backupDir: string;

  beforeEach(() => {
    backupDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  describe('save() + readBytes() round-trip', () => {
    it('stores bytes byte-identical to source (non-text PNG fixture)', () => {
      const store = new AttachmentBlobStore(backupDir);
      const sidecar = store.save(
        'bp-att-001',
        'att-png-1',
        'PROJ-1',
        'screenshot.png',
        'image/png',
        PNG_FIXTURE,
      );

      // Byte-identity check via sha256
      expect(sidecar.sha256).toBe(PNG_SHA256);
      expect(sidecar.sizeBytes).toBe(PNG_FIXTURE.length);

      // Read back and verify byte-for-byte equality
      const readBack = store.readBytes('bp-att-001', 'att-png-1');
      expect(Buffer.compare(readBack, PNG_FIXTURE)).toBe(0); // 0 = identical
      expect(crypto.createHash('sha256').update(readBack).digest('hex')).toBe(PNG_SHA256);

      console.log(
        `[test-evidence] PNG round-trip: sha256=${sidecar.sha256.slice(0, 16)}... ` +
          `sizeBytes=${sidecar.sizeBytes}`,
      );
    });

    it('preserves original filename from issue metadata (not Content-Disposition)', () => {
      const store = new AttachmentBlobStore(backupDir);
      const sidecar = store.save(
        'bp-att-002',
        'att-fn-1',
        'PROJ-2',
        'report Q1 2026.xlsx',   // filename from issue.fields.attachment metadata
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        Buffer.from('fake-xlsx-content'),
      );

      expect(sidecar.filename).toBe('report Q1 2026.xlsx');
      expect(sidecar.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
    });

    it('preserves original MIME type in sidecar', () => {
      const store = new AttachmentBlobStore(backupDir);
      const sidecar = store.save(
        'bp-att-003',
        'att-mime-1',
        'PROJ-3',
        'data.csv',
        'text/csv',
        Buffer.from('col1,col2\n1,2\n'),
      );

      expect(sidecar.mimeType).toBe('text/csv');
    });

    it('stores correct backupPointId and issueKey in sidecar', () => {
      const store = new AttachmentBlobStore(backupDir);
      const sidecar = store.save(
        'bp-sidecar-check',
        'att-sc-1',
        'MYPROJ-55',
        'file.pdf',
        'application/pdf',
        Buffer.from('%PDF-1.4 test'),
      );

      const readSidecar = store.readSidecar('bp-sidecar-check', 'att-sc-1');
      expect(readSidecar.backupPointId).toBe('bp-sidecar-check');
      expect(readSidecar.issueKey).toBe('MYPROJ-55');
      expect(readSidecar.attachmentId).toBe('att-sc-1');
    });

    it('stores data.bin and meta.json on disk', () => {
      const store = new AttachmentBlobStore(backupDir);
      store.save('bp-files-check', 'att-f-1', 'PROJ-1', 'doc.txt', 'text/plain', Buffer.from('hello'));

      const dir = path.join(backupDir, 'bp-files-check', 'attachments', 'att-f-1');
      expect(fs.existsSync(path.join(dir, 'data.bin'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'meta.json'))).toBe(true);
    });
  });
});

describe('JiraHttpClient.downloadAttachment() — canonical client method', () => {
  let db: Database.Database;
  let credRepo: JiraCredentialRepository;

  beforeEach(() => {
    db = openDb();
    credRepo = new JiraCredentialRepository(db);
    credRepo.upsertConnection(CLOUD_ID, TOKENS, 'client-att', SITE_URL, 'account-att');
  });

  afterEach(() => { db.close(); });

  it('calls GET /rest/api/3/attachment/content/{id} and returns Buffer', async () => {
    const mockFetch = jest.fn().mockResolvedValue(makeBinaryResponse(PNG_FIXTURE));
    const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined, mockFetch);

    const result = await client.downloadAttachment('att-123');

    expect(result).toBeInstanceOf(Buffer);
    expect(Buffer.compare(result, PNG_FIXTURE)).toBe(0);
    expect(crypto.createHash('sha256').update(result).digest('hex')).toBe(PNG_SHA256);

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('/rest/api/3/attachment/content/att-123');
    expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe('GET');

    console.log(
      `[test-evidence] downloadAttachment: ${result.length} bytes, sha256 matches fixture`,
    );
  });

  it('throws on non-200 response', async () => {
    const mockFetch = jest.fn().mockResolvedValue(makeErrorResponse(403));
    const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined, mockFetch);

    await expect(client.downloadAttachment('att-bad')).rejects.toThrow('403');
  });
});

describe('IssueCaptureOrchestrator — attachment integration', () => {
  let db: Database.Database;
  let credRepo: JiraCredentialRepository;
  let backupDir: string;

  beforeEach(() => {
    db = openDb();
    credRepo = new JiraCredentialRepository(db);
    credRepo.upsertConnection(CLOUD_ID, TOKENS, 'client-att', SITE_URL, 'account-att');
    backupDir = makeTempDir();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  it('downloads attachment after issue capture and verifies byte-identical storage', async () => {
    const issue = {
      id: 'id-PROJ-1',
      key: 'PROJ-1',
      self: 'https://test.atlassian.net/issue/PROJ-1',
      fields: {
        summary: 'Issue with PNG attachment',
        customfield_10020: null,
        issuelinks: [],
        subtasks: [],
        // Attachment ref with original filename + MIME from issue metadata
        attachment: [
          {
            id: 'att-png-123',
            filename: 'original-name.png',
            mimeType: 'image/png',
            size: PNG_FIXTURE.length,
            content: `https://test.atlassian.net/attachment/content/att-png-123`,
            created: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    };

    const mockFetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/rest/api/3/search/jql')) {
        return Promise.resolve(makeJsonResponse(200, { issues: [issue], total: 1 }));
      }
      if (url.includes('/comment')) return Promise.resolve(makeJsonResponse(200, { comments: [], total: 0 }));
      if (url.includes('/watchers')) return Promise.resolve(makeJsonResponse(200, { watchCount: 0, isWatching: false, watchers: [] }));
      if (url.includes('/worklog')) return Promise.resolve(makeJsonResponse(200, { worklogs: [] }));
      // Binary attachment download
      if (url.includes('/attachment/content/att-png-123')) {
        return Promise.resolve(makeBinaryResponse(PNG_FIXTURE));
      }
      return Promise.resolve(makeErrorResponse(404));
    });

    const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined, mockFetch);
    const bpId = 'bp-att-int-001';
    const repo = new BackupPointRepository(db);
    const writer = new BackupPointManifestWriter(repo, {
      backupPointId: bpId,
      cloudId: CLOUD_ID,
      siteUrl: SITE_URL,
      scopeMode: 'all',
    });

    const config: IssueCaptureConfig = {
      backupPointId: bpId,
      cloudId: CLOUD_ID,
      projectKeys: ['PROJ'],
      backupDir,
      heartbeatIntervalMs: 9000,
    };

    const orchestrator = new IssueCaptureOrchestrator(client, writer, config);
    const result = await orchestrator.run();

    expect(result.totalIssuesCaptured).toBe(1);
    expect(result.totalErrors).toBe(0);

    // Verify attachment was written to blob store
    const blobStore = new AttachmentBlobStore(backupDir);
    const storedBytes = blobStore.readBytes(bpId, 'att-png-123');
    const storedSidecar = blobStore.readSidecar(bpId, 'att-png-123');

    // Byte-identical check
    expect(Buffer.compare(storedBytes, PNG_FIXTURE)).toBe(0);
    expect(storedSidecar.sha256).toBe(PNG_SHA256);

    // Original filename from issue metadata (not Content-Disposition)
    expect(storedSidecar.filename).toBe('original-name.png');
    expect(storedSidecar.mimeType).toBe('image/png');
    expect(storedSidecar.backupPointId).toBe(bpId);
    expect(storedSidecar.issueKey).toBe('PROJ-1');

    console.log(
      `[test-evidence] attachment round-trip: filename=${storedSidecar.filename} ` +
        `mimeType=${storedSidecar.mimeType} sha256=${storedSidecar.sha256.slice(0, 16)}... ` +
        `sizeBytes=${storedSidecar.sizeBytes}`,
    );
  });

  it('records per-attachment failure in manifest without aborting run', async () => {
    const issue = {
      id: 'id-PROJ-2',
      key: 'PROJ-2',
      self: 'https://test.atlassian.net/issue/PROJ-2',
      fields: {
        summary: 'Issue with failing attachment',
        customfield_10020: null,
        issuelinks: [],
        subtasks: [],
        attachment: [
          {
            id: 'att-fail-1',
            filename: 'broken.zip',
            mimeType: 'application/zip',
            size: 999,
            content: 'https://test.atlassian.net/attachment/content/att-fail-1',
            created: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    };

    const mockFetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/rest/api/3/search/jql')) {
        return Promise.resolve(makeJsonResponse(200, { issues: [issue], total: 1 }));
      }
      if (url.includes('/comment')) return Promise.resolve(makeJsonResponse(200, { comments: [], total: 0 }));
      if (url.includes('/watchers')) return Promise.resolve(makeJsonResponse(200, { watchCount: 0, isWatching: false, watchers: [] }));
      if (url.includes('/worklog')) return Promise.resolve(makeJsonResponse(200, { worklogs: [] }));
      // Attachment download fails
      if (url.includes('/attachment/content/')) {
        return Promise.resolve(makeErrorResponse(500));
      }
      return Promise.resolve(makeErrorResponse(404));
    });

    const client = new JiraHttpClient(CLOUD_ID, credRepo, 'jira', undefined, mockFetch);
    const bpId = 'bp-att-err-001';
    const repo = new BackupPointRepository(db);
    const writer = new BackupPointManifestWriter(repo, {
      backupPointId: bpId,
      cloudId: CLOUD_ID,
      siteUrl: SITE_URL,
      scopeMode: 'all',
    });

    const config: IssueCaptureConfig = {
      backupPointId: bpId,
      cloudId: CLOUD_ID,
      projectKeys: ['PROJ'],
      backupDir,
      heartbeatIntervalMs: 9000,
    };

    const orchestrator = new IssueCaptureOrchestrator(client, writer, config);
    const result = await orchestrator.run();

    // Issue itself captured ok; attachment failed — run did not abort
    expect(result.totalIssuesCaptured).toBe(1);
    expect(result.totalErrors).toBe(0); // issue-level error count

    // Attachment error recorded in manifest
    const entries = repo.getEntriesByBackupPoint(bpId);
    const attErrorEntry = entries.find((e) => e.objectId.includes('att-fail-1'));
    expect(attErrorEntry).toBeDefined();
    expect(attErrorEntry!.status).toBe('error');
    expect(attErrorEntry!.errorMessage).toBeDefined();

    console.log(
      `[test-evidence] attachment error entry: ${JSON.stringify(attErrorEntry)}`,
    );
  });
});
