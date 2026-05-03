import { useState } from 'react';
import type { SdiScanResult, RegulationTag } from '../types';

// ── Regulation badge ──────────────────────────────────────────────────────────

const BADGE_STYLES: Record<RegulationTag, string> = {
  GDPR: 'bg-blue-100 text-blue-700 border border-blue-200',
  PCI_DSS: 'bg-amber-100 text-amber-800 border border-amber-300',
};

const BADGE_LABELS: Record<RegulationTag, string> = {
  GDPR: 'GDPR',
  PCI_DSS: 'PCI DSS',
};

function RegulationBadge({ tag }: { tag: RegulationTag }) {
  return (
    <span
      data-testid={`regulation-badge-${tag}`}
      className={[
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
        BADGE_STYLES[tag],
      ].join(' ')}
    >
      {BADGE_LABELS[tag]}
    </span>
  );
}

// ── Detector breakdown tooltip ────────────────────────────────────────────────

const DETECTOR_LABELS: Record<string, string> = {
  email: 'Email',
  api_key: 'API key',
  credit_card: 'Credit card',
  phone: 'Phone',
};

interface FindingIndicatorProps {
  sdiScan: SdiScanResult;
}

function FindingIndicator({ sdiScan }: FindingIndicatorProps) {
  const [tooltipVisible, setTooltipVisible] = useState(false);

  const breakdownEntries = Object.entries(sdiScan.detectorBreakdown).filter(
    ([, count]) => (count ?? 0) > 0
  );

  const breakdownText = breakdownEntries
    .map(([detector, count]) => `${DETECTOR_LABELS[detector] ?? detector}: ${count}`)
    .join(', ');

  return (
    <div className="relative inline-flex items-center">
      <button
        type="button"
        data-testid="finding-count-indicator"
        aria-label={`${sdiScan.findingCount} sensitive findings — ${breakdownText}`}
        className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-200 transition-colors cursor-default"
        onMouseEnter={() => setTooltipVisible(true)}
        onMouseLeave={() => setTooltipVisible(false)}
        onFocus={() => setTooltipVisible(true)}
        onBlur={() => setTooltipVisible(false)}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          fill="currentColor"
          className="h-3 w-3 text-gray-400"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm7 .5V5h2v3.5H7zM7 11v-2h2v2H7z"
            clipRule="evenodd"
          />
        </svg>
        {sdiScan.findingCount} sensitive finding{sdiScan.findingCount !== 1 ? 's' : ''}
      </button>

      {tooltipVisible && breakdownEntries.length > 0 && (
        <div
          role="tooltip"
          data-testid="finding-tooltip"
          className="absolute bottom-full left-0 mb-1.5 z-10 min-w-max rounded-md bg-gray-900 px-2.5 py-1.5 text-xs text-white shadow-lg"
        >
          {breakdownEntries.map(([detector, count]) => (
            <div key={detector}>
              {DETECTOR_LABELS[detector] ?? detector}: {count}
            </div>
          ))}
          {/* tooltip arrow */}
          <div className="absolute left-3 top-full h-0 w-0 border-x-4 border-x-transparent border-t-4 border-t-gray-900" />
        </div>
      )}
    </div>
  );
}

// ── ProtectedObjectCard ───────────────────────────────────────────────────────

export interface ProtectedObjectCardProps {
  /** Jira object type this card represents. */
  objectType: 'JiraIssue' | 'JiraProject' | 'JiraBoard' | 'JiraSprint';
  /** Display label shown as the card title. */
  label: string;
  /** Count of discovered objects from the most recent backup-point manifest. */
  count: number;
  /**
   * SDI scan result from manifest.sdiScan.
   * When absent or findingCount === 0, no SDI badges are rendered.
   */
  sdiScan?: SdiScanResult;
}

export function ProtectedObjectCard({
  objectType,
  label,
  count,
  sdiScan,
}: ProtectedObjectCardProps) {
  const hasFindings = sdiScan && sdiScan.findingCount > 0;
  const hasTags = hasFindings && sdiScan.regulationTags.length > 0;

  return (
    <div
      data-testid={`protected-object-card-${objectType}`}
      className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
    >
      {/* Header row: label + count */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-800">{label}</span>
        <span className="text-sm font-semibold text-gray-900 tabular-nums">{count.toLocaleString()}</span>
      </div>

      {/* SDI section — only when there are findings */}
      {hasFindings && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {/* Regulation tags */}
          {hasTags &&
            sdiScan.regulationTags.map((tag) => (
              <RegulationBadge key={tag} tag={tag} />
            ))}

          {/* Finding count indicator with tooltip */}
          <FindingIndicator sdiScan={sdiScan} />
        </div>
      )}
    </div>
  );
}
