/**
 * BackupMetrics — in-process counters for the Jira backup pipeline.
 *
 * Counters:
 *   jira_backup_manifest_writes_total
 *     Incremented once per appendStageSection call in BackupPointManifestWriter.
 *
 *   jira_backup_pagination_terminations_total{reason}
 *     Incremented once per paginateAtlassian call at the point of termination.
 *     reason ∈ { empty_page, short_page, is_last, total_reached }
 *
 *   jira_backup_pages_fetched_total{endpoint}
 *     Incremented once per page fetched in paginateAtlassian.
 *
 * Usage:
 *   import { backupMetrics } from '../metrics/BackupMetrics';
 *   backupMetrics.incManifestWrites();
 *   backupMetrics.incPaginationTerminations('short_page');
 *   backupMetrics.incPagesFetched('/rest/api/3/project/search');
 *
 * Tests should call backupMetrics.reset() in beforeEach() for isolation.
 */

export type PaginationTerminationReason =
  | 'empty_page'
  | 'short_page'
  | 'is_last'
  | 'total_reached';

export class BackupMetrics {
  jira_backup_manifest_writes_total = 0;
  jira_backup_pagination_terminations_total: Record<string, number> = {};
  jira_backup_pages_fetched_total: Record<string, number> = {};

  incManifestWrites(): void {
    this.jira_backup_manifest_writes_total++;
  }

  incPaginationTerminations(reason: PaginationTerminationReason): void {
    this.jira_backup_pagination_terminations_total[reason] =
      (this.jira_backup_pagination_terminations_total[reason] ?? 0) + 1;
  }

  incPagesFetched(endpoint: string): void {
    this.jira_backup_pages_fetched_total[endpoint] =
      (this.jira_backup_pages_fetched_total[endpoint] ?? 0) + 1;
  }

  /** Resets all counters. Call in beforeEach() for test isolation. */
  reset(): void {
    this.jira_backup_manifest_writes_total = 0;
    this.jira_backup_pagination_terminations_total = {};
    this.jira_backup_pages_fetched_total = {};
  }
}

export const backupMetrics = new BackupMetrics();
