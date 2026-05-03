/**
 * ProjectInventorySearch — in-project issue search with filter panel.
 *
 * Renders:
 *   1. Project key input — scopes all searches to a specific project.
 *   2. Search input (debounced 250 ms) — issueKey exact match OR tokenised
 *      summary search, routed to GET /api/inventory/projects/:key/issues.
 *   3. Filter panel (toggle) — six filters: Issue Status, Issue Type, Priority,
 *      Assignee (account ID), Labels (multi-add), Updated date range.
 *   4. Active-filter chips — one chip per active filter; individual × clear;
 *      "Clear all" affordance when any filter is active.
 *   5. Issues table — same dual-column labelling as IssuesTable (Sprint 9):
 *      "Issue Status" (Jira workflow) vs "Status" (DCC platform protection).
 *   6. Empty state — shown when search + filters yield zero results.
 *
 * NOTE: Assignee typeahead (displayName → accountId) is not implemented here
 * because no Phase 1 API exposes assignee lookup. The filter accepts a raw
 * accountId string. This is flagged as a known gap per the open contract
 * (no Figma spec for the filter panel — OC-002 in inventory-ui.md §6).
 */

import React, { useEffect, useRef, useState } from 'react';
import { fetchProjectIssues } from '../api/jira';
import type { IssueTableRow, ProjectIssuesParams } from '../api/jira';

// ── Filter state ──────────────────────────────────────────────────────────────

interface FilterState {
  status: string;
  issueType: string;
  priority: string;
  assigneeAccountId: string;
  labels: string[];
  updatedFrom: string;
  updatedTo: string;
}

const EMPTY_FILTERS: FilterState = {
  status: '',
  issueType: '',
  priority: '',
  assigneeAccountId: '',
  labels: [],
  updatedFrom: '',
  updatedTo: '',
};

function hasActiveFilters(f: FilterState): boolean {
  return (
    f.status !== '' ||
    f.issueType !== '' ||
    f.priority !== '' ||
    f.assigneeAccountId !== '' ||
    f.labels.length > 0 ||
    f.updatedFrom !== '' ||
    f.updatedTo !== ''
  );
}

// ── Bundled fetch params (single object keeps the fetch effect simple) ────────

interface FetchParams {
  projectKey: string;
  query: string;
  filters: FilterState;
  offset: number;
  limit: number;
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  return (
    <span
      className="relative inline-flex items-center gap-1 cursor-default"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      <span
        aria-hidden="true"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-400 text-gray-500 text-xs leading-none select-none"
      >
        ?
      </span>
      {visible && (
        <span
          role="tooltip"
          className="absolute left-0 top-6 z-10 w-56 rounded bg-gray-800 px-2 py-1.5 text-xs text-white shadow-lg whitespace-normal"
        >
          {text}
        </span>
      )}
    </span>
  );
}

// ── Column definitions — preserves Issue Status / Status dual labelling ───────

interface ColumnDef {
  key: string;
  header: React.ReactNode;
  /** Plain-text aria-label (no tooltip markup). */
  ariaLabel: string;
  render: (row: IssueTableRow) => React.ReactNode;
}

const COLUMNS: ColumnDef[] = [
  {
    key: 'issueKey',
    header: 'Issue Key',
    ariaLabel: 'Issue Key',
    render: (row) => (
      <span className="font-mono text-xs text-blue-700">{row.issueKey}</span>
    ),
  },
  {
    key: 'summary',
    header: 'Summary',
    ariaLabel: 'Summary',
    render: (row) => (
      <span className="text-gray-800 line-clamp-2">{row.summary ?? '—'}</span>
    ),
  },
  {
    key: 'issueStatus',
    header: (
      <Tooltip text="The Jira workflow status of the issue at the time it was backed up (e.g. 'In Progress', 'Done'). This is NOT the DCC platform protection status.">
        Issue Status
      </Tooltip>
    ),
    ariaLabel: 'Issue Status (Jira workflow state)',
    render: (row) => (
      <span className="text-gray-700">{row.issueStatus ?? '—'}</span>
    ),
  },
  {
    key: 'issueType',
    header: 'Issue Type',
    ariaLabel: 'Issue Type',
    render: (row) => (
      <span className="text-gray-700">{row.issueType ?? '—'}</span>
    ),
  },
  {
    key: 'assignee',
    header: 'Assignee',
    ariaLabel: 'Assignee',
    render: (row) => (
      <span className="text-gray-700">
        {row.assignee ?? <em className="text-gray-400">Unassigned</em>}
      </span>
    ),
  },
  {
    key: 'platformStatus',
    header: (
      <Tooltip text="The DCC platform's protection status for this object — whether it was successfully captured or encountered an error. This is NOT the Jira workflow status.">
        Status
      </Tooltip>
    ),
    ariaLabel: 'Status (DCC platform protection status)',
    render: (row) => {
      const isProtected = row.platformStatus === 'protected';
      return (
        <span
          data-testid={`platform-status-${row.issueKey}`}
          className={[
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
            isProtected
              ? 'bg-green-50 text-green-700 ring-1 ring-green-600/20'
              : 'bg-red-50 text-red-700 ring-1 ring-red-600/20',
          ].join(' ')}
        >
          {isProtected ? 'Protected' : 'Error'}
        </span>
      );
    },
  },
  {
    key: 'policy',
    header: 'Policy',
    ariaLabel: 'Policy',
    render: (row) => (
      <span className="text-gray-700 capitalize">{row.policy}</span>
    ),
  },
  {
    key: 'lastBackupFormatted',
    header: 'Last Backup',
    ariaLabel: 'Last Backup',
    render: (row) => {
      const d = new Date(row.lastBackupAt);
      const formatted = isNaN(d.getTime())
        ? row.lastBackupAt
        : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      return (
        <span className="text-gray-600 whitespace-nowrap">{formatted}</span>
      );
    },
  },
];

// ── Pagination ────────────────────────────────────────────────────────────────

function Pagination({
  offset,
  limit,
  total,
  onPageChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onPageChange: (newOffset: number) => void;
}) {
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return (
    <div
      data-testid="project-search-pagination"
      className="flex items-center justify-between border-t border-gray-200 bg-white px-4 py-3"
    >
      <p className="text-sm text-gray-500">
        Showing{' '}
        <span className="font-medium">{Math.min(offset + 1, total)}</span>
        {' – '}
        <span className="font-medium">{Math.min(offset + limit, total)}</span>
        {' of '}
        <span className="font-medium">{total.toLocaleString()}</span>
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="project-search-prev"
          disabled={offset === 0}
          onClick={() => onPageChange(Math.max(0, offset - limit))}
          className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Previous
        </button>
        <span className="flex items-center px-2 text-sm text-gray-600">
          Page {currentPage} of {totalPages}
        </span>
        <button
          type="button"
          data-testid="project-search-next"
          disabled={offset + limit >= total}
          onClick={() => onPageChange(offset + limit)}
          className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}

// ── Filter chip ───────────────────────────────────────────────────────────────

function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-blue-600/20">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter: ${label}`}
        className="ml-0.5 rounded-full p-0.5 hover:bg-blue-100"
      >
        ×
      </button>
    </span>
  );
}

// ── ProjectInventorySearch ────────────────────────────────────────────────────

export interface ProjectInventorySearchProps {
  /** Cloud ID of the connected Jira site. Passed as x-cloud-id header. */
  cloudId: string;
  /**
   * Pre-populate the project key field (e.g. from route navigation).
   * User can still edit or clear it.
   */
  initialProjectKey?: string;
  /** Rows per page. Defaults to 50. */
  pageSize?: number;
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

export function ProjectInventorySearch({
  cloudId,
  initialProjectKey = '',
  pageSize = 50,
}: ProjectInventorySearchProps) {
  // ── Project key input state ────────────────────────────────────────────────
  const [projectKeyInput, setProjectKeyInput] = useState(initialProjectKey);

  // ── Search + filter state ──────────────────────────────────────────────────
  const [rawQuery, setRawQuery] = useState('');
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [labelInput, setLabelInput] = useState('');

  // ── Single bundled fetch-params object (drives the fetch effect) ───────────
  const [fetchParams, setFetchParams] = useState<FetchParams>({
    projectKey: initialProjectKey,
    query: '',
    filters: EMPTY_FILTERS,
    offset: 0,
    limit: pageSize,
  });

  // ── Results state ──────────────────────────────────────────────────────────
  const [rows, setRows] = useState<IssueTableRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>(
    initialProjectKey ? 'loading' : 'idle',
  );

  const abortRef = useRef<AbortController | null>(null);

  // ── Debounce: rawQuery → fetchParams.query (offset reset to 0) ────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      setFetchParams((prev) => ({
        ...prev,
        query: rawQuery,
        offset: 0,
      }));
    }, 250);
    return () => clearTimeout(timer);
  }, [rawQuery]);

  // ── Filter changes → fetchParams (offset reset to 0) ─────────────────────
  useEffect(() => {
    setFetchParams((prev) => ({ ...prev, filters, offset: 0 }));
  }, [filters]);

  // ── "Go" button / Enter: commit project key → fetchParams ─────────────────
  function commitProjectKey() {
    const key = projectKeyInput.trim().toUpperCase();
    setProjectKeyInput(key);
    setFetchParams({
      projectKey: key,
      query: rawQuery,
      filters,
      offset: 0,
      limit: pageSize,
    });
  }

  // ── Pagination: update offset only ────────────────────────────────────────
  function handlePageChange(newOffset: number) {
    setFetchParams((prev) => ({ ...prev, offset: newOffset }));
  }

  // ── Fetch effect ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!fetchParams.projectKey) {
      setLoadState('idle');
      setRows([]);
      setTotal(0);
      return;
    }

    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    setLoadState('loading');

    const params: ProjectIssuesParams = {
      offset: fetchParams.offset,
      limit: fetchParams.limit,
    };
    if (fetchParams.query) params.q = fetchParams.query;
    if (fetchParams.filters.status) params.status = fetchParams.filters.status;
    if (fetchParams.filters.issueType) params.issueType = fetchParams.filters.issueType;
    if (fetchParams.filters.priority) params.priority = fetchParams.filters.priority;
    if (fetchParams.filters.assigneeAccountId)
      params.assigneeAccountId = fetchParams.filters.assigneeAccountId;
    if (fetchParams.filters.labels.length > 0)
      params.labels = fetchParams.filters.labels;
    if (fetchParams.filters.updatedFrom) params.updatedFrom = fetchParams.filters.updatedFrom;
    if (fetchParams.filters.updatedTo) params.updatedTo = fetchParams.filters.updatedTo;

    fetchProjectIssues(cloudId, fetchParams.projectKey, params)
      .then((data) => {
        setRows(data.issues);
        setTotal(data.total);
        setLoadState('loaded');
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setLoadState('error');
      });

    return () => {
      abortRef.current?.abort();
    };
  }, [cloudId, fetchParams]);

  // ── Filter helpers ────────────────────────────────────────────────────────

  function updateFilter<K extends keyof FilterState>(key: K, value: FilterState[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function addLabel() {
    const trimmed = labelInput.trim();
    if (trimmed && !filters.labels.includes(trimmed)) {
      updateFilter('labels', [...filters.labels, trimmed]);
    }
    setLabelInput('');
  }

  function removeLabel(label: string) {
    updateFilter(
      'labels',
      filters.labels.filter((l) => l !== label),
    );
  }

  function clearAllFilters() {
    setFilters(EMPTY_FILTERS);
    setLabelInput('');
  }

  // ── Derive active-filter chips ────────────────────────────────────────────

  const chips: Array<{ label: string; onRemove: () => void }> = [];
  if (filters.status)
    chips.push({ label: `Issue Status: ${filters.status}`, onRemove: () => updateFilter('status', '') });
  if (filters.issueType)
    chips.push({ label: `Type: ${filters.issueType}`, onRemove: () => updateFilter('issueType', '') });
  if (filters.priority)
    chips.push({ label: `Priority: ${filters.priority}`, onRemove: () => updateFilter('priority', '') });
  if (filters.assigneeAccountId)
    chips.push({ label: `Assignee: ${filters.assigneeAccountId}`, onRemove: () => updateFilter('assigneeAccountId', '') });
  filters.labels.forEach((l) =>
    chips.push({ label: `Label: ${l}`, onRemove: () => removeLabel(l) }),
  );
  if (filters.updatedFrom)
    chips.push({ label: `Updated from: ${filters.updatedFrom}`, onRemove: () => updateFilter('updatedFrom', '') });
  if (filters.updatedTo)
    chips.push({ label: `Updated to: ${filters.updatedTo}`, onRemove: () => updateFilter('updatedTo', '') });

  const anyFilters = hasActiveFilters(filters);
  const projectKeySet = !!fetchParams.projectKey;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div data-testid="project-inventory-search" className="flex flex-col gap-4">

      {/* ── Project key input ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <label
          htmlFor="project-key-input"
          className="shrink-0 text-sm font-medium text-gray-700"
        >
          Project Key
        </label>
        <input
          id="project-key-input"
          data-testid="project-key-input"
          type="text"
          value={projectKeyInput}
          onChange={(e) => setProjectKeyInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitProjectKey();
          }}
          placeholder="e.g. PROJ"
          className="flex-1 rounded border border-gray-300 px-3 py-1.5 font-mono text-sm text-gray-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          aria-label="Project key"
        />
        <button
          type="button"
          data-testid="project-key-submit"
          onClick={commitProjectKey}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
        >
          Go
        </button>
      </div>

      {/* ── Search bar + filter toggle (only when project key is committed) ── */}
      {projectKeySet && (
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-sm focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400">
            <svg
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-gray-400"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="search"
              data-testid="project-search-input"
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              placeholder="Search by issue key (e.g. PROJ-1) or summary keywords…"
              className="flex-1 bg-transparent text-sm text-gray-800 placeholder-gray-400 focus:outline-none"
              aria-label="Search issues"
            />
            {rawQuery && (
              <button
                type="button"
                onClick={() => setRawQuery('')}
                aria-label="Clear search"
                className="shrink-0 text-gray-400 hover:text-gray-600"
              >
                ×
              </button>
            )}
          </div>
          <button
            type="button"
            data-testid="filter-toggle"
            onClick={() => setFiltersOpen((o) => !o)}
            aria-expanded={filtersOpen}
            aria-controls="filter-panel"
            className={[
              'rounded border px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1',
              anyFilters
                ? 'border-blue-500 bg-blue-50 text-blue-700'
                : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50',
            ].join(' ')}
          >
            Filters{anyFilters ? ` (${chips.length})` : ''}
          </button>
        </div>
      )}

      {/* ── Filter panel ─────────────────────────────────────────────────── */}
      {projectKeySet && filtersOpen && (
        <div
          id="filter-panel"
          data-testid="filter-panel"
          className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">

            {/* Issue Status */}
            <div className="flex flex-col gap-1">
              <label htmlFor="filter-status" className="text-xs font-medium text-gray-600">
                Issue Status
              </label>
              <input
                id="filter-status"
                data-testid="filter-status"
                type="text"
                value={filters.status}
                onChange={(e) => updateFilter('status', e.target.value)}
                placeholder="e.g. In Progress, Done"
                className="rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {/* Issue Type */}
            <div className="flex flex-col gap-1">
              <label htmlFor="filter-issue-type" className="text-xs font-medium text-gray-600">
                Issue Type
              </label>
              <input
                id="filter-issue-type"
                data-testid="filter-issue-type"
                type="text"
                value={filters.issueType}
                onChange={(e) => updateFilter('issueType', e.target.value)}
                placeholder="e.g. Bug, Story, Task"
                className="rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {/* Priority */}
            <div className="flex flex-col gap-1">
              <label htmlFor="filter-priority" className="text-xs font-medium text-gray-600">
                Priority
              </label>
              <input
                id="filter-priority"
                data-testid="filter-priority"
                type="text"
                value={filters.priority}
                onChange={(e) => updateFilter('priority', e.target.value)}
                placeholder="e.g. High, Medium, Low"
                className="rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {/* Assignee — account ID text input (typeahead deferred to Phase 2) */}
            <div className="flex flex-col gap-1">
              <label htmlFor="filter-assignee" className="text-xs font-medium text-gray-600">
                Assignee Account ID
              </label>
              <input
                id="filter-assignee"
                data-testid="filter-assignee"
                type="text"
                value={filters.assigneeAccountId}
                onChange={(e) => updateFilter('assigneeAccountId', e.target.value)}
                placeholder="Atlassian account ID"
                className="rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-400">
                Display-name typeahead requires a Phase 2 assignee-lookup API.
              </p>
            </div>

            {/* Labels — multi-add */}
            <div className="flex flex-col gap-1">
              <label htmlFor="filter-label-input" className="text-xs font-medium text-gray-600">
                Labels
              </label>
              <div className="flex gap-1">
                <input
                  id="filter-label-input"
                  data-testid="filter-label-input"
                  type="text"
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addLabel();
                    }
                  }}
                  placeholder="Add label…"
                  className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  type="button"
                  data-testid="filter-label-add"
                  onClick={addLabel}
                  className="rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-50 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  Add
                </button>
              </div>
              {filters.labels.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {filters.labels.map((l) => (
                    <span
                      key={l}
                      className="inline-flex items-center gap-0.5 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700"
                    >
                      {l}
                      <button
                        type="button"
                        onClick={() => removeLabel(l)}
                        aria-label={`Remove label ${l}`}
                        className="hover:text-red-600"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Updated date range */}
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-600">
                Updated Date Range
              </span>
              <div className="flex gap-2">
                <div className="flex flex-1 flex-col gap-0.5">
                  <label htmlFor="filter-updated-from" className="text-xs text-gray-500">
                    From
                  </label>
                  <input
                    id="filter-updated-from"
                    data-testid="filter-updated-from"
                    type="date"
                    value={filters.updatedFrom}
                    onChange={(e) => updateFilter('updatedFrom', e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div className="flex flex-1 flex-col gap-0.5">
                  <label htmlFor="filter-updated-to" className="text-xs text-gray-500">
                    To
                  </label>
                  <input
                    id="filter-updated-to"
                    data-testid="filter-updated-to"
                    type="date"
                    value={filters.updatedTo}
                    onChange={(e) => updateFilter('updatedTo', e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Clear all filters */}
          {anyFilters && (
            <div className="mt-4 flex justify-end border-t border-gray-100 pt-3">
              <button
                type="button"
                data-testid="clear-all-filters"
                onClick={clearAllFilters}
                className="text-sm text-gray-500 underline hover:text-gray-700"
              >
                Clear all filters
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Active filter chips ───────────────────────────────────────────── */}
      {projectKeySet && chips.length > 0 && (
        <div
          data-testid="active-filter-chips"
          className="flex flex-wrap items-center gap-2"
          aria-label="Active filters"
        >
          {chips.map((chip) => (
            <FilterChip key={chip.label} label={chip.label} onRemove={chip.onRemove} />
          ))}
          <button
            type="button"
            data-testid="clear-all-chips"
            onClick={clearAllFilters}
            className="text-xs text-gray-500 underline hover:text-gray-700"
          >
            Clear all
          </button>
        </div>
      )}

      {/* ── Results table (shown when project key is committed) ──────────── */}
      {projectKeySet && (
        <div
          data-testid="project-issues-table-container"
          className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm"
        >
          <div className="overflow-x-auto">
            <table data-testid="project-issues-table" className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left">
                  {COLUMNS.map((col) => (
                    <th
                      key={col.ariaLabel}
                      aria-label={col.ariaLabel}
                      scope="col"
                      className="px-4 py-3 font-semibold text-gray-600 whitespace-nowrap"
                    >
                      {col.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loadState === 'loading' && (
                  <tr>
                    <td
                      colSpan={COLUMNS.length}
                      className="px-4 py-8 text-center text-gray-400"
                    >
                      Loading issues…
                    </td>
                  </tr>
                )}
                {loadState === 'error' && (
                  <tr>
                    <td
                      colSpan={COLUMNS.length}
                      data-testid="project-search-error"
                      className="px-4 py-8 text-center text-red-600"
                    >
                      Failed to load issues. Check the project key and try again.
                    </td>
                  </tr>
                )}
                {loadState === 'loaded' && rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={COLUMNS.length}
                      data-testid="project-search-empty"
                      className="px-4 py-8 text-center text-gray-400"
                    >
                      No issues match your search and filters.
                    </td>
                  </tr>
                )}
                {loadState === 'loaded' &&
                  rows.map((row) => (
                    <tr
                      key={row.issueKey}
                      data-testid={`project-issue-row-${row.issueKey}`}
                      className="border-b border-gray-100 hover:bg-gray-50"
                    >
                      {COLUMNS.map((col) => (
                        <td key={col.ariaLabel} className="px-4 py-3 align-top">
                          {col.render(row)}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          {loadState === 'loaded' && total > 0 && (
            <Pagination
              offset={fetchParams.offset}
              limit={pageSize}
              total={total}
              onPageChange={handlePageChange}
            />
          )}
        </div>
      )}

      {/* ── Prompt: no project key entered yet ───────────────────────────── */}
      {!projectKeySet && (
        <div
          data-testid="project-search-prompt"
          className="flex h-64 items-center justify-center rounded-lg border border-dashed border-gray-300 bg-white text-gray-400"
        >
          <p className="text-sm">
            Enter a project key above and press{' '}
            <kbd className="rounded border border-gray-300 px-1 py-0.5 font-mono text-xs">
              Go
            </kbd>{' '}
            to search issues within that project.
          </p>
        </div>
      )}
    </div>
  );
}
