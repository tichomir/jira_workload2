/**
 * HeartbeatEmitter — emits structured progress events for backup jobs.
 *
 * Used by IssueCaptureOrchestrator and attachment download loops.
 *
 * Guarantees:
 *   - A heartbeat event is emitted at minimum every heartbeatIntervalMs (≤10s default).
 *   - The internal timer fires even when no item has finished, satisfying the
 *     ">0 seconds, no item completed" stall-detection window.
 *   - complete() emits a terminal event with final aggregate counts.
 *   - Every event is persisted to job_events and broadcast on the event bus.
 *
 * Structured log: '[jira-backup] heartbeat jobId=... phase=... processed=... failed=...'
 */

import { JobStore } from './JobStore';
import { JobEventBus, JobPhase, JobProgressEvent, jobEventBus } from './JobEventBus';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 9_000; // ≤10s per spec

export interface HeartbeatConfig {
  jobId: string;
  backupPointId: string;
  phase: JobPhase;
  heartbeatIntervalMs?: number;
  itemsTotal?: number;
  /** Injectable time source for testing */
  nowMs?: () => number;
}

export class HeartbeatEmitter {
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private itemsProcessed = 0;
  private itemsFailed = 0;
  private lastHeartbeatAt: number;
  private itemsTotal: number | undefined;

  constructor(
    private readonly config: HeartbeatConfig,
    private readonly jobStore: JobStore,
    private readonly bus: JobEventBus = jobEventBus,
  ) {
    this.intervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.lastHeartbeatAt = this.now();
    this.itemsTotal = config.itemsTotal;
  }

  /** Set or update the total expected item count (used in heartbeat payloads). */
  setTotal(total: number): void {
    this.itemsTotal = total;
  }

  /**
   * Start the periodic timer.
   * Registers the job in the store and starts emitting heartbeats every intervalMs.
   */
  start(): void {
    this.jobStore.createJob(
      this.config.jobId,
      this.config.backupPointId,
      this.config.phase,
      this.now(),
    );

    this.timer = setInterval(() => {
      this.flush();
    }, this.intervalMs);
  }

  /**
   * Called per-item by the orchestrator after each issue/attachment is processed.
   * Increments the appropriate counter and emits a heartbeat if the interval has elapsed.
   */
  tick(opts: { failed?: boolean; currentItemKey?: string } = {}): void {
    if (opts.failed) {
      this.itemsFailed++;
    } else {
      this.itemsProcessed++;
    }

    if (this.now() - this.lastHeartbeatAt >= this.intervalMs) {
      this.flush(opts.currentItemKey);
    }
  }

  /**
   * Stops the periodic timer without emitting a terminal event.
   * Call complete() instead to finish cleanly.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Stops the timer and emits a terminal event with final aggregate counts.
   * Updates the job status in the store.
   */
  complete(): void {
    this.stop();
    const now = this.now();

    this.jobStore.completeJob(
      this.config.jobId,
      this.itemsProcessed,
      this.itemsFailed,
      now,
    );

    const summary = this.jobStore.getJobSummary(this.config.jobId);
    const displayStatus = summary?.displayStatus ?? 'Completed';

    const event: JobProgressEvent = {
      type: 'terminal',
      jobId: this.config.jobId,
      backupPointId: this.config.backupPointId,
      phase: this.config.phase,
      itemsProcessed: this.itemsProcessed,
      itemsFailed: this.itemsFailed,
      itemsTotal: this.itemsTotal,
      timestamp: new Date(now).toISOString(),
      displayStatus,
    };

    this.jobStore.insertJobEvent(event);
    this.bus.publish(event);

    console.log(
      `[jira-backup] terminal jobId=${this.config.jobId} phase=${this.config.phase} ` +
        `processed=${this.itemsProcessed} failed=${this.itemsFailed} status="${displayStatus}"`,
    );
    console.log(
      `[jira-backup] job_completed jobId=${this.config.jobId} status="${displayStatus}" errors=${this.itemsFailed}`,
    );
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private flush(currentItemKey?: string): void {
    const now = this.now();
    this.lastHeartbeatAt = now;

    const event: JobProgressEvent = {
      type: 'heartbeat',
      jobId: this.config.jobId,
      backupPointId: this.config.backupPointId,
      phase: this.config.phase,
      itemsProcessed: this.itemsProcessed,
      itemsFailed: this.itemsFailed,
      itemsTotal: this.itemsTotal,
      currentItemKey,
      timestamp: new Date(now).toISOString(),
    };

    this.jobStore.insertJobEvent(event);
    this.jobStore.updateHeartbeat(
      this.config.jobId,
      this.itemsProcessed,
      this.itemsFailed,
      now,
      this.itemsTotal,
    );
    this.bus.publish(event);

    console.log(
      `[jira-backup] heartbeat jobId=${this.config.jobId} phase=${this.config.phase} ` +
        `processed=${this.itemsProcessed} failed=${this.itemsFailed}`,
    );
  }

  private now(): number {
    return (this.config.nowMs ?? Date.now)();
  }
}
