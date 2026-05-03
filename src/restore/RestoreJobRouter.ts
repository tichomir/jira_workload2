/**
 * RestoreJobRouter — HTTP endpoints for the restore job lifecycle.
 *
 * Endpoints:
 *   POST /restore/jobs                    — create a restore job
 *   GET  /restore/jobs/:id               — poll job state + phaseProgress
 *   POST /restore/jobs/:id/decisions     — resolve ask-mode conflict
 *   GET  /restore/jobs/:id/events        — SSE stream of restore events
 *
 * Structured logs:
 *   [jira-restore] job.created           jobId=...
 *   [jira-restore] job.blocked.trash-window jobId=... affectedProjects=...
 *   [jira-restore] job.heartbeat         jobId=... (emitted by RestoreWorker)
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RestoreJobStore } from './RestoreJobStore';
import { RestoreEventBus } from './RestoreEventBus';
import { RestoreWorker } from './RestoreWorker';
import { TrashWindowChecker } from './TrashWindowChecker';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';
import { JiraHttpClient } from '../http/JiraHttpClient';
import {
  ConflictMode,
  RestoreScope,
  RestoreDestination,
} from './types';

export interface RestoreJobRouterOptions {
  /** Skip credential validation. Use ONLY in tests. */
  allowUnauthenticated?: boolean;
  /** Heartbeat interval override for testing */
  heartbeatIntervalMs?: number;
  /** Stall check interval override for testing */
  checkIntervalMs?: number;
  /** Stale threshold override for testing */
  staleThresholdMs?: number;
  /**
   * Override the trash-window checker used by POST /restore/jobs.
   * Inject a mock in tests to avoid real Jira API calls.
   */
  trashWindowChecker?: Pick<TrashWindowChecker, 'checkProjects'>;
}

export function createRestoreJobRouter(
  restoreStore: RestoreJobStore,
  eventBus: RestoreEventBus,
  credRepo: JiraCredentialRepository,
  opts: RestoreJobRouterOptions = {},
): Router {
  const router = Router();

  // ── Auth helper ────────────────────────────────────────────────────────────

  function getCloudId(req: Request, res: Response): string | null {
    if (opts.allowUnauthenticated) {
      // In unauthenticated test mode, accept any x-cloud-id or use 'test-cloud-id'
      return (req.headers['x-cloud-id'] as string) ?? 'test-cloud-id';
    }

    const cloudId = req.headers['x-cloud-id'] as string | undefined;
    if (!cloudId) {
      res.status(401).json({ error: 'missing_cloud_id' });
      return null;
    }
    const cred = credRepo.getByCloudId(cloudId);
    if (!cred) {
      res.status(401).json({ error: 'invalid_cloud_id' });
      return null;
    }
    return cloudId;
  }

  // ── POST /restore/jobs ─────────────────────────────────────────────────────

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const cloudId = getCloudId(req, res);
    if (cloudId === null) return;

    const { sourceBackupPointId, scope, destination, conflictMode } = req.body as {
      sourceBackupPointId?: unknown;
      scope?: unknown;
      destination?: unknown;
      conflictMode?: unknown;
    };

    // ── Validate required fields ─────────────────────────────────────────────

    if (!sourceBackupPointId || typeof sourceBackupPointId !== 'string') {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'sourceBackupPointId is required and must be a string.',
      });
      return;
    }

    if (!scope || typeof scope !== 'object') {
      res.status(400).json({
        error: 'INVALID_SCOPE',
        message: 'scope is required.',
      });
      return;
    }

    const scopeObj = scope as Record<string, unknown>;
    if (!['all', 'projects', 'issues'].includes(scopeObj['type'] as string)) {
      res.status(400).json({
        error: 'INVALID_SCOPE',
        message: "scope.type must be 'all', 'projects', or 'issues'.",
      });
      return;
    }

    if (scopeObj['type'] === 'projects') {
      const keys = scopeObj['projectKeys'];
      if (!Array.isArray(keys) || keys.length === 0) {
        res.status(400).json({
          error: 'INVALID_SCOPE',
          message: "projectKeys must be a non-empty array when scope.type is 'projects'.",
        });
        return;
      }
    }

    if (scopeObj['type'] === 'issues') {
      const keys = scopeObj['issueKeys'];
      if (!Array.isArray(keys) || keys.length === 0) {
        res.status(400).json({
          error: 'INVALID_SCOPE',
          message: "issueKeys must be non-empty when scope.type is 'issues'.",
        });
        return;
      }
    }

    if (!destination || typeof destination !== 'object') {
      res.status(400).json({
        error: 'INVALID_DESTINATION',
        message: 'destination is required.',
      });
      return;
    }

    const destObj = destination as Record<string, unknown>;
    if (!['original', 'alternate', 'export'].includes(destObj['type'] as string)) {
      res.status(400).json({
        error: 'INVALID_DESTINATION',
        message: "destination.type must be 'original', 'alternate', or 'export'.",
      });
      return;
    }

    if (destObj['type'] === 'alternate') {
      if (!destObj['targetProjectKey'] || typeof destObj['targetProjectKey'] !== 'string') {
        res.status(400).json({
          error: 'INVALID_DESTINATION',
          message: "targetProjectKey is required when destination.type is 'alternate'.",
        });
        return;
      }
    }

    // conflictMode defaults to 'skip' when omitted
    const resolvedConflictMode: ConflictMode =
      (conflictMode as ConflictMode | undefined) ?? 'skip';

    if (!['override', 'skip', 'ask'].includes(resolvedConflictMode)) {
      res.status(400).json({
        error: 'INVALID_CONFLICT_MODE',
        message: "conflictMode must be 'override', 'skip', or 'ask'.",
      });
      return;
    }

    // ── Trash-window check (original destination + specific project scope) ──

    if (
      destObj['type'] === 'original' &&
      scopeObj['type'] === 'projects'
    ) {
      const projectKeys = scopeObj['projectKeys'] as string[];

      try {
        const checker: Pick<TrashWindowChecker, 'checkProjects'> =
          opts.trashWindowChecker ??
          new TrashWindowChecker(new JiraHttpClient(cloudId, credRepo));

        const results = await checker.checkProjects(projectKeys);
        const blocked = results.filter((r) => r.inTrash);

        if (blocked.length > 0) {
          const first = blocked[0];
          console.log(
            `[jira-restore] trash-window-block project=${first.projectKey} action=blocked`,
          );

          res.status(400).json({
            code: 'TRASH_WINDOW_BLOCK',
            projectKey: first.projectKey,
            deletedAt: first.deletedAt ?? null,
            expiresAt: first.expiresAt ?? null,
            guidance: 'Use Alternate location restore',
          });
          return;
        }
      } catch (err) {
        // Network/auth error during trash check — fail with 502
        res.status(502).json({
          error: 'TRASH_CHECK_FAILED',
          message: `Could not verify project trash status: ${String(err)}`,
        });
        return;
      }
    }

    // ── Create job ────────────────────────────────────────────────────────────

    const jobId = `restore-${randomUUID()}`;
    const job = restoreStore.createJob({
      jobId,
      sourceBackupPointId: sourceBackupPointId as string,
      scope: scope as RestoreScope,
      destination: destination as RestoreDestination,
      conflictMode: resolvedConflictMode,
    });

    console.log(
      `[jira-restore] job.created jobId=${jobId} ` +
        `sourceBackupPointId=${sourceBackupPointId} conflictMode=${resolvedConflictMode}`,
    );

    // ── Start skeleton worker (fire-and-forget) ───────────────────────────────

    const worker = new RestoreWorker(
      {
        jobId,
        heartbeatIntervalMs: opts.heartbeatIntervalMs,
        checkIntervalMs: opts.checkIntervalMs,
        staleThresholdMs: opts.staleThresholdMs,
      },
      restoreStore,
      eventBus,
    );

    // Fire-and-forget; full error handling lands in Sprint 12
    worker.run().catch((err: unknown) => {
      console.error(`[jira-restore] worker.error jobId=${jobId}`, err);
      restoreStore.setFailed(jobId, `Worker error: ${String(err)}`);
    });

    res.status(201).json(serializeJob(job));
  });

  // ── GET /restore/jobs/:id ──────────────────────────────────────────────────

  router.get('/:id', (req: Request, res: Response): void => {
    const cloudId = getCloudId(req, res);
    if (cloudId === null) return;

    const jobId = req.params['id'] as string;
    const job = restoreStore.getJob(jobId);

    if (!job) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: `Restore job '${jobId}' not found.`,
      });
      return;
    }

    res.json(serializeJob(job));
  });

  // ── POST /restore/jobs/:id/decisions ──────────────────────────────────────

  router.post('/:id/decisions', (req: Request, res: Response): void => {
    const cloudId = getCloudId(req, res);
    if (cloudId === null) return;

    const jobId = req.params['id'] as string;
    const job = restoreStore.getJob(jobId);

    if (!job) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: `Restore job '${jobId}' not found.`,
      });
      return;
    }

    if (job.status !== 'awaiting_decision') {
      res.status(409).json({
        error: 'INVALID_STATE',
        message: `Job is not awaiting a decision. Current status: ${job.status}.`,
      });
      return;
    }

    const { conflictId, decision } = req.body as {
      conflictId?: unknown;
      decision?: unknown;
    };

    if (!conflictId || typeof conflictId !== 'string') {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'conflictId is required.',
      });
      return;
    }

    if (!['override', 'skip'].includes(decision as string)) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: "decision must be 'override' or 'skip'.",
      });
      return;
    }

    const conflict = restoreStore.getConflict(conflictId as string);
    if (!conflict || conflict.jobId !== jobId) {
      res.status(404).json({
        error: 'CONFLICT_NOT_FOUND',
        message: `No pending conflict with id '${conflictId}'.`,
      });
      return;
    }

    if (conflict.decision !== null) {
      res.status(409).json({
        error: 'CONFLICT_ALREADY_RESOLVED',
        message: `Conflict '${conflictId}' has already been resolved.`,
      });
      return;
    }

    restoreStore.resolveConflict(conflictId as string, decision as 'override' | 'skip');
    restoreStore.setStatus(jobId, 'running');

    res.json({
      jobId,
      conflictId,
      decision,
      status: 'running',
    });
  });

  // ── GET /restore/jobs/:id/events (SSE) ────────────────────────────────────

  router.get('/:id/events', (req: Request, res: Response): void => {
    const cloudId = getCloudId(req, res);
    if (cloudId === null) return;

    const jobId = req.params['id'] as string;
    const job = restoreStore.getJob(jobId);

    if (!job) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: `Restore job '${jobId}' not found.`,
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    function sendEvent(eventType: string, data: unknown): void {
      res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    const unsubscribe = eventBus.subscribe(jobId, (event) => {
      sendEvent(event.type, event);

      if (event.type === 'complete') {
        unsubscribe();
        res.end();
      }
    });

    req.on('close', () => {
      unsubscribe();
    });
  });

  // ── GET /restore/jobs/:id/download ────────────────────────────────────────

  router.get('/:id/download', (req: Request, res: Response): void => {
    const cloudId = getCloudId(req, res);
    if (cloudId === null) return;

    const jobId = req.params['id'] as string;
    const job = restoreStore.getJob(jobId);

    if (!job) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: `Restore job '${jobId}' not found.`,
      });
      return;
    }

    if (job.destination.type !== 'export') {
      res.status(400).json({
        error: 'NOT_EXPORT_JOB',
        message: `Job '${jobId}' is not a browser-download export job.`,
      });
      return;
    }

    if (job.status !== 'completed') {
      res.status(409).json({
        error: 'JOB_NOT_COMPLETE',
        message: `Job '${jobId}' is not yet complete (status: ${job.status}).`,
      });
      return;
    }

    const zipPath = restoreStore.getDownloadPath(jobId);
    if (!zipPath || !fs.existsSync(zipPath)) {
      res.status(404).json({
        error: 'ARCHIVE_NOT_FOUND',
        message: `Archive for job '${jobId}' is not available.`,
      });
      return;
    }

    const filename = `restore-${jobId}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', fs.statSync(zipPath).size);

    const stream = fs.createReadStream(zipPath);
    stream.pipe(res);
    stream.on('error', () => {
      res.status(500).end();
    });
  });

  return router;
}

// ── Serialisation ──────────────────────────────────────────────────────────────

function serializeJob(job: ReturnType<RestoreJobStore['getJob']>) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    sourceBackupPointId: job.sourceBackupPointId,
    createdAt: job.createdAt,
    scope: job.scope,
    destination: job.destination,
    conflictMode: job.conflictMode,
    status: job.status,
    currentPhase: job.currentPhase,
    phaseProgress: job.phaseProgress,
    errorCount: job.errorCount,
    failureDiagnostic: job.failureDiagnostic,
    adfMediaWarningEmitted: job.adfMediaWarningEmitted,
    adfMediaWarnings: job.adfMediaWarnings,
    trashWindowBlocked: job.trashWindowBlocked,
  };
}
