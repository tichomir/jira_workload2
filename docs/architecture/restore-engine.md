# Restore Engine — Phase Executor & Diagnostic Contract

_Sprint 12 — Software Architect deliverable_
_Phase: Restore Engine & Wizard — Sprint 2 of 3_
_Source of truth for backend implementation of the dependency-ordered restore engine._

---

## 1. Ordered Phase List

The restore engine executes phases in strict dependency order. No phase may begin until the preceding phase has reached a terminal state (`completed`, `completed_with_errors`). A `failed` terminal state halts the entire run — no subsequent phase executes.

| # | Phase token | Objects written | Jira API calls |
|---|---|---|---|
| 1 | `project` | Project metadata | `PUT /rest/api/3/project/{key}` |
| 2 | `workflow` | Workflow + WorkflowScheme | `POST /rest/api/3/workflow`, `POST /rest/api/3/workflowscheme` |
| 3 | `custom_field` | CustomField + FieldConfiguration | `POST /rest/api/3/field`, `POST /rest/api/3/fieldconfiguration` |
| 4 | `board` | Board metadata | `POST /rest/agile/1.0/board` |
| 5 | `sprint` | Sprint metadata | `POST /rest/agile/1.0/sprint` |
| 6 | `issue_body` | Issue body (system + custom fields, no links/comments) | `POST /rest/api/3/issue`, `PUT /rest/api/3/issue/{key}` |
| 7 | `post_issue` | Issue links + comments + attachments | `POST /rest/api/3/issueLink`, `POST /rest/api/3/issue/{key}/comment`, `POST /rest/api/3/issue/{key}/attachments` |

> **Why this order matters:** Project must exist before boards/sprints can reference it. Workflows must exist before projects can assign schemes. Custom fields must exist before issues can carry custom values. Boards and sprints must exist before issues can be assigned sprint membership. The post-issue pass must run after all issue keys are resolved to handle cross-issue link references.

---

## 2. PhaseResult Shape

Every phase executor returns a `PhaseResult` that the orchestrator records and surfaces to the UI.

```typescript
interface PhaseResult {
  phase: RestorePhase;           // 'project' | 'workflow' | 'custom_field' | 'board' | 'sprint' | 'issue_body' | 'post_issue'
  itemsAttempted: number;        // total objects passed to this phase
  itemsSucceeded: number;        // objects written without error
  itemsFailed: number;           // objects that produced a write error
  namedDiagnosticCode: string | null;  // set only on phase-level halt (see §3)
  message: string | null;        // human-readable explanation; null if phase succeeded
  startedAt: string;             // ISO 8601
  completedAt: string;           // ISO 8601
  fatal: boolean;                // true → halt; false → non-fatal (partial errors)
}
```

`namedDiagnosticCode` is only set when `fatal: true`. For per-item write failures that do not halt the phase, `itemsFailed` is incremented and the error is appended to the per-item error log, but `namedDiagnosticCode` remains `null`.

---

## 3. Halt-on-Phase-Failure Rule & Named Diagnostic Codes

### Rule

If a phase returns `fatal: true`, the engine:

1. Sets `RestoreJob.status = 'failed'`.
2. Sets `RestoreJob.failureDiagnostic = '<DIAGNOSTIC_CODE>: <message>'`.
3. Sets `RestoreJob.currentPhase = null`.
4. Emits a `phaseFailure` SSE event (see §4).
5. **Does not execute any subsequent phases.**
6. Marks the job terminal — no further progress events are emitted.

The named diagnostic is surfaced in the UI (Step 6 — Execute) as a red inline banner **before** the next phase row would have begun, so the operator can see exactly which phase halted the run and why.

### Named Diagnostic Codes

| Code | Phase | Trigger condition |
|---|---|---|
| `RESTORE_PHASE_PROJECT_FAILED` | `project` | Project write returned non-retryable error (403, 404, 409 other than trash-window) or >50% of project items failed |
| `RESTORE_PHASE_WORKFLOW_FAILED` | `workflow` | Workflow or WorkflowScheme creation failed for all items or returned a schema-mismatch error from Jira |
| `RESTORE_PHASE_CUSTOM_FIELD_FAILED` | `custom_field` | CustomField or FieldConfiguration creation failed for all items |
| `RESTORE_PHASE_BOARD_FAILED` | `board` | Board creation returned 403 (insufficient permission) or all board items failed |
| `RESTORE_PHASE_SPRINT_FAILED` | `sprint` | Sprint creation returned 403 or all sprint items failed |
| `RESTORE_PHASE_ISSUE_BODY_FAILED` | `issue_body` | Issue creation endpoint returned 429 (rate-limited, retries exhausted) or >80% of issues failed |
| `RESTORE_PHASE_POST_ISSUE_FAILED` | `post_issue` | All link, comment, and attachment writes failed (non-fatal variant exists — see below) |
| `TRASH_WINDOW_BLOCK` | `project` | Target project is in Atlassian's 60-day trash window; emitted before any writes occur |
| `RESTORE_SCOPE_EMPTY` | pre-phase | Scope resolution produced zero items; nothing to restore |
| `BACKUP_POINT_NOT_FOUND` | pre-phase | `sourceBackupPointId` does not exist in the manifest store |

> **Non-fatal `post_issue` variant:** Individual link/comment/attachment failures increment `itemsFailed` and are logged but do **not** set `fatal: true` unless *all* items fail. This preserves the completed issues even when post-issue pass is partially degraded.

### Diagnostic Message Format

```
<DIAGNOSTIC_CODE>: <phase>: <concise human-readable explanation>.
Context: <API response snippet or item count summary>.
Recovery: <operator-facing recovery action>.
```

Example:

```
RESTORE_PHASE_BOARD_FAILED: board: All 3 board creation requests returned HTTP 403.
Context: Jira response: {"errorMessages":["You do not have permission to create boards in this project."]}.
Recovery: Ensure the connected account holds 'Administer Projects' permission on the target site, then retry.
```

---

## 4. Heartbeat & Progress Event Schema

Progress events are emitted every **≤10 seconds** during active phase execution. A job with no event for **>20 seconds** triggers a stalled-job alert in the UI (handled by `StalledJobDetector`, reused from backup jobs).

### SSE Event Types

#### `progress` — per-phase item progress

```json
{
  "event": "progress",
  "data": {
    "jobId": "restore-abc-123",
    "phase": "issue_body",
    "itemsDone": 67,
    "itemsTotal": 142,
    "errorCount": 1,
    "ts": "2026-05-03T10:15:22Z"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `jobId` | string | Restore job UUID |
| `phase` | `RestorePhase` | Current executing phase token |
| `itemsDone` | number | Items attempted so far in this phase |
| `itemsTotal` | number | Total items expected in this phase (from manifest) |
| `errorCount` | number | Cumulative per-item errors across all phases |
| `ts` | string | ISO 8601 timestamp of emission |

#### `phaseComplete` — phase finished without fatal error

```json
{
  "event": "phaseComplete",
  "data": {
    "jobId": "restore-abc-123",
    "phase": "sprint",
    "itemsAttempted": 8,
    "itemsSucceeded": 7,
    "itemsFailed": 1,
    "ts": "2026-05-03T10:15:30Z"
  }
}
```

#### `phaseFailure` — fatal phase error, execution halted

```json
{
  "event": "phaseFailure",
  "data": {
    "jobId": "restore-abc-123",
    "phase": "board",
    "namedDiagnosticCode": "RESTORE_PHASE_BOARD_FAILED",
    "message": "RESTORE_PHASE_BOARD_FAILED: board: All 3 board creation requests returned HTTP 403. ...",
    "ts": "2026-05-03T10:15:35Z"
  }
}
```

#### `adfMediaWarning` — non-fatal warning after attachment phase

```json
{
  "event": "adfMediaWarning",
  "data": {
    "jobId": "restore-abc-123",
    "affectedIssueCount": 12,
    "message": "12 issues contain ADF media nodes that reference attachment IDs which have changed after restore. Links in issue descriptions or comments may be broken. Full rewrite pass is available in Phase 2.",
    "ts": "2026-05-03T10:15:55Z"
  }
}
```

#### `complete` — job reached terminal status

```json
{
  "event": "complete",
  "data": {
    "jobId": "restore-abc-123",
    "status": "completed_with_errors",
    "errorCount": 3,
    "ts": "2026-05-03T10:16:00Z"
  }
}
```

---

## 5. ADF Media Breakage Warning

ADF (Atlassian Document Format) media nodes in issue descriptions and comments reference attachments by their Jira-assigned `attachmentId`. When attachments are restored, Jira assigns **new** `attachmentId` values. The original ADF references become stale.

### Behaviour

- The warning is **non-fatal** and does not halt execution.
- It is emitted as an `adfMediaWarning` SSE event **after** the `post_issue` phase completes.
- `RestoreJob.adfMediaWarningEmitted` is set to `true` when any attachment in scope is successfully written.
- The wizard Step 5 (Review) pre-emptively renders a yellow inline banner when any attachments are in scope, warning the operator before the job starts.
- Full ADF media node rewriting (updating `attachmentId` references in ADF content) is **deferred to Phase 2** (T5 OQ-5, §7 Constraint 10).

### What the operator sees

- A persistent yellow banner on the Step 6 (Execute) screen once the warning is emitted.
- Banner copy: _"Some issues contain ADF media links that may be broken after restore. Attachment files have been restored, but link references in issue descriptions and comments could not be updated automatically. A full rewrite pass will be available in Phase 2."_
- The restore job status is unaffected — `completed` or `completed_with_errors` per the error count, not `failed`.

---

## 6. Execution Sequence Diagram

```
Operator                 RestoreJobRouter         RestoreWorker           JiraHttpClient
   │                           │                       │                       │
   │  POST /restore/jobs        │                       │                       │
   │──────────────────────────►│                       │                       │
   │                           │  create job (pending) │                       │
   │  201 { jobId, status }    │                       │                       │
   │◄──────────────────────────│                       │                       │
   │                           │  spawn worker         │                       │
   │  GET /restore/jobs/{id}/  │──────────────────────►│                       │
   │     events (SSE)          │                       │                       │
   │──────────────────────────►│  sse stream           │                       │
   │                           │◄──────────────────────┤                       │
   │                           │                       │                       │
   │                           │               [Phase 1: project]              │
   │                           │                       │  PUT /project/{key}   │
   │                           │                       │──────────────────────►│
   │                           │                       │  200 OK               │
   │                           │                       │◄──────────────────────│
   │  event: progress          │                       │                       │
   │◄──────────────────────────┤◄──────────────────────│                       │
   │                           │                       │                       │
   │                           │               [Phase 2: workflow]             │
   │                           │                       │  POST /workflow        │
   │                           │                       │──────────────────────►│
   │                           │                       │  403 Forbidden        │
   │                           │                       │◄──────────────────────│
   │                           │                       │  [fatal → halt]       │
   │  event: phaseFailure      │                       │                       │
   │  (RESTORE_PHASE_          │                       │                       │
   │   WORKFLOW_FAILED)        │                       │                       │
   │◄──────────────────────────┤◄──────────────────────│                       │
   │                           │                       │                       │
   │  event: complete          │                       │                       │
   │  (status: failed)         │                       │                       │
   │◄──────────────────────────┤◄──────────────────────│                       │
   │                           │                       │                       │
```

**Happy-path continuation** (post_issue phase, with ADF warning):

```
   │                           │               [Phase 7: post_issue]           │
   │                           │                       │  POST /issue/{k}/     │
   │                           │                       │    attachments        │
   │                           │                       │──────────────────────►│
   │                           │                       │  200 OK (new id)      │
   │                           │                       │◄──────────────────────│
   │  event: adfMediaWarning   │                       │                       │
   │◄──────────────────────────┤◄──────────────────────│                       │
   │                           │                       │                       │
   │  event: complete          │                       │                       │
   │  (status: completed)      │                       │                       │
   │◄──────────────────────────┤◄──────────────────────│                       │
```

---

## 7. Phase Executor Interface Contract

Each phase is implemented as a function conforming to:

```typescript
type PhaseExecutor = (ctx: PhaseExecutionContext) => Promise<PhaseResult>;

interface PhaseExecutionContext {
  job: RestoreJob;
  manifest: BackupPointManifest;
  httpClient: JiraHttpClient;     // canonical authenticated client; must not be bypassed
  eventBus: RestoreEventBus;      // emits SSE events; executor calls eventBus.emit('progress', ...)
  conflictResolver: ConflictResolver;
}
```

The orchestrator calls executors sequentially, checks `result.fatal` after each, and short-circuits on `true`.

---

## 8. Cross-References

- Wizard step flow and API endpoint shapes: `docs/restore-architecture.md`
- Restore type definitions: `src/restore/types.ts`
- RestoreWorker implementation target: `src/restore/RestoreWorker.ts`
- RestoreEventBus: `src/restore/RestoreEventBus.ts`
- Design request (restore-unit wizard & Board/Sprint sidebar filters): `docs/design-requests/restore-unit-and-sidebar-filters.md`
- Open contracts: `docs/open-contracts.md` OC-001, OC-002, OC-003

---

## 9. Sprint Allocation

| Sprint | Scope |
|---|---|
| Sprint 11 (done) | Wizard step flow · RestoreJob schema · Conflict-mode state machine · API endpoint shapes · Trash-window block rule |
| **Sprint 12 (this sprint)** | Phase executor interface · Ordered phase list implementation (project → workflow → custom_field → board → sprint → issue_body) · PhaseResult shape · Halt-on-failure + named diagnostics · Heartbeat/progress events |
| Sprint 13 | Post-issue-creation pass (links + comments + attachments) · ADF media warning emission · Export / Browser Download |
