/**
 * Shared pagination utility for all Atlassian REST API list endpoints.
 *
 * RULE: Do NOT write ad-hoc pagination loops anywhere in this codebase.
 * Every paginated API call MUST use paginateAtlassian. Adding a new paginated
 * endpoint? Add a fetchPage callback and call paginateAtlassian — never a new
 * while(true) loop.
 *
 * Structured log lines emitted:
 *   [jira-backup] page_fetched endpoint=<url> pageIndex=<i> itemsInPage=<n>
 *   [jira-backup] pagination_terminated endpoint=<url> reason=<reason> pageCount=<n> totalItems=<n>
 *
 * Metrics incremented (see BackupMetrics):
 *   jira_backup_pages_fetched_total{endpoint}
 *   jira_backup_pagination_terminations_total{reason}
 *
 * See: docs/architecture/context-capture-pipeline.md §3
 */

import { backupMetrics, PaginationTerminationReason } from '../metrics/BackupMetrics';

/**
 * Shape of a single page returned by an Atlassian list endpoint.
 * Different endpoints use different keys for their item arrays.
 */
export interface AtlassianPage<T> {
  /** Most Jira REST v3 list endpoints return items under 'values' */
  values?: T[];
  /** POST /rest/api/3/search/jql returns items under 'issues' */
  issues?: T[];
  /** Total count reported by the API (absent on flat-array endpoints) */
  total?: number;
  /** Agile API: explicitly signals the last page */
  isLast?: boolean;
  maxResults?: number;
  startAt?: number;
}

/**
 * Callback invoked once per page. startAt and maxResults are managed by
 * paginateAtlassian; the caller only provides the path-specific fetch logic.
 */
export type FetchPageFn<T> = (
  startAt: number,
  maxResults: number,
) => Promise<AtlassianPage<T>>;

/** Options for paginateAtlassian. All fields are optional for backward compat. */
export interface PaginateOptions {
  /**
   * Human-readable endpoint label used in structured log lines and metrics.
   * E.g. '/rest/api/3/project/search' or 'POST /rest/api/3/search/jql'.
   * Defaults to 'unknown' when omitted.
   */
  endpoint?: string;
}

export interface AtlassianPaginationResult<T> {
  /** All items collected across every page */
  items: T[];
  /** items.length */
  totalFetched: number;
  /** null when the endpoint does not return a total field */
  apiReportedTotal: number | null;
  /** Number of HTTP calls made */
  pagesFetched: number;
  /**
   * True when totalFetched === apiReportedTotal (or apiReportedTotal is null).
   * False signals a RECONCILIATION_GAP.
   */
  reconciled: boolean;
  /** Present when reconciled === false: apiReportedTotal - totalFetched */
  gap?: number;
}

/**
 * Paginates through an Atlassian list endpoint, collecting all results.
 *
 * Termination conditions — ANY of these stops pagination:
 *   1. results.length === 0         (empty page)
 *   2. isLast === true              (Agile API explicit end signal)
 *   3. results.length < maxResults  (partial page = last page)
 *   4. items.length >= apiReportedTotal
 *
 * For non-paginated flat-array endpoints (e.g. GET /rest/api/3/issuetype,
 * GET /rest/api/3/field), wrap with a single-page adapter that sets
 * isLast: true and total: items.length to force single-pass reconciliation.
 *
 * @param fetchPage  Callback invoked per page with (startAt, maxResults).
 * @param maxResults Page size passed to every fetchPage call. Default 50.
 * @param options    Optional: endpoint label for structured logging and metrics.
 */
export async function paginateAtlassian<T>(
  fetchPage: FetchPageFn<T>,
  maxResults = 50,
  options: PaginateOptions = {},
): Promise<AtlassianPaginationResult<T>> {
  const endpoint = options.endpoint ?? 'unknown';
  const items: T[] = [];
  let startAt = 0;
  let apiReportedTotal: number | null = null;
  let pagesFetched = 0;

  while (true) {
    const page = await fetchPage(startAt, maxResults);
    pagesFetched++;

    const pageItems: T[] = page.values ?? page.issues ?? [];
    items.push(...pageItems);

    // Capture total from first page only (if provided by this endpoint)
    if (apiReportedTotal === null && page.total !== undefined) {
      apiReportedTotal = page.total;
    }

    // Structured log: page fetched
    console.log(
      `[jira-backup] page_fetched endpoint=${endpoint} pageIndex=${pagesFetched - 1} itemsInPage=${pageItems.length}`,
    );
    backupMetrics.incPagesFetched(endpoint);

    // Determine termination reason (checked in priority order)
    let terminationReason: PaginationTerminationReason | null = null;
    if (pageItems.length === 0) {
      terminationReason = 'empty_page';
    } else if (page.isLast === true) {
      terminationReason = 'is_last';
    } else if (pageItems.length < maxResults) {
      terminationReason = 'short_page';
    } else if (apiReportedTotal !== null && items.length >= apiReportedTotal) {
      terminationReason = 'total_reached';
    }

    if (terminationReason !== null) {
      // Structured log: pagination terminated
      console.log(
        `[jira-backup] pagination_terminated endpoint=${endpoint} reason=${terminationReason} ` +
          `pageCount=${pagesFetched} totalItems=${items.length}`,
      );
      backupMetrics.incPaginationTerminations(terminationReason);
      break;
    }

    startAt += pageItems.length;
  }

  const totalFetched = items.length;
  const reconciled =
    apiReportedTotal === null ? true : totalFetched === apiReportedTotal;

  return {
    items,
    totalFetched,
    apiReportedTotal,
    pagesFetched,
    reconciled,
    gap: reconciled ? undefined : apiReportedTotal! - totalFetched,
  };
}
