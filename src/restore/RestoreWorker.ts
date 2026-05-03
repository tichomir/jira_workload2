/**
 * RestoreWorker — orchestrates a restore job run.
 *
 * Responsibilities:
 *   1. Transitions job pending → running.
 *   2. Starts a heartbeat timer (≤10s cadence) emitting current phase,
 *      items processed/total, and error count.
 *   3. Starts a stall detector that marks the job stalled if no heartbeat
 *      for >20s.
 *   4. Delegates phase execution to RestoreEngine (which enforces write order,
 *      phase-failure halt, and ADF media warning).
 *   5. Marks the job completed / failed on engine exit.
 *
 * Structured logs:
 *   [jira-restore] job.created  jobId=... status=running
 *   [jira-restore] job.heartbeat jobId=... phase=... processed=N/M
 *   [jira-restore] job.stalled  jobId=... lastHeartbeatAgeMs=...
 *   [jira-restore] job.complete jobId=... status=...
 */

import { RestoreJobStore } from './RestoreJobStore';
import { RestoreEventBus, RestoreProgressEvent, restoreEventBus } from './RestoreEventBus';
import { RestoreEngine, JiraWriteClient, NullJiraWriteClient } from './RestoreEngine';
import { buildDefaultHandlers } from './RestorePhaseHandlers';
import { RestoreJobStatus } from './types';

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
  /** Polling interval for ask-mode conflict decisions. Default: 100ms. */
  decisionPollIntervalMs?: number;
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
    private readonly client: JiraWriteClient = new NullJiraWriteClient(),
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
   * then runs all restore phases via RestoreEngine.
   *
   * The returned Promise resolves when all phases have completed (or failed).
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

    try {
      const engine = new RestoreEngine(
        buildDefaultHandlers(),
        this.store,
        this.bus,
        {
          nowMs: this.config.nowMs,
          decisionPollIntervalMs: this.config.decisionPollIntervalMs,
        },
      );

      const result = await engine.execute(jobId, this.client);

      this.stop();

      if (result.outcome === 'failed') {
        // Engine already called store.setFailed(); just emit the terminal event.
        const event: RestoreProgressEvent = {
          type: 'complete',
          jobId,
          status: 'failed',
          timestamp: new Date(this.now()).toISOString(),
        };
        this.bus.publish(event);
        console.log(`[jira-restore] job.complete jobId=${jobId} status=failed`);
        return;
      }

      const finalStatus: 'completed' | 'completed_with_errors' =
        result.outcome === 'completed' ? 'completed' : 'completed_with_errors';

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
    } catch (err) {
      this.stop();
      throw err;
    }
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
    const currentPhaseProgress = job?.phaseProgress.find(
      (p) => p.phase === job?.currentPhase,
    );

    const event: RestoreProgressEvent = {
      type: 'heartbeat',
      jobId,
      phase: job?.currentPhase ?? undefined,
      processed: currentPhaseProgress?.processed,
      total: currentPhaseProgress?.total,
      errorCount: job?.errorCount ?? 0,
      timestamp: new Date(now).toISOString(),
    };
    this.bus.publish(event);

    console.log(
      `[jira-restore] job.heartbeat jobId=${jobId} ` +
        `phase=${job?.currentPhase ?? 'none'} ` +
        `processed=${currentPhaseProgress?.processed ?? 0}/${currentPhaseProgress?.total ?? 0}`,
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
