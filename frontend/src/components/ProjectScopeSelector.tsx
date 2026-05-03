import { useEffect, useState } from 'react';
import type { JiraSite } from '../types';
import {
  fetchDiscoveryPreview,
  fetchWorkloadConfig,
  saveWorkloadConfig,
  type DiscoveryPreview,
} from '../api/jira';

// ── Risk notice ───────────────────────────────────────────────────────────────
// Design MCP frame was not available during implementation. This component was
// built to the acceptance criteria text. The JSM notice uses the same visual
// treatment as WorkloadCard's JSM exclusion notice (blue info style). RISK: final
// visual may diverge from design spec once a Design MCP frame is available.

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProjectScopeSelectorProps {
  site: JiraSite;
  onComplete: (config: { scope: 'all' | 'selected'; selectedKeys: string[] }) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ProjectScopeSelector({ site, onComplete }: ProjectScopeSelectorProps) {
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  const [preview, setPreview] = useState<DiscoveryPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Load discovery preview + saved config in parallel on mount.
  // If either fails, degrade gracefully: scope defaults to 'all', project list
  // is empty (user can still proceed with All projects).
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const [previewData, savedConfig] = await Promise.all([
          fetchDiscoveryPreview(site.id),
          fetchWorkloadConfig(site.id),
        ]);
        if (cancelled) return;
        setPreview(previewData);
        setScope(savedConfig.scope);
        setSelectedKeys(savedConfig.selectedKeys);
      } catch {
        if (!cancelled) {
          setLoadError(
            'Could not load project list from Jira. You can still set scope to All projects and save.',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [site.id]);

  function toggleKey(key: string) {
    setSelectedKeys((prev: string[]) =>
      prev.includes(key) ? prev.filter((k: string) => k !== key) : [...prev, key],
    );
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);

    const resolvedKeys = scope === 'all' ? [] : selectedKeys;

    try {
      await saveWorkloadConfig({ cloudId: site.id, scope, selectedKeys: resolvedKeys });
      onComplete({ scope, selectedKeys: resolvedKeys });
    } catch {
      setSaveError('Failed to save configuration. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const canSave = scope === 'all' || selectedKeys.length > 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white shadow-sm">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="px-5 pt-5 pb-4 border-b border-gray-100">
        <h2 className="text-base font-semibold text-gray-900">Configure Project Scope</h2>
        <p className="mt-1 text-sm text-gray-500">
          Choose which projects on{' '}
          <span className="font-medium text-gray-700">{site.name}</span> to include in
          daily backups.
        </p>
      </div>

      {/* ── JSM out-of-scope notice ──────────────────────────────────────────── */}
      {/* Renders only when service_desk projects were detected. Uses the same
          visual treatment as WorkloadCard's JSM exclusion notice. */}
      {preview && preview.jsmProjectsDetected > 0 && (
        <div className="border-b border-gray-100 px-5 py-3">
          <div
            role="note"
            aria-label="JSM out-of-scope notice"
            className="flex items-start gap-2 rounded-md bg-blue-50 border border-blue-200 px-3 py-2.5 text-xs text-blue-700"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="mt-0.5 h-4 w-4 shrink-0 text-blue-500"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
                clipRule="evenodd"
              />
            </svg>
            <span>
              <strong>
                {preview.jsmProjectsDetected} Jira Service Management project
                {preview.jsmProjectsDetected !== 1 ? 's' : ''} detected.
              </strong>{' '}
              JSM objects are excluded from Phase 1 backup and restore. Full JSM backup
              support is planned for Phase 2.
            </span>
          </div>
        </div>
      )}

      {/* ── Project scope radio selector ─────────────────────────────────────── */}
      <div className="px-5 py-4">
        <fieldset>
          <legend className="text-sm font-medium text-gray-700 mb-3">Project scope</legend>

          <div className="flex flex-col gap-3">
            {/* All projects (default) */}
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="project-scope"
                value="all"
                checked={scope === 'all'}
                onChange={() => setScope('all')}
                className="mt-0.5 h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500"
              />
              <div>
                <span className="text-sm font-medium text-gray-900">All projects</span>
                <p className="text-xs text-gray-500 mt-0.5">
                  Back up every project on this site (JSM projects excluded — Phase 2).
                </p>
              </div>
            </label>

            {/* Selected projects */}
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="project-scope"
                value="selected"
                checked={scope === 'selected'}
                onChange={() => setScope('selected')}
                className="mt-0.5 h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500"
              />
              <div>
                <span className="text-sm font-medium text-gray-900">Selected projects</span>
                <p className="text-xs text-gray-500 mt-0.5">
                  Choose specific projects to include in backup.
                </p>
              </div>
            </label>
          </div>
        </fieldset>

        {/* ── Multi-select — visible only when 'Selected projects' is chosen ── */}
        {scope === 'selected' && (
          <div className="mt-4">
            {/* Load error fallback */}
            {loadError && (
              <div
                role="alert"
                className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700"
              >
                {loadError}
              </div>
            )}

            {/* Loading spinner */}
            {loading && !loadError && (
              <div className="flex items-center gap-2 py-2 text-xs text-gray-500">
                <svg
                  className="h-3.5 w-3.5 animate-spin text-blue-500"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                  />
                </svg>
                Loading projects…
              </div>
            )}

            {/* Empty state */}
            {!loading && preview && preview.projects.length === 0 && (
              <p className="py-2 text-xs text-gray-500">
                No in-scope projects found on this site.
              </p>
            )}

            {/* Project multi-select list */}
            {!loading && preview && preview.projects.length > 0 && (
              <>
                <p className="mb-2 text-xs text-gray-500">
                  {selectedKeys.length === 0
                    ? 'Select one or more projects to include:'
                    : `${selectedKeys.length} project${selectedKeys.length !== 1 ? 's' : ''} selected:`}
                </p>

                <div
                  role="listbox"
                  aria-multiselectable="true"
                  aria-label="Projects"
                  className="max-h-48 overflow-y-auto rounded-md border border-gray-200 divide-y divide-gray-100"
                >
                  {preview.projects.map((project) => {
                    const isSelected = selectedKeys.includes(project.key);
                    return (
                      <div
                        key={project.key}
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => toggleKey(project.key)}
                        className={[
                          'flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors',
                          isSelected
                            ? 'bg-blue-50 text-blue-900'
                            : 'text-gray-700 hover:bg-gray-50',
                        ].join(' ')}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleKey(project.key)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Select ${project.name}`}
                          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                        <span className="shrink-0 font-mono text-xs text-gray-400">
                          {project.key}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {selectedKeys.length === 0 && (
                  <p className="mt-1.5 text-xs text-red-600">
                    Select at least one project to continue.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Save error ──────────────────────────────────────────────────────── */}
      {saveError && (
        <div className="px-5 pb-3">
          <p
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
          >
            {saveError}
          </p>
        </div>
      )}

      {/* ── Footer / actions ────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-t border-gray-100 px-5 py-4">
        <p className="text-xs text-gray-400 italic">
          {/* Design MCP not available — flagged as implementation risk */}
          No Design MCP frame — built to acceptance text (risk flagged).
        </p>

        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !canSave}
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
        >
          {saving && (
            <svg
              className="h-3.5 w-3.5 animate-spin"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
          )}
          {saving ? 'Saving…' : 'Save & Continue'}
        </button>
      </div>
    </div>
  );
}
