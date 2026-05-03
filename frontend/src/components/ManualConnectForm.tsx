import { useState } from 'react';
import type { JiraSite } from '../types';
import { submitManualConnection, ApiError, ManualAuthError } from '../api/jira';

interface ManualConnectFormProps {
  onConnected: (site: JiraSite) => void;
  onCancel: () => void;
}

// ── Client-side validation (mirrors backend rules) ──────────────────────────

const ATLASSIAN_NET_RE = /^https:\/\/[a-zA-Z0-9-]+\.atlassian\.net(\/.*)?$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateSiteUrl(v: string): string | null {
  if (!v.trim()) return 'Site URL is required.';
  if (!ATLASSIAN_NET_RE.test(v.trim()))
    return 'Must be https://<subdomain>.atlassian.net';
  return null;
}

function validateCloudId(v: string): string | null {
  if (!v.trim()) return 'Cloud ID is required.';
  if (!UUID_RE.test(v.trim())) return 'Must be a valid UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).';
  return null;
}

function validateEmail(v: string): string | null {
  if (!v.trim()) return 'Email is required.';
  if (!EMAIL_RE.test(v.trim())) return 'Must be a valid email address.';
  return null;
}

function validateApiToken(v: string): string | null {
  if (!v.trim()) return 'API token is required.';
  return null;
}

// ── Backend error code → user-readable message ───────────────────────────────

const BACKEND_ERROR_MESSAGES: Record<string, string> = {
  INVALID_URL: 'Site URL must be https://<subdomain>.atlassian.net',
  INVALID_CLOUDID: 'Cloud ID must be a valid UUID.',
  INVALID_EMAIL: 'Email address is not valid.',
  INVALID_TOKEN: 'API token must not be empty.',
  AUTH_FAILED: 'Email or API token incorrect. Check your credentials and try again.',
  NETWORK_ERROR: 'Could not reach Atlassian. Check your connection and try again.',
};

// ── Component ─────────────────────────────────────────────────────────────────

export function ManualConnectForm({ onConnected, onCancel }: ManualConnectFormProps) {
  const [siteUrl, setSiteUrl] = useState('');
  const [cloudId, setCloudId] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');

  // Touched state — only show inline errors after the field has been visited
  const [touched, setTouched] = useState({
    siteUrl: false,
    cloudId: false,
    email: false,
    apiToken: false,
  });

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Per-field validation errors
  const errors = {
    siteUrl: validateSiteUrl(siteUrl),
    cloudId: validateCloudId(cloudId),
    email: validateEmail(email),
    apiToken: validateApiToken(apiToken),
  };

  const isValid = !errors.siteUrl && !errors.cloudId && !errors.email && !errors.apiToken;

  function blur(field: keyof typeof touched) {
    setTouched((t) => ({ ...t, [field]: true }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Mark all fields touched so validation is fully visible
    setTouched({ siteUrl: true, cloudId: true, email: true, apiToken: true });
    if (!isValid) return;

    setSubmitting(true);
    setFormError(null);

    try {
      await submitManualConnection({
        siteUrl: siteUrl.trim(),
        cloudId: cloudId.trim(),
        email: email.trim(),
        apiToken: apiToken.trim(),
      });

      // Build a minimal JiraSite from the form data + returned accountId
      const site: JiraSite = {
        id: cloudId.trim(),
        name: new URL(siteUrl.trim()).hostname.split('.')[0],
        url: siteUrl.trim(),
        scopes: [],
        avatarUrl: '',
      };

      onConnected(site);
    } catch (err) {
      if (err instanceof ManualAuthError) {
        setFormError(BACKEND_ERROR_MESSAGES[err.code] ?? err.message);
      } else if (err instanceof ApiError) {
        setFormError(BACKEND_ERROR_MESSAGES['NETWORK_ERROR']);
      } else {
        setFormError('An unexpected error occurred. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="mb-1 text-base font-semibold text-gray-900">Connect with API Token</h2>
      <p className="mb-4 text-sm text-gray-500">
        Enter your Jira Cloud site details and an Atlassian API token.{' '}
        <a
          href="https://id.atlassian.com/manage-profile/security/api-tokens"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 underline underline-offset-2 hover:text-blue-800"
        >
          How to generate an API token
        </a>
      </p>

      {/* Form-level error */}
      {formError && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {formError}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        {/* Site URL */}
        <Field
          id="manual-site-url"
          label="Site URL"
          type="url"
          value={siteUrl}
          placeholder="https://yoursite.atlassian.net"
          error={touched.siteUrl ? errors.siteUrl : null}
          onChange={(v) => { setSiteUrl(v); setFormError(null); }}
          onBlur={() => blur('siteUrl')}
          autoComplete="url"
        />

        {/* Cloud ID */}
        <Field
          id="manual-cloud-id"
          label="Cloud ID"
          type="text"
          value={cloudId}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          error={touched.cloudId ? errors.cloudId : null}
          onChange={(v) => { setCloudId(v); setFormError(null); }}
          onBlur={() => blur('cloudId')}
          autoComplete="off"
        />

        {/* Email */}
        <Field
          id="manual-email"
          label="Email"
          type="email"
          value={email}
          placeholder="you@example.com"
          error={touched.email ? errors.email : null}
          onChange={(v) => { setEmail(v); setFormError(null); }}
          onBlur={() => blur('email')}
          autoComplete="email"
        />

        {/* API Token */}
        <Field
          id="manual-api-token"
          label="API Token"
          type="password"
          value={apiToken}
          placeholder="Your Atlassian API token"
          error={touched.apiToken ? errors.apiToken : null}
          onChange={(v) => { setApiToken(v); setFormError(null); }}
          onBlur={() => blur('apiToken')}
          autoComplete="current-password"
        />

        {/* Actions */}
        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
          >
            {submitting && (
              <svg
                className="h-4 w-4 animate-spin"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
            )}
            {submitting ? 'Connecting…' : 'Connect'}
          </button>

          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="text-sm text-gray-500 hover:text-gray-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Field — reusable labelled input with inline error ─────────────────────────

interface FieldProps {
  id: string;
  label: string;
  type: string;
  value: string;
  placeholder: string;
  error: string | null;
  onChange: (value: string) => void;
  onBlur: () => void;
  autoComplete?: string;
}

function Field({ id, label, type, value, placeholder, error, onChange, onBlur, autoComplete }: FieldProps) {
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-gray-700">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? 'true' : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className={[
          'rounded-md border px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400',
          'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent',
          'transition-colors',
          error
            ? 'border-red-400 bg-red-50 focus:ring-red-400'
            : 'border-gray-300 bg-white',
        ].join(' ')}
      />
      {error && (
        <p id={errorId} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
