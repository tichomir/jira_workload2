/** Mirrors AccessibleResource from the backend JiraOAuthHandler */
export interface JiraSite {
  id: string;       // cloudId
  name: string;     // siteName
  url: string;      // siteUrl
  scopes: string[];
  avatarUrl: string;
}

export type OAuthCallbackResult =
  | { status: 'connected'; site: JiraSite }       // single-site auto-select
  | { status: 'connected'; sites: JiraSite[] };   // multi-site picker

export type AuthMode = 'oauth' | 'api_token';

/** Persisted workload configuration for a connected site. */
export interface WorkloadConfig {
  scope: 'all' | 'selected';
  selectedKeys: string[];
}

/** Regulation tags activated by the SDI scanner. */
export type RegulationTag = 'GDPR' | 'PCI_DSS';

/**
 * SDI scan result attached to a backup-point manifest.
 * Populated by the post-processing pipeline after capture completes.
 */
export interface SdiScanResult {
  /** Regulation frameworks triggered by detected data (email/phone → GDPR, credit card → PCI_DSS). */
  regulationTags: RegulationTag[];
  /** Total number of sensitive findings across all scanned items. */
  findingCount: number;
  /** Per-detector finding counts (only detectors with ≥1 finding are present). */
  detectorBreakdown: Partial<Record<'email' | 'api_key' | 'credit_card' | 'phone', number>>;
}

export type ConnectionFlowState =
  | { phase: 'idle' }
  | { phase: 'pending' }                           // waiting for OAuth redirect return
  | { phase: 'site-selection'; sites: JiraSite[] }
  | { phase: 'onboarding'; site: JiraSite; authMode: AuthMode }  // scope config step
  | { phase: 'connected'; site: JiraSite; authMode: AuthMode }
  | { phase: 'manual-form' }                       // API Token manual connection form
  | { phase: 'error'; code: 401 | 403 | 'network' | 'unknown'; message: string };
