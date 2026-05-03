/**
 * Backup-point manifest types.
 * Defined per the context-node capture pipeline architecture (docs/architecture/context-capture-pipeline.md).
 */

export type CapturePhase =
  | 'issue_type'
  | 'custom_field'
  | 'field_configuration'
  | 'workflow'
  | 'workflow_scheme'
  | 'project'
  | 'board'
  | 'sprint'
  | 'issue';

export type JiraObjectType =
  | 'IssueType'
  | 'CustomField'
  | 'FieldConfiguration'
  | 'Workflow'
  | 'WorkflowScheme'
  | 'JiraProject'
  | 'JiraBoard'
  | 'JiraSprint'
  | 'JiraIssue';

export type SkipReason =
  | 'jsm_out_of_scope'  // service_desk project type — Phase 2
  | 'system_field'       // custom:false field — context endpoint not called
  | 'duplicate_id';      // defensive: API returned same ID in two pages

export type ManifestErrorCode =
  | 'API_ERROR'          // non-2xx response from Jira API
  | 'NETWORK_ERROR'      // connection timeout or DNS failure
  | 'PARSE_ERROR'        // unexpected response shape
  | 'RECONCILIATION_GAP' // fetched count < API-reported total
  | 'PHASE_HALTED'       // a prior phase error caused this phase to be skipped
  | 'AUTH_ERROR';        // 401/403 during capture

export interface ManifestError {
  httpStatus?: number;
  code: ManifestErrorCode;
  message: string;
  endpoint?: string;
  failedAt: string;
  halted: boolean;
}

/**
 * A single entry in the backup-point manifest.
 * Every API-returned object produces exactly one ManifestEntry.
 * Failures produce an error entry — never a silent omission.
 */
export interface ManifestEntry {
  id: string;
  key: string;
  phase: CapturePhase;
  objectType: JiraObjectType;
  capturedAt: string;
  status: 'success' | 'error' | 'skipped' | 'out_of_scope';
  error?: ManifestError;
  skipReason?: SkipReason;
  /** True for objects excluded from backup (e.g. JSM projects). Entry is always written (zero-silent-omission). */
  outOfScope?: boolean;
  /** Human-readable reason when outOfScope is true. */
  reason?: string;
  backupPointId: string;
  /** Phase-specific captured data payload */
  data?: unknown;
}

export interface PhaseSummary {
  phase: CapturePhase;
  totalFetched: number;
  successCount: number;
  errorCount: number;
  skippedCount: number;
  completed: boolean;
}

/**
 * Per-stage section written atomically to the manifest after each capture
 * phase completes. Used by the manifest writer to enforce the integrity
 * invariant: capturedCount + skippedIds.length === apiTotalReported.
 */
export interface ManifestStageSection {
  stageName: CapturePhase;
  /** Number of paginated API calls made for this stage */
  apiPageCount: number;
  /** Total count reported by the API (null for flat-array endpoints) */
  apiTotalReported: number | null;
  /** Number of items successfully captured */
  capturedCount: number;
  /** IDs of objects that were skipped (e.g. system fields, JSM projects) */
  skippedIds: string[];
  /** Maps skipped ID → human-readable skip reason */
  skippedReasons: Record<string, string>;
}

export interface ReconciliationReport {
  objectType: JiraObjectType;
  apiReportedTotal: number | null;
  totalFetched: number;
  manifestEntryCount: number;
  reconciled: boolean;
  gap?: number;
}

/**
 * Top-level backup-point manifest.
 */
export interface BackupPointManifest {
  backupPointId: string;
  cloudId: string;
  siteUrl: string;
  /** ISO 8601 timestamp when the backup job was created/started */
  createdAt: string;
  startedAt: string;
  finalisedAt: string;
  /** Whether the discovery scope was all projects or a selected subset */
  scopeMode: 'all' | 'selected';
  status: 'in_progress' | 'completed' | 'completed_with_errors' | 'halted';
  phaseSummary: Record<CapturePhase, PhaseSummary>;
  /** Per-stage sections written atomically as each stage completes */
  stages: ManifestStageSection[];
  entries: ManifestEntry[];
  reconciliation: ReconciliationReport[];
}

/**
 * Returned by every paginated fetch helper.
 */
export interface PaginationResult<T> {
  items: T[];
  totalFetched: number;
  apiReportedTotal: number | null;
  pagesFetched: number;
  reconciled: boolean;
  gap?: number;
}

/**
 * A captured Project context node.
 */
export interface ProjectNode {
  id: string;
  key: string;
  name: string;
  projectTypeKey: 'software' | 'business' | 'service_desk' | string;
  archived: boolean;
  leadAccountId?: string;
  workflowSchemeId?: string;
  self: string;
  style?: 'next-gen' | 'classic';
}

/**
 * Emitted when one or more service_desk projects are detected.
 */
export interface JsmOutOfScopeNotice {
  type: 'jsm_out_of_scope';
  projectCount: number;
  projectKeys: string[];
  message: string;
  phase2Note: string;
}

export const JSM_NOTICE_MESSAGE =
  'Jira Service Management projects were detected on this site. ' +
  'JSM objects (JSMTicket, JSMQueue, JSMRequestType, JSMSLAM) are out of scope for Phase 1 backup. ' +
  'These projects are excluded from backup and restore.';

export const JSM_NOTICE_PHASE2 =
  'Full JSM backup support is planned for Phase 2. See T1 §1, T3 §3.2.';
