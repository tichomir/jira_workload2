/**
 * JobEventBus — in-process publish/subscribe for job progress events.
 *
 * The HeartbeatEmitter publishes to this bus; the SSE endpoint subscribes
 * per connection. Uses Node's EventEmitter so no external dependencies.
 */

import { EventEmitter } from 'events';

export type JobPhase = 'issues' | 'attachments' | 'context';
export type JobEventType = 'heartbeat' | 'stalled' | 'terminal';

export interface JobProgressEvent {
  type: JobEventType;
  jobId: string;
  backupPointId: string;
  phase: JobPhase;
  itemsProcessed: number;
  itemsTotal?: number;
  itemsFailed: number;
  currentItemKey?: string;
  timestamp: string;
  /** Only present on terminal events */
  displayStatus?: string;
  /** Only present on stalled events */
  lastHeartbeatAgeMs?: number;
}

export class JobEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(500);
  }

  publish(event: JobProgressEvent): void {
    this.emitter.emit(`job:${event.jobId}`, event);
    this.emitter.emit('job:*', event);
  }

  /** Subscribe to all events for a specific job. Returns an unsubscribe function. */
  subscribe(jobId: string, handler: (event: JobProgressEvent) => void): () => void {
    this.emitter.on(`job:${jobId}`, handler);
    return () => this.emitter.off(`job:${jobId}`, handler);
  }

  /** Subscribe to all events across all jobs. Returns an unsubscribe function. */
  subscribeAll(handler: (event: JobProgressEvent) => void): () => void {
    this.emitter.on('job:*', handler);
    return () => this.emitter.off('job:*', handler);
  }
}

/** Module-level singleton used by HeartbeatEmitter and the SSE endpoint. */
export const jobEventBus = new JobEventBus();
