/**
 * StalledJobDetector — flags backup jobs with no heartbeat for >20 seconds.
 *
 * Runs a periodic check (every 5s by default) against all active jobs in the
 * job store. On stall detection:
 *   - Sets job.stalled = true in the job store
 *   - Emits a 'stalled' event on the event bus
 *   - Writes structured log: '[jira-backup] job stalled jobId=... lastHeartbeatAgeMs=...'
 *
 * On recovery (heartbeat resumes after a stall):
 *   - Clears job.stalled = false
 *   - Emits a 'heartbeat' event (the normal heartbeat from the emitter clears the flag)
 *   - Writes structured log: '[jira-backup] job recovered jobId=...'
 *
 * The stalled state is queryable via JobStore.getJob(jobId).stalled for UI consumption.
 */

import { JobStore } from './JobStore';
import { JobEventBus, JobProgressEvent, jobEventBus } from './JobEventBus';

export const DEFAULT_CHECK_INTERVAL_MS = 5_000;  // 5s
export const DEFAULT_STALE_THRESHOLD_MS = 20_000; // 20s

export interface StalledJobDetectorConfig {
  checkIntervalMs?: number;
  staleThresholdMs?: number;
  /** Injectable time source for testing */
  nowMs?: () => number;
}

export class StalledJobDetector {
  private readonly checkIntervalMs: number;
  private readonly staleThresholdMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly stalledJobIds = new Set<string>();

  constructor(
    private readonly jobStore: JobStore,
    private readonly bus: JobEventBus = jobEventBus,
    private readonly config: StalledJobDetectorConfig = {},
  ) {
    this.checkIntervalMs = config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.staleThresholdMs = config.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.check();
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Runs one stall-detection pass. Called by the internal timer; also exposed
   * for direct calls in tests.
   */
  check(): void {
    const now = (this.config.nowMs ?? Date.now)();
    const activeJobs = this.jobStore.getActiveJobs();

    for (const job of activeJobs) {
      const age = now - job.lastHeartbeatAt;
      const wasStalled = this.stalledJobIds.has(job.id);

      if (age > this.staleThresholdMs) {
        if (!wasStalled) {
          // New stall detection
          this.stalledJobIds.add(job.id);
          this.jobStore.setStalled(job.id, true);

          const event: JobProgressEvent = {
            type: 'stalled',
            jobId: job.id,
            backupPointId: job.backupPointId,
            phase: job.phase,
            itemsProcessed: job.itemsProcessed,
            itemsFailed: job.itemsFailed,
            itemsTotal: job.itemsTotal ?? undefined,
            lastHeartbeatAgeMs: age,
            timestamp: new Date(now).toISOString(),
          };

          this.bus.publish(event);

          console.log(
            `[jira-backup] job stalled jobId=${job.id} lastHeartbeatAgeMs=${age}`,
          );
        }
      } else if (wasStalled) {
        // Recovery: heartbeat resumed
        this.stalledJobIds.delete(job.id);
        this.jobStore.setStalled(job.id, false);

        console.log(
          `[jira-backup] job recovered jobId=${job.id}`,
        );
      }
    }

    // Remove completed jobs from the tracked-stalled set
    const activeIds = new Set(activeJobs.map((j) => j.id));
    for (const id of this.stalledJobIds) {
      if (!activeIds.has(id)) {
        this.stalledJobIds.delete(id);
      }
    }
  }
}
