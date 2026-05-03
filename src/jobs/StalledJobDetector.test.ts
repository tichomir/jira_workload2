/**
 * StalledJobDetector tests
 *
 * Covers:
 *  - (a) Stalled trigger at 21s: job flagged when no heartbeat for >20s
 *  - (b) Recovery: stalled flag cleared when heartbeat resumes
 *  - (c) No false positive at 19s: job NOT flagged within threshold
 *  - Structured log lines on stall and recovery
 *  - Stalled state queryable from job registry
 */

import Database from 'better-sqlite3';
import { JobStore } from './JobStore';
import { JobEventBus, JobProgressEvent } from './JobEventBus';
import { StalledJobDetector, DEFAULT_STALE_THRESHOLD_MS } from './StalledJobDetector';
import { HeartbeatEmitter } from './HeartbeatEmitter';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  JobStore.migrate(db);
  return db;
}

describe('StalledJobDetector', () => {
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

  // ── (a) Stall trigger at 21s ──────────────────────────────────────────────

  it('(a) flags job stalled when no heartbeat received for >20s', () => {
    let fakeMs = 1_000_000;

    // Register a running job with lastHeartbeatAt = fakeMs
    store.createJob('job-stall-a', 'bp-a', 'issues', fakeMs);

    const received: JobProgressEvent[] = [];
    bus.subscribe('job-stall-a', (e) => received.push(e));

    const detector = new StalledJobDetector(store, bus, {
      staleThresholdMs: 20_000,
      nowMs: () => fakeMs,
    });

    // Advance time to 21s after last heartbeat
    fakeMs = 1_000_000 + 21_000;
    detector.check();

    const job = store.getJob('job-stall-a');
    expect(job!.stalled).toBe(true);
    expect(job!.status).toBe('stalled');

    const stalledEvent = received.find((e) => e.type === 'stalled');
    expect(stalledEvent).toBeDefined();
    expect(stalledEvent!.jobId).toBe('job-stall-a');
    expect(stalledEvent!.lastHeartbeatAgeMs).toBeGreaterThan(20_000);
  });

  // ── (b) Recovery clears the flag ─────────────────────────────────────────

  it('(b) clears stalled flag when heartbeat resumes', () => {
    let fakeMs = 2_000_000;

    store.createJob('job-recover', 'bp-r', 'issues', fakeMs);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const detector = new StalledJobDetector(store, bus, {
      staleThresholdMs: 20_000,
      nowMs: () => fakeMs,
    });

    // Step 1: advance past threshold → job becomes stalled
    fakeMs = 2_000_000 + 21_000;
    detector.check();

    expect(store.getJob('job-recover')!.stalled).toBe(true);

    // Step 2: simulate heartbeat resume (update lastHeartbeatAt to now)
    store.updateHeartbeat('job-recover', 5, 0, fakeMs);

    // Step 3: another check — age is now 0, should recover
    detector.check();

    expect(store.getJob('job-recover')!.stalled).toBe(false);
    expect(store.getJob('job-recover')!.status).toBe('running');

    const recoveryLogs = logSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('job recovered'),
    );
    expect(recoveryLogs.length).toBeGreaterThanOrEqual(1);

    logSpy.mockRestore();
  });

  // ── (c) No false positive at 19s ─────────────────────────────────────────

  it('(c) does NOT flag job stalled at 19s (within threshold)', () => {
    let fakeMs = 3_000_000;

    store.createJob('job-no-stall', 'bp-ns', 'issues', fakeMs);

    const received: JobProgressEvent[] = [];
    bus.subscribe('job-no-stall', (e) => received.push(e));

    const detector = new StalledJobDetector(store, bus, {
      staleThresholdMs: 20_000,
      nowMs: () => fakeMs,
    });

    // Only 19s elapsed — should NOT stall
    fakeMs = 3_000_000 + 19_000;
    detector.check();

    const job = store.getJob('job-no-stall');
    expect(job!.stalled).toBe(false);
    expect(job!.status).toBe('running');

    const stalledEvent = received.find((e) => e.type === 'stalled');
    expect(stalledEvent).toBeUndefined();
  });

  // ── Structured log ────────────────────────────────────────────────────────

  it('writes structured log on stall detection', () => {
    let fakeMs = 4_000_000;
    store.createJob('job-log-stall', 'bp-ls', 'issues', fakeMs);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const detector = new StalledJobDetector(store, bus, {
      staleThresholdMs: 20_000,
      nowMs: () => fakeMs,
    });

    fakeMs = 4_000_000 + 21_000;
    detector.check();

    const stallLogs = logSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('[jira-backup] job stalled'),
    );
    expect(stallLogs.length).toBe(1);
    expect(stallLogs[0][0]).toContain('jobId=job-log-stall');
    expect(stallLogs[0][0]).toContain('lastHeartbeatAgeMs=');

    logSpy.mockRestore();
  });

  // ── Stall state queryable from job registry ───────────────────────────────

  it('stalled state is queryable from job registry API', () => {
    let fakeMs = 5_000_000;
    store.createJob('job-query', 'bp-q', 'issues', fakeMs);

    const detector = new StalledJobDetector(store, bus, {
      staleThresholdMs: 20_000,
      nowMs: () => fakeMs,
    });

    fakeMs += 21_000;
    detector.check();

    const summary = store.getJobSummary('job-query');
    expect(summary).not.toBeNull();
    expect(summary!.stalled).toBe(true);
    expect(summary!.status).toBe('stalled');
  });

  // ── Timer-based operation ─────────────────────────────────────────────────

  it('runs check on periodic timer interval', () => {
    jest.useFakeTimers();

    let fakeMs = 6_000_000;
    store.createJob('job-timer-stall', 'bp-ts', 'issues', fakeMs);

    const detector = new StalledJobDetector(store, bus, {
      checkIntervalMs: 5_000,
      staleThresholdMs: 20_000,
      nowMs: () => fakeMs,
    });

    detector.start();

    // After 26s total: first timer fires at 5s (age=0, no stall yet)
    // but we advance fake time to 26s so on the next check the age is >20s
    fakeMs = 6_000_000 + 26_000;
    jest.advanceTimersByTime(10_000); // trigger the 5s interval twice

    const job = store.getJob('job-timer-stall');
    expect(job!.stalled).toBe(true);

    detector.stop();
    jest.useRealTimers();
  });

  // ── Only fires stalled event once ────────────────────────────────────────

  it('does not emit duplicate stalled events on repeated checks', () => {
    let fakeMs = 7_000_000;
    store.createJob('job-nodup', 'bp-nd', 'issues', fakeMs);

    const received: JobProgressEvent[] = [];
    bus.subscribe('job-nodup', (e) => received.push(e));

    const detector = new StalledJobDetector(store, bus, {
      staleThresholdMs: 20_000,
      nowMs: () => fakeMs,
    });

    fakeMs += 21_000;
    detector.check();
    detector.check(); // second check — already stalled, should not re-emit
    detector.check(); // third

    const stalledEvents = received.filter((e) => e.type === 'stalled');
    expect(stalledEvents).toHaveLength(1);
  });
});
