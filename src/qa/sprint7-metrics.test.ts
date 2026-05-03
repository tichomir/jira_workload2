/**
 * Sprint 7 QA: Structured logs and metrics for pagination and manifest emission.
 *
 * Verifies:
 *   - [jira-backup] page_fetched log emitted per page
 *   - [jira-backup] pagination_terminated log emitted at termination
 *   - [jira-backup] manifest_written log emitted per appendStageSection call
 *   - Counters jira_backup_manifest_writes_total,
 *     jira_backup_pagination_terminations_total{reason},
 *     jira_backup_pages_fetched_total{endpoint} increment correctly.
 */

import Database from 'better-sqlite3';
import { paginateAtlassian, AtlassianPage } from '../pagination/paginateAtlassian';
import { backupMetrics } from '../metrics/BackupMetrics';
import { BackupPointManifestWriter } from '../manifest/BackupPointManifestWriter';
import { BackupPointRepository } from '../manifest/BackupPointRepository';
import { ManifestStageSection, ManifestEntry, CapturePhase } from '../manifest/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  BackupPointRepository.migrate(db);
  return db;
}

function collectLogs(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(' '));
    origLog(...args);
  };
  return fn().then(
    () => { console.log = origLog; return logs; },
    (err) => { console.log = origLog; throw err; },
  );
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('Sprint 7 — structured logs and metrics', () => {
  beforeEach(() => {
    backupMetrics.reset();
  });

  // ── paginateAtlassian ──────────────────────────────────────────────────────

  describe('paginateAtlassian', () => {
    it('emits page_fetched log for every page', async () => {
      const endpoint = '/rest/api/3/project/search';
      // Two pages: first has 2 items (full), second has 1 item (short → terminates)
      let call = 0;
      const fetchPage = async (): Promise<AtlassianPage<{ id: string }>> => {
        call++;
        if (call === 1) return { values: [{ id: 'P1' }, { id: 'P2' }], total: 3 };
        return { values: [{ id: 'P3' }], total: 3 };
      };

      const logs = await collectLogs(async () => {
        await paginateAtlassian(fetchPage, 2, { endpoint });
      });

      const pageFetchedLogs = logs.filter((l) => l.includes('[jira-backup] page_fetched'));
      expect(pageFetchedLogs).toHaveLength(2);
      expect(pageFetchedLogs[0]).toContain(`endpoint=${endpoint}`);
      expect(pageFetchedLogs[0]).toContain('pageIndex=0');
      expect(pageFetchedLogs[0]).toContain('itemsInPage=2');
      expect(pageFetchedLogs[1]).toContain('pageIndex=1');
      expect(pageFetchedLogs[1]).toContain('itemsInPage=1');
    });

    it('emits pagination_terminated log with reason=short_page on partial page', async () => {
      const endpoint = '/rest/api/3/project/search';
      let call = 0;
      const fetchPage = async (): Promise<AtlassianPage<{ id: string }>> => {
        call++;
        if (call === 1) return { values: [{ id: 'P1' }, { id: 'P2' }], total: 3 };
        return { values: [{ id: 'P3' }], total: 3 }; // short page
      };

      const logs = await collectLogs(async () => {
        await paginateAtlassian(fetchPage, 2, { endpoint });
      });

      const termLog = logs.find((l) => l.includes('[jira-backup] pagination_terminated'));
      expect(termLog).toBeDefined();
      expect(termLog).toContain('reason=short_page');
      expect(termLog).toContain(`endpoint=${endpoint}`);
      expect(termLog).toContain('pageCount=2');
      expect(termLog).toContain('totalItems=3');
    });

    it('emits pagination_terminated with reason=empty_page on empty response', async () => {
      const endpoint = '/rest/api/3/field';
      const fetchPage = async (): Promise<AtlassianPage<{ id: string }>> => ({
        values: [],
        total: 0,
      });

      const logs = await collectLogs(async () => {
        await paginateAtlassian(fetchPage, 50, { endpoint });
      });

      const termLog = logs.find((l) => l.includes('[jira-backup] pagination_terminated'));
      expect(termLog).toBeDefined();
      expect(termLog).toContain('reason=empty_page');
    });

    it('increments jira_backup_pages_fetched_total per page', async () => {
      const endpoint = '/rest/api/3/issue/type';
      let call = 0;
      const fetchPage = async (): Promise<AtlassianPage<{ id: string }>> => {
        call++;
        if (call === 1) return { values: [{ id: 'T1' }, { id: 'T2' }] };
        return { values: [] };
      };

      await paginateAtlassian(fetchPage, 2, { endpoint });

      // 2 pages fetched (page 1 full, page 2 empty terminates)
      expect(backupMetrics.jira_backup_pages_fetched_total[endpoint]).toBe(2);
    });

    it('increments jira_backup_pagination_terminations_total{reason}', async () => {
      const endpoint = '/rest/api/3/workflow/search';
      const fetchPage = async (): Promise<AtlassianPage<{ id: string }>> => ({
        values: [{ id: 'W1' }],
        total: 1, // one item returned == maxResults? No, maxResults=50 so this is short_page
      });

      await paginateAtlassian(fetchPage, 50, { endpoint });

      expect(
        backupMetrics.jira_backup_pagination_terminations_total['short_page'],
      ).toBe(1);
    });

    it('uses "unknown" as endpoint label when option omitted', async () => {
      const fetchPage = async (): Promise<AtlassianPage<{ id: string }>> => ({
        values: [],
      });

      const logs = await collectLogs(async () => {
        await paginateAtlassian(fetchPage);
      });

      const pageFetchedLog = logs.find((l) => l.includes('[jira-backup] page_fetched'));
      expect(pageFetchedLog).toContain('endpoint=unknown');
    });
  });

  // ── BackupPointManifestWriter ────────────────────────────────────────────────

  describe('BackupPointManifestWriter.appendStageSection', () => {
    it('emits [jira-backup] manifest_written log per stage written', () => {
      const db = openDb();
      const repo = new BackupPointRepository(db);
      const writer = new BackupPointManifestWriter(repo, {
        backupPointId: 'bp-metrics-001',
        cloudId: 'cloud-test',
        siteUrl: 'https://test.atlassian.net',
        scopeMode: 'all',
      });

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.join(' '));
        origLog(...args);
      };

      try {
        const section: ManifestStageSection = {
          stageName: 'project' as CapturePhase,
          apiPageCount: 1,
          apiTotalReported: 2,
          capturedCount: 2,
          skippedIds: [],
          skippedReasons: {},
        };
        writer.appendStageSection(section, []);
      } finally {
        console.log = origLog;
        db.close();
      }

      const manifestLog = logs.find((l) => l.includes('[jira-backup] manifest_written'));
      expect(manifestLog).toBeDefined();
      expect(manifestLog).toContain('backupPointId=bp-metrics-001');
      expect(manifestLog).toContain('objectType=JiraProject');
      expect(manifestLog).toContain('count=2');
    });

    it('increments jira_backup_manifest_writes_total per appendStageSection', () => {
      const db = openDb();
      const repo = new BackupPointRepository(db);
      const writer = new BackupPointManifestWriter(repo, {
        backupPointId: 'bp-metrics-002',
        cloudId: 'cloud-test',
        siteUrl: 'https://test.atlassian.net',
        scopeMode: 'all',
      });

      const section1: ManifestStageSection = {
        stageName: 'issue_type' as CapturePhase,
        apiPageCount: 1,
        apiTotalReported: 3,
        capturedCount: 3,
        skippedIds: [],
        skippedReasons: {},
      };
      const section2: ManifestStageSection = {
        stageName: 'custom_field' as CapturePhase,
        apiPageCount: 1,
        apiTotalReported: 5,
        capturedCount: 5,
        skippedIds: [],
        skippedReasons: {},
      };

      writer.appendStageSection(section1, []);
      writer.appendStageSection(section2, []);

      expect(backupMetrics.jira_backup_manifest_writes_total).toBe(2);
      db.close();
    });
  });
});
