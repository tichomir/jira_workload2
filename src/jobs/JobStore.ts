/**
 * JobStore — SQLite-backed persistence for jobs, job events, and job errors.
 *
 * Tables (migration 006):
 *   jobs        — one row per backup job; tracks status, heartbeat, stalled flag
 *   job_events  — per-heartbeat event rows for audit trail
 *   job_errors  — per-item error records with full traceability
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { JobPhase, JobProgressEvent } from './JobEventBus';

const MIGRATION_006 = path.join(__dirname, '../../db/migrations/006_jobs.sql');

// ── Row types ──────────────────────────────────────────────────────────────────

export type JobStatus =
  | 'running'
  | 'stalled'
  | 'completed'
  | 'completed_with_errors'
  | 'failed';

export interface JobRow {
  id: string;
  backupPointId: string;
  phase: JobPhase;
  status: JobStatus;
  displayStatus: string | null;
  itemsProcessed: number;
  itemsFailed: number;
  itemsTotal: number | null;
  lastHeartbeatAt: number; // epoch ms
  stalled: boolean;
  createdAt: number; // epoch ms
  completedAt: number | null; // epoch ms
}

export interface JobErrorRecord {
  id: string;
  jobId: string;
  backupPointId: string;
  itemType: string;
  itemId: string;
  errorCode?: string;
  errorMessage?: string;
  timestamp: string; // ISO 8601
}

export interface JobSummary {
  status: JobStatus;
  displayStatus: string;
  itemsProcessed: number;
  itemsFailed: number;
  itemsTotal: number | null;
  lastHeartbeatAt: number;
  stalled: boolean;
  backupPointId: string;
  errors: JobErrorRecord[];
}

// ── Store ──────────────────────────────────────────────────────────────────────

export class JobStore {
  constructor(private readonly db: Database.Database) {}

  static migrate(db: Database.Database): void {
    const sql = fs.readFileSync(MIGRATION_006, 'utf-8');
    db.exec(sql);
  }

  // ── Job lifecycle ───────────────────────────────────────────────────────────

  createJob(
    jobId: string,
    backupPointId: string,
    phase: JobPhase,
    nowMs = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs
           (id, backup_point_id, phase, status, items_processed, items_failed, last_heartbeat_at, stalled, created_at)
         VALUES (?, ?, ?, 'running', 0, 0, ?, 0, ?)`,
      )
      .run(jobId, backupPointId, phase, nowMs, nowMs);
  }

  updateHeartbeat(
    jobId: string,
    itemsProcessed: number,
    itemsFailed: number,
    lastHeartbeatAt: number,
    itemsTotal?: number,
  ): void {
    this.db
      .prepare(
        `UPDATE jobs
            SET items_processed   = ?,
                items_failed      = ?,
                last_heartbeat_at = ?,
                items_total       = COALESCE(?, items_total),
                stalled           = 0
          WHERE id = ?`,
      )
      .run(itemsProcessed, itemsFailed, lastHeartbeatAt, itemsTotal ?? null, jobId);
  }

  setStalled(jobId: string, stalled: boolean): void {
    this.db
      .prepare(`UPDATE jobs SET stalled = ?, status = ? WHERE id = ?`)
      .run(
        stalled ? 1 : 0,
        stalled ? 'stalled' : 'running',
        jobId,
      );
  }

  completeJob(
    jobId: string,
    itemsProcessed: number,
    itemsFailed: number,
    nowMs = Date.now(),
  ): void {
    // Status precedence: failed > completed_with_errors > completed
    // Hard failure is set explicitly via setFailed(); here we handle success paths.
    const status: JobStatus = itemsFailed > 0 ? 'completed_with_errors' : 'completed';
    const displayStatus =
      itemsFailed > 0
        ? `Completed with ${itemsFailed} errors`
        : 'Completed successfully';

    this.db
      .prepare(
        `UPDATE jobs
            SET status          = ?,
                display_status  = ?,
                items_processed = ?,
                items_failed    = ?,
                completed_at    = ?,
                stalled         = 0
          WHERE id = ?`,
      )
      .run(status, displayStatus, itemsProcessed, itemsFailed, nowMs, jobId);
  }

  setFailed(jobId: string, reason: string, nowMs = Date.now()): void {
    this.db
      .prepare(
        `UPDATE jobs
            SET status         = 'failed',
                display_status = ?,
                completed_at   = ?,
                stalled        = 0
          WHERE id = ?`,
      )
      .run(`Failed: ${reason}`, nowMs, jobId);
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  getJob(jobId: string): JobRow | null {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE id = ?`)
      .get(jobId) as RawJobRow | undefined;
    return row ? mapJobRow(row) : null;
  }

  getActiveJobs(nowMs?: number): JobRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status IN ('running', 'stalled')`,
      )
      .all() as RawJobRow[];
    return rows.map(mapJobRow);
  }

  // ── Job events ───────────────────────────────────────────────────────────────

  insertJobEvent(event: JobProgressEvent): void {
    const id = `evt-${event.jobId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.db
      .prepare(
        `INSERT INTO job_events
           (id, job_id, event_type, phase, items_processed, items_failed, items_total,
            current_item_key, backup_point_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        event.jobId,
        event.type,
        event.phase,
        event.itemsProcessed,
        event.itemsFailed,
        event.itemsTotal ?? null,
        event.currentItemKey ?? null,
        event.backupPointId,
        event.timestamp,
      );
  }

  getJobEvents(jobId: string): JobProgressEvent[] {
    const rows = this.db
      .prepare(
        `SELECT event_type, job_id, backup_point_id, phase, items_processed,
                items_failed, items_total, current_item_key, timestamp
           FROM job_events
          WHERE job_id = ?
          ORDER BY timestamp ASC`,
      )
      .all(jobId) as Array<{
        event_type: string;
        job_id: string;
        backup_point_id: string;
        phase: string;
        items_processed: number;
        items_failed: number;
        items_total: number | null;
        current_item_key: string | null;
        timestamp: string;
      }>;

    return rows.map((r) => ({
      type: r.event_type as 'heartbeat' | 'stalled' | 'terminal',
      jobId: r.job_id,
      backupPointId: r.backup_point_id,
      phase: r.phase as JobPhase,
      itemsProcessed: r.items_processed,
      itemsFailed: r.items_failed,
      itemsTotal: r.items_total ?? undefined,
      currentItemKey: r.current_item_key ?? undefined,
      timestamp: r.timestamp,
    }));
  }

  // ── Job errors ───────────────────────────────────────────────────────────────

  insertJobError(error: Omit<JobErrorRecord, 'id'>): void {
    const id = `jerr-${error.jobId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.db
      .prepare(
        `INSERT INTO job_errors
           (id, job_id, backup_point_id, item_type, item_id, error_code, error_message, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        error.jobId,
        error.backupPointId,
        error.itemType,
        error.itemId,
        error.errorCode ?? null,
        error.errorMessage ?? null,
        error.timestamp,
      );
  }

  getJobErrors(jobId: string): JobErrorRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, job_id, backup_point_id, item_type, item_id, error_code, error_message, timestamp
           FROM job_errors
          WHERE job_id = ?
          ORDER BY timestamp ASC`,
      )
      .all(jobId) as Array<{
        id: string;
        job_id: string;
        backup_point_id: string;
        item_type: string;
        item_id: string;
        error_code: string | null;
        error_message: string | null;
        timestamp: string;
      }>;

    return rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      backupPointId: r.backup_point_id,
      itemType: r.item_type,
      itemId: r.item_id,
      errorCode: r.error_code ?? undefined,
      errorMessage: r.error_message ?? undefined,
      timestamp: r.timestamp,
    }));
  }

  // ── Summary ──────────────────────────────────────────────────────────────────

  getJobSummary(jobId: string): JobSummary | null {
    const job = this.getJob(jobId);
    if (!job) return null;

    const errors = this.getJobErrors(jobId);

    const displayStatus =
      job.displayStatus ??
      (job.status === 'completed'
        ? 'Completed successfully'
        : job.status === 'completed_with_errors'
          ? `Completed with ${job.itemsFailed} errors`
          : job.status === 'failed'
            ? 'Failed'
            : job.status === 'stalled'
              ? 'Stalled'
              : 'Running');

    return {
      status: job.status,
      displayStatus,
      itemsProcessed: job.itemsProcessed,
      itemsFailed: job.itemsFailed,
      itemsTotal: job.itemsTotal,
      lastHeartbeatAt: job.lastHeartbeatAt,
      stalled: job.stalled,
      backupPointId: job.backupPointId,
      errors,
    };
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────────

interface RawJobRow {
  id: string;
  backup_point_id: string;
  phase: string;
  status: string;
  display_status: string | null;
  items_processed: number;
  items_failed: number;
  items_total: number | null;
  last_heartbeat_at: number;
  stalled: number;
  created_at: number;
  completed_at: number | null;
}

function mapJobRow(r: RawJobRow): JobRow {
  return {
    id: r.id,
    backupPointId: r.backup_point_id,
    phase: r.phase as JobPhase,
    status: r.status as JobStatus,
    displayStatus: r.display_status,
    itemsProcessed: r.items_processed,
    itemsFailed: r.items_failed,
    itemsTotal: r.items_total,
    lastHeartbeatAt: r.last_heartbeat_at,
    stalled: r.stalled === 1,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}
