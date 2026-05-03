/**
 * ProjectDiscoveryService — paginated Project discovery via GET /rest/api/3/project/search.
 *
 * Responsibilities:
 *  - Discovers all projects on a connected Jira Cloud site (All scope) or
 *    a filtered subset (Selected scope) by project keys.
 *  - Enforces the pagination termination contract from the architecture doc.
 *  - Emits structured log lines per project and a reconciliation summary.
 *  - Detects JSM (service_desk) projects and emits out-of-scope notices.
 *  - Writes a ManifestEntry for every returned project (no silent omissions).
 */

import { JiraHttpClient } from '../http/JiraHttpClient';
import { paginateAtlassian } from '../pagination/paginateAtlassian';
import {
  ManifestEntry,
  PaginationResult,
  ProjectNode,
  JsmOutOfScopeNotice,
  ReconciliationReport,
  JSM_NOTICE_MESSAGE,
  JSM_NOTICE_PHASE2,
} from '../manifest/types';

// ── Jira API response shapes ──────────────────────────────────────────────────

interface JiraProjectApiItem {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
  isPrivate?: boolean;
  self: string;
  lead?: { accountId: string };
  style?: string;
  archived?: boolean;
}

interface ProjectSearchPage {
  values: JiraProjectApiItem[];
  total: number;
  isLast: boolean;
  maxResults: number;
  startAt: number;
}

// ── Configuration ─────────────────────────────────────────────────────────────

export interface ProjectDiscoveryConfig {
  /** 'all' — discover every project; 'selected' — filter by selectedKeys */
  scope: 'all' | 'selected';
  /** Required when scope === 'selected'. Discovery filters to these project keys. */
  selectedKeys?: string[];
  /** Page size for /rest/api/3/project/search. Default: 50 */
  maxResults?: number;
}

// ── Result ─────────────────────────────────────────────────────────────────────

export interface ProjectDiscoveryResult {
  /** All captured project context nodes (software + business) */
  projects: ProjectNode[];
  /** Manifest entries for every returned project including out_of_scope JSM entries */
  manifestEntries: ManifestEntry[];
  /** Reconciliation report for the project phase */
  reconciliation: ReconciliationReport;
  /** Present when one or more service_desk projects were detected */
  jsmNotice?: JsmOutOfScopeNotice;
  /** Count of service_desk projects detected (0 when none). For onboarding wizard out-of-scope notice. */
  jsmProjectsDetected: number;
  /** Pagination statistics */
  pagination: PaginationResult<ProjectNode>;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class ProjectDiscoveryService {
  constructor(
    private readonly httpClient: JiraHttpClient,
    private readonly backupPointId: string,
  ) {}

  /**
   * Runs paginated Project discovery.
   *
   * Pagination terminates when ANY of:
   *   - values.length === 0
   *   - isLast === true
   *   - values.length < maxResults
   *   - startAt >= total (defensive guard)
   */
  async discoverProjects(config: ProjectDiscoveryConfig): Promise<ProjectDiscoveryResult> {
    const maxResults = config.maxResults ?? 50;

    // ── Paginated fetch via shared utility ─────────────────────────────────
    const paginationResult = await paginateAtlassian<JiraProjectApiItem>(
      async (startAt, mr) => {
        const params = new URLSearchParams({
          startAt: String(startAt),
          maxResults: String(mr),
          ...(config.scope === 'selected' && config.selectedKeys?.length
            ? { keys: config.selectedKeys.join(',') }
            : {}),
        });
        return this.httpClient.get(
          `/rest/api/3/project/search?${params.toString()}`,
        ) as Promise<ProjectSearchPage>;
      },
      maxResults,
    );

    const allApiItems = paginationResult.items;
    const apiReportedTotal = paginationResult.apiReportedTotal;
    const pagesFetched = paginationResult.pagesFetched;

    // ── Map API items to ProjectNodes + ManifestEntries ────────────────────
    const capturedAt = new Date().toISOString();
    const projects: ProjectNode[] = [];
    const manifestEntries: ManifestEntry[] = [];
    const jsmProjectKeys: string[] = [];

    for (const item of allApiItems) {
      console.log(
        `[jira-discovery] project-discovered projectKey=${item.key} projectTypeKey=${item.projectTypeKey}`,
      );

      const node: ProjectNode = {
        id: item.id,
        key: item.key,
        name: item.name,
        projectTypeKey: item.projectTypeKey,
        archived: item.archived ?? false,
        leadAccountId: item.lead?.accountId,
        self: item.self,
        style: item.style as ProjectNode['style'],
      };

      if (item.projectTypeKey === 'service_desk') {
        // JSM — out of scope for Phase 1
        jsmProjectKeys.push(item.key);

        console.log(
          `[jira-discovery] jsm-out-of-scope projectKey=${item.key}`,
        );

        manifestEntries.push({
          id: item.id,
          key: item.key,
          phase: 'project',
          objectType: 'JiraProject',
          capturedAt,
          status: 'out_of_scope',
          skipReason: 'jsm_out_of_scope',
          outOfScope: true,
          reason: 'JSM Phase 1 deferred',
          backupPointId: this.backupPointId,
          data: node,
        });
        // JSM projects are NOT added to the projects array (excluded from backup pipeline)
      } else {
        projects.push(node);

        manifestEntries.push({
          id: item.id,
          key: item.key,
          phase: 'project',
          objectType: 'JiraProject',
          capturedAt,
          status: 'success',
          backupPointId: this.backupPointId,
          data: node,
        });
      }
    }

    // ── Reconciliation ─────────────────────────────────────────────────────
    const totalFetched = allApiItems.length;
    const reconciled =
      apiReportedTotal === null ? true : totalFetched === apiReportedTotal;

    const pagination: PaginationResult<ProjectNode> = {
      items: projects,
      totalFetched,
      apiReportedTotal,
      pagesFetched,
      reconciled,
      gap: reconciled ? undefined : (apiReportedTotal! - totalFetched),
    };

    const reconciliation: ReconciliationReport = {
      objectType: 'JiraProject',
      apiReportedTotal,
      totalFetched,
      manifestEntryCount: manifestEntries.length,
      reconciled: totalFetched === manifestEntries.length,
      gap:
        totalFetched !== manifestEntries.length
          ? totalFetched - manifestEntries.length
          : undefined,
    };

    console.log(
      `[jira-discovery] discovery-complete` +
        ` apiReportedTotal=${apiReportedTotal ?? 'unknown'}` +
        ` fetchedCount=${totalFetched}` +
        ` inScope=${projects.length}` +
        ` outOfScope=${jsmProjectKeys.length}` +
        ` reconciled=${reconciliation.reconciled}`,
    );

    // ── JSM notice ─────────────────────────────────────────────────────────
    let jsmNotice: JsmOutOfScopeNotice | undefined;
    if (jsmProjectKeys.length > 0) {
      jsmNotice = {
        type: 'jsm_out_of_scope',
        projectCount: jsmProjectKeys.length,
        projectKeys: jsmProjectKeys,
        message: JSM_NOTICE_MESSAGE,
        phase2Note: JSM_NOTICE_PHASE2,
      };
    }

    return {
      projects,
      manifestEntries,
      reconciliation,
      jsmNotice,
      jsmProjectsDetected: jsmProjectKeys.length,
      pagination,
    };
  }
}
