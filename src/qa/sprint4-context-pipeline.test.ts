/**
 * Sprint 4 QA — Context Pipeline Integration Tests
 *
 * Coverage:
 *  (1) Stage execution order — strict call-sequence spy; reordering fails this test
 *  (2) Custom-field context gate — /field/{id}/context invoked ONLY for custom:true
 *      fields; zero calls for system fields verified via mock spy
 *  (3) Zero-silent-omission — when total=50 but 48 captured and 0 skipped,
 *      ManifestIntegrityError is raised and backup-point status = 'completed_with_errors'
 *  (4) Pagination termination — tested for all three conditions:
 *        (a) isLast === true
 *        (b) partial page (values.length < maxResults)
 *        (c) empty page (values.length === 0)
 *  (5) Stage failure halts pipeline and emits named diagnostic
 *
 * All tests run against in-memory mocks of the HTTP client — no real network calls.
 */

import Database from 'better-sqlite3';
import { ContextNodeCaptureOrchestrator, ProgressEvent } from '../capture/ContextNodeCaptureOrchestrator';
import { JiraHttpClient } from '../http/JiraHttpClient';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';
import {
  BackupPointManifestWriter,
  ManifestIntegrityError,
} from '../manifest/BackupPointManifestWriter';
import { BackupPointRepository } from '../manifest/BackupPointRepository';
import { paginateAtlassian } from '../pagination/paginateAtlassian';
import { ManifestStageSection } from '../manifest/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  BackupPointRepository.migrate(db);
  return db;
}

function makeRepo(db: Database.Database): BackupPointRepository {
  return new BackupPointRepository(db);
}

function makeWriter(
  repo: BackupPointRepository,
  id = 'bp-sprint4-001',
): BackupPointManifestWriter {
  return new BackupPointManifestWriter(repo, {
    backupPointId: id,
    cloudId: 'cloud-sprint4',
    siteUrl: 'https://sprint4test.atlassian.net',
    scopeMode: 'all',
  });
}

function makeSection(
  stageName: ManifestStageSection['stageName'],
  capturedCount: number,
  skippedIds: string[] = [],
  apiTotalReported: number | null = null,
): ManifestStageSection {
  return {
    stageName,
    apiPageCount: 1,
    apiTotalReported:
      apiTotalReported ?? capturedCount + skippedIds.length,
    capturedCount,
    skippedIds,
    skippedReasons: Object.fromEntries(
      skippedIds.map((id) => [id, 'system_field']),
    ),
  };
}

const BACKUP_POINT_ID = 'bp-sprint4-001';
const PROJECTS = [{ id: 'proj-1', key: 'PROJ' }];

// ── Full-run mock builder ─────────────────────────────────────────────────────

function buildDefaultMockGet(): jest.Mock {
  return jest.fn().mockImplementation((path: string) => {
    if (path === '/rest/api/3/issuetype') {
      return Promise.resolve([
        { id: '1', name: 'Bug', subtask: false, self: 'https://example.com' },
      ]);
    }
    if (path === '/rest/api/3/field') {
      return Promise.resolve([
        { id: 'summary', name: 'Summary', custom: false },
        { id: 'customfield_10001', name: 'Story Points', custom: true },
      ]);
    }
    if (path.startsWith('/rest/api/3/field/') && path.includes('/context')) {
      return Promise.resolve({
        values: [{ id: 'ctx-1', name: 'Default', isGlobalContext: true, isAnyIssueType: true }],
        total: 1,
        isLast: true,
      });
    }
    if (path.startsWith('/rest/api/3/fieldconfiguration')) {
      return Promise.resolve({ values: [{ id: 1, name: 'Default FC' }], total: 1, isLast: true });
    }
    if (path.startsWith('/rest/api/3/workflow/search')) {
      return Promise.resolve({ values: [{ id: { name: 'Software Workflow' } }], total: 1, isLast: true });
    }
    if (path.startsWith('/rest/api/3/workflowscheme')) {
      return Promise.resolve({ values: [{ id: 1, name: 'Default WF Scheme' }], total: 1, isLast: true });
    }
    if (path.startsWith('/rest/agile/1.0/board') && !path.includes('/sprint')) {
      return Promise.resolve({ values: [{ id: 100, name: 'PROJ board', type: 'scrum' }], total: 1, isLast: true });
    }
    if (path.startsWith('/rest/agile/1.0/board/') && path.includes('/sprint')) {
      return Promise.resolve({ values: [{ id: 10, name: 'Sprint 1', state: 'active' }], total: 1, isLast: true });
    }
    throw new Error(`Unexpected path in mock: ${path}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) Stage execution order
// ─────────────────────────────────────────────────────────────────────────────

describe('Sprint 4 — (1) Stage execution order', () => {
  it('executes all 7 stages in the strict dependency order via call-sequence spy', async () => {
    const callSequence: string[] = [];

    const mockGet = jest.fn().mockImplementation((path: string) => {
      if (path === '/rest/api/3/issuetype') {
        callSequence.push('issuetype');
        return Promise.resolve([
          { id: '1', name: 'Bug', subtask: false, self: 'https://example.com' },
        ]);
      }
      if (path === '/rest/api/3/field') {
        callSequence.push('field');
        return Promise.resolve([
          { id: 'summary', name: 'Summary', custom: false },
          { id: 'customfield_10001', name: 'Story Points', custom: true },
        ]);
      }
      if (path.startsWith('/rest/api/3/field/') && path.includes('/context')) {
        callSequence.push('field-context');
        return Promise.resolve({ values: [], total: 0, isLast: true });
      }
      if (path.startsWith('/rest/api/3/fieldconfiguration')) {
        callSequence.push('fieldconfiguration');
        return Promise.resolve({ values: [{ id: 1, name: 'FC' }], total: 1, isLast: true });
      }
      if (path.startsWith('/rest/api/3/workflow/search')) {
        callSequence.push('workflow');
        return Promise.resolve({ values: [{ id: { name: 'WF' } }], total: 1, isLast: true });
      }
      if (path.startsWith('/rest/api/3/workflowscheme')) {
        callSequence.push('workflowscheme');
        return Promise.resolve({ values: [{ id: 1, name: 'WFS' }], total: 1, isLast: true });
      }
      if (path.startsWith('/rest/agile/1.0/board') && !path.includes('/sprint')) {
        callSequence.push('board');
        return Promise.resolve({ values: [{ id: 100, name: 'B', type: 'scrum' }], total: 1, isLast: true });
      }
      if (path.startsWith('/rest/agile/1.0/board/') && path.includes('/sprint')) {
        callSequence.push('sprint');
        return Promise.resolve({ values: [{ id: 10, name: 'Sprint 1', state: 'active' }], total: 1, isLast: true });
      }
      throw new Error(`Unknown path: ${path}`);
    });

    const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
    await orch.run({
      backupPointId: BACKUP_POINT_ID,
      cloudId: 'test',
      projects: PROJECTS,
      heartbeatIntervalMs: 60000,
    });

    // First call: issuetype; second: field; field-context for custom field only;
    // then fieldconfiguration, workflow, workflowscheme, board, sprint — in order.
    const posIssuetype = callSequence.indexOf('issuetype');
    const posField = callSequence.indexOf('field');
    const posFieldConfig = callSequence.indexOf('fieldconfiguration');
    const posWorkflow = callSequence.indexOf('workflow');
    const posWorkflowScheme = callSequence.indexOf('workflowscheme');
    const posBoard = callSequence.indexOf('board');
    const posSprint = callSequence.indexOf('sprint');

    // Assert strict dependency ordering
    expect(posIssuetype).toBeLessThan(posField);
    expect(posField).toBeLessThan(posFieldConfig);
    expect(posFieldConfig).toBeLessThan(posWorkflow);
    expect(posWorkflow).toBeLessThan(posWorkflowScheme);
    expect(posWorkflowScheme).toBeLessThan(posBoard);
    expect(posBoard).toBeLessThan(posSprint);
  });

  it('records stage names in the result in the same strict order', async () => {
    const mockGet = buildDefaultMockGet();
    const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
    const result = await orch.run({
      backupPointId: BACKUP_POINT_ID,
      cloudId: 'test',
      projects: PROJECTS,
      heartbeatIntervalMs: 60000,
    });

    expect(result.halted).toBe(false);
    expect(result.stages.map((s) => s.stageName)).toEqual([
      'issue_type',
      'custom_field',
      'field_configuration',
      'workflow',
      'workflow_scheme',
      'board',
      'sprint',
    ]);
  });

  it('onStageComplete hook fires in strict order matching dependency contract', async () => {
    const mockGet = buildDefaultMockGet();
    const completedStages: string[] = [];

    const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
    await orch.run({
      backupPointId: BACKUP_POINT_ID,
      cloudId: 'test',
      projects: PROJECTS,
      heartbeatIntervalMs: 60000,
      onStageComplete: (result) => completedStages.push(result.stageName),
    });

    expect(completedStages).toEqual([
      'issue_type',
      'custom_field',
      'field_configuration',
      'workflow',
      'workflow_scheme',
      'board',
      'sprint',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) Custom-field context gate
// ─────────────────────────────────────────────────────────────────────────────

describe('Sprint 4 — (2) Custom-field context gate', () => {
  it('calls /field/{id}/context ONLY for custom:true fields; never for system fields', async () => {
    const mockGet = jest.fn().mockImplementation((path: string) => {
      if (path === '/rest/api/3/issuetype') return Promise.resolve([]);
      if (path === '/rest/api/3/field') {
        return Promise.resolve([
          { id: 'summary',     name: 'Summary',     custom: false },
          { id: 'description', name: 'Description', custom: false },
          { id: 'status',      name: 'Status',      custom: false },
          { id: 'customfield_10001', name: 'Story Points', custom: true },
          { id: 'customfield_10002', name: 'Sprint',       custom: true },
        ]);
      }
      if (path.startsWith('/rest/api/3/field/') && path.includes('/context')) {
        return Promise.resolve({ values: [], total: 0, isLast: true });
      }
      if (path.startsWith('/rest/api/3/fieldconfiguration')) return Promise.resolve({ values: [], total: 0, isLast: true });
      if (path.startsWith('/rest/api/3/workflow/search')) return Promise.resolve({ values: [], total: 0, isLast: true });
      if (path.startsWith('/rest/api/3/workflowscheme')) return Promise.resolve({ values: [], total: 0, isLast: true });
      if (path.startsWith('/rest/agile/1.0/board')) return Promise.resolve({ values: [], total: 0, isLast: true });
      throw new Error(`Unexpected: ${path}`);
    });

    const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
    await orch.run({
      backupPointId: BACKUP_POINT_ID,
      cloudId: 'test',
      projects: PROJECTS,
      heartbeatIntervalMs: 60000,
    });

    // Context endpoint called for BOTH custom fields
    const customfield10001Calls = mockGet.mock.calls.filter(
      ([path]: [string]) => path.includes('/field/customfield_10001/context'),
    );
    const customfield10002Calls = mockGet.mock.calls.filter(
      ([path]: [string]) => path.includes('/field/customfield_10002/context'),
    );
    expect(customfield10001Calls.length).toBeGreaterThanOrEqual(1);
    expect(customfield10002Calls.length).toBeGreaterThanOrEqual(1);

    // Context endpoint NEVER called for any system field
    const systemFieldContextCalls = mockGet.mock.calls.filter(
      ([path]: [string]) =>
        (path.includes('/field/summary/context') ||
          path.includes('/field/description/context') ||
          path.includes('/field/status/context')),
    );
    expect(systemFieldContextCalls).toHaveLength(0);
  });

  it('system fields accumulate in systemFieldsSkipped and skippedReasons', async () => {
    const mockGet = jest.fn().mockImplementation((path: string) => {
      if (path === '/rest/api/3/issuetype') return Promise.resolve([]);
      if (path === '/rest/api/3/field') {
        return Promise.resolve([
          { id: 'summary',     name: 'Summary',     custom: false },
          { id: 'reporter',    name: 'Reporter',    custom: false },
          { id: 'assignee',    name: 'Assignee',    custom: false },
          { id: 'customfield_10001', name: 'Points', custom: true },
        ]);
      }
      if (path.includes('/context')) return Promise.resolve({ values: [], total: 0, isLast: true });
      if (path.startsWith('/rest/api/3/fieldconfiguration')) return Promise.resolve({ values: [], total: 0, isLast: true });
      if (path.startsWith('/rest/api/3/workflow/search')) return Promise.resolve({ values: [], total: 0, isLast: true });
      if (path.startsWith('/rest/api/3/workflowscheme')) return Promise.resolve({ values: [], total: 0, isLast: true });
      if (path.startsWith('/rest/agile/1.0/board')) return Promise.resolve({ values: [], total: 0, isLast: true });
      throw new Error(`Unexpected: ${path}`);
    });

    const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
    const result = await orch.run({
      backupPointId: BACKUP_POINT_ID,
      cloudId: 'test',
      projects: PROJECTS,
      heartbeatIntervalMs: 60000,
    });

    // 3 system fields skipped
    expect(result.systemFieldsSkipped).toBe(3);

    const cfStage = result.stages.find((s) => s.stageName === 'custom_field');
    expect(cfStage?.section.skippedIds).toContain('summary');
    expect(cfStage?.section.skippedIds).toContain('reporter');
    expect(cfStage?.section.skippedIds).toContain('assignee');
    expect(cfStage?.section.skippedReasons['summary']).toBe('system_field');
    expect(cfStage?.section.skippedReasons['reporter']).toBe('system_field');
    expect(cfStage?.section.skippedReasons['assignee']).toBe('system_field');

    // Only the custom field has a manifest entry
    expect(cfStage?.entries).toHaveLength(1);
    expect(cfStage?.entries[0].id).toBe('customfield_10001');
  });

  it('zero context calls when ALL fields are system fields', async () => {
    const mockGet = jest.fn().mockImplementation((path: string) => {
      if (path === '/rest/api/3/issuetype') return Promise.resolve([]);
      if (path === '/rest/api/3/field') {
        return Promise.resolve([
          { id: 'summary',   name: 'Summary',   custom: false },
          { id: 'priority',  name: 'Priority',  custom: false },
          { id: 'issuetype', name: 'Issue Type', custom: false },
        ]);
      }
      if (path.startsWith('/rest/api/3/fieldconfiguration')) return Promise.resolve({ values: [], total: 0, isLast: true });
      if (path.startsWith('/rest/api/3/workflow/search')) return Promise.resolve({ values: [], total: 0, isLast: true });
      if (path.startsWith('/rest/api/3/workflowscheme')) return Promise.resolve({ values: [], total: 0, isLast: true });
      if (path.startsWith('/rest/agile/1.0/board')) return Promise.resolve({ values: [], total: 0, isLast: true });
      throw new Error(`Unexpected: ${path}`);
    });

    const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
    const result = await orch.run({
      backupPointId: BACKUP_POINT_ID,
      cloudId: 'test',
      projects: PROJECTS,
      heartbeatIntervalMs: 60000,
    });

    // No context calls at all
    const contextCalls = mockGet.mock.calls.filter(
      ([path]: [string]) => path.includes('/context'),
    );
    expect(contextCalls).toHaveLength(0);
    expect(result.systemFieldsSkipped).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) Zero-silent-omission — count mismatch raises ManifestIntegrityError
// ─────────────────────────────────────────────────────────────────────────────

describe('Sprint 4 — (3) Zero-silent-omission invariant', () => {
  it('throws ManifestIntegrityError when capturedCount(48) + skipped(0) !== apiTotal(50)', () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const writer = makeWriter(repo, 'bp-omission-test');

    // API reported 50 but only 48 captured, 0 skipped → gap of 2
    const section = makeSection('issue_type', 48, [], 50);

    expect(() => writer.appendStageSection(section, [])).toThrow(ManifestIntegrityError);
  });

  it('ManifestIntegrityError carries correct stage, counts, and actualSum', () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const writer = makeWriter(repo, 'bp-integrity-detail');

    const section = makeSection('workflow', 48, [], 50);

    let caught: ManifestIntegrityError | undefined;
    try {
      writer.appendStageSection(section, []);
    } catch (err) {
      caught = err as ManifestIntegrityError;
    }

    expect(caught).toBeDefined();
    expect(caught!.name).toBe('ManifestIntegrityError');
    expect(caught!.stageName).toBe('workflow');
    expect(caught!.capturedCount).toBe(48);
    expect(caught!.skippedCount).toBe(0);
    expect(caught!.apiTotalReported).toBe(50);
    expect(caught!.actualSum).toBe(48); // 48 + 0
    expect(caught!.message).toContain('!== apiTotalReported(50)');
  });

  it('backup-point status is flagged completed_with_errors after integrity violation', () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const writer = makeWriter(repo, 'bp-status-check');

    // apiTotalReported=50 but only 48 captured → ManifestIntegrityError
    const badSection = makeSection('issue_type', 48, [], 50);

    try {
      writer.appendStageSection(badSection, []);
    } catch {
      // expected ManifestIntegrityError
    }

    const stored = repo.getById('bp-status-check');
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('completed_with_errors');
  });

  it('finalize() returns completed_with_errors when prior integrity errors occurred', () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const writer = makeWriter(repo, 'bp-finalize-cwe');

    try {
      writer.appendStageSection(makeSection('issue_type', 48, [], 50), []);
    } catch {
      // expected
    }

    // Even if caller passes 'completed', writer upgrades to completed_with_errors
    const manifest = writer.finalize('completed');
    expect(manifest.status).toBe('completed_with_errors');
  });

  it('validator detect integrity violation in stored manifest', () => {
    const db = makeDb();
    const repo = makeRepo(db);
    const writer = makeWriter(repo, 'bp-validator-gap');

    try {
      writer.appendStageSection(makeSection('board', 48, [], 50), []);
    } catch {
      // expected
    }

    // The manifest was saved as completed_with_errors before throw
    const stored = repo.getById('bp-validator-gap');
    expect(stored).not.toBeNull();

    const validation = BackupPointManifestWriter.validate(stored!);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes('integrity violation'))).toBe(true);
  });

  it('emits [jira-manifest] integrity-violation log line on count mismatch', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const db = makeDb();
    const repo = makeRepo(db);
    const writer = makeWriter(repo, 'bp-log-check');

    try {
      writer.appendStageSection(makeSection('sprint', 48, [], 50), []);
    } catch {
      // expected
    }

    const errorLines = consoleSpy.mock.calls.map((args) => String(args[0]));
    const violationLine = errorLines.find(
      (l) => l.includes('[jira-manifest]') && l.includes('integrity-violation'),
    );
    expect(violationLine).toBeDefined();
    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) Pagination termination — all three conditions
// ─────────────────────────────────────────────────────────────────────────────

describe('Sprint 4 — (4) Pagination termination contract', () => {
  describe('(4a) terminates on isLast === true', () => {
    it('stops after first page when isLast=true even on a full page', async () => {
      let callCount = 0;
      const fetchPage = jest.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          values: [{ id: 1 }, { id: 2 }, { id: 3 }],
          total: 3,
          isLast: true,
        });
      });

      const result = await paginateAtlassian(fetchPage, 3);

      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(result.items).toHaveLength(3);
      expect(result.pagesFetched).toBe(1);
      expect(result.apiReportedTotal).toBe(3);
      expect(result.reconciled).toBe(true);
    });

    it('terminates on isLast=true mid-sequence (page 2 of 3 signals isLast)', async () => {
      const fetchPage = jest.fn()
        .mockResolvedValueOnce({
          values: [{ id: 1 }, { id: 2 }],
          total: 4,
          isLast: false,
        })
        .mockResolvedValueOnce({
          values: [{ id: 3 }, { id: 4 }],
          total: 4,
          isLast: true,
        });

      const result = await paginateAtlassian(fetchPage, 2);

      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(result.items).toHaveLength(4);
      expect(result.reconciled).toBe(true);
    });
  });

  describe('(4b) terminates on partial page (values.length < maxResults)', () => {
    it('stops after partial page without isLast signal', async () => {
      const fetchPage = jest.fn()
        .mockResolvedValueOnce({
          values: [{ id: 1 }, { id: 2 }, { id: 3 }],
          total: 5,
          isLast: false,
        })
        // Second page is partial (2 items < maxResults=3)
        .mockResolvedValueOnce({
          values: [{ id: 4 }, { id: 5 }],
          total: 5,
          isLast: false,
        });

      const result = await paginateAtlassian(fetchPage, 3);

      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(result.items).toHaveLength(5);
      expect(result.totalFetched).toBe(5);
      expect(result.reconciled).toBe(true);
    });

    it('handles single-item partial page (values.length=1 < maxResults=50)', async () => {
      const fetchPage = jest.fn()
        .mockResolvedValueOnce({
          values: [{ id: 1 }],
          total: 1,
          isLast: false, // no isLast signal — relies on partial-page detection
        });

      const result = await paginateAtlassian(fetchPage, 50);

      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(result.items).toHaveLength(1);
    });
  });

  describe('(4c) terminates on empty page (values.length === 0)', () => {
    it('stops immediately on empty first page', async () => {
      const fetchPage = jest.fn().mockResolvedValueOnce({
        values: [],
        total: 0,
        isLast: false,
      });

      const result = await paginateAtlassian(fetchPage, 50);

      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(result.items).toHaveLength(0);
    });

    it('stops on empty second page after one full page', async () => {
      const fetchPage = jest.fn()
        .mockResolvedValueOnce({
          // First page is exactly maxResults — not a partial-page termination signal
          values: [{ id: 1 }],
          total: 2,
          isLast: false,
        })
        .mockResolvedValueOnce({
          values: [],
          total: 2,
          isLast: false,
        });

      const result = await paginateAtlassian(fetchPage, 1);

      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(result.items).toHaveLength(1);
    });
  });

  describe('pagination across orchestrator stages', () => {
    it('fieldconfiguration stage paginates multiple pages correctly', async () => {
      const mockGet = jest.fn().mockImplementation((path: string) => {
        if (path === '/rest/api/3/issuetype') return Promise.resolve([]);
        if (path === '/rest/api/3/field') return Promise.resolve([]);
        if (path.startsWith('/rest/api/3/fieldconfiguration')) {
          const url = new URL(`http://x${path}`);
          const startAt = Number(url.searchParams.get('startAt') ?? '0');
          if (startAt === 0) {
            return Promise.resolve({
              values: [{ id: 1, name: 'FC A' }, { id: 2, name: 'FC B' }],
              total: 3,
              isLast: false,
            });
          }
          // Second page is partial — terminates
          return Promise.resolve({
            values: [{ id: 3, name: 'FC C' }],
            total: 3,
            isLast: false,
          });
        }
        if (path.startsWith('/rest/api/3/workflow/search')) return Promise.resolve({ values: [], total: 0, isLast: true });
        if (path.startsWith('/rest/api/3/workflowscheme')) return Promise.resolve({ values: [], total: 0, isLast: true });
        if (path.startsWith('/rest/agile/1.0/board')) return Promise.resolve({ values: [], total: 0, isLast: true });
        throw new Error(`Unexpected: ${path}`);
      });

      const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
      const result = await orch.run({
        backupPointId: BACKUP_POINT_ID,
        cloudId: 'test',
        projects: PROJECTS,
        maxResults: 2,
        heartbeatIntervalMs: 60000,
      });

      const fcStage = result.stages.find((s) => s.stageName === 'field_configuration');
      expect(fcStage?.entries).toHaveLength(3);
      expect(fcStage?.section.capturedCount).toBe(3);
    });

    it('sprint stage paginates multiple pages per board correctly', async () => {
      const mockGet = jest.fn().mockImplementation((path: string) => {
        if (path === '/rest/api/3/issuetype') return Promise.resolve([]);
        if (path === '/rest/api/3/field') return Promise.resolve([]);
        if (path.startsWith('/rest/api/3/fieldconfiguration')) return Promise.resolve({ values: [], total: 0, isLast: true });
        if (path.startsWith('/rest/api/3/workflow/search')) return Promise.resolve({ values: [], total: 0, isLast: true });
        if (path.startsWith('/rest/api/3/workflowscheme')) return Promise.resolve({ values: [], total: 0, isLast: true });
        if (path.startsWith('/rest/agile/1.0/board') && !path.includes('/sprint')) {
          return Promise.resolve({ values: [{ id: 200, name: 'Board A', type: 'scrum' }], total: 1, isLast: true });
        }
        if (path.includes('/board/200/sprint')) {
          const url = new URL(`http://x${path}`);
          const startAt = Number(url.searchParams.get('startAt') ?? '0');
          if (startAt === 0) {
            return Promise.resolve({
              values: [
                { id: 1, name: 'Sprint 1', state: 'closed' },
                { id: 2, name: 'Sprint 2', state: 'closed' },
              ],
              total: 3,
              isLast: false,
            });
          }
          // Second page partial — terminates
          return Promise.resolve({
            values: [{ id: 3, name: 'Sprint 3', state: 'active' }],
            total: 3,
            isLast: false,
          });
        }
        throw new Error(`Unexpected: ${path}`);
      });

      const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
      const result = await orch.run({
        backupPointId: BACKUP_POINT_ID,
        cloudId: 'test',
        projects: PROJECTS,
        maxResults: 2,
        heartbeatIntervalMs: 60000,
      });

      const sprintStage = result.stages.find((s) => s.stageName === 'sprint');
      expect(sprintStage?.entries).toHaveLength(3);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) Stage failure halts pipeline and emits named diagnostic
// ─────────────────────────────────────────────────────────────────────────────

describe('Sprint 4 — (5) Stage failure halts pipeline', () => {
  it('halts at issue_type stage — subsequent stages do not run', async () => {
    const mockGet = jest.fn().mockImplementation((path: string) => {
      if (path === '/rest/api/3/issuetype') {
        throw new Error('IssueType API 500: Internal Server Error');
      }
      // All other paths should never be reached
      throw new Error(`Should not be called after halt: ${path}`);
    });

    const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
    const result = await orch.run({
      backupPointId: BACKUP_POINT_ID,
      cloudId: 'test',
      projects: PROJECTS,
      heartbeatIntervalMs: 60000,
    });

    expect(result.halted).toBe(true);
    expect(result.haltedAtStage).toBe('issue_type');
    expect(result.haltDiagnostic).toContain('stage=issue_type error');
    expect(result.haltDiagnostic).toContain('IssueType API 500');

    // Only the failed stage recorded
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].outcome).toBe('error');

    // Field endpoint never called
    const fieldCalls = mockGet.mock.calls.filter(
      ([path]: [string]) => path === '/rest/api/3/field',
    );
    expect(fieldCalls).toHaveLength(0);
  });

  it('halts at custom_field stage — workflow stages do not run', async () => {
    const mockGet = jest.fn().mockImplementation((path: string) => {
      if (path === '/rest/api/3/issuetype') {
        return Promise.resolve([{ id: '1', name: 'Bug', subtask: false, self: '' }]);
      }
      if (path === '/rest/api/3/field') {
        throw new Error('Field API unavailable');
      }
      // Workflow stages should never be reached
      if (path.startsWith('/rest/api/3/fieldconfiguration') ||
          path.startsWith('/rest/api/3/workflow') ||
          path.startsWith('/rest/agile/1.0/board')) {
        throw new Error(`Should not be called after halt: ${path}`);
      }
      throw new Error(`Unexpected: ${path}`);
    });

    const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
    const result = await orch.run({
      backupPointId: BACKUP_POINT_ID,
      cloudId: 'test',
      projects: PROJECTS,
      heartbeatIntervalMs: 60000,
    });

    expect(result.halted).toBe(true);
    expect(result.haltedAtStage).toBe('custom_field');

    const stageNames = result.stages.map((s) => s.stageName);
    expect(stageNames).toContain('issue_type');
    expect(stageNames).toContain('custom_field');
    expect(stageNames).not.toContain('field_configuration');
    expect(stageNames).not.toContain('workflow');
    expect(stageNames).not.toContain('workflow_scheme');
    expect(stageNames).not.toContain('board');
    expect(stageNames).not.toContain('sprint');
  });

  it('halts at workflow stage — emits stage_error event with named diagnostic', async () => {
    const mockGet = jest.fn().mockImplementation((path: string) => {
      if (path === '/rest/api/3/issuetype') return Promise.resolve([]);
      if (path === '/rest/api/3/field') return Promise.resolve([]);
      if (path.startsWith('/rest/api/3/fieldconfiguration')) return Promise.resolve({ values: [], total: 0, isLast: true });
      if (path.startsWith('/rest/api/3/workflow/search')) {
        throw new Error('Workflow API: 503 Service Unavailable');
      }
      throw new Error(`Should not reach: ${path}`);
    });

    const events: ProgressEvent[] = [];
    const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
    const result = await orch.run({
      backupPointId: BACKUP_POINT_ID,
      cloudId: 'test',
      projects: PROJECTS,
      onProgress: (e) => events.push(e),
      heartbeatIntervalMs: 60000,
    });

    expect(result.halted).toBe(true);
    expect(result.haltedAtStage).toBe('workflow');

    // Named diagnostic in result
    expect(result.haltDiagnostic).toBeDefined();
    expect(result.haltDiagnostic).toContain('stage=workflow error');
    expect(result.haltDiagnostic).toContain('503 Service Unavailable');

    // stage_error progress event emitted with diagnostic
    const errorEvent = events.find((e) => e.type === 'stage_error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.stage).toBe('workflow');
    expect(errorEvent!.diagnostic).toContain('503 Service Unavailable');

    // Stages after workflow not started
    const stageNames = result.stages.map((s) => s.stageName);
    expect(stageNames).not.toContain('workflow_scheme');
    expect(stageNames).not.toContain('board');
    expect(stageNames).not.toContain('sprint');
  });

  it('halts at board stage — sprint stage does not run', async () => {
    const mockGet = jest.fn().mockImplementation((path: string) => {
      if (path === '/rest/api/3/issuetype') return Promise.resolve([]);
      if (path === '/rest/api/3/field') return Promise.resolve([]);
      if (path.startsWith('/rest/api/3/fieldconfiguration')) return Promise.resolve({ values: [], total: 0, isLast: true });
      if (path.startsWith('/rest/api/3/workflow/search')) return Promise.resolve({ values: [], total: 0, isLast: true });
      if (path.startsWith('/rest/api/3/workflowscheme')) return Promise.resolve({ values: [], total: 0, isLast: true });
      if (path.startsWith('/rest/agile/1.0/board') && !path.includes('/sprint')) {
        throw new Error('Board API error: 403 Forbidden');
      }
      throw new Error(`Should not reach sprint: ${path}`);
    });

    const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
    const result = await orch.run({
      backupPointId: BACKUP_POINT_ID,
      cloudId: 'test',
      projects: PROJECTS,
      heartbeatIntervalMs: 60000,
    });

    expect(result.halted).toBe(true);
    expect(result.haltedAtStage).toBe('board');
    expect(result.haltDiagnostic).toContain('stage=board error');

    const stageNames = result.stages.map((s) => s.stageName);
    expect(stageNames).not.toContain('sprint');
  });

  it('emits stage_start event before each stage so monitoring has named entry point', async () => {
    const mockGet = jest.fn().mockImplementation((path: string) => {
      if (path === '/rest/api/3/issuetype') return Promise.resolve([]);
      if (path === '/rest/api/3/field') throw new Error('field API down');
      throw new Error(`Unreachable: ${path}`);
    });

    const events: ProgressEvent[] = [];
    const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
    await orch.run({
      backupPointId: BACKUP_POINT_ID,
      cloudId: 'test',
      projects: PROJECTS,
      onProgress: (e) => events.push(e),
      heartbeatIntervalMs: 60000,
    });

    // Both issue_type and custom_field should have a stage_start event before failure
    const startedStages = events
      .filter((e) => e.type === 'stage_start')
      .map((e) => e.stage);

    expect(startedStages).toContain('issue_type');
    expect(startedStages).toContain('custom_field');
    // Stages after failure have no start event
    expect(startedStages).not.toContain('field_configuration');
  });
});
