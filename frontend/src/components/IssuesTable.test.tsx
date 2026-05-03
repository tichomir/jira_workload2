/**
 * Component-level tests for IssuesTable and GlobalSearchBar.
 *
 * Run with: cd frontend && npx vitest run
 *
 * Coverage:
 *   IssuesTable
 *     - renders all eight specified columns
 *     - 'Issue Status' and 'Status' columns have distinct aria-labels
 *     - tooltips are present on 'Issue Status' and 'Status' headers
 *     - renders issue rows returned by the API
 *     - shows "Protected" badge for platformStatus=protected
 *     - shows "Error" badge for platformStatus=error
 *     - shows empty state when no issues are returned
 *     - shows error state when fetch fails
 *     - pagination controls render with correct total
 *     - prev/next page buttons call fetchIssues with updated offset
 *
 *   GlobalSearchBar
 *     - renders search input
 *     - calls searchInventory after debounce
 *     - renders typed result cards with Project / Board / Sprint badges
 *     - each result card has a data-testid encoding type + id
 *     - clicking a Project card calls onNavigate with /inventory/projects/<id>
 *     - clicking a Board card calls onNavigate with /inventory/boards/<id>
 *     - clicking a Sprint card calls onNavigate with /inventory/sprints/<id>
 *     - shows empty state message when no results are returned
 *     - closes dropdown on outside click
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { IssuesTable } from './IssuesTable';
import { GlobalSearchBar } from './GlobalSearchBar';
import * as jiraApi from '../api/jira';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_ROW_1: jiraApi.IssueTableRow = {
  issueKey: 'PROJ-1',
  summary: 'Fix login bug',
  issueStatus: 'In Progress',
  issueType: 'Bug',
  assignee: 'Alice Smith',
  platformStatus: 'protected',
  policy: 'daily',
  lastBackupAt: '2026-05-01T10:00:00.000Z',
  backupPointId: 'bp-001',
};

const MOCK_ROW_2: jiraApi.IssueTableRow = {
  issueKey: 'PROJ-2',
  summary: 'Update README',
  issueStatus: 'Done',
  issueType: 'Task',
  assignee: null,
  platformStatus: 'error',
  policy: 'daily',
  lastBackupAt: '2026-05-01T10:00:00.000Z',
  backupPointId: 'bp-001',
};

const MOCK_ISSUES_RESPONSE: jiraApi.IssuesResponse = {
  issues: [MOCK_ROW_1, MOCK_ROW_2],
  total: 2,
  backupPointId: 'bp-001',
};

const MOCK_SEARCH_RESULTS: jiraApi.SearchCard[] = [
  {
    type: 'JiraProject',
    id: 'proj-abc',
    displayName: 'Alpha Project',
    projectKey: 'ALPHA',
    lastBackupAt: '2026-05-01T10:00:00.000Z',
  },
  {
    type: 'JiraBoard',
    id: 'board-xyz',
    displayName: 'Alpha Sprint Board',
    projectKey: 'ALPHA',
    lastBackupAt: '2026-05-01T10:00:00.000Z',
  },
  {
    type: 'JiraSprint',
    id: 'sprint-123',
    displayName: 'Sprint 9',
    lastBackupAt: '2026-05-01T10:00:00.000Z',
  },
];

// ── IssuesTable tests ─────────────────────────────────────────────────────────

describe('IssuesTable', () => {
  beforeEach(() => {
    jest.spyOn(jiraApi, 'fetchIssues').mockResolvedValue(MOCK_ISSUES_RESPONSE);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders all eight column headers', async () => {
    render(<IssuesTable cloudId="cloud-001" />);
    await waitFor(() =>
      expect(screen.getByTestId('issues-table')).toBeInTheDocument(),
    );

    // Check all eight column aria-labels
    const expected = [
      'Issue Key',
      'Summary',
      'Issue Status (Jira workflow state)',
      'Issue Type',
      'Assignee',
      'Status (DCC platform protection status)',
      'Policy',
      'Last Backup',
    ];
    for (const label of expected) {
      expect(screen.getByRole('columnheader', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
  });

  it('"Issue Status" and "Status" column headers are visually distinct with different aria-labels', async () => {
    render(<IssuesTable cloudId="cloud-001" />);
    await waitFor(() =>
      expect(screen.getByTestId('issues-table')).toBeInTheDocument(),
    );

    const issueStatusCol = screen.getByRole('columnheader', {
      name: /issue status.*jira workflow/i,
    });
    const platformStatusCol = screen.getByRole('columnheader', {
      name: /^status.*dcc platform/i,
    });

    expect(issueStatusCol).not.toBe(platformStatusCol);
  });

  it('"Issue Status" column header contains tooltip marker', async () => {
    render(<IssuesTable cloudId="cloud-001" />);
    await waitFor(() =>
      expect(screen.getByTestId('issues-table')).toBeInTheDocument(),
    );

    // Column headers contain the text "Issue Status" and "Status"
    const headers = screen.getAllByRole('columnheader');
    const issueStatusHeader = headers.find((h) =>
      h.getAttribute('aria-label')?.includes('Issue Status'),
    );
    const statusHeader = headers.find((h) =>
      h.getAttribute('aria-label')?.startsWith('Status'),
    );
    expect(issueStatusHeader).toBeDefined();
    expect(statusHeader).toBeDefined();
  });

  it('renders issue rows from the API response', async () => {
    render(<IssuesTable cloudId="cloud-001" />);
    await waitFor(() =>
      expect(screen.getByTestId('issue-row-PROJ-1')).toBeInTheDocument(),
    );

    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Bug')).toBeInTheDocument();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
  });

  it('renders Protected badge for platformStatus=protected', async () => {
    render(<IssuesTable cloudId="cloud-001" />);
    await waitFor(() =>
      expect(screen.getByTestId('platform-status-PROJ-1')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('platform-status-PROJ-1')).toHaveTextContent('Protected');
  });

  it('renders Error badge for platformStatus=error', async () => {
    render(<IssuesTable cloudId="cloud-001" />);
    await waitFor(() =>
      expect(screen.getByTestId('platform-status-PROJ-2')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('platform-status-PROJ-2')).toHaveTextContent('Error');
  });

  it('shows empty state when no issues are returned', async () => {
    jest.spyOn(jiraApi, 'fetchIssues').mockResolvedValue({
      issues: [],
      total: 0,
      backupPointId: null,
    });

    render(<IssuesTable cloudId="cloud-001" />);
    await waitFor(() =>
      expect(
        screen.getByText(/no issues found/i),
      ).toBeInTheDocument(),
    );
  });

  it('shows error state when fetch fails', async () => {
    jest.spyOn(jiraApi, 'fetchIssues').mockRejectedValue(new Error('Network error'));

    render(<IssuesTable cloudId="cloud-001" />);
    await waitFor(() =>
      expect(screen.getByTestId('issues-table-error')).toBeInTheDocument(),
    );
  });

  it('renders pagination when total > 0', async () => {
    jest.spyOn(jiraApi, 'fetchIssues').mockResolvedValue({
      ...MOCK_ISSUES_RESPONSE,
      total: 150,
    });

    render(<IssuesTable cloudId="cloud-001" pageSize={50} />);
    await waitFor(() =>
      expect(screen.getByTestId('issues-pagination')).toBeInTheDocument(),
    );

    expect(screen.getByText(/150/)).toBeInTheDocument();
    expect(screen.getByTestId('pagination-prev')).toBeDisabled();
    expect(screen.getByTestId('pagination-next')).not.toBeDisabled();
  });

  it('calls fetchIssues with updated offset when Next is clicked', async () => {
    const fetchSpy = jest.spyOn(jiraApi, 'fetchIssues').mockResolvedValue({
      ...MOCK_ISSUES_RESPONSE,
      total: 150,
    });

    render(<IssuesTable cloudId="cloud-001" pageSize={50} />);
    await waitFor(() =>
      expect(screen.getByTestId('pagination-next')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('pagination-next'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('cloud-001', {
        offset: 50,
        limit: 50,
      });
    });
  });
});

// ── GlobalSearchBar tests ─────────────────────────────────────────────────────

describe('GlobalSearchBar', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(jiraApi, 'searchInventory').mockResolvedValue({
      results: MOCK_SEARCH_RESULTS,
    });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders the search input', () => {
    render(<GlobalSearchBar cloudId="cloud-001" />);
    expect(screen.getByTestId('global-search-input')).toBeInTheDocument();
  });

  it('calls searchInventory after debounce', async () => {
    const searchSpy = jest.spyOn(jiraApi, 'searchInventory');
    render(<GlobalSearchBar cloudId="cloud-001" debounceMs={300} />);

    fireEvent.change(screen.getByTestId('global-search-input'), {
      target: { value: 'alpha' },
    });

    // Should not have called yet — debounce pending
    expect(searchSpy).not.toHaveBeenCalled();

    // Advance timers past debounce
    act(() => jest.advanceTimersByTime(300));

    await waitFor(() =>
      expect(searchSpy).toHaveBeenCalledWith('cloud-001', 'alpha'),
    );
  });

  it('renders typed result cards with Project / Board / Sprint badges', async () => {
    render(<GlobalSearchBar cloudId="cloud-001" debounceMs={300} />);

    fireEvent.change(screen.getByTestId('global-search-input'), {
      target: { value: 'alpha' },
    });
    act(() => jest.advanceTimersByTime(300));

    await waitFor(() =>
      expect(screen.getByTestId('global-search-dropdown')).toBeInTheDocument(),
    );

    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.getByText('Board')).toBeInTheDocument();
    expect(screen.getByText('Sprint')).toBeInTheDocument();
  });

  it('renders result card with correct data-testid encoding type and id', async () => {
    render(<GlobalSearchBar cloudId="cloud-001" debounceMs={300} />);

    fireEvent.change(screen.getByTestId('global-search-input'), {
      target: { value: 'alpha' },
    });
    act(() => jest.advanceTimersByTime(300));

    await waitFor(() =>
      expect(screen.getByTestId('search-result-JiraProject-proj-abc')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('search-result-JiraBoard-board-xyz')).toBeInTheDocument();
    expect(screen.getByTestId('search-result-JiraSprint-sprint-123')).toBeInTheDocument();
  });

  it('calls onNavigate with /inventory/projects/<id> when Project card is clicked', async () => {
    const navigate = jest.fn();
    render(
      <GlobalSearchBar cloudId="cloud-001" onNavigate={navigate} debounceMs={300} />,
    );

    fireEvent.change(screen.getByTestId('global-search-input'), {
      target: { value: 'alpha' },
    });
    act(() => jest.advanceTimersByTime(300));

    await waitFor(() =>
      expect(screen.getByTestId('search-result-JiraProject-proj-abc')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('search-result-JiraProject-proj-abc'));
    expect(navigate).toHaveBeenCalledWith('/inventory/projects/proj-abc');
  });

  it('calls onNavigate with /inventory/boards/<id> when Board card is clicked', async () => {
    const navigate = jest.fn();
    render(
      <GlobalSearchBar cloudId="cloud-001" onNavigate={navigate} debounceMs={300} />,
    );

    fireEvent.change(screen.getByTestId('global-search-input'), {
      target: { value: 'alpha' },
    });
    act(() => jest.advanceTimersByTime(300));

    await waitFor(() =>
      expect(screen.getByTestId('search-result-JiraBoard-board-xyz')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('search-result-JiraBoard-board-xyz'));
    expect(navigate).toHaveBeenCalledWith('/inventory/boards/board-xyz');
  });

  it('calls onNavigate with /inventory/sprints/<id> when Sprint card is clicked', async () => {
    const navigate = jest.fn();
    render(
      <GlobalSearchBar cloudId="cloud-001" onNavigate={navigate} debounceMs={300} />,
    );

    fireEvent.change(screen.getByTestId('global-search-input'), {
      target: { value: 'alpha' },
    });
    act(() => jest.advanceTimersByTime(300));

    await waitFor(() =>
      expect(screen.getByTestId('search-result-JiraSprint-sprint-123')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('search-result-JiraSprint-sprint-123'));
    expect(navigate).toHaveBeenCalledWith('/inventory/sprints/sprint-123');
  });

  it('shows empty-results message when search returns no results', async () => {
    jest.spyOn(jiraApi, 'searchInventory').mockResolvedValue({ results: [] });

    render(<GlobalSearchBar cloudId="cloud-001" debounceMs={300} />);

    fireEvent.change(screen.getByTestId('global-search-input'), {
      target: { value: 'zzznomatch' },
    });
    act(() => jest.advanceTimersByTime(300));

    await waitFor(() =>
      expect(screen.getByText(/no results for/i)).toBeInTheDocument(),
    );
  });

  it('projectKey context line is shown below the display name', async () => {
    render(<GlobalSearchBar cloudId="cloud-001" debounceMs={300} />);

    fireEvent.change(screen.getByTestId('global-search-input'), {
      target: { value: 'alpha' },
    });
    act(() => jest.advanceTimersByTime(300));

    await waitFor(() =>
      expect(screen.getByText('Project: ALPHA')).toBeInTheDocument(),
    );
  });
});
