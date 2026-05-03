# Phase 2 Backlog — Jira Cloud Connector

_Groomed: 2026-05-03 | Author: Software Architect | Status: READY FOR SPRINT PLANNING_

This document grooms the five deferred Phase 2 items explicitly listed in the PRD Non-Goals
section (T1 §1, T2 §6, T3 §3.2, T5, T7). Each entry follows the same structure:
scope summary → key open questions (OQs) → rough sizing → dependencies.

---

## 1. JSM Objects (JSMTicket / JSMQueue / JSMRequestType / JSMSLAM)

### Scope Summary
Jira Service Management extends Jira Cloud with service-desk-specific object types that are
outside the Phase 1 object set. Phase 1 explicitly excludes JSM even when the connected site
has `project_type = service_desk` (T2 §6 Constraint 11, T3 §3.2). The onboarding wizard
surfaces an out-of-scope notice for service_desk projects, but takes no backup action.

Phase 2 must extend the backup/restore pipeline to cover:

| Object Type    | Key Attributes                                              | API Surface                                          |
|----------------|-------------------------------------------------------------|------------------------------------------------------|
| JSMTicket      | requestType, sla, participants, approvals, status category  | `GET /rest/servicedeskapi/request`                   |
| JSMQueue       | name, jqlFilter, columnConfig                               | `GET /rest/servicedeskapi/servicedesk/{id}/queue`    |
| JSMRequestType | name, description, fields, groups                           | `GET /rest/servicedeskapi/servicedesk/{id}/requesttype` |
| JSMSLAM        | name, type, goals (respond/resolve), calendarRef            | `GET /rest/servicedeskapi/servicedesk/{id}/sla`      |

Restore dependency additions: JSMRequestType and JSMQueue depend on a live Project and
WorkflowScheme; SLAs depend on an active Calendar configuration (not backed up in Phase 1 —
see OQ-1 below). The restore write order becomes:
Project → Workflow + WorkflowScheme → CustomField + FieldConfig → Board → Sprint →
JSMRequestType → JSMQueue → Issue body → JSMTicket fields → links/comments/attachments →
JSMSLAM (post-issue pass).

### Key Open Questions
| ID    | Question                                                                                         | Owner         |
|-------|--------------------------------------------------------------------------------------------------|---------------|
| OQ-1  | Calendar configurations for SLA goals — are they recoverable via API or must they be re-entered manually post-restore? | Engineering   |
| OQ-2  | Does `read:servicedesk-request:jira` scope cover SLA goal reads or is `manage:jira-configuration` required? | Auth/Scopes   |
| OQ-3  | How are participant `accountId` arrays handled when restoring to the same site with potentially deactivated users? | Engineering   |
| OQ-4  | Should JSMQueue jqlFilter references to custom fields survive the field-remapping restore pass? | Engineering   |
| OQ-5  | Full JSM teaser SDI profile — separate T7 required (T7 OQ-3). Does it block Phase 2 GA or ship independently? | PM            |

### Rough Sizing
| Work Item                                          | Estimate |
|----------------------------------------------------|----------|
| API discovery + schema modelling for 4 object types| 8 SP     |
| Backup capture pipeline extension (4 handlers)     | 13 SP    |
| Restore engine phase extensions + conflict modes   | 13 SP    |
| Inventory UI sidebar additions (4 new types)       | 5 SP     |
| SDI teaser profile for JSM object types            | 5 SP     |
| QA: integration + Playwright coverage              | 8 SP     |
| **Total (rough)**                                  | **52 SP**|

### Dependencies
- Phase 1 restore engine (`RestoreEngine.ts`, `RestorePhaseHandlers.ts`) — must be stable.
- Atlassian `read:servicedesk-request:jira` scope added to OAuth scope set (T2 §4.2.2).
- OQ-1 (Calendar API) resolved before SLA restore can be designed.
- Full JSM SDI teaser (T7 Phase 2) should ship in the same release window.

---

## 2. Audit Log Backup

### Scope Summary
The AuditLog node type provides a tamper-evident record of administrative actions on a Jira
site. It is excluded from Phase 1 pending Engineering confirmation of the required scope
(T1 §1, T3 §3.2, T6 §2 — OQ-2: `read:audit-log:jira` vs. `manage:jira-configuration`).

Phase 2 scope:
- Paginated capture of audit log records via `GET /rest/api/3/auditing/record`
  (startDate / endDate / filter parameters).
- Storage model: append-only log segments in the backup manifest with immutable references.
- Restore semantics differ from other object types — audit logs are **read-only reference
  data** and are not re-injected into the target site. Restore surfaces logs as a
  downloadable evidence package, not as Jira objects.
- Retention: log segments follow the same flat RPO+Retention policy as Phase 1 unless GFS
  is adopted (T4 §2).

### Key Open Questions
| ID    | Question                                                                                     | Owner       |
|-------|----------------------------------------------------------------------------------------------|-------------|
| OQ-1  | Confirmed required scope: `read:audit-log:jira` or `manage:jira-configuration`? The latter is overly privileged. | Atlassian docs / Engineering |
| OQ-2  | Maximum audit record retention window on Atlassian's side (logs may be auto-purged at 180 days). Does this constrain backup frequency? | Engineering |
| OQ-3  | Are audit logs considered PII under GDPR (they contain `accountId` + IP address)? Does SDI scanner need to cover log segments? | Legal / PM  |
| OQ-4  | Restore destination for logs: download-only, or should they appear in the Inventory UI? | PM / Design |

### Rough Sizing
| Work Item                                   | Estimate |
|---------------------------------------------|----------|
| Scope confirmation + API contract design     | 2 SP     |
| Paginated log capture handler               | 5 SP     |
| Manifest schema extension for log segments  | 3 SP     |
| Evidence-package download endpoint          | 3 SP     |
| SDI coverage for log segments (if OQ-3 = yes)| 5 SP    |
| QA                                          | 3 SP     |
| **Total (rough)**                           | **21 SP**|

### Dependencies
- OQ-1 (scope) must be resolved before implementation begins — scope expansion requires
  re-authorisation of all connected sites.
- Phase 1 manifest schema (`manifest-schema.json`) extended for `auditLog` segment type.
- Legal sign-off on OQ-3 before SDI coverage decisions are made.

---

## 3. Cross-Site Restore (cloudId Remapping + accountId Portability)

### Scope Summary
Phase 1 restore is limited to the originating `cloudId` (T2 OQ-3, T5 §5.2). Cross-site
restore — restoring a backup from Site A (`cloudId` A) to Site B (`cloudId` B) — is blocked
because:

1. **Custom field IDs are site-scoped.** `customfield_10001` on Site A has no guaranteed
   correspondence on Site B. A remapping table must be built by diffing field schemas at
   restore time.
2. **`accountId` values are site-scoped.** User references in Issue assignee, reporter,
   comments, worklogs, and watchers are not portable without a user-resolution pass against
   Site B's directory.
3. **Project keys may collide.** Alternate-location restore on Site B with an identical
   project key requires conflict-mode handling.

Phase 2 scope:
- Cross-site remapping engine: `customFieldId` ↔ `fieldName` fuzzy-match table built at
  restore-plan time.
- User resolution pass: `accountId` → `emailAddress` → Site B `accountId` lookup via
  `GET /rest/api/3/user/search?query={email}`.
- Unresolvable references (deactivated accounts, missing fields) surfaced as named
  diagnostics; operator can map manually or skip.
- Project key collision detection and rename-on-conflict handling.
- UI: cross-site destination option unlocked in Restore Wizard destination step.

### Key Open Questions
| ID    | Question                                                                                           | Owner       |
|-------|----------------------------------------------------------------------------------------------------|-------------|
| OQ-1  | Is `emailAddress` reliably present on both sites for user resolution, or do managed-account domains complicate this? | Engineering |
| OQ-2  | Should unresolvable field mappings block restore or allow partial restore with warnings? | PM          |
| OQ-3  | What is the UX for the manual mapping table — inline in wizard or exported CSV for operator review? | Design      |
| OQ-4  | Multi-tenant cross-organisation restore (different Atlassian Org Admin) — explicitly out of scope for Phase 2? | PM          |

### Rough Sizing
| Work Item                                                | Estimate |
|----------------------------------------------------------|----------|
| Cross-site remapping engine (fields + users)             | 13 SP    |
| Unresolvable-reference diagnostic surface                | 5 SP     |
| Restore Wizard UI: cross-site destination + mapping review | 8 SP   |
| Project key collision detection                          | 3 SP     |
| QA: integration + Playwright coverage                    | 8 SP     |
| **Total (rough)**                                        | **37 SP**|

### Dependencies
- Phase 1 restore engine stable and covered by tests.
- User requires Site Admin role on **both** sites; OAuth scope expansion for Site B
  connection required.
- OQ-3 (UX for mapping table) blocks Frontend work.
- Cross-tenant restore (different Org Admin) explicitly deferred — not Phase 2 scope
  per PRD Non-Goals.

---

## 4. Incremental Backup (updated >= lastBackupTimestamp)

### Scope Summary
Phase 1 uses a full-snapshot model: every backup job re-captures all Issues, Boards,
Sprints, and context nodes regardless of change state (T3 §4.3). This is correct for
correctness guarantees but is expensive at scale.

Phase 2 incremental backup uses the `updated >= {lastBackupTimestamp}` JQL predicate in
`POST /rest/api/3/search/jql` to capture only Issues modified since the last successful
backup point. Context nodes (IssueType, CustomField, Workflow, etc.) still require full
re-capture on each run because Atlassian does not expose an `updatedSince` filter for
schema objects.

Delta model:
- Each incremental backup point references its **base full-snapshot** backup point ID.
- Restore from an incremental point replays: base full-snapshot → all incremental deltas
  up to the selected restore point.
- Deleted Issues (no native delete event from Jira API) require a **tombstone pass**:
  diff the current Issue key set against the previous manifest to detect removals.

### Key Open Questions
| ID    | Question                                                                                              | Owner       |
|-------|-------------------------------------------------------------------------------------------------------|-------------|
| OQ-1  | Does `updated` on an Issue reflect comment/worklog/attachment changes, or only field-level edits? Atlassian docs are ambiguous. | Engineering |
| OQ-2  | Tombstone detection via key-set diff — what is the performance cost at 100k+ issues? Is a separate delete-event webhook feasible? | Engineering |
| OQ-3  | Should incremental points be user-selectable as restore targets, or only full snapshots? | PM          |
| OQ-4  | GFS retention is a Phase 2 item (T4 §2) — should incremental backup ship with or after GFS? | PM          |

### Rough Sizing
| Work Item                                                    | Estimate |
|--------------------------------------------------------------|----------|
| Incremental JQL capture path in `IssueCaptureOrchestrator`   | 5 SP     |
| Delta manifest schema (base ref + changed-key set)            | 3 SP     |
| Tombstone detection pass                                      | 5 SP     |
| Restore chain: full-snapshot + incremental replay             | 8 SP     |
| Backup point UI: distinguish full vs incremental points       | 3 SP     |
| QA                                                            | 5 SP     |
| **Total (rough)**                                             | **29 SP**|

### Dependencies
- Phase 1 `BackupPointManifestWriter` and `IssueCaptureOrchestrator` stable.
- OQ-1 resolved — if `updated` does not cover attachment changes, attachment re-capture
  strategy must be designed separately.
- GFS retention design (T4 §2) should be co-designed with incremental to avoid
  manifest schema rework.

---

## 5. ADF Media Link Rewrite Post-Attachment-Restore

### Scope Summary
When attachments are restored via Phase 1's `BrowserDownloadAssembler` or direct Jira
API writes, each restored attachment receives a **new `attachmentId`**. ADF (Atlassian
Document Format) nodes in Issue descriptions and comments that reference the original
`attachmentId` via `media` node `attrs.id` become stale (T5 OQ-5, §7 Constraint 10).

Phase 1 handles this with a best-effort warning in the restore report
(`RestoreWizard` ADF warning banner). Phase 2 requires a full rewrite pass:

1. After the post-issue-creation attachment pass completes, build a mapping table:
   `{ oldAttachmentId → newAttachmentId }`.
2. Traverse all ADF trees in Issue descriptions and comment bodies.
3. For each `media` node where `attrs.id` is in the mapping table, rewrite `attrs.id`
   to the new value.
4. `PUT /rest/api/3/issue/{key}` to write the updated description ADF.
5. For comments: `PUT /rest/api/3/issue/{key}/comment/{commentId}`.

Rate-limit exposure: ADF rewrite issues one PUT per Issue with at least one attachment
reference plus one PUT per comment. At scale this can saturate Atlassian's rate limits.
Batching and back-off strategy required.

### Key Open Questions
| ID    | Question                                                                                               | Owner       |
|-------|--------------------------------------------------------------------------------------------------------|-------------|
| OQ-1  | Does Atlassian's `PUT /rest/api/3/issue/{key}` accept a full ADF description replacement, or is a partial-update path available? | Engineering |
| OQ-2  | ADF `media` nodes also embed `collection` and `occurrenceKey` — do these require rewriting too?       | Engineering |
| OQ-3  | Should the rewrite pass be a separate post-restore job (decoupled from restore latency) or inline?    | PM / Design |
| OQ-4  | What is the fallback if the rewrite PUT fails for a specific Issue — leave broken links or surface as a named error? | PM          |

### Rough Sizing
| Work Item                                                             | Estimate |
|-----------------------------------------------------------------------|----------|
| ADF tree traversal + media-node rewrite engine                        | 8 SP     |
| oldId → newId mapping table built during attachment restore pass      | 3 SP     |
| Rate-limit-aware PUT loop with back-off                               | 5 SP     |
| Restore report: rewrite pass status + per-issue error surfacing       | 3 SP     |
| QA: round-trip fidelity tests for ADF media references                | 5 SP     |
| **Total (rough)**                                                     | **24 SP**|

### Dependencies
- Phase 1 `RestorePhaseHandlers` attachment pass must expose the
  `oldAttachmentId → newAttachmentId` mapping (currently not stored).
- OQ-1 resolved — PUT semantics for ADF description must be confirmed.
- Rate-limit back-off strategy should reuse the canonical `JiraHttpClient` retry logic.
- Phase 1 ADF warning banner in `RestoreWizard` should remain until rewrite pass ships.

---

## Summary Table

| # | Item                         | Rough Total | Key Blocker               | Suggested Phase 2 Order |
|---|------------------------------|-------------|---------------------------|--------------------------|
| 1 | JSM Objects                  | ~52 SP      | OQ-1 (Calendar API)       | 2nd (after Incremental)  |
| 2 | Audit Log Backup             | ~21 SP      | OQ-1 (scope confirmation) | 3rd                      |
| 3 | Cross-Site Restore           | ~37 SP      | OQ-3 (UX mapping table)   | 4th                      |
| 4 | Incremental Backup           | ~29 SP      | OQ-1 (updated field scope)| 1st — lowest risk        |
| 5 | ADF Media Link Rewrite       | ~24 SP      | OQ-1 (PUT semantics)      | Concurrent with Sprint 15|

**Recommended Phase 2 entry point:** Incremental Backup (item 4) — it is self-contained,
unblocked, and delivers immediate customer value without new scope dependencies.
