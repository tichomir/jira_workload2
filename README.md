# jira_workload_2 — Jira Cloud Backup & Restore

Automated daily backup and granular point-in-time restore for Atlassian Jira Cloud.
Protects against accidental deletion — deleted Issues are permanently gone with no
native undo; deleted Projects enter a 60-day trash window after which all data is
irrecoverable. This connector fills that gap.

**Audience:** Operators running the Phase-1 MVP on 50+ seat Jira Cloud deployments.

---

## Quick Start (5 minutes)

> Full installation instructions — including OAuth app setup, env vars, container
> deployment, and operations — are in **[INSTALL.md](INSTALL.md)**.

### Prerequisites

- Node 20+
- Podman 4+ (Docker-compatible)
- mkcert (for HTTPS callback in local dev)

### Steps

```sh
# 1. Clone and install dependencies
git clone <repo-url> jira_workload_2
cd jira_workload_2
npm install

# 2. Generate local HTTPS certificates (required — Atlassian rejects HTTP callbacks)
mkcert -install
mkcert localhost 127.0.0.1

# 3. Copy and fill in env vars (CLIENT_ID, CLIENT_SECRET, etc.)
cp .env.example .env
$EDITOR .env

# 4. Start the stack
./start.sh
```

The app starts on `https://localhost:3000`. Navigate to the Jira connector and click
**Connect** to begin the OAuth flow.

See [INSTALL.md](INSTALL.md) for the complete walkthrough, including:
- Exact OAuth scope list to configure in the Atlassian Developer Console
- Container / production deployment with Caddy HTTPS termination
- Operations: log locations, credential rotation, backup-point inspection

---

## Feature Matrix

### Phase 1 — In this release

| Area | Details |
|---|---|
| **Object types** | Issues, Projects, Boards, Sprints, Workflows, WorkflowSchemes, CustomFields, FieldConfigurations, Attachments |
| **Issue coverage** | System fields, all custom field values (`customFieldValues` map, no field skipped), ADF comments, issue links (both directions), subtasks, sprint membership, watchers, worklogs |
| **Attachments** | Binary-faithful download: byte-for-byte, original MIME type, original filename, no transcoding |
| **Backup trigger** | Daily full snapshot; manual trigger via UI |
| **Search endpoint** | `POST /rest/api/3/search/jql` only (deprecated `GET /rest/api/3/search` is blocked at build time) |
| **Restore conflict modes** | Skip (default), Override, Ask per conflict |
| **Restore destinations** | Original location, Alternate location (same Jira site), Browser Download (ZIP export) |
| **Trash-window handling** | In-place restore blocked for projects in Atlassian's 60-day trash window; alternate-location guidance shown |
| **OAuth scopes** | `read:jira-user read:jira-work write:jira-work manage:jira-project manage:jira-configuration read:me offline_access` |
| **Auth fallback** | Manual API Token (HTTP Basic) path |
| **Sensitive Data Intelligence** | Detects email, API keys/secrets, credit card numbers (Luhn), phone numbers across backup artifacts; activates GDPR and PCI DSS regulation tags |
| **Inventory UI** | Protected Object sidebar: Issues (default), Projects, Boards, Sprints with per-row counts; Global Search; Project Inventory Search with filters |
| **Observability** | Heartbeat progress events ≤10 s; stalled-job alert at >20 s; "Completed with N errors" on partial failure; per-item traceability to backup-point ID |
| **Storage** | SQLite credential store + manifest store (persistent volumes in container runtime) |

### Phase 2 — Deferred / Not in this release

| Item | Reason deferred |
|---|---|
| **JSM objects** (JSMTicket, JSMQueue, JSMRequestType, JSMSLAM) | Requires `read:servicedesk-request:jira` scope; Calendar API OQ unresolved |
| **Audit Log backup** | Scope not confirmed (`read:audit-log:jira` vs `manage:jira-configuration`) |
| **Cross-site restore** | `accountId` and custom field IDs are site-scoped; remapping table design outstanding |
| **Incremental backup** | Full-snapshot model in Phase 1; `updated >=` JQL path + tombstone detection is Phase 2 |
| **GFS (Grandfather-Father-Son) retention** | Flat RPO+Retention in Phase 1; GFS co-designed with incremental backup |
| **Blob storage export** (S3 / Azure Blob / GCS) | Browser Download only in Phase 1 |
| **ADF media link rewriting** | Restored attachments get new IDs; ADF `media` node refs may break; full rewrite pass is Phase 2 |
| **Merge conflict mode** | No read-compare-write cycle; deferred pending rate-limit study |
| **SMB GTM motion** | Sub-50-seat customers are a Phase 2 target |
| **Restore from Atlassian native trash** | Native trash integration out of scope |

---

## Documentation

| Document | Purpose |
|---|---|
| [INSTALL.md](INSTALL.md) | Prerequisites, local dev setup, container deployment, operations |
| [DEMO.md](DEMO.md) | End-to-end walkthrough: connect → backup → browse → restore |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component map, data flow, object model, key invariants |
| [CHANGELOG.md](CHANGELOG.md) | Release history with breaking-change markers |

---

## Project Structure

```
src/           Backend (TypeScript / Node 20)
  auth/        OAuth 3LO handler, scope definitions
  http/        JiraHttpClient — the single canonical authenticated HTTP client
  capture/     Context-node and Issue capture orchestrators
  backup/      Attachment blob store
  restore/     Dependency-ordered restore engine, phase handlers, wizard API
  sdi/         Sensitive Data Intelligence scanner (detectors + file handlers)
  inventory/   Object inventory API
  jobs/        Heartbeat emitter, stalled-job detector, job event bus
  manifest/    Backup point manifest writer and repository
  pagination/  Shared paginateAtlassian utility
  discovery/   Project discovery service
  db/          Credential repository (SQLite via better-sqlite3)

frontend/      React + Vite + Tailwind UI
  src/
    components/ ConnectButton, InventorySidebar, IssuesTable, RestoreWizard, …

e2e/           Playwright end-to-end tests (sprints 1–14)
tests/         Integration test suites with evidence JSON
db/migrations/ SQLite schema migrations (001–007)
scripts/       CI gates (check-deprecated-endpoint.sh, log-audit.sh)
```

---

## Phase 2 & Handoff

- [Phase 2 Backlog](docs/phase2-backlog.md) — JSM, Audit Log, cross-site restore,
  incremental backup, ADF media link rewrite; each with scope, open questions,
  rough sizing (52 / 21 / 37 / 29 / 24 SP respectively), and dependencies.
- [Sprint Kickoff Handoff Brief — Tihomir](docs/handoff-tihomir.md) — MVP state,
  what shipped across Phases 1–6, known Phase 1 limitations, carry-forward items,
  and recommended Sprint 15 shape.
