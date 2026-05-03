/**
 * IssueCaptureOrchestrator
 *
 * Drives the full Issue backup pipeline for a single backup job:
 *
 *   1. Iterates over every in-scope project
 *   2. For each project, calls paginateIssues() via POST /rest/api/3/search/jql
 *   3. For each issue fetches supplemental data:
 *        - Comments (ADF body + author + timestamps)
 *        - Watchers       (/rest/api/3/issue/{key}/watchers)
 *        - Worklogs       (/rest/api/3/issue/{key}/worklog)
 *        - Attachments listed from fields.attachment (downloads deferred to task-004)
 *   4. Merges into a full IssueCapturePayload and writes to the backup store
 *   5. Records every item in the manifest (ok or error) via writer.append()
 *   6. Emits heartbeat progress events every ≤10s
 *   7. On completion: 'Completed with N errors' if any errors, else 'Completed successfully'
 *
 * Coverage invariant (PRD Goal 3):
 *   Every issue payload contains system fields, customFieldValues (all customfield_*
 *   keys), ADF comments, issue links (inward + outward), subtask refs, sprint
 *   membership (customfield_10020), watchers, worklogs.
 *
 * Per-item error contract:
 *   Each issue is wrapped in try/catch. Failure → manifest entry with status='error'.
 *   The run continues. Only on clean finish is status 'Completed successfully'.
 *
 * Heartbeat: events emitted every ≤10s (default 9000ms). If >20s elapses since the
 * last event, callers should surface a 'stalled' alert.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { JiraHttpClient, JiraIssue } from '../http/JiraHttpClient';
import { BackupPointManifestWriter } from '../manifest/BackupPointManifestWriter';
import { JiraObjectType } from '../manifest/types';
import { AttachmentBlobStore } from '../backup/AttachmentBlobStore';
import { HeartbeatEmitter } from '../jobs/HeartbeatEmitter';
import { JobStore } from '../jobs/JobStore';

// ── Default heartbeat interval ─────────────────────────────────────────────────

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 9_000; // ≤10s per spec

// ── Progress events ────────────────────────────────────────────────────────────

export type IssueProgressEventType =
  | 'heartbeat'
  | 'project_start'
  | 'project_complete'
  | 'issue_captured'
  | 'issue_error'
  | 'job_complete';

export interface IssueProgressEvent {
  type: IssueProgressEventType;
  projectKey?: string;
  issueKey?: string;
  timestamp: string;
  totalIssuesCaptured: number;
  totalErrors: number;
  message?: string;
}

// ── Full issue payload ─────────────────────────────────────────────────────────

/** Comment as returned by GET /rest/api/3/issue/{key}/comment */
export interface IssueComment {
  id: string;
  author: { accountId: string; displayName?: string };
  body: unknown; // ADF document
  created: string;
  updated: string;
}

/** Worklog entry */
export interface IssueWorklog {
  id: string;
  author: { accountId: string; displayName?: string };
  comment?: unknown; // ADF
  started: string;
  timeSpentSeconds: number;
}

/** Watcher summary */
export interface IssueWatchers {
  watchCount: number;
  isWatching: boolean;
  watchers: Array<{ accountId: string; displayName?: string }>;
}

/** Attachment metadata from fields.attachment */
export interface AttachmentRef {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  content: string; // download URL
  created: string;
}

/**
 * Full capture payload written to the backup store for every issue.
 * Contains all eight data classes from PRD Goal 3.
 */
export interface IssueCapturePayload {
  /** Issue identity */
  backupPointId: string;
  capturedAt: string; // ISO 8601
  /** System fields + all customfield_* keys from fields map */
  id: string;
  key: string;
  self: string;
  fields: Record<string, unknown>;
  /**
   * customFieldValues: subset of fields containing all customfield_* entries.
   * Preserved separately to make the coverage invariant machine-checkable.
   */
  customFieldValues: Record<string, unknown>;
  /** ADF comment bodies + author + timestamps */
  comments: IssueComment[];
  /** Sprint membership from customfield_10020 or sprint field */
  sprintMembership: unknown;
  /** Watchers list */
  watchers: IssueWatchers | null;
  /** Worklog entries */
  worklogs: IssueWorklog[];
  /** Attachment references (bytes downloaded separately) */
  attachmentRefs: AttachmentRef[];
}

// ── Orchestrator config ────────────────────────────────────────────────────────

export interface IssueCaptureConfig {
  backupPointId: string;
  cloudId: string;
  /** In-scope project keys to capture issues for */
  projectKeys: string[];
  /** Directory to write issue JSON payloads and attachment binaries */
  backupDir: string;
  /** JQL template: receives {projectKey}. Default: 'project = {projectKey} ORDER BY created ASC' */
  jqlTemplate?: (projectKey: string) => string;
  maxResults?: number;
  onProgress?: (event: IssueProgressEvent) => void;
  heartbeatIntervalMs?: number;
  /** Injected time source for testing */
  nowMs?: () => number;
  /**
   * Optional HeartbeatEmitter — when provided the orchestrator delegates
   * per-item ticks and job lifecycle to it (persistence + event bus).
   */
  heartbeatEmitter?: HeartbeatEmitter;
  /**
   * Optional JobStore — when provided per-item errors are persisted to
   * job_errors and job status is updated at completion.
   */
  jobStore?: JobStore;
  /**
   * jobId for the JobStore / HeartbeatEmitter; defaults to backupPointId.
   */
  jobId?: string;
}

// ── Run result ─────────────────────────────────────────────────────────────────

export interface IssueCaptureRunResult {
  backupPointId: string;
  totalIssuesCaptured: number;
  totalErrors: number;
  /** 'Completed successfully' or 'Completed with N errors' */
  jobStatus: string;
  /** ISO 8601 timestamp */
  completedAt: string;
}

// ── Orchestrator ───────────────────────────────────────────────────────────────

export class IssueCaptureOrchestrator {
  private readonly heartbeatMs: number;
  private lastHeartbeatAt: number;
  private totalCaptured = 0;
  private totalErrors = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly blobStore: AttachmentBlobStore;

  constructor(
    private readonly client: JiraHttpClient,
    private readonly writer: BackupPointManifestWriter,
    private readonly config: IssueCaptureConfig,
  ) {
    this.heartbeatMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.lastHeartbeatAt = (config.nowMs ?? Date.now)();
    this.blobStore = new AttachmentBlobStore(config.backupDir);
  }

  /**
   * Runs the full issue capture pipeline across all configured projects.
   * Never throws — per-item failures are recorded and the run continues.
   */
  async run(): Promise<IssueCaptureRunResult> {
    // Ensure backup directory exists
    fs.mkdirSync(path.join(this.config.backupDir, this.config.backupPointId, 'issues'), {
      recursive: true,
    });

    const emitter = this.config.heartbeatEmitter;
    if (emitter) {
      emitter.start();
    } else {
      this.startHeartbeat();
    }

    try {
      for (const projectKey of this.config.projectKeys) {
        await this.captureProject(projectKey);
      }
    } finally {
      if (!emitter) {
        this.stopHeartbeat();
      }
    }

    const jobStatus =
      this.totalErrors === 0
        ? 'Completed successfully'
        : `Completed with ${this.totalErrors} errors`;

    const completedAt = new Date().toISOString();

    console.log(
      `[jira-issue-capture] job_complete backupPointId=${this.config.backupPointId} ` +
        `total=${this.totalCaptured} errors=${this.totalErrors} status="${jobStatus}"`,
    );

    this.emitProgress({
      type: 'job_complete',
      timestamp: completedAt,
      totalIssuesCaptured: this.totalCaptured,
      totalErrors: this.totalErrors,
      message: jobStatus,
    });

    // Delegate completion to the emitter when present; it persists final status.
    if (emitter) {
      emitter.complete();
    } else if (this.config.jobStore && this.config.jobId) {
      // No emitter wired in — persist final status directly to the job store.
      this.config.jobStore.completeJob(
        this.config.jobId,
        this.totalCaptured,
        this.totalErrors,
      );
    }

    return {
      backupPointId: this.config.backupPointId,
      totalIssuesCaptured: this.totalCaptured,
      totalErrors: this.totalErrors,
      jobStatus,
      completedAt,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async captureProject(projectKey: string): Promise<void> {
    const jql = this.config.jqlTemplate
      ? this.config.jqlTemplate(projectKey)
      : `project = ${projectKey} ORDER BY created ASC`;

    this.emitProgress({
      type: 'project_start',
      projectKey,
      timestamp: new Date().toISOString(),
      totalIssuesCaptured: this.totalCaptured,
      totalErrors: this.totalErrors,
    });

    console.log(
      `[jira-issue-capture] project_start project=${projectKey} jql="${jql}"`,
    );

    const result = await this.client.paginateIssues(
      jql,
      ['*all', 'comment', 'attachment', 'worklog', 'watches'],
      this.config.maxResults ?? 50,
    );

    for (const issue of result.items) {
      await this.captureIssue(issue);
      this.maybeHeartbeat();
    }

    this.emitProgress({
      type: 'project_complete',
      projectKey,
      timestamp: new Date().toISOString(),
      totalIssuesCaptured: this.totalCaptured,
      totalErrors: this.totalErrors,
    });

    console.log(
      `[jira-issue-capture] project_complete project=${projectKey} ` +
        `issues=${result.totalFetched} pages=${result.pagesFetched}`,
    );
  }

  private async captureIssue(issue: JiraIssue): Promise<void> {
    const capturedAt = new Date().toISOString();
    const sourceEndpoint = `/rest/api/3/search/jql`;

    try {
      // Extract customFieldValues: all keys starting with 'customfield_'
      const customFieldValues: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(issue.fields)) {
        if (k.startsWith('customfield_')) {
          customFieldValues[k] = v;
        }
      }

      // Sprint membership: customfield_10020 is the canonical sprint field
      const sprintMembership = issue.fields['customfield_10020'] ?? null;

      // Attachment refs from issue fields
      const attachmentRefs = this.extractAttachmentRefs(issue);

      // Fetch supplemental data in parallel
      const [comments, watchers, worklogs] = await Promise.all([
        this.fetchComments(issue.key),
        this.fetchWatchers(issue.key),
        this.fetchWorklogs(issue.key),
      ]);

      const payload: IssueCapturePayload = {
        backupPointId: this.config.backupPointId,
        capturedAt,
        id: issue.id,
        key: issue.key,
        self: issue.self,
        fields: issue.fields,
        customFieldValues,
        comments,
        sprintMembership,
        watchers,
        worklogs,
        attachmentRefs,
      };

      // Persist issue JSON to backup store
      this.writeIssuePayload(payload);

      // Record ok entry in manifest
      this.writer.appendEntry({
        objectType: 'JiraIssue' as JiraObjectType,
        objectId: issue.key,
        capturedAt: Date.now(),
        sourceEndpoint,
        status: 'ok',
      });

      this.totalCaptured++;

      // Tick the external emitter (if wired in) for the captured issue
      this.config.heartbeatEmitter?.tick({ currentItemKey: issue.key });

      // Download attachments after issue is persisted (post-issue-creation pass)
      for (const att of attachmentRefs) {
        await this.downloadAttachment(att, issue.key);
        this.maybeHeartbeat();
        this.config.heartbeatEmitter?.tick({ currentItemKey: `${issue.key}:att:${att.id}` });
      }
      this.emitProgress({
        type: 'issue_captured',
        issueKey: issue.key,
        timestamp: capturedAt,
        totalIssuesCaptured: this.totalCaptured,
        totalErrors: this.totalErrors,
      });

      console.log(
        `[jira-issue-capture] issue_captured key=${issue.key} ` +
          `customFields=${Object.keys(customFieldValues).length} ` +
          `comments=${comments.length} worklogs=${worklogs.length} ` +
          `attachments=${attachmentRefs.length}`,
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.totalErrors++;

      // Per-item failure: record error entry, continue run
      this.writer.appendEntry({
        objectType: 'JiraIssue' as JiraObjectType,
        objectId: issue.key,
        capturedAt: Date.now(),
        sourceEndpoint,
        status: 'error',
        errorMessage,
      });

      // Persist to job_errors store when wired in
      if (this.config.jobStore && this.config.jobId) {
        this.config.jobStore.insertJobError({
          jobId: this.config.jobId,
          backupPointId: this.config.backupPointId,
          itemType: 'JiraIssue',
          itemId: issue.key,
          errorCode: 'API_ERROR',
          errorMessage,
          timestamp: capturedAt,
        });
      }

      // Tick the external emitter for the failed item
      this.config.heartbeatEmitter?.tick({ failed: true, currentItemKey: issue.key });

      this.emitProgress({
        type: 'issue_error',
        issueKey: issue.key,
        timestamp: capturedAt,
        totalIssuesCaptured: this.totalCaptured,
        totalErrors: this.totalErrors,
        message: errorMessage,
      });

      console.error(
        `[jira-issue-capture] issue_error key=${issue.key} error="${errorMessage}"`,
      );
    }
  }

  // ── Supplemental data fetchers ────────────────────────────────────────────

  private async fetchComments(issueKey: string): Promise<IssueComment[]> {
    // Always fetch separately to guarantee ADF body + complete author info.
    // Errors propagate to captureIssue's per-item try/catch.
    const result = (await this.client.get(
      `/rest/api/3/issue/${issueKey}/comment?expand=renderedBody&maxResults=1000`,
    )) as { comments: IssueComment[]; total: number };
    return result.comments ?? [];
  }

  private async fetchWatchers(issueKey: string): Promise<IssueWatchers | null> {
    // Errors propagate to captureIssue's per-item try/catch.
    return (await this.client.get(
      `/rest/api/3/issue/${issueKey}/watchers`,
    )) as IssueWatchers;
  }

  private async fetchWorklogs(issueKey: string): Promise<IssueWorklog[]> {
    // Errors propagate to captureIssue's per-item try/catch.
    const result = (await this.client.get(
      `/rest/api/3/issue/${issueKey}/worklog`,
    )) as { worklogs: IssueWorklog[] };
    return result.worklogs ?? [];
  }

  private extractAttachmentRefs(issue: JiraIssue): AttachmentRef[] {
    const attachments = issue.fields['attachment'];
    if (!Array.isArray(attachments)) return [];
    return attachments as AttachmentRef[];
  }

  // ── Attachment download ────────────────────────────────────────────────────

  /**
   * Downloads one attachment and writes it to the blob store.
   * Filename and MIME type are taken from the issue's attachment metadata
   * (not from Content-Disposition headers).
   * Per-attachment failures are recorded independently and do not abort the run.
   */
  private async downloadAttachment(
    att: AttachmentRef,
    issueKey: string,
  ): Promise<void> {
    const sourceEndpoint = `/rest/api/3/attachment/content/${att.id}`;
    try {
      const data = await this.client.downloadAttachment(att.id);
      this.blobStore.save(
        this.config.backupPointId,
        att.id,
        issueKey,
        att.filename,   // original filename from issue metadata
        att.mimeType,   // original MIME type from issue metadata
        data,
      );

      this.writer.appendEntry({
        objectType: 'JiraIssue' as JiraObjectType, // attachment is child of issue
        objectId: `${issueKey}:att:${att.id}`,
        capturedAt: Date.now(),
        sourceEndpoint,
        status: 'ok',
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const capturedAt = new Date().toISOString();

      this.totalErrors++;

      this.writer.appendEntry({
        objectType: 'JiraIssue' as JiraObjectType,
        objectId: `${issueKey}:att:${att.id}`,
        capturedAt: Date.now(),
        sourceEndpoint,
        status: 'error',
        errorMessage,
      });

      // Persist to job_errors store when wired in
      if (this.config.jobStore && this.config.jobId) {
        this.config.jobStore.insertJobError({
          jobId: this.config.jobId,
          backupPointId: this.config.backupPointId,
          itemType: 'JiraAttachment',
          itemId: `${issueKey}:att:${att.id}`,
          errorCode: 'ATTACHMENT_ERROR',
          errorMessage,
          timestamp: capturedAt,
        });
      }

      // Tick the external emitter for the failed attachment
      this.config.heartbeatEmitter?.tick({ failed: true, currentItemKey: `${issueKey}:att:${att.id}` });

      console.error(
        `[jira-issue-capture] attachment_error attachmentId=${att.id} ` +
          `issueKey=${issueKey} error="${errorMessage}"`,
      );
    }
  }

  // ── Backup store ──────────────────────────────────────────────────────────

  private writeIssuePayload(payload: IssueCapturePayload): void {
    const dir = path.join(
      this.config.backupDir,
      this.config.backupPointId,
      'issues',
    );
    const filePath = path.join(dir, `${payload.key}.json`);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.emitProgress({
        type: 'heartbeat',
        timestamp: new Date().toISOString(),
        totalIssuesCaptured: this.totalCaptured,
        totalErrors: this.totalErrors,
      });
      this.lastHeartbeatAt = (this.config.nowMs ?? Date.now)();
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private maybeHeartbeat(): void {
    const now = (this.config.nowMs ?? Date.now)();
    if (now - this.lastHeartbeatAt >= this.heartbeatMs) {
      this.emitProgress({
        type: 'heartbeat',
        timestamp: new Date().toISOString(),
        totalIssuesCaptured: this.totalCaptured,
        totalErrors: this.totalErrors,
      });
      this.lastHeartbeatAt = now;
    }
  }

  private emitProgress(event: IssueProgressEvent): void {
    if (this.config.onProgress) {
      this.config.onProgress(event);
    }
  }
}
