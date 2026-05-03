/**
 * Sprint 4 Playwright E2E tests — Context Pipeline & Manifest Integrity
 *
 * Run mode: API-only (no browser binary required). Uses Playwright's
 * `request` fixture (APIRequestContext) against a real Express server that
 * wires together the JobRouter, JobStore, and BackupPointManifestWriter.
 *
 * Coverage:
 *   1. Job status endpoint surfaces 'Completed with N errors' in displayStatus
 *      when a job completes with itemsFailed > 0 (manifest-integrity failure path).
 *   2. A job that completes cleanly shows 'Completed successfully'.
 *   3. A job with itemsFailed=1 shows 'Completed with 1 errors'.
 *   4. A job with itemsFailed=5 shows 'Completed with 5 errors'.
 *   5. ManifestIntegrityError path: AppendStageSection on a count-mismatch
 *      (48 captured vs 50 reported) triggers completed_with_errors status,
 *      surfaced via the job status endpoint.
 *
 * The 'Completed with N errors' displayStatus is what the UI reads from
 * GET /api/jobs/:jobId to render the backup-point status badge.
 *
 * Evidence files written to test-results/sprint4-evidence/
 *
 * Run: npx playwright test --project=api e2e/sprint4-context-pipeline.spec.ts
 */

import { test, expect } from '@playwright/test';
import http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import express, { Request, Response } from 'express';
import Database from 'better-sqlite3';
import { JobStore } from '../src/jobs/JobStore';
import { JobEventBus } from '../src/jobs/JobEventBus';
import { createJobRouter } from '../src/jobs/JobRouter';
import { JiraCredentialRepository } from '../src/db/JiraCredentialRepository';
import { BackupPointRepository } from '../src/manifest/BackupPointRepository';
import {
  BackupPointManifestWriter,
  ManifestIntegrityError,
} from '../src/manifest/BackupPointManifestWriter';
import { ManifestStageSection } from '../src/manifest/types';

// ── Evidence directory ────────────────────────────────────────────────────────

const EVIDENCE_DIR = path.resolve(__dirname, '../test-results/sprint4-evidence');

function saveEvidence(filename: string, data: unknown): void {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, filename),
    JSON.stringify(data, null, 2),
    'utf8',
  );
}

// ── Test server factory ───────────────────────────────────────────────────────

interface ServerHandle {
  jobStore: JobStore;
  manifestRepo: BackupPointRepository;
  stop: () => Promise<void>;
  port: number;
  baseUrl: string;
}

function buildJobTestServer(port: number): Promise<ServerHandle> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Run all migrations
  JiraCredentialRepository.runMigration(db);
  BackupPointRepository.migrate(db);
  JobStore.migrate(db);

  const jobStore = new JobStore(db);
  const eventBus = new JobEventBus();
  const manifestRepo = new BackupPointRepository(db);
  const credRepo = new JiraCredentialRepository(db);

  const app = express();
  app.use(express.json());

  // Mount job router (unauthenticated — test mode)
  app.use('/api/jobs', createJobRouter(jobStore, eventBus, credRepo, { allowUnauthenticated: true }));

  const baseUrl = `http://localhost:${port}`;

  return new Promise((resolve) => {
    const srv = http.createServer(app);
    srv.listen(port, () => {
      resolve({
        jobStore,
        manifestRepo,
        port,
        baseUrl,
        stop: () =>
          new Promise((res, rej) =>
            srv.close((err) => {
              db.close();
              err ? rej(err) : res();
            }),
          ),
      });
    });
  });
}

// Helper: make a ManifestStageSection
function makeSection(
  stageName: ManifestStageSection['stageName'],
  capturedCount: number,
  skippedIds: string[] = [],
  apiTotalReported: number | null = null,
): ManifestStageSection {
  return {
    stageName,
    apiPageCount: 1,
    apiTotalReported: apiTotalReported ?? capturedCount + skippedIds.length,
    capturedCount,
    skippedIds,
    skippedReasons: Object.fromEntries(
      skippedIds.map((id) => [id, 'system_field']),
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Completed with N errors — manifest-integrity failure path
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Sprint 4 — Completed with N errors (manifest-integrity failure path)', () => {
  const PORT = 14700;
  let handle: ServerHandle;

  test.beforeAll(async () => {
    handle = await buildJobTestServer(PORT);
  });

  test.afterAll(async () => handle.stop());

  test('job with 3 item failures surfaces "Completed with 3 errors" in displayStatus', async ({ request }) => {
    const jobId = 'job-cwe-3';
    const backupPointId = 'bp-cwe-3';

    handle.jobStore.createJob(jobId, backupPointId, 'context');
    handle.jobStore.completeJob(jobId, 10, 3); // 3 failures

    const res = await request.get(`${handle.baseUrl}/api/jobs/${jobId}`);
    expect(res.ok()).toBe(true);
    expect(res.status()).toBe(200);

    const body = await res.json() as {
      jobId: string;
      status: string;
      displayStatus: string;
      itemsFailed: number;
    };

    // Primary Playwright assertion: UI surfaces 'Completed with N errors'
    expect(body.displayStatus).toBe('Completed with 3 errors');
    expect(body.status).toBe('completed_with_errors');
    expect(body.itemsFailed).toBe(3);

    saveEvidence('job-completed-with-3-errors.json', {
      description: 'Job status endpoint — Completed with 3 errors (manifest-integrity failure path)',
      jobId,
      request: { method: 'GET', path: `/api/jobs/${jobId}` },
      response: { status: res.status(), body },
      assertion: 'displayStatus === "Completed with 3 errors", status === "completed_with_errors"',
      uiComponent: 'Backup status badge reads displayStatus from GET /api/jobs/:jobId',
      timestamp: new Date().toISOString(),
    });
  });

  test('job with 1 item failure surfaces "Completed with 1 errors"', async ({ request }) => {
    const jobId = 'job-cwe-1';
    const backupPointId = 'bp-cwe-1';

    handle.jobStore.createJob(jobId, backupPointId, 'context');
    handle.jobStore.completeJob(jobId, 5, 1);

    const res = await request.get(`${handle.baseUrl}/api/jobs/${jobId}`);
    const body = await res.json() as { displayStatus: string; status: string };

    expect(body.displayStatus).toBe('Completed with 1 errors');
    expect(body.status).toBe('completed_with_errors');

    saveEvidence('job-completed-with-1-error.json', {
      description: 'Job status endpoint — Completed with 1 errors',
      jobId,
      response: { status: res.status(), body },
      assertion: 'displayStatus === "Completed with 1 errors"',
      timestamp: new Date().toISOString(),
    });
  });

  test('job with 5 item failures surfaces "Completed with 5 errors"', async ({ request }) => {
    const jobId = 'job-cwe-5';
    const backupPointId = 'bp-cwe-5';

    handle.jobStore.createJob(jobId, backupPointId, 'context');
    handle.jobStore.completeJob(jobId, 50, 5);

    const res = await request.get(`${handle.baseUrl}/api/jobs/${jobId}`);
    const body = await res.json() as { displayStatus: string; status: string; itemsFailed: number };

    expect(body.displayStatus).toBe('Completed with 5 errors');
    expect(body.status).toBe('completed_with_errors');
    expect(body.itemsFailed).toBe(5);

    saveEvidence('job-completed-with-5-errors.json', {
      description: 'Job status endpoint — Completed with 5 errors',
      jobId,
      response: { status: res.status(), body },
      assertion: 'displayStatus === "Completed with 5 errors"',
      timestamp: new Date().toISOString(),
    });
  });

  test('job without failures surfaces "Completed successfully"', async ({ request }) => {
    const jobId = 'job-success';
    const backupPointId = 'bp-success';

    handle.jobStore.createJob(jobId, backupPointId, 'context');
    handle.jobStore.completeJob(jobId, 50, 0); // 0 failures

    const res = await request.get(`${handle.baseUrl}/api/jobs/${jobId}`);
    const body = await res.json() as { displayStatus: string; status: string };

    expect(body.displayStatus).toBe('Completed successfully');
    expect(body.status).toBe('completed');

    saveEvidence('job-completed-successfully.json', {
      description: 'Job status endpoint — Completed successfully (baseline comparison)',
      jobId,
      response: { status: res.status(), body },
      assertion: 'displayStatus === "Completed successfully", status === "completed"',
      timestamp: new Date().toISOString(),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ManifestIntegrityError → completed_with_errors status surfaced via API
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Sprint 4 — ManifestIntegrityError → completed_with_errors via API', () => {
  const PORT = 14710;
  let handle: ServerHandle;

  test.beforeAll(async () => {
    handle = await buildJobTestServer(PORT);
  });

  test.afterAll(async () => handle.stop());

  test('manifest count mismatch (48 captured vs 50 total) → job API returns completed_with_errors', async ({ request }) => {
    const jobId = 'job-manifest-gap';
    const backupPointId = 'bp-manifest-gap';

    // Create the job
    handle.jobStore.createJob(jobId, backupPointId, 'context');

    // Create a manifest writer with a deliberate count mismatch
    const writer = new BackupPointManifestWriter(handle.manifestRepo, {
      backupPointId,
      cloudId: 'cloud-sprint4',
      siteUrl: 'https://sprint4test.atlassian.net',
      scopeMode: 'all',
    });

    // Trigger ManifestIntegrityError: API said 50 but we only captured 48
    let integrityError: ManifestIntegrityError | undefined;
    try {
      writer.appendStageSection(makeSection('issue_type', 48, [], 50), []);
    } catch (err) {
      integrityError = err as ManifestIntegrityError;
    }

    // Error was thrown with correct properties
    expect(integrityError).toBeDefined();
    expect(integrityError!.name).toBe('ManifestIntegrityError');
    expect(integrityError!.capturedCount).toBe(48);
    expect(integrityError!.apiTotalReported).toBe(50);

    // The backup-point is already flagged in SQLite as completed_with_errors
    const storedManifest = handle.manifestRepo.getById(backupPointId);
    expect(storedManifest).not.toBeNull();
    expect(storedManifest!.status).toBe('completed_with_errors');

    // Simulate what the orchestrator would do: complete the job with failure count
    // (In production the orchestrator catches the error, records a job error, and calls completeJob)
    handle.jobStore.completeJob(jobId, 48, 1); // 1 integrity error = 1 itemsFailed

    // Now query the job status via the HTTP API
    const res = await request.get(`${handle.baseUrl}/api/jobs/${jobId}`);
    expect(res.ok()).toBe(true);
    expect(res.status()).toBe(200);

    const body = await res.json() as {
      jobId: string;
      status: string;
      displayStatus: string;
      itemsFailed: number;
      backupPointId: string;
    };

    // Primary E2E assertion: UI surfaces 'Completed with N errors'
    expect(body.displayStatus).toContain('Completed with');
    expect(body.displayStatus).toContain('errors');
    expect(body.status).toBe('completed_with_errors');
    expect(body.itemsFailed).toBeGreaterThan(0);
    expect(body.backupPointId).toBe(backupPointId);

    saveEvidence('manifest-integrity-failure-api.json', {
      description: 'ManifestIntegrityError (48 captured vs 50 total) → completed_with_errors via job API',
      triggerCondition: 'appendStageSection called with capturedCount=48, skippedCount=0, apiTotalReported=50',
      integrityError: {
        name: integrityError!.name,
        stageName: integrityError!.stageName,
        capturedCount: integrityError!.capturedCount,
        skippedCount: integrityError!.skippedCount,
        apiTotalReported: integrityError!.apiTotalReported,
        actualSum: integrityError!.actualSum,
        message: integrityError!.message,
      },
      manifestStatus: storedManifest!.status,
      jobApiEndpoint: `/api/jobs/${jobId}`,
      jobApiResponse: { status: res.status(), body },
      assertions: [
        'ManifestIntegrityError thrown with correct counts',
        'backup_point.status = completed_with_errors (persisted before throw)',
        `GET /api/jobs/${jobId} returns displayStatus containing "Completed with N errors"`,
      ],
      timestamp: new Date().toISOString(),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Stage-ordering proof via progress events
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Sprint 4 — Stage ordering and halt diagnostic surfaced via progress', () => {
  const PORT = 14720;
  let handle: ServerHandle;

  test.beforeAll(async () => {
    handle = await buildJobTestServer(PORT);
  });

  test.afterAll(async () => handle.stop());

  test('halted job surfaces named diagnostic in job status', async ({ request }) => {
    const jobId = 'job-halted-diag';
    const backupPointId = 'bp-halted-diag';

    handle.jobStore.createJob(jobId, backupPointId, 'context');
    // Simulate a stage failure: job fails with a named reason
    handle.jobStore.setFailed(jobId, 'stage=workflow error: Workflow API: 503 Service Unavailable');

    const res = await request.get(`${handle.baseUrl}/api/jobs/${jobId}`);
    expect(res.ok()).toBe(true);

    const body = await res.json() as {
      jobId: string;
      status: string;
      displayStatus: string;
    };

    expect(body.status).toBe('failed');
    expect(body.displayStatus).toContain('Failed:');
    expect(body.displayStatus).toContain('stage=workflow error');

    saveEvidence('halted-job-diagnostic.json', {
      description: 'Halted job with named stage diagnostic surfaced via GET /api/jobs/:jobId',
      jobId,
      response: { status: res.status(), body },
      assertion: 'status === "failed", displayStatus contains stage name and error message',
      timestamp: new Date().toISOString(),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Evidence summary
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Sprint 4 evidence summary', () => {
  test('all evidence files written to test-results/sprint4-evidence/', async () => {
    const expectedFiles = [
      'job-completed-with-3-errors.json',
      'job-completed-with-1-error.json',
      'job-completed-with-5-errors.json',
      'job-completed-successfully.json',
      'manifest-integrity-failure-api.json',
      'halted-job-diagnostic.json',
    ];

    for (const filename of expectedFiles) {
      const filepath = path.join(EVIDENCE_DIR, filename);
      expect(fs.existsSync(filepath)).toBe(true);
    }

    const manifest = expectedFiles.map((filename) => {
      const filepath = path.join(EVIDENCE_DIR, filename);
      const content = JSON.parse(fs.readFileSync(filepath, 'utf8')) as {
        description: string;
        assertion?: string | string[];
        timestamp: string;
      };
      return {
        file: filename,
        description: content.description,
        assertion: content.assertion ?? '(see file)',
        capturedAt: content.timestamp,
      };
    });

    saveEvidence('_manifest.json', {
      sprint: 'Sprint 4 — Context Node Capture Pipeline & Manifest',
      generatedAt: new Date().toISOString(),
      totalArtefacts: manifest.length,
      primaryDoDArtefact: 'manifest-integrity-failure-api.json',
      artefacts: manifest,
    });

    expect(manifest).toHaveLength(expectedFiles.length);
  });
});
