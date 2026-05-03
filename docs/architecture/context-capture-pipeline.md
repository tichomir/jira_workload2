# Jira Cloud — Context-Node Capture Pipeline Architecture

_Author: Software Architect | Date: 2026-05-03 | Status: Approved for Sprint 3_

---

## 1. Capture Order (Restore Dependency Contract)

Context nodes MUST be captured in the following strict order in every backup job. This order mirrors the write dependency chain required during restore: a later-phase object always references an earlier-phase object, so capturing out of order would leave dangling references in the manifest.

```
Phase 1 — IssueType
Phase 2 — CustomField + FieldConfiguration
Phase 3 — Workflow + WorkflowScheme
Phase 4 — Project
Phase 5 — Board
Phase 6 — Sprint
Phase 7 — Issue  (Protected Object — always after all context phases)
```

**Rule:** Context node capture (Phases 1–6) MUST complete successfully before any Protected Object capture (Phase 7) begins. If any context phase fails, the backup job halts at that phase and surfaces a named diagnostic. Protected Object capture does not start.

### Rationale

| Dependency | Why order matters |
|---|---|
| IssueType before CustomField | FieldConfigurations reference IssueType mappings |
| CustomField before Workflow | Workflow post-functions can reference custom field IDs |
| Workflow before Project | Projects reference a WorkflowScheme (which bundles Workflows) |
| Project before Board | Boards are scoped to a Project |
| Board before Sprint | Sprints belong to a Board (via rapidViewId) |
| Sprint before Issue | Issues carry sprint membership; sprint ID must exist in manifest before issue reference is written |

---

## 2. Backup-Point Manifest Schema

### Zero-Silent-Omission Guarantee

Every object returned by the Jira API MUST appear in the manifest — either as a successful entry or as an explicit error entry. Silent drops are forbidden.

**Implementation rule:** After each paginated fetch loop completes, the manifest MUST contain exactly `paginationResult.totalFetched` entries (success + error combined) for that object type. If `totalFetched < apiReportedTotal` AND pagination terminated on `isLast !== true` and `values.length > 0`, the manifest MUST include a `RECONCILIATION_GAP` sentinel entry (see §3).

### TypeScript Interfaces

```typescript
/**
 * A single entry in the backup-point manifest.
 * Every API-returned object produces exactly one ManifestEntry.
 * Failures produce an error entry — never a silent omission.
 */
export interface ManifestEntry {
  /** Unique identifier of the object as returned by the Jira API */
  id: string;
  /** Human-readable key or name (e.g. project key, issue key) */
  key: string;
  /** The capture phase this entry belongs to */
  phase: CapturePhase;
  /** The Jira object type */
  objectType: JiraObjectType;
  /** ISO 8601 timestamp when this entry was captured */
  capturedAt: string;
  /** Outcome of the capture attempt */
  status: 'success' | 'error' | 'skipped' | 'out_of_scope';
  /** Present when status === 'error' — structured diagnostic */
  error?: ManifestError;
  /** Present when status === 'skipped' — reason code */
  skipReason?: SkipReason;
  /** Backup-point this entry belongs to */
  backupPointId: string;
}

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
  | 'jsm_out_of_scope'     // service_desk project type — Phase 2
  | 'system_field'          // custom:false field — context endpoint not called
  | 'duplicate_id';         // defensive: API returned same ID in two pages

export interface ManifestError {
  /** HTTP status code, if applicable */
  httpStatus?: number;
  /** Error code for programmatic handling */
  code: ManifestErrorCode;
  /** Human-readable description */
  message: string;
  /** Jira API endpoint that failed */
  endpoint?: string;
  /** ISO 8601 timestamp of the failure */
  failedAt: string;
  /** Whether the backup job was halted by this error */
  halted: boolean;
}

export type ManifestErrorCode =
  | 'API_ERROR'             // non-2xx response from Jira API
  | 'NETWORK_ERROR'         // connection timeout or DNS failure
  | 'PARSE_ERROR'           // unexpected response shape
  | 'RECONCILIATION_GAP'    // fetched count < API-reported total
  | 'PHASE_HALTED'          // a prior phase error caused this phase to be skipped
  | 'AUTH_ERROR';           // 401/403 during capture

/**
 * Top-level backup-point manifest.
 * Written atomically at the end of a successful (or partial) backup job.
 */
export interface BackupPointManifest {
  backupPointId: string;
  cloudId: string;
  siteUrl: string;
  /** ISO 8601 timestamp when the backup job started */
  startedAt: string;
  /** ISO 8601 timestamp when the manifest was finalised */
  finalisedAt: string;
  /** Final job status */
  status: 'completed' | 'completed_with_errors' | 'halted';
  /** Per-phase summary counts */
  phaseSummary: Record<CapturePhase, PhaseSummary>;
  /** All captured entries — one per API-returned object */
  entries: ManifestEntry[];
  /** Reconciliation report — one entry per object type */
  reconciliation: ReconciliationReport[];
}

export interface PhaseSummary {
  phase: CapturePhase;
  totalFetched: number;
  successCount: number;
  errorCount: number;
  skippedCount: number;
  /** True if this phase completed without any halting errors */
  completed: boolean;
}

export interface ReconciliationReport {
  objectType: JiraObjectType;
  /** Total objects the Jira API reported (from the `total` field in paginated responses) */
  apiReportedTotal: number | null;  // null if API does not return a total
  /** Actual number fetched across all pages */
  totalFetched: number;
  /** Number of manifest entries (success + error + skipped) for this type */
  manifestEntryCount: number;
  /** True if totalFetched === manifestEntryCount (no silent drops) */
  reconciled: boolean;
  /** Present if reconciled === false */
  gap?: number;
}
```

### ProjectNode Interface

```typescript
/**
 * A captured Project context node.
 * Stored as the payload within ManifestEntry for JiraProject objects.
 */
export interface ProjectNode {
  /** Jira project ID */
  id: string;
  /** Jira project key (e.g. "PROJ") */
  key: string;
  /** Display name */
  name: string;
  /**
   * Jira project type key.
   * Phase 1 supports: 'software', 'business'.
   * 'service_desk' → out_of_scope entry; JSM notice surfaced.
   */
  projectTypeKey: 'software' | 'business' | 'service_desk' | string;
  /** Whether this project is in the Atlassian-managed 60-day trash window */
  archived: boolean;
  /** Account ID of the project lead */
  leadAccountId?: string;
  /** ID of the WorkflowScheme associated with this project */
  workflowSchemeId?: string;
  /** ISO 8601 timestamp from the API */
  self: string;
  /** Raw style — 'next-gen' (team-managed) or 'classic' */
  style?: 'next-gen' | 'classic';
}
```

---

## 3. Pagination Termination Contract

All Jira list endpoints (project/search, field list, board list, sprint list, etc.) MUST use the following pagination logic. No endpoint is exempt.

### Termination Conditions (ANY of the following halts pagination)

| Condition | Applies to |
|---|---|
| `values.length === 0` | All paginated endpoints |
| `isLast === true` | Endpoints that return an `isLast` boolean (e.g. Board/Sprint via Agile API) |
| `values.length < maxResults` | All paginated endpoints — a partial page means the last page |
| `startAt >= total` | Endpoints returning a `total` field — defensive guard |

### PaginationResult Interface

```typescript
/**
 * Returned by every paginated fetch helper.
 * Callers use this to build ReconciliationReport entries.
 */
export interface PaginationResult<T> {
  /** All items fetched across all pages */
  items: T[];
  /** Number of items fetched (items.length) */
  totalFetched: number;
  /**
   * Total count reported by the API.
   * Some endpoints (e.g. GET /rest/api/3/field) do not return a total;
   * set to null in that case.
   */
  apiReportedTotal: number | null;
  /** Number of pages fetched */
  pagesFetched: number;
  /**
   * True if totalFetched === apiReportedTotal (when apiReportedTotal is known).
   * Always true when apiReportedTotal is null (cannot detect a gap).
   */
  reconciled: boolean;
  /**
   * Present if reconciled === false.
   * Value: apiReportedTotal - totalFetched.
   */
  gap?: number;
}
```

### Standard Pagination Loop (TypeScript pseudocode)

```typescript
async function paginateAll<T>(
  fetchPage: (startAt: number, maxResults: number) => Promise<{
    values?: T[];
    issues?: T[];       // search/jql uses 'issues' key
    total?: number;
    isLast?: boolean;
    maxResults: number;
  }>,
  maxResults = 50
): Promise<PaginationResult<T>> {
  const items: T[] = [];
  let startAt = 0;
  let apiReportedTotal: number | null = null;
  let pagesFetched = 0;

  while (true) {
    const page = await fetchPage(startAt, maxResults);
    pagesFetched++;

    const pageItems = page.values ?? page.issues ?? [];
    items.push(...pageItems);

    // Capture total from first page (if provided)
    if (apiReportedTotal === null && page.total !== undefined) {
      apiReportedTotal = page.total;
    }

    // Termination — ANY condition stops pagination
    if (
      pageItems.length === 0 ||
      page.isLast === true ||
      pageItems.length < maxResults ||
      (apiReportedTotal !== null && items.length >= apiReportedTotal)
    ) {
      break;
    }

    startAt += pageItems.length;
  }

  const totalFetched = items.length;
  const reconciled =
    apiReportedTotal === null ? true : totalFetched === apiReportedTotal;

  return {
    items,
    totalFetched,
    apiReportedTotal,
    pagesFetched,
    reconciled,
    gap: reconciled ? undefined : (apiReportedTotal! - totalFetched),
  };
}
```

### Endpoint-Specific Notes

| Endpoint | Pagination key | `total` field | `isLast` field |
|---|---|---|---|
| `GET /rest/api/3/project/search` | `values` | ✅ `total` | ✅ `isLast` |
| `GET /rest/api/3/field` | N/A — returns flat array | ❌ | ❌ |
| `GET /rest/api/3/issuetype` | N/A — returns flat array | ❌ | ❌ |
| `GET /rest/api/3/workflow/search` | `values` | ✅ `total` | ✅ `isLast` |
| `GET /rest/agile/1.0/board` | `values` | ✅ `total` | ✅ `isLast` |
| `GET /rest/agile/1.0/board/{id}/sprint` | `values` | ✅ `total` | ✅ `isLast` |
| `POST /rest/api/3/search/jql` | `issues` | ✅ `total` | ❌ |

> **Note:** `GET /rest/api/3/field` and `GET /rest/api/3/issuetype` return non-paginated flat arrays. Wrap them in the pagination helper with a single-page adapter (set `apiReportedTotal = items.length` after fetch).

---

## 4. JSM Project-Type Detection and Out-of-Scope Notice Contract

### Detection Rule

During Project discovery (`GET /rest/api/3/project/search`), each returned project is inspected for its `projectTypeKey` field:

| `projectTypeKey` | Phase 1 action |
|---|---|
| `software` | Capture normally |
| `business` | Capture normally |
| `service_desk` | Emit out-of-scope notice; write manifest entry with `status: 'out_of_scope'`, `skipReason: 'jsm_out_of_scope'` |
| Any other value | Log as warning; capture normally (defensive) |

### Out-of-Scope Notice Contract

When one or more `service_desk` projects are detected, the backup engine MUST:

1. Add a manifest entry for each JSM project with `status: 'out_of_scope'` and `skipReason: 'jsm_out_of_scope'`. The project ID and key MUST still appear in the manifest — no silent omission.
2. Include the JSM project in `ReconciliationReport.totalFetched` (it was returned by the API).
3. **NOT** include the JSM project in the Protected Object capture pipeline (Issues are not backed up for `service_desk` projects in Phase 1).
4. Surface a structured notice in the backup job result:

```typescript
export interface JsmOutOfScopeNotice {
  /** Always 'jsm_out_of_scope' */
  type: 'jsm_out_of_scope';
  /** Number of service_desk projects detected */
  projectCount: number;
  /** Project keys of affected projects */
  projectKeys: string[];
  /** Message to surface in the UI */
  message: string;
  /** Phase 2 roadmap note */
  phase2Note: string;
}

// Canonical message values:
const JSM_NOTICE_MESSAGE =
  'Jira Service Management projects were detected on this site. ' +
  'JSM objects (JSMTicket, JSMQueue, JSMRequestType, JSMSLAM) are out of scope for Phase 1 backup. ' +
  'These projects are excluded from backup and restore.';

const JSM_NOTICE_PHASE2 =
  'Full JSM backup support is planned for Phase 2. See T1 §1, T3 §3.2.';
```

5. **Never** surface a `service_desk` project as a "missed" project in reconciliation — its `out_of_scope` status is the expected outcome, not an error.

### Onboarding Wizard Integration

The `JsmOutOfScopeNotice` is emitted as a job event during the first backup run (or during a pre-backup discovery scan) and displayed as a persistent informational banner in the Workload Card. The banner:
- Uses an info/warning visual treatment (not an error)
- Lists the affected project keys
- Links to the Phase 2 roadmap item

---

## 5. Custom Field Context Discovery Gate

Custom field context discovery (`GET /rest/api/3/field/{id}/context`) is only called for fields where `custom: true`. System fields (`custom: false`) are never passed to the context endpoint.

```typescript
// Pseudocode for the custom field capture phase
const allFields = await fetchAllFields(); // GET /rest/api/3/field (flat array)

for (const field of allFields) {
  if (!field.custom) {
    // System field — skip context discovery, no manifest entry for context
    continue;
  }
  // Custom field — fetch context
  const contexts = await fetchFieldContexts(field.id); // GET /rest/api/3/field/{id}/context
  // ... write manifest entry
}
```

This rule is a hard constraint (T2 §6 Constraint 7, T3 §4.2). Calling the context endpoint for system fields would return an error and constitutes incorrect API usage.

---

## 6. Phase Halt and Diagnostic Contract

If any capture phase encounters a halting error (API error on a required resource, auth failure, irrecoverable parse error):

1. The engine sets `ManifestEntry.error.halted = true` for the failing entry.
2. The engine sets `PhaseSummary.completed = false` for the current phase.
3. All subsequent phases are written to the manifest with `status: 'error'`, `error.code: 'PHASE_HALTED'`, `error.halted: false` (they were not attempted, not that they individually failed).
4. The backup job status is set to `'halted'` (not `'completed_with_errors'`).
5. The UI surfaces the named diagnostic: `"Backup halted at phase <phase>: <error.message>"`.

**`completed_with_errors`** is used when the job ran all phases but individual items within a phase failed (e.g., one project's WorkflowScheme could not be fetched). The job continues capturing remaining items.

---

## Appendix: Manifest File Storage

The manifest JSON is written to the data plane (SQLite / Postgres) as a single JSON column on a `backup_points` table. The schema for that table is defined in a subsequent migration (`003_backup_points.sql` — Sprint 3 deliverable for the Backend Developer role).

Manifests are **never** stored only in-process memory. A crash mid-backup must leave a partial manifest on disk (written incrementally or at each phase boundary), not silence the failure.
