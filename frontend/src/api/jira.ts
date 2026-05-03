import type { JiraSite } from '../types';
import { emitAuthError } from './authErrorChannel';

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
    if (res.status === 401 || res.status === 403) {
      emitAuthError(res.status);
    }
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

// ── Manual API Token connection ───────────────────────────────────────────────

export interface ManualConnectionPayload {
  siteUrl: string;
  cloudId: string;
  email: string;
  apiToken: string;
}

export interface ManualConnectionSuccess {
  status: 'connected';
  accountId: string;
}

export class ManualAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ManualAuthError';
  }
}

/**
 * POSTs manual API Token credentials to the backend for verification and
 * persistence. Throws ManualAuthError for typed backend error codes or ApiError
 * for unexpected HTTP failures.
 */
export async function submitManualConnection(
  payload: ManualConnectionPayload,
): Promise<ManualConnectionSuccess> {
  const res = await fetch('/api/connections/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      emitAuthError(res.status);
    }
    const body = await res.json().catch(() => ({})) as { error?: string; message?: string };
    if (body.error) {
      throw new ManualAuthError(body.error, body.message ?? body.error);
    }
    throw new ApiError(res.status, `Manual connection failed: ${res.status}`);
  }

  return res.json() as Promise<ManualConnectionSuccess>;
}

// ── Discovery preview & workload config ──────────────────────────────────────

export interface DiscoveryPreviewProject {
  id: string;
  key: string;
  name: string;
}

export interface DiscoveryPreview {
  projects: DiscoveryPreviewProject[];
  jsmProjectsDetected: number;
}

export interface WorkloadConfigPayload {
  cloudId: string;
  scope: 'all' | 'selected';
  selectedKeys: string[];
}

/**
 * Fetches a discovery preview for the onboarding scope selector.
 * Returns the first batch of in-scope projects plus a JSM detection count.
 */
export async function fetchDiscoveryPreview(cloudId: string): Promise<DiscoveryPreview> {
  const res = await fetch(`/api/jira/discovery/preview?cloudId=${encodeURIComponent(cloudId)}`);
  if (!res.ok) {
    throw new ApiError(res.status, `fetchDiscoveryPreview failed: ${res.status}`);
  }
  return res.json() as Promise<DiscoveryPreview>;
}

/**
 * Fetches the persisted workload config for a connected site.
 * Returns default { scope: 'all', selectedKeys: [] } when not yet configured.
 */
export async function fetchWorkloadConfig(
  cloudId: string,
): Promise<{ scope: 'all' | 'selected'; selectedKeys: string[] }> {
  const res = await fetch(`/api/jira/workload-config?cloudId=${encodeURIComponent(cloudId)}`);
  if (!res.ok) {
    throw new ApiError(res.status, `fetchWorkloadConfig failed: ${res.status}`);
  }
  return res.json() as Promise<{ scope: 'all' | 'selected'; selectedKeys: string[] }>;
}

/**
 * Persists workload configuration (scope + selected project keys) for a site.
 */
export async function saveWorkloadConfig(payload: WorkloadConfigPayload): Promise<void> {
  const res = await fetch('/api/jira/workload-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new ApiError(res.status, `saveWorkloadConfig failed: ${res.status}`);
  }
}

// ── Inventory ─────────────────────────────────────────────────────────────────

export interface InventorySummary {
  backupPointId: string | null;
  counts: {
    JiraIssue: number;
    JiraProject: number;
    JiraBoard: number;
    JiraSprint: number;
  };
}

/**
 * Fetches per-type object counts from the latest backup point manifest.
 * Passes cloudId as x-cloud-id header.
 */
export async function fetchInventorySummary(
  cloudId: string,
): Promise<InventorySummary> {
  const res = await fetch('/api/inventory/summary', {
    headers: { 'x-cloud-id': cloudId },
  });
  if (!res.ok) {
    throw new ApiError(res.status, `fetchInventorySummary failed: ${res.status}`);
  }
  return res.json() as Promise<InventorySummary>;
}

// ── Issues table ──────────────────────────────────────────────────────────────

export interface IssueTableRow {
  issueKey: string;
  summary: string | null;
  issueStatus: string | null;
  issueType: string | null;
  assignee: string | null;
  platformStatus: 'protected' | 'error';
  policy: string;
  lastBackupAt: string;
  backupPointId: string;
}

export interface IssuesResponse {
  issues: IssueTableRow[];
  total: number;
  backupPointId: string | null;
}

/**
 * Fetches a paginated list of Issues from the latest backup point.
 * Passes cloudId as x-cloud-id header.
 */
export async function fetchIssues(
  cloudId: string,
  params: { offset?: number; limit?: number } = {},
): Promise<IssuesResponse> {
  const qs = new URLSearchParams();
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const url = `/api/inventory/issues${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetch(url, { headers: { 'x-cloud-id': cloudId } });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) emitAuthError(res.status);
    throw new ApiError(res.status, `fetchIssues failed: ${res.status}`);
  }
  return res.json() as Promise<IssuesResponse>;
}

// ── Global search ─────────────────────────────────────────────────────────────

export interface SearchCard {
  type: 'JiraProject' | 'JiraBoard' | 'JiraSprint' | 'JiraIssue';
  id: string;
  displayName: string;
  projectKey?: string;
  lastBackupAt: string | null;
}

export interface SearchResponse {
  results: SearchCard[];
}

/**
 * Searches across projectKey, projectName, boardName, sprintName.
 * Returns typed Protected Object cards.
 */
export async function searchInventory(
  cloudId: string,
  q: string,
): Promise<SearchResponse> {
  const url = `/api/search?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'x-cloud-id': cloudId } });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) emitAuthError(res.status);
    throw new ApiError(res.status, `searchInventory failed: ${res.status}`);
  }
  return res.json() as Promise<SearchResponse>;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Strips oauth_* query params from the URL without triggering a page reload. */
export function clearOAuthParams(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('oauth_result');
  url.searchParams.delete('oauth_error');
  window.history.replaceState({}, '', url.toString());
}
