import React, { useState } from 'react';
import type { JiraSite } from '../types';
import { submitManualConnection, ManualAuthError } from '../api/jira';

interface ManualAuthFormProps {
  onConnected: (site: JiraSite) => void;
  onCancel: () => void;
}

interface FormFields {
  siteUrl: string;
  cloudId: string;
  email: string;
  apiToken: string;
}

const ERROR_LABELS: Record<string, string> = {
  INVALID_URL: 'Site URL must be https://<subdomain>.atlassian.net',
  INVALID_CLOUDID: 'Cloud ID must be a valid UUID',
  INVALID_EMAIL: 'Email must be a valid address',
  INVALID_TOKEN: 'API Token must not be empty',
  AUTH_FAILED: 'Credentials rejected by Atlassian — check your email and token',
  NETWORK_ERROR: 'Unable to reach Atlassian — check your network connection',
};

export function ManualAuthForm({ onConnected, onCancel }: ManualAuthFormProps) {
  const [fields, setFields] = useState<FormFields>({
    siteUrl: '',
    cloudId: '',
    email: '',
    apiToken: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = e.target;
    setFields((prev: FormFields) => ({ ...prev, [name]: value }));
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await submitManualConnection(fields);
      // Build a minimal JiraSite from what we know; backend doesn't return full site object
      const site: JiraSite = {
        id: fields.cloudId,
        name: new URL(fields.siteUrl).hostname.split('.')[0],
        url: fields.siteUrl,
        scopes: [],
        avatarUrl: '',
      };
      onConnected(site);
    } catch (err) {
      if (err instanceof ManualAuthError) {
        setError(ERROR_LABELS[err.code] ?? err.message);
      } else {
        setError('An unexpected error occurred. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="mb-1 text-base font-semibold text-gray-900">Connect with API Token</h2>
      <p className="mb-5 text-xs text-gray-500">
        Use an Atlassian API token to connect without OAuth.
      </p>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-700">Site URL</span>
          <input
            type="url"
            name="siteUrl"
            value={fields.siteUrl}
            onChange={handleChange}
            placeholder="https://yoursite.atlassian.net"
            required
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-700">Cloud ID</span>
          <input
            type="text"
            name="cloudId"
            value={fields.cloudId}
            onChange={handleChange}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            required
            className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-700">Email</span>
          <input
            type="email"
            name="email"
            value={fields.email}
            onChange={handleChange}
            placeholder="you@example.com"
            required
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-700">API Token</span>
          <input
            type="password"
            name="apiToken"
            value={fields.apiToken}
            onChange={handleChange}
            placeholder="Atlassian API token"
            required
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={submitting}
            className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 transition-colors"
          >
            {submitting ? 'Verifying…' : 'Connect'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
