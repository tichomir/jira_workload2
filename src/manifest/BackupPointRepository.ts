/**
 * BackupPointRepository — SQLite-backed store for backup-point manifests
 * and per-item manifest_entries.
 *
 * Tables:
 *   backup_points   (migration 003) — full BackupPointManifest JSON blob
 *   manifest_entries (migration 005) — individual per-item capture rows
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { BackupPointManifest, SimpleManifestEntry, JiraObjectType } from './types';

const MIGRATION_003 = path.join(
  __dirname,
  '../../db/migrations/003_backup_points.sql',
);

const MIGRATION_005 = path.join(
  __dirname,
  '../../db/migrations/005_manifest_entries.sql',
);

export class BackupPointRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Runs all backup-point migrations (idempotent — uses CREATE TABLE IF NOT EXISTS).
   * Includes backup_points (003) and manifest_entries (005).
   */
  static migrate(db: Database.Database): void {
    const sql003 = fs.readFileSync(MIGRATION_003, 'utf-8');
    db.exec(sql003);
    const sql005 = fs.readFileSync(MIGRATION_005, 'utf-8');
    db.exec(sql005);
  }

  /**
   * Creates a new in-progress backup-point row.
   * manifest_json is initialised with an empty skeleton until first stage write.
   */
  create(
    id: string,
    cloudId: string,
    siteUrl: string,
    scopeMode: 'all' | 'selected',
  ): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO backup_points (id, cloud_id, site_url, started_at, status, manifest_json)
         VALUES (?, ?, ?, ?, 'in_progress', ?)`,
      )
      .run(
        id,
        cloudId,
        siteUrl,
        now,
        JSON.stringify({
          backupPointId: id,
          cloudId,
          siteUrl,
          createdAt: new Date(now * 1000).toISOString(),
          startedAt: new Date(now * 1000).toISOString(),
          finalisedAt: '',
          scopeMode,
          status: 'in_progress',
          stages: [],
          entries: [],
          phaseSummary: {} as Record<string, unknown>,
          reconciliation: [],
        }),
      );
  }

  /**
   * Atomically overwrites manifest_json for the given backup point.
   * Called after every stage to ensure durability at each phase boundary.
   */
  writeManifest(id: string, manifest: BackupPointManifest): void {
    this.db
      .prepare(
        `UPDATE backup_points
            SET manifest_json = ?,
                status        = ?,
                finalised_at  = ?
          WHERE id = ?`,
      )
      .run(
        JSON.stringify(manifest),
        manifest.status,
        manifest.finalisedAt
          ? Math.floor(new Date(manifest.finalisedAt).getTime() / 1000)
          : null,
        id,
      );
  }

  /**
   * Returns the stored manifest for the given backup point ID, or null.
   */
  getById(id: string): BackupPointManifest | null {
    const row = this.db
      .prepare(
        `SELECT manifest_json FROM backup_points WHERE id = ?`,
      )
      .get(id) as { manifest_json: string | null } | undefined;

    if (!row || !row.manifest_json) return null;

    return JSON.parse(row.manifest_json) as BackupPointManifest;
  }

  /**
   * Lists all backup points for a given cloud ID, newest first.
   */
  listByCloudId(
    cloudId: string,
  ): Array<{ id: string; status: string; startedAt: number }> {
    return this.db
      .prepare(
        `SELECT id, status, started_at as startedAt
           FROM backup_points
          WHERE cloud_id = ?
          ORDER BY started_at DESC`,
      )
      .all(cloudId) as Array<{ id: string; status: string; startedAt: number }>;
  }

  // ── manifest_entries ────────────────────────────────────────────────────────

  /**
   * Persists a single manifest entry to the manifest_entries table.
   * Called by BackupPointManifestWriter.append() on each captured item.
   */
  insertEntry(entry: SimpleManifestEntry): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO manifest_entries
           (id, backup_point_id, object_type, object_id, captured_at, source_endpoint, status, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.backupPointId,
        entry.objectType,
        entry.objectId,
        Math.floor(entry.capturedAt / 1000),
        entry.sourceEndpoint,
        entry.status,
        entry.errorMessage ?? null,
      );
  }

  /**
   * Returns all manifest entries for a given backup point, ordered by captured_at.
   * Used by the Inventory UI and the IssueCaptureOrchestrator finalize check.
   */
  getEntriesByBackupPoint(backupPointId: string): SimpleManifestEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, backup_point_id, object_type, object_id,
                captured_at, source_endpoint, status, error_message
           FROM manifest_entries
          WHERE backup_point_id = ?
          ORDER BY captured_at ASC`,
      )
      .all(backupPointId) as Array<{
        id: string;
        backup_point_id: string;
        object_type: string;
        object_id: string;
        captured_at: number;
        source_endpoint: string;
        status: string;
        error_message: string | null;
      }>;

    return rows.map((r) => ({
      id: r.id,
      backupPointId: r.backup_point_id,
      objectType: r.object_type as JiraObjectType,
      objectId: r.object_id,
      capturedAt: r.captured_at * 1000,
      sourceEndpoint: r.source_endpoint,
      status: r.status as 'ok' | 'error',
      errorMessage: r.error_message ?? undefined,
    }));
  }

  /**
   * Counts entries of a given objectType for a backup point.
   * Used by finalize() omission check.
   */
  countEntriesByObjectType(
    backupPointId: string,
    objectType: JiraObjectType,
    status?: 'ok' | 'error',
  ): number {
    const statusClause = status ? `AND status = '${status}'` : '';
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt
           FROM manifest_entries
          WHERE backup_point_id = ?
            AND object_type = ?
            ${statusClause}`,
      )
      .get(backupPointId, objectType) as { cnt: number };
    return row.cnt;
  }
}
