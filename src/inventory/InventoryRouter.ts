/**
 * InventoryRouter — HTTP endpoints for the Protected Object Inventory UI.
 *
 * Endpoints (mount this router at /api):
 *
 *   GET /inventory/summary
 *     Returns per-type object counts (JiraIssue, JiraProject, JiraBoard, JiraSprint)
 *     sourced from the latest backup point manifest for the caller's cloud ID.
 *     Response: { backupPointId, counts: { JiraIssue, JiraProject, JiraBoard, JiraSprint } }
 *
 *   GET /inventory/issues[?offset=0&limit=50]
 *     Returns a paginated list of Issues table rows from the latest backup point.
 *     Each row: { issueKey, summary, issueStatus, issueType, assignee,
 *                 platformStatus, policy, lastBackupAt, backupPointId }
 *     When backupDir is configured, rich fields (summary, issueStatus, etc.) are
 *     loaded from the persisted issue JSON files. Otherwise they return null.
 *     Response: { issues, total, backupPointId }
 *
 *   GET /search?q=<term>
 *     Case-insensitive full-text search across projectKey, projectName, boardName,
 *     sprintName, and issueKey. Returns typed Protected Object cards.
 *     Response: { results: Array<{ type, id, displayName, projectKey?, lastBackupAt }> }
 *
 * All endpoints require the x-cloud-id header to identify the connected Jira site,
 * unless allowUnauthenticated is set (test-only).
 *
 * Structured log lines are emitted on every request:
 *   [jira-inventory] <endpoint> op=<op> outcome=<ok|error|...> [backupPointId=...] [count=...]
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { BackupPointRepository } from '../manifest/BackupPointRepository';
import { JiraObjectType } from '../manifest/types';

// ── Options ───────────────────────────────────────────────────────────────────

export interface InventoryRouterOptions {
  /**
   * Root directory where issue JSON payloads are stored by IssueCaptureOrchestrator.
   * When provided, GET /inventory/issues loads rich fields (summary, issueStatus,
   * issueType, assignee) from {backupDir}/{backupPointId}/issues/{issueKey}.json.
   * When absent those fields are returned as null.
   */
  backupDir?: string;
  /**
   * Skip x-cloud-id header validation. Use ONLY in tests — never in production.
   */
  allowUnauthenticated?: boolean;
}

// ── Response shape types ──────────────────────────────────────────────────────

export interface InventorySummaryResponse {
  backupPointId: string | null;
  counts: Record<string, number>;
}

export interface IssueTableRow {
  issueKey: string;
  summary: string | null;
  issueStatus: string | null;
  issueType: string | null;
  assignee: string | null;
  /** 'protected' when status=ok, 'error' when status=error */
  platformStatus: 'protected' | 'error';
  /** Backup policy label — always 'daily' in Phase 1 */
  policy: string;
  lastBackupAt: string;
  backupPointId: string;
}

export interface SearchCard {
  type: JiraObjectType;
  id: string;
  displayName: string;
  projectKey?: string;
  lastBackupAt: string | null;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createInventoryRouter(
  repo: BackupPointRepository,
  opts: InventoryRouterOptions = {},
): Router {
  const router = Router();

  // ── Auth helper ─────────────────────────────────────────────────────────────

  function resolveCloudId(req: Request, res: Response): string | null {
    const cloudId = req.headers['x-cloud-id'] as string | undefined;
    if (!cloudId) {
      if (!opts.allowUnauthenticated) {
        res.status(401).json({ error: 'missing_cloud_id' });
        return null;
      }
      // In unauthenticated mode without a header, require the query param for
      // functional routing (cloud ID is needed to look up the backup point).
      const qCloudId = req.query['cloudId'] as string | undefined;
      if (!qCloudId) {
        res.status(400).json({ error: 'missing_cloud_id' });
        return null;
      }
      return qCloudId;
    }
    return cloudId;
  }

  // ── GET /inventory/summary ──────────────────────────────────────────────────

  router.get('/inventory/summary', (req: Request, res: Response): void => {
    const cloudId = resolveCloudId(req, res);
    if (!cloudId) return;

    const points = repo.listByCloudId(cloudId);
    const latest = points[0] ?? null;

    if (!latest) {
      console.log(
        `[jira-inventory] summary op=get cloudId=${cloudId} outcome=no_backups`,
      );
      const body: InventorySummaryResponse = {
        backupPointId: null,
        counts: { JiraIssue: 0, JiraProject: 0, JiraBoard: 0, JiraSprint: 0 },
      };
      res.json(body);
      return;
    }

    const objectTypes: JiraObjectType[] = [
      'JiraIssue',
      'JiraProject',
      'JiraBoard',
      'JiraSprint',
    ];

    const counts: Record<string, number> = {};
    for (const type of objectTypes) {
      counts[type] = repo.countEntriesByObjectType(latest.id, type);
    }

    console.log(
      `[jira-inventory] summary op=get backupPointId=${latest.id} ` +
        `issueCount=${counts['JiraIssue']} projectCount=${counts['JiraProject']} ` +
        `boardCount=${counts['JiraBoard']} sprintCount=${counts['JiraSprint']} outcome=ok`,
    );

    const body: InventorySummaryResponse = {
      backupPointId: latest.id,
      counts,
    };
    res.json(body);
  });

  // ── GET /inventory/issues ──────────────────────────────────────────────────

  router.get('/inventory/issues', (req: Request, res: Response): void => {
    const cloudId = resolveCloudId(req, res);
    if (!cloudId) return;

    const points = repo.listByCloudId(cloudId);
    const latest = points[0] ?? null;

    if (!latest) {
      console.log(
        `[jira-inventory] issues op=list cloudId=${cloudId} outcome=no_backups`,
      );
      res.json({ issues: [], total: 0, backupPointId: null });
      return;
    }

    const rawOffset = parseInt((req.query.offset as string) || '0', 10);
    const rawLimit = parseInt((req.query.limit as string) || '50', 10);
    const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : Math.min(rawLimit, 200);

    // Filter to JiraIssue entries only; exclude attachment sub-entries (key contains ':att:')
    const allIssueEntries = repo
      .getEntriesByBackupPoint(latest.id)
      .filter(
        (e) => e.objectType === 'JiraIssue' && !e.objectId.includes(':att:'),
      );

    const total = allIssueEntries.length;
    const page = allIssueEntries.slice(offset, offset + limit);

    const issues: IssueTableRow[] = page.map((entry) => {
      let summary: string | null = null;
      let issueStatus: string | null = null;
      let issueType: string | null = null;
      let assignee: string | null = null;

      if (opts.backupDir) {
        try {
          const filePath = path.join(
            opts.backupDir,
            latest.id,
            'issues',
            `${entry.objectId}.json`,
          );
          const raw = fs.readFileSync(filePath, 'utf-8');
          const payload = JSON.parse(raw) as {
            fields?: Record<string, unknown>;
          };
          summary = (payload.fields?.['summary'] as string) ?? null;
          issueStatus =
            (payload.fields?.['status'] as { name?: string } | null)?.name ??
            null;
          issueType =
            (
              payload.fields?.['issuetype'] as { name?: string } | null
            )?.name ?? null;
          assignee =
            (
              payload.fields?.['assignee'] as {
                displayName?: string;
              } | null
            )?.displayName ?? null;
        } catch {
          // File not found or JSON parse error — rich fields remain null.
          // This is expected when backupDir is configured but the issue
          // payload file has not yet been written.
        }
      }

      return {
        issueKey: entry.objectId,
        summary,
        issueStatus,
        issueType,
        assignee,
        platformStatus: entry.status === 'ok' ? 'protected' : 'error',
        policy: 'daily',
        lastBackupAt: new Date(entry.capturedAt).toISOString(),
        backupPointId: entry.backupPointId,
      };
    });

    console.log(
      `[jira-inventory] issues op=list backupPointId=${latest.id} ` +
        `total=${total} returned=${issues.length} offset=${offset} limit=${limit} outcome=ok`,
    );

    res.json({ issues, total, backupPointId: latest.id });
  });

  // ── GET /search ─────────────────────────────────────────────────────────────

  router.get('/search', (req: Request, res: Response): void => {
    const cloudId = resolveCloudId(req, res);
    if (!cloudId) return;

    const q = ((req.query.q as string) ?? '').trim();

    if (!q) {
      console.log(
        `[jira-inventory] search op=search cloudId=${cloudId} outcome=empty_query`,
      );
      res.json({ results: [] });
      return;
    }

    const points = repo.listByCloudId(cloudId);
    const latest = points[0] ?? null;

    if (!latest) {
      console.log(
        `[jira-inventory] search op=search cloudId=${cloudId} q="${q}" outcome=no_backups`,
      );
      res.json({ results: [] });
      return;
    }

    const lowerQ = q.toLowerCase();
    const results: SearchCard[] = [];

    // ── Search context node entries from manifest_json ──────────────────────
    // Projects, Boards, Sprints are captured by ContextNodeCaptureOrchestrator
    // and stored in the backup_points.manifest_json blob as ManifestEntry[].
    const manifest = repo.getById(latest.id);

    if (manifest?.entries) {
      for (const entry of manifest.entries) {
        // Skip failed / skipped entries
        if (entry.status !== 'success') continue;

        const data = entry.data as Record<string, unknown> | null | undefined;

        if (entry.objectType === 'JiraProject') {
          // data is ProjectNode: { key, name, ... }
          const projectKey =
            (data?.['key'] as string | undefined) ?? entry.key ?? '';
          const projectName = (data?.['name'] as string | undefined) ?? '';
          if (
            projectKey.toLowerCase().includes(lowerQ) ||
            projectName.toLowerCase().includes(lowerQ)
          ) {
            results.push({
              type: 'JiraProject',
              id: entry.id,
              displayName: projectName || projectKey,
              projectKey: projectKey || undefined,
              lastBackupAt: entry.capturedAt,
            });
          }
        } else if (entry.objectType === 'JiraBoard') {
          // data is { id, name, location: { projectKey? } }
          const boardName = (data?.['name'] as string | undefined) ?? '';
          const location = data?.['location'] as
            | { projectKey?: string }
            | null
            | undefined;
          const boardProjectKey = location?.projectKey ?? undefined;
          if (boardName.toLowerCase().includes(lowerQ)) {
            results.push({
              type: 'JiraBoard',
              id: entry.id,
              displayName: boardName,
              projectKey: boardProjectKey,
              lastBackupAt: entry.capturedAt,
            });
          }
        } else if (entry.objectType === 'JiraSprint') {
          // data is { id, name, state, ... }
          const sprintName = (data?.['name'] as string | undefined) ?? '';
          if (sprintName.toLowerCase().includes(lowerQ)) {
            results.push({
              type: 'JiraSprint',
              id: entry.id,
              displayName: sprintName,
              lastBackupAt: entry.capturedAt,
            });
          }
        }
      }
    }

    // ── Search issues from manifest_entries table ────────────────────────────
    // Issues are stored in manifest_entries (not in manifest_json.entries).
    // We match by issueKey (objectId).
    const issueEntries = repo
      .getEntriesByBackupPoint(latest.id)
      .filter(
        (e) => e.objectType === 'JiraIssue' && !e.objectId.includes(':att:'),
      );

    for (const entry of issueEntries) {
      if (entry.objectId.toLowerCase().includes(lowerQ)) {
        results.push({
          type: 'JiraIssue',
          id: entry.objectId,
          displayName: entry.objectId,
          lastBackupAt: new Date(entry.capturedAt).toISOString(),
        });
      }
    }

    console.log(
      `[jira-inventory] search op=search backupPointId=${latest.id} ` +
        `q="${q}" results=${results.length} outcome=ok`,
    );

    res.json({ results });
  });

  return router;
}
