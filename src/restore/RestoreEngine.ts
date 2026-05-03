/**
 * RestoreEngine — dependency-ordered phase executor for restore jobs.
 *
 * Responsibilities:
 *   - Runs phase handlers in strict order: project → workflow → custom_field →
 *     board → sprint → issue_body → post_issue
 *   - On any phase failure, persists the named diagnostic code and halts; no
 *     subsequent phase is started.
 *   - Emits phaseTransition, phaseFailure, and adfMediaWarning SSE events.
 *   - Emits a structured log line per phase: [restore-engine] phase=X outcome=Y items=N
 *
 * Heartbeat (progress events with current phase, processed, total) is owned by
 * RestoreWorker, which reads phaseProgress from the store between phases.
 *
 * Source: docs/restore-architecture.md §2, §3
 */

import { randomUUID } from 'crypto';
import { RestoreJobStore } from './RestoreJobStore';
import { RestoreEventBus } from './RestoreEventBus';
import {
  ConflictMode,
  RestoreDestination,
  RestorePhase,
  RestoreScope,
  PhaseProgress,
} from './types';

// ── JiraWriteClient interface ──────────────────────────────────────────────────

/**
 * Abstraction over Jira REST API write operations used by phase handlers.
 * Inject a mock in tests; a real HTTP-backed implementation lands in a later sprint.
 */
export interface JiraWriteClient {
  projectExists(projectKey: string): Promise<boolean>;
  writeProject(projectData: Record<string, unknown>): Promise<void>;
  writeWorkflow(workflowData: Record<string, unknown>): Promise<void>;
  writeCustomField(fieldData: Record<string, unknown>): Promise<void>;
  writeBoard(boardData: Record<string, unknown>): Promise<void>;
  writeSprint(sprintData: Record<string, unknown>): Promise<void>;
  /** Returns the newly created issue's ID. */
  writeIssue(issueData: Record<string, unknown>): Promise<string>;
  writeIssueLinks(issueId: string, links: unknown[]): Promise<void>;
  writeComments(issueId: string, comments: unknown[]): Promise<void>;
  writeAttachments(issueId: string, attachments: unknown[]): Promise<void>;
}

/**
 * No-op write client — used when no real client is wired (e.g. early sprints).
 * projectExists always returns false (no conflicts), all writes are no-ops.
 */
export class NullJiraWriteClient implements JiraWriteClient {
  async projectExists(_key: string): Promise<boolean> { return false; }
  async writeProject(_d: Record<string, unknown>): Promise<void> {}
  async writeWorkflow(_d: Record<string, unknown>): Promise<void> {}
  async writeCustomField(_d: Record<string, unknown>): Promise<void> {}
  async writeBoard(_d: Record<string, unknown>): Promise<void> {}
  async writeSprint(_d: Record<string, unknown>): Promise<void> {}
  async writeIssue(_d: Record<string, unknown>): Promise<string> { return `null-issue-${randomUUID()}`; }
  async writeIssueLinks(_id: string, _l: unknown[]): Promise<void> {}
  async writeComments(_id: string, _c: unknown[]): Promise<void> {}
  async writeAttachments(_id: string, _a: unknown[]): Promise<void> {}
}

// ── Phase interfaces ───────────────────────────────────────────────────────────

export interface PhaseContext {
  jobId: string;
  conflictMode: ConflictMode;
  scope: RestoreScope;
  destination: RestoreDestination;
  client: JiraWriteClient;
  store: RestoreJobStore;
  bus: RestoreEventBus;
  nowMs: () => number;
  /**
   * How often (ms) to poll the store for an ask-mode conflict decision.
   * Default: 100ms. Lower values speed up tests.
   */
  decisionPollIntervalMs?: number;
}

export interface PhaseResult {
  status: 'completed' | 'completed_with_errors' | 'failed';
  processed: number;
  total: number;
  errorCount: number;
  /**
   * Named diagnostic code, SCREAMING_SNAKE_CASE[:detail], when status='failed'.
   * e.g. "PROJECT_WRITE_FAILED: connection refused"
   */
  diagnostic?: string;
  /**
   * Issue IDs whose attachments were written in this phase.
   * Present on post_issue phase to trigger ADF media link breakage warning.
   */
  affectedIssueIds?: string[];
}

export interface PhaseHandler {
  readonly phase: RestorePhase;
  run(ctx: PhaseContext): Promise<PhaseResult>;
}

// ── Engine execution result ────────────────────────────────────────────────────

export type EngineExecutionResult =
  | { outcome: 'completed'; totalErrors: number }
  | { outcome: 'completed_with_errors'; totalErrors: number }
  | { outcome: 'failed'; diagnostic: string; phase: RestorePhase };

// ── RestoreEngine ──────────────────────────────────────────────────────────────

export interface RestoreEngineConfig {
  nowMs?: () => number;
  decisionPollIntervalMs?: number;
}

export class RestoreEngine {
  private readonly nowMs: () => number;
  private readonly decisionPollIntervalMs: number;

  constructor(
    private readonly handlers: PhaseHandler[],
    private readonly store: RestoreJobStore,
    private readonly bus: RestoreEventBus,
    config: RestoreEngineConfig = {},
  ) {
    this.nowMs = config.nowMs ?? Date.now;
    this.decisionPollIntervalMs = config.decisionPollIntervalMs ?? 100;
  }

  /**
   * Execute all phase handlers in order for the given job.
   *
   * Guarantees:
   *   - Phase N+1 never starts if Phase N returned status='failed'.
   *   - On failure, failureDiagnostic is persisted BEFORE any subsequent phase.
   *   - ADF media warning is emitted after post_issue if affectedIssueIds is non-empty.
   *
   * Returns the final execution outcome; callers (RestoreWorker) call store.complete().
   */
  async execute(jobId: string, client: JiraWriteClient): Promise<EngineExecutionResult> {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`Restore job not found: ${jobId}`);

    // Initialise phaseProgress for all phases (all pending, 0 items)
    const phaseProgress: PhaseProgress[] = this.handlers.map((h) => ({
      phase: h.phase,
      status: 'pending' as const,
      total: 0,
      processed: 0,
      errorCount: 0,
      startedAt: null,
      completedAt: null,
    }));
    this.store.updatePhaseProgress(jobId, phaseProgress);

    const ctx: PhaseContext = {
      jobId,
      conflictMode: job.conflictMode,
      scope: job.scope,
      destination: job.destination,
      client,
      store: this.store,
      bus: this.bus,
      nowMs: this.nowMs,
      decisionPollIntervalMs: this.decisionPollIntervalMs,
    };

    let totalErrors = 0;

    for (let i = 0; i < this.handlers.length; i++) {
      const handler = this.handlers[i];
      const now = this.nowMs();

      // Mark phase running in store (heartbeat timer reads this)
      phaseProgress[i] = {
        ...phaseProgress[i],
        status: 'running',
        startedAt: new Date(now).toISOString(),
      };
      this.store.setCurrentPhase(jobId, handler.phase);
      this.store.updatePhaseProgress(jobId, phaseProgress);

      this.bus.publish({
        type: 'phaseTransition',
        jobId,
        phase: handler.phase,
        timestamp: new Date(now).toISOString(),
      });

      let result: PhaseResult;
      try {
        result = await handler.run(ctx);
      } catch (err) {
        result = {
          status: 'failed',
          processed: 0,
          total: 0,
          errorCount: 1,
          diagnostic: `UNHANDLED_PHASE_ERROR: ${String(err)}`,
        };
      }

      // Persist final phase state
      phaseProgress[i] = {
        ...phaseProgress[i],
        status: result.status,
        total: result.total,
        processed: result.processed,
        errorCount: result.errorCount,
        completedAt: new Date(this.nowMs()).toISOString(),
      };
      this.store.updatePhaseProgress(jobId, phaseProgress);

      // Structured log per phase (always emitted)
      console.log(
        `[restore-engine] phase=${handler.phase} outcome=${result.status} items=${result.processed}`,
      );

      if (result.status === 'failed') {
        const diagnostic = result.diagnostic ?? `PHASE_FAILED: ${handler.phase}`;

        // Persist diagnostic BEFORE any subsequent phase could ever run
        this.store.setFailed(jobId, diagnostic, this.nowMs());

        this.bus.publish({
          type: 'phaseFailure',
          jobId,
          phase: handler.phase,
          diagnostic,
          timestamp: new Date(this.nowMs()).toISOString(),
        });

        return { outcome: 'failed', diagnostic, phase: handler.phase };
      }

      // Accumulate errors onto the job row
      totalErrors += result.errorCount;
      for (let j = 0; j < result.errorCount; j++) {
        this.store.incrementErrorCount(jobId);
      }

      // ADF media link breakage warning — emitted after post_issue with attachments
      if (
        handler.phase === 'post_issue' &&
        result.affectedIssueIds &&
        result.affectedIssueIds.length > 0
      ) {
        this.store.setAdfMediaWarning(jobId);
        this.bus.publish({
          type: 'adfMediaWarning',
          jobId,
          affectedIssueIds: result.affectedIssueIds,
          timestamp: new Date(this.nowMs()).toISOString(),
        });
        console.log(
          `[restore-engine] adf-media-link-breakage-possible jobId=${jobId} ` +
            `affectedIssues=${result.affectedIssueIds.join(',')}`,
        );
      }
    }

    // All phases completed — clear current phase
    this.store.setCurrentPhase(jobId, null);

    return totalErrors > 0
      ? { outcome: 'completed_with_errors', totalErrors }
      : { outcome: 'completed', totalErrors: 0 };
  }
}
