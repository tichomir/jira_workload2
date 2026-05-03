# Open Design Contracts
_Tracked blockers awaiting external input (Design, Product, or cross-team dependencies)._
_Updated at sprint end. Resolved contracts are moved to the archive section below._

---

## Active Blockers

### OC-001 — Figma Spec: Restore-Unit Card Design
**Status:** OPEN  
**Raised:** Sprint 9 (Phase 5, Sprint 1 of 2)  
**Owner:** Design  
**Required by:** Sprint 10 (Phase 5, Sprint 2 of 2)  
**Blocking:** Restore button affordance on Protected Object cards (Issues, Projects, Boards, Sprints).  
**Detail:**  
The restore-unit card needs to show: object type badge, display name, backup point timestamp, conflict mode selector (Override / Skip / Ask — default: Skip per T5 §5.1), destination selector (Original location / Alternate location / Export). Without the Figma frame, implementers must not invent a layout — build conservatively to acceptance-criteria text and flag in sprint 2 review.  
**Reference:** `docs/architecture/inventory-ui.md` §6 OC-001

---

### OC-002 — Figma Spec: Board/Sprint Sidebar Filters
**Status:** OPEN  
**Raised:** Sprint 9 (Phase 5, Sprint 1 of 2)  
**Owner:** Design  
**Required by:** Sprint 10 (Phase 5, Sprint 2 of 2)  
**Blocking:** Filter panel for Boards and Sprints in the sidebar detail view. Phase 1 ships Issues filters (status, issueType, priority, assigneeAccountId, labels, updated date range). Board/Sprint filter UI shape is not yet specced.  
**Detail:**  
Minimum required fields for the Board/Sprint filter panel:
- Board name search (substring)
- Sprint state filter (active / closed / future)
- Associated project selector  

**Reference:** `docs/architecture/inventory-ui.md` §6 OC-002

---

### OC-003 — Jira-Specific Figma Spec: Restore-Unit and Board/Sprint Sidebar Filters (Combined)
**Status:** OPEN  
**Raised:** Sprint 10 (Phase 5, Sprint 2 of 2)  
**Owner:** Design  
**Required by:** Next SDI / Restore phase sprint planning  
**Blocking:** Both the restore-unit card design and the Board/Sprint filter panel layout for the Jira-specific Inventory UI. OC-001 and OC-002 above cover the same concern; this entry tracks the consolidated Jira-specific Figma deliverable that resolves both.  
**Detail:**  
A single Figma spec covering:
1. Jira-specific restore-unit card with all required fields (see OC-001 detail).
2. Board/Sprint sidebar filter panel with board name search, sprint state filter, and project selector (see OC-002 detail).
3. Visual treatment of SDI regulation tags (GDPR / PCI DSS badges) on Protected Object cards.
4. Error and "stalled" alert states in the Inventory UI.

Until this spec is delivered, Sprint 10 implementers must build conservatively against acceptance-criteria text only. Any invented layout will require rework when the spec arrives.

---

## Resolved Contracts

_(None yet. Resolved contracts will be archived here with resolution date and PR reference.)_
