/**
 * JiraHttpClient — the single canonical authenticated HTTP client for all
 * Jira Cloud API calls. Feature code MUST NOT instantiate raw fetch() calls
 * against *.atlassian.com; use this module instead.
 *
 * Supports:
 *   - OAuth 2.0 Bearer auth with mutex-guarded atomic rotating-refresh-token handler
 *   - HTTP Basic (email:apiToken) auth for manual connection path
 *
 * Public API:
 *   get(path)           → parsed JSON response body
 *   post(path, body)    → parsed JSON response body
 *   getBinary(path)     → Buffer (for attachment downloads)
 */

import { JiraCredentialRepository } from '../db/JiraCredentialRepository';

type FetchFn = typeof globalThis.fetch;

// ─── Error types ────────────────────────────────────────────────────────────

export type AuthErrorCode =
  | 'NO_CREDENTIAL'
  | 'AUTH_FAILED'
  | 'REFRESH_FAILED'
  | 'REFRESH_NETWORK_ERROR';

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class JiraHttpClient {
  /**
   * Holds the in-flight refresh promise. When non-null, concurrent 401
   * handlers await it instead of firing a second refresh POST.
   * Set to null by the `finally` block after the refresh resolves or rejects.
   */
  private refreshInFlight: Promise<void> | null = null;

  /**
   * @param cloudId          Atlassian cloud site ID used to look up credentials
   *                         and to build the Jira REST base URL.
   * @param repo             Credential repository for token reads / rotation.
   * @param connectorType    'jira' = OAuth Bearer; 'api_token' = HTTP Basic.
   * @param explicitBasicAuth When provided, overrides DB lookup for a single
   *                         verification call (pre-storage — no refresh).
   * @param fetchFn          Injected for testing; defaults to globalThis.fetch.
   */
  constructor(
    private readonly cloudId: string,
    private readonly repo: JiraCredentialRepository,
    private readonly connectorType: 'jira' | 'api_token' = 'jira',
    private readonly explicitBasicAuth?: { email: string; apiToken: string },
    private readonly fetchFn: FetchFn = globalThis.fetch,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  async get(path: string): Promise<unknown> {
    const response = await this.execute('GET', path);
    if (response.status === 401) {
      throw new AuthError('AUTH_FAILED', `GET ${path} returned 401 Unauthorized`);
    }
    if (!response.ok) {
      throw new Error(`[jira-http] GET ${path} → ${response.status}`);
    }
    return response.json();
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.execute('POST', path, body);
    if (response.status === 401) {
      throw new AuthError('AUTH_FAILED', `POST ${path} returned 401 Unauthorized`);
    }
    if (!response.ok) {
      throw new Error(`[jira-http] POST ${path} → ${response.status}`);
    }
    return response.json();
  }

  /**
   * Downloads binary content (e.g. attachments) byte-for-byte.
   * The caller receives a Buffer with the original content unmodified.
   */
  async getBinary(path: string): Promise<Buffer> {
    const response = await this.execute('GET', path);
    if (response.status === 401) {
      throw new AuthError('AUTH_FAILED', `getBinary ${path} returned 401 Unauthorized`);
    }
    if (!response.ok) {
      throw new Error(`[jira-http] getBinary ${path} → ${response.status}`);
    }
    const ab = await response.arrayBuffer();
    return Buffer.from(ab);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /**
   * Core request dispatcher. Injects the Authorization header, fires the
   * request, and on a 401 (OAuth mode only) triggers one atomic token refresh
   * then replays the original request. On retry the fresh token is read from
   * the credential store (which `ensureTokenRefreshed` has already updated).
   */
  private async execute(
    method: string,
    path: string,
    body?: unknown,
    isRetry = false,
  ): Promise<Response> {
    const url = this.buildUrl(path);
    const authHeader = this.getAuthHeader();

    const headers: Record<string, string> = {
      Authorization: authHeader,
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    console.log(`[jira-http] request method=${method} path=${path}`);

    const response = await this.fetchFn(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    console.log(
      `[jira-http] response method=${method} path=${path} status=${response.status}`,
    );

    // 401 handling: only for OAuth Bearer mode, only on first attempt.
    // explicitBasicAuth (pre-storage verification) never refreshes.
    if (
      response.status === 401 &&
      !isRetry &&
      !this.explicitBasicAuth &&
      this.connectorType === 'jira'
    ) {
      const cred = this.repo.getByCloudId(this.cloudId);
      if (!cred) {
        throw new AuthError(
          'NO_CREDENTIAL',
          `No OAuth credential for cloudId=${this.cloudId}`,
        );
      }
      await this.ensureTokenRefreshed(cred.refreshToken);
      return this.execute(method, path, body, true);
    }

    return response;
  }

  /**
   * Mutex-guarded refresh coordinator. If a refresh is already in flight,
   * awaits it (so only one POST to auth.atlassian.com is fired per burst of
   * concurrent 401s). After the in-flight refresh resolves, the caller retries
   * using the newly-persisted tokens read from the credential store.
   *
   * `refreshInFlight` is reset to null in the `finally` block so subsequent
   * independent 401s can start a fresh refresh.
   */
  private async ensureTokenRefreshed(refreshToken: string): Promise<void> {
    if (this.refreshInFlight !== null) {
      // Another refresh is already in-flight; queue behind it.
      return this.refreshInFlight;
    }

    let resolveFn!: () => void;
    let rejectFn!: (err: unknown) => void;
    this.refreshInFlight = new Promise<void>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    // Suppress unhandled-rejection when no concurrent caller is awaiting
    // this promise (the creator re-throws the error through its own chain).
    this.refreshInFlight.catch(() => undefined);

    try {
      await this.doRefresh(refreshToken);
      resolveFn();
    } catch (err) {
      rejectFn(err);
      throw err;
    } finally {
      // Reset after resolve/reject so future bursts can start a new refresh.
      this.refreshInFlight = null;
    }
  }

  /**
   * Performs the actual POST to auth.atlassian.com/oauth/token and atomically
   * persists both new access_token and new refresh_token to the credential
   * store before returning (i.e. before the mutex is released).
   *
   * Per T2 §6 Constraint 4: both tokens are written inside a single
   * better-sqlite3 transaction before any waiter proceeds.
   */
  private async doRefresh(refreshToken: string): Promise<void> {
    const clientId = process.env['JIRA_OAUTH_CLIENT_ID'] ?? '';
    const clientSecret = process.env['JIRA_OAUTH_CLIENT_SECRET'] ?? '';

    let response: Response;
    try {
      response = await this.fetchFn('https://auth.atlassian.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
        }),
      });
    } catch (err) {
      console.error(`[jira-http] token_refresh outcome=error cloudId=${this.cloudId}`, err);
      throw new AuthError(
        'REFRESH_NETWORK_ERROR',
        `Token refresh network error: ${String(err)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text();
      console.error(
        `[jira-http] token_refresh outcome=error cloudId=${this.cloudId} status=${response.status} body=${body}`,
      );
      throw new AuthError(
        'REFRESH_FAILED',
        `Token refresh failed: HTTP ${response.status}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in?: number;
    };

    const expiresAt =
      Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600) - 30;

    // Atomic write: both tokens committed inside a single transaction before
    // this method returns (and therefore before the mutex is released).
    this.repo.rotateTokens(
      this.cloudId,
      data.access_token,
      data.refresh_token,
      expiresAt,
    );

    console.log(
      `[jira-http] token_refresh outcome=ok cloudId=${this.cloudId}`,
    );
  }

  /**
   * Builds the full URL for a request path. Absolute URLs (https://...) are
   * passed through unchanged; relative paths are prefixed with the Jira REST
   * base URL for this site.
   */
  private buildUrl(path: string): string {
    if (path.startsWith('https://') || path.startsWith('http://')) {
      return path;
    }
    return `https://api.atlassian.com/ex/jira/${this.cloudId}${path}`;
  }

  /**
   * Returns the Authorization header value for the current credential mode.
   * OAuth: "Bearer <access_token>" read from DB (always fresh after refresh).
   * Basic: "Basic <base64(email:apiToken)>" either from DB or explicit override.
   */
  private getAuthHeader(): string {
    if (this.explicitBasicAuth) {
      const { email, apiToken } = this.explicitBasicAuth;
      const encoded = Buffer.from(`${email}:${apiToken}`).toString('base64');
      return `Basic ${encoded}`;
    }

    if (this.connectorType === 'api_token') {
      const cred = this.repo.getApiTokenByCloudId(this.cloudId);
      if (!cred) {
        throw new AuthError(
          'NO_CREDENTIAL',
          `No api_token credential for cloudId=${this.cloudId}`,
        );
      }
      const encoded = Buffer.from(`${cred.email}:${cred.apiToken}`).toString(
        'base64',
      );
      return `Basic ${encoded}`;
    }

    // OAuth Bearer
    const cred = this.repo.getByCloudId(this.cloudId);
    if (!cred) {
      throw new AuthError(
        'NO_CREDENTIAL',
        `No OAuth credential for cloudId=${this.cloudId}`,
      );
    }
    return `Bearer ${cred.accessToken}`;
  }
}
