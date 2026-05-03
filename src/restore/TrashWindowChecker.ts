/**
 * TrashWindowChecker — probes the Jira REST API to detect whether a project
 * is currently in Atlassian's 60-day trash window.
 *
 * Detection method (per docs/restore-architecture.md §5):
 *   GET /rest/api/3/project/{projectIdOrKey}
 *   → 404     : project not found (likely in trash or permanently deleted)
 *   → 200 with archived: true : project is archived/trashed
 *
 * Uses the canonical authenticated HTTP client only (no raw fetch).
 *
 * Structured log: '[jira-restore] job.blocked.trash-window projectKey=...'
 */

import { JiraHttpClient } from '../http/JiraHttpClient';

export interface TrashCheckResult {
  projectKey: string;
  inTrash: boolean;
  /** ISO 8601 timestamp when the project was deleted, if available from the API. */
  deletedAt: string | null;
  /** ISO 8601 timestamp when the trash window expires (deletedAt + 60 days), if known. */
  expiresAt: string | null;
}

export class TrashWindowChecker {
  constructor(private readonly client: JiraHttpClient) {}

  /**
   * Checks whether any of the given project keys are currently in the trash.
   * Returns one result per key.
   */
  async checkProjects(projectKeys: string[]): Promise<TrashCheckResult[]> {
    const results: TrashCheckResult[] = [];

    for (const projectKey of projectKeys) {
      const inTrash = await this.isInTrash(projectKey);
      // deletedAt / expiresAt are not exposed by GET /rest/api/3/project/{key};
      // they would be populated from the backup manifest by the caller if available.
      results.push({ projectKey, inTrash, deletedAt: null, expiresAt: null });
    }

    return results;
  }

  /**
   * Returns true if the project is in the trash window (archived or 404).
   */
  async isInTrash(projectKey: string): Promise<boolean> {
    try {
      const project = await this.client.get(
        `/rest/api/3/project/${encodeURIComponent(projectKey)}`,
      ) as Record<string, unknown>;

      // Atlassian sets archived=true for projects in the trash window
      if (project.archived === true) {
        return true;
      }

      return false;
    } catch (err: unknown) {
      // A 404 response means the project is not accessible — treat as trash/deleted
      if (
        err instanceof Error &&
        err.message.includes('404')
      ) {
        return true;
      }

      // Any other error (network, auth): re-throw so the caller can handle it
      throw err;
    }
  }
}
