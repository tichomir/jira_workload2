import { useState } from 'react';
import type { JiraSite } from '../types';
import { ApiError, selectSite } from '../api/jira';

interface SitePickerProps {
  sites: JiraSite[];
  onConnected: (site: JiraSite) => void;
  onError: (code: 401 | 403 | 'network' | 'unknown', message: string) => void;
}

export function SitePicker({ sites, onConnected, onError }: SitePickerProps) {
  const [selectedId, setSelectedId] = useState<string>(sites[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);

  async function handleConfirm() {
    if (!selectedId || submitting) return;
    setSubmitting(true);
    try {
      const result = await selectSite(selectedId);
      onConnected(result.site);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) onError(401, err.message);
        else if (err.status === 403) onError(403, err.message);
        else onError('unknown', err.message);
      } else {
        onError('network', err instanceof Error ? err.message : 'Network error');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-5 py-4">
        <h2 className="text-base font-semibold text-gray-900">Select a Jira site</h2>
        <p className="mt-1 text-sm text-gray-500">
          Multiple sites were found on your account. Choose one to connect.
        </p>
      </div>

      <ul role="listbox" aria-label="Jira sites" className="divide-y divide-gray-100">
        {sites.map((site) => {
          const isSelected = site.id === selectedId;
          return (
            <li
              key={site.id}
              role="option"
              aria-selected={isSelected}
              onClick={() => setSelectedId(site.id)}
              className={`flex cursor-pointer items-center gap-3 px-5 py-3.5 transition-colors ${
                isSelected
                  ? 'bg-blue-50 ring-inset ring-1 ring-blue-300'
                  : 'hover:bg-gray-50'
              }`}
            >
              {/* Avatar or fallback */}
              {site.avatarUrl ? (
                <img
                  src={site.avatarUrl}
                  alt=""
                  className="h-8 w-8 rounded-full object-cover"
                />
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700">
                  {site.name.charAt(0).toUpperCase()}
                </div>
              )}

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-900">{site.name}</p>
                <p className="truncate text-xs text-gray-400">{site.url}</p>
                <p className="truncate font-mono text-xs text-gray-300">{site.id}</p>
              </div>

              {/* Selection indicator */}
              <div
                className={`h-4 w-4 shrink-0 rounded-full border-2 transition-colors ${
                  isSelected ? 'border-blue-600 bg-blue-600' : 'border-gray-300'
                }`}
                aria-hidden="true"
              />
            </li>
          );
        })}
      </ul>

      <div className="border-t border-gray-100 px-5 py-4">
        <button
          type="button"
          disabled={!selectedId || submitting}
          onClick={handleConfirm}
          className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
        >
          {submitting ? 'Connecting…' : 'Connect to selected site'}
        </button>
      </div>
    </div>
  );
}
