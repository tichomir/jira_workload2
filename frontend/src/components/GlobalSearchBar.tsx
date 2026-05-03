/**
 * GlobalSearchBar — cross-entity search over projectKey, projectName,
 * boardName, and sprintName.
 *
 * Renders a text input above the Issues table. On input (debounced 300ms),
 * calls GET /api/search?q=<term> and shows a dropdown overlay of typed
 * Protected Object cards — each card shows:
 *   • Type badge (Project | Board | Sprint)
 *   • Display name
 *   • projectKey context line (when available)
 *
 * Clicking a card navigates to its typed detail route:
 *   /inventory/projects/<id>
 *   /inventory/boards/<id>
 *   /inventory/sprints/<id>
 *   /inventory/issues/<id>
 *
 * Note: JiraIssue records are NOT included in Global Search. Issue search is
 * handled by Project Inventory Search (GET /api/inventory/issues?q=), deferred
 * to sprint 2.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { searchInventory } from '../api/jira';
import type { SearchCard } from '../api/jira';

// ── Type badge ────────────────────────────────────────────────────────────────

const TYPE_BADGE_STYLES: Record<SearchCard['type'], string> = {
  JiraProject: 'bg-violet-100 text-violet-700',
  JiraBoard:   'bg-sky-100 text-sky-700',
  JiraSprint:  'bg-amber-100 text-amber-700',
  JiraIssue:   'bg-gray-100 text-gray-700',
};

const TYPE_LABELS: Record<SearchCard['type'], string> = {
  JiraProject: 'Project',
  JiraBoard:   'Board',
  JiraSprint:  'Sprint',
  JiraIssue:   'Issue',
};

function TypeBadge({ type }: { type: SearchCard['type'] }) {
  return (
    <span
      className={[
        'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-medium',
        TYPE_BADGE_STYLES[type],
      ].join(' ')}
    >
      {TYPE_LABELS[type]}
    </span>
  );
}

// ── Route helper ──────────────────────────────────────────────────────────────

function detailRoute(card: SearchCard): string {
  const segmentMap: Record<SearchCard['type'], string> = {
    JiraProject: 'projects',
    JiraBoard:   'boards',
    JiraSprint:  'sprints',
    JiraIssue:   'issues',
  };
  return `/inventory/${segmentMap[card.type]}/${encodeURIComponent(card.id)}`;
}

// ── Single result card ────────────────────────────────────────────────────────

interface ResultCardProps {
  card: SearchCard;
  onNavigate: (route: string) => void;
}

function ResultCard({ card, onNavigate }: ResultCardProps) {
  return (
    <button
      type="button"
      data-testid={`search-result-${card.type}-${card.id}`}
      onClick={() => onNavigate(detailRoute(card))}
      className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-gray-50 focus-visible:bg-gray-50"
    >
      <TypeBadge type={card.type} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-800">
          {card.displayName}
        </p>
        {card.projectKey && (
          <p className="text-xs text-gray-500">Project: {card.projectKey}</p>
        )}
      </div>
    </button>
  );
}

// ── GlobalSearchBar ───────────────────────────────────────────────────────────

export interface GlobalSearchBarProps {
  cloudId: string;
  /**
   * Called when the user selects a search result card.
   * Receives the target route (e.g. /inventory/projects/abc123).
   * Defaults to window.location.href navigation when not provided.
   */
  onNavigate?: (route: string) => void;
  /** Debounce delay in ms. Defaults to 300. */
  debounceMs?: number;
}

export function GlobalSearchBar({
  cloudId,
  onNavigate,
  debounceMs = 300,
}: GlobalSearchBarProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchCard[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Search on query change ────────────────────────────────────────────────

  const runSearch = useCallback(
    (q: string) => {
      if (!q.trim()) {
        setResults([]);
        setOpen(false);
        setLoading(false);
        setError(false);
        return;
      }

      setLoading(true);
      setError(false);

      searchInventory(cloudId, q)
        .then((data) => {
          setResults(data.results);
          setOpen(true);
          setLoading(false);
        })
        .catch(() => {
          setError(true);
          setLoading(false);
        });
    },
    [cloudId],
  );

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => runSearch(query), debounceMs);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query, debounceMs, runSearch]);

  // ── Close on outside click ────────────────────────────────────────────────

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ── Navigation ────────────────────────────────────────────────────────────

  function handleNavigate(route: string) {
    setOpen(false);
    setQuery('');
    if (onNavigate) {
      onNavigate(route);
    } else {
      window.location.href = route;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      data-testid="global-search-container"
      className="relative w-full max-w-lg"
    >
      <div className="relative">
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-3 flex items-center text-gray-400"
        >
          {/* magnifier icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"
            />
          </svg>
        </span>
        <input
          type="search"
          data-testid="global-search-input"
          aria-label="Search projects, boards, and sprints"
          placeholder="Search projects, boards, sprints…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
          className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-4 text-sm text-gray-800 placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        {loading && (
          <span
            aria-label="Searching…"
            className="absolute inset-y-0 right-3 flex items-center"
          >
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          </span>
        )}
      </div>

      {open && (
        <div
          data-testid="global-search-dropdown"
          role="listbox"
          aria-label="Search results"
          className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
        >
          {error && (
            <p
              data-testid="search-error"
              className="px-4 py-3 text-sm text-red-600"
            >
              Search failed. Try again.
            </p>
          )}

          {!error && results.length === 0 && (
            <p className="px-4 py-3 text-sm text-gray-500">
              No results for &ldquo;{query}&rdquo;
            </p>
          )}

          {!error &&
            results.length > 0 &&
            results.map((card) => (
              <ResultCard
                key={`${card.type}-${card.id}`}
                card={card}
                onNavigate={handleNavigate}
              />
            ))}
        </div>
      )}
    </div>
  );
}
