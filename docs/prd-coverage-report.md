# PRD Coverage Report — Jira Cloud Phase 1 MVP

_Generated: Sprint 14 — Hardening, Observability & MVP Handoff_
_Spec file: `e2e/sprint14-prd-signal-assertions.spec.ts`_
_Log audit: `scripts/log-audit.sh`_

---

## Coverage Map: PRD §2 Goals → Playwright Spec → Log Pattern

| # | PRD §2 Goal | Source | Playwright Spec (test.describe) | Signal Assertion | Log Pattern |
|---|-------------|--------|----------------------------------|------------------|-------------|
| G-1 | OAuth /me HTTP 200 with valid accountId; credential store has non-null accessToken + refreshToken | T2 §4.2, §4.5 | `PRD Goal 1 — OAuth /me 200 + credential store` | `GET /me → 200 + accountId`; `SELECT access_token FROM jira_credentials` | `[jira-oauth] account verified` |
| G-2 | Project discovery via paginated GET /project/search; zero silent omissions | T3 §4.3, T4 §6 | `PRD Goal 2 — Project discovery & manifest completeness` | `manifest_entries COUNT === apiTotalReported` | `[jira-discovery] project page fetched` |
| G-3 | Full Issue capture: all 8 payload classes (system + custom fields, comments, links, subtasks, sprint, watchers, worklogs) | T3 §3.5 | `PRD Goal 3 — Issue coverage invariant (T3 §3.3)` | `POST /search/jql → issues with all field classes`; `manifest JiraIssue count` | `[jira-backup] search/jql endpoint called` |
| G-4 | Binary-faithful attachment download: byte-for-byte, original MIME type, no transcoding | T3 §3.2, §4.4 | `PRD Goal 4 — Binary-faithful attachment download` | `GET /attachment/content/:id → Content-Type: image/png + SHA256` | `[jira-backup] attachment downloaded` |
| G-5 | Backup capture order: IssueType → CustomField+FieldConfig → Workflow+WorkflowScheme → Project → Board → Sprint → Issue | T1 §1, T3 §3.4 | `PRD Goal 5 — Backup capture dependency order` | `manifest_entries first_id order: Project < Board < Sprint < JiraIssue` | `[jira-backup] context pipeline` |
| G-6 | Restore write order: Project → Workflow → CustomField → Board → Sprint → Issue body → post-issue; phase halt with named diagnostic | T1 §1, T2 §6 C8, T5 §5.2 | `PRD Goal 6 — Restore write order & phase-failure halt` | `phaseProgress canonical order assertion`; `failure_phase + failure_message in DB` | `[jira-restore] phase.*halt` |
| G-7 | Atomic token rotation: both access_token + refresh_token written before mutex release; concurrent refreshes queued | T2 §4.5, §6 C4 | `PRD Goal 7 — Atomic rotating refresh token` | `POST /oauth/token → body.access_token + body.refresh_token both present` | `[jira-oauth] token refreshed — writing new access_token + refresh_token atomically` |
| G-8 | Only POST /rest/api/3/search/jql used; deprecated GET /rest/api/3/search never called | T2 §4.5, §6 C6 | `PRD Goal 8 — POST /search/jql; deprecated GET /search intercepted` | `GET /search → 410`; `forbiddenEndpointCalls` guard array; network interceptor | `[DEPRECATED-ENDPOINT-GUARD] FORBIDDEN` |
| G-9 | Custom field context: GET /field/:id/context only for custom:true fields; system fields skipped | T2 §6 C7, T3 §4.2 | `PRD Goal 9 — Custom field context gated on custom:true` | `fields.filter(f => f.custom).map(context call)`; system fields never passed to context | `[jira-backup] custom-field context fetched fieldId=` |
| G-10 | SDI: email/phone → GDPR tag; credit card → PCI_DSS tag; surfaced on PO cards without operator action | T7 §2, §3, §4 | `PRD Goal 10 — SDI regulation tag activation on Protected Object cards` | `manifest_entries.sdi_scan_result.regulationTags contains GDPR / PCI_DSS` | `[jira-sdi]` |
| G-11 | Inventory sidebar: Issues (default), Projects, Boards, Sprints — per-row counts from latest manifest | T8 §2, §3 | `PRD Goal 11 — Inventory sidebar: Issues, Projects, Boards, Sprints with counts` | `GET /inventory/summary → { issues, projects, boards, sprints } all numbers ≥ seeded counts` | `[jira-inventory]` |
| G-12 | Restore wizard: Override / Skip (default) / Ask per conflict; Original / Alternate / Export destinations | T5 §5.1, §5.2 | `PRD Goal 12 — Restore wizard conflict modes & destinations` | `POST /restore/jobs with each conflictMode + destinationType → 201`; default conflict_mode=skip | `[jira-restore] job.created` |
| G-13 | Heartbeat ≤10s; stalled alert >20s; "Completed with N errors" label on partial failure | T5 §6.2, §6.2b | `PRD Goal 13 — Heartbeat cadence, stalled alert, Completed with N errors` | `status=completed_with_errors when items_failed>0`; `stalled=1 when heartbeat_gap>20s` | `[jira-restore] job.heartbeat` / `[jira-backup] heartbeat` |

---

## Network Interceptor — Deprecated Endpoint Guard

The guard is implemented in the mock Jira server within `sprint14-prd-signal-assertions.spec.ts`:

```typescript
app.get('/rest/api/3/search', (req, res) => {
  const msg = `FORBIDDEN: GET /rest/api/3/search called with query: ${req.url}`;
  forbiddenEndpointCalls.push(msg);
  console.error('[DEPRECATED-ENDPOINT-GUARD]', msg);
  res.status(410).json({ error: 'deprecated endpoint', forbidden: true });
});
```

CI fails if any application code triggers this endpoint:

```typescript
// Goal 8 — CI guard assertion
const appViolation = logLines.find(
  (l) => l.includes('[DEPRECATED-ENDPOINT-GUARD]') && !l.includes('prd-signal-test')
);
expect(appViolation).toBeUndefined();
```

A complementary static check runs at build time via `scripts/check-deprecated-endpoint.sh` (Sprint 7, already in place).

---

## Log Audit Script

Run against any test output or application log file:

```bash
# Pipe test output
npm test 2>&1 | tee /tmp/run.log && ./scripts/log-audit.sh /tmp/run.log

# Or pass a file
./scripts/log-audit.sh logs/app.ndjson
```

**Audit fails CI** (`exit 1`) if any of the 15 required patterns is absent:

| # | Pattern | PRD Goal |
|---|---------|----------|
| 1 | `\[jira-oauth\] account verified` | G-1 |
| 2 | `\[jira-oauth\] token refreshed` | G-1, G-7 |
| 3 | `\[jira-discovery\].*page.*fetched` | G-2 |
| 4 | `\[jira-backup\].*search/jql` | G-3, G-8 |
| 5 | `\[jira-backup\].*attachment downloaded` | G-4 |
| 6 | `\[jira-backup\].*context.*pipeline` | G-5 |
| 7 | `\[jira-restore\].*phase` | G-6 |
| 8 | `\[jira-oauth\].*token.*refresh` | G-7 |
| 9 | `\[jira-backup\].*pagination.*terminated` | G-8 |
| 10 | `\[jira-backup\].*custom-field context` | G-9 |
| 11 | `\[jira-sdi\]` | G-10 |
| 12 | `\[jira-inventory\]` | G-11 |
| 13 | `\[jira-restore\].*job\.created` | G-12 |
| 14 | `\[jira-restore\].*job\.heartbeat` | G-13 |
| 15 | `\[jira-backup\].*heartbeat` | G-13 |

---

## Evidence Artifacts

All test runs write structured evidence to `tests/integration/prd-signal-assertions/evidence/`:

| File | Contents |
|------|----------|
| `goal1-oauth-me.json` | Mock /me response shape |
| `goal1-credential-store.json` | Credential store non-null assertion |
| `goal1-log-pattern.json` | `[jira-oauth] account verified` log match |
| `goal2-project-discovery.json` | Project API response + project keys |
| `goal2-manifest-omission.json` | manifest_entries count vs API total |
| `goal3-coverage-invariant.json` | Issue key + fields present in /search/jql response |
| `goal4-attachment-download.json` | Content-Type + byte length + SHA256 |
| `goal5-capture-order.json` | manifest_entries first_id ordering assertion |
| `goal6-restore-phase-order.json` | phaseProgress canonical order |
| `goal6-phase-halt-diagnostic.json` | failure_phase + failure_message in DB |
| `goal7-token-refresh.json` | Token refresh response shape |
| `goal8-deprecated-endpoint-blocked.json` | 410 response from GET /search |
| `goal8-violation-capture.json` | forbiddenEndpointCalls array |
| `goal8-ci-guard-result.json` | App-code violation count (must be 0) |
| `goal9-field-list.json` | Custom vs system field breakdown |
| `goal9-context-gating.json` | custom:true fields with context / system fields skipped |
| `goal10-gdpr-tag.json` | GDPR regulation tag in sdi_scan_result |
| `goal10-pci-dss-tag.json` | PCI_DSS regulation tag in sdi_scan_result |
| `goal11-sidebar-counts.json` | issues / projects / boards / sprints counts |
| `goal12-default-conflict-mode.json` | conflict_mode=skip as default |
| `goal13-completed-with-errors.json` | status=completed_with_errors shape |
| `goal13-stalled-detection.json` | stalled=1 with heartbeat gap > 20s |
| `_manifest.json` | PRD goal → spec → log pattern mapping |
| `_log-audit-lines.json` | All captured log lines from run |

---

## Related Files

| File | Purpose |
|------|---------|
| `e2e/sprint14-prd-signal-assertions.spec.ts` | This coverage report's test suite |
| `e2e/sprint14-coverage-invariant-e2e.spec.ts` | Round-trip coverage invariant + 3×3 conflict mode/destination matrix |
| `scripts/log-audit.sh` | CI log pattern audit script |
| `scripts/check-deprecated-endpoint.sh` | Static build-time check for deprecated endpoint usage |
| `tests/integration/prd-signal-assertions/evidence/` | Evidence artifact directory |
