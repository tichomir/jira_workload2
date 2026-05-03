/**
 * BackupPointManifestWriter
 *
 * Writes per-stage sections to the backup-point manifest atomically.
 * Also persists individual item entries via append() for issue/attachment capture.
 *
 * Enforces two invariants:
 *
 * 1. Stage integrity: capturedCount + skippedIds.length === apiTotalReported
 *    Violation raises ManifestIntegrityError and marks status 'completed_with_errors'.
 *
 * 2. Omission check (finalize with discoveredCounts): captured ok-entries count
 *    must equal the discovered count for every objectType passed.
 *    Violation raises ManifestOmissionError.
 *
 * See: docs/architecture/context-capture-pipeline.md §2
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  BackupPointManifest,
  ManifestEntry,
  ManifestStageSection,
  CapturePhase,
  PhaseSummary,
  ReconciliationReport,
  JiraObjectType,
  SimpleManifestEntry,
} from './types';
import { BackupPointRepository } from './BackupPointRepository';
import { backupMetrics } from '../metrics/BackupMetrics';

// ── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA_PATH = path.join(__dirname, 'manifest-schema.json');

// ── Error types ───────────────────────────────────────────────────────────────

/**
 * Raised when capturedCount + skippedIds.length !== apiTotalReported.
 * Signals a silent-omission risk and marks the manifest
 * status='completed_with_errors'.
 */
export class ManifestIntegrityError extends Error {
  readonly stageName: string;
  readonly capturedCount: number;
  readonly skippedCount: number;
  readonly apiTotalReported: number;
  readonly actualSum: number;

  constructor(
    stageName: string,
    capturedCount: number,
    skippedCount: number,
    apiTotalReported: number,
  ) {
    const actualSum = capturedCount + skippedCount;
    super(
      `ManifestIntegrityError at stage '${stageName}': ` +
        `capturedCount(${capturedCount}) + skippedCount(${skippedCount}) = ${actualSum} ` +
        `!== apiTotalReported(${apiTotalReported})`,
    );
    this.name = 'ManifestIntegrityError';
    this.stageName = stageName;
    this.capturedCount = capturedCount;
    this.skippedCount = skippedCount;
    this.apiTotalReported = apiTotalReported;
    this.actualSum = actualSum;
  }
}

/**
 * Raised by finalize() when the number of ok-status manifest_entries for an
 * objectType does not match the discovered count supplied by the caller.
 * Zero-silent-omission guarantee: every discovered object must have a
 * corresponding ok entry, or finalize() throws this error.
 */
export class ManifestOmissionError extends Error {
  readonly objectType: JiraObjectType;
  readonly discoveredCount: number;
  readonly capturedCount: number;

  constructor(
    objectType: JiraObjectType,
    discoveredCount: number,
    capturedCount: number,
  ) {
    super(
      `ManifestOmissionError for '${objectType}': ` +
        `discovered ${discoveredCount} but only ${capturedCount} ok entries in manifest`,
    );
    this.name = 'ManifestOmissionError';
    this.objectType = objectType;
    this.discoveredCount = discoveredCount;
    this.capturedCount = capturedCount;
  }
}

// ── Validation result ─────────────────────────────────────────────────────────

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
}

// ── Writer config ─────────────────────────────────────────────────────────────

export interface ManifestWriterConfig {
  backupPointId: string;
  cloudId: string;
  siteUrl: string;
  scopeMode: 'all' | 'selected';
}

// ── Phase → ObjectType mapping ────────────────────────────────────────────────

const PHASE_OBJECT_TYPE: Partial<Record<CapturePhase, JiraObjectType>> = {
  issue_type: 'IssueType',
  custom_field: 'CustomField',
  field_configuration: 'FieldConfiguration',
  workflow: 'Workflow',
  workflow_scheme: 'WorkflowScheme',
  project: 'JiraProject',
  board: 'JiraBoard',
  sprint: 'JiraSprint',
  issue: 'JiraIssue',
};

// ── Writer ────────────────────────────────────────────────────────────────────

export class BackupPointManifestWriter {
  private readonly sections: ManifestStageSection[] = [];
  private readonly allEntries: ManifestEntry[] = [];
  private integrityErrors = 0;
  private readonly createdAt: string;

  constructor(
    private readonly repo: BackupPointRepository,
    private readonly config: ManifestWriterConfig,
  ) {
    this.createdAt = new Date().toISOString();
    this.repo.create(
      config.backupPointId,
      config.cloudId,
      config.siteUrl,
      config.scopeMode,
    );
  }

  /**
   * Appends a stage section to the manifest and persists atomically to SQLite.
   *
   * Enforces invariant: capturedCount + skippedIds.length === apiTotalReported.
   * If violated, throws ManifestIntegrityError and records the violation
   * (the backup continues but status becomes 'completed_with_errors').
   *
   * @throws ManifestIntegrityError on integrity violation
   */
  appendStageSection(
    section: ManifestStageSection,
    entries: ManifestEntry[],
  ): void {
    // Integrity invariant check (only when apiTotalReported is known)
    if (section.apiTotalReported !== null) {
      const skippedCount = section.skippedIds.length;
      const actualSum = section.capturedCount + skippedCount;
      if (actualSum !== section.apiTotalReported) {
        this.integrityErrors++;
        const err = new ManifestIntegrityError(
          section.stageName,
          section.capturedCount,
          skippedCount,
          section.apiTotalReported,
        );
        console.error(`[jira-manifest] integrity-violation ${err.message}`);
        // Persist current state as completed_with_errors before re-throwing
        this.sections.push(section);
        this.allEntries.push(...entries);
        this.persistSnapshot('completed_with_errors');
        throw err;
      }
    }

    this.sections.push(section);
    this.allEntries.push(...entries);

    // Structured log: manifest stage written
    const objectType = PHASE_OBJECT_TYPE[section.stageName] ?? section.stageName;
    console.log(
      `[jira-backup] manifest_written backupPointId=${this.config.backupPointId} ` +
        `objectType=${objectType} count=${section.capturedCount}`,
    );
    backupMetrics.incManifestWrites();

    // Atomic per-stage write to SQLite
    this.persistSnapshot('in_progress');
  }

  /**
   * Appends a single per-item entry to the manifest_entries table.
   *
   * Used by IssueCaptureOrchestrator and attachment download to record
   * every captured item (ok or error) with full traceability:
   *   backupPointId + capturedAt → single-click lookup in Inventory UI.
   *
   * A structured log line is emitted for every append so the test suite
   * can verify execution evidence without inspecting the DB directly.
   */
  append(entry: SimpleManifestEntry): void {
    this.repo.insertEntry(entry);
    console.log(
      `[jira-manifest] append backupPointId=${entry.backupPointId} ` +
        `objectType=${entry.objectType} objectId=${entry.objectId} ` +
        `status=${entry.status}` +
        (entry.errorMessage ? ` error=${entry.errorMessage}` : ''),
    );
  }

  /**
   * Convenience helper that generates a UUID id for the entry.
   */
  appendEntry(
    partial: Omit<SimpleManifestEntry, 'id' | 'backupPointId'>,
  ): void {
    this.append({
      id: randomUUID(),
      backupPointId: this.config.backupPointId,
      ...partial,
    });
  }

  /**
   * Finalises the manifest, sets the terminal status, and writes the
   * completed manifest to SQLite. Returns the finalized manifest.
   *
   * When discoveredCounts is provided, performs the zero-silent-omission check:
   * for each objectType, the count of ok-status manifest_entries must equal
   * the discovered count. Throws ManifestOmissionError on mismatch BEFORE
   * persisting the final status (the backup-point row already has a status
   * from the last appendStageSection call, so data is not lost).
   *
   * @throws ManifestOmissionError when any objectType has fewer ok entries
   *         than the supplied discovered count.
   */
  finalize(
    status: 'completed' | 'completed_with_errors' | 'halted',
    discoveredCounts?: Partial<Record<JiraObjectType, number>>,
  ): BackupPointManifest {
    // Zero-silent-omission check
    if (discoveredCounts) {
      for (const [objectType, discoveredCount] of Object.entries(discoveredCounts)) {
        if (discoveredCount === undefined || discoveredCount === null) continue;
        const capturedCount = this.repo.countEntriesByObjectType(
          this.config.backupPointId,
          objectType as JiraObjectType,
          'ok',
        );
        if (capturedCount !== discoveredCount) {
          throw new ManifestOmissionError(
            objectType as JiraObjectType,
            discoveredCount,
            capturedCount,
          );
        }
      }
    }

    const effectiveStatus =
      this.integrityErrors > 0 && status !== 'halted'
        ? 'completed_with_errors'
        : status;

    return this.persistSnapshot(effectiveStatus);
  }

  // ── Static validator ────────────────────────────────────────────────────────

  /**
   * Validates a manifest object against the JSON schema and integrity rules.
   * Runnable standalone against any persisted manifest:
   *
   *   const stored = repo.getById(id);
   *   const result = BackupPointManifestWriter.validate(stored);
   *   if (!result.valid) console.error(result.errors);
   */
  static validate(manifest: unknown): ManifestValidationResult {
    const errors: string[] = [];

    if (!manifest || typeof manifest !== 'object') {
      return { valid: false, errors: ['manifest must be a non-null object'] };
    }

    const m = manifest as Record<string, unknown>;

    // Required top-level string fields
    const requiredStrings = [
      'backupPointId',
      'cloudId',
      'siteUrl',
      'createdAt',
      'startedAt',
      'finalisedAt',
    ];
    for (const field of requiredStrings) {
      if (typeof m[field] !== 'string' || (m[field] as string).length === 0) {
        errors.push(`'${field}' must be a non-empty string`);
      }
    }

    // scopeMode
    if (m['scopeMode'] !== 'all' && m['scopeMode'] !== 'selected') {
      errors.push(`'scopeMode' must be 'all' or 'selected'`);
    }

    // status
    const validStatuses = [
      'in_progress',
      'completed',
      'completed_with_errors',
      'halted',
    ];
    if (!validStatuses.includes(m['status'] as string)) {
      errors.push(`'status' must be one of: ${validStatuses.join(', ')}`);
    }

    // stages array
    if (!Array.isArray(m['stages'])) {
      errors.push(`'stages' must be an array`);
    } else {
      for (let i = 0; i < (m['stages'] as unknown[]).length; i++) {
        const stageErrors = BackupPointManifestWriter.validateStageSection(
          (m['stages'] as unknown[])[i],
          i,
        );
        errors.push(...stageErrors);
      }
    }

    // entries array
    if (!Array.isArray(m['entries'])) {
      errors.push(`'entries' must be an array`);
    }

    // Integrity invariant on every stage
    if (Array.isArray(m['stages'])) {
      for (const stage of m['stages'] as ManifestStageSection[]) {
        if (
          stage.apiTotalReported !== null &&
          stage.apiTotalReported !== undefined
        ) {
          const skippedCount = stage.skippedIds?.length ?? 0;
          const actualSum = (stage.capturedCount ?? 0) + skippedCount;
          if (actualSum !== stage.apiTotalReported) {
            errors.push(
              `integrity violation at stage '${stage.stageName}': ` +
                `capturedCount(${stage.capturedCount}) + skippedCount(${skippedCount}) = ${actualSum} ` +
                `!== apiTotalReported(${stage.apiTotalReported})`,
            );
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Loads a manifest from the store and validates it.
   * Suitable for use as a standalone CLI harness or test utility.
   */
  static validateFromStore(
    repo: BackupPointRepository,
    backupPointId: string,
  ): ManifestValidationResult {
    const manifest = repo.getById(backupPointId);
    if (!manifest) {
      return {
        valid: false,
        errors: [`No manifest found for backupPointId='${backupPointId}'`],
      };
    }
    return BackupPointManifestWriter.validate(manifest);
  }

  /**
   * Loads and validates a manifest from a JSON file on disk.
   * Suitable for offline/export validation.
   */
  static validateFromFile(filePath: string): ManifestValidationResult {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return { valid: false, errors: [`Cannot read file: ${filePath}`] };
    }

    let manifest: unknown;
    try {
      manifest = JSON.parse(raw);
    } catch {
      return { valid: false, errors: ['File is not valid JSON'] };
    }

    return BackupPointManifestWriter.validate(manifest);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private persistSnapshot(
    status: BackupPointManifest['status'],
  ): BackupPointManifest {
    const now = new Date().toISOString();
    const phaseSummary = this.buildPhaseSummary();
    const reconciliation = this.buildReconciliation();

    const manifest: BackupPointManifest = {
      backupPointId: this.config.backupPointId,
      cloudId: this.config.cloudId,
      siteUrl: this.config.siteUrl,
      createdAt: this.createdAt,
      startedAt: this.createdAt,
      finalisedAt:
        status === 'in_progress' ? '' : now,
      scopeMode: this.config.scopeMode,
      status,
      stages: [...this.sections],
      entries: [...this.allEntries],
      phaseSummary,
      reconciliation,
    };

    this.repo.writeManifest(this.config.backupPointId, manifest);
    return manifest;
  }

  private buildPhaseSummary(): Record<CapturePhase, PhaseSummary> {
    const summary = {} as Record<CapturePhase, PhaseSummary>;

    for (const section of this.sections) {
      const phase = section.stageName;
      const phaseEntries = this.allEntries.filter((e) => e.phase === phase);
      summary[phase] = {
        phase,
        totalFetched:
          (section.capturedCount ?? 0) + section.skippedIds.length,
        successCount: phaseEntries.filter((e) => e.status === 'success').length,
        errorCount: phaseEntries.filter((e) => e.status === 'error').length,
        skippedCount: phaseEntries.filter(
          (e) => e.status === 'skipped' || e.status === 'out_of_scope',
        ).length,
        completed: true,
      };
    }

    return summary;
  }

  private buildReconciliation(): ReconciliationReport[] {
    return this.sections.map((section) => {
      const objectType =
        PHASE_OBJECT_TYPE[section.stageName] ?? ('Unknown' as JiraObjectType);
      const manifestEntryCount = this.allEntries.filter(
        (e) => e.phase === section.stageName,
      ).length;
      const totalFetched =
        section.capturedCount + section.skippedIds.length;
      const reconciled =
        section.apiTotalReported === null
          ? true
          : totalFetched === section.apiTotalReported;

      return {
        objectType,
        apiReportedTotal: section.apiTotalReported,
        totalFetched,
        manifestEntryCount,
        reconciled,
        gap: reconciled ? undefined : section.apiTotalReported! - totalFetched,
      };
    });
  }

  private static validateStageSection(
    stage: unknown,
    index: number,
  ): string[] {
    const errors: string[] = [];
    if (!stage || typeof stage !== 'object') {
      errors.push(`stages[${index}] must be an object`);
      return errors;
    }
    const s = stage as Record<string, unknown>;
    const required = [
      'stageName',
      'apiPageCount',
      'apiTotalReported',
      'capturedCount',
      'skippedIds',
      'skippedReasons',
    ];
    for (const field of required) {
      if (!(field in s)) {
        errors.push(`stages[${index}].${field} is required`);
      }
    }
    if (typeof s['capturedCount'] !== 'number' || s['capturedCount'] < 0) {
      errors.push(`stages[${index}].capturedCount must be a non-negative number`);
    }
    if (!Array.isArray(s['skippedIds'])) {
      errors.push(`stages[${index}].skippedIds must be an array`);
    }
    if (typeof s['skippedReasons'] !== 'object' || Array.isArray(s['skippedReasons'])) {
      errors.push(`stages[${index}].skippedReasons must be an object`);
    }
    return errors;
  }
}
