/**
 * Sprint 7 QA: Per-item error aggregation into final job status.
 *
 * Verifies the job status state machine contract:
 *   errors === 0                        → 'Completed successfully'
 *   errors > 0 AND successes > 0        → 'Completed with N errors'
 *   errors > 0 AND successes === 0      → 'Failed'
 *
 * Also verifies:
 *   - [jira-backup] job_completed structured log line is emitted
 *   - Every error record persisted with backupPointId + ISO 8601 timestamp
 */

import Database from 'better-sqlite3';
import { JobStore } from '../jobs/JobStore';
import { JobEventBus, JobProgressEvent } from '../jobs/JobEventBus';
import { HeartbeatEmitter } from '../jobs/HeartbeatEmitter';

// ── Helpers ───────────────────────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  JobStore.migrate(db);
  return db;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Sprint 7 — per-item error aggregation', () => {
  let db: Database.Database;
  let store: JobStore;
  let bus: JobEventBus;

  beforeEach(() => {
    db = openDb();
    store = new JobStore(db);
    bus = new JobEventBus();
  });

  afterEach(() => {
    db.close();
  });

  // ── Happy path: zero errors ──────────────────────────────────────────────────

  describe('Happy path — zero errors → Completed successfully', () => {
    it('sets status=completed and displayStatus="Completed successfully"', () => {
      const jobId = 'agg-happy-001';
      const backupPointId = 'bp-happy-001';

      store.createJob(jobId, backupPointId, 'issues');
      // 5 items processed, 0 failed
      store.completeJob(jobId, 5, 0);

      const summary = store.getJobSummary(jobId);
      expect(summary).not.toBeNull();
      expect(summary!.status).toBe('completed');
      expect(summary!.displayStatus).toBe('Completed successfully');
      expect(summary!.itemsFailed).toBe(0);
      expect(summary!.itemsProcessed).toBe(5);
    });

    it('HeartbeatEmitter.complete() emits [jira-backup] job_completed log on happy path', () => {
      const jobId = 'agg-happy-log-001';
      const backupPointId = 'bp-happy-log-001';
      const logLines: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logLines.push(args.join(' '));
        origLog(...args);
      };

      try {
        const emitter = new HeartbeatEmitter(
          { jobId, backupPointId, phase: 'issues', heartbeatIntervalMs: 60_000 },
          store,
          bus,
        );
        emitter.start();
        // 3 successful ticks
        emitter.tick();
        emitter.tick();
        emitter.tick();
        emitter.complete();
      } finally {
        console.log = origLog;
      }

      const completedLog = logLines.find((l) => l.includes('[jira-backup] job_completed'));
      expect(completedLog).toBeDefined();
      expect(completedLog).toContain('status="Completed successfully"');
      expect(completedLog).toContain('errors=0');
    });
  });

  // ── Error path: mixed success/failure ────────────────────────────────────────

  describe('Error path — mixed success/failure → Completed with N errors', () => {
    it('sets status=completed_with_errors and displayStatus="Completed with N errors"', () => {
      const jobId = 'agg-mixed-001';
      const backupPointId = 'bp-mixed-001';
      const N = 3;

      store.createJob(jobId, backupPointId, 'issues');
      // Insert per-item error records
      for (let i = 0; i < N; i++) {
        store.insertJobError({
          jobId,
          backupPointId,
          itemType: 'JiraIssue',
          itemId: `ERR-${i + 1}`,
          errorCode: 'API_ERROR',
          errorMessage: `Simulated error ${i + 1}`,
          timestamp: new Date().toISOString(),
        });
      }
      // 4 succeeded, 3 failed
      store.completeJob(jobId, 4, N);

      const summary = store.getJobSummary(jobId);
      expect(summary).not.toBeNull();
      expect(summary!.status).toBe('completed_with_errors');
      expect(summary!.displayStatus).toBe(`Completed with ${N} errors`);
      expect(summary!.itemsFailed).toBe(N);
      expect(summary!.errors).toHaveLength(N);
    });

    it('every error record carries backupPointId + ISO 8601 timestamp', () => {
      const jobId = 'agg-trace-001';
      const backupPointId = 'bp-trace-001';

      store.createJob(jobId, backupPointId, 'issues');
      const ts = new Date().toISOString();

      store.insertJobError({
        jobId,
        backupPointId,
        itemType: 'JiraIssue',
        itemId: 'TRACE-1',
        errorCode: 'API_ERROR',
        errorMessage: 'error for traceability test',
        timestamp: ts,
      });

      store.completeJob(jobId, 1, 1);
      const summary = store.getJobSummary(jobId);

      expect(summary!.errors).toHaveLength(1);
      const errRecord = summary!.errors[0];
      expect(errRecord.backupPointId).toBe(backupPointId);
      expect(errRecord.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(errRecord.itemId).toBe('TRACE-1');
      expect(errRecord.itemType).toBe('JiraIssue');
    });

    it('HeartbeatEmitter.complete() emits [jira-backup] job_completed log with error count', () => {
      const jobId = 'agg-err-log-001';
      const backupPointId = 'bp-err-log-001';
      const FAIL_COUNT = 2;
      const logLines: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logLines.push(args.join(' '));
        origLog(...args);
      };

      try {
        const emitter = new HeartbeatEmitter(
          { jobId, backupPointId, phase: 'issues', heartbeatIntervalMs: 60_000 },
          store,
          bus,
        );
        emitter.start();
        emitter.tick();                        // 1 success
        emitter.tick({ failed: true });        // 1 failure
        emitter.tick({ failed: true });        // 2 failures
        emitter.complete();
      } finally {
        console.log = origLog;
      }

      const completedLog = logLines.find((l) => l.includes('[jira-backup] job_completed'));
      expect(completedLog).toBeDefined();
      expect(completedLog).toContain(`errors=${FAIL_COUNT}`);
      expect(completedLog).toContain(`Completed with ${FAIL_COUNT} errors`);
    });
  });

  // ── All-failed path: zero successes ──────────────────────────────────────────

  describe('All-failed path — zero successes → Failed', () => {
    it('sets status=failed when itemsProcessed=0 and itemsFailed>0', () => {
      const jobId = 'agg-allfail-001';
      const backupPointId = 'bp-allfail-001';

      store.createJob(jobId, backupPointId, 'issues');
      store.insertJobError({
        jobId,
        backupPointId,
        itemType: 'JiraIssue',
        itemId: 'FAIL-1',
        errorCode: 'API_ERROR',
        errorMessage: 'total failure',
        timestamp: new Date().toISOString(),
      });
      // 0 processed, 1 failed → Failed
      store.completeJob(jobId, 0, 1);

      const summary = store.getJobSummary(jobId);
      expect(summary!.status).toBe('failed');
      expect(summary!.displayStatus).toBe('Failed');
    });
  });
});
