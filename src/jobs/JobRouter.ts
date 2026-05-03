/**
 * JobRouter — HTTP and SSE endpoints for job progress and status.
 *
 * Endpoints:
 *   GET /api/jobs/:jobId          — returns full job summary (status, counts, errors)
 *   GET /api/jobs/:jobId/events   — SSE stream of heartbeat/stalled/terminal events
 *
 * Both endpoints validate that the jobId exists and use the credential repository
 * as the canonical auth check (request must carry a valid x-cloud-id header that
 * resolves to a known connection, or pass the `allowUnauthenticated` flag for tests).
 *
 * SSE stream:
 *   - On connect: sends any previously-persisted events for the job as initial replay
 *   - Then subscribes to live events on the event bus
 *   - Sends 'data: ...\n\n' frames per SSE spec
 *   - Closes the subscription on client disconnect
 */

import { Router, Request, Response } from 'express';
import { JobStore } from './JobStore';
import { JobEventBus } from './JobEventBus';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';

export interface JobRouterOptions {
  /**
   * Skip credential validation. Use ONLY in tests — never in production.
   */
  allowUnauthenticated?: boolean;
}

export function createJobRouter(
  jobStore: JobStore,
  eventBus: JobEventBus,
  credRepo: JiraCredentialRepository,
  opts: JobRouterOptions = {},
): Router {
  const router = Router();

  // ── Auth middleware ────────────────────────────────────────────────────────

  function requireAuth(req: Request, res: Response): boolean {
    if (opts.allowUnauthenticated) return true;

    const cloudId = req.headers['x-cloud-id'] as string | undefined;
    if (!cloudId) {
      res.status(401).json({ error: 'missing_cloud_id' });
      return false;
    }
    const cred = credRepo.getByCloudId(cloudId);
    if (!cred) {
      res.status(401).json({ error: 'invalid_cloud_id' });
      return false;
    }
    return true;
  }

  // ── GET /api/jobs/:jobId ───────────────────────────────────────────────────

  router.get('/:jobId', (req: Request, res: Response): void => {
    if (!requireAuth(req, res)) return;

    const jobId = req.params.jobId as string;
    const summary = jobStore.getJobSummary(jobId);

    if (!summary) {
      res.status(404).json({ error: 'job_not_found', jobId });
      return;
    }

    res.json({
      jobId,
      status: summary.status,
      displayStatus: summary.displayStatus,
      itemsProcessed: summary.itemsProcessed,
      itemsFailed: summary.itemsFailed,
      itemsTotal: summary.itemsTotal ?? null,
      lastHeartbeatAt: summary.lastHeartbeatAt,
      stalled: summary.stalled,
      backupPointId: summary.backupPointId,
      errors: summary.errors,
    });
  });

  // ── GET /api/jobs/:jobId/events  (SSE) ────────────────────────────────────

  router.get('/:jobId/events', (req: Request, res: Response): void => {
    if (!requireAuth(req, res)) return;

    const jobId = req.params.jobId as string;

    // Validate job exists
    const job = jobStore.getJob(jobId);
    if (!job) {
      res.status(404).json({ error: 'job_not_found', jobId });
      return;
    }

    // SSE response headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
    res.flushHeaders();

    function sendEvent(data: unknown): void {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    // Replay persisted events for this job (catch-up for late subscribers)
    const pastEvents = jobStore.getJobEvents(jobId);
    for (const evt of pastEvents) {
      sendEvent(evt);
    }

    // Subscribe to live events
    const unsubscribe = eventBus.subscribe(jobId, (event) => {
      sendEvent(event);

      // Close SSE connection after terminal event
      if (event.type === 'terminal') {
        unsubscribe();
        res.end();
      }
    });

    // Clean up on client disconnect
    req.on('close', () => {
      unsubscribe();
    });
  });

  return router;
}
