import { useEffect, useState } from 'react';
import type { AuthMode, JiraSite } from '../types';
import { subscribeAuthError, type AuthErrorCode } from '../api/authErrorChannel';
import { initiateOAuth } from '../api/jira';

// ── Protected Object Types ────────────────────────────────────────────────────

interface ObjectTypeRow {
  label: string;
  icon: React.ReactNode;
}

const PROTECTED_OBJECT_TYPES: ObjectTypeRow[] = [
  {
    label: 'Issues',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-blue-500" aria-hidden="true">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
      </svg>
    ),
  },
  {
    label: 'Projects',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-blue-500" aria-hidden="true">
        <path d="M3.75 3A1.75 1.75 0 002 4.75v3.26a3.235 3.235 0 011.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0016.25 5h-4.836a.25.25 0 01-.177-.073L9.823 3.513A1.75 1.75 0 008.586 3H3.75zM3.75 9A1.75 1.75 0 002 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0018 15.25v-4.5A1.75 1.75 0 0016.25 9H3.75z" />
      </svg>
    ),
  },
  {
    label: 'Boards',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-blue-500" aria-hidden="true">
        <path fillRule="evenodd" d="M4.25 2A2.25 2.25 0 002 4.25v11.5A2.25 2.25 0 004.25 18h11.5A2.25 2.25 0 0018 15.75V4.25A2.25 2.25 0 0015.75 2H4.25zm0 1.5h11.5c.414 0 .75.336.75.75v11.5a.75.75 0 01-.75.75H4.25a.75.75 0 01-.75-.75V4.25c0-.414.336-.75.75-.75zM8 7.5a.75.75 0 000 1.5h4a.75.75 0 000-1.5H8zm-2 4a.75.75 0 000 1.5h8a.75.75 0 000-1.5H6z" clipRule="evenodd" />
      </svg>
    ),
  },
  {
    label: 'Sprints',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-blue-500" aria-hidden="true">
        <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
      </svg>
    ),
  },
];

// ── Auth-error banner ─────────────────────────────────────────────────────────

interface AuthErrorBannerProps {
  code: AuthErrorCode;
  authMode: AuthMode;
  onReconnect: () => void;
}

function AuthErrorBanner({ code, authMode, onReconnect }: AuthErrorBannerProps) {
  const is401 = code === 401;

  const headline = is401
    ? 'Connection expired — reconnect to resume backups'
    : 'Insufficient permissions — reauthorize with Site Admin';

  const ctaLabel = is401 ? 'Reconnect' : 'Reauthorize';

  function handleCta() {
    if (authMode === 'oauth') {
      initiateOAuth();
    } else {
      onReconnect();
    }
  }

  return (
    <div
      role="alert"
      className="mt-4 flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="mt-0.5 h-4 w-4 shrink-0 text-red-500"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
          clipRule="evenodd"
        />
      </svg>
      <div className="flex-1">
        <p className="font-medium">{headline}</p>
        <button
          type="button"
          onClick={handleCta}
          className="mt-2 rounded bg-red-100 px-3 py-1.5 text-xs font-semibold text-red-800 hover:bg-red-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 transition-colors"
        >
          {ctaLabel}
        </button>
      </div>
    </div>
  );
}

// ── WorkloadCard ──────────────────────────────────────────────────────────────

interface WorkloadCardProps {
  site: JiraSite;
  authMode: AuthMode;
  /** Called when the user needs to go back to manual form (API Token reconnect). */
  onManualReconnect: () => void;
  /** Called when user wants to switch account / start over. */
  onDisconnect: () => void;
}

export function WorkloadCard({
  site,
  authMode,
  onManualReconnect,
  onDisconnect,
}: WorkloadCardProps) {
  const [authError, setAuthError] = useState<AuthErrorCode | null>(null);

  // Subscribe to auth errors emitted by the API layer.
  // Banner persists until onManualReconnect / initiateOAuth navigates away or
  // the parent replaces this component with a reconnected WorkloadCard.
  useEffect(() => {
    const unsub = subscribeAuthError((code) => setAuthError(code));
    return unsub;
  }, []);

  return (
    <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white shadow-sm">
      {/* ── Connection summary header ──────────────────────────────────────── */}
      <div className="flex items-center gap-3 p-5">
        {site.avatarUrl ? (
          <img src={site.avatarUrl} alt="" className="h-10 w-10 rounded-full object-cover" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-sm font-bold text-blue-700">
            {site.name.charAt(0).toUpperCase()}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-gray-900">{site.name}</p>
          <p className="truncate font-mono text-xs text-gray-400">{site.id}</p>
        </div>

        {/* Auth mode badge */}
        <span
          className={[
            'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
            authMode === 'oauth'
              ? 'bg-blue-100 text-blue-700'
              : 'bg-amber-100 text-amber-700',
          ].join(' ')}
        >
          {authMode === 'oauth' ? 'OAuth' : 'API Token'}
        </span>
      </div>

      {/* ── Protected Object Types ─────────────────────────────────────────── */}
      <div className="border-t border-gray-100 px-5 py-4">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Protected Object Types
        </h3>
        <ul className="flex flex-col gap-2" role="list">
          {PROTECTED_OBJECT_TYPES.map(({ label, icon }) => (
            <li key={label} className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm text-gray-700">
                {icon}
                {label}
              </span>
              <span className="text-xs text-gray-400">—</span>
            </li>
          ))}
        </ul>
      </div>

      {/* ── JSM exclusion notice ───────────────────────────────────────────── */}
      <div className="border-t border-gray-100 px-5 py-3">
        <div
          role="note"
          aria-label="JSM exclusion notice"
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
            <strong>Phase 1 scope:</strong> Jira Service Management objects are not protected in
            Phase 1. JSM tickets, queues, request types, and SLAs are excluded from backup and
            restore.
          </span>
        </div>
      </div>

      {/* ── Auth error banner (persists until reconnect) ───────────────────── */}
      {authError && (
        <div className="border-t border-gray-100 px-5 pb-4">
          <AuthErrorBanner
            code={authError}
            authMode={authMode}
            onReconnect={onManualReconnect}
          />
        </div>
      )}

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <div className="border-t border-gray-100 px-5 py-3">
        <button
          type="button"
          onClick={onDisconnect}
          className="text-xs text-gray-400 underline underline-offset-2 hover:text-gray-600 transition-colors"
        >
          Switch account or site
        </button>
      </div>
    </div>
  );
}
