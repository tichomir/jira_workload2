# JIRA_WORKLOAD_2 — Project Intelligence

_Auto-maintained by PersonaForge. Updated at sprint start, after every role checkpoint, and at sprint end._
_Read this file BEFORE `.persona-snapshot.md` and BEFORE any exploration._
_It tells you what has been built, in what order, and key decisions made._

## Project Context

Executive Summary
Jira Cloud is Atlassian's multi-tenant SaaS issue-tracking platform, hosted on AWS, serving software delivery, IT, and business project teams. Atlassian's Shared Responsibility Model explicitly excludes customer-initiated destructive changes from infrastructure backup recovery — deleted Issues are permanently destroyed with no native undo, and deleted Projects enter a 60-day trash window after which all contained data is irrecoverable (T1 §2). This workload delivers automated daily backup and granular point-in-time restore for the Phase 1 object set — Issues, Projects, Boards, Sprints, Workflows, Custom Fields, and Attachments — via Atlassian's OAuth 2.0 (3LO) surface, reusing the auth architecture established in the Confluence Cloud pilot. The Phase 1 contract is: every Issue's system and custom field values round-trip completely (the coverage invariant), restore dependency ordering is enforced automatically (Project → Workflow + WorkflowScheme → CustomField + FieldConfiguration → Board → Sprint → Issue), and Sensitive Data Intelligence scanning surfaces GDPR and PCI DSS exposure without operator intervention.

2. Goals
Goal: The DCC connector authenticates to a Jira Cloud site via OAuth 2.0 (3LO) using the scope set defined in T2 §4.2.2. The authorizing account holds Site Admin or Atlassian Organization Admin role. On completion, GET https://api.atlassian.com/me returns HTTP 200 with a valid accountId and the connection credential store contains a non-null accessToken and refreshToken. Source: T2 §4.2, §4.5.

Goal: The backup connector discovers all Projects on the connected Jira Cloud site via paginated GET /rest/api/3/project/search, scoped by the "Project scope" configuration field (All projects / Selected projects). Discovery completes with zero silent omissions — every project returned by the API is represented in the backup point manifest. Source: T3 §4.3, T4 §6.

Goal: Every Issue backed up captures all properties defined in T3 §3.3 for the Issue object type: system fields, all custom field values (customFieldValues map, no field skipped), all comments (ADF body + author + timestamps), all issue links (all link types, both directions), subtask references, sprint membership, attachment references, watchers, and worklogs. This is the primary coverage invariant. Source: T3 §3.5.

Goal: Attachments are stored binary-faithful — byte-for-byte, original MIME type, original filename, no transcoding or recompression — via GET /rest/api/3/attachment/content/{id} through the canonical authenticated HTTP client. Source: T3 §3.2, §4.4.

Goal: The backup engine enforces the restore dependency capture order: IssueType → CustomField + FieldConfiguration → Workflow + WorkflowScheme → Project → Board → Sprint → Issue. Context node capture is always performed before Protected Object capture in every backup job. Source: T1 §1, T3 §3.4.

Goal: The restore engine enforces the write dependency order: Project → Workflow + WorkflowScheme → CustomField + FieldConfiguration → Board → Sprint → Issue body → issue links + comments + attachments (post-issue-creation pass). A failure in any phase halts execution and surfaces a named diagnostic before the next phase begins. Source: T1 §1, T2 §6 Constraint 8, T5 §5.2.

Goal: The canonical authenticated HTTP client handles rotating refresh tokens atomically: on every POST https://auth.atlassian.com/oauth/token refresh, both the new access_token and new refresh_token are written to the credential store before the mutex is released. Concurrent refresh requests queue behind a single in-flight refresh. Source: T2 §4.5, §6 Constraint 4.

Goal: The search endpoint used for all Issue discovery and backup is POST /rest/api/3/search/jql. The deprecated GET /rest/api/3/search endpoint is not used anywhere in the codebase. Pagination terminates on issues.length === 0 or issues.length < maxResults. Source: T2 §4.5, §6 Constraint 6.

Goal: Custom field context discovery calls GET /rest/api/3/field/{id}/context only for fields where custom: true. System fields (custom: false) are never passed to the context endpoint. Source: T2 §6 Constraint 7, T3 §4.2.

Goal: The SDI teaser scanner detects email addresses, API keys / secret tokens, credit card numbers, and phone numbers across entities.xml, tabular exports (.csv, .xlsx, .tsv), developer configuration attachments (.env, .yaml, .yml, .json, .toml, .properties, .config), and text/log attachments (.txt, .log, .md). On detection of email or phone data, the GDPR regulation tag activates. On detection of credit card data, the PCI DSS regulation tag activates. Source: T7 §2, §3, §4.

Goal: The Protected Object Inventory view sidebar renders four object types — Issues (JiraIssue), Projects (JiraProject), Boards (JiraBoard), Sprints (JiraSprint) — with Issues as the default selection. Each sidebar row shows a count of discovered objects from the most recent backup point manifest. Source: T8 §2, §3.

Goal: The restore wizard supports three conflict modes (Override, Skip, Ask per conflict) with Skip as the default. Destination options are Original location, Alternate location (same Jira site), and Export/Browser Download. Cross-site and Cross-tenant restore are not supported in Phase 1. Source: T5 §5.1, §5.2.

Goal: Backup and restore jobs each emit a progress event every ≤10 seconds. A job with no heartbeat for >20 seconds surfaces a "stalled" alert in the UI. A backup that completes with per-item errors displays "Completed with N errors" — not "Completed successfully." Each backed-up item is traceable to a backup-point ID and timestamp via a single UI click. Source: T5 §6.2, §6.2b.

3. Non-Goals
The following are explicitly deferred to Phase 2 or out of scope for engineering entirely.

Deferred to Phase 2:

Jira Service Management (JSM) objects — JSMTicket, JSMQueue, JSMRequestType, JSMSLAM. Not in scope even for sites whose project type is service_desk; JSM-specific metadata is excluded from Phase 1 backup and restore. The onboarding wizard surfaces an out-of-scope notice when service_desk project type is detected. (T1 §1, T2 §6 Constraint 11, T3 §3.2)
Audit Log backup — AuditLog node type; requires read:audit-log:jira or coverage under manage:jira-configuration, pending Engineering confirmation (T6 OQ-2). (T1 §1, T3 §3.2, T6 §2)
Cross-site restore — restoring a backup from Site A (cloudId A) to Site B (cloudId B). Atlassian accountIds and custom field IDs are site-scoped and not portable without remapping tables. (T2 OQ-3, T5 §5.2)
Incremental backup — the Phase 1 model is a full-snapshot daily backup. Incremental via updated >= {lastBackupTimestamp} is a Phase 2 performance optimisation. (T3 §4.3)
Custom backup window — backup timing is platform-managed. No per-workload schedule exposure in Phase 1. (T4 §3)
GFS (Grandfather-Father-Son) retention — flat RPO+Retention (Configuration A) is the Phase 1 model. GFS re-evaluation is gated on a named JSM-compliance customer requirement. (T4 §2)
Blob storage export destination — export destination in Phase 1 is Browser Download only. S3 / Azure Blob / GCS export is Phase 2. (T5 §5.2)
ADF media link rewriting post-attachment-restore — restored attachments receive new attachmentId values; ADF media node references in Issue descriptions and comments may break. Best-effort warning in restore report; full rewrite pass is Phase 2. (T5 OQ-5, §7 Constraint 10)
Merge conflict mode — no read-compare-write cycle; deferred given rate-limit constraints. (T5 §5.1)
Full JSM teaser profile — a separate T7 for JSM is Phase 2. (T7 OQ-3)
Restore from Atlassian's native project trash — Projects in the 60-day Atlassian-managed trash window are blocked for in-place restore and must use alternate-location restore; native trash integration is not in scope. (T5 §4.2)
SMB GTM motion — sub-50-seat customers are a Phase 2 target. (T1 §2)
Out of scope (not a Phase 2 item, not engineering scope):

Marketing copy, competitive matrices, BoM collateral, and sales enablement materials — covered by the PMM brief (out-pmm). Do not implement.
BYOS (Bring Your Own Storage) and attestation — out of scope per global agent rules.
DCC region selection — platform-level concern, not workload-specific. (T2 §5.1)
Compliance reset as a workload capability. (Global agent rules)

---

## Sprint History
### Sprint 1 - OAuth 3LO Foundation & Credential Store | 2026-05-03 | ⏳ in progress | 17 SP est.
**Goal:** [Phase: OAuth Authentication & Connector Foundation — Sprint 1 of 2]
Establish the OAuth 2.0 (3LO) connection flow to Jira Cloud, the canonical authenticated HTTP client with atomic rotating-refresh-token handling, and the manual API Token fallback path. This phase reuses Confluence pilot auth architecture and lays the groundwork all later phases depend on.

Deliverables (across all sprints in this phase):
- OAuth 2.0 (3LO) redirect flow with full scope set from T2 §4.2.2 and HTTPS-only callback enforcement
- Site picker UI driven by GET /oauth/token/accessible-resources with single-site auto-select
- Credential store schema persisting cloudId, accessToken, refreshToken, oauthClientId atomically
- Canonical authenticated HTTP client with mutex-guarded rotating refresh-token handler queuing concurrent refreshes
- Manual connection path with API Token (HTTP Basic) and form validation (Site URL, Cloud ID, email, token)
- Workload Card rendering protected object types and explicit JSM exclusion notice
- Error banner mappings for HTTP 401/403 with reconnect affordance

This is sprint 1 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 1 - OAuth 3LO Foundation & Credential Store | 2026-05-03 | ✅ Software Architect checkpoint (1/1 done)

- ✅ Define OAuth flow architecture and credential store schema (◈ Standard, 3 SP)

---
### Sprint 1 - OAuth 3LO Foundation & Credential Store | 2026-05-03 | ✅ Backend Developer checkpoint (1/1 done)

- ✅ Implement OAuth 3LO redirect flow and accessible-resources callback handler (◉ Deep, 5 SP)

---
### Sprint 1 - OAuth 3LO Foundation & Credential Store | 2026-05-03 | ✅ done | 17 SP
**Goal:** [Phase: OAuth Authentication & Connector Foundation — Sprint 1 of 2]
Establish the OAuth 2.0 (3LO) connection flow to Jira Cloud, the canonical authenticated HTTP client with atomic rotating-refresh-token handling, and the manual API Token fallback path. This phase reuses Confluence pilot auth architecture and lays the groundwork all later phases depend on.

Deliverables (across all sprints in this phase):
- OAuth 2.0 (3LO) redirect flow with full scope set from T2 §4.2.2 and HTTPS-only callback enforcement
- Site picker UI driven by GET /oauth/token/accessible-resources with single-site auto-select
- Credential store schema persisting cloudId, accessToken, refreshToken, oauthClientId atomically
- Canonical authenticated HTTP client with mutex-guarded rotating refresh-token handler queuing concurrent refreshes
- Manual connection path with API Token (HTTP Basic) and form validation (Site URL, Cloud ID, email, token)
- Workload Card rendering protected object types and explicit JSM exclusion notice
- Error banner mappings for HTTP 401/403 with reconnect affordance

This is sprint 1 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

**Delivered:**
- ✅ Define OAuth flow architecture and credential store schema — Software Architect (◈ Standard, 3 SP)
- ✅ Implement credential store with atomic token rotation — Backend Developer (◈ Standard, 3 SP)
- ✅ Implement OAuth 3LO redirect flow and accessible-resources callback handler — Backend Developer (◉ Deep, 5 SP)
- ✅ Build Site Picker UI with single-site auto-select — Frontend Developer (◈ Standard, 3 SP)
- ✅ QA: end-to-end OAuth happy-path + atomic-refresh fault-injection tests — Qa Engineer (◈ Standard, 3 SP)

---
### Sprint 2 - HTTP Client, Manual Auth Fallback & Workload Card | 2026-05-03 | ⏳ in progress | 22 SP est.
**Goal:** [Phase: OAuth Authentication & Connector Foundation — Sprint 2 of 2]
Establish the OAuth 2.0 (3LO) connection flow to Jira Cloud, the canonical authenticated HTTP client with atomic rotating-refresh-token handling, and the manual API Token fallback path. This phase reuses Confluence pilot auth architecture and lays the groundwork all later phases depend on.

Deliverables (across all sprints in this phase):
- OAuth 2.0 (3LO) redirect flow with full scope set from T2 §4.2.2 and HTTPS-only callback enforcement
- Site picker UI driven by GET /oauth/token/accessible-resources with single-site auto-select
- Credential store schema persisting cloudId, accessToken, refreshToken, oauthClientId atomically
- Canonical authenticated HTTP client with mutex-guarded rotating refresh-token handler queuing concurrent refreshes
- Manual connection path with API Token (HTTP Basic) and form validation (Site URL, Cloud ID, email, token)
- Workload Card rendering protected object types and explicit JSM exclusion notice
- Error banner mappings for HTTP 401/403 with reconnect affordance

This is sprint 2 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 2 - HTTP Client, Manual Auth Fallback & Workload Card | 2026-05-03 | ✅ Backend Developer checkpoint (2/2 done)

- ✅ Implement canonical authenticated HTTP client with mutex-guarded rotating refresh (◉ Deep, 8 SP)
- ✅ Implement manual API Token connection path (HTTP Basic) with backend validation (◉ Deep, 5 SP)

---
### Sprint 2 - HTTP Client, Manual Auth Fallback & Workload Card | 2026-05-03 | ✅ done | 25 SP
**Goal:** [Phase: OAuth Authentication & Connector Foundation — Sprint 2 of 2]
Establish the OAuth 2.0 (3LO) connection flow to Jira Cloud, the canonical authenticated HTTP client with atomic rotating-refresh-token handling, and the manual API Token fallback path. This phase reuses Confluence pilot auth architecture and lays the groundwork all later phases depend on.

Deliverables (across all sprints in this phase):
- OAuth 2.0 (3LO) redirect flow with full scope set from T2 §4.2.2 and HTTPS-only callback enforcement
- Site picker UI driven by GET /oauth/token/accessible-resources with single-site auto-select
- Credential store schema persisting cloudId, accessToken, refreshToken, oauthClientId atomically
- Canonical authenticated HTTP client with mutex-guarded rotating refresh-token handler queuing concurrent refreshes
- Manual connection path with API Token (HTTP Basic) and form validation (Site URL, Cloud ID, email, token)
- Workload Card rendering protected object types and explicit JSM exclusion notice
- Error banner mappings for HTTP 401/403 with reconnect affordance

This is sprint 2 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

**Delivered:**
- ✅ Implement canonical authenticated HTTP client with mutex-guarded rotating refresh — Backend Developer (◉ Deep, 8 SP)
- ✅ Implement manual API Token connection path (HTTP Basic) with backend validation — Backend Developer (◉ Deep, 5 SP)
- ✅ Build Manual Connection form UI with field validation — Frontend Developer (◈ Standard, 3 SP)
- ✅ Build Workload Card with protected object types, JSM exclusion notice, and 401/403 error banner — Frontend Developer (◈ Standard, 3 SP)
- ✅ QA: integration tests for HTTP client refresh, manual auth flow, and Workload Card error states — Qa Engineer (◈ Standard, 3 SP)
- ✅ Fix: Implement manual API Token connection path with HTTP Basic auth and backend validation — Backend Developer (◈ Standard, 3 SP)

---
### Sprint 3 - Project Discovery & JSM Detection | 2026-05-03 | ⏳ in progress | 15 SP est.
**Goal:** [Phase: Discovery & Context Node Capture — Sprint 1 of 2]
Implement Project discovery and the full context-node capture pipeline (IssueType, CustomField + FieldConfiguration, Workflow + WorkflowScheme, Board, Sprint) in the strict order required by the restore dependency contract. Custom field context discovery is gated on the custom:true flag.

Deliverables (across all sprints in this phase):
- Paginated Project discovery via GET /rest/api/3/project/search with All / Selected scope filter
- JSM project-type detection emitting out-of-scope notice in onboarding
- Context-node capture pipeline ordered: IssueType → CustomField + FieldConfiguration → Workflow + WorkflowScheme → Project → Board → Sprint
- Custom field context discovery limited to custom:true fields (system fields skipped)
- Backup point manifest schema with zero-silent-omission guarantee
- Pagination termination logic for all list endpoints

This is sprint 1 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 3 - Project Discovery & JSM Detection | 2026-05-03 | ✅ Software Architect checkpoint (1/1 done)

- ✅ Define context-node capture pipeline architecture and manifest schema (⚡ Quick, 2 SP)

---
### Sprint 3 - Project Discovery & JSM Detection | 2026-05-03 | ✅ Backend Developer checkpoint (1/1 done)

- ✅ JSM project-type detection and out-of-scope manifest annotation (⚡ Quick, 2 SP)

---
### Sprint 3 - Project Discovery & JSM Detection | 2026-05-03 | ✅ done | 15 SP
**Goal:** [Phase: Discovery & Context Node Capture — Sprint 1 of 2]
Implement Project discovery and the full context-node capture pipeline (IssueType, CustomField + FieldConfiguration, Workflow + WorkflowScheme, Board, Sprint) in the strict order required by the restore dependency contract. Custom field context discovery is gated on the custom:true flag.

Deliverables (across all sprints in this phase):
- Paginated Project discovery via GET /rest/api/3/project/search with All / Selected scope filter
- JSM project-type detection emitting out-of-scope notice in onboarding
- Context-node capture pipeline ordered: IssueType → CustomField + FieldConfiguration → Workflow + WorkflowScheme → Project → Board → Sprint
- Custom field context discovery limited to custom:true fields (system fields skipped)
- Backup point manifest schema with zero-silent-omission guarantee
- Pagination termination logic for all list endpoints

This is sprint 1 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

**Delivered:**
- ✅ Define context-node capture pipeline architecture and manifest schema — Software Architect (⚡ Quick, 2 SP)
- ✅ Implement paginated Project discovery via /rest/api/3/project/search — Backend Developer (◉ Deep, 5 SP)
- ✅ JSM project-type detection and out-of-scope manifest annotation — Backend Developer (⚡ Quick, 2 SP)
- ✅ Onboarding UI: Project scope selector and JSM out-of-scope notice — Frontend Developer (◈ Standard, 3 SP)
- ✅ QA: Project discovery integration tests with zero-silent-omission proof — Qa Engineer (◈ Standard, 3 SP)

---
### Sprint 4 - Context Node Capture Pipeline & Manifest | 2026-05-03 | ⏳ in progress | 18 SP est.
**Goal:** [Phase: Discovery & Context Node Capture — Sprint 2 of 2]
Implement Project discovery and the full context-node capture pipeline (IssueType, CustomField + FieldConfiguration, Workflow + WorkflowScheme, Board, Sprint) in the strict order required by the restore dependency contract. Custom field context discovery is gated on the custom:true flag.

Deliverables (across all sprints in this phase):
- Paginated Project discovery via GET /rest/api/3/project/search with All / Selected scope filter
- JSM project-type detection emitting out-of-scope notice in onboarding
- Context-node capture pipeline ordered: IssueType → CustomField + FieldConfiguration → Workflow + WorkflowScheme → Project → Board → Sprint
- Custom field context discovery limited to custom:true fields (system fields skipped)
- Backup point manifest schema with zero-silent-omission guarantee
- Pagination termination logic for all list endpoints

This is sprint 2 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 4 - Context Node Capture Pipeline & Manifest | 2026-05-03 | ◐ Backend Developer checkpoint (1/3 done)

- ✅ Implement context-node capture pipeline orchestrator with strict ordering (◉ Deep, 8 SP)
- ❌ Extract shared pagination termination utility (⚡ Quick, 2 SP)
- ❌ Implement backup point manifest writer with zero-silent-omission guarantee (◉ Deep, 5 SP)

---
### Sprint 4 - Context Node Capture Pipeline & Manifest | 2026-05-03 | 📋 reviewing | 18 SP
**Goal:** [Phase: Discovery & Context Node Capture — Sprint 2 of 2]
Implement Project discovery and the full context-node capture pipeline (IssueType, CustomField + FieldConfiguration, Workflow + WorkflowScheme, Board, Sprint) in the strict order required by the restore dependency contract. Custom field context discovery is gated on the custom:true flag.

Deliverables (across all sprints in this phase):
- Paginated Project discovery via GET /rest/api/3/project/search with All / Selected scope filter
- JSM project-type detection emitting out-of-scope notice in onboarding
- Context-node capture pipeline ordered: IssueType → CustomField + FieldConfiguration → Workflow + WorkflowScheme → Project → Board → Sprint
- Custom field context discovery limited to custom:true fields (system fields skipped)
- Backup point manifest schema with zero-silent-omission guarantee
- Pagination termination logic for all list endpoints

This is sprint 2 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

**Delivered:**
- ✅ Implement context-node capture pipeline orchestrator with strict ordering — Backend Developer (◉ Deep, 8 SP)
- ❌ Implement backup point manifest writer with zero-silent-omission guarantee — Backend Developer (◉ Deep, 5 SP)
- ❌ Extract shared pagination termination utility — Backend Developer (⚡ Quick, 2 SP)
- ⏭ QA: integration tests for context pipeline ordering, custom-field gating, and manifest invariant — Qa Engineer (◈ Standard, 3 SP)

---
### Sprint 5 - Issue Backup Engine via search/jql + Pagination | 2026-05-03 | ⏳ in progress | 26 SP est.
**Goal:** [Phase: Issue & Attachment Backup Engine — Sprint 1 of 3]
Deliver the primary coverage invariant: full Issue capture (system + custom fields, comments, links, subtasks, sprint membership, watchers, worklogs) via POST /rest/api/3/search/jql, plus binary-faithful attachment download. This is the core value-delivery phase.

Deliverables (across all sprints in this phase):
- Issue backup via POST /rest/api/3/search/jql (deprecated GET endpoint forbidden in codebase)
- Full Issue payload capture: system fields, customFieldValues map, ADF comments, issue links (both directions), subtasks, sprint membership, watchers, worklogs
- Binary-faithful attachment download via GET /rest/api/3/attachment/content/{id} preserving bytes, MIME type, and filename
- Pagination termination on issues.length === 0 or < maxResults
- Per-item error tracking emitting 'Completed with N errors' status on partial failure
- Backup-point ID and timestamp traceability for every captured item
- Heartbeat progress events ≤10s with stalled-job detection at >20s

This is sprint 1 of 3 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 5 - Issue Backup Engine via search/jql + Pagination | 2026-05-03 | ✅ Backend Developer checkpoint (4/4 done)

- ✅ Carry-forward: Backup point manifest writer with zero-silent-omission guarantee (◉ Deep, 5 SP)
- ✅ Implement Issue search + pagination via POST /rest/api/3/search/jql (◉ Deep, 5 SP)
- ✅ Issue capture orchestrator with full payload + per-item error tracking (◉ Deep, 8 SP)
- ✅ Binary-faithful attachment download via /rest/api/3/attachment/content/{id} (◈ Standard, 3 SP)

---
### Sprint 5 - Issue Backup Engine via search/jql + Pagination | 2026-05-03 | ✅ done | 29 SP
**Goal:** [Phase: Issue & Attachment Backup Engine — Sprint 1 of 3]
Deliver the primary coverage invariant: full Issue capture (system + custom fields, comments, links, subtasks, sprint membership, watchers, worklogs) via POST /rest/api/3/search/jql, plus binary-faithful attachment download. This is the core value-delivery phase.

Deliverables (across all sprints in this phase):
- Issue backup via POST /rest/api/3/search/jql (deprecated GET endpoint forbidden in codebase)
- Full Issue payload capture: system fields, customFieldValues map, ADF comments, issue links (both directions), subtasks, sprint membership, watchers, worklogs
- Binary-faithful attachment download via GET /rest/api/3/attachment/content/{id} preserving bytes, MIME type, and filename
- Pagination termination on issues.length === 0 or < maxResults
- Per-item error tracking emitting 'Completed with N errors' status on partial failure
- Backup-point ID and timestamp traceability for every captured item
- Heartbeat progress events ≤10s with stalled-job detection at >20s

This is sprint 1 of 3 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

**Delivered:**
- ✅ Carry-forward: Backup point manifest writer with zero-silent-omission guarantee — Backend Developer (◉ Deep, 5 SP)
- ✅ Implement Issue search + pagination via POST /rest/api/3/search/jql — Backend Developer (◉ Deep, 5 SP)
- ✅ Issue capture orchestrator with full payload + per-item error tracking — Backend Developer (◉ Deep, 8 SP)
- ✅ Binary-faithful attachment download via /rest/api/3/attachment/content/{id} — Backend Developer (◈ Standard, 3 SP)
- ✅ QA: Coverage-invariant integration tests for Issue + Attachment capture — Qa Engineer (◉ Deep, 5 SP)
- ✅ Fix: Verify IssueCaptureOrchestrator tests pass after error handling changes — Backend Developer (◈ Standard, 3 SP)

---
### Sprint 6 - Heartbeat, Stalled-Job Detection & Per-Item Error Status | 2026-05-03 | ⏳ in progress | 17 SP est.
**Goal:** [Phase: Issue & Attachment Backup Engine — Sprint 2 of 3]
Deliver the primary coverage invariant: full Issue capture (system + custom fields, comments, links, subtasks, sprint membership, watchers, worklogs) via POST /rest/api/3/search/jql, plus binary-faithful attachment download. This is the core value-delivery phase.

Deliverables (across all sprints in this phase):
- Issue backup via POST /rest/api/3/search/jql (deprecated GET endpoint forbidden in codebase)
- Full Issue payload capture: system fields, customFieldValues map, ADF comments, issue links (both directions), subtasks, sprint membership, watchers, worklogs
- Binary-faithful attachment download via GET /rest/api/3/attachment/content/{id} preserving bytes, MIME type, and filename
- Pagination termination on issues.length === 0 or < maxResults
- Per-item error tracking emitting 'Completed with N errors' status on partial failure
- Backup-point ID and timestamp traceability for every captured item
- Heartbeat progress events ≤10s with stalled-job detection at >20s

This is sprint 2 of 3 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 4 - Context Node Capture Pipeline & Manifest | 2026-05-03 | ⏳ in progress | 18 SP est.
**Goal:** [Phase: Discovery & Context Node Capture — Sprint 2 of 2]
Implement Project discovery and the full context-node capture pipeline (IssueType, CustomField + FieldConfiguration, Workflow + WorkflowScheme, Board, Sprint) in the strict order required by the restore dependency contract. Custom field context discovery is gated on the custom:true flag.

Deliverables (across all sprints in this phase):
- Paginated Project discovery via GET /rest/api/3/project/search with All / Selected scope filter
- JSM project-type detection emitting out-of-scope notice in onboarding
- Context-node capture pipeline ordered: IssueType → CustomField + FieldConfiguration → Workflow + WorkflowScheme → Project → Board → Sprint
- Custom field context discovery limited to custom:true fields (system fields skipped)
- Backup point manifest schema with zero-silent-omission guarantee
- Pagination termination logic for all list endpoints

This is sprint 2 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 4 - Context Node Capture Pipeline & Manifest | 2026-05-03 | ◐ Backend Developer checkpoint (1/3 done)

- ✅ Implement context-node capture pipeline orchestrator with strict ordering (◉ Deep, 8 SP)
- ❌ Extract shared pagination termination utility (⚡ Quick, 2 SP)
- ❌ Implement backup point manifest writer with zero-silent-omission guarantee (◉ Deep, 5 SP)

---
### Sprint 4 - Context Node Capture Pipeline & Manifest | 2026-05-03 | 📋 reviewing | 18 SP
**Goal:** [Phase: Discovery & Context Node Capture — Sprint 2 of 2]
Implement Project discovery and the full context-node capture pipeline (IssueType, CustomField + FieldConfiguration, Workflow + WorkflowScheme, Board, Sprint) in the strict order required by the restore dependency contract. Custom field context discovery is gated on the custom:true flag.

Deliverables (across all sprints in this phase):
- Paginated Project discovery via GET /rest/api/3/project/search with All / Selected scope filter
- JSM project-type detection emitting out-of-scope notice in onboarding
- Context-node capture pipeline ordered: IssueType → CustomField + FieldConfiguration → Workflow + WorkflowScheme → Project → Board → Sprint
- Custom field context discovery limited to custom:true fields (system fields skipped)
- Backup point manifest schema with zero-silent-omission guarantee
- Pagination termination logic for all list endpoints

This is sprint 2 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

**Delivered:**
- ✅ Implement context-node capture pipeline orchestrator with strict ordering — Backend Developer (◉ Deep, 8 SP)
- ❌ Implement backup point manifest writer with zero-silent-omission guarantee — Backend Developer (◉ Deep, 5 SP)
- ❌ Extract shared pagination termination utility — Backend Developer (⚡ Quick, 2 SP)
- ⏭ QA: integration tests for context pipeline ordering, custom-field gating, and manifest invariant — Qa Engineer (◈ Standard, 3 SP)

---
### Sprint 4 - Context Node Capture Pipeline & Manifest | 2026-05-03 | ⏳ in progress | 18 SP est.
**Goal:** [Phase: Discovery & Context Node Capture — Sprint 2 of 2]
Implement Project discovery and the full context-node capture pipeline (IssueType, CustomField + FieldConfiguration, Workflow + WorkflowScheme, Board, Sprint) in the strict order required by the restore dependency contract. Custom field context discovery is gated on the custom:true flag.

Deliverables (across all sprints in this phase):
- Paginated Project discovery via GET /rest/api/3/project/search with All / Selected scope filter
- JSM project-type detection emitting out-of-scope notice in onboarding
- Context-node capture pipeline ordered: IssueType → CustomField + FieldConfiguration → Workflow + WorkflowScheme → Project → Board → Sprint
- Custom field context discovery limited to custom:true fields (system fields skipped)
- Backup point manifest schema with zero-silent-omission guarantee
- Pagination termination logic for all list endpoints

This is sprint 2 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 4 - Context Node Capture Pipeline & Manifest | 2026-05-03 | ✅ Backend Developer checkpoint (2/2 done)

- ✅ Implement backup point manifest writer with zero-silent-omission guarantee (◉ Deep, 5 SP)
- ✅ Extract shared pagination termination utility (⚡ Quick, 2 SP)

---
### Sprint 4 - Context Node Capture Pipeline & Manifest | 2026-05-03 | ✅ done | 21 SP
**Goal:** [Phase: Discovery & Context Node Capture — Sprint 2 of 2]
Implement Project discovery and the full context-node capture pipeline (IssueType, CustomField + FieldConfiguration, Workflow + WorkflowScheme, Board, Sprint) in the strict order required by the restore dependency contract. Custom field context discovery is gated on the custom:true flag.

Deliverables (across all sprints in this phase):
- Paginated Project discovery via GET /rest/api/3/project/search with All / Selected scope filter
- JSM project-type detection emitting out-of-scope notice in onboarding
- Context-node capture pipeline ordered: IssueType → CustomField + FieldConfiguration → Workflow + WorkflowScheme → Project → Board → Sprint
- Custom field context discovery limited to custom:true fields (system fields skipped)
- Backup point manifest schema with zero-silent-omission guarantee
- Pagination termination logic for all list endpoints

This is sprint 2 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

**Delivered:**
- ✅ Implement context-node capture pipeline orchestrator with strict ordering — Backend Developer (◉ Deep, 8 SP)
- ✅ Implement backup point manifest writer with zero-silent-omission guarantee — Backend Developer (◉ Deep, 5 SP)
- ✅ Extract shared pagination termination utility — Backend Developer (⚡ Quick, 2 SP)
- ✅ QA: integration tests for context pipeline ordering, custom-field gating, and manifest invariant — Qa Engineer (◈ Standard, 3 SP)
- ✅ Fix: Complete pagination termination utility extraction — Backend Developer (◈ Standard, 3 SP)

---
### Sprint 6 - Heartbeat, Stalled-Job Detection & Per-Item Error Status | 2026-05-03 | ⏳ in progress | 17 SP est.
**Goal:** [Phase: Issue & Attachment Backup Engine — Sprint 2 of 3]
Deliver the primary coverage invariant: full Issue capture (system + custom fields, comments, links, subtasks, sprint membership, watchers, worklogs) via POST /rest/api/3/search/jql, plus binary-faithful attachment download. This is the core value-delivery phase.

Deliverables (across all sprints in this phase):
- Issue backup via POST /rest/api/3/search/jql (deprecated GET endpoint forbidden in codebase)
- Full Issue payload capture: system fields, customFieldValues map, ADF comments, issue links (both directions), subtasks, sprint membership, watchers, worklogs
- Binary-faithful attachment download via GET /rest/api/3/attachment/content/{id} preserving bytes, MIME type, and filename
- Pagination termination on issues.length === 0 or < maxResults
- Per-item error tracking emitting 'Completed with N errors' status on partial failure
- Backup-point ID and timestamp traceability for every captured item
- Heartbeat progress events ≤10s with stalled-job detection at >20s

This is sprint 2 of 3 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 6 - Heartbeat, Stalled-Job Detection & Per-Item Error Status | 2026-05-03 | ◐ Backend Developer checkpoint (1/3 done)

- ✅ Implement stalled-job detector (>20s no heartbeat) (◈ Standard, 3 SP)
- ❌ Aggregate per-item errors into 'Completed with N errors' final status (◈ Standard, 3 SP)
- ❌ Expose job progress + status via SSE/HTTP endpoint for UI consumption (◈ Standard, 3 SP)

---
### Sprint 6 - Heartbeat, Stalled-Job Detection & Per-Item Error Status | 2026-05-03 | 📋 reviewing | 17 SP
**Goal:** [Phase: Issue & Attachment Backup Engine — Sprint 2 of 3]
Deliver the primary coverage invariant: full Issue capture (system + custom fields, comments, links, subtasks, sprint membership, watchers, worklogs) via POST /rest/api/3/search/jql, plus binary-faithful attachment download. This is the core value-delivery phase.

Deliverables (across all sprints in this phase):
- Issue backup via POST /rest/api/3/search/jql (deprecated GET endpoint forbidden in codebase)
- Full Issue payload capture: system fields, customFieldValues map, ADF comments, issue links (both directions), subtasks, sprint membership, watchers, worklogs
- Binary-faithful attachment download via GET /rest/api/3/attachment/content/{id} preserving bytes, MIME type, and filename
- Pagination termination on issues.length === 0 or < maxResults
- Per-item error tracking emitting 'Completed with N errors' status on partial failure
- Backup-point ID and timestamp traceability for every captured item
- Heartbeat progress events ≤10s with stalled-job detection at >20s

This is sprint 2 of 3 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

**Delivered:**
- ✅ Implement progress heartbeat emitter for backup jobs (≤10s) — Backend Developer (◉ Deep, 5 SP)
- ✅ Implement stalled-job detector (>20s no heartbeat) — Backend Developer (◈ Standard, 3 SP)
- ❌ Aggregate per-item errors into 'Completed with N errors' final status — Backend Developer (◈ Standard, 3 SP)
- ❌ Expose job progress + status via SSE/HTTP endpoint for UI consumption — Backend Developer (◈ Standard, 3 SP)
- ⏭ QA: Fault-injection tests for heartbeat, stall, and partial-failure status — Qa Engineer (◈ Standard, 3 SP)

---
### Sprint 7 - Per-Item Error Aggregation, Progress API & Live Tenant Validation | 2026-05-03 | ⏳ in progress | 17 SP est.
**Goal:** [Phase: Issue & Attachment Backup Engine — Sprint 3 of 3]
Deliver the primary coverage invariant: full Issue capture (system + custom fields, comments, links, subtasks, sprint membership, watchers, worklogs) via POST /rest/api/3/search/jql, plus binary-faithful attachment download. This is the core value-delivery phase.

Deliverables (across all sprints in this phase):
- Issue backup via POST /rest/api/3/search/jql (deprecated GET endpoint forbidden in codebase)
- Full Issue payload capture: system fields, customFieldValues map, ADF comments, issue links (both directions), subtasks, sprint membership, watchers, worklogs
- Binary-faithful attachment download via GET /rest/api/3/attachment/content/{id} preserving bytes, MIME type, and filename
- Pagination termination on issues.length === 0 or < maxResults
- Per-item error tracking emitting 'Completed with N errors' status on partial failure
- Backup-point ID and timestamp traceability for every captured item
- Heartbeat progress events ≤10s with stalled-job detection at >20s

This is sprint 3 of 3 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 7 - Per-Item Error Aggregation, Progress API & Live Tenant Validation | 2026-05-03 | ◐ Backend Developer checkpoint (0/3 done)

- ❌ Aggregate per-item errors into 'Completed with N errors' final status (◉ Deep, 5 SP)
- ❌ Add structured logs/metrics around manifest emission and pagination termination (⚡ Quick, 2 SP)
- ❌ Expose job progress + status via SSE endpoint for UI consumption (◉ Deep, 5 SP)

---
### Sprint 7 - Per-Item Error Aggregation, Progress API & Live Tenant Validation | 2026-05-03 | 📋 reviewing | 17 SP
**Goal:** [Phase: Issue & Attachment Backup Engine — Sprint 3 of 3]
Deliver the primary coverage invariant: full Issue capture (system + custom fields, comments, links, subtasks, sprint membership, watchers, worklogs) via POST /rest/api/3/search/jql, plus binary-faithful attachment download. This is the core value-delivery phase.

Deliverables (across all sprints in this phase):
- Issue backup via POST /rest/api/3/search/jql (deprecated GET endpoint forbidden in codebase)
- Full Issue payload capture: system fields, customFieldValues map, ADF comments, issue links (both directions), subtasks, sprint membership, watchers, worklogs
- Binary-faithful attachment download via GET /rest/api/3/attachment/content/{id} preserving bytes, MIME type, and filename
- Pagination termination on issues.length === 0 or < maxResults
- Per-item error tracking emitting 'Completed with N errors' status on partial failure
- Backup-point ID and timestamp traceability for every captured item
- Heartbeat progress events ≤10s with stalled-job detection at >20s

This is sprint 3 of 3 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

**Delivered:**
- ❌ Aggregate per-item errors into 'Completed with N errors' final status — Backend Developer (◉ Deep, 5 SP)
- ❌ Expose job progress + status via SSE endpoint for UI consumption — Backend Developer (◉ Deep, 5 SP)
- ❌ Add structured logs/metrics around manifest emission and pagination termination — Backend Developer (⚡ Quick, 2 SP)
- ⏭ End-to-end live-tenant validation of capture pipeline — Qa Engineer (◉ Deep, 5 SP)

---
### Sprint 6 - Heartbeat, Stalled-Job Detection & Per-Item Error Status | 2026-05-03 | ⏳ in progress | 17 SP est.
**Goal:** [Phase: Issue & Attachment Backup Engine — Sprint 2 of 3]
Deliver the primary coverage invariant: full Issue capture (system + custom fields, comments, links, subtasks, sprint membership, watchers, worklogs) via POST /rest/api/3/search/jql, plus binary-faithful attachment download. This is the core value-delivery phase.

Deliverables (across all sprints in this phase):
- Issue backup via POST /rest/api/3/search/jql (deprecated GET endpoint forbidden in codebase)
- Full Issue payload capture: system fields, customFieldValues map, ADF comments, issue links (both directions), subtasks, sprint membership, watchers, worklogs
- Binary-faithful attachment download via GET /rest/api/3/attachment/content/{id} preserving bytes, MIME type, and filename
- Pagination termination on issues.length === 0 or < maxResults
- Per-item error tracking emitting 'Completed with N errors' status on partial failure
- Backup-point ID and timestamp traceability for every captured item
- Heartbeat progress events ≤10s with stalled-job detection at >20s

This is sprint 2 of 3 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 6 - Heartbeat, Stalled-Job Detection & Per-Item Error Status | 2026-05-03 | ✅ Backend Developer checkpoint (2/2 done)

- ✅ Aggregate per-item errors into 'Completed with N errors' final status (◈ Standard, 3 SP)
- ✅ Expose job progress + status via SSE/HTTP endpoint for UI consumption (◈ Standard, 3 SP)

---
### Sprint 6 - Heartbeat, Stalled-Job Detection & Per-Item Error Status | 2026-05-03 | ✅ done | 17 SP
**Goal:** [Phase: Issue & Attachment Backup Engine — Sprint 2 of 3]
Deliver the primary coverage invariant: full Issue capture (system + custom fields, comments, links, subtasks, sprint membership, watchers, worklogs) via POST /rest/api/3/search/jql, plus binary-faithful attachment download. This is the core value-delivery phase.

Deliverables (across all sprints in this phase):
- Issue backup via POST /rest/api/3/search/jql (deprecated GET endpoint forbidden in codebase)
- Full Issue payload capture: system fields, customFieldValues map, ADF comments, issue links (both directions), subtasks, sprint membership, watchers, worklogs
- Binary-faithful attachment download via GET /rest/api/3/attachment/content/{id} preserving bytes, MIME type, and filename
- Pagination termination on issues.length === 0 or < maxResults
- Per-item error tracking emitting 'Completed with N errors' status on partial failure
- Backup-point ID and timestamp traceability for every captured item
- Heartbeat progress events ≤10s with stalled-job detection at >20s

This is sprint 2 of 3 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

**Delivered:**
- ✅ Implement progress heartbeat emitter for backup jobs (≤10s) — Backend Developer (◉ Deep, 5 SP)
- ✅ Implement stalled-job detector (>20s no heartbeat) — Backend Developer (◈ Standard, 3 SP)
- ✅ Aggregate per-item errors into 'Completed with N errors' final status — Backend Developer (◈ Standard, 3 SP)
- ✅ Expose job progress + status via SSE/HTTP endpoint for UI consumption — Backend Developer (◈ Standard, 3 SP)
- ✅ QA: Fault-injection tests for heartbeat, stall, and partial-failure status — Qa Engineer (◈ Standard, 3 SP)

---
### Sprint 7 - Per-Item Error Aggregation, Progress API & Live Tenant Validation | 2026-05-03 | ⏳ in progress | 17 SP est.
**Goal:** [Phase: Issue & Attachment Backup Engine — Sprint 3 of 3]
Deliver the primary coverage invariant: full Issue capture (system + custom fields, comments, links, subtasks, sprint membership, watchers, worklogs) via POST /rest/api/3/search/jql, plus binary-faithful attachment download. This is the core value-delivery phase.

Deliverables (across all sprints in this phase):
- Issue backup via POST /rest/api/3/search/jql (deprecated GET endpoint forbidden in codebase)
- Full Issue payload capture: system fields, customFieldValues map, ADF comments, issue links (both directions), subtasks, sprint membership, watchers, worklogs
- Binary-faithful attachment download via GET /rest/api/3/attachment/content/{id} preserving bytes, MIME type, and filename
- Pagination termination on issues.length === 0 or < maxResults
- Per-item error tracking emitting 'Completed with N errors' status on partial failure
- Backup-point ID and timestamp traceability for every captured item
- Heartbeat progress events ≤10s with stalled-job detection at >20s

This is sprint 3 of 3 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 7 - Per-Item Error Aggregation, Progress API & Live Tenant Validation | 2026-05-03 | ✅ Backend Developer checkpoint (3/3 done)

- ✅ Aggregate per-item errors into 'Completed with N errors' final status (◉ Deep, 5 SP)
- ✅ Add structured logs/metrics around manifest emission and pagination termination (⚡ Quick, 2 SP)
- ✅ Expose job progress + status via SSE endpoint for UI consumption (◉ Deep, 5 SP)

---
### Sprint 7 - Per-Item Error Aggregation, Progress API & Live Tenant Validation | 2026-05-03 | ✅ done | 23 SP
**Goal:** [Phase: Issue & Attachment Backup Engine — Sprint 3 of 3]
Deliver the primary coverage invariant: full Issue capture (system + custom fields, comments, links, subtasks, sprint membership, watchers, worklogs) via POST /rest/api/3/search/jql, plus binary-faithful attachment download. This is the core value-delivery phase.

Deliverables (across all sprints in this phase):
- Issue backup via POST /rest/api/3/search/jql (deprecated GET endpoint forbidden in codebase)
- Full Issue payload capture: system fields, customFieldValues map, ADF comments, issue links (both directions), subtasks, sprint membership, watchers, worklogs
- Binary-faithful attachment download via GET /rest/api/3/attachment/content/{id} preserving bytes, MIME type, and filename
- Pagination termination on issues.length === 0 or < maxResults
- Per-item error tracking emitting 'Completed with N errors' status on partial failure
- Backup-point ID and timestamp traceability for every captured item
- Heartbeat progress events ≤10s with stalled-job detection at >20s

This is sprint 3 of 3 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

**Delivered:**
- ✅ Aggregate per-item errors into 'Completed with N errors' final status — Backend Developer (◉ Deep, 5 SP)
- ✅ Expose job progress + status via SSE endpoint for UI consumption — Backend Developer (◉ Deep, 5 SP)
- ✅ Add structured logs/metrics around manifest emission and pagination termination — Backend Developer (⚡ Quick, 2 SP)
- ✅ End-to-end live-tenant validation of capture pipeline — Qa Engineer (◉ Deep, 5 SP)
- ✅ Complete truncated test file for BackupMetrics and pagination logs — Backend Developer (◈ Standard, 3 SP)
- ✅ Fix HeartbeatEmitter.complete() regression for completed_with_errors status — Backend Developer (◈ Standard, 3 SP)

---
### Sprint 8 - SDI Teaser Scanner: Detectors, File Handlers & Pipeline Integration | 2026-05-03 | ⏳ in progress | 21 SP est.
**Goal:** [Phase: Sensitive Data Intelligence Teaser Scanner]
Implement the SDI scanner that detects emails, API keys/secrets, credit card numbers, and phone numbers across entities.xml, tabular exports, dev-config attachments, and text/log files, activating GDPR and PCI DSS regulation tags accordingly.

Deliverables:
- Pattern detectors for email, API keys/secret tokens, credit card numbers (Luhn-validated), phone numbers
- File-type handlers for entities.xml, .csv/.xlsx/.tsv, .env/.yaml/.yml/.json/.toml/.properties/.config, .txt/.log/.md
- Regulation tag activation rules: email/phone → GDPR, credit card → PCI DSS
- SDI scan results surfaced on Protected Object cards without operator action
- Scan integration into the backup post-processing pipeline

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 8 - SDI Teaser Scanner: Detectors, File Handlers & Pipeline Integration | 2026-05-03 | ✅ Software Architect checkpoint (1/1 done)

- ✅ Design SDI scanner architecture and detector interface (⚡ Quick, 2 SP)

---
### Sprint 8 - SDI Teaser Scanner: Detectors, File Handlers & Pipeline Integration | 2026-05-03 | ✅ Backend Developer checkpoint (1/1 done)

- ✅ Implement file-type handlers and scanner orchestrator with pipeline integration (◉ Deep, 8 SP)

---
### Sprint 8 - SDI Teaser Scanner: Detectors, File Handlers & Pipeline Integration | 2026-05-03 | ✅ done | 21 SP
**Goal:** [Phase: Sensitive Data Intelligence Teaser Scanner]
Implement the SDI scanner that detects emails, API keys/secrets, credit card numbers, and phone numbers across entities.xml, tabular exports, dev-config attachments, and text/log files, activating GDPR and PCI DSS regulation tags accordingly.

Deliverables:
- Pattern detectors for email, API keys/secret tokens, credit card numbers (Luhn-validated), phone numbers
- File-type handlers for entities.xml, .csv/.xlsx/.tsv, .env/.yaml/.yml/.json/.toml/.properties/.config, .txt/.log/.md
- Regulation tag activation rules: email/phone → GDPR, credit card → PCI DSS
- SDI scan results surfaced on Protected Object cards without operator action
- Scan integration into the backup post-processing pipeline

**Delivered:**
- ✅ Design SDI scanner architecture and detector interface — Software Architect (⚡ Quick, 2 SP)
- ✅ Implement pattern detectors (email, API key/secret, credit card with Luhn, phone) — Backend Developer (◉ Deep, 5 SP)
- ✅ Implement file-type handlers and scanner orchestrator with pipeline integration — Backend Developer (◉ Deep, 8 SP)
- ✅ Surface SDI findings and regulation tags on Protected Object cards — Frontend Developer (◈ Standard, 3 SP)
- ✅ QA: end-to-end SDI scan validation against live-tenant backup + carry-forward live-tenant capture validation — Qa Engineer (◈ Standard, 3 SP)

---
### Sprint 9 - Inventory Sidebar, Issues Table & Global Search (Phase 5 Sprint 1 of 2) | 2026-05-03 | ⏳ in progress | 18 SP est.
**Goal:** [Phase: Protected Object Inventory & Browse UI — Sprint 1 of 2]
Build the Inventory sidebar (Issues, Projects, Boards, Sprints), the Issues table with the dual Status/Issue Status columns, Global Search across project/board/sprint names, and Project Inventory in-app search with filters.

Deliverables (across all sprints in this phase):
- Inventory sidebar with four object types and per-row counts from the latest backup manifest
- Issues table with columns Issue Key, Summary, Issue Status, Issue Type, Assignee plus platform Status/Policy/Last Backup
- Distinct 'Issue Status' vs 'Status' column header labelling
- Global Search across projectKey, projectName, boardName, sprintName returning typed Protected Object cards
- Project Inventory Search with issueKey exact match and tokenised summary search
- Filters: status, issueType, priority, assigneeAccountId, labels, updated date range
- Open contract logged for Design: Jira-specific Figma spec for restore-unit and Board/Sprint sidebar filters

This is sprint 1 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 9 - Inventory Sidebar, Issues Table & Global Search (Phase 5 Sprint 1 of 2) | 2026-05-03 | ✅ Software Architect checkpoint (1/1 done)

- ✅ Design Inventory UI architecture and manifest data contract (⚡ Quick, 2 SP)

---
### Sprint 9 - Inventory Sidebar, Issues Table & Global Search (Phase 5 Sprint 1 of 2) | 2026-05-03 | ✅ done | 18 SP
**Goal:** [Phase: Protected Object Inventory & Browse UI — Sprint 1 of 2]
Build the Inventory sidebar (Issues, Projects, Boards, Sprints), the Issues table with the dual Status/Issue Status columns, Global Search across project/board/sprint names, and Project Inventory in-app search with filters.

Deliverables (across all sprints in this phase):
- Inventory sidebar with four object types and per-row counts from the latest backup manifest
- Issues table with columns Issue Key, Summary, Issue Status, Issue Type, Assignee plus platform Status/Policy/Last Backup
- Distinct 'Issue Status' vs 'Status' column header labelling
- Global Search across projectKey, projectName, boardName, sprintName returning typed Protected Object cards
- Project Inventory Search with issueKey exact match and tokenised summary search
- Filters: status, issueType, priority, assigneeAccountId, labels, updated date range
- Open contract logged for Design: Jira-specific Figma spec for restore-unit and Board/Sprint sidebar filters

This is sprint 1 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

**Delivered:**
- ✅ Design Inventory UI architecture and manifest data contract — Software Architect (⚡ Quick, 2 SP)
- ✅ Backend: Inventory manifest API + Global Search endpoint — Backend Developer (◉ Deep, 5 SP)
- ✅ Frontend: Inventory sidebar with per-type counts — Frontend Developer (◈ Standard, 3 SP)
- ✅ Frontend: Issues table + Global Search bar with typed cards — Frontend Developer (◉ Deep, 5 SP)
- ✅ QA: Playwright signal assertions for Inventory UI — Qa Engineer (◈ Standard, 3 SP)

---
### Sprint 10 - Project Inventory Search, Filters & Phase Wrap | 2026-05-03 | ⏳ in progress | 18 SP est.
**Goal:** [Phase: Protected Object Inventory & Browse UI — Sprint 2 of 2]
Build the Inventory sidebar (Issues, Projects, Boards, Sprints), the Issues table with the dual Status/Issue Status columns, Global Search across project/board/sprint names, and Project Inventory in-app search with filters.

Deliverables (across all sprints in this phase):
- Inventory sidebar with four object types and per-row counts from the latest backup manifest
- Issues table with columns Issue Key, Summary, Issue Status, Issue Type, Assignee plus platform Status/Policy/Last Backup
- Distinct 'Issue Status' vs 'Status' column header labelling
- Global Search across projectKey, projectName, boardName, sprintName returning typed Protected Object cards
- Project Inventory Search with issueKey exact match and tokenised summary search
- Filters: status, issueType, priority, assigneeAccountId, labels, updated date range
- Open contract logged for Design: Jira-specific Figma spec for restore-unit and Board/Sprint sidebar filters

This is sprint 2 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 10 - Project Inventory Search, Filters & Phase Wrap | 2026-05-03 | ✅ Software Architect checkpoint (2/2 done)

- ✅ Design Project Inventory Search & Filter contract (⚡ Quick, 2 SP)
- ✅ Carry-forward: scope full SDI remediation workflows on PO cards (◈ Standard, 3 SP)

---
### Sprint 10 - Project Inventory Search, Filters & Phase Wrap | 2026-05-03 | ✅ done | 18 SP
**Goal:** [Phase: Protected Object Inventory & Browse UI — Sprint 2 of 2]
Build the Inventory sidebar (Issues, Projects, Boards, Sprints), the Issues table with the dual Status/Issue Status columns, Global Search across project/board/sprint names, and Project Inventory in-app search with filters.

Deliverables (across all sprints in this phase):
- Inventory sidebar with four object types and per-row counts from the latest backup manifest
- Issues table with columns Issue Key, Summary, Issue Status, Issue Type, Assignee plus platform Status/Policy/Last Backup
- Distinct 'Issue Status' vs 'Status' column header labelling
- Global Search across projectKey, projectName, boardName, sprintName returning typed Protected Object cards
- Project Inventory Search with issueKey exact match and tokenised summary search
- Filters: status, issueType, priority, assigneeAccountId, labels, updated date range
- Open contract logged for Design: Jira-specific Figma spec for restore-unit and Board/Sprint sidebar filters

This is sprint 2 of 2 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

**Delivered:**
- ✅ Design Project Inventory Search & Filter contract — Software Architect (⚡ Quick, 2 SP)
- ✅ Backend: Project Inventory Search endpoint with filters — Backend Developer (◉ Deep, 5 SP)
- ✅ Frontend: Project Inventory search bar + filter panel — Frontend Developer (◉ Deep, 5 SP)
- ✅ QA: Playwright coverage for Project Inventory search & filters — Qa Engineer (◈ Standard, 3 SP)
- ✅ Carry-forward: scope full SDI remediation workflows on PO cards — Software Architect (◈ Standard, 3 SP)

---
### Sprint 11 - Restore Wizard UI & Conflict-Mode Foundation | 2026-05-03 | ⏳ in progress | 17 SP est.
**Goal:** [Phase: Restore Engine & Wizard — Sprint 1 of 3]
Implement the restore wizard (conflict modes, destination options) and the dependency-ordered restore engine, including the post-issue-creation pass for links/comments/attachments. Cross-site restore and ADF media rewrite are explicitly deferred.

Deliverables (across all sprints in this phase):
- Restore wizard with three conflict modes (Override, Skip default, Ask per conflict)
- Destination options: Original location, Alternate location (same site), Browser Download export
- Restore engine enforcing write order: Project → Workflow + WorkflowScheme → CustomField + FieldConfiguration → Board → Sprint → Issue body → links/comments/attachments
- Phase-failure halt with named diagnostic before next phase
- Block in-place restore for projects in Atlassian's 60-day trash window with alternate-location guidance
- Best-effort warning for ADF media link breakage post-attachment-restore
- Heartbeat and progress events ≤10s for restore jobs

This is sprint 1 of 3 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 11 - Restore Wizard UI & Conflict-Mode Foundation | 2026-05-03 | ✅ Software Architect checkpoint (1/1 done)

- ✅ Design restore wizard contract & conflict-resolution state machine (◈ Standard, 3 SP)

---
### Sprint 11 - Restore Wizard UI & Conflict-Mode Foundation | 2026-05-03 | ✅ done | 17 SP
**Goal:** [Phase: Restore Engine & Wizard — Sprint 1 of 3]
Implement the restore wizard (conflict modes, destination options) and the dependency-ordered restore engine, including the post-issue-creation pass for links/comments/attachments. Cross-site restore and ADF media rewrite are explicitly deferred.

Deliverables (across all sprints in this phase):
- Restore wizard with three conflict modes (Override, Skip default, Ask per conflict)
- Destination options: Original location, Alternate location (same site), Browser Download export
- Restore engine enforcing write order: Project → Workflow + WorkflowScheme → CustomField + FieldConfiguration → Board → Sprint → Issue body → links/comments/attachments
- Phase-failure halt with named diagnostic before next phase
- Block in-place restore for projects in Atlassian's 60-day trash window with alternate-location guidance
- Best-effort warning for ADF media link breakage post-attachment-restore
- Heartbeat and progress events ≤10s for restore jobs

This is sprint 1 of 3 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

**Delivered:**
- ✅ Design restore wizard contract & conflict-resolution state machine — Software Architect (◈ Standard, 3 SP)
- ✅ Backend: Restore job API + conflict-mode + trash-window block — Backend Developer (◉ Deep, 5 SP)
- ✅ Frontend: Restore wizard UI (steps, conflict mode, destination) — Frontend Developer (◉ Deep, 5 SP)
- ✅ QA: Playwright coverage for restore wizard + conflict modes + trash-window block — Qa Engineer (◈ Standard, 3 SP)
- ✅ Carry-forward: file Figma spec request for restore-unit & Board/Sprint sidebar filters — Software Architect (⚡ Quick, 1 SP)

---
### Sprint 12 - Restore Engine Dependency-Ordered Writer | 2026-05-03 | ⏳ in progress | 20 SP est.
**Goal:** [Phase: Restore Engine & Wizard — Sprint 2 of 3]
Implement the restore wizard (conflict modes, destination options) and the dependency-ordered restore engine, including the post-issue-creation pass for links/comments/attachments. Cross-site restore and ADF media rewrite are explicitly deferred.

Deliverables (across all sprints in this phase):
- Restore wizard with three conflict modes (Override, Skip default, Ask per conflict)
- Destination options: Original location, Alternate location (same site), Browser Download export
- Restore engine enforcing write order: Project → Workflow + WorkflowScheme → CustomField + FieldConfiguration → Board → Sprint → Issue body → links/comments/attachments
- Phase-failure halt with named diagnostic before next phase
- Block in-place restore for projects in Atlassian's 60-day trash window with alternate-location guidance
- Best-effort warning for ADF media link breakage post-attachment-restore
- Heartbeat and progress events ≤10s for restore jobs

This is sprint 2 of 3 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

_Sprint started. Role checkpoints below will update as work completes._

---
### Sprint 12 - Restore Engine Dependency-Ordered Writer | 2026-05-03 | ✅ Software Architect checkpoint (2/2 done)

- ✅ Design restore engine phase executor & diagnostic contract (◈ Standard, 3 SP)
- ✅ File Figma spec request for restore-unit & Board/Sprint sidebar filters (⚡ Quick, 1 SP)

---
### Sprint 12 - Restore Engine Dependency-Ordered Writer | 2026-05-03 | ✅ done | 20 SP
**Goal:** [Phase: Restore Engine & Wizard — Sprint 2 of 3]
Implement the restore wizard (conflict modes, destination options) and the dependency-ordered restore engine, including the post-issue-creation pass for links/comments/attachments. Cross-site restore and ADF media rewrite are explicitly deferred.

Deliverables (across all sprints in this phase):
- Restore wizard with three conflict modes (Override, Skip default, Ask per conflict)
- Destination options: Original location, Alternate location (same site), Browser Download export
- Restore engine enforcing write order: Project → Workflow + WorkflowScheme → CustomField + FieldConfiguration → Board → Sprint → Issue body → links/comments/attachments
- Phase-failure halt with named diagnostic before next phase
- Block in-place restore for projects in Atlassian's 60-day trash window with alternate-location guidance
- Best-effort warning for ADF media link breakage post-attachment-restore
- Heartbeat and progress events ≤10s for restore jobs

This is sprint 2 of 3 for the phase. Plan a slice of the deliverables appropriate for one sprint; remaining items will be picked up in subsequent sprints via the auto-extracted Carry-Forward Backlog.

**Delivered:**
- ✅ Design restore engine phase executor & diagnostic contract — Software Architect (◈ Standard, 3 SP)
- ✅ Implement dependency-ordered restore engine with phase halt & heartbeats — Backend Developer (◉ Deep, 8 SP)
- ✅ Wire restore job progress UI: phase tracker, diagnostic banner, ADF warning — Frontend Developer (◈ Standard, 3 SP)
- ✅ Playwright coverage: restore engine phase order, halt diagnostic, ADF warning, heartbeat — Qa Engineer (◉ Deep, 5 SP)
- ✅ File Figma spec request for restore-unit & Board/Sprint sidebar filters — Software Architect (⚡ Quick, 1 SP)

---
