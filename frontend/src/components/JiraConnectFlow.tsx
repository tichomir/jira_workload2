import React, { useEffect, useRef, useState } from 'react';
import type { AuthMode, ConnectionFlowState, JiraSite } from '../types';
import { clearOAuthParams, parseOAuthCallbackParam } from '../api/jira';
import { ConnectButton } from './ConnectButton';
import { SitePicker } from './SitePicker';
import { ErrorBanner } from './ErrorBanner';
import { WorkloadCard } from './WorkloadCard';
import { ManualConnectForm } from './ManualConnectForm';
import { ProjectScopeSelector } from './ProjectScopeSelector';

/**
 * JiraConnectFlow — top-level orchestrator for the Jira OAuth connection UI.
 *
 * State machine:
 *   idle  →  (click Connect)  →  pending (navigate to /api/jira/oauth/start)
 *   idle  →  (API Token link)  →  manual-form
 *   pending  →  (OAuth callback return)  →  site-selection | connected | error
 *   site-selection  →  (user confirms)  →  connected (oauth) | error
 *   manual-form  →  (submit success)  →  connected (api_token)
 *   manual-form  →  (cancel)  →  idle
 *   connected  →  (auth error 401/403 for api_token)  →  manual-form
 *   connected  →  (auth error 401/403 for oauth)  →  OAuth redirect
 *   error  →  (Reconnect)  →  pending
 *
 * The backend callback handler redirects to:
 *   /?oauth_result=<base64url(JSON)>          on success
 *   /?oauth_error=<reason>                    on failure
 */
export function JiraConnectFlow() {
  const [state, setState] = useState<ConnectionFlowState>({ phase: 'idle' });
  const [autoConnectedBanner, setAutoConnectedBanner] = useState<string | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // On mount: detect OAuth callback return via URL params
  useEffect(() => {
    const result = parseOAuthCallbackParam();
    if (!result) return;          // normal page load

    clearOAuthParams();           // remove oauth_* from URL bar

    if (!result.ok) {
      setState({ phase: 'error', code: 'unknown', message: result.reason });
      return;
    }

    const { data } = result;

    if (data.status !== 'connected') {
      setState({ phase: 'error', code: 'unknown', message: 'Unexpected OAuth response status' });
      return;
    }

    if (data.site) {
      // Single site — auto-select, skip picker
      setState({ phase: 'connected', site: data.site, authMode: 'oauth' });
      showAutoConnectedBanner(data.site.name);
    } else if (data.sites && data.sites.length > 0) {
      setState({ phase: 'site-selection', sites: data.sites });
    } else {
      setState({ phase: 'error', code: 'unknown', message: 'No accessible Jira sites returned.' });
    }
  }, []);

  function showAutoConnectedBanner(siteName: string) {
    setAutoConnectedBanner(siteName);
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = setTimeout(() => setAutoConnectedBanner(null), 4000);
  }

  function handleConnected(site: JiraSite, authMode: AuthMode = 'oauth') {
    // Route through onboarding to configure project scope before showing WorkloadCard.
    setState({ phase: 'onboarding', site, authMode });
    showAutoConnectedBanner(site.name);
  }

  function handleOnboardingComplete(site: JiraSite, authMode: AuthMode) {
    setState({ phase: 'connected', site, authMode });
  }

  function handleError(code: 401 | 403 | 'network' | 'unknown', message: string) {
    setState({ phase: 'error', code, message });
  }

  function handleDismissError() {
    setState({ phase: 'idle' });
  }

  return (
    <div className="flex flex-col items-center gap-6">
      {/* Auto-select transient banner */}
      {autoConnectedBanner && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-md bg-green-50 border border-green-200 px-4 py-2.5 text-sm font-medium text-green-800 shadow-sm transition-all"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4 shrink-0 text-green-600"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
              clipRule="evenodd"
            />
          </svg>
          Connected to <span className="font-semibold">{autoConnectedBanner}</span>
        </div>
      )}

      {/* Error banner */}
      {state.phase === 'error' && (
        <div className="w-full max-w-md">
          <ErrorBanner
            code={state.code}
            message={state.message}
            onDismiss={handleDismissError}
          />
        </div>
      )}

      {/* Idle: show Connect button + manual auth link */}
      {state.phase === 'idle' && (
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-sm text-gray-500">
            Authorise with your Atlassian account to connect Jira Cloud.
          </p>
          <ConnectButton />
          <button
            type="button"
            onClick={() => setState({ phase: 'manual-form' })}
            className="text-xs text-gray-400 underline underline-offset-2 hover:text-gray-600 transition-colors"
          >
            Connect with API Token
          </button>
        </div>
      )}

      {/* Pending: user navigated away for OAuth — show spinner if they somehow stay on page */}
      {state.phase === 'pending' && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <svg
            className="h-4 w-4 animate-spin text-blue-500"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Waiting for Atlassian authorisation…
        </div>
      )}

      {/* Multi-site picker */}
      {state.phase === 'site-selection' && (
        <SitePicker
          sites={state.sites}
          onConnected={(site) => handleConnected(site, 'oauth')}
          onError={handleError}
        />
      )}

      {/* Manual API Token form */}
      {state.phase === 'manual-form' && (
        <ManualConnectForm
          onConnected={(site) => handleConnected(site, 'api_token')}
          onCancel={() => setState({ phase: 'idle' })}
        />
      )}

      {/* Onboarding: Project scope selector wizard step */}
      {state.phase === 'onboarding' && (
        <ProjectScopeSelector
          site={state.site}
          onComplete={() => handleOnboardingComplete(state.site, state.authMode)}
        />
      )}

      {/* Connected: WorkloadCard with all protection details and error banner */}
      {state.phase === 'connected' && (
        <WorkloadCard
          site={state.site}
          authMode={state.authMode}
          onManualReconnect={() => setState({ phase: 'manual-form' })}
          onDisconnect={() => setState({ phase: 'idle' })}
        />
      )}
    </div>
  );
}
