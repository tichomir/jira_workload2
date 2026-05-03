/**
 * HeartbeatEmitter tests
 *
 * Covers:
 *  - Timer fires heartbeat at ≤heartbeatIntervalMs intervals (fake timers)
 *  - Per-item tick emits heartbeat when interval elapsed
 *  - Each event carries required fields
 *  - Events persisted to job_events and broadcast on event bus
 *  - complete() emits terminal event with final aggregate counts
 *  - Structured log '[jira-backup] heartbeat' emitted per tick
 */

import Database from 'better-sqlite3';
import { JobStore } from './JobStore';
import { JobEventBus, JobProgressEvent } from './JobEventBus';
import { HeartbeatEmitter, DEFAULT_HEARTBEAT_INTERVAL_MS } from './HeartbeatEmitter';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  JobStore.migrate(db);
  return db;
}

describe('HeartbeatEmitter', () => {
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

  // ── Timer-based heartbeat ─────────────────────────────────────────────────

  describe('timer-driven heartbeat', () => {
    it('emits heartbeat at every interval tick via fake timers', () => {
      jest.useFakeTimers();
      const received: JobProgressEvent[] = [];
      bus.subscribe('job-timer-1', (e) => received.push(e));

      const emitter = new HeartbeatEmitter(
        { jobId: 'job-timer-1', backupPointId: 'bp-001', phase: 'issues', heartbeatIntervalMs: 500 },
        store,
        bus,
      );
      emitter.start();

      // Advance time by 1100ms → should trigger 2 timer ticks at 500ms each
      jest.advanceTimersByTime(1100);

      expect(received.filter((e) => e.type === 'heartbeat').length).toBeGreaterThanOrEqual(2);
      emitter.stop();
      jest.useRealTimers();
    });

    it('timer fires even when no item has been ticked', () => {
      jest.useFakeTimers();
      const received: JobProgressEvent[] = [];
      bus.subscribe('job-timer-idle', (e) => received.push(e));

      const emitter = new HeartbeatEmitter(
        { jobId: 'job-timer-idle', backupPointId: 'bp-idle', phase: 'issues', heartbeatIntervalMs: 300 },
        store,
        bus,
      );
      emitter.start();

      jest.advanceTimersByTime(700);

      const heartbeats = received.filter((e) => e.type === 'heartbeat');
      expect(heartbeats.length).toBeGreaterThanOrEqual(2);
      // itemsProcessed = 0 because no tick() was called
      expect(heartbeats[0].itemsProcessed).toBe(0);

      emitter.stop();
      jest.useRealTimers();
    });
  });

  // ── Per-item tick ─────────────────────────────────────────────────────────

  describe('per-item tick', () => {
    it('emits heartbeat when interval elapsed after tick', () => {
      let fakeMs = 0;
      const received: JobProgressEvent[] = [];
      bus.subscribe('job-tick-1', (e) => received.push(e));

      const emitter = new HeartbeatEmitter(
        {
          jobId: 'job-tick-1',
          backupPointId: 'bp-tick',
          phase: 'issues',
          heartbeatIntervalMs: 100,
          nowMs: () => fakeMs,
        },
        store,
        bus,
      );
      emitter.start();

      fakeMs = 50;
      emitter.tick({ currentItemKey: 'PROJ-1' });
      // Not enough time elapsed — no heartbeat yet
      expect(received.filter((e) => e.type === 'heartbeat').length).toBe(0);

      fakeMs = 150;
      emitter.tick({ currentItemKey: 'PROJ-2' });
      // Interval elapsed — heartbeat should fire
      expect(received.filter((e) => e.type === 'heartbeat').length).toBeGreaterThanOrEqual(1);

      emitter.stop();
    });

    it('tracks itemsProcessed and itemsFailed correctly', () => {
      let fakeMs = 0;
      const received: JobProgressEvent[] = [];
      bus.subscribe('job-counts', (e) => received.push(e));

      const emitter = new HeartbeatEmitter(
        {
          jobId: 'job-counts',
          backupPointId: 'bp-counts',
          phase: 'issues',
          heartbeatIntervalMs: 10,
          nowMs: () => fakeMs,
        },
        store,
        bus,
      );
      emitter.start();

      fakeMs = 20;
      emitter.tick({ currentItemKey: 'PROJ-1' }); // success
      fakeMs = 40;
      emitter.tick({ failed: true, currentItemKey: 'PROJ-2' }); // error
      fakeMs = 60;
      emitter.tick({ currentItemKey: 'PROJ-3' }); // success

      const lastHeartbeat = received
        .filter((e) => e.type === 'heartbeat')
        .slice(-1)[0];
      expect(lastHeartbeat.itemsProcessed).toBe(2);
      expect(lastHeartbeat.itemsFailed).toBe(1);

      emitter.stop();
    });
  });

  // ── Required event fields ─────────────────────────────────────────────────

  describe('event fields', () => {
    it('every heartbeat event carries required fields', () => {
      jest.useFakeTimers();
      const received: JobProgressEvent[] = [];
      bus.subscribe('job-fields', (e) => received.push(e));

      const emitter = new HeartbeatEmitter(
        { jobId: 'job-fields', backupPointId: 'bp-fields', phase: 'attachments', heartbeatIntervalMs: 200 },
        store,
        bus,
      );
      emitter.start();
      jest.advanceTimersByTime(250);

      const hb = received.find((e) => e.type === 'heartbeat');
      expect(hb).toBeDefined();
      expect(hb!.jobId).toBe('job-fields');
      expect(hb!.backupPointId).toBe('bp-fields');
      expect(hb!.phase).toBe('attachments');
      expect(typeof hb!.itemsProcessed).toBe('number');
      expect(typeof hb!.itemsFailed).toBe('number');
      expect(hb!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      emitter.stop();
      jest.useRealTimers();
    });
  });

  // ── Persistence ───────────────────────────────────────────────────────────

  describe('persistence', () => {
    it('persists heartbeat events to job_events table', () => {
      jest.useFakeTimers();

      const emitter = new HeartbeatEmitter(
        { jobId: 'job-persist', backupPointId: 'bp-persist', phase: 'issues', heartbeatIntervalMs: 100 },
        store,
        bus,
      );
      emitter.start();
      jest.advanceTimersByTime(250);
      emitter.stop();

      const events = store.getJobEvents('job-persist');
      expect(events.filter((e) => e.type === 'heartbeat').length).toBeGreaterThanOrEqual(2);

      jest.useRealTimers();
    });

    it('registers job in jobs table on start()', () => {
      const emitter = new HeartbeatEmitter(
        { jobId: 'job-reg', backupPointId: 'bp-reg', phase: 'context' },
        store,
        bus,
      );
      emitter.start();

      const job = store.getJob('job-reg');
      expect(job).not.toBeNull();
      expect(job!.backupPointId).toBe('bp-reg');
      expect(job!.phase).toBe('context');
      expect(job!.status).toBe('running');

      emitter.stop();
    });
  });

  // ── Terminal event ────────────────────────────────────────────────────────

  describe('complete()', () => {
    it('emits terminal event with final aggregate counts', () => {
      let fakeMs = 0;
      const received: JobProgressEvent[] = [];
      bus.subscribe('job-terminal', (e) => received.push(e));

      const emitter = new HeartbeatEmitter(
        {
          jobId: 'job-terminal',
          backupPointId: 'bp-term',
          phase: 'issues',
          heartbeatIntervalMs: 1000,
          nowMs: () => fakeMs,
        },
        store,
        bus,
      );
      emitter.start();

      fakeMs = 100;
      emitter.tick(); // success
      emitter.tick({ failed: true }); // error
      emitter.tick(); // success

      emitter.complete();

      const terminal = received.find((e) => e.type === 'terminal');
      expect(terminal).toBeDefined();
      expect(terminal!.itemsProcessed).toBe(2);
      expect(terminal!.itemsFailed).toBe(1);
      expect(terminal!.jobId).toBe('job-terminal');
      expect(terminal!.displayStatus).toContain('error');
    });

    it('marks job completed_with_errors in store when itemsFailed > 0', () => {
      const emitter = new HeartbeatEmitter(
        { jobId: 'job-cwf', backupPointId: 'bp-cwf', phase: 'issues' },
        store,
        bus,
      );
      emitter.start();
      emitter.tick({ failed: true });
      emitter.complete();

      const job = store.getJob('job-cwf');
      expect(job!.status).toBe('completed_with_errors');
    });

    it('marks job completed in store when 0 errors', () => {
      const emitter = new HeartbeatEmitter(
        { jobId: 'job-ok', backupPointId: 'bp-ok', phase: 'issues' },
        store,
        bus,
      );
      emitter.start();
      emitter.tick();
      emitter.complete();

      const job = store.getJob('job-ok');
      expect(job!.status).toBe('completed');
    });
  });

  // ── Structured log ────────────────────────────────────────────────────────

  describe('structured log', () => {
    it('writes [jira-backup] heartbeat log per timer tick', () => {
      jest.useFakeTimers();
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const emitter = new HeartbeatEmitter(
        { jobId: 'job-log', backupPointId: 'bp-log', phase: 'issues', heartbeatIntervalMs: 200 },
        store,
        bus,
      );
      emitter.start();
      jest.advanceTimersByTime(250);
      emitter.stop();

      const heartbeatLogs = logSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('[jira-backup] heartbeat'),
      );
      expect(heartbeatLogs.length).toBeGreaterThanOrEqual(1);

      logSpy.mockRestore();
      jest.useRealTimers();
    });
  });

  // ── Error path ────────────────────────────────────────────────────────────

  describe('error path', () => {
    it('tick() with failed=true increments itemsFailed, not itemsProcessed', () => {
      let fakeMs = 0;
      const received: JobProgressEvent[] = [];
      bus.subscribe('job-err-path', (e) => received.push(e));

      const emitter = new HeartbeatEmitter(
        {
          jobId: 'job-err-path',
          backupPointId: 'bp-ep',
          phase: 'issues',
          heartbeatIntervalMs: 0, // always flush on tick
          nowMs: () => { fakeMs += 10; return fakeMs; },
        },
        store,
        bus,
      );
      emitter.start();
      emitter.tick({ failed: true });
      emitter.stop();

      const hb = received.find((e) => e.type === 'heartbeat');
      expect(hb).toBeDefined();
      expect(hb!.itemsFailed).toBe(1);
      expect(hb!.itemsProcessed).toBe(0);
    });
  });
});
