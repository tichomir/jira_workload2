/**
 * RestoreWizard — six-step restore flow.
 *
 * Steps:
 *   1. Source      — select backup point
 *   2. Scope       — all / projects / issues
 *   3. Destination — Original / Alternate / Browser Download
 *   4. Conflict    — Override / Skip (default) / Ask per conflict
 *   5. Review      — summary + trash-window warning + ADF warning
 *   6. Execute     — job progress view (polling + SSE-style heartbeat detection)
 *
 * NOTE: Full Figma spec for the restore-unit card is a carry-forward design item
 * (OC-001). This component is built conservatively against the acceptance criteria
 * in restore-architecture.md. Any visual design decisions here are provisional and
 * should be revisited when the Figma frame is delivered.
 *
 * Design carry-forward: Jira-specific Figma spec for restore-unit is pending.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  createRestoreJob,
  fetchRestoreJob,
  resolveConflict,
  RestoreApiError,
} from '../api/jira';
import type {
  ConflictMode,
  PhaseProgress,
  RestoreDestination,
  RestoreJob,
  RestorePhase,
  RestoreScope,
} from '../api/jira';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BackupPointOption {
  backupPointId: string;
  timestamp: string;
  issueCount: number;
  projectCount: number;
}

export interface RestoreWizardProps {
  /** Available backup points; consumer fetches and passes these in. */
  backupPoints: BackupPointOption[];
  /** Cloud ID of the connected Jira site (used for project picker placeholder). */
  cloudId: string;
  /** Called when the wizard is dismissed or the job completes. */
  onClose?: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STALL_THRESHOLD_MS = 20_000;
const POLL_INTERVAL_MS = 5_000;

const PHASE_LABELS: Record<RestorePhase, string> = {
  project:      'Projects',
  workflow:     'Workflows & Schemes',
  custom_field: 'Custom Fields & Configurations',
  board:        'Boards',
  sprint:       'Sprints',
  issue_body:   'Issues',
  post_issue:   'Links, Comments & Attachments',
};

const PHASE_ORDER: RestorePhase[] = [
  'project', 'workflow', 'custom_field', 'board', 'sprint', 'issue_body', 'post_issue',
];

// ── Wizard state ──────────────────────────────────────────────────────────────

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

interface WizardState {
  step: WizardStep;
  // Step 1
  selectedBackupPointId: string;
  // Step 2
  scope: RestoreScope;
  // Step 3
  destination: RestoreDestination;
  trashWindowBlocked: boolean;    // pre-detected at review time via API 409
  // Step 4
  conflictMode: ConflictMode;
}

// ── Small shared UI primitives ────────────────────────────────────────────────

function StepHeader({ step, title }: { step: number; title: string }) {
  return (
    <div className="mb-6">
      <span className="text-xs font-semibold uppercase tracking-wide text-blue-600">
        Step {step} of 6
      </span>
      <h2 className="mt-1 text-lg font-semibold text-gray-900">{title}</h2>
    </div>
  );
}

function NavButtons({
  onBack,
  onNext,
  nextLabel = 'Next',
  nextDisabled = false,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <div className="mt-8 flex justify-between">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Back
        </button>
      ) : (
        <span />
      )}
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        className="rounded bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {nextLabel}
      </button>
    </div>
  );
}

function InlineBanner({ variant, children }: { variant: 'warning' | 'error' | 'info'; children: React.ReactNode }) {
  const styles = {
    warning: 'bg-yellow-50 border-yellow-300 text-yellow-800',
    error:   'bg-red-50 border-red-300 text-red-800',
    info:    'bg-blue-50 border-blue-300 text-blue-800',
  }[variant];
  return (
    <div className={`rounded border px-4 py-3 text-sm ${styles}`} role="alert">
      {children}
    </div>
  );
}

// ── Step 1: Source ────────────────────────────────────────────────────────────

function StepSource({
  backupPoints,
  selectedId,
  onChange,
  onNext,
}: {
  backupPoints: BackupPointOption[];
  selectedId: string;
  onChange: (id: string) => void;
  onNext: () => void;
}) {
  return (
    <div>
      <StepHeader step={1} title="Select Backup Point" />
      {backupPoints.length === 0 ? (
        <p className="text-sm text-gray-500">No backup points available.</p>
      ) : (
        <ul className="space-y-2" role="radiogroup" aria-label="Backup point selection">
          {backupPoints.map((bp) => (
            <li key={bp.backupPointId}>
              <label className={`flex cursor-pointer items-start gap-3 rounded border p-3 ${selectedId === bp.backupPointId ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>
                <input
                  type="radio"
                  name="backupPoint"
                  value={bp.backupPointId}
                  checked={selectedId === bp.backupPointId}
                  onChange={() => onChange(bp.backupPointId)}
                  className="mt-0.5"
                />
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {new Date(bp.timestamp).toLocaleString()}
                  </p>
                  <p className="text-xs text-gray-500">
                    {bp.projectCount} projects · {bp.issueCount} issues
                  </p>
                  <p className="text-xs text-gray-400">{bp.backupPointId}</p>
                </div>
              </label>
            </li>
          ))}
        </ul>
      )}
      <NavButtons onNext={onNext} nextDisabled={!selectedId} />
    </div>
  );
}

// ── Step 2: Scope ─────────────────────────────────────────────────────────────

function StepScope({
  scope,
  onChange,
  onBack,
  onNext,
}: {
  scope: RestoreScope;
  onChange: (s: RestoreScope) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [rawKeys, setRawKeys] = useState(
    scope.type === 'projects' ? scope.projectKeys.join(', ') :
    scope.type === 'issues'   ? scope.issueKeys.join(', ') : '',
  );

  const handleTypeChange = (type: RestoreScope['type']) => {
    if (type === 'all') onChange({ type: 'all' });
    else if (type === 'projects') onChange({ type: 'projects', projectKeys: [] });
    else onChange({ type: 'issues', issueKeys: [] });
    setRawKeys('');
  };

  const handleKeysBlur = () => {
    const keys = rawKeys.split(/[\s,]+/).map(k => k.trim()).filter(Boolean);
    if (scope.type === 'projects') onChange({ type: 'projects', projectKeys: keys });
    if (scope.type === 'issues')   onChange({ type: 'issues',   issueKeys: keys });
  };

  const isValid =
    scope.type === 'all' ||
    (scope.type === 'projects' && scope.projectKeys.length > 0) ||
    (scope.type === 'issues'   && scope.issueKeys.length > 0);

  return (
    <div>
      <StepHeader step={2} title="Select Restore Scope" />
      <div className="space-y-3">
        {(['all', 'projects', 'issues'] as const).map((type) => (
          <label key={type} className="flex cursor-pointer items-start gap-3">
            <input
              type="radio"
              name="scope"
              value={type}
              checked={scope.type === type}
              onChange={() => handleTypeChange(type)}
              className="mt-0.5"
            />
            <span className="text-sm text-gray-800">
              {type === 'all'      && 'All items in backup point'}
              {type === 'projects' && 'Selected projects (by project key)'}
              {type === 'issues'   && 'Individual issues (by issue key)'}
            </span>
          </label>
        ))}
      </div>

      {(scope.type === 'projects' || scope.type === 'issues') && (
        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-gray-700">
            {scope.type === 'projects' ? 'Project keys (comma or space separated, e.g. PROJ, OPS)' : 'Issue keys (e.g. PROJ-1, PROJ-42)'}
          </label>
          <textarea
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            rows={2}
            value={rawKeys}
            onChange={(e) => setRawKeys(e.target.value)}
            onBlur={handleKeysBlur}
            placeholder={scope.type === 'projects' ? 'PROJ, OPS' : 'PROJ-1, PROJ-42'}
          />
        </div>
      )}

      <NavButtons onBack={onBack} onNext={onNext} nextDisabled={!isValid} />
    </div>
  );
}

// ── Step 3: Destination ───────────────────────────────────────────────────────

function StepDestination({
  destination,
  trashWindowBlocked,
  onChange,
  onBack,
  onNext,
}: {
  destination: RestoreDestination;
  trashWindowBlocked: boolean;
  onChange: (d: RestoreDestination) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [altKey, setAltKey] = useState(
    destination.type === 'alternate' ? destination.targetProjectKey : '',
  );

  const handleTypeChange = (type: RestoreDestination['type']) => {
    if (type === 'original') onChange({ type: 'original' });
    else if (type === 'alternate') onChange({ type: 'alternate', targetProjectKey: altKey });
    else onChange({ type: 'export' });
  };

  const handleAltKeyBlur = () => {
    if (destination.type === 'alternate') {
      onChange({ type: 'alternate', targetProjectKey: altKey.trim() });
    }
  };

  const isValid =
    (destination.type === 'original' && !trashWindowBlocked) ||
    destination.type === 'export' ||
    (destination.type === 'alternate' && destination.targetProjectKey.trim() !== '');

  return (
    <div>
      <StepHeader step={3} title="Choose Destination" />

      {trashWindowBlocked && (
        <div className="mb-4" data-testid="trash-window-banner">
          <InlineBanner variant="error">
            <strong>Original location unavailable.</strong> One or more projects in this restore scope are currently in Atlassian&apos;s 60-day trash window and cannot be restored in place. Use <em>Alternate location</em> to restore into a new or existing project, or wait for a Site Admin to restore the project from the Atlassian admin trash.
          </InlineBanner>
        </div>
      )}

      <div className="space-y-3">
        <label className={`flex cursor-pointer items-start gap-3 ${trashWindowBlocked ? 'opacity-40 cursor-not-allowed' : ''}`}>
          <input
            type="radio"
            name="destination"
            value="original"
            checked={destination.type === 'original'}
            onChange={() => handleTypeChange('original')}
            disabled={trashWindowBlocked}
            className="mt-0.5"
            data-testid="dest-original"
          />
          <div>
            <span className="text-sm font-medium text-gray-800">Original location</span>
            <p className="text-xs text-gray-500">Restore to the same project key on this Jira site.</p>
          </div>
        </label>

        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="radio"
            name="destination"
            value="alternate"
            checked={destination.type === 'alternate'}
            onChange={() => handleTypeChange('alternate')}
            className="mt-0.5"
            data-testid="dest-alternate"
          />
          <div className="flex-1">
            <span className="text-sm font-medium text-gray-800">Alternate location</span>
            <p className="text-xs text-gray-500">Restore into an existing project on the same Jira site.</p>
            {destination.type === 'alternate' && (
              <input
                type="text"
                className="mt-2 w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="Target project key (e.g. OPS)"
                value={altKey}
                onChange={(e) => setAltKey(e.target.value)}
                onBlur={handleAltKeyBlur}
                data-testid="alt-project-key"
              />
            )}
          </div>
        </label>

        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="radio"
            name="destination"
            value="export"
            checked={destination.type === 'export'}
            onChange={() => handleTypeChange('export')}
            className="mt-0.5"
            data-testid="dest-export"
          />
          <div>
            <span className="text-sm font-medium text-gray-800">Browser Download (export)</span>
            <p className="text-xs text-gray-500">Download a .zip archive — no writes to Jira. S3/Azure/GCS export is Phase 2.</p>
          </div>
        </label>
      </div>

      <NavButtons onBack={onBack} onNext={onNext} nextDisabled={!isValid} />
    </div>
  );
}

// ── Step 4: Conflict Mode ─────────────────────────────────────────────────────

const CONFLICT_OPTIONS: { value: ConflictMode; label: string; help: string }[] = [
  {
    value: 'skip',
    label: 'Skip (default)',
    help: 'Leave existing objects untouched. Only missing objects are restored.',
  },
  {
    value: 'override',
    label: 'Override',
    help: 'Overwrite existing objects with backup data. Use with caution — current data will be replaced.',
  },
  {
    value: 'ask',
    label: 'Ask per conflict',
    help: 'Pause the job when a conflict is detected and prompt you to decide individually.',
  },
];

function StepConflictMode({
  mode,
  onChange,
  onBack,
  onNext,
}: {
  mode: ConflictMode;
  onChange: (m: ConflictMode) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div>
      <StepHeader step={4} title="Conflict Resolution Mode" />
      <div className="space-y-3">
        {CONFLICT_OPTIONS.map(({ value, label, help }) => (
          <label
            key={value}
            className={`flex cursor-pointer items-start gap-3 rounded border p-3 ${mode === value ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
            data-testid={`conflict-${value}`}
          >
            <input
              type="radio"
              name="conflictMode"
              value={value}
              checked={mode === value}
              onChange={() => onChange(value)}
              className="mt-0.5"
            />
            <div>
              <p className="text-sm font-medium text-gray-900">{label}</p>
              <p className="mt-0.5 text-xs text-gray-500">{help}</p>
            </div>
          </label>
        ))}
      </div>
      <NavButtons onBack={onBack} onNext={onNext} />
    </div>
  );
}

// ── Step 5: Review ────────────────────────────────────────────────────────────

function scopeLabel(scope: RestoreScope): string {
  if (scope.type === 'all') return 'All items';
  if (scope.type === 'projects') return `Projects: ${scope.projectKeys.join(', ')}`;
  return `Issues: ${scope.issueKeys.join(', ')}`;
}

function destinationLabel(dest: RestoreDestination): string {
  if (dest.type === 'original') return 'Original location';
  if (dest.type === 'alternate') return `Alternate location — ${dest.targetProjectKey}`;
  return 'Browser Download (export)';
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 py-2 text-sm border-b border-gray-100 last:border-0">
      <span className="w-40 shrink-0 font-medium text-gray-600">{label}</span>
      <span className="text-gray-900 break-all">{value}</span>
    </div>
  );
}

function StepReview({
  state,
  backupPoints,
  onBack,
  onStart,
  starting,
  startError,
  onGoToDestination,
}: {
  state: WizardState;
  backupPoints: BackupPointOption[];
  onBack: () => void;
  onStart: () => void;
  starting: boolean;
  startError: string | null;
  onGoToDestination: () => void;
}) {
  const bp = backupPoints.find(b => b.backupPointId === state.selectedBackupPointId);
  const hasAttachments = state.scope.type !== 'issues'; // conservative: warn unless issue-only scope

  return (
    <div>
      <StepHeader step={5} title="Review & Start" />

      <div className="rounded border border-gray-200 bg-white p-4">
        <ReviewRow label="Backup point" value={bp ? `${new Date(bp.timestamp).toLocaleString()} (${bp.backupPointId})` : state.selectedBackupPointId} />
        <ReviewRow label="Scope" value={scopeLabel(state.scope)} />
        <ReviewRow label="Destination" value={destinationLabel(state.destination)} />
        <ReviewRow label="Conflict mode" value={CONFLICT_OPTIONS.find(o => o.value === state.conflictMode)?.label ?? state.conflictMode} />
      </div>

      <div className="mt-4 space-y-3">
        {state.trashWindowBlocked && (
          <div data-testid="review-trash-banner">
            <InlineBanner variant="error">
              <strong>Trash window block detected.</strong> One or more projects are in Atlassian&apos;s 60-day trash window; original location restore is unavailable.{' '}
              <button
                type="button"
                onClick={onGoToDestination}
                data-testid="trash-go-to-destination"
                className="underline font-semibold hover:no-underline"
              >
                Choose Alternate location or Browser Download
              </button>
              .
            </InlineBanner>
          </div>
        )}

        {hasAttachments && (
          <InlineBanner variant="warning">
            <strong>Note:</strong> Restored attachments receive new attachment IDs. ADF media node references in issue descriptions and comments may break. A best-effort warning will appear in the restore report. Full ADF media link rewriting is deferred to Phase 2.
          </InlineBanner>
        )}

        {startError && (
          <InlineBanner variant="error">
            {startError}
          </InlineBanner>
        )}
      </div>

      <NavButtons
        onBack={onBack}
        onNext={onStart}
        nextLabel={starting ? 'Starting…' : 'Start Restore'}
        nextDisabled={starting || state.trashWindowBlocked}
      />
    </div>
  );
}

// ── Restore Completion Report ─────────────────────────────────────────────────

function RestoreCompletionReport({
  job,
  destination,
}: {
  job: RestoreJob;
  destination: RestoreDestination;
}) {
  const [adfExpanded, setAdfExpanded] = React.useState(true);
  const hasWarnings = job.adfMediaWarnings.length > 0;
  const isExportComplete = destination.type === 'export' && job.status === 'completed';

  const exportCsv = () => {
    const header = 'Issue Key\n';
    const rows = job.adfMediaWarnings.join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `adf-media-warnings-${job.jobId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mt-6 space-y-4" data-testid="restore-completion-report">
      {/* ADF media warnings panel */}
      {hasWarnings && (
        <div
          className="rounded border border-yellow-300 bg-yellow-50"
          data-testid="adf-media-warning-panel"
        >
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-yellow-800 hover:bg-yellow-100"
            onClick={() => setAdfExpanded((e) => !e)}
            aria-expanded={adfExpanded}
            data-testid="adf-warning-toggle"
          >
            <span>
              ADF media references may be broken ({job.adfMediaWarnings.length} issue
              {job.adfMediaWarnings.length !== 1 ? 's' : ''} affected)
            </span>
            <span aria-hidden="true">{adfExpanded ? '▲' : '▼'}</span>
          </button>

          {adfExpanded && (
            <div className="border-t border-yellow-200 px-4 py-3 text-sm text-yellow-800">
              <p className="mb-2">
                Restored attachments receive new attachment IDs. ADF media node references
                in the descriptions and comments of the following issues may point to
                pre-restore attachment IDs and no longer render correctly. Operators may
                need to re-attach files manually.{' '}
                <strong>Full ADF media link rewriting is deferred to Phase 2.</strong>
              </p>
              <ul
                className="mb-3 max-h-40 overflow-y-auto space-y-0.5 rounded border border-yellow-200 bg-white p-2 font-mono text-xs"
                data-testid="adf-warning-issue-list"
              >
                {job.adfMediaWarnings.map((issueKey) => (
                  <li key={issueKey}>{issueKey}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={exportCsv}
                data-testid="adf-warning-csv-export"
                className="rounded border border-yellow-400 bg-white px-3 py-1.5 text-xs font-medium text-yellow-800 hover:bg-yellow-50"
              >
                Export warning list as CSV
              </button>
            </div>
          )}
        </div>
      )}

      {/* Browser Download CTA */}
      {isExportComplete && (
        <div
          className="rounded border border-blue-300 bg-blue-50 px-4 py-3"
          data-testid="download-archive-section"
        >
          <p className="mb-2 text-sm font-medium text-blue-800">
            Your restore archive is ready.
          </p>
          <a
            href={`/restore/jobs/${encodeURIComponent(job.jobId)}/download`}
            data-testid="download-archive-cta"
            className="inline-block rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Download archive
          </a>
        </div>
      )}
    </div>
  );
}

// ── Step 6: Execute / Progress ────────────────────────────────────────────────

function PhaseRow({ progress, isCurrent }: { progress: PhaseProgress; isCurrent: boolean }) {
  const pct = progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0;

  const icon =
    progress.status === 'completed' || progress.status === 'completed_with_errors'
      ? (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-500 text-white text-xs font-bold" aria-label="completed">
          ✓
        </span>
      )
      : progress.status === 'failed'
      ? (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500 text-white text-xs font-bold" aria-label="failed">
          ✗
        </span>
      )
      : progress.status === 'running'
      ? (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500 text-white text-xs" aria-label="running">
          ●
        </span>
      )
      : (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-gray-300" aria-label="pending" />
      );

  return (
    <div
      className={`py-2 px-3 rounded ${isCurrent ? 'bg-blue-50' : ''}`}
      data-testid={`phase-row-${progress.phase}`}
    >
      <div className="flex items-center gap-3 text-sm">
        {icon}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className={`font-medium truncate ${progress.status === 'pending' ? 'text-gray-400' : 'text-gray-800'}`}>
              {PHASE_LABELS[progress.phase]}
            </span>
            <span className={`shrink-0 text-xs font-semibold ${
              progress.status === 'running'              ? 'text-blue-600' :
              progress.status === 'completed'            ? 'text-green-600' :
              progress.status === 'completed_with_errors'? 'text-yellow-600' :
              progress.status === 'failed'               ? 'text-red-600' :
                                                           'text-gray-400'
            }`}>
              {progress.status === 'running'
                ? (progress.total > 0 ? `${progress.processed}/${progress.total}` : 'running…')
                : progress.status !== 'pending'
                ? progress.status.replace(/_/g, ' ')
                : ''}
            </span>
          </div>
          {progress.status === 'running' && (
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-full rounded-full bg-blue-500 transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          {progress.errorCount > 0 && (
            <p className="mt-0.5 text-xs text-yellow-700">{progress.errorCount} error(s)</p>
          )}
        </div>
      </div>
    </div>
  );
}

interface ConflictPrompt {
  conflictId: string;
  objectType: string;
  objectKey: string;
  existingObjectSummary: string;
  incomingObjectSummary: string;
}

function StepExecute({
  jobId,
  destination,
  onClose,
}: {
  jobId: string;
  destination: RestoreDestination;
  onClose?: () => void;
}) {
  const [job, setJob] = useState<RestoreJob | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);
  const [decidingConflict, setDecidingConflict] = useState(false);
  const [adfDismissed, setAdfDismissed] = useState(false);

  const lastEventRef = useRef<number>(Date.now());
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevJobRef = useRef<RestoreJob | null>(null);

  const resetStalledTimer = useCallback(() => {
    lastEventRef.current = Date.now();
    setStalled(false);
    if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
    stallTimerRef.current = setTimeout(() => setStalled(true), STALL_THRESHOLD_MS);
  }, []);

  const doPoll = useCallback(async () => {
    try {
      const updated = await fetchRestoreJob(jobId);
      setPollError(null);
      resetStalledTimer();

      // Detect a new ConflictDecisionRequired by status transition
      if (
        updated.status === 'awaiting_decision' &&
        prevJobRef.current?.status !== 'awaiting_decision'
      ) {
        // The SSE event would carry conflict details; we surface a generic
        // prompt here since we're polling rather than subscribing to SSE.
        setConflict({
          conflictId: 'pending',
          objectType: 'object',
          objectKey: updated.currentPhase ?? '?',
          existingObjectSummary: 'Existing object',
          incomingObjectSummary: 'Incoming (backup) object',
        });
      }

      prevJobRef.current = updated;
      setJob(updated);

      const done = ['completed', 'completed_with_errors', 'failed'].includes(updated.status);
      if (done && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPollError(msg);
    }
  }, [jobId, resetStalledTimer]);

  useEffect(() => {
    resetStalledTimer();
    doPoll();
    pollRef.current = setInterval(doPoll, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
    };
  }, [doPoll, resetStalledTimer]);

  const handleDecision = async (decision: 'override' | 'skip') => {
    if (!conflict) return;
    setDecidingConflict(true);
    try {
      await resolveConflict(jobId, conflict.conflictId, decision);
      setConflict(null);
    } catch {
      // ignore — poll will surface updated state
    } finally {
      setDecidingConflict(false);
    }
  };

  const isTerminal = job && ['completed', 'completed_with_errors', 'failed'].includes(job.status);

  return (
    <div>
      <StepHeader step={6} title="Restore in Progress" />

      {stalled && !isTerminal && (
        <div className="mb-4" data-testid="stalled-banner">
          <InlineBanner variant="warning">
            No progress update received in the last 20 seconds. The job may be stalled.
          </InlineBanner>
        </div>
      )}

      {pollError && (
        <InlineBanner variant="error">{pollError}</InlineBanner>
      )}

      {!job && !pollError && (
        <p className="text-sm text-gray-500">Loading job status…</p>
      )}

      {job && (
        <div className="space-y-4">
          {/* Overall status */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700">Status:</span>
            <span
              data-testid="job-status"
              className={`rounded px-2 py-0.5 text-xs font-bold uppercase ${
                job.status === 'completed'              ? 'bg-green-100 text-green-700' :
                job.status === 'completed_with_errors'  ? 'bg-yellow-100 text-yellow-700' :
                job.status === 'failed'                 ? 'bg-red-100 text-red-700' :
                job.status === 'awaiting_decision'      ? 'bg-purple-100 text-purple-700' :
                                                          'bg-blue-100 text-blue-700'
              }`}
            >
              {job.status.replace(/_/g, ' ')}
            </span>
            {job.errorCount > 0 && (
              <span className="text-xs text-yellow-700">({job.errorCount} error{job.errorCount !== 1 ? 's' : ''})</span>
            )}
          </div>

          {/* ADF media warning — shown after post_issue phase, dismissible */}
          {job.adfMediaWarningEmitted && !adfDismissed && (
            <div data-testid="adf-warning-banner">
              <InlineBanner variant="warning">
                <div className="flex items-start justify-between gap-2">
                  <span>
                    Some ADF media links in restored issues may be broken — review affected issues.
                    {' '}Full ADF media link rewriting is deferred to Phase 2.
                  </span>
                  <button
                    type="button"
                    onClick={() => setAdfDismissed(true)}
                    data-testid="adf-warning-dismiss"
                    className="shrink-0 text-yellow-700 hover:text-yellow-900 font-bold text-lg leading-none"
                    aria-label="Dismiss ADF media warning"
                  >
                    ×
                  </button>
                </div>
              </InlineBanner>
            </div>
          )}

          {/* Phase-failure diagnostic */}
          {job.failureDiagnostic && (
            <div data-testid="phase-failure-banner">
              <InlineBanner variant="error">
                <p><strong>Restore failed:</strong> {job.failureDiagnostic}</p>
                <p className="mt-1 text-xs font-medium">Restore halted before next phase.</p>
              </InlineBanner>
            </div>
          )}

          {/* Ask-mode conflict prompt */}
          {conflict && job.status === 'awaiting_decision' && (
            <div className="rounded border border-purple-200 bg-purple-50 p-4" data-testid="conflict-prompt">
              <p className="text-sm font-semibold text-purple-800">Conflict detected — decide how to proceed</p>
              <p className="mt-1 text-xs text-purple-700">
                Object: <strong>{conflict.objectKey}</strong> ({conflict.objectType})
              </p>
              <p className="mt-0.5 text-xs text-purple-600">Existing: {conflict.existingObjectSummary}</p>
              <p className="text-xs text-purple-600">Incoming: {conflict.incomingObjectSummary}</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={decidingConflict}
                  onClick={() => handleDecision('override')}
                  className="rounded bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-40"
                >
                  Override
                </button>
                <button
                  type="button"
                  disabled={decidingConflict}
                  onClick={() => handleDecision('skip')}
                  className="rounded border border-purple-300 bg-white px-3 py-1.5 text-xs font-medium text-purple-700 hover:bg-purple-50 disabled:opacity-40"
                >
                  Skip
                </button>
              </div>
            </div>
          )}

          {/* Phase stepper — all 7 phases always visible */}
          <div
            className="rounded border border-gray-200 bg-white divide-y divide-gray-100"
            data-testid="phase-stepper"
          >
            {PHASE_ORDER.map(phase => {
              const found = job.phaseProgress.find(p => p.phase === phase);
              const progress: PhaseProgress = found ?? {
                phase,
                status: 'pending',
                total: 0,
                processed: 0,
                errorCount: 0,
                startedAt: null,
                completedAt: null,
              };
              return (
                <PhaseRow
                  key={phase}
                  progress={progress}
                  isCurrent={job.currentPhase === phase}
                />
              );
            })}
          </div>
        </div>
      )}

      {isTerminal && job && (
        <>
          <RestoreCompletionReport job={job} destination={destination} />
          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded bg-gray-800 px-5 py-2 text-sm font-medium text-white hover:bg-gray-900"
            >
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── RestoreWizard (root) ──────────────────────────────────────────────────────

/**
 * RestoreWizard
 *
 * DESIGN NOTE: This component is built without an authoritative Figma frame.
 * The Jira-specific Figma spec for the restore-unit is a carry-forward design item
 * (OC-001 in inventory-ui.md). All layout decisions are provisional and should be
 * revisited when the Figma frame is delivered. This is flagged as a carry-forward
 * in the PR description.
 */
export function RestoreWizard({ backupPoints, cloudId: _cloudId, onClose }: RestoreWizardProps) {
  const [state, setState] = useState<WizardState>({
    step: 1,
    selectedBackupPointId: backupPoints[0]?.backupPointId ?? '',
    scope: { type: 'all' },
    destination: { type: 'original' },
    trashWindowBlocked: false,
    conflictMode: 'skip', // Skip is the pre-selected default
  });

  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const goTo = (step: WizardStep) =>
    setState(prev => ({ ...prev, step }));

  // Step 6: create the job and transition
  const handleStart = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const job = await createRestoreJob({
        sourceBackupPointId: state.selectedBackupPointId,
        scope: state.scope,
        destination: state.destination,
        conflictMode: state.conflictMode,
      });
      setJobId(job.jobId);
      goTo(6);
    } catch (err) {
      if (err instanceof RestoreApiError && err.code === 'TRASH_WINDOW_BLOCK') {
        setState(prev => ({ ...prev, trashWindowBlocked: true }));
        setStartError(err.message);
      } else {
        setStartError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <div
      data-testid="restore-wizard"
      className="mx-auto max-w-2xl rounded-xl border border-gray-200 bg-gray-50 p-6 shadow-sm"
    >
      {/* Step indicator */}
      <div className="mb-6 flex gap-1" aria-hidden="true">
        {([1, 2, 3, 4, 5, 6] as WizardStep[]).map(s => (
          <div
            key={s}
            className={`h-1 flex-1 rounded-full transition-colors ${
              s < state.step  ? 'bg-blue-500' :
              s === state.step ? 'bg-blue-700' :
                                 'bg-gray-200'
            }`}
          />
        ))}
      </div>

      {state.step === 1 && (
        <StepSource
          backupPoints={backupPoints}
          selectedId={state.selectedBackupPointId}
          onChange={(id) => setState(prev => ({ ...prev, selectedBackupPointId: id }))}
          onNext={() => goTo(2)}
        />
      )}

      {state.step === 2 && (
        <StepScope
          scope={state.scope}
          onChange={(scope) => setState(prev => ({ ...prev, scope }))}
          onBack={() => goTo(1)}
          onNext={() => goTo(3)}
        />
      )}

      {state.step === 3 && (
        <StepDestination
          destination={state.destination}
          trashWindowBlocked={state.trashWindowBlocked}
          onChange={(destination) => setState(prev => ({ ...prev, destination }))}
          onBack={() => goTo(2)}
          onNext={() => goTo(4)}
        />
      )}

      {state.step === 4 && (
        <StepConflictMode
          mode={state.conflictMode}
          onChange={(conflictMode) => setState(prev => ({ ...prev, conflictMode }))}
          onBack={() => goTo(3)}
          onNext={() => goTo(5)}
        />
      )}

      {state.step === 5 && (
        <StepReview
          state={state}
          backupPoints={backupPoints}
          onBack={() => goTo(4)}
          onStart={handleStart}
          starting={starting}
          startError={startError}
          onGoToDestination={() => goTo(3)}
        />
      )}

      {state.step === 6 && jobId && (
        <StepExecute jobId={jobId} destination={state.destination} onClose={onClose} />
      )}
    </div>
  );
}
