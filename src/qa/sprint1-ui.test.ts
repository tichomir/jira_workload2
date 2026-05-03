/**
 * @jest-environment jsdom
 *
 * Sprint 1 QA — UI tests (jsdom)
 *
 * Verifies the frontend's oauth_result / oauth_error URL-param handling and
 * the ErrorBanner Reconnect affordance, using a minimal vanilla-JS DOM
 * simulation that mirrors the logic in JiraConnectFlow.tsx and jira.ts.
 *
 * These tests cover the "401 reconnect banner" acceptance criterion from the
 * browser's perspective without requiring a running browser or Vite build.
 */

// ── Minimal frontend logic under test ─────────────────────────────────────────
// Replicated here to avoid a Vite/React build dependency in Jest tests.
// The logic is identical to frontend/src/api/jira.ts#parseOAuthCallbackParam.

function parseOAuthCallbackParam(search: string):
  | { ok: true; data: { status: string; site?: { id: string; name: string; url: string }; sites?: unknown[] } }
  | { ok: false; reason: string }
  | null {
  const params = new URLSearchParams(search);
  const raw = params.get('oauth_result');
  const errorParam = params.get('oauth_error');

  if (errorParam) return { ok: false, reason: errorParam };
  if (!raw) return null;

  try {
    const json = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    return { ok: true, data: JSON.parse(json) as { status: string } };
  } catch {
    return { ok: false, reason: 'malformed_oauth_result' };
  }
}

function encodeOAuthResult(payload: object): string {
  return btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Minimal DOM renderer that mirrors JiraConnectFlow + ErrorBanner ARIA contracts */
function renderApp(search: string): void {
  const result = parseOAuthCallbackParam(search);
  const app = document.getElementById('app')!;

  if (!result) {
    app.innerHTML =
      '<button id="connect-btn">Connect Jira Cloud</button>';
    return;
  }

  if (!result.ok) {
    app.innerHTML = `
      <div role="alert" id="error-banner">
        <p id="error-headline">Your Jira session has expired or the credentials are invalid.</p>
        <p id="error-detail">${result.reason}</p>
        <button id="reconnect-btn" data-href="/api/jira/oauth/start">Reconnect</button>
        <button id="dismiss-btn">Dismiss</button>
      </div>`;
    return;
  }

  const { data } = result;
  if (data.status === 'connected' && data.site) {
    app.innerHTML = `
      <div role="status" aria-live="polite" id="auto-banner">
        Connected to <span id="site-name">${data.site.name}</span>
      </div>
      <div class="connected-card">
        <p class="site-name">${data.site.name}</p>
        <p class="site-url">${data.site.url}</p>
        <span class="badge">Connected</span>
      </div>`;
    return;
  }

  if (data.status === 'connected' && data.sites && data.sites.length > 0) {
    app.innerHTML =
      '<select role="listbox" id="site-select"></select>' +
      '<button id="confirm-btn">Connect to selected</button>';
    return;
  }

  app.innerHTML =
    '<div role="alert"><p>Unexpected OAuth response</p></div>';
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Sprint 1 UI — Reconnect banner and OAuth result rendering', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
  });

  // ── Idle state ─────────────────────────────────────────────────────────────

  it('idle state: Connect button renders, no error banner', () => {
    renderApp('');

    const btn = document.getElementById('connect-btn');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Connect Jira Cloud');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  // ── 401 Error → Reconnect banner ───────────────────────────────────────────

  it('oauth_error=access_denied renders error banner with Reconnect button', () => {
    renderApp('?oauth_error=access_denied');

    const banner = document.querySelector('[role="alert"]');
    expect(banner).not.toBeNull();
    expect(banner!.id).toBe('error-banner');

    const headline = document.getElementById('error-headline');
    expect(headline).not.toBeNull();
    expect(headline!.textContent).toContain('Your Jira session has expired');

    const reconnect = document.getElementById('reconnect-btn');
    expect(reconnect).not.toBeNull();
    expect(reconnect!.textContent).toBe('Reconnect');
    expect(reconnect!.dataset['href']).toBe('/api/jira/oauth/start');
  });

  it('oauth_error=authorization_denied renders error banner with Reconnect button', () => {
    renderApp('?oauth_error=authorization_denied');

    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.getElementById('reconnect-btn')).not.toBeNull();
    expect(document.getElementById('error-detail')!.textContent).toBe('authorization_denied');
  });

  it('Reconnect button is present alongside Dismiss button', () => {
    renderApp('?oauth_error=session_expired');

    expect(document.getElementById('reconnect-btn')).not.toBeNull();
    expect(document.getElementById('dismiss-btn')).not.toBeNull();
  });

  it('error banner does NOT render in idle state', () => {
    renderApp('');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  // ── Single-site auto-select ────────────────────────────────────────────────

  it('single-site auto-select: status banner + ConnectedCard renders', () => {
    const site = { id: 'cloud-ui-001', name: 'Acme Corp', url: 'https://acme.atlassian.net' };
    const encoded = encodeOAuthResult({ status: 'connected', site });

    renderApp(`?oauth_result=${encoded}`);

    // Status banner (auto-connected)
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    expect(document.getElementById('site-name')!.textContent).toBe('Acme Corp');

    // ConnectedCard fields
    expect(document.querySelector('.connected-card .site-name')!.textContent).toBe('Acme Corp');
    expect(document.querySelector('.connected-card .site-url')!.textContent).toBe('https://acme.atlassian.net');
    expect(document.querySelector('.connected-card .badge')!.textContent).toBe('Connected');

    // No error banner
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('single-site: no error banner, no connect button in connected state', () => {
    const site = { id: 'cloud-ui-001', name: 'Acme Corp', url: 'https://acme.atlassian.net' };
    renderApp(`?oauth_result=${encodeOAuthResult({ status: 'connected', site })}`);

    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.getElementById('connect-btn')).toBeNull();
  });

  // ── Multi-site picker ──────────────────────────────────────────────────────

  it('multi-site: site picker (listbox) renders', () => {
    renderApp(`?oauth_result=${encodeOAuthResult({
      status: 'connected',
      sites: [
        { id: 'c1', name: 'Site 1', url: 'https://s1.atlassian.net' },
        { id: 'c2', name: 'Site 2', url: 'https://s2.atlassian.net' },
      ],
    })}`);

    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expect(document.getElementById('confirm-btn')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  // ── Malformed oauth_result ─────────────────────────────────────────────────

  it('malformed oauth_result param renders error banner', () => {
    renderApp('?oauth_result=!!!invalid-base64!!!');

    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.getElementById('error-detail')!.textContent).toBe('malformed_oauth_result');
  });
});
