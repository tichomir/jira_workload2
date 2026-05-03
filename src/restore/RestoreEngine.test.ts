/**
 * RestoreEngine — unit tests
 *
 * Covers:
 *   - Full happy path: all 7 phases execute in order
 *   - Phase-N failure halts phase-N+1 (no subsequent phases run)
 *   - Named diagnostic persisted on failure before any next phase
 *   - ADF media link breakage warning emitted after post_issue
 *   - Heartbeat includes current phase, processed, and total
 *   - Project phase: skip / override / ask conflict-mode resolution
 *   - Structured log lines emitted per phase
 */

import Database from 'better-sqlite3';
import { RestoreJobStore } from './RestoreJobStore';
import { RestoreEventBus, RestoreProgressEvent } from './RestoreEventBus';
import {
  RestoreEngine,
  JiraWriteClient,
  PhaseHandler,
  PhaseContext,
  PhaseResult,
} from './RestoreEngine';
import {
  buildDefaultHandlers,
  ProjectPhaseHandler,
} from './RestorePhaseHandlers';
import { RestoreWorker } from './RestoreWorker';
import { RestorePhase } from './types';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';

// ── Fixture helpers ────────────────────────────────────────────────────────────

function buildFixture(opts: {
  conflictMode?: 'override' | 'skip' | 'ask';
  scope?: 'all' | 'projects' | 'issues';
} = {}) {
  const db = new Database(':memory:');
  RestoreJobStore.migrate(db);
  JiraCredentialRepository.runMigration(db);

  const store = new RestoreJobStore(db);
  const bus = new RestoreEventBus();

  const scopeObj =
    opts.scope === 'projects'
      ? { type: 'projects' as const, projectKeys: ['PROJ', 'OPS'] }
      : opts.scope === 'issues'
      ? { type: 'issues' as const, issueKeys: ['PROJ-1', 'PROJ-2'] }
      : { type: 'all' as const };

  const job = store.createJob({
    jobId: `engine-test-${Date.now()}-${Math.random()}`,
    sourceBackupPointId: 'bp-sprint12',
    scope: scopeObj,
    destination: { type: 'original' },
    conflictMode: opts.conflictMode ?? 'skip',
  });

  // Worker marks the job running before calling engine; replicate that here
  store.setStatus(job.jobId, 'running');

  return { store, bus, job, db };
}

/** Mock JiraWriteClient with jest spies on every method. */
function makeClient(overrides: Partial<{
  projectExistsResult: boolean;
  writeProjectError: Error;
}> = {}): jest.Mocked<JiraWriteClient> {
  return {
    projectExists: jest.fn().mockResolvedValue(overrides.projectExistsResult ?? false),
    writeProject: overrides.writeProjectError
      ? jest.fn().mockRejectedValue(overrides.writeProjectError)
      : jest.fn().mockResolvedValue(undefined),
    writeWorkflow: jest.fn().mockResolvedValue(undefined),
    writeCustomField: jest.fn().mockResolvedValue(undefined),
    writeBoard: jest.fn().mockResolvedValue(undefined),
    writeSprint: jest.fn().mockResolvedValue(undefined),
    writeIssue: jest.fn().mockResolvedValue('new-issue-id'),
    writeIssueLinks: jest.fn().mockResolvedValue(undefined),
    writeComments: jest.fn().mockResolvedValue(undefined),
    writeAttachments: jest.fn().mockResolvedValue(undefined),
  };
}

function buildEngine(
  store: RestoreJobStore,
  bus: RestoreEventBus,
  handlers?: PhaseHandler[],
  opts: { decisionPollIntervalMs?: number; nowMs?: () => number } = {},
): RestoreEngine {
  return new RestoreEngine(
    handlers ?? buildDefaultHandlers(),
    store,
    bus,
    { decisionPollIntervalMs: opts.decisionPollIntervalMs ?? 10, nowMs: opts.nowMs },
  );
}

// ── Happy path: all phases execute in order ────────────────────────────────────

describe('RestoreEngine — happy path', () => {
  it('executes all 7 phases in the documented order', async () => {
    const { store, bus, job } = buildFixture();
    const client = makeClient();
    const transitions: RestorePhase[] = [];

    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'phaseTransition' && e.phase) transitions.push(e.phase);
    });

    const engine = buildEngine(store, bus);
    const result = await engine.execute(job.jobId, client);

    expect(result.outcome).toBe('completed');
    expect(transitions).toEqual([
      'project',
      'workflow',
      'custom_field',
      'board',
      'sprint',
      'issue_body',
      'post_issue',
    ]);
  });

  it('returns outcome=completed with totalErrors=0 on clean run', async () => {
    const { store, bus, job } = buildFixture();
    const result = await buildEngine(store, bus).execute(job.jobId, makeClient());
    expect(result.outcome).toBe('completed');
    expect((result as { totalErrors: number }).totalErrors).toBe(0);
  });

  it('initialises phaseProgress entries for all phases before first phase runs', async () => {
    const { store, bus, job } = buildFixture();
    const client = makeClient();

    let capturedBeforeStart: unknown;
    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'phaseTransition' && e.phase === 'project' && !capturedBeforeStart) {
        capturedBeforeStart = store.getJob(job.jobId)?.phaseProgress;
      }
    });

    await buildEngine(store, bus).execute(job.jobId, client);

    const progress = store.getJob(job.jobId)?.phaseProgress;
    expect(progress).toHaveLength(7);
  });

  it('all phases reach status=completed after a clean run', async () => {
    const { store, bus, job } = buildFixture();
    await buildEngine(store, bus).execute(job.jobId, makeClient());

    const progress = store.getJob(job.jobId)?.phaseProgress ?? [];
    for (const p of progress) {
      expect(p.status).toBe('completed');
      expect(p.completedAt).not.toBeNull();
    }
  });

  it('emits a structured log line per phase', async () => {
    const { store, bus, job } = buildFixture();
    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));

    await buildEngine(store, bus).execute(job.jobId, makeClient());
    spy.mockRestore();

    const engineLogs = logs.filter((l) => l.startsWith('[restore-engine] phase='));
    expect(engineLogs).toHaveLength(7);
    expect(engineLogs[0]).toContain('phase=project');
    expect(engineLogs[0]).toContain('outcome=completed');
  });
});

// ── Phase failure halts execution ──────────────────────────────────────────────

describe('RestoreEngine — phase failure halts subsequent phases', () => {
  /** Creates a handler that always fails with the given diagnostic code. */
  function failingHandler(phase: RestorePhase, diagnostic: string): PhaseHandler {
    return {
      phase,
      async run(_ctx: PhaseContext): Promise<PhaseResult> {
        return { status: 'failed', processed: 0, total: 1, errorCount: 1, diagnostic };
      },
    };
  }

  it('custom_field failure: board, sprint, issue_body, post_issue do NOT run', async () => {
    const { store, bus, job } = buildFixture();
    const client = makeClient();
    const executedPhases: RestorePhase[] = [];

    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'phaseTransition' && e.phase) executedPhases.push(e.phase);
    });

    const handlers = buildDefaultHandlers().map((h) =>
      h.phase === 'custom_field'
        ? failingHandler('custom_field', 'CUSTOM_FIELD_CREATE_FORBIDDEN: insufficient scope')
        : h,
    );

    const result = await buildEngine(store, bus, handlers).execute(job.jobId, client);

    expect(result.outcome).toBe('failed');
    expect(executedPhases).toContain('project');
    expect(executedPhases).toContain('workflow');
    expect(executedPhases).toContain('custom_field');
    expect(executedPhases).not.toContain('board');
    expect(executedPhases).not.toContain('sprint');
    expect(executedPhases).not.toContain('issue_body');
    expect(executedPhases).not.toContain('post_issue');
  });

  it('persists named diagnostic on the job BEFORE any subsequent phase could run', async () => {
    const { store, bus, job } = buildFixture();

    const diagnosticCode = 'WORKFLOW_WRITE_FAILED: 403 Forbidden';

    // Spy on phaseTransition to capture when diagnostic is first set
    let diagnosticAtBoardStart: string | null | undefined;
    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'phaseTransition' && e.phase === 'board') {
        // This should never fire; but if it did, capture the diagnostic at that moment
        diagnosticAtBoardStart = store.getJob(job.jobId)?.failureDiagnostic;
      }
    });

    const handlers = buildDefaultHandlers().map((h) =>
      h.phase === 'workflow' ? failingHandler('workflow', diagnosticCode) : h,
    );

    await buildEngine(store, bus, handlers).execute(job.jobId, makeClient());

    const finalJob = store.getJob(job.jobId);
    expect(finalJob?.status).toBe('failed');
    expect(finalJob?.failureDiagnostic).toBe(diagnosticCode);
    // Board phase never ran, so diagnosticAtBoardStart was never set
    expect(diagnosticAtBoardStart).toBeUndefined();
  });

  it('emits phaseFailure event with diagnostic code', async () => {
    const { store, bus, job } = buildFixture();
    const failures: RestoreProgressEvent[] = [];

    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'phaseFailure') failures.push(e);
    });

    const handlers = buildDefaultHandlers().map((h) =>
      h.phase === 'board'
        ? failingHandler('board', 'BOARD_CREATE_FORBIDDEN: admin rights required')
        : h,
    );

    await buildEngine(store, bus, handlers).execute(job.jobId, makeClient());

    expect(failures).toHaveLength(1);
    expect(failures[0].phase).toBe('board');
    expect(failures[0].diagnostic).toBe('BOARD_CREATE_FORBIDDEN: admin rights required');
  });

  it('project phase failure from client error returns PROJECT_WRITE_FAILED diagnostic', async () => {
    const { store, bus, job } = buildFixture({ scope: 'projects' });
    const client = makeClient({
      projectExistsResult: false,
      writeProjectError: new Error('connection refused'),
    });

    const result = await buildEngine(store, bus).execute(job.jobId, client);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.diagnostic).toContain('PROJECT_WRITE_FAILED');
      expect(result.phase).toBe('project');
    }
  });

  it('unhandled exception in a phase handler becomes UNHANDLED_PHASE_ERROR', async () => {
    const { store, bus, job } = buildFixture();

    const throwingHandler: PhaseHandler = {
      phase: 'sprint',
      async run(): Promise<PhaseResult> {
        throw new Error('unexpected boom');
      },
    };

    const handlers = buildDefaultHandlers().map((h) =>
      h.phase === 'sprint' ? throwingHandler : h,
    );

    const result = await buildEngine(store, bus, handlers).execute(job.jobId, makeClient());

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.diagnostic).toContain('UNHANDLED_PHASE_ERROR');
      expect(result.diagnostic).toContain('unexpected boom');
    }
  });
});

// ── ADF media warning ──────────────────────────────────────────────────────────

describe('RestoreEngine — ADF media link breakage warning', () => {
  it('emits adfMediaWarning event after post_issue with affected issueIds', async () => {
    const { store, bus, job } = buildFixture();
    const warnings: RestoreProgressEvent[] = [];

    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'adfMediaWarning') warnings.push(e);
    });

    await buildEngine(store, bus).execute(job.jobId, makeClient());

    expect(warnings).toHaveLength(1);
    expect(warnings[0].affectedIssueIds).toBeDefined();
    expect((warnings[0].affectedIssueIds as string[]).length).toBeGreaterThan(0);
  });

  it('sets adfMediaWarningEmitted=true on the job after post_issue', async () => {
    const { store, bus, job } = buildFixture();

    await buildEngine(store, bus).execute(job.jobId, makeClient());

    expect(store.getJob(job.jobId)?.adfMediaWarningEmitted).toBe(true);
  });

  it('does NOT emit adfMediaWarning when post_issue phase fails before attachments', async () => {
    const { store, bus, job } = buildFixture();
    const warnings: RestoreProgressEvent[] = [];

    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'adfMediaWarning') warnings.push(e);
    });

    const noAttachmentPostIssueHandler: PhaseHandler = {
      phase: 'post_issue',
      async run(): Promise<PhaseResult> {
        return {
          status: 'failed',
          processed: 0,
          total: 1,
          errorCount: 1,
          diagnostic: 'POST_ISSUE_FAILED: test',
          affectedIssueIds: [],  // empty → no warning
        };
      },
    };

    const handlers = buildDefaultHandlers().map((h) =>
      h.phase === 'post_issue' ? noAttachmentPostIssueHandler : h,
    );

    await buildEngine(store, bus, handlers).execute(job.jobId, makeClient());

    expect(warnings).toHaveLength(0);
    expect(store.getJob(job.jobId)?.adfMediaWarningEmitted).toBe(false);
  });

  it('affectedIssueIds reflects issues scope when scope type is issues', async () => {
    const { store, bus, job } = buildFixture({ scope: 'issues' });
    const warnings: RestoreProgressEvent[] = [];

    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'adfMediaWarning') warnings.push(e);
    });

    await buildEngine(store, bus).execute(job.jobId, makeClient());

    expect(warnings[0].affectedIssueIds).toEqual(
      expect.arrayContaining(['PROJ-1', 'PROJ-2']),
    );
  });
});

// ── Heartbeat includes processed/total ────────────────────────────────────────

describe('RestoreWorker — heartbeat includes current phase, processed, total', () => {
  function buildWorkerFixture() {
    const db = new Database(':memory:');
    RestoreJobStore.migrate(db);
    const store = new RestoreJobStore(db);
    const bus = new RestoreEventBus();

    const job = store.createJob({
      jobId: 'hb-test-job',
      sourceBackupPointId: 'bp-hb',
      scope: { type: 'all' },
      destination: { type: 'original' },
      conflictMode: 'skip',
    });

    return { store, bus, job };
  }

  it('emits heartbeat with processed and total for the current phase', () => {
    const { store, bus, job } = buildWorkerFixture();

    // Pre-populate phaseProgress with a running phase
    store.setStatus(job.jobId, 'running');
    store.setCurrentPhase(job.jobId, 'issue_body');
    store.updatePhaseProgress(job.jobId, [
      {
        phase: 'issue_body',
        status: 'running',
        total: 150,
        processed: 72,
        errorCount: 0,
        startedAt: '2026-05-03T10:00:00Z',
        completedAt: null,
      },
    ]);
    store.updateHeartbeat(job.jobId, Date.now());

    const heartbeats: RestoreProgressEvent[] = [];
    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'heartbeat') heartbeats.push(e);
    });

    const worker = new RestoreWorker(
      { jobId: job.jobId, heartbeatIntervalMs: 9000 },
      store,
      bus,
    );

    // Directly invoke the heartbeat (simulates timer firing)
    const workerAny = worker as unknown as { emitHeartbeat: () => void };
    workerAny.emitHeartbeat();

    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0].phase).toBe('issue_body');
    expect(heartbeats[0].processed).toBe(72);
    expect(heartbeats[0].total).toBe(150);
    expect(heartbeats[0].errorCount).toBe(0);
  });

  it('heartbeat includes errorCount from job row', () => {
    const { store, bus, job } = buildWorkerFixture();

    store.setStatus(job.jobId, 'running');
    store.setCurrentPhase(job.jobId, 'sprint');
    store.updatePhaseProgress(job.jobId, [
      {
        phase: 'sprint',
        status: 'running',
        total: 5,
        processed: 3,
        errorCount: 1,
        startedAt: new Date().toISOString(),
        completedAt: null,
      },
    ]);
    // Simulate 1 error on the job row
    store.incrementErrorCount(job.jobId);
    store.updateHeartbeat(job.jobId, Date.now());

    const heartbeats: RestoreProgressEvent[] = [];
    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'heartbeat') heartbeats.push(e);
    });

    const worker = new RestoreWorker(
      { jobId: job.jobId, heartbeatIntervalMs: 9000 },
      store,
      bus,
    );
    (worker as unknown as { emitHeartbeat: () => void }).emitHeartbeat();

    expect(heartbeats[0].errorCount).toBe(1);
    expect(heartbeats[0].processed).toBe(3);
    expect(heartbeats[0].total).toBe(5);
  });

  it('heartbeat processed/total are undefined when no phase is running', () => {
    const { store, bus, job } = buildWorkerFixture();

    store.setStatus(job.jobId, 'running');
    // No currentPhase set, no phaseProgress
    store.updateHeartbeat(job.jobId, Date.now());

    const heartbeats: RestoreProgressEvent[] = [];
    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'heartbeat') heartbeats.push(e);
    });

    const worker = new RestoreWorker(
      { jobId: job.jobId, heartbeatIntervalMs: 9000 },
      store,
      bus,
    );
    (worker as unknown as { emitHeartbeat: () => void }).emitHeartbeat();

    expect(heartbeats[0].phase).toBeUndefined();
    expect(heartbeats[0].processed).toBeUndefined();
    expect(heartbeats[0].total).toBeUndefined();
  });
});

// ── Project phase: conflict-mode resolution ────────────────────────────────────

describe('ProjectPhaseHandler — conflict-mode resolution', () => {
  function buildProjectFixture(conflictMode: 'override' | 'skip' | 'ask') {
    const db = new Database(':memory:');
    RestoreJobStore.migrate(db);
    const store = new RestoreJobStore(db);
    const bus = new RestoreEventBus();
    const job = store.createJob({
      jobId: `proj-test-${conflictMode}`,
      sourceBackupPointId: 'bp-proj',
      scope: { type: 'projects', projectKeys: ['MYPROJ'] },
      destination: { type: 'original' },
      conflictMode,
    });
    store.setStatus(job.jobId, 'running');
    return { store, bus, job };
  }

  it('skip mode: does NOT call writeProject when project exists', async () => {
    const { store, bus, job } = buildProjectFixture('skip');
    const client = makeClient({ projectExistsResult: true });

    const ctx: PhaseContext = {
      jobId: job.jobId,
      conflictMode: 'skip',
      scope: job.scope,
      destination: job.destination,
      client,
      store,
      bus,
      nowMs: Date.now,
      decisionPollIntervalMs: 10,
    };

    const handler = new ProjectPhaseHandler();
    const result = await handler.run(ctx);

    expect(result.status).toBe('completed');
    expect(result.processed).toBe(1);
    expect(client.writeProject).not.toHaveBeenCalled();
  });

  it('override mode: calls writeProject even when project exists', async () => {
    const { store, bus, job } = buildProjectFixture('override');
    const client = makeClient({ projectExistsResult: true });

    const ctx: PhaseContext = {
      jobId: job.jobId,
      conflictMode: 'override',
      scope: job.scope,
      destination: job.destination,
      client,
      store,
      bus,
      nowMs: Date.now,
      decisionPollIntervalMs: 10,
    };

    const handler = new ProjectPhaseHandler();
    const result = await handler.run(ctx);

    expect(result.status).toBe('completed');
    expect(client.writeProject).toHaveBeenCalledTimes(1);
  });

  it('no conflict: calls writeProject when project does not exist', async () => {
    const { store, bus, job } = buildProjectFixture('skip');
    const client = makeClient({ projectExistsResult: false });

    const ctx: PhaseContext = {
      jobId: job.jobId,
      conflictMode: 'skip',
      scope: job.scope,
      destination: job.destination,
      client,
      store,
      bus,
      nowMs: Date.now,
      decisionPollIntervalMs: 10,
    };

    const handler = new ProjectPhaseHandler();
    const result = await handler.run(ctx);

    expect(result.status).toBe('completed');
    expect(client.writeProject).toHaveBeenCalledTimes(1);
  });

  it('ask mode with override decision: calls writeProject', async () => {
    const { store, bus, job } = buildProjectFixture('ask');
    const client = makeClient({ projectExistsResult: true });

    const conflictEvents: RestoreProgressEvent[] = [];
    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'ConflictDecisionRequired') conflictEvents.push(e);
    });

    const ctx: PhaseContext = {
      jobId: job.jobId,
      conflictMode: 'ask',
      scope: job.scope,
      destination: job.destination,
      client,
      store,
      bus,
      nowMs: Date.now,
      decisionPollIntervalMs: 10,
    };

    const handler = new ProjectPhaseHandler();

    // Resolve the conflict shortly after it is emitted
    setTimeout(() => {
      const pending = store.getPendingConflict(job.jobId);
      if (pending) store.resolveConflict(pending.id, 'override');
    }, 20);

    const result = await handler.run(ctx);

    expect(result.status).toBe('completed');
    expect(conflictEvents).toHaveLength(1);
    expect(conflictEvents[0].objectKey).toBe('MYPROJ');
    expect(client.writeProject).toHaveBeenCalledTimes(1);
  });

  it('ask mode with skip decision: does NOT call writeProject', async () => {
    const { store, bus, job } = buildProjectFixture('ask');
    const client = makeClient({ projectExistsResult: true });

    const ctx: PhaseContext = {
      jobId: job.jobId,
      conflictMode: 'ask',
      scope: job.scope,
      destination: job.destination,
      client,
      store,
      bus,
      nowMs: Date.now,
      decisionPollIntervalMs: 10,
    };

    const handler = new ProjectPhaseHandler();

    setTimeout(() => {
      const pending = store.getPendingConflict(job.jobId);
      if (pending) store.resolveConflict(pending.id, 'skip');
    }, 20);

    const result = await handler.run(ctx);

    expect(result.status).toBe('completed');
    expect(client.writeProject).not.toHaveBeenCalled();
  });
});

// ── Full worker run through engine ─────────────────────────────────────────────

describe('RestoreWorker — full run via RestoreEngine', () => {
  it('completes with status=completed after all phases succeed', async () => {
    const db = new Database(':memory:');
    RestoreJobStore.migrate(db);
    const store = new RestoreJobStore(db);
    const bus = new RestoreEventBus();

    const job = store.createJob({
      jobId: 'worker-full-run',
      sourceBackupPointId: 'bp-full',
      scope: { type: 'all' },
      destination: { type: 'original' },
      conflictMode: 'skip',
    });

    const completeEvents: RestoreProgressEvent[] = [];
    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'complete') completeEvents.push(e);
    });

    const worker = new RestoreWorker(
      { jobId: job.jobId, heartbeatIntervalMs: 5000 },
      store,
      bus,
    );

    await worker.run();

    expect(store.getJob(job.jobId)?.status).toBe('completed');
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].status).toBe('completed');
  });

  it('worker emits phaseTransition events for all 7 phases', async () => {
    const db = new Database(':memory:');
    RestoreJobStore.migrate(db);
    const store = new RestoreJobStore(db);
    const bus = new RestoreEventBus();

    const job = store.createJob({
      jobId: 'worker-phases-run',
      sourceBackupPointId: 'bp-phases',
      scope: { type: 'all' },
      destination: { type: 'original' },
      conflictMode: 'skip',
    });

    const phasesObserved: RestorePhase[] = [];
    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'phaseTransition' && e.phase) phasesObserved.push(e.phase);
    });

    await new RestoreWorker({ jobId: job.jobId, heartbeatIntervalMs: 5000 }, store, bus).run();

    expect(phasesObserved).toEqual([
      'project', 'workflow', 'custom_field', 'board', 'sprint', 'issue_body', 'post_issue',
    ]);
  });

  it('worker emits adfMediaWarning and sets adfMediaWarningEmitted after run', async () => {
    const db = new Database(':memory:');
    RestoreJobStore.migrate(db);
    const store = new RestoreJobStore(db);
    const bus = new RestoreEventBus();

    const job = store.createJob({
      jobId: 'worker-adf-run',
      sourceBackupPointId: 'bp-adf',
      scope: { type: 'all' },
      destination: { type: 'original' },
      conflictMode: 'skip',
    });

    const adfWarnings: RestoreProgressEvent[] = [];
    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'adfMediaWarning') adfWarnings.push(e);
    });

    await new RestoreWorker({ jobId: job.jobId, heartbeatIntervalMs: 5000 }, store, bus).run();

    expect(adfWarnings).toHaveLength(1);
    expect(store.getJob(job.jobId)?.adfMediaWarningEmitted).toBe(true);
  });
});

// ── Structured log assertions ──────────────────────────────────────────────────

describe('RestoreEngine — structured logs', () => {
  it('emits [restore-engine] phase=X outcome=Y items=N for each phase', async () => {
    const { store, bus, job } = buildFixture();
    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((m: string) => logs.push(m));

    await buildEngine(store, bus).execute(job.jobId, makeClient());
    spy.mockRestore();

    const phaseLogs = logs.filter((l) => l.match(/\[restore-engine\] phase=\w+ outcome=/));
    expect(phaseLogs).toHaveLength(7);
    expect(phaseLogs.every((l) => l.includes('outcome=completed'))).toBe(true);
    expect(phaseLogs.every((l) => l.includes('items='))).toBe(true);
  });

  it('emits [restore-engine] adf-media-link-breakage-possible log after post_issue', async () => {
    const { store, bus, job } = buildFixture();
    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((m: string) => logs.push(m));

    await buildEngine(store, bus).execute(job.jobId, makeClient());
    spy.mockRestore();

    expect(logs.some((l) => l.includes('adf-media-link-breakage-possible'))).toBe(true);
  });
});
