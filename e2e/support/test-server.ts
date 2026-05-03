/**
 * Minimal test server for Playwright E2E tests.
 *
 * Combines:
 *   - Real JiraOAuthHandler + JiraConnectionsRouter (backend under test)
 *   - Mock Atlassian endpoints (local intercepts so no real network traffic)
 *   - Minimal frontend HTML page (vanilla JS, same ARIA roles as the React app)
 *   - Test-only endpoints: GET /api/test/credential/:cloudId, POST /api/test/reset
 *
 * The OAuth redirect URI is set to http://localhost:<port>/api/jira/oauth/callback
 * and the HTTPS enforcement check is bypassed for localhost in the test config.
 */

import express, { Request, Response } from 'express';
import Database from 'better-sqlite3';
import { createServer, Server } from 'http';
import { JiraCredentialRepository } from '../../src/db/JiraCredentialRepository';
import { OAuthStateStore } from '../../src/auth/OAuthStateStore';
import { createJiraOAuthRouter } from '../../src/auth/JiraOAuthHandler';
import { createJiraConnectionsRouter } from '../../src/connections/JiraConnectionsRouter';

// ── Mock Atlassian fixtures ───────────────────────────────────────────────────

const MOCK_SITE = {
  id: 'cloud-e2e-pw-001',
  name: 'Playwright Test Site',
  url: 'https://playwright-test.atlassian.net',
  scopes: ['manage:jira-configuration', 'read:jira-work'],
  avatarUrl: '',
};

const MOCK_TOKENS = {
  access_token: 'pw_access_token_abc',
  refresh_token: 'pw_refresh_token_xyz',
  expires_in: 3600,
};

const MOCK_ME = { accountId: 'account-pw-999' };

// ── Injectable fetch that intercepts Atlassian API calls ─────────────────────

function createMockFetch(overrides: { accessibleResources401?: boolean; me401?: boolean } = {}) {
  return async (url: string, _opts?: RequestInit): Promise<Response> => {
    const makeRes = (body: unknown, status = 200): Response =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      }) as unknown as Response;

    if (url === 'https://auth.atlassian.com/oauth/token') {
      return makeRes(MOCK_TOKENS);
    }
    if (url === 'https://api.atlassian.com/oauth/token/accessible-resources') {
      return overrides.accessibleResources401
        ? makeRes({ error: 'Unauthorized' }, 401)
        : makeRes([MOCK_SITE]);
    }
    if (url === 'https://api.atlassian.com/me') {
      return overrides.me401 ? makeRes({ error: 'Unauthorized' }, 401) : makeRes(MOCK_ME);
    }
    return Promise.reject(new Error(`[test-server] Unexpected fetch URL: ${url}`));
  };
}

// ── Minimal frontend HTML ─────────────────────────────────────────────────────

const FRONTEND_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Jira OAuth Test App</title>
</head>
<body>
  <div id="app"></div>
  <script>
    (function () {
      var params = new URLSearchParams(location.search);
      var oauthResult = params.get('oauth_result');
      var oauthError  = params.get('oauth_error');

      // Strip OAuth params from URL bar (mirrors clearOAuthParams())
      var cleanUrl = new URL(location.href);
      cleanUrl.searchParams.delete('oauth_result');
      cleanUrl.searchParams.delete('oauth_error');
      history.replaceState({}, '', cleanUrl.toString());

      var app = document.getElementById('app');

      if (oauthError) {
        renderError(oauthError);
      } else if (oauthResult) {
        try {
          var data = JSON.parse(atob(oauthResult.replace(/-/g,'+').replace(/_/g,'/')));
          if (data.status === 'connected' && data.site) {
            renderConnected(data.site);
          } else if (data.status === 'connected' && data.sites && data.sites.length > 0) {
            renderSitePicker(data.sites);
          } else {
            renderError('unexpected_response');
          }
        } catch (e) {
          renderError('malformed_oauth_result');
        }
      } else {
        renderIdle();
      }

      function renderIdle() {
        app.innerHTML =
          '<p id="idle-prompt">Authorise with your Atlassian account to connect Jira Cloud.</p>' +
          '<button id="connect-btn" onclick="window.location.href=\\'/api/jira/oauth/start\\'">Connect Jira Cloud</button>';
      }

      function renderConnected(site) {
        app.innerHTML =
          '<div role="status" aria-live="polite" id="auto-banner">Connected to <span id="site-name">' + esc(site.name) + '</span></div>' +
          '<div class="connected-card">' +
          '  <p class="site-name">' + esc(site.name) + '</p>' +
          '  <p class="site-url">' + esc(site.url) + '</p>' +
          '  <span class="badge">Connected</span>' +
          '  <p class="site-id" data-cloud-id="' + esc(site.id) + '">' + esc(site.id) + '</p>' +
          '</div>';
      }

      function renderSitePicker(sites) {
        var opts = sites.map(function(s) {
          return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>';
        }).join('');
        app.innerHTML =
          '<select role="listbox" id="site-select" size="' + sites.length + '">' + opts + '</select>' +
          '<button id="confirm-btn">Connect to selected</button>';
        document.getElementById('confirm-btn').addEventListener('click', function() {
          var cloudId = document.getElementById('site-select').value;
          fetch('/api/jira/connections/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cloudId: cloudId })
          })
          .then(function(r) { return r.json(); })
          .then(function(data) { renderConnected(data.site); })
          .catch(function() { renderError('select_failed'); });
        });
      }

      function renderError(reason) {
        app.innerHTML =
          '<div role="alert" id="error-banner">' +
          '  <p id="error-headline">Your Jira session has expired or the credentials are invalid.</p>' +
          '  <p id="error-detail">' + esc(String(reason)) + '</p>' +
          '  <button id="reconnect-btn" onclick="window.location.href=\\'/api/jira/oauth/start\\'">Reconnect</button>' +
          '</div>';
      }

      function esc(str) {
        return String(str)
          .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }
    })();
  </script>
</body>
</html>`;

// ── Server factory ────────────────────────────────────────────────────────────

export interface TestServerHandle {
  server: Server;
  db: Database.Database;
  port: number;
  mockSite: typeof MOCK_SITE;
  mockTokens: typeof MOCK_TOKENS;
}

export async function startTestServer(
  port: number,
  opts: { accessibleResources401?: boolean; me401?: boolean } = {},
): Promise<TestServerHandle> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  JiraCredentialRepository.runMigration(db);
  const repo = new JiraCredentialRepository(db);
  const stateStore = new OAuthStateStore();

  // Config: http://localhost is allowed in test mode (HTTPS check tested separately
  // via the /start endpoint with an HTTP_CONFIG in unit tests).
  const config = {
    clientId: 'pw-test-client-id',
    clientSecret: 'pw-test-client-secret',
    // Use http for the local test server; the /start endpoint will 302 to this.
    // We bypass the HTTPS guard by pointing to a localhost path that the router
    // will accept when we configure it with a custom config that has no HTTPS check.
    redirectUri: `http://localhost:${port}/api/jira/oauth/callback`,
  };

  const mockFetch = createMockFetch(opts) as unknown as typeof globalThis.fetch;

  const app = express();
  app.use(express.json());

  // Serve minimal frontend
  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(FRONTEND_HTML);
  });

  // Backend routes — NOTE: we bypass HTTPS enforcement by using the real router
  // but with a modified config. The /start HTTPS enforcement is tested in unit tests.
  // Here we patch the router to accept http://localhost for test purposes.
  const oauthRouter = createJiraOAuthRouter(stateStore, repo, config, mockFetch);

  // Override /start to not enforce HTTPS (test-only bypass)
  app.get('/api/jira/oauth/start', (_req: Request, res: Response) => {
    const { randomBytes } = require('crypto') as typeof import('crypto');
    const state = stateStore.generate();
    const params = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: config.clientId,
      scope: 'read:jira-work manage:jira-configuration',
      redirect_uri: config.redirectUri,
      state,
      response_type: 'code',
      prompt: 'consent',
    });
    res.redirect(302, `https://auth.atlassian.com/authorize?${params}`);
  });

  // Callback route uses the real handler (which calls the mock fetch)
  app.use('/api/jira/oauth', oauthRouter);
  app.use('/api/jira/connections', createJiraConnectionsRouter(repo));

  // Test-only endpoint: read credential row by cloudId
  app.get('/api/test/credential/:cloudId', (req: Request, res: Response) => {
    const cred = repo.getByCloudId(req.params.cloudId);
    if (!cred) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(cred);
  });

  // Test-only endpoint: seed a credential directly (for banner tests)
  app.post('/api/test/seed', (req: Request, res: Response) => {
    const { cloudId, accessToken, refreshToken, siteUrl, accountId } = req.body as {
      cloudId: string;
      accessToken: string;
      refreshToken: string;
      siteUrl: string;
      accountId: string;
    };
    repo.upsertConnection(
      cloudId,
      { accessToken, refreshToken, accessTokenExpiresAt: 9_999_999_999 },
      'pw-test-client-id',
      siteUrl,
      accountId,
    );
    res.json({ ok: true });
  });

  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(port, () => {
      resolve({ server, db, port, mockSite: MOCK_SITE, mockTokens: MOCK_TOKENS });
    });
  });
}

export async function stopTestServer(handle: TestServerHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    handle.server.close((err) => {
      handle.db.close();
      if (err) reject(err);
      else resolve();
    });
  });
}
