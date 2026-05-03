# Jira Cloud — OAuth 2.0 (3LO) Architecture Note

_Author: Software Architect | Date: 2026-05-03 | Status: Approved for Sprint 1_

---

## 1. OAuth 2.0 (3LO) Redirect Flow Sequence

### Scope Set (T2 §4.2.2 — verbatim)

The following scopes MUST be requested in the authorization URL. All scopes are required; none are optional:

```
read:jira-user
read:jira-work
write:jira-work
manage:jira-project
manage:jira-configuration
read:me
offline_access
```

> `offline_access` is mandatory to obtain a `refresh_token`. Without it, Atlassian does not issue a refresh token and the connector cannot perform unattended backup jobs.

### Sequence Diagram

```
User Browser          DCC Backend              Atlassian Auth           Jira Cloud API
     │                     │                        │                        │
     │  Click "Connect"    │                        │                        │
     │────────────────────>│                        │                        │
     │                     │ Generate state (CSRF),  │                        │
     │                     │ store in session        │                        │
     │                     │                        │                        │
     │ 302 → Atlassian     │                        │                        │
     │  /authorize?        │                        │                        │
     │  client_id=...      │                        │                        │
     │  redirect_uri=...   │                        │                        │
     │  scope=<full set>   │                        │                        │
     │  state=<csrf_token> │                        │                        │
     │  response_type=code │                        │                        │
     │  prompt=consent     │                        │                        │
     │────────────────────────────────────────────>│                        │
     │                     │                        │                        │
     │  User consents      │                        │                        │
     │<────────────────────────────────────────────│                        │
     │                     │                        │                        │
     │ GET /oauth/callback │                        │                        │
     │  ?code=AUTH_CODE    │                        │                        │
     │  &state=<csrf_token>│                        │                        │
     │────────────────────>│                        │                        │
     │                     │ Validate state == session.state                 │
     │                     │                        │                        │
     │                     │ POST /oauth/token       │                        │
     │                     │  grant_type=authorization_code                  │
     │                     │  code=AUTH_CODE         │                        │
     │                     │  redirect_uri=...       │                        │
     │                     │  client_id=...          │                        │
     │                     │  client_secret=...      │                        │
     │                     │────────────────────────>│                        │
     │                     │                        │                        │
     │                     │ { access_token,         │                        │
     │                     │   refresh_token,        │                        │
     │                     │   expires_in }          │                        │
     │                     │<────────────────────────│                        │
     │                     │                        │                        │
     │                     │ GET /oauth/token/accessible-resources           │
     │                     │  Authorization: Bearer <access_token>           │
     │                     │────────────────────────>│                        │
     │                     │ [{ id: cloudId,         │                        │
     │                     │    url: siteUrl, ... }] │                        │
     │                     │<────────────────────────│                        │
     │                     │                        │                        │
     │                     │ GET /me                 │                        │
     │                     │────────────────────────>│                        │
     │                     │ { accountId, ... }      │                        │
     │                     │<────────────────────────│                        │
     │                     │                        │                        │
     │                     │ ATOMIC WRITE to credential store:               │
     │                     │  cloudId, accessToken, refreshToken,            │
     │                     │  oauthClientId, accountId, siteUrl,             │
     │                     │  accessTokenExpiresAt                           │
     │                     │                        │                        │
     │  Site picker UI     │                        │                        │
     │  (or auto-select    │                        │                        │
     │   if single site)   │                        │                        │
     │<────────────────────│                        │                        │
```

### Authorization URL Construction

```
https://auth.atlassian.com/authorize
  ?audience=api.atlassian.com
  &client_id={OAUTH_CLIENT_ID}
  &scope=read%3Ajira-user%20read%3Ajira-work%20write%3Ajira-work%20manage%3Ajira-project%20manage%3Ajira-configuration%20read%3Ame%20offline_access
  &redirect_uri={HTTPS_CALLBACK_URI}
  &state={CSRF_TOKEN}
  &response_type=code
  &prompt=consent
```

`prompt=consent` is required on every authorization request to ensure the refresh token is always issued, even when the user has previously authorized the application.

### Site Picker Logic

- If `GET /oauth/token/accessible-resources` returns exactly **1** site → auto-select, skip UI.
- If it returns **2+** sites → render the Site Picker UI for the user to choose one `cloudId`.
- The selected `cloudId` is the only one persisted to the credential store.

---

## 2. HTTPS-Only Callback Enforcement

All OAuth callbacks MUST use HTTPS. HTTP callbacks are rejected by Atlassian and are forbidden in this codebase.

### Development Environment (Caddy + mkcert)

**Strategy:** Use Caddy as a local reverse proxy with a `mkcert`-issued certificate to terminate TLS at `https://localhost` (or a named local hostname).

**Setup:**

```bash
# Install mkcert and create a local CA
mkcert -install
mkcert localhost 127.0.0.1

# Caddyfile (dev)
localhost {
  tls localhost+1.pem localhost+1-key.pem
  reverse_proxy localhost:3001
}
```

The DCC backend listens on port `3001` (plain HTTP, loopback only). Caddy terminates TLS on `443` and forwards to it. The registered Atlassian OAuth redirect URI is:

```
https://localhost/oauth/callback
```

This URI is registered in the Atlassian developer console for the dev OAuth app and must not be changed without updating both the console and the `OAUTH_REDIRECT_URI` env variable.

**Enforcement at the application layer:**

```typescript
// In the OAuth initiation handler — enforced before redirect
if (!redirectUri.startsWith('https://')) {
  throw new Error('OAuth callback URI must use HTTPS');
}
```

### Production Environment

- TLS is terminated at the load balancer / ingress (e.g., AWS ALB or nginx).
- The backend only receives traffic from the internal network on HTTP; the public-facing URI is always HTTPS.
- `OAUTH_REDIRECT_URI` in the production environment must begin with `https://`. The application validates this at startup:

```typescript
// In server startup
const redirectUri = process.env.OAUTH_REDIRECT_URI;
if (!redirectUri?.startsWith('https://')) {
  throw new Error('FATAL: OAUTH_REDIRECT_URI must use HTTPS in production');
}
```

### CSRF Protection

A cryptographically random `state` parameter (32 bytes, hex-encoded) is generated per-authorization-request, stored in a server-side session, and validated on callback. Mismatch results in HTTP 400 and the flow is aborted.

---

## 3. Credential Store Schema

### Table DDL (SQLite / Postgres compatible)

See migration file: `db/migrations/001_jira_credentials.sql`

```sql
CREATE TABLE IF NOT EXISTS jira_credentials (
  id               TEXT        NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  cloud_id         TEXT        NOT NULL UNIQUE,
  site_url         TEXT        NOT NULL,
  account_id       TEXT        NOT NULL,
  oauth_client_id  TEXT        NOT NULL,
  access_token     TEXT        NOT NULL,
  refresh_token    TEXT        NOT NULL,
  access_token_expires_at  INTEGER NOT NULL,  -- Unix epoch seconds (UTC)
  created_at       INTEGER     NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER     NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_jira_credentials_cloud_id
  ON jira_credentials (cloud_id);
```

For Postgres, replace `lower(hex(randomblob(16)))` with `gen_random_uuid()::text` and `unixepoch()` with `EXTRACT(EPOCH FROM NOW())::bigint`.

### Atomic Write Semantics for Token Rotation

**Invariant:** `access_token` and `refresh_token` are always updated together in a single transaction. A partial write (one token updated, the other not) must never be observable.

```sql
-- Token rotation (called by the refresh handler)
BEGIN IMMEDIATE;  -- IMMEDIATE prevents read-only snapshot; serialises concurrent writes

UPDATE jira_credentials
SET
  access_token             = :newAccessToken,
  refresh_token            = :newRefreshToken,
  access_token_expires_at  = :newExpiresAt,
  updated_at               = unixepoch()
WHERE cloud_id = :cloudId;

-- Verify exactly one row was updated
-- If rowcount != 1, ROLLBACK and surface error
COMMIT;
```

**Why `BEGIN IMMEDIATE`:** SQLite's default `DEFERRED` transaction can upgrade from read to write and fail if another writer holds the lock. `IMMEDIATE` acquires the write lock upfront, serialising all token rotations. On Postgres this is a standard `BEGIN; ... COMMIT;` (Postgres serialises writes at the row level).

---

## 4. Mutex-Guarded Refresh Handler Design

### Problem

Multiple concurrent API calls may simultaneously receive HTTP 401. Without coordination, each would independently attempt a token refresh, causing:
- Race conditions writing to the credential store
- Token invalidation: Atlassian's rotating refresh token model issues a new `refresh_token` on every refresh. The second refresh call using the now-invalidated old `refresh_token` will fail with a 400.

### Design: Single In-Flight Refresh with Promise Coalescing

```typescript
class JiraAuthClient {
  private refreshPromise: Promise<void> | null = null;
  private mutex = new Mutex(); // e.g., async-mutex library

  /**
   * Called by the 401 interceptor. Guarantees only one refresh is
   * in-flight at a time. Concurrent callers await the same promise.
   */
  async refreshAccessToken(cloudId: string): Promise<void> {
    // If a refresh is already in flight, join it — do not start a new one
    if (this.refreshPromise !== null) {
      return this.refreshPromise;
    }

    // Acquire mutex so no concurrent caller can enter the critical section
    const release = await this.mutex.acquire();
    try {
      // Double-check: another caller may have refreshed while we waited
      if (this.refreshPromise !== null) {
        return this.refreshPromise;
      }

      this.refreshPromise = this._doRefresh(cloudId).finally(() => {
        this.refreshPromise = null;
      });

      return this.refreshPromise;
    } finally {
      release();
    }
  }

  private async _doRefresh(cloudId: string): Promise<void> {
    const creds = await credentialStore.get(cloudId);

    const response = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type:    'refresh_token',
        client_id:     creds.oauthClientId,
        client_secret: process.env.OAUTH_CLIENT_SECRET,
        refresh_token: creds.refreshToken,
      }),
    });

    if (!response.ok) {
      throw new OAuthRefreshError(`Token refresh failed: ${response.status}`);
    }

    const { access_token, refresh_token, expires_in } = await response.json();
    const expiresAt = Math.floor(Date.now() / 1000) + expires_in - 30; // 30s buffer

    // ATOMIC WRITE: both tokens in one transaction
    await credentialStore.rotateTokens(cloudId, {
      accessToken:           access_token,
      refreshToken:          refresh_token,
      accessTokenExpiresAt:  expiresAt,
    });
  }
}
```

### 401 Interceptor Pseudocode

```typescript
// Wraps every Jira API call
async function jiraRequest(cloudId: string, req: RequestConfig): Promise<Response> {
  let response = await executeRequest(req, await credentialStore.getAccessToken(cloudId));

  if (response.status === 401) {
    // Queue behind any in-flight refresh
    await authClient.refreshAccessToken(cloudId);
    // Retry once with the new token
    response = await executeRequest(req, await credentialStore.getAccessToken(cloudId));
  }

  if (response.status === 403) {
    throw new JiraPermissionError('Insufficient scope or revoked access — reconnect required');
  }

  return response;
}
```

### Concurrent Request Flow (N callers hitting 401 simultaneously)

```
Caller A ──► 401 ──► refreshAccessToken() ──► acquires mutex ──► _doRefresh() ──► ATOMIC WRITE ──► resolves
Caller B ──► 401 ──► refreshAccessToken() ──► awaits same promise ──────────────────────────────► resolves
Caller C ──► 401 ──► refreshAccessToken() ──► awaits same promise ──────────────────────────────► resolves
```

All three callers retry with the same new `access_token`. Only one `POST /oauth/token` call is made.

---

## 5. Confluence Pilot Reuse Points and Jira Deltas

### Reusable from Confluence Pilot

| Component | Reuse Decision |
|---|---|
| `CredentialStore` class | **Reuse as-is** — table schema is extended (see delta below) but the CRUD interface (`get`, `rotateTokens`, `delete`) is unchanged |
| `OAuthCallbackHandler` | **Reuse** — CSRF state generation/validation, auth code exchange, `/me` call are identical |
| `MutexGuardedRefreshHandler` | **Reuse as-is** — the refresh coalescing logic is auth-provider-agnostic |
| HTTPS enforcement middleware | **Reuse** — redirect URI validation on startup is identical |
| `Caddy` + `mkcert` dev setup | **Reuse** — same Caddyfile pattern, different hostname mapping if needed |

### Jira-Specific Deltas

| Delta | Detail |
|---|---|
| **Scope set** | Jira requires `read:jira-user`, `read:jira-work`, `write:jira-work`, `manage:jira-project`, `manage:jira-configuration` in addition to the common `read:me` and `offline_access`. Confluence used `read:confluence-space.summary`, `read:confluence-content.all`, etc. The scope list is passed as an environment variable `OAUTH_SCOPES` to keep the handler generic. |
| **`/accessible-resources` response shape** | Identical endpoint; response includes `scopes` array per site. For Jira, verify that `manage:jira-configuration` is present in the site's scope list before persisting — if absent, surface an "insufficient permissions" error. |
| **Site picker** | Confluence pilot may have targeted a specific site directly. Jira adds explicit single-site auto-select logic (described in §1). |
| **`cloud_id` namespacing** | Credential store rows are namespaced by `cloud_id`. If both Confluence and Jira connectors connect to the same Atlassian site, they share the `cloud_id` but have separate credential rows (different tables or a `connector_type` discriminator column). Recommended: add `connector_type TEXT NOT NULL DEFAULT 'jira'` as a column and make the unique constraint on `(cloud_id, connector_type)`. |
| **JSM project type guard** | After site selection, query `GET /rest/api/3/project/search` and check `projectTypeKey`. If `service_desk` projects are present, surface the out-of-scope notice in the Workload Card. This is a Jira-only concern. |

### Delta: Credential Store Unique Constraint (Multi-Connector)

```sql
-- If the Confluence credential table is being extended for multi-connector use:
ALTER TABLE jira_credentials
  ADD COLUMN connector_type TEXT NOT NULL DEFAULT 'jira';

-- Replace the UNIQUE constraint on cloud_id alone:
DROP INDEX IF EXISTS idx_jira_credentials_cloud_id;
CREATE UNIQUE INDEX idx_credentials_cloud_connector
  ON jira_credentials (cloud_id, connector_type);
```

---

## Appendix: Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OAUTH_CLIENT_ID` | Yes | Atlassian OAuth app client ID |
| `OAUTH_CLIENT_SECRET` | Yes | Atlassian OAuth app client secret (never logged) |
| `OAUTH_REDIRECT_URI` | Yes | Full HTTPS callback URI registered in Atlassian console |
| `OAUTH_SCOPES` | Yes | Space-separated scope string (see §1) |
| `CREDENTIAL_STORE_PATH` | Yes (SQLite) | Absolute path to the SQLite database file |
| `DATABASE_URL` | Yes (Postgres) | Postgres connection string |
