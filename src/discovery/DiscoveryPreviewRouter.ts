/**
 * DiscoveryPreviewRouter — lightweight project discovery preview for the
 * onboarding wizard scope selector.
 *
 * Routes:
 *   GET  /preview             → { projects: [{id,key,name}], jsmProjectsDetected }
 */

import { Router, Request, Response } from 'express';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';
import { JiraHttpClient } from '../http/JiraHttpClient';

interface JiraProjectApiItem {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
}

interface ProjectSearchPage {
  values: JiraProjectApiItem[];
  total: number;
  isLast: boolean;
  maxResults: number;
  startAt: number;
}

export function createDiscoveryPreviewRouter(repo: JiraCredentialRepository): Router {
  const router = Router();

  // GET /preview?cloudId=<id>
  // Fetches the first page of projects (max 100) and returns in-scope projects
  // plus a count of JSM (service_desk) projects detected.
  // Used by the onboarding wizard to populate the multi-select and JSM notice.
  router.get('/preview', async (req: Request, res: Response): Promise<void> => {
    const cloudId = req.query['cloudId'] as string | undefined;

    if (!cloudId || typeof cloudId !== 'string') {
      res.status(400).json({ error: 'missing_cloud_id' });
      return;
    }

    const credential = repo.getByCloudId(cloudId);
    if (!credential) {
      res.status(404).json({ error: 'credential_not_found' });
      return;
    }

    const connectorType = credential.connectorType === 'api_token' ? 'api_token' : 'jira';
    const httpClient = new JiraHttpClient(cloudId, repo, connectorType);

    try {
      const page = (await httpClient.get(
        '/rest/api/3/project/search?maxResults=100',
      )) as ProjectSearchPage;

      const items: JiraProjectApiItem[] = page.values ?? [];

      const projects = items
        .filter((item) => item.projectTypeKey !== 'service_desk')
        .map((item) => ({ id: item.id, key: item.key, name: item.name }));

      const jsmProjectsDetected = items.filter(
        (item) => item.projectTypeKey === 'service_desk',
      ).length;

      res.json({ projects, jsmProjectsDetected });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: 'upstream_error', message });
    }
  });

  return router;
}
