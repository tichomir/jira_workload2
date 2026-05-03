/**
 * WorkloadConfigRepository — persists per-site workload configuration.
 *
 * Currently stores:
 *   - scope: 'all' | 'selected' (project discovery scope)
 *   - selectedKeys: string[] (project keys when scope === 'selected')
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export interface WorkloadConfig {
  cloudId: string;
  scope: 'all' | 'selected';
  selectedKeys: string[];
}

const MIGRATION_PATH = path.join(__dirname, '../../db/migrations/004_workload_config.sql');

export class WorkloadConfigRepository {
  constructor(private readonly db: Database.Database) {}

  static runMigration(db: Database.Database): void {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
    db.exec(sql);
  }

  upsert(cloudId: string, scope: 'all' | 'selected', selectedKeys: string[]): void {
    this.db
      .prepare(
        `INSERT INTO workload_config (cloud_id, scope, selected_keys, updated_at)
         VALUES (?, ?, ?, unixepoch())
         ON CONFLICT(cloud_id) DO UPDATE SET
           scope         = excluded.scope,
           selected_keys = excluded.selected_keys,
           updated_at    = unixepoch()`,
      )
      .run(cloudId, scope, JSON.stringify(selectedKeys));
  }

  getByCloudId(cloudId: string): WorkloadConfig | null {
    const row = this.db
      .prepare('SELECT cloud_id, scope, selected_keys FROM workload_config WHERE cloud_id = ?')
      .get(cloudId) as
      | { cloud_id: string; scope: string; selected_keys: string | null }
      | undefined;

    if (!row) return null;
    return {
      cloudId: row.cloud_id,
      scope: row.scope as 'all' | 'selected',
      selectedKeys: row.selected_keys ? (JSON.parse(row.selected_keys) as string[]) : [],
    };
  }
}
