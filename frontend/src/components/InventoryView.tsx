/**
 * InventoryView — top-level layout for the Protected Object Inventory UI.
 *
 * Composition (per inventory-ui.md §7):
 *   InventoryView
 *   ├── InventorySidebar  (object-type selector with counts)
 *   └── main panel
 *       ├── GlobalSearchBar           (cross-entity search → typed result cards)
 *       └── ProjectInventorySearch   (project-scoped issue search + filters,
 *                                     shown when Issues is selected)
 *
 * Phase 1 renders ProjectInventorySearch when the sidebar selection is
 * 'JiraIssue'. Other object types show a "coming soon" placeholder.
 *
 * NOTE (OC-001, OC-002): Projects / Boards / Sprints detail views are blocked
 * on Figma specs for the restore-unit card and Board/Sprint sidebar filters
 * respectively — see inventory-ui.md §6.
 */

import React, { useState } from 'react';
import {
  InventorySidebar,
  DEFAULT_SELECTED_TYPE,
} from './InventorySidebar';
import type { InventoryObjectType } from './InventorySidebar';
import { ProjectInventorySearch } from './ProjectInventorySearch';
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
          <ProjectInventorySearch cloudId={cloudId} />
        ) : (
          <ComingSoonPanel type={selectedType} />
        )}
      </main>
    </div>
  );
}
