/**
 * RestoreWorker — skeleton restore job worker (Sprint 11).
 *
 * This sprint delivers the heartbeat / stall-detection infrastructure.
 * Actual Jira API writes land in Sprint 12–13.
 *
 * Behaviour:
 *   1. Marks the job as 'running' in RestoreJobStore.
 *   2. Starts a heartbeat timer (≤10s cadence).
 *   3. Logs each restore phase transition ([jira-restore] job.heartbeat).
 *   4. Stall detection: a parallel monitor checks every 5s; if the last heartbeat
 *      is >20s ago it marks the job stalled and emits a 'stalled' event.
 *   5. Full phase writes are no-ops for now — placeholders only.
 *
 * Structured logs:
 *   [jira-restore] job.created  jobId=...
 *   [jira-restore] job.heartbeat jobId=... phase=...
 *   [jira-restore] job.stalled  jobId=... lastHeartbeatAgeMs=...
 *   [jira-restore] job.complete jobId=... status=...
 */

import { RestoreJobStore } from './RestoreJobStore';
import { RestoreEventBus, RestoreProgressEvent, restoreEventBus } from './RestoreEventBus';
import { RestorePhase, RestoreJobStatus } from './types';

export const DEFAULT_RESTORE_HEARTBEAT_INTERVAL_MS = 9_000;  // ≤10s
export const DEFAULT_RESTORE_CHECK_INTERVAL_MS     = 5_000;  // stall checker cadence
export const DEFAULT_RESTORE_STALE_THRESHOLD_MS    = 20_000; // >20s = stalled

export interface RestoreWorkerConfig {
  jobId: string;
  heartbeatIntervalMs?: number;
  checkIntervalMs?: number;
  staleThresholdMs?: number;
  /** Injectable time source for testing */
  nowMs?: () => number;
}

export class RestoreWorker {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stalledCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt = 0;
  private stalled = false;

  private readonly heartbeatIntervalMs: number;
  private readonly checkIntervalMs: number;
  private readonly staleThresholdMs: number;

  constructor(
    private readonly config: RestoreWorkerConfig,
    private readonly store: RestoreJobStore,
    private readonly bus: RestoreEventBus = restoreEventBus,
  ) {
    this.heartbeatIntervalMs =
      config.heartbeatIntervalMs ?? DEFAULT_RESTORE_HEARTBEAT_INTERVAL_MS;
    this.checkIntervalMs =
      config.checkIntervalMs ?? DEFAULT_RESTORE_CHECK_INTERVAL_MS;
    this.staleThresholdMs =
      config.staleThresholdMs ?? DEFAULT_RESTORE_STALE_THRESHOLD_MS;
  }

  /**
   * Starts the worker: marks the job running, begins heartbeat and stall timers,
   * then runs through the restore phase stubs.
   *
   * The returned Promise resolves when all (skeleton) phases have been logged.
   * Callers should fire-and-forget in production; await in tests for
   * deterministic assertions.
   */
  async run(): Promise<void> {
    const { jobId } = this.config;

    // Transition pending → running
    this.store.setStatus(jobId, 'running');
    this.lastHeartbeatAt = this.now();
    this.store.updateHeartbeat(jobId, this.lastHeartbeatAt);

    console.log(`[jira-restore] job.created jobId=${jobId} status=running`);

    // Start periodic heartbeat emitter
    this.heartbeatTimer = setInterval(() => {
      this.emitHeartbeat();
    }, this.heartbeatIntervalMs);

    // Start stall detector
    this.stalledCheckTimer = setInterval(() => {
      this.checkStall();
    }, this.checkIntervalMs);

    // Run skeleton phases (no writes; log transitions only)
    const phases: RestorePhase[] = [
      'project',
      'workflow',
      'custom_field',
      'board',
      'sprint',
      'issue_body',
      'post_issue',
    ];

    for (const phase of phases) {
      this.store.setCurrentPhase(jobId, phase);
      this.bus.publish({
        type: 'phaseTransition',
        jobId,
        phase,
        timestamp: new Date(this.now()).toISOString(),
      });
      console.log(`[jira-restore] phase.start jobId=${jobId} phase=${phase}`);
      // Skeleton: no actual work; full implementation in Sprint 12
    }

    this.stop();

    // Mark complete
    const job = this.store.getJob(jobId);
    const finalStatus: 'completed' | 'completed_with_errors' =
      (job?.errorCount ?? 0) > 0 ? 'completed_with_errors' : 'completed';

    this.store.complete(jobId, finalStatus, this.now());
    this.store.setCurrentPhase(jobId, null);

    const event: RestoreProgressEvent = {
      type: 'complete',
      jobId,
      status: finalStatus,
      timestamp: new Date(this.now()).toISOString(),
    };
    this.bus.publish(event);

    console.log(
      `[jira-restore] job.complete jobId=${jobId} status=${finalStatus}`,
    );
  }

  /** Stops both timers without emitting a terminal event. */
  stop(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.stalledCheckTimer !== null) {
      clearInterval(this.stalledCheckTimer);
      this.stalledCheckTimer = null;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private emitHeartbeat(): void {
    const { jobId } = this.config;
    const now = this.now();

    this.lastHeartbeatAt = now;
    this.store.updateHeartbeat(jobId, now);

    if (this.stalled) {
      // Recovery: heartbeat resumed after stall
      this.stalled = false;
      this.store.setStalled(jobId, false);
      console.log(`[jira-restore] job.recovered jobId=${jobId}`);
    }

    const job = this.store.getJob(jobId);
    const event: RestoreProgressEvent = {
      type: 'heartbeat',
      jobId,
      phase: job?.currentPhase ?? undefined,
      errorCount: job?.errorCount ?? 0,
      timestamp: new Date(now).toISOString(),
    };
    this.bus.publish(event);

    console.log(
      `[jira-restore] job.heartbeat jobId=${jobId} phase=${job?.currentPhase ?? 'none'}`,
    );
  }

  private checkStall(): void {
    const { jobId } = this.config;
    const age = this.now() - this.lastHeartbeatAt;

    if (age > this.staleThresholdMs && !this.stalled) {
      this.stalled = true;
      this.store.setStalled(jobId, true);

      const event: RestoreProgressEvent = {
        type: 'stalled',
        jobId,
        lastHeartbeatAgeMs: age,
        timestamp: new Date(this.now()).toISOString(),
      };
      this.bus.publish(event);

      console.log(
        `[jira-restore] job.stalled jobId=${jobId} lastHeartbeatAgeMs=${age}`,
      );
    }
  }

  private now(): number {
    return (this.config.nowMs ?? Date.now)();
  }
}
