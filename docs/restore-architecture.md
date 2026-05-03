# Restore Engine & Wizard — Architecture

_Sprint 11 — Software Architect deliverable_
_Phase: Restore Engine & Wizard — Sprint 1 of 3_

---

## 1. Wizard Step Flow

The restore wizard is a linear six-step flow. Each step must be completed before advancing; the user may navigate backward to any completed step.

```
Step 1: Source Selection
  └─ Select backup point from the backup point list
       (backupPointId, timestamp, item counts displayed)

Step 2: Scope Picker
  └─ Choose objects to restore:
       - All items in backup point, OR
       - Selected Projects (multi-select by projectKey), OR
       - Individual Issues (by issueKey / search)

Step 3: Destination
  └─ Choose restore target:
       (a) Original location   — same projectKey on same Jira site
       (b) Alternate location  — operator-selected projectKey on same site
       (c) Export / Browser Download — serialise to .zip archive, no Jira writes

Step 4: Conflict Mode
  └─ Choose how to handle objects that already exist at the destination:
       (a) Override    — overwrite existing object
       (b) Skip        — leave existing object untouched [DEFAULT]
       (c) Ask per conflict — pause job, prompt operator, resume on decision

Step 5: Review
  └─ Summary card: source backup point, scope, destination, conflict mode
       - Trash-window block notice rendered here if applicable (see §5)
       - ADF media link warning rendered if any attachments are in scope
       - "Start Restore" CTA

Step 6: Execute
  └─ Live progress view:
       - Phase-by-phase progress bar (Project → Workflow → CustomField →
         Board → Sprint → Issue → Links/Comments/Attachments)
       - Per-phase named diagnostic on failure, execution halted
       - ConflictDecisionRequired prompt inlined (Ask mode only)
       - Final status: Completed / Completed with N errors / Failed
```

---

## 2. RestoreJob Data Contract

### Schema

```typescript
interface RestoreJob {
  jobId: string;                        // UUID, server-assigned
  sourceBackupPointId: string;          // FK → BackupPoint.id
  createdAt: string;                    // ISO 8601

  scope: RestoreScope;
  destination: RestoreDestination;
  conflictMode: ConflictMode;

  status: RestoreJobStatus;
  currentPhase: RestorePhase | null;
  phaseProgress: PhaseProgress[];

  errorCount: number;
  failureDiagnostic: string | null;     // named diagnostic when status=failed

  adfMediaWarningEmitted: boolean;      // true if any attachments in scope
  trashWindowBlocked: boolean;          // true if original-location blocked
}

// ── Scope ────────────────────────────────────────────────────────────────────

type RestoreScope =
  | { type: 'all' }
  | { type: 'projects'; projectKeys: string[] }
  | { type: 'issues';   issueKeys: string[] };

// ── Destination ──────────────────────────────────────────────────────────────

type RestoreDestination =
  | { type: 'original' }
  | { type: 'alternate'; targetProjectKey: string }
  | { type: 'export' };

// ── Conflict Mode ─────────────────────────────────────────────────────────────

type ConflictMode = 'override' | 'skip' | 'ask';

// ── Status ───────────────────────────────────────────────────────────────────

type RestoreJobStatus =
  | 'pending'
  | 'running'
  | 'awaiting_decision'    // paused; ConflictDecisionRequired emitted
  | 'completed'
  | 'completed_with_errors'
  | 'failed';

// ── Phase ordering (enforced by engine, sprints 2–3) ─────────────────────────

type RestorePhase =
  | 'project'
  | 'workflow'              // Workflow + WorkflowScheme together
  | 'custom_field'          // CustomField + FieldConfiguration together
  | 'board'
  | 'sprint'
  | 'issue_body'
  | 'post_issue';           // issue links + comments + attachments

interface PhaseProgress {
  phase: RestorePhase;
  status: 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed';
  total: number;
  processed: number;
  errorCount: number;
  startedAt: string | null;
  completedAt: string | null;
}
```

---

## 3. Conflict-Mode State Machine

### States

```
PENDING ──────────────────────────────────────────────► RUNNING
                                                              │
                              ┌───────────────────────────────┤
                              │                               │
                    (conflictMode=ask,               (override or skip,
                     conflict detected)               no conflict pause)
                              │                               │
                              ▼                               │
                    AWAITING_DECISION ◄────────────────────── │
                         │    │                               │
               (operator  │    │ (operator                    │
                decides)  │    │  decides)                    │
                          ▼    ▼                              │
                        RUNNING ──────────────────────────────┘
                              │
                    ┌─────────┴──────────┐
                    │                    │
             (all phases OK)   (phase failure)
                    │                    │
                    ▼                    ▼
            COMPLETED /            FAILED
        COMPLETED_WITH_ERRORS   (execution halted,
                                 named diagnostic set)
```

### Transitions

| From | Event | To | Side Effect |
|---|---|---|---|
| `pending` | job started | `running` | first heartbeat emitted |
| `running` | conflict detected (ask mode) | `awaiting_decision` | emit `ConflictDecisionRequired` SSE event; job paused |
| `awaiting_decision` | POST `.../decisions` received | `running` | apply decision; resume processing |
| `running` | phase error (non-recoverable) | `failed` | set `failureDiagnostic`; halt execution; no subsequent phases run |
| `running` | all phases complete, errorCount=0 | `completed` | — |
| `running` | all phases complete, errorCount>0 | `completed_with_errors` | — |

### ConflictDecisionRequired Event (SSE)

```json
{
  "event": "ConflictDecisionRequired",
  "jobId": "restore-abc-123",
  "conflictId": "conflict-uuid",
  "objectType": "JiraIssue",
  "objectKey": "PROJ-42",
  "existingObjectSummary": "Fix login bug",
  "incomingObjectSummary": "Fix login bug (restored)"
}
```

The job pauses after emitting this event. No further phase progress occurs until a decision is received. All in-flight items in the current phase complete their current API call before the pause takes effect (atomic item boundary, not mid-write).

### Ask-Mode Pause/Resume Protocol

1. Engine processes items sequentially within each phase.
2. On encountering a conflict with `conflictMode=ask`:
   - Set `status = awaiting_decision`.
   - Emit `ConflictDecisionRequired` SSE event with `conflictId`.
   - Block the item processing loop.
3. Operator calls `POST /restore/jobs/{id}/decisions` with the decision payload.
4. Engine applies the decision (`override` or `skip`) to the conflicted object.
5. Set `status = running`. Resume processing from the paused item.
6. Multiple conflicts are resolved sequentially (one at a time); a queue is not pre-populated.

---

## 4. Destination Option Semantics

### 4a. Original Location

- Restore target is the same `projectKey` on the same Jira site (`cloudId`).
- No project-key remapping; all issue references, board/sprint associations use original identifiers.
- **Blocked** if the target project is currently in Atlassian's 60-day trash window (see §5).

### 4b. Alternate Location (same site)

- Operator selects an existing target `projectKey` on the **same** Jira site.
- Cross-site restore is **not supported** in Phase 1 (see §7 — Deferred).
- The engine remaps board and sprint associations to the alternate project.
- `accountId`-scoped fields (assignee, reporter, watchers) are carried over as-is — they remain valid within the same site.
- Custom field IDs are site-scoped and require no remapping within the same site.

### 4c. Export / Browser Download

- No Jira API write calls are made.
- The restore engine serialises the scoped backup data to a `.zip` archive:
  - `manifest.json` — item list and metadata
  - `issues/` — one JSON file per issue with full field payload
  - `attachments/` — binary attachment files at original filenames
- The archive is streamed to the operator's browser via a signed download URL.
- S3 / Azure Blob / GCS export is **deferred to Phase 2** (see §7 — Deferred).

---

## 5. In-Place Block Rule — 60-Day Trash Window

Atlassian places deleted projects into a 60-day managed trash window. Projects in this state cannot be written to via the REST API. Attempting an in-place restore to a trashed project will fail at the `project` phase.

### Detection

Before the restore engine starts the `project` phase, it calls:

```
GET /rest/api/3/project/{projectIdOrKey}
```

If the response indicates the project is in the trash (`archived: true` or HTTP 404 after confirming the project exists in the backup manifest), the in-place restore is blocked.

### Block Behaviour

- `status` is set to `failed` immediately, before any write occurs.
- `failureDiagnostic` is set to:

```
"TRASH_WINDOW_BLOCK: Project '{projectKey}' is currently in Atlassian's 60-day trash window and cannot be restored in place. To recover this project: (1) Use 'Alternate location' restore to restore data into a new or existing project on the same site, or (2) Wait for an Atlassian Site Admin to restore the project from the Atlassian admin trash, then retry. Native trash integration is not available in Phase 1."
```

- The Review step (wizard Step 5) pre-checks for this condition and renders the block notice **before** the operator starts the job, provided the project's trashed state is detectable via API at review time.

---

## 6. API Endpoint Shapes

### 6a. POST /restore/jobs — Create Restore Job

**Request**

```http
POST /restore/jobs
Content-Type: application/json

{
  "sourceBackupPointId": "bp-2026-05-03T00:00:00Z",
  "scope": {
    "type": "projects",
    "projectKeys": ["PROJ", "OPS"]
  },
  "destination": {
    "type": "original"
  },
  "conflictMode": "skip"
}
```

**Response — 201 Created**

```json
{
  "jobId": "restore-f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "sourceBackupPointId": "bp-2026-05-03T00:00:00Z",
  "createdAt": "2026-05-03T10:15:00Z",
  "scope": { "type": "projects", "projectKeys": ["PROJ", "OPS"] },
  "destination": { "type": "original" },
  "conflictMode": "skip",
  "status": "pending",
  "currentPhase": null,
  "phaseProgress": [],
  "errorCount": 0,
  "failureDiagnostic": null,
  "adfMediaWarningEmitted": false,
  "trashWindowBlocked": false
}
```

**Response — 400 Bad Request** (validation failure)

```json
{
  "error": "INVALID_SCOPE",
  "message": "issueKeys must be non-empty when scope.type is 'issues'."
}
```

**Response — 409 Conflict** (trash-window block detected at submission time)

```json
{
  "error": "TRASH_WINDOW_BLOCK",
  "message": "Project 'PROJ' is currently in Atlassian's 60-day trash window and cannot be restored in place. Use 'alternate' destination or wait for an admin to restore the project from Atlassian trash.",
  "affectedProjectKeys": ["PROJ"]
}
```

---

### 6b. GET /restore/jobs/{id} — Poll Job State

**Request**

```http
GET /restore/jobs/restore-f47ac10b-58cc-4372-a567-0e02b2c3d479
```

**Response — 200 OK**

```json
{
  "jobId": "restore-f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "sourceBackupPointId": "bp-2026-05-03T00:00:00Z",
  "createdAt": "2026-05-03T10:15:00Z",
  "scope": { "type": "projects", "projectKeys": ["PROJ", "OPS"] },
  "destination": { "type": "original" },
  "conflictMode": "skip",
  "status": "running",
  "currentPhase": "issue_body",
  "phaseProgress": [
    {
      "phase": "project",
      "status": "completed",
      "total": 2, "processed": 2, "errorCount": 0,
      "startedAt": "2026-05-03T10:15:01Z",
      "completedAt": "2026-05-03T10:15:03Z"
    },
    {
      "phase": "workflow",
      "status": "completed",
      "total": 3, "processed": 3, "errorCount": 0,
      "startedAt": "2026-05-03T10:15:03Z",
      "completedAt": "2026-05-03T10:15:05Z"
    },
    {
      "phase": "issue_body",
      "status": "running",
      "total": 142, "processed": 67, "errorCount": 1,
      "startedAt": "2026-05-03T10:15:12Z",
      "completedAt": null
    }
  ],
  "errorCount": 1,
  "failureDiagnostic": null,
  "adfMediaWarningEmitted": true,
  "trashWindowBlocked": false
}
```

**Response — 404 Not Found**

```json
{
  "error": "NOT_FOUND",
  "message": "Restore job 'restore-xyz' not found."
}
```

#### SSE Stream — GET /restore/jobs/{id}/events

The UI subscribes to the SSE stream for live updates. Events emitted:

```
event: progress
data: {"phase":"issue_body","processed":68,"total":142,"errorCount":1}

event: ConflictDecisionRequired
data: {"conflictId":"cdr-uuid","objectType":"JiraIssue","objectKey":"PROJ-42","existingObjectSummary":"...","incomingObjectSummary":"..."}

event: phaseFailure
data: {"phase":"board","diagnostic":"BOARD_CREATE_FORBIDDEN: ..."}

event: complete
data: {"status":"completed_with_errors","errorCount":3}
```

Heartbeat events are emitted every ≤10 seconds. A job with no event for >20 seconds surfaces a "stalled" alert in the UI (reuses `StalledJobDetector` from backup jobs).

---

### 6c. POST /restore/jobs/{id}/decisions — Resolve Ask-Mode Conflict

Only valid when `status = awaiting_decision`.

**Request**

```http
POST /restore/jobs/restore-f47ac10b-58cc-4372-a567-0e02b2c3d479/decisions
Content-Type: application/json

{
  "conflictId": "cdr-uuid",
  "decision": "override"
}
```

`decision` must be `"override"` or `"skip"`.

**Response — 200 OK**

```json
{
  "jobId": "restore-f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "conflictId": "cdr-uuid",
  "decision": "override",
  "status": "running"
}
```

**Response — 409 Conflict** (job not in awaiting_decision state)

```json
{
  "error": "INVALID_STATE",
  "message": "Job is not awaiting a decision. Current status: running."
}
```

**Response — 404 Not Found** (conflictId mismatch)

```json
{
  "error": "CONFLICT_NOT_FOUND",
  "message": "No pending conflict with id 'cdr-uuid'."
}
```

---

## 7. Explicitly Deferred (Non-Goals)

The following are out of scope for this phase and must not be implemented:

| Item | Reason | Source |
|---|---|---|
| **Cross-site restore** | `accountId` and custom field IDs are site-scoped; remapping tables required | T2 OQ-3, T5 §5.2 |
| **Cross-tenant restore** | Not supported in Phase 1 | T5 §5.2 |
| **ADF media link rewriting** | Restored attachments receive new `attachmentId`; full rewrite pass is Phase 2. A best-effort warning is emitted in the restore report (`adfMediaWarningEmitted: true`) | T5 OQ-5, §7 Constraint 10 |
| **Merge conflict mode** | No read-compare-write cycle; deferred given rate-limit constraints | T5 §5.1 |
| **S3 / Azure Blob / GCS export** | Export destination is Browser Download only in Phase 1 | T5 §5.2 |
| **Restore from Atlassian trash** | Projects in the trash window are blocked for in-place restore; native trash integration not in scope | T5 §4.2 |

---

## 8. Sprint Allocation

| Sprint | Scope |
|---|---|
| **Sprint 11 (this sprint)** | Wizard step flow · RestoreJob schema · Conflict-mode state machine · API endpoint shapes · Trash-window block rule · Conflict decision API |
| **Sprint 12** | Restore engine write-order implementation (Project → Workflow → CustomField → Board → Sprint → Issue body) · Phase-failure halt + named diagnostic |
| **Sprint 13** | Post-issue-creation pass (links + comments + attachments) · ADF media warning · Heartbeat + progress events for restore jobs · Export / Browser Download |
