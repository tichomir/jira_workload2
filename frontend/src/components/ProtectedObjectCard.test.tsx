/**
 * Tests for ProtectedObjectCard — SDI badge and finding-count rendering.
 *
 * Run with: cd frontend && npx vitest run
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { ProtectedObjectCard } from './ProtectedObjectCard';
import type { SdiScanResult } from '../types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SDI_BOTH_TAGS: SdiScanResult = {
  regulationTags: ['GDPR', 'PCI_DSS'],
  findingCount: 3,
  detectorBreakdown: { email: 2, credit_card: 1 },
};

const SDI_GDPR_ONLY: SdiScanResult = {
  regulationTags: ['GDPR'],
  findingCount: 2,
  detectorBreakdown: { email: 2 },
};

const SDI_ZERO_FINDINGS: SdiScanResult = {
  regulationTags: [],
  findingCount: 0,
  detectorBreakdown: {},
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ProtectedObjectCard', () => {
  it('renders both GDPR and PCI_DSS badges when both tags are present', () => {
    render(
      <ProtectedObjectCard
        objectType="JiraIssue"
        label="Issues"
        count={42}
        sdiScan={SDI_BOTH_TAGS}
      />
    );

    expect(screen.getByTestId('regulation-badge-GDPR')).toBeInTheDocument();
    expect(screen.getByTestId('regulation-badge-PCI_DSS')).toBeInTheDocument();
  });

  it('renders the finding-count indicator with correct count', () => {
    render(
      <ProtectedObjectCard
        objectType="JiraIssue"
        label="Issues"
        count={42}
        sdiScan={SDI_BOTH_TAGS}
      />
    );

    const indicator = screen.getByTestId('finding-count-indicator');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent('3 sensitive findings');
  });

  it('indicator aria-label includes detector breakdown', () => {
    render(
      <ProtectedObjectCard
        objectType="JiraIssue"
        label="Issues"
        count={42}
        sdiScan={SDI_BOTH_TAGS}
      />
    );

    const indicator = screen.getByTestId('finding-count-indicator');
    expect(indicator).toHaveAttribute(
      'aria-label',
      expect.stringContaining('email: 2')
    );
    expect(indicator).toHaveAttribute(
      'aria-label',
      expect.stringContaining('credit_card: 1')
    );
  });

  it('renders only GDPR badge when only GDPR tag is present', () => {
    render(
      <ProtectedObjectCard
        objectType="JiraProject"
        label="Projects"
        count={5}
        sdiScan={SDI_GDPR_ONLY}
      />
    );

    expect(screen.getByTestId('regulation-badge-GDPR')).toBeInTheDocument();
    expect(screen.queryByTestId('regulation-badge-PCI_DSS')).not.toBeInTheDocument();
  });

  it('renders no SDI badges when sdiScan is absent', () => {
    render(
      <ProtectedObjectCard
        objectType="JiraBoard"
        label="Boards"
        count={3}
      />
    );

    expect(screen.queryByTestId('regulation-badge-GDPR')).not.toBeInTheDocument();
    expect(screen.queryByTestId('regulation-badge-PCI_DSS')).not.toBeInTheDocument();
    expect(screen.queryByTestId('finding-count-indicator')).not.toBeInTheDocument();
  });

  it('renders no SDI badges when findingCount is 0', () => {
    render(
      <ProtectedObjectCard
        objectType="JiraSprint"
        label="Sprints"
        count={8}
        sdiScan={SDI_ZERO_FINDINGS}
      />
    );

    expect(screen.queryByTestId('regulation-badge-GDPR')).not.toBeInTheDocument();
    expect(screen.queryByTestId('regulation-badge-PCI_DSS')).not.toBeInTheDocument();
    expect(screen.queryByTestId('finding-count-indicator')).not.toBeInTheDocument();
  });

  it('renders label and count', () => {
    render(
      <ProtectedObjectCard
        objectType="JiraIssue"
        label="Issues"
        count={1234}
        sdiScan={SDI_BOTH_TAGS}
      />
    );

    expect(screen.getByText('Issues')).toBeInTheDocument();
    expect(screen.getByText('1,234')).toBeInTheDocument();
  });
});
