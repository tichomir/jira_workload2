# DEMO — Jira Cloud Backup & Restore: End-to-End Walkthrough

_Phase 1 MVP · Operator walkthrough for a first-time user_

This guide walks through the complete operator journey: connecting to a Jira Cloud site,
browsing the Object Explorer, triggering and inspecting a backup, triggering a restore, and
verifying round-trip integrity. Follow the sections in order on a fresh installation.

---

## Prerequisites

- The application is running (see `INSTALL.md` for local dev or container setup).
- You have a Jira Cloud site with **Site Admin** or **Atlassian Organization Admin** access.
- The OAuth app has been registered in the Atlassian Developer Console with all seven
  required scopes (see [Step 1](#1-connect--oauth-3lo-flow) below).

---

## 1. Connect — OAuth 3LO Flow

### 1a. Navigate to the Connector Settings page

Open the DCC UI in your browser (`https://localhost:3000` in local dev). The Workload Card
for Jira Cloud is shown on the main dashboard. Click **Connect Jira Cloud** to start.

![Screenshot 01 — Workload Card showing Connect button and protected object types](docs/img/demo-01-workload-card.png)

> _TODO-screenshot: Capture the Workload Card at `https://localhost:3000`. The card shows
> Issues, Projects, Boards, Sprints as protected object types and the JSM out-of-scope
> notice at the bottom._

The card also displays an explicit notice that **Jira Service Management (JSM)** objects
are out of scope for Phase 1.

---

### 1b. OAuth Authorisation Redirect

Clicking **Connect** calls `GET /api/jira/oauth/start`, which redirects your browser to
the Atlassian authorisation endpoint. The URL includes all seven required scopes:

```
read:jira-user read:jira-work write:jira-work manage:jira-project
manage:jira-configuration read:me offline_access
```

The Atlassian consent screen lists every scope. The authorising account must hold
**Site Admin** or **Atlassian Organization Admin** role — a standard user account will
not have sufficient permissions to complete backup and restore operations.

![Screenshot 02 — Atlassian OAuth consent screen showing all seven scopes](docs/img/demo-02-oauth-consent.png)

> _TODO-screenshot: Capture the Atlassian consent screen at
> `https://auth.atlassian.com/authorize?...`. Ensure all seven scopes are visible in the
> "This app would like to" list._

---

### 1c. Site Picker (Multi-Site Accounts)

After approving consent, the callback handler calls
`GET https://api.atlassian.com/oauth/token/accessible-resources`. If your Atlassian
account has access to multiple sites, the **Site Picker** UI appears and lists them. Select
the target site. If only one site is accessible, it is selected automatically.

![Screenshot 03 — Site Picker UI with site list and auto-select indicator](docs/img/demo-03-site-picker.png)

> _TODO-screenshot: Capture the Site Picker component (`frontend/src/components/SitePicker.tsx`)
> showing at least one site entry with name, URL, and the "Connect this site" button._

On success, the log emits:

```
[jira-oauth] account verified accountId=<accountId> cloudId=<cloudId>
```

The Workload Card transitions from the **Connect** state to a green **Connected** badge.

---

### 1d. What to do if a scope is rejected (403 / Insufficient Scope)

If you see the error banner **"Permission error — re-authorise to grant required scopes"**,
Atlassian returned `HTTP 403` because the access token does not carry all seven scopes.

**Cause:** The OAuth app's Permissions page in the Atlassian Developer Console has missing
or disabled scopes.

**Fix:**
1. Go to `https://developer.atlassian.com/console/myapps/` and open your app.
2. Navigate to **Permissions → Jira API** and enable all seven scopes listed above.
3. Click **Reconnect** on the Workload Card to re-trigger the OAuth flow.
4. On the consent screen, verify all seven scopes appear before approving.

The alternative path is **Manual API Token** (HTTP Basic auth). Click **Connect manually**
on the Workload Card and fill in Site URL, Cloud ID, email, and API token. This path does
not require OAuth app configuration.

---

## 2. Browse the Object Explorer

### 2a. Inventory Sidebar

After a successful backup, navigate to the **Inventory** section. The left sidebar shows
four object types — **Issues** (selected by default), **Projects**, **Boards**, **Sprints**
— each with a count of discovered objects from the most recent backup manifest.

![Screenshot 04 — Inventory sidebar with four object types and per-row counts](docs/img/demo-04-inventory-sidebar.png)

> _TODO-screenshot: Capture `frontend/src/components/InventorySidebar.tsx` rendered with
> counts populated, e.g. "Issues · 1,247", "Projects · 8", "Boards · 12", "Sprints · 34"._

---

### 2b. Issues Table with Dual Status Columns

With **Issues** selected in the sidebar, the main panel shows the Issues table. Column
headers are:

| Column | Description |
|---|---|
| Issue Key | Jira issue key (e.g. `PROJ-123`) — links to the issue card |
| Summary | Issue title text |
| **Issue Status** | The Jira workflow status (e.g. In Progress, Done) |
| Issue Type | Bug, Story, Task, Sub-task, etc. |
| Assignee | Account display name |
| **Status** | Platform backup status (Backed up, Partial, Error) |
| Policy | Backup policy name |
| Last Backup | Timestamp of the most recent successful backup |

Note the distinction between **Issue Status** (Jira's own workflow state) and **Status**
(the platform's backup-health status) — both columns are present simultaneously.

![Screenshot 05 — Issues table showing Issue Status and Status columns side by side](docs/img/demo-05-issues-table.png)

> _TODO-screenshot: Capture `frontend/src/components/IssuesTable.tsx` with at least three
> rows visible, showing distinct values in the "Issue Status" and "Status" columns._

---

### 2c. Global Search

The Global Search bar at the top of the Inventory view accepts free-text queries across
`projectKey`, `projectName`, `boardName`, and `sprintName`. Results are returned as typed
**Protected Object cards** with a coloured type badge (Project / Board / Sprint).

Type `"Sprint 14"` in the search bar and press Enter. Any sprint whose name contains that
string returns as a JiraSprint card showing the sprint state, board name, and parent project.

![Screenshot 06 — Global Search results showing typed Protected Object cards](docs/img/demo-06-global-search.png)

> _TODO-screenshot: Capture `frontend/src/components/GlobalSearchBar.tsx` with at least
> one search result card visible, showing the type badge and object metadata._

---

## 3. Trigger a Backup

### 3a. Start a Backup Job

Navigate to **Backup** in the left navigation and click **Back up now**. This calls:

```
POST /api/jira/backup/start
```

The backup engine discovers projects (scoped to All or Selected based on your workload
config), then runs the context-node capture pipeline in strict dependency order before
capturing Issues and Attachments. The **scopes exercised** are:

- `read:jira-work` — project, issue, board, sprint, worklog discovery
- `read:jira-user` — assignee and watcher account resolution
- `manage:jira-configuration` — workflow and custom field context discovery

---

### 3b. Progress Heartbeat (≤10 s SLO)

The backup job emits a heartbeat event **every ≤10 seconds** over the SSE stream
(`GET /api/jira/jobs/:jobId/events`). The UI displays a live progress bar and the current
phase label (e.g. _Capturing Issues: 342 / 1,247_).

If no heartbeat arrives for **>20 seconds**, the UI surfaces a **Stalled** alert banner.
Check server logs for `[jira-backup] worker.error` entries.

![Screenshot 07 — Backup progress panel showing heartbeat indicator and phase label](docs/img/demo-07-backup-progress.png)

> _TODO-screenshot: Capture the backup progress panel while a backup is in flight. The
> heartbeat timestamp should update; the phase label should show the current step._

---

### 3c. Per-Item Status and "Completed with N errors"

Each issue is tracked individually. If any issue or attachment fails to capture, the job
does **not** report "Completed successfully" — it instead shows:

```
Completed with 3 errors
```

The error count is a link that opens a per-item error list, showing the issue key and the
failure reason for each failed item.

A completely successful backup shows **Completed** with a green status indicator and the
total item count.

---

### 3d. SDI Scan Results on Protected Object Cards

After the backup completes, the post-processing SDI scanner runs automatically. If
sensitive data patterns are detected in attachments or exported content, **regulation tags**
appear on the affected Protected Object cards without requiring any operator action:

- **GDPR** tag — email address or phone number detected
- **PCI DSS** tag — credit card number (Luhn-validated) detected

---

## 4. Inspect a Backup-Point ID

### 4a. Find the Backup Point in the GUI

Every backup job produces a **backup-point ID** in the format `bp-<uuid>`. To find it:

1. Navigate to **Inventory**.
2. Select any object (e.g. a Project or an Issue).
3. The detail panel on the right shows **Last Backup** with the timestamp.
4. Click the timestamp. A popover opens showing the full `backupPointId`, the job
   completion time, the item count, and the backup scope.

![Screenshot 08 — Backup-point popover showing backupPointId, timestamp, and item count](docs/img/demo-08-backup-point-detail.png)

> _TODO-screenshot: Capture the backup-point popover from the Inventory detail panel.
> The `backupPointId` field (e.g. `bp-3f7a1c2e-...`) and timestamp must be visible._

### 4b. Cross-Reference via the Manifest

The backup-point ID is the primary key in the manifest. You can also inspect it directly
in the database:

```sh
sqlite3 data/jira.db \
  "SELECT id, created_at, project_count, issue_count \
   FROM backup_points ORDER BY created_at DESC LIMIT 5;"
```

Every item in the manifest is linked to a `backup_point_id` — one UI click from any issue
card traces back to the backup point that captured it.

---

## 5. Trigger a Restore

### 5a. Open the Restore Wizard

From the Inventory view, select the project or issues you want to restore and click
**Restore**. The Restore Wizard opens with three steps:

1. **Conflict Mode** — how to handle objects that already exist at the destination
2. **Destination** — where to write the restored objects
3. **Confirm** — review the restore scope and start the job

![Screenshot 09 — Restore Wizard step 1: Conflict Mode selection](docs/img/demo-09-restore-wizard-conflict.png)

> _TODO-screenshot: Capture `frontend/src/components/RestoreWizard.tsx` on Step 1, showing
> the three conflict mode radio buttons with "Skip" selected (the default)._

---

### 5b. Conflict Modes

| Mode | Behaviour |
|---|---|
| **Skip** (default) | Objects that already exist at the destination are left unchanged; only missing objects are written. |
| **Override** | Existing objects at the destination are overwritten with the backed-up versions. |
| **Ask per conflict** | The wizard pauses on each conflicting object and prompts the operator to choose Skip or Override individually. |

Select the mode appropriate for your situation. **Skip** is the recommended default for
most recovery scenarios to avoid unintended overwrites.

---

### 5c. Destination Options

| Option | Description |
|---|---|
| **Original location** | Restore to the same project key and site the backup was taken from. Blocked if the project is in Atlassian's 60-day trash window. |
| **Alternate location (same Jira site)** | Restore to a new project key on the same site. Required when the original is in the trash window. |
| **Browser Download** | Export the backup data as a ZIP archive for offline inspection or manual import. No Jira API writes occur. |

![Screenshot 10 — Restore Wizard step 2: Destination selection with Alternate location option](docs/img/demo-10-restore-wizard-destination.png)

> _TODO-screenshot: Capture the Restore Wizard Destination step showing the three options
> and the `targetProjectKey` input field visible when "Alternate location" is selected._

---

### 5d. Trash-Window Block and Alternate-Location Guidance

If you select **Original location** for a project that is currently in Atlassian's 60-day
trash window, the wizard surfaces a block banner:

```
TRASH_WINDOW_BLOCK — This project is in Atlassian's managed trash.
In-place restore is not available. Select Alternate location to create
a new copy under a different project key on the same site.
```

The block is enforced by `TrashWindowChecker.ts` before the restore job is created.
The server logs:

```
[jira-restore] trash-window-block project=MYPROJ action=blocked
```

Switch to **Alternate location**, enter a new project key (2–10 uppercase letters, not
already in use), and proceed. The trashed project is unaffected.

![Screenshot 11 — Restore Wizard showing TRASH_WINDOW_BLOCK banner with Alternate location guidance](docs/img/demo-11-trash-window-block.png)

> _TODO-screenshot: Capture the trash-window block banner in the Restore Wizard. The error
> message, the "Use Alternate location" guidance text, and the disabled "Start restore"
> button should all be visible._

---

### 5e. Dependency Ordering in the Restore Engine

Once the job starts, the **Restore Progress** panel shows the phases executing in strict
dependency order:

```
1. Project
2. Workflow + WorkflowScheme
3. CustomField + FieldConfiguration
4. Board
5. Sprint
6. Issue body
7. Issue links + Comments + Attachments (post-issue-creation pass)
```

Each phase emits a heartbeat every ≤10 seconds. A phase failure halts execution
immediately and surfaces a named diagnostic (e.g. `PHASE_FAILED: Board — 403 Insufficient Scope`)
before the next phase begins. No subsequent phases are attempted after a halt.

---

### 5f. ADF Media Link Warning

After attachment restore completes, restored attachments receive **new `attachmentId`
values** in Jira. Any `media` nodes in issue descriptions or comments that referenced the
original attachment IDs may render as broken media links in Jira's Atlassian Document
Format (ADF) editor.

The restore report automatically surfaces a warning:

```
ADF media links may be broken for N issues. Full rewrite is a Phase 2 item.
```

No operator action is required. The issues and their content are fully restored; only
inline media previews within the ADF description/comment body may be affected.

---

## 6. Verify Integrity — Round-Trip Check

### 6a. Confirm Issue Count and Field Values

After the restore job reaches `completed`:

1. Open Jira Cloud and navigate to the restored project.
2. Open several issues and verify:
   - All **system fields** are present (Summary, Description, Status, Priority, Assignee,
     Reporter, Labels, Fix Version, Components).
   - All **custom field values** are populated — no empty custom fields that had values
     in the original.
   - All **comments** are present with the original author name and timestamp.
   - All **issue links** (both directions) are restored.
   - **Sprint membership** is correct.
   - **Attachments** are downloadable and byte-identical to the originals.

### 6b. Cross-Reference Against the Manifest

The backup manifest records every captured issue, board, sprint, and attachment. Use the
backup-point ID from [Section 4](#4-inspect-a-backup-point-id) to query:

```sh
sqlite3 data/jira.db \
  "SELECT object_type, COUNT(*) as count \
   FROM manifest_entries \
   WHERE backup_point_id = 'bp-<your-id>' \
   GROUP BY object_type;"
```

Compare the counts against what Jira reports in the restored project. Every row in
`manifest_entries` should have a corresponding object in Jira after a successful restore.

### 6c. Attachment SHA-256 Fidelity

For binary attachment verification, the backup stores the original SHA-256 hash alongside
each attachment in the blob store. Download the same file from the restored Jira issue and
compare:

```sh
# Hash the downloaded file
sha256sum ~/Downloads/my-attachment.pdf

# Query the stored hash from the manifest
sqlite3 data/jira.db \
  "SELECT filename, sha256 FROM manifest_entries \
   WHERE object_type = 'attachment' AND backup_point_id = 'bp-<your-id>' \
   AND filename = 'my-attachment.pdf';"
```

A matching hash confirms **binary-faithful** restore — byte-for-byte, original MIME type,
original filename, no transcoding.

---

## Screenshot Summary

| # | File path | Section | Status |
|---|---|---|---|
| 01 | `docs/img/demo-01-workload-card.png` | Connect — Workload Card | TODO-screenshot |
| 02 | `docs/img/demo-02-oauth-consent.png` | Connect — Atlassian consent screen | TODO-screenshot |
| 03 | `docs/img/demo-03-site-picker.png` | Connect — Site Picker | TODO-screenshot |
| 04 | `docs/img/demo-04-inventory-sidebar.png` | Browse — Inventory sidebar | TODO-screenshot |
| 05 | `docs/img/demo-05-issues-table.png` | Browse — Issues table dual columns | TODO-screenshot |
| 06 | `docs/img/demo-06-global-search.png` | Browse — Global Search results | TODO-screenshot |
| 07 | `docs/img/demo-07-backup-progress.png` | Backup — progress heartbeat panel | TODO-screenshot |
| 08 | `docs/img/demo-08-backup-point-detail.png` | Backup-point ID — detail popover | TODO-screenshot |
| 09 | `docs/img/demo-09-restore-wizard-conflict.png` | Restore — conflict mode step | TODO-screenshot |
| 10 | `docs/img/demo-10-restore-wizard-destination.png` | Restore — destination step | TODO-screenshot |
| 11 | `docs/img/demo-11-trash-window-block.png` | Restore — trash-window block banner | TODO-screenshot |

All `docs/img/demo-NN-*.png` paths are reserved for operator-captured screenshots. The
surrounding prose is operator-ready; replace the TODO-screenshot notes with actual captures
before publishing to end users.

---

## Related Documentation

- `INSTALL.md` — Prerequisites, local dev setup, container deployment
- `ARCHITECTURE.md` — Component map, data flow, key invariants
- `CHANGELOG.md` — Version history and breaking changes
