# Design Request: Restore-Unit Wizard & Board/Sprint Sidebar Filters
_Sprint 11 carry-forward · Open contracts: OC-001, OC-002, OC-003_
_Raised: 2026-05-03 · Design owner: **Design** (tag: `@design`)_
_Required by: Sprint 12 planning · Status: **OPEN**_

---

## Purpose

Two visual design contracts have been open since Sprint 9 and remain unresolved entering Sprint 11. This document consolidates both into a single actionable brief for Design, lists the unanswered visual questions per surface, and points to the as-built components so Design can annotate against live code rather than starting from scratch.

The restore wizard (`RestoreWizard.tsx`) was built conservatively in Sprint 11 against acceptance-criteria text only. All layout decisions are provisional. Any invented layout in the current component **will require rework** once the Figma frame is delivered.

---

## 1. Restore-Unit Wizard (OC-001 / OC-003)

### 1.1 As-Built Component Paths

| Artefact | Path |
|---|---|
| Main wizard component | `frontend/src/components/RestoreWizard.tsx` |
| Restore API types | `frontend/src/api/jira.ts` (types: `ConflictMode`, `RestoreDestination`, `RestoreScope`, `RestoreJob`, `PhaseProgress`, `RestorePhase`) |
| Restore architecture doc | `docs/restore-architecture.md` |
| Backend restore types | `src/restore/types.ts` |

### 1.2 Current Wizard Structure (as-built, six steps)

The wizard is a six-step linear flow rendered inside a `max-w-2xl` panel with a segmented step indicator bar:

```
Step 1 — Select Backup Point
  Radio list of backup points (timestamp, project count, issue count)

Step 2 — Select Restore Scope
  Radio: All items / Selected projects / Individual issues
  Textarea for project/issue keys when narrowing scope

Step 3 — Choose Destination
  Radio cards: Original location / Alternate location / Browser Download
  Inline text field for alternate project key
  Trash-window block banner (error, red) when original restore is blocked

Step 4 — Conflict Resolution Mode
  Radio cards: Skip (default) / Override / Ask per conflict
  Per-card help text explaining consequences

Step 5 — Review & Start
  Summary table (backup point · scope · destination · conflict mode)
  Trash-window block banner (error) — halts start if triggered
  ADF media link breakage warning (yellow)
  Start Restore button

Step 6 — Restore in Progress
  Overall status badge (colour-coded by status)
  Phase-progress rows (7 phases, ordered)
  ADF media warning (yellow, when emitted by engine)
  Phase-failure diagnostic banner (red)
  Ask-mode conflict prompt (purple, pauses job)
  Stalled-job banner (yellow, >20 s no heartbeat)
  Close button on terminal status
```

### 1.3 Current Visual Decisions (All Provisional)

These decisions were made without a Figma frame. Each is a **candidate for change** when the spec arrives:

| Area | Current implementation | Question for Design |
|---|---|---|
| **Container shape** | `max-w-2xl`, `rounded-xl`, `border-gray-200`, `bg-gray-50`, `p-6 shadow-sm` | Is this a modal, a slide-over panel, a full-page route, or an inline expansion of the Protected Object card? |
| **Step indicator** | Horizontal segmented bar (6 segments, `h-1`, blue fill for completed/current, gray for future) | Confirm bar vs. numbered step bubbles. Current bar has no step labels — is that acceptable? |
| **Step header** | `Step N of 6` label (blue, uppercase, 12px) + `h2` title | Should the wizard display a persistent breadcrumb or just the current step label? |
| **Backup point selection** | Radio list rows with timestamp + counts + ID | Is a dropdown more appropriate? Should rows be sortable? |
| **Destination cards** | Radio `label` elements styled as bordered cards; no icons | Design to confirm: icon-per-destination (e.g. home / arrows / download), or text-only cards? |
| **Conflict mode cards** | Bordered radio cards with help text inline | Override card has a caution note — does Design want a warning icon/colour treatment for Override specifically? |
| **Trash-window block banner** | Red inline banner above destination radios; disables Original location option with `opacity-40` | Confirm: banner copy, link to Atlassian admin docs, CTA wording. |
| **ADF media warning** | Yellow inline banner on Step 5 (Review) and Step 6 (Execute) | Confirm: is this a dismissible toast, a persistent inline alert, or an entry in a restore report sidebar? |
| **Phase progress** | Seven `PhaseRow` components stacked in a bordered card; running phase shows a thin blue progress bar | Confirm: should completed phases collapse? Should phase rows animate in sequentially? |
| **Ask-mode conflict prompt** | Purple bordered card with two buttons (Override / Skip) inlined in the Execute step | This is the most design-sensitive surface. Confirm: full-page block, modal overlay, or inline card? What metadata should be shown (current field values, diff view)? |
| **Stalled-job banner** | Yellow inline banner within the Execute step | Confirm: should this surface in the sidebar/notification tray rather than inside the wizard? |
| **Close button** | Plain dark button, right-aligned, only visible when job is terminal | Should there be a "View report" action alongside Close on completion? |

### 1.4 Unanswered Visual Questions — Restore-Unit

1. **Entry point**: How does the user open the wizard? From a "Restore" button on the Protected Object card, from a toolbar action, or from a right-click context menu? The Figma spec for the Protected Object card (OC-001) is needed here first.
2. **Modal vs. slide-over vs. route**: Is the wizard a modal overlay, a right-side slide-over (matching the Inventory sidebar), or a dedicated route (`/restore/:backupPointId`)?
3. **Scope selection UX**: Step 2 uses a textarea for comma-separated keys. Is a multi-select typeahead against the live manifest preferred?
4. **Conflict prompt content**: When Ask-mode triggers, what metadata does Design want shown? The current implementation surfaces only object type and key — no diff view. Is a side-by-side diff (backup value vs. current value) required?
5. **Restore report**: Is there a separate "restore report" surface (a list of per-item results, errors, ADF warnings)? If so, this is not yet specced and the close button currently has no "View report" affordance.
6. **Phase labels copy**: Current phase labels are `Projects`, `Workflows & Schemes`, `Custom Fields & Configurations`, `Boards`, `Sprints`, `Issues`, `Links, Comments & Attachments`. Confirm these are the correct user-facing strings.
7. **Status badge colours**: Status badge uses Tailwind colour utilities (green/yellow/red/purple/blue). Confirm these map to the platform design token set.
8. **Trash-window block — CTA**: Current copy says "wait for a Site Admin to restore the project from the Atlassian admin trash." Confirm link target and exact copy.
9. **Browser Download UX**: When destination is "Browser Download (export)", does a native browser `<a download>` trigger suffice, or should there be a progress indicator before the ZIP is ready?
10. **Alternate location — project picker**: Currently a free-text input for project key. Does Design want a typeahead against discoverable projects on the connected site?

---

## 2. Board/Sprint Sidebar Filters (OC-002 / OC-003)

### 2.1 As-Built Component Paths

| Artefact | Path |
|---|---|
| Inventory sidebar | `frontend/src/components/InventorySidebar.tsx` |
| Inventory view (parent) | `frontend/src/components/InventoryView.tsx` |
| Issues filter panel | `frontend/src/components/ProjectInventorySearch.tsx` |
| Inventory API contract | `docs/architecture/inventory-ui.md` §2–§4 |
| Project Inventory Search doc | `docs/architecture/project-inventory-search.md` |

### 2.2 Current State

Phase 1 ships filters for the **Issues** sidebar selection only:

| Filter | Type | As-built |
|---|---|---|
| Issue status | Multi-select | ✅ shipped Sprint 10 |
| Issue type | Multi-select | ✅ shipped Sprint 10 |
| Priority | Multi-select | ✅ shipped Sprint 10 |
| Assignee (`accountId`) | Text input | ✅ shipped Sprint 10 |
| Labels | Tag input | ✅ shipped Sprint 10 |
| Updated date range | Date range picker | ✅ shipped Sprint 10 |

**Boards and Sprints have no filter panel.** When the sidebar selection is `JiraBoard` or `JiraSprint`, the detail view shows the object list without filter controls.

The minimum required fields for Board/Sprint filters (from OC-002) are:
- Board name search (substring)
- Sprint state filter (active / closed / future)
- Associated project selector

### 2.3 Unanswered Visual Questions — Board/Sprint Sidebar Filters

1. **Panel shape**: Should Board/Sprint filters use the same collapsible panel shell as the Issues filter panel, or a distinct layout (e.g. a compact toolbar above the results table)?
2. **Board name search**: Substring input or typeahead against the manifest? Should it debounce or require explicit submit?
3. **Sprint state filter**: Radio (single-select) or checkbox group (multi-select)? Is "All states" the default, or "Active only"?
4. **Associated project selector**: Free-text project key input or a dropdown/typeahead populated from the manifest's project list? Multi-select (filter sprints across multiple projects) or single-select?
5. **Board detail view**: When a Board row is selected, what columns appear in the object list? (Currently unspecced — Issues table columns are documented in `docs/architecture/inventory-ui.md` §3, but Board columns are not.)
6. **Sprint detail view**: Same question — what columns for the Sprint list? (Candidate: Sprint Name, State, Start Date, End Date, Associated Board, Issue Count.)
7. **Filter count badge**: Issues sidebar row shows a count badge. Do Board/Sprint sidebar rows need a count badge breakdown by filter state (e.g. "3 active, 12 closed")?
8. **Empty state**: If no Boards or Sprints exist in the backup manifest, what empty-state copy should appear?
9. **SDI tags on Board/Sprint cards**: Do Board or Sprint Protected Object cards surface SDI regulation tags? (Issues and Projects cards do — OC-003 §3.)
10. **Restore affordance on Board/Sprint cards**: Does "Restore" on a Board or Sprint restore the whole Board/Sprint graph (including contained issues), or only the Board/Sprint metadata object? This affects both the filter design and the restore-unit card spec.

---

## 3. SDI Regulation Tags on Protected Object Cards (OC-003 §3)

The SDI scanner produces regulation tags (`GDPR`, `PCI DSS`) surfaced on Protected Object cards (Issues, Projects). The visual treatment of these badges is unspecced.

### 3.1 Unanswered Visual Questions

1. **Badge shape**: Pill / chip / icon+label? Should GDPR and PCI DSS have distinct icon treatments (e.g. shield icon for GDPR, lock icon for PCI DSS)?
2. **Placement on card**: Top-right corner badge, below the object name, or inline with the status/policy column?
3. **Tooltip / popover**: Should clicking the badge open a detail panel listing matched patterns, or is the badge text-only?
4. **Severity tiers**: If both GDPR and PCI DSS fire on the same object, is there a combined "high risk" state, or are both badges shown independently?
5. **Dismissed state**: Can an operator acknowledge/dismiss an SDI finding? If so, what visual state does a dismissed badge enter?

---

## 4. Action Items for Design

| # | Action | Owner | Needed by |
|---|---|---|---|
| D-01 | Deliver Figma frame for restore-unit wizard (steps 1–6, all states: default, trash-block, ask-conflict, stalled, terminal) | @design | Sprint 12 kickoff |
| D-02 | Specify entry point for restore wizard (card button, toolbar, context menu) | @design | Sprint 12 kickoff |
| D-03 | Confirm wizard container type (modal / slide-over / route) | @design | Sprint 12 kickoff |
| D-04 | Specify Board filter panel layout and column list for Board detail view | @design | Sprint 12 kickoff |
| D-05 | Specify Sprint filter panel layout and column list for Sprint detail view | @design | Sprint 12 kickoff |
| D-06 | Specify SDI regulation tag badge visual treatment | @design | Sprint 12 kickoff |
| D-07 | Confirm phase label copy and status badge colour tokens | @design | Sprint 12 kickoff |
| D-08 | Specify restore report surface (post-completion summary) | @design | Sprint 13 (restore engine phase) |

---

## 5. References

- `docs/open-contracts.md` — OC-001, OC-002, OC-003
- `docs/restore-architecture.md` — full restore engine spec
- `docs/architecture/inventory-ui.md` — Inventory UI data contracts and §6 open contracts
- `docs/architecture/project-inventory-search.md` — Project Inventory search and filter contracts
- `frontend/src/components/RestoreWizard.tsx` — as-built wizard (provisional layout, see design note at top of file)
- `frontend/src/components/InventorySidebar.tsx` — as-built sidebar
- `frontend/src/components/ProjectInventorySearch.tsx` — as-built Issues filter panel
- Sprint 11 PR description (links back here per acceptance criteria)

---

_This document will be updated when the Figma frame is delivered. Until then, Sprint 12 implementers must build conservatively against acceptance-criteria text and flag any layout invention in their PR description._
