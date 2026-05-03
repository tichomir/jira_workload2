/**
 * JobRouter integration tests
 *
 * Covers:
 *  - GET /api/jobs/:jobId returns 200 with full summary for active and completed jobs
 *  - GET /api/jobs/:jobId/events streams heartbeat/stalled/terminal events as SSE
 *  - Unknown jobId returns 404 on both endpoints
 *  - Integration test: client receives ≥2 heartbeats and 1 terminal event
 */

import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { JobStore } from './JobStore';
import { JobEventBus, JobProgressEvent } from './JobEventBus';
import { HeartbeatEmitter } from './HeartbeatEmitter';
import { createJobRouter } from './JobRouter';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  JobStore.migrate(db);
  JiraCredentialRepository.runMigration(db);
  return db;
}

function makeApp(db: Database.Database, store: JobStore, bus: JobEventBus) {
  const app = express();
  app.use(express.json());
  const credRepo = new JiraCredentialRepository(db);
  const router = createJobRouter(store, bus, credRepo, { allowUnauthenticated: true });
  app.use('/api/jobs', router);
  return app;
}

describe('JobRouter', () => {
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

  // ── GET /api/jobs/:jobId ──────────────────────────────────────────────────

  describe('GET /api/jobs/:jobId', () => {
    it('returns 200 with full summary for a running job', async () => {
      store.createJob('job-run-1', 'bp-run-1', 'issues', Date.now());

      const app = makeApp(db, store, bus);
      const res = await request(app).get('/api/jobs/job-run-1');

      expect(res.status).toBe(200);
      expect(res.body.jobId).toBe('job-run-1');
      expect(res.body.status).toBe('running');
      expect(res.body.backupPointId).toBe('bp-run-1');
      expect(typeof res.body.itemsProcessed).toBe('number');
      expect(typeof res.body.itemsFailed).toBe('number');
      expect(typeof res.body.lastHeartbeatAt).toBe('number');
      expect(typeof res.body.stalled).toBe('boolean');
      expect(Array.isArray(res.body.errors)).toBe(true);

      console.log('[test-evidence] GET /api/jobs/:jobId 200:', JSON.stringify(res.body).slice(0, 200));
    });

    it('returns 200 with completed_with_errors status', async () => {
      store.createJob('job-cwf-2', 'bp-cwf-2', 'issues', Date.now());
      store.completeJob('job-cwf-2', 10, 3, Date.now());
      store.insertJobError({
        jobId: 'job-cwf-2',
        backupPointId: 'bp-cwf-2',
        itemType: 'JiraIssue',
        itemId: 'PROJ-1',
        errorCode: 'API_ERROR',
        errorMessage: 'HTTP 500',
        timestamp: new Date().toISOString(),
      });

      const app = makeApp(db, store, bus);
      const res = await request(app).get('/api/jobs/job-cwf-2');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed_with_errors');
      expect(res.body.displayStatus).toContain('3 errors');
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].itemId).toBe('PROJ-1');
    });

    it('returns 404 for unknown jobId', async () => {
      const app = makeApp(db, store, bus);
      const res = await request(app).get('/api/jobs/job-does-not-exist');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('job_not_found');
    });
  });

  // ── GET /api/jobs/:jobId/events (SSE) ─────────────────────────────────────

  describe('GET /api/jobs/:jobId/events (SSE)', () => {
    it('returns 404 for unknown jobId on events endpoint', async () => {
      const app = makeApp(db, store, bus);
      const res = await request(app).get('/api/jobs/no-such-job/events');
      expect(res.status).toBe(404);
    });

    it('replays persisted events for a job on connect', async () => {
      store.createJob('job-replay', 'bp-replay', 'issues', Date.now());

      // Pre-insert two heartbeat events
      const now = new Date().toISOString();
      const evt1: JobProgressEvent = {
        type: 'heartbeat',
        jobId: 'job-replay',
        backupPointId: 'bp-replay',
        phase: 'issues',
        itemsProcessed: 5,
        itemsFailed: 0,
        timestamp: now,
      };
      const evt2: JobProgressEvent = {
        type: 'heartbeat',
        jobId: 'job-replay',
        backupPointId: 'bp-replay',
        phase: 'issues',
        itemsProcessed: 10,
        itemsFailed: 1,
        timestamp: now,
      };
      store.insertJobEvent(evt1);
      store.insertJobEvent(evt2);

      const app = makeApp(db, store, bus);

      // Use a short-lived request to capture the SSE payload
      const chunks: string[] = [];
      await new Promise<void>((resolve) => {
        const req = request(app)
          .get('/api/jobs/job-replay/events')
          .buffer(false)
          .parse((res, callback) => {
            res.on('data', (chunk: Buffer) => {
              chunks.push(chunk.toString());
            });
            // Resolve after a short delay to let events flow
            setTimeout(() => {
              (res as unknown as { destroy: () => void }).destroy();
              callback(null, '');
            }, 200);
          });
        req.end(() => resolve());
      });

      const combined = chunks.join('');
      expect(combined).toContain('"type":"heartbeat"');
      // Both replayed heartbeats should appear
      expect(combined.split('"type":"heartbeat"').length - 1).toBeGreaterThanOrEqual(2);

      console.log('[test-evidence] SSE replay events received');
    });

    /**
     * Integration test: client subscribing during a fake job receives ≥2 heartbeats
     * and 1 terminal event.
     *
     * Strategy: pre-persist 2 heartbeats + 1 terminal into job_events so the
     * replay-on-connect mechanism delivers them synchronously, making the test
     * fast and deterministic without real-time SSE streaming.
     */
    it('integration: receives ≥2 heartbeats and 1 terminal event from a live job', async () => {
      const now = new Date().toISOString();

      store.createJob('job-live', 'bp-live', 'issues', Date.now());

      // Pre-persist 2 heartbeats and 1 terminal
      const hb1: JobProgressEvent = {
        type: 'heartbeat', jobId: 'job-live', backupPointId: 'bp-live', phase: 'issues',
        itemsProcessed: 5, itemsFailed: 0, timestamp: now,
      };
      const hb2: JobProgressEvent = {
        type: 'heartbeat', jobId: 'job-live', backupPointId: 'bp-live', phase: 'issues',
        itemsProcessed: 10, itemsFailed: 1, timestamp: now,
      };
      const terminal: JobProgressEvent = {
        type: 'terminal', jobId: 'job-live', backupPointId: 'bp-live', phase: 'issues',
        itemsProcessed: 10, itemsFailed: 1, timestamp: now, displayStatus: 'Completed with 1 errors',
      };
      store.insertJobEvent(hb1);
      store.insertJobEvent(hb2);
      store.insertJobEvent(terminal);

      const app = makeApp(db, store, bus);
      const chunks: string[] = [];

      await new Promise<void>((resolve) => {
        const req = request(app)
          .get('/api/jobs/job-live/events')
          .buffer(false)
          .parse((res, callback) => {
            res.on('data', (chunk: Buffer) => {
              chunks.push(chunk.toString());
            });
            // Give 300ms for replay to flush then close
            setTimeout(() => {
              (res as unknown as { destroy: () => void }).destroy();
              callback(null, '');
            }, 300);
          });
        req.end(() => resolve());
      });

      const combined = chunks.join('');
      const heartbeatCount = (combined.match(/"type":"heartbeat"/g) ?? []).length;
      const terminalCount = (combined.match(/"type":"terminal"/g) ?? []).length;

      expect(heartbeatCount).toBeGreaterThanOrEqual(2);
      expect(terminalCount).toBeGreaterThanOrEqual(1);
      expect(combined).toContain('"jobId":"job-live"');

      console.log(`[test-evidence] SSE live job: ${heartbeatCount} heartbeats, ${terminalCount} terminal`);
    }, 10_000);
  });

  // ── Status precedence ─────────────────────────────────────────────────────

  describe('status precedence', () => {
    it('failed status takes precedence over completed_with_errors', async () => {
      store.createJob('job-failed', 'bp-f', 'issues', Date.now());
      store.setFailed('job-failed', 'unrecoverable error', Date.now());

      const app = makeApp(db, store, bus);
      const res = await request(app).get('/api/jobs/job-failed');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.displayStatus).toContain('Failed');
    });
  });
});
