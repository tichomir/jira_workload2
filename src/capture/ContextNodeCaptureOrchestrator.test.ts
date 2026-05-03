/**
 * ContextNodeCaptureOrchestrator tests
 *
 * Covers:
 *  - Stage execution in documented order (reordering fails this test)
 *  - Custom field context called only for custom:true fields
 *  - System fields counted in 'systemFieldsSkipped' metric
 *  - Stage failure halts pipeline and emits named diagnostic
 *  - Subsequent stages do NOT run after a halting failure
 *  - Progress heartbeat emitted during long-running stages
 *  - Structured log line per stage (stage=<name> count=<n> outcome=ok|error)
 */

import { ContextNodeCaptureOrchestrator, ProgressEvent } from './ContextNodeCaptureOrchestrator';
import { JiraHttpClient } from '../http/JiraHttpClient';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';

// ── Helpers ──────────────────────────────────────────────────────────────────

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
const PROJECTS = [{ id: 'proj-1', key: 'PROJ' }];

/** Returns an empty paginated page */
const emptyPage = () =>
  Promise.resolve({ values: [], total: 0, isLast: true });

/** Returns a paginated page with items */
const page = <T>(items: T[]) =>
  Promise.resolve({ values: items, total: items.length, isLast: true });

// ── Shared mock builder ───────────────────────────────────────────────────────

/**
 * Builds a mockGet that returns sensible defaults for every stage endpoint.
 * Override individual paths by prepending .mockImplementationOnce calls.
 */
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
      return Promise.resolve({ values: [{ id: 'ctx-1', name: 'Default', isGlobalContext: true, isAnyIssueType: true }], total: 1, isLast: true });
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ContextNodeCaptureOrchestrator', () => {
  describe('stage ordering', () => {
    it('executes stages in documented order: issueType → customField → fieldConfig → workflow → workflowScheme → board → sprint', async () => {
      const callOrder: string[] = [];
      const mockGet = jest.fn().mockImplementation((path: string) => {
        if (path === '/rest/api/3/issuetype') {
          callOrder.push('issuetype');
          return Promise.resolve([]);
        }
        if (path === '/rest/api/3/field') {
          callOrder.push('field');
          return Promise.resolve([]);
        }
        if (path.startsWith('/rest/api/3/fieldconfiguration')) {
          callOrder.push('fieldconfiguration');
          return Promise.resolve({ values: [], total: 0, isLast: true });
        }
        if (path.startsWith('/rest/api/3/workflow/search')) {
          callOrder.push('workflow');
          return Promise.resolve({ values: [], total: 0, isLast: true });
        }
        if (path.startsWith('/rest/api/3/workflowscheme')) {
          callOrder.push('workflowscheme');
          return Promise.resolve({ values: [], total: 0, isLast: true });
        }
        if (path.startsWith('/rest/agile/1.0/board') && !path.includes('/sprint')) {
          callOrder.push('board');
          return Promise.resolve({ values: [], total: 0, isLast: true });
        }
        if (path.startsWith('/rest/agile/1.0/board/') && path.includes('/sprint')) {
          callOrder.push('sprint');
          return Promise.resolve({ values: [], total: 0, isLast: true });
        }
        throw new Error(`Unknown path: ${path}`);
      });

      const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
      await orch.run({ backupPointId: BACKUP_POINT_ID, cloudId: 'test', projects: PROJECTS, heartbeatIntervalMs: 60000 });

      expect(callOrder).toEqual([
        'issuetype',
        'field',
        'fieldconfiguration',
        'workflow',
        'workflowscheme',
        'board',
        // No sprint call because board returned 0 boards → no board IDs
      ]);
    });

    it('fetches sprints only after boards are captured (board IDs flow to sprint stage)', async () => {
      const mockGet = buildDefaultMockGet();
      const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
      const result = await orch.run({
        backupPointId: BACKUP_POINT_ID,
        cloudId: 'test',
        projects: PROJECTS,
        heartbeatIntervalMs: 60000,
      });

      const boardStage = result.stages.find((s) => s.stageName === 'board');
      const sprintStage = result.stages.find((s) => s.stageName === 'sprint');

      expect(boardStage?.entries).toHaveLength(1);
      expect(boardStage?.entries[0].id).toBe('100');

      // Sprint URL should include the board ID from the board stage
      const sprintCall = mockGet.mock.calls.find(
        ([path]) => typeof path === 'string' && path.includes('/board/100/sprint'),
      );
      expect(sprintCall).toBeDefined();
      expect(sprintStage?.entries).toHaveLength(1);
    });
  });

  describe('custom field context gate', () => {
    it('calls context endpoint ONLY for custom:true fields', async () => {
      const mockGet = buildDefaultMockGet();
      const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));

      await orch.run({ backupPointId: BACKUP_POINT_ID, cloudId: 'test', projects: PROJECTS, heartbeatIntervalMs: 60000 });

      // Context endpoint should be called for customfield_10001 (custom:true)
      const ctxCall = mockGet.mock.calls.find(
        ([path]) =>
          typeof path === 'string' &&
          path.includes('/field/customfield_10001/context'),
      );
      expect(ctxCall).toBeDefined();

      // Context endpoint should NOT be called for 'summary' (custom:false)
      const summaryCtxCall = mockGet.mock.calls.find(
        ([path]) =>
          typeof path === 'string' && path.includes('/field/summary/context'),
      );
      expect(summaryCtxCall).toBeUndefined();
    });

    it('counts system fields in systemFieldsSkipped metric', async () => {
      const mockGet = jest.fn().mockImplementation((path: string) => {
        if (path === '/rest/api/3/field') {
          return Promise.resolve([
            { id: 'summary', name: 'Summary', custom: false },
            { id: 'description', name: 'Description', custom: false },
            { id: 'customfield_10001', name: 'Story Points', custom: true },
          ]);
        }
        // All other paths return empty
        if (path === '/rest/api/3/issuetype') return Promise.resolve([]);
        if (path.includes('/field/customfield_10001/context')) {
          return Promise.resolve({ values: [], total: 0, isLast: true });
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

      expect(result.systemFieldsSkipped).toBe(2); // summary + description

      const cfStage = result.stages.find((s) => s.stageName === 'custom_field');
      expect(cfStage?.section.skippedIds).toContain('summary');
      expect(cfStage?.section.skippedIds).toContain('description');
      expect(cfStage?.section.skippedReasons['summary']).toBe('system_field');
    });
  });

  describe('stage failure halts pipeline', () => {
    it('stops execution when issuetype stage fails', async () => {
      const mockGet = jest.fn().mockImplementation((path: string) => {
        if (path === '/rest/api/3/issuetype') {
          throw new Error('API error: 500');
        }
        return Promise.resolve({ values: [], total: 0, isLast: true });
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
      // Only the failed stage should be in results
      expect(result.stages).toHaveLength(1);
      expect(result.stages[0].stageName).toBe('issue_type');
      // Field endpoint should never be called
      const fieldCall = mockGet.mock.calls.find(
        ([path]) => typeof path === 'string' && path === '/rest/api/3/field',
      );
      expect(fieldCall).toBeUndefined();
    });

    it('stops execution when workflow stage fails, does not invoke workflowScheme or later', async () => {
      const mockGet = jest.fn().mockImplementation((path: string) => {
        if (path === '/rest/api/3/issuetype') return Promise.resolve([]);
        if (path === '/rest/api/3/field') return Promise.resolve([]);
        if (path.startsWith('/rest/api/3/fieldconfiguration')) return Promise.resolve({ values: [], total: 0, isLast: true });
        if (path.startsWith('/rest/api/3/workflow/search')) {
          throw new Error('Workflow API unavailable');
        }
        throw new Error(`Should not be called: ${path}`);
      });

      const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
      const result = await orch.run({
        backupPointId: BACKUP_POINT_ID,
        cloudId: 'test',
        projects: PROJECTS,
        heartbeatIntervalMs: 60000,
      });

      expect(result.halted).toBe(true);
      expect(result.haltedAtStage).toBe('workflow');

      const stageNames = result.stages.map((s) => s.stageName);
      expect(stageNames).not.toContain('workflow_scheme');
      expect(stageNames).not.toContain('board');
      expect(stageNames).not.toContain('sprint');
    });

    it('emits stage_error progress event with named diagnostic on halt', async () => {
      const mockGet = jest.fn().mockImplementation((path: string) => {
        if (path === '/rest/api/3/issuetype') throw new Error('IssueType fetch failed');
        return Promise.resolve({ values: [], total: 0, isLast: true });
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

      const errorEvent = events.find((e) => e.type === 'stage_error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.stage).toBe('issue_type');
      expect(errorEvent?.diagnostic).toContain('IssueType fetch failed');
    });
  });

  describe('progress heartbeat', () => {
    it('emits heartbeat events during a long-running stage', async () => {
      jest.useFakeTimers();

      const progressEvents: ProgressEvent[] = [];
      let resolveIssuetype!: (val: unknown[]) => void;
      const issueTypePromise = new Promise<unknown[]>((r) => {
        resolveIssuetype = r;
      });

      const mockGet = jest.fn().mockImplementation((path: string) => {
        if (path === '/rest/api/3/issuetype') return issueTypePromise;
        if (path === '/rest/api/3/field') return Promise.resolve([]);
        if (path.startsWith('/rest/api/3/fieldconfiguration')) return Promise.resolve({ values: [], total: 0, isLast: true });
        if (path.startsWith('/rest/api/3/workflow/search')) return Promise.resolve({ values: [], total: 0, isLast: true });
        if (path.startsWith('/rest/api/3/workflowscheme')) return Promise.resolve({ values: [], total: 0, isLast: true });
        if (path.startsWith('/rest/agile/1.0/board')) return Promise.resolve({ values: [], total: 0, isLast: true });
        return Promise.resolve([]);
      });

      const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));

      // Start run (does not await) — heartbeat interval is registered synchronously
      const runPromise = orch.run({
        backupPointId: BACKUP_POINT_ID,
        cloudId: 'test',
        projects: PROJECTS,
        onProgress: (e) => progressEvents.push(e),
        heartbeatIntervalMs: 9000,
      });

      // Advance fake time by 9.5s — fires one heartbeat tick
      jest.advanceTimersByTime(9500);

      // Unblock the issuetype fetch; the finally block in runWithHeartbeat
      // calls clearInterval when work() resolves, so no infinite loop.
      resolveIssuetype([]);
      await runPromise;

      const heartbeats = progressEvents.filter((e) => e.type === 'heartbeat');
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);
      expect(heartbeats[0].stage).toBe('issue_type');

      jest.useRealTimers();
    });
  });

  describe('structured logging', () => {
    it('emits stage_start and stage_complete events for every stage', async () => {
      const mockGet = buildDefaultMockGet();
      const events: ProgressEvent[] = [];

      const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
      await orch.run({
        backupPointId: BACKUP_POINT_ID,
        cloudId: 'test',
        projects: PROJECTS,
        onProgress: (e) => events.push(e),
        heartbeatIntervalMs: 60000,
      });

      const startEvents = events.filter((e) => e.type === 'stage_start');
      const completeEvents = events.filter((e) => e.type === 'stage_complete');

      // All 7 stages should emit start + complete
      expect(startEvents).toHaveLength(7);
      expect(completeEvents).toHaveLength(7);

      const expectedStages = [
        'issue_type',
        'custom_field',
        'field_configuration',
        'workflow',
        'workflow_scheme',
        'board',
        'sprint',
      ];
      for (const stage of expectedStages) {
        expect(startEvents.some((e) => e.stage === stage)).toBe(true);
        expect(completeEvents.some((e) => e.stage === stage)).toBe(true);
      }
    });
  });

  describe('onStageComplete hook', () => {
    it('calls onStageComplete after each stage with its section', async () => {
      const mockGet = buildDefaultMockGet();
      const stageSections: string[] = [];

      const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
      await orch.run({
        backupPointId: BACKUP_POINT_ID,
        cloudId: 'test',
        projects: PROJECTS,
        heartbeatIntervalMs: 60000,
        onStageComplete: (result) => stageSections.push(result.stageName),
      });

      expect(stageSections).toEqual([
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

  describe('pagination', () => {
    it('collects all pages across multi-page board results', async () => {
      const mockGet = jest.fn().mockImplementation((path: string) => {
        if (path === '/rest/api/3/issuetype') return Promise.resolve([]);
        if (path === '/rest/api/3/field') return Promise.resolve([]);
        if (path.startsWith('/rest/api/3/fieldconfiguration')) return Promise.resolve({ values: [], total: 0, isLast: true });
        if (path.startsWith('/rest/api/3/workflow/search')) return Promise.resolve({ values: [], total: 0, isLast: true });
        if (path.startsWith('/rest/api/3/workflowscheme')) return Promise.resolve({ values: [], total: 0, isLast: true });
        if (path.startsWith('/rest/agile/1.0/board') && !path.includes('/sprint')) {
          const url = new URL(`http://x${path}`);
          const startAt = Number(url.searchParams.get('startAt') ?? '0');
          const maxResults = Number(url.searchParams.get('maxResults') ?? '50');
          if (startAt === 0) {
            // First page: full (triggers next page)
            return Promise.resolve({
              values: [{ id: 1, name: 'Board A', type: 'scrum' }, { id: 2, name: 'Board B', type: 'kanban' }],
              total: 3,
              isLast: false,
            });
          }
          // Second page: partial (terminates)
          return Promise.resolve({
            values: [{ id: 3, name: 'Board C', type: 'scrum' }],
            total: 3,
            isLast: false,
          });
        }
        if (path.startsWith('/rest/agile/1.0/board/') && path.includes('/sprint')) {
          return Promise.resolve({ values: [], total: 0, isLast: true });
        }
        throw new Error(`Unknown: ${path}`);
      });

      const orch = new ContextNodeCaptureOrchestrator(makeClient(mockGet));
      const result = await orch.run({
        backupPointId: BACKUP_POINT_ID,
        cloudId: 'test',
        projects: PROJECTS,
        maxResults: 2,
        heartbeatIntervalMs: 60000,
      });

      const boardStage = result.stages.find((s) => s.stageName === 'board');
      expect(boardStage?.entries).toHaveLength(3);
      expect(boardStage?.section.capturedCount).toBe(3);
    });
  });
});
