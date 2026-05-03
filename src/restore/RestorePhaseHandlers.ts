/**
 * RestorePhaseHandlers — concrete PhaseHandler implementations for Sprint 12.
 *
 * Phase order enforced by the engine:
 *   project → workflow → custom_field → board → sprint → issue_body → post_issue
 *
 * Sprint 12 contract:
 *   - ProjectPhaseHandler performs REAL conflict-mode resolution against the
 *     injected JiraWriteClient (override / skip / ask outcomes are all wired).
 *   - All other handlers are deterministic stubs that simulate work for now;
 *     real Jira API writes land in Sprint 13.
 *
 * Source: docs/restore-architecture.md §2, §3, §4
 */

import { randomUUID } from 'crypto';
import { PhaseHandler, PhaseContext, PhaseResult } from './RestoreEngine';
import { RestorePhase } from './types';

// ── Project Phase — real conflict-mode resolution ──────────────────────────────

export class ProjectPhaseHandler implements PhaseHandler {
  readonly phase: RestorePhase = 'project';

  async run(ctx: PhaseContext): Promise<PhaseResult> {
    const projects = this.projectsFromScope(ctx);
    let processed = 0;

    for (const project of projects) {
      const projectKey = project['key'] as string;
      try {
        const exists = await ctx.client.projectExists(projectKey);

        if (exists) {
          if (ctx.conflictMode === 'skip') {
            // Skip — leave the existing project untouched
            console.log(
              `[restore-engine] phase=project conflict=skip projectKey=${projectKey}`,
            );
            processed++;
            continue;
          }

          if (ctx.conflictMode === 'override') {
            // Override — write over the existing project
            await ctx.client.writeProject(project);
            console.log(
              `[restore-engine] phase=project conflict=override projectKey=${projectKey}`,
            );
            processed++;
            continue;
          }

          if (ctx.conflictMode === 'ask') {
            // Ask — pause job, emit ConflictDecisionRequired, wait for operator decision
            const conflictId = `conflict-${randomUUID()}`;

            ctx.store.insertConflict({
              id: conflictId,
              jobId: ctx.jobId,
              objectType: 'JiraProject',
              objectKey: projectKey,
              existingObjectSummary: (project['name'] as string | undefined) ?? projectKey,
              incomingObjectSummary:
                `${(project['name'] as string | undefined) ?? projectKey} (restored)`,
            });

            ctx.store.setStatus(ctx.jobId, 'awaiting_decision');

            ctx.bus.publish({
              type: 'ConflictDecisionRequired',
              jobId: ctx.jobId,
              conflictId,
              objectType: 'JiraProject',
              objectKey: projectKey,
              existingObjectSummary: (project['name'] as string | undefined) ?? projectKey,
              incomingObjectSummary:
                `${(project['name'] as string | undefined) ?? projectKey} (restored)`,
              timestamp: new Date(ctx.nowMs()).toISOString(),
            });

            console.log(
              `[restore-engine] phase=project conflict=ask projectKey=${projectKey} ` +
                `conflictId=${conflictId} awaiting decision`,
            );

            const decision = await this.waitForDecision(ctx, conflictId);
            ctx.store.setStatus(ctx.jobId, 'running');

            if (decision === 'override') {
              await ctx.client.writeProject(project);
              console.log(
                `[restore-engine] phase=project conflict=ask decision=override projectKey=${projectKey}`,
              );
            } else {
              console.log(
                `[restore-engine] phase=project conflict=ask decision=skip projectKey=${projectKey}`,
              );
            }
            processed++;
            continue;
          }
        }

        // Project does not exist — write it
        await ctx.client.writeProject(project);
        processed++;
      } catch (err) {
        return {
          status: 'failed',
          processed,
          total: projects.length,
          errorCount: 1,
          diagnostic: `PROJECT_WRITE_FAILED: ${String(err)}`,
        };
      }
    }

    return {
      status: 'completed',
      processed,
      total: projects.length,
      errorCount: 0,
    };
  }

  /** Derive the list of project records to restore from the job scope. */
  private projectsFromScope(ctx: PhaseContext): Array<Record<string, unknown>> {
    if (ctx.scope.type === 'issues') {
      // Issue-scoped restore assumes the target project already exists
      return [];
    }
    if (ctx.scope.type === 'projects') {
      return ctx.scope.projectKeys.map((key) => ({ key, name: `Project ${key}` }));
    }
    // 'all' scope — stub with a single representative project
    return [{ key: 'MOCK', name: 'Mock Project' }];
  }

  /**
   * Polls the store for an operator decision on the given conflictId.
   * Resolves once a decision ('override' | 'skip') is present.
   */
  private waitForDecision(ctx: PhaseContext, conflictId: string): Promise<'override' | 'skip'> {
    const intervalMs = ctx.decisionPollIntervalMs ?? 100;
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const conflict = ctx.store.getConflict(conflictId);
        if (conflict?.decision !== null && conflict?.decision !== undefined) {
          clearInterval(timer);
          resolve(conflict.decision as 'override' | 'skip');
        }
      }, intervalMs);
    });
  }
}

// ── Stub handlers for non-Project phases (Sprint 12) ──────────────────────────

/** Simulates restoring 3 workflows and their scheme associations. */
export class WorkflowPhaseHandler implements PhaseHandler {
  readonly phase: RestorePhase = 'workflow';

  async run(ctx: PhaseContext): Promise<PhaseResult> {
    const items = [
      { id: 'wf-mock-1', name: 'Software Simplified Workflow' },
      { id: 'wf-mock-2', name: 'Bug Workflow' },
      { id: 'wf-mock-3', name: 'Default Workflow' },
    ];
    for (const item of items) {
      await ctx.client.writeWorkflow(item);
    }
    return { status: 'completed', processed: items.length, total: items.length, errorCount: 0 };
  }
}

/** Simulates restoring custom fields and their field configurations. */
export class CustomFieldPhaseHandler implements PhaseHandler {
  readonly phase: RestorePhase = 'custom_field';

  async run(ctx: PhaseContext): Promise<PhaseResult> {
    const items = [
      { id: 'customfield_10001', name: 'Story Points', custom: true },
      { id: 'customfield_10002', name: 'Epic Link', custom: true },
    ];
    for (const item of items) {
      await ctx.client.writeCustomField(item);
    }
    return { status: 'completed', processed: items.length, total: items.length, errorCount: 0 };
  }
}

/** Simulates restoring boards. */
export class BoardPhaseHandler implements PhaseHandler {
  readonly phase: RestorePhase = 'board';

  async run(ctx: PhaseContext): Promise<PhaseResult> {
    const items = [{ id: 1, name: 'Mock Board', type: 'scrum' }];
    for (const item of items) {
      await ctx.client.writeBoard(item as Record<string, unknown>);
    }
    return { status: 'completed', processed: items.length, total: items.length, errorCount: 0 };
  }
}

/** Simulates restoring sprints. */
export class SprintPhaseHandler implements PhaseHandler {
  readonly phase: RestorePhase = 'sprint';

  async run(ctx: PhaseContext): Promise<PhaseResult> {
    const items = [
      { id: 101, name: 'Sprint 1', state: 'closed' },
      { id: 102, name: 'Sprint 2', state: 'active' },
    ];
    for (const item of items) {
      await ctx.client.writeSprint(item as Record<string, unknown>);
    }
    return { status: 'completed', processed: items.length, total: items.length, errorCount: 0 };
  }
}

/** Simulates restoring issue bodies (system + custom fields). */
export class IssueBodyPhaseHandler implements PhaseHandler {
  readonly phase: RestorePhase = 'issue_body';

  async run(ctx: PhaseContext): Promise<PhaseResult> {
    const issueKeys = this.issueKeysFromScope(ctx);
    let processed = 0;

    for (const key of issueKeys) {
      await ctx.client.writeIssue({ key, summary: `Restored issue ${key}` });
      processed++;
    }

    return {
      status: 'completed',
      processed,
      total: issueKeys.length,
      errorCount: 0,
    };
  }

  private issueKeysFromScope(ctx: PhaseContext): string[] {
    if (ctx.scope.type === 'issues') return ctx.scope.issueKeys;
    if (ctx.scope.type === 'projects') {
      return ctx.scope.projectKeys.map((pk) => `${pk}-1`);
    }
    return ['MOCK-1', 'MOCK-2'];
  }
}

/**
 * Post-issue pass: restores issue links, comments, and attachments.
 * Emits affectedIssueIds so the engine can emit the ADF media link breakage warning.
 *
 * Per architecture §7: restored attachments receive new attachmentIds; ADF media
 * node references in issue descriptions/comments may break. Best-effort warning only.
 */
export class PostIssuePhaseHandler implements PhaseHandler {
  readonly phase: RestorePhase = 'post_issue';

  async run(ctx: PhaseContext): Promise<PhaseResult> {
    const issueKeys = this.issueKeysFromScope(ctx);
    let processed = 0;

    for (const key of issueKeys) {
      await ctx.client.writeIssueLinks(key, []);
      await ctx.client.writeComments(key, []);
      await ctx.client.writeAttachments(key, [{ filename: `${key}-attachment.png` }]);
      processed++;
    }

    return {
      status: 'completed',
      processed,
      total: issueKeys.length,
      errorCount: 0,
      // All restored issues potentially have broken ADF media references
      affectedIssueIds: issueKeys,
    };
  }

  private issueKeysFromScope(ctx: PhaseContext): string[] {
    if (ctx.scope.type === 'issues') return ctx.scope.issueKeys;
    if (ctx.scope.type === 'projects') {
      return ctx.scope.projectKeys.map((pk) => `${pk}-1`);
    }
    return ['MOCK-1', 'MOCK-2'];
  }
}

// ── Factory ────────────────────────────────────────────────────────────────────

/**
 * Returns the canonical ordered list of phase handlers.
 * Order matches the restore dependency contract in docs/restore-architecture.md §2.
 */
export function buildDefaultHandlers(): PhaseHandler[] {
  return [
    new ProjectPhaseHandler(),
    new WorkflowPhaseHandler(),
    new CustomFieldPhaseHandler(),
    new BoardPhaseHandler(),
    new SprintPhaseHandler(),
    new IssueBodyPhaseHandler(),
    new PostIssuePhaseHandler(),
  ];
}
