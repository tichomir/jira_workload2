/**
 * IssuesTable — paginated browse table for JiraIssue objects.
 *
 * Column order (per inventory-ui.md §3.3):
 *   1. Issue Key
 *   2. Summary
 *   3. Issue Status   ← Jira workflow status (NOT the same as "Status")
 *   4. Issue Type
 *   5. Assignee
 *   6. Status         ← DCC platform protection status (NOT "Issue Status")
 *   7. Policy
 *   8. Last Backup
 *
 * "Issue Status" and "Status" column headers each carry a tooltip that
 * clarifies the semantic distinction to prevent operator confusion.
 *
 * TODO(sprint-2): Add Project Inventory in-app search with filters
 *   (issueKey exact match, tokenised summary, issueStatus, issueType,
 *    priority, assigneeAccountId, labels, updated date range).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchIssues } from '../api/jira';
import type { IssueTableRow } from '../api/jira';

// ── Tooltip ───────────────────────────────────────────────────────────────────

interface TooltipProps {
  text: string;
  children: React.ReactNode;
}

function Tooltip({ text, children }: TooltipProps) {
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

// ── Column header definitions ─────────────────────────────────────────────────

interface ColumnDef {
  key: keyof IssueTableRow | 'lastBackupFormatted';
  header: React.ReactNode;
  /** aria-label for the <th> — plain text without tooltip markup. */
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
      <span className="text-gray-700">{row.assignee ?? <em className="text-gray-400">Unassigned</em>}</span>
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
        : d.toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          });
      return <span className="text-gray-600 whitespace-nowrap">{formatted}</span>;
    },
  },
];

// ── Pagination ────────────────────────────────────────────────────────────────

interface PaginationProps {
  offset: number;
  limit: number;
  total: number;
  onPageChange: (newOffset: number) => void;
}

function Pagination({ offset, limit, total, onPageChange }: PaginationProps) {
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div
      data-testid="issues-pagination"
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
          data-testid="pagination-prev"
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
          data-testid="pagination-next"
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

// ── IssuesTable ───────────────────────────────────────────────────────────────

export interface IssuesTableProps {
  cloudId: string;
  /** Default page size. Defaults to 50. */
  pageSize?: number;
}

type LoadState = 'loading' | 'loaded' | 'error';

export function IssuesTable({ cloudId, pageSize = 50 }: IssuesTableProps) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [rows, setRows] = useState<IssueTableRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    (newOffset: number) => {
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = new AbortController();

      setLoadState('loading');

      fetchIssues(cloudId, { offset: newOffset, limit: pageSize })
        .then((data) => {
          setRows(data.issues);
          setTotal(data.total);
          setOffset(newOffset);
          setLoadState('loaded');
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          setLoadState('error');
        });
    },
    [cloudId, pageSize],
  );

  useEffect(() => {
    load(0);
    return () => {
      abortRef.current?.abort();
    };
  }, [load]);

  return (
    <div data-testid="issues-table-container" className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table data-testid="issues-table" className="w-full text-sm">
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
                <td colSpan={COLUMNS.length} className="px-4 py-8 text-center text-gray-400">
                  Loading issues…
                </td>
              </tr>
            )}
            {loadState === 'error' && (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  data-testid="issues-table-error"
                  className="px-4 py-8 text-center text-red-600"
                >
                  Failed to load issues.
                </td>
              </tr>
            )}
            {loadState === 'loaded' && rows.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="px-4 py-8 text-center text-gray-400">
                  No issues found in the latest backup point.
                </td>
              </tr>
            )}
            {loadState === 'loaded' &&
              rows.map((row) => (
                <tr
                  key={row.issueKey}
                  data-testid={`issue-row-${row.issueKey}`}
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
          offset={offset}
          limit={pageSize}
          total={total}
          onPageChange={load}
        />
      )}
    </div>
  );
}
