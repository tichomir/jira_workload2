// Full scope set from T2 §4.2.2 — all scopes are required, none are optional.
// offline_access is mandatory to obtain a refresh_token for unattended backup jobs.
export const JIRA_OAUTH_SCOPES = [
  'read:jira-user',
  'read:jira-work',
  'write:jira-work',
  'manage:jira-project',
  'manage:jira-configuration',
  'read:me',
  'offline_access',
] as const;
