import { Router, Request, Response } from 'express';
import { OAuthStateStore } from './OAuthStateStore';
import { JiraCredentialRepository, TokenSet } from '../db/JiraCredentialRepository';
import { JIRA_OAUTH_SCOPES } from './jiraOAuthScopes';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AccessibleResource {
  id: string;
  name: string;
  url: string;
  scopes: string[];
  avatarUrl: string;
}

type FetchFn = typeof globalThis.fetch;

/**
 * Creates an Express Router with two endpoints:
 *   GET /start    — initiates OAuth 3LO flow
 *   GET /callback — handles Atlassian authorization callback
 *
 * fetchFn is injectable for testing; defaults to global fetch (Node 20+).
 */
export function createJiraOAuthRouter(
  stateStore: OAuthStateStore,
  repo: JiraCredentialRepository,
  config: OAuthConfig,
  fetchFn: FetchFn = globalThis.fetch
): Router {
  const router = Router();

  // GET /start
  // Generates a CSRF state nonce, constructs the Atlassian authorize URL with the
  // full scope set, and redirects the browser. Rejects http:// redirect URIs with 400.
  router.get('/start', (_req: Request, res: Response) => {
    if (!config.redirectUri.startsWith('https://')) {
      console.error(
        `[jira-oauth] OAUTH_REDIRECT_URI must use HTTPS, rejecting: ${config.redirectUri}`
      );
      res.status(400).json({ error: 'redirect_uri_must_be_https' });
      return;
    }

    const state = stateStore.generate();
    const params = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: config.clientId,
      scope: JIRA_OAUTH_SCOPES.join(' '),
      redirect_uri: config.redirectUri,
      state,
      response_type: 'code',
      prompt: 'consent',
    });

    const authorizeUrl = `https://auth.atlassian.com/authorize?${params.toString()}`;
    res.redirect(302, authorizeUrl);
  });

  // GET /callback
  // Validates the CSRF state nonce, exchanges the authorization code for tokens,
  // retrieves accessible resources and account identity, then persists credentials.
  router.get('/callback', async (req: Request, res: Response): Promise<void> => {
    const { code, state, error } = req.query as Record<string, string | undefined>;

    // Authorization was denied or errored on Atlassian's side
    if (error) {
      console.error(`[jira-oauth] authorization error from Atlassian: ${error}`);
      res.status(400).json({ error: 'authorization_denied', detail: error });
      return;
    }

    // Validate CSRF state (single-use, 10-min TTL)
    if (!state || !stateStore.consume(state)) {
      console.error('[jira-oauth] invalid or expired state nonce');
      res.status(400).json({ error: 'invalid_state' });
      return;
    }

    if (!code) {
      res.status(400).json({ error: 'missing_code' });
      return;
    }

    // --- Step 1: Exchange authorization code for tokens ---
    let accessToken: string;
    let refreshToken: string;
    let expiresIn: number;

    try {
      const tokenRes = await fetchFn('https://auth.atlassian.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: config.redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        console.error(`[jira-oauth] token exchange failed: ${tokenRes.status} ${body}`);
        res.status(400).json({ error: 'token_exchange_failed', status: tokenRes.status });
        return;
      }

      const tokenData = (await tokenRes.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in?: number;
      };
      accessToken = tokenData.access_token;
      refreshToken = tokenData.refresh_token;
      expiresIn = tokenData.expires_in ?? 3600;
    } catch (err) {
      console.error('[jira-oauth] token exchange network error:', err);
      res.status(500).json({ error: 'token_exchange_network_error' });
      return;
    }

    // 30-second safety buffer per architecture spec §4
    const accessTokenExpiresAt = Math.floor(Date.now() / 1000) + expiresIn - 30;

    // --- Step 2: Enumerate accessible Jira sites ---
    let sites: AccessibleResource[];
    try {
      const sitesRes = await fetchFn(
        'https://api.atlassian.com/oauth/token/accessible-resources',
        { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }
      );

      if (!sitesRes.ok) {
        const body = await sitesRes.text();
        console.error(`[jira-oauth] accessible-resources failed: ${sitesRes.status} ${body}`);
        res.status(500).json({ error: 'accessible_resources_failed' });
        return;
      }

      sites = (await sitesRes.json()) as AccessibleResource[];
    } catch (err) {
      console.error('[jira-oauth] accessible-resources network error:', err);
      res.status(500).json({ error: 'accessible_resources_network_error' });
      return;
    }

    // --- Step 3: Verify accountId via /me ---
    let accountId: string;
    try {
      const meRes = await fetchFn('https://api.atlassian.com/me', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });

      if (!meRes.ok) {
        const body = await meRes.text();
        console.error(`[jira-oauth] /me verification failed: ${meRes.status} ${body}`);
        res.status(500).json({ error: 'me_verification_failed' });
        return;
      }

      const me = (await meRes.json()) as { accountId: string };
      accountId = me.accountId;
    } catch (err) {
      console.error('[jira-oauth] /me network error:', err);
      res.status(500).json({ error: 'me_network_error' });
      return;
    }

    // --- Step 4: Persist credentials for all sites atomically ---
    const tokens: TokenSet = { accessToken, refreshToken, accessTokenExpiresAt };
    for (const site of sites) {
      repo.upsertConnection(site.id, tokens, config.clientId, site.url, accountId);
      console.log(
        `[jira-oauth] account verified accountId=${accountId} cloudId=${site.id}`
      );
    }

    // Build the result payload for the frontend SitePicker.
    // The SPA reads ?oauth_result=<base64url> on page load (JiraConnectFlow.tsx).
    const payload =
      sites.length === 1
        ? { status: 'connected', site: sites[0] }
        : { status: 'connected', sites };

    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const frontendOrigin = config.redirectUri.replace(/\/api\/.*$/, '');
    res.redirect(302, `${frontendOrigin}/?oauth_result=${encoded}`);
  });

  return router;
}
