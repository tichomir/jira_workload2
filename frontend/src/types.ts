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

export type ConnectionFlowState =
  | { phase: 'idle' }
  | { phase: 'pending' }                           // waiting for OAuth redirect return
  | { phase: 'site-selection'; sites: JiraSite[] }
  | { phase: 'connected'; site: JiraSite }
  | { phase: 'error'; code: 401 | 403 | 'network' | 'unknown'; message: string };
