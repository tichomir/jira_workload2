/**
 * Restore Engine & Wizard — shared type definitions.
 * Source: docs/restore-architecture.md §2.
 */

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

export type RestoreScope =
  | { type: 'all' }
  | { type: 'projects'; projectKeys: string[] }
  | { type: 'issues'; issueKeys: string[] };

export type RestoreDestination =
  | { type: 'original' }
  | { type: 'alternate'; targetProjectKey: string }
  | { type: 'export' };

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
  lastHeartbeatAt: number | null;
  stalled: boolean;
}

export interface RestoreConflict {
  id: string;
  jobId: string;
  objectType: string;
  objectKey: string;
  existingObjectSummary: string | null;
  incomingObjectSummary: string | null;
  decision: 'override' | 'skip' | null;
  createdAt: string;
  decidedAt: string | null;
}
