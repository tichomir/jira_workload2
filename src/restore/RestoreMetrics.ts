/**
 * RestoreMetrics — in-process counters for the Jira restore pipeline.
 *
 * Counters:
 *   jira_restore_manifest_entities_total{phase}
 *     Incremented by the count of entities loaded from the backup manifest
 *     for each restore phase (project, workflow, custom_field, board, sprint,
 *     issue_body, post_issue).
 *
 *   jira_restore_pagination_terminations_total{cause}
 *     Incremented once at each paginated-read termination point during restore.
 *     cause ∈ { empty, short_page }
 *
 * Structured log helpers:
 *   logManifestLoaded(phase, count)
 *     Emits: [jira-restore] manifest-loaded phase={name} count={n}
 *
 *   logPaginationTerminated(cause, fetched)
 *     Emits: [jira-restore] pagination-terminated cause={empty|short_page} fetched={n}
 *
 * Usage:
 *   import { restoreMetrics } from './RestoreMetrics';
 *   restoreMetrics.logManifestLoaded('issue_body', 120);
 *   restoreMetrics.logPaginationTerminated('empty', 0);
 *
 * Tests should call restoreMetrics.reset() in beforeEach() for counter isolation.
 *
 * No new dependencies — uses only Node.js built-ins (console.log).
 */

export type RestorePaginationCause = 'empty' | 'short_page';

export class RestoreMetrics {
  /** Counter: number of manifest entities loaded per restore phase. */
  jira_restore_manifest_entities_total: Record<string, number> = {};

  /** Counter: number of paginated-read terminations per cause. */
  jira_restore_pagination_terminations_total: Record<string, number> = {};

  /**
   * Emits a structured log line and increments the manifest-entities counter.
   *
   * Call once per restore phase, with count = number of entities loaded
   * from the backup manifest for that phase.
   */
  logManifestLoaded(phase: string, count: number): void {
    console.log(`[jira-restore] manifest-loaded phase=${phase} count=${count}`);
    this.jira_restore_manifest_entities_total[phase] =
      (this.jira_restore_manifest_entities_total[phase] ?? 0) + count;
  }

  /**
   * Emits a structured log line and increments the pagination-terminations counter.
   *
   * Call at the point where a paginated read loop terminates, providing the
   * cause ('empty' = page returned 0 items, 'short_page' = page was shorter
   * than maxResults) and the total number of items fetched in that call.
   */
  logPaginationTerminated(cause: RestorePaginationCause, fetched: number): void {
    console.log(
      `[jira-restore] pagination-terminated cause=${cause} fetched=${fetched}`,
    );
    this.jira_restore_pagination_terminations_total[cause] =
      (this.jira_restore_pagination_terminations_total[cause] ?? 0) + 1;
  }

  /** Resets all counters. Call in beforeEach() for test isolation. */
  reset(): void {
    this.jira_restore_manifest_entities_total = {};
    this.jira_restore_pagination_terminations_total = {};
  }
}

export const restoreMetrics = new RestoreMetrics();
