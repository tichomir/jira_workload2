/**
 * WorkloadConfigRouter — persists and retrieves per-site workload configuration.
 *
 * Routes:
 *   GET  /workload-config?cloudId=<id>  → { scope, selectedKeys }
 *   POST /workload-config               → { ok, scope, selectedKeys }
 */

import { Router, Request, Response } from 'express';
import { WorkloadConfigRepository } from './WorkloadConfigRepository';

export function createWorkloadConfigRouter(repo: WorkloadConfigRepository): Router {
  const router = Router();

  // GET /workload-config?cloudId=<id>
  // Returns saved scope config, or the default ('all', []) if not yet configured.
  router.get('/', (req: Request, res: Response): void => {
    const cloudId = req.query['cloudId'] as string | undefined;

    if (!cloudId || typeof cloudId !== 'string') {
      res.status(400).json({ error: 'missing_cloud_id' });
      return;
    }

    const config = repo.getByCloudId(cloudId);
    if (!config) {
      res.json({ scope: 'all', selectedKeys: [] });
      return;
    }

    res.json({ scope: config.scope, selectedKeys: config.selectedKeys });
  });

  // POST /workload-config
  // Persists scope and selectedKeys for the given cloudId.
  router.post('/', (req: Request, res: Response): void => {
    const { cloudId, scope, selectedKeys } = req.body as {
      cloudId?: string;
      scope?: string;
      selectedKeys?: unknown;
    };

    if (!cloudId || typeof cloudId !== 'string') {
      res.status(400).json({ error: 'missing_cloud_id' });
      return;
    }
    if (scope !== 'all' && scope !== 'selected') {
      res.status(400).json({ error: 'invalid_scope', message: "scope must be 'all' or 'selected'" });
      return;
    }

    const keys: string[] = Array.isArray(selectedKeys)
      ? (selectedKeys as unknown[]).filter((k): k is string => typeof k === 'string')
      : [];

    repo.upsert(cloudId, scope, keys);
    res.json({ ok: true, scope, selectedKeys: keys });
  });

  return router;
}
