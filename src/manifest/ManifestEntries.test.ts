/**
 * Tests for manifest_entries table, append() API, ManifestOmissionError,
 * and getEntriesByBackupPoint() query helper.
 *
 * Execution evidence: console.log lines emitted by append() are captured
 * by jest spies and asserted in the happy-path test.
 */

import Database from 'better-sqlite3';
import {
  BackupPointManifestWriter,
  ManifestOmissionError,
} from './BackupPointManifestWriter';
import { BackupPointRepository } from './BackupPointRepository';
import { SimpleManifestEntry } from './types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  BackupPointRepository.migrate(db); // runs 003 + 005
  return db;
}

function makeRepo(db: Database.Database): BackupPointRepository {
  return new BackupPointRepository(db);
}

function makeWriter(
  repo: BackupPointRepository,
  id = 'bp-entries-001',
): BackupPointManifestWriter {
  return new BackupPointManifestWriter(repo, {
    backupPointId: id,
    cloudId: 'cloud-abc',
    siteUrl: 'https://test.atlassian.net',
    scopeMode: 'all',
  });
}

function makeEntry(
  overrides: Partial<SimpleManifestEntry> = {},
): SimpleManifestEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2)}`,
    backupPointId: 'bp-entries-001',
    objectType: 'JiraIssue',
    objectId: 'PROJ-1',
    capturedAt: Date.now(),
    sourceEndpoint: '/rest/api/3/search/jql',
    status: 'ok',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('manifest_entries table + append() API', () => {
  describe('append() happy path', () => {
    it('persists an ok entry to manifest_entries table', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo);

      const entry = makeEntry({ objectId: 'PROJ-42', status: 'ok' });
      writer.append(entry);

      const stored = repo.getEntriesByBackupPoint('bp-entries-001');
      expect(stored).toHaveLength(1);
      expect(stored[0].objectId).toBe('PROJ-42');
      expect(stored[0].objectType).toBe('JiraIssue');
      expect(stored[0].status).toBe('ok');
      expect(stored[0].backupPointId).toBe('bp-entries-001');
      expect(stored[0].sourceEndpoint).toBe('/rest/api/3/search/jql');
    });

    it('emits a structured log line for execution evidence', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo);

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const entry = makeEntry({ objectId: 'PROJ-99', status: 'ok' });
      writer.append(entry);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('[jira-manifest] append'),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('objectId=PROJ-99'),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('status=ok'),
      );

      logSpy.mockRestore();
    });

    it('persists multiple entries and returns them ordered by capturedAt', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo);

      const now = Date.now();
      writer.append(makeEntry({ objectId: 'PROJ-1', capturedAt: now + 0 }));
      writer.append(makeEntry({ objectId: 'PROJ-2', capturedAt: now + 100 }));
      writer.append(makeEntry({ objectId: 'PROJ-3', capturedAt: now + 200 }));

      const stored = repo.getEntriesByBackupPoint('bp-entries-001');
      expect(stored).toHaveLength(3);
      expect(stored.map((e) => e.objectId)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
    });
  });

  describe('append() error entries', () => {
    it('persists an error entry with errorMessage', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo);

      const entry = makeEntry({
        objectId: 'PROJ-ERR',
        status: 'error',
        errorMessage: 'HTTP 403 Forbidden',
      });
      writer.append(entry);

      const stored = repo.getEntriesByBackupPoint('bp-entries-001');
      expect(stored).toHaveLength(1);
      expect(stored[0].status).toBe('error');
      expect(stored[0].errorMessage).toBe('HTTP 403 Forbidden');
    });

    it('includes errorMessage in the log line for error entries', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo);

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      writer.append(
        makeEntry({ status: 'error', errorMessage: 'rate-limited' }),
      );

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('error=rate-limited'),
      );

      logSpy.mockRestore();
    });
  });

  describe('getEntriesByBackupPoint()', () => {
    it('returns empty array for unknown backup point', () => {
      const db = makeDb();
      const repo = makeRepo(db);

      const result = repo.getEntriesByBackupPoint('nonexistent');
      expect(result).toEqual([]);
    });

    it('returns only entries for the requested backup point', () => {
      const db = makeDb();
      const repo = makeRepo(db);

      // Two writers with different backup-point IDs
      const writerA = new BackupPointManifestWriter(repo, {
        backupPointId: 'bp-A',
        cloudId: 'c1',
        siteUrl: 'https://a.atlassian.net',
        scopeMode: 'all',
      });
      const writerB = new BackupPointManifestWriter(repo, {
        backupPointId: 'bp-B',
        cloudId: 'c1',
        siteUrl: 'https://a.atlassian.net',
        scopeMode: 'all',
      });

      writerA.append({ ...makeEntry(), backupPointId: 'bp-A', objectId: 'A-1' });
      writerA.append({ ...makeEntry(), backupPointId: 'bp-A', objectId: 'A-2' });
      writerB.append({ ...makeEntry(), backupPointId: 'bp-B', objectId: 'B-1' });

      expect(repo.getEntriesByBackupPoint('bp-A')).toHaveLength(2);
      expect(repo.getEntriesByBackupPoint('bp-B')).toHaveLength(1);
      expect(repo.getEntriesByBackupPoint('bp-B')[0].objectId).toBe('B-1');
    });

    it('round-trips all fields including capturedAt as epoch ms', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo);

      const capturedAt = 1746270000000; // fixed epoch ms
      writer.append(
        makeEntry({ capturedAt, objectId: 'RT-1', sourceEndpoint: '/custom/endpoint' }),
      );

      const stored = repo.getEntriesByBackupPoint('bp-entries-001');
      expect(stored[0].capturedAt).toBe(capturedAt);
      expect(stored[0].sourceEndpoint).toBe('/custom/endpoint');
    });
  });
});

describe('ManifestOmissionError + finalize(discoveredCounts)', () => {
  describe('happy path — counts match', () => {
    it('does not throw when captured ok count equals discovered count', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo);

      writer.append(makeEntry({ objectId: 'PROJ-1', status: 'ok' }));
      writer.append(makeEntry({ objectId: 'PROJ-2', status: 'ok' }));
      writer.append(makeEntry({ objectId: 'PROJ-3', status: 'ok' }));

      expect(() =>
        writer.finalize('completed', { JiraIssue: 3 }),
      ).not.toThrow();

      console.log('[test-evidence] finalize completed with 3 JiraIssue entries, no omissions');
    });

    it('ignores error entries when checking omission (only ok entries count)', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo);

      writer.append(makeEntry({ objectId: 'PROJ-1', status: 'ok' }));
      writer.append(makeEntry({ objectId: 'PROJ-2', status: 'ok' }));
      // PROJ-3 errored — not counted toward captured ok
      writer.append(makeEntry({ objectId: 'PROJ-3', status: 'error' }));

      // discoveredCounts = 2 ok; 2 ok entries present → no throw
      expect(() =>
        writer.finalize('completed_with_errors', { JiraIssue: 2 }),
      ).not.toThrow();
    });

    it('passes when discoveredCounts is not provided (backward compat)', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo);

      writer.append(makeEntry({ status: 'ok' }));
      expect(() => writer.finalize('completed')).not.toThrow();
    });
  });

  describe('error path — omission detected', () => {
    it('throws ManifestOmissionError when captured < discovered', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo);

      // Only 2 ok entries but discovered said 5
      writer.append(makeEntry({ objectId: 'PROJ-1', status: 'ok' }));
      writer.append(makeEntry({ objectId: 'PROJ-2', status: 'ok' }));

      expect(() =>
        writer.finalize('completed', { JiraIssue: 5 }),
      ).toThrow(ManifestOmissionError);
    });

    it('ManifestOmissionError carries objectType, discoveredCount, capturedCount', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo);

      writer.append(makeEntry({ objectId: 'PROJ-1', status: 'ok' }));
      // discoveredCount = 3, capturedCount = 1 → mismatch

      let caught: ManifestOmissionError | undefined;
      try {
        writer.finalize('completed', { JiraIssue: 3 });
      } catch (err) {
        caught = err as ManifestOmissionError;
      }

      expect(caught).toBeDefined();
      expect(caught!.objectType).toBe('JiraIssue');
      expect(caught!.discoveredCount).toBe(3);
      expect(caught!.capturedCount).toBe(1);
      expect(caught!.message).toContain('ManifestOmissionError');
      expect(caught!.message).toContain("'JiraIssue'");

      console.log(`[test-evidence] ManifestOmissionError: ${caught!.message}`);
    });

    it('checks all objectTypes and throws on first mismatch', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo);

      writer.append(makeEntry({ objectType: 'JiraIssue', status: 'ok' }));
      writer.append(
        makeEntry({ objectType: 'JiraProject', status: 'ok', objectId: 'PROJ' }),
      );

      // JiraIssue: 1 ok, expected 1 → pass
      // JiraSprint: 0 ok, expected 2 → fail
      expect(() =>
        writer.finalize('completed', { JiraIssue: 1, JiraSprint: 2 }),
      ).toThrow(ManifestOmissionError);
    });
  });

  describe('ManifestOmissionError class', () => {
    it('has correct name and is instanceof Error', () => {
      const err = new ManifestOmissionError('JiraIssue', 5, 3);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ManifestOmissionError');
      expect(err.objectType).toBe('JiraIssue');
      expect(err.discoveredCount).toBe(5);
      expect(err.capturedCount).toBe(3);
    });
  });
});
