import React from 'react';
import { initiateOAuth } from '../api/jira';

interface ErrorBannerProps {
  code: 401 | 403 | 'network' | 'unknown';
  message: string;
  onDismiss?: () => void;
}

const MESSAGES: Record<ErrorBannerProps['code'], string> = {
  401: 'Your Jira session has expired or the credentials are invalid.',
  403: 'Access denied — the authorising account may lack Site Admin or Org Admin role.',
  network: 'A network error occurred. Check your connection and try again.',
  unknown: 'An unexpected error occurred.',
};

export function ErrorBanner({ code, message, onDismiss }: ErrorBannerProps) {
  const headline = MESSAGES[code] ?? message;

  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800"
    >
      {/* Warning icon */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="mt-0.5 h-5 w-5 shrink-0 text-red-500"
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
        {message && message !== headline && (
          <p className="mt-1 text-red-700">{message}</p>
        )}

        <div className="mt-3 flex gap-3">
          <button
            type="button"
            onClick={initiateOAuth}
            className="rounded bg-red-100 px-3 py-1.5 text-xs font-semibold text-red-800 hover:bg-red-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 transition-colors"
          >
            Reconnect
          </button>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 transition-colors"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
