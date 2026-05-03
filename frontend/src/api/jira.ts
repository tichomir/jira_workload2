import type { JiraSite } from '../types';

/**
 * Navigates the browser to the backend OAuth start endpoint.
 * The backend enforces HTTPS-only redirect URIs and generates a CSRF nonce.
 */
export function initiateOAuth(): void {
  window.location.href = '/api/jira/oauth/start';
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * POSTs the selected cloudId to the backend to finalise the connection.
 * Throws ApiError for 4xx/5xx responses.
 */
export async function selectSite(cloudId: string): Promise<{ status: 'connected'; site: JiraSite }> {
  const res = await fetch('/api/jira/connections/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cloudId }),
  });

  if (!res.ok) {
    throw new ApiError(res.status, `selectSite failed: ${res.status}`);
  }

  return res.json() as Promise<{ status: 'connected'; site: JiraSite }>;
}

/**
 * Parses the OAuth callback result from the URL query parameter injected by
 * the backend after /api/jira/oauth/callback completes.
 *
 * The backend redirects to the frontend with:
 *   ?oauth_result=<base64url-encoded JSON of OAuthCallbackResult>
 *
 * Returns null if the query param is absent (normal page load, not a callback).
 * Returns an error descriptor if the param is present but malformed.
 */
export function parseOAuthCallbackParam():
  | { ok: true; data: { status: string; site?: JiraSite; sites?: JiraSite[] } }
  | { ok: false; reason: string }
  | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('oauth_result');
  const errorParam = params.get('oauth_error');

  if (errorParam) {
    return { ok: false, reason: errorParam };
  }

  if (!raw) {
    return null;
  }

  try {
    // base64url → JSON
    const json = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const data = JSON.parse(json) as { status: string; site?: JiraSite; sites?: JiraSite[] };
    return { ok: true, data };
  } catch {
    return { ok: false, reason: 'malformed_oauth_result' };
  }
}

/** Strips oauth_* query params from the URL without triggering a page reload. */
export function clearOAuthParams(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('oauth_result');
  url.searchParams.delete('oauth_error');
  window.history.replaceState({}, '', url.toString());
}
