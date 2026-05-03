/**
 * Tests for ProjectDiscoveryService.
 *
 * Covers:
 *  - Happy-path multi-page discovery (all scope)
 *  - Selected-projects scope filter
 *  - Pagination termination: empty page, isLast, partial page
 *  - HTTP 429 (rate-limit) error path
 *  - Empty result set
 *  - JSM (service_desk) project detection and out-of-scope manifest entries
 *  - Reconciliation log and zero-silent-omission guarantee
 */

import { ProjectDiscoveryService } from './ProjectDiscoveryService';
import { JiraHttpClient } from '../http/JiraHttpClient';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProject(
  id: string,
  key: string,
  projectTypeKey = 'software',
  archived = false,
) {
  return {
    id,
    key,
    name: `Project ${key}`,
    projectTypeKey,
    self: `https://api.atlassian.com/ex/jira/test-cloud/${key}`,
    archived,
    lead: { accountId: `acc-${id}` },
    style: 'classic',
  };
}

function makeClient(mockGet: jest.Mock): JiraHttpClient {
  const client = new JiraHttpClient(
    'test-cloud',
    {} as JiraCredentialRepository,
    'jira',
    undefined,
    jest.fn(),
  );
  (client as unknown as { get: jest.Mock }).get = mockGet;
  return client;
}

const BACKUP_POINT_ID = 'bp-test-001';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ProjectDiscoveryService', () => {
  describe('all-scope happy path — multi-page', () => {
    it('paginates across two full pages and terminates on partial page', async () => {
      // Page 1: 3 projects (full page of maxResults=3)
      // Page 2: 2 projects (partial page → terminates)
      const mockGet = jest.fn()
        .mockResolvedValueOnce({
          values: [makeProject('1', 'ALPHA'), makeProject('2', 'BETA'), makeProject('3', 'GAMMA')],
          total: 5,
          isLast: false,
          maxResults: 3,
          startAt: 0,
        })
        .mockResolvedValueOnce({
          values: [makeProject('4', 'DELTA'), makeProject('5', 'EPSILON')],
          total: 5,
          isLast: false,
          maxResults: 3,
          startAt: 3,
        });

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
      const result = await svc.discoverProjects({ scope: 'all', maxResults: 3 });

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(result.projects).toHaveLength(5);
      expect(result.projects.map((p) => p.key)).toEqual(['ALPHA', 'BETA', 'GAMMA', 'DELTA', 'EPSILON']);
      expect(result.manifestEntries).toHaveLength(5);
      expect(result.manifestEntries.every((e) => e.status === 'success')).toBe(true);
      expect(result.pagination.totalFetched).toBe(5);
      expect(result.pagination.apiReportedTotal).toBe(5);
      expect(result.pagination.reconciled).toBe(true);
      expect(result.pagination.pagesFetched).toBe(2);
    });

    it('terminates on isLast === true even when page is full', async () => {
      const mockGet = jest.fn().mockResolvedValueOnce({
        values: [makeProject('1', 'ONLY'), makeProject('2', 'LAST')],
        total: 2,
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
      const result = await svc.discoverProjects({ scope: 'all' });

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.projects).toHaveLength(2);
    });

    it('terminates on empty values array', async () => {
      // Use maxResults=1 so the first page (1 item) is "full" and pagination
      // continues, then terminates when the second page returns an empty array.
      const mockGet = jest.fn()
        .mockResolvedValueOnce({
          values: [makeProject('1', 'FIRST')],
          total: 2,
          isLast: false,
          maxResults: 1,
          startAt: 0,
        })
        .mockResolvedValueOnce({
          values: [],
          total: 2,
          isLast: false,
          maxResults: 1,
          startAt: 1,
        });

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
      const result = await svc.discoverProjects({ scope: 'all', maxResults: 1 });

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(result.projects).toHaveLength(1);
    });
  });

  describe('empty result', () => {
    it('returns empty arrays and reconciled=true when no projects exist', async () => {
      const mockGet = jest.fn().mockResolvedValueOnce({
        values: [],
        total: 0,
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
      const result = await svc.discoverProjects({ scope: 'all' });

      expect(result.projects).toHaveLength(0);
      expect(result.manifestEntries).toHaveLength(0);
      expect(result.pagination.totalFetched).toBe(0);
      expect(result.pagination.reconciled).toBe(true);
      expect(result.jsmNotice).toBeUndefined();
    });
  });

  describe('selected-projects scope', () => {
    it('passes keys query parameter and only processes returned projects', async () => {
      const mockGet = jest.fn().mockResolvedValueOnce({
        values: [makeProject('10', 'WEB'), makeProject('11', 'MOB')],
        total: 2,
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
      const result = await svc.discoverProjects({
        scope: 'selected',
        selectedKeys: ['WEB', 'MOB'],
      });

      // Verify the keys param was included in the URL
      const calledUrl: string = mockGet.mock.calls[0][0];
      expect(calledUrl).toContain('keys=WEB%2CMOB');

      expect(result.projects).toHaveLength(2);
      expect(result.projects.map((p) => p.key)).toEqual(['WEB', 'MOB']);
    });

    it('makes no keys query param when scope is all', async () => {
      const mockGet = jest.fn().mockResolvedValueOnce({
        values: [],
        total: 0,
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
      await svc.discoverProjects({ scope: 'all' });

      const calledUrl: string = mockGet.mock.calls[0][0];
      expect(calledUrl).not.toContain('keys=');
    });
  });

  describe('JSM detection', () => {
    it('emits out_of_scope manifest entry with outOfScope:true and reason for service_desk projects', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const mockGet = jest.fn().mockResolvedValueOnce({
        values: [
          makeProject('1', 'SW', 'software'),
          makeProject('2', 'JSM', 'service_desk'),
          makeProject('3', 'BIZ', 'business'),
        ],
        total: 3,
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
      const result = await svc.discoverProjects({ scope: 'all' });

      // Only non-JSM projects in the pipeline
      expect(result.projects).toHaveLength(2);
      expect(result.projects.map((p) => p.key)).toEqual(['SW', 'BIZ']);

      // All 3 API-returned projects have a manifest entry (zero-silent-omission)
      expect(result.manifestEntries).toHaveLength(3);
      const jsmEntry = result.manifestEntries.find((e) => e.key === 'JSM');
      expect(jsmEntry).toBeDefined();
      expect(jsmEntry!.status).toBe('out_of_scope');
      expect(jsmEntry!.skipReason).toBe('jsm_out_of_scope');
      expect(jsmEntry!.outOfScope).toBe(true);
      expect(jsmEntry!.reason).toBe('JSM Phase 1 deferred');
      expect(jsmEntry!.phase).toBe('project');
      expect(jsmEntry!.objectType).toBe('JiraProject');

      // JSM notice and aggregate count
      expect(result.jsmNotice).toBeDefined();
      expect(result.jsmNotice!.type).toBe('jsm_out_of_scope');
      expect(result.jsmNotice!.projectCount).toBe(1);
      expect(result.jsmNotice!.projectKeys).toEqual(['JSM']);
      expect(result.jsmProjectsDetected).toBe(1);

      // Per-project log line
      const jsmLogLine = consoleSpy.mock.calls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('[jira-discovery] jsm-out-of-scope') && args[0].includes('projectKey=JSM'),
      );
      expect(jsmLogLine).toBeDefined();

      consoleSpy.mockRestore();
    });

    it('software and business projects are not tagged outOfScope', async () => {
      const mockGet = jest.fn().mockResolvedValueOnce({
        values: [
          makeProject('1', 'SW', 'software'),
          makeProject('2', 'BIZ', 'business'),
        ],
        total: 2,
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
      const result = await svc.discoverProjects({ scope: 'all' });

      expect(result.projects).toHaveLength(2);
      expect(result.jsmProjectsDetected).toBe(0);
      result.manifestEntries.forEach((e) => {
        expect(e.outOfScope).toBeUndefined();
        expect(e.status).toBe('success');
      });
    });

    it('does not emit jsmNotice when no service_desk projects exist', async () => {
      const mockGet = jest.fn().mockResolvedValueOnce({
        values: [makeProject('1', 'SW', 'software')],
        total: 1,
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
      const result = await svc.discoverProjects({ scope: 'all' });

      expect(result.jsmNotice).toBeUndefined();
      expect(result.jsmProjectsDetected).toBe(0);
    });

    it('handles multiple service_desk projects and emits one log line per JSM project', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const mockGet = jest.fn().mockResolvedValueOnce({
        values: [
          makeProject('1', 'JSM1', 'service_desk'),
          makeProject('2', 'JSM2', 'service_desk'),
          makeProject('3', 'SW', 'software'),
        ],
        total: 3,
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
      const result = await svc.discoverProjects({ scope: 'all' });

      expect(result.jsmProjectsDetected).toBe(2);
      expect(result.projects).toHaveLength(1);

      const jsmLogLines = consoleSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('[jira-discovery] jsm-out-of-scope'),
      );
      expect(jsmLogLines).toHaveLength(2);

      consoleSpy.mockRestore();
    });
  });

  describe('error paths', () => {
    it('propagates HTTP 429 error thrown by the HTTP client', async () => {
      const mockGet = jest.fn().mockRejectedValueOnce(
        new Error('[jira-http] GET /rest/api/3/project/search?startAt=0&maxResults=50 → 429'),
      );

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);

      await expect(
        svc.discoverProjects({ scope: 'all' }),
      ).rejects.toThrow('429');
    });

    it('propagates network error from HTTP client', async () => {
      const mockGet = jest.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);

      await expect(
        svc.discoverProjects({ scope: 'all' }),
      ).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('manifest integrity — zero-silent-omission', () => {
    it('writes exactly one ManifestEntry per API-returned project', async () => {
      const mockGet = jest.fn().mockResolvedValueOnce({
        values: [
          makeProject('1', 'A', 'software'),
          makeProject('2', 'B', 'service_desk'),
          makeProject('3', 'C', 'business'),
        ],
        total: 3,
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
      const result = await svc.discoverProjects({ scope: 'all' });

      expect(result.manifestEntries).toHaveLength(3);
      const ids = result.manifestEntries.map((e) => e.id);
      expect(ids).toContain('1');
      expect(ids).toContain('2');
      expect(ids).toContain('3');
    });

    it('records backupPointId on every manifest entry', async () => {
      const mockGet = jest.fn().mockResolvedValueOnce({
        values: [makeProject('42', 'PROJ')],
        total: 1,
        isLast: true,
        maxResults: 50,
        startAt: 0,
      });

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
      const result = await svc.discoverProjects({ scope: 'all' });

      expect(result.manifestEntries[0].backupPointId).toBe(BACKUP_POINT_ID);
    });

    it('reports reconciliation gap when totalFetched < apiReportedTotal', async () => {
      // API says 5 but we only get 3 (simulating a gap scenario)
      const mockGet = jest.fn().mockResolvedValueOnce({
        values: [makeProject('1', 'A'), makeProject('2', 'B'), makeProject('3', 'C')],
        total: 5,
        isLast: true, // force termination even though gap exists
        maxResults: 50,
        startAt: 0,
      });

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
      const result = await svc.discoverProjects({ scope: 'all' });

      expect(result.pagination.reconciled).toBe(false);
      expect(result.pagination.gap).toBe(2);
      expect(result.pagination.apiReportedTotal).toBe(5);
      expect(result.pagination.totalFetched).toBe(3);
    });
  });

  describe('pagination termination contract', () => {
    it('terminates when values.length < maxResults (partial page)', async () => {
      // Page with 2 items when maxResults is 50 — should stop
      const mockGet = jest.fn().mockResolvedValueOnce({
        values: [makeProject('1', 'X'), makeProject('2', 'Y')],
        total: 2,
        isLast: false,
        maxResults: 50,
        startAt: 0,
      });

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
      const result = await svc.discoverProjects({ scope: 'all' });

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.projects).toHaveLength(2);
    });

    it('terminates when startAt >= total (defensive guard)', async () => {
      // 3 pages of 2 each, total=4 → third call should not happen
      const mockGet = jest.fn()
        .mockResolvedValueOnce({
          values: [makeProject('1', 'A'), makeProject('2', 'B')],
          total: 4,
          isLast: false,
          maxResults: 2,
          startAt: 0,
        })
        .mockResolvedValueOnce({
          values: [makeProject('3', 'C'), makeProject('4', 'D')],
          total: 4,
          isLast: false,
          maxResults: 2,
          startAt: 2,
        });

      const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
      const result = await svc.discoverProjects({ scope: 'all', maxResults: 2 });

      // After page 2: items.length (4) >= apiReportedTotal (4) → stops
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(result.projects).toHaveLength(4);
    });
  });
});
