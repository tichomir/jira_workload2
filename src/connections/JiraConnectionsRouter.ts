import { Router, Request, Response } from 'express';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';

/**
 * Creates an Express Router for connection management:
 *   POST /select — finalises site selection from the multi-site picker.
 *
 * The frontend SitePicker calls POST /api/jira/connections/select with
 * { cloudId } after the user chooses from the list returned by the callback.
 */
export function createJiraConnectionsRouter(repo: JiraCredentialRepository): Router {
  const router = Router();

  // POST /select
  // Verifies a credential row exists for the given cloudId (upserted during OAuth
  // callback) and returns the resolved site info for the frontend connected state.
  router.post('/select', (req: Request, res: Response): void => {
    const { cloudId } = req.body as { cloudId?: string };

    if (!cloudId || typeof cloudId !== 'string') {
      res.status(400).json({ error: 'missing_cloud_id' });
      return;
    }

    const credential = repo.getByCloudId(cloudId);
    if (!credential) {
      res.status(404).json({ error: 'cloud_id_not_found' });
      return;
    }

    res.json({
      status: 'connected',
      site: {
        id: credential.cloudId,
        name: credential.siteUrl,   // name not stored separately; siteUrl used as fallback
        url: credential.siteUrl,
        scopes: [],                  // scopes are stored in the OAuth token, not the credential row
        avatarUrl: '',
      },
    });
  });

  return router;
}
