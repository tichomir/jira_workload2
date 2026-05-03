import { useEffect, useState } from 'react';
import { fetchInventorySummary } from '../api/jira';

// ── Types ─────────────────────────────────────────────────────────────────────

export type InventoryObjectType = 'JiraIssue' | 'JiraProject' | 'JiraBoard' | 'JiraSprint';

export const DEFAULT_SELECTED_TYPE: InventoryObjectType = 'JiraIssue';

interface SidebarRowDef {
  objectType: InventoryObjectType;
  label: string;
}

const ROWS: SidebarRowDef[] = [
  { objectType: 'JiraIssue',   label: 'Issues'   },
  { objectType: 'JiraProject', label: 'Projects' },
  { objectType: 'JiraBoard',   label: 'Boards'   },
  { objectType: 'JiraSprint',  label: 'Sprints'  },
];

// ── Props ─────────────────────────────────────────────────────────────────────

export interface InventorySidebarProps {
  /** Cloud ID of the connected Jira site — passed as x-cloud-id header. */
  cloudId: string;
  /** Currently selected object type. Callers should initialise with DEFAULT_SELECTED_TYPE. */
  selectedType: InventoryObjectType;
  /** Called when the user clicks a sidebar row. */
  onSelect: (type: InventoryObjectType) => void;
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div
      aria-hidden="true"
      className="flex items-center justify-between rounded-md px-3 py-2.5"
    >
      <div className="h-4 w-16 rounded bg-gray-200 animate-pulse" />
      <div className="h-4 w-8 rounded bg-gray-200 animate-pulse" />
    </div>
  );
}

// ── Single row ────────────────────────────────────────────────────────────────

interface SidebarRowProps {
  objectType: InventoryObjectType;
  label: string;
  /** null = no backup point yet → render em-dash */
  count: number | null;
  selected: boolean;
  onClick: () => void;
}

function SidebarRow({ objectType, label, count, selected, onClick }: SidebarRowProps) {
  const countDisplay = count === null ? '—' : count.toLocaleString();

  return (
    <button
      type="button"
      data-testid={`sidebar-row-${objectType}`}
      aria-pressed={selected}
      onClick={onClick}
      className={[
        'flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left transition-colors',
        selected
          ? 'bg-blue-50 text-blue-700 font-semibold'
          : 'text-gray-700 hover:bg-gray-100',
      ].join(' ')}
    >
      <span className="text-sm">{label}</span>
      <span
        data-testid={`sidebar-count-${objectType}`}
        className={[
          'text-sm tabular-nums',
          selected ? 'text-blue-700 font-semibold' : 'text-gray-500',
        ].join(' ')}
      >
        {countDisplay}
      </span>
    </button>
  );
}

// ── InventorySidebar ──────────────────────────────────────────────────────────

type LoadState = 'loading' | 'loaded' | 'error';

export function InventorySidebar({ cloudId, selectedType, onSelect }: InventorySidebarProps) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [counts, setCounts] = useState<Record<InventoryObjectType, number | null>>({
    JiraIssue:   null,
    JiraProject: null,
    JiraBoard:   null,
    JiraSprint:  null,
  });

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');

    fetchInventorySummary(cloudId)
      .then((summary) => {
        if (cancelled) return;
        // When backupPointId is null, no backup exists — keep counts as null (renders em-dash).
        // When backupPointId is present, use the numeric counts from the API.
        if (summary.backupPointId === null) {
          setCounts({ JiraIssue: null, JiraProject: null, JiraBoard: null, JiraSprint: null });
        } else {
          setCounts({
            JiraIssue:   summary.counts.JiraIssue   ?? 0,
            JiraProject: summary.counts.JiraProject ?? 0,
            JiraBoard:   summary.counts.JiraBoard   ?? 0,
            JiraSprint:  summary.counts.JiraSprint  ?? 0,
          });
        }
        setLoadState('loaded');
      })
      .catch(() => {
        if (cancelled) return;
        setLoadState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [cloudId]);

  return (
    <nav
      aria-label="Inventory object types"
      data-testid="inventory-sidebar"
      className="flex flex-col gap-1 rounded-lg border border-gray-200 bg-white p-3 shadow-sm w-48"
    >
      <p className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
        Object Types
      </p>

      {loadState === 'loading' && (
        <>
          {ROWS.map((row) => (
            <SkeletonRow key={row.objectType} />
          ))}
        </>
      )}

      {loadState === 'error' && (
        <p
          data-testid="sidebar-error"
          className="px-3 py-2 text-xs text-red-600"
        >
          Failed to load counts.
        </p>
      )}

      {loadState === 'loaded' && (
        <>
          {ROWS.map((row) => (
            <SidebarRow
              key={row.objectType}
              objectType={row.objectType}
              label={row.label}
              count={counts[row.objectType]}
              selected={selectedType === row.objectType}
              onClick={() => onSelect(row.objectType)}
            />
          ))}
        </>
      )}
    </nav>
  );
}
