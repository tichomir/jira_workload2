/**
 * RestoreJobStore — SQLite-backed persistence for restore jobs and conflicts.
 *
 * Tables (migration 007):
 *   restore_jobs      — one row per restore job; status, phase, heartbeat, stall flag
 *   restore_conflicts — pending conflict decisions for ask-mode jobs
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import {
  RestoreJob,
  RestoreConflict,
  RestoreJobStatus,
  RestorePhase,
  RestoreScope,
  RestoreDestination,
  ConflictMode,
  PhaseProgress,
} from './types';

const MIGRATION_007 = path.join(__dirname, '../../db/migrations/007_restore_jobs.sql');

// ── Raw DB row types ───────────────────────────────────────────────────────────

interface RawRestoreJobRow {
  id: string;
  source_backup_point_id: string;
  scope: string;
  destination: string;
  conflict_mode: string;
  status: string;
  current_phase: string | null;
  phase_progress: string;
  error_count: number;
  failure_diagnostic: string | null;
  adf_media_warning_emitted: number;
  trash_window_blocked: number;
  last_heartbeat_at: number | null;
  stalled: number;
  created_at: string;
  completed_at: string | null;
}

interface RawConflictRow {
  id: string;
  job_id: string;
  object_type: string;
  object_key: string;
  existing_object_summary: string | null;
  incoming_object_summary: string | null;
  decision: string | null;
  created_at: string;
  decided_at: string | null;
}

// ── Store ──────────────────────────────────────────────────────────────────────

export class RestoreJobStore {
  constructor(private readonly db: Database.Database) {}

  static migrate(db: Database.Database): void {
    const sql = fs.readFileSync(MIGRATION_007, 'utf-8');
    db.exec(sql);
  }

  // ── Job lifecycle ───────────────────────────────────────────────────────────

  createJob(params: {
    jobId: string;
    sourceBackupPointId: string;
    scope: RestoreScope;
    destination: RestoreDestination;
    conflictMode: ConflictMode;
    createdAt?: string;
  }): RestoreJob {
    const createdAt = params.createdAt ?? new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO restore_jobs
           (id, source_backup_point_id, scope, destination, conflict_mode,
            status, current_phase, phase_progress, error_count, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, '[]', 0, ?)`,
      )
      .run(
        params.jobId,
        params.sourceBackupPointId,
        JSON.stringify(params.scope),
        JSON.stringify(params.destination),
        params.conflictMode,
        createdAt,
      );

    return this.getJob(params.jobId)!;
  }

  setStatus(jobId: string, status: RestoreJobStatus): void {
    this.db
      .prepare(`UPDATE restore_jobs SET status = ? WHERE id = ?`)
      .run(status, jobId);
  }

  setCurrentPhase(jobId: string, phase: RestorePhase | null): void {
    this.db
      .prepare(`UPDATE restore_jobs SET current_phase = ? WHERE id = ?`)
      .run(phase, jobId);
  }

  updatePhaseProgress(jobId: string, phaseProgress: PhaseProgress[]): void {
    this.db
      .prepare(`UPDATE restore_jobs SET phase_progress = ? WHERE id = ?`)
      .run(JSON.stringify(phaseProgress), jobId);
  }

  updateHeartbeat(jobId: string, nowMs: number): void {
    this.db
      .prepare(
        `UPDATE restore_jobs
            SET last_heartbeat_at = ?,
                stalled = 0
          WHERE id = ?`,
      )
      .run(nowMs, jobId);
  }

  setStalled(jobId: string, stalled: boolean): void {
    this.db
      .prepare(`UPDATE restore_jobs SET stalled = ? WHERE id = ?`)
      .run(stalled ? 1 : 0, jobId);
  }

  setFailed(jobId: string, diagnostic: string, nowMs = Date.now()): void {
    this.db
      .prepare(
        `UPDATE restore_jobs
            SET status = 'failed',
                failure_diagnostic = ?,
                stalled = 0,
                completed_at = ?
          WHERE id = ?`,
      )
      .run(diagnostic, new Date(nowMs).toISOString(), jobId);
  }

  setTrashWindowBlocked(jobId: string): void {
    this.db
      .prepare(
        `UPDATE restore_jobs
            SET trash_window_blocked = 1,
                status = 'failed',
                failure_diagnostic = 'TRASH_WINDOW_BLOCK'
          WHERE id = ?`,
      )
      .run(jobId);
  }

  complete(jobId: string, status: 'completed' | 'completed_with_errors', nowMs = Date.now()): void {
    this.db
      .prepare(
        `UPDATE restore_jobs
            SET status = ?,
                stalled = 0,
                completed_at = ?
          WHERE id = ?`,
      )
      .run(status, new Date(nowMs).toISOString(), jobId);
  }

  incrementErrorCount(jobId: string): void {
    this.db
      .prepare(`UPDATE restore_jobs SET error_count = error_count + 1 WHERE id = ?`)
      .run(jobId);
  }

  setAdfMediaWarning(jobId: string): void {
    this.db
      .prepare(`UPDATE restore_jobs SET adf_media_warning_emitted = 1 WHERE id = ?`)
      .run(jobId);
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  getJob(jobId: string): RestoreJob | null {
    const row = this.db
      .prepare(`SELECT * FROM restore_jobs WHERE id = ?`)
      .get(jobId) as RawRestoreJobRow | undefined;
    return row ? mapJobRow(row) : null;
  }

  getActiveJobs(): RestoreJob[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM restore_jobs WHERE status IN ('running', 'awaiting_decision', 'stalled')`,
      )
      .all() as RawRestoreJobRow[];
    return rows.map(mapJobRow);
  }

  // ── Conflicts ────────────────────────────────────────────────────────────────

  insertConflict(params: {
    id: string;
    jobId: string;
    objectType: string;
    objectKey: string;
    existingObjectSummary?: string;
    incomingObjectSummary?: string;
    createdAt?: string;
  }): RestoreConflict {
    const createdAt = params.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO restore_conflicts
           (id, job_id, object_type, object_key, existing_object_summary,
            incoming_object_summary, decision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        params.id,
        params.jobId,
        params.objectType,
        params.objectKey,
        params.existingObjectSummary ?? null,
        params.incomingObjectSummary ?? null,
        createdAt,
      );

    return this.getConflict(params.id)!;
  }

  getConflict(conflictId: string): RestoreConflict | null {
    const row = this.db
      .prepare(`SELECT * FROM restore_conflicts WHERE id = ?`)
      .get(conflictId) as RawConflictRow | undefined;
    return row ? mapConflictRow(row) : null;
  }

  getPendingConflict(jobId: string): RestoreConflict | null {
    const row = this.db
      .prepare(
        `SELECT * FROM restore_conflicts WHERE job_id = ? AND decision IS NULL LIMIT 1`,
      )
      .get(jobId) as RawConflictRow | undefined;
    return row ? mapConflictRow(row) : null;
  }

  resolveConflict(conflictId: string, decision: 'override' | 'skip', nowMs = Date.now()): void {
    this.db
      .prepare(
        `UPDATE restore_conflicts
            SET decision = ?, decided_at = ?
          WHERE id = ?`,
      )
      .run(decision, new Date(nowMs).toISOString(), conflictId);
  }
}

// ── Mappers ────────────────────────────────────────────────────────────────────

function mapJobRow(r: RawRestoreJobRow): RestoreJob {
  return {
    jobId: r.id,
    sourceBackupPointId: r.source_backup_point_id,
    scope: JSON.parse(r.scope) as RestoreScope,
    destination: JSON.parse(r.destination) as RestoreDestination,
    conflictMode: r.conflict_mode as ConflictMode,
    status: r.status as RestoreJobStatus,
    currentPhase: (r.current_phase as RestorePhase | null) ?? null,
    phaseProgress: JSON.parse(r.phase_progress) as PhaseProgress[],
    errorCount: r.error_count,
    failureDiagnostic: r.failure_diagnostic,
    adfMediaWarningEmitted: r.adf_media_warning_emitted === 1,
    trashWindowBlocked: r.trash_window_blocked === 1,
    lastHeartbeatAt: r.last_heartbeat_at,
    stalled: r.stalled === 1,
    createdAt: r.created_at,
  };
}

function mapConflictRow(r: RawConflictRow): RestoreConflict {
  return {
    id: r.id,
    jobId: r.job_id,
    objectType: r.object_type,
    objectKey: r.object_key,
    existingObjectSummary: r.existing_object_summary,
    incomingObjectSummary: r.incoming_object_summary,
    decision: (r.decision as 'override' | 'skip' | null) ?? null,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}
