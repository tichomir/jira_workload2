# Sprint 1 QA Report — OAuth 3LO Foundation & Credential Store

**Sprint:** Sprint 1 — OAuth Authentication & Connector Foundation (Sprint 1 of 2)
**Date:** 2026-05-03
**QA Engineer:** qa-engineer-persona
**Environment:** Node 20, better-sqlite3 (in-memory + on-disk WAL), Jest 29, Playwright (API project)

---

## Executive Summary

All acceptance criteria for Sprint 1 are satisfied. 59 tests pass across two test runners (Jest + Playwright) with zero failures. The four acceptance criterion areas — E2E happy path, HTTPS enforcement, atomicity fault injection, and 401 reconnect banner — are each covered by dedicated test suites.

| Criterion | Status | Tests |
|---|---|---|
| E2E happy-path: credential row has non-null accessToken + refreshToken | PASS | 4 tests |
| HTTPS-only callback enforcement: 400 + log line on http:// | PASS | 6 tests |
| Atomicity fault injection: no mixed-token state after kill+restart | PASS | 4 tests |
| 401 reconnect banner: structured error response from backend | PASS | 7 tests |

---

## Test Suite Results

### 1. Jest Integration Tests (`npm test`)

**Configuration:** `jest.config.js` — `maxWorkers: 1` (serial execution required; SQLite concurrent-handle tests trigger SIGKILL under default parallel workers).

**Result: 50/50 PASS — 5 test suites, 0 failures**

```
PASS src/auth/JiraOAuthHandler.test.ts       (12 tests)
PASS src/qa/sprint1-e2e.test.ts              (15 tests)
PASS src/connections/JiraConnectionsRouter.test.ts (3 tests)
PASS src/qa/sprint1-ui.test.ts               (9 tests)
PASS src/db/JiraCredentialRepository.test.ts (11 tests)

Test Suites: 5 passed, 5 total
Tests:       50 passed, 50 total
Time:        ~9s
```

#### Verbose test list

**`src/auth/JiraOAuthHandler.test.ts`**
```
GET /api/jira/oauth/start
  ✓ redirects to Atlassian authorize URL containing all T2 §4.2.2 scopes (32 ms)
  ✓ includes a state nonce in the redirect URL (4 ms)
  ✓ returns 400 with structured error when redirect_uri uses http:// (25 ms)
GET /api/jira/oauth/callback — happy paths
  ✓ auto-selects single site: redirects to frontend with site payload (4 ms)
  ✓ multi-site: redirects to frontend with sites list payload (3 ms)
  ✓ logs [jira-oauth] account verified with accountId and cloudId (3 ms)
  ✓ persists accessTokenExpiresAt with 30-second buffer (2 ms)
GET /api/jira/oauth/callback — error paths
  ✓ returns 400 for unknown (invalid) state nonce (3 ms)
  ✓ returns 400 for expired state nonce (24 ms)
  ✓ returns 400 when token exchange returns 4xx (3 ms)
  ✓ returns 400 when Atlassian returns an error query parameter (4 ms)
  ✓ returns 400 for state nonce that has already been consumed (replay prevention) (6 ms)
```

**`src/qa/sprint1-e2e.test.ts`** (QA integration tests)
```
E2E Happy Path — Full OAuth Flow
  ✓ GET /start → GET /callback: credential row has non-null accessToken AND refreshToken (19 ms)
  ✓ POST /connections/select returns connected after OAuth credentials are stored (12 ms)
  ✓ multi-site OAuth flow stores credentials for all sites (4 ms)
HTTPS-Only Callback Enforcement
  ✓ returns 400 with redirect_uri_must_be_https when http:// URI configured (4 ms)
  ✓ logs the rejection with the offending URI (2 ms)
  ✓ does NOT reject a valid https:// redirectUri (2 ms)
  ✓ does not call fetchFn when the http:// guard rejects (2 ms)
Atomicity Fault Injection — Kill+Restart Simulation
  ✓ no mixed-token state after mid-rotation crash: both tokens are original on restart (6 ms)
  ✓ successful rotation across open/close cycles leaves both tokens as new values (4 ms)
  ✓ concurrent upsert and rotateTokens: last-writer wins, no mixed state (4 ms)
401 Error Response — Reconnect Banner Trigger Path
  ✓ accessible-resources 401 → callback returns 500 accessible_resources_failed; no credential stored (4 ms)
  ✓ /me 401 → callback returns 500 me_verification_failed; no credential stored (3 ms)
  ✓ token exchange 4xx → callback returns 400 token_exchange_failed (3 ms)
  ✓ GET /start redirects to Atlassian authorize URL — this is the Reconnect button target (1 ms)
  ✓ oauth_error query param from Atlassian → 400 authorization_denied from callback (3 ms)
```

**`src/connections/JiraConnectionsRouter.test.ts`**
```
JiraConnectionsRouter
  ✓ returns 400 when cloudId is missing (13 ms)
  ✓ returns 404 when cloudId has no stored credential (2 ms)
  ✓ returns 200 with site info for a known cloudId (2 ms)
```

**`src/qa/sprint1-ui.test.ts`** (jsdom UI tests)
```
Sprint 1 UI — Reconnect banner and OAuth result rendering
  ✓ idle state: Connect button renders, no error banner (7 ms)
  ✓ oauth_error=access_denied renders error banner with Reconnect button (3 ms)
  ✓ oauth_error=authorization_denied renders error banner with Reconnect button (1 ms)
  ✓ Reconnect button is present alongside Dismiss button (2 ms)
  ✓ error banner does NOT render in idle state
  ✓ single-site auto-select: status banner + ConnectedCard renders (3 ms)
  ✓ single-site: no error banner, no connect button in connected state (1 ms)
  ✓ multi-site: site picker (listbox) renders (2 ms)
  ✓ malformed oauth_result param renders error banner (1 ms)
```

**`src/db/JiraCredentialRepository.test.ts`**
```
JiraCredentialRepository
  runMigration
    ✓ creates the jira_credentials table on a fresh database (3 ms)
    ✓ is idempotent — running the migration twice does not throw (1 ms)
  upsertConnection
    ✓ inserts a new credential row and persists all fields (1 ms)
    ✓ updates an existing row (upsert semantics) without changing created_at (1 ms)
    ✓ allows two credentials with the same cloud_id but different connector_type
  getByCloudId
    ✓ returns null when no credential exists for the given cloudId (1 ms)
    ✓ returns the correct credential after insert (1 ms)
  rotateTokens
    ✓ updates both access_token and refresh_token (happy path)
    ✓ updates updated_at on rotation (3 ms)
    ✓ throws when the cloudId does not exist (9 ms)
    ✓ atomicity — simulates failure mid-write and verifies no partial state (1 ms)
```

---

### 2. Playwright E2E Tests (`npx playwright test --project=api`)

**Configuration:** `playwright.config.ts` — API project (no browser binary; uses `request` fixture over real HTTP).

**Result: 9/9 PASS — 0 failures**

```
Running 9 tests using 1 worker

  ✓  1 [api] E2E Happy Path — OAuth flow and credential assertion
       › GET /start redirects to Atlassian authorize URL (48ms)
  ✓  2 [api] E2E Happy Path — OAuth flow and credential assertion
       › GET /callback: single-site auto-select, oauth_result payload, credential persisted (105ms)
  ✓  3 [api] E2E Happy Path — OAuth flow and credential assertion
       › POST /connections/select returns site info for stored cloudId (49ms)
  ✓  4 [api] HTTPS-Only Enforcement
       › GET /start returns 400 with redirect_uri_must_be_https (12ms)
  ✓  5 [api] HTTPS-Only Enforcement
       › fetchFn is never called when http:// guard rejects (30ms)
  ✓  6 [api] Atomicity — no mixed-token state after rotation
       › after successful upsert→re-seed, credential is consistent (both tokens updated) (54ms)
  ✓  7 [api] 401 Error — Backend error codes for Reconnect banner
       › accessible-resources 401 → 500 accessible_resources_failed; no credential stored (56ms)
  ✓  8 [api] 401 Error — Backend error codes for Reconnect banner
       › /me 401 → 500 me_verification_failed; no credential stored (23ms)
  ✓  9 [api] 401 Error — Backend error codes for Reconnect banner
       › oauth_error=access_denied param → frontend renders error banner (HTTP contract) (16ms)

  9 passed (1.4s)
```

---

## Acceptance Criterion Evidence

### AC 1: Playwright E2E happy-path — credential row asserted non-null on both tokens

**Test:** `e2e/sprint1-oauth.spec.ts` line 181 — "GET /callback: single-site auto-select, oauth_result payload, credential persisted"

**What it does:**
1. Calls `GET /api/jira/oauth/start` — asserts 302 redirect to `https://auth.atlassian.com/authorize` with correct `response_type`, `audience`, and `client_id`.
2. Extracts the `state` nonce from the redirect URL.
3. Calls `GET /api/jira/oauth/callback?code=e2e-auth-code&state=<nonce>` against a server wired with a mock fetch that returns `access_token=pw_access_token_abc123`, `refresh_token=pw_refresh_token_xyz789`.
4. Asserts 302 redirect to frontend with `oauth_result` base64url payload; decodes payload → `status=connected`, `site.id=cloud-pw-e2e-001`, no `sites` array (single-site auto-select).
5. Calls `GET /api/test/credential/cloud-pw-e2e-001` → asserts `accessToken` and `refreshToken` are non-null, matching mock values.

**Console log evidence (from test run):**
```
[jira-oauth] account verified accountId=account-pw-e2e-999 cloudId=cloud-pw-e2e-001
```

**Result: PASS**

---

### AC 2: HTTP callback rejection asserts 400 + log line

**Tests:**
- `e2e/sprint1-oauth.spec.ts` line 259 — "GET /start returns 400 with redirect_uri_must_be_https"
- `src/qa/sprint1-e2e.test.ts` — "returns 400 with redirect_uri_must_be_https when http:// URI configured"
- `src/qa/sprint1-e2e.test.ts` — "logs the rejection with the offending URI"

**What it does:** Configures the OAuth router with `redirectUri: 'http://insecure.example.com/api/jira/oauth/callback'`. Calls `GET /api/jira/oauth/start`. Asserts:
- Response status is `400`
- Response body `{ "error": "redirect_uri_must_be_https" }`
- `console.error` called with `[jira-oauth] OAUTH_REDIRECT_URI must use HTTPS` and the offending URI
- No downstream fetch calls made (fetchFn spy not called)

**Console log evidence (from test run):**
```
[jira-oauth] OAUTH_REDIRECT_URI must use HTTPS, rejecting: http://insecure.example.com/api/jira/oauth/callback
```

**Result: PASS**

---

### AC 3: Atomicity fault-injection — no mixed-token state after kill+restart

**Tests:**
- `src/qa/sprint1-e2e.test.ts` — "no mixed-token state after mid-rotation crash: both tokens are original on restart"
- `src/db/JiraCredentialRepository.test.ts` — "atomicity — simulates failure mid-write and verifies no partial state"

**Kill+restart simulation methodology:**
The test uses a real on-disk SQLite file (WAL mode) across three distinct `Database` handle lifetimes, each mimicking a separate process:

1. **Phase 1 (seed):** Opens DB, runs migration, inserts `access_initial_v1` / `refresh_initial_v1`, closes (checkpointed).
2. **Phase 2 (crash):** Opens same file. Spies on `db.transaction` to inject a `throw new Error('[kill-sim] SIGKILL — process terminated')` _after_ the `UPDATE` executes but _before_ `COMMIT`. Calls `rotateTokens()` with new token values. Verifies the call throws. Closes DB — SQLite WAL discards the uncommitted entry.
3. **Phase 3 (restart):** Opens same file fresh. Reads credential row. Asserts:
   - `accessToken === 'access_initial_v1'` (original value preserved)
   - `refreshToken === 'refresh_initial_v1'` (original value preserved)
   - `accessToken !== 'access_PARTIAL_new'` (partial new value NOT present)
   - `refreshToken !== 'refresh_PARTIAL_new'` (partial new value NOT present)

**Mixed-state assertions:** The test explicitly fails if `accessToken` is the new value while `refreshToken` is the old value, or vice versa.

**Result: PASS** — SQLite WAL atomicity guarantee holds; no mixed-token state observable after crash simulation.

---

### AC 4: 401 reconnect banner test passes

**Tests:**
- `e2e/sprint1-oauth.spec.ts` — "accessible-resources 401 → 500 accessible_resources_failed; no credential stored"
- `e2e/sprint1-oauth.spec.ts` — "/me 401 → 500 me_verification_failed; no credential stored"
- `e2e/sprint1-oauth.spec.ts` — "oauth_error=access_denied param → frontend renders error banner (HTTP contract)"
- `src/qa/sprint1-ui.test.ts` — "oauth_error=access_denied renders error banner with Reconnect button"
- `src/qa/sprint1-ui.test.ts` — "Reconnect button is present alongside Dismiss button"

**What they prove:**

*Backend layer:* When the Atlassian `accessible-resources` endpoint returns 401, the callback returns `HTTP 500 { "error": "accessible_resources_failed" }` and no credential row is persisted. Same for `/me` 401 → `me_verification_failed`. When Atlassian sends `?error=access_denied` to the callback, the backend returns `HTTP 400 { "error": "authorization_denied", "detail": "access_denied" }`.

*Frontend layer (jsdom):* When the frontend receives `?oauth_error=access_denied` in the URL, a `<div role="alert">` error banner renders with:
- Headline: "Your Jira session has expired or the credentials are invalid."
- A `<button id="reconnect-btn">` with `data-href="/api/jira/oauth/start"`
- A `<button id="dismiss-btn">` alongside it

**Console log evidence (from Playwright run):**
```
[jira-oauth] accessible-resources failed: 401 {"error":"Unauthorized"}
[jira-oauth] /me verification failed: 401 {"error":"Unauthorized"}
[jira-oauth] authorization error from Atlassian: access_denied
```

**Result: PASS**

---

## Issues Found and Resolved

### Issue: `sprint1-e2e.test.ts` SIGKILL under parallel Jest workers

**Symptom:** `npm test` (default parallel workers) killed the `sprint1-e2e.test.ts` worker process with SIGKILL. The suite contains three tests that open multiple concurrent SQLite file handles (atomicity tests), which exhausts process memory/file-descriptor limits when run concurrently with other suites.

**Fix:** Added `maxWorkers: 1` to `jest.config.js`. This enforces serial suite execution at the config level, eliminating the SIGKILL without changing any test logic.

**File changed:** `jest.config.js` — added `maxWorkers: 1` with explanatory comment.

**Verification:** `npm test` now returns `Tests: 50 passed, 50 total` with no failures.

---

## Coverage Summary

| Area | Test Files | Tests | Result |
|---|---|---|---|
| OAuth 3LO handler (unit) | `JiraOAuthHandler.test.ts` | 12 | PASS |
| QA integration (all 4 AC areas) | `sprint1-e2e.test.ts` | 15 | PASS |
| Connections router | `JiraConnectionsRouter.test.ts` | 3 | PASS |
| UI / banner rendering (jsdom) | `sprint1-ui.test.ts` | 9 | PASS |
| Credential repository (unit) | `JiraCredentialRepository.test.ts` | 11 | PASS |
| Playwright E2E API | `e2e/sprint1-oauth.spec.ts` | 9 | PASS |
| **Total** | **6 files** | **59** | **59 PASS / 0 FAIL** |

---

## Notes and Assumptions

1. **No browser binary required.** The Playwright project is configured as `api`-only; all E2E assertions run via `request` fixture against a real Express HTTP server spun up in `beforeAll`. Browser screenshots are not applicable.

2. **Mock Atlassian endpoints.** No real Atlassian network calls are made in any test. The injectable `fetchFn` parameter in `createJiraOAuthRouter` is used throughout to intercept `https://auth.atlassian.com/oauth/token`, `/oauth/token/accessible-resources`, and `/me` calls.

3. **SQLite WAL mode.** All atomicity tests use `journal_mode = WAL` to match the production configuration documented in `db/migrations/001_jira_credentials.sql`. The on-disk file approach in the kill+restart tests is required to observe WAL recovery behavior; `:memory:` databases do not survive across `Database` handle closures.

4. **Refresh-token rotation atomicity.** The `rotateTokens` method uses `db.transaction()` (SQLite `BEGIN IMMEDIATE`) which automatically rolls back on exception. The fault-injection tests confirm this behavior is sufficient to prevent mixed-token state observable at the application layer, meeting the T2 §4.5 / §6 Constraint 4 requirement.

5. **JSM exclusion notice** is a Phase 1 deliverable for the Workload Card component, not the OAuth flow. It is out of scope for this sprint's QA task.
