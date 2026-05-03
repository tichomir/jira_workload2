/**
 * InventoryView — top-level layout for the Protected Object Inventory UI.
 *
 * Composition (per inventory-ui.md §7):
 *   InventoryView
 *   ├── InventorySidebar  (object-type selector with counts)
 *   └── main panel
 *       ├── GlobalSearchBar  (cross-entity search → typed result cards)
 *       └── IssuesTable      (paginated browse when Issues is selected)
 *
 * Phase 1 renders the IssuesTable when the sidebar selection is 'JiraIssue'.
 * Other object types show a "coming soon" placeholder.
 *
 * TODO(sprint-2): Add Project Inventory in-app search filters panel.
 * TODO(sprint-2): Implement Projects / Boards / Sprints detail views
 *   (blocked on OC-001 restore-unit Figma spec and OC-002 Board/Sprint
 *    sidebar filter spec — see inventory-ui.md §6).
 */

import React, { useState } from 'react';
import {
  InventorySidebar,
  DEFAULT_SELECTED_TYPE,
} from './InventorySidebar';
import type { InventoryObjectType } from './InventorySidebar';
import { IssuesTable } from './IssuesTable';
import { GlobalSearchBar } from './GlobalSearchBar';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface InventoryViewProps {
  /** Cloud ID of the connected Jira site. */
  cloudId: string;
  /**
   * Navigation callback — called when the user clicks a Global Search result.
   * Defaults to window.location.href assignment when not provided.
   */
  onNavigate?: (route: string) => void;
}

// ── Placeholder for non-Issue views ──────────────────────────────────────────

function ComingSoonPanel({ type }: { type: InventoryObjectType }) {
  const labels: Record<InventoryObjectType, string> = {
    JiraIssue:   'Issues',
    JiraProject: 'Projects',
    JiraBoard:   'Boards',
    JiraSprint:  'Sprints',
  };
  return (
    <div
      data-testid={`placeholder-${type}`}
      className="flex h-64 items-center justify-center rounded-lg border border-dashed border-gray-300 bg-white text-gray-400"
    >
      <p className="text-sm">{labels[type]} detail view — coming in sprint 2</p>
    </div>
  );
}

// ── InventoryView ─────────────────────────────────────────────────────────────

export function InventoryView({ cloudId, onNavigate }: InventoryViewProps) {
  const [selectedType, setSelectedType] =
    useState<InventoryObjectType>(DEFAULT_SELECTED_TYPE);

  return (
    <div
      data-testid="inventory-view"
      className="flex min-h-screen gap-6 bg-gray-50 p-6"
    >
      {/* Sidebar */}
      <aside className="shrink-0">
        <InventorySidebar
          cloudId={cloudId}
          selectedType={selectedType}
          onSelect={setSelectedType}
        />
      </aside>

      {/* Main panel */}
      <main className="flex min-w-0 flex-1 flex-col gap-4">
        {/* Global Search */}
        <GlobalSearchBar cloudId={cloudId} onNavigate={onNavigate} />

        {/* Content area */}
        {selectedType === 'JiraIssue' ? (
          <IssuesTable cloudId={cloudId} />
        ) : (
          <ComingSoonPanel type={selectedType} />
        )}
      </main>
    </div>
  );
}
