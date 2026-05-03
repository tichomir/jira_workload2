/**
 * RestoreMetrics — unit tests
 *
 * Covers:
 *   - logManifestLoaded emits correct log line and increments counter
 *   - logPaginationTerminated emits correct log line and increments counter
 *   - Counters accumulate across multiple calls
 *   - reset() clears all counters
 *   - RestoreEngine emits manifest-loaded per phase after executing
 */

import Database from 'better-sqlite3';
import { RestoreMetrics, restoreMetrics } from './RestoreMetrics';
import { RestoreJobStore } from './RestoreJobStore';
import { RestoreEventBus } from './RestoreEventBus';
import { RestoreEngine } from './RestoreEngine';
import { buildDefaultHandlers } from './RestorePhaseHandlers';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';

beforeEach(() => {
  restoreMetrics.reset();
});

// ── logManifestLoaded ──────────────────────────────────────────────────────────

describe('RestoreMetrics.logManifestLoaded', () => {
  it('emits [jira-restore] manifest-loaded log line with phase and count', () => {
    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((m: string) => logs.push(m));

    restoreMetrics.logManifestLoaded('project', 5);

    spy.mockRestore();

    expect(logs.some((l) => l === '[jira-restore] manifest-loaded phase=project count=5')).toBe(true);
  });

  it('increments jira_restore_manifest_entities_total counter for the given phase', () => {
    restoreMetrics.logManifestLoaded('workflow', 3);
    restoreMetrics.logManifestLoaded('workflow', 2);

    expect(restoreMetrics.jira_restore_manifest_entities_total['workflow']).toBe(5);
  });

  it('tracks multiple phases independently', () => {
    restoreMetrics.logManifestLoaded('project', 2);
    restoreMetrics.logManifestLoaded('issue_body', 10);
    restoreMetrics.logManifestLoaded('sprint', 4);

    expect(restoreMetrics.jira_restore_manifest_entities_total['project']).toBe(2);
    expect(restoreMetrics.jira_restore_manifest_entities_total['issue_body']).toBe(10);
    expect(restoreMetrics.jira_restore_manifest_entities_total['sprint']).toBe(4);
  });
});

// ── logPaginationTerminated ────────────────────────────────────────────────────

describe('RestoreMetrics.logPaginationTerminated', () => {
  it('emits [jira-restore] pagination-terminated log with cause and fetched', () => {
    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((m: string) => logs.push(m));

    restoreMetrics.logPaginationTerminated('empty', 0);

    spy.mockRestore();

    expect(
      logs.some((l) => l === '[jira-restore] pagination-terminated cause=empty fetched=0'),
    ).toBe(true);
  });

  it('emits correct log for short_page cause', () => {
    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((m: string) => logs.push(m));

    restoreMetrics.logPaginationTerminated('short_page', 47);

    spy.mockRestore();

    expect(
      logs.some((l) =>
        l === '[jira-restore] pagination-terminated cause=short_page fetched=47',
      ),
    ).toBe(true);
  });

  it('increments jira_restore_pagination_terminations_total counter for cause', () => {
    restoreMetrics.logPaginationTerminated('empty', 0);
    restoreMetrics.logPaginationTerminated('empty', 0);
    restoreMetrics.logPaginationTerminated('short_page', 5);

    expect(restoreMetrics.jira_restore_pagination_terminations_total['empty']).toBe(2);
    expect(restoreMetrics.jira_restore_pagination_terminations_total['short_page']).toBe(1);
  });
});

// ── reset() ───────────────────────────────────────────────────────────────────

describe('RestoreMetrics.reset', () => {
  it('clears all counters', () => {
    restoreMetrics.logManifestLoaded('board', 1);
    restoreMetrics.logPaginationTerminated('empty', 0);

    const fresh = new RestoreMetrics();
    fresh.logManifestLoaded('board', 1);
    fresh.logPaginationTerminated('empty', 0);
    fresh.reset();

    expect(fresh.jira_restore_manifest_entities_total).toEqual({});
    expect(fresh.jira_restore_pagination_terminations_total).toEqual({});
  });
});

// ── RestoreEngine integration: manifest-loaded per phase ──────────────────────

describe('RestoreEngine — manifest-loaded log & counter per phase', () => {
  function buildFixture() {
    const db = new Database(':memory:');
    RestoreJobStore.migrate(db);
    JiraCredentialRepository.runMigration(db);
    const store = new RestoreJobStore(db);
    const bus = new RestoreEventBus();

    const job = store.createJob({
      jobId: `metrics-test-${Date.now()}`,
      sourceBackupPointId: 'bp-metrics',
      scope: { type: 'all' },
      destination: { type: 'original' },
      conflictMode: 'skip',
    });
    store.setStatus(job.jobId, 'running');

    return { store, bus, job };
  }

  it('emits [jira-restore] manifest-loaded for all 7 phases after engine run', async () => {
    const { store, bus, job } = buildFixture();
    restoreMetrics.reset();

    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((m: string) => logs.push(m));

    const engine = new RestoreEngine(buildDefaultHandlers(), store, bus);
    await engine.execute(job.jobId, {
      projectExists: jest.fn().mockResolvedValue(false),
      writeProject: jest.fn().mockResolvedValue(undefined),
      writeWorkflow: jest.fn().mockResolvedValue(undefined),
      writeCustomField: jest.fn().mockResolvedValue(undefined),
      writeBoard: jest.fn().mockResolvedValue(undefined),
      writeSprint: jest.fn().mockResolvedValue(undefined),
      writeIssue: jest.fn().mockResolvedValue('new-id'),
      writeIssueLinks: jest.fn().mockResolvedValue(undefined),
      writeComments: jest.fn().mockResolvedValue(undefined),
      writeAttachments: jest.fn().mockResolvedValue(undefined),
    });

    spy.mockRestore();

    const manifestLogs = logs.filter((l) => l.startsWith('[jira-restore] manifest-loaded'));
    expect(manifestLogs).toHaveLength(7);

    const phases = ['project', 'workflow', 'custom_field', 'board', 'sprint', 'issue_body', 'post_issue'];
    for (const phase of phases) {
      expect(manifestLogs.some((l) => l.includes(`phase=${phase}`))).toBe(true);
    }
  });

  it('increments jira_restore_manifest_entities_total for each phase', async () => {
    const { store, bus, job } = buildFixture();
    restoreMetrics.reset();

    const engine = new RestoreEngine(buildDefaultHandlers(), store, bus);
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await engine.execute(job.jobId, {
      projectExists: jest.fn().mockResolvedValue(false),
      writeProject: jest.fn().mockResolvedValue(undefined),
      writeWorkflow: jest.fn().mockResolvedValue(undefined),
      writeCustomField: jest.fn().mockResolvedValue(undefined),
      writeBoard: jest.fn().mockResolvedValue(undefined),
      writeSprint: jest.fn().mockResolvedValue(undefined),
      writeIssue: jest.fn().mockResolvedValue('new-id'),
      writeIssueLinks: jest.fn().mockResolvedValue(undefined),
      writeComments: jest.fn().mockResolvedValue(undefined),
      writeAttachments: jest.fn().mockResolvedValue(undefined),
    });
    spy.mockRestore();

    // All 7 phases should have counter entries
    const counter = restoreMetrics.jira_restore_manifest_entities_total;
    expect(Object.keys(counter)).toHaveLength(7);
    for (const phase of ['project', 'workflow', 'custom_field', 'board', 'sprint', 'issue_body', 'post_issue']) {
      expect(counter[phase]).toBeGreaterThanOrEqual(0);
    }
  });
});
