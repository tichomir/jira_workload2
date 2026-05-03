# SDI Remediation Workflows — Design Scope
_Sprint 10 carry-forward — Protected Object Inventory & Browse UI (Phase 5, Sprint 2 of 2)_
_Status: DESIGN DRAFT — not yet approved for implementation_

---

## 1. Purpose

This note scopes the operator-facing remediation affordances for Sensitive Data Intelligence (SDI) findings surfaced on Protected Object (PO) cards. The teaser scanner (Sprint 8) is passive — it detects and tags findings but provides no operator workflow. This document defines the lifecycle, API surface, and UI affordances needed to make SDI findings actionable.

The goal is to unblock planning for the next SDI phase while keeping Phase 1 scope contained: the teaser scanner ships findings as read-only badges; the remediation workflows described here are a Phase 2 deliverable unless explicitly pulled into a Phase 1 sprint by product decision.

---

## 2. Finding Lifecycle State Machine

A finding is created when the SDI scanner records a detection against a backed-up object. Each finding progresses through the following states:

```
                    ┌──────────┐
                    │   new    │  (initial state, on scan detection)
                    └────┬─────┘
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   ┌──────────┐  ┌──────────────┐  ┌──────────────┐
   │acknowledged│  │false_positive│  │  suppressed  │
   └─────┬────┘  └──────────────┘  └──────────────┘
         │
         ▼
   ┌──────────────────────┐
   │ escalated_to_compliance│
   └──────────────────────┘
```

### 2.1 States

| State | Description |
|---|---|
| `new` | Scanner detected a finding; no operator action taken. Displayed as an active badge on the PO card. |
| `acknowledged` | Operator has reviewed and confirmed the finding is real. Finding remains visible; badge changes to "Reviewed". |
| `false_positive` | Operator has determined the detection is incorrect. Finding is hidden from default view; suppression is pattern-specific and object-scoped. |
| `suppressed` | Operator has chosen to suppress the finding for this object (not pattern-wide). Finding is excluded from active badge counts but retained in audit history. |
| `escalated_to_compliance` | Operator has escalated the finding for compliance review. Terminal state in the UI — further state changes require compliance team action outside the DCC platform (Phase 2). |

### 2.2 Permitted Transitions

| From | To | Actor | Requires confirmation |
|---|---|---|---|
| `new` | `acknowledged` | Operator | No |
| `new` | `false_positive` | Operator | Yes (confirm dialog) |
| `new` | `suppressed` | Operator | Yes (confirm dialog) |
| `new` | `escalated_to_compliance` | Operator | Yes (confirm dialog with reason field) |
| `acknowledged` | `false_positive` | Operator | Yes |
| `acknowledged` | `suppressed` | Operator | Yes |
| `acknowledged` | `escalated_to_compliance` | Operator | Yes (reason field) |
| `false_positive` | `new` | Operator (undo) | No |
| `suppressed` | `new` | Operator (undo) | No |
| `escalated_to_compliance` | — | (terminal in Phase 1) | N/A |

Transitions not listed above are forbidden. Attempting a forbidden transition returns `HTTP 422 UNPROCESSABLE_ENTITY`.

### 2.3 Re-scan Behaviour

When a new backup point is created, the SDI scanner runs against the new snapshot. For each finding:
- If the finding was previously in `false_positive` or `suppressed` for this object + pattern combination, the scanner does **not** re-create a `new` finding for the same object and pattern. The existing finding state is inherited.
- If the finding appears in a new object (different backup point item), a fresh `new` finding is created.
- `acknowledged` and `escalated_to_compliance` findings are re-evaluated on each scan; if the pattern no longer matches in the new snapshot, the finding transitions to a `resolved` terminal state (Phase 2 extension — not in scope for Phase 1 remediation).

---

## 3. Audit Log Requirements

Every state transition must produce an immutable audit record. This is required for GDPR accountability (Article 5(2)) and PCI DSS audit trail obligations.

### 3.1 Audit Record Schema

```typescript
interface SdiFindingAuditRecord {
  /** Unique audit record ID. */
  auditId: string;

  /** The finding this record pertains to. */
  findingId: string;

  /** Object identifier (backupPointId + objectType + objectId). */
  objectRef: {
    backupPointId: string;
    objectType: 'JiraIssue' | 'JiraProject' | 'JiraBoard' | 'JiraSprint';
    objectId: string;
  };

  /** Detector that created the original finding. */
  detectorType: 'email' | 'api_key' | 'credit_card' | 'phone';

  /** Regulation tags active on this finding. */
  regulationTags: ('GDPR' | 'PCI_DSS')[];

  /** State before this transition. */
  fromState: FindingState;

  /** State after this transition. */
  toState: FindingState;

  /** ISO 8601 timestamp of the transition. */
  transitionedAt: string;

  /** Operator account ID (Atlassian accountId from session). */
  operatorAccountId: string;

  /** Optional operator-supplied reason (required for escalation). */
  reason?: string;
}
```

### 3.2 Audit Storage

Audit records are **append-only** — no record is ever updated or deleted. They are stored in a dedicated `sdi_finding_audit` table (migration to be defined in Phase 2 sprint). Audit records must survive backup point deletion (no cascade delete from backup_points to audit records).

### 3.3 Structured Log Emission

In addition to the database record, every transition emits a structured log line:

```json
{
  "event": "sdi_finding_transition",
  "findingId": "...",
  "objectId": "...",
  "detector": "credit_card",
  "regulationTags": ["PCI_DSS"],
  "fromState": "new",
  "toState": "escalated_to_compliance",
  "operatorAccountId": "...",
  "timestamp": "2026-05-03T10:00:00Z"
}
```

---

## 4. API Surface Sketch

All SDI remediation endpoints are under `/api/sdi/findings`. Authentication is via the existing DCC session; the operator's Atlassian accountId is extracted from the session for audit records.

### 4.1 List Findings for a Protected Object

```
GET /api/sdi/findings
  ?objectId=<string>          // required; the manifest entry objectId
  &objectType=<string>        // required; JiraIssue | JiraProject | ...
  &backupPointId=<string>     // optional; defaults to latest backup point
  &state=<csv>                // optional filter; e.g. "new,acknowledged"
  &regulationTag=<string>     // optional filter; GDPR | PCI_DSS
  &limit=<int>                // default 50
  &offset=<int>               // default 0
```

Response: `{ findings: SdiFinding[], total: number }`

### 4.2 Transition a Finding

```
POST /api/sdi/findings/{findingId}/transition
Content-Type: application/json

{
  "toState": "acknowledged" | "false_positive" | "suppressed" | "escalated_to_compliance",
  "reason": "<string>"   // required when toState === "escalated_to_compliance"
}
```

Response on success: `HTTP 200` with the updated `SdiFinding` object.
Response on forbidden transition: `HTTP 422` with `{ error: "INVALID_TRANSITION", from: "...", to: "..." }`.

### 4.3 Suppress Pattern for Object (Bulk)

```
POST /api/sdi/findings/suppress-pattern
Content-Type: application/json

{
  "objectId": "<string>",
  "objectType": "<string>",
  "detectorType": "email" | "api_key" | "credit_card" | "phone"
}
```

Transitions all `new` findings of the given `detectorType` for the given object to `suppressed`. Returns a count of suppressed findings. This is a batch convenience operation; each transition generates an individual audit record.

### 4.4 Get Audit Trail for a Finding

```
GET /api/sdi/findings/{findingId}/audit
```

Response: `{ auditRecords: SdiFindingAuditRecord[] }` in chronological order.

---

## 5. PO Card UI Affordances

These affordances are additions to the existing passive teaser surface (SDI badge on PO card). They require the Figma spec referenced in `docs/open-contracts.md` OC-003 before implementation.

### 5.1 Badge Behaviour

| Finding state(s) | Badge appearance | Count included |
|---|---|---|
| `new` | Red/amber badge with regulation tag (GDPR / PCI DSS) | Yes |
| `acknowledged` | Blue "Reviewed" badge | Yes |
| `false_positive` | Not shown in default view | No (hidden by default) |
| `suppressed` | Not shown in default view | No (hidden by default) |
| `escalated_to_compliance` | Orange "Escalated" badge | Yes |

A "Show suppressed/false-positive" toggle reveals hidden findings.

### 5.2 Finding Detail Drawer

Clicking the SDI badge opens a drawer (slide-in panel) on the PO card showing:
- List of findings for this object, grouped by detector type.
- For each finding: matched text snippet (redacted beyond first N chars), detector type, regulation tags, current state, last transition timestamp, and operator identity.
- Action buttons per finding (state-dependent; see §5.3).

### 5.3 Action Buttons (per finding, state-dependent)

| Current state | Available actions |
|---|---|
| `new` | Acknowledge · Mark False Positive · Suppress · Escalate to Compliance |
| `acknowledged` | Mark False Positive · Suppress · Escalate to Compliance |
| `false_positive` | Undo (→ new) |
| `suppressed` | Undo (→ new) |
| `escalated_to_compliance` | (read-only; no actions) |

Destructive transitions (false_positive, suppress, escalate) show a confirmation dialog. Escalation requires a reason text field.

---

## 6. Integration Points with Existing Passive Teaser Surface

The existing teaser surface (Sprint 8) writes findings to a `sdi_findings` table (or equivalent structure in `SdiScanner.ts`). The remediation layer extends this:

1. **`SdiScanner.ts`** — already creates findings on scan. Remediation adds a `state` column (default `'new'`) and `suppressedPatterns` map per object. Scanner checks suppressedPatterns before emitting new `new` findings.
2. **`ProtectedObjectCard.tsx`** — currently renders passive badges. Remediation adds the finding drawer and action buttons.
3. **`InventoryRouter.ts`** — extend or add a sibling `SdiFindingsRouter.ts` for the new endpoints.
4. **Backup pipeline post-processing** — the SDI scan step already runs post-backup. Add suppression-inheritance logic here.

---

## 7. Dependencies and Carry-Forward Items

The following items are explicitly carried forward and must be resolved before full remediation implementation:

### 7.1 Precision/Recall Telemetry (Carry-Forward)
**Status:** Carried forward (not yet implemented)  
**Why it matters:** False-positive rates drive the usefulness of the "Mark False Positive" workflow. Without telemetry on which patterns generate false positives, operators have no baseline; product cannot prioritise detector tuning.  
**Dependency:** Remediation UI may show inflated false-positive action rates if telemetry is absent. Recommendation: instrument `false_positive` and `suppressed` transitions from day 1 of remediation rollout to build a baseline.

### 7.2 False-Positive Sampling Pipeline (Carry-Forward)
**Status:** Carried forward  
**Why it matters:** Aggregating false-positive signals across tenants enables detector improvement (e.g. refining regex specificity for API key detection). This is a platform-level concern, not workload-specific, but the data originates from remediation transitions.  
**Dependency on remediation:** The `SdiFindingAuditRecord` schema (§3.1) must be finalised before the sampling pipeline can be wired up. Lock the schema before Phase 2 implementation.

### 7.3 Figma Spec (OC-003, Carry-Forward)
**Status:** OPEN (see `docs/open-contracts.md` OC-003)  
**Blocking:** PO card UI affordances (§5) cannot be implemented without the spec. Build conservatively to acceptance-criteria text until spec arrives.

---

## 8. Recommended Phasing

| Phase | Scope | Prerequisite |
|---|---|---|
| **Phase 1 (current)** | Passive teaser only — detection + regulation tag badge. No operator action. | Shipped (Sprint 8) |
| **Phase 2a** | Finding lifecycle + audit trail. `new → acknowledged`, `false_positive`, `suppressed`. API endpoints §4.1–§4.3. Finding detail drawer (read-only state visible, no escalation). | Figma spec OC-003; `sdi_findings` schema extension |
| **Phase 2b** | Escalation workflow. `escalated_to_compliance` state + reason field. Audit trail API (§4.4). | Phase 2a complete; compliance team handoff process defined |
| **Phase 2c** | Telemetry + false-positive sampling pipeline. Per-detector false-positive rate dashboard. | Phase 2a audit records in production; sampling pipeline infrastructure |
| **Phase 3** | Suppress-pattern (bulk, §4.3). Cross-backup-point finding continuity (suppression inheritance across scans). Detector tuning based on telemetry. | Phase 2c telemetry baseline |

---

_End of document. Dependencies on T7 §2–§4, engineering coding standards (audit + structured logging invariants), and open-contracts.md OC-003._
