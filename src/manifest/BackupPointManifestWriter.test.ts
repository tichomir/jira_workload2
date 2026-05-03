/**
 * Tests for BackupPointManifestWriter
 *
 * Covers:
 *  - capturedCount + skippedIds.length === apiTotalReported invariant
 *  - ManifestIntegrityError raised on violation
 *  - completed_with_errors status on integrity failure
 *  - Atomic per-stage persistence to SQLite
 *  - Validator runnable standalone against persisted manifests
 *  - Schema validation of required fields
 */

import Database from 'better-sqlite3';
import {
  BackupPointManifestWriter,
  ManifestIntegrityError,
} from './BackupPointManifestWriter';
import { BackupPointRepository } from './BackupPointRepository';
import { ManifestEntry, ManifestStageSection } from './types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  BackupPointRepository.migrate(db);
  return db;
}

function makeRepo(db: Database.Database): BackupPointRepository {
  return new BackupPointRepository(db);
}

function makeWriter(
  repo: BackupPointRepository,
  opts: { id?: string; scopeMode?: 'all' | 'selected' } = {},
): BackupPointManifestWriter {
  return new BackupPointManifestWriter(repo, {
    backupPointId: opts.id ?? 'bp-001',
    cloudId: 'cloud-xyz',
    siteUrl: 'https://example.atlassian.net',
    scopeMode: opts.scopeMode ?? 'all',
  });
}

function makeSection(
  stageName: ManifestStageSection['stageName'],
  capturedCount: number,
  skippedIds: string[] = [],
  apiTotalReported: number | null = null,
): ManifestStageSection {
  return {
    stageName,
    apiPageCount: 1,
    apiTotalReported:
      apiTotalReported ?? capturedCount + skippedIds.length,
    capturedCount,
    skippedIds,
    skippedReasons: Object.fromEntries(
      skippedIds.map((id) => [id, 'system_field']),
    ),
  };
}

function makeEntry(
  id: string,
  phase: ManifestEntry['phase'],
): ManifestEntry {
  return {
    id,
    key: `key-${id}`,
    phase,
    objectType: 'IssueType',
    capturedAt: new Date().toISOString(),
    status: 'success',
    backupPointId: 'bp-001',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BackupPointManifestWriter', () => {
  describe('integrity invariant — capturedCount + skippedIds.length === apiTotalReported', () => {
    it('does not throw when invariant holds (capturedCount + skipped === total)', () => {
      const repo = makeRepo(makeDb());
      const writer = makeWriter(repo);

      // 3 captured + 1 skipped = 4 = apiTotalReported
      const section = makeSection('issue_type', 3, ['sys-1'], 4);
      const entries = [
        makeEntry('1', 'issue_type'),
        makeEntry('2', 'issue_type'),
        makeEntry('3', 'issue_type'),
      ];

      expect(() => writer.appendStageSection(section, entries)).not.toThrow();
    });

    it('does not throw when apiTotalReported is null (non-paginated endpoint)', () => {
      const repo = makeRepo(makeDb());
      const writer = makeWriter(repo);

      const section: ManifestStageSection = {
        stageName: 'issue_type',
        apiPageCount: 1,
        apiTotalReported: null, // null — invariant not applicable
        capturedCount: 5,
        skippedIds: [],
        skippedReasons: {},
      };

      expect(() => writer.appendStageSection(section, [])).not.toThrow();
    });

    it('throws ManifestIntegrityError when capturedCount + skipped !== apiTotalReported', () => {
      const repo = makeRepo(makeDb());
      const writer = makeWriter(repo);

      // API says 5 total but we only captured 3 with no skipped = 3 ≠ 5
      const section = makeSection('issue_type', 3, [], 5);

      expect(() => writer.appendStageSection(section, [])).toThrow(
        ManifestIntegrityError,
      );
    });

    it('ManifestIntegrityError carries stage, counts, and sum', () => {
      const repo = makeRepo(makeDb());
      const writer = makeWriter(repo);

      const section = makeSection('workflow', 2, ['skip-1'], 5);

      let caught: ManifestIntegrityError | undefined;
      try {
        writer.appendStageSection(section, []);
      } catch (err) {
        caught = err as ManifestIntegrityError;
      }

      expect(caught).toBeDefined();
      expect(caught!.stageName).toBe('workflow');
      expect(caught!.capturedCount).toBe(2);
      expect(caught!.skippedCount).toBe(1);
      expect(caught!.apiTotalReported).toBe(5);
      expect(caught!.actualSum).toBe(3); // 2 + 1
      expect(caught!.message).toContain('!== apiTotalReported(5)');
    });

    it('marks manifest status as completed_with_errors after integrity violation', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo, { id: 'bp-integrity-err' });

      const badSection = makeSection('issue_type', 1, [], 5); // 1 ≠ 5

      try {
        writer.appendStageSection(badSection, []);
      } catch {
        // expected
      }

      const stored = repo.getById('bp-integrity-err');
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe('completed_with_errors');
    });
  });

  describe('atomic per-stage persistence', () => {
    it('persists manifest to SQLite after each stage', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo, { id: 'bp-persist' });

      // Initially in_progress with no stages
      let stored = repo.getById('bp-persist');
      expect(stored).not.toBeNull();
      expect(stored!.stages).toHaveLength(0);

      writer.appendStageSection(
        makeSection('issue_type', 2),
        [makeEntry('1', 'issue_type'), makeEntry('2', 'issue_type')],
      );

      // After first stage: one section persisted
      stored = repo.getById('bp-persist');
      expect(stored!.stages).toHaveLength(1);
      expect(stored!.stages[0].stageName).toBe('issue_type');
      expect(stored!.stages[0].capturedCount).toBe(2);

      writer.appendStageSection(
        makeSection('custom_field', 1, ['sys-1'], 2),
        [makeEntry('cf-1', 'custom_field')],
      );

      // After second stage: two sections persisted
      stored = repo.getById('bp-persist');
      expect(stored!.stages).toHaveLength(2);
      expect(stored!.stages[1].stageName).toBe('custom_field');
    });

    it('includes all entries in the persisted manifest', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo, { id: 'bp-entries' });

      const entries = [makeEntry('1', 'issue_type'), makeEntry('2', 'issue_type')];
      writer.appendStageSection(makeSection('issue_type', 2), entries);

      const stored = repo.getById('bp-entries');
      expect(stored!.entries).toHaveLength(2);
      expect(stored!.entries.map((e) => e.id)).toEqual(['1', '2']);
    });
  });

  describe('finalize', () => {
    it('sets status=completed on clean run', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo, { id: 'bp-clean' });

      writer.appendStageSection(makeSection('issue_type', 2), []);
      const manifest = writer.finalize('completed');

      expect(manifest.status).toBe('completed');
      expect(manifest.finalisedAt).not.toBe('');

      const stored = repo.getById('bp-clean');
      expect(stored!.status).toBe('completed');
    });

    it('sets status=halted when requested', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo, { id: 'bp-halted' });

      const manifest = writer.finalize('halted');
      expect(manifest.status).toBe('halted');
    });

    it('overrides to completed_with_errors when prior integrity errors exist', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo, { id: 'bp-prior-err' });

      try {
        writer.appendStageSection(makeSection('issue_type', 1, [], 10), []);
      } catch {
        // integrity error expected
      }

      // Even if caller passes 'completed', writer upgrades to completed_with_errors
      const manifest = writer.finalize('completed');
      expect(manifest.status).toBe('completed_with_errors');
    });

    it('writes scopeMode and backupPointId to finalized manifest', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo, { id: 'bp-meta', scopeMode: 'selected' });

      const manifest = writer.finalize('completed');

      expect(manifest.backupPointId).toBe('bp-meta');
      expect(manifest.scopeMode).toBe('selected');
      expect(manifest.cloudId).toBe('cloud-xyz');
    });
  });

  describe('static validate()', () => {
    it('returns valid=true for a well-formed manifest', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo, { id: 'bp-valid' });

      writer.appendStageSection(makeSection('issue_type', 2), [
        makeEntry('1', 'issue_type'),
        makeEntry('2', 'issue_type'),
      ]);

      const manifest = writer.finalize('completed');
      const result = BackupPointManifestWriter.validate(manifest);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns valid=false for null input', () => {
      const result = BackupPointManifestWriter.validate(null);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('returns errors for missing required fields', () => {
      const result = BackupPointManifestWriter.validate({
        backupPointId: '',
        // missing cloudId, siteUrl, etc.
        scopeMode: 'unknown',
        status: 'invalid',
        stages: 'not-array',
        entries: null,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('cloudId'))).toBe(true);
      expect(result.errors.some((e) => e.includes('scopeMode'))).toBe(true);
      expect(result.errors.some((e) => e.includes('stages'))).toBe(true);
    });

    it('detects integrity violations in stored manifest', () => {
      // Build a manifest with a bad stage section (bypass the writer's check)
      const manifest = {
        backupPointId: 'bp-bad',
        cloudId: 'cloud-1',
        siteUrl: 'https://example.atlassian.net',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finalisedAt: new Date().toISOString(),
        scopeMode: 'all',
        status: 'completed',
        stages: [
          {
            stageName: 'issue_type',
            apiPageCount: 1,
            apiTotalReported: 10,
            capturedCount: 3, // 3 + 0 = 3 ≠ 10 → violation
            skippedIds: [],
            skippedReasons: {},
          },
        ],
        entries: [],
        phaseSummary: {},
        reconciliation: [],
      };

      const result = BackupPointManifestWriter.validate(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('integrity violation'))).toBe(true);
    });
  });

  describe('validateFromStore()', () => {
    it('validates a manifest persisted via the repo', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const writer = makeWriter(repo, { id: 'bp-stored-val' });

      writer.appendStageSection(makeSection('issue_type', 1), [
        makeEntry('1', 'issue_type'),
      ]);
      writer.finalize('completed');

      const result = BackupPointManifestWriter.validateFromStore(
        repo,
        'bp-stored-val',
      );
      expect(result.valid).toBe(true);
    });

    it('returns error when backupPointId does not exist', () => {
      const db = makeDb();
      const repo = makeRepo(db);
      const result = BackupPointManifestWriter.validateFromStore(
        repo,
        'nonexistent',
      );
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('No manifest found');
    });
  });
});
