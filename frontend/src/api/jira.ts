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

// ── Project Inventory Search ──────────────────────────────────────────────────

export interface ProjectIssuesParams {
  q?: string;
  /** Jira workflow status filter (case-insensitive exact match). */
  status?: string;
  issueType?: string;
  priority?: string;
  /** Assignee Atlassian account ID (exact match). */
  assigneeAccountId?: string;
  /** Labels — issue must carry at least one of the supplied values. */
  labels?: string[];
  /** ISO 8601 date — include only issues updated on or after this date. */
  updatedFrom?: string;
  /** ISO 8601 date — include only issues updated on or before this date. */
  updatedTo?: string;
  offset?: number;
  limit?: number;
}

/**
 * Fetches issues within a specific project from the latest backup point,
 * applying optional search query and field filters.
 * - `q` matching an issue-key pattern (e.g. PROJ-1) performs an exact lookup.
 * - Otherwise `q` is tokenised for AND-substring summary search.
 */
export async function fetchProjectIssues(
  cloudId: string,
  projectKey: string,
  params: ProjectIssuesParams = {},
): Promise<IssuesResponse> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.status) qs.set('status', params.status);
  if (params.issueType) qs.set('issueType', params.issueType);
  if (params.priority) qs.set('priority', params.priority);
  if (params.assigneeAccountId) qs.set('assigneeAccountId', params.assigneeAccountId);
  if (params.labels && params.labels.length > 0) {
    params.labels.forEach((l) => qs.append('labels', l));
  }
  if (params.updatedFrom) qs.set('updatedFrom', params.updatedFrom);
  if (params.updatedTo) qs.set('updatedTo', params.updatedTo);
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const url = `/api/inventory/projects/${encodeURIComponent(projectKey)}/issues${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetch(url, { headers: { 'x-cloud-id': cloudId } });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) emitAuthError(res.status);
    throw new ApiError(res.status, `fetchProjectIssues failed: ${res.status}`);
  }
  return res.json() as Promise<IssuesResponse>;
}

// ── Restore ───────────────────────────────────────────────────────────────────

export type RestoreScope =
  | { type: 'all' }
  | { type: 'projects'; projectKeys: string[] }
  | { type: 'issues'; issueKeys: string[] };

export type RestoreDestination =
  | { type: 'original' }
  | { type: 'alternate'; targetProjectKey: string }
  | { type: 'export' };

export type ConflictMode = 'override' | 'skip' | 'ask';

export type RestoreJobStatus =
  | 'pending'
  | 'running'
  | 'awaiting_decision'
  | 'completed'
  | 'completed_with_errors'
  | 'failed';

export type RestorePhase =
  | 'project'
  | 'workflow'
  | 'custom_field'
  | 'board'
  | 'sprint'
  | 'issue_body'
  | 'post_issue';

export interface PhaseProgress {
  phase: RestorePhase;
  status: 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed';
  total: number;
  processed: number;
  errorCount: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RestoreJob {
  jobId: string;
  sourceBackupPointId: string;
  createdAt: string;
  scope: RestoreScope;
  destination: RestoreDestination;
  conflictMode: ConflictMode;
  status: RestoreJobStatus;
  currentPhase: RestorePhase | null;
  phaseProgress: PhaseProgress[];
  errorCount: number;
  failureDiagnostic: string | null;
  adfMediaWarningEmitted: boolean;
  trashWindowBlocked: boolean;
}

export interface CreateRestoreJobPayload {
  sourceBackupPointId: string;
  scope: RestoreScope;
  destination: RestoreDestination;
  conflictMode: ConflictMode;
}

export interface TrashWindowBlockError {
  error: 'TRASH_WINDOW_BLOCK';
  message: string;
  affectedProjectKeys: string[];
}

export class RestoreApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly affectedProjectKeys?: string[],
  ) {
    super(message);
    this.name = 'RestoreApiError';
  }
}

/**
 * Creates a new restore job.
 * Throws RestoreApiError with code='TRASH_WINDOW_BLOCK' when the destination
 * project is in Atlassian's 60-day trash window.
 */
export async function createRestoreJob(
  payload: CreateRestoreJobPayload,
): Promise<RestoreJob> {
  const res = await fetch('/restore/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; message?: string; affectedProjectKeys?: string[] };
    throw new RestoreApiError(
      res.status,
      body.error ?? 'UNKNOWN',
      body.message ?? `createRestoreJob failed: ${res.status}`,
      body.affectedProjectKeys,
    );
  }

  return res.json() as Promise<RestoreJob>;
}

/**
 * Polls the current state of a restore job.
 */
export async function fetchRestoreJob(jobId: string): Promise<RestoreJob> {
  const res = await fetch(`/restore/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; message?: string };
    throw new RestoreApiError(
      res.status,
      body.error ?? 'UNKNOWN',
      body.message ?? `fetchRestoreJob failed: ${res.status}`,
    );
  }
  return res.json() as Promise<RestoreJob>;
}

/**
 * Resolves an Ask-mode conflict decision.
 */
export async function resolveConflict(
  jobId: string,
  conflictId: string,
  decision: 'override' | 'skip',
): Promise<void> {
  const res = await fetch(`/restore/jobs/${encodeURIComponent(jobId)}/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conflictId, decision }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; message?: string };
    throw new RestoreApiError(
      res.status,
      body.error ?? 'UNKNOWN',
      body.message ?? `resolveConflict failed: ${res.status}`,
    );
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Strips oauth_* query params from the URL without triggering a page reload. */
export function clearOAuthParams(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('oauth_result');
  url.searchParams.delete('oauth_error');
  window.history.replaceState({}, '', url.toString());
}
