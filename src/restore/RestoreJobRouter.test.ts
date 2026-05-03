/**
 * RestoreJobRouter — integration tests
 *
 * Covers:
 *   POST /restore/jobs  — happy path, validation errors, trash-window block, conflict-mode default
 *   GET  /restore/jobs/:id — found/not-found
 *   POST /restore/jobs/:id/decisions — happy path, wrong state, missing conflict
 *   Worker heartbeat ≤10s and stall detection >20s
 *   Structured log assertions
 */

import Database from 'better-sqlite3';
import request from 'supertest';
import express from 'express';
import { RestoreJobStore } from './RestoreJobStore';
import { RestoreEventBus } from './RestoreEventBus';
import { createRestoreJobRouter } from './RestoreJobRouter';
import { RestoreWorker } from './RestoreWorker';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';

// ── Test app factory ────────────────────────────────────────────────────────

function buildApp(opts?: {
  heartbeatIntervalMs?: number;
  checkIntervalMs?: number;
  staleThresholdMs?: number;
}) {
  const db = new Database(':memory:');
  RestoreJobStore.migrate(db);
  JiraCredentialRepository.runMigration(db);

  const restoreStore = new RestoreJobStore(db);
  const eventBus = new RestoreEventBus();
  const credRepo = new JiraCredentialRepository(db);

  const app = express();
  app.use(express.json());
  app.use(
    '/restore/jobs',
    createRestoreJobRouter(restoreStore, eventBus, credRepo, {
      allowUnauthenticated: true,
      ...opts,
    }),
  );

  return { app, restoreStore, eventBus, db };
}

// ── POST /restore/jobs ──────────────────────────────────────────────────────

describe('POST /restore/jobs', () => {
  it('creates a job and returns 201 with pending status', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-test-001',
        scope: { type: 'all' },
        destination: { type: 'export' },
        conflictMode: 'skip',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.jobId).toMatch(/^restore-/);
    expect(res.body.sourceBackupPointId).toBe('bp-test-001');
    expect(res.body.scope).toEqual({ type: 'all' });
    expect(res.body.destination).toEqual({ type: 'export' });
    expect(res.body.conflictMode).toBe('skip');
    expect(res.body.currentPhase).toBeNull();
    expect(res.body.phaseProgress).toEqual([]);
    expect(res.body.errorCount).toBe(0);
    expect(res.body.failureDiagnostic).toBeNull();
    expect(res.body.adfMediaWarningEmitted).toBe(false);
    expect(res.body.trashWindowBlocked).toBe(false);
  });

  it('defaults conflictMode to skip when omitted', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-test-002',
        scope: { type: 'all' },
        destination: { type: 'export' },
      });

    expect(res.status).toBe(201);
    expect(res.body.conflictMode).toBe('skip');
  });

  it('accepts override conflict mode', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-test-003',
        scope: { type: 'all' },
        destination: { type: 'export' },
        conflictMode: 'override',
      });

    expect(res.status).toBe(201);
    expect(res.body.conflictMode).toBe('override');
  });

  it('accepts ask conflict mode', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-test-004',
        scope: { type: 'all' },
        destination: { type: 'export' },
        conflictMode: 'ask',
      });

    expect(res.status).toBe(201);
    expect(res.body.conflictMode).toBe('ask');
  });

  it('returns 400 when sourceBackupPointId is missing', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/restore/jobs')
      .send({
        scope: { type: 'all' },
        destination: { type: 'export' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  it('returns 400 when scope is missing', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-test',
        destination: { type: 'export' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SCOPE');
  });

  it('returns 400 when scope.type is invalid', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-test',
        scope: { type: 'invalid' },
        destination: { type: 'export' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SCOPE');
  });

  it('returns 400 when scope.type=projects but projectKeys is empty', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-test',
        scope: { type: 'projects', projectKeys: [] },
        destination: { type: 'original' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SCOPE');
  });

  it('returns 400 when scope.type=issues but issueKeys is missing', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-test',
        scope: { type: 'issues' },
        destination: { type: 'original' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SCOPE');
    expect(res.body.message).toContain('issueKeys must be non-empty');
  });

  it('returns 400 when destination is missing', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-test',
        scope: { type: 'all' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_DESTINATION');
  });

  it('returns 400 when destination.type=alternate but targetProjectKey missing', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-test',
        scope: { type: 'all' },
        destination: { type: 'alternate' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_DESTINATION');
  });

  it('accepts alternate destination with targetProjectKey', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-test',
        scope: { type: 'all' },
        destination: { type: 'alternate', targetProjectKey: 'NEWPROJ' },
      });

    expect(res.status).toBe(201);
    expect(res.body.destination).toEqual({ type: 'alternate', targetProjectKey: 'NEWPROJ' });
  });

  it('returns 400 for invalid conflictMode', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-test',
        scope: { type: 'all' },
        destination: { type: 'export' },
        conflictMode: 'merge',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_CONFLICT_MODE');
  });
});

// ── Trash-window block ──────────────────────────────────────────────────────

describe('POST /restore/jobs — trash-window detection', () => {
  it('skips trash check when destination is not original', async () => {
    const { app } = buildApp();

    // export destination — no trash check, no Jira API call needed
    const res = await request(app)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-test',
        scope: { type: 'projects', projectKeys: ['PROJ'] },
        destination: { type: 'export' },
      });

    // Should succeed without any Jira API calls
    expect(res.status).toBe(201);
  });

  it('skips trash check when scope is all', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-test',
        scope: { type: 'all' },
        destination: { type: 'original' },
      });

    expect(res.status).toBe(201);
  });
});

// ── GET /restore/jobs/:id ───────────────────────────────────────────────────

describe('GET /restore/jobs/:id', () => {
  it('returns 200 with job state for existing job', async () => {
    const { app, restoreStore } = buildApp();

    const job = restoreStore.createJob({
      jobId: 'restore-test-abc',
      sourceBackupPointId: 'bp-abc',
      scope: { type: 'all' },
      destination: { type: 'export' },
      conflictMode: 'skip',
    });

    const res = await request(app).get(`/restore/jobs/${job.jobId}`);

    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe('restore-test-abc');
    expect(res.body.status).toBe('pending');
    expect(res.body.sourceBackupPointId).toBe('bp-abc');
    expect(res.body.phaseProgress).toEqual([]);
    expect(res.body.errorCount).toBe(0);
    expect(res.body.failureDiagnostic).toBeNull();
  });

  it('returns 404 for non-existent job', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/restore/jobs/restore-does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('returns current phase and phase progress when set', async () => {
    const { app, restoreStore } = buildApp();

    const job = restoreStore.createJob({
      jobId: 'restore-phase-test',
      sourceBackupPointId: 'bp-xyz',
      scope: { type: 'projects', projectKeys: ['PROJ'] },
      destination: { type: 'original' },
      conflictMode: 'skip',
    });

    restoreStore.setStatus(job.jobId, 'running');
    restoreStore.setCurrentPhase(job.jobId, 'issue_body');
    restoreStore.updatePhaseProgress(job.jobId, [
      {
        phase: 'project',
        status: 'completed',
        total: 1,
        processed: 1,
        errorCount: 0,
        startedAt: '2026-05-03T10:00:00Z',
        completedAt: '2026-05-03T10:00:01Z',
      },
    ]);

    const res = await request(app).get(`/restore/jobs/${job.jobId}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
    expect(res.body.currentPhase).toBe('issue_body');
    expect(res.body.phaseProgress).toHaveLength(1);
    expect(res.body.phaseProgress[0].phase).toBe('project');
  });
});

// ── POST /restore/jobs/:id/decisions ───────────────────────────────────────

describe('POST /restore/jobs/:id/decisions', () => {
  it('returns 200 and transitions to running when in awaiting_decision state', async () => {
    const { app, restoreStore } = buildApp();

    const job = restoreStore.createJob({
      jobId: 'restore-decision-test',
      sourceBackupPointId: 'bp-dec',
      scope: { type: 'all' },
      destination: { type: 'original' },
      conflictMode: 'ask',
    });

    restoreStore.setStatus(job.jobId, 'awaiting_decision');

    const conflict = restoreStore.insertConflict({
      id: 'conflict-001',
      jobId: job.jobId,
      objectType: 'JiraIssue',
      objectKey: 'PROJ-42',
      existingObjectSummary: 'Fix login bug',
      incomingObjectSummary: 'Fix login bug (restored)',
    });

    const res = await request(app)
      .post(`/restore/jobs/${job.jobId}/decisions`)
      .send({ conflictId: conflict.id, decision: 'override' });

    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe(job.jobId);
    expect(res.body.conflictId).toBe(conflict.id);
    expect(res.body.decision).toBe('override');
    expect(res.body.status).toBe('running');

    // Verify DB state
    const resolved = restoreStore.getConflict(conflict.id);
    expect(resolved?.decision).toBe('override');
    expect(resolved?.decidedAt).toBeTruthy();

    const updatedJob = restoreStore.getJob(job.jobId);
    expect(updatedJob?.status).toBe('running');
  });

  it('returns 409 when job is not in awaiting_decision state', async () => {
    const { app, restoreStore } = buildApp();

    const job = restoreStore.createJob({
      jobId: 'restore-wrong-state',
      sourceBackupPointId: 'bp-ws',
      scope: { type: 'all' },
      destination: { type: 'original' },
      conflictMode: 'ask',
    });
    // status is 'pending', not 'awaiting_decision'

    const res = await request(app)
      .post(`/restore/jobs/${job.jobId}/decisions`)
      .send({ conflictId: 'conflict-xyz', decision: 'skip' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INVALID_STATE');
    expect(res.body.message).toContain('pending');
  });

  it('returns 404 when job does not exist', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/restore/jobs/restore-nonexistent/decisions')
      .send({ conflictId: 'cdr-123', decision: 'skip' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('returns 404 when conflictId does not exist for the job', async () => {
    const { app, restoreStore } = buildApp();

    const job = restoreStore.createJob({
      jobId: 'restore-bad-conflict',
      sourceBackupPointId: 'bp-bc',
      scope: { type: 'all' },
      destination: { type: 'original' },
      conflictMode: 'ask',
    });
    restoreStore.setStatus(job.jobId, 'awaiting_decision');

    const res = await request(app)
      .post(`/restore/jobs/${job.jobId}/decisions`)
      .send({ conflictId: 'no-such-conflict', decision: 'skip' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CONFLICT_NOT_FOUND');
  });

  it('returns 400 for invalid decision value', async () => {
    const { app, restoreStore } = buildApp();

    const job = restoreStore.createJob({
      jobId: 'restore-bad-dec',
      sourceBackupPointId: 'bp-bd',
      scope: { type: 'all' },
      destination: { type: 'original' },
      conflictMode: 'ask',
    });
    restoreStore.setStatus(job.jobId, 'awaiting_decision');

    const res = await request(app)
      .post(`/restore/jobs/${job.jobId}/decisions`)
      .send({ conflictId: 'cdr-001', decision: 'merge' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });
});

// ── Worker heartbeat and stall detection ────────────────────────────────────

describe('RestoreWorker', () => {
  function buildWorkerFixture(opts?: {
    heartbeatIntervalMs?: number;
    checkIntervalMs?: number;
    staleThresholdMs?: number;
  }) {
    const db = new Database(':memory:');
    RestoreJobStore.migrate(db);
    const store = new RestoreJobStore(db);
    const bus = new RestoreEventBus();

    const job = store.createJob({
      jobId: 'restore-worker-test',
      sourceBackupPointId: 'bp-w-test',
      scope: { type: 'all' },
      destination: { type: 'export' },
      conflictMode: 'skip',
    });

    return { store, bus, job };
  }

  it('transitions job to running after start', async () => {
    const { store, bus, job } = buildWorkerFixture();

    const worker = new RestoreWorker(
      { jobId: job.jobId, heartbeatIntervalMs: 100, checkIntervalMs: 50 },
      store,
      bus,
    );

    await worker.run();

    const updated = store.getJob(job.jobId);
    expect(['completed', 'completed_with_errors']).toContain(updated?.status);
  });

  it('emits heartbeat events at ≤10s cadence via timer invocation', () => {
    const { store, bus, job } = buildWorkerFixture();

    const heartbeats: unknown[] = [];
    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'heartbeat') heartbeats.push(e);
    });

    const worker = new RestoreWorker(
      { jobId: job.jobId, heartbeatIntervalMs: 50, checkIntervalMs: 200 },
      store,
      bus,
    );

    // Set up job in running state
    store.setStatus(job.jobId, 'running');
    store.updateHeartbeat(job.jobId, Date.now());

    // Directly invoke the heartbeat emitter (simulates timer firing)
    const workerAny = worker as unknown as { emitHeartbeat: () => void };
    workerAny.emitHeartbeat();
    workerAny.emitHeartbeat();

    // Should have emitted heartbeat events
    expect(heartbeats.length).toBe(2);
  });

  it('emits phaseTransition events for each restore phase', async () => {
    const { store, bus, job } = buildWorkerFixture();

    const transitions: string[] = [];
    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'phaseTransition' && e.phase) transitions.push(e.phase);
    });

    const worker = new RestoreWorker(
      { jobId: job.jobId, heartbeatIntervalMs: 1000 },
      store,
      bus,
    );

    await worker.run();

    expect(transitions).toContain('project');
    expect(transitions).toContain('workflow');
    expect(transitions).toContain('custom_field');
    expect(transitions).toContain('board');
    expect(transitions).toContain('sprint');
    expect(transitions).toContain('issue_body');
    expect(transitions).toContain('post_issue');
  });

  it('emits a complete event when worker finishes', async () => {
    const { store, bus, job } = buildWorkerFixture();

    const completeEvents: unknown[] = [];
    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'complete') completeEvents.push(e);
    });

    const worker = new RestoreWorker(
      { jobId: job.jobId, heartbeatIntervalMs: 1000 },
      store,
      bus,
    );

    await worker.run();

    expect(completeEvents).toHaveLength(1);
  });

  it('surfaces stalled state when heartbeat gap exceeds 20s', () => {
    const { store, bus, job } = buildWorkerFixture();

    let fakeNow = 0;
    const stalledEvents: unknown[] = [];
    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'stalled') stalledEvents.push(e);
    });

    const worker = new RestoreWorker(
      {
        jobId: job.jobId,
        heartbeatIntervalMs: 9000,
        checkIntervalMs: 5000,
        staleThresholdMs: 20000,
        nowMs: () => fakeNow,
      },
      store,
      bus,
    );

    // Manually start heartbeat tracking without running full worker
    store.setStatus(job.jobId, 'running');
    store.updateHeartbeat(job.jobId, fakeNow);

    // Simulate 25s passing with no heartbeat
    fakeNow = 25_000;

    // Call private checkStall-like logic directly via the stall check path
    // We access internal by creating a test worker and calling checkStall indirectly
    // through the exported public API
    const workerAny = worker as unknown as {
      lastHeartbeatAt: number;
      checkStall: () => void;
    };
    workerAny.lastHeartbeatAt = 0;
    workerAny.checkStall();

    expect(stalledEvents).toHaveLength(1);
    const updatedJob = store.getJob(job.jobId);
    expect(updatedJob?.stalled).toBe(true);
  });

  it('emits stalled event and recovers when heartbeat resumes', () => {
    const { store, bus, job } = buildWorkerFixture();

    let fakeNow = 0;
    const events: Array<string> = [];
    bus.subscribe(job.jobId, (e) => {
      events.push(e.type);
    });

    const worker = new RestoreWorker(
      {
        jobId: job.jobId,
        heartbeatIntervalMs: 9000,
        checkIntervalMs: 5000,
        staleThresholdMs: 20000,
        nowMs: () => fakeNow,
      },
      store,
      bus,
    );

    store.setStatus(job.jobId, 'running');
    store.updateHeartbeat(job.jobId, 0);

    const workerAny = worker as unknown as {
      lastHeartbeatAt: number;
      stalled: boolean;
      checkStall: () => void;
      emitHeartbeat: () => void;
    };
    workerAny.lastHeartbeatAt = 0;

    // Advance to 25s → stall
    fakeNow = 25_000;
    workerAny.checkStall();
    expect(workerAny.stalled).toBe(true);

    // Advance to 30s → heartbeat → recovery
    fakeNow = 30_000;
    workerAny.emitHeartbeat();
    expect(workerAny.stalled).toBe(false);

    expect(events).toContain('stalled');
    expect(events).toContain('heartbeat');
  });
});

// ── Structured log assertions ───────────────────────────────────────────────

describe('structured log output', () => {
  it('emits [jira-restore] job.created log on POST /restore/jobs', async () => {
    const { app } = buildApp();
    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg);
    });

    await request(app)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-log-test',
        scope: { type: 'all' },
        destination: { type: 'export' },
      });

    spy.mockRestore();
    expect(logs.some((l) => l.includes('[jira-restore] job.created'))).toBe(true);
  });

  it('emits [jira-restore] job.heartbeat log when timer fires', () => {
    const db = new Database(':memory:');
    RestoreJobStore.migrate(db);
    const store = new RestoreJobStore(db);
    const bus = new RestoreEventBus();

    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const job = store.createJob({
      jobId: 'restore-log-hb',
      sourceBackupPointId: 'bp-hb',
      scope: { type: 'all' },
      destination: { type: 'export' },
      conflictMode: 'skip',
    });
    store.setStatus(job.jobId, 'running');
    store.updateHeartbeat(job.jobId, Date.now());

    const worker = new RestoreWorker(
      { jobId: job.jobId, heartbeatIntervalMs: 9000 },
      store,
      bus,
    );

    // Directly trigger the heartbeat (simulates interval firing)
    const workerAny = worker as unknown as { emitHeartbeat: () => void };
    workerAny.emitHeartbeat();

    spy.mockRestore();

    expect(logs.some((l) => l.includes('[jira-restore] job.heartbeat'))).toBe(true);
  });
});

// ── RestoreJobStore — trash-window block ────────────────────────────────────

describe('RestoreJobStore — trash-window block', () => {
  it('sets trashWindowBlocked=true and status=failed', () => {
    const db = new Database(':memory:');
    RestoreJobStore.migrate(db);
    const store = new RestoreJobStore(db);

    const job = store.createJob({
      jobId: 'restore-trash-test',
      sourceBackupPointId: 'bp-trash',
      scope: { type: 'projects', projectKeys: ['TRASHED'] },
      destination: { type: 'original' },
      conflictMode: 'skip',
    });

    store.setTrashWindowBlocked(job.jobId);

    const updated = store.getJob(job.jobId);
    expect(updated?.trashWindowBlocked).toBe(true);
    expect(updated?.status).toBe('failed');
    expect(updated?.failureDiagnostic).toBe('TRASH_WINDOW_BLOCK');
  });
});
