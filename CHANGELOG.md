# CHANGELOG — Jira Cloud Backup & Restore Connector

All notable changes to this project are documented here.
Format: `Added` / `Changed` / `Fixed` / `Removed` per phase.
**BREAKING** markers indicate changes requiring operator action on upgrade.

---

## [1.x.x+1] — 2026-05-03 — Frontend Containerisation Fix

### Fixed
- Container build now includes the frontend bundle.
  `https://localhost:4443/` now serves the Vite + React app (was returning 404 before this fix).
- `frontend/tsconfig.json` updated to exclude test files from the production TypeScript check,
  enabling `npm run build` in the Docker builder stage to succeed.
- Unused `React` default imports removed from production components (`ProtectedObjectCard`,
  `SitePicker`, and 9 other files) to satisfy `noUnusedLocals: true`.
- `frontend/package-lock.json` generated so `npm ci` in the Docker builder stage can run.

### Changed
- Backend (`src/server.ts`) now serves static files from `/app/dist/frontend/` with SPA
  fallback for client-side routing. All `/api/*` routes continue to respond as before; the
  SPA fallback only fires for non-API paths.
- `Dockerfile` builder stage now runs `COPY frontend/ ./frontend/` + `RUN cd frontend && npm ci && npm run build`
  so the Vite bundle lands in `dist/frontend/` inside the image.

### Removed
- `docker-compose.yml` — the file that was added in Sprint 17 as an identical copy of
  `podman-compose.yml` has been removed. Use `podman-compose.yml` directly.
  For Docker Compose users: `docker compose -f podman-compose.yml up -d` continues to work
  because the file uses standard Compose schema v3.

---

## [1.x.x] — 2026-05-03 — Container Deployment Shipped (Sprint 17)

### Added
- `Dockerfile` — multi-stage Node 20 Alpine build: `builder` stage compiles TypeScript
  via `npm run build`; `runtime` stage installs production deps only, runs as non-root
  `jiraapp` user.
- `.dockerignore` — excludes `node_modules/`, `data/`, `.env`, `.env.*`, `.git/`,
  `dist/`, `e2e/results/`.
- `podman-compose.yml` — two-service stack: `backend` (built from `Dockerfile`) and
  `caddy` (`caddy:2-alpine`). Named volumes `jira-data:/data`, `jira-attachments:/attachments`,
  `caddy-data`, `caddy-config`. Backend healthcheck on `GET /health`.
- `docker-compose.yml` — identical copy of `podman-compose.yml` for Docker Compose
  compatibility. _(Removed in [1.x.x+1]; see entry above.)_
- `Caddyfile.example` — HTTPS termination on `localhost:4443` via `tls internal` (local
  CA); reverse-proxies to `backend:3000`. Copy to `Caddyfile` before starting (gitignored).
- `.env.example` — complete inventory of every `process.env.*` read in `src/`, grouped
  by section (OAuth / Server / Database & Storage / TLS / Heartbeat / Fault Injection).
  1:1 with the preflight inventory in `docs/sprint17-preflight.md`.
- `GET /health` endpoint in `src/server.ts` — returns `{ status: "ok" }` with HTTP 200.
  Used by the compose healthcheck and Caddy health probes.
- `start.sh` — one-command launcher: auto-copies `Caddyfile.example` → `Caddyfile` and
  `.env.example` → `.env` if missing (with edit warning), runs `podman-compose up -d`
  (falls back to `docker compose up -d`), prints `https://localhost:4443` and next steps.
- `start.ps1`, `start.bat` — Windows equivalents of `start.sh`.
- `docs/sprint17-preflight.md` — pre-flight inventory: entry point, server port,
  all `process.env.*` reads with file:line, all npm scripts.

### Changed
- **BREAKING** — `start.sh` now launches the container stack (`podman-compose up -d`) and
  serves the app at `https://localhost:4443` (Caddy HTTPS). Previous local-dev invocations
  that expected `start.sh` to run `node dist/server.js` directly must switch to the local
  dev workflow in `INSTALL.md §2.5`.
  Migration: use `./start.sh` for container mode (https://localhost:4443) or
  `npm run build && node dist/server.js` for direct local dev (https://localhost:3000).

---

## [1.0.0-phase-7] — 2026-05-03 — Hardening, Observability & MVP Handoff

### Added
- End-to-end coverage-invariant test suite proving round-trip fidelity for system + custom fields.
- Playwright signal assertions for every PRD acceptance criterion across all phases.
- Structured log audit confirming all named log patterns (`[jira-oauth]`, `[jira-backup]`,
  `[jira-restore]`, `[jira-sdi]`, `[jira-http]`) are emitted.
- Fault-injection harness (`src/fault-injection/FaultInjectionConfig.ts`) with env-gated flags:
  `FAULT_SUSPEND_HEARTBEAT_MS`, `FAULT_ATTACHMENT_ERROR_RATE`, `FAULT_HALT_RESTORE_PHASE`.
- Heartbeat SLO load test: 5k-issue backup at ≤10s cadence, 500-item restore verified.
- Operator runbook (now at `INSTALL.md` §4).
- Phase 2 backlog groomed (`docs/phase2-backlog.md`): JSM, Audit Log, cross-site restore,
  incremental backup, ADF media link rewrite — each with scope, OQs, sizing, dependencies.
- Sprint kickoff handoff brief for Tihomir (`docs/handoff-tihomir.md`).

### Fixed
- Stalled-job alert now correctly surfaces in UI under fault-injected heartbeat suspension.
- "Completed with N errors" status wired end-to-end through fault-injected attachment failures.

---

## [1.0.0-phase-6] — 2026-05-03 — Restore Engine & Wizard (Sprints 11–13)

### Added
- Restore wizard UI: three-step flow (conflict mode → destination → confirm).
- Three conflict modes: Override, **Skip (default)**, Ask per conflict.
- Three restore destinations: Original location, Alternate location (same site), Browser Download.
- Dependency-ordered restore engine (`src/restore/RestoreEngine.ts`) with phase-halt and
  named diagnostic on failure.
- Write order contract enforced: Project → Workflow + WorkflowScheme → CustomField +
  FieldConfiguration → Board → Sprint → Issue body → links/comments/attachments.
- Trash-window detection: `TrashWindowChecker` probes `GET /rest/api/3/project/{key}`;
  in-place restore blocked for `archived: true` or 404 responses with `TRASH_WINDOW_BLOCK`
  error code and alternate-location guidance.
- Browser Download export: `BrowserDownloadAssembler` assembles a JSZip archive with
  `projects.json`, `workflows.json`, `custom-fields.json`, `boards.json`, `sprints.json`,
  `issues.json`, and `attachments/{id}/data.bin`.
- ADF media-link breakage best-effort warning surfaced in restore report
  (full rewrite pass deferred to Phase 2).
- `RestoreMetrics` and `RestoreWorker` with ≤10s heartbeat and >20s stall detection for restore jobs.
- `POST /restore/jobs`, `GET /restore/jobs/:id`, `GET /restore/jobs/:id/events` (SSE) endpoints.

### Changed
- **BREAKING** — `POST /restore/jobs` request body schema introduced in Sprint 11:
  `{ sourceBackupPointId, scope, destination, conflictMode }`. Clients built against an
  earlier draft API must update their request shape.
  Migration: pass `destination.type = "original" | "alternate" | "browser_download"` and
  `conflictMode = "skip" | "override" | "ask"`.

---

## [1.0.0-phase-5] — 2026-05-03 — Protected Object Inventory & Browse UI (Sprints 9–10)

### Added
- Inventory sidebar with four object types (Issues [default], Projects, Boards, Sprints)
  and per-row counts sourced from the latest backup manifest.
- Issues table with columns: Issue Key, Summary, Issue Status (Jira workflow state),
  Issue Type, Assignee, plus platform Status / Policy / Last Backup.
  Distinct "Issue Status" vs "Status" labelling.
- Global Search: case-insensitive search across `projectKey`, `projectName`, `boardName`,
  `sprintName`, `issueKey` returning typed Protected Object cards.
  `GET /api/search?q=<term>`
- Project Inventory Search: exact `issueKey` match and tokenised AND summary search within
  a project. `GET /api/inventory/projects/:projectKey/issues?q=...`
- Filters on Project Inventory: `status`, `issueType`, `priority`, `assigneeAccountId`,
  `labels` (repeatable), `updatedFrom`, `updatedTo` (ISO 8601).
- `GET /api/inventory/summary` returning per-type object counts.
- `GET /api/inventory/issues` returning paginated Issues table rows.

---

## [1.0.0-phase-4] — 2026-05-03 — SDI Teaser Scanner (Sprint 8)

### Added
- Pattern detectors:
  - `EmailDetector` — RFC-5322-pragmatic; activates GDPR tag.
  - `ApiKeySecretDetector` — entropy-based + pattern-based; activates GDPR tag.
  - `CreditCardDetector` — 13–19 digit extraction + Luhn validation; activates PCI DSS tag.
  - `PhoneDetector` — E.164, US/CA, UK, EU generic formats; activates GDPR tag.
- File-type handlers:
  - `XmlEntitiesHandler` — `entities.xml`
  - `TabularHandler` — `.csv`, `.xlsx`, `.tsv` (via ExcelJS)
  - `ConfigHandler` — `.env`, `.yaml`, `.yml`, `.json`, `.toml`, `.properties`, `.config`
  - `PlainTextHandler` — `.txt`, `.log`, `.md`
- Regulation tag rules: email/phone → GDPR; credit card → PCI DSS.
- `SdiScanner` integrated into backup post-processing pipeline after attachment persistence.
- SDI findings surfaced on Protected Object cards without operator action.

---

## [1.0.0-phase-3] — 2026-05-03 — Issue & Attachment Backup Engine (Sprints 5–7)

### Added
- Issue search via `POST /rest/api/3/search/jql`; pagination terminates on
  `issues.length === 0` or `issues.length < maxResults`.
- Full Issue payload capture in `IssueCaptureOrchestrator`: system fields, all
  `customfield_*` values, ADF comments, issue links (inward + outward), subtask refs,
  sprint membership (`customfield_10020`), watchers, worklogs.
- Binary-faithful attachment download via `GET /rest/api/3/attachment/content/{id}`;
  sha256 stored in sidecar metadata.
- `AttachmentBlobStore` for content storage.
- `HeartbeatEmitter` — progress events at ≤10s cadence.
- `StalledJobDetector` — flags jobs with >20s no heartbeat; sets `stalled: true` in job
  store and emits SSE event.
- Per-item error tracking: each failed item recorded in `job_errors`; job completes with
  status `completed_with_errors` if any errors, `completed` otherwise.
- SSE endpoint `GET /api/jobs/:jobId/events` for live job progress in UI.
- `BackupMetrics` with structured log lines and per-endpoint page counters.
- `scripts/check-deprecated-endpoint.sh` build gate — `npm run build` fails if
  `GET /rest/api/3/search` appears in `src/`.

### Changed
- **BREAKING** — Deprecated `GET /rest/api/3/search` endpoint is now **permanently blocked**
  by the build gate. Any code using the deprecated endpoint will fail `npm run build`.
  Migration: use `POST /rest/api/3/search/jql` with a `{ jql, fields, startAt, maxResults }`
  body.

---

## [1.0.0-phase-2] — 2026-05-03 — Discovery & Context Node Capture (Sprints 3–4)

### Added
- Paginated Project discovery via `GET /rest/api/3/project/search` with All / Selected
  scope filter (`WorkloadConfigRepository`).
- JSM `service_desk` project-type detection → out-of-scope manifest annotation with
  `JSM_NOTICE_MESSAGE` and `JSM_NOTICE_PHASE2` constants.
- Context-node capture pipeline (`ContextNodeCaptureOrchestrator`) in strict order:
  IssueType → CustomField + FieldConfiguration → Workflow + WorkflowScheme →
  Board → Sprint.
- Custom field context discovery gated on `custom: true` — `GET /rest/api/3/field/{id}/context`
  is never called for system fields.
- Shared `paginateAtlassian` utility with four termination conditions and structured logs.
- `BackupPointManifestWriter` with zero-silent-omission guarantee (integrity + omission
  checks; raises `ManifestIntegrityError` / `ManifestOmissionError`).
- Onboarding UI: Project scope selector and JSM out-of-scope notice.
- DB migrations 003 (`backup_points`), 004 (`workload_config`), 005 (`manifest_entries`).

### Changed
- **BREAKING** — Backup job now requires the context-node capture phase to complete before
  Protected Object (Issue) capture begins. Jobs started against the Phase 1 API surface
  without this ordering will fail manifest integrity checks.
  Migration: upgrade both backend and frontend together.

---

## [1.0.0-phase-1] — 2026-05-03 — OAuth Authentication & Connector Foundation (Sprints 1–2)

### Added
- OAuth 2.0 (3LO) redirect flow (`JiraOAuthHandler`) with HTTPS-only callback enforcement.
  Scope set: `read:jira-user read:jira-work write:jira-work manage:jira-project
  manage:jira-configuration read:me offline_access`.
- Site picker UI driven by `GET /oauth/token/accessible-resources` with single-site auto-select.
- Credential store (`JiraCredentialRepository`) persisting `{ cloudId, accessToken,
  refreshToken, oauthClientId }` atomically via `BEGIN IMMEDIATE` transaction.
- Canonical `JiraHttpClient` with mutex-guarded rotating-refresh-token handler:
  concurrent 401s queue behind a single in-flight refresh; both tokens written
  before mutex is released.
- Manual API Token (HTTP Basic) fallback path (`ManualAuthRouter`) with field validation
  and live verification call.
- Workload Card: protected object types, JSM exclusion notice, HTTP 401/403 error banners.
- `OAuthStateStore` for CSRF nonce management (single-use, 10-min TTL).
- DB migrations 001 (`jira_credentials`), 002 (`api_token_credentials`).
- DB migrations 006 (`jobs`), 007 (`restore_jobs`) added in later sprints.

### Changed
- **BREAKING** — `manage:jira-configuration` scope added (Sprint 2) to support workflow and
  custom field management during restore. Existing OAuth grants without this scope must
  re-consent.
  Migration: click **Reconnect** in the Workload Card; grant all seven scopes on the
  Atlassian consent screen.
- **BREAKING** — `offline_access` scope required for refresh token issuance. Grants issued
  without `offline_access` cannot be refreshed unattended.
  Migration: same reconnect flow as above.

---

## Phase-1 Limitations / Not in this release

These items are intentionally deferred. See `docs/phase2-backlog.md` for groomed backlog.

| # | Limitation | Phase 2 item |
|---|---|---|
| 1 | **JSM objects** (JSMTicket, JSMQueue, JSMRequestType, JSMSLAM) not backed up or restored | Phase 2 item 1 (~52 SP) |
| 2 | **Audit Log** backup not implemented (scope confirmation pending) | Phase 2 item 2 (~21 SP) |
| 3 | **Cross-site restore** not supported — `accountId` and custom field IDs are site-scoped | Phase 2 item 3 (~37 SP) |
| 4 | **Incremental backup** not implemented — full snapshot on every run | Phase 2 item 4 (~29 SP) |
| 5 | **GFS (Grandfather-Father-Son) retention** not implemented — flat RPO+Retention only | Co-designed with item 4 |
| 6 | **Blob storage export** (S3 / Azure Blob / GCS) not supported — Browser Download only | Phase 2 |
| 7 | **ADF media link rewriting** not performed post-attachment-restore — best-effort warning only | Phase 2 item 5 (~24 SP) |
| 8 | **Merge conflict mode** not implemented | Phase 2 (rate-limit study first) |
| 9 | **Restore from Atlassian native trash** not supported — alternate-location restore required | Out of scope |
| 10 | **SMB GTM** (sub-50-seat) not targeted | Phase 2 GTM motion |

---

## What's Next — Phase 2

Recommended entry point: **Incremental Backup** (lowest risk, no new scope dependencies).

Sprint 15 proposal: Incremental JQL capture path + IBAN/national ID SDI detectors
(~27 SP). See `docs/handoff-tihomir.md` §5 for full Sprint 15 shape.

Full Phase 2 backlog at `docs/phase2-backlog.md`.

---

## P1 Doc Carry-Forward

The following public functions/classes were found without existing docstrings and have
been assigned stub docstrings in this sprint. Any requiring richer documentation
(parameter-level, non-obvious preconditions, edge cases) are flagged below as P1
carry-forward items for their owner roles.

### `src/db/JiraCredentialRepository.ts` — Backend Developer (P1)

- `JiraCredentialRepository` class: stub docstring added. Needs full per-method JSDoc
  on `upsert()`, `rotateTokens()`, `getByCloudId()`, `getApiTokenByCloudId()` with
  explicit documentation of the atomicity guarantee and null-return contract.

### `src/sdi/detectors/EmailDetector.ts` — Backend Developer (P1)

- `EmailDetector` class: stub docstring added. Needs per-method JSDoc on `scan()` with
  `ScanContext` preconditions and redaction contract.

All other public classes and exported functions in `src/` have file-level or class-level
docstrings. Per-method docstring coverage is generally good in `JiraHttpClient`,
`paginateAtlassian`, `HeartbeatEmitter`, `StalledJobDetector`, `TrashWindowChecker`,
`BrowserDownloadAssembler`, and the manifest writer/repository classes.
