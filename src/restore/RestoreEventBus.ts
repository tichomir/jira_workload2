/**
 * RestoreEventBus — in-process publish/subscribe for restore job progress events.
 *
 * Used by RestoreWorker (publisher) and the SSE endpoint (subscriber).
 *
 * Event types:
 *   heartbeat               — periodic progress ping (≤10s cadence)
 *   stalled                 — no heartbeat for >20s
 *   phaseTransition         — worker entered a new restore phase
 *   ConflictDecisionRequired — job paused awaiting operator decision (ask mode)
 *   phaseFailure            — a phase failed; job halted with named diagnostic
 *   complete                — job reached a terminal status
 */

import { EventEmitter } from 'events';
import { RestorePhase, RestoreJobStatus } from './types';

export type RestoreEventType =
  | 'heartbeat'
  | 'stalled'
  | 'phaseTransition'
  | 'ConflictDecisionRequired'
  | 'phaseFailure'
  | 'complete';

export interface RestoreProgressEvent {
  type: RestoreEventType;
  jobId: string;
  timestamp: string;
  /** Present on heartbeat/stalled/phaseTransition */
  phase?: RestorePhase;
  /** Present on heartbeat */
  errorCount?: number;
  /** Present on stalled events */
  lastHeartbeatAgeMs?: number;
  /** Present on phaseFailure */
  diagnostic?: string;
  /** Present on complete */
  status?: RestoreJobStatus;
  /** Present on ConflictDecisionRequired */
  conflictId?: string;
  objectType?: string;
  objectKey?: string;
  existingObjectSummary?: string;
  incomingObjectSummary?: string;
}

export class RestoreEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(500);
  }

  publish(event: RestoreProgressEvent): void {
    this.emitter.emit(`restore:${event.jobId}`, event);
    this.emitter.emit('restore:*', event);
  }

  /** Subscribe to all events for a specific restore job. Returns unsubscribe fn. */
  subscribe(jobId: string, handler: (event: RestoreProgressEvent) => void): () => void {
    this.emitter.on(`restore:${jobId}`, handler);
    return () => this.emitter.off(`restore:${jobId}`, handler);
  }
}

/** Module-level singleton used by RestoreWorker and the SSE endpoint. */
export const restoreEventBus = new RestoreEventBus();
