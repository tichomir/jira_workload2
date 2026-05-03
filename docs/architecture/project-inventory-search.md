# Project Inventory Search & Filter Contract
_Sprint 10 — Protected Object Inventory & Browse UI (Phase 5, Sprint 2 of 2)_
_Status: APPROVED for implementation_

---

## 1. Overview

Project Inventory Search is the in-table search and filter surface for the Issues view. It operates on the `manifest_entries` table for a specific backup point and project scope. It is distinct from **Global Search** (cross-entity, `GET /api/inventory/search`) — Global Search does not index Issues; Project Inventory Search does.

The search surface supports two complementary input modes that are combined with filters via AND logic:

- **issueKey exact match** — detected by regex, short-circuits to a direct row lookup.
- **Tokenised summary search** — whitespace-split, case-insensitive AND-of-tokens substring match against the issue summary field.

---

## 2. Search Mode Detection

### 2.1 issueKey Exact-Match

An issueKey pattern is detected using the following regex applied to the trimmed `q` parameter:

```
/^[A-Z][A-Z0-9]+-\d+$/
```

**Semantics:**
- First character: uppercase ASCII letter `[A-Z]`
- Remaining key characters before the dash: one or more uppercase letters or digits `[A-Z0-9]+`
- Dash separator: `-`
- Issue number: one or more digits `\d+`

**Examples of matching values:** `PROJ-1`, `AB-123`, `JIRA-4567`, `X9Y-10`
**Examples of non-matching values:** `proj-1` (lowercase), `PROJ-`, `PROJ`, `123-PROJ`

**Behaviour when matched:** The search short-circuits to a **direct key lookup** against `manifest_entries.data->>'issueKey'`. No tokenisation is performed. Returns 0 or 1 result. Active filters (§4) are still applied as AND conditions.

### 2.2 Tokenised Summary Search

When the `q` parameter is present but does **not** match the issueKey regex, tokenised summary search is used.

**Tokenisation:**
- Split `q` on one or more whitespace characters (`\s+`).
- Discard empty tokens (result of leading/trailing whitespace after split).
- Minimum 1 token after discarding.

**Match semantics:**
- **AND-of-tokens**: all tokens must match.
- **Case-insensitive substring**: each token is matched via `LOWER(summary) LIKE '%' || LOWER(token) || '%'` (or equivalent in-process string containment check).
- A summary matches if and only if **every** token appears as a substring within it (case-insensitively).

**Example:**

| `q` | Tokens | Matches summary |
|---|---|---|
| `"login bug"` | `["login", "bug"]` | `"Fix login bug on mobile"` ✓ |
| `"login bug"` | `["login", "bug"]` | `"Bug report: login screen"` ✓ |
| `"login bug"` | `["login", "bug"]` | `"Fix login screen"` ✗ (missing "bug") |
| `"  Login  "` | `["Login"]` | `"login page crash"` ✓ |

### 2.3 No `q` Parameter

When `q` is absent or an empty string, no search predicate is applied. All issues for the scoped backup point and project are returned, subject only to active filters (§4) and pagination (§5).

---

## 3. Filter Schema

Filters are applied as additional AND conditions on top of any search predicate.

| Filter | Query Param | Type | Source Field | Match Semantics |
|---|---|---|---|---|
| Jira workflow status | `issueStatus` | `string` (single value) | `manifest_entries.data->>'status'` (Jira status name) | Case-insensitive exact match |
| Issue type | `issueType` | `string` (single value) | `manifest_entries.data->>'issueType'` | Case-insensitive exact match |
| Priority | `priority` | `string` (single value) | `manifest_entries.data->>'priority'` | Case-insensitive exact match |
| Assignee | `assigneeAccountId` | `string` (single value) | `manifest_entries.data->>'assigneeAccountId'` | Exact match (account IDs are opaque strings) |
| Labels | `labels` | `string` (comma-separated) | `manifest_entries.data->'labels'` (JSON array) | Multi-select OR within labels, AND with other filters: issue must carry **at least one** of the specified labels |
| Updated from | `updatedFrom` | ISO 8601 date string | `manifest_entries.data->>'updated'` | `updated >= updatedFrom` (inclusive) |
| Updated to | `updatedTo` | ISO 8601 date string | `manifest_entries.data->>'updated'` | `updated <= updatedTo` (inclusive) |

### 3.1 `labels` Filter Detail

The `labels` parameter accepts a comma-separated list of label names:

```
GET /api/inventory/projects/PROJ/issues?labels=frontend,mobile
```

An issue matches if its `labels` JSON array contains **at least one** of `["frontend", "mobile"]`. Label matching is case-insensitive.

### 3.2 Date Range Filter Detail

Both `updatedFrom` and `updatedTo` accept ISO 8601 date strings (date-only `YYYY-MM-DD` or datetime `YYYY-MM-DDTHH:mm:ssZ`). When only one bound is provided, the range is open-ended on the other side. When both are provided, the range is inclusive on both ends.

---

## 4. Query Parameter Shape

```
GET /api/inventory/projects/{projectKey}/issues
  ?backupPointId=<string>        // required; scopes results to a specific backup point
  &q=<string>                    // optional; issueKey exact-match OR tokenised summary search
  &issueStatus=<string>          // optional filter
  &issueType=<string>            // optional filter
  &priority=<string>             // optional filter
  &assigneeAccountId=<string>    // optional filter
  &labels=<csv>                  // optional filter; comma-separated label names
  &updatedFrom=<ISO date>        // optional filter; inclusive lower bound on updated timestamp
  &updatedTo=<ISO date>          // optional filter; inclusive upper bound on updated timestamp
  &limit=<int>                   // pagination; default 50, max 100
  &offset=<int>                  // pagination; default 0
```

Path parameter `{projectKey}` scopes all results to issues belonging to that project (matched against `manifest_entries.data->>'projectKey'`).

`backupPointId` is **required**. Requests without it return `HTTP 400`.

### 4.1 Response Shape

```typescript
interface ProjectIssueInventoryResponse {
  items: IssueTableRow[];           // see inventory-ui.md §3.1
  total: number;                    // total matching count (before pagination)
  backupPointId: string;
  backupPointTimestamp: string;     // ISO 8601
  projectKey: string;
  appliedFilters: {                 // echo of active filters for client-side state
    q?: string;
    issueStatus?: string;
    issueType?: string;
    priority?: string;
    assigneeAccountId?: string;
    labels?: string[];
    updatedFrom?: string;
    updatedTo?: string;
  };
  pagination: {
    limit: number;
    offset: number;
  };
}
```

---

## 5. Search + Filter Interaction (AND)

All active predicates (search and filters) are combined with **AND** logic:

```
result_set = issues WHERE
  projectKey = {projectKey}
  AND backupPointId = {backupPointId}
  [AND issueKey = {q}]              -- if q matches issueKey regex
  [AND summary contains all tokens] -- if q present and not issueKey
  [AND issueStatus = ...]
  [AND issueType = ...]
  [AND priority = ...]
  [AND assigneeAccountId = ...]
  [AND labels contains any of ...]
  [AND updated >= updatedFrom]
  [AND updated <= updatedTo]
```

There is no OR across search and filters. A narrower query always produces a subset of a broader query.

---

## 6. Pagination Contract

- `limit` — number of results per page. Default: `50`. Maximum enforced server-side: `100`. Values above 100 are clamped to 100.
- `offset` — zero-based index of the first result to return. Default: `0`.
- `total` in the response reflects the total count of matching results **before** pagination is applied. This allows the client to derive page count as `Math.ceil(total / limit)`.
- An `offset` beyond the total result count returns an empty `items` array with `total` reflecting the actual match count.

---

## 7. Integration Points

- **Issues Table component** (`frontend/src/components/IssuesTable.tsx`) — drives `q`, filter, and pagination params from local component state. Re-fetches on any param change.
- **IssuesFilterPanel** — renders filter controls; each change updates the URL query string and triggers a re-fetch.
- **InventoryRouter** (`src/inventory/InventoryRouter.ts`) — implements this endpoint. Delegates search/filter evaluation to a `ProjectIssueSearchService` that queries `manifest_entries` via SQLite.
- **BackupPointManifestWriter** — writes the `data` JSON blob per entry; the search surface reads from this. No runtime dependency on the writer.

---

## 8. Error Responses

| Condition | HTTP Status | Error Code |
|---|---|---|
| `backupPointId` missing | 400 | `MISSING_BACKUP_POINT_ID` |
| `backupPointId` not found | 404 | `BACKUP_POINT_NOT_FOUND` |
| `{projectKey}` has no issues in this backup point | 200 | *(empty `items`, `total: 0`)* |
| `updatedFrom`/`updatedTo` not valid ISO date | 400 | `INVALID_DATE_FILTER` |
| `limit` < 1 | 400 | `INVALID_PAGINATION` |

---

_End of document. Reviewed against T8 §3, inventory-ui.md §3.4, engineering coding standards._
