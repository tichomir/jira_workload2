# Inventory UI Architecture & Data Contracts
_Sprint 9 — Protected Object Inventory & Browse UI (Phase 5, Sprint 1 of 2)_
_Status: APPROVED for implementation_

---

## 1. Overview

The Inventory UI consists of three interconnected surfaces:

1. **Sidebar** — four object-type rows (Issues, Projects, Boards, Sprints) each showing a live count from the most recent backup manifest.
2. **Issues table** — paginated browse view with nine columns distinguishing Jira workflow status from platform protection status.
3. **Global Search** — cross-entity search over projectKey/projectName/boardName/sprintName returning typed Protected Object cards.

All three surfaces are read-only in Phase 1. Restore is initiated from the Protected Object card (restore-unit design pending — see §6 Open Contracts).

---

## 2. Sidebar Component

### 2.1 Shape

```typescript
/** One row in the Inventory sidebar. */
export interface SidebarObjectTypeRow {
  /** Internal discriminant used for routing and selection state. */
  objectType: 'JiraIssue' | 'JiraProject' | 'JiraBoard' | 'JiraSprint';
  /** Human-readable label shown in the sidebar. */
  label: 'Issues' | 'Projects' | 'Boards' | 'Sprints';
  /** Count of captured objects from the most-recent completed backup point. */
  count: number;
  /** True while the manifest count is being loaded. */
  loading: boolean;
}
```

Fixed ordering: Issues → Projects → Boards → Sprints. **Issues is the default selected row** on first load (T8 §3).

### 2.2 Manifest Fields Consumed for Counts

The sidebar mapper reads `BackupPointManifest.phaseSummary` (type `Record<CapturePhase, PhaseSummary>`), extracting the `successCount` field for the phases that correspond to each sidebar row:

| Sidebar row | `CapturePhase` key | `JiraObjectType` filter |
|---|---|---|
| Issues | `'issue'` | `'JiraIssue'` |
| Projects | `'project'` | `'JiraProject'` |
| Boards | `'board'` | `'JiraBoard'` |
| Sprints | `'sprint'` | `'JiraSprint'` |

**Source fields used:** `phaseSummary[phase].successCount` for the count. The mapper ignores `errorCount` and `skippedCount` for the sidebar badge — these are surfaced in the detail view, not the sidebar row.

**Fallback:** when no completed backup point exists, count renders as `—` (em-dash), not `0`.

### 2.3 Mapper Function Contract

```typescript
/**
 * Derives the four sidebar rows from the most-recent completed manifest.
 * Returns rows with count=0 and loading=false when manifest is null.
 */
function buildSidebarRows(
  manifest: BackupPointManifest | null
): SidebarObjectTypeRow[];
```

The function is pure (no side effects). It is called by the sidebar component after the manifest is fetched from `GET /api/backup-points/latest`.

---

## 3. Issues Table Data Contract

### 3.1 Row Schema

```typescript
/**
 * One row in the Issues inventory table.
 *
 * COLUMN SEMANTICS (critical — two "status" concepts coexist):
 *
 * issueStatus  — the Jira workflow status of the issue at time of backup
 *                (e.g. "In Progress", "Done").  Source: issue.fields.status.name.
 *                Column header label: "Issue Status".
 *
 * platformStatus — the DCC platform's protection status for this object
 *                  (e.g. "Protected", "Error", "Pending").
 *                  Derived from SimpleManifestEntry.status ('ok' | 'error').
 *                  Column header label: "Status".
 *
 * These two fields MUST NOT be conflated. See §3.2 for disambiguation rules.
 */
export interface IssueTableRow {
  // --- Jira fields (from ManifestEntry.data) ---

  /** Jira issue key, e.g. "PROJ-123". Column header: "Issue Key". */
  issueKey: string;

  /** Issue summary text. Column header: "Summary". */
  summary: string;

  /**
   * Jira workflow status name at time of backup, e.g. "In Progress".
   * Source: issue.fields.status.name
   * Column header: "Issue Status"   ← NOT "Status"
   */
  issueStatus: string;

  /** Issue type name, e.g. "Story", "Bug". Column header: "Issue Type". */
  issueType: string;

  /** Assignee display name. Null when unassigned. Column header: "Assignee". */
  assigneeDisplayName: string | null;

  // --- Platform fields (from SimpleManifestEntry) ---

  /**
   * DCC platform protection status derived from SimpleManifestEntry.status.
   *   'ok'    → 'Protected'
   *   'error' → 'Error'
   * Column header: "Status"   ← NOT "Issue Status"
   */
  platformStatus: 'Protected' | 'Error';

  /**
   * Backup policy name applied to this object's project (from workload config).
   * Column header: "Policy".
   */
  policy: string;

  /**
   * ISO 8601 timestamp of the backup point that captured this issue.
   * Source: SimpleManifestEntry.capturedAt (Unix epoch ms → ISO string).
   * Column header: "Last Backup".
   */
  lastBackupAt: string;

  /** backupPointId for single-click traceability. Used by detail/restore link. */
  backupPointId: string;

  /** SDI regulation tags if present; empty array otherwise. */
  regulationTags: string[];
}
```

### 3.2 'Issue Status' vs 'Status' — Disambiguation Rules

| Concept | Field | Source | Column Header | Example values |
|---|---|---|---|---|
| Jira workflow state | `issueStatus` | `issue.fields.status.name` in Jira API response | **"Issue Status"** | "To Do", "In Progress", "Done" |
| DCC platform protection state | `platformStatus` | `SimpleManifestEntry.status` | **"Status"** | "Protected", "Error" |

**Rendering rule:** The column header string `"Issue Status"` must never be abbreviated to `"Status"` in any UI element (header, tooltip, filter label, aria-label). The column header string `"Status"` refers exclusively to the platform protection status.

### 3.3 Column Ordering

1. Issue Key
2. Summary
3. Issue Status *(Jira workflow)*
4. Issue Type
5. Assignee
6. Status *(platform protection)*
7. Policy
8. Last Backup

### 3.4 Issues Table API Endpoint Contract

```
GET /api/inventory/issues
  ?backupPointId=<id>        // required; targets specific backup point
  &issueStatus=<name>        // filter: Jira workflow status
  &issueType=<name>          // filter: issue type
  &priority=<name>           // filter: Jira priority
  &assigneeAccountId=<id>    // filter: assignee accountId
  &labels=<csv>              // filter: comma-separated label names
  &updatedFrom=<ISO date>    // filter: updated >= date
  &updatedTo=<ISO date>      // filter: updated <= date
  &q=<string>                // Project Inventory Search: issueKey exact OR tokenised summary
  &limit=<int>               // pagination; default 50, max 100
  &offset=<int>              // pagination offset
```

Response:

```typescript
interface IssueInventoryResponse {
  items: IssueTableRow[];
  total: number;
  backupPointId: string;
  backupPointTimestamp: string;
}
```

---

## 4. Global Search Index Contract

### 4.1 Index Shape

Global Search operates over a denormalised in-memory index built from the latest completed manifest. The index is rebuilt whenever a new completed backup point is recorded.

```typescript
/** One entry in the Global Search index. */
export interface GlobalSearchIndexEntry {
  /** Discriminates the Protected Object type for card rendering. */
  objectType: 'JiraProject' | 'JiraBoard' | 'JiraSprint' | 'JiraIssue';

  /** Unique object ID (projectId, boardId, sprintId, or issueId). */
  objectId: string;

  // --- Searchable text fields ---
  /** Jira project key (present on JiraProject; also carried on boards/sprints for context). */
  projectKey?: string;
  /** Full project name. */
  projectName?: string;
  /** Board name (present on JiraBoard). */
  boardName?: string;
  /** Sprint name (present on JiraSprint). */
  sprintName?: string;

  // --- Display fields for the result card ---
  /** Display label shown in the search result card. */
  displayName: string;
  /** Secondary context line (e.g. "Project: PROJ" for a board row). */
  contextLine?: string;

  // --- Traceability ---
  backupPointId: string;
  backupPointTimestamp: string;
}
```

### 4.2 Search Contract

```typescript
/**
 * Tokenised substring match across all indexed text fields.
 * All query tokens must match at least one searchable field (AND semantics).
 * Matching is case-insensitive.
 *
 * Returns at most `limit` results, sorted by objectType (Projects first,
 * then Boards, Sprints, Issues) then alphabetically by displayName.
 */
function searchInventory(
  index: GlobalSearchIndexEntry[],
  query: string,
  limit?: number  // default 20
): GlobalSearchIndexEntry[];
```

### 4.3 Searchable Fields per Object Type

| Object Type | Searchable fields |
|---|---|
| JiraProject | `projectKey`, `projectName` |
| JiraBoard | `boardName`, `projectKey`, `projectName` |
| JiraSprint | `sprintName`, `boardName`, `projectKey` |
| JiraIssue | `issueKey`, `summary` (via Project Inventory Search, not Global Search) |

> Note: JiraIssue records are NOT included in the Global Search index. Issue search is scoped to Project Inventory Search (GET /api/inventory/issues?q=) which supports issueKey exact match and tokenised summary search.

### 4.4 Search API Endpoint Contract

```
GET /api/inventory/search
  ?q=<string>     // required; min 1 char
  &limit=<int>    // default 20, max 50
```

Response:

```typescript
interface GlobalSearchResponse {
  results: GlobalSearchIndexEntry[];
  query: string;
  total: number;
}
```

---

## 5. Manifest-to-UI Mapper Summary

All three surfaces share a single manifest fetch. The `InventoryDataMapper` service:

1. Fetches `GET /api/backup-points/latest` (returns `BackupPointManifest`).
2. Derives sidebar counts from `phaseSummary` (§2.2).
3. Builds the `GlobalSearchIndexEntry[]` index from `entries` where `status === 'success'` (§4).
4. Exposes `IssueTableRow[]` via the paginated Issues endpoint backed by `manifest_entries` table (§3.4).

The mapper enforces: **a manifest entry with `status === 'error'` maps to `platformStatus: 'Error'`; a manifest entry with `status === 'success'` maps to `platformStatus: 'Protected'`.**

---

## 6. Open Contracts (Blockers for Sprint 2)

### OC-001 — Figma Spec: Restore-Unit Card Design
**Status:** OPEN  
**Blocking:** Restore button affordance on Protected Object cards (Issues, Projects, Boards, Sprints). Without the Figma frame, implementers must not invent a layout — build conservatively to acceptance-criteria text and flag in sprint 2 review.  
**Owner:** Design  
**Required by:** Sprint 10 (Phase 5, Sprint 2 of 2)  
**Detail:** The restore-unit card needs to show: object type badge, display name, backup point timestamp, conflict mode selector (Override / Skip / Ask), destination selector (Original location / Alternate location / Export). Per T5 §5.1, Skip is the default conflict mode.

### OC-002 — Figma Spec: Board/Sprint Sidebar Filters
**Status:** OPEN  
**Blocking:** Filter panel for Boards and Sprints in the sidebar detail view. Phase 1 ships Issues filters (status, issueType, priority, assigneeAccountId, labels, updated date range). Board/Sprint filter UI shape is not yet specced.  
**Owner:** Design  
**Required by:** Sprint 10 (Phase 5, Sprint 2 of 2)  
**Detail:** Minimum required: board name search, sprint state filter (active/closed/future), associated project selector.

---

## 7. Component Tree (Reference)

```
InventoryView
├── InventorySidebar
│   ├── SidebarRow (Issues) [default selected]
│   ├── SidebarRow (Projects)
│   ├── SidebarRow (Boards)
│   └── SidebarRow (Sprints)
├── InventoryMainPanel
│   ├── GlobalSearchBar              ← queries /api/inventory/search
│   ├── IssuesTable                  ← queries /api/inventory/issues
│   │   ├── IssuesTableHeader
│   │   │   └── columns: IssueKey | Summary | IssueStatus | IssueType |
│   │   │                Assignee | Status | Policy | LastBackup
│   │   ├── IssuesTableRow (×N)
│   │   └── IssuesPagination
│   └── IssuesFilterPanel
│       ├── StatusFilter             (issueStatus — Jira workflow)
│       ├── IssueTypeFilter
│       ├── PriorityFilter
│       ├── AssigneeFilter
│       ├── LabelsFilter
│       └── UpdatedDateRangeFilter
└── GlobalSearchResultsOverlay       ← rendered over main panel on query
    └── SearchResultCard (×N)        ← typed: Project | Board | Sprint
```

---

_End of document. Reviewed against T8 §2–§3, T5 §5.1–§5.2, engineering coding standards._
