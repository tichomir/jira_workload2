/**
 * Sprint 7 QA: SSE endpoint and snapshot JSON endpoint.
 *
 * Verifies GET /api/jobs/:jobId/events (SSE) and GET /api/jobs/:jobId (snapshot).
 *
 * Acceptance criteria:
 *   - SSE stream emits heartbeat events with phase, progress counters, error count, status
 *   - GET /api/jobs/:jobId returns equivalent snapshot JSON
 *   - Stalled status (>20s no heartbeat) is reflected in both stream and snapshot
 *   - Happy-path: job completes, SSE delivers terminal event with 'Completed with N errors'
 *   - Error-path (stalled): stalled job surfaces stalled status via snapshot
 *   - Endpoints sit behind canonical auth middleware (x-cloud-id validation)
 *
 * All tests use the REAL JobRouter, JobStore, HeartbeatEmitter, and
 * StalledJobDetector — no mocking of those components.
 */

import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { JobStore } from '../jobs/JobStore';
import { JobEventBus, JobProgressEvent } from '../jobs/JobEventBus';
import { HeartbeatEmitter } from '../jobs/HeartbeatEmitter';
import { StalledJobDetector } from '../jobs/StalledJobDetector';
import { createJobRouter } from '../jobs/JobRouter';
import { JiraCredentialRepository, TokenSet } from '../db/JiraCredentialRepository';

// ── Constants ─────────────────────────────────────────────────────────────────

const CLOUD_ID = 'cloud-sse-test-001';
const SITE_URL = 'https://ssetest.atlassian.net';
const TOKENS: TokenSet = {
  accessToken: 'access_sse',
  refreshToken: 'refresh_sse',
  accessTokenExpiresAt: 9_999_999_999,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  JiraCredentialRepository.runMigration(db);
  JobStore.migrate(db);
  return db;
}

function makeApp(
  store: JobStore,
  bus: JobEventBus,
  db: Database.Database,
  opts: { allowUnauthenticated?: boolean } = {},
): ReturnType<typeof express> {
  const app = express();
  app.use(express.json());
  const credRepo = new JiraCredentialRepository(db);
  const router = createJobRouter(store, bus, credRepo, opts);
  app.use('/api/jobs', router);
  return app;
}

/**
 * Collects SSE events by connecting and buffering for `waitMs`.
 */
async function collectSse(
  app: ReturnType<typeof express>,
  jobId: string,
  waitMs = 300,
): Promise<JobProgressEvent[]> {
  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    const req = request(app)
      .get(`/api/jobs/${jobId}/events`)
      .buffer(false)
      .parse((res, callback) => {
        res.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
        setTimeout(() => {
          (res as unknown as { destroy: () => void }).destroy();
          callback(null, '');
        }, waitMs);
      });
    req.end(() => resolve());
  });

  const raw = chunks.join('');
  const events: JobProgressEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        events.push(JSON.parse(line.slice(6)) as JobProgressEvent);
      } catch {
        // skip malformed lines
      }
    }
  }
  return events;
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('Sprint 7 — SSE endpoint and snapshot API', () => {
  let db: Database.Database;
  let store: JobStore;
  let bus: JobEventBus;
  let credRepo: JiraCredentialRepository;

  beforeEach(() => {
    db = openDb();
    store = new JobStore(db);
    bus = new JobEventBus();
    credRepo = new JiraCredentialRepository(db);
    credRepo.upsertConnection(CLOUD_ID, TOKENS, 'client-sse-1', SITE_URL, 'account-sse-1');
  });

  afterEach(() => {
    db.close();
  });

  // ── Auth middleware ────────────────────────────────────────────────────────

  describe('auth middleware', () => {
    it('GET /api/jobs/:jobId returns 401 without x-cloud-id header', async () => {
      const app = makeApp(store, bus, db); // no allowUnauthenticated
      const jobId = 'auth-test-job';
      store.createJob(jobId, 'bp-auth', 'issues');

      const res = await request(app).get(`/api/jobs/${jobId}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_cloud_id');
    });

    it('GET /api/jobs/:jobId returns 401 with unknown x-cloud-id', async () => {
      const app = makeApp(store, bus, db);
      const jobId = 'auth-test-job-2';
      store.createJob(jobId, 'bp-auth-2', 'issues');

      const res = await request(app)
        .get(`/api/jobs/${jobId}`)
        .set('x-cloud-id', 'unknown-cloud');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_cloud_id');
    });

    it('GET /api/jobs/:jobId succeeds with valid x-cloud-id', async () => {
      const app = makeApp(store, bus, db);
      const jobId = 'auth-valid-job';
      store.createJob(jobId, 'bp-auth-valid', 'issues');

      const res = await request(app)
        .get(`/api/jobs/${jobId}`)
        .set('x-cloud-id', CLOUD_ID);
      expect(res.status).toBe(200);
      expect(res.body.jobId).toBe(jobId);
    });
  });

  // ── Happy path: job completes with N errors ───────────────────────────────

  describe('Happy path — job completes, SSE delivers terminal with Completed with N errors', () => {
    it(
      'SSE receives ≥1 heartbeat and terminal event; snapshot reflects completed_with_errors',
      async () => {
        jest.useFakeTimers();

        const jobId = 'sse-happy-001';
        const backupPointId = 'bp-sse-happy-001';
        const ERRORS = 2;
        const HEARTBEAT_MS = 9_000;
        const RUN_MS = 20_000; // advance 20s → ≥2 heartbeats

        const busEvents: JobProgressEvent[] = [];
        bus.subscribe(jobId, (e) => busEvents.push(e));

        const emitter = new HeartbeatEmitter(
          { jobId, backupPointId, phase: 'issues', heartbeatIntervalMs: HEARTBEAT_MS },
          store,
          bus,
        );

        emitter.start();

        // Simulate N failed items so final status is 'Completed with N errors'
        for (let i = 0; i < ERRORS; i++) {
          emitter.tick({ failed: true });
          store.insertJobError({
            jobId,
            backupPointId,
            itemType: 'JiraIssue',
            itemId: `SSE-ERR-${i + 1}`,
            errorCode: 'API_ERROR',
            errorMessage: `error ${i + 1}`,
            timestamp: new Date().toISOString(),
          });
        }
        // Simulate some successful items too (so status is completed_with_errors not failed)
        emitter.tick();
        emitter.tick();
        emitter.tick();

        // Advance 20s → heartbeats fire at 9s and 18s
        jest.advanceTimersByTime(RUN_MS);
        emitter.complete();

        jest.useRealTimers();

        // ── Event bus assertions ──────────────────────────────────────────

        const heartbeats = busEvents.filter((e) => e.type === 'heartbeat');
        const terminal = busEvents.find((e) => e.type === 'terminal');

        // ≥2 heartbeats over 20s at 9s intervals
        expect(heartbeats.length).toBeGreaterThanOrEqual(2);

        // Each heartbeat has required fields
        for (const hb of heartbeats) {
          expect(hb.jobId).toBe(jobId);
          expect(hb.backupPointId).toBe(backupPointId);
          expect(hb.phase).toBe('issues');
          expect(typeof hb.itemsProcessed).toBe('number');
          expect(typeof hb.itemsFailed).toBe('number');
          expect(hb.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        }

        // Terminal event present with correct error count
        expect(terminal).toBeDefined();
        expect(terminal!.type).toBe('terminal');
        expect(terminal!.itemsFailed).toBe(ERRORS);
        expect(terminal!.displayStatus).toContain(`${ERRORS} errors`);

        // ── Snapshot API assertions ───────────────────────────────────────

        const app = makeApp(store, bus, db, { allowUnauthenticated: true });

        const snapshotRes = await request(app).get(`/api/jobs/${jobId}`);
        expect(snapshotRes.status).toBe(200);
        expect(snapshotRes.body.jobId).toBe(jobId);
        expect(snapshotRes.body.status).toBe('completed_with_errors');
        expect(snapshotRes.body.displayStatus).toBe(`Completed with ${ERRORS} errors`);
        expect(snapshotRes.body.itemsFailed).toBe(ERRORS);
        expect(snapshotRes.body.backupPointId).toBe(backupPointId);
        expect(snapshotRes.body.errors).toHaveLength(ERRORS);
        expect(snapshotRes.body.stalled).toBe(false);

        // ── SSE replay assertions ─────────────────────────────────────────

        const sseEvents = await collectSse(app, jobId);
        const sseHeartbeats = sseEvents.filter((e) => e.type === 'heartbeat');
        const sseTerminal = sseEvents.find((e) => e.type === 'terminal');

        // SSE replay delivers ≥2 heartbeats (same events from job_events table)
        expect(sseHeartbeats.length).toBeGreaterThanOrEqual(2);

        // SSE terminal event carries itemsFailed
        expect(sseTerminal).toBeDefined();
        expect(sseTerminal!.itemsFailed).toBe(ERRORS);
        expect(sseTerminal!.backupPointId).toBe(backupPointId);

        // Heartbeat cadence: consecutive timestamps ≤10s apart
        const tsMs = sseHeartbeats.map((e) => new Date(e.timestamp).getTime());
        for (let i = 1; i < tsMs.length; i++) {
          expect(tsMs[i] - tsMs[i - 1]).toBeLessThanOrEqual(10_000);
        }
      },
      15_000,
    );
  });

  // ── Error path: stalled job surfaces stalled status ───────────────────────

  describe('Error path — stalled job surfaces stalled status in snapshot and stream', () => {
    it('stalled=true in snapshot after >20s without heartbeat', async () => {
      const jobId = 'sse-stall-001';
      const backupPointId = 'bp-sse-stall-001';

      // Synthetic clock: start at a large epoch so arithmetic is unambiguous
      let fakeMs = 10_000_000_000;

      store.createJob(jobId, backupPointId, 'issues', fakeMs);

      // Subscribe before firing detector so we capture the stalled event
      const busEvents: JobProgressEvent[] = [];
      bus.subscribeAll((e) => busEvents.push(e));

      // Advance synthetic clock by 25s — no heartbeat in between
      const PAUSE_MS = 25_000;
      fakeMs += PAUSE_MS;

      const detector = new StalledJobDetector(store, bus, {
        staleThresholdMs: 20_000,
        nowMs: () => fakeMs,
      });
      detector.check();

      const stalledEvent = busEvents.find((e) => e.type === 'stalled');
      expect(stalledEvent).toBeDefined();
      expect(stalledEvent!.jobId).toBe(jobId);
      expect(stalledEvent!.lastHeartbeatAgeMs).toBeGreaterThan(20_000);

      // ── Snapshot API reflects stalled state ───────────────────────────

      const app = makeApp(store, bus, db, { allowUnauthenticated: true });

      const snapshotRes = await request(app).get(`/api/jobs/${jobId}`);
      expect(snapshotRes.status).toBe(200);
      expect(snapshotRes.body.stalled).toBe(true);
      expect(snapshotRes.body.status).toBe('stalled');
      expect(snapshotRes.body.jobId).toBe(jobId);
    });

    it('returns 404 for unknown jobId on both snapshot and SSE endpoints', async () => {
      const app = makeApp(store, bus, db, { allowUnauthenticated: true });

      const snapshotRes = await request(app).get('/api/jobs/nonexistent-job');
      expect(snapshotRes.status).toBe(404);
      expect(snapshotRes.body.error).toBe('job_not_found');

      const sseRes = await request(app).get('/api/jobs/nonexistent-job/events');
      expect(sseRes.status).toBe(404);
      expect(sseRes.body.error).toBe('job_not_found');
    });
  });
});
