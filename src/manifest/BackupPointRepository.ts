/**
 * BackupPointRepository — SQLite-backed store for backup-point manifests.
 *
 * The backup_points table (migration 003_backup_points.sql) stores the full
 * BackupPointManifest JSON in a single manifest_json column. Manifests are
 * NEVER held only in-process memory — every stage boundary writes to disk.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { BackupPointManifest } from './types';

const MIGRATION_PATH = path.join(
  __dirname,
  '../../db/migrations/003_backup_points.sql',
);

export class BackupPointRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Runs the backup_points migration (idempotent — uses CREATE TABLE IF NOT EXISTS).
   */
  static migrate(db: Database.Database): void {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
    db.exec(sql);
  }

  /**
   * Creates a new in-progress backup-point row.
   * manifest_json is NULL until the first stage section is written.
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
}
