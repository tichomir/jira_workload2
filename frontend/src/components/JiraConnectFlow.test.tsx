/**
 * Unit tests for JiraConnectFlow and child components.
 *
 * NOTE: These tests require a DOM environment (jsdom) and React Testing Library.
 * Run with: cd frontend && npx vitest run
 *
 * Flow coverage:
 *   1. Idle state — ConnectButton is rendered
 *   2. Single-site auto-select via ?oauth_result param — skips SitePicker, shows banner
 *   3. Multi-site — SitePicker rendered with all sites; confirm POSTs /select
 *   4. 401/403 error from backend — ErrorBanner renders with Reconnect button
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { JiraConnectFlow } from './JiraConnectFlow';
import type { JiraSite } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function encodeOAuthResult(payload: object): string {
  return btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const SITE_A: JiraSite = {
  id: 'cloud-aaa',
  name: 'Acme Corp',
  url: 'https://acme.atlassian.net',
  scopes: [],
  avatarUrl: '',
};

const SITE_B: JiraSite = {
  id: 'cloud-bbb',
  name: 'Beta Inc',
  url: 'https://beta.atlassian.net',
  scopes: [],
  avatarUrl: '',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('JiraConnectFlow', () => {
  beforeEach(() => {
    // Reset URL
    window.history.replaceState({}, '', '/');
    // Reset fetch mock
    global.fetch = jest.fn();
  });

  it('renders Connect button in idle state', () => {
    render(<JiraConnectFlow />);
    expect(screen.getByRole('button', { name: /connect jira cloud/i })).toBeInTheDocument();
  });

  it('auto-selects single site and shows transient banner', async () => {
    const encoded = encodeOAuthResult({ status: 'connected', site: SITE_A });
    window.history.replaceState({}, '', `/?oauth_result=${encoded}`);

    render(<JiraConnectFlow />);

    // Banner should appear
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Connected to Acme Corp');
    });

    // SitePicker should NOT be rendered
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    // ConnectedCard should be present
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });

  it('renders SitePicker for multi-site response', async () => {
    const encoded = encodeOAuthResult({ status: 'connected', sites: [SITE_A, SITE_B] });
    window.history.replaceState({}, '', `/?oauth_result=${encoded}`);

    render(<JiraConnectFlow />);

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Beta Inc')).toBeInTheDocument();
  });

  it('POSTs to /api/jira/connections/select on site confirm', async () => {
    const encoded = encodeOAuthResult({ status: 'connected', sites: [SITE_A, SITE_B] });
    window.history.replaceState({}, '', `/?oauth_result=${encoded}`);

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'connected', site: SITE_A }),
    });

    render(<JiraConnectFlow />);

    await waitFor(() => screen.getByRole('listbox'));

    // Select Beta Inc
    fireEvent.click(screen.getByText('Beta Inc'));
    fireEvent.click(screen.getByRole('button', { name: /connect to selected/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/jira/connections/select',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ cloudId: 'cloud-bbb' }),
        })
      );
    });
  });

  it('shows ErrorBanner with Reconnect button on oauth_error param', async () => {
    window.history.replaceState({}, '', '/?oauth_error=authorization_denied');

    render(<JiraConnectFlow />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /reconnect/i })).toBeInTheDocument();
  });
});
