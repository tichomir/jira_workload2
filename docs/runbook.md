# Operator Runbook — Jira Cloud Backup & Restore

This runbook covers the three most common operational issues:

1. [OAuth Reconnect](#1-oauth-reconnect)
2. [Scope Errors (403 / Insufficient Scope)](#2-scope-errors-403--insufficient-scope)
3. [Restoring a Project in Atlassian's 60-Day Trash Window](#3-restoring-a-project-in-atlantians-60-day-trash-window)

---

## 1. OAuth Reconnect

### When does this happen?

- Atlassian has rotated (invalidated) the refresh token — for example after a Site Admin revokes the OAuth app's access, or after an extended period of inactivity.
- The scope set on the existing token grant no longer matches `JIRA_OAUTH_SCOPES` (e.g. a new required scope was added and the user has not re-consented).
- The credential store contains `null` or an expired `refresh_token` for the site.

The system emits this structured log line when a refresh attempt fails:

```
[jira-oauth] token.refresh.failed cloudId=<cloudId> status=<httpStatus>
```

And the Workload Card in the UI surfaces a red error banner:

```
Connection error — reconnect required
```

---

### Step 1 — Inspect the credential store

Open an SQLite shell against the database file (default: `data/jira.db`):

```sh
sqlite3 data/jira.db
```

Query the credential row for the affected site:

```sql
SELECT
  cloud_id,
  site_url,
  account_id,
  oauth_client_id,
  datetime(access_token_expires_at, 'unixepoch') AS token_expires,
  datetime(updated_at, 'unixepoch') AS last_rotated
FROM jira_credentials
WHERE connector_type = 'jira';
```

**What to look for:**

| Field | Healthy value | Problem signal |
|---|---|---|
| `token_expires` | A future timestamp | Past timestamp — access token is stale |
| `last_rotated` | Within the last 24 h | Old date — refresh has not been completing |
| `refresh_token` | Non-empty string | Empty / null — re-consent required |

> Screenshot placeholder — SQLite query output showing credential row with token\_expires and last\_rotated columns

---

### Step 2 — Trigger a re-consent (OAuth reconnect)

Navigate to the Jira connector settings page in the DCC UI. Click **Reconnect**. This calls:

```
GET /api/jira/oauth/start
```

The backend enforces HTTPS-only for the redirect URI. If your `OAUTH_REDIRECT_URI` env var starts with `http://`, the request returns `400 redirect_uri_must_be_https` and the flow is blocked — update your env config before retrying.

The Atlassian consent screen appears. The authorising account **must hold Site Admin or Atlassian Organization Admin role**. After approval, the callback handler:

1. Exchanges the authorisation code for `access_token` + `refresh_token`.
2. Calls `GET https://api.atlassian.com/oauth/token/accessible-resources` to retrieve the `cloudId`.
3. Calls `GET https://api.atlassian.com/me` to confirm a valid `accountId`.
4. Writes all four values atomically to `jira_credentials` in a single `BEGIN IMMEDIATE` transaction.

Success is confirmed by this log line:

```
[jira-oauth] account verified accountId=<accountId> cloudId=<cloudId>
```

> Screenshot placeholder — Atlassian OAuth consent screen with scope list displayed

---

### Step 3 — Verify the token is live

Run the credential-store query from Step 1 again. Confirm `token_expires` is in the future and `last_rotated` is the current timestamp.

Optionally, trigger a manual backup job and confirm the first heartbeat appears in the SSE stream within 10 seconds:

```
[jira-backup] job.heartbeat jobId=<jobId> progress=<n>
```

---

## 2. Scope Errors (403 / Insufficient Scope)

### When does this happen?

Atlassian returns `HTTP 403` when the access token does not carry a scope required for the operation being performed. This can happen when:

- The OAuth app's scope list in the Atlassian developer console was modified after the initial grant.
- The user consented to an older, narrower scope set.
- A Site Admin reduced the app's allowed scopes in the org's app-management settings.

The system logs:

```
[jira-oauth] request.403 cloudId=<cloudId> path=<path> scope_hint=<scope>
```

The Workload Card error banner shows:

```
Permission error — re-authorise to grant required scopes
```

---

### Required scope set (T2 §4.2.2)

All scopes below are **mandatory**. None are optional.

| Scope | Purpose |
|---|---|
| `read:jira-user` | Read user profiles and account details |
| `read:jira-work` | Read issues, projects, boards, sprints, worklogs |
| `write:jira-work` | Create/update issues, comments, attachments during restore |
| `manage:jira-project` | Create projects and configure project settings during restore |
| `manage:jira-configuration` | Manage workflows, custom fields, field configurations during restore |
| `read:me` | Retrieve the authorising user's `accountId` via `/me` |
| `offline_access` | Obtain a `refresh_token` for unattended backup jobs |

The exact scope string sent in the authorisation URL is:

```
read:jira-user read:jira-work write:jira-work manage:jira-project manage:jira-configuration read:me offline_access
```

---

### Diagnosis steps

**Step 1 — Identify the missing scope**

Check the server logs for the `403` entry. The `scope_hint` field names the scope Atlassian flagged. If the hint is absent, call the Atlassian API directly with the current token to see which scope is missing:

```sh
curl -H "Authorization: Bearer <access_token>" \
     "https://api.atlassian.com/me"
```

A `403` here confirms `read:me` is absent. Repeat for other endpoints as needed.

**Step 2 — Check the Atlassian developer console**

1. Go to `https://developer.atlassian.com/console/myapps/`.
2. Open the app corresponding to `oauth_client_id` in the credential store.
3. Navigate to **Permissions** → **Jira API**.
4. Confirm all seven scopes from the table above are listed and enabled.

> Screenshot placeholder — Atlassian developer console Permissions page showing all seven scopes enabled

**Step 3 — Re-grant via reconnect**

Follow the [OAuth Reconnect](#1-oauth-reconnect) procedure above. On the Atlassian consent screen, the expanded scope list must match all seven scopes. If the consent screen does not show all seven, the app permissions in the developer console were not saved — return to Step 2.

**Step 4 — Confirm scopes on the new token**

Decode the new `access_token` (JWT, base64url):

```sh
echo "<token_payload_segment>" | base64 -d | python3 -m json.tool | grep -A20 '"scope"'
```

Confirm all seven scope strings are present in the decoded payload.

---

## 3. Restoring a Project in Atlassian's 60-Day Trash Window

### Why in-place restore is blocked

When a Jira project is deleted, Atlassian moves it into a **60-day managed trash window**. During this window, the project exists at the original `projectKey` and URL path, but it is in an `archived: true` state — it is not writable through the standard REST API.

Attempting an in-place restore (`destination.type = "original"`) against a trashed project will fail with:

```json
{
  "code": "TRASH_WINDOW_BLOCK",
  "projectKey": "MYPROJ",
  "deletedAt": null,
  "expiresAt": null,
  "guidance": "Use Alternate location restore"
}
```

The server also emits:

```
[jira-restore] trash-window-block project=MYPROJ action=blocked
```

**The correct path is Alternate location restore**, which creates the project under a new key on the same site, independent of the trashed copy.

> Screenshot placeholder — Restore wizard showing the TRASH_WINDOW_BLOCK error banner with "Use Alternate location" guidance

---

### Step-by-step: Alternate location restore

#### Step 1 — Identify the backup point

In the DCC UI, navigate to **Inventory** → select the project → click the most recent backup point. Note the `backupPointId` (format: `bp-<uuid>`).

Alternatively, query the manifest:

```sh
sqlite3 data/jira.db \
  "SELECT id, created_at, project_count FROM backup_points ORDER BY created_at DESC LIMIT 5;"
```

> Screenshot placeholder — Inventory view showing backup point list with timestamps and item counts

---

#### Step 2 — Choose a new project key

The alternate-location restore creates the project under a new `projectKey` on the same Jira site. The key must:

- Be 2–10 uppercase letters.
- Not conflict with any existing (or trashed) project key on the site.

A safe convention is to append `R` or the current date: e.g. `MYPROJ` → `MYPROJR` or `MYPROJ20260503`.

---

#### Step 3 — Open the Restore Wizard

1. From the Inventory view, select the project and click **Restore**.
2. On the **Destination** step, select **Alternate location (same Jira site)**.
3. Enter the new `targetProjectKey` in the field provided.
4. Leave **Conflict mode** as **Skip** (default) unless you intend to override any pre-existing issues at the target key.

> Screenshot placeholder — Restore wizard Destination step with "Alternate location" selected and targetProjectKey field filled in

---

#### Step 4 — Submit the restore job

Click **Start restore**. The wizard calls:

```
POST /restore/jobs
Content-Type: application/json

{
  "sourceBackupPointId": "bp-<uuid>",
  "scope": { "type": "projects", "projectKeys": ["MYPROJ"] },
  "destination": { "type": "alternate", "targetProjectKey": "MYPROJR" },
  "conflictMode": "skip"
}
```

Because the destination is `"alternate"` (not `"original"`), the trash-window check is **skipped** and the job is created immediately.

---

#### Step 5 — Monitor progress

The UI's **Restore progress** panel streams live phase updates via SSE. The restore engine writes objects in strict dependency order:

```
Project → Workflow + WorkflowScheme → CustomField + FieldConfiguration
       → Board → Sprint → Issue body → issue links + comments + attachments
```

Each phase emits a heartbeat every ≤ 10 seconds. If no heartbeat appears for > 20 seconds, the UI surfaces a **Stalled** alert — check server logs for `[jira-restore] worker.error` entries.

> Screenshot placeholder — Restore progress panel showing phase-by-phase status tracker and heartbeat indicator

---

#### Step 6 — Verify the restored project

Once the job reaches `completed` status:

1. Open Jira Cloud in a browser and navigate to the new project key (e.g. `MYPROJR`).
2. Confirm the issue count, board, and sprint structure match the backup-point manifest.
3. If any issues show an ADF media-link warning in the restore report, note that attachment references in issue descriptions may be broken — full rewrite is a Phase 2 item. The warning is surfaced in the restore report automatically; no operator action is required.

---

### What happens to the trashed project?

The trashed project at `MYPROJ` remains in Atlassian's trash window until it is either:

- **Permanently deleted** by a Site Admin via the Atlassian admin UI (irreversible).
- **Automatically purged** after the 60-day window expires.

The DCC connector does not interact with Atlassian's native trash — that integration is deferred to Phase 2. The alternate-location restore creates a fully independent copy.
