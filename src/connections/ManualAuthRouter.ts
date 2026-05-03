/**
 * ManualAuthRouter — POST /api/connections/manual
 *
 * Validates HTTP Basic (API Token) credentials, performs a live verification
 * call via the canonical JiraHttpClient, and persists the credential only on
 * successful verification.
 *
 * Typed error codes returned on failure:
 *   INVALID_URL      — siteUrl is not https://*.atlassian.net
 *   INVALID_CLOUDID  — cloudId is not a valid UUID
 *   INVALID_EMAIL    — email fails RFC 5322 format check
 *   INVALID_TOKEN    — apiToken is empty
 *   AUTH_FAILED      — /rest/api/3/myself returned non-200 (wrong credentials)
 *   NETWORK_ERROR    — network-level failure reaching Atlassian
 */

import { Router, Request, Response } from 'express';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';
import { JiraHttpClient, AuthError } from '../http/JiraHttpClient';

type FetchFn = typeof globalThis.fetch;

// ─── validation helpers ──────────────────────────────────────────────────────

const ATLASSIAN_NET_RE = /^https:\/\/[a-zA-Z0-9-]+\.atlassian\.net(\/.*)?$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Simplified RFC 5322 check: local@domain.tld — rejects bare locals and missing TLD
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── router factory ──────────────────────────────────────────────────────────

/**
 * @param repo     Credential store (shared with OAuth router).
 * @param fetchFn  Injected for testing; defaults to globalThis.fetch.
 */
export function createManualAuthRouter(
  repo: JiraCredentialRepository,
  fetchFn: FetchFn = globalThis.fetch,
): Router {
  const router = Router();

  /**
   * POST /
   * Body: { siteUrl: string; cloudId: string; email: string; apiToken: string }
   *
   * On success: { status: 'connected'; accountId: string }
   * On failure: { error: '<ERROR_CODE>'; message?: string }
   */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const { siteUrl, cloudId, email, apiToken } = req.body as {
      siteUrl?: string;
      cloudId?: string;
      email?: string;
      apiToken?: string;
    };

    // ── input validation ─────────────────────────────────────────────────────

    if (!siteUrl || typeof siteUrl !== 'string' || !ATLASSIAN_NET_RE.test(siteUrl)) {
      res.status(400).json({
        error: 'INVALID_URL',
        message: 'siteUrl must be https://<subdomain>.atlassian.net',
      });
      return;
    }

    if (!cloudId || typeof cloudId !== 'string' || !UUID_RE.test(cloudId)) {
      res.status(400).json({
        error: 'INVALID_CLOUDID',
        message: 'cloudId must be a valid UUID',
      });
      return;
    }

    if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
      res.status(400).json({
        error: 'INVALID_EMAIL',
        message: 'email must be a valid RFC 5322 address',
      });
      return;
    }

    if (!apiToken || typeof apiToken !== 'string' || apiToken.trim().length === 0) {
      res.status(400).json({
        error: 'INVALID_TOKEN',
        message: 'apiToken must be a non-empty string',
      });
      return;
    }

    // ── live verification via canonical HTTP client ───────────────────────────

    const client = new JiraHttpClient(
      cloudId,
      repo,
      'api_token',
      { email, apiToken },
      fetchFn,
    );

    let accountId: string;
    try {
      const myself = (await client.get(
        '/rest/api/3/myself',
      )) as { accountId?: string };

      if (!myself.accountId) {
        res.status(401).json({
          error: 'AUTH_FAILED',
          message: 'Verification succeeded but accountId was absent in response',
        });
        return;
      }
      accountId = myself.accountId;
    } catch (err) {
      if (err instanceof AuthError && err.code === 'AUTH_FAILED') {
        res.status(401).json({
          error: 'AUTH_FAILED',
          message: 'Credentials rejected by Atlassian (/rest/api/3/myself returned 401)',
        });
        return;
      }
      console.error('[jira-manual-auth] network error during verification:', err);
      res.status(502).json({
        error: 'NETWORK_ERROR',
        message: 'Unable to reach Atlassian to verify credentials',
      });
      return;
    }

    // ── persist only after successful verification ────────────────────────────

    repo.upsertApiTokenConnection(cloudId, siteUrl, email, apiToken, accountId);
    console.log(
      `[jira-manual-auth] account_verified accountId=${accountId} cloudId=${cloudId}`,
    );

    res.status(200).json({ status: 'connected', accountId });
  });

  return router;
}
