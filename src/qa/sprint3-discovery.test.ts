/**
 * Sprint 3 QA — Project Discovery Integration Tests
 *
 * Coverage:
 *  (a) Multi-page All-projects discovery (3 pages, last page partial) —
 *      every returned project lands in the manifest, reconciliation passes
 *  (b) Selected-projects scope filters correctly — keys param sent, only
 *      returned projects processed
 *  (c) Mixed software/business/service_desk — JSM projects in manifest with
 *      outOfScope flag; onboarding notice present; [jira-discovery] log lines
 *      captured for every jsm-out-of-scope event
 *  (d) Pagination termination on isLast, partial page, and empty page
 *  (e) 429 error propagation (rate-limit path) — error surfaces to caller
 *  Reconciliation assertion: manifestEntries.length === apiReportedTotal
 *
 * Tests use in-memory mocks of the HTTP client — no real network calls.
 */

import { ProjectDiscoveryService } from '../discovery/ProjectDiscoveryService';
import { JiraHttpClient } from '../http/JiraHttpClient';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProject(
  id: string,
  key: string,
  projectTypeKey: 'software' | 'business' | 'service_desk' = 'software',
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

const BACKUP_POINT_ID = 'bp-sprint3-001';

// ── (a) Three-page All-projects discovery ─────────────────────────────────────

describe('Sprint 3 — (a) Three-page All-projects discovery', () => {
  /**
   * 3 pages, last page partial:
   *   Page 1: PROJ1, PROJ2, PROJ3  (full, maxResults=3)
   *   Page 2: PROJ4, PROJ5, PROJ6  (full, maxResults=3)
   *   Page 3: PROJ7               (partial → terminates)
   * API-reported total = 7
   */

  it('paginates all 3 pages, every project lands in manifest, reconciliation passes', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const mockGet = jest.fn()
      .mockResolvedValueOnce({
        values: [makeProject('1', 'PROJ1'), makeProject('2', 'PROJ2'), makeProject('3', 'PROJ3')],
        total: 7,
        isLast: false,
        maxResults: 3,
        startAt: 0,
      })
      .mockResolvedValueOnce({
        values: [makeProject('4', 'PROJ4'), makeProject('5', 'PROJ5'), makeProject('6', 'PROJ6')],
        total: 7,
        isLast: false,
        maxResults: 3,
        startAt: 3,
      })
      .mockResolvedValueOnce({
        values: [makeProject('7', 'PROJ7')],
        total: 7,
        isLast: false,
        maxResults: 3,
        startAt: 6,
      });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    const result = await svc.discoverProjects({ scope: 'all', maxResults: 3 });

    // All 3 pages fetched
    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(result.pagination.pagesFetched).toBe(3);

    // All 7 projects discovered
    expect(result.projects).toHaveLength(7);
    expect(result.projects.map((p) => p.key)).toEqual([
      'PROJ1', 'PROJ2', 'PROJ3', 'PROJ4', 'PROJ5', 'PROJ6', 'PROJ7',
    ]);

    // Zero-silent-omission: every project has a manifest entry
    expect(result.manifestEntries).toHaveLength(7);
    for (const entry of result.manifestEntries) {
      expect(entry.status).toBe('success');
      expect(entry.backupPointId).toBe(BACKUP_POINT_ID);
      expect(entry.phase).toBe('project');
      expect(entry.objectType).toBe('JiraProject');
    }

    // Reconciliation assertion: manifestEntries.length === API-reported total
    expect(result.reconciliation.manifestEntryCount).toBe(result.reconciliation.apiReportedTotal);
    expect(result.reconciliation.reconciled).toBe(true);
    expect(result.reconciliation.gap).toBeUndefined();

    // Pagination reconciliation
    expect(result.pagination.totalFetched).toBe(7);
    expect(result.pagination.apiReportedTotal).toBe(7);
    expect(result.pagination.reconciled).toBe(true);

    // Discovery-complete log line emitted
    const logLines = consoleSpy.mock.calls.map((args) => String(args[0]));
    const completeLog = logLines.find(
      (l) => l.includes('[jira-discovery]') && l.includes('discovery-complete'),
    );
    expect(completeLog).toBeDefined();
    expect(completeLog).toContain('apiReportedTotal=7');
    expect(completeLog).toContain('fetchedCount=7');
    expect(completeLog).toContain('inScope=7');
    expect(completeLog).toContain('reconciled=true');

    // Per-project log lines — one [jira-discovery] project-discovered per project
    const discoveredLines = logLines.filter(
      (l) => l.includes('[jira-discovery]') && l.includes('project-discovered'),
    );
    expect(discoveredLines).toHaveLength(7);

    consoleSpy.mockRestore();
  });

  it('third page URL includes correct startAt offset', async () => {
    const mockGet = jest.fn()
      .mockResolvedValueOnce({
        values: [makeProject('1', 'A'), makeProject('2', 'B'), makeProject('3', 'C')],
        total: 7, isLast: false, maxResults: 3, startAt: 0,
      })
      .mockResolvedValueOnce({
        values: [makeProject('4', 'D'), makeProject('5', 'E'), makeProject('6', 'F')],
        total: 7, isLast: false, maxResults: 3, startAt: 3,
      })
      .mockResolvedValueOnce({
        values: [makeProject('7', 'G')],
        total: 7, isLast: false, maxResults: 3, startAt: 6,
      });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    await svc.discoverProjects({ scope: 'all', maxResults: 3 });

    const thirdCall: string = mockGet.mock.calls[2][0];
    expect(thirdCall).toContain('startAt=6');
    expect(thirdCall).toContain('maxResults=3');
  });
});

// ── (b) Selected-projects scope ───────────────────────────────────────────────

describe('Sprint 3 — (b) Selected-projects scope', () => {
  it('passes keys param and only processes projects the API returns', async () => {
    const mockGet = jest.fn().mockResolvedValueOnce({
      values: [makeProject('10', 'WEB'), makeProject('11', 'MOB'), makeProject('12', 'API')],
      total: 3,
      isLast: true,
      maxResults: 50,
      startAt: 0,
    });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    const result = await svc.discoverProjects({
      scope: 'selected',
      selectedKeys: ['WEB', 'MOB', 'API'],
    });

    // keys param encoded in request URL
    const calledUrl: string = mockGet.mock.calls[0][0];
    expect(calledUrl).toContain('keys=');
    expect(calledUrl).toContain('WEB');
    expect(calledUrl).toContain('MOB');
    expect(calledUrl).toContain('API');

    // All 3 returned projects are in both the pipeline and the manifest
    expect(result.projects).toHaveLength(3);
    expect(result.projects.map((p) => p.key)).toEqual(['WEB', 'MOB', 'API']);
    expect(result.manifestEntries).toHaveLength(3);

    // Reconciliation: manifestEntries.length === API-reported total
    expect(result.reconciliation.manifestEntryCount).toBe(3);
    expect(result.reconciliation.apiReportedTotal).toBe(3);
    expect(result.reconciliation.reconciled).toBe(true);
  });

  it('Selected scope with partial API return — only returned projects in manifest', async () => {
    // Operator selected 5 keys but API returns only 2 (the others may be deleted/inaccessible)
    const mockGet = jest.fn().mockResolvedValueOnce({
      values: [makeProject('1', 'ALIVE1'), makeProject('2', 'ALIVE2')],
      total: 2,
      isLast: true,
      maxResults: 50,
      startAt: 0,
    });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    const result = await svc.discoverProjects({
      scope: 'selected',
      selectedKeys: ['ALIVE1', 'ALIVE2', 'GONE1', 'GONE2', 'GONE3'],
    });

    // Only the 2 API-returned projects appear in the manifest — no phantom entries
    expect(result.projects).toHaveLength(2);
    expect(result.manifestEntries).toHaveLength(2);
    expect(result.reconciliation.manifestEntryCount).toBe(2);
  });

  it('all-scope request does not include keys param', async () => {
    const mockGet = jest.fn().mockResolvedValueOnce({
      values: [], total: 0, isLast: true, maxResults: 50, startAt: 0,
    });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    await svc.discoverProjects({ scope: 'all' });

    const calledUrl: string = mockGet.mock.calls[0][0];
    expect(calledUrl).not.toContain('keys=');
  });
});

// ── (c) Mixed software/business/service_desk — JSM detection ─────────────────

describe('Sprint 3 — (c) Mixed project types with JSM detection', () => {
  /**
   * 3-page run with JSM projects interspersed:
   *   Page 1: PROJ1(software), JSM1(service_desk), PROJ2(business)
   *   Page 2: PROJ3(software), JSM2(service_desk), PROJ4(software)
   *   Page 3: PROJ5(software)  [partial → terminates]
   * Total: 7 API items, 2 JSM, 5 in-scope
   */
  it('every project in manifest, JSM entries have outOfScope:true, onboarding notice present', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const mockGet = jest.fn()
      .mockResolvedValueOnce({
        values: [
          makeProject('1', 'PROJ1', 'software'),
          makeProject('2', 'JSM1', 'service_desk'),
          makeProject('3', 'PROJ2', 'business'),
        ],
        total: 7, isLast: false, maxResults: 3, startAt: 0,
      })
      .mockResolvedValueOnce({
        values: [
          makeProject('4', 'PROJ3', 'software'),
          makeProject('5', 'JSM2', 'service_desk'),
          makeProject('6', 'PROJ4', 'software'),
        ],
        total: 7, isLast: false, maxResults: 3, startAt: 3,
      })
      .mockResolvedValueOnce({
        values: [makeProject('7', 'PROJ5', 'software')],
        total: 7, isLast: false, maxResults: 3, startAt: 6,
      });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    const result = await svc.discoverProjects({ scope: 'all', maxResults: 3 });

    // In-scope pipeline only has non-JSM projects
    expect(result.projects).toHaveLength(5);
    expect(result.jsmProjectsDetected).toBe(2);

    // Zero-silent-omission: ALL 7 API-returned projects in the manifest
    expect(result.manifestEntries).toHaveLength(7);

    // JSM manifest entries
    const jsmEntries = result.manifestEntries.filter((e) => e.outOfScope === true);
    expect(jsmEntries).toHaveLength(2);
    for (const entry of jsmEntries) {
      expect(entry.status).toBe('out_of_scope');
      expect(entry.skipReason).toBe('jsm_out_of_scope');
      expect(entry.reason).toBe('JSM Phase 1 deferred');
      expect(entry.objectType).toBe('JiraProject');
      expect(entry.phase).toBe('project');
    }

    // Onboarding out-of-scope notice (drives JSM banner in ProjectScopeSelector)
    expect(result.jsmNotice).toBeDefined();
    expect(result.jsmNotice!.type).toBe('jsm_out_of_scope');
    expect(result.jsmNotice!.projectCount).toBe(2);
    expect(result.jsmNotice!.projectKeys).toContain('JSM1');
    expect(result.jsmNotice!.projectKeys).toContain('JSM2');
    expect(result.jsmNotice!.message).toContain('Jira Service Management');
    expect(result.jsmNotice!.phase2Note).toContain('Phase 2');

    // Reconciliation: manifestEntries.length (7) === API-reported total (7)
    expect(result.reconciliation.manifestEntryCount).toBe(7);
    expect(result.reconciliation.apiReportedTotal).toBe(7);
    expect(result.reconciliation.reconciled).toBe(true);

    // [jira-discovery] log lines captured
    const logLines = consoleSpy.mock.calls.map((args) => String(args[0]));

    // One jsm-out-of-scope log line per JSM project
    const jsmLogLines = logLines.filter(
      (l) => l.includes('[jira-discovery]') && l.includes('jsm-out-of-scope'),
    );
    expect(jsmLogLines).toHaveLength(2);
    expect(jsmLogLines.some((l) => l.includes('projectKey=JSM1'))).toBe(true);
    expect(jsmLogLines.some((l) => l.includes('projectKey=JSM2'))).toBe(true);

    // discovery-complete log with aggregate counts
    const completeLine = logLines.find(
      (l) => l.includes('[jira-discovery]') && l.includes('discovery-complete'),
    );
    expect(completeLine).toBeDefined();
    expect(completeLine).toContain('inScope=5');
    expect(completeLine).toContain('outOfScope=2');
    expect(completeLine).toContain('reconciled=true');

    consoleSpy.mockRestore();
  });

  it('non-JSM projects have no outOfScope flag', async () => {
    const mockGet = jest.fn().mockResolvedValueOnce({
      values: [
        makeProject('1', 'SW', 'software'),
        makeProject('2', 'BIZ', 'business'),
      ],
      total: 2, isLast: true, maxResults: 50, startAt: 0,
    });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    const result = await svc.discoverProjects({ scope: 'all' });

    expect(result.jsmNotice).toBeUndefined();
    expect(result.jsmProjectsDetected).toBe(0);
    for (const entry of result.manifestEntries) {
      expect(entry.outOfScope).toBeUndefined();
      expect(entry.status).toBe('success');
    }
  });
});

// ── (d) Pagination termination contract ───────────────────────────────────────

describe('Sprint 3 — (d) Pagination termination contract', () => {
  it('terminates on isLast === true (even when page is full)', async () => {
    const mockGet = jest.fn().mockResolvedValueOnce({
      values: [makeProject('1', 'A'), makeProject('2', 'B'), makeProject('3', 'C')],
      total: 3,
      isLast: true,
      maxResults: 3,
      startAt: 0,
    });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    const result = await svc.discoverProjects({ scope: 'all', maxResults: 3 });

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(result.projects).toHaveLength(3);
    expect(result.pagination.pagesFetched).toBe(1);
  });

  it('terminates on partial page (values.length < maxResults)', async () => {
    // Page 1 is full (maxResults=3), page 2 is partial → terminates on page 2
    const mockGet = jest.fn()
      .mockResolvedValueOnce({
        values: [makeProject('1', 'A'), makeProject('2', 'B'), makeProject('3', 'C')],
        total: 5, isLast: false, maxResults: 3, startAt: 0,
      })
      .mockResolvedValueOnce({
        values: [makeProject('4', 'D'), makeProject('5', 'E')],
        total: 5, isLast: false, maxResults: 3, startAt: 3,
      });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    const result = await svc.discoverProjects({ scope: 'all', maxResults: 3 });

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(result.projects).toHaveLength(5);
  });

  it('terminates on empty page (values.length === 0)', async () => {
    // Page 1 has 1 item (with maxResults=1, it is "full"), page 2 is empty → terminates
    const mockGet = jest.fn()
      .mockResolvedValueOnce({
        values: [makeProject('1', 'A')],
        total: 2, isLast: false, maxResults: 1, startAt: 0,
      })
      .mockResolvedValueOnce({
        values: [],
        total: 2, isLast: false, maxResults: 1, startAt: 1,
      });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    const result = await svc.discoverProjects({ scope: 'all', maxResults: 1 });

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(result.projects).toHaveLength(1);
  });

  it('terminates when fetched count reaches apiReportedTotal (defensive guard)', async () => {
    // total=4, maxResults=2 — after page 2 all items collected, no page 3
    const mockGet = jest.fn()
      .mockResolvedValueOnce({
        values: [makeProject('1', 'A'), makeProject('2', 'B')],
        total: 4, isLast: false, maxResults: 2, startAt: 0,
      })
      .mockResolvedValueOnce({
        values: [makeProject('3', 'C'), makeProject('4', 'D')],
        total: 4, isLast: false, maxResults: 2, startAt: 2,
      });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    const result = await svc.discoverProjects({ scope: 'all', maxResults: 2 });

    // Should stop after page 2 (4 fetched === 4 total)
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(result.projects).toHaveLength(4);
  });
});

// ── (e) 429 error propagation ─────────────────────────────────────────────────

describe('Sprint 3 — (e) 429 rate-limit error path', () => {
  it('surfaces 429 error from first page to caller', async () => {
    const mockGet = jest.fn().mockRejectedValueOnce(
      new Error('[jira-http] GET /rest/api/3/project/search?startAt=0&maxResults=50 → 429'),
    );

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    await expect(svc.discoverProjects({ scope: 'all' })).rejects.toThrow('429');
  });

  it('surfaces 429 error from second page to caller (partial discovery scenario)', async () => {
    const mockGet = jest.fn()
      .mockResolvedValueOnce({
        values: [makeProject('1', 'FIRST')],
        total: 5, isLast: false, maxResults: 1, startAt: 0,
      })
      .mockRejectedValueOnce(
        new Error('[jira-http] GET /rest/api/3/project/search?startAt=1&maxResults=1 → 429'),
      );

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    await expect(svc.discoverProjects({ scope: 'all', maxResults: 1 })).rejects.toThrow('429');
  });
});

// ── Reconciliation assertion ───────────────────────────────────────────────────

describe('Sprint 3 — Reconciliation: manifestEntries.length === API-reported total', () => {
  it('passes reconciliation for mixed-type response: every item has exactly one manifest entry', async () => {
    const mockGet = jest.fn().mockResolvedValueOnce({
      values: [
        makeProject('1', 'SW', 'software'),
        makeProject('2', 'JSM', 'service_desk'),
        makeProject('3', 'BIZ', 'business'),
      ],
      total: 3, isLast: true, maxResults: 50, startAt: 0,
    });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    const result = await svc.discoverProjects({ scope: 'all' });

    // Core reconciliation invariant: every API-returned item → exactly one manifest entry
    expect(result.manifestEntries).toHaveLength(3);
    expect(result.reconciliation.manifestEntryCount).toBe(result.reconciliation.apiReportedTotal);
    expect(result.reconciliation.reconciled).toBe(true);

    // Verify manifest IDs cover all API items
    const manifestIds = result.manifestEntries.map((e) => e.id);
    expect(manifestIds).toContain('1');
    expect(manifestIds).toContain('2');
    expect(manifestIds).toContain('3');
  });

  it('reports reconciliation gap when totalFetched < apiReportedTotal', async () => {
    // API claims 10 but isLast:true on 3 items → gap of 7
    const mockGet = jest.fn().mockResolvedValueOnce({
      values: [makeProject('1', 'A'), makeProject('2', 'B'), makeProject('3', 'C')],
      total: 10, isLast: true, maxResults: 50, startAt: 0,
    });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    const result = await svc.discoverProjects({ scope: 'all' });

    expect(result.pagination.reconciled).toBe(false);
    expect(result.pagination.gap).toBe(7);
    expect(result.pagination.totalFetched).toBe(3);
    expect(result.pagination.apiReportedTotal).toBe(10);
  });

  it('3-page mixed run: manifestEntries.length === 7 === apiReportedTotal', async () => {
    const mockGet = jest.fn()
      .mockResolvedValueOnce({
        values: [
          makeProject('1', 'P1', 'software'),
          makeProject('2', 'P2', 'business'),
          makeProject('3', 'J1', 'service_desk'),
        ],
        total: 7, isLast: false, maxResults: 3, startAt: 0,
      })
      .mockResolvedValueOnce({
        values: [
          makeProject('4', 'P3', 'software'),
          makeProject('5', 'J2', 'service_desk'),
          makeProject('6', 'P4', 'business'),
        ],
        total: 7, isLast: false, maxResults: 3, startAt: 3,
      })
      .mockResolvedValueOnce({
        values: [makeProject('7', 'P5', 'software')],
        total: 7, isLast: false, maxResults: 3, startAt: 6,
      });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    const result = await svc.discoverProjects({ scope: 'all', maxResults: 3 });

    // Primary reconciliation assertion
    expect(result.manifestEntries).toHaveLength(7);
    expect(result.reconciliation.apiReportedTotal).toBe(7);
    expect(result.reconciliation.manifestEntryCount).toBe(7);
    expect(result.reconciliation.reconciled).toBe(true);
    expect(result.reconciliation.gap).toBeUndefined();
  });
});

// ── Log-line audit ────────────────────────────────────────────────────────────

describe('Sprint 3 — [jira-discovery] structured log lines', () => {
  it('emits project-discovered log per project with key and type', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const mockGet = jest.fn().mockResolvedValueOnce({
      values: [
        makeProject('1', 'ALPHA', 'software'),
        makeProject('2', 'BETA', 'business'),
        makeProject('3', 'GAMMA', 'service_desk'),
      ],
      total: 3, isLast: true, maxResults: 50, startAt: 0,
    });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    await svc.discoverProjects({ scope: 'all' });

    const logLines = consoleSpy.mock.calls.map((args) => String(args[0]));

    // Per-project discovery log lines
    const projLog = logLines.find(
      (l) => l.includes('[jira-discovery]') && l.includes('project-discovered') && l.includes('projectKey=ALPHA'),
    );
    expect(projLog).toBeDefined();
    expect(projLog).toContain('projectTypeKey=software');

    const bizLog = logLines.find(
      (l) => l.includes('[jira-discovery]') && l.includes('project-discovered') && l.includes('projectKey=BETA'),
    );
    expect(bizLog).toBeDefined();
    expect(bizLog).toContain('projectTypeKey=business');

    // JSM log line (jsm-out-of-scope separate from project-discovered)
    const jsmLog = logLines.find(
      (l) => l.includes('[jira-discovery]') && l.includes('jsm-out-of-scope') && l.includes('projectKey=GAMMA'),
    );
    expect(jsmLog).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('discovery-complete log contains all aggregate counters', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const mockGet = jest.fn().mockResolvedValueOnce({
      values: [
        makeProject('1', 'SW', 'software'),
        makeProject('2', 'JSM', 'service_desk'),
      ],
      total: 2, isLast: true, maxResults: 50, startAt: 0,
    });

    const svc = new ProjectDiscoveryService(makeClient(mockGet), BACKUP_POINT_ID);
    await svc.discoverProjects({ scope: 'all' });

    const logLines = consoleSpy.mock.calls.map((args) => String(args[0]));
    const completeLine = logLines.find(
      (l) => l.includes('[jira-discovery]') && l.includes('discovery-complete'),
    );

    expect(completeLine).toBeDefined();
    expect(completeLine).toContain('apiReportedTotal=2');
    expect(completeLine).toContain('fetchedCount=2');
    expect(completeLine).toContain('inScope=1');
    expect(completeLine).toContain('outOfScope=1');
    expect(completeLine).toContain('reconciled=true');

    consoleSpy.mockRestore();
  });
});
