# Sprint Kickoff Handoff Brief — Tihomir

_From: Software Architect | Date: 2026-05-03 | For: Sprint 15 (Phase 2 Kickoff)_
_Status: MVP COMPLETE — Phase 1 (Sprints 1–14) delivered_

---

## 1. MVP State

The Jira Cloud backup/restore connector has completed Phase 1 across 13 delivered sprints
(Sprints 1–13) plus Sprint 14 (current: Hardening & Observability). Every Phase 1 PRD goal
has been implemented and tested. The connector is ready for operator handoff.

**Phase 1 acceptance criteria met:**
- OAuth 2.0 (3LO) authentication with atomic rotating-refresh-token handling ✅
- Paginated Project discovery with zero-silent-omission guarantee ✅
- Full Issue coverage invariant: system fields, all custom field values, ADF comments,
  issue links (both directions), subtasks, sprint membership, watchers, worklogs ✅
- Binary-faithful attachment download via `GET /rest/api/3/attachment/content/{id}` ✅
- Restore dependency-ordered write: Project → Workflow + WorkflowScheme → CustomField +
  FieldConfig → Board → Sprint → Issue body → links/comments/attachments ✅
- Heartbeat progress events ≤10 s; stalled-job detection at >20 s; "Completed with N errors"
  status for partial failures ✅
- SDI teaser scanner (email, API key/secret, credit card, phone) with GDPR + PCI DSS tags ✅
- Protected Object Inventory UI sidebar with four object types + per-row counts ✅
- Restore wizard: three conflict modes (Override, Skip [default], Ask); three destinations
  (Original location, Alternate location, Browser Download) ✅
- Trash-window block for in-place restore with alternate-location guidance ✅

---

## 2. What Shipped — Phase Summary (Sprints 1–13)

### Phase 1: OAuth Authentication & Connector Foundation (Sprints 1–2)
- OAuth 3LO redirect flow, `accessible-resources` site picker, single-site auto-select.
- Credential store with atomic `{ cloudId, accessToken, refreshToken, oauthClientId }`.
- Canonical `JiraHttpClient` with mutex-guarded rotating-refresh handler; concurrent
  refresh requests queue behind a single in-flight refresh.
- Manual API Token (HTTP Basic) fallback path with form validation.
- Workload Card: protected object types, JSM exclusion notice, 401/403 error banners.
- Key files: `src/http/JiraHttpClient.ts`, `src/auth/JiraOAuthHandler.ts`,
  `src/db/JiraCredentialRepository.ts`, `frontend/src/components/WorkloadCard.tsx`.

### Phase 2: Discovery & Context Node Capture (Sprints 3–4)
- Paginated Project discovery via `GET /rest/api/3/project/search` (All / Selected scope).
- JSM `service_desk` project detection → out-of-scope manifest annotation.
- Context-node capture pipeline in strict order:
  IssueType → CustomField + FieldConfiguration → Workflow + WorkflowScheme →
  Project → Board → Sprint.
- Custom field context discovery gated on `custom: true` — system fields never passed
  to `GET /rest/api/3/field/{id}/context`.
- Shared `paginateAtlassian` utility; backup point manifest with zero-silent-omission guarantee.
- Key files: `src/capture/ContextNodeCaptureOrchestrator.ts`,
  `src/discovery/ProjectDiscoveryService.ts`, `src/manifest/BackupPointManifestWriter.ts`,
  `src/pagination/paginateAtlassian.ts`.

### Phase 3: Issue & Attachment Backup Engine (Sprints 5–7)
- Issue search via `POST /rest/api/3/search/jql` — deprecated `GET /rest/api/3/search`
  is forbidden in the codebase (enforced by `scripts/check-deprecated-endpoint.sh`).
- Pagination terminates on `issues.length === 0` or `issues.length < maxResults`.
- Full Issue payload capture in `IssueCaptureOrchestrator`.
- Binary-faithful attachment download; `AttachmentBlobStore` for content storage.
- Progress heartbeat emitter (≤10 s) + stalled-job detector (>20 s threshold).
- Per-item error aggregation → "Completed with N errors" final status.
- SSE endpoint for live job progress consumption by UI.
- Structured logs + metrics via `BackupMetrics`; `[jira-backup]` log namespace.
- Key files: `src/capture/IssueCaptureOrchestrator.ts`, `src/jobs/HeartbeatEmitter.ts`,
  `src/jobs/StalledJobDetector.ts`, `src/metrics/BackupMetrics.ts`.

### Phase 4: SDI Teaser Scanner (Sprint 8)
- Pattern detectors: `EmailDetector`, `ApiKeySecretDetector`, `CreditCardDetector` (Luhn),
  `PhoneDetector`.
- File-type handlers: `XmlEntitiesHandler`, `TabularHandler` (.csv/.xlsx/.tsv),
  `ConfigHandler` (.env/.yaml/.yml/.json/.toml/.properties/.config),
  `PlainTextHandler` (.txt/.log/.md).
- Regulation tags: email/phone → GDPR; credit card → PCI DSS.
- SDI results surfaced on Protected Object cards without operator action.
- Scanner integrated into backup post-processing pipeline.
- Key files: `src/sdi/SdiScanner.ts`, `src/sdi/detectors/`, `src/sdi/handlers/`.

### Phase 5: Protected Object Inventory & Browse UI (Sprints 9–10)
- Inventory sidebar: Issues (default), Projects, Boards, Sprints — per-row counts from
  latest backup manifest.
- Issues table: Issue Key, Summary, Issue Status, Issue Type, Assignee + platform
  Status / Policy / Last Backup. Distinct "Issue Status" vs "Status" column labelling.
- Global Search: `projectKey`, `projectName`, `boardName`, `sprintName` → typed
  Protected Object cards.
- Project Inventory Search: issueKey exact match + tokenised summary search.
- Filters: status, issueType, priority, assigneeAccountId, labels, updated date range.
- Key files: `frontend/src/components/InventorySidebar.tsx`, `IssuesTable.tsx`,
  `GlobalSearchBar.tsx`, `ProjectInventorySearch.tsx`, `src/inventory/InventoryRouter.ts`.

### Phase 6: Restore Engine & Wizard (Sprints 11–13)
- Restore wizard UI: three steps (conflict mode → destination → confirm).
- Conflict modes: Override, Skip (default), Ask per conflict.
- Destination options: Original location, Alternate location (same site), Browser Download.
- Dependency-ordered restore engine with phase-halt diagnostic on failure.
- Trash-window detection: projects in Atlassian's 60-day trash window are blocked for
  in-place restore; alternate-location guidance shown.
- ADF media link breakage best-effort warning in restore report.
- Browser Download export: `BrowserDownloadAssembler` generates ZIP via JSZip.
- Restore heartbeat and structured restore metrics.
- Key files: `src/restore/RestoreEngine.ts`, `RestorePhaseHandlers.ts`,
  `TrashWindowChecker.ts`, `BrowserDownloadAssembler.ts`,
  `frontend/src/components/RestoreWizard.tsx`.

---

## 3. Known Limitations (Phase 1)

| # | Limitation                                        | Source           | Resolution Path              |
|---|---------------------------------------------------|------------------|------------------------------|
| 1 | ADF media node refs break after attachment restore | T5 OQ-5          | Phase 2 item 5 (ADF rewrite) |
| 2 | Incremental backup not implemented — full snapshot each run | T3 §4.3 | Phase 2 item 4              |
| 3 | JSM objects (ticket/queue/SLA) excluded entirely  | T2 §6 C11        | Phase 2 item 1               |
| 4 | Cross-site restore blocked (no cloudId remapping) | T2 OQ-3          | Phase 2 item 3               |
| 5 | Audit log not captured                            | T6 OQ-2          | Phase 2 item 2 (scope TBD)   |
| 6 | Export destination = Browser Download only; no S3/Azure/GCS | T5 §5.2 | Phase 2 (blob storage)  |
| 7 | GFS retention not implemented (flat RPO+Retention)| T4 §2            | Phase 2 (co-design with incr.)|
| 8 | Merge conflict mode not implemented               | T5 §5.1          | Phase 2 (rate-limit study first) |
| 9 | Restore from Atlassian native trash not supported | T5 §4.2          | Out of scope (not Phase 2)   |
| 10| Sub-50-seat SMB GTM not targeted                  | T1 §2            | Phase 2 GTM motion           |

---

## 4. Carry-Forward Items (Require Sprint 15 Attention)

These items were scoped but not fully closed in Phase 1 hardening:

### 4a. IBAN / National ID Detectors
The SDI scanner shipped with email, API key/secret, credit card (Luhn), and phone detectors.
IBAN and national ID (e.g. SSN, NI number, NINO) patterns were identified as high-value
GDPR signals but were not included in the Phase 1 teaser profile. These require:
- Pattern research per jurisdiction (UK NI, US SSN, EU IBAN, DE Personalausweis, etc.).
- Luhn-equivalent validation for IBAN (ISO 13616 MOD 97).
- Regulation tag mapping: IBAN/national ID → GDPR.
- Addition to `src/sdi/detectors/` following the existing `Detector` interface.

Recommended sizing: **8 SP** (detectors + handlers + QA).

### 4b. SDI Precision Telemetry
Current SDI scan results report detected-type counts per file but do not emit structured
metrics on false-positive rates, scan duration per file type, or detector hit rates.
Without this telemetry, tuning detector precision in production is blind. Required:
- Per-detector hit count and scan duration metrics.
- False-positive sampling mechanism (operator-flagged dismissal tracked in DB).
- Metrics emitted via `BackupMetrics` / `RestoreMetrics` pattern.

Recommended sizing: **5 SP**.

### 4c. Full SDI Remediation Workflows on Protected Object Cards
`docs/architecture/sdi-remediation-scope.md` was produced in Sprint 10 to scope this work.
Phase 1 surfaces SDI findings on cards but provides no operator action (dismiss, escalate,
export finding, annotate). Full remediation workflows require:
- Dismissal action with operator-annotated reason (stored in DB).
- Finding export (JSON/CSV download per card).
- Escalation pathway (webhook or email notification — platform capability dependency).
- UI changes to `ProtectedObjectCard.tsx`.

Recommended sizing: **13 SP** (backend + UI + QA).

### 4d. Performance Validation of Global Search
The `InventoryRouter` Global Search endpoint was implemented against a mock manifest.
No load test has been run against a realistic manifest size (50k+ issues, 1k+ boards,
5k+ sprints). Before Phase 2 GA, a performance gate is required:
- Latency target: P99 < 500 ms for Global Search at 100k manifest entries.
- Index strategy for `backupPoints` + `manifestEntries` tables.
- If SQLite FTS5 is insufficient at scale, migrate search to Postgres full-text index.

Recommended sizing: **8 SP** (benchmarking + index tuning + migration plan if needed).

---

## 5. Recommended Sprint 15 Shape (Phase 2 Kickoff)

**Sprint goal:** Begin Phase 2 with the lowest-risk, highest-value item — Incremental
Backup — while closing carry-forward precision gaps from Phase 1 hardening.

### Proposed Sprint 15 Backlog

| Role               | Task                                                                          | Depth    | SP  |
|--------------------|-------------------------------------------------------------------------------|----------|-----|
| Software Architect | Design incremental backup delta manifest schema and tombstone strategy        | Standard | 3   |
| Backend Developer  | Implement incremental JQL capture path in `IssueCaptureOrchestrator`         | Deep     | 5   |
| Backend Developer  | Implement delta manifest + base-snapshot reference                            | Standard | 3   |
| Backend Developer  | IBAN + national ID detectors for SDI scanner                                  | Standard | 5   |
| Frontend Developer | Backup point UI: distinguish full vs incremental points                       | Standard | 3   |
| QA Engineer        | Incremental capture integration tests + tombstone detection proof             | Standard | 5   |
| QA Engineer        | SDI detector tests for IBAN + national ID patterns                            | Quick    | 3   |
| **Total**          |                                                                               |          | **27 SP** |

### What is deferred out of Sprint 15
- JSM objects — blocked on OQ-1 (Calendar API scope confirmation).
- Cross-site restore — blocked on UX design for mapping table.
- Full SDI remediation workflows — large; plan for Sprint 16–17.
- Performance validation of Global Search — schedule as a dedicated spike in Sprint 16.

### Useful Context for Tihomir
- The `paginateAtlassian` utility in `src/pagination/paginateAtlassian.ts` is the
  canonical pagination function — all new list endpoints must use it.
- The `JiraHttpClient` in `src/http/JiraHttpClient.ts` is the only HTTP client that
  may be used against Atlassian APIs. Do not instantiate raw `fetch` or `axios` in
  feature code.
- The deprecated `GET /rest/api/3/search` endpoint is blocked by
  `scripts/check-deprecated-endpoint.sh` which runs in `npm run build`. Any PR that
  reintroduces it will fail the build gate.
- All backup/restore jobs must emit progress heartbeats ≤10 s and surface the
  "stalled" alert at >20 s — this is a global engineering standard, not optional.
- The restore dependency order is contractual (T1 §1) — any new object type added in
  Phase 2 must be placed correctly in `RestorePhaseHandlers.ts`.
- Open design contract filed in `docs/design-requests/restore-unit-and-sidebar-filters.md`
  — Figma spec for restore-unit and Board/Sprint sidebar filters is still outstanding
  from Design. Follow up before Sprint 16 frontend work begins.

---

## 6. Reference

| Document                              | Location                                    |
|---------------------------------------|---------------------------------------------|
| Phase 2 Backlog (groomed)             | `docs/phase2-backlog.md`                    |
| PRD (Phase 1)                         | `docs/JIRA Cloud — Phase 1 MVP PRD (2).md`  |
| Restore Architecture                  | `docs/restore-architecture.md`              |
| SDI Scanner Architecture              | `docs/sdi-scanner.md`                       |
| SDI Remediation Scope                 | `docs/architecture/sdi-remediation-scope.md`|
| Inventory UI Architecture             | `docs/architecture/inventory-ui.md`         |
| Project Inventory Search Contract     | `docs/architecture/project-inventory-search.md` |
| Restore Engine Architecture           | `docs/architecture/restore-engine.md`       |
| Open Contracts Log                    | `docs/open-contracts.md`                    |
| Design Request (sidebar filters)      | `docs/design-requests/restore-unit-and-sidebar-filters.md` |
