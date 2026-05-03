# Architecture — Jira Cloud Backup & Restore Connector

_Version: 1.0.0-phase-1 | Last updated: 2026-05-03 | Status: MVP shipped (Sprints 1–14)_

---

## Table of Contents

1. [Component Map](#1-component-map)
2. [Data Flow](#2-data-flow)
3. [Object Model](#3-object-model)
4. [Key Invariants](#4-key-invariants)
5. [Integration Boundaries](#5-integration-boundaries)

---

## 1. Component Map

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Browser (React + Vite + Tailwind)                                       │
│                                                                          │
│  ┌──────────────────┐  ┌─────────────────────┐  ┌───────────────────┐   │
│  │  JiraConnectFlow │  │  InventorySidebar   │  │   RestoreWizard   │   │
│  │  ManualAuthForm  │  │  IssuesTable        │  │   (3-step wizard) │   │
│  │  SitePicker      │  │  GlobalSearchBar    │  │   PhaseTracker    │   │
│  │  WorkloadCard    │  │  ProjectInventory   │  │   DiagnosticBanner│   │
│  │  ErrorBanner     │  │  Search + Filters   │  │   ADF Warning     │   │
│  └────────┬─────────┘  └──────────┬──────────┘  └────────┬──────────┘   │
│           │                       │                       │              │
│           └───────────────────────┼───────────────────────┘              │
│                                   │ HTTP/SSE                             │
└───────────────────────────────────┼──────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼──────────────────────────────────────┐
│  Backend — Express (Node 20 / TypeScript)                                │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │  Routers                                                          │   │
│  │  JiraConnectionsRouter  ManualAuthRouter  WorkloadConfigRouter    │   │
│  │  JobRouter (SSE heartbeat + status)  InventoryRouter              │   │
│  │  DiscoveryPreviewRouter  RestoreJobRouter                         │   │
│  └───────────────┬───────────────────────────────────────────────────┘   │
│                  │                                                        │
│  ┌───────────────▼──────────────────────────────────────────────────┐    │
│  │  Orchestrators & Services                                        │    │
│  │                                                                  │    │
│  │  ┌──────────────────────┐  ┌────────────────────────────────┐   │    │
│  │  │ContextNodeCapture    │  │  IssueCaptureOrchestrator      │   │    │
│  │  │Orchestrator          │  │  (full payload + per-item err) │   │    │
│  │  │(ordered pipeline)    │  └──────────────┬─────────────────┘   │    │
│  │  └──────────┬───────────┘                 │                     │    │
│  │             │                             │                     │    │
│  │  ┌──────────▼───────────┐  ┌──────────────▼─────────────────┐  │    │
│  │  │ ProjectDiscovery     │  │  AttachmentBlobStore           │  │    │
│  │  │ Service              │  │  (binary-faithful storage)     │  │    │
│  │  └──────────────────────┘  └────────────────────────────────┘  │    │
│  │                                                                  │    │
│  │  ┌──────────────────────┐  ┌────────────────────────────────┐  │    │
│  │  │ RestoreEngine        │  │  SdiScanner                    │  │    │
│  │  │ RestorePhaseHandlers │  │  (post-processing pipeline)    │  │    │
│  │  │ TrashWindowChecker   │  └────────────────────────────────┘  │    │
│  │  │ BrowserDownload      │                                       │    │
│  │  │ Assembler            │                                       │    │
│  │  └──────────────────────┘                                       │    │
│  │                                                                  │    │
│  │  ┌──────────────────────┐  ┌────────────────────────────────┐  │    │
│  │  │ HeartbeatEmitter     │  │  BackupMetrics / RestoreMetrics│  │    │
│  │  │ StalledJobDetector   │  │  (structured logs + counters)  │  │    │
│  │  │ JobEventBus          │  └────────────────────────────────┘  │    │
│  │  └──────────────────────┘                                       │    │
│  └──────────────────────────────────────────────────────────────────┘   │
│                  │                                                        │
│  ┌───────────────▼──────────────────────────────────────────────────┐    │
│  │  Canonical HTTP Layer                                            │    │
│  │                                                                  │    │
│  │  ┌──────────────────────────────────────────────────────────┐   │    │
│  │  │  JiraHttpClient                                          │   │    │
│  │  │  • OAuth Bearer (mutex-guarded rotating refresh)        │   │    │
│  │  │  • HTTP Basic (API Token fallback)                      │   │    │
│  │  │  • POST /rest/api/3/search/jql (GET deprecated/banned)  │   │    │
│  │  │  • paginateAtlassian (shared pagination utility)        │   │    │
│  │  └──────────────────────────────────────────────────────────┘   │    │
│  │                                                                  │    │
│  │  ┌──────────────────────────────────────────────────────────┐   │    │
│  │  │  JiraOAuthHandler                                        │   │    │
│  │  │  • 3LO redirect + callback                              │   │    │
│  │  │  • accessible-resources site picker                     │   │    │
│  │  └──────────────────────────────────────────────────────────┘   │    │
│  └──────────────────────────────────────────────────────────────────┘   │
│                  │                                                        │
│  ┌───────────────▼──────────────────────────────────────────────────┐    │
│  │  Storage Tier — SQLite (better-sqlite3)                          │    │
│  │                                                                  │    │
│  │  jira_credentials      — cloudId, accessToken, refreshToken,    │    │
│  │                          oauthClientId (atomic rotation)         │    │
│  │  api_token_credentials — cloudId, email, apiToken               │    │
│  │  backup_points         — backupPointId, cloudId, status,        │    │
│  │                          timestamps, manifest JSON               │    │
│  │  manifest_entries      — per-item rows (objectType, status,     │    │
│  │                          sdiScan, backupPointId, capturedAt)     │    │
│  │  jobs                  — backup job state, heartbeat, SSE       │    │
│  │  restore_jobs          — restore job state, phases, conflicts   │    │
│  │  workload_config       — scopeMode, selectedProjectKeys         │    │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                         ┌──────────▼──────────┐
                         │  Atlassian Cloud     │
                         │  api.atlassian.com  │
                         │  auth.atlassian.com │
                         └─────────────────────┘
```

### Key Files by Component

| Component | Primary Files |
|---|---|
| OAuth handler | `src/auth/JiraOAuthHandler.ts`, `src/auth/jiraOAuthScopes.ts` |
| Canonical HTTP client | `src/http/JiraHttpClient.ts` |
| Credential store | `src/db/JiraCredentialRepository.ts` |
| Project discovery | `src/discovery/ProjectDiscoveryService.ts` |
| Context-node pipeline | `src/capture/ContextNodeCaptureOrchestrator.ts` |
| Issue capture | `src/capture/IssueCaptureOrchestrator.ts` |
| Attachment store | `src/backup/AttachmentBlobStore.ts` |
| Manifest writer | `src/manifest/BackupPointManifestWriter.ts` |
| Pagination utility | `src/pagination/paginateAtlassian.ts` |
| Heartbeat / stall | `src/jobs/HeartbeatEmitter.ts`, `src/jobs/StalledJobDetector.ts` |
| SDI scanner | `src/sdi/SdiScanner.ts`, `src/sdi/detectors/`, `src/sdi/handlers/` |
| Restore engine | `src/restore/RestoreEngine.ts`, `src/restore/RestorePhaseHandlers.ts` |
| Trash-window check | `src/restore/TrashWindowChecker.ts` |
| Browser download | `src/restore/BrowserDownloadAssembler.ts` |
| Inventory API | `src/inventory/InventoryRouter.ts` |
| Metrics | `src/metrics/BackupMetrics.ts`, `src/restore/RestoreMetrics.ts` |
| Frontend shell | `frontend/src/App.tsx`, `frontend/src/components/` |

---

## 2. Data Flow

### 2.1 Backup Path

```
1. PROJECT DISCOVERY
   ─────────────────
   ProjectDiscoveryService
   → GET /rest/api/3/project/search  (paginated, All / Selected scope)
   → JSM service_desk projects → out-of-scope manifest annotation (not captured)
   → Non-JSM projects → proceed to context-node capture

2. CONTEXT-NODE CAPTURE  (strict dependency order — must complete before Protected Objects)
   ──────────────────────────────────────────────────────────────────────────────────────
   ContextNodeCaptureOrchestrator enforces this exact sequence:

   a. IssueType         GET /rest/api/3/issuetype
   b. CustomField        GET /rest/api/3/field
                         → custom:false fields → skipped (system_field skip reason)
                         → custom:true fields  → GET /rest/api/3/field/{id}/context
   c. FieldConfiguration GET /rest/api/3/fieldconfiguration
   d. Workflow           GET /rest/api/3/workflow/search
   e. WorkflowScheme     GET /rest/api/3/workflowscheme
   f. Project            (already discovered; context metadata written to manifest)
   g. Board              GET /rest/agile/1.0/board
   h. Sprint             GET /rest/agile/1.0/board/{id}/sprint  (per board)

   Each stage: paginateAtlassian → ManifestEntry written per object.
   Failures produce error ManifestEntry — never a silent omission.

3. ISSUE + ATTACHMENT FETCH
   ─────────────────────────
   IssueCaptureOrchestrator:
   → POST /rest/api/3/search/jql  fields=['*all']  (paginated)
     Pagination terminates: issues.length === 0  OR  issues.length < maxResults
   → Per issue: system fields + customFieldValues (no field skipped)
     ADF comments (body + author + timestamps)
     Issue links (all link types, both directions)
     Subtask references, sprint membership, watchers, worklogs
   → Per attachment reference: JiraHttpClient.downloadAttachment(id)
     → GET /rest/api/3/attachment/content/{id}
     → AttachmentBlobStore.store(buffer, filename, mimeType)
     Binary-faithful: no transcoding, no recompression

4. SDI POST-PROCESSING  (after Issue + Attachment fetch, before manifest finalisation)
   ──────────────────────────────────────────────────────────────────────────────────
   SdiScanner:
   → For each attachment, route to file-type handler by extension:
     entities.xml         → XmlEntitiesHandler
     .csv/.xlsx/.tsv      → TabularHandler
     .env/.yaml/.yml/     → ConfigHandler
       .json/.toml/
       .properties/.config
     .txt/.log/.md        → PlainTextHandler
   → Pattern detectors applied to extracted text:
     EmailDetector, ApiKeySecretDetector,
     CreditCardDetector (Luhn-validated), PhoneDetector
   → Regulation tag activation:
     email / phone → GDPR
     credit card   → PCI DSS
   → SdiScanEntry written to manifest_entries row for the JiraIssue

5. MANIFEST WRITE
   ───────────────
   BackupPointManifestWriter:
   → Per-stage ManifestStageSection written atomically after each phase
   → BackupPointManifest finalised: status set to 'completed' or
     'completed_with_errors' (never 'completed' when errorCount > 0)
   → backup_points row updated; manifest_entries rows persisted
   → Invariant: capturedCount + skippedIds.length === apiTotalReported
     (ReconciliationReport written — gaps surface as RECONCILIATION_GAP errors)

OBSERVABILITY (concurrent with steps 1–5):
   HeartbeatEmitter → progress event every ≤10 s → SSE endpoint for UI
   StalledJobDetector → alert if no heartbeat for >20 s
   BackupMetrics → structured log lines per phase (namespace: [jira-backup])
```

### 2.2 Restore Path

```
1. VALIDATION
   ──────────
   RestoreJobRouter receives wizard submission:
   { sourceBackupPointId, scope, destination, conflictMode }
   → TrashWindowChecker: if destination.type === 'original' AND project is in
     Atlassian's 60-day trash window → block with TRASH_WINDOW_BLOCKED error,
     surface alternate-location guidance (in-place restore is forbidden)
   → Backup point loaded from manifest store; scope validated

2. DEPENDENCY-ORDERED WRITER  (strict phase sequence — failure halts execution)
   ────────────────────────────────────────────────────────────────────────────
   RestoreEngine delegates to RestorePhaseHandlers in this exact order:

   Phase 1: project        POST /rest/api/3/project
   Phase 2: workflow       POST /rest/api/3/workflow  (+ WorkflowScheme)
   Phase 3: custom_field   POST /rest/api/3/field     (+ FieldConfiguration)
   Phase 4: board          POST /rest/agile/1.0/board
   Phase 5: sprint         POST /rest/agile/1.0/sprint
   Phase 6: issue_body     POST /rest/api/3/issue
   Phase 7: post_issue     POST /rest/api/3/issue/{key}/comment
                           POST /rest/api/3/issueLink
                           POST /rest/api/3/issue/{key}/attachments

   Phase failure → named diagnostic written to RestoreJob.failureDiagnostic
               → execution halts; subsequent phases are not attempted
               → UI DiagnosticBanner surfaces the named failure

3. CONFLICT RESOLUTION  (evaluated per object in phases 1–6)
   ────────────────────────────────────────────────────────
   If an object already exists in the destination site:
     conflictMode = 'skip'     → object skipped; RestoreConflict row written
     conflictMode = 'override' → existing object overwritten
     conflictMode = 'ask'      → job moves to 'awaiting_decision' state;
                                  UI prompts operator per conflict;
                                  decision written back → job resumes

   Default conflict mode: 'skip'

4. DESTINATION ROUTING
   ────────────────────
   destination.type = 'original'  → write back to originating cloudId / project
   destination.type = 'alternate' → write to targetProjectKey on same cloudId
   destination.type = 'export'    → BrowserDownloadAssembler generates ZIP
                                     (JSZip) containing issue JSON + attachments;
                                     no Jira API writes made

5. ADF MEDIA WARNING
   ──────────────────
   After post_issue phase: if any attachment was restored (new attachmentId assigned),
   RestoreWizard ADF warning banner is shown.
   ADF media node rewrite (old → new attachmentId) is deferred to Phase 2.

OBSERVABILITY (concurrent with steps 1–5):
   HeartbeatEmitter → progress event every ≤10 s → SSE endpoint for UI
   StalledJobDetector → alert if no heartbeat for >20 s
   RestoreMetrics → structured log lines per phase (namespace: [jira-restore])
```

---

## 3. Object Model

### 3.1 Context Nodes (captured before Protected Objects; required for restore dependency ordering)

| Object Type | Key Fields | Capture Endpoint | Restore Order |
|---|---|---|---|
| **IssueType** | id, name, description, subtask, avatarId | `GET /rest/api/3/issuetype` | — (context; not directly restored) |
| **CustomField** | id, name, schema, custom (boolean) | `GET /rest/api/3/field` | Phase 3 |
| **FieldConfiguration** | id, name, description, isDefault | `GET /rest/api/3/fieldconfiguration` | Phase 3 (alongside CustomField) |
| **Workflow** | id, name, description, statuses, transitions | `GET /rest/api/3/workflow/search` | Phase 2 |
| **WorkflowScheme** | id, name, description, issueTypeMappings | `GET /rest/api/3/workflowscheme` | Phase 2 (alongside Workflow) |

**Custom field gating rule:** `GET /rest/api/3/field/{id}/context` is called only when `custom === true`. Fields where `custom === false` (system fields) are recorded in the manifest with `skipReason: 'system_field'` and the context endpoint is never invoked.

### 3.2 Protected Objects (the Phase 1 backup/restore target set)

| Object Type | Key Fields | Capture Endpoint | Restore Phase | Dependencies |
|---|---|---|---|---|
| **JiraProject** | id, key, name, projectTypeKey, archived, leadAccountId, workflowSchemeId | `GET /rest/api/3/project/search` | Phase 1 | None |
| **JiraBoard** | id, name, type, location.projectId, columnConfig, filter | `GET /rest/agile/1.0/board` | Phase 4 | JiraProject |
| **JiraSprint** | id, name, state, startDate, endDate, completeDate, boardId | `GET /rest/agile/1.0/board/{id}/sprint` | Phase 5 | JiraBoard |
| **JiraIssue** | id, key, summary, description (ADF), status, issueType, priority, assignee, reporter, created, updated, customFieldValues (map — no field skipped), comments (ADF bodies + author + timestamps), issueLinks (both directions), subtasks, attachments (refs), sprint membership, watchers, worklogs | `POST /rest/api/3/search/jql` fields=`['*all']` | Phase 6 (body) + Phase 7 (links/comments/attachments) | JiraProject, JiraBoard, JiraSprint, CustomField, Workflow |

### 3.3 Manifest Entry Status Values

| Status | Meaning |
|---|---|
| `success` | Object captured and persisted without error |
| `error` | API error during capture; error detail recorded; backup continues |
| `skipped` | Object excluded by rule (system_field, duplicate_id) |
| `out_of_scope` | JSM service_desk project — Phase 2 item; entry still written (zero-silent-omission) |

### 3.4 Restore Job Status Values

| Status | Meaning |
|---|---|
| `pending` | Job created; not yet started |
| `running` | Phase execution in progress |
| `awaiting_decision` | Conflict mode = 'ask'; waiting for operator input |
| `completed` | All phases succeeded; zero errors |
| `completed_with_errors` | All phases ran; one or more per-item errors recorded |
| `failed` | A phase-level failure halted execution; diagnostic surfaced |

---

## 4. Key Invariants

These are the architectural contracts the codebase enforces. Violating any of them is a P0 defect.

### Invariant 1 — Manifest Persisted ⇔ Job Complete
A backup point manifest row is written with `status: 'completed'` or `status: 'completed_with_errors'` only after all capture phases have run and the `BackupPointManifestWriter.finalise()` call succeeds. A job that crashes mid-run leaves the manifest row in `status: 'in_progress'` — the UI displays it as incomplete. There is no path that writes `completed` without persisting the manifest.

**Corollary:** A backup that completes with per-item errors MUST display "Completed with N errors" — never "Completed successfully." The `HeartbeatEmitter.complete(errorCount)` method enforces this: if `errorCount > 0`, the final job status is `completed_with_errors`.

### Invariant 2 — GUI Status Equals Log Status
The job status displayed in the UI is read from the same `jobs` / `restore_jobs` DB row that the backend writes structured log lines against. There is no separate "display status" field. If the log says `completed_with_errors`, the UI must show `completed_with_errors`. If you cannot enforce this in a sprint, raise it as a blocker — do not paper over it.

### Invariant 3 — One Canonical Authenticated HTTP Client
All HTTP calls to Atlassian APIs (`*.atlassian.com`, `auth.atlassian.com`) go through `JiraHttpClient` in `src/http/JiraHttpClient.ts`. Feature code MUST NOT instantiate raw `fetch()` or `axios.create()` against vendor API endpoints. If a new API surface is needed, add a method to `JiraHttpClient`.

### Invariant 4 — Refresh Interceptor Centralised with Atomic Token Rotation
The 401 → refresh → retry cycle lives exclusively in `JiraHttpClient.execute()` / `ensureTokenRefreshed()` / `doRefresh()`. When a token refresh fires, both `access_token` and `refresh_token` are written to `jira_credentials` inside a single `better-sqlite3` transaction (`repo.rotateTokens(...)`) before the mutex is released. Concurrent 401 handlers queue behind a single `refreshInFlight` Promise — only one POST to `https://auth.atlassian.com/oauth/token` is fired per burst. Feature code must never read tokens directly or implement its own retry.

### Invariant 5 — Coverage Completeness: Every Configured Custom-Field Value Captured
`IssueCaptureOrchestrator` requests `fields: ['*all']` on every `POST /rest/api/3/search/jql` call. No field list is specified that could accidentally exclude a custom field. The `customFieldValues` map on a `JiraIssue` manifest entry must contain every `customfield_*` key returned by the API for that issue. Any change to the field list parameter that produces a narrower field set violates this invariant.

### Invariant 6 — POST /rest/api/3/search/jql Is the Only Issue Search Endpoint
The deprecated `GET /rest/api/3/search` endpoint is permanently forbidden. A CI build gate (`scripts/check-deprecated-endpoint.sh`) runs as part of `npm run build` and fails the build if the forbidden path appears anywhere in `src/`. New code that needs to search issues must use `JiraHttpClient.searchIssues()` or `JiraHttpClient.paginateIssues()`.

### Invariant 7 — Custom-Field Context Discovery Only for custom:true Fields
`ContextNodeCaptureOrchestrator` calls `GET /rest/api/3/field/{id}/context` only for fields where `custom === true`. System fields (`custom === false`) skip the context endpoint and are recorded with `skipReason: 'system_field'`. Passing system field IDs to the context endpoint produces unnecessary API calls and may return errors — this invariant prevents that.

### Invariant 8 — Pagination Terminates on Empty or Partial Page
`paginateAtlassian` (the shared utility used by all list endpoints) terminates when:
- `items.length === 0` (empty page — no more data)
- `items.length < maxResults` (partial page — last page)
- `isLast === true` (Agile API compatibility)
- `collectedItems >= apiReportedTotal` (total-count sentinel)

Callers must not implement custom termination logic. All paginated fetches must go through `paginateAtlassian`.

### Invariant 9 — Restore Dependency Order Is Contractual
The restore write order `Project → Workflow + WorkflowScheme → CustomField + FieldConfiguration → Board → Sprint → Issue body → links/comments/attachments` is defined in `RestorePhaseHandlers.ts` and must not be changed without a corresponding PRD/architecture change. A failure in any phase halts execution — the next phase must not begin until all items in the current phase have completed or produced an explicit error entry. Any new Phase 2 object type must be placed correctly in this sequence.

### Invariant 10 — Heartbeat ≤10s; Stalled Alert >20s
Every backup and restore job emits a progress heartbeat at most 10 seconds apart via `HeartbeatEmitter`. `StalledJobDetector` surfaces a "stalled" UI alert if no heartbeat is received for more than 20 seconds. Silent jobs that run without heartbeats are unacceptable — this is a global engineering standard enforced in `src/jobs/`.

---

## 5. Integration Boundaries

### 5.1 Atlassian API Endpoints Used

| Endpoint | Method | Purpose | Phase Introduced |
|---|---|---|---|
| `https://api.atlassian.com/me` | GET | Verify OAuth identity (accountId check) | Phase 1 |
| `https://api.atlassian.com/oauth/token/accessible-resources` | GET | Site picker — list connected Jira sites | Phase 1 |
| `https://auth.atlassian.com/oauth/token` | POST | Obtain / refresh OAuth tokens | Phase 1 |
| `/rest/api/3/project/search` | GET | Paginated project discovery | Phase 2 |
| `/rest/api/3/issuetype` | GET | IssueType context-node capture | Phase 2 |
| `/rest/api/3/field` | GET | CustomField list (custom flag gate) | Phase 2 |
| `/rest/api/3/field/{id}/context` | GET | Custom-field context (custom:true only) | Phase 2 |
| `/rest/api/3/fieldconfiguration` | GET | FieldConfiguration capture | Phase 2 |
| `/rest/api/3/workflow/search` | GET | Workflow capture | Phase 2 |
| `/rest/api/3/workflowscheme` | GET | WorkflowScheme capture | Phase 2 |
| `/rest/agile/1.0/board` | GET | Board capture | Phase 2 |
| `/rest/agile/1.0/board/{id}/sprint` | GET | Sprint capture (per board) | Phase 2 |
| `/rest/api/3/search/jql` | POST | Issue search + pagination | Phase 3 |
| `/rest/api/3/attachment/content/{id}` | GET | Binary-faithful attachment download | Phase 3 |
| `/rest/api/3/project` | POST | Restore: create project | Phase 6 |
| `/rest/api/3/workflow` | POST | Restore: create workflow | Phase 6 |
| `/rest/api/3/workflowscheme` | POST | Restore: create workflow scheme | Phase 6 |
| `/rest/api/3/field` | POST | Restore: create custom field | Phase 6 |
| `/rest/agile/1.0/board` | POST | Restore: create board | Phase 6 |
| `/rest/agile/1.0/sprint` | POST | Restore: create sprint | Phase 6 |
| `/rest/api/3/issue` | POST | Restore: create issue | Phase 6 |
| `/rest/api/3/issue/{key}/comment` | POST | Restore: create comment (post-issue pass) | Phase 6 |
| `/rest/api/3/issueLink` | POST | Restore: create issue link (post-issue pass) | Phase 6 |
| `/rest/api/3/issue/{key}/attachments` | POST | Restore: upload attachment (post-issue pass) | Phase 6 |

### 5.2 Deprecated Endpoints — Migrated Off

| Endpoint | Status | Replacement | Enforcement |
|---|---|---|---|
| `GET /rest/api/3/search` | **FORBIDDEN** | `POST /rest/api/3/search/jql` | `scripts/check-deprecated-endpoint.sh` runs in `npm run build`; build fails if the forbidden path appears in `src/` |

### 5.3 OAuth Scope Set

All scopes are required. None are optional. `offline_access` is mandatory to obtain a `refresh_token` for unattended backup jobs (defined in `src/auth/jiraOAuthScopes.ts`).

| Scope | Purpose |
|---|---|
| `read:jira-user` | Read user profile data (assignee, reporter, watchers, worklogs) |
| `read:jira-work` | Read issues, projects, boards, sprints, workflows, custom fields, attachments |
| `write:jira-work` | Create/update issues, comments, issue links, attachments during restore |
| `manage:jira-project` | Create/configure projects during restore; board and sprint management |
| `manage:jira-configuration` | Read and write workflow schemes, field configurations; required for full context-node capture |
| `read:me` | Verify the authorising account identity via `GET /me` after OAuth callback |
| `offline_access` | Obtain `refresh_token`; enables unattended rotating-refresh token flow |

### 5.4 Credential Store Schema

Credentials are persisted in SQLite and never written to environment variables or log output.

```
jira_credentials
  cloudId          TEXT PRIMARY KEY
  accessToken      TEXT NOT NULL
  refreshToken     TEXT NOT NULL
  oauthClientId    TEXT NOT NULL
  expiresAt        INTEGER          -- Unix epoch seconds (30-second buffer applied)
  createdAt        TEXT
  updatedAt        TEXT

api_token_credentials
  cloudId          TEXT PRIMARY KEY
  siteUrl          TEXT NOT NULL
  email            TEXT NOT NULL
  apiToken         TEXT NOT NULL    -- stored as-is; transmitted as HTTP Basic
  createdAt        TEXT
  updatedAt        TEXT
```

### 5.5 Not Supported in Phase 1 (Integration Boundary Exclusions)

- **JSM API** (`/rest/servicedeskapi/*`) — no calls made; out of scope.
- **Audit log API** (`/rest/api/3/auditing/record`) — pending scope confirmation.
- **Cross-site restore** — blocked; `cloudId` remapping tables not implemented.
- **S3 / Azure Blob / GCS** — export destination is Browser Download only.
- **Incremental backup** — full-snapshot model only; `updated >=` JQL predicate not used.

---

## Appendix: Migration & Extension Notes

### Adding a New Object Type (Phase 2)
1. Add the object type to `JiraObjectType` in `src/manifest/types.ts`.
2. Add a capture step to `ContextNodeCaptureOrchestrator.ts` in the correct dependency position.
3. Add a restore phase to `RestorePhaseHandlers.ts` in the correct restore-order position.
4. Update `RestorePhase` union type in `src/restore/types.ts`.
5. Add SDI handler registration in `SdiScanner.ts` if the new object type has scannable attachments.
6. Update this document: Object Model (§3), Data Flow (§2), Integration Boundaries (§5).

### Changing the OAuth Scope Set
Any scope addition requires re-authorisation of all connected sites. This is a **BREAKING** change for existing connections. Scope additions must be documented in `CHANGELOG.md` with an explicit `**BREAKING**` marker and operator reconnect instructions.
