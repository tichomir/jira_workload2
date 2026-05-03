# INSTALL — Jira Cloud Backup & Restore Connector

This document covers all three runtime variants end-to-end:

1. [Prerequisites](#1-prerequisites)
2. [Local Development](#2-local-development)
3. [Container Deployment](#3-container-deployment)
4. [Operations](#4-operations)

---

## 1. Prerequisites

| Requirement | Minimum version | Notes |
|---|---|---|
| Node.js | 20 LTS | Backend runtime |
| npm | 10+ | Bundled with Node 20 |
| Podman | 4.0+ | Docker CLI-compatible; swap `podman` ↔ `docker` as needed |
| mkcert | 1.4+ | Local HTTPS certificate generation (local dev only) |
| SQLite | 3.x | Bundled via `better-sqlite3`; no separate install required |

Atlassian Developer account with Site Admin or Atlassian Organization Admin role
on the target Jira Cloud site is required for the OAuth consent step.

---

## 2. Local Development

### 2.1 Clone and install

```sh
git clone <repo-url> jira_workload_2
cd jira_workload_2
npm install
cd frontend && npm install && cd ..
```

### 2.2 Generate HTTPS certificates (required)

Atlassian's OAuth 2.0 (3LO) flow rejects HTTP redirect URIs — HTTPS is mandatory.
Use mkcert to create a locally-trusted certificate:

```sh
# Install the local CA once (system-wide trust)
mkcert -install

# Generate certs for localhost
mkcert localhost 127.0.0.1
```

This creates `localhost+1.pem` (certificate) and `localhost+1-key.pem` (private key)
in the current directory. Reference them in your env vars (see §2.4).

### 2.3 Create an OAuth app in the Atlassian Developer Console

1. Go to `https://developer.atlassian.com/console/myapps/` and click **Create**.
2. Choose **OAuth 2.0 (3LO)** as the app type.
3. Under **Permissions → Jira API**, add ALL of the following scopes — every scope is
   mandatory; none are optional:

   | Scope | Purpose |
   |---|---|
   | `read:jira-user` | Read user profiles and account details |
   | `read:jira-work` | Read issues, projects, boards, sprints, worklogs |
   | `write:jira-work` | Create/update issues, comments, attachments during restore |
   | `manage:jira-project` | Create projects and configure project settings during restore |
   | `manage:jira-configuration` | Manage workflows, custom fields, field configurations during restore |
   | `read:me` | Retrieve the authorising user's `accountId` via `/me` |
   | `offline_access` | Obtain a `refresh_token` for unattended backup jobs |

4. Under **Authorization → OAuth 2.0 (3LO)**, set the callback URL to:
   ```
   https://localhost:3000/api/jira/oauth/callback
   ```
5. Copy the **Client ID** and **Client Secret** — you will need them in §2.4.

### 2.4 Environment variables

Copy the example file and edit it:

```sh
cp .env.example .env
```

#### Required env vars

| Variable | Description | Example |
|---|---|---|
| `JIRA_OAUTH_CLIENT_ID` | OAuth app Client ID from Atlassian Developer Console | `abcdef123456` |
| `JIRA_OAUTH_CLIENT_SECRET` | OAuth app Client Secret | `secret_xyz` |
| `OAUTH_REDIRECT_URI` | Must match the callback URL registered in the console | `https://localhost:3000/api/jira/oauth/callback` |
| `DATABASE_URL` | Path to the SQLite database file | `data/jira.db` |
| `TLS_CERT` | Path to the mkcert-generated certificate | `localhost+1.pem` |
| `TLS_KEY` | Path to the mkcert-generated private key | `localhost+1-key.pem` |
| `PORT` | HTTP/HTTPS port the backend listens on | `3000` |

#### Optional env vars

| Variable | Description | Default |
|---|---|---|
| `LOG_LEVEL` | Log verbosity (`debug`, `info`, `warn`, `error`) | `info` |
| `HEARTBEAT_INTERVAL_MS` | Backup/restore heartbeat interval in milliseconds | `8000` |
| `STALL_THRESHOLD_MS` | Time without heartbeat before a "stalled" alert fires | `20000` |

### 2.5 Start the development stack

```sh
# Build the TypeScript backend
npm run build

# Start backend (from project root)
node dist/server.js

# In a second terminal — start frontend dev server
cd frontend && npm run dev
```

The app is available at `https://localhost:3000`.

To run all backend tests:
```sh
npm test
```

To run end-to-end Playwright tests:
```sh
npm run test:e2e
```

---

## 3. Container Deployment

### 3.1 Runtime topology

The production-parity stack runs two containers:

| Container | Image | Role |
|---|---|---|
| `jira-backup-app` | Node 20 image built from `Dockerfile` | Backend API + static frontend |
| `caddy` | `caddy:2-alpine` | HTTPS termination, reverse proxy |

Persistent volumes:
- `jira-data` — SQLite database (`jira.db`), credential store, backup manifests
- `jira-attachments` — binary attachment blobs

### 3.2 Build and start

```sh
# Build the app image
podman build -t jira-backup-app:latest .

# Start the full stack
podman-compose up -d

# Check logs
podman-compose logs -f
```

### 3.3 Environment variables (container)

Set these in a `.env` file at the project root (read by `podman-compose.yml`) or
pass them via your container orchestration secrets mechanism.

| Variable | Description |
|---|---|
| `JIRA_OAUTH_CLIENT_ID` | OAuth app Client ID |
| `JIRA_OAUTH_CLIENT_SECRET` | OAuth app Client Secret |
| `OAUTH_REDIRECT_URI` | Must be an `https://` URI; must match the Atlassian console registration |
| `DATABASE_URL` | Absolute path inside the container, e.g. `/data/jira.db` |
| `PORT` | App port (Caddy proxies to this; default `3000`) |
| `LOG_LEVEL` | Log verbosity |
| `HEARTBEAT_INTERVAL_MS` | Heartbeat interval (default `8000`) |
| `STALL_THRESHOLD_MS` | Stall threshold (default `20000`) |

### 3.4 Caddy HTTPS configuration

The `Caddyfile` at the project root configures HTTPS termination.
Update the `your-domain.example.com` placeholder to your actual domain:

```
your-domain.example.com {
    reverse_proxy jira-backup-app:3000
}
```

Caddy automatically provisions a Let's Encrypt certificate for the domain.
For self-hosted environments without public DNS, use a local CA or supply
your own certificate via Caddy's `tls` directive.

### 3.5 Persistent volumes

The `podman-compose.yml` mounts two named volumes:

```yaml
volumes:
  jira-data:       # /data inside the container — DB + manifests
  jira-attachments: # /attachments — binary blob store
```

Back up these volumes as part of your standard infrastructure backup strategy.

---

## 4. Operations

### 4.1 Log locations

All structured log output goes to **stdout** in the format:

```
[namespace] event key=value key=value ...
```

Key log namespaces:

| Namespace | Source |
|---|---|
| `[jira-oauth]` | OAuth flow, token refresh, re-consent events |
| `[jira-http]` | HTTP request/response, token refresh outcome |
| `[jira-backup]` | Backup job lifecycle, heartbeat, per-item errors |
| `[jira-restore]` | Restore job lifecycle, phase transitions, trash-window blocks |
| `[jira-sdi]` | SDI scan results, regulation tag activations |

In the container stack, access logs with:
```sh
podman-compose logs -f jira-backup-app
```

To audit whether all expected log patterns are being emitted:
```sh
bash scripts/log-audit.sh
```

### 4.2 OAuth credential rotation

#### When does a reconnect become necessary?

- Atlassian invalidated the refresh token (Site Admin revoked app access, extended inactivity).
- The scope set on the token grant no longer matches `JIRA_OAUTH_SCOPES` (new scope added, re-consent required).
- The credential store contains `null` or an expired `refresh_token`.

The system emits `[jira-oauth] token.refresh.failed` and the Workload Card in the UI
surfaces a red **"Connection error — reconnect required"** banner.

#### Step 1 — Inspect the credential store

```sh
sqlite3 data/jira.db
```

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

| Field | Healthy value | Problem signal |
|---|---|---|
| `token_expires` | Future timestamp | Past timestamp — token stale |
| `last_rotated` | Within last 24 h | Old date — refresh not completing |
| `refresh_token` | Non-empty string | Null/empty — re-consent required |

#### Step 2 — Trigger re-consent

Navigate to the Jira connector settings page and click **Reconnect**. This calls
`GET /api/jira/oauth/start`. The authorising account must hold Site Admin or
Atlassian Organization Admin role.

**Important:** `OAUTH_REDIRECT_URI` must start with `https://`. An `http://` URI returns
`400 redirect_uri_must_be_https` and blocks the flow.

After approval, the callback handler:
1. Exchanges the auth code for `access_token` + `refresh_token`.
2. Calls `GET https://api.atlassian.com/oauth/token/accessible-resources` to retrieve `cloudId`.
3. Calls `GET https://api.atlassian.com/me` to confirm a valid `accountId`.
4. Writes all four values atomically to `jira_credentials` in a single transaction.

Success: `[jira-oauth] account verified accountId=<id> cloudId=<id>`

#### Step 3 — Verify the token is live

Re-run the credential-store query from Step 1 and confirm `token_expires` is in the future
and `last_rotated` is the current timestamp.

### 4.3 Scope errors (403 / Insufficient Scope)

Atlassian returns HTTP 403 when the access token lacks a required scope. The system logs
`[jira-oauth] request.403` and the Workload Card shows **"Permission error — re-authorise
to grant required scopes"**.

#### Diagnosis steps

1. Check logs for `scope_hint` in the `403` entry to identify the missing scope.
2. Go to `https://developer.atlassian.com/console/myapps/` → your app → **Permissions → Jira API**.
   Confirm all seven scopes listed in §2.3 are enabled.
3. Follow the reconnect procedure in §4.2 to issue a new grant with the full scope set.
4. Verify the new token by decoding its JWT payload:
   ```sh
   echo "<token_payload_segment>" | base64 -d | python3 -m json.tool | grep -A20 '"scope"'
   ```

### 4.4 Reading the Object Explorer manifest

The backup point manifest is stored in the SQLite database. To list recent backup points:

```sh
sqlite3 data/jira.db \
  "SELECT id, created_at, project_count, issue_count, status
   FROM backup_points
   ORDER BY created_at DESC LIMIT 10;"
```

To inspect entries within a specific backup point:

```sh
sqlite3 data/jira.db \
  "SELECT object_type, object_key, backup_point_id, captured_at
   FROM manifest_entries
   WHERE backup_point_id = 'bp-<uuid>'
   ORDER BY object_type, object_key
   LIMIT 50;"
```

### 4.5 Inspecting a backup-point ID

Every backed-up item is traceable to a `backupPointId` (format: `bp-<uuid>`) and a timestamp.

**In the UI:** Navigate to **Inventory** → select a project or issue → click the item row.
The detail panel shows the `backupPointId` and timestamp for that item.

**Via CLI:**
```sh
sqlite3 data/jira.db \
  "SELECT id, created_at, status, issue_count FROM backup_points ORDER BY created_at DESC LIMIT 5;"
```

### 4.6 Restoring a project in Atlassian's 60-day trash window

When a Jira project is deleted, Atlassian moves it to a managed trash window for 60 days.
The connector **blocks in-place restore** for trashed projects because the project key is
in an `archived: true` state and is not writable via the standard REST API.

The error response:
```json
{
  "code": "TRASH_WINDOW_BLOCK",
  "projectKey": "MYPROJ",
  "guidance": "Use Alternate location restore"
}
```

Log line: `[jira-restore] trash-window-block project=MYPROJ action=blocked`

#### Step-by-step: Alternate location restore

**Step 1** — Identify the backup point (see §4.5).

**Step 2** — Choose a new project key (2–10 uppercase letters, no collision with existing
or trashed keys). Convention: append `R` or date, e.g. `MYPROJR`.

**Step 3** — Open the Restore Wizard in the UI:
- Select the project → **Restore**
- **Destination** step: select **Alternate location (same Jira site)**
- Enter the new `targetProjectKey`
- Leave **Conflict mode** as **Skip** (default) unless overrides are intended

**Step 4** — Submit. The wizard calls:
```
POST /restore/jobs
{
  "sourceBackupPointId": "bp-<uuid>",
  "scope": { "type": "projects", "projectKeys": ["MYPROJ"] },
  "destination": { "type": "alternate", "targetProjectKey": "MYPROJR" },
  "conflictMode": "skip"
}
```

Because destination is `"alternate"`, the trash-window check is skipped and the job starts
immediately.

**Step 5** — Monitor progress via the **Restore progress** panel (SSE stream). The engine
writes objects in dependency order:

```
Project → Workflow + WorkflowScheme → CustomField + FieldConfiguration
       → Board → Sprint → Issue body → issue links + comments + attachments
```

Each phase emits a heartbeat every ≤10 s. No heartbeat for >20 s triggers a **Stalled**
alert — check logs for `[jira-restore] worker.error` entries.

**Step 6** — Verify. Once `completed`, navigate to the new project key in Jira and confirm
issue count, board, and sprint structure match the backup manifest. If the restore report
shows ADF media-link warnings, attachment references in issue descriptions may be broken —
this is a known Phase 1 limitation; a full rewrite pass is Phase 2.

---

> **Note:** `docs/runbook.md` has been retired. Its content is fully incorporated above.
